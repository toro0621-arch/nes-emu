import type { Mapper } from './mappers/mapper';

// 2C02 の色（RGB）。nesdev wiki の 2C02 パレットを元にしたもの
const NES_RGB = [
  0x666666, 0x002a88, 0x1412a7, 0x3b00a4, 0x5c007e, 0x6e0040, 0x6c0600, 0x561d00,
  0x333500, 0x0b4800, 0x005200, 0x004f08, 0x00404d, 0x000000, 0x000000, 0x000000,
  0xadadad, 0x155fd9, 0x4240ff, 0x7527fe, 0xa01acc, 0xb71e7b, 0xb53120, 0x994e00,
  0x6b6d00, 0x388700, 0x0c9300, 0x008f32, 0x007c8d, 0x000000, 0x000000, 0x000000,
  0xfffeff, 0x64b0ff, 0x9290ff, 0xc676ff, 0xf36aff, 0xfe6ecc, 0xfe8170, 0xea9e22,
  0xbcbe00, 0x88d800, 0x5ce430, 0x45e082, 0x48cdde, 0x4f4f4f, 0x000000, 0x000000,
  0xfffeff, 0xc0dfff, 0xd3d2ff, 0xe8c8ff, 0xfbc2ff, 0xfec4ea, 0xfeccc5, 0xf7d8a5,
  0xe4e594, 0xcfef96, 0xbdf4ab, 0xb3f3cc, 0xb5ebf2, 0xb8b8b8, 0x000000, 0x000000,
];
/** ImageData にそのまま書ける色（リトルエンディアンの ABGR） */
const NES_ABGR = Uint32Array.from(
  NES_RGB,
  (c) => (0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | (c >> 16)) >>> 0,
);

// ネームテーブルのミラーリング（論理テーブル 0〜3 → 実メモリの 1KB ページ）
const NT_PAGES = {
  horizontal: [0, 0, 1, 1],
  vertical: [0, 1, 0, 1],
  single0: [0, 0, 0, 0],
  single1: [1, 1, 1, 1],
  four: [0, 1, 2, 3],
} as const;

export const SCREEN_W = 256;
export const SCREEN_H = 240;

export class Ppu {
  // レジスタ
  ctrl = 0;
  mask = 0;
  status = 0;
  oamAddr = 0;
  /** loopy の v / t / x / w */
  v = 0;
  t = 0;
  x = 0;
  w = 0;
  private readBuffer = 0;
  private openBus = 0;

  oam = new Uint8Array(256);
  /** ネームテーブル用のメモリ（4 画面ミラー用に 4KB）。テストが画面の文字を読むので公開 */
  vram = new Uint8Array(0x1000);
  palette = new Uint8Array(32);

  scanline = 0;
  dot = 0;
  frame = 0;
  /** 電源投入からの累計ドット（MMC3 が A12 の変化の間隔を測るのに使う） */
  dots = 0;
  private oddFrame = false;
  private skipDot = false;
  /** VBlank に入ったら true（呼び出し側が下ろす） */
  frameReady = false;
  frameBuffer = new Uint32Array(SCREEN_W * SCREEN_H);

  private suppressVbl = false;

  // 背景のパイプライン
  private ntByte = 0;
  private atBits = 0;
  private tileLo = 0;
  private tileHi = 0;
  private patLo = 0;
  private patHi = 0;
  private attrLo = 0;
  private attrHi = 0;

  // 次の走査線に描くスプライト（256 ピクセル分）
  private sprColor = new Uint8Array(SCREEN_W);
  private sprBehind = new Uint8Array(SCREEN_W);
  private sprZero = new Uint8Array(SCREEN_W);

  constructor(private mapper: Mapper) {
    mapper.attachCiram?.(this.vram);
  }

  /** NMI 出力線（VBlank 中かつ NMI 有効） */
  nmiOutput(): boolean {
    return (this.ctrl & 0x80) !== 0 && (this.status & 0x80) !== 0;
  }

  // ---- CPU から見たレジスタ $2000-$2007 ----
  readReg(reg: number): number {
    switch (reg & 7) {
      case 2: {
        const r = (this.status & 0xe0) | (this.openBus & 0x1f);
        // VBlank が立つ直前に読むと、その回は立たず NMI も出ない
        if (this.scanline === 241 && this.dot === 1) this.suppressVbl = true;
        this.status &= ~0x80;
        this.w = 0;
        return (this.openBus = r);
      }
      case 4: {
        let r = this.oam[this.oamAddr];
        if ((this.oamAddr & 3) === 2) r &= 0xe3;
        return (this.openBus = r);
      }
      case 7: {
        this.refreshMirroring();
        const addr = this.v & 0x3fff;
        let r: number;
        if (addr < 0x3f00) {
          r = this.readBuffer;
          this.readBuffer = this.read(addr);
        } else {
          // パレットはバッファを通さない（バッファには裏のネームテーブルが入る）
          r = (this.readPalette(addr) & this.greyMask()) | (this.openBus & 0xc0);
          this.readBuffer = this.read(addr - 0x1000);
        }
        this.incrementV();
        this.mapper.ppuAddress?.(this.v & 0x3fff); // 進んだ v がアドレスバスに出る
        return (this.openBus = r);
      }
      default:
        return this.openBus;
    }
  }

  writeReg(reg: number, val: number): void {
    this.openBus = val;
    switch (reg & 7) {
      case 0:
        this.ctrl = val;
        this.t = (this.t & 0xf3ff) | ((val & 3) << 10);
        break;
      case 1:
        this.mask = val;
        break;
      case 3:
        this.oamAddr = val;
        break;
      case 4:
        this.oam[this.oamAddr] = val;
        this.oamAddr = (this.oamAddr + 1) & 0xff;
        break;
      case 5:
        if (!this.w) {
          this.t = (this.t & 0xffe0) | (val >> 3);
          this.x = val & 7;
        } else {
          this.t = (this.t & 0x8c1f) | ((val & 7) << 12) | ((val & 0xf8) << 2);
        }
        this.w ^= 1;
        break;
      case 6:
        if (!this.w) {
          this.t = (this.t & 0x80ff) | ((val & 0x3f) << 8);
        } else {
          this.t = (this.t & 0xff00) | val;
          this.v = this.t;
          // アドレスバスに新しい v が出る（MMC3 はここでも A12 の変化を見る）
          this.mapper.ppuAddress?.(this.v & 0x3fff);
        }
        this.w ^= 1;
        break;
      case 7:
        this.refreshMirroring();
        this.write(this.v & 0x3fff, val);
        this.incrementV();
        this.mapper.ppuAddress?.(this.v & 0x3fff);
        break;
    }
  }

  /** $4014 の OAM DMA が 1 バイト書く */
  dmaWrite(val: number): void {
    this.oam[this.oamAddr] = val;
    this.oamAddr = (this.oamAddr + 1) & 0xff;
  }

  // ---- PPU のメモリ空間 ----
  /** ミラーリング表。マッパーが途中で切り替えることがあるので、走査線ごとと $2007 のたびに取り直す */
  private ntPages: readonly number[] = NT_PAGES.horizontal;
  private refreshMirroring(): void {
    this.ntPages = NT_PAGES[this.mapper.mirroring()];
  }

  private ntIndex(addr: number): number {
    return this.ntPages[(addr >> 10) & 3] * 0x400 + (addr & 0x3ff);
  }

  private read(addr: number): number {
    if (addr < 0x2000) return this.mapper.ppuRead(addr);
    if (addr < 0x3f00) {
      // ネームテーブルを自分で切り替えるマッパーは、マッパーに任せる
      if (this.mapper.ntRead) return this.mapper.ntRead(addr & 0x2fff);
      return this.vram[this.ntIndex(addr)];
    }
    return this.readPalette(addr);
  }

  private write(addr: number, val: number): void {
    if (addr < 0x2000) this.mapper.ppuWrite(addr, val);
    else if (addr < 0x3f00) {
      if (this.mapper.ntWrite) this.mapper.ntWrite(addr & 0x2fff, val);
      else this.vram[this.ntIndex(addr)] = val;
    } else this.palette[paletteIndex(addr)] = val & 0x3f;
  }

  private readPalette(addr: number): number {
    return this.palette[paletteIndex(addr)];
  }

  private greyMask(): number {
    return this.mask & 1 ? 0x30 : 0x3f;
  }

  private rendering(): boolean {
    return (this.mask & 0x18) !== 0;
  }

  private incrementV(): void {
    if (this.rendering() && (this.scanline < 240 || this.scanline === 261)) {
      // 描画中に $2007 を触ると、X と Y のスクロールが同時に進む
      this.incX();
      this.incY();
    } else {
      this.v = (this.v + (this.ctrl & 0x04 ? 32 : 1)) & 0x7fff;
    }
  }

  // ---- スクロール（loopy） ----
  private incX(): void {
    if ((this.v & 0x1f) === 31) {
      this.v &= ~0x1f;
      this.v ^= 0x400;
    } else this.v++;
  }

  private incY(): void {
    if ((this.v & 0x7000) !== 0x7000) {
      this.v += 0x1000;
      return;
    }
    this.v &= ~0x7000;
    let y = (this.v & 0x3e0) >> 5;
    if (y === 29) {
      y = 0;
      this.v ^= 0x800;
    } else if (y === 31) y = 0;
    else y++;
    this.v = (this.v & ~0x3e0) | (y << 5);
  }

  // ---- 1 ドット進める ----
  tick(): void {
    const sl = this.scanline;
    const dot = this.dot;
    this.dots++;

    if (dot === 0) this.mapper.ppuScanline?.(sl, (this.mask & 0x18) !== 0);
    if (sl < 240) {
      if (dot === 0) this.refreshMirroring();
      else {
        if (this.mask & 0x18) this.renderDot(sl, dot, true);
        if (dot <= 256) this.outputPixel(sl, dot - 1);
      }
    } else if (sl === 261) {
      if (dot === 1) this.status &= ~0xe0; // VBlank・スプライト0ヒット・オーバーフローを下ろす
      if (this.mask & 0x18) this.renderDot(sl, dot, false);
      // 奇数フレームで描画中なら、プリレンダーラインの最後の 1 ドットを飛ばす（描画が有効かどうかは 1 ドット前に見る）
      if (dot === 338) this.skipDot = this.oddFrame && (this.mask & 0x18) !== 0;
      else if (dot === 339 && this.skipDot) this.dot = 340;
    } else if (sl === 241 && dot === 1) {
      if (!this.suppressVbl) this.status |= 0x80;
      this.suppressVbl = false;
      this.frameReady = true;
    }

    if (++this.dot > 340) {
      this.dot = 0;
      if (++this.scanline > 261) {
        this.scanline = 0;
        this.frame++;
        this.oddFrame = !this.oddFrame;
      }
    }
  }

  private renderDot(sl: number, dot: number, visible: boolean): void {
    if ((dot >= 2 && dot <= 257) || (dot >= 322 && dot <= 337)) {
      // 8 ドットごとに 1 タイル分を読む
      switch ((dot - 1) & 7) {
        case 0:
          this.loadShifters();
          this.ntByte = this.read(0x2000 | (this.v & 0x0fff));
          break;
        case 2: {
          const v = this.v;
          const at = this.read(0x23c0 | (v & 0x0c00) | ((v >> 4) & 0x38) | ((v >> 2) & 0x07));
          this.atBits = (at >> (((v >> 4) & 4) | (v & 2))) & 3;
          break;
        }
        case 4:
          this.tileLo = this.read(this.bgPatternAddr());
          break;
        case 6:
          this.tileHi = this.read(this.bgPatternAddr() + 8);
          break;
        case 7:
          this.incX();
          break;
      }
    }
    if (dot === 256) this.incY();
    else if (dot === 257) {
      this.loadShifters();
      this.v = (this.v & ~0x041f) | (this.t & 0x041f);
      this.oamAddr = 0;
    } else if (dot === 261) {
      // 実機はドット 257〜320 で 8 個分のスプライトのパターンを読む。最初のパターン読み出しが 261 あたり
      this.mapper.ppuSpriteFetch?.(true, (this.ctrl & 0x20) !== 0);
      if (visible) this.evaluateSprites(sl);
      else {
        this.clearSprites();
        this.dummySpriteFetches(0);
      }
      this.mapper.ppuSpriteFetch?.(false, (this.ctrl & 0x20) !== 0);
    }
    if (sl === 261 && dot >= 280 && dot <= 304) {
      this.v = (this.v & ~0x7be0) | (this.t & 0x7be0);
    }
  }

  private bgPatternAddr(): number {
    return (this.ctrl & 0x10 ? 0x1000 : 0) + this.ntByte * 16 + ((this.v >> 12) & 7);
  }

  // 実機のシフトレジスタは毎ドット 1 ビットずつ送られるが、ここでは送らずに置いておき、
  // 読み込みのたびに 8 ビットまとめて送る。何ビット目を出すかは outputPixel でドットから計算する
  private loadShifters(): void {
    this.patLo = ((this.patLo << 8) | this.tileLo) & 0xffff;
    this.patHi = ((this.patHi << 8) | this.tileHi) & 0xffff;
    this.attrLo = ((this.attrLo << 8) | (this.atBits & 1 ? 0xff : 0)) & 0xffff;
    this.attrHi = ((this.attrHi << 8) | (this.atBits & 2 ? 0xff : 0)) & 0xffff;
  }

  private clearSprites(): void {
    this.sprColor.fill(0);
    this.sprBehind.fill(0);
    this.sprZero.fill(0);
  }

  /** 走査線 sl の時点で、次の走査線に描くスプライトを並べる（スプライトの Y は 1 ライン遅れて出る） */
  private evaluateSprites(sl: number): void {
    this.clearSprites();
    const tall = (this.ctrl & 0x20) !== 0;
    const h = tall ? 16 : 8;
    let count = 0;
    for (let i = 0; i < 64; i++) {
      const y = this.oam[i * 4];
      const row0 = sl - y;
      if (row0 < 0 || row0 >= h) continue;
      if (count === 8) {
        this.status |= 0x20;
        break;
      }
      count++;
      const tile = this.oam[i * 4 + 1];
      const attr = this.oam[i * 4 + 2];
      const sx = this.oam[i * 4 + 3];
      const row = attr & 0x80 ? h - 1 - row0 : row0;
      let addr: number;
      if (tall) addr = ((tile & 1) << 12) + ((tile & 0xfe) + (row >> 3)) * 16 + (row & 7);
      else addr = (this.ctrl & 0x08 ? 0x1000 : 0) + tile * 16 + row;
      const lo = this.read(addr);
      const hi = this.read(addr + 8);
      const pal = 0x10 | ((attr & 3) << 2);
      for (let px = 0; px < 8; px++) {
        const x = sx + px;
        if (x > 255) break;
        if (this.sprColor[x]) continue; // OAM で前にあるスプライトが優先
        const bit = attr & 0x40 ? px : 7 - px;
        const c = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        if (!c) continue;
        this.sprColor[x] = pal | c;
        this.sprBehind[x] = (attr >> 5) & 1;
        if (i === 0) this.sprZero[x] = 1;
      }
    }
    this.dummySpriteFetches(count);
  }

  /**
   * 空いているスプライトの枠でも、実機はタイル $FF のパターンを読む。
   * 読むアドレスで MMC3 の IRQ カウンタが進むので、データは使わないが読んでおく
   */
  private dummySpriteFetches(used: number): void {
    const addr = this.ctrl & 0x20 ? 0x1000 + 0xfe * 16 : (this.ctrl & 0x08 ? 0x1000 : 0) + 0xff * 16;
    for (let i = used; i < 8; i++) {
      this.read(addr);
      this.read(addr + 8);
    }
  }

  private outputPixel(sl: number, x: number): void {
    const mask = this.mask;
    let color = 0;
    if (mask & 0x18) {
      let bg = 0;
      if (mask & 0x08 && (x >= 8 || mask & 0x02)) {
        // 最後の読み込みから (x & 7) ドット分送られているはず
        const bit = 0x8000 >> (this.x + (x & 7));
        const p = (this.patLo & bit ? 1 : 0) | (this.patHi & bit ? 2 : 0);
        if (p) bg = ((this.attrLo & bit ? 1 : 0) | (this.attrHi & bit ? 2 : 0)) * 4 + p;
      }
      let spr = 0;
      if (mask & 0x10 && (x >= 8 || mask & 0x04)) spr = this.sprColor[x];
      if (bg && spr) {
        if (this.sprZero[x] && x !== 255) this.status |= 0x40;
        color = this.sprBehind[x] ? bg : spr;
      } else color = bg || spr;
    } else if ((this.v & 0x3f00) === 0x3f00) {
      // 描画オフで v がパレットを指しているときはその色が出る
      color = this.v & 0x1f;
    }
    this.frameBuffer[sl * SCREEN_W + x] = NES_ABGR[this.palette[paletteIndex(color)] & this.greyMask()];
  }
}

function paletteIndex(addr: number): number {
  const a = addr & 0x1f;
  // $3F10/$14/$18/$1C は $3F00/$04/$08/$0C のミラー
  return (a & 0x13) === 0x10 ? a & 0x0f : a;
}
