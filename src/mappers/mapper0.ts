import type { Cartridge, Mirroring } from '../cartridge';
import type { Mapper } from './mapper';

// NROM：PRG 16KB（$C000 にミラー）または 32KB、CHR 8KB 固定
export class Mapper0 implements Mapper {
  private prgRam = new Uint8Array(0x2000);
  private prgMask: number;

  constructor(private cart: Cartridge) {
    this.prgMask = cart.prg.length > 0x4000 ? 0x7fff : 0x3fff;
  }

  cpuRead(addr: number): number {
    if (addr >= 0x8000) return this.cart.prg[addr & this.prgMask];
    if (addr >= 0x6000) return this.prgRam[addr - 0x6000];
    return 0;
  }

  cpuWrite(addr: number, v: number): void {
    if (addr >= 0x6000 && addr < 0x8000) this.prgRam[addr - 0x6000] = v;
  }

  ppuRead(addr: number): number {
    return this.cart.chr[addr & 0x1fff];
  }

  ppuWrite(addr: number, v: number): void {
    if (this.cart.chrRam) this.cart.chr[addr & 0x1fff] = v;
  }

  mirroring(): Mirroring {
    return this.cart.mirroring;
  }
}
