// blargg の PPU テスト ROM
import { describe, expect, it } from 'vitest';
import { PASS, runBlargg } from './blargg';

const ROMS_TO_RUN = [
  'palette_ram', 'sprite_ram', 'vram_access', 'vbl_clear_time', 'oam_read',
  '01.basics', '02.alignment', '03.corners', '04.flip', '05.left_clip', '06.right_edge',
  '07.screen_bottom', '08.double_height', '09.timing_basics', '10.timing_order', '11.edge_timing',
  '01-vbl_basics', '02-vbl_set_time', '03-vbl_clear_time', '04-nmi_control', '05-nmi_timing',
  '06-suppression', '07-nmi_on_timing', '08-nmi_off_timing', '09-even_odd_frames', '10-even_odd_timing',
];

describe('PPU (blargg)', () => {
  for (const name of ROMS_TO_RUN) {
    it(name, () => {
      const text = runBlargg(name);
      expect(text, text).toMatch(PASS);
    }, 20000);
  }
});
