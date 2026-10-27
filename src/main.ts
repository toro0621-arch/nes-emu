import { registerSW } from 'virtual:pwa-register';
import { AudioOutput } from './audio/output';
import { KeyboardInput } from './input/keyboard';
import { TouchInput } from './input/touch';
import { Nes } from './nes';
import { SCREEN_H, SCREEN_W } from './ppu';
import { loadState, saveState, type SaveState } from './savestate';
import {
  deleteLibrary,
  getState,
  listLibrary,
  loadLastRom,
  loadSram,
  putLibrary,
  putState,
  romId,
  saveLastRom,
  saveSram,
  saveSramNow,
  type LibraryEntry,
} from './storage';
import { keepScreenOn } from './wakelock';

const FRAME_MS = 1000 / 60.0988; // NTSC の NES のフレームレート
/** 画面のふちを切り落とす幅（canvas は 240×224） */
const CROP = 8;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('screen');
const ctx = canvas.getContext('2d')!;
const message = $('message');
const fpsLabel = $('fps');
const romInput = $<HTMLInputElement>('rom');
const resetButton = $<HTMLButtonElement>('reset');
const soundButton = $<HTMLButtonElement>('sound');

const touch = new TouchInput($('pad'));

// ---- 横画面 ----
// スマホを横にしたときと、「横画面」ボタンを押したとき（縦のままページを回す）に横向きのレイアウトにする
const rotateButton = $<HTMLButtonElement>('rotate');
const ROTATE_KEY = 'nes-emu:rotate';
let wantRotate = false;
try {
  wantRotate = localStorage.getItem(ROTATE_KEY) === '1';
} catch {
  // 無視
}
const landscapeMq = matchMedia('(orientation: landscape) and (max-height: 600px)');
const portraitMq = matchMedia('(orientation: portrait)');
function applyLayout(): void {
  // 本当に横になっているときは回さない
  const rotated = wantRotate && portraitMq.matches;
  const root = document.documentElement;
  root.classList.toggle('rotated', rotated);
  root.classList.toggle('landscape', rotated || landscapeMq.matches);
  touch.rotated = rotated;
  rotateButton.textContent = wantRotate ? '縦画面' : '横画面';
}
landscapeMq.addEventListener('change', applyLayout);
portraitMq.addEventListener('change', applyLayout);
rotateButton.addEventListener('click', () => {
  wantRotate = !wantRotate;
  try {
    localStorage.setItem(ROTATE_KEY, wantRotate ? '1' : '0');
  } catch {
    // 無視
  }
  applyLayout();
});
applyLayout();
const keyboard = new KeyboardInput();

let nes: Nes | null = null;
let image: ImageData | null = null;

// ---- 音 ----
const audio = new AudioOutput();
const MUTE_KEY = 'nes-emu:muted';
try {
  audio.muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  // 保存できない環境では毎回オン
}
const showSound = () => (soundButton.textContent = audio.muted ? '🔇' : '🔊');
showSound();
soundButton.addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  showSound();
  try {
    localStorage.setItem(MUTE_KEY, audio.muted ? '1' : '0');
  } catch {
    // 無視
  }
});
// スマホはユーザー操作の中でしか音を出し始められないので、操作のたびに開始（再開）を試みる。
// タッチの pointerdown は「ユーザー操作」に数えられないため、指を離したときに行う
const unlockAudio = () => {
  if (!audio.running) void audio.start();
};
for (const type of ['pointerup', 'touchend', 'keydown', 'click']) {
  document.addEventListener(type, unlockAudio, { capture: true });
}

/** 遊んでいる ROM の ID（セーブデータの保存先） */
let currentId: string | null = null;
let currentRom: { name: string; data: Uint8Array } | null = null;

/**
 * ROM を読み込んで動かし始める。セーブデータがあれば、ゲームが読む前に入れておく。
 * 読み込めなければ null、読み込めたらセーブデータを入れたかどうかを返す
 */
async function startRom(name: string, data: Uint8Array): Promise<{ loadedSave: boolean } | null> {
  if (currentRom && currentRom.data === data) return { loadedSave: false };
  await flushSave(); // 前の ROM のセーブを書き出しておく
  let next: Nes;
  try {
    next = new Nes(data);
  } catch (e) {
    nes = null;
    currentId = null;
    currentRom = null;
    resetButton.disabled = true;
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    message.textContent = e instanceof Error ? e.message : String(e);
    keepScreenOn(false);
    return null;
  }
  const id = await romId(data);
  let loadedSave = false;
  const ram = next.mapper.saveRam;
  if (ram) {
    const saved = await loadSram(id);
    if (saved) {
      ram.set(saved.subarray(0, ram.length));
      loadedSave = true;
    }
    next.mapper.saveDirty = false;
  }
  nes = next;
  currentId = id;
  currentRom = { name, data };
  // ゲーム一覧に入れる（最後に遊んだ時刻を更新）と、次に開いたときに読み込む ROM として覚える
  void putLibrary({ id, name, data, lastPlayed: Date.now() });
  void saveLastRom({ name, data });
  // PPU の画面バッファをそのまま ImageData として使う（コピーなし）
  image = new ImageData(new Uint8ClampedArray(nes.ppu.frameBuffer.buffer), SCREEN_W, SCREEN_H);
  message.textContent = '';
  resetButton.disabled = false;
  document.title = `${name.replace(/\.nes$/i, '')} - NES Emu`;
  acc = 0;
  keepScreenOn(true);
  return { loadedSave };
}

/** バッテリーバックアップの RAM が変わっていれば保存する */
async function flushSave(): Promise<void> {
  const mapper = nes?.mapper;
  if (!mapper?.saveRam || !mapper.saveDirty || !currentId) return;
  mapper.saveDirty = false;
  if (!(await saveSram(currentId, mapper.saveRam))) mapper.saveDirty = true;
}
// ゲームは何度かに分けて書くことが多いので、1 秒ごとにまとめて保存。アプリを閉じる・切り替えるときはすぐ保存
setInterval(() => void flushSave(), 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) void flushSave();
});
window.addEventListener('pagehide', () => {
  const mapper = nes?.mapper;
  if (mapper?.saveRam && mapper.saveDirty && currentId) {
    saveSramNow(currentId, mapper.saveRam);
    mapper.saveDirty = false;
  }
});

romInput.addEventListener('change', async () => {
  const file = romInput.files?.[0];
  romInput.value = '';
  if (!file) return;
  const data = new Uint8Array(await file.arrayBuffer());
  const started = await startRom(file.name, data);
  closeMenu();
  if (!started) return;
  if (started.loadedSave) showToast('セーブデータを読み込みました');
});

// 前回の ROM があれば読み込んでおく（音は最初のタップで出始める）
void loadLastRom().then(async (rom) => {
  if (!rom || nes) return;
  // （ゲーム一覧ができる前に遊んでいた ROM も、ここで一覧に入る）
  const started = await startRom(rom.name, rom.data);
  if (started) showToast(`前回の「${rom.name}」を読み込みました${started.loadedSave ? '（セーブデータあり）' : ''}`);
});

// ---- お知らせ ----
const toast = $('toast');
const toastText = $('toast-text');
const toastAction = $<HTMLButtonElement>('toast-action');
let toastTimer = 0;
function showToast(text: string, action?: { label: string; run: () => void }): void {
  toastText.textContent = text;
  toastAction.hidden = !action;
  toastAction.textContent = action?.label ?? '';
  toastAction.onclick = action ? () => action.run() : null;
  toast.hidden = false;
  clearTimeout(toastTimer);
  // ボタン付き（更新のお知らせ）は押されるまで出しておく
  if (!action) toastTimer = window.setTimeout(() => (toast.hidden = true), 3000);
}

// ---- PWA（オフライン対応・更新） ----
const updateSW = registerSW({
  onNeedRefresh() {
    showToast('新しいバージョンがあります', { label: '更新', run: () => void updateSW(true) });
  },
  onOfflineReady() {
    showToast('オフラインでも使えるようになりました');
  },
});

resetButton.addEventListener('click', () => {
  nes?.reset();
  closeMenu();
});

// ---- メニュー（どこでもセーブ・ゲーム一覧） ----
const menu = $('menu');
const slotsEl = $('slots');
const slotsHint = $('slots-hint');
const libraryEl = $('library');
const libraryHint = $('library-hint');
const SLOTS = 3;
let menuOpen = false;

$('menu-open').addEventListener('click', () => void openMenu());
$('menu-close').addEventListener('click', () => closeMenu());
// 外側（暗いところ）を押しても閉じる
menu.addEventListener('click', (e) => {
  if (e.target === menu) closeMenu();
});

async function openMenu(): Promise<void> {
  menuOpen = true; // 開いている間はゲームを止める
  menu.hidden = false;
  await Promise.all([renderSlots(), renderLibrary()]);
}

function closeMenu(): void {
  menuOpen = false;
  menu.hidden = true;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
function formatTime(t: number): string {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad2(d.getMinutes())}`;
}

/** 2 回押して実行するボタン（上書き・削除の確認。ダイアログを出さない） */
function confirmButton(label: string, confirmLabel: string, run: () => void, className = 'btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  let armed = false;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      b.classList.add('warn');
      setTimeout(() => {
        armed = false;
        b.textContent = label;
        b.classList.remove('warn');
      }, 3000);
      return;
    }
    run();
  });
  return b;
}

function button(label: string, run: () => void, className = 'btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

async function renderSlots(): Promise<void> {
  slotsEl.replaceChildren();
  const id = currentId;
  if (!nes || !id) {
    slotsHint.textContent = 'ゲームを選ぶと使えます';
    return;
  }
  slotsHint.textContent = '好きなところで保存して、いつでもそこから続けられます';
  for (let slot = 1; slot <= SLOTS; slot++) {
    const saved = await getState(id, slot);
    const row = document.createElement('div');
    row.className = 'slot';
    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.alt = '';
    if (saved?.thumb) thumb.src = saved.thumb;
    const info = document.createElement('div');
    info.className = 'info';
    info.textContent = `スロット ${slot}`;
    const time = document.createElement('small');
    time.textContent = saved ? formatTime(saved.time) : '空き';
    info.append(time);
    const save = saved
      ? confirmButton('セーブ', '上書き？', () => void doSave(slot))
      : button('セーブ', () => void doSave(slot));
    const load = button('ロード', () => void doLoad(slot), 'btn accent');
    load.disabled = !saved;
    row.append(thumb, info, save, load);
    slotsEl.append(row);
  }
}

async function doSave(slot: number): Promise<void> {
  if (!nes || !currentId) return;
  const ok = await putState(currentId, slot, {
    time: Date.now(),
    thumb: canvas.toDataURL('image/png'),
    state: saveState(nes),
  });
  showToast(ok ? `スロット ${slot} にセーブしました` : 'セーブできませんでした（保存領域が使えません）');
  await renderSlots();
}

async function doLoad(slot: number): Promise<void> {
  if (!nes || !currentId) return;
  const saved = await getState(currentId, slot);
  if (!saved) return;
  try {
    loadState(nes, saved.state as SaveState);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'ロードできませんでした');
    return;
  }
  // 画面はセーブしたときの絵を出しておく（次のフレームで描き直される）
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0);
  img.src = saved.thumb;
  acc = 0;
  closeMenu();
  showToast(`スロット ${slot} をロードしました`);
}

async function renderLibrary(): Promise<void> {
  const list = await listLibrary();
  libraryEl.replaceChildren();
  libraryHint.textContent = list.length ? '' : 'まだありません。「ROM を追加」からゲームのファイルを選んでください';
  for (const entry of list) libraryEl.append(libraryRow(entry));
}

function libraryRow(entry: LibraryEntry): HTMLLIElement {
  const li = document.createElement('li');
  const playing = entry.id === currentId;
  if (playing) li.className = 'current';
  const play = document.createElement('button');
  play.className = 'btn play';
  const name = document.createElement('span');
  name.textContent = entry.name.replace(/\.nes$/i, '');
  const when = document.createElement('small');
  when.textContent = playing ? 'プレイ中' : `最後に遊んだ日 ${formatTime(entry.lastPlayed)}`;
  play.append(name, when);
  play.addEventListener('click', async () => {
    if (playing) return closeMenu();
    const started = await startRom(entry.name, entry.data);
    closeMenu();
    if (started?.loadedSave) showToast('セーブデータを読み込みました');
  });
  const del = confirmButton('削除', '消す？', async () => {
    await deleteLibrary(entry.id);
    await renderLibrary();
  }, 'btn del');
  li.append(play, del);
  return li;
}

// ---- 早送り ----
const ffButton = $<HTMLButtonElement>('ff');
const FF_SPEED = 3;
let fastForward = false;
ffButton.addEventListener('click', () => {
  fastForward = !fastForward;
  ffButton.classList.toggle('on', fastForward);
  ffButton.setAttribute('aria-pressed', String(fastForward));
});

/** 早送り中の音は、間引いて高く速く鳴らす */
function decimate(samples: Float32Array, n: number): Float32Array {
  const out = new Float32Array(Math.floor(samples.length / n));
  for (let i = 0; i < out.length; i++) out[i] = samples[i * n];
  return out;
}

// 画面のリフレッシュレート（60Hz / 120Hz など）に関係なく、NES の 60.1fps で進める
let acc = 0;
let last = performance.now();
let frames = 0;
let fpsTime = last;

function loop(now: number): void {
  const dt = now - last;
  last = now;
  if (nes && image && !document.hidden && !menuOpen) {
    const speed = fastForward ? FF_SPEED : 1;
    acc = Math.min(acc + dt * speed, FRAME_MS * 3 * speed);
    let ran = false;
    // 半フレーム分たまったら 1 フレーム進める（60Hz 画面で毎回 1 フレームになるように）
    while (acc >= FRAME_MS / 2) {
      nes.bus.pads[0].buttons = touch.read() | keyboard.read();
      nes.runFrame();
      acc -= FRAME_MS;
      frames++;
      ran = true;
    }
    if (ran) {
      // 上下左右の 8 ドットは、実機のテレビでも見えない部分（左端の線やスクロールのちらつきが出る）なので切り落とす
      ctx.putImageData(image, -CROP, -CROP);
      const samples = nes.apu.takeSamples();
      audio.push(speed > 1 ? decimate(samples, speed) : samples);
      nes.apu.sampleRate = audio.sampleRate;
      nes.apu.rateAdjust = audio.rateAdjust();
    }
  }
  if (now - fpsTime >= 1000) {
    fpsLabel.textContent = nes ? `${Math.round((frames * 1000) / (now - fpsTime))} fps` : '';
    frames = 0;
    fpsTime = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// 開発サーバーでだけ、動作確認用に中身を見られるようにする
if (import.meta.env.DEV) Object.assign(window, { emu: { nes: () => nes, audio } });
