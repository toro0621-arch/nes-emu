import { NesBus } from './bus';
import { parseINes, type Cartridge } from './cartridge';
import { Cpu } from './cpu';
import { createMapper, type Mapper } from './mappers/mapper';
import { Ppu } from './ppu';

export class Nes {
  cart: Cartridge;
  mapper: Mapper;
  cpu: Cpu;
  ppu: Ppu;
  bus: NesBus;

  constructor(rom: Uint8Array) {
    this.cart = parseINes(rom);
    this.mapper = createMapper(this.cart);
    this.ppu = new Ppu(this.mapper);
    this.bus = new NesBus(this.mapper, this.ppu);
    this.cpu = new Cpu(this.bus);
    this.bus.cpu = this.cpu;
    this.cpu.powerOn();
  }

  reset(): void {
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
