import type { Cartridge } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';
import { MIRROR_VH1S } from './discrete';

/** I²C の EEPROM（24C01 = 128 バイト、24C02 = 256 バイト）。バンダイのドラゴンボール Z などのセーブ */
class Eeprom {
  readonly data: Uint8Array;
  dirty = false;
  private scl = 0;
  private sda = 1;
  private out = 1;
  private state: 'idle' | 'device' | 'address' | 'write' | 'read' = 'idle';
  private bit = 0;
  private shift = 0;
  private addr = 0;
  private next: 'idle' | 'address' | 'write' | 'read' = 'idle';
  private ackClock = false;

  constructor(private readonly small: boolean) {
    this.data = new Uint8Array(small ? 128 : 256).fill(0xff);
  }

  /** マッパーのレジスタから SCL・SDA を書く */
  write(scl: number, sda: number): void {
    if (this.scl && scl && this.sda !== sda) {
      // SCL が 1 のまま SDA が変わる：1→0 は開始、0→1 は終了
      if (!sda) {
        this.state = this.small ? 'address' : 'device';
        this.bit = 0;
        this.ackClock = false;
        this.shift = 0;
        this.out = 1;
      } else {
        this.state = 'idle';
        this.out = 1;
      }
    } else if (!this.scl && scl) this.rise(sda);
    else if (this.scl && !scl) this.fall();
    this.scl = scl;
    this.sda = sda;
  }

  read(): number {
    return this.out;
  }

  private rise(sda: number): void {
    if (this.state === 'idle') return;
    if (this.bit < 8) {
      // データのビット（読み出し中はホストが読むだけ）
      if (this.state !== 'read') this.shift = ((this.shift << 1) | sda) & 0xff;
      this.bit++;
    } else {
      // 9 クロック目（ACK）。読み出し中にホストが 1（NACK）なら終わり
      this.ackClock = true;
      if (this.state === 'read' && sda) this.state = 'idle';
    }
  }

  private fall(): void {
    if (this.state === 'idle') return;
    const mask = this.data.length - 1;
    if (this.ackClock) {
      // ACK のクロックが終わった → 次のバイトへ
      this.ackClock = false;
      this.bit = 0;
      this.shift = 0;
      if (this.state === 'read') this.addr = (this.addr + 1) & mask;
      else this.state = this.next;
      this.out = this.state === 'read' ? this.data[this.addr] >> 7 : 1;
      return;
    }
    if (this.state === 'read') {
      this.out = this.bit < 8 ? (this.data[this.addr] >> (7 - this.bit)) & 1 : 1;
      return;
    }
    if (this.bit !== 8) return;
    // 1 バイト受け取った → ACK を返す
    const b = this.shift;
    switch (this.state) {
      case 'device':
        if ((b & 0xf0) !== 0xa0) {
          this.state = 'idle';
          return;
        }
        this.next = b & 1 ? 'read' : 'address';
        break;
      case 'address':
        if (this.small) {
          this.addr = b >> 1;
          this.next = b & 1 ? 'read' : 'write';
        } else {
          this.addr = b;
          this.next = 'write';
        }
        break;
      case 'write':
        this.data[this.addr] = b;
        this.addr = (this.addr + 1) & mask;
        this.dirty = true;
        this.next = 'write';
        break;
    }
    this.out = 0;
  }
}

// バンダイ FCG（16・153・159）。レジスタは $6000-$7FFF（FCG-1/2）か $8000-$FFFF（LZ93D50）
export class Mapper16 extends BaseMapper {
  private chrRegs = new Array<number>(8).fill(0);
  private prgReg = 0;
  private irqEnabled = false;
  private counter = 0;
  private latch = 0;
  /** $6000 に書くタイプ（FCG-1/2）は、カウンタに直接書く */
  private fcg = false;
  private eeprom: Eeprom | null;
  private ramOn = false;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    // 159 は 24C01、16 は 24C02（FCG-1/2 のソフトでは使われないだけ）。153 は普通の PRG RAM
    this.eeprom = cart.mapper === 153 ? null : new Eeprom(cart.mapper === 159);
    this.update();
  }

  get saveRam(): Uint8Array | null {
    if (this.eeprom) return this.eeprom.data;
    return this.cart.battery ? this.prgRam : null;
  }

  cpuRead(addr: number): number {
    if (addr >= 0x6000 && addr < 0x8000) {
      if (this.eeprom) return this.eeprom.read() << 4;
      return this.ramOn ? this.prgRam[addr & 0x1fff] : 0;
    }
    return super.cpuRead(addr);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr >= 0x6000 && addr < 0x8000) {
      if (this.cart.mapper === 153) {
        if (this.ramOn) {
          this.prgRam[addr & 0x1fff] = v;
          this.saveDirty = true;
        }
        return;
      }
      this.fcg = true;
    } else if (addr < 0x6000) return;
    const r = addr & 0x0f;
    if (r < 8) this.chrRegs[r] = v;
    else if (r === 8) this.prgReg = v & 0x0f;
    else if (r === 9) this.mirror = MIRROR_VH1S[v & 3];
    else if (r === 0x0a) {
      this.irqEnabled = (v & 1) !== 0;
      if (!this.fcg) this.counter = this.latch;
      this.host.irq(false);
    } else if (r === 0x0b) this.setCounter((this.fcgValue() & 0xff00) | v);
    else if (r === 0x0c) this.setCounter((this.fcgValue() & 0xff) | (v << 8));
    else if (r === 0x0d) {
      if (this.eeprom) {
        this.eeprom.write((v >> 5) & 1, (v >> 6) & 1);
        if (this.eeprom.dirty) {
          this.eeprom.dirty = false;
          this.saveDirty = true;
        }
      } else this.ramOn = (v & 0x20) !== 0;
    }
    this.update();
  }

  private fcgValue(): number {
    return this.fcg ? this.counter : this.latch;
  }

  private setCounter(v: number): void {
    if (this.fcg) this.counter = v;
    else this.latch = v;
  }

  private update(): void {
    if (this.cart.mapper === 153) {
      // 153（ファミコンジャンプII）：CHR レジスタのビット 0 で PRG の 256KB を選ぶ
      const outer = (this.chrRegs.some((c) => c & 1) ? 1 : 0) << 4;
      this.setPrg16k(0, outer | this.prgReg);
      this.setPrg16k(2, outer | 0x0f);
      return;
    }
    this.setPrg16k(0, this.prgReg);
    this.setPrg16k(2, -1);
    for (let i = 0; i < 8; i++) this.setChr1k(i, this.chrRegs[i]);
  }

  cpuClock(): void {
    if (!this.irqEnabled) return;
    if (this.counter === 0) this.host.irq(true);
    this.counter = (this.counter - 1) & 0xffff;
  }
}
