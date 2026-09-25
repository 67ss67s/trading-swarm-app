/**
 * 天气即状态:窗外随真实状态变化。
 *   行情剧烈(BTC 1h 波动 ≥ 2.5%)= 下雨,≥ 3.2% 再加打雷;
 *   风控 high = 屋顶警报灯旋转红光;
 *   今日盈利且不下雨 = 晴朗,偶尔放烟花;
 *   UTC 18:00–06:00 = 夜景,其余白天。
 * 悬停天空出一句解释。
 */
import { t } from '@/lib/i18n';
import type { Layout } from './layout';
import type { MarketState } from './types';
import { glow, line, rgba, R, type Ctx } from './sprites';

export type WeatherOverride = 'rain' | 'clear' | 'night' | 'day' | null;

export interface Weather {
  night: boolean;
  rain: boolean;
  thunder: boolean;
  fireworks: boolean;
  alarm: boolean;
  reasons: string[];
}

export function computeWeather(market: MarketState | undefined, pnlToday: string | undefined, ov: { sky: 'night' | 'day' | null; rain: 'rain' | 'clear' | null }, now = new Date()): Weather {
  const vol = Number(market?.btc_vol_1h ?? '0');
  const pnl = Number(pnlToday ?? '0');
  const h = now.getUTCHours();
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const night = ov.sky ? ov.sky === 'night' : h < 6 || h >= 18;
  const rain = ov.rain ? ov.rain === 'rain' : vol >= 2.5;
  const thunder = rain && (ov.rain === 'rain' || vol >= 3.2);
  const alarm = market?.risk_level === 'high';
  const fireworks = !rain && pnl > 0;
  const reasons: string[] = [];
  const demo = t('(演示覆盖)');
  const v = vol.toFixed(1);
  if (rain) reasons.push(t('在下雨{thunder}:BTC 1 小时波动 {v}%{demo}', { thunder: thunder ? t('还打雷') : '', v, demo: ov.rain ? demo : '' }));
  else reasons.push(t('天晴:BTC 1 小时波动只有 {v}%', { v }));
  if (fireworks) reasons.push(t('偶尔放烟花:今天赚了 {pnl} USDT', { pnl: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}` }));
  if (alarm) reasons.push(t('屋顶红色警报灯在转:风控等级 high'));
  reasons.push(t('{sky}:现在 UTC {hh}:{mm}{demo}', { sky: night ? t('夜景') : t('白天'), hh: String(h).padStart(2, '0'), mm, demo: ov.sky ? demo : '' }));
  return { night, rain, thunder, fireworks, alarm, reasons };
}

/** 闪电:每 ~7 秒一次,很短 */
export function drawThunder(ctx: Ctx, L: Layout, t: number, reduced: boolean): void {
  if (reduced) return;
  const cyc = 6.8;
  const ph = t % cyc;
  if (ph > 0.22) return;
  const k = Math.floor(t / cyc);
  const x0 = ((k * 97) % Math.max(1, L.LW - 60)) + 30;
  const flash = ph < 0.06 || (ph > 0.12 && ph < 0.16);
  if (flash) {
    ctx.fillStyle = 'rgba(220,230,255,0.16)';
    ctx.fillRect(0, 0, L.LW, L.groundY);
  }
  let x = x0, y = 0;
  for (let i = 0; i < 7; i++) {
    const nx = x + ((k * 13 + i * 7) % 9) - 4, ny = y + 10 + ((k + i) % 4) * 3;
    line(ctx, x, y, nx, ny, '#f4f6ff');
    line(ctx, x + 1, y, nx + 1, ny, rgba('#9fb8ff', 0.7));
    x = nx; y = ny;
  }
  glow(ctx, x0, 10, 20, '#c8d6ff', 0.25);
}

/** 屋顶警报灯:两盏旋转红灯,扫出光锥 */
export function drawRoofAlarm(ctx: Ctx, L: Layout, t: number, reduced: boolean, strong: boolean): void {
  const top = L.towerTop - 3;
  const lights = [L.mainX + 60, L.shaftX + 6];
  for (const [i, x] of lights.entries()) {
    R(ctx, x - 2, top - 4, 5, 4, '#1a0508');
    const on = reduced || Math.floor(t * 4 + i) % 2 === 0;
    R(ctx, x - 1, top - 4, 3, 3, on ? '#ff2b3b' : '#5a0a12');
    if (reduced) continue;
    const a = t * 4 + i * Math.PI;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,40,60,${strong ? 0.16 : 0.1})`;
    ctx.beginPath();
    ctx.moveTo(x, top - 3);
    const len = strong ? 130 : 80;
    ctx.lineTo(x + Math.cos(a - 0.18) * len, top - 3 + Math.sin(a - 0.18) * len * 0.35);
    ctx.lineTo(x + Math.cos(a + 0.18) * len, top - 3 + Math.sin(a + 0.18) * len * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    glow(ctx, x, top - 3, 6, '#ff2b3b', 0.5);
  }
}

/** 紧急停止:每层天花板一盏旋转警灯 + 全楼红色脉冲 */
export function drawEmergency(ctx: Ctx, L: Layout, rooms: { x: number; y: number; w: number; h: number }[], t: number, left: number, reduced: boolean): void {
  const k = Math.min(1, left / 2);
  for (const r of rooms) {
    const x = r.x + Math.round(r.w * 0.62);
    R(ctx, x - 2, r.y, 5, 3, '#1a0508');
    const on = reduced || Math.floor(t * 5) % 2 === 0;
    R(ctx, x - 1, r.y + 1, 3, 2, on ? '#ff2b3b' : '#5a0a12');
    if (!reduced && on) glow(ctx, x, r.y + 2, 10, '#ff2b3b', 0.45 * k);
  }
  if (!reduced) {
    const pulse = (Math.sin(t * 6) + 1) / 2;
    ctx.fillStyle = `rgba(255,20,40,${0.08 * pulse * k})`;
    ctx.fillRect(0, 0, L.LW, L.LH);
  }
}
