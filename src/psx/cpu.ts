// プレイステーションの CPU（R3000A。32 ビットの MIPS）。
// 分岐の次の 1 命令（遅延スロット）と、ロードした値が 1 命令遅れて届く（ロード遅延）ところまで実機どおりに動かす

import type { Gte } from './gte';

export interface PsxBus {
  /** 経過したクロック（33.8688MHz） */
  cycles: number;
  stopAt: number;
  /** 割り込みが来ている（I_STAT & I_MASK） */
  irqPending: boolean;
  read8(a: number): number;
  read16(a: number): number;
  read32(a: number): number;
  write8(a: number, v: number): void;
  write16(a: number, v: number): void;
  write32(a: number, v: number): void;
  /** 命令を読む（BIOS の ROM は遅い） */
  fetch(a: number): number;
  /** PC がこのアドレスに来たら呼ぶ（-1 = なし。EXE を読み込むときに使う） */
  hookPc: number;
  onHook(): void;
}

const EXC_INT = 0;
const EXC_ADEL = 4;
const EXC_ADES = 5;
const EXC_SYS = 8;
const EXC_BP = 9;
const EXC_RI = 10;
const EXC_CPU = 11;
const EXC_OV = 12;

export class R3000 {
  r = new Int32Array(32);
  hi = 0;
  lo = 0;
  pc = 0xbfc00000 | 0;
  nextPc = 0xbfc00004 | 0;
  /** 今の命令のアドレスと、それが分岐の遅延スロットか */
  private curPc = 0;
  private inDelay = false;
  private branched = false;
  /** ロード遅延：次の命令のあとで書かれるレジスタと値 */
  private ldReg = 0;
  private ldVal = 0;
  private newLdReg = 0;
  private newLdVal = 0;
  // COP0
  sr = 0;
  cause = 0;
  epc = 0;
  badVaddr = 0;
  /** 待ちループの見張り */
  private idlePc = -1;
  private idleSnap = new Int32Array(34);
  idleWrites = 0;

  constructor(
    public bus: PsxBus & { writes: number; volatileRead: boolean },
    public gte: Gte,
  ) {}

  /** キャッシュを切り離している（BIOS がキャッシュを消すとき。メモリには書かない） */
  get isolated(): boolean {
    return (this.sr & 0x10000) !== 0;
  }

  private setReg(i: number, v: number): void {
    if (i === 0) return;
    this.r[i] = v;
    if (this.ldReg === i) this.ldReg = 0;
  }

  /** ロード（1 命令遅れて届く） */
  private load(i: number, v: number): void {
    if (i === 0) return;
    // 同じレジスタへの続けてのロードは、前のものを捨てる
    if (this.ldReg === i) this.ldReg = 0;
    this.newLdReg = i;
    this.newLdVal = v;
  }

  exception(code: number): void {
    const handler = this.sr & 0x400000 ? 0xbfc00180 | 0 : 0x80000080 | 0;
    // 割り込み・カーネルモードの 3 段のスタックを 1 つずらす
    this.sr = (this.sr & ~0x3f) | ((this.sr << 2) & 0x3f);
    this.cause = (this.cause & ~0x8000007c) | (code << 2);
    if (this.inDelay) {
      this.epc = (this.curPc - 4) | 0;
      this.cause |= 0x80000000;
    } else this.epc = this.curPc;
    this.pc = handler;
    this.nextPc = (handler + 4) | 0;
    this.branched = false;
  }

  /** bus.stopAt まで実行する */
  run(): void {
    const b = this.bus;
    while (b.cycles < b.stopAt) {
      // 割り込み
      if (b.irqPending) this.cause |= 0x400;
      else this.cause &= ~0x400;
      if (this.sr & 1 && this.sr & this.cause & 0xff00) {
        this.curPc = this.pc;
        this.inDelay = this.branched;
        // 次が GTE の命令なら、実機では先に実行されてから割り込みに入る（BIOS が EPC を 1 つ進める）
        const next = b.fetch(this.pc);
        if (next >>> 25 === 0x25) this.gte.command(next);
        this.flushLoad();
        this.exception(EXC_INT);
        continue;
      }
      if (this.pc === b.hookPc) b.onHook();
      this.step();
    }
  }

  private flushLoad(): void {
    if (this.ldReg) this.r[this.ldReg] = this.ldVal;
    this.ldReg = 0;
  }

  step(): void {
    const b = this.bus;
    const pc = this.pc;
    this.curPc = pc;
    this.inDelay = this.branched;
    this.branched = false;
    b.cycles += 2;
    if (pc & 3) {
      this.badVaddr = pc;
      this.flushLoad();
      this.exception(EXC_ADEL);
      return;
    }
    const op = b.fetch(pc);
    this.pc = this.nextPc;
    this.nextPc = (this.nextPc + 4) | 0;
    this.newLdReg = 0;
    this.execute(op);
    // ロード遅延：前の命令のロードを書き、この命令のロードを次へ
    if (this.ldReg) this.r[this.ldReg] = this.ldVal;
    this.ldReg = this.newLdReg;
    this.ldVal = this.newLdVal;
    this.r[0] = 0;
  }

  private branch(target: number): void {
    this.nextPc = target | 0;
    this.branched = true;
    // 自分へ戻るだけのループなら、次の出来事まで飛ばす
    const back = this.curPc - target;
    if (back >= 0 && back <= 32) this.checkIdle(target);
  }

  private checkIdle(target: number): void {
    const b = this.bus;
    const s = this.idleSnap;
    const r = this.r;
    if (target === this.idlePc && b.writes === this.idleWrites && !b.volatileRead) {
      let same = s[32] === this.hi && s[33] === this.lo;
      for (let i = 1; same && i < 32; i++) if (s[i] !== r[i]) same = false;
      if (same) {
        if (b.stopAt > b.cycles) b.cycles = b.stopAt;
        return;
      }
    }
    this.idlePc = target;
    s.set(r);
    s[32] = this.hi;
    s[33] = this.lo;
    this.idleWrites = b.writes;
    b.volatileRead = false;
  }

  private execute(op: number): void {
    const r = this.r;
    const b = this.bus;
    const rs = (op >>> 21) & 31;
    const rt = (op >>> 16) & 31;
    switch (op >>> 26) {
      case 0x00: {
        const rd = (op >>> 11) & 31;
        const sa = (op >>> 6) & 31;
        switch (op & 63) {
          case 0x00:
            this.setReg(rd, r[rt] << sa);
            return;
          case 0x02:
            this.setReg(rd, r[rt] >>> sa);
            return;
          case 0x03:
            this.setReg(rd, r[rt] >> sa);
            return;
          case 0x04:
            this.setReg(rd, r[rt] << (r[rs] & 31));
            return;
          case 0x06:
            this.setReg(rd, r[rt] >>> (r[rs] & 31));
            return;
          case 0x07:
            this.setReg(rd, r[rt] >> (r[rs] & 31));
            return;
          case 0x08:
            this.branch(r[rs]);
            return;
          case 0x09: {
            const t = r[rs];
            this.setReg(rd, (this.curPc + 8) | 0);
            this.branch(t);
            return;
          }
          case 0x0c:
            this.exception(EXC_SYS);
            return;
          case 0x0d:
            this.exception(EXC_BP);
            return;
          case 0x10:
            this.setReg(rd, this.hi);
            return;
          case 0x11:
            this.hi = r[rs];
            return;
          case 0x12:
            this.setReg(rd, this.lo);
            return;
          case 0x13:
            this.lo = r[rs];
            return;
          case 0x18: {
            // 符号つき 32 × 32 → 64
            const a = r[rs];
            const c = r[rt];
            this.lo = Math.imul(a, c);
            this.hi = mulHi(a, c, true);
            b.cycles += 6;
            return;
          }
          case 0x19: {
            const a = r[rs];
            const c = r[rt];
            this.lo = Math.imul(a, c);
            this.hi = mulHi(a, c, false);
            b.cycles += 6;
            return;
          }
          case 0x1a: {
            const n = r[rs];
            const d = r[rt];
            if (d === 0) {
              this.hi = n;
              this.lo = n >= 0 ? -1 : 1;
            } else if (n === -0x80000000 && d === -1) {
              this.hi = 0;
              this.lo = n;
            } else {
              this.lo = (n / d) | 0;
              this.hi = n % d | 0;
            }
            b.cycles += 34;
            return;
          }
          case 0x1b: {
            const n = r[rs] >>> 0;
            const d = r[rt] >>> 0;
            if (d === 0) {
              this.hi = n | 0;
              this.lo = -1;
            } else {
              this.lo = Math.floor(n / d) | 0;
              this.hi = n % d | 0;
            }
            b.cycles += 34;
            return;
          }
          case 0x20: {
            const a = r[rs];
            const c = r[rt];
            const v = (a + c) | 0;
            if (~(a ^ c) & (a ^ v) & 0x80000000) this.exception(EXC_OV);
            else this.setReg(rd, v);
            return;
          }
          case 0x21:
            this.setReg(rd, (r[rs] + r[rt]) | 0);
            return;
          case 0x22: {
            const a = r[rs];
            const c = r[rt];
            const v = (a - c) | 0;
            if ((a ^ c) & (a ^ v) & 0x80000000) this.exception(EXC_OV);
            else this.setReg(rd, v);
            return;
          }
          case 0x23:
            this.setReg(rd, (r[rs] - r[rt]) | 0);
            return;
          case 0x24:
            this.setReg(rd, r[rs] & r[rt]);
            return;
          case 0x25:
            this.setReg(rd, r[rs] | r[rt]);
            return;
          case 0x26:
            this.setReg(rd, r[rs] ^ r[rt]);
            return;
          case 0x27:
            this.setReg(rd, ~(r[rs] | r[rt]));
            return;
          case 0x2a:
            this.setReg(rd, r[rs] < r[rt] ? 1 : 0);
            return;
          case 0x2b:
            this.setReg(rd, r[rs] >>> 0 < r[rt] >>> 0 ? 1 : 0);
            return;
        }
        this.exception(EXC_RI);
        return;
      }
      case 0x01: {
        // BLTZ・BGEZ（・AL つき）
        const v = r[rs];
        const ge = rt & 1;
        const take = ge ? v >= 0 : v < 0;
        if ((rt & 0x1e) === 0x10) this.setReg(31, (this.curPc + 8) | 0);
        if (take) this.branch((this.pc + ((op << 16) >> 14)) | 0);
        return;
      }
      case 0x02:
        this.branch(((this.pc & 0xf0000000) | ((op & 0x3ffffff) << 2)) | 0);
        return;
      case 0x03:
        this.setReg(31, (this.curPc + 8) | 0);
        this.branch(((this.pc & 0xf0000000) | ((op & 0x3ffffff) << 2)) | 0);
        return;
      case 0x04:
        if (r[rs] === r[rt]) this.branch((this.pc + ((op << 16) >> 14)) | 0);
        return;
      case 0x05:
        if (r[rs] !== r[rt]) this.branch((this.pc + ((op << 16) >> 14)) | 0);
        return;
      case 0x06:
        if (r[rs] <= 0) this.branch((this.pc + ((op << 16) >> 14)) | 0);
        return;
      case 0x07:
        if (r[rs] > 0) this.branch((this.pc + ((op << 16) >> 14)) | 0);
        return;
      case 0x08: {
        const a = r[rs];
        const c = (op << 16) >> 16;
        const v = (a + c) | 0;
        if (~(a ^ c) & (a ^ v) & 0x80000000) this.exception(EXC_OV);
        else this.setReg(rt, v);
        return;
      }
      case 0x09:
        this.setReg(rt, (r[rs] + ((op << 16) >> 16)) | 0);
        return;
      case 0x0a:
        this.setReg(rt, r[rs] < (op << 16) >> 16 ? 1 : 0);
        return;
      case 0x0b:
        this.setReg(rt, r[rs] >>> 0 < ((op << 16) >> 16) >>> 0 ? 1 : 0);
        return;
      case 0x0c:
        this.setReg(rt, r[rs] & (op & 0xffff));
        return;
      case 0x0d:
        this.setReg(rt, r[rs] | (op & 0xffff));
        return;
      case 0x0e:
        this.setReg(rt, r[rs] ^ (op & 0xffff));
        return;
      case 0x0f:
        this.setReg(rt, op << 16);
        return;
      case 0x10:
        this.cop0(op, rs, rt);
        return;
      case 0x11:
      case 0x13:
        this.cause = (this.cause & ~0x30000000) | (((op >>> 26) & 3) << 28);
        this.exception(EXC_CPU);
        return;
      case 0x12:
        this.cop2(op, rs, rt);
        return;
      case 0x20: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        this.load(rt, (b.read8(a) << 24) >> 24);
        return;
      }
      case 0x21: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        if (a & 1) return this.addrError(a, EXC_ADEL);
        this.load(rt, (b.read16(a) << 16) >> 16);
        return;
      }
      case 0x22: {
        // LWL：ロード中の値も合わせて使う
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        const cur = this.ldReg === rt ? this.ldVal : r[rt];
        const w = b.read32(a & ~3);
        let v: number;
        switch (a & 3) {
          case 0:
            v = (cur & 0x00ffffff) | (w << 24);
            break;
          case 1:
            v = (cur & 0x0000ffff) | (w << 16);
            break;
          case 2:
            v = (cur & 0x000000ff) | (w << 8);
            break;
          default:
            v = w;
        }
        this.load(rt, v | 0);
        return;
      }
      case 0x23: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        if (a & 3) return this.addrError(a, EXC_ADEL);
        this.load(rt, b.read32(a));
        return;
      }
      case 0x24: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        this.load(rt, b.read8(a));
        return;
      }
      case 0x25: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        if (a & 1) return this.addrError(a, EXC_ADEL);
        this.load(rt, b.read16(a));
        return;
      }
      case 0x26: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        const cur = this.ldReg === rt ? this.ldVal : r[rt];
        const w = b.read32(a & ~3);
        let v: number;
        switch (a & 3) {
          case 0:
            v = w;
            break;
          case 1:
            v = (cur & 0xff000000) | (w >>> 8);
            break;
          case 2:
            v = (cur & 0xffff0000) | (w >>> 16);
            break;
          default:
            v = (cur & 0xffffff00) | (w >>> 24);
        }
        this.load(rt, v | 0);
        return;
      }
      case 0x28: {
        if (this.isolated) return;
        b.write8((r[rs] + ((op << 16) >> 16)) | 0, r[rt] & 0xff);
        return;
      }
      case 0x29: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        if (a & 1) return this.addrError(a, EXC_ADES);
        if (this.isolated) return;
        b.write16(a, r[rt] & 0xffff);
        return;
      }
      case 0x2a: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        if (this.isolated) return;
        const al = a & ~3;
        const w = b.read32(al);
        const v = r[rt];
        let m: number;
        switch (a & 3) {
          case 0:
            m = (w & 0xffffff00) | (v >>> 24);
            break;
          case 1:
            m = (w & 0xffff0000) | (v >>> 16);
            break;
          case 2:
            m = (w & 0xff000000) | (v >>> 8);
            break;
          default:
            m = v;
        }
        b.write32(al, m | 0);
        return;
      }
      case 0x2b: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        if (a & 3) return this.addrError(a, EXC_ADES);
        if (this.isolated) return;
        b.write32(a, r[rt]);
        return;
      }
      case 0x2e: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        if (this.isolated) return;
        const al = a & ~3;
        const w = b.read32(al);
        const v = r[rt];
        let m: number;
        switch (a & 3) {
          case 0:
            m = v;
            break;
          case 1:
            m = (w & 0x000000ff) | (v << 8);
            break;
          case 2:
            m = (w & 0x0000ffff) | (v << 16);
            break;
          default:
            m = (w & 0x00ffffff) | (v << 24);
        }
        b.write32(al, m | 0);
        return;
      }
      case 0x32: {
        // LWC2：GTE のデータレジスタへ
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        if (a & 3) return this.addrError(a, EXC_ADEL);
        this.gte.writeData(rt, b.read32(a));
        return;
      }
      case 0x3a: {
        const a = (r[rs] + ((op << 16) >> 16)) | 0;
        if (a & 3) return this.addrError(a, EXC_ADES);
        if (this.isolated) return;
        b.write32(a, this.gte.readData(rt));
        return;
      }
      case 0x30:
      case 0x31:
      case 0x33:
      case 0x38:
      case 0x39:
      case 0x3b:
        this.cause = (this.cause & ~0x30000000) | (((op >>> 26) & 3) << 28);
        this.exception(EXC_CPU);
        return;
    }
    this.exception(EXC_RI);
  }

  private addrError(a: number, code: number): void {
    this.badVaddr = a;
    this.exception(code);
  }

  private cop0(op: number, rs: number, rt: number): void {
    const rd = (op >>> 11) & 31;
    switch (rs) {
      case 0x00: {
        let v = 0;
        switch (rd) {
          case 8:
            v = this.badVaddr;
            break;
          case 12:
            v = this.sr;
            break;
          case 13:
            v = this.cause;
            break;
          case 14:
            v = this.epc;
            break;
          case 15:
            v = 0x00000002; // PRId
            break;
        }
        this.load(rt, v | 0);
        return;
      }
      case 0x04: {
        const v = this.r[rt];
        if (rd === 12) this.sr = v;
        else if (rd === 13) this.cause = (this.cause & ~0x300) | (v & 0x300);
        return;
      }
      case 0x10:
        if ((op & 63) === 0x10) this.sr = (this.sr & ~0xf) | ((this.sr >>> 2) & 0xf);
        return;
    }
  }

  private cop2(op: number, rs: number, rt: number): void {
    if (!(this.sr & 0x40000000)) {
      this.cause = (this.cause & ~0x30000000) | (2 << 28);
      this.exception(EXC_CPU);
      return;
    }
    if (rs & 0x10) {
      this.gte.command(op);
      this.bus.cycles += 8;
      return;
    }
    const rd = (op >>> 11) & 31;
    switch (rs) {
      case 0x00:
        this.load(rt, this.gte.readData(rd));
        return;
      case 0x02:
        this.load(rt, this.gte.readControl(rd));
        return;
      case 0x04:
        this.gte.writeData(rd, this.r[rt]);
        return;
      case 0x06:
        this.gte.writeControl(rd, this.r[rt]);
        return;
    }
  }

  /** リセット・EXE を読み込んだときに PC を決める */
  jump(pc: number): void {
    this.pc = pc | 0;
    this.nextPc = (pc + 4) | 0;
    this.branched = false;
    this.ldReg = 0;
  }
}

/** 32 × 32 の積の上位 32 ビット */
export function mulHi(a: number, b: number, signed: boolean): number {
  const ua = a >>> 0;
  const ub = b >>> 0;
  const a0 = ua & 0xffff;
  const a1 = ua >>> 16;
  const b0 = ub & 0xffff;
  const b1 = ub >>> 16;
  let hi = a1 * b1 + Math.floor((a1 * b0 + a0 * b1 + Math.floor((a0 * b0) / 65536)) / 65536);
  if (signed) {
    if (a < 0) hi -= ub;
    if (b < 0) hi -= ua;
  }
  return hi | 0;
}

export { EXC_INT };
