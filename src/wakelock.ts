// 遊んでいるあいだ画面が消えないようにする（対応ブラウザのみ）。
// 画面を切り替えると解除されるので、戻ってきたら取り直す
let lock: WakeLockSentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  if (!wanted || lock || document.hidden || !('wakeLock' in navigator)) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => (lock = null));
  } catch {
    // 電池残量が少ないときなどは断られる。気にしない
  }
}

export function keepScreenOn(on: boolean): void {
  wanted = on;
  if (on) void acquire();
  else {
    void lock?.release();
    lock = null;
  }
}

document.addEventListener('visibilitychange', () => void acquire());
