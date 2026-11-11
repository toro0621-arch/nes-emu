// ゲームボーイアドバンスの画面（1 ラインずつ描く）。
// BG はモード 0〜2 のタイル（文字 BG・回転拡大 BG）とモード 3〜5 のビットマップ。
// スプライト（OBJ）、ウィンドウ、半透明・明るさの変化、モザイクに対応

export const GBA_W = 240;
export const GBA_H = 160;

/** 透明（色は 15 ビットなので、16 ビット目を印に使う） */
const T = 0x8000;

/** 15 ビットの色 → ImageData にそのまま書ける色（ABGR） */
const COLORS = new Uint32Array(32768);
for (let c = 0; c < 32768; c++) {
  const r = c & 31;
  const g = (c >> 5) & 31;
  const b = (c >> 10) & 31;
  COLORS[c] = 0xff000000 | (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2));
}

/**
 * 液晶っぽい色。GBA の液晶は暗めで色が薄く、隣の色が少し混ざって見えた。
 * ゲームはそれを見越して濃い色で作られているので、今の画面だとギラついて見える。
 * 光の量に直して（ガンマ 2.7）色を少し混ぜ、明るさを 94% にしてから画面のガンマ（2.2）に戻す
 * （Pokefan531 さんの GBA 用の色の補正と同じ考え方）
 */
const LCD_COLORS = new Uint32Array(32768);
for (let c = 0; c < 32768; c++) {
  const r = ((c & 31) / 31) ** 2.7;
  const g = (((c >> 5) & 31) / 31) ** 2.7;
  const b = (((c >> 10) & 31) / 31) ** 2.7;
  const out = (v: number) => Math.round(Math.min(1, Math.max(0, v * 0.94)) ** (1 / 2.2) * 255);
  const or = out(0.82 * r + 0.125 * g + 0.195 * b);
  const og = out(0.24 * r + 0.665 * g + 0.075 * b);
  const ob = out(-0.06 * r + 0.21 * g + 0.73 * b);
  LCD_COLORS[c] = 0xff000000 | (ob << 16) | (og << 8) | or;
}

/** OBJ の形 × 大きさ → 幅・高さ */
const OBJ_W = [8, 16, 32, 64, 16, 32, 32, 64, 8, 8, 16, 32, 8, 8, 8, 8];
const OBJ_H = [8, 16, 32, 64, 8, 8, 16, 32, 16, 32, 32, 64, 8, 8, 8, 8];

function sign28(v: number): number {
  return (v << 4) >> 4;
}

export class GbaPpu {
  frameBuffer = new Uint32Array(GBA_W * GBA_H) as Uint32Array<ArrayBuffer>;
  /** 液晶っぽい色にする */
  lcd = false;
  /** 回転拡大 BG の基準点（ラインごとに PB・PD ずつ進む） */
  bg2x = 0;
  bg2y = 0;
  bg3x = 0;
  bg3y = 0;

  private bg = [new Uint16Array(GBA_W), new Uint16Array(GBA_W), new Uint16Array(GBA_W), new Uint16Array(GBA_W)];
  private objColor = new Uint16Array(GBA_W);
  private objPrio = new Uint8Array(GBA_W);
  private objSemi = new Uint8Array(GBA_W);
  private objWin = new Uint8Array(GBA_W);
  private winMask = new Uint8Array(GBA_W);
  private order = new Int32Array(4);

  private io16: Uint16Array;
  private vram16: Uint16Array;
  private pal16: Uint16Array;
  private oam16: Uint16Array;
  private oamS16: Int16Array;

  constructor(
    io: Uint8Array,
    private vram: Uint8Array,
    pal: Uint8Array,
    oam: Uint8Array,
  ) {
    this.io16 = new Uint16Array(io.buffer, io.byteOffset, io.length >> 1);
    this.vram16 = new Uint16Array(vram.buffer, vram.byteOffset, vram.length >> 1);
    this.pal16 = new Uint16Array(pal.buffer, pal.byteOffset, pal.length >> 1);
    this.oam16 = new Uint16Array(oam.buffer, oam.byteOffset, oam.length >> 1);
    this.oamS16 = new Int16Array(oam.buffer, oam.byteOffset, oam.length >> 1);
  }

  /** どこでもセーブで写さないもの（本体のメモリの別の見え方） */
  stateSkip(): unknown[] {
    return [this.io16, this.vram16, this.pal16, this.oam16, this.oamS16];
  }

  /** BG2X などのレジスタを書いたとき・V ブランクのはじめに、基準点を読み直す */
  latchRefs(): void {
    const io = this.io16;
    this.bg2x = sign28(io[0x14] | (io[0x15] << 16));
    this.bg2y = sign28(io[0x16] | (io[0x17] << 16));
    this.bg3x = sign28(io[0x1c] | (io[0x1d] << 16));
    this.bg3y = sign28(io[0x1e] | (io[0x1f] << 16));
  }

  renderLine(y: number): void {
    const io = this.io16;
    const dispcnt = io[0];
    const out = this.frameBuffer;
    const row = y * GBA_W;
    if (dispcnt & 0x80) {
      // 強制ブランク（白）
      out.fill(this.lcd ? LCD_COLORS[0x7fff] : 0xffffffff, row, row + GBA_W);
      this.stepRefs();
      return;
    }
    const mode = dispcnt & 7;
    const mosaic = io[0x26];

    // BG をそれぞれのバッファに描く
    let bgMask = 0;
    if (mode === 0) bgMask = 0xf;
    else if (mode === 1) bgMask = 0x7;
    else if (mode === 2) bgMask = 0xc;
    else bgMask = 0x4;
    bgMask &= dispcnt >> 8;
    for (let b = 0; b < 4; b++) {
      if (!(bgMask & (1 << b))) continue;
      if (mode === 0 || (mode === 1 && b < 2)) this.renderText(b, y, mosaic);
      else if (mode <= 2) this.renderAffine(b, b === 2 ? this.bg2x : this.bg3x, b === 2 ? this.bg2y : this.bg3y);
      else this.renderBitmap(mode, dispcnt);
    }

    // OBJ
    this.objColor.fill(T);
    this.objPrio.fill(4);
    this.objSemi.fill(0);
    this.objWin.fill(0);
    if (dispcnt & 0x9000) this.renderObjs(y, dispcnt, mode, mosaic);

    // ウィンドウ
    const anyWin = dispcnt & 0xe000;
    if (anyWin) this.buildWindow(y, dispcnt);

    // 優先順位の順に並べた BG
    let nbg = 0;
    for (let p = 0; p < 4; p++) {
      for (let b = 0; b < 4; b++) {
        if (bgMask & (1 << b) && (io[4 + b] & 3) === p) this.order[nbg++] = b;
      }
    }

    const pal = this.pal16;
    const bd = pal[0] & 0x7fff;
    const bldcnt = io[0x28];
    const blendMode = (bldcnt >> 6) & 3;
    const target1 = bldcnt & 0x3f;
    const target2 = (bldcnt >> 8) & 0x3f;
    const alpha = io[0x29];
    const eva = Math.min(16, alpha & 31);
    const evb = Math.min(16, (alpha >> 8) & 31);
    const evy = Math.min(16, io[0x2a] & 31);
    const objColor = this.objColor;
    const objPrio = this.objPrio;
    const objSemi = this.objSemi;
    const winMask = this.winMask;
    const order = this.order;
    const bgs = this.bg;
    const prio0 = io[4] & 3;
    const prio1 = io[5] & 3;
    const prio2 = io[6] & 3;
    const prio3 = io[7] & 3;
    const colors = this.lcd ? LCD_COLORS : COLORS;

    for (let x = 0; x < GBA_W; x++) {
      const mask = anyWin ? winMask[x] : 0x3f;
      let c1 = bd;
      let l1 = 5;
      let c2 = bd;
      let l2 = 5;
      let found = 0;
      const oc = objColor[x];
      const op = oc !== T && mask & 16 ? objPrio[x] : 9;
      let objDone = op === 9;
      for (let k = 0; k < nbg; k++) {
        const b = order[k];
        if (!objDone) {
          const bp = b === 0 ? prio0 : b === 1 ? prio1 : b === 2 ? prio2 : prio3;
          if (op <= bp) {
            if (found === 0) {
              c1 = oc;
              l1 = 4;
            } else {
              c2 = oc;
              l2 = 4;
            }
            found++;
            objDone = true;
            if (found === 2) break;
          }
        }
        if (mask & (1 << b)) {
          const col = bgs[b][x];
          if (col !== T) {
            if (found === 0) {
              c1 = col;
              l1 = b;
            } else {
              c2 = col;
              l2 = b;
            }
            if (++found === 2) break;
          }
        }
      }
      if (!objDone && found < 2) {
        if (found === 0) {
          c1 = oc;
          l1 = 4;
        } else {
          c2 = oc;
          l2 = 4;
        }
      }

      let color = c1;
      if (l1 === 4 && objSemi[x] && target2 & (1 << l2)) {
        color = blend(c1, c2, eva, evb);
      } else if (mask & 32 && target1 & (1 << l1)) {
        if (blendMode === 1) {
          if (target2 & (1 << l2)) color = blend(c1, c2, eva, evb);
        } else if (blendMode === 2) color = brighten(c1, evy);
        else if (blendMode === 3) color = darken(c1, evy);
      }
      out[row + x] = colors[color];
    }
    this.stepRefs();
  }

  private stepRefs(): void {
    const io = this.io16;
    this.bg2x += (io[0x11] << 16) >> 16;
    this.bg2y += (io[0x13] << 16) >> 16;
    this.bg3x += (io[0x19] << 16) >> 16;
    this.bg3y += (io[0x1b] << 16) >> 16;
  }

  private buildWindow(y: number, dispcnt: number): void {
    const io = this.io16;
    const mask = this.winMask;
    const winout = io[0x25];
    const winin = io[0x24];
    mask.fill(winout & 0x3f);
    if (dispcnt & 0x8000) {
      const m = (winout >> 8) & 0x3f;
      const ow = this.objWin;
      for (let x = 0; x < GBA_W; x++) if (ow[x]) mask[x] = m;
    }
    for (let w = 1; w >= 0; w--) {
      if (!(dispcnt & (0x2000 << w))) continue;
      // 範囲は「x1 で入り、x2 で出る」。x1 > x2 なら端をまたいで折り返す
      const v = io[0x22 + w];
      let y1 = v >> 8;
      let y2 = v & 0xff;
      if (y1 > GBA_H && y1 > y2) y1 = 0;
      if (y2 > GBA_H) {
        y2 = GBA_H;
        if (y1 > GBA_H) y1 = GBA_H;
      }
      const inY = y1 <= y2 ? y >= y1 && y < y2 : y >= y1 || y < y2;
      if (!inY) continue;
      const h = io[0x20 + w];
      let x1 = h >> 8;
      let x2 = h & 0xff;
      if (x1 > GBA_W && x1 > x2) x1 = 0;
      if (x2 > GBA_W) {
        x2 = GBA_W;
        if (x1 > GBA_W) x1 = GBA_W;
      }
      const m = (winin >> (w * 8)) & 0x3f;
      if (x1 <= x2) {
        for (let x = x1; x < x2; x++) mask[x] = m;
      } else {
        for (let x = x1; x < GBA_W; x++) mask[x] = m;
        for (let x = 0; x < x2; x++) mask[x] = m;
      }
    }
  }

  private renderText(b: number, y: number, mosaic: number): void {
    const io = this.io16;
    const cnt = io[4 + b];
    const hofs = io[8 + b * 2] & 0x1ff;
    const vofs = io[9 + b * 2] & 0x1ff;
    const charBase = ((cnt >> 2) & 3) << 14;
    const screenBase = ((cnt >> 8) & 31) << 11;
    const size = cnt >> 14;
    const mos = cnt & 0x40;
    let yy = y;
    if (mos) {
      const mv = ((mosaic >> 4) & 15) + 1;
      yy = y - (y % mv);
    }
    yy = (yy + vofs) & (size & 2 ? 511 : 255);
    const wmask = size & 1 ? 511 : 255;
    const vblock = size === 3 ? (yy >> 8) * 2 : size === 2 ? yy >> 8 : 0;
    const rowOff = ((yy & 255) >> 3) * 32;
    const ty = yy & 7;
    const vram = this.vram;
    const vram16 = this.vram16;
    const pal = this.pal16;
    const buf = this.bg[b];
    const c256 = cnt & 0x80;
    let x = 0;
    while (x < GBA_W) {
      const xx = (x + hofs) & wmask;
      const block = vblock + (size & 1 ? xx >> 8 : 0);
      const entry = vram16[((screenBase + block * 0x800 + (rowOff + ((xx & 255) >> 3)) * 2) & 0xffff) >> 1];
      const tile = entry & 0x3ff;
      const hf = entry & 0x400;
      const py = entry & 0x800 ? 7 - ty : ty;
      let px = xx & 7;
      if (c256) {
        const base = charBase + tile * 64 + py * 8;
        for (; px < 8 && x < GBA_W; px++, x++) {
          const addr = base + (hf ? 7 - px : px);
          const ci = addr < 0x10000 ? vram[addr] : 0;
          buf[x] = ci ? pal[ci] & 0x7fff : T;
        }
      } else {
        const base = charBase + tile * 32 + py * 4;
        const palBase = (entry >> 12) << 4;
        for (; px < 8 && x < GBA_W; px++, x++) {
          const tx = hf ? 7 - px : px;
          const addr = base + (tx >> 1);
          const byte = addr < 0x10000 ? vram[addr] : 0;
          const ci = tx & 1 ? byte >> 4 : byte & 15;
          buf[x] = ci ? pal[palBase + ci] & 0x7fff : T;
        }
      }
    }
    if (mos) mosaicH(buf, (mosaic & 15) + 1);
  }

  private renderAffine(b: number, refX: number, refY: number): void {
    const io = this.io16;
    const cnt = io[4 + b];
    const pbase = b === 2 ? 0x10 : 0x18;
    const pa = (io[pbase] << 16) >> 16;
    const pc = (io[pbase + 2] << 16) >> 16;
    const charBase = ((cnt >> 2) & 3) << 14;
    const screenBase = ((cnt >> 8) & 31) << 11;
    const size = 128 << (cnt >> 14);
    const shift = 4 + (cnt >> 14); // 1 行のタイル数 = size / 8
    const wrap = cnt & 0x2000;
    const vram = this.vram;
    const pal = this.pal16;
    const buf = this.bg[b];
    let x0 = refX;
    let y0 = refY;
    for (let x = 0; x < GBA_W; x++, x0 += pa, y0 += pc) {
      let tx = x0 >> 8;
      let ty = y0 >> 8;
      if (wrap) {
        tx &= size - 1;
        ty &= size - 1;
      } else if (tx < 0 || ty < 0 || tx >= size || ty >= size) {
        buf[x] = T;
        continue;
      }
      const tile = vram[(screenBase + ((ty >> 3) << shift) + (tx >> 3)) & 0xffff];
      const ci = vram[(charBase + tile * 64 + (ty & 7) * 8 + (tx & 7)) & 0xffff];
      buf[x] = ci ? pal[ci] & 0x7fff : T;
    }
    if (cnt & 0x40) mosaicH(buf, (io[0x26] & 15) + 1);
  }

  private renderBitmap(mode: number, dispcnt: number): void {
    const io = this.io16;
    const pa = (io[0x10] << 16) >> 16;
    const pc = (io[0x12] << 16) >> 16;
    const buf = this.bg[2];
    const vram = this.vram;
    const vram16 = this.vram16;
    const pal = this.pal16;
    const page = dispcnt & 0x10 ? 0xa000 : 0;
    const w = mode === 5 ? 160 : 240;
    const h = mode === 5 ? 128 : 160;
    let x0 = this.bg2x;
    let y0 = this.bg2y;
    for (let x = 0; x < GBA_W; x++, x0 += pa, y0 += pc) {
      const tx = x0 >> 8;
      const ty = y0 >> 8;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) {
        buf[x] = T;
        continue;
      }
      if (mode === 3) buf[x] = vram16[ty * 240 + tx] & 0x7fff;
      else if (mode === 4) {
        const ci = vram[page + ty * 240 + tx];
        buf[x] = ci ? pal[ci] & 0x7fff : T;
      } else buf[x] = vram16[(page >> 1) + ty * 160 + tx] & 0x7fff;
    }
    if (io[6] & 0x40) mosaicH(buf, (io[0x26] & 15) + 1);
  }

  private renderObjs(y: number, dispcnt: number, mode: number, mosaic: number): void {
    const oam = this.oam16;
    const oamS = this.oamS16;
    const vram = this.vram;
    const pal = this.pal16;
    const oneD = dispcnt & 0x40;
    const showObj = dispcnt & 0x1000;
    const showWin = dispcnt & 0x8000;
    const objColor = this.objColor;
    const objPrio = this.objPrio;
    const objSemi = this.objSemi;
    const objWin = this.objWin;
    const mosV = ((mosaic >> 12) & 15) + 1;
    for (let i = 0; i < 128; i++) {
      const a0 = oam[i * 4];
      const affine = a0 & 0x100;
      if (!affine && a0 & 0x200) continue;
      const om = (a0 >> 10) & 3;
      if (om === 3) continue;
      if (om === 2 ? !showWin : !showObj) continue;
      const a1 = oam[i * 4 + 1];
      const a2 = oam[i * 4 + 2];
      const si = ((a0 >> 14) << 2) | (a1 >> 14);
      const w = OBJ_W[si];
      const h = OBJ_H[si];
      const dbl = affine && a0 & 0x200;
      const bw = dbl ? w * 2 : w;
      const bh = dbl ? h * 2 : h;
      let oy = a0 & 0xff;
      if (oy + bh > 256) oy -= 256;
      let ly = y - oy;
      if (ly < 0 || ly >= bh) continue;
      if (a0 & 0x1000) {
        ly = y - (y % mosV) - oy;
        if (ly < 0) ly = 0;
      }
      let ox = a1 & 0x1ff;
      if (ox >= 240) ox -= 512;
      const tile = a2 & 0x3ff;
      if (mode >= 3 && tile < 512) continue;
      const prio = (a2 >> 10) & 3;
      const c256 = a0 & 0x2000;
      const palBase = 256 + (c256 ? 0 : (a2 >> 12) << 4);
      // 1 行ぶんのタイル数（1 次元の並びならスプライトの幅、2 次元なら 32）
      const rowTiles = oneD ? (w >> 3) * (c256 ? 2 : 1) : 32;

      let pa = 256;
      let pb = 0;
      let pc = 0;
      let pd = 256;
      if (affine) {
        const g = ((a1 >> 9) & 31) * 16;
        pa = oamS[g + 3];
        pb = oamS[g + 7];
        pc = oamS[g + 11];
        pd = oamS[g + 15];
      }
      const hf = !affine && a1 & 0x1000;
      const vf = !affine && a1 & 0x2000;
      const dy = ly - (bh >> 1);
      for (let sx = 0; sx < bw; sx++) {
        const x = ox + sx;
        if (x < 0) continue;
        if (x >= GBA_W) break;
        let tx: number;
        let ty: number;
        if (affine) {
          const dx = sx - (bw >> 1);
          tx = ((pa * dx + pb * dy) >> 8) + (w >> 1);
          ty = ((pc * dx + pd * dy) >> 8) + (h >> 1);
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        } else {
          tx = hf ? w - 1 - sx : sx;
          ty = vf ? h - 1 - ly : ly;
        }
        let ci: number;
        if (c256) {
          const t = (tile + (ty >> 3) * rowTiles + (tx >> 3) * 2) & 0x3ff;
          ci = vram[0x10000 + t * 32 + (ty & 7) * 8 + (tx & 7)];
        } else {
          const t = (tile + (ty >> 3) * rowTiles + (tx >> 3)) & 0x3ff;
          const byte = vram[0x10000 + t * 32 + (ty & 7) * 4 + ((tx & 7) >> 1)];
          ci = tx & 1 ? byte >> 4 : byte & 15;
        }
        if (!ci) continue;
        if (om === 2) {
          objWin[x] = 1;
          continue;
        }
        if (objColor[x] === T || prio < objPrio[x]) {
          objColor[x] = pal[palBase + ci] & 0x7fff;
          objPrio[x] = prio;
          objSemi[x] = om === 1 ? 1 : 0;
        }
      }
    }
  }
}

function mosaicH(buf: Uint16Array, m: number): void {
  if (m <= 1) return;
  for (let x = 0; x < GBA_W; x++) buf[x] = buf[x - (x % m)];
}

function blend(a: number, b: number, eva: number, evb: number): number {
  const r = Math.min(31, ((a & 31) * eva + (b & 31) * evb) >> 4);
  const g = Math.min(31, (((a >> 5) & 31) * eva + ((b >> 5) & 31) * evb) >> 4);
  const bl = Math.min(31, (((a >> 10) & 31) * eva + ((b >> 10) & 31) * evb) >> 4);
  return r | (g << 5) | (bl << 10);
}

function brighten(a: number, evy: number): number {
  let r = a & 31;
  let g = (a >> 5) & 31;
  let b = (a >> 10) & 31;
  r += ((31 - r) * evy) >> 4;
  g += ((31 - g) * evy) >> 4;
  b += ((31 - b) * evy) >> 4;
  return r | (g << 5) | (b << 10);
}

function darken(a: number, evy: number): number {
  let r = a & 31;
  let g = (a >> 5) & 31;
  let b = (a >> 10) & 31;
  r -= (r * evy) >> 4;
  g -= (g * evy) >> 4;
  b -= (b * evy) >> 4;
  return r | (g << 5) | (b << 10);
}
