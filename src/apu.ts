// APU（2A03 の音源）。CPU 1 サイクルごとに tick() する
export const CPU_HZ = 1789773;

const LENGTH_TABLE = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
];
const DUTY = [
  [0, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 0, 0, 0],
  [1, 0, 0, 1, 1, 1, 1, 1],
];
const TRIANGLE = [
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];
const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

// ミキサー（実機の非線形な足し算を表にしたもの）
const PULSE_MIX = Float32Array.from({ length: 31 }, (_, n) => (n ? 95.52 / (8128 / n + 100) : 0));
const TND_MIX = Float32Array.from({ length: 203 }, (_, n) => (n ? 163.67 / (24329 / n + 100) : 0));

export const IRQ_FRAME = 1;
export const IRQ_DMC = 2;

/** 音量の包絡線（矩形波・ノイズ共通） */
class Envelope {
  start = false;
  loop = false;
  constant = false;
  volume = 0;
  private divider = 0;
  private decay = 0;

  clock(): void {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.volume;
    } else if (this.divider > 0) {
      this.divider--;
    } else {
      this.divider = this.volume;
      if (this.decay > 0) this.decay--;
      else if (this.loop) this.decay = 15;
    }
  }

  output(): number {
    return this.constant ? this.volume : this.decay;
  }
}

export class Pulse {
  enabled = false;
  length = 0;
  halt = false;
  env = new Envelope();
  private duty = 0;
  private step = 0;
  period = 0;
  private timer = 0;
  // スイープ
  private sweepOn = false;
  private sweepPeriod = 0;
  private sweepNegate = false;
  private sweepShift = 0;
  private sweepDivider = 0;
  private sweepReload = false;
  /** 周期が短すぎる・スイープ先が範囲外で音が出ない（周期かスイープが変わったときに計算し直す） */
  private silenced = true;

  /**
   * second: 矩形波 2（スイープの負方向の計算が 1 違う）
   * noSweep: スイープのない矩形波（MMC5 の拡張音源）。周期による消音もない
   */
  constructor(
    private second: boolean,
    private noSweep = false,
  ) {}

  write(reg: number, v: number): void {
    switch (reg) {
      case 0:
        this.duty = v >> 6;
        this.halt = this.env.loop = (v & 0x20) !== 0;
        this.env.constant = (v & 0x10) !== 0;
        this.env.volume = v & 0x0f;
        break;
      case 1:
        this.sweepOn = (v & 0x80) !== 0;
        this.sweepPeriod = (v >> 4) & 7;
        this.sweepNegate = (v & 0x08) !== 0;
        this.sweepShift = v & 7;
        this.sweepReload = true;
        break;
      case 2:
        this.period = (this.period & 0x700) | v;
        break;
      case 3:
        this.period = (this.period & 0xff) | ((v & 7) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        this.step = 0;
        this.env.start = true;
        break;
    }
    this.updateSilenced();
  }

  private updateSilenced(): void {
    this.silenced = !this.noSweep && (this.period < 8 || this.sweepTarget() > 0x7ff);
  }

  /** APU サイクル（CPU 2 サイクル）ごと */
  clockTimer(): void {
    if (this.timer === 0) {
      this.timer = this.period;
      this.step = (this.step + 1) & 7;
    } else this.timer--;
  }

  private sweepTarget(): number {
    const delta = this.period >> this.sweepShift;
    if (!this.sweepNegate) return this.period + delta;
    return this.period - delta - (this.second ? 0 : 1);
  }

  clockSweep(): void {
    if (this.sweepDivider === 0 && this.sweepOn && this.sweepShift > 0 && !this.silenced) {
      this.period = Math.max(0, this.sweepTarget());
      this.updateSilenced();
    }
    if (this.sweepDivider === 0 || this.sweepReload) {
      this.sweepDivider = this.sweepPeriod;
      this.sweepReload = false;
    } else this.sweepDivider--;
  }

  clockLength(): void {
    if (this.length > 0 && !this.halt) this.length--;
  }

  output(): number {
    if (this.length === 0 || this.silenced || !DUTY[this.duty][this.step]) return 0;
    return this.env.output();
  }
}

class Triangle {
  enabled = false;
  length = 0;
  private control = false;
  private linearLoad = 0;
  private linear = 0;
  private linearReload = false;
  private period = 0;
  private timer = 0;
  private step = 0;

  write(reg: number, v: number): void {
    switch (reg) {
      case 0:
        this.control = (v & 0x80) !== 0;
        this.linearLoad = v & 0x7f;
        break;
      case 2:
        this.period = (this.period & 0x700) | v;
        break;
      case 3:
        this.period = (this.period & 0xff) | ((v & 7) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        this.linearReload = true;
        break;
    }
  }

  /** CPU サイクルごと */
  clockTimer(): void {
    if (this.timer === 0) {
      this.timer = this.period;
      // 周期が極端に短い（超音波）ときは止めて、プチプチ音を防ぐ
      if (this.length > 0 && this.linear > 0 && this.period >= 2) this.step = (this.step + 1) & 31;
    } else this.timer--;
  }

  clockLinear(): void {
    if (this.linearReload) this.linear = this.linearLoad;
    else if (this.linear > 0) this.linear--;
    if (!this.control) this.linearReload = false;
  }

  clockLength(): void {
    if (this.length > 0 && !this.control) this.length--;
  }

  output(): number {
    return TRIANGLE[this.step];
  }
}

class Noise {
  enabled = false;
  length = 0;
  halt = false;
  env = new Envelope();
  private mode = false;
  private period = NOISE_PERIOD[0];
  private timer = 0;
  private shift = 1;

  write(reg: number, v: number): void {
    switch (reg) {
      case 0:
        this.halt = this.env.loop = (v & 0x20) !== 0;
        this.env.constant = (v & 0x10) !== 0;
        this.env.volume = v & 0x0f;
        break;
      case 2:
        this.mode = (v & 0x80) !== 0;
        this.period = NOISE_PERIOD[v & 0x0f];
        break;
      case 3:
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        this.env.start = true;
        break;
    }
  }

  /** CPU サイクルごと（周期表は CPU サイクル単位） */
  clockTimer(): void {
    if (this.timer === 0) {
      this.timer = this.period - 1;
      const fb = (this.shift ^ (this.shift >> (this.mode ? 6 : 1))) & 1;
      this.shift = (this.shift >> 1) | (fb << 14);
    } else this.timer--;
  }

  clockLength(): void {
    if (this.length > 0 && !this.halt) this.length--;
  }

  output(): number {
    if (this.length === 0 || this.shift & 1) return 0;
    return this.env.output();
  }
}

/** DMC：メモリ上の 1 ビット差分のサンプルを再生する */
class Dmc {
  irqEnabled = false;
  irqFlag = false;
  private loop = false;
  private rate = DMC_RATE[0];
  private timer = 0;
  level = 0;
  private sampleAddr = 0xc000;
  private sampleLen = 1;
  addr = 0xc000;
  remaining = 0;
  private buffer = 0;
  private bufferEmpty = true;
  private shift = 0;
  private bits = 8;
  private silent = true;

  constructor(
    private readMem: (addr: number) => number,
    private stallCpu: (cycles: number) => void,
  ) {}

  write(reg: number, v: number): void {
    switch (reg) {
      case 0:
        this.irqEnabled = (v & 0x80) !== 0;
        if (!this.irqEnabled) this.irqFlag = false;
        this.loop = (v & 0x40) !== 0;
        this.rate = DMC_RATE[v & 0x0f];
        break;
      case 1:
        this.level = v & 0x7f;
        break;
      case 2:
        this.sampleAddr = 0xc000 | (v << 6);
        break;
      case 3:
        this.sampleLen = (v << 4) | 1;
        break;
    }
  }

  setEnabled(on: boolean): void {
    if (!on) this.remaining = 0;
    else if (this.remaining === 0) {
      this.restart();
      this.fill();
    }
  }

  private restart(): void {
    this.addr = this.sampleAddr;
    this.remaining = this.sampleLen;
  }

  /** バッファが空なら次の 1 バイトを読む（そのあいだ CPU は止まる） */
  private fill(): void {
    if (!this.bufferEmpty || this.remaining === 0) return;
    this.stallCpu(4);
    this.buffer = this.readMem(this.addr);
    this.bufferEmpty = false;
    this.addr = this.addr === 0xffff ? 0x8000 : this.addr + 1;
    if (--this.remaining === 0) {
      if (this.loop) this.restart();
      else if (this.irqEnabled) this.irqFlag = true;
    }
  }

  /** CPU サイクルごと */
  clockTimer(): void {
    if (this.timer > 0) {
      this.timer--;
      return;
    }
    this.timer = this.rate - 1;
    if (!this.silent) {
      if (this.shift & 1) {
        if (this.level <= 125) this.level += 2;
      } else if (this.level >= 2) this.level -= 2;
    }
    this.shift >>= 1;
    if (--this.bits === 0) {
      this.bits = 8;
      if (this.bufferEmpty) this.silent = true;
      else {
        this.silent = false;
        this.shift = this.buffer;
        this.bufferEmpty = true;
        this.fill();
      }
    }
  }
}

export class Apu {
  private pulse1 = new Pulse(false);
  private pulse2 = new Pulse(true);
  private triangle = new Triangle();
  private noise = new Noise();
  private dmc: Dmc;

  // フレームカウンタ
  private fiveStep = false;
  private irqInhibit = false;
  private frameIrq = false;
  private frameCycle = 0;
  /** $4017 を書いてからリセットまでの残りサイクル */
  private frameResetDelay = 0;
  private pending4017 = 0;
  private cycle = 0;

  // 音の出力
  sampleRate = 48000;
  /** 出力の速さの微調整（バッファがたまりすぎ・足りなさすぎを防ぐ） */
  rateAdjust = 1;
  private sampleAcc = 0;
  private sampleSum = 0;
  private sampleCount = 0;
  private hpPrev = 0;
  private hpOut = 0;
  private lpOut = 0;
  /** 出力した音（呼び出し側が取り出す） */
  samples = new Float32Array(4096);
  sampleLength = 0;
  /** カートリッジの拡張音源（なければ null） */
  expansion: (() => number) | null = null;

  constructor(
    readMem: (addr: number) => number,
    stallCpu: (cycles: number) => void,
    private setIrq: (source: number, on: boolean) => void,
  ) {
    this.dmc = new Dmc(readMem, stallCpu);
  }

  write(addr: number, v: number): void {
    if (addr < 0x4004) this.pulse1.write(addr & 3, v);
    else if (addr < 0x4008) this.pulse2.write(addr & 3, v);
    else if (addr < 0x400c) this.triangle.write(addr & 3, v);
    else if (addr < 0x4010) this.noise.write(addr & 3, v);
    else if (addr < 0x4014) {
      this.dmc.write(addr & 3, v);
      this.updateIrq();
    } else if (addr === 0x4015) {
      this.pulse1.enabled = (v & 1) !== 0;
      this.pulse2.enabled = (v & 2) !== 0;
      this.triangle.enabled = (v & 4) !== 0;
      this.noise.enabled = (v & 8) !== 0;
      if (!this.pulse1.enabled) this.pulse1.length = 0;
      if (!this.pulse2.enabled) this.pulse2.length = 0;
      if (!this.triangle.enabled) this.triangle.length = 0;
      if (!this.noise.enabled) this.noise.length = 0;
      this.dmc.irqFlag = false;
      this.dmc.setEnabled((v & 0x10) !== 0);
      this.updateIrq();
    } else if (addr === 0x4017) {
      this.pending4017 = v;
      // 書き込みが APU サイクルの途中なら 3 サイクル後、そうでなければ 4 サイクル後に反映
      this.frameResetDelay = this.cycle & 1 ? 4 : 3;
      this.irqInhibit = (v & 0x40) !== 0;
      if (this.irqInhibit) {
        this.frameIrq = false;
        this.updateIrq();
      }
    }
  }

  readStatus(): number {
    const r =
      (this.pulse1.length > 0 ? 1 : 0) |
      (this.pulse2.length > 0 ? 2 : 0) |
      (this.triangle.length > 0 ? 4 : 0) |
      (this.noise.length > 0 ? 8 : 0) |
      (this.dmc.remaining > 0 ? 0x10 : 0) |
      (this.frameIrq ? 0x40 : 0) |
      (this.dmc.irqFlag ? 0x80 : 0);
    this.frameIrq = false;
    this.updateIrq();
    return r;
  }

  private updateIrq(): void {
    this.setIrq(IRQ_FRAME, this.frameIrq);
    this.setIrq(IRQ_DMC, this.dmc.irqFlag);
  }

  private quarterFrame(): void {
    this.pulse1.env.clock();
    this.pulse2.env.clock();
    this.noise.env.clock();
    this.triangle.clockLinear();
  }

  private halfFrame(): void {
    this.pulse1.clockLength();
    this.pulse2.clockLength();
    this.triangle.clockLength();
    this.noise.clockLength();
    this.pulse1.clockSweep();
    this.pulse2.clockSweep();
  }

  private clockFrameCounter(): void {
    const c = ++this.frameCycle;
    if (c === 7457) this.quarterFrame();
    else if (c === 14913) {
      this.quarterFrame();
      this.halfFrame();
    } else if (c === 22371) this.quarterFrame();
    else if (!this.fiveStep) {
      if (c === 29828) this.raiseFrameIrq();
      else if (c === 29829) {
        this.quarterFrame();
        this.halfFrame();
        this.raiseFrameIrq();
      } else if (c === 29830) {
        this.raiseFrameIrq();
        this.frameCycle = 0;
      }
    } else if (c === 37281) {
      this.quarterFrame();
      this.halfFrame();
    } else if (c === 37282) this.frameCycle = 0;
  }

  private raiseFrameIrq(): void {
    if (this.irqInhibit) return;
    this.frameIrq = true;
    this.setIrq(IRQ_FRAME, true);
  }

  /** CPU 1 サイクル進める */
  tick(): void {
    this.cycle++;
    if (this.frameResetDelay > 0 && --this.frameResetDelay === 0) {
      this.fiveStep = (this.pending4017 & 0x80) !== 0;
      this.frameCycle = 0;
      if (this.fiveStep) {
        this.quarterFrame();
        this.halfFrame();
      }
    } else this.clockFrameCounter();

    this.triangle.clockTimer();
    this.noise.clockTimer();
    const dmcIrq = this.dmc.irqFlag;
    this.dmc.clockTimer();
    if (this.dmc.irqFlag !== dmcIrq) this.updateIrq();

    // 矩形波と音のミックスは APU サイクル（CPU 2 サイクル）ごと
    if (this.cycle & 1) {
      this.pulse1.clockTimer();
      this.pulse2.clockTimer();
      this.mixSample();
    }
  }

  private mixSample(): void {
    this.sampleSum +=
      PULSE_MIX[this.pulse1.output() + this.pulse2.output()] +
      TND_MIX[3 * this.triangle.output() + 2 * this.noise.output() + this.dmc.level] +
      (this.expansion ? this.expansion() : 0);
    this.sampleCount++;
    this.sampleAcc += 2 * this.sampleRate * this.rateAdjust;
    if (this.sampleAcc < CPU_HZ) return;
    this.sampleAcc -= CPU_HZ;

    // その間の平均をとり（簡単なローパス）、実機と同じように直流分を落とす
    const x = this.sampleSum / this.sampleCount;
    this.sampleSum = 0;
    this.sampleCount = 0;
    this.hpOut = 0.996 * (this.hpOut + x - this.hpPrev); // 約 30Hz のハイパス
    this.hpPrev = x;
    this.lpOut += 0.6 * (this.hpOut - this.lpOut); // 約 14kHz のローパス
    if (this.sampleLength < this.samples.length) this.samples[this.sampleLength++] = this.lpOut;
  }

  /** たまった音を取り出す */
  takeSamples(): Float32Array {
    const out = this.samples.slice(0, this.sampleLength);
    this.sampleLength = 0;
    return out;
  }
}
