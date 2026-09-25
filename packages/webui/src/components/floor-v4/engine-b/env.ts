/**
 * 环境层:天空(色带抖动 / 星星 / 月亮 / 飞艇 / 探照灯)、城市天际线(离屏缓存 + 窗灯闪)、雨、街道(路灯 / 过路车)、
 * 大楼外壳(外墙 / 楼板 / 电梯井 / 屋顶圆顶 / 雷达天线 / 招牌 / 侧楼招牌与遮阳棚)。
 */
import type { Layout } from './layout';
import type { Theme } from './themes';
import { hash, q } from './props';
import { R, P, line, disc, glow, lightCone, text, textW, shade, rgba, mix, type Ctx } from './sprites';

// ---------- 天空 ----------
export function drawSky(ctx: Ctx, L: Layout, th: Theme, t: number, reduced: boolean, night = true, overcast = false): void {
  const bands = night ? th.sky : th.skyDay;
  const n = bands.length;
  const H = L.groundY;
  const bandH = Math.ceil(H / n);
  for (let i = 0; i < n; i++) R(ctx, 0, i * bandH, L.LW, bandH + 1, overcast ? mix(bands[i]!, '#4a4f5c', 0.45) : bands[i]!);
  // 色带之间 2 行棋盘抖动
  for (let i = 1; i < n; i++) {
    const y0 = i * bandH;
    ctx.fillStyle = overcast ? mix(bands[i - 1]!, '#4a4f5c', 0.45) : bands[i - 1]!;
    for (let y = y0; y < y0 + 2; y++) for (let x = (y % 2); x < L.LW; x += 2) ctx.fillRect(x, y, 1, 1);
  }
  // 星星
  for (let i = 0; i < (night && !overcast ? 70 : 0); i++) {
    const x = Math.floor(hash(i * 3.1) * L.LW);
    const y = Math.floor(hash(i * 7.7) * H * 0.6);
    const tw = reduced ? 1 : Math.sin(t * (0.6 + hash(i) * 2) + i);
    if (tw > 0.2) P(ctx, x, y, tw > 0.85 ? th.stars : rgba(th.stars, 0.55));
  }
  // 月亮
  if (!night && !overcast) {
    const sx = Math.round(L.LW * 0.12), sy = 32;
    glow(ctx, sx, sy, 26, '#fff2b0', 0.22);
    disc(ctx, sx, sy, 10, '#fff6c8');
    disc(ctx, sx, sy, 8, '#ffe98a');
  }
  if (overcast) {
    // 乌云
    for (let i = 0; i < 7; i++) {
      const cx = ((i * 83 + (reduced ? 0 : t * 3)) % (L.LW + 80)) - 40, cy = 14 + (i % 3) * 12;
      for (let k = 0; k < 4; k++) disc(ctx, cx + k * 9, cy + (k % 2) * 3, 7 + (k % 2) * 2, mix('#3a3e4a', '#262a33', (i % 3) / 3));
    }
  }
  if (th.moon && night && !overcast) {
    const mx = Math.round(L.LW * 0.12), my = 30;
    glow(ctx, mx, my, 22, th.moon, 0.14);
    disc(ctx, mx, my, 9, th.moon);
    disc(ctx, mx + 3, my - 2, 2, shade(th.moon, -0.12));
    disc(ctx, mx - 3, my + 3, 1, shade(th.moon, -0.12));
    P(ctx, mx + 1, my + 5, shade(th.moon, -0.12));
  }
  // 探照灯
  if (th.searchlights) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 2; k++) {
      const bx = k === 0 ? L.LW * 0.14 : L.LW * 0.88;
      const a = -Math.PI / 2 + Math.sin(t * 0.35 + k * 2) * 0.55;
      const len = H * 1.1;
      ctx.fillStyle = 'rgba(120,200,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(bx, L.groundY);
      ctx.lineTo(bx + Math.cos(a - 0.05) * len, L.groundY + Math.sin(a - 0.05) * len);
      ctx.lineTo(bx + Math.cos(a + 0.05) * len, L.groundY + Math.sin(a + 0.05) * len);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  // 飞艇
  if (th.blimp) {
    const span = L.LW + 90;
    // 来回飘,始终留在画面里(不再从边缘切出去)
    const bx = Math.round(8 + (L.LW - 64) * (reduced ? 0.3 : 0.5 - 0.5 * Math.cos(t * 0.05)));
    void span;
    const by = 22 + Math.round(Math.sin(t * 0.5) * 1);
    R(ctx, bx + 3, by - 1, 34, 13, th.outline);
    R(ctx, bx + 1, by + 2, 38, 7, th.outline);
    R(ctx, bx + 4, by, 32, 11, '#c23aa8');
    R(ctx, bx + 2, by + 3, 36, 5, '#c23aa8');
    R(ctx, bx + 4, by, 32, 2, '#ff7ae6');
    R(ctx, bx + 4, by + 9, 32, 2, '#7a1f6a');
    text(ctx, 'HIGHER', bx + 9, by + 3, '#ffe9ff');
    R(ctx, bx + 16, by + 12, 8, 3, '#39f0ff');
    R(ctx, bx - 2, by + 2, 4, 7, '#ff4fd8');
  }
}

// ---------- 天际线(缓存) ----------
interface Skyline { cv: HTMLCanvasElement; wins: { x: number; y: number; c: string }[] }
const skyCache = new Map<string, Skyline>();
function buildSkyline(L: Layout, th: Theme): Skyline {
  const cv = document.createElement('canvas');
  cv.width = L.LW;
  cv.height = L.LH;
  const c = cv.getContext('2d')!;
  const wins: Skyline['wins'] = [];
  const layers: [string, number, number, number][] = [
    [th.cityFar, 0.55, 12, 0.25],
    [th.cityNear, 0.4, 7, 0.55],
  ];
  layers.forEach(([col, hMax, seed, lit], li) => {
    let x = -4;
    let k = 0;
    while (x < L.LW) {
      const w = 14 + Math.floor(hash(seed + k) * 22);
      const h = Math.floor((0.25 + hash(seed + k * 3.3) * 0.75) * L.groundY * hMax);
      const top = L.groundY - h;
      R(c, x, top, w, h, col);
      R(c, x, top, w, 1, shade(col, 0.18));
      // 屋顶细节
      if (hash(k + seed * 2) > 0.6) { R(c, x + 3, top - 4, 1, 4, col); P(c, x + 3, top - 5, '#ff4040'); }
      if (hash(k + seed * 5) > 0.7) { R(c, x + w - 8, top - 5, 5, 5, col); R(c, x + w - 8, top - 5, 5, 1, shade(col, 0.2)); }
      // 窗
      for (let wy = top + 3; wy < L.groundY - 3; wy += 4) {
        for (let wx = x + 2; wx < x + w - 2; wx += 3) {
          const hv = hash(wx * 1.3 + wy * 7.1 + li * 99);
          if (hv < lit) {
            const wc = th.cityWin[Math.floor(hash(wx + wy) * th.cityWin.length)]!;
            const cc = li === 0 ? rgba(wc, 0.45) : wc;
            c.fillStyle = cc;
            c.fillRect(wx, wy, li === 0 ? 1 : 2, li === 0 ? 1 : 2);
            if (li === 1 && hv < 0.04) wins.push({ x: wx, y: wy, c: wc });
          } else if (li === 1) {
            c.fillStyle = shade(col, 0.08);
            c.fillRect(wx, wy, 2, 2);
          }
        }
      }
      x += w + Math.floor(hash(seed + k * 9) * 5);
      k++;
    }
  });
  return { cv, wins };
}
export function drawCity(ctx: Ctx, L: Layout, th: Theme, t: number, reduced: boolean, night = true): void {
  const key = `${th.id}|${L.LW}|${L.LH}`;
  let s = skyCache.get(key);
  if (!s) { s = buildSkyline(L, th); skyCache.set(key, s); }
  ctx.drawImage(s.cv, 0, 0);
  if (!night) {
    // 白天:楼体被天光洗亮、窗灯变暗
    ctx.fillStyle = rgba(th.skyDay[2]!, 0.38);
    ctx.fillRect(0, 0, L.LW, L.groundY);
    return;
  }
  if (reduced) return;
  // 一些窗户慢慢开关灯
  s.wins.forEach((w, i) => {
    const on = Math.sin(t * 0.25 + i * 1.7) > 0;
    R(ctx, w.x, w.y, 2, 2, on ? w.c : shade(th.cityNear, 0.08));
  });
}

// ---------- 雨 ----------
export function drawRain(ctx: Ctx, L: Layout, rain: boolean, t: number, reduced: boolean): void {
  if (!rain || reduced) return;
  ctx.fillStyle = 'rgba(170,190,255,0.28)';
  const H = L.groundY + 6;
  for (let i = 0; i < 140; i++) {
    const sp = 150 + hash(i) * 60;
    const y = ((t * sp + hash(i * 3) * H) % H);
    const x = ((hash(i * 7) * (L.LW + 40)) - y * 0.22 + L.LW) % (L.LW + 20) - 10;
    ctx.fillRect(Math.round(x), Math.round(y), 1, 3);
  }
  // 地面溅水
  ctx.fillStyle = 'rgba(200,215,255,0.45)';
  for (let i = 0; i < 10; i++) {
    const ph = (t * 1.7 + hash(i * 5)) % 1;
    if (ph > 0.25) continue;
    const x = Math.floor(hash(i * 13 + Math.floor(t * 1.7 + hash(i * 5))) * L.LW);
    ctx.fillRect(x - 1, L.groundY + 2, 1, 1);
    ctx.fillRect(x + 1, L.groundY + 2, 1, 1);
    ctx.fillRect(x, L.groundY + 1, 1, 1);
  }
}

// ---------- 街道 ----------
export function drawStreet(ctx: Ctx, L: Layout, th: Theme, t: number, reduced: boolean): void {
  const g = L.groundY;
  R(ctx, 0, g, L.LW, 6, th.street.walk);
  for (let x = 0; x < L.LW; x += 8) R(ctx, x, g, 1, 5, shade(th.street.walk, -0.18));
  R(ctx, 0, g, L.LW, 1, shade(th.street.walk, 0.2));
  R(ctx, 0, g + 5, L.LW, 1, shade(th.street.walk, -0.35));
  R(ctx, 0, g + 6, L.LW, L.LH - g - 6, th.street.road);
  for (let x = 0; x < L.LW; x += 14) R(ctx, x + 2, g + 14, 7, 1, rgba(th.street.line, 0.6));
  // 路灯
  const lamps = [L.mainX - 74, L.mainX - 150, L.wingX + L.wingW + 40, L.wingX + L.wingW + 118].filter((x) => x > 4 && x < L.LW - 4);
  for (const x of lamps) {
    R(ctx, x, g - 26, 1, 26, th.metal.dark);
    R(ctx, x, g - 26, 5, 1, th.metal.dark);
    R(ctx, x + 3, g - 25, 4, 2, th.metal.b);
    R(ctx, x + 4, g - 23, 2, 1, th.street.lamp);
    R(ctx, x - 1, g - 1, 3, 1, th.metal.b);
  }
  // 过路车(两条车道)
  const cars: [number, number, 1 | -1, string][] = [[17, 0, 1, '#d64f3c'], [23, 9, -1, '#3c7fd6']];
  for (const [period, off, dir, col] of cars) {
    const ph = reduced ? -1 : ((t + off) % period) / period;
    if (ph < 0 || ph > 0.5) continue;
    const span = L.LW + 80;
    const x = dir === 1 ? Math.round(ph * 2 * span - 40) : Math.round(L.LW + 40 - ph * 2 * span);
    const y = dir === 1 ? g + 16 : g + 9;
    R(ctx, x - 1, y - 6, 24, 8, th.outline);
    R(ctx, x, y - 3, 22, 4, col);
    R(ctx, x + 4, y - 5, 12, 2, shade(col, -0.2));
    R(ctx, x + 5, y - 5, 4, 2, '#9fd4ff');
    R(ctx, x + 10, y - 5, 5, 2, '#9fd4ff');
    R(ctx, x + 3, y, 3, 2, '#111');
    R(ctx, x + 16, y, 3, 2, '#111');
    const hx = dir === 1 ? x + 21 : x;
    const tx = dir === 1 ? x : x + 21;
    P(ctx, hx, y - 2, '#fff6c0');
    P(ctx, tx, y - 2, '#ff3030');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,240,180,0.12)';
    for (let k = 0; k < 18; k++) ctx.fillRect(hx + dir * k, y - 2 - Math.floor(k / 5), 1, 1 + Math.floor(k / 2.5));
    ctx.restore();
  }
}
export function drawStreetGlow(ctx: Ctx, L: Layout, th: Theme): void {
  const g = L.groundY;
  const lamps = [L.mainX - 74, L.mainX - 150, L.wingX + L.wingW + 40, L.wingX + L.wingW + 118].filter((x) => x > 4 && x < L.LW - 4);
  for (const x of lamps) {
    lightCone(ctx, x + 5, g - 22, g + 4, 3, 26, th.street.lamp, 0.07);
    glow(ctx, x + 5, g - 23, 6, th.street.lamp, 0.35);
  }
}

// ---------- 大楼外壳 ----------
function facadeFill(ctx: Ctx, x: number, y: number, w: number, h: number, th: Theme): void {
  const f = th.facade;
  R(ctx, x, y, w, h, f.base);
  if (f.pattern === 'brick') {
    for (let yy = y; yy < y + h; yy += 3) {
      R(ctx, x, yy, w, 1, f.dark);
      const off = (Math.floor((yy - y) / 3) % 2) * 3;
      for (let xx = x + off; xx < x + w; xx += 6) P(ctx, xx, yy + 1, f.dark);
    }
  } else if (f.pattern === 'panel') {
    for (let yy = y; yy < y + h; yy += 8) R(ctx, x, yy, w, 1, f.dark);
    R(ctx, x + 1, y, 1, h, f.light);
  } else {
    for (let yy = y; yy < y + h; yy += 4) for (let xx = x + ((yy / 4) % 2) * 2; xx < x + w; xx += 4) P(ctx, xx, yy, f.light);
  }
  R(ctx, x, y, 1, h, th.outline);
  R(ctx, x + w - 1, y, 1, h, th.outline);
}

function slab(ctx: Ctx, x: number, y: number, w: number, th: Theme, L: Layout): void {
  R(ctx, x, y, w, L.slab, th.slab.face);
  R(ctx, x, y, w, 1, th.slab.top);
  R(ctx, x, y + L.slab - 1, w, 1, th.slab.dark);
  for (let xx = x + 3; xx < x + w; xx += 12) P(ctx, xx, y + 2, th.slab.dark);
}

export function drawShellBack(ctx: Ctx, L: Layout, th: Theme): void {
  // 大楼背后投影
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(L.mainX + 4, L.towerTop + 4, L.mainW + L.shaftW + L.wingW, L.groundY - L.towerTop);
  // 电梯井内壁
  const sx = L.shaftX, sw = L.shaftW;
  R(ctx, sx, L.towerTop, sw, L.groundY - L.towerTop, shade(th.facade.dark, -0.35));
  R(ctx, sx + 3, L.towerTop, 1, L.groundY - L.towerTop, th.metal.dark);
  R(ctx, sx + sw - 4, L.towerTop, 1, L.groundY - L.towerTop, th.metal.dark);
  for (let y = L.towerTop; y < L.groundY; y += 6) { P(ctx, sx + 3, y, th.metal.b); P(ctx, sx + sw - 4, y, th.metal.b); }
}

export function drawShellFront(ctx: Ctx, L: Layout, th: Theme, t: number, cabLevel: number, reduced: boolean, lobbyOpen = false): void {
  const f = th.facade;
  // 主楼左外墙
  facadeFill(ctx, L.mainX, L.towerTop, L.wall, L.groundY - L.towerTop, th);
  // 底层大堂门(外来的信封 / 审批从这里进楼)
  const dx = L.mainX - 1, dw = L.wall + 2, dh = 22, dy = L.groundY - dh;
  R(ctx, dx - 1, dy - 1, dw + 2, dh + 1, th.outline);
  R(ctx, dx, dy, dw, dh, f.trim);
  if (lobbyOpen) {
    R(ctx, dx + 1, dy + 1, dw - 2, dh - 1, '#0c0a08');
    glow(ctx, L.mainX + 2, L.groundY - 10, 10, th.light, 0.35);
  } else {
    R(ctx, dx + 1, dy + 1, dw - 2, dh - 1, shade(th.desk.face, -0.1));
    R(ctx, dx + 2, dy + 3, dw - 4, 6, rgba('#9fd4ff', 0.35));
    P(ctx, dx + dw - 2, dy + 13, '#ffd23a');
  }
  // 门楣小雨棚 + 门灯
  R(ctx, dx - 7, dy - 4, dw + 8, 2, th.outline);
  R(ctx, dx - 6, dy - 4, dw + 6, 1, f.trim);
  R(ctx, dx - 5, dy - 1, 2, 2, th.street.lamp);
  if (!reduced) glow(ctx, dx - 4, dy, 6, th.street.lamp, 0.3);
  // 侧楼右外墙(L1–L3;L0 是临街橱窗)
  const wr = L.wingX + L.wingW - L.wall;
  facadeFill(ctx, wr, L.wingTop, L.wall, L.floorY(1) - L.wingTop, th);
  // 电梯井在侧楼屋顶以上露出的外墙
  facadeFill(ctx, L.shaftX + L.shaftW - 3, L.towerTop, 3, L.wingTop - L.towerTop, th);
  // 井壁(每层门洞上方的隔断)
  for (let l = 0; l < 6; l++) {
    const fy = L.floorY(l);
    const ceil = L.floorY(l + 1) + L.slab;
    const doorTop = fy - 18;
    R(ctx, L.shaftX, ceil, 2, doorTop - ceil, f.dark);
    R(ctx, L.shaftX + 1, ceil, 1, doorTop - ceil, f.light);
    if (l <= 4) {
      const bottom = l === 3 ? fy : doorTop; // L3 是指挥层上半截,没有门洞
      R(ctx, L.shaftX + L.shaftW - 2, ceil, 2, bottom - ceil, f.dark);
    }
    // 楼层指示灯
    const lit = Math.round(cabLevel) === l;
    R(ctx, L.shaftX + L.shaftW / 2 - 3, ceil + 1, 7, 3, th.outline);
    P(ctx, L.shaftX + L.shaftW / 2 - 2, ceil + 2, lit ? '#ffde6b' : '#3a3a3a');
    text(ctx, String(l + 1), L.shaftX + L.shaftW / 2, ceil + 1, lit ? '#ffde6b' : '#6a6a6a');
  }
  // 楼板
  for (let l = 1; l <= 6; l++) {
    const y = L.floorY(l);
    const w = l <= 4 && l !== 3 ? L.mainW + L.shaftW + L.wingW : L.mainW + L.shaftW; // L3 楼板不穿过双层指挥层
    slab(ctx, L.mainX, y, w, th, L);
  }
  slab(ctx, L.mainX, L.groundY, L.mainW + L.shaftW + L.wingW, th, L);
  // 主楼屋顶女儿墙
  const top = L.towerTop;
  R(ctx, L.mainX - 1, top - 4, L.mainW + L.shaftW + 2, 4, th.outline);
  R(ctx, L.mainX, top - 3, L.mainW + L.shaftW, 3, f.light);
  R(ctx, L.mainX, top - 3, L.mainW + L.shaftW, 1, f.trim);
  // 机房(电梯井顶)
  R(ctx, L.shaftX - 1, top - 15, L.shaftW + 2, 12, th.outline);
  R(ctx, L.shaftX, top - 14, L.shaftW, 11, f.base);
  R(ctx, L.shaftX, top - 14, L.shaftW, 1, f.light);
  R(ctx, L.shaftX + 4, top - 11, 5, 5, th.metal.dark);
  const spin = reduced ? 0 : Math.floor(t * 8) % 4;
  P(ctx, L.shaftX + 5 + (spin % 2) * 2, top - 10 + Math.floor(spin / 2) * 2, th.metal.a);
  R(ctx, L.shaftX + 12, top - 11, 6, 3, '#1a1a1a');
  P(ctx, L.shaftX + 13, top - 10, Math.floor(t * 2) % 2 ? '#5dff8f' : '#1f4d2d');

  // 招牌 TRADING SWARM(屋顶中段)
  const sign = 'TRADING SWARM';
  const sw = textW(sign) + 8;
  const sx = Math.round(L.mainX + L.mainW * 0.5 - sw / 2);
  const sy = top - 22;
  R(ctx, sx + 4, sy + 11, 1, 8, th.metal.dark);
  R(ctx, sx + sw - 5, sy + 11, 1, 8, th.metal.dark);
  R(ctx, sx - 1, sy - 1, sw + 2, 13, th.outline);
  R(ctx, sx, sy, sw, 11, shade(f.dark, -0.3));
  const flick = !reduced && hash(Math.floor(t * 4)) > 0.95;
  text(ctx, sign, sx + 4, sy + 3, flick ? shade(th.neon[0], -0.6) : th.neon[0]);

  // 侧楼屋顶栏杆(茶水间)
  const ty = L.wingTop;
  const rx0 = L.wingX, rx1 = L.wingX + L.wingW - 1;
  R(ctx, rx0, ty - 9, rx1 - rx0, 1, th.metal.b);
  for (let x = rx0 + 2; x < rx1; x += 6) R(ctx, x, ty - 9, 1, 9, th.metal.dark);
  R(ctx, rx1 - 1, ty - 9, 1, 9, th.metal.b);

  // 临街橱窗(侧楼底层右侧)
  const gx = wr, gy = L.floorY(1) + L.slab, gh = L.groundY - gy;
  R(ctx, gx, gy, L.wall, gh, th.outline);
  R(ctx, gx + 1, gy, L.wall - 2, gh, rgba('#9fd4ff', 0.18));
  R(ctx, gx + 2, gy + 2, 1, gh - 6, rgba('#ffffff', 0.25));
  // 遮阳棚(条纹)
  const ay = gy + 1;
  for (let i = 0; i < 18; i++) {
    const c = Math.floor(i / 3) % 2 ? '#f2efe6' : '#e0485a';
    R(ctx, gx - 2 + i, ay + Math.floor(i / 3), 1, 3, c);
  }
  R(ctx, gx - 2, ay + 3, 18, 1, th.outline);
  for (let i = 0; i < 18; i += 3) P(ctx, gx - 1 + i, ay + 7 + (i / 3 >= 5 ? 0 : 0) - 1 + Math.floor(i / 3) - 3, '#e0485a');
  // 立牌
  const bx = gx + 20, by = L.groundY;
  if (bx < L.LW - 10) {
    line(ctx, bx, by - 1, bx + 3, by - 12, th.outline);
    line(ctx, bx + 9, by - 1, bx + 6, by - 12, th.outline);
    R(ctx, bx + 1, by - 11, 8, 8, '#2a2a2a');
    R(ctx, bx + 2, by - 10, 6, 1, '#7fd1ff');
    R(ctx, bx + 2, by - 8, 4, 1, '#f2efe6');
    R(ctx, bx + 2, by - 6, 5, 1, '#f2efe6');
  }
}

/** 电梯轿厢(含乘客由 render 画) */
export function drawCab(ctx: Ctx, L: Layout, th: Theme, cabY: number, doorOpen: boolean, ding: number): { x: number; y: number; w: number; h: number } {
  const w = L.shaftW - 6;
  const h = L.floorH - L.slab - 3;
  const x = L.shaftX + 3;
  const y = Math.round(cabY - h);
  // 缆绳
  R(ctx, x + Math.floor(w / 2), L.towerTop, 1, y - L.towerTop, th.metal.dark);
  R(ctx, x - 1, y - 1, w + 2, h + 2, th.outline);
  R(ctx, x, y, w, h, shade(th.metal.b, -0.1));
  R(ctx, x + 1, y + 2, w - 2, h - 3, doorOpen ? shade(th.light, -0.2) : shade(th.light, -0.45));
  R(ctx, x, y, w, 2, th.metal.a);
  R(ctx, x, y + h - 1, w, 1, th.metal.dark);
  if (ding > 0) P(ctx, x + Math.floor(w / 2), y - 2, '#ffde6b');
  return { x, y, w, h };
}
export function drawCabDoors(ctx: Ctx, cab: { x: number; y: number; w: number; h: number }, th: Theme, open: boolean): void {
  if (open) return;
  // 半透明玻璃门
  ctx.fillStyle = rgba(th.metal.a, 0.28);
  ctx.fillRect(cab.x + 1, cab.y + 2, cab.w - 2, cab.h - 3);
  R(ctx, cab.x + Math.floor(cab.w / 2), cab.y + 2, 1, cab.h - 3, rgba(th.outline, 0.6));
}

/** 屋顶:雷达圆顶(天文台)+ 旋转雷达天线 + 航空灯 */
export function drawRoof(ctx: Ctx, L: Layout, th: Theme, t: number, color: string, reduced: boolean): void {
  const top = L.towerTop - 3;
  const dx = L.mainX + 30, dr = 17;
  // 圆顶
  for (let yy = -dr; yy <= 0; yy++) {
    const w = Math.floor(Math.sqrt(dr * dr - yy * yy));
    R(ctx, dx - w - 1, top + yy - 1, w * 2 + 3, 1, th.outline);
  }
  for (let yy = -dr + 1; yy <= 0; yy++) {
    const w = Math.floor(Math.sqrt((dr - 1) * (dr - 1) - yy * yy));
    R(ctx, dx - w, top + yy, w * 2 + 1, 1, yy < -dr * 0.55 ? th.metal.a : th.metal.b);
    P(ctx, dx - w, top + yy, shade(th.metal.a, 0.3));
    P(ctx, dx + w, top + yy, th.metal.dark);
  }
  // 圆顶缝 + 伸出的望远镜
  const slitX = dx + (reduced ? 0 : Math.round(Math.sin(t * 0.2) * 5));
  R(ctx, slitX - 2, top - dr + 2, 4, dr - 3, '#0c0f1a');
  line(ctx, slitX, top - 6, slitX + 7, top - dr - 4, th.metal.a);
  line(ctx, slitX + 1, top - 6, slitX + 8, top - dr - 4, th.metal.dark);
  R(ctx, dx - dr, top, dr * 2 + 1, 1, th.metal.dark);
  // 雷达天线(旋转)
  const mx = L.mainX + L.mainW - 26;
  R(ctx, mx, top - 16, 2, 16, th.metal.dark);
  R(ctx, mx - 3, top - 2, 8, 2, th.metal.b);
  const a = reduced ? 0.6 : q(t, 10) * 1.6;
  const cw = Math.round(Math.cos(a) * 7);
  const face = Math.sin(a) > 0;
  const dcx = mx + 1, dcy = top - 20;
  for (let yy = -5; yy <= 5; yy++) {
    const curve = Math.round((yy * yy) / 10);
    const x0 = dcx - Math.abs(cw) + (cw > 0 ? curve : -curve) * 0;
    const ww = Math.max(1, Math.abs(cw) * 2 - Math.abs(Math.round(yy * 0.6)));
    R(ctx, x0 + Math.abs(Math.round(yy * 0.3)), dcy + yy, ww, 1, face ? th.metal.a : th.metal.b);
  }
  line(ctx, dcx, dcy, dcx + (cw > 0 ? -5 : 5), dcy - 1, th.metal.dark);
  P(ctx, dcx + (cw > 0 ? -5 : 5), dcy - 1, color);
  // 天线航空灯
  const ax = L.mainX + L.mainW - 8;
  R(ctx, ax, top - 26, 1, 26, th.metal.dark);
  const blink = reduced || Math.floor(t * 1.2) % 2 === 0;
  if (blink) { P(ctx, ax, top - 27, '#ff3030'); glow(ctx, ax, top - 27, 4, '#ff3030', 0.5); }
}
