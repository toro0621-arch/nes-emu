// nestest.nes を自動モード（PC=$C000 から開始）で動かし、公式ログと 1 命令ずつ突き合わせる
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NesBus } from '../src/bus';
import { parseINes } from '../src/cartridge';
import { Cpu, hex } from '../src/cpu';
import { createMapper } from '../src/mappers/mapper';

const ROMS = join(__dirname, 'roms');

interface LogLine {
  pc: number;
  bytes: string;
  regs: string;
  cyc: number;
}

function parseLog(text: string): LogLine[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => ({
      pc: parseInt(l.slice(0, 4), 16),
      bytes: l.slice(6, 14).trim(),
      regs: l.slice(48, 73),
      cyc: parseInt(l.slice(l.indexOf('CYC:') + 4), 10),
    }));
}

describe('CPU (nestest)', () => {
  it('公式ログと全命令が一致する', () => {
    const cart = parseINes(new Uint8Array(readFileSync(join(ROMS, 'nestest.nes'))));
    const bus = new NesBus(createMapper(cart));
    const cpu = new Cpu(bus);
    cpu.powerOn();
    cpu.pc = 0xc000;
    expect(cpu.sp).toBe(0xfd);
    expect(cpu.p).toBe(0x24);

    const log = parseLog(readFileSync(join(ROMS, 'nestest.log'), 'utf8'));
    for (let i = 0; i < log.length; i++) {
      const want = log[i];
      const len = want.bytes.split(' ').length;
      const bytes: string[] = [];
      for (let k = 0; k < len; k++) bytes.push(hex(bus.read(cpu.pc + k), 2));
      const got = {
        pc: hex(cpu.pc, 4),
        bytes: bytes.join(' '),
        regs: `A:${hex(cpu.a, 2)} X:${hex(cpu.x, 2)} Y:${hex(cpu.y, 2)} P:${hex(cpu.p, 2)} SP:${hex(cpu.sp, 2)}`,
        cyc: cpu.cycles,
      };
      const exp = { pc: hex(want.pc, 4), bytes: want.bytes, regs: want.regs, cyc: want.cyc };
      if (JSON.stringify(got) !== JSON.stringify(exp)) {
        const prev = log.slice(Math.max(0, i - 3), i).map((l) => `  ${hex(l.pc, 4)} ${l.bytes} ${l.regs} CYC:${l.cyc}`);
        expect.fail(`${i + 1} 行目で不一致\n直前:\n${prev.join('\n')}\n期待: ${JSON.stringify(exp)}\n実際: ${JSON.stringify(got)}`);
      }
      cpu.step();
    }
    // nestest は $02/$03 にエラーコードを書く（00 なら全テスト合格）
    expect(hex(bus.read(0x02), 2) + hex(bus.read(0x03), 2)).toBe('0000');
  });
});
