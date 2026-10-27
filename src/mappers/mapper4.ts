import type { Cartridge } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';

// MMC3（TxROM）：PRG 8KB×4・CHR 1KB/2KB 単位の切り替えと、走査線を数える IRQ。
// IRQ カウンタは PPU アドレスの A12 の立ち上がりで進む（描画中は 1 走査線に 1 回）
export class Mapper4 extends BaseMapper {
  private bankSelect = 0;
  private regs = [0, 2, 4, 5, 6, 7, 0, 1];
  private irqLatch = 0;
  private irqCounter = 0;
  private irqReload = false;
  private irqEnabled = false;
  private a12 = false;
  /** A12 が最後に 0 になった PPU ドット */
  private a12LowSince = 0;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.update();
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) {
      super.cpuWrite(addr, v);
      return;
    }
    const odd = addr & 1;
    switch (addr & 0xe000) {
      case 0x8000:
        if (odd) this.regs[this.bankSelect & 7] = v;
        else this.bankSelect = v;
        this.update();
        break;
      case 0xa000:
        if (!odd && this.cart.mirroring !== 'four') this.mirror = v & 1 ? 'horizontal' : 'vertical';
        // 奇数（PRG RAM の保護）は、無視しても困るゲームがないので扱わない
        break;
      case 0xc000:
        if (odd) {
          this.irqCounter = 0;
          this.irqReload = true;
        } else this.irqLatch = v;
        break;
      case 0xe000:
        this.irqEnabled = odd === 1;
        if (!this.irqEnabled) this.host.irq(false);
        break;
    }
  }

  private update(): void {
    const r = this.regs;
    if (this.bankSelect & 0x40) {
      this.setPrg8k(0, -2);
      this.setPrg8k(2, r[6]);
    } else {
      this.setPrg8k(0, r[6]);
      this.setPrg8k(2, -2);
    }
    this.setPrg8k(1, r[7]);
    this.setPrg8k(3, -1);

    // CHR：2KB×2（R0・R1）と 1KB×4（R2〜R5）。bit7 で前後を入れ替える
    const inv = this.bankSelect & 0x80 ? 4 : 0;
    this.setChr1k(inv ^ 0, r[0] & 0xfe);
    this.setChr1k(inv ^ 1, r[0] | 1);
    this.setChr1k(inv ^ 2, r[1] & 0xfe);
    this.setChr1k(inv ^ 3, r[1] | 1);
    this.setChr1k(inv ^ 4, r[2]);
    this.setChr1k(inv ^ 5, r[3]);
    this.setChr1k(inv ^ 6, r[4]);
    this.setChr1k(inv ^ 7, r[5]);
  }

  ppuRead(addr: number): number {
    this.watchA12(addr);
    return super.ppuRead(addr);
  }

  ppuWrite(addr: number, v: number): void {
    this.watchA12(addr);
    super.ppuWrite(addr, v);
  }

  ppuAddress(addr: number): void {
    this.watchA12(addr);
  }

  private watchA12(addr: number): void {
    const high = (addr & 0x1000) !== 0;
    if (high && !this.a12) {
      // 0 の時間が短い立ち上がり（同じ走査線の中の細かい切り替え）は数えない
      if (this.host.ppuDots() - this.a12LowSince >= 10) this.clockIrq();
    } else if (!high && this.a12) {
      this.a12LowSince = this.host.ppuDots();
    }
    this.a12 = high;
  }

  private clockIrq(): void {
    if (this.irqCounter === 0 || this.irqReload) {
      this.irqCounter = this.irqLatch;
      this.irqReload = false;
    } else this.irqCounter--;
    if (this.irqCounter === 0 && this.irqEnabled) this.host.irq(true);
  }
}
