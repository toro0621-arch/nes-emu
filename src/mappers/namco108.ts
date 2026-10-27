import type { Cartridge } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';

// ナムコ 108 系（206・76・88・154）：MMC3 の前身。IRQ と PRG の入れ替えモードはない
export class Mapper206 extends BaseMapper {
  private select = 0;
  private regs = [0, 2, 4, 5, 6, 7, 0, 1];

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.update();
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    // 154：どこに書いてもビット 6 で 1 画面ミラーを選ぶ
    if (this.cart.mapper === 154) this.mirror = v & 0x40 ? 'single1' : 'single0';
    if (addr >= 0xa000) return;
    if (addr & 1) this.regs[this.select] = v & 0x3f;
    else this.select = v & 7;
    this.update();
  }

  private update(): void {
    const r = this.regs;
    this.setPrg8k(0, r[6] & 0x0f);
    this.setPrg8k(1, r[7] & 0x0f);
    this.setPrg8k(2, -2);
    this.setPrg8k(3, -1);
    if (this.cart.mapper === 76) {
      // 76：2KB×4（R2〜R5）
      for (let i = 0; i < 4; i++) this.setChr2k(i * 2, r[2 + i]);
      return;
    }
    // 88・154：前半は CHR の前の 64KB、後半は後ろの 64KB
    const hi = this.cart.mapper === 88 || this.cart.mapper === 154 ? 0x40 : 0;
    this.setChr1k(0, r[0] & 0x3e);
    this.setChr1k(1, (r[0] & 0x3e) | 1);
    this.setChr1k(2, r[1] & 0x3e);
    this.setChr1k(3, (r[1] & 0x3e) | 1);
    for (let i = 0; i < 4; i++) this.setChr1k(4 + i, r[2 + i] | hi);
  }
}
