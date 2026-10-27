import { Pulse } from '../apu';
import type { Cartridge } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';

// MMC5（5、光栄のシミュレーション・ジャストブリード・メタルスレイダーグローリー など）
// PRG・CHR の細かい切り替え、拡張 RAM（ネームテーブル・拡張属性）、走査線 IRQ、掛け算器、矩形波 2 つ + PCM
export class Mapper5 extends BaseMapper {
  private ciram: Uint8Array = new Uint8Array(0x800);
  private exram = new Uint8Array(0x400);
  private prgMode = 3;
  private chrMode = 0;
  private exramMode = 0;
  private ntMap = 0;
  private fillTile = 0;
  private fillAttr = 0;
  private prgRegs = [0, 0, 0, 0, 0xff]; // $5113〜$5117
  private ramProtect = [0, 0];
  private chrA = new Array<number>(8).fill(0); // $5120〜$5127（8×16 のスプライト用）
  private chrB = new Array<number>(4).fill(0); // $5128〜$512B（8×16 の背景用）
  private chrUpper = 0;
  private lastSetB = false;
  private mulA = 0xff;
  private mulB = 0xff;
  // IRQ
  private irqTarget = 0;
  private irqEnabled = false;
  private irqPending = false;
  private inFrame = false;
  private scanline = 0;
  // PPU の状態
  private spriteFetch = false;
  private tall = false;
  private rendering = false;
  /** 拡張属性モードで、今読んでいるタイルの拡張 RAM の値 */
  private exTile = 0;
  // 音源
  private pulse1 = new Pulse(false, true);
  private pulse2 = new Pulse(false, true);
  private pcm = 0;
  private frameDiv = 0;
  private apuOdd = false;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.prgRam = new Uint8Array(0x10000); // 64KB（ソフトによって使うのは 8〜32KB）
    this.updatePrg();
  }

  attachCiram(ciram: Uint8Array): void {
    this.ciram = ciram;
  }

  // ---- CPU ----
  /** $6000〜$FFFF の 8KB ごとの割り当て（ROM か RAM か、どのバンクか） */
  private prgMap: { rom: boolean; offset: number }[] = [];

  private updatePrg(): void {
    const r = this.prgRegs;
    const map: { rom: boolean; offset: number }[] = [];
    const ram = (bank: number) => ({ rom: false, offset: (bank & 7) << 13 });
    const rom = (bank: number) => {
      const n = this.prgBanks8k;
      return { rom: true, offset: (((bank & 0x7f) % n) << 13) };
    };
    const pick = (reg: number, bank: number) => (reg & 0x80 ? rom(bank) : ram(bank));
    map[0] = ram(r[0]); // $6000
    switch (this.prgMode) {
      case 0: {
        const b = r[4] & 0x7c;
        for (let i = 0; i < 4; i++) map[1 + i] = rom(b + i);
        break;
      }
      case 1: {
        const b1 = r[2] & 0x7e;
        map[1] = pick(r[2], b1);
        map[2] = pick(r[2], b1 + 1);
        const b2 = r[4] & 0x7e;
        map[3] = rom(b2);
        map[4] = rom(b2 + 1);
        break;
      }
      case 2: {
        const b1 = r[2] & 0x7e;
        map[1] = pick(r[2], b1);
        map[2] = pick(r[2], b1 + 1);
        map[3] = pick(r[3], r[3]);
        map[4] = rom(r[4]);
        break;
      }
      default:
        map[1] = pick(r[1], r[1]);
        map[2] = pick(r[2], r[2]);
        map[3] = pick(r[3], r[3]);
        map[4] = rom(r[4]);
    }
    this.prgMap = map;
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000) {
      const m = this.prgMap[(addr - 0x6000) >> 13];
      return m.rom ? this.prg[m.offset + (addr & 0x1fff)] : this.prgRam[m.offset + (addr & 0x1fff)];
    }
    if (addr >= 0x5c00) return this.exramMode >= 2 ? this.exram[addr - 0x5c00] : 0;
    switch (addr) {
      case 0x5204: {
        const v = (this.irqPending ? 0x80 : 0) | (this.inFrame ? 0x40 : 0);
        this.irqPending = false;
        this.host.irq(false);
        return v;
      }
      case 0x5205:
        return (this.mulA * this.mulB) & 0xff;
      case 0x5206:
        return ((this.mulA * this.mulB) >> 8) & 0xff;
      case 0x5015:
        return (this.pulse1.length > 0 ? 1 : 0) | (this.pulse2.length > 0 ? 2 : 0);
    }
    return 0;
  }

  cpuWrite(addr: number, v: number): void {
    if (addr >= 0x6000) {
      const m = this.prgMap[(addr - 0x6000) >> 13];
      if (!m.rom && this.ramProtect[0] === 2 && this.ramProtect[1] === 1) {
        this.prgRam[m.offset + (addr & 0x1fff)] = v;
        this.saveDirty = true;
      }
      return;
    }
    if (addr >= 0x5c00) {
      // 拡張 RAM：モード 0・1 は描画中だけ書ける（それ以外は 0 が書かれる）、モード 2 はいつでも、3 は読み出し専用
      if (this.exramMode === 3) return;
      this.exram[addr - 0x5c00] = this.exramMode === 2 || this.inFrame ? v : 0;
      return;
    }
    if (addr >= 0x5000 && addr <= 0x5007) {
      if ((addr & 3) === 1) return; // スイープはない
      (addr < 0x5004 ? this.pulse1 : this.pulse2).write(addr & 3, v);
      return;
    }
    switch (addr) {
      case 0x5011:
        this.pcm = v;
        return;
      case 0x5015:
        this.pulse1.enabled = (v & 1) !== 0;
        this.pulse2.enabled = (v & 2) !== 0;
        if (!this.pulse1.enabled) this.pulse1.length = 0;
        if (!this.pulse2.enabled) this.pulse2.length = 0;
        return;
      case 0x5100:
        this.prgMode = v & 3;
        this.updatePrg();
        return;
      case 0x5101:
        this.chrMode = v & 3;
        return;
      case 0x5102:
        this.ramProtect[0] = v & 3;
        return;
      case 0x5103:
        this.ramProtect[1] = v & 3;
        return;
      case 0x5104:
        this.exramMode = v & 3;
        return;
      case 0x5105:
        this.ntMap = v;
        return;
      case 0x5106:
        this.fillTile = v;
        return;
      case 0x5107:
        this.fillAttr = v & 3;
        return;
      case 0x5130:
        this.chrUpper = v & 3;
        return;
      case 0x5203:
        this.irqTarget = v;
        return;
      case 0x5204:
        this.irqEnabled = (v & 0x80) !== 0;
        this.host.irq(this.irqEnabled && this.irqPending);
        return;
      case 0x5205:
        this.mulA = v;
        return;
      case 0x5206:
        this.mulB = v;
        return;
    }
    if (addr >= 0x5113 && addr <= 0x5117) {
      this.prgRegs[addr - 0x5113] = v;
      this.updatePrg();
    } else if (addr >= 0x5120 && addr <= 0x5127) {
      this.chrA[addr - 0x5120] = v | (this.chrUpper << 8);
      this.lastSetB = false;
    } else if (addr >= 0x5128 && addr <= 0x512b) {
      this.chrB[addr - 0x5128] = v | (this.chrUpper << 8);
      this.lastSetB = true;
    }
  }

  // ---- PPU ----
  ppuSpriteFetch(on: boolean, tall: boolean): void {
    this.spriteFetch = on;
    this.tall = tall;
  }

  ppuScanline(sl: number, rendering: boolean): void {
    this.rendering = rendering && (sl < 240 || sl === 261);
    if (!rendering || sl >= 240) {
      if (sl === 240 || !rendering) this.inFrame = false;
      return;
    }
    if (!this.inFrame) {
      this.inFrame = true;
      this.scanline = 0;
    } else this.scanline++;
    if (this.scanline === this.irqTarget && this.irqTarget !== 0) {
      this.irqPending = true;
      if (this.irqEnabled) this.host.irq(true);
    }
  }

  /** 1KB の CHR バンク番号（ページの大きさはモードで変わる） */
  private chrBank(addr: number): number {
    const slot = addr >> 10;
    const useA = this.tall ? this.spriteFetch || !this.rendering && !this.lastSetB : !this.lastSetB;
    if (useA) {
      const r = this.chrA;
      switch (this.chrMode) {
        case 0:
          return r[7] * 8 + slot;
        case 1:
          return r[slot < 4 ? 3 : 7] * 4 + (slot & 3);
        case 2:
          return r[(slot >> 1) * 2 + 1] * 2 + (slot & 1);
        default:
          return r[slot];
      }
    }
    const r = this.chrB;
    switch (this.chrMode) {
      case 0:
        return r[3] * 8 + slot;
      case 1:
        return r[3] * 4 + (slot & 3);
      case 2:
        return r[(slot & 2) | 1] * 2 + (slot & 1);
      default:
        return r[slot & 3];
    }
  }

  ppuRead(addr: number): number {
    if (this.exramMode === 1 && this.rendering && !this.spriteFetch) {
      // 拡張属性：背景のタイルごとに 4KB のバンクを選ぶ
      const bank = (this.exTile & 0x3f) | (this.chrUpper << 6);
      return this.chr[((bank << 12) + (addr & 0xfff)) % this.chr.length];
    }
    const bank = this.chrBank(addr);
    return this.chr[((bank << 10) + (addr & 0x3ff)) % this.chr.length];
  }

  ppuWrite(addr: number, v: number): void {
    if (this.cart.chrRam) this.chr[((this.chrBank(addr) << 10) + (addr & 0x3ff)) % this.chr.length] = v;
  }

  ntRead(addr: number): number {
    const off = addr & 0x3ff;
    const isAttr = off >= 0x3c0;
    if (this.exramMode === 1 && this.rendering && !this.spriteFetch) {
      if (isAttr) {
        const pal = this.exTile >> 6;
        return pal | (pal << 2) | (pal << 4) | (pal << 6);
      }
      this.exTile = this.exram[off];
    }
    switch ((this.ntMap >> (((addr >> 10) & 3) * 2)) & 3) {
      case 0:
        return this.ciram[off];
      case 1:
        return this.ciram[0x400 + off];
      case 2:
        return this.exramMode <= 1 ? this.exram[off] : 0;
      default:
        if (isAttr) {
          const a = this.fillAttr;
          return a | (a << 2) | (a << 4) | (a << 6);
        }
        return this.fillTile;
    }
  }

  ntWrite(addr: number, v: number): void {
    const off = addr & 0x3ff;
    switch ((this.ntMap >> (((addr >> 10) & 3) * 2)) & 3) {
      case 0:
        this.ciram[off] = v;
        break;
      case 1:
        this.ciram[0x400 + off] = v;
        break;
      case 2:
        if (this.exramMode <= 1) this.exram[off] = v;
        break;
    }
  }

  // ---- 音源 ----
  cpuClock(): void {
    // 長さと音量の包絡線は 240Hz（CPU 7457 サイクルごと）
    if (++this.frameDiv >= 7457) {
      this.frameDiv = 0;
      for (const p of [this.pulse1, this.pulse2]) {
        p.env.clock();
        p.clockLength();
      }
    }
    this.apuOdd = !this.apuOdd;
    if (this.apuOdd) {
      this.pulse1.clockTimer();
      this.pulse2.clockTimer();
    }
  }

  audioOut(): number {
    return (this.pulse1.output() + this.pulse2.output()) * 0.0095 + this.pcm * 0.0012;
  }
}
