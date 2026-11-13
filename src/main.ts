import { registerSW } from 'virtual:pwa-register';
import { AudioOutput } from './audio/output';
import { KeyboardInput } from './input/keyboard';
import { TouchInput } from './input/touch';
import { AUTO_ID, GB_PALETTES, MONO_ID, autoPalette } from './gb/palettes';
import { DMG_COLORS } from './gb/ppu';
import { createMachine, detectSystem, isPsxExe, type Machine, type System } from './machine';
import { createPsx, discId, numId, openDisc, pickDisc } from './psx/load';
import type { PsxMachine } from './machine';
import { stateFromJson, stateToJson, type SaveState } from './savestate';
import { CHEAT_HELP, CheatRunner, parseCheat, type Cheat, type CheatTarget } from './cheats';
import { isZip, unzipRom } from './zip';
import {
  deleteLibrary,
  getLibrary,
  getState,
  listLibrary,
  loadBios,
  putLibraryChecked,
  saveBios,
  type DiscFile,
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
import { SmoothScreen, type SmoothMode } from './smooth';
import { keepScreenOn } from './wakelock';


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

let machine: Machine | null = null;
let image: ImageData | null = null;

/** 本体の画面バッファを canvas に描けるようにし、画面の大きさ（縦横比）を合わせる */
function bindScreen(m: Machine): void {
  // 画面バッファをそのまま ImageData として使う（コピーなし）
  image = new ImageData(new Uint8ClampedArray(m.frameBuffer.buffer), m.width, m.height);
  const w = m.width - m.crop * 2;
  const h = m.height - m.crop * 2;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const root = document.documentElement.style;
  root.setProperty('--sw', String(m.aspect ? m.aspect[0] : w));
  root.setProperty('--sh', String(m.aspect ? m.aspect[1] : h));
  if (document.documentElement.dataset.system !== m.system) setButtonLabels(m.system);
  document.documentElement.dataset.system = m.system;
  // ワンダースワンの縦持ちのソフトでは、ひし形のボタンを X ボタンとして表示する
  if (m.vertical) document.documentElement.dataset.wsvertical = '';
  else delete document.documentElement.dataset.wsvertical;
}

/** ボタンの文字（プレイステーションは △○×□・L1/R1） */
function setButtonLabels(system: System): void {
  const ps = system === 'psx';
  const labels: Record<string, string> = ps
    ? { A: '○', B: '✕', X: '△', Y: '□', L: 'L1', R: 'R1', L2: 'L2' }
    : { A: 'A', B: 'B', X: 'X', Y: 'Y', L: 'L', R: 'R', L2: system === 'n64' ? 'Z' : 'L2' };
  for (const [btn, text] of Object.entries(labels)) {
    const el = document.querySelector<HTMLElement>(`#pad [data-btn="${btn}"]`);
    if (el) el.textContent = text;
  }
}

/** ファイル名から拡張子を取る */
const baseName = (name: string) => name.replace(/\.(nes|gbc?|gba|wsc?|sfc|smc|exe|z64|n64|v64)$/i, '');

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
/** ゲームのセーブデータ（メモリーカード）の保存先。ふつうは currentId と同じ。
 * プレイステーションの何枚組のゲームは、1 枚目のメモリーカードを 2 枚目以降でも使う */
let currentSaveId: string | null = null;
let currentRom: { name: string; data: Uint8Array } | null = null;
/** プレイステーションの CD のファイル */
let currentFiles: DiscFile[] | null = null;

/**
 * ROM を読み込んで動かし始める。セーブデータがあれば、ゲームが読む前に入れておく。
 * 読み込めなければ null、読み込めたらセーブデータを入れたかどうかを返す
 */
async function startRom(
  name: string,
  data: Uint8Array,
  files?: DiscFile[],
  knownId?: string,
  cardId?: string,
): Promise<{ loadedSave: boolean; resumed?: boolean } | null> {
  if (currentRom && currentRom.data === data && !files) return { loadedSave: false };
  if (files && knownId && knownId === currentId) return { loadedSave: false };
  await flushSave(); // 前の ROM のセーブを書き出しておく
  await autoSave(); // 前の ROM の続き
  let next: Machine;
  let discKey: string | null = null;
  try {
    if (files || isPsxExe(data)) {
      // プレイステーション：BIOS と CD を読む（少し時間がかかる）
      message.textContent = '読み込み中…';
      discKey = files ? (knownId ?? (await discId(files))) : null;
      // 何枚組で、前に 1 枚目のメモリーカードと結びつけたディスク
      if (discKey && !cardId) cardId = (await getLibrary(discKey))?.cardId;
      next = await createPsx(discKey ?? (await romId(data)), files ?? null, files ? null : data);
    } else next = createMachine(data, name);
  } catch (e) {
    machine = null;
    currentId = null;
    currentSaveId = null;
    currentRom = null;
    resetButton.disabled = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    message.textContent = e instanceof Error ? e.message : String(e);
    keepScreenOn(false);
    return null;
  }
  const id = discKey ?? (await romId(data));
  let loadedSave = false;
  const ram = next.saveRam;
  if (ram) {
    const saved = await loadSram(cardId ?? id);
    if (saved) {
      ram.set(saved.subarray(0, ram.length));
      loadedSave = true;
    }
    next.afterSaveLoaded();
    next.saveDirty = false;
  }
  machine = next;
  currentId = id;
  currentSaveId = cardId ?? id;
  currentRom = { name, data };
  currentFiles = files ?? null;
  // ゲーム一覧に入れる（最後に遊んだ時刻を更新）と、次に開いたときに読み込む ROM として覚える
  if (files) {
    void putLibraryChecked({ id, name, data, files, lastPlayed: Date.now(), ...(cardId ? { cardId } : {}) }).then((ok) => {
      if (!ok) showToast('端末の空きが足りず、ゲーム一覧に入れられませんでした（今は遊べます）');
    });
    void saveLastRom({ name, data, ref: id });
    void navigator.storage?.persist?.();
  } else {
    void putLibrary({ id, name, data, lastPlayed: Date.now() });
    void saveLastRom({ name, data });
  }
  next.setStereo(stereo ? 1 : 0);
  next.setPalette(paletteFor(id));
  next.setLcdColor?.(lcdColor);
  applyPsxSettings(next);
  applyCheats();
  bindScreen(next);
  message.textContent = '';
  resetButton.disabled = false;
  document.title = `${baseName(name)} - NES Emu`;
  acc = 0;
  keepScreenOn(true);
  rewind.clear();
  // 前に遊んだところの続きがあれば、そこから
  const resumed = await autoLoad(next, id);
  return { loadedSave, resumed };
}

// ---- つづきから自動で再開 ----
// アプリを離れる（ほかのアプリに切り替える・閉じる）たびに、どこでもセーブの「0 番」に今の状態を入れておく
const AUTO_SLOT = 0;
let autoSaving = false;
async function autoSave(): Promise<void> {
  const m = machine;
  const id = currentId;
  if (!m || !id || autoSaving) return;
  autoSaving = true;
  try {
    await putState(id, AUTO_SLOT, { time: Date.now(), thumb: canvas.toDataURL('image/png'), state: m.saveState() });
  } finally {
    autoSaving = false;
  }
}
async function autoLoad(m: Machine, id: string): Promise<boolean> {
  const saved = await getState(id, AUTO_SLOT);
  if (!saved || machine !== m) return false;
  try {
    m.loadState(saved.state as SaveState);
  } catch {
    return false; // 古い形式などは使わない
  }
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0);
  img.src = saved.thumb;
  return true;
}
/** 続きを捨てて、電源を入れ直したところから */
function restartFromBeginning(): void {
  if (!machine) return;
  machine.reset();
  applyCheats();
  rewind.clear();
  acc = 0;
  showToast('最初から始めました');
}

/** バッテリーバックアップの RAM が変わっていれば保存する */
async function flushSave(): Promise<void> {
  const mapper = machine;
  const id = currentSaveId;
  if (!mapper?.saveRam || !mapper.saveDirty || !id) return;
  mapper.saveDirty = false;
  if (!(await saveSram(id, mapper.saveRam))) mapper.saveDirty = true;
}
// ゲームは何度かに分けて書くことが多いので、1 秒ごとにまとめて保存。アプリを閉じる・切り替えるときはすぐ保存
setInterval(() => void flushSave(), 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    void flushSave();
    void autoSave();
  }
});
window.addEventListener('pagehide', () => {
  const mapper = machine;
  if (mapper?.saveRam && mapper.saveDirty && currentSaveId) {
    saveSramNow(currentSaveId, mapper.saveRam);
    mapper.saveDirty = false;
  }
});

romInput.addEventListener('change', async () => {
  const all = Array.from(romInput.files ?? []);
  romInput.value = '';
  const file = all[0];
  if (!file) return;
  // プレイステーションの CD（大きいので中身は読み込まない）
  const disc = await pickDisc(all);
  if (disc && 'error' in disc) {
    closeMenu();
    showToast(disc.error);
    return;
  }
  if (disc) {
    closeMenu();
    const started = await startRom(disc.name, new Uint8Array(0), disc.files);
    if (started?.resumed) showToast('前のつづきから再開しました', { label: '最初から', run: restartFromBeginning });
    else if (started?.loadedSave) showToast('メモリーカードを読み込みました');
    return;
  }
  let name = file.name;
  let data: Uint8Array = new Uint8Array(await file.arrayBuffer());
  if (isZip(data)) {
    // ZIP のままでも中の ROM を取り出して遊べる
    try {
      ({ name, data } = await unzipRom(data));
    } catch (e) {
      closeMenu();
      showToast(e instanceof Error ? e.message : 'ZIP を開けませんでした');
      return;
    }
  }
  const started = await startRom(name, data);
  closeMenu();
  if (!started) return;
  if (started.resumed) showToast('前のつづきから再開しました', { label: '最初から', run: restartFromBeginning });
  else if (started.loadedSave) showToast('セーブデータを読み込みました');
});

// 前回の ROM があれば読み込んでおく（音は最初のタップで出始める）
void loadLastRom().then(async (rom) => {
  if (!rom || machine) return;
  // （ゲーム一覧ができる前に遊んでいた ROM も、ここで一覧に入る）
  const started = await startRom(rom.name, rom.data, rom.files, rom.ref, rom.cardId);
  if (started?.resumed)
    showToast(`「${baseName(rom.name)}」のつづきから再開しました`, { label: '最初から', run: restartFromBeginning });
  else if (started) showToast(`前回の「${rom.name}」を読み込みました${started.loadedSave ? '（セーブデータあり）' : ''}`);
});

// ---- お知らせ ----
const toast = $('toast');
const toastText = $('toast-text');
const toastAction = $<HTMLButtonElement>('toast-action');
let toastTimer = 0;
function showToast(text: string, action?: { label: string; run: () => void; sticky?: boolean }): void {
  toastText.textContent = text;
  toastAction.hidden = !action;
  toastAction.textContent = action?.label ?? '';
  toastAction.onclick = action
    ? (e) => {
        e.stopPropagation();
        hideToast();
        action.run();
      }
    : null;
  toast.hidden = false;
  clearTimeout(toastTimer);
  // 更新のお知らせだけは押されるまで出しておく。ほかはしばらくしたら消える（ボタン付きは長めに）
  if (!action?.sticky) toastTimer = window.setTimeout(hideToast, action ? 6000 : 3000);
}
function hideToast(): void {
  clearTimeout(toastTimer);
  toast.hidden = true;
}
// お知らせを押すと（ボタン以外のところ）すぐ消える
toast.addEventListener('click', hideToast);

// ---- PWA（オフライン対応・更新） ----
const updateSW = registerSW({
  onNeedRefresh() {
    showToast('新しいバージョンがあります', { label: '更新', run: () => void updateSW(true), sticky: true });
  },
  onOfflineReady() {
    showToast('オフラインでも使えるようになりました');
  },
});

resetButton.addEventListener('click', () => {
  if (machine) {
    machine.reset();
    applyCheats();
    bindScreen(machine);
  }
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

// ---- ステレオ ----
const STEREO_KEY = 'nes-emu:stereo';
let stereo = true;
try {
  stereo = localStorage.getItem(STEREO_KEY) !== '0';
} catch {
  // 無視
}
const stereoButton = $<HTMLButtonElement>('stereo');
const showStereo = () => {
  stereoButton.textContent = stereo ? 'ステレオ：オン' : 'ステレオ：オフ';
  stereoButton.classList.toggle('accent', stereo);
  stereoButton.setAttribute('aria-pressed', String(stereo));
};
showStereo();
stereoButton.addEventListener('click', () => {
  stereo = !stereo;
  try {
    localStorage.setItem(STEREO_KEY, stereo ? '1' : '0');
  } catch {
    // 無視
  }
  machine?.setStereo(stereo ? 1 : 0);
  showStereo();
});

// ---- ドットをなめらかに（全部の本体で共通） ----
const SMOOTH_KEY = 'nes-emu:smooth';
const SMOOTH_MODES: [SmoothMode, string][] = [
  ['off', 'オフ'],
  ['light', '軽め'],
  ['strong', '強め'],
];
const smooth = new SmoothScreen($('screen-wrap'));
{
  let m: SmoothMode = 'off';
  try {
    const v = localStorage.getItem(SMOOTH_KEY);
    if (v === 'light' || v === 'strong') m = v;
  } catch {
    // 無視
  }
  smooth.setMode(m);
}
function renderSmooth(): void {
  const el = $('smooth-modes');
  el.replaceChildren();
  for (const [mode, label] of SMOOTH_MODES) {
    el.append(
      button(
        label,
        () => {
          if (!smooth.setMode(mode)) showToast('この端末では使えませんでした（GPU が使えません）');
          try {
            localStorage.setItem(SMOOTH_KEY, smooth.mode);
          } catch {
            // 無視
          }
          if (machine) smooth.draw(machine.frameBuffer, machine.width, machine.height, machine.crop);
          renderSmooth();
        },
        'btn' + (mode === smooth.mode ? ' accent' : ''),
      ),
    );
  }
}

// ---- 液晶っぽい色（ゲームボーイアドバンス。全部のソフトで共通） ----
const LCD_KEY = 'nes-emu:gba-lcd';
let lcdColor = false;
try {
  lcdColor = localStorage.getItem(LCD_KEY) === '1';
} catch {
  // 保存できない環境では毎回オフ
}
const lcdSection = $('lcd-section');
const lcdButton = $<HTMLButtonElement>('lcd');
function renderLcd(): void {
  lcdSection.hidden = !machine?.setLcdColor;
  lcdButton.textContent = lcdColor ? 'オン' : 'オフ';
  lcdButton.classList.toggle('accent', lcdColor);
  lcdButton.setAttribute('aria-pressed', String(lcdColor));
}
lcdButton.addEventListener('click', () => {
  lcdColor = !lcdColor;
  try {
    localStorage.setItem(LCD_KEY, lcdColor ? '1' : '0');
  } catch {
    // 無視
  }
  machine?.setLcdColor?.(lcdColor);
  renderLcd();
});

// ---- ゲームのセーブデータ（バッテリーバックアップ）の書き出し・読み込み ----
const sramSection = $('sram-section');
const savFile = $<HTMLInputElement>('sav-file');
function renderSram(): void {
  sramSection.hidden = !machine?.saveRam || !currentRom;
}
$('sav-export').addEventListener('click', () => {
  const ram = machine?.saveRam;
  if (!ram || !currentRom) return;
  void flushSave();
  const url = URL.createObjectURL(new Blob([ram.slice()], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName(currentRom.name)}.sav`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showToast('セーブデータを書き出しました');
});
savFile.addEventListener('change', async () => {
  const file = savFile.files?.[0];
  savFile.value = '';
  const m = machine;
  const rom = currentRom;
  const id = currentSaveId;
  const gameId = currentId;
  if (!file || !m?.saveRam || !rom || !id || !gameId) return;
  if (!confirm(`「${baseName(rom.name)}」のいまのセーブデータを、読み込むファイルで上書きして、ゲームを最初から始めます。よろしいですか？`)) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  // ファイルが短ければ足りないところはいまのまま、長ければ余りは使わない
  const next = m.saveRam.slice();
  next.set(bytes.subarray(0, next.length));
  if (!(await saveSram(id, next))) {
    showToast('セーブデータを保存できませんでした');
    return;
  }
  // 作り直して、保存したセーブデータから始める（いまのセーブで上書きしないように）
  m.saveDirty = false;
  currentRom = null;
  currentId = null;
  const started = await startRom(rom.name, rom.data, currentFiles ?? undefined, currentFiles ? gameId : undefined, id !== gameId ? id : undefined);
  closeMenu();
  showToast(started?.loadedSave ? 'セーブデータを読み込みました' : 'セーブデータを読み込めませんでした');
});

// ---- 改造コード（ゲームごとに覚える） ----
const CHEAT_KEY = 'nes-emu:cheats:';
const cheats = new CheatRunner();
function cheatList(): Cheat[] {
  if (!currentSaveId) return [];
  try {
    const v = JSON.parse(localStorage.getItem(CHEAT_KEY + currentSaveId) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveCheats(list: Cheat[]): void {
  if (!currentSaveId) return;
  try {
    localStorage.setItem(CHEAT_KEY + currentSaveId, JSON.stringify(list));
  } catch {
    showToast('改造コードを保存できませんでした');
  }
  applyCheats(list);
}
/** オンのコードを本体にかけ直す */
function applyCheats(list = cheatList()): void {
  const m = machine;
  if (!m?.poke) {
    cheats.set('nes', [], null);
    return;
  }
  cheats.set(m.system, list, m as unknown as CheatTarget);
}
function renderCheats(): void {
  const m = machine;
  $('cheat-section').hidden = !m?.poke || !currentSaveId;
  if (!m) return;
  $('cheat-hint').textContent = `使えるコード：${CHEAT_HELP[m.system]}。おかしくなったらオフにしてリセットしてください`;
  const el = $('cheat-list');
  el.replaceChildren();
  const list = cheatList();
  list.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'cheat';
    const info = document.createElement('div');
    info.className = 'info';
    info.textContent = c.name || '（名前なし）';
    const code = document.createElement('small');
    code.textContent = c.code.replace(/\n/g, ' ');
    info.append(code);
    const toggle = button(
      c.on ? 'オン' : 'オフ',
      () => {
        list[i].on = !list[i].on;
        saveCheats(list);
        renderCheats();
      },
      'btn' + (c.on ? ' accent' : ''),
    );
    const del = confirmButton('削除', '消す？', () => {
      list.splice(i, 1);
      saveCheats(list);
      renderCheats();
    }, 'btn del');
    li.append(info, toggle, del);
    el.append(li);
  });
}
$('cheat-add').addEventListener('click', () => {
  const m = machine;
  if (!m?.poke) return;
  const nameEl = $<HTMLInputElement>('cheat-name');
  const codeEl = $<HTMLTextAreaElement>('cheat-code');
  const code = codeEl.value.trim();
  try {
    parseCheat(m.system, code);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'コードを読めませんでした');
    return;
  }
  const list = cheatList();
  list.push({ name: nameEl.value.trim(), code, on: true });
  saveCheats(list);
  nameEl.value = '';
  codeEl.value = '';
  renderCheats();
  showToast('改造コードを追加しました（オン）');
});

// ---- プレイステーションの設定（全部のソフトで共通。最初はどちらもオン） ----
const PSX_FAST_KEY = 'nes-emu:psx-fastcd';
const PSX_TC_KEY = 'nes-emu:psx-truecolor';
const loadFlag = (k: string) => {
  try {
    return localStorage.getItem(k) !== '0';
  } catch {
    return true;
  }
};
let psxFastCd = loadFlag(PSX_FAST_KEY);
let psxTrueColor = loadFlag(PSX_TC_KEY);
function applyPsxSettings(m: Machine | null): void {
  if (m?.system !== 'psx') return;
  (m as PsxMachine).setFastCd(psxFastCd);
  (m as PsxMachine).setTrueColor(psxTrueColor);
}
function renderPsxSettings(): void {
  $('psx-section').hidden = machine?.system !== 'psx';
  for (const [id, on] of [
    ['psx-fastcd', psxFastCd],
    ['psx-truecolor', psxTrueColor],
  ] as const) {
    const b = $<HTMLButtonElement>(id);
    b.textContent = on ? 'オン' : 'オフ';
    b.classList.toggle('accent', on);
    b.setAttribute('aria-pressed', String(on));
  }
}
for (const [id, key] of [
  ['psx-fastcd', PSX_FAST_KEY],
  ['psx-truecolor', PSX_TC_KEY],
] as const) {
  $(id).addEventListener('click', () => {
    if (id === 'psx-fastcd') psxFastCd = !psxFastCd;
    else psxTrueColor = !psxTrueColor;
    try {
      localStorage.setItem(key, (id === 'psx-fastcd' ? psxFastCd : psxTrueColor) ? '1' : '0');
    } catch {
      // 無視
    }
    applyPsxSettings(machine);
    renderPsxSettings();
  });
}

// ---- プレイステーションのディスクの入れかえ ----
$<HTMLInputElement>('disc-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const all = Array.from(input.files ?? []);
  input.value = '';
  const m = machine;
  if (!all.length || m?.system !== 'psx' || !currentSaveId) return;
  const pick = await pickDisc(all);
  if (!pick) {
    showToast('CD のイメージ（.cue と .bin、または .iso）を選んでください');
    return;
  }
  if ('error' in pick) {
    showToast(pick.error);
    return;
  }
  try {
    const id = await discId(pick.files);
    if (id === currentId) {
      showToast('今入っているディスクと同じです');
      return;
    }
    const disc = await openDisc(pick.files);
    await flushSave();
    await autoSave();
    (m as PsxMachine).swapDisc(disc, numId(id));
    // これからは新しいディスクとして続ける（メモリーカードは同じものを使う）
    const cardId = currentSaveId;
    currentId = id;
    currentRom = { name: pick.name, data: new Uint8Array(0) };
    currentFiles = pick.files;
    rewind.clear();
    void putLibraryChecked({ id, name: pick.name, data: currentRom.data, files: pick.files, lastPlayed: Date.now(), cardId });
    void saveLastRom({ name: pick.name, data: currentRom.data, ref: id });
    document.title = `${baseName(pick.name)} - NES Emu`;
    closeMenu();
    showToast(`「${pick.name}」に入れかえました`);
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'ディスクを読み込めませんでした');
  }
});

// ---- プレイステーションの BIOS ----
const biosHint = $('bios-hint');
const biosClear = $<HTMLButtonElement>('bios-clear');
const biosFile = $<HTMLInputElement>('bios-file');
async function renderBios(): Promise<void> {
  const own = await loadBios();
  biosClear.hidden = !own;
  biosHint.textContent = own
    ? `自分の BIOS（${own.name}）を使っています`
    : '今は互換 BIOS（OpenBIOS）で動かしています。動かないゲームがあれば、本体から吸い出した BIOS（SCPH1001.BIN など）を選んでください';
}
biosFile.addEventListener('change', async () => {
  const file = biosFile.files?.[0];
  biosFile.value = '';
  if (!file) return;
  if (file.size !== 512 * 1024) {
    showToast('BIOS は 512KB のファイルです（SCPH1001.BIN など）');
    return;
  }
  const ok = await saveBios({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  showToast(ok ? 'BIOS を入れました。次にプレイステーションのゲームを開いたときから使います' : 'BIOS を保存できませんでした');
  await renderBios();
});
biosClear.addEventListener('click', async () => {
  await saveBios(null);
  showToast('互換 BIOS に戻しました');
  await renderBios();
});

// ---- ゲームボーイの色づけ（ソフトごとに覚える。最初は「おまかせ」） ----
const PALETTE_KEY = 'nes-emu:gbpal:';
const colorSection = $('color-section');
const palettesEl = $('palettes');

function paletteFor(id: string): string {
  try {
    return localStorage.getItem(PALETTE_KEY + id) ?? AUTO_ID;
  } catch {
    return AUTO_ID;
  }
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const dmgHex = (abgr: number) => hex(((abgr & 0xff) << 16) | (abgr & 0xff00) | ((abgr >> 16) & 0xff));

function renderPalettes(): void {
  palettesEl.replaceChildren();
  const id = currentId;
  colorSection.hidden = !machine?.colorable || !id;
  if (colorSection.hidden || !id) return;
  const chosen = paletteFor(id);
  const options: { id: string; name: string; colors: string[] }[] = [
    {
      id: AUTO_ID,
      name: 'おまかせ',
      colors: GB_PALETTES.find((p) => p.id === autoPalette(gbTitle()))!.bg.map(hex),
    },
    { id: MONO_ID, name: '白黒（液晶）', colors: Array.from(DMG_COLORS, dmgHex) },
    ...GB_PALETTES.map((p) => ({ id: p.id, name: p.name, colors: p.bg.map(hex) })),
  ];
  for (const o of options) {
    const b = button(
      '',
      () => {
        try {
          localStorage.setItem(PALETTE_KEY + id, o.id);
        } catch {
          // 無視
        }
        machine?.setPalette(o.id);
        renderPalettes();
      },
      'btn' + (o.id === chosen ? ' selected' : ''),
    );
    const sw = document.createElement('span');
    sw.className = 'swatch';
    for (const c of o.colors) {
      const i = document.createElement('i');
      i.style.background = c;
      sw.append(i);
    }
    const label = document.createElement('span');
    label.textContent = o.name;
    b.append(sw, label);
    palettesEl.append(b);
  }
}

/** 遊んでいるゲームボーイのソフトの題名（ヘッダー） */
function gbTitle(): string {
  const data = currentRom?.data;
  if (!data) return '';
  return String.fromCharCode(...data.subarray(0x134, 0x143)).replace(/\0.*$/s, '').trim();
}

async function openMenu(): Promise<void> {
  renderPalettes();
  renderLcd();
  renderSram();
  renderSmooth();
  renderFfSpeeds();
  void renderBios();
  renderPsxSettings();
  renderCheats();
  $('disc-section').hidden = machine?.system !== 'psx' || !currentFiles;
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
  if (!machine || !id) {
    $('state-file-row').hidden = true;
    slotsHint.textContent = 'ゲームを選ぶと使えます';
    return;
  }
  slotsHint.textContent = '好きなところで保存して、いつでもそこから続けられます（⤓ でファイルに書き出せます）';
  $('state-file-row').hidden = false;
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
    if (saved) {
      // ファイルに書き出す（バックアップ・不具合の調査用）
      const exp = button('⤓', () => exportState(slot, saved), 'btn');
      exp.title = 'ファイルに書き出す';
      exp.setAttribute('aria-label', `スロット ${slot} をファイルに書き出す`);
      row.append(exp);
    }
    slotsEl.append(row);
  }
}

function exportState(slot: number, saved: { time: number; thumb: string; state: unknown }): void {
  if (!currentRom) return;
  const text = stateToJson(saved.state, { game: currentRom.name, time: saved.time, thumb: saved.thumb });
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName(currentRom.name)}-slot${slot}.state.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showToast('どこでもセーブをファイルに書き出しました');
}
$<HTMLInputElement>('state-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !machine) return;
  try {
    const { state } = stateFromJson(await file.text());
    machine.loadState(state);
    rewind.clear();
    acc = 0;
    closeMenu();
    showToast('ファイルからロードしました');
  } catch (err) {
    showToast(err instanceof Error && err.message.includes('セーブ') ? err.message : 'このファイルは読み込めませんでした');
  }
});

async function doSave(slot: number): Promise<void> {
  if (!machine || !currentId) return;
  const ok = await putState(currentId, slot, {
    time: Date.now(),
    thumb: canvas.toDataURL('image/png'),
    state: machine.saveState(),
  });
  showToast(ok ? `スロット ${slot} にセーブしました` : 'セーブできませんでした（保存領域が使えません）');
  await renderSlots();
}

async function doLoad(slot: number): Promise<void> {
  if (!machine || !currentId) return;
  const saved = await getState(currentId, slot);
  if (!saved) return;
  try {
    machine.loadState(saved.state as SaveState);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'ロードできませんでした');
    return;
  }
  rewind.clear();
  // 画面はセーブしたときの絵を出しておく（次のフレームで描き直される）
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0);
  img.src = saved.thumb;
  acc = 0;
  closeMenu();
  showToast(`スロット ${slot} をロードしました`);
}

// ゲーム一覧はフォルダ式：最初に本体ごとのフォルダ、開くとその本体のゲーム
const FOLDERS: { system: System; name: string; icon: string }[] = [
  { system: 'nes', name: 'ファミコン', icon: '🎮' },
  { system: 'gb', name: 'ゲームボーイ', icon: '🕹️' },
  { system: 'ws', name: 'ワンダースワン', icon: '📟' },
  { system: 'gba', name: 'ゲームボーイアドバンス', icon: '🟣' },
  { system: 'snes', name: 'スーパーファミコン', icon: '🌈' },
  { system: 'psx', name: 'プレイステーション', icon: '💿' },
  { system: 'n64', name: 'NINTENDO64', icon: '🕹️' },
];
/** 開いているフォルダ（null ならフォルダの一覧） */
let openFolder: System | null = null;

function systemOf(entry: { data: Uint8Array; name: string; files?: DiscFile[] }): System | null {
  if (entry.files) return 'psx';
  return detectSystem(entry.data, entry.name);
}

async function renderLibrary(): Promise<void> {
  const list = await listLibrary();
  libraryEl.replaceChildren();
  if (!list.length) {
    libraryHint.textContent = 'まだありません。「ROM を追加」からゲームのファイルを選んでください';
    return;
  }
  libraryHint.textContent = '';
  if (openFolder === null) {
    for (const f of FOLDERS) {
      const games = list.filter((e) => systemOf(e) === f.system);
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'btn play folder';
      const name = document.createElement('span');
      name.textContent = `${f.icon} ${f.name}`;
      const count = document.createElement('small');
      const playing = machine?.system === f.system ? '・プレイ中のゲームあり' : '';
      count.textContent = `${games.length} 本${playing}`;
      b.append(name, count);
      b.addEventListener('click', () => {
        openFolder = f.system;
        void renderLibrary();
      });
      li.append(b);
      libraryEl.append(li);
    }
    return;
  }
  const folder = FOLDERS.find((f) => f.system === openFolder)!;
  const back = document.createElement('li');
  back.className = 'folder-head';
  back.append(
    button('← フォルダ一覧', () => {
      openFolder = null;
      void renderLibrary();
    }),
  );
  const title = document.createElement('span');
  title.textContent = `${folder.icon} ${folder.name}`;
  back.append(title);
  libraryEl.append(back);
  const games = list.filter((e) => systemOf(e) === openFolder);
  if (!games.length) libraryHint.textContent = 'このフォルダにはまだゲームがありません';
  for (const entry of games) libraryEl.append(libraryRow(entry));
}

function libraryRow(entry: LibraryEntry): HTMLLIElement {
  const li = document.createElement('li');
  const playing = entry.id === currentId;
  if (playing) li.className = 'current';
  const play = document.createElement('button');
  play.className = 'btn play';
  const name = document.createElement('span');
  name.textContent = baseName(entry.name);
  const when = document.createElement('small');
  when.textContent = playing ? 'プレイ中' : `最後に遊んだ日 ${formatTime(entry.lastPlayed)}`;
  play.append(name, when);
  play.addEventListener('click', async () => {
    if (playing) return closeMenu();
    closeMenu();
    const started = await startRom(entry.name, entry.data, entry.files, entry.id, entry.cardId);
    if (started?.resumed) showToast('前のつづきから再開しました', { label: '最初から', run: restartFromBeginning });
    else if (started?.loadedSave) showToast('セーブデータを読み込みました');
  });
  const del = confirmButton('削除', '消す？', async () => {
    await deleteLibrary(entry.id);
    await renderLibrary();
  }, 'btn del');
  li.append(play, del);
  return li;
}

// ---- 巻き戻し ----
// 10 フレームごとに状態を覚えておき（だいたい 10 秒ぶん。メモリは 24M バイトまで）、ボタンを押している間はそれを新しい順に戻す
class Rewind {
  private buf: SaveState[] = [];
  private cap = 60;
  private counter = 0;
  private every = 10;
  active = false;
  private popWait = 0;

  clear(): void {
    this.buf = [];
    this.counter = 0;
    this.every = 10;
  }

  /** ふつうに 1 フレーム進めたあと */
  record(m: Machine): void {
    if (++this.counter < this.every) return;
    this.counter = 0;
    const st = m.saveState();
    if (this.buf.length === 0) {
      const size = stateBytes(st);
      this.cap = Math.max(4, Math.min(60, Math.floor((40 << 20) / Math.max(1, size))));
      // 大きい本体（64 は 9MB くらい）は、覚える間隔をあけて軽くする
      this.every = size > 4 << 20 ? 60 : 10;
    }
    this.buf.push(st);
    if (this.buf.length > this.cap) this.buf.shift();
  }

  /** 巻き戻し中の 1 フレーム：3 フレームに 1 回 1 つ前に戻り、その絵を出す。戻れなければ false */
  step(m: Machine): boolean {
    if (this.popWait > 0) {
      this.popWait--;
      return true;
    }
    // いちばん古いものは残しておく（そこで止まる）
    const st = this.buf.length > 1 ? this.buf.pop() : this.buf[0];
    if (!st) return false;
    try {
      m.loadState(st);
    } catch {
      this.clear();
      return false;
    }
    this.popWait = 2;
    // 1 フレームだけ動かして、その時点の絵を作る（音は出さない）
    m.setButtons(0);
    m.runFrame();
    m.takeSamples();
    this.last = st;
    return true;
  }
  /** 最後に戻った状態（離したときにそこへ戻してから再開する） */
  last: SaveState | null = null;
}
function stateBytes(v: unknown): number {
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (Array.isArray(v)) return v.reduce((a: number, x) => a + stateBytes(x), 0);
  if (v && typeof v === 'object') return Object.values(v).reduce((a: number, x) => a + stateBytes(x), 0);
  return 8;
}
const rewind = new Rewind();
const rewindButton = $<HTMLButtonElement>('rewind');
const rewindOn = (e: Event) => {
  e.preventDefault();
  if (!machine) return;
  rewind.active = true;
  rewind.last = null;
  rewindButton.classList.add('on');
};
const rewindOff = () => {
  if (!rewind.active) return;
  rewind.active = false;
  rewindButton.classList.remove('on');
  // 最後に見せた状態から続ける
  if (machine && rewind.last) machine.loadState(rewind.last);
  rewind.last = null;
  acc = 0;
};
rewindButton.addEventListener('pointerdown', rewindOn);
rewindButton.addEventListener('pointerup', rewindOff);
rewindButton.addEventListener('pointercancel', rewindOff);
rewindButton.addEventListener('pointerleave', rewindOff);
rewindButton.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.code === 'Backspace' && !e.repeat) rewindOn(e);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Backspace') rewindOff();
});

// ---- 早送り ----
const ffButton = $<HTMLButtonElement>('ff');
/** 1〜3 倍は 0.25 刻み、その上は 4・6 倍 */
const FF_SPEEDS = [1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 4, 6];
const FF_KEY = 'nes-emu:ff-speed';
let ffSpeed = 3;
try {
  const v = Number(localStorage.getItem(FF_KEY));
  if (FF_SPEEDS.includes(v)) ffSpeed = v;
} catch {
  // 無視
}
let fastForward = false;
const showFf = () => {
  ffButton.classList.toggle('on', fastForward);
  ffButton.setAttribute('aria-pressed', String(fastForward));
  ffButton.textContent = fastForward ? `⏩×${ffSpeed}` : '⏩';
};
ffButton.addEventListener('click', () => {
  fastForward = !fastForward;
  showFf();
});

/** メニューの「早送りの速さ」 */
function renderFfSpeeds(): void {
  const el = $('ff-speeds');
  el.replaceChildren();
  for (const v of FF_SPEEDS) {
    el.append(
      button(
        `${v} 倍`,
        () => {
          ffSpeed = v;
          try {
            localStorage.setItem(FF_KEY, String(v));
          } catch {
            // 無視
          }
          showFf();
          renderFfSpeeds();
        },
        'btn' + (v === ffSpeed ? ' accent' : ''),
      ),
    );
  }
}

/** 早送り中の音は、間引いて高く速く鳴らす */
function decimate(samples: Float32Array, n: number): Float32Array {
  // 左・右が交互に並んでいるので、1 組ずつ間引く（1.5 倍などの半端な速さにも対応）
  const frames = Math.floor(samples.length / 2 / n);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const j = Math.floor(i * n) * 2;
    out[i * 2] = samples[j];
    out[i * 2 + 1] = samples[j + 1];
  }
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
  if (machine && image && !document.hidden && !menuOpen) {
    const speed = fastForward ? ffSpeed : 1;
    // 本体ごとのフレームレート（ファミコン 60.1、ゲームボーイ 59.7、ワンダースワン 75.5）で進める
    const FRAME_MS = 1000 / machine.fps;
    acc = Math.min(acc + dt * speed, FRAME_MS * 3 * speed);
    // 絵を間引ける本体は、遅れているときは最後の 1 フレームだけ描く
    const canSkip = !!machine.setSkip;
    let ran = false;
    // 半フレーム分たまったら 1 フレーム進める（60Hz 画面で毎回 1 フレームになるように）
    let rewound = false;
    while (acc >= FRAME_MS / 2) {
      if (rewind.active) {
        // 巻き戻し中：ふつうの速さで、前の状態を順に見せる
        rewind.step(machine);
        rewound = true;
        acc -= FRAME_MS * speed;
        frames++;
        ran = true;
        continue;
      }
      machine.setButtons(touch.read() | keyboard.read());
      if (cheats.active && machine.poke) cheats.apply(machine as unknown as CheatTarget);
      if (canSkip) machine.setSkip!(acc >= FRAME_MS * 1.5);
      machine.runFrame();
      rewind.record(machine);
      acc -= FRAME_MS;
      frames++;
      ran = true;
    }
    // プレイステーションは画面の大きさが変わる
    if (ran && image.data.buffer !== machine.frameBuffer.buffer) bindScreen(machine);
    if (ran) smooth.draw(machine.frameBuffer, machine.width, machine.height, machine.crop);
    if (ran && rewound) ctx.putImageData(image, -machine.crop, -machine.crop);
    else if (ran) {
      // 上下左右の 8 ドットは、実機のテレビでも見えない部分（左端の線やスクロールのちらつきが出る）なので切り落とす
      ctx.putImageData(image, -machine.crop, -machine.crop);
      const samples = machine.takeSamples();
      audio.push(speed > 1 ? decimate(samples, speed) : samples);
      machine.setAudio(audio.sampleRate, audio.rateAdjust());
    }
  }
  if (now - fpsTime >= 1000) {
    fpsLabel.textContent = machine ? `${Math.round((frames * 1000) / (now - fpsTime))} fps` : '';
    frames = 0;
    fpsTime = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// 開発サーバーでだけ、動作確認用に中身を見られるようにする
if (import.meta.env.DEV) Object.assign(window, { emu: { machine: () => machine, audio } });
