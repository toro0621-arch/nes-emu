import { NesBus } from './bus';
import { parseINes } from './cartridge';
import { Cpu } from './cpu';
import { createMapper } from './mappers/mapper';

const out = document.getElementById('out')!;
const input = document.getElementById('rom') as HTMLInputElement;

input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const cart = parseINes(new Uint8Array(await file.arrayBuffer()));
    const lines = [
      `PRG: ${cart.prg.length / 1024}KB  CHR: ${cart.chrRam ? 'RAM 8KB' : `${cart.chr.length / 1024}KB`}`,
      `マッパー: ${cart.mapper}  ミラーリング: ${cart.mirroring}  バッテリー: ${cart.battery ? 'あり' : 'なし'}`,
    ];
    const cpu = new Cpu(new NesBus(createMapper(cart)));
    cpu.powerOn();
    lines.push('', '最初の 20 命令:');
    for (let i = 0; i < 20; i++) {
      lines.push(cpu.trace());
      cpu.step();
    }
    out.textContent = lines.join('\n');
  } catch (e) {
    out.textContent = String(e instanceof Error ? e.message : e);
  }
});
