import type { Cartridge, Mirroring } from '../cartridge';
import { BaseMapper, type MapperHost } from './base';

// 汎用ロジック IC だけでできた、レジスタが 1 つのマッパーたち

/** CNROM（3）：CHR 8KB を切り替え */
export class Mapper3 extends BaseMapper {
  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg16k(0, 0);
    this.setPrg16k(2, -1);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr >= 0x8000) this.setChr8k(v);
    else super.cpuWrite(addr, v);
  }
}

/** CNROM + コピープロテクト（185）：決まった値以外を書くと CHR が読めなくなる */
export class Mapper185 extends Mapper3 {
  private chrOn = false;

  cpuWrite(addr: number, v: number): void {
    if (addr >= 0x8000) this.chrOn = (v & 0x0f) !== 0 && v !== 0x13;
    else super.cpuWrite(addr, v);
  }

  ppuRead(addr: number): number {
    return this.chrOn ? super.ppuRead(addr) : 0xff;
  }
}

/** AxROM（7）：PRG 32KB と 1 画面ミラーの切り替え */
export class Mapper7 extends BaseMapper {
  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg32k(0);
    this.mirror = 'single0';
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    this.setPrg32k(v & 0x0f);
    this.mirror = v & 0x10 ? 'single1' : 'single0';
  }
}

/** PRG 32KB と CHR 8KB を 1 つの値で切り替えるマッパー（Color Dreams・GxROM など） */
abstract class Prg32Chr8 extends BaseMapper {
  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg32k(0);
  }

  protected abstract decode(v: number): [prg: number, chr: number];

  /** 書き込みを受け付けるか（既定は $8000-$FFFF） */
  protected hit(addr: number): boolean {
    return addr >= 0x8000;
  }

  cpuWrite(addr: number, v: number): void {
    if (!this.hit(addr)) return super.cpuWrite(addr, v);
    const [prg, chr] = this.decode(v);
    this.setPrg32k(prg);
    this.setChr8k(chr);
  }
}

/** Color Dreams（11） */
export class Mapper11 extends Prg32Chr8 {
  protected decode(v: number): [number, number] {
    return [v & 3, v >> 4];
  }
}

/** GxROM（66） */
export class Mapper66 extends Prg32Chr8 {
  protected decode(v: number): [number, number] {
    return [(v >> 4) & 3, v & 3];
  }
}

/** ジャレコ JF-11/14（140）：$6000-$7FFF に書く */
export class Mapper140 extends Prg32Chr8 {
  protected hit(addr: number): boolean {
    return addr >= 0x6000 && addr < 0x8000;
  }
  protected decode(v: number): [number, number] {
    return [(v >> 4) & 3, v & 0x0f];
  }
}

/** ジャレコ JF-13（86）：$6000-$6FFF に書く（$7000 の音声は扱わない） */
export class Mapper86 extends Prg32Chr8 {
  protected hit(addr: number): boolean {
    return addr >= 0x6000 && addr < 0x7000;
  }
  protected decode(v: number): [number, number] {
    return [(v >> 4) & 3, ((v >> 4) & 4) | (v & 3)];
  }
}

/** UNL-PCI556（38）：$7000-$7FFF に書く */
export class Mapper38 extends Prg32Chr8 {
  protected hit(addr: number): boolean {
    return addr >= 0x7000 && addr < 0x8000;
  }
  protected decode(v: number): [number, number] {
    return [v & 3, (v >> 2) & 3];
  }
}

/** NINA-03/06（79）・（113）：$4100-$5FFF のうち A8 が 1 のアドレスに書く */
export class Mapper79 extends Prg32Chr8 {
  protected hit(addr: number): boolean {
    return addr >= 0x4100 && addr < 0x6000 && (addr & 0x100) !== 0;
  }
  protected decode(v: number): [number, number] {
    if (this.cart.mapper === 113) {
      this.mirror = v & 0x80 ? 'vertical' : 'horizontal';
      return [(v >> 3) & 7, ((v >> 3) & 8) | (v & 7)];
    }
    return [(v >> 3) & 1, v & 7];
  }
}

/** BNROM / NINA-001（34）：CHR が 8KB 以下なら BNROM */
export class Mapper34 extends BaseMapper {
  private readonly nina: boolean;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.nina = cart.chr.length > 0x2000;
    this.setPrg32k(0);
  }

  cpuWrite(addr: number, v: number): void {
    if (this.nina) {
      super.cpuWrite(addr, v);
      if (addr === 0x7ffd) this.setPrg32k(v & 1);
      else if (addr === 0x7ffe) this.setChr4k(0, v & 0x0f);
      else if (addr === 0x7fff) this.setChr4k(4, v & 0x0f);
    } else if (addr >= 0x8000) this.setPrg32k(v);
    else super.cpuWrite(addr, v);
  }
}

/** $8000 を 16KB 切り替え、$C000 を最後に固定するマッパーの土台 */
abstract class Prg16Fixed extends BaseMapper {
  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg16k(0, 0);
    this.setPrg16k(2, -1);
  }
}

/** Camerica（71）：$C000-$FFFF で PRG、$9000 で 1 画面ミラー（Fire Hawk） */
export class Mapper71 extends Prg16Fixed {
  cpuWrite(addr: number, v: number): void {
    if (addr >= 0xc000) this.setPrg16k(0, v);
    else if (addr >= 0x9000 && addr < 0xa000) this.mirror = v & 0x10 ? 'single1' : 'single0';
    else if (addr < 0x8000) super.cpuWrite(addr, v);
  }
}

/** Camerica BF9096（232）：64KB ずつの外側のバンクと、その中の 16KB */
export class Mapper232 extends Prg16Fixed {
  private outer = 0;
  private inner = 0;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.update();
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    if (addr < 0xc000) this.outer = (v >> 3) & 3;
    else this.inner = v & 3;
    this.update();
  }

  private update(): void {
    this.setPrg16k(0, this.outer * 4 + this.inner);
    this.setPrg16k(2, this.outer * 4 + 3);
  }
}

/** $8000 への 1 回の書き込みで PRG 16KB・CHR 8KB・ミラーをまとめて切り替えるマッパー */
export class LatchMapper extends Prg16Fixed {
  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    switch (this.cart.mapper) {
      case 70: // バンダイ
        this.setPrg16k(0, (v >> 4) & 0x0f);
        this.setChr8k(v & 0x0f);
        break;
      case 152: // バンダイ・タイトー（1 画面ミラー付き）
        this.setPrg16k(0, (v >> 4) & 7);
        this.setChr8k(v & 0x0f);
        this.mirror = v & 0x80 ? 'single1' : 'single0';
        break;
      case 78: // アイレム・ジャレコ
        this.setPrg16k(0, v & 7);
        this.setChr8k(v >> 4);
        // ホーリーダイバーは縦横の切り替え、コスモキャリアは 1 画面の切り替え
        if (this.cart.submapper === 3 || this.cart.mirroring === 'four')
          this.mirror = v & 8 ? 'vertical' : 'horizontal';
        else this.mirror = v & 8 ? 'single1' : 'single0';
        break;
      case 89: // サンソフト 2（天下のご意見番 水戸黄門）
        this.setPrg16k(0, (v >> 4) & 7);
        this.setChr8k(((v >> 4) & 8) | (v & 7));
        this.mirror = v & 8 ? 'single1' : 'single0';
        break;
      case 93: // サンソフト 2（ファンタジーゾーン）
        this.setPrg16k(0, (v >> 4) & 7);
        break;
      case 94: // 戦場の狼
        this.setPrg16k(0, (v >> 2) & 7);
        break;
    }
  }
}

/** UNROM の逆版（180、クレイジークライマー）：$8000 は最初に固定、$C000 を切り替え */
export class Mapper180 extends BaseMapper {
  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg16k(0, 0);
    this.setPrg16k(2, 0);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr >= 0x8000) this.setPrg16k(2, v & 7);
    else super.cpuWrite(addr, v);
  }
}

/** アイレム TAM-S1（97、快傑ヤンチャ丸）：$8000 は最後に固定、$C000 を切り替え */
export class Mapper97 extends BaseMapper {
  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg16k(0, -1);
    this.setPrg16k(2, 0);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    this.setPrg16k(2, v & 0x1f);
    this.mirror = v & 0x80 ? 'vertical' : 'horizontal';
  }
}

/** $6000-$7FFF に書いて CHR だけを切り替えるマッパー（87・101・184） */
export class ChrAt6000 extends BaseMapper {
  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg32k(0);
    if (this.prg.length <= 0x4000) this.setPrg16k(2, 0);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x6000 || addr >= 0x8000) return;
    switch (this.cart.mapper) {
      case 87: // ジャレコ・コナミ・タイトー：ビットの順が逆
        this.setChr8k(((v & 1) << 1) | ((v >> 1) & 1));
        break;
      case 101: // うる星やつら
        this.setChr8k(v);
        break;
      case 184: // サンソフト 1
        this.setChr4k(0, v & 7);
        this.setChr4k(4, (v >> 4) & 7);
        break;
    }
  }
}

/** ジャレコ JF-17/19（72・92）：ビット 7・6 が 0→1 になったときに PRG・CHR を切り替え */
export class Mapper72 extends BaseMapper {
  private last = 0;

  constructor(cart: Cartridge, host: MapperHost) {
    super(cart, host);
    this.setPrg16k(0, 0);
    this.setPrg16k(2, -1);
  }

  cpuWrite(addr: number, v: number): void {
    if (addr < 0x8000) return super.cpuWrite(addr, v);
    const rise = v & ~this.last;
    this.last = v;
    if (rise & 0x80) {
      if (this.cart.mapper === 92) this.setPrg16k(2, v & 0x0f);
      else this.setPrg16k(0, v & 0x0f);
    }
    if (rise & 0x40) this.setChr8k(v & 0x0f);
  }
}

export const MIRROR_VH1S: Mirroring[] = ['vertical', 'horizontal', 'single0', 'single1'];
export const MIRROR_HV1S: Mirroring[] = ['horizontal', 'vertical', 'single0', 'single1'];
