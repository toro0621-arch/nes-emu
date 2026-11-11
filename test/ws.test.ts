// ワンダースワン：小さなテスト用プログラムを組み立てて動かし、画面・割り込み・ボタン・セーブを確かめる
import { describe, expect, it } from 'vitest';
import { createMachine, detectSystem } from '../src/machine';
import { WsDisplay } from '../src/ws/display';
import { V30MZ } from '../src/ws/cpu';
import { Ws, WsEeprom } from '../src/ws/ws';

/**
 * ROM（64KB）を作る。code は F000:0000 から置き、リセットで飛ぶ。
 * flags：ヘッダーの各値
 */
function makeRom(code: number[], opt: { color?: boolean; vertical?: boolean; save?: number } = {}): Uint8Array {
  const rom = new Uint8Array(0x10000);
  rom.set(code, 0);
  const f = 0x10000 - 16;
  rom.set([0xea, 0x00, 0x00, 0x00, 0xf0], f); // JMP F000:0000
  rom[f + 7] = opt.color ? 1 : 0;
  rom[f + 11] = opt.save ?? 0;
  rom[f + 12] = opt.vertical ? 1 : 0;
  return rom;
}

/** 画面に 1 枚のタイル（黒）を出し、VBlank 割り込みで $0100 を数え、ボタンを $0102 に写すプログラム */
function program(): number[] {
  const c: number[] = [];
  const out = (port: number, v: number) => c.push(0xb0, v, 0xe6, port); // mov al,v / out port,al
  c.push(0xfa); // cli
  c.push(0x31, 0xc0, 0x8e, 0xd8, 0x8e, 0xc0, 0x8e, 0xd0); // xor ax,ax / mov ds,ax / mov es,ax / mov ss,ax
  c.push(0xbc, 0x00, 0x20); // mov sp,2000h
  out(0x1c, 0xf0); // プール 0 = 白、1 = 黒
  out(0x20, 0x10); // パレット 0：色 0 → プール 0、色 1 → プール 1
  out(0x21, 0x11);
  c.push(0xb9, 0x08, 0x00, 0xbf, 0x10, 0x20, 0xb8, 0xff, 0x00, 0xf3, 0xab); // タイル 1 を色 1 で埋める
  c.push(0xc7, 0x06, 0x00, 0x08, 0x01, 0x00); // mov word [0800h],1（マップの左上 = タイル 1）
  out(0x07, 0x01); // SCR1 のマップは $0800
  out(0x00, 0x01); // SCR1 を表示
  const fix = c.length + 4;
  c.push(0xc7, 0x06, 0x98, 0x00, 0x00, 0x00); // mov word [98h], handler（あとで埋める）
  c.push(0xc7, 0x06, 0x9a, 0x00, 0x00, 0xf0); // mov word [9Ah], F000h
  out(0xb0, 0x20); // 割り込みの番号は 20h から（VBlank = 26h）
  out(0xb2, 0x40); // VBlank 割り込みを有効に
  c.push(0xfb); // sti
  const loop = c.length;
  c.push(0xf4); // hlt
  c.push(0xb0, 0x20, 0xe6, 0xb5, 0xe4, 0xb5, 0xa2, 0x02, 0x01); // X のボタンを読んで [0102h] へ
  c.push(0xeb, (loop - (c.length + 2)) & 0xff); // jmp loop
  const handler = c.length;
  c[fix] = handler & 0xff;
  c[fix + 1] = handler >> 8;
  c.push(0xff, 0x06, 0x00, 0x01); // inc word [0100h]
  c.push(0xb0, 0x40, 0xe6, 0xb6); // 割り込みを受け付けたと知らせる
  c.push(0xcf); // iret
  return c;
}

describe('ワンダースワン', () => {
  it('ROM を見分ける', () => {
    expect(detectSystem(makeRom([0x90]))).toBe('ws');
    expect(detectSystem(new Uint8Array(0x10000), 'game.wsc')).toBe('ws');
  });

  it('テスト用プログラム：VBlank 割り込み・画面・ボタン', () => {
    const m = createMachine(makeRom(program()));
    expect(m.width).toBe(224);
    expect(m.fps).toBeGreaterThan(75);
    for (let f = 0; f < 10; f++) m.runFrame();
    const ws = (m as unknown as { ws: Ws }).ws;
    const count = ws.ram[0x100] | (ws.ram[0x101] << 8);
    expect(count).toBeGreaterThan(8);
    expect(count).toBeLessThan(12);
    // 左上の 8×8 は黒、その右は白
    const black = m.frameBuffer[2 * 224 + 2];
    const white = m.frameBuffer[2 * 224 + 12];
    expect(black & 0xff).toBeLessThan(40);
    expect(white & 0xff).toBeGreaterThan(200);
    // → を押すと X2（bit1）が読める
    m.setButtons(0x80);
    m.runFrame();
    m.runFrame();
    expect(ws.ram[0x102] & 0x0f).toBe(0x02);
  });

  it('縦持ちのソフトは画面を回し、十字キーを Y ボタンに', () => {
    const m = createMachine(makeRom(program(), { vertical: true }));
    expect(m.width).toBe(144);
    expect(m.height).toBe(224);
    for (let f = 0; f < 3; f++) m.runFrame();
    // 元の画面の左上（黒）は、回した画面の左下に来る
    expect(m.frameBuffer[223 * 144 + 2] & 0xff).toBeLessThan(40);
    expect(m.frameBuffer[2] & 0xff).toBeGreaterThan(200);
  });

  it('どこでもセーブ', () => {
    const rom = makeRom(program());
    const m = createMachine(rom);
    for (let f = 0; f < 5; f++) m.runFrame();
    const st = structuredClone(m.saveState());
    for (let f = 0; f < 7; f++) m.runFrame();
    const other = createMachine(rom);
    other.loadState(st);
    const ws = (other as unknown as { ws: Ws }).ws;
    expect(ws.ram[0x100]).toBeGreaterThan(3);
    expect(ws.ram[0x100]).toBeLessThan(7);
    other.runFrame();
  });

  it('SRAM のセーブ（$10000〜）', () => {
    const code = [0xb8, 0x00, 0x10, 0x8e, 0xd8, 0xc6, 0x06, 0x34, 0x12, 0x5a, 0xf4]; // mov ax,1000h / mov ds,ax / mov byte [1234h],5Ah / hlt
    const m = createMachine(makeRom(code, { save: 0x02 }));
    m.runFrame();
    expect(m.saveRam!.length).toBe(0x8000);
    expect(m.saveRam![0x1234]).toBe(0x5a);
    expect(m.saveDirty).toBe(true);
  });
});

describe('ワンダースワンの EEPROM', () => {
  it('書き込みと読み出し（16Kbit = 10 ビットのアドレス）', () => {
    const e = new WsEeprom(2048);
    const cmd = (op: number, addr: number) => {
      const c = (1 << 12) | (op << 10) | addr;
      e.write(2, c & 0xff);
      e.write(3, c >> 8);
    };
    cmd(0, 0x300); // EWEN
    e.write(4, 0x40);
    e.write(0, 0x34);
    e.write(1, 0x12);
    cmd(1, 5); // WRITE
    e.write(4, 0x20);
    e.write(0, 0);
    e.write(1, 0);
    cmd(2, 5); // READ
    e.write(4, 0x10);
    expect(e.read(0) | (e.read(1) << 8)).toBe(0x1234);
    expect(e.data[10]).toBe(0x34);
  });
});

describe('ワンダースワンの画面', () => {
  it('カラー 4 ビット：スプライトが SCR2 の上、優先度なしは下', () => {
    const ram = new Uint8Array(0x10000);
    const io = new Uint8Array(0x100);
    const d = new WsDisplay(ram, io);
    io[0x60] = 0xc0; // カラー・4 ビット（プレーン）
    io[0x14] = 1;
    // パレット 0 の色 1 = 赤、パレット 8 の色 2 = 青
    ram[0xfe00 + 2] = 0x00;
    ram[0xfe00 + 3] = 0x0f;
    ram[0xfe00 + 8 * 32 + 4] = 0x0f;
    ram[0xfe00 + 8 * 32 + 5] = 0x00;
    // タイル 1 = 色 1、タイル 2 = 色 2
    for (let y = 0; y < 8; y++) {
      ram[0x4000 + 32 + y * 4] = 0xff;
      ram[0x4000 + 64 + y * 4 + 1] = 0xff;
    }
    // SCR2 のマップ（$1000）全体をタイル 1 に
    for (let i = 0; i < 1024; i++) ram[0x1000 + i * 2] = 1;
    io[0x07] = 0x20;
    io[0x00] = 0x02 | 0x04; // SCR2 とスプライト
    // スプライト 0：(16, 0) に優先度あり、スプライト 1：(32, 0) に優先度なし
    io[0x04] = 0x30; // スプライトの表は (0x30 << 9) = $6000
    ram.set([0x02, 0x20, 0, 16, 0x02, 0x00, 0, 32], 0x6000);
    io[0x06] = 2;
    d.latchSprites();
    d.renderLine(3);
    const px = (x: number) => d.frameBuffer[3 * 224 + x];
    expect(px(0) & 0xff).toBe(0xff); // 赤（SCR2）
    expect((px(18) >> 16) & 0xff).toBe(0xff); // 青（スプライト・優先度あり）
    expect(px(34) & 0xff).toBe(0xff); // SCR2 の下に隠れる
  });
});

describe('V30MZ', () => {
  it('REP MOVSW と セグメント', () => {
    const mem = new Uint8Array(1 << 20);
    const cpu = new V30MZ({ read8: (a) => mem[a], write8: (a, v) => (mem[a] = v), in8: () => 0, out8: () => {} });
    // mov cx,3 / mov si,10h / mov di,20h / rep movsw / hlt
    mem.set([0xb9, 3, 0, 0xbe, 0x10, 0, 0xbf, 0x20, 0, 0xf3, 0xa5, 0xf4], 0x100);
    mem.set([1, 2, 3, 4, 5, 6], 0x10);
    cpu.s.fill(0);
    cpu.ip = 0x100;
    for (let i = 0; i < 6 && !cpu.halted; i++) cpu.step();
    expect(Array.from(mem.subarray(0x20, 0x26))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cpu.r[1]).toBe(0);
  });
});
