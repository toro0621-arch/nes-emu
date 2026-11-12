// MDEC：ムービー（JPEG に近い圧縮の絵）をほどく計算機。ほどいた絵は DMA で取り出して VRAM へ送られる

const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53, 10, 19,
  23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
];
/** zigzag の逆（並んだ順 → 8×8 の位置） */
const ZAGZIG = new Uint8Array(64);
for (let i = 0; i < 64; i++) ZAGZIG[ZIGZAG[i]] = i;

const P32 = 4294967296;
const P31 = 2147483648;

export class Mdec {
  private qtY = new Uint8Array(64);
  private qtC = new Uint8Array(64);
  private scale = new Int16Array(64);
  /** 受け取り中のコマンド */
  private cmd = 0;
  private need = 0;
  private input: number[] = [];
  /** 出てきたデータ（ワード） */
  private out = new Uint32Array(0);
  private outPos = 0;
  private outLen = 0;
  enableIn = false;
  enableOut = false;
  private blk = Array.from({ length: 6 }, () => new Int16Array(64));
  private tmp = new Float64Array(64);
  private block = 0;

  get status(): number {
    let s = 0;
    if (this.outPos >= this.outLen) s |= 1 << 31;
    if (this.need > 0 || this.outPos < this.outLen) s |= 1 << 29;
    if (this.enableIn && this.need > 0) s |= 1 << 28;
    if (this.enableOut && this.outPos < this.outLen) s |= 1 << 27;
    s |= ((this.cmd >> 25) & 0xf) << 23;
    s |= (this.block & 7) << 16;
    s |= (this.need - 1) & 0xffff;
    return s >>> 0;
  }

  control(v: number): void {
    if (v & 0x80000000) {
      this.need = 0;
      this.input = [];
      this.outPos = this.outLen = 0;
      this.cmd = 0;
      this.block = 4;
    }
    this.enableIn = (v & 0x40000000) !== 0;
    this.enableOut = (v & 0x20000000) !== 0;
  }

  write(v: number): void {
    if (this.need === 0) {
      this.cmd = v;
      this.input = [];
      switch (v >>> 29) {
        case 1:
          this.need = v & 0xffff;
          break;
        case 2:
          this.need = v & 1 ? 32 : 16;
          break;
        case 3:
          this.need = 32;
          break;
        default:
          this.need = 0;
      }
      return;
    }
    this.input.push(v);
    this.need--;
    if (this.need === 0) this.finish();
  }

  read(): number {
    if (this.outPos < this.outLen) return this.out[this.outPos++];
    return 0;
  }

  private finish(): void {
    const d = this.input;
    switch (this.cmd >>> 29) {
      case 2: {
        for (let i = 0; i < 64; i++) this.qtY[i] = (d[i >> 2] >>> ((i & 3) * 8)) & 0xff;
        if (this.cmd & 1) for (let i = 0; i < 64; i++) this.qtC[i] = (d[16 + (i >> 2)] >>> ((i & 3) * 8)) & 0xff;
        return;
      }
      case 3:
        for (let i = 0; i < 64; i++) this.scale[i] = (d[i >> 1] >>> ((i & 1) * 16)) & 0xffff;
        return;
      case 1:
        this.decode();
    }
  }

  private emit(w: number): void {
    if (this.outLen >= this.out.length) {
      const n = new Uint32Array(Math.max(4096, this.out.length * 2));
      n.set(this.out.subarray(this.outPos, this.outLen));
      this.outLen -= this.outPos;
      this.outPos = 0;
      this.out = n;
    }
    this.out[this.outLen++] = w;
  }

  private decode(): void {
    // ハーフワードの並びにする
    const words = this.input;
    const n = words.length * 2;
    const src = new Uint16Array(n);
    for (let i = 0; i < words.length; i++) {
      src[i * 2] = words[i] & 0xffff;
      src[i * 2 + 1] = words[i] >>> 16;
    }
    if (this.outPos >= this.outLen) this.outPos = this.outLen = 0;
    const depth = (this.cmd >> 27) & 3;
    const signed = (this.cmd & (1 << 26)) !== 0;
    const bit15 = this.cmd & (1 << 25) ? 0x8000 : 0;
    let p = 0;
    if (depth < 2) {
      // 白黒：Y のブロック 1 つずつ
      while (p < n) {
        const np = this.rle(src, p, this.blk[0], this.qtY);
        if (np < 0) break;
        p = np;
        this.idct(this.blk[0]);
        const b = this.blk[0];
        if (depth === 1) {
          for (let i = 0; i < 64; i += 4) {
            let w = 0;
            for (let k = 0; k < 4; k++) w |= ((b[i + k] ^ (signed ? 0 : 0x80)) & 0xff) << (k * 8);
            this.emit(w >>> 0);
          }
        } else {
          for (let i = 0; i < 64; i += 8) {
            let w = 0;
            for (let k = 0; k < 8; k++) w |= (((b[i + k] ^ (signed ? 0 : 0x80)) & 0xff) >> 4) << (k * 4);
            this.emit(w >>> 0);
          }
        }
      }
      return;
    }
    // カラー：Cr Cb Y1 Y2 Y3 Y4 で 16×16
    const rgb = new Int32Array(256 * 3);
    while (p < n) {
      let ok = true;
      for (let k = 0; k < 6; k++) {
        this.block = k;
        const np = this.rle(src, p, this.blk[k], k < 2 ? this.qtC : this.qtY);
        if (np < 0) {
          ok = false;
          break;
        }
        p = np;
        this.idct(this.blk[k]);
      }
      if (!ok) break;
      const cr = this.blk[0];
      const cb = this.blk[1];
      for (let k = 0; k < 4; k++) {
        const yb = this.blk[2 + k];
        const xx = (k & 1) * 8;
        const yy = (k >> 1) * 8;
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            const ci = ((x + xx) >> 1) + ((y + yy) >> 1) * 8;
            const R = cr[ci];
            const B = cb[ci];
            const G = Math.round(-0.3437 * B - 0.7143 * R);
            const Y = yb[x + y * 8];
            let r = Math.max(-128, Math.min(127, Y + Math.round(1.402 * R)));
            let g = Math.max(-128, Math.min(127, Y + G));
            let bl = Math.max(-128, Math.min(127, Y + Math.round(1.772 * B)));
            if (!signed) {
              r ^= 0x80;
              g ^= 0x80;
              bl ^= 0x80;
            }
            const o = ((x + xx) + (y + yy) * 16) * 3;
            rgb[o] = r & 0xff;
            rgb[o + 1] = g & 0xff;
            rgb[o + 2] = bl & 0xff;
          }
      }
      if (depth === 2) {
        // 24 ビット：R G B の順にバイトを詰める
        for (let i = 0; i < 768; i += 4) this.emit((rgb[i] | (rgb[i + 1] << 8) | (rgb[i + 2] << 16) | (rgb[i + 3] << 24)) >>> 0);
      } else {
        for (let i = 0; i < 256; i += 2) {
          const px = (j: number) => {
            const o = j * 3;
            return (rgb[o] >> 3) | ((rgb[o + 1] >> 3) << 5) | ((rgb[o + 2] >> 3) << 10) | bit15;
          };
          this.emit((px(i) | (px(i + 1) << 16)) >>> 0);
        }
      }
    }
    this.block = 4;
  }

  /** ランレングスと量子化をほどく。読み終わった位置（足りなければ -1） */
  private rle(src: Uint16Array, p: number, blk: Int16Array, qt: Uint8Array): number {
    blk.fill(0);
    const n = src.length;
    let v: number;
    do {
      if (p >= n) return -1;
      v = src[p++];
    } while (v === 0xfe00);
    let k = 0;
    const q = (v >> 10) & 0x3f;
    let val = ((v << 22) >> 22) * qt[0];
    for (;;) {
      if (q === 0) val = ((v << 22) >> 22) * 2;
      val = Math.max(-0x400, Math.min(0x3ff, val));
      if (q > 0) blk[ZAGZIG[k]] = val;
      else blk[k] = val;
      if (p >= n) return p;
      v = src[p++];
      k += ((v >> 10) & 0x3f) + 1;
      if (k > 63) break;
      val = Math.trunc((((v << 22) >> 22) * qt[k] * q + 4) / 8);
    }
    return p;
  }

  private idct(b: Int16Array): void {
    const s = this.scale;
    const t = this.tmp;
    for (let x = 0; x < 8; x++)
      for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) sum += b[u * 8 + x] * s[u * 8 + y];
        t[x + y * 8] = sum;
      }
    for (let x = 0; x < 8; x++)
      for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) sum += t[u + y * 8] * s[u * 8 + x];
        let v = Math.floor(sum / P32) + (Math.floor(sum / P31) & 1);
        v = (v << 23) >> 23;
        b[x + y * 8] = Math.max(-128, Math.min(127, v));
      }
  }

  stateSkip(): unknown[] {
    return [this.blk, this.tmp];
  }
}
