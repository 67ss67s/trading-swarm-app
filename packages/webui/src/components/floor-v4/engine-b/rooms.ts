/**
 * 每个 agent 的小房间 —— 后景(墙 + 墙上道具)。前景(桌子 / 显示器 / 柜台)在 rooms-front.ts。
 * RADAR 天文台雷达屏、THREAD 线索板红线、LAB 冒泡烧杯、BOOK 账本墙、SENTINEL 金库门 + 潜望镜、
 * EXEC 跑马灯、MARKET 信号货架、AUDIT 图书馆、HELM 作战大屏。
 */
import type { RoomGeo, Layout } from './layout';
import type { Theme } from './themes';
import type { Role } from './types';
import { ROLES } from './roles';
import { DECO } from '../deco';
import { hash, noise, q, bookshelf, plant, ceilingLight, nameplate, mug } from './props';
import { R, P, line, disc, ring, glow, text, textW, shade, rgba, type Ctx } from './sprites';

export interface RoomCtx { th: Theme; t: number; status: string; reduced: boolean; L: Layout; rain?: boolean }

export function roomWall(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const { th } = c;
  const w = th.wall;
  R(ctx, r.x, r.y, r.w, r.h, w.a);
  if (w.pattern === 'wood') {
    for (let x = r.x; x < r.x + r.w; x += 6) {
      R(ctx, x, r.y, 3, r.h, w.b);
      P(ctx, x + 1, r.y + 4 + Math.floor(hash(x) * (r.h - 10)), w.dark);
    }
    for (let x = r.x + 5; x < r.x + r.w; x += 6) R(ctx, x, r.y, 1, r.h, w.dark);
  } else if (w.pattern === 'grid') {
    for (let x = r.x + 3; x < r.x + r.w; x += 10) R(ctx, x, r.y, 1, r.h, w.b);
    for (let y = r.y + 5; y < r.y + r.h; y += 10) R(ctx, r.x, y, r.w, 1, w.b);
    for (let x = r.x + 3; x < r.x + r.w; x += 10) for (let y = r.y + 5; y < r.y + r.h; y += 10) P(ctx, x, y, shade(w.b, 0.3));
  } else {
    for (let x = r.x; x < r.x + r.w; x += 8) R(ctx, x, r.y, 4, r.h, w.b);
  }
  // 护墙板 + 踢脚线
  const wy = r.y + r.h - 9;
  R(ctx, r.x, wy, r.w, 9, w.dark);
  R(ctx, r.x, wy, r.w, 1, shade(w.dark, 0.25));
  for (let x = r.x + 4; x < r.x + r.w; x += 12) R(ctx, x, wy + 2, 8, 5, shade(w.dark, 0.08));
  R(ctx, r.x, r.y + r.h - 1, r.w, 1, th.floorBoard);
  // 顶部阴影
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(r.x, r.y, r.w, 2);
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.fillRect(r.x, r.y + 2, r.w, 2);
  // 角色色霓虹条(指挥中心 / Meme)或挂画线
  const col = ROLES[r.role].color;
  if (th.lampStyle !== 'lamp') R(ctx, r.x + 2, r.y + 4, r.w - 4, 1, rgba(col, 0.55));
}

export function roomCeiling(ctx: Ctx, r: RoomGeo, c: RoomCtx): number[] {
  const xs = lightXs(r);
  for (const x of xs) ceilingLight(ctx, x, r.y, c.th, ROLES[r.role].color);
  return xs;
}

export function roomPlate(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  nameplate(ctx, r.x + 4, r.y + 7, ROLES[r.role].callsign, ROLES[r.role].color, c.status, c.t, c.th);
}

/** 吊灯位置:避开右上角的进化灯板 */
export function lightXs(r: RoomGeo): number[] {
  return r.w > 150 ? [r.x + Math.round(r.w * 0.22), r.x + Math.round(r.w * 0.47)] : [r.x + Math.round(r.w * 0.3)];
}

// ---------- 各房间后景 ----------
export function roomBack(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  roomWall(ctx, r, c);
  switch (r.role) {
    case 'radar': radarBack(ctx, r, c); break;
    case 'thread_manager': threadBack(ctx, r, c); break;
    case 'strategy_lab': labBack(ctx, r, c); break;
    case 'portfolio_manager': bookBack(ctx, r, c); break;
    case 'risk_sentinel': sentinelBack(ctx, r, c); break;
    case 'executor': execBack(ctx, r, c); break;
    case 'asp_agent': marketBack(ctx, r, c); break;
    case 'reviewer': auditBack(ctx, r, c); break;
    case 'gate_captain': helmBack(ctx, r, c); break;
  }
  roomCeiling(ctx, r, c);
  roomPlate(ctx, r, c);
}

function frame(ctx: Ctx, x: number, y: number, w: number, h: number, c: RoomCtx, fill: string): void {
  R(ctx, x - 2, y - 2, w + 4, h + 4, c.th.outline);
  R(ctx, x - 1, y - 1, w + 2, h + 2, c.th.metal.b);
  R(ctx, x - 1, y - 1, w + 2, 1, c.th.metal.a);
  R(ctx, x, y, w, h, fill);
}

function radarBack(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const { th, t } = c;
  // 星图
  const sx = r.x + r.w - 58, sy = r.y + 12, sw = 30, sh = r.h - 25;
  frame(ctx, sx, sy, sw, sh, c, '#0b1330');
  const stars: [number, number][] = [[4, 4], [11, 7], [17, 3], [24, 9], [8, 13], [20, 15], [14, 19], [26, 20]];
  for (let i = 0; i + 1 < stars.length; i += 2) line(ctx, sx + stars[i]![0], sy + stars[i]![1], sx + stars[i + 1]![0], sy + stars[i + 1]![1], rgba('#9fb8ff', 0.4));
  line(ctx, sx + 11, sy + 7, sx + 8, sy + 13, rgba('#9fb8ff', 0.4));
  stars.forEach(([x, y], i) => { if (y < sh) P(ctx, sx + x, sy + y, Math.sin(t * 2 + i) > 0 ? '#fff6d0' : '#9fb8ff'); });
  // 大雷达屏
  const cx = r.x + 26, cy = r.y + Math.round(r.h * 0.46), rr = Math.max(9, Math.min(14, Math.floor(r.h * 0.3)));
  disc(ctx, cx, cy, rr + 2, th.outline);
  disc(ctx, cx, cy, rr + 1, th.metal.b);
  disc(ctx, cx, cy, rr, '#06200f');
  ring(ctx, cx, cy, rr * 0.66, '#12502a');
  ring(ctx, cx, cy, rr * 0.33, '#12502a');
  R(ctx, cx - rr, cy, rr * 2, 1, '#0f4222');
  R(ctx, cx, cy - rr, 1, rr * 2, '#0f4222');
  const a = c.reduced ? 0.8 : t * 1.8;
  for (let k = 0; k < 7; k++) {
    const aa = a - k * 0.09;
    line(ctx, cx, cy, cx + Math.cos(aa) * (rr - 1), cy + Math.sin(aa) * (rr - 1), k === 0 ? '#b8ffb0' : rgba('#5dff8f', 0.55 - k * 0.07));
  }
  const blips: [number, number][] = [[0.5, -0.4], [-0.35, 0.3], [0.2, 0.6], [-0.6, -0.5]];
  blips.forEach(([bx, by], i) => {
    const ang = Math.atan2(by, bx);
    const diff = (((a - ang) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const bright = diff < 1.4 ? 1 - diff / 1.4 : 0;
    if (bright > 0.05 || i === 0) P(ctx, cx + Math.round(bx * rr), cy + Math.round(by * rr), bright > 0.5 ? '#eaffd0' : rgba('#5dff8f', 0.3 + bright));
  });
  glow(ctx, cx, cy, rr + 3, '#5dff8f', 0.08);
  // 天窗
  R(ctx, r.x + 50, r.y, 18, 3, '#0c0f1a');
  P(ctx, r.x + 54, r.y + 1, th.stars);
}

function threadBack(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const { th, t } = c;
  const bx = r.x + 8, by = r.y + 9, bw = Math.min(62, Math.round(r.w * 0.36)), bh = r.h - 21;
  const board = th.id === 'study' ? '#a87a46' : th.id === 'command' ? '#12243d' : '#3a1a5a';
  frame(ctx, bx, by, bw, bh, c, board);
  for (let i = 0; i < 40; i++) P(ctx, bx + Math.floor(hash(i * 3) * bw), by + Math.floor(hash(i * 5) * bh), shade(board, -0.18));
  const notes: [number, number, string][] = [
    [0.08, 0.12, '#ffe27a'], [0.42, 0.08, '#ff9ac2'], [0.76, 0.18, '#9fe8ff'], [0.22, 0.58, '#f2efe6'], [0.58, 0.55, '#ffe27a'], [0.85, 0.62, '#b8ff9a'],
  ];
  const pts = notes.map(([nx, ny]) => [bx + Math.round(nx * (bw - 8)), by + Math.round(ny * (bh - 7))] as [number, number]);
  const links: [number, number][] = [[0, 1], [1, 2], [0, 3], [3, 4], [1, 4], [4, 5], [2, 5]];
  for (const [a, b] of links) line(ctx, pts[a]![0] + 3, pts[a]![1] + 1, pts[b]![0] + 3, pts[b]![1] + 1, '#d8283a');
  // 红线上的脉冲
  if (!c.reduced) {
    const li = Math.floor(t * 0.8) % links.length;
    const [a, b] = links[li]!;
    const ph = (t * 0.8) % 1;
    const px = pts[a]![0] + 3 + (pts[b]![0] - pts[a]![0]) * ph;
    const py = pts[a]![1] + 1 + (pts[b]![1] - pts[a]![1]) * ph;
    P(ctx, px, py, '#ffe0e0');
    glow(ctx, px, py, 3, '#ff4050', 0.4);
  }
  notes.forEach(([, , col], i) => {
    const [x, y] = pts[i]!;
    R(ctx, x, y, 7, 6, col);
    R(ctx, x, y + 5, 7, 1, shade(col, -0.25));
    R(ctx, x + 1, y + 2, 4, 1, shade(col, -0.45));
    R(ctx, x + 1, y + 4, 3, 1, shade(col, -0.45));
    P(ctx, x + 3, y, '#e8283a');
  });
  // 地图 / 照片
  const gx = bx + bw + 8;
  if (gx + 20 < r.seatX - 12) {
    frame(ctx, gx, r.y + 10, 14, 11, c, '#e8e2d4');
    R(ctx, gx + 3, r.y + 12, 8, 6, '#6a86a8');
    disc(ctx, gx + 7, r.y + 14, 2, '#f2d0a0');
  }
}

function labBack(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const { th, t } = c;
  const fy = r.y + r.h;
  // 墙上药品架
  const sx = r.x + 8, sy = r.y + 9;
  R(ctx, sx, sy + 7, 44, 2, th.desk.top);
  R(ctx, sx, sy + 9, 44, 1, th.outline);
  const jars = ['#9be15d', '#c98bff', '#ffd166', '#5ec8ff', '#ff7a5c', '#c98bff'];
  jars.forEach((jc, i) => {
    const x = sx + 2 + i * 7;
    R(ctx, x - 1, sy, 6, 7, th.outline);
    R(ctx, x, sy + 1, 4, 6, rgba('#dff6ff', 0.35));
    R(ctx, x, sy + 3 + (i % 2), 4, 4 - (i % 2), jc);
    R(ctx, x, sy, 4, 1, th.metal.a);
  });
  // 实验台 + 烧杯
  const bx = r.x + 6, bw = 48, top = fy - 10;
  R(ctx, bx - 1, top - 1, bw + 2, 11, th.outline);
  R(ctx, bx, top, bw, 2, th.metal.a);
  R(ctx, bx, top + 2, bw, 8, th.metal.b);
  for (let x = bx + 4; x < bx + bw; x += 12) R(ctx, x, top + 4, 8, 4, th.metal.dark);
  const liquid = ROLES.strategy_lab.color;
  // 锥形瓶
  const ex = bx + 8;
  for (let yy = 0; yy < 9; yy++) {
    const hw = yy < 3 ? 1 : Math.min(4, 1 + Math.floor((yy - 2) * 0.7));
    R(ctx, ex - hw - 1, top - 9 + yy, hw * 2 + 3, 1, th.outline);
  }
  for (let yy = 0; yy < 9; yy++) {
    const hw = yy < 3 ? 1 : Math.min(4, 1 + Math.floor((yy - 2) * 0.7));
    R(ctx, ex - hw, top - 9 + yy, hw * 2 + 1, 1, yy >= 4 ? liquid : rgba('#dff6ff', 0.4));
  }
  // 圆底烧瓶 + 酒精灯
  const rx = bx + 24;
  disc(ctx, rx, top - 8, 4, th.outline);
  disc(ctx, rx, top - 8, 3, '#7dffb0');
  R(ctx, rx - 1, top - 15, 3, 5, rgba('#dff6ff', 0.5));
  R(ctx, rx - 2, top - 4, 5, 4, th.metal.dark);
  const fl = c.reduced ? 0 : Math.floor(t * 10) % 3;
  P(ctx, rx, top - 4 - 1 - (fl === 1 ? 1 : 0), '#ffb03a');
  P(ctx, rx, top - 4, '#ff6a2a');
  // 试管架
  const tx = bx + 36;
  R(ctx, tx - 1, top - 4, 11, 4, th.desk.face);
  ['#ff7a5c', '#ffd166', '#5ec8ff'].forEach((col, i) => {
    R(ctx, tx + i * 3, top - 10, 2, 8, rgba('#dff6ff', 0.4));
    R(ctx, tx + i * 3, top - 6, 2, 4, col);
  });
  // 冒泡
  if (!c.reduced) {
    for (let i = 0; i < 5; i++) {
      const ph = (t * 0.9 + i / 5) % 1;
      const src = i % 2 ? [ex, top - 5] : [rx, top - 11];
      const yy = src[1]! - Math.floor(ph * 12);
      const xx = src[0]! + Math.round(Math.sin(ph * 8 + i) * 1.5);
      ctx.fillStyle = rgba(i % 2 ? liquid : '#7dffb0', 0.9 - ph * 0.8);
      ctx.fillRect(xx, yy, 1, 1);
      if (ph > 0.85) { ctx.fillRect(xx - 1, yy - 1, 1, 1); ctx.fillRect(xx + 1, yy - 1, 1, 1); }
    }
  }
  glow(ctx, ex, top - 4, 6, liquid, 0.14);
  // 白板
  const wx = r.x + r.w - 44;
  if (wx > r.seatX + 22) {
    const wy = r.y + 12;
    frame(ctx, wx, wy, 34, 15, c, '#eceae2');
    line(ctx, wx + 3, wy + 11, wx + 12, wy + 4, '#3a6fd6');
    line(ctx, wx + 12, wy + 4, wx + 18, wy + 8, '#3a6fd6');
    line(ctx, wx + 18, wy + 8, wx + 30, wy + 2, '#d63a4a');
    R(ctx, wx + 3, wy + 2, 6, 1, '#555');
    R(ctx, wx + 20, wy + 12, 10, 1, '#555');
  }
}

function bookBack(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const { th, t } = c;
  // 账本墙:一排排彩色活页夹
  const lx = r.x + 6, ly = r.y + 8, lw = Math.min(54, Math.round(r.w * 0.3)), lh = r.h - 9;
  R(ctx, lx - 1, ly - 1, lw + 2, lh + 1, th.outline);
  R(ctx, lx, ly, lw, lh, th.desk.dark);
  for (let row = 0; row * 9 + 8 <= lh; row++) {
    const yy = ly + row * 9;
    for (let k = 0; k * 4 + 3 <= lw; k++) {
      const col = th.books[(k + row * 2) % th.books.length]!;
      R(ctx, lx + 1 + k * 4, yy + 1, 3, 7, col);
      P(ctx, lx + 2 + k * 4, yy + 3, '#f2efe6');
      P(ctx, lx + 1 + k * 4, yy + 1, shade(col, 0.3));
    }
    R(ctx, lx, yy + 8, lw, 1, th.desk.top);
  }
  // 敞口看板:饼图 + 数字
  const bx = r.x + r.w - 52, by = r.y + 12;
  if (bx > r.seatX + 20) {
    frame(ctx, bx, by, 40, 18, c, th.screen.bg);
    const cx = bx + 9, cy = by + 9, rr = 6;
    const cols = [ROLES.portfolio_manager.color, th.screen.line, '#5ec8ff', '#ff5d8f'];
    for (let yy = -rr; yy <= rr; yy++) for (let xx = -rr; xx <= rr; xx++) {
      if (xx * xx + yy * yy > rr * rr + 1) continue;
      const ang = ((Math.atan2(yy, xx) + Math.PI) / (Math.PI * 2) + (c.reduced ? 0 : t * 0.02)) % 1;
      P(ctx, cx + xx, cy + yy, cols[ang < 0.4 ? 0 : ang < 0.65 ? 1 : ang < 0.85 ? 2 : 3]!);
    }
    text(ctx, DECO.exposurePct ?? '--', bx + 19, by + 3, '#f2efe6');
    R(ctx, bx + 19, by + 10, 16, 2, '#2a2a2a');
    R(ctx, bx + 19, by + 10, 6 + Math.round((Math.sin(t * 0.7) + 1) * 3), 2, ROLES.portfolio_manager.color);
    R(ctx, bx + 19, by + 13, 16, 2, '#2a2a2a');
    R(ctx, bx + 19, by + 13, 10, 2, '#5ec8ff');
  }
}

function sentinelBack(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const { th, t } = c;
  const fy = r.y + r.h;
  // 金库门
  const rr = Math.max(10, Math.min(15, Math.floor((r.h - 8) / 2)));
  const cx = r.x + 10 + rr, cy = fy - rr - 3;
  disc(ctx, cx, cy, rr + 2, th.outline);
  disc(ctx, cx, cy, rr + 1, shade(th.metal.b, -0.2));
  disc(ctx, cx, cy, rr - 1, th.metal.a);
  disc(ctx, cx, cy, rr - 3, shade(th.metal.a, -0.12));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    P(ctx, cx + Math.round(Math.cos(a) * (rr - 1)), cy + Math.round(Math.sin(a) * (rr - 1)), th.metal.dark);
  }
  const spin = c.reduced ? 0 : t * 0.5;
  for (let i = 0; i < 3; i++) {
    const a = spin + (i / 3) * Math.PI * 2;
    line(ctx, cx, cy, cx + Math.cos(a) * (rr - 4), cy + Math.sin(a) * (rr - 4), th.metal.dark);
    P(ctx, cx + Math.round(Math.cos(a) * (rr - 4)), cy + Math.round(Math.sin(a) * (rr - 4)), shade(th.metal.a, 0.3));
  }
  disc(ctx, cx, cy, 2, th.metal.dark);
  P(ctx, cx, cy, ROLES.risk_sentinel.color);
  // 键盘锁
  const kx = cx + rr + 4;
  R(ctx, kx - 1, cy - 5, 7, 10, th.outline);
  R(ctx, kx, cy - 4, 5, 8, th.metal.b);
  const ok = c.status !== 'stuck';
  P(ctx, kx + 2, cy - 3, ok ? (Math.floor(t * 2) % 2 ? '#5dff8f' : '#1f4d2d') : '#ff3b5c');
  for (let i = 0; i < 6; i++) P(ctx, kx + 1 + (i % 3) * 1.5, cy - 1 + Math.floor(i / 3) * 2, th.metal.dark);
  // 潜望镜(瞭望塔)
  const px = r.x + r.w - 16;
  R(ctx, px - 1, r.y, 4, r.h - 16, th.outline);
  R(ctx, px, r.y, 2, r.h - 16, th.metal.b);
  R(ctx, px - 4, r.y + r.h - 17, 8, 4, th.outline);
  R(ctx, px - 3, r.y + r.h - 16, 6, 2, th.metal.a);
  P(ctx, px - 3, r.y + r.h - 15, '#9fd4ff');
  // 旋转警示灯
  const lx = r.x + Math.round(r.w * 0.42);
  R(ctx, lx - 2, r.y + 1, 5, 3, th.outline);
  const col = ok ? '#5dff8f' : '#ff3b5c';
  const on = ok ? Math.sin(t * 2) > 0 : Math.floor(t * 6) % 2 === 0;
  R(ctx, lx - 1, r.y + 2, 3, 2, on ? col : shade(col, -0.6));
  if (on && !c.reduced) glow(ctx, lx, r.y + 3, ok ? 5 : 9, col, ok ? 0.25 : 0.45);
}

function execBack(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const { th, t } = c;
  // LED 跑马灯
  const mx = r.x + 40, my = r.y + 11, mw = r.w - 48;
  R(ctx, mx - 1, my - 1, mw + 2, 9, th.outline);
  R(ctx, mx, my, mw, 7, '#0a0a0a');
  const TONE = { up: '#5dff8f', down: '#ff5d7a', hi: '#ffd166' } as const;
  const items: [string, string][] = DECO.tape.length ? DECO.tape.map((x) => [x.text, TONE[x.tone]] as [string, string]) : [['NO DATA', '#8a8398']];
  const full = items.map(([s]) => s + '   ').join('');
  const totalW = textW(full) + 4;
  const off = c.reduced ? 0 : Math.floor(q(t, 20) * 18) % totalW;
  ctx.save();
  ctx.beginPath();
  ctx.rect(mx, my, mw, 7);
  ctx.clip();
  for (let rep = 0; rep < 3; rep++) {
    let x = mx + 2 - off + rep * totalW;
    for (const [s, col] of items) { text(ctx, s, x, my + 1, col); x += textW(s + '   ') + 1; }
  }
  ctx.restore();
  // 世界钟
  ['NY', 'LDN', 'TKY'].forEach((lab, i) => {
    const cx = r.x + r.w - 64 + i * 22, cy = r.y + 24;
    if (cx - 5 < r.seatX + 30) return;
    disc(ctx, cx, cy, 5, th.outline);
    disc(ctx, cx, cy, 4, '#eceae2');
    const a = t * 0.05 + i * 2;
    line(ctx, cx, cy, cx + Math.cos(a) * 3, cy + Math.sin(a) * 3, '#222');
    line(ctx, cx, cy, cx + Math.cos(a * 12) * 2, cy + Math.sin(a * 12) * 2, '#c33');
    text(ctx, lab, cx - Math.floor(textW(lab) / 2), cy + 7, shade(th.wall.a, 0.6));
  });
}

function marketBack(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const { th, t } = c;
  // 霓虹招牌
  const col = ROLES.asp_agent.color;
  const s = 'SIGNALS';
  const flick = !c.reduced && hash(Math.floor(t * 5) + 3) > 0.9;
  const sx = r.x + 44;
  text(ctx, s, sx, r.y + 11, flick ? shade(col, -0.6) : col);
  if (!flick) glow(ctx, sx + textW(s) / 2, r.y + 13, 16, col, 0.12);
  // 货架 + 发光信号包
  const shx = r.x + 6, shw = r.w - 30;
  for (let row = 0; row < 2; row++) {
    const yy = r.y + 19 + row * 8;
    if (yy + 8 > r.y + r.h - 12) break;
    R(ctx, shx, yy + 6, shw, 2, th.desk.top);
    R(ctx, shx, yy + 8, shw, 1, th.outline);
    for (let k = 0; k < Math.floor(shw / 8); k++) {
      const pc = th.cityWin[(k + row) % th.cityWin.length]!;
      const x = shx + 2 + k * 8;
      R(ctx, x - 1, yy, 7, 6, th.outline);
      R(ctx, x, yy + 1, 5, 5, shade(pc, -0.35));
      R(ctx, x + 1, yy + 2, 3, 3, pc);
      if (!c.reduced && Math.sin(t * 1.5 + k * 1.3 + row) > 0.7) glow(ctx, x + 2, yy + 3, 4, pc, 0.3);
    }
  }
  // OPEN 灯牌
  const ox = r.x + r.w - 22, oy = r.y + 12;
  R(ctx, ox - 1, oy - 1, 19, 9, th.outline);
  R(ctx, ox, oy, 17, 7, '#1a0a14');
  text(ctx, 'OPEN', ox + 1, oy + 1, Math.floor(t * 1.2) % 4 === 3 && !c.reduced ? '#5a2030' : '#ff5a7a');
}

function auditBack(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const { th, t } = c;
  const h = r.h - 12;
  bookshelf(ctx, r.x + 5, r.y + 10, 34, h, th, 11);
  bookshelf(ctx, r.x + r.w - 32, r.y + 10, 27, h, th, 23);
  // 梯子
  const lx = r.x + 30;
  line(ctx, lx, r.y + 6, lx + 5, r.y + r.h - 1, th.metal.dark);
  line(ctx, lx + 4, r.y + 6, lx + 9, r.y + r.h - 1, th.metal.dark);
  for (let k = 1; k < 6; k++) { const yy = r.y + 6 + k * Math.floor((r.h - 7) / 6); const dx = Math.round(((yy - r.y - 6) / (r.h - 7)) * 5); R(ctx, lx + dx, yy, 5, 1, th.metal.b); }
  // 地球仪
  const gx = r.x + r.w - 44, gy = r.y + r.h - 14;
  if (gx > r.seatX + 16) {
    disc(ctx, gx, gy, 5, th.outline);
    disc(ctx, gx, gy, 4, '#3f6fb0');
    const rot = c.reduced ? 0 : Math.floor(t * 2) % 8;
    for (let i = 0; i < 4; i++) P(ctx, gx - 3 + ((rot + i * 2) % 7), gy - 2 + (i % 3) * 2, '#6fb04a');
    R(ctx, gx, gy + 5, 1, 7, th.metal.dark);
    R(ctx, gx - 3, gy + 12, 7, 1, th.metal.dark);
  }
}

// 世界地图(粗略 24×10 位图)
const MAP = [
  '..####.....##.####......',
  '.######...###########...',
  '..#####....##########...',
  '...###.....#########....',
  '....##......####.###....',
  '.....###.....###..#.....',
  '.....####....##.........',
  '......###.....#.....##..',
  '......##............###.',
  '.......#................',
];

function helmBack(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const { th, t } = c;
  // 作战大屏(上半层)
  const sw = Math.min(r.w - 28, 120), sh = Math.round(r.h * 0.42);
  const sx = r.x + Math.round((r.w - sw) / 2) - 8, sy = r.y + 13;
  frame(ctx, sx, sy, sw, sh, c, th.screen.bg);
  const cell = Math.max(2, Math.floor(Math.min((sw * 0.62) / 24, (sh - 4) / 10)));
  const mx = sx + 3, my = sy + 3;
  for (let y = 0; y < MAP.length; y++) for (let x = 0; x < 24; x++) {
    if (MAP[y]![x] !== '#') continue;
    P(ctx, mx + x * cell, my + y * cell, rgba(th.screen.line, 0.7));
  }
  const nodes: [number, number][] = [[4, 2], [13, 1], [19, 3], [20, 8], [7, 7]];
  nodes.forEach(([x, y], i) => {
    const on = c.reduced || Math.sin(t * 2 + i * 1.3) > -0.3;
    if (on) { P(ctx, mx + x * cell, my + y * cell, th.screen.hi); glow(ctx, mx + x * cell, my + y * cell, 3, th.screen.line, 0.35); }
  });
  for (let i = 0; i + 1 < nodes.length; i++) {
    const [ax, ay] = nodes[i]!;
    const [bx, by] = nodes[i + 1]!;
    const ph = c.reduced ? 1 : Math.min(1, ((t * 0.6 + i * 0.3) % 1.6));
    line(ctx, mx + ax * cell, my + ay * cell, mx + (ax + (bx - ax) * ph) * cell, my + (ay + (by - ay) * ph) * cell, rgba(ROLES.gate_captain.color, 0.8));
  }
  // 右侧小图
  const cx0 = mx + 24 * cell + 4;
  const cw = sx + sw - 3 - cx0;
  if (cw > 10) {
    let py = -1;
    for (let i = 0; i < cw; i++) {
      const v = noise(i + (c.reduced ? 0 : q(t, 6) * 4), 5);
      const yy = Math.round(sy + sh * 0.3 - v * sh * 0.2);
      if (py >= 0) R(ctx, cx0 + i, Math.min(py, yy), 1, Math.abs(py - yy) + 1, th.screen.line);
      py = yy;
    }
    for (let i = 0; i < cw; i += 2) {
      const v = (noise(i * 0.7 + (c.reduced ? 0 : q(t, 4) * 2), 9) + 1) / 2;
      const bh = Math.round(v * sh * 0.3);
      R(ctx, cx0 + i, sy + sh - 3 - bh, 1, bh, rgba(ROLES.gate_captain.color, 0.8));
    }
  }
  text(ctx, 'COMMAND', sx + 3, sy + sh - 7, rgba(th.screen.hi, 0.7));
  glow(ctx, sx + sw / 2, sy + sh / 2, sw * 0.4, th.screen.line, 0.05);
  // 侧楼二层的窗(看得到外面的城)
  const wx = r.x + r.w - 24, wy = r.y + 13;
  frame(ctx, wx, wy, 14, sh, c, th.sky[2]!);
  for (let i = 0; i < 6; i++) R(ctx, wx + 1 + (i % 3) * 4, wy + sh - 6 - Math.floor(hash(i + 4) * 10), 3, 10, th.cityNear);
  for (let i = 0; i < 5; i++) P(ctx, wx + 2 + (i % 3) * 4, wy + sh - 4 - (i % 2) * 3, th.cityWin[i % th.cityWin.length]!);
  if (c.rain && !c.reduced) for (let i = 0; i < 5; i++) R(ctx, wx + 1 + ((i * 3 + Math.floor(t * 9)) % 13), wy + ((i * 7 + Math.floor(t * 40)) % sh), 1, 2, 'rgba(180,200,255,0.5)');
  R(ctx, wx + 6, wy, 1, sh, c.th.metal.b);
}

// ---------- 屋顶茶水间(侧楼屋顶) ----------
export function terrace(ctx: Ctx, L: Layout, c: RoomCtx): void {
  const { th, t } = c;
  const fy = L.wingTop;
  const x0 = L.wingX, x1 = L.wingX + L.wingW - 2;
  // 木平台
  R(ctx, x0, fy - 1, x1 - x0, 1, shade(th.floorBoard, 0.2));
  // 串灯
  const p0 = x0 + 6, p1 = x1 - 6;
  R(ctx, p0, fy - 26, 1, 26, th.metal.dark);
  R(ctx, p1, fy - 26, 1, 26, th.metal.dark);
  const bulbs = ['#ffd166', '#ff7a5c', '#9be15d', '#5ec8ff', '#ff4fd8'];
  for (let i = 0; i <= 20; i++) {
    const u = i / 20;
    const x = Math.round(p0 + (p1 - p0) * u);
    const y = Math.round(fy - 26 + Math.sin(u * Math.PI) * 6);
    P(ctx, x, y, th.metal.dark);
    if (i % 3 === 1) {
      const on = c.reduced || Math.sin(t * 2 + i) > -0.5;
      const bc = bulbs[(i / 3) % bulbs.length | 0]!;
      P(ctx, x, y + 1, on ? bc : shade(bc, -0.6));
      if (on) glow(ctx, x, y + 1, 3, bc, 0.3);
    }
  }
  // 咖啡台
  const cx = L.coffeeX;
  R(ctx, cx - 9, fy - 9, 20, 9, th.outline);
  R(ctx, cx - 8, fy - 8, 18, 8, th.desk.face);
  R(ctx, cx - 8, fy - 8, 18, 1, th.desk.top);
  R(ctx, cx - 6, fy - 19, 9, 11, th.outline);
  R(ctx, cx - 5, fy - 18, 7, 10, th.metal.a);
  R(ctx, cx - 5, fy - 18, 7, 2, th.metal.dark);
  P(ctx, cx - 3, fy - 15, Math.floor(t * 2) % 2 ? '#ff3b3b' : '#5a1a1a');
  R(ctx, cx - 3, fy - 12, 3, 1, th.metal.dark);
  mug(ctx, cx - 3, fy - 8, th, t, '#f2efe6', c.reduced);
  mug(ctx, cx + 5, fy - 8, th, t + 0.4, '#ff9ac2', true);
  text(ctx, 'CAFE', cx - 6, fy - 25, th.neon[0]);
  // 长椅
  const bx = x0 + Math.round((x1 - x0) * 0.55);
  R(ctx, bx - 1, fy - 7, 22, 3, th.outline);
  R(ctx, bx, fy - 6, 20, 1, th.desk.top);
  R(ctx, bx + 1, fy - 4, 1, 4, th.metal.dark);
  R(ctx, bx + 18, fy - 4, 1, 4, th.metal.dark);
  R(ctx, bx, fy - 12, 20, 1, th.desk.top);
  R(ctx, bx + 1, fy - 12, 1, 6, th.metal.dark);
  R(ctx, bx + 18, fy - 12, 1, 6, th.metal.dark);
  // 植物
  plant(ctx, x1 - 12, fy, th, t, 2, 3, c.reduced);
  plant(ctx, bx - 8, fy, th, t, 1, 5, c.reduced);
  // 水塔
  const wt = x1 - 30;
  R(ctx, wt - 1, fy - 30, 14, 14, th.outline);
  R(ctx, wt, fy - 29, 12, 12, shade(th.facade.base, 0.1));
  for (let i = 0; i < 4; i++) R(ctx, wt, fy - 27 + i * 3, 12, 1, th.facade.dark);
  R(ctx, wt - 1, fy - 32, 14, 3, th.facade.dark);
  R(ctx, wt + 1, fy - 17, 1, 17, th.metal.dark);
  R(ctx, wt + 10, fy - 17, 1, 17, th.metal.dark);
  line(ctx, wt + 1, fy - 12, wt + 10, fy - 4, th.metal.dark);
}

export function roomHasRain(role: Role): boolean {
  return role === 'gate_captain';
}
