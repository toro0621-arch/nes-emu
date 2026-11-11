// ワンダースワン・ワンダースワンカラー本体（メモリ・I/O ポート・割り込み・タイマー・ボタン・DMA・セーブ）
import { V30MZ, type WsCpuBus } from './cpu';
import { WS_H, WsDisplay } from './display';
import { WsSound } from './sound';

/** 1 ラインのクロック数と、1 フレームのライン数（0〜158） */
const LINE_CYCLES = 256;

// 割り込みの番号（ステータスのビット）
const INT_HBLANK_TIMER = 7;
const INT_VBLANK = 6;
const INT_VBLANK_TIMER = 5;
const INT_LINE = 4;
const INT_KEY = 1;

/** ROM の後ろ 10 バイトのヘッダー */
export interface WsHeader {
  color: boolean;
  /** 縦持ちのソフト */
  vertical: boolean;
  saveType: number;
  rtc: boolean;
}

export function parseWsHeader(rom: Uint8Array): WsHeader {
  const h = rom.length - 10;
  return {
    color: (rom[h + 1] & 1) !== 0,
    vertical: (rom[h + 6] & 1) !== 0,
    saveType: rom[h + 5],
    rtc: rom[h + 7] === 1,
  };
}

/** ワンダースワンの ROM らしいか（最後の 16 バイトが「JMP FAR」で始まる） */
export function isWsRom(data: Uint8Array): boolean {
  return data.length >= 0x10000 && (data.length & 0xffff) === 0 && data[data.length - 16] === 0xea;
}

/** シリアル EEPROM（93C46 などと同じ命令。1 ワード = 16 ビット） */
export class WsEeprom {
  readonly data: Uint8Array;
  private readonly addrBits: number;
  dirty = false;
  private dataReg = 0;
  private cmd = 0;
  private writable = true;

  constructor(bytes: number) {
    this.data = new Uint8Array(bytes).fill(0xff);
    const words = bytes >> 1;
    this.addrBits = Math.max(6, Math.ceil(Math.log2(words)));
  }

  read(reg: number): number {
    switch (reg) {
      case 0:
        return this.dataReg & 0xff;
      case 1:
        return this.dataReg >> 8;
      case 2:
        return this.cmd & 0xff;
      case 3:
        return this.cmd >> 8;
      default:
        return 0x03; // 読み終わり・書き終わり
    }
  }

  write(reg: number, v: number): void {
    switch (reg) {
      case 0:
        this.dataReg = (this.dataReg & 0xff00) | v;
        return;
      case 1:
        this.dataReg = (this.dataReg & 0xff) | (v << 8);
        return;
      case 2:
        this.cmd = (this.cmd & 0xff00) | v;
        return;
      case 3:
        this.cmd = (this.cmd & 0xff) | (v << 8);
        return;
    }
    // 制御：bit4 = 読む、bit5 = 書く、bit6 = そのほかの命令
    const bits = this.addrBits;
    const op = (this.cmd >> bits) & 3;
    const addr = this.cmd & ((1 << bits) - 1);
    const words = this.data.length >> 1;
    const a = (addr % words) * 2;
    if (v & 0x10) {
      this.dataReg = this.data[a] | (this.data[a + 1] << 8);
    } else if (v & 0x20) {
      if (this.writable) this.put(a, this.dataReg);
    } else if (v & 0x40) {
      if (op === 3) this.put(a, 0xffff); // ERASE
      else if (op === 0) {
        switch (addr >> (bits - 2)) {
          case 3:
            this.writable = true; // EWEN
            break;
          case 0:
            this.writable = false; // EWDS
            break;
          case 2:
            for (let i = 0; i < this.data.length; i += 2) this.put(i, 0xffff); // ERAL
            break;
          case 1:
            for (let i = 0; i < this.data.length; i += 2) this.put(i, this.dataReg); // WRAL
            break;
        }
      }
    }
  }

  private put(a: number, v: number): void {
    this.data[a] = v & 0xff;
    this.data[a + 1] = v >> 8;
    this.dirty = true;
  }
}

export class Ws implements WsCpuBus {
  readonly rom: Uint8Array;
  private readonly romMask: number;
  readonly header: WsHeader;
  /** カラー本体として動かすか（白黒専用のソフトは白黒の本体として動かす） */
  readonly color: boolean;
  readonly cpu: V30MZ;
  readonly display: WsDisplay;
  readonly sound: WsSound;
  readonly ram = new Uint8Array(0x10000);
  readonly io = new Uint8Array(0x100);
  readonly sram: Uint8Array | null;
  readonly eeprom: WsEeprom | null;
  /** 本体の EEPROM（持ち主の名前など。保存はしない） */
  private iee = new WsEeprom(2048);
  saveDirty = false;
  frameReady = false;

  private line = 0;
  private irqStatus = 0;
  private keys = 0; // 押されているボタン（bit0〜3 = X1〜X4、4〜7 = Y1〜Y4、8 = START、9 = A、10 = B）
  private hTimer = 0;
  private vTimer = 0;
  private cycleDebt = 0;
  // サウンド DMA
  private sdmaSrc = 0;
  private sdmaLen = 0;
  private sdmaTimer = 0;
  // 時計
  private rtcBuf: number[] = [];

  constructor(rom: Uint8Array) {
    // ROM の大きさを 2 のべき乗に（足りないところは先頭からくり返す）
    let size = 0x10000;
    while (size < rom.length) size *= 2;
    if (size !== rom.length) {
      const r = new Uint8Array(size);
      for (let i = 0; i < size; i += rom.length) r.set(rom.subarray(0, Math.min(rom.length, size - i)), i);
      rom = r;
    }
    this.rom = rom;
    this.romMask = size - 1;
    this.header = parseWsHeader(rom);
    this.color = this.header.color;
    const st = this.header.saveType;
    const sramSize = { 0x01: 0x8000, 0x02: 0x8000, 0x03: 0x20000, 0x04: 0x40000, 0x05: 0x80000 }[st] ?? 0;
    const eepSize = { 0x10: 128, 0x20: 2048, 0x50: 1024 }[st] ?? 0;
    this.sram = sramSize ? new Uint8Array(sramSize) : null;
    this.eeprom = eepSize ? new WsEeprom(eepSize) : null;
    this.display = new WsDisplay(this.ram, this.io);
    this.sound = new WsSound(this.ram, this.io);
    this.cpu = new V30MZ(this);
    this.powerOn();
  }

  /** 起動 ROM が終わったあとの状態 */
  private powerOn(): void {
    const io = this.io;
    io.fill(0);
    io[0xc0] = 0xff;
    io[0xc1] = 0xff;
    io[0xc2] = 0xff;
    io[0xc3] = 0xff;
    io[0x14] = 1; // 画面オン
    io[0x16] = 158;
    io[0x17] = 155;
    io[0xa0] = this.color ? 0x87 : 0x85;
    this.cpu.reset();
  }

  get saveRam(): Uint8Array | null {
    return this.sram ?? this.eeprom?.data ?? null;
  }

  // ---- ボタン ----
  setKeys(k: number): void {
    if (k & ~this.keys) this.raise(INT_KEY);
    this.keys = k;
  }

  // ---- メモリ ----
  read8(a: number): number {
    switch (a >> 16) {
      case 0:
        // 白黒の本体の RAM は 16KB だけ
        return this.color || a < 0x4000 ? this.ram[a] : 0x90;
      case 1:
        if (!this.sram) return 0xff;
        return this.sram[((this.io[0xc1] << 16) | (a & 0xffff)) & (this.sram.length - 1)];
      case 2:
        return this.rom[((this.io[0xc2] << 16) | (a & 0xffff)) & this.romMask];
      case 3:
        return this.rom[((this.io[0xc3] << 16) | (a & 0xffff)) & this.romMask];
      default:
        return this.rom[(((this.io[0xc0] & 0x3f) << 20) | a) & this.romMask];
    }
  }

  write8(a: number, v: number): void {
    const seg = a >> 16;
    if (seg === 0) {
      if (this.color || a < 0x4000) {
        this.ram[a] = v;
        if (a >= 0xfe00) this.display.palDirty = true; // カラーのパレット
      }
    } else if (seg === 1 && this.sram) {
      this.sram[((this.io[0xc1] << 16) | (a & 0xffff)) & (this.sram.length - 1)] = v;
      this.saveDirty = true;
    }
  }

  // ---- I/O ポート ----
  in8(p: number): number {
    const io = this.io;
    switch (p) {
      case 0x02:
        return this.line;
      case 0x92:
        return this.sound.noiseCounter & 0xff;
      case 0x93:
        return this.sound.noiseCounter >> 8;
      case 0x91:
        return io[0x91] | 0x80; // ヘッドホンをつないでいる（ステレオ）
      case 0xa0:
        return this.color ? 0x87 : 0x85; // bit1 = カラー本体
      case 0xa8:
        return this.hTimer & 0xff;
      case 0xa9:
        return this.hTimer >> 8;
      case 0xaa:
        return this.vTimer & 0xff;
      case 0xab:
        return this.vTimer >> 8;
      case 0xb3:
        return 0x84; // シリアル：送信できる
      case 0xb4:
        return this.irqStatus;
      case 0xb5: {
        // ボタン：選んだグループの 4 ビット（押されている = 1）
        const sel = io[0xb5] & 0x70;
        let n = 0;
        if (sel & 0x10) n |= (this.keys >> 4) & 15; // Y
        if (sel & 0x20) n |= this.keys & 15; // X
        if (sel & 0x40) n |= ((this.keys >> 8) & 7) << 1; // START A B
        return sel | n;
      }
      case 0xba:
      case 0xbb:
      case 0xbc:
      case 0xbd:
      case 0xbe:
        return this.iee.read(p - 0xba);
      case 0xc4:
      case 0xc5:
      case 0xc6:
      case 0xc7:
      case 0xc8:
        return this.eeprom ? this.eeprom.read(p - 0xc4) : 0xff;
      case 0xca:
        return 0x80; // 時計：準備できている
      case 0xcb:
        return this.rtcBuf.shift() ?? 0;
    }
    return io[p];
  }

  out8(p: number, v: number): void {
    const io = this.io;
    switch (p) {
      case 0x02:
        return; // 読み出し専用
      case 0x48:
        if (!this.color) return;
        io[p] = v;
        if (v & 0x80) this.gdma();
        return;
      case 0x52:
        if (!this.color) return;
        io[p] = v;
        if (v & 0x80) {
          this.sdmaSrc = io[0x4a] | (io[0x4b] << 8) | ((io[0x4c] & 0x0f) << 16);
          this.sdmaLen = io[0x4e] | (io[0x4f] << 8) | ((io[0x50] & 0x0f) << 16);
        }
        return;
      case 0x8e:
        io[p] = v;
        if (v & 0x08) this.sound.resetNoise();
        return;
      case 0xa4:
      case 0xa5:
        io[p] = v;
        this.hTimer = io[0xa4] | (io[0xa5] << 8);
        return;
      case 0xa6:
      case 0xa7:
        io[p] = v;
        this.vTimer = io[0xa6] | (io[0xa7] << 8);
        return;
      case 0xb2:
        io[p] = v;
        this.irqStatus &= v;
        return;
      case 0xb6:
        this.irqStatus &= ~v;
        return;
      case 0xba:
      case 0xbb:
      case 0xbc:
      case 0xbd:
      case 0xbe:
        this.iee.write(p - 0xba, v);
        return;
      case 0xc4:
      case 0xc5:
      case 0xc6:
      case 0xc7:
      case 0xc8:
        if (this.eeprom) {
          this.eeprom.write(p - 0xc4, v);
          if (this.eeprom.dirty) {
            this.eeprom.dirty = false;
            this.saveDirty = true;
          }
        }
        return;
      case 0xca:
        // 時計：0x15 で日時（BCD）を読む
        if (v === 0x15 || v === 0x14) {
          const d = new Date();
          const bcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | n % 10;
          this.rtcBuf = [
            bcd(d.getFullYear() % 100),
            bcd(d.getMonth() + 1),
            bcd(d.getDate()),
            d.getDay(),
            bcd(d.getHours()),
            bcd(d.getMinutes()),
            bcd(d.getSeconds()),
          ];
        } else if (v === 0x13) {
          const d = new Date();
          const bcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | n % 10;
          this.rtcBuf = [bcd(d.getHours()), bcd(d.getMinutes()), bcd(d.getSeconds())];
        }
        io[p] = v;
        return;
    }
    // 白黒の本体にはカラーの機能（$40〜$6F の多く）がない
    if (!this.color && p >= 0x40 && p < 0x70) return;
    io[p] = v;
    if ((p >= 0x1c && p < 0x40) || p === 0x60 || p === 0x01) this.display.palDirty = true;
  }

  /** カラーの汎用 DMA（すぐに転送して、その分 CPU を止める） */
  private gdma(): void {
    const io = this.io;
    let src = (io[0x40] | (io[0x41] << 8) | (io[0x42] << 16)) & 0xffffe;
    let dst = (io[0x44] | (io[0x45] << 8)) & 0xfffe;
    let len = (io[0x46] | (io[0x47] << 8)) & 0xfffe;
    const step = io[0x48] & 0x40 ? -2 : 2;
    this.cpu.cycles += 5 + len;
    while (len > 0) {
      this.ram[dst] = this.read8(src);
      this.ram[(dst + 1) & 0xffff] = this.read8((src + 1) & 0xfffff);
      src = (src + step) & 0xfffff;
      dst = (dst + step) & 0xffff;
      len -= 2;
    }
    this.display.palDirty = true;
    io[0x40] = src & 0xff;
    io[0x41] = (src >> 8) & 0xff;
    io[0x42] = src >> 16;
    io[0x44] = dst & 0xff;
    io[0x45] = dst >> 8;
    io[0x46] = io[0x47] = 0;
    io[0x48] &= 0x7f;
  }

  /** サウンド DMA（PCM のデータを音のレジスタへ送る） */
  private soundDma(cycles: number): void {
    const io = this.io;
    const ctrl = io[0x52];
    if (!(ctrl & 0x80)) return;
    const rate = [WS_CLOCK_4K, WS_CLOCK_6K, WS_CLOCK_12K, WS_CLOCK_24K][ctrl & 3];
    this.sdmaTimer -= cycles;
    while (this.sdmaTimer <= 0 && io[0x52] & 0x80) {
      this.sdmaTimer += rate;
      const v = this.read8(this.sdmaSrc & 0xfffff);
      if (!(ctrl & 0x10)) io[0x89] = v; // チャンネル 2 の PCM へ
      this.sdmaSrc = (this.sdmaSrc + (ctrl & 0x40 ? -1 : 1)) & 0xfffff;
      if (--this.sdmaLen <= 0) {
        if (ctrl & 0x08) {
          this.sdmaSrc = io[0x4a] | (io[0x4b] << 8) | ((io[0x4c] & 0x0f) << 16);
          this.sdmaLen = io[0x4e] | (io[0x4f] << 8) | ((io[0x50] & 0x0f) << 16);
        } else io[0x52] &= 0x7f;
      }
    }
  }

  // ---- 割り込み ----
  private raise(bit: number): void {
    if (this.io[0xb2] & (1 << bit)) this.irqStatus |= 1 << bit;
  }

  private checkIrq(): void {
    const pending = this.irqStatus & this.io[0xb2];
    if (!pending) return;
    const cpu = this.cpu;
    cpu.halted = false;
    if (!cpu.canInterrupt()) return;
    const bit = 31 - Math.clz32(pending);
    cpu.interrupt((this.io[0xb0] & 0xf8) + bit);
  }

  /** CPU を cycles クロック分動かす */
  private run(cycles: number): void {
    const cpu = this.cpu;
    let budget = cycles - this.cycleDebt;
    while (budget > 0) {
      this.checkIrq();
      cpu.cycles = 0;
      cpu.step();
      budget -= cpu.cycles;
    }
    this.cycleDebt = -budget;
  }

  /** 1 フレーム分（次の VBlank まで）動かす */
  runFrame(): void {
    this.frameReady = false;
    for (let guard = 0; !this.frameReady && guard < 400; guard++) this.runLine();
  }

  private runLine(): void {
    const io = this.io;
    if (this.line < WS_H) this.display.renderLine(this.line);
    // HBlank タイマー（ラインごとに 1 減る）
    if (io[0xa2] & 1 && this.hTimer > 0) {
      if (--this.hTimer === 0) {
        this.raise(INT_HBLANK_TIMER);
        if (io[0xa2] & 2) this.hTimer = io[0xa4] | (io[0xa5] << 8);
      }
    }
    const total = Math.max(io[0x16], WS_H);
    this.line = this.line >= total ? 0 : this.line + 1;
    if (this.line === WS_H) {
      this.display.latchSprites();
      this.raise(INT_VBLANK);
      if (io[0xa2] & 4 && this.vTimer > 0) {
        if (--this.vTimer === 0) {
          this.raise(INT_VBLANK_TIMER);
          if (io[0xa2] & 8) this.vTimer = io[0xa6] | (io[0xa7] << 8);
        }
      }
      this.frameReady = true;
    }
    if (this.line === io[0x03]) this.raise(INT_LINE);
    // 音と PCM の DMA は半ラインずつ（24kHz の PCM を取りこぼさないように）
    const half = LINE_CYCLES / 2;
    this.run(half);
    this.soundDma(half);
    this.sound.advance(half);
    this.run(half);
    this.soundDma(half);
    this.sound.advance(half);
  }
}

// サウンド DMA の 1 回あたりのクロック数（4k・6k・12k・24kHz）
const WS_CLOCK_4K = 768;
const WS_CLOCK_6K = 512;
const WS_CLOCK_12K = 256;
const WS_CLOCK_24K = 128;
