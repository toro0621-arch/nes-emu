// スーパーファミコンのカートリッジ：ヘッダーを探して ROM の並べ方（LoROM・HiROM・ExHiROM）と SRAM を決める

export type SnesMap = 'lorom' | 'hirom' | 'exhirom';

export interface SnesCartInfo {
  map: SnesMap;
  title: string;
  /** SRAM のバイト数（0 = なし） */
  sramSize: number;
  battery: boolean;
  /** 追加チップの名前（対応していないもの）。なければ null */
  chip: string | null;
  /** DSP-1 が入っている（対応しているチップ） */
  dsp1: boolean;
  /** ROM の大きさ（バイト。DSP-1 の置き場所を決める） */
  romSize: number;
  fastRom: boolean;
}

/** SNES の ROM か（ヘッダーらしいものがあるか）。.sfc / .smc の拡張子でも決める */
export function isSnesRom(d: Uint8Array, name = ''): boolean {
  if (/\.(sfc|smc|swc|fig)$/i.test(name)) return true;
  const rom = stripCopier(d);
  if (rom.length < 0x8000) return false;
  return bestHeader(rom).score >= 8;
}

/** コピー機の 512 バイトのヘッダーがあれば取り除く */
export function stripCopier(d: Uint8Array): Uint8Array {
  return (d.length & 0x7fff) === 512 ? d.subarray(512) : d;
}

function scoreHeader(rom: Uint8Array, at: number, map: SnesMap): number {
  if (at + 0x40 > rom.length) return -100;
  let score = 0;
  const mode = rom[at + 0x15];
  const reset = rom[at + 0x3c] | (rom[at + 0x3d] << 8);
  const comp = rom[at + 0x1c] | (rom[at + 0x1d] << 8);
  const sum = rom[at + 0x1e] | (rom[at + 0x1f] << 8);
  if ((comp ^ sum) === 0xffff) score += 8;
  if (reset >= 0x8000) score += 4;
  else score -= 8;
  const m = mode & 0xef;
  if (map === 'lorom' && (m === 0x20 || m === 0x22 || m === 0x23)) score += 4;
  if (map === 'hirom' && (m === 0x21 || m === 0x2a)) score += 4;
  if (map === 'exhirom' && m === 0x25) score += 6;
  if (rom[at + 0x17] >= 0x07 && rom[at + 0x17] <= 0x0d) score += 2;
  if (rom[at + 0x18] <= 0x08) score += 1;
  let printable = 0;
  for (let i = 0; i < 21; i++) {
    const c = rom[at + i];
    if (c >= 0x20 && c < 0x7f) printable++;
  }
  if (printable >= 18) score += 2;
  // リセットで最初に実行する命令がよくあるもの（SEI・CLC・XCE など）
  const op = rom[(at & ~0x7fff) | (reset & 0x7fff)];
  if (op === 0x78 || op === 0x18 || op === 0x38 || op === 0x9c || op === 0x4c || op === 0x5c || op === 0xc2 || op === 0xe2)
    score += 2;
  return score;
}

function bestHeader(rom: Uint8Array): { at: number; map: SnesMap; score: number } {
  const cands: { at: number; map: SnesMap; score: number }[] = [
    { at: 0x7fc0, map: 'lorom', score: 0 },
    { at: 0xffc0, map: 'hirom', score: 0 },
    { at: 0x40ffc0, map: 'exhirom', score: 0 },
  ];
  for (const c of cands) c.score = scoreHeader(rom, c.at, c.map);
  cands.sort((a, b) => b.score - a.score);
  return cands[0];
}

const CHIPS: Record<number, string> = {
  0x0: 'DSP',
  0x1: 'スーパーFX',
  0x2: 'OBC1',
  0x3: 'SA-1',
  0x4: 'S-DD1',
  0x5: 'S-RTC',
  0xe: 'スーパーゲームボーイなど',
  0xf: '特別なチップ',
};

export function cartInfo(rom: Uint8Array): SnesCartInfo {
  const h = bestHeader(rom);
  const at = h.at;
  const type = rom[at + 0x16];
  let title = '';
  for (let i = 0; i < 21; i++) {
    const c = rom[at + i];
    title += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ' ';
  }
  const sramCode = rom[at + 0x18];
  // 種類の下位 4 ビット：0 ROM だけ、1 RAM、2 RAM + 電池、3〜6 はチップつき
  const hasRam = [1, 2, 4, 5].includes(type & 0x0f);
  const sramSize = hasRam && sramCode > 0 ? 1024 << Math.min(sramCode, 8) : 0;
  const battery = (type & 0x0f) === 2 || (type & 0x0f) === 5 || (type & 0x0f) === 6;
  let chip = (type & 0x0f) >= 3 ? (CHIPS[type >> 4] ?? '特別なチップ') : null;
  // DSP の中でも DSP-1 は動かせる（DSP-2〜4 は別の中身なのでタイトルで見分ける）
  let dsp1 = false;
  if (chip === 'DSP') {
    const t = title.toUpperCase();
    if (t.startsWith('DUNGEON MASTER')) chip = 'DSP-2';
    else if (t.startsWith('SD') && t.includes('GUNDAM GX')) chip = 'DSP-3';
    else if (t.startsWith('TOP GEAR 3000')) chip = 'DSP-4';
    else {
      chip = null;
      dsp1 = true;
    }
  }
  return {
    dsp1,
    romSize: rom.length,
    map: h.map,
    title: title.trim(),
    sramSize,
    battery,
    chip,
    fastRom: (rom[at + 0x15] & 0x10) !== 0,
  };
}

/** ROM の大きさが 2 のべき乗でないとき、実機と同じように上の部分をくり返して並べ直す */
export function mirrorRom(rom: Uint8Array): Uint8Array {
  let size = 1;
  while (size < rom.length) size <<= 1;
  if (size === rom.length) return rom;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = rom[mirror(i, rom.length)];
  return out;
}

function mirror(addr: number, size: number): number {
  let base = 0;
  let mask = 1 << 23;
  while (addr >= size) {
    while (!(addr & mask)) mask >>= 1;
    addr -= mask;
    if (size > mask) {
      size -= mask;
      base += mask;
    }
    mask >>= 1;
  }
  return base + addr;
}
