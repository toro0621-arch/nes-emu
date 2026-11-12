// プレイステーションのゲームを開く：CD のイメージ（.cue + .bin・.iso）を見分けて、BIOS と一緒に本体を作る

import { PsxMachine } from '../machine';
import type { DiscFile } from '../storage';
import { loadBios } from '../storage';
import { BlobSource, Disc, type DiscSource } from './disc';

export type DiscPick = { name: string; files: DiscFile[] } | { error: string } | null;

const UNSUPPORTED = /\.(chd|pbp|ecm|cso|7z|rar|mds|mdf|ccd|img\.ecm)$/i;

/** 選ばれたファイルがプレイステーションの CD か調べる（違えば null） */
export async function pickDisc(files: File[]): Promise<DiscPick> {
  const bad = files.find((f) => UNSUPPORTED.test(f.name));
  if (bad) return { error: `「${bad.name}」の形式にはまだ対応していません。.bin + .cue か .iso にしてください` };
  const cue = files.find((f) => /\.cue$/i.test(f.name));
  if (cue) {
    const text = await cue.text();
    const need = [...text.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))/gim)].map((m) => (m[1] ?? m[2]).replace(/^.*[\\/]/, ''));
    const out: DiscFile[] = [{ name: cue.name, blob: cue }];
    const missing: string[] = [];
    for (const n of need) {
      const f = files.find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (f) out.push({ name: f.name, blob: f });
      else missing.push(n);
    }
    if (missing.length) {
      // 名前が変わっていても、.bin が 1 つだけ選ばれていればそれを使う
      const bins = files.filter((x) => /\.(bin|img|iso)$/i.test(x.name));
      if (need.length === 1 && bins.length === 1) out.push({ name: need[0], blob: bins[0] });
      else return { error: `「${missing.join('」「')}」も一緒に選んでください（.cue と .bin を両方）` };
    }
    return { name: cue.name.replace(/\.cue$/i, ''), files: out };
  }
  const img = files.find((f) => /\.(bin|iso|img)$/i.test(f.name));
  if (!img) return null;
  if (/\.bin$/i.test(img.name)) {
    // .bin は CD の生のデータ（先頭に同期の印がある）か、とても大きいときだけ
    const head = new Uint8Array(await img.slice(0, 12).arrayBuffer());
    const sync = head[0] === 0 && head[1] === 0xff && head[10] === 0xff && head[11] === 0;
    if (!sync && img.size < 32 * 1024 * 1024) return null;
  }
  return { name: img.name.replace(/\.(bin|iso|img)$/i, ''), files: [{ name: img.name, blob: img }] };
}

/** CD を見分ける ID（全部を読むと時間がかかるので、名前・大きさ・最初の部分から） */
export async function discId(files: DiscFile[]): Promise<string> {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const f of files) {
    parts.push(enc.encode(`${f.name.toLowerCase()}:${f.blob.size};`));
    if (!/\.cue$/i.test(f.name)) {
      parts.push(new Uint8Array(await f.blob.slice(0, 256 * 1024).arrayBuffer()));
      const mid = Math.floor(f.blob.size / 2);
      parts.push(new Uint8Array(await f.blob.slice(mid, mid + 64 * 1024).arrayBuffer()));
    }
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  let hex: string;
  if (crypto.subtle) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
    hex = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    let h = 0x811c9dc5;
    for (let i = 0; i < all.length; i++) h = Math.imul(h ^ all[i], 0x01000193);
    hex = (h >>> 0).toString(16);
  }
  return `psx-${hex}`;
}

/** CD のイメージを開く（最初の部分は読み終わるまで待つ） */
export async function openDisc(files: DiscFile[]): Promise<Disc> {
  const sources = new Map<string, DiscSource>();
  let cueText: string | null = null;
  for (const f of files) {
    if (/\.cue$/i.test(f.name)) cueText = await f.blob.text();
    else {
      const s = new BlobSource(f.blob);
      await s.preload(0, 512 * 1024);
      sources.set(f.name.toLowerCase(), s);
    }
  }
  if (cueText) return Disc.fromCue(cueText, sources);
  const first = [...sources.values()][0];
  if (!first) throw new Error('CD のイメージが見つかりません');
  return Disc.fromSingle(first);
}

let openBios: Uint8Array | null = null;

/** 使う BIOS：自分で入れたものがあればそれ、なければ互換 BIOS（OpenBIOS） */
export async function getBios(): Promise<{ data: Uint8Array; own: boolean }> {
  const own = await loadBios();
  if (own) return { data: own.data, own: true };
  if (!openBios) {
    const res = await fetch(`${import.meta.env.BASE_URL}psx/openbios.bin`);
    if (!res.ok) throw new Error('互換 BIOS を読み込めませんでした（通信を確認してください）');
    openBios = new Uint8Array(await res.arrayBuffer());
  }
  return { data: openBios, own: false };
}

/** 数字の ID（どこでもセーブの取り違えを防ぐ） */
function numId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h >>> 0;
}

export async function createPsx(id: string, files: DiscFile[] | null, exe: Uint8Array | null): Promise<PsxMachine> {
  const bios = await getBios();
  const disc = files ? await openDisc(files) : null;
  return new PsxMachine(bios.data, disc, exe, numId(id));
}
