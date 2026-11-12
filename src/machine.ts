// ファミコンとゲームボーイを、アプリから同じように扱うための窓口
import { BUTTON } from './controller';
import { Gb } from './gb/gb';
import { isGbRom } from './gb/cart';
import { applyGbPalette } from './gb/palettes';
import { GB_H, GB_W } from './gb/ppu';
import { Nes } from './nes';
import { SCREEN_H, SCREEN_W } from './ppu';
import { applyState, captureState, loadState, saveState, type SaveState } from './savestate';
import { GBA_CLOCK } from './gba/apu';
import { Gba, isGbaRom } from './gba/gba';
import { GBA_H, GBA_W } from './gba/ppu';
import { isSnesRom } from './snes/cart';
import { SNES_H, SNES_W } from './snes/ppu';
import { LINE_CYCLES, LINES, MASTER_CLOCK, Snes } from './snes/snes';
import { WS_H, WS_W } from './ws/display';
import { isWsRom, Ws } from './ws/ws';
import { Psx } from './psx/psx';
import type { Disc } from './psx/disc';
import { PAD } from './psx/sio';

export type System = 'nes' | 'gb' | 'ws' | 'gba' | 'snes' | 'psx';

/** ROM の中身（とファイル名）から本体を決める。わからなければ null */
export function detectSystem(data: Uint8Array, name = ''): System | null {
  if (data[0] === 0x4e && data[1] === 0x45 && data[2] === 0x53 && data[3] === 0x1a) return 'nes';
  if (isPsxExe(data)) return 'psx';
  if (isGbaRom(data)) return 'gba';
  if (isGbRom(data)) return 'gb';
  if (/\.(sfc|smc)$/i.test(name)) return 'snes';
  if (/\.wsc?$/i.test(name)) return 'ws';
  if (isSnesRom(data)) return 'snes';
  if (isWsRom(data)) return 'ws';
  return null;
}

export interface Machine {
  readonly system: System;
  /** 1 秒あたりのフレーム数 */
  readonly fps: number;
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
  /** ワンダースワンの縦持ちのソフトか */
  readonly vertical?: boolean;
  /** 白黒のゲームボーイのソフトで、色をつけられるか */
  readonly colorable: boolean;
  /** 色づけのパレット（palettes.ts の id） */
  setPalette(id: string): void;
  /** 画面の縦横比（なければ width・height のとおり。プレイステーションはいつも 4:3） */
  readonly aspect?: [number, number];
  /** 液晶っぽい色にする（ゲームボーイアドバンスだけ） */
  setLcdColor?(on: boolean): void;
  reset(): void;
  /** バッテリーバックアップのセーブデータ（なければ null） */
  readonly saveRam: Uint8Array | null;
  saveDirty: boolean;
  /** セーブデータを saveRam に書き込んだあとに呼ぶ */
  afterSaveLoaded(): void;
  saveState(): SaveState;
  loadState(state: SaveState): void;
}

/** ROM の中身から本体を決めて作る（どれでもなければ例外） */
export function createMachine(data: Uint8Array, name = ''): Machine {
  switch (detectSystem(data, name)) {
    case 'nes':
      return new NesMachine(data);
    case 'gb':
      return new GbMachine(data);
    case 'ws':
      return new WsMachine(data);
    case 'gba':
      return new GbaMachine(data);
    case 'snes':
      return new SnesMachine(data);
  }
  throw new Error(
    'ファミコン（.nes）・ゲームボーイ（.gb / .gbc）・ワンダースワン（.ws / .wsc）・ゲームボーイアドバンス（.gba）・スーパーファミコン（.sfc / .smc）の ROM を選んでください',
  );
}

class NesMachine implements Machine {
  readonly system = 'nes';
  readonly fps = 60.0988;
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
    this.nes.bus.pads[0].buttons = b & 0xff;
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
  readonly fps = 59.7275;
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
    b &= 0xff;
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

/**
 * ワンダースワン。縦持ちのソフトは画面を 90° 回して出し、十字キーを Y ボタンに、A・B を X ボタンに割り当てる
 */
class WsMachine implements Machine {
  readonly system = 'ws';
  readonly fps = 75.47;
  readonly crop = 0;
  readonly colorable = false;
  readonly width: number;
  readonly height: number;
  readonly frameBuffer: Uint32Array<ArrayBuffer>;
  ws: Ws;
  readonly vertical: boolean;
  private spread = 1;
  private keys = 0;

  constructor(private readonly data: Uint8Array) {
    this.ws = new Ws(data);
    this.ws.sound.stereo = true;
    this.vertical = this.ws.header.vertical;
    this.width = this.vertical ? WS_H : WS_W;
    this.height = this.vertical ? WS_W : WS_H;
    this.frameBuffer = this.vertical ? new Uint32Array(WS_W * WS_H) : this.ws.display.frameBuffer;
  }
  setPalette() {}
  runFrame() {
    this.ws.runFrame();
    if (!this.vertical) return;
    // 本体を左に 90° 倒して持つ向き：画面の上の行が左の列になる
    const src = this.ws.display.frameBuffer;
    const dst = this.frameBuffer;
    for (let y = 0; y < WS_W; y++) {
      const sx = WS_W - 1 - y;
      for (let x = 0; x < WS_H; x++) dst[y * WS_H + x] = src[x * WS_W + sx];
    }
  }
  setButtons(b: number) {
    const up = b & BUTTON.UP ? 1 : 0;
    const right = b & BUTTON.RIGHT ? 1 : 0;
    const down = b & BUTTON.DOWN ? 1 : 0;
    const left = b & BUTTON.LEFT ? 1 : 0;
    let k = 0;
    const eu = b & BUTTON.EX_UP ? 1 : 0;
    const er = b & BUTTON.EX_RIGHT ? 1 : 0;
    const ed = b & BUTTON.EX_DOWN ? 1 : 0;
    const el = b & BUTTON.EX_LEFT ? 1 : 0;
    if (!this.vertical) {
      // 十字キー = X1〜X4（↑ → ↓ ←）、ひし形のボタン = Y1〜Y4
      k = up | (right << 1) | (down << 2) | (left << 3);
      k |= (eu | (er << 1) | (ed << 2) | (el << 3)) << 4;
    } else {
      // 縦持ち（本体を左に倒す）：Y1〜Y4 は ← ↑ → ↓ に、X1〜X4 も ← ↑ → ↓ に見える
      k = (left | (up << 1) | (right << 2) | (down << 3)) << 4;
      k |= el | (eu << 1) | (er << 2) | (ed << 3);
    }
    if (b & BUTTON.A) k |= 1 << 9;
    if (b & BUTTON.B) k |= 1 << 10;
    if (b & BUTTON.START) k |= 1 << 8;
    this.keys = k;
    this.ws.setKeys(k);
  }
  takeSamples() {
    return this.ws.sound.takeSamples();
  }
  setAudio(rate: number, adjust: number) {
    this.ws.sound.sampleRate = rate;
    this.ws.sound.rateAdjust = adjust;
  }
  setStereo(spread: number) {
    this.spread = spread;
    this.ws.sound.spread = spread;
  }
  reset() {
    const old = this.ws;
    const next = new Ws(this.data);
    const ram = old.saveRam;
    if (ram) next.saveRam!.set(ram);
    next.sound.stereo = true;
    next.sound.spread = this.spread;
    next.sound.sampleRate = old.sound.sampleRate;
    next.sound.rateAdjust = old.sound.rateAdjust;
    next.setKeys(this.keys);
    this.ws = next;
    if (!this.vertical) (this as { frameBuffer: Uint32Array<ArrayBuffer> }).frameBuffer = next.display.frameBuffer;
  }
  get saveRam() {
    return this.ws.saveRam;
  }
  get saveDirty() {
    return this.ws.saveDirty;
  }
  set saveDirty(v: boolean) {
    this.ws.saveDirty = v;
  }
  afterSaveLoaded() {}
  private parts(): Record<string, object> {
    const w = this.ws;
    return { ws: w, cpu: w.cpu, display: w.display, sound: w.sound };
  }
  /** マッパーの番号の代わりに、ROM の大きさとセーブの種類で別のソフトのセーブを見分ける */
  private id(): number {
    return this.ws.rom.length + this.ws.header.saveType;
  }
  saveState() {
    const w = this.ws;
    return captureState('ws', this.id(), this.parts(), new Set<unknown>([w, w.cpu, w.display, w.sound, w.rom]));
  }
  loadState(s: SaveState) {
    applyState(s, 'ws', this.id(), this.parts());
    this.ws.saveDirty = this.ws.saveRam !== null;
  }
}

/** ゲームボーイアドバンス（L・R ボタンあり） */
class GbaMachine implements Machine {
  readonly system = 'gba';
  /** 1 フレーム = 228 ライン × 1232 クロック */
  readonly fps = GBA_CLOCK / 280896;
  readonly width = GBA_W;
  readonly height = GBA_H;
  readonly crop = 0;
  readonly colorable = false;
  gba: Gba;
  private keys = 0;
  private spread = 1;
  private lcd = false;

  constructor(private readonly data: Uint8Array) {
    this.gba = new Gba(data);
    this.gba.apu.stereo = true;
  }
  setPalette() {}
  setLcdColor(on: boolean) {
    this.lcd = on;
    this.gba.ppu.lcd = on;
  }
  get frameBuffer() {
    return this.gba.ppu.frameBuffer;
  }
  runFrame() {
    this.gba.runFrame();
  }
  setButtons(b: number) {
    if ((b & (BUTTON.UP | BUTTON.DOWN)) === (BUTTON.UP | BUTTON.DOWN)) b &= ~(BUTTON.UP | BUTTON.DOWN);
    if ((b & (BUTTON.LEFT | BUTTON.RIGHT)) === (BUTTON.LEFT | BUTTON.RIGHT)) b &= ~(BUTTON.LEFT | BUTTON.RIGHT);
    // KEYINPUT の並び：A B SELECT START → ← ↑ ↓ R L
    let k = 0;
    if (b & BUTTON.A) k |= 1;
    if (b & BUTTON.B) k |= 2;
    if (b & BUTTON.SELECT) k |= 4;
    if (b & BUTTON.START) k |= 8;
    if (b & BUTTON.RIGHT) k |= 0x10;
    if (b & BUTTON.LEFT) k |= 0x20;
    if (b & BUTTON.UP) k |= 0x40;
    if (b & BUTTON.DOWN) k |= 0x80;
    if (b & BUTTON.R) k |= 0x100;
    if (b & BUTTON.L) k |= 0x200;
    if (k === this.keys) return;
    this.keys = k;
    this.gba.setKeys(k);
  }
  takeSamples() {
    return this.gba.apu.takeSamples();
  }
  setAudio(rate: number, adjust: number) {
    this.gba.apu.sampleRate = rate;
    this.gba.apu.rateAdjust = adjust;
  }
  setStereo(spread: number) {
    this.spread = spread;
    this.gba.apu.spread = spread;
  }
  reset() {
    const old = this.gba;
    const next = new Gba(this.data);
    next.save.data.set(old.save.data);
    next.apu.stereo = true;
    next.apu.spread = this.spread;
    next.apu.sampleRate = old.apu.sampleRate;
    next.apu.rateAdjust = old.apu.rateAdjust;
    next.setKeys(this.keys);
    next.ppu.lcd = this.lcd;
    this.gba = next;
  }
  get saveRam() {
    return this.gba.save.data;
  }
  get saveDirty() {
    return this.gba.save.dirty;
  }
  set saveDirty(v: boolean) {
    this.gba.save.dirty = v;
  }
  afterSaveLoaded() {}
  private parts(): Record<string, object> {
    const g = this.gba;
    const parts: Record<string, object> = { gba: g, cpu: g.cpu, ppu: g.ppu, apu: g.apu, save: g.save };
    if (g.rtc) parts.rtc = g.rtc;
    return parts;
  }
  saveState() {
    const g = this.gba;
    const skip = new Set<unknown>([g, g.cpu, g.ppu, g.apu, g.save, g.rtc, ...g.stateSkip(), ...g.ppu.stateSkip()]);
    return captureState('gba', this.data.length, this.parts(), skip);
  }
  loadState(s: SaveState) {
    applyState(s, 'gba', this.data.length, this.parts());
    this.gba.save.dirty = true;
    this.gba.ppu.lcd = this.lcd;
  }
}

/** スーパーファミコン（A・B・X・Y・L・R） */
class SnesMachine implements Machine {
  readonly system = 'snes';
  readonly fps = MASTER_CLOCK / (LINE_CYCLES * LINES);
  readonly width = SNES_W;
  readonly height = SNES_H;
  readonly crop = 0;
  readonly colorable = false;
  snes: Snes;
  private pad = 0;
  private spread = 1;

  constructor(private readonly data: Uint8Array) {
    this.snes = new Snes(data);
    this.snes.apu.stereo = true;
  }
  setPalette() {}
  get frameBuffer() {
    return this.snes.ppu.frameBuffer;
  }
  runFrame() {
    this.snes.runFrame();
  }
  setButtons(b: number) {
    if ((b & (BUTTON.UP | BUTTON.DOWN)) === (BUTTON.UP | BUTTON.DOWN)) b &= ~(BUTTON.UP | BUTTON.DOWN);
    if ((b & (BUTTON.LEFT | BUTTON.RIGHT)) === (BUTTON.LEFT | BUTTON.RIGHT)) b &= ~(BUTTON.LEFT | BUTTON.RIGHT);
    // コントローラーの並び（上位ビットから）：B Y SELECT START ↑ ↓ ← → A X L R
    let p = 0;
    if (b & BUTTON.B) p |= 0x8000;
    if (b & BUTTON.Y) p |= 0x4000;
    if (b & BUTTON.SELECT) p |= 0x2000;
    if (b & BUTTON.START) p |= 0x1000;
    if (b & BUTTON.UP) p |= 0x0800;
    if (b & BUTTON.DOWN) p |= 0x0400;
    if (b & BUTTON.LEFT) p |= 0x0200;
    if (b & BUTTON.RIGHT) p |= 0x0100;
    if (b & BUTTON.A) p |= 0x0080;
    if (b & BUTTON.X) p |= 0x0040;
    if (b & BUTTON.L) p |= 0x0020;
    if (b & BUTTON.R) p |= 0x0010;
    this.pad = p;
    this.snes.setPad(p);
  }
  takeSamples() {
    return this.snes.apu.takeSamples();
  }
  setAudio(rate: number, adjust: number) {
    this.snes.apu.sampleRate = rate;
    this.snes.apu.rateAdjust = adjust;
  }
  setStereo(spread: number) {
    this.spread = spread;
    this.snes.apu.spread = spread;
  }
  reset() {
    const old = this.snes;
    const next = new Snes(this.data);
    next.sram.set(old.sram);
    next.apu.stereo = true;
    next.apu.spread = this.spread;
    next.apu.sampleRate = old.apu.sampleRate;
    next.apu.rateAdjust = old.apu.rateAdjust;
    next.setPad(this.pad);
    this.snes = next;
  }
  get saveRam() {
    return this.snes.sram.length ? this.snes.sram : null;
  }
  get saveDirty() {
    return this.snes.sramDirty;
  }
  set saveDirty(v: boolean) {
    this.snes.sramDirty = v;
  }
  afterSaveLoaded() {}
  private parts(): Record<string, object> {
    const s = this.snes;
    const parts: Record<string, object> = { snes: s, cpu: s.cpu, ppu: s.ppu, apu: s.apu, spc: s.apu.spc, dsp: s.apu.dsp };
    if (s.dsp1) parts.dsp1 = s.dsp1;
    return parts;
  }
  saveState() {
    const s = this.snes;
    const skip = new Set<unknown>([s, s.cpu, s.ppu, s.apu, s.apu.spc, s.apu.dsp, s.dsp1, s.info, ...s.stateSkip()]);
    return captureState('snes', this.data.length, this.parts(), skip);
  }
  loadState(st: SaveState) {
    applyState(st, 'snes', this.data.length, this.parts());
    this.snes.sramDirty = this.snes.sram.length > 0;
  }
}

/** プレイステーションの実行ファイル（PS-X EXE） */
export function isPsxExe(d: Uint8Array): boolean {
  return d.length > 0x800 && String.fromCharCode(...d.subarray(0, 8)) === 'PS-X EXE';
}

/** プレイステーション（△○×□・L1/L2/R1/R2） */
export class PsxMachine implements Machine {
  readonly system = 'psx';
  readonly fps: number;
  readonly crop = 0;
  readonly colorable = false;
  readonly aspect: [number, number] = [320, 240];
  psx: Psx;
  private pad = 0;
  private spread = 1;

  constructor(
    private readonly bios: Uint8Array,
    private readonly disc: Disc | null,
    private readonly exe: Uint8Array | null,
    private readonly id: number,
  ) {
    this.psx = this.make();
    this.fps = this.psx.fps;
  }

  private make(): Psx {
    const p = new Psx(this.bios);
    if (this.disc) {
      p.insertDisc(this.disc);
      p.pal = this.disc.region() === 'pal';
    }
    if (this.exe) p.loadExe(this.exe);
    return p;
  }

  setPalette() {}
  get width() {
    return this.psx.gpu.outW;
  }
  get height() {
    return this.psx.gpu.outH;
  }
  get frameBuffer() {
    return this.psx.gpu.frameBuffer;
  }
  runFrame() {
    this.psx.runFrame();
  }
  setButtons(b: number) {
    let p = 0;
    if (b & BUTTON.SELECT) p |= PAD.SELECT;
    if (b & BUTTON.START) p |= PAD.START;
    if (b & BUTTON.UP) p |= PAD.UP;
    if (b & BUTTON.DOWN) p |= PAD.DOWN;
    if (b & BUTTON.LEFT) p |= PAD.LEFT;
    if (b & BUTTON.RIGHT) p |= PAD.RIGHT;
    if (b & BUTTON.A) p |= PAD.CIRCLE;
    if (b & BUTTON.B) p |= PAD.CROSS;
    if (b & BUTTON.X) p |= PAD.TRIANGLE;
    if (b & BUTTON.Y) p |= PAD.SQUARE;
    if (b & BUTTON.L) p |= PAD.L1;
    if (b & BUTTON.R) p |= PAD.R1;
    if (b & BUTTON.L2) p |= PAD.L2;
    if (b & BUTTON.R2) p |= PAD.R2;
    this.pad = p;
    this.psx.sio.buttons = p;
  }
  takeSamples() {
    return this.psx.spu.takeSamples();
  }
  setAudio(rate: number, adjust: number) {
    this.psx.spu.sampleRate = rate;
    this.psx.spu.rateAdjust = adjust;
  }
  setStereo(spread: number) {
    this.spread = spread;
    this.psx.spu.spread = spread;
  }
  reset() {
    const old = this.psx;
    const next = this.make();
    next.sio.card.set(old.sio.card);
    next.spu.spread = this.spread;
    next.spu.sampleRate = old.spu.sampleRate;
    next.spu.rateAdjust = old.spu.rateAdjust;
    next.sio.buttons = this.pad;
    this.psx = next;
  }
  get saveRam() {
    return this.psx.sio.card;
  }
  get saveDirty() {
    return this.psx.sio.cardDirty;
  }
  set saveDirty(v: boolean) {
    this.psx.sio.cardDirty = v;
  }
  afterSaveLoaded() {}
  private parts(): Record<string, object> {
    const p = this.psx;
    return {
      psx: p,
      cpu: p.cpu,
      gte: p.gte,
      gpu: p.gpu,
      timers: p.timers,
      cdrom: p.cdrom,
      cdaudio: p.cdrom.audio,
      spu: p.spu,
      mdec: p.mdec,
      sio: p.sio,
    };
  }
  saveState() {
    const p = this.psx;
    const skip = new Set<unknown>([
      p,
      p.cpu,
      p.gte,
      p.gpu,
      p.timers,
      p.cdrom,
      p.cdrom.audio,
      p.spu,
      p.mdec,
      p.sio,
      p.cdrom.disc,
      ...p.stateSkip(),
      ...p.gpu.stateSkip(),
      ...p.cdrom.stateSkip(),
      ...p.spu.stateSkip(),
      ...p.mdec.stateSkip(),
    ]);
    return captureState('psx', this.id, this.parts(), skip);
  }
  loadState(st: SaveState) {
    applyState(st, 'psx', this.id, this.parts());
    this.psx.gpu.render();
    this.psx.sio.cardDirty = true;
    this.psx.sio.buttons = this.pad;
  }
}
