// NINTENDO64 本体：メモリの並び、割り込み（MI）、画面（VI）、音（AI）、カートリッジ（PI）、
// コントローラーとセーブ（SI・PIF）、絵と音の計算機（RSP・RDP）をまとめて、1 フレームずつ進める

import { CYCLES_PER_OP, Vr4300, type N64Bus } from './cpu';
import { Jit } from './jit';
import { Rdp } from './rdp';
import { Rsp } from './rsp';

export const N64_CLOCK = 93750000;

// MI の割り込みの番号
export const INT_SP = 0;
export const INT_SI = 1;
export const INT_AI = 2;
export const INT_VI = 3;
export const INT_PI = 4;
export const INT_DP = 5;

/** セーブの置き場所：SRAM・フラッシュ 128KB のあとに EEPROM 2KB */
export const SAVE_SIZE = 0x20000 + 0x800;
const EEP_OFF = 0x20000;

/** EEPROM が 16K のゲーム（カートリッジの ID の 2〜3 文字目）。それ以外は 4K として答える */
const EEP16K = new Set(['YS', 'B7', 'FU', 'DO', 'PD', 'MV', 'MX', 'K4', 'M8', 'EP', 'CW', 'CZ', 'D6', 'R7', 'P3', 'IJ', 'N6', 'UB', 'KJ', 'GV', '3D', 'RZ', 'D2', 'JF', 'XO', 'B5']);

/** ROM をこの機械のワードの並び（.n64 と同じ）にそろえる */
export function normalizeRom(d: Uint8Array): Uint8Array {
  const n = (d.length + 3) & ~3;
  const out = new Uint8Array(n);
  out.set(d);
  const m = (d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3];
  if (m === (0x80371240 | 0)) {
    // .z64（ビッグエンディアン）
    for (let i = 0; i < n; i += 4) {
      const a = out[i];
      const b = out[i + 1];
      out[i] = out[i + 3];
      out[i + 1] = out[i + 2];
      out[i + 2] = b;
      out[i + 3] = a;
    }
  } else if (m === 0x37804012) {
    // .v64（2 バイトずつ逆）
    for (let i = 0; i < n; i += 4) {
      const a = out[i];
      const b = out[i + 1];
      out[i] = out[i + 2];
      out[i + 1] = out[i + 3];
      out[i + 2] = a;
      out[i + 3] = b;
    }
  }
  return out;
}

export function isN64Rom(d: Uint8Array): boolean {
  if (d.length < 0x1000) return false;
  const m = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
  return m === 0x80371240 || m === 0x37804012 || m === 0x40123780;
}

/** コントローラーのボタン（上位バイトから） */
export const N64PAD = {
  A: 0x8000,
  B: 0x4000,
  Z: 0x2000,
  START: 0x1000,
  UP: 0x0800,
  DOWN: 0x0400,
  LEFT: 0x0200,
  RIGHT: 0x0100,
  L: 0x0020,
  R: 0x0010,
  CUP: 0x0008,
  CDOWN: 0x0004,
  CLEFT: 0x0002,
  CRIGHT: 0x0001,
} as const;

export class N64 implements N64Bus {
  // RDRAM 8MB（拡張パックつき）
  ramSize = 8 * 1024 * 1024;
  ram8 = new Uint8Array(this.ramSize);
  ram16 = new Uint16Array(this.ram8.buffer);
  ram32 = new Int32Array(this.ram8.buffer);
  rom8: Uint8Array;
  rom32: Int32Array;
  /** SP の DMEM + IMEM（8KB） */
  spMem8 = new Uint8Array(0x2000);
  spMem32 = new Int32Array(this.spMem8.buffer);
  pifRam = new Uint8Array(64);
  save = new Uint8Array(SAVE_SIZE);
  saveDirty = false;

  cycles = 0;
  stopAt = 0;
  miPending = false;
  writes = 0;
  volatileRead = false;

  cpu: Vr4300;
  rsp: Rsp;
  rdp: Rdp;

  // MI
  miMode = 0;
  miIntr = 0;
  miMask = 0;
  // VI
  vi = new Uint32Array(16);
  viLine = 0;
  private viField = 0;
  // AI
  aiAddr = 0;
  aiLen = 0;
  aiCtrl = 0;
  aiDacrate = 0;
  aiBitrate = 0;
  /** 鳴らしているバッファが終わる時刻（-1 = 鳴らしていない） */
  aiEndAt = -1;
  /** 次に待っているバッファ（-1 = なし） */
  aiNextLen = -1;
  aiNextAddr = 0;
  // PI
  pi = new Uint32Array(16);
  piAt = -1;
  // SI
  siAddr = 0;
  siAt = -1;
  siStatus = 0;
  // RI・RDRAM のレジスタ
  ri = new Uint32Array(8);
  rdramRegs = new Uint32Array(0x100);
  // フラッシュ
  private flashMode = 0;
  private flashStatus = 0;
  private flashOffset = 0;
  private flashBuf = new Uint8Array(128);
  private flashUsed = false;
  // コントローラー
  buttons = 0;
  stickX = 0;
  stickY = 0;
  private eep16k = false;
  pal = false;

  // 画面
  frameBuffer = new Uint32Array(320 * 240);
  outW = 320;
  outH = 240;
  // 音
  sampleRate = 48000;
  rateAdjust = 1;
  spread = 1;
  samples = new Float32Array(32768);
  sampleLength = 0;
  private resample = 0;
  frame = 0;
  /** このフレームは絵を描かない（重いときに間引く） */
  skipDraw = false;

  constructor(rom: Uint8Array, useJit = true) {
    const r = normalizeRom(rom);
    // 2 のべき乗に広げなくてよい。4 バイト単位で持つ
    this.rom8 = new Uint8Array(new ArrayBuffer(r.length));
    this.rom8.set(r);
    this.rom32 = new Int32Array(this.rom8.buffer);
    this.cpu = new Vr4300(this);
    if (useJit) this.cpu.jit = new Jit(this.cpu, this.ramSize);
    this.rdp = new Rdp(this);
    this.rsp = new Rsp(this);
    const id = String.fromCharCode(this.romByte(0x3c), this.romByte(0x3d));
    this.eep16k = EEP16K.has(id);
    const country = this.romByte(0x3e);
    this.pal = 'DFIPSUXY'.includes(String.fromCharCode(country));
    this.boot();
  }

  private romByte(i: number): number {
    return this.rom8[i ^ 3];
  }

  get fps(): number {
    return this.pal ? 50 : 60;
  }

  /** 電源を入れた直後の状態にする（本体の起動 ROM がやることを代わりにする） */
  private boot(): void {
    // カートリッジの先頭 4KB を SP の DMEM へ
    for (let i = 0; i < 0x1000 && i < this.rom8.length; i += 4) this.spMem32[i >> 2] = this.rom32[i >> 2];
    // 起動プログラム（IPL3）の種類を調べる
    let sum = 0;
    for (let i = 0x40; i < 0x1000; i += 4) sum += this.rom32[i >> 2] >>> 0;
    let seed = 0x3f;
    let cic = 6102;
    switch (sum) {
      case 0xd6497e414b:
        seed = 0x78;
        cic = 6103;
        break;
      case 0x11a49f60e96:
        seed = 0x91;
        cic = 6105;
        break;
      case 0xd6d5be5580:
        seed = 0x85;
        cic = 6106;
        break;
    }
    const c = this.cpu;
    const set = (r: number, v: number) => {
      c.lo[r] = v | 0;
      c.hi[r] = (v | 0) >> 31;
    };
    set(1, 1);
    set(2, 0x0ebda536);
    set(3, 0x0ebda536);
    set(4, 0xa536);
    set(5, 0xc0f1d859);
    set(6, 0xa4001f0c);
    set(7, 0xa4001f08);
    set(8, 0xc0);
    set(10, 0x40);
    set(11, 0xa4000040);
    set(12, 0xed10d0b3);
    set(13, 0x1402a4cc);
    set(14, 0x2de108ea);
    set(15, 0x3103e121);
    set(19, 0);
    set(20, this.pal ? 0 : 1);
    set(21, 0);
    set(22, seed);
    set(23, 0);
    set(25, 0x9debb54f);
    set(29, 0xa4001ff0);
    set(31, 0xa4001550);
    if (cic === 6105) {
      const stub = [0x3c0dbfc0, 0x8da807fc, 0x25ad07c0, 0x31080080, 0x5500fffc, 0x3c0dbfc0, 0x8da80024, 0x3c0bb000];
      for (let i = 0; i < stub.length; i++) this.spMem32[(0x1000 >> 2) + i] = stub[i];
    }
    this.pifRam[0x24] = 0;
    this.pifRam[0x25] = cic === 6105 ? 2 : 0;
    this.pifRam[0x26] = seed;
    this.pifRam[0x27] = seed;
    c.status = 0x34000000;
    c.jump(0xa4000040);
    // メモリの初期化は済んでいることにする（8MB）
    this.ri[3] = 0x14; // RI_SELECT
    this.ri[0] = 0x0e;
    this.ri[1] = 0x40;
    this.ram32[0x318 >> 2] = this.ramSize;
    this.ram32[0x3f0 >> 2] = this.ramSize;
    this.vi[6] = 0x20d; // V_SYNC
    this.miMode = 0;
    this.rsp.status = 1;
  }

  // ---- 割り込み ----
  raise(n: number): void {
    this.miIntr |= 1 << n;
    this.updateMi();
  }
  lower(n: number): void {
    this.miIntr &= ~(1 << n);
    this.updateMi();
  }
  private updateMi(): void {
    this.miPending = (this.miIntr & this.miMask) !== 0;
    this.cpu.updateInt();
    if (this.miPending && this.stopAt > this.cycles + CYCLES_PER_OP) this.stopAt = this.cycles + CYCLES_PER_OP;
  }

  // ---- メモリ（物理アドレス） ----
  read32(p: number): number {
    if (p < this.ramSize) return this.ram32[p >> 2];
    if (p >= 0x10000000 && p < 0x1fc00000) {
      const i = p - 0x10000000;
      return i < this.rom8.length ? this.rom32[i >> 2] : 0;
    }
    // 入出力のレジスタは「出来事」のときにしか変わらない（出来事の時刻で CPU を止めている）ので、
    // それを読み続けるだけのループも飛ばしてよい。時間とともに変わる AI の残りの長さだけは別
    if (p >= 0x04000000 && p < 0x04002000) return this.spMem32[(p & 0x1fff) >> 2];
    switch (p >>> 20) {
      case 0x03f:
        return this.rdramRegs[(p >> 2) & 0xff] | 0;
      case 0x040:
        return this.rsp.readReg(p);
      case 0x041:
        return this.rdp.readReg((p >> 2) & 7);
      case 0x043:
        switch (p & 0xc) {
          case 0:
            return this.miMode;
          case 4:
            return 0x02020102;
          case 8:
            return this.miIntr;
          default:
            return this.miMask;
        }
      case 0x044: {
        const r = (p >> 2) & 15;
        if (r === 4) return this.viLine;
        return this.vi[r] | 0;
      }
      case 0x045:
        this.volatileRead = true;
        switch (p & 0x1c) {
          case 4:
            return this.aiRemaining();
          case 0xc: {
            let s = 0x01100000;
            if (this.aiEndAt >= 0) s |= 0x40000000;
            if (this.aiNextLen >= 0) s |= 0x80000001;
            return s | 0;
          }
        }
        return this.aiRemaining();
      case 0x046: {
        const r = (p >> 2) & 15;
        if (r === 4) return (this.piAt >= 0 ? 1 : 0) | (this.miIntr & (1 << INT_PI) ? 8 : 0);
        return this.pi[r] | 0;
      }
      case 0x047:
        return this.ri[(p >> 2) & 7] | 0;
      case 0x048:
        if ((p & 0x1c) === 0x18) return (this.siAt >= 0 ? 1 : 0) | (this.miIntr & (1 << INT_SI) ? 0x1000 : 0);
        return this.siAddr;
    }
    if (p >= 0x1fc007c0 && p < 0x1fc00800) {
      const i = p - 0x1fc007c0;
      return (this.pifRam[i] << 24) | (this.pifRam[i + 1] << 16) | (this.pifRam[i + 2] << 8) | this.pifRam[i + 3];
    }
    if (p >= 0x08000000 && p < 0x08020000) {
      // フラッシュの状態（SRAM のゲームはここを直接は読まない）
      return this.flashStatus | 0;
    }
    return 0;
  }

  read16(p: number): number {
    if (p < this.ramSize) return this.ram16[(p ^ 2) >> 1];
    return (this.read32(p & ~3) >>> ((2 - (p & 2)) * 8)) & 0xffff;
  }

  read8(p: number): number {
    if (p < this.ramSize) return this.ram8[p ^ 3];
    return (this.read32(p & ~3) >>> ((3 - (p & 3)) * 8)) & 0xff;
  }

  write32(p: number, v: number): void {
    if (p < this.ramSize) {
      this.ram32[p >> 2] = v;
      return;
    }
    if (p >= 0x04000000 && p < 0x04002000) {
      this.spMem32[(p & 0x1fff) >> 2] = v;
      if (p & 0x1000) this.rsp.jit?.invalidate(p & 0xffc, 4);
      return;
    }
    switch (p >>> 20) {
      case 0x03f:
        this.rdramRegs[(p >> 2) & 0xff] = v;
        return;
      case 0x040:
        this.rsp.writeReg(p, v);
        return;
      case 0x041:
        this.rdp.writeReg((p >> 2) & 7, v);
        return;
      case 0x043:
        switch (p & 0xc) {
          case 0:
            this.miMode = (this.miMode & ~0x7f) | (v & 0x7f);
            if (v & 0x80) this.miMode &= ~0x80;
            if (v & 0x100) this.miMode |= 0x80;
            if (v & 0x200) this.miMode &= ~0x100;
            if (v & 0x400) this.miMode |= 0x100;
            if (v & 0x800) this.lower(INT_DP);
            if (v & 0x1000) this.miMode &= ~0x200;
            if (v & 0x2000) this.miMode |= 0x200;
            return;
          case 0xc:
            for (let i = 0; i < 6; i++) {
              if (v & (1 << (i * 2))) this.miMask &= ~(1 << i);
              if (v & (2 << (i * 2))) this.miMask |= 1 << i;
            }
            this.updateMi();
            return;
        }
        return;
      case 0x044: {
        const r = (p >> 2) & 15;
        if (r === 4) {
          this.lower(INT_VI);
          return;
        }
        this.vi[r] = v;
        return;
      }
      case 0x045:
        switch (p & 0x1c) {
          case 0:
            this.aiAddr = v & 0xffffff;
            return;
          case 4:
            this.aiPush(v & 0x3fff8);
            return;
          case 8:
            this.aiCtrl = v & 1;
            return;
          case 0xc:
            this.lower(INT_AI);
            return;
          case 0x10:
            this.aiDacrate = v & 0x3fff;
            return;
          case 0x14:
            this.aiBitrate = v & 0xf;
            return;
        }
        return;
      case 0x046: {
        const r = (p >> 2) & 15;
        switch (r) {
          case 0:
            this.pi[0] = v & 0xffffff;
            return;
          case 1:
            this.pi[1] = v;
            return;
          case 2:
            this.pi[2] = v & 0xffffff;
            this.piDma(false);
            return;
          case 3:
            this.pi[3] = v & 0xffffff;
            this.piDma(true);
            return;
          case 4:
            if (v & 2) this.lower(INT_PI);
            return;
        }
        this.pi[r] = v & 0xff;
        return;
      }
      case 0x047:
        this.ri[(p >> 2) & 7] = v;
        return;
      case 0x048:
        switch (p & 0x1c) {
          case 0:
            this.siAddr = v & 0xffffff;
            return;
          case 4:
            this.pifRun();
            this.siDma(true);
            return;
          case 0x10:
            this.siDma(false);
            return;
          case 0x18:
            this.lower(INT_SI);
            return;
        }
        return;
    }
    if (p >= 0x1fc007c0 && p < 0x1fc00800) {
      const i = p - 0x1fc007c0;
      this.pifRam[i] = v >>> 24;
      this.pifRam[i + 1] = (v >> 16) & 0xff;
      this.pifRam[i + 2] = (v >> 8) & 0xff;
      this.pifRam[i + 3] = v & 0xff;
      this.pifControl();
      // 直接書いたときも SI の割り込みが来る
      this.siAt = this.cycles + 3000;
      this.soon(this.siAt);
      return;
    }
    if (p >= 0x08010000 && p < 0x08020000) this.flashCommand(v);
  }

  write16(p: number, v: number): void {
    if (p < this.ramSize) {
      this.ram16[(p ^ 2) >> 1] = v;
      return;
    }
    // 入出力への 16 ビットの書き込みは、ずらした 32 ビットの値として届く
    this.write32(p & ~3, v << ((2 - (p & 2)) * 8));
  }

  write8(p: number, v: number): void {
    if (p < this.ramSize) {
      this.ram8[p ^ 3] = v;
      return;
    }
    if (p >= 0x04000000 && p < 0x04002000) {
      this.spMem8[(p & 0x1fff) ^ 3] = v;
      if (p & 0x1000) this.rsp.jit?.invalidate(p & 0xffc, 4);
      return;
    }
    this.write32(p & ~3, v << ((3 - (p & 3)) * 8));
  }

  private soon(t: number): void {
    if (t >= 0 && t < this.stopAt) this.stopAt = Math.max(t, this.cycles + 1);
  }

  // ---- PI（カートリッジ） ----
  private piDma(toRam: boolean): void {
    const len = (this.pi[toRam ? 3 : 2] & 0xffffff) + 1;
    const cart = this.pi[1] >>> 0;
    const dram = this.pi[0] & 0xfffffe;
    if (toRam) {
      if (cart >= 0x10000000 && cart < 0x1fc00000) {
        const src = cart - 0x10000000;
        const rom = this.rom8;
        const ram = this.ram8;
        const n = Math.min(len, this.ramSize - dram);
        if (!((src | dram | n) & 3) && src + n <= rom.length) {
          this.ram32.set(this.rom32.subarray(src >> 2, (src + n) >> 2), dram >> 2);
        } else {
          for (let i = 0; i < n; i++) {
            const s = src + i;
            ram[(dram + i) ^ 3] = s < rom.length ? rom[s ^ 3] : 0;
          }
        }
      } else if (cart >= 0x08000000 && cart < 0x08020000) {
        this.saveRead(cart - 0x08000000, dram, len);
      }
    } else if (cart >= 0x08000000 && cart < 0x08020000) {
      this.saveWrite(cart - 0x08000000, dram, len);
    }
    if (toRam) this.cpu.jit?.invalidateRange(dram, len);
    this.pi[0] = (dram + len + 7) & 0xfffff8;
    this.pi[1] = (cart + len + 1) & ~1;
    this.writes++;
    // 少したってから終わりの割り込み
    this.piAt = this.cycles + Math.min(20000, 1000 + len * 2);
    this.soon(this.piAt);
  }

  // ---- セーブ（SRAM・フラッシュ） ----
  private saveRead(off: number, dram: number, len: number): void {
    const ram = this.ram8;
    if (this.flashUsed) {
      if (this.flashMode === 1) {
        // 状態・ID
        const id = [0x11118001, 0x00c2001e];
        for (let i = 0; i < len; i++) ram[(dram + i) ^ 3] = (id[(i >> 2) & 1] >>> ((3 - (i & 3)) * 8)) & 0xff;
        return;
      }
      const base = (off & 0xffff) * 2;
      for (let i = 0; i < len; i++) ram[(dram + i) ^ 3] = this.save[(base + i) & 0x1ffff];
      return;
    }
    for (let i = 0; i < len; i++) ram[(dram + i) ^ 3] = this.save[(off + i) & 0x1ffff];
  }

  private saveWrite(off: number, dram: number, len: number): void {
    const ram = this.ram8;
    if (this.flashUsed) {
      // 書き込みモード：1 ページぶんの入れ物へ
      for (let i = 0; i < Math.min(len, 128); i++) this.flashBuf[i] = ram[(dram + i) ^ 3];
      return;
    }
    for (let i = 0; i < len; i++) this.save[(off + i) & 0x1ffff] = ram[(dram + i) ^ 3];
    this.saveDirty = true;
  }

  private flashCommand(v: number): void {
    this.flashUsed = true;
    switch (v >>> 24) {
      case 0x4b:
        this.flashOffset = (v & 0xffff) * 128;
        return;
      case 0x78:
        this.flashMode = 2; // 消去
        this.flashStatus = 0x11118008;
        return;
      case 0xa5:
        this.flashOffset = (v & 0xffff) * 128;
        this.flashStatus = 0x11118004;
        return;
      case 0xb4:
        this.flashMode = 3; // 書き込み
        return;
      case 0xd2:
        if (this.flashMode === 2) {
          // セクター（128 ページ）ごとの消去
          const s = this.flashOffset & ~0x3fff;
          this.save.fill(0xff, s, Math.min(0x20000, s + 0x4000));
          this.saveDirty = true;
        } else if (this.flashMode === 3) {
          this.save.set(this.flashBuf, this.flashOffset & 0x1ff80);
          this.saveDirty = true;
        }
        return;
      case 0xe1:
        this.flashMode = 1;
        this.flashStatus = 0x11118001;
        return;
      case 0xf0:
        this.flashMode = 0;
        this.flashStatus = 0x11118004;
        return;
    }
  }

  // ---- SI・PIF（コントローラー・EEPROM） ----
  private siDma(toRam: boolean): void {
    const a = this.siAddr & 0xfffffc;
    const ram = this.ram8;
    if (toRam) {
      for (let i = 0; i < 64; i++) ram[(a + i) ^ 3] = this.pifRam[i];
      this.cpu.jit?.invalidateRange(a, 64);
    }
    else {
      for (let i = 0; i < 64; i++) this.pifRam[i] = ram[(a + i) ^ 3];
      this.pifControl();
    }
    this.writes++;
    this.siAt = this.cycles + 6000;
    this.soon(this.siAt);
  }

  /** PIF の最後のバイトの命令 */
  private pifControl(): void {
    const c = this.pifRam[63];
    if (c & 0x08) this.pifRam[63] &= ~0x08; // 起動の終わり
    if (c & 0x20) this.pifRam[63] = 0x80;
    if (c & 0x40) this.pifRam[63] &= ~0x40;
    if (c & 0x02) {
      // CIC との合言葉（6105 の合言葉はまだ計算しない。0 を返す）
      for (let i = 48; i < 63; i++) this.pifRam[i] = 0;
      this.pifRam[63] &= ~0x02;
    }
  }

  /** コントローラー・EEPROM とのやりとり（ジョイバス）を実行する */
  private pifRun(): void {
    const r = this.pifRam;
    if (!(r[63] & 1)) return;
    let ch = 0;
    let i = 0;
    while (i < 63 && ch < 6) {
      const tx = r[i];
      if (tx === 0xfe) break;
      if (tx === 0xff) {
        i++;
        continue;
      }
      if (tx === 0 || tx === 0xfd) {
        ch++;
        i++;
        continue;
      }
      const n = tx & 0x3f;
      const rxAt = i + 1;
      const rx = r[rxAt] & 0x3f;
      const cmdAt = i + 2;
      const out = cmdAt + n;
      if (out + rx > 64) break;
      const cmd = r[cmdAt];
      if (ch === 0) {
        switch (cmd) {
          case 0x00:
          case 0xff:
            r[out] = 0x05;
            r[out + 1] = 0x00;
            r[out + 2] = 0x02; // コントローラーパックなし
            break;
          case 0x01:
            r[out] = this.buttons >> 8;
            r[out + 1] = this.buttons & 0xff;
            r[out + 2] = this.stickX & 0xff;
            r[out + 3] = this.stickY & 0xff;
            break;
          case 0x02:
          case 0x03:
            // パックがない
            r[rxAt] |= 0x80;
            break;
          default:
            r[rxAt] |= 0x80;
        }
      } else if (ch === 4) {
        switch (cmd) {
          case 0x00:
          case 0xff:
            r[out] = 0x00;
            r[out + 1] = this.eep16k ? 0xc0 : 0x80;
            r[out + 2] = 0x00;
            break;
          case 0x04: {
            const blk = r[cmdAt + 1];
            for (let k = 0; k < 8; k++) r[out + k] = this.save[EEP_OFF + ((blk * 8 + k) & 0x7ff)];
            break;
          }
          case 0x05: {
            const blk = r[cmdAt + 1];
            for (let k = 0; k < 8; k++) this.save[EEP_OFF + ((blk * 8 + k) & 0x7ff)] = r[cmdAt + 2 + k];
            r[out] = 0;
            this.saveDirty = true;
            break;
          }
          default:
            r[rxAt] |= 0x80;
        }
      } else {
        // つながっていない
        r[rxAt] |= 0x80;
      }
      ch++;
      i = out + rx;
    }
  }

  // ---- AI（音） ----
  private get aiFreq(): number {
    return (this.pal ? 49656530 : 48681812) / (this.aiDacrate + 1);
  }

  private aiRemaining(): number {
    if (this.aiEndAt < 0) return 0;
    const left = Math.max(0, this.aiEndAt - this.cycles);
    return (Math.floor((left / N64_CLOCK) * this.aiFreq) * 4) & 0x3fff8;
  }

  private aiPush(len: number): void {
    if (!len) return;
    if (this.aiEndAt < 0) this.aiStart(this.aiAddr, len);
    else {
      this.aiNextLen = len;
      this.aiNextAddr = this.aiAddr;
    }
  }

  private aiStart(addr: number, len: number): void {
    const freq = this.aiFreq;
    const dur = Math.round(((len / 4) / freq) * N64_CLOCK);
    this.aiEndAt = Math.max(this.cycles, this.aiEndAt) + dur;
    this.soon(this.aiEndAt);
    this.aiLen = len;
    // 出力の周波数に合わせて書き出す
    const step = freq / (this.sampleRate * this.rateAdjust);
    const n = len >> 2;
    const ram16 = this.ram16;
    const base = (addr & 0xfffffe) >> 1;
    let p = this.resample;
    const out = this.samples;
    while (p < n) {
      const i = Math.floor(p);
      const l = ((ram16[(base + i * 2) ^ 1] << 16) >> 16) / 32768;
      const r = ((ram16[(base + i * 2 + 1) ^ 1] << 16) >> 16) / 32768;
      const mid = (l + r) / 2;
      const side = ((l - r) / 2) * this.spread;
      if (this.sampleLength + 1 < out.length) {
        out[this.sampleLength++] = mid + side;
        out[this.sampleLength++] = mid - side;
      }
      p += step;
    }
    this.resample = p - n;
  }

  takeSamples(): Float32Array {
    const o = this.samples.slice(0, this.sampleLength);
    this.sampleLength = 0;
    return o;
  }

  // ---- 時間を進める ----
  private events(): void {
    const now = this.cycles;
    this.cpu.checkTimer();
    if (this.piAt >= 0 && now >= this.piAt) {
      this.piAt = -1;
      this.raise(INT_PI);
    }
    if (this.siAt >= 0 && now >= this.siAt) {
      this.siAt = -1;
      this.raise(INT_SI);
    }
    if (this.aiEndAt >= 0 && now >= this.aiEndAt) {
      if (this.aiNextLen >= 0) {
        const l = this.aiNextLen;
        this.aiNextLen = -1;
        this.aiStart(this.aiNextAddr, l);
      } else this.aiEndAt = -1;
      this.raise(INT_AI);
    }
    this.rsp.tick();
  }

  private nextEvent(limit: number): number {
    let t = limit;
    if (this.cpu.timerAt < t) t = this.cpu.timerAt;
    if (this.piAt >= 0 && this.piAt < t) t = this.piAt;
    if (this.siAt >= 0 && this.siAt < t) t = this.siAt;
    if (this.aiEndAt >= 0 && this.aiEndAt < t) t = this.aiEndAt;
    const r = this.rsp.nextAt;
    if (r >= 0 && r < t) t = r;
    return t;
  }

  runFrame(): void {
    const lines = ((this.vi[6] & 0x3ff) || 0x20c) + 1;
    const frameCycles = Math.round(N64_CLOCK / this.fps);
    const start = this.cycles;
    const intr = this.vi[3] & 0x3ff;
    for (let l = 0; l < lines; l++) {
      this.viLine = (l & ~1) | this.viField;
      if ((l & ~1) === (intr & ~1) && !(l & 1)) {
        this.raise(INT_VI);
        if (!this.skipDraw) this.render();
      }
      const end = start + Math.floor(((l + 1) * frameCycles) / lines);
      while (this.cycles < end) {
        this.stopAt = this.nextEvent(end);
        if (this.stopAt <= this.cycles) this.stopAt = this.cycles + 1;
        this.cpu.run();
        this.events();
      }
    }
    if (this.vi[0] & 0x40) this.viField ^= 1;
    else this.viField = 0;
    this.frame++;
  }

  /** VI の設定どおりに RDRAM の絵を画面バッファへ */
  render(): void {
    const ctrl = this.vi[0];
    const type = ctrl & 3;
    const stride = this.vi[2] & 0xfff;
    const h0 = (this.vi[9] >>> 16) & 0x3ff;
    const h1 = this.vi[9] & 0x3ff;
    const v0 = (this.vi[10] >>> 16) & 0x3ff;
    const v1 = this.vi[10] & 0x3ff;
    const xs = this.vi[12] & 0xfff;
    const ys = this.vi[13] & 0xfff;
    let w = ((h1 - h0) * xs) >> 10;
    let h = (((v1 - v0) >> 1) * ys) >> 10;
    if (type < 2 || !stride || w <= 0 || h <= 0) {
      this.frameBuffer.fill(0xff000000);
      return;
    }
    w = Math.min(w, 720, stride);
    h = Math.min(h, 576);
    if (this.outW !== w || this.outH !== h || this.frameBuffer.length !== w * h) {
      this.outW = w;
      this.outH = h;
      this.frameBuffer = new Uint32Array(w * h);
    }
    const fb = this.frameBuffer;
    const origin = this.vi[1] & 0xffffff;
    if (type === 2) {
      const ram16 = this.ram16;
      const base = origin >> 1;
      const max = this.ramSize >> 1;
      for (let y = 0; y < h; y++) {
        const row = base + y * stride;
        const o = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          const c = i < max ? ram16[i ^ 1] : 0;
          const r = (c >> 11) & 31;
          const g = (c >> 6) & 31;
          const b = (c >> 1) & 31;
          fb[o + x] = 0xff000000 | (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2));
        }
      }
    } else {
      const ram32 = this.ram32;
      const base = origin >> 2;
      const max = this.ramSize >> 2;
      for (let y = 0; y < h; y++) {
        const row = base + y * stride;
        const o = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          const c = i < max ? ram32[i] : 0;
          fb[o + x] = 0xff000000 | ((c >>> 8) & 0xff) << 16 | ((c >>> 16) & 0xff) << 8 | (c >>> 24);
        }
      }
    }
  }

  stateSkip(): unknown[] {
    return [this.ram16, this.ram32, this.rom8, this.rom32, this.spMem32, this.frameBuffer, this.samples];
  }
}
