import { describe, expect, it } from 'vitest';
import { validate } from '@trade-gate/contracts';
import { computeSnapshot, DEFAULT_PORTFOLIO_POLICY, evaluateCapacity, type CapacityInputs, type CapacityRules } from '../../src/demo/portfolio.js';
import { blocksNewRisk, evaluateRisk } from '../../src/demo/risk.js';
import { RiskStore } from '../../src/demo/team-store.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';
import { computeSizing } from '../../src/demo/gates.js';
import { openStateDb } from '../../src/state-db.js';
import type { AccountView, Judgment, MarketView, StrategyThread } from '../../src/demo/types.js';

const NOW = 1_800_000_000_000;
const account = (equity = '100', available = equity): AccountView => ({ backend: 'paper', equity, available, unrealized_pnl: '0', positions: [], open_orders: [], as_of: NOW });
const market = (symbol: string, price: string): MarketView => ({ symbol, last: price, mark: price, funding_rate: '0', next_funding_at: NOW, open_interest: '0', as_of: NOW, klines_tf: '15m' });
const rules = (step = '0.01', floor = '5'): CapacityRules => ({ step_size: step, min_qty: step, min_notional: floor, tick_size: '0.01', source: 'exchange', observed_at: NOW, trading: true });
function input(): CapacityInputs {
  const markets = new Map([market('BTCUSDT', '80000'), market('ETHUSDT', '2500'), market('DOGEUSDT', '0.09')].map((m) => [m.symbol, m]));
  return {
    snapshot: computeSnapshot({ account: account(), markets, threads: [], intents: [], now: NOW }), markets,
    rules: new Map([['BTCUSDT', rules('0.001', '50')], ['ETHUSDT', rules('0.001', '20')], ['DOGEUSDT', rules('1')]]),
    watchlist: [...markets.keys()], threads: [], risk_pct: '0.5', leverage: 3, max_open_threads: 3,
  };
}
const evaluate = (patch: Partial<CapacityInputs> = {}) => evaluateCapacity({ ...input(), ...patch });
const symbol = (name: string, patch: Partial<CapacityInputs> = {}) => evaluate(patch).by_symbol.find((s) => s.symbol === name)!;

describe('Portfolio Manager capacity', () => {
  it('BTC at 100 U needs 240 U at a 1.5% stop; leverage changes margin, not stop risk', () => {
    const btc = symbol('BTCUSDT');
    expect(btc).toMatchObject({ verdict: 'needs_equity', min_qty: '0.001', min_viable_notional: '80', min_size_risk: '1.2', required_equity: '240', equity_shortfall: '140', risk_budget: '0.5', stop_distance_pct: '1.5', stop_source: 'default' });
    expect(Number(btc.margin_per_thread)).toBeCloseTo(80 / 3, 10);
    const levered = symbol('BTCUSDT', { leverage: 10 });
    expect(levered.required_equity).toBe('240');
    expect(levered.margin_per_thread).toBe('8');
  });

  it('ETH uses its 20 U notional floor and DOGE rounds to whole tokens', () => {
    expect(symbol('ETHUSDT')).toMatchObject({ verdict: 'ok', min_qty: '0.008', min_viable_notional: '20', min_size_risk: '0.3', required_equity: '60' });
    expect(symbol('DOGEUSDT')).toMatchObject({ verdict: 'ok', min_qty: '56', min_viable_notional: '5.04', min_size_risk: '0.0756', required_equity: '15.12' });
  });

  it('rounds the minQty constraint too; exact decimal boundaries never add a spurious step', () => {
    const markets = new Map([['MUUSDT', market('MUUSDT', '1000')]]);
    const r = new Map([['MUUSDT', { ...rules('0.01'), min_qty: '0.015' }]]);
    expect(evaluate({ markets, rules: r, watchlist: ['MUUSDT'] }).by_symbol[0]).toMatchObject({ min_qty: '0.02', min_viable_notional: '20' });
    expect(evaluate({ markets, rules: new Map([['MUUSDT', rules('0.01', '30')]]), watchlist: ['MUUSDT'] }).by_symbol[0]!.min_qty).toBe('0.03');
  });

  it('prefers the symbol ATR scenario and supports an explicit default stop', () => {
    expect(symbol('BTCUSDT', { typical_stops: new Map([['BTCUSDT', '1']]) })).toMatchObject({ stop_distance_pct: '1', stop_source: 'atr', required_equity: '160' });
    expect(symbol('BTCUSDT', { config: { default_stop_distance_pct: '2' } })).toMatchObject({ stop_source: 'default', required_equity: '320' });
  });

  it('missing, incomplete, stale or invalid filters stay rules_unknown, with explicit nulls', () => {
    for (const r of [new Map(), new Map([['BTCUSDT', { ...rules(), min_qty: '' }]]), new Map([['BTCUSDT', { ...rules(), step_size: 'NaN' }]]), new Map([['BTCUSDT', { ...rules(), observed_at: NOW - 600_001 }]])]) {
      expect(symbol('BTCUSDT', { rules: r })).toMatchObject({ verdict: 'rules_unknown', min_qty: null, required_equity: null, min_size_risk: null });
    }
    const capacity = evaluate({ rules: new Map() });
    expect(capacity.binding_constraint).toBe('rules_unknown');
    expect(capacity.margin_budget.required_for_free_slots_usdt).toBeNull();
    expect(validate('demo_portfolio_capacity', JSON.parse(JSON.stringify(capacity))).ok).toBe(true);
  });

  it('missing/stale prices and invalid account quality do not produce an ok verdict or Infinity', () => {
    expect(symbol('BTCUSDT', { markets: new Map() }).verdict).toBe('unavailable');
    expect(symbol('BTCUSDT', { markets: new Map([['BTCUSDT', { ...market('BTCUSDT', '80000'), as_of: NOW - 180_001 }]]) }).verdict).toBe('unavailable');
    const bad = evaluate({ snapshot: { ...input().snapshot, equity: 0, quality: 'incomplete' } });
    expect(bad.binding_constraint).toBe('snapshot_unavailable');
    expect(bad.margin_budget.slots_supported).toBeNull();
    expect(bad.by_symbol.every((s) => s.verdict !== 'ok')).toBe(true);
    expect(JSON.stringify(bad)).not.toMatch(/Infinity|NaN/);
  });

  it('four full-risk threads at 1% stop need 66.67 U margin, binding the 50% margin budget', () => {
    const names = ['BNBUSDT', 'MUUSDT', 'SPCXUSDT', 'CRCLUSDT'];
    const patch: Partial<CapacityInputs> = { watchlist: names, markets: new Map(names.map((s) => [s, market(s, '100')])), rules: new Map(names.map((s) => [s, rules()])), max_open_threads: 4, config: { default_stop_distance_pct: '1' } };
    const c = evaluate(patch);
    expect(c).toMatchObject({ slots_total: 4, slots_used: 0, slots_free: 4, binding_constraint: 'margin_budget' });
    expect(c.margin_budget).toMatchObject({ limit_usdt: '50', free_usdt: '50', slots_supported: 3 });
    expect(c.margin_budget.witness_symbols).toHaveLength(3);
    expect(Number(c.margin_budget.required_for_free_slots_usdt)).toBeCloseTo(200 / 3, 10);
    expect(evaluate({ ...patch, config: { default_stop_distance_pct: '1', max_margin_ratio: 0.7 } }).binding_constraint).toBe('thread_slots');
  });

  it('respects free balance and reserves local intents once, excluding exchange orders already charged to available', () => {
    const base = input().snapshot;
    const leg = { symbol: 'SOLUSDT', cluster: 'crypto_beta' as const, side: 'long' as const, qty: 1, mark: 15, notional: 15, ref: 'order:a', stop_loss_usdt: null };
    const c = evaluate({ snapshot: { ...base, available: 20, legs: [{ ...leg, source: 'open_order' }, { ...leg, symbol: 'MUUSDT', source: 'intent', ref: 'intent:b' }] }, config: { max_margin_ratio: 1 } });
    expect(c).toMatchObject({ slots_used: 2, slots_free: 1 });
    expect(c.margin_budget).toMatchObject({ committed_usdt: '80', reserved_usdt: '5', free_usdt: '15' });
    const low = evaluate({ snapshot: { ...base, available: 1 }, config: { max_margin_ratio: 1 } });
    expect(low.margin_budget.slots_supported).toBe(0);
  });

  it('counts only open threads, does not count a matched position twice, excludes occupied/watch-only symbols', () => {
    const threads = [{ id: 'a', symbol: 'ETHUSDT', side: 'long', status: 'in_position' }, { id: 'b', symbol: 'BTCUSDT', side: 'long', status: 'closed' }] as StrategyThread[];
    const c = evaluate({ threads, watch_only: ['DOGEUSDT'], snapshot: { ...input().snapshot, legs: [{ symbol: 'ETHUSDT', side: 'long', source: 'position', cluster: 'crypto_major', ref: 'p', qty: 0.008, mark: 2500, notional: 20, stop_loss_usdt: 0.3 }] } });
    expect(c).toMatchObject({ slots_total: 3, slots_used: 1, slots_free: 2, binding_constraint: 'min_size_risk' });
    expect(c.margin_budget.witness_symbols).toEqual([]);
  });

  it('is deterministic and its decimal/null response matches the JSON Schema', () => {
    const inp = input();
    expect(evaluateCapacity(inp)).toEqual(evaluateCapacity(inp));
    expect(validate('demo_portfolio_capacity', evaluateCapacity(inp)).ok).toBe(true);
  });
});

describe('capacity risk alert and sizing explanation', () => {
  const riskInput = () => ({ snapshot: input().snapshot, capacity: evaluate(), policy: DEFAULT_PORTFOLIO_POLICY, workflow: DEFAULT_WORKFLOW, threads: [], daily_loss_pct: 0, halted: false, execution: { status: 'connected', detail: '', checked_at: NOW }, market_as_of: { BTCUSDT: NOW }, unknown_intents: 0, now: NOW });

  it('warns with every affected symbol and required equity, deduplicates jitter and clears after recovery', () => {
    const inp = riskInput();
    const alerts = evaluateRisk(inp);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'capacity_short', severity: 'warn', auto_action: 'none', value: 100, threshold: 240 });
    expect(alerts[0]!.detail).toContain('BTCUSDT 要 240 U 权益');
    expect(blocksNewRisk(alerts)).toBe(false);
    const jitter = evaluateRisk({ ...inp, capacity: evaluate({ markets: new Map([...input().markets, ['BTCUSDT', market('BTCUSDT', '80001')]]) }) });
    expect(jitter[0]!.fingerprint).toBe(alerts[0]!.fingerprint);
    const state = openStateDb(':memory:');
    try {
      const store = new RiskStore(state.db);
      store.reconcile(alerts, NOW);
      expect(store.reconcile(jitter, NOW + 1).opened).toEqual([]);
      const recovered = evaluateRisk({ ...inp, capacity: evaluate({ snapshot: { ...input().snapshot, equity: 240, available: 240 } }) });
      for (let i = 0; i < 3; i++) store.reconcile(recovered, NOW + 2 + i);
      expect(store.open()).toEqual([]);
    } finally { state.close(); }
    expect(evaluateRisk({ ...inp, capacity: evaluate({ watch_only: ['BTCUSDT'] }) })).toEqual([]);
    expect(evaluateRisk({ ...inp, capacity: evaluate({ rules: new Map() }) })).toEqual([]);
  });

  it('preserves the 5% sizing rejection and spells out BTC equity needed', () => {
    const j = { proposal: { direction: 'long', entry: 'market', stop_price: '78800' } } as Judgment;
    const result = computeSizing(j, account(), market('BTCUSDT', '80000'), rules('0.001', '50'));
    expect(result.ok).toBe(false);
    expect(result.qty).toBe('0.001');
    expect(result.sizing.note).toContain('最小下单量风险 1.20 U > 预算 0.50 U;要 240 U 权益才能按 0.5% 做 BTCUSDT');
  });
});
