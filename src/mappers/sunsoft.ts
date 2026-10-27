import type { Cartridge } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';
import { MIRROR_VH1S } from './discrete';

// サンソフト 3・4・FME-7（5B）

/** サンソフト 3（67、ファンタジーゾーン2・ヨーロッパ戦線） */
export class Mapper67 extends BaseMapper {
  private counter = 0;
  private enabled = false;
  private toggle = false;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg16k(0, 0);
    this.setPrg16k(2, -1);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    switch (addr & 0xf800) {
      case 0x8800:
        this.setChr2k(0, v);
        break;
      case 0x9800:
        this.setChr2k(2, v);
        break;
      case 0xa800:
        this.setChr2k(4, v);
        break;
      case 0xb800:
        this.setChr2k(6, v);
        break;
      case 0xc800:
        // 上位バイト → 下位バイトの順に 2 回書く
        if (this.toggle) this.counter = (this.counter & 0xff00) | v;
        else this.counter = (this.counter & 0xff) | (v << 8);
        this.toggle = !this.toggle;
        break;
      case 0xd800:
        this.enabled = (v & 0x10) !== 0;
        this.toggle = false;
        this.host.irq(false);
        break;
      case 0xe800:
        this.mirror = MIRROR_VH1S[v & 3];
        break;
      case 0xf800:
        this.setPrg16k(0, v);
        break;
    }
  }

  cpuClock(): void {
    if (!this.enabled) return;
    this.counter = (this.counter - 1) & 0xffff;
    if (this.counter === 0xffff) {
      this.enabled = false;
      this.host.irq(true);
    }
  }
}

/** サンソフト 4（68、アフターバーナー）：CHR ROM をネームテーブルにできる */
export class Mapper68 extends BaseMapper {
  private ciram: Uint8Array = new Uint8Array(0x800);
  private ntBanks = [0x80, 0x80];
  private chrNt = false;
  private mirrorMode = 0;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg16k(0, 0);
    this.setPrg16k(2, -1);
  }

  attachCiram(ciram: Uint8Array): void {
    this.ciram = ciram;
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    switch (addr & 0xf000) {
      case 0x8000:
      case 0x9000:
      case 0xa000:
      case 0xb000:
        this.setChr2k(((addr >> 12) - 8) * 2, v);
        break;
      case 0xc000:
        this.ntBanks[0] = v | 0x80;
        break;
      case 0xd000:
        this.ntBanks[1] = v | 0x80;
        break;
      case 0xe000:
        this.mirrorMode = v & 3;
        this.chrNt = (v & 0x10) !== 0;
        break;
      case 0xf000:
        this.setPrg16k(0, v);
        break;
    }
  }

  /** 論理ネームテーブル 0〜3 が、2 つの実ページ（または CHR の 2 つのバンク）のどちらか */
  private page(addr: number): number {
    const t = (addr >> 10) & 3;
    switch (this.mirrorMode) {
      case 0:
        return t & 1;
      case 1:
        return t >> 1;
      case 2:
        return 0;
      default:
        return 1;
    }
  }

  ntRead(addr: number): number {
    const p = this.page(addr);
    if (this.chrNt) return this.chr[((this.ntBanks[p] << 10) + (addr & 0x3ff)) % this.chr.length];
    return this.ciram[p * 0x400 + (addr & 0x3ff)];
  }

  ntWrite(addr: number, v: number): void {
    if (!this.chrNt) this.ciram[this.page(addr) * 0x400 + (addr & 0x3ff)] = v;
  }
}

/** サンソフト 5B（FME-7 + AY-3-8910 互換の矩形波 3 つ）の音源 */
class Sunsoft5B {
  private regs = new Uint8Array(16);
  private timers = [0, 0, 0];
  private outs = [0, 0, 0];
  private div = 0;
  /** 1 段 3dB の音量（0〜15） */
  private static readonly VOL = Float32Array.from({ length: 16 }, (_, i) => (i ? Math.pow(10, ((i - 15) * 3) / 20) : 0));

  write(reg: number, v: number): void {
    this.regs[reg & 0x0f] = v;
  }

  clock(): void {
    // 矩形波は CPU 16 サイクルごと
    if (++this.div < 16) return;
    this.div = 0;
    for (let ch = 0; ch < 3; ch++) {
      const period = this.regs[ch * 2] | ((this.regs[ch * 2 + 1] & 0x0f) << 8);
      if (++this.timers[ch] >= Math.max(1, period)) {
        this.timers[ch] = 0;
        this.outs[ch] ^= 1;
      }
    }
  }

  output(): number {
    let sum = 0;
    const mixer = this.regs[7];
    for (let ch = 0; ch < 3; ch++) {
      const toneOff = (mixer >> ch) & 1;
      const vol = this.regs[8 + ch] & 0x0f;
      if (toneOff) continue;
      if (this.outs[ch]) sum += Sunsoft5B.VOL[vol];
    }
    return sum * 0.12;
  }
}

/** FME-7（69、ギミック!・バットマン など） */
export class Mapper69 extends BaseMapper {
  private command = 0;
  private ramBank = 0; // $6000-$7FFF の設定
  private irqEnabled = false;
  private counterEnabled = false;
  private counter = 0;
  private audio = new Sunsoft5B();
  private audioReg = 0;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg8k(3, -1);
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) {
      const bank = this.ramBank & 0x3f;
      if (this.ramBank & 0x40) {
        // RAM（使えないときは何も出ない）
        return this.ramBank & 0x80 ? this.prgRam[addr & 0x1fff] : 0;
      }
      return this.prg[((bank % this.prgBanks8k) << 13) + (addr & 0x1fff)];
    }
    return super.cpuRead(addr);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) {
      if (addr >= 0x6000 && (this.ramBank & 0xc0) === 0xc0) super.cpuWrite(addr, v);
      return;
    }
    switch (addr & 0xe000) {
      case 0x8000:
        this.command = v & 0x0f;
        break;
      case 0xa000:
        this.execute(v);
        break;
      case 0xc000:
        this.audioReg = v & 0x0f;
        break;
      case 0xe000:
        this.audio.write(this.audioReg, v);
        break;
    }
  }

  private execute(v: number): void {
    const c = this.command;
    if (c < 8) this.setChr1k(c, v);
    else if (c === 8) this.ramBank = v;
    else if (c < 0xc) this.setPrg8k(c - 9, v & 0x3f);
    else if (c === 0xc) this.mirror = MIRROR_VH1S[v & 3];
    else if (c === 0xd) {
      this.irqEnabled = (v & 1) !== 0;
      this.counterEnabled = (v & 0x80) !== 0;
      this.host.irq(false);
    } else if (c === 0xe) this.counter = (this.counter & 0xff00) | v;
    else this.counter = (this.counter & 0xff) | (v << 8);
  }

  cpuClock(): void {
    this.audio.clock();
    if (!this.counterEnabled) return;
    this.counter = (this.counter - 1) & 0xffff;
    if (this.counter === 0xffff && this.irqEnabled) this.host.irq(true);
  }

  audioOut(): number {
    return this.audio.output();
  }
}
