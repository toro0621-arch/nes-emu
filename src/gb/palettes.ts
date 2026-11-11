// 白黒のゲームボーイのソフトに色をつけるパレット。
// ゲームボーイカラーの本体が白黒のソフトに使った色づけ（起動時のボタンで選べた 12 種類）をもとにしている
import { DMG_COLORS, toAbgr, type GbPpu } from './ppu';

type Four = [number, number, number, number];

export interface GbPalette {
  id: string;
  name: string;
  bg: Four;
  obj0: Four;
  obj1: Four;
}

const RED_OBJ: Four = [0xffffff, 0xff8484, 0x943a3a, 0x000000];
const same = (id: string, name: string, c: Four): GbPalette => ({ id, name, bg: c, obj0: c, obj1: c });

export const GB_PALETTES: GbPalette[] = [
  { id: 'color', name: 'カラー（標準）', bg: [0xffffff, 0x7bff31, 0x0063c5, 0x000000], obj0: RED_OBJ, obj1: RED_OBJ },
  same('red', '赤', [0xffffff, 0xff8484, 0x943a3a, 0x000000]),
  { id: 'blue', name: '青', bg: [0xffffff, 0x63a5ff, 0x0000ff, 0x000000], obj0: RED_OBJ, obj1: RED_OBJ },
  same('green', '緑', [0xffffff, 0x52ff00, 0xff4200, 0x000000]),
  same('brown', '茶', [0xffffff, 0xffad63, 0x843100, 0x000000]),
  {
    id: 'darkblue',
    name: '紺',
    bg: [0xffffff, 0x8c8cde, 0x52528c, 0x000000],
    obj0: RED_OBJ,
    obj1: [0xffffff, 0xffad63, 0x843100, 0x000000],
  },
  {
    id: 'yellow',
    name: '黄',
    bg: [0xffffff, 0xffff00, 0x7b4a00, 0x000000],
    obj0: [0xffffff, 0x63a5ff, 0x0000ff, 0x000000],
    obj1: [0xffffff, 0x7bff31, 0x008400, 0x000000],
  },
  same('orange', '黄と赤', [0xffffff, 0xffff00, 0xff0000, 0x000000]),
  same('pastel', 'パステル', [0xffffa5, 0xff9494, 0x9494ff, 0x000000]),
  same('sepia', 'セピア', [0xffe6c5, 0xce9c84, 0x846b29, 0x5a3108]),
  same('gray', 'グレー', [0xffffff, 0xa5a5a5, 0x525252, 0x000000]),
  same('invert', '反転', [0x000000, 0x008484, 0xffde00, 0xffffff]),
];

/** 「白黒（液晶）」：色をつけない（昔の液晶っぽい緑） */
export const MONO_ID = 'mono';
/** 「おまかせ」：ソフトの名前から選び、知らないソフトは標準のカラー */
export const AUTO_ID = 'auto';

/** ソフトの名前（ヘッダーの題名）からパレットを選ぶ */
const BY_TITLE: [RegExp, string][] = [
  [/^POKEMON RED/, 'red'],
  [/^POKEMON BLUE/, 'blue'],
  [/^POKEMON GREEN/, 'green'],
  [/^TETRIS/, 'orange'],
  [/^ZELDA/, 'color'],
  [/^SUPER MARIOLAND|^SUPERMARIOLAND|^MARIOLAND/, 'brown'],
  [/^KIRBY|^KIRBY DREAM LAND/, 'pastel'],
  [/^METROID2/, 'yellow'],
  [/^DR\.MARIO|^DR MARIO/, 'orange'],
];

export function autoPalette(title: string): string {
  for (const [re, id] of BY_TITLE) if (re.test(title)) return id;
  return 'color';
}

/** パレットを画面に反映する（id は MONO_ID・AUTO_ID・GB_PALETTES の id） */
export function applyGbPalette(ppu: GbPpu, id: string, title: string): void {
  if (id === MONO_ID) {
    ppu.dmgBg.set(DMG_COLORS);
    ppu.dmgObj0.set(DMG_COLORS);
    ppu.dmgObj1.set(DMG_COLORS);
    return;
  }
  const p = GB_PALETTES.find((x) => x.id === (id === AUTO_ID ? autoPalette(title) : id)) ?? GB_PALETTES[0];
  ppu.dmgBg.set(p.bg.map(toAbgr));
  ppu.dmgObj0.set(p.obj0.map(toAbgr));
  ppu.dmgObj1.set(p.obj1.map(toAbgr));
}
