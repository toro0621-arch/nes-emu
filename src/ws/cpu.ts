// ワンダースワンの CPU（NEC V30MZ。8086 / 80186 と同じ命令が動く）

export interface WsCpuBus {
  read8(addr: number): number;
  write8(addr: number, v: number): void;
  in8(port: number): number;
  out8(port: number, v: number): void;
}

/** 偶数パリティなら 1 */
const PARITY = Uint8Array.from({ length: 256 }, (_, v) => {
  let n = v;
  n ^= n >> 4;
  n ^= n >> 2;
  n ^= n >> 1;
  return (n & 1) ^ 1;
});

// 16 ビットレジスタの番号（命令の中の並び）
const AX = 0;
const CX = 1;
const DX = 2;
const BX = 3;
const SP = 4;
const BP = 5;
const SI = 6;
const DI = 7;
// セグメントレジスタの番号
const ES = 0;
const CS = 1;
const SS = 2;
const DS = 3;

export class V30MZ {
  /** AX CX DX BX SP BP SI DI */
  readonly r = new Uint16Array(8);
  /** ES CS SS DS */
  readonly s = new Uint16Array(4);
  ip = 0;
  // フラグ（0 か 1）
  cf = 0;
  pf = 0;
  af = 0;
  zf = 0;
  sf = 0;
  tf = 0;
  ie = 0;
  df = 0;
  of = 0;

  /** 使ったクロック数（呼び出し側が差し引く） */
  cycles = 0;
  halted = false;
  /** MOV SS・POP SS・STI の直後の 1 命令は割り込みを受け付けない */
  private inhibit = false;

  // 命令ごとの一時的な状態
  private seg = -1; // セグメント・オーバーライド（なければ -1）
  private mod = 0;
  private reg = 0;
  private rm = 0;
  private eaSeg = 0; // 値（セグメントレジスタの中身）
  private eaOff = 0;

  constructor(private bus: WsCpuBus) {}

  reset(): void {
    this.r.fill(0);
    this.s.fill(0);
    this.s[CS] = 0xffff;
    this.ip = 0;
    this.r[SP] = 0x2000;
    this.setFlags(0);
    this.halted = false;
  }

  // ---- フラグ ----
  getFlags(): number {
    return (
      this.cf |
      2 |
      (this.pf << 2) |
      (this.af << 4) |
      (this.zf << 6) |
      (this.sf << 7) |
      (this.tf << 8) |
      (this.ie << 9) |
      (this.df << 10) |
      (this.of << 11) |
      0xf000
    );
  }
  setFlags(f: number): void {
    this.cf = f & 1;
    this.pf = (f >> 2) & 1;
    this.af = (f >> 4) & 1;
    this.zf = (f >> 6) & 1;
    this.sf = (f >> 7) & 1;
    this.tf = (f >> 8) & 1;
    this.ie = (f >> 9) & 1;
    this.df = (f >> 10) & 1;
    this.of = (f >> 11) & 1;
  }
  private szp8(v: number): void {
    this.sf = (v >> 7) & 1;
    this.zf = (v & 0xff) === 0 ? 1 : 0;
    this.pf = PARITY[v & 0xff];
  }
  private szp16(v: number): void {
    this.sf = (v >> 15) & 1;
    this.zf = (v & 0xffff) === 0 ? 1 : 0;
    this.pf = PARITY[v & 0xff];
  }

  // ---- メモリ ----
  private rd8(seg: number, off: number): number {
    return this.bus.read8(((seg << 4) + (off & 0xffff)) & 0xfffff);
  }
  private rd16(seg: number, off: number): number {
    if (off & 1) this.cycles++; // 奇数番地の 16 ビットは 1 クロック余分
    return this.rd8(seg, off) | (this.rd8(seg, off + 1) << 8);
  }
  private wr8(seg: number, off: number, v: number): void {
    this.bus.write8(((seg << 4) + (off & 0xffff)) & 0xfffff, v & 0xff);
  }
  private wr16(seg: number, off: number, v: number): void {
    if (off & 1) this.cycles++;
    this.wr8(seg, off, v);
    this.wr8(seg, off + 1, v >> 8);
  }
  private fetch8(): number {
    const v = this.rd8(this.s[CS], this.ip);
    this.ip = (this.ip + 1) & 0xffff;
    return v;
  }
  private fetch16(): number {
    const lo = this.fetch8();
    return lo | (this.fetch8() << 8);
  }
  private push(v: number): void {
    this.r[SP] -= 2;
    this.wr16(this.s[SS], this.r[SP], v);
  }
  private pop(): number {
    const v = this.rd16(this.s[SS], this.r[SP]);
    this.r[SP] += 2;
    return v;
  }

  // ---- 8 ビットレジスタ（AL CL DL BL AH CH DH BH） ----
  private getR8(i: number): number {
    return i < 4 ? this.r[i] & 0xff : this.r[i - 4] >> 8;
  }
  private setR8(i: number, v: number): void {
    if (i < 4) this.r[i] = (this.r[i] & 0xff00) | (v & 0xff);
    else this.r[i - 4] = (this.r[i - 4] & 0xff) | ((v & 0xff) << 8);
  }

  // ---- ModR/M ----
  private modrm(): void {
    const b = this.fetch8();
    this.mod = b >> 6;
    this.reg = (b >> 3) & 7;
    this.rm = b & 7;
    if (this.mod === 3) return;
    const r = this.r;
    let off: number;
    let seg = DS;
    switch (this.rm) {
      case 0:
        off = r[BX] + r[SI];
        break;
      case 1:
        off = r[BX] + r[DI];
        break;
      case 2:
        off = r[BP] + r[SI];
        seg = SS;
        break;
      case 3:
        off = r[BP] + r[DI];
        seg = SS;
        break;
      case 4:
        off = r[SI];
        break;
      case 5:
        off = r[DI];
        break;
      case 6:
        if (this.mod === 0) off = this.fetch16();
        else {
          off = r[BP];
          seg = SS;
        }
        break;
      default:
        off = r[BX];
    }
    if (this.mod === 1) off += (this.fetch8() << 24) >> 24;
    else if (this.mod === 2) off += this.fetch16();
    this.eaOff = off & 0xffff;
    this.eaSeg = this.s[this.seg >= 0 ? this.seg : seg];
    this.cycles += 1;
  }
  private getRM8(): number {
    return this.mod === 3 ? this.getR8(this.rm) : this.rd8(this.eaSeg, this.eaOff);
  }
  private setRM8(v: number): void {
    if (this.mod === 3) this.setR8(this.rm, v);
    else this.wr8(this.eaSeg, this.eaOff, v);
  }
  private getRM16(): number {
    return this.mod === 3 ? this.r[this.rm] : this.rd16(this.eaSeg, this.eaOff);
  }
  private setRM16(v: number): void {
    if (this.mod === 3) this.r[this.rm] = v;
    else this.wr16(this.eaSeg, this.eaOff, v);
  }
  /** データを読むときのセグメント（DS、オーバーライドがあればそれ） */
  private dataSeg(): number {
    return this.s[this.seg >= 0 ? this.seg : DS];
  }

  // ---- 演算 ----
  private alu8(op: number, a: number, b: number): number {
    let r: number;
    switch (op) {
      case 0: // ADD
      case 2: {
        // ADC
        const c = op === 2 ? this.cf : 0;
        r = a + b + c;
        this.cf = (r >> 8) & 1;
        this.of = ((a ^ r) & (b ^ r) & 0x80) >> 7;
        this.af = ((a ^ b ^ r) >> 4) & 1;
        break;
      }
      case 3: // SBB
      case 5: // SUB
      case 7: {
        // CMP
        const c = op === 3 ? this.cf : 0;
        r = a - b - c;
        this.cf = (r >> 8) & 1;
        this.of = ((a ^ b) & (a ^ r) & 0x80) >> 7;
        this.af = ((a ^ b ^ r) >> 4) & 1;
        break;
      }
      case 1:
        r = a | b;
        this.cf = this.of = this.af = 0;
        break;
      case 4:
        r = a & b;
        this.cf = this.of = this.af = 0;
        break;
      default:
        r = a ^ b;
        this.cf = this.of = this.af = 0;
    }
    this.szp8(r);
    return op === 7 ? a : r & 0xff;
  }
  private alu16(op: number, a: number, b: number): number {
    let r: number;
    switch (op) {
      case 0:
      case 2: {
        const c = op === 2 ? this.cf : 0;
        r = a + b + c;
        this.cf = (r >> 16) & 1;
        this.of = ((a ^ r) & (b ^ r) & 0x8000) >> 15;
        this.af = ((a ^ b ^ r) >> 4) & 1;
        break;
      }
      case 3:
      case 5:
      case 7: {
        const c = op === 3 ? this.cf : 0;
        r = a - b - c;
        this.cf = (r >> 16) & 1;
        this.of = ((a ^ b) & (a ^ r) & 0x8000) >> 15;
        this.af = ((a ^ b ^ r) >> 4) & 1;
        break;
      }
      case 1:
        r = a | b;
        this.cf = this.of = this.af = 0;
        break;
      case 4:
        r = a & b;
        this.cf = this.of = this.af = 0;
        break;
      default:
        r = a ^ b;
        this.cf = this.of = this.af = 0;
    }
    this.szp16(r);
    return op === 7 ? a : r & 0xffff;
  }
  private inc8(a: number): number {
    const r = (a + 1) & 0xff;
    this.of = r === 0x80 ? 1 : 0;
    this.af = (a & 0xf) === 0xf ? 1 : 0;
    this.szp8(r);
    return r;
  }
  private dec8(a: number): number {
    const r = (a - 1) & 0xff;
    this.of = a === 0x80 ? 1 : 0;
    this.af = (a & 0xf) === 0 ? 1 : 0;
    this.szp8(r);
    return r;
  }
  private inc16(a: number): number {
    const r = (a + 1) & 0xffff;
    this.of = r === 0x8000 ? 1 : 0;
    this.af = (a & 0xf) === 0xf ? 1 : 0;
    this.szp16(r);
    return r;
  }
  private dec16(a: number): number {
    const r = (a - 1) & 0xffff;
    this.of = a === 0x8000 ? 1 : 0;
    this.af = (a & 0xf) === 0 ? 1 : 0;
    this.szp16(r);
    return r;
  }

  /** シフト・ローテート（0 ROL、1 ROR、2 RCL、3 RCR、4 SHL、5 SHR、6 SHL、7 SAR） */
  private shift(op: number, v: number, count: number, bits: number): number {
    // V30 系はシフト数を 32 未満に切り詰めない
    if (count === 0) return v;
    const mask = bits === 8 ? 0xff : 0xffff;
    const msb = bits - 1;
    this.cycles += count;
    for (let i = 0; i < count; i++) {
      switch (op) {
        case 0: {
          const c = (v >> msb) & 1;
          v = ((v << 1) | c) & mask;
          this.cf = c;
          break;
        }
        case 1: {
          const c = v & 1;
          v = (v >> 1) | (c << msb);
          this.cf = c;
          break;
        }
        case 2: {
          const c = (v >> msb) & 1;
          v = ((v << 1) | this.cf) & mask;
          this.cf = c;
          break;
        }
        case 3: {
          const c = v & 1;
          v = (v >> 1) | (this.cf << msb);
          this.cf = c;
          break;
        }
        case 4:
        case 6:
          this.cf = (v >> msb) & 1;
          v = (v << 1) & mask;
          break;
        case 5:
          this.cf = v & 1;
          this.of = (v >> msb) & 1;
          v >>= 1;
          break;
        default:
          this.cf = v & 1;
          v = (v >> 1) | (v & (1 << msb));
      }
    }
    switch (op) {
      case 0:
      case 2:
      case 4:
      case 6:
        this.of = ((v >> msb) & 1) ^ this.cf;
        break;
      case 1:
      case 3:
        this.of = ((v >> msb) ^ (v >> (msb - 1))) & 1;
        break;
      case 7:
        this.of = 0;
        break;
    }
    if (op >= 4) {
      if (bits === 8) this.szp8(v);
      else this.szp16(v);
      this.af = 0;
    }
    return v;
  }

  // ---- 割り込み ----
  /** 割り込み（ソフトウェア割り込みとハードウェア割り込みの共通） */
  interrupt(vector: number): void {
    this.push(this.getFlags());
    this.push(this.s[CS]);
    this.push(this.ip);
    this.ie = 0;
    this.tf = 0;
    this.ip = this.rd16(0, vector * 4);
    this.s[CS] = this.rd16(0, vector * 4 + 2);
    this.cycles += 10;
  }

  /** 割り込みを受け付けられる状態か */
  canInterrupt(): boolean {
    return this.ie === 1 && !this.inhibit;
  }

  // ---- 実行 ----
  /** 1 命令実行する。HLT 中なら 1 クロック進めるだけ */
  step(): void {
    if (this.halted) {
      this.cycles += 1;
      return;
    }
    this.inhibit = false;
    this.seg = -1;
    let rep = 0; // 1 = REP / REPE、2 = REPNE
    for (;;) {
      const op = this.fetch8();
      switch (op) {
        case 0x26:
          this.seg = ES;
          this.cycles++;
          continue;
        case 0x2e:
          this.seg = CS;
          this.cycles++;
          continue;
        case 0x36:
          this.seg = SS;
          this.cycles++;
          continue;
        case 0x3e:
          this.seg = DS;
          this.cycles++;
          continue;
        case 0xf0:
          this.cycles++;
          continue;
        case 0xf2:
          rep = 2;
          this.cycles++;
          continue;
        case 0xf3:
          rep = 1;
          this.cycles++;
          continue;
      }
      this.exec(op, rep);
      return;
    }
  }

  private jcc(cond: boolean): void {
    const d = (this.fetch8() << 24) >> 24;
    if (cond) {
      this.ip = (this.ip + d) & 0xffff;
      this.cycles += 4;
    } else this.cycles += 1;
  }

  private cond(c: number): boolean {
    switch (c) {
      case 0:
        return this.of === 1;
      case 1:
        return this.of === 0;
      case 2:
        return this.cf === 1;
      case 3:
        return this.cf === 0;
      case 4:
        return this.zf === 1;
      case 5:
        return this.zf === 0;
      case 6:
        return (this.cf | this.zf) === 1;
      case 7:
        return (this.cf | this.zf) === 0;
      case 8:
        return this.sf === 1;
      case 9:
        return this.sf === 0;
      case 10:
        return this.pf === 1;
      case 11:
        return this.pf === 0;
      case 12:
        return this.sf !== this.of;
      case 13:
        return this.sf === this.of;
      case 14:
        return this.zf === 1 || this.sf !== this.of;
      default:
        return this.zf === 0 && this.sf === this.of;
    }
  }

  private exec(op: number, rep: number): void {
    const r = this.r;
    const s = this.s;
    // ALU 命令（0x00〜0x3F の下位 3 ビットが 0〜5）
    if (op < 0x40 && (op & 7) < 6) {
      const alu = op >> 3;
      switch (op & 7) {
        case 0:
          this.modrm();
          if (alu === 7) this.alu8(alu, this.getRM8(), this.getR8(this.reg));
          else this.setRM8(this.alu8(alu, this.getRM8(), this.getR8(this.reg)));
          this.cycles += this.mod === 3 ? 1 : 2;
          return;
        case 1:
          this.modrm();
          if (alu === 7) this.alu16(alu, this.getRM16(), r[this.reg]);
          else this.setRM16(this.alu16(alu, this.getRM16(), r[this.reg]));
          this.cycles += this.mod === 3 ? 1 : 2;
          return;
        case 2:
          this.modrm();
          this.setR8(this.reg, this.alu8(alu, this.getR8(this.reg), this.getRM8()));
          this.cycles += 1;
          return;
        case 3:
          this.modrm();
          r[this.reg] = this.alu16(alu, r[this.reg], this.getRM16());
          this.cycles += 1;
          return;
        case 4:
          this.setR8(0, this.alu8(alu, r[AX] & 0xff, this.fetch8()));
          this.cycles += 1;
          return;
        default:
          r[AX] = this.alu16(alu, r[AX], this.fetch16());
          this.cycles += 1;
          return;
      }
    }
    if (op >= 0x40 && op < 0x48) {
      r[op & 7] = this.inc16(r[op & 7]);
      this.cycles += 1;
      return;
    }
    if (op >= 0x48 && op < 0x50) {
      r[op & 7] = this.dec16(r[op & 7]);
      this.cycles += 1;
      return;
    }
    if (op >= 0x50 && op < 0x58) {
      // PUSH SP は減らしたあとの値を積む（8086・V20 と同じ）
      if (op === 0x54) {
        r[SP] -= 2;
        this.wr16(this.s[SS], r[SP], r[SP]);
      } else this.push(r[op & 7]);
      this.cycles += 1;
      return;
    }
    if (op >= 0x58 && op < 0x60) {
      const v = this.pop();
      r[op & 7] = v;
      this.cycles += 1;
      return;
    }
    if (op >= 0x70 && op < 0x80) return this.jcc(this.cond(op & 15));
    if (op >= 0x91 && op < 0x98) {
      const t = r[AX];
      r[AX] = r[op & 7];
      r[op & 7] = t;
      this.cycles += 3;
      return;
    }
    if (op >= 0xb0 && op < 0xb8) {
      this.setR8(op & 7, this.fetch8());
      this.cycles += 1;
      return;
    }
    if (op >= 0xb8 && op < 0xc0) {
      r[op & 7] = this.fetch16();
      this.cycles += 1;
      return;
    }

    switch (op) {
      case 0x06:
      case 0x0e:
      case 0x16:
      case 0x1e:
        this.push(s[op >> 3]);
        this.cycles += 2;
        return;
      case 0x07:
      case 0x17:
      case 0x1f:
        s[op >> 3] = this.pop();
        if (op === 0x17) this.inhibit = true;
        this.cycles += 3;
        return;
      case 0x0f: // V30MZ にはない命令（何もしない）
        this.cycles += 1;
        return;
      case 0x27: {
        // DAA
        const al = r[AX] & 0xff;
        const oldCf = this.cf;
        let v = al;
        if ((al & 0x0f) > 9 || this.af) {
          v += 6;
          this.af = 1;
        } else this.af = 0;
        if (al > 0x99 || oldCf) {
          v += 0x60;
          this.cf = 1;
        } else this.cf = 0;
        this.setR8(0, v);
        this.szp8(v);
        this.cycles += 10;
        return;
      }
      case 0x2f: {
        // DAS
        const al = r[AX] & 0xff;
        const oldCf = this.cf;
        let v = al;
        if ((al & 0x0f) > 9 || this.af) {
          v -= 6;
          this.af = 1;
        } else this.af = 0;
        if (al > 0x99 || oldCf) {
          v -= 0x60;
          this.cf = 1;
        } else this.cf = 0;
        this.setR8(0, v);
        this.szp8(v);
        this.cycles += 10;
        return;
      }
      case 0x37: // AAA
      case 0x3f: {
        // AAS
        if ((r[AX] & 0x0f) > 9 || this.af) {
          if (op === 0x37) {
            this.setR8(0, (r[AX] & 0xff) + 6);
            this.setR8(4, (r[AX] >> 8) + 1);
          } else {
            this.setR8(0, (r[AX] & 0xff) - 6);
            this.setR8(4, (r[AX] >> 8) - 1);
          }
          this.af = this.cf = 1;
        } else this.af = this.cf = 0;
        this.setR8(0, r[AX] & 0x0f);
        this.cycles += 9;
        return;
      }
      case 0x60: {
        // PUSHA
        const sp = r[SP];
        this.push(r[AX]);
        this.push(r[CX]);
        this.push(r[DX]);
        this.push(r[BX]);
        this.push(sp);
        this.push(r[BP]);
        this.push(r[SI]);
        this.push(r[DI]);
        this.cycles += 9;
        return;
      }
      case 0x61:
        // POPA
        r[DI] = this.pop();
        r[SI] = this.pop();
        r[BP] = this.pop();
        this.pop();
        r[BX] = this.pop();
        r[DX] = this.pop();
        r[CX] = this.pop();
        r[AX] = this.pop();
        this.cycles += 8;
        return;
      case 0x62: {
        // BOUND
        this.modrm();
        const v = (r[this.reg] << 16) >> 16;
        const lo = (this.rd16(this.eaSeg, this.eaOff) << 16) >> 16;
        const hi = (this.rd16(this.eaSeg, this.eaOff + 2) << 16) >> 16;
        this.cycles += 12;
        if (v < lo || v > hi) this.interrupt(5);
        return;
      }
      case 0x63:
      case 0x64:
      case 0x65:
      case 0x66:
      case 0x67:
      case 0xf1:
      case 0x9b: // WAIT
        this.cycles += 1;
        return;
      case 0x68:
        this.push(this.fetch16());
        this.cycles += 1;
        return;
      case 0x6a:
        this.push(((this.fetch8() << 24) >> 24) & 0xffff);
        this.cycles += 1;
        return;
      case 0x69:
      case 0x6b: {
        // IMUL r16, r/m16, imm
        this.modrm();
        const a = (this.getRM16() << 16) >> 16;
        const b = op === 0x69 ? (this.fetch16() << 16) >> 16 : (this.fetch8() << 24) >> 24;
        const res = a * b;
        r[this.reg] = res & 0xffff;
        this.cf = this.of = res !== (res << 16) >> 16 ? 1 : 0;
        this.cycles += 4;
        return;
      }
      case 0x6c:
      case 0x6d:
      case 0x6e:
      case 0x6f:
      case 0xa4:
      case 0xa5:
      case 0xa6:
      case 0xa7:
      case 0xaa:
      case 0xab:
      case 0xac:
      case 0xad:
      case 0xae:
      case 0xaf:
        return this.string(op, rep);
      case 0x80:
      case 0x82: {
        this.modrm();
        const v = this.alu8(this.reg, this.getRM8(), this.fetch8());
        if (this.reg !== 7) this.setRM8(v);
        this.cycles += this.mod === 3 ? 1 : 2;
        return;
      }
      case 0x81: {
        this.modrm();
        const v = this.alu16(this.reg, this.getRM16(), this.fetch16());
        if (this.reg !== 7) this.setRM16(v);
        this.cycles += this.mod === 3 ? 1 : 2;
        return;
      }
      case 0x83: {
        this.modrm();
        const v = this.alu16(this.reg, this.getRM16(), ((this.fetch8() << 24) >> 24) & 0xffff);
        if (this.reg !== 7) this.setRM16(v);
        this.cycles += this.mod === 3 ? 1 : 2;
        return;
      }
      case 0x84:
        this.modrm();
        this.alu8(4, this.getRM8(), this.getR8(this.reg));
        this.cycles += 1;
        return;
      case 0x85:
        this.modrm();
        this.alu16(4, this.getRM16(), r[this.reg]);
        this.cycles += 1;
        return;
      case 0x86: {
        this.modrm();
        const a = this.getRM8();
        this.setRM8(this.getR8(this.reg));
        this.setR8(this.reg, a);
        this.cycles += 3;
        return;
      }
      case 0x87: {
        this.modrm();
        const a = this.getRM16();
        this.setRM16(r[this.reg]);
        r[this.reg] = a;
        this.cycles += 3;
        return;
      }
      case 0x88:
        this.modrm();
        this.setRM8(this.getR8(this.reg));
        this.cycles += 1;
        return;
      case 0x89:
        this.modrm();
        this.setRM16(r[this.reg]);
        this.cycles += 1;
        return;
      case 0x8a:
        this.modrm();
        this.setR8(this.reg, this.getRM8());
        this.cycles += 1;
        return;
      case 0x8b:
        this.modrm();
        r[this.reg] = this.getRM16();
        this.cycles += 1;
        return;
      case 0x8c:
        this.modrm();
        this.setRM16(s[this.reg & 3]);
        this.cycles += 1;
        return;
      case 0x8d:
        this.modrm();
        r[this.reg] = this.mod === 3 ? r[this.rm] : this.eaOff;
        this.cycles += 1;
        return;
      case 0x8e:
        this.modrm();
        s[this.reg & 3] = this.getRM16();
        if ((this.reg & 3) === SS) this.inhibit = true;
        this.cycles += 2;
        return;
      case 0x8f: {
        const v = this.pop();
        this.modrm();
        this.setRM16(v);
        this.cycles += 2;
        return;
      }
      case 0x90:
        this.cycles += 1;
        return;
      case 0x98:
        r[AX] = r[AX] & 0x80 ? r[AX] | 0xff00 : r[AX] & 0xff;
        this.cycles += 1;
        return;
      case 0x99:
        r[DX] = r[AX] & 0x8000 ? 0xffff : 0;
        this.cycles += 1;
        return;
      case 0x9a: {
        const ip = this.fetch16();
        const cs = this.fetch16();
        this.push(s[CS]);
        this.push(this.ip);
        s[CS] = cs;
        this.ip = ip;
        this.cycles += 10;
        return;
      }
      case 0x9c:
        this.push(this.getFlags());
        this.cycles += 2;
        return;
      case 0x9d:
        this.setFlags(this.pop());
        this.cycles += 3;
        return;
      case 0x9e: {
        const ah = r[AX] >> 8;
        this.setFlags((this.getFlags() & 0xff00) | ah);
        this.cycles += 4;
        return;
      }
      case 0x9f:
        this.setR8(4, this.getFlags() & 0xff);
        this.cycles += 2;
        return;
      case 0xa0:
        this.setR8(0, this.rd8(this.dataSeg(), this.fetch16()));
        this.cycles += 1;
        return;
      case 0xa1:
        r[AX] = this.rd16(this.dataSeg(), this.fetch16());
        this.cycles += 1;
        return;
      case 0xa2:
        this.wr8(this.dataSeg(), this.fetch16(), r[AX]);
        this.cycles += 1;
        return;
      case 0xa3:
        this.wr16(this.dataSeg(), this.fetch16(), r[AX]);
        this.cycles += 1;
        return;
      case 0xa8:
        this.alu8(4, r[AX] & 0xff, this.fetch8());
        this.cycles += 1;
        return;
      case 0xa9:
        this.alu16(4, r[AX], this.fetch16());
        this.cycles += 1;
        return;
      case 0xc0:
      case 0xc1:
      case 0xd0:
      case 0xd1:
      case 0xd2:
      case 0xd3: {
        this.modrm();
        const byte = (op & 1) === 0;
        const v = byte ? this.getRM8() : this.getRM16();
        const count = op <= 0xc1 ? this.fetch8() : op <= 0xd1 ? 1 : r[CX] & 0xff;
        const res = this.shift(this.reg, v, count, byte ? 8 : 16);
        if (byte) this.setRM8(res);
        else this.setRM16(res);
        this.cycles += this.mod === 3 ? 1 : 3;
        return;
      }
      case 0xc2: {
        const n = this.fetch16();
        this.ip = this.pop();
        r[SP] += n;
        this.cycles += 6;
        return;
      }
      case 0xc3:
        this.ip = this.pop();
        this.cycles += 6;
        return;
      case 0xc4:
      case 0xc5: {
        this.modrm();
        r[this.reg] = this.rd16(this.eaSeg, this.eaOff);
        s[op === 0xc4 ? ES : DS] = this.rd16(this.eaSeg, this.eaOff + 2);
        this.cycles += 6;
        return;
      }
      case 0xc6:
        this.modrm();
        this.setRM8(this.fetch8());
        this.cycles += 1;
        return;
      case 0xc7:
        this.modrm();
        this.setRM16(this.fetch16());
        this.cycles += 1;
        return;
      case 0xc8: {
        // ENTER
        const size = this.fetch16();
        const level = this.fetch8() & 0x1f;
        this.push(r[BP]);
        const frame = r[SP];
        if (level > 0) {
          for (let i = 1; i < level; i++) {
            r[BP] -= 2;
            this.push(this.rd16(s[SS], r[BP]));
          }
          this.push(frame);
        }
        r[BP] = frame;
        r[SP] -= size;
        this.cycles += 8 + level * 4;
        return;
      }
      case 0xc9:
        r[SP] = r[BP];
        r[BP] = this.pop();
        this.cycles += 2;
        return;
      case 0xca: {
        const n = this.fetch16();
        this.ip = this.pop();
        s[CS] = this.pop();
        r[SP] += n;
        this.cycles += 9;
        return;
      }
      case 0xcb:
        this.ip = this.pop();
        s[CS] = this.pop();
        this.cycles += 8;
        return;
      case 0xcc:
        this.interrupt(3);
        return;
      case 0xcd:
        this.interrupt(this.fetch8());
        return;
      case 0xce:
        if (this.of) this.interrupt(4);
        else this.cycles += 1;
        return;
      case 0xcf:
        this.ip = this.pop();
        s[CS] = this.pop();
        this.setFlags(this.pop());
        this.cycles += 10;
        return;
      case 0xd4: {
        // AAM
        const base = this.fetch8();
        this.cycles += 17;
        if (base === 0) {
          this.interrupt(0);
          return;
        }
        const al = r[AX] & 0xff;
        r[AX] = (Math.floor(al / base) << 8) | al % base;
        this.szp8(r[AX] & 0xff);
        return;
      }
      case 0xd5: {
        // AAD（V30 系は即値を見ず、いつも 10）
        this.fetch8();
        const base = 10;
        const al = ((r[AX] >> 8) * base + (r[AX] & 0xff)) & 0xff;
        r[AX] = al;
        this.szp8(al);
        this.cycles += 6;
        return;
      }
      case 0xd6: // SALC
        this.setR8(0, this.cf ? 0xff : 0);
        this.cycles += 3;
        return;
      case 0xd7:
        this.setR8(0, this.rd8(this.dataSeg(), r[BX] + (r[AX] & 0xff)));
        this.cycles += 5;
        return;
      case 0xd8:
      case 0xd9:
      case 0xda:
      case 0xdb:
      case 0xdc:
      case 0xdd:
      case 0xde:
      case 0xdf: // 浮動小数点（コプロセッサなし）
        this.modrm();
        this.cycles += 1;
        return;
      case 0xe0:
      case 0xe1:
      case 0xe2: {
        const d = (this.fetch8() << 24) >> 24;
        r[CX]--;
        const go = r[CX] !== 0 && (op === 0xe2 || (op === 0xe1 ? this.zf === 1 : this.zf === 0));
        if (go) {
          this.ip = (this.ip + d) & 0xffff;
          this.cycles += 6;
        } else this.cycles += 3;
        return;
      }
      case 0xe3:
        return this.jcc(r[CX] === 0);
      case 0xe4:
        this.setR8(0, this.bus.in8(this.fetch8()));
        this.cycles += 7;
        return;
      case 0xe5: {
        const p = this.fetch8();
        r[AX] = this.bus.in8(p) | (this.bus.in8((p + 1) & 0xff) << 8);
        this.cycles += 6;
        return;
      }
      case 0xe6:
        this.bus.out8(this.fetch8(), r[AX] & 0xff);
        this.cycles += 6;
        return;
      case 0xe7: {
        const p = this.fetch8();
        this.bus.out8(p, r[AX] & 0xff);
        this.bus.out8((p + 1) & 0xff, r[AX] >> 8);
        this.cycles += 6;
        return;
      }
      case 0xe8: {
        const d = this.fetch16();
        this.push(this.ip);
        this.ip = (this.ip + d) & 0xffff;
        this.cycles += 5;
        return;
      }
      case 0xe9: {
        const d = this.fetch16();
        this.ip = (this.ip + d) & 0xffff;
        this.cycles += 4;
        return;
      }
      case 0xea: {
        const ip = this.fetch16();
        s[CS] = this.fetch16();
        this.ip = ip;
        this.cycles += 7;
        return;
      }
      case 0xeb: {
        const d = (this.fetch8() << 24) >> 24;
        this.ip = (this.ip + d) & 0xffff;
        this.cycles += 4;
        return;
      }
      case 0xec:
        this.setR8(0, this.bus.in8(r[DX] & 0xff));
        this.cycles += 6;
        return;
      case 0xed:
        r[AX] = this.bus.in8(r[DX] & 0xff) | (this.bus.in8((r[DX] + 1) & 0xff) << 8);
        this.cycles += 6;
        return;
      case 0xee:
        this.bus.out8(r[DX] & 0xff, r[AX] & 0xff);
        this.cycles += 6;
        return;
      case 0xef:
        this.bus.out8(r[DX] & 0xff, r[AX] & 0xff);
        this.bus.out8((r[DX] + 1) & 0xff, r[AX] >> 8);
        this.cycles += 6;
        return;
      case 0xf4:
        this.halted = true;
        this.cycles += 9;
        return;
      case 0xf5:
        this.cf ^= 1;
        this.cycles += 4;
        return;
      case 0xf6:
        return this.group3(8);
      case 0xf7:
        return this.group3(16);
      case 0xf8:
        this.cf = 0;
        this.cycles += 4;
        return;
      case 0xf9:
        this.cf = 1;
        this.cycles += 4;
        return;
      case 0xfa:
        this.ie = 0;
        this.cycles += 4;
        return;
      case 0xfb:
        this.ie = 1;
        this.inhibit = true;
        this.cycles += 4;
        return;
      case 0xfc:
        this.df = 0;
        this.cycles += 4;
        return;
      case 0xfd:
        this.df = 1;
        this.cycles += 4;
        return;
      case 0xfe:
        this.modrm();
        if (this.reg === 0) this.setRM8(this.inc8(this.getRM8()));
        else if (this.reg === 1) this.setRM8(this.dec8(this.getRM8()));
        this.cycles += this.mod === 3 ? 1 : 3;
        return;
      case 0xff:
        return this.group5();
    }
    // ここまでに当てはまらない命令はない（念のため何もしない）
    this.cycles += 1;
  }

  private group3(bits: number): void {
    this.modrm();
    const byte = bits === 8;
    const v = byte ? this.getRM8() : this.getRM16();
    const r = this.r;
    switch (this.reg) {
      case 0:
      case 1: {
        const imm = byte ? this.fetch8() : this.fetch16();
        if (byte) this.alu8(4, v, imm);
        else this.alu16(4, v, imm);
        this.cycles += 1;
        return;
      }
      case 2:
        if (byte) this.setRM8(~v);
        else this.setRM16(~v);
        this.cycles += this.mod === 3 ? 1 : 3;
        return;
      case 3:
        if (byte) this.setRM8(this.alu8(5, 0, v));
        else this.setRM16(this.alu16(5, 0, v));
        this.cycles += this.mod === 3 ? 1 : 3;
        return;
      case 4: {
        // MUL
        if (byte) {
          const res = (r[AX] & 0xff) * v;
          r[AX] = res;
          this.cf = this.of = res >> 8 ? 1 : 0;
          this.szp8(res);
        } else {
          const res = r[AX] * v;
          r[AX] = res & 0xffff;
          r[DX] = Math.floor(res / 0x10000);
          this.cf = this.of = r[DX] ? 1 : 0;
          this.szp16(r[AX]);
        }
        this.cycles += 3;
        return;
      }
      case 5: {
        // IMUL
        if (byte) {
          const res = ((r[AX] << 24) >> 24) * ((v << 24) >> 24);
          r[AX] = res & 0xffff;
          this.cf = this.of = res !== (res << 24) >> 24 ? 1 : 0;
          this.szp8(res);
        } else {
          const res = ((r[AX] << 16) >> 16) * ((v << 16) >> 16);
          r[AX] = res & 0xffff;
          r[DX] = (res >> 16) & 0xffff;
          this.cf = this.of = res !== (res << 16) >> 16 ? 1 : 0;
          this.szp16(res);
        }
        this.cycles += 4;
        return;
      }
      case 6: {
        // DIV
        if (v === 0) return this.interrupt(0);
        if (byte) {
          const q = Math.floor(r[AX] / v);
          if (q > 0xff) return this.interrupt(0);
          r[AX] = ((r[AX] % v) << 8) | q;
          this.cycles += 15;
        } else {
          const n = r[DX] * 0x10000 + r[AX];
          const q = Math.floor(n / v);
          if (q > 0xffff) return this.interrupt(0);
          r[DX] = n % v;
          r[AX] = q;
          this.cycles += 23;
        }
        return;
      }
      default: {
        // IDIV
        if (v === 0) return this.interrupt(0);
        if (byte) {
          const n = (r[AX] << 16) >> 16;
          const d = (v << 24) >> 24;
          const q = Math.trunc(n / d);
          if (q > 127 || q < -128) return this.interrupt(0);
          r[AX] = (((n % d) & 0xff) << 8) | (q & 0xff);
          this.cycles += 17;
        } else {
          const n = ((r[DX] << 16) | r[AX]) | 0;
          const d = (v << 16) >> 16;
          const q = Math.trunc(n / d);
          if (q > 32767 || q < -32768) return this.interrupt(0);
          r[DX] = n % d;
          r[AX] = q;
          this.cycles += 24;
        }
        return;
      }
    }
  }

  private group5(): void {
    this.modrm();
    const r = this.r;
    const s = this.s;
    switch (this.reg) {
      case 0:
        this.setRM16(this.inc16(this.getRM16()));
        this.cycles += this.mod === 3 ? 1 : 3;
        return;
      case 1:
        this.setRM16(this.dec16(this.getRM16()));
        this.cycles += this.mod === 3 ? 1 : 3;
        return;
      case 2: {
        const t = this.getRM16();
        this.push(this.ip);
        this.ip = t;
        this.cycles += 5;
        return;
      }
      case 3: {
        const ip = this.rd16(this.eaSeg, this.eaOff);
        const cs = this.rd16(this.eaSeg, this.eaOff + 2);
        this.push(s[CS]);
        this.push(this.ip);
        this.ip = ip;
        s[CS] = cs;
        this.cycles += 12;
        return;
      }
      case 4:
        this.ip = this.getRM16();
        this.cycles += 4;
        return;
      case 5: {
        const ip = this.rd16(this.eaSeg, this.eaOff);
        s[CS] = this.rd16(this.eaSeg, this.eaOff + 2);
        this.ip = ip;
        this.cycles += 9;
        return;
      }
      default: {
        // PUSH r/m（SP を指すときは減らしたあとの値）
        if (this.mod === 3 && this.rm === SP) {
          r[SP] -= 2;
          this.wr16(s[SS], r[SP], r[SP]);
        } else this.push(this.getRM16());
        this.cycles += 2;
        return;
      }
    }
  }

  /** 文字列命令（REP 付きなら CX 回くり返す） */
  private string(op: number, rep: number): void {
    const r = this.r;
    const s = this.s;
    const word = op & 1;
    const size = word ? 2 : 1;
    const step = this.df ? -size : size;
    const src = this.dataSeg();
    const once = (): void => {
      switch (op) {
        case 0x6c:
          this.wr8(s[ES], r[DI], this.bus.in8(r[DX] & 0xff));
          r[DI] += step;
          break;
        case 0x6d:
          this.wr16(s[ES], r[DI], this.bus.in8(r[DX] & 0xff) | (this.bus.in8((r[DX] + 1) & 0xff) << 8));
          r[DI] += step;
          break;
        case 0x6e:
          this.bus.out8(r[DX] & 0xff, this.rd8(src, r[SI]));
          r[SI] += step;
          break;
        case 0x6f: {
          const v = this.rd16(src, r[SI]);
          this.bus.out8(r[DX] & 0xff, v & 0xff);
          this.bus.out8((r[DX] + 1) & 0xff, v >> 8);
          r[SI] += step;
          break;
        }
        case 0xa4:
          this.wr8(s[ES], r[DI], this.rd8(src, r[SI]));
          r[SI] += step;
          r[DI] += step;
          break;
        case 0xa5:
          this.wr16(s[ES], r[DI], this.rd16(src, r[SI]));
          r[SI] += step;
          r[DI] += step;
          break;
        case 0xa6:
          this.alu8(7, this.rd8(src, r[SI]), this.rd8(s[ES], r[DI]));
          r[SI] += step;
          r[DI] += step;
          break;
        case 0xa7:
          this.alu16(7, this.rd16(src, r[SI]), this.rd16(s[ES], r[DI]));
          r[SI] += step;
          r[DI] += step;
          break;
        case 0xaa:
          this.wr8(s[ES], r[DI], r[AX]);
          r[DI] += step;
          break;
        case 0xab:
          this.wr16(s[ES], r[DI], r[AX]);
          r[DI] += step;
          break;
        case 0xac:
          this.setR8(0, this.rd8(src, r[SI]));
          r[SI] += step;
          break;
        case 0xad:
          r[AX] = this.rd16(src, r[SI]);
          r[SI] += step;
          break;
        case 0xae:
          this.alu8(7, r[AX] & 0xff, this.rd8(s[ES], r[DI]));
          r[DI] += step;
          break;
        default:
          this.alu16(7, r[AX], this.rd16(s[ES], r[DI]));
          r[DI] += step;
      }
      this.cycles += 3;
    };
    const compares = op === 0xa6 || op === 0xa7 || op === 0xae || op === 0xaf;
    if (!rep) {
      once();
      return;
    }
    this.cycles += 2;
    while (r[CX] !== 0) {
      once();
      r[CX]--;
      if (compares && (rep === 1 ? this.zf === 0 : this.zf === 1)) break;
    }
  }
}
