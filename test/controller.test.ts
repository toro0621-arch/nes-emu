import { describe, expect, it } from 'vitest';
import { BUTTON, Controller } from '../src/controller';

function readAll(pad: Controller, n = 8): number[] {
  return Array.from({ length: n }, () => pad.read());
}

describe('Controller', () => {
  it('A, B, SELECT, START, 上, 下, 左, 右 の順に 1 ビットずつ返す', () => {
    const pad = new Controller();
    pad.buttons = BUTTON.A | BUTTON.START | BUTTON.LEFT;
    pad.write(1);
    pad.write(0);
    expect(readAll(pad)).toEqual([1, 0, 0, 1, 0, 0, 1, 0]);
  });

  it('8 ビット読んだあとは 1 が続く', () => {
    const pad = new Controller();
    pad.write(1);
    pad.write(0);
    readAll(pad);
    expect(readAll(pad, 3)).toEqual([1, 1, 1]);
  });

  it('ストローブ中は常に A の状態を返す', () => {
    const pad = new Controller();
    pad.buttons = BUTTON.A;
    pad.write(1);
    expect(readAll(pad, 3)).toEqual([1, 1, 1]);
    pad.buttons = 0;
    expect(pad.read()).toBe(0);
  });

  it('取り込んだあとにボタンが変わっても、次のストローブまでは前の状態を返す', () => {
    const pad = new Controller();
    pad.buttons = BUTTON.B;
    pad.write(1);
    pad.write(0);
    pad.buttons = BUTTON.A;
    expect(readAll(pad, 2)).toEqual([0, 1]);
  });

  it('上下・左右の同時押しは打ち消す', () => {
    const pad = new Controller();
    pad.buttons = BUTTON.UP | BUTTON.DOWN | BUTTON.RIGHT | BUTTON.A;
    pad.write(1);
    pad.write(0);
    expect(readAll(pad)).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);
  });
});
