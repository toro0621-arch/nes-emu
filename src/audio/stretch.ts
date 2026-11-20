/**
 * 音の高さを変えずに、テンポだけ速くする（早送り用）。
 *
 * WSOLA というやり方：音を少しずつ重なる短いかけら（約 20ms）に切り、速さのぶんだけ飛ばしながら並べ直す。
 * かけらをつなぐときは、前のかけらの続きといちばん形が似ている所を少し前後に探してからつなぐので、
 * つなぎ目でブツブツしにくい。かけらはなめらかに重ねる（ハン窓。半分ずつ重ねると音量が変わらない）。
 * 左・右が交互に並んだ音（ステレオ）を扱う。
 */

/** かけらの長さ（組）。48kHz で約 21ms */
const GRAIN = 1024;
const HOP = GRAIN / 2;
/** つなぐ所を探す幅（組） */
const SEEK = 256;
/** 探すときに比べる長さ・とびとびに比べる間隔（軽くするため） */
const CMP = 256;
const CMP_STEP = 4;

const WINDOW = (() => {
  const w = new Float32Array(GRAIN);
  for (let i = 0; i < GRAIN; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN);
  return w;
})();

export class TimeStretch {
  /** まだ使っていない入力（ステレオ） */
  private buf = new Float32Array(1 << 16);
  private len = 0;
  /** 次のかけらを取る位置（組。buf の頭から） */
  private pos = 0;
  /** 前のかけらを取った位置（-1 = まだない） */
  private prev = -1;
  /** 前のかけらの後ろ半分（次のかけらの前半と重ねる） */
  private tail = new Float32Array(HOP * 2);

  reset(): void {
    this.len = 0;
    this.pos = 0;
    this.prev = -1;
    this.tail.fill(0);
  }

  /** samples（ステレオ）を ratio 倍の速さにした音を返す */
  process(samples: Float32Array, ratio: number): Float32Array {
    this.append(samples);
    const hopIn = HOP * Math.max(1, ratio);
    const out: Float32Array[] = [];
    let outLen = 0;
    const b = this.buf;
    // 次のかけらと、その前後の探す幅がそろっていれば並べる
    while (Math.floor(this.pos) + SEEK + GRAIN <= this.len >> 1) {
      const base = Math.floor(this.pos);
      let start = base;
      if (this.prev >= 0) {
        // 前のかけらの「本当の続き」（prev + HOP）にいちばん似ている所を、base の前後で探す
        const want = this.prev + HOP;
        let best = -Infinity;
        const lo = Math.max(0, base - SEEK);
        for (let s = lo; s <= base + SEEK; s += 8) {
          let c = 0;
          for (let k = 0; k < CMP; k += CMP_STEP) {
            const a = (want + k) * 2;
            const x = (s + k) * 2;
            c += (b[a] + b[a + 1]) * (b[x] + b[x + 1]);
          }
          if (c > best) {
            best = c;
            start = s;
          }
        }
      }
      const chunk = new Float32Array(HOP * 2);
      for (let i = 0; i < HOP; i++) {
        const w = WINDOW[i];
        const si = (start + i) * 2;
        chunk[i * 2] = this.tail[i * 2] + b[si] * w;
        chunk[i * 2 + 1] = this.tail[i * 2 + 1] + b[si + 1] * w;
      }
      for (let i = 0; i < HOP; i++) {
        const w = WINDOW[HOP + i];
        const si = (start + HOP + i) * 2;
        this.tail[i * 2] = b[si] * w;
        this.tail[i * 2 + 1] = b[si + 1] * w;
      }
      out.push(chunk);
      outLen += chunk.length;
      this.prev = start;
      this.pos += hopIn;
    }
    this.trim();
    const res = new Float32Array(outLen);
    let o = 0;
    for (const c of out) {
      res.set(c, o);
      o += c.length;
    }
    return res;
  }

  private append(s: Float32Array): void {
    if (this.len + s.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.len + s.length));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(s, this.len);
    this.len += s.length;
  }

  /** もう使わない頭の部分を捨てる（探す幅と、前のかけらの続きのぶんは残す） */
  private trim(): void {
    const keep = Math.max(0, Math.min(Math.floor(this.pos) - SEEK, this.prev >= 0 ? this.prev : Infinity));
    if (keep <= 0) return;
    this.buf.copyWithin(0, keep * 2, this.len);
    this.len -= keep * 2;
    this.pos -= keep;
    if (this.prev >= 0) this.prev -= keep;
    // 入力が溜まりすぎたら（速さに追いつかないとき）、古いぶんを捨てる
    if (this.len > 48000 * 2) {
      const drop = (this.len >> 1) - 24000;
      this.buf.copyWithin(0, drop * 2, this.len);
      this.len -= drop * 2;
      this.pos = Math.max(0, this.pos - drop);
      this.prev = -1;
    }
  }
}
