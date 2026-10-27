import { AudioOutput } from './audio/output';
import { KeyboardInput } from './input/keyboard';
import { TouchInput } from './input/touch';
import { Nes } from './nes';
import { SCREEN_H, SCREEN_W } from './ppu';

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

romInput.addEventListener('change', async () => {
  const file = romInput.files?.[0];
  romInput.value = '';
  if (!file) return;
  try {
    nes = new Nes(new Uint8Array(await file.arrayBuffer()));
    // PPU の画面バッファをそのまま ImageData として使う（コピーなし）
    image = new ImageData(new Uint8ClampedArray(nes.ppu.frameBuffer.buffer), SCREEN_W, SCREEN_H);
    message.textContent = '';
    resetButton.disabled = false;
    acc = 0;
  } catch (e) {
    nes = null;
    resetButton.disabled = true;
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    message.textContent = e instanceof Error ? e.message : String(e);
  }
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
