// ドットをなめらかにして表示する（スマホの GPU で描く。WebGL2）。
// 強め：xBR という考え方（まわりの色の差から輪郭の向きを読み、角を斜めの線で描き直す。浅い・急な傾きも見る）。
// 軽め：上下・左右の 4 つだけを見て、角を 45° に丸める（EPX に近い）。
// どちらも 1 つの点の中の位置ごとに、その点の色かとなりの色かを決めるので、拡大しても輪郭がくっきり残る

export type SmoothMode = 'off' | 'light' | 'strong';

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  // 画面いっぱいの三角形 1 つ
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform ivec2 u_size;
uniform vec2 u_origin;
uniform vec2 u_view;
uniform int u_mode; // 1 = 軽め, 2 = 強め

vec3 px(ivec2 p) {
  return texelFetch(u_tex, clamp(p, ivec2(0), u_size - 1), 0).rgb;
}

// 色の差（明るさを重く見る）
float df(vec3 a, vec3 b) {
  vec3 d = a - b;
  float y = 0.299 * d.r + 0.587 * d.g + 0.114 * d.b;
  float u = -0.169 * d.r - 0.331 * d.g + 0.499 * d.b;
  float v = 0.499 * d.r - 0.418 * d.g - 0.0813 * d.b;
  return 48.0 * abs(y) + 7.0 * abs(u) + 6.0 * abs(v);
}
// ほぼ同じ色か（0〜255 で言うと差が 15 くらいまで）
bool eq(vec3 a, vec3 b) { return df(a, b) < 0.06; }

// 線のどちら側か（ふちは画面の 1 ドットぶんだけぼかす）
float cover(float v) {
  float w = max(fwidth(v), 1e-4);
  return clamp(v / w + 0.5, 0.0, 1.0);
}

void main() {
  // 元の画面の上の位置（右下が角になるように折り返す）
  vec2 pos = u_origin + v_uv * u_view;
  vec2 cell = floor(pos);
  vec2 fp = pos - cell;
  ivec2 c = ivec2(cell);
  ivec2 s = ivec2(fp.x >= 0.5 ? 1 : -1, fp.y >= 0.5 ? 1 : -1);
  vec2 q = vec2(s.x > 0 ? fp.x : 1.0 - fp.x, s.y > 0 ? fp.y : 1.0 - fp.y);
  ivec2 dx = ivec2(s.x, 0);
  ivec2 dy = ivec2(0, s.y);

  vec3 E = px(c);
  vec3 F = px(c + dx);
  vec3 H = px(c + dy);
  vec3 D = px(c - dx);
  vec3 B = px(c - dy);
  vec3 col = E;

  if (u_mode == 1) {
    // 軽め：となりの 2 つが同じ色で、自分と違えば、角をその色で丸める
    if (eq(F, H) && !eq(E, F) && !eq(F, B) && !eq(H, D)) {
      col = mix(E, F, cover(q.x + q.y - 1.5));
    }
  } else {
    vec3 I = px(c + dx + dy);
    vec3 C = px(c + dx - dy);
    vec3 G = px(c - dx + dy);
    vec3 F4 = px(c + 2 * dx);
    vec3 H5 = px(c + 2 * dy);
    vec3 I4 = px(c + 2 * dx + dy);
    vec3 I5 = px(c + dx + 2 * dy);
    // 輪郭が F-H の向き（e が小さい）か、E-I の向き（i が小さい）か
    float e = df(E, C) + df(E, G) + df(I, F4) + df(I, H5) + 4.0 * df(H, F);
    float i = df(H, D) + df(H, I5) + df(F, I4) + df(F, B) + 4.0 * df(E, I);
    bool rule = e < i && !eq(E, F) && !eq(E, H) &&
      ((!eq(F, B) && !eq(H, D)) || (eq(E, I) && !eq(F, I4) && !eq(H, I5)) || eq(E, G) || eq(E, C));
    if (rule) {
      vec3 p = df(E, F) <= df(E, H) ? F : H;
      float ke = df(F, G);
      float ki = df(H, C);
      float a = cover(q.x + q.y - 1.5);
      // 浅い傾き・急な傾き
      if (ke * 2.0 <= ki && !eq(E, G) && !eq(D, G)) a = max(a, cover(q.x * 0.5 + q.y - 1.0));
      if (ki * 2.0 <= ke && !eq(E, C) && !eq(B, C)) a = max(a, cover(q.x + q.y * 0.5 - 1.0));
      col = mix(E, p, a);
    }
  }
  outColor = vec4(col, 1.0);
}`;

export class SmoothScreen {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private texW = 0;
  private texH = 0;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  mode: SmoothMode = 'off';

  constructor(wrap: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'screen-gl';
    this.canvas.hidden = true;
    wrap.insertBefore(this.canvas, wrap.firstChild?.nextSibling ?? null);
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.gl = null;
    });
    this.canvas.addEventListener('webglcontextrestored', () => this.init());
    new ResizeObserver(() => this.resize()).observe(wrap);
  }

  /** GPU が使えなければ false（そのときは今までどおりの表示） */
  setMode(mode: SmoothMode): boolean {
    this.mode = mode;
    if (mode !== 'off' && !this.gl && !this.init()) {
      this.mode = 'off';
      this.canvas.hidden = true;
      return false;
    }
    this.canvas.hidden = mode === 'off';
    this.resize();
    return true;
  }

  private init(): boolean {
    const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) return false;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
      this.prog = p;
    } catch (e) {
      console.error(e);
      return false;
    }
    for (const n of ['u_tex', 'u_size', 'u_origin', 'u_view', 'u_mode']) this.loc[n] = gl.getUniformLocation(this.prog, n);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texW = this.texH = 0;
    this.gl = gl;
    return true;
  }

  /** 表示の大きさ × 画面の細かさ（最大でだいたい 2000 ドット） */
  private resize(): void {
    if (this.mode === 'off') return;
    const w = this.canvas.offsetWidth;
    const h = this.canvas.offsetHeight;
    if (!w || !h) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2000 / Math.max(w, h));
    const cw = Math.round(w * scale);
    const ch = Math.round(h * scale);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
  }

  /** 1 フレームを描く（frame は ABGR の画面バッファ、crop は上下左右から切り落とす幅） */
  draw(frame: Uint32Array, width: number, height: number, crop: number): void {
    const gl = this.gl;
    if (this.mode === 'off' || !gl || !this.prog) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const bytes = new Uint8Array(frame.buffer, frame.byteOffset, width * height * 4);
    if (this.texW !== width || this.texH !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      this.texW = width;
      this.texH = height;
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.uniform1i(this.loc.u_tex, 0);
    gl.uniform2i(this.loc.u_size, width, height);
    gl.uniform2f(this.loc.u_origin, crop, crop);
    gl.uniform2f(this.loc.u_view, width - crop * 2, height - crop * 2);
    gl.uniform1i(this.loc.u_mode, this.mode === 'light' ? 1 : 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
