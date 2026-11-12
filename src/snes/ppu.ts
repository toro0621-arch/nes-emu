// スーパーファミコンの画面（PPU）。1 ラインずつ描く。
// BG はモード 0〜7（2・4・8 色ビット、オフセットパータイル、高解像度、回転拡大のモード 7）、
// スプライト、ウィンドウ、メイン・サブ画面のカラー演算（加算・減算・半透明）、モザイク、明るさ

export const SNES_W = 256;
export const SNES_H = 224;

/** モードごとの重なりの順（大きいほど手前）：[BG1 低, BG1 高, BG2 低, BG2 高, BG3 低, BG3 高, BG4 低, BG4 高, OBJ0, OBJ1, OBJ2, OBJ3] */
const ZTABLE = [
  [8, 11, 7, 10, 2, 5, 1, 4, 3, 6, 9, 12],
  [6, 9, 5, 8, 1, 3, 0, 0, 2, 4, 7, 10],
  [3, 7, 1, 5, 0, 0, 0, 0, 2, 4, 6, 8],
  [3, 7, 1, 5, 0, 0, 0, 0, 2, 4, 6, 8],
  [3, 7, 1, 5, 0, 0, 0, 0, 2, 4, 6, 8],
  [3, 7, 1, 5, 0, 0, 0, 0, 2, 4, 6, 8],
  [3, 7, 1, 5, 0, 0, 0, 0, 2, 4, 6, 8],
  [3, 3, 1, 5, 0, 0, 0, 0, 2, 4, 6, 7],
];
/** モードごとの BG の色ビット数（0 = なし） */
const BPP = [
  [2, 2, 2, 2],
  [4, 4, 2, 0],
  [4, 4, 0, 0],
  [8, 4, 0, 0],
  [8, 2, 0, 0],
  [4, 2, 0, 0],
  [4, 0, 0, 0],
  [8, 0, 0, 0],
];
/** OBJSEL の大きさの組み合わせ（小・大の幅と高さ） */
const OBJ_SIZES = [
  [8, 8, 16, 16],
  [8, 8, 32, 32],
  [8, 8, 64, 64],
  [16, 16, 32, 32],
  [16, 16, 64, 64],
  [32, 32, 64, 64],
  [16, 32, 32, 64],
  [16, 32, 32, 32],
];

/** 15 ビットの色 × 明るさ（0〜15）→ ABGR */
const COLORS = new Uint32Array(32768 * 16);
for (let br = 0; br < 16; br++) {
  for (let c = 0; c < 32768; c++) {
    const f = (br + 1) / 16;
    const conv = (v: number) => Math.round(((v << 3) | (v >> 2)) * (br === 0 ? 0 : f));
    const r = conv(c & 31);
    const g = conv((c >> 5) & 31);
    const b = conv((c >> 10) & 31);
    COLORS[br * 32768 + c] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
}

/** 層の番号（0〜3 BG、4 演算しない OBJ、5 OBJ、6 背景色）→ CGADSUB のビット */
const LAYER_BIT = [1, 2, 4, 8, 0, 16, 32];

const sign13 = (v: number) => (v << 19) >> 19;
const sign16 = (v: number) => (v << 16) >> 16;
const clip10 = (n: number) => (n & 0x2000 ? n | ~0x3ff : n & 0x3ff);

export class SnesPpu {
  frameBuffer = new Uint32Array(SNES_W * SNES_H) as Uint32Array<ArrayBuffer>;
  vram = new Uint16Array(0x8000);
  cgram = new Uint16Array(256);
  oam = new Uint8Array(544);

  // ── レジスタ ──
  forceBlank = true;
  brightness = 0;
  objSize = 0;
  objBase = 0;
  objNameOffset = 0x1000;
  oamAddr = 0;
  oamReload = 0;
  oamPriority = false;
  private oamLatch = 0;
  bgMode = 0;
  bg3Prio = false;
  bigTiles = 0;
  mosaicSize = 1;
  mosaicMask = 0;
  mapBase = new Uint16Array(4);
  mapSize = new Uint8Array(4);
  charBase = new Uint16Array(4);
  hofs = new Uint16Array(4);
  vofs = new Uint16Array(4);
  private scrollLatch = 0;
  private hofsLatch = 0;
  m7hofs = 0;
  m7vofs = 0;
  private m7Latch = 0;
  vmain = 0;
  vaddr = 0;
  private vramBuf = 0;
  m7sel = 0;
  m7a = 0;
  m7b = 0;
  m7c = 0;
  m7d = 0;
  m7x = 0;
  m7y = 0;
  cgAddr = 0;
  private cgLatch = 0;
  private cgFlip = false;
  wsel = new Uint8Array(3); // $2123〜$2125
  wpos = new Uint8Array(4); // $2126〜$2129
  wbglog = 0;
  wobjlog = 0;
  tm = 0;
  ts = 0;
  tmw = 0;
  tsw = 0;
  cgwsel = 0;
  cgadsub = 0;
  fixedColor = 0;
  setini = 0;
  /** 掛け算の結果（$2134〜$2136） */
  mpy = 0;
  // カウンタのラッチ
  hLatch = 0;
  vLatch = 0;
  latched = false;
  private hFlip = false;
  private vFlip = false;
  /** 1 つ前に読んだ値（読めないビットに残る） */
  ppu1Open = 0;
  ppu2Open = 0;

  // ── 1 ラインぶんの作業用 ──
  private bgColor = [new Uint16Array(512), new Uint16Array(512), new Uint16Array(512), new Uint16Array(512)];
  private bgZ = [new Uint8Array(512), new Uint8Array(512), new Uint8Array(512), new Uint8Array(512)];
  private objColor = new Uint16Array(256);
  private objZ = new Uint8Array(256);
  private objMath = new Uint8Array(256);
  private winMask = [
    new Uint8Array(256),
    new Uint8Array(256),
    new Uint8Array(256),
    new Uint8Array(256),
    new Uint8Array(256),
    new Uint8Array(256),
  ];
  private mainC = new Uint16Array(512);
  private mainL = new Uint8Array(512);
  private subC = new Uint16Array(512);
  private subL = new Uint8Array(512);
  private bestZ = new Uint8Array(512);

  /** 今の H・V カウンタ（読み出し・ラッチ用。本体が入れる） */
  counters: () => [number, number] = () => [0, 0];

  // ───────── レジスタの書き込み ─────────

  write(a: number, v: number): void {
    switch (a) {
      case 0x00:
        this.forceBlank = (v & 0x80) !== 0;
        this.brightness = v & 15;
        break;
      case 0x01:
        this.objSize = v >> 5;
        this.objBase = (v & 7) << 13;
        this.objNameOffset = (((v >> 3) & 3) + 1) << 12;
        break;
      case 0x02:
        this.oamReload = (this.oamReload & 0x100) | v;
        this.oamAddr = this.oamReload << 1;
        break;
      case 0x03:
        this.oamReload = (this.oamReload & 0xff) | ((v & 1) << 8);
        this.oamPriority = (v & 0x80) !== 0;
        this.oamAddr = this.oamReload << 1;
        break;
      case 0x04: {
        const ad = this.oamAddr;
        if (ad >= 0x200) this.oam[0x200 | (ad & 0x1f)] = v;
        else if (ad & 1) {
          this.oam[ad - 1] = this.oamLatch;
          this.oam[ad] = v;
        } else this.oamLatch = v;
        this.oamAddr = (ad + 1) & 0x3ff;
        break;
      }
      case 0x05:
        this.bgMode = v & 7;
        this.bg3Prio = (v & 8) !== 0;
        this.bigTiles = v >> 4;
        break;
      case 0x06:
        this.mosaicSize = (v >> 4) + 1;
        this.mosaicMask = v & 15;
        break;
      case 0x07:
      case 0x08:
      case 0x09:
      case 0x0a:
        this.mapBase[a - 7] = (v & 0xfc) << 8;
        this.mapSize[a - 7] = v & 3;
        break;
      case 0x0b:
        this.charBase[0] = (v & 15) << 12;
        this.charBase[1] = (v >> 4) << 12;
        break;
      case 0x0c:
        this.charBase[2] = (v & 15) << 12;
        this.charBase[3] = (v >> 4) << 12;
        break;
      case 0x0d:
      case 0x0f:
      case 0x11:
      case 0x13: {
        const bg = (a - 0x0d) >> 1;
        this.hofs[bg] = ((v << 8) | (this.scrollLatch & ~7) | (this.hofsLatch & 7)) & 0x3ff;
        this.scrollLatch = v;
        this.hofsLatch = v;
        if (a === 0x0d) {
          this.m7hofs = ((v << 8) | this.m7Latch) & 0x1fff;
          this.m7Latch = v;
        }
        break;
      }
      case 0x0e:
      case 0x10:
      case 0x12:
      case 0x14: {
        const bg = (a - 0x0e) >> 1;
        this.vofs[bg] = ((v << 8) | this.scrollLatch) & 0x3ff;
        this.scrollLatch = v;
        if (a === 0x0e) {
          this.m7vofs = ((v << 8) | this.m7Latch) & 0x1fff;
          this.m7Latch = v;
        }
        break;
      }
      case 0x15:
        this.vmain = v;
        break;
      case 0x16:
        this.vaddr = (this.vaddr & 0xff00) | v;
        this.vramBuf = this.vram[this.vramAddr() & 0x7fff];
        break;
      case 0x17:
        this.vaddr = (this.vaddr & 0xff) | (v << 8);
        this.vramBuf = this.vram[this.vramAddr() & 0x7fff];
        break;
      case 0x18: {
        const ad = this.vramAddr() & 0x7fff;
        this.vram[ad] = (this.vram[ad] & 0xff00) | v;
        if (!(this.vmain & 0x80)) this.vaddr = (this.vaddr + this.vramStep()) & 0xffff;
        break;
      }
      case 0x19: {
        const ad = this.vramAddr() & 0x7fff;
        this.vram[ad] = (this.vram[ad] & 0xff) | (v << 8);
        if (this.vmain & 0x80) this.vaddr = (this.vaddr + this.vramStep()) & 0xffff;
        break;
      }
      case 0x1a:
        this.m7sel = v;
        break;
      case 0x1b:
        this.m7a = ((v << 8) | this.m7Latch) & 0xffff;
        this.m7Latch = v;
        this.mpy = sign16(this.m7a) * ((this.m7b << 16) >> 24);
        break;
      case 0x1c:
        this.m7b = ((v << 8) | this.m7Latch) & 0xffff;
        this.m7Latch = v;
        this.mpy = sign16(this.m7a) * ((this.m7b << 16) >> 24);
        break;
      case 0x1d:
        this.m7c = ((v << 8) | this.m7Latch) & 0xffff;
        this.m7Latch = v;
        break;
      case 0x1e:
        this.m7d = ((v << 8) | this.m7Latch) & 0xffff;
        this.m7Latch = v;
        break;
      case 0x1f:
        this.m7x = ((v << 8) | this.m7Latch) & 0x1fff;
        this.m7Latch = v;
        break;
      case 0x20:
        this.m7y = ((v << 8) | this.m7Latch) & 0x1fff;
        this.m7Latch = v;
        break;
      case 0x21:
        this.cgAddr = v;
        this.cgFlip = false;
        break;
      case 0x22:
        if (!this.cgFlip) this.cgLatch = v;
        else {
          this.cgram[this.cgAddr] = ((v & 0x7f) << 8) | this.cgLatch;
          this.cgAddr = (this.cgAddr + 1) & 0xff;
        }
        this.cgFlip = !this.cgFlip;
        break;
      case 0x23:
      case 0x24:
      case 0x25:
        this.wsel[a - 0x23] = v;
        break;
      case 0x26:
      case 0x27:
      case 0x28:
      case 0x29:
        this.wpos[a - 0x26] = v;
        break;
      case 0x2a:
        this.wbglog = v;
        break;
      case 0x2b:
        this.wobjlog = v;
        break;
      case 0x2c:
        this.tm = v;
        break;
      case 0x2d:
        this.ts = v;
        break;
      case 0x2e:
        this.tmw = v;
        break;
      case 0x2f:
        this.tsw = v;
        break;
      case 0x30:
        this.cgwsel = v;
        break;
      case 0x31:
        this.cgadsub = v;
        break;
      case 0x32: {
        const i = v & 31;
        if (v & 0x20) this.fixedColor = (this.fixedColor & ~31) | i;
        if (v & 0x40) this.fixedColor = (this.fixedColor & ~(31 << 5)) | (i << 5);
        if (v & 0x80) this.fixedColor = (this.fixedColor & ~(31 << 10)) | (i << 10);
        break;
      }
      case 0x33:
        this.setini = v;
        break;
    }
  }

  // ───────── レジスタの読み出し ─────────

  read(a: number): number {
    switch (a) {
      case 0x34:
        return (this.ppu1Open = this.mpy & 0xff);
      case 0x35:
        return (this.ppu1Open = (this.mpy >> 8) & 0xff);
      case 0x36:
        return (this.ppu1Open = (this.mpy >> 16) & 0xff);
      case 0x37:
        this.latch();
        return 0;
      case 0x38: {
        const ad = this.oamAddr;
        const v = ad >= 0x200 ? this.oam[0x200 | (ad & 0x1f)] : this.oam[ad];
        this.oamAddr = (ad + 1) & 0x3ff;
        return (this.ppu1Open = v);
      }
      case 0x39: {
        const v = this.vramBuf & 0xff;
        if (!(this.vmain & 0x80)) {
          this.vramBuf = this.vram[this.vramAddr() & 0x7fff];
          this.vaddr = (this.vaddr + this.vramStep()) & 0xffff;
        }
        return (this.ppu1Open = v);
      }
      case 0x3a: {
        const v = this.vramBuf >> 8;
        if (this.vmain & 0x80) {
          this.vramBuf = this.vram[this.vramAddr() & 0x7fff];
          this.vaddr = (this.vaddr + this.vramStep()) & 0xffff;
        }
        return (this.ppu1Open = v);
      }
      case 0x3b: {
        let v: number;
        if (!this.cgFlip) v = this.cgram[this.cgAddr] & 0xff;
        else {
          v = (this.cgram[this.cgAddr] >> 8) | (this.ppu2Open & 0x80);
          this.cgAddr = (this.cgAddr + 1) & 0xff;
        }
        this.cgFlip = !this.cgFlip;
        return (this.ppu2Open = v);
      }
      case 0x3c: {
        const v = this.hFlip ? (this.hLatch >> 8) | (this.ppu2Open & 0xfe) : this.hLatch & 0xff;
        this.hFlip = !this.hFlip;
        return (this.ppu2Open = v);
      }
      case 0x3d: {
        const v = this.vFlip ? (this.vLatch >> 8) | (this.ppu2Open & 0xfe) : this.vLatch & 0xff;
        this.vFlip = !this.vFlip;
        return (this.ppu2Open = v);
      }
      case 0x3e:
        return (this.ppu1Open = (this.ppu1Open & 0x10) | 1);
      case 0x3f: {
        const v = (this.latched ? 0x40 : 0) | (this.ppu2Open & 0x20) | 3;
        this.latched = false;
        this.hFlip = false;
        this.vFlip = false;
        return (this.ppu2Open = v);
      }
    }
    return this.ppu1Open;
  }

  /** H・V カウンタをラッチする（$2137 を読む・$4201 の bit7） */
  latch(): void {
    const [h, v] = this.counters();
    this.hLatch = h;
    this.vLatch = v;
    this.latched = true;
  }

  private vramAddr(): number {
    const a = this.vaddr;
    switch ((this.vmain >> 2) & 3) {
      case 1:
        return (a & 0xff00) | ((a & 0xe0) >> 5) | ((a & 0x1f) << 3);
      case 2:
        return (a & 0xfe00) | ((a & 0x1c0) >> 6) | ((a & 0x3f) << 3);
      case 3:
        return (a & 0xfc00) | ((a & 0x380) >> 7) | ((a & 0x7f) << 3);
    }
    return a;
  }

  private vramStep(): number {
    const s = this.vmain & 3;
    return s === 0 ? 1 : s === 1 ? 32 : 128;
  }

  /** V ブランクのはじめ（OAM のアドレスを戻す） */
  vblank(): void {
    if (!this.forceBlank) this.oamAddr = this.oamReload << 1;
  }

  // ───────── 描画 ─────────

  /** ライン y（1〜224）を描く */
  renderLine(y: number): void {
    if (y < 1 || y > SNES_H) return;
    const out = this.frameBuffer;
    const row = (y - 1) * SNES_W;
    if (this.forceBlank) {
      out.fill(0xff000000, row, row + SNES_W);
      return;
    }
    const mode = this.bgMode;
    const hires = mode === 5 || mode === 6 || (this.setini & 8) !== 0;
    const width = mode === 5 || mode === 6 ? 512 : 256;
    const z = ZTABLE[mode];
    const bpp = BPP[mode];
    const layers = this.tm | this.ts;

    // BG
    for (let bg = 0; bg < 4; bg++) {
      this.bgZ[bg].fill(0);
      if (!(layers & (1 << bg))) continue;
      if (mode === 7) {
        if (bg === 0) this.renderMode7(y, 0, z);
        else if (bg === 1 && this.setini & 0x40) this.renderMode7(y, 1, z);
        continue;
      }
      if (!bpp[bg]) continue;
      this.renderBg(bg, y, bpp[bg], width, z);
    }
    // OBJ
    this.objZ.fill(0);
    if (layers & 0x10) this.renderObj(y, z);

    // ウィンドウ
    this.buildWindows();

    // メイン画面とサブ画面を重ねる
    this.compose(true, width);
    this.compose(false, width);

    // カラー演算
    const br = this.brightness * 32768;
    const cgw = this.cgwsel;
    const add = this.cgadsub;
    const sub = (add & 0x80) !== 0;
    const half = (add & 0x40) !== 0;
    const useSub = (cgw & 2) !== 0;
    const colorWin = this.winMask[5];
    const blackMode = (cgw >> 6) & 3;
    const mathMode = (cgw >> 4) & 3;
    const fixed = this.fixedColor;
    const step = width === 512 ? 2 : 1;
    if (!hires && !(add & 0x3f) && blackMode === 0) {
      // カラー演算も黒くする範囲もないとき
      const mc = this.mainC;
      for (let x = 0; x < SNES_W; x++) out[row + x] = COLORS[br + mc[x]];
      return;
    }
    if (!hires) {
      // ふつうの解像度：1 点ずつ演算する
      const mc = this.mainC;
      const ml = this.mainL;
      const sc = this.subC;
      const sl = this.subL;
      for (let x = 0; x < SNES_W; x++) {
        const inWin = colorWin[x];
        let c = mc[x];
        const layer = ml[x];
        const black = blackMode === 3 || (blackMode === 2 && inWin === 1) || (blackMode === 1 && inWin === 0);
        if (black) c = 0;
        if (
          add & LAYER_BIT[layer] &&
          (mathMode === 0 || (mathMode === 1 && inWin === 1) || (mathMode === 2 && inWin === 0))
        ) {
          let operand = fixed;
          let halve = half && !black;
          if (useSub) {
            if (sl[x] === 6) halve = false;
            else operand = sc[x];
          }
          c = mix(c, operand, sub, halve);
        }
        out[row + x] = COLORS[br + c];
      }
      return;
    }
    for (let x = 0; x < SNES_W; x++) {
      let color = 0;
      for (let k = 0; k < (hires ? 2 : 1); k++) {
        // 高解像度：偶数の点はサブ画面、奇数の点はメイン画面
        const px = x * step + (step === 2 ? (k === 0 ? 1 : 0) : 0);
        const inWin = colorWin[x];
        let c = this.mainC[px];
        const layer = this.mainL[px];
        const black = blackMode === 3 || (blackMode === 2 && inWin) || (blackMode === 1 && !inWin);
        if (black) c = 0;
        const mathOk = mathMode === 0 || (mathMode === 1 && inWin) || (mathMode === 2 && !inWin);
        let enabled = mathOk && (add & (1 << (layer === 6 ? 5 : layer === 5 ? 4 : layer))) !== 0;
        if (layer === 4) enabled = false; // パレット 0〜3 の OBJ は演算しない
        if (hires && k === 1) {
          // サブ画面の点
          c = this.subL[px] === 6 ? this.cgram[0] & 0x7fff : this.subC[px];
          enabled = false;
        }
        if (enabled) {
          let operand: number;
          let halve = half;
          if (useSub) {
            if (this.subL[px] === 6) {
              operand = fixed;
              halve = false;
            } else operand = this.subC[px];
          } else operand = fixed;
          if (black) halve = false;
          c = mix(c, operand, sub, halve);
        }
        if (k === 0) color = c;
        else color = avg(color, c);
      }
      out[row + x] = COLORS[br + color];
    }
  }

  /** メイン（true）かサブ画面の、点ごとにいちばん手前の色と層を決める（層：0〜3 BG、4 OBJ（演算なし）、5 OBJ、6 背景色） */
  private compose(main: boolean, width: number): void {
    const enable = main ? this.tm : this.ts;
    const winDis = main ? this.tmw : this.tsw;
    const outC = main ? this.mainC : this.subC;
    const outL = main ? this.mainL : this.subL;
    const back = main ? this.cgram[0] & 0x7fff : this.fixedColor;
    const hi = width === 512 ? 1 : 0;
    outC.fill(back, 0, width);
    outL.fill(6, 0, width);
    const best = this.bestZ;
    best.fill(0, 0, width);
    for (let bg = 0; bg < 4; bg++) {
      if (!(enable & (1 << bg))) continue;
      const zb = this.bgZ[bg];
      const cb = this.bgColor[bg];
      const win = winDis & (1 << bg) ? this.winMask[bg] : null;
      for (let px = 0; px < width; px++) {
        const zz = zb[px];
        if (zz > best[px] && !(win && win[px >> hi])) {
          best[px] = zz;
          outC[px] = cb[px];
          outL[px] = bg;
        }
      }
    }
    if (enable & 0x10) {
      const win = winDis & 0x10 ? this.winMask[4] : null;
      for (let px = 0; px < width; px++) {
        const x = px >> hi;
        const zz = this.objZ[x];
        if (zz > best[px] && !(win && win[x])) {
          best[px] = zz;
          outC[px] = this.objColor[x];
          outL[px] = this.objMath[x] ? 5 : 4;
        }
      }
    }
  }

  private buildWindows(): void {
    const w1l = this.wpos[0];
    const w1r = this.wpos[1];
    const w2l = this.wpos[2];
    const w2r = this.wpos[3];
    for (let layer = 0; layer < 6; layer++) {
      const mask = this.winMask[layer];
      const sel = (this.wsel[layer >> 1] >> ((layer & 1) * 4)) & 15;
      const logic = layer < 4 ? (this.wbglog >> (layer * 2)) & 3 : (this.wobjlog >> ((layer - 4) * 2)) & 3;
      const e1 = sel & 2;
      const i1 = sel & 1;
      const e2 = sel & 8;
      const i2 = sel & 4;
      if (!e1 && !e2) {
        mask.fill(0);
        continue;
      }
      for (let x = 0; x < 256; x++) {
        const a = (x >= w1l && x <= w1r ? 1 : 0) ^ (i1 ? 1 : 0);
        const b = (x >= w2l && x <= w2r ? 1 : 0) ^ (i2 ? 1 : 0);
        let r: number;
        if (e1 && !e2) r = a;
        else if (e2 && !e1) r = b;
        else if (logic === 0) r = a | b;
        else if (logic === 1) r = a & b;
        else if (logic === 2) r = a ^ b;
        else r = (a ^ b) ^ 1;
        mask[x] = r;
      }
    }
  }

  private renderBg(bg: number, y: number, bpp: number, width: number, z: number[]): void {
    const vram = this.vram;
    const cg = this.cgram;
    const big = (this.bigTiles >> bg) & 1;
    const tileW = big || width === 512 ? 16 : 8;
    const tileH = big ? 16 : 8;
    const size = this.mapSize[bg];
    const mapW = (size & 1 ? 64 : 32) * tileW;
    const mapH = (size & 2 ? 64 : 32) * tileH;
    const mapBase = this.mapBase[bg];
    const charBase = this.charBase[bg];
    const zLo = z[bg * 2];
    const zHi = z[bg * 2 + 1];
    const colorBuf = this.bgColor[bg];
    const zBuf = this.bgZ[bg];
    const mosaic = (this.mosaicMask >> bg) & 1 ? this.mosaicSize : 1;
    const direct = bpp === 8 && (this.cgwsel & 1) !== 0;
    const palBase = this.bgMode === 0 ? bg * 32 : 0;
    const wordsPerTile = bpp * 4;
    const hScale = width === 512 ? 2 : 1;
    const opt = this.bgMode === 2 || this.bgMode === 4 || this.bgMode === 6;

    let line = y;
    if (mosaic > 1) line = y - ((y - 1) % mosaic);
    const baseH = this.hofs[bg] * hScale;
    const baseV = this.vofs[bg];

    // 同じ文字（8 ドット）の中は、まとめて読む。モザイクとオフセットパータイルは 1 ドットずつ
    const single = mosaic > 1 || opt;
    let px = 0;
    while (px < width) {
      const sx = mosaic > 1 ? px - (px % (mosaic * hScale)) : px;
      let hofs = baseH;
      let vofs = baseV;
      if (opt) {
        // オフセットパータイル：列ごとに BG3 のマップからずらす量を読む
        const col = (sx + (baseH & 7)) >> 3;
        if (col > 0) {
          const o = this.optEntry(col - 1, bg);
          if (o.h !== -1) hofs = (baseH & 7) | ((o.h * hScale) & ~7);
          if (o.v !== -1) vofs = o.v;
        }
      }
      const mx = (sx + hofs) & (mapW - 1);
      const my = (line + vofs) & (mapH - 1);
      const tx = tileW === 16 ? mx >> 4 : mx >> 3;
      const ty = tileH === 16 ? my >> 4 : my >> 3;
      // マップは 32×32 のブロックが並ぶ
      let off = ((ty & 31) << 5) | (tx & 31);
      if (tx & 32) off += 0x400;
      if (ty & 32) off += size & 1 ? 0x800 : 0x400;
      const entry = vram[(mapBase + off) & 0x7fff];
      const fy = my & (tileH - 1);
      const fx = mx & (tileW - 1);
      const hflip = entry & 0x4000;
      let cy = entry & 0x8000 ? tileH - 1 - fy : fy;
      let cx = hflip ? tileW - 1 - fx : fx;
      let tile = entry & 0x3ff;
      if (cx >= 8) {
        tile += 1;
        cx -= 8;
      }
      if (cy >= 8) {
        tile += 16;
        cy -= 8;
      }
      const addr = (charBase + (tile & 0x3ff) * wordsPerTile + cy) & 0x7fff;
      const w0 = vram[addr];
      const w1 = bpp >= 4 ? vram[(addr + 8) & 0x7fff] : 0;
      const w2 = bpp === 8 ? vram[(addr + 16) & 0x7fff] : 0;
      const w3 = bpp === 8 ? vram[(addr + 24) & 0x7fff] : 0;
      const pal = (entry >> 10) & 7;
      const zz = entry & 0x2000 ? zHi : zLo;
      const palOff = bpp === 4 ? pal * 16 : bpp === 2 ? palBase + pal * 4 : 0;
      // この文字の中で続けて描けるドット数
      let run = single ? 1 : hflip ? cx + 1 : 8 - cx;
      if (px + run > width) run = width - px;
      for (let k = 0; k < run; k++, px++) {
        const bit = 7 - cx;
        cx += hflip ? -1 : 1;
        let ci = ((w0 >> bit) & 1) | (((w0 >> (bit + 8)) & 1) << 1);
        if (bpp >= 4) {
          ci |= (((w1 >> bit) & 1) << 2) | (((w1 >> (bit + 8)) & 1) << 3);
          if (bpp === 8)
            ci |=
              (((w2 >> bit) & 1) << 4) |
              (((w2 >> (bit + 8)) & 1) << 5) |
              (((w3 >> bit) & 1) << 6) |
              (((w3 >> (bit + 8)) & 1) << 7);
        }
        if (!ci) {
          zBuf[px] = 0;
          continue;
        }
        colorBuf[px] = (direct ? directColor(ci, pal) : cg[palOff + ci]) & 0x7fff;
        zBuf[px] = zz;
      }
    }
  }

  /** オフセットパータイルの値（-1 = 使わない） */
  private optEntry(col: number, bg: number): { h: number; v: number } {
    const vram = this.vram;
    const base = this.mapBase[2];
    const h3 = this.hofs[2];
    const v3 = this.vofs[2];
    const tx = ((h3 >> 3) + col) & 31;
    const ty = (v3 >> 3) & 31;
    const bit = bg === 0 ? 0x2000 : 0x4000;
    const e1 = vram[(base + ty * 32 + tx) & 0x7fff];
    let h = -1;
    let v = -1;
    if (this.bgMode === 4) {
      if (e1 & bit) {
        if (e1 & 0x8000) v = e1 & 0x3ff;
        else h = e1 & 0x3ff;
      }
    } else {
      const e2 = vram[(base + ((ty + 1) & 31) * 32 + tx) & 0x7fff];
      if (e1 & bit) h = e1 & 0x3ff;
      if (e2 & bit) v = e2 & 0x3ff;
    }
    return { h, v };
  }

  private renderMode7(y: number, bg: number, z: number[]): void {
    const vram = this.vram;
    const cg = this.cgram;
    const a = sign16(this.m7a);
    const b = sign16(this.m7b);
    const c = sign16(this.m7c);
    const d = sign16(this.m7d);
    const cx = sign13(this.m7x);
    const cy = sign13(this.m7y);
    const hofs = sign13(this.m7hofs);
    const vofs = sign13(this.m7vofs);
    const sel = this.m7sel;
    const mosaic = (this.mosaicMask >> bg) & 1 ? this.mosaicSize : 1;
    let line = y;
    if (mosaic > 1) line = y - ((y - 1) % mosaic);
    const yy = sel & 2 ? 255 - line : line;
    const psx = ((a * clip10(hofs - cx)) & ~63) + ((b * clip10(vofs - cy)) & ~63) + ((b * yy) & ~63) + (cx << 8);
    const psy = ((c * clip10(hofs - cx)) & ~63) + ((d * clip10(vofs - cy)) & ~63) + ((d * yy) & ~63) + (cy << 8);
    const repeat = sel >> 6;
    const colorBuf = this.bgColor[bg];
    const zBuf = this.bgZ[bg];
    const direct = bg === 0 && (this.cgwsel & 1) !== 0;
    for (let x = 0; x < 256; x++) {
      const sx0 = mosaic > 1 ? x - (x % mosaic) : x;
      const sx = sel & 1 ? 255 - sx0 : sx0;
      let px = (psx + a * sx) >> 8;
      let py = (psy + c * sx) >> 8;
      let tile: number;
      const out = px < 0 || py < 0 || px > 1023 || py > 1023;
      if (repeat === 2 && out) {
        zBuf[x] = 0;
        continue;
      }
      if (repeat === 3 && out) tile = 0;
      else {
        px &= 1023;
        py &= 1023;
        tile = vram[(py >> 3) * 128 + (px >> 3)] & 0xff;
      }
      const ci = vram[(tile * 64 + (py & 7) * 8 + (px & 7)) & 0x7fff] >> 8;
      if (bg === 1) {
        // EXTBG：bit7 が優先度、残り 7 ビットが色
        const c7 = ci & 0x7f;
        if (!c7) {
          zBuf[x] = 0;
          continue;
        }
        colorBuf[x] = cg[c7] & 0x7fff;
        zBuf[x] = ci & 0x80 ? z[3] : z[2];
        continue;
      }
      if (!ci) {
        zBuf[x] = 0;
        continue;
      }
      colorBuf[x] = direct ? directColor(ci, 0) : cg[ci] & 0x7fff;
      zBuf[x] = z[0];
    }
  }

  private renderObj(y: number, z: number[]): void {
    const oam = this.oam;
    const vram = this.vram;
    const cg = this.cgram;
    const sizes = OBJ_SIZES[this.objSize];
    const objColor = this.objColor;
    const objZ = this.objZ;
    const objMath = this.objMath;
    // 優先順位の高い順（OAM の番号順。回転していればそこから）に、このラインに入るものを 32 個まで集める
    const first = this.oamPriority ? (this.oamAddr >> 2) & 0x7f : 0;
    const list: number[] = [];
    const line = (y - 1) & 0xff; // スプライトの Y は 1 ライン遅れて表示される
    for (let k = 0; k < 128 && list.length < 32; k++) {
      const i = (first + k) & 0x7f;
      const hi = oam[0x200 + (i >> 2)] >> ((i & 3) * 2);
      const large = (hi >> 1) & 1;
      const w = sizes[large * 2];
      const h = sizes[large * 2 + 1];
      const sy = oam[i * 4 + 1];
      if (((line - sy) & 0xff) >= h) continue;
      let sx = oam[i * 4] | ((hi & 1) << 8);
      if (sx >= 256) sx -= 512;
      if (sx + w <= 0 || sx >= 256) continue;
      list.push(i);
    }
    // 優先順位の低いものから描き、高いもので上書きする
    for (let n = list.length - 1; n >= 0; n--) {
      const i = list[n];
      const hi = oam[0x200 + (i >> 2)] >> ((i & 3) * 2);
      const large = (hi >> 1) & 1;
      const w = sizes[large * 2];
      const h = sizes[large * 2 + 1];
      let sx = oam[i * 4] | ((hi & 1) << 8);
      if (sx >= 256) sx -= 512;
      const sy = oam[i * 4 + 1];
      const tileLo = oam[i * 4 + 2];
      const attr = oam[i * 4 + 3];
      const nameHi = attr & 1;
      const pal = (attr >> 1) & 7;
      const prio = (attr >> 4) & 3;
      let ry = (line - sy) & 0xff;
      if (attr & 0x80) ry = h - 1 - ry;
      const zz = z[8 + prio];
      const math = pal >= 4 ? 1 : 0;
      const base = this.objBase + (nameHi ? this.objNameOffset : 0);
      for (let rx = 0; rx < w; rx++) {
        const x = sx + rx;
        if (x < 0 || x >= 256) continue;
        const cx = attr & 0x40 ? w - 1 - rx : rx;
        // 16×16 のタイルの並びの中で折り返す
        const tile = ((((tileLo >> 4) + (ry >> 3)) & 15) << 4) | ((tileLo + (cx >> 3)) & 15);
        const addr = (base + tile * 16 + (ry & 7)) & 0x7fff;
        const p0 = vram[addr];
        const p1 = vram[(addr + 8) & 0x7fff];
        const bit = 7 - (cx & 7);
        const ci =
          ((p0 >> bit) & 1) | (((p0 >> (bit + 8)) & 1) << 1) | (((p1 >> bit) & 1) << 2) | (((p1 >> (bit + 8)) & 1) << 3);
        if (!ci) continue;
        objColor[x] = cg[128 + pal * 16 + ci] & 0x7fff;
        objZ[x] = zz;
        objMath[x] = math;
      }
    }
  }
}

function directColor(ci: number, pal: number): number {
  const r = ((ci & 7) << 2) | ((pal & 1) << 1);
  const g = (((ci >> 3) & 7) << 2) | (((pal >> 1) & 1) << 1);
  const b = (((ci >> 6) & 3) << 3) | (((pal >> 2) & 1) << 2);
  return r | (g << 5) | (b << 10);
}

function mix(a: number, b: number, sub: boolean, half: boolean): number {
  let r: number;
  let g: number;
  let bl: number;
  if (sub) {
    r = (a & 31) - (b & 31);
    g = ((a >> 5) & 31) - ((b >> 5) & 31);
    bl = ((a >> 10) & 31) - ((b >> 10) & 31);
    if (half) {
      r >>= 1;
      g >>= 1;
      bl >>= 1;
    }
    if (r < 0) r = 0;
    if (g < 0) g = 0;
    if (bl < 0) bl = 0;
  } else {
    r = (a & 31) + (b & 31);
    g = ((a >> 5) & 31) + ((b >> 5) & 31);
    bl = ((a >> 10) & 31) + ((b >> 10) & 31);
    if (half) {
      r >>= 1;
      g >>= 1;
      bl >>= 1;
    }
    if (r > 31) r = 31;
    if (g > 31) g = 31;
    if (bl > 31) bl = 31;
  }
  return r | (g << 5) | (bl << 10);
}

function avg(a: number, b: number): number {
  const r = ((a & 31) + (b & 31)) >> 1;
  const g = (((a >> 5) & 31) + ((b >> 5) & 31)) >> 1;
  const bl = (((a >> 10) & 31) + ((b >> 10) & 31)) >> 1;
  return r | (g << 5) | (bl << 10);
}
