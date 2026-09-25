// Portfolio Manager(portfolio.ts)+ Risk Sentinel(risk.ts / team-store.ts)。全部纯代码,零模型、零网络。
// 场景清单来自 docs/design/team-roles-2026-09-06.md §3.8 / §4.8(评审稿的验收项):BTC+ETH 同簇超限、
// 同币多空 gross 不抵销、挂单只一边成交的最坏净额、待批 intent 与真实挂单去重、止损预算不被盈利仓抵销、
// 质量不 ok 不放行、latch(high 不自动解除)、warn 滞回、ack 不放行。
import { afterEach, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { stubBrain } from '../../src/demo/brain.js';
import { clusterFor, computeSnapshot, evaluateImpact, DEFAULT_PORTFOLIO_POLICY, parsePolicy, tightenOnly, stopLossUsdt } from '../../src/demo/portfolio.js';
import { blocksNewRisk, evaluateRisk, riskFingerprint, riskSummary } from '../../src/demo/risk.js';
import { RiskStore, CLEAN_STREAK_TO_RESOLVE } from '../../src/demo/team-store.js';
import { presenceFor } from '../../src/demo/routes-bots.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';
import type { AccountView, DemoIntent, MarketView, PositionView, StrategyThread } from '../../src/demo/types.js';

const NOW = 1_788_600_000_000;

function market(symbol: string, mark: number, asOf = NOW): MarketView {
  return { symbol, last: String(mark), mark: String(mark), funding_rate: '0', next_funding_at: 0, open_interest: '0', as_of: asOf, klines_tf: '15m' } as MarketView;
}
function pos(symbol: string, side: 'long' | 'short', qty: number, mark: number): PositionView {
  return { symbol, side, qty: String(qty), entry_price: String(mark), mark_price: String(mark), unrealized_pnl: '0', leverage: 5 };
}
function account(positions: PositionView[], openOrders: AccountView['open_orders'] = [], equity = 10_000, asOf = NOW): AccountView {
  return { backend: 'paper', equity: String(equity), available: String(equity), unrealized_pnl: '0', positions, open_orders: openOrders, as_of: asOf };
}
function thread(symbol: string, side: 'long' | 'short', stop: number | null, status: StrategyThread['status'] = 'in_position'): StrategyThread {
  return { id: `thr-${symbol}-${side}`, symbol, side, status, stop_price: stop === null ? null : String(stop), entry_client_order_id: `cid-${symbol}`, attention: null } as unknown as StrategyThread;
}
function intent(symbol: string, direction: 'long' | 'short', qty: number, status: DemoIntent['status'], cid: string | null = null, limit: string | null = null): DemoIntent {
  return { id: `int-${symbol}-${qty}`, episode_id: 'ep', thread_id: null, principal: 'agent', at: NOW, kind: 'open', symbol, direction, quantity: String(qty), entry: limit ? 'limit' : 'market', limit_price: limit, stop_price: null, take_profit_price: null, sizing: {} as DemoIntent['sizing'], status, client_order_id: cid, backend: 'paper', receipts: [], error: null };
}
const markets = new Map([
  ['BTCUSDT', market('BTCUSDT', 100_000)],
  ['ETHUSDT', market('ETHUSDT', 4_000)],
  ['SOLUSDT', market('SOLUSDT', 200)],
  ['TSLAUSDT', market('TSLAUSDT', 400)],
]);

describe('clusters + policy', () => {
  it('maps symbols to human-versioned clusters; unknown stays unknown', () => {
    expect(clusterFor('BTCUSDT')).toBe('crypto_major');
    expect(clusterFor('SOLUSDT')).toBe('crypto_beta');
    expect(clusterFor('TSLAUSDT')).toBe('equity_linked');
    expect(clusterFor('XAUUSDT')).toBe('metal');
    expect(clusterFor('WEIRD-PERP')).toBe('unknown');
  });
  it('policy parse falls back per field; tightenOnly refuses loosening', () => {
    const p = parsePolicy('{"max_gross_ratio": 2, "max_net_ratio": "x"}');
    expect(p.max_gross_ratio).toBe(2);
    expect(p.max_net_ratio).toBe(DEFAULT_PORTFOLIO_POLICY.max_net_ratio);
    expect(tightenOnly(DEFAULT_PORTFOLIO_POLICY, { ...DEFAULT_PORTFOLIO_POLICY, max_gross_ratio: 2 })).toEqual([]);
    expect(tightenOnly(DEFAULT_PORTFOLIO_POLICY, { ...DEFAULT_PORTFOLIO_POLICY, max_gross_ratio: 5 })).toEqual(['max_gross_ratio 只能收紧']);
  });
  it('stop loss on the wrong side counts as no protection', () => {
    expect(stopLossUsdt('long', 1, 100, 90)).toBe(10);
    expect(stopLossUsdt('long', 1, 100, 110)).toBeNull();
    expect(stopLossUsdt('short', 2, 100, 105)).toBe(10);
  });
});

describe('computeSnapshot', () => {
  it('drops the reservation of an intent whose thread is already closed (2026-09-06 HYPE compensation leak)', () => {
    const closedThread = { ...thread('HYPEUSDT', 'long', 84.86), id: 'thr-closed' };
    const it = { ...intent('HYPEUSDT', 'long', 0.35, 'submitted', 'tgd-h-e1'), thread_id: 'thr-closed' };
    const mk = new Map(markets);
    mk.set('HYPEUSDT', market('HYPEUSDT', 86));
    const withOpen = computeSnapshot({ account: account([]), markets: mk, threads: [closedThread], intents: [it], now: NOW });
    expect(withOpen.legs.some((l) => l.source === 'intent' && l.symbol === 'HYPEUSDT')).toBe(true);
    const threadGone = computeSnapshot({ account: account([]), markets: mk, threads: [], intents: [it], now: NOW });
    expect(threadGone.legs.some((l) => l.source === 'intent')).toBe(false);
  });

  it('gross does not net out a same-symbol long+short; net does', () => {
    const s = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.1, 100_000), pos('BTCUSDT', 'short', 0.1, 100_000)]), markets, threads: [], intents: [], now: NOW });
    expect(s.positions.gross).toBe(20_000);
    expect(s.positions.net).toBe(0);
    expect(s.positions.gross_ratio).toBe(2);
    expect(s.by_symbol['BTCUSDT']!.gross).toBe(20_000);
  });
  it('BTC + ETH land in one cluster; cluster ratio exceeds the cap while each symbol alone would not', () => {
    const s = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.12, 100_000), pos('ETHUSDT', 'long', 3, 4_000)]), markets, threads: [thread('BTCUSDT', 'long', 99_000), thread('ETHUSDT', 'long', 3_950)], intents: [], now: NOW });
    expect(s.by_cluster['crypto_major']!.gross).toBe(24_000);
    expect(s.by_cluster['crypto_major']!.gross_ratio).toBeCloseTo(2.4);
    expect(s.by_symbol['BTCUSDT']!.gross_ratio).toBeCloseTo(1.2);
    // 止损预算:0.12×1000 + 3×50 = 270 USDT = 2.7% > 1.5%
    expect(s.stop_budget_usdt).toBeCloseTo(270);
    expect(s.unprotected_notional).toBe(0);
    expect(s.quality).toBe('ok');
  });
  it('open orders reserve one-sided worst-case net; reduce-only orders are neither risk nor relief', () => {
    const orders: AccountView['open_orders'] = [
      { symbol: 'SOLUSDT', client_order_id: 'o1', type: 'LIMIT', side: 'BUY', qty: '50', price: '200', stop_price: null, reduce_only: false, status: 'NEW' },
      { symbol: 'SOLUSDT', client_order_id: 'o2', type: 'LIMIT', side: 'SELL', qty: '50', price: '200', stop_price: null, reduce_only: false, status: 'NEW' },
      { symbol: 'BTCUSDT', client_order_id: 'sl', type: 'STOP_MARKET', side: 'SELL', qty: '0.05', price: null, stop_price: '99000', reduce_only: true, status: 'NEW' },
    ];
    const s = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.05, 100_000)], orders), markets, threads: [thread('BTCUSDT', 'long', 99_000)], intents: [], now: NOW });
    // 持仓净 +5000;多空各 10000 挂单不能假设同时成交抵销:最坏区间 [-0.5, 1.5]
    expect(s.worst_net_ratio.low).toBeCloseTo(-0.5);
    expect(s.worst_net_ratio.high).toBeCloseTo(1.5);
    expect(s.projected.gross).toBe(25_000);
    expect(s.legs.filter((l) => l.source === 'open_order')).toHaveLength(2);
  });
  it('pending intents are reserved once: an intent already visible as an order is not double counted; unknown is still reserved', () => {
    const orders: AccountView['open_orders'] = [{ symbol: 'ETHUSDT', client_order_id: 'cid-eth', type: 'LIMIT', side: 'BUY', qty: '1', price: '4000', stop_price: null, reduce_only: false, status: 'NEW' }];
    const s = computeSnapshot({ account: account([], orders), markets, threads: [], intents: [intent('ETHUSDT', 'long', 1, 'submitted', 'cid-eth'), intent('SOLUSDT', 'short', 10, 'unknown'), intent('SOLUSDT', 'long', 99, 'rejected')], now: NOW });
    expect(s.legs.map((l) => l.ref).sort()).toEqual(['intent:int-SOLUSDT-10', 'order:cid-eth']);
    expect(s.projected.gross).toBe(6_000);
  });
  it('unprotected positions are listed and excluded from the stop budget; a profitable position never offsets losses', () => {
    const s = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.1, 100_000), pos('SOLUSDT', 'short', 10, 200)]), markets, threads: [thread('BTCUSDT', 'long', 99_000), thread('SOLUSDT', 'short', 190 /* wrong side for a short */)], intents: [], now: NOW });
    expect(s.stop_budget_usdt).toBe(100);
    expect(s.unprotected_symbols).toEqual(['SOLUSDT']);
    expect(s.unprotected_notional).toBe(2_000);
  });
  it('2026-09-21: spot positions without a stop are excluded from the stop budget and listed separately (demo BTC/ETH/OKB blew the 1.5% cap)', () => {
    const spotBtc = { ...pos('BTCUSDT', 'long', 0.5, 100_000), market: 'spot' as const };
    const s = computeSnapshot({ account: account([spotBtc, pos('SOLUSDT', 'long', 10, 200)]), markets, threads: [thread('SOLUSDT', 'long', 190)], intents: [], now: NOW });
    expect(s.stop_budget_usdt).toBe(100);
    expect(s.spot_no_stop_notional).toBe(50_000);
    expect(s.unprotected_notional).toBe(0);
    expect(s.unprotected_symbols).toEqual([]);
  });
  it('quality: stale when the oldest component is too old; incomplete on equity ≤ 0 or missing market; inconsistent on >15s spread', () => {
    const old = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.01, 100_000)], [], 10_000, NOW - 60_000), markets, threads: [], intents: [], now: NOW });
    expect(old.quality).toBe('stale');
    const zero = computeSnapshot({ account: account([], [], 0), markets, threads: [], intents: [], now: NOW });
    expect(zero.quality).toBe('incomplete');
    const noMkt = computeSnapshot({ account: account([pos('DOGEUSDT', 'long', 1000, 0.1)]), markets, threads: [], intents: [], now: NOW });
    expect(noMkt.quality).toBe('incomplete');
    const spread = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.01, 100_000)], [], 10_000, NOW - 20_000), markets, threads: [], intents: [], now: NOW });
    expect(spread.quality).toBe('inconsistent');
    // 带缓存的通道(agent_mcp)声明账户天然可以 16 分钟老:同样的 20 秒偏差是 ok;老到超过声明才 stale。
    expect(computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.01, 100_000)], [], 10_000, NOW - 20_000), markets, threads: [], intents: [], now: NOW, account_max_age_ms: 16 * 60_000 }).quality).toBe('ok');
    expect(computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.01, 100_000)], [], 10_000, NOW - 10 * 60_000), markets, threads: [], intents: [], now: NOW, account_max_age_ms: 16 * 60_000 }).quality).toBe('ok');
    expect(computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.01, 100_000)], [], 10_000, NOW - 20 * 60_000), markets, threads: [], intents: [], now: NOW, account_max_age_ms: 16 * 60_000 }).quality).toBe('stale');
  });
  it('economic fingerprint ignores time, changes with content', () => {
    const a = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.1, 100_000)]), markets, threads: [], intents: [], now: NOW });
    const b = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.1, 100_000)], [], 10_000, NOW + 5_000), markets, threads: [], intents: [], now: NOW + 5_000 });
    const c = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.2, 100_000)]), markets, threads: [], intents: [], now: NOW });
    expect(a.economic_fingerprint).toBe(b.economic_fingerprint);
    expect(a.economic_fingerprint).not.toBe(c.economic_fingerprint);
  });
});

describe('evaluateImpact', () => {
  const base = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.15, 100_000)]), markets, threads: [thread('BTCUSDT', 'long', 99_500)], intents: [], now: NOW });
  it('passes a small diversified candidate, blocks a same-cluster one over the cap, never edits the candidate', () => {
    const ok = evaluateImpact(base, { symbol: 'TSLAUSDT', side: 'long', qty: 10, price: 400, stop: 396 });
    expect(ok.verdict).toBe('pass');
    expect(ok.after.gross_ratio).toBeCloseTo(1.9);
    const tooBig = evaluateImpact(base, { symbol: 'ETHUSDT', side: 'long', qty: 2, price: 4_000, stop: 3_960 });
    expect(tooBig.verdict).toBe('block');
    expect(tooBig.reasons.join(' ')).toMatch(/风险簇 crypto_major/);
    expect(tooBig.after.cluster_ratio).toBeCloseTo(2.3);
  });
  it('blocks a candidate without a verifiable stop, an unknown-cluster symbol, and anything on a non-ok snapshot', () => {
    expect(evaluateImpact(base, { symbol: 'SOLUSDT', side: 'long', qty: 1, price: 200, stop: null }).reasons.join(' ')).toMatch(/止损/);
    expect(evaluateImpact(base, { symbol: 'WEIRD', side: 'long', qty: 1, price: 1, stop: 0.9 }).reasons.join(' ')).toMatch(/unknown/);
    const stale = computeSnapshot({ account: account([], [], 10_000, NOW - 60_000), markets, threads: [], intents: [], now: NOW });
    expect(evaluateImpact(stale, { symbol: 'SOLUSDT', side: 'long', qty: 1, price: 200, stop: 190 }).verdict).toBe('unavailable');
  });
  it('warns above 80% of a cap', () => {
    const s = computeSnapshot({ account: account([pos('SOLUSDT', 'long', 100, 200)]), markets, threads: [thread('SOLUSDT', 'long', 199.5)], intents: [], now: NOW });
    const r = evaluateImpact(s, { symbol: 'TSLAUSDT', side: 'short', qty: 12, price: 400, stop: 401 });
    expect(r.verdict).toBe('warn');
    expect(r.after.gross_ratio).toBeCloseTo(2.48);
  });
});

describe('evaluateRisk', () => {
  const wf = { ...DEFAULT_WORKFLOW, daily_loss_stop_pct: '3' };
  const okExec = { status: 'connected', detail: '', checked_at: NOW };
  const mkt = { BTCUSDT: NOW, ETHUSDT: NOW };
  it('quiet account → no alerts; fingerprints are stable across small value jitter', () => {
    const snap = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.05, 100_000)]), markets, threads: [thread('BTCUSDT', 'long', 99_000)], intents: [], now: NOW });
    const inp = { snapshot: snap, policy: DEFAULT_PORTFOLIO_POLICY, workflow: wf, threads: [], daily_loss_pct: 0.2, halted: false, execution: okExec, market_as_of: mkt, unknown_intents: 0, now: NOW };
    expect(evaluateRisk(inp)).toEqual([]);
    const a = evaluateRisk({ ...inp, daily_loss_pct: 2.01 });
    const b = evaluateRisk({ ...inp, daily_loss_pct: 2.34 });
    expect(a[0]!.kind).toBe('daily_loss');
    expect(a[0]!.severity).toBe('warn');
    expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
    expect(evaluateRisk({ ...inp, daily_loss_pct: 3.2 })[0]).toMatchObject({ severity: 'critical', auto_action: 'block_new_risk' });
  });
  it('high alerts for cluster over cap, missing protection, stale market, unknown orders, halted, disconnected', () => {
    const snap = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.15, 100_000), pos('ETHUSDT', 'long', 2, 4_000)]), markets, threads: [thread('BTCUSDT', 'long', 99_000)], intents: [], now: NOW });
    const alerts = evaluateRisk({ snapshot: snap, policy: DEFAULT_PORTFOLIO_POLICY, workflow: wf, threads: [{ ...thread('ETHUSDT', 'long', null), attention: 'PROTECTION_MISSING' }], daily_loss_pct: 0, halted: true, execution: { status: 'error', detail: 'token expired', checked_at: NOW }, market_as_of: { BTCUSDT: NOW, ETHUSDT: NOW - 10 * 60_000 }, unknown_intents: 1, now: NOW });
    const kinds = alerts.map((a) => a.kind).sort();
    expect(kinds).toEqual(expect.arrayContaining(['halted', 'cluster_concentration', 'protection_missing', 'thread_attention', 'execution_unknown', 'execution_disconnected', 'market_stale']));
    expect(blocksNewRisk(alerts)).toBe(true);
    expect(alerts.find((a) => a.kind === 'market_stale')!.severity).toBe('high'); // 1/2 of the watchlist stale
  });
  it('splits the protection alert into never_verified (high, per-symbol, does not block other symbols) and stale (warn) — 09-12 §9.31', () => {
    const snap = computeSnapshot({ account: account([]), markets, threads: [], intents: [], now: NOW });
    const base = { snapshot: snap, policy: DEFAULT_PORTFOLIO_POLICY, workflow: wf, threads: [], daily_loss_pct: 0, halted: false, execution: { status: 'connected', detail: '', checked_at: NOW }, market_as_of: { BTCUSDT: NOW, ETHUSDT: NOW }, unknown_intents: 0, now: NOW };
    const prot = { channel: 'agent_mcp', ttl_days: 7, never_verified: [] as string[], expired: [] as string[], probe_failed: [] as { symbol: string; error: string | null }[], auto_note: null as string | null };
    // 全部验过 = 没有保护腿告警
    expect(evaluateRisk({ ...base, protection: prot }).some((a) => a.kind.startsWith('protection_'))).toBe(false);
    // never_verified 不再阻断开仓,也不再产生 protection_never_verified 告警
    const never = evaluateRisk({ ...base, protection: { ...prot, never_verified: ['BTCUSDT'] } });
    expect(never.some((x) => x.kind === 'protection_never_verified')).toBe(false);
    const many = evaluateRisk({ ...base, protection: { ...prot, never_verified: ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'] } }).filter((x) => x.kind === 'protection_never_verified');
    expect(many).toHaveLength(0);
    expect(blocksNewRisk(never)).toBe(false);
    // 过期:warn + 带「重新验证」按钮;auto_note 解释这轮为什么没自动跑
    const stale = evaluateRisk({ ...base, protection: { ...prot, expired: ['ETHUSDT'], auto_note: '已暂停,没有自动重跑金丝雀' } });
    const st = stale.find((x) => x.kind === 'protection_stale')!;
    expect(st).toMatchObject({ severity: 'warn', scope: 'ETHUSDT' });
    expect(st.detail).toMatch(/已暂停/);
    expect(blocksNewRisk(stale)).toBe(false);
    // 真挂止损失败:同样是第二态 warn,原因写进 detail
    const failed = evaluateRisk({ ...base, protection: { ...prot, probe_failed: [{ symbol: 'SOLUSDT', error: '-4130' }] } });
    const f = failed.find((x) => x.kind === 'protection_stale')!;
    expect(f).toMatchObject({ severity: 'warn', scope: 'SOLUSDT' });
    expect(f.detail).toMatch(/-4130/);
  });

  it('raises transport_unstable (warn, never blocks) when the execution channel keeps losing responses — generic, not proxy-specific', () => {
    const snap = computeSnapshot({ account: account([]), markets, threads: [], intents: [], now: NOW });
    const base = { snapshot: snap, policy: DEFAULT_PORTFOLIO_POLICY, workflow: wf, threads: [], daily_loss_pct: 0, halted: false, execution: { status: 'connected', detail: '', checked_at: NOW }, market_as_of: { BTCUSDT: NOW, ETHUSDT: NOW }, unknown_intents: 0, now: NOW };
    const t = (runs: number, errors: number) => ({ window_ms: 1_800_000, runs, transport_errors: errors, last_error: errors ? 'Socket connection closed unexpectedly before a response was received' : null, last_at: errors ? NOW : null });
    expect(evaluateRisk({ ...base, transport: null }).some((a) => a.kind === 'transport_unstable')).toBe(false);
    expect(evaluateRisk({ ...base, transport: t(20, 1) }).some((a) => a.kind === 'transport_unstable')).toBe(false); // 一次不算
    expect(evaluateRisk({ ...base, transport: t(40, 2) }).some((a) => a.kind === 'transport_unstable')).toBe(false); // 2/40 = 5%,不算
    const alerts = evaluateRisk({ ...base, transport: t(6, 2) }); // 2/6 = 33%
    const a = alerts.find((x) => x.kind === 'transport_unstable')!;
    expect(a).toMatchObject({ severity: 'warn', scope: 'execution', auto_action: 'none' });
    expect(a.detail).toMatch(/不是交易所拒单/);
    expect(a.detail).toMatch(/不会因此误平仓/);
    expect(blocksNewRisk(alerts)).toBe(false);
    expect(evaluateRisk({ ...base, transport: t(100, 3) }).some((x) => x.kind === 'transport_unstable')).toBe(true); // 绝对次数 ≥3 也算
  });

  // 09-08:两条天天误报的 high(见 docs/demo/v3-ui-contract.md §9.23)
  it('账户略微过期只报 warn(通道节奏),超上界一倍才 high', () => {
    const backendLimit = 510_000; // agent_mcp:ttl 300 + timeout 120 + 余量 90
    const stale = (ageMs: number) =>
      evaluateRisk({
        snapshot: computeSnapshot({ account: account([], [], 10_000, NOW - ageMs), markets, threads: [], intents: [], now: NOW, account_max_age_ms: backendLimit }),
        policy: DEFAULT_PORTFOLIO_POLICY, workflow: wf, threads: [], daily_loss_pct: 0, halted: false, execution: okExec,
        market_as_of: mkt, unknown_intents: 0,
        account_age_ms: ageMs, account_max_age_ms: backendLimit, now: NOW,
      }).find((a) => a.kind === 'account_stale');
    expect(stale(400_000)).toBeUndefined(); // 还在上界内:快照 ok,一条都不报
    const mild = stale(600_000)!;
    expect(mild).toMatchObject({ severity: 'warn', auto_action: 'none' });
    expect(mild.detail).toMatch(/自动恢复/);
    expect(stale(1_200_000)).toMatchObject({ severity: 'high', auto_action: 'block_new_risk' });
  });

  it('快照不新鲜时「缺止损保护」只报 warn:止损刚成交与真裸奔在旧快照里长得一样', () => {
    const snap = computeSnapshot({ account: account([pos('ETHUSDT', 'long', 2, 4_000)]), markets, threads: [], intents: [], now: NOW });
    const base = { snapshot: snap, policy: DEFAULT_PORTFOLIO_POLICY, workflow: wf, threads: [], daily_loss_pct: 0, halted: false, execution: okExec, market_as_of: mkt, unknown_intents: 0, now: NOW };
    const fresh = evaluateRisk({ ...base, account_age_ms: 20_000 }).find((a) => a.kind === 'protection_missing')!;
    expect(fresh).toMatchObject({ severity: 'high', auto_action: 'block_new_risk' });
    const old = evaluateRisk({ ...base, account_age_ms: 400_000 }).find((a) => a.kind === 'protection_missing')!;
    expect(old).toMatchObject({ severity: 'warn', auto_action: 'none' });
    expect(old.detail).toMatch(/强制刷新账户/);
    expect(old.fingerprint).toBe(fresh.fingerprint); // 同一件事,升级不新建告警
  });
});

describe('evaluateRisk on a bad snapshot', () => {
  it('reports only the quality alert (no Infinity ratio alerts) when equity ≤ 0 or components are missing', () => {
    const zero = computeSnapshot({ account: account([pos('BTCUSDT', 'long', 0.1, 100_000)], [], 0), markets, threads: [], intents: [], now: NOW });
    const alerts = evaluateRisk({ snapshot: zero, policy: DEFAULT_PORTFOLIO_POLICY, workflow: { ...DEFAULT_WORKFLOW, daily_loss_stop_pct: '3' }, threads: [], daily_loss_pct: 0, halted: false, execution: { status: 'connected', detail: '', checked_at: NOW }, market_as_of: { BTCUSDT: NOW }, unknown_intents: 0, now: NOW });
    expect(alerts.map((a) => a.kind)).toEqual(['account_incomplete']);
    expect(alerts.some((a) => /Infinity/.test(a.title))).toBe(false);
    // equity 0 → dailyLossPct would be 100%; that is "unknown", not a loss.
    const withLoss = evaluateRisk({ snapshot: zero, policy: DEFAULT_PORTFOLIO_POLICY, workflow: { ...DEFAULT_WORKFLOW, daily_loss_stop_pct: '3' }, threads: [], daily_loss_pct: 100, halted: false, execution: { status: 'connected', detail: '', checked_at: NOW }, market_as_of: { BTCUSDT: NOW }, unknown_intents: 0, now: NOW });
    expect(withLoss.some((a) => a.kind === 'daily_loss')).toBe(false);
  });
});

describe('RiskStore latch', () => {
  let state: StateDb;
  afterEach(() => state?.close());
  it('09-20:基础设施类 high(止损未验证/组件过期)条件消失就自动解除,不攒「确认恢复」;confirmAllRecovery 一次关掉所有 ready 的', () => {
    state = openStateDb(':memory:');
    const rs = new RiskStore(state.db);
    const base = { severity: 'high' as const, scope: 'x', title: 't', detail: '', value: null, threshold: null, refs: [], auto_action: 'none' as const };
    const never = { ...base, kind: 'protection_never_verified' as const, scope: 'channel:okx', fingerprint: riskFingerprint('protection_never_verified', 'channel:okx') };
    const stale = { ...base, kind: 'account_stale' as const, scope: 'account', fingerprint: riskFingerprint('account_stale', 'account'), auto_action: 'block_new_risk' as const };
    const money = { ...base, kind: 'gross_exposure' as const, scope: 'account', fingerprint: riskFingerprint('gross_exposure', 'account'), auto_action: 'block_new_risk' as const };
    rs.reconcile([never, stale, money], NOW);
    let r = { resolved: [] as { fingerprint: string }[], recovery_ready: [] as { fingerprint: string }[] };
    for (let i = 0; i < CLEAN_STREAK_TO_RESOLVE; i++) r = rs.reconcile([], NOW + 10 + i);
    expect(r.resolved.map((a) => a.fingerprint).sort()).toEqual([never.fingerprint, stale.fingerprint].sort());
    expect(r.recovery_ready.map((a) => a.fingerprint)).toEqual([money.fingerprint]);
    expect(rs.open()).toHaveLength(1);
    const done = rs.confirmAllRecovery(NOW + 50);
    expect(done.map((a) => a.fingerprint)).toEqual([money.fingerprint]);
    expect(rs.open()).toHaveLength(0);
    // 条件还在的不会被「全部恢复」误关
    rs.reconcile([money], NOW + 60);
    expect(rs.confirmAllRecovery(NOW + 61)).toHaveLength(0);
    expect(rs.open()).toHaveLength(1);
  });
  it('warn auto-resolves after 3 clean rounds; high only becomes recovery_ready and stays open until a human confirms; ack never resolves', () => {
    state = openStateDb(':memory:');
    const rs = new RiskStore(state.db);
    const warn = { kind: 'daily_loss' as const, severity: 'warn' as const, fingerprint: riskFingerprint('daily_loss', 'account'), scope: 'account', title: 'w', detail: '', value: 2, threshold: 3, refs: [], auto_action: 'none' as const };
    const high = { ...warn, kind: 'gross_exposure' as const, severity: 'high' as const, fingerprint: riskFingerprint('gross_exposure', 'account'), auto_action: 'block_new_risk' as const };
    let r = rs.reconcile([warn, high], NOW);
    expect(r.opened).toHaveLength(2);
    r = rs.reconcile([warn, high], NOW + 1);
    expect(r.opened).toHaveLength(0);
    expect(rs.open().find((a) => a.fingerprint === riskFingerprint('daily_loss', 'account'))!.observed_count).toBe(2);
    // ack ≠ resolve
    const highRow = rs.open().find((a) => a.fingerprint === riskFingerprint('gross_exposure', 'account'))!;
    expect(rs.ack(highRow.id, NOW)!.resolved_at).toBeNull();
    expect(blocksNewRisk(rs.open())).toBe(true);
    // clean rounds
    for (let i = 1; i < CLEAN_STREAK_TO_RESOLVE; i++) {
      r = rs.reconcile([], NOW + 10 + i);
      expect(r.resolved).toHaveLength(0);
      expect(r.recovery_ready).toHaveLength(0);
    }
    r = rs.reconcile([], NOW + 100);
    expect(r.resolved.map((a) => a.fingerprint)).toEqual([riskFingerprint('daily_loss', 'account')]);
    expect(r.recovery_ready.map((a) => a.fingerprint)).toEqual([riskFingerprint('gross_exposure', 'account')]);
    expect(rs.open().map((a) => a.fingerprint)).toEqual([riskFingerprint('gross_exposure', 'account')]);
    expect(blocksNewRisk(rs.open())).toBe(false); // 09-06:成因已消除只等人确认的不再挡单(告警本身还开着)
    expect(rs.open()[0]!.recovery_ready).toBe(true);
    // the condition comes back → recovery_ready cleared
    r = rs.reconcile([high], NOW + 200);
    expect(rs.open()[0]!.recovery_ready).toBe(false);
    expect(rs.confirmRecovery(highRow.id, NOW + 201).ok).toBe(false);
    for (let i = 0; i < CLEAN_STREAK_TO_RESOLVE; i++) rs.reconcile([], NOW + 300 + i);
    expect(rs.confirmRecovery(highRow.id, NOW + 400).ok).toBe(true);
    expect(rs.open()).toHaveLength(0);
    // re-occurrence after resolve opens a NEW row (history kept)
    rs.reconcile([high], NOW + 500);
    expect(rs.list({ status: 'all' }).filter((a) => a.fingerprint === riskFingerprint('gross_exposure', 'account'))).toHaveLength(2);
  });
});

describe('runtime wiring', () => {
  let rt: DemoRuntime | null = null;
  let state: StateDb | null = null;
  afterEach(async () => {
    if (rt) await rt.stop();
    state?.close();
    rt = null;
    state = null;
  });
  it('seeds both code roles enabled, computes a snapshot on account poll, derives presence, policy only tightens without confirm', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state);
    expect(store.bots.profile('portfolio_manager')!.enabled).toBe(true);
    expect(store.bots.profile('risk_sentinel')!.enabled).toBe(true);
    rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain(() => '{}') }, marketPollMs: 600_000, accountPollMs: 600_000, radar: { runScreen: async () => { throw new Error('no'); } } });
    expect(presenceFor('portfolio_manager', rt, true).state).toBe('waiting');
    rt.evaluateTeamRisk({ backend: 'paper', equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: Date.now() });
    expect(rt.portfolioSnapshot?.quality).toBe('ok');
    expect(store.portfolio.latest()?.snapshot_id).toBe(rt.portfolioSnapshot!.snapshot_id);
    expect(presenceFor('portfolio_manager', rt, true).state).toBe('idle');
    // watchlist markets are not loaded in this test → market_stale is a real (high) alert on 6/6 symbols
    expect(rt.riskOpen.map((a) => a.kind)).toEqual(['market_stale']);
    expect(presenceFor('risk_sentinel', rt, true).state).toBe('working');
    // policy
    expect(rt.setPortfolioPolicy({ max_gross_ratio: 2 }).errors).toEqual([]);
    expect(rt.portfolioPolicy().max_gross_ratio).toBe(2);
    expect(rt.setPortfolioPolicy({ max_gross_ratio: 4 }).errors.join(' ')).toMatch(/LOOSEN/);
    expect(rt.setPortfolioPolicy({ max_gross_ratio: 4 }, 'LOOSEN').errors).toEqual([]);
    expect(rt.portfolioPolicy().version).toBe(3);
    // impact on the live snapshot
    const impact = rt.portfolioImpact({ symbol: 'BTCUSDT', side: 'long', qty: 0.01, price: 100_000, stop: 99_000 });
    expect(impact?.verdict).toBe('pass');
  });
});

describe('one alert per kind + scope', () => {
  it('updates age, count, threshold and refs, preserves first seen; merges legacy minute buckets on startup', () => {
    const state = openStateDb(':memory:');
    try {
      let rs = new RiskStore(state.db);
      const alert = { kind: 'account_stale' as const, severity: 'high' as const, scope: 'account', fingerprint: 'old', title: '过期 60 秒', detail: '', value: 60_000, threshold: 30_000, refs: ['pf1'], auto_action: 'block_new_risk' as const };
      rs.reconcile([alert], NOW);
      rs.reconcile([{ ...alert, fingerprint: 'new-minute', value: 180_000, title: '过期 180 秒', threshold: 60_000, refs: ['pf2'] }], NOW + 120_000);
      const row = rs.open()[0]!;
      expect(rs.open()).toHaveLength(1);
      expect(row).toMatchObject({ first_seen_at: NOW, last_seen_at: NOW + 120_000, observed_count: 2, value: 180_000, threshold: 60_000, refs: ['pf2'] });
      // Simulate historical bucket rows; migration is idempotent and does not drop counts.
      state.db.prepare(`INSERT INTO demo_risk_alert SELECT 'legacy', 'minute-old', kind, severity, scope, title, detail, value, threshold, refs_json, auto_action, first_seen_at - 1, last_seen_at - 1, 7, resolved_at, acked_at, clean_streak, recovery_ready FROM demo_risk_alert WHERE id=?`).run(row.id);
      rs = new RiskStore(state.db);
      expect(rs.open()).toHaveLength(1);
      expect(rs.open()[0]).toMatchObject({ id: 'legacy', observed_count: 9, value: 180_000, first_seen_at: NOW - 1 });
      expect(riskSummary(rs.open())).toEqual(['过期 180 秒 ×9']);
      expect(new RiskStore(state.db).open()[0]!.observed_count).toBe(9);
      rs.reconcile([{ ...alert, scope: 'other' }, alert], NOW + 180_000);
      expect(rs.open()).toHaveLength(2);
      expect(riskSummary(rs.open())).toHaveLength(1);
    } finally { state.close(); }
  });
});
