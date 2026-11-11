// オーディオスレッドで動く再生器。メインスレッドから届いた音（左・右が交互）をリングバッファにためて流す

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

const SIZE = 1 << 15;
const MASK = SIZE - 1;

class NesAudioProcessor extends AudioWorkletProcessor {
  private bufL = new Float32Array(SIZE);
  private bufR = new Float32Array(SIZE);
  private read = 0;
  /** たまっている音の数（左右 1 組で 1） */
  private count = 0;
  private lastL = 0;
  private lastR = 0;
  private sinceReport = 0;
  /** 音が途切れた回数（累計） */
  private underruns = 0;
  /** 足りなくなったら、ある程度たまるまで待ってから再生を再開する（細切れの途切れを防ぐ） */
  private waiting = true;
  private readonly resumeAt = Math.floor(sampleRate * 0.05);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data);
  }

  private push(data: Float32Array): void {
    const frames = data.length >> 1;
    // たまりすぎたら（0.25 秒超）古いほうを捨てて遅延を戻す
    const max = Math.floor(sampleRate * 0.25);
    if (this.count + frames > max) {
      const drop = this.count + frames - max;
      this.read = (this.read + Math.min(drop, this.count)) & MASK;
      this.count = Math.max(0, this.count - drop);
    }
    let w = (this.read + this.count) & MASK;
    for (let i = 0; i < frames; i++) {
      this.bufL[w] = data[i * 2];
      this.bufR[w] = data[i * 2 + 1];
      w = (w + 1) & MASK;
    }
    this.count = Math.min(SIZE, this.count + frames);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const ch0 = out[0];
    const ch1 = out[1];
    if (this.waiting && this.count >= this.resumeAt) this.waiting = false;
    for (let i = 0; i < ch0.length; i++) {
      if (!this.waiting && this.count > 0) {
        this.lastL = this.bufL[this.read];
        this.lastR = this.bufR[this.read];
        this.read = (this.read + 1) & MASK;
        this.count--;
      } else {
        // 足りないときは最後の値からゆっくり 0 へ（ブツッという音を防ぐ）
        this.lastL *= 0.995;
        this.lastR *= 0.995;
        if (!this.waiting) {
          this.waiting = true;
          this.underruns++;
        }
      }
      if (ch1) {
        ch0[i] = this.lastL;
        ch1[i] = this.lastR;
      } else ch0[i] = (this.lastL + this.lastR) / 2; // 出力がモノラルなら混ぜる
    }
    for (let c = 2; c < out.length; c++) out[c].set(ch0);

    // ためている量をときどきメインスレッドへ知らせる（速さの微調整に使う）
    this.sinceReport += ch0.length;
    if (this.sinceReport >= sampleRate / 20) {
      this.sinceReport = 0;
      this.port.postMessage({ queued: this.count, underruns: this.underruns });
    }
    return true;
  }
}

registerProcessor('nes-audio', NesAudioProcessor);
