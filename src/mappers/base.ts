import type { Cartridge, Mirroring } from '../cartridge';

/** マッパーが本体に求めるもの */
export interface MapperHost {
  /** マッパーの IRQ 線 */
  irq(on: boolean): void;
  /** CPU の累計サイクル（MMC1 の連続書き込みの判定用） */
  cpuCycles(): number;
  /** PPU の累計ドット（MMC3 の A12 の判定用） */
  ppuDots(): number;
}

export interface Mapper {
  /** CPU $4020-$FFFF */
  cpuRead(addr: number): number;
  cpuWrite(addr: number, v: number): void;
  /** PPU $0000-$1FFF（パターンテーブル）。PPU のアドレスバスに出たアドレスもここで見える */
  ppuRead(addr: number): number;
  ppuWrite(addr: number, v: number): void;
  /** パターンを読まずに PPU のアドレスバスが変わったとき（$2006 の書き込み） */
  ppuAddress?(addr: number): void;
  mirroring(): Mirroring;
  /** バッテリーで保存される RAM（なければ null） */
  readonly saveRam: Uint8Array | null;
  /** saveRam が書き換えられた（保存したら呼び出し側が false にする） */
  saveDirty: boolean;
}

/** 8KB 単位の PRG と 1KB 単位の CHR の切り替え表を持つ、マッパーの土台 */
export abstract class BaseMapper implements Mapper {
  protected prg: Uint8Array;
  protected chr: Uint8Array;
  protected prgRam = new Uint8Array(0x2000);
  /** $8000/$A000/$C000/$E000 の各 8KB が PRG ROM のどこを指すか */
  protected prgOffsets = [0, 0x2000, 0x4000, 0x6000];
  /** $0000-$1FFF の各 1KB が CHR のどこを指すか */
  protected chrOffsets = [0, 0x400, 0x800, 0xc00, 0x1000, 0x1400, 0x1800, 0x1c00];
  protected mirror: Mirroring;
  saveDirty = false;

  constructor(
    protected cart: Cartridge,
    protected host: MapperHost,
  ) {
    this.prg = cart.prg;
    this.chr = cart.chr;
    this.mirror = cart.mirroring;
  }

  get saveRam(): Uint8Array | null {
    return this.cart.battery ? this.prgRam : null;
  }

  protected get prgBanks8k(): number {
    return this.prg.length >> 13;
  }

  protected get chrBanks1k(): number {
    return this.chr.length >> 10;
  }

  /** 8KB の PRG バンクを slot（0〜3 = $8000〜$E000）に割り当てる。負の数は後ろから数える */
  protected setPrg8k(slot: number, bank: number): void {
    const n = this.prgBanks8k;
    this.prgOffsets[slot] = (((bank % n) + n) % n) << 13;
  }

  protected setPrg16k(slot: number, bank: number): void {
    this.setPrg8k(slot, bank * 2);
    this.setPrg8k(slot + 1, bank * 2 + 1);
  }

  protected setChr1k(slot: number, bank: number): void {
    this.chrOffsets[slot] = (bank % this.chrBanks1k) << 10;
  }

  protected setChr4k(slot: number, bank: number): void {
    for (let i = 0; i < 4; i++) this.setChr1k(slot + i, bank * 4 + i);
  }

  cpuRead(addr: number): number {
    if (addr >= 0x8000) return this.prg[this.prgOffsets[(addr >> 13) & 3] + (addr & 0x1fff)];
    if (addr >= 0x6000) return this.prgRam[addr & 0x1fff];
    return 0;
  }

  cpuWrite(addr: number, v: number): void {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.prgRam[addr & 0x1fff] = v;
      this.saveDirty = true;
    }
  }

  ppuRead(addr: number): number {
    return this.chr[this.chrOffsets[addr >> 10] + (addr & 0x3ff)];
  }

  ppuWrite(addr: number, v: number): void {
    if (this.cart.chrRam) this.chr[this.chrOffsets[addr >> 10] + (addr & 0x3ff)] = v;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }
}
