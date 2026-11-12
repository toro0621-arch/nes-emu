// 音源（SPU）：512KB の音のメモリにある ADPCM の音を 24 声で鳴らす。
// 音量の変化（ADSR）、ノイズ、ピッチを揺らす機能、リバーブ（響き）、CD の音を混ぜる。44100Hz で作る

import type { CdAudio } from './cdrom';

const POS = [0, 60, 115, 98, 122, 0, 0, 0];
const NEG = [0, 0, -52, -55, -60, 0, 0, 0];

/** 4 つのサンプルをなめらかにつなぐ重み（小数部 0〜255 ごとに 4 つ、合計 32768） */
const GAUSS = new Int32Array(256 * 4);
{
  const sigma = 0.6;
  for (let f = 0; f < 256; f++) {
    const t = f / 256;
    const d = [1 + t, t, 1 - t, 2 - t];
    const w = d.map((x) => Math.exp(-(x * x) / (2 * sigma * sigma)));
    const sum = w.reduce((a, b) => a + b, 0);
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const v = Math.round((w[k] / sum) * 32768);
      GAUSS[f * 4 + k] = v;
      total += v;
    }
    GAUSS[f * 4 + 1] += 32768 - total;
  }
}

const enum Phase {
  Off,
  Attack,
  Decay,
  Sustain,
  Release,
}

class Voice {
  volL = 0;
  volR = 0;
  pitch = 0;
  start = 0;
  adsrLo = 0;
  adsrHi = 0;
  level = 0;
  repeat = 0;
  /** 今読んでいるブロックの位置（バイト） */
  addr = 0;
  counter = 0;
  phase = Phase.Off;
  private wait = 0;
  /** ほどいたサンプル（前の 3 つ + 28） */
  buf = new Int16Array(31);
  old = 0;
  older = 0;
  /** 鳴らした最後の値（次の声のピッチを揺らすのに使う） */
  out = 0;
  repeatSet = false;

  keyOn(): void {
    this.addr = this.start;
    this.counter = 0;
    this.phase = Phase.Attack;
    this.level = 0;
    this.wait = 0;
    this.old = this.older = 0;
    this.buf.fill(0);
    this.repeatSet = false;
    this.needBlock = true;
  }

  needBlock = true;

  /** ADSR を 1 サンプル進める */
  envelope(): void {
    if (this.phase === Phase.Off) return;
    let exp = false;
    let dec = false;
    let shift = 0;
    let step = 0;
    const lo = this.adsrLo;
    const hi = this.adsrHi;
    switch (this.phase) {
      case Phase.Attack:
        exp = (lo & 0x8000) !== 0;
        shift = (lo >> 10) & 31;
        step = 7 - ((lo >> 8) & 3);
        break;
      case Phase.Decay:
        exp = true;
        dec = true;
        shift = ((lo >> 4) & 15) * 4;
        step = -8;
        break;
      case Phase.Sustain:
        exp = (hi & 0x8000) !== 0;
        dec = (hi & 0x4000) !== 0;
        shift = (hi >> 8) & 31;
        step = dec ? -8 + ((hi >> 6) & 3) : 7 - ((hi >> 6) & 3);
        break;
      case Phase.Release:
        exp = (hi & 0x20) !== 0;
        dec = true;
        shift = (hi & 31) * 4;
        step = -8;
        break;
    }
    if (this.wait > 0) {
      this.wait--;
      return;
    }
    let cycles = 1 << Math.max(0, shift - 11);
    let st = step << Math.max(0, 11 - shift);
    if (exp && !dec && this.level > 0x6000) cycles *= 4;
    if (exp && dec) st = (st * this.level) >> 15;
    this.wait = cycles - 1;
    let lv = this.level + st;
    if (lv < 0) lv = 0;
    if (lv > 0x7fff) lv = 0x7fff;
    this.level = lv;
    switch (this.phase) {
      case Phase.Attack:
        if (lv >= 0x7fff) {
          this.phase = Phase.Decay;
          this.wait = 0;
        }
        break;
      case Phase.Decay:
        if (lv <= ((lo & 15) + 1) * 0x800) {
          this.phase = Phase.Sustain;
          this.wait = 0;
        }
        break;
      case Phase.Release:
        if (lv <= 0) {
          this.phase = Phase.Off;
          this.level = 0;
        }
        break;
    }
  }
}

export class Spu {
  ram = new Uint8Array(512 * 1024);
  ram16 = new Int16Array(this.ram.buffer);
  voices = Array.from({ length: 24 }, () => new Voice());
  regs = new Uint16Array(0x200);
  mainL = 0;
  mainR = 0;
  revL = 0;
  revR = 0;
  ctrl = 0;
  stat = 0;
  irqAddr = 0;
  transferAddr = 0;
  /** 書き込み途中の転送アドレス（バイト） */
  private taddr = 0;
  endx = 0;
  pmon = 0;
  non = 0;
  eon = 0;
  cdL = 0;
  cdR = 0;
  revBase = 0;
  private revAddr = 0;
  private revInL = 0;
  private revInR = 0;
  private revOutL = 0;
  private revOutR = 0;
  private odd = false;
  private noise = 1;
  private noiseCount = 0;
  private noiseLevel = 0;
  /** 最後に音を作った時刻 */
  last = 0;
  private cdBuf = new Int32Array(2);
  // 出力
  sampleRate = 48000;
  rateAdjust = 1;
  spread = 1;
  samples = new Float32Array(16384);
  sampleLength = 0;
  private resample = 0;
  private prevL = 0;
  private prevR = 0;

  constructor(
    private raiseIrq: () => void,
    private cd: CdAudio,
  ) {}

  // ---- レジスタ ----
  read(a: number): number {
    const r = (a & 0x3fe) >> 1;
    if (r < 0xc0) {
      const v = this.voices[r >> 3];
      if ((r & 7) === 6) return v.level;
      return this.regs[r];
    }
    switch (r) {
      case 0xce:
        return this.endx & 0xffff;
      case 0xcf:
        return this.endx >>> 16;
      case 0xd5:
        return this.ctrl;
      case 0xd7:
        return this.stat;
      case 0xd3:
        return this.transferAddr;
      case 0xdc:
        return this.mainL & 0xffff;
      case 0xdd:
        return this.mainR & 0xffff;
    }
    if (r >= 0x100 && r < 0x130) {
      const v = this.voices[(r - 0x100) >> 1];
      return r & 1 ? v.volR & 0xffff : v.volL & 0xffff;
    }
    return this.regs[r];
  }

  write(a: number, val: number): void {
    const r = (a & 0x3fe) >> 1;
    this.regs[r] = val;
    if (r < 0xc0) {
      const v = this.voices[r >> 3];
      switch (r & 7) {
        case 0:
          v.volL = vol(val);
          return;
        case 1:
          v.volR = vol(val);
          return;
        case 2:
          v.pitch = val;
          return;
        case 3:
          v.start = val * 8;
          return;
        case 4:
          v.adsrLo = val;
          return;
        case 5:
          v.adsrHi = val;
          return;
        case 6:
          v.level = val & 0x7fff;
          return;
        case 7:
          v.repeat = val * 8;
          v.repeatSet = true;
          return;
      }
    }
    switch (r) {
      case 0xc0:
        this.mainL = vol(val);
        return;
      case 0xc1:
        this.mainR = vol(val);
        return;
      case 0xc2:
        this.revL = (val << 16) >> 16;
        return;
      case 0xc3:
        this.revR = (val << 16) >> 16;
        return;
      case 0xc4:
        this.keys(val, 0, true);
        return;
      case 0xc5:
        this.keys(val, 16, true);
        return;
      case 0xc6:
        this.keys(val, 0, false);
        return;
      case 0xc7:
        this.keys(val, 16, false);
        return;
      case 0xc8:
        this.pmon = (this.pmon & 0xffff0000) | val;
        return;
      case 0xc9:
        this.pmon = (this.pmon & 0xffff) | (val << 16);
        return;
      case 0xca:
        this.non = (this.non & 0xffff0000) | val;
        return;
      case 0xcb:
        this.non = (this.non & 0xffff) | (val << 16);
        return;
      case 0xcc:
        this.eon = (this.eon & 0xffff0000) | val;
        return;
      case 0xcd:
        this.eon = (this.eon & 0xffff) | (val << 16);
        return;
      case 0xd1:
        this.revBase = val * 4; // ハーフワード単位
        this.revAddr = this.revBase;
        return;
      case 0xd2:
        this.irqAddr = val * 8;
        return;
      case 0xd3:
        this.transferAddr = val;
        this.taddr = val * 8;
        return;
      case 0xd4:
        this.checkIrq(this.taddr);
        this.ram16[(this.taddr >> 1) & 0x3ffff] = val;
        this.taddr = (this.taddr + 2) & 0x7ffff;
        return;
      case 0xd5:
        this.ctrl = val;
        if (!(val & 0x40)) this.stat &= ~0x40;
        this.stat = (this.stat & ~0x3f) | (val & 0x3f);
        return;
      case 0xd8:
        this.cdL = (val << 16) >> 16;
        return;
      case 0xd9:
        this.cdR = (val << 16) >> 16;
        return;
    }
  }

  private keys(val: number, base: number, on: boolean): void {
    for (let i = 0; i < 16 && base + i < 24; i++) {
      if (!(val & (1 << i))) continue;
      const v = this.voices[base + i];
      if (on) {
        v.keyOn();
        this.endx &= ~(1 << (base + i));
      } else if (v.phase !== Phase.Off) v.phase = Phase.Release;
    }
  }

  private checkIrq(addr: number): void {
    if (this.ctrl & 0x40 && (addr & ~7) === (this.irqAddr & ~7) && !(this.stat & 0x40)) {
      this.stat |= 0x40;
      this.raiseIrq();
    }
  }

  // ---- DMA ----
  dmaWrite(w: number): void {
    this.checkIrq(this.taddr);
    this.ram16[(this.taddr >> 1) & 0x3ffff] = w;
    this.taddr = (this.taddr + 2) & 0x7ffff;
    this.ram16[(this.taddr >> 1) & 0x3ffff] = w >>> 16;
    this.taddr = (this.taddr + 2) & 0x7ffff;
  }

  dmaRead(): number {
    const lo = this.ram16[(this.taddr >> 1) & 0x3ffff] & 0xffff;
    this.taddr = (this.taddr + 2) & 0x7ffff;
    const hi = this.ram16[(this.taddr >> 1) & 0x3ffff] & 0xffff;
    this.taddr = (this.taddr + 2) & 0x7ffff;
    return lo | (hi << 16);
  }

  // ---- 音を作る ----
  /** 今の時刻まで音を作る（768 クロックで 1 つ） */
  run(now: number): void {
    while (now - this.last >= 768) {
      this.last += 768;
      this.sample();
    }
  }

  private decodeBlock(v: Voice): void {
    const ram = this.ram;
    const a = v.addr & 0x7fff0;
    this.checkIrq(a);
    const hdr = ram[a];
    let shift = hdr & 15;
    if (shift > 12) shift = 9;
    const f = (hdr >> 4) & 7;
    const flags = ram[a + 1];
    if (flags & 4 && !v.repeatSet) v.repeat = a;
    const b = v.buf;
    b[0] = b[28];
    b[1] = b[29];
    b[2] = b[30];
    let old = v.old;
    let older = v.older;
    for (let i = 0; i < 28; i++) {
      const byte = ram[a + 2 + (i >> 1)];
      const nib = i & 1 ? byte >> 4 : byte & 15;
      let s = ((nib << 28) >> 16) >> shift;
      s += (old * POS[f] + older * NEG[f] + 32) >> 6;
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      b[3 + i] = s;
      older = old;
      old = s;
    }
    v.old = old;
    v.older = older;
  }

  private sample(): void {
    let sumL = 0;
    let sumR = 0;
    let revL = 0;
    let revR = 0;
    const on = (this.ctrl & 0x8000) !== 0;
    // ノイズ
    {
      const shift = (this.ctrl >> 10) & 15;
      const step = ((this.ctrl >> 8) & 3) + 4;
      this.noiseCount += step << 16 >> shift;
      while (this.noiseCount >= 0x10000) {
        this.noiseCount -= 0x10000;
        const p = ((this.noise >> 15) ^ (this.noise >> 12) ^ (this.noise >> 11) ^ (this.noise >> 10) ^ 1) & 1;
        this.noise = ((this.noise << 1) | p) & 0xffff;
      }
      this.noiseLevel = (this.noise << 16) >> 16;
    }
    for (let i = 0; i < 24; i++) {
      const v = this.voices[i];
      if (v.phase === Phase.Off) {
        v.out = 0;
        continue;
      }
      if (v.needBlock) {
        this.decodeBlock(v);
        v.needBlock = false;
      }
      // ガウス補間
      const f = (v.counter >> 4) & 0xff;
      const p = v.counter >> 12;
      const b = v.buf;
      let s =
        (GAUSS[f * 4] * b[p] + GAUSS[f * 4 + 1] * b[p + 1] + GAUSS[f * 4 + 2] * b[p + 2] + GAUSS[f * 4 + 3] * b[p + 3]) >> 15;
      if (this.non & (1 << i)) s = this.noiseLevel;
      const out = (s * v.level) >> 15;
      v.out = out;
      v.envelope();
      if (on) {
        const l = (out * v.volL) >> 15;
        const r = (out * v.volR) >> 15;
        sumL += l;
        sumR += r;
        if (this.eon & (1 << i)) {
          revL += l;
          revR += r;
        }
      }
      // 次の位置
      let step = v.pitch;
      if (i > 0 && this.pmon & (1 << i)) {
        const factor = this.voices[i - 1].out + 0x8000;
        step = Math.floor((step * factor) / 32768) & 0xffff;
      }
      if (step > 0x4000) step = 0x4000;
      v.counter += step;
      while (v.counter >= 28 << 12) {
        v.counter -= 28 << 12;
        // ブロックの終わり
        const flags = this.ram[(v.addr & 0x7fff0) + 1];
        if (flags & 1) {
          this.endx |= 1 << i;
          v.addr = v.repeat;
          if (!(flags & 2)) {
            v.phase = Phase.Off;
            v.level = 0;
          }
        } else v.addr = (v.addr + 16) & 0x7ffff;
        this.decodeBlock(v);
      }
    }
    // CD の音
    this.cd.pop(this.cdBuf);
    if (this.ctrl & 1) {
      const cl = (this.cdBuf[0] * this.cdL) >> 15;
      const cr = (this.cdBuf[1] * this.cdR) >> 15;
      sumL += cl;
      sumR += cr;
      if (this.ctrl & 4) {
        revL += cl;
        revR += cr;
      }
    }
    // リバーブ（22050Hz で左右を順に）
    if (this.ctrl & 0x80) this.reverb(revL, revR);
    else this.odd = !this.odd;
    sumL += this.revOutL;
    sumR += this.revOutR;
    let l = clamp16(sumL);
    let r = clamp16(sumR);
    l = (l * this.mainL) >> 15;
    r = (r * this.mainR) >> 15;
    if (!(this.ctrl & 0x4000)) l = r = 0;
    this.output(l, r);
  }

  private rv(i: number): number {
    return this.regs[0xe0 + i];
  }

  private revAt(off: number): number {
    // off はハーフワード単位の相対位置
    const size = 0x40000 - this.revBase;
    let a = this.revAddr + off - this.revBase;
    a = ((a % size) + size) % size;
    return this.revBase + a;
  }

  private rr(off: number): number {
    return this.ram16[this.revAt(off)];
  }

  private rw(off: number, v: number): void {
    if (!(this.ctrl & 0x80)) return;
    this.ram16[this.revAt(off)] = clamp16(v);
  }

  private reverb(inL: number, inR: number): void {
    this.revInL = inL;
    this.revInR = inR;
    this.odd = !this.odd;
    if (!this.odd) return;
    const g = (i: number) => (this.rv(i) << 16) >> 16;
    const d = (i: number) => this.rv(i) * 4; // 8 バイト単位 → ハーフワード
    const m = (a: number, b: number) => (a * b) >> 15;
    const dAPF1 = d(0);
    const dAPF2 = d(1);
    const vIIR = g(2);
    const vCOMB1 = g(3);
    const vCOMB2 = g(4);
    const vCOMB3 = g(5);
    const vCOMB4 = g(6);
    const vWALL = g(7);
    const vAPF1 = g(8);
    const vAPF2 = g(9);
    const mLSAME = d(10);
    const mRSAME = d(11);
    const mLCOMB1 = d(12);
    const mRCOMB1 = d(13);
    const mLCOMB2 = d(14);
    const mRCOMB2 = d(15);
    const dLSAME = d(16);
    const dRSAME = d(17);
    const mLDIFF = d(18);
    const mRDIFF = d(19);
    const mLCOMB3 = d(20);
    const mRCOMB3 = d(21);
    const mLCOMB4 = d(22);
    const mRCOMB4 = d(23);
    const dLDIFF = d(24);
    const dRDIFF = d(25);
    const mLAPF1 = d(26);
    const mRAPF1 = d(27);
    const mLAPF2 = d(28);
    const mRAPF2 = d(29);
    const vLIN = g(30);
    const vRIN = g(31);
    const lin = m(vLIN, this.revInL);
    const rin = m(vRIN, this.revInR);
    this.rw(mLSAME, m(lin + m(this.rr(dLSAME), vWALL) - this.rr(mLSAME - 1), vIIR) + this.rr(mLSAME - 1));
    this.rw(mRSAME, m(rin + m(this.rr(dRSAME), vWALL) - this.rr(mRSAME - 1), vIIR) + this.rr(mRSAME - 1));
    this.rw(mLDIFF, m(lin + m(this.rr(dRDIFF), vWALL) - this.rr(mLDIFF - 1), vIIR) + this.rr(mLDIFF - 1));
    this.rw(mRDIFF, m(rin + m(this.rr(dLDIFF), vWALL) - this.rr(mRDIFF - 1), vIIR) + this.rr(mRDIFF - 1));
    let lout = m(vCOMB1, this.rr(mLCOMB1)) + m(vCOMB2, this.rr(mLCOMB2)) + m(vCOMB3, this.rr(mLCOMB3)) + m(vCOMB4, this.rr(mLCOMB4));
    let rout = m(vCOMB1, this.rr(mRCOMB1)) + m(vCOMB2, this.rr(mRCOMB2)) + m(vCOMB3, this.rr(mRCOMB3)) + m(vCOMB4, this.rr(mRCOMB4));
    lout = clamp16(lout - m(vAPF1, this.rr(mLAPF1 - dAPF1)));
    this.rw(mLAPF1, lout);
    lout = m(lout, vAPF1) + this.rr(mLAPF1 - dAPF1);
    rout = clamp16(rout - m(vAPF1, this.rr(mRAPF1 - dAPF1)));
    this.rw(mRAPF1, rout);
    rout = m(rout, vAPF1) + this.rr(mRAPF1 - dAPF1);
    lout = clamp16(lout - m(vAPF2, this.rr(mLAPF2 - dAPF2)));
    this.rw(mLAPF2, lout);
    lout = m(lout, vAPF2) + this.rr(mLAPF2 - dAPF2);
    rout = clamp16(rout - m(vAPF2, this.rr(mRAPF2 - dAPF2)));
    this.rw(mRAPF2, rout);
    rout = m(rout, vAPF2) + this.rr(mRAPF2 - dAPF2);
    this.revOutL = m(clamp16(lout), this.revL);
    this.revOutR = m(clamp16(rout), this.revR);
    this.revAddr = this.revAt(1);
  }

  /** 44100Hz の音を出力の周波数に合わせて書き出す */
  private output(l: number, r: number): void {
    const step = 44100 / (this.sampleRate * this.rateAdjust);
    while (this.resample < 1) {
      const t = this.resample;
      let ol = ((this.prevL + (l - this.prevL) * t) / 32768) * 0.9;
      let or = ((this.prevR + (r - this.prevR) * t) / 32768) * 0.9;
      const mid = (ol + or) / 2;
      const side = ((ol - or) / 2) * this.spread;
      ol = mid + side;
      or = mid - side;
      if (this.sampleLength + 1 < this.samples.length) {
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

  stateSkip(): unknown[] {
    return [this.ram16, this.samples, this.cdBuf];
  }
}

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/** 音量のレジスタ（15 ビット目が 0 なら固定の音量。1 のときのスイープは固定扱い） */
function vol(v: number): number {
  if (v & 0x8000) return 0x3fff;
  return (v << 17) >> 16;
}
