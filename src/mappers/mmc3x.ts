import type { Cartridge } from '../cartridge';
import type { MapperHost } from './base';
import { Mapper4 } from './mapper4';

/** TxSROM（118、アルマジロ・ゴール!!2 など）：CHR バンクのビット 7 でネームテーブルを選ぶ */
export class Mapper118 extends Mapper4 {
  private ciram: Uint8Array = new Uint8Array(0x800);

  attachCiram(ciram: Uint8Array): void {
    this.ciram = ciram;
  }

  private page(addr: number): number {
    return (this.chrBankNums[(addr >> 10) & 3] >> 7) & 1;
  }

  ntRead(addr: number): number {
    return this.ciram[this.page(addr) * 0x400 + (addr & 0x3ff)];
  }

  ntWrite(addr: number, v: number): void {
    this.ciram[this.page(addr) * 0x400 + (addr & 0x3ff)] = v;
  }
}

/** TQROM（119、ピンボット・ハイスピード）：CHR バンクのビット 6 で 8KB の CHR RAM を選ぶ */
export class Mapper119 extends Mapper4 {
  private chrRamBuf = new Uint8Array(0x2000);

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
  }

  ppuRead(addr: number): number {
    const b = this.chrBankNums[addr >> 10];
    if (b & 0x40) {
      super.ppuRead(addr); // IRQ のために A12 は見せる
      return this.chrRamBuf[((b & 7) << 10) | (addr & 0x3ff)];
    }
    return super.ppuRead(addr);
  }

  ppuWrite(addr: number, v: number): void {
    const b = this.chrBankNums[addr >> 10];
    if (b & 0x40) this.chrRamBuf[((b & 7) << 10) | (addr & 0x3ff)] = v;
    super.ppuWrite(addr, v);
  }
}
