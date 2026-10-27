// どこでもセーブ：保存したところから動かし直すと、同じ画面・同じ音になるか
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Nes } from '../src/nes';
import { loadState, saveState } from '../src/savestate';

const ROMS = join(__dirname, 'roms');

/** 画面・RAM・音から作る、ずれを見つけるための値 */
function fingerprint(nes: Nes, frames: number): string {
  let h = 0x811c9dc5;
  const mix = (v: number) => (h = Math.imul(h ^ (v | 0), 0x01000193));
  for (let f = 0; f < frames; f++) {
    nes.runFrame();
    for (const s of nes.apu.takeSamples()) mix(Math.round(s * 1e6));
  }
  for (const v of nes.ppu.frameBuffer) mix(v);
  for (const v of nes.bus.ram) mix(v);
  mix(nes.cpu.cycles);
  return (h >>> 0).toString(16);
}

const ROM_FILES = ['nestest.nes', 'apu_test.nes', 'all_instrs.nes', '5-MMC3.nes', '01.basics.nes'];

describe('どこでもセーブ', () => {
  for (const file of ROM_FILES) {
    it(`${file}：ロードしてから動かすと、セーブしたときの続きと同じになる`, () => {
      const path = join(ROMS, file);
      if (!existsSync(path)) return;
      const rom = new Uint8Array(readFileSync(path));
      const nes = new Nes(rom);
      for (let f = 0; f < 50; f++) nes.runFrame();
      nes.apu.takeSamples();
      // IndexedDB に入れるときと同じように複製してから使う
      const state = structuredClone(saveState(nes));
      const expected = fingerprint(nes, 30);

      // 同じ本体を進めてから戻す
      for (let f = 0; f < 20; f++) nes.runFrame();
      nes.apu.takeSamples();
      loadState(nes, state);
      expect(fingerprint(nes, 30)).toBe(expected);

      // 新しく作った本体に読み込んでも同じ
      const other = new Nes(rom);
      loadState(other, structuredClone(state));
      expect(fingerprint(other, 30)).toBe(expected);
    });
  }

  it('別のマッパーのゲームのセーブは読み込まない', () => {
    const a = join(ROMS, 'nestest.nes');
    const b = join(ROMS, '5-MMC3.nes');
    if (!existsSync(a) || !existsSync(b)) return;
    const state = saveState(new Nes(new Uint8Array(readFileSync(a))));
    expect(() => loadState(new Nes(new Uint8Array(readFileSync(b))), state)).toThrow(/別のゲーム/);
  });
});
