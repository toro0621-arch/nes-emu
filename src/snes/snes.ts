// スーパーファミコン本体：メモリの並び・I/O レジスタ・DMA と HDMA・割り込み（NMI・IRQ）・コントローラー・1 フレームの流れ

import { SnesApu } from './apu';
import { cartInfo, mirrorRom, stripCopier, type SnesCartInfo } from './cart';
import { W65816, type W65Bus } from './cpu';
import { SnesPpu } from './ppu';

/** 1 ラインのマスタークロック数と、1 フレームのライン数（NTSC） */
export const LINE_CYCLES = 1364;
export const LINES = 262;
export const MASTER_CLOCK = 21477272;
/** H ブランクのはじまり（ここで 1 ライン描いて HDMA を動かす） */
const HBLANK_START = 1104;

/** DMA の転送モード：1 単位で書く B バスのアドレスのずれ */
const DMA_PATTERN = [[0], [0, 1], [0, 0], [0, 0, 1, 1], [0, 1, 2, 3], [0, 1, 0, 1], [0, 0], [0, 0, 1, 1]];

export class Snes implements W65Bus {
  cycles = 0;
  stopAt = 0;
  nmiPending = false;
  irqLine = false;
  writes = 0;
  volatileRead = false;

  readonly cpu: W65816;
  readonly ppu = new SnesPpu();
  readonly apu = new SnesApu();
  readonly info: SnesCartInfo;
  private rom: Uint8Array;
  private romMask: number;
  sram: Uint8Array;
  sramDirty = false;
  private wram = new Uint8Array(0x20000);
  private wramAddr = 0;
  /** データバスに最後に乗った値（何もないところを読むと返る） */
  private mdr = 0;

  // CPU のレジスタ
  private nmitimen = 0;
  private wrio = 0xff;
  private mulA = 0xff;
  private divA = 0xffff;
  private rdmpy = 0;
  private rddiv = 0;
  private htime = 0x1ff;
  private vtime = 0x1ff;
  private fastRom = false;
  private rdnmi = false;
  private timeup = false;
  // DMA
  private dmaRegs = new Uint8Array(0x80);
  private hdmaen = 0;
  private hdmaDo = new Uint8Array(8);
  private hdmaEnd = new Uint8Array(8);
  // コントローラー（ボタンは B Y SELECT START ↑ ↓ ← → A X L R の順で上位ビットから）
  pad1 = 0;
  private joy = new Uint16Array(4);
  private latchPads = false;
  private serial1 = 0;
  private serial2 = 0;
  private autoJoyBusy = 0;

  line = 0;
  private lineStart = 0;
  private apuTime = 0;
  /** そのフレームで描いたか（強制ブランクのまま終わったときの判定などに） */
  frame = 0;

  constructor(data: Uint8Array) {
    const raw = stripCopier(data);
    this.info = cartInfo(raw);
    if (this.info.chip) throw new Error(`このソフトはカセットの中の追加チップ（${this.info.chip}）が必要で、まだ動きません`);
    this.rom = mirrorRom(raw);
    this.romMask = this.rom.length - 1;
    this.sram = new Uint8Array(this.info.sramSize || 0);
    this.fastRom = false;
    this.cpu = new W65816(this);
    this.ppu.counters = () => [Math.min(339, Math.floor((this.cycles - this.lineStart) / 4)), this.line];
    this.cpu.reset();
  }

  /** どこでもセーブで写さないもの（ROM） */
  stateSkip(): unknown[] {
    return [this.rom];
  }

  // ───────── バス ─────────

  idle(): void {
    this.cycles += 6;
  }

  /** アクセスにかかるマスタークロック（6 = 速い、8 = ふつう、12 = 遅い） */
  private speed(a: number): number {
    const bank = a >>> 16;
    const off = a & 0xffff;
    if (bank & 0x40) {
      if (bank >= 0xc0) return this.fastRom ? 6 : 8;
      return 8;
    }
    if (off & 0x8000) return bank & 0x80 && this.fastRom ? 6 : 8;
    if (off < 0x2000) return 8;
    if (off < 0x4000) return 6;
    if (off < 0x4200) return 12;
    if (off < 0x6000) return 6;
    return 8;
  }

  read(a: number): number {
    this.cycles += this.speed(a);
    const v = this.readNoTime(a);
    if (v >= 0) this.mdr = v;
    return this.mdr;
  }

  write(a: number, v: number): void {
    this.writes++;
    this.cycles += this.speed(a);
    this.mdr = v;
    this.writeNoTime(a, v);
  }

  /** 読む（何もなければ -1 = オープンバス） */
  private readNoTime(a: number): number {
    const bank = a >>> 16;
    const off = a & 0xffff;
    if (bank === 0x7e || bank === 0x7f) return this.wram[a & 0x1ffff];
    if (!(bank & 0x40) && off < 0x8000) {
      if (off < 0x2000) return this.wram[off];
      if (off < 0x2100) return -1;
      if (off < 0x2200) return this.readB(off & 0xff);
      if (off < 0x4000) return -1;
      if (off < 0x4200) {
        this.volatileRead = true;
        if (off === 0x4016) return (this.mdr & 0xfc) | this.readSerial(0);
        if (off === 0x4017) return (this.mdr & 0xe0) | 0x1c | this.readSerial(1);
        return -1;
      }
      if (off < 0x4400) return this.readCpuReg(off);
      if (off < 0x6000) return -1;
    }
    return this.cartRead(bank, off);
  }

  private writeNoTime(a: number, v: number): void {
    const bank = a >>> 16;
    const off = a & 0xffff;
    if (bank === 0x7e || bank === 0x7f) {
      this.wram[a & 0x1ffff] = v;
      return;
    }
    if (!(bank & 0x40) && off < 0x8000) {
      if (off < 0x2000) {
        this.wram[off] = v;
        return;
      }
      if (off < 0x2100) return;
      if (off < 0x2200) {
        this.writeB(off & 0xff, v);
        return;
      }
      if (off < 0x4000) return;
      if (off < 0x4200) {
        if (off === 0x4016) {
          const l = (v & 1) !== 0;
          if (l) this.reloadSerial();
          this.latchPads = l;
        }
        return;
      }
      if (off < 0x4400) {
        this.writeCpuReg(off, v);
        return;
      }
      if (off < 0x6000) return;
    }
    this.cartWrite(bank, off, v);
  }

  // ───────── カートリッジ ─────────

  private cartRead(bank: number, off: number): number {
    const map = this.info.map;
    const sram = this.sram;
    if (map === 'lorom') {
      const b = bank & 0x7f;
      if (sram.length && b >= 0x70 && b < 0x7e && off < 0x8000) return sram[((b & 0x0f) * 0x8000 + off) % sram.length];
      if (off < 0x8000 && b < 0x40) return -1;
      return this.rom[((b << 15) | (off & 0x7fff)) & this.romMask];
    }
    if (map === 'hirom' || map === 'exhirom') {
      const b = bank & 0x7f;
      if (sram.length && b >= 0x20 && b < 0x40 && off >= 0x6000 && off < 0x8000)
        return sram[(((b & 0x1f) << 13) | (off - 0x6000)) % sram.length];
      if (b < 0x40 && off < 0x8000) return -1;
      let i = ((bank & 0x3f) << 16) | off;
      if (map === 'exhirom' && !(bank & 0x80)) i += 0x400000;
      return this.rom[i & this.romMask];
    }
    return -1;
  }

  private cartWrite(bank: number, off: number, v: number): void {
    const sram = this.sram;
    if (!sram.length) return;
    const b = bank & 0x7f;
    let i = -1;
    if (this.info.map === 'lorom') {
      if (b >= 0x70 && b < 0x7e && off < 0x8000) i = ((b & 0x0f) * 0x8000 + off) % sram.length;
    } else if (b >= 0x20 && b < 0x40 && off >= 0x6000 && off < 0x8000) i = (((b & 0x1f) << 13) | (off - 0x6000)) % sram.length;
    if (i >= 0 && sram[i] !== v) {
      sram[i] = v;
      this.sramDirty = true;
    }
  }

  // ───────── B バス（$2100〜$21FF：画面・音・WRAM のポート） ─────────

  private readB(r: number): number {
    if (r >= 0x34 && r < 0x40) {
      if (r >= 0x37) this.volatileRead = true;
      return this.ppu.read(r);
    }
    if (r >= 0x40 && r < 0x80) {
      this.volatileRead = true;
      this.syncApu();
      return this.apu.portOut[r & 3];
    }
    if (r === 0x80) {
      const v = this.wram[this.wramAddr];
      this.wramAddr = (this.wramAddr + 1) & 0x1ffff;
      return v;
    }
    return -1;
  }

  private writeB(r: number, v: number): void {
    if (r < 0x34) {
      this.ppu.write(r, v);
      return;
    }
    if (r >= 0x40 && r < 0x80) {
      this.syncApu();
      this.apu.portIn[r & 3] = v;
      return;
    }
    switch (r) {
      case 0x80:
        this.wram[this.wramAddr] = v;
        this.wramAddr = (this.wramAddr + 1) & 0x1ffff;
        break;
      case 0x81:
        this.wramAddr = (this.wramAddr & 0x1ff00) | v;
        break;
      case 0x82:
        this.wramAddr = (this.wramAddr & 0x100ff) | (v << 8);
        break;
      case 0x83:
        this.wramAddr = (this.wramAddr & 0xffff) | ((v & 1) << 16);
        break;
    }
  }

  /** 音の部分を今の時刻まで進める */
  syncApu(): void {
    const n = this.cycles - this.apuTime;
    if (n > 0) {
      this.apuTime = this.cycles;
      this.apu.runMaster(n);
    }
  }

  // ───────── CPU のレジスタ（$4200〜） ─────────

  private hpos(): number {
    return this.cycles - this.lineStart;
  }

  private vblankStart(): number {
    return this.ppu.setini & 4 ? 240 : 225;
  }

  private readCpuReg(off: number): number {
    switch (off) {
      case 0x4210: {
        const v = (this.rdnmi ? 0x80 : 0) | 0x02 | (this.mdr & 0x70);
        this.rdnmi = false;
        return v;
      }
      case 0x4211: {
        const v = (this.timeup ? 0x80 : 0) | (this.mdr & 0x7f);
        this.timeup = false;
        this.irqLine = false;
        return v;
      }
      case 0x4212: {
        const h = this.hpos();
        const vb = this.line >= this.vblankStart();
        const hb = h < 4 || h >= HBLANK_START - 8;
        const busy = this.autoJoyBusy > 0 && this.cycles < this.autoJoyBusy;
        return (vb ? 0x80 : 0) | (hb ? 0x40 : 0) | (busy ? 1 : 0) | (this.mdr & 0x3e);
      }
      case 0x4213:
        return this.wrio;
      case 0x4214:
        return this.rddiv & 0xff;
      case 0x4215:
        return this.rddiv >> 8;
      case 0x4216:
        return this.rdmpy & 0xff;
      case 0x4217:
        return this.rdmpy >> 8;
      case 0x4218:
      case 0x4219:
      case 0x421a:
      case 0x421b:
      case 0x421c:
      case 0x421d:
      case 0x421e:
      case 0x421f: {
        const j = this.joy[(off - 0x4218) >> 1];
        return off & 1 ? j >> 8 : j & 0xff;
      }
    }
    if (off >= 0x4300 && off < 0x4380) {
      const r = off & 0x0f;
      if (r === 0x0b || r === 0x0f) return this.dmaRegs[off & 0x7f];
      if (r > 0x0b) return -1;
      return this.dmaRegs[off & 0x7f];
    }
    return -1;
  }

  private writeCpuReg(off: number, v: number): void {
    switch (off) {
      case 0x4200: {
        const old = this.nmitimen;
        this.nmitimen = v;
        if (!(v & 0x30)) {
          this.irqLine = false;
          this.timeup = false;
        }
        // V ブランク中に NMI を有効にすると、すぐに NMI が起きる
        if (!(old & 0x80) && v & 0x80 && this.rdnmi) this.nmiPending = true;
        return;
      }
      case 0x4201:
        if (this.wrio & 0x80 && !(v & 0x80)) this.ppu.latch();
        this.wrio = v;
        return;
      case 0x4202:
        this.mulA = v;
        return;
      case 0x4203:
        this.rdmpy = this.mulA * v;
        this.rddiv = v;
        return;
      case 0x4204:
        this.divA = (this.divA & 0xff00) | v;
        return;
      case 0x4205:
        this.divA = (this.divA & 0xff) | (v << 8);
        return;
      case 0x4206:
        if (v === 0) {
          this.rddiv = 0xffff;
          this.rdmpy = this.divA;
        } else {
          this.rddiv = Math.floor(this.divA / v);
          this.rdmpy = this.divA % v;
        }
        return;
      case 0x4207:
        this.htime = (this.htime & 0x100) | v;
        return;
      case 0x4208:
        this.htime = (this.htime & 0xff) | ((v & 1) << 8);
        return;
      case 0x4209:
        this.vtime = (this.vtime & 0x100) | v;
        return;
      case 0x420a:
        this.vtime = (this.vtime & 0xff) | ((v & 1) << 8);
        return;
      case 0x420b:
        for (let ch = 0; ch < 8; ch++) if (v & (1 << ch)) this.runDma(ch);
        return;
      case 0x420c:
        this.hdmaen = v;
        return;
      case 0x420d:
        this.fastRom = (v & 1) !== 0;
        return;
    }
    if (off >= 0x4300 && off < 0x4380) this.dmaRegs[off & 0x7f] = v;
  }

  // ───────── DMA ─────────

  private runDma(ch: number): void {
    const r = this.dmaRegs;
    const base = ch << 4;
    const ctrl = r[base];
    const bAddr = r[base + 1];
    let addr = r[base + 2] | (r[base + 3] << 8);
    const bank = r[base + 4];
    let count = r[base + 5] | (r[base + 6] << 8);
    if (count === 0) count = 0x10000;
    const pattern = DMA_PATTERN[ctrl & 7];
    const step = (ctrl >> 3) & 3;
    const toA = (ctrl & 0x80) !== 0;
    this.cycles += 8;
    let i = 0;
    while (count > 0) {
      const b = 0x2100 | ((bAddr + pattern[i % pattern.length]) & 0xff);
      const a = (bank << 16) | addr;
      this.cycles += 8;
      if (toA) {
        const v = this.readB(b & 0xff);
        this.writeDmaA(a, v < 0 ? this.mdr : v);
      } else {
        const v = this.readDmaA(a);
        this.writeB(b & 0xff, v);
      }
      if (step === 0) addr = (addr + 1) & 0xffff;
      else if (step === 2) addr = (addr - 1) & 0xffff;
      i++;
      count--;
    }
    r[base + 2] = addr & 0xff;
    r[base + 3] = addr >> 8;
    r[base + 5] = 0;
    r[base + 6] = 0;
  }

  /** DMA の A バス側（B バスのレジスタや DMA のレジスタには届かない） */
  private readDmaA(a: number): number {
    const off = a & 0xffff;
    if (!(a & 0x400000) && ((off >= 0x2100 && off < 0x2200) || (off >= 0x4000 && off < 0x4400))) return this.mdr;
    const v = this.readNoTime(a);
    if (v >= 0) this.mdr = v;
    return this.mdr;
  }

  private writeDmaA(a: number, v: number): void {
    const off = a & 0xffff;
    if (!(a & 0x400000) && ((off >= 0x2100 && off < 0x2200) || (off >= 0x4000 && off < 0x4400))) return;
    this.writeNoTime(a, v);
  }

  /** フレームのはじめに HDMA の表を読み始める */
  private hdmaInit(): void {
    const r = this.dmaRegs;
    for (let ch = 0; ch < 8; ch++) {
      this.hdmaDo[ch] = 0;
      this.hdmaEnd[ch] = 1;
      if (!(this.hdmaen & (1 << ch))) continue;
      const base = ch << 4;
      // 表のアドレス = A1T
      r[base + 8] = r[base + 2];
      r[base + 9] = r[base + 3];
      this.hdmaEnd[ch] = 0;
      this.hdmaLoad(ch);
    }
  }

  /** 表から次の行数（と間接のアドレス）を読む */
  private hdmaLoad(ch: number): void {
    const r = this.dmaRegs;
    const base = ch << 4;
    const bank = r[base + 4];
    let a2 = r[base + 8] | (r[base + 9] << 8);
    const n = this.readDmaA((bank << 16) | a2);
    a2 = (a2 + 1) & 0xffff;
    r[base + 10] = n;
    if (r[base] & 0x40) {
      const lo = this.readDmaA((bank << 16) | a2);
      a2 = (a2 + 1) & 0xffff;
      const hi = this.readDmaA((bank << 16) | a2);
      a2 = (a2 + 1) & 0xffff;
      r[base + 5] = lo;
      r[base + 6] = hi;
      this.cycles += 16;
    }
    r[base + 8] = a2 & 0xff;
    r[base + 9] = a2 >> 8;
    this.cycles += 8;
    if (n === 0) this.hdmaEnd[ch] = 1;
    this.hdmaDo[ch] = 1;
  }

  /** H ブランクごとの HDMA */
  private hdmaLine(): void {
    if (!this.hdmaen) return;
    const r = this.dmaRegs;
    this.cycles += 18;
    for (let ch = 0; ch < 8; ch++) {
      if (!(this.hdmaen & (1 << ch)) || this.hdmaEnd[ch]) continue;
      const base = ch << 4;
      const ctrl = r[base];
      const indirect = (ctrl & 0x40) !== 0;
      if (this.hdmaDo[ch]) {
        const pattern = DMA_PATTERN[ctrl & 7];
        const bAddr = r[base + 1];
        for (let i = 0; i < pattern.length; i++) {
          let a: number;
          if (indirect) {
            const p = r[base + 5] | (r[base + 6] << 8);
            a = (r[base + 7] << 16) | p;
            const np = (p + 1) & 0xffff;
            r[base + 5] = np & 0xff;
            r[base + 6] = np >> 8;
          } else {
            const p = r[base + 8] | (r[base + 9] << 8);
            a = (r[base + 4] << 16) | p;
            const np = (p + 1) & 0xffff;
            r[base + 8] = np & 0xff;
            r[base + 9] = np >> 8;
          }
          const b = (bAddr + pattern[i]) & 0xff;
          this.cycles += 8;
          if (ctrl & 0x80) this.writeDmaA(a, this.readB(b) & 0xff);
          else this.writeB(b, this.readDmaA(a));
        }
      }
      const n = (r[base + 10] - 1) & 0xff;
      r[base + 10] = n;
      this.hdmaDo[ch] = n & 0x80 ? 1 : 0;
      if ((n & 0x7f) === 0) this.hdmaLoad(ch);
    }
  }

  // ───────── コントローラー ─────────

  setPad(bits: number): void {
    this.pad1 = bits & 0xfff0;
    if (this.latchPads) this.reloadSerial();
  }

  private reloadSerial(): void {
    this.serial1 = this.pad1;
    this.serial2 = 0;
  }

  private readSerial(port: number): number {
    if (this.latchPads) this.reloadSerial();
    if (port === 0) {
      const b = (this.serial1 >> 15) & 1;
      this.serial1 = ((this.serial1 << 1) | 1) & 0xffff;
      return b;
    }
    const b = (this.serial2 >> 15) & 1;
    this.serial2 = ((this.serial2 << 1) | 1) & 0xffff;
    return b;
  }

  // ───────── 1 フレーム ─────────

  private runUntil(t: number): void {
    while (this.cycles < t) {
      this.stopAt = t;
      this.cpu.run();
    }
  }

  private triggerIrq(): void {
    this.timeup = true;
    this.irqLine = true;
  }

  runFrame(): void {
    do this.runLine();
    while (this.line !== 0);
    this.syncApu();
    this.frame++;
  }

  private runLine(): void {
    const v = this.line;
    const vbStart = this.vblankStart();
    // ラインのはじめ
    if (v === 0) {
      this.rdnmi = false;
      this.hdmaInit();
    }
    if (v === vbStart) {
      this.ppu.vblank();
      this.rdnmi = true;
      if (this.nmitimen & 0x80) this.nmiPending = true;
      // 自動でコントローラーを読む
      if (this.nmitimen & 1) {
        this.joy[0] = this.pad1;
        this.joy[1] = 0;
        this.serial1 = 0xffff;
        this.serial2 = 0xffff;
        this.autoJoyBusy = this.cycles + LINE_CYCLES * 3;
      }
    }
    // IRQ（V だけならラインのはじめ、H を使うなら HTIME の位置）
    const mode = (this.nmitimen >> 4) & 3;
    if (mode === 2 && v === this.vtime) this.triggerIrq();
    let hIrq = -1;
    if ((mode === 1 || (mode === 3 && v === this.vtime)) && this.htime < 340) hIrq = this.htime * 4 + 14;

    if (hIrq >= 0 && hIrq < HBLANK_START) {
      this.runUntil(this.lineStart + hIrq);
      this.triggerIrq();
    }
    this.runUntil(this.lineStart + HBLANK_START);
    if (v >= 1 && v < vbStart) this.ppu.renderLine(v);
    if (v < vbStart) this.hdmaLine();
    if (hIrq >= HBLANK_START) {
      this.runUntil(this.lineStart + hIrq);
      this.triggerIrq();
    }
    this.runUntil(this.lineStart + LINE_CYCLES);
    this.lineStart += LINE_CYCLES;
    this.line = v + 1 === LINES ? 0 : v + 1;
    if (this.line % 16 === 0) this.syncApu();
  }
}
