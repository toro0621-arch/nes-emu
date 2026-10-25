import { BUTTON } from '../controller';

// PC で試すとき用：矢印キー・Z(B)・X(A)・Enter(START)・Shift(SELECT)
const KEYMAP: Record<string, number> = {
  ArrowUp: BUTTON.UP,
  ArrowDown: BUTTON.DOWN,
  ArrowLeft: BUTTON.LEFT,
  ArrowRight: BUTTON.RIGHT,
  KeyZ: BUTTON.B,
  KeyX: BUTTON.A,
  Enter: BUTTON.START,
  ShiftLeft: BUTTON.SELECT,
  ShiftRight: BUTTON.SELECT,
};

export class KeyboardInput {
  buttons = 0;
  /** 次のフレームが読むまで残しておくボタン（1 フレームより短いタップを取りこぼさない） */
  private latched = 0;

  /** フレームの頭に 1 回呼ぶ */
  read(): number {
    const b = this.buttons | this.latched;
    this.latched = 0;
    return b;
  }

  constructor() {
    window.addEventListener('keydown', (e) => {
      const b = KEYMAP[e.code];
      if (!b || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      this.buttons |= b;
      this.latched |= b;
    });
    window.addEventListener('keyup', (e) => {
      const b = KEYMAP[e.code];
      if (b) this.buttons &= ~b;
    });
    // 押したままフォーカスが外れると離したことが伝わらないので、全部離す
    window.addEventListener('blur', () => (this.buttons = 0));
  }
}
