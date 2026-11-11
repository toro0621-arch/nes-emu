// ゲームボーイアドバンスのカートリッジのセーブ（SRAM・フラッシュ・EEPROM）と時計（RTC）

export type GbaSaveType = 'sram' | 'flash64' | 'flash128' | 'eeprom' | 'none';

/** ROM の中の印（ライブラリの名前）からセーブの種類を決める */
export function detectSaveType(rom: Uint8Array): GbaSaveType {
  const marks: [string, GbaSaveType][] = [
    ['EEPROM_V', 'eeprom'],
    ['SRAM_V', 'sram'],
    ['SRAM_F_V', 'sram'],
    ['FLASH_V', 'flash64'],
    ['FLASH512_V', 'flash64'],
    ['FLASH1M_V', 'flash128'],
  ];
  const codes = marks.map(([m]) => Array.from(m, (ch) => ch.charCodeAt(0)));
  // 印は 4 バイト境界にある
  for (let i = 0; i + 12 < rom.length; i += 4) {
    if (rom[i] !== 0x45 && rom[i] !== 0x53 && rom[i] !== 0x46) continue; // E S F
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      let ok = true;
      for (let j = 0; j < c.length; j++) {
        if (rom[i + j] !== c[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return marks[k][1];
    }
  }
  return 'sram';
}

export function hasRtc(rom: Uint8Array): boolean {
  const m = 'SIIRTC_V';
  outer: for (let i = 0; i + 8 < rom.length; i += 4) {
    for (let j = 0; j < 8; j++) if (rom[i + j] !== m.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

export class GbaSave {
  data: Uint8Array;
  dirty = false;
  // フラッシュ
  private flashState = 0;
  private flashId = false;
  private flashErase = false;
  private flashWrite = false;
  private flashBankNext = false;
  private flashBank = 0;
  // EEPROM
  /** アドレスのビット数（6 = 512 バイト、14 = 8K バイト）。0 はまだわからない */
  eepromBits = 0;
  private epState = 0;
  private epBuf = 0;
  private epCount = 0;
  private epAddr = 0;
  private epData = new Uint8Array(8);
  private epReadPos = -1;
  private epReadAddr = 0;

  constructor(readonly type: GbaSaveType) {
    const size = type === 'flash128' ? 0x20000 : type === 'flash64' ? 0x10000 : type === 'eeprom' ? 0x2000 : 0x8000;
    this.data = new Uint8Array(size).fill(0xff);
  }

  read8(a: number): number {
    a &= 0xffff;
    if (this.type === 'sram') return this.data[a & 0x7fff];
    if (this.type === 'flash64' || this.type === 'flash128') {
      if (this.flashId && a < 2) {
        // 64K は Panasonic、128K は Sanyo のチップとして答える
        if (this.type === 'flash128') return a === 0 ? 0x62 : 0x13;
        return a === 0 ? 0x32 : 0x1b;
      }
      return this.data[this.flashBank * 0x10000 + a];
    }
    return 0xff;
  }

  write8(a: number, v: number): void {
    a &= 0xffff;
    if (this.type === 'sram') {
      if (this.data[a & 0x7fff] !== v) {
        this.data[a & 0x7fff] = v;
        this.dirty = true;
      }
      return;
    }
    if (this.type !== 'flash64' && this.type !== 'flash128') return;
    if (this.flashWrite) {
      this.flashWrite = false;
      this.data[this.flashBank * 0x10000 + a] = v;
      this.dirty = true;
      return;
    }
    if (this.flashBankNext) {
      this.flashBankNext = false;
      if (a === 0 && this.type === 'flash128') this.flashBank = v & 1;
      return;
    }
    if (this.flashState === 0 && a === 0x5555 && v === 0xaa) this.flashState = 1;
    else if (this.flashState === 1 && a === 0x2aaa && v === 0x55) this.flashState = 2;
    else if (this.flashState === 2) {
      this.flashState = 0;
      if (this.flashErase) {
        this.flashErase = false;
        if (a === 0x5555 && v === 0x10) {
          this.data.fill(0xff);
          this.dirty = true;
        } else if (v === 0x30) {
          const base = this.flashBank * 0x10000 + (a & 0xf000);
          this.data.fill(0xff, base, base + 0x1000);
          this.dirty = true;
        }
        return;
      }
      if (a !== 0x5555) return;
      switch (v) {
        case 0x90:
          this.flashId = true;
          break;
        case 0xf0:
          this.flashId = false;
          break;
        case 0x80:
          this.flashErase = true;
          break;
        case 0xa0:
          this.flashWrite = true;
          break;
        case 0xb0:
          this.flashBankNext = true;
          break;
      }
    } else if (v === 0xf0) {
      this.flashState = 0;
      this.flashId = false;
    } else this.flashState = 0;
  }

  /** DMA の長さから EEPROM の大きさを決める（9・73 → 512 バイト、17・81 → 8K バイト） */
  eepromHint(count: number): void {
    if (this.eepromBits) return;
    if (count === 9 || count === 73) this.eepromBits = 6;
    else if (count === 17 || count === 81) this.eepromBits = 14;
  }

  eepromRead(): number {
    if (this.epReadPos < 0) return 1;
    const p = this.epReadPos++;
    if (p < 4) return 0;
    const bit = p - 4;
    const byte = this.data[(this.epReadAddr * 8 + (bit >> 3)) & 0x1fff];
    if (this.epReadPos >= 68) this.epReadPos = -1;
    return (byte >> (7 - (bit & 7))) & 1;
  }

  eepromWrite(v: number): void {
    const bit = v & 1;
    const bits = this.eepromBits || 14;
    switch (this.epState) {
      case 0: // 命令の 2 ビット
        this.epBuf = (this.epBuf << 1) | bit;
        if (++this.epCount === 2) {
          this.epState = this.epBuf === 3 ? 1 : this.epBuf === 2 ? 2 : 0;
          this.epBuf = this.epCount = 0;
          this.epAddr = 0;
        }
        break;
      case 1: // 読み出し：アドレス → 終わりの 1 ビット
      case 2: // 書き込み：アドレス → 64 ビット → 終わりの 1 ビット
        this.epAddr = (this.epAddr << 1) | bit;
        if (++this.epCount === bits) {
          this.epCount = 0;
          this.epAddr &= 0x3ff;
          if (this.epState === 1) this.epState = 3;
          else {
            this.epState = 4;
            this.epData.fill(0);
          }
        }
        break;
      case 3:
        this.epReadAddr = this.epAddr;
        this.epReadPos = 0;
        this.epState = 0;
        break;
      case 4:
        this.epData[this.epCount >> 3] |= bit << (7 - (this.epCount & 7));
        if (++this.epCount === 64) {
          this.epState = 5;
          this.epCount = 0;
        }
        break;
      case 5: {
        const base = (this.epAddr * 8) & 0x1fff;
        this.data.set(this.epData, base);
        this.dirty = true;
        this.epState = 0;
        this.epReadPos = -1;
        break;
      }
    }
  }
}

function bcd(v: number): number {
  return ((Math.floor(v / 10) % 10) << 4) | v % 10;
}

/** カートリッジの時計（S-3511。GPIO の 3 本の線でやりとりする） */
export class GbaRtc {
  /** GPIO を読めるようにするか（0x80000C8） */
  readable = 0;
  direction = 0;
  pins = 0;
  private step = 0;
  private bits = 0;
  private bitsRead = 0;
  private command = 0;
  private active = false;
  private bytesLeft = 0;
  private control = 0x40;
  private time = new Uint8Array(7);

  /** 0x80000C4〜0x80000C9 を読む（読めないときは -1 → ROM を読む） */
  read16(a: number): number {
    if (!(this.readable & 1)) return -1;
    if (a === 0xc4) return this.pins;
    if (a === 0xc6) return this.direction;
    if (a === 0xc8) return this.readable;
    return -1;
  }

  write16(a: number, v: number): void {
    if (a === 0xc4) {
      this.pins = (this.pins & ~this.direction) | (v & this.direction & 0xf);
      this.update();
    } else if (a === 0xc6) this.direction = v & 0xf;
    else if (a === 0xc8) this.readable = v & 1;
  }

  private output(bit: number): void {
    // SIO（ビット 1）を時計の側から出す
    this.pins = (this.pins & this.direction) | ((5 | (bit << 1)) & ~this.direction);
  }

  private update(): void {
    const p = this.pins;
    if (!(p & 4)) {
      this.bitsRead = 0;
      this.bytesLeft = 0;
      this.active = false;
      this.command = 0;
    }
    switch (this.step) {
      case 0:
        if ((p & 5) === 1) this.step = 1;
        break;
      case 1:
        if ((p & 5) === 5) this.step = 2;
        else if ((p & 5) !== 1) this.step = 0;
        break;
      case 2:
        if (!(p & 1)) {
          this.bits &= ~(1 << this.bitsRead);
          this.bits |= ((p & 2) >> 1) << this.bitsRead;
        } else if (p & 4) {
          if (!(this.command & 0x80)) {
            if (++this.bitsRead === 8) this.processByte();
          } else {
            this.output(this.outBit());
            if (++this.bitsRead === 8) {
              this.bitsRead = 0;
              if (--this.bytesLeft <= 0) {
                this.active = false;
                this.command = 0;
              }
            }
          }
        } else {
          this.bitsRead = 0;
          this.bytesLeft = 0;
          this.active = false;
          this.command = 0;
          this.step &= 2;
        }
        break;
    }
  }

  private processByte(): void {
    this.bytesLeft--;
    if (!this.active) {
      const cmd = this.bits;
      if ((cmd & 0x0f) === 0x06) {
        this.command = cmd;
        const id = (cmd >> 4) & 7;
        this.bytesLeft = [0, 0, 7, 0, 1, 0, 3, 0][id];
        this.active = this.bytesLeft > 0;
        if (id === 0) this.control = 0;
        if (id === 2 || id === 6) this.updateClock();
      }
    } else if (((this.command >> 4) & 7) === 4) this.control = this.bits;
    this.bits = 0;
    this.bitsRead = 0;
    if (this.bytesLeft <= 0) {
      this.active = false;
      this.command = 0;
    }
  }

  private outBit(): number {
    if (!this.active) return 0;
    let byte = 0;
    const id = (this.command >> 4) & 7;
    if (id === 4) byte = this.control;
    else if (id === 2 || id === 6) byte = this.time[7 - this.bytesLeft];
    return (byte >> this.bitsRead) & 1;
  }

  private updateClock(): void {
    const d = new Date();
    this.time[0] = bcd(d.getFullYear() % 100);
    this.time[1] = bcd(d.getMonth() + 1);
    this.time[2] = bcd(d.getDate());
    this.time[3] = bcd(d.getDay());
    const h = d.getHours();
    this.time[4] = this.control & 0x40 ? bcd(h) : bcd(h % 12) | (h >= 12 ? 0x80 : 0);
    this.time[5] = bcd(d.getMinutes());
    this.time[6] = bcd(d.getSeconds());
  }
}
