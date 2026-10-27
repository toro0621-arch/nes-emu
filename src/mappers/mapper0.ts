import type { Cartridge } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';

// NROM：PRG 16KB（$C000 にミラー）または 32KB、CHR 8KB 固定
export class Mapper0 extends BaseMapper {
  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg16k(0, 0);
    this.setPrg16k(2, -1);
  }
}
