/**
 * 每个 agent 自己的小房间(镜头推进后看到的场景),同样画在 640×360 世界里,安全区 40..600 × 22..338。
 * 房间里:大号角色 + 专属道具(会动)+ 墙上 30 天进化方格板。3 个关键数与「打开工作台」由 DOM 卡片给。
 */
import type { EvoDay } from './types';
import type { Theme } from './themes';
import type { Weather } from './world';
import type { RoomKind } from './roles';
import { box, dither, ellipse, hash, hline, mix, px, rect, rgba, shade, text, textWidth, vline, type Ctx } from './pixel';
import { drawChar, drawGlobe, drawPlant, shadow, WORLD } from './sprites';
import { drawEvoCell } from './desks';
import { DECO } from '../deco';
import type { AgentSim } from './world';

const W = 640;
const H = 360;
const WALL = 170;

export const ROOM_AGENT = { x: 196, y: 300 };
export const ROOM_EVO = { x: 94, y: 66, cell: 8, gap: 2, cols: 15 };

export function roomEvoCellRect(i: number): { x: number; y: number; w: number; h: number } {
  const { x, y, cell, gap, cols } = ROOM_EVO;
  return { x: x + (i % cols) * (cell + gap), y: y + Math.floor(i / cols) * (cell + gap), w: cell, h: cell };
}

export interface RoomCtx {
  th: Theme;
  sim: AgentSim;
  evo: EvoDay[];
  hoverEvo: number;
  evoFocus: boolean;
  t: number;
  still: boolean;
  weather: Weather;
  cursor: { x: number; y: number } | null;
}

export function drawRoom(g: Ctx, rc: RoomCtx): void {
  const { th, sim, t, still } = rc;
  const p = th.c;
  const col = sim.meta.color;
  shell(g, th, sim.meta.room);
  // 房间专属
  const kind = sim.meta.room;
  g.save();
  g.translate(-24, 0);
  ROOM_DRAW[kind](g, th, col, t, still, rc);
  g.restore();
  WALL_EXTRA[kind](g, th, col, t, still, rc);
  // 进化板
  drawEvoBoard(g, rc);
  // 标题牌
  const title = `${sim.meta.callsign}`;
  rect(g, 88, 24, textWidth(title, 2) + 12, 16, p.outline);
  rect(g, 89, 25, textWidth(title, 2) + 10, 14, shade(p.wallDark, -0.2));
  text(g, title, 95, 28, col, 2);
  // 大号角色
  const breath = !still && Math.sin(t * 2.2 + sim.phase) > 0;
  const blink = !still && t % 3.7 < 0.14;
  let look: -1 | 0 | 1 = 0;
  if (rc.cursor && !still) {
    const dx = rc.cursor.x - ROOM_AGENT.x;
    look = Math.abs(dx) < 10 ? 0 : dx < 0 ? -1 : 1;
  }
  shadow(g, ROOM_AGENT.x, ROOM_AGENT.y, 26, 0.4);
  drawChar(g, sim.meta.shape, col, ROOM_AGENT.x, ROOM_AGENT.y, { cell: 4, breath, blink, look });
  // 状态灯
  const st = sim.data.status;
  const stCol = st === 'working' ? p.up : st === 'stuck' ? p.down : st === 'waiting' ? p.warn : p.textDim;
  rect(g, ROOM_AGENT.x - 20, ROOM_AGENT.y + 8, 40, 9, p.outline);
  rect(g, ROOM_AGENT.x - 17, ROOM_AGENT.y + 11, 3, 3, stCol);
  const lab = st === 'working' ? 'WORKING' : st === 'stuck' ? 'STUCK' : st === 'waiting' ? 'WAITING' : 'IDLE';
  text(g, lab, ROOM_AGENT.x - 11, ROOM_AGENT.y + 10, p.text);
  // 前景植物
  drawPlant(g, p, 552, 338, 2.2, t, 77, still);
  drawPlant(g, p, 92, 340, 1.6, t, 78, still);
}

function shell(g: Ctx, th: Theme, kind: RoomKind): void {
  const p = th.c;
  rect(g, -40, -40, W + 80, H + 80, p.floorA);
  // 墙
  rect(g, -40, 0, W + 80, WALL, kind === 'radar' ? '#0a0e22' : p.wall);
  rect(g, -40, -40, W + 80, 40, p.ceiling);
  if (kind !== 'radar') {
    for (let x = -40; x < W + 40; x += 20) {
      vline(g, x, 12, WALL - 12, p.wallDark);
      vline(g, x + 1, 12, WALL - 12, p.wallHi);
    }
    rect(g, -40, WALL - 40, W + 80, 36, p.wallDark);
    hline(g, -40, WALL - 40, W + 80, p.trimHi);
  }
  rect(g, -40, 0, W + 80, 12, p.ceiling);
  hline(g, -40, 11, W + 80, p.outline);
  rect(g, -40, WALL - 5, W + 80, 5, p.trim);
  hline(g, -40, WALL - 5, W + 80, p.trimHi);
  // 地板
  for (let y = WALL; y < H + 40; y += 10) {
    const off = ((y - WALL) / 10) % 2 ? 0 : 24;
    for (let x = -40 - off; x < W + 40; x += 48) {
      const c = hash(x * 5 + y) > 0.5 ? p.floorA : p.floorB;
      rect(g, x, y, 48, 10, c);
      hline(g, x, y, 48, shade(c, 0.07));
      vline(g, x, y, 10, p.floorLine);
    }
  }
  g.save();
  for (let j = 0; j < 30; j++) {
    g.globalAlpha = 0.35 * (1 - j / 30);
    hline(g, -40, WALL + j, W + 80, '#000');
  }
  g.restore();
  // 地毯
  ellipse(g, ROOM_AGENT.x + 90, 300, 190, 36, p.rugEdge);
  ellipse(g, ROOM_AGENT.x + 90, 300, 186, 33, p.rugDark);
  ellipse(g, ROOM_AGENT.x + 90, 300, 176, 28, p.rug);
}

function drawEvoBoard(g: Ctx, rc: RoomCtx): void {
  const { th, evo, hoverEvo, t, still } = rc;
  const p = th.c;
  const { x, y, cell, gap, cols } = ROOM_EVO;
  const bw = cols * (cell + gap) - gap;
  const bh = 2 * (cell + gap) - gap;
  box(g, x - 6, y - 14, bw + 12, bh + 22, shade(p.wallDark, -0.3), p.trim, p.outline, p.outline);
  text(g, 'EVOLUTION 30D', x, y - 10, rc.evoFocus ? p.warn : p.textDim);
  const days = evo.slice(-30);
  while (days.length < 30) days.unshift({ date: '', status: 'none', score: null, headline: null });
  days.forEach((d, i) => {
    const r = roomEvoCellRect(i);
    drawEvoCell(g, th, r.x, r.y, cell, d.status, i === 29, i === hoverEvo, t, still);
    if ((d.events ?? 0) > 0) px(g, r.x + cell - 2, r.y + 1, '#ffffff');
  });
  if (rc.evoFocus && !still) {
    g.save();
    g.globalAlpha = 0.4 + 0.4 * Math.sin(t * 5);
    hline(g, x - 7, y - 15, bw + 14, p.warn);
    hline(g, x - 7, y + bh + 8, bw + 14, p.warn);
    g.restore();
  }
}

type RoomFn = (g: Ctx, th: Theme, col: string, t: number, still: boolean, rc: RoomCtx) => void;

const ROOM_DRAW: Record<RoomKind, RoomFn> = {
  radar(g, th, col, t, still) {
    const p = th.c;
    // 穹顶星空
    for (let i = 0; i < 120; i++) {
      const sx = hash(i * 7) * W;
      const sy = 14 + hash(i * 13) * (WALL - 30);
      const tw = still || Math.sin(t * 2 + i) > -0.5;
      if (tw) px(g, sx, sy, i % 7 ? '#8a9ad0' : '#ffffff');
    }
    for (let i = 0; i < W; i += 40) vline(g, i, 12, WALL - 12, '#141a3a');
    // 望远镜
    rect(g, 300, 250, 4, 40, p.metalDark);
    rect(g, 290, 288, 24, 4, p.metalDark);
    g.save();
    g.translate(302, 250);
    g.rotate(-0.6);
    rect(g, -6, -40, 12, 44, p.outline);
    rect(g, -5, -39, 10, 42, p.metalHi);
    rect(g, -5, -39, 3, 42, shade(p.metalHi, 0.3));
    g.restore();
    // 雷达屏
    const cx = 470;
    const cy = 240;
    const r = 52;
    box(g, cx - r - 12, cy - r - 12, r * 2 + 24, r * 2 + 50, p.metalDark, p.metal, p.outline, p.outline);
    ellipse(g, cx, cy, r + 2, r + 2, p.outline);
    ellipse(g, cx, cy, r, r, '#031a0c');
    for (const rr of [r * 0.33, r * 0.66, r]) for (let a = 0; a < 64; a++) px(g, cx + Math.cos((a / 64) * 6.283) * rr, cy + Math.sin((a / 64) * 6.283) * rr, '#0f4a24');
    hline(g, cx - r, cy, r * 2, '#0f4a24');
    vline(g, cx, cy - r, r * 2, '#0f4a24');
    const ang = still ? 0.8 : t * 1.6;
    for (let k = 0; k < 28; k++) {
      const a = ang - k * 0.03;
      g.save();
      g.globalAlpha = 1 - k / 28;
      for (let i = 0; i < r; i += 1) px(g, cx + Math.cos(a) * i, cy + Math.sin(a) * i, k === 0 ? '#aaffc0' : col);
      g.restore();
    }
    const blips = [[0.5, 0.6], [2.2, 0.8], [3.9, 0.35], [5.1, 0.7]];
    blips.forEach(([a0, d0]) => {
      const diff = ((ang - a0!) % 6.283 + 6.283) % 6.283;
      const a = Math.max(0, 1 - diff / 3);
      g.save();
      g.globalAlpha = a;
      rect(g, cx + Math.cos(a0!) * r * d0! - 1, cy + Math.sin(a0!) * r * d0! - 1, 3, 3, '#e8ffe8');
      g.restore();
    });
    text(g, 'SCAN 212', cx - 30, cy + r + 18, col);
  },
  lab(g, th, col, t, still) {
    const p = th.c;
    // 墙上的回测曲线板
    box(g, 290, 40, 290, 100, '#0a1410', '#1c2a22', p.outline, p.outline);
    text(g, 'BACKTEST  SOL BREAKOUT V3', 300, 46, col);
    const prog = still ? 1 : (t * 0.12) % 1.2;
    let yv = 120;
    for (let i = 0; i < 260; i++) {
      if (i / 260 > prog) break;
      yv += Math.sin(i * 0.21) * 1.2 + (hash(i) - 0.42) * 2.4;
      yv = Math.max(60, Math.min(132, yv));
      px(g, 304 + i, yv, p.up);
      px(g, 304 + i, yv + 1, shade(p.up, -0.5));
    }
    hline(g, 304, 132, 262, '#1c3a2a');
    text(g, 'WIN 58%  PF 1.9', 470, 124, p.text);
    // 实验台 + 烧杯
    box(g, 300, 250, 250, 14, p.deskTop, p.deskTopHi, p.deskFront, p.outline);
    rect(g, 300, 264, 250, 26, p.deskFront);
    const flasks: [number, string][] = [[330, '#5effa8'], [380, col], [440, '#ff7a5c'], [500, '#39c8ff']];
    flasks.forEach(([fx, c], i) => {
      const h = 26 + (i % 2) * 8;
      rect(g, fx - 7, 250 - h, 14, h, p.outline);
      rect(g, fx - 6, 250 - h + 1, 12, h - 1, rgba('#d8f0ff', 0.25) as string);
      rect(g, fx - 6, 250 - h * 0.55, 12, h * 0.55 - 1, c);
      hline(g, fx - 6, 250 - h * 0.55, 12, shade(c, 0.4));
      rect(g, fx - 3, 250 - h - 6, 6, 6, p.outline);
      rect(g, fx - 2, 250 - h - 6, 4, 6, rgba('#d8f0ff', 0.3) as string);
      if (!still)
        for (let b = 0; b < 4; b++) {
          const ph = (t * 0.8 + b / 4 + i * 0.3) % 1;
          px(g, fx - 3 + ((b * 3) % 7), 250 - 3 - ph * (h * 0.5 + 12), mix(c, '#ffffff', 0.6));
        }
    });

  },
  sentinel(g, th, col, t, still, rc) {
    const p = th.c;
    // 瞭望窗 + 探照灯
    box(g, 280, 30, 140, 100, p.trim, p.trimHi, p.outline, p.outline);
    rect(g, 284, 34, 132, 92, rc.weather.night ? '#0a1030' : '#6a90c0');
    for (let i = 0; i < 12; i++) {
      const bh = 10 + hash(i) * 30;
      rect(g, 284 + i * 11, 126 - bh, 10, bh, '#0c1226');
    }
    if (!still) {
      const a = Math.sin(t * 0.8) * 0.6 - 1.57;
      g.save();
      g.beginPath();
      g.rect(284, 34, 132, 92);
      g.clip();
      g.globalAlpha = 0.25;
      g.fillStyle = '#fff8c0';
      g.beginPath();
      g.moveTo(350, 126);
      g.lineTo(350 + Math.cos(a - 0.12) * 120, 126 + Math.sin(a - 0.12) * 120);
      g.lineTo(350 + Math.cos(a + 0.12) * 120, 126 + Math.sin(a + 0.12) * 120);
      g.closePath();
      g.fill();
      g.restore();
    }
    vline(g, 350, 34, 92, p.trim);
    hline(g, 284, 80, 132, p.trim);
    // 金库门
    const cx = 500;
    const cy = 220;
    ellipse(g, cx, cy, 62, 62, p.outline);
    ellipse(g, cx, cy, 60, 60, p.metal);
    ellipse(g, cx, cy, 52, 52, p.metalDark);
    ellipse(g, cx, cy, 48, 48, p.metalHi);
    ellipse(g, cx - 4, cy - 4, 40, 40, shade(p.metalHi, 0.12));
    for (let a = 0; a < 12; a++) rect(g, cx + Math.cos(a * 0.524) * 56 - 2, cy + Math.sin(a * 0.524) * 56 - 2, 4, 4, p.metalDark);
    const rot = still ? 0 : t * 0.7;
    for (let k = 0; k < 3; k++) {
      const a = rot + (k * Math.PI) / 3;
      for (let i = -28; i <= 28; i++) {
        rect(g, cx + Math.cos(a) * i - 1, cy + Math.sin(a) * i - 1, 3, 3, p.outline);
      }
      for (let i = -27; i <= 27; i++) px(g, cx + Math.cos(a) * i, cy + Math.sin(a) * i, p.metalHi);
    }
    ellipse(g, cx, cy, 8, 8, p.outline);
    ellipse(g, cx, cy, 6, 6, col);
  },
  exec(g, th, col, t, still) {
    const p = th.c;
    // 走马灯行情
    rect(g, 0, 14, W, 12, '#050808');
    const tape = DECO.tape.length ? `  ${DECO.tape.map((x) => x.text).join('   ')}   ` : '  NO DATA   ';
    const off = still ? 0 : Math.floor(t * 30) % (textWidth(tape) + 40);
    text(g, tape + tape, 10 - off, 18, p.up);
    // 四屏交易台
    for (let i = 0; i < 4; i++) {
      const mx = 290 + i * 74;
      const my = 60 + (i % 2) * 6;
      box(g, mx, my, 68, 50, p.monFrame, p.monFrameHi, p.outline, p.outline);
      rect(g, mx + 3, my + 3, 62, 44, p.screen);
      if (i === 1) {
        for (let r = 0; r < 9; r++) {
          const L = 8 + hash(r + Math.floor(still ? 0 : t * 3)) * 40;
          rect(g, mx + 5, my + 5 + r * 4, L, 2, r < 4 ? p.down : p.up);
        }
      } else {
        const shift = still ? 0 : t * 4;
        for (let k = 0; k < 20; k++) {
          const v = Math.sin((k + shift) * 0.4 + i) * 8 + Math.sin((k + shift) * 0.13) * 6;
          const up = hash(Math.floor(k + shift) + i) > 0.45;
          rect(g, mx + 5 + k * 3, my + 24 - v, 2, 4 + Math.abs(v) * 0.3, up ? p.up : p.down);
        }
      }
      rect(g, mx + 30, my + 50, 8, 10, p.monFrame);
    }
    box(g, 280, 232, 310, 14, p.deskTop, p.deskTopHi, p.deskFront, p.outline);
    rect(g, 280, 246, 310, 36, p.deskFront);
    // 下单大按钮 + 电话
    rect(g, 420, 222, 24, 10, p.outline);
    rect(g, 421, 223, 22, 8, still || Math.sin(t * 3) > 0 ? col : shade(col, -0.4));
    text(g, 'GO', 427, 225, p.outline);
    rect(g, 520, 222, 22, 10, p.outline);
    rect(g, 521, 223, 20, 8, p.metalDark);
    if (!still && Math.sin(t * 7) > 0.6) text(g, 'RING', 518, 212, p.warn);
  },
  market(g, th, col, t, still) {
    const p = th.c;
    // 雨棚
    for (let i = 0; i < 300; i++) {
      const c = Math.floor(i / 12) % 2 ? '#f4efe2' : col;
      vline(g, 290 + i, 40, 16, c);
      if (i % 12 < 8) vline(g, 290 + i, 56, 3, c);
    }
    hline(g, 290, 40, 300, p.outline);
    // 霓虹招牌
    const on = still || Math.sin(t * 3) > -0.7;
    const s = 'SIGNAL SHOP';
    text(g, s, 440 - textWidth(s, 2) / 2, 70, on ? mix(col, '#ffffff', 0.4) : shade(col, -0.5), 2);
    // 货架:信号卡
    for (let r = 0; r < 2; r++) {
      rect(g, 300, 96 + r * 34, 280, 4, p.shelf);
      for (let i = 0; i < 9; i++) {
        const cx = 306 + i * 31;
        const cy = 72 + r * 34;
        const c = p.books[(i + r) % p.books.length]!;
        rect(g, cx, cy, 22, 24, p.outline);
        rect(g, cx + 1, cy + 1, 20, 22, '#f4efe2');
        rect(g, cx + 3, cy + 3, 16, 8, c);
        hline(g, cx + 3, cy + 14, 14, '#8a8070');
        hline(g, cx + 3, cy + 17, 10, '#8a8070');
      }
    }
    // 柜台 + 收银机 + 金币
    box(g, 300, 240, 280, 14, p.deskTop, p.deskTopHi, p.deskFront, p.outline);
    rect(g, 300, 254, 280, 30, mix(col, p.deskFront, 0.6));
    box(g, 500, 212, 44, 28, p.metal, p.metalHi, p.metalDark, p.outline);
    rect(g, 506, 216, 32, 8, '#0a1410');
    text(g, '+12U', 510, 218, p.up);
    const drawer = still ? 0 : Math.max(0, Math.sin(t * 1.3)) * 6;
    rect(g, 498, 240 + drawer * 0, 48, 4 + drawer, p.metalDark);
    for (let i = 0; i < 6; i++) {
      ellipse(g, 340 + i * 8, 236 - (i % 3) * 3, 4, 2, p.outline);
      ellipse(g, 340 + i * 8, 235 - (i % 3) * 3, 4, 2, '#ffcf4a');
    }
  },
  audit(g, th, col, t, still) {
    const p = th.c;
    // 满墙书架
    for (let s = 0; s < 3; s++) {
      const sx = 260 + s * 116;
      box(g, sx, 20, 110, 160, p.shelf, shade(p.shelf, 0.2), p.shelfDark, p.outline);
      for (let r = 0; r < 5; r++) {
        const by = 24 + r * 31;
        rect(g, sx + 3, by, 104, 27, p.shelfDark);
        rect(g, sx + 3, by + 27, 104, 3, p.shelf);
        let bx = sx + 4;
        let k = s * 50 + r * 9;
        while (bx < sx + 104) {
          const bw = 3 + Math.floor(hash(k) * 4);
          const bh = 16 + Math.floor(hash(k + 1) * 10);
          const c = p.books[Math.floor(hash(k + 2) * p.books.length)]!;
          rect(g, bx, by + 27 - bh, bw, bh, c);
          vline(g, bx, by + 27 - bh, bh, shade(c, 0.25));
          bx += bw + 1;
          k += 3;
        }
      }
    }
    // 梯子
    for (let i = 0; i < 2; i++) vline(g, 372 + i * 16, 60, 200, p.metalDark);
    for (let y = 70; y < 260; y += 14) hline(g, 372, y, 17, p.metalDark);
    // 阅读桌 + 翻页的书 + 台灯
    box(g, 430, 250, 150, 12, p.deskTop, p.deskTopHi, p.deskFront, p.outline);
    rect(g, 440, 262, 6, 28, p.deskFront);
    rect(g, 564, 262, 6, 28, p.deskFront);
    rect(g, 480, 240, 40, 12, p.outline);
    rect(g, 481, 241, 18, 10, '#f4efe2');
    rect(g, 501, 241, 18, 10, '#efe8d8');
    const flip = still ? 0 : (t * 0.5) % 1;
    if (flip < 0.3) {
      const fw = Math.round(18 * Math.cos((flip / 0.3) * Math.PI));
      if (fw > 0) rect(g, 501, 238, fw, 10, '#ffffff');
      else rect(g, 501 + fw, 238, -fw, 10, '#ffffff');
    }
    for (let i = 0; i < 4; i++) hline(g, 483, 243 + i * 2, 14, '#9a8a70');
    rect(g, 550, 230, 3, 20, p.metalDark);
    rect(g, 543, 224, 16, 7, p.lamp);
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.12;
    ellipse(g, 520, 250, 50, 14, p.lampLight.startsWith('rgba') ? '#ffbe6e' : p.lamp);
    g.restore();
    void col;
  },
  book(g, th, col, t, still) {
    const p = th.c;
    // 账本墙:每行一笔真实持仓(DECO.ledger),没有持仓就空着
    box(g, 270, 26, 320, 130, '#0c0f0c', '#1a201a', p.outline, p.outline);
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 6; c++) {
        const x = 276 + c * 52;
        const y = 32 + r * 13;
        rect(g, x, y, 50, 11, (r + c) % 2 ? '#101610' : '#0e130e');
        const v = DECO.ledger[r]?.[c];
        if (!v) continue;
        const neg = v.startsWith('-');
        text(g, v.slice(0, 8), x + 3, y + 3, c === 0 ? col : c === 5 ? (neg ? p.down : p.up) : p.text);
      }
    if (!DECO.ledger.length) text(g, 'NO POSITIONS', 390, 84, p.textDim);
    void hash;
    // 饼图
    const cx = 470;
    const cy = 238;
    const R = 36;
    const PIE = [col, p.up, '#5ec8ff', p.metal];
    const tot = DECO.byCoin.slice(0, 4).reduce((s, x) => s + x[1], 0);
    const parts: [number, string][] = tot > 0 ? DECO.byCoin.slice(0, 4).map(([, v], i) => [v / tot, PIE[i]!] as [number, string]) : [[1, p.metal]];
    const rot = still ? 0 : t * 0.2;
    let a0 = rot;
    ellipse(g, cx, cy + 4, R + 1, R * 0.55 + 1, p.outline);
    for (const [f, c] of parts) {
      for (let a = a0; a < a0 + f * 6.283; a += 0.02) for (let rr = 0; rr < R; rr += 1) px(g, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.55, c);
      a0 += f * 6.283;
    }
    text(g, `EXPOSURE ${DECO.exposurePct ?? '--'}`, cx - 24, cy + 30, p.text);
    // 算盘
    box(g, 320, 222, 70, 40, p.deskTop, p.deskTopHi, p.deskFront, p.outline);
    for (let r = 0; r < 4; r++) {
      hline(g, 324, 228 + r * 9, 62, p.metalDark);
      for (let b = 0; b < 5; b++) {
        const slide = still ? 0 : Math.round(Math.sin(t * 1.2 + r + b) * 2);
        rect(g, 328 + b * 11 + slide, 226 + r * 9, 6, 5, b % 2 ? col : '#f4efe2');
      }
    }
  },
  thread(g, th, col, t, still) {
    const p = th.c;
    // 软木板
    box(g, 270, 24, 320, 140, '#b88a52', '#d0a468', '#8a6038', p.outline);
    dither(g, 272, 26, 316, 136, '#a67a44');
    const notes: [number, number, string][] = [[296, 44, '#ffe066'], [380, 38, '#9be15d'], [470, 52, '#ff9af0'], [540, 40, '#5ec8ff'], [320, 110, '#ffffff'], [420, 104, '#ffe066'], [520, 116, '#ff7a5c']];
    const pins = notes.map(([x, y]) => ({ x: x + 12, y: y + 2 }));
    // 红线逐条牵出
    const links: [number, number][] = [[0, 1], [1, 2], [2, 3], [1, 5], [4, 5], [5, 6], [0, 4]];
    const prog = still ? links.length : (t * 0.8) % (links.length + 2);
    links.forEach(([a, b], i) => {
      const f = Math.max(0, Math.min(1, prog - i));
      if (f <= 0) return;
      const A = pins[a]!;
      const B = pins[b]!;
      const n = Math.hypot(B.x - A.x, B.y - A.y);
      for (let k = 0; k < n * f; k++) {
        const u = k / n;
        px(g, A.x + (B.x - A.x) * u, A.y + (B.y - A.y) * u + Math.sin(u * Math.PI) * 5, '#d8283a');
      }
    });
    notes.forEach(([x, y, c], i) => {
      rect(g, x - 1, y - 1, 26, 22, 'rgba(0,0,0,0.3)');
      rect(g, x, y, 24, 20, c);
      for (let l = 0; l < 3; l++) hline(g, x + 3, y + 6 + l * 4, 12 + ((i + l) % 3) * 3, shade(c, -0.45));
      ellipse(g, x + 12, y + 2, 2, 2, '#c82030');
    });
    text(g, 'SOL?', 300, 50, '#6a4a10');
    // 放大镜在板前游走
    const mx = still ? 430 : 420 + Math.sin(t * 0.7) * 90;
    const my = still ? 90 : 90 + Math.cos(t * 0.9) * 30;
    ellipse(g, mx, my, 12, 12, p.outline);
    ellipse(g, mx, my, 10, 10, rgba('#d8f0ff', 0.35) as string);
    px(g, mx - 4, my - 4, '#ffffff');
    for (let i = 0; i < 10; i++) rect(g, mx + 8 + i, my + 8 + i, 3, 3, p.metalDark);
    void col;
  },
  helm(g, th, col, t, still) {
    const p = th.c;
    // 大屏
    box(g, 280, 26, 310, 110, '#050a10', '#101a2a', p.outline, p.outline);
    text(g, 'MISSION BOARD', 292, 32, col);
    const items = ['RADAR  SCAN 212', 'THREAD SOL THESIS', 'LAB    BACKTEST V3', 'SENTINEL CHECK', 'EXEC   WAIT APPROVAL'];
    items.forEach((s, i) => {
      const done = i < (still ? 3 : Math.floor(t * 0.6) % 6);
      rect(g, 292, 46 + i * 16, 8, 8, done ? p.up : p.outline);
      text(g, s, 306, 48 + i * 16, done ? p.text : p.textDim);
    });
    // 作战桌:地图 + 移动的棋子
    const tx = 300;
    const ty = 200;
    rect(g, tx - 2, ty - 2, 284, 74, p.outline);
    rect(g, tx, ty, 280, 70, p.table);
    rect(g, tx + 6, ty + 6, 268, 58, '#0a1a24');
    for (let r = 0; r < 14; r++)
      for (let c = 0; c < 36; c++) if (WORLD[r + 2]?.[c] === '#') rect(g, tx + 10 + c * 7.3, ty + 8 + r * 4, 5, 3, '#1c4a5a');
    const cols = ['#9be15d', '#5ec8ff', '#c98bff', '#ff5d8f', '#4fd1c5'];
    cols.forEach((c, i) => {
      const u = still ? i / 5 : (t * 0.05 + i / 5) % 1;
      const x = tx + 14 + u * 250;
      const y = ty + 20 + Math.sin(u * 6 + i) * 16 + i * 4;
      ellipse(g, x, y, 3, 3, p.outline);
      ellipse(g, x, y - 1, 2, 2, c);
    });
    rect(g, tx + 10, ty + 70, 8, 24, p.tableDark);
    rect(g, tx + 262, ty + 70, 8, 24, p.tableDark);
    drawGlobe(g, 560, 176, 10, p.holo, p.holoDim, t, still);
  },
};

// ---------------- 墙面补充道具(不平移,填左侧与上方空墙) ----------------
const LZ = { x: 86, y: 108, w: 162, h: 56 };

function frame(g: Ctx, th: Theme, x: number, y: number, w: number, h: number, fill: string): void {
  box(g, x, y, w, h, fill, shade(fill, 0.18), shade(fill, -0.3), th.c.outline);
}

const WALL_EXTRA: Record<RoomKind, RoomFn> = {
  radar(g, th, col, t, still) {
    const p = th.c;
    // 星图
    frame(g, th, LZ.x, LZ.y, LZ.w, LZ.h, '#0c1430');
    const stars: [number, number][] = [[14, 12], [34, 20], [52, 10], [70, 26], [96, 16], [118, 34], [140, 22], [30, 42], [80, 44], [128, 46]];
    const lines: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [1, 7], [3, 8], [5, 9]];
    for (const [a, b] of lines) {
      const A = stars[a]!;
      const B = stars[b]!;
      const n = Math.hypot(B[0] - A[0], B[1] - A[1]);
      for (let k = 0; k < n; k += 2) px(g, LZ.x + A[0] + ((B[0] - A[0]) * k) / n, LZ.y + A[1] + ((B[1] - A[1]) * k) / n, '#3a5a9a');
    }
    stars.forEach(([x, y], i) => {
      const tw = still || Math.sin(t * 3 + i) > -0.6;
      rect(g, LZ.x + x - 1, LZ.y + y - 1, 3, 3, tw ? '#e8f0ff' : '#8a9ad0');
    });
    text(g, 'SKY MAP', LZ.x + 4, LZ.y + LZ.h - 8, '#6a8ad0');
    // 圆形天窗 + 望远镜视野
    const cx = 492;
    const cy = 70;
    ellipse(g, cx, cy, 48, 48, p.outline);
    ellipse(g, cx, cy, 46, 46, p.metal);
    ellipse(g, cx, cy, 41, 41, '#050818');
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * 6.28 + (still ? 0 : t * 0.05);
      const r = 8 + hash(i) * 30;
      px(g, cx + Math.cos(a) * r, cy + Math.sin(a) * r, i % 6 ? '#8a9ad0' : '#ffffff');
    }
    ellipse(g, cx + 14, cy - 12, 8, 8, '#f4ecc8');
    px(g, cx + 11, cy - 14, '#d8ceaa');
    px(g, cx + 16, cy - 9, '#d8ceaa');
    for (let a = 0; a < 8; a++) rect(g, cx + Math.cos(a * 0.785) * 44 - 1, cy + Math.sin(a * 0.785) * 44 - 1, 3, 3, p.metalDark);
    void col;
  },
  lab(g, th, col, t, still) {
    const p = th.c;
    // 白板公式
    frame(g, th, LZ.x, LZ.y, LZ.w, LZ.h, '#e8ece8');
    const lines = ['SHARPE = MU / SIGMA', 'PF = GP / GL = 1.9', 'DD < 8%  N = 312', 'H0: EDGE > COST ?'];
    lines.forEach((l, i) => text(g, l, LZ.x + 6, LZ.y + 6 + i * 11, i === 3 ? '#c83040' : '#2a3a6a'));
    // 画了一半的小曲线
    for (let i = 0; i < 26; i++) px(g, LZ.x + 128 + i, LZ.y + 40 - Math.sqrt(i) * 4, '#2f8a4a');
    rect(g, LZ.x + LZ.w - 16, LZ.y + LZ.h, 12, 3, p.metalDark);
    rect(g, LZ.x + LZ.w - 14, LZ.y + LZ.h - 2, 3, 2, '#c83040');
    // 药剂架
    rect(g, 266, 150, 170, 3, p.shelf);
    for (let i = 0; i < 8; i++) {
      const c = p.books[i % p.books.length]!;
      const h = 8 + (i % 3) * 3;
      rect(g, 272 + i * 20, 150 - h - 1, 12, h + 1, p.outline);
      rect(g, 273 + i * 20, 150 - h, 10, h, c);
      hline(g, 273 + i * 20, 150 - h, 10, shade(c, 0.4));
      if (!still && i % 3 === 0) px(g, 277 + i * 20, 150 - h - 3 - ((t * 6 + i) % 4), mix(c, '#ffffff', 0.5));
    }
    void col;
  },
  sentinel(g, th, col, t, still) {
    const p = th.c;
    // 限额条
    frame(g, th, LZ.x, LZ.y, LZ.w, LZ.h, '#0e1418');
    const bars: [string, number, string][] = [['DAY LOSS', 0.14, p.up], ['EXPOSURE', 0.62, p.warn], ['LEVERAGE', 0.3, p.up], ['STALE FEED', still ? 0.8 : 0.5 + 0.4 * Math.abs(Math.sin(t * 0.7)), p.down]];
    bars.forEach(([l, v, c], i) => {
      text(g, l, LZ.x + 5, LZ.y + 5 + i * 12, p.textDim);
      rect(g, LZ.x + 60, LZ.y + 5 + i * 12, 94, 5, '#1c2630');
      rect(g, LZ.x + 60, LZ.y + 5 + i * 12, Math.round(94 * v), 5, c);
    });
    // 监控墙 2×3
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 3; c++) {
        const x = 420 + c * 46;
        const y = 24 + r * 38;
        frame(g, th, x, y, 42, 32, p.monFrame);
        rect(g, x + 3, y + 3, 36, 26, '#0a100c');
        for (let k = 0; k < 18; k++) px(g, x + 3 + hash(k + r * 7 + c * 3 + Math.floor(still ? 0 : t * 8)) * 36, y + 3 + hash(k * 3 + c) * 26, '#2a4a34');
        rect(g, x + 8 + c * 4, y + 12 + r * 3, 12, 10, '#1a3424');
        text(g, `CAM${r * 3 + c + 1}`, x + 4, y + 4, '#5a9a6a');
        if (!still && Math.floor(t * 1.5) % 2 === 0) px(g, x + 36, y + 5, '#ff3a3a');
      }
    // 警报灯
    const on = still || Math.sin(t * 5) > 0;
    rect(g, 404, 18, 10, 9, p.outline);
    rect(g, 405, 19, 8, 7, on ? p.down : shade(p.down, -0.6));
    if (on) {
      g.save();
      g.globalAlpha = 0.28;
      ellipse(g, 409, 23, 18, 12, p.down);
      g.restore();
    }
    void col;
  },
  exec(g, th, col, t, still) {
    const p = th.c;
    // 三地时钟
    frame(g, th, LZ.x, LZ.y, LZ.w, LZ.h, shade(p.wallDark, -0.25));
    ['NY', 'LDN', 'TKY'].forEach((city, i) => {
      const cx = LZ.x + 28 + i * 52;
      const cy = LZ.y + 24;
      ellipse(g, cx, cy, 15, 15, p.outline);
      ellipse(g, cx, cy, 14, 14, '#f4efe2');
      for (let k = 0; k < 12; k++) px(g, cx + Math.cos(k * 0.524) * 12, cy + Math.sin(k * 0.524) * 12, '#6a5a4a');
      const base = (still ? 0 : t * 0.2) + i * 1.3;
      const ha = base - 1.57;
      const ma = base * 12 - 1.57;
      for (let r = 0; r < 7; r++) px(g, cx + Math.cos(ha) * r, cy + Math.sin(ha) * r, '#1a1410');
      for (let r = 0; r < 11; r++) px(g, cx + Math.cos(ma) * r, cy + Math.sin(ma) * r, col);
      text(g, city, cx - textWidth(city) / 2, LZ.y + 45, p.text);
    });
  },
  market(g, th, col, t, still) {
    const p = th.c;
    // 粉笔价目板
    frame(g, th, LZ.x, LZ.y, LZ.w, LZ.h, '#1e2a22');
    text(g, 'TODAY MENU', LZ.x + 6, LZ.y + 5, '#f4efe2');
    const items: [string, string][] = [['BTC SIGNAL', '12U'], ['ETH SIGNAL', '9U'], ['SOL BREAKOUT', '15U']];
    items.forEach(([a, b], i) => {
      text(g, a, LZ.x + 6, LZ.y + 17 + i * 11, '#cfe8d0');
      text(g, b, LZ.x + LZ.w - 6 - textWidth(b), LZ.y + 17 + i * 11, '#ffe066');
    });
    if (!still && Math.sin(t * 2) > 0.3) text(g, 'NEW!', LZ.x + 118, LZ.y + 5, '#ff7a5c');
    void col;
  },
  audit(g, th, col, t, still) {
    const p = th.c;
    // 教训钉板
    frame(g, th, LZ.x, LZ.y, LZ.w, LZ.h, '#b88a52');
    text(g, 'LESSONS', LZ.x + 5, LZ.y + 4, '#4a2a08');
    const notes = ['#fff1a8', '#d8f4ff', '#ffd8de', '#eaffd8'];
    notes.forEach((c, i) => {
      const x = LZ.x + 6 + i * 38;
      const y = LZ.y + 14 + (i % 2) * 4;
      rect(g, x, y, 32, 32, c);
      for (let l = 0; l < 4; l++) hline(g, x + 3, y + 6 + l * 6, 20 + ((i + l) % 3) * 3, shade(c, -0.45));
      ellipse(g, x + 16, y + 2, 2, 2, '#c82030');
    });
    void col;
    void t;
    void still;
  },
  book(g, th, col, t, still) {
    const p = th.c;
    // 各币敞口柱状
    frame(g, th, LZ.x, LZ.y, LZ.w, LZ.h, '#0c0f0c');
    text(g, 'EXPOSURE BY COIN', LZ.x + 5, LZ.y + 4, p.textDim);
    const v: [string, number][] = DECO.byCoin;
    v.forEach(([s, k], i) => {
      const h = Math.round(30 * k * (still ? 1 : 0.92 + 0.08 * Math.sin(t * 1.5 + i)));
      const x = LZ.x + 8 + i * 30;
      rect(g, x, LZ.y + 44 - h, 16, h, i === 2 ? col : shade(col, -0.35));
      text(g, s, x, LZ.y + 47, p.text);
    });
  },
  thread(g, th, col, t, still) {
    const p = th.c;
    // 时间线
    frame(g, th, LZ.x, LZ.y, LZ.w, LZ.h, '#e8dcc0');
    text(g, 'SOL THESIS TIMELINE', LZ.x + 5, LZ.y + 4, '#4a2a08');
    hline(g, LZ.x + 8, LZ.y + 32, LZ.w - 16, '#6a4a2a');
    const pts = ['SETUP', 'ENTRY', 'ADD', 'EXIT?'];
    pts.forEach((s, i) => {
      const x = LZ.x + 14 + i * 42;
      const done = i < (still ? 3 : 1 + (Math.floor(t * 0.5) % 4));
      ellipse(g, x, LZ.y + 32, 3, 3, done ? '#d8283a' : '#9a8a70');
      text(g, s, x - 8, LZ.y + 40, '#4a2a08');
    });
    void p;
    void col;
  },
  helm(g, th, col, t, still) {
    const p = th.c;
    // 小世界地图 + 旗
    frame(g, th, LZ.x, LZ.y, LZ.w, LZ.h, '#0a1a24');
    for (let r = 0; r < 14; r++) for (let c = 0; c < 36; c++) if (WORLD[r + 2]?.[c] === '#') rect(g, LZ.x + 6 + c * 4.2, LZ.y + 6 + r * 3.2, 3, 2, '#1c4a5a');
    const pins: [number, number][] = [[40, 14], [84, 12], [128, 22], [118, 38]];
    pins.forEach(([x, y], i) => {
      const on = still || Math.sin(t * 3 + i) > -0.3;
      rect(g, LZ.x + x - 1, LZ.y + y - 1, 3, 3, on ? col : shade(col, -0.5));
    });
    // 旗帜
    const wave = still ? 0 : Math.round(Math.sin(t * 3));
    vline(g, 546, 20, 60, p.metalDark);
    rect(g, 547, 22 + wave, 18, 12, col);
    rect(g, 547, 22 + wave, 18, 2, shade(col, 0.3));
    text(g, 'TS', 550, 26 + wave, p.outline);
  },
};
