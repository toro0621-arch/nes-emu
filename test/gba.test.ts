// ゲームボーイアドバンス：手で組み立てた小さなプログラムと、テスト ROM（あれば）で確かめる
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUTTON } from '../src/controller';
import { Gba } from '../src/gba/gba';
import { GbaSave, detectSaveType } from '../src/gba/save';
import { createMachine, detectSystem } from '../src/machine';

/** ARM の命令（32 ビット）を並べた ROM。0xC0 から実行する */
function makeRom(code: number[], extra = ''): Uint8Array {
  const rom = new Uint8Array(0x400);
  const dv = new DataView(rom.buffer);
  dv.setUint32(0, 0xea00002e, true); // b 0xC0（ヘッダーを飛ばす）
  rom.set([0x24, 0xff, 0xae, 0x51], 4); // 任天堂のロゴの先頭
  rom[0xb2] = 0x96;
  code.forEach((op, i) => dv.setUint32(0xc0 + i * 4, op >>> 0, true));
  for (let i = 0; i < extra.length; i++) rom[0x300 + i] = extra.charCodeAt(i);
  return rom;
}

/** モード 3 で左上に赤い点を描き、KEYINPUT を IWRAM の先頭に写し続ける */
const PROGRAM = [
  0xe3a00301, // mov r0, #0x04000000
  0xe3a01003, // mov r1, #3
  0xe3811b01, // orr r1, r1, #0x400（モード 3 + BG2）
  0xe1c010b0, // strh r1, [r0]
  0xe3a02406, // mov r2, #0x06000000
  0xe3a0301f, // mov r3, #0x1f（赤）
  0xe1c230b0, // strh r3, [r2]
  0xe3a05403, // mov r5, #0x03000000
  0xe2806c01, // add r6, r0, #0x100
  0xe1d643b0, // ldrh r4, [r6, #0x30]
  0xe5854000, // str r4, [r5]
  0xeafffffc, // b（ldrh へ）
];

function hash(a: Uint32Array): number {
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + a[i]) | 0;
  return h;
}

describe('GBA', () => {
  it('ヘッダーで本体を見分ける', () => {
    expect(detectSystem(makeRom(PROGRAM), 'x.gba')).toBe('gba');
    expect(createMachine(makeRom(PROGRAM)).system).toBe('gba');
  });

  it('モード 3 の画面とボタン（L・R を含む）', () => {
    const m = createMachine(makeRom(PROGRAM));
    m.runFrame();
    m.runFrame();
    expect(m.frameBuffer[0] >>> 0, '左上が赤').toBe(0xff0000ff);
    expect(m.frameBuffer[1] >>> 0, 'となりは黒').toBe(0xff000000);
    const gba = (m as unknown as { gba: Gba }).gba;
    expect(gba.read32(0x03000000) & 0x3ff, '何も押していない').toBe(0x3ff);
    m.setButtons(BUTTON.A | BUTTON.L | BUTTON.R | BUTTON.UP);
    m.runFrame();
    // 押したボタンは 0 になる：A = bit0、↑ = bit6、R = bit8、L = bit9
    expect(gba.read32(0x03000000) & 0x3ff).toBe(0x3ff & ~(1 | 0x40 | 0x100 | 0x200));
  });

  it('どこでもセーブで同じ続きになる', () => {
    const m = createMachine(makeRom(PROGRAM));
    for (let i = 0; i < 5; i++) m.runFrame();
    const st = m.saveState();
    m.setButtons(BUTTON.B);
    for (let i = 0; i < 3; i++) m.runFrame();
    const after = hash(m.frameBuffer);
    const gba = (m as unknown as { gba: Gba }).gba;
    const keyAfter = gba.read32(0x03000000);
    m.loadState(st);
    m.setButtons(0);
    m.setButtons(BUTTON.B);
    for (let i = 0; i < 3; i++) m.runFrame();
    expect(hash(m.frameBuffer)).toBe(after);
    expect((m as unknown as { gba: Gba }).gba.read32(0x03000000)).toBe(keyAfter);
    // 別の大きさの ROM のセーブは読み込まない
    const other = createMachine(makeRom([...PROGRAM, 0]).slice(0, 0x300));
    expect(() => other.loadState(st)).toThrow();
  });

  it('セーブの種類を ROM の印で見分ける', () => {
    expect(detectSaveType(makeRom(PROGRAM, 'FLASH1M_V103'))).toBe('flash128');
    expect(detectSaveType(makeRom(PROGRAM, 'FLASH_V126'))).toBe('flash64');
    expect(detectSaveType(makeRom(PROGRAM, 'EEPROM_V124'))).toBe('eeprom');
    expect(detectSaveType(makeRom(PROGRAM))).toBe('sram');
  });

  it('EEPROM の読み書き（512 バイト）', () => {
    const s = new GbaSave('eeprom');
    const bits = (v: number, n: number) => {
      for (let i = n - 1; i >= 0; i--) s.eepromWrite((v / 2 ** i) & 1);
    };
    s.eepromHint(73);
    bits(2, 2); // 書き込み
    bits(5, 6); // アドレス 5
    const data = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0];
    for (const b of data) bits(b, 8);
    bits(0, 1);
    expect(s.dirty).toBe(true);
    expect(Array.from(s.data.subarray(40, 48))).toEqual(data);
    s.eepromHint(9);
    bits(3, 2); // 読み出し
    bits(5, 6);
    bits(0, 1);
    const out: number[] = [];
    for (let i = 0; i < 68; i++) out.push(s.eepromRead());
    expect(out.slice(0, 4)).toEqual([0, 0, 0, 0]);
    const bytes = [];
    for (let i = 0; i < 8; i++) bytes.push(out.slice(4 + i * 8, 12 + i * 8).reduce((a, b) => (a << 1) | b, 0));
    expect(bytes).toEqual(data);
    expect(s.eepromRead(), '読み終わったら 1（準備完了）').toBe(1);
  });

  // テスト ROM（npm run fetch-test-roms で test/roms/gba/ に入る）
  const romDir = join(__dirname, 'roms', 'gba');
  const load = (n: string) => {
    const p = join(romDir, n);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  };
  const run = (rom: Uint8Array, frames: number) => {
    const g = new Gba(rom);
    for (let i = 0; i < frames; i++) g.runFrame();
    return g;
  };

  it('jsmolka/gba-tests：ARM・Thumb・メモリ・セーブ（SRAM・フラッシュ）', () => {
    let passed: number | null = null;
    for (const n of ['arm.gba', 'thumb.gba', 'memory.gba', 'save-sram.gba', 'save-flash64.gba', 'save-flash128.gba']) {
      const rom = load(n);
      if (!rom) continue;
      // フラッシュのテストは 64K バイトを 1 バイトずつ書くので時間がかかる
      const g = run(rom, n.includes('flash') ? 200 : 30);
      // 失敗するとテストの番号が r12 に入り、画面にも出る
      expect(g.cpu.r[12], n).toBe(0);
      const h = hash(g.ppu.frameBuffer);
      // どれも同じ「All tests passed」の画面になる
      if (passed === null) passed = h;
      expect(h, n).toBe(passed);
    }
  });

  it('FuzzARM：ランダムな 1 万個の命令が実機と同じ結果になる', () => {
    const rom = load('FuzzARM.gba');
    if (!rom) return;
    const g = run(rom, 900);
    // 「End of testing」だけが左上に出る（失敗すると命令とレジスタの値が並ぶ）
    const fb = g.ppu.frameBuffer;
    let lit = 0;
    let lowest = 0;
    for (let i = 0; i < fb.length; i++) {
      if ((fb[i] & 0xffffff) !== 0) {
        lit++;
        lowest = Math.floor(i / 240);
      }
    }
    expect(lit).toBeGreaterThan(50);
    expect(lowest, '1 行目だけ').toBeLessThan(10);
  });
});
