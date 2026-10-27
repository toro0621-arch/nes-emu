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

/**
 * 新しめのテストは $6000 に状態（$80 = 実行中、$81 = リセットしてほしい、それ以外 = 結果コード）、
 * $6001-$6003 に目印 DE B0 61、$6004 から結果の文章を書く
 */
function memoryResult(nes: Nes): { status: number; text: string } | null {
  const bus = nes.bus;
  if (bus.read(0x6001) !== 0xde || bus.read(0x6002) !== 0xb0 || bus.read(0x6003) !== 0x61) return null;
  let text = '';
  for (let a = 0x6004; a < 0x7000; a++) {
    const c = bus.read(a);
    if (!c) break;
    text += String.fromCharCode(c);
  }
  return { status: bus.read(0x6000), text: text.trim() };
}

/** 結果が出るまで（最大 maxFrames）動かし、結果の文章を返す */
export function runBlargg(name: string, maxFrames = 600): string {
  const nes = new Nes(new Uint8Array(readFileSync(join(ROMS, `${name}.nes`))));
  let text = '';
  let resetAt = -1;
  for (let frame = 0; frame < maxFrames; frame++) {
    nes.runFrame();
    const mem = memoryResult(nes);
    if (mem) {
      if (mem.status === 0x81 && resetAt < 0) resetAt = frame + 10; // 少し待ってからリセットを押す
      if (frame === resetAt) {
        nes.reset();
        resetAt = -1;
      }
      if (mem.status < 0x80) return `${mem.text}\n(result ${mem.status})`;
      continue;
    }
    if (frame % 30 !== 29) continue;
    text = screenText(nes);
    // 2005 年版は結果コードを "$01" の形で出す（1 が合格）
    if (/passed|failed|\$[0-9a-f]{2}/i.test(text)) break;
  }
  return text;
}

export const PASS = /passed|\$01/i;
