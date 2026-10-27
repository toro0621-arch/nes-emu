import type { Cartridge, Mirroring } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';

const MIRRORS: Mirroring[] = ['single0', 'single1', 'vertical', 'horizontal'];

// MMC1（SxROM）：1 ビットずつ 5 回書いてレジスタを設定する
export class Mapper1 extends BaseMapper {
  private shift = 0;
  private count = 0;
  private control = 0x0c;
  private chr0 = 0;
  private chr1 = 0;
  private prgBank = 0;
  private lastWriteCycle = -10;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.update();
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) {
      super.cpuWrite(addr, v);
      return;
    }
    // INC などの読み・変更・書き命令は 2 回続けて書くが、MMC1 は続けての 2 回目を無視する
    const cycle = this.host.cpuCycles();
    const consecutive = cycle - this.lastWriteCycle <= 1;
    this.lastWriteCycle = cycle;
    if (consecutive) return;

    if (v & 0x80) {
      this.shift = 0;
      this.count = 0;
      this.control |= 0x0c;
      this.update();
      return;
    }
    this.shift |= (v & 1) << this.count;
    if (++this.count < 5) return;

    const value = this.shift;
    this.shift = 0;
    this.count = 0;
    switch ((addr >> 13) & 3) {
      case 0:
        this.control = value;
        break;
      case 1:
        this.chr0 = value;
        break;
      case 2:
        this.chr1 = value;
        break;
      case 3:
        this.prgBank = value;
        break;
    }
    this.update();
  }

  private update(): void {
    if (this.cart.mirroring !== 'four') this.mirror = MIRRORS[this.control & 3];

    // 512KB の SUROM は、CHR レジスタの bit4 で PRG の前半・後半 256KB を選ぶ
    const outer = this.prg.length > 0x40000 ? this.chr0 & 0x10 : 0;
    const bank = (this.prgBank & 0x0f) | outer;
    switch ((this.control >> 2) & 3) {
      case 0:
      case 1: // 32KB 単位
        this.setPrg16k(0, bank & ~1);
        this.setPrg16k(2, bank | 1);
        break;
      case 2: // $8000 は先頭に固定、$C000 を切り替え
        this.setPrg16k(0, outer);
        this.setPrg16k(2, bank);
        break;
      case 3: // $8000 を切り替え、$C000 は最後に固定
        this.setPrg16k(0, bank);
        this.setPrg16k(2, outer | 0x0f);
        break;
    }

    if (this.control & 0x10) {
      this.setChr4k(0, this.chr0);
      this.setChr4k(4, this.chr1);
    } else {
      this.setChr4k(0, this.chr0 & ~1);
      this.setChr4k(4, this.chr0 | 1);
    }
  }
}
