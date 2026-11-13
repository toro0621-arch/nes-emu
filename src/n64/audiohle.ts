/**
 * 音の RSP 処理を、RSP の命令を 1 つずつ動かさずに JavaScript で直接まねる（HLE）
 *
 * 任天堂の標準の音声マイクロコード（いわゆる ABI1。多くのソフトが使う）だけを受け持ち、
 * それ以外のマイクロコードは今までどおり RSP をそのまま動かす。
 * コマンド表（8 バイトずつ）を読み、DMEM の作業場で ADPCM の展開・音程の変換・音量の合成をして、
 * できた音を DRAM に書き戻す。
 */
import type { N64 } from './n64';

const DMEM_BASE = 0x5c0;
const A_INIT = 0x01;
const A_LOOP = 0x02;
const A_LEFT = 0x02;
const A_VOL = 0x04;
const A_AUX = 0x08;

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}
function align(v: number, n: number): number {
  return (v + n - 1) & ~(n - 1);
}
/** (a * b) >> 16 を 64 ビットで計算して 32 ビットに収める */
function mulShr16(a: number, b: number): number {
  const bh = b >> 16;
  const bl = b & 0xffff;
  return (a * bh + Math.floor((a * bl) / 65536)) | 0;
}

export class AudioHle {
  /** DMEM の作業場（ビッグエンディアンのバイト列） */
  private m = new Uint8Array(0x1000);
  private seg = new Int32Array(16);
  private inp = 0;
  private out = 0;
  private count = 0;
  private dryRight = 0;
  private wetLeft = 0;
  private wetRight = 0;
  private dry = 0;
  private wet = 0;
  private vol = [0, 0];
  private target = [0, 0];
  private rate = [0, 0];
  private loop = 0;
  /** ADPCM の係数表（POLEF もこれを使い、書き換える） */
  private table = new Int16Array(128);
  private lut = new Int16Array(256);

  constructor(private n64: N64) {}

  /** 標準の音声マイクロコードかどうか（ucode_data の決まった所の値で見分ける） */
  static detect(n64: N64, ucodeData: number): boolean {
    const r = (a: number) => {
      const p = (ucodeData + a) & 0xfffffc;
      return p < n64.ramSize ? n64.ram32[p >> 2] : 0;
    };
    return r(0) === 1 && r(0x30) === (0xf0000f00 | 0) && r(0x28) === 0x1e24138c;
  }

  // ---- DMEM ----
  private s16(a: number): number {
    a &= 0xfff;
    return ((this.m[a] << 24) | (this.m[(a + 1) & 0xfff] << 16)) >> 16;
  }
  private w16(a: number, v: number): void {
    a &= 0xfff;
    this.m[a] = v >> 8;
    this.m[(a + 1) & 0xfff] = v;
  }

  // ---- DRAM ----
  private dramU8(a: number): number {
    a &= 0xffffff;
    return a < this.n64.ramSize ? this.n64.ram8[a ^ 3] : 0;
  }
  private dramS16(a: number): number {
    return ((this.dramU8(a) << 24) | (this.dramU8(a + 1) << 16)) >> 16;
  }
  private dramW8(a: number, v: number): void {
    a &= 0xffffff;
    if (a < this.n64.ramSize) this.n64.ram8[a ^ 3] = v;
  }
  private dramW16(a: number, v: number): void {
    this.dramW8(a, v >> 8);
    this.dramW8(a + 1, v);
  }
  private dramS32(a: number): number {
    return (this.dramU8(a) << 24) | (this.dramU8(a + 1) << 16) | (this.dramU8(a + 2) << 8) | this.dramU8(a + 3);
  }
  private dramW32(a: number, v: number): void {
    this.dramW16(a, v >> 16);
    this.dramW16(a + 2, v);
  }
  private wrote(a: number, len: number): void {
    this.n64.cpu.jit?.invalidateRange(a & 0xffffff, len);
  }

  private addr(so: number): number {
    return (this.seg[(so >>> 24) & 0xf] + (so & 0xffffff)) & 0xffffff;
  }

  /** タスクを最後まで処理する */
  run(dataPtr: number, dataSize: number, ucodeData: number): void {
    // 音程変換の係数表は、マイクロコードのデータの中にある
    for (let i = 0; i < 256; i++) this.lut[i] = this.dramS16(ucodeData + 0xc0 + i * 2);
    this.seg.fill(0);
    const end = dataPtr + (dataSize & ~7);
    for (let p = dataPtr; p < end; p += 8) {
      const w0 = this.dramS32(p);
      const w1 = this.dramS32(p + 4);
      this.command(w0, w1);
    }
    this.n64.writes++;
  }

  private command(w0: number, w1: number): void {
    const flags = (w0 >>> 16) & 0xff;
    switch ((w0 >>> 24) & 0x1f) {
      case 0x01: // ADPCM
        this.adpcm(flags & A_INIT, flags & A_LOOP, this.addr(w1));
        break;
      case 0x02: {
        // CLEARBUFF
        const d = (w0 & 0xffff) + DMEM_BASE;
        const c = w1 & 0xffff;
        if (c) this.m.fill(0, d & 0xfff, Math.min(0x1000, (d & 0xfff) + align(c, 16)));
        break;
      }
      case 0x03: // ENVMIXER
        this.envmix(flags & A_INIT, flags & A_AUX, this.addr(w1));
        break;
      case 0x04: // LOADBUFF
        if (this.count) this.load(this.inp, this.addr(w1), this.count);
        break;
      case 0x05: // RESAMPLE
        this.resample(flags & 1, w0 & 0xffff, this.addr(w1));
        break;
      case 0x06: // SAVEBUFF
        if (this.count) this.save(this.out, this.addr(w1), this.count);
        break;
      case 0x07: // SEGMENT
        this.seg[(w1 >>> 24) & 0xf] = w1 & 0xffffff;
        break;
      case 0x08: {
        // SETBUFF
        const i = (w0 & 0xffff) + DMEM_BASE;
        const o = (w1 >>> 16) + DMEM_BASE;
        const c = w1 & 0xffff;
        if (flags & A_AUX) {
          this.dryRight = i;
          this.wetLeft = o;
          this.wetRight = c + DMEM_BASE;
        } else {
          this.inp = i;
          this.out = o;
          this.count = c;
        }
        break;
      }
      case 0x09: {
        // SETVOL
        const v = (w0 << 16) >> 16;
        if (flags & A_AUX) {
          this.dry = v;
          this.wet = (w1 << 16) >> 16;
        } else {
          const lr = flags & A_LEFT ? 0 : 1;
          if (flags & A_VOL) this.vol[lr] = v;
          else {
            this.target[lr] = v;
            this.rate[lr] = w1 | 0;
          }
        }
        break;
      }
      case 0x0a: {
        // DMEMMOVE
        const i = (w0 & 0xffff) + DMEM_BASE;
        const o = (w1 >>> 16) + DMEM_BASE;
        const c = w1 & 0xffff;
        if (c) {
          const n = align(c, 16);
          for (let k = 0; k < n; k++) this.m[(o + k) & 0xfff] = this.m[(i + k) & 0xfff];
        }
        break;
      }
      case 0x0b: {
        // LOADADPCM
        const a = this.addr(w1);
        const n = Math.min(128, align(w0 & 0xffff, 8) >> 1);
        for (let k = 0; k < n; k++) this.table[k] = this.dramS16(a + k * 2);
        break;
      }
      case 0x0c: {
        // MIXER
        const gain = (w0 << 16) >> 16;
        const i = (w1 >>> 16) + DMEM_BASE;
        const o = (w1 & 0xffff) + DMEM_BASE;
        const n = align(this.count, 32);
        for (let k = 0; k < n; k += 2) this.w16(o + k, clamp16(this.s16(o + k) + ((this.s16(i + k) * gain + 0x4000) >> 15)));
        break;
      }
      case 0x0d: {
        // INTERLEAVE
        const l = (w1 >>> 16) + DMEM_BASE;
        const r = (w1 & 0xffff) + DMEM_BASE;
        const n = this.count >> 1;
        // 出力が入力に重なることがあるので、先に読んでおく
        const tmp = new Int16Array(n * 2);
        for (let k = 0; k < n; k++) {
          tmp[k * 2] = this.s16(l + k * 2);
          tmp[k * 2 + 1] = this.s16(r + k * 2);
        }
        for (let k = 0; k < n * 2; k++) this.w16(this.out + k * 2, tmp[k]);
        break;
      }
      case 0x0e: // POLEF
        if (this.count) this.polef(flags & A_INIT, (w0 << 16) >> 16, this.addr(w1));
        break;
      case 0x0f: // SETLOOP
        this.loop = this.addr(w1);
        break;
      default:
        break;
    }
  }

  private load(dmem: number, a: number, count: number): void {
    dmem &= 0xff8;
    a &= 0xfffff8;
    const n = align(count, 8);
    for (let k = 0; k < n; k++) this.m[(dmem + k) & 0xfff] = this.dramU8(a + k);
  }
  private save(dmem: number, a: number, count: number): void {
    dmem &= 0xff8;
    a &= 0xfffff8;
    const n = align(count, 8);
    for (let k = 0; k < n; k++) this.dramW8(a + k, this.m[(dmem + k) & 0xfff]);
    this.wrote(a, n);
  }

  private adpcm(init: number, loop: number, address: number): void {
    const last = new Int16Array(16);
    const frame = new Int16Array(16);
    if (!init) {
      const src = loop ? this.loop : address;
      for (let k = 0; k < 16; k++) last[k] = this.dramS16(src + k * 2);
    }
    let o = this.out;
    let i = this.inp;
    for (let k = 0; k < 16; k++, o += 2) this.w16(o, last[k]);
    let count = align(this.count, 32);
    const t = this.table;
    while (count > 0) {
      const code = this.m[i++ & 0xfff];
      const scale = code >> 4;
      const cb = (code & 0xf) << 4;
      const rshift = scale < 12 ? 12 - scale : 0;
      for (let k = 0; k < 8; k++) {
        const b = this.m[i++ & 0xfff];
        frame[k * 2] = ((((b & 0xf0) << 8) << 16) >> 16) >> rshift;
        frame[k * 2 + 1] = ((((b & 0x0f) << 12) << 16) >> 16) >> rshift;
      }
      for (let half = 0; half < 2; half++) {
        const base = half * 8;
        const l1 = half ? last[6] : last[14];
        const l2 = half ? last[7] : last[15];
        for (let k = 0; k < 8; k++) {
          let acc = frame[base + k] << 11;
          acc += t[cb + k] * l1 + t[cb + 8 + k] * l2;
          // rdot(k, book2, src)
          for (let j = 0; j < k; j++) acc += t[cb + 8 + j] * frame[base + k - 1 - j];
          last[base + k] = clamp16(acc >> 11);
        }
      }
      for (let k = 0; k < 16; k++, o += 2) this.w16(o, last[k]);
      count -= 32;
    }
    for (let k = 0; k < 16; k++) this.dramW16(address + k * 2, last[k]);
    this.wrote(address, 32);
  }

  private resample(init: number, pitch: number, address: number): void {
    pitch = (pitch << 1) >>> 0;
    let ipos = ((this.inp >> 1) - 4) & 0x7ff;
    let opos = (this.out >> 1) & 0x7ff;
    let acc: number;
    if (init) {
      for (let k = 0; k < 4; k++) this.w16((ipos + k) * 2, 0);
      acc = 0;
    } else {
      for (let k = 0; k < 4; k++) this.w16((ipos + k) * 2, this.dramS16(address + k * 2));
      acc = this.dramS16(address + 8) & 0xffff;
    }
    const n = align(this.count, 16);
    const lut = this.lut;
    for (let k = 0; k < n; k += 2) {
      const e = (acc & 0xfc00) >> 8;
      const v =
        ((this.s16(ipos * 2) * lut[e]) >> 15) +
        ((this.s16((ipos + 1) * 2) * lut[e + 1]) >> 15) +
        ((this.s16((ipos + 2) * 2) * lut[e + 2]) >> 15) +
        ((this.s16((ipos + 3) * 2) * lut[e + 3]) >> 15);
      this.w16(opos * 2, clamp16(v));
      opos = (opos + 1) & 0x7ff;
      acc += pitch;
      ipos = (ipos + (acc >>> 16)) & 0x7ff;
      acc &= 0xffff;
    }
    for (let k = 0; k < 4; k++) this.dramW16(address + k * 2, this.s16((ipos + k) * 2));
    this.dramW16(address + 8, acc);
    this.wrote(address, 10);
  }

  private envmix(init: number, aux: number, address: number): void {
    const value = [0, 0];
    const tgt = [0, 0];
    const step = [0, 0];
    const expRate = [0, 0];
    const expSeq = [0, 0];
    let dry = this.dry;
    let wet = this.wet;
    if (init) {
      for (let s = 0; s < 2; s++) {
        value[s] = this.vol[s] * 65536;
        tgt[s] = this.target[s] * 65536;
        expRate[s] = this.rate[s];
        expSeq[s] = Math.imul(this.vol[s], this.rate[s]);
      }
    } else {
      // マイクロコードが残す形：8 サンプルぶんの音量（整数部・小数部）を左右、そのあとに目標・割合・dry・wet
      value[0] = (this.dramS16(address + 14) << 16) | (this.dramS16(address + 30) & 0xffff);
      value[1] = (this.dramS16(address + 46) << 16) | (this.dramS16(address + 62) & 0xffff);
      tgt[0] = this.dramS16(address + 64) * 65536;
      expRate[0] = this.dramS32(address + 66);
      tgt[1] = this.dramS16(address + 70) * 65536;
      expRate[1] = this.dramS32(address + 72);
      dry = this.dramS16(address + 76);
      wet = this.dramS16(address + 78);
      expSeq[0] = value[0];
      expSeq[1] = value[1];
    }
    step[0] = tgt[0] - value[0];
    step[1] = tgt[1] - value[1];
    const n = this.count;
    const inp = this.inp;
    const outs = [this.out, this.dryRight, this.wetLeft, this.wetRight];
    const nb = aux ? 4 : 2;
    const gains = [0, 0, 0, 0];
    const lanes = new Int32Array(16);
    for (let k = 0; k < 8; k++) {
      lanes[k] = value[0];
      lanes[8 + k] = value[1];
    }
    let ptr = 0;
    for (let y = 0; y < n; y += 16) {
      for (let s = 0; s < 2; s++) {
        if (step[s] !== 0) {
          expSeq[s] = mulShr16(expSeq[s], expRate[s]);
          step[s] = Math.floor((expSeq[s] - value[s]) / 8);
        }
      }
      for (let x = 0; x < 8; x++) {
        const vol = [0, 0];
        for (let s = 0; s < 2; s++) {
          value[s] += step[s];
          const reached = step[s] <= 0 ? value[s] <= tgt[s] : value[s] >= tgt[s];
          if (reached) {
            value[s] = tgt[s];
            step[s] = 0;
          }
          vol[s] = ((value[s] | 0) >> 16) | 0;
          lanes[s * 8 + x] = value[s] | 0;
        }
        gains[0] = clamp16((vol[0] * dry + 0x4000) >> 15);
        gains[1] = clamp16((vol[1] * dry + 0x4000) >> 15);
        gains[2] = clamp16((vol[0] * wet + 0x4000) >> 15);
        gains[3] = clamp16((vol[1] * wet + 0x4000) >> 15);
        const src = this.s16(inp + ptr * 2);
        for (let b = 0; b < nb; b++) {
          const a = outs[b] + ptr * 2;
          this.w16(a, clamp16(this.s16(a) + ((src * gains[b] + 0x4000) >> 15)));
        }
        ptr++;
      }
    }
    for (let k = 0; k < 8; k++) {
      this.dramW16(address + k * 2, lanes[k] >> 16);
      this.dramW16(address + 16 + k * 2, lanes[k]);
      this.dramW16(address + 32 + k * 2, lanes[8 + k] >> 16);
      this.dramW16(address + 48 + k * 2, lanes[8 + k]);
    }
    this.dramW16(address + 64, tgt[0] / 65536);
    this.dramW32(address + 66, expRate[0]);
    this.dramW16(address + 70, tgt[1] / 65536);
    this.dramW32(address + 72, expRate[1]);
    this.dramW16(address + 76, dry);
    this.dramW16(address + 78, wet);
    this.wrote(address, 80);
  }

  private polef(init: number, gain: number, address: number): void {
    const t = this.table;
    let l1 = 0;
    let l2 = 0;
    if (!init) {
      l1 = this.dramS16(address + 4);
      l2 = this.dramS16(address + 6);
    }
    const h2Before = new Int16Array(8);
    for (let k = 0; k < 8; k++) {
      h2Before[k] = t[8 + k];
      t[8 + k] = (t[8 + k] * gain) >> 14;
    }
    let count = align(this.count, 16);
    let i = this.inp;
    let o = this.out;
    const frame = new Int16Array(8);
    const res = new Int16Array(8);
    do {
      for (let k = 0; k < 8; k++, i += 2) frame[k] = this.s16(i);
      for (let k = 0; k < 8; k++) {
        let acc = frame[k] * gain;
        acc += t[k] * l1 + h2Before[k] * l2;
        for (let j = 0; j < k; j++) acc += t[8 + j] * frame[k - 1 - j];
        res[k] = clamp16(acc >> 14);
        this.w16(o + k * 2, res[k]);
      }
      l1 = res[6];
      l2 = res[7];
      o += 16;
      count -= 16;
    } while (count > 0);
    for (let k = 0; k < 4; k++) this.dramW16(address + k * 2, res[4 + k]);
    this.wrote(address, 8);
  }
}
