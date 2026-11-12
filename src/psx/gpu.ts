// プレイステーションの GPU：1MB の画面メモリ（VRAM。1024 × 512 の 16 ビットの点）に、
// 三角形・四角形・線・スプライトを描く。テクスチャ（4・8・15 ビット）、グーロー（色のなめらかな変化）、
// 半透明 4 種類、ディザ、マスクビットまで実機どおりにする。描いた VRAM の一部を画面に出す

/** 15 ビットの色 → 画面バッファの色（ABGR） */
const RGB15 = new Uint32Array(0x8000);
for (let c = 0; c < 0x8000; c++) {
  const r = c & 31;
  const g = (c >> 5) & 31;
  const b = (c >> 10) & 31;
  RGB15[c] = 0xff000000 | (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2));
}

/** ディザの表（4 × 4） */
const DITHER = [-4, 0, -3, 1, 2, -2, 3, -1, -3, 1, -4, 0, 3, -1, 2, -2];

/** 8 ビットの値 + ディザ → 5 ビット（[ディザの位置][値 0〜511]） */
const DITHER_LUT: Uint8Array[] = DITHER.map((d) => {
  const t = new Uint8Array(512);
  for (let v = 0; v < 512; v++) t[v] = Math.min(255, Math.max(0, v + d)) >> 3;
  return t;
});
const NO_DITHER = (() => {
  const t = new Uint8Array(512);
  for (let v = 0; v < 512; v++) t[v] = Math.min(255, v) >> 3;
  return t;
})();

/** 1 つの頂点 */
interface Vtx {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  u: number;
  v: number;
}

const HRES = [256, 320, 512, 640];
/** 点 1 つあたりの GPU のクロック数（256・320・512・640・368） */
const DOT_DIV = [10, 8, 5, 4, 7];

export class Gpu {
  vram = new Uint16Array(1024 * 512);
  // GP0(E1〜E6) の設定
  texpage = 0; // E1 の下位 12 ビット（＝ GPUSTAT の 0〜10・15 ビット）
  dither = false;
  drawToDisplay = false;
  texDisable = false;
  rectFlipX = false;
  rectFlipY = false;
  twMaskX = 0;
  twMaskY = 0;
  twOffX = 0;
  twOffY = 0;
  areaX1 = 0;
  areaY1 = 0;
  areaX2 = 0;
  areaY2 = 0;
  offX = 0;
  offY = 0;
  setMask = false;
  checkMask = false;
  // GP1 の設定
  displayOff = true;
  dmaDir = 0;
  dispX = 0;
  dispY = 0;
  hStart = 0x200;
  hEnd = 0xc00;
  vStart = 0x10;
  vEnd = 0x100;
  /** GP1(08) の値 */
  dispMode = 0;
  irq = false;
  allowTexDisable = false;
  /** 奇数・偶数のフィールド（GPUSTAT の 31・13 ビット） */
  field = 0;
  lineOdd = 0;
  // コマンドの受け取り
  private cmd = new Uint32Array(16);
  private cmdLen = 0;
  private cmdNeed = 0;
  private poly = false; // 折れ線を受け取っている
  private polyWords: number[] = [];
  // CPU → VRAM・VRAM → CPU の転送
  private xfer = 0; // 0 なし、1 書き込み、2 読み出し
  private xX = 0;
  private xY = 0;
  private xW = 0;
  private xH = 0;
  private xI = 0;
  readBuf = 0;
  /** GPU の割り込みを出す */
  onIrq: () => void = () => {};

  /** 画面に出す部分（render で作る） */
  frameBuffer = new Uint32Array(320 * 240);
  outW = 320;
  outH = 240;
  pal = false;

  // ---- レジスタ ----
  get stat(): number {
    let s = this.texpage & 0x1ff;
    if (this.dither) s |= 1 << 9;
    if (this.drawToDisplay) s |= 1 << 10;
    if (this.setMask) s |= 1 << 11;
    if (this.checkMask) s |= 1 << 12;
    if (this.texDisable) s |= 1 << 15;
    const m = this.dispMode;
    s |= ((m >> 6) & 1) << 16;
    s |= (m & 3) << 17;
    s |= ((m >> 2) & 1) << 19;
    s |= ((m >> 3) & 1) << 20;
    s |= ((m >> 4) & 1) << 21;
    s |= ((m >> 5) & 1) << 22;
    s |= ((m >> 7) & 1) << 14;
    if (this.displayOff) s |= 1 << 23;
    if (this.irq) s |= 1 << 24;
    // 26 コマンドを受け取れる、27 VRAM を送れる、28 DMA を受け取れる
    s |= 1 << 26;
    if (this.xfer === 2) s |= 1 << 27;
    s |= 1 << 28;
    s |= this.dmaDir << 29;
    switch (this.dmaDir) {
      case 1:
      case 2:
        s |= 1 << 25;
        break;
      case 3:
        if (this.xfer === 2) s |= 1 << 25;
        break;
    }
    const interlace = (m & 0x24) === 0x24;
    if (interlace) {
      if (this.field) s |= 1 << 13;
      if (this.field) s |= 1 << 31;
    } else {
      s |= 1 << 13;
      if (this.lineOdd) s |= 1 << 31;
    }
    return s >>> 0;
  }

  read(): number {
    if (this.xfer === 2) {
      let v = 0;
      for (let k = 0; k < 2; k++) {
        const x = (this.xX + (this.xI % this.xW)) & 1023;
        const y = (this.xY + Math.floor(this.xI / this.xW)) & 511;
        v |= this.vram[y * 1024 + x] << (k * 16);
        this.xI++;
        if (this.xI >= this.xW * this.xH) {
          this.xfer = 0;
          break;
        }
      }
      this.readBuf = v;
    }
    return this.readBuf;
  }

  gp1(v: number): void {
    const p = v & 0xffffff;
    switch ((v >>> 24) & 0x3f) {
      case 0x00:
        this.gp1(0x01000000);
        this.irq = false;
        this.displayOff = true;
        this.dmaDir = 0;
        this.dispX = this.dispY = 0;
        this.hStart = 0x200;
        this.hEnd = 0xc00;
        this.vStart = 0x10;
        this.vEnd = 0x100;
        this.dispMode = 0;
        this.texpage = 0;
        this.dither = this.drawToDisplay = this.texDisable = false;
        this.rectFlipX = this.rectFlipY = false;
        this.twMaskX = this.twMaskY = this.twOffX = this.twOffY = 0;
        this.areaX1 = this.areaY1 = this.areaX2 = this.areaY2 = 0;
        this.offX = this.offY = 0;
        this.setMask = this.checkMask = false;
        return;
      case 0x01:
        this.cmdLen = 0;
        this.cmdNeed = 0;
        this.poly = false;
        this.xfer = 0;
        return;
      case 0x02:
        this.irq = false;
        return;
      case 0x03:
        this.displayOff = (v & 1) !== 0;
        return;
      case 0x04:
        this.dmaDir = v & 3;
        return;
      case 0x05:
        this.dispX = p & 0x3fe;
        this.dispY = (p >> 10) & 0x1ff;
        return;
      case 0x06:
        this.hStart = p & 0xfff;
        this.hEnd = (p >> 12) & 0xfff;
        return;
      case 0x07:
        this.vStart = p & 0x3ff;
        this.vEnd = (p >> 10) & 0x3ff;
        return;
      case 0x08:
        this.dispMode = p & 0xff;
        return;
      case 0x09:
        this.allowTexDisable = (v & 1) !== 0;
        return;
      case 0x10:
      case 0x11:
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15:
      case 0x16:
      case 0x17:
      case 0x18:
      case 0x19:
      case 0x1a:
      case 0x1b:
      case 0x1c:
      case 0x1d:
      case 0x1e:
      case 0x1f:
        switch (v & 7) {
          case 2:
            this.readBuf = (this.twMaskX | (this.twMaskY << 5) | (this.twOffX << 10) | (this.twOffY << 15)) >>> 0;
            break;
          case 3:
            this.readBuf = this.areaX1 | (this.areaY1 << 10);
            break;
          case 4:
            this.readBuf = this.areaX2 | (this.areaY2 << 10);
            break;
          case 5:
            this.readBuf = (this.offX & 0x7ff) | ((this.offY & 0x7ff) << 11);
            break;
          case 7:
            this.readBuf = 2;
            break;
        }
        return;
    }
  }

  gp0(v: number): void {
    if (this.xfer === 1) {
      this.writePixel(v & 0xffff);
      if (this.xfer === 1) this.writePixel(v >>> 16);
      return;
    }
    if (this.poly) {
      this.polyWords.push(v);
      if ((v & 0xf000f000) === 0x50005000 && this.polyWords.length >= 3) {
        this.poly = false;
        this.drawPolyLine();
      }
      return;
    }
    if (this.cmdLen === 0) {
      const c = v >>> 24;
      this.cmdNeed = cmdLength(c);
      if ((c & 0xe0) === 0x40 && c & 0x08) {
        // 折れ線：終わりの印まで受け取る
        this.poly = true;
        this.polyWords = [v];
        return;
      }
    }
    this.cmd[this.cmdLen++] = v;
    if (this.cmdLen >= this.cmdNeed) {
      this.cmdLen = 0;
      this.exec();
    }
  }

  private exec(): void {
    const c = this.cmd;
    const op = c[0] >>> 24;
    if (op >= 0x20 && op < 0x40) return this.polygon(op);
    if (op >= 0x40 && op < 0x60) return this.line(op);
    if (op >= 0x60 && op < 0x80) return this.rect(op);
    if (op >= 0x80 && op < 0xa0) return this.copy();
    if (op >= 0xa0 && op < 0xc0) {
      this.xX = c[1] & 0x3ff;
      this.xY = (c[1] >>> 16) & 0x1ff;
      this.xW = ((c[2] & 0xffff) - 1 & 0x3ff) + 1;
      this.xH = (((c[2] >>> 16) - 1) & 0x1ff) + 1;
      this.xI = 0;
      this.xfer = 1;
      return;
    }
    if (op >= 0xc0 && op < 0xe0) {
      this.xX = c[1] & 0x3ff;
      this.xY = (c[1] >>> 16) & 0x1ff;
      this.xW = ((c[2] & 0xffff) - 1 & 0x3ff) + 1;
      this.xH = (((c[2] >>> 16) - 1) & 0x1ff) + 1;
      this.xI = 0;
      this.xfer = 2;
      return;
    }
    const p = c[0] & 0xffffff;
    switch (op) {
      case 0x02:
        return this.fill();
      case 0x1f:
        this.irq = true;
        this.onIrq();
        return;
      case 0xe1:
        this.texpage = (p & 0x1ff) | (p & 0x800 ? 0x8000 : 0);
        this.dither = (p & 0x200) !== 0;
        this.drawToDisplay = (p & 0x400) !== 0;
        this.texDisable = this.allowTexDisable && (p & 0x800) !== 0;
        this.rectFlipX = (p & 0x1000) !== 0;
        this.rectFlipY = (p & 0x2000) !== 0;
        return;
      case 0xe2:
        this.twMaskX = p & 31;
        this.twMaskY = (p >> 5) & 31;
        this.twOffX = (p >> 10) & 31;
        this.twOffY = (p >> 15) & 31;
        return;
      case 0xe3:
        this.areaX1 = p & 0x3ff;
        this.areaY1 = (p >> 10) & 0x1ff;
        return;
      case 0xe4:
        this.areaX2 = p & 0x3ff;
        this.areaY2 = (p >> 10) & 0x1ff;
        return;
      case 0xe5:
        this.offX = (p << 21) >> 21;
        this.offY = (p << 10) >> 21;
        return;
      case 0xe6:
        this.setMask = (p & 1) !== 0;
        this.checkMask = (p & 2) !== 0;
        return;
    }
  }

  private writePixel(px: number): void {
    const x = (this.xX + (this.xI % this.xW)) & 1023;
    const y = (this.xY + Math.floor(this.xI / this.xW)) & 511;
    const i = y * 1024 + x;
    if (!this.checkMask || !(this.vram[i] & 0x8000)) this.vram[i] = px | (this.setMask ? 0x8000 : 0);
    this.xI++;
    if (this.xI >= this.xW * this.xH) this.xfer = 0;
  }

  private fill(): void {
    const c = this.cmd;
    const col = c[0];
    const px = ((col >> 3) & 31) | (((col >> 11) & 31) << 5) | (((col >> 19) & 31) << 10);
    const x0 = c[1] & 0x3f0;
    const y0 = (c[1] >>> 16) & 0x1ff;
    const w = ((c[2] & 0x3ff) + 15) & ~15;
    const h = (c[2] >>> 16) & 0x1ff;
    const vr = this.vram;
    for (let y = 0; y < h; y++) {
      const row = ((y0 + y) & 511) * 1024;
      for (let x = 0; x < w; x++) vr[row + ((x0 + x) & 1023)] = px;
    }
  }

  private copy(): void {
    const c = this.cmd;
    const sx = c[1] & 0x3ff;
    const sy = (c[1] >>> 16) & 0x1ff;
    const dx = c[2] & 0x3ff;
    const dy = (c[2] >>> 16) & 0x1ff;
    const w = ((c[3] & 0xffff) - 1 & 0x3ff) + 1;
    const h = (((c[3] >>> 16) - 1) & 0x1ff) + 1;
    const vr = this.vram;
    const mask = this.setMask ? 0x8000 : 0;
    const row = new Uint16Array(w);
    for (let y = 0; y < h; y++) {
      const s = ((sy + y) & 511) * 1024;
      for (let x = 0; x < w; x++) row[x] = vr[s + ((sx + x) & 1023)];
      const d = ((dy + y) & 511) * 1024;
      for (let x = 0; x < w; x++) {
        const i = d + ((dx + x) & 1023);
        if (this.checkMask && vr[i] & 0x8000) continue;
        vr[i] = row[x] | mask;
      }
    }
  }

  // ---- 描く ----
  private vtx: Vtx[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, r: 0, g: 0, b: 0, u: 0, v: 0 }));

  private polygon(op: number): void {
    const c = this.cmd;
    const shaded = (op & 0x10) !== 0;
    const quad = (op & 0x08) !== 0;
    const textured = (op & 0x04) !== 0;
    const semi = (op & 0x02) !== 0;
    const raw = (op & 0x01) !== 0;
    const n = quad ? 4 : 3;
    let i = 0;
    let clut = 0;
    let tpage = this.texpage;
    for (let k = 0; k < n; k++) {
      const p = this.vtx[k];
      const col = k === 0 || !shaded ? c[0] : c[i++];
      if (k === 0) i = 1;
      p.r = col & 0xff;
      p.g = (col >> 8) & 0xff;
      p.b = (col >> 16) & 0xff;
      const xy = c[i++];
      p.x = ((xy << 21) >> 21) + this.offX;
      p.y = ((xy << 5) >> 21) + this.offY;
      if (textured) {
        const uv = c[i++];
        p.u = uv & 0xff;
        p.v = (uv >> 8) & 0xff;
        if (k === 0) clut = uv >>> 16;
        if (k === 1) tpage = uv >>> 16;
      }
    }
    if (textured) {
      // テクスチャのページは GPUSTAT にも反映される
      this.texpage = (this.texpage & ~0x9ff) | (tpage & 0x1ff) | (this.allowTexDisable && tpage & 0x800 ? 0x8000 : 0);
      this.texDisable = (this.texpage & 0x8000) !== 0;
    }
    const tex = textured && !this.texDisable;
    const v = this.vtx;
    this.triangle(v[0], v[1], v[2], shaded, tex, raw, semi, clut, tpage);
    if (quad) this.triangle(v[1], v[2], v[3], shaded, tex, raw, semi, clut, tpage);
  }

  private triangle(a: Vtx, b: Vtx, c: Vtx, shaded: boolean, tex: boolean, raw: boolean, semi: boolean, clut: number, tpage: number): void {
    let area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (area === 0) return;
    if (area < 0) {
      const t = b;
      b = c;
      c = t;
      area = -area;
    }
    const minX0 = Math.min(a.x, b.x, c.x);
    const maxX0 = Math.max(a.x, b.x, c.x);
    const minY0 = Math.min(a.y, b.y, c.y);
    const maxY0 = Math.max(a.y, b.y, c.y);
    if (maxX0 - minX0 >= 1024 || maxY0 - minY0 >= 512) return;
    const minX = Math.max(minX0, this.areaX1);
    const maxX = Math.min(maxX0, this.areaX2);
    const minY = Math.max(minY0, this.areaY1);
    const maxY = Math.min(maxY0, this.areaY2);
    if (minX > maxX || minY > maxY) return;

    // 辺の式：内側で 0 以上。上・左の辺の上の点は含め、下・右の辺の上の点は含めない
    const e0x = b.y - a.y; // 辺 a→b
    const e0y = b.x - a.x;
    const e1x = c.y - b.y; // 辺 b→c
    const e1y = c.x - b.x;
    const e2x = a.y - c.y; // 辺 c→a
    const e2y = a.x - c.x;
    const bias0 = e0x < 0 || (e0x === 0 && e0y > 0) ? 0 : -1;
    const bias1 = e1x < 0 || (e1x === 0 && e1y > 0) ? 0 : -1;
    const bias2 = e2x < 0 || (e2x === 0 && e2y > 0) ? 0 : -1;

    // 色・テクスチャ座標の変化の割合
    const d1x = b.x - a.x;
    const d1y = b.y - a.y;
    const d2x = c.x - a.x;
    const d2y = c.y - a.y;
    const gx = (fa: number, fb: number, fc: number) => ((fb - fa) * d2y - (fc - fa) * d1y) / area;
    const gy = (fa: number, fb: number, fc: number) => ((fc - fa) * d1x - (fb - fa) * d2x) / area;
    const rdx = shaded ? gx(a.r, b.r, c.r) : 0;
    const rdy = shaded ? gy(a.r, b.r, c.r) : 0;
    const gdx = shaded ? gx(a.g, b.g, c.g) : 0;
    const gdy = shaded ? gy(a.g, b.g, c.g) : 0;
    const bdx = shaded ? gx(a.b, b.b, c.b) : 0;
    const bdy = shaded ? gy(a.b, b.b, c.b) : 0;
    const udx = tex ? gx(a.u, b.u, c.u) : 0;
    const udy = tex ? gy(a.u, b.u, c.u) : 0;
    const vdx = tex ? gx(a.v, b.v, c.v) : 0;
    const vdy = tex ? gy(a.v, b.v, c.v) : 0;

    const vr = this.vram;
    const dith = this.dither && (shaded || (tex && !raw));
    const mode = (tpage >> 5) & 3;
    const tdepth = (tpage >> 7) & 3;
    const tbx = (tpage & 15) * 64;
    const tby = ((tpage >> 4) & 1) * 256;
    const cx = (clut & 63) * 16;
    const cy = (clut >> 6) & 511;
    const maskOr = this.setMask ? 0x8000 : 0;
    const check = this.checkMask;
    const twmx = ~(this.twMaskX * 8) & 0xff;
    const twox = (this.twOffX & this.twMaskX) * 8;
    const twmy = ~(this.twMaskY * 8) & 0xff;
    const twoy = (this.twOffY & this.twMaskY) * 8;

    // 最初の点（少しだけずらして、ちょうど境目の値が下へ丸まらないように）
    const E = 1 / 1024;
    for (let y = minY; y <= maxY; y++) {
      let w0 = e0y * (y - a.y) - e0x * (minX - a.x);
      let w1 = e1y * (y - b.y) - e1x * (minX - b.x);
      let w2 = e2y * (y - c.y) - e2x * (minX - c.x);
      const fx = minX - a.x;
      const fy = y - a.y;
      let r = a.r + rdx * fx + rdy * fy + E;
      let g = a.g + gdx * fx + gdy * fy + E;
      let bb = a.b + bdx * fx + bdy * fy + E;
      let u = a.u + udx * fx + udy * fy + E;
      let v = a.v + vdx * fx + vdy * fy + E;
      const row = y * 1024;
      const drow = (y & 3) * 4;
      let inside = false;
      for (let x = minX; x <= maxX; x++, w0 -= e0x, w1 -= e1x, w2 -= e2x, r += rdx, g += gdx, bb += bdx, u += udx, v += vdx) {
        if (w0 + bias0 < 0 || w1 + bias1 < 0 || w2 + bias2 < 0) {
          if (inside) break;
          continue;
        }
        inside = true;
        const idx = row + x;
        const dst = vr[idx];
        if (check && dst & 0x8000) continue;
        const lut = dith ? DITHER_LUT[drow + (x & 3)] : NO_DITHER;
        let out: number;
        let transparent = semi;
        if (tex) {
          const tu = ((u | 0) & twmx) | twox;
          const tv = ((v | 0) & twmy) | twoy;
          let t: number;
          const ty = ((tby + tv) & 511) * 1024;
          if (tdepth === 0) {
            const w = vr[ty + ((tbx + (tu >> 2)) & 1023)];
            t = vr[cy * 1024 + ((cx + ((w >> ((tu & 3) * 4)) & 15)) & 1023)];
          } else if (tdepth === 1) {
            const w = vr[ty + ((tbx + (tu >> 1)) & 1023)];
            t = vr[cy * 1024 + ((cx + ((w >> ((tu & 1) * 8)) & 255)) & 1023)];
          } else t = vr[ty + ((tbx + tu) & 1023)];
          if (t === 0) continue;
          transparent = semi && (t & 0x8000) !== 0;
          if (raw) out = t;
          else {
            const cr = shaded ? r | 0 : a.r;
            const cg = shaded ? g | 0 : a.g;
            const cb = shaded ? bb | 0 : a.b;
            out =
              lut[((t & 31) * cr) >> 4] |
              (lut[(((t >> 5) & 31) * cg) >> 4] << 5) |
              (lut[(((t >> 10) & 31) * cb) >> 4] << 10) |
              (t & 0x8000);
          }
        } else if (shaded) out = lut[r | 0] | (lut[g | 0] << 5) | (lut[bb | 0] << 10);
        else out = (a.r >> 3) | ((a.g >> 3) << 5) | ((a.b >> 3) << 10);
        if (transparent) out = blend(dst, out, mode) | (out & 0x8000);
        vr[idx] = out | maskOr;
      }
    }
  }

  private rect(op: number): void {
    const c = this.cmd;
    const textured = (op & 0x04) !== 0;
    const semi = (op & 0x02) !== 0;
    const raw = (op & 0x01) !== 0;
    const col = c[0];
    const xy = c[1];
    let x0 = ((xy << 21) >> 21) + this.offX;
    let y0 = ((xy << 5) >> 21) + this.offY;
    let i = 2;
    let u0 = 0;
    let v0 = 0;
    let clut = 0;
    if (textured) {
      const uv = c[i++];
      u0 = uv & 0xff;
      v0 = (uv >> 8) & 0xff;
      clut = uv >>> 16;
    }
    let w: number;
    let h: number;
    switch ((op >> 3) & 3) {
      case 0: {
        const wh = c[i++];
        w = wh & 0x3ff;
        h = (wh >>> 16) & 0x1ff;
        break;
      }
      case 1:
        w = h = 1;
        break;
      case 2:
        w = h = 8;
        break;
      default:
        w = h = 16;
    }
    const tex = textured && !this.texDisable;
    const tpage = this.texpage;
    const mode = (tpage >> 5) & 3;
    const tdepth = (tpage >> 7) & 3;
    const tbx = (tpage & 15) * 64;
    const tby = ((tpage >> 4) & 1) * 256;
    const cx = (clut & 63) * 16;
    const cy = (clut >> 6) & 511;
    const maskOr = this.setMask ? 0x8000 : 0;
    const check = this.checkMask;
    const vr = this.vram;
    const cr = col & 0xff;
    const cg = (col >> 8) & 0xff;
    const cb = (col >> 16) & 0xff;
    const flat = (cr >> 3) | ((cg >> 3) << 5) | ((cb >> 3) << 10);
    const twmx = ~(this.twMaskX * 8) & 0xff;
    const twox = (this.twOffX & this.twMaskX) * 8;
    const twmy = ~(this.twMaskY * 8) & 0xff;
    const twoy = (this.twOffY & this.twMaskY) * 8;
    const du = this.rectFlipX ? -1 : 1;
    const dv = this.rectFlipY ? -1 : 1;
    // 描く範囲で切り取る
    let sx = 0;
    let sy = 0;
    if (x0 < this.areaX1) {
      sx = this.areaX1 - x0;
    }
    if (y0 < this.areaY1) {
      sy = this.areaY1 - y0;
    }
    const ex = Math.min(w, this.areaX2 - x0 + 1);
    const ey = Math.min(h, this.areaY2 - y0 + 1);
    for (let yy = sy; yy < ey; yy++) {
      const y = y0 + yy;
      const row = (y & 511) * 1024;
      const tv = (((v0 + yy * dv) & 0xff & twmy) | twoy) & 0xff;
      const ty = ((tby + tv) & 511) * 1024;
      for (let xx = sx; xx < ex; xx++) {
        const x = x0 + xx;
        const idx = row + (x & 1023);
        const dst = vr[idx];
        if (check && dst & 0x8000) continue;
        let out: number;
        let transparent = semi;
        if (tex) {
          const tu = (((u0 + xx * du) & 0xff & twmx) | twox) & 0xff;
          let t: number;
          if (tdepth === 0) {
            const wv = vr[ty + ((tbx + (tu >> 2)) & 1023)];
            t = vr[cy * 1024 + ((cx + ((wv >> ((tu & 3) * 4)) & 15)) & 1023)];
          } else if (tdepth === 1) {
            const wv = vr[ty + ((tbx + (tu >> 1)) & 1023)];
            t = vr[cy * 1024 + ((cx + ((wv >> ((tu & 1) * 8)) & 255)) & 1023)];
          } else t = vr[ty + ((tbx + tu) & 1023)];
          if (t === 0) continue;
          transparent = semi && (t & 0x8000) !== 0;
          if (raw) out = t;
          else
            out =
              NO_DITHER[((t & 31) * cr) >> 4] |
              (NO_DITHER[(((t >> 5) & 31) * cg) >> 4] << 5) |
              (NO_DITHER[(((t >> 10) & 31) * cb) >> 4] << 10) |
              (t & 0x8000);
        } else out = flat;
        if (transparent) out = blend(dst, out, mode) | (out & 0x8000);
        vr[idx] = out | maskOr;
      }
    }
    x0 = y0 = 0;
  }

  private line(op: number): void {
    const c = this.cmd;
    const shaded = (op & 0x10) !== 0;
    const semi = (op & 0x02) !== 0;
    const c0 = c[0];
    const p0 = c[1];
    const c1 = shaded ? c[2] : c0;
    const p1 = shaded ? c[3] : c[2];
    this.drawLine(c0, p0, c1, p1, shaded, semi);
  }

  private drawPolyLine(): void {
    const w = this.polyWords;
    const op = w[0] >>> 24;
    const shaded = (op & 0x10) !== 0;
    const semi = (op & 0x02) !== 0;
    let i = 1;
    let col = w[0];
    let pos = w[i++];
    for (;;) {
      let ncol = col;
      if (shaded) {
        if (i >= w.length || (w[i] & 0xf000f000) === 0x50005000) break;
        ncol = w[i++];
      }
      if (i >= w.length || (w[i] & 0xf000f000) === 0x50005000) break;
      const npos = w[i++];
      this.drawLine(col, pos, ncol, npos, shaded, semi);
      col = ncol;
      pos = npos;
    }
  }

  private drawLine(c0: number, p0: number, c1: number, p1: number, shaded: boolean, semi: boolean): void {
    const x0 = ((p0 << 21) >> 21) + this.offX;
    const y0 = ((p0 << 5) >> 21) + this.offY;
    const x1 = ((p1 << 21) >> 21) + this.offX;
    const y1 = ((p1 << 5) >> 21) + this.offY;
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (Math.abs(dx) >= 1024 || Math.abs(dy) >= 512) return;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    const r0 = c0 & 0xff;
    const g0 = (c0 >> 8) & 0xff;
    const b0 = (c0 >> 16) & 0xff;
    const r1 = c1 & 0xff;
    const g1 = (c1 >> 8) & 0xff;
    const b1 = (c1 >> 16) & 0xff;
    const mode = (this.texpage >> 5) & 3;
    const vr = this.vram;
    const dith = this.dither && shaded;
    const maskOr = this.setMask ? 0x8000 : 0;
    for (let s = 0; s <= steps; s++) {
      const t = steps ? s / steps : 0;
      const x = Math.round(x0 + dx * t);
      const y = Math.round(y0 + dy * t);
      if (x < this.areaX1 || x > this.areaX2 || y < this.areaY1 || y > this.areaY2) continue;
      const idx = (y & 511) * 1024 + (x & 1023);
      const dst = vr[idx];
      if (this.checkMask && dst & 0x8000) continue;
      const lut = dith ? DITHER_LUT[(y & 3) * 4 + (x & 3)] : NO_DITHER;
      const r = shaded ? (r0 + (r1 - r0) * t) | 0 : r0;
      const g = shaded ? (g0 + (g1 - g0) * t) | 0 : g0;
      const b = shaded ? (b0 + (b1 - b0) * t) | 0 : b0;
      let out = lut[r] | (lut[g] << 5) | (lut[b] << 10);
      if (semi) out = blend(dst, out, mode);
      vr[idx] = out | maskOr;
    }
  }

  // ---- 画面に出す ----
  /** 今の表示モードでの横の点の数（画面に見える部分） */
  render(): void {
    const m = this.dispMode;
    const hi = m & 0x40 ? 4 : m & 3;
    const baseW = hi === 4 ? 368 : HRES[hi];
    const div = DOT_DIV[hi];
    let w = Math.round((this.hEnd - this.hStart) / div);
    w = (w + 2) & ~3;
    if (w <= 0 || w > baseW) w = baseW;
    const interlace = (m & 0x24) === 0x24;
    const maxLines = this.pal ? 288 : 240;
    let h = this.vEnd - this.vStart;
    if (h <= 0 || h > maxLines) h = maxLines;
    if (interlace) h *= 2;
    if (this.outW !== w || this.outH !== h || this.frameBuffer.length !== w * h) {
      this.outW = w;
      this.outH = h;
      this.frameBuffer = new Uint32Array(w * h);
    }
    const fb = this.frameBuffer;
    if (this.displayOff) {
      fb.fill(0xff000000);
      return;
    }
    const vr = this.vram;
    const sx = this.dispX;
    const sy = this.dispY;
    if (m & 0x10) {
      // 24 ビットの色（ムービー）
      for (let y = 0; y < h; y++) {
        const row = ((sy + y) & 511) * 1024;
        const o = y * w;
        for (let x = 0; x < w; x++) {
          const bx = sx * 2 + x * 3;
          const i0 = bx >> 1;
          const w0 = vr[row + (i0 & 1023)];
          const w1 = vr[row + ((i0 + 1) & 1023)];
          let r: number;
          let g: number;
          let b: number;
          if (bx & 1) {
            r = w0 >> 8;
            g = w1 & 0xff;
            b = w1 >> 8;
          } else {
            r = w0 & 0xff;
            g = w0 >> 8;
            b = w1 & 0xff;
          }
          fb[o + x] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
      }
      return;
    }
    for (let y = 0; y < h; y++) {
      const row = ((sy + y) & 511) * 1024;
      const o = y * w;
      for (let x = 0; x < w; x++) fb[o + x] = RGB15[vr[row + ((sx + x) & 1023)] & 0x7fff];
    }
  }

  stateSkip(): unknown[] {
    return [this.frameBuffer];
  }
}

/** 半透明：0 = 半々、1 = 足す、2 = 引く、3 = 1/4 を足す */
function blend(bg: number, fg: number, mode: number): number {
  let r: number;
  let g: number;
  let b: number;
  const br = bg & 31;
  const bgg = (bg >> 5) & 31;
  const bb = (bg >> 10) & 31;
  const fr = fg & 31;
  const fgg = (fg >> 5) & 31;
  const fb = (fg >> 10) & 31;
  switch (mode) {
    case 0:
      r = (br + fr) >> 1;
      g = (bgg + fgg) >> 1;
      b = (bb + fb) >> 1;
      break;
    case 1:
      r = Math.min(31, br + fr);
      g = Math.min(31, bgg + fgg);
      b = Math.min(31, bb + fb);
      break;
    case 2:
      r = Math.max(0, br - fr);
      g = Math.max(0, bgg - fgg);
      b = Math.max(0, bb - fb);
      break;
    default:
      r = Math.min(31, br + (fr >> 2));
      g = Math.min(31, bgg + (fgg >> 2));
      b = Math.min(31, bb + (fb >> 2));
  }
  return r | (g << 5) | (b << 10);
}

/** GP0 のコマンドの長さ（ワード数） */
function cmdLength(op: number): number {
  if (op >= 0x20 && op < 0x40) {
    const shaded = op & 0x10;
    const quad = op & 0x08;
    const tex = op & 0x04;
    const n = quad ? 4 : 3;
    return 1 + n * (1 + (tex ? 1 : 0)) + (shaded ? n - 1 : 0);
  }
  if (op >= 0x40 && op < 0x60) return op & 0x10 ? 4 : 3;
  if (op >= 0x60 && op < 0x80) {
    const size = (op >> 3) & 3;
    return 2 + (op & 0x04 ? 1 : 0) + (size === 0 ? 1 : 0);
  }
  if (op >= 0x80 && op < 0xa0) return 4;
  if (op >= 0xa0 && op < 0xe0) return 3;
  if (op === 0x02) return 3;
  return 1;
}
