// ワンダースワンの音（波形メモリ 4 チャンネル。2 は PCM、3 はスイープ、4 はノイズにもなる）

export const WS_CLOCK = 3072000;

/** ノイズの LFSR のタップ位置（$8E の下位 3 ビット） */
const NOISE_TAP = [14, 10, 13, 4, 8, 6, 9, 11];

export class WsSound {
  sampleRate = 48000;
  rateAdjust = 1;
  stereo = false;
  spread = 1;
  samples = new Float32Array(8192);
  sampleLength = 0;

  /** 周期のカウンタと波形の位置 */
  private timer = new Int32Array(4);
  private pos = new Uint8Array(4);
  private lfsr = 0;
  private sweepTimer = 0;
  private noiseOut = 0;

  private sumL = 0;
  private sumR = 0;
  private count = 0;
  private acc = 0;
  private hpPrevL = 0;
  private hpOutL = 0;
  private hpPrevR = 0;
  private hpOutR = 0;

  constructor(
    private ram: Uint8Array,
    private io: Uint8Array,
  ) {}

  private freq(ch: number): number {
    return this.io[0x80 + ch * 2] | ((this.io[0x81 + ch * 2] & 7) << 8);
  }

  /** $8E の bit3 を書くとノイズを初期化 */
  resetNoise(): void {
    this.lfsr = 0;
  }

  /** LFSR の値（$92・$93 で読める） */
  get noiseCounter(): number {
    return this.lfsr;
  }

  /** cycles クロック進める */
  advance(cycles: number): void {
    const io = this.io;
    const ctrl = io[0x90];
    // 各チャンネルの位置を進める
    for (let ch = 0; ch < 4; ch++) {
      if (!(ctrl & (1 << ch))) continue;
      const period = 2048 - this.freq(ch);
      this.timer[ch] -= cycles;
      while (this.timer[ch] <= 0) {
        this.timer[ch] += period;
        if (ch === 3 && ctrl & 0x80) this.stepNoise();
        else this.pos[ch] = (this.pos[ch] + 1) & 31;
      }
    }
    // スイープ（チャンネル 3）：(n + 1) × 8192 クロックごとに周波数を足す
    if (ctrl & 0x40) {
      this.sweepTimer -= cycles;
      while (this.sweepTimer <= 0) {
        this.sweepTimer += (io[0x8d] + 1) * 8192;
        const f = (this.freq(2) + ((io[0x8c] << 24) >> 24)) & 0x7ff;
        io[0x84] = f & 0xff;
        io[0x85] = f >> 8;
      }
    }

    // 出力（その間は一定とみなして平均する）
    let l = 0;
    let r = 0;
    const base = (io[0x8f] << 6) & 0xffff;
    for (let ch = 0; ch < 4; ch++) {
      if (!(ctrl & (1 << ch))) continue;
      const vol = io[0x88 + ch];
      if (ch === 1 && ctrl & 0x20) {
        // PCM：音量のレジスタがそのまま 8 ビットの音
        const v = io[0x89];
        const pv = io[0x94];
        l += pv & 0x08 ? v : pv & 0x04 ? v >> 1 : 0;
        r += pv & 0x02 ? v : pv & 0x01 ? v >> 1 : 0;
        continue;
      }
      let sample: number;
      if (ch === 3 && ctrl & 0x80) sample = this.noiseOut ? 15 : 0;
      else {
        const p = this.pos[ch];
        const b = this.ram[base + ch * 16 + (p >> 1)];
        sample = p & 1 ? b >> 4 : b & 15;
      }
      l += sample * (vol >> 4);
      r += sample * (vol & 15);
    }
    this.sumL += l * cycles;
    this.sumR += r * cycles;
    this.count += cycles;

    this.acc += cycles * this.sampleRate * this.rateAdjust;
    while (this.acc >= WS_CLOCK) {
      this.acc -= WS_CLOCK;
      this.emit();
    }
  }

  private stepNoise(): void {
    const tap = NOISE_TAP[this.io[0x8e] & 7];
    const bit = 1 ^ ((this.lfsr >> 7) & 1) ^ ((this.lfsr >> tap) & 1);
    this.lfsr = ((this.lfsr << 1) | bit) & 0x7fff;
    this.noiseOut = bit;
  }

  private emit(): void {
    if (this.count === 0) return;
    // 最大でだいたい 15 × 15 × 4 + 255 → 0〜0.5 くらいに
    let l = this.sumL / this.count / 2400;
    let r = this.sumR / this.count / 2400;
    this.sumL = this.sumR = this.count = 0;
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
