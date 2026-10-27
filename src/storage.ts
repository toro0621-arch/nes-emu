// 端末の中（IndexedDB）への保存。外へは送らない
// - roms：最後に遊んだ ROM（次に開いたときに読み込む）
// - saves：バッテリーバックアップのセーブデータ（ROM の中身のハッシュごと）
// - library：読み込んだことのある ROM（ゲーム一覧）
// - states：どこでもセーブ（「ROM の ID:スロット番号」ごと）
const DB_NAME = 'nes-emu';
const STORE = 'roms';
const SAVES = 'saves';
const LIBRARY = 'library';
const STATES = 'states';
const LAST = 'last';

export interface SavedRom {
  name: string;
  data: Uint8Array;
}

// 接続は開いたままにしておく。アプリを閉じる瞬間の保存で、開くのを待たずにすぐ書き始められるように
let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= openDb().catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [STORE, SAVES, LIBRARY, STATES]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  storeName = STORE,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(storeName, mode).objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 保存できない環境（プライベートモードなど）では何もしない */
export async function saveLastRom(rom: SavedRom): Promise<void> {
  try {
    await run('readwrite', (s) => s.put(rom, LAST));
  } catch {
    // 無視
  }
}

export async function loadLastRom(): Promise<SavedRom | null> {
  try {
    const rom = await run<SavedRom | undefined>('readonly', (s) => s.get(LAST));
    return rom && rom.data instanceof Uint8Array ? rom : null;
  } catch {
    return null;
  }
}

/** ROM を見分ける ID（中身の SHA-256）。ファイル名が変わっても同じセーブデータを使える */
export async function romId(data: Uint8Array): Promise<string> {
  if (crypto.subtle) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
    return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // HTTPS でない場所では crypto.subtle が使えないので、簡単なハッシュで代用
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193);
  return `fnv-${(h >>> 0).toString(16)}-${data.length}`;
}

export async function saveSram(id: string, data: Uint8Array): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put(data.slice(), id), SAVES);
    return true;
  } catch {
    return false;
  }
}

// ページが閉じられる瞬間は IndexedDB の書き込みが間に合わないことがあるので、
// そのときだけ localStorage に同期的に書いておき、次に読み込むときに IndexedDB へ移す
const PENDING = 'nes-emu:pending-save:';

export function saveSramNow(id: string, data: Uint8Array): void {
  try {
    let bin = '';
    for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
    localStorage.setItem(PENDING + id, btoa(bin));
  } catch {
    // 無視
  }
}

function takePending(id: string): Uint8Array | null {
  try {
    const b64 = localStorage.getItem(PENDING + id);
    if (b64 === null) return null;
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function loadSram(id: string): Promise<Uint8Array | null> {
  const pending = takePending(id);
  if (pending) {
    // 閉じる直前の分のほうが新しい。IndexedDB へ移せたら localStorage から消す
    if (await saveSram(id, pending)) {
      try {
        localStorage.removeItem(PENDING + id);
      } catch {
        // 無視
      }
    }
    return pending;
  }
  try {
    const data = await run<Uint8Array | undefined>('readonly', (s) => s.get(id), SAVES);
    return data instanceof Uint8Array ? data : null;
  } catch {
    return null;
  }
}

// ---- ゲーム一覧 ----
export interface LibraryEntry {
  id: string;
  name: string;
  data: Uint8Array;
  /** 最後に遊んだ時刻（ミリ秒） */
  lastPlayed: number;
}

export async function putLibrary(entry: LibraryEntry): Promise<void> {
  try {
    await run('readwrite', (s) => s.put(entry, entry.id), LIBRARY);
  } catch {
    // 無視
  }
}

/** 最近遊んだ順 */
export async function listLibrary(): Promise<LibraryEntry[]> {
  try {
    const all = await run<LibraryEntry[]>('readonly', (s) => s.getAll(), LIBRARY);
    return all.filter((e) => e && e.data instanceof Uint8Array).sort((a, b) => b.lastPlayed - a.lastPlayed);
  } catch {
    return [];
  }
}

/** ゲーム一覧から消す（バッテリーのセーブとどこでもセーブも一緒に消す） */
export async function deleteLibrary(id: string): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(id), LIBRARY);
    await run('readwrite', (s) => s.delete(id), SAVES);
    await run('readwrite', (s) => s.delete(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`)), STATES);
  } catch {
    // 無視
  }
}

// ---- どこでもセーブ ----
export interface StoredState {
  /** 保存した時刻（ミリ秒） */
  time: number;
  /** そのときの画面（data: URL） */
  thumb: string;
  state: unknown;
}

export async function putState(id: string, slot: number, value: StoredState): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put(value, `${id}:${slot}`), STATES);
    return true;
  } catch {
    return false;
  }
}

export async function getState(id: string, slot: number): Promise<StoredState | null> {
  try {
    return (await run<StoredState | undefined>('readonly', (s) => s.get(`${id}:${slot}`), STATES)) ?? null;
  } catch {
    return null;
  }
}
