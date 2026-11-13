// RSP：絵と音の下ごしらえをする計算機（小さな MIPS + 16 ビット × 8 個をまとめて計算するベクトル演算）。
// ゲームが自分で持ってきたプログラム（マイクロコード）をそのまま 1 命令ずつ実行する。
// こうしておくと、ゲームごとに違うマイクロコードを 1 つずつ作り直さなくても動く

import { INT_SP, type N64 } from './n64';
import { RspJit } from './rspjit';

const P47 = 140737488355328; // 2^47
const P48 = 281474976710656; // 2^48

/** 割り算の逆数の表（実機の ROM と同じ計算で作る） */
const RCP = new Uint16Array(512);
const RSQ = new Uint16Array(512);
RCP[0] = 0xffff;
for (let i = 1; i < 512; i++) RCP[i] = (Math.floor(17179869184 / (i + 512)) + 1) >> 8;
for (let i = 0; i < 512; i++) {
  const a = (i + 512) >> (i & 1);
  // a × (b+1)² が 2^44 未満の間 b を増やす
  let b = Math.floor(Math.sqrt(17592186044416 / a)) - 2;
  if (b < 131072) b = 131072;
  while (a * (b + 1) * (b + 1) < 17592186044416) b++;
  RSQ[i] = b >> 1;
}

/** vt の要素の選び方（e）ごとの、要素 i が読む元の番号 */
const BC: Uint8Array[] = [];
for (let e = 0; e < 16; e++) {
  const t = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    if (e < 2) t[i] = i;
    else if (e < 4) t[i] = (i & ~1) | (e & 1);
    else if (e < 8) t[i] = (i & ~3) | (e & 3);
    else t[i] = e & 7;
  }
  BC.push(t);
}

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

export class Rsp {
  r = new Int32Array(32);
  pc = 0;
  nextPc = 4;
  private branched = false;
  /** ベクトルレジスタ：32 本 × 8 要素（要素 0 が上位） */
  v = new Int16Array(32 * 8);
  acc = new Float64Array(8);
  vco = 0;
  vcc = 0;
  vce = 0;
  private divIn = 0;
  private divOut = 0;
  private divDp = false;
  // SP のレジスタ
  status = 1;
  memAddr = 0;
  dramAddr = 0;
  private rdLen = 0;
  private wrLen = 0;
  semaphore = 0;
  /** 次に続きを実行する時刻（-1 = 止まっている） */
  nextAt = -1;
  private tmp = new Int16Array(8);
  private vte = new Int16Array(8);

  private mem8: Uint8Array;
  private mem32: Int32Array;
  /** 速く動かすための書き換え */
  jit: RspJit | null = null;
  imem32(): Int32Array {
    return this.mem32;
  }
  dmem8(): Uint8Array {
    return this.mem8;
  }
  dmem32(): Int32Array {
    return this.mem32;
  }

  constructor(private n64: N64) {
    this.mem8 = n64.spMem8;
    this.mem32 = n64.spMem32;
    this.jit = new RspJit(this);
  }

  // ---- レジスタ（CPU から・RSP の COP0 から） ----
  readReg(p: number): number {
    if (p >= 0x04080000) return this.pc & 0xffc;
    return this.readCop0((p >> 2) & 7);
  }

  writeReg(p: number, v: number): void {
    if (p >= 0x04080000) {
      this.pc = v & 0xffc;
      this.nextPc = (this.pc + 4) & 0xffc;
      this.branched = false;
      return;
    }
    this.writeCop0((p >> 2) & 7, v);
  }

  private readCop0(r: number): number {
    switch (r) {
      case 0:
        return this.memAddr;
      case 1:
        return this.dramAddr;
      case 2:
        return this.rdLen;
      case 3:
        return this.wrLen;
      case 4:
        return this.status;
      case 5:
      case 6:
        return 0;
      case 7: {
        const s = this.semaphore;
        this.semaphore = 1;
        return s;
      }
    }
    return this.n64.rdp.readReg(r - 8);
  }

  private writeCop0(r: number, v: number): void {
    switch (r) {
      case 0:
        this.memAddr = v & 0x1ff8;
        return;
      case 1:
        this.dramAddr = v & 0xfffff8;
        return;
      case 2:
        this.rdLen = v;
        this.dma(v, true);
        return;
      case 3:
        this.wrLen = v;
        this.dma(v, false);
        return;
      case 4:
        this.writeStatus(v);
        return;
      case 7:
        this.semaphore = 0;
        return;
    }
    if (r >= 8) this.n64.rdp.writeReg(r - 8, v);
  }

  private writeStatus(v: number): void {
    let s = this.status;
    if (v & 1) s &= ~1;
    if (v & 2) s |= 1;
    if (v & 4) s &= ~2;
    if (v & 8) this.n64.lower(INT_SP);
    if (v & 0x10) this.n64.raise(INT_SP);
    if (v & 0x20) s &= ~0x20;
    if (v & 0x40) s |= 0x20;
    if (v & 0x80) s &= ~0x40;
    if (v & 0x100) s |= 0x40;
    for (let i = 0; i < 8; i++) {
      if (v & (1 << (9 + i * 2))) s &= ~(0x80 << i);
      if (v & (1 << (10 + i * 2))) s |= 0x80 << i;
    }
    const wasHalted = (this.status & 1) !== 0;
    this.status = s;
    if (wasHalted && !(s & 1)) {
      // 動き出す
      this.lastRun = this.n64.cycles;
      this.nextAt = this.n64.cycles + 200;
      if (this.n64.stopAt > this.nextAt) this.n64.stopAt = this.nextAt;
    }
  }

  private dma(v: number, toSp: boolean): void {
    const len = ((v & 0xfff) | 7) + 1;
    const count = ((v >> 12) & 0xff) + 1;
    const skip = (v >>> 20) & 0xff8;
    const bank = this.memAddr & 0x1000;
    let mem = this.memAddr & 0xff8;
    let endAddr = this.memAddr & 0x1ff8;
    const startMem = mem;
    let dram = this.dramAddr;
    const ram = this.n64.ram32;
    const sp = this.mem32;
    const max = this.n64.ramSize;
    for (let c = 0; c < count; c++) {
      for (let i = 0; i < len; i += 4) {
        const s = (bank | ((mem + i) & 0xfff)) >> 2;
        const d = (dram + i) & 0xfffffc;
        if (toSp) sp[s] = d < max ? ram[d >> 2] : 0;
        else if (d < max) ram[d >> 2] = sp[s];
      }
      mem = (mem + len) & 0xfff;
      dram += len + skip;
      endAddr += len;
    }
    // 終わったあとのアドレスは、DMEM の終わりを越えると IMEM 側のビットまで進む
    this.memAddr = endAddr & 0x1ff8;
    if (toSp && bank) this.jit?.invalidate(startMem, count * len);
    if (!toSp) this.n64.cpu.jit?.invalidateRange(this.dramAddr, dram - this.dramAddr);
    this.dramAddr = dram & 0xfffff8;
    this.rdLen = this.wrLen = 0xff8;
    this.n64.writes++;
  }

  /** 時刻が来たら実行する（BREAK で止まるまで。長いときは何回かに分ける） */
  /** 最後に実行した時刻（RSP は CPU の 2/3 の速さなので、たった時間ぶんだけ進める） */
  private lastRun = 0;

  tick(): void {
    if (this.nextAt < 0 || this.n64.cycles < this.nextAt) return;
    this.nextAt = -1;
    if (this.status & 1) return;
    const now = this.n64.cycles;
    const budget = Math.max(2000, Math.min(300000, Math.floor(((now - this.lastRun) * 2) / 3)));
    this.lastRun = now;
    this.run(budget);
    if (!(this.status & 1)) this.nextAt = this.n64.cycles + 3000;
  }

  // ---- メモリ（DMEM の中で折り返す） ----
  private rb(a: number): number {
    return this.mem8[(a & 0xfff) ^ 3];
  }
  private wb(a: number, v: number): void {
    this.mem8[(a & 0xfff) ^ 3] = v;
  }
  rw(a: number): number {
    if (!(a & 3)) return this.mem32[(a & 0xfff) >> 2];
    return (this.rb(a) << 24) | (this.rb(a + 1) << 16) | (this.rb(a + 2) << 8) | this.rb(a + 3);
  }
  ww(a: number, v: number): void {
    if (!(a & 3)) {
      this.mem32[(a & 0xfff) >> 2] = v;
      return;
    }
    this.wb(a, v >>> 24);
    this.wb(a + 1, v >>> 16);
    this.wb(a + 2, v >>> 8);
    this.wb(a + 3, v);
  }

  /** ベクトルレジスタのバイト（0 が最上位） */
  private vb(reg: number, k: number): number {
    const e = this.v[reg * 8 + ((k & 15) >> 1)];
    return k & 1 ? e & 0xff : (e >> 8) & 0xff;
  }
  private setVb(reg: number, k: number, b: number): void {
    const i = reg * 8 + ((k & 15) >> 1);
    const e = this.v[i];
    this.v[i] = k & 1 ? (e & 0xff00) | (b & 0xff) : (e & 0x00ff) | ((b & 0xff) << 8);
  }

  // ---- 実行 ----
  private pollPc = -1;
  private pollVal = 0;
  private pollN = 0;

  run(max: number): void {
    this.pollPc = -1;
    const r = this.r;
    const mem32 = this.mem32;
    const jit = this.jit;
    for (let n = 0; n < max; n++) {
      if (jit !== null && !this.branched) {
        const blk = jit.get(this.pc);
        if (blk !== null) {
          n += blk(this) - 1;
          continue;
        }
      }
      const pc = this.pc;
      const op = mem32[(0x1000 | pc) >> 2];
      const wasBranch = this.branched;
      this.branched = false;
      this.pc = this.nextPc;
      this.nextPc = (this.nextPc + 4) & 0xffc;
      const rs = (op >>> 21) & 31;
      const rt = (op >>> 16) & 31;
      const imm = (op << 16) >> 16;
      switch (op >>> 26) {
        case 0x00: {
          const rd = (op >>> 11) & 31;
          const sa = (op >>> 6) & 31;
          switch (op & 63) {
            case 0x00:
              r[rd] = r[rt] << sa;
              break;
            case 0x02:
              r[rd] = r[rt] >>> sa;
              break;
            case 0x03:
              r[rd] = r[rt] >> sa;
              break;
            case 0x04:
              r[rd] = r[rt] << (r[rs] & 31);
              break;
            case 0x06:
              r[rd] = r[rt] >>> (r[rs] & 31);
              break;
            case 0x07:
              r[rd] = r[rt] >> (r[rs] & 31);
              break;
            case 0x08:
              this.nextPc = r[rs] & 0xffc;
              this.branched = true;
              break;
            case 0x09: {
              const t = r[rs] & 0xffc;
              r[rd] = (pc + 8) & 0xffc;
              this.nextPc = t;
              this.branched = true;
              break;
            }
            case 0x0d:
              // BREAK：止まる
              this.status |= 3;
              if (this.status & 0x40) this.n64.raise(INT_SP);
              r[0] = 0;
              return;
            case 0x20:
            case 0x21:
              r[rd] = (r[rs] + r[rt]) | 0;
              break;
            case 0x22:
            case 0x23:
              r[rd] = (r[rs] - r[rt]) | 0;
              break;
            case 0x24:
              r[rd] = r[rs] & r[rt];
              break;
            case 0x25:
              r[rd] = r[rs] | r[rt];
              break;
            case 0x26:
              r[rd] = r[rs] ^ r[rt];
              break;
            case 0x27:
              r[rd] = ~(r[rs] | r[rt]);
              break;
            case 0x2a:
              r[rd] = r[rs] < r[rt] ? 1 : 0;
              break;
            case 0x2b:
              r[rd] = r[rs] >>> 0 < r[rt] >>> 0 ? 1 : 0;
              break;
          }
          break;
        }
        case 0x01: {
          const neg = r[rs] < 0;
          const take = rt & 1 ? !neg : neg;
          if ((rt & 0x1e) === 0x10) r[31] = (pc + 8) & 0xffc;
          if (take) {
            this.nextPc = (pc + 4 + (imm << 2)) & 0xffc;
            this.branched = true;
          }
          break;
        }
        case 0x02:
          this.nextPc = (op << 2) & 0xffc;
          this.branched = true;
          break;
        case 0x03:
          r[31] = (pc + 8) & 0xffc;
          this.nextPc = (op << 2) & 0xffc;
          this.branched = true;
          break;
        case 0x04:
          if (r[rs] === r[rt]) {
            this.nextPc = (pc + 4 + (imm << 2)) & 0xffc;
            this.branched = true;
          }
          break;
        case 0x05:
          if (r[rs] !== r[rt]) {
            this.nextPc = (pc + 4 + (imm << 2)) & 0xffc;
            this.branched = true;
          }
          break;
        case 0x06:
          if (r[rs] <= 0) {
            this.nextPc = (pc + 4 + (imm << 2)) & 0xffc;
            this.branched = true;
          }
          break;
        case 0x07:
          if (r[rs] > 0) {
            this.nextPc = (pc + 4 + (imm << 2)) & 0xffc;
            this.branched = true;
          }
          break;
        case 0x08:
        case 0x09:
          r[rt] = (r[rs] + imm) | 0;
          break;
        case 0x0a:
          r[rt] = r[rs] < imm ? 1 : 0;
          break;
        case 0x0b:
          r[rt] = r[rs] >>> 0 < imm >>> 0 ? 1 : 0;
          break;
        case 0x0c:
          r[rt] = r[rs] & (op & 0xffff);
          break;
        case 0x0d:
          r[rt] = r[rs] | (op & 0xffff);
          break;
        case 0x0e:
          r[rt] = r[rs] ^ (op & 0xffff);
          break;
        case 0x0f:
          r[rt] = op << 16;
          break;
        case 0x10: {
          const rd = (op >>> 11) & 15;
          if (rs === 0) {
            const val = this.readCop0(rd);
            r[rt] = val;
            // 同じ所で同じ値を読み続けている（CPU や RDP を待っている）なら、今回はここで休む
            if (pc === this.pollPc && val === this.pollVal && n - this.pollN <= 24) {
              this.pollN = n;
              r[0] = 0;
              return;
            }
            this.pollPc = pc;
            this.pollVal = val;
            this.pollN = n;
          } else if (rs === 4) {
            this.writeCop0(rd, r[rt]);
            if (this.status & 1) {
              // 自分で止まった
              r[0] = 0;
              return;
            }
          }
          break;
        }
        case 0x12:
          this.cop2(op, rs, rt);
          break;
        case 0x20:
          r[rt] = (this.rb(r[rs] + imm) << 24) >> 24;
          break;
        case 0x21: {
          const a = r[rs] + imm;
          r[rt] = (((this.rb(a) << 8) | this.rb(a + 1)) << 16) >> 16;
          break;
        }
        case 0x23:
        case 0x27:
          r[rt] = this.rw(r[rs] + imm);
          break;
        case 0x24:
          r[rt] = this.rb(r[rs] + imm);
          break;
        case 0x25: {
          const a = r[rs] + imm;
          r[rt] = (this.rb(a) << 8) | this.rb(a + 1);
          break;
        }
        case 0x28:
          this.wb(r[rs] + imm, r[rt]);
          break;
        case 0x29: {
          const a = r[rs] + imm;
          this.wb(a, r[rt] >> 8);
          this.wb(a + 1, r[rt]);
          break;
        }
        case 0x2b:
          this.ww(r[rs] + imm, r[rt]);
          break;
        case 0x32:
          this.lwc2(op, rs, rt);
          break;
        case 0x3a:
          this.swc2(op, rs, rt);
          break;
      }
      r[0] = 0;
      void wasBranch;
    }
  }

  cop2(op: number, rs: number, rt: number): void {
    if (rs & 0x10) return this.vector(op);
    const rd = (op >>> 11) & 31;
    const e = (op >>> 7) & 15;
    switch (rs) {
      case 0x00:
        this.r[rt] = (((this.vb(rd, e) << 8) | this.vb(rd, e + 1)) << 16) >> 16;
        return;
      case 0x02:
        switch (rd & 3) {
          case 0:
            this.r[rt] = (this.vco << 16) >> 16;
            return;
          case 1:
            this.r[rt] = (this.vcc << 16) >> 16;
            return;
          default:
            this.r[rt] = this.vce & 0xff;
            return;
        }
      case 0x04:
        this.setVb(rd, e, this.r[rt] >> 8);
        if (e !== 15) this.setVb(rd, e + 1, this.r[rt]);
        return;
      case 0x06:
        switch (rd & 3) {
          case 0:
            this.vco = this.r[rt] & 0xffff;
            return;
          case 1:
            this.vcc = this.r[rt] & 0xffff;
            return;
          default:
            this.vce = this.r[rt] & 0xff;
            return;
        }
    }
  }

  lwc2(op: number, rs: number, vt: number): void {
    const e = (op >>> 7) & 15;
    const off = (op << 25) >> 25;
    const base = this.r[rs];
    const v = this.v;
    switch ((op >>> 11) & 31) {
      case 0:
        this.setVb(vt, e, this.rb(base + off));
        return;
      case 1:
      case 2:
      case 3: {
        const sh = (op >>> 11) & 31;
        const a = base + (off << sh);
        const n = Math.min(1 << sh, 16 - e);
        for (let i = 0; i < n; i++) this.setVb(vt, e + i, this.rb(a + i));
        return;
      }
      case 4: {
        const a = base + (off << 4);
        const n = Math.min(16 - e, 16 - (a & 15));
        for (let i = 0; i < n; i++) this.setVb(vt, e + i, this.rb(a + i));
        return;
      }
      case 5: {
        let a = base + (off << 4);
        const start = 16 - ((a & 15) - e);
        a &= ~15;
        for (let k = start; k < 16; k++) this.setVb(vt, k & 15, this.rb(a++));
        return;
      }
      case 6:
      case 7: {
        let a = base + (off << 3);
        const idx = (a & 7) - e;
        a &= ~7;
        const sh = ((op >>> 11) & 31) === 6 ? 8 : 7;
        for (let k = 0; k < 8; k++) v[vt * 8 + k] = this.rb(a + ((idx + k) & 15)) << sh;
        return;
      }
      case 8: {
        let a = base + (off << 4);
        const idx = (a & 7) - e;
        a &= ~7;
        for (let k = 0; k < 8; k++) v[vt * 8 + k] = this.rb(a + ((idx + k * 2) & 15)) << 7;
        return;
      }
      case 9: {
        let a = base + (off << 4);
        const idx = (a & 7) - e;
        a &= ~7;
        const t = this.tmp;
        for (let k = 0; k < 4; k++) {
          t[k] = this.rb(a + ((idx + k * 4) & 15)) << 7;
          t[k + 4] = this.rb(a + ((idx + k * 4 + 8) & 15)) << 7;
        }
        const end = Math.min(e + 8, 16);
        for (let k = e; k < end; k++) {
          const el = t[k >> 1];
          this.setVb(vt, k, k & 1 ? el : el >> 8);
        }
        return;
      }
      case 11: {
        let a = base + (off << 4);
        const begin = a & ~7;
        a = begin + ((e + (a & 8)) & 15);
        const vbase = vt & ~7;
        let voff = e >> 1;
        for (let i = 0; i < 8; i++) {
          const hi = this.rb(a++);
          if (a === begin + 16) a = begin;
          const lo = this.rb(a++);
          if (a === begin + 16) a = begin;
          v[(vbase + voff) * 8 + i] = (hi << 8) | lo;
          voff = (voff + 1) & 7;
        }
        return;
      }
    }
  }

  swc2(op: number, rs: number, vt: number): void {
    const e = (op >>> 7) & 15;
    const off = (op << 25) >> 25;
    const base = this.r[rs];
    const v = this.v;
    switch ((op >>> 11) & 31) {
      case 0:
        this.wb(base + off, this.vb(vt, e));
        return;
      case 1:
      case 2:
      case 3: {
        const sh = (op >>> 11) & 31;
        const a = base + (off << sh);
        for (let i = 0; i < 1 << sh; i++) this.wb(a + i, this.vb(vt, e + i));
        return;
      }
      case 4: {
        const a = base + (off << 4);
        const n = 16 - (a & 15);
        for (let i = 0; i < n; i++) this.wb(a + i, this.vb(vt, e + i));
        return;
      }
      case 5: {
        let a = base + (off << 4);
        const end = e + (a & 15);
        const b2 = 16 - (a & 15);
        a &= ~15;
        for (let k = e; k < end; k++) this.wb(a++, this.vb(vt, k + b2));
        return;
      }
      case 6:
      case 7: {
        const a = base + (off << 3);
        const packed = ((op >>> 11) & 31) === 6;
        for (let k = e; k < e + 8; k++) {
          const first = (k & 15) < 8;
          const hiByte = (v[vt * 8 + (k & 7)] >> 8) & 0xff;
          const sh7 = (v[vt * 8 + (k & 7)] >> 7) & 0xff;
          this.wb(a + k - e, first === packed ? hiByte : sh7);
        }
        return;
      }
      case 8: {
        let a = base + (off << 4);
        const idx = a & 7;
        a &= ~7;
        for (let k = 0; k < 8; k++) {
          const bi = e + k * 2;
          const val = ((this.vb(vt, bi) << 1) | (this.vb(vt, bi + 1) >> 7)) & 0xff;
          this.wb(a + ((idx + k * 2) & 15), val);
        }
        return;
      }
      case 9: {
        let a = base + (off << 4);
        const b2 = a & 7;
        a &= ~7;
        let els: number[] | null = null;
        switch (e) {
          case 0:
          case 15:
            els = [0, 1, 2, 3];
            break;
          case 1:
            els = [6, 7, 4, 5];
            break;
          case 4:
            els = [1, 2, 3, 0];
            break;
          case 5:
            els = [7, 4, 5, 6];
            break;
          case 8:
            els = [4, 5, 6, 7];
            break;
          case 11:
            els = [3, 0, 1, 2];
            break;
          case 12:
            els = [5, 6, 7, 4];
            break;
        }
        for (let k = 0; k < 4; k++) this.wb(a + ((b2 + k * 4) & 15), els ? (v[vt * 8 + els[k]] >> 7) & 0xff : 0);
        return;
      }
      case 10: {
        let a = base + (off << 4);
        let b2 = a & 7;
        a &= ~7;
        for (let k = e; k < e + 16; k++) this.wb(a + (b2++ & 15), this.vb(vt, k));
        return;
      }
      case 11: {
        let a = base + (off << 4);
        const start = vt & ~7;
        let el = 16 - (e & ~1);
        let b2 = (a & 7) - (e & ~1);
        a &= ~7;
        for (let k = start; k < start + 8; k++) {
          const val = v[k * 8 + ((el++ >> 1) & 7)];
          this.wb(a + (b2 & 15), val >> 8);
          this.wb(a + ((b2 + 1) & 15), val);
          b2 += 2;
        }
        return;
      }
    }
  }

  private rcp(input: number): number {
    const mask = input >> 31;
    let data = input ^ mask;
    if (input > -32768) data -= mask;
    if (data === 0) return 0x7fffffff;
    if (input === -32768) return 0xffff0000 | 0;
    const shift = Math.clz32(data);
    const index = ((data << shift) & 0x7fc00000) >>> 22;
    let result = (0x10000 | RCP[index]) << 14;
    result = (result >>> (31 - shift)) ^ mask;
    return result;
  }

  private rsq(input: number): number {
    const mask = input >> 31;
    let data = input ^ mask;
    if (input > -32768) data -= mask;
    if (data === 0) return 0x7fffffff;
    if (input === -32768) return 0xffff0000 | 0;
    const shift = Math.clz32(data);
    let index = ((data << shift) & 0x7fc00000) >>> 22;
    index = (index & 0x1fe) | (shift & 1);
    let result = (0x10000 | RSQ[index]) << 14;
    result = (result >>> ((31 - shift) >> 1)) ^ mask;
    return result;
  }

  vector(op: number): void {
    const e = (op >>> 21) & 15;
    const vtR = (op >>> 16) & 31;
    const vsR = (op >>> 11) & 31;
    const vdR = (op >>> 6) & 31;
    const v = this.v;
    const bc = BC[e];
    const t = this.vte;
    for (let i = 0; i < 8; i++) t[i] = v[vtR * 8 + bc[i]];
    const s = vsR * 8;
    const d = vdR * 8;
    const out = this.tmp;
    const f = op & 63;
    let ok: boolean;
    if (f < 0x10) ok = this.vMul(f, e, vsR, s, d, t, out);
    else if (f < 0x20) ok = f === 0x1d || f <= 0x15 ? this.vAdd(f, e, vsR, s, d, t, out) : this.vRsvd(f, e, vsR, s, d, t, out);
    else if (f < 0x28) ok = this.vCmp(f, e, vsR, s, d, t, out);
    else if (f < 0x30) ok = f <= 0x2d ? this.vLogic(f, e, vsR, s, d, t, out) : this.vRsvd(f, e, vsR, s, d, t, out);
    else if (f <= 0x37 || f === 0x3f) ok = f === 0x3f ? false : this.vDiv(f, e, vsR, s, d, t, out);
    else ok = this.vRsvd(f, e, vsR, s, d, t, out);
    if (!ok) return;
    for (let i = 0; i < 8; i++) v[d + i] = out[i];
  }

  private vMul(f: number, e: number, vsR: number, s: number, d: number, t: Int16Array, out: Int16Array): boolean {
    const v = this.v;
    const acc = this.acc;
    switch (f) {
      case 0x00:
      case 0x01:
        for (let i = 0; i < 8; i++) {
          const a = v[s + i] * t[i] * 2 + 0x8000;
          acc[i] = a;
          const h = Math.floor(a / 65536);
          out[i] = f === 0 ? clamp16(h) : a < 0 ? 0 : h > 32767 ? 0xffff : h;
        }
        break;
      case 0x02:
      case 0x0a:
        for (let i = 0; i < 8; i++) {
          let val = t[i];
          if (vsR & 1) val *= 65536;
          let a = acc[i];
          if (f === 0x02 ? a >= 0 : a < 0) a += val;
          if (a >= P47) a -= P48;
          else if (a < -P47) a += P48;
          acc[i] = a;
          out[i] = clamp16(Math.floor(a / 65536));
        }
        break;
      case 0x03:
        for (let i = 0; i < 8; i++) {
          let p = v[s + i] * t[i];
          if (p < 0) p += 31;
          acc[i] = p * 65536;
          out[i] = clamp16(p >> 1) & ~15;
        }
        break;
      case 0x04:
        for (let i = 0; i < 8; i++) {
          const a = ((v[s + i] & 0xffff) * (t[i] & 0xffff)) >>> 16;
          acc[i] = a;
          out[i] = a;
        }
        break;
      case 0x05:
        for (let i = 0; i < 8; i++) {
          const a = v[s + i] * (t[i] & 0xffff);
          acc[i] = a;
          out[i] = a >> 16;
        }
        break;
      case 0x06:
        for (let i = 0; i < 8; i++) {
          const a = (v[s + i] & 0xffff) * t[i];
          acc[i] = a;
          out[i] = a;
        }
        break;
      case 0x07:
        for (let i = 0; i < 8; i++) {
          const p = v[s + i] * t[i];
          acc[i] = p * 65536;
          out[i] = clamp16(p);
        }
        break;
      case 0x08:
      case 0x09:
        for (let i = 0; i < 8; i++) {
          let a = acc[i] + v[s + i] * t[i] * 2;
          if (a >= P47) a -= P48;
          else if (a < -P47) a += P48;
          acc[i] = a;
          const h = Math.floor(a / 65536);
          out[i] = f === 0x08 ? clamp16(h) : h < 0 ? 0 : h > 32767 ? 0xffff : h;
        }
        break;
      case 0x0b:
        for (let i = 0; i < 8; i++) {
          let p = Math.floor(acc[i] / 65536);
          if (p < -0x20 && !(p & 0x20)) p += 0x20;
          else if (p > 0x20 && !(p & 0x20)) p -= 0x20;
          acc[i] = p * 65536 + (((acc[i] % 65536) + 65536) % 65536);
          out[i] = clamp16(p >> 1) & ~15;
        }
        break;
      case 0x0c:
      case 0x0d:
      case 0x0e:
      case 0x0f:
        for (let i = 0; i < 8; i++) {
          let p: number;
          if (f === 0x0c) p = ((v[s + i] & 0xffff) * (t[i] & 0xffff)) >>> 16;
          else if (f === 0x0d) p = v[s + i] * (t[i] & 0xffff);
          else if (f === 0x0e) p = (v[s + i] & 0xffff) * t[i];
          else p = v[s + i] * t[i] * 65536;
          let a = acc[i] + p;
          if (a >= P47) a -= P48;
          else if (a < -P47) a += P48;
          acc[i] = a;
          const h = Math.floor(a / 65536);
          if (f === 0x0d || f === 0x0f) out[i] = clamp16(h);
          else out[i] = h < -32768 ? 0 : h > 32767 ? 0xffff : a - h * 65536;
        }
        break;
      default:
        return this.vRsvd(f, e, vsR, s, d, t, out);
    }
    return true;
  }

  private vAdd(f: number, e: number, vsR: number, s: number, d: number, t: Int16Array, out: Int16Array): boolean {
    const v = this.v;
    const acc = this.acc;
    switch (f) {
      case 0x10:
        for (let i = 0; i < 8; i++) {
          const r = v[s + i] + t[i] + ((this.vco >> i) & 1);
          this.setAccLow(i, r);
          out[i] = clamp16(r);
        }
        this.vco = 0;
        break;
      case 0x11:
        for (let i = 0; i < 8; i++) {
          const r = v[s + i] - t[i] - ((this.vco >> i) & 1);
          this.setAccLow(i, r);
          out[i] = clamp16(r);
        }
        this.vco = 0;
        break;
      case 0x13:
        for (let i = 0; i < 8; i++) {
          const sv = v[s + i];
          let r: number;
          if (sv < 0) {
            r = -t[i];
            this.setAccLow(i, r);
            out[i] = t[i] === -32768 ? 32767 : r;
          } else {
            r = sv === 0 ? 0 : t[i];
            this.setAccLow(i, r);
            out[i] = r;
          }
        }
        break;
      case 0x14: {
        let co = 0;
        for (let i = 0; i < 8; i++) {
          const r = (v[s + i] & 0xffff) + (t[i] & 0xffff);
          this.setAccLow(i, r);
          out[i] = r;
          if (r > 0xffff) co |= 1 << i;
        }
        this.vco = co;
        break;
      }
      case 0x15: {
        let co = 0;
        for (let i = 0; i < 8; i++) {
          const r = (v[s + i] & 0xffff) - (t[i] & 0xffff);
          this.setAccLow(i, r);
          out[i] = r;
          if (r < 0) co |= 0x101 << i;
          else if (r !== 0) co |= 0x100 << i;
        }
        this.vco = co;
        break;
      }
      case 0x1d:
        for (let i = 0; i < 8; i++) {
          const a = acc[i];
          if (e === 8) out[i] = Math.floor(a / 4294967296);
          else if (e === 9) out[i] = Math.floor(a / 65536);
          else if (e === 10) out[i] = a - Math.floor(a / 65536) * 65536;
          else out[i] = 0;
        }
        break;
      default:
        return this.vRsvd(f, e, vsR, s, d, t, out);
    }
    return true;
  }

  private vCmp(f: number, e: number, vsR: number, s: number, d: number, t: Int16Array, out: Int16Array): boolean {
    const v = this.v;
    switch (f) {
      case 0x20:
      case 0x21:
      case 0x22:
      case 0x23: {
        let cc = 0;
        for (let i = 0; i < 8; i++) {
          const sv = v[s + i];
          const tv = t[i];
          const co = (this.vco >> i) & 1;
          const ne = (this.vco >> (i + 8)) & 1;
          let c: boolean;
          if (f === 0x20) c = sv < tv || (sv === tv && ne === 1 && co === 1);
          else if (f === 0x21) c = sv === tv && ne === 0;
          else if (f === 0x22) c = sv !== tv || ne === 1;
          else c = sv > tv || (sv === tv && !(ne === 1 && co === 1));
          if (c) cc |= 1 << i;
          out[i] = c ? sv : tv;
          this.setAccLow(i, out[i]);
        }
        this.vcc = cc;
        this.vco = 0;
        break;
      }
      case 0x24: {
        let cc = this.vcc;
        for (let i = 0; i < 8; i++) {
          const sv = v[s + i] & 0xffff;
          const tv = t[i] & 0xffff;
          const co = (this.vco >> i) & 1;
          const ne = (this.vco >> (i + 8)) & 1;
          let le = (cc >> i) & 1;
          let ge = (cc >> (i + 8)) & 1;
          let di: number;
          if (co) {
            if (!ne) {
              const sum = sv + tv;
              const carry = sum > 0xffff;
              const lz = (sum & 0xffff) === 0;
              le = ((this.vce >> i) & 1 ? lz || !carry : lz && !carry) ? 1 : 0;
            }
            di = le ? -tv : sv;
          } else {
            if (!ne) ge = sv - tv >= 0 ? 1 : 0;
            di = ge ? tv : sv;
          }
          cc = (cc & ~(0x101 << i)) | (le << i) | (ge << (i + 8));
          out[i] = di;
          this.setAccLow(i, di);
        }
        this.vcc = cc;
        this.vco = 0;
        this.vce = 0;
        break;
      }
      case 0x25: {
        let cc = 0;
        let co = 0;
        let ce = 0;
        for (let i = 0; i < 8; i++) {
          const sv = v[s + i];
          const tv = t[i];
          let di: number;
          if ((sv ^ tv) < 0) {
            const sum = sv + tv;
            const ge = tv < 0;
            const le = sum <= 0;
            const vce = sum === -1;
            const ne = sum !== 0 && !vce;
            di = le ? -tv : sv;
            if (le) cc |= 1 << i;
            if (ge) cc |= 0x100 << i;
            co |= 1 << i;
            if (ne) co |= 0x100 << i;
            if (vce) ce |= 1 << i;
          } else {
            const diff = sv - tv;
            const le = tv < 0;
            const ge = diff >= 0;
            di = ge ? tv : sv;
            if (le) cc |= 1 << i;
            if (ge) cc |= 0x100 << i;
            if (diff !== 0) co |= 0x100 << i;
          }
          out[i] = di;
          this.setAccLow(i, di);
        }
        this.vcc = cc;
        this.vco = co;
        this.vce = ce;
        break;
      }
      case 0x26: {
        let cc = 0;
        for (let i = 0; i < 8; i++) {
          const sv = v[s + i];
          const tv = t[i];
          let di: number;
          if ((sv ^ tv) < 0) {
            const ge = tv < 0;
            const le = sv + tv + 1 <= 0;
            di = le ? ~tv : sv;
            if (le) cc |= 1 << i;
            if (ge) cc |= 0x100 << i;
          } else {
            const le = tv < 0;
            const ge = sv - tv >= 0;
            di = ge ? tv : sv;
            if (le) cc |= 1 << i;
            if (ge) cc |= 0x100 << i;
          }
          out[i] = di;
          this.setAccLow(i, di);
        }
        this.vcc = cc;
        this.vco = 0;
        this.vce = 0;
        break;
      }
      case 0x27:
        for (let i = 0; i < 8; i++) {
          out[i] = (this.vcc >> i) & 1 ? v[s + i] : t[i];
          this.setAccLow(i, out[i]);
        }
        this.vco = 0;
        break;
      default:
        return this.vRsvd(f, e, vsR, s, d, t, out);
    }
    return true;
  }

  private vLogic(f: number, e: number, vsR: number, s: number, d: number, t: Int16Array, out: Int16Array): boolean {
    const v = this.v;
    switch (f) {
      case 0x28:
      case 0x29:
      case 0x2a:
      case 0x2b:
      case 0x2c:
      case 0x2d:
        for (let i = 0; i < 8; i++) {
          const a = v[s + i];
          const b = t[i];
          let r: number;
          switch (f) {
            case 0x28:
              r = a & b;
              break;
            case 0x29:
              r = ~(a & b);
              break;
            case 0x2a:
              r = a | b;
              break;
            case 0x2b:
              r = ~(a | b);
              break;
            case 0x2c:
              r = a ^ b;
              break;
            default:
              r = ~(a ^ b);
          }
          out[i] = r;
          this.setAccLow(i, r);
        }
        break;
      default:
        return this.vRsvd(f, e, vsR, s, d, t, out);
    }
    return true;
  }

  private vDiv(f: number, e: number, vsR: number, s: number, d: number, t: Int16Array, out: Int16Array): boolean {
    const v = this.v;
    switch (f) {
      case 0x30:
      case 0x31:
      case 0x34:
      case 0x35: {
        const low = f === 0x31 || f === 0x35;
        const tv = t[e & 7];
        const input = low && this.divDp ? (this.divIn << 16) | (tv & 0xffff) : tv;
        const result = f < 0x34 ? this.rcp(input) : this.rsq(input);
        this.divDp = false;
        this.divOut = result >> 16;
        for (let i = 0; i < 8; i++) {
          this.setAccLow(i, t[i]);
          out[i] = v[d + i];
        }
        out[vsR & 7] = result;
        break;
      }
      case 0x32:
      case 0x36:
        for (let i = 0; i < 8; i++) {
          this.setAccLow(i, t[i]);
          out[i] = v[d + i];
        }
        this.divDp = true;
        this.divIn = t[e & 7];
        out[vsR & 7] = this.divOut;
        break;
      case 0x33:
        for (let i = 0; i < 8; i++) {
          this.setAccLow(i, t[i]);
          out[i] = v[d + i];
        }
        out[vsR & 7] = t[e & 7];
        break;
      case 0x37:
      case 0x3f:
        return false;
      default:
        return this.vRsvd(f, e, vsR, s, d, t, out);
    }
    return true;
  }

  private vRsvd(f: number, e: number, vsR: number, s: number, d: number, t: Int16Array, out: Int16Array): boolean {
    const v = this.v;
    switch (f) {
      default:
        // 使われない番号：アキュムレーターの下位に足した値が入り、結果は 0 になる
        for (let i = 0; i < 8; i++) {
          this.setAccLow(i, v[s + i] + t[i]);
          out[i] = 0;
        }
    
    }
    return true;
  }


  /** アキュムレーターの下位 16 ビットだけ入れ替える */
  private setAccLow(i: number, val: number): void {
    const a = this.acc[i];
    this.acc[i] = Math.floor(a / 65536) * 65536 + (val & 0xffff);
  }

  stateSkip(): unknown[] {
    return [this.mem8, this.mem32, this.tmp, this.vte, this.jit];
  }
}
