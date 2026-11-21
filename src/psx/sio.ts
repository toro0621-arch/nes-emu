// コントローラーとメモリーカードの差し込み口（SIO0）。1 バイト送ると 1 バイト返ってくる。
// コントローラーは普通のパッド（デジタル）、メモリーカードは 128KB（15 ブロック）

/** パッドのボタン（押すと 0 になる。ここでは押すと 1 で持ち、送るときに反転する） */
export const PAD = {
  SELECT: 1 << 0,
  START: 1 << 3,
  UP: 1 << 4,
  RIGHT: 1 << 5,
  DOWN: 1 << 6,
  LEFT: 1 << 7,
  L2: 1 << 8,
  R2: 1 << 9,
  L1: 1 << 10,
  R1: 1 << 11,
  TRIANGLE: 1 << 12,
  CIRCLE: 1 << 13,
  CROSS: 1 << 14,
  SQUARE: 1 << 15,
} as const;

export const CARD_SIZE = 128 * 1024;

/** フォーマット済みの空のメモリーカード */
export function blankCard(): Uint8Array {
  const c = new Uint8Array(CARD_SIZE);
  const frame = (i: number) => c.subarray(i * 128, i * 128 + 128);
  const sum = (f: Uint8Array) => {
    let x = 0;
    for (let i = 0; i < 127; i++) x ^= f[i];
    f[127] = x;
  };
  let f = frame(0);
  f[0] = 0x4d; // 'M'
  f[1] = 0x43; // 'C'
  sum(f);
  for (let i = 1; i < 16; i++) {
    f = frame(i);
    f[0] = 0xa0; // 空き
    f[8] = 0xff;
    f[9] = 0xff;
    sum(f);
  }
  for (let i = 16; i < 36; i++) {
    f = frame(i);
    f[0] = f[1] = f[2] = f[3] = 0xff;
    f[8] = 0xff;
    f[9] = 0xff;
    sum(f);
  }
  f = frame(63);
  f[0] = 0x4d;
  f[1] = 0x43;
  sum(f);
  return c;
}

/** 1 バイトのやりとりにかかる CPU のクロック */
const BYTE_CYCLES = 1088;
/** ACK（次のバイトをどうぞ）の合図が来るまで */
const ACK_CYCLES = 1088 + 340;
/** 自動の早送りにする、1 秒あたりのメモリーカードの読み書きの回数 */
const CARD_BURST = 20;
/** /ACK の合図の長さ（クロック） */
const ACK_PULSE = 100;

export class Sio {
  buttons = 0;
  card: Uint8Array = blankCard();
  cardDirty = false;
  /** メモリーカードの「書き込んだ」印（電源を入れた直後は 1） */
  private cardFlag = 0x08;

  mode = 0;
  ctrl = 0;
  baud = 0;
  private rx = 0xff;
  private rxFull = false;
  /** /ACK が出ている（低い）間の終わりの時刻。本物は 100 クロックくらいの短い合図で、すぐ戻る */
  private ackUntil = -1;
  private irq = false;
  /** 今話している相手：0 なし、1 パッド、2 メモリーカード、3 だれも答えない */
  private dev = 0;
  private step = 0;
  // メモリーカードのやりとり
  private cmd = 0;
  private addr = 0;
  private chk = 0;
  private wbuf = new Uint8Array(128);
  /** 返事が届く時刻（CPU のクロック。-1 = なし） */
  pendingAt = -1;
  private pendingAt0 = 0;
  private pendingByte = 0xff;
  private pendingAck = false;

  constructor(
    private now: () => number,
    private raiseIrq: () => void,
  ) {}

  get stat(): number {
    let s = 0x5; // 送れる・送り終わった
    if (this.rxFull) s |= 0x2;
    if (this.ackUntil >= 0 && this.now() < this.ackUntil) s |= 0x80;
    if (this.irq) s |= 0x200;
    return s;
  }

  readData(): number {
    const v = this.rx;
    this.rxFull = false;
    this.rx = 0xff;
    return v;
  }

  writeData(v: number): void {
    // 選ばれていなければ何も返ってこない
    if (!(this.ctrl & 2)) {
      this.dev = 0;
      return;
    }
    const port = (this.ctrl >> 13) & 1;
    let out = 0xff;
    let ack = false;
    if (this.dev === 0) {
      if (port === 1) this.dev = 3;
      else if (v === 0x01) this.dev = 1;
      else if (v === 0x81) this.dev = 2;
      else this.dev = 3;
      this.step = 0;
    }
    if (this.dev === 1) [out, ack] = this.pad(v);
    else if (this.dev === 2) [out, ack] = this.memcard(v);
    if (!ack) this.dev = this.dev === 3 ? 3 : 0;
    this.pendingByte = out;
    this.pendingAck = ack;
    this.pendingAt = this.now() + (ack ? ACK_CYCLES : BYTE_CYCLES);
  }

  /** 時刻が来たら返事を受け取る */
  tick(): void {
    if (this.pendingAt < 0 || this.now() < this.pendingAt) return;
    this.pendingAt0 = this.pendingAt;
    this.pendingAt = -1;
    this.rx = this.pendingByte;
    this.rxFull = true;
    if (this.pendingAck) {
      // BIOS は「/ACK が戻るまで待つ」ことがあるので、出しっぱなしにしない
      this.ackUntil = this.pendingAt0 + ACK_PULSE;
      if (this.ctrl & 0x1000) {
        this.irq = true;
        this.raiseIrq();
      }
    }
  }

  writeCtrl(v: number): void {
    this.ctrl = v & ~0x50;
    if (v & 0x10) {
      // 割り込みの印を消す
      this.irq = false;
    }
    if (v & 0x40) {
      this.ctrl = 0;
      this.mode = 0;
      this.irq = false;
    }
    if (!(v & 2)) {
      this.dev = 0;
      this.step = 0;
    }
  }

  private pad(v: number): [number, boolean] {
    const s = this.step++;
    const b = ~this.buttons & 0xffff;
    switch (s) {
      case 0:
        return [0xff, true];
      case 1:
        return v === 0x42 ? [0x41, true] : [0xff, false];
      case 2:
        return [0x5a, true];
      case 3:
        return [b & 0xff, true];
      case 4:
        return [b >> 8, false];
    }
    return [0xff, false];
  }

  /** 最近メモリーカードを読み書きした時刻（新しい順に CARD_BURST 回ぶん。自動の早送りに使う） */
  cardTimes: number[] = new Array<number>(CARD_BURST).fill(-1e12);

  /**
   * セーブ・ロードで続けて読み書きしている最中か。
   * ゲームによっては、遊んでいる間もカードがあるかをときどき読んで確かめるので、
   * 「1 秒に CARD_BURST 回以上」続けて読み書きしているときだけにする（セーブ・ロードは 1 秒に 30 回ほど）
   */
  cardBusy(): boolean {
    const now = this.now();
    const sec = 33868800;
    return now - this.cardTimes[0] < sec / 5 && now - this.cardTimes[CARD_BURST - 1] < sec;
  }

  /** 前に読み書きした場所 */
  private cardLast = -1;

  /**
   * 読み書きした場所を覚える。同じ場所をくり返し読むのは「カードがあるか」の確かめなので数えない
   * （セーブ・ロードは、となりの場所へ順に進んでいく）
   */
  private noteCard(): void {
    const a = this.addr & 0x3ff;
    if (a === this.cardLast) return;
    this.cardLast = a;
    // 前の版のセーブから戻すと数が足りないことがある
    if (this.cardTimes.length !== CARD_BURST) this.cardTimes = new Array<number>(CARD_BURST).fill(-1e12);
    this.cardTimes.pop();
    this.cardTimes.unshift(this.now());
  }

  private memcard(v: number): [number, boolean] {
    const s = this.step++;

    if (s === 0) return [0xff, true];
    if (s === 1) {
      this.cmd = v;
      if (v !== 0x52 && v !== 0x57 && v !== 0x53) return [this.cardFlag, false];
      return [this.cardFlag, true];
    }
    switch (this.cmd) {
      case 0x52: // 読む
        switch (s) {
          case 2:
            return [0x5a, true];
          case 3:
            return [0x5d, true];
          case 4:
            this.addr = v << 8;
            return [0x00, true];
          case 5:
            this.addr |= v;
            this.addr &= 0x3ff;
            this.noteCard();
            return [this.addr >> 8, true];
          case 6:
            return [0x5c, true];
          case 7:
            return [0x5d, true];
          case 8:
            return [this.addr >> 8, true];
          case 9:
            this.chk = (this.addr >> 8) ^ (this.addr & 0xff);
            return [this.addr & 0xff, true];
        }
        if (s < 10 + 128) {
          const d = this.card[this.addr * 128 + (s - 10)];
          this.chk ^= d;
          return [d, true];
        }
        if (s === 138) return [this.chk, true];
        return [0x47, false];
      case 0x57: // 書く
        switch (s) {
          case 2:
            return [0x5a, true];
          case 3:
            return [0x5d, true];
          case 4:
            this.addr = v << 8;
            this.chk = v;
            return [0x00, true];
          case 5:
            this.addr |= v;
            this.chk ^= v;
            this.noteCard();
            return [this.addr >> 8, true];
        }
        if (s < 6 + 128) {
          this.wbuf[s - 6] = v;
          this.chk ^= v;
          return [0x00, true];
        }
        if (s === 134) {
          // チェックサム
          this.cmd = v === this.chk ? 0x157 : 0x257;
          return [0x00, true];
        }
        return [0xff, false];
      case 0x157:
      case 0x257:
        if (s === 135) return [0x5c, true];
        if (s === 136) return [0x5d, true];
        if (s === 137) {
          if (this.cmd === 0x257) return [0x4e, false];
          if (this.addr > 0x3ff) return [0xff, false];
          this.card.set(this.wbuf, (this.addr & 0x3ff) * 128);
          this.cardDirty = true;
          this.cardFlag = 0;
          return [0x47, false];
        }
        return [0xff, false];
      case 0x53: // ID
        switch (s) {
          case 2:
            return [0x5a, true];
          case 3:
            return [0x5d, true];
          case 4:
            return [0x5c, true];
          case 5:
            return [0x5d, true];
          case 6:
            return [0x04, true];
          case 7:
            return [0x00, true];
          case 8:
            return [0x00, true];
          case 9:
            return [0x80, false];
        }
    }
    return [0xff, false];
  }
}
