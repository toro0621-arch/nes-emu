// スーパーファミコンの音の部分（SPC700 + DSP + 64K バイトのメモリ + タイマー 3 つ）。
// 本体の CPU とは 4 つのポート（$2140〜$2143 ⇔ $F4〜$F7）でやりとりする

import { SnesDsp } from './dsp';
import { Spc700 } from './spc700';

/**
 * 起動用の小さなプログラム（$FFC0〜$FFFF）。本体の CPU からプログラムを受け取って動かす。
 * 実機の IPL と同じやりとり（$AA・$BB を出して待つ → $CC で開始 → 番号つきで 1 バイトずつ受け取る）を、
 * このエミュレータのために書いたもの
 */
const IPL = new Uint8Array([
  0xcd, 0xef, //       mov x,#$EF
  0xbd, //             mov sp,x
  0xe8, 0x00, //       mov a,#0
  0xc6, //       clr:  mov (x),a        ; $01〜$EF を 0 に
  0x1d, //             dec x
  0xd0, 0xfc, //       bne clr
  0x8f, 0xaa, 0xf4, // mov $F4,#$AA     ; 準備できた印
  0x8f, 0xbb, 0xf5, // mov $F5,#$BB
  0x78, 0xcc, 0xf4, // hs:  cmp $F4,#$CC
  0xd0, 0xfb, //       bne hs
  0xba, 0xf6, //  cmd: movw ya,$F6      ; 書き込み先（または飛び先）
  0xda, 0x00, //       movw $00,ya
  0xe4, 0xf4, //       mov a,$F4        ; 合図の値
  0xeb, 0xf5, //       mov y,$F5        ; 0 なら実行、それ以外なら受け取り
  0xc4, 0xf4, //       mov $F4,a        ; 合図を返す
  0xf0, 0x19, //       beq exec
  0xeb, 0xf4, //  w0:  mov y,$F4        ; 番号 0 が来るまで待つ
  0xd0, 0xfc, //       bne w0
  0x7e, 0xf4, // loop: cmp y,$F4
  0xf0, 0x04, //       beq byte
  0x10, 0xfa, //       bpl loop         ; まだ前の番号
  0x2f, 0xe8, //       bra cmd          ; 番号が飛んだら次の命令
  0xe4, 0xf5, // byte: mov a,$F5
  0xcb, 0xf4, //       mov $F4,y        ; 受け取った番号を返す
  0xd7, 0x00, //       mov [$00]+y,a
  0xfc, //             inc y
  0xd0, 0xef, //       bne loop
  0xab, 0x01, //       inc $01
  0x2f, 0xeb, //       bra loop
  0x1f, 0x00, 0x00, // exec: jmp [$0000+x]   ; x = 0
  0x00, 0x00,
  0xc0, 0xff, //       リセットのベクタ
]);

/** 本体のマスタークロック（21.477MHz）1 つあたりの SPC700 のサイクル数 */
const SPC_PER_MASTER = 1024000 / 21477272;

export class SnesApu {
  ram = new Uint8Array(0x10000);
  readonly dsp: SnesDsp;
  readonly spc: Spc700;
  /** 本体 → 音（$2140〜$2143 に書いた値） */
  portIn = new Uint8Array(4);
  /** 音 → 本体 */
  portOut = new Uint8Array(4);
  private control = 0xb0;
  private dspAddr = 0;
  private timerTarget = new Uint8Array(3);
  private timerStage = new Uint8Array(3);
  private timerOut = new Uint8Array(3);
  private timerDiv = new Int32Array(3);
  private budget = 0;
  /** DSP のサンプルまでのサイクル */
  private sampleClock = 0;

  // 出力（32kHz を出力の周波数に変える）
  sampleRate = 48000;
  rateAdjust = 1;
  stereo = false;
  spread = 1;
  samples = new Float32Array(8192);
  sampleLength = 0;
  private resample = 0;
  private prevL = 0;
  private prevR = 0;

  constructor() {
    this.dsp = new SnesDsp(this.ram);
    this.spc = new Spc700(this);
    this.spc.pc = 0xffc0;
  }

  read(a: number): number {
    if (a >= 0xf0 && a < 0x100) {
      switch (a) {
        case 0xf2:
          return this.dspAddr;
        case 0xf3:
          return this.dsp.read(this.dspAddr);
        case 0xf4:
        case 0xf5:
        case 0xf6:
        case 0xf7:
          return this.portIn[a - 0xf4];
        case 0xf8:
        case 0xf9:
          return this.ram[a];
        case 0xfd:
        case 0xfe:
        case 0xff: {
          const t = a - 0xfd;
          const v = this.timerOut[t];
          this.timerOut[t] = 0;
          return v;
        }
      }
      return 0;
    }
    if (a >= 0xffc0 && this.control & 0x80) return IPL[a - 0xffc0];
    return this.ram[a];
  }

  write(a: number, v: number): void {
    if (a >= 0xf0 && a < 0x100) {
      switch (a) {
        case 0xf1:
          for (let t = 0; t < 3; t++) {
            if (!(this.control & (1 << t)) && v & (1 << t)) {
              this.timerStage[t] = 0;
              this.timerOut[t] = 0;
            }
          }
          if (v & 0x10) this.portIn[0] = this.portIn[1] = 0;
          if (v & 0x20) this.portIn[2] = this.portIn[3] = 0;
          this.control = v;
          break;
        case 0xf2:
          this.dspAddr = v;
          break;
        case 0xf3:
          this.dsp.write(this.dspAddr, v);
          break;
        case 0xf4:
        case 0xf5:
        case 0xf6:
        case 0xf7:
          this.portOut[a - 0xf4] = v;
          break;
        case 0xfa:
        case 0xfb:
        case 0xfc:
          this.timerTarget[a - 0xfa] = v;
          break;
      }
    }
    // メモリには常に書く（$F0〜$FF の下にも RAM がある）
    this.ram[a] = v;
  }

  /** 本体のマスタークロック n 個ぶん進める */
  runMaster(n: number): void {
    this.budget += n * SPC_PER_MASTER;
    const spc = this.spc;
    while (this.budget > 0) {
      const c = spc.step();
      this.budget -= c;
      this.tick(c);
    }
  }

  private tick(c: number): void {
    // タイマー（0・1 は 128 サイクル、2 は 16 サイクルごと）
    for (let t = 0; t < 3; t++) {
      this.timerDiv[t] += c;
      const div = t === 2 ? 16 : 128;
      while (this.timerDiv[t] >= div) {
        this.timerDiv[t] -= div;
        if (!(this.control & (1 << t))) continue;
        this.timerStage[t]++;
        if ((this.timerStage[t] & 0xff) === this.timerTarget[t]) {
          this.timerStage[t] = 0;
          this.timerOut[t] = (this.timerOut[t] + 1) & 15;
        }
      }
    }
    // DSP は 32 サイクルごとに 1 サンプル
    this.sampleClock += c;
    while (this.sampleClock >= 32) {
      this.sampleClock -= 32;
      this.dsp.sample();
      this.output(this.dsp.outL, this.dsp.outR);
    }
  }

  /** 32kHz のサンプルを出力の周波数に合わせて（間をつないで）書き出す */
  private output(l: number, r: number): void {
    const step = 32000 / (this.sampleRate * this.rateAdjust);
    while (this.resample < 1) {
      const t = this.resample;
      let ol = ((this.prevL + (l - this.prevL) * t) / 32768) * 0.7;
      let or = ((this.prevR + (r - this.prevR) * t) / 32768) * 0.7;
      const m = (ol + or) / 2;
      const side = ((ol - or) / 2) * (this.stereo ? this.spread : 0);
      ol = m + side;
      or = m - side;
      if (!this.stereo) {
        if (this.sampleLength < this.samples.length) this.samples[this.sampleLength++] = ol;
      } else if (this.sampleLength + 1 < this.samples.length) {
        this.samples[this.sampleLength++] = ol;
        this.samples[this.sampleLength++] = or;
      }
      this.resample += step;
    }
    this.resample -= 1;
    this.prevL = l;
    this.prevR = r;
  }

  takeSamples(): Float32Array {
    const out = this.samples.slice(0, this.sampleLength);
    this.sampleLength = 0;
    return out;
  }
}
