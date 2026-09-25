// `cases/v4-gates`:闸 × 判断边的定向覆盖集(docs/eval/gate-coverage-2026-09-12.md)。
//
// 每个 case 都是「合成 K 线 + 脚本判断」:K 线是确定性的平台 + 一根尖峰,判断写在 playbook 的
// `[[STUB_JUDGMENT]]` 块里由桩大脑原样吐出。零模型成本、零网络、可重放。
// 这些 case 不用来评判断质量(收益/regret 之类对它们没有意义),只用来回答一个问题:
// 每一道闸、每一条合法边,是不是至少有一个用例必然走到。

import { demo } from '@trading-swarm/gateway';
import type { EvalCase, Judgment, Kline, StrategyThread } from './types.js';
import type { GateEnv } from './gate-coverage.js';
// MarketEvent 还没从 demo/index.ts 转出(本轮不动 gateway 源码),走 dist 深路径取类型。
import type { MarketEvent } from '@trading-swarm/gateway/dist/demo/events.js';

const TFS = ['15m', '1h', '4h'] as const;
const BARS = 24;
const SYMBOL = 'BTCUSDT';
const BASE_PRICE = 100000;
const BAR_RANGE = 200; // 每根的高低差,ATR14 ≈ 200
export const GATE_SET = 'v4-gates';
/** 所有 case 共用的 as_of,报告读起来省事;15m/1h/4h 都能整除它。 */
export const GATE_AS_OF = Date.UTC(2026, 8, 1, 0, 0, 0);

const d2 = (x: number): string => x.toFixed(2);

/**
 * 平台 K 线:每根 open=close=price,高低各 ±range/2 → TR 恒为 range,ATR14 = range。
 * `spikeAtr` 给最后一根一个向上的尖峰(收在「前 20 根高点」之上 spikeAtr 个 ATR),
 * 用来把「入场方式」闸的追单距离顶过 1 ATR。
 */
export function flatBars(tf: string, endMs: number, opts: { n?: number; price?: number; range?: number; spikeAtr?: number; drift?: number } = {}): Kline[] {
  const tfMs = demo.tfToMs(tf);
  const n = opts.n ?? BARS;
  const price = opts.price ?? BASE_PRICE;
  const range = opts.range ?? BAR_RANGE;
  const out: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const t = endMs - (n - i) * tfMs;
    const drift = (opts.drift ?? 0) * i * range;
    const isLast = i === n - 1;
    const close = isLast && opts.spikeAtr ? price + drift + range / 2 + opts.spikeAtr * range : price + drift;
    const open = price + drift;
    const high = Math.max(open, close) + range / 2;
    const low = Math.min(open, close) - range / 2;
    out.push({ open_time: t, open: d2(open), high: d2(high), low: d2(low), close: d2(close), volume: (100 + i).toFixed(3), close_time: t + tfMs - 1 });
  }
  return out;
}

/** 隐藏的未来 K 线:必须与可见侧逐字不同(否则 `future_leakage` 会判「可见 bar 抄了未来 bar」)。 */
function futureBars(tf: string, startMs: number, from: number): Kline[] {
  const tfMs = demo.tfToMs(tf);
  const out: Kline[] = [];
  for (let i = 0; i < 8; i++) {
    const t = startMs + i * tfMs;
    const c = from + (i + 1) * 137.31;
    out.push({ open_time: t, open: d2(c - 11.17), high: d2(c + 43.91), low: d2(c - 57.13), close: d2(c), volume: (321.5 + i).toFixed(3), close_time: t + tfMs - 1 });
  }
  return out;
}

function thread(over: Partial<StrategyThread> = {}): StrategyThread {
  return {
    id: 'thr-gate',
    symbol: SYMBOL,
    side: 'long',
    status: 'in_position',
    source: 'agent',
    timeframe: '15m',
    thesis: '合成线程(闸覆盖用例)',
    invalidation_text: '15m 收盘跌破 99000',
    watch_conditions: ['止损是否触及'],
    entry: { type: 'market', price: null, zone: null },
    stop_price: '99000.00',
    take_profits: ['102000.00'],
    qty: '0.100',
    margin_usdt: '3333.33',
    leverage: 3,
    margin_mode: 'cross',
    entry_client_order_id: 'tgd-gatecase-e1',
    protection_client_order_ids: [],
    filled_avg_price: '100000.00',
    realized_pnl: null,
    close_reason: null,
    attention: null,
    entry_lookup_misses: 0,
    leg_seq: 0,
    episode_ids: [],
    intent_ids: [],
    created_at: GATE_AS_OF - 3_600_000,
    updated_at: GATE_AS_OF - 3_600_000,
    opened_at: GATE_AS_OF - 3_600_000,
    closed_at: null,
    version: 2,
    ...over,
  } as StrategyThread;
}

const JUDGMENT = (over: Partial<Judgment>): Judgment => ({
  action: 'NO_TRADE',
  direction: null,
  confidence: 0.5,
  headline: '闸覆盖用例的脚本判断',
  thesis: '这是 cases/v4-gates 的脚本判断,只为把某一道闸或某一条边逼到必然触发。',
  reasons: ['脚本判断 [E1]'],
  evidence_refs: ['E1'],
  invalidation: null,
  invalidation_price: null,
  target_price: null,
  watch_conditions: ['下一次重跑闸覆盖'],
  proposal: null,
  ...over,
});

/** 一个能过契约、必然被开仓闸检查的多头提议。 */
const PROPOSE = (over: Partial<Judgment> = {}, proposal: Partial<NonNullable<Judgment['proposal']>> = {}): Judgment =>
  JUDGMENT({
    action: 'PROPOSE',
    direction: 'long',
    confidence: 0.7,
    reasons: ['脚本提议,用于触发开仓闸 [E1]'],
    proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '99000.00', take_profits: ['102000.00'], rationale: '脚本提议', ...proposal } as NonNullable<Judgment['proposal']>,
    ...over,
  });

const PLAYBOOK = '闸覆盖用例(cases/v4-gates):判断由脚本给定,不走 playbook 推理。';

function scriptPlaybook(j: Judgment): string {
  return `${PLAYBOOK}\n[[STUB_JUDGMENT]]${JSON.stringify(j)}[[/STUB_JUDGMENT]]`;
}

interface CaseSpec {
  id: string;
  mode: 'scan' | 'review';
  judgment: Judgment;
  covers: string[];
  tags?: string[];
  thread?: StrategyThread | null;
  halted?: boolean;
  gate_env?: GateEnv;
  positions?: { symbol: string; side: 'long' | 'short'; qty: string; entry_price: string; mark_price: string; unrealized_pnl: string; leverage: number }[];
  /** 行情快照比 as_of 早多少毫秒(> 3 分钟即过期)。 */
  market_age_ms?: number;
  spikeAtr?: number;
}

function buildCase(spec: CaseSpec): EvalCase {
  const asOf = GATE_AS_OF;
  const klines: Record<string, Kline[]> = {};
  for (const tf of TFS) klines[tf] = flatBars(tf, asOf, tf === '15m' ? { spikeAtr: spec.spikeAtr } : {});
  const base = klines['15m']!;
  const last = Number(base[base.length - 1]!.close);
  const positions = spec.positions ?? [];
  return {
    id: spec.id,
    set: GATE_SET,
    meta: { set: GATE_SET },
    tags: [GATE_SET, spec.mode, ...(spec.tags ?? [])],
    symbol: SYMBOL,
    timeframe: '15m',
    as_of: asOf,
    mode: spec.mode,
    thread: spec.thread ?? null,
    visible: {
      klines,
      market: { symbol: SYMBOL, last: d2(last), mark: d2(last), funding_rate: '0.00010000', next_funding_at: asOf + 3_600_000, open_interest: '12345.678', as_of: asOf - (spec.market_age_ms ?? 0), klines_tf: '15m' },
      ticker24h: { priceChangePercent: '1.234', highPrice: d2(last + 900), lowPrice: d2(last - 900), quoteVolume: '9876543210.12' },
      oi_change_1h_pct: null,
      market_state: null,
      account: { backend: 'paper', equity: '10000.00', available: '9000.00', unrealized_pnl: '0.00', positions, open_orders: [], as_of: asOf },
      playbook_text: scriptPlaybook(spec.judgment),
      last_judgment_summary: null,
      halted: spec.halted ?? false,
      stale_all: false,
      ...(spec.gate_env ? { gate_env: spec.gate_env } : {}),
    },
    hidden: { future_klines: futureBars('15m', asOf, last), horizon_bars: 8, rubric: null, mirror_of: null, covers: spec.covers },
  };
}

/**
 * §9.30 的合成事件:宏观(assets 为空 → 触达所有币),窗口把 `GATE_AS_OF` 夹在正中间,
 * 所以 `event_blackout_min > 0` 时必然落在封锁窗口里。
 */
function blackoutEvent(): MarketEvent {
  const start = GATE_AS_OF - 10 * 60_000;
  return {
    id: 'evt-gate-cpi',
    kind: 'scheduled',
    subkind: 'cpi',
    assets: [],
    expected_at: start,
    window_ms: 2 * 3_600_000,
    captured_at: GATE_AS_OF - 6 * 3_600_000,
    source: 'calendar',
    source_ref: 'gate-case',
    confidence: 'confirmed',
    status: 'captured',
    brief: null,
    impact: null,
    used_by: [],
    title: '美国 CPI(闸覆盖合成事件)',
    dedupe_key: 'gate-case:cpi',
    briefs: [],
    brief_count: 0,
    updated_at: GATE_AS_OF - 6 * 3_600_000,
    resolved_at: null,
    dismissed_at: null,
  };
}

/** 一个议会结果;`consensus` 的字段由用例覆写,其余走「两条策略都同意做多」的底子。 */
function council(consensus: Partial<demo.CouncilResult['consensus']>): demo.CouncilResult {
  return {
    version: 'council-gate-case',
    at: GATE_AS_OF,
    symbol: SYMBOL,
    mode: 'require',
    verdicts: [],
    consensus: {
      reached: true,
      direction: 'long',
      agreeing: ['trend-follow', 'breakout'],
      dissenting: [],
      neutral: [],
      abstaining: [],
      required: 2,
      voting: ['trend-follow', 'breakout'],
      gate_effective: true,
      gate_reason: '',
      entry_timing: 'confirmed',
      reason: '2/2 同意做多',
      ...consensus,
    },
    text: '议会(闸覆盖用例):脚本给定的共识结果。',
  };
}

const POS = [{ symbol: SYMBOL, side: 'long' as const, qty: '0.100', entry_price: '99500.00', mark_price: '100000.00', unrealized_pnl: '50.00', leverage: 3 }];

/** 判断图登记的 16 道闸,每道一个必然踩线的用例。 */
function guardCases(): EvalCase[] {
  return [
    buildCase({ id: 'gate-halt', mode: 'scan', halted: true, judgment: PROPOSE(), covers: ['guard:halt'], gate_env: {} }),
    buildCase({ id: 'gate-paused', mode: 'scan', judgment: PROPOSE(), covers: ['guard:paused'], gate_env: { paused: true } }),
    buildCase({ id: 'gate-fresh-evidence', mode: 'scan', judgment: PROPOSE(), covers: ['guard:fresh_evidence'], gate_env: {}, market_age_ms: 10 * 60_000, tags: ['stale-snapshot'] }),
    buildCase({ id: 'gate-no-position', mode: 'scan', judgment: PROPOSE(), covers: ['guard:no_position'], gate_env: {}, positions: POS }),
    buildCase({ id: 'gate-daily-open-cap', mode: 'scan', judgment: PROPOSE(), covers: ['guard:daily_open_cap'], gate_env: { opens_today: 2 } }),
    buildCase({ id: 'gate-stop-side', mode: 'scan', judgment: PROPOSE({}, { stop_price: '101500.00' }), covers: ['guard:stop_side'], gate_env: {} }),
    buildCase({ id: 'gate-stop-distance', mode: 'scan', judgment: PROPOSE({}, { stop_price: '99950.00' }), covers: ['guard:stop_distance'], gate_env: {} }),
    buildCase({ id: 'gate-tp-side', mode: 'scan', judgment: PROPOSE({}, { take_profit_price: '98000.00', take_profits: ['98000.00'] } as never), covers: ['guard:tp_side'], gate_env: {} }),
    buildCase({ id: 'gate-confidence-floor', mode: 'scan', judgment: PROPOSE({ confidence: 0.3 }), covers: ['guard:confidence_floor'], gate_env: {} }),
    buildCase({ id: 'gate-no-add', mode: 'scan', judgment: JUDGMENT({ action: 'ADD', direction: 'long', confidence: 0.6, reasons: ['脚本 ADD,用于触发「演示版不加仓」 [E1]'] }), covers: ['guard:no_add'], gate_env: {} }),
    buildCase({ id: 'gate-thread-limits', mode: 'scan', judgment: PROPOSE(), covers: ['guard:thread_limits'], gate_env: { other_threads: [thread({ id: 'thr-other-same-symbol' })] } }),
    buildCase({ id: 'gate-no-unknown-orders', mode: 'scan', judgment: PROPOSE(), covers: ['guard:no_unknown_orders'], gate_env: { unknown_intent: true } }),
    buildCase({ id: 'gate-strategy-consensus', mode: 'scan', judgment: PROPOSE(), covers: ['guard:strategy_consensus'], gate_env: { council_mode: 'require', council: null } }),
    buildCase({ id: 'gate-entry-style', mode: 'scan', judgment: PROPOSE(), covers: ['guard:entry_style'], gate_env: { entry_style: 'prefer_limit' }, spikeAtr: 2 }),
    buildCase({ id: 'gate-preflight', mode: 'scan', judgment: PROPOSE(), covers: ['guard:preflight'], gate_env: { preflight: true }, positions: POS }),
    buildCase({ id: 'gate-thread-still-open', mode: 'review', thread: thread({ status: 'closed', closed_at: GATE_AS_OF - 60_000 }), judgment: JUDGMENT({ action: 'HOLD', direction: 'long', reasons: ['脚本 HOLD,线程已结束 [E1]'] }), covers: ['guard:thread_still_open'], gate_env: {} }),
  ];
}

/**
 * 09-12 晚合并进来的三道闸 / 判定,判断图的 guards 表还没登记它们(见 `EXTENSION_GATE_INVENTORY`)。
 * 规矩一样:每一行一个必然踩线的用例;另外两个「必然放行」的对照用例钉住语义的另一半
 * (事件封锁不拦平仓、entry_timing=pending 时限价放行)。
 */
function extensionGateCases(): EvalCase[] {
  const pendingCouncil = council({ entry_timing: 'pending', reason: '2/2 同意做多,但回踩未确认' });
  return [
    // §9.31:本币在这条通道上从没验证过能挂止损 → 提交前重闸按币阻断。
    // 故意不给持仓,好让「提交前重闸」的拒绝理由里只有保护腿这一条。
    buildCase({
      id: 'gate-protection-never-verified',
      mode: 'scan',
      judgment: PROPOSE(),
      covers: ['guard:protection_never_verified'],
      gate_env: { preflight: true, protection_state: 'never_verified', channel: 'binance-live' },
    }),
    // §9.30:封锁窗口内的开仓被拒。
    buildCase({
      id: 'gate-event-blackout',
      mode: 'scan',
      judgment: PROPOSE(),
      covers: ['guard:event_blackout'],
      gate_env: { event_blackout_min: 60, events: [blackoutEvent()] },
    }),
    // §9.30 的另一半:同一个封锁窗口,平仓永远放行(不能把人困在仓位里)。
    buildCase({
      id: 'gate-event-blackout-exit-allowed',
      mode: 'review',
      thread: thread(),
      positions: POS,
      judgment: JUDGMENT({ action: 'EXIT', direction: 'long', reasons: ['封锁窗口内离场,事件封锁不拦平仓 [E1]'] }),
      covers: ['gate_pass:event_blackout_exit'],
      gate_env: { event_blackout_min: 60, events: [blackoutEvent()] },
    }),
    // §9.25 补正三:min_agree(3)超过能投票的策略数(2)→ gate_effective=false,require 下拒。
    buildCase({
      id: 'gate-council-gate-effective',
      mode: 'scan',
      judgment: PROPOSE(),
      covers: ['guard:council_gate_effective'],
      gate_env: {
        council_mode: 'require',
        council: council({ reached: false, direction: null, agreeing: [], required: 3, voting: ['trend-follow', 'breakout'], gate_effective: false, gate_reason: '共识闸当前无效:min_agree 3 > 能投票的策略数 2', entry_timing: null, reason: '共识闸当前无效:min_agree 3 > 能投票的策略数 2' }),
      },
    }),
    // §9.25b:方向成立但 entry_timing=pending,市价被拒。
    buildCase({
      id: 'gate-council-entry-timing',
      mode: 'scan',
      judgment: PROPOSE({}, { entry: 'market' }),
      covers: ['guard:council_entry_timing'],
      gate_env: { council_mode: 'require', council: pendingCouncil },
    }),
    // §9.25b 的另一半:同一个议会结果,限价提议放行。
    buildCase({
      id: 'gate-council-entry-timing-limit-allowed',
      mode: 'scan',
      judgment: PROPOSE({}, { entry: 'limit', limit_price: '99700.00', entry_zone: ['99600.00', '99800.00'] }),
      covers: ['gate_pass:council_entry_timing_limit'],
      gate_env: { council_mode: 'require', council: pendingCouncil },
    }),
  ];
}

const EDGE_JUDGMENT: Record<string, Judgment> = {
  'scan.NO_TRADE': JUDGMENT({ action: 'NO_TRADE' }),
  'scan.WATCH': JUDGMENT({ action: 'WATCH', direction: 'long', reasons: ['脚本 WATCH [E1]'] }),
  'scan.PROPOSE': PROPOSE(),
  'halted.NO_TRADE': JUDGMENT({ action: 'NO_TRADE' }),
  'stale.NO_TRADE': JUDGMENT({ action: 'NO_TRADE' }),
  'stale.WATCH': JUDGMENT({ action: 'WATCH', direction: 'long', reasons: ['脚本 WATCH [E1]'] }),
  'watch_only.NO_TRADE': JUDGMENT({ action: 'NO_TRADE' }),
  'watch_only.WATCH': JUDGMENT({ action: 'WATCH', direction: 'long', reasons: ['脚本 WATCH [E1]'] }),
  'pending.HOLD': JUDGMENT({ action: 'HOLD', direction: 'long', reasons: ['脚本 HOLD [E1]'] }),
  'pending.INVALIDATE': JUDGMENT({ action: 'INVALIDATE', direction: 'long', reasons: ['脚本 INVALIDATE [E1]'] }),
  'position.HOLD': JUDGMENT({ action: 'HOLD', direction: 'long', reasons: ['脚本 HOLD [E1]'] }),
  'position.REDUCE': JUDGMENT({ action: 'REDUCE', direction: 'long', reasons: ['脚本 REDUCE [E1]'] }),
  'position.EXIT': JUDGMENT({ action: 'EXIT', direction: 'long', reasons: ['脚本 EXIT [E1]'] }),
  'position.INVALIDATE': JUDGMENT({ action: 'INVALIDATE', direction: 'long', reasons: ['脚本 INVALIDATE [E1]'] }),
};

/** 14 条模型边,每条一个 case。 */
function edgeCases(): EvalCase[] {
  const out: EvalCase[] = [];
  for (const e of demo.JUDGMENT_GRAPH.model_edges) {
    const j = EDGE_JUDGMENT[e.id];
    if (!j) continue;
    const id = `edge-${e.id.replace(/\./g, '-').toLowerCase()}`;
    const covers = [`model_edge:${e.id}`];
    if (e.from === 'review:pending_entry') out.push(buildCase({ id, mode: 'review', thread: thread({ status: 'pending_entry', entry: { type: 'limit', price: '99500.00', zone: ['99400.00', '99600.00'] }, filled_avg_price: null }), judgment: j, covers, tags: ['trigger:thread_review'] }));
    else if (e.from === 'review:in_position') out.push(buildCase({ id, mode: 'review', thread: thread(), judgment: j, covers, positions: POS, tags: ['trigger:position_review'] }));
    else if (e.from === 'scan:halted') out.push(buildCase({ id, mode: 'scan', halted: true, judgment: j, covers }));
    else if (e.from === 'scan:stale') out.push(buildCase({ id, mode: 'scan', judgment: j, covers, market_age_ms: 10 * 60_000, tags: ['stale-snapshot'] }));
    else if (e.from === 'scan:watch_only') out.push(buildCase({ id, mode: 'scan', judgment: j, covers, tags: ['watch_only'] }));
    else out.push(buildCase({ id, mode: 'scan', judgment: j, covers }));
  }
  return out;
}

/** 每条事件边一个 case:`trigger:<kind>` 标签决定 `inputs.triggerFor` 给出的 kind。 */
function eventCases(): EvalCase[] {
  const out: EvalCase[] = [];
  for (const e of demo.JUDGMENT_GRAPH.event_edges) {
    const id = `evt-${e.from}-${e.event}`.toLowerCase();
    const covers = [`event_edge:${e.id}`];
    const tags = [`trigger:${e.event}`];
    if (e.from === 'none') out.push(buildCase({ id, mode: 'scan', judgment: EDGE_JUDGMENT['scan.NO_TRADE']!, covers, tags }));
    else if (e.from === 'pending_entry') out.push(buildCase({ id, mode: 'review', thread: thread({ status: 'pending_entry', entry: { type: 'limit', price: '99500.00', zone: ['99400.00', '99600.00'] }, filled_avg_price: null }), judgment: EDGE_JUDGMENT['pending.HOLD']!, covers, tags }));
    else out.push(buildCase({ id, mode: 'review', thread: thread(), judgment: EDGE_JUDGMENT['position.HOLD']!, covers, tags, positions: POS }));
  }
  return out;
}

/** 全部定向 case,按 id 排序(生成是纯函数,同一版代码两次生成逐字相同)。 */
export function generateGateCases(): EvalCase[] {
  return [...guardCases(), ...extensionGateCases(), ...edgeCases(), ...eventCases()].sort((a, b) => a.id.localeCompare(b.id));
}
