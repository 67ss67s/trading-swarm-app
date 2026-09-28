// gates.ts: evaluateGates (code-side risk gates, model never sees/sets these) and computeSizing
// (qty math). docs/demo/README.md §5 items 6-7.

import { describe, expect, it } from 'vitest';
import { computeSizing, DEFAULT_GATES, evaluateGates, type GateContext, type SymbolRules } from '../../src/demo/gates.js';
import type { AccountView, Judgment, MarketView } from '../../src/demo/types.js';

const market: MarketView = { symbol: 'BTCUSDT', last: '77000', mark: '77000', funding_rate: '0.0001', next_funding_at: 0, open_interest: '1000', as_of: 0, klines_tf: '15m' };
const flatAccount: AccountView = { backend: 'paper', equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: 0 };
const heldAccount: AccountView = { ...flatAccount, positions: [{ symbol: 'BTCUSDT', side: 'long', qty: '0.1', entry_price: '76000', mark_price: '77000', unrealized_pnl: '100', leverage: 3 }] };

function mkJudgment(overrides: Partial<Judgment> = {}): Judgment {
  return {
    action: 'PROPOSE',
    direction: 'long',
    confidence: 0.7,
    headline: 'h',
    thesis: 't',
    reasons: ['r [E1]'],
    evidence_refs: ['E1'],
    invalidation: null,
    invalidation_price: null,
    target_price: null,
    watch_conditions: [],
    proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '76300', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' },
    ...overrides,
  };
}

function mkCtx(overrides: Partial<GateContext> = {}): GateContext {
  return { halted: false, paused: false, account: flatAccount, market, opens_today: 0, stale_refs: new Set(), ...overrides };
}

function gate(results: ReturnType<typeof evaluateGates>, name: string) {
  const g = results.find((r) => r.name === name);
  if (!g) throw new Error(`gate "${name}" not present in ${JSON.stringify(results.map((r) => r.name))}`);
  return g;
}

// ---------------------------------------------------------------- evaluateGates

describe('evaluateGates', () => {
  it('halted blocks PROPOSE', () => {
    const results = evaluateGates(mkJudgment(), mkCtx({ halted: true }));
    expect(gate(results, '紧急停止').passed).toBe(false);
  });

  it('halted does not block a non-opening action like NO_TRADE', () => {
    const results = evaluateGates(mkJudgment({ action: 'NO_TRADE', proposal: null }), mkCtx({ halted: true }));
    expect(gate(results, '紧急停止').passed).toBe(true);
  });

  it('a stale evidence ref blocks PROPOSE', () => {
    const results = evaluateGates(mkJudgment({ evidence_refs: ['E1', 'E2'] }), mkCtx({ stale_refs: new Set(['E2']) }));
    expect(gate(results, '证据新鲜度').passed).toBe(false);
  });

  it('fresh evidence refs pass the staleness gate', () => {
    const results = evaluateGates(mkJudgment({ evidence_refs: ['E1'] }), mkCtx({ stale_refs: new Set(['E9']) }));
    expect(gate(results, '证据新鲜度').passed).toBe(true);
  });

  it('an existing position blocks PROPOSE', () => {
    const results = evaluateGates(mkJudgment(), mkCtx({ account: heldAccount }));
    expect(gate(results, '无持仓才能开仓').passed).toBe(false);
  });

  it('the daily open cap blocks PROPOSE once reached', () => {
    const results = evaluateGates(mkJudgment(), mkCtx({ opens_today: DEFAULT_GATES.max_opens_per_day }));
    expect(gate(results, '每日开仓上限').passed).toBe(false);
  });

  it('below the daily cap, PROPOSE passes the cap gate', () => {
    const results = evaluateGates(mkJudgment(), mkCtx({ opens_today: DEFAULT_GATES.max_opens_per_day - 1 }));
    expect(gate(results, '每日开仓上限').passed).toBe(true);
  });

  it('stop on the wrong side of entry fails "止损在正确一侧" (long stop must be below entry)', () => {
    const j = mkJudgment({ proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '78000', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' } });
    const results = evaluateGates(j, mkCtx());
    expect(gate(results, '止损在正确一侧').passed).toBe(false);
  });

  it('stop on the wrong side of entry fails for shorts too (short stop must be above entry)', () => {
    const j = mkJudgment({
      direction: 'short',
      proposal: { direction: 'short', entry: 'market', limit_price: null, entry_zone: null, stop_price: '76000', take_profit_price: '75000', take_profits: ['75000'], rationale: 'r' },
    });
    const results = evaluateGates(j, mkCtx());
    expect(gate(results, '止损在正确一侧').passed).toBe(false);
  });

  it('stop distance below the minimum (1%) fails "止损距离"', () => {
    const j = mkJudgment({ proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '76950', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' } }); // ~0.065% away
    const results = evaluateGates(j, mkCtx());
    expect(gate(results, '止损距离').passed).toBe(false);
  });

  it('stop distance above the maximum (5%) fails "止损距离"', () => {
    const j = mkJudgment({ proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '70000', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' } }); // ~9% away
    const results = evaluateGates(j, mkCtx());
    expect(gate(results, '止损距离').passed).toBe(false);
  });

  it('stop distance within [1%, 5%] passes "止损距离"; 0.91% is now under the 1% floor', () => {
    // 09-27 起默认底线 1%:76300 对 77000 ≈ 0.91% 不够,76000 ≈ 1.30% 放行
    expect(gate(evaluateGates(mkJudgment(), mkCtx()), '止损距离').passed).toBe(false);
    const j = mkJudgment({ proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '76000', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' } });
    expect(gate(evaluateGates(j, mkCtx()), '止损距离').passed).toBe(true);
  });

  it('confidence below 0.4 fails "信心下限"', () => {
    const results = evaluateGates(mkJudgment({ confidence: 0.39 }), mkCtx());
    expect(gate(results, '信心下限').passed).toBe(false);
  });

  it('confidence at exactly 0.4 passes "信心下限"', () => {
    const results = evaluateGates(mkJudgment({ confidence: 0.4 }), mkCtx());
    expect(gate(results, '信心下限').passed).toBe(true);
  });

  it('ADD always fails with "演示版不加仓" and does not run the PROPOSE-only gates', () => {
    const results = evaluateGates(mkJudgment({ action: 'ADD', proposal: null }), mkCtx());
    const addGate = gate(results, '演示版不加仓');
    expect(addGate.passed).toBe(false);
    expect(addGate.reason).toMatch(/不执行/);
    expect(results.find((r) => r.name === '每日开仓上限')).toBeUndefined();
  });

  it('ADD is still subject to the halted/staleness "opening" gates', () => {
    const results = evaluateGates(mkJudgment({ action: 'ADD', proposal: null }), mkCtx({ halted: true }));
    expect(gate(results, '紧急停止').passed).toBe(false);
  });
});

// ---------------------------------------------------------------- computeSizing

const rules: SymbolRules = { step_size: '0.001', tick_size: '0.1', min_qty: '0.001', min_notional: '100' };

describe('computeSizing', () => {
  it('qty = risk_usdt / stop_distance, floored to step_size', () => {
    const j = mkJudgment({ proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '76500', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' } });
    // equity 10000 × 0.5% = 50 risk_usdt; stop_distance = 77000-76500 = 500; raw = 0.1
    const { qty, ok, sizing } = computeSizing(j, flatAccount, market, rules);
    expect(qty).toBe('0.100');
    expect(ok).toBe(true);
    expect(sizing.risk_usdt).toBe('50.00');
    expect(sizing.stop_distance).toBe('500.00');
  });

  it('clamps to the notional cap (equity × max_notional_multiple) when the raw qty would exceed it', () => {
    const j = mkJudgment({ proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '76999', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' } }); // stop_distance=1 → huge raw qty
    const { qty, sizing } = computeSizing(j, flatAccount, market, rules);
    const maxNotional = 10000 * DEFAULT_GATES.max_notional_multiple;
    expect(Number(qty) * Number(market.mark)).toBeLessThanOrEqual(maxNotional + 1e-6);
    expect(sizing.note).toMatch(/名义超过权益/);
  });

  it('bumps qty up to the exchange minimum notional when the risk-sized qty is too small (fine step_size, so flooring does not eat the bump)', () => {
    const smallEquity: AccountView = { ...flatAccount, equity: '100' };
    const fineRules: SymbolRules = { ...rules, step_size: '0.0001' };
    const j = mkJudgment({ proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '72000', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' } }); // stop_distance=5000
    // risk_usdt = 100*0.5% = 0.5; raw qty = 0.5/5000 = 0.0001 → notional ≈ 7.7, well under min_notional 100
    const { qty, sizing } = computeSizing(j, smallEquity, market, fineRules);
    expect(Number(qty) * Number(market.mark)).toBeGreaterThanOrEqual(100);
    expect(sizing.note).toMatch(/低于交易所最小名义/);
  });

  // Regression (fixed 2026-09-03): the min-notional bump targets notional ≈ min_notional × 1.02 (gates.ts:87-90)
  // but then floors that qty to step_size (gates.ts:92) *without re-checking* the result still
  // clears min_notional. With a step_size that is coarse relative to the 2% bump margin, flooring
  // undershoots the exchange's minimum again — the intent notice claims the order is above the
  // floor when in fact it is not, and the exchange would reject it (or, in `demo`, silently size a
  // trade the code itself believes is above minimum but is not).
  it('min-notional bump survives step flooring (regression: it used to undershoot back under the minimum)', () => {
    const smallEquity: AccountView = { ...flatAccount, equity: '100' };
    const coarseRules: SymbolRules = { ...rules, step_size: '0.001', min_notional: '100' };
    const j = mkJudgment({ proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '72000', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' } });
    const { qty, sizing } = computeSizing(j, smallEquity, market, coarseRules);
    const postFloorNotional = Number(qty) * Number(market.mark);
    // What the code claims via its note: bumped to clear min_notional.
    expect(sizing.note).toMatch(/低于交易所最小名义/);
    // What is actually true: it did not. This assertion documents the bug and is expected to FAIL
    // until gates.ts re-checks (or rounds up instead of floors) after applying step_size.
    expect(postFloorNotional).toBeGreaterThanOrEqual(100);
  });

  it('ok=false when the resulting qty is still below the exchange min_qty', () => {
    const smallEquity: AccountView = { ...flatAccount, equity: '100' };
    const j = mkJudgment({ proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '72000', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' } });
    const strictRules: SymbolRules = { ...rules, min_qty: '1' }; // way above what a 100 USDT account can size
    const { ok, sizing } = computeSizing(j, smallEquity, market, strictRules);
    expect(ok).toBe(false);
    expect(sizing.note).toMatch(/低于交易所最小下单量/);
  });

  it('ok=true and no notes when a plain risk-sized qty already clears every floor', () => {
    const j = mkJudgment({ proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '76500', take_profit_price: '79000', take_profits: ['79000'], rationale: 'r' } });
    const { ok, sizing } = computeSizing(j, flatAccount, market, rules);
    expect(ok).toBe(true);
    expect(sizing.note).not.toMatch(/超过|低于/);
  });
});

describe('证据新鲜度 — market snapshot age', () => {
  it('refuses PROPOSE when the market snapshot is older than MARKET_STALE_MS even if no cited evidence is stale', async () => {
    const { evaluateGates, MARKET_STALE_MS } = await import('../../src/demo/gates.js');
    const j = { action: 'PROPOSE', direction: 'long', confidence: 0.7, evidence_refs: ['E1'], reasons: ['x [E1]'], proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '99', take_profits: ['103'], rationale: 'r' } } as never;
    const market = { symbol: 'BTCUSDT', last: '100', mark: '100', funding_rate: '0', next_funding_at: 0, open_interest: null, as_of: 1_000_000, klines_tf: '15m' } as never;
    const account = { backend: 'paper', equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: 1_000_000 } as never;
    const fresh = evaluateGates(j, { halted: false, paused: false, account, market, opens_today: 0, stale_refs: new Set(), now: 1_000_000 + 60_000 });
    expect(fresh.find((g) => g.name === '证据新鲜度')?.passed).toBe(true);
    const old = evaluateGates(j, { halted: false, paused: false, account, market, opens_today: 0, stale_refs: new Set(), now: 1_000_000 + MARKET_STALE_MS + 1 });
    expect(old.find((g) => g.name === '证据新鲜度')?.passed).toBe(false);
    expect(old.find((g) => g.name === '证据新鲜度')?.reason).toMatch(/过期/);
    // without `now` the old citation-only behaviour is unchanged
    const legacy = evaluateGates(j, { halted: false, paused: false, account, market, opens_today: 0, stale_refs: new Set() });
    expect(legacy.find((g) => g.name === '证据新鲜度')?.passed).toBe(true);
  });
});

describe('agent sizing: bounded opinion and hard caps', () => {
  const agent = { multiplier: 2, overshoot: false, split: 3, reason: '信心充足', applied: true };
  it('applies multiplier only when applied; liquidity caps total even for split=3', () => {
    const base = computeSizing(mkJudgment(), flatAccount, market, rules);
    const doubled = computeSizing(mkJudgment(), flatAccount, market, rules, DEFAULT_GATES, { agent });
    expect(Number(doubled.qty)).toBeGreaterThan(Number(base.qty));
    expect(doubled.sizing.risk_usdt).toBe('100.00');
    expect(computeSizing(mkJudgment(), flatAccount, market, rules, DEFAULT_GATES, { agent: { ...agent, applied: false } }).qty).toBe(base.qty);
    const capped = computeSizing(mkJudgment(), flatAccount, market, rules, DEFAULT_GATES, { agent, liquidity_notional_cap: 1000 });
    expect(capped.ok).toBe(true);
    expect(Number(capped.qty) * Number(market.mark)).toBeLessThanOrEqual(1000);
    expect(computeSizing(mkJudgment(), flatAccount, market, rules, DEFAULT_GATES, { agent, liquidity_notional_cap: 50 }).ok).toBe(false);
  });
  it('allows only the smallest lot up to exactly twice the adjusted budget', () => {
    const acct = { ...flatAccount, equity: '100' };
    const m = { ...market, mark: '100' };
    const r = { ...rules, step_size: '1', min_qty: '1', min_notional: '100' };
    const j = mkJudgment(); j.proposal!.stop_price = '99';
    const opts = { agent: { ...agent, multiplier: 1, overshoot: true } };
    expect(computeSizing(j, acct, m, r).ok).toBe(false);
    expect(computeSizing(j, acct, m, r, DEFAULT_GATES, opts)).toMatchObject({ ok: true, qty: '1' });
    j.proposal!.stop_price = '98.99';
    expect(computeSizing(j, acct, m, r, DEFAULT_GATES, opts).ok).toBe(false);
    j.proposal!.stop_price = '99';
    expect(computeSizing(j, acct, m, r, { ...DEFAULT_GATES, max_notional_multiple: 0.5 }, opts).ok).toBe(false);
    expect(computeSizing(j, acct, m, r, DEFAULT_GATES, { ...opts, liquidity_notional_cap: 99 }).ok).toBe(false);
  });
  it('quarter multiplier reduces risk and zero or NaN volume caps reject', () => {
    expect(computeSizing(mkJudgment(), flatAccount, market, rules, DEFAULT_GATES, { agent: { ...agent, multiplier: 0.25 } }).sizing.risk_usdt).toBe('12.50');
    for (const cap of [0, NaN]) expect(computeSizing(mkJudgment(), flatAccount, market, rules, DEFAULT_GATES, { liquidity_notional_cap: cap }).ok).toBe(false);
  });
});

it('uses conservative limit/mark prices for stop risk and notional', () => {
  const j = mkJudgment();
  j.proposal = { ...j.proposal!, entry: 'limit', limit_price: '80000', stop_price: '76000' };
  const r = computeSizing(j, flatAccount, market, rules, DEFAULT_GATES, { agent: { multiplier: 2, overshoot: false, split: 1, reason: '测试', applied: true } });
  expect(r.sizing.stop_distance).toBe('4000.00');
  expect(Number(r.qty) * 4000).toBeLessThanOrEqual(100);
  const capped = computeSizing(j, flatAccount, market, rules, DEFAULT_GATES, { liquidity_notional_cap: 1000 });
  expect(Number(capped.qty) * 80000).toBeLessThanOrEqual(1000);
});

it('overshoot cannot relax the risk budget for fixed quantities above the minimum lot', () => {
  const j = mkJudgment(); j.proposal!.stop_price = '99.6';
  const result = computeSizing(j, { ...flatAccount, equity: '100' }, { ...market, mark: '100' },
    { ...rules, step_size: '1', min_qty: '1', min_notional: '100' }, DEFAULT_GATES,
    { fixed_qty: '2', agent: { multiplier: 1, overshoot: true, split: 3, reason: '测试', applied: true } });
  expect(result.ok).toBe(false);
  expect(result.qty).toBe('2');
  expect(result.sizing.note).toContain('容差 5%');
});

it('SKHYNIX minimum lot 0.01 at 1302 is 13.02 USDT, and fixed quantities below minNotional fail before execution', () => {
  const m = { ...market, symbol: 'SKHYNIXUSDT', mark: '1302', last: '1302' };
  const j = mkJudgment({ proposal: { ...mkJudgment().proposal!, stop_price: '1273', take_profit_price:'1348', take_profits:['1348'] } });
  const filters = { step_size:'0.01', tick_size:'0.01', min_qty:'0.01', min_notional:'5' };
  const sized = computeSizing(j, { ...flatAccount, equity:'100' }, m, filters, DEFAULT_GATES, { fixed_qty:'0.01' });
  expect(sized.ok).toBe(true);
  const under = computeSizing(j, { ...flatAccount, equity:'100' }, m, { ...filters, step_size:'0.001', min_qty:'0.001' }, DEFAULT_GATES, { fixed_qty:'0.003' });
  expect(under.ok).toBe(false);
  expect(under.sizing.note).toContain('低于交易所最小名义');
});
