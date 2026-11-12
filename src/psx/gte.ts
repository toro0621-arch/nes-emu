// GTE（ジオメトリ変換エンジン）：3D の座標変換・光の計算をする CPU のとなりの計算機（コプロセッサ 2）。
// 計算の途中のけた数・あふれたときの止め方・割り算の近似まで実機どおりにする（ずれると 3D がガタガタになる）

const UNR = new Uint8Array(0x101);
for (let i = 0; i < 0x101; i++) UNR[i] = Math.max(0, Math.floor((Math.floor(0x40000 / (i + 0x100)) + 1) / 2) - 0x101);

const P43 = 0x80000000000; // 2^43
const P44 = 0x100000000000; // 2^44

function s16(v: number): number {
  return (v << 16) >> 16;
}

export class Gte {
  // データ
  v = new Int16Array(12); // VX0 VY0 VZ0 0 / VX1 ... / VX2 ...（4 つずつ）
  rgbc = 0;
  otz = 0;
  ir = new Int32Array(4); // IR0 IR1 IR2 IR3
  sx = new Int32Array(3);
  sy = new Int32Array(3);
  sz = new Int32Array(4); // SZ0..SZ3
  rgb = new Int32Array(3); // RGB0 RGB1 RGB2
  res1 = 0;
  mac = new Int32Array(4); // MAC0..MAC3
  lzcs = 0;
  lzcr = 32;
  // 制御
  rt = new Int32Array(9);
  tr = new Int32Array(3);
  llm = new Int32Array(9);
  bk = new Int32Array(3);
  lcm = new Int32Array(9);
  fc = new Int32Array(3);
  ofx = 0;
  ofy = 0;
  h = 0;
  dqa = 0;
  dqb = 0;
  zsf3 = 0;
  zsf4 = 0;
  flag = 0;

  private sf = 0;
  private lm = false;

  // ---- レジスタ ----
  readData(i: number): number {
    switch (i) {
      case 0:
        return (this.v[0] & 0xffff) | (this.v[1] << 16);
      case 1:
        return this.v[2];
      case 2:
        return (this.v[4] & 0xffff) | (this.v[5] << 16);
      case 3:
        return this.v[6];
      case 4:
        return (this.v[8] & 0xffff) | (this.v[9] << 16);
      case 5:
        return this.v[10];
      case 6:
        return this.rgbc;
      case 7:
        return this.otz;
      case 8:
      case 9:
      case 10:
      case 11:
        return s16(this.ir[i - 8]);
      case 12:
      case 13:
      case 14:
        return (this.sx[i - 12] & 0xffff) | (this.sy[i - 12] << 16);
      case 15:
        return (this.sx[2] & 0xffff) | (this.sy[2] << 16);
      case 16:
      case 17:
      case 18:
      case 19:
        return this.sz[i - 16] & 0xffff;
      case 20:
      case 21:
      case 22:
        return this.rgb[i - 20];
      case 23:
        return this.res1;
      case 24:
      case 25:
      case 26:
      case 27:
        return this.mac[i - 24];
      case 28:
      case 29: {
        const c = (x: number) => Math.min(0x1f, Math.max(0, x >> 7));
        return c(this.ir[1]) | (c(this.ir[2]) << 5) | (c(this.ir[3]) << 10);
      }
      case 30:
        return this.lzcs;
      case 31:
        return this.lzcr;
    }
    return 0;
  }

  writeData(i: number, v: number): void {
    switch (i) {
      case 0:
      case 2:
      case 4:
        this.v[i * 2] = v;
        this.v[i * 2 + 1] = v >> 16;
        return;
      case 1:
      case 3:
      case 5:
        this.v[(i - 1) * 2 + 2] = v;
        return;
      case 6:
        this.rgbc = v;
        return;
      case 7:
        this.otz = v & 0xffff;
        return;
      case 8:
      case 9:
      case 10:
      case 11:
        this.ir[i - 8] = s16(v);
        return;
      case 12:
      case 13:
      case 14:
        this.sx[i - 12] = s16(v);
        this.sy[i - 12] = v >> 16;
        return;
      case 15:
        this.pushSxy(s16(v), v >> 16);
        return;
      case 16:
      case 17:
      case 18:
      case 19:
        this.sz[i - 16] = v & 0xffff;
        return;
      case 20:
      case 21:
      case 22:
        this.rgb[i - 20] = v;
        return;
      case 23:
        this.res1 = v;
        return;
      case 24:
      case 25:
      case 26:
      case 27:
        this.mac[i - 24] = v;
        return;
      case 28:
        this.ir[1] = (v & 0x1f) << 7;
        this.ir[2] = ((v >> 5) & 0x1f) << 7;
        this.ir[3] = ((v >> 10) & 0x1f) << 7;
        return;
      case 30: {
        this.lzcs = v;
        const x = v < 0 ? ~v : v;
        this.lzcr = Math.clz32(x);
        return;
      }
    }
  }

  readControl(i: number): number {
    const pair = (m: Int32Array, k: number) => (m[k] & 0xffff) | (m[k + 1] << 16);
    switch (i) {
      case 0:
        return pair(this.rt, 0);
      case 1:
        return pair(this.rt, 2);
      case 2:
        return pair(this.rt, 4);
      case 3:
        return pair(this.rt, 6);
      case 4:
        return this.rt[8];
      case 5:
      case 6:
      case 7:
        return this.tr[i - 5];
      case 8:
        return pair(this.llm, 0);
      case 9:
        return pair(this.llm, 2);
      case 10:
        return pair(this.llm, 4);
      case 11:
        return pair(this.llm, 6);
      case 12:
        return this.llm[8];
      case 13:
      case 14:
      case 15:
        return this.bk[i - 13];
      case 16:
        return pair(this.lcm, 0);
      case 17:
        return pair(this.lcm, 2);
      case 18:
        return pair(this.lcm, 4);
      case 19:
        return pair(this.lcm, 6);
      case 20:
        return this.lcm[8];
      case 21:
      case 22:
      case 23:
        return this.fc[i - 21];
      case 24:
        return this.ofx;
      case 25:
        return this.ofy;
      case 26:
        return s16(this.h); // 実機は符号つきで読める
      case 27:
        return this.dqa;
      case 28:
        return this.dqb;
      case 29:
        return this.zsf3;
      case 30:
        return this.zsf4;
      case 31:
        return this.flag;
    }
    return 0;
  }

  writeControl(i: number, v: number): void {
    const pair = (m: Int32Array, k: number) => {
      m[k] = s16(v);
      m[k + 1] = v >> 16;
    };
    switch (i) {
      case 0:
        return pair(this.rt, 0);
      case 1:
        return pair(this.rt, 2);
      case 2:
        return pair(this.rt, 4);
      case 3:
        return pair(this.rt, 6);
      case 4:
        this.rt[8] = s16(v);
        return;
      case 5:
      case 6:
      case 7:
        this.tr[i - 5] = v;
        return;
      case 8:
        return pair(this.llm, 0);
      case 9:
        return pair(this.llm, 2);
      case 10:
        return pair(this.llm, 4);
      case 11:
        return pair(this.llm, 6);
      case 12:
        this.llm[8] = s16(v);
        return;
      case 13:
      case 14:
      case 15:
        this.bk[i - 13] = v;
        return;
      case 16:
        return pair(this.lcm, 0);
      case 17:
        return pair(this.lcm, 2);
      case 18:
        return pair(this.lcm, 4);
      case 19:
        return pair(this.lcm, 6);
      case 20:
        this.lcm[8] = s16(v);
        return;
      case 21:
      case 22:
      case 23:
        this.fc[i - 21] = v;
        return;
      case 24:
        this.ofx = v;
        return;
      case 25:
        this.ofy = v;
        return;
      case 26:
        this.h = v & 0xffff;
        return;
      case 27:
        this.dqa = s16(v);
        return;
      case 28:
        this.dqb = v;
        return;
      case 29:
        this.zsf3 = s16(v);
        return;
      case 30:
        this.zsf4 = s16(v);
        return;
      case 31:
        this.flag = v & 0x7ffff000;
        if (this.flag & 0x7f87e000) this.flag |= 0x80000000;
        return;
    }
  }

  // ---- 計算の部品 ----
  /** MAC1〜3 の 44 ビットのあふれを調べて、44 ビットに丸める */
  private a(n: number, v: number): number {
    if (v >= P43) {
      this.flag |= 1 << (31 - n);
      v -= P44;
    } else if (v < -P43) {
      this.flag |= 1 << (28 - n);
      v += P44;
    }
    return v;
  }

  /** 右へ sf × 12 ビットずらす（符号つき） */
  private shr(v: number, sh: number): number {
    return sh ? Math.floor(v / 4096) : v;
  }

  /** MAC n に入れる（44 ビットの値を sf でずらして 32 ビットに） */
  private setMac(n: number, v: number): number {
    const r = this.shr(v, this.sf);
    this.mac[n] = r;
    return r;
  }

  private irSat(n: number, v: number, lm: boolean): number {
    const lo = lm ? 0 : -0x8000;
    if (v < lo) {
      this.flag |= 1 << (25 - n);
      return lo;
    }
    if (v > 0x7fff) {
      this.flag |= 1 << (25 - n);
      return 0x7fff;
    }
    return v;
  }

  private setIr(n: number, v: number, lm = this.lm): void {
    this.ir[n] = this.irSat(n, v, lm);
  }

  private mac0(v: number): number {
    if (v > 0x7fffffff) this.flag |= 1 << 16;
    else if (v < -0x80000000) this.flag |= 1 << 15;
    this.mac[0] = v;
    return v;
  }

  private sat(v: number, lo: number, hi: number, bit: number): number {
    if (v < lo) {
      this.flag |= 1 << bit;
      return lo;
    }
    if (v > hi) {
      this.flag |= 1 << bit;
      return hi;
    }
    return v;
  }

  private pushSxy(x: number, y: number): void {
    this.sx[0] = this.sx[1];
    this.sy[0] = this.sy[1];
    this.sx[1] = this.sx[2];
    this.sy[1] = this.sy[2];
    this.sx[2] = x;
    this.sy[2] = y;
  }

  private pushSz(z: number): void {
    this.sz[0] = this.sz[1];
    this.sz[1] = this.sz[2];
    this.sz[2] = this.sz[3];
    this.sz[3] = z;
  }

  private pushColor(): void {
    const r = this.sat(this.mac[1] >> 4, 0, 255, 21);
    const g = this.sat(this.mac[2] >> 4, 0, 255, 20);
    const b = this.sat(this.mac[3] >> 4, 0, 255, 19);
    this.rgb[0] = this.rgb[1];
    this.rgb[1] = this.rgb[2];
    this.rgb[2] = r | (g << 8) | (b << 16) | (this.rgbc & 0xff000000);
  }

  /** 行列 × ベクトル + 平行移動（t は 12 ビット左へずらす前の値）。MAC1〜3 と IR1〜3 に入れる */
  private mulMat(m: Int32Array, x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
    const t = [tx, ty, tz];
    for (let i = 0; i < 3; i++) {
      const n = i + 1;
      let v = this.a(n, t[i] * 4096 + m[i * 3] * x);
      v = this.a(n, v + m[i * 3 + 1] * y);
      v = this.a(n, v + m[i * 3 + 2] * z);
      this.setMac(n, v);
    }
    this.setIr(1, this.mac[1]);
    this.setIr(2, this.mac[2]);
    this.setIr(3, this.mac[3]);
  }

  private unrDivide(): number {
    const h = this.h;
    const z3 = this.sz[3];
    if (h < z3 * 2) {
      const z = Math.clz32(z3) - 16;
      const n = h << z;
      let d = z3 << z;
      const u = UNR[(d - 0x7fc0) >> 7] + 0x101;
      d = Math.floor((0x2000080 - d * u) / 256);
      d = Math.floor((0x0000080 + d * u) / 256);
      return Math.min(0x1ffff, Math.floor((n * d + 0x8000) / 65536));
    }
    this.flag |= 1 << 17;
    return 0x1ffff;
  }

  /** 1 つの頂点の透視変換（last のときだけ奥行きの色の割合も出す） */
  private rtp(vi: number, last: boolean): void {
    const v = this.v;
    const x = v[vi * 4];
    const y = v[vi * 4 + 1];
    const z = v[vi * 4 + 2];
    const m = this.rt;
    const t = this.tr;
    let mac3raw = 0;
    for (let i = 0; i < 3; i++) {
      const n = i + 1;
      let s = this.a(n, t[i] * 4096 + m[i * 3] * x);
      s = this.a(n, s + m[i * 3 + 1] * y);
      s = this.a(n, s + m[i * 3 + 2] * z);
      this.setMac(n, s);
      if (n === 3) mac3raw = s;
    }
    this.setIr(1, this.mac[1]);
    this.setIr(2, this.mac[2]);
    // IR3 は値は sf に合わせるが、あふれの印は 12 ビットずらした値で決まる
    {
      const chk = Math.floor(mac3raw / 4096);
      if (chk < -0x8000 || chk > 0x7fff) this.flag |= 1 << 22;
      const lo = this.lm ? 0 : -0x8000;
      this.ir[3] = Math.min(0x7fff, Math.max(lo, this.mac[3]));
    }
    this.pushSz(this.sat(Math.floor(mac3raw / 4096), 0, 0xffff, 18));
    const q = this.unrDivide();
    const sx = this.mac0(q * this.ir[1] + this.ofx);
    const sy = this.mac0(q * this.ir[2] + this.ofy);
    this.pushSxy(this.sat(Math.floor(sx / 65536), -0x400, 0x3ff, 14), this.sat(Math.floor(sy / 65536), -0x400, 0x3ff, 13));
    if (last) {
      const p = this.mac0(q * this.dqa + this.dqb);
      this.ir[0] = this.sat(Math.floor(p / 4096), 0, 0x1000, 12);
    }
  }

  /** 奥行きの色（FC）へ IR0 の割合で近づける。MAC1〜3 は 44 ビットの値（ずらす前）を受け取る */
  private depthCue(m1: number, m2: number, m3: number): void {
    const ms = [m1, m2, m3];
    for (let i = 0; i < 3; i++) {
      const n = i + 1;
      const fc = this.a(n, this.fc[i] * 4096 - ms[i]);
      this.ir[n] = this.irSat(n, this.shr(fc, this.sf), false);
    }
    for (let i = 0; i < 3; i++) {
      const n = i + 1;
      this.setMac(n, this.a(n, this.ir[n] * this.ir[0] + ms[i]));
    }
  }

  private finishColor(): void {
    this.pushColor();
    this.setIr(1, this.mac[1]);
    this.setIr(2, this.mac[2]);
    this.setIr(3, this.mac[3]);
  }

  /** 法線から光の強さを出す（NCS・NCC・NCD の前半） */
  private light(vi: number): void {
    const v = this.v;
    this.mulMat(this.llm, v[vi * 4], v[vi * 4 + 1], v[vi * 4 + 2], 0, 0, 0);
    this.mulMat(this.lcm, this.ir[1], this.ir[2], this.ir[3], this.bk[0], this.bk[1], this.bk[2]);
  }

  private colorMul(): [number, number, number] {
    const c = this.rgbc;
    const r = (c & 0xff) * 16;
    const g = ((c >> 8) & 0xff) * 16;
    const b = ((c >> 16) & 0xff) * 16;
    return [this.a(1, r * this.ir[1]), this.a(2, g * this.ir[2]), this.a(3, b * this.ir[3])];
  }

  private ncs(vi: number): void {
    this.light(vi);
    this.pushColor();
  }

  private ncc(vi: number): void {
    this.light(vi);
    const [a, b, c] = this.colorMul();
    this.setMac(1, a);
    this.setMac(2, b);
    this.setMac(3, c);
    this.finishColor();
  }

  private ncd(vi: number): void {
    this.light(vi);
    const [a, b, c] = this.colorMul();
    this.depthCue(a, b, c);
    this.finishColor();
  }

  private dpcs(color: number): void {
    const r = (color & 0xff) * 65536;
    const g = ((color >> 8) & 0xff) * 65536;
    const b = ((color >> 16) & 0xff) * 65536;
    this.depthCue(r, g, b);
    this.finishColor();
  }

  /** コマンドを実行する */
  command(op: number): void {
    this.flag = 0;
    this.sf = op & 0x80000 ? 1 : 0;
    this.lm = (op & 0x400) !== 0;
    switch (op & 0x3f) {
      case 0x01:
        this.rtp(0, true);
        break;
      case 0x06: {
        const [x0, x1, x2] = this.sx;
        const [y0, y1, y2] = this.sy;
        this.mac0(x0 * y1 + x1 * y2 + x2 * y0 - x0 * y2 - x1 * y0 - x2 * y1);
        break;
      }
      case 0x0c: {
        const d1 = this.rt[0];
        const d2 = this.rt[4];
        const d3 = this.rt[8];
        const [, i1, i2, i3] = this.ir;
        this.setMac(1, this.a(1, i3 * d2 - i2 * d3));
        this.setMac(2, this.a(2, i1 * d3 - i3 * d1));
        this.setMac(3, this.a(3, i2 * d1 - i1 * d2));
        this.setIr(1, this.mac[1]);
        this.setIr(2, this.mac[2]);
        this.setIr(3, this.mac[3]);
        break;
      }
      case 0x10:
        this.dpcs(this.rgbc);
        break;
      case 0x11:
        this.depthCue(this.ir[1] * 4096, this.ir[2] * 4096, this.ir[3] * 4096);
        this.finishColor();
        break;
      case 0x12:
        this.mvmva(op);
        break;
      case 0x13:
        this.ncd(0);
        break;
      case 0x14: {
        this.mulMat(this.lcm, this.ir[1], this.ir[2], this.ir[3], this.bk[0], this.bk[1], this.bk[2]);
        const [a, b, c] = this.colorMul();
        this.depthCue(a, b, c);
        this.finishColor();
        break;
      }
      case 0x16:
        this.ncd(0);
        this.ncd(1);
        this.ncd(2);
        break;
      case 0x1b:
        this.ncc(0);
        break;
      case 0x1c: {
        this.mulMat(this.lcm, this.ir[1], this.ir[2], this.ir[3], this.bk[0], this.bk[1], this.bk[2]);
        const [a, b, c] = this.colorMul();
        this.setMac(1, a);
        this.setMac(2, b);
        this.setMac(3, c);
        this.finishColor();
        break;
      }
      case 0x1e:
        this.ncs(0);
        break;
      case 0x20:
        this.ncs(0);
        this.ncs(1);
        this.ncs(2);
        break;
      case 0x28: {
        for (let n = 1; n <= 3; n++) this.setMac(n, this.ir[n] * this.ir[n]);
        this.setIr(1, this.mac[1]);
        this.setIr(2, this.mac[2]);
        this.setIr(3, this.mac[3]);
        break;
      }
      case 0x29: {
        const [a, b, c] = this.colorMul();
        this.depthCue(a, b, c);
        this.finishColor();
        break;
      }
      case 0x2a:
        this.dpcs(this.rgb[0]);
        this.dpcs(this.rgb[0]);
        this.dpcs(this.rgb[0]);
        break;
      case 0x2d: {
        const v = this.mac0(this.zsf3 * (this.sz[1] + this.sz[2] + this.sz[3]));
        this.otz = this.sat(Math.floor(v / 4096), 0, 0xffff, 18);
        break;
      }
      case 0x2e: {
        const v = this.mac0(this.zsf4 * (this.sz[0] + this.sz[1] + this.sz[2] + this.sz[3]));
        this.otz = this.sat(Math.floor(v / 4096), 0, 0xffff, 18);
        break;
      }
      case 0x30:
        this.rtp(0, false);
        this.rtp(1, false);
        this.rtp(2, true);
        break;
      case 0x3d: {
        for (let n = 1; n <= 3; n++) this.setMac(n, this.a(n, this.ir[0] * this.ir[n]));
        this.finishColor();
        break;
      }
      case 0x3e: {
        const sh = this.sf ? 4096 : 1;
        for (let n = 1; n <= 3; n++) this.setMac(n, this.a(n, this.mac[n] * sh + this.ir[0] * this.ir[n]));
        this.finishColor();
        break;
      }
      case 0x3f:
        this.ncc(0);
        this.ncc(1);
        this.ncc(2);
        break;
    }
    if (this.flag & 0x7f87e000) this.flag |= 0x80000000;
  }

  private mvmva(op: number): void {
    const mx = (op >> 17) & 3;
    const vsel = (op >> 15) & 3;
    const cv = (op >> 13) & 3;
    let m: Int32Array;
    if (mx === 0) m = this.rt;
    else if (mx === 1) m = this.llm;
    else if (mx === 2) m = this.lcm;
    else {
      // 存在しない行列：実機では決まった値の寄せ集めになる
      const r = (this.rgbc & 0xff) << 4;
      m = new Int32Array([-r, r, this.ir[0], this.rt[2], this.rt[2], this.rt[2], this.rt[4], this.rt[4], this.rt[4]]);
    }
    let x: number;
    let y: number;
    let z: number;
    if (vsel === 3) {
      x = this.ir[1];
      y = this.ir[2];
      z = this.ir[3];
    } else {
      x = this.v[vsel * 4];
      y = this.v[vsel * 4 + 1];
      z = this.v[vsel * 4 + 2];
    }
    if (cv === 2) {
      // FC を足すときの実機の不具合：1 列目の結果は捨てられ、印だけが残る
      for (let i = 0; i < 3; i++) {
        const n = i + 1;
        const t = this.a(n, this.fc[i] * 4096 + m[i * 3] * x);
        this.irSat(n, this.shr(t, this.sf), false);
        let s = this.a(n, m[i * 3 + 1] * y);
        s = this.a(n, s + m[i * 3 + 2] * z);
        this.setMac(n, s);
      }
      this.setIr(1, this.mac[1]);
      this.setIr(2, this.mac[2]);
      this.setIr(3, this.mac[3]);
      return;
    }
    const t = cv === 0 ? this.tr : cv === 1 ? this.bk : null;
    this.mulMat(m, x, y, z, t ? t[0] : 0, t ? t[1] : 0, t ? t[2] : 0);
  }
}
