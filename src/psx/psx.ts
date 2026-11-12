// プレイステーション本体：メモリの並び、DMA、割り込み、タイマー、時間の進め方をまとめる

import { Cdrom } from './cdrom';
import { R3000, type PsxBus } from './cpu';
import type { Disc } from './disc';
import { Gpu } from './gpu';
import { Gte } from './gte';
import { Mdec } from './mdec';
import { Sio } from './sio';
import { Spu } from './spu';
import { PsxTimers } from './timers';

export const CPU_CLOCK = 33868800;
/** 1 ラインの CPU のクロック（NTSC・PAL） */
const LINE_NTSC = 2172;
const LINE_PAL = 2169;
const LINES_NTSC = 263;
const LINES_PAL = 314;

export class Psx implements PsxBus {
  ram = new Uint8Array(2 * 1024 * 1024);
  ram16 = new Uint16Array(this.ram.buffer);
  ram32 = new Int32Array(this.ram.buffer);
  bios: Uint8Array;
  bios32: Int32Array;
  scratch = new Uint8Array(1024);
  scratch32 = new Int32Array(this.scratch.buffer);
  scratch16 = new Uint16Array(this.scratch.buffer);

  cycles = 0;
  stopAt = 0;
  irqPending = false;
  writes = 0;
  volatileRead = false;
  hookPc = -1;

  istat = 0;
  imask = 0;
  cacheCtrl = 0;
  memCtrl = new Uint32Array(16);
  ramSize = 0xb88;
  // DMA
  madr = new Uint32Array(7);
  bcr = new Uint32Array(7);
  chcr = new Uint32Array(7);
  dpcr = 0x07654321;
  dicr = 0;

  gte = new Gte();
  cpu: R3000;
  gpu = new Gpu();
  timers: PsxTimers;
  cdrom: Cdrom;
  spu: Spu;
  mdec = new Mdec();
  sio: Sio;

  pal = false;
  line = 0;
  frame = 0;
  /** 読み込む EXE（BIOS が起動し終わったところで差し込む） */
  private exe: Uint8Array | null = null;
  /** printf などの出力（テスト用） */
  tty = '';

  constructor(bios: Uint8Array) {
    this.bios = new Uint8Array(512 * 1024);
    this.bios.set(bios.subarray(0, 512 * 1024));
    this.bios32 = new Int32Array(this.bios.buffer);
    const now = () => this.cycles;
    this.cpu = new R3000(this, this.gte);
    this.timers = new PsxTimers(now, (n) => this.raise(n));
    this.cdrom = new Cdrom(now, () => this.raise(2));
    this.spu = new Spu(() => this.raise(9), this.cdrom.audio);
    this.sio = new Sio(now, () => this.raise(7));
    this.gpu.onIrq = () => this.raise(1);
  }

  get lineCycles(): number {
    return this.pal ? LINE_PAL : LINE_NTSC;
  }
  get lines(): number {
    return this.pal ? LINES_PAL : LINES_NTSC;
  }
  get fps(): number {
    return CPU_CLOCK / (this.lineCycles * this.lines);
  }

  insertDisc(d: Disc | null): void {
    this.cdrom.disc = d;
  }

  /** EXE を読み込んで実行する（BIOS の起動を待ってから） */
  loadExe(exe: Uint8Array): void {
    this.exe = exe;
    this.hookPc = 0x80030000 | 0;
  }

  onHook(): void {
    const e = this.exe;
    this.hookPc = -1;
    if (!e) return;
    this.exe = null;
    const dv = new DataView(e.buffer, e.byteOffset, e.byteLength);
    const pc = dv.getUint32(0x10, true);
    const gp = dv.getUint32(0x14, true);
    const dest = dv.getUint32(0x18, true);
    const size = dv.getUint32(0x1c, true);
    const sp = dv.getUint32(0x30, true) + dv.getUint32(0x34, true);
    for (let i = 0; i < size && 0x800 + i < e.length; i++) this.ram[(dest + i) & 0x1fffff] = e[0x800 + i];
    const r = this.cpu.r;
    r[28] = gp;
    if (sp) {
      r[29] = sp;
      r[30] = sp;
    }
    this.cpu.jump(pc);
  }

  // ---- 割り込み ----
  raise(n: number): void {
    this.istat |= 1 << n;
    this.irqPending = (this.istat & this.imask) !== 0;
  }

  // ---- メモリ ----
  fetch(a: number): number {
    const p = a & 0x1fffffff;
    if (p < 0x800000) return this.ram32[(p & 0x1fffff) >> 2];
    if (p >= 0x1fc00000 && p < 0x1fc80000) {
      this.cycles += 4;
      return this.bios32[(p & 0x7ffff) >> 2];
    }
    return 0;
  }

  read32(a: number): number {
    const p = a & 0x1fffffff;
    if (p < 0x800000) return this.ram32[(p & 0x1fffff) >> 2];
    if (p >= 0x1f800000 && p < 0x1f800400) return this.scratch32[(p & 0x3ff) >> 2];
    if (p >= 0x1fc00000 && p < 0x1fc80000) return this.bios32[(p & 0x7ffff) >> 2];
    if (a >>> 0 === 0xfffe0130) return this.cacheCtrl;
    return this.io32(p);
  }

  read16(a: number): number {
    const p = a & 0x1fffffff;
    if (p < 0x800000) return this.ram16[(p & 0x1fffff) >> 1];
    if (p >= 0x1f800000 && p < 0x1f800400) return this.scratch16[(p & 0x3ff) >> 1];
    if (p >= 0x1fc00000 && p < 0x1fc80000) return this.bios[p & 0x7ffff] | (this.bios[(p & 0x7ffff) + 1] << 8);
    return this.io16(p);
  }

  read8(a: number): number {
    const p = a & 0x1fffffff;
    if (p < 0x800000) return this.ram[p & 0x1fffff];
    if (p >= 0x1f800000 && p < 0x1f800400) return this.scratch[p & 0x3ff];
    if (p >= 0x1fc00000 && p < 0x1fc80000) return this.bios[p & 0x7ffff];
    return this.io8(p);
  }

  write32(a: number, v: number): void {
    this.writes++;
    const p = a & 0x1fffffff;
    if (p < 0x800000) {
      this.ram32[(p & 0x1fffff) >> 2] = v;
      return;
    }
    if (p >= 0x1f800000 && p < 0x1f800400) {
      this.scratch32[(p & 0x3ff) >> 2] = v;
      return;
    }
    if (a >>> 0 === 0xfffe0130) {
      this.cacheCtrl = v;
      return;
    }
    this.ioWrite32(p, v);
  }

  write16(a: number, v: number): void {
    this.writes++;
    const p = a & 0x1fffffff;
    if (p < 0x800000) {
      this.ram16[(p & 0x1fffff) >> 1] = v;
      return;
    }
    if (p >= 0x1f800000 && p < 0x1f800400) {
      this.scratch16[(p & 0x3ff) >> 1] = v;
      return;
    }
    this.ioWrite16(p, v & 0xffff);
  }

  write8(a: number, v: number): void {
    this.writes++;
    const p = a & 0x1fffffff;
    if (p < 0x800000) {
      this.ram[p & 0x1fffff] = v;
      return;
    }
    if (p >= 0x1f800000 && p < 0x1f800400) {
      this.scratch[p & 0x3ff] = v;
      return;
    }
    this.ioWrite8(p, v & 0xff);
  }

  // ---- 入出力 ----
  private io32(p: number): number {
    this.volatileRead = true;
    if (p >= 0x1f801080 && p < 0x1f801100) return this.dmaRead(p);
    switch (p) {
      case 0x1f801070:
        return this.istat;
      case 0x1f801074:
        return this.imask;
      case 0x1f801810:
        return this.gpu.read();
      case 0x1f801814: {
        return this.gpu.stat | 0;
      }
      case 0x1f801820:
        return this.mdec.read();
      case 0x1f801824:
        return this.mdec.status | 0;
      case 0x1f801060:
        return this.ramSize;
    }
    if (p >= 0x1f801000 && p < 0x1f801040) return this.memCtrl[(p >> 2) & 15];
    if (p >= 0x1f801100 && p < 0x1f801130) return this.timers.read(p);
    if (p >= 0x1f801c00 && p < 0x1f802000) return this.spu.read(p) | (this.spu.read(p + 2) << 16);
    return (this.io16(p) | (this.io16(p + 2) << 16)) | 0;
  }

  private io16(p: number): number {
    this.volatileRead = true;
    if (p >= 0x1f801c00 && p < 0x1f802000) return this.spu.read(p);
    if (p >= 0x1f801100 && p < 0x1f801130) return this.timers.read(p);
    switch (p) {
      case 0x1f801040:
        return this.sio.readData() | 0;
      case 0x1f801044:
        this.sio.tick();
        return this.sio.stat;
      case 0x1f801048:
        return this.sio.mode;
      case 0x1f80104a:
        return this.sio.ctrl;
      case 0x1f80104e:
        return this.sio.baud;
      case 0x1f801070:
        return this.istat & 0xffff;
      case 0x1f801074:
        return this.imask & 0xffff;
    }
    if (p >= 0x1f801800 && p < 0x1f801804) return this.io8(p) | (this.io8(p + 1) << 8);
    if (p >= 0x1f801080 && p < 0x1f801100) return this.dmaRead(p & ~3) >>> ((p & 2) * 8) & 0xffff;
    if (p >= 0x1f801810 && p < 0x1f801828) return (this.io32(p & ~3) >>> ((p & 2) * 8)) & 0xffff;
    return 0;
  }

  private io8(p: number): number {
    this.volatileRead = true;
    if (p >= 0x1f801800 && p < 0x1f801804) return this.cdrom.read(p);
    if (p === 0x1f801040) return this.sio.readData();
    if (p >= 0x1f000000 && p < 0x1f080000) return 0xff; // 拡張ポート（何もつながっていない）
    if (p >= 0x1f801080 && p < 0x1f801100) return (this.dmaRead(p & ~3) >>> ((p & 3) * 8)) & 0xff;
    return (this.io16(p & ~1) >> ((p & 1) * 8)) & 0xff;
  }

  private ioWrite32(p: number, v: number): void {
    if (p >= 0x1f801080 && p < 0x1f801100) return this.dmaWrite(p, v);
    switch (p) {
      case 0x1f801070:
        this.istat &= v;
        this.irqPending = (this.istat & this.imask) !== 0;
        return;
      case 0x1f801074:
        this.imask = v & 0x7ff;
        this.irqPending = (this.istat & this.imask) !== 0;
        return;
      case 0x1f801810:
        this.gpu.gp0(v);
        return;
      case 0x1f801814:
        this.gpu.gp1(v);
        this.updateDotClock();
        return;
      case 0x1f801820:
        this.mdec.write(v);
        return;
      case 0x1f801824:
        this.mdec.control(v);
        return;
      case 0x1f801060:
        this.ramSize = v;
        return;
    }
    if (p >= 0x1f801000 && p < 0x1f801040) {
      this.memCtrl[(p >> 2) & 15] = v;
      return;
    }
    if (p >= 0x1f801100 && p < 0x1f801130) {
      this.timers.write(p, v);
      this.soon(this.timers.nextEvent());
      return;
    }
    if (p >= 0x1f801c00 && p < 0x1f802000) {
      this.spu.write(p, v & 0xffff);
      this.spu.write(p + 2, v >>> 16);
      return;
    }
    this.ioWrite16(p, v & 0xffff);
    this.ioWrite16(p + 2, v >>> 16);
  }

  private ioWrite16(p: number, v: number): void {
    if (p >= 0x1f801c00 && p < 0x1f802000) {
      this.spu.write(p, v);
      return;
    }
    if (p >= 0x1f801100 && p < 0x1f801130) {
      this.timers.write(p, v);
      this.soon(this.timers.nextEvent());
      return;
    }
    switch (p) {
      case 0x1f801040:
        this.sio.writeData(v & 0xff);
        this.soon(this.sio.pendingAt);
        return;
      case 0x1f801048:
        this.sio.mode = v;
        return;
      case 0x1f80104a:
        this.sio.writeCtrl(v);
        return;
      case 0x1f80104e:
        this.sio.baud = v;
        return;
      case 0x1f801070:
        this.istat &= v | 0xffff0000;
        this.irqPending = (this.istat & this.imask) !== 0;
        return;
      case 0x1f801074:
        this.imask = v & 0x7ff;
        this.irqPending = (this.istat & this.imask) !== 0;
        return;
    }
    if (p >= 0x1f801800 && p < 0x1f801804) {
      this.cdrom.write(p, v & 0xff);
      return;
    }
    if (p >= 0x1f801080 && p < 0x1f801100) {
      const a = p & ~3;
      const sh = (p & 2) * 8;
      const old = this.dmaRead(a);
      this.dmaWrite(a, (old & ~(0xffff << sh)) | (v << sh));
    }
  }

  private ioWrite8(p: number, v: number): void {
    if (p >= 0x1f801800 && p < 0x1f801804) {
      this.cdrom.write(p, v);
      this.soon(this.cdrom.nextEvent());
      return;
    }
    if (p === 0x1f801040) {
      this.sio.writeData(v);
      this.soon(this.sio.pendingAt);
      return;
    }
    if (p === 0x1f802041) return; // POST の表示
    if (p === 0x1f802023 || p === 0x1f802080) {
      this.tty += String.fromCharCode(v);
      return;
    }
    if (p >= 0x1f801080 && p < 0x1f801100) {
      const a = p & ~3;
      const sh = (p & 3) * 8;
      const old = this.dmaRead(a);
      this.dmaWrite(a, (old & ~(0xff << sh)) | (v << sh));
      return;
    }
    this.ioWrite16(p & ~1, v << ((p & 1) * 8));
  }

  private updateDotClock(): void {
    const m = this.gpu.dispMode;
    const div = m & 0x40 ? 7 : [10, 8, 5, 4][m & 3];
    this.timers.dotCycles = (div * 7) / 11;
    this.gpu.pal = (m & 8) !== 0;
  }

  // ---- DMA ----
  private dmaRead(p: number): number {
    if (p === 0x1f8010f0) return this.dpcr | 0;
    if (p === 0x1f8010f4) return this.dicr | 0;
    const ch = (p >> 4) & 7;
    if (ch > 6) return 0;
    switch (p & 0xc) {
      case 0:
        return this.madr[ch] | 0;
      case 4:
        return this.bcr[ch] | 0;
      case 8:
        return this.chcr[ch] | 0;
    }
    return 0;
  }

  private dmaWrite(p: number, v: number): void {
    if (p === 0x1f8010f0) {
      this.dpcr = v >>> 0;
      return;
    }
    if (p === 0x1f8010f4) {
      // 下位：書き換え。24〜30 ビット：1 を書くと消える
      const flags = (this.dicr & ~(v & 0x7f000000)) & 0x7f000000;
      this.dicr = ((v & 0x00ff803f) | flags) >>> 0;
      this.updateDicr(false);
      return;
    }
    const ch = (p >> 4) & 7;
    if (ch > 6) return;
    switch (p & 0xc) {
      case 0:
        this.madr[ch] = v & 0xffffff;
        return;
      case 4:
        this.bcr[ch] = v >>> 0;
        return;
      case 8:
        if (ch === 6) this.chcr[ch] = ((v & 0x51000000) | 0x2) >>> 0;
        else this.chcr[ch] = v >>> 0;
        this.tryDma(ch);
        return;
    }
  }

  private updateDicr(edge: boolean): void {
    const flags = (this.dicr >>> 24) & 0x7f;
    const en = (this.dicr >>> 16) & 0x7f;
    const master = (this.dicr & 0x8000) !== 0 || ((this.dicr & 0x800000) !== 0 && (flags & en) !== 0);
    const was = (this.dicr & 0x80000000) !== 0;
    if (master) this.dicr = (this.dicr | 0x80000000) >>> 0;
    else this.dicr = (this.dicr & 0x7fffffff) >>> 0;
    if (master && (!was || edge)) this.raise(3);
  }

  /** 始める条件がそろったら、全部いっぺんに転送する */
  tryDma(ch: number): void {
    const c = this.chcr[ch];
    const sync = (c >> 9) & 3;
    const go = sync === 0 ? (c & 0x01000000) !== 0 && (c & 0x10000000) !== 0 : (c & 0x01000000) !== 0;
    if (!go) return;
    // MDEC から出すのは、出せるものがあるときだけ
    this.runDma(ch);
    this.chcr[ch] = (this.chcr[ch] & ~0x11000000) >>> 0;
    if (this.dicr & (1 << (16 + ch))) {
      this.dicr = (this.dicr | (1 << (24 + ch))) >>> 0;
      this.updateDicr(true);
    }
  }

  private runDma(ch: number): void {
    const c = this.chcr[ch];
    const sync = (c >> 9) & 3;
    const toRam = (c & 1) === 0;
    const step = c & 2 ? -4 : 4;
    let addr = this.madr[ch] & 0x1ffffc;
    const ram = this.ram32;
    if (sync === 2) {
      // つながったリスト（GPU のコマンド）
      let guard = 0;
      for (;;) {
        const hdr = ram[addr >> 2];
        const n = hdr >>> 24;
        for (let i = 1; i <= n; i++) this.gpu.gp0(ram[((addr + i * 4) & 0x1ffffc) >> 2]);
        this.cycles += n + 1;
        if (hdr & 0x800000 || ++guard > 0x100000) break;
        addr = hdr & 0x1ffffc;
      }
      this.madr[ch] = 0xffffff;
      return;
    }
    let words: number;
    if (sync === 0) words = this.bcr[ch] & 0xffff || 0x10000;
    else words = (this.bcr[ch] & 0xffff || 0x10000) * (this.bcr[ch] >>> 16);
    this.cycles += words;
    for (let i = 0; i < words; i++) {
      const a = addr >> 2;
      switch (ch) {
        case 0:
          this.mdec.write(ram[a]);
          break;
        case 1:
          ram[a] = this.mdec.read();
          break;
        case 2:
          if (toRam) ram[a] = this.gpu.read();
          else this.gpu.gp0(ram[a]);
          break;
        case 3:
          ram[a] = this.cdrom.readWord();
          break;
        case 4:
          if (toRam) ram[a] = this.spu.dmaRead();
          else this.spu.dmaWrite(ram[a]);
          break;
        case 6:
          ram[a] = i === words - 1 ? 0xffffff : (addr - 4) & 0x1fffff;
          break;
      }
      addr = (addr + step) & 0x1ffffc;
    }
    if (sync === 1) {
      this.madr[ch] = addr;
      this.bcr[ch] &= 0xffff;
    }
  }

  // ---- 時間を進める ----
  /** 出来事が早まったら、CPU を早めに止める */
  private soon(t: number): void {
    if (t >= 0 && t < this.stopAt) this.stopAt = Math.max(t, this.cycles + 1);
  }

  /** 次に出来事が起きる時刻（CPU を止める時刻） */
  private nextEvent(limit: number): number {
    let t = limit;
    const c = this.cdrom.nextEvent();
    if (c < t) t = c;
    const tm = this.timers.nextEvent();
    if (tm < t) t = tm;
    if (this.sio.pendingAt >= 0 && this.sio.pendingAt < t) t = this.sio.pendingAt;
    return t;
  }

  private events(): void {
    this.cdrom.tick();
    this.sio.tick();
    this.timers.syncAll();
  }

  /** 1 フレーム（1 回の垂直帰線まで）進める */
  runFrame(): void {
    const lc = this.lineCycles;
    const lines = this.lines;
    const vblankLine = this.pal ? 288 : 240;
    for (let l = 0; l < lines; l++) {
      this.line = l;
      const end = this.cycles + lc;
      const hblankAt = end - Math.round(lc * 0.18);
      let inHblank = false;
      while (this.cycles < end) {
        const lim = !inHblank && hblankAt > this.cycles ? hblankAt : end;
        this.stopAt = this.nextEvent(lim);
        if (this.stopAt <= this.cycles) this.stopAt = this.cycles + 1;
        this.cpu.run();
        this.events();
        if (!inHblank && this.cycles >= hblankAt) {
          inHblank = true;
          this.timers.setHblank(true);
          this.timers.hblank();
        }
      }
      this.timers.setHblank(false);
      this.gpu.lineOdd ^= 1;
      if (l === vblankLine) {
        this.raise(0);
        this.timers.setVblank(true);
        this.gpu.render();
        this.gpu.field ^= 1;
      }
      if (l === lines - 1) this.timers.setVblank(false);
      this.spu.run(this.cycles);
    }
    this.frame++;
  }

  stateSkip(): unknown[] {
    return [this.ram16, this.ram32, this.bios, this.bios32, this.scratch32, this.scratch16, this.exe];
  }
}
