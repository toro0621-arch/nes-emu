// ゲームボーイアドバンスの CPU（ARM7TDMI）。32 ビットの ARM 命令と 16 ビットの Thumb 命令を実行する。
// レジスタは Int32Array に入れ、計算は 32 ビット整数として扱う（符号なしが要るところは >>> 0）

/** CPU から見たバス（メモリと時間） */
export interface ArmBus {
  /** 経過したクロック数（メモリの読み書きでも増える） */
  cycles: number;
  /** ここまで実行したら止まる（途中で予定が変わると早まる） */
  stopAt: number;
  /** IME・IE・IF から割り込みを受けられる状態か */
  irqReady: boolean;
  /** IE & IF が 0 でない（HALT から戻る） */
  irqWaiting(): boolean;
  fetch16(a: number): number;
  fetch32(a: number): number;
  /** 分岐したときの命令の読み直しの時間 */
  branchCost(a: number, thumb: number): number;
  read8(a: number): number;
  read16(a: number): number;
  read32(a: number): number;
  write8(a: number, v: number): void;
  write16(a: number, v: number): void;
  write32(a: number, v: number): void;
}

export const MODE_USR = 0x10;
export const MODE_FIQ = 0x11;
export const MODE_IRQ = 0x12;
export const MODE_SVC = 0x13;
export const MODE_ABT = 0x17;
export const MODE_UND = 0x1b;
export const MODE_SYS = 0x1f;

/** モードごとのレジスタバンクの番号（0 = ユーザー・システム） */
function bankOf(mode: number): number {
  switch (mode) {
    case MODE_FIQ:
      return 1;
    case MODE_IRQ:
      return 2;
    case MODE_SVC:
      return 3;
    case MODE_ABT:
      return 4;
    case MODE_UND:
      return 5;
  }
  return 0;
}

/** 条件コード × NZCV → 実行するか */
const COND = new Uint8Array(256);
for (let cond = 0; cond < 16; cond++) {
  for (let f = 0; f < 16; f++) {
    const n = (f >> 3) & 1;
    const z = (f >> 2) & 1;
    const c = (f >> 1) & 1;
    const v = f & 1;
    let ok = false;
    switch (cond) {
      case 0: ok = z === 1; break;
      case 1: ok = z === 0; break;
      case 2: ok = c === 1; break;
      case 3: ok = c === 0; break;
      case 4: ok = n === 1; break;
      case 5: ok = n === 0; break;
      case 6: ok = v === 1; break;
      case 7: ok = v === 0; break;
      case 8: ok = c === 1 && z === 0; break;
      case 9: ok = c === 0 || z === 1; break;
      case 10: ok = n === v; break;
      case 11: ok = n !== v; break;
      case 12: ok = z === 0 && n === v; break;
      case 13: ok = z === 1 || n !== v; break;
      case 14: ok = true; break;
      default: ok = false;
    }
    COND[(cond << 4) | f] = ok ? 1 : 0;
  }
}

type Handler = (c: Arm7, op: number) => void;

export class Arm7 {
  /** r0〜r15。実行中の r15 は「命令のアドレス + 8（Thumb は + 4）」 */
  r = new Int32Array(16);
  /** 次に実行する命令のアドレス */
  pc = 0;
  n = 0;
  z = 0;
  c = 0;
  v = 0;
  /** IRQ 禁止・FIQ 禁止・Thumb */
  iflag = 1;
  fflag = 1;
  t = 0;
  mode = MODE_SVC;
  /** モードごとの r13・r14 */
  banks = new Int32Array(12);
  usrHigh = new Int32Array(5);
  fiqHigh = new Int32Array(5);
  spsrs = new Int32Array(6);
  halted = false;
  /** シフタのキャリー（命令の途中で使う） */
  shc = 0;

  constructor(public bus: ArmBus) {}

  getCpsr(): number {
    return (
      ((this.n << 31) | (this.z << 30) | (this.c << 29) | (this.v << 28) | (this.iflag << 7) | (this.fflag << 6) | (this.t << 5) | this.mode) | 0
    );
  }

  setCpsr(v: number): void {
    this.n = (v >>> 31) & 1;
    this.z = (v >>> 30) & 1;
    this.c = (v >>> 29) & 1;
    this.v = (v >>> 28) & 1;
    this.iflag = (v >>> 7) & 1;
    this.fflag = (v >>> 6) & 1;
    this.t = (v >>> 5) & 1;
    this.setMode(v & 0x1f);
  }

  get spsr(): number {
    const b = bankOf(this.mode);
    return b ? this.spsrs[b] : this.getCpsr();
  }

  set spsr(v: number) {
    const b = bankOf(this.mode);
    if (b) this.spsrs[b] = v;
  }

  setMode(m: number): void {
    const ob = bankOf(this.mode);
    const nb = bankOf(m);
    if (ob !== nb) {
      const r = this.r;
      this.banks[ob * 2] = r[13];
      this.banks[ob * 2 + 1] = r[14];
      if (ob === 1) {
        this.fiqHigh.set(r.subarray(8, 13));
        r.set(this.usrHigh, 8);
      }
      if (nb === 1) {
        this.usrHigh.set(r.subarray(8, 13));
        r.set(this.fiqHigh, 8);
      }
      r[13] = this.banks[nb * 2];
      r[14] = this.banks[nb * 2 + 1];
    }
    this.mode = m;
  }

  /** 指定したモードの r13 を設定する（起動時用） */
  setBankedSp(mode: number, sp: number): void {
    if (bankOf(mode) === bankOf(this.mode)) this.r[13] = sp;
    else this.banks[bankOf(mode) * 2] = sp;
  }

  nzcv(): number {
    return (this.n << 3) | (this.z << 2) | (this.c << 1) | this.v;
  }

  /** r15 に書いたとき（分岐） */
  branch(a: number): void {
    this.pc = this.t ? a & ~1 : a & ~3;
    this.bus.cycles += this.bus.branchCost(this.pc, this.t);
  }

  exception(vector: number, mode: number, lr: number): void {
    const cpsr = this.getCpsr();
    this.setMode(mode);
    this.spsrs[bankOf(mode)] = cpsr;
    this.r[14] = lr;
    this.iflag = 1;
    if (mode === MODE_FIQ) this.fflag = 1;
    this.t = 0;
    this.branch(vector);
  }

  irq(): void {
    this.exception(0x18, MODE_IRQ, this.pc + 4);
  }

  /** bus.stopAt クロックまで実行する */
  run(): void {
    const b = this.bus;
    while (b.cycles < b.stopAt) {
      if (this.halted) {
        if (b.irqWaiting()) this.halted = false;
        else {
          b.cycles = b.stopAt;
          return;
        }
      }
      if (b.irqReady && !this.iflag) this.irq();
      const pc = this.pc;
      if (this.t) {
        const op = b.fetch16(pc);
        this.pc = pc + 2;
        this.r[15] = pc + 4;
        THUMB[op >>> 6](this, op);
      } else {
        const op = b.fetch32(pc);
        this.pc = pc + 4;
        this.r[15] = pc + 8;
        const cond = op >>> 28;
        if (cond === 14 || COND[(cond << 4) | this.nzcv()]) ARM[((op >>> 16) & 0xff0) | ((op >>> 4) & 0xf)](this, op);
      }
    }
  }

  /** 1 命令だけ実行（テスト用） */
  step(): void {
    this.bus.stopAt = this.bus.cycles + 1;
    this.run();
  }
}

// ───────── シフタ ─────────

/** 即値でシフト（LSR #0 は #32、ASR #0 は #32、ROR #0 は RRX） */
function shiftImm(c: Arm7, v: number, type: number, amt: number): number {
  switch (type) {
    case 0:
      if (amt === 0) {
        c.shc = c.c;
        return v;
      }
      c.shc = (v >>> (32 - amt)) & 1;
      return v << amt;
    case 1:
      if (amt === 0) {
        c.shc = v >>> 31;
        return 0;
      }
      c.shc = (v >>> (amt - 1)) & 1;
      return (v >>> amt) | 0;
    case 2:
      if (amt === 0) {
        c.shc = v >>> 31;
        return v >> 31;
      }
      c.shc = (v >> (amt - 1)) & 1;
      return v >> amt;
    default:
      if (amt === 0) {
        c.shc = v & 1;
        return (v >>> 1) | (c.c << 31);
      }
      c.shc = (v >>> (amt - 1)) & 1;
      return (v >>> amt) | (v << (32 - amt));
  }
}

/** レジスタの値でシフト（下位 8 ビット。0 なら何もしない） */
function shiftReg(c: Arm7, v: number, type: number, amt: number): number {
  if (amt === 0) {
    c.shc = c.c;
    return v;
  }
  switch (type) {
    case 0:
      if (amt < 32) {
        c.shc = (v >>> (32 - amt)) & 1;
        return v << amt;
      }
      c.shc = amt === 32 ? v & 1 : 0;
      return 0;
    case 1:
      if (amt < 32) {
        c.shc = (v >>> (amt - 1)) & 1;
        return (v >>> amt) | 0;
      }
      c.shc = amt === 32 ? v >>> 31 : 0;
      return 0;
    case 2:
      if (amt < 32) {
        c.shc = (v >> (amt - 1)) & 1;
        return v >> amt;
      }
      c.shc = v >>> 31;
      return v >> 31;
    default:
      amt &= 31;
      if (amt === 0) {
        c.shc = v >>> 31;
        return v;
      }
      c.shc = (v >>> (amt - 1)) & 1;
      return (v >>> amt) | (v << (32 - amt));
  }
}

// ───────── 演算（フラグを立てる） ─────────

function addFlags(c: Arm7, a: number, b: number, carry: number): number {
  const sum = (a >>> 0) + (b >>> 0) + carry;
  const res = sum | 0;
  c.n = res >>> 31;
  c.z = res === 0 ? 1 : 0;
  c.c = sum > 0xffffffff ? 1 : 0;
  c.v = (~(a ^ b) & (a ^ res)) >>> 31;
  return res;
}

/** a - b - (1 - carry) */
function subFlags(c: Arm7, a: number, b: number, carry: number): number {
  const res = (a - b - (1 - carry)) | 0;
  c.n = res >>> 31;
  c.z = res === 0 ? 1 : 0;
  c.c = a >>> 0 >= (b >>> 0) + (1 - carry) ? 1 : 0;
  c.v = ((a ^ b) & (a ^ res)) >>> 31;
  return res;
}

function logicFlags(c: Arm7, res: number): void {
  c.n = res >>> 31;
  c.z = res === 0 ? 1 : 0;
  c.c = c.shc;
}

/** 32 × 32 → 64 ビットの掛け算。結果は mulHi・mulLo */
let mulHi = 0;
let mulLo = 0;
function mul64(a: number, b: number, signed: boolean): void {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const p11 = a1 * b1;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  mulLo = (mid << 16) | (p00 & 0xffff);
  let hi = p11 + Math.floor(p01 / 65536) + Math.floor(p10 / 65536) + (mid >>> 16);
  if (signed) {
    if (a < 0) hi -= b >>> 0;
    if (b < 0) hi -= a >>> 0;
  }
  mulHi = hi | 0;
}

/** 掛け算の内部サイクル（掛ける数の大きさで決まる） */
function mulCycles(rs: number): number {
  if ((rs & 0xffffff00) === 0 || (rs & 0xffffff00) === 0xffffff00 >> 0) return 1;
  if ((rs & 0xffff0000) === 0 || (rs >> 16) === -1) return 2;
  if ((rs & 0xff000000) === 0 || (rs >> 24) === -1) return 3;
  return 4;
}

// ───────── メモリの読み書き（ずれたアドレスの扱いを含む） ─────────

function ldr(c: Arm7, a: number): number {
  const v = c.bus.read32(a);
  const rot = (a & 3) << 3;
  return rot ? (v >>> rot) | (v << (32 - rot)) : v;
}

function ldrh(c: Arm7, a: number): number {
  const v = c.bus.read16(a);
  return a & 1 ? ((v >>> 8) | (v << 24)) | 0 : v;
}

function ldrsh(c: Arm7, a: number): number {
  if (a & 1) return (c.bus.read8(a) << 24) >> 24;
  return (c.bus.read16(a) << 16) >> 16;
}

// ───────── ARM 命令 ─────────

function armUndefined(c: Arm7): void {
  c.exception(0x04, MODE_UND, c.pc);
}

function armNop(): void {}

function armDataProc(c: Arm7, op: number): void {
  // 第 2 オペランド
  let b: number;
  let a: number;
  const rn = (op >>> 16) & 15;
  if (op & 0x02000000) {
    const imm = op & 0xff;
    const rot = (op >>> 7) & 0x1e;
    if (rot) {
      b = (imm >>> rot) | (imm << (32 - rot));
      c.shc = b >>> 31;
    } else {
      b = imm;
      c.shc = c.c;
    }
    a = c.r[rn];
  } else if (op & 0x10) {
    // レジスタの値でシフト（このとき r15 は + 12 に見える）
    c.bus.cycles += 1;
    const rm = op & 15;
    const v = rm === 15 ? c.r[15] + 4 : c.r[rm];
    b = shiftReg(c, v, (op >>> 5) & 3, c.r[(op >>> 8) & 15] & 0xff);
    a = rn === 15 ? c.r[15] + 4 : c.r[rn];
  } else {
    b = shiftImm(c, c.r[op & 15], (op >>> 5) & 3, (op >>> 7) & 31);
    a = c.r[rn];
  }

  const s = op & 0x100000;
  const rd = (op >>> 12) & 15;
  let res = 0;
  switch ((op >>> 21) & 15) {
    case 0:
      res = a & b;
      if (s) logicFlags(c, res);
      break;
    case 1:
      res = a ^ b;
      if (s) logicFlags(c, res);
      break;
    case 2:
      res = s ? subFlags(c, a, b, 1) : (a - b) | 0;
      break;
    case 3:
      res = s ? subFlags(c, b, a, 1) : (b - a) | 0;
      break;
    case 4:
      res = s ? addFlags(c, a, b, 0) : (a + b) | 0;
      break;
    case 5:
      res = s ? addFlags(c, a, b, c.c) : (a + b + c.c) | 0;
      break;
    case 6:
      res = s ? subFlags(c, a, b, c.c) : (a - b - (1 - c.c)) | 0;
      break;
    case 7:
      res = s ? subFlags(c, b, a, c.c) : (b - a - (1 - c.c)) | 0;
      break;
    case 8:
      logicFlags(c, a & b);
      if (rd === 15) c.setCpsr(c.spsr);
      return;
    case 9:
      logicFlags(c, a ^ b);
      if (rd === 15) c.setCpsr(c.spsr);
      return;
    case 10:
      subFlags(c, a, b, 1);
      if (rd === 15) c.setCpsr(c.spsr);
      return;
    case 11:
      addFlags(c, a, b, 0);
      if (rd === 15) c.setCpsr(c.spsr);
      return;
    case 12:
      res = a | b;
      if (s) logicFlags(c, res);
      break;
    case 13:
      res = b;
      if (s) logicFlags(c, res);
      break;
    case 14:
      res = a & ~b;
      if (s) logicFlags(c, res);
      break;
    case 15:
      res = ~b;
      if (s) logicFlags(c, res);
      break;
  }
  if (rd === 15) {
    // S 付きで r15 に書くと、SPSR を CPSR に戻す（例外からの復帰）
    if (s) c.setCpsr(c.spsr);
    c.branch(res);
  } else c.r[rd] = res;
}

function armMrs(c: Arm7, op: number): void {
  c.r[(op >>> 12) & 15] = op & 0x400000 ? c.spsr : c.getCpsr();
}

function armMsr(c: Arm7, op: number): void {
  let v: number;
  if (op & 0x02000000) {
    const imm = op & 0xff;
    const rot = (op >>> 7) & 0x1e;
    v = rot ? (imm >>> rot) | (imm << (32 - rot)) : imm;
  } else v = c.r[op & 15];
  let mask = 0;
  if (op & 0x80000) mask |= 0xff000000;
  if (op & 0x40000) mask |= 0xff0000;
  if (op & 0x20000) mask |= 0xff00;
  if (op & 0x10000) mask |= 0xff;
  if (op & 0x400000) {
    c.spsr = (c.spsr & ~mask) | (v & mask);
  } else {
    if (c.mode === MODE_USR) mask &= 0xff000000;
    const t = c.t;
    c.setCpsr((c.getCpsr() & ~mask) | (v & mask));
    c.t = t;
  }
}

function armBx(c: Arm7, op: number): void {
  const v = c.r[op & 15];
  c.t = v & 1;
  c.branch(v);
}

function armMul(c: Arm7, op: number): void {
  const rd = (op >>> 16) & 15;
  const rs = c.r[(op >>> 8) & 15];
  let res = Math.imul(c.r[op & 15], rs);
  if (op & 0x200000) {
    res = (res + c.r[(op >>> 12) & 15]) | 0;
    c.bus.cycles += 1;
  }
  c.bus.cycles += mulCycles(rs);
  if (op & 0x100000) {
    c.n = res >>> 31;
    c.z = res === 0 ? 1 : 0;
  }
  c.r[rd] = res;
}

function armMull(c: Arm7, op: number): void {
  const hiR = (op >>> 16) & 15;
  const loR = (op >>> 12) & 15;
  const signed = (op & 0x400000) !== 0;
  const rs = c.r[(op >>> 8) & 15];
  mul64(c.r[op & 15], rs, signed);
  let hi = mulHi;
  let lo = mulLo;
  c.bus.cycles += mulCycles(signed ? rs : rs & 0x7fffffff ? rs : rs) + 1;
  if (op & 0x200000) {
    const sum = (lo >>> 0) + (c.r[loR] >>> 0);
    lo = sum | 0;
    hi = (hi + c.r[hiR] + (sum > 0xffffffff ? 1 : 0)) | 0;
    c.bus.cycles += 1;
  }
  if (op & 0x100000) {
    c.n = hi >>> 31;
    c.z = hi === 0 && lo === 0 ? 1 : 0;
  }
  c.r[loR] = lo;
  c.r[hiR] = hi;
}

function armSwp(c: Arm7, op: number): void {
  const a = c.r[(op >>> 16) & 15];
  const src = c.r[op & 15];
  let v: number;
  if (op & 0x400000) {
    v = c.bus.read8(a);
    c.bus.write8(a, src & 0xff);
  } else {
    v = ldr(c, a);
    c.bus.write32(a, src);
  }
  c.bus.cycles += 1;
  c.r[(op >>> 12) & 15] = v;
}

/** LDRH・STRH・LDRSB・LDRSH */
function armHalf(c: Arm7, op: number): void {
  const rn = (op >>> 16) & 15;
  const rd = (op >>> 12) & 15;
  const off = op & 0x400000 ? ((op >>> 4) & 0xf0) | (op & 0xf) : c.r[op & 15];
  const base = c.r[rn];
  const up = op & 0x800000;
  const pre = op & 0x1000000;
  const moved = up ? (base + off) | 0 : (base - off) | 0;
  const addr = pre ? moved : base;
  const wb = !pre || op & 0x200000;
  const sh = (op >>> 5) & 3;
  if (op & 0x100000) {
    let v: number;
    if (sh === 1) v = ldrh(c, addr);
    else if (sh === 2) v = (c.bus.read8(addr) << 24) >> 24;
    else v = ldrsh(c, addr);
    c.bus.cycles += 1;
    if (wb) c.r[rn] = moved;
    if (rd === 15) c.branch(v);
    else c.r[rd] = v;
  } else {
    if (sh === 1) c.bus.write16(addr, (rd === 15 ? c.r[15] + 4 : c.r[rd]) & 0xffff);
    if (wb) c.r[rn] = moved;
  }
}

/** LDR・STR・LDRB・STRB */
function armSingle(c: Arm7, op: number): void {
  const rn = (op >>> 16) & 15;
  const rd = (op >>> 12) & 15;
  let off: number;
  if (op & 0x02000000) off = shiftImm(c, c.r[op & 15], (op >>> 5) & 3, (op >>> 7) & 31);
  else off = op & 0xfff;
  const base = c.r[rn];
  const moved = op & 0x800000 ? (base + off) | 0 : (base - off) | 0;
  const pre = op & 0x1000000;
  const addr = pre ? moved : base;
  const wb = !pre || op & 0x200000;
  if (op & 0x100000) {
    const v = op & 0x400000 ? c.bus.read8(addr) : ldr(c, addr);
    c.bus.cycles += 1;
    if (wb) c.r[rn] = moved;
    if (rd === 15) c.branch(v);
    else c.r[rd] = v;
  } else {
    const v = rd === 15 ? c.r[15] + 4 : c.r[rd];
    if (op & 0x400000) c.bus.write8(addr, v & 0xff);
    else c.bus.write32(addr, v);
    if (wb) c.r[rn] = moved;
  }
}

/** LDM・STM */
function armBlock(c: Arm7, op: number): void {
  const rn = (op >>> 16) & 15;
  let list = op & 0xffff;
  const load = op & 0x100000;
  const w = op & 0x200000;
  const s = op & 0x400000;
  const up = op & 0x800000;
  const pre = op & 0x1000000;
  let count = 0;
  for (let i = list; i; i &= i - 1) count++;
  if (!list) {
    // 空のリスト：r15 を転送し、ベースは 0x40 動く
    list = 0x8000;
    count = 16;
  }
  const base = c.r[rn];
  let addr: number;
  let newBase: number;
  if (up) {
    addr = pre ? base + 4 : base;
    newBase = (base + count * 4) | 0;
  } else {
    newBase = (base - count * 4) | 0;
    addr = pre ? newBase : newBase + 4;
  }
  addr &= ~3;
  // S 付き（r15 を読み込む LDM 以外）はユーザーモードのレジスタを転送する
  const userBank = s && !(load && list & 0x8000);
  const oldMode = c.mode;
  if (userBank) c.setMode(MODE_SYS);
  const bus = c.bus;
  if (load) {
    if (w) c.r[rn] = newBase;
    for (let i = 0; i < 16; i++) {
      if (!(list & (1 << i))) continue;
      const v = bus.read32(addr);
      addr += 4;
      if (i === 15) {
        if (s) c.setCpsr(c.spsr);
        c.branch(v);
      } else c.r[i] = v;
    }
    bus.cycles += 1;
  } else {
    let first = true;
    for (let i = 0; i < 16; i++) {
      if (!(list & (1 << i))) continue;
      bus.write32(addr, i === 15 ? c.r[15] + 4 : c.r[i]);
      addr += 4;
      // ベースがリストの最初なら元の値、そうでなければ新しい値が書かれる
      if (first && w) c.r[rn] = newBase;
      first = false;
    }
  }
  if (userBank) c.setMode(oldMode);
}

function armBranch(c: Arm7, op: number): void {
  if (op & 0x1000000) c.r[14] = c.pc;
  c.branch(c.r[15] + ((op << 8) >> 6));
}

function armSwi(c: Arm7): void {
  c.exception(0x08, MODE_SVC, c.pc);
}

const ARM: Handler[] = new Array(4096);
for (let i = 0; i < 4096; i++) {
  const hi = i >> 4;
  const lo = i & 15;
  let h: Handler = armUndefined;
  switch (hi >> 5) {
    case 0:
      if (lo === 9) {
        if ((hi & 0xfc) === 0) h = armMul;
        else if ((hi & 0xf8) === 0x08) h = armMull;
        else if ((hi & 0xfb) === 0x10) h = armSwp;
      } else if ((lo & 9) === 9) h = armHalf;
      else if (hi === 0x12 && lo === 1) h = armBx;
      else if ((hi & 0xfb) === 0x10) h = lo === 0 ? armMrs : armNop;
      else if ((hi & 0xfb) === 0x12) h = lo === 0 ? armMsr : armNop;
      else h = armDataProc;
      break;
    case 1:
      if ((hi & 0xfb) === 0x32) h = armMsr;
      else if ((hi & 0xfb) === 0x30) h = armNop;
      else h = armDataProc;
      break;
    case 2:
      h = armSingle;
      break;
    case 3:
      h = lo & 1 ? armUndefined : armSingle;
      break;
    case 4:
      h = armBlock;
      break;
    case 5:
      h = armBranch;
      break;
    case 6:
      h = armNop;
      break;
    case 7:
      h = hi & 0x10 ? armSwi : armNop;
      break;
  }
  ARM[i] = h;
}

// ───────── Thumb 命令 ─────────

function thShift(c: Arm7, op: number): void {
  const rd = op & 7;
  const res = shiftImm(c, c.r[(op >>> 3) & 7], (op >>> 11) & 3, (op >>> 6) & 31);
  logicFlags(c, res);
  c.r[rd] = res;
}

function thAddSub(c: Arm7, op: number): void {
  const a = c.r[(op >>> 3) & 7];
  const x = (op >>> 6) & 7;
  const b = op & 0x400 ? x : c.r[x];
  c.r[op & 7] = op & 0x200 ? subFlags(c, a, b, 1) : addFlags(c, a, b, 0);
}

function thImm(c: Arm7, op: number): void {
  const rd = (op >>> 8) & 7;
  const imm = op & 0xff;
  switch ((op >>> 11) & 3) {
    case 0:
      c.r[rd] = imm;
      c.n = 0;
      c.z = imm === 0 ? 1 : 0;
      break;
    case 1:
      subFlags(c, c.r[rd], imm, 1);
      break;
    case 2:
      c.r[rd] = addFlags(c, c.r[rd], imm, 0);
      break;
    case 3:
      c.r[rd] = subFlags(c, c.r[rd], imm, 1);
      break;
  }
}

function thAlu(c: Arm7, op: number): void {
  const rd = op & 7;
  const a = c.r[rd];
  const b = c.r[(op >>> 3) & 7];
  let res: number;
  switch ((op >>> 6) & 15) {
    case 0:
      res = a & b;
      break;
    case 1:
      res = a ^ b;
      break;
    case 2:
      c.bus.cycles += 1;
      res = shiftReg(c, a, 0, b & 0xff);
      c.c = c.shc;
      break;
    case 3:
      c.bus.cycles += 1;
      res = shiftReg(c, a, 1, b & 0xff);
      c.c = c.shc;
      break;
    case 4:
      c.bus.cycles += 1;
      res = shiftReg(c, a, 2, b & 0xff);
      c.c = c.shc;
      break;
    case 5:
      c.r[rd] = addFlags(c, a, b, c.c);
      return;
    case 6:
      c.r[rd] = subFlags(c, a, b, c.c);
      return;
    case 7:
      c.bus.cycles += 1;
      res = shiftReg(c, a, 3, b & 0xff);
      c.c = c.shc;
      break;
    case 8:
      c.n = (a & b) >>> 31;
      c.z = (a & b) === 0 ? 1 : 0;
      return;
    case 9:
      c.r[rd] = subFlags(c, 0, b, 1);
      return;
    case 10:
      subFlags(c, a, b, 1);
      return;
    case 11:
      addFlags(c, a, b, 0);
      return;
    case 12:
      res = a | b;
      break;
    case 13:
      c.bus.cycles += mulCycles(a);
      res = Math.imul(a, b);
      break;
    case 14:
      res = a & ~b;
      break;
    default:
      res = ~b;
      break;
  }
  c.n = res >>> 31;
  c.z = res === 0 ? 1 : 0;
  c.r[rd] = res;
}

function thHi(c: Arm7, op: number): void {
  const rd = (op & 7) | ((op >>> 4) & 8);
  const rs = (op >>> 3) & 15;
  const b = c.r[rs];
  switch ((op >>> 8) & 3) {
    case 0: {
      const res = (c.r[rd] + b) | 0;
      if (rd === 15) c.branch(res);
      else c.r[rd] = res;
      break;
    }
    case 1:
      subFlags(c, c.r[rd], b, 1);
      break;
    case 2:
      if (rd === 15) c.branch(b);
      else c.r[rd] = b;
      break;
    case 3:
      c.t = b & 1;
      c.branch(b);
      break;
  }
}

function thLdrPc(c: Arm7, op: number): void {
  c.r[(op >>> 8) & 7] = c.bus.read32(((c.r[15] & ~2) + ((op & 0xff) << 2)) & ~3);
  c.bus.cycles += 1;
}

function thLdStReg(c: Arm7, op: number): void {
  const addr = (c.r[(op >>> 3) & 7] + c.r[(op >>> 6) & 7]) | 0;
  const rd = op & 7;
  const bus = c.bus;
  switch ((op >>> 9) & 7) {
    case 0:
      bus.write32(addr, c.r[rd]);
      break;
    case 1:
      bus.write16(addr, c.r[rd] & 0xffff);
      break;
    case 2:
      bus.write8(addr, c.r[rd] & 0xff);
      break;
    case 3:
      c.r[rd] = (bus.read8(addr) << 24) >> 24;
      bus.cycles += 1;
      break;
    case 4:
      c.r[rd] = ldr(c, addr);
      bus.cycles += 1;
      break;
    case 5:
      c.r[rd] = ldrh(c, addr);
      bus.cycles += 1;
      break;
    case 6:
      c.r[rd] = bus.read8(addr);
      bus.cycles += 1;
      break;
    case 7:
      c.r[rd] = ldrsh(c, addr);
      bus.cycles += 1;
      break;
  }
}

function thLdStImm(c: Arm7, op: number): void {
  const rd = op & 7;
  const base = c.r[(op >>> 3) & 7];
  const off = (op >>> 6) & 31;
  const bus = c.bus;
  switch ((op >>> 11) & 3) {
    case 0:
      bus.write32((base + (off << 2)) | 0, c.r[rd]);
      break;
    case 1:
      c.r[rd] = ldr(c, (base + (off << 2)) | 0);
      bus.cycles += 1;
      break;
    case 2:
      bus.write8((base + off) | 0, c.r[rd] & 0xff);
      break;
    case 3:
      c.r[rd] = bus.read8((base + off) | 0);
      bus.cycles += 1;
      break;
  }
}

function thLdStHalf(c: Arm7, op: number): void {
  const rd = op & 7;
  const addr = (c.r[(op >>> 3) & 7] + (((op >>> 6) & 31) << 1)) | 0;
  if (op & 0x800) {
    c.r[rd] = ldrh(c, addr);
    c.bus.cycles += 1;
  } else c.bus.write16(addr, c.r[rd] & 0xffff);
}

function thLdStSp(c: Arm7, op: number): void {
  const rd = (op >>> 8) & 7;
  const addr = (c.r[13] + ((op & 0xff) << 2)) | 0;
  if (op & 0x800) {
    c.r[rd] = ldr(c, addr);
    c.bus.cycles += 1;
  } else c.bus.write32(addr, c.r[rd]);
}

function thAddr(c: Arm7, op: number): void {
  const base = op & 0x800 ? c.r[13] : c.r[15] & ~2;
  c.r[(op >>> 8) & 7] = (base + ((op & 0xff) << 2)) | 0;
}

function thSp(c: Arm7, op: number): void {
  const off = (op & 0x7f) << 2;
  c.r[13] = op & 0x80 ? (c.r[13] - off) | 0 : (c.r[13] + off) | 0;
}

function thPushPop(c: Arm7, op: number): void {
  const bus = c.bus;
  const list = op & 0xff;
  const r = op & 0x100;
  if (op & 0x800) {
    // POP
    let addr = c.r[13];
    for (let i = 0; i < 8; i++) {
      if (!(list & (1 << i))) continue;
      c.r[i] = bus.read32(addr & ~3);
      addr += 4;
    }
    if (r) {
      const v = bus.read32(addr & ~3);
      addr += 4;
      c.r[13] = addr;
      c.branch(v);
    } else if (!list) {
      // 空のリスト：r15 を読み込み、SP は 0x40 進む
      const v = bus.read32(addr & ~3);
      c.r[13] = addr + 0x40;
      c.branch(v);
    } else c.r[13] = addr;
    bus.cycles += 1;
  } else {
    // PUSH
    let count = 0;
    for (let i = list; i; i &= i - 1) count++;
    if (r) count++;
    if (!list && !r) {
      const addr = c.r[13] - 0x40;
      bus.write32(addr & ~3, c.r[15] + 2);
      c.r[13] = addr;
      return;
    }
    let addr = c.r[13] - count * 4;
    c.r[13] = addr;
    for (let i = 0; i < 8; i++) {
      if (!(list & (1 << i))) continue;
      bus.write32(addr & ~3, c.r[i]);
      addr += 4;
    }
    if (r) bus.write32(addr & ~3, c.r[14]);
  }
}

function thBlock(c: Arm7, op: number): void {
  const rb = (op >>> 8) & 7;
  const list = op & 0xff;
  const bus = c.bus;
  let addr = c.r[rb];
  if (!list) {
    // 空のリスト：r15 を転送し、ベースは 0x40 進む
    if (op & 0x800) {
      const v = bus.read32(addr & ~3);
      c.r[rb] = addr + 0x40;
      c.branch(v);
    } else {
      bus.write32(addr & ~3, c.r[15] + 2);
      c.r[rb] = addr + 0x40;
    }
    return;
  }
  let count = 0;
  for (let i = list; i; i &= i - 1) count++;
  const end = (addr + count * 4) | 0;
  if (op & 0x800) {
    for (let i = 0; i < 8; i++) {
      if (!(list & (1 << i))) continue;
      c.r[i] = bus.read32(addr & ~3);
      addr += 4;
    }
    if (!(list & (1 << rb))) c.r[rb] = end;
    bus.cycles += 1;
  } else {
    let first = true;
    for (let i = 0; i < 8; i++) {
      if (!(list & (1 << i))) continue;
      bus.write32(addr & ~3, c.r[i]);
      addr += 4;
      if (first) c.r[rb] = end;
      first = false;
    }
  }
}

function thCondBranch(c: Arm7, op: number): void {
  const cond = (op >>> 8) & 15;
  if (cond === 15) {
    c.exception(0x08, MODE_SVC, c.pc);
    return;
  }
  if (cond === 14) {
    c.exception(0x04, MODE_UND, c.pc);
    return;
  }
  if (COND[(cond << 4) | c.nzcv()]) c.branch(c.r[15] + (((op & 0xff) << 24) >> 23));
}

function thBranch(c: Arm7, op: number): void {
  c.branch(c.r[15] + (((op & 0x7ff) << 21) >> 20));
}

function thBl1(c: Arm7, op: number): void {
  c.r[14] = (c.r[15] + (((op & 0x7ff) << 21) >> 9)) | 0;
}

function thBl2(c: Arm7, op: number): void {
  const target = (c.r[14] + ((op & 0x7ff) << 1)) | 0;
  c.r[14] = c.pc | 1;
  c.branch(target);
}

function thUndefined(c: Arm7): void {
  c.exception(0x04, MODE_UND, c.pc);
}

const THUMB: Handler[] = new Array(1024);
for (let i = 0; i < 1024; i++) {
  const op = i << 6;
  let h: Handler = thUndefined;
  if ((op & 0xf800) === 0x1800) h = thAddSub;
  else if ((op & 0xe000) === 0x0000) h = thShift;
  else if ((op & 0xe000) === 0x2000) h = thImm;
  else if ((op & 0xfc00) === 0x4000) h = thAlu;
  else if ((op & 0xfc00) === 0x4400) h = thHi;
  else if ((op & 0xf800) === 0x4800) h = thLdrPc;
  else if ((op & 0xf000) === 0x5000) h = thLdStReg;
  else if ((op & 0xe000) === 0x6000) h = thLdStImm;
  else if ((op & 0xf000) === 0x8000) h = thLdStHalf;
  else if ((op & 0xf000) === 0x9000) h = thLdStSp;
  else if ((op & 0xf000) === 0xa000) h = thAddr;
  else if ((op & 0xff00) === 0xb000) h = thSp;
  else if ((op & 0xf600) === 0xb400) h = thPushPop;
  else if ((op & 0xf000) === 0xc000) h = thBlock;
  else if ((op & 0xf000) === 0xd000) h = thCondBranch;
  else if ((op & 0xf800) === 0xe000) h = thBranch;
  else if ((op & 0xf800) === 0xf000) h = thBl1;
  else if ((op & 0xf800) === 0xf800) h = thBl2;
  THUMB[i] = h;
}
