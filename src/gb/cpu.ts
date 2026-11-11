// ゲームボーイの CPU（シャープ SM83）。メモリの読み書き 1 回ごとに 1 M サイクル（4 クロック）進める

const FZ = 0x80;
const FN = 0x40;
const FH = 0x20;
const FC = 0x10;

export interface GbBus {
  /** 1 M サイクル進める（タイマー・画面・音・DMA） */
  tick(): void;
  read(addr: number): number;
  write(addr: number, v: number): void;
  /** 割り込み要求（IF）と許可（IE） */
  if_: number;
  ie: number;
  /** HDMA などで CPU が止まる M サイクル数 */
  stall: number;
  /** STOP 命令（ゲームボーイカラーの倍速切り替え） */
  stop(): void;
}

export class GbCpu {
  a = 0;
  f = 0;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;
  sp = 0xfffe;
  pc = 0x100;
  ime = false;
  private eiPending = false;
  halted = false;
  private haltBug = false;
  /** 存在しない命令を実行して止まった */
  locked = false;

  constructor(private bus: GbBus) {}

  // ---- メモリ（1 回 = 1 M サイクル） ----
  private rd(a: number): number {
    this.bus.tick();
    return this.bus.read(a & 0xffff);
  }
  private wr(a: number, v: number): void {
    this.bus.tick();
    this.bus.write(a & 0xffff, v & 0xff);
  }
  private imm8(): number {
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }
  private imm16(): number {
    const lo = this.imm8();
    return lo | (this.imm8() << 8);
  }
  private push(v: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, v >> 8);
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, v);
  }
  private pop(): number {
    const lo = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  private get hl(): number {
    return (this.h << 8) | this.l;
  }
  private set hl(v: number) {
    this.h = (v >> 8) & 0xff;
    this.l = v & 0xff;
  }

  /** 16 ビットのレジスタ組（0 BC、1 DE、2 HL、3 SP） */
  private r16(i: number): number {
    switch (i) {
      case 0:
        return (this.b << 8) | this.c;
      case 1:
        return (this.d << 8) | this.e;
      case 2:
        return this.hl;
      default:
        return this.sp;
    }
  }
  private setR16(i: number, v: number): void {
    v &= 0xffff;
    switch (i) {
      case 0:
        this.b = v >> 8;
        this.c = v & 0xff;
        break;
      case 1:
        this.d = v >> 8;
        this.e = v & 0xff;
        break;
      case 2:
        this.hl = v;
        break;
      default:
        this.sp = v;
    }
  }

  /** 8 ビットのレジスタ（0 B、1 C、2 D、3 E、4 H、5 L、6 (HL)、7 A） */
  private r8(i: number): number {
    switch (i) {
      case 0:
        return this.b;
      case 1:
        return this.c;
      case 2:
        return this.d;
      case 3:
        return this.e;
      case 4:
        return this.h;
      case 5:
        return this.l;
      case 6:
        return this.rd(this.hl);
      default:
        return this.a;
    }
  }
  private setR8(i: number, v: number): void {
    v &= 0xff;
    switch (i) {
      case 0:
        this.b = v;
        break;
      case 1:
        this.c = v;
        break;
      case 2:
        this.d = v;
        break;
      case 3:
        this.e = v;
        break;
      case 4:
        this.h = v;
        break;
      case 5:
        this.l = v;
        break;
      case 6:
        this.wr(this.hl, v);
        break;
      default:
        this.a = v;
    }
  }

  private cond(i: number): boolean {
    switch (i) {
      case 0:
        return (this.f & FZ) === 0;
      case 1:
        return (this.f & FZ) !== 0;
      case 2:
        return (this.f & FC) === 0;
      default:
        return (this.f & FC) !== 0;
    }
  }

  private alu(op: number, v: number): void {
    const a = this.a;
    let r: number;
    switch (op) {
      case 0: // ADD
        r = a + v;
        this.f = (r & 0xff ? 0 : FZ) | ((a & 0xf) + (v & 0xf) > 0xf ? FH : 0) | (r > 0xff ? FC : 0);
        this.a = r & 0xff;
        break;
      case 1: {
        // ADC
        const c = (this.f >> 4) & 1;
        r = a + v + c;
        this.f = (r & 0xff ? 0 : FZ) | ((a & 0xf) + (v & 0xf) + c > 0xf ? FH : 0) | (r > 0xff ? FC : 0);
        this.a = r & 0xff;
        break;
      }
      case 2: // SUB
      case 7: // CP
        r = a - v;
        this.f = (r & 0xff ? 0 : FZ) | FN | ((a & 0xf) < (v & 0xf) ? FH : 0) | (r < 0 ? FC : 0);
        if (op === 2) this.a = r & 0xff;
        break;
      case 3: {
        // SBC
        const c = (this.f >> 4) & 1;
        r = a - v - c;
        this.f = (r & 0xff ? 0 : FZ) | FN | ((a & 0xf) - (v & 0xf) - c < 0 ? FH : 0) | (r < 0 ? FC : 0);
        this.a = r & 0xff;
        break;
      }
      case 4: // AND
        this.a = a & v;
        this.f = (this.a ? 0 : FZ) | FH;
        break;
      case 5: // XOR
        this.a = a ^ v;
        this.f = this.a ? 0 : FZ;
        break;
      default: // OR
        this.a = a | v;
        this.f = this.a ? 0 : FZ;
    }
  }

  /** CB 命令の回転・シフト（0 RLC、1 RRC、2 RL、3 RR、4 SLA、5 SRA、6 SWAP、7 SRL） */
  private rot(op: number, v: number): number {
    let r: number;
    let c: number;
    switch (op) {
      case 0:
        c = v >> 7;
        r = ((v << 1) | c) & 0xff;
        break;
      case 1:
        c = v & 1;
        r = (v >> 1) | (c << 7);
        break;
      case 2:
        c = v >> 7;
        r = ((v << 1) | ((this.f >> 4) & 1)) & 0xff;
        break;
      case 3:
        c = v & 1;
        r = (v >> 1) | ((this.f & FC) << 3);
        break;
      case 4:
        c = v >> 7;
        r = (v << 1) & 0xff;
        break;
      case 5:
        c = v & 1;
        r = (v >> 1) | (v & 0x80);
        break;
      case 6:
        c = 0;
        r = ((v << 4) | (v >> 4)) & 0xff;
        break;
      default:
        c = v & 1;
        r = v >> 1;
    }
    this.f = (r ? 0 : FZ) | (c ? FC : 0);
    return r;
  }

  /** 割り込みを受け付ける（5 M サイクル） */
  private dispatch(): void {
    this.bus.tick();
    this.bus.tick();
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, this.pc >> 8);
    // 上位バイトを積んだあとで、どの割り込みかを決める（IE を書き換えられると取り消しになる）
    const pending = this.bus.ie & this.bus.if_ & 0x1f;
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, this.pc & 0xff);
    if (pending) {
      const bit = pending & -pending;
      this.bus.if_ &= ~bit;
      this.pc = 0x40 + 8 * (31 - Math.clz32(bit));
    } else this.pc = 0;
    this.bus.tick();
    this.ime = false;
  }

  /** 1 命令（または割り込み 1 回・HALT 中の 1 M サイクル）進める */
  step(): void {
    const bus = this.bus;
    if (bus.stall > 0) {
      bus.stall--;
      bus.tick();
      return;
    }
    if (this.locked) {
      bus.tick();
      return;
    }
    const pending = bus.ie & bus.if_ & 0x1f;
    if (this.halted) {
      if (!pending) {
        bus.tick();
        return;
      }
      this.halted = false;
      bus.tick();
    }
    if (this.ime && pending) {
      this.dispatch();
      return;
    }
    const enableAfter = this.eiPending;
    const op = this.rd(this.pc);
    if (this.haltBug) this.haltBug = false;
    else this.pc = (this.pc + 1) & 0xffff;
    this.exec(op);
    if (enableAfter && this.eiPending) {
      this.ime = true;
      this.eiPending = false;
    }
  }

  private exec(op: number): void {
    // LD r, r'（0x40〜0x7F、0x76 は HALT）
    if (op >= 0x40 && op < 0x80) {
      if (op === 0x76) return this.halt();
      this.setR8((op >> 3) & 7, this.r8(op & 7));
      return;
    }
    // 算術・論理（0x80〜0xBF）
    if (op >= 0x80 && op < 0xc0) {
      this.alu((op >> 3) & 7, this.r8(op & 7));
      return;
    }
    switch (op) {
      case 0x00:
        return;
      case 0x01:
      case 0x11:
      case 0x21:
      case 0x31:
        this.setR16(op >> 4, this.imm16());
        return;
      case 0x02:
        this.wr((this.b << 8) | this.c, this.a);
        return;
      case 0x12:
        this.wr((this.d << 8) | this.e, this.a);
        return;
      case 0x22: {
        const hl = this.hl;
        this.wr(hl, this.a);
        this.hl = hl + 1;
        return;
      }
      case 0x32: {
        const hl = this.hl;
        this.wr(hl, this.a);
        this.hl = hl - 1;
        return;
      }
      case 0x0a:
        this.a = this.rd((this.b << 8) | this.c);
        return;
      case 0x1a:
        this.a = this.rd((this.d << 8) | this.e);
        return;
      case 0x2a: {
        const hl = this.hl;
        this.a = this.rd(hl);
        this.hl = hl + 1;
        return;
      }
      case 0x3a: {
        const hl = this.hl;
        this.a = this.rd(hl);
        this.hl = hl - 1;
        return;
      }
      case 0x03:
      case 0x13:
      case 0x23:
      case 0x33:
        this.setR16(op >> 4, this.r16(op >> 4) + 1);
        this.bus.tick();
        return;
      case 0x0b:
      case 0x1b:
      case 0x2b:
      case 0x3b:
        this.setR16(op >> 4, this.r16(op >> 4) - 1);
        this.bus.tick();
        return;
      case 0x04:
      case 0x0c:
      case 0x14:
      case 0x1c:
      case 0x24:
      case 0x2c:
      case 0x34:
      case 0x3c: {
        const i = op >> 3;
        const v = this.r8(i);
        const r = (v + 1) & 0xff;
        this.f = (this.f & FC) | (r ? 0 : FZ) | ((v & 0xf) === 0xf ? FH : 0);
        this.setR8(i, r);
        return;
      }
      case 0x05:
      case 0x0d:
      case 0x15:
      case 0x1d:
      case 0x25:
      case 0x2d:
      case 0x35:
      case 0x3d: {
        const i = op >> 3;
        const v = this.r8(i);
        const r = (v - 1) & 0xff;
        this.f = (this.f & FC) | FN | (r ? 0 : FZ) | ((v & 0xf) === 0 ? FH : 0);
        this.setR8(i, r);
        return;
      }
      case 0x06:
      case 0x0e:
      case 0x16:
      case 0x1e:
      case 0x26:
      case 0x2e:
      case 0x36:
      case 0x3e:
        this.setR8(op >> 3, this.imm8());
        return;
      case 0x07: {
        const c = this.a >> 7;
        this.a = ((this.a << 1) | c) & 0xff;
        this.f = c ? FC : 0;
        return;
      }
      case 0x0f: {
        const c = this.a & 1;
        this.a = (this.a >> 1) | (c << 7);
        this.f = c ? FC : 0;
        return;
      }
      case 0x17: {
        const c = this.a >> 7;
        this.a = ((this.a << 1) | ((this.f >> 4) & 1)) & 0xff;
        this.f = c ? FC : 0;
        return;
      }
      case 0x1f: {
        const c = this.a & 1;
        this.a = (this.a >> 1) | ((this.f & FC) << 3);
        this.f = c ? FC : 0;
        return;
      }
      case 0x08: {
        const addr = this.imm16();
        this.wr(addr, this.sp & 0xff);
        this.wr(addr + 1, this.sp >> 8);
        return;
      }
      case 0x09:
      case 0x19:
      case 0x29:
      case 0x39: {
        const hl = this.hl;
        const v = this.r16(op >> 4);
        const r = hl + v;
        this.f = (this.f & FZ) | ((hl & 0xfff) + (v & 0xfff) > 0xfff ? FH : 0) | (r > 0xffff ? FC : 0);
        this.hl = r;
        this.bus.tick();
        return;
      }
      case 0x10:
        this.imm8();
        this.bus.stop();
        return;
      case 0x18: {
        const e = (this.imm8() << 24) >> 24;
        this.pc = (this.pc + e) & 0xffff;
        this.bus.tick();
        return;
      }
      case 0x20:
      case 0x28:
      case 0x30:
      case 0x38: {
        const e = (this.imm8() << 24) >> 24;
        if (this.cond((op >> 3) & 3)) {
          this.pc = (this.pc + e) & 0xffff;
          this.bus.tick();
        }
        return;
      }
      case 0x27: {
        let a = this.a;
        const f = this.f;
        let carry = f & FC;
        if (f & FN) {
          if (f & FH) a -= 0x06;
          if (f & FC) a -= 0x60;
        } else {
          if (f & FC || a > 0x99) {
            a += 0x60;
            carry = FC;
          }
          if (f & FH || (a & 0x0f) > 9) a += 0x06;
        }
        this.a = a & 0xff;
        this.f = (this.a ? 0 : FZ) | (f & FN) | carry;
        return;
      }
      case 0x2f:
        this.a ^= 0xff;
        this.f |= FN | FH;
        return;
      case 0x37:
        this.f = (this.f & FZ) | FC;
        return;
      case 0x3f:
        this.f = (this.f & FZ) | ((this.f & FC) ^ FC);
        return;
      // ---- 0xC0〜0xFF ----
      case 0xc0:
      case 0xc8:
      case 0xd0:
      case 0xd8:
        this.bus.tick();
        if (this.cond((op >> 3) & 3)) {
          this.pc = this.pop();
          this.bus.tick();
        }
        return;
      case 0xc1:
      case 0xd1:
      case 0xe1: {
        this.setR16((op >> 4) & 3, this.pop());
        return;
      }
      case 0xf1: {
        const v = this.pop();
        this.a = v >> 8;
        this.f = v & 0xf0;
        return;
      }
      case 0xc5:
      case 0xd5:
      case 0xe5:
        this.bus.tick();
        this.push(this.r16((op >> 4) & 3));
        return;
      case 0xf5:
        this.bus.tick();
        this.push((this.a << 8) | this.f);
        return;
      case 0xc2:
      case 0xca:
      case 0xd2:
      case 0xda: {
        const addr = this.imm16();
        if (this.cond((op >> 3) & 3)) {
          this.pc = addr;
          this.bus.tick();
        }
        return;
      }
      case 0xc3:
        this.pc = this.imm16();
        this.bus.tick();
        return;
      case 0xc4:
      case 0xcc:
      case 0xd4:
      case 0xdc: {
        const addr = this.imm16();
        if (this.cond((op >> 3) & 3)) {
          this.bus.tick();
          this.push(this.pc);
          this.pc = addr;
        }
        return;
      }
      case 0xcd: {
        const addr = this.imm16();
        this.bus.tick();
        this.push(this.pc);
        this.pc = addr;
        return;
      }
      case 0xc6:
      case 0xce:
      case 0xd6:
      case 0xde:
      case 0xe6:
      case 0xee:
      case 0xf6:
      case 0xfe:
        this.alu((op >> 3) & 7, this.imm8());
        return;
      case 0xc7:
      case 0xcf:
      case 0xd7:
      case 0xdf:
      case 0xe7:
      case 0xef:
      case 0xf7:
      case 0xff:
        this.bus.tick();
        this.push(this.pc);
        this.pc = op & 0x38;
        return;
      case 0xc9:
        this.pc = this.pop();
        this.bus.tick();
        return;
      case 0xd9:
        this.pc = this.pop();
        this.bus.tick();
        this.ime = true;
        return;
      case 0xcb:
        this.execCb(this.imm8());
        return;
      case 0xe0:
        this.wr(0xff00 | this.imm8(), this.a);
        return;
      case 0xf0:
        this.a = this.rd(0xff00 | this.imm8());
        return;
      case 0xe2:
        this.wr(0xff00 | this.c, this.a);
        return;
      case 0xf2:
        this.a = this.rd(0xff00 | this.c);
        return;
      case 0xe8: {
        const e = this.imm8();
        const sp = this.sp;
        this.f = ((sp & 0xf) + (e & 0xf) > 0xf ? FH : 0) | ((sp & 0xff) + e > 0xff ? FC : 0);
        this.sp = (sp + ((e << 24) >> 24)) & 0xffff;
        this.bus.tick();
        this.bus.tick();
        return;
      }
      case 0xf8: {
        const e = this.imm8();
        const sp = this.sp;
        this.f = ((sp & 0xf) + (e & 0xf) > 0xf ? FH : 0) | ((sp & 0xff) + e > 0xff ? FC : 0);
        this.hl = sp + ((e << 24) >> 24);
        this.bus.tick();
        return;
      }
      case 0xf9:
        this.sp = this.hl;
        this.bus.tick();
        return;
      case 0xe9:
        this.pc = this.hl;
        return;
      case 0xea:
        this.wr(this.imm16(), this.a);
        return;
      case 0xfa:
        this.a = this.rd(this.imm16());
        return;
      case 0xf3:
        this.ime = false;
        this.eiPending = false;
        return;
      case 0xfb:
        this.eiPending = true;
        return;
      default:
        // 存在しない命令：実機は止まる
        this.locked = true;
    }
  }

  private execCb(op: number): void {
    const i = op & 7;
    const v = this.r8(i);
    const bit = (op >> 3) & 7;
    switch (op >> 6) {
      case 0:
        this.setR8(i, this.rot(bit, v));
        return;
      case 1:
        this.f = (this.f & FC) | FH | ((v >> bit) & 1 ? 0 : FZ);
        return;
      case 2:
        this.setR8(i, v & ~(1 << bit));
        return;
      default:
        this.setR8(i, v | (1 << bit));
    }
  }

  private halt(): void {
    if (!this.ime && this.bus.ie & this.bus.if_ & 0x1f) {
      // HALT のバグ：次の命令を読んだあと PC が進まない
      this.haltBug = true;
    } else this.halted = true;
  }
}
