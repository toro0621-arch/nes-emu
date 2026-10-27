import type { Cartridge, Mirroring } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';
import { MIRROR_VH1S } from './discrete';

// コナミ VRC シリーズ

/** VRC4・VRC6・VRC7 共通の IRQ（走査線か CPU サイクルで数える） */
export class VrcIrq {
  private latch = 0;
  private counter = 0;
  private prescaler = 341;
  private enabled = false;
  private enableAfterAck = false;
  private cycleMode = false;

  constructor(private host: MapperHost) {}

  writeLatch(v: number): void {
    this.latch = v & 0xff;
  }
  writeLatchLow(v: number): void {
    this.latch = (this.latch & 0xf0) | (v & 0x0f);
  }
  writeLatchHigh(v: number): void {
    this.latch = (this.latch & 0x0f) | ((v & 0x0f) << 4);
  }

  writeControl(v: number): void {
    this.enableAfterAck = (v & 1) !== 0;
    this.enabled = (v & 2) !== 0;
    this.cycleMode = (v & 4) !== 0;
    if (this.enabled) {
      this.counter = this.latch;
      this.prescaler = 341;
    }
    this.host.irq(false);
  }

  ack(): void {
    this.enabled = this.enableAfterAck;
    this.host.irq(false);
  }

  clock(): void {
    if (!this.enabled) return;
    if (!this.cycleMode) {
      // 走査線モード：CPU 1 サイクル = PPU 3 ドット。341 ドットで 1 回
      this.prescaler -= 3;
      if (this.prescaler > 0) return;
      this.prescaler += 341;
    }
    if (this.counter === 0xff) {
      this.counter = this.latch;
      this.host.irq(true);
    } else this.counter++;
  }
}

/**
 * VRC2・VRC4（21・22・23・25）。カートリッジによってレジスタのアドレス線のつなぎ方が違うので、
 * 同じマッパー番号の中のつなぎ方を両方受け付ける
 */
export class Vrc24 extends BaseMapper {
  private prg0 = 0;
  private prg1 = 0;
  private swap = false;
  private chrRegs = new Array<number>(8).fill(0);
  private irq: VrcIrq;
  /** [A0 にあたるアドレスのビット, A1 にあたるビット] */
  private lines: [number, number][];
  private readonly vrc2a: boolean;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.irq = new VrcIrq(host);
    this.vrc2a = cart.mapper === 22;
    switch (cart.mapper) {
      case 21:
        this.lines = [
          [0x02, 0x04],
          [0x40, 0x80],
        ];
        break;
      case 22:
        this.lines = [[0x02, 0x01]];
        break;
      case 23:
        this.lines = [
          [0x01, 0x02],
          [0x04, 0x08],
        ];
        break;
      default: // 25
        this.lines = [
          [0x02, 0x01],
          [0x08, 0x04],
        ];
    }
    this.update();
  }

  private reg(addr: number): number {
    let r = 0;
    for (const [a0, a1] of this.lines) {
      if (addr & a0) r |= 1;
      if (addr & a1) r |= 2;
    }
    return r;
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    const r = this.reg(addr);
    switch (addr & 0xf000) {
      case 0x8000:
        this.prg0 = v & 0x1f;
        break;
      case 0x9000:
        if (this.vrc2a || this.cart.mapper === 23 && !this.isVrc4()) {
          this.mirror = v & 1 ? 'horizontal' : 'vertical';
        } else if (r === 0) this.mirror = MIRROR_VH1S[v & 3];
        else if (r === 2) this.swap = (v & 2) !== 0;
        break;
      case 0xa000:
        this.prg1 = v & 0x1f;
        break;
      case 0xb000:
      case 0xc000:
      case 0xd000:
      case 0xe000: {
        const i = (((addr >> 12) - 0xb) << 1) | (r >> 1);
        if (r & 1) this.chrRegs[i] = (this.chrRegs[i] & 0x0f) | ((v & 0x1f) << 4);
        else this.chrRegs[i] = (this.chrRegs[i] & 0x1f0) | (v & 0x0f);
        break;
      }
      case 0xf000:
        if (r === 0) this.irq.writeLatchLow(v);
        else if (r === 1) this.irq.writeLatchHigh(v);
        else if (r === 2) this.irq.writeControl(v);
        else this.irq.ack();
        break;
    }
    this.update();
  }

  /** マッパー 23 には VRC2b と VRC4e がある。VRC4 は PRG が 256KB まで、VRC2 は 128KB まで */
  private isVrc4(): boolean {
    return this.prg.length > 0x20000 || this.cart.submapper === 2;
  }

  private update(): void {
    if (this.swap) {
      this.setPrg8k(0, -2);
      this.setPrg8k(2, this.prg0);
    } else {
      this.setPrg8k(0, this.prg0);
      this.setPrg8k(2, -2);
    }
    this.setPrg8k(1, this.prg1);
    this.setPrg8k(3, -1);
    for (let i = 0; i < 8; i++) this.setChr1k(i, this.vrc2a ? this.chrRegs[i] >> 1 : this.chrRegs[i]);
  }

  cpuClock(): void {
    this.irq.clock();
  }
}

/** VRC1（75、がんばれゴエモン！からくり道中 など） */
export class Mapper75 extends BaseMapper {
  private chrSel = [0, 0];

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg8k(3, -1);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    switch (addr & 0xf000) {
      case 0x8000:
        this.setPrg8k(0, v & 0x0f);
        break;
      case 0x9000:
        if (this.cart.mirroring !== 'four') this.mirror = v & 1 ? 'horizontal' : 'vertical';
        this.chrSel[0] = (this.chrSel[0] & 0x0f) | ((v & 2) << 3);
        this.chrSel[1] = (this.chrSel[1] & 0x0f) | ((v & 4) << 2);
        break;
      case 0xa000:
        this.setPrg8k(1, v & 0x0f);
        break;
      case 0xc000:
        this.setPrg8k(2, v & 0x0f);
        break;
      case 0xe000:
        this.chrSel[0] = (this.chrSel[0] & 0x10) | (v & 0x0f);
        break;
      case 0xf000:
        this.chrSel[1] = (this.chrSel[1] & 0x10) | (v & 0x0f);
        break;
    }
    this.setChr4k(0, this.chrSel[0]);
    this.setChr4k(4, this.chrSel[1]);
  }
}

/** VRC3（73、沙羅曼蛇）：16 ビットの CPU サイクル IRQ */
export class Mapper73 extends BaseMapper {
  private latch = 0;
  private counter = 0;
  private enabled = false;
  private enableAfterAck = false;
  private mode8 = false;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg16k(0, 0);
    this.setPrg16k(2, -1);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    const shift = ((addr >> 12) - 8) * 4; // $8000〜$B000 で 4 ビットずつ
    switch (addr & 0xf000) {
      case 0x8000:
      case 0x9000:
      case 0xa000:
      case 0xb000:
        this.latch = (this.latch & ~(0xf << shift)) | ((v & 0xf) << shift);
        break;
      case 0xc000:
        this.enableAfterAck = (v & 1) !== 0;
        this.enabled = (v & 2) !== 0;
        this.mode8 = (v & 4) !== 0;
        if (this.enabled) this.counter = this.latch;
        this.host.irq(false);
        break;
      case 0xd000:
        this.enabled = this.enableAfterAck;
        this.host.irq(false);
        break;
      case 0xf000:
        this.setPrg16k(0, v & 7);
        break;
    }
  }

  cpuClock(): void {
    if (!this.enabled) return;
    if (this.mode8) {
      const lo = (this.counter + 1) & 0xff;
      if (lo === 0) {
        this.counter = (this.counter & 0xff00) | (this.latch & 0xff);
        this.host.irq(true);
      } else this.counter = (this.counter & 0xff00) | lo;
    } else if (this.counter === 0xffff) {
      this.counter = this.latch;
      this.host.irq(true);
    } else this.counter++;
  }
}

/** VRC7（85、ラグランジュポイント・タイニートゥーン2）。FM 音源は鳴らさない */
export class Mapper85 extends BaseMapper {
  private irq: VrcIrq;
  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.irq = new VrcIrq(host);
    this.setPrg8k(3, -1);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    // VRC7a は A4、VRC7b は A3 で同じ $x000 の中の 2 つのレジスタを分ける
    const hi = (addr & 0x18) !== 0 ? 1 : 0;
    switch (addr & 0xf000) {
      case 0x8000:
        this.setPrg8k(hi, v & 0x3f);
        break;
      case 0x9000:
        if (!hi) this.setPrg8k(2, v & 0x3f);
        break;
      case 0xa000:
      case 0xb000:
      case 0xc000:
      case 0xd000:
        this.setChr1k(((addr >> 12) - 0xa) * 2 + hi, v);
        break;
      case 0xe000:
        if (hi) this.irq.writeLatch(v);
        else this.mirror = MIRROR_VH1S[v & 3];
        break;
      case 0xf000:
        if (hi) this.irq.ack();
        else this.irq.writeControl(v);
        break;
    }
  }

  cpuClock(): void {
    this.irq.clock();
  }
}

// ---- VRC6（24・26、悪魔城伝説・魍魎戦記MADARA・エスパードリーム2）と拡張音源 ----

class Vrc6Pulse {
  volume = 0;
  duty = 0;
  constant = false;
  period = 0;
  enabled = false;
  private timer = 0;
  private step = 15;

  write(reg: number, v: number): void {
    if (reg === 0) {
      this.volume = v & 0x0f;
      this.duty = (v >> 4) & 7;
      this.constant = (v & 0x80) !== 0;
    } else if (reg === 1) this.period = (this.period & 0xf00) | v;
    else {
      this.period = (this.period & 0xff) | ((v & 0x0f) << 8);
      this.enabled = (v & 0x80) !== 0;
      if (!this.enabled) this.step = 15;
    }
  }

  clock(shift: number): void {
    if (!this.enabled) return;
    if (this.timer > 0) this.timer--;
    else {
      this.timer = this.period >> shift;
      this.step = (this.step - 1) & 15;
    }
  }

  output(): number {
    if (!this.enabled) return 0;
    return this.constant || this.step <= this.duty ? this.volume : 0;
  }
}

class Vrc6Saw {
  rate = 0;
  period = 0;
  enabled = false;
  private timer = 0;
  private step = 0;
  private acc = 0;

  write(reg: number, v: number): void {
    if (reg === 0) this.rate = v & 0x3f;
    else if (reg === 1) this.period = (this.period & 0xf00) | v;
    else {
      this.period = (this.period & 0xff) | ((v & 0x0f) << 8);
      this.enabled = (v & 0x80) !== 0;
      if (!this.enabled) this.acc = this.step = 0;
    }
  }

  clock(shift: number): void {
    if (!this.enabled) return;
    if (this.timer > 0) {
      this.timer--;
      return;
    }
    this.timer = this.period >> shift;
    // 2 回に 1 回 rate を足し、7 回足したら（14 ステップで）0 に戻る
    this.step++;
    if (this.step >= 14) this.acc = this.step = 0;
    else if ((this.step & 1) === 0) this.acc = (this.acc + this.rate) & 0xff;
  }

  output(): number {
    return this.enabled ? this.acc >> 3 : 0;
  }
}

export class Mapper24 extends BaseMapper {
  private irq: VrcIrq;
  private chrRegs = new Array<number>(8).fill(0);
  private bankMode = 0;
  private pulse1 = new Vrc6Pulse();
  private pulse2 = new Vrc6Pulse();
  private saw = new Vrc6Saw();
  private halt = false;
  private shift = 0;
  private readonly swapLines: boolean;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.irq = new VrcIrq(host);
    this.swapLines = cart.mapper === 26;
    this.setPrg16k(0, 0);
    this.setPrg8k(2, 0);
    this.setPrg8k(3, -1);
    this.updateChr();
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    let r = addr & 3;
    if (this.swapLines) r = ((r & 1) << 1) | (r >> 1);
    switch (addr & 0xf000) {
      case 0x8000:
        this.setPrg16k(0, v & 0x0f);
        break;
      case 0x9000:
        if (r === 3) {
          this.halt = (v & 1) !== 0;
          this.shift = v & 4 ? 8 : v & 2 ? 4 : 0;
        } else this.pulse1.write(r, v);
        break;
      case 0xa000:
        if (r < 3) this.pulse2.write(r, v);
        break;
      case 0xb000:
        if (r < 3) this.saw.write(r, v);
        else {
          this.bankMode = v;
          this.updateChr();
        }
        break;
      case 0xc000:
        this.setPrg8k(2, v & 0x1f);
        break;
      case 0xd000:
      case 0xe000:
        this.chrRegs[((addr >> 12) - 0xd) * 4 + r] = v;
        this.updateChr();
        break;
      case 0xf000:
        if (r === 0) this.irq.writeLatch(v);
        else if (r === 1) this.irq.writeControl(v);
        else if (r === 2) this.irq.ack();
        break;
    }
  }

  private updateChr(): void {
    const r = this.chrRegs;
    switch (this.bankMode & 3) {
      case 0:
        for (let i = 0; i < 8; i++) this.setChr1k(i, r[i]);
        break;
      case 1:
        for (let i = 0; i < 4; i++) this.setChr2k(i * 2, r[i]);
        break;
      default:
        for (let i = 0; i < 4; i++) this.setChr1k(i, r[i]);
        this.setChr2k(4, r[4]);
        this.setChr2k(6, r[5]);
    }
    const mirrors: Mirroring[] = ['vertical', 'horizontal', 'single0', 'single1'];
    this.mirror = mirrors[(this.bankMode >> 2) & 3];
  }

  cpuClock(): void {
    this.irq.clock();
    if (this.halt) return;
    this.pulse1.clock(this.shift);
    this.pulse2.clock(this.shift);
    this.saw.clock(this.shift);
  }

  audioOut(): number {
    // 0〜61 の合計を、APU の矩形波 1 つと同じくらいの大きさに合わせる
    return (this.pulse1.output() + this.pulse2.output() + this.saw.output()) * 0.0075;
  }
}
