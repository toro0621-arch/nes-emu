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

let nes: Nes | null = null;
let image: ImageData | null = null;

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
      nes.runFrame();
      acc -= FRAME_MS;
      frames++;
      ran = true;
    }
    if (ran) ctx.putImageData(image, 0, 0);
  }
  if (now - fpsTime >= 1000) {
    fpsLabel.textContent = nes ? `${Math.round((frames * 1000) / (now - fpsTime))} fps` : '';
    frames = 0;
    fpsTime = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
