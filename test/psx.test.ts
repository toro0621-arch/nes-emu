// プレイステーション：互換 BIOS（OpenBIOS）で起動し、テストのプログラムと手作りの CD を動かす
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUTTON } from '../src/controller';
import { PsxMachine, detectSystem } from '../src/machine';
import { mulHi } from '../src/psx/cpu';
import { ArraySource, Disc } from '../src/psx/disc';
import { Gte } from '../src/psx/gte';
import { Psx } from '../src/psx/psx';
import { blankCard } from '../src/psx/sio';

const BIOS = new Uint8Array(readFileSync(join(__dirname, '..', 'public', 'psx', 'openbios.bin')));
const ROMS = join(__dirname, 'roms', 'psx');

/** 画面に出ている部分で、緑（PASS の札）と赤い字の FAIL があるか */
function countColors(p: Psx): { green: number } {
  const g = p.gpu;
  g.render();
  let green = 0;
  for (const c of g.frameBuffer) {
    const r = c & 0xff;
    const gg = (c >> 8) & 0xff;
    const b = (c >> 16) & 0xff;
    if (gg > 100 && r < 60 && b < 60) green++;
  }
  return { green };
}

/** ISO9660 の小さな CD（SYSTEM.CNF と MAIN.EXE だけ）を 2352 バイトのセクターで作る */
function makeDisc(exe: Uint8Array): Uint8Array {
  const SEC = 2048;
  const cnf = new TextEncoder().encode('BOOT = cdrom:\\MAIN.EXE;1\r\nTCB = 4\r\nEVENT = 10\r\nSTACK = 801FFFF0\r\n');
  const rootLba = 20;
  const ptLba = 18;
  const cnfLba = 22;
  const exeLba = 24;
  const n = exeLba + Math.ceil(exe.length / SEC) + 4;
  const img = new Uint8Array(n * SEC);
  const both16 = (v: number) => [v & 0xff, v >> 8, v >> 8, v & 0xff];
  const both32 = (v: number) => {
    const le = [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
    return [...le, ...[...le].reverse()];
  };
  const rec = (name: number[], lba: number, size: number, dir: boolean) => {
    let l = 33 + name.length;
    l += l & 1;
    const r = [l, 0, ...both32(lba), ...both32(size), 126, 1, 1, 0, 0, 0, 0, dir ? 2 : 0, 0, 0, ...both16(1), name.length, ...name];
    while (r.length < l) r.push(0);
    return r;
  };
  const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
  const root = [
    ...rec([0], rootLba, SEC, true),
    ...rec([1], rootLba, SEC, true),
    ...rec(str('MAIN.EXE;1'), exeLba, exe.length, false),
    ...rec(str('SYSTEM.CNF;1'), cnfLba, cnf.length, false),
  ];
  img.set(root, rootLba * SEC);
  img.set([1, 0, rootLba & 0xff, rootLba >> 8, 0, 0, 1, 0], ptLba * SEC);
  img.set([1, 0, 0, 0, 0, rootLba, 0, 1], (ptLba + 1) * SEC);
  const pvd = new Uint8Array(SEC);
  pvd.set([1, ...str('CD001'), 1], 0);
  pvd.set(str('PLAYSTATION'.padEnd(32)), 8);
  pvd.set(both32(n), 80);
  pvd.set(both16(1), 120);
  pvd.set(both16(1), 124);
  pvd.set(both16(SEC), 128);
  pvd.set(both32(8), 132);
  pvd.set([ptLba, 0, 0, 0], 140);
  pvd.set([0, 0, 0, ptLba + 1], 148);
  pvd.set(rec([0], rootLba, SEC, true), 156);
  pvd[881] = 1;
  img.set(pvd, 16 * SEC);
  img.set([255, ...str('CD001'), 1], 17 * SEC);
  img.set(cnf, cnfLba * SEC);
  img.set(exe, exeLba * SEC);
  // 2352 バイトのセクター（モード 2 フォーム 1）にする
  const raw = new Uint8Array(n * 2352);
  const bcd = (v: number) => ((v / 10) | 0) * 16 + (v % 10);
  for (let i = 0; i < n; i++) {
    const o = i * 2352;
    const a = i + 150;
    raw.fill(0xff, o + 1, o + 11);
    raw.set([bcd(Math.floor(a / 4500)), bcd(Math.floor(a / 75) % 60), bcd(a % 75), 2, 0, 0, 8, 0, 0, 0, 8, 0], o + 12);
    raw.set(img.subarray(i * SEC, (i + 1) * SEC), o + 24);
  }
  return raw;
}

describe('PlayStation の部品', () => {
  it('32 × 32 の掛け算の上位 32 ビット', () => {
    expect(mulHi(-1, -1, true)).toBe(0);
    expect(mulHi(-1, -1, false)).toBe(-2);
    expect(mulHi(0x7fffffff, 0x7fffffff, true)).toBe(0x3fffffff);
    expect(mulHi(-0x80000000, 1, true)).toBe(-1);
  });

  it('GTE：AVSZ3 と NCLIP', () => {
    const g = new Gte();
    g.writeControl(29, 0x155); // ZSF3
    g.writeData(17, 100);
    g.writeData(18, 200);
    g.writeData(19, 300);
    g.command(0x4b58002d);
    expect(g.readData(7)).toBe(((100 + 200 + 300) * 0x155) >> 12);
    g.writeData(12, 0);
    g.writeData(13, 10);
    g.writeData(14, 10 << 16);
    g.command(0x4b400006);
    expect(g.readData(24)).toBe(100);
  });

  it('空のメモリーカードは "MC" で始まる', () => {
    const c = blankCard();
    expect(c.length).toBe(128 * 1024);
    expect(String.fromCharCode(c[0], c[1])).toBe('MC');
  });

  it('PS-X EXE を見分ける', () => {
    const exe = new Uint8Array(0x900);
    exe.set(Array.from('PS-X EXE', (c) => c.charCodeAt(0)));
    expect(detectSystem(exe, 'test.exe')).toBe('psx');
  });
});

describe('PlayStation のテストプログラム（npm run fetch-test-roms で test/roms/psx/ に入る）', () => {
  it('CPU の命令・GTE のテストがすべて PASS の画面になる', () => {
    if (!existsSync(ROMS)) return;
    for (const f of readdirSync(ROMS).filter((x) => /^(CPU|GTE)/.test(x))) {
      const p = new Psx(BIOS);
      p.loadExe(new Uint8Array(readFileSync(join(ROMS, f))));
      for (let i = 0; i < 40; i++) p.runFrame();
      // PASS の緑の札が出ていて、FAIL の赤い札がない（いちばん上の見出しの行は赤いので除く）
      expect(countColors(p).green, f).toBeGreaterThan(200);
      const g = p.gpu;
      let fail = 0;
      for (let y = 16; y < g.outH; y++)
        for (let x = 280; x < g.outW; x++) {
          const c = g.frameBuffer[y * g.outW + x];
          if ((c & 0xff) > 150 && ((c >> 8) & 0xff) < 60) fail++;
        }
      expect(fail, f).toBe(0);
    }
  });

  it('CD から起動する（手作りの CD に入れた PSXNICCC のデモ）', () => {
    if (!existsSync(join(ROMS, 'PSXNICCC.exe'))) return;
    const exe = new Uint8Array(readFileSync(join(ROMS, 'PSXNICCC.exe')));
    const disc = Disc.fromSingle(new ArraySource(makeDisc(exe)));
    const m = new PsxMachine(BIOS, disc, null, 1);
    for (let i = 0; i < 300; i++) m.runFrame();
    // 何か描かれている
    let lit = 0;
    for (const c of m.frameBuffer) if ((c & 0xffffff) !== 0) lit++;
    expect(lit).toBeGreaterThan(1000);
    expect(m.psx.cdrom.pos).toBeGreaterThan(150 + 24);
    // どこでもセーブ・ロード
    const st = m.saveState();
    for (let i = 0; i < 30; i++) m.runFrame();
    const a = m.frameBuffer.slice();
    m.loadState(st);
    for (let i = 0; i < 30; i++) m.runFrame();
    expect(m.frameBuffer).toEqual(a);
    m.setButtons(BUTTON.A | BUTTON.L2);
    expect(m.psx.sio.buttons).toBe((1 << 13) | (1 << 8));
  });
});
