// オーディオスレッドで動く再生器。メインスレッドから届いた音をリングバッファにためて流す

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

const SIZE = 1 << 15;
const MASK = SIZE - 1;

class NesAudioProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(SIZE);
  private read = 0;
  private count = 0;
  private last = 0;
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
    // たまりすぎたら（0.25 秒超）古いほうを捨てて遅延を戻す
    const max = Math.floor(sampleRate * 0.25);
    if (this.count + data.length > max) {
      const drop = this.count + data.length - max;
      this.read = (this.read + Math.min(drop, this.count)) & MASK;
      this.count = Math.max(0, this.count - drop);
    }
    let w = (this.read + this.count) & MASK;
    for (let i = 0; i < data.length; i++) {
      this.buf[w] = data[i];
      w = (w + 1) & MASK;
    }
    this.count = Math.min(SIZE, this.count + data.length);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const ch0 = out[0];
    if (this.waiting && this.count >= this.resumeAt) this.waiting = false;
    for (let i = 0; i < ch0.length; i++) {
      if (!this.waiting && this.count > 0) {
        this.last = this.buf[this.read];
        this.read = (this.read + 1) & MASK;
        this.count--;
      } else {
        // 足りないときは最後の値からゆっくり 0 へ（ブツッという音を防ぐ）
        this.last *= 0.995;
        if (!this.waiting) {
          this.waiting = true;
          this.underruns++;
        }
      }
      ch0[i] = this.last;
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);

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
