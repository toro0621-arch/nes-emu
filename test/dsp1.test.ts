// スーパーファミコンの DSP-1（スーパーマリオカートなど）：命令の計算と、やりとりの決まり
import { describe, expect, it } from 'vitest';
import { Dsp1 } from '../src/snes/dsp1';

/** 命令と引数（16 ビット）を送り、n 個の答えを受け取る */
function call(d: Dsp1, op: number, args: number[], n: number): number[] {
  d.writeData(op);
  for (const a of args) {
    d.writeData(a & 0xff);
    d.writeData((a >> 8) & 0xff);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = d.readData();
    const hi = d.readData();
    out.push(((lo | (hi << 8)) << 16) >> 16);
  }
  return out;
}

const DEG = 65536 / 360;

describe('DSP-1', () => {
  it('いつでも受け付けられる（ステータスの bit7）', () => {
    expect(new Dsp1().readStatus() & 0x80).toBe(0x80);
  });

  it('かけ算・sin と cos・回転・長さ', () => {
    const d = new Dsp1();
    expect(call(d, 0x00, [0x4000, 1000], 1)).toEqual([500]); // 0.5 × 1000
    expect(call(d, 0x20, [0x4000, 1000], 1)).toEqual([501]);
    const [s, c] = call(d, 0x04, [Math.round(30 * DEG), 1000], 2);
    expect(s).toBeCloseTo(500, -1);
    expect(c).toBeCloseTo(866, -1);
    // 90° 回すと (1000, 0) → (0, -1000)
    const [x2, y2] = call(d, 0x0c, [Math.round(90 * DEG), 1000, 0], 2);
    expect(Math.abs(x2)).toBeLessThan(2);
    expect(y2).toBeCloseTo(-1000, -1);
    expect(call(d, 0x28, [300, 400, 0], 1)).toEqual([500]);
  });

  it('逆数（仮数と指数）', () => {
    const d = new Dsp1();
    // 0.5 × 2^0 の逆数は 2 = 0.5 × 2^2
    const [m, e] = call(d, 0x10, [0x4000, 0], 2);
    expect((m / 32768) * 2 ** e).toBeCloseTo(2, 3);
    const [m2, e2] = call(d, 0x10, [0x6000, 3], 2); // 0.75 × 8 = 6
    expect((m2 / 32768) * 2 ** e2).toBeCloseTo(1 / 6, 3);
  });

  it('投影：地面の点を画面に映し、画面の点から地面に戻すと元に戻る', () => {
    const d = new Dsp1();
    // 注視点 (1000, 2000, 0)、目までの距離 300、画面まで 200、北東を向いて 60° 傾ける
    call(d, 0x02, [1000, 2000, 0, 300, 200, Math.round(45 * DEG), Math.round(60 * DEG)], 4);
    for (const [gx, gy] of [
      [1100, 1950],
      [980, 1900],
      [1200, 1700],
    ]) {
      const [h, v, m] = call(d, 0x06, [gx, gy, 0], 3);
      expect(m).toBeGreaterThan(0);
      const [x, y] = call(d, 0x0e, [h, v], 2);
      expect(Math.abs(x - gx), `x ${gx}`).toBeLessThan(gx / 100 + 4);
      expect(Math.abs(y - gy), `y ${gy}`).toBeLessThan(gy / 100 + 4);
    }
  });

  it('モード 7 の係数：続けて読むと次の行になり、1 ドットの動きが画面→地面の変換と合う', () => {
    const d = new Dsp1();
    call(d, 0x02, [0, 0, 0, 400, 256, Math.round(30 * DEG), Math.round(70 * DEG)], 4);
    const v = 10;
    // H を 0 → 64 にしたときの地面の動き
    const [x0, y0] = call(d, 0x0e, [0, v], 2);
    const [x1, y1] = call(d, 0x0e, [64, v], 2);
    const [a, , c] = call(d, 0x0a, [v], 4);
    expect(Math.abs((a / 256) * 64 - (x1 - x0))).toBeLessThan(3);
    expect(Math.abs((c / 256) * 64 - (y1 - y0))).toBeLessThan(3);
    // 続けて読むと次の行（下の行ほど地面は近い = 係数は小さい）
    const [a2] = [((): number => {
      const lo = d.readData();
      const hi = d.readData();
      return ((lo | (hi << 8)) << 16) >> 16;
    })()];
    expect(Math.abs(a2)).toBeLessThan(Math.abs(a) + 1);
  });

  it('最初の引数で 0x80 を書くと命令をやめる', () => {
    const d = new Dsp1();
    d.writeData(0x00);
    d.writeData(0x80);
    // 次の 1 バイトは新しい命令として受け付ける
    expect(call(d, 0x00, [0x2000, 800], 1)).toEqual([200]);
  });
});
