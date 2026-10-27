// blargg のテスト ROM を動かし、画面（ネームテーブル）に出た結果の文字を読む
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** 結果が出るまで（最大 maxFrames）動かし、画面の文字を返す */
export function runBlargg(name: string, maxFrames = 600): string {
  const nes = new Nes(new Uint8Array(readFileSync(join(ROMS, `${name}.nes`))));
  let text = '';
  for (let frame = 0; frame < maxFrames; frame++) {
    nes.runFrame();
    if (frame % 30 !== 29) continue;
    text = screenText(nes);
    // 2005 年版は結果コードを "$01" の形で出す（1 が合格）
    if (/passed|failed|\$[0-9a-f]{2}/i.test(text)) break;
  }
  return text;
}

export const PASS = /passed|\$01/i;
