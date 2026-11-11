// ゲームボーイのカートリッジ（ヘッダーの読み取りと MBC＝バンク切り替えチップ）

/** ヘッダーの任天堂ロゴの先頭 4 バイト（$0104〜）。ゲームボーイの ROM かどうかの見分けに使う */
const LOGO = [0xce, 0xed, 0x66, 0x66];

export function isGbRom(data: Uint8Array): boolean {
  return data.length >= 0x150 && LOGO.every((b, i) => data[0x104 + i] === b);
}

type Kind = 'none' | 'mbc1' | 'mbc2' | 'mbc3' | 'mbc5';

/** カートリッジの種類（$0147） → MBC の種類・バッテリーの有無・時計の有無 */
function cartType(t: number): { kind: Kind; battery: boolean; rtc: boolean; rumble: boolean } {
  const k = (kind: Kind, battery = false, rtc = false, rumble = false) => ({ kind, battery, rtc, rumble });
  switch (t) {
    case 0x00:
    case 0x08:
      return k('none');
    case 0x09:
      return k('none', true);
    case 0x01:
    case 0x02:
      return k('mbc1');
    case 0x03:
    case 0xff: // HuC1（赤外線以外は MBC1 と同じ）
      return k('mbc1', true);
    case 0x05:
      return k('mbc2');
    case 0x06:
      return k('mbc2', true);
    case 0x0f:
    case 0x10:
      return k('mbc3', true, true);
    case 0x11:
    case 0x12:
      return k('mbc3');
    case 0x13:
      return k('mbc3', true);
    case 0x19:
    case 0x1a:
      return k('mbc5');
    case 0x1b:
      return k('mbc5', true);
    case 0x1c:
    case 0x1d:
      return k('mbc5', false, false, true);
    case 0x1e:
      return k('mbc5', true, false, true);
  }
  throw new Error(`このカートリッジ（種類 $${t.toString(16).padStart(2, '0').toUpperCase()}）には未対応です`);
}

const RAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];

/** 時計（MBC3）のデータをセーブデータの後ろに置く大きさと、目印 */
const RTC_BYTES = 24;
const RTC_MAGIC = 0x47;

export class GbCart {
  readonly title: string;
  /** ゲームボーイカラー用（$0143 の bit7） */
  readonly cgb: boolean;
  readonly kind: Kind;
  readonly type: number;
  readonly battery: boolean;
  private readonly rtc: boolean;
  private readonly rumble: boolean;
  readonly rom: Uint8Array;
  /** 外付け RAM（MBC2 は 512 個の 4 ビット） */
  readonly ram: Uint8Array;
  /** 保存するデータ（RAM と、時計があればその後ろに時計の状態） */
  readonly saveRam: Uint8Array | null;
  saveDirty = false;

  private readonly romBanks: number;
  private ramOn = false;
  private bank1 = 1;
  private bank2 = 0;
  private mode = 0;
  private romBankLo = 1; // MBC3・MBC5 の ROM バンク
  private ramBank = 0;
  /** $0000〜$3FFF と $4000〜$7FFF の ROM の位置、$A000〜$BFFF の RAM の位置 */
  private rom0 = 0;
  private rom1 = 0x4000;
  private ramOff = 0;

  // 時計（MBC3）
  private rtcBase = 0; // 動いているとき：0 秒だった時刻（秒）
  private rtcHaltedAt = 0; // 止まっているとき：その時点の秒数
  private rtcHalt = false;
  private rtcCarry = false;
  private rtcLatched = [0, 0, 0, 0, 0];
  private rtcLatchArm = false;
  private rtcReady = false;

  constructor(rom: Uint8Array) {
    if (!isGbRom(rom)) throw new Error('ゲームボーイの ROM ではありません');
    this.rom = rom;
    this.title = String.fromCharCode(...rom.subarray(0x134, 0x143)).replace(/\0.*$/s, '').trim();
    this.cgb = (rom[0x143] & 0x80) !== 0;
    this.type = rom[0x147];
    const t = cartType(this.type);
    this.kind = t.kind;
    this.battery = t.battery;
    this.rtc = t.rtc;
    this.rumble = t.rumble;
    this.romBanks = Math.max(2, Math.ceil(rom.length / 0x4000));
    const ramSize = this.kind === 'mbc2' ? 0x200 : (RAM_SIZES[rom[0x149]] ?? 0);
    const total = ramSize + (this.rtc ? RTC_BYTES : 0);
    const buf = new Uint8Array(total);
    this.ram = buf.subarray(0, ramSize);
    this.saveRam = this.battery && total > 0 ? buf : null;
    this.update();
  }

  private update(): void {
    const n = this.romBanks;
    const mod = (b: number) => ((b % n) + n) % n;
    switch (this.kind) {
      case 'mbc1': {
        const lo = this.bank1 || 1;
        this.rom1 = mod((this.bank2 << 5) | lo) << 14;
        this.rom0 = this.mode ? mod(this.bank2 << 5) << 14 : 0;
        this.ramOff = this.mode ? this.bank2 << 13 : 0;
        break;
      }
      case 'mbc2':
        this.rom1 = mod(this.romBankLo || 1) << 14;
        break;
      case 'mbc3':
        this.rom1 = mod(this.romBankLo || 1) << 14;
        this.ramOff = (this.ramBank & 3) << 13;
        break;
      case 'mbc5':
        this.rom1 = mod(this.romBankLo) << 14;
        this.ramOff = (this.ramBank & (this.rumble ? 7 : 0x0f)) << 13;
        break;
    }
  }

  read(a: number): number {
    if (a < 0x4000) return this.rom[this.rom0 + a] ?? 0xff;
    if (a < 0x8000) return this.rom[this.rom1 + (a & 0x3fff)] ?? 0xff;
    // $A000〜$BFFF：外付け RAM
    if (!this.ramOn && this.kind !== 'none') return 0xff;
    if (this.kind === 'mbc2') return this.ram[a & 0x1ff] | 0xf0;
    if (this.rtc && this.ramBank >= 8) return this.ramBank <= 0x0c ? this.rtcLatched[this.ramBank - 8] : 0xff;
    const ram = this.ram;
    if (ram.length === 0) return 0xff;
    return ram[(this.ramOff + (a & 0x1fff)) % ram.length];
  }

  write(a: number, v: number): void {
    if (a >= 0xa000) {
      if (!this.ramOn && this.kind !== 'none') return;
      if (this.kind === 'mbc2') {
        this.ram[a & 0x1ff] = v & 0x0f;
      } else if (this.rtc && this.ramBank >= 8) {
        this.rtcWrite(this.ramBank - 8, v);
        return;
      } else {
        if (this.ram.length === 0) return;
        this.ram[(this.ramOff + (a & 0x1fff)) % this.ram.length] = v;
      }
      if (this.saveRam) this.saveDirty = true;
      return;
    }
    switch (this.kind) {
      case 'none':
        return;
      case 'mbc1':
        if (a < 0x2000) this.ramOn = (v & 0x0f) === 0x0a;
        else if (a < 0x4000) this.bank1 = v & 0x1f;
        else if (a < 0x6000) this.bank2 = v & 3;
        else this.mode = v & 1;
        break;
      case 'mbc2':
        if (a < 0x4000) {
          if (a & 0x100) this.romBankLo = v & 0x0f;
          else this.ramOn = (v & 0x0f) === 0x0a;
        }
        break;
      case 'mbc3':
        if (a < 0x2000) this.ramOn = (v & 0x0f) === 0x0a;
        else if (a < 0x4000) this.romBankLo = v & 0x7f;
        else if (a < 0x6000) this.ramBank = v & 0x0f;
        else if (this.rtc) {
          // 0 → 1 と書くと、そのときの時刻を読めるように写す
          if (v === 1 && this.rtcLatchArm) this.rtcLatch();
          this.rtcLatchArm = v === 0;
        }
        break;
      case 'mbc5':
        if (a < 0x2000) this.ramOn = (v & 0x0f) === 0x0a;
        else if (a < 0x3000) this.romBankLo = (this.romBankLo & 0x100) | v;
        else if (a < 0x4000) this.romBankLo = (this.romBankLo & 0xff) | ((v & 1) << 8);
        else if (a < 0x6000) this.ramBank = v & 0x0f;
        break;
    }
    this.update();
  }

  // ---- 時計（MBC3） ----

  /** セーブデータを読み込んだあとに呼ぶ（時計の状態を取り出す） */
  loadRtc(): void {
    if (!this.rtc) return;
    this.rtcReady = true;
    const buf = this.saveRam ?? new Uint8Array(0);
    const tail = this.ram.length;
    if (buf.length >= tail + RTC_BYTES && buf[tail + 17] === RTC_MAGIC) {
      const dv = new DataView(buf.buffer, buf.byteOffset + tail, RTC_BYTES);
      this.rtcBase = dv.getFloat64(0, true);
      this.rtcHaltedAt = dv.getFloat64(8, true);
      const flags = buf[tail + 16];
      this.rtcHalt = (flags & 1) !== 0;
      this.rtcCarry = (flags & 2) !== 0;
    } else {
      this.rtcBase = Date.now() / 1000;
      this.rtcHalt = false;
      this.rtcCarry = false;
      this.saveRtc();
    }
  }

  private saveRtc(): void {
    const buf = this.saveRam;
    if (!buf) return;
    const tail = this.ram.length;
    const dv = new DataView(buf.buffer, buf.byteOffset + tail, RTC_BYTES);
    dv.setFloat64(0, this.rtcBase, true);
    dv.setFloat64(8, this.rtcHaltedAt, true);
    buf[tail + 16] = (this.rtcHalt ? 1 : 0) | (this.rtcCarry ? 2 : 0);
    buf[tail + 17] = RTC_MAGIC;
    this.saveDirty = true;
  }

  /** 今の秒数（512 日を超えたら繰り上がりを立てて戻す） */
  private rtcSeconds(): number {
    if (!this.rtcReady) this.loadRtc();
    let t = this.rtcHalt ? this.rtcHaltedAt : Date.now() / 1000 - this.rtcBase;
    const max = 512 * 86400;
    if (t >= max) {
      t %= max;
      this.rtcCarry = true;
      this.setRtcSeconds(t);
    }
    return Math.max(0, t);
  }

  private setRtcSeconds(t: number): void {
    if (this.rtcHalt) this.rtcHaltedAt = t;
    else this.rtcBase = Date.now() / 1000 - t;
    this.saveRtc();
  }

  private rtcLatch(): void {
    const t = Math.floor(this.rtcSeconds());
    const days = Math.floor(t / 86400);
    this.rtcLatched = [
      t % 60,
      Math.floor(t / 60) % 60,
      Math.floor(t / 3600) % 24,
      days & 0xff,
      ((days >> 8) & 1) | (this.rtcHalt ? 0x40 : 0) | (this.rtcCarry ? 0x80 : 0),
    ];
  }

  private rtcWrite(reg: number, v: number): void {
    const t = this.rtcSeconds();
    let s = Math.floor(t) % 60;
    let m = Math.floor(t / 60) % 60;
    let h = Math.floor(t / 3600) % 24;
    let d = Math.floor(t / 86400);
    switch (reg) {
      case 0:
        s = v % 60;
        break;
      case 1:
        m = v % 60;
        break;
      case 2:
        h = v % 24;
        break;
      case 3:
        d = (d & 0x100) | v;
        break;
      case 4: {
        d = (d & 0xff) | ((v & 1) << 8);
        this.rtcCarry = (v & 0x80) !== 0;
        const halt = (v & 0x40) !== 0;
        const total = ((d * 24 + h) * 60 + m) * 60 + s;
        if (halt !== this.rtcHalt) {
          this.rtcHalt = halt;
          if (halt) this.rtcHaltedAt = total;
          else this.rtcBase = Date.now() / 1000 - total;
          this.saveRtc();
          this.rtcLatched[reg] = v;
          return;
        }
        break;
      }
    }
    this.setRtcSeconds(((d * 24 + h) * 60 + m) * 60 + s);
    this.rtcLatched[reg] = v;
  }
}
