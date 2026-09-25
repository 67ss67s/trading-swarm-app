/**
 * 进化方格(布局 B):每个房间天花板下挂一块像素灯板「EVO + 最近 14 天」,今天那格呼吸闪;
 * 点标题在房间里展开 30 天完整方格(2 行 × 15)。色盲友好:bad 格加像素小叉,good 格加一点高光,
 * 有进化事件的格子上方亮一颗金色像素。
 */
import type { Layout, RoomGeo } from './layout';
import type { Theme } from './themes';
import type { EvoDay, EvoRoleRow, EvoStatus, Role } from './types';
import { R, P, text, mix, rgba, glow, type Ctx } from './sprites';

export const BOARD_N = 14;
const EMPTY_DAY: EvoDay = { date: '', status: 'none', score: null, headline: null };
const CELL = 3;
const STEP = 4;
const TITLE_W = 11;

export interface BoardGeo { x: number; y: number; w: number; h: number; titleX: number; cellsX: number; cellY: number }
export interface PanelGeo { x: number; y: number; w: number; h: number; cols: number; rows: number; cell: number; step: number; ox: number; oy: number }

export function boardGeo(r: RoomGeo): BoardGeo {
  const w = 2 + TITLE_W + 3 + BOARD_N * STEP - 1 + 2;
  const x = r.x + r.w - 4 - w;
  const y = r.y + 1;
  return { x, y, w, h: 7, titleX: x + 2, cellsX: x + 2 + TITLE_W + 3, cellY: y + 2 };
}

export function panelGeo(r: RoomGeo): PanelGeo {
  const cols = 15, rows = 2, cell = 5, step = 6;
  const w = cols * step - 1 + 6;
  const h = 9 + rows * step - 1 + 3;
  const b = boardGeo(r);
  return { x: r.x + r.w - 4 - w, y: b.y + b.h + 1, w, h, cols, rows, cell, step, ox: 3, oy: 9 };
}

function col(th: Theme, s: EvoStatus): string {
  return th.evo[s];
}

export function drawCell(ctx: Ctx, x: number, y: number, s: number, d: EvoDay, th: Theme, today: boolean, t: number, reduced: boolean, flash: number): void {
  let c = col(th, d.status);
  if (today && !reduced) c = mix(c, '#ffffff', 0.12 + 0.28 * (Math.sin(t * 3.2) + 1) / 2);
  if (flash > 0) c = mix(c, '#ffffff', Math.min(1, flash) * 0.8);
  R(ctx, x, y, s, s, c);
  const dark = mix(c, '#000000', 0.55);
  if (d.status === 'none') {
    R(ctx, x + 1, y + 1, s - 2, s - 2, mix(c, '#000000', 0.35));
  } else if (d.status === 'bad') {
    // 像素小叉
    for (let i = 0; i < s; i++) { P(ctx, x + i, y + i, dark); P(ctx, x + s - 1 - i, y + i, dark); }
  } else if (d.status === 'good') {
    P(ctx, x, y, mix(c, '#ffffff', 0.7));
    if (s >= 5) P(ctx, x + 1, y, mix(c, '#ffffff', 0.45));
  }
  if ((d.events ?? 0) > 0) {
    if (s >= 5) P(ctx, x + s - 1, y, '#ffe36b');
    else P(ctx, x + 1, y - 1, '#ffe36b');
  }
  if (today && (reduced || Math.floor(t * 2) % 2 === 0)) {
    ctx.fillStyle = rgba('#ffffff', 0.7);
    ctx.fillRect(x - 1, y + s, s + 2, 1);
  }
}

export function drawBoard(ctx: Ctx, r: RoomGeo, row: EvoRoleRow | undefined, th: Theme, t: number, reduced: boolean, flash: number, hover: number | null, expanded: boolean): void {
  const g = boardGeo(r);
  R(ctx, g.x - 1, g.y - 1, g.w + 2, g.h + 2, th.outline);
  R(ctx, g.x, g.y, g.w, g.h, th.evo.plate);
  R(ctx, g.x, g.y, g.w, 1, mix(th.evo.plate, '#ffffff', 0.12));
  text(ctx, 'EVO', g.titleX, g.y + 1, expanded ? '#ffe36b' : mix(th.evo.good, '#ffffff', 0.3));
  // 没数据也要把 14 格画出来(灰格);有数据按日期右对齐,今天在最右
  const src = row?.days ?? [];
  const days = src.slice(-BOARD_N);
  const off = BOARD_N - days.length;
  for (let k = 0; k < off; k++) drawCell(ctx, g.cellsX + k * STEP, g.cellY, CELL, EMPTY_DAY, th, false, t, reduced, 0);
  days.forEach((d, i) => {
    const x = g.cellsX + (i + off) * STEP;
    const today = i === days.length - 1;
    drawCell(ctx, x, g.cellY, CELL, d, th, today, t, reduced, today ? flash : 0);
    if (hover === src.length - days.length + i) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 1, g.cellY - 1, CELL + 2, 1);
      ctx.fillRect(x - 1, g.cellY + CELL, CELL + 2, 1);
    }
  });
  if (flash > 0 && !reduced) glow(ctx, g.cellsX + (BOARD_N - 1) * STEP + 1, g.cellY + 1, 6, '#ffe36b', 0.5 * Math.min(1, flash));
}

export function drawPanel(ctx: Ctx, r: RoomGeo, row: EvoRoleRow | undefined, th: Theme, t: number, reduced: boolean, hover: number | null): void {
  const p = panelGeo(r);
  R(ctx, p.x - 1, p.y - 1, p.w + 2, p.h + 2, th.outline);
  R(ctx, p.x, p.y, p.w, p.h, th.evo.plate);
  R(ctx, p.x, p.y, p.w, 1, mix(th.evo.plate, '#ffffff', 0.15));
  text(ctx, '30 DAYS', p.x + 3, p.y + 2, '#e8e6df');
  // 图例
  const lg: EvoStatus[] = ['good', 'ok', 'bad', 'none'];
  lg.forEach((s, i) => R(ctx, p.x + p.w - 4 - (4 - i) * 5, p.y + 3, 3, 3, th.evo[s]));
  const src = row?.days ?? [];
  const days = src.slice(-p.cols * p.rows);
  const off = p.cols * p.rows - days.length;
  for (let k = 0; k < off; k++) drawCell(ctx, p.x + p.ox + (k % p.cols) * p.step, p.y + p.oy + Math.floor(k / p.cols) * p.step, p.cell, EMPTY_DAY, th, false, t, reduced, 0);
  days.forEach((d, i) => {
    const k = i + off;
    const x = p.x + p.ox + (k % p.cols) * p.step;
    const y = p.y + p.oy + Math.floor(k / p.cols) * p.step;
    drawCell(ctx, x, y, p.cell, d, th, i === days.length - 1, t, reduced, 0);
    if (hover === src.length - days.length + i) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 1, y - 1, p.cell + 2, 1);
      ctx.fillRect(x - 1, y + p.cell, p.cell + 2, 1);
      ctx.fillRect(x - 1, y, 1, p.cell);
      ctx.fillRect(x + p.cell, y, 1, p.cell);
    }
  });
}

export interface EvoHit { role: Role; kind: 'cell' | 'title'; index: number; x: number; y: number }

/** 命中测试:index 是 row.days 里的下标 */
export function evoHit(L: Layout, rows: Map<Role, EvoRoleRow>, lx: number, ly: number, expanded: Role | null): EvoHit | null {
  if (expanded) {
    const r = L.rooms[expanded];
    const p = panelGeo(r);
    const row = rows.get(expanded);
    if (lx >= p.x && lx < p.x + p.w && ly >= p.y && ly < p.y + p.h) {
      if (row) {
        const n = p.cols * p.rows;
        const days = row.days.slice(-n);
        const off = n - days.length;
        for (let i = 0; i < days.length; i++) {
          const k = i + off;
          const x = p.x + p.ox + (k % p.cols) * p.step;
          const y = p.y + p.oy + Math.floor(k / p.cols) * p.step;
          if (lx >= x - 0.5 && lx < x + p.cell + 0.5 && ly >= y - 0.5 && ly < y + p.cell + 0.5) return { role: expanded, kind: 'cell', index: row.days.length - days.length + i, x: x + p.cell / 2, y };
        }
      }
      return { role: expanded, kind: 'title', index: -1, x: p.x + 10, y: p.y };
    }
  }
  for (const r of Object.values(L.rooms)) {
    const g = boardGeo(r);
    if (lx < g.x - 1 || lx >= g.x + g.w + 1 || ly < g.y - 1 || ly >= g.y + g.h + 1) continue;
    if (lx < g.cellsX - 1) return { role: r.role, kind: 'title', index: -1, x: g.titleX + 5, y: g.y };
    const row = rows.get(r.role);
    if (!row) return null;
    const days = row.days.slice(-BOARD_N);
    const off = BOARD_N - days.length;
    const i = Math.floor((lx - g.cellsX + 0.5) / STEP) - off;
    if (i < 0 || i >= days.length) return null;
    return { role: r.role, kind: 'cell', index: row.days.length - days.length + i, x: g.cellsX + (i + off) * STEP + 1.5, y: g.cellY };
  }
  return null;
}
