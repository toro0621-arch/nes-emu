// ZIP ファイルから ROM を取り出す（ROM を ZIP のまま選んでも遊べるように）

const ROM_EXT = /\.(nes|gbc?|gba|wsc?|sfc|smc)$/i;

export function isZip(data: Uint8Array): boolean {
  return data.length > 30 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/** ZIP の中の ROM（なければ一番大きいファイル）を取り出す */
export async function unzipRom(data: Uint8Array): Promise<{ name: string; data: Uint8Array }> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // 中央ディレクトリの終わり（後ろから探す）
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('ZIP ファイルが壊れています');
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  type Entry = { name: string; method: number; size: number; csize: number; offset: number };
  const entries: Entry[] = [];
  for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen));
    if (!name.endsWith('/')) entries.push({ name, method, size, csize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const pick =
    entries.find((e) => ROM_EXT.test(e.name)) ?? entries.slice().sort((a, b) => b.size - a.size)[0];
  if (!pick) throw new Error('ZIP の中にファイルがありません');
  const lh = pick.offset;
  const start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
  const raw = data.subarray(start, start + pick.csize);
  const name = pick.name.split('/').pop() ?? pick.name;
  if (pick.method === 0) return { name, data: raw.slice() };
  if (pick.method !== 8) throw new Error('この圧縮方式の ZIP には未対応です');
  const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return { name, data: new Uint8Array(await new Response(stream).arrayBuffer()) };
}
