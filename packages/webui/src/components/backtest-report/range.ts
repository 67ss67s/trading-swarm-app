/**
 * 回测报告的「时间范围」纯函数(看区间 + 按区间重跑共用,单测覆盖):
 *   rangePresets / presetWindow   今年、近 3 / 6 个月、近 1 年、全部 —— 看区间时锚在报告终点,重跑时锚在现在
 *   rangeStats                    从报告已有的逐点净值与逐笔交易派生区间指标(不重跑、不扣期初持仓)
 *   rerunRequest / rerunTitle     组 POST /api/research/backtests 的请求体
 *   parseDay / dayInput           <input type="date"> 与 UTC 毫秒互转
 * 时间一律 UTC。
 */
import type { BacktestAsset, BacktestReport, StrategyIR } from '@trading-swarm/contracts';

export interface TimeRange {
  from_ms: number;
  to_ms: number;
}

export type RangePresetKey = 'ytd' | '3m' | '6m' | '1y' | 'all';
export const RANGE_PRESET_KEYS: readonly RangePresetKey[] = ['ytd', '3m', '6m', '1y', 'all'];

const DAY = 86_400_000;

export function tfMillis(tf: string): number {
  const n = Number(tf.slice(0, -1));
  const u = tf.slice(-1);
  const unit = u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : u === 'd' ? DAY : u === 'w' ? 7 * DAY : DAY;
  return (Number.isFinite(n) && n > 0 ? n : 1) * unit;
}

/** UTC 日历往回推 n 个月(月底溢出按当月最后一天) */
export function monthsBefore(ms: number, n: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() - n;
  const target = new Date(Date.UTC(y, m, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target.getTime();
}

/** 预设窗口,锚点 = 区间终点。'all' 返回 null(看区间 = 整份报告;重跑 = 后端缺省全窗口,不传 from/to)。 */
export function presetWindow(key: RangePresetKey, anchor: number): TimeRange | null {
  switch (key) {
    case 'ytd':
      return { from_ms: Date.UTC(new Date(anchor).getUTCFullYear(), 0, 1), to_ms: anchor };
    case '3m':
      return { from_ms: monthsBefore(anchor, 3), to_ms: anchor };
    case '6m':
      return { from_ms: monthsBefore(anchor, 6), to_ms: anchor };
    case '1y':
      return { from_ms: monthsBefore(anchor, 12), to_ms: anchor };
    case 'all':
      return null;
  }
}

/** 看区间:预设窗口与报告窗口求交;完全不相交或覆盖全部时返回 null(= 看全部) */
export function viewPreset(key: RangePresetKey, window: TimeRange): TimeRange | null {
  const w = presetWindow(key, window.to_ms);
  if (!w) return null;
  const from = Math.max(w.from_ms, window.from_ms);
  const to = Math.min(w.to_ms, window.to_ms);
  if (!(from < to) || (from <= window.from_ms && to >= window.to_ms)) return null;
  return { from_ms: from, to_ms: to };
}

/** 当前选区是否就是某个看区间预设(高亮用) */
export function matchViewPreset(sel: TimeRange | null, window: TimeRange, tolMs: number): RangePresetKey | null {
  for (const k of RANGE_PRESET_KEYS) {
    const w = viewPreset(k, window);
    if (w === null && sel === null) return k;
    if (w && sel && Math.abs(w.from_ms - sel.from_ms) <= tolMs && Math.abs(w.to_ms - sel.to_ms) <= tolMs) return k;
  }
  return null;
}

/** 选区夹到窗口内;太窄(不到 minSpan)或等于整窗口 → null */
export function clampRange(r: TimeRange | null, window: TimeRange, minSpan = 0): TimeRange | null {
  if (!r) return null;
  const from = Math.max(window.from_ms, Math.min(r.from_ms, r.to_ms));
  const to = Math.min(window.to_ms, Math.max(r.from_ms, r.to_ms));
  if (to - from < Math.max(1, minSpan)) return null;
  if (from <= window.from_ms && to >= window.to_ms) return null;
  return { from_ms: from, to_ms: to };
}

// ---------------------------------------------------------------------------
// 区间指标(前端派生)

export interface RangeStats {
  /** 实际用到的起止净值点 */
  start_at: number;
  end_at: number;
  points: number;
  /** 区间收益 = 终点净值 / 起点净值 − 1 */
  ret: number;
  /** 区间持有收益 =(1 + 终点基准)/(1 + 起点基准)− 1;没有基准为 null */
  bench: number | null;
  excess: number | null;
  /** 区间最大回撤(正数小数),峰值只在区间内找 */
  max_dd: number;
  /** 区间内平仓的笔数(exit_at ∈ [from, to]) */
  trades: number;
  wins: number;
  /** 起点时已持仓(净值点 exposure > 0 或有跨过起点的交易) */
  open_at_start: boolean;
  /** 入场在区间前、出场在区间内的笔数(计入 trades) */
  carried_in: number;
}

/**
 * 区间指标只用报告里已有的数据:净值点(可能已抽稀)+ 逐笔交易。
 * 起点取「≤ from 的最后一个净值点」(没有就取区间内第一个),终点取「≤ to 的最后一个净值点」。
 * 期初若有持仓,区间收益含这笔仓位在区间内的盈亏 —— 这不是「从空仓重跑」,界面要标清口径。
 */
export function rangeStats(asset: Pick<BacktestAsset, 'equity' | 'trades'> | null | undefined, range: TimeRange): RangeStats | null {
  if (!asset || asset.equity.length < 2) return null;
  const eq = [...asset.equity].sort((a, b) => a.at - b.at);
  let s = -1;
  for (let i = 0; i < eq.length; i++) {
    if (eq[i]!.at <= range.from_ms) s = i;
    else break;
  }
  if (s < 0) s = eq.findIndex((p) => p.at >= range.from_ms);
  let e = -1;
  for (let i = eq.length - 1; i >= 0; i--) {
    if (eq[i]!.at <= range.to_ms) {
      e = i;
      break;
    }
  }
  if (s < 0 || e <= s) return null;
  const a = eq[s]!;
  const b = eq[e]!;
  if (!(a.equity > 0)) return null;
  let peak = a.equity;
  let maxDd = 0;
  for (let i = s; i <= e; i++) {
    const v = eq[i]!.equity;
    if (v > peak) peak = v;
    else if (peak > 0) maxDd = Math.max(maxDd, 1 - v / peak);
  }
  const ret = b.equity / a.equity - 1;
  const bench = a.benchmark_pct !== null && b.benchmark_pct !== null && 1 + a.benchmark_pct > 0 ? (1 + b.benchmark_pct) / (1 + a.benchmark_pct) - 1 : null;
  const closed = asset.trades.filter((tr) => tr.exit_at >= range.from_ms && tr.exit_at <= range.to_ms);
  const carriedIn = closed.filter((tr) => tr.entry_at < range.from_ms).length;
  const spanning = asset.trades.some((tr) => tr.entry_at < range.from_ms && tr.exit_at > range.from_ms);
  return {
    start_at: a.at,
    end_at: b.at,
    points: e - s + 1,
    ret,
    bench,
    excess: bench === null ? null : ret - bench,
    max_dd: maxDd,
    trades: closed.length,
    wins: closed.filter((tr) => tr.pnl > 0).length,
    open_at_start: a.exposure > 0 || spanning,
    carried_in: carriedIn,
  };
}

// ---------------------------------------------------------------------------
// 按区间重跑

export interface RerunBody {
  strategy_ir: StrategyIR;
  timeframe: string;
  symbols?: string[];
  from_ms?: number;
  to_ms?: number;
  title?: string;
}

/** 报告里的单资产 symbol,主资产排第一(后端取第一个非篮子 symbol 当主资产);篮子不传,后端自己拼 */
export function rerunSymbols(report: Pick<BacktestReport, 'assets' | 'primary_key'>): string[] {
  const singles = report.assets.filter((a) => a.kind !== 'basket');
  const primary = singles.find((a) => a.key === report.primary_key);
  const ordered = primary ? [primary, ...singles.filter((a) => a !== primary)] : singles;
  const out: string[] = [];
  for (const a of ordered) for (const s of a.symbols) if (!out.includes(s)) out.push(s);
  return out.slice(0, 8);
}

export function ymdUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 去掉上一次重跑加的「· 区间 …」后缀,再加本次的;总长 ≤ 300 */
export function rerunTitle(baseTitle: string, range: TimeRange | null, allLabel: string): string {
  const base = baseTitle.replace(/\s*·\s*(区间|Range)\s.*$/u, '').trim() || 'backtest';
  const tag = range ? `${ymdUtc(range.from_ms)}→${ymdUtc(range.to_ms)}` : allLabel;
  const suffix = ` · ${/[一-鿿]/.test(base) ? '区间' : 'Range'} ${tag}`;
  return (base.slice(0, 300 - suffix.length) + suffix).slice(0, 300);
}

export function rerunRequest(report: Pick<BacktestReport, 'strategy_ir' | 'timeframe' | 'assets' | 'primary_key' | 'title'>, range: TimeRange | null, allLabel: string): RerunBody {
  const symbols = rerunSymbols(report);
  return {
    strategy_ir: report.strategy_ir,
    timeframe: report.timeframe,
    ...(symbols.length ? { symbols } : {}),
    ...(range ? { from_ms: Math.round(range.from_ms), to_ms: Math.round(range.to_ms) } : {}),
    title: rerunTitle(report.title, range, allLabel),
  };
}

export type RangeProblem = 'order' | 'too_short' | 'future' | null;

/** 重跑区间校验:起点要早于终点、至少 minBars 根 K 线、起点不能在未来。终点超过现在由调用方夹到现在。 */
export function rangeProblem(range: TimeRange | null, timeframe: string, now: number, minBars = 5): RangeProblem {
  if (!range) return null;
  if (range.from_ms >= now) return 'future';
  if (!(range.from_ms < range.to_ms)) return 'order';
  if (Math.min(range.to_ms, now) - range.from_ms < minBars * tfMillis(timeframe)) return 'too_short';
  return null;
}

/** 'YYYY-MM-DD' → UTC 毫秒;end=true 取当天最后一毫秒 */
export function parseDay(s: string, end = false): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms) || ymdUtc(ms) !== s.trim()) return null;
  return end ? ms + DAY - 1 : ms;
}

export function dayInput(ms: number): string {
  return ymdUtc(ms);
}

export function spanDays(r: TimeRange): number {
  return Math.max(0, Math.round((r.to_ms - r.from_ms) / DAY));
}
