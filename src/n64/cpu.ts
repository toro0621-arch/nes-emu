// NINTENDO64 の CPU（VR4300。64 ビットの MIPS III）。
// レジスタは 64 ビットなので、上位 32 ビットと下位 32 ビットを別々の配列で持つ（JavaScript の数は 32 ビットの計算が速い）。
// 浮動小数点（COP1）、TLB（仮想アドレスの変換表）、例外・割り込みまで入っている

import type { Jit } from './jit';

export interface N64Bus {
  /** 経過したクロック */
  cycles: number;
  stopAt: number;
  /** メモリの読み書き（物理アドレス）。RDRAM は CPU が直接読む */
  read32(p: number): number;
  read16(p: number): number;
  read8(p: number): number;
  write32(p: number, v: number): void;
  write16(p: number, v: number): void;
  write8(p: number, v: number): void;
  /** RDRAM（ワードごとにこの機械の並びで持つ。バイトは番地 ^ 3、ハーフワードは番地 ^ 2） */
  ram8: Uint8Array;
  ram16: Uint16Array;
  ram32: Int32Array;
  ramSize: number;
  /** MI の割り込みが来ている */
  miPending: boolean;
  /** 待ちループの見張り */
  writes: number;
  volatileRead: boolean;
}

/** 1 命令のクロック（実機は命令によって違うが、平均でこのくらい） */
export const CYCLES_PER_OP = 3;

const EXC_INT = 0;
const EXC_MOD = 1;
const EXC_TLBL = 2;
const EXC_TLBS = 3;
const EXC_ADEL = 4;
const EXC_ADES = 5;
const EXC_SYS = 8;
const EXC_BP = 9;
const EXC_RI = 10;
const EXC_CPU = 11;
const EXC_OV = 12;
const EXC_TR = 13;
const EXC_FPE = 15;

const P32 = 4294967296;

class TlbEntry {
  mask = 0;
  vpn2 = 0;
  asid = 0;
  g = false;
  pfn0 = 0;
  pfn1 = 0;
  v0 = false;
  v1 = false;
  d0 = false;
  d1 = false;
  // 書いたままの値（読み戻し用）
  lo0 = 0;
  lo1 = 0;
  hiRaw = 0;
}

function roundEven(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0) return r - 1;
  return r;
}

export class Vr4300 {
  lo = new Int32Array(32);
  hi = new Int32Array(32);
  // 掛け算・割り算の結果（HI・LO）
  mhiL = 0;
  mhiH = 0;
  mloL = 0;
  mloH = 0;
  pc = 0;
  nextPc = 0;
  curPc = 0;
  inDelay = false;
  branched = false;
  llbit = false;

  // COP0
  index = 0;
  entryLo0 = 0;
  entryLo1 = 0;
  context = 0;
  pageMask = 0;
  wired = 0;
  badVaddr = 0;
  entryHi = 0;
  compare = 0;
  status = 0x34000000;
  cause = 0;
  epc = 0;
  config = 0x7006e463;
  llAddr = 0;
  watchLo = 0;
  watchHi = 0;
  xcontext = 0;
  tagLo = 0;
  errorEpc = 0;
  /** COP0 に最後に書いた値（使われていないレジスタを読むと見える） */
  private cop0Latch = 0;
  /** Count の基準（Count = (cycles - countBase) / 2） */
  countBase = 0;
  /** 次に Count = Compare になる時刻 */
  timerAt = Infinity;
  /** 割り込みを受け付ける状態で、割り込みが来ている */
  intReady = false;
  tlb = Array.from({ length: 32 }, () => new TlbEntry());
  // TLB の変換を 1 ページぶん覚えておく
  private tcPage = -1;
  private tcPhys = 0;
  private tcWritable = false;

  // COP1（浮動小数点）：64 ビット × 32 本
  private fbuf = new ArrayBuffer(32 * 8);
  f64 = new Float64Array(this.fbuf);
  f32 = new Float32Array(this.fbuf);
  fi = new Int32Array(this.fbuf);
  fcr31 = 0;
  private tmpBuf = new ArrayBuffer(8);
  private tmpF64 = new Float64Array(this.tmpBuf);
  private tmpI32 = new Int32Array(this.tmpBuf);
  private tmpF32 = new Float32Array(this.tmpBuf);

  // 待ちループ
  private idlePc = -1;
  private idleSnap = new Int32Array(64);
  private idleWrites = 0;

  /** 速く動かすための書き換え（使えなければ null） */
  jit: Jit | null = null;

  constructor(public bus: N64Bus) {}

  // ---- COP0 ----
  get count(): number {
    return Math.floor((this.bus.cycles - this.countBase) / 2) >>> 0;
  }

  private updateTimer(): void {
    const d = ((this.compare - this.count) >>> 0) || P32;
    this.timerAt = this.bus.cycles + d * 2;
  }

  /** 時刻が来たらタイマーの割り込み */
  checkTimer(): void {
    if (this.bus.cycles >= this.timerAt) {
      this.cause |= 0x8000;
      this.timerAt += P32 * 2;
      this.updateInt();
    }
  }

  /** 割り込みを受け付けるか調べ直す（Status・Cause・MI が変わったら呼ぶ） */
  updateInt(): void {
    if (this.bus.miPending) this.cause |= 0x400;
    else this.cause &= ~0x400;
    this.intReady = (this.status & 7) === 1 && (this.status & this.cause & 0xff00) !== 0;
    if (this.intReady && this.bus.stopAt > this.bus.cycles + 1) this.soon = true;
  }
  /** 割り込みが来たので、待ちループの飛ばしをやめる */
  private soon = false;

  private readCop0(r: number): number {
    switch (r) {
      case 0:
        return this.index;
      case 1: {
        // Random：Wired〜31 の間をまわる
        const span = 32 - (this.wired & 31);
        return (this.wired & 31) + (Math.floor(this.bus.cycles / CYCLES_PER_OP) % span);
      }
      case 2:
        return this.entryLo0;
      case 3:
        return this.entryLo1;
      case 4:
        return this.context;
      case 5:
        return this.pageMask;
      case 6:
        return this.wired;
      case 8:
        return this.badVaddr;
      case 9:
        return this.count | 0;
      case 10:
        return this.entryHi;
      case 11:
        return this.compare;
      case 12:
        return this.status;
      case 13:
        return this.cause;
      case 14:
        return this.epc;
      case 15:
        return 0x00000b22;
      case 16:
        return this.config;
      case 17:
        return this.llAddr;
      case 18:
        return this.watchLo;
      case 19:
        return this.watchHi;
      case 20:
        return this.xcontext;
      case 28:
        return this.tagLo;
      case 30:
        return this.errorEpc;
    }
    return this.cop0Latch;
  }

  private writeCop0(r: number, v: number): void {
    this.cop0Latch = v;
    switch (r) {
      case 0:
        this.index = v & 0x8000003f;
        return;
      case 2:
        this.entryLo0 = v & 0x3fffffff;
        return;
      case 3:
        this.entryLo1 = v & 0x3fffffff;
        return;
      case 4:
        this.context = (this.context & 0x007ffff0) | (v & 0xff800000);
        return;
      case 5:
        this.pageMask = v & 0x01ffe000;
        return;
      case 6:
        this.wired = v & 0x3f;
        return;
      case 8:
        return;
      case 9:
        this.countBase = this.bus.cycles - (v >>> 0) * 2;
        this.updateTimer();
        return;
      case 10:
        this.entryHi = v & 0xffffe0ff;
        this.tcPage = -1;
        return;
      case 11:
        this.compare = v;
        this.cause &= ~0x8000;
        this.updateTimer();
        this.updateInt();
        return;
      case 12:
        this.status = v;
        this.updateInt();
        return;
      case 13:
        this.cause = (this.cause & ~0x300) | (v & 0x300);
        this.updateInt();
        return;
      case 14:
        this.epc = v;
        return;
      case 16:
        this.config = (this.config & ~0x0f00800f) | (v & 0x0f00800f);
        return;
      case 17:
        this.llAddr = v;
        return;
      case 18:
        this.watchLo = v & 0xfffffffb;
        return;
      case 19:
        this.watchHi = v & 0xf;
        return;
      case 20:
        this.xcontext = v;
        return;
      case 28:
        this.tagLo = v & 0x0fffffc0;
        return;
      case 30:
        this.errorEpc = v;
        return;
    }
  }

  private tlbRead(): void {
    const e = this.tlb[this.index & 31];
    this.pageMask = e.mask;
    this.entryHi = e.hiRaw;
    this.entryLo0 = e.lo0;
    this.entryLo1 = e.lo1;
  }

  private tlbWrite(i: number): void {
    const e = this.tlb[i & 31];
    e.mask = this.pageMask;
    e.hiRaw = this.entryHi & ~this.pageMask;
    e.vpn2 = (this.entryHi & ~this.pageMask) >>> 13;
    e.asid = this.entryHi & 0xff;
    e.g = (this.entryLo0 & this.entryLo1 & 1) !== 0;
    e.lo0 = (this.entryLo0 & ~1) | (e.g ? 1 : 0);
    e.lo1 = (this.entryLo1 & ~1) | (e.g ? 1 : 0);
    e.pfn0 = (this.entryLo0 >>> 6) & 0xfffff;
    e.pfn1 = (this.entryLo1 >>> 6) & 0xfffff;
    e.v0 = (this.entryLo0 & 2) !== 0;
    e.v1 = (this.entryLo1 & 2) !== 0;
    e.d0 = (this.entryLo0 & 4) !== 0;
    e.d1 = (this.entryLo1 & 4) !== 0;
    this.tcPage = -1;
  }

  private tlbProbe(): void {
    this.index = 0x80000000 | 0;
    const asid = this.entryHi & 0xff;
    for (let i = 0; i < 32; i++) {
      const e = this.tlb[i];
      if (e.vpn2 === ((this.entryHi & ~e.mask) >>> 13) && (e.g || e.asid === asid)) {
        this.index = i;
        return;
      }
    }
  }

  /** 仮想アドレス → 物理アドレス（変換できなければ例外を起こして -1） */
  private translate(v: number, write: boolean): number {
    const seg = v >>> 29;
    if (seg === 4 || seg === 5) return v & 0x1fffffff;
    const page = v >>> 12;
    if (page === this.tcPage && (!write || this.tcWritable)) return this.tcPhys | (v & 0xfff);
    const asid = this.entryHi & 0xff;
    for (let i = 0; i < 32; i++) {
      const e = this.tlb[i];
      const mask = e.mask | 0x1fff;
      if ((v & ~mask) >>> 13 !== e.vpn2 || !(e.g || e.asid === asid)) continue;
      const odd = (v & ((mask + 1) >>> 1)) !== 0;
      const valid = odd ? e.v1 : e.v0;
      if (!valid) {
        this.tlbException(v, write, false);
        return -1;
      }
      const dirty = odd ? e.d1 : e.d0;
      if (write && !dirty) {
        this.tlbFault(v);
        this.exception(EXC_MOD);
        return -1;
      }
      const pfn = odd ? e.pfn1 : e.pfn0;
      const pageMask = mask >>> 1;
      const phys = ((pfn << 12) & ~pageMask) | (v & pageMask);
      this.tcPage = page;
      this.tcPhys = phys & ~0xfff;
      this.tcWritable = dirty;
      return phys & 0x1fffffff;
    }
    this.tlbException(v, write, true);
    return -1;
  }

  private tlbFault(v: number): void {
    this.badVaddr = v;
    this.context = (this.context & 0xff800000) | ((v >>> 9) & 0x007ffff0);
    this.entryHi = (v & 0xffffe000) | (this.entryHi & 0xff);
  }

  private tlbException(v: number, write: boolean, miss: boolean): void {
    this.tlbFault(v);
    const refill = miss && !(this.status & 2);
    this.exception(write ? EXC_TLBS : EXC_TLBL);
    if (refill) {
      const base = this.status & 0x400000 ? 0xbfc00200 | 0 : 0x80000000 | 0;
      this.pc = base;
      this.nextPc = (base + 4) | 0;
    }
  }

  exception(code: number, ce = 0): void {
    if (!(this.status & 2)) {
      if (this.inDelay) {
        this.epc = (this.curPc - 4) | 0;
        this.cause |= 0x80000000;
      } else {
        this.epc = this.curPc;
        this.cause &= 0x7fffffff;
      }
    }
    this.status |= 2;
    this.cause = (this.cause & ~0x3000007c) | (code << 2) | (ce << 28);
    const base = this.status & 0x400000 ? 0xbfc00200 | 0 : 0x80000000 | 0;
    this.pc = (base + 0x180) | 0;
    this.nextPc = (this.pc + 4) | 0;
    this.branched = false;
    this.intReady = false;
    this.aborted = true;
  }
  /** この命令が例外で打ち切られた（結果を書かない） */
  aborted = false;

  addrError(v: number, write: boolean): void {
    this.badVaddr = v;
    this.exception(write ? EXC_ADES : EXC_ADEL);
  }

  // ---- メモリ（仮想アドレス） ----
  r32(v: number): number {
    if (v & 3) {
      this.addrError(v, false);
      return 0;
    }
    const p = this.translate(v, false);
    if (p < 0) return 0;
    const b = this.bus;
    if (p < b.ramSize) return b.ram32[p >> 2];
    return b.read32(p);
  }
  r16(v: number): number {
    if (v & 1) {
      this.addrError(v, false);
      return 0;
    }
    const p = this.translate(v, false);
    if (p < 0) return 0;
    const b = this.bus;
    if (p < b.ramSize) return b.ram16[(p ^ 2) >> 1];
    return b.read16(p);
  }
  r8(v: number): number {
    const p = this.translate(v, false);
    if (p < 0) return 0;
    const b = this.bus;
    if (p < b.ramSize) return b.ram8[p ^ 3];
    return b.read8(p);
  }
  w32(v: number, x: number): void {
    if (v & 3) return this.addrError(v, true);
    const p = this.translate(v, true);
    if (p < 0) return;
    const b = this.bus;
    b.writes++;
    if (p < b.ramSize) {
      b.ram32[p >> 2] = x;
      if (this.jit !== null && this.jit.codeWords[p >> 2]) this.jit.invalidate(p);
    } else b.write32(p, x);
  }
  w16(v: number, x: number): void {
    if (v & 1) return this.addrError(v, true);
    const p = this.translate(v, true);
    if (p < 0) return;
    const b = this.bus;
    b.writes++;
    if (p < b.ramSize) {
      b.ram16[(p ^ 2) >> 1] = x;
      if (this.jit !== null && this.jit.codeWords[p >> 2]) this.jit.invalidate(p);
    } else b.write16(p, x & 0xffff);
  }
  w8(v: number, x: number): void {
    const p = this.translate(v, true);
    if (p < 0) return;
    const b = this.bus;
    b.writes++;
    if (p < b.ramSize) {
      b.ram8[p ^ 3] = x;
      if (this.jit !== null && this.jit.codeWords[p >> 2]) this.jit.invalidate(p);
    } else b.write8(p, x & 0xff);
  }

  // ---- 実行 ----
  run(): void {
    const b = this.bus;
    while (b.cycles < b.stopAt) {
      if (this.intReady) {
        this.curPc = this.pc;
        this.inDelay = this.branched;
        this.exception(EXC_INT);
        continue;
      }
      const jit = this.jit;
      if (jit !== null && !this.branched) {
        const blk = jit.get(this.pc);
        if (blk !== null) {
          blk(this);
          this.lo[0] = 0;
          this.hi[0] = 0;
          continue;
        }
      }
      this.step();
    }
  }

  step(): void {
    const b = this.bus;
    const pc = this.pc;
    this.curPc = pc;
    this.inDelay = this.branched;
    this.branched = false;
    this.aborted = false;
    b.cycles += CYCLES_PER_OP;
    let op: number;
    {
      // 命令を読む
      const seg = pc >>> 29;
      let p: number;
      if ((seg === 4 || seg === 5) && !(pc & 3)) p = pc & 0x1fffffff;
      else {
        if (pc & 3) {
          this.addrError(pc, false);
          return;
        }
        p = this.translate(pc, false);
        if (p < 0) return;
      }
      op = p < b.ramSize ? b.ram32[p >> 2] : b.read32(p);
    }
    this.pc = this.nextPc;
    this.nextPc = (this.nextPc + 4) | 0;
    this.execute(op);
    this.lo[0] = 0;
    this.hi[0] = 0;
  }

  private branch(target: number): void {
    this.nextPc = target | 0;
    this.branched = true;
    const back = this.curPc - target;
    if (back >= 0 && back <= 32) this.checkIdle(target);
  }

  /** 条件が外れた「likely」の分岐：次の 1 命令を飛ばす */
  private skipDelay(): void {
    this.pc = this.nextPc;
    this.nextPc = (this.nextPc + 4) | 0;
  }

  /** 待ちループの見張り：同じ分岐先に、書き込みも入出力の読み込みもないまま戻ってきたら、レジスタも変わっていないか比べる */
  private idleArmed = false;
  private idleMiss = 0;

  checkIdle(target: number): void {
    const b = this.bus;
    if (this.soon) {
      this.soon = false;
      this.idlePc = -1;
      return;
    }
    if (target !== this.idlePc) {
      this.idlePc = target;
      this.idleWrites = b.writes;
      b.volatileRead = false;
      this.idleArmed = false;
      this.idleMiss = 0;
      return;
    }
    if (b.writes !== this.idleWrites || b.volatileRead) {
      this.idleWrites = b.writes;
      b.volatileRead = false;
      this.idleArmed = false;
      return;
    }
    // レジスタが毎回変わるループ（数を数えるだけの待ちなど）は、何回か外れたらあきらめる
    if (this.idleMiss > 8) return;
    const s = this.idleSnap;
    const lo = this.lo;
    const hi = this.hi;
    if (this.idleArmed) {
      let same = true;
      for (let i = 1; i < 32; i++)
        if (s[i] !== lo[i] || s[32 + i] !== hi[i]) {
          same = false;
          break;
        }
      if (same) {
        if (b.stopAt > b.cycles) b.cycles = b.stopAt;
        return;
      }
      this.idleMiss++;
    }
    s.set(lo);
    s.set(hi, 32);
    this.idleArmed = true;
  }

  /** 32 ビットの結果を入れる（上位は符号で埋める） */
  set32(r: number, v: number): void {
    this.lo[r] = v;
    this.hi[r] = v >> 31;
  }

  execute(op: number): void {
    const lo = this.lo;
    const hi = this.hi;
    const rs = (op >>> 21) & 31;
    const rt = (op >>> 16) & 31;
    const imm = (op << 16) >> 16;
    switch (op >>> 26) {
      case 0x00:
        return this.special(op, rs, rt);
      case 0x01:
        return this.regimm(op, rs, rt, imm);
      case 0x02:
        this.branch((this.pc & 0xf0000000) | ((op & 0x3ffffff) << 2));
        return;
      case 0x03:
        this.set32(31, (this.curPc + 8) | 0);
        this.branch((this.pc & 0xf0000000) | ((op & 0x3ffffff) << 2));
        return;
      case 0x04:
        if (lo[rs] === lo[rt] && hi[rs] === hi[rt]) this.branch(this.pc + (imm << 2));
        return;
      case 0x05:
        if (lo[rs] !== lo[rt] || hi[rs] !== hi[rt]) this.branch(this.pc + (imm << 2));
        return;
      case 0x06:
        if (hi[rs] < 0 || (hi[rs] === 0 && lo[rs] === 0)) this.branch(this.pc + (imm << 2));
        return;
      case 0x07:
        if (hi[rs] > 0 || (hi[rs] === 0 && lo[rs] !== 0)) this.branch(this.pc + (imm << 2));
        return;
      case 0x08: {
        // ADDI（あふれたら例外）
        const a = lo[rs];
        const v = (a + imm) | 0;
        if (~(a ^ imm) & (a ^ v) & 0x80000000) this.exception(EXC_OV);
        else this.set32(rt, v);
        return;
      }
      case 0x09:
        this.set32(rt, (lo[rs] + imm) | 0);
        return;
      case 0x0a: {
        const ih = imm >> 31;
        lo[rt] = hi[rs] < ih || (hi[rs] === ih && lo[rs] >>> 0 < imm >>> 0) ? 1 : 0;
        hi[rt] = 0;
        return;
      }
      case 0x0b: {
        const ih = imm >> 31;
        lo[rt] = hi[rs] >>> 0 < ih >>> 0 || (hi[rs] === ih && lo[rs] >>> 0 < imm >>> 0) ? 1 : 0;
        hi[rt] = 0;
        return;
      }
      case 0x0c:
        lo[rt] = lo[rs] & (op & 0xffff);
        hi[rt] = 0;
        return;
      case 0x0d:
        lo[rt] = lo[rs] | (op & 0xffff);
        hi[rt] = hi[rs];
        return;
      case 0x0e:
        lo[rt] = lo[rs] ^ (op & 0xffff);
        hi[rt] = hi[rs];
        return;
      case 0x0f:
        this.set32(rt, op << 16);
        return;
      case 0x10:
        return this.cop0(op, rs, rt);
      case 0x11:
        return this.cop1(op, rs, rt);
      case 0x12:
        this.exception(EXC_CPU, 2);
        return;
      case 0x13:
        this.exception(EXC_RI);
        return;
      case 0x14:
        if (lo[rs] === lo[rt] && hi[rs] === hi[rt]) this.branch(this.pc + (imm << 2));
        else this.skipDelay();
        return;
      case 0x15:
        if (lo[rs] !== lo[rt] || hi[rs] !== hi[rt]) this.branch(this.pc + (imm << 2));
        else this.skipDelay();
        return;
      case 0x16:
        if (hi[rs] < 0 || (hi[rs] === 0 && lo[rs] === 0)) this.branch(this.pc + (imm << 2));
        else this.skipDelay();
        return;
      case 0x17:
        if (hi[rs] > 0 || (hi[rs] === 0 && lo[rs] !== 0)) this.branch(this.pc + (imm << 2));
        else this.skipDelay();
        return;
      case 0x18: {
        // DADDI
        const al = lo[rs];
        const ah = hi[rs];
        const bh = imm >> 31;
        const l = (al + imm) | 0;
        const h = (ah + bh + (l >>> 0 < al >>> 0 ? 1 : 0)) | 0;
        if (~(ah ^ bh) & (ah ^ h) & 0x80000000) this.exception(EXC_OV);
        else {
          lo[rt] = l;
          hi[rt] = h;
        }
        return;
      }
      case 0x19: {
        const al = lo[rs];
        const l = (al + imm) | 0;
        hi[rt] = (hi[rs] + (imm >> 31) + (l >>> 0 < al >>> 0 ? 1 : 0)) | 0;
        lo[rt] = l;
        return;
      }
      case 0x1a:
        return this.ldl(rt, (lo[rs] + imm) | 0);
      case 0x1b:
        return this.ldr(rt, (lo[rs] + imm) | 0);
      case 0x20: {
        const v = this.r8((lo[rs] + imm) | 0);
        if (!this.aborted) this.set32(rt, (v << 24) >> 24);
        return;
      }
      case 0x21: {
        const v = this.r16((lo[rs] + imm) | 0);
        if (!this.aborted) this.set32(rt, (v << 16) >> 16);
        return;
      }
      case 0x22: {
        // LWL
        const a = (lo[rs] + imm) | 0;
        const w = this.r32(a & ~3);
        if (this.aborted) return;
        const sh = (a & 3) * 8;
        this.set32(rt, sh ? (w << sh) | (lo[rt] & ((1 << sh) - 1)) : w);
        return;
      }
      case 0x23: {
        const v = this.r32((lo[rs] + imm) | 0);
        if (!this.aborted) this.set32(rt, v);
        return;
      }
      case 0x24: {
        const v = this.r8((lo[rs] + imm) | 0);
        if (!this.aborted) {
          lo[rt] = v;
          hi[rt] = 0;
        }
        return;
      }
      case 0x25: {
        const v = this.r16((lo[rs] + imm) | 0);
        if (!this.aborted) {
          lo[rt] = v;
          hi[rt] = 0;
        }
        return;
      }
      case 0x26: {
        // LWR
        const a = (lo[rs] + imm) | 0;
        const w = this.r32(a & ~3);
        if (this.aborted) return;
        const sh = (3 - (a & 3)) * 8;
        this.set32(rt, sh ? (w >>> sh) | (lo[rt] & ~(0xffffffff >>> sh)) : w);
        return;
      }
      case 0x27: {
        const v = this.r32((lo[rs] + imm) | 0);
        if (!this.aborted) {
          lo[rt] = v;
          hi[rt] = 0;
        }
        return;
      }
      case 0x28:
        this.w8((lo[rs] + imm) | 0, lo[rt] & 0xff);
        return;
      case 0x29:
        this.w16((lo[rs] + imm) | 0, lo[rt] & 0xffff);
        return;
      case 0x2a: {
        // SWL
        const a = (lo[rs] + imm) | 0;
        const sh = (a & 3) * 8;
        if (!sh) return this.w32(a, lo[rt]);
        const w = this.r32(a & ~3);
        if (this.aborted) return;
        this.w32(a & ~3, (w & ~(0xffffffff >>> sh)) | (lo[rt] >>> sh));
        return;
      }
      case 0x2b:
        this.w32((lo[rs] + imm) | 0, lo[rt]);
        return;
      case 0x2c:
        return this.sdl(rt, (lo[rs] + imm) | 0);
      case 0x2d:
        return this.sdr(rt, (lo[rs] + imm) | 0);
      case 0x2e: {
        // SWR
        const a = (lo[rs] + imm) | 0;
        const sh = (3 - (a & 3)) * 8;
        if (!sh) return this.w32(a & ~3, lo[rt]);
        const w = this.r32(a & ~3);
        if (this.aborted) return;
        this.w32(a & ~3, (w & ((1 << sh) - 1)) | (lo[rt] << sh));
        return;
      }
      case 0x2f:
        return; // CACHE
      case 0x30: {
        // LL
        const a = (lo[rs] + imm) | 0;
        const v = this.r32(a);
        if (this.aborted) return;
        this.set32(rt, v);
        this.llbit = true;
        this.llAddr = (a & 0x1fffffff) >>> 4;
        return;
      }
      case 0x31: {
        // LWC1
        if (!this.fpuOk()) return;
        const v = this.r32((lo[rs] + imm) | 0);
        if (!this.aborted) this.fi[this.fidx(rt)] = v;
        return;
      }
      case 0x34: {
        // LLD
        const a = (lo[rs] + imm) | 0;
        if (a & 7) return this.addrError(a, false);
        const h = this.r32(a);
        if (this.aborted) return;
        const l = this.r32(a + 4);
        hi[rt] = h;
        lo[rt] = l;
        this.llbit = true;
        this.llAddr = (a & 0x1fffffff) >>> 4;
        return;
      }
      case 0x35: {
        // LDC1
        if (!this.fpuOk()) return;
        const a = (lo[rs] + imm) | 0;
        if (a & 7) return this.addrError(a, false);
        const h = this.r32(a);
        if (this.aborted) return;
        const l = this.r32(a + 4);
        this.setDBits(rt, l, h);
        return;
      }
      case 0x37: {
        // LD
        const a = (lo[rs] + imm) | 0;
        if (a & 7) return this.addrError(a, false);
        const h = this.r32(a);
        if (this.aborted) return;
        const l = this.r32(a + 4);
        hi[rt] = h;
        lo[rt] = l;
        return;
      }
      case 0x38: {
        // SC
        if (this.llbit) {
          this.w32((lo[rs] + imm) | 0, lo[rt]);
          if (this.aborted) return;
        }
        lo[rt] = this.llbit ? 1 : 0;
        hi[rt] = 0;
        this.llbit = false;
        return;
      }
      case 0x39:
        if (!this.fpuOk()) return;
        this.w32((lo[rs] + imm) | 0, this.fi[this.fidx(rt)]);
        return;
      case 0x3c: {
        // SCD
        if (this.llbit) {
          const a = (lo[rs] + imm) | 0;
          if (a & 7) return this.addrError(a, true);
          this.w32(a, hi[rt]);
          if (this.aborted) return;
          this.w32(a + 4, lo[rt]);
        }
        lo[rt] = this.llbit ? 1 : 0;
        hi[rt] = 0;
        this.llbit = false;
        return;
      }
      case 0x3d: {
        // SDC1
        if (!this.fpuOk()) return;
        const a = (lo[rs] + imm) | 0;
        if (a & 7) return this.addrError(a, true);
        this.w32(a, this.getDHi(rt));
        if (this.aborted) return;
        this.w32(a + 4, this.getDLo(rt));
        return;
      }
      case 0x3f: {
        // SD
        const a = (lo[rs] + imm) | 0;
        if (a & 7) return this.addrError(a, true);
        this.w32(a, hi[rt]);
        if (this.aborted) return;
        this.w32(a + 4, lo[rt]);
        return;
      }
    }
    this.exception(EXC_RI);
  }

  /** 8 バイトを上位から順に並べた配列にして読み書きする（LDL・LDR・SDL・SDR 用。あまり使われない） */
  private ldl(rt: number, a: number): void {
    const n = a & 7;
    const base = a & ~7;
    const mh = this.r32(base);
    if (this.aborted) return;
    const ml = this.r32(base + 4);
    let r = (BigInt(this.hi[rt] >>> 0) << 32n) | BigInt(this.lo[rt] >>> 0);
    const m = (BigInt(mh >>> 0) << 32n) | BigInt(ml >>> 0);
    const sh = BigInt(n * 8);
    r = ((m << sh) & 0xffffffffffffffffn) | (r & ((1n << sh) - 1n));
    this.hi[rt] = Number((r >> 32n) & 0xffffffffn) | 0;
    this.lo[rt] = Number(r & 0xffffffffn) | 0;
  }
  private ldr(rt: number, a: number): void {
    const n = a & 7;
    const base = a & ~7;
    const mh = this.r32(base);
    if (this.aborted) return;
    const ml = this.r32(base + 4);
    let r = (BigInt(this.hi[rt] >>> 0) << 32n) | BigInt(this.lo[rt] >>> 0);
    const m = (BigInt(mh >>> 0) << 32n) | BigInt(ml >>> 0);
    const sh = BigInt((7 - n) * 8);
    r = (m >> sh) | (r & ~(0xffffffffffffffffn >> sh) & 0xffffffffffffffffn);
    this.hi[rt] = Number((r >> 32n) & 0xffffffffn) | 0;
    this.lo[rt] = Number(r & 0xffffffffn) | 0;
  }
  private sdl(rt: number, a: number): void {
    const n = a & 7;
    const base = a & ~7;
    const mh = this.r32(base);
    if (this.aborted) return;
    const ml = this.r32(base + 4);
    const r = (BigInt(this.hi[rt] >>> 0) << 32n) | BigInt(this.lo[rt] >>> 0);
    let m = (BigInt(mh >>> 0) << 32n) | BigInt(ml >>> 0);
    const sh = BigInt(n * 8);
    m = (r >> sh) | (m & ~(0xffffffffffffffffn >> sh) & 0xffffffffffffffffn);
    this.w32(base, Number((m >> 32n) & 0xffffffffn) | 0);
    if (this.aborted) return;
    this.w32(base + 4, Number(m & 0xffffffffn) | 0);
  }
  private sdr(rt: number, a: number): void {
    const n = a & 7;
    const base = a & ~7;
    const mh = this.r32(base);
    if (this.aborted) return;
    const ml = this.r32(base + 4);
    const r = (BigInt(this.hi[rt] >>> 0) << 32n) | BigInt(this.lo[rt] >>> 0);
    let m = (BigInt(mh >>> 0) << 32n) | BigInt(ml >>> 0);
    const sh = BigInt((7 - n) * 8);
    m = ((r << sh) & 0xffffffffffffffffn) | (m & ((1n << sh) - 1n));
    this.w32(base, Number((m >> 32n) & 0xffffffffn) | 0);
    if (this.aborted) return;
    this.w32(base + 4, Number(m & 0xffffffffn) | 0);
  }

  private special(op: number, rs: number, rt: number): void {
    const lo = this.lo;
    const hi = this.hi;
    const rd = (op >>> 11) & 31;
    const sa = (op >>> 6) & 31;
    switch (op & 63) {
      case 0x00:
        this.set32(rd, lo[rt] << sa);
        return;
      case 0x02:
        this.set32(rd, lo[rt] >>> sa);
        return;
      case 0x03: {
        // SRA は 64 ビットの値をずらしてから下位 32 ビットを取る
        const v = sa ? (lo[rt] >>> sa) | (hi[rt] << (32 - sa)) : lo[rt];
        this.set32(rd, v);
        return;
      }
      case 0x04:
        this.set32(rd, lo[rt] << (lo[rs] & 31));
        return;
      case 0x06:
        this.set32(rd, lo[rt] >>> (lo[rs] & 31));
        return;
      case 0x07: {
        const s = lo[rs] & 31;
        this.set32(rd, s ? (lo[rt] >>> s) | (hi[rt] << (32 - s)) : lo[rt]);
        return;
      }
      case 0x08:
        this.branch(lo[rs]);
        return;
      case 0x09: {
        const t = lo[rs];
        this.set32(rd, (this.curPc + 8) | 0);
        this.branch(t);
        return;
      }
      case 0x0c:
        this.exception(EXC_SYS);
        return;
      case 0x0d:
        this.exception(EXC_BP);
        return;
      case 0x0f:
        return; // SYNC
      case 0x10:
        lo[rd] = this.mhiL;
        hi[rd] = this.mhiH;
        return;
      case 0x11:
        this.mhiL = lo[rs];
        this.mhiH = hi[rs];
        return;
      case 0x12:
        lo[rd] = this.mloL;
        hi[rd] = this.mloH;
        return;
      case 0x13:
        this.mloL = lo[rs];
        this.mloH = hi[rs];
        return;
      case 0x14:
        return this.dshift(rd, rt, lo[rs] & 63, 0);
      case 0x16:
        return this.dshift(rd, rt, lo[rs] & 63, 1);
      case 0x17:
        return this.dshift(rd, rt, lo[rs] & 63, 2);
      case 0x18: {
        const a = lo[rs];
        const c = lo[rt];
        const l = Math.imul(a, c);
        const h = mulHi32(a, c, true);
        this.mloL = l;
        this.mloH = l >> 31;
        this.mhiL = h;
        this.mhiH = h >> 31;
        return;
      }
      case 0x19: {
        const a = lo[rs];
        const c = lo[rt];
        const l = Math.imul(a, c);
        const h = mulHi32(a, c, false);
        this.mloL = l;
        this.mloH = l >> 31;
        this.mhiL = h;
        this.mhiH = h >> 31;
        return;
      }
      case 0x1a: {
        const n = lo[rs];
        const d = lo[rt];
        let q: number;
        let r: number;
        if (d === 0) {
          q = n < 0 ? 1 : -1;
          r = n;
        } else if (n === -0x80000000 && d === -1) {
          q = n;
          r = 0;
        } else {
          q = (n / d) | 0;
          r = n % d | 0;
        }
        this.mloL = q;
        this.mloH = q >> 31;
        this.mhiL = r;
        this.mhiH = r >> 31;
        return;
      }
      case 0x1b: {
        const n = lo[rs] >>> 0;
        const d = lo[rt] >>> 0;
        let q: number;
        let r: number;
        if (d === 0) {
          q = -1;
          r = n | 0;
        } else {
          q = Math.floor(n / d) | 0;
          r = n % d | 0;
        }
        this.mloL = q;
        this.mloH = q >> 31;
        this.mhiL = r;
        this.mhiH = r >> 31;
        return;
      }
      case 0x1c:
      case 0x1d: {
        // DMULT・DMULTU
        const signed = (op & 63) === 0x1c;
        let a = (BigInt(hi[rs]) << 32n) | BigInt(lo[rs] >>> 0);
        let c = (BigInt(hi[rt]) << 32n) | BigInt(lo[rt] >>> 0);
        if (!signed) {
          a = BigInt.asUintN(64, a);
          c = BigInt.asUintN(64, c);
        }
        const p = a * c;
        this.mloL = Number(p & 0xffffffffn) | 0;
        this.mloH = Number((p >> 32n) & 0xffffffffn) | 0;
        this.mhiL = Number((p >> 64n) & 0xffffffffn) | 0;
        this.mhiH = Number((p >> 96n) & 0xffffffffn) | 0;
        return;
      }
      case 0x1e:
      case 0x1f: {
        // DDIV・DDIVU
        const signed = (op & 63) === 0x1e;
        let n = (BigInt(hi[rs]) << 32n) | BigInt(lo[rs] >>> 0);
        let d = (BigInt(hi[rt]) << 32n) | BigInt(lo[rt] >>> 0);
        if (!signed) {
          n = BigInt.asUintN(64, n);
          d = BigInt.asUintN(64, d);
        }
        let q: bigint;
        let r: bigint;
        if (d === 0n) {
          q = signed && n < 0n ? 1n : -1n;
          r = n;
        } else {
          q = n / d;
          r = n % d;
        }
        this.mloL = Number(q & 0xffffffffn) | 0;
        this.mloH = Number((q >> 32n) & 0xffffffffn) | 0;
        this.mhiL = Number(r & 0xffffffffn) | 0;
        this.mhiH = Number((r >> 32n) & 0xffffffffn) | 0;
        return;
      }
      case 0x20: {
        const a = lo[rs];
        const c = lo[rt];
        const v = (a + c) | 0;
        if (~(a ^ c) & (a ^ v) & 0x80000000) this.exception(EXC_OV);
        else this.set32(rd, v);
        return;
      }
      case 0x21:
        this.set32(rd, (lo[rs] + lo[rt]) | 0);
        return;
      case 0x22: {
        const a = lo[rs];
        const c = lo[rt];
        const v = (a - c) | 0;
        if ((a ^ c) & (a ^ v) & 0x80000000) this.exception(EXC_OV);
        else this.set32(rd, v);
        return;
      }
      case 0x23:
        this.set32(rd, (lo[rs] - lo[rt]) | 0);
        return;
      case 0x24:
        lo[rd] = lo[rs] & lo[rt];
        hi[rd] = hi[rs] & hi[rt];
        return;
      case 0x25:
        lo[rd] = lo[rs] | lo[rt];
        hi[rd] = hi[rs] | hi[rt];
        return;
      case 0x26:
        lo[rd] = lo[rs] ^ lo[rt];
        hi[rd] = hi[rs] ^ hi[rt];
        return;
      case 0x27:
        lo[rd] = ~(lo[rs] | lo[rt]);
        hi[rd] = ~(hi[rs] | hi[rt]);
        return;
      case 0x2a:
        lo[rd] = hi[rs] < hi[rt] || (hi[rs] === hi[rt] && lo[rs] >>> 0 < lo[rt] >>> 0) ? 1 : 0;
        hi[rd] = 0;
        return;
      case 0x2b:
        lo[rd] = hi[rs] >>> 0 < hi[rt] >>> 0 || (hi[rs] === hi[rt] && lo[rs] >>> 0 < lo[rt] >>> 0) ? 1 : 0;
        hi[rd] = 0;
        return;
      case 0x2c:
      case 0x2d: {
        // DADD・DADDU
        const al = lo[rs];
        const ah = hi[rs];
        const bh = hi[rt];
        const l = (al + lo[rt]) | 0;
        const h = (ah + bh + (l >>> 0 < al >>> 0 ? 1 : 0)) | 0;
        if ((op & 63) === 0x2c && ~(ah ^ bh) & (ah ^ h) & 0x80000000) {
          this.exception(EXC_OV);
          return;
        }
        lo[rd] = l;
        hi[rd] = h;
        return;
      }
      case 0x2e:
      case 0x2f: {
        const al = lo[rs];
        const ah = hi[rs];
        const bl = lo[rt];
        const bh = hi[rt];
        const l = (al - bl) | 0;
        const h = (ah - bh - (al >>> 0 < bl >>> 0 ? 1 : 0)) | 0;
        if ((op & 63) === 0x2e && (ah ^ bh) & (ah ^ h) & 0x80000000) {
          this.exception(EXC_OV);
          return;
        }
        lo[rd] = l;
        hi[rd] = h;
        return;
      }
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x36: {
        // TGE・TGEU・TLT・TLTU・TEQ・TNE
        const lt = hi[rs] < hi[rt] || (hi[rs] === hi[rt] && lo[rs] >>> 0 < lo[rt] >>> 0);
        const ltu = hi[rs] >>> 0 < hi[rt] >>> 0 || (hi[rs] === hi[rt] && lo[rs] >>> 0 < lo[rt] >>> 0);
        const eq = lo[rs] === lo[rt] && hi[rs] === hi[rt];
        const f = op & 63;
        const trap = f === 0x30 ? !lt : f === 0x31 ? !ltu : f === 0x32 ? lt : f === 0x33 ? ltu : f === 0x34 ? eq : !eq;
        if (trap) this.exception(EXC_TR);
        return;
      }
      case 0x38:
        return this.dshift(rd, rt, sa, 0);
      case 0x3a:
        return this.dshift(rd, rt, sa, 1);
      case 0x3b:
        return this.dshift(rd, rt, sa, 2);
      case 0x3c:
        return this.dshift(rd, rt, sa + 32, 0);
      case 0x3e:
        return this.dshift(rd, rt, sa + 32, 1);
      case 0x3f:
        return this.dshift(rd, rt, sa + 32, 2);
    }
    this.exception(EXC_RI);
  }

  /** 64 ビットのシフト（kind：0 左、1 右、2 符号つきの右） */
  private dshift(rd: number, rt: number, s: number, kind: number): void {
    let l = this.lo[rt];
    let h = this.hi[rt];
    if (kind === 0) {
      if (s >= 32) {
        h = l << (s - 32);
        l = 0;
      } else if (s) {
        h = (h << s) | (l >>> (32 - s));
        l <<= s;
      }
    } else if (kind === 1) {
      if (s >= 32) {
        l = h >>> (s - 32);
        h = 0;
      } else if (s) {
        l = (l >>> s) | (h << (32 - s));
        h >>>= s;
      }
    } else if (s >= 32) {
      l = h >> (s - 32);
      h >>= 31;
    } else if (s) {
      l = (l >>> s) | (h << (32 - s));
      h >>= s;
    }
    this.lo[rd] = l;
    this.hi[rd] = h;
  }

  private regimm(op: number, rs: number, rt: number, imm: number): void {
    const neg = this.hi[rs] < 0;
    const target = this.pc + (imm << 2);
    switch (rt) {
      case 0x00:
        if (neg) this.branch(target);
        return;
      case 0x01:
        if (!neg) this.branch(target);
        return;
      case 0x02:
        if (neg) this.branch(target);
        else this.skipDelay();
        return;
      case 0x03:
        if (!neg) this.branch(target);
        else this.skipDelay();
        return;
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c:
      case 0x0e: {
        // TGEI・TGEIU・TLTI・TLTIU・TEQI・TNEI
        const l = this.lo[rs];
        const h = this.hi[rs];
        const ih = imm >> 31;
        const lt = h < ih || (h === ih && l >>> 0 < imm >>> 0);
        const ltu = h >>> 0 < ih >>> 0 || (h === ih && l >>> 0 < imm >>> 0);
        const eq = l === imm && h === ih;
        const trap = rt === 8 ? !lt : rt === 9 ? !ltu : rt === 10 ? lt : rt === 11 ? ltu : rt === 12 ? eq : !eq;
        if (trap) this.exception(EXC_TR);
        return;
      }
      case 0x10:
        this.set32(31, (this.curPc + 8) | 0);
        if (neg) this.branch(target);
        return;
      case 0x11:
        this.set32(31, (this.curPc + 8) | 0);
        if (!neg) this.branch(target);
        return;
      case 0x12:
        this.set32(31, (this.curPc + 8) | 0);
        if (neg) this.branch(target);
        else this.skipDelay();
        return;
      case 0x13:
        this.set32(31, (this.curPc + 8) | 0);
        if (!neg) this.branch(target);
        else this.skipDelay();
        return;
    }
    this.exception(EXC_RI);
  }

  private cop0(op: number, rs: number, rt: number): void {
    const rd = (op >>> 11) & 31;
    switch (rs) {
      case 0x00:
        this.set32(rt, this.readCop0(rd));
        return;
      case 0x01: {
        const v = this.readCop0(rd);
        this.lo[rt] = v;
        this.hi[rt] = v >> 31;
        return;
      }
      case 0x04:
      case 0x05:
        this.writeCop0(rd, this.lo[rt]);
        return;
    }
    if (rs & 0x10) {
      switch (op & 63) {
        case 0x01:
          this.tlbRead();
          return;
        case 0x02:
          this.tlbWrite(this.index);
          return;
        case 0x06:
          this.tlbWrite(this.readCop0(1));
          return;
        case 0x08:
          this.tlbProbe();
          return;
        case 0x18:
          // ERET
          if (this.status & 4) {
            this.pc = this.errorEpc;
            this.status &= ~4;
          } else {
            this.pc = this.epc;
            this.status &= ~2;
          }
          this.nextPc = (this.pc + 4) | 0;
          this.llbit = false;
          this.branched = false;
          this.updateInt();
          return;
      }
    }
    this.exception(EXC_RI);
  }

  // ---- COP1 ----
  private fpuOk(): boolean {
    if (this.status & 0x20000000) return true;
    this.exception(EXC_CPU, 1);
    return false;
  }

  /** 32 ビットの値（単精度・整数）を置く場所（fi・f32 の添字） */
  private fidx(r: number): number {
    // FR = 0 のとき、奇数番は偶数番の上位 32 ビット
    if (this.status & 0x04000000) return r * 2;
    return (r & ~1) * 2 + (r & 1);
  }

  private getDLo(r: number): number {
    if (this.status & 0x04000000) return this.fi[r * 2];
    return this.fi[(r & ~1) * 2];
  }
  private getDHi(r: number): number {
    if (this.status & 0x04000000) return this.fi[r * 2 + 1];
    return this.fi[(r & ~1) * 2 + 1];
  }
  private setDBits(r: number, l: number, h: number): void {
    const i = this.status & 0x04000000 ? r * 2 : (r & ~1) * 2;
    this.fi[i] = l;
    this.fi[i + 1] = h;
  }
  private getD(r: number): number {
    return this.f64[this.status & 0x04000000 ? r : r & ~1];
  }
  private setD(r: number, v: number): void {
    this.f64[this.status & 0x04000000 ? r : r & ~1] = v;
  }
  private getS(r: number): number {
    return this.f32[this.fidx(r)];
  }
  private setS(r: number, v: number): void {
    this.f32[this.fidx(r)] = v;
  }

  /** 丸めて整数に（mode：0 近いほう、1 0 のほうへ、2 切り上げ、3 切り捨て） */
  private roundTo(x: number, mode: number): number {
    switch (mode) {
      case 0:
        return roundEven(x);
      case 1:
        return Math.trunc(x);
      case 2:
        return Math.ceil(x);
    }
    return Math.floor(x);
  }

  /** 計算できない（実機ではソフトで処理する例外）ときの例外 */
  private fpUnimplemented(): void {
    this.fcr31 = (this.fcr31 & ~0x3f000) | 0x20000;
    this.exception(EXC_FPE);
  }

  private setW(fd: number, x: number, mode: number): void {
    const v = this.roundTo(x, mode);
    if (!(v >= -2147483648 && v <= 2147483647)) return this.fpUnimplemented();
    this.fi[this.fidx(fd)] = v;
  }

  private setL(fd: number, x: number, mode: number): void {
    const v = this.roundTo(x, mode);
    if (!(Math.abs(v) < 9007199254740992)) return this.fpUnimplemented();
    const l = v % P32 | 0;
    const h = Math.floor(v / P32) | 0;
    this.setDBits(fd, l, h);
  }

  private getL(fs: number): number {
    return this.getDHi(fs) * P32 + (this.getDLo(fs) >>> 0);
  }

  private cop1(op: number, rs: number, rt: number): void {
    if (!this.fpuOk()) return;
    const fs = (op >>> 11) & 31;
    const fd = (op >>> 6) & 31;
    const ft = rt;
    switch (rs) {
      case 0x00:
        this.set32(rt, this.fi[this.fidx(fs)]);
        return;
      case 0x01:
        this.lo[rt] = this.getDLo(fs);
        this.hi[rt] = this.getDHi(fs);
        return;
      case 0x02:
        this.set32(rt, fs === 31 ? this.fcr31 : fs === 0 ? 0xa00 : 0);
        return;
      case 0x04:
        this.fi[this.fidx(fs)] = this.lo[rt];
        return;
      case 0x05:
        this.setDBits(fs, this.lo[rt], this.hi[rt]);
        return;
      case 0x06:
        if (fs === 31) this.fcr31 = this.lo[rt] & 0x0183ffff;
        return;
      case 0x08: {
        const cond = (this.fcr31 & 0x800000) !== 0;
        const target = this.pc + (((op << 16) >> 16) << 2);
        switch (rt & 3) {
          case 0:
            if (!cond) this.branch(target);
            return;
          case 1:
            if (cond) this.branch(target);
            return;
          case 2:
            if (!cond) this.branch(target);
            else this.skipDelay();
            return;
          default:
            if (cond) this.branch(target);
            else this.skipDelay();
            return;
        }
      }
      case 0x10:
        return this.fpS(op, fs, ft, fd);
      case 0x11:
        return this.fpD(op, fs, ft, fd);
      case 0x14: {
        // 整数（32 ビット）から
        const v = this.fi[this.fidx(fs)];
        if ((op & 63) === 0x20) this.setS(fd, v);
        else if ((op & 63) === 0x21) this.setD(fd, v);
        else this.fpUnimplemented();
        return;
      }
      case 0x15: {
        // 整数（64 ビット）から
        const v = this.getL(fs);
        if ((op & 63) === 0x20) this.setS(fd, v);
        else if ((op & 63) === 0x21) this.setD(fd, v);
        else this.fpUnimplemented();
        return;
      }
    }
    this.exception(EXC_RI);
  }

  private fcmp(op: number, a: number, b: number): void {
    const un = a !== a || b !== b;
    const f = op & 15;
    let c = false;
    if (un) c = (f & 1) !== 0;
    else {
      if (f & 2 && a === b) c = true;
      if (f & 4 && a < b) c = true;
    }
    if (c) this.fcr31 |= 0x800000;
    else this.fcr31 &= ~0x800000;
  }

  private fpS(op: number, fs: number, ft: number, fd: number): void {
    const a = this.getS(fs);
    const mode = this.fcr31 & 3;
    switch (op & 63) {
      case 0x00:
        this.setS(fd, a + this.getS(ft));
        return;
      case 0x01:
        this.setS(fd, a - this.getS(ft));
        return;
      case 0x02:
        this.setS(fd, a * this.getS(ft));
        return;
      case 0x03:
        this.setS(fd, a / this.getS(ft));
        return;
      case 0x04:
        this.setS(fd, Math.sqrt(a));
        return;
      case 0x05:
        this.setS(fd, Math.abs(a));
        return;
      case 0x06:
        this.fi[this.fidx(fd)] = this.fi[this.fidx(fs)];
        return;
      case 0x07:
        this.setS(fd, -a);
        return;
      case 0x08:
        return this.setL(fd, a, 0);
      case 0x09:
        return this.setL(fd, a, 1);
      case 0x0a:
        return this.setL(fd, a, 2);
      case 0x0b:
        return this.setL(fd, a, 3);
      case 0x0c:
        return this.setW(fd, a, 0);
      case 0x0d:
        return this.setW(fd, a, 1);
      case 0x0e:
        return this.setW(fd, a, 2);
      case 0x0f:
        return this.setW(fd, a, 3);
      case 0x21:
        this.setD(fd, a);
        return;
      case 0x24:
        return this.setW(fd, a, mode);
      case 0x25:
        return this.setL(fd, a, mode);
    }
    if ((op & 0x30) === 0x30) return this.fcmp(op, a, this.getS(ft));
    this.fpUnimplemented();
  }

  private fpD(op: number, fs: number, ft: number, fd: number): void {
    const a = this.getD(fs);
    const mode = this.fcr31 & 3;
    switch (op & 63) {
      case 0x00:
        this.setD(fd, a + this.getD(ft));
        return;
      case 0x01:
        this.setD(fd, a - this.getD(ft));
        return;
      case 0x02:
        this.setD(fd, a * this.getD(ft));
        return;
      case 0x03:
        this.setD(fd, a / this.getD(ft));
        return;
      case 0x04:
        this.setD(fd, Math.sqrt(a));
        return;
      case 0x05:
        this.setD(fd, Math.abs(a));
        return;
      case 0x06:
        this.setDBits(fd, this.getDLo(fs), this.getDHi(fs));
        return;
      case 0x07:
        this.setD(fd, -a);
        return;
      case 0x08:
        return this.setL(fd, a, 0);
      case 0x09:
        return this.setL(fd, a, 1);
      case 0x0a:
        return this.setL(fd, a, 2);
      case 0x0b:
        return this.setL(fd, a, 3);
      case 0x0c:
        return this.setW(fd, a, 0);
      case 0x0d:
        return this.setW(fd, a, 1);
      case 0x0e:
        return this.setW(fd, a, 2);
      case 0x0f:
        return this.setW(fd, a, 3);
      case 0x20:
        this.setS(fd, a);
        return;
      case 0x24:
        return this.setW(fd, a, mode);
      case 0x25:
        return this.setL(fd, a, mode);
    }
    if ((op & 0x30) === 0x30) return this.fcmp(op, a, this.getD(ft));
    this.fpUnimplemented();
  }

  jump(pc: number): void {
    this.pc = pc | 0;
    this.nextPc = (pc + 4) | 0;
    this.branched = false;
  }

  stateSkip(): unknown[] {
    return [this.f32, this.fi, this.tmpF64, this.tmpI32, this.tmpF32, this.jit];
  }
}

function mulHi32(a: number, b: number, signed: boolean): number {
  const ua = a >>> 0;
  const ub = b >>> 0;
  const a0 = ua & 0xffff;
  const a1 = ua >>> 16;
  const b0 = ub & 0xffff;
  const b1 = ub >>> 16;
  let h = a1 * b1 + Math.floor((a1 * b0 + a0 * b1 + Math.floor((a0 * b0) / 65536)) / 65536);
  if (signed) {
    if (a < 0) h -= ub;
    if (b < 0) h -= ua;
  }
  return h | 0;
}

export { EXC_INT };
