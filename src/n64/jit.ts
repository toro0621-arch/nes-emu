// CPU の命令を JavaScript の関数に書き換えて速く動かす（動的再コンパイル）。
// RDRAM にあるプログラムを、分岐までのひとかたまり（ブロック）ごとに 1 つの関数にする。
// よく使う命令（計算・読み書き・分岐）はその場で JavaScript にし、それ以外はふつうの実行（インタープリター）を呼ぶ。
// プログラムが書きかえられたら（DMA や書き込み）、そのページの関数を捨てる

import { CYCLES_PER_OP, type Vr4300 } from './cpu';

type Block = (c: Vr4300) => void;

const MAX_OPS = 64;
/** 1 つの関数にまとめる範囲（2 の何乗バイトか）。大きすぎると関数が大きくなって速くならない */
const REGION = 8;

/** その場で JavaScript にできる SPECIAL の命令 */
const SIMPLE_FUNCT = new Set([
  0x00, 0x02, 0x03, 0x04, 0x06, 0x07, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x16, 0x17, 0x18, 0x19, 0x21, 0x23, 0x24, 0x25, 0x26,
  0x27, 0x2a, 0x2b, 0x2d, 0x2f, 0x38, 0x3a, 0x3b, 0x3c, 0x3e, 0x3f,
]);

/** RDRAM（8MB）で、KSEG0・KSEG1 のアドレスか（下位 2 ビットは alignment 用に別に足す） */
const RAM_MASK = 0xdf800000 | 0;
const KSEG = 0x80000000 | 0;

export class Jit {
  /** 4 バイトごとの、そこから始まるブロック（KSEG0 と KSEG1 は同じ物理アドレスなので同じもの） */
  blocks: (Block | null)[];
  /** ページ（4KB）ごとに、そこから作ったブロックの中身（ワードの番号 → JavaScript） */
  private pageSrc = new Map<number, Map<number, string>>();
  /** ページごとの書き換えの回数（関数を作ったあとに書き換えられたら、その関数はすぐ抜ける） */
  pageGen: Int32Array;
  /** プログラムを関数にしたページの印（書き込まれたら捨てる） */
  codePages: Uint8Array;
  /** 関数にした命令のワードの印（ここに書き込まれたら、そのページの関数を捨てる） */
  codeWords: Uint8Array;
  /** compile が最後に作ったブロックの命令数 */
  private lastLen = 0;
  /** 調べるとき用：作った関数の中身（null なら残さない） */
  debugSrc: Map<number, string> | null = null;
  /** 関数を作れない環境（CSP など）なら false */
  ok = true;

  constructor(
    private cpu: Vr4300,
    ramSize: number,
  ) {
    this.codePages = new Uint8Array(ramSize >> 12);
    this.pageGen = new Int32Array(ramSize >> 12);
    this.codeWords = new Uint8Array(ramSize >> 2);
    this.blocks = new Array<Block | null>(ramSize >> 2).fill(null);
    try {
      new Function('return 1')();
    } catch {
      this.ok = false;
    }
  }

  get(pc: number): Block | null {
    if ((pc & RAM_MASK) !== KSEG) return null;
    const i = (pc & 0x7fffff) >> 2;
    const b = this.blocks[i];
    if (b !== null) return b;
    const body = this.compile(pc);
    if (body === null) return null;
    this.codeWords.fill(1, i, Math.min(this.codeWords.length, i + this.lastLen));
    const page = (pc & 0x7fffff) >> 12;
    this.codePages[page] = 1;
    const region = (pc & 0x7fffff) >> REGION;
    let src = this.pageSrc.get(region);
    if (!src) {
      src = new Map();
      this.pageSrc.set(region, src);
    }
    src.set(i, body);
    // 近くのブロックをまとめて 1 つの関数にし直す（関数の数が多いと、呼ぶたびに遅くなるため）
    const fn = this.buildPage(page, region, src);
    if (!fn) return null;
    for (const k of src.keys()) this.blocks[k] = fn;
    return fn;
  }

  /** ページの中のブロックを、switch で行き来する 1 つの関数にする */
  private buildPage(page: number, region: number, src: Map<number, string>): Block | null {
    const c = this.cpu;
    const gen = this.pageGen[page];
    const cases: string[] = [];
    for (const [k, body] of src) cases.push(`case ${k}:{c.aborted=false;${body}}break;`);
    const code =
      'return function(c){const b=c.bus;let a=0,v=0,t=0;for(;;){switch((c.pc&0x7fffff)>>2){' +
      cases.join('\n') +
      '\ndefault:return;}lo[0]=0;hi[0]=0;' +
      `if(c.aborted||c.branched||c.intReady||b.cycles>=b.stopAt||pg[${page}]!==${gen})return;` +
      `const p=c.pc;if((p&${RAM_MASK})!==${KSEG}||((p&0x7fffff)>>${REGION})!==${region})return;}}`;
    try {
      return new Function('lo', 'hi', 'ram8', 'ram16', 'ram32', 'cp', 'mulHi', 'dsh', 'f32', 'f64', 'fi', 'pg', code)(
        c.lo,
        c.hi,
        c.bus.ram8,
        c.bus.ram16,
        c.bus.ram32,
        this.codeWords,
        mulHi32,
        dshift,
        c.f32,
        c.f64,
        c.fi,
        this.pageGen,
      ) as Block;
    } catch (e) {
      console.error(e);
      this.ok = false;
      return null;
    }
  }

  /** 物理アドレス p のページの関数を捨てる */
  invalidate(p: number): void {
    const page = p >> 12;
    if (!this.codePages[page]) return;
    this.codePages[page] = 0;
    this.pageGen[page]++;
    for (let r = (page << 12) >> REGION; r < ((page + 1) << 12) >> REGION; r++) {
      const src = this.pageSrc.get(r);
      if (!src) continue;
      for (const k of src.keys()) this.blocks[k] = null;
      this.pageSrc.delete(r);
    }
    this.codeWords.fill(0, page << 10, (page + 1) << 10);
    // ブロックはページをまたがないが、遅延スロットのぶん次のページの最初のワードに印があるかもしれない
    if ((page + 1) << 10 < this.codeWords.length) this.codeWords[(page + 1) << 10] = 0;
  }

  invalidateRange(p: number, len: number): void {
    const end = Math.min(this.codePages.length, ((p + len - 1) >> 12) + 1);
    for (let page = Math.max(0, p >> 12); page < end; page++) if (this.codePages[page]) this.invalidate(page << 12);
  }

  clear(): void {
    this.blocks.fill(null);
    this.pageSrc.clear();
    this.pageGen.fill(0);
    this.codePages.fill(0);
    this.codeWords.fill(0);
  }

  // ---- 書き換え ----
  private compile(pc: number): string | null {
    if (!this.ok || (pc & RAM_MASK) !== KSEG || pc & 3) return null;
    const c = this.cpu;
    const ram32 = c.bus.ram32;
    const lines: string[] = [];
    let addr = pc;
    let n = 0;
    let ended = false;
    const pageEnd = (pc & ~0xfff) + 0x1000;
    // 実行した命令のぶんだけ時間を進める（ブロックの途中で抜けるときも、その時点までの数で）
    const cyc = (code: string, k: number) => code.replace(/return;/g, `{b.cycles+=${k * CYCLES_PER_OP};return;}`);
    while (n < MAX_OPS && !ended) {
      const op = ram32[(addr & 0x7fffff) >> 2];
      const kind = this.classify(op);
      if (kind === 'branch') {
        // 遅延スロット（次の 1 命令）も同じページになければ、ここで区切ってふつうに実行する
        if (addr + 4 >= pageEnd) break;
        const slot = ram32[((addr + 4) & 0x7fffff) >> 2];
        if (this.classify(slot) !== 'simple') {
          lines.push(cyc(this.generic(op, addr, true), n + 1));
          n++;
          ended = true;
          break;
        }
        // 条件つきの分岐で、飛ばなかったときの続きも同じページにあれば、そのまま続けて書く（関数を呼ぶ回数を減らす）
        const go = this.conditional(op) && n + 2 < MAX_OPS && addr + 8 < pageEnd;
        lines.push('{' + this.branch(op, addr, slot, n + 2, !go) + '}');
        n += 2;
        if (!go) {
          ended = true;
          break;
        }
        addr += 8;
        continue;
      }
      if (kind === 'end') {
        lines.push(cyc(this.generic(op, addr, true), n + 1));
        n++;
        ended = true;
        break;
      }
      const code =
        kind === 'simple' ? this.simple(op, addr, false) : (this.fpu(op, addr, c.status & 0x24000000) ?? this.generic(op, addr, false));
      lines.push(cyc(code, n + 1));
      n++;
      addr += 4;
      if (addr >= pageEnd) break;
    }
    // 1 命令も書けなかった（ページの終わりの分岐など）ときは、ふつうに実行する
    if (n === 0) return null;
    this.lastLen = Math.max(n, ((addr - pc) >> 2) + 1);
    if (!ended) lines.push(`b.cycles+=${n * CYCLES_PER_OP};c.pc=${addr | 0};c.nextPc=${(addr + 4) | 0};`);
    // ページの関数の中では、ブロックを抜ける return は switch を抜ける break にする
    const body = lines.join('\n').replace(/return;/g, 'break;');
    if (this.debugSrc) this.debugSrc.set(pc, body);
    return body;
  }

  /** simple：その場で書ける命令、generic：インタープリターを呼ぶ、branch：分岐、end：ここでブロックを終える */
  private classify(op: number): 'simple' | 'generic' | 'branch' | 'end' {
    const o = op >>> 26;
    switch (o) {
      case 0x00: {
        const f = op & 63;
        if (f === 0x08 || f === 0x09) return 'branch';
        if (f === 0x0c || f === 0x0d || (f >= 0x30 && f <= 0x36)) return 'end';
        return SIMPLE_FUNCT.has(f) ? 'simple' : 'generic';
      }
      case 0x01: {
        const rt = (op >>> 16) & 31;
        if (rt <= 3 || (rt >= 0x10 && rt <= 0x13)) return 'branch';
        return 'end';
      }
      case 0x02:
      case 0x03:
      case 0x04:
      case 0x05:
      case 0x06:
      case 0x07:
      case 0x14:
      case 0x15:
      case 0x16:
      case 0x17:
        return 'branch';
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c:
      case 0x0d:
      case 0x0e:
      case 0x0f:
      case 0x19:
      case 0x20:
      case 0x21:
      case 0x23:
      case 0x24:
      case 0x25:
      case 0x27:
      case 0x28:
      case 0x29:
      case 0x2b:
      case 0x37:
      case 0x3f:
        return 'simple';
      case 0x2f:
        return 'simple'; // CACHE は何もしない
      case 0x10:
        return 'end';
      case 0x11:
        // COP1 の分岐はインタープリターで
        return ((op >>> 21) & 31) === 8 ? 'end' : 'generic';
    }
    return 'generic';
  }

  /**
   * 浮動小数点（COP1）のよく使う命令をその場で書く。書けないときは null（インタープリターで）。
   * x：書いたときの Status の CU1・FR。実行するときに変わっていたら、インタープリターで実行する
   */
  private fpu(op: number, addr: number, x: number): string | null {
    if (!(x & 0x20000000)) return null;
    const fr = (x & 0x04000000) !== 0;
    const ix = (r: number) => (fr ? r * 2 : (r & ~1) * 2 + (r & 1));
    const dx = (r: number) => (fr ? r : r & ~1);
    const dl = (r: number) => (fr ? r * 2 : (r & ~1) * 2);
    const rs = (op >>> 21) & 31;
    const rt = (op >>> 16) & 31;
    const fs = (op >>> 11) & 31;
    const fd = (op >>> 6) & 31;
    const imm = (op << 16) >> 16;
    const ea = `a=(lo[${rs}]+${imm})|0;`;
    const fail = 'if(c.aborted)return;';
    const pre = this.pre(addr, false);
    let fast: string | null = null;
    switch (op >>> 26) {
      case 0x31: // LWC1
        fast = ea + `if((a&${RAM_MASK | 3})===${KSEG})t=ram32[(a&0x7fffff)>>2];else{${pre}t=c.r32(a);${fail}}fi[${ix(rt)}]=t;`;
        break;
      case 0x39: // SWC1
        fast =
          ea +
          `v=fi[${ix(rt)}];if((a&${RAM_MASK | 3})===${KSEG}){b.writes++;ram32[(a&0x7fffff)>>2]=v;if(cp[(a&0x7fffff)>>2])c.jit.invalidate(a&0x7fffff);}` +
          `else{${pre}c.w32(a,v);${fail}}`;
        break;
      case 0x35: // LDC1
        fast =
          ea +
          `if((a&${RAM_MASK | 7})===${KSEG}){v=ram32[(a&0x7fffff)>>2];t=ram32[((a&0x7fffff)>>2)+1];}` +
          `else{${pre}if(a&7){c.addrError(a,false);return;}v=c.r32(a);${fail}t=c.r32(a+4);${fail}}` +
          `fi[${dl(rt)}]=t;fi[${dl(rt) + 1}]=v;`;
        break;
      case 0x3d: // SDC1
        fast =
          ea +
          `if((a&${RAM_MASK | 7})===${KSEG}){b.writes++;ram32[(a&0x7fffff)>>2]=fi[${dl(rt) + 1}];ram32[((a&0x7fffff)>>2)+1]=fi[${dl(rt)}];if(cp[(a&0x7fffff)>>2]|cp[((a&0x7fffff)>>2)+1])c.jit.invalidate(a&0x7fffff);}` +
          `else{${pre}if(a&7){c.addrError(a,true);return;}c.w32(a,fi[${dl(rt) + 1}]);${fail}c.w32(a+4,fi[${dl(rt)}]);${fail}}`;
        break;
      case 0x11: {
        const f = op & 63;
        if (rs === 0x00) fast = rt ? `v=fi[${ix(fs)}];lo[${rt}]=v;hi[${rt}]=v>>31;` : '';
        else if (rs === 0x04) fast = `fi[${ix(fs)}]=lo[${rt}];`;
        else if (rs === 0x10 || rs === 0x11) {
          const S = rs === 0x10;
          const get = (r: number) => (S ? `f32[${ix(r)}]` : `f64[${dx(r)}]`);
          const set = (v: string) => (S ? `f32[${ix(fd)}]=${v};` : `f64[${dx(fd)}]=${v};`);
          switch (f) {
            case 0x00:
              fast = set(`${get(fs)}+${get(rt)}`);
              break;
            case 0x01:
              fast = set(`${get(fs)}-${get(rt)}`);
              break;
            case 0x02:
              fast = set(`${get(fs)}*${get(rt)}`);
              break;
            case 0x03:
              fast = set(`${get(fs)}/${get(rt)}`);
              break;
            case 0x04:
              fast = set(`Math.sqrt(${get(fs)})`);
              break;
            case 0x05:
              fast = set(`Math.abs(${get(fs)})`);
              break;
            case 0x06:
              fast = S ? `fi[${ix(fd)}]=fi[${ix(fs)}];` : `fi[${dl(fd)}]=fi[${dl(fs)}];fi[${dl(fd) + 1}]=fi[${dl(fs) + 1}];`;
              break;
            case 0x07:
              fast = set(`-${get(fs)}`);
              break;
            case 0x20:
              if (!S) fast = `f32[${ix(fd)}]=f64[${dx(fs)}];`;
              break;
            case 0x21:
              if (S) fast = `f64[${dx(fd)}]=f32[${ix(fs)}];`;
              break;
            default:
              if (f >= 0x30) fast = `c.fcmp(${op | 0},${get(fs)},${get(rt)});`;
              else if (f === 0x0d || f === 0x24) fast = `${pre}c.setW(${fd},${get(fs)},${f === 0x0d ? 1 : 'c.fcr31&3'});${fail}`;
          }
        } else if (rs === 0x14) {
          if ((op & 63) === 0x20) fast = `f32[${ix(fd)}]=fi[${ix(fs)}];`;
          else if ((op & 63) === 0x21) fast = `f64[${dx(fd)}]=fi[${ix(fs)}];`;
        }
        break;
      }
    }
    if (fast === null) return null;
    return `if((c.status&${0x24000000})===${x}){${fast}}else{${this.generic(op, addr, false)}}`;
  }

  /** インタープリターで 1 命令（end なら、そのあとブロックを終える） */
  private generic(op: number, addr: number, end: boolean): string {
    const s = `c.curPc=${addr | 0};c.inDelay=false;c.branched=false;c.pc=${(addr + 4) | 0};c.nextPc=${(addr + 8) | 0};c.execute(${op | 0});c.lo[0]=0;c.hi[0]=0;`;
    return end ? s + 'return;' : s + 'if(c.aborted)return;';
  }

  /** 失敗したら（例外）ブロックを抜けるための前置き */
  private pre(addr: number, slot: boolean): string {
    return `c.curPc=${addr | 0};c.inDelay=${slot};`;
  }

  private simple(op: number, addr: number, slot: boolean): string {
    const rs = (op >>> 21) & 31;
    const rt = (op >>> 16) & 31;
    const rd = (op >>> 11) & 31;
    const sa = (op >>> 6) & 31;
    const imm = (op << 16) >> 16;
    const uimm = op & 0xffff;
    const S = (r: number, v: string) => (r ? `v=${v};lo[${r}]=v;hi[${r}]=v>>31;` : '');
    const ea = `a=(lo[${rs}]+${imm})|0;`;
    const fail = 'if(c.aborted)return;';
    switch (op >>> 26) {
      case 0x00:
        switch (op & 63) {
          case 0x00:
            return S(rd, `lo[${rt}]<<${sa}`);
          case 0x02:
            return S(rd, `lo[${rt}]>>>${sa}`);
          case 0x03:
            return S(rd, sa ? `(lo[${rt}]>>>${sa})|(hi[${rt}]<<${32 - sa})` : `lo[${rt}]`);
          case 0x04:
            return S(rd, `lo[${rt}]<<(lo[${rs}]&31)`);
          case 0x06:
            return S(rd, `lo[${rt}]>>>(lo[${rs}]&31)`);
          case 0x07:
            return rd ? `t=lo[${rs}]&31;${S(rd, `t?(lo[${rt}]>>>t)|(hi[${rt}]<<(32-t)):lo[${rt}]`)}` : '';
          case 0x0f:
            return '';
          case 0x10:
            return rd ? `lo[${rd}]=c.mhiL;hi[${rd}]=c.mhiH;` : '';
          case 0x11:
            return `c.mhiL=lo[${rs}];c.mhiH=hi[${rs}];`;
          case 0x12:
            return rd ? `lo[${rd}]=c.mloL;hi[${rd}]=c.mloH;` : '';
          case 0x13:
            return `c.mloL=lo[${rs}];c.mloH=hi[${rs}];`;
          case 0x14:
          case 0x16:
          case 0x17: {
            const kind = (op & 63) === 0x14 ? 0 : (op & 63) === 0x16 ? 1 : 2;
            return rd ? `dsh(lo,hi,${rd},${rt},lo[${rs}]&63,${kind});` : '';
          }
          case 0x18:
          case 0x19: {
            const signed = (op & 63) === 0x18;
            return `a=lo[${rs}];t=lo[${rt}];v=Math.imul(a,t);c.mloL=v;c.mloH=v>>31;v=mulHi(a,t,${signed});c.mhiL=v;c.mhiH=v>>31;`;
          }
          case 0x21:
            return S(rd, `(lo[${rs}]+lo[${rt}])|0`);
          case 0x23:
            return S(rd, `(lo[${rs}]-lo[${rt}])|0`);
          case 0x24:
            return rd ? `lo[${rd}]=lo[${rs}]&lo[${rt}];hi[${rd}]=hi[${rs}]&hi[${rt}];` : '';
          case 0x25:
            return rd ? `lo[${rd}]=lo[${rs}]|lo[${rt}];hi[${rd}]=hi[${rs}]|hi[${rt}];` : '';
          case 0x26:
            return rd ? `lo[${rd}]=lo[${rs}]^lo[${rt}];hi[${rd}]=hi[${rs}]^hi[${rt}];` : '';
          case 0x27:
            return rd ? `lo[${rd}]=~(lo[${rs}]|lo[${rt}]);hi[${rd}]=~(hi[${rs}]|hi[${rt}]);` : '';
          case 0x2a:
            return rd
              ? `lo[${rd}]=(hi[${rs}]<hi[${rt}]||(hi[${rs}]===hi[${rt}]&&(lo[${rs}]>>>0)<(lo[${rt}]>>>0)))?1:0;hi[${rd}]=0;`
              : '';
          case 0x2b:
            return rd
              ? `lo[${rd}]=((hi[${rs}]>>>0)<(hi[${rt}]>>>0)||(hi[${rs}]===hi[${rt}]&&(lo[${rs}]>>>0)<(lo[${rt}]>>>0)))?1:0;hi[${rd}]=0;`
              : '';
          case 0x2d:
            return rd
              ? `a=lo[${rs}];v=(a+lo[${rt}])|0;hi[${rd}]=(hi[${rs}]+hi[${rt}]+((v>>>0)<(a>>>0)?1:0))|0;lo[${rd}]=v;`
              : '';
          case 0x2f:
            return rd
              ? `a=lo[${rs}];t=lo[${rt}];v=(a-t)|0;hi[${rd}]=(hi[${rs}]-hi[${rt}]-((a>>>0)<(t>>>0)?1:0))|0;lo[${rd}]=v;`
              : '';
          case 0x38:
            return rd ? `dsh(lo,hi,${rd},${rt},${sa},0);` : '';
          case 0x3a:
            return rd ? `dsh(lo,hi,${rd},${rt},${sa},1);` : '';
          case 0x3b:
            return rd ? `dsh(lo,hi,${rd},${rt},${sa},2);` : '';
          case 0x3c:
            return rd ? `dsh(lo,hi,${rd},${rt},${sa + 32},0);` : '';
          case 0x3e:
            return rd ? `dsh(lo,hi,${rd},${rt},${sa + 32},1);` : '';
          case 0x3f:
            return rd ? `dsh(lo,hi,${rd},${rt},${sa + 32},2);` : '';
        }
        break;
      case 0x09:
        return S(rt, `(lo[${rs}]+${imm})|0`);
      case 0x0a:
        return rt
          ? `lo[${rt}]=(hi[${rs}]<${imm >> 31}||(hi[${rs}]===${imm >> 31}&&(lo[${rs}]>>>0)<${imm >>> 0}))?1:0;hi[${rt}]=0;`
          : '';
      case 0x0b:
        return rt
          ? `lo[${rt}]=((hi[${rs}]>>>0)<${(imm >> 31) >>> 0}||(hi[${rs}]===${imm >> 31}&&(lo[${rs}]>>>0)<${imm >>> 0}))?1:0;hi[${rt}]=0;`
          : '';
      case 0x0c:
        return rt ? `lo[${rt}]=lo[${rs}]&${uimm};hi[${rt}]=0;` : '';
      case 0x0d:
        return rt ? `lo[${rt}]=lo[${rs}]|${uimm};hi[${rt}]=hi[${rs}];` : '';
      case 0x0e:
        return rt ? `lo[${rt}]=lo[${rs}]^${uimm};hi[${rt}]=hi[${rs}];` : '';
      case 0x0f:
        return S(rt, `${(op << 16) | 0}`);
      case 0x19:
        return rt ? `a=lo[${rs}];v=(a+${imm})|0;hi[${rt}]=(hi[${rs}]+${imm >> 31}+((v>>>0)<(a>>>0)?1:0))|0;lo[${rt}]=v;` : '';
      case 0x2f:
        return '';
      // ---- 読み込み ----
      case 0x20:
      case 0x24:
        return (
          ea +
          `if((a&${RAM_MASK})===${KSEG})t=ram8[(a&0x7fffff)^3];else{${this.pre(addr, slot)}t=c.r8(a);${fail}}` +
          (rt ? (op >>> 26 === 0x20 ? S(rt, '(t<<24)>>24') : `lo[${rt}]=t;hi[${rt}]=0;`) : '')
        );
      case 0x21:
      case 0x25:
        return (
          ea +
          `if((a&${RAM_MASK | 1})===${KSEG})t=ram16[((a&0x7fffff)^2)>>1];else{${this.pre(addr, slot)}t=c.r16(a);${fail}}` +
          (rt ? (op >>> 26 === 0x21 ? S(rt, '(t<<16)>>16') : `lo[${rt}]=t;hi[${rt}]=0;`) : '')
        );
      case 0x23:
      case 0x27:
        return (
          ea +
          `if((a&${RAM_MASK | 3})===${KSEG})t=ram32[(a&0x7fffff)>>2];else{${this.pre(addr, slot)}t=c.r32(a);${fail}}` +
          (rt ? (op >>> 26 === 0x23 ? `lo[${rt}]=t;hi[${rt}]=t>>31;` : `lo[${rt}]=t;hi[${rt}]=0;`) : '')
        );
      case 0x37:
        return (
          ea +
          `if((a&${RAM_MASK | 7})===${KSEG}){v=ram32[(a&0x7fffff)>>2];t=ram32[((a&0x7fffff)>>2)+1];}` +
          `else{${this.pre(addr, slot)}if(a&7){c.addrError(a,false);return;}v=c.r32(a);${fail}t=c.r32(a+4);${fail}}` +
          (rt ? `hi[${rt}]=v;lo[${rt}]=t;` : '')
        );
      // ---- 書き込み ----
      case 0x28:
        return (
          ea +
          `if((a&${RAM_MASK})===${KSEG}){b.writes++;ram8[(a&0x7fffff)^3]=lo[${rt}];if(cp[(a&0x7fffff)>>2])c.jit.invalidate(a&0x7fffff);}` +
          `else{${this.pre(addr, slot)}c.w8(a,lo[${rt}]&255);${fail}}`
        );
      case 0x29:
        return (
          ea +
          `if((a&${RAM_MASK | 1})===${KSEG}){b.writes++;ram16[((a&0x7fffff)^2)>>1]=lo[${rt}];if(cp[(a&0x7fffff)>>2])c.jit.invalidate(a&0x7fffff);}` +
          `else{${this.pre(addr, slot)}c.w16(a,lo[${rt}]&65535);${fail}}`
        );
      case 0x2b:
        return (
          ea +
          `if((a&${RAM_MASK | 3})===${KSEG}){b.writes++;ram32[(a&0x7fffff)>>2]=lo[${rt}];if(cp[(a&0x7fffff)>>2])c.jit.invalidate(a&0x7fffff);}` +
          `else{${this.pre(addr, slot)}c.w32(a,lo[${rt}]);${fail}}`
        );
      case 0x3f:
        return (
          ea +
          `if((a&${RAM_MASK | 7})===${KSEG}){b.writes++;ram32[(a&0x7fffff)>>2]=hi[${rt}];ram32[((a&0x7fffff)>>2)+1]=lo[${rt}];if(cp[(a&0x7fffff)>>2]|cp[((a&0x7fffff)>>2)+1])c.jit.invalidate(a&0x7fffff);}` +
          `else{${this.pre(addr, slot)}if(a&7){c.addrError(a,true);return;}c.w32(a,hi[${rt}]);${fail}c.w32(a+4,lo[${rt}]);${fail}}`
        );
    }
    // ここには来ない（classify と合わせてある）
    return this.generic(op, addr, false);
  }

  /** 分岐 + 遅延スロット */
  /** 条件つきの分岐（飛ばないこともある）か */
  private conditional(op: number): boolean {
    const o = op >>> 26;
    return o === 0x01 || (o >= 0x04 && o <= 0x07) || (o >= 0x14 && o <= 0x17);
  }

  /** k：ここまでに実行した命令の数（遅延スロットを含む）。final：ここでブロックを終える */
  private branch(op: number, addr: number, slot: number, k: number, final: boolean): string {
    const adv = `b.cycles+=${k * CYCLES_PER_OP};`;
    const rs = (op >>> 21) & 31;
    const rt = (op >>> 16) & 31;
    const imm = (op << 16) >> 16;
    const rel = (addr + 4 + (imm << 2)) | 0;
    const next = (addr + 8) | 0;
    const link = (r: number) => (r ? `lo[${r}]=${next};hi[${r}]=${next >> 31};` : '');
    const slotCode = this.simple(slot, addr + 4, true).replace(/return;/g, `{${adv}return;}`);
    const idle = (target: string) => `t=${addr | 0}-(${target});if(t>=0&&t<=32){c.curPc=${addr | 0};c.checkIdle(${target});}`;
    // 条件つきの分岐
    const cond = (expr: string, likely: boolean, linkReg = 0) => {
      const head = `const take=${expr};${link(linkReg)}`;
      const jump = `c.pc=${rel};c.nextPc=${(rel + 4) | 0};${idle(String(rel))}`;
      if (!final) {
        // 飛んだらここで抜ける。飛ばなければ続きへ
        return likely
          ? `${head}if(take){${slotCode}${adv}${jump}return;}`
          : `${head}${slotCode}if(take){${adv}${jump}return;}`;
      }
      const fall = `c.pc=${next};c.nextPc=${(next + 4) | 0};`;
      return (
        adv +
        head +
        (likely ? `if(take){${slotCode}${jump}}else{${fall}}` : `${slotCode}if(take){${jump}}else{${fall}}`)
      );
    };
    const eq = `(lo[${rs}]===lo[${rt}]&&hi[${rs}]===hi[${rt}])`;
    const lez = `(hi[${rs}]<0||(hi[${rs}]===0&&lo[${rs}]===0))`;
    const gtz = `(hi[${rs}]>0||(hi[${rs}]===0&&lo[${rs}]!==0))`;
    switch (op >>> 26) {
      case 0x00: {
        // JR・JALR
        const rd = (op >>> 11) & 31;
        const jalr = (op & 63) === 0x09;
        return `${adv}const tgt=lo[${rs}];${jalr ? link(rd) : ''}${slotCode}c.pc=tgt;c.nextPc=(tgt+4)|0;${idle('tgt')}`;
      }
      case 0x01: {
        const neg = `(hi[${rs}]<0)`;
        const pos = `(hi[${rs}]>=0)`;
        switch (rt) {
          case 0x00:
            return cond(neg, false);
          case 0x01:
            return cond(pos, false);
          case 0x02:
            return cond(neg, true);
          case 0x03:
            return cond(pos, true);
          case 0x10:
            return cond(neg, false, 31);
          case 0x11:
            return cond(pos, false, 31);
          case 0x12:
            return cond(neg, true, 31);
          default:
            return cond(pos, true, 31);
        }
      }
      case 0x02:
      case 0x03: {
        const tgt = ((addr + 4) & 0xf0000000) | ((op & 0x3ffffff) << 2);
        return `${adv}${op >>> 26 === 0x03 ? link(31) : ''}${slotCode}c.pc=${tgt | 0};c.nextPc=${(tgt + 4) | 0};${idle(String(tgt | 0))}`;
      }
      case 0x04:
        return cond(eq, false);
      case 0x05:
        return cond(`!${eq}`, false);
      case 0x06:
        return cond(lez, false);
      case 0x07:
        return cond(gtz, false);
      case 0x14:
        return cond(eq, true);
      case 0x15:
        return cond(`!${eq}`, true);
      case 0x16:
        return cond(lez, true);
      default:
        return cond(gtz, true);
    }
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

/** 64 ビットのシフト（kind：0 左、1 右、2 符号つきの右） */
function dshift(lo: Int32Array, hi: Int32Array, rd: number, rt: number, s: number, kind: number): void {
  let l = lo[rt];
  let h = hi[rt];
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
  lo[rd] = l;
  hi[rd] = h;
}
