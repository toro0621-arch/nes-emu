// NINTENDO64：ROM の並べ直し、PeterLemon さんのテスト（CPU・RSP・RDP）、どこでもセーブ
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMachine, detectSystem } from '../src/machine';
import { N64, isN64Rom, normalizeRom } from '../src/n64/n64';

const ROMS = join(__dirname, 'roms', 'n64');

describe('NINTENDO64', () => {
  it('ROM の 3 つの形式（.z64・.v64・.n64）を同じ並びにそろえる', () => {
    const z = new Uint8Array(0x1000);
    z.set([0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4]);
    const v = new Uint8Array(0x1000);
    v.set([0x37, 0x80, 0x40, 0x12, 2, 1, 4, 3]);
    const n = new Uint8Array(0x1000);
    n.set([0x40, 0x12, 0x37, 0x80, 4, 3, 2, 1]);
    expect(isN64Rom(z) && isN64Rom(v) && isN64Rom(n)).toBe(true);
    expect(Array.from(normalizeRom(z).subarray(0, 8))).toEqual(Array.from(n.subarray(0, 8)));
    expect(Array.from(normalizeRom(v).subarray(0, 8))).toEqual(Array.from(n.subarray(0, 8)));
    expect(detectSystem(z, 'game.z64')).toBe('n64');
  });

  it('CPU と RSP のテストが PASS の画面になる（npm run fetch-test-roms で test/roms/n64/ に入る）', () => {
    if (!existsSync(ROMS)) return;
    for (const f of readdirSync(ROMS).filter((x) => /^(CPU|RSPCP2)/.test(x))) {
      const n = new N64(new Uint8Array(readFileSync(join(ROMS, f))));
      for (let i = 0; i < 40; i++) n.runFrame();
      n.render();
      // PASS は緑の札、FAIL は赤い札（左はしと見出しの赤い字は除く）
      let green = 0;
      let red = 0;
      for (let y = 20; y < n.outH; y++)
        for (let x = 200; x < n.outW; x++) {
          const c = n.frameBuffer[y * n.outW + x];
          const r = c & 0xff;
          const g = (c >> 8) & 0xff;
          const b = (c >> 16) & 0xff;
          if (g > 100 && r < 60 && b < 60) green++;
          if (r > 150 && g < 60 && b < 60) red++;
        }
      expect(green, f).toBeGreaterThan(200);
      expect(red, f).toBe(0);
    }
  });

  it('3D のデモが描かれ、どこでもセーブで同じ続きになる', () => {
    const p = join(ROMS, 'N64NICCC.N64');
    if (!existsSync(p)) return;
    const m = createMachine(new Uint8Array(readFileSync(p)), 'N64NICCC.N64');
    for (let i = 0; i < 90; i++) m.runFrame();
    const colors = new Set(m.frameBuffer);
    expect(colors.size).toBeGreaterThan(4);
    const st = m.saveState();
    for (let i = 0; i < 20; i++) m.runFrame();
    const a = m.frameBuffer.slice();
    m.loadState(st);
    for (let i = 0; i < 20; i++) m.runFrame();
    expect(m.frameBuffer).toEqual(a);
  });
});
