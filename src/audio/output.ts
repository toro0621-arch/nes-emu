import workletUrl from './worklet.ts?worker&url';

// Web Audio への出力。スマホではユーザー操作のあとでないと音が出せないので、最初のタップで start() する
export class AudioOutput {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private starting: Promise<void> | null = null;
  /** オーディオスレッドにたまっている音の数 */
  queued = 0;
  /** 音が途切れた回数（累計、確認用） */
  underruns = 0;
  muted = false;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get running(): boolean {
    return this.node !== null && this.ctx?.state === 'running';
  }

  start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      return this.starting ?? Promise.resolve();
    }
    // AudioContext はユーザー操作の中で同期的に作る（iOS の制約）
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    void ctx.resume();
    this.starting = (async () => {
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'nes-audio', { numberOfInputs: 0, outputChannelCount: [1] });
      node.port.onmessage = (e: MessageEvent<{ queued: number; underruns: number }>) => {
        this.queued = e.data.queued;
        this.underruns = e.data.underruns;
      };
      const gain = ctx.createGain();
      gain.gain.value = this.muted ? 0 : 1;
      node.connect(gain).connect(ctx.destination);
      this.node = node;
      this.gain = gain;
    })();
    return this.starting;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  push(samples: Float32Array): void {
    if (!this.node || samples.length === 0) return;
    this.queued += samples.length;
    this.node.port.postMessage(samples, [samples.buffer]);
  }

  /**
   * 音を作る速さの補正値。ためている量が目標（約 80ms）より少なければ少し多めに、
   * 多ければ少なめに作らせて、画面と音がずれていかないようにする（±0.5% まで）
   */
  rateAdjust(): number {
    const target = this.sampleRate * 0.08;
    const err = (target - this.queued) / target;
    return 1 + Math.max(-1, Math.min(1, err)) * 0.005;
  }
}
