// スーパーファミコンの追加チップ DSP-1（スーパーマリオカート・パイロットウイングスなど）。
// 本物のチップは中のプログラム（任天堂の著作物）で計算しているので、それは使わず、
// 命令ごとの計算（3D の投影・モード 7 の行ごとの係数・回転・逆数など）をこのエミュレータで計算して返す。
// 数は 16 ビットの固定小数点（0x8000 = 1.0）、角度は 16 ビットで 1 周（0x10000 = 360°）

const s16 = (v: number) => (v << 16) >> 16;
/** 16 ビットに収める（はみ出したら端の値） */
const sat = (v: number) => {
  if (!Number.isFinite(v)) return v > 0 ? 32767 : -32768;
  const f = Math.floor(v);
  return f > 32767 ? 32767 : f < -32768 ? -32768 : f;
};
const RAD = Math.PI / 32768;
/** sin・cos（0x8000 倍。1.0 は 0x7FFF） */
const sinQ = (a: number) => (a === -32768 ? 0 : sat(Math.min(32767, Math.round(Math.sin(s16(a) * RAD) * 32768))));
const cosQ = (a: number) => sat(Math.min(32767, Math.round(Math.cos(s16(a) * RAD) * 32768)));
const mul = (a: number, b: number) => (a * b) >> 15;

/** 視点の傾きの上限（視点の高さのけたごと） */
const MAX_AZS = [
  0x38b4, 0x38b7, 0x38ba, 0x38be, 0x38c0, 0x38c4, 0x38c7, 0x38ca, 0x38ce, 0x38d0, 0x38d4, 0x38d7, 0x38da, 0x38dd, 0x38e0,
  0x38e4,
];

/** 命令ごとの入力・出力の数（16 ビット単位） */
const IN_COUNT: Record<number, number> = {};
const OUT_COUNT: Record<number, number> = {};
function cmd(ops: number[], inN: number, outN: number): void {
  for (const op of ops) {
    IN_COUNT[op] = inN;
    OUT_COUNT[op] = outN;
  }
}
cmd([0x00, 0x20, 0x30], 2, 1); // かけ算
cmd([0x10], 2, 2); // 逆数
cmd([0x04, 0x24], 2, 2); // sin・cos
cmd([0x08], 3, 2); // ベクトルの大きさ（の 2 乗）
cmd([0x18, 0x38], 4, 1); // 大きさの比較
cmd([0x28], 3, 1); // ベクトルの長さ
cmd([0x0c, 0x2c], 3, 2); // 2D の回転
cmd([0x1c, 0x3c], 6, 3); // 3D の回転
cmd([0x02, 0x12, 0x22, 0x32], 7, 4); // 投影の準備
cmd([0x0a, 0x1a, 0x2a, 0x3a], 1, 4); // モード 7 の行ごとの係数
cmd([0x06, 0x16, 0x26, 0x36], 3, 3); // 物の投影
cmd([0x0e, 0x1e, 0x2e, 0x3e], 2, 2); // 画面の位置 → 地面の位置
cmd([0x01, 0x05, 0x31, 0x35], 4, 0); // 姿勢の行列 A
cmd([0x11, 0x15], 4, 0); // B
cmd([0x21, 0x25], 4, 0); // C
cmd([0x0d, 0x09, 0x39, 0x3d], 3, 3); // 世界 → 物（A）
cmd([0x1d, 0x19], 3, 3); // B
cmd([0x2d, 0x29], 3, 3); // C
cmd([0x03, 0x33], 3, 3); // 物 → 世界（A）
cmd([0x13], 3, 3);
cmd([0x23], 3, 3);
cmd([0x0b, 0x3b], 3, 1); // 内積（A）
cmd([0x1b], 3, 1);
cmd([0x2b], 3, 1);
cmd([0x14, 0x34], 6, 3); // 姿勢の変化
cmd([0x07, 0x0f], 1, 1); // メモリのテスト
cmd([0x27, 0x2f], 1, 1); // 版
cmd([0x17, 0x37, 0x3f], 1, 1024); // データの読み出し（中身は持っていないので 0）

/** m を 0x4000〜0x7FFF（負なら -0x8000〜-0x4001）にそろえたときに左へずらした数 */
function normShift(m: number): number {
  let i = 0x4000;
  let e = 0;
  if (m < 0) {
    while (m & i && i) {
      i >>= 1;
      e++;
    }
  } else {
    while (!(m & i) && i) {
      i >>= 1;
      e++;
    }
  }
  return e;
}

export class Dsp1 {
  private command = 0;
  private waiting = true;
  private firstParam = false;
  private inBytes = new Uint8Array(16);
  private inIndex = 0;
  private inCount = 0;
  private out = new Uint8Array(2048);
  private outIndex = 0;
  private outCount = 0;
  private rasterV = 0;

  // 投影の準備（命令 02）で決まるもの
  private sinAas = 0;
  private cosAas = 0x7fff;
  private sinAzs = 0;
  private cosAzs = 0x7fff;
  private nx = 0;
  private ny = 0;
  private nz = 1;
  private centreX = 0;
  private centreY = 0;
  private centreZ = 0;
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private les = 0;
  private vOffset = 0;
  /** 傾き（上限で止めたもの）の cos と、その逆数 2 つ（補正の前と後） */
  private secAzs1 = 1;
  private secAzs2 = 1;
  private mats = [new Int32Array(9), new Int32Array(9), new Int32Array(9)];

  /** データレジスタを読む */
  readData(): number {
    if (this.outCount === 0) return 0x80;
    const v = this.out[this.outIndex++];
    if (--this.outCount === 0) {
      // モード 7 の係数は、続けて読むと次の行のものが出てくる
      if ((this.command & 0x0f) === 0x0a) {
        this.rasterV = s16(this.rasterV + 1);
        this.raster(this.rasterV);
      }
    }
    return v;
  }

  /** ステータスレジスタ（いつでも受け付けられる） */
  readStatus(): number {
    return 0x80;
  }

  writeData(v: number): void {
    if ((this.command & 0x0f) === 0x0a && this.outCount !== 0) {
      this.outCount = 0;
      this.waiting = true;
    }
    if (this.waiting) {
      this.command = v & 0x3f;
      this.inIndex = 0;
      this.firstParam = true;
      this.inCount = (IN_COUNT[this.command] ?? 0) * 2;
      this.waiting = this.inCount === 0;
      if (this.waiting) this.outCount = 0;
      return;
    }
    // 最初の引数で 0x80 を書くと、命令をやめて待ちに戻る
    if (this.firstParam && v === 0x80) {
      this.waiting = true;
      this.firstParam = false;
      return;
    }
    this.firstParam = false;
    this.inBytes[this.inIndex++] = v;
    if (this.inIndex >= this.inCount) {
      this.execute();
      this.waiting = true;
    }
  }

  private arg(i: number): number {
    return s16(this.inBytes[i * 2] | (this.inBytes[i * 2 + 1] << 8));
  }

  private output(values: number[]): void {
    this.outIndex = 0;
    this.outCount = values.length * 2;
    values.forEach((v, i) => {
      this.out[i * 2] = v & 0xff;
      this.out[i * 2 + 1] = (v >> 8) & 0xff;
    });
  }

  private execute(): void {
    const c = this.command;
    const a = (i: number) => this.arg(i);
    switch (c) {
      case 0x00:
        this.output([s16(mul(a(0), a(1)))]);
        return;
      case 0x20:
      case 0x30:
        this.output([s16(mul(a(0), a(1)) + 1)]);
        return;
      case 0x10:
        this.output(inverse(a(0), a(1)));
        return;
      case 0x04:
      case 0x24: {
        const ang = a(0);
        const r = a(1);
        this.output([s16(mul(sinQ(ang), r)), s16(mul(cosQ(ang), r))]);
        return;
      }
      case 0x08: {
        const size = (a(0) * a(0) + a(1) * a(1) + a(2) * a(2)) * 2;
        this.output([size & 0xffff, (size >>> 16) & 0xffff]);
        return;
      }
      case 0x18:
      case 0x38: {
        const d = (a(0) * a(0) + a(1) * a(1) + a(2) * a(2) - a(3) * a(3)) >> 15;
        this.output([s16(d + (c === 0x38 ? 1 : 0))]);
        return;
      }
      case 0x28:
        this.output([sat(Math.sqrt(a(0) * a(0) + a(1) * a(1) + a(2) * a(2)))]);
        return;
      case 0x0c:
      case 0x2c: {
        const ang = a(0);
        const x = a(1);
        const y = a(2);
        const s = sinQ(ang);
        const co = cosQ(ang);
        this.output([s16(mul(y, s) + mul(x, co)), s16(mul(y, co) - mul(x, s))]);
        return;
      }
      case 0x1c:
      case 0x3c:
        this.output(polar(a(0), a(1), a(2), a(3), a(4), a(5)));
        return;
      case 0x02:
      case 0x12:
      case 0x22:
      case 0x32:
        this.output(this.parameter(a(0), a(1), a(2), a(3), a(4), a(5), a(6)));
        return;
      case 0x0a:
      case 0x1a:
      case 0x2a:
      case 0x3a:
        this.rasterV = a(0);
        this.raster(this.rasterV);
        return;
      case 0x06:
      case 0x16:
      case 0x26:
      case 0x36:
        this.output(this.project(a(0), a(1), a(2)));
        return;
      case 0x0e:
      case 0x1e:
      case 0x2e:
      case 0x3e:
        this.output(this.target(a(0), a(1)));
        return;
      case 0x01:
      case 0x05:
      case 0x31:
      case 0x35:
        this.attitude(0, a(0), a(1), a(2), a(3));
        this.outCount = 0;
        return;
      case 0x11:
      case 0x15:
        this.attitude(1, a(0), a(1), a(2), a(3));
        this.outCount = 0;
        return;
      case 0x21:
      case 0x25:
        this.attitude(2, a(0), a(1), a(2), a(3));
        this.outCount = 0;
        return;
      case 0x0d:
      case 0x09:
      case 0x39:
      case 0x3d:
      case 0x1d:
      case 0x19:
      case 0x2d:
      case 0x29: {
        // 世界の座標 → 物から見た座標（行列の行をかける）
        const m = this.mats[c === 0x1d || c === 0x19 ? 1 : c === 0x2d || c === 0x29 ? 2 : 0];
        const x = a(0);
        const y = a(1);
        const z = a(2);
        this.output([0, 1, 2].map((r) => s16(mul(m[r * 3], x) + mul(m[r * 3 + 1], y) + mul(m[r * 3 + 2], z))));
        return;
      }
      case 0x03:
      case 0x33:
      case 0x13:
      case 0x23: {
        // 物から見た座標 → 世界の座標（行列の列をかける）
        const m = this.mats[c === 0x13 ? 1 : c === 0x23 ? 2 : 0];
        const f = a(0);
        const l = a(1);
        const u = a(2);
        this.output([0, 1, 2].map((k) => s16(mul(m[k], f) + mul(m[3 + k], l) + mul(m[6 + k], u))));
        return;
      }
      case 0x0b:
      case 0x3b:
      case 0x1b:
      case 0x2b: {
        const m = this.mats[c === 0x1b ? 1 : c === 0x2b ? 2 : 0];
        this.output([s16((a(0) * m[0] + a(1) * m[1] + a(2) * m[2]) >> 15)]);
        return;
      }
      case 0x14:
      case 0x34:
        this.output(gyrate(a(0), a(1), a(2), a(3), a(4), a(5)));
        return;
      case 0x07:
      case 0x0f:
        this.output([0x0000]);
        return;
      case 0x27:
      case 0x2f:
        this.output([0x0100]);
        return;
      case 0x17:
      case 0x37:
      case 0x3f:
        this.output(new Array(1024).fill(0));
        return;
    }
    this.outCount = 0;
  }

  /** 投影の準備：注視点 F、注視点から目までの距離 Lfe、目から画面までの距離 Les、方位角 Aas、天頂角 Azs */
  private parameter(fx: number, fy: number, fz: number, lfe: number, les: number, aas: number, azs: number): number[] {
    this.sinAas = sinQ(aas);
    this.cosAas = cosQ(aas);
    this.sinAzs = sinQ(azs);
    this.cosAzs = cosQ(azs);
    // 画面の向き（目の方へ向かう単位ベクトル）
    this.nx = (-this.sinAzs / 32768) * (this.sinAas / 32768);
    this.ny = (this.sinAzs / 32768) * (this.cosAas / 32768);
    this.nz = this.cosAzs / 32768;
    // 目の位置と、画面の中心
    this.centreX = s16(fx + Math.floor(lfe * this.nx));
    this.centreY = s16(fy + Math.floor(lfe * this.ny));
    this.centreZ = s16(fz + Math.floor(lfe * this.nz));
    this.gx = this.centreX - Math.floor(les * this.nx);
    this.gy = this.centreY - Math.floor(les * this.ny);
    this.gz = this.centreZ - Math.floor(les * this.nz);
    this.les = les;

    // 傾きは地平線の近くで止める（目の高さのけたで上限が変わる）
    let max = MAX_AZS[Math.min(15, normShift(this.centreZ))];
    let clipped = azs;
    if (azs < 0) {
      max = -max;
      if (clipped < max + 1) clipped = max + 1;
    } else if (clipped > max) clipped = max;
    const sinC = Math.sin(clipped * RAD);
    let cosC = Math.cos(clipped * RAD);
    this.secAzs1 = 1 / cosC;

    // 注視の軸が地面と交わるところ
    const ahead = sat(this.centreZ * Math.tan(clipped * RAD));
    this.centreX = s16(this.centreX + Math.floor((ahead * this.sinAas) / 32768));
    this.centreY = s16(this.centreY - Math.floor((ahead * this.cosAas) / 32768));

    // 止めたぶんは、画面の中心の行をずらし、cos を補って合わせる
    let vof = 0;
    if (azs !== clipped || azs === max) {
      const d = (azs - clipped) * RAD;
      vof = sat(les * Math.tan(d));
      cosC /= Math.cos(d);
    }
    this.vOffset = Math.floor(les * cosC);
    const vva = sat(-(this.vOffset / sinC));
    this.secAzs2 = 1 / cosC;
    return [s16(vof), vva, this.centreX, this.centreY];
  }

  /** モード 7 の 1 行ぶんの係数 A・B・C・D（0x100 = 1.0） */
  private raster(vs: number): void {
    const den = (vs * this.sinAzs) / 32768 + this.vOffset;
    const k = sat((256 * this.centreZ) / den);
    const k2 = sat(((256 * this.centreZ) / den) * this.secAzs2);
    this.output([
      s16(mul(k, this.cosAas)),
      s16(mul(k2, -this.sinAas)),
      s16(mul(k, this.sinAas)),
      s16(mul(k2, this.cosAas)),
    ]);
  }

  /** 物の投影：世界の (X, Y, Z) → 画面の (H, V) と大きさ M（0x100 = 等倍） */
  private project(x: number, y: number, z: number): number[] {
    const px = x - this.gx;
    const py = y - this.gy;
    const pz = z - this.gz;
    const depth = this.les - (px * this.nx + py * this.ny + pz * this.nz);
    const s = this.les / depth;
    const ca = this.cosAas / 32768;
    const sa = this.sinAas / 32768;
    const cz = this.cosAzs / 32768;
    const sz = this.sinAzs / 32768;
    const h = s * (px * ca + py * sa);
    const v = s * (px * -cz * sa + py * cz * ca - pz * sz);
    return [sat(h), sat(v), sat(256 * s)];
  }

  /** 画面の (H, V) → 地面の (X, Y) */
  private target(h: number, v: number): number[] {
    const den = (v * this.sinAzs) / 32768 + this.vOffset;
    const hh = s16(h << 8);
    const vv = s16(v << 8);
    const c1 = sat((128 * this.centreZ) / den);
    const ch = (c1 * hh) >> 15;
    let x = this.centreX + mul(ch, this.cosAas);
    let y = this.centreY + mul(ch, this.sinAas);
    const c2 = sat(((128 * this.centreZ) / den) * this.secAzs1);
    const cv = (c2 * vv) >> 15;
    x += mul(cv, -this.sinAas);
    y += mul(cv, this.cosAas);
    return [s16(x), s16(y)];
  }

  /** 姿勢の行列（大きさ m、Z・Y・X 軸まわりの角度） */
  private attitude(n: number, m: number, az: number, ay: number, ax: number): void {
    const sz = sinQ(az);
    const cz = cosQ(az);
    const sy = sinQ(ay);
    const cy = cosQ(ay);
    const sx = sinQ(ax);
    const cx = cosQ(ax);
    const s = m >> 1;
    const t = this.mats[n];
    t[0] = mul(mul(s, cz), cy);
    t[1] = -mul(mul(s, sz), cy);
    t[2] = mul(s, sy);
    t[3] = mul(mul(s, sz), cx) + mul(mul(mul(s, cz), sx), sy);
    t[4] = mul(mul(s, cz), cx) - mul(mul(mul(s, sz), sx), sy);
    t[5] = -mul(mul(s, sx), cy);
    t[6] = mul(mul(s, sz), sx) - mul(mul(mul(s, cz), cx), sy);
    t[7] = mul(mul(s, cz), sx) + mul(mul(mul(s, sz), cx), sy);
    t[8] = mul(mul(s, cx), cy);
  }
}

/** 逆数：(a / 0x8000) × 2^b の逆数を、同じ形（仮数と指数）で返す */
function inverse(a: number, b: number): number[] {
  if (a === 0) return [0x7fff, 0x002f];
  const v = (a / 32768) * 2 ** b;
  const w = 1 / v;
  let e = Math.ceil(Math.log2(Math.abs(w))) + 0;
  let m = (w / 2 ** e) * 32768;
  // 仮数を 0x4000〜0x7FFF（負は -0x8000〜-0x4001）に収める
  while (Math.abs(m) >= 32768) {
    m /= 2;
    e++;
  }
  while (Math.abs(m) < 16384) {
    m *= 2;
    e--;
  }
  return [sat(m), s16(e)];
}

function polar(az: number, ay: number, ax: number, x1: number, y1: number, z1: number): number[] {
  // Z 軸
  let x = mul(y1, sinQ(az)) + mul(x1, cosQ(az));
  let y = mul(y1, cosQ(az)) - mul(x1, sinQ(az));
  x1 = s16(x);
  y1 = s16(y);
  // Y 軸
  let z = mul(x1, sinQ(ay)) + mul(z1, cosQ(ay));
  x = mul(x1, cosQ(ay)) - mul(z1, sinQ(ay));
  const x2 = s16(x);
  z1 = s16(z);
  // X 軸
  y = mul(z1, sinQ(ax)) + mul(y1, cosQ(ax));
  z = mul(z1, cosQ(ax)) - mul(y1, sinQ(ax));
  return [x2, s16(y), s16(z)];
}

/** 姿勢の変化：角速度（U・F・L）を Z・X・Y 軸の角度に足す */
function gyrate(az: number, ax: number, ay: number, u: number, f: number, l: number): number[] {
  const sy = Math.sin(ay * RAD);
  const cy = Math.cos(ay * RAD);
  const cx = Math.cos(ax * RAD);
  const sx = Math.sin(ax * RAD);
  const rz = az + sat((u * cy - f * sy) / cx);
  const rx = ax + Math.floor(u * sy + f * cy);
  const ry = ay + sat((-(u * cy + f * sy) * sx) / cx) + l;
  return [s16(rz), s16(rx), s16(ry)];
}
