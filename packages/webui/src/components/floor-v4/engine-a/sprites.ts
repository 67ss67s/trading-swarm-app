/**
 * 精灵:角色(字符串网格 → 放大 + 描边 + 明暗 + 眨眼/呼吸/走路帧)与小道具(植物、杯子热气、宠物、全息地球、信封)。
 * 角色精灵按参数缓存成离屏 canvas;道具是每帧画的小函数(带微动)。
 */
import { SHAPES, type ShapeId } from './roles';
import type { ThemePalette } from './themes';
import { ellipse, hash, makeCanvas, mix, px, rect, rgba, shade, text, type Ctx } from './pixel';

export interface CharOpts {
  cell?: number;
  blink?: boolean;
  breath?: boolean;
  walk?: 0 | 1 | 2;
  look?: -1 | 0 | 1;
  stretch?: boolean;
  back?: boolean;
  outline?: string;
}

const cache = new Map<string, HTMLCanvasElement>();

/** 返回精灵 canvas;绘制时以底边中点对齐:drawImage(s, x - s.width/2, y - s.height) */
export function charSprite(shape: ShapeId, color: string, o: CharOpts = {}): HTMLCanvasElement {
  const c = o.cell ?? 2;
  const key = `${shape}|${color}|${c}|${o.blink ? 1 : 0}${o.breath ? 1 : 0}${o.walk ?? 0}${o.look ?? 0}${o.stretch ? 1 : 0}${o.back ? 1 : 0}|${o.outline ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rows = SHAPES[shape];
  const W = 12 * c;
  const H0 = 12 * c;
  // 0 空,1 身体,2 高光,3 眼白,4 瞳孔
  let m: number[][] = [];
  for (let y = 0; y < H0; y++) {
    const row: number[] = [];
    for (let x = 0; x < W; x++) {
      const ch = rows[Math.floor(y / c)]?.[Math.floor(x / c)] ?? '.';
      row.push(ch === '#' ? 1 : ch === 'h' ? 2 : ch === 'e' ? 3 : 0);
    }
    m.push(row);
  }
  // 眼睛:每个眼块底行靠视线方向的像素 = 瞳孔
  for (let by = 0; by < 12; by++)
    for (let bx = 0; bx < 12; bx++) {
      if (rows[by]?.[bx] !== 'e') continue;
      const x0 = bx * c;
      const y0 = by * c;
      if (o.back) {
        for (let j = 0; j < c; j++) for (let i = 0; i < c; i++) m[y0 + j]![x0 + i] = 1;
        continue;
      }
      if (o.blink) {
        for (let j = 0; j < c; j++) for (let i = 0; i < c; i++) m[y0 + j]![x0 + i] = j === c - 1 ? 4 : 1;
        continue;
      }
      const pw = Math.max(1, Math.floor(c / 2));
      const pxs = o.look === -1 ? 0 : o.look === 1 ? c - pw : c - pw;
      for (let j = c - pw; j < c; j++) for (let i = pxs; i < pxs + pw; i++) m[y0 + j]![x0 + i] = 4;
    }
  // 呼吸:头部下沉 1px
  if (o.breath) {
    const split = 6 * c;
    const nm = m.map((r) => r.slice());
    for (let y = split - 1; y >= 1; y--) nm[y] = m[y - 1]!.slice();
    nm[0] = new Array(W).fill(0);
    m = nm;
  }
  // 走路:两条腿交替抬起 + 身体上下
  if (o.walk) {
    const legTop = 9 * c;
    const nm = m.map((r) => r.slice());
    for (let y = legTop; y < H0; y++)
      for (let x = 0; x < W; x++) {
        const left = x < W / 2;
        if ((o.walk === 1 && left) || (o.walk === 2 && !left)) nm[y]![x] = y + 1 < H0 ? m[y + 1]![x]! : 0;
      }
    m = nm;
  }
  // 伸懒腰:躯干拉长 2px
  let H = H0;
  if (o.stretch) {
    const at = 5 * c;
    const nm: number[][] = [];
    for (let y = 0; y < H0; y++) {
      nm.push(m[y]!.slice());
      if (y === at || y === at + 1) nm.push(m[y]!.slice());
    }
    m = nm;
    H = H0 + 2;
  }
  const [cv, g] = makeCanvas(W + 2, H + 2);
  const at = (x: number, y: number) => (y < 0 || y >= H || x < 0 || x >= W ? 0 : m[y]![x]!);
  const base = color;
  const hi = shade(base, 0.32);
  const hi2 = shade(base, 0.15);
  const dk = shade(base, -0.28);
  const dk2 = shade(base, -0.45);
  const ol = o.outline ?? mix(shade(base, -0.78), '#0a0610', 0.5);
  for (let y = -1; y <= H; y++)
    for (let x = -1; x <= W; x++) {
      const v = at(x, y);
      if (v === 0) {
        if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) px(g, x + 1, y + 1, ol);
        continue;
      }
      let col = base;
      if (v === 3) col = '#f6f4ee';
      else if (v === 4) col = '#15101c';
      else if (v === 2) col = shade(base, 0.55);
      else {
        const up = at(x, y - 1) === 0;
        const dn = at(x, y + 1) === 0;
        const lf = at(x - 1, y) === 0;
        const rt = at(x + 1, y) === 0;
        if (up) col = hi;
        else if (dn) col = dk2;
        else if (lf) col = hi2;
        else if (rt) col = dk;
        else if (y > H * 0.62) col = mix(base, dk, 0.55);
        if (o.back && !up) col = mix(col, dk, 0.35);
      }
      px(g, x + 1, y + 1, col);
    }
  cache.set(key, cv);
  return cv;
}

export function drawChar(g: Ctx, shape: ShapeId, color: string, x: number, y: number, o: CharOpts = {}): { w: number; h: number } {
  const s = charSprite(shape, color, o);
  g.drawImage(s, Math.round(x - s.width / 2), Math.round(y - s.height));
  return { w: s.width, h: s.height };
}

export function shadow(g: Ctx, x: number, y: number, rx: number, alpha = 0.35): void {
  g.save();
  g.globalAlpha = alpha;
  ellipse(g, x, y, rx, Math.max(1, Math.round(rx / 3)), '#000000');
  g.restore();
}

// ---------- 植物 ----------
export function drawPlant(g: Ctx, p: ThemePalette, x: number, y: number, size: number, t: number, seed: number, still = false): void {
  const r = (i: number) => hash(seed * 31 + i);
  const potW = Math.round(6 + size * 3);
  const potH = Math.round(4 + size * 2);
  // 叶子
  const n = 5 + Math.round(size * 3);
  const sway = still ? 0 : Math.sin(t * 1.3 + seed) * 1.2;
  for (let k = 0; k < n; k++) {
    const dir = (k / (n - 1)) * 2 - 1 + (r(k) - 0.5) * 0.3;
    const len = Math.round((8 + size * 7) * (0.7 + r(k + 50) * 0.5) * (1 - Math.abs(dir) * 0.25));
    const col = k % 3 === 0 ? p.plantDark : k % 3 === 1 ? p.plant : p.plantHi;
    for (let i = 0; i < len; i++) {
      const f = i / len;
      const lx = x + dir * i * 0.85 + sway * f * f;
      const ly = y - potH - i * (1.05 - Math.abs(dir) * 0.45) + f * f * Math.abs(dir) * len * 0.55;
      px(g, lx, ly, col);
      if (f < 0.75) px(g, lx + (dir < 0 ? -1 : 1), ly, mix(col, p.plantDark, 0.3));
      if (f > 0.3 && f < 0.8) px(g, lx, ly - 1, p.plantHi);
    }
  }
  // 盆
  rect(g, x - potW / 2 - 1, y - potH - 1, potW + 2, potH + 1, p.outline);
  rect(g, x - potW / 2, y - potH, potW, potH, p.pot);
  rect(g, x - potW / 2, y - potH, potW, 1, shade(p.pot, 0.25));
  rect(g, x - potW / 2 + potW - 2, y - potH + 1, 2, potH - 1, p.potDark);
  rect(g, x - potW / 2 - 1, y - potH - 2, potW + 2, 2, shade(p.pot, 0.1));
}

// ---------- 杯子 + 热气 ----------
export function drawMug(g: Ctx, x: number, y: number, color: string, t: number, steam: boolean, outline: string): void {
  rect(g, x - 1, y - 6, 6, 7, outline);
  rect(g, x, y - 5, 4, 5, color);
  rect(g, x, y - 5, 4, 1, shade(color, 0.35));
  rect(g, x + 3, y - 4, 1, 4, shade(color, -0.3));
  rect(g, x + 4, y - 4, 2, 1, color);
  rect(g, x + 5, y - 4, 1, 3, color);
  rect(g, x + 4, y - 2, 2, 1, color);
  rect(g, x + 1, y - 5, 2, 1, '#3a2014');
  if (!steam) return;
  for (let k = 0; k < 3; k++) {
    const ph = (t * 0.55 + k / 3) % 1;
    const sx = x + 1.5 + Math.sin(ph * 7 + k * 2) * 1.3;
    const sy = y - 7 - ph * 9;
    g.fillStyle = `rgba(255,255,255,${(0.55 * (1 - ph)).toFixed(3)})`;
    g.fillRect(Math.round(sx), Math.round(sy), 1, 2);
  }
}

// ---------- 宠物(打盹) ----------
export function drawPet(g: Ctx, kind: 'cat' | 'corgi', body: string, dark: string, belly: string, x: number, y: number, t: number, outline: string, still = false): void {
  const br = still ? 0 : Math.sin(t * 2.2) > 0 ? 1 : 0;
  // 身体(蜷成一团)
  ellipse(g, x, y - 4, 10, 5 + (br ? 0 : 0), outline);
  ellipse(g, x, y - 4, 9, 4, body);
  ellipse(g, x - 1, y - 6 - br * 0.5, 7, 2, shade(body, 0.18));
  ellipse(g, x + 1, y - 2, 7, 1, dark);
  if (kind === 'cat') {
    // 条纹
    for (let i = -5; i <= 5; i += 3) rect(g, x + i, y - 8 + br, 1, 3, dark);
  } else {
    ellipse(g, x + 2, y - 2, 5, 1, belly);
  }
  // 头
  const hx = x - 9;
  const hy = y - 5;
  ellipse(g, hx, hy, 5, 4, outline);
  ellipse(g, hx, hy, 4, 3, body);
  if (kind === 'corgi') ellipse(g, hx - 1, hy + 1, 3, 2, belly);
  // 耳朵
  const earH = kind === 'corgi' ? 4 : 3;
  rect(g, hx - 4, hy - 3 - earH + 1, 2, earH, outline);
  rect(g, hx + 2, hy - 3 - earH + 1, 2, earH, outline);
  rect(g, hx - 3, hy - 3 - earH + 2, 1, earH - 1, body);
  rect(g, hx + 2, hy - 3 - earH + 2, 1, earH - 1, body);
  // 闭眼
  rect(g, hx - 3, hy, 2, 1, outline);
  rect(g, hx + 1, hy, 2, 1, outline);
  px(g, hx - 1, hy + 2, '#e27a8a');
  // 尾巴(偶尔摆一下)
  const flick = still ? 0 : Math.sin(t * 0.9) > 0.85 ? 1 : 0;
  const tx = x + 9;
  if (kind === 'cat') {
    rect(g, tx, y - 3 - flick * 2, 2, 3 + flick * 2, outline);
    rect(g, tx - 2, y - 1, 3, 1, body);
    rect(g, tx, y - 2 - flick * 2, 1, 2 + flick, body);
  } else {
    rect(g, tx - 1, y - 6 - flick, 3, 3, body);
    px(g, tx, y - 6 - flick, belly);
  }
  // zzz
  if (!still) {
    const ph = (t * 0.35) % 1;
    g.save();
    g.globalAlpha = 1 - ph;
    text(g, 'Z', hx + 2 + ph * 6, hy - 10 - ph * 10, '#dfe8ff');
    if (ph > 0.4) text(g, 'z', hx + 6 + ph * 5, hy - 16 - ph * 6, '#dfe8ff');
    g.restore();
  }
}

// ---------- 全息地球 ----------
export const WORLD = [
  '....................................',
  '......#####....#.##################.',
  '..##########..##.###################',
  '..#########.....####################',
  '...#######......####################',
  '....#####......####.###############.',
  '.....###.......#######.#########....',
  '......##.......########...######....',
  '.......##......#######.....##.##....',
  '........####....#####.......#..##...',
  '........#####...#####..........##...',
  '........####.....###.........#####..',
  '.........###.....##..........####...',
  '.........##.........................',
  '..........#.........................',
  '....................................',
  '....######################..........',
  '####################################',
];

export function drawGlobe(g: Ctx, cx: number, cy: number, r: number, land: string, sea: string, t: number, still = false): void {
  const rot = still ? 0.6 : t * 0.35;
  for (let j = -r; j <= r; j++)
    for (let i = -r; i <= r; i++) {
      const d2 = i * i + j * j;
      if (d2 > r * r) continue;
      const lat = Math.asin(Math.max(-1, Math.min(1, j / r)));
      const cl = Math.cos(lat) * r;
      const lon = Math.asin(Math.max(-1, Math.min(1, cl > 0.01 ? i / cl : 0))) + rot;
      let col = Math.floor(((((lon / Math.PI) * 180 + 180) % 360) + 360) % 360 / 10);
      col = Math.max(0, Math.min(35, col));
      const row = Math.max(0, Math.min(17, Math.floor(((lat / Math.PI) * 180 + 90) / 10)));
      const isLand = WORLD[row]?.[col] === '#';
      const edge = d2 > (r - 1.2) * (r - 1.2);
      const X = cx + i;
      const Y = cy + j;
      if (edge) px(g, X, Y, land);
      else if (isLand) px(g, X, Y, (i + j) % 3 === 0 ? mix(land, '#ffffff', 0.35) : land);
      else if (((i + j) & 1) === 0) px(g, X, Y, sea);
    }
  // 经纬线
  g.save();
  g.globalAlpha = 0.5;
  for (let k = 0; k < 3; k++) {
    const ph = ((rot * 0.6 + k / 3) % 1) * Math.PI;
    const rx = Math.abs(Math.cos(ph)) * r;
    for (let j = -r + 1; j < r; j += 1) {
      const w = rx * Math.sqrt(1 - (j * j) / (r * r));
      px(g, cx + w * (Math.sin(ph) > 0 ? 1 : -1), cy + j, land);
    }
  }
  g.restore();
}

// ---------- 信封 ----------
export function drawEnvelope(g: Ctx, x: number, y: number, color: string, outline: string, glow: number): void {
  if (glow > 0) {
    g.save();
    g.globalAlpha = 0.35 * glow;
    ellipse(g, x, y, 7, 5, color);
    g.globalAlpha = 0.2 * glow;
    ellipse(g, x, y, 10, 7, color);
    g.restore();
  }
  const X = Math.round(x - 4);
  const Y = Math.round(y - 3);
  rect(g, X - 1, Y - 1, 10, 8, outline);
  rect(g, X, Y, 8, 6, '#fff6e0');
  rect(g, X, Y + 5, 8, 1, '#e0cfa8');
  px(g, X, Y, color);
  px(g, X + 1, Y + 1, color);
  px(g, X + 2, Y + 2, color);
  px(g, X + 3, Y + 3, color);
  px(g, X + 4, Y + 3, color);
  px(g, X + 5, Y + 2, color);
  px(g, X + 6, Y + 1, color);
  px(g, X + 7, Y, color);
}

export function glowDot(g: Ctx, x: number, y: number, color: string, a: number): void {
  g.fillStyle = rgba(color, a);
  g.fillRect(Math.round(x), Math.round(y), 1, 1);
}
