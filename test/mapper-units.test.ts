// マッパーのバンク切り替えを直接確かめる
import { describe, expect, it } from 'vitest';
import type { Cartridge } from '../src/cartridge';
import { createMapper, type Mapper } from '../src/mappers/mapper';

/** 各 8KB の PRG バンクの先頭にバンク番号、各 1KB の CHR バンクの先頭にバンク番号を入れたカートリッジ */
function cart(mapper: number, prgKb: number, chrKb: number, battery = false): Cartridge {
  const prg = new Uint8Array(prgKb * 1024);
  for (let b = 0; b < prg.length / 0x2000; b++) prg[b * 0x2000] = b;
  const chrRam = chrKb === 0;
  const chr = new Uint8Array(chrRam ? 0x2000 : chrKb * 1024);
  if (!chrRam) for (let b = 0; b < chr.length / 0x400; b++) chr[b * 0x400] = b;
  return { prg, chr, chrRam, mapper, mirroring: 'horizontal', battery };
}

function setup(c: Cartridge) {
  const clock = { cpu: 0, dots: 0, irq: false };
  const m = createMapper(c, { irq: (on) => (clock.irq = on), cpuCycles: () => clock.cpu, ppuDots: () => clock.dots });
  return { m, clock };
}

/** $8000/$A000/$C000/$E000 に見えている 8KB バンク */
const prgBanks = (m: Mapper) => [0x8000, 0xa000, 0xc000, 0xe000].map((a) => m.cpuRead(a));
/** $0000〜$1C00 に見えている 1KB バンク */
const chrBanks = (m: Mapper) => Array.from({ length: 8 }, (_, i) => m.ppuRead(i * 0x400));

describe('マッパー 2（UxROM）', () => {
  it('$8000 に書いた番号の 16KB が $8000 に出て、$C000 は最後のバンクに固定', () => {
    const { m } = setup(cart(2, 128, 0));
    expect(prgBanks(m)).toEqual([0, 1, 14, 15]);
    m.cpuWrite(0x8000, 3);
    expect(prgBanks(m)).toEqual([6, 7, 14, 15]);
    m.cpuWrite(0xffff, 9); // 範囲外は折り返す（8 バンク）
    expect(prgBanks(m)).toEqual([2, 3, 14, 15]);
  });

  it('CHR RAM に書ける', () => {
    const { m } = setup(cart(2, 128, 0));
    m.ppuWrite(0x1234, 0x56);
    expect(m.ppuRead(0x1234)).toBe(0x56);
  });
});

describe('マッパー 1（MMC1）', () => {
  /** 5 回に分けて 1 ビットずつ書く（書き込みは別々の命令なので、サイクルを空ける） */
  function serial(m: Mapper, clock: { cpu: number }, addr: number, value: number) {
    for (let i = 0; i < 5; i++) {
      clock.cpu += 4;
      m.cpuWrite(addr, (value >> i) & 1);
    }
  }

  it('電源投入時は $C000 が最後のバンクに固定', () => {
    const { m } = setup(cart(1, 256, 128));
    expect(prgBanks(m).slice(2)).toEqual([30, 31]);
  });

  it('PRG の 3 つのモード', () => {
    const { m, clock } = setup(cart(1, 256, 128));
    serial(m, clock, 0xe000, 5);
    expect(prgBanks(m)).toEqual([10, 11, 30, 31]); // モード 3：$8000 切り替え
    serial(m, clock, 0x8000, 0b01000); // モード 2：$8000 固定・$C000 切り替え
    expect(prgBanks(m)).toEqual([0, 1, 10, 11]);
    serial(m, clock, 0x8000, 0b00000); // モード 0：32KB 単位（下位ビットは無視）
    expect(prgBanks(m)).toEqual([8, 9, 10, 11]);
  });

  it('CHR の 8KB / 4KB モードとミラーリング', () => {
    const { m, clock } = setup(cart(1, 256, 128));
    serial(m, clock, 0x8000, 0b11110); // CHR 4KB、PRG モード 3、縦ミラー
    expect(m.mirroring()).toBe('vertical');
    serial(m, clock, 0xa000, 3);
    serial(m, clock, 0xc000, 8);
    expect(chrBanks(m)).toEqual([12, 13, 14, 15, 32, 33, 34, 35]);
    serial(m, clock, 0x8000, 0b01111); // CHR 8KB、横ミラー
    expect(m.mirroring()).toBe('horizontal');
    expect(chrBanks(m)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]); // chr0=3 の偶数側（2）から 8KB
  });

  it('bit7 を書くとシフトがリセットされる', () => {
    const { m, clock } = setup(cart(1, 256, 128));
    clock.cpu += 4;
    m.cpuWrite(0xe000, 1);
    clock.cpu += 4;
    m.cpuWrite(0xe000, 0x80);
    serial(m, clock, 0xe000, 2);
    expect(prgBanks(m).slice(0, 2)).toEqual([4, 5]);
  });

  it('続けてのサイクルの 2 回目の書き込み（INC などの読み・変更・書き命令）は無視する', () => {
    const { m, clock } = setup(cart(1, 256, 128));
    clock.cpu += 4;
    m.cpuWrite(0xe000, 1);
    m.cpuWrite(0xe000, 1); // 同じ命令の 2 回目の書き込み → 無視
    for (let i = 1; i < 5; i++) {
      clock.cpu += 4;
      m.cpuWrite(0xe000, 0);
    }
    expect(prgBanks(m).slice(0, 2)).toEqual([2, 3]); // 1 だけが入る
  });

  it('512KB（SUROM）は CHR レジスタの bit4 で後半 256KB を選ぶ', () => {
    const { m, clock } = setup(cart(1, 512, 0));
    serial(m, clock, 0xe000, 1);
    expect(prgBanks(m)).toEqual([2, 3, 30, 31]);
    serial(m, clock, 0xa000, 0x10);
    expect(prgBanks(m)).toEqual([34, 35, 62, 63]);
  });

  it('バッテリー付きなら $6000-$7FFF が保存対象になる', () => {
    const { m } = setup(cart(1, 256, 0, true));
    expect(m.saveDirty).toBe(false);
    m.cpuWrite(0x6010, 0x42);
    expect(m.saveRam?.[0x10]).toBe(0x42);
    expect(m.saveDirty).toBe(true);
    expect(setup(cart(1, 256, 0, false)).m.saveRam).toBeNull();
  });
});

describe('マッパー 4（MMC3）', () => {
  it('PRG：R6・R7 と、bit6 での入れ替え', () => {
    const { m } = setup(cart(4, 256, 256));
    m.cpuWrite(0x8000, 6);
    m.cpuWrite(0x8001, 5);
    m.cpuWrite(0x8000, 7);
    m.cpuWrite(0x8001, 9);
    expect(prgBanks(m)).toEqual([5, 9, 30, 31]);
    m.cpuWrite(0x8000, 0x47); // bit6：$8000 と $C000 を入れ替え
    expect(prgBanks(m)).toEqual([30, 9, 5, 31]);
  });

  it('CHR：2KB×2 と 1KB×4、bit7 での入れ替え', () => {
    const { m } = setup(cart(4, 256, 256));
    [10, 21, 30, 31, 32, 33].forEach((v, r) => {
      m.cpuWrite(0x8000, r);
      m.cpuWrite(0x8001, v);
    });
    expect(chrBanks(m)).toEqual([10, 11, 20, 21, 30, 31, 32, 33]);
    m.cpuWrite(0x8000, 0x80);
    expect(chrBanks(m)).toEqual([30, 31, 32, 33, 10, 11, 20, 21]);
  });

  it('ミラーリング', () => {
    const { m } = setup(cart(4, 256, 256));
    m.cpuWrite(0xa000, 0);
    expect(m.mirroring()).toBe('vertical');
    m.cpuWrite(0xa000, 1);
    expect(m.mirroring()).toBe('horizontal');
  });

  it('IRQ：A12 の立ち上がりを数え、latch 回目で IRQ。短い間隔の立ち上がりは数えない', () => {
    const { m, clock } = setup(cart(4, 256, 256));
    const line = () => {
      // 1 走査線ぶん：A12=0 の読み出しのあと、十分たってから A12=1
      m.ppuRead(0x0000);
      clock.dots += 341;
      m.ppuRead(0x1000);
    };
    m.cpuWrite(0xc000, 3); // latch = 3
    m.cpuWrite(0xc001, 0); // 次の立ち上がりで読み込み
    m.cpuWrite(0xe001, 0); // 有効
    line(); // 3 を読み込む
    line(); // 2
    line(); // 1
    expect(clock.irq).toBe(false);
    line(); // 0 → IRQ
    expect(clock.irq).toBe(true);
    m.cpuWrite(0xe000, 0); // 無効にすると IRQ も下がる
    expect(clock.irq).toBe(false);

    // 短い間隔の立ち上がりは数えない
    m.cpuWrite(0xc001, 0);
    m.cpuWrite(0xe001, 0);
    line(); // 3 を読み込む
    m.ppuRead(0x0000);
    clock.dots += 4;
    m.ppuRead(0x1000); // 4 ドットしか 0 でなかった → 数えない
    line(); // 2
    line(); // 1
    expect(clock.irq).toBe(false); // 短いのを数えていたら、ここで 0 になって IRQ が出ている
    line(); // 0 → IRQ
    expect(clock.irq).toBe(true);
  });
});
