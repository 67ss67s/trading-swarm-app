/**
 * 工位:桌体(缓存)+ 显示器内容(每帧)+ 桌牌与「最近 14 天」进化灯板 + 椅子;市场台是带条纹雨棚的小铺子;门口信箱。
 */
import type { AgentStatus, EvoDay } from './types';
import type { Theme } from './themes';
import type { DeskSpot } from './layout';
import { roleMeta } from './roles';
import { box, dither, ellipse, hash, hline, makeCanvas, mix, px, rect, rgba, shade, text, textWidth, vline, type Ctx } from './pixel';
import { drawMug } from './sprites';

const deskCache = new Map<string, { cv: HTMLCanvasElement; ox: number; oy: number }>();

export const EVO_CELLS = 14;
export const EVO_CELL = 3;
export const EVO_GAP = 1;

/** 进化灯板的第 i 格(0 = 最早,13 = 今天)在世界坐标里的矩形 */
export function evoCellRect(d: DeskSpot, i: number): { x: number; y: number; w: number; h: number } {
  const total = EVO_CELLS * (EVO_CELL + EVO_GAP) - EVO_GAP;
  const x0 = Math.round(d.x - total / 2);
  return { x: x0 + i * (EVO_CELL + EVO_GAP), y: d.y + 10, w: EVO_CELL, h: EVO_CELL };
}

/** 桌牌(方块条标题)的矩形 */
export function plateRect(d: DeskSpot): { x: number; y: number; w: number; h: number } {
  const cs = roleMeta(d.role).callsign;
  const w = textWidth(cs) + 6;
  return { x: Math.round(d.x - w / 2), y: d.y + 2, w, h: 7 };
}

export function deskBaseline(d: DeskSpot): number {
  return d.y + 16;
}

function buildDesk(th: Theme, d: DeskSpot): { cv: HTMLCanvasElement; ox: number; oy: number } {
  const key = `${th.id}|${d.role}`;
  const hit = deskCache.get(key);
  if (hit) return hit;
  const p = th.c;
  const w = d.wide;
  const ox = Math.round(w / 2) + 6;
  const oy = 66;
  const [cv, g] = makeCanvas(w + 12, oy + 22);
  const X = ox - w / 2;
  const Y = oy; // 桌面前沿
  // 地面阴影
  g.save();
  g.globalAlpha = 0.35;
  rect(g, X - 2, Y + 16, w + 4, 3, '#000');
  g.restore();
  const kiosk = d.kind === 'kiosk';
  // 桌面
  rect(g, X - 1, Y - 13, w + 2, 30, p.outline);
  rect(g, X, Y - 12, w, 12, p.deskTop);
  hline(g, X, Y - 12, w, p.deskTopHi);
  for (let i = 3; i < w - 3; i += 11) hline(g, X + i, Y - 8 + (i % 3), 5, shade(p.deskTop, -0.06));
  hline(g, X, Y, w, p.deskTopHi);
  // 前挡板
  rect(g, X, Y + 1, w, 15, kiosk ? mix(roleMeta(d.role).color, p.deskFront, 0.55) : p.deskFront);
  hline(g, X, Y + 15, w, p.deskFrontDark);
  vline(g, X + 2, Y + 1, 15, p.deskFrontDark);
  vline(g, X + w - 3, Y + 1, 15, p.deskFrontDark);
  if (kiosk) for (let i = 4; i < w - 4; i += 8) rect(g, X + i, Y + 1, 4, 1, shade(p.deskFront, 0.2));
  // 灯板底座(进化方格的暗底)
  const total = EVO_CELLS * (EVO_CELL + EVO_GAP) - EVO_GAP;
  rect(g, Math.round(ox - total / 2) - 2, Y + 9, total + 4, 5, p.outline);
  // 桌牌底
  const cs = roleMeta(d.role).callsign;
  const pw = textWidth(cs) + 6;
  rect(g, Math.round(ox - pw / 2), Y + 2, pw, 7, p.outline);
  if (!kiosk) {
    // 两台显示器(屏幕内容每帧画)
    const mw = Math.floor(w / 2) - 16;
    for (const side of [-1, 1]) {
      const mx = side < 0 ? X + 3 : X + w - 3 - mw;
      rect(g, mx - 1, Y - 27, mw + 2, 16, p.outline);
      rect(g, mx, Y - 26, mw, 14, p.monFrame);
      hline(g, mx, Y - 26, mw, p.monFrameHi);
      rect(g, mx + mw / 2 - 1, Y - 12, 3, 3, p.monFrame);
      rect(g, mx + mw / 2 - 4, Y - 9, 9, 1, p.monFrameHi);
    }
    // 键盘
    rect(g, ox - 9, Y - 8, 18, 4, p.outline);
    rect(g, ox - 8, Y - 8, 16, 3, p.metalDark);
    for (let i = 0; i < 7; i++) px(g, ox - 7 + i * 2, Y - 7, p.metal);
    rect(g, ox + 11, Y - 7, 3, 2, p.metalDark);
    // 纸
    rect(g, X + 4, Y - 6, 7, 5, '#e8e0cc');
    rect(g, X + 5, Y - 7, 7, 5, '#f4efe2');
    hline(g, X + 6, Y - 5, 4, '#a09070');
    // 台灯
    const lx = X + w - 8;
    rect(g, lx, Y - 4, 5, 2, p.metalDark);
    vline(g, lx + 2, Y - 10, 6, p.metalDark);
    rect(g, lx - 1, Y - 13, 6, 3, p.lamp);
    hline(g, lx - 1, Y - 13, 6, shade(p.lamp, 0.3));
  } else {
    // 雨棚 + 立柱
    const col = roleMeta(d.role).color;
    vline(g, X + 2, Y - 44, 32, p.metalDark);
    vline(g, X + w - 3, Y - 44, 32, p.metalDark);
    rect(g, X - 3, Y - 50, w + 6, 8, p.outline);
    for (let i = 0; i < w + 4; i++) {
      const c = Math.floor(i / 6) % 2 ? '#f4efe2' : col;
      vline(g, X - 2 + i, Y - 49, 6, c);
      if (i % 6 < 4) px(g, X - 2 + i, Y - 43, c);
    }
    hline(g, X - 2, Y - 49, w + 4, 'rgba(255,255,255,0.35)');
    // 招牌
    rect(g, ox - 18, Y - 58, 36, 9, p.outline);
    rect(g, ox - 17, Y - 57, 34, 7, p.deskFrontDark);
    text(g, 'OKX.AI', ox - 11, Y - 56, col);
    // 柜台上的货:金币堆 + 信号卡 + 小屏
    for (let i = 0; i < 3; i++) {
      ellipse(g, X + 10 + i * 3, Y - 5 - i * 2, 3, 1, p.outline);
      ellipse(g, X + 10 + i * 3, Y - 6 - i * 2, 3, 1, '#ffcf4a');
    }
    for (let i = 0; i < 3; i++) {
      rect(g, X + w - 26 + i * 7, Y - 11, 6, 8, p.outline);
      rect(g, X + w - 25 + i * 7, Y - 10, 4, 6, ['#9be15d', '#ff7a5c', '#5ec8ff'][i]!);
    }
  }
  const out = { cv, ox, oy };
  deskCache.set(key, out);
  return out;
}

/** 椅子(在人后面) */
export function drawChair(g: Ctx, th: Theme, d: DeskSpot): void {
  if (d.kind === 'kiosk') return;
  const p = th.c;
  const x = d.seat.x;
  const y = d.seat.y;
  box(g, x - 10, y - 24, 20, 16, p.chair, p.chairHi, shade(p.chair, -0.3), p.outline);
  hline(g, x - 8, y - 22, 16, p.chairHi);
}

export interface DeskLive {
  status: AgentStatus;
  color: string;
  seated: boolean;
  typing: boolean;
  evo: EvoDay[];
  hoverEvo: number;
  highlight: number;
  mail: boolean;
}

/** 桌子 + 会动的部分 */
export function drawDesk(g: Ctx, th: Theme, d: DeskSpot, live: DeskLive, t: number, still: boolean): void {
  const p = th.c;
  const { cv, ox, oy } = buildDesk(th, d);
  const X0 = Math.round(d.x - ox);
  const Y0 = Math.round(d.y - oy);
  g.drawImage(cv, X0, Y0);
  const w = d.wide;
  const X = d.x - w / 2;
  const Y = d.y;
  const col = live.color;
  // 显示器屏幕
  if (d.kind !== 'kiosk') {
    const mw = Math.floor(w / 2) - 16;
    [-1, 1].forEach((side, k) => {
      const mx = side < 0 ? X + 3 : X + w - 3 - mw;
      drawScreen(g, th, Math.round(mx + 1), Y - 25, mw - 2, 12, live.status, col, t, hash(d.x * 3 + k) * 100, still, k);
    });
    // 屏幕的光溢到桌面
    g.save();
    g.globalAlpha = live.status === 'idle' ? 0.05 : 0.12;
    rect(g, X + 2, Y - 11, w - 4, 3, live.status === 'stuck' ? p.down : col);
    g.restore();
    // 打字的手
    if (live.seated && live.typing) {
      const f = still ? 0 : Math.floor(t * 10) % 4;
      const hc = shade(col, 0.05);
      rect(g, d.x - 7, Y - 9 - (f === 0 ? 1 : 0), 4, 3, p.outline);
      rect(g, d.x - 6, Y - 9 - (f === 0 ? 1 : 0), 3, 2, hc);
      rect(g, d.x + 3, Y - 9 - (f === 2 ? 1 : 0), 4, 3, p.outline);
      rect(g, d.x + 3, Y - 9 - (f === 2 ? 1 : 0), 3, 2, hc);
    }
    drawMug(g, X + 14, Y - 3, th.id === 'meme' ? '#ff9af0' : th.id === 'command' ? '#dfe6ee' : '#e8e0d0', t + d.x, !still && live.seated, p.outline);
  } else {
    // 小铺子:招财小屏
    const blink = still || Math.sin(t * 2 + d.x) > -0.4;
    if (blink) text(g, 'OKX.AI', d.x - 11, Y - 56, mix(col, '#ffffff', 0.35));
  }
  // 桌前 LED 条
  const ledOn = live.status === 'working' ? 1 : live.status === 'stuck' ? (still || Math.sin(t * 8) > 0 ? 1 : 0.2) : 0.45;
  g.save();
  g.globalAlpha = ledOn;
  hline(g, X + 3, Y + 1, w - 6, live.status === 'stuck' ? p.down : col);
  g.restore();
  // 桌牌
  const cs = roleMeta(d.role).callsign;
  const pr = plateRect(d);
  if (live.highlight > 0) {
    g.save();
    g.globalAlpha = 0.5 + 0.5 * live.highlight;
    rect(g, pr.x - 1, pr.y - 1, pr.w + 2, pr.h + 2, col);
    g.restore();
    rect(g, pr.x, pr.y, pr.w, pr.h, p.outline);
  }
  text(g, cs, pr.x + 3, pr.y + 1, col);
  // 进化灯板
  drawEvoStrip(g, th, d, live.evo, live.hoverEvo, t, still);
  // 未取的信封
  if (live.mail) {
    const bob = still ? 0 : Math.round(Math.sin(t * 4));
    rect(g, d.x - 22, Y - 18 + bob, 8, 6, p.outline);
    rect(g, d.x - 21, Y - 17 + bob, 6, 4, '#fff6e0');
    px(g, d.x - 18, Y - 16 + bob, col);
  }
}

export function drawEvoStrip(g: Ctx, th: Theme, d: DeskSpot, days: EvoDay[], hover: number, t: number, still: boolean): void {
  const last = days.slice(-EVO_CELLS);
  for (let i = 0; i < EVO_CELLS; i++) {
    const day = last[i];
    const r = evoCellRect(d, i);
    drawEvoCell(g, th, r.x, r.y, EVO_CELL, day?.status ?? 'none', i === EVO_CELLS - 1, i === hover, t, still);
  }
}

/** 一格进化方块:颜色 + 色盲辅助形状(bad 小叉,good 高光),今天那格呼吸 */
export function drawEvoCell(g: Ctx, th: Theme, x: number, y: number, s: number, status: EvoDay['status'], today: boolean, hover: boolean, t: number, still: boolean): void {
  const c = th.evo[status];
  let col = c;
  if (today && !still) col = mix(c, '#ffffff', 0.15 + 0.3 * (0.5 + 0.5 * Math.sin(t * 4)));
  rect(g, x, y, s, s, col);
  if (status === 'good') px(g, x, y, mix(c, '#ffffff', 0.7));
  if (status === 'bad') {
    const dk = shade(c, -0.6);
    if (s === 3) {
      px(g, x, y, dk);
      px(g, x + 2, y, dk);
      px(g, x + 1, y + 1, dk);
      px(g, x, y + 2, dk);
      px(g, x + 2, y + 2, dk);
    } else {
      for (let i = 1; i < s - 1; i++) {
        px(g, x + i, y + i, dk);
        px(g, x + s - 1 - i, y + i, dk);
      }
    }
  }
  if (status === 'none' && s > 4) dither(g, x, y, s, s, shade(c, -0.3));
  if (today) {
    g.save();
    g.globalAlpha = still ? 0.6 : 0.35 + 0.35 * Math.sin(t * 4);
    rect(g, x - 1, y - 1, s + 2, 1, '#ffffff');
    rect(g, x - 1, y + s, s + 2, 1, '#ffffff');
    g.restore();
  }
  if (hover) {
    rect(g, x - 1, y - 1, s + 2, 1, '#ffffff');
    rect(g, x - 1, y + s, s + 2, 1, '#ffffff');
    rect(g, x - 1, y, 1, s, '#ffffff');
    rect(g, x + s, y, 1, s, '#ffffff');
  }
}

function drawScreen(g: Ctx, th: Theme, x: number, y: number, w: number, h: number, status: AgentStatus, col: string, t: number, seed: number, still: boolean, k: number): void {
  const p = th.c;
  if (status === 'stuck') {
    const on = still || Math.sin(t * 6) > -0.2;
    rect(g, x, y, w, h, on ? '#3a0a12' : '#1a0508');
    if (on) {
      text(g, '!', x + w / 2 - 1, y + 3, p.down);
      hline(g, x + 2, y + h - 3, w - 4, shade(p.down, -0.3));
    }
    return;
  }
  rect(g, x, y, w, h, p.screen);
  if (status === 'idle') {
    // 屏保:弹跳像素
    const T = still ? 3 : t;
    const bx = Math.abs(((T * 7 + seed) % (2 * (w - 2))) - (w - 2));
    const by = Math.abs(((T * 5 + seed) % (2 * (h - 2))) - (h - 2));
    px(g, x + bx, y + by, shade(col, -0.2));
    return;
  }
  if (status === 'waiting') {
    const n = still ? 3 : Math.floor(t * 2) % 4;
    for (let i = 0; i < n; i++) px(g, x + 3 + i * 2, y + h - 4, col);
    hline(g, x + 2, y + 2, Math.floor(w * 0.6), p.screenLine);
    hline(g, x + 2, y + 4, Math.floor(w * 0.4), p.screenLine);
    return;
  }
  // 干活:曲线跳动 + 文本行
  const shift = still ? 0 : t * 6;
  if (k === 0) {
    for (let i = 0; i < w - 2; i++) {
      const v = Math.sin((i + shift) * 0.5 + seed) * 2 + Math.sin((i + shift) * 0.17 + seed * 2) * 2.5;
      const yy = y + h / 2 + v;
      px(g, x + 1 + i, yy, col);
      if (i % 3 === 0) px(g, x + 1 + i, y + h - 2, shade(col, -0.5));
    }
  } else {
    const rowsN = Math.floor((h - 2) / 2);
    for (let r = 0; r < rowsN; r++) {
      const L = Math.floor(hash(r + Math.floor(shift / 3) + seed) * (w - 4)) + 2;
      hline(g, x + 2, y + 1 + r * 2, L, r % 3 === 0 ? col : p.screenLine);
    }
    if (!still && Math.sin(t * 8) > 0) px(g, x + w - 3, y + h - 3, '#ffffff');
  }
  // 扫描线闪
  if (!still) {
    const sy = Math.floor((t * 9 + seed) % (h * 3));
    if (sy < h) {
      g.save();
      g.globalAlpha = 0.18;
      hline(g, x, y + sy, w, '#ffffff');
      g.restore();
    }
  }
  // 屏幕外发光
  g.save();
  g.globalAlpha = 0.08;
  rect(g, x - 1, y - 1, w + 2, h + 2, col);
  g.restore();
}

// ---------------- 你的信箱(待批订单 = 金信封) ----------------
export const MAILBOX = { x: 321, y: 336 };

export function mailboxRect(): { x: number; y: number; w: number; h: number } {
  return { x: MAILBOX.x - 10, y: MAILBOX.y - 34, w: 20, h: 34 };
}

export function drawMailbox(g: Ctx, th: Theme, count: number, t: number, still: boolean, hover: boolean): void {
  const p = th.c;
  const { x, y } = MAILBOX;
  g.save();
  g.globalAlpha = 0.35;
  ellipse(g, x, y, 8, 2, '#000');
  g.restore();
  rect(g, x - 2, y - 16, 4, 16, p.outline);
  rect(g, x - 1, y - 16, 2, 16, p.metal);
  // 箱体
  rect(g, x - 9, y - 28, 18, 13, p.outline);
  rect(g, x - 8, y - 27, 16, 11, count ? '#b8862a' : p.metalHi);
  hline(g, x - 8, y - 27, 16, count ? '#ffd76a' : shade(p.metalHi, 0.3));
  rect(g, x - 6, y - 24, 12, 2, p.outline);
  text(g, 'YOU', x - 5, y - 21, count ? '#3a2408' : p.outline);
  // 小旗
  const up = count > 0;
  rect(g, x + 8, up ? y - 34 : y - 26, 1, up ? 8 : 4, p.outline);
  rect(g, x + 9, up ? y - 34 : y - 26, 4, 3, '#ff4a4a');
  // 顶灯
  const on = count > 0 && (still || Math.sin(t * 6) > 0);
  rect(g, x - 2, y - 31, 4, 3, p.outline);
  rect(g, x - 1, y - 30, 2, 2, on ? '#ffe066' : shade(p.metal, -0.2));
  if (on) {
    g.save();
    g.globalAlpha = 0.3;
    ellipse(g, x, y - 29, 7, 5, '#ffe066');
    g.restore();
  }
  // 塞在口里的金信封
  if (count > 0) {
    const bob = still ? 0 : Math.round(Math.sin(t * 3));
    rect(g, x - 6, y - 38 + bob, 12, 9, p.outline);
    rect(g, x - 5, y - 37 + bob, 10, 7, '#ffcf4a');
    hline(g, x - 5, y - 37 + bob, 10, '#fff0b0');
    px(g, x - 4, y - 36 + bob, '#b8862a');
    px(g, x - 3, y - 35 + bob, '#b8862a');
    px(g, x - 2, y - 34 + bob, '#b8862a');
    px(g, x + 1, y - 34 + bob, '#b8862a');
    px(g, x + 2, y - 35 + bob, '#b8862a');
    px(g, x + 3, y - 36 + bob, '#b8862a');
    if (count > 1) text(g, String(Math.min(9, count)), x + 7, y - 40 + bob, '#ffe066');
    g.fillStyle = rgba('#ffe066', hover ? 0.5 : 0.25);
    g.fillRect(x - 7, y - 39 + bob, 14, 1);
  }
  if (hover) {
    rect(g, x - 10, y - 42, 20, 1, '#ffffff');
  }
}
