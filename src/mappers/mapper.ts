import type { Cartridge, Mirroring } from '../cartridge';
import { Mapper0 } from './mapper0';

export interface Mapper {
  /** CPU $4020-$FFFF */
  cpuRead(addr: number): number;
  cpuWrite(addr: number, v: number): void;
  /** PPU $0000-$1FFF（パターンテーブル） */
  ppuRead(addr: number): number;
  ppuWrite(addr: number, v: number): void;
  mirroring(): Mirroring;
}

export function createMapper(cart: Cartridge): Mapper {
  switch (cart.mapper) {
    case 0:
      return new Mapper0(cart);
    default:
      throw new Error(`マッパー ${cart.mapper} には未対応です`);
  }
}
