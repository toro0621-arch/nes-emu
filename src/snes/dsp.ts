// スーパーファミコンの音源（S-DSP）。BRR という形式で縮めた波形を 8 声で鳴らす。
// 音量の山（ADSR・ゲイン）、ノイズ、ピッチモジュレーション、エコー（8 タップの FIR）。32kHz で 1 サンプルずつ作る

/** 音量の山・ノイズの速さ（サンプル数ごとに 1 回） */
const RATES = [
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6,
  5, 4, 3, 2, 1,
];
const OFFSETS = [
  1, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0,
  1040, 536, 0, 1040, 0, 0,
];

/**
 * 4 つのサンプルをなめらかにつなぐ重み（ガウス関数で作る。実機の表に近い形）。
 * 小数部 f（0〜255）ごとに 4 つの重み、合計 2048
 */
const GAUSS = new Int16Array(256 * 4);
{
  const sigma = 0.63;
  for (let f = 0; f < 256; f++) {
    const t = f / 256;
    const d = [1 + t, t, 1 - t, 2 - t];
    const w = d.map((x) => Math.exp(-(x * x) / (2 * sigma * sigma)));
    const sum = w.reduce((a, b) => a + b, 0);
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const v = Math.round((w[k] / sum) * 2048);
      GAUSS[f * 4 + k] = v;
      total += v;
    }
    GAUSS[f * 4 + 1] += 2048 - total;
  }
}

const ENV_RELEASE = 0;
const ENV_ATTACK = 1;
const ENV_DECAY = 2;
const ENV_SUSTAIN = 3;

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

class Voice {
  /** デコードした 12 サンプル（リング） */
  buf = new Int16Array(12);
  bufPos = 0;
  interpPos = 0;
  brrAddr = 0;
  brrOffset = 1;
  env = 0;
  hiddenEnv = 0;
  envMode = ENV_RELEASE;
  konDelay = 0;
  out = 0;
}

export class SnesDsp {
  regs = new Uint8Array(128);
  private voices = [new Voice(), new Voice(), new Voice(), new Voice(), new Voice(), new Voice(), new Voice(), new Voice()];
  private counter = 0;
  private noise = 0x4000;
  /** キーオン待ち（次のサンプルで始める） */
  private konPending = 0;
  private everyOther = false;
  // エコー
  private echoOffset = 0;
  private echoLength = 0;
  private echoHistL = new Int16Array(8);
  private echoHistR = new Int16Array(8);
  private echoHistPos = 0;
  /** 作ったサンプル（32kHz、左右交互） */
  outL = 0;
  outR = 0;

  constructor(private ram: Uint8Array) {
    this.regs[0x6c] = 0xe0;
  }

  read(a: number): number {
    return this.regs[a & 0x7f];
  }

  write(a: number, v: number): void {
    if (a & 0x80) return; // $80〜$FF は読むだけ
    a &= 0x7f;
    this.regs[a] = v;
    if (a === 0x4c) this.konPending |= v;
    else if (a === 0x7c) this.regs[0x7c] = 0; // ENDX は書くと 0 になる
  }

  private readCounter(rate: number): boolean {
    if (rate === 0) return false;
    return (this.counter + OFFSETS[rate]) % RATES[rate] === 0;
  }

  private decodeBrr(v: Voice): void {
    const ram = this.ram;
    const header = ram[v.brrAddr];
    const shift = header >> 4;
    const filter = (header >> 2) & 3;
    const b0 = ram[(v.brrAddr + v.brrOffset) & 0xffff];
    const b1 = ram[(v.brrAddr + v.brrOffset + 1) & 0xffff];
    let nyb = (b0 << 8) | b1;
    const buf = v.buf;
    for (let k = 0; k < 4; k++, nyb <<= 4) {
      let s = ((nyb & 0xf000) << 16) >> 28; // 上の 4 ビットを符号つきで
      s = (s << shift) >> 1;
      if (shift >= 13) s = s < 0 ? -2048 : 0;
      const pos = v.bufPos;
      const p1 = buf[(pos + 11) % 12];
      const p2 = buf[(pos + 10) % 12] >> 1;
      if (filter === 1) {
        s += p1 >> 1;
        s += -p1 >> 5;
      } else if (filter === 2) {
        s += p1;
        s -= p2;
        s += p2 >> 4;
        s += (p1 * -3) >> 6;
      } else if (filter === 3) {
        s += p1;
        s -= p2;
        s += (p1 * -13) >> 7;
        s += (p2 * 3) >> 4;
      }
      s = clamp16(s);
      buf[pos] = (s * 2) << 16 >> 16;
      v.bufPos = pos + 1 === 12 ? 0 : pos + 1;
    }
  }

  /** 次のブロックへ進む（終わりの印があれば、ループするか止める） */
  private nextBrr(v: Voice, idx: number): void {
    v.brrOffset += 2;
    if (v.brrOffset < 9) return;
    const header = this.ram[v.brrAddr];
    if (header & 1) {
      this.regs[0x7c] |= 1 << idx;
      const dir = (this.regs[0x5d] << 8) + this.regs[idx * 16 + 4] * 4;
      v.brrAddr = this.ram[(dir + 2) & 0xffff] | (this.ram[(dir + 3) & 0xffff] << 8);
      if (!(header & 2)) {
        v.envMode = ENV_RELEASE;
        v.env = 0;
      }
    } else v.brrAddr = (v.brrAddr + 9) & 0xffff;
    v.brrOffset = 1;
  }

  private runEnvelope(v: Voice, idx: number): void {
    const r = this.regs;
    let env = v.env;
    if (v.envMode === ENV_RELEASE) {
      env -= 8;
      v.env = env < 0 ? 0 : env;
      return;
    }
    const adsr1 = r[idx * 16 + 5];
    let rate: number;
    let data: number;
    if (adsr1 & 0x80) {
      data = r[idx * 16 + 6];
      if (v.envMode >= ENV_DECAY) {
        env--;
        env -= env >> 8;
        rate = data & 0x1f;
        if (v.envMode === ENV_DECAY) rate = ((adsr1 >> 3) & 0x0e) + 0x10;
      } else {
        rate = (adsr1 & 0x0f) * 2 + 1;
        env += rate < 31 ? 0x20 : 0x400;
      }
    } else {
      data = r[idx * 16 + 7];
      const mode = data >> 5;
      if (mode < 4) {
        env = data * 0x10;
        rate = 31;
      } else {
        rate = data & 0x1f;
        if (mode === 4) env -= 0x20;
        else if (mode === 5) {
          env--;
          env -= env >> 8;
        } else {
          env += 0x20;
          if (mode === 7 && v.hiddenEnv >= 0x600) env += 0x8 - 0x20;
        }
      }
    }
    if (env >> 8 === data >> 5 && v.envMode === ENV_DECAY) v.envMode = ENV_SUSTAIN;
    v.hiddenEnv = env;
    if (env < 0 || env > 0x7ff) {
      env = env < 0 ? 0 : 0x7ff;
      if (v.envMode === ENV_ATTACK) v.envMode = ENV_DECAY;
    }
    if (this.readCounter(rate)) v.env = env;
  }

  /** 1 サンプル（32kHz）を作る。結果は outL・outR */
  sample(): void {
    const r = this.regs;
    const ram = this.ram;
    // 全体のカウンタ
    if (--this.counter < 0) this.counter = 0x77ff;
    // ノイズ
    if (this.readCounter(r[0x6c] & 0x1f)) {
      const n = this.noise;
      this.noise = (n >> 1) | (((n << 14) ^ (n << 13)) & 0x4000);
    }
    const flg = r[0x6c];
    // キーオン・キーオフ（2 サンプルに 1 回）
    this.everyOther = !this.everyOther;
    if (this.everyOther) {
      const kon = this.konPending;
      this.konPending = 0;
      const koff = r[0x5c];
      for (let i = 0; i < 8; i++) {
        const v = this.voices[i];
        if (kon & (1 << i)) {
          v.konDelay = 5;
          const dir = (r[0x5d] << 8) + r[i * 16 + 4] * 4;
          v.brrAddr = ram[dir & 0xffff] | (ram[(dir + 1) & 0xffff] << 8);
          v.brrOffset = 1;
          v.bufPos = 0;
          v.interpPos = 0;
          v.env = 0;
          v.hiddenEnv = 0;
          v.envMode = ENV_ATTACK;
          this.regs[0x7c] &= ~(1 << i);
        } else if (koff & (1 << i)) v.envMode = ENV_RELEASE;
      }
    }
    if (flg & 0x80) {
      for (const v of this.voices) {
        v.envMode = ENV_RELEASE;
        v.env = 0;
      }
    }

    const pmon = r[0x2d];
    const non = r[0x3d];
    const eon = r[0x4d];
    let mainL = 0;
    let mainR = 0;
    let echoL = 0;
    let echoR = 0;
    let prevOut = 0;
    const noiseOut = ((this.noise << 1) << 16) >> 16;
    for (let i = 0; i < 8; i++) {
      const v = this.voices[i];
      const base = i * 16;
      let output = 0;
      if (v.konDelay > 0) {
        // キーオンの直後：最初のブロックを読み込む間は音を出さない
        if (v.konDelay <= 3) {
          this.decodeBrr(v);
          this.nextBrr(v, i);
        }
        v.konDelay--;
        v.interpPos = 0;
        v.env = 0;
        r[base + 8] = 0;
        r[base + 9] = 0;
        v.out = 0;
        prevOut = 0;
        continue;
      }
      // 波形の補間（ガウス）
      if (non & (1 << i)) output = noiseOut;
      else {
        const f = ((v.interpPos >> 4) & 0xff) * 4;
        const p = (v.interpPos >> 12) + v.bufPos;
        const buf = v.buf;
        let o = (GAUSS[f] * buf[p % 12]) >> 11;
        o += (GAUSS[f + 1] * buf[(p + 1) % 12]) >> 11;
        o += (GAUSS[f + 2] * buf[(p + 2) % 12]) >> 11;
        o = (o << 16) >> 16;
        o += (GAUSS[f + 3] * buf[(p + 3) % 12]) >> 11;
        output = clamp16(o) & ~1;
      }
      output = ((output * v.env) >> 11) & ~1;
      v.out = output;
      r[base + 8] = v.env >> 4;
      r[base + 9] = (output >> 8) & 0xff;

      // 音量
      const vl = (r[base] << 24) >> 24;
      const vr = (r[base + 1] << 24) >> 24;
      const l = (output * vl) >> 7;
      const rr = (output * vr) >> 7;
      mainL = clamp16(mainL + l);
      mainR = clamp16(mainR + rr);
      if (eon & (1 << i)) {
        echoL = clamp16(echoL + l);
        echoR = clamp16(echoR + rr);
      }

      this.runEnvelope(v, i);

      // 音の高さ（前の声の出力で揺らすこともある）
      let pitch = (r[base + 2] | (r[base + 3] << 8)) & 0x3fff;
      if (i > 0 && pmon & (1 << i)) pitch += ((prevOut >> 5) * pitch) >> 10;
      prevOut = output;
      let pos = (v.interpPos & 0x3fff) + pitch;
      if (pos > 0x7fff) pos = 0x7fff;
      v.interpPos = pos;
      if (v.interpPos >= 0x4000) {
        this.decodeBrr(v);
        this.nextBrr(v, i);
      }
    }

    // エコー
    const esa = r[0x6d] << 8;
    if (this.echoOffset === 0) this.echoLength = (r[0x7d] & 0x0f) * 0x800;
    const ea = (esa + this.echoOffset) & 0xffff;
    const hp = (this.echoHistPos + 1) & 7;
    this.echoHistPos = hp;
    this.echoHistL[hp] = ((ram[ea] | (ram[(ea + 1) & 0xffff] << 8)) << 16) >> 17;
    this.echoHistR[hp] = ((ram[(ea + 2) & 0xffff] | (ram[(ea + 3) & 0xffff] << 8)) << 16) >> 17;
    let firL = 0;
    let firR = 0;
    for (let k = 0; k < 8; k++) {
      const c = (r[k * 16 + 0x0f] << 24) >> 24;
      const h = (hp + 1 + k) & 7;
      firL += (this.echoHistL[h] * c) >> 6;
      firR += (this.echoHistR[h] * c) >> 6;
      if (k === 6) {
        firL = (firL << 16) >> 16;
        firR = (firR << 16) >> 16;
      }
    }
    firL = clamp16(firL) & ~1;
    firR = clamp16(firR) & ~1;

    const mvl = (r[0x0c] << 24) >> 24;
    const mvr = (r[0x1c] << 24) >> 24;
    const evl = (r[0x2c] << 24) >> 24;
    const evr = (r[0x3c] << 24) >> 24;
    let outL = clamp16(((mainL * mvl) >> 7) + ((firL * evl) >> 7));
    let outR = clamp16(((mainR * mvr) >> 7) + ((firR * evr) >> 7));
    if (flg & 0x40) outL = outR = 0;
    this.outL = outL;
    this.outR = outR;

    // エコーのバッファへ書き戻す
    const efb = (r[0x0d] << 24) >> 24;
    if (!(flg & 0x20)) {
      const wl = clamp16(echoL + ((firL * efb) >> 7)) & ~1;
      const wr = clamp16(echoR + ((firR * efb) >> 7)) & ~1;
      ram[ea] = wl & 0xff;
      ram[(ea + 1) & 0xffff] = (wl >> 8) & 0xff;
      ram[(ea + 2) & 0xffff] = wr & 0xff;
      ram[(ea + 3) & 0xffff] = (wr >> 8) & 0xff;
    }
    this.echoOffset += 4;
    if (this.echoOffset >= this.echoLength) this.echoOffset = 0;
  }
}
