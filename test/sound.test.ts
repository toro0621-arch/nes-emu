// 音が正しい高さで出るかを、出力波形の 0 交差の数から周波数を測って確かめる
import { describe, expect, it } from 'vitest';
import { Apu, CPU_HZ } from '../src/apu';
import { Nes } from '../src/nes';

/** 6502 のコードを $8000 に置いた NROM（16KB）を作る。NMI/IRQ は RTI だけのところへ */
function makeRom(code: number[]): Uint8Array {
  const prg = new Uint8Array(0x4000);
  prg.set(code);
  const rti = code.length;
  prg[rti] = 0x40;
  const vec = (off: number, addr: number) => {
    prg[off] = addr & 0xff;
    prg[off + 1] = addr >> 8;
  };
  vec(0x3ffa, 0x8000 + rti); // NMI
  vec(0x3ffc, 0x8000); // RESET
  vec(0x3ffe, 0x8000 + rti); // IRQ
  const header = [0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return Uint8Array.from([...header, ...prg, ...new Uint8Array(0x2000)]);
}

/** 正方向へ 0 を横切る回数 ÷ 秒数 */
function frequency(samples: Float32Array, rate: number): number {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] - mean < 0 && samples[i] - mean >= 0) crossings++;
  return crossings / (samples.length / rate);
}

function rms(samples: Float32Array): number {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length);
}

function runApu(setup: (apu: Apu) => void, seconds = 0.5): Float32Array {
  const apu = new Apu(() => 0, () => {}, () => {});
  setup(apu);
  const out: number[] = [];
  for (let i = 0; i < CPU_HZ * seconds; i++) {
    apu.tick();
    if (apu.sampleLength > 3000) out.push(...apu.takeSamples());
  }
  out.push(...apu.takeSamples());
  return Float32Array.from(out.slice(2000)); // 立ち上がり（ハイパスが落ち着くまで）は除く
}

describe('APU の音', () => {
  it('矩形波：周期 253 → 440Hz', () => {
    const s = runApu((apu) => {
      apu.write(0x4015, 0x01);
      apu.write(0x4000, 0xbf); // デューティ 50%、長さ固定、音量 15
      apu.write(0x4002, 253);
      apu.write(0x4003, 0x00);
    });
    expect(frequency(s, 48000)).toBeCloseTo(CPU_HZ / (16 * 254), -1);
    expect(rms(s)).toBeGreaterThan(0.02);
  });

  it('三角波：周期 253 → 220Hz（矩形波の半分）', () => {
    const s = runApu((apu) => {
      apu.write(0x4015, 0x04);
      apu.write(0x4008, 0xff); // 長さ・線形カウンタ固定
      apu.write(0x400a, 253);
      apu.write(0x400b, 0x00);
    });
    expect(frequency(s, 48000)).toBeCloseTo(CPU_HZ / (32 * 254), -1);
  });

  it('ノイズ：音が出る', () => {
    const s = runApu((apu) => {
      apu.write(0x4015, 0x08);
      apu.write(0x400c, 0x3f);
      apu.write(0x400e, 0x04);
      apu.write(0x400f, 0x00);
    });
    expect(rms(s)).toBeGreaterThan(0.01);
  });

  it('何も鳴らさなければ無音', () => {
    expect(rms(runApu(() => {}))).toBeLessThan(1e-4);
  });

  it('$4015 で止めると音が消える', () => {
    const s = runApu((apu) => {
      apu.write(0x4015, 0x01);
      apu.write(0x4000, 0xbf);
      apu.write(0x4002, 253);
      apu.write(0x4003, 0x00);
      apu.write(0x4015, 0x00);
    });
    expect(rms(s)).toBeLessThan(1e-4);
  });

  it('ROM から鳴らした音が、動いた時間ぶん出て 440Hz になる', () => {
    // SEI / CLD / $4015=1 / $4000=$BF / $4001=$08 / $4002=$FD / $4003=$00 / 無限ループ
    const code = [
      0x78, 0xd8, 0xa9, 0x01, 0x8d, 0x15, 0x40, 0xa9, 0xbf, 0x8d, 0x00, 0x40, 0xa9, 0x08, 0x8d, 0x01, 0x40,
      0xa9, 0xfd, 0x8d, 0x02, 0x40, 0xa9, 0x00, 0x8d, 0x03, 0x40, 0x4c, 0x1b, 0x80,
    ];
    const nes = new Nes(makeRom(code));
    const out: number[] = [];
    for (let f = 0; f < 60; f++) {
      nes.runFrame();
      out.push(...nes.apu.takeSamples());
    }
    // 動いた CPU サイクル数ぶんの時間だけ音が出ている（最初のフレームは電源投入からなので少し短い）
    expect(Math.abs(out.length - (nes.cpu.cycles * 48000) / CPU_HZ)).toBeLessThan(2);
    expect(out.length).toBeGreaterThan(47000);
    expect(frequency(Float32Array.from(out.slice(2000)), 48000)).toBeCloseTo(440.4, -1);
  });
});
