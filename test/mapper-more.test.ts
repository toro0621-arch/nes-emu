// 段階6のあとに足したマッパーのバンク切り替え・IRQ を直接確かめる
import { describe, expect, it } from 'vitest';
import type { Cartridge, Mirroring } from '../src/cartridge';
import { createMapper, SUPPORTED_MAPPERS, type Mapper } from '../src/mappers/mapper';

/** 各 8KB の PRG バンクの先頭にバンク番号、各 1KB の CHR バンクの先頭にバンク番号を入れたカートリッジ */
function cart(mapper: number, prgKb: number, chrKb: number, opt: { battery?: boolean; mirroring?: Mirroring; submapper?: number } = {}): Cartridge {
  const prg = new Uint8Array(prgKb * 1024);
  for (let b = 0; b < prg.length / 0x2000; b++) prg[b * 0x2000] = b;
  const chrRam = chrKb === 0;
  const chr = new Uint8Array(chrRam ? 0x2000 : chrKb * 1024);
  if (!chrRam) for (let b = 0; b < chr.length / 0x400; b++) chr[b * 0x400] = b & 0xff;
  return { prg, chr, chrRam, mapper, mirroring: opt.mirroring ?? 'horizontal', battery: opt.battery ?? false, submapper: opt.submapper ?? 0 };
}

function setup(c: Cartridge) {
  const clock = { cpu: 0, dots: 0, irq: false };
  const m = createMapper(c, { irq: (on) => (clock.irq = on), cpuCycles: () => clock.cpu, ppuDots: () => clock.dots });
  const ciram = new Uint8Array(0x1000);
  m.attachCiram?.(ciram);
  return { m, clock, ciram };
}

const prgBanks = (m: Mapper) => [0x8000, 0xa000, 0xc000, 0xe000].map((a) => m.cpuRead(a));
const chrBanks = (m: Mapper) => Array.from({ length: 8 }, (_, i) => m.ppuRead(i * 0x400));
/** CPU を n サイクル進める */
const run = (m: Mapper, n: number) => {
  for (let i = 0; i < n; i++) m.cpuClock?.();
};

describe('対応マッパーの一覧', () => {
  it('ファミコンでよく使われるマッパーがそろっている', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 7, 9, 10, 16, 18, 19, 21, 22, 23, 24, 25, 26, 32, 33, 48, 65, 66, 67, 68, 69, 73, 75, 80, 85, 88, 206])
      expect(SUPPORTED_MAPPERS.includes(n), `マッパー ${n}`).toBe(true);
  });
  it('未対応の番号はエラーメッセージに番号が入る', () => {
    expect(() => setup(cart(255, 32, 8))).toThrow(/255/);
  });
});

describe('単純なマッパー', () => {
  it('3（CNROM）：CHR 8KB', () => {
    const { m } = setup(cart(3, 32, 32));
    m.cpuWrite(0x8000, 2);
    expect(chrBanks(m)).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
  });
  it('7（AxROM）：PRG 32KB と 1 画面ミラー', () => {
    const { m } = setup(cart(7, 256, 0));
    m.cpuWrite(0x8000, 0x13);
    expect(prgBanks(m)).toEqual([12, 13, 14, 15]);
    expect(m.mirroring()).toBe('single1');
  });
  it('66（GxROM）', () => {
    const { m } = setup(cart(66, 128, 32));
    m.cpuWrite(0x8000, 0x21);
    expect(prgBanks(m)).toEqual([8, 9, 10, 11]);
    expect(chrBanks(m)[0]).toBe(8);
  });
  it('87：ビットの順が逆', () => {
    const { m } = setup(cart(87, 32, 32));
    m.cpuWrite(0x6000, 1);
    expect(chrBanks(m)[0]).toBe(16);
  });
  it('180：$C000 を切り替え', () => {
    const { m } = setup(cart(180, 128, 0));
    m.cpuWrite(0x8000, 3);
    expect(prgBanks(m)).toEqual([0, 1, 6, 7]);
  });
  it('185：決まった値でだけ CHR が読める', () => {
    const { m } = setup(cart(185, 32, 8));
    m.cpuWrite(0x8000, 0);
    expect(m.ppuRead(0)).toBe(0xff);
    m.cpuWrite(0x8000, 0x11);
    expect(m.ppuRead(0)).toBe(0);
  });
});

describe('MMC2・MMC4', () => {
  it('タイル $FD/$FE を読むと CHR が切り替わる', () => {
    const { m } = setup(cart(9, 128, 128));
    m.cpuWrite(0xb000, 1); // 左・FD
    m.cpuWrite(0xc000, 2); // 左・FE
    expect(m.ppuRead(0)).toBe(8); // 最初は FE
    m.ppuRead(0x0fd8);
    expect(m.ppuRead(0)).toBe(4);
    m.ppuRead(0x0fe8);
    expect(m.ppuRead(0)).toBe(8);
  });
  it('MMC2 の PRG は 8KB、MMC4 は 16KB', () => {
    const a = setup(cart(9, 128, 128)).m;
    a.cpuWrite(0xa000, 3);
    expect(prgBanks(a)).toEqual([3, 13, 14, 15]);
    const b = setup(cart(10, 128, 128)).m;
    b.cpuWrite(0xa000, 3);
    expect(prgBanks(b)).toEqual([6, 7, 14, 15]);
  });
});

describe('ナムコ 108', () => {
  it('206：R6・R7 と CHR', () => {
    const { m } = setup(cart(206, 128, 64));
    m.cpuWrite(0x8000, 6);
    m.cpuWrite(0x8001, 5);
    m.cpuWrite(0x8000, 2);
    m.cpuWrite(0x8001, 9);
    expect(prgBanks(m)).toEqual([5, 1, 14, 15]);
    expect(chrBanks(m)[4]).toBe(9);
  });
});

describe('VRC', () => {
  it('VRC4（21）：PRG・CHR・入れ替えモード', () => {
    const { m } = setup(cart(21, 256, 256));
    m.cpuWrite(0x8000, 3);
    m.cpuWrite(0xa000, 4);
    expect(prgBanks(m)).toEqual([3, 4, 30, 31]);
    m.cpuWrite(0x9004, 2); // $9002 相当（A2）：入れ替え
    expect(prgBanks(m)).toEqual([30, 4, 3, 31]);
    m.cpuWrite(0xb000, 0x5);
    m.cpuWrite(0xb002, 0x1); // 上位
    expect(chrBanks(m)[0]).toBe(0x15);
  });
  it('VRC4（25）：A0 と A1 が逆のつなぎ方', () => {
    const { m } = setup(cart(25, 256, 256));
    m.cpuWrite(0xb002, 0x7); // A1 → 下位ビット扱いで「上位」
    expect(chrBanks(m)[0]).toBe(0x70);
  });
  it('VRC4 の CPU サイクル IRQ', () => {
    const { m, clock } = setup(cart(21, 256, 256));
    m.cpuWrite(0xf000, 0x0e); // ラッチ下位
    m.cpuWrite(0xf002, 0x0f); // ラッチ上位（A1）→ $FE
    m.cpuWrite(0xf004, 0x06); // 有効・サイクルモード（A2）
    run(m, 1);
    expect(clock.irq).toBe(false);
    run(m, 1);
    expect(clock.irq).toBe(true);
    m.cpuWrite(0xf006, 0); // ACK
    expect(clock.irq).toBe(false);
  });
  it('VRC4 の走査線 IRQ は 341/3 サイクルごと', () => {
    const { m, clock } = setup(cart(21, 256, 256));
    m.cpuWrite(0xf000, 0x0f);
    m.cpuWrite(0xf002, 0x0f); // $FF
    m.cpuWrite(0xf004, 0x02);
    run(m, 113);
    expect(clock.irq).toBe(false);
    run(m, 2);
    expect(clock.irq).toBe(true);
  });
  it('VRC6：PRG と CHR', () => {
    const { m } = setup(cart(24, 256, 256));
    m.cpuWrite(0x8000, 2);
    m.cpuWrite(0xc000, 9);
    expect(prgBanks(m)).toEqual([4, 5, 9, 31]);
    m.cpuWrite(0xd001, 7);
    expect(chrBanks(m)[1]).toBe(7);
  });
  it('VRC6 の矩形波が鳴る', () => {
    const { m } = setup(cart(24, 256, 256));
    m.cpuWrite(0x9000, 0x8f); // 音量 15、常に出す
    m.cpuWrite(0x9001, 0x10);
    m.cpuWrite(0x9002, 0x80);
    run(m, 10);
    expect(m.audioOut!()).toBeGreaterThan(0);
  });
  it('VRC1（75）', () => {
    const { m } = setup(cart(75, 128, 128));
    m.cpuWrite(0x8000, 2);
    m.cpuWrite(0x9000, 2); // CHR0 の上位ビット
    m.cpuWrite(0xe000, 1);
    expect(prgBanks(m)[0]).toBe(2);
    expect(chrBanks(m)[0]).toBe(0x11 * 4);
  });
  it('VRC7（85）：A3 でも A4 でも 2 つ目のレジスタ', () => {
    const { m } = setup(cart(85, 256, 256));
    m.cpuWrite(0x8010, 5);
    expect(prgBanks(m)[1]).toBe(5);
    m.cpuWrite(0x8008, 6);
    expect(prgBanks(m)[1]).toBe(6);
    m.cpuWrite(0xa008, 3);
    expect(chrBanks(m)[1]).toBe(3);
  });
});

describe('サンソフト', () => {
  it('FME-7（69）：コマンドで PRG・CHR・ミラー', () => {
    const { m } = setup(cart(69, 256, 256));
    m.cpuWrite(0x8000, 9);
    m.cpuWrite(0xa000, 7);
    m.cpuWrite(0x8000, 3);
    m.cpuWrite(0xa000, 12);
    m.cpuWrite(0x8000, 0xc);
    m.cpuWrite(0xa000, 1);
    expect(prgBanks(m)[0]).toBe(7);
    expect(chrBanks(m)[3]).toBe(12);
    expect(m.mirroring()).toBe('horizontal');
  });
  it('FME-7 の IRQ は 0 から下に回ったとき', () => {
    const { m, clock } = setup(cart(69, 256, 256));
    m.cpuWrite(0x8000, 0xe);
    m.cpuWrite(0xa000, 2);
    m.cpuWrite(0x8000, 0xf);
    m.cpuWrite(0xa000, 0);
    m.cpuWrite(0x8000, 0xd);
    m.cpuWrite(0xa000, 0x81);
    run(m, 2);
    expect(clock.irq).toBe(false);
    run(m, 1);
    expect(clock.irq).toBe(true);
  });
  it('FME-7 の $6000 に PRG ROM・RAM を出せる', () => {
    const { m } = setup(cart(69, 256, 256));
    m.cpuWrite(0x8000, 8);
    m.cpuWrite(0xa000, 5);
    expect(m.cpuRead(0x6000)).toBe(5);
    m.cpuWrite(0xa000, 0xc0);
    m.cpuWrite(0x6001, 0x42);
    expect(m.cpuRead(0x6001)).toBe(0x42);
  });
  it('サンソフト 3（67）：IRQ カウンタ', () => {
    const { m, clock } = setup(cart(67, 128, 128));
    m.cpuWrite(0xc800, 0);
    m.cpuWrite(0xc800, 3);
    m.cpuWrite(0xd800, 0x10);
    run(m, 3);
    expect(clock.irq).toBe(false);
    run(m, 1);
    expect(clock.irq).toBe(true);
  });
  it('サンソフト 4（68）：CHR ROM をネームテーブルに使う', () => {
    const { m } = setup(cart(68, 128, 256));
    m.cpuWrite(0xc000, 3); // → CHR の 1KB バンク $83
    m.cpuWrite(0xe000, 0x10); // 縦ミラー + CHR をネームテーブルに
    expect(m.ntRead!(0x2000)).toBe(0x83);
  });
});

describe('ナムコ 163', () => {
  it('PRG と、CHR の代わりに CIRAM を使う', () => {
    const { m, ciram } = setup(cart(19, 256, 256));
    m.cpuWrite(0xe000, 3);
    expect(prgBanks(m)[0]).toBe(3);
    ciram[0x400] = 0x77;
    m.cpuWrite(0x8000, 0xe1); // パターン $0000 → CIRAM ページ 1
    expect(m.ppuRead(0)).toBe(0x77);
    m.cpuWrite(0xe800, 0x40); // 下半分の CIRAM を使わない
    expect(m.ppuRead(0)).toBe(0xe1);
  });
  it('ネームテーブルの割り当て', () => {
    const { m, ciram } = setup(cart(19, 256, 256));
    ciram[0x401] = 0x55;
    m.cpuWrite(0xc000, 0xe1);
    expect(m.ntRead!(0x2001)).toBe(0x55);
    m.cpuWrite(0xc000, 0x10); // CHR ROM のバンク $10
    expect(m.ntRead!(0x2000)).toBe(0x10);
  });
  it('IRQ は $7FFF まで数えたら', () => {
    const { m, clock } = setup(cart(19, 256, 256));
    m.cpuWrite(0x5000, 0xfd);
    m.cpuWrite(0x5800, 0xff); // $7FFD・有効
    run(m, 1);
    expect(clock.irq).toBe(false);
    run(m, 1);
    expect(clock.irq).toBe(true);
    expect(m.cpuRead(0x5000)).toBe(0xff);
  });
  it('波形メモリ音源が鳴る', () => {
    const { m } = setup(cart(19, 256, 256));
    const w = (a: number, v: number) => {
      m.cpuWrite(0xf800, a);
      m.cpuWrite(0x4800, v);
    };
    for (let i = 0; i < 16; i++) w(i, 0xff); // 波形：すべて 15
    w(0x78, 0x00);
    w(0x7a, 0x10);
    w(0x7c, 0xe0); // 長さ 32
    w(0x7e, 0x00);
    w(0x7f, 0x0f); // 音量 15・1 チャンネル
    run(m, 100);
    expect(m.audioOut!()).toBeGreaterThan(0);
  });
});

describe('バンダイ FCG', () => {
  it('PRG・CHR（$8000 と $6000 のどちらでも）', () => {
    const { m } = setup(cart(16, 256, 256));
    m.cpuWrite(0x8008, 3);
    m.cpuWrite(0x6002, 9);
    expect(prgBanks(m)).toEqual([6, 7, 30, 31]);
    expect(chrBanks(m)[2]).toBe(9);
  });
  it('IRQ（LZ93D50）は $800A でラッチをカウンタへ', () => {
    const { m, clock } = setup(cart(16, 256, 256));
    m.cpuWrite(0x800b, 2);
    m.cpuWrite(0x800c, 0);
    m.cpuWrite(0x800a, 1);
    run(m, 2);
    expect(clock.irq).toBe(false);
    run(m, 1);
    expect(clock.irq).toBe(true);
  });
  it('24C02 の EEPROM に書いて読める', () => {
    const { m } = setup(cart(16, 256, 256));
    const line = (scl: number, sda: number) => m.cpuWrite(0x800d, (scl << 5) | (sda << 6) | 0x80);
    const start = () => (line(1, 1), line(1, 0), line(0, 0));
    const stop = () => (line(0, 0), line(1, 0), line(1, 1));
    const sendByte = (b: number) => {
      for (let i = 7; i >= 0; i--) {
        const bit = (b >> i) & 1;
        line(0, bit);
        line(1, bit);
        line(0, bit);
      }
      line(0, 1);
      line(1, 1); // ACK のクロック
      const ack = (m.cpuRead(0x6000) >> 4) & 1;
      line(0, 1);
      return ack;
    };
    const readByte = (last: boolean) => {
      let b = 0;
      for (let i = 0; i < 8; i++) {
        line(0, 1);
        line(1, 1);
        b = (b << 1) | ((m.cpuRead(0x6000) >> 4) & 1);
      }
      line(0, 1);
      line(0, last ? 1 : 0);
      line(1, last ? 1 : 0);
      line(0, last ? 1 : 0);
      return b;
    };
    start();
    expect(sendByte(0xa0)).toBe(0);
    expect(sendByte(0x10)).toBe(0);
    expect(sendByte(0x5a)).toBe(0);
    expect(sendByte(0xc3)).toBe(0);
    stop();
    expect(m.saveDirty).toBe(true);
    expect(m.saveRam![0x10]).toBe(0x5a);
    // 読み出し：アドレスを書いてから読みの開始
    start();
    sendByte(0xa0);
    sendByte(0x10);
    start();
    sendByte(0xa1);
    expect(readByte(false)).toBe(0x5a);
    expect(readByte(true)).toBe(0xc3);
    stop();
  });
});

describe('ジャレコ・アイレム・タイトー', () => {
  it('ジャレコ SS88006（18）：4 ビットずつ書く', () => {
    const { m, clock } = setup(cart(18, 256, 256));
    m.cpuWrite(0x8000, 5);
    m.cpuWrite(0x8001, 1);
    expect(prgBanks(m)[0]).toBe(0x15);
    m.cpuWrite(0xa002, 3);
    expect(chrBanks(m)[1]).toBe(3);
    m.cpuWrite(0xe000, 2);
    m.cpuWrite(0xf000, 0);
    m.cpuWrite(0xf001, 1);
    run(m, 1);
    expect(clock.irq).toBe(false);
    run(m, 1);
    expect(clock.irq).toBe(true);
  });
  it('アイレム G-101（32）', () => {
    const { m } = setup(cart(32, 256, 256));
    m.cpuWrite(0x8000, 4);
    m.cpuWrite(0xa000, 5);
    m.cpuWrite(0xb003, 7);
    expect(prgBanks(m)).toEqual([4, 5, 30, 31]);
    expect(chrBanks(m)[3]).toBe(7);
    m.cpuWrite(0x9000, 2);
    expect(prgBanks(m)).toEqual([30, 5, 4, 31]);
  });
  it('アイレム H3001（65）の IRQ', () => {
    const { m, clock } = setup(cart(65, 256, 256));
    m.cpuWrite(0x9005, 0);
    m.cpuWrite(0x9006, 3);
    m.cpuWrite(0x9004, 0);
    m.cpuWrite(0x9003, 0x80);
    run(m, 2);
    expect(clock.irq).toBe(false);
    run(m, 1);
    expect(clock.irq).toBe(true);
  });
  it('タイトー TC0190（33）', () => {
    const { m } = setup(cart(33, 256, 256));
    m.cpuWrite(0x8000, 0x43);
    m.cpuWrite(0x8002, 5);
    m.cpuWrite(0xa001, 9);
    expect(prgBanks(m)[0]).toBe(3);
    expect(m.mirroring()).toBe('horizontal');
    expect(chrBanks(m).slice(0, 2)).toEqual([10, 11]);
    expect(chrBanks(m)[5]).toBe(9);
  });
  it('タイトー X1-005（80）：$7EF0 のレジスタと RAM', () => {
    const { m } = setup(cart(80, 256, 256, { battery: true }));
    m.cpuWrite(0x7efa, 6);
    m.cpuWrite(0x7ef2, 8);
    expect(prgBanks(m)[0]).toBe(6);
    expect(chrBanks(m)[4]).toBe(8);
    m.cpuWrite(0x7ef8, 0xa3);
    m.cpuWrite(0x7f05, 0x99);
    expect(m.cpuRead(0x7f85)).toBe(0x99);
  });
});

describe('MMC3 の仲間', () => {
  it('TxSROM（118）：CHR バンクのビット 7 でネームテーブル', () => {
    const { m, ciram } = setup(cart(118, 256, 256));
    ciram[0x400] = 0x31;
    m.cpuWrite(0x8000, 0); // R0
    m.cpuWrite(0x8001, 0x80);
    expect(m.ntRead!(0x2000)).toBe(0x31);
    expect(m.ntRead!(0x2800)).toBe(0); // R1 は 0
  });
  it('TQROM（119）：CHR バンクのビット 6 で CHR RAM', () => {
    const { m } = setup(cart(119, 128, 64));
    m.cpuWrite(0x8000, 2); // R2（$1000）
    m.cpuWrite(0x8001, 0x41);
    m.ppuWrite(0x1003, 0x66);
    expect(m.ppuRead(0x1003)).toBe(0x66);
    m.cpuWrite(0x8001, 0x01);
    expect(m.ppuRead(0x1000)).toBe(1);
  });
});

describe('MMC5', () => {
  it('PRG モード 3（8KB×4）と RAM', () => {
    const { m } = setup(cart(5, 512, 256));
    m.cpuWrite(0x5100, 3);
    m.cpuWrite(0x5114, 0x85);
    m.cpuWrite(0x5115, 0x86);
    m.cpuWrite(0x5116, 0x87);
    expect(prgBanks(m)).toEqual([5, 6, 7, 63]);
    m.cpuWrite(0x5102, 2);
    m.cpuWrite(0x5103, 1);
    m.cpuWrite(0x5113, 1);
    m.cpuWrite(0x6000, 0x12);
    expect(m.cpuRead(0x6000)).toBe(0x12);
    m.cpuWrite(0x5113, 0);
    expect(m.cpuRead(0x6000)).toBe(0);
  });
  it('CHR モード 3（1KB）', () => {
    const { m } = setup(cart(5, 128, 256));
    m.cpuWrite(0x5101, 3);
    for (let i = 0; i < 8; i++) m.cpuWrite(0x5120 + i, 10 + i);
    expect(chrBanks(m)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });
  it('ネームテーブル：CIRAM・拡張 RAM・塗りつぶし', () => {
    const { m, ciram } = setup(cart(5, 128, 256));
    ciram[0x405] = 0x21;
    m.cpuWrite(0x5104, 0);
    m.cpuWrite(0x5105, 0b11100100); // 0:A 1:B 2:拡張 3:塗りつぶし
    m.cpuWrite(0x5106, 0x44);
    m.cpuWrite(0x5107, 2);
    expect(m.ntRead!(0x2405)).toBe(0x21);
    m.cpuWrite(0x5104, 2); // 拡張 RAM に CPU から書く
    m.cpuWrite(0x5c07, 0x33);
    m.cpuWrite(0x5104, 0);
    expect(m.ntRead!(0x2807)).toBe(0x33);
    expect(m.ntRead!(0x2c00)).toBe(0x44);
    expect(m.ntRead!(0x2fc0)).toBe(0xaa);
  });
  it('走査線 IRQ と掛け算', () => {
    const { m, clock } = setup(cart(5, 128, 256));
    m.cpuWrite(0x5203, 3);
    m.cpuWrite(0x5204, 0x80);
    for (let sl = 0; sl < 3; sl++) m.ppuScanline!(sl, true);
    expect(clock.irq).toBe(false);
    m.ppuScanline!(3, true);
    expect(clock.irq).toBe(true);
    expect(m.cpuRead(0x5204) & 0xc0).toBe(0xc0);
    expect(clock.irq).toBe(false);
    m.cpuWrite(0x5205, 200);
    m.cpuWrite(0x5206, 100);
    expect(m.cpuRead(0x5205) | (m.cpuRead(0x5206) << 8)).toBe(20000);
  });
});
