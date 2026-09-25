// 旧口径重放钉子(2026-09-23 结构止盈止损改造前实测):冻结了旧 order_gate(min_rr 1.5 / 成本下限放宽 / 2R 兜底)的请求,
// 改造后逐字节同一结果——engine v3、engine v4 快路径、订单周期执行核三条路径各钉一个哈希。哈希变了 = 旧 manifest 重放不再一致。
import { describe, it, expect } from 'vitest';
import type { ResearchRequest, StrategyIR } from '@trading-swarm/contracts';
import { runReplay } from '../../../src/demo/research/engine.js';
import { runOrderPath } from '../../../src/demo/research/orders/index.js';
import { LEGACY_ORDER_GATE, orderGateFor } from '../../../src/demo/research/order-gate.js';
import { hash } from '../../../src/demo/research/primitives.js';
import { node } from '../../../src/demo/research/strategy.js';
import { synthDataset, emaIR } from './backtest-report-fixtures.js';

const STEP = 3600000;
const d = synthDataset(800, STEP, 'BTCUSDT', 11);
/** 止损贴得很近(3 根最低)+ 结构止盈:旧口径下会触发成本下限放宽与 2R 兜底 */
const tightIR = (): StrategyIR => ({ version: 1, label: '贴身止损', description: '突破入场', signal: [node('donchian_breakout', { lookback: 20, basis: 'close' })], entry: node('next_open_market', {}), risk: { stop: node('swing_low_stop', { lookback: 3 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 }), node('structure_target', { htf: '4h', swing_length: 3 })] });
const req = (ir: StrategyIR, fast: boolean): ResearchRequest => ({ idempotency_key: 'pin', dataset_id: 'pin', study_id: 'pin', strategy_ir: ir, execution: { initial_cash: '10000', risk_fraction: '0.01', max_allocation: '1', fee_rate: '0.001', slippage_bps: '5', qty_step: '0.00000001', min_notional: '5', max_opens_per_day: 10, sizing_mode: 'unit_notional' }, order_gate: { ...LEGACY_ORDER_GATE }, from_ms: d.bars[300]!.close_time, to_ms: d.bars[790]!.close_time, arms: ['a_rules'], repeats: 1, max_model_calls: 0, timeout_ms: 60000, purpose: 'development', acknowledge_adaptive_search: true, ...(fast ? { spec_version: 'strategy-spec/v1;engine=v4' } : {}) }) as ResearchRequest;
const none = async () => { throw new Error('no model'); };
const armHash = (r: Awaited<ReturnType<typeof runReplay>>) => hash({ v: r.engine_version, s: r.status, arms: r.arms.map((a) => ({ m: a.metrics, t: a.trades, d: a.decisions.map((x) => [x.at, x.action, x.reason, x.gate_errors, x.fit ?? null]) })) });

describe('旧 order_gate 重放不变', () => {
  it('engine v3 / v4 与订单执行核的结果哈希钉住', async () => {
    const got: Record<string, string> = {};
    for (const [k, ir] of [['ema', emaIR()], ['tight', tightIR()]] as const) {
      got[`${k}_v3`] = armHash(await runReplay(d, req(ir, false), none));
      got[`${k}_v4`] = armHash(await runReplay(d, req(ir, true), none, { fast: true }));
    }
    const orderIR: StrategyIR = { ...tightIR(), order: { direction: 'long', market: 'spot' } };
    const o = runOrderPath({ ir: orderIR, bars: d.bars, timeframe_ms: STEP, symbol: 'BTCUSDT', from_index: 300, to_index: 790, initial_cash: 10000, fee_rate: '0.001', slippage_bps: '5', gate: orderGateFor(orderIR, LEGACY_ORDER_GATE) });
    got.orders = hash({ v: o.engine_version, plans: o.plans, stats: o.stats, notes: o.notes });
    expect(got).toMatchInlineSnapshot(`
      {
        "ema_v3": "4f9403fd60e60c81b6e917df92374b10ac8fe9a3e452d4507cecb048c854f0c0",
        "ema_v4": "f81137bb9b62c06eadfb31a544960b241b2054528b80237dfcf0b95b03765971",
        "orders": "67b03a25c9b0b3085e24c04107f766adcbd2eb8fda3e875aaae654a71a8d3b89",
        "tight_v3": "9c7f3f35a8cc24dabdbc80147c637efaa143a6e4105a5a0002f788efdfd39b25",
        "tight_v4": "3a8ab32bb789da01cf00de66b65e4267597e46edc5ac46be9ccd093c1f26f40f",
      }
    `);
  }, 120000);
});
