/**
 * 房间中景(椅背,画在角色之前)与前景(桌子 / 显示器 / 柜台 / 作战桌 + 全息地球,画在角色之后),以及灯光叠加。
 */
import type { Layout, RoomGeo } from './layout';
import { lightXs, type RoomCtx } from './rooms';
import { ROLES } from './roles';
import { chairBack, desk, monitor, screenGlow, mug, plant, deskLamp, deskLampGlow, ceilingLightGlow, hash, type ScreenKind } from './props';
import { R, P, line, disc, glow, lightCone, text, shade, rgba, type Ctx } from './sprites';

export function roomMid(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const fy = r.y + r.h;
  const chair = shade(c.th.desk.dark, -0.1);
  if (r.role === 'asp_agent') return; // 小铺站柜台
  if (r.role === 'gate_captain') {
    chairBack(ctx, r.seatX, fy, shade(ROLES.gate_captain.color, -0.45), c.th);
    return;
  }
  chairBack(ctx, r.seatX, fy, c.th.id === 'meme' ? shade(ROLES[r.role].color, -0.5) : chair, c.th);
}

function mon(ctx: Ctx, x: number, bottom: number, w: number, h: number, kind: ScreenKind, c: RoomCtx, seed: number): void {
  const alert = c.status === 'stuck';
  monitor(ctx, x, bottom, w, h, kind, c.t, c.th, ROLES[(['radar', 'strategy_lab', 'executor'] as const)[seed % 3]!].color, seed, alert);
  screenGlow(ctx, x, bottom - h - 2, w, h, c.th, alert);
}

function keyboard(ctx: Ctx, cx: number, top: number, c: RoomCtx, typing: boolean, color: string): void {
  R(ctx, cx - 5, top - 1, 10, 1, c.th.metal.dark);
  R(ctx, cx - 4, top - 1, 8, 1, c.th.metal.b);
  if (typing && !c.reduced) {
    const k = Math.floor(c.t * 9);
    P(ctx, cx - 4 + (k * 3) % 8, top - 1, c.th.screen.hi);
    // 手
    const l = k % 2 === 0;
    R(ctx, cx - 3 - (l ? 1 : 0), top - 2 - (l ? 1 : 0), 2, 1, shade(color, 0.15));
    R(ctx, cx + 1 + (l ? 0 : 1), top - 2 - (l ? 0 : 1), 2, 1, shade(color, 0.15));
  }
}

export function roomFront(ctx: Ctx, r: RoomGeo, c: RoomCtx, L: Layout, typing: boolean): void {
  const { th, t } = c;
  const fy = r.y + r.h;
  const sx = r.seatX;
  const col = ROLES[r.role].color;
  switch (r.role) {
    case 'radar': {
      desk(ctx, sx, fy, 36, th);
      mon(ctx, sx + 10, fy - 6, 13, 9, 'radar', c, 1);
      mon(ctx, sx - 25, fy - 6, 11, 8, 'text', c, 4);
      keyboard(ctx, sx, fy - 6, c, typing, col);
      plant(ctx, r.x + r.w - 10, fy, th, t, 1, 2, c.reduced);
      break;
    }
    case 'thread_manager': {
      desk(ctx, sx, fy, 36, th);
      mon(ctx, sx + 10, fy - 6, 13, 9, 'text', c, 7);
      mug(ctx, sx - 14, fy - 6, th, t, '#e8e2d4', c.reduced);
      keyboard(ctx, sx, fy - 6, c, typing, col);
      // 档案柜
      const fx = r.x + r.w - 18;
      R(ctx, fx - 1, fy - 18, 12, 18, th.outline);
      R(ctx, fx, fy - 17, 10, 17, th.metal.b);
      for (let i = 0; i < 3; i++) { R(ctx, fx + 1, fy - 16 + i * 5, 8, 4, th.metal.a); R(ctx, fx + 4, fy - 14 + i * 5, 2, 1, th.metal.dark); }
      break;
    }
    case 'strategy_lab': {
      desk(ctx, sx, fy, 36, th);
      mon(ctx, sx + 10, fy - 6, 15, 10, 'curve', c, 3);
      keyboard(ctx, sx, fy - 6, c, typing, col);
      deskLamp(ctx, sx - 14, fy - 6, th, 1);
      break;
    }
    case 'portfolio_manager': {
      desk(ctx, sx, fy, 38, th);
      mon(ctx, sx + 10, fy - 6, 14, 9, 'bars', c, 5);
      keyboard(ctx, sx, fy - 6, c, typing, col);
      // 金币堆 + 摊开的账本
      for (let i = 0; i < 3; i++) R(ctx, sx - 18, fy - 7 - i, 4, 1, i % 2 ? '#ffd166' : '#e0a93a');
      R(ctx, sx - 13, fy - 7, 7, 1, '#f2efe6');
      P(ctx, sx - 10, fy - 7, th.outline);
      plant(ctx, r.x + r.w - 10, fy, th, t, 2, 7, c.reduced);
      break;
    }
    case 'risk_sentinel': {
      desk(ctx, sx, fy, 36, th);
      mon(ctx, sx + 10, fy - 6, 14, 10, 'cctv', c, 2);
      keyboard(ctx, sx, fy - 6, c, typing, col);
      mug(ctx, sx - 14, fy - 6, th, t + 1, '#ff9ac2', c.reduced);
      break;
    }
    case 'executor': {
      desk(ctx, sx, fy, 64, th);
      mon(ctx, sx - 31, fy - 6, 14, 9, 'candles', c, 6);
      mon(ctx, sx + 10, fy - 6, 14, 9, 'candles', c, 9);
      mon(ctx, sx + 26, fy - 6, 11, 8, 'chart', c, 12);
      keyboard(ctx, sx, fy - 6, c, typing, col);
      // 回执打印机:吐小票
      const px = sx - 11;
      R(ctx, px - 1, fy - 10, 9, 4, th.outline);
      R(ctx, px, fy - 9, 7, 3, th.metal.a);
      const len = c.reduced ? 2 : Math.floor((t * 3) % 8);
      R(ctx, px + 1, fy - 10 - len, 5, len, '#f2efe6');
      for (let i = 1; i < len; i += 2) R(ctx, px + 2, fy - 10 - i, 3, 1, '#b0aaa0');
      plant(ctx, r.x + 10, fy, th, t, 2, 1, c.reduced);
      break;
    }
    case 'asp_agent': {
      // 柜台
      const cw = 44, top = fy - 9;
      const x = sx - 18;
      R(ctx, x - 1, top - 1, cw + 2, 10, th.outline);
      R(ctx, x, top, cw, 2, shade(th.desk.top, 0.1));
      R(ctx, x, top + 2, cw, 7, th.desk.face);
      for (let i = 0; i < cw; i += 6) R(ctx, x + i + 2, top + 3, 3, 5, shade(th.desk.face, -0.15));
      R(ctx, x, top + 2, cw, 1, col);
      // 收银机
      R(ctx, sx + 13, top - 7, 11, 7, th.outline);
      R(ctx, sx + 14, top - 6, 9, 6, th.metal.b);
      R(ctx, sx + 15, top - 5, 7, 2, th.screen.bg);
      text(ctx, '+', sx + 16, top - 6, Math.floor(t * 2) % 2 ? th.screen.line : th.screen.hi);
      // 台面上的小信号包
      R(ctx, sx - 18, top - 3, 4, 3, '#ffd166');
      R(ctx, sx - 9, top - 3, 4, 3, col);
      plant(ctx, r.x + r.w - 10, fy, th, t, 1, 4, c.reduced);
      break;
    }
    case 'reviewer': {
      desk(ctx, sx, fy, 36, th);
      // 摊开的书
      R(ctx, sx - 5, fy - 8, 11, 2, '#f2efe6');
      R(ctx, sx, fy - 8, 1, 2, th.outline);
      R(ctx, sx - 4, fy - 8, 3, 1, '#b0aaa0');
      deskLamp(ctx, sx + 13, fy - 6, th, -1);
      // 书堆
      for (let i = 0; i < 3; i++) R(ctx, sx - 18, fy - 7 - i * 2, 6, 2, th.books[i]!);
      break;
    }
    case 'gate_captain': {
      // 船长控制台
      const cx = sx;
      R(ctx, cx - 18, fy - 9, 37, 9, th.outline);
      R(ctx, cx - 17, fy - 8, 35, 8, th.desk.face);
      R(ctx, cx - 17, fy - 8, 35, 2, th.desk.top);
      for (let i = 0; i < 6; i++) {
        const on = c.reduced || Math.sin(t * 3 + i * 1.7) > 0;
        P(ctx, cx - 15 + i * 5, fy - 5, on ? ['#ff5d5d', '#5dff8f', '#ffd166'][i % 3]! : th.desk.dark);
      }
      mon(ctx, cx + 10, fy - 8, 10, 8, 'chart', c, 8);
      // 作战桌 + 全息地球
      const tx = L.meetTableX;
      const tw = 58;
      R(ctx, tx - tw / 2 - 1, fy - 8, tw + 2, 3, th.outline);
      R(ctx, tx - tw / 2, fy - 7, tw, 1, shade(th.desk.top, 0.2));
      R(ctx, tx - tw / 2, fy - 6, tw, 1, th.desk.face);
      R(ctx, tx - 6, fy - 5, 12, 5, th.desk.dark);
      R(ctx, tx - 4, fy - 9, 8, 2, th.metal.a);
      glow(ctx, tx, fy - 24, 16, th.neon[1], 0.12);
      lightCone(ctx, tx, fy - 30, fy - 8, 18, 6, th.neon[1], 0.05);
      const gr = 8, gy = fy - 22;
      const rot = c.reduced ? 0 : t * 0.7;
      for (let la = -3; la <= 3; la++) {
        const yy = Math.round(gy + (la / 3.5) * gr);
        const rw = Math.sqrt(Math.max(0, 1 - (la / 3.5) ** 2)) * gr;
        for (let k = 0; k < 10; k++) {
          const a = rot + (k / 10) * Math.PI * 2;
          if (Math.cos(a) < -0.1) continue;
          const xx = Math.round(tx + Math.sin(a) * rw);
          const land = hash(k * 3 + la * 7 + Math.floor((rot * 10) / (Math.PI * 2))) > 0.55;
          P(ctx, xx, yy, land ? th.screen.hi : rgba(th.neon[1], 0.7));
        }
      }
      R(ctx, tx - 9, gy + gr + 2, 19, 1, rgba(th.neon[1], 0.5));
      // 两把会议椅
      for (const d of [-32, 32]) {
        R(ctx, tx + d - 3, fy - 10, 7, 10, th.outline);
        R(ctx, tx + d - 2, fy - 9, 5, 5, shade(ROLES.gate_captain.color, -0.5));
        R(ctx, tx + d - 2, fy - 4, 5, 1, th.desk.dark);
        R(ctx, tx + d, fy - 3, 1, 3, th.metal.dark);
      }
      plant(ctx, r.x + 8, fy, th, t, 2, 9, c.reduced);
      break;
    }
  }
}

/** 灯光叠加(在角色之后画,照亮角色) */
export function roomLights(ctx: Ctx, r: RoomGeo, c: RoomCtx): void {
  const fy = r.y + r.h;
  const xs = lightXs(r);
  const dim = c.status === 'idle' ? 0.75 : 1;
  for (const x of xs) ceilingLightGlow(ctx, x, r.y, fy, c.th, ROLES[r.role].color, dim);
  if (r.role === 'strategy_lab') deskLampGlow(ctx, r.seatX - 11, fy - 6, c.th, 1);
  if (r.role === 'reviewer') deskLampGlow(ctx, r.seatX + 11, fy - 6, c.th, -1);
  if (c.th.lampStyle === 'neon') {
    // 霓虹:墙顶一条角色色光带
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgba(ROLES[r.role].color, 0.1);
    ctx.fillRect(r.x, r.y + 3, r.w, 4);
    ctx.restore();
  }
}

/** 屋顶茶水间的宠物 + Zz */
export function drawZ(ctx: Ctx, x: number, y: number, t: number, color: string): void {
  for (let i = 0; i < 2; i++) {
    const ph = (t * 0.5 + i * 0.5) % 1;
    const zx = x + Math.round(ph * 5), zy = y - Math.round(ph * 9);
    ctx.fillStyle = rgba(color, 1 - ph);
    ctx.fillRect(zx, zy, 3, 1); ctx.fillRect(zx + 1, zy + 1, 1, 1); ctx.fillRect(zx, zy + 2, 3, 1);
  }
}

export { line, disc };
