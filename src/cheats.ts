// 改造コード（チート）：コードを読み取って、毎フレーム RAM に書き込む・ROM の値を差し替える

import type { System } from './machine';

/** 1 つの命令 */
export type CheatOp =
  | { kind: 'write'; addr: number; val: number; size: 1 | 2 }
  /** 次の 1 つを、この場所の値が val と同じ（eq）/違う（!eq）ときだけ */
  | { kind: 'if'; addr: number; val: number; size: 1 | 2; eq: boolean }
  /** ROM のこの場所を読んだら val を返す（cmp があれば、元の値が cmp のときだけ） */
  | { kind: 'rom'; addr: number; val: number; cmp: number };

export interface RomPatch {
  addr: number;
  val: number;
  cmp: number;
}

/** 改造コードを使える本体の窓口 */
export interface CheatTarget {
  poke(addr: number, v: number): void;
  peek(addr: number): number;
  setRomPatches(p: RomPatch[]): void;
}

export interface Cheat {
  name: string;
  code: string;
  on: boolean;
}

const NES_GG = 'APZLGITYEOXUKSVN';
const SNES_GG = 'DF4709156BC8A23E';

const hex = (s: string) => parseInt(s, 16);

/** ふつうの「アドレス:値」（値が 2 桁なら 1 バイト、4 桁なら 2 バイト） */
function raw(code: string): CheatOp | null {
  const m = code.match(/^([0-9A-F]{4,8})[:\-=\s]([0-9A-F]{2}|[0-9A-F]{4})$/);
  if (!m) return null;
  return { kind: 'write', addr: hex(m[1]), val: hex(m[2]), size: m[2].length === 4 ? 2 : 1 };
}

function nesGenie(code: string): CheatOp | null {
  if (!/^[APZLGITYEOXUKSVN]{6}([APZLGITYEOXUKSVN]{2})?$/.test(code)) return null;
  const n = Array.from(code, (c) => NES_GG.indexOf(c));
  const addr =
    0x8000 |
    ((n[3] & 7) << 12) |
    ((n[5] & 7) << 8) |
    ((n[4] & 8) << 8) |
    ((n[2] & 7) << 4) |
    ((n[1] & 8) << 4) |
    (n[4] & 7) |
    (n[3] & 8);
  if (n.length === 6) {
    const val = ((n[1] & 7) << 4) | ((n[0] & 8) << 4) | (n[0] & 7) | (n[5] & 8);
    return { kind: 'rom', addr, val, cmp: -1 };
  }
  const val = ((n[1] & 7) << 4) | ((n[0] & 8) << 4) | (n[0] & 7) | (n[7] & 8);
  const cmp = ((n[7] & 7) << 4) | ((n[6] & 8) << 4) | (n[6] & 7) | (n[5] & 8);
  return { kind: 'rom', addr, val, cmp };
}

function gbGenie(code: string): CheatOp | null {
  const m = code.match(/^([0-9A-F]{3})-?([0-9A-F]{3})(?:-?([0-9A-F]{3}))?$/);
  if (!m) return null;
  const s = m[1] + m[2] + (m[3] ?? '');
  const d = Array.from(s, (c) => hex(c));
  const val = (d[0] << 4) | d[1];
  const addr = ((d[5] ^ 0xf) << 12) | (d[2] << 8) | (d[3] << 4) | d[4];
  if (addr >= 0x8000) return null;
  let cmp = -1;
  if (d.length === 9) {
    const x = (d[6] << 4) | d[8];
    cmp = (((x >> 2) | (x << 6)) & 0xff) ^ 0xba;
  }
  return { kind: 'rom', addr, val, cmp };
}

function gbShark(code: string): CheatOp | null {
  const m = code.match(/^([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/);
  if (!m) return null;
  return { kind: 'write', addr: hex(m[4] + m[3]), val: hex(m[2]), size: 1 };
}

function snesGenie(code: string): CheatOp | null {
  const m = code.match(/^([0-9A-F]{4})-([0-9A-F]{4})$/);
  if (!m) return null;
  const n = Array.from(m[1] + m[2], (c) => SNES_GG.indexOf(c));
  const val = (n[0] << 4) | n[1];
  let t = 0;
  for (let i = 2; i < 8; i++) t = (t << 4) | n[i];
  // t のビット（上から）：i j k l q r s t o p a b c d u v w x e f g h m n
  // アドレス（上から）：a b c d e f g h i j k l m n o p q r s t u v w x
  const order = 'ijklqrstopabcduvwxefghmn';
  let addr = 0;
  for (let k = 0; k < 24; k++) {
    if (t & (1 << (23 - k))) addr |= 1 << (23 - (order.charCodeAt(k) - 97));
  }
  return { kind: 'rom', addr, val, cmp: -1 };
}

function snesPar(code: string): CheatOp | null {
  const m = code.match(/^([0-9A-F]{6}):?([0-9A-F]{2})$/);
  if (!m) return null;
  const addr = hex(m[1]);
  const bank = addr >> 16;
  const off = addr & 0xffff;
  // RAM（WRAM・SRAM）なら毎フレーム書き込み、ROM なら差し替え
  const ram =
    bank === 0x7e ||
    bank === 0x7f ||
    (bank >= 0x70 && bank <= 0x7d) ||
    (!(bank & 0x40) && off < 0x2000) ||
    (!(bank & 0x40) && off >= 0x6000 && off < 0x8000);
  return ram ? { kind: 'write', addr, val: hex(m[2]), size: 1 } : { kind: 'rom', addr, val: hex(m[2]), cmp: -1 };
}

/** GBA のコードブレイカー（暗号なし） */
function gbaCb(code: string): CheatOp | null {
  const m = code.match(/^([0-9A-F])([0-9A-F]{7})\s?([0-9A-F]{4})$/);
  if (!m) return null;
  const addr = hex(m[2]);
  const val = hex(m[3]);
  switch (m[1]) {
    case '3':
      return { kind: 'write', addr, val: val & 0xff, size: 1 };
    case '8':
      return { kind: 'write', addr: addr & ~1, val, size: 2 };
    case '7':
      return { kind: 'if', addr: addr & ~1, val, size: 2, eq: true };
    case 'A':
      return { kind: 'if', addr: addr & ~1, val, size: 2, eq: false };
  }
  return null;
}

/** プレイステーションのプロアクションリプレイ（ゲームシャーク） */
function psxPar(code: string): CheatOp | null {
  const m = code.match(/^([0-9A-F]{2})([0-9A-F]{6})\s?([0-9A-F]{4})$/);
  if (!m) return null;
  const addr = (0x80000000 | hex(m[2])) >>> 0;
  const val = hex(m[3]);
  switch (m[1]) {
    case '80':
      return { kind: 'write', addr, val, size: 2 };
    case '30':
      return { kind: 'write', addr, val: val & 0xff, size: 1 };
    case 'D0':
      return { kind: 'if', addr, val, size: 2, eq: true };
    case 'D1':
      return { kind: 'if', addr, val, size: 2, eq: false };
    case 'E0':
      return { kind: 'if', addr, val: val & 0xff, size: 1, eq: true };
    case 'E1':
      return { kind: 'if', addr, val: val & 0xff, size: 1, eq: false };
  }
  return null;
}

/** NINTENDO64 のゲームシャーク（プロアクションリプレイ） */
function n64Shark(code: string): CheatOp | null {
  const m = code.match(/^([0-9A-F]{2})([0-9A-F]{6})\s?([0-9A-F]{4})$/);
  if (!m) return null;
  const addr = (0x80000000 | hex(m[2])) >>> 0;
  const val = hex(m[3]);
  // 64 は上位バイトが先なので、16 ビットは 2 バイトを入れ替えて書く
  const swap = ((val & 0xff) << 8) | (val >> 8);
  switch (m[1]) {
    case '80':
    case 'A0':
      return { kind: 'write', addr, val: val & 0xff, size: 1 };
    case '81':
    case 'A1':
      return { kind: 'write', addr, val: swap, size: 2 };
    case 'D0':
      return { kind: 'if', addr, val: val & 0xff, size: 1, eq: true };
    case 'D1':
      return { kind: 'if', addr, val: swap, size: 2, eq: true };
    case 'D2':
      return { kind: 'if', addr, val: val & 0xff, size: 1, eq: false };
    case 'D3':
      return { kind: 'if', addr, val: swap, size: 2, eq: false };
  }
  return null;
}

const PARSERS: Record<System, ((c: string) => CheatOp | null)[]> = {
  nes: [nesGenie, raw],
  gb: [gbShark, gbGenie, raw],
  snes: [snesGenie, snesPar, raw],
  gba: [gbaCb, raw],
  psx: [psxPar, raw],
  ws: [raw],
  n64: [n64Shark, raw],
};

/** 本体ごとに使えるコードの書き方（メニューの説明） */
export const CHEAT_HELP: Record<System, string> = {
  nes: 'ゲームジーニー（SXIOPO・AEUZZGEA など）、または「アドレス:値」（0075:09 など）',
  gb: 'ゲームシャーク（010FA0C1 など）、ゲームジーニー（00A-17B-C49 など）、または「アドレス:値」',
  snes: 'プロアクションリプレイ（7E0DBF63 など）、ゲームジーニー（C2B4-D4A7 など）、または「アドレス:値」',
  gba: 'コードブレイカー（32000000 00FF など。暗号になっているものは使えません）、または「アドレス:値」',
  psx: 'プロアクションリプレイ（800A1234 03E7 など。80・30・D0・D1・E0・E1 で始まるもの）',
  ws: '「アドレス:値」（1234:63 など）',
  n64: 'ゲームシャーク（8033B21E 0008 など。80・81・D0・D1・D2・D3 で始まるもの）',
};

/** 何行でも、1 行に 1 つずつ。読めないものがあれば、その行を例外のメッセージにする */
export function parseCheat(system: System, text: string): CheatOp[] {
  const ops: CheatOp[] = [];
  const lines = text
    .toUpperCase()
    .replace(/[　]/g, ' ')
    .split(/[\n+,;]/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    // 16 進数を全角で書いた場合も読めるように
    const c = line.replace(/[０-９Ａ-Ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\s+/g, ' ');
    let op: CheatOp | null = null;
    for (const p of PARSERS[system]) {
      op = p(c) ?? p(c.replace(/\s/g, ''));
      if (op) break;
    }
    if (!op) throw new Error(`「${line}」は読めないコードです`);
    ops.push(op);
  }
  if (!ops.length) throw new Error('コードを入れてください');
  return ops;
}

/** オンの改造コードをまとめて持ち、毎フレームかける */
export class CheatRunner {
  private ops: CheatOp[] = [];

  /** オンのコードを入れ直す（ROM の差し替えもここで） */
  set(system: System, cheats: Cheat[], target: CheatTarget | null): void {
    this.ops = [];
    for (const c of cheats) {
      if (!c.on) continue;
      try {
        this.ops.push(...parseCheat(system, c.code));
      } catch {
        // 読めないものは使わない
      }
    }
    target?.setRomPatches(
      this.ops.filter((o): o is Extract<CheatOp, { kind: 'rom' }> => o.kind === 'rom').map(({ addr, val, cmp }) => ({ addr, val, cmp })),
    );
  }

  get active(): boolean {
    return this.ops.some((o) => o.kind !== 'rom');
  }

  /** 1 フレームに 1 回 */
  apply(t: CheatTarget): void {
    const ops = this.ops;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (o.kind === 'write') {
        t.poke(o.addr, o.val & 0xff);
        if (o.size === 2) t.poke(o.addr + 1, o.val >> 8);
      } else if (o.kind === 'if') {
        let v = t.peek(o.addr);
        if (o.size === 2) v |= t.peek(o.addr + 1) << 8;
        if ((v === o.val) !== o.eq) i++; // 次の 1 つを飛ばす
      }
    }
  }
}
