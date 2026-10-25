// blargg の PPU テスト ROM を動かし、画面（ネームテーブル）に出た結果の文字を読む
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Nes } from '../src/nes';

const ROMS = join(__dirname, 'roms');

/** ネームテーブル 0 に書かれた文字（テスト ROM はタイル番号 = ASCII） */
function screenText(nes: Nes): string {
  const lines: string[] = [];
  for (let r = 0; r < 30; r++) {
    let line = '';
    for (let c = 0; c < 32; c++) {
      const b = nes.ppu.vram[r * 32 + c];
      line += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join('\n');
}

function run(name: string): string {
  const nes = new Nes(new Uint8Array(readFileSync(join(ROMS, `${name}.nes`))));
  let text = '';
  for (let frame = 0; frame < 600; frame++) {
    nes.runFrame();
    if (frame % 30 !== 29) continue;
    text = screenText(nes);
    // 2005 年版は結果コードを "$01" の形で出す（1 が合格）
    if (/passed|failed|\$[0-9a-f]{2}/i.test(text)) break;
  }
  return text;
}

const PASS = /passed|\$01/i;

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
      const text = run(name);
      expect(text, text).toMatch(PASS);
    }, 20000);
  }
});
