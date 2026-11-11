// ファミコンとゲームボーイを、アプリから同じように扱うための窓口
import { BUTTON } from './controller';
import { Gb } from './gb/gb';
import { isGbRom } from './gb/cart';
import { applyGbPalette } from './gb/palettes';
import { GB_H, GB_W } from './gb/ppu';
import { Nes } from './nes';
import { SCREEN_H, SCREEN_W } from './ppu';
import { applyState, captureState, loadState, saveState, type SaveState } from './savestate';

export type System = 'nes' | 'gb';

export interface Machine {
  readonly system: System;
  /** 画面の大きさ（frameBuffer の幅・高さ）と、上下左右から切り落とす幅 */
  readonly width: number;
  readonly height: number;
  readonly crop: number;
  /** ImageData にそのまま書ける色（ABGR）の画面 */
  readonly frameBuffer: Uint32Array<ArrayBuffer>;
  runFrame(): void;
  /** 押されているボタン（BUTTON の OR） */
  setButtons(b: number): void;
  takeSamples(): Float32Array;
  setAudio(sampleRate: number, rateAdjust: number): void;
  /** ステレオの広がり（0 = モノラル、1 = ステレオ）。音は左・右が交互に出てくる */
  setStereo(spread: number): void;
  /** 白黒のゲームボーイのソフトで、色をつけられるか */
  readonly colorable: boolean;
  /** 色づけのパレット（palettes.ts の id） */
  setPalette(id: string): void;
  reset(): void;
  /** バッテリーバックアップのセーブデータ（なければ null） */
  readonly saveRam: Uint8Array | null;
  saveDirty: boolean;
  /** セーブデータを saveRam に書き込んだあとに呼ぶ */
  afterSaveLoaded(): void;
  saveState(): SaveState;
  loadState(state: SaveState): void;
}

/** ROM の中身から本体を決めて作る（どちらでもなければ例外） */
export function createMachine(data: Uint8Array): Machine {
  if (data[0] === 0x4e && data[1] === 0x45 && data[2] === 0x53 && data[3] === 0x1a) return new NesMachine(data);
  if (isGbRom(data)) return new GbMachine(data);
  throw new Error('ファミコン（.nes）かゲームボーイ（.gb / .gbc）の ROM を選んでください');
}

class NesMachine implements Machine {
  readonly system = 'nes';
  readonly width = SCREEN_W;
  readonly height = SCREEN_H;
  readonly crop = 8;
  readonly colorable = false;
  readonly nes: Nes;
  setPalette() {}

  constructor(data: Uint8Array) {
    this.nes = new Nes(data);
    this.nes.apu.stereo = true;
  }
  setStereo(spread: number) {
    this.nes.apu.spread = spread;
  }
  get frameBuffer() {
    return this.nes.ppu.frameBuffer;
  }
  runFrame() {
    this.nes.runFrame();
  }
  setButtons(b: number) {
    this.nes.bus.pads[0].buttons = b;
  }
  takeSamples() {
    return this.nes.apu.takeSamples();
  }
  setAudio(rate: number, adjust: number) {
    this.nes.apu.sampleRate = rate;
    this.nes.apu.rateAdjust = adjust;
  }
  reset() {
    this.nes.reset();
  }
  get saveRam() {
    return this.nes.mapper.saveRam;
  }
  get saveDirty() {
    return this.nes.mapper.saveDirty;
  }
  set saveDirty(v: boolean) {
    this.nes.mapper.saveDirty = v;
  }
  afterSaveLoaded() {}
  saveState() {
    return saveState(this.nes);
  }
  loadState(s: SaveState) {
    loadState(this.nes, s);
  }
}

class GbMachine implements Machine {
  readonly system = 'gb';
  readonly width = GB_W;
  readonly height = GB_H;
  readonly crop = 0;
  gb: Gb;
  private buttons = 0;

  private spread = 1;
  private palette = 'auto';
  get colorable() {
    return !this.gb.cgb;
  }
  setPalette(id: string) {
    this.palette = id;
    if (!this.gb.cgb) applyGbPalette(this.gb.ppu, id, this.gb.cart.title);
  }

  constructor(private readonly data: Uint8Array) {
    this.gb = new Gb(data);
    this.gb.apu.stereo = true;
  }
  setStereo(spread: number) {
    this.spread = spread;
    this.gb.apu.spread = spread;
  }
  get frameBuffer() {
    return this.gb.ppu.frameBuffer;
  }
  runFrame() {
    this.gb.runFrame();
  }
  setButtons(b: number) {
    // ゲームボーイは十字キーの反対どうしも同時に押せてしまうので、ファミコンと同じく打ち消す
    if ((b & (BUTTON.UP | BUTTON.DOWN)) === (BUTTON.UP | BUTTON.DOWN)) b &= ~(BUTTON.UP | BUTTON.DOWN);
    if ((b & (BUTTON.LEFT | BUTTON.RIGHT)) === (BUTTON.LEFT | BUTTON.RIGHT)) b &= ~(BUTTON.LEFT | BUTTON.RIGHT);
    this.buttons = b;
    this.gb.setButtons(b);
  }
  takeSamples() {
    return this.gb.apu.takeSamples();
  }
  setAudio(rate: number, adjust: number) {
    this.gb.apu.sampleRate = rate;
    this.gb.apu.rateAdjust = adjust;
  }
  reset() {
    // ゲームボーイにはリセットボタンがないので、電源を入れ直す（カートリッジの RAM はそのまま）
    const old = this.gb;
    const next = new Gb(this.data);
    const ram = old.cart.saveRam ?? old.cart.ram;
    (next.cart.saveRam ?? next.cart.ram).set(ram);
    next.cart.loadRtc();
    next.setButtons(this.buttons);
    next.apu.stereo = true;
    if (!next.cgb) applyGbPalette(next.ppu, this.palette, next.cart.title);
    next.apu.spread = this.spread;
    next.apu.sampleRate = old.apu.sampleRate;
    next.apu.rateAdjust = old.apu.rateAdjust;
    this.gb = next;
  }
  get saveRam() {
    return this.gb.cart.saveRam;
  }
  get saveDirty() {
    return this.gb.cart.saveDirty;
  }
  set saveDirty(v: boolean) {
    this.gb.cart.saveDirty = v;
  }
  afterSaveLoaded() {
    this.gb.cart.loadRtc();
  }
  private parts(): Record<string, object> {
    const g = this.gb;
    return { gb: g, cpu: g.cpu, ppu: g.ppu, apu: g.apu, cart: g.cart };
  }
  saveState() {
    const g = this.gb;
    return captureState('gb', g.cart.type, this.parts(), new Set<unknown>([g, g.cpu, g.ppu, g.apu, g.cart, g.cart.rom]));
  }
  loadState(s: SaveState) {
    applyState(s, 'gb', this.gb.cart.type, this.parts());
    this.gb.ppu.refreshPalettes();
    this.setPalette(this.palette);
    this.gb.cart.saveDirty = this.gb.cart.saveRam !== null;
  }
}
