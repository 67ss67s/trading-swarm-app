/**
 * 多周期原语的公共底座(2026-09-23 夜):把已收盘的执行周期 K 线按高周期分桶,聚成完整的高周期 K 线。
 *
 * 口径(与 trend-state.ts trendState 的高周期桶同一规则):
 *   - 桶 = floor(open_time / htf) × htf(UTC 对齐,日线 = UTC 0 点);
 *   - 只收完整的桶:根数 = htf/base、open_time 逐根连续、最后一根 close_time = 桶起点 + htf − 1;缺根的桶整桶跳过(不补值);
 *   - 高周期 K 线在「收完它最后一根执行周期 K 线」的那一根(end 下标)才出现,之前任何一根都看不到它——不偷看未收完的高周期 K 线。
 *   - 从整段 series 一次算完并按数组缓存:第 i 根的取值只依赖 series[0..i](桶的完整性只看桶内、≤ end 的根),所以与「每根截前缀再算」逐位相同。
 * 不受决策视图(engine viewBars / 订单核 view,500–5000 根)约束:原语从 ctx.series 读整段,缺省退回 ctx.bars。
 */
import type { ResearchBar } from '@trading-swarm/contracts';
import { n, type PrimitiveContext } from './registry.js';

const UNIT: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 };
export function htfMillis(tf: string): number { const m = /^(\d+)(m|h|d)$/.exec(tf); if (!m) throw new Error('htf_invalid'); return Number(m[1]) * UNIT[m[2]!]!; }
/** 高周期 ÷ 执行周期;低于执行周期或不可整除抛错(checkIR 的 timeframe_consistency 先拦) */
export function htfRatio(htf: string, base: number): number { const t = htfMillis(htf); if (t < base || t % base !== 0) throw new Error('htf_below_or_indivisible_base'); return t / base; }

export interface HtfSeries {
  /** 完整的高周期 K 线(数值字段是 number) */
  bars: ResearchBar[];
  /** 第 k 根高周期 K 线收完时的执行周期下标 */
  end: number[];
  /** 执行周期第 i 根收盘时已收完的最近一根高周期 K 线下标(没有 = -1) */
  last: Int32Array;
}
const seriesCache = new WeakMap<ResearchBar[], Map<string, HtfSeries>>();
function memo<T>(cache: WeakMap<ResearchBar[], Map<string, T>>, series: ResearchBar[], key: string, make: () => T): T {
  let m = cache.get(series); if (!m) { m = new Map(); cache.set(series, m); }
  let v = m.get(key); if (v === undefined) { v = make(); m.set(key, v); } return v;
}
export function htfSeries(series: ResearchBar[], base: number, htf: string): HtfSeries {
  const target = htfMillis(htf), per = htfRatio(htf, base);
  return memo(seriesCache, series, `${base}:${target}`, () => {
    const bars: ResearchBar[] = [], end: number[] = [], last = new Int32Array(series.length);
    let start = NaN, count = 0, contiguous = true, open = 0, high = -Infinity, low = Infinity, volume = 0;
    for (let i = 0; i < series.length; i++) {
      const b = series[i]!, key = Math.floor(b.open_time / target) * target;
      if (key !== start) { start = key; count = 0; contiguous = true; open = Number(b.open); high = -Infinity; low = Infinity; volume = 0; }
      if (b.open_time !== start + count * base) contiguous = false;
      high = Math.max(high, Number(b.high)); low = Math.min(low, Number(b.low)); volume += Number(b.volume); count++;
      if (count === per && contiguous && b.close_time === start + target - 1) {
        bars.push({ open_time: start, close_time: start + target - 1, available_at: b.available_at, open: open, high, low, close: Number(b.close), volume } as unknown as ResearchBar);
        end.push(i);
      }
      last[i] = bars.length - 1;
    }
    return { bars, end, last };
  });
}
/** 原语读的整段序列与当前下标:有 series 用 series(不受视图约束),否则退回决策视图。 */
export function seriesOf(ctx: PrimitiveContext): { series: ResearchBar[]; i: number } {
  return ctx.series && ctx.series_i !== undefined ? { series: ctx.series, i: ctx.series_i } : { series: ctx.bars, i: ctx.i };
}

// ── htf_ma_state ─────────────────────────────────────────────────────────

export interface HtfMaParams { htf: string; period: number; ma: 'sma' | 'ema'; side: 'above' | 'below' }
export function htfMaParams(p: Record<string, unknown>): HtfMaParams {
  return { htf: String(p.htf), period: n(p, 'period'), ma: p.ma === 'ema' ? 'ema' : 'sma', side: p.side === 'below' ? 'below' : 'above' };
}
const stateCache = new WeakMap<ResearchBar[], Map<string, Int8Array>>();
/**
 * 每根执行周期 K 线收盘时的高周期均线状态:+1 = 最近一根已收完的高周期 K 线收盘在其 MA(period) 之上,-1 = 之下,
 * 0 = 相等或高周期 K 线不足 period 根。SMA = 最近 period 根高周期收盘的算术平均(逐窗求和,无滚动累积误差);
 * EMA 从第一根高周期收盘起递推(同 trend-state.ts ema),至少 period 根才判。
 */
export function htfMaStates(series: ResearchBar[], base: number, p: HtfMaParams): Int8Array {
  return memo(stateCache, series, `${base}:${p.htf}:${p.period}:${p.ma}`, () => {
    const h = htfSeries(series, base, p.htf), closes = h.bars.map((b) => Number(b.close)), per = new Int8Array(closes.length);
    let e = 0;
    const k = 2 / (p.period + 1);
    for (let j = 0; j < closes.length; j++) {
      let line: number;
      if (p.ma === 'ema') { e = j === 0 ? closes[0]! : closes[j]! * k + e * (1 - k); line = e; }
      else { if (j + 1 < p.period) { per[j] = 0; continue; } let s = 0; for (let x = j - p.period + 1; x <= j; x++) s += closes[x]!; line = s / p.period; }
      per[j] = j + 1 < p.period ? 0 : closes[j]! > line ? 1 : closes[j]! < line ? -1 : 0;
    }
    const out = new Int8Array(series.length);
    for (let i = 0; i < series.length; i++) { const j = h.last[i]!; out[i] = j >= 0 ? per[j]! : 0; }
    return out;
  });
}
/** 取数要借的历史:SMA = (period+2) 根高周期;EMA 多借到 3×period 让递推收敛。只影响取数,不进决策视图。 */
export function htfMaHistory(p: Record<string, unknown>, base = 3600000): number {
  const x = htfMaParams(p); let r: number; try { r = htfRatio(x.htf, base); } catch { return 0; }
  return (x.ma === 'ema' ? 3 * x.period : x.period + 2) * r; // +1 根高周期余量:取数起点落在桶中间时首桶不完整
}
