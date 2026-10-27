import type { Cartridge } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';

// ナムコ 163（19）と、その簡易版の 175・340（210）。
// 163 は CHR の代わりにネームテーブル用 RAM を割り当てられ、波形メモリ音源を持つ
export class Mapper19 extends BaseMapper {
  private readonly n163: boolean;
  protected ciram: Uint8Array = new Uint8Array(0x800);
  /** 0〜7 = パターン、8〜11 = ネームテーブル */
  private banks = [0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0xe0, 0xe0, 0xe0];
  private lowRam = true; // $E800 bit6 が 0 なら $0000-$0FFF で CIRAM を選べる
  private highRam = true;
  private irqCounter = 0;
  private irqEnabled = false;
  // 音源
  private sound = new Uint8Array(0x80);
  private soundAddr = 0;
  private autoInc = false;
  private soundOff = false;
  private channelOut = new Float32Array(8);
  private channelTimer = 0;
  private channelIndex = 0;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.n163 = cart.mapper === 19;
    this.setPrg8k(3, -1);
    if (!this.n163 && cart.submapper === 2) this.mirror = 'single0';
    this.updateChr();
  }

  attachCiram(ciram: Uint8Array): void {
    this.ciram = ciram;
  }

  get saveRam(): Uint8Array | null {
    return this.cart.battery ? this.prgRam : null;
  }

  cpuRead(addr: number): number {
    if (this.n163) {
      if (addr >= 0x4800 && addr < 0x5000) {
        const v = this.sound[this.soundAddr];
        if (this.autoInc) this.soundAddr = (this.soundAddr + 1) & 0x7f;
        return v;
      }
      if (addr >= 0x5000 && addr < 0x5800) return this.irqCounter & 0xff;
      if (addr >= 0x5800 && addr < 0x6000) return ((this.irqCounter >> 8) & 0x7f) | (this.irqEnabled ? 0x80 : 0);
    }
    return super.cpuRead(addr);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) {
      if (this.n163 && addr >= 0x4800 && addr < 0x6000) {
        if (addr < 0x5000) {
          this.sound[this.soundAddr] = v;
          if (this.autoInc) this.soundAddr = (this.soundAddr + 1) & 0x7f;
        } else if (addr < 0x5800) {
          this.irqCounter = (this.irqCounter & 0x7f00) | v;
          this.host.irq(false);
        } else {
          this.irqCounter = (this.irqCounter & 0xff) | ((v & 0x7f) << 8);
          this.irqEnabled = (v & 0x80) !== 0;
          this.host.irq(false);
        }
        return;
      }
      return super.cpuWrite(addr, v);
    }
    if (addr < 0xe000) {
      const i = (addr - 0x8000) >> 11; // $800 ごとに 1 つ
      if (i < 12 && (this.n163 || i < 8)) this.banks[i] = v;
      this.updateChr();
      return;
    }
    switch (addr & 0xf800) {
      case 0xe000:
        this.setPrg8k(0, v & 0x3f);
        this.soundOff = (v & 0x40) !== 0;
        if (!this.n163 && this.cart.submapper === 2) {
          this.mirror = (['single0', 'vertical', 'horizontal', 'single1'] as const)[v >> 6];
        }
        break;
      case 0xe800:
        this.setPrg8k(1, v & 0x3f);
        this.lowRam = (v & 0x40) === 0;
        this.highRam = (v & 0x80) === 0;
        this.updateChr();
        break;
      case 0xf000:
        this.setPrg8k(2, v & 0x3f);
        break;
      case 0xf800:
        this.soundAddr = v & 0x7f;
        this.autoInc = (v & 0x80) !== 0;
        break;
    }
  }

  private updateChr(): void {
    for (let i = 0; i < 8; i++) this.setChr1k(i, this.banks[i]);
  }

  /** パターンの 1KB が CIRAM を指しているか（指していればそのページ、でなければ -1） */
  private ciramPage(slot: number): number {
    if (!this.n163) return -1;
    const b = this.banks[slot];
    if (b < 0xe0) return -1;
    if (slot < 4 ? !this.lowRam : !this.highRam) return -1;
    return b & 1;
  }

  ppuRead(addr: number): number {
    const p = this.ciramPage(addr >> 10);
    if (p >= 0) return this.ciram[p * 0x400 + (addr & 0x3ff)];
    return super.ppuRead(addr);
  }

  ppuWrite(addr: number, v: number): void {
    const p = this.ciramPage(addr >> 10);
    if (p >= 0) this.ciram[p * 0x400 + (addr & 0x3ff)] = v;
    else super.ppuWrite(addr, v);
  }

  // 163 だけはネームテーブルを自分で選ぶ（210 は普通のミラーリングなので ntRead を持たせない）
  protected ntBank(addr: number): number {
    return this.banks[8 + ((addr >> 10) & 3)];
  }

  cpuClock(): void {
    if (!this.n163) return;
    if (this.irqEnabled && this.irqCounter < 0x7fff) {
      this.irqCounter++;
      if (this.irqCounter === 0x7fff) this.host.irq(true);
    }
    // 音源：15 サイクルごとに 1 チャンネルずつ進める
    if (++this.channelTimer >= 15) {
      this.channelTimer = 0;
      this.stepChannel();
    }
  }

  private channels(): number {
    return ((this.sound[0x7f] >> 4) & 7) + 1;
  }

  private stepChannel(): void {
    const n = this.channels();
    this.channelIndex = (this.channelIndex + 1) % n;
    const ch = 7 - this.channelIndex; // 最後のチャンネル（$78〜$7F）から使う
    const base = 0x40 + ch * 8;
    const s = this.sound;
    const freq = s[base] | (s[base + 2] << 8) | ((s[base + 4] & 3) << 16);
    let phase = s[base + 1] | (s[base + 3] << 8) | (s[base + 5] << 16);
    const length = 256 - (s[base + 4] & 0xfc);
    phase = (phase + freq) % (length << 16);
    s[base + 1] = phase & 0xff;
    s[base + 3] = (phase >> 8) & 0xff;
    s[base + 5] = (phase >> 16) & 0xff;
    const pos = ((phase >> 16) + s[base + 6]) & 0xff;
    const sample = (s[pos >> 1] >> ((pos & 1) * 4)) & 0x0f;
    this.channelOut[ch] = (sample - 8) * (s[base + 7] & 0x0f);
  }

  audioOut(): number {
    if (!this.n163 || this.soundOff) return 0;
    // 実機は時分割で 1 チャンネルずつ鳴らしているので、平均をとる
    const n = this.channels();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.channelOut[7 - i];
    return (sum / n) * 0.006;
  }
}

/** 163 のネームテーブル切り替え（ntRead / ntWrite を持つのは 19 だけにする） */
export class Mapper19Nt extends Mapper19 {
  ntRead(addr: number): number {
    const b = this.ntBank(addr);
    if (b >= 0xe0) return this.ciram[(b & 1) * 0x400 + (addr & 0x3ff)];
    return this.chr[((b << 10) + (addr & 0x3ff)) % this.chr.length];
  }

  ntWrite(addr: number, v: number): void {
    const b = this.ntBank(addr);
    if (b >= 0xe0) this.ciram[(b & 1) * 0x400 + (addr & 0x3ff)] = v;
  }
}
