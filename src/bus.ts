import { Controller } from './controller';
import type { Cpu, CpuBus } from './cpu';
import type { Mapper } from './mappers/mapper';
import type { Ppu } from './ppu';

// CPU から見たメモリマップ。APU は後の段階でつなぐ
export class NesBus implements CpuBus {
  ram = new Uint8Array(0x800);
  cpu!: Cpu;
  pads = [new Controller(), new Controller()];

  constructor(
    public mapper: Mapper,
    public ppu: Ppu,
  ) {}

  read(addr: number): number {
    if (addr < 0x2000) return this.ram[addr & 0x7ff];
    if (addr < 0x4000) return this.ppu.readReg(addr);
    // 上位ビットはデータバスの残り（直前に読んだアドレスの上位バイト $40）が見える
    if (addr === 0x4016) return 0x40 | this.pads[0].read();
    if (addr === 0x4017) return 0x40 | this.pads[1].read();
    if (addr < 0x4020) return 0; // APU（未実装）
    return this.mapper.cpuRead(addr);
  }

  write(addr: number, v: number): void {
    if (addr < 0x2000) this.ram[addr & 0x7ff] = v;
    else if (addr < 0x4000) this.ppu.writeReg(addr, v);
    else if (addr === 0x4014) this.oamDma(v);
    else if (addr === 0x4016) {
      this.pads[0].write(v);
      this.pads[1].write(v);
    } else if (addr < 0x4020) return; // APU（未実装）
    else this.mapper.cpuWrite(addr, v);
  }

  // CPU 1 サイクル = PPU 3 ドット。CPU の読み書きは 2 ドット目のあとに起きる
  tick(cycles: number): void {
    const ppu = this.ppu;
    for (let i = 0; i < cycles; i++) {
      ppu.tick();
      ppu.tick();
      ppu.tick();
      this.sampleNmi();
    }
  }

  tickBeforeAccess(): void {
    this.ppu.tick();
    this.ppu.tick();
  }

  tickAfterAccess(): void {
    this.ppu.tick();
    this.sampleNmi();
  }

  /** CPU は NMI 線を各サイクルの終わりに見て、立ち上がりを覚える */
  private nmiLine = false;
  private sampleNmi(): void {
    const line = this.ppu.nmiOutput();
    if (line && !this.nmiLine) this.cpu.nmi();
    this.nmiLine = line;
  }

  /** $4014：CPU メモリの 1 ページを OAM へ。CPU は 513（奇数サイクルなら 514）サイクル止まる */
  private oamDma(page: number): void {
    const base = page << 8;
    for (let i = 0; i < 256; i++) this.ppu.dmaWrite(this.read(base + i));
    this.cpu.stall += 513 + (this.cpu.cycles & 1);
  }
}
