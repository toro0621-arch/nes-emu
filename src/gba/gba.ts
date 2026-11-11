// ゲームボーイアドバンス本体：メモリ・I/O レジスタ・DMA・タイマー・割り込みと、1 フレームの進め方

import { GbaApu } from './apu';
import { biosImage } from './bios';
import { Arm7, MODE_IRQ, MODE_SVC, MODE_SYS, type ArmBus } from './cpu';
import { GBA_H, GbaPpu } from './ppu';
import { detectSaveType, GbaRtc, GbaSave, hasRtc } from './save';

/** 1 ラインのクロック数（240 ドット × 4 + H ブランク） */
const LINE_CYCLES = 1232;
const HDRAW_CYCLES = 960;
const LINES = 228;

/** GBA の ROM か（ヘッダーの決まった値 0x96 と、任天堂のロゴの先頭） */
export function isGbaRom(d: Uint8Array): boolean {
  return d.length >= 0xc0 && d[0xb2] === 0x96 && d[4] === 0x24 && d[5] === 0xff && d[6] === 0xae && d[7] === 0x51;
}

const SRAM_WAIT = [4, 3, 2, 8];
const N_WAIT = [4, 3, 2, 8];
const PRESCALE = [0, 6, 8, 10];

export class Gba implements ArmBus {
  cycles = 0;
  stopAt = 0;
  irqReady = false;

  readonly cpu: Arm7;
  readonly ppu: GbaPpu;
  readonly apu = new GbaApu();
  readonly save: GbaSave;
  readonly rtc: GbaRtc | null;

  private bios: Uint8Array;
  private bios16: Uint16Array;
  private bios32: Int32Array;
  private ewram = new Uint8Array(0x40000);
  private ewram16 = new Uint16Array(this.ewram.buffer);
  private ewram32 = new Int32Array(this.ewram.buffer);
  private iwram = new Uint8Array(0x8000);
  private iwram16 = new Uint16Array(this.iwram.buffer);
  private iwram32 = new Int32Array(this.iwram.buffer);
  io = new Uint8Array(0x400);
  private io16 = new Uint16Array(this.io.buffer);
  private pal = new Uint8Array(0x400);
  private pal16 = new Uint16Array(this.pal.buffer);
  private pal32 = new Int32Array(this.pal.buffer);
  private vram = new Uint8Array(0x18000);
  private vram16 = new Uint16Array(this.vram.buffer);
  private vram32 = new Int32Array(this.vram.buffer);
  private oam = new Uint8Array(0x400);
  private oam16 = new Uint16Array(this.oam.buffer);
  private oam32 = new Int32Array(this.oam.buffer);
  private rom: Uint8Array;
  private rom16: Uint16Array;
  private rom32: Int32Array;
  private romSize: number;
  /** EEPROM の場所（ROM が 16M バイトより大きいと 0x0DFFFF00〜） */
  private eepromStart: number;

  /** 押されているボタン（KEYINPUT と同じ並び。押すと 1） */
  keys = 0;
  line = 0;
  private lineStart = 0;
  /** BIOS の外から BIOS を読んだときに返す値 */
  private biosLast = 0xe129f000 | 0;
  private dmaLast = 0;

  // 待ち時間（アクセス 1 回のクロック数。アドレスの上位 4 ビットごと）
  private n16 = new Uint8Array(16);
  private s16 = new Uint8Array(16);
  private n32 = new Uint8Array(16);
  private s32 = new Uint8Array(16);
  private fetchCost16 = new Uint8Array(16);
  private fetchCost32 = new Uint8Array(16);

  // DMA（内部のアドレスと残り回数）
  private dmaSrc = new Int32Array(4);
  private dmaDst = new Int32Array(4);
  private dmaCount = new Int32Array(4);
  private dmaBusy = false;

  // タイマー
  private tmCounter = new Int32Array(4);
  private tmReload = new Int32Array(4);
  private tmCtrl = new Int32Array(4);
  private tmAcc = new Float64Array(4);
  private timerLast = 0;
  private timerNext = Infinity;

  constructor(rom: Uint8Array) {
    // ROM は 4 バイト単位に切りそろえる
    const size = (rom.length + 3) & ~3;
    this.rom = new Uint8Array(size);
    this.rom.set(rom);
    this.rom16 = new Uint16Array(this.rom.buffer);
    this.rom32 = new Int32Array(this.rom.buffer);
    this.romSize = rom.length;
    this.eepromStart = rom.length > 0x1000000 ? 0x1ffff00 : 0x1000000;
    this.bios = biosImage();
    this.bios16 = new Uint16Array(this.bios.buffer);
    this.bios32 = new Int32Array(this.bios.buffer);
    this.save = new GbaSave(detectSaveType(rom));
    this.rtc = hasRtc(rom) ? new GbaRtc() : null;
    this.cpu = new Arm7(this);
    this.ppu = new GbaPpu(this.io, this.vram, this.pal, this.oam);
    this.apu.host = this;
    this.setWait(0);
    this.boot();
  }

  /** BIOS の起動画面を飛ばして、BIOS が終わったあとの状態から始める */
  private boot(): void {
    const cpu = this.cpu;
    cpu.setMode(MODE_SYS);
    cpu.setBankedSp(MODE_SVC, 0x03007fe0);
    cpu.setBankedSp(MODE_IRQ, 0x03007fa0);
    cpu.r[13] = 0x03007f00;
    cpu.iflag = 0;
    cpu.fflag = 0;
    cpu.t = 0;
    cpu.pc = 0x08000000;
    this.io16[0x88 >> 1] = 0x200; // SOUNDBIAS
    this.io16[0x134 >> 1] = 0x8000; // RCNT
    this.io[0x300] = 1; // POSTFLG
    this.io16[0x130 >> 1] = 0x3ff;
    this.io16[0x20 >> 1] = 0x100; // BG2PA
    this.io16[0x26 >> 1] = 0x100; // BG2PD
    this.io16[0x30 >> 1] = 0x100;
    this.io16[0x36 >> 1] = 0x100;
  }

  /** どこでもセーブで写さないもの（ROM・BIOS と、同じメモリの別の見え方） */
  stateSkip(): unknown[] {
    return [
      this.rom,
      this.rom16,
      this.rom32,
      this.bios,
      this.bios16,
      this.bios32,
      this.ewram16,
      this.ewram32,
      this.iwram16,
      this.iwram32,
      this.io16,
      this.pal16,
      this.pal32,
      this.vram16,
      this.vram32,
      this.oam16,
      this.oam32,
    ];
  }

  // ───────── 待ち時間 ─────────

  private setWait(w: number): void {
    const set = (r: number, n16: number, s16: number, n32: number, s32: number): void => {
      this.n16[r] = n16;
      this.s16[r] = s16;
      this.n32[r] = n32;
      this.s32[r] = s32;
    };
    for (let r = 0; r < 16; r++) set(r, 1, 1, 1, 1);
    set(2, 3, 3, 6, 6);
    set(5, 1, 1, 2, 2);
    set(6, 1, 1, 2, 2);
    const ws = [
      [N_WAIT[(w >> 2) & 3], [2, 1][(w >> 4) & 1]],
      [N_WAIT[(w >> 5) & 3], [4, 1][(w >> 7) & 1]],
      [N_WAIT[(w >> 8) & 3], [8, 1][(w >> 10) & 1]],
    ];
    for (let k = 0; k < 3; k++) {
      const n = 1 + ws[k][0];
      const s = 1 + ws[k][1];
      set(8 + k * 2, n, s, n + s, s * 2);
      set(9 + k * 2, n, s, n + s, s * 2);
    }
    const sram = 1 + SRAM_WAIT[w & 3];
    set(14, sram, sram, sram, sram);
    set(15, sram, sram, sram, sram);
    for (let r = 0; r < 16; r++) {
      this.fetchCost16[r] = this.s16[r];
      this.fetchCost32[r] = this.s32[r];
    }
    // プリフェッチが有効なら、ROM の命令は待たずに読めることが多い
    if (w & 0x4000) {
      for (let r = 8; r < 14; r++) {
        this.fetchCost16[r] = 1;
        this.fetchCost32[r] = 2;
      }
    }
  }

  branchCost(a: number, thumb: number): number {
    const r = (a >>> 24) & 15;
    return thumb ? this.n16[r] + this.s16[r] - 1 : this.n32[r] + this.s32[r] - 1;
  }

  // ───────── 割り込み ─────────

  private updateIrq(): void {
    const io = this.io16;
    this.irqReady = (io[0x208 >> 1] & 1) !== 0 && (io[0x200 >> 1] & io[0x202 >> 1] & 0x3fff) !== 0;
  }

  /** 割り込みの要求（IF のビットを立てる） */
  raise(bit: number): void {
    this.io16[0x202 >> 1] |= bit;
    this.updateIrq();
  }

  irqWaiting(): boolean {
    return (this.io16[0x200 >> 1] & this.io16[0x202 >> 1] & 0x3fff) !== 0;
  }

  // ───────── メモリ ─────────

  fetch16(a: number): number {
    const r = a >>> 24;
    if (r === 8 || r === 9) {
      this.cycles += this.fetchCost16[r];
      const i = a & 0x1ffffff;
      return i < this.romSize ? this.rom16[i >> 1] : (i >> 1) & 0xffff;
    }
    if (r === 3) {
      this.cycles += 1;
      return this.iwram16[(a & 0x7fff) >> 1];
    }
    if (r === 0 && a < 0x4000) {
      this.cycles += 1;
      this.biosLast = this.bios32[((a + 4) & 0x3ffc) >> 2];
      return this.bios16[a >> 1];
    }
    const v = this.read16(a);
    return v;
  }

  fetch32(a: number): number {
    const r = a >>> 24;
    if (r === 3) {
      this.cycles += 1;
      return this.iwram32[(a & 0x7fff) >> 2];
    }
    if (r === 8 || r === 9) {
      this.cycles += this.fetchCost32[r];
      const i = a & 0x1ffffff;
      return i < this.romSize ? this.rom32[i >> 2] : ((i >> 1) & 0xffff) | (((i >> 1) + 1) << 16);
    }
    if (r === 0 && a < 0x4000) {
      this.cycles += 1;
      this.biosLast = this.bios32[((a + 8) & 0x3ffc) >> 2];
      return this.bios32[a >> 2];
    }
    return this.read32(a);
  }

  private vramIndex(a: number): number {
    const i = a & 0x1ffff;
    return i >= 0x18000 ? i - 0x8000 : i;
  }

  read8(a: number): number {
    const r = a >>> 24;
    if (r > 15) return 0;
    this.cycles += this.n16[r];
    switch (r) {
      case 0:
        if (a >= 0x4000) return 0;
        if (this.cpu.pc >>> 24 !== 0) return (this.biosLast >>> ((a & 3) << 3)) & 0xff;
        return this.bios[a];
      case 2:
        return this.ewram[a & 0x3ffff];
      case 3:
        return this.iwram[a & 0x7fff];
      case 4:
        return (this.ioRead16(a & 0xfffffe) >>> ((a & 1) << 3)) & 0xff;
      case 5:
        return this.pal[a & 0x3ff];
      case 6:
        return this.vram[this.vramIndex(a)];
      case 7:
        return this.oam[a & 0x3ff];
      case 8:
      case 9:
      case 10:
      case 11:
      case 12:
      case 13: {
        const i = a & 0x1ffffff;
        if (i < this.romSize) return this.rom[i];
        return ((i >> 1) >> ((i & 1) << 3)) & 0xff;
      }
      case 14:
      case 15:
        return this.save.read8(a);
    }
    return 0;
  }

  read16(a: number): number {
    const r = a >>> 24;
    if (r > 15) return 0;
    this.cycles += this.n16[r];
    switch (r) {
      case 0:
        if (a >= 0x4000) return 0;
        if (this.cpu.pc >>> 24 !== 0) return (this.biosLast >>> ((a & 2) << 3)) & 0xffff;
        return this.bios16[a >> 1];
      case 2:
        return this.ewram16[(a & 0x3ffff) >> 1];
      case 3:
        return this.iwram16[(a & 0x7fff) >> 1];
      case 4:
        return this.ioRead16(a & 0xfffffe);
      case 5:
        return this.pal16[(a & 0x3ff) >> 1];
      case 6:
        return this.vram16[this.vramIndex(a) >> 1];
      case 7:
        return this.oam16[(a & 0x3ff) >> 1];
      case 8:
      case 9:
      case 10:
      case 11:
      case 12:
      case 13: {
        const i = a & 0x1ffffff;
        if (r === 13 && this.save.type === 'eeprom' && i >= this.eepromStart) return this.save.eepromRead();
        if (this.rtc && i >= 0xc4 && i < 0xca) {
          const v = this.rtc.read16(i);
          if (v >= 0) return v;
        }
        if (i < this.romSize) return this.rom16[i >> 1];
        return (i >> 1) & 0xffff;
      }
      case 14:
      case 15:
        return this.save.read8(a) * 0x101;
    }
    return 0;
  }

  read32(a: number): number {
    const r = a >>> 24;
    if (r > 15) return 0;
    this.cycles += this.n32[r];
    switch (r) {
      case 0:
        if (a >= 0x4000) return 0;
        if (this.cpu.pc >>> 24 !== 0) return this.biosLast;
        return this.bios32[a >> 2];
      case 2:
        return this.ewram32[(a & 0x3ffff) >> 2];
      case 3:
        return this.iwram32[(a & 0x7fff) >> 2];
      case 4:
        return this.ioRead16(a & 0xfffffc) | (this.ioRead16((a & 0xfffffc) + 2) << 16);
      case 5:
        return this.pal32[(a & 0x3ff) >> 2];
      case 6:
        return this.vram32[this.vramIndex(a) >> 2];
      case 7:
        return this.oam32[(a & 0x3ff) >> 2];
      case 8:
      case 9:
      case 10:
      case 11:
      case 12:
      case 13: {
        const i = a & 0x1ffffff;
        if (i < this.romSize && !(this.rtc && i >= 0xc4 && i < 0xca)) return this.rom32[i >> 2];
        this.cycles -= this.n32[r];
        return this.read16(a) | (this.read16(a + 2) << 16);
      }
      case 14:
      case 15:
        return Math.imul(this.save.read8(a), 0x01010101);
    }
    return 0;
  }

  write8(a: number, v: number): void {
    const r = a >>> 24;
    if (r > 15) return;
    this.cycles += this.n16[r];
    switch (r) {
      case 2:
        this.ewram[a & 0x3ffff] = v;
        return;
      case 3:
        this.iwram[a & 0x7fff] = v;
        return;
      case 4:
        this.ioWrite8(a & 0xffffff, v);
        return;
      case 5:
        this.pal16[(a & 0x3fe) >> 1] = v * 0x101;
        return;
      case 6: {
        // 8 ビットの書き込みは BG の場所だけ（2 バイトとも同じ値になる）。OBJ の場所は無視
        const i = this.vramIndex(a);
        const bgEnd = (this.io16[0] & 7) >= 3 ? 0x14000 : 0x10000;
        if (i < bgEnd) this.vram16[i >> 1] = v * 0x101;
        return;
      }
      case 14:
      case 15:
        this.save.write8(a, v);
        return;
    }
  }

  write16(a: number, v: number): void {
    const r = a >>> 24;
    if (r > 15) return;
    this.cycles += this.n16[r];
    switch (r) {
      case 2:
        this.ewram16[(a & 0x3ffff) >> 1] = v;
        return;
      case 3:
        this.iwram16[(a & 0x7fff) >> 1] = v;
        return;
      case 4:
        this.ioWrite16(a & 0xfffffe, v & 0xffff);
        return;
      case 5:
        this.pal16[(a & 0x3ff) >> 1] = v;
        return;
      case 6:
        this.vram16[this.vramIndex(a) >> 1] = v;
        return;
      case 7:
        this.oam16[(a & 0x3ff) >> 1] = v;
        return;
      case 8:
      case 9:
      case 10:
      case 11:
      case 12:
      case 13: {
        const i = a & 0x1ffffff;
        if (r === 13 && this.save.type === 'eeprom' && i >= this.eepromStart) this.save.eepromWrite(v);
        else if (this.rtc && i >= 0xc4 && i < 0xca) this.rtc.write16(i, v);
        return;
      }
      case 14:
      case 15:
        this.save.write8(a, (v >>> ((a & 1) << 3)) & 0xff);
        return;
    }
  }

  write32(a: number, v: number): void {
    const r = a >>> 24;
    if (r > 15) return;
    this.cycles += this.n32[r];
    switch (r) {
      case 2:
        this.ewram32[(a & 0x3ffff) >> 2] = v;
        return;
      case 3:
        this.iwram32[(a & 0x7fff) >> 2] = v;
        return;
      case 4:
        this.ioWrite16(a & 0xfffffc, v & 0xffff);
        this.ioWrite16((a & 0xfffffc) + 2, v >>> 16);
        return;
      case 5:
        this.pal32[(a & 0x3ff) >> 2] = v;
        return;
      case 6:
        this.vram32[this.vramIndex(a) >> 2] = v;
        return;
      case 7:
        this.oam32[(a & 0x3ff) >> 2] = v;
        return;
      case 8:
      case 9:
      case 10:
      case 11:
      case 12:
      case 13:
        this.cycles -= this.n32[r];
        this.write16(a, v & 0xffff);
        this.write16(a + 2, v >>> 16);
        return;
      case 14:
      case 15:
        this.save.write8(a, (v >>> ((a & 3) << 3)) & 0xff);
        return;
    }
  }

  // ───────── I/O レジスタ ─────────

  private ioRead16(a: number): number {
    if (a >= 0x400) return 0;
    const io = this.io16;
    switch (a) {
      case 0x100:
      case 0x104:
      case 0x108:
      case 0x10c:
        this.syncTimers();
        return this.tmCounter[(a - 0x100) >> 2] & 0xffff;
      case 0x130:
        return ~this.keys & 0x3ff;
    }
    if (a >= 0x60 && a < 0xa0) return this.apu.read8(a) | (this.apu.read8(a + 1) << 8);
    // 書き込み専用のレジスタ（BG のスクロールなど）は 0 に見える
    if ((a >= 0x10 && a < 0x48) || (a >= 0x4c && a < 0x50) || (a >= 0x54 && a < 0x60)) return 0;
    if (a >= 0xa0 && a < 0xb8) return 0;
    if (a >= 0xb8 && a < 0xe0) {
      const k = (a - 0xb0) % 12;
      if (k === 10) return io[a >> 1];
      return 0;
    }
    return io[a >> 1];
  }

  private ioWrite8(a: number, v: number): void {
    if (a >= 0x400) return;
    if (a === 0x301) {
      // HALTCNT：HALT（ビット 7 なら STOP。ここでは同じに扱う）
      this.cpu.halted = true;
      this.stopAt = this.cycles;
      return;
    }
    if (a === 0x202 || a === 0x203) {
      this.io16[0x101] &= ~(v << ((a & 1) << 3));
      this.updateIrq();
      return;
    }
    if (a >= 0x60 && a < 0xa8) {
      this.soundWrite8(a, v);
      return;
    }
    const old = this.io16[a >> 1];
    const nv = a & 1 ? (old & 0xff) | (v << 8) : (old & 0xff00) | v;
    this.ioWrite16(a & ~1, nv);
  }

  private soundWrite8(a: number, v: number): void {
    this.apu.write8(a, v, this.cycles);
    if (a < 0xa0) this.io[a] = v;
  }

  private ioWrite16(a: number, v: number): void {
    if (a >= 0x400) return;
    const io = this.io16;
    switch (a) {
      case 0x04:
        io[2] = (io[2] & 7) | (v & 0xff38);
        return;
      case 0x06:
        return;
      case 0x28:
      case 0x2a:
      case 0x2c:
      case 0x2e:
      case 0x38:
      case 0x3a:
      case 0x3c:
      case 0x3e:
        io[a >> 1] = v;
        this.ppu.latchRefs();
        return;
      case 0x130:
        return;
      case 0x132:
        io[a >> 1] = v;
        this.checkKeyIrq();
        return;
      case 0x200:
      case 0x208:
        io[a >> 1] = v;
        this.updateIrq();
        return;
      case 0x202:
        io[0x101] &= ~v;
        this.updateIrq();
        return;
      case 0x204:
        io[a >> 1] = v;
        this.setWait(v);
        return;
      case 0x300:
        this.io[0x300] = v & 1;
        if (v & 0xff00) this.ioWrite8(0x301, v >> 8);
        return;
    }
    if (a >= 0x60 && a < 0xa8) {
      this.soundWrite8(a, v & 0xff);
      this.soundWrite8(a + 1, v >> 8);
      return;
    }
    if (a >= 0xb0 && a < 0xe0) {
      const ch = Math.floor((a - 0xb0) / 12);
      const k = (a - 0xb0) % 12;
      if (k === 10) {
        this.dmaControl(ch, v);
        return;
      }
    }
    if (a >= 0x100 && a < 0x110) {
      const t = (a - 0x100) >> 2;
      if (a & 2) this.timerControl(t, v);
      else this.tmReload[t] = v;
      io[a >> 1] = v;
      return;
    }
    io[a >> 1] = v;
  }

  // ───────── ボタン ─────────

  setKeys(k: number): void {
    this.keys = k & 0x3ff;
    this.checkKeyIrq();
  }

  private checkKeyIrq(): void {
    const cnt = this.io16[0x132 >> 1];
    if (!(cnt & 0x4000)) return;
    const sel = cnt & 0x3ff;
    const hit = cnt & 0x8000 ? (this.keys & sel) === sel && sel !== 0 : (this.keys & sel) !== 0;
    if (hit) this.raise(0x1000);
  }

  // ───────── DMA ─────────

  private dmaControl(ch: number, v: number): void {
    const base = (0xb0 + ch * 12) >> 1;
    const io = this.io16;
    const old = io[base + 5];
    io[base + 5] = v;
    if (!(old & 0x8000) && v & 0x8000) {
      this.dmaSrc[ch] = (io[base] | (io[base + 1] << 16)) & (ch === 0 ? 0x07ffffff : 0x0fffffff);
      this.dmaDst[ch] = (io[base + 2] | (io[base + 3] << 16)) & (ch === 3 ? 0x0fffffff : 0x07ffffff);
      this.dmaLoadCount(ch);
      if (((v >> 12) & 3) === 0) this.runDma(ch);
    }
  }

  private dmaLoadCount(ch: number): void {
    let n = this.io16[((0xb8 + ch * 12) >> 1)];
    if (ch < 3) n &= 0x3fff;
    if (n === 0) n = ch === 3 ? 0x10000 : 0x4000;
    this.dmaCount[ch] = n;
  }

  private runDma(ch: number): void {
    if (this.dmaBusy) return;
    this.dmaBusy = true;
    const cntIndex = (0xba + ch * 12) >> 1;
    const ctrl = this.io16[cntIndex];
    const timing = (ctrl >> 12) & 3;
    const srcCtl = (ctrl >> 7) & 3;
    const dstCtl = (ctrl >> 5) & 3;
    let word = (ctrl & 0x400) !== 0;
    let count = this.dmaCount[ch];
    const fifo = timing === 3 && (ch === 1 || ch === 2);
    if (fifo) {
      word = true;
      count = 4;
    }
    const size = word ? 4 : 2;
    const srcStep = srcCtl === 1 ? -size : srcCtl === 2 ? 0 : size;
    const dstStep = fifo ? 0 : dstCtl === 1 ? -size : dstCtl === 2 ? 0 : size;
    let src = this.dmaSrc[ch];
    let dst = this.dmaDst[ch];
    if (ch === 3 && this.save.type === 'eeprom' && ((src >>> 24) === 13 || (dst >>> 24) === 13)) this.save.eepromHint(count);
    this.cycles += 2;
    for (let k = 0; k < count; k++) {
      if (word) {
        let v: number;
        if (src >>> 0 >= 0x02000000) {
          v = this.read32(src & ~3);
          this.dmaLast = v;
        } else v = this.dmaLast;
        this.write32(dst & ~3, v);
      } else {
        let v: number;
        if (src >>> 0 >= 0x02000000) {
          v = this.read16(src & ~1);
          this.dmaLast = v | (v << 16);
        } else v = this.dmaLast & 0xffff;
        this.write16(dst & ~1, v);
      }
      src = (src + srcStep) | 0;
      dst = (dst + dstStep) | 0;
    }
    this.dmaSrc[ch] = src;
    this.dmaDst[ch] = dst;
    if (ctrl & 0x4000) this.raise(0x100 << ch);
    if (ctrl & 0x200 && timing !== 0) {
      this.dmaLoadCount(ch);
      if (dstCtl === 3) {
        const base = (0xb0 + ch * 12) >> 1;
        this.dmaDst[ch] = (this.io16[base + 2] | (this.io16[base + 3] << 16)) & (ch === 3 ? 0x0fffffff : 0x07ffffff);
      }
    } else this.io16[cntIndex] &= ~0x8000;
    this.dmaBusy = false;
  }

  /** V ブランク（1）・H ブランク（2）で動く DMA */
  private triggerDma(timing: number): void {
    for (let ch = 0; ch < 4; ch++) {
      const ctrl = this.io16[(0xba + ch * 12) >> 1];
      if (ctrl & 0x8000 && ((ctrl >> 12) & 3) === timing) this.runDma(ch);
    }
  }

  fifoRequest(addr: number): void {
    for (let ch = 1; ch <= 2; ch++) {
      const ctrl = this.io16[(0xba + ch * 12) >> 1];
      if (ctrl & 0x8000 && ((ctrl >> 12) & 3) === 3 && this.dmaDst[ch] === addr) this.runDma(ch);
    }
  }

  // ───────── タイマー ─────────

  private timerControl(t: number, v: number): void {
    this.syncTimers();
    const old = this.tmCtrl[t];
    this.tmCtrl[t] = v & 0xc7;
    if (!(old & 0x80) && v & 0x80) {
      this.tmCounter[t] = this.tmReload[t];
      this.tmAcc[t] = 0;
    }
    this.scheduleTimers();
  }

  /** 今の時刻までタイマーを進める */
  private syncTimers(): void {
    const now = this.cycles;
    const elapsed = now - this.timerLast;
    this.timerLast = now;
    if (elapsed <= 0) return;
    for (let t = 0; t < 4; t++) {
      const ctrl = this.tmCtrl[t];
      if (!(ctrl & 0x80) || (t > 0 && ctrl & 4)) continue;
      const shift = PRESCALE[ctrl & 3];
      const acc = this.tmAcc[t] + elapsed;
      const ticks = Math.floor(acc / (1 << shift));
      this.tmAcc[t] = acc - ticks * (1 << shift);
      if (ticks) this.tickTimer(t, ticks);
    }
    this.scheduleTimers();
  }

  private tickTimer(t: number, n: number): void {
    let c = this.tmCounter[t] + n;
    if (c >= 0x10000) {
      const period = 0x10000 - this.tmReload[t];
      while (c >= 0x10000) {
        c -= period;
        this.timerOverflow(t);
      }
    }
    this.tmCounter[t] = c;
  }

  private timerOverflow(t: number): void {
    if (this.tmCtrl[t] & 0x40) this.raise(8 << t);
    if (t < 2) this.apu.timerOverflow(t, this.cycles);
    if (t < 3) {
      const next = this.tmCtrl[t + 1];
      if (next & 0x80 && next & 4) this.tickTimer(t + 1, 1);
    }
  }

  private scheduleTimers(): void {
    let next = Infinity;
    for (let t = 0; t < 4; t++) {
      const ctrl = this.tmCtrl[t];
      if (!(ctrl & 0x80) || (t > 0 && ctrl & 4)) continue;
      const rem = (0x10000 - this.tmCounter[t]) * (1 << PRESCALE[ctrl & 3]) - this.tmAcc[t];
      if (rem < next) next = rem;
    }
    this.timerNext = this.cycles + Math.max(1, next);
    if (this.timerNext < this.stopAt) this.stopAt = this.timerNext;
  }

  // ───────── 1 フレーム ─────────

  private runUntil(t: number): void {
    while (this.cycles < t) {
      this.stopAt = this.timerNext < t ? this.timerNext : t;
      this.cpu.run();
      if (this.cycles >= this.timerNext) this.syncTimers();
    }
  }

  runFrame(): void {
    for (let i = 0; i < LINES; i++) this.runLine();
    this.syncTimers();
    this.apu.sync(this.cycles);
  }

  private runLine(): void {
    const io = this.io16;
    const y = this.line;
    this.runUntil(this.lineStart + HDRAW_CYCLES);
    // H ブランク
    if (y < GBA_H) this.ppu.renderLine(y);
    io[2] |= 2;
    if (io[2] & 0x10) this.raise(2);
    if (y < GBA_H) this.triggerDma(2);
    this.runUntil(this.lineStart + LINE_CYCLES);
    this.lineStart += LINE_CYCLES;
    this.apu.sync(this.cycles);

    // 次のライン
    const ny = y + 1 === LINES ? 0 : y + 1;
    this.line = ny;
    io[3] = ny;
    io[2] &= ~2;
    if (ny === GBA_H) {
      io[2] |= 1;
      if (io[2] & 8) this.raise(1);
      this.triggerDma(1);
      this.ppu.latchRefs();
    } else if (ny === LINES - 1) io[2] &= ~1;
    if (ny === io[2] >> 8) {
      io[2] |= 4;
      if (io[2] & 0x20) this.raise(4);
    } else io[2] &= ~4;
  }
}
