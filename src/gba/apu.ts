// ゲームボーイアドバンスの音。ゲームボーイと同じ 4 チャンネル（波形メモリは 2 バンク）と、
// DMA で流し込む 8 ビットの PCM（FIFO A・B）。FIFO はタイマー 0 か 1 があふれるたびに 1 つ進む

import { lengthWrite, Noise, Square } from '../gb/apu';

export const GBA_CLOCK = 16777216;

class GbaWave {
  on = false;
  dac = false;
  length = 0;
  lengthOn = false;
  freq = 0;
  volCode = 0;
  force75 = false;
  /** 64 サンプル（2 バンクつなげて鳴らす） */
  dim64 = false;
  bank = 0;
  readonly ram = new Uint8Array(32);
  private timer = 0;
  private pos = 0;

  write(reg: number, v: number, quirk: boolean): void {
    switch (reg) {
      case 0:
        this.dim64 = (v & 0x20) !== 0;
        this.bank = (v >> 6) & 1;
        this.dac = (v & 0x80) !== 0;
        if (!this.dac) this.on = false;
        break;
      case 1:
        this.length = 256 - v;
        break;
      case 2:
        this.volCode = (v >> 5) & 3;
        this.force75 = (v & 0x80) !== 0;
        break;
      case 3:
        this.freq = (this.freq & 0x700) | v;
        break;
      case 4:
        this.freq = (this.freq & 0xff) | ((v & 7) << 8);
        this.length = lengthWrite(this, v, quirk, 256);
        if (v & 0x80) {
          this.on = this.dac;
          this.timer = (2048 - this.freq) * 2;
          this.pos = 0;
        }
        break;
    }
  }

  clockLength(): void {
    if (this.lengthOn && this.length > 0 && --this.length === 0) this.on = false;
  }

  advance(n: number): void {
    this.timer -= n;
    if (this.timer > 0) return;
    const period = (2048 - this.freq) * 2;
    const mask = this.dim64 ? 63 : 31;
    while (this.timer <= 0) {
      this.timer += period;
      this.pos = (this.pos + 1) & mask;
    }
  }

  output(): number {
    if (!this.on) return 0;
    const s = this.dim64 ? (this.bank * 32 + this.pos) & 63 : this.bank * 32 + this.pos;
    const b = this.ram[s >> 1];
    const nib = s & 1 ? b & 15 : b >> 4;
    if (this.force75) return (nib * 3) >> 2;
    return this.volCode ? nib >> (this.volCode - 1) : 0;
  }
}

/** 0x60〜0x7F の各バイト → [チャンネル, レジスタ番号]（-1 は無し） */
const PSG_MAP: [number, number][] = [];
for (let i = 0; i < 0x20; i++) PSG_MAP.push([-1, 0]);
PSG_MAP[0x00] = [0, 0];
PSG_MAP[0x02] = [0, 1];
PSG_MAP[0x03] = [0, 2];
PSG_MAP[0x04] = [0, 3];
PSG_MAP[0x05] = [0, 4];
PSG_MAP[0x08] = [1, 1];
PSG_MAP[0x09] = [1, 2];
PSG_MAP[0x0c] = [1, 3];
PSG_MAP[0x0d] = [1, 4];
PSG_MAP[0x10] = [2, 0];
PSG_MAP[0x12] = [2, 1];
PSG_MAP[0x13] = [2, 2];
PSG_MAP[0x14] = [2, 3];
PSG_MAP[0x15] = [2, 4];
PSG_MAP[0x18] = [3, 1];
PSG_MAP[0x19] = [3, 2];
PSG_MAP[0x1c] = [3, 3];
PSG_MAP[0x1d] = [3, 4];

/** 読み出せないビット（0x60〜0x8F。書き込み専用のところは 0 で読める） */
const READ_MASK = [
  0x7f, 0x00, 0xc0, 0xff, 0x00, 0x40, 0x00, 0x00, 0xc0, 0xff, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0xe0, 0x00, 0x00, 0xe0,
  0x00, 0x40, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0x40, 0x00, 0x00, 0x77, 0xff, 0x0f, 0x77, 0x80, 0x00, 0x00, 0x00,
  0xfe, 0xc3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

export class GbaApu {
  sampleRate = 48000;
  rateAdjust = 1;
  samples = new Float32Array(8192);
  sampleLength = 0;
  stereo = false;
  spread = 1;
  /** FIFO にデータが足りなくなったとき（DMA を動かす）。引数は FIFO のアドレス */
  host: { fifoRequest(addr: number): void } | null = null;

  private power = false;
  /** 0x60〜0x8F のレジスタ（読み出し用） */
  regs = new Uint8Array(0x30);
  private ch1 = new Square(true);
  private ch2 = new Square(false);
  private ch3 = new GbaWave();
  private ch4 = new Noise();
  private seqStep = 0;
  private seqTimer = 0;
  private dotFrac = 0;
  /** FIFO A・B（32 バイトずつ） */
  private fifo = new Int8Array(64);
  private fifoRead = new Uint8Array(2);
  private fifoWrite = new Uint8Array(2);
  private fifoCount = new Uint8Array(2);
  private fifoOut = new Int8Array(2);
  /** 最後に進めた時刻 */
  last = 0;

  private sumL = 0;
  private sumR = 0;
  private count = 0;
  private acc = 0;
  private lastL = 0;
  private lastR = 0;
  private hpPrevL = 0;
  private hpOutL = 0;
  private hpPrevR = 0;
  private hpOutR = 0;

  constructor() {
    this.regs[0x28] = 0x00;
    this.regs[0x29] = 0x02; // SOUNDBIAS = 0x200
  }

  /** 0x60〜0x8F と波形メモリ（0x90〜0x9F）を読む */
  read8(a: number): number {
    if (a >= 0x90 && a < 0xa0) return this.ch3.ram[(this.ch3.bank ^ 1) * 16 + (a - 0x90)];
    if (a < 0x60 || a >= 0x90) return 0;
    const i = a - 0x60;
    if (i === 0x24) {
      return (
        (this.power ? 0x80 : 0) | (this.ch1.on ? 1 : 0) | (this.ch2.on ? 2 : 0) | (this.ch3.on ? 4 : 0) | (this.ch4.on ? 8 : 0)
      );
    }
    return this.regs[i] & READ_MASK[i];
  }

  write8(a: number, v: number, now: number): void {
    this.sync(now);
    if (a >= 0x90 && a < 0xa0) {
      this.ch3.ram[(this.ch3.bank ^ 1) * 16 + (a - 0x90)] = v;
      return;
    }
    if (a >= 0xa0 && a < 0xa8) {
      this.pushFifo(a < 0xa4 ? 0 : 1, v);
      return;
    }
    if (a < 0x60 || a >= 0x90) return;
    const i = a - 0x60;
    if (i === 0x24) {
      const on = (v & 0x80) !== 0;
      if (this.power && !on) {
        for (let r = 0; r < 0x20; r++) this.writePsg(r, 0);
        this.regs[0x20] = this.regs[0x21] = 0;
        this.ch1.on = this.ch2.on = this.ch3.on = this.ch4.on = false;
      }
      if (!this.power && on) this.seqStep = 0;
      this.power = on;
      this.regs[i] = v & 0x80;
      return;
    }
    if (i === 0x23) {
      // FIFO のリセット（書くだけのビット）
      if (v & 0x08) this.resetFifo(0);
      if (v & 0x80) this.resetFifo(1);
      this.regs[i] = v & 0x77;
      return;
    }
    if (i < 0x20 || i === 0x20 || i === 0x21) {
      if (!this.power) return;
      if (i < 0x20) this.writePsg(i, v);
    }
    this.regs[i] = v;
  }

  private writePsg(i: number, v: number): void {
    this.regs[i] = v;
    const [ch, reg] = PSG_MAP[i];
    const quirk = (this.seqStep & 1) === 1;
    if (ch === 0) this.ch1.write(reg, v, quirk);
    else if (ch === 1) this.ch2.write(reg, v, quirk);
    else if (ch === 2) this.ch3.write(reg, v, quirk);
    else if (ch === 3) this.ch4.write(reg, v, quirk);
  }

  private pushFifo(ch: number, v: number): void {
    if (this.fifoCount[ch] >= 32) return;
    this.fifo[ch * 32 + this.fifoWrite[ch]] = v;
    this.fifoWrite[ch] = (this.fifoWrite[ch] + 1) & 31;
    this.fifoCount[ch]++;
  }

  private resetFifo(ch: number): void {
    this.fifoRead[ch] = this.fifoWrite[ch] = this.fifoCount[ch] = 0;
  }

  /** タイマー t があふれた（FIFO を進める） */
  timerOverflow(t: number, now: number): void {
    const cnt = this.regs[0x22] | (this.regs[0x23] << 8);
    for (let ch = 0; ch < 2; ch++) {
      if (((cnt >> (10 + ch * 4)) & 1) !== t) continue;
      if (!(cnt & (0x300 << (ch * 4)))) continue;
      this.sync(now);
      if (this.fifoCount[ch] > 0) {
        this.fifoOut[ch] = this.fifo[ch * 32 + this.fifoRead[ch]];
        this.fifoRead[ch] = (this.fifoRead[ch] + 1) & 31;
        this.fifoCount[ch]--;
      }
      if (this.fifoCount[ch] <= 16) this.host?.fifoRequest(ch ? 0x40000a4 : 0x40000a0);
    }
  }

  /** now（GBA のクロック）まで進める */
  sync(now: number): void {
    const n = now - this.last;
    this.last = now;
    if (n > 0) this.advance(n);
  }

  private advance(n: number): void {
    // その間の出力
    let l = 0;
    let r = 0;
    const cnt = this.regs[0x22] | (this.regs[0x23] << 8);
    if (this.power) {
      const pan = this.regs[0x21];
      const vol = this.regs[0x20];
      const o1 = this.ch1.output();
      const o2 = this.ch2.output();
      const o3 = this.ch3.output();
      const o4 = this.ch4.output();
      const left = (pan & 0x10 ? o1 : 0) + (pan & 0x20 ? o2 : 0) + (pan & 0x40 ? o3 : 0) + (pan & 0x80 ? o4 : 0);
      const right = (pan & 1 ? o1 : 0) + (pan & 2 ? o2 : 0) + (pan & 4 ? o3 : 0) + (pan & 8 ? o4 : 0);
      const ratio = (cnt & 3) === 0 ? 0.25 : (cnt & 3) === 1 ? 0.5 : 1;
      l = left * (((vol >> 4) & 7) + 1) * ratio;
      r = right * ((vol & 7) + 1) * ratio;
      const a = this.fifoOut[0] * (cnt & 4 ? 4 : 2);
      const b = this.fifoOut[1] * (cnt & 8 ? 4 : 2);
      if (cnt & 0x200) l += a;
      if (cnt & 0x100) r += a;
      if (cnt & 0x2000) l += b;
      if (cnt & 0x1000) r += b;
    }
    this.sumL += l * n;
    this.sumR += r * n;
    this.count += n;

    // ゲームボーイの音のチャンネルは 4.19MHz（GBA の 1/4）で進む
    this.dotFrac += n;
    const dots = this.dotFrac >> 2;
    this.dotFrac &= 3;
    if (dots && this.power) {
      this.ch1.advance(dots);
      this.ch2.advance(dots);
      this.ch3.advance(dots);
      this.ch4.advance(dots);
    }
    // 512Hz のフレームシーケンサ
    this.seqTimer += n;
    while (this.seqTimer >= 32768) {
      this.seqTimer -= 32768;
      this.frameStep();
    }

    this.acc += n * this.sampleRate * this.rateAdjust;
    while (this.acc >= GBA_CLOCK) {
      this.acc -= GBA_CLOCK;
      this.emit();
    }
  }

  private frameStep(): void {
    if (!this.power) return;
    const s = this.seqStep;
    this.seqStep = (s + 1) & 7;
    if ((s & 1) === 0) {
      this.ch1.clockLength();
      this.ch2.clockLength();
      this.ch3.clockLength();
      this.ch4.clockLength();
    }
    if (s === 2 || s === 6) this.ch1.clockSweep();
    if (s === 7) {
      this.ch1.env.clock();
      this.ch2.env.clock();
      this.ch4.env.clock();
    }
  }

  private emit(): void {
    if (this.count > 0) {
      // ふつうはだいたい ±0.5 に収まるくらいに
      this.lastL = this.sumL / this.count / 1280;
      this.lastR = this.sumR / this.count / 1280;
      this.sumL = this.sumR = this.count = 0;
    }
    let l = this.lastL;
    let r = this.lastR;
    const m = (l + r) / 2;
    const side = ((l - r) / 2) * (this.stereo ? this.spread : 0);
    l = m + side;
    r = m - side;
    this.hpOutL = 0.996 * (this.hpOutL + l - this.hpPrevL);
    this.hpPrevL = l;
    if (!this.stereo) {
      if (this.sampleLength < this.samples.length) this.samples[this.sampleLength++] = this.hpOutL;
      return;
    }
    this.hpOutR = 0.996 * (this.hpOutR + r - this.hpPrevR);
    this.hpPrevR = r;
    if (this.sampleLength + 1 < this.samples.length) {
      this.samples[this.sampleLength++] = this.hpOutL;
      this.samples[this.sampleLength++] = this.hpOutR;
    }
  }

  takeSamples(): Float32Array {
    const out = this.samples.slice(0, this.sampleLength);
    this.sampleLength = 0;
    return out;
  }
}
