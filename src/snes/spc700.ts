// スーパーファミコンの音の CPU（SPC700。ソニー製の 8 ビット CPU）。音のプログラムを動かして DSP に指示する

export interface SpcBus {
  read(a: number): number;
  write(a: number, v: number): void;
}

/** 命令ごとのサイクル数（分岐したときは +2） */
const CYCLES = new Uint8Array([
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6, 6,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 12, 5,
  3, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 4,
  3, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9,
  2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 4, 5, 3, 4, 3, 4, 3,
  2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3,
]);

export class Spc700 {
  a = 0;
  x = 0;
  y = 0;
  sp = 0xef;
  pc = 0;
  n = 0;
  v = 0;
  /** ダイレクトページ（0 = $00xx、1 = $01xx） */
  p = 0;
  b = 0;
  h = 0;
  i = 0;
  z = 0;
  c = 0;
  /** SLEEP・STOP で止まっている */
  stopped = false;

  constructor(public bus: SpcBus) {}

  getPsw(): number {
    return (this.n << 7) | (this.v << 6) | (this.p << 5) | (this.b << 4) | (this.h << 3) | (this.i << 2) | (this.z << 1) | this.c;
  }

  setPsw(v: number): void {
    this.n = (v >> 7) & 1;
    this.v = (v >> 6) & 1;
    this.p = (v >> 5) & 1;
    this.b = (v >> 4) & 1;
    this.h = (v >> 3) & 1;
    this.i = (v >> 2) & 1;
    this.z = (v >> 1) & 1;
    this.c = v & 1;
  }

  private rd(a: number): number {
    return this.bus.read(a & 0xffff);
  }

  private wr(a: number, v: number): void {
    this.bus.write(a & 0xffff, v & 0xff);
  }

  private fetch(): number {
    const v = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    const lo = this.fetch();
    return lo | (this.fetch() << 8);
  }

  private dp(o: number): number {
    return (this.p << 8) | (o & 0xff);
  }

  private rdDp16(o: number): number {
    return this.rd(this.dp(o)) | (this.rd(this.dp(o + 1)) << 8);
  }

  private push(v: number): void {
    this.wr(0x100 | this.sp, v);
    this.sp = (this.sp - 1) & 0xff;
  }

  private pop(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.rd(0x100 | this.sp);
  }

  private nz(v: number): number {
    v &= 0xff;
    this.n = v >> 7;
    this.z = v === 0 ? 1 : 0;
    return v;
  }

  private adc(a: number, b: number): number {
    const r = a + b + this.c;
    this.v = (~(a ^ b) & (a ^ r) & 0x80) ? 1 : 0;
    this.h = ((a ^ b ^ r) & 0x10) ? 1 : 0;
    this.c = r > 0xff ? 1 : 0;
    return this.nz(r);
  }

  private sbc(a: number, b: number): number {
    return this.adc(a, b ^ 0xff);
  }

  private cmp(a: number, b: number): void {
    const r = a - b;
    this.c = r >= 0 ? 1 : 0;
    this.nz(r);
  }

  /** ORA AND EOR CMP ADC SBC（op の上位 3 ビット） */
  private alu(kind: number, a: number, b: number): number {
    switch (kind) {
      case 0:
        return this.nz(a | b);
      case 1:
        return this.nz(a & b);
      case 2:
        return this.nz(a ^ b);
      case 3:
        this.cmp(a, b);
        return a;
      case 4:
        return this.adc(a, b);
      default:
        return this.sbc(a, b);
    }
  }

  private shift(kind: number, v: number): number {
    let r: number;
    switch (kind) {
      case 0: // ASL
        this.c = v >> 7;
        r = v << 1;
        break;
      case 1: // ROL
        r = (v << 1) | this.c;
        this.c = v >> 7;
        break;
      case 2: // LSR
        this.c = v & 1;
        r = v >> 1;
        break;
      default: // ROR
        r = (v >> 1) | (this.c << 7);
        this.c = v & 1;
        break;
    }
    return this.nz(r);
  }

  /** 1 命令を実行し、かかったサイクル数を返す */
  step(): number {
    if (this.stopped) return 2;
    const op = this.fetch();
    let cyc = CYCLES[op];
    const lo = op & 0x0f;
    const hi = op >> 4;

    switch (lo) {
      case 0x00: {
        if (hi & 1) break; // 分岐は下で
        switch (op) {
          case 0x00: break; // NOP
          case 0x20: this.p = 0; break;
          case 0x40: this.p = 1; break;
          case 0x60: this.c = 0; break;
          case 0x80: this.c = 1; break;
          case 0xa0: this.i = 1; break;
          case 0xc0: this.i = 0; break;
          case 0xe0: this.v = 0; this.h = 0; break;
        }
        return cyc;
      }
      case 0x01: {
        // TCALL n
        const vec = 0xffde - hi * 2;
        this.push(this.pc >> 8);
        this.push(this.pc);
        this.pc = this.rd(vec) | (this.rd(vec + 1) << 8);
        return cyc;
      }
      case 0x02: {
        // SET1・CLR1 dp.bit
        const a = this.dp(this.fetch());
        const bit = 1 << (hi >> 1);
        const v = this.rd(a);
        this.wr(a, hi & 1 ? v & ~bit : v | bit);
        return cyc;
      }
      case 0x03: {
        // BBS・BBC dp.bit, rel
        const v = this.rd(this.dp(this.fetch()));
        const off = (this.fetch() << 24) >> 24;
        const set = (v >> (hi >> 1)) & 1;
        if ((hi & 1) === 0 ? set : !set) {
          this.pc = (this.pc + off) & 0xffff;
          cyc += 2;
        }
        return cyc;
      }
    }

    // 分岐
    if ((lo === 0 && hi & 1) || op === 0x2f) {
      const off = (this.fetch() << 24) >> 24;
      let take: boolean;
      switch (op) {
        case 0x10: take = !this.n; break;
        case 0x30: take = !!this.n; break;
        case 0x50: take = !this.v; break;
        case 0x70: take = !!this.v; break;
        case 0x90: take = !this.c; break;
        case 0xb0: take = !!this.c; break;
        case 0xd0: take = !this.z; break;
        case 0xf0: take = !!this.z; break;
        default: take = true; // BRA（0x2F）
      }
      if (take) {
        this.pc = (this.pc + off) & 0xffff;
        if (op !== 0x2f) cyc += 2;
      }
      return cyc;
    }

    // 列 4〜9 の上半分（OR AND EOR CMP ADC SBC）
    if (hi < 0x0c && lo >= 4 && lo <= 9) {
      const kind = hi >> 1;
      const odd = hi & 1;
      let addr = -1;
      let v: number;
      switch (lo) {
        case 4:
          addr = odd ? this.dp(this.fetch() + this.x) : this.dp(this.fetch());
          v = this.rd(addr);
          break;
        case 5: {
          const base = this.fetch16();
          v = this.rd(odd ? base + this.x : base);
          break;
        }
        case 6:
          v = odd ? this.rd(this.fetch16() + this.y) : this.rd(this.dp(this.x));
          break;
        case 7: {
          const o = this.fetch();
          const ptr = odd ? this.rdDp16(o) + this.y : this.rdDp16(o + this.x);
          v = this.rd(ptr);
          break;
        }
        case 8:
          if (!odd) {
            v = this.fetch();
            break;
          }
          {
            // OP dp, #imm
            const imm = this.fetch();
            const d = this.dp(this.fetch());
            const r = this.alu(kind, this.rd(d), imm);
            if (kind !== 3) this.wr(d, r);
          }
          return cyc;
        default: {
          // OP dp, dp ／ OP (X), (Y)
          if (!odd) {
            const s = this.rd(this.dp(this.fetch()));
            const d = this.dp(this.fetch());
            const r = this.alu(kind, this.rd(d), s);
            if (kind !== 3) this.wr(d, r);
          } else {
            const s = this.rd(this.dp(this.y));
            const d = this.dp(this.x);
            const r = this.alu(kind, this.rd(d), s);
            if (kind !== 3) this.wr(d, r);
          }
          return cyc;
        }
      }
      this.a = this.alu(kind, this.a, v);
      return cyc;
    }

    switch (op) {
      // ── MOV（ストア） ──
      case 0xc4: this.wr(this.dp(this.fetch()), this.a); break;
      case 0xd4: this.wr(this.dp(this.fetch() + this.x), this.a); break;
      case 0xc5: this.wr(this.fetch16(), this.a); break;
      case 0xd5: this.wr(this.fetch16() + this.x, this.a); break;
      case 0xc6: this.wr(this.dp(this.x), this.a); break;
      case 0xd6: this.wr(this.fetch16() + this.y, this.a); break;
      case 0xc7: this.wr(this.rdDp16(this.fetch() + this.x), this.a); break;
      case 0xd7: this.wr(this.rdDp16(this.fetch()) + this.y, this.a); break;
      case 0xd8: this.wr(this.dp(this.fetch()), this.x); break;
      case 0xd9: this.wr(this.dp(this.fetch() + this.y), this.x); break;
      case 0xc9: this.wr(this.fetch16(), this.x); break;
      case 0xcb: this.wr(this.dp(this.fetch()), this.y); break;
      case 0xdb: this.wr(this.dp(this.fetch() + this.x), this.y); break;
      case 0xcc: this.wr(this.fetch16(), this.y); break;
      case 0xaf: this.wr(this.dp(this.x), this.a); this.x = (this.x + 1) & 0xff; break;
      case 0x8f: {
        const imm = this.fetch();
        this.wr(this.dp(this.fetch()), imm);
        break;
      }
      case 0xfa: {
        const v = this.rd(this.dp(this.fetch()));
        this.wr(this.dp(this.fetch()), v);
        break;
      }
      // ── MOV（ロード） ──
      case 0xe4: this.a = this.nz(this.rd(this.dp(this.fetch()))); break;
      case 0xf4: this.a = this.nz(this.rd(this.dp(this.fetch() + this.x))); break;
      case 0xe5: this.a = this.nz(this.rd(this.fetch16())); break;
      case 0xf5: this.a = this.nz(this.rd(this.fetch16() + this.x)); break;
      case 0xe6: this.a = this.nz(this.rd(this.dp(this.x))); break;
      case 0xf6: this.a = this.nz(this.rd(this.fetch16() + this.y)); break;
      case 0xe7: this.a = this.nz(this.rd(this.rdDp16(this.fetch() + this.x))); break;
      case 0xf7: this.a = this.nz(this.rd(this.rdDp16(this.fetch()) + this.y)); break;
      case 0xe8: this.a = this.nz(this.fetch()); break;
      case 0xbf: this.a = this.nz(this.rd(this.dp(this.x))); this.x = (this.x + 1) & 0xff; break;
      case 0xcd: this.x = this.nz(this.fetch()); break;
      case 0xf8: this.x = this.nz(this.rd(this.dp(this.fetch()))); break;
      case 0xf9: this.x = this.nz(this.rd(this.dp(this.fetch() + this.y))); break;
      case 0xe9: this.x = this.nz(this.rd(this.fetch16())); break;
      case 0x8d: this.y = this.nz(this.fetch()); break;
      case 0xeb: this.y = this.nz(this.rd(this.dp(this.fetch()))); break;
      case 0xfb: this.y = this.nz(this.rd(this.dp(this.fetch() + this.x))); break;
      case 0xec: this.y = this.nz(this.rd(this.fetch16())); break;
      // ── レジスタ間 ──
      case 0x5d: this.x = this.nz(this.a); break;
      case 0x7d: this.a = this.nz(this.x); break;
      case 0xdd: this.a = this.nz(this.y); break;
      case 0xfd: this.y = this.nz(this.a); break;
      case 0x9d: this.x = this.nz(this.sp); break;
      case 0xbd: this.sp = this.x; break;
      // ── CMP X・Y ──
      case 0xc8: this.cmp(this.x, this.fetch()); break;
      case 0x3e: this.cmp(this.x, this.rd(this.dp(this.fetch()))); break;
      case 0x1e: this.cmp(this.x, this.rd(this.fetch16())); break;
      case 0xad: this.cmp(this.y, this.fetch()); break;
      case 0x7e: this.cmp(this.y, this.rd(this.dp(this.fetch()))); break;
      case 0x5e: this.cmp(this.y, this.rd(this.fetch16())); break;
      // ── シフト・増減（メモリ） ──
      case 0x0b: case 0x2b: case 0x4b: case 0x6b: {
        const a = this.dp(this.fetch());
        this.wr(a, this.shift(hi >> 1, this.rd(a)));
        break;
      }
      case 0x1b: case 0x3b: case 0x5b: case 0x7b: {
        const a = this.dp(this.fetch() + this.x);
        this.wr(a, this.shift(hi >> 1, this.rd(a)));
        break;
      }
      case 0x0c: case 0x2c: case 0x4c: case 0x6c: {
        const a = this.fetch16();
        this.wr(a, this.shift(hi >> 1, this.rd(a)));
        break;
      }
      case 0x1c: case 0x3c: case 0x5c: case 0x7c:
        this.a = this.shift(hi >> 1, this.a);
        break;
      case 0x8b: { const a = this.dp(this.fetch()); this.wr(a, this.nz(this.rd(a) - 1)); break; }
      case 0x9b: { const a = this.dp(this.fetch() + this.x); this.wr(a, this.nz(this.rd(a) - 1)); break; }
      case 0x8c: { const a = this.fetch16(); this.wr(a, this.nz(this.rd(a) - 1)); break; }
      case 0xab: { const a = this.dp(this.fetch()); this.wr(a, this.nz(this.rd(a) + 1)); break; }
      case 0xbb: { const a = this.dp(this.fetch() + this.x); this.wr(a, this.nz(this.rd(a) + 1)); break; }
      case 0xac: { const a = this.fetch16(); this.wr(a, this.nz(this.rd(a) + 1)); break; }
      case 0x9c: this.a = this.nz(this.a - 1); break;
      case 0xbc: this.a = this.nz(this.a + 1); break;
      case 0x1d: this.x = this.nz(this.x - 1); break;
      case 0x3d: this.x = this.nz(this.x + 1); break;
      case 0xdc: this.y = this.nz(this.y - 1); break;
      case 0xfc: this.y = this.nz(this.y + 1); break;
      // ── 16 ビット ──
      case 0x1a: case 0x3a: {
        const o = this.fetch();
        const v = (this.rdDp16(o) + (op === 0x3a ? 1 : -1)) & 0xffff;
        this.wr(this.dp(o), v);
        this.wr(this.dp(o + 1), v >> 8);
        this.n = v >> 15;
        this.z = v === 0 ? 1 : 0;
        break;
      }
      case 0x5a: {
        const w = this.rdDp16(this.fetch());
        const r = ((this.y << 8) | this.a) - w;
        this.c = r >= 0 ? 1 : 0;
        this.n = (r >> 15) & 1;
        this.z = (r & 0xffff) === 0 ? 1 : 0;
        break;
      }
      case 0x7a: case 0x9a: {
        let w = this.rdDp16(this.fetch());
        const ya = (this.y << 8) | this.a;
        let carry = 0;
        if (op === 0x9a) {
          w ^= 0xffff;
          carry = 1;
        }
        const r = ya + w + carry;
        this.v = (~(ya ^ w) & (ya ^ r) & 0x8000) ? 1 : 0;
        this.h = ((ya ^ w ^ r) & 0x1000) ? 1 : 0;
        this.c = r > 0xffff ? 1 : 0;
        this.a = r & 0xff;
        this.y = (r >> 8) & 0xff;
        this.n = (r >> 15) & 1;
        this.z = (r & 0xffff) === 0 ? 1 : 0;
        break;
      }
      case 0xba: {
        const w = this.rdDp16(this.fetch());
        this.a = w & 0xff;
        this.y = w >> 8;
        this.n = w >> 15;
        this.z = w === 0 ? 1 : 0;
        break;
      }
      case 0xda: {
        const o = this.fetch();
        this.wr(this.dp(o), this.a);
        this.wr(this.dp(o + 1), this.y);
        break;
      }
      case 0xcf: {
        const r = this.y * this.a;
        this.a = r & 0xff;
        this.y = r >> 8;
        this.nz(this.y);
        break;
      }
      case 0x9e: {
        const ya = (this.y << 8) | this.a;
        const x = this.x;
        this.v = this.y >= x ? 1 : 0;
        this.h = (this.y & 15) >= (x & 15) ? 1 : 0;
        if (this.y < x << 1) {
          this.a = Math.floor(ya / x) & 0xff;
          this.y = ya % x;
        } else {
          this.a = (255 - Math.floor((ya - (x << 9)) / (256 - x))) & 0xff;
          this.y = (x + ((ya - (x << 9)) % (256 - x))) & 0xff;
        }
        this.nz(this.a);
        break;
      }
      case 0xdf: {
        let a = this.a;
        if (this.c || a > 0x99) {
          a += 0x60;
          this.c = 1;
        }
        if (this.h || (a & 15) > 9) a += 0x06;
        this.a = this.nz(a);
        break;
      }
      case 0xbe: {
        let a = this.a;
        if (!this.c || a > 0x99) {
          a -= 0x60;
          this.c = 0;
        }
        if (!this.h || (a & 15) > 9) a -= 0x06;
        this.a = this.nz(a);
        break;
      }
      case 0x9f:
        this.a = this.nz((this.a >> 4) | (this.a << 4));
        break;
      // ── ビット（13 ビットのアドレス + 3 ビットの番号） ──
      case 0x0a: case 0x2a: case 0x4a: case 0x6a: case 0x8a: case 0xaa: case 0xca: case 0xea: {
        const w = this.fetch16();
        const addr = w & 0x1fff;
        const bit = w >> 13;
        const m = (this.rd(addr) >> bit) & 1;
        switch (op) {
          case 0x0a: this.c |= m; break;
          case 0x2a: this.c |= m ^ 1; break;
          case 0x4a: this.c &= m; break;
          case 0x6a: this.c &= m ^ 1; break;
          case 0x8a: this.c ^= m; break;
          case 0xaa: this.c = m; break;
          case 0xca: {
            const v = this.rd(addr);
            this.wr(addr, this.c ? v | (1 << bit) : v & ~(1 << bit));
            break;
          }
          default: {
            const v = this.rd(addr);
            this.wr(addr, v ^ (1 << bit));
            break;
          }
        }
        break;
      }
      case 0x0e: case 0x4e: {
        const a = this.fetch16();
        const v = this.rd(a);
        this.nz(this.a - v);
        this.wr(a, op === 0x0e ? v | this.a : v & ~this.a);
        break;
      }
      // ── 比較して分岐・数えて分岐 ──
      case 0x2e: case 0xde: {
        const o = this.fetch();
        const v = this.rd(op === 0x2e ? this.dp(o) : this.dp(o + this.x));
        const off = (this.fetch() << 24) >> 24;
        if (this.a !== v) {
          this.pc = (this.pc + off) & 0xffff;
          cyc += 2;
        }
        break;
      }
      case 0x6e: {
        const a = this.dp(this.fetch());
        const v = (this.rd(a) - 1) & 0xff;
        this.wr(a, v);
        const off = (this.fetch() << 24) >> 24;
        if (v) {
          this.pc = (this.pc + off) & 0xffff;
          cyc += 2;
        }
        break;
      }
      case 0xfe: {
        this.y = (this.y - 1) & 0xff;
        const off = (this.fetch() << 24) >> 24;
        if (this.y) {
          this.pc = (this.pc + off) & 0xffff;
          cyc += 2;
        }
        break;
      }
      // ── スタック ──
      case 0x0d: this.push(this.getPsw()); break;
      case 0x2d: this.push(this.a); break;
      case 0x4d: this.push(this.x); break;
      case 0x6d: this.push(this.y); break;
      case 0x8e: this.setPsw(this.pop()); break;
      case 0xae: this.a = this.pop(); break;
      case 0xce: this.x = this.pop(); break;
      case 0xee: this.y = this.pop(); break;
      // ── ジャンプ・サブルーチン ──
      case 0x5f: this.pc = this.fetch16(); break;
      case 0x1f: {
        const a = (this.fetch16() + this.x) & 0xffff;
        this.pc = this.rd(a) | (this.rd(a + 1) << 8);
        break;
      }
      case 0x3f: {
        const dest = this.fetch16();
        this.push(this.pc >> 8);
        this.push(this.pc);
        this.pc = dest;
        break;
      }
      case 0x4f: {
        const dest = 0xff00 | this.fetch();
        this.push(this.pc >> 8);
        this.push(this.pc);
        this.pc = dest;
        break;
      }
      case 0x6f: {
        const l = this.pop();
        this.pc = l | (this.pop() << 8);
        break;
      }
      case 0x7f: {
        this.setPsw(this.pop());
        const l = this.pop();
        this.pc = l | (this.pop() << 8);
        break;
      }
      case 0x0f: {
        this.push(this.pc >> 8);
        this.push(this.pc);
        this.push(this.getPsw());
        this.b = 1;
        this.i = 0;
        this.pc = this.rd(0xffde) | (this.rd(0xffdf) << 8);
        break;
      }
      // ── フラグ・そのほか ──
      case 0xed: this.c ^= 1; break;
      case 0xef: case 0xff:
        this.stopped = true;
        break;
    }
    return cyc;
  }
}
