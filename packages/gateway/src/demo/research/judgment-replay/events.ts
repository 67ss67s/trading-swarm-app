/**
 * 事件来源:生产 judge 同源的候选事件。
 *
 * 生产扫描循环在每根 K 线收盘时跑 `triggers.ts detectTriggers`,有命中才叫醒模型(backtest.ts 的盲回放同样如此)。
 * 这些触发器是纯函数、只吃已收盘 K 线算出的特征,所以可以在冻结数据上逐根重放 —— 这就是本实验的事件源,
 * 不用任何固定策略的信号。
 *
 * 逐字照搬(backtest.ts 里未导出,只能镜像,窗口大小一个不改):
 *   - barFeatures:主周期 60 根 / 1h 120 根 / 4h 80 根算 tfFeatures,日线 260 根算 dailyRegime,收盘价当 mark;
 *   - triggerHitsAt:fast_move_pct=null(回放没有 tick),阈值取 workflow 默认值,prev_tf / prev_session 每根都更新。
 * 直接 import(只读):backtest.ts visibleWindow / ticker24hFromBars / assertBlind,context.ts buildContext,
 * market.ts tfFeatures / dailyRegime,triggers.ts detectTriggers / sessionInfo,strategy-signals closedWeeks,
 * workflow.ts DEFAULT_WORKFLOW,几何实验室 viewAt / assertVisible / pivots。
 *
 * 本文件新增的只有三条代码规则(都写进 EVENT_RULES_VERSION):
 *   1. 触发器 → 方向:breakout 按突破方向;ema_cross 按 EMA20 与 EMA50 的新相对位置;vol_spike 按这根涨跌;
 *      retest 按 1h 趋势。funding / session 没有方向,只作为上下文里的附带命中,不单独成事件。
 *   2. 同一币同方向冷却 N 根(突破会扎堆,也控制调用量)。
 *   3. 结构止损:最近一个已确认 1h 摆动低(高)点外 0.1 ATR,没有就用近 10 根最低(最高);
 *      距参考收盘 < 0.5 ATR14 就不做(所有臂都不做,也不叫模型)。
 */
import { assertBlind, ticker24hFromBars, visibleWindow } from '../../backtest.js';
import { buildContext, type BuiltContext, type EpisodeInputs } from '../../context.js';
import { assertVisible, pivots, viewAt, type View } from '../../geometry-lab/core.js';
import { atr as prodAtr, dailyRegime, ema as prodEma, tfFeatures, type TfFeatures } from '../../market.js';
import { closedWeeks } from '../../strategy-signals.js';
import { detectTriggers, sessionInfo } from '../../triggers.js';
import type { AccountView, DailyRegime, Kline, MarketView, SessionInfo, TriggerHit } from '../../types.js';
import { DEFAULT_WORKFLOW } from '../../workflow.js';
import { atrSeries } from '../primitives/indicators.js';
import { completeBuckets } from '../primitives/structure.js';
import type { FundingPoint } from './data.js';
import { settlePlanDir, settleTrailDir } from './settle.js';
import { D1, H1, H4, LOOKBACK, MIN_STOP_ATR, STOP_BUFFER_ATR, TRAIL_BARS, type Bar, type Dir, type DropCounts, type JrEvent, type PeriodDef, type Venue } from './types.js';

const N = (s: string): number => Number(s);

export interface Bundle {
  venue: Venue;
  symbol: string;
  h1: Bar[];
  h4: Bar[];
  d1: Bar[];
  w1: Kline[];
  funding: FundingPoint[];
}

/** 4h / 1d 用完整收盘桶从 1h 聚合(UTC 对齐,与交易所 K 线同口径;不完整的桶直接丢)。 */
export function makeBundle(venue: Venue, symbol: string, h1: Bar[], funding: FundingPoint[] = []): Bundle {
  const h4 = completeBuckets(h1, H1, H4);
  const d1 = completeBuckets(h1, H1, D1);
  const w1 = closedWeeks(d1, h1.at(-1)?.close_time ?? 0);
  return { venue, symbol, h1, h4, d1, w1, funding };
}

function fundingAt(f: readonly FundingPoint[], t: number): FundingPoint | null {
  let lo = 0;
  let hi = f.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid]!.at <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? f[lo - 1]! : null;
}

export interface ScanFeatures {
  tf: TfFeatures;
  h1: TfFeatures;
  market: MarketView;
  session: SessionInfo;
}

/**
 * market.ts tfFeatures 去掉 indicators / last_bars 的镜像(逐行照抄其余字段)。
 * 原因:tfFeatures 每次都算整套指标快照(约 3.6ms),逐根重放 8 万根要十分钟;触发器只用这些基础字段。
 * 事件根上仍用生产 tfFeatures 重算一遍喂给上下文,测试钉住两者在基础字段上逐位相等。
 */
export function lightFeatures(tf: string, klines: Kline[]): TfFeatures {
  const ks = klines;
  const closes = ks.map((k) => Number(k.close));
  const last = ks[ks.length - 1]!;
  const lastClose = Number(last.close);
  const e20 = prodEma(closes, 20);
  const e50 = prodEma(closes, 50);
  const win20 = ks.slice(-20);
  const win50 = ks.slice(-50);
  const prev20 = ks.slice(-21, -1);
  const hi20 = Math.max(...win20.map((k) => Number(k.high)));
  const lo20 = Math.min(...win20.map((k) => Number(k.low)));
  const hi20prev = prev20.length ? Math.max(...prev20.map((k) => Number(k.high))) : hi20;
  const lo20prev = prev20.length ? Math.min(...prev20.map((k) => Number(k.low))) : lo20;
  const hi50 = Math.max(...win50.map((k) => Number(k.high)));
  const lo50 = Math.min(...win50.map((k) => Number(k.low)));
  const vols = ks.map((k) => Number(k.volume));
  const avgVol20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, vols.length - 1));
  const prev = ks[ks.length - 2] ?? last;
  const prev5 = ks[ks.length - 6] ?? ks[0]!;
  return {
    tf,
    last_close: lastClose,
    last_open_time: last.open_time,
    ema20: e20[e20.length - 1]!,
    ema50: e50[e50.length - 1]!,
    atr14: prodAtr(ks, 14),
    swing_high_20: hi20,
    swing_low_20: lo20,
    swing_high_20_prev: hi20prev,
    swing_low_20_prev: lo20prev,
    swing_high_50: hi50,
    swing_low_50: lo50,
    dist_to_high20_pct: ((hi20 - lastClose) / lastClose) * 100,
    dist_to_low20_pct: ((lastClose - lo20) / lastClose) * 100,
    vol_ratio_20: avgVol20 > 0 ? Number(last.volume) / avgVol20 : 1,
    change_pct_last: ((lastClose - Number(prev.close)) / Number(prev.close)) * 100,
    change_pct_5: ((lastClose - Number(prev5.close)) / Number(prev5.close)) * 100,
    last_bars: '',
    indicators: null,
  };
}

/** 触发器比较用到的字段;事件根上生产 tfFeatures 与 lightFeatures 在这些字段上必须逐位相等。 */
export const TRIGGER_FIELDS = ['last_close', 'last_open_time', 'ema20', 'ema50', 'atr14', 'swing_high_20', 'swing_low_20', 'swing_high_20_prev', 'swing_low_20_prev', 'swing_high_50', 'swing_low_50', 'dist_to_high20_pct', 'dist_to_low20_pct', 'vol_ratio_20', 'change_pct_last', 'change_pct_5'] as const;

/** backtest.ts barFeatures 的前半段(触发器要用的部分);null 条件逐字照抄。light=true 时用 lightFeatures。 */
export function scanFeatures(b: Bundle, t: number, light = false): ScanFeatures | null {
  const feat = light ? lightFeatures : tfFeatures;
  const tfBars = visibleWindow(b.h1, t, 60);
  const h1 = visibleWindow(b.h1, t, 120);
  const h4 = visibleWindow(b.h4, t, 80);
  if (tfBars.length < 5 || h1.length < 5 || h4.length < 5) return null;
  const last = tfBars[tfBars.length - 1]!;
  const funding = b.venue === 'perp' ? fundingAt(b.funding, t) : null;
  const market: MarketView = {
    market: b.venue,
    symbol: b.symbol,
    last: last.close,
    mark: last.close,
    funding_rate: funding ? funding.rate : '',
    next_funding_at: Math.floor(t / 28_800_000) * 28_800_000 + 28_800_000,
    open_interest: '',
    as_of: t,
    klines_tf: '1h',
  };
  return { tf: feat('1h', tfBars), h1: feat('1h', h1), market, session: sessionInfo(t) };
}

export interface FullFeatures extends ScanFeatures {
  features: TfFeatures[];
  regime: DailyRegime | null;
  ticker: { priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string };
}

/** 完整生产特征(给上下文用):主周期 / 1h 用生产 tfFeatures 重算,4h、日线状态、24h ticker。 */
export function fullFeatures(b: Bundle, t: number, light?: ScanFeatures): FullFeatures {
  const sf = scanFeatures(b, t, false);
  if (!sf) throw new Error(`no features at ${t}`);
  if (light) for (const k of TRIGGER_FIELDS) for (const w of ['tf', 'h1'] as const) if (light[w][k] !== sf[w][k]) throw new Error(`light_features_drift:${w}.${k}`);
  const h4 = visibleWindow(b.h4, t, 80);
  const daily = visibleWindow(b.d1, t, 260);
  return { ...sf, features: [sf.tf, sf.h1, tfFeatures('4h', h4)], regime: daily.length >= 30 ? dailyRegime(daily, t) : null, ticker: ticker24hFromBars(b.h1, t, '1h') };
}

export function triggersAt(b: Bundle, sf: ScanFeatures, prev: { tf: TfFeatures | null; session: SessionInfo['name'] | null }): TriggerHit[] {
  return detectTriggers({
    symbol: b.symbol,
    now_tf: sf.tf,
    prev_tf: prev.tf,
    h1: sf.h1,
    market: sf.market,
    session: sf.session,
    fast_move_pct: null,
    fast_move_threshold_pct: Number(DEFAULT_WORKFLOW.fast_move_pct ?? '0.8'),
    prev_session: prev.session,
  });
}

/** 规则 1:触发器 → 方向;没有方向的触发器返回 null。 */
export function hitDirection(hit: TriggerHit, f: TfFeatures, prev: TfFeatures | null, h1: TfFeatures | null): Dir | null {
  switch (hit.kind) {
    case 'breakout':
      if (!prev) return f.change_pct_last > 0 ? 'long' : 'short';
      return f.last_close > prev.swing_high_20 ? 'long' : f.last_close < prev.swing_low_20 ? 'short' : null;
    case 'ema_cross':
      return f.ema20 > f.ema50 ? 'long' : 'short';
    case 'vol_spike':
      return f.change_pct_last >= 0 ? 'long' : 'short';
    case 'retest':
      return h1 ? (h1.ema20 > h1.ema50 ? 'long' : 'short') : null;
    default:
      return null;
  }
}

export function atr14Of(v: View): number {
  return atrSeries(v.bars.slice(), 14).at(-1)!;
}

/** 规则 3:结构止损(最近一个已确认 1h 摆动点外 0.1 ATR;没有就用近 10 根极值)。 */
export function structuralStop(v: View, dir: Dir): { stop: number; source: string; dist_atr: number; atr14: number } {
  assertVisible(v);
  const close = N(v.bars.at(-1)!.close);
  const atr = atr14Of(v);
  const ps = pivots(v.bars, 3, 3);
  const w10 = v.bars.slice(-10);
  if (dir === 'long') {
    const p = ps.filter((x) => x.kind === 'low' && x.price < close).at(-1);
    const level = p ? p.price : Math.min(...w10.map((x) => N(x.low)));
    const stop = level - STOP_BUFFER_ATR * atr;
    return { stop, source: p ? `1h swing low ${p.price} −0.1ATR` : `LL10 ${level} −0.1ATR`, dist_atr: (close - stop) / atr, atr14: atr };
  }
  const p = ps.filter((x) => x.kind === 'high' && x.price > close).at(-1);
  const level = p ? p.price : Math.max(...w10.map((x) => N(x.high)));
  const stop = level + STOP_BUFFER_ATR * atr;
  return { stop, source: p ? `1h swing high ${p.price} +0.1ATR` : `HH10 ${level} +0.1ATR`, dist_atr: (stop - close) / atr, atr14: atr };
}

/** 副管仓的结构止盈:方向上 1–6 ATR 内最近的已确认 1h 摆动点(几何实验室 A 臂同规则的双向版);没有就不设。 */
export function structuralTarget(v: View, dir: Dir, atr: number): number | null {
  const close = N(v.bars.at(-1)!.close);
  const ps = pivots(v.bars, 3, 3);
  const c = ps
    .filter((p) => (dir === 'long' ? p.kind === 'high' && p.price > close : p.kind === 'low' && p.price < close))
    .map((p) => p.price)
    .filter((px) => Math.abs(px - close) / atr >= 1 && Math.abs(px - close) / atr <= 6)
    .sort((a, b) => Math.abs(a - close) - Math.abs(b - close));
  return c[0] ?? null;
}

/** 代码过滤臂 A_f:1h 与 4h 的 EMA20/EMA50 都与方向一致(默认 playbook「适用」条件的代码版)。 */
export function trendAligned(ff: FullFeatures, dir: Dir): boolean {
  const h1 = ff.features[1]!;
  const h4 = ff.features[2]!;
  return dir === 'long' ? h1.ema20 > h1.ema50 && h4.ema20 > h4.ema50 : h1.ema20 < h1.ema50 && h4.ema20 < h4.ema50;
}

export interface EventOptions {
  directions: Dir[];
  cooldown_bars: number;
}

export interface BuiltEvents {
  events: JrEvent[];
  drops: DropCounts;
}

function lastIndexAtOrBefore(bars: readonly Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.close_time <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** 在一个行情段上逐根重放生产触发器,产出事件(含两种管仓的结算)。 */
export function buildEvents(b: Bundle, period: PeriodDef, o: EventOptions): BuiltEvents {
  const drops: DropCounts = { candidates: 0, stop_too_close: 0, cooldown: 0, no_forward: 0, no_features: 0, accepted: 0 };
  const events: JrEvent[] = [];
  const bars = b.h1;
  // 从段首前 2 根开始走,好让段内第一根就有 prev_tf(生产循环里 prev 也是连续更新的)
  const start = Math.max(0, lastIndexAtOrBefore(bars, period.from - 2 * H1));
  let prevTf: TfFeatures | null = null;
  let prevSession: SessionInfo['name'] | null = null;
  const lastAt = new Map<Dir, number>();
  const funding = b.venue === 'perp' ? b.funding : [];
  for (let i = start; i < bars.length; i++) {
    const t = bars[i]!.close_time;
    if (t >= period.to) break;
    const sf = scanFeatures(b, t, true);
    if (!sf) {
      prevSession = null;
      continue;
    }
    const prevBefore = prevTf;
    const hits = triggersAt(b, sf, { tf: prevTf, session: prevSession });
    prevTf = sf.tf;
    prevSession = sf.session.name;
    if (t < period.from) continue;
    const directional = hits.map((h) => ({ h, d: hitDirection(h, sf.tf, prevBefore, sf.h1) })).filter((x): x is { h: TriggerHit; d: Dir } => x.d !== null && o.directions.includes(x.d));
    if (!directional.length) continue;
    drops.candidates++;
    const chosen = directional[0]!;
    const v = viewAt(b.symbol, bars, t, LOOKBACK);
    if (v.bars.length < LOOKBACK) {
      drops.no_features++;
      continue;
    }
    const st = structuralStop(v, chosen.d);
    if (!(st.dist_atr >= MIN_STOP_ATR)) {
      drops.stop_too_close++;
      continue;
    }
    const last = lastAt.get(chosen.d);
    if (last !== undefined && t - last < o.cooldown_bars * H1) {
      drops.cooldown++;
      continue;
    }
    const future = bars.slice(i + 1);
    if (future.length < TRAIL_BARS) {
      drops.no_forward++;
      continue;
    }
    lastAt.set(chosen.d, t);
    const ff = fullFeatures(b, t, sf);
    const target = structuralTarget(v, chosen.d, st.atr14);
    events.push({
      id: `${b.venue}:${b.symbol}:${t}:${chosen.d}`,
      venue: b.venue,
      symbol: b.symbol,
      period: period.id,
      as_of: t,
      direction: chosen.d,
      kind: chosen.h.kind,
      hits,
      ref_close: N(bars[i]!.close),
      atr14: st.atr14,
      stop: st.stop,
      stop_source: st.source,
      stop_atr: st.dist_atr,
      target,
      trend_ok: trendAligned(ff, chosen.d),
      trail: settleTrailDir(chosen.d, st.stop, v.bars, future, st.atr14, funding),
      plan: settlePlanDir(chosen.d, st.stop, target, future, st.atr14, funding),
    });
    drops.accepted++;
  }
  return { events, drops };
}

// ─────────────────────────────── 生产上下文(模型唯一能看到的东西) ───────────────────────────────

/** backtest.ts accountAt 的镜像(未导出):纸面账户、无持仓。 */
export function paperAccount(t: number): AccountView {
  return { backend: 'paper', equity: '10000.00', available: '10000.00', unrealized_pnl: '0.00', positions: [], open_orders: [], as_of: t };
}

/** 与 backtest.ts walkLegs 同形的 scan 输入;strategies=[](不带策略,由 workflow 默认 playbook 兜底)。 */
export function episodeInputs(b: Bundle, t: number, hits: TriggerHit[]): EpisodeInputs {
  const ff = fullFeatures(b, t);
  const klines: Record<string, Kline[]> = {
    '1h': visibleWindow(b.h1, t, 600),
    '4h': visibleWindow(b.h4, t, 600),
    '1d': visibleWindow(b.d1, t, 400),
    '1w': visibleWindow(b.w1, t, 80),
  };
  const trigger = hits[0] ?? null;
  return {
    now: t,
    symbol: b.symbol,
    trigger: { kind: trigger?.kind ?? 'kline_close', detail: trigger?.detail ?? '判断回放' },
    mode: 'scan',
    thread: null,
    open_threads: [],
    account: paperAccount(t),
    market: ff.market,
    features: ff.features,
    oi_change_1h_pct: null,
    ticker24h: ff.ticker,
    market_state: null,
    playbook_text: DEFAULT_WORKFLOW.playbook_text,
    last_judgment_summary: null,
    halted: false,
    daily_regime: ff.regime,
    session: ff.session,
    trigger_hits: hits,
    memories: [],
    strategies: [],
    klines,
    funding_history: b.venue === 'perp' ? b.funding.filter((f) => f.at <= t) : [],
  };
}

/** 防泄露:生产的 assertBlind + 每条 K 线 close_time ≤ t + 每个特征的最后一根在 t 之前收盘。 */
export function assertInputsBlind(inp: EpisodeInputs, t: number): void {
  assertBlind(inp, t);
  for (const [tf, bs] of Object.entries(inp.klines ?? {})) for (const k of bs) if (k.close_time > t) throw new Error(`future_bar_leak:${tf}:${k.close_time}>${t}`);
  const ms: Record<string, number> = { '1h': H1, '4h': H4 };
  for (const f of inp.features) if (f.last_open_time + (ms[f.tf] ?? H1) - 1 > t) throw new Error(`future_feature_leak:${f.tf}`);
  if ((inp.funding_history ?? []).some((f) => f.at > t)) throw new Error('future_funding_leak');
}

export function buildEventContext(b: Bundle, ev: Pick<JrEvent, 'as_of' | 'hits'>): { built: BuiltContext; inputs: EpisodeInputs } {
  const inputs = episodeInputs(b, ev.as_of, ev.hits);
  assertInputsBlind(inputs, ev.as_of);
  return { built: buildContext(inputs), inputs };
}
