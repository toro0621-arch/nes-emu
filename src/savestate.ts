import type { Nes } from './nes';

// どこでもセーブ（ステートセーブ）：エミュレータの中身をまるごと写し取り、あとで書き戻す。
// CPU・PPU・APU・マッパーの各オブジェクトのフィールドを順にたどって、数値・真偽値・配列・型付き配列を写す。
// 関数や、ほかの部品への参照（CPU が持つバスなど）と、ROM そのものは写さない

/** 形式が変わったら上げる（古いセーブは読み込まない） */
export const STATE_VERSION = 1;

export interface SaveState {
  version: number;
  mapper: number;
  parts: Record<string, unknown>;
}

/** 写さないフィールド（画面・音の出力バッファ。次のフレームで作り直される） */
const SKIP_KEYS = new Set(['frameBuffer', 'samples', 'sampleLength', 'cart', 'host']);

type Obj = Record<string, unknown>;

function isTyped(v: unknown): v is Uint8Array | Uint16Array | Uint32Array | Float32Array | Int8Array | Int16Array | Int32Array {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

export function saveState(nes: Nes): SaveState {
  const skip = new Set<unknown>([nes.cpu, nes.ppu, nes.apu, nes.bus, nes.mapper, nes.cart, nes.cart.prg]);
  if (!nes.cart.chrRam) skip.add(nes.cart.chr);

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
  for (const [name, part] of Object.entries(partsOf(nes))) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(part as unknown as Obj)) {
      if (SKIP_KEYS.has(k) || typeof x === 'function' || x === undefined || skip.has(x)) continue;
      out[k] = snap(x, 1);
    }
    parts[name] = out;
  }
  return { version: STATE_VERSION, mapper: nes.cart.mapper, parts };
}

/** 書き戻す。形式やマッパーが合わなければ例外 */
export function loadState(nes: Nes, state: SaveState): void {
  if (!state || state.version !== STATE_VERSION) throw new Error('このセーブは古い形式なので読み込めません');
  if (state.mapper !== nes.cart.mapper) throw new Error('別のゲームのセーブです');

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

  const parts = partsOf(nes);
  for (const [name, saved] of Object.entries(state.parts)) {
    const part = parts[name as keyof typeof parts];
    if (part) restore(part as unknown as Obj, saved as Obj);
  }
  // 読み込んだバッテリー RAM もセーブデータとして保存し直す
  nes.mapper.saveDirty = nes.mapper.saveRam !== null;
}

function structuredCloneArray(v: unknown[]): unknown[] {
  return v.map((x) => (Array.isArray(x) ? structuredCloneArray(x) : x !== null && typeof x === 'object' ? { ...(x as Obj) } : x));
}

function partsOf(nes: Nes) {
  return { cpu: nes.cpu, ppu: nes.ppu, apu: nes.apu, bus: nes.bus, mapper: nes.mapper };
}
