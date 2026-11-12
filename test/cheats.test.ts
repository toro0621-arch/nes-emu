// 改造コード：いろいろな形式を読めるか、毎フレームの書き込みと条件
import { describe, expect, it } from 'vitest';
import { CheatRunner, parseCheat, type RomPatch } from '../src/cheats';

describe('改造コード', () => {
  it('ファミコンのゲームジーニー', () => {
    expect(parseCheat('nes', 'SXIOPO')).toEqual([{ kind: 'rom', addr: 0x91d9, val: 0xad, cmp: -1 }]);
    expect(parseCheat('nes', 'aeuzzgea')).toEqual([{ kind: 'rom', addr: 0xa4b2, val: 0x00, cmp: 0x80 }]);
  });
  it('ゲームボーイのゲームジーニーとゲームシャーク', () => {
    expect(parseCheat('gb', '00A-17B-C49')).toEqual([{ kind: 'rom', addr: 0x4a17, val: 0x00, cmp: 0xc8 }]);
    expect(parseCheat('gb', '010FA0C1')).toEqual([{ kind: 'write', addr: 0xc1a0, val: 0x0f, size: 1 }]);
  });
  it('スーパーファミコンのプロアクションリプレイとゲームジーニー', () => {
    expect(parseCheat('snes', '7E0DBF63')).toEqual([{ kind: 'write', addr: 0x7e0dbf, val: 0x63, size: 1 }]);
    expect(parseCheat('snes', 'C2B4-D4A7')[0].kind).toBe('rom');
  });
  it('プレイステーション（全角でも）と GBA', () => {
    expect(parseCheat('psx', '８００Ａ１２３４　０３Ｅ７')).toEqual([{ kind: 'write', addr: 0x800a1234, val: 0x3e7, size: 2 }]);
    expect(parseCheat('gba', '32000000 00FF')).toEqual([{ kind: 'write', addr: 0x2000000, val: 0xff, size: 1 }]);
  });
  it('読めないコードは断る', () => {
    expect(() => parseCheat('nes', 'XYZ123')).toThrow();
  });
  it('毎フレーム書き込む・条件つき（プレイステーションの D0）', () => {
    const mem = new Map<number, number>();
    let patches: RomPatch[] = [];
    const t = {
      poke: (a: number, v: number) => void mem.set(a, v),
      peek: (a: number) => mem.get(a) ?? 0,
      setRomPatches: (p: RomPatch[]) => void (patches = p),
    };
    const r = new CheatRunner();
    r.set('psx', [{ name: '', code: 'D0000010 0001\n80000020 1234', on: true }], t);
    r.apply(t);
    expect(mem.has(0x80000020)).toBe(false);
    mem.set(0x80000010, 1);
    r.apply(t);
    expect(mem.get(0x80000020)).toBe(0x34);
    expect(mem.get(0x80000021)).toBe(0x12);
    r.set('nes', [{ name: '', code: 'SXIOPO', on: true }], t);
    expect(patches).toEqual([{ addr: 0x91d9, val: 0xad, cmp: -1 }]);
  });
});
