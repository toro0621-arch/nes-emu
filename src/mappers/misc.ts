import type { Cartridge } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';
import { MIRROR_HV1S } from './discrete';

/** ジャレコ SS88006（18、忍者じゃじゃ丸 銀河大作戦・ジャストブリード以外のジャレコ後期作など） */
export class Mapper18 extends BaseMapper {
  private prgRegs = [0, 0, 0];
  private chrRegs = new Array<number>(8).fill(0);
  private reload = 0;
  private counter = 0;
  private enabled = false;
  private sizeMask = 0xffff;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.update();
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    const r = addr & 3;
    const nib = v & 0x0f;
    const hi = r & 1;
    switch (addr & 0xf000) {
      case 0x8000:
      case 0x9000: {
        const i = ((addr >> 12) - 8) * 2 + (r >> 1);
        if (i < 3) this.prgRegs[i] = setNibble(this.prgRegs[i], hi, nib);
        break;
      }
      case 0xa000:
      case 0xb000:
      case 0xc000:
      case 0xd000: {
        const i = ((addr >> 12) - 0xa) * 2 + (r >> 1);
        this.chrRegs[i] = setNibble(this.chrRegs[i], hi, nib);
        break;
      }
      case 0xe000:
        this.reload = (this.reload & ~(0xf << (r * 4))) | (nib << (r * 4));
        break;
      case 0xf000:
        if (r === 0) {
          this.counter = this.reload;
          this.host.irq(false);
        } else if (r === 1) {
          this.enabled = (v & 1) !== 0;
          this.sizeMask = v & 8 ? 0x0f : v & 4 ? 0xff : v & 2 ? 0xfff : 0xffff;
          this.host.irq(false);
        } else if (r === 2) this.mirror = MIRROR_HV1S[v & 3];
        break;
    }
    this.update();
  }

  private update(): void {
    for (let i = 0; i < 3; i++) this.setPrg8k(i, this.prgRegs[i]);
    this.setPrg8k(3, -1);
    for (let i = 0; i < 8; i++) this.setChr1k(i, this.chrRegs[i]);
  }

  cpuClock(): void {
    if (!this.enabled) return;
    const m = this.sizeMask;
    const low = ((this.counter & m) - 1) & m;
    this.counter = (this.counter & ~m) | low;
    if (low === 0) this.host.irq(true);
  }
}

function setNibble(reg: number, hi: number, nib: number): number {
  return hi ? (reg & 0x0f) | (nib << 4) : (reg & 0xf0) | nib;
}

/** アイレム G-101（32、イメージファイト・メジャーリーグ など） */
export class Mapper32 extends BaseMapper {
  private prg0 = 0;
  private prg1 = 1;
  private swap = false;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    if (cart.submapper === 1) this.mirror = 'single1';
    this.update();
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    switch (addr & 0xf000) {
      case 0x8000:
        this.prg0 = v & 0x1f;
        break;
      case 0x9000:
        if (this.cart.submapper !== 1) this.mirror = v & 1 ? 'horizontal' : 'vertical';
        this.swap = (v & 2) !== 0;
        break;
      case 0xa000:
        this.prg1 = v & 0x1f;
        break;
      case 0xb000:
        this.setChr1k(addr & 7, v);
        break;
    }
    this.update();
  }

  private update(): void {
    this.setPrg8k(this.swap ? 2 : 0, this.prg0);
    this.setPrg8k(this.swap ? 0 : 2, -2);
    this.setPrg8k(1, this.prg1);
    this.setPrg8k(3, -1);
  }
}

/** アイレム H3001（65、大工の源さん2・ダイ・ハード など） */
export class Mapper65 extends BaseMapper {
  private latch = 0;
  private counter = 0;
  private enabled = false;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg8k(0, 0);
    this.setPrg8k(1, 1);
    this.setPrg8k(2, -2);
    this.setPrg8k(3, -1);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    switch (addr & 0xf007) {
      case 0x8000:
        this.setPrg8k(0, v);
        break;
      case 0x9001:
        this.mirror = v & 0x80 ? 'horizontal' : 'vertical';
        break;
      case 0x9003:
        this.enabled = (v & 0x80) !== 0;
        this.host.irq(false);
        break;
      case 0x9004:
        this.counter = this.latch;
        this.host.irq(false);
        break;
      case 0x9005:
        this.latch = (this.latch & 0xff) | (v << 8);
        break;
      case 0x9006:
        this.latch = (this.latch & 0xff00) | v;
        break;
      case 0xa000:
        this.setPrg8k(1, v);
        break;
      case 0xc000:
        this.setPrg8k(2, v);
        break;
      default:
        if ((addr & 0xf000) === 0xb000) this.setChr1k(addr & 7, v);
    }
  }

  cpuClock(): void {
    if (!this.enabled || this.counter === 0) return;
    if (--this.counter === 0) {
      this.enabled = false;
      this.host.irq(true);
    }
  }
}

/** タイトー TC0190（33）・TC0690（48、IRQ 付き） */
export class Mapper33 extends BaseMapper {
  private readonly tc0690: boolean;
  private irqLatch = 0;
  private irqCounter = 0;
  private irqReload = false;
  private irqEnabled = false;
  private a12 = false;
  private a12LowSince = 0;
  /** IRQ は実機では少し遅れて出る */
  private irqDelay = 0;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.tc0690 = cart.mapper === 48;
    this.setPrg8k(2, -2);
    this.setPrg8k(3, -1);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    switch (addr & 0xe003) {
      case 0x8000:
        this.setPrg8k(0, v & 0x3f);
        if (!this.tc0690) this.mirror = v & 0x40 ? 'horizontal' : 'vertical';
        break;
      case 0x8001:
        this.setPrg8k(1, v & 0x3f);
        break;
      case 0x8002:
        this.setChr2k(0, v);
        break;
      case 0x8003:
        this.setChr2k(2, v);
        break;
      case 0xa000:
      case 0xa001:
      case 0xa002:
      case 0xa003:
        this.setChr1k(4 + (addr & 3), v);
        break;
      case 0xc000:
        this.irqLatch = (v ^ 0xff) & 0xff;
        break;
      case 0xc001:
        this.irqCounter = 0;
        this.irqReload = true;
        break;
      case 0xc002:
        this.irqEnabled = true;
        break;
      case 0xc003:
        this.irqEnabled = false;
        this.host.irq(false);
        break;
      case 0xe000:
        if (this.tc0690) this.mirror = v & 0x40 ? 'horizontal' : 'vertical';
        break;
    }
  }

  // TC0690 の IRQ は MMC3 と同じく A12 の立ち上がりで数える
  ppuRead(addr: number): number {
    if (this.tc0690) this.watchA12(addr);
    return super.ppuRead(addr);
  }

  ppuAddress(addr: number): void {
    if (this.tc0690) this.watchA12(addr);
  }

  private watchA12(addr: number): void {
    const high = (addr & 0x1000) !== 0;
    if (high && !this.a12) {
      if (this.host.ppuDots() - this.a12LowSince >= 10) this.clockIrq();
    } else if (!high && this.a12) this.a12LowSince = this.host.ppuDots();
    this.a12 = high;
  }

  private clockIrq(): void {
    if (this.irqCounter === 0 || this.irqReload) {
      this.irqCounter = this.irqLatch;
      this.irqReload = false;
    } else this.irqCounter--;
    if (this.irqCounter === 0 && this.irqEnabled) this.irqDelay = 7;
  }

  cpuClock(): void {
    if (this.irqDelay > 0 && --this.irqDelay === 0) this.host.irq(true);
  }
}

/** タイトー X1-005（80・207）：レジスタは $7EF0-$7EFF、128 バイトの RAM 付き */
export class Mapper80 extends BaseMapper {
  private ram = new Uint8Array(0x80);
  private ramOn = false;
  private ciram: Uint8Array = new Uint8Array(0x800);
  private ntPage = [0, 0];

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg8k(3, -1);
    if (cart.mapper === 207) {
      // 207（不動明王伝）：CHR レジスタのビット 7 でネームテーブルを選ぶ
      this.ntRead = (addr) => this.ciram[this.ntPage[(addr >> 11) & 1] * 0x400 + (addr & 0x3ff)];
      this.ntWrite = (addr, v) => {
        this.ciram[this.ntPage[(addr >> 11) & 1] * 0x400 + (addr & 0x3ff)] = v;
      };
    }
  }

  ntRead?: (addr: number) => number;
  ntWrite?: (addr: number, v: number) => void;

  attachCiram(ciram: Uint8Array): void {
    this.ciram = ciram;
  }

  get saveRam(): Uint8Array | null {
    return this.cart.battery ? this.ram : null;
  }

  cpuRead(addr: number): number {
    if (addr >= 0x7f00 && addr < 0x8000) return this.ramOn ? this.ram[addr & 0x7f] : 0xff;
    if (addr < 0x8000) return 0;
    return super.cpuRead(addr);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr >= 0x7f00 && addr < 0x8000) {
      if (this.ramOn) {
        this.ram[addr & 0x7f] = v;
        this.saveDirty = true;
      }
      return;
    }
    switch (addr) {
      case 0x7ef0:
      case 0x7ef1:
        this.setChr2k((addr & 1) * 2, (v & 0x7f) >> 1);
        this.ntPage[addr & 1] = v >> 7;
        break;
      case 0x7ef2:
      case 0x7ef3:
      case 0x7ef4:
      case 0x7ef5:
        this.setChr1k(4 + addr - 0x7ef2, v);
        break;
      case 0x7ef6:
      case 0x7ef7:
        if (this.cart.mapper === 80) this.mirror = v & 1 ? 'vertical' : 'horizontal';
        break;
      case 0x7ef8:
      case 0x7ef9:
        this.ramOn = v === 0xa3;
        break;
      case 0x7efa:
      case 0x7efb:
        this.setPrg8k(0, v);
        break;
      case 0x7efc:
      case 0x7efd:
        this.setPrg8k(1, v);
        break;
      case 0x7efe:
      case 0x7eff:
        this.setPrg8k(2, v);
        break;
    }
  }
}

/** タイトー X1-017（82、SD刑事ブレイダー など） */
export class Mapper82 extends BaseMapper {
  private chrRegs = [0, 0, 0, 0, 0, 0];
  private invert = false;
  private ram = new Uint8Array(0x1400);
  private ramOn = [false, false, false];

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg8k(3, -1);
    this.updateChr();
  }

  get saveRam(): Uint8Array | null {
    return this.cart.battery ? this.ram : null;
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x7400) {
      const block = addr < 0x6800 ? 0 : addr < 0x7000 ? 1 : 2;
      return this.ramOn[block] ? this.ram[addr - 0x6000] : 0;
    }
    if (addr < 0x8000) return 0;
    return super.cpuRead(addr);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr >= 0x6000 && addr < 0x7400) {
      const block = addr < 0x6800 ? 0 : addr < 0x7000 ? 1 : 2;
      if (this.ramOn[block]) {
        this.ram[addr - 0x6000] = v;
        this.saveDirty = true;
      }
      return;
    }
    if (addr >= 0x7ef0 && addr <= 0x7ef5) {
      this.chrRegs[addr - 0x7ef0] = v;
      this.updateChr();
    } else if (addr === 0x7ef6) {
      this.mirror = v & 1 ? 'vertical' : 'horizontal';
      this.invert = (v & 2) !== 0;
      this.updateChr();
    } else if (addr === 0x7ef7) this.ramOn[0] = v === 0xca;
    else if (addr === 0x7ef8) this.ramOn[1] = v === 0x69;
    else if (addr === 0x7ef9) this.ramOn[2] = v === 0x84;
    else if (addr >= 0x7efa && addr <= 0x7efc) this.setPrg8k(addr - 0x7efa, v >> 2);
  }

  private updateChr(): void {
    const r = this.chrRegs;
    const a = this.invert ? 4 : 0;
    const b = this.invert ? 0 : 4;
    this.setChr2k(a, r[0] >> 1);
    this.setChr2k(a + 2, r[1] >> 1);
    for (let i = 0; i < 4; i++) this.setChr1k(b + i, r[2 + i]);
  }
}
