import type { Cartridge } from '../cartridge';
import type { Mapper, MapperHost } from './base';
import { Mapper0 } from './mapper0';
import { Mapper1 } from './mapper1';
import { Mapper2 } from './mapper2';
import { Mapper4 } from './mapper4';

export type { Mapper, MapperHost } from './base';

export function createMapper(cart: Cartridge, host: MapperHost): Mapper {
  switch (cart.mapper) {
    case 0:
      return new Mapper0(cart, host);
    case 1:
      return new Mapper1(cart, host);
    case 2:
      return new Mapper2(cart, host);
    case 4:
      return new Mapper4(cart, host);
    default:
      throw new Error(`マッパー ${cart.mapper} には未対応です（対応：0・1・2・4）`);
  }
}
