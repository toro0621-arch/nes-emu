// CD のイメージ（.bin + .cue、.iso）。数百 MB あるので全部は読み込まず、
// 使うところだけ少しずつファイルから読む（読み終わるまでドライブは待つ）

export const SECTOR = 2352;

/** ファイルの中身を読むもの（スマホのファイル＝Blob、テストでは Uint8Array） */
export interface DiscSource {
  readonly size: number;
  /** すでに読んであればすぐ返す。なければ読み始めて null */
  readNow(offset: number, len: number): Uint8Array | null;
}

/** Uint8Array をそのまま使う */
export class ArraySource implements DiscSource {
  constructor(private data: Uint8Array) {}
  get size() {
    return this.data.length;
  }
  readNow(offset: number, len: number): Uint8Array {
    return this.data.subarray(offset, offset + len);
  }
}

const CHUNK = 256 * 1024;
const MAX_CHUNKS = 160; // 40MB まで覚えておく

/** Blob（ファイル）から 256KB ずつ読んで覚えておく */
export class BlobSource implements DiscSource {
  private chunks = new Map<number, Uint8Array>();
  private loading = new Set<number>();
  constructor(private blob: Blob) {}
  get size() {
    return this.blob.size;
  }

  private load(n: number): void {
    if (this.chunks.has(n) || this.loading.has(n) || n * CHUNK >= this.blob.size) return;
    this.loading.add(n);
    this.blob
      .slice(n * CHUNK, Math.min(this.blob.size, (n + 1) * CHUNK))
      .arrayBuffer()
      .then((b) => {
        this.loading.delete(n);
        this.chunks.set(n, new Uint8Array(b));
        if (this.chunks.size > MAX_CHUNKS) {
          // いちばん古いものから捨てる
          const first = this.chunks.keys().next().value as number;
          this.chunks.delete(first);
        }
      })
      .catch(() => this.loading.delete(n));
  }

  readNow(offset: number, len: number): Uint8Array | null {
    const n0 = Math.floor(offset / CHUNK);
    const n1 = Math.floor((offset + len - 1) / CHUNK);
    // 先も読んでおく
    for (let k = 1; k <= 4; k++) this.load(n1 + k);
    let ok = true;
    for (let n = n0; n <= n1; n++) {
      const c = this.chunks.get(n);
      if (!c) {
        this.load(n);
        ok = false;
      } else {
        // よく使うものは後ろへ（捨てられにくく）
        this.chunks.delete(n);
        this.chunks.set(n, c);
      }
    }
    if (!ok) return null;
    if (n0 === n1) {
      const c = this.chunks.get(n0)!;
      const o = offset - n0 * CHUNK;
      return c.subarray(o, o + len);
    }
    const out = new Uint8Array(len);
    for (let n = n0, pos = 0; n <= n1; n++) {
      const c = this.chunks.get(n)!;
      const s = Math.max(offset, n * CHUNK) - n * CHUNK;
      const e = Math.min(offset + len, (n + 1) * CHUNK) - n * CHUNK;
      out.set(c.subarray(s, e), pos);
      pos += e - s;
    }
    return out;
  }

  /** 最初の部分を読み終わるまで待つ（起動を速くする） */
  async preload(offset: number, len: number): Promise<void> {
    const n0 = Math.floor(offset / CHUNK);
    const n1 = Math.floor((offset + len - 1) / CHUNK);
    for (let n = n0; n <= n1; n++) {
      if (this.chunks.has(n) || n * CHUNK >= this.blob.size) continue;
      const b = await this.blob.slice(n * CHUNK, Math.min(this.blob.size, (n + 1) * CHUNK)).arrayBuffer();
      this.chunks.set(n, new Uint8Array(b));
    }
  }
}

export interface Track {
  number: number;
  audio: boolean;
  /** トラックの始まり（INDEX 01）の絶対セクター番号（00:02:00 = 150） */
  start: number;
  /** INDEX 00（なければ start） */
  pregap: number;
  /** セクター数（start から） */
  length: number;
  source: DiscSource;
  /** start のセクターがファイルの何バイト目か */
  offset: number;
  sectorSize: number;
}

export function toBcd(n: number): number {
  return ((n / 10) | 0) * 16 + (n % 10);
}
export function fromBcd(b: number): number {
  return (b >> 4) * 10 + (b & 15);
}

export class Disc {
  constructor(
    public tracks: Track[],
    /** ディスクの終わり（絶対セクター番号） */
    public end: number,
  ) {}

  /** .bin（または .iso）1 つだけ */
  static fromSingle(source: DiscSource): Disc {
    const head = source.readNow(0, 16);
    const sync = !!head && head[0] === 0 && head[1] === 0xff && head[10] === 0xff && head[11] === 0;
    const raw = sync || (!head && source.size % SECTOR === 0 && source.size % 2048 !== 0);
    const size = raw ? SECTOR : 2048;
    const n = Math.floor(source.size / size);
    return new Disc([{ number: 1, audio: false, start: 150, pregap: 150, length: n, source, offset: 0, sectorSize: size }], 150 + n);
  }

  /** .cue を読む。files はファイル名（小文字）→ 中身 */
  static fromCue(cue: string, files: Map<string, DiscSource>): Disc {
    const tracks: Track[] = [];
    let source: DiscSource | null = null;
    let fileStart = 150; // このファイルの 0 バイト目の絶対セクター番号
    let fileSectors = 0;
    let gapShift = 0; // PREGAP（ファイルにない無音）の合計
    type Pending = Track & { idx0?: number; mode: string; fileStart: number; gap: number };
    let cur: Pending | null = null;
    const pending: Pending[] = [];
    const msf = (s: string) => {
      const [m, sec, f] = s.split(':').map((x) => parseInt(x, 10));
      return (m * 60 + sec) * 75 + f;
    };
    const lookup = (name: string): DiscSource | null => {
      const base = name.replace(/^.*[\\/]/, '').toLowerCase();
      return files.get(base) ?? (files.size === 1 ? [...files.values()][0] : null);
    };
    for (const line0 of cue.split(/\r?\n/)) {
      const line = line0.trim();
      const m = line.match(/^(\S+)\s*(.*)$/);
      if (!m) continue;
      const cmd = m[1].toUpperCase();
      const rest = m[2];
      if (cmd === 'FILE') {
        if (source) fileStart += fileSectors;
        const name = rest.match(/^"([^"]*)"/)?.[1] ?? rest.split(/\s+/)[0];
        source = lookup(name);
        if (!source) throw new Error(`「${name}」が見つかりません。.cue と一緒に選んでください`);
        fileSectors = 0;
        cur = null;
      } else if (cmd === 'TRACK') {
        const [num, mode] = rest.split(/\s+/);
        const up = (mode ?? '').toUpperCase();
        const sectorSize = up === 'AUDIO' ? SECTOR : parseInt(up.split('/')[1] ?? '2352', 10) || SECTOR;
        cur = {
          number: parseInt(num, 10),
          audio: up === 'AUDIO',
          start: 0,
          pregap: 0,
          length: 0,
          source: source!,
          offset: 0,
          sectorSize,
          mode: up,
          fileStart,
          gap: gapShift,
        };
        pending.push(cur);
        if (source) fileSectors = Math.floor(source.size / sectorSize);
      } else if (cmd === 'PREGAP' && cur) {
        gapShift += msf(rest.trim());
        cur.gap = gapShift;
      } else if (cmd === 'INDEX' && cur) {
        const [n, t] = rest.split(/\s+/);
        const pos = msf(t);
        const p = cur;
        if (parseInt(n, 10) === 0) p.idx0 = pos;
        else if (parseInt(n, 10) === 1) {
          p.offset = pos * p.sectorSize;
          p.start = p.fileStart + p.gap + pos;
          p.pregap = p.idx0 !== undefined ? p.fileStart + p.gap + p.idx0 : p.start;
        }
      }
    }
    if (source) fileStart += fileSectors;
    const end = fileStart + gapShift;
    // 長さ：次のトラックの始まりか、ファイルの終わりまで
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i];
      const fileEnd = t.fileStart + t.gap + Math.floor(t.source.size / t.sectorSize);
      const next = pending[i + 1];
      const lim = next && next.source === t.source ? next.pregap : fileEnd;
      t.length = Math.max(0, lim - t.start);
      tracks.push(t);
    }
    if (!tracks.length) throw new Error('.cue にトラックがありません');
    return new Disc(tracks, Math.max(end, tracks[tracks.length - 1].start + tracks[tracks.length - 1].length));
  }

  trackAt(lba: number): Track | null {
    for (let i = this.tracks.length - 1; i >= 0; i--) if (lba >= this.tracks[i].pregap) return this.tracks[i];
    return this.tracks[0] ?? null;
  }

  private buf = new Uint8Array(SECTOR);

  /** 絶対セクター番号の 2352 バイト。まだ読めていなければ null */
  read(lba: number): Uint8Array | null {
    const t = this.trackAt(lba);
    const out = this.buf;
    if (!t || lba < t.start || lba >= t.start + t.length) {
      // トラックの間の無音・ディスクの外
      out.fill(0);
      if (t && !t.audio) this.header(out, lba, 2);
      return out;
    }
    const pos = t.offset + (lba - t.start) * t.sectorSize;
    const d = t.source.readNow(pos, t.sectorSize);
    if (!d) return null;
    if (t.sectorSize === SECTOR) {
      out.set(d.subarray(0, SECTOR));
      return out;
    }
    // 2048 バイトのイメージ：まわりの情報を作る（モード 2 フォーム 1 として）
    out.fill(0);
    this.header(out, lba, 2);
    out[18] = out[22] = 0x08;
    out.set(d.subarray(0, Math.min(2048, d.length)), 24);
    return out;
  }

  private header(out: Uint8Array, lba: number, mode: number): void {
    out[0] = 0;
    for (let i = 1; i < 11; i++) out[i] = 0xff;
    out[11] = 0;
    out[12] = toBcd(Math.floor(lba / 4500));
    out[13] = toBcd(Math.floor(lba / 75) % 60);
    out[14] = toBcd(lba % 75);
    out[15] = mode;
  }

  /** ディスクのライセンスの国（起動したときの画面の速さを決める） */
  region(): 'ntsc' | 'pal' {
    // セクター 4（システムエリア）にライセンスの文字がある
    const s = this.read(150 + 4);
    if (!s) return 'ntsc';
    let txt = '';
    for (let i = 24; i < 24 + 80; i++) txt += String.fromCharCode(s[i]);
    return /Europe|Euro/i.test(txt) ? 'pal' : 'ntsc';
  }
}
