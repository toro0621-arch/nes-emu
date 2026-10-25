// iNES 形式の ROM を読み込む
export type Mirroring = 'horizontal' | 'vertical' | 'four' | 'single0' | 'single1';

export interface Cartridge {
  prg: Uint8Array;
  chr: Uint8Array;
  /** CHR が ROM ではなく RAM（書き込み可）か */
  chrRam: boolean;
  mapper: number;
  mirroring: Mirroring;
  battery: boolean;
}

export function parseINes(data: Uint8Array): Cartridge {
  if (data.length < 16 || data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) {
    throw new Error('iNES 形式の ROM ではありません');
  }
  const prgSize = data[4] * 0x4000;
  const chrSize = data[5] * 0x2000;
  const f6 = data[6];
  const f7 = data[7];
  const trainer = (f6 & 0x04) !== 0;
  // NES 2.0 でない古いヘッダーは 8〜15 バイト目にゴミが入っていることがあるので、上位ニブルを捨てる
  const isNes2 = (f7 & 0x0c) === 0x08;
  const dirty = !isNes2 && (data[12] | data[13] | data[14] | data[15]) !== 0;
  const mapper = (f6 >> 4) | (dirty ? 0 : f7 & 0xf0);

  let off = 16 + (trainer ? 512 : 0);
  if (data.length < off + prgSize + chrSize) throw new Error('ROM のサイズがヘッダーと合いません');
  const prg = data.slice(off, off + prgSize);
  off += prgSize;
  const chrRam = chrSize === 0;
  const chr = chrRam ? new Uint8Array(0x2000) : data.slice(off, off + chrSize);

  return {
    prg,
    chr,
    chrRam,
    mapper,
    mirroring: f6 & 0x08 ? 'four' : f6 & 0x01 ? 'vertical' : 'horizontal',
    battery: (f6 & 0x02) !== 0,
  };
}
