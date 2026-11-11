// ゲームボーイの画面（PPU）。1 ライン 456 ドット × 154 ライン。
// 描画はライン単位（モード 3 に入った時点のレジスタで 1 ライン描く）

export const GB_W = 160;
export const GB_H = 144;

/** ImageData にそのまま書ける色（ABGR）に直す */
const abgr = (rgb: number) => (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | (rgb >> 16)) >>> 0;

/** 白黒ゲームボーイの 4 色（明るい順。昔の液晶っぽい緑） */
export const DMG_COLORS = Uint32Array.from([0xe0f8d0, 0x88c070, 0x346856, 0x081820], abgr);

/** 0xRRGGBB → ABGR */
export const toAbgr = abgr;

/** ゲームボーイカラーの 15 ビット色 → ABGR（液晶らしく少しだけ色を混ぜて、どぎつさを抑える） */
function cgbColor(c: number): number {
  const r = c & 31;
  const g = (c >> 5) & 31;
  const b = (c >> 10) & 31;
  const R = (r * 26 + g * 4 + b * 2) >> 5;
  const G = (g * 24 + b * 8) >> 5;
  const B = (r * 6 + g * 4 + b * 22) >> 5;
  const s = (v: number) => Math.min(255, (v * 255) / 31) | 0;
  return (0xff000000 | (s(B) << 16) | (s(G) << 8) | s(R)) >>> 0;
}

export interface PpuHost {
  /** 割り込み要求（0 = VBlank、1 = STAT） */
  interrupt(bit: number): void;
  /** HBlank に入った（HBlank DMA 用） */
  hblank(): void;
}

export class GbPpu {
  readonly frameBuffer = new Uint32Array(GB_W * GB_H);
  /** 8KB × 2 バンク */
  readonly vram = new Uint8Array(0x4000);
  readonly oam = new Uint8Array(0xa0);
  frameReady = false;

  lcdc = 0x91;
  stat = 0;
  scy = 0;
  scx = 0;
  ly = 0;
  lyc = 0;
  bgp = 0xfc;
  obp0 = 0xff;
  obp1 = 0xff;
  wy = 0;
  wx = 0;
  vramBank = 0;

  // ゲームボーイカラーのパレット（各 64 バイト）
  readonly bgPalRam = new Uint8Array(64).fill(0xff);
  readonly objPalRam = new Uint8Array(64);
  bcps = 0;
  ocps = 0;
  private bgColors = new Uint32Array(32);
  private objColors = new Uint32Array(32);
  /** 白黒のソフトの 4 色（背景・スプライト 0・スプライト 1）。色をつけるときはここを変える */
  readonly dmgBg = DMG_COLORS.slice();
  readonly dmgObj0 = DMG_COLORS.slice();
  readonly dmgObj1 = DMG_COLORS.slice();
  /** OPRI：1 なら白黒と同じく X 座標でスプライトの優先順位を決める */
  opri = 0;

  private line = 0;
  private dot = 0;
  private mode = 2;
  private mode3End = 252;
  private statLine = false;
  private windowLine = 0;
  private wyHit = false;
  private offDots = 0;

  // 1 ライン分の作業用
  private bgIdx = new Uint8Array(GB_W);
  private bgPrio = new Uint8Array(GB_W);
  private objDone = new Uint8Array(GB_W);
  private sprites: number[] = [];

  constructor(
    private host: PpuHost,
    readonly cgb: boolean,
  ) {
    for (let i = 0; i < 32; i++) this.updatePal(i);
    this.frameBuffer.fill(DMG_COLORS[0]);
  }

  get on(): boolean {
    return (this.lcdc & 0x80) !== 0;
  }

  // ---- レジスタ ----
  read(a: number): number {
    switch (a) {
      case 0xff40:
        return this.lcdc;
      case 0xff41:
        return 0x80 | (this.stat & 0x78) | (this.ly === this.lyc ? 4 : 0) | (this.on ? this.mode : 0);
      case 0xff42:
        return this.scy;
      case 0xff43:
        return this.scx;
      case 0xff44:
        return this.ly;
      case 0xff45:
        return this.lyc;
      case 0xff47:
        return this.bgp;
      case 0xff48:
        return this.obp0;
      case 0xff49:
        return this.obp1;
      case 0xff4a:
        return this.wy;
      case 0xff4b:
        return this.wx;
    }
    if (!this.cgb) return 0xff;
    switch (a) {
      case 0xff4f:
        return 0xfe | this.vramBank;
      case 0xff68:
        return 0x40 | this.bcps;
      case 0xff69:
        return this.bgPalRam[this.bcps & 0x3f];
      case 0xff6a:
        return 0x40 | this.ocps;
      case 0xff6b:
        return this.objPalRam[this.ocps & 0x3f];
      case 0xff6c:
        return 0xfe | this.opri;
    }
    return 0xff;
  }

  write(a: number, v: number): void {
    switch (a) {
      case 0xff40: {
        const wasOn = this.on;
        this.lcdc = v;
        if (wasOn && !this.on) {
          // 画面を消す：LY は 0 に戻り、画面は白くなる
          this.line = 0;
          this.ly = 0;
          this.dot = 0;
          this.mode = 0;
          this.offDots = 0;
          this.frameBuffer.fill(this.cgb ? 0xffffffff : this.dmgBg[0]);
        } else if (!wasOn && this.on) {
          this.line = 0;
          this.ly = 0;
          this.dot = 0;
          this.mode = 2;
          this.windowLine = 0;
          this.wyHit = this.wy === 0;
        }
        this.updateStat();
        return;
      }
      case 0xff41:
        this.stat = v & 0x78;
        this.updateStat();
        return;
      case 0xff42:
        this.scy = v;
        return;
      case 0xff43:
        this.scx = v;
        return;
      case 0xff45:
        this.lyc = v;
        this.updateStat();
        return;
      case 0xff47:
        this.bgp = v;
        return;
      case 0xff48:
        this.obp0 = v;
        return;
      case 0xff49:
        this.obp1 = v;
        return;
      case 0xff4a:
        this.wy = v;
        return;
      case 0xff4b:
        this.wx = v;
        return;
    }
    if (!this.cgb) return;
    switch (a) {
      case 0xff4f:
        this.vramBank = v & 1;
        return;
      case 0xff68:
        this.bcps = v & 0xbf;
        return;
      case 0xff69: {
        const i = this.bcps & 0x3f;
        this.bgPalRam[i] = v;
        this.updatePal(i >> 1);
        if (this.bcps & 0x80) this.bcps = (this.bcps & 0x80) | ((i + 1) & 0x3f);
        return;
      }
      case 0xff6a:
        this.ocps = v & 0xbf;
        return;
      case 0xff6b: {
        const i = this.ocps & 0x3f;
        this.objPalRam[i] = v;
        this.updatePal(32 + (i >> 1));
        if (this.ocps & 0x80) this.ocps = (this.ocps & 0x80) | ((i + 1) & 0x3f);
        return;
      }
      case 0xff6c:
        this.opri = v & 1;
        return;
    }
  }

  /** パレットの色を作り直す（0〜31 = 背景、32〜63 = スプライト） */
  private updatePal(i: number): void {
    if (i < 32) this.bgColors[i] = cgbColor(this.bgPalRam[i * 2] | (this.bgPalRam[i * 2 + 1] << 8));
    else {
      const j = i - 32;
      this.objColors[j] = cgbColor(this.objPalRam[j * 2] | (this.objPalRam[j * 2 + 1] << 8));
    }
  }

  /** パレットの RAM を書き戻したあと（どこでもセーブのロード）に色を作り直す */
  refreshPalettes(): void {
    for (let i = 0; i < 64; i++) this.updatePal(i);
  }

  private setMode(m: number): void {
    this.mode = m;
    this.updateStat();
  }

  /** STAT 割り込みの線（どれか 1 つでも立っていれば 1）。0 → 1 で割り込み */
  private updateStat(): void {
    const s = this.stat;
    const on = this.on;
    const line =
      on &&
      ((s & 0x40 && this.ly === this.lyc) ||
        (s & 0x08 && this.mode === 0) ||
        (s & 0x10 && this.mode === 1) ||
        (s & 0x20 && this.mode === 2));
    if (line && !this.statLine) this.host.interrupt(1);
    this.statLine = !!line;
  }

  // ---- 時間を進める ----
  advance(dots: number): void {
    if (!this.on) {
      this.offDots += dots;
      if (this.offDots >= 70224) {
        this.offDots -= 70224;
        this.frameReady = true;
      }
      return;
    }
    this.dot += dots;
    for (;;) {
      if (this.line < 144) {
        if (this.mode === 2 && this.dot >= 80) {
          this.renderLine();
          this.mode3End = 80 + 172 + (this.scx & 7) + this.sprites.length * 6;
          this.setMode(3);
          continue;
        }
        if (this.mode === 3 && this.dot >= this.mode3End) {
          this.setMode(0);
          this.host.hblank();
          continue;
        }
      }
      if (this.dot >= 456) {
        this.dot -= 456;
        this.nextLine();
        continue;
      }
      break;
    }
  }

  private nextLine(): void {
    this.line++;
    if (this.line === 144) {
      this.ly = 144;
      this.mode = 1;
      this.host.interrupt(0);
      this.frameReady = true;
    } else if (this.line === 154) {
      this.line = 0;
      this.ly = 0;
      this.mode = 2;
      this.windowLine = 0;
      this.wyHit = false;
    } else {
      this.ly = this.line;
      if (this.line < 144) this.mode = 2;
    }
    if (this.line < 144 && this.ly === this.wy) this.wyHit = true;
    this.updateStat();
  }

  // ---- 1 ライン描く ----
  private renderLine(): void {
    const ly = this.line;
    const lcdc = this.lcdc;
    const cgb = this.cgb;
    const vram = this.vram;
    const fb = this.frameBuffer;
    const row = ly * GB_W;
    const bgIdx = this.bgIdx;
    const bgPrio = this.bgPrio;
    const bgp = this.bgp;
    const signed = (lcdc & 0x10) === 0;
    const dmgBg = this.dmgBg;

    /** 背景かウィンドウの 1 タイル分（x0 から w ドット、タイルの中の横位置は fx から） */
    const drawTiles = (mapBase: number, srcY: number, srcX: number, from: number) => {
      const tileRow = (srcY >> 3) & 31;
      const fy = srcY & 7;
      let x = from;
      let sx = srcX;
      while (x < GB_W) {
        const mapAddr = mapBase + tileRow * 32 + ((sx >> 3) & 31);
        const tile = vram[mapAddr];
        const attr = cgb ? vram[0x2000 + mapAddr] : 0;
        const base = (attr & 8 ? 0x2000 : 0) + (signed ? 0x1000 + ((tile << 24) >> 24) * 16 : tile * 16);
        const ty = attr & 0x40 ? 7 - fy : fy;
        const lo = vram[base + ty * 2];
        const hi = vram[base + ty * 2 + 1];
        const pal = (attr & 7) * 4;
        for (let px = sx & 7; px < 8 && x < GB_W; px++, x++, sx++) {
          const bit = attr & 0x20 ? px : 7 - px;
          const idx = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
          bgIdx[x] = idx;
          bgPrio[x] = attr & 0x80 ? 1 : 0;
          fb[row + x] = cgb ? this.bgColors[pal + idx] : dmgBg[(bgp >> (idx * 2)) & 3];
        }
      }
    };

    if (cgb || lcdc & 1) {
      drawTiles(lcdc & 0x08 ? 0x1c00 : 0x1800, (ly + this.scy) & 0xff, this.scx, 0);
      // ウィンドウ
      if (lcdc & 0x20 && this.wyHit && this.wx <= 166) {
        const wx = this.wx - 7;
        const from = Math.max(0, wx);
        drawTiles(lcdc & 0x40 ? 0x1c00 : 0x1800, this.windowLine, from - wx, from);
        this.windowLine++;
      }
    } else {
      bgIdx.fill(0);
      bgPrio.fill(0);
      fb.fill(dmgBg[0], row, row + GB_W);
    }

    // スプライト：このラインにかかる最初の 10 個
    const tall = (lcdc & 4) !== 0;
    const h = tall ? 16 : 8;
    const oam = this.oam;
    const sprites = this.sprites;
    sprites.length = 0;
    for (let i = 0; i < 40 && sprites.length < 10; i++) {
      const y = oam[i * 4] - 16;
      if (ly >= y && ly < y + h) sprites.push(i);
    }
    if (!(lcdc & 2) || sprites.length === 0) return;
    // 優先順位：白黒は X 座標の小さい順（同じなら番号順）、カラーは番号順
    if (!cgb || this.opri) sprites.sort((a, b) => oam[a * 4 + 1] - oam[b * 4 + 1] || a - b);
    const done = this.objDone;
    done.fill(0);
    const masterPrio = !cgb || (lcdc & 1) !== 0;
    for (const i of sprites) {
      const o = i * 4;
      const y = oam[o] - 16;
      const x = oam[o + 1] - 8;
      const attr = oam[o + 3];
      let tile = oam[o + 2];
      if (tall) tile &= 0xfe;
      let ty = ly - y;
      if (attr & 0x40) ty = h - 1 - ty;
      const base = (cgb && attr & 8 ? 0x2000 : 0) + tile * 16 + ty * 2;
      const lo = vram[base];
      const hi = vram[base + 1];
      for (let px = 0; px < 8; px++) {
        const sx = x + px;
        if (sx < 0 || sx >= GB_W || done[sx]) continue;
        const bit = attr & 0x20 ? px : 7 - px;
        const idx = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        if (idx === 0) continue;
        done[sx] = 1;
        // 背景の色 1〜3 の後ろに隠れる
        if (masterPrio && bgIdx[sx] !== 0 && (attr & 0x80 || (cgb && bgPrio[sx]))) continue;
        fb[row + sx] = cgb
          ? this.objColors[(attr & 7) * 4 + idx]
          : (attr & 0x10 ? this.dmgObj1 : this.dmgObj0)[((attr & 0x10 ? this.obp1 : this.obp0) >> (idx * 2)) & 3];
      }
    }
  }
}
