// テスト用ROM（nestest・blargg のテスト）を test/roms/ にダウンロードする。リポジトリには含めない。
// ゲームボーイのテスト ROM は test/roms/gb/ に置く
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
  // マッパー 1（MMC1）を使う、複数のテストをまとめた ROM
  'instr_test-v5/all_instrs.nes',
  'instr_test-v5/official_only.nes',
  'instr_timing/instr_timing.nes',
  'ppu_vbl_nmi/ppu_vbl_nmi.nes',
  'apu_test/apu_test.nes',
  // マッパー 4（MMC3）
  ...['1-clocking', '2-details', '3-A12_clocking', '4-scanline_timing', '5-MMC3', '6-MMC3_alt']
    .map((n) => `mmc3_test_2/rom_singles/${n}.nes`),
  ...['1-len_ctr', '2-len_table', '3-irq_flag', '4-jitter', '5-len_timing', '6-irq_flag_timing', '7-dmc_basics', '8-dmc_rates']
    .map((n) => `apu_test/rom_singles/${n}.nes`),
  ...['01.basics', '02.alignment', '03.corners', '04.flip', '05.left_clip', '06.right_edge', '07.screen_bottom', '08.double_height', '09.timing_basics', '10.timing_order', '11.edge_timing']
    .map((n) => `sprite_hit_tests_2005.10.05/${n}.nes`),
];

const GB_BASE = 'https://raw.githubusercontent.com/retrio/gb-test-roms/master/';
/** [元の場所, 保存する名前] */
const GB_FILES = [
  ['cpu_instrs/cpu_instrs.gb', 'cpu_instrs.gb'],
  ['instr_timing/instr_timing.gb', 'instr_timing.gb'],
  ['mem_timing/mem_timing.gb', 'mem_timing.gb'],
  ['mem_timing-2/mem_timing.gb', 'mem_timing-2.gb'],
  ['halt_bug.gb', 'halt_bug.gb'],
  ['interrupt_time/interrupt_time.gb', 'interrupt_time.gb'],
  ['dmg_sound/dmg_sound.gb', 'dmg_sound.gb'],
  ['cgb_sound/cgb_sound.gb', 'cgb_sound.gb'],
];

async function download(url, path) {
  if (existsSync(path)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} のダウンロードに失敗: ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${url}`);
}

mkdirSync(join(dir, 'gb'), { recursive: true });
for (const f of FILES) await download(BASE + f, join(dir, f.split('/').pop()));
for (const [f, name] of GB_FILES) await download(GB_BASE + f, join(dir, 'gb', name));
