/**
 * RDP の「1 ドットを描く手順」を、そのときの設定に合わせた JavaScript の関数にする
 *
 * rdp.ts のふつうの描き方は、1 ドットごとに「どのテクスチャ形式か」「どう合成するか」「どう重ねるか」を
 * 調べながら進むので遅い。設定（合成・重ね合わせ・テクスチャの形式など）は 1 つの図形の中では変わらないので、
 * 設定ごとに、必要な計算だけを並べたループを文字列で組み立てて関数にする。
 * 計算の中身は rdp.ts の fetch / sample / combine / blend / plot とまったく同じ（結果は 1 ビットも変わらない）。
 */

export interface TileSpec {
  size: number;
  format: number;
  cs: boolean;
  ms: boolean;
  ct: boolean;
  mt: boolean;
  maskS: boolean;
  maskT: boolean;
  shiftS: number;
  shiftT: number;
}

export interface PixelSpec {
  /** rect：テクスチャつきの四角形、fill：色だけの四角形、tri：三角形の 1 ライン */
  kind: 'rect' | 'fill' | 'tri';
  omHi: number;
  omLo: number;
  combHi: number;
  combLo: number;
  ciSize: number;
  two: boolean;
  /** Z を使う（z >= 0） */
  hasZ: boolean;
  flip: boolean;
  shadeOn: boolean;
  texOn: boolean;
  zOn: boolean;
  t0: TileSpec | null;
  t1: TileSpec | null;
}

function tileKey(t: TileSpec | null): string {
  if (!t) return '-';
  return `${t.size}${t.format}${+t.cs}${+t.ms}${+t.ct}${+t.mt}${+t.maskS}${+t.maskT}.${t.shiftS}.${t.shiftT}`;
}

export function specKey(s: PixelSpec): string {
  return (
    s.kind +
    (s.omHi & 0x38e000) +
    '|' +
    s.omLo +
    '|' +
    s.combHi +
    '|' +
    s.combLo +
    '|' +
    s.ciSize +
    (s.hasZ ? 'z' : '') +
    (s.flip ? 'f' : '') +
    (s.shadeOn ? 's' : '') +
    (s.texOn ? 't' : '') +
    (s.zOn ? 'Z' : '') +
    tileKey(s.t0) +
    tileKey(s.t1)
  );
}

const RGB16 = (v: string, r: string, g: string, b: string, a: string) =>
  `{const c5=(${v}>>11)&31,d5=(${v}>>6)&31,e5=(${v}>>1)&31;${r}=(c5<<3)|(c5>>2);${g}=(d5<<3)|(d5>>2);${b}=(e5<<3)|(e5>>2);${a}=${v}&1?255:0;}`;

/** rdp.ts の fetch と同じ。p はタイルの変数の頭文字、o は結果を入れる変数（r,g,b,a）の頭 */
function genFetch(t: TileSpec, p: string, s: string, tt: string, o: string, tlut: boolean, tlutIA: boolean): string {
  let c = `{let fs=${s},ft=${tt};`;
  if (t.cs || !t.maskS) c += `if(fs<0)fs=0;else if(fs>${p}maxS)fs=${p}maxS;`;
  if (t.maskS) {
    if (t.ms) c += `if((fs>>${p}mkS)&1)fs=~fs;`;
    c += `fs&=${p}andS;`;
  }
  if (t.ct || !t.maskT) c += `if(ft<0)ft=0;else if(ft>${p}maxT)ft=${p}maxT;`;
  if (t.maskT) {
    if (t.mt) c += `if((ft>>${p}mkT)&1)ft=~ft;`;
    c += `ft&=${p}andT;`;
  }
  c += `const fbase=${p}base+ft*${p}line;`;
  const idx = (e: string) =>
    `{const fa=0x800+(${e})*8;const fv=(tm[fa&0xfff]<<8)|tm[(fa+1)&0xfff];` +
    (tlutIA ? `${o}r=${o}g=${o}b=fv>>8;${o}a=fv&0xff;` : RGB16('fv', o + 'r', o + 'g', o + 'b', o + 'a')) +
    '}';
  switch (t.size) {
    case 0:
      c += `const fb=tm[(fbase+(fs>>1))&0xfff];const fn=fs&1?fb&15:fb>>4;`;
      if (tlut || t.format === 2) c += idx(`(${p}pal<<4)|fn`);
      else if (t.format === 3) c += `${o}r=${o}g=${o}b=((fn>>1)*36.43)|0;${o}a=fn&1?255:0;`;
      else c += `${o}r=${o}g=${o}b=${o}a=fn*17;`;
      break;
    case 1:
      c += `const fb=tm[(fbase+fs)&0xfff];`;
      if (tlut || t.format === 2) c += idx('fb');
      else if (t.format === 3) c += `${o}r=${o}g=${o}b=(fb>>4)*17;${o}a=(fb&15)*17;`;
      else c += `${o}r=${o}g=${o}b=${o}a=fb;`;
      break;
    case 2:
      c += `const fa=(fbase+fs*2)&0xfff;const fv=(tm[fa]<<8)|tm[(fa+1)&0xfff];`;
      if (t.format === 3) c += `${o}r=${o}g=${o}b=fv>>8;${o}a=fv&0xff;`;
      else c += RGB16('fv', o + 'r', o + 'g', o + 'b', o + 'a');
      break;
    default:
      c += `const fa=(fbase+fs*2)&0x7ff;${o}r=tm[fa];${o}g=tm[fa+1];${o}b=tm[fa|0x800];${o}a=tm[(fa+1)|0x800];`;
  }
  return c + '}';
}

/** rdp.ts の sample と同じ。s・t は整数の式、結果は o＋r,g,b,a へ */
function genSample(t: TileSpec, p: string, s: string, tt: string, o: string, spec: PixelSpec): string {
  const tlut = (spec.omHi & 0x8000) !== 0;
  const ia = (spec.omHi & 0x4000) !== 0;
  let c = `{let ss=${s},st=${tt};`;
  if (t.shiftS) c += t.shiftS > 10 ? `ss=ss<<${16 - t.shiftS};` : `ss=ss>>${t.shiftS};`;
  if (t.shiftT) c += t.shiftT > 10 ? `st=st<<${16 - t.shiftT};` : `st=st>>${t.shiftT};`;
  c += `ss-=${p}sl3;st-=${p}tl3;`;
  if (!(spec.omHi & 0x2000)) return c + genFetch(t, p, 'ss>>5', 'st>>5', o, tlut, ia) + '}';
  c += `const si=ss>>5,ti=st>>5,sf=ss&31,tf=st&31;if(!sf&&!tf)${genFetch(t, p, 'si', 'ti', o, tlut, ia)}else{`;
  c += genFetch(t, p, 'si', 'ti', 'q0', tlut, ia);
  c += genFetch(t, p, 'si+1', 'ti', 'q1', tlut, ia);
  c += genFetch(t, p, 'si', 'ti+1', 'q2', tlut, ia);
  c += genFetch(t, p, 'si+1', 'ti+1', 'q3', tlut, ia);
  c += 'const w00=(32-sf)*(32-tf),w10=sf*(32-tf),w01=(32-sf)*tf,w11=sf*tf;';
  for (const ch of 'rgba') c += `${o}${ch}=(q0${ch}*w00+q1${ch}*w10+q2${ch}*w01+q3${ch}*w11+512)>>10;`;
  return c + '}}';
}

// 合成の入力（rdp.ts の rgbIn / alphaArr / decodeCombine と同じ選び方）。色は [r,g,b] の式
const SRC: Record<number, string[]> = {
  0: ['cr', 'cg', 'cb', 'ca'],
  1: ['ar', 'ag', 'ab', 'aa'],
  2: ['br', 'bg', 'bb', 'ba'],
  3: ['p0', 'p1', 'p2', 'p3'],
  4: ['sr', 'sg', 'sb', 'sa'],
  5: ['e0', 'e1', 'e2', 'e3'],
};
function rgbIn(sel: number, kind: number): string[] {
  if (sel < 6) return SRC[sel];
  if ((kind === 0 || kind === 3) && sel === 6) return ['255', '255', '255'];
  return ['0', '0', '0'];
}
function alphaIn(sel: number, mul: boolean): string {
  switch (sel) {
    case 0:
      return mul ? '255' : 'ca';
    case 6:
      return mul ? 'lod' : '255';
    case 7:
      return '0';
  }
  return SRC[sel][3];
}

function genCombine(cycle: number, hi: number, lo: number): string {
  let a: number, b: number, c: number, d: number, aa: number, ab: number, ac: number, ad: number;
  if (cycle === 0) {
    a = (hi >> 20) & 15;
    c = (hi >> 15) & 31;
    aa = (hi >> 12) & 7;
    ac = (hi >> 9) & 7;
    b = (lo >>> 28) & 15;
    d = (lo >> 15) & 7;
    ab = (lo >> 12) & 7;
    ad = (lo >> 9) & 7;
  } else {
    a = (hi >> 5) & 15;
    c = hi & 31;
    b = (lo >> 24) & 15;
    aa = (lo >> 21) & 7;
    ac = (lo >> 18) & 7;
    d = (lo >> 6) & 7;
    ab = (lo >> 3) & 7;
    ad = lo & 7;
  }
  const A = rgbIn(a, 0);
  const B = rgbIn(b, 1);
  const D = rgbIn(d, 3);
  let C: string[];
  if (c < 6) C = rgbIn(c, 2);
  else {
    const scalar: Record<number, string> = { 7: 'ca', 8: 'aa', 9: 'ba', 10: 'p3', 11: 'sa', 12: 'e3', 14: 'lod', 15: 'k5' };
    const v = scalar[c] ?? '0';
    C = [v, v, v];
  }
  const one = (A_: string, B_: string, C_: string, D_: string) => {
    // (A − B) × C が 0 になるなら D そのまま
    if (C_ === '0' || A_ === B_) return D_;
    return `cl(((${A_}-${B_})*${C_}+(${D_}<<8)+0x80)>>8)`;
  };
  return (
    `{const nr=${one(A[0], B[0], C[0], D[0])},ng=${one(A[1], B[1], C[1], D[1])},nb=${one(A[2], B[2], C[2], D[2])},` +
    `na=${one(alphaIn(aa, false), alphaIn(ab, false), alphaIn(ac, true), alphaIn(ad, false))};cr=nr;cg=ng;cb=nb;ca=na;}`
  );
}

function genReadFb(ci: number): string {
  if (ci === 2)
    return '{const fa=ciAddr+i*2;const fv=fa<ramSize?ram16[(fa>>1)^1]:0;const c5=(fv>>11)&31,d5=(fv>>6)&31,e5=(fv>>1)&31;mr=(c5<<3)|(c5>>2);mg=(d5<<3)|(d5>>2);mb=(e5<<3)|(e5>>2);}';
  if (ci === 3) return '{const fa=ciAddr+i*4;const fv=fa<ramSize?ram32[fa>>2]:0;mr=fv>>>24;mg=(fv>>16)&0xff;mb=(fv>>8)&0xff;}';
  return '{mr=mg=mb=R.ramByte(ciAddr+i);}';
}

function genWriteFb(ci: number, r: string, g: string, b: string): string {
  if (ci === 2) return `{const fa=ciAddr+i*2;if(fa<ramSize)ram16[(fa>>1)^1]=((${r}>>3)<<11)|((${g}>>3)<<6)|((${b}>>3)<<1)|1;}`;
  if (ci === 3) return `{const fa=ciAddr+i*4;if(fa<ramSize)ram32[fa>>2]=(${r}<<24)|(${g}<<16)|(${b}<<8)|0xff;}`;
  return `{const fa=ciAddr+i;if(fa<ramSize)ram8[fa^3]=${r};}`;
}

/** rdp.ts の blend と同じ（pr,pg,pb を書き換える） */
function genBlend(cycle: number, lo: number): string {
  const sh = cycle === 0 ? 2 : 0;
  const m1a = (lo >>> (28 + sh)) & 3;
  const m1b = (lo >>> (24 + sh)) & 3;
  const m2a = (lo >>> (20 + sh)) & 3;
  const m2b = (lo >>> (16 + sh)) & 3;
  const inp = (sel: number) => (sel === 0 ? ['pr', 'pg', 'pb'] : sel === 1 ? ['mr', 'mg', 'mb'] : sel === 2 ? ['bc0', 'bc1', 'bc2'] : ['f0', 'f1', 'f2']);
  const P = inp(m1a);
  const M = inp(m2a);
  const A = m1b === 0 ? 'alpha' : m1b === 1 ? 'f3' : m1b === 2 ? 'sa' : '0';
  const B = m2b === 0 ? '(255-bA)' : m2b === 3 ? '0' : '255';
  return (
    `{const bA=${A},bB=${B};const xr=cl((${P[0]}*bA+${M[0]}*bB+127)/255|0),xg=cl((${P[1]}*bA+${M[1]}*bB+127)/255|0),` +
    `xb=cl((${P[2]}*bA+${M[2]}*bB+127)/255|0);pr=xr;pg=xg;pb=xb;}`
  );
}

/** rdp.ts の plot と同じ。i（画面の中の位置）・z・dz が決まっているところに置く。描かないときは continue */
function genPlot(spec: PixelSpec): string {
  const lo = spec.omLo;
  const ci = spec.ciSize;
  const two = spec.two;
  const force = (lo & 0x4000) !== 0;
  const std = ((lo >>> 30) & 3) === 0 && ((lo >>> 26) & 3) === 0 && ((lo >>> 22) & 3) === 1 && ((lo >>> 18) & 3) === 0;
  let c = 'let alpha=ca;';
  if (lo & 1) c += 'if(alpha<bc3)continue;';
  if (lo & 0x1000) c += 'if(alpha===0)continue;';
  const zUse = spec.hasZ && (lo & 0x30) !== 0;
  if (zUse) c += 'const zAddr=ziAddr+i*2;';
  if (spec.hasZ && lo & 0x10) {
    const mode = (lo >> 10) & 3;
    const pass = mode === 3 ? 'Math.abs(z-old)<=dz' : mode === 2 ? 'z<old' : 'z<=old';
    c += `if(zAddr<ramSize){const old=Z_DEC[ram16[(zAddr>>1)^1]>>2];if(!(${pass}))continue;}`;
  }
  const zw = spec.hasZ && lo & 0x20 ? 'if(zAddr<ramSize)ram16[(zAddr>>1)^1]=zEncode(z);' : '';
  if (force && !two && std && !(lo & 0x2000)) {
    if (!zw) c += 'if(alpha===0)continue;';
    c += `if(alpha===255){${genWriteFb(ci, 'cr', 'cg', 'cb')}${zw}continue;}`;
    if (ci === 2) {
      c +=
        '{const fa=ciAddr+i*2;if(fa<ramSize){const fv=ram16[(fa>>1)^1];const c5=(fv>>11)&31,d5=(fv>>6)&31,e5=(fv>>1)&31;const bB=255-alpha;' +
        'const xr=((cr*alpha+((c5<<3)|(c5>>2))*bB+127)/255)|0,xg=((cg*alpha+((d5<<3)|(d5>>2))*bB+127)/255)|0,xb=((cb*alpha+((e5<<3)|(e5>>2))*bB+127)/255)|0;' +
        'ram16[(fa>>1)^1]=((xr>>3)<<11)|((xg>>3)<<6)|((xb>>3)<<1)|1;}}' +
        zw;
      return c;
    }
  }
  c += 'let pr=cr,pg=cg,pb=cb;';
  const needMem = force || two;
  if (needMem) c += genReadFb(ci);
  if (lo & 0x2000) c += lo & 0x1000 ? '' : 'alpha=255;';
  if (two) c += genBlend(0, lo);
  const last = two ? 1 : 0;
  if (force) c += genBlend(last, lo);
  else {
    const m1a = (lo >>> (last === 0 ? 30 : 28)) & 3;
    if (m1a) {
      if (m1a === 1 && !needMem) c += genReadFb(ci);
      c += m1a === 1 ? 'pr=mr;pg=mg;pb=mb;' : m1a === 2 ? 'pr=bc0;pg=bc1;pb=bc2;' : 'pr=f0;pg=f1;pb=f2;';
    }
  }
  return c + genWriteFb(ci, 'pr', 'pg', 'pb') + zw;
}

function genTileVars(p: string, tile: string): string {
  return (
    `const ${p}T=R.tiles[${tile}];const ${p}maxS=(${p}T.sh-${p}T.sl)>>2,${p}maxT=(${p}T.th-${p}T.tl)>>2,${p}mkS=${p}T.maskS,${p}mkT=${p}T.maskT,` +
    `${p}andS=(1<<${p}T.maskS)-1,${p}andT=(1<<${p}T.maskT)-1,${p}base=${p}T.tmem*8,${p}line=${p}T.line*8,${p}pal=${p}T.palette,${p}sl3=${p}T.sl<<3,${p}tl3=${p}T.tl<<3;`
  );
}

export type RectFn = (
  R: unknown,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x0r: number,
  y0r: number,
  s0: number,
  t0: number,
  dsdx: number,
  dtdy: number,
  tile: number,
) => void;
export type SpanFn = (R: unknown, P: Float64Array, y: number, xs: number, xe: number) => void;

/** 設定に合わせた関数の中身（JavaScript の文字列）を作る */
export function generate(spec: PixelSpec): string {
  const tex = spec.kind === 'rect' || (spec.kind === 'tri' && spec.texOn);
  let c =
    'const n=R.n64,tm=R.tmem,ram16=n.ram16,ram32=n.ram32,ram8=n.ram8,ramSize=n.ramSize,ciAddr=R.ciAddr,ciWidth=R.ciWidth,ziAddr=R.ziAddr;' +
    'const p0=R.prim[0],p1=R.prim[1],p2=R.prim[2],p3=R.prim[3],e0=R.env[0],e1=R.env[1],e2=R.env[2],e3=R.env[3];' +
    'const bc0=R.blendC[0],bc1=R.blendC[1],bc2=R.blendC[2],bc3=R.blendC[3],f0=R.fog[0],f1=R.fog[1],f2=R.fog[2],f3=R.fog[3],lod=R.lodArr[3],k5=R.k5Arr[3];' +
    'let cr=R.comb[0],cg=R.comb[1],cb=R.comb[2],ca=R.comb[3],ar=R.texel0[0],ag=R.texel0[1],ab=R.texel0[2],aa=R.texel0[3];' +
    'let br=R.texel1[0],bg=R.texel1[1],bb=R.texel1[2],ba=R.texel1[3],sr=R.shade[0],sg=R.shade[1],sb=R.shade[2],sa=R.shade[3];' +
    'let mr=0,mg=0,mb=0,q0r=0,q0g=0,q0b=0,q0a=0,q1r=0,q1g=0,q1b=0,q1a=0,q2r=0,q2g=0,q2b=0,q2a=0,q3r=0,q3g=0,q3b=0,q3a=0;';
  const tex1 = tex && spec.two;
  if (tex) c += genTileVars('u', spec.kind === 'tri' ? 'P[18]' : 'tile');
  if (tex1) c += genTileVars('v', spec.kind === 'tri' ? '((P[18]+1)&7)' : '((tile+1)&7)');
  const combine = (spec.two ? genCombine(0, spec.combHi, spec.combLo) : '') + genCombine(1, spec.combHi, spec.combLo);
  const plot = genPlot(spec);
  if (spec.kind === 'tri') {
    c +=
      'const xMajor=P[0],er=P[1],eg=P[2],eb=P[3],ea=P[4],es=P[5],et=P[6],ew=P[7],ez=P[8],drdx=P[9],dgdx=P[10],dbdx=P[11],dadx=P[12],' +
      'dsdx=P[13],dtdx=P[14],dwdx=P[15],dzdx=P[16],dz=P[17];const row=y*ciWidth;' +
      'for(let x=xs;x<=xe;x++){const dx=x-xMajor;';
    if (spec.shadeOn) c += 'sr=c8((er+drdx*dx)/65536);sg=c8((eg+dgdx*dx)/65536);sb=c8((eb+dbdx*dx)/65536);sa=c8((ea+dadx*dx)/65536);';
    if (spec.texOn) {
      c += 'let s=es+dsdx*dx,t=et+dtdx*dx;';
      if (spec.omHi & 0x80000) c += 'const ww=ew+dwdx*dx;if(ww>0){s=(s/ww)*32768;t=(t/ww)*32768;}else{s=0x7fff;t=0x7fff;}';
      else c += 's/=65536;t/=65536;';
      c += 'const sx=s|0,tx=t|0;' + genSample(spec.t0!, 'u', 'sx', 'tx', 'a', spec);
      if (spec.two) c += genSample(spec.t1!, 'v', 'sx', 'tx', 'b', spec);
    }
    c += combine;
    if (spec.hasZ) {
      if (spec.omLo & 4) c += 'const z=R.primZ<<3;';
      else c += 'let z=(ez+dzdx*dx)/8192;z=z<0?0:z>0x3ffff?0x3ffff:z|0;';
    }
    c += 'const i=row+x;' + plot + '}';
  } else {
    c += `const z=${spec.hasZ ? 'R.primZ<<3' : '-1'},dz=R.primDz;`;
    if (spec.kind === 'fill') {
      // テクスチャもシェードもないので、合成は 1 回だけ（rdp.ts と同じ）
      c += combine;
      c += 'for(let y=y0;y<y1;y++){const row=y*ciWidth;for(let x=x0;x<x1;x++){const i=row+x;' + plot + '}}';
    } else {
      c += 'for(let y=y0;y<y1;y++){const tv=t0+(y-y0r)*dtdy;const row=y*ciWidth;for(let x=x0;x<x1;x++){const sv=s0+(x-x0r)*dsdx;';
      const s = spec.flip ? 'tv>>5' : 'sv>>5';
      const t = spec.flip ? 'sv>>5' : 'tv>>5';
      c += genSample(spec.t0!, 'u', s, t, 'a', spec);
      if (spec.two) c += genSample(spec.t1!, 'v', s, t, 'b', spec);
      c += combine + 'const i=row+x;' + plot + '}}';
    }
  }
  // 途中の色は次の図形にも持ち越される（rdp.ts と同じ）
  c += 'R.comb[0]=cr;R.comb[1]=cg;R.comb[2]=cb;R.comb[3]=ca;';
  if (tex) c += 'R.texel0[0]=ar;R.texel0[1]=ag;R.texel0[2]=ab;R.texel0[3]=aa;';
  if (tex1) c += 'R.texel1[0]=br;R.texel1[1]=bg;R.texel1[2]=bb;R.texel1[3]=ba;';
  if (spec.kind === 'tri' && spec.shadeOn) c += 'R.shade[0]=sr;R.shade[1]=sg;R.shade[2]=sb;R.shade[3]=sa;';
  return c;
}

function cl(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
function c8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

export class RdpJit {
  private cache = new Map<string, RectFn | SpanFn | null>();
  ok = true;

  constructor(
    private zDec: Int32Array,
    private zEncode: (z: number) => number,
  ) {
    try {
      new Function('return 1')();
    } catch {
      this.ok = false;
    }
  }

  get(spec: PixelSpec): RectFn | SpanFn | null {
    if (!this.ok) return null;
    const key = specKey(spec);
    let f = this.cache.get(key);
    if (f !== undefined) return f;
    try {
      const args = spec.kind === 'tri' ? 'R,P,y,xs,xe' : 'R,x0,y0,x1,y1,x0r,y0r,s0,t0,dsdx,dtdy,tile';
      f = new Function('Z_DEC', 'zEncode', 'cl', 'c8', `return function(${args}){${generate(spec)}}`)(this.zDec, this.zEncode, cl, c8) as
        | RectFn
        | SpanFn;
    } catch (e) {
      console.error(e);
      f = null;
    }
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, f);
    return f;
  }
}
