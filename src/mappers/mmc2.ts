import type { Cartridge } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';

// MMC2（9、パンチアウト!!）・MMC4（10、ファミコンウォーズ・ファイアーエムブレム）。
// PPU がタイル $FD / $FE のパターンを読むと、その 4KB の CHR が自動で切り替わる（ラッチ）
export class Mapper9 extends BaseMapper {
  private readonly mmc4: boolean;
  private chrSel = [0, 0, 0, 0]; // [左FD, 左FE, 右FD, 右FE]
  private latch = [1, 1]; // 0 = FD、1 = FE

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.mmc4 = cart.mapper === 10;
    if (this.mmc4) {
      this.setPrg16k(0, 0);
      this.setPrg16k(2, -1);
    } else {
      this.setPrg8k(0, 0);
      this.setPrg8k(1, -3);
      this.setPrg8k(2, -2);
      this.setPrg8k(3, -1);
    }
    this.updateChr();
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0xa000) return super.cpuWrite(addr, v);
    switch (addr & 0xf000) {
      case 0xa000:
        if (this.mmc4) this.setPrg16k(0, v & 0x0f);
        else this.setPrg8k(0, v & 0x0f);
        return;
      case 0xb000:
        this.chrSel[0] = v & 0x1f;
        break;
      case 0xc000:
        this.chrSel[1] = v & 0x1f;
        break;
      case 0xd000:
        this.chrSel[2] = v & 0x1f;
        break;
      case 0xe000:
        this.chrSel[3] = v & 0x1f;
        break;
      case 0xf000:
        this.mirror = v & 1 ? 'horizontal' : 'vertical';
        return;
    }
    this.updateChr();
  }

  private updateChr(): void {
    this.setChr4k(0, this.chrSel[this.latch[0]]);
    this.setChr4k(4, this.chrSel[2 + this.latch[1]]);
  }

  ppuRead(addr: number): number {
    const v = super.ppuRead(addr);
    // ラッチが変わるのは、そのパターンを読んだあと
    const a = addr & 0x1ff8;
    let changed = false;
    if (addr < 0x1000) {
      const hit = this.mmc4 ? a : addr;
      if (hit === 0x0fd8 && this.latch[0] !== 0) (this.latch[0] = 0), (changed = true);
      else if (hit === 0x0fe8 && this.latch[0] !== 1) (this.latch[0] = 1), (changed = true);
    } else if (a === 0x1fd8 && this.latch[1] !== 0) (this.latch[1] = 0), (changed = true);
    else if (a === 0x1fe8 && this.latch[1] !== 1) (this.latch[1] = 1), (changed = true);
    if (changed) this.updateChr();
    return v;
  }
}
