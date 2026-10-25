// テスト用ROM（nestest・blargg のテスト）を test/roms/ にダウンロードする。リポジトリには含めない。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'roms');
const BASE = 'https://raw.githubusercontent.com/christopherpow/nes-test-roms/master/';
const FILES = [
  'other/nestest.nes',
  'other/nestest.log',
  ...[
    '01-vbl_basics', '02-vbl_set_time', '03-vbl_clear_time', '04-nmi_control', '05-nmi_timing',
    '06-suppression', '07-nmi_on_timing', '08-nmi_off_timing', '09-even_odd_frames', '10-even_odd_timing',
  ].map((n) => `ppu_vbl_nmi/rom_singles/${n}.nes`),
  ...['palette_ram', 'sprite_ram', 'vram_access', 'vbl_clear_time'].map((n) => `blargg_ppu_tests_2005.09.15b/${n}.nes`),
  'oam_read/oam_read.nes',
  ...['01.basics', '02.alignment', '03.corners', '04.flip', '05.left_clip', '06.right_edge', '07.screen_bottom', '08.double_height', '09.timing_basics', '10.timing_order', '11.edge_timing']
    .map((n) => `sprite_hit_tests_2005.10.05/${n}.nes`),
];

mkdirSync(dir, { recursive: true });
for (const f of FILES) {
  const path = join(dir, f.split('/').pop());
  if (existsSync(path)) continue;
  const res = await fetch(BASE + f);
  if (!res.ok) throw new Error(`${f} のダウンロードに失敗: ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${f}`);
}
