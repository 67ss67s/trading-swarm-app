/**
 * 策略回放 K 线上的 SMC 图层(lightweight-charts series primitive,画在蜡烛下层)。
 * 数据:GET /api/research/backtests/:id/replay?overlay=smc 的 smc_overlay(契约 SmcOverlay,时间 = K 线 open_time ms)。
 * 画法:溢价/折价/均衡区 = 淡色背景;订单块 / FVG = 半透明色块(失效/回补处截止,未失效延伸到最右);
 * BOS / CHoCH = 从被突破的 pivot 到突破根的水平线 + 标签(摆动实线、内部虚线);等高等低 = 点线;前日/周高低 = 短横线。
 * 概念参照 LuxAlgo SMC 的图示习惯,绘制代码自研。
 */
import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, Time } from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { SmcOverlay } from '@trade-gate/contracts';
import { hexAlpha } from './format';

export type SmcLayerKey = 'structure' | 'blocks' | 'fvg' | 'zones' | 'levels';
export const SMC_LAYER_KEYS: SmcLayerKey[] = ['structure', 'blocks', 'fvg', 'zones', 'levels'];
export const SMC_COLORS = { bull: '#2aa76e', bear: '#c94b3e', obBull: '#3f9ac2', obBear: '#c94b3e', fvgBull: '#2aa76e', fvgBear: '#b58530', eq: '#97a3b4', htf: '#a468e0', premium: '#c94b3e', discount: '#2aa76e', equilibrium: '#97a3b4' } as const;

interface Model { overlay: SmcOverlay; times: number[]; layers: Set<SmcLayerKey>; blocks: SmcOverlay['order_blocks']; fvgs: SmcOverlay['fvgs'] }
/** 到图尾仍未失效的块 / 缺口会一直延伸到最右,全画会糊成一片(老的低位看涨块能挂好几年):每个级别 × 方向只留离最新价最近的 ACTIVE_KEEP 个;已失效的照画(有终点) */
export const ACTIVE_KEEP = 5;
function nearestActive<T extends { top: number; bottom: number; dir: string }>(xs: T[], alive: (x: T) => boolean, group: (x: T) => string, price: number): T[] {
  const keep = new Set<T>(), by = new Map<string, T[]>();
  for (const x of xs) if (alive(x)) (by.get(group(x)) ?? by.set(group(x), []).get(group(x))!).push(x);
  for (const g of by.values()) g.sort((a, b) => Math.abs((a.top + a.bottom) / 2 - price) - Math.abs((b.top + b.bottom) / 2 - price)).slice(0, ACTIVE_KEEP).forEach((x) => keep.add(x));
  return xs.filter((x) => !alive(x) || keep.has(x));
}

/** 时间(ms)→ 逻辑下标:不在 K 线上的时间(窗口前的 pivot)按二分落到最近一根,之前/之后按周期外推 */
function logicalOf(times: number[], t: number): number {
  const n = times.length; if (!n) return 0;
  const step = n > 1 ? (times[n - 1]! - times[0]!) / (n - 1) : 1;
  if (t <= times[0]!) return (t - times[0]!) / step;
  if (t >= times[n - 1]!) return n - 1 + (t - times[n - 1]!) / step;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid]! <= t) lo = mid; else hi = mid; }
  return lo;
}

class Renderer implements IPrimitivePaneRenderer {
  constructor(private readonly src: SmcPrimitive) {}
  draw(): void {}
  drawBackground(target: CanvasRenderingTarget2D): void {
    const { model, chart, series } = this.src; if (!model || !chart || !series) return;
    const { overlay: o, times, layers } = model, ts = chart.timeScale(), last = times.length - 1;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = mediaSize.width;
      // 未失效(null)= 延伸到最后一根右侧半根;logicalToCoordinate 对非整数 / 越界逻辑下标不可靠(实测返回 0),先取整再按 barSpacing 补
      const spacing = ts.options().barSpacing ?? 6;
      const x = (t: number | null) => {
        const lg = t === null ? last : logicalOf(times, t), base = Math.round(lg), v = ts.logicalToCoordinate(base as never);
        return v === null ? NaN : Number(v) + (lg - base) * spacing + (t === null ? spacing / 2 : 0);
      };
      const y = (p: number) => { const v = series.priceToCoordinate(p); return v === null ? NaN : Number(v); };
      const visible = (x0: number, x1: number) => Number.isFinite(x0) && Number.isFinite(x1) && x1 >= x0 && x1 >= 0 && x0 <= W;
      const rect = (x0: number, x1: number, top: number, bottom: number, fill: string, stroke?: string) => {
        const y0 = y(top), y1 = y(bottom); if (!visible(x0, x1) || !Number.isFinite(y0) || !Number.isFinite(y1)) return;
        const l = Math.max(-2, x0), r = Math.min(W + 2, x1), h = Math.max(1, y1 - y0); if (!(r > l)) return;
        ctx.fillStyle = fill; ctx.fillRect(l, y0, r - l, h);
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(l + 0.5, y0 + 0.5, r - l - 1, h - 1); }
      };
      const hline = (x0: number, x1: number, level: number, color: string, dash: number[], width = 1) => {
        const yy = y(level); if (!visible(x0, x1) || !Number.isFinite(yy)) return;
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(Math.max(-2, x0), Math.round(yy) + 0.5); ctx.lineTo(Math.min(W + 2, x1), Math.round(yy) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      };
      const label = (text: string, xx: number, yy: number, color: string, above: boolean, size = 10) => {
        if (!Number.isFinite(xx) || !Number.isFinite(yy) || xx < -40 || xx > W + 40) return;
        ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = above ? 'bottom' : 'top'; ctx.fillText(text, xx, yy + (above ? -2 : 2));
      };
      // 区间背景
      if (layers.has('zones') && o.zones) {
        const z = o.zones, x0 = x(z.from), x1 = x(null);
        rect(x0, x1, z.premium.top, z.premium.bottom, hexAlpha(SMC_COLORS.premium, 0.07));
        rect(x0, x1, z.discount.top, z.discount.bottom, hexAlpha(SMC_COLORS.discount, 0.07));
        rect(x0, x1, z.equilibrium.top, z.equilibrium.bottom, hexAlpha(SMC_COLORS.equilibrium, 0.14));
        ctx.textAlign = 'right';
        const tag = (text: string, price: number, color: string, above: boolean) => { const yy = y(price); if (!Number.isFinite(yy)) return; ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = color; ctx.textAlign = 'right'; ctx.textBaseline = above ? 'top' : 'bottom'; ctx.fillText(text, Math.min(W, x1) - 4, yy + (above ? 2 : -2)); };
        tag(`Premium · ${z.strong_high ? 'Strong High' : 'Weak High'}`, z.premium.top, hexAlpha(SMC_COLORS.premium, 0.85), true);
        tag('Equilibrium', z.equilibrium.top, hexAlpha(SMC_COLORS.equilibrium, 0.9), false);
        tag(`Discount · ${z.strong_low ? 'Strong Low' : 'Weak Low'}`, z.discount.bottom, hexAlpha(SMC_COLORS.discount, 0.85), false);
      }
      // 订单块:内部级别淡、摆动级别深并描边
      if (layers.has('blocks')) for (const b of model.blocks) {
        const c = b.dir === 'bullish' ? SMC_COLORS.obBull : SMC_COLORS.obBear, swing = b.scope === 'swing';
        rect(x(b.from), x(b.mitigated_at), b.top, b.bottom, hexAlpha(c, swing ? 0.26 : 0.14), swing ? hexAlpha(c, 0.7) : undefined);
      }
      if (layers.has('fvg')) for (const g of model.fvgs) rect(x(g.from), x(g.filled_at), g.top, g.bottom, hexAlpha(g.dir === 'bullish' ? SMC_COLORS.fvgBull : SMC_COLORS.fvgBear, 0.2));
      if (layers.has('structure')) {
        for (const s of o.structures) {
          const x0 = x(s.from), x1 = x(s.at), c = s.dir === 'bullish' ? SMC_COLORS.bull : SMC_COLORS.bear, swing = s.scope === 'swing';
          hline(x0, x1, s.level, hexAlpha(c, swing ? 0.95 : 0.7), swing ? [] : [4, 3], swing ? 1.5 : 1);
          // 标签只在线段够宽时画,缩得很小时不糊成一片
          if (x1 - x0 > (swing ? 18 : 30)) label(s.kind, (x0 + x1) / 2, y(s.level), hexAlpha(c, swing ? 1 : 0.8), s.dir === 'bullish', swing ? 11 : 9);
        }
        for (const e of o.eq) {
          const x0 = x(e.from), x1 = x(e.to), c = e.kind === 'EQH' ? SMC_COLORS.bear : SMC_COLORS.bull;
          hline(x0, x1, e.level, hexAlpha(c, 0.8), [1, 2]);
          if (x1 - x0 > 20) label(e.kind, (x0 + x1) / 2, y(e.level), hexAlpha(c, 0.9), e.kind === 'EQH', 9);
        }
      }
      if (layers.has('levels')) for (const h of o.htf_levels) {
        const x0 = x(h.from), x1 = x(h.to) + spacing;
        if (x1 - x0 < 6) continue;
        hline(x0, x1, h.level, hexAlpha(SMC_COLORS.htf, h.kind.startsWith('PW') ? 0.85 : 0.55), h.kind.startsWith('PW') ? [6, 3] : [2, 2]);
        if (x1 - x0 > 28 && x0 >= 0) { ctx.font = '9px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = hexAlpha(SMC_COLORS.htf, 0.9); ctx.textAlign = 'left'; ctx.textBaseline = h.kind.endsWith('H') ? 'bottom' : 'top'; const yy = y(h.level); if (Number.isFinite(yy)) ctx.fillText(h.kind, Math.max(0, x0) + 2, yy + (h.kind.endsWith('H') ? -1 : 1)); }
      }
    });
  }
}
class PaneView implements IPrimitivePaneView {
  private readonly r: Renderer;
  constructor(src: SmcPrimitive) { this.r = new Renderer(src); }
  zOrder(): 'bottom' { return 'bottom'; }
  renderer(): IPrimitivePaneRenderer { return this.r; }
}

/** 挂到蜡烛序列上的 SMC 图层;setModel(null) 清空 */
export class SmcPrimitive implements ISeriesPrimitive<Time> {
  model: Model | null = null;
  chart: IChartApi | null = null;
  series: ISeriesApi<'Candlestick'> | null = null;
  private request: (() => void) | null = null;
  private readonly views: PaneView[] = [new PaneView(this)];
  attached(p: SeriesAttachedParameter<Time>): void { this.chart = p.chart as IChartApi; this.series = p.series as ISeriesApi<'Candlestick'>; this.request = p.requestUpdate; }
  detached(): void { this.chart = null; this.series = null; this.request = null; }
  paneViews(): readonly IPrimitivePaneView[] { return this.views; }
  setModel(overlay: SmcOverlay | null, times: number[], layers: Set<SmcLayerKey>, lastPrice = NaN): void {
    this.model = overlay ? {
      overlay, times, layers,
      blocks: nearestActive(overlay.order_blocks, (b) => b.mitigated_at === null, (b) => b.scope + b.dir, lastPrice),
      fvgs: nearestActive(overlay.fvgs, (g) => g.filled_at === null, (g) => g.dir, lastPrice),
    } : null;
    this.request?.();
  }
}
