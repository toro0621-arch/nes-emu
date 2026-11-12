// CD-ROM ドライブ：コマンドを受けて、少し時間がたってから返事（割り込み）を返す。
// データを読む・CD の音楽を流す・XA（ゲームの声や BGM によく使われる圧縮音声）をほどく

import { type Disc, SECTOR, fromBcd, toBcd } from './disc';

const CLOCK = 33868800;
const SECTOR_1X = Math.round(CLOCK / 75);
const SECTOR_2X = Math.round(CLOCK / 150);
const ACK = 25000;
const ACK_INIT = 80000;

const XA_POS = [0, 60, 115, 98];
const XA_NEG = [0, 0, -52, -55];

interface Resp {
  int: number;
  data: number[];
}

/** 2 つ目の返事の種類（届くときの状態で中身を作る） */
const enum Later {
  Stat,
  SeekDone,
  GetId,
  NoDisc,
}

/** CD から流れる音（XA と CD の音楽）を 44100Hz のステレオでためておく */
export class CdAudio {
  buf = new Int16Array(44100 * 2);
  head = 0;
  count = 0;
  private srcPos = 0;
  /** XA の前の値 */
  oldL = [0, 0];
  oldR = [0, 0];
  /** リサンプル用の前の値 */
  private lastL = 0;
  private lastR = 0;

  push(l: number, r: number): void {
    if (this.count >= this.buf.length / 2) return;
    const i = ((this.head + this.count) % (this.buf.length / 2)) * 2;
    this.buf[i] = l;
    this.buf[i + 1] = r;
    this.count++;
  }

  /** rate Hz の音を 44100Hz にして入れる */
  pushResampled(l: Int16Array, r: Int16Array, n: number, rate: number): void {
    const step = rate / 44100;
    let p = this.srcPos;
    while (p < n) {
      const i = Math.floor(p);
      const f = p - i;
      const l0 = i === 0 ? this.lastL : l[i - 1];
      const r0 = i === 0 ? this.lastR : r[i - 1];
      this.push(l0 + (l[i] - l0) * f, r0 + (r[i] - r0) * f);
      p += step;
    }
    this.srcPos = p - n;
    this.lastL = l[n - 1];
    this.lastR = r[n - 1];
  }

  /** 1 つ取り出す（なければ 0） */
  pop(out: Int32Array): void {
    if (this.count === 0) {
      out[0] = out[1] = 0;
      return;
    }
    const i = this.head * 2;
    out[0] = this.buf[i];
    out[1] = this.buf[i + 1];
    this.head = (this.head + 1) % (this.buf.length / 2);
    this.count--;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }
}

export class Cdrom {
  disc: Disc | null = null;
  audio = new CdAudio();
  index = 0;
  private params: number[] = [];
  private resp: number[] = [];
  private respPos = 0;
  intEnable = 0;
  intFlag = 0;
  /** まだ渡していない返事（前の割り込みが消されるのを待っている） */
  private queue: Resp[] = [];
  private queueAt = -1;
  /** 受け付けたコマンド（最初の返事を出す時刻） */
  private cmd = -1;
  private cmdAt = -1;
  /** 2 つ目の返事 */
  private second: { int: number; kind: number } | null = null;
  private secondAt = -1;
  // ドライブの状態
  stat = 0x02;
  mode = 0;
  private setloc = 0;
  private setlocPending = false;
  /** 読んでいる位置（絶対セクター番号） */
  pos = 150;
  reading = false;
  playing = false;
  private readAt = -1;
  /** 読み込み待ち（ファイルから届くまで）の回数 */
  stalls = 0;
  // データ
  private sector = new Uint8Array(SECTOR);
  private sectorReady = false;
  private data = new Uint8Array(0x930);
  private dataLen = 0;
  private dataPos = 0;
  private lastHeader = new Uint8Array(8);
  filterFile = 0;
  filterChan = 0;
  muted = false;
  adpcmMuted = false;
  // 音量（CD の左右 → SPU の左右）
  volLL = 0x80;
  volLR = 0;
  volRR = 0x80;
  volRL = 0;
  private nvol = [0x80, 0, 0x80, 0];
  private reportCount = 0;
  private xaL = new Int16Array(4032);
  private xaR = new Int16Array(4032);

  constructor(
    private now: () => number,
    private raiseIrq: () => void,
  ) {}

  /** 次に何か起きる時刻 */
  nextEvent(): number {
    let t = Infinity;
    if (this.cmdAt >= 0) t = Math.min(t, this.cmdAt);
    if (this.secondAt >= 0 && this.intFlag === 0) t = Math.min(t, this.secondAt);
    if (this.queueAt >= 0) t = Math.min(t, this.queueAt);
    if (this.readAt >= 0) t = Math.min(t, this.readAt);
    return t;
  }

  /** 時刻が来たものを処理する */
  tick(): void {
    const now = this.now();
    if (this.cmdAt >= 0 && now >= this.cmdAt) {
      this.cmdAt = -1;
      const c = this.cmd;
      this.cmd = -1;
      this.execute(c);
    }
    if (this.secondAt >= 0 && now >= this.secondAt && this.second) {
      const s = this.second;
      this.second = null;
      this.secondAt = -1;
      this.deliver({ int: s.int, data: this.laterData(s.kind) });
    }
    if (this.queueAt >= 0 && now >= this.queueAt) {
      this.queueAt = -1;
      this.flushQueue();
    }
    if (this.readAt >= 0 && now >= this.readAt) this.readSector();
  }

  // ---- レジスタ ----
  read(a: number): number {
    switch (a & 3) {
      case 0: {
        let s = this.index;
        if (this.params.length === 0) s |= 0x08;
        if (this.params.length < 16) s |= 0x10;
        if (this.respPos < this.resp.length) s |= 0x20;
        if (this.dataPos < this.dataLen) s |= 0x40;
        if (this.cmdAt >= 0) s |= 0x80;
        return s;
      }
      case 1: {
        if (this.respPos < this.resp.length) return this.resp[this.respPos++];
        return 0;
      }
      case 2:
        return this.readData();
      case 3:
        if (this.index & 1) return this.intFlag | 0xe0;
        return this.intEnable | 0xe0;
    }
    return 0;
  }

  readData(): number {
    if (this.dataPos >= this.dataLen) {
      // 空のときは最後のバイトをくり返す
      return this.dataLen ? this.data[this.dataLen - 1] : 0;
    }
    return this.data[this.dataPos++];
  }

  /** DMA で 4 バイトずつ */
  readWord(): number {
    return this.readData() | (this.readData() << 8) | (this.readData() << 16) | (this.readData() << 24);
  }

  write(a: number, v: number): void {
    const r = a & 3;
    if (r === 0) {
      this.index = v & 3;
      return;
    }
    switch (this.index * 4 + r) {
      case 1:
        this.command(v);
        return;
      case 2:
        if (this.params.length < 16) this.params.push(v);
        return;
      case 3:
        if (v & 0x80) {
          if (this.dataPos >= this.dataLen && this.sectorReady) this.loadData();
        } else {
          this.dataLen = this.dataPos = 0;
        }
        return;
      case 5:
        return;
      case 6:
        this.intEnable = v & 0x1f;
        return;
      case 7:
        this.intFlag &= ~(v & 0x1f);
        if (v & 0x40) this.params = [];
        if (this.intFlag === 0) {
          if (this.queue.length) this.queueAt = this.now() + 1500;
          else if (this.second) this.secondAt = Math.max(this.secondAt, this.now() + 1500);
        }
        return;
      case 9:
        return;
      case 10:
        this.nvol[0] = v;
        return;
      case 11:
        this.nvol[1] = v;
        return;
      case 13:
        this.nvol[2] = v;
        return;
      case 14:
        this.nvol[3] = v;
        return;
      case 15:
        if (v & 0x20) {
          this.volLL = this.nvol[0];
          this.volLR = this.nvol[1];
          this.volRR = this.nvol[2];
          this.volRL = this.nvol[3];
        }
        this.adpcmMuted = (v & 1) !== 0;
        return;
    }
  }

  /** セクターをデータの入れ物へ（モードで 2048 か 2340 バイト） */
  private loadData(): void {
    if (this.mode & 0x20) {
      this.data.set(this.sector.subarray(12, 12 + 0x924));
      this.dataLen = 0x924;
    } else {
      this.data.set(this.sector.subarray(24, 24 + 0x800));
      this.dataLen = 0x800;
    }
    this.dataPos = 0;
  }

  // ---- 返事 ----
  private deliver(r: Resp): void {
    if (this.intFlag !== 0) {
      // 前の割り込みが残っている：あとで
      if (r.int === 1) {
        // データの知らせは最新のものだけ
        const i = this.queue.findIndex((q) => q.int === 1);
        if (i >= 0) this.queue.splice(i, 1);
      }
      this.queue.push(r);
      return;
    }
    this.resp = r.data;
    this.respPos = 0;
    this.intFlag = r.int;
    if (this.intFlag & this.intEnable) this.raiseIrq();
  }

  private flushQueue(): void {
    if (this.intFlag !== 0 || !this.queue.length) return;
    this.deliver(this.queue.shift()!);
  }

  private ack(data: number[] = [this.stat]): void {
    this.deliver({ int: 3, data });
  }

  private error(code: number): void {
    this.deliver({ int: 5, data: [this.stat | 1, code] });
  }

  private later(delay: number, int: number, kind: Later): void {
    this.second = { int, kind };
    this.secondAt = this.now() + delay;
  }

  private laterData(kind: number): number[] {
    switch (kind) {
      case Later.SeekDone:
        this.stat &= ~0x40;
        return [this.stat];
      case Later.NoDisc:
        return [0x08, 0x40, 0, 0, 0, 0, 0, 0];
      case Later.GetId: {
        const d = this.disc!;
        if (d.tracks.every((t) => t.audio)) return [this.stat | 0x08, 0x90, 0, 0, 0, 0, 0, 0];
        // ライセンスの文字（地域）
        const lic = d.region() === 'pal' ? 'SCEE' : 'SCEA';
        return [this.stat, 0x00, 0x20, 0x00, ...Array.from(lic, (ch) => ch.charCodeAt(0))];
      }
    }
    return [this.stat];
  }

  // ---- コマンド ----
  private command(v: number): void {
    // 前のコマンドの返事を待たずに次が来ても、新しいほうを受け付ける
    this.cmd = v;
    this.cmdAt = this.now() + (v === 0x0a ? ACK_INIT : ACK);
  }

  private get speedCycles(): number {
    return this.mode & 0x80 ? SECTOR_2X : SECTOR_1X;
  }

  private seekTime(): number {
    const d = Math.abs(this.setloc - this.pos);
    return 20000 + Math.min(1500000, d * 20);
  }

  private stopReading(): void {
    this.reading = false;
    this.playing = false;
    this.readAt = -1;
    this.stat &= ~0xe0;
  }

  private execute(c: number): void {
    const p = this.params;
    this.params = [];
    if (!this.disc && c !== 0x01 && c !== 0x19 && c !== 0x0a && c !== 0x0e && c !== 0x1a) {
      this.error(0x80);
      return;
    }
    switch (c) {
      case 0x01: // GetStat
        this.ack();
        this.stat &= ~0x10;
        return;
      case 0x02: // Setloc
        if (p.length < 3) return this.error(0x20);
        this.setloc = (fromBcd(p[0]) * 60 + fromBcd(p[1])) * 75 + fromBcd(p[2]);
        this.setlocPending = true;
        this.ack();
        return;
      case 0x03: {
        // Play
        const track = p.length ? fromBcd(p[0]) : 0;
        if (track && this.disc) {
          const t = this.disc.tracks.find((x) => x.number === track);
          if (t) {
            this.setloc = t.start;
            this.setlocPending = true;
          }
        }
        this.stopReading();
        if (this.setlocPending) {
          this.pos = this.setloc;
          this.setlocPending = false;
        }
        this.playing = true;
        this.stat |= 0x82;
        this.reportCount = 0;
        this.readAt = this.now() + this.seekTime() + this.speedCycles;
        this.ack();
        return;
      }
      case 0x04:
      case 0x05:
        this.ack();
        return;
      case 0x06: // ReadN
      case 0x1b: {
        // ReadS
        this.stopReading();
        let delay = this.speedCycles;
        if (this.setlocPending) {
          delay += this.seekTime();
          this.pos = this.setloc;
          this.setlocPending = false;
        }
        this.reading = true;
        this.stat |= 0x22;
        this.readAt = this.now() + delay;
        this.ack();
        return;
      }
      case 0x07: // MotorOn
        this.stat |= 0x02;
        this.ack();
        this.later(SECTOR_1X / 2, 2, Later.Stat);
        return;
      case 0x08: // Stop
        this.stopReading();
        this.ack();
        this.stat &= ~0x02;
        this.later(SECTOR_1X, 2, Later.Stat);
        return;
      case 0x09: {
        // Pause
        const was = this.reading || this.playing;
        this.ack();
        this.stopReading();
        this.later(was ? (this.mode & 0x80 ? 2157000 / 2 : 2157000) / 20 : 7000, 2, Later.Stat);
        return;
      }
      case 0x0a: // Init
        this.stopReading();
        this.mode = 0;
        this.stat = 0x02;
        this.ack();
        this.later(ACK_INIT, 2, Later.Stat);
        return;
      case 0x0b:
        this.muted = true;
        this.ack();
        return;
      case 0x0c:
        this.muted = false;
        this.ack();
        return;
      case 0x0d:
        this.filterFile = p[0] ?? 0;
        this.filterChan = p[1] ?? 0;
        this.ack();
        return;
      case 0x0e:
        this.mode = p[0] ?? 0;
        this.ack();
        return;
      case 0x0f:
        this.ack([this.stat, this.mode, 0, this.filterFile, this.filterChan]);
        return;
      case 0x10: // GetlocL
        this.ack(Array.from(this.lastHeader));
        return;
      case 0x11: {
        // GetlocP
        const d = this.disc!;
        const lba = this.pos;
        const t = d.trackAt(lba);
        const rel = t ? Math.abs(lba - t.start) : lba;
        const idx = t && lba < t.start ? 0 : 1;
        this.ack([
          toBcd(t ? t.number : 1),
          idx,
          toBcd(Math.floor(rel / 4500)),
          toBcd(Math.floor(rel / 75) % 60),
          toBcd(rel % 75),
          toBcd(Math.floor(lba / 4500)),
          toBcd(Math.floor(lba / 75) % 60),
          toBcd(lba % 75),
        ]);
        return;
      }
      case 0x12:
        this.ack();
        this.later(ACK, 2, Later.Stat);
        return;
      case 0x13: {
        const d = this.disc!;
        this.ack([this.stat, toBcd(d.tracks[0].number), toBcd(d.tracks[d.tracks.length - 1].number)]);
        return;
      }
      case 0x14: {
        const d = this.disc!;
        const n = p.length ? fromBcd(p[0]) : 0;
        let at: number;
        if (n === 0) at = d.end;
        else {
          const t = d.tracks.find((x) => x.number === n);
          if (!t) return this.error(0x10);
          at = t.start;
        }
        this.ack([this.stat, toBcd(Math.floor(at / 4500)), toBcd(Math.floor(at / 75) % 60)]);
        return;
      }
      case 0x15: // SeekL
      case 0x16: {
        // SeekP
        this.stopReading();
        this.stat |= 0x42;
        this.ack();
        const t = this.seekTime();
        this.pos = this.setloc;
        this.setlocPending = false;
        this.later(t, 2, Later.SeekDone);
        return;
      }
      case 0x19: {
        const sub = p[0] ?? 0;
        if (sub === 0x20) this.ack([0x94, 0x09, 0x19, 0xc0]);
        else if (sub === 0x04 || sub === 0x05) this.ack([this.stat, 0, 0]);
        else this.error(0x10);
        return;
      }
      case 0x1a: // GetID
        if (!this.disc) {
          this.ack([0x08]);
          this.later(ACK, 5, Later.NoDisc);
          return;
        }
        this.ack();
        this.later(ACK * 2, 2, Later.GetId);
        return;
      case 0x1c:
        this.stopReading();
        this.ack();
        return;
      case 0x1d:
        this.error(0x40);
        return;
      case 0x1e: // ReadTOC
        this.ack();
        this.later(ACK * 20, 2, Later.Stat);
        return;
    }
    this.error(0x40);
  }

  // ---- 読む ----
  private readSector(): void {
    const d = this.disc;
    if (!d || (!this.reading && !this.playing)) {
      this.readAt = -1;
      return;
    }
    const s = d.read(this.pos);
    if (!s) {
      // ファイルから届くのを待つ
      this.stalls++;
      this.readAt = this.now() + 20000;
      return;
    }
    this.readAt = this.now() + this.speedCycles;
    const lba = this.pos++;
    const t = d.trackAt(lba);
    if (this.playing || (t && t.audio)) {
      if (this.playing) {
        // CD の音楽
        if (!this.muted && t && t.audio) {
          for (let i = 0; i < SECTOR; i += 4) {
            const l = (s[i] | (s[i + 1] << 8)) << 16 >> 16;
            const r = (s[i + 2] | (s[i + 3] << 8)) << 16 >> 16;
            this.audio.push(l, r);
          }
        }
        if (this.mode & 0x04 && ++this.reportCount % 10 === 0 && t) {
          const rel = Math.max(0, lba - t.start);
          this.deliver({
            int: 1,
            data: [
              this.stat,
              toBcd(t.number),
              1,
              toBcd(Math.floor(rel / 4500)),
              toBcd(Math.floor(rel / 75) % 60),
              toBcd(rel % 75),
              0,
              0,
            ],
          });
        }
        if (t && lba + 1 >= t.start + t.length) {
          // トラックの終わり
          if (this.mode & 0x02) {
            this.stopReading();
            this.deliver({ int: 4, data: [this.stat] });
          }
        }
        return;
      }
    }
    this.lastHeader.set(s.subarray(12, 20));
    // XA の音声
    const submode = s[18];
    if (this.mode & 0x40 && s[15] === 2 && submode & 0x04) {
      if (!(this.mode & 0x08) || (s[16] === this.filterFile && s[17] === this.filterChan)) this.decodeXa(s);
      return;
    }
    this.sector.set(s);
    this.sectorReady = true;
    this.deliver({ int: 1, data: [this.stat] });
  }

  private decodeXa(s: Uint8Array): void {
    if (this.muted || this.adpcmMuted) return;
    const coding = s[19];
    const stereo = (coding & 3) === 1;
    const rate = coding & 0x04 ? 18900 : 37800;
    const bits8 = (coding & 0x30) === 0x10;
    const L = this.xaL;
    const R = this.xaR;
    let nl = 0;
    let nr = 0;
    const units = bits8 ? 4 : 8;
    for (let g = 0; g < 18; g++) {
      const base = 24 + g * 128;
      for (let u = 0; u < units; u++) {
        const hdr = s[base + 4 + u];
        let shift = hdr & 15;
        if (shift > (bits8 ? 8 : 12)) shift = bits8 ? 8 : 9;
        const f = (hdr >> 4) & 3;
        const right = stereo && u & 1;
        const old = right ? this.audio.oldR : this.audio.oldL;
        for (let j = 0; j < 28; j++) {
          let x: number;
          if (bits8) x = ((s[base + 16 + j * 4 + u] << 24) >> 16) >> shift;
          else {
            const b = s[base + 16 + j * 4 + (u >> 1)];
            const nib = u & 1 ? b >> 4 : b & 15;
            x = ((nib << 28) >> 16) >> shift;
          }
          x += (old[0] * XA_POS[f] + old[1] * XA_NEG[f] + 32) >> 6;
          x = Math.max(-32768, Math.min(32767, x));
          old[1] = old[0];
          old[0] = x;
          if (right) R[nr++] = x;
          else L[nl++] = x;
        }
      }
    }
    if (stereo) this.audio.pushResampled(L, R, Math.min(nl, nr), rate);
    else this.audio.pushResampled(L, L, nl, rate);
  }

  stateSkip(): unknown[] {
    return [this.disc, this.audio, this.xaL, this.xaR];
  }
}
