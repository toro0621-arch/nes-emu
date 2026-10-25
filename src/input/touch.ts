import { BUTTON } from '../controller';

// 画面下のタッチボタン。指ごとに押しているボタンを持ち、指を滑らせても追いかける。
// 十字キーは中心からの角度で 8 方向、A/B は両方の間を押すと同時押しになる
export class TouchInput {
  buttons = 0;
  /** 次のフレームが読むまで残しておくボタン（1 フレームより短いタップを取りこぼさない） */
  private latched = 0;

  /** フレームの頭に 1 回呼ぶ */
  read(): number {
    const b = this.buttons | this.latched;
    this.latched = 0;
    return b;
  }
  private fingers = new Map<number, number>();
  private dpad: HTMLElement;
  private a: HTMLElement;
  private b: HTMLElement;
  private keys: [HTMLElement, number][];

  constructor(private root: HTMLElement) {
    const q = (sel: string) => root.querySelector<HTMLElement>(sel)!;
    this.dpad = q('#dpad');
    this.a = q('[data-btn="A"]');
    this.b = q('[data-btn="B"]');
    this.keys = [
      [q('[data-btn="SELECT"]'), BUTTON.SELECT],
      [q('[data-btn="START"]'), BUTTON.START],
    ];

    root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      root.setPointerCapture(e.pointerId);
      this.track(e);
    });
    root.addEventListener('pointermove', (e) => {
      if (this.fingers.has(e.pointerId)) this.track(e);
    });
    const release = (e: PointerEvent) => {
      this.fingers.delete(e.pointerId);
      this.update();
    };
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private track(e: PointerEvent): void {
    this.fingers.set(e.pointerId, this.hitTest(e.clientX, e.clientY));
    this.update();
  }

  private hitTest(x: number, y: number): number {
    // 十字キー（見た目より少し広く反応させる）
    const d = this.dpad.getBoundingClientRect();
    const r = d.width / 2;
    const dx = x - (d.left + r);
    const dy = y - (d.top + r);
    const dist = Math.hypot(dx, dy);
    if (dist < r * 1.3) {
      if (dist < r * 0.15) return 0; // 真ん中は遊び
      // 斜めは 30°、上下左右は 60° の範囲（斜めに入りすぎないように）
      const T = 0.5;
      let m = 0;
      if (Math.abs(dx) > Math.abs(dy) * T) m |= dx > 0 ? BUTTON.RIGHT : BUTTON.LEFT;
      if (Math.abs(dy) > Math.abs(dx) * T) m |= dy > 0 ? BUTTON.DOWN : BUTTON.UP;
      return m;
    }

    // A / B：近いほう。2 つの距離が近い（真ん中あたり）なら両方
    const da = distTo(this.a, x, y);
    const db = distTo(this.b, x, y);
    const br = this.a.getBoundingClientRect().width / 2;
    if (Math.min(da, db) < br * 1.5) {
      if (Math.abs(da - db) < br * 0.6) return BUTTON.A | BUTTON.B;
      return da < db ? BUTTON.A : BUTTON.B;
    }

    for (const [el, m] of this.keys) {
      const k = el.getBoundingClientRect();
      const pad = 10;
      if (x >= k.left - pad && x <= k.right + pad && y >= k.top - pad && y <= k.bottom + pad) return m;
    }
    return 0;
  }

  private update(): void {
    let m = 0;
    for (const v of this.fingers.values()) m |= v;
    const pressed = m & ~this.buttons;
    this.buttons = m;
    this.latched |= pressed;
    if (pressed && navigator.vibrate) navigator.vibrate(8);
    // 見た目
    this.root.querySelectorAll<HTMLElement>('[data-btn]').forEach((el) => {
      const bit = BUTTON[el.dataset.btn as keyof typeof BUTTON];
      el.classList.toggle('pressed', (m & bit) !== 0);
    });
  }
}

function distTo(el: HTMLElement, x: number, y: number): number {
  const r = el.getBoundingClientRect();
  return Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
}
