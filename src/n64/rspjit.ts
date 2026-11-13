// RSP のプログラム（マイクロコード）を JavaScript の関数に書き換えて速く動かす。
// RSP のプログラムは IMEM（4KB）に入っていて、仕事（絵・音）ごとに入れ替わる。
// 入れ替わったら（IMEM に書き込まれたら）作った関数を全部捨てる。
// よく使うベクトルの掛け算・足し算は、8 個の要素を展開した専用のコードにする

import type { Rsp } from './rsp';

type Block = (rsp: Rsp) => number;

const MAX_OPS = 48;

/** vt の要素の選び方（e）ごとの、要素 i が読む元の番号 */
const BC: number[][] = [];
for (let e = 0; e < 16; e++) {
  const t: number[] = [];
  for (let i = 0; i < 8; i++) {
    if (e < 2) t.push(i);
    else if (e < 4) t.push((i & ~1) | (e & 1));
    else if (e < 8) t.push((i & ~3) | (e & 3));
    else t.push(e & 7);
  }
  BC.push(t);
}

/** 専用のコードにするベクトル命令 */
const FAST_VEC = new Set([0x00, 0x01, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x27, 0x28, 0x2a, 0x2c]);

export class RspJit {
  blocks: (Block | null)[] = new Array<Block | null>(1024).fill(null);
  /** ブロックの長さ（命令数） */
  private lens = new Uint8Array(1024);
  /** IMEM が書きかわったかもしれない印（使う前に中身を比べる） */
  private stale = new Uint8Array(1024);
  ok = true;

  constructor(private rsp: Rsp) {
    try {
      new Function('return 1')();
    } catch {
      this.ok = false;
    }
  }

  /** IMEM が書きかわった */
  clear(): void {
    this.blocks.fill(null);
    this.stale.fill(0);
    for (const v of this.versions) v.length = 0;
  }

  /** IMEM の a〜a+len（バイト）が書きかわった：重なるブロックだけ捨てる */
  invalidate(a: number, len: number): void {
    const w0 = (a & 0xfff) >> 2;
    const w1 = Math.min(1024, w0 + ((len + 3) >> 2));
    for (let i = Math.max(0, w0 - MAX_OPS); i < w1; i++) {
      if (this.blocks[i] !== null && i + this.lens[i] > w0) this.stale[i] = 1;
    }
  }

  /** 同じ場所に入ったことのあるプログラム（オーバーレイで入れ替わるので、いくつか覚えておく） */
  private versions: { src: Int32Array; fn: Block }[][] = Array.from({ length: 1024 }, () => []);

  private matches(pc: number, src: Int32Array): boolean {
    const m = this.rsp.imem32();
    for (let k = 0; k < src.length; k++) if (m[(0x1000 | ((pc + k * 4) & 0xffc)) >> 2] !== src[k]) return false;
    return true;
  }

  get(pc: number): Block | null {
    const i = pc >> 2;
    const b = this.blocks[i];
    if (b !== null && !this.stale[i]) return b;
    this.stale[i] = 0;
    // 前に作ったものの中に、今の命令の並びと同じものがあればそれを使う
    const vs = this.versions[i];
    for (let k = 0; k < vs.length; k++) {
      const ver = vs[k];
      if (this.matches(pc, ver.src)) {
        this.blocks[i] = ver.fn;
        this.lens[i] = ver.src.length;
        return ver.fn;
      }
    }
    this.blocks[i] = null;
    if (!this.ok) return null;
    const nb = this.compile(pc);
    if (nb) {
      this.blocks[i] = nb;
      this.lens[i] = this.lastLen;
      const m = this.rsp.imem32();
      const src = new Int32Array(this.lastLen);
      for (let k = 0; k < src.length; k++) src[k] = m[(0x1000 | ((pc + k * 4) & 0xffc)) >> 2];
      if (vs.length >= 8) vs.shift();
      vs.push({ src, fn: nb });
    }
    return nb;
  }

  /** simple：その場で書ける、vec：ベクトル演算など（関数を呼ぶ）、branch：分岐、stop：ブロックに入れない */
  private classify(op: number): 'simple' | 'branch' | 'stop' {
    switch (op >>> 26) {
      case 0x00: {
        const f = op & 63;
        if (f === 0x08 || f === 0x09) return 'branch';
        if (f === 0x0d) return 'stop';
        return [0x00, 0x02, 0x03, 0x04, 0x06, 0x07, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2a, 0x2b].includes(f)
          ? 'simple'
          : 'stop';
      }
      case 0x01:
        return 'branch';
      case 0x02:
      case 0x03:
      case 0x04:
      case 0x05:
      case 0x06:
      case 0x07:
        return 'branch';
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c:
      case 0x0d:
      case 0x0e:
      case 0x0f:
      case 0x20:
      case 0x21:
      case 0x23:
      case 0x24:
      case 0x25:
      case 0x27:
      case 0x28:
      case 0x29:
      case 0x2b:
      case 0x32:
      case 0x3a:
        return 'simple';
      case 0x12: {
        const rs = (op >>> 21) & 31;
        if (rs & 0x10) return 'simple';
        return rs === 0 || rs === 2 || rs === 4 || rs === 6 ? 'simple' : 'stop';
      }
    }
    return 'stop';
  }

  private lastLen = 0;

  private compile(pc: number): Block | null {
    const mem32 = this.rsp.imem32();
    const lines: string[] = [];
    let addr = pc;
    let n = 0;
    let ended = false;
    while (n < MAX_OPS) {
      const op = mem32[(0x1000 | addr) >> 2];
      const kind = this.classify(op);
      if (kind === 'stop') break;
      if (kind === 'branch') {
        const slotAddr = (addr + 4) & 0xffc;
        const slot = mem32[(0x1000 | slotAddr) >> 2];
        if (slotAddr === 0 || this.classify(slot) !== 'simple') break;
        lines.push(this.branch(op, addr, this.simple(slot), n + 2));
        n += 2;
        ended = true;
        break;
      }
      lines.push(this.simple(op));
      n++;
      addr = (addr + 4) & 0xffc;
      if (addr === 0) break;
    }
    if (n === 0) return null;
    // 調べる長さ：ブロックの命令（＋分岐しなかったときに止まった次の命令は含めない）
    this.lastLen = n;
    if (!ended) lines.push(`R.pc=${addr};R.nextPc=${(addr + 4) & 0xffc};return ${n};`);
    const body =
      'return function(R){const r=R.r,m8=R.dmem8(),m32=R.dmem32();let a=0;' +
      lines.join('\n') +
      '}';
    try {
      return new Function('VF', body)(VF) as Block;
    } catch (e) {
      console.error(e);
      this.ok = false;
      return null;
    }
  }

  private simple(op: number): string {
    const rs = (op >>> 21) & 31;
    const rt = (op >>> 16) & 31;
    const rd = (op >>> 11) & 31;
    const sa = (op >>> 6) & 31;
    const imm = (op << 16) >> 16;
    const uimm = op & 0xffff;
    const set = (reg: number, e: string) => (reg ? `r[${reg}]=${e};` : '');
    const ea = `a=(r[${rs}]+${imm})&4095;`;
    switch (op >>> 26) {
      case 0x00:
        switch (op & 63) {
          case 0x00:
            return set(rd, `r[${rt}]<<${sa}`);
          case 0x02:
            return set(rd, `r[${rt}]>>>${sa}`);
          case 0x03:
            return set(rd, `r[${rt}]>>${sa}`);
          case 0x04:
            return set(rd, `r[${rt}]<<(r[${rs}]&31)`);
          case 0x06:
            return set(rd, `r[${rt}]>>>(r[${rs}]&31)`);
          case 0x07:
            return set(rd, `r[${rt}]>>(r[${rs}]&31)`);
          case 0x20:
          case 0x21:
            return set(rd, `(r[${rs}]+r[${rt}])|0`);
          case 0x22:
          case 0x23:
            return set(rd, `(r[${rs}]-r[${rt}])|0`);
          case 0x24:
            return set(rd, `r[${rs}]&r[${rt}]`);
          case 0x25:
            return set(rd, `r[${rs}]|r[${rt}]`);
          case 0x26:
            return set(rd, `r[${rs}]^r[${rt}]`);
          case 0x27:
            return set(rd, `~(r[${rs}]|r[${rt}])`);
          case 0x2a:
            return set(rd, `r[${rs}]<r[${rt}]?1:0`);
          case 0x2b:
            return set(rd, `(r[${rs}]>>>0)<(r[${rt}]>>>0)?1:0`);
        }
        break;
      case 0x08:
      case 0x09:
        return set(rt, `(r[${rs}]+${imm})|0`);
      case 0x0a:
        return set(rt, `r[${rs}]<${imm}?1:0`);
      case 0x0b:
        return set(rt, `(r[${rs}]>>>0)<${imm >>> 0}?1:0`);
      case 0x0c:
        return set(rt, `r[${rs}]&${uimm}`);
      case 0x0d:
        return set(rt, `r[${rs}]|${uimm}`);
      case 0x0e:
        return set(rt, `r[${rs}]^${uimm}`);
      case 0x0f:
        return set(rt, `${(op << 16) | 0}`);
      case 0x20:
        return rt ? `${ea}r[${rt}]=(m8[a^3]<<24)>>24;` : '';
      case 0x21:
        return rt ? `${ea}r[${rt}]=(((m8[a^3]<<8)|m8[((a+1)&4095)^3])<<16)>>16;` : '';
      case 0x23:
      case 0x27:
        return rt ? `${ea}r[${rt}]=(a&3)?R.rw(a):m32[a>>2];` : '';
      case 0x24:
        return rt ? `${ea}r[${rt}]=m8[a^3];` : '';
      case 0x25:
        return rt ? `${ea}r[${rt}]=(m8[a^3]<<8)|m8[((a+1)&4095)^3];` : '';
      case 0x28:
        return `${ea}m8[a^3]=r[${rt}];`;
      case 0x29:
        return `${ea}m8[a^3]=r[${rt}]>>8;m8[((a+1)&4095)^3]=r[${rt}];`;
      case 0x2b:
        return `${ea}if(a&3)R.ww(a,r[${rt}]);else m32[a>>2]=r[${rt}];`;
      case 0x32:
        return `R.lwc2(${op | 0},${rs},${rt});`;
      case 0x3a:
        return `R.swc2(${op | 0},${rs},${rt});`;
      case 0x12:
        if (rs & 0x10) return this.vector(op);
        return `R.cop2(${op | 0},${rs},${rt});`;
    }
    return '';
  }

  private branch(op: number, addr: number, slot: string, total: number): string {
    const rs = (op >>> 21) & 31;
    const rt = (op >>> 16) & 31;
    const imm = (op << 16) >> 16;
    const tgt = (addr + 4 + (imm << 2)) & 0xffc;
    const next = (addr + 8) & 0xffc;
    const go = (t: string) => `R.pc=${t};R.nextPc=(${t}+4)&4092;return ${total};`;
    const cond = (c: string, link = false) =>
      `const take=${c};${link ? `r[31]=${next};` : ''}${slot}if(take){${go(String(tgt))}}${go(String(next))}`;
    switch (op >>> 26) {
      case 0x00: {
        const rd = (op >>> 11) & 31;
        const link = (op & 63) === 0x09 && rd ? `r[${rd}]=${next};` : '';
        return `const t=r[${rs}]&4092;${link}${slot}${go('t')}`;
      }
      case 0x01: {
        const neg = `r[${rs}]<0`;
        const take = rt & 1 ? `!(${neg})` : neg;
        return cond(take, (rt & 0x1e) === 0x10);
      }
      case 0x02:
        return `${slot}${go(String((op << 2) & 0xffc))}`;
      case 0x03:
        return `r[31]=${next};${slot}${go(String((op << 2) & 0xffc))}`;
      case 0x04:
        return cond(`r[${rs}]===r[${rt}]`);
      case 0x05:
        return cond(`r[${rs}]!==r[${rt}]`);
      case 0x06:
        return cond(`r[${rs}]<=0`);
      default:
        return cond(`r[${rs}]>0`);
    }
  }

  /** ベクトル演算：よく使うものは専用の関数（小さいので JavaScript のエンジンがよく最適化する）を呼ぶ */
  private vector(op: number): string {
    const f = op & 63;
    if (!FAST_VEC.has(f)) return `R.vector(${op | 0});`;
    const e = (op >>> 21) & 15;
    const vt = (op >>> 16) & 31;
    const vs = (op >>> 11) & 31;
    const vd = (op >>> 6) & 31;
    return `VF[${f}](R,${vs * 8},${vt * 8},${e},${vd * 8});`;
  }
}

// ---- 専用のベクトル演算（R.v：ベクトルレジスタ、R.acc：アキュムレーター） ----
type VecFn = (R: Rsp, s: number, t: number, e: number, d: number) => void;
const P47 = 140737488355328;
const P48 = 281474976710656;
const TT = new Int16Array(8);
const OUT = new Int16Array(8);
const BCF = BC.map((x) => Int8Array.from(x));

function lanes(R: Rsp, t: number, e: number): void {
  const v = R.v;
  const bc = BCF[e];
  for (let i = 0; i < 8; i++) TT[i] = v[t + bc[i]];
}
function store(R: Rsp, d: number): void {
  const v = R.v;
  for (let i = 0; i < 8; i++) v[d + i] = OUT[i];
}
function c16(h: number): number {
  return h > 32767 ? 32767 : h < -32768 ? -32768 : h;
}
function low(R: Rsp, i: number, p: number): void {
  const a = R.acc[i];
  R.acc[i] = Math.floor(a / 65536) * 65536 + (p & 65535);
}

const VF: VecFn[] = [];
VF[0x00] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  const acc = R.acc;
  for (let i = 0; i < 8; i++) {
    const a = v[s + i] * TT[i] * 2 + 32768;
    acc[i] = a;
    OUT[i] = c16(Math.floor(a / 65536));
  }
  store(R, d);
};
VF[0x01] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  const acc = R.acc;
  for (let i = 0; i < 8; i++) {
    const a = v[s + i] * TT[i] * 2 + 32768;
    acc[i] = a;
    const h = Math.floor(a / 65536);
    OUT[i] = a < 0 ? 0 : h > 32767 ? 65535 : h;
  }
  store(R, d);
};
VF[0x04] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  const acc = R.acc;
  for (let i = 0; i < 8; i++) {
    const a = ((v[s + i] & 65535) * (TT[i] & 65535)) >>> 16;
    acc[i] = a;
    OUT[i] = a;
  }
  store(R, d);
};
VF[0x05] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  const acc = R.acc;
  for (let i = 0; i < 8; i++) {
    const a = v[s + i] * (TT[i] & 65535);
    acc[i] = a;
    OUT[i] = a >> 16;
  }
  store(R, d);
};
VF[0x06] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  const acc = R.acc;
  for (let i = 0; i < 8; i++) {
    const a = (v[s + i] & 65535) * TT[i];
    acc[i] = a;
    OUT[i] = a;
  }
  store(R, d);
};
VF[0x07] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  const acc = R.acc;
  for (let i = 0; i < 8; i++) {
    const p = v[s + i] * TT[i];
    acc[i] = p * 65536;
    OUT[i] = c16(p);
  }
  store(R, d);
};
VF[0x08] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  const acc = R.acc;
  for (let i = 0; i < 8; i++) {
    let a = acc[i] + v[s + i] * TT[i] * 2;
    if (a >= P47) a -= P48;
    else if (a < -P47) a += P48;
    acc[i] = a;
    OUT[i] = c16(Math.floor(a / 65536));
  }
  store(R, d);
};
function mad(R: Rsp, s: number, t: number, e: number, d: number, kind: number): void {
  lanes(R, t, e);
  const v = R.v;
  const acc = R.acc;
  for (let i = 0; i < 8; i++) {
    const vs = v[s + i];
    const vt = TT[i];
    let p: number;
    if (kind === 0) p = ((vs & 65535) * (vt & 65535)) >>> 16;
    else if (kind === 1) p = vs * (vt & 65535);
    else if (kind === 2) p = (vs & 65535) * vt;
    else p = vs * vt * 65536;
    let a = acc[i] + p;
    if (a >= P47) a -= P48;
    else if (a < -P47) a += P48;
    acc[i] = a;
    const h = Math.floor(a / 65536);
    if (kind === 1 || kind === 3) OUT[i] = c16(h);
    else OUT[i] = h < -32768 ? 0 : h > 32767 ? 65535 : a - h * 65536;
  }
  store(R, d);
}
VF[0x0c] = (R, s, t, e, d) => mad(R, s, t, e, d, 0);
VF[0x0d] = (R, s, t, e, d) => mad(R, s, t, e, d, 1);
VF[0x0e] = (R, s, t, e, d) => mad(R, s, t, e, d, 2);
VF[0x0f] = (R, s, t, e, d) => mad(R, s, t, e, d, 3);
VF[0x10] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  for (let i = 0; i < 8; i++) {
    const p = v[s + i] + TT[i] + ((R.vco >> i) & 1);
    low(R, i, p);
    OUT[i] = c16(p);
  }
  R.vco = 0;
  store(R, d);
};
VF[0x11] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  for (let i = 0; i < 8; i++) {
    const p = v[s + i] - TT[i] - ((R.vco >> i) & 1);
    low(R, i, p);
    OUT[i] = c16(p);
  }
  R.vco = 0;
  store(R, d);
};
VF[0x27] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  for (let i = 0; i < 8; i++) {
    const p = (R.vcc >> i) & 1 ? v[s + i] : TT[i];
    low(R, i, p);
    OUT[i] = p;
  }
  R.vco = 0;
  store(R, d);
};
VF[0x28] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  for (let i = 0; i < 8; i++) {
    const p = v[s + i] & TT[i];
    low(R, i, p);
    OUT[i] = p;
  }
  store(R, d);
};
VF[0x2a] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  for (let i = 0; i < 8; i++) {
    const p = v[s + i] | TT[i];
    low(R, i, p);
    OUT[i] = p;
  }
  store(R, d);
};
VF[0x2c] = (R, s, t, e, d) => {
  lanes(R, t, e);
  const v = R.v;
  for (let i = 0; i < 8; i++) {
    const p = v[s + i] ^ TT[i];
    low(R, i, p);
    OUT[i] = p;
  }
  store(R, d);
};
