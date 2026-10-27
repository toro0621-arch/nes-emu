// 6502（NES の 2A03。10進モードなし）
export interface CpuBus {
  read(addr: number): number;
  write(addr: number, v: number): void;
  /** CPU が n サイクル進んだ（PPU などをそのぶん進める） */
  tick(cycles: number): void;
  /** 命令の最後のサイクルを、読み書きの直前まで進める */
  tickBeforeAccess(): void;
  /** 最後のサイクルの残りを進める */
  tickAfterAccess(): void;
}

export const C = 0x01;
export const Z = 0x02;
export const I = 0x04;
export const D = 0x08;
export const B = 0x10;
export const U = 0x20;
export const V = 0x40;
export const N = 0x80;

// アドレッシングモード
const IMP = 0, ACC = 1, IMM = 2, ZP = 3, ZPX = 4, ZPY = 5, ABS = 6, ABX = 7, ABY = 8, IND = 9, IZX = 10, IZY = 11, REL = 12;
const MODE_LEN = [1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 2, 2, 2];

type Exec = (c: Cpu) => void;

interface Op {
  name: string;
  mode: number;
  cycles: number;
  /** ページをまたいだら +1 サイクル（読み出し系の命令） */
  pagePenalty: boolean;
  exec: Exec;
}

export class Cpu {
  a = 0;
  x = 0;
  y = 0;
  sp = 0xfd;
  pc = 0;
  p = U | I;
  /** 起動からの累計サイクル */
  cycles = 0;
  /** DMA などで CPU が止まるサイクル数 */
  stall = 0;
  /** JAM 命令で停止した */
  jammed = false;

  private nmiPending = false;
  /** IRQ 線（マッパーや APU が立てる。ビットごとに要因を持つ） */
  irqLine = 0;
  // 命令の最後から 2 サイクル目で割り込みを確認し、次の命令の代わりに実行する
  private doNmi = false;
  private doIrq = false;

  // 実行中の命令のオペランド
  private addr = 0;
  private mode = IMP;
  private crossed = false;

  constructor(public bus: CpuBus) {}

  reset(): void {
    this.pc = this.read16(0xfffc);
    this.sp = (this.sp - 3) & 0xff;
    this.p |= I;
    this.cycles += 7;
    this.bus.tick(7);
    this.jammed = false;
    this.nmiPending = this.doNmi = this.doIrq = false;
  }

  /** 電源投入直後の状態にしてリセット */
  powerOn(): void {
    this.a = this.x = this.y = 0;
    this.sp = 0x00;
    this.p = U | I;
    this.cycles = 0;
    this.reset();
  }

  nmi(): void {
    this.nmiPending = true;
  }

  /** 1 命令（または割り込み・停止 1 サイクル）を実行し、かかったサイクル数を返す */
  step(): number {
    if (this.stall > 0 || this.jammed) {
      if (this.stall > 0) this.stall--;
      this.cycles++;
      this.bus.tick(1);
      this.pollInterrupts();
      return 1;
    }
    if (this.doNmi || this.doIrq) {
      const vector = this.doNmi ? 0xfffa : 0xfffe;
      this.doNmi = this.doIrq = false;
      this.interrupt(vector);
      this.bus.tick(7);
      return 7;
    }

    const op = OPS[this.read(this.pc)];
    this.pc = (this.pc + 1) & 0xffff;
    this.mode = op.mode;
    this.resolve(op.mode);
    const n = op.cycles + (op.pagePenalty && this.crossed ? 1 : 0);
    const before = (this.cycles += n);
    // オペランドの読み書きは命令の最後のサイクルに起きるので、その直前まで PPU を進めておく
    this.bus.tick(n - 1);
    this.pollInterrupts();
    this.bus.tickBeforeAccess();
    op.exec(this);
    this.bus.tickAfterAccess();
    const extra = this.cycles - before; // 分岐で増えたサイクル
    if (extra) this.bus.tick(extra);
    return n + extra;
  }

  private pollInterrupts(): void {
    if (this.nmiPending) {
      this.nmiPending = false;
      this.doNmi = true;
    }
    if (this.irqLine && !(this.p & I)) this.doIrq = true;
  }

  // ---- メモリ ----
  read(addr: number): number {
    return this.bus.read(addr);
  }
  write(addr: number, v: number): void {
    this.bus.write(addr, v);
  }
  read16(addr: number): number {
    return this.read(addr) | (this.read((addr + 1) & 0xffff) << 8);
  }
  /** 同じページ内で折り返す 16bit 読み出し（ゼロページ間接・JMP 間接のバグ） */
  private read16wrap(addr: number): number {
    const hi = (addr & 0xff00) | ((addr + 1) & 0xff);
    return this.read(addr) | (this.read(hi) << 8);
  }
  private push(v: number): void {
    this.write(0x100 | this.sp, v);
    this.sp = (this.sp - 1) & 0xff;
  }
  private pop(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.read(0x100 | this.sp);
  }
  private push16(v: number): void {
    this.push(v >> 8);
    this.push(v & 0xff);
  }
  private pop16(): number {
    const lo = this.pop();
    return lo | (this.pop() << 8);
  }

  private interrupt(vector: number): void {
    this.push16(this.pc);
    this.push((this.p & ~B) | U);
    this.p |= I;
    this.pc = this.read16(vector);
    this.cycles += 7;
  }

  private resolve(mode: number): void {
    this.crossed = false;
    const pc = this.pc;
    switch (mode) {
      case IMP:
      case ACC:
        return;
      case IMM:
        this.addr = pc;
        this.pc = (pc + 1) & 0xffff;
        return;
      case ZP:
        this.addr = this.read(pc);
        this.pc = (pc + 1) & 0xffff;
        return;
      case ZPX:
        this.addr = (this.read(pc) + this.x) & 0xff;
        this.pc = (pc + 1) & 0xffff;
        return;
      case ZPY:
        this.addr = (this.read(pc) + this.y) & 0xff;
        this.pc = (pc + 1) & 0xffff;
        return;
      case ABS:
        this.addr = this.read16(pc);
        this.pc = (pc + 2) & 0xffff;
        return;
      case ABX: {
        const base = this.read16(pc);
        this.addr = (base + this.x) & 0xffff;
        this.crossed = (base & 0xff00) !== (this.addr & 0xff00);
        this.pc = (pc + 2) & 0xffff;
        return;
      }
      case ABY: {
        const base = this.read16(pc);
        this.addr = (base + this.y) & 0xffff;
        this.crossed = (base & 0xff00) !== (this.addr & 0xff00);
        this.pc = (pc + 2) & 0xffff;
        return;
      }
      case IND:
        this.addr = this.read16wrap(this.read16(pc));
        this.pc = (pc + 2) & 0xffff;
        return;
      case IZX:
        this.addr = this.read16wrap((this.read(pc) + this.x) & 0xff);
        this.pc = (pc + 1) & 0xffff;
        return;
      case IZY: {
        const base = this.read16wrap(this.read(pc));
        this.addr = (base + this.y) & 0xffff;
        this.crossed = (base & 0xff00) !== (this.addr & 0xff00);
        this.pc = (pc + 1) & 0xffff;
        return;
      }
      case REL: {
        const off = this.read(pc);
        this.pc = (pc + 1) & 0xffff;
        this.addr = (this.pc + (off < 0x80 ? off : off - 0x100)) & 0xffff;
        return;
      }
    }
  }

  // ---- 命令の部品 ----
  private zn(v: number): void {
    this.p = (this.p & ~(Z | N)) | (v === 0 ? Z : 0) | (v & N);
  }
  private setFlag(f: number, on: boolean): void {
    if (on) this.p |= f;
    else this.p &= ~f;
  }
  private operand(): number {
    return this.mode === ACC ? this.a : this.read(this.addr);
  }
  /** 読み・変更・書き（RMW）命令の書き戻し */
  private store(v: number): void {
    if (this.mode === ACC) this.a = v;
    else this.write(this.addr, v);
  }
  private branch(cond: boolean): void {
    if (!cond) return;
    this.cycles += (this.pc & 0xff00) !== (this.addr & 0xff00) ? 2 : 1;
    this.pc = this.addr;
  }
  private compare(reg: number, v: number): void {
    const r = reg - v;
    this.setFlag(C, r >= 0);
    this.zn(r & 0xff);
  }
  private adcValue(v: number): void {
    const sum = this.a + v + (this.p & C);
    this.setFlag(C, sum > 0xff);
    this.setFlag(V, (~(this.a ^ v) & (this.a ^ sum) & 0x80) !== 0);
    this.a = sum & 0xff;
    this.zn(this.a);
  }
  private aslValue(v: number): number {
    this.setFlag(C, (v & 0x80) !== 0);
    const r = (v << 1) & 0xff;
    this.zn(r);
    return r;
  }
  private lsrValue(v: number): number {
    this.setFlag(C, (v & 1) !== 0);
    const r = v >> 1;
    this.zn(r);
    return r;
  }
  private rolValue(v: number): number {
    const r = ((v << 1) | (this.p & C)) & 0xff;
    this.setFlag(C, (v & 0x80) !== 0);
    this.zn(r);
    return r;
  }
  private rorValue(v: number): number {
    const r = (v >> 1) | ((this.p & C) << 7);
    this.setFlag(C, (v & 1) !== 0);
    this.zn(r);
    return r;
  }

  // ---- 公式命令 ----
  ADC(): void { this.adcValue(this.read(this.addr)); }
  SBC(): void { this.adcValue(this.read(this.addr) ^ 0xff); }
  AND(): void { this.a &= this.read(this.addr); this.zn(this.a); }
  ORA(): void { this.a |= this.read(this.addr); this.zn(this.a); }
  EOR(): void { this.a ^= this.read(this.addr); this.zn(this.a); }
  ASL(): void { this.store(this.aslValue(this.operand())); }
  LSR(): void { this.store(this.lsrValue(this.operand())); }
  ROL(): void { this.store(this.rolValue(this.operand())); }
  ROR(): void { this.store(this.rorValue(this.operand())); }
  BIT(): void {
    const v = this.read(this.addr);
    this.p = (this.p & ~(Z | V | N)) | ((this.a & v) === 0 ? Z : 0) | (v & (V | N));
  }
  BCC(): void { this.branch(!(this.p & C)); }
  BCS(): void { this.branch((this.p & C) !== 0); }
  BNE(): void { this.branch(!(this.p & Z)); }
  BEQ(): void { this.branch((this.p & Z) !== 0); }
  BPL(): void { this.branch(!(this.p & N)); }
  BMI(): void { this.branch((this.p & N) !== 0); }
  BVC(): void { this.branch(!(this.p & V)); }
  BVS(): void { this.branch((this.p & V) !== 0); }
  BRK(): void {
    this.push16((this.pc + 1) & 0xffff);
    this.push(this.p | B | U);
    this.p |= I;
    this.pc = this.read16(0xfffe);
  }
  CLC(): void { this.p &= ~C; }
  CLD(): void { this.p &= ~D; }
  CLI(): void { this.p &= ~I; }
  CLV(): void { this.p &= ~V; }
  SEC(): void { this.p |= C; }
  SED(): void { this.p |= D; }
  SEI(): void { this.p |= I; }
  CMP(): void { this.compare(this.a, this.read(this.addr)); }
  CPX(): void { this.compare(this.x, this.read(this.addr)); }
  CPY(): void { this.compare(this.y, this.read(this.addr)); }
  DEC(): void { const v = (this.read(this.addr) - 1) & 0xff; this.write(this.addr, v); this.zn(v); }
  INC(): void { const v = (this.read(this.addr) + 1) & 0xff; this.write(this.addr, v); this.zn(v); }
  DEX(): void { this.x = (this.x - 1) & 0xff; this.zn(this.x); }
  DEY(): void { this.y = (this.y - 1) & 0xff; this.zn(this.y); }
  INX(): void { this.x = (this.x + 1) & 0xff; this.zn(this.x); }
  INY(): void { this.y = (this.y + 1) & 0xff; this.zn(this.y); }
  JMP(): void { this.pc = this.addr; }
  JSR(): void { this.push16((this.pc - 1) & 0xffff); this.pc = this.addr; }
  RTS(): void { this.pc = (this.pop16() + 1) & 0xffff; }
  RTI(): void { this.p = (this.pop() & ~B) | U; this.pc = this.pop16(); }
  LDA(): void { this.a = this.read(this.addr); this.zn(this.a); }
  LDX(): void { this.x = this.read(this.addr); this.zn(this.x); }
  LDY(): void { this.y = this.read(this.addr); this.zn(this.y); }
  STA(): void { this.write(this.addr, this.a); }
  STX(): void { this.write(this.addr, this.x); }
  STY(): void { this.write(this.addr, this.y); }
  NOP(): void {}
  PHA(): void { this.push(this.a); }
  PHP(): void { this.push(this.p | B | U); }
  PLA(): void { this.a = this.pop(); this.zn(this.a); }
  PLP(): void { this.p = (this.pop() & ~B) | U; }
  TAX(): void { this.x = this.a; this.zn(this.x); }
  TAY(): void { this.y = this.a; this.zn(this.y); }
  TSX(): void { this.x = this.sp; this.zn(this.x); }
  TXA(): void { this.a = this.x; this.zn(this.a); }
  TXS(): void { this.sp = this.x; }
  TYA(): void { this.a = this.y; this.zn(this.a); }

  // ---- 非公式命令（一部のゲームが使う） ----
  LAX(): void { this.a = this.x = this.read(this.addr); this.zn(this.a); }
  SAX(): void { this.write(this.addr, this.a & this.x); }
  DCP(): void { const v = (this.read(this.addr) - 1) & 0xff; this.write(this.addr, v); this.compare(this.a, v); }
  ISB(): void { const v = (this.read(this.addr) + 1) & 0xff; this.write(this.addr, v); this.adcValue(v ^ 0xff); }
  SLO(): void { const v = this.aslValue(this.read(this.addr)); this.write(this.addr, v); this.a |= v; this.zn(this.a); }
  RLA(): void { const v = this.rolValue(this.read(this.addr)); this.write(this.addr, v); this.a &= v; this.zn(this.a); }
  SRE(): void { const v = this.lsrValue(this.read(this.addr)); this.write(this.addr, v); this.a ^= v; this.zn(this.a); }
  RRA(): void { const v = this.rorValue(this.read(this.addr)); this.write(this.addr, v); this.adcValue(v); }
  ANC(): void { this.a &= this.read(this.addr); this.zn(this.a); this.setFlag(C, (this.a & 0x80) !== 0); }
  ALR(): void { this.a = this.lsrValue(this.a & this.read(this.addr)); }
  ARR(): void {
    this.a = ((this.a & this.read(this.addr)) >> 1) | ((this.p & C) << 7);
    this.zn(this.a);
    this.setFlag(C, (this.a & 0x40) !== 0);
    this.setFlag(V, (((this.a >> 6) ^ (this.a >> 5)) & 1) !== 0);
  }
  AXS(): void {
    const r = (this.a & this.x) - this.read(this.addr);
    this.setFlag(C, r >= 0);
    this.x = r & 0xff;
    this.zn(this.x);
  }
  // 不安定な命令。チップによって (A | 定数) & 値 の定数が違う。テスト ROM が期待する $FF（= LAX #値）にする
  LXA(): void { this.a = this.x = this.read(this.addr); this.zn(this.a); }
  JAM(): void { this.jammed = true; this.pc = (this.pc - 1) & 0xffff; }

  // 書き込む値に「元のアドレスの上位バイト + 1」が AND される不安定な命令。
  // ページをまたぐと、書き込み先の上位バイトも書く値になる
  private storeHighAnd(value: number, index: number): void {
    const base = (this.addr - index) & 0xffff;
    const v = value & (((base >> 8) + 1) & 0xff);
    const addr = this.crossed ? (v << 8) | (this.addr & 0xff) : this.addr;
    this.write(addr, v);
  }
  SHY(): void { this.storeHighAnd(this.y, this.x); }
  SHX(): void { this.storeHighAnd(this.x, this.y); }
  SHA(): void { this.storeHighAnd(this.a & this.x, this.y); }
  TAS(): void { this.sp = this.a & this.x; this.storeHighAnd(this.sp, this.y); }
  LAS(): void { this.a = this.x = this.sp = this.read(this.addr) & this.sp; this.zn(this.a); }
  ANE(): void { this.a = this.x & this.read(this.addr); this.zn(this.a); }

  // ---- デバッグ ----
  /** nestest.log と同じ並びの 1 行（逆アセンブルのオペランド表示は省略） */
  trace(): string {
    const op = OPS[this.read(this.pc)];
    const len = MODE_LEN[op.mode];
    const bytes: string[] = [];
    for (let i = 0; i < len; i++) bytes.push(hex(this.read((this.pc + i) & 0xffff), 2));
    return (
      `${hex(this.pc, 4)}  ${bytes.join(' ').padEnd(8)}  ${op.name.padEnd(4)}` +
      `A:${hex(this.a, 2)} X:${hex(this.x, 2)} Y:${hex(this.y, 2)} P:${hex(this.p, 2)} SP:${hex(this.sp, 2)} CYC:${this.cycles}`
    );
  }
}

export function hex(v: number, w: number): string {
  return v.toString(16).toUpperCase().padStart(w, '0');
}

// ---- 命令表 ----
type Name = {
  [K in keyof Cpu]: Cpu[K] extends () => void ? (K extends Uppercase<K & string> ? K : never) : never;
}[keyof Cpu];

const OPS: Op[] = new Array(256);

/** 1 つの命令を複数のオペコードに登録する。entries は [オペコード, モード, サイクル, ページ跨ぎ+1?] */
function def(name: Name, entries: [number, number, number, boolean?][]): void {
  const exec: Exec = (c) => c[name]();
  for (const [code, mode, cycles, pagePenalty] of entries) {
    OPS[code] = { name, mode, cycles, pagePenalty: pagePenalty ?? false, exec };
  }
}

/** ORA/AND/EOR/ADC/LDA/CMP/SBC のような 8 モードある読み出し命令 */
function alu(name: Name, base: number): void {
  def(name, [
    [base + 0x09, IMM, 2], [base + 0x05, ZP, 3], [base + 0x15, ZPX, 4], [base + 0x0d, ABS, 4],
    [base + 0x1d, ABX, 4, true], [base + 0x19, ABY, 4, true], [base + 0x01, IZX, 6], [base + 0x11, IZY, 5, true],
  ]);
}
/** ASL/ROL/LSR/ROR */
function shift(name: Name, base: number): void {
  def(name, [[base + 0x0a, ACC, 2], [base + 0x06, ZP, 5], [base + 0x16, ZPX, 6], [base + 0x0e, ABS, 6], [base + 0x1e, ABX, 7]]);
}
/** SLO/RLA/SRE/RRA/DCP/ISB（非公式の RMW 命令） */
function rmw(name: Name, base: number): void {
  def(name, [
    [base + 0x07, ZP, 5], [base + 0x17, ZPX, 6], [base + 0x0f, ABS, 6], [base + 0x1f, ABX, 7],
    [base + 0x1b, ABY, 7], [base + 0x03, IZX, 8], [base + 0x13, IZY, 8],
  ]);
}

alu('ORA', 0x00); alu('AND', 0x20); alu('EOR', 0x40); alu('ADC', 0x60);
alu('LDA', 0xa0); alu('CMP', 0xc0); alu('SBC', 0xe0);
def('STA', [[0x85, ZP, 3], [0x95, ZPX, 4], [0x8d, ABS, 4], [0x9d, ABX, 5], [0x99, ABY, 5], [0x81, IZX, 6], [0x91, IZY, 6]]);
shift('ASL', 0x00); shift('ROL', 0x20); shift('LSR', 0x40); shift('ROR', 0x60);
def('DEC', [[0xc6, ZP, 5], [0xd6, ZPX, 6], [0xce, ABS, 6], [0xde, ABX, 7]]);
def('INC', [[0xe6, ZP, 5], [0xf6, ZPX, 6], [0xee, ABS, 6], [0xfe, ABX, 7]]);
def('LDX', [[0xa2, IMM, 2], [0xa6, ZP, 3], [0xb6, ZPY, 4], [0xae, ABS, 4], [0xbe, ABY, 4, true]]);
def('LDY', [[0xa0, IMM, 2], [0xa4, ZP, 3], [0xb4, ZPX, 4], [0xac, ABS, 4], [0xbc, ABX, 4, true]]);
def('STX', [[0x86, ZP, 3], [0x96, ZPY, 4], [0x8e, ABS, 4]]);
def('STY', [[0x84, ZP, 3], [0x94, ZPX, 4], [0x8c, ABS, 4]]);
def('CPX', [[0xe0, IMM, 2], [0xe4, ZP, 3], [0xec, ABS, 4]]);
def('CPY', [[0xc0, IMM, 2], [0xc4, ZP, 3], [0xcc, ABS, 4]]);
def('BIT', [[0x24, ZP, 3], [0x2c, ABS, 4]]);
def('JMP', [[0x4c, ABS, 3], [0x6c, IND, 5]]);
def('JSR', [[0x20, ABS, 6]]);
def('BPL', [[0x10, REL, 2]]); def('BMI', [[0x30, REL, 2]]); def('BVC', [[0x50, REL, 2]]); def('BVS', [[0x70, REL, 2]]);
def('BCC', [[0x90, REL, 2]]); def('BCS', [[0xb0, REL, 2]]); def('BNE', [[0xd0, REL, 2]]); def('BEQ', [[0xf0, REL, 2]]);
const implied: [Name, number, number][] = [
  ['BRK', 0x00, 7], ['RTI', 0x40, 6], ['RTS', 0x60, 6],
  ['PHP', 0x08, 3], ['PLP', 0x28, 4], ['PHA', 0x48, 3], ['PLA', 0x68, 4],
  ['CLC', 0x18, 2], ['SEC', 0x38, 2], ['CLI', 0x58, 2], ['SEI', 0x78, 2], ['CLV', 0xb8, 2], ['CLD', 0xd8, 2], ['SED', 0xf8, 2],
  ['DEY', 0x88, 2], ['TYA', 0x98, 2], ['TAY', 0xa8, 2], ['INY', 0xc8, 2], ['INX', 0xe8, 2],
  ['TXA', 0x8a, 2], ['TXS', 0x9a, 2], ['TAX', 0xaa, 2], ['TSX', 0xba, 2], ['DEX', 0xca, 2], ['NOP', 0xea, 2],
];
for (const [name, code, cycles] of implied) def(name, [[code, IMP, cycles]]);

// 非公式
rmw('SLO', 0x00); rmw('RLA', 0x20); rmw('SRE', 0x40); rmw('RRA', 0x60); rmw('DCP', 0xc0); rmw('ISB', 0xe0);
def('LAX', [[0xa7, ZP, 3], [0xb7, ZPY, 4], [0xaf, ABS, 4], [0xbf, ABY, 4, true], [0xa3, IZX, 6], [0xb3, IZY, 5, true]]);
def('SAX', [[0x87, ZP, 3], [0x97, ZPY, 4], [0x8f, ABS, 4], [0x83, IZX, 6]]);
def('SBC', [[0xeb, IMM, 2]]);
def('ANC', [[0x0b, IMM, 2], [0x2b, IMM, 2]]);
def('ALR', [[0x4b, IMM, 2]]);
def('ARR', [[0x6b, IMM, 2]]);
def('AXS', [[0xcb, IMM, 2]]);
def('LXA', [[0xab, IMM, 2]]);
def('ANE', [[0x8b, IMM, 2]]);
def('SHY', [[0x9c, ABX, 5]]);
def('SHX', [[0x9e, ABY, 5]]);
def('SHA', [[0x9f, ABY, 5], [0x93, IZY, 6]]);
def('TAS', [[0x9b, ABY, 5]]);
def('LAS', [[0xbb, ABY, 4, true]]);
def('NOP', [
  [0x1a, IMP, 2], [0x3a, IMP, 2], [0x5a, IMP, 2], [0x7a, IMP, 2], [0xda, IMP, 2], [0xfa, IMP, 2],
  [0x80, IMM, 2], [0x82, IMM, 2], [0x89, IMM, 2], [0xc2, IMM, 2], [0xe2, IMM, 2],
  [0x04, ZP, 3], [0x44, ZP, 3], [0x64, ZP, 3],
  [0x14, ZPX, 4], [0x34, ZPX, 4], [0x54, ZPX, 4], [0x74, ZPX, 4], [0xd4, ZPX, 4], [0xf4, ZPX, 4],
  [0x0c, ABS, 4],
  [0x1c, ABX, 4, true], [0x3c, ABX, 4, true], [0x5c, ABX, 4, true], [0x7c, ABX, 4, true], [0xdc, ABX, 4, true], [0xfc, ABX, 4, true],
]);
// 残り（JAM）は CPU を止める
for (let i = 0; i < 256; i++) {
  if (!OPS[i]) OPS[i] = { name: 'JAM', mode: IMP, cycles: 2, pagePenalty: false, exec: (c) => c.JAM() };
}
