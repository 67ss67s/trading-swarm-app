// 多周期原语(2026-09-23 夜):htf_ma_state(高周期均线上下)、macd_divergence / macd_divergence_exit 的 htf 与 direction 参数。
// 第一段是旧口径钉子:改动前实测的结果哈希——不用新参数的 IR 走 engine v5 快路径、v3 慢路径、订单周期执行核(现货 + 永续多空)逐字节不变。
import { describe, it, expect } from 'vitest';
import type { ResearchRequest, StrategyIR } from '@trading-swarm/contracts';
import { runReplay } from '../../../src/demo/research/engine.js';
import { runOrderPath } from '../../../src/demo/research/orders/index.js';
import { DEFAULT_ORDER_GATE, orderGateFor } from '../../../src/demo/research/order-gate.js';
import { hash } from '../../../src/demo/research/primitives.js';
import { node } from '../../../src/demo/research/strategy.js';
import { synthDataset } from './backtest-report-fixtures.js';

const H1 = 3600000;
const d = synthDataset(1500, H1, 'BTCUSDT', 23);
const macdP = { fast: 12, slow: 26, signal: 9, swing_length: 3, lookback: 60, source: 'histogram' };
const divIR = (order?: StrategyIR['order']): StrategyIR => ({
  version: 1, label: 'MACD 底背离', description: '1h MACD 底背离入场,顶背离离场;持有数十根,每 1000 根约 5 个信号',
  signal: [node('macd_divergence', macdP)], entry: node('next_open_market', {}),
  risk: { stop: node('pivot_stop', { swing_length: 3 }), sizing: node('equal_notional', { max_allocation: '1' }) },
  exit: [node('macd_divergence_exit', macdP), node('chandelier_trail', { atr_period: 22, multiple: 3 })],
  regime: node('trend_state', { adx_period: 14, adx_min: 15, ema_fast: 20, ema_slow: 50, htf: '4h' }),
  ...(order ? { order } : {}),
});
const bothOrder: StrategyIR['order'] = { direction: 'both', market: 'perp', leverage: 1, short_signal: [node('donchian_breakout', { lookback: 20, basis: 'close', direction: 'down' })] };
const req = (ir: StrategyIR, fast = true): ResearchRequest => ({ idempotency_key: 'pin', dataset_id: 'pin', study_id: 'pin', strategy_ir: ir, execution: { initial_cash: '10000', risk_fraction: '0.01', max_allocation: '1', fee_rate: '0.001', slippage_bps: '5', qty_step: '0.00000001', min_notional: '5', max_opens_per_day: 10, sizing_mode: 'unit_notional' }, order_gate: { ...DEFAULT_ORDER_GATE }, from_ms: d.bars[300]!.close_time, to_ms: d.bars[1490]!.close_time, arms: ['a_rules'], repeats: 1, max_model_calls: 0, timeout_ms: 60000, purpose: 'development', acknowledge_adaptive_search: true, ...(fast ? { spec_version: 'strategy-spec/v2;engine=v4' } : {}) }) as ResearchRequest;
const none = async () => { throw new Error('no model'); };
const armHash = (r: Awaited<ReturnType<typeof runReplay>>) => hash({ v: r.engine_version, s: r.status, arms: r.arms.map((a) => ({ m: a.metrics, t: a.trades, e: a.equity, d: a.decisions.map((x) => [x.at, x.action, x.reason, x.gate_errors, x.input_hash, x.decision_hash]) })) });
const orderRun = (ir: StrategyIR) => runOrderPath({ ir, bars: d.bars, timeframe_ms: H1, symbol: 'BTCUSDT', from_index: 300, to_index: 1490, initial_cash: 10000, ...(ir.order?.market === 'perp' ? {} : { fee_rate: '0.001' }), slippage_bps: '5', gate: orderGateFor(ir, DEFAULT_ORDER_GATE) });
const orderHash = (o: ReturnType<typeof orderRun>) => hash({ v: o.engine_version, plans: o.plans, stats: o.stats, notes: o.notes, equity: o.equity, trades: o.trades });

describe('多周期参数接入前后,不用新参数的 IR 结果逐字节不变', () => {
  it('engine v5 快路径 / v3 慢路径 / 订单执行核(现货做多、永续多空)的结果哈希钉住', async () => {
    const got: Record<string, string> = {};
    got.div_v5 = armHash(await runReplay(d, req(divIR()), none, { fast: true }));
    got.div_v3 = armHash(await runReplay(d, req(divIR(), false), none, { fast: false }));
    got.orders_spot = orderHash(orderRun(divIR({ direction: 'long', market: 'spot' })));
    got.orders_perp_both = orderHash(orderRun(divIR(bothOrder)));
    const { regime: _r, ...bare } = divIR();
    const bareRun = await runReplay(d, req(bare), none, { fast: true });
    got.div_bare_v5 = armHash(bareRun);
    got.trades = String(bareRun.arms[0]!.trades.length) + '/' + orderRun(divIR(bothOrder)).plans.length;
    expect(got).toMatchInlineSnapshot(`
      {
        "div_bare_v5": "e9be54c28b5024027a04053160d3814b68417ee1cba064dd14ad916f61cd35f6",
        "div_v3": "f22ddd7b975e5ac2838160526a51b6bc683d810cba7f8c76d16d2bb751f1ee2a",
        "div_v5": "9971b05215cfa0cfe05c735dc1681923703406af6177278870f81d229376e839",
        "orders_perp_both": "87eb7bd4c1870db95f07c4d53fa85c0606e52ce489b8b306d4506ee95d1995ac",
        "orders_spot": "7ffc77b1c204f2f3b20294c23e8e1ea6f64e136ea1b5047989172e471747d8d6",
        "trades": "17/70",
      }
    `);
  }, 180000);
});

// ── 以下是新原语 / 新参数本身的行为 ────────────────────────────────────────────

import type { ResearchBar } from '@trading-swarm/contracts';
import { checkIR, irWarmup, irHistoryBars } from '../../../src/demo/research/strategy.js';
import { registry } from '../../../src/demo/research/primitives/index.js';
import { htfSeries, htfMaStates, htfMaParams } from '../../../src/demo/research/primitives/htf.js';
import { htfDivergenceFlags, macdDivergence } from '../../../src/demo/research/primitives/signals.js';
import { orderIntents } from '../../../src/demo/research/orders/intents.js';
import { viewBars } from '../../../src/demo/research/engine.js';
import { synthBars } from './backtest-report-fixtures.js';

const M15 = 15 * 60000, DAY = 86400000;
// 从 2025-12-31 18:00 起(桶中间开头:首个日线桶不完整,应被跳过),约 110 天 15m
const m15 = synthBars(96 * 110, M15, 41, Date.UTC(2025, 11, 31, 18));
/** 蛮力参照:只用 bars[0..i] 现场聚合完整高周期 K 线(与实现无共享代码) */
function bruteHtf(bars: ResearchBar[], i: number, base: number, target: number): { close: number; high: number; low: number; open: number }[] {
  const groups = new Map<number, ResearchBar[]>();
  for (const b of bars.slice(0, i + 1)) { const k = Math.floor(b.open_time / target) * target; groups.set(k, [...(groups.get(k) ?? []), b]); }
  return [...groups].filter(([k, v]) => v.length === target / base && v.every((b, j) => b.open_time === k + j * base) && v.at(-1)!.close_time === k + target - 1)
    .map(([, v]) => ({ open: Number(v[0]!.open), high: Math.max(...v.map((b) => Number(b.high))), low: Math.min(...v.map((b) => Number(b.low))), close: Number(v.at(-1)!.close) }));
}
const maIR = (): StrategyIR => ({
  version: 1, label: 'MA60 主导多空', description: '日线 SMA60 定方向,4h MACD 背离触发,15m 执行;持有数十根,每 1000 根约 1 个信号(待验证)',
  signal: [node('macd_divergence', { ...macdP, htf: '4h' })], entry: node('next_open_market', {}),
  risk: { stop: node('pivot_stop', { swing_length: 3 }), sizing: node('equal_notional', { max_allocation: '1' }) },
  exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 })],
  regime: node('htf_ma_state', { htf: '1d', period: 60, ma: 'sma', side: 'above' }),
  order: { direction: 'both', market: 'perp', leverage: 1, short_signal: [node('macd_divergence', { ...macdP, htf: '4h', direction: 'bearish' })], short_regime: node('htf_ma_state', { htf: '1d', period: 60, ma: 'sma', side: 'below' }) },
});

describe('htf_ma_state / macd_divergence{htf,direction}:登记与检查', () => {
  it('登记为 regime,视图预热 0、历史需求走 history_bars;15m + 日线 SMA60 + 4h 背离过 checkIR(旧口径 5000 根上限不再卡)', () => {
    const p = registry.get('htf_ma_state')!;
    expect(p.category).toBe('regime');
    expect(p.warmup_bars({ htf: '1d', period: 60 }, M15)).toBe(0);
    expect(p.history_bars!({ htf: '1d', period: 60 }, M15)).toBe(62 * 96);
    expect(registry.get('macd_divergence')!.warmup_bars(macdP, M15)).toBe(26 + 9 + 60 + 6 + 1); // 不带 htf = 旧预热
    expect(registry.get('macd_divergence')!.history_bars!(macdP, M15)).toBe(0);
    expect(registry.get('macd_divergence')!.warmup_bars({ ...macdP, htf: '4h' }, M15)).toBe(0);
    expect(registry.get('macd_divergence')!.history_bars!({ ...macdP, htf: '4h' }, M15)).toBe((26 + 9 + 60 + 6 + 1 + 1) * 16);
    const r = checkIR(maIR(), '15m');
    expect(r.ok, JSON.stringify(r.checks)).toBe(true);
    expect(irWarmup(maIR(), M15)).toBeLessThan(5000);
    expect(viewBars(maIR(), { lookback: 1, atr_period: 1 } as never, M15)).toBe(Math.min(5000, Math.max(500, 6 * irWarmup(maIR(), M15))));
    expect(irHistoryBars(maIR(), M15)).toBe(62 * 96);
    expect(irHistoryBars(divIR(), H1)).toBe(0); // 旧 IR 不多借数据
    // 高周期低于执行周期、未知参数、越界参数判死
    const bad = (regime: StrategyIR['regime']) => checkIR({ ...maIR(), regime }, '15m').ok;
    expect(bad(node('htf_ma_state', { htf: '5m', period: 60 }))).toBe(false);
    expect(bad(node('htf_ma_state', { htf: '1d', period: 1 }))).toBe(false);
    expect(bad(node('htf_ma_state', { htf: '1d', period: 60, side: 'up' }))).toBe(false);
    expect(bad(node('htf_ma_state', { htf: '1d', period: 60, lookback: 3 }))).toBe(false);
    expect(checkIR({ ...maIR(), signal: [node('macd_divergence', { ...macdP, direction: 'down' })] }, '15m').ok).toBe(false);
  });
});

describe('高周期分桶:只用已收盘的完整桶', () => {
  it('聚合与蛮力参照逐根一致;首个不完整日线桶、中间缺根的桶整桶跳过', () => {
    const holed = m15.filter((_, i) => i !== 96 * 5 + 40); // 第 6 天中间缺一根
    for (const bars of [m15, holed]) {
      const h = htfSeries(bars, M15, '1d');
      for (const i of [0, 23, 24, 95, 96 * 3 + 23, 96 * 5 + 30, 96 * 6 + 22, 96 * 6 + 23, 96 * 40 + 7, bars.length - 1]) {
        const want = bruteHtf(bars, i, M15, DAY), j = h.last[i]!;
        expect(j + 1, `i=${i}`).toBe(want.length);
        if (j >= 0) expect({ open: Number(h.bars[j]!.open), high: Number(h.bars[j]!.high), low: Number(h.bars[j]!.low), close: Number(h.bars[j]!.close) }).toEqual(want.at(-1));
      }
      // 日线 K 线在它最后一根 15m(UTC 23:45)收盘时才出现
      for (const [k, e] of h.end.entries()) expect(bars[e]!.close_time).toBe(Number(h.bars[k]!.close_time));
    }
    expect(htfSeries(m15, M15, '1d').bars[0]!.open_time).toBe(Date.UTC(2026, 0, 1)); // 2025-12-31 18:00 起的首桶不完整
    expect(htfSeries(holed, M15, '1d').bars.length).toBe(htfSeries(m15, M15, '1d').bars.length - 1);
  });
  it('htf_ma_state 与蛮力 SMA/EMA 逐根同号;历史不足 period 根时不成立', () => {
    for (const ma of ['sma', 'ema'] as const) {
      const p = htfMaParams({ htf: '1d', period: 60, ma }), st = htfMaStates(m15, M15, p);
      let checked = 0, nonzero = 0;
      for (let i = 0; i < m15.length; i += 97) {
        const closes = bruteHtf(m15, i, M15, DAY).map((b) => b.close);
        let want = 0;
        if (closes.length >= 60) {
          let line: number;
          if (ma === 'sma') line = closes.slice(-60).reduce((a, b) => a + b, 0) / 60;
          else { const k = 2 / 61; line = closes.reduce((e, c, j) => (j === 0 ? c : c * k + e * (1 - k)), 0); }
          want = closes.at(-1)! > line ? 1 : closes.at(-1)! < line ? -1 : 0;
        }
        expect(st[i], `${ma} i=${i}`).toBe(want); checked++; if (want) nonzero++;
      }
      expect(checked).toBeGreaterThan(100);
      expect(nonzero).toBeGreaterThan(30);
    }
  });
});

describe('因果性:改掉 t 之后的数据,t 及以前的信号不变', () => {
  const perturb = (bars: ResearchBar[], t: number) => bars.map((b, i) => (i <= t ? b : { ...b, open: String(Number(b.open) * 1.3), high: String(Number(b.high) * 1.5), low: String(Number(b.low) * 0.6), close: String(Number(b.close) * (i % 2 ? 1.4 : 0.7)) }));
  it('htf_ma_state 状态、4h 底/顶背离触发(整段 series 与原语入口)逐根相同', () => {
    for (const t of [96 * 70 + 13, 96 * 90 + 95, 96 * 100 + 50]) {
      const alt = perturb(m15, t);
      for (const side of ['above', 'below'] as const) {
        const p = { htf: '1d', period: 60, side }, prim = registry.get('htf_ma_state')!;
        const a = htfMaStates(m15, M15, htfMaParams(p)), b = htfMaStates(alt, M15, htfMaParams(p));
        expect([...a.slice(0, t + 1)]).toEqual([...b.slice(0, t + 1)]);
        for (let i = t - 400; i <= t; i += 7) {
          const ctx = (s: ResearchBar[]) => ({ bars: s.slice(i - 499, i + 1), i: 499, timeframe_ms: M15, series: s, series_i: i });
          expect(prim.compute(ctx(alt), p).pass).toBe(prim.compute(ctx(m15), p).pass);
        }
      }
      for (const kind of ['bullish', 'bearish'] as const) {
        const a = htfDivergenceFlags(m15, M15, '4h', macdP, kind), b = htfDivergenceFlags(alt, M15, '4h', macdP, kind);
        expect([...a.slice(0, t + 1)]).toEqual([...b.slice(0, t + 1)]);
      }
      // 扰动确实改变了 t 之后的结果(否则这个测试什么也没测)
      expect([...htfMaStates(alt, M15, htfMaParams({ htf: '1d', period: 60 })).slice(t + 1)]).not.toEqual([...htfMaStates(m15, M15, htfMaParams({ htf: '1d', period: 60 })).slice(t + 1)]);
    }
  });
});

describe('高周期背离:与「在高周期 K 线上截前缀调 macdDivergence」逐根一致', () => {
  it('1h → 4h,底背离与顶背离;触发只在收完那根 4h 的 1h K 线上', () => {
    const h1 = synthBars(6000, H1, 5, Date.UTC(2025, 0, 1)), h = htfSeries(h1, H1, '4h');
    for (const kind of ['bullish', 'bearish'] as const) {
      const flags = htfDivergenceFlags(h1, H1, '4h', macdP, kind);
      let hits = 0;
      for (let k = 0; k < h.bars.length; k++) {
        const want = macdDivergence(h.bars.slice(0, k + 1), macdP, kind);
        expect(flags[h.end[k]!] === 1, `${kind} k=${k}`).toBe(want);
        if (want) hits++;
      }
      expect(hits).toBeGreaterThan(5);
      // 非 4h 收盘根永远不触发
      const ends = new Set(h.end);
      expect(flags.every((f, i) => f === 0 || ends.has(i))).toBe(true);
      // 原语入口:signal(direction)与 exit 走同一结果
      const sig = registry.get('macd_divergence')!, ex = registry.get('macd_divergence_exit')!;
      for (let i = 1000; i < 6000; i += 1) {
        if (!flags[i] && i % 13) continue;
        const ctx = { bars: h1.slice(i - 499, i + 1), i: 499, timeframe_ms: H1, series: h1, series_i: i };
        expect(sig.compute(ctx, { ...macdP, htf: '4h', ...(kind === 'bearish' ? { direction: 'bearish' } : {}) }).pass).toBe(flags[i] === 1);
        if (kind === 'bearish') expect(ex.compute({ ...ctx, position: { entry_at: 0, entry_price: 1, initial_distance: 1, bars_held: 1 } }, { ...macdP, htf: '4h' }).exit).toBe(flags[i] === 1);
      }
    }
  });
  it('direction=bearish 不带 htf = 执行周期上的顶背离(与离场原语同一判定)', () => {
    const sig = registry.get('macd_divergence')!, ex = registry.get('macd_divergence_exit')!;
    let hits = 0;
    for (let i = 200; i < d.bars.length; i++) {
      const ctx = { bars: d.bars, i, timeframe_ms: H1 };
      const a = sig.compute(ctx, { ...macdP, direction: 'bearish' }).pass, b = ex.compute({ ...ctx, position: { entry_at: 0, entry_price: 1, initial_distance: 1, bars_held: 1 } }, macdP).exit;
      expect(a).toBe(b); if (a) hits++;
    }
    expect(hits).toBeGreaterThan(3);
  });
});

describe('做空方向门:short_regime=htf_ma_state{side:below}', () => {
  const trig = (extra: Partial<NonNullable<StrategyIR['order']>> = {}, regime: StrategyIR['regime'] = node('htf_ma_state', { htf: '1d', period: 20, side: 'above' })): StrategyIR => ({
    ...maIR(), signal: [node('donchian_breakout', { lookback: 8, basis: 'close' })], regime,
    order: { direction: 'both', market: 'perp', leverage: 1, short_signal: [node('donchian_breakout', { lookback: 8, basis: 'close', direction: 'down' })], short_regime: node('htf_ma_state', { htf: '1d', period: 20, side: 'below' }), ...extra },
  });
  const run = (ir: StrategyIR) => orderIntents(ir, m15, M15, { fee_rate: '0.0005', slippage_bps: '5', from_index: 96 * 30, to_index: m15.length - 1, view: 500 });
  it('做多只在日线收盘在 MA 之上时出现,做空只在之下时出现,两侧都有', () => {
    const st = htfMaStates(m15, M15, htfMaParams({ htf: '1d', period: 20 }));
    const { intents } = run(trig());
    let long = 0, short = 0;
    intents.forEach((x, j) => { if (!x) return; const i = 96 * 30 + j; if (x.side === 'long') { long++; expect(st[i]).toBe(1); } else { short++; expect(st[i]).toBe(-1); } });
    expect(long).toBeGreaterThan(10);
    expect(short).toBeGreaterThan(10);
    // 去掉做空方向门,做空会出现在均线之上
    const free = run(trig({ short_regime: undefined })).intents;
    expect(free.some((x, j) => x?.side === 'short' && st[96 * 30 + j] === 1)).toBe(true);
  });
  it('direction=short 时 regime=htf_ma_state{side:below} 按参数判定(不镜像),提示不写「偏多」', () => {
    const st = htfMaStates(m15, M15, htfMaParams({ htf: '1d', period: 20 }));
    const ir = trig({ direction: 'short', short_signal: undefined, short_regime: undefined }, node('htf_ma_state', { htf: '1d', period: 20, side: 'below' }));
    ir.signal = [node('donchian_breakout', { lookback: 8, basis: 'close', direction: 'down' })];
    const { intents, notes } = run(ir);
    const shorts = intents.map((x, j) => [x, 96 * 30 + j] as const).filter(([x]) => x?.side === 'short');
    expect(shorts.length).toBeGreaterThan(5);
    expect(shorts.every(([, i]) => st[i] === -1)).toBe(true);
    expect(notes.join(';')).toMatch(/按参数 side=below 判定/);
  });
  it('4h 顶背离做空触发:short_signal=macd_divergence{htf:4h,direction:bearish},每笔做空都落在 4h 顶背离确认根', () => {
    const flags = htfDivergenceFlags(m15, M15, '4h', macdP, 'bearish');
    const ir = { ...maIR(), regime: undefined, order: { ...maIR().order!, short_regime: undefined } } as StrategyIR;
    const { intents } = run(ir);
    const shorts = intents.map((x, j) => [x, 96 * 30 + j] as const).filter(([x]) => x?.side === 'short');
    expect(shorts.length).toBeGreaterThan(0);
    expect(shorts.every(([, i]) => flags[i] === 1)).toBe(true);
  });
});
