// 標準コントローラー。$4016 に 1→0 を書くとボタンの状態を取り込み、読むたびに 1 ビットずつ返す
export const BUTTON = {
  A: 0x01,
  B: 0x02,
  SELECT: 0x04,
  START: 0x08,
  UP: 0x10,
  DOWN: 0x20,
  LEFT: 0x40,
  RIGHT: 0x80,
} as const;

export class Controller {
  /** 今押されているボタン（BUTTON の OR） */
  buttons = 0;
  private strobe = false;
  private shift = 0;

  write(v: number): void {
    this.strobe = (v & 1) !== 0;
    if (this.strobe) this.shift = this.latched();
  }

  read(): number {
    if (this.strobe) return this.latched() & 1;
    const bit = this.shift & 1;
    // 8 ビット読み終わったあとは 1 が返る（純正コントローラーの動き）
    this.shift = (this.shift >> 1) | 0x80;
    return bit;
  }

  /** 上下・左右の同時押しは実機の十字キーではありえず、誤動作するゲームがあるので消す */
  private latched(): number {
    let b = this.buttons;
    if ((b & (BUTTON.UP | BUTTON.DOWN)) === (BUTTON.UP | BUTTON.DOWN)) b &= ~(BUTTON.UP | BUTTON.DOWN);
    if ((b & (BUTTON.LEFT | BUTTON.RIGHT)) === (BUTTON.LEFT | BUTTON.RIGHT)) b &= ~(BUTTON.LEFT | BUTTON.RIGHT);
    return b;
  }
}
