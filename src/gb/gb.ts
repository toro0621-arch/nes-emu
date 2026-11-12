// ゲームボーイ・ゲームボーイカラー本体（メモリの配置・タイマー・割り込み・DMA・ボタン・倍速）
import { GbApu } from './apu';
import { GbCart } from './cart';
import { GbCpu, type GbBus } from './cpu';
import { GbPpu } from './ppu';

/** タイマーの速さ（TAC の下位 2 ビット）→ 見る DIV のビット */
const TIMER_BIT = [1 << 9, 1 << 3, 1 << 5, 1 << 7];

export class Gb implements GbBus {
  readonly cart: GbCart;
  readonly cpu: GbCpu;
  readonly ppu: GbPpu;
  readonly apu: GbApu;
  /** ゲームボーイカラーとして動かしているか */
  readonly cgb: boolean;

  private wram = new Uint8Array(0x8000);
  private hram = new Uint8Array(0x7f);
  private wramBank = 1;
  if_ = 0xe1;
  ie = 0;
  stall = 0;

  // タイマー
  private div = 0xabcc;
  private tima = 0;
  private tma = 0;
  private tac = 0xf8;
  private timaOverflow = false;

  // ボタン（押されている = 1。ファミコンと同じビット：A B SELECT START ↑ ↓ ← →）
  private p1 = 0x30;
  private buttons = 0;

  // シリアル（テスト ROM の出力を受け取るだけ）
  private sb = 0;
  private sc = 0;
  serialOut = '';

  // DMA
  private dmaSrc = 0;
  private dmaPos = 160;
  private dmaDelay = 0;
  private hdmaSrc = 0;
  private hdmaDst = 0;
  private hdmaLeft = 0; // 残りのブロック数（HBlank DMA 中）
  private hdmaActive = false;

  // 倍速（カラー）
  doubleSpeed = false;
  private key1 = 0;

  constructor(rom: Uint8Array) {
    this.cart = new GbCart(rom);
    this.cgb = this.cart.cgb;
    this.ppu = new GbPpu({ interrupt: (bit) => (this.if_ |= 1 << bit), hblank: () => this.hblank() }, this.cgb);
    this.apu = new GbApu();
    this.cpu = new GbCpu(this);
    this.powerOn();
  }

  /** 起動 ROM が終わった直後の状態にする */
  private powerOn(): void {
    const c = this.cpu;
    if (this.cgb) {
      c.a = 0x11;
      c.f = 0x80;
      c.b = 0x00;
      c.c = 0x00;
      c.d = 0xff;
      c.e = 0x56;
      c.h = 0x00;
      c.l = 0x0d;
    } else {
      c.a = 0x01;
      c.f = 0xb0;
      c.b = 0x00;
      c.c = 0x13;
      c.d = 0x00;
      c.e = 0xd8;
      c.h = 0x01;
      c.l = 0x4d;
    }
    c.sp = 0xfffe;
    c.pc = 0x100;
  }

  // ---- ボタン ----
  setButtons(b: number): void {
    // 新しく押されたボタンがあればボタン割り込み
    if (b & ~this.buttons) this.if_ |= 0x10;
    this.buttons = b;
  }

  private readJoypad(): number {
    const b = this.buttons;
    let low = 0x0f;
    if (!(this.p1 & 0x10)) {
      // 十字キー：→ ← ↑ ↓
      low &= ~(((b >> 7) & 1) | (((b >> 6) & 1) << 1) | (((b >> 4) & 1) << 2) | (((b >> 5) & 1) << 3));
    }
    if (!(this.p1 & 0x20)) low &= ~(b & 0x0f); // A B SELECT START
    return 0xc0 | this.p1 | low;
  }

  // ---- 時間 ----
  tick(): void {
    // タイマー（CPU のクロックで動く）
    if (this.timaOverflow) {
      this.timaOverflow = false;
      this.tima = this.tma;
      this.if_ |= 4;
    }
    const old = this.div;
    const now = (old + 4) & 0xffff;
    this.div = now;
    if (this.tac & 4) {
      const m = TIMER_BIT[this.tac & 3];
      if (old & m && !(now & m)) this.incTima();
    }
    // 音のフレームシーケンサ（512Hz）
    const am = this.doubleSpeed ? 0x2000 : 0x1000;
    if (old & am && !(now & am)) this.apu.frameStep();
    // OAM DMA：1 M サイクルに 1 バイト
    if (this.dmaPos < 160) {
      if (this.dmaDelay > 0) this.dmaDelay--;
      else {
        this.ppu.oam[this.dmaPos] = this.read(this.dmaSrc + this.dmaPos);
        this.dmaPos++;
      }
    }
    // 画面と音は倍速でも同じ速さ
    const dots = this.doubleSpeed ? 2 : 4;
    this.ppu.advance(dots);
    this.apu.advance(dots);
  }

  private incTima(): void {
    if (this.tima === 0xff) {
      this.tima = 0;
      this.timaOverflow = true;
    } else this.tima++;
  }

  private timerSignal(div: number, tac: number): boolean {
    return (tac & 4) !== 0 && (div & TIMER_BIT[tac & 3]) !== 0;
  }

  stop(): void {
    if (this.cgb && this.key1 & 1) {
      this.doubleSpeed = !this.doubleSpeed;
      this.key1 = 0;
      this.div = 0;
    }
  }

  // ---- HBlank DMA（カラー） ----
  private hblank(): void {
    if (!this.hdmaActive) return;
    this.copyHdmaBlock();
    this.stall += this.doubleSpeed ? 16 : 8;
    if (--this.hdmaLeft === 0) this.hdmaActive = false;
  }

  private copyHdmaBlock(): void {
    const vram = this.ppu.vram;
    const bank = this.ppu.vramBank * 0x2000;
    for (let i = 0; i < 16; i++) {
      vram[bank + ((this.hdmaDst + i) & 0x1fff)] = this.read((this.hdmaSrc + i) & 0xffff);
    }
    this.hdmaSrc = (this.hdmaSrc + 16) & 0xffff;
    this.hdmaDst = (this.hdmaDst + 16) & 0x1fff;
  }

  // ---- メモリ ----
  /** 改造コード（ゲームジーニー）の ROM の差し替え */
  genie: Map<number, { val: number; cmp: number }> | null = null;

  read(a: number): number {
    if (a < 0x8000) {
      const v = this.cart.read(a);
      if (this.genie !== null) {
        const g = this.genie.get(a);
        if (g && (g.cmp < 0 || g.cmp === v)) return g.val;
      }
      return v;
    }
    if (a < 0xa000) return this.ppu.vram[this.ppu.vramBank * 0x2000 + (a - 0x8000)];
    if (a < 0xc000) return this.cart.read(a);
    if (a < 0xd000) return this.wram[a - 0xc000];
    if (a < 0xe000) return this.wram[this.wramBank * 0x1000 + (a - 0xd000)];
    if (a < 0xfe00) return this.read(a - 0x2000);
    if (a < 0xfea0) return this.ppu.oam[a - 0xfe00];
    if (a < 0xff00) return 0xff;
    if (a >= 0xff80) return a === 0xffff ? this.ie : this.hram[a - 0xff80];
    return this.readIo(a);
  }

  write(a: number, v: number): void {
    if (a < 0x8000) return this.cart.write(a, v);
    if (a < 0xa000) {
      this.ppu.vram[this.ppu.vramBank * 0x2000 + (a - 0x8000)] = v;
      return;
    }
    if (a < 0xc000) return this.cart.write(a, v);
    if (a < 0xd000) {
      this.wram[a - 0xc000] = v;
      return;
    }
    if (a < 0xe000) {
      this.wram[this.wramBank * 0x1000 + (a - 0xd000)] = v;
      return;
    }
    if (a < 0xfe00) return this.write(a - 0x2000, v);
    if (a < 0xfea0) {
      this.ppu.oam[a - 0xfe00] = v;
      return;
    }
    if (a < 0xff00) return;
    if (a >= 0xff80) {
      if (a === 0xffff) this.ie = v;
      else this.hram[a - 0xff80] = v;
      return;
    }
    this.writeIo(a, v);
  }

  private readIo(a: number): number {
    switch (a) {
      case 0xff00:
        return this.readJoypad();
      case 0xff01:
        return this.sb;
      case 0xff02:
        return this.sc | (this.cgb ? 0x7c : 0x7e);
      case 0xff04:
        return this.div >> 8;
      case 0xff05:
        return this.tima;
      case 0xff06:
        return this.tma;
      case 0xff07:
        return this.tac | 0xf8;
      case 0xff0f:
        return this.if_ | 0xe0;
      case 0xff46:
        return this.dmaSrc >> 8;
    }
    if (a >= 0xff10 && a < 0xff40) return this.apu.read(a);
    if (a >= 0xff40 && a < 0xff70 && a !== 0xff4d && !(a >= 0xff51 && a <= 0xff55)) return this.ppu.read(a);
    if (!this.cgb) return 0xff;
    switch (a) {
      case 0xff4d:
        return 0x7e | (this.doubleSpeed ? 0x80 : 0) | (this.key1 & 1);
      case 0xff55:
        return this.hdmaActive ? (this.hdmaLeft - 1) & 0x7f : 0xff;
      case 0xff70:
        return 0xf8 | this.wramBank;
    }
    return 0xff;
  }

  private writeIo(a: number, v: number): void {
    switch (a) {
      case 0xff00:
        this.p1 = v & 0x30;
        return;
      case 0xff01:
        this.sb = v;
        return;
      case 0xff02:
        this.sc = v;
        if ((v & 0x81) === 0x81) {
          // 相手がいないので、送ったら 0xFF が返ってきたことにする
          this.serialOut += String.fromCharCode(this.sb);
          if (this.serialOut.length > 4096) this.serialOut = this.serialOut.slice(-2048);
          this.sb = 0xff;
          this.sc &= 0x7f;
          this.if_ |= 8;
        }
        return;
      case 0xff04: {
        // DIV を書くと 0 に戻る（そのとき見ていたビットが 1 → 0 になるとタイマーが進む）
        if (this.timerSignal(this.div, this.tac)) this.incTima();
        const am = this.doubleSpeed ? 0x2000 : 0x1000;
        if (this.div & am) this.apu.frameStep();
        this.div = 0;
        return;
      }
      case 0xff05:
        // あふれた直後の 1 M サイクルに書くと、TMA の読み込みが取り消される
        this.tima = v;
        this.timaOverflow = false;
        return;
      case 0xff06:
        this.tma = v;
        return;
      case 0xff07: {
        if (this.timerSignal(this.div, this.tac) && !this.timerSignal(this.div, v)) this.incTima();
        this.tac = v & 7;
        return;
      }
      case 0xff0f:
        this.if_ = v & 0x1f;
        return;
      case 0xff46:
        this.dmaSrc = v << 8;
        this.dmaPos = 0;
        this.dmaDelay = 1;
        return;
    }
    if (a >= 0xff10 && a < 0xff40) return this.apu.write(a, v);
    if (!this.cgb && a >= 0xff4c) return;
    switch (a) {
      case 0xff4d:
        this.key1 = v & 1;
        return;
      case 0xff51:
        this.hdmaSrc = (this.hdmaSrc & 0xff) | (v << 8);
        return;
      case 0xff52:
        this.hdmaSrc = (this.hdmaSrc & 0xff00) | (v & 0xf0);
        return;
      case 0xff53:
        this.hdmaDst = (this.hdmaDst & 0xff) | ((v & 0x1f) << 8);
        return;
      case 0xff54:
        this.hdmaDst = (this.hdmaDst & 0x1f00) | (v & 0xf0);
        return;
      case 0xff55: {
        if (this.hdmaActive && !(v & 0x80)) {
          // HBlank DMA の途中で止める
          this.hdmaActive = false;
          return;
        }
        const blocks = (v & 0x7f) + 1;
        if (v & 0x80) {
          this.hdmaActive = true;
          this.hdmaLeft = blocks;
        } else {
          // まとめて転送（その間 CPU は止まる）
          for (let i = 0; i < blocks; i++) this.copyHdmaBlock();
          this.stall += blocks * (this.doubleSpeed ? 16 : 8);
        }
        return;
      }
      case 0xff70:
        this.wramBank = v & 7 || 1;
        return;
    }
    if (a >= 0xff40 && a < 0xff70) this.ppu.write(a, v);
  }

  /** 1 フレーム分（次の VBlank まで）動かす */
  runFrame(): void {
    const ppu = this.ppu;
    ppu.frameReady = false;
    // 画面が止まっていても抜けられるよう、1 フレームの数倍で打ち切る
    for (let guard = 0; !ppu.frameReady && guard < 400000; guard++) this.cpu.step();
  }
}
