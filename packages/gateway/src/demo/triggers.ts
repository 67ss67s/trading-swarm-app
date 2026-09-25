// Code triggers (docs/demo/v3-ui-contract.md §0): deterministic rules that decide WHEN the model is
// worth calling. The model never runs on a bare kline close in triggered mode — it runs when one of
// these fires, when a thread event happens, or when the per-symbol heartbeat is due. Everything here
// is pure so eval can replay it from recorded features.

import type { MarketView, SessionInfo, TriggerHit } from './types.js';
import type { TfFeatures } from './market.js';

export interface TriggerInputs {
  symbol: string;
  /** Features on the scan timeframe for the bar that just closed. */
  now_tf: TfFeatures;
  /** Same timeframe, previous close (null on the first pass after start). */
  prev_tf: TfFeatures | null;
  h1: TfFeatures | null;
  market: MarketView | null;
  session: SessionInfo;
  /** Signed % move over the last ~5 minutes from the mark-price ring buffer (null when unknown). */
  fast_move_pct: number | null;
  /** Workflow threshold for fast_move (decimal %). */
  fast_move_threshold_pct: number;
  /** Previous session name so a window is announced once, not on every close inside it. */
  prev_session: SessionInfo['name'] | null;
}

const fmt = (n: number, d = 2): string => n.toFixed(d);

/** All rules that fired, strongest first. Empty = nothing worth waking the model for. */
export function detectTriggers(inp: TriggerInputs): TriggerHit[] {
  const hits: TriggerHit[] = [];
  const f = inp.now_tf;
  const p = inp.prev_tf;
  const atrPct = f.last_close > 0 ? (f.atr14 / f.last_close) * 100 : 0;

  // 1. fast_move: sudden pump/dump inside 5 minutes (the "it just spiked" case); independent of the bar.
  if (inp.fast_move_pct !== null && Math.abs(inp.fast_move_pct) >= inp.fast_move_threshold_pct) {
    hits.push({ kind: 'fast_move', detail: `5 分钟内 ${inp.fast_move_pct >= 0 ? '急拉' : '急跌'} ${fmt(Math.abs(inp.fast_move_pct))}%(阈值 ${fmt(inp.fast_move_threshold_pct, 1)}%)`, score: Math.min(1, Math.abs(inp.fast_move_pct) / (inp.fast_move_threshold_pct * 2)) });
  }

  // 2. breakout: this close is beyond the previous window's 20-bar high/low.
  if (p) {
    if (f.last_close > p.swing_high_20) hits.push({ kind: 'breakout', detail: `${f.tf} 收盘 ${fmt(f.last_close, dp(f))} 突破前 20 根高点 ${fmt(p.swing_high_20, dp(f))}(量比 ${fmt(f.vol_ratio_20)})`, score: Math.min(1, ((f.last_close - p.swing_high_20) / Math.max(1e-9, f.atr14)) * 0.5 + 0.4) });
    else if (f.last_close < p.swing_low_20) hits.push({ kind: 'breakout', detail: `${f.tf} 收盘 ${fmt(f.last_close, dp(f))} 跌破前 20 根低点 ${fmt(p.swing_low_20, dp(f))}(量比 ${fmt(f.vol_ratio_20)})`, score: Math.min(1, ((p.swing_low_20 - f.last_close) / Math.max(1e-9, f.atr14)) * 0.5 + 0.4) });
  } else if (f.dist_to_high20_pct <= 0.02 && f.change_pct_last > 0) hits.push({ kind: 'breakout', detail: `${f.tf} 收在 20 根高点上(首轮无前值对比)`, score: 0.4 });
  else if (f.dist_to_low20_pct <= 0.02 && f.change_pct_last < 0) hits.push({ kind: 'breakout', detail: `${f.tf} 收在 20 根低点下(首轮无前值对比)`, score: 0.4 });

  // 3. ema_cross on the scan timeframe (EMA20 vs EMA50 flipped since the previous close).
  if (p && Math.sign(f.ema20 - f.ema50) !== Math.sign(p.ema20 - p.ema50) && f.ema20 !== f.ema50) {
    hits.push({ kind: 'ema_cross', detail: `${f.tf} EMA20 ${f.ema20 > f.ema50 ? '上穿' : '下穿'} EMA50(${fmt(f.ema20, dp(f))} vs ${fmt(f.ema50, dp(f))})`, score: 0.6 });
  }

  // 4. vol_spike: volume ≥ 2× the 20-bar average with a real body.
  if (f.vol_ratio_20 >= 2 && Math.abs(f.change_pct_last) >= 0.6 * atrPct && atrPct > 0) {
    hits.push({ kind: 'vol_spike', detail: `${f.tf} 量比 ${fmt(f.vol_ratio_20)},这根 ${f.change_pct_last >= 0 ? '+' : ''}${fmt(f.change_pct_last)}%(ATR ${fmt(atrPct)}%)`, score: Math.min(1, f.vol_ratio_20 / 4) });
  }

  // 5. retest: price came back to EMA20 after having been ≥ 1 ATR away within the last 5 bars, with 1h trend defined.
  const distEma20Pct = f.last_close > 0 ? (Math.abs(f.last_close - f.ema20) / f.last_close) * 100 : 0;
  if (atrPct > 0 && distEma20Pct <= 0.3 * atrPct && Math.abs(f.change_pct_5) >= 1.0 * atrPct && inp.h1 && inp.h1.ema20 !== inp.h1.ema50) {
    hits.push({ kind: 'retest', detail: `${f.tf} 回踩 EMA20 ${fmt(f.ema20, dp(f))}(距 ${fmt(distEma20Pct)}%,近 5 根 ${f.change_pct_5 >= 0 ? '+' : ''}${fmt(f.change_pct_5)}%),1h ${inp.h1.ema20 > inp.h1.ema50 ? '偏多' : '偏空'}`, score: 0.5 });
  }

  // 6. funding: extreme funding often precedes a squeeze either way.
  if (inp.market) {
    const fr = Number(inp.market.funding_rate) * 100;
    if (Math.abs(fr) >= 0.05) hits.push({ kind: 'funding', detail: `资金费率 ${fr >= 0 ? '+' : ''}${fmt(fr, 4)}%(|x| ≥ 0.05%)`, score: Math.min(1, Math.abs(fr) / 0.15) });
  }

  // 7. session: announced once when entering the US open / close window (not on every close inside it).
  if ((inp.session.name === 'us_open_window' || inp.session.name === 'us_close_window') && inp.prev_session !== inp.session.name) {
    hits.push({ kind: 'session', detail: inp.session.text, score: 0.3 });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * 09-12 事件区的触发器入口(docs/design/strategy-loop-v2-and-events-2026-09-12.md §5.2 第 3 步)。
 * 这里只认「这条事件的窗口盖住了现在、而且和这个币有关」这一个事实——窗口判定、资产匹配、状态过滤全在
 * events.ts 里做完了再传进来,triggers.ts 保持纯函数、可被 eval 回放。事件**不下单**,只是把模型叫醒。
 */
export interface EventTriggerInput {
  now: number;
  /** events.ts 的 `EventStore.liveFor(symbol, now)` 结果;调用方已经筛过窗口与资产。 */
  live_events: { source_ref?: string; brief?: { task_id?: string } | null; id: string; subkind: string; title: string; confidence: string; expected_at: number | null; captured_at: number; assets: string[] }[];
}

/** 窗口内的每条事件一个 hit。`confirmed` 的分高于 `rumor`,宏观(assets 空)略低于点名某个币的。 */
export function detectEventTriggers(inp: EventTriggerInput): TriggerHit[] {
  const hits: TriggerHit[] = [];
  for (const e of inp.live_events) {
    const startedAt = e.expected_at ?? e.captured_at;
    const mins = Math.round((inp.now - startedAt) / 60_000);
    const base = e.confidence === 'confirmed' ? 0.8 : e.confidence === 'reported' ? 0.6 : 0.4;
    const score = Math.max(0.2, base - (e.assets.length === 0 ? 0.1 : 0));
    hits.push({ kind: 'event', event_id: e.id, event_subkind: e.subkind, source_ref: e.source_ref, research_task_id: e.brief?.task_id, detail: `事件窗口内:${e.subkind}「${e.title}」(${mins >= 0 ? `已开始 ${mins} 分钟` : `还有 ${-mins} 分钟`},可信度 ${e.confidence})`, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

function dp(f: TfFeatures): number {
  return f.last_close > 100 ? 0 : f.last_close > 1 ? 2 : 5;
}

// ---------- trading sessions (calendar facts the model should not have to infer) ----------

/** Minutes since midnight in a zone, plus weekday (0 = Sunday), DST-aware via Intl. */
function zoned(now: number, timeZone: string): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(now));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '0';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { minutes: hour * 60 + minute, weekday: wd < 0 ? 0 : wd };
}

/**
 * Where we are in the 24h cycle, in plain words. US cash open (09:30 ET) and close (16:00 ET) are the
 * two moments crypto volatility reliably expands; the ±window is what the playbook keys off.
 */
export function sessionInfo(now = Date.now()): SessionInfo {
  const ny = zoned(now, 'America/New_York');
  const ldn = zoned(now, 'Europe/London');
  const weekend = ny.weekday === 0 || ny.weekday === 6;
  const usOpen = 9 * 60 + 30;
  const usClose = 16 * 60;
  const toOpen = weekend ? null : usOpen - ny.minutes;
  const toClose = weekend ? null : usClose - ny.minutes;
  const inUs = !weekend && ny.minutes >= usOpen && ny.minutes < usClose;
  const inLondon = !weekend && ldn.minutes >= 8 * 60 && ldn.minutes < 16 * 60 + 30;
  const asia = zoned(now, 'Asia/Singapore');
  const inAsia = asia.minutes >= 8 * 60 && asia.minutes < 17 * 60;
  let name: SessionInfo['name'] = 'off';
  let text = '亚洲/欧美都收市的清淡时段';
  if (weekend) {
    name = 'weekend';
    text = '周末,传统市场休市,流动性偏低';
  } else if (toOpen !== null && toOpen <= 30 && toOpen > -15) {
    name = 'us_open_window';
    text = toOpen > 0 ? `美股开盘前 ${toOpen} 分钟,开盘前后波动通常放大` : `美股刚开盘 ${-toOpen} 分钟,波动放大、假突破多`;
  } else if (toClose !== null && toClose <= 30 && toClose > -15) {
    name = 'us_close_window';
    text = toClose > 0 ? `美股收盘前 ${toClose} 分钟,收盘前常有方向性成交` : `美股刚收盘 ${-toClose} 分钟`;
  } else if (inUs) {
    name = 'us';
    text = '美股盘中';
  } else if (inLondon) {
    name = 'london';
    text = '伦敦盘中';
  } else if (inAsia) {
    name = 'asia';
    text = '亚洲盘中';
  }
  return { name, text, minutes_to_us_open: toOpen, minutes_to_us_close: toClose, weekend };
}

/** Signed % move between the oldest sample inside `windowMs` and the newest; null if too little history. */
export function windowMovePct(samples: { at: number; mark: number }[], now: number, windowMs: number): number | null {
  const inWindow = samples.filter((s) => now - s.at <= windowMs);
  if (inWindow.length < 2) return null;
  const first = inWindow[0]!;
  const last = inWindow[inWindow.length - 1]!;
  if (now - first.at < windowMs * 0.5) return null; // not enough span to call it a 5-minute move
  return first.mark > 0 ? ((last.mark - first.mark) / first.mark) * 100 : null;
}
