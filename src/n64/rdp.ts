// RDP：三角形と四角形を 1 点ずつ描く絵描き係。RSP が作ったコマンドの列を読んで、
// テクスチャ（TMEM 4KB）→ 色の合成（コンバイナー）→ 重ね合わせ（ブレンダー）→ 奥行きの比べっこ（Z バッファ）の順に計算し、
// RDRAM の中の画面に書き込む

import { INT_DP, type N64 } from './n64';

/** コマンドの長さ（64 ビットのワード数） */
const CMD_LEN = new Uint8Array(64).fill(1);
CMD_LEN[0x08] = 4;
CMD_LEN[0x09] = 6;
CMD_LEN[0x0a] = 12;
CMD_LEN[0x0b] = 14;
CMD_LEN[0x0c] = 12;
CMD_LEN[0x0d] = 14;
CMD_LEN[0x0e] = 20;
CMD_LEN[0x0f] = 22;
CMD_LEN[0x24] = 2;
CMD_LEN[0x25] = 2;

// Z の値（18 ビット）を 14 ビットに詰める実機の形式
const Z_SHIFT = [6, 5, 4, 3, 2, 1, 0, 0];
const Z_BASE = [0, 0x20000, 0x30000, 0x38000, 0x3c000, 0x3e000, 0x3f000, 0x3f800];
function zEncode(z: number): number {
  let e = 0;
  while (e < 7 && z >= Z_BASE[e + 1]) e++;
  return ((e << 11) | (((z - Z_BASE[e]) >> Z_SHIFT[e]) & 0x7ff)) << 2;
}
const Z_DEC = new Int32Array(0x4000);
for (let i = 0; i < 0x4000; i++) Z_DEC[i] = ((i & 0x7ff) << Z_SHIFT[i >> 11]) + Z_BASE[i >> 11];

class Tile {
  format = 0;
  size = 0;
  line = 0;
  tmem = 0;
  palette = 0;
  ct = false;
  mt = false;
  maskT = 0;
  shiftT = 0;
  cs = false;
  ms = false;
  maskS = 0;
  shiftS = 0;
  sl = 0;
  tl = 0;
  sh = 0;
  th = 0;
}

export class Rdp {
  start = 0;
  end = 0;
  current = 0;
  status = 0x80;
  private buf: number[] = [];
  private w = new Int32Array(44);

  tmem = new Uint8Array(4096);
  tiles = Array.from({ length: 8 }, () => new Tile());
  // 色の出力先・Z・テクスチャの元
  private ciAddr = 0;
  private ciWidth = 320;
  private ciSize = 2;
  private ziAddr = 0;
  private tiAddr = 0;
  private tiWidth = 0;
  private tiSize = 0;
  tiFormat = 0;
  // 切り取る範囲
  private scX0 = 0;
  private scY0 = 0;
  private scX1 = 320;
  private scY1 = 240;
  // モード
  private omHi = 0;
  private omLo = 0;
  private combHi = 0;
  private combLo = 0;
  private fillColor = 0;
  private prim = new Int32Array(4);
  private env = new Int32Array(4);
  private blendC = new Int32Array(4);
  private fog = new Int32Array(4);
  private primLod = 0;
  private primZ = 0;
  private primDz = 0;
  k4 = 0;
  private k5 = 0;

  // 計算の途中の色
  private texel0 = new Int32Array(4);
  private texel1 = new Int32Array(4);
  private comb = new Int32Array(4);
  private shade = new Int32Array(4);
  private mem = new Int32Array(4);
  private one = new Int32Array([255, 255, 255, 255]);
  private zero = new Int32Array(4);
  private noise = new Int32Array(4);
  private tmpC = new Int32Array(4);

  constructor(private n64: N64) {}

  readReg(r: number): number {
    switch (r) {
      case 0:
        return this.start;
      case 1:
        return this.end;
      case 2:
        return this.current;
      case 3:
        return this.status;
    }
    return 0;
  }

  writeReg(r: number, v: number): void {
    switch (r) {
      case 0:
        this.start = v & 0xfffff8;
        this.current = this.start;
        return;
      case 1:
        this.end = v & 0xfffff8;
        this.run();
        return;
      case 3:
        if (v & 1) this.status &= ~1;
        if (v & 2) this.status |= 1;
        if (v & 4) this.status &= ~2;
        if (v & 8) this.status |= 2;
        if (v & 0x10) this.status &= ~4;
        if (v & 0x20) this.status |= 4;
        return;
    }
  }

  /** current から end までのコマンドを読む */
  private run(): void {
    if (this.status & 2) return; // 止められている
    const xbus = (this.status & 1) !== 0;
    const src = xbus ? this.n64.spMem32 : this.n64.ram32;
    const mask = xbus ? 0xfff : 0xffffff;
    const max = xbus ? 0x1000 : this.n64.ramSize;
    for (let a = this.current; a < this.end; a += 4) {
      const i = a & mask;
      this.buf.push(i < max ? src[i >> 2] : 0);
    }
    this.current = this.end;
    const b = this.buf;
    let p = 0;
    while (p + 1 < b.length) {
      const cmd = (b[p] >>> 24) & 63;
      const len = CMD_LEN[cmd] * 2;
      if (p + len > b.length) break;
      const w = this.w;
      for (let k = 0; k < len; k++) w[k] = b[p + k];
      p += len;
      this.exec(cmd);
    }
    if (p) b.splice(0, p);
    if (b.length > 4096) b.length = 0;
    this.n64.writes++;
  }

  private exec(cmd: number): void {
    const w0 = this.w[0];
    const w1 = this.w[1];
    if (cmd >= 0x08 && cmd <= 0x0f) return this.triangle(cmd);
    switch (cmd) {
      case 0x24:
      case 0x25:
        return this.texRect(cmd === 0x25);
      case 0x29:
        this.n64.raise(INT_DP);
        return;
      case 0x2c:
        this.k4 = (w1 >> 9) & 0x1ff;
        this.k5 = w1 & 0x1ff;
        return;
      case 0x2d:
        this.scX0 = ((w0 >> 12) & 0xfff) >> 2;
        this.scY0 = (w0 & 0xfff) >> 2;
        this.scX1 = (((w1 >> 12) & 0xfff) + 3) >> 2;
        this.scY1 = ((w1 & 0xfff) + 3) >> 2;
        return;
      case 0x2e:
        this.primZ = (w1 >>> 16) & 0x7fff;
        this.primDz = w1 & 0xffff;
        return;
      case 0x2f:
        this.omHi = w0;
        this.omLo = w1;
        return;
      case 0x30:
        return this.loadTlut();
      case 0x32: {
        const t = this.tiles[(w1 >> 24) & 7];
        t.sl = (w0 >> 12) & 0xfff;
        t.tl = w0 & 0xfff;
        t.sh = (w1 >> 12) & 0xfff;
        t.th = w1 & 0xfff;
        return;
      }
      case 0x33:
        return this.loadBlock();
      case 0x34:
        return this.loadTile();
      case 0x35: {
        const t = this.tiles[(w1 >> 24) & 7];
        t.format = (w0 >> 21) & 7;
        t.size = (w0 >> 19) & 3;
        t.line = (w0 >> 9) & 0x1ff;
        t.tmem = w0 & 0x1ff;
        t.palette = (w1 >> 20) & 15;
        t.ct = (w1 & 0x80000) !== 0;
        t.mt = (w1 & 0x40000) !== 0;
        t.maskT = (w1 >> 14) & 15;
        t.shiftT = (w1 >> 10) & 15;
        t.cs = (w1 & 0x200) !== 0;
        t.ms = (w1 & 0x100) !== 0;
        t.maskS = (w1 >> 4) & 15;
        t.shiftS = w1 & 15;
        return;
      }
      case 0x36:
        return this.fillRect();
      case 0x37:
        this.fillColor = w1;
        return;
      case 0x38:
        setColor(this.fog, w1);
        return;
      case 0x39:
        setColor(this.blendC, w1);
        return;
      case 0x3a:
        this.primLod = w0 & 0xff;
        setColor(this.prim, w1);
        return;
      case 0x3b:
        setColor(this.env, w1);
        return;
      case 0x3c:
        this.combHi = w0;
        this.combLo = w1;
        return;
      case 0x3d:
        this.tiFormat = (w0 >> 21) & 7;
        this.tiSize = (w0 >> 19) & 3;
        this.tiWidth = (w0 & 0x3ff) + 1;
        this.tiAddr = w1 & 0xffffff;
        return;
      case 0x3e:
        this.ziAddr = w1 & 0xffffff;
        return;
      case 0x3f:
        this.ciSize = (w0 >> 19) & 3;
        this.ciWidth = (w0 & 0x3ff) + 1;
        this.ciAddr = w1 & 0xffffff;
        return;
    }
  }

  // ---- テクスチャを TMEM へ ----
  private ramByte(a: number): number {
    return a < this.n64.ramSize ? this.n64.ram8[a ^ 3] : 0;
  }

  private loadBlock(): void {
    const w0 = this.w[0];
    const w1 = this.w[1];
    const t = this.tiles[(w1 >> 24) & 7];
    const sl = (w0 >> 12) & 0xfff;
    const tl = w0 & 0xfff;
    const sh = (w1 >> 12) & 0xfff;
    t.sl = sl << 2;
    t.tl = tl << 2;
    t.sh = sh << 2;
    t.th = w1 & 0xfff;
    const bits = 4 << this.tiSize;
    const bytes = (((sh - sl + 1) * bits + 63) >> 6) << 3;
    const src = this.tiAddr + ((tl * this.tiWidth + sl) * bits >> 3);
    this.copyToTmem(src, t.tmem * 8, bytes);
  }

  private loadTile(): void {
    const w0 = this.w[0];
    const w1 = this.w[1];
    const t = this.tiles[(w1 >> 24) & 7];
    t.sl = (w0 >> 12) & 0xfff;
    t.tl = w0 & 0xfff;
    t.sh = (w1 >> 12) & 0xfff;
    t.th = w1 & 0xfff;
    const sl = t.sl >> 2;
    const tl = t.tl >> 2;
    const sh = t.sh >> 2;
    const th = t.th >> 2;
    const bits = 4 << this.tiSize;
    const rowBytes = ((sh - sl + 1) * bits + 7) >> 3;
    const line = t.line * 8;
    for (let y = tl; y <= th; y++) {
      const src = this.tiAddr + ((y * this.tiWidth + sl) * bits >> 3);
      this.copyToTmem(src, t.tmem * 8 + (y - tl) * line, rowBytes);
    }
  }

  /** 32 ビットのテクスチャは、赤緑を下半分・青と透明度を上半分に分けて置く（実機と同じ） */
  private copyToTmem(src: number, dst: number, bytes: number): void {
    const tm = this.tmem;
    if (this.tiSize === 3) {
      for (let i = 0; i < bytes; i += 4) {
        const d = (dst + (i >> 1)) & 0x7ff;
        tm[d] = this.ramByte(src + i);
        tm[d + 1] = this.ramByte(src + i + 1);
        tm[d | 0x800] = this.ramByte(src + i + 2);
        tm[(d + 1) | 0x800] = this.ramByte(src + i + 3);
      }
      return;
    }
    for (let i = 0; i < bytes; i++) tm[(dst + i) & 0xfff] = this.ramByte(src + i);
  }

  private loadTlut(): void {
    const w0 = this.w[0];
    const w1 = this.w[1];
    const t = this.tiles[(w1 >> 24) & 7];
    const sl = ((w0 >> 12) & 0xfff) >> 2;
    const sh = ((w1 >> 12) & 0xfff) >> 2;
    const tm = this.tmem;
    for (let i = 0; i <= sh - sl; i++) {
      const a = this.tiAddr + (sl + i) * 2;
      const hi = this.ramByte(a);
      const lo = this.ramByte(a + 1);
      const d = (t.tmem * 8 + i * 8) & 0xfff;
      for (let k = 0; k < 8; k += 2) {
        tm[(d + k) & 0xfff] = hi;
        tm[(d + k + 1) & 0xfff] = lo;
      }
    }
  }

  // ---- テクスチャを読む ----
  /** タイルの (s, t)（整数の位置）の色を out へ */
  private fetch(t: Tile, s: number, tt: number, out: Int32Array): void {
    // 折り返し・鏡写し・端で止める
    if (t.cs || !t.maskS) {
      const max = (t.sh - t.sl) >> 2;
      if (s < 0) s = 0;
      else if (s > max) s = max;
    }
    if (t.maskS) {
      if (t.ms && (s >> t.maskS) & 1) s = ~s;
      s &= (1 << t.maskS) - 1;
    }
    if (t.ct || !t.maskT) {
      const max = (t.th - t.tl) >> 2;
      if (tt < 0) tt = 0;
      else if (tt > max) tt = max;
    }
    if (t.maskT) {
      if (t.mt && (tt >> t.maskT) & 1) tt = ~tt;
      tt &= (1 << t.maskT) - 1;
    }
    const tm = this.tmem;
    const base = t.tmem * 8 + tt * t.line * 8;
    const tlut = (this.omHi & 0x8000) !== 0;
    let idx = -1;
    switch (t.size) {
      case 0: {
        const b = tm[(base + (s >> 1)) & 0xfff];
        const n = s & 1 ? b & 15 : b >> 4;
        if (tlut || t.format === 2) idx = (t.palette << 4) | n;
        else if (t.format === 3) {
          const i = (n >> 1) * 36.43;
          out[0] = out[1] = out[2] = i | 0;
          out[3] = n & 1 ? 255 : 0;
        } else {
          const i = n * 17;
          out[0] = out[1] = out[2] = out[3] = i;
        }
        break;
      }
      case 1: {
        const b = tm[(base + s) & 0xfff];
        if (tlut || t.format === 2) idx = b;
        else if (t.format === 3) {
          out[0] = out[1] = out[2] = (b >> 4) * 17;
          out[3] = (b & 15) * 17;
        } else out[0] = out[1] = out[2] = out[3] = b;
        break;
      }
      case 2: {
        const a = (base + s * 2) & 0xfff;
        const v = (tm[a] << 8) | tm[(a + 1) & 0xfff];
        if (t.format === 3) {
          out[0] = out[1] = out[2] = v >> 8;
          out[3] = v & 0xff;
        } else rgba16(v, out);
        break;
      }
      default: {
        const a = (base + s * 2) & 0x7ff;
        out[0] = tm[a];
        out[1] = tm[a + 1];
        out[2] = tm[a | 0x800];
        out[3] = tm[(a + 1) | 0x800];
      }
    }
    if (idx >= 0) {
      const a = 0x800 + idx * 8;
      const v = (tm[a & 0xfff] << 8) | tm[(a + 1) & 0xfff];
      if (this.omHi & 0x4000) {
        out[0] = out[1] = out[2] = v >> 8;
        out[3] = v & 0xff;
      } else rgba16(v, out);
    }
  }

  /** テクスチャ座標（10.5 の固定小数）から色を読む。bilinear なら 4 つを混ぜる */
  private sample(tile: number, s: number, tt: number, out: Int32Array): void {
    const t = this.tiles[tile];
    if (t.shiftS) s = t.shiftS > 10 ? s << (16 - t.shiftS) : s >> t.shiftS;
    if (t.shiftT) tt = t.shiftT > 10 ? tt << (16 - t.shiftT) : tt >> t.shiftT;
    s -= t.sl << 3;
    tt -= t.tl << 3;
    if (!(this.omHi & 0x2000)) {
      this.fetch(t, s >> 5, tt >> 5, out);
      return;
    }
    const si = s >> 5;
    const ti = tt >> 5;
    const sf = s & 31;
    const tf = tt & 31;
    if (!sf && !tf) {
      this.fetch(t, si, ti, out);
      return;
    }
    const c = this.tmpC;
    this.fetch(t, si, ti, out);
    const r0 = out[0];
    const g0 = out[1];
    const b0 = out[2];
    const a0 = out[3];
    this.fetch(t, si + 1, ti, c);
    const r1 = c[0];
    const g1 = c[1];
    const b1 = c[2];
    const a1 = c[3];
    this.fetch(t, si, ti + 1, c);
    const r2 = c[0];
    const g2 = c[1];
    const b2 = c[2];
    const a2 = c[3];
    this.fetch(t, si + 1, ti + 1, c);
    const w00 = (32 - sf) * (32 - tf);
    const w10 = sf * (32 - tf);
    const w01 = (32 - sf) * tf;
    const w11 = sf * tf;
    out[0] = (r0 * w00 + r1 * w10 + r2 * w01 + c[0] * w11 + 512) >> 10;
    out[1] = (g0 * w00 + g1 * w10 + g2 * w01 + c[1] * w11 + 512) >> 10;
    out[2] = (b0 * w00 + b1 * w10 + b2 * w01 + c[2] * w11 + 512) >> 10;
    out[3] = (a0 * w00 + a1 * w10 + a2 * w01 + c[3] * w11 + 512) >> 10;
  }

  // ---- 色の合成 ----
  private rgbIn(sel: number, kind: number): Int32Array {
    switch (sel) {
      case 0:
        return this.comb;
      case 1:
        return this.texel0;
      case 2:
        return this.texel1;
      case 3:
        return this.prim;
      case 4:
        return this.shade;
      case 5:
        return this.env;
    }
    if (kind === 0 || kind === 3) {
      if (sel === 6) return this.one;
      if (sel === 7 && kind === 0) return this.noise;
    }
    return this.zero;
  }

  /** (A − B) × C + D を 1 回 */
  private combine(cycle: number): void {
    const hi = this.combHi;
    const lo = this.combLo;
    let a: number;
    let b: number;
    let c: number;
    let d: number;
    let aa: number;
    let ab: number;
    let ac: number;
    let ad: number;
    if (cycle === 0) {
      a = (hi >> 20) & 15;
      c = (hi >> 15) & 31;
      aa = (hi >> 12) & 7;
      ac = (hi >> 9) & 7;
      b = (lo >>> 28) & 15;
      d = (lo >> 15) & 7;
      ab = (lo >> 12) & 7;
      ad = (lo >> 9) & 7;
    } else {
      a = (hi >> 5) & 15;
      c = hi & 31;
      b = (lo >> 24) & 15;
      aa = (lo >> 21) & 7;
      ac = (lo >> 18) & 7;
      d = (lo >> 6) & 7;
      ab = (lo >> 3) & 7;
      ad = lo & 7;
    }
    const A = this.rgbIn(a, 0);
    const B = this.rgbIn(b, 1);
    const D = this.rgbIn(d, 3);
    let c0: number;
    let c1: number;
    let c2: number;
    if (c < 6) {
      const C = this.rgbIn(c, 2);
      c0 = C[0];
      c1 = C[1];
      c2 = C[2];
    } else {
      let v = 0;
      switch (c) {
        case 7:
          v = this.comb[3];
          break;
        case 8:
          v = this.texel0[3];
          break;
        case 9:
          v = this.texel1[3];
          break;
        case 10:
          v = this.prim[3];
          break;
        case 11:
          v = this.shade[3];
          break;
        case 12:
          v = this.env[3];
          break;
        case 14:
          v = this.primLod;
          break;
        case 15:
          v = this.k5;
          break;
      }
      c0 = c1 = c2 = v;
    }
    const r = clamp8(((A[0] - B[0]) * c0 + (D[0] << 8) + 0x80) >> 8);
    const g = clamp8(((A[1] - B[1]) * c1 + (D[1] << 8) + 0x80) >> 8);
    const bl = clamp8(((A[2] - B[2]) * c2 + (D[2] << 8) + 0x80) >> 8);
    const al = clamp8(((this.alphaIn(aa) - this.alphaIn(ab)) * this.alphaMul(ac) + (this.alphaIn(ad) << 8) + 0x80) >> 8);
    const o = this.comb;
    o[0] = r;
    o[1] = g;
    o[2] = bl;
    o[3] = al;
  }

  private alphaIn(sel: number): number {
    switch (sel) {
      case 0:
        return this.comb[3];
      case 1:
        return this.texel0[3];
      case 2:
        return this.texel1[3];
      case 3:
        return this.prim[3];
      case 4:
        return this.shade[3];
      case 5:
        return this.env[3];
      case 6:
        return 255;
    }
    return 0;
  }

  private alphaMul(sel: number): number {
    switch (sel) {
      case 1:
        return this.texel0[3];
      case 2:
        return this.texel1[3];
      case 3:
        return this.prim[3];
      case 4:
        return this.shade[3];
      case 5:
        return this.env[3];
      case 6:
        return this.primLod;
    }
    return 0;
  }

  // ---- 画面へ書く ----
  private readFb(i: number): void {
    const m = this.mem;
    const n = this.n64;
    if (this.ciSize === 2) {
      const a = this.ciAddr + i * 2;
      const v = a < n.ramSize ? n.ram16[(a >> 1) ^ 1] : 0;
      rgba16(v, m);
    } else if (this.ciSize === 3) {
      const a = this.ciAddr + i * 4;
      const v = a < n.ramSize ? n.ram32[a >> 2] : 0;
      m[0] = v >>> 24;
      m[1] = (v >> 16) & 0xff;
      m[2] = (v >> 8) & 0xff;
      m[3] = v & 0xff;
    } else {
      const v = this.ramByte(this.ciAddr + i);
      m[0] = m[1] = m[2] = v;
      m[3] = 255;
    }
  }

  private writeFb(i: number, r: number, g: number, b: number): void {
    const n = this.n64;
    if (this.ciSize === 2) {
      const a = this.ciAddr + i * 2;
      if (a < n.ramSize) n.ram16[(a >> 1) ^ 1] = ((r >> 3) << 11) | ((g >> 3) << 6) | ((b >> 3) << 1) | 1;
    } else if (this.ciSize === 3) {
      const a = this.ciAddr + i * 4;
      if (a < n.ramSize) n.ram32[a >> 2] = (r << 24) | (g << 16) | (b << 8) | 0xff;
    } else {
      const a = this.ciAddr + i;
      if (a < n.ramSize) n.ram8[a ^ 3] = r;
    }
  }

  private blendIn(sel: number, pixel: Int32Array): Int32Array {
    switch (sel) {
      case 0:
        return pixel;
      case 1:
        return this.mem;
      case 2:
        return this.blendC;
    }
    return this.fog;
  }

  /** ブレンダーを 1 回。結果は out へ（pixel と同じ配列でもよい） */
  private blend(cycle: number, pixel: Int32Array, alpha: number, out: Int32Array): void {
    const lo = this.omLo;
    const sh = cycle === 0 ? 2 : 0;
    const m1a = (lo >>> (28 + sh)) & 3;
    const m1b = (lo >>> (24 + sh)) & 3;
    const m2a = (lo >>> (20 + sh)) & 3;
    const m2b = (lo >>> (16 + sh)) & 3;
    const P = this.blendIn(m1a, pixel);
    const M = this.blendIn(m2a, pixel);
    let A: number;
    switch (m1b) {
      case 0:
        A = alpha;
        break;
      case 1:
        A = this.fog[3];
        break;
      case 2:
        A = this.shade[3];
        break;
      default:
        A = 0;
    }
    let B: number;
    switch (m2b) {
      case 0:
        B = 255 - A;
        break;
      case 1:
        B = 255; // 画面の透明度（カバレッジ）は「全部」とみなす
        break;
      case 2:
        B = 255;
        break;
      default:
        B = 0;
    }
    const r = clamp8((P[0] * A + M[0] * B + 127) / 255 | 0);
    const g = clamp8((P[1] * A + M[1] * B + 127) / 255 | 0);
    const b = clamp8((P[2] * A + M[2] * B + 127) / 255 | 0);
    out[0] = r;
    out[1] = g;
    out[2] = b;
  }

  private pix = new Int32Array(4);

  /** 合成の終わった色（comb）を、Z・透明の判定をして画面へ。z は 18 ビット（Z を使わないときは -1） */
  private plot(x: number, y: number, z: number, dz: number): void {
    const lo = this.omLo;
    const i = y * this.ciWidth + x;
    const comb = this.comb;
    let alpha = comb[3];
    // 透明度で消す
    if (lo & 1) {
      if (alpha < this.blendC[3]) return;
    }
    if (lo & 0x1000 && alpha === 0) return;
    const n = this.n64;
    let zAddr = 0;
    if (z >= 0 && lo & 0x30) {
      zAddr = this.ziAddr + i * 2;
      if (lo & 0x10 && zAddr < n.ramSize) {
        const old = Z_DEC[n.ram16[(zAddr >> 1) ^ 1] >> 2];
        const mode = (lo >> 10) & 3;
        let pass: boolean;
        if (mode === 3) pass = Math.abs(z - old) <= dz;
        else if (mode === 2) pass = z < old;
        else pass = z <= old;
        if (!pass) return;
      }
    }
    const twoCycle = ((this.omHi >> 20) & 3) === 1;
    const force = (lo & 0x4000) !== 0;
    const pix = this.pix;
    pix[0] = comb[0];
    pix[1] = comb[1];
    pix[2] = comb[2];
    const needMem = force || twoCycle;
    if (needMem) this.readFb(i);
    if (lo & 0x2000) {
      // 透明度を「重なり具合」として使う絵（ふちどり）は、そのままの濃さで重ねる
      alpha = lo & 0x1000 ? alpha : 255;
    }
    // 1 サイクルのときは 1 つ目の設定、2 サイクルのときは 1 つ目 → 2 つ目の順に使う
    if (twoCycle) this.blend(0, pix, alpha, pix);
    const last = twoCycle ? 1 : 0;
    if (force) this.blend(last, pix, alpha, pix);
    else {
      // 重ねない設定：1 つ目の入力（P）をそのまま出す
      const m1a = (lo >>> (last === 0 ? 30 : 28)) & 3;
      if (m1a) {
        if (m1a === 1 && !needMem) this.readFb(i);
        const P = m1a === 1 ? this.mem : m1a === 2 ? this.blendC : this.fog;
        pix[0] = P[0];
        pix[1] = P[1];
        pix[2] = P[2];
      }
    }
    this.writeFb(i, pix[0], pix[1], pix[2]);
    if (z >= 0 && lo & 0x20 && zAddr < n.ramSize) n.ram16[(zAddr >> 1) ^ 1] = zEncode(z);
  }

  // ---- 四角形 ----
  private fillRect(): void {
    const w0 = this.w[0];
    const w1 = this.w[1];
    const cycle = (this.omHi >> 20) & 3;
    let x1 = ((w0 >> 12) & 0xfff) >> 2;
    let y1 = (w0 & 0xfff) >> 2;
    let x0 = ((w1 >> 12) & 0xfff) >> 2;
    let y0 = (w1 & 0xfff) >> 2;
    if (cycle >= 2) {
      x1++;
      y1++;
    }
    x0 = Math.max(x0, this.scX0);
    y0 = Math.max(y0, this.scY0);
    x1 = Math.min(x1, this.scX1);
    y1 = Math.min(y1, this.scY1);
    const n = this.n64;
    if (cycle === 3) {
      // 塗りつぶし
      const c = this.fillColor;
      if (this.ciSize === 2) {
        const hi = c >>> 16;
        const lo = c & 0xffff;
        for (let y = y0; y < y1; y++) {
          const row = (this.ciAddr >> 1) + y * this.ciWidth;
          for (let x = x0; x < x1; x++) {
            const a = row + x;
            if (a < n.ramSize >> 1) n.ram16[a ^ 1] = x & 1 ? lo : hi;
          }
        }
      } else if (this.ciSize === 3) {
        for (let y = y0; y < y1; y++) {
          const row = (this.ciAddr >> 2) + y * this.ciWidth;
          for (let x = x0; x < x1; x++) if (row + x < n.ramSize >> 2) n.ram32[row + x] = c;
        }
      } else {
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const a = this.ciAddr + y * this.ciWidth + x;
            if (a < n.ramSize) n.ram8[a ^ 3] = (c >>> ((3 - (x & 3)) * 8)) & 0xff;
          }
      }
      return;
    }
    // 色の合成つき（テクスチャ・シェードなし）
    this.shade.fill(0);
    this.texel0.fill(0);
    this.texel1.fill(0);
    const two = cycle === 1;
    const z = this.omLo & 4 ? this.primZ << 3 : -1;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (two) this.combine(0);
        this.combine(1);
        this.plot(x, y, z, this.primDz);
      }
  }

  private texRect(flip: boolean): void {
    const w = this.w;
    const cycle = (this.omHi >> 20) & 3;
    let x1 = ((w[0] >> 12) & 0xfff) >> 2;
    let y1 = (w[0] & 0xfff) >> 2;
    const tile = (w[1] >> 24) & 7;
    const x0r = ((w[1] >> 12) & 0xfff) >> 2;
    const y0r = (w[1] & 0xfff) >> 2;
    let s0 = w[2] >> 16;
    let t0 = (w[2] << 16) >> 16;
    let dsdx = w[3] >> 16;
    const dtdy = (w[3] << 16) >> 16;
    if (cycle >= 2) {
      x1++;
      y1++;
      if (cycle === 2) dsdx >>= 2;
    }
    const x0 = Math.max(x0r, this.scX0);
    const y0 = Math.max(y0r, this.scY0);
    x1 = Math.min(x1, this.scX1);
    y1 = Math.min(y1, this.scY1);
    // 10.5 の座標を 10.10 にして進める
    s0 <<= 5;
    t0 <<= 5;
    const two = cycle === 1;
    const copy = cycle === 2;
    const t = this.tiles[tile];
    const tex1 = (tile + 1) & 7;
    const z = this.omLo & 4 ? this.primZ << 3 : -1;
    this.shade.fill(0);
    for (let y = y0; y < y1; y++) {
      const tv = t0 + (y - y0r) * dtdy;
      for (let x = x0; x < x1; x++) {
        const sv = s0 + (x - x0r) * dsdx;
        const s = flip ? tv >> 5 : sv >> 5;
        const tt = flip ? sv >> 5 : tv >> 5;
        if (copy) {
          // そのまま写す
          let cs = s;
          let ct = tt;
          if (t.shiftS) cs = t.shiftS > 10 ? cs << (16 - t.shiftS) : cs >> t.shiftS;
          if (t.shiftT) ct = t.shiftT > 10 ? ct << (16 - t.shiftT) : ct >> t.shiftT;
          this.fetch(t, (cs - (t.sl << 3)) >> 5, (ct - (t.tl << 3)) >> 5, this.texel0);
          const c = this.texel0;
          if (this.omLo & 1 && c[3] === 0) continue;
          this.writeFb(y * this.ciWidth + x, c[0], c[1], c[2]);
          continue;
        }
        this.sample(tile, s, tt, this.texel0);
        if (two) {
          this.sample(tex1, s, tt, this.texel1);
          this.combine(0);
        }
        this.combine(1);
        this.plot(x, y, z, this.primDz);
      }
    }
  }

  // ---- 三角形 ----
  private triangle(cmd: number): void {
    const w = this.w;
    const shadeOn = (cmd & 4) !== 0;
    const texOn = (cmd & 2) !== 0;
    const zOn = (cmd & 1) !== 0;
    const lft = (w[0] & 0x800000) !== 0;
    const tile = (w[0] >> 16) & 7;
    const yl = (w[0] << 18) >> 18;
    const ym = (w[1] << 2) >> 18;
    const yh = (w[1] << 18) >> 18;
    const xl = w[2];
    const dxldy = w[3];
    const xh = w[4];
    const dxhdy = w[5];
    const xm = w[6];
    const dxmdy = w[7];
    let p = 8;
    // 色・テクスチャ・Z の始まりの値と、横（dx）・主辺ぞい（de）の変化
    let r0 = 0, g0 = 0, b0 = 0, a0 = 0, drdx = 0, dgdx = 0, dbdx = 0, dadx = 0, drde = 0, dgde = 0, dbde = 0, dade = 0;
    if (shadeOn) {
      const f = (i: number, j: number, hiHalf: boolean) => {
        const hi = hiHalf ? w[p + i] >> 16 : (w[p + i] << 16) >> 16;
        const lo = hiHalf ? w[p + j] >>> 16 : w[p + j] & 0xffff;
        return hi * 65536 + lo;
      };
      r0 = f(0, 4, true);
      g0 = f(0, 4, false);
      b0 = f(1, 5, true);
      a0 = f(1, 5, false);
      drdx = f(2, 6, true);
      dgdx = f(2, 6, false);
      dbdx = f(3, 7, true);
      dadx = f(3, 7, false);
      drde = f(8, 12, true);
      dgde = f(8, 12, false);
      dbde = f(9, 13, true);
      dade = f(9, 13, false);
      p += 16;
    }
    let s0 = 0, t0 = 0, w0 = 0, dsdx = 0, dtdx = 0, dwdx = 0, dsde = 0, dtde = 0, dwde = 0;
    if (texOn) {
      const f = (i: number, j: number, hiHalf: boolean) => {
        const hi = hiHalf ? w[p + i] >> 16 : (w[p + i] << 16) >> 16;
        const lo = hiHalf ? w[p + j] >>> 16 : w[p + j] & 0xffff;
        return hi * 65536 + lo;
      };
      s0 = f(0, 4, true);
      t0 = f(0, 4, false);
      w0 = f(1, 5, true);
      dsdx = f(2, 6, true);
      dtdx = f(2, 6, false);
      dwdx = f(3, 7, true);
      dsde = f(8, 12, true);
      dtde = f(8, 12, false);
      dwde = f(9, 13, true);
      p += 16;
    }
    let z0 = 0, dzdx = 0, dzde = 0, dzdy = 0;
    if (zOn) {
      z0 = w[p];
      dzdx = w[p + 1];
      dzde = w[p + 2];
      dzdy = w[p + 3];
    }
    const cycle = (this.omHi >> 20) & 3;
    const two = cycle === 1;
    const persp = (this.omHi & 0x80000) !== 0;
    const zPrim = (this.omLo & 4) !== 0;
    const useZ = zOn || zPrim;
    const dzpix = zPrim ? this.primDz : (Math.abs(dzdx) + Math.abs(dzdy)) / 8192;
    const dzTol = Math.max(dzpix * 2, 16);
    const tex1 = (tile + 1) & 7;
    const shade = this.shade;
    if (!shadeOn) shade.fill(0);
    if (!texOn) {
      this.texel0.fill(0);
      this.texel1.fill(0);
    }

    const yhBase = yh & ~3;
    const y0 = Math.max(yh >> 2, this.scY0);
    const y1 = Math.min((yl - 1) >> 2, this.scY1 - 1);
    for (let y = y0; y <= y1; y++) {
      // 1 ラインを 4 つに分けた位置で辺を調べ、いちばん外側までを描く
      let left = Infinity;
      let right = -Infinity;
      for (let sub = 0; sub < 4; sub++) {
        const yy = y * 4 + sub;
        if (yy < yh || yy >= yl) continue;
        const major = xh + dxhdy * ((yy - yhBase) / 4);
        const minor = yy < ym ? xm + dxmdy * ((yy - yhBase) / 4) : xl + dxldy * ((yy - ym) / 4);
        const l = lft ? major : minor;
        const rr = lft ? minor : major;
        if (l < left) left = l;
        if (rr > right) right = rr;
      }
      if (left > right) continue;
      let xs = Math.ceil(left / 65536);
      let xe = Math.ceil(right / 65536) - 1;
      if (xs < this.scX0) xs = this.scX0;
      if (xe >= this.scX1) xe = this.scX1 - 1;
      if (xs > xe) continue;
      // 主辺の上での値（このラインの頭）
      const dy = y - (yh >> 2);
      const xMajor = (xh + dxhdy * dy) / 65536;
      const er = r0 + drde * dy;
      const eg = g0 + dgde * dy;
      const eb = b0 + dbde * dy;
      const ea = a0 + dade * dy;
      const es = s0 + dsde * dy;
      const et = t0 + dtde * dy;
      const ew = w0 + dwde * dy;
      const ez = z0 + dzde * dy;
      for (let x = xs; x <= xe; x++) {
        const dx = x - xMajor;
        if (shadeOn) {
          shade[0] = clamp8((er + drdx * dx) / 65536);
          shade[1] = clamp8((eg + dgdx * dx) / 65536);
          shade[2] = clamp8((eb + dbdx * dx) / 65536);
          shade[3] = clamp8((ea + dadx * dx) / 65536);
        }
        if (texOn) {
          let s = es + dsdx * dx;
          let t = et + dtdx * dx;
          if (persp) {
            const ww = ew + dwdx * dx;
            if (ww > 0) {
              s = (s / ww) * 32768;
              t = (t / ww) * 32768;
            } else {
              s = 0x7fff;
              t = 0x7fff;
            }
          } else {
            s /= 65536;
            t /= 65536;
          }
          const si = s | 0;
          const ti = t | 0;
          this.sample(tile, si, ti, this.texel0);
          if (two) this.sample(tex1, si, ti, this.texel1);
        }
        if (cycle === 3) {
          // 塗りつぶしモードの三角形
          const c = this.fillColor;
          const i = y * this.ciWidth + x;
          if (this.ciSize === 2) this.writeFb16(i, x & 1 ? c & 0xffff : c >>> 16);
          else this.writeFb(i, c >>> 24, (c >> 16) & 0xff, (c >> 8) & 0xff);
          continue;
        }
        if (two) this.combine(0);
        this.combine(1);
        let z = -1;
        if (useZ) {
          if (zPrim) z = this.primZ << 3;
          else {
            z = (ez + dzdx * dx) / 8192;
            z = z < 0 ? 0 : z > 0x3ffff ? 0x3ffff : z | 0;
          }
        }
        this.plot(x, y, z, dzTol);
      }
    }
  }

  private writeFb16(i: number, v: number): void {
    const a = this.ciAddr + i * 2;
    if (a < this.n64.ramSize) this.n64.ram16[(a >> 1) ^ 1] = v;
  }

  stateSkip(): unknown[] {
    return [this.w, this.one, this.zero, this.tmpC, this.pix];
  }
}

function setColor(c: Int32Array, v: number): void {
  c[0] = v >>> 24;
  c[1] = (v >> 16) & 0xff;
  c[2] = (v >> 8) & 0xff;
  c[3] = v & 0xff;
}

function rgba16(v: number, out: Int32Array): void {
  const r = (v >> 11) & 31;
  const g = (v >> 6) & 31;
  const b = (v >> 1) & 31;
  out[0] = (r << 3) | (r >> 2);
  out[1] = (g << 3) | (g >> 2);
  out[2] = (b << 3) | (b >> 2);
  out[3] = v & 1 ? 255 : 0;
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
