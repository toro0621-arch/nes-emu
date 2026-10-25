import type { CpuBus } from './cpu';
import type { Mapper } from './mappers/mapper';

// CPU から見たメモリマップ。PPU・APU・コントローラーは後の段階でつなぐ
export class NesBus implements CpuBus {
  ram = new Uint8Array(0x800);

  constructor(public mapper: Mapper) {}

  read(addr: number): number {
    if (addr < 0x2000) return this.ram[addr & 0x7ff];
    if (addr < 0x4000) return 0; // PPU レジスタ（未実装）
    if (addr < 0x4020) return 0; // APU・I/O（未実装）
    return this.mapper.cpuRead(addr);
  }

  write(addr: number, v: number): void {
    if (addr < 0x2000) this.ram[addr & 0x7ff] = v;
    else if (addr < 0x4020) return; // PPU・APU・I/O（未実装）
    else this.mapper.cpuWrite(addr, v);
  }
}
