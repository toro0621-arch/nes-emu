// blargg の APU テスト ROM（apu_test）
import { describe, expect, it } from 'vitest';
import { PASS, runBlargg } from './blargg';

const ROMS_TO_RUN = [
  '1-len_ctr', '2-len_table', '3-irq_flag', '4-jitter',
  '5-len_timing', '6-irq_flag_timing', '7-dmc_basics', '8-dmc_rates',
];

describe('APU (blargg apu_test)', () => {
  for (const name of ROMS_TO_RUN) {
    it(name, () => {
      const text = runBlargg(name);
      expect(text, text).toMatch(PASS);
    }, 20000);
  }
});
