// 最後に遊んだ ROM を端末の中（IndexedDB）に保存し、次に開いたときに読み込む。外へは送らない
const DB_NAME = 'nes-emu';
const STORE = 'roms';
const LAST = 'last';

export interface SavedRom {
  name: string;
  data: Uint8Array;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
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
