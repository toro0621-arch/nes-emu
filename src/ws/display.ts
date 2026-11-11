// ワンダースワンの画面（224×144）。背景 2 枚（SCR1・SCR2）とスプライト。1 ライン単位で描く

export const WS_W = 224;
export const WS_H = 144;

/** ImageData にそのまま書ける色（ABGR）。白黒は 16 段階の灰色（0 が白） */
const MONO = Uint32Array.from({ length: 16 }, (_, i) => {
  const v = Math.round(((15 - i) * 255) / 15);
  // 液晶っぽく、ほんの少しだけ緑がかった灰色に
  const r = Math.round(v * 0.94 + 8);
  const g = Math.round(v * 0.97 + 6);
  const b = Math.round(v * 0.9 + 6);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
});

/** 12 ビットの色（0RGB）→ ABGR */
const COLOR = Uint32Array.from({ length: 4096 }, (_, c) => {
  const r = ((c >> 8) & 15) * 17;
  const g = ((c >> 4) & 15) * 17;
  const b = (c & 15) * 17;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
});

export class WsDisplay {
  readonly frameBuffer = new Uint32Array(WS_W * WS_H);
  /** スプライトの表（VBlank のはじめに RAM から写す。128 個 × 4 バイト） */
  readonly spriteTable = new Uint8Array(512);
  spriteCount = 0;

  // 1 ライン分の作業用
  private scr1 = new Uint32Array(WS_W);
  private scr1On = new Uint8Array(WS_W);
  private scr2 = new Uint32Array(WS_W);
  private scr2On = new Uint8Array(WS_W);
  private spr = new Uint32Array(WS_W);
  private sprOn = new Uint8Array(WS_W); // 0 = なし、1 = SCR2 の下、2 = SCR2 の上
  private done = new Uint8Array(WS_W);
  /** 使う色（パレット 16 × 色 16）。パレットが書き換えられたら作り直す */
  private pal = new Uint32Array(256);
  palDirty = true;
  private row = new Uint8Array(8);

  constructor(
    private ram: Uint8Array,
    private io: Uint8Array,
  ) {}

  /** スプライトの表を写す（VBlank のはじめ） */
  latchSprites(): void {
    const io = this.io;
    const color = (io[0x60] & 0x80) !== 0;
    const base = (io[0x04] & (color ? 0x3f : 0x1f)) << 9;
    const first = io[0x05] & 0x7f;
    const count = Math.min(io[0x06], 128 - first);
    this.spriteCount = Math.max(0, count);
    for (let i = 0; i < this.spriteCount * 4; i++) this.spriteTable[i] = this.ram[(base + first * 4 + i) & 0xffff];
  }

  /** 色番号 → 画面の色（mono：パレットのプールから、カラー：パレット RAM から） */
  private colorOf(pal: number, idx: number): number {
    const io = this.io;
    if (io[0x60] & 0x80) {
      const a = 0xfe00 + pal * 32 + idx * 2;
      return COLOR[(this.ram[a] | (this.ram[a + 1] << 8)) & 0xfff];
    }
    // 白黒：パレットは 4 色それぞれプールの番号（0〜7）、プールが 16 段階の濃さ
    const p = io[0x20 + pal * 2 + (idx >> 1)];
    const pool = (idx & 1 ? p >> 4 : p) & 7;
    const shade = (io[0x1c + (pool >> 1)] >> ((pool & 1) * 4)) & 15;
    return MONO[shade];
  }

  /** タイル 1 行（8 点）の色番号を row に入れる */
  private tileRow(tile: number, fy: number, row: Uint8Array): void {
    const ram = this.ram;
    const mode = this.io[0x60];
    if (!(mode & 0x40)) {
      if (mode & 0x20 && mode & 0x80) {
        const a = (0x2000 + tile * 16 + fy * 2) & 0xffff;
        for (let x = 0; x < 8; x++) row[x] = (ram[a + (x >> 2)] >> (6 - (x & 3) * 2)) & 3;
        return;
      }
      const a = (0x2000 + tile * 16 + fy * 2) & 0xffff;
      const p0 = ram[a];
      const p1 = ram[a + 1];
      for (let x = 0; x < 8; x++) {
        const bit = 7 - x;
        row[x] = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1);
      }
      return;
    }
    const a = (0x4000 + tile * 32 + fy * 4) & 0xffff;
    if (mode & 0x20) {
      for (let x = 0; x < 8; x += 2) {
        const v = ram[a + (x >> 1)];
        row[x] = v >> 4;
        row[x + 1] = v & 15;
      }
      return;
    }
    const p0 = ram[a];
    const p1 = ram[a + 1];
    const p2 = ram[a + 2];
    const p3 = ram[a + 3];
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      row[x] = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
    }
  }

  private layer(mapBase: number, sx: number, sy: number, line: number, out: Uint32Array, on: Uint8Array): void {
    const ram = this.ram;
    const color = (this.io[0x60] & 0x80) !== 0;
    const bpp4 = (this.io[0x60] & 0x40) !== 0;
    const y = (line + sy) & 0xff;
    const ty = y >> 3;
    const row = this.row;
    const pals = this.pal;
    let x = 0;
    let px = sx & 0xff;
    while (x < WS_W) {
      // タイル 1 枚分をまとめて読む
      const ea = mapBase + (ty * 32 + (px >> 3)) * 2;
      const e = ram[ea & 0xffff] | (ram[(ea + 1) & 0xffff] << 8);
      let tile = e & 0x1ff;
      if (color && e & 0x2000) tile |= 0x200;
      const pal = (e >> 9) & 15;
      this.tileRow(tile, e & 0x8000 ? 7 - (y & 7) : y & 7, row);
      const hflip = (e & 0x4000) !== 0;
      const clear0 = bpp4 || (pal & 4) !== 0; // 色 0 が透明か
      const base = pal * 16;
      for (let fx = px & 7; fx < 8 && x < WS_W; fx++, x++, px = (px + 1) & 0xff) {
        const idx = row[hflip ? 7 - fx : fx];
        if (idx === 0 && clear0) {
          on[x] = 0;
          continue;
        }
        on[x] = 1;
        out[x] = pals[base + idx];
      }
    }
  }

  renderLine(line: number): void {
    const io = this.io;
    const fb = this.frameBuffer;
    const row = line * WS_W;
    // 画面が消えているときは白
    if (!(io[0x14] & 1)) {
      fb.fill(MONO[0], row, row + WS_W);
      return;
    }
    const color = (io[0x60] & 0x80) !== 0;
    const ctrl = io[0x00];
    if (this.palDirty) {
      this.palDirty = false;
      const n = color ? 16 : 4;
      for (let p = 0; p < 16; p++) for (let i = 0; i < n; i++) this.pal[p * 16 + i] = this.colorOf(p, i);
    }
    const back = color ? this.colorOf((io[0x01] >> 4) & 15, io[0x01] & 15) : MONO[(io[0x1c + ((io[0x01] & 7) >> 1)] >> ((io[0x01] & 1) * 4)) & 15];
    const mapMask = color ? 0x0f : 0x07;
    const map1 = (io[0x07] & mapMask) << 11;
    const map2 = ((io[0x07] >> 4) & mapMask) << 11;

    if (ctrl & 1) this.layer(map1, io[0x10], io[0x11], line, this.scr1, this.scr1On);
    else this.scr1On.fill(0);
    if (ctrl & 2) {
      this.layer(map2, io[0x12], io[0x13], line, this.scr2, this.scr2On);
      if (ctrl & 0x20) {
        // SCR2 のウィンドウ（bit4 = 1 なら外側だけ表示）
        const x0 = io[0x08];
        const y0 = io[0x09];
        const x1 = io[0x0a];
        const y1 = io[0x0b];
        const outside = (ctrl & 0x10) !== 0;
        const inY = line >= y0 && line <= y1;
        for (let x = 0; x < WS_W; x++) {
          const inside = inY && x >= x0 && x <= x1;
          if (inside === outside) this.scr2On[x] = 0;
        }
      }
    } else this.scr2On.fill(0);

    this.sprOn.fill(0);
    if (ctrl & 4) this.sprites(line, (ctrl & 8) !== 0);

    const s1 = this.scr1;
    const s1On = this.scr1On;
    const s2 = this.scr2;
    const s2On = this.scr2On;
    const sp = this.spr;
    const spOn = this.sprOn;
    for (let x = 0; x < WS_W; x++) {
      let c = back;
      if (s1On[x]) c = s1[x];
      if (spOn[x] === 1) c = sp[x];
      if (s2On[x]) c = s2[x];
      if (spOn[x] === 2) c = sp[x];
      fb[row + x] = c;
    }
  }

  private sprites(line: number, windowOn: boolean): void {
    const io = this.io;
    const t = this.spriteTable;
    const wx0 = io[0x0c];
    const wy0 = io[0x0d];
    const wx1 = io[0x0e];
    const wy1 = io[0x0f];
    let drawn = 0;
    // 表の先にあるものほど手前（同じ点はあとから描かない）
    const done = this.done;
    done.fill(0);
    for (let i = 0; i < this.spriteCount && drawn < 32; i++) {
      const o = i * 4;
      const sy = t[o + 2];
      const dy = (line - sy) & 0xff;
      if (dy >= 8) continue;
      drawn++;
      const e = t[o] | (t[o + 1] << 8);
      const sx = t[o + 3];
      const tile = e & 0x1ff;
      const pal = ((e >> 9) & 7) + 8;
      const outsideOnly = (e & 0x1000) !== 0;
      const prio = e & 0x2000 ? 2 : 1;
      const fy = e & 0x8000 ? 7 - dy : dy;
      const row = this.row;
      this.tileRow(tile, fy, row);
      const clear0 = (this.io[0x60] & 0x40) !== 0 || (pal & 4) !== 0;
      for (let px = 0; px < 8; px++) {
        const x = (sx + px) & 0xff;
        if (x >= WS_W || done[x]) continue;
        if (windowOn) {
          const inside = x >= wx0 && x <= wx1 && line >= wy0 && line <= wy1;
          if (inside === outsideOnly) continue;
        }
        const idx = row[e & 0x4000 ? 7 - px : px];
        if (idx === 0 && clear0) continue;
        done[x] = 1;
        this.sprOn[x] = prio;
        this.spr[x] = this.pal[pal * 16 + idx];
      }
    }
  }
}
