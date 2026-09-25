/**
 * 像素美术原语:颜色工具、3×5 像素字、角色精灵(字符串网格 + 描边 + 明暗,离屏缓存)、宠物精灵、绘图小函数。
 * 全程序化,不用任何外部图片。
 */
import { SHAPES, type SpriteShape } from './roles';

export type Ctx = CanvasRenderingContext2D;

// ---------- 颜色 ----------
const shadeCache = new Map<string, string>();
function hexToRgb(h: string): [number, number, number] {
  let s = h.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
/** amt>0 提亮、<0 压暗(-1..1) */
export function shade(hex: string, amt: number): string {
  const k = hex + amt;
  const hit = shadeCache.get(k);
  if (hit) return hit;
  const [r, g, b] = hexToRgb(hex);
  const out = amt >= 0 ? rgbToHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt) : rgbToHex(r * (1 + amt), g * (1 + amt), b * (1 + amt));
  shadeCache.set(k, out);
  return out;
}
export function mix(a: string, b: string, t: number): string {
  const k = `${a}|${b}|${t}`;
  const hit = shadeCache.get(k);
  if (hit) return hit;
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const out = rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
  shadeCache.set(k, out);
  return out;
}
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// ---------- 绘图原语 ----------
export function R(ctx: Ctx, x: number, y: number, w: number, h: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
export function P(ctx: Ctx, x: number, y: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
}
/** Bresenham 像素线 */
export function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, c: string): void {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  ctx.fillStyle = c;
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let i = 0; i < 600; i++) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
/** 实心像素圆 */
export function disc(ctx: Ctx, cx: number, cy: number, r: number, c: string): void {
  ctx.fillStyle = c;
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r - y * y + r * 0.8));
    ctx.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
  }
}
/** 像素圆环 */
export function ring(ctx: Ctx, cx: number, cy: number, r: number, c: string): void {
  ctx.fillStyle = c;
  const n = Math.max(16, Math.round(r * 7));
  let lx = NaN, ly = NaN;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r);
    if (x !== lx || y !== ly) ctx.fillRect(x, y, 1, 1);
    lx = x; ly = y;
  }
}
/** 阶梯半透明光池(3 档,保持像素感) */
export function lightCone(ctx: Ctx, x: number, top: number, bottom: number, wTop: number, wBottom: number, c: string, a = 0.16): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const h = bottom - top;
  for (let band = 0; band < 3; band++) {
    ctx.fillStyle = rgba(c, a * (0.55 + band * 0.25));
    const shrink = band * 0.22;
    for (let y = 0; y < h; y += 1) {
      const t = y / h;
      const w = (wTop + (wBottom - wTop) * t) * (1 - shrink);
      ctx.fillRect(Math.round(x - w / 2), Math.round(top + y), Math.round(w), 1);
    }
  }
  ctx.restore();
}
/** 圆形光晕(阶梯) */
export function glow(ctx: Ctx, cx: number, cy: number, r: number, c: string, a = 0.22): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 3; i >= 1; i--) {
    ctx.fillStyle = rgba(c, a * (1 - i * 0.22));
    const rr = Math.round((r * i) / 3);
    for (let y = -rr; y <= rr; y++) {
      const w = Math.floor(Math.sqrt(rr * rr - y * y));
      ctx.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
    }
  }
  ctx.restore();
}

// ---------- 3×5 像素字 ----------
const GLYPHS: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001110',
  '+': '000010111010000', '-': '000000111000000', '.': '000000000000010', '%': '101001010100101', ':': '000010000010000', '/': '001001010100100',
  '$': '011110010011110', '!': '010010010000010', '?': '110001010000010', '>': '100010001010100', '<': '001010100010001', ' ': '000000000000000',
  '@': '010101111100011', '#': '101111101111101', '*': '000101010101000', '=': '000111000111000', "'": '010010000000000', ',': '000000000010100',
};
export function textW(s: string): number {
  return s.length * 4 - 1;
}
export function text(ctx: Ctx, s: string, x: number, y: number, c: string): void {
  ctx.fillStyle = c;
  const up = s.toUpperCase();
  let cx = Math.round(x);
  const cy = Math.round(y);
  for (const ch of up) {
    const g = GLYPHS[ch] ?? GLYPHS['?']!;
    for (let i = 0; i < 15; i++) if (g[i] === '1') ctx.fillRect(cx + (i % 3), cy + Math.floor(i / 3), 1, 1);
    cx += 4;
  }
}

// ---------- 角色精灵 ----------
export type Pose = 'stand' | 'walk1' | 'walk2' | 'stretch' | 'catch' | 'sit' | 'talk' | 'cup';

export interface SpriteOpts {
  pose: Pose;
  blink: boolean;
  look: -1 | 0 | 1;
  breath: 0 | 1;
}

const spriteCache = new Map<string, HTMLCanvasElement>();
const PAD = 3;
export const SPRITE_SIZE = 12 + PAD * 2;

function buildGrid(shape: SpriteShape, o: SpriteOpts): string[][] {
  const rows = SHAPES[shape];
  const W = 12 + PAD * 2;
  const g: string[][] = Array.from({ length: W }, () => Array.from({ length: W }, () => '.'));
  const breathCut = 6;
  for (let y = 0; y < 12; y++) {
    const src = rows[y] ?? '';
    let rowSrc = src;
    // 走路:脚两行互换 → 迈步
    if ((o.pose === 'walk1' || o.pose === 'walk2') && y >= 10) {
      const alt = o.pose === 'walk1' ? (y === 10 ? rows[11] : rows[10]) : src;
      rowSrc = alt ?? src;
    }
    for (let x = 0; x < 12; x++) {
      const ch = rowSrc[x] ?? '.';
      if (ch === '.') continue;
      const dy = o.breath && y < breathCut ? 1 : 0;
      const gy = y + PAD + dy;
      if (gy < W) g[gy]![x + PAD] = ch;
    }
  }
  // 手臂:伸懒腰 / 接信封 / 说话 / 端杯子
  if (o.pose === 'stretch' || o.pose === 'catch' || o.pose === 'talk' || o.pose === 'cup') {
    const ay = 6 + PAD;
    const row = g[ay]!;
    let L = row.findIndex((c) => c !== '.');
    let Rr = row.length - 1 - [...row].reverse().findIndex((c) => c !== '.');
    if (L < 0) { L = PAD + 2; Rr = PAD + 9; }
    const put = (x: number, y: number) => { if (x >= 0 && x < W && y >= 0 && y < W && g[y]![x] === '.') g[y]![x] = 'a'; };
    if (o.pose === 'stretch') {
      for (let k = 0; k < 5; k++) { put(L - 1, ay - k); put(Rr + 1, ay - k); }
    } else if (o.pose === 'catch') {
      put(L - 1, ay); put(L - 2, ay - 1); put(L - 2, ay - 2);
      put(Rr + 1, ay); put(Rr + 2, ay - 1); put(Rr + 2, ay - 2);
    } else if (o.pose === 'talk') {
      put(Rr + 1, ay); put(Rr + 2, ay - 1);
    } else {
      put(Rr + 1, ay); put(Rr + 2, ay); put(Rr + 2, ay - 1); put(Rr + 3, ay - 1); put(Rr + 3, ay); put(Rr + 2, ay + 1); put(Rr + 3, ay + 1);
      if (g[ay - 1]) { g[ay - 1]![Rr + 2] = 'c'; g[ay - 1]![Rr + 3] = 'c'; }
      g[ay]![Rr + 2] = 'c'; g[ay]![Rr + 3] = 'c'; if (g[ay + 1]) { g[ay + 1]![Rr + 2] = 'c'; g[ay + 1]![Rr + 3] = 'c'; }
    }
  }
  return g;
}

export function agentSprite(shape: SpriteShape, color: string, outline: string, o: SpriteOpts): HTMLCanvasElement {
  const key = `${shape}|${color}|${outline}|${o.pose}|${o.blink ? 1 : 0}|${o.look}|${o.breath}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;
  const W = SPRITE_SIZE;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = W;
  const c = cv.getContext('2d')!;
  const g = buildGrid(shape, o);
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < W && g[y]![x] !== '.';
  const lite = shade(color, 0.28);
  const dark = shade(color, -0.3);
  const deep = shade(color, -0.5);
  const eye = '#0d0b12';
  // 描边
  c.fillStyle = outline;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    if (filled(x, y)) continue;
    if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) c.fillRect(x, y, 1, 1);
  }
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const ch = g[y]![x]!;
    if (ch === '.') continue;
    if (ch === 'c') { c.fillStyle = '#f2efe6'; c.fillRect(x, y, 1, 1); continue; }
    let col = color;
    if (!filled(x, y - 1) || !filled(x - 1, y)) col = lite;
    if (!filled(x, y + 1)) col = dark;
    if (!filled(x + 1, y) && filled(x, y - 1)) col = dark;
    if (y >= 9 + PAD) col = !filled(x, y + 1) ? deep : dark;
    if (ch === 'h') col = shade(color, 0.6);
    if (ch === 'a') col = shade(color, 0.1);
    if (ch === 'e') col = o.blink ? dark : o.look !== 0 ? color : eye;
    c.fillStyle = col;
    c.fillRect(x, y, 1, 1);
  }
  // 眼睛看向某侧:把瞳孔挪 1px
  if (!o.blink && o.look !== 0) {
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      if (g[y]![x] !== 'e') continue;
      const nx = x + o.look;
      if (filled(nx, y)) { c.fillStyle = eye; c.fillRect(nx, y, 1, 1); }
      else { c.fillStyle = eye; c.fillRect(x, y, 1, 1); }
    }
  }
  spriteCache.set(key, cv);
  return cv;
}

/**
 * 场景里的角色按 1.5 倍画:先对 12px 精灵做 Scale2x(EPX)平滑放大到 2 倍,再最近邻缩到 1.5 倍。
 * 比直接 1.5 倍最近邻(2-1-2-1 的锯齿像素)干净,又不像 2 倍那样压过家具。
 */
export const AGENT_SCALE = 1.5;
/** 角色在场景里的显示高度(逻辑像素) */
export const AH = Math.round(12 * AGENT_SCALE);
const bigCache = new Map<string, HTMLCanvasElement>();
function epx(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const sd = src.getContext('2d')!.getImageData(0, 0, w, h).data;
  const px = new Uint32Array(sd.buffer.slice(0));
  const out = document.createElement('canvas');
  out.width = w * 2;
  out.height = h * 2;
  const oc = out.getContext('2d')!;
  const od = oc.createImageData(w * 2, h * 2);
  const o32 = new Uint32Array(od.data.buffer);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : px[y * w + x]!);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const P0 = at(x, y), A = at(x, y - 1), B = at(x + 1, y), C = at(x - 1, y), D = at(x, y + 1);
    let p1 = P0, p2 = P0, p3 = P0, p4 = P0;
    if (C === A && C !== D && A !== B) p1 = A;
    if (A === B && A !== C && B !== D) p2 = B;
    if (D === C && D !== B && C !== A) p3 = C;
    if (B === D && B !== A && D !== C) p4 = D;
    const W2 = w * 2;
    o32[y * 2 * W2 + x * 2] = p1;
    o32[y * 2 * W2 + x * 2 + 1] = p2;
    o32[(y * 2 + 1) * W2 + x * 2] = p3;
    o32[(y * 2 + 1) * W2 + x * 2 + 1] = p4;
  }
  oc.putImageData(od, 0, 0);
  return out;
}
export function agentSpriteBig(shape: SpriteShape, color: string, outline: string, o: SpriteOpts): HTMLCanvasElement {
  const key = `${shape}|${color}|${outline}|${o.pose}|${o.blink ? 1 : 0}|${o.look}|${o.breath}`;
  const hit = bigCache.get(key);
  if (hit) return hit;
  const x2 = epx(agentSprite(shape, color, outline, o));
  const n = Math.round(SPRITE_SIZE * AGENT_SCALE);
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const c = cv.getContext('2d')!;
  c.imageSmoothingEnabled = false;
  c.drawImage(x2, 0, 0, n, n);
  bigCache.set(key, cv);
  return cv;
}

/** 以脚底中心 (x, feetY) 画角色;small = 原始 12px(电梯轿厢里) */
export function drawAgent(ctx: Ctx, shape: SpriteShape, color: string, outline: string, x: number, feetY: number, o: SpriteOpts, bob = 0, small = false): void {
  if (small) {
    const cv = agentSprite(shape, color, outline, o);
    ctx.drawImage(cv, Math.round(x - SPRITE_SIZE / 2), Math.round(feetY - (PAD + 12) - bob));
    return;
  }
  const cv = agentSpriteBig(shape, color, outline, o);
  ctx.drawImage(cv, Math.round(x - cv.width / 2), Math.round(feetY - Math.floor((PAD + 12) * AGENT_SCALE) - bob));
}

// ---------- 宠物 ----------
const PETS: Record<'cat' | 'robodog' | 'shiba', { rows: string[]; pal: Record<string, string> }> = {
  cat: {
    rows: ['..............', '.o..o.........', '.oooo.........', '.oeoo.oooo....', '.ooooooooooo..', '..oowwoooooooo', '...oooooooo.oo'],
    pal: { o: '#e08a3c', w: '#f6e3c8', e: '#3a2410' },
  },
  robodog: {
    rows: ['..............', '..a...........', '.ggg..........', '.gegg.ggggg...', '.gggggggggggg.', '..gggbgggggg..', '...g.g..g.g...'],
    pal: { g: '#9fb3c8', b: '#39e0ff', e: '#39e0ff', a: '#ff5d5d' },
  },
  shiba: {
    rows: ['..............', '.o..o.........', '.oooo.........', '.oeoo.oooo....', '.woooooooooo..', '..wwwoooooooo.', '...wwwwooo.oo.'],
    pal: { o: '#e6a04a', w: '#fbe6c6', e: '#2a1a0a' },
  },
};
export function drawPet(ctx: Ctx, kind: 'cat' | 'robodog' | 'shiba', x: number, feetY: number, breath: boolean, outline: string): void {
  const p = PETS[kind];
  const h = p.rows.length;
  const w = p.rows[0]!.length;
  const oy = feetY - h;
  const at = (xx: number, yy: number) => (p.rows[yy]?.[xx] ?? '.') !== '.';
  ctx.fillStyle = outline;
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    if (at(xx, y)) continue;
    if (at(xx - 1, y) || at(xx + 1, y) || at(xx, y - 1) || at(xx, y + 1)) ctx.fillRect(x + xx, oy + y, 1, 1);
  }
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    const ch = p.rows[y]![xx]!;
    if (ch === '.') continue;
    let col = p.pal[ch] ?? '#fff';
    if (ch === 'e') col = shade(p.pal.o ?? p.pal.g ?? '#888', -0.45); // 睡着:眼睛是一条缝
    if (!at(xx, y + 1)) col = shade(col, -0.25);
    ctx.fillStyle = col;
    // 呼吸:背部那一行偶尔抬 1px
    const dy = breath && y === 3 && xx > 5 ? -1 : 0;
    ctx.fillRect(x + xx, oy + y + dy, 1, 1);
  }
}
