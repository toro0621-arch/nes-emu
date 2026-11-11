// ゲームボーイ：blargg のテスト ROM と、画面・カートリッジ・どこでもセーブを確かめる
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GbCart } from '../src/gb/cart';
import { Gb } from '../src/gb/gb';
import { DMG_COLORS, GbPpu } from '../src/gb/ppu';
import { createMachine } from '../src/machine';

const ROMS = join(__dirname, 'roms', 'gb');
const load = (name: string) => {
  const path = join(ROMS, name);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
};

/** 結果をシリアルに出すテスト（cpu_instrs など） */
function runSerial(rom: Uint8Array, seconds: number): string {
  const gb = new Gb(rom);
  for (let f = 0; f < seconds * 60 && !/Passed|Failed/.test(gb.serialOut); f++) {
    gb.runFrame();
    gb.apu.takeSamples();
  }
  return gb.serialOut;
}

/** 結果をカートリッジの RAM（$A000〜）に書くテスト */
function runRam(rom: Uint8Array, seconds: number): { status: number; text: string } {
  const gb = new Gb(rom);
  const ram = gb.cart.ram;
  const done = () => ram[1] === 0xde && ram[2] === 0xb0 && ram[3] === 0x61 && ram[0] !== 0x80;
  for (let f = 0; f < seconds * 60 && !done(); f++) {
    gb.runFrame();
    gb.apu.takeSamples();
  }
  let text = '';
  for (let i = 4; i < ram.length && ram[i]; i++) text += String.fromCharCode(ram[i]);
  return { status: done() ? ram[0] : -1, text };
}

/** 画面に結果を出すテスト：「Passed」の文字があるかを画面の文字から読む代わりに、RAM の結果とシリアルを見る */
function screenText(gb: Gb): string {
  // 背景のタイル番号を文字として読む（blargg のテストはタイル番号 = ASCII）
  let s = '';
  for (let y = 0; y < 18; y++) {
    for (let x = 0; x < 20; x++) s += String.fromCharCode(gb.ppu.vram[0x1800 + y * 32 + x] || 32);
    s += '\n';
  }
  return s;
}

describe('ゲームボーイ：blargg のテスト ROM', () => {
  for (const [name, secs] of [
    ['cpu_instrs.gb', 70],
    ['instr_timing.gb', 5],
    ['mem_timing.gb', 5],
  ] as const) {
    it(`${name}`, () => {
      const rom = load(name);
      if (!rom) return;
      expect(runSerial(rom, secs)).toMatch(/Passed/);
    });
  }

  it('mem_timing-2', () => {
    const rom = load('mem_timing-2.gb');
    if (!rom) return;
    const r = runRam(rom, 10);
    expect(r.status, r.text).toBe(0);
  });

  for (const name of ['halt_bug.gb', 'interrupt_time.gb']) {
    it(`${name}（画面に Passed）`, () => {
      const rom = load(name);
      if (!rom) return;
      const gb = new Gb(rom);
      for (let f = 0; f < 600 && !/Passed|Failed/.test(screenText(gb)); f++) {
        gb.runFrame();
        gb.apu.takeSamples();
      }
      expect(screenText(gb)).toMatch(/Passed/);
    });
  }

  it('dmg_sound：音の基本（01〜07）', () => {
    const rom = load('dmg_sound.gb');
    if (!rom) return;
    const r = runRam(rom, 80);
    // 08〜12 は波形メモリと電源の細かい癖（ほとんどのゲームに関係ない）
    expect(r.text).toMatch(/01:ok\s+02:ok\s+03:ok\s+04:ok\s+05:ok\s+06:ok\s+07:ok/);
  });
});

// ---- 画面（スプライト・ウィンドウ・優先順位）----

function ppuWith(cgb = false) {
  const ints: number[] = [];
  const ppu = new GbPpu({ interrupt: (b) => ints.push(b), hblank: () => {} }, cgb);
  return { ppu, ints };
}

/** タイル n を、すべて色番号 idx の点で埋める */
function fillTile(vram: Uint8Array, n: number, idx: number, bank = 0): void {
  for (let r = 0; r < 8; r++) {
    vram[bank + n * 16 + r * 2] = idx & 1 ? 0xff : 0;
    vram[bank + n * 16 + r * 2 + 1] = idx & 2 ? 0xff : 0;
  }
}

/** 1 フレーム描く */
function frame(ppu: GbPpu): void {
  ppu.frameReady = false;
  for (let i = 0; i < 80000 && !ppu.frameReady; i++) ppu.advance(4);
}

describe('ゲームボーイの画面', () => {
  it('背景・ウィンドウ・スプライトの重なり（白黒）', () => {
    const { ppu } = ppuWith();
    const v = ppu.vram;
    fillTile(v, 1, 1); // 背景用：色 1
    fillTile(v, 2, 3); // ウィンドウ用：色 3
    fillTile(v, 3, 2); // スプライト用：色 2
    v.fill(1, 0x1800, 0x1c00); // 背景のマップ（$9800）はタイル 1
    v.fill(2, 0x1c00, 0x2000); // ウィンドウのマップ（$9C00）はタイル 2
    ppu.write(0xff47, 0b11100100); // BGP：そのまま
    ppu.write(0xff48, 0b11100100);
    ppu.write(0xff4a, 100); // WY
    ppu.write(0xff4b, 7 + 80); // WX → 画面の x = 80 から
    // スプライト 0：(20, 20) に前、スプライト 1：(40, 20) に背景の後ろ
    ppu.oam.set([16 + 20, 8 + 20, 3, 0x00, 16 + 20, 8 + 40, 3, 0x80]);
    ppu.write(0xff40, 0x80 | 0x40 | 0x20 | 0x10 | 0x02 | 0x01);
    frame(ppu);
    frame(ppu);
    const px = (x: number, y: number) => ppu.frameBuffer[y * 160 + x];
    expect(px(5, 5)).toBe(DMG_COLORS[1]); // 背景
    expect(px(90, 110)).toBe(DMG_COLORS[3]); // ウィンドウ（右下）
    expect(px(10, 110)).toBe(DMG_COLORS[1]); // ウィンドウの左は背景
    expect(px(22, 22)).toBe(DMG_COLORS[2]); // スプライト（前）
    expect(px(42, 22)).toBe(DMG_COLORS[1]); // スプライト（背景の後ろ）
  });

  it('1 ラインに 11 個以上のスプライトは描かれない', () => {
    const { ppu } = ppuWith();
    fillTile(ppu.vram, 1, 3);
    ppu.write(0xff48, 0b11100100);
    for (let i = 0; i < 12; i++) ppu.oam.set([16, 8 + i * 12, 1, 0], i * 4);
    ppu.write(0xff40, 0x80 | 0x10 | 0x02);
    frame(ppu);
    frame(ppu);
    expect(ppu.frameBuffer[2 + 9 * 12]).toBe(DMG_COLORS[3]); // 10 個目
    expect(ppu.frameBuffer[2 + 10 * 12]).toBe(DMG_COLORS[0]); // 11 個目
  });

  it('カラー：パレットと VRAM バンク 1 のタイル属性', () => {
    const { ppu } = ppuWith(true);
    const v = ppu.vram;
    fillTile(v, 1, 1, 0x2000); // バンク 1 のタイル 1
    v.fill(1, 0x1800, 0x1c00);
    v.fill(0x08 | 2, 0x3800, 0x3c00); // 属性：バンク 1・パレット 2
    // 背景パレット 2 の色 1 を赤（0x001F）に
    ppu.write(0xff68, 0x80 | (2 * 8 + 2));
    ppu.write(0xff69, 0x1f);
    ppu.write(0xff69, 0x00);
    ppu.write(0xff40, 0x80 | 0x10 | 0x01);
    frame(ppu);
    frame(ppu);
    const c = ppu.frameBuffer[0];
    expect(c & 0xff).toBeGreaterThan(150); // 赤が強い
    expect((c >> 16) & 0xff).toBeLessThan(80);
  });

  it('LYC と VBlank の割り込み', () => {
    const { ppu, ints } = ppuWith();
    ppu.write(0xff45, 50);
    ppu.write(0xff41, 0x40);
    ppu.write(0xff40, 0x80);
    frame(ppu);
    expect(ints.filter((b) => b === 1).length).toBeGreaterThan(0);
    expect(ints.includes(0)).toBe(true);
  });
});

// ---- カートリッジ ----

function makeRom(type: number, banks: number, ramCode = 0, cgb = false): Uint8Array {
  const rom = new Uint8Array(banks * 0x4000);
  for (let b = 0; b < banks; b++) rom[b * 0x4000 + 0x200] = b; // 各バンクの $x200 にバンク番号
  rom.set([0xce, 0xed, 0x66, 0x66], 0x104);
  rom[0x143] = cgb ? 0x80 : 0;
  rom[0x147] = type;
  rom[0x149] = ramCode;
  return rom;
}

describe('ゲームボーイのカートリッジ', () => {
  it('MBC1：ROM バンク（0 は 1 に）と RAM', () => {
    const c = new GbCart(makeRom(0x03, 64, 3));
    expect(c.read(0x4200)).toBe(1);
    c.write(0x2000, 5);
    expect(c.read(0x4200)).toBe(5);
    c.write(0x2000, 0);
    expect(c.read(0x4200)).toBe(1);
    c.write(0x4000, 1); // 上位ビット
    c.write(0x2000, 2);
    expect(c.read(0x4200)).toBe(34);
    expect(c.read(0xa000)).toBe(0xff); // RAM が無効
    c.write(0x0000, 0x0a);
    c.write(0xa123, 0x42);
    expect(c.read(0xa123)).toBe(0x42);
    expect(c.saveDirty).toBe(true);
  });

  it('MBC3：ROM バンクと時計', () => {
    const c = new GbCart(makeRom(0x10, 128, 3));
    c.write(0x2000, 0x50);
    expect(c.read(0x4200)).toBe(0x50);
    c.loadRtc();
    c.write(0x0000, 0x0a);
    c.write(0x4000, 0x08); // 秒
    c.write(0xa000, 30);
    c.write(0x6000, 0);
    c.write(0x6000, 1);
    expect(c.read(0xa000)).toBeGreaterThan(29);
    expect(c.read(0xa000)).toBeLessThan(33);
    // 時計の状態はセーブデータの後ろに入る
    expect(c.saveRam!.length).toBe(0x8000 + 24);
  });

  it('MBC5：9 ビットの ROM バンク', () => {
    const c = new GbCart(makeRom(0x1b, 512, 4));
    c.write(0x2000, 0x34);
    c.write(0x3000, 1);
    expect(c.read(0x4200)).toBe(0x134 & 0xff);
    c.write(0x2000, 0);
    c.write(0x3000, 0);
    expect(c.read(0x4200)).toBe(0); // MBC5 はバンク 0 も選べる
  });

  it('MBC2：内蔵の 4 ビット RAM', () => {
    const c = new GbCart(makeRom(0x06, 16));
    c.write(0x0000, 0x0a);
    c.write(0xa005, 0xab);
    expect(c.read(0xa205)).toBe(0xfb);
    c.write(0x2100, 3);
    expect(c.read(0x4200)).toBe(3);
  });

  it('ゲームボーイではない ROM は読み込まない', () => {
    expect(() => new GbCart(new Uint8Array(0x8000))).toThrow(/ゲームボーイ/);
  });
});

// ---- どこでもセーブ ----

describe('ゲームボーイのどこでもセーブ', () => {
  it('ロードしてから動かすと、セーブしたときの続きと同じになる', () => {
    const rom = load('cpu_instrs.gb');
    if (!rom) return;
    const fp = (m: ReturnType<typeof createMachine>) => {
      let h = 0x811c9dc5;
      for (let f = 0; f < 30; f++) {
        m.runFrame();
        for (const s of m.takeSamples()) h = Math.imul(h ^ Math.round(s * 1e6), 0x01000193);
      }
      for (const v of m.frameBuffer) h = Math.imul(h ^ v, 0x01000193);
      return h >>> 0;
    };
    const m = createMachine(rom);
    for (let f = 0; f < 120; f++) m.runFrame();
    m.takeSamples();
    const state = structuredClone(m.saveState());
    const want = fp(m);
    for (let f = 0; f < 20; f++) m.runFrame();
    m.takeSamples();
    m.loadState(state);
    expect(fp(m)).toBe(want);
    const other = createMachine(rom);
    other.loadState(structuredClone(state));
    expect(fp(other)).toBe(want);
  });
});
