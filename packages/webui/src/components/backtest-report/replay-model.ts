/**
 * 策略回放的纯函数模型(不碰图表库,方便测试):
 * 把 BacktestPlan 转成「K 线索引上的线段 + 标记」。所有时间都吸附到所在 K 线的开盘时间,
 * 否则 lightweight-charts 会把非整根的时间点插进时间轴,把蜡烛间距打乱。
 * 同一条线序列里线段不能在时间上重叠,所以按时间把计划分到若干「泳道」,每条泳道一组序列。
 */
import type { BacktestCandle, BacktestPlan, BacktestTrade } from '@trading-swarm/contracts';
import { t } from '@/lib/i18n';

export const LONG_COLOR = '#3f9ac2';
export const SHORT_COLOR = '#a468e0';
export const STOP_COLOR = '#c94b3e';
export const TP_COLOR = '#2aa76e';
export const PENDING_COLOR = '#97a3b4';

/** 最大的 i 使 candles[i].t <= at;at 早于第一根时返回 0 */
export function snapIndex(candles: BacktestCandle[], at: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  if (hi < 0) return 0;
  if (at <= candles[0]!.t) return 0;
  if (at >= candles[hi]!.t) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid]!.t <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export type SegRole = 'entry_pending' | 'entry_filled' | 'stop' | `tp${number}`;

export interface Seg {
  planId: string;
  role: SegRole;
  side: 'long' | 'short';
  /** [K 线索引, 价格] 折点;止损按 stop_path 是阶梯 */
  points: [number, number][];
}

export interface PlanSpan {
  planId: string;
  start: number;
  end: number;
}

export function planEndAt(p: BacktestPlan): number {
  return p.exit?.at ?? (p.filled_at === null ? p.expires_at ?? p.events[p.events.length - 1]?.at ?? p.placed_at : p.events[p.events.length - 1]?.at ?? p.filled_at);
}

export function planSegments(p: BacktestPlan, candles: BacktestCandle[]): Seg[] {
  const segs: Seg[] = [];
  const idx = (at: number) => snapIndex(candles, at);
  const placed = idx(p.placed_at);
  const end = idx(planEndAt(p));
  const entryPx = p.entry_price ?? p.fill_price ?? p.reference_price;
  const fillIdx = p.filled_at === null ? null : idx(p.filled_at);
  // 入场:挂单期间灰虚线,成交后实线到出场
  const pendingEnd = fillIdx ?? end;
  if (p.entry_type === 'limit' || fillIdx === null) segs.push({ planId: p.id, role: 'entry_pending', side: p.side, points: [[placed, entryPx], [pendingEnd, entryPx]] });
  if (fillIdx !== null) {
    const px = p.fill_price ?? entryPx;
    segs.push({ planId: p.id, role: 'entry_filled', side: p.side, points: [[fillIdx, px], [end, px]] });
  }
  const from = fillIdx ?? placed;
  // 止损:stop_path 阶梯;没有就用 stop.price 一条平线
  const path = p.stop_path.length ? [...p.stop_path].sort((a, b) => a.at - b.at) : p.stop ? [{ at: fillIdx === null ? p.placed_at : p.filled_at!, price: p.stop.price }] : [];
  if (path.length) {
    const pts: [number, number][] = [];
    for (const s of path) {
      const i = Math.max(from, idx(s.at));
      if (pts.length && pts[pts.length - 1]![0] === i) pts[pts.length - 1] = [i, s.price];
      else pts.push([i, s.price]);
    }
    const stopEnd = p.stop?.filled_at ? idx(p.stop.filled_at) : end;
    pts.push([Math.max(pts[pts.length - 1]![0], stopEnd), pts[pts.length - 1]![1]]);
    segs.push({ planId: p.id, role: 'stop', side: p.side, points: pts });
  }
  p.take_profits.forEach((tp, k) => {
    const tpEnd = tp.filled_at ? idx(tp.filled_at) : end;
    segs.push({ planId: p.id, role: `tp${k}`, side: p.side, points: [[from, tp.price], [Math.max(from, tpEnd), tp.price]] });
  });
  return segs;
}

export function planSpan(p: BacktestPlan, candles: BacktestCandle[]): PlanSpan {
  return { planId: p.id, start: snapIndex(candles, p.placed_at), end: snapIndex(candles, planEndAt(p)) };
}

/** 贪心分泳道:同一泳道里后一个计划的起点至少比前一个终点晚 2 根(中间要塞一个断点) */
export function assignLanes(spans: PlanSpan[]): Map<string, number> {
  const lanes: number[] = [];
  const out = new Map<string, number>();
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    let lane = lanes.findIndex((lastEnd) => lastEnd + 1 < s.start);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(-10);
    }
    lanes[lane] = s.end;
    out.set(s.planId, lane);
  }
  return out;
}

export type LwPoint = { time: number; value?: number };

/** 一组线段(同一泳道同一角色)→ 带断点的序列数据(time 为秒) */
export function segmentsToSeries(segs: Seg[], candles: BacktestCandle[]): LwPoint[] {
  const out: LwPoint[] = [];
  const sec = (i: number) => Math.floor(candles[i]!.t / 1000);
  const sorted = [...segs].sort((a, b) => a.points[0]![0] - b.points[0]![0]);
  let last = -1;
  for (const s of sorted) {
    for (const [i, v] of s.points) {
      if (i < last) continue;
      if (i === last && out.length && out[out.length - 1]!.time === sec(i)) {
        out[out.length - 1] = { time: sec(i), value: v };
        continue;
      }
      out.push({ time: sec(i), value: v });
      last = i;
    }
    // 断点:下一根放一个空白点,线就不会连到下一段
    const endIdx = s.points[s.points.length - 1]![0];
    if (endIdx + 1 < candles.length) {
      out.push({ time: sec(endIdx + 1) });
      last = endIdx + 1;
    }
  }
  return out;
}

export interface ReplayMarker {
  time: number;
  planId: string | null;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string;
  text: string;
}

const EVENT_MARK: Record<string, { shape: ReplayMarker['shape']; color: string; text: () => string } | undefined> = {
  tp_hit: { shape: 'circle', color: TP_COLOR, text: () => 'TP' },
  sl_hit: { shape: 'square', color: STOP_COLOR, text: () => 'SL' },
  no_fill: { shape: 'square', color: PENDING_COLOR, text: () => t('未成交') },
  replaced: { shape: 'square', color: PENDING_COLOR, text: () => t('替换') },
  rolled_out: { shape: 'circle', color: '#b58530', text: () => t('滚出') },
  rolled_in: { shape: 'circle', color: '#b58530', text: () => t('滚入') },
  flipped: { shape: 'circle', color: '#a6e146', text: () => t('反手') },
  liquidated: { shape: 'square', color: STOP_COLOR, text: () => t('强平') },
  closed: { shape: 'circle', color: '#aab4c3', text: () => t('平仓') },
};

export function planMarkers(p: BacktestPlan, candles: BacktestCandle[], withText: boolean): ReplayMarker[] {
  const sec = (at: number) => Math.floor(candles[snapIndex(candles, at)]!.t / 1000);
  const long = p.side === 'long';
  const sideColor = long ? LONG_COLOR : SHORT_COLOR;
  const out: ReplayMarker[] = [];
  const entryMark = (at: number, text: string) =>
    out.push({ time: sec(at), planId: p.id, position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: sideColor, text: withText ? text : '' });
  let tpN = 0;
  const events = p.events.length ? p.events : synthEvents(p);
  for (const e of events) {
    if (e.kind === 'filled') entryMark(e.at, long ? t('多') : t('空'));
    else if (e.kind === 'added') entryMark(e.at, t('加仓'));
    else {
      const m = EVENT_MARK[e.kind];
      if (!m) continue;
      const text = e.kind === 'tp_hit' ? `TP${++tpN}` : m.text();
      out.push({ time: sec(e.at), planId: p.id, position: e.kind === 'tp_hit' ? (long ? 'aboveBar' : 'belowBar') : e.kind === 'sl_hit' || e.kind === 'liquidated' ? (long ? 'belowBar' : 'aboveBar') : 'aboveBar', shape: m.shape, color: m.color, text: withText ? text : '' });
    }
  }
  return out;
}

/** 老数据没有 events 时,用字段拼一份最小事件序列 */
function synthEvents(p: BacktestPlan): BacktestPlan['events'] {
  const ev: BacktestPlan['events'] = [{ at: p.placed_at, kind: 'placed', price: p.entry_price, note: '' }];
  if (p.filled_at !== null) ev.push({ at: p.filled_at, kind: 'filled', price: p.fill_price, note: '' });
  else if (p.status === 'no_fill' && p.expires_at !== null) ev.push({ at: p.expires_at, kind: 'no_fill', price: null, note: '' });
  if (p.exit && p.exit.reason !== 'open') {
    const kind = p.exit.reason === 'sl' ? 'sl_hit' : p.exit.reason === 'tp' ? 'tp_hit' : p.exit.reason === 'liquidation' ? 'liquidated' : p.exit.reason === 'flipped' ? 'flipped' : p.exit.reason === 'rolled' ? 'rolled_out' : 'closed';
    ev.push({ at: p.exit.at, kind, price: p.exit.price, note: '' });
  }
  return ev;
}

/** plans 缺失时的退路:只画 trades 的入场出场点 */
export function tradeMarkers(trades: BacktestTrade[], candles: BacktestCandle[], symbol: string | null): ReplayMarker[] {
  const sec = (at: number) => Math.floor(candles[snapIndex(candles, at)]!.t / 1000);
  const out: ReplayMarker[] = [];
  for (const tr of trades) {
    if (symbol && tr.symbol !== symbol) continue;
    const long = tr.side === 'long';
    out.push({ time: sec(tr.entry_at), planId: tr.id, position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: long ? LONG_COLOR : SHORT_COLOR, text: '' });
    out.push({ time: sec(tr.exit_at), planId: tr.id, position: 'aboveBar', shape: 'circle', color: tr.pnl >= 0 ? TP_COLOR : STOP_COLOR, text: '' });
  }
  return out;
}

export function sortMarkers(ms: ReplayMarker[]): ReplayMarker[] {
  return [...ms].sort((a, b) => a.time - b.time);
}
