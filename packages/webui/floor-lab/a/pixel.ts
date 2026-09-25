/**
 * 像素绘图原语:整数矩形、描边盒、抖动、颜色运算、3×5 像素字、种子随机。
 */
export type Ctx = CanvasRenderingContext2D;

export function rect(g: Ctx, x: number, y: number, w: number, h: number, c: string): void {
  if (w <= 0 || h <= 0) return;
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function px(g: Ctx, x: number, y: number, c: string): void {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), 1, 1);
}

export function hline(g: Ctx, x: number, y: number, w: number, c: string): void {
  rect(g, x, y, w, 1, c);
}
export function vline(g: Ctx, x: number, y: number, h: number, c: string): void {
  rect(g, x, y, 1, h, c);
}

/** 带 1px 描边、顶部高光、底部阴影的盒子 */
export function box(g: Ctx, x: number, y: number, w: number, h: number, fill: string, hi: string, dark: string, outline?: string): void {
  if (outline) rect(g, x - 1, y - 1, w + 2, h + 2, outline);
  rect(g, x, y, w, h, fill);
  hline(g, x, y, w, hi);
  vline(g, x, y, h, hi);
  hline(g, x, y + h - 1, w, dark);
  vline(g, x + w - 1, y, h, dark);
}

/** 棋盘抖动填充 */
export function dither(g: Ctx, x: number, y: number, w: number, h: number, c: string, phase = 0): void {
  g.fillStyle = c;
  for (let j = 0; j < h; j++) for (let i = (j + phase) & 1; i < w; i += 2) g.fillRect(x + i, y + j, 1, 1);
}

/** 像素椭圆填充(扫描线) */
export function ellipse(g: Ctx, cx: number, cy: number, rx: number, ry: number, c: string): void {
  g.fillStyle = c;
  for (let j = -ry; j <= ry; j++) {
    const k = 1 - (j * j) / (ry * ry + 0.0001);
    if (k < 0) continue;
    const hw = Math.round(rx * Math.sqrt(k));
    g.fillRect(Math.round(cx - hw), Math.round(cy + j), hw * 2 + 1, 1);
  }
}

/** 抖动的椭圆(用于光池) */
export function ellipseDither(g: Ctx, cx: number, cy: number, rx: number, ry: number, c: string, phase = 0): void {
  g.fillStyle = c;
  for (let j = -ry; j <= ry; j++) {
    const k = 1 - (j * j) / (ry * ry + 0.0001);
    if (k < 0) continue;
    const hw = Math.round(rx * Math.sqrt(k));
    const y = Math.round(cy + j);
    for (let i = -hw; i <= hw; i++) if (((i + y + phase) & 1) === 0) g.fillRect(Math.round(cx + i), y, 1, 1);
  }
}

export function hex(c: string): [number, number, number] {
  let s = c.replace('#', '');
  if (s.length === 3) s = s.split('').map((ch) => ch + ch).join('');
  const n = parseInt(s.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function toHex(r: number, g: number, b: number): string {
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + ((1 << 24) | (cl(r) << 16) | (cl(g) << 8) | cl(b)).toString(16).slice(1);
}
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
export function shade(c: string, k: number): string {
  return k >= 0 ? mix(c, '#ffffff', k) : mix(c, '#000000', -k);
}
export function rgba(c: string, a: number): string {
  const [r, g, b] = hex(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 稳定的伪随机(整数哈希),用于逐帧不闪的「随机」 */
export function hash(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// ---------- 3×5 像素字 ----------
const GLYPHS: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111',
  '9': '111101111001110', '.': '000000000000010', ',': '000000000010100', ':': '000010000010000', '-': '000000111000000',
  '+': '000010111010000', '%': '101001010100101', '/': '001001010100100', '>': '100010001010100', '<': '001010100010001',
  '!': '010010010000010', '?': '110001010000010', $: '011110010011110', '#': '101111101111101', '*': '000101010101000',
  "'": '010010000000000', '(': '010100100100010', ')': '010001001001010', '=': '000111000111000', '_': '000000000000111',
  '|': '010010010010010', '&': '010101010101011', '^': '010101000000000', ' ': '000000000000000',
};

export function textWidth(s: string, scale = 1): number {
  return s.length ? (s.length * 4 - 1) * scale : 0;
}

export function text(g: Ctx, s: string, x: number, y: number, c: string, scale = 1): void {
  g.fillStyle = c;
  let cx = Math.round(x);
  const yy = Math.round(y);
  for (const ch of s.toUpperCase()) {
    const gl = GLYPHS[ch] ?? GLYPHS['?']!;
    for (let i = 0; i < 15; i++) if (gl[i] === '1') g.fillRect(cx + (i % 3) * scale, yy + Math.floor(i / 3) * scale, scale, scale);
    cx += 4 * scale;
  }
}

export function textCenter(g: Ctx, s: string, cx: number, y: number, c: string, scale = 1): void {
  text(g, s, Math.round(cx - textWidth(s, scale) / 2), y, c, scale);
}

/** 带 1px 暗描边的字 */
export function textOutlined(g: Ctx, s: string, x: number, y: number, c: string, outline: string, scale = 1): void {
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]] as const) text(g, s, x + dx, y + dy, outline, scale);
  text(g, s, x, y, c, scale);
}

/** 霓虹字:外发光两圈 + 本体 */
export function neonText(g: Ctx, s: string, x: number, y: number, c: string, scale: number, on = 1): void {
  g.save();
  g.globalAlpha = 0.18 * on;
  for (let r = 2; r >= 1; r--) for (const [dx, dy] of [[-r, 0], [r, 0], [0, -r], [0, r]] as const) text(g, s, x + dx, y + dy, c, scale);
  g.globalAlpha = 1;
  text(g, s, x, y, on > 0.5 ? mix(c, '#ffffff', 0.45) : shade(c, -0.5), scale);
  g.restore();
}

export function makeCanvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  return [c, g];
}
