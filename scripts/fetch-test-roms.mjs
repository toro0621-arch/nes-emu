// テスト用ROM（nestest）を test/roms/ にダウンロードする。リポジトリには含めない。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'roms');
const BASE = 'https://raw.githubusercontent.com/christopherpow/nes-test-roms/master/other/';
const FILES = ['nestest.nes', 'nestest.log'];

mkdirSync(dir, { recursive: true });
for (const f of FILES) {
  const path = join(dir, f);
  if (existsSync(path)) continue;
  const res = await fetch(BASE + f);
  if (!res.ok) throw new Error(`${f} のダウンロードに失敗: ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${f}`);
}
