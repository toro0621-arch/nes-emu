// スーパーファミコン：手で組み立てた小さなプログラムと、テスト ROM（あれば）で確かめる
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUTTON } from '../src/controller';
import { createMachine, detectSystem } from '../src/machine';
import { Snes } from '../src/snes/snes';

/** LoROM 32K バイト。$8000 から実行する */
function makeRom(code: number[], type = 0x00, sram = 0): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom.set(code, 0);
  const h = 0x7fc0;
  const title = 'TEST PROGRAM';
  for (let i = 0; i < 21; i++) rom[h + i] = i < title.length ? title.charCodeAt(i) : 0x20;
  rom[h + 0x15] = 0x20; // LoROM
  rom[h + 0x16] = type;
  rom[h + 0x17] = 0x08;
  rom[h + 0x18] = sram;
  rom[h + 0x1c] = 0x00; // チェックサムの補数
  rom[h + 0x1d] = 0x00;
  rom[h + 0x1e] = 0xff;
  rom[h + 0x1f] = 0xff;
  rom[0x7ffc] = 0x00; // リセットのベクタ = $8000
  rom[0x7ffd] = 0x80;
  return rom;
}

/** 背景色を赤にして画面をつけ、コントローラーを自動で読んで WRAM の $0000〜$0001 に写し続ける */
const PROGRAM = [
  0x78, //             sei
  0xa9, 0x00, //       lda #0
  0x8d, 0x21, 0x21, // sta $2121（CGRAM の 0 番）
  0xa9, 0x1f, //       lda #$1F（赤）
  0x8d, 0x22, 0x21, // sta $2122
  0xa9, 0x00, //       lda #0
  0x8d, 0x22, 0x21, // sta $2122
  0xa9, 0x0f, //       lda #$0F（明るさ 15、画面をつける）
  0x8d, 0x00, 0x21, // sta $2100
  0xa9, 0x01, //       lda #1（コントローラーを自動で読む）
  0x8d, 0x00, 0x42, // sta $4200
  0xad, 0x18, 0x42, // loop: lda $4218
  0x8d, 0x00, 0x00, // sta $0000
  0xad, 0x19, 0x42, // lda $4219
  0x8d, 0x01, 0x00, // sta $0001
  0x80, 0xf2, //       bra loop
];

function hash(a: Uint32Array): number {
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + a[i]) | 0;
  return h;
}

describe('スーパーファミコン', () => {
  it('ヘッダーと拡張子で本体を見分ける', () => {
    expect(detectSystem(makeRom(PROGRAM), 'x.sfc')).toBe('snes');
    expect(detectSystem(makeRom(PROGRAM), 'x.bin')).toBe('snes');
    expect(createMachine(makeRom(PROGRAM), 'x.sfc').system).toBe('snes');
  });

  it('背景色と、A・B・X・Y・L・R を含むボタン', () => {
    const m = createMachine(makeRom(PROGRAM), 'x.sfc');
    m.runFrame();
    m.runFrame();
    expect(m.frameBuffer[0] >>> 0, '背景が赤').toBe(0xff0000ff);
    const snes = (m as unknown as { snes: Snes }).snes;
    m.setButtons(BUTTON.A | BUTTON.X | BUTTON.L | BUTTON.R | BUTTON.B | BUTTON.Y | BUTTON.START | BUTTON.UP);
    m.runFrame();
    m.runFrame();
    // $4218：A X L R が上位 4 ビット、$4219：B Y SELECT START ↑ ↓ ← →
    expect(snes.read(0x7e0000)).toBe(0xf0);
    expect(snes.read(0x7e0001)).toBe(0x80 | 0x40 | 0x10 | 0x08);
    m.setButtons(BUTTON.DOWN | BUTTON.SELECT);
    m.runFrame();
    m.runFrame();
    expect(snes.read(0x7e0000)).toBe(0);
    expect(snes.read(0x7e0001)).toBe(0x20 | 0x04);
  });

  it('どこでもセーブで同じ続きになる', () => {
    const m = createMachine(makeRom(PROGRAM), 'x.sfc');
    for (let i = 0; i < 3; i++) m.runFrame();
    const st = m.saveState();
    m.setButtons(BUTTON.Y);
    for (let i = 0; i < 3; i++) m.runFrame();
    const snes = () => (m as unknown as { snes: Snes }).snes;
    const after = snes().read(0x7e0001);
    m.loadState(st);
    expect(snes().read(0x7e0001)).toBe(0);
    m.setButtons(BUTTON.Y); // アプリは毎フレームボタンを伝え直す
    for (let i = 0; i < 3; i++) m.runFrame();
    expect(snes().read(0x7e0001)).toBe(after);
  });

  it('SRAM のあるカートリッジ（$70:0000〜）', () => {
    const code = [0xa9, 0x5a, 0x8f, 0x34, 0x12, 0x70, 0x80, 0xfe]; // lda #$5A; sta $701234; bra *
    const m = createMachine(makeRom(code, 0x02, 0x03), 'x.sfc');
    m.runFrame();
    expect(m.saveRam?.length).toBe(8192);
    expect(m.saveRam?.[0x1234]).toBe(0x5a);
    expect(m.saveDirty).toBe(true);
  });

  it('追加チップが要るソフトは分かりやすく断る', () => {
    expect(() => createMachine(makeRom(PROGRAM, 0x15), 'fx.sfc')).toThrow(/スーパーFX/);
  });

  // テスト ROM（npm run fetch-test-roms で test/roms/snes/ に入る）
  const romDir = join(__dirname, 'roms', 'snes');
  const load = (n: string) => {
    const p = join(romDir, n);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  };

  it('PeterLemon さんの CPU・SPC700 のテストがすべて PASS の画面になる', () => {
    // 結果の画面（すべて PASS と出たもの）を写し取った値と比べる
    for (const n of ['CPUADC.sfc', 'CPUSBC.sfc', 'CPUMOV.sfc', 'CPUPSR.sfc', 'SPC700ADC.sfc', 'SPC700SBC.sfc']) {
      const rom = load(n);
      if (!rom) continue;
      const s = new Snes(rom);
      for (let i = 0; i < 120; i++) s.runFrame();
      expect(hash(s.ppu.frameBuffer), n).toBe(HASHES[n]);
    }
  });

  it('BRR の音を鳴らす（SPC700 へプログラムを送って DSP で鳴らす）', () => {
    const rom = load('PlayBRRSample.sfc');
    if (!rom) return;
    const s = new Snes(rom);
    let peak = 0;
    let count = 0;
    for (let i = 0; i < 120; i++) {
      s.runFrame();
      const smp = s.apu.takeSamples();
      count += smp.length;
      for (const v of smp) peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0.1);
    // 1 秒あたり 48000 サンプルくらい（120 フレーム ≒ 2 秒）
    expect(count).toBeGreaterThan(95000);
    expect(count).toBeLessThan(97000);
  });

  it('モード 7 と HDMA（遠近の床）', () => {
    const rom = load('Perspective.sfc');
    if (!rom) return;
    const s = new Snes(rom);
    for (let i = 0; i < 30; i++) s.runFrame();
    expect(hash(s.ppu.frameBuffer)).toBe(HASHES['Perspective.sfc']);
  });
});

/** すべて PASS と出た画面（と、お手本どおりのモード 7 の画面）の値 */
const HASHES: Record<string, number> = {
  'CPUADC.sfc': 1551483701,
  'CPUSBC.sfc': -1692454513,
  'CPUMOV.sfc': 1907828407,
  'CPUPSR.sfc': 204210635,
  'SPC700ADC.sfc': -1899510778,
  'SPC700SBC.sfc': -1498743866,
  'Perspective.sfc': -2846049,
};
