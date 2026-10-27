import { registerSW } from 'virtual:pwa-register';
import { AudioOutput } from './audio/output';
import { KeyboardInput } from './input/keyboard';
import { TouchInput } from './input/touch';
import { Nes } from './nes';
import { SCREEN_H, SCREEN_W } from './ppu';
import { loadLastRom, saveLastRom } from './storage';
import { keepScreenOn } from './wakelock';

const FRAME_MS = 1000 / 60.0988; // NTSC の NES のフレームレート

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('screen');
const ctx = canvas.getContext('2d')!;
const message = $('message');
const fpsLabel = $('fps');
const romInput = $<HTMLInputElement>('rom');
const resetButton = $<HTMLButtonElement>('reset');
const soundButton = $<HTMLButtonElement>('sound');

const touch = new TouchInput($('pad'));
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

function startRom(name: string, data: Uint8Array): boolean {
  try {
    nes = new Nes(data);
    // PPU の画面バッファをそのまま ImageData として使う（コピーなし）
    image = new ImageData(new Uint8ClampedArray(nes.ppu.frameBuffer.buffer), SCREEN_W, SCREEN_H);
    message.textContent = '';
    resetButton.disabled = false;
    document.title = `${name.replace(/\.nes$/i, '')} - NES Emu`;
    acc = 0;
    keepScreenOn(true);
    return true;
  } catch (e) {
    nes = null;
    resetButton.disabled = true;
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    message.textContent = e instanceof Error ? e.message : String(e);
    keepScreenOn(false);
    return false;
  }
}

romInput.addEventListener('change', async () => {
  const file = romInput.files?.[0];
  romInput.value = '';
  if (!file) return;
  const data = new Uint8Array(await file.arrayBuffer());
  if (startRom(file.name, data)) void saveLastRom({ name: file.name, data });
});

// 前回の ROM があれば読み込んでおく（音は最初のタップで出始める）
void loadLastRom().then((rom) => {
  if (rom && !nes && startRom(rom.name, rom.data)) showToast(`前回の「${rom.name}」を読み込みました`);
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

resetButton.addEventListener('click', () => nes?.reset());

// 画面のリフレッシュレート（60Hz / 120Hz など）に関係なく、NES の 60.1fps で進める
let acc = 0;
let last = performance.now();
let frames = 0;
let fpsTime = last;

function loop(now: number): void {
  const dt = now - last;
  last = now;
  if (nes && image && !document.hidden) {
    acc = Math.min(acc + dt, FRAME_MS * 3);
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
      ctx.putImageData(image, 0, 0);
      const samples = nes.apu.takeSamples();
      audio.push(samples);
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
