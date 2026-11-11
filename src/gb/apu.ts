// ゲームボーイの音（矩形波 2 つ・波形メモリ・ノイズ）。
// 時間は 4.19MHz のドット単位で進め、出力はその間の平均（簡単なローパス）をサンプリング周波数で取り出す

export const GB_CLOCK = 4194304;

const DUTY = [0b00000001, 0b10000001, 0b10000111, 0b01111110];
const NOISE_DIV = [8, 16, 32, 48, 64, 80, 96, 112];
/** 読み出したとき 1 になるビット（$FF10〜$FF2F） */
const READ_OR = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, 0xff, 0x3f, 0x00, 0xff, 0xbf, 0x7f, 0xff, 0x9f, 0xff, 0xbf, 0xff, 0xff, 0x00, 0x00, 0xbf,
  0x00, 0x00, 0x70, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

class Envelope {
  init = 0;
  up = false;
  period = 0;
  volume = 0;
  private timer = 0;

  write(v: number): void {
    this.init = v >> 4;
    this.up = (v & 8) !== 0;
    this.period = v & 7;
  }
  trigger(): void {
    this.volume = this.init;
    this.timer = this.period || 8;
  }
  clock(): void {
    if (!this.period) return;
    if (--this.timer > 0) return;
    this.timer = this.period;
    if (this.up && this.volume < 15) this.volume++;
    else if (!this.up && this.volume > 0) this.volume--;
  }
}

export class Square {
  on = false;
  dac = false;
  duty = 0;
  length = 0;
  lengthOn = false;
  freq = 0;
  env = new Envelope();
  private timer = 0;
  private pos = 0;
  // スイープ（矩形波 1 だけ）
  sweepPeriod = 0;
  sweepDown = false;
  sweepShift = 0;
  private sweepTimer = 0;
  private sweepOn = false;
  private shadow = 0;
  /** 引き算のスイープを計算したあと（このあと引き算をやめると止まる） */
  private negUsed = false;

  constructor(readonly hasSweep: boolean) {}

  /** quirk：次のフレームシーケンサの段が長さを数えない段か（長さカウンタの癖） */
  write(reg: number, v: number, quirk = false): void {
    switch (reg) {
      case 0:
        this.sweepPeriod = (v >> 4) & 7;
        this.sweepDown = (v & 8) !== 0;
        this.sweepShift = v & 7;
        if (this.negUsed && !this.sweepDown) this.on = false;
        break;
      case 1:
        this.duty = v >> 6;
        this.length = 64 - (v & 63);
        break;
      case 2:
        this.env.write(v);
        this.dac = (v & 0xf8) !== 0;
        if (!this.dac) this.on = false;
        break;
      case 3:
        this.freq = (this.freq & 0x700) | v;
        break;
      case 4:
        this.freq = (this.freq & 0xff) | ((v & 7) << 8);
        this.length = lengthWrite(this, v, quirk, 64);
        if (v & 0x80) this.trigger();
        break;
    }
  }

  private trigger(): void {
    this.on = this.dac;
    this.negUsed = false;
    this.timer = (2048 - this.freq) * 4;
    this.env.trigger();
    if (this.hasSweep) {
      this.shadow = this.freq;
      this.sweepTimer = this.sweepPeriod || 8;
      this.sweepOn = this.sweepPeriod !== 0 || this.sweepShift !== 0;
      if (this.sweepShift) this.sweepCalc();
    }
  }

  private sweepCalc(): number {
    if (this.sweepDown) this.negUsed = true;
    const d = this.shadow >> this.sweepShift;
    const f = this.sweepDown ? this.shadow - d : this.shadow + d;
    if (f > 2047) this.on = false;
    return f;
  }

  clockSweep(): void {
    if (--this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepPeriod || 8;
    if (!this.sweepOn || !this.sweepPeriod) return;
    const f = this.sweepCalc();
    if (f <= 2047 && this.sweepShift) {
      this.freq = this.shadow = f;
      this.sweepCalc();
    }
  }

  clockLength(): void {
    if (this.lengthOn && this.length > 0 && --this.length === 0) this.on = false;
  }

  advance(n: number): void {
    this.timer -= n;
    while (this.timer <= 0) {
      this.timer += (2048 - this.freq) * 4;
      this.pos = (this.pos + 1) & 7;
    }
  }

  output(): number {
    return this.on && (DUTY[this.duty] >> (7 - this.pos)) & 1 ? this.env.volume : 0;
  }
}

/**
 * NRx4 を書いたときの長さカウンタ。次の段が長さを数えない段（quirk）なら、
 * 長さを有効にした瞬間に 1 つ数える。トリガーで 0 なら最大に戻す
 */
export function lengthWrite(ch: { length: number; lengthOn: boolean; on: boolean }, v: number, quirk: boolean, max: number): number {
  const wasOn = ch.lengthOn;
  ch.lengthOn = (v & 0x40) !== 0;
  let len = ch.length;
  if (quirk && !wasOn && ch.lengthOn && len > 0 && --len === 0 && !(v & 0x80)) ch.on = false;
  if (v & 0x80 && len === 0) len = quirk && ch.lengthOn ? max - 1 : max;
  return len;
}

class Wave {
  on = false;
  dac = false;
  length = 0;
  lengthOn = false;
  freq = 0;
  volCode = 0;
  readonly ram = new Uint8Array(16);
  private timer = 0;
  private pos = 0;

  write(reg: number, v: number, quirk = false): void {
    switch (reg) {
      case 0:
        this.dac = (v & 0x80) !== 0;
        if (!this.dac) this.on = false;
        break;
      case 1:
        this.length = 256 - v;
        break;
      case 2:
        this.volCode = (v >> 5) & 3;
        break;
      case 3:
        this.freq = (this.freq & 0x700) | v;
        break;
      case 4:
        this.freq = (this.freq & 0xff) | ((v & 7) << 8);
        this.length = lengthWrite(this, v, quirk, 256);
        if (v & 0x80) {
          this.on = this.dac;
          this.timer = (2048 - this.freq) * 2 + 6;
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
    while (this.timer <= 0) {
      this.timer += (2048 - this.freq) * 2;
      this.pos = (this.pos + 1) & 31;
    }
  }

  output(): number {
    if (!this.on || this.volCode === 0) return 0;
    const b = this.ram[this.pos >> 1];
    const s = this.pos & 1 ? b & 0x0f : b >> 4;
    return s >> (this.volCode - 1);
  }
}

export class Noise {
  on = false;
  dac = false;
  length = 0;
  lengthOn = false;
  env = new Envelope();
  shift = 0;
  narrow = false;
  div = 0;
  private timer = 0;
  private lfsr = 0x7fff;

  write(reg: number, v: number, quirk = false): void {
    switch (reg) {
      case 1:
        this.length = 64 - (v & 63);
        break;
      case 2:
        this.env.write(v);
        this.dac = (v & 0xf8) !== 0;
        if (!this.dac) this.on = false;
        break;
      case 3:
        this.shift = v >> 4;
        this.narrow = (v & 8) !== 0;
        this.div = v & 7;
        break;
      case 4:
        this.length = lengthWrite(this, v, quirk, 64);
        if (v & 0x80) {
          this.on = this.dac;
          this.timer = this.period();
          this.lfsr = 0x7fff;
          this.env.trigger();
        }
        break;
    }
  }

  private period(): number {
    return NOISE_DIV[this.div] << this.shift;
  }

  clockLength(): void {
    if (this.lengthOn && this.length > 0 && --this.length === 0) this.on = false;
  }

  advance(n: number): void {
    this.timer -= n;
    if (this.timer > 0) return;
    const p = this.period();
    while (this.timer <= 0) {
      this.timer += p;
      const x = (this.lfsr ^ (this.lfsr >> 1)) & 1;
      this.lfsr = (this.lfsr >> 1) | (x << 14);
      if (this.narrow) this.lfsr = (this.lfsr & ~0x40) | (x << 6);
    }
  }

  output(): number {
    return this.on && !(this.lfsr & 1) ? this.env.volume : 0;
  }
}

export class GbApu {
  sampleRate = 48000;
  /** 画面と音がずれないようにする補正（main.ts が決める） */
  rateAdjust = 1;
  samples = new Float32Array(8192);
  sampleLength = 0;
  /** true なら左・右を交互に出す（アプリ用）。spread：0 = モノラル、1 = 実機どおりのステレオ */
  stereo = false;
  spread = 1;

  private power = true;
  private regs = new Uint8Array(0x30);
  private ch1 = new Square(true);
  private ch2 = new Square(false);
  private ch3 = new Wave();
  private ch4 = new Noise();
  private seqStep = 0;
  private sum = 0;
  private sumR = 0;
  private count = 0;
  private acc = 0;
  private hpPrev = 0;
  private hpOut = 0;
  private hpPrevR = 0;
  private hpOutR = 0;
  private mixL = 0;
  private mixR = 0;

  constructor() {
    // 起動直後の状態（音量最大・全チャンネルを左右に）
    this.write(0xff24, 0x77);
    this.write(0xff25, 0xf3);
  }

  read(a: number): number {
    if (a >= 0xff30) return this.ch3.ram[a - 0xff30];
    const i = a - 0xff10;
    if (a === 0xff26) {
      return (
        0x70 |
        (this.power ? 0x80 : 0) |
        (this.ch1.on ? 1 : 0) |
        (this.ch2.on ? 2 : 0) |
        (this.ch3.on ? 4 : 0) |
        (this.ch4.on ? 8 : 0)
      );
    }
    return this.regs[i] | READ_OR[i];
  }

  write(a: number, v: number): void {
    if (a >= 0xff30) {
      this.ch3.ram[a - 0xff30] = v;
      return;
    }
    if (a === 0xff26) {
      const on = (v & 0x80) !== 0;
      if (this.power && !on) {
        // 電源を切るとレジスタはすべて 0 に
        for (let r = 0xff10; r < 0xff26; r++) this.write(r, 0);
        this.ch1.on = this.ch2.on = this.ch3.on = this.ch4.on = false;
      }
      if (!this.power && on) this.seqStep = 0;
      this.power = on;
      return;
    }
    if (!this.power) return;
    const i = a - 0xff10;
    this.regs[i] = v;
    const quirk = (this.seqStep & 1) === 1;
    if (i < 5) this.ch1.write(i, v, quirk);
    else if (i < 10) this.ch2.write(i - 5, v, quirk);
    else if (i < 15) this.ch3.write(i - 10, v, quirk);
    else if (i < 20) this.ch4.write(i - 15, v, quirk);
  }

  /** 512Hz のフレームシーケンサ（DIV から呼ばれる） */
  frameStep(): void {
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

  /** n ドット（4.19MHz）進める */
  advance(n: number): void {
    // その間の出力（この間は一定とみなす）
    this.mix();
    this.sum += this.mixL * n;
    this.sumR += this.mixR * n;
    this.count += n;
    this.ch1.advance(n);
    this.ch2.advance(n);
    this.ch3.advance(n);
    this.ch4.advance(n);
    this.acc += n * this.sampleRate * this.rateAdjust;
    if (this.acc < GB_CLOCK) return;
    this.acc -= GB_CLOCK;
    let l = this.sum / this.count;
    let r = this.sumR / this.count;
    this.sum = 0;
    this.sumR = 0;
    this.count = 0;
    // 広がりを調整（0 なら左右とも真ん中＝モノラル）
    const m = (l + r) / 2;
    const side = ((l - r) / 2) * (this.stereo ? this.spread : 0);
    l = m + side;
    r = m - side;
    this.hpOut = 0.996 * (this.hpOut + l - this.hpPrev); // 直流分を落とす
    this.hpPrev = l;
    if (!this.stereo) {
      if (this.sampleLength < this.samples.length) this.samples[this.sampleLength++] = this.hpOut;
      return;
    }
    this.hpOutR = 0.996 * (this.hpOutR + r - this.hpPrevR);
    this.hpPrevR = r;
    if (this.sampleLength + 1 < this.samples.length) {
      this.samples[this.sampleLength++] = this.hpOut;
      this.samples[this.sampleLength++] = this.hpOutR;
    }
  }

  /** 今の左右の出力を mixL・mixR に入れる */
  private mix(): void {
    if (!this.power) {
      this.mixL = this.mixR = 0;
      return;
    }
    const pan = this.regs[0x15];
    const vol = this.regs[0x14];
    const o1 = this.ch1.output();
    const o2 = this.ch2.output();
    const o3 = this.ch3.output();
    const o4 = this.ch4.output();
    const left = (pan & 0x10 ? o1 : 0) + (pan & 0x20 ? o2 : 0) + (pan & 0x40 ? o3 : 0) + (pan & 0x80 ? o4 : 0);
    const right = (pan & 1 ? o1 : 0) + (pan & 2 ? o2 : 0) + (pan & 4 ? o3 : 0) + (pan & 8 ? o4 : 0);
    // 各チャンネル 0〜15、左右の音量 1〜8 → だいたい 0〜0.5 に（ファミコンと同じくらいの大きさ）
    this.mixL = (left * (((vol >> 4) & 7) + 1)) / (15 * 4 * 8 * 2);
    this.mixR = (right * ((vol & 7) + 1)) / (15 * 4 * 8 * 2);
  }

  takeSamples(): Float32Array {
    const out = this.samples.slice(0, this.sampleLength);
    this.sampleLength = 0;
    return out;
  }
}
