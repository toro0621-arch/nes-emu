import type { Nes } from './nes';

// どこでもセーブ（ステートセーブ）：エミュレータの中身をまるごと写し取り、あとで書き戻す。
// CPU・PPU・APU・マッパーの各オブジェクトのフィールドを順にたどって、数値・真偽値・配列・型付き配列を写す。
// 関数や、ほかの部品への参照（CPU が持つバスなど）と、ROM そのものは写さない

/** 形式が変わったら上げる（古いセーブは読み込まない） */
export const STATE_VERSION = 1;

export interface SaveState {
  version: number;
  /** 本体（ないものはファミコン） */
  system?: 'nes' | 'gb' | 'ws' | 'gba' | 'snes' | 'psx';
  mapper: number;
  parts: Record<string, unknown>;
}

/** 写さないフィールド（画面・音の出力バッファ。次のフレームで作り直される） */
const SKIP_KEYS = new Set(['frameBuffer', 'samples', 'sampleLength', 'cart', 'host', 'genie']);

type Obj = Record<string, unknown>;

function isTyped(v: unknown): v is Uint8Array | Uint16Array | Uint32Array | Float32Array | Int8Array | Int16Array | Int32Array {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

export function saveState(nes: Nes): SaveState {
  const skip = new Set<unknown>([nes.cpu, nes.ppu, nes.apu, nes.bus, nes.mapper, nes.cart, nes.cart.prg]);
  if (!nes.cart.chrRam) skip.add(nes.cart.chr);
  return captureState('nes', nes.cart.mapper, partsOf(nes), skip);
}

/**
 * 部品（CPU・画面・音など）のフィールドを写し取る。skip にあるもの（ほかの部品・ROM）は写さない
 */
export function captureState(
  system: 'nes' | 'gb' | 'ws' | 'gba' | 'snes' | 'psx',
  mapper: number,
  partsIn: Record<string, object>,
  skip: Set<unknown>,
): SaveState {
  const snap = (v: unknown, depth: number): unknown => {
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' || v === null) return v;
    if (isTyped(v)) return v.slice();
    if (Array.isArray(v)) return v.map((x) => snap(x, depth + 1));
    if (typeof v === 'object' && depth < 8) {
      const out: Obj = {};
      for (const [k, x] of Object.entries(v as Obj)) {
        if (SKIP_KEYS.has(k) || typeof x === 'function' || x === undefined || skip.has(x)) continue;
        out[k] = snap(x, depth + 1);
      }
      return out;
    }
    return undefined;
  };

  const parts: Record<string, unknown> = {};
  for (const [name, part] of Object.entries(partsIn)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(part as unknown as Obj)) {
      if (SKIP_KEYS.has(k) || typeof x === 'function' || x === undefined || skip.has(x)) continue;
      out[k] = snap(x, 1);
    }
    parts[name] = out;
  }
  return { version: STATE_VERSION, system, mapper, parts };
}

/** 書き戻す。形式やマッパーが合わなければ例外 */
export function loadState(nes: Nes, state: SaveState): void {
  applyState(state, 'nes', nes.cart.mapper, partsOf(nes));
  // 読み込んだバッテリー RAM もセーブデータとして保存し直す
  nes.mapper.saveDirty = nes.mapper.saveRam !== null;
}

export function applyState(state: SaveState, system: 'nes' | 'gb' | 'ws' | 'gba' | 'snes' | 'psx', mapper: number, parts: Record<string, object>): void {
  if (!state || state.version !== STATE_VERSION) throw new Error('このセーブは古い形式なので読み込めません');
  if ((state.system ?? 'nes') !== system || state.mapper !== mapper) throw new Error('別のゲームのセーブです');

  // 今あるオブジェクトの中身を書き換える（クラスのメソッドはそのまま使えるように）
  const restore = (target: Obj, saved: Obj): void => {
    for (const [k, v] of Object.entries(saved)) {
      const cur = target[k];
      if (isTyped(cur) && isTyped(v)) {
        if (cur.length === v.length) cur.set(v as never);
        else target[k] = v.slice();
      } else if (Array.isArray(cur) && Array.isArray(v)) {
        if (cur.length === v.length && cur.some((x) => x !== null && typeof x === 'object')) {
          // オブジェクトの配列（コントローラーなど）は、1 つずつ中身を書き戻す
          v.forEach((x, i) => {
            if (cur[i] !== null && typeof cur[i] === 'object' && x !== null && typeof x === 'object') restore(cur[i] as Obj, x as Obj);
            else cur[i] = x;
          });
        } else {
          // 数値の配列は新しい配列に置き換える（定数の表を指していることがあるので、中身は書き換えない）
          target[k] = structuredCloneArray(v);
        }
      } else if (cur !== null && typeof cur === 'object' && !isTyped(cur) && v !== null && typeof v === 'object') {
        restore(cur as Obj, v as Obj);
      } else {
        target[k] = v;
      }
    }
  };

  for (const [name, saved] of Object.entries(state.parts)) {
    const part = parts[name];
    if (part) restore(part as unknown as Obj, saved as Obj);
  }
}

function structuredCloneArray(v: unknown[]): unknown[] {
  return v.map((x) => (Array.isArray(x) ? structuredCloneArray(x) : x !== null && typeof x === 'object' ? { ...(x as Obj) } : x));
}

function partsOf(nes: Nes): Record<string, object> {
  return { cpu: nes.cpu, ppu: nes.ppu, apu: nes.apu, bus: nes.bus, mapper: nes.mapper };
}

// ---- ファイルにする（書き出し・読み込み） ----
const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  Uint8ClampedArray,
};

function toB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** どこでもセーブを JSON の文字列にする（型付き配列は base64） */
export function stateToJson(state: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, state }, (_k, v) => {
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      return { $t: v.constructor.name, b: toB64(u) };
    }
    return v;
  });
}

export function stateFromJson(text: string): { state: SaveState } & Record<string, unknown> {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && typeof v.$t === 'string' && typeof v.b === 'string' && TYPED[v.$t]) {
      const bin = atob(v.b);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new TYPED[v.$t](u.buffer);
    }
    return v;
  });
}
