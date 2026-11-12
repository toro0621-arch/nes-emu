// スーパーファミコンの CPU（65C816。ファミコンの 6502 を 16 ビットにしたもの）。
// A・X・Y は 8 ビットと 16 ビットを切り替えられ、アドレスは 24 ビット（バンク 8 ビット + 16 ビット）

export interface W65Bus {
  /** 経過したマスタークロック */
  cycles: number;
  /** ここまで実行したら止まる */
  stopAt: number;
  read(a: number): number;
  write(a: number, v: number): void;
  /** 内部の処理に 1 サイクルかかる */
  idle(): void;
  /** 割り込みの線（NMI は立ち上がりで 1 回、IRQ は立っている間） */
  nmiPending: boolean;
  irqLine: boolean;
  /** 書き込みの回数と、読むたびに変わりうる値（音のポート・カウンタ）を読んだか（待ちループを見分ける） */
  writes: number;
  volatileRead: boolean;
}

/** 実効アドレスの次のバイトの求め方 */
const WRAP_LONG = 0; // 24 ビットでそのまま
const WRAP_BANK0 = 1; // バンク 0 の中で折り返す（ダイレクトページ・スタック）
const WRAP_PAGE = 2; // ページ（256 バイト）の中で折り返す（エミュレーションモードの古い動き）

export class W65816 {
  a = 0;
  x = 0;
  y = 0;
  s = 0x01ff;
  d = 0;
  dbr = 0;
  pbr = 0;
  pc = 0;
  // フラグ
  n = 0;
  v = 0;
  /** 1 = A は 8 ビット */
  m = 1;
  /** 1 = X・Y は 8 ビット */
  xf = 1;
  dec = 0;
  i = 1;
  z = 0;
  c = 0;
  /** エミュレーションモード（6502 として動く） */
  e = 1;
  /** WAI（割り込みを待つ）・STP（止まる） */
  waiting = false;
  stopped = false;

  private ea = 0;
  private wrap = 0;
  /** 待ちループの見張り */
  private idlePc = -1;
  private idleState = new Int32Array(8);
  private idleWrites = 0;

  constructor(public bus: W65Bus) {}

  reset(): void {
    this.e = 1;
    this.m = 1;
    this.xf = 1;
    this.i = 1;
    this.dec = 0;
    this.d = 0;
    this.dbr = 0;
    this.pbr = 0;
    this.s = 0x0100 | (this.s & 0xff);
    this.x &= 0xff;
    this.y &= 0xff;
    this.waiting = false;
    this.stopped = false;
    const b = this.bus;
    this.pc = b.read(0xfffc) | (b.read(0xfffd) << 8);
  }

  getP(): number {
    return (
      (this.n << 7) | (this.v << 6) | (this.m << 5) | (this.xf << 4) | (this.dec << 3) | (this.i << 2) | (this.z << 1) | this.c
    );
  }

  setP(v: number): void {
    this.n = (v >> 7) & 1;
    this.v = (v >> 6) & 1;
    this.m = (v >> 5) & 1;
    this.xf = (v >> 4) & 1;
    this.dec = (v >> 3) & 1;
    this.i = (v >> 2) & 1;
    this.z = (v >> 1) & 1;
    this.c = v & 1;
    if (this.e) {
      this.m = 1;
      this.xf = 1;
    }
    if (this.xf) {
      this.x &= 0xff;
      this.y &= 0xff;
    }
  }

  // ───────── メモリ ─────────

  private fetch(): number {
    const v = this.bus.read((this.pbr << 16) | this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    const lo = this.fetch();
    return lo | (this.fetch() << 8);
  }

  private next(a: number): number {
    if (this.wrap === WRAP_LONG) return (a + 1) & 0xffffff;
    if (this.wrap === WRAP_BANK0) return (a + 1) & 0xffff;
    return (a & 0xffff00) | ((a + 1) & 0xff);
  }

  private rd8(): number {
    return this.bus.read(this.ea);
  }

  private rd16(): number {
    const lo = this.bus.read(this.ea);
    return lo | (this.bus.read(this.next(this.ea)) << 8);
  }

  private wr8(v: number): void {
    this.bus.write(this.ea, v & 0xff);
  }

  private wr16(v: number): void {
    this.bus.write(this.ea, v & 0xff);
    this.bus.write(this.next(this.ea), (v >> 8) & 0xff);
  }

  /** ダイレクトページ（エミュレーションモードで DL = 0 ならページの中で折り返す） */
  private readDirect(off: number): number {
    if (this.e && !(this.d & 0xff)) return this.bus.read(this.d | (off & 0xff));
    return this.bus.read((this.d + off) & 0xffff);
  }

  private readDirectN(off: number): number {
    return this.bus.read((this.d + off) & 0xffff);
  }

  private push(v: number): void {
    this.bus.write(this.s, v & 0xff);
    this.s = this.e ? 0x100 | ((this.s - 1) & 0xff) : (this.s - 1) & 0xffff;
  }

  private pull(): number {
    this.s = this.e ? 0x100 | ((this.s + 1) & 0xff) : (this.s + 1) & 0xffff;
    return this.bus.read(this.s);
  }

  /** 65816 で増えた命令のスタック操作（エミュレーションモードでもページをまたぐ） */
  private pushN(v: number): void {
    this.bus.write(this.s, v & 0xff);
    this.s = (this.s - 1) & 0xffff;
  }

  private pullN(): number {
    this.s = (this.s + 1) & 0xffff;
    return this.bus.read(this.s);
  }

  private fixS(): void {
    if (this.e) this.s = 0x100 | (this.s & 0xff);
  }

  // ───────── アドレッシング（this.ea・this.wrap を決める） ─────────

  private dpIo(): void {
    if (this.d & 0xff) this.bus.idle();
  }

  private aDp(): void {
    const o = this.fetch();
    this.dpIo();
    if (this.e && !(this.d & 0xff)) {
      this.ea = this.d | o;
      this.wrap = WRAP_PAGE;
    } else {
      this.ea = (this.d + o) & 0xffff;
      this.wrap = WRAP_BANK0;
    }
  }

  private aDpIdx(r: number): void {
    const o = this.fetch();
    this.dpIo();
    this.bus.idle();
    if (this.e && !(this.d & 0xff)) {
      this.ea = this.d | ((o + r) & 0xff);
      this.wrap = WRAP_PAGE;
    } else {
      this.ea = (this.d + o + r) & 0xffff;
      this.wrap = WRAP_BANK0;
    }
  }

  private aDpInd(): void {
    const o = this.fetch();
    this.dpIo();
    const p = this.readDirect(o) | (this.readDirect(o + 1) << 8);
    this.ea = (this.dbr << 16) | p;
    this.wrap = WRAP_LONG;
  }

  private aDpIndX(): void {
    const o = this.fetch();
    this.dpIo();
    this.bus.idle();
    const p = this.readDirect(o + this.x) | (this.readDirect(o + this.x + 1) << 8);
    this.ea = (this.dbr << 16) | p;
    this.wrap = WRAP_LONG;
  }

  private aDpIndY(write: boolean): void {
    const o = this.fetch();
    this.dpIo();
    const p = this.readDirect(o) | (this.readDirect(o + 1) << 8);
    if (write || !this.xf || ((p + this.y) & 0xff00) !== (p & 0xff00)) this.bus.idle();
    this.ea = ((this.dbr << 16) + p + this.y) & 0xffffff;
    this.wrap = WRAP_LONG;
  }

  private aDpIndLong(): void {
    const o = this.fetch();
    this.dpIo();
    this.ea = this.readDirectN(o) | (this.readDirectN(o + 1) << 8) | (this.readDirectN(o + 2) << 16);
    this.wrap = WRAP_LONG;
  }

  private aDpIndLongY(): void {
    const o = this.fetch();
    this.dpIo();
    const p = this.readDirectN(o) | (this.readDirectN(o + 1) << 8) | (this.readDirectN(o + 2) << 16);
    this.ea = (p + this.y) & 0xffffff;
    this.wrap = WRAP_LONG;
  }

  private aAbs(): void {
    this.ea = (this.dbr << 16) | this.fetch16();
    this.wrap = WRAP_LONG;
  }

  private aAbsIdx(r: number, write: boolean): void {
    const p = this.fetch16();
    if (write || !this.xf || ((p + r) & 0xff00) !== (p & 0xff00)) this.bus.idle();
    this.ea = ((this.dbr << 16) + p + r) & 0xffffff;
    this.wrap = WRAP_LONG;
  }

  private aLong(): void {
    const lo = this.fetch16();
    this.ea = lo | (this.fetch() << 16);
    this.wrap = WRAP_LONG;
  }

  private aLongX(): void {
    const lo = this.fetch16();
    this.ea = ((lo | (this.fetch() << 16)) + this.x) & 0xffffff;
    this.wrap = WRAP_LONG;
  }

  private aSr(): void {
    const o = this.fetch();
    this.bus.idle();
    this.ea = (this.s + o) & 0xffff;
    this.wrap = WRAP_BANK0;
  }

  private aSrIndY(): void {
    const o = this.fetch();
    this.bus.idle();
    const b = this.bus;
    const p = b.read((this.s + o) & 0xffff) | (b.read((this.s + o + 1) & 0xffff) << 8);
    b.idle();
    this.ea = ((this.dbr << 16) + p + this.y) & 0xffffff;
    this.wrap = WRAP_LONG;
  }

  /** ORA・AND などの「cc=01」の命令のアドレッシング（下位 5 ビットで決まる）。即値なら false */
  private aGroup1(op: number, write: boolean): boolean {
    switch (op & 0x1f) {
      case 0x01:
        this.aDpIndX();
        return true;
      case 0x03:
        this.aSr();
        return true;
      case 0x05:
        this.aDp();
        return true;
      case 0x07:
        this.aDpIndLong();
        return true;
      case 0x09:
        return false;
      case 0x0d:
        this.aAbs();
        return true;
      case 0x0f:
        this.aLong();
        return true;
      case 0x11:
        this.aDpIndY(write);
        return true;
      case 0x12:
        this.aDpInd();
        return true;
      case 0x13:
        this.aSrIndY();
        return true;
      case 0x15:
        this.aDpIdx(this.x);
        return true;
      case 0x17:
        this.aDpIndLongY();
        return true;
      case 0x19:
        this.aAbsIdx(this.y, write);
        return true;
      case 0x1d:
        this.aAbsIdx(this.x, write);
        return true;
      default:
        this.aLongX();
        return true;
    }
  }

  // ───────── 演算 ─────────

  private nz8(v: number): void {
    this.n = (v >> 7) & 1;
    this.z = (v & 0xff) === 0 ? 1 : 0;
  }

  private nz16(v: number): void {
    this.n = (v >> 15) & 1;
    this.z = (v & 0xffff) === 0 ? 1 : 0;
  }

  private adc8(data: number): void {
    const a = this.a & 0xff;
    let r: number;
    if (!this.dec) r = a + data + this.c;
    else {
      r = (a & 0x0f) + (data & 0x0f) + this.c;
      if (r > 0x09) r += 0x06;
      const c = r > 0x0f ? 1 : 0;
      r = (a & 0xf0) + (data & 0xf0) + (c << 4) + (r & 0x0f);
    }
    this.v = (~(a ^ data) & (a ^ r) & 0x80) ? 1 : 0;
    if (this.dec && r > 0x9f) r += 0x60;
    this.c = r > 0xff ? 1 : 0;
    this.nz8(r);
    this.a = (this.a & 0xff00) | (r & 0xff);
  }

  private adc16(data: number): void {
    const a = this.a;
    let r: number;
    if (!this.dec) r = a + data + this.c;
    else {
      r = (a & 0x000f) + (data & 0x000f) + this.c;
      if (r > 0x0009) r += 0x0006;
      let c = r > 0x000f ? 1 : 0;
      r = (a & 0x00f0) + (data & 0x00f0) + (c << 4) + (r & 0x000f);
      if (r > 0x009f) r += 0x0060;
      c = r > 0x00ff ? 1 : 0;
      r = (a & 0x0f00) + (data & 0x0f00) + (c << 8) + (r & 0x00ff);
      if (r > 0x09ff) r += 0x0600;
      c = r > 0x0fff ? 1 : 0;
      r = (a & 0xf000) + (data & 0xf000) + (c << 12) + (r & 0x0fff);
    }
    this.v = (~(a ^ data) & (a ^ r) & 0x8000) ? 1 : 0;
    if (this.dec && r > 0x9fff) r += 0x6000;
    this.c = r > 0xffff ? 1 : 0;
    this.nz16(r);
    this.a = r & 0xffff;
  }

  private sbc8(data: number): void {
    const a = this.a & 0xff;
    data ^= 0xff;
    let r: number;
    if (!this.dec) r = a + data + this.c;
    else {
      r = (a & 0x0f) + (data & 0x0f) + this.c;
      if (r <= 0x0f) r -= 0x06;
      const c = r > 0x0f ? 1 : 0;
      r = (a & 0xf0) + (data & 0xf0) + (c << 4) + (r & 0x0f);
    }
    this.v = (~(a ^ data) & (a ^ r) & 0x80) ? 1 : 0;
    if (this.dec && r <= 0xff) r -= 0x60;
    this.c = r > 0xff ? 1 : 0;
    this.nz8(r);
    this.a = (this.a & 0xff00) | (r & 0xff);
  }

  private sbc16(data: number): void {
    const a = this.a;
    data ^= 0xffff;
    let r: number;
    if (!this.dec) r = a + data + this.c;
    else {
      r = (a & 0x000f) + (data & 0x000f) + this.c;
      if (r <= 0x000f) r -= 0x0006;
      let c = r > 0x000f ? 1 : 0;
      r = (a & 0x00f0) + (data & 0x00f0) + (c << 4) + (r & 0x000f);
      if (r <= 0x00ff) r -= 0x0060;
      c = r > 0x00ff ? 1 : 0;
      r = (a & 0x0f00) + (data & 0x0f00) + (c << 8) + (r & 0x00ff);
      if (r <= 0x0fff) r -= 0x0600;
      c = r > 0x0fff ? 1 : 0;
      r = (a & 0xf000) + (data & 0xf000) + (c << 12) + (r & 0x0fff);
    }
    this.v = (~(a ^ data) & (a ^ r) & 0x8000) ? 1 : 0;
    if (this.dec && r <= 0xffff) r -= 0x6000;
    this.c = r > 0xffff ? 1 : 0;
    this.nz16(r);
    this.a = r & 0xffff;
  }

  /** ORA AND EOR ADC (STA) LDA CMP SBC を 1 つの値で行う（op の上位 3 ビット） */
  private alu(kind: number, v: number, wide: boolean): void {
    if (wide) {
      switch (kind) {
        case 0:
          this.a |= v;
          this.nz16(this.a);
          break;
        case 1:
          this.a &= v;
          this.nz16(this.a);
          break;
        case 2:
          this.a ^= v;
          this.nz16(this.a);
          break;
        case 3:
          this.adc16(v);
          break;
        case 5:
          this.a = v;
          this.nz16(v);
          break;
        case 6: {
          const r = this.a - v;
          this.c = r >= 0 ? 1 : 0;
          this.nz16(r);
          break;
        }
        case 7:
          this.sbc16(v);
          break;
      }
    } else {
      const a = this.a & 0xff;
      switch (kind) {
        case 0:
          this.a = (this.a & 0xff00) | (a | v);
          this.nz8(a | v);
          break;
        case 1:
          this.a = (this.a & 0xff00) | (a & v);
          this.nz8(a & v);
          break;
        case 2:
          this.a = (this.a & 0xff00) | (a ^ v);
          this.nz8(a ^ v);
          break;
        case 3:
          this.adc8(v);
          break;
        case 5:
          this.a = (this.a & 0xff00) | v;
          this.nz8(v);
          break;
        case 6: {
          const r = a - v;
          this.c = r >= 0 ? 1 : 0;
          this.nz8(r);
          break;
        }
        case 7:
          this.sbc8(v);
          break;
      }
    }
  }

  /** 読み書きする命令（ASL ROL LSR ROR INC DEC TSB TRB）の演算 */
  private rmwOp(kind: number, v: number, wide: boolean): number {
    const mask = wide ? 0xffff : 0xff;
    const top = wide ? 15 : 7;
    let r: number;
    switch (kind) {
      case 0: // ASL
        this.c = (v >> top) & 1;
        r = (v << 1) & mask;
        break;
      case 1: // ROL
        r = ((v << 1) | this.c) & mask;
        this.c = (v >> top) & 1;
        break;
      case 2: // LSR
        this.c = v & 1;
        r = v >> 1;
        break;
      case 3: // ROR
        r = (v >> 1) | (this.c << top);
        this.c = v & 1;
        break;
      case 4: // INC
        r = (v + 1) & mask;
        break;
      case 5: // DEC
        r = (v - 1) & mask;
        break;
      case 6: // TSB
        this.z = (v & this.a & mask) === 0 ? 1 : 0;
        return v | (this.a & mask);
      default: // TRB
        this.z = (v & this.a & mask) === 0 ? 1 : 0;
        return v & ~this.a & mask;
    }
    if (wide) this.nz16(r);
    else this.nz8(r);
    return r;
  }

  private rmw(kind: number): void {
    const b = this.bus;
    if (this.m) {
      const v = this.rd8();
      b.idle();
      this.wr8(this.rmwOp(kind, v, false));
    } else {
      const v = this.rd16();
      b.idle();
      const r = this.rmwOp(kind, v, true);
      // 16 ビットのときは上位バイトから書く
      b.write(this.next(this.ea), (r >> 8) & 0xff);
      b.write(this.ea, r & 0xff);
    }
  }

  private branch(cond: boolean): void {
    const off = (this.fetch() << 24) >> 24;
    if (!cond) return;
    const dest = (this.pc + off) & 0xffff;
    this.bus.idle();
    if (this.e && (dest & 0xff00) !== (this.pc & 0xff00)) this.bus.idle();
    this.pc = dest;
    if (off < 0 && off >= -48) this.checkIdle();
  }

  /**
   * 少し後ろへ戻る分岐（ループ）で、前の回とレジスタがまったく同じで、その間にメモリへ書かず、
   * 勝手に変わる値も読んでいなければ、次の出来事（割り込み・ラインの区切り）まで同じことをくり返すだけなので時間を飛ばす
   */
  private checkIdle(): void {
    const b = this.bus;
    const s = this.idleState;
    const p = this.getP() | (this.e << 8);
    const key = (this.pbr << 16) | this.pc;
    if (
      key === this.idlePc &&
      b.writes === this.idleWrites &&
      !b.volatileRead &&
      s[0] === this.a &&
      s[1] === this.x &&
      s[2] === this.y &&
      s[3] === this.s &&
      s[4] === this.d &&
      s[5] === this.dbr &&
      s[6] === p
    ) {
      if (b.stopAt > b.cycles) b.cycles = b.stopAt;
      return;
    }
    this.idlePc = key;
    s[0] = this.a;
    s[1] = this.x;
    s[2] = this.y;
    s[3] = this.s;
    s[4] = this.d;
    s[5] = this.dbr;
    s[6] = p;
    this.idleWrites = b.writes;
    b.volatileRead = false;
  }

  private interrupt(nativeVec: number, emuVec: number, brk: boolean): void {
    if (!this.e) this.push(this.pbr);
    this.push(this.pc >> 8);
    this.push(this.pc);
    // エミュレーションモードでは bit4 が B フラグ（BRK・COP なら 1、IRQ・NMI なら 0）
    let p = this.getP();
    if (this.e) p = (p & ~0x10) | 0x20 | (brk ? 0x10 : 0);
    this.push(p);
    this.i = 1;
    this.dec = 0;
    this.pbr = 0;
    const vec = this.e ? emuVec : nativeVec;
    this.pc = this.bus.read(vec) | (this.bus.read(vec + 1) << 8);
  }

  nmi(): void {
    this.bus.idle();
    this.bus.idle();
    this.interrupt(0xffea, 0xfffa, false);
  }

  irq(): void {
    this.bus.idle();
    this.bus.idle();
    this.interrupt(0xffee, 0xfffe, false);
  }

  /** bus.stopAt まで実行する */
  run(): void {
    const b = this.bus;
    while (b.cycles < b.stopAt) {
      if (b.nmiPending) {
        b.nmiPending = false;
        this.waiting = false;
        this.nmi();
        continue;
      }
      if (b.irqLine) {
        if (this.waiting) this.waiting = false;
        if (!this.i) {
          this.irq();
          continue;
        }
      }
      if (this.waiting || this.stopped) {
        b.cycles = b.stopAt;
        return;
      }
      this.step();
    }
  }

  /** 1 命令を実行する */
  step(): void {
    const b = this.bus;
    const op = this.fetch();
    switch (op) {
      // ── ORA AND EOR ADC STA LDA CMP SBC ──
      case 0x01: case 0x03: case 0x05: case 0x07: case 0x09: case 0x0d: case 0x0f: case 0x11: case 0x12: case 0x13: case 0x15: case 0x17: case 0x19: case 0x1d: case 0x1f:
      case 0x21: case 0x23: case 0x25: case 0x27: case 0x29: case 0x2d: case 0x2f: case 0x31: case 0x32: case 0x33: case 0x35: case 0x37: case 0x39: case 0x3d: case 0x3f:
      case 0x41: case 0x43: case 0x45: case 0x47: case 0x49: case 0x4d: case 0x4f: case 0x51: case 0x52: case 0x53: case 0x55: case 0x57: case 0x59: case 0x5d: case 0x5f:
      case 0x61: case 0x63: case 0x65: case 0x67: case 0x69: case 0x6d: case 0x6f: case 0x71: case 0x72: case 0x73: case 0x75: case 0x77: case 0x79: case 0x7d: case 0x7f:
      case 0xa1: case 0xa3: case 0xa5: case 0xa7: case 0xa9: case 0xad: case 0xaf: case 0xb1: case 0xb2: case 0xb3: case 0xb5: case 0xb7: case 0xb9: case 0xbd: case 0xbf:
      case 0xc1: case 0xc3: case 0xc5: case 0xc7: case 0xc9: case 0xcd: case 0xcf: case 0xd1: case 0xd2: case 0xd3: case 0xd5: case 0xd7: case 0xd9: case 0xdd: case 0xdf:
      case 0xe1: case 0xe3: case 0xe5: case 0xe7: case 0xe9: case 0xed: case 0xef: case 0xf1: case 0xf2: case 0xf3: case 0xf5: case 0xf7: case 0xf9: case 0xfd: case 0xff: {
        const wide = !this.m;
        let v: number;
        if (this.aGroup1(op, false)) v = wide ? this.rd16() : this.rd8();
        else v = wide ? this.fetch16() : this.fetch();
        this.alu(op >> 5, v, wide);
        break;
      }
      // STA
      case 0x81: case 0x83: case 0x85: case 0x87: case 0x8d: case 0x8f: case 0x91: case 0x92: case 0x93: case 0x95: case 0x97: case 0x99: case 0x9d: case 0x9f:
        this.aGroup1(op, true);
        if (this.m) this.wr8(this.a);
        else this.wr16(this.a);
        break;

      // ── ASL ROL LSR ROR（メモリ） ──
      case 0x06: case 0x26: case 0x46: case 0x66:
        this.aDp();
        this.rmw(op >> 5);
        break;
      case 0x0e: case 0x2e: case 0x4e: case 0x6e:
        this.aAbs();
        this.rmw(op >> 5);
        break;
      case 0x16: case 0x36: case 0x56: case 0x76:
        this.aDpIdx(this.x);
        this.rmw(op >> 5);
        break;
      case 0x1e: case 0x3e: case 0x5e: case 0x7e:
        this.aAbsIdx(this.x, true);
        this.rmw(op >> 5);
        break;
      // アキュムレータ
      case 0x0a: case 0x2a: case 0x4a: case 0x6a:
        b.idle();
        if (this.m) this.a = (this.a & 0xff00) | this.rmwOp(op >> 5, this.a & 0xff, false);
        else this.a = this.rmwOp(op >> 5, this.a, true);
        break;
      // INC DEC
      case 0xe6: this.aDp(); this.rmw(4); break;
      case 0xee: this.aAbs(); this.rmw(4); break;
      case 0xf6: this.aDpIdx(this.x); this.rmw(4); break;
      case 0xfe: this.aAbsIdx(this.x, true); this.rmw(4); break;
      case 0xc6: this.aDp(); this.rmw(5); break;
      case 0xce: this.aAbs(); this.rmw(5); break;
      case 0xd6: this.aDpIdx(this.x); this.rmw(5); break;
      case 0xde: this.aAbsIdx(this.x, true); this.rmw(5); break;
      case 0x1a:
        b.idle();
        if (this.m) this.a = (this.a & 0xff00) | this.rmwOp(4, this.a & 0xff, false);
        else this.a = this.rmwOp(4, this.a, true);
        break;
      case 0x3a:
        b.idle();
        if (this.m) this.a = (this.a & 0xff00) | this.rmwOp(5, this.a & 0xff, false);
        else this.a = this.rmwOp(5, this.a, true);
        break;
      // TSB TRB
      case 0x04: this.aDp(); this.rmw(6); break;
      case 0x0c: this.aAbs(); this.rmw(6); break;
      case 0x14: this.aDp(); this.rmw(7); break;
      case 0x1c: this.aAbs(); this.rmw(7); break;

      // ── BIT ──
      case 0x24: case 0x2c: case 0x34: case 0x3c: {
        if (op === 0x24) this.aDp();
        else if (op === 0x2c) this.aAbs();
        else if (op === 0x34) this.aDpIdx(this.x);
        else this.aAbsIdx(this.x, false);
        if (this.m) {
          const v = this.rd8();
          this.n = (v >> 7) & 1;
          this.v = (v >> 6) & 1;
          this.z = (v & this.a & 0xff) === 0 ? 1 : 0;
        } else {
          const v = this.rd16();
          this.n = (v >> 15) & 1;
          this.v = (v >> 14) & 1;
          this.z = (v & this.a) === 0 ? 1 : 0;
        }
        break;
      }
      case 0x89:
        if (this.m) this.z = (this.fetch() & this.a & 0xff) === 0 ? 1 : 0;
        else this.z = (this.fetch16() & this.a) === 0 ? 1 : 0;
        break;

      // ── LDX LDY STX STY STZ CPX CPY ──
      case 0xa2: case 0xa6: case 0xae: case 0xb6: case 0xbe: {
        let v: number;
        if (op === 0xa2) v = this.xf ? this.fetch() : this.fetch16();
        else {
          if (op === 0xa6) this.aDp();
          else if (op === 0xae) this.aAbs();
          else if (op === 0xb6) this.aDpIdx(this.y);
          else this.aAbsIdx(this.y, false);
          v = this.xf ? this.rd8() : this.rd16();
        }
        this.x = v;
        if (this.xf) this.nz8(v);
        else this.nz16(v);
        break;
      }
      case 0xa0: case 0xa4: case 0xac: case 0xb4: case 0xbc: {
        let v: number;
        if (op === 0xa0) v = this.xf ? this.fetch() : this.fetch16();
        else {
          if (op === 0xa4) this.aDp();
          else if (op === 0xac) this.aAbs();
          else if (op === 0xb4) this.aDpIdx(this.x);
          else this.aAbsIdx(this.x, false);
          v = this.xf ? this.rd8() : this.rd16();
        }
        this.y = v;
        if (this.xf) this.nz8(v);
        else this.nz16(v);
        break;
      }
      case 0x86: case 0x8e: case 0x96:
        if (op === 0x86) this.aDp();
        else if (op === 0x8e) this.aAbs();
        else this.aDpIdx(this.y);
        if (this.xf) this.wr8(this.x);
        else this.wr16(this.x);
        break;
      case 0x84: case 0x8c: case 0x94:
        if (op === 0x84) this.aDp();
        else if (op === 0x8c) this.aAbs();
        else this.aDpIdx(this.x);
        if (this.xf) this.wr8(this.y);
        else this.wr16(this.y);
        break;
      case 0x64: case 0x74: case 0x9c: case 0x9e:
        if (op === 0x64) this.aDp();
        else if (op === 0x74) this.aDpIdx(this.x);
        else if (op === 0x9c) this.aAbs();
        else this.aAbsIdx(this.x, true);
        if (this.m) this.wr8(0);
        else this.wr16(0);
        break;
      case 0xe0: case 0xe4: case 0xec: case 0xc0: case 0xc4: case 0xcc: {
        const r = op >= 0xe0 ? this.x : this.y;
        let v: number;
        const mode = op & 0x0f;
        if (mode === 0) v = this.xf ? this.fetch() : this.fetch16();
        else {
          if (mode === 4) this.aDp();
          else this.aAbs();
          v = this.xf ? this.rd8() : this.rd16();
        }
        const d = r - v;
        this.c = d >= 0 ? 1 : 0;
        if (this.xf) this.nz8(d);
        else this.nz16(d);
        break;
      }

      // ── 分岐 ──
      case 0x10: this.branch(!this.n); break;
      case 0x30: this.branch(!!this.n); break;
      case 0x50: this.branch(!this.v); break;
      case 0x70: this.branch(!!this.v); break;
      case 0x90: this.branch(!this.c); break;
      case 0xb0: this.branch(!!this.c); break;
      case 0xd0: this.branch(!this.z); break;
      case 0xf0: this.branch(!!this.z); break;
      case 0x80: this.branch(true); break;
      case 0x82: {
        const off = this.fetch16();
        b.idle();
        this.pc = (this.pc + off) & 0xffff;
        break;
      }

      // ── ジャンプ・サブルーチン ──
      case 0x4c:
        this.pc = this.fetch16();
        break;
      case 0x5c: {
        const lo = this.fetch16();
        this.pbr = this.fetch();
        this.pc = lo;
        break;
      }
      case 0x6c: {
        const p = this.fetch16();
        this.pc = b.read(p) | (b.read((p + 1) & 0xffff) << 8);
        break;
      }
      case 0x7c: {
        const p = this.fetch16();
        b.idle();
        const at = (p + this.x) & 0xffff;
        this.pc = b.read((this.pbr << 16) | at) | (b.read((this.pbr << 16) | ((at + 1) & 0xffff)) << 8);
        break;
      }
      case 0xdc: {
        const p = this.fetch16();
        const lo = b.read(p) | (b.read((p + 1) & 0xffff) << 8);
        this.pbr = b.read((p + 2) & 0xffff);
        this.pc = lo;
        break;
      }
      case 0x20: {
        const dest = this.fetch16();
        b.idle();
        const ret = (this.pc - 1) & 0xffff;
        this.push(ret >> 8);
        this.push(ret);
        this.pc = dest;
        break;
      }
      case 0x22: {
        const lo = this.fetch16();
        this.pushN(this.pbr);
        b.idle();
        const bank = this.fetch();
        const ret = (this.pc - 1) & 0xffff;
        this.pushN(ret >> 8);
        this.pushN(ret);
        this.fixS();
        this.pbr = bank;
        this.pc = lo;
        break;
      }
      case 0xfc: {
        const lo = this.fetch();
        const ret = this.pc;
        this.pushN(ret >> 8);
        this.pushN(ret);
        const hi = this.fetch();
        b.idle();
        const at = ((hi << 8) | lo) + this.x;
        this.pc = b.read((this.pbr << 16) | (at & 0xffff)) | (b.read((this.pbr << 16) | ((at + 1) & 0xffff)) << 8);
        this.fixS();
        break;
      }
      case 0x60: {
        b.idle();
        b.idle();
        const lo = this.pull();
        this.pc = ((lo | (this.pull() << 8)) + 1) & 0xffff;
        b.idle();
        break;
      }
      case 0x6b: {
        b.idle();
        b.idle();
        const lo = this.pullN();
        const hi = this.pullN();
        this.pbr = this.pullN();
        this.fixS();
        this.pc = ((lo | (hi << 8)) + 1) & 0xffff;
        break;
      }
      case 0x40: {
        b.idle();
        b.idle();
        this.setP(this.pull());
        const lo = this.pull();
        this.pc = lo | (this.pull() << 8);
        if (!this.e) this.pbr = this.pull();
        break;
      }

      // ── スタック ──
      case 0x48:
        b.idle();
        if (this.m) this.push(this.a);
        else {
          this.push(this.a >> 8);
          this.push(this.a);
        }
        break;
      case 0x68:
        b.idle();
        b.idle();
        if (this.m) {
          const v = this.pull();
          this.a = (this.a & 0xff00) | v;
          this.nz8(v);
        } else {
          const lo = this.pull();
          this.a = lo | (this.pull() << 8);
          this.nz16(this.a);
        }
        break;
      case 0xda: case 0x5a: {
        b.idle();
        const r = op === 0xda ? this.x : this.y;
        if (this.xf) this.push(r);
        else {
          this.push(r >> 8);
          this.push(r);
        }
        break;
      }
      case 0xfa: case 0x7a: {
        b.idle();
        b.idle();
        let v: number;
        if (this.xf) {
          v = this.pull();
          this.nz8(v);
        } else {
          const lo = this.pull();
          v = lo | (this.pull() << 8);
          this.nz16(v);
        }
        if (op === 0xfa) this.x = v;
        else this.y = v;
        break;
      }
      case 0x08:
        b.idle();
        this.push(this.e ? this.getP() | 0x30 : this.getP());
        break;
      case 0x28:
        b.idle();
        b.idle();
        this.setP(this.pull());
        break;
      case 0x8b:
        b.idle();
        this.push(this.dbr);
        break;
      case 0xab:
        b.idle();
        b.idle();
        this.dbr = this.pullN();
        this.fixS();
        this.nz8(this.dbr);
        break;
      case 0x0b:
        b.idle();
        this.pushN(this.d >> 8);
        this.pushN(this.d);
        this.fixS();
        break;
      case 0x2b: {
        b.idle();
        b.idle();
        const lo = this.pullN();
        this.d = lo | (this.pullN() << 8);
        this.fixS();
        this.nz16(this.d);
        break;
      }
      case 0x4b:
        b.idle();
        this.push(this.pbr);
        break;
      case 0xf4: {
        const v = this.fetch16();
        this.pushN(v >> 8);
        this.pushN(v);
        this.fixS();
        break;
      }
      case 0xd4: {
        const o = this.fetch();
        this.dpIo();
        const v = this.readDirectN(o) | (this.readDirectN(o + 1) << 8);
        this.pushN(v >> 8);
        this.pushN(v);
        this.fixS();
        break;
      }
      case 0x62: {
        const off = this.fetch16();
        b.idle();
        const v = (this.pc + off) & 0xffff;
        this.pushN(v >> 8);
        this.pushN(v);
        this.fixS();
        break;
      }

      // ── 転送 ──
      case 0xaa:
        b.idle();
        if (this.xf) {
          this.x = this.a & 0xff;
          this.nz8(this.x);
        } else {
          this.x = this.a;
          this.nz16(this.x);
        }
        break;
      case 0xa8:
        b.idle();
        if (this.xf) {
          this.y = this.a & 0xff;
          this.nz8(this.y);
        } else {
          this.y = this.a;
          this.nz16(this.y);
        }
        break;
      case 0x8a:
        b.idle();
        if (this.m) {
          this.a = (this.a & 0xff00) | (this.x & 0xff);
          this.nz8(this.a);
        } else {
          this.a = this.x;
          this.nz16(this.a);
        }
        break;
      case 0x98:
        b.idle();
        if (this.m) {
          this.a = (this.a & 0xff00) | (this.y & 0xff);
          this.nz8(this.a);
        } else {
          this.a = this.y;
          this.nz16(this.a);
        }
        break;
      case 0xba:
        b.idle();
        if (this.xf) {
          this.x = this.s & 0xff;
          this.nz8(this.x);
        } else {
          this.x = this.s;
          this.nz16(this.x);
        }
        break;
      case 0x9a:
        b.idle();
        this.s = this.e ? 0x100 | (this.x & 0xff) : this.x;
        break;
      case 0x9b:
        b.idle();
        this.y = this.x;
        if (this.xf) this.nz8(this.y);
        else this.nz16(this.y);
        break;
      case 0xbb:
        b.idle();
        this.x = this.y;
        if (this.xf) this.nz8(this.x);
        else this.nz16(this.x);
        break;
      case 0x5b:
        b.idle();
        this.d = this.a;
        this.nz16(this.d);
        break;
      case 0x7b:
        b.idle();
        this.a = this.d;
        this.nz16(this.a);
        break;
      case 0x1b:
        b.idle();
        this.s = this.e ? 0x100 | (this.a & 0xff) : this.a;
        break;
      case 0x3b:
        b.idle();
        this.a = this.s;
        this.nz16(this.a);
        break;
      case 0xeb:
        b.idle();
        b.idle();
        this.a = ((this.a >> 8) | (this.a << 8)) & 0xffff;
        this.nz8(this.a);
        break;
      case 0xfb: {
        b.idle();
        const c = this.c;
        this.c = this.e;
        this.e = c;
        if (this.e) {
          this.m = 1;
          this.xf = 1;
          this.x &= 0xff;
          this.y &= 0xff;
          this.s = 0x100 | (this.s & 0xff);
        }
        break;
      }

      // ── フラグ ──
      case 0x18: b.idle(); this.c = 0; break;
      case 0x38: b.idle(); this.c = 1; break;
      case 0x58: b.idle(); this.i = 0; break;
      case 0x78: b.idle(); this.i = 1; break;
      case 0xb8: b.idle(); this.v = 0; break;
      case 0xd8: b.idle(); this.dec = 0; break;
      case 0xf8: b.idle(); this.dec = 1; break;
      case 0xc2: {
        const v = this.fetch();
        b.idle();
        this.setP(this.getP() & ~v);
        break;
      }
      case 0xe2: {
        const v = this.fetch();
        b.idle();
        this.setP(this.getP() | v);
        break;
      }

      // ── X・Y の増減 ──
      case 0xe8:
        b.idle();
        this.x = (this.x + 1) & (this.xf ? 0xff : 0xffff);
        if (this.xf) this.nz8(this.x);
        else this.nz16(this.x);
        break;
      case 0xc8:
        b.idle();
        this.y = (this.y + 1) & (this.xf ? 0xff : 0xffff);
        if (this.xf) this.nz8(this.y);
        else this.nz16(this.y);
        break;
      case 0xca:
        b.idle();
        this.x = (this.x - 1) & (this.xf ? 0xff : 0xffff);
        if (this.xf) this.nz8(this.x);
        else this.nz16(this.x);
        break;
      case 0x88:
        b.idle();
        this.y = (this.y - 1) & (this.xf ? 0xff : 0xffff);
        if (this.xf) this.nz8(this.y);
        else this.nz16(this.y);
        break;

      // ── そのほか ──
      case 0xea:
        b.idle();
        break;
      case 0x42:
        this.fetch();
        break;
      case 0x00:
        this.fetch();
        this.interrupt(0xffe6, 0xfffe, true);
        break;
      case 0x02:
        this.fetch();
        this.interrupt(0xffe4, 0xfff4, true);
        break;
      case 0xcb:
        b.idle();
        b.idle();
        this.waiting = true;
        break;
      case 0xdb:
        b.idle();
        b.idle();
        this.stopped = true;
        break;
      case 0x54: case 0x44: {
        // MVN・MVP：1 バイトずつ動かし、A が 0xFFFF になるまで同じ命令をくり返す
        const dst = this.fetch();
        const src = this.fetch();
        this.dbr = dst;
        const v = b.read((src << 16) | this.x);
        b.write((dst << 16) | this.y, v);
        b.idle();
        b.idle();
        const step = op === 0x54 ? 1 : -1;
        const mask = this.xf ? 0xff : 0xffff;
        this.x = (this.x + step) & mask;
        this.y = (this.y + step) & mask;
        this.a = (this.a - 1) & 0xffff;
        if (this.a !== 0xffff) this.pc = (this.pc - 3) & 0xffff;
        break;
      }
      default:
        break;
    }
  }
}
