import type { Cartridge } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';

// UxROM：$8000-$BFFF を 16KB 単位で切り替え、$C000-$FFFF は最後のバンクに固定。CHR は 8KB（たいてい RAM）
export class Mapper2 extends BaseMapper {
  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg16k(0, 0);
    this.setPrg16k(2, -1);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr >= 0x8000) this.setPrg16k(0, v);
    else super.cpuWrite(addr, v);
  }
}
