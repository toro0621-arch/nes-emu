// プレイステーションの CPU の命令を JavaScript の関数に書き換えて速く動かす（動的再コンパイル）。
//
// メインメモリ（2MB）にあるプログラムを、分岐までのひとかたまり（ブロック）ごとに JavaScript にする。
// インタープリター（cpu.ts）と結果が 1 クロックも変わらないように作ってある：
//  - ロードした値が 1 命令遅れて届く（ロード遅延）のを、どの命令のあとで書くかまで同じにする
//  - ブロックは、次の出来事（stopAt）までに最後まで実行できるときだけ使う（割り込みの起きる時刻が変わらない）
//  - 入出力のレジスタを読み書きする直前には、時刻をインタープリターと同じにする。入出力に書いたら、すぐ抜ける
//  - 例外が起きる命令（アドレスのずれ・あふれ）は、その命令の手前で抜けて、インタープリターに任せる
// よく通るところだけ関数にし（HOT）、落ち着いたら近くのブロックを 1 つの関数にまとめる（N64 と同じ。小さい関数が
// たくさんあると、JavaScript のエンジンがなかなか速い形にしてくれないため）。

import { mulHi, type R3000 } from './cpu';

type Block = (c: R3000) => void;

const MAX_OPS = 64;
/** この回数だけ入口として通ったら関数にする */
const HOT = 5000;
/** 1 つの関数にまとめる範囲（2 の何乗バイトか） */
const REGION = 10;
/** 新しいブロックが出なくなってから、まとめるまでのフレーム数 */
const SETTLE = 20;
/** 1 つの関数にまとめる中身の大きさの上限（文字数） */
const MAX_SRC = 30000;
const RAM_WORDS = (2 * 1024 * 1024) >> 2;

/** 命令 1 つぶんの JavaScript */
interface Op {
  code: string;
  /** setReg で書くレジスタ（ロード遅延の取り消しに使う） */
  write: number;
  /** 1 命令遅れて書くロードのレジスタ（値は N に入れる） */
  load: number;
  /** この命令のクロック（2 ＋ 掛け算・割り算などのぶん） */
  cycles: number;
}

export class PsxJit {
  /** 4 バイトごとの、そこから始まるブロック */
  private blocks: (Block | null)[] = new Array<Block | null>(RAM_WORDS).fill(null);
  /** ブロックを作ったときのアドレスの上位 3 ビット（KUSEG・KSEG0・KSEG1 は同じメモリだが、分けておく） */
  private seg = new Uint8Array(RAM_WORDS);
  private heat = new Uint16Array(RAM_WORDS);
  /** 4KB ごとの、関数にしたプログラムがあるかの印（書き込まれたら捨てる） */
  codePages = new Uint8Array(512);
  /** ページごとの書き換えの回数（関数を作ったあとに書き換えられたら、その関数はすぐ抜ける） */
  private pageGen = new Int32Array(512);
  private regionSrc = new Map<number, Map<number, string>>();
  private pending = new Map<number, number>();
  private tickNo = 0;
  ok = true;

  constructor(private cpu: R3000) {
    try {
      new Function('return 1')();
    } catch {
      this.ok = false;
    }
  }

  peek(pc: number): Block | null {
    if ((pc & 0x1fffffff) >= 0x800000) return null;
    const i = (pc & 0x1fffff) >> 2;
    return this.seg[i] === pc >>> 29 ? this.blocks[i] : null;
  }

  get(pc: number): Block | null {
    if (!this.ok || (pc & 0x1fffffff) >= 0x800000) return null;
    const i = (pc & 0x1fffff) >> 2;
    const b = this.blocks[i];
    if (b !== null && this.seg[i] === pc >>> 29) return b;
    if (this.heat[i] < HOT) {
      this.heat[i]++;
      return null;
    }
    const body = this.compile(pc);
    if (body === null) {
      this.heat[i] = 0;
      return null;
    }
    const page = (pc & 0x1fffff) >> 12;
    this.codePages[page] = 1;
    const region = (pc & 0x1fffff) >> REGION;
    let src = this.regionSrc.get(region);
    if (!src) {
      src = new Map();
      this.regionSrc.set(region, src);
    }
    // 同じ場所で別の区画（KSEG0 と KUSEG など）のものがあれば置きかえる
    src.set(i, body);
    this.seg[i] = pc >>> 29;
    const fn = this.build(page, region, pc >>> 29, new Map([[i, body]]));
    if (!fn) return null;
    this.blocks[i] = fn;
    this.pending.set(region, this.tickNo);
    return fn;
  }

  /** 1 フレームに 1 回。しばらく新しいブロックが出ていない範囲を、1 つの関数にまとめ直す */
  tick(): void {
    this.tickNo++;
    if (this.pending.size === 0) return;
    for (const [region, at] of this.pending) {
      if (this.tickNo - at < SETTLE) continue;
      this.pending.delete(region);
      const src = this.regionSrc.get(region);
      if (!src || src.size < 2) continue;
      const page = (region << REGION) >> 12;
      // 区画ごとに分ける（KSEG0 と KUSEG の両方から呼ばれる所があれば別々に）
      const bySeg = new Map<number, number[]>();
      for (const k of src.keys()) {
        const s = this.seg[k];
        let l = bySeg.get(s);
        if (!l) bySeg.set(s, (l = []));
        l.push(k);
      }
      for (const [seg, keys] of bySeg) {
        keys.sort((a, b) => a - b);
        let part = new Map<number, string>();
        let size = 0;
        const flush = () => {
          if (part.size === 0) return;
          const fn = this.build(page, region, seg, part);
          if (fn) for (const k of part.keys()) this.blocks[k] = fn;
          part = new Map();
          size = 0;
        };
        for (const k of keys) {
          const body = src.get(k)!;
          if (size + body.length > MAX_SRC) flush();
          part.set(k, body);
          size += body.length;
        }
        flush();
      }
    }
  }

  private build(page: number, region: number, seg: number, src: Map<number, string>): Block | null {
    const c = this.cpu;
    const bus = c.bus as unknown as { ram32: Int32Array; ram16: Uint16Array; ram: Uint8Array; scratch32: Int32Array; scratch16: Uint16Array; scratch: Uint8Array };
    const gen = this.pageGen[page];
    const cases: string[] = [];
    for (const [k, body] of src) cases.push(`case ${k}:{${body}}break;`);
    const code =
      'return function(c){const b=c.bus,r=c.r;let a=0,v=0,t=0,p=0,L=0,N=0,PR=0,PV=0;for(;;){switch((c.pc&0x1fffff)>>2){' +
      cases.join('\n') +
      '\ndefault:return;}' +
      `if(c.branched||b.irqPending||b.cycles>=b.stopAt||pg[${page}]!==${gen})return;` +
      `p=c.pc;if((p&0x1fffffff)>=0x800000||((p&0x1fffff)>>${REGION})!==${region}||(p>>>29)!==${seg})return;}}`;
    try {
      return new Function('ram32', 'ram16', 'ram8', 's32', 's16', 's8', 'cp', 'mulHi', 'pg', code)(
        bus.ram32,
        bus.ram16,
        bus.ram,
        bus.scratch32,
        bus.scratch16,
        bus.scratch,
        this.codePages,
        mulHi,
        this.pageGen,
      ) as Block;
    } catch (e) {
      console.error(e);
      this.ok = false;
      return null;
    }
  }

  /** 物理アドレス p（メインメモリ）のページの関数を捨てる */
  invalidate(p: number): void {
    const page = (p & 0x1fffff) >> 12;
    if (!this.codePages[page]) return;
    this.codePages[page] = 0;
    this.pageGen[page]++;
    this.heat.fill(0, page << 10, (page + 1) << 10);
    for (let r = (page << 12) >> REGION; r < ((page + 1) << 12) >> REGION; r++) {
      const src = this.regionSrc.get(r);
      if (!src) continue;
      for (const k of src.keys()) this.blocks[k] = null;
      this.regionSrc.delete(r);
      this.pending.delete(r);
    }
  }

  invalidateRange(p: number, len: number): void {
    p &= 0x1fffff;
    const last = Math.min(511, (p + len - 1) >> 12);
    for (let page = p >> 12; page <= last; page++) if (this.codePages[page]) this.invalidate(page << 12);
  }

  clear(): void {
    this.blocks.fill(null);
    this.heat.fill(0);
    this.codePages.fill(0);
    this.pageGen.fill(0);
    this.regionSrc.clear();
    this.pending.clear();
  }

  // ---- 命令を JavaScript にする ----

  /** pc から始まるブロックの JavaScript（作れなければ null） */
  private compile(pc: number): string | null {
    const ram32 = (this.cpu.bus as unknown as { ram32: Int32Array }).ram32;
    const word = (a: number) => ram32[(a & 0x1fffff) >> 2];
    const pageEnd = (pc & ~0xfff) + 0x1000;
    let out = '';
    let addr = pc;
    /** ここまでに実行した命令のクロック（まだ b.cycles に足していない） */
    let cyc = 0;
    /** いちばんかかったときのクロック（入口で、次の出来事までに終わるか調べる） */
    let maxCyc = 0;
    /** 前の命令のロード（この命令のあとで書く）。-1 = 入口で渡されたもの（PR） */
    let pend = -1;
    let n = 0;
    // ブロックの手前で抜ける（その命令からインタープリター）。ロード遅延は c.ldReg に戻す
    const exitAt = (at: number, cycles: number, pendReg: number, extra = '') => {
      let s = `b.cycles+=${cycles};c.pc=${at | 0};c.nextPc=${(at + 4) | 0};`;
      if (pendReg === -1) s += 'c.ldReg=PR;c.ldVal=PV;';
      else if (pendReg > 0) s += `c.ldReg=${pendReg};c.ldVal=L;`;
      return s + extra + 'break;';
    };
    // 入口：インタープリターから渡されたロード（PR）を受け取る
    out += 'PR=c.ldReg;PV=c.ldVal;c.ldReg=0;';
    const entryAt = out.length;
    while (n < MAX_OPS) {
      const op = word(addr);
      const kind = classify(op);
      if (kind === 'stop') break;
      if (kind === 'branch') {
        if (addr + 4 >= pageEnd) break;
        const slot = word(addr + 4);
        const sk = classify(slot);
        if (sk !== 'simple') break;
        // 分岐の命令（遅延スロットは、前のロードを書いたあとなので、ロード中のものはない）
        const br = branchCode(op, addr);
        const so = this.op(slot, addr + 4, 0);
        if (!so) break;
        const k1 = cyc + 2; // 分岐まで
        const k2 = k1 + so.cycles; // 遅延スロットまで
        maxCyc = Math.max(maxCyc, k2);
        // 分岐の計算（ロード遅延はまだ書かない）
        out += br.pre;
        // 自分へ戻る短いループなら、待ちループかどうか調べる（インタープリターと同じく、ロードを書く前・遅延スロットの前に）
        // 待ちループで次の出来事まで時間を飛ばしたら、インタープリターと同じく遅延スロットの手前でいったん止まる
        const idle = br.idle
          ? `if(take){b.cycles+=${k1};${br.idle}b.cycles-=${k1};if(b.cycles+${k1}>=b.stopAt)IDLE_EXIT}`
          : '';
        out += idle.replace('IDLE_EXIT', `{${commit(pend, br.write)}${exitAtSlot(addr + 4, k1, br.target)}}`);
        // 分岐の命令のあと：前のロードを書く（リンクで同じレジスタに書いたら取り消し）
        out += commit(pend, br.write);
        // 遅延スロット
        out += so.code
          .replace(/\bEXIT_BEFORE\b/g, `{${slotExit(addr + 4, k1, br.target)}}`)
          .replace(/\bIO_CYC\b/g, String(k1 + 2));
        // 遅延スロットのロードは、次の命令（分岐先）のあとで書く
        const after = so.load ? `c.ldReg=${so.load};c.ldVal=N;` : '';
        out += `b.cycles+=${k2};${after}if(take){c.pc=${br.target};c.nextPc=(c.pc+4)|0;}else{c.pc=${(addr + 8) | 0};c.nextPc=${(addr + 12) | 0};}break;`;
        n += 2;
        return finish(out, entryAt, maxCyc);
      }
      const o = this.op(op, addr, pend === -1 ? 'PR' : pend);
      if (!o) break;
      // 例外になりそうなら、この命令の手前で抜ける
      let code = o.code.replace(/\bEXIT_BEFORE\b/g, `{${exitAt(addr, cyc, pend)}}`).replace(/\bIO_CYC\b/g, String(cyc + 2));
      cyc += o.cycles;
      maxCyc = Math.max(maxCyc, cyc);
      code += commit(pend, o.write || o.load);
      // 入出力に書いたら、すぐ抜ける（割り込みが起きるかもしれない）
      const nextPend = o.load;
      code += o.code.includes('IOW=1') ? `if(IOW){${exitAt(addr + 4, cyc, nextPend, '')}}` : '';
      if (nextPend) code += 'L=N;';
      out += code;
      pend = nextPend;
      addr += 4;
      n++;
      if (addr >= pageEnd) break;
    }
    if (n === 0) return null;
    // 分岐なしで終わり（ページの終わり・命令の数・関数にできない命令の手前）
    out += exitAt(addr, cyc, pend);
    return finish(out, entryAt, maxCyc);

    function finish(body: string, _at: number, maxc: number): string {
      // 次の出来事までに終われないときは、何もせずにインタープリターへ
      return `if(b.cycles+${maxc}>b.stopAt)return;let IOW=0;` + body;
    }

    /** 遅延スロットの手前で抜ける（分岐は済んでいる） */
    function exitAtSlot(slotAddr: number, cycles: number, target: string): string {
      return `b.cycles+=${cycles};c.pc=${slotAddr | 0};c.nextPc=${target};c.branched=true;break;`;
    }
    /** 遅延スロットの命令の手前で抜ける（例外はインタープリターで） */
    function slotExit(slotAddr: number, cycles: number, target: string): string {
      return `b.cycles+=${cycles};c.pc=${slotAddr | 0};if(take){c.nextPc=${target};c.branched=true;}else c.nextPc=${(slotAddr + 4) | 0};break;`;
    }
    /** 前の命令のロードを書く（この命令が同じレジスタに書いたら取り消し） */
    function commit(p: number, written: number): string {
      if (p === -1) return written ? `if(PR!==0&&PR!==${written})r[PR]=PV;` : 'if(PR!==0)r[PR]=PV;';
      if (p > 0 && p !== written) return `r[${p}]=L;`;
      return '';
    }
  }

  /** 分岐以外の命令 1 つ。cur：ロード中のレジスタ（LWL・LWR が使う） */
  private op(op: number, addr: number, cur: number | 'PR'): Op | null {
    const rs = (op >>> 21) & 31;
    const rt = (op >>> 16) & 31;
    const rd = (op >>> 11) & 31;
    const sa = (op >>> 6) & 31;
    const imm = (op << 16) >> 16;
    const R = (i: number) => (i === 0 ? '0' : `r[${i}]`);
    const set = (d: number, e: string): Op => ({ code: d ? `r[${d}]=${e};` : '', write: d, load: 0, cycles: 2 });
    const ea = `a=(${R(rs)}+${imm})|0;p=a&0x1fffffff;`;
    // 入出力を読むときは、時刻をインタープリターと同じにしてから
    const io = (e: string) => `{b.cycles+=IO_CYC;${e};b.cycles-=IO_CYC;}`;
    const ld = (e: string): Op => ({ code: e, write: 0, load: rt, cycles: 2 });
    const st = (e: string): Op => ({ code: e, write: 0, load: 0, cycles: 2 });
    const curExpr = cur === 'PR' ? `(PR===${rt}?PV:${R(rt)})` : cur === rt && rt ? 'L' : R(rt);
    switch (op >>> 26) {
      case 0x00:
        switch (op & 63) {
          case 0x00:
            return set(rd, `${R(rt)}<<${sa}`);
          case 0x02:
            return set(rd, `${R(rt)}>>>${sa}|0`);
          case 0x03:
            return set(rd, `${R(rt)}>>${sa}`);
          case 0x04:
            return set(rd, `${R(rt)}<<(${R(rs)}&31)`);
          case 0x06:
            return set(rd, `${R(rt)}>>>(${R(rs)}&31)|0`);
          case 0x07:
            return set(rd, `${R(rt)}>>(${R(rs)}&31)`);
          case 0x10:
            return set(rd, 'c.hi');
          case 0x11:
            return { code: `c.hi=${R(rs)};`, write: 0, load: 0, cycles: 2 };
          case 0x12:
            return set(rd, 'c.lo');
          case 0x13:
            return { code: `c.lo=${R(rs)};`, write: 0, load: 0, cycles: 2 };
          case 0x18:
          case 0x19:
            return {
              code: `a=${R(rs)};t=${R(rt)};c.lo=Math.imul(a,t);c.hi=mulHi(a,t,${(op & 63) === 0x18});`,
              write: 0,
              load: 0,
              cycles: 8,
            };
          case 0x1a:
            return {
              code:
                `a=${R(rs)};t=${R(rt)};if(t===0){c.hi=a;c.lo=a>=0?-1:1;}else if(a===-0x80000000&&t===-1){c.hi=0;c.lo=a;}` +
                `else{c.lo=(a/t)|0;c.hi=a%t|0;}`,
              write: 0,
              load: 0,
              cycles: 36,
            };
          case 0x1b:
            return {
              code: `a=${R(rs)}>>>0;t=${R(rt)}>>>0;if(t===0){c.hi=a|0;c.lo=-1;}else{c.lo=Math.floor(a/t)|0;c.hi=a%t|0;}`,
              write: 0,
              load: 0,
              cycles: 36,
            };
          case 0x20: // ADD（あふれたら例外）
            return {
              code: `a=${R(rs)};t=${R(rt)};v=(a+t)|0;if(~(a^t)&(a^v)&0x80000000)EXIT_BEFORE;${rd ? `r[${rd}]=v;` : ''}`,
              write: rd,
              load: 0,
              cycles: 2,
            };
          case 0x21:
            return set(rd, `(${R(rs)}+${R(rt)})|0`);
          case 0x22:
            return {
              code: `a=${R(rs)};t=${R(rt)};v=(a-t)|0;if((a^t)&(a^v)&0x80000000)EXIT_BEFORE;${rd ? `r[${rd}]=v;` : ''}`,
              write: rd,
              load: 0,
              cycles: 2,
            };
          case 0x23:
            return set(rd, `(${R(rs)}-${R(rt)})|0`);
          case 0x24:
            return set(rd, `${R(rs)}&${R(rt)}`);
          case 0x25:
            return set(rd, `${R(rs)}|${R(rt)}`);
          case 0x26:
            return set(rd, `${R(rs)}^${R(rt)}`);
          case 0x27:
            return set(rd, `~(${R(rs)}|${R(rt)})`);
          case 0x2a:
            return set(rd, `${R(rs)}<${R(rt)}?1:0`);
          case 0x2b:
            return set(rd, `${R(rs)}>>>0<${R(rt)}>>>0?1:0`);
        }
        return null;
      case 0x08: // ADDI（あふれたら例外）
        return {
          code: `a=${R(rs)};v=(a+${imm})|0;if(~(a^${imm})&(a^v)&0x80000000)EXIT_BEFORE;${rt ? `r[${rt}]=v;` : ''}`,
          write: rt,
          load: 0,
          cycles: 2,
        };
      case 0x09:
        return set(rt, `(${R(rs)}+${imm})|0`);
      case 0x0a:
        return set(rt, `${R(rs)}<${imm}?1:0`);
      case 0x0b:
        return set(rt, `${R(rs)}>>>0<${imm >>> 0}?1:0`);
      case 0x0c:
        return set(rt, `${R(rs)}&${op & 0xffff}`);
      case 0x0d:
        return set(rt, `${R(rs)}|${op & 0xffff}`);
      case 0x0e:
        return set(rt, `${R(rs)}^${op & 0xffff}`);
      case 0x0f:
        return set(rt, String(op << 16));
      case 0x12: {
        // GTE（使えないときは例外なので、インタープリターで）
        const ok = 'if(!(c.sr&0x40000000))EXIT_BEFORE;';
        if (rs & 0x10) return { code: ok + `c.gte.command(${op | 0});`, write: 0, load: 0, cycles: 10 };
        switch (rs) {
          case 0x00:
            return { code: ok + `N=c.gte.readData(${rd});`, write: 0, load: rt, cycles: 2 };
          case 0x02:
            return { code: ok + `N=c.gte.readControl(${rd});`, write: 0, load: rt, cycles: 2 };
          case 0x04:
            return { code: ok + `c.gte.writeData(${rd},${R(rt)});`, write: 0, load: 0, cycles: 2 };
          case 0x06:
            return { code: ok + `c.gte.writeControl(${rd},${R(rt)});`, write: 0, load: 0, cycles: 2 };
        }
        return null;
      }
      case 0x20: // LB
        return ld(
          ea +
            `if(p<0x800000)N=ram8[p&0x1fffff]<<24>>24;else if(p>=0x1f800000&&p<0x1f800400)N=s8[p&0x3ff]<<24>>24;else ${io('N=b.read8(a)<<24>>24')}`,
        );
      case 0x24: // LBU
        return ld(ea + `if(p<0x800000)N=ram8[p&0x1fffff];else if(p>=0x1f800000&&p<0x1f800400)N=s8[p&0x3ff];else ${io('N=b.read8(a)')}`);
      case 0x21: // LH
        return ld(
          ea +
            `if(a&1)EXIT_BEFORE;if(p<0x800000)N=ram16[(p&0x1fffff)>>1]<<16>>16;else if(p>=0x1f800000&&p<0x1f800400)N=s16[(p&0x3ff)>>1]<<16>>16;else ${io('N=b.read16(a)<<16>>16')}`,
        );
      case 0x25: // LHU
        return ld(
          ea +
            `if(a&1)EXIT_BEFORE;if(p<0x800000)N=ram16[(p&0x1fffff)>>1];else if(p>=0x1f800000&&p<0x1f800400)N=s16[(p&0x3ff)>>1];else ${io('N=b.read16(a)')}`,
        );
      case 0x23: // LW
        return ld(
          ea +
            `if(a&3)EXIT_BEFORE;if(p<0x800000)N=ram32[(p&0x1fffff)>>2];else if(p>=0x1f800000&&p<0x1f800400)N=s32[(p&0x3ff)>>2];else ${io('N=b.read32(a)')}`,
        );
      case 0x22: // LWL
      case 0x26: {
        // LWR
        const left = op >>> 26 === 0x22;
        const rd32 = `if(p<0x800000)t=ram32[(p&0x1ffffc)>>2];else if(p>=0x1f800000&&p<0x1f800400)t=s32[(p&0x3fc)>>2];else ${io('t=b.read32(a&~3)')}`;
        const merge = left
          ? `v=${curExpr};switch(a&3){case 0:N=(v&0x00ffffff)|(t<<24);break;case 1:N=(v&0x0000ffff)|(t<<16);break;case 2:N=(v&0x000000ff)|(t<<8);break;default:N=t;}N|=0;`
          : `v=${curExpr};switch(a&3){case 0:N=t;break;case 1:N=(v&0xff000000)|(t>>>8);break;case 2:N=(v&0xffff0000)|(t>>>16);break;default:N=(v&0xffffff00)|(t>>>24);}N|=0;`;
        return ld(ea + rd32 + merge);
      }
      case 0x28: // SB
        return st(
          ea +
            `v=${R(rt)}&0xff;b.writes++;if(p<0x800000){ram8[p&0x1fffff]=v;if(cp[(p&0x1fffff)>>12])c.jit.invalidate(p);}` +
            `else if(p>=0x1f800000&&p<0x1f800400)s8[p&0x3ff]=v;else{b.writes--;${io('b.write8(a,v)')}IOW=1;}`,
        );
      case 0x29: // SH
        return st(
          ea +
            `if(a&1)EXIT_BEFORE;v=${R(rt)}&0xffff;b.writes++;if(p<0x800000){ram16[(p&0x1fffff)>>1]=v;if(cp[(p&0x1fffff)>>12])c.jit.invalidate(p);}` +
            `else if(p>=0x1f800000&&p<0x1f800400)s16[(p&0x3ff)>>1]=v;else{b.writes--;${io('b.write16(a,v)')}IOW=1;}`,
        );
      case 0x2b: // SW
        return st(
          ea +
            `if(a&3)EXIT_BEFORE;v=${R(rt)};b.writes++;if(p<0x800000){ram32[(p&0x1fffff)>>2]=v;if(cp[(p&0x1fffff)>>12])c.jit.invalidate(p);}` +
            `else if(p>=0x1f800000&&p<0x1f800400)s32[(p&0x3ff)>>2]=v;else{b.writes--;${io('b.write32(a,v)')}IOW=1;}`,
        );
      case 0x2a: // SWL
      case 0x2e: {
        // SWR
        const left = op >>> 26 === 0x2a;
        const merge = left
          ? `switch(a&3){case 0:v=(t&0xffffff00)|(w>>>24);break;case 1:v=(t&0xffff0000)|(w>>>16);break;case 2:v=(t&0xff000000)|(w>>>8);break;default:v=w;}v|=0;`
          : `switch(a&3){case 0:v=w;break;case 1:v=(t&0x000000ff)|(w<<8);break;case 2:v=(t&0x0000ffff)|(w<<16);break;default:v=(t&0x00ffffff)|(w<<24);}v|=0;`;
        return st(
          ea +
            `{const w=${R(rt)};if(p<0x800000){t=ram32[(p&0x1ffffc)>>2];${merge}b.writes++;ram32[(p&0x1ffffc)>>2]=v;if(cp[(p&0x1fffff)>>12])c.jit.invalidate(p);}` +
            `else if(p>=0x1f800000&&p<0x1f800400){t=s32[(p&0x3fc)>>2];${merge}b.writes++;s32[(p&0x3fc)>>2]=v;}` +
            `else{${io('t=b.read32(a&~3)')}${merge}${io('b.write32(a&~3,v)')}IOW=1;}}`,
        );
      }
      case 0x32: // LWC2
        return {
          code:
            'if(!(c.sr&0x40000000))EXIT_BEFORE;' +
            ea +
            `if(a&3)EXIT_BEFORE;if(p<0x800000)v=ram32[(p&0x1fffff)>>2];else if(p>=0x1f800000&&p<0x1f800400)v=s32[(p&0x3ff)>>2];else ${io('v=b.read32(a)')}c.gte.writeData(${rt},v);`,
          write: 0,
          load: 0,
          cycles: 2,
        };
      case 0x3a: // SWC2
        return st(
          'if(!(c.sr&0x40000000))EXIT_BEFORE;' +
            ea +
            `if(a&3)EXIT_BEFORE;v=c.gte.readData(${rt});b.writes++;if(p<0x800000){ram32[(p&0x1fffff)>>2]=v;if(cp[(p&0x1fffff)>>12])c.jit.invalidate(p);}` +
            `else if(p>=0x1f800000&&p<0x1f800400)s32[(p&0x3ff)>>2]=v;else{b.writes--;${io('b.write32(a,v)')}IOW=1;}`,
        );
    }
    return null;
  }
}

/** simple：ブロックの中で JavaScript にできる。branch：分岐。stop：インタープリターに任せる */
function classify(op: number): 'simple' | 'branch' | 'stop' {
  const o = op >>> 26;
  if (o === 0) {
    const f = op & 63;
    if (f === 0x08 || f === 0x09) return 'branch';
    if (f === 0x0c || f === 0x0d) return 'stop';
    return [0x00, 0x02, 0x03, 0x04, 0x06, 0x07, 0x10, 0x11, 0x12, 0x13, 0x18, 0x19, 0x1a, 0x1b, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2a, 0x2b].includes(f)
      ? 'simple'
      : 'stop';
  }
  if (o >= 0x01 && o <= 0x07) return 'branch';
  if (o === 0x12) {
    const rs = (op >>> 21) & 31;
    return rs & 0x10 || rs === 0 || rs === 2 || rs === 4 || rs === 6 ? 'simple' : 'stop';
  }
  if ((o >= 0x08 && o <= 0x0f) || [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x28, 0x29, 0x2a, 0x2b, 0x2e, 0x32, 0x3a].includes(o)) return 'simple';
  return 'stop';
}

/** 分岐の命令：take（飛ぶか）と target（飛び先の式）、リンクで書くレジスタ、待ちループの見張り */
function branchCode(op: number, addr: number): { pre: string; target: string; write: number; idle: string } {
  const rs = (op >>> 21) & 31;
  const rt = (op >>> 16) & 31;
  const R = (i: number) => (i === 0 ? '0' : `r[${i}]`);
  const rel = (addr + 4 + ((op << 16) >> 14)) | 0;
  const link = (addr + 8) | 0;
  // インタープリターの branch()：飛び先が自分の 32 バイト手前までなら、待ちループか調べる
  const idleConst = (t: number) => {
    const back = addr - t;
    return back >= 0 && back <= 32 ? `c.checkIdle(${t});` : '';
  };
  switch (op >>> 26) {
    case 0x00: {
      const rd = (op >>> 11) & 31;
      const jalr = (op & 63) === 0x09;
      return {
        pre: `const take=true;const tgt=${R(rs)};${jalr && rd ? `r[${rd}]=${link};` : ''}`,
        target: 'tgt',
        write: jalr ? rd : 0,
        idle: `{const bk=${addr}-tgt;if(bk>=0&&bk<=32)c.checkIdle(tgt);}`,
      };
    }
    case 0x01: {
      const ge = rt & 1;
      const al = (rt & 0x1e) === 0x10;
      return {
        pre: `const take=${R(rs)}${ge ? '>=' : '<'}0;${al ? `r[31]=${link};` : ''}`,
        target: String(rel),
        write: al ? 31 : 0,
        idle: idleConst(rel),
      };
    }
    case 0x02:
    case 0x03: {
      const t = ((addr + 4) & 0xf0000000) | ((op & 0x3ffffff) << 2);
      return {
        pre: `const take=true;${op >>> 26 === 0x03 ? `r[31]=${link};` : ''}`,
        target: String(t | 0),
        write: op >>> 26 === 0x03 ? 31 : 0,
        idle: idleConst(t | 0),
      };
    }
    case 0x04:
      return { pre: `const take=${R(rs)}===${R(rt)};`, target: String(rel), write: 0, idle: idleConst(rel) };
    case 0x05:
      return { pre: `const take=${R(rs)}!==${R(rt)};`, target: String(rel), write: 0, idle: idleConst(rel) };
    case 0x06:
      return { pre: `const take=${R(rs)}<=0;`, target: String(rel), write: 0, idle: idleConst(rel) };
    default:
      return { pre: `const take=${R(rs)}>0;`, target: String(rel), write: 0, idle: idleConst(rel) };
  }
}
