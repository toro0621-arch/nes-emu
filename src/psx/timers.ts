// 3 つのタイマー（root counter）。数えるのは CPU のクロック・画面の点のクロック・横の帰線・CPU の 1/8。
// 毎クロック数えると重いので、読まれたとき・時刻が来たときにまとめて進める

export class PsxTimer {
  counter = 0;
  mode = 0x400;
  target = 0;
  /** 最後に進めた時刻（CPU のクロック） */
  last = 0;
  /** 1 未満の端数 */
  frac = 0;
  /** 割り込みを 1 回出した（ワンショットのとき） */
  fired = false;

  constructor(public readonly n: number) {}
}

export class PsxTimers {
  t = [new PsxTimer(0), new PsxTimer(1), new PsxTimer(2)];
  /** 点 1 つあたりの CPU のクロック（表示モードで変わる） */
  dotCycles = 5.09;
  /** 帰線中か（同期モードで止めるため） */
  inHblank = false;
  inVblank = false;

  constructor(
    private now: () => number,
    private irq: (n: number) => void,
  ) {}

  /** CPU のクロックで数えるか（それ以外は帰線か点のクロック） */
  private rate(t: PsxTimer): number {
    const src = (t.mode >> 8) & 3;
    if (t.n === 0) return src & 1 ? 1 / this.dotCycles : 1;
    if (t.n === 1) return src & 1 ? 0 : 1; // 0 = 帰線で数える（hblank で 1 つずつ）
    return src & 2 ? 1 / 8 : 1;
  }

  private paused(t: PsxTimer): boolean {
    if (!(t.mode & 1)) return false;
    const sync = (t.mode >> 1) & 3;
    if (t.n === 2) return sync === 0 || sync === 3;
    const blank = t.n === 0 ? this.inHblank : this.inVblank;
    if (sync === 0) return blank;
    if (sync === 2) return !blank;
    if (sync === 3) return !t.fired && !blank;
    return false;
  }

  /** 今の時刻まで進める */
  sync(i: number): void {
    const t = this.t[i];
    const now = this.now();
    const dt = now - t.last;
    t.last = now;
    if (dt <= 0) return;
    const r = this.rate(t);
    if (r === 0 || this.paused(t)) return;
    const f = t.frac + dt * r;
    const n = Math.floor(f);
    t.frac = f - n;
    if (n > 0) this.advance(t, n);
  }

  syncAll(): void {
    this.sync(0);
    this.sync(1);
    this.sync(2);
  }

  /** n 回数える（目標値・0xFFFF を通り過ぎたら印と割り込み） */
  advance(t: PsxTimer, n: number): void {
    const resetOnTarget = (t.mode & 8) !== 0;
    while (n > 0) {
      const toTarget = (t.target - t.counter) & 0xffff || 0x10000;
      const toOverflow = 0xffff - t.counter || 0x10000;
      const step = Math.min(n, toTarget, toOverflow);
      t.counter += step;
      n -= step;
      if (t.counter === t.target) {
        t.mode |= 0x800;
        if (t.mode & 0x10) this.raise(t);
        if (resetOnTarget) {
          t.counter = 0;
          continue;
        }
      }
      if (t.counter >= 0xffff) {
        t.mode |= 0x1000;
        if (t.mode & 0x20) this.raise(t);
        t.counter = 0;
      }
    }
  }

  private raise(t: PsxTimer): void {
    // ワンショットで 1 度出していたら出さない
    if (!(t.mode & 0x40) && t.fired) return;
    t.fired = true;
    if (t.mode & 0x80) {
      // トグル：ビット 10 が 1→0 になったときに割り込み
      t.mode ^= 0x400;
      if (!(t.mode & 0x400)) this.irq(4 + t.n);
    } else {
      t.mode &= ~0x400;
      this.irq(4 + t.n);
      t.mode |= 0x400;
    }
  }

  read(a: number): number {
    const i = (a >> 4) & 3;
    if (i > 2) return 0;
    this.sync(i);
    const t = this.t[i];
    switch (a & 0xc) {
      case 0:
        return t.counter;
      case 4: {
        const v = t.mode;
        t.mode &= ~0x1800;
        return v;
      }
      case 8:
        return t.target;
    }
    return 0;
  }

  write(a: number, v: number): void {
    const i = (a >> 4) & 3;
    if (i > 2) return;
    this.sync(i);
    const t = this.t[i];
    switch (a & 0xc) {
      case 0:
        t.counter = v & 0xffff;
        break;
      case 4:
        t.mode = (v & 0x3ff) | 0x400 | (t.mode & 0x1800);
        t.counter = 0;
        t.frac = 0;
        t.fired = false;
        break;
      case 8:
        t.target = v & 0xffff;
        break;
    }
  }

  /** 横の帰線（タイマー 1 は帰線を数えられる） */
  hblank(): void {
    const t = this.t[1];
    if (((t.mode >> 8) & 1) && !this.paused(t)) this.advance(t, 1);
  }

  setVblank(on: boolean): void {
    this.sync(1);
    this.inVblank = on;
    const t = this.t[1];
    if (on && t.mode & 1) {
      const sync = (t.mode >> 1) & 3;
      if (sync === 1 || sync === 2) t.counter = 0;
      if (sync === 3) t.fired = true;
    }
  }

  setHblank(on: boolean): void {
    this.sync(0);
    this.inHblank = on;
    const t = this.t[0];
    if (on && t.mode & 1) {
      const sync = (t.mode >> 1) & 3;
      if (sync === 1 || sync === 2) t.counter = 0;
    }
  }

  /** 次に割り込みが起きそうな時刻（スケジュール用）。なければ Infinity */
  nextEvent(): number {
    let best = Infinity;
    const now = this.now();
    for (const t of this.t) {
      if (!(t.mode & 0x30)) continue;
      const r = this.rate(t);
      if (r === 0) continue;
      let left = Infinity;
      if (t.mode & 0x10) left = t.target > t.counter ? t.target - t.counter : 0x10000 + t.target - t.counter;
      if (t.mode & 0x20) left = Math.min(left, 0xffff - t.counter || 0x10000);
      const at = now + Math.ceil((left - t.frac) / r);
      if (at < best) best = at;
    }
    return best;
  }
}
