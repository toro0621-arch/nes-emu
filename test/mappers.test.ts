// マッパー 1（MMC1）・4（MMC3）を使う blargg のテスト ROM（マッパー 2 はテスト ROM がないので mapper-units.test.ts で確かめる）
import { describe, expect, it } from 'vitest';
import { PASS, runBlargg } from './blargg';

describe('MMC1 を使うテスト ROM', () => {
  // [名前, 最大フレーム数]（まとめた ROM は時間がかかる）
  const roms: [string, number][] = [
    ['all_instrs', 8000],
    ['official_only', 8000],
    ['instr_timing', 8000],
    ['ppu_vbl_nmi', 8000],
    ['apu_test', 8000],
  ];
  for (const [name, frames] of roms) {
    it(name, () => {
      const text = runBlargg(name, frames);
      expect(text, text).toMatch(PASS);
    }, 120000);
  }
});

describe('MMC3（mmc3_test_2）', () => {
  for (const name of ['1-clocking', '2-details', '3-A12_clocking', '4-scanline_timing', '5-MMC3']) {
    it(name, () => {
      const text = runBlargg(name);
      expect(text, text).toMatch(PASS);
    }, 30000);
  }
});
