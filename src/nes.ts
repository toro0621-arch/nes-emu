import { Apu } from './apu';
import { NesBus } from './bus';
import { parseINes, type Cartridge } from './cartridge';
import { Cpu } from './cpu';
import { createMapper, type Mapper } from './mappers/mapper';
import { Ppu } from './ppu';

const IRQ_MAPPER = 4;

export class Nes {
  cart: Cartridge;
  mapper: Mapper;
  cpu: Cpu;
  ppu: Ppu;
  apu: Apu;
  bus: NesBus;

  constructor(rom: Uint8Array) {
    this.cart = parseINes(rom);
    this.mapper = createMapper(this.cart, {
      irq: (on) => this.setIrq(IRQ_MAPPER, on),
      cpuCycles: () => this.cpu.cycles,
      ppuDots: () => this.ppu.dots,
    });
    this.ppu = new Ppu(this.mapper);
    this.bus = new NesBus(this.mapper, this.ppu);
    this.cpu = new Cpu(this.bus);
    this.apu = new Apu(
      (addr) => this.bus.read(addr),
      (cycles) => (this.cpu.stall += cycles),
      (source, on) => this.setIrq(source, on),
    );
    if (this.mapper.audioOut) {
      const m = this.mapper;
      this.apu.expansion = () => m.audioOut!();
    }
    this.bus.cpu = this.cpu;
    this.bus.apu = this.apu;
    this.cpu.powerOn();
  }

  /** IRQ 線は要因ごとのビットの OR（APU のフレーム・DMC、マッパー） */
  private setIrq(source: number, on: boolean): void {
    this.cpu.irqLine = on ? this.cpu.irqLine | source : this.cpu.irqLine & ~source;
  }

  reset(): void {
    this.apu.write(0x4015, 0); // リセットで音は止まる
    this.cpu.reset();
  }

  /** 次の VBlank まで動かす（1 フレーム分） */
  runFrame(): void {
    const ppu = this.ppu;
    ppu.frameReady = false;
    // 万一 PPU が止まっていても抜けられるよう、1 フレームの数倍で打ち切る
    for (let guard = 0; !ppu.frameReady && guard < 200000; guard++) this.cpu.step();
  }
}
