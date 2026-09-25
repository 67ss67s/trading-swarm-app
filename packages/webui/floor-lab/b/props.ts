/**
 * 通用道具:桌子、椅背、显示器(多种内容)、植物、马克杯热气、吊灯、书架、门牌。
 * 所有函数都画在逻辑像素坐标上,t = 世界时间(秒)。
 */
import type { Theme } from './themes';
import { R, P, line, ring, glow, lightCone, text, textW, shade, rgba, type Ctx } from './sprites';

export function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function noise(x: number, seed: number): number {
  return Math.sin(x * 0.7 + seed) * 0.5 + Math.sin(x * 0.23 + seed * 2.1) * 0.35 + Math.sin(x * 1.9 + seed * 0.3) * 0.15;
}
/** 12fps 量化时间:像素动画用它,位移用连续 t */
export function q(t: number, fps = 12): number {
  return Math.floor(t * fps) / fps;
}

export function desk(ctx: Ctx, cx: number, fy: number, w: number, th: Theme, h = 6): void {
  const x = Math.round(cx - w / 2);
  const top = fy - h;
  R(ctx, x - 1, top - 1, w + 2, 1, th.outline);
  R(ctx, x, top, w, 1, shade(th.desk.top, 0.18));
  R(ctx, x, top + 1, w, 1, th.desk.top);
  R(ctx, x, top + 2, w, h - 2, th.desk.face);
  R(ctx, x, fy - 1, w, 1, th.desk.dark);
  // 抽屉
  R(ctx, x + w - 8, top + 3, 6, 1, th.desk.dark);
  P(ctx, x + w - 5, top + 3, shade(th.desk.top, 0.3));
  R(ctx, x + 2, top + 3, 5, 1, th.desk.dark);
  R(ctx, x - 1, top, 1, h, th.outline);
  R(ctx, x + w, top, 1, h, th.outline);
}

export function chairBack(ctx: Ctx, cx: number, fy: number, color: string, th: Theme): void {
  const x = Math.round(cx - 9);
  R(ctx, x - 1, fy - 21, 20, 16, th.outline);
  R(ctx, x, fy - 20, 18, 14, color);
  R(ctx, x, fy - 20, 18, 1, shade(color, 0.25));
  R(ctx, x + 1, fy - 19, 1, 12, shade(color, 0.12));
  R(ctx, x + 16, fy - 19, 1, 12, shade(color, -0.25));
}

export type ScreenKind = 'chart' | 'candles' | 'bars' | 'text' | 'radar' | 'curve' | 'cctv' | 'pie' | 'map';

export function monitor(ctx: Ctx, x: number, bottom: number, w: number, h: number, kind: ScreenKind, t: number, th: Theme, accent: string, seed: number, alert = false, stand = true): void {
  const y = bottom - h - (stand ? 2 : 0);
  if (stand) {
    R(ctx, x + Math.floor(w / 2) - 1, bottom - 2, 2, 2, th.metal.dark);
    R(ctx, x + Math.floor(w / 2) - 3, bottom - 1, 6, 1, th.metal.b);
  }
  R(ctx, x - 1, y - 1, w + 2, h + 2, th.outline);
  R(ctx, x, y, w, h, th.screen.frame);
  screen(ctx, x + 1, y + 1, w - 2, h - 2, kind, t, th, accent, seed, alert);
}

export function screen(ctx: Ctx, x: number, y: number, w: number, h: number, kind: ScreenKind, t: number, th: Theme, accent: string, seed: number, alert = false): void {
  const qt = q(t, 8);
  const flick = hash(Math.floor(t * 3) + seed * 13) > 0.93;
  R(ctx, x, y, w, h, alert ? '#2a0610' : th.screen.bg);
  const ln = alert ? '#ff4d6d' : kind === 'candles' ? th.screen.line : th.screen.line;
  if (alert) {
    const on = Math.floor(t * 3) % 2 === 0;
    if (on) { R(ctx, x + Math.floor(w / 2), y + 1, 1, Math.max(1, h - 4), '#ff4d6d'); P(ctx, x + Math.floor(w / 2), y + h - 2, '#ff4d6d'); }
    for (let i = 0; i < w; i += 2) P(ctx, x + i, y + h - 1, '#5a1020');
  } else if (kind === 'chart' || kind === 'curve') {
    const n = w;
    const grow = kind === 'curve' ? Math.floor((qt * 5 + seed) % (n + 12)) : n;
    let py = -1;
    for (let i = 0; i < Math.min(n, grow); i++) {
      const v = kind === 'curve' ? (i / n) * 0.8 + noise(i * 0.9, seed) * 0.25 : noise(i + qt * 6, seed);
      const yy = kind === 'curve' ? Math.round(y + h - 2 - v * (h - 3)) : Math.round(y + h / 2 - v * (h / 2 - 1));
      const cy = Math.max(y, Math.min(y + h - 1, yy));
      if (py >= 0) { const a = Math.min(py, cy), b = Math.max(py, cy); R(ctx, x + i, a, 1, b - a + 1, ln); }
      else P(ctx, x + i, cy, ln);
      py = cy;
    }
    if (kind === 'curve') R(ctx, x, y + h - 1, w, 1, shade(th.screen.bg, 0.25));
    else P(ctx, x + w - 1, py, th.screen.hi);
  } else if (kind === 'candles') {
    for (let i = 0; i + 1 < w; i += 2) {
      const k = i / 2 + Math.floor(qt * 2);
      const v = noise(k, seed);
      const up = noise(k + 1, seed) > v;
      const c = up ? '#4fe08a' : '#ff5d7a';
      const mid = Math.round(y + h / 2 - v * (h / 2 - 1));
      const bh = 1 + Math.floor(hash(k + seed) * 3);
      R(ctx, x + i, Math.max(y, mid - bh), 1, Math.min(h, bh * 2), c);
    }
  } else if (kind === 'bars') {
    for (let i = 0; i < w; i += 2) {
      const v = (noise(i * 0.8 + qt * 1.5, seed) + 1) / 2;
      const bh = Math.max(1, Math.round(v * (h - 1)));
      R(ctx, x + i, y + h - bh, 1, bh, i % 4 === 0 ? ln : accent);
    }
  } else if (kind === 'text') {
    const off = Math.floor(qt * 2);
    for (let r = 0; r < h; r += 2) {
      const len = 2 + Math.floor(hash(r + off + seed) * (w - 3));
      R(ctx, x + 1, y + r, len, 1, r === 0 ? th.screen.hi : ln);
    }
  } else if (kind === 'radar') {
    const cx = x + Math.floor(w / 2), cy = y + Math.floor(h / 2);
    const rr = Math.min(w, h) / 2 - 1;
    ring(ctx, cx, cy, rr, shade(ln, -0.5));
    const a = t * 2.4;
    line(ctx, cx, cy, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, ln);
    if (Math.floor(t * 2) % 2) P(ctx, cx + 2, cy - 1, th.screen.hi);
  } else if (kind === 'cctv') {
    const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
    for (let i = 0; i < 4; i++) {
      const sx = x + (i % 2) * hw, sy = y + Math.floor(i / 2) * hh;
      R(ctx, sx, sy, hw - 1, hh - 1, shade(th.screen.bg, 0.12));
      const nn = Math.floor(qt * 4) + i * 7;
      for (let k = 0; k < 3; k++) P(ctx, sx + Math.floor(hash(nn + k) * (hw - 1)), sy + Math.floor(hash(nn + k + 9) * (hh - 1)), shade(ln, -0.2));
      R(ctx, sx, sy + ((Math.floor(t * 6) + i) % Math.max(1, hh - 1)), hw - 1, 1, rgba(th.screen.hi, 0.35));
    }
  } else if (kind === 'pie') {
    const cx = x + Math.floor(w / 2), cy = y + Math.floor(h / 2);
    const rr = Math.floor(Math.min(w, h) / 2) - 1;
    const cols = [accent, ln, th.screen.hi, shade(accent, -0.4)];
    for (let yy = -rr; yy <= rr; yy++) for (let xx = -rr; xx <= rr; xx++) {
      if (xx * xx + yy * yy > rr * rr + 1) continue;
      const ang = (Math.atan2(yy, xx) + Math.PI + t * 0.2) / (Math.PI * 2);
      const idx = ang % 1 < 0.38 ? 0 : ang % 1 < 0.64 ? 1 : ang % 1 < 0.84 ? 2 : 3;
      P(ctx, cx + xx, cy + yy, cols[idx]!);
    }
  }
  // 扫描线 + 偶发闪烁
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let r = 1; r < h; r += 2) ctx.fillRect(x, y + r, w, 1);
  if (flick) { ctx.fillStyle = rgba(th.screen.hi, 0.18); ctx.fillRect(x, y, w, h); }
  P(ctx, x, y, rgba(th.screen.hi, 0.5));
}

export function screenGlow(ctx: Ctx, x: number, y: number, w: number, h: number, th: Theme, alert = false): void {
  glow(ctx, x + w / 2, y + h / 2, Math.max(w, h) * 0.9, alert ? '#ff3355' : th.screen.line, 0.1);
}

export function plant(ctx: Ctx, x: number, fy: number, th: Theme, t: number, size = 1, seed = 0, reduced = false): void {
  const sway = reduced ? 0 : Math.round(Math.sin(t * 1.3 + seed) * 0.8);
  const ph = 5 + size;
  const pw = 5 + size * 2;
  // 盆
  R(ctx, x - Math.floor(pw / 2) - 1, fy - ph - 1, pw + 2, ph + 1, th.outline);
  R(ctx, x - Math.floor(pw / 2), fy - ph, pw, ph, th.plant.pot);
  R(ctx, x - Math.floor(pw / 2), fy - ph, pw, 1, shade(th.plant.pot, 0.3));
  R(ctx, x + Math.floor(pw / 2) - 1, fy - ph + 1, 1, ph - 1, shade(th.plant.pot, -0.3));
  // 叶子
  const top = fy - ph;
  const leaves = 4 + size * 3;
  for (let i = 0; i < leaves; i++) {
    const a = -Math.PI / 2 + (i / (leaves - 1) - 0.5) * 2.4;
    const len = 4 + size * 2 + (i % 2) * 2;
    const s = i % 2 === 0 ? sway : -sway;
    for (let k = 1; k <= len; k++) {
      const lx = x + Math.cos(a) * k * 0.9 + (k > len / 2 ? s : 0);
      const ly = top + Math.sin(a) * k * 0.8 + (k * k) / (len * 3);
      P(ctx, lx, ly, k === len ? shade(th.plant.a, 0.25) : i % 2 ? th.plant.a : th.plant.b);
    }
  }
}

export function mug(ctx: Ctx, x: number, bottom: number, th: Theme, t: number, color = '#e8e2d4', reduced = false): void {
  R(ctx, x - 1, bottom - 5, 5, 5, th.outline);
  R(ctx, x, bottom - 4, 3, 4, color);
  R(ctx, x, bottom - 4, 3, 1, shade(color, 0.3));
  P(ctx, x + 3, bottom - 3, color);
  if (reduced) return;
  for (let i = 0; i < 3; i++) {
    const ph = (t * 0.9 + i / 3) % 1;
    const sy = bottom - 6 - Math.floor(ph * 7);
    const sx = x + 1 + Math.round(Math.sin(ph * 6 + i) * 1);
    ctx.fillStyle = `rgba(235,235,235,${0.45 * (1 - ph)})`;
    ctx.fillRect(sx, sy, 1, 1);
  }
}

export function ceilingLight(ctx: Ctx, x: number, cy: number, th: Theme, accent: string): void {
  if (th.lampStyle === 'lamp') {
    R(ctx, x, cy, 1, 3, th.outline);
    R(ctx, x - 3, cy + 3, 7, 1, th.outline);
    R(ctx, x - 2, cy + 3, 5, 2, shade(th.light, -0.35));
    R(ctx, x - 3, cy + 5, 7, 1, shade(th.light, -0.5));
    R(ctx, x - 1, cy + 6, 3, 1, th.light);
  } else if (th.lampStyle === 'strip') {
    R(ctx, x - 7, cy, 14, 2, th.metal.dark);
    R(ctx, x - 6, cy + 1, 12, 1, th.light);
  } else {
    R(ctx, x - 6, cy, 12, 1, accent);
    R(ctx, x - 6, cy + 1, 12, 1, shade(accent, 0.5));
  }
}
export function ceilingLightGlow(ctx: Ctx, x: number, cy: number, fy: number, th: Theme, accent: string, dim = 1): void {
  const c = th.lampStyle === 'neon' ? accent : th.light;
  const top = cy + (th.lampStyle === 'lamp' ? 6 : 2);
  lightCone(ctx, x, top, fy, th.lampStyle === 'lamp' ? 5 : 12, th.lampStyle === 'lamp' ? 34 : 38, c, 0.055 * dim);
  glow(ctx, x, top, 5, c, 0.3 * dim);
}

export function deskLamp(ctx: Ctx, x: number, deskTop: number, th: Theme, dir: 1 | -1 = 1): void {
  R(ctx, x - 2, deskTop - 1, 5, 1, th.metal.dark);
  line(ctx, x, deskTop - 1, x + dir * 2, deskTop - 6, th.metal.b);
  R(ctx, x + dir * 2 - 2, deskTop - 8, 5, 2, th.lampStyle === 'lamp' ? '#2f6b45' : th.metal.a);
  R(ctx, x + dir * 2 - 1, deskTop - 6, 3, 1, th.light);
}
export function deskLampGlow(ctx: Ctx, x: number, deskTop: number, th: Theme, dir: 1 | -1 = 1): void {
  lightCone(ctx, x + dir * 2, deskTop - 6, deskTop + 1, 3, 16, th.light, 0.09);
}

export function bookshelf(ctx: Ctx, x: number, y: number, w: number, h: number, th: Theme, seed: number): void {
  R(ctx, x - 1, y - 1, w + 2, h + 2, th.outline);
  R(ctx, x, y, w, h, th.desk.dark);
  R(ctx, x, y, w, 1, th.desk.top);
  const shelfH = 8;
  for (let sy = y + 1; sy + shelfH <= y + h; sy += shelfH) {
    R(ctx, x + 1, sy, w - 2, shelfH - 1, shade(th.desk.dark, -0.35));
    let bx = x + 1;
    let k = 0;
    while (bx < x + w - 2) {
      const bw = 1 + Math.floor(hash(seed + sy * 3 + k) * 2);
      const bh = 4 + Math.floor(hash(seed + sy + k * 7) * 3);
      if (hash(seed + k * 11 + sy) < 0.1) { bx += 2; k++; continue; }
      const c = th.books[Math.floor(hash(seed + k * 5 + sy * 2) * th.books.length)]!;
      R(ctx, bx, sy + shelfH - 1 - bh, bw, bh, c);
      P(ctx, bx, sy + shelfH - 1 - bh, shade(c, 0.35));
      bx += bw;
      k++;
    }
    R(ctx, x, sy + shelfH - 1, w, 1, th.desk.face);
  }
}

export function nameplate(ctx: Ctx, x: number, y: number, callsign: string, color: string, status: string, t: number, th: Theme): void {
  const w = textW(callsign) + 9;
  R(ctx, x - 1, y - 1, w + 2, 9, th.outline);
  R(ctx, x, y, w, 7, shade(th.wall.dark, -0.2));
  R(ctx, x + 1, y + 1, 3, 5, color);
  text(ctx, callsign, x + 6, y + 1, '#f2eee4');
  // 状态灯
  const sc = status === 'working' ? '#5dff8f' : status === 'waiting' ? '#ffd166' : status === 'stuck' ? '#ff3b5c' : '#7c8594';
  const on = status !== 'stuck' || Math.floor(t * 4) % 2 === 0;
  R(ctx, x + w + 2, y + 2, 3, 3, th.outline);
  if (on) { P(ctx, x + w + 3, y + 3, sc); }
}
