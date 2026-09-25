import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { MarketInbox, type QueueRow } from '../../src/demo/asp-agent/inbox.js';
import { DEFAULT_MARKET_SETTINGS } from '../../src/demo/asp-agent/settings.js';
import { scorecardFor, SCORECARD_TTL_MS, type ScorecardDeps } from '../../src/demo/asp-agent/scorecard.js';
import type { Kline } from '../../src/demo/types.js';

const states: StateDb[] = [];
afterEach(() => { for (const s of states.splice(0)) s.close(); });
function store() { const s = openStateDb(':memory:'); states.push(s); return new DemoStore(s); }

const TF = 15 * 60 * 1000;
/** 15m 整点边界(1800000000000 / 900000 正好整除),K 线与信号共用。 */
const T0 = 1800000000000;
const JOB = 'job-1';

/** 一条 ASP order 投递。默认是 BTC 多单:入场 60000 / 止损 59000 / 止盈 62000。 */
const row = (id: string, patch: Record<string, unknown> = {}): QueueRow => ({
  id, job_id: JOB, message_id: id,
  content: JSON.stringify({ deliveryId: id, signal_type: 'order', symbol: 'BTC-USDT-SWAP', action: 'LONG', signalTime: T0, price: '60000', stop_loss: '59000', take_profit: ['62000'], ...patch }),
  llm_content: null, payload_json: null, created_at: new Date(T0).toISOString(),
});

/** 第 i 根 15m K 线(从 T0 起)。 */
const k = (i: number, high: number, low: number, close: number): Kline => ({
  open_time: T0 + i * TF, open: String(close), high: String(high), low: String(low), close: String(close), volume: '1', close_time: T0 + (i + 1) * TF - 1,
});

/** 灌一批投递并落进信号账本(accept 写投递表,capture 写 demo_trader_signal)。 */
async function seed(s: DemoStore, rows: QueueRow[]) {
  const inbox = new MarketInbox({
    store: s, settings: () => ({ ...DEFAULT_MARKET_SETTINGS, enabled: true }),
    session: () => 's1', now: () => T0, system: async () => {}, emit: () => {},
  });
  await inbox.accept(rows);
  return inbox.capture();
}

function deps(s: DemoStore, klines: Kline[] | ((symbol: string) => Kline[]), patch: Partial<ScorecardDeps> = {}): ScorecardDeps {
  return {
    store: s, now: T0 + 20 * TF,
    fetchKlines: async (symbol) => (typeof klines === 'function' ? klines(symbol) : klines),
    ...patch,
  };
}

describe('ASP 订阅信号事后回测评分', () => {
  it('止盈命中:R 为正,mfe/mae 用持仓期间极值,战绩汇总跟着走', async () => {
    const s = store();
    await seed(s, [row('a')]);
    // bar0 成交(60000 落在 59900–60100),bar0 不判出场;bar2 摸到 62500 → 止盈 62000。
    const card = await scorecardFor(JOB, deps(s, [k(0, 60100, 59900, 60000), k(1, 61000, 60000, 60900), k(2, 62500, 60800, 62200)]));
    expect(card.outcomes).toHaveLength(1);
    const o = card.outcomes[0]!;
    expect(o).toMatchObject({ symbol: 'BTCUSDT', side: 'long', status: 'tp_hit', entry: '60000', stop: '59000', tps: ['62000'] });
    expect(o.r).toBe(2);             // (62000-60000)/1000
    expect(o.mfe_r).toBe(2.5);       // 62500 的高点
    expect(o.mae_r).toBe(0);         // 持仓期间最低 60000
    expect(o.entry_at).toBe(T0);
    expect(o.exit_at).toBe(T0 + 2 * TF);
    expect(card).toMatchObject({ job_id: JOB, n_signals: 1, n_scored: 1, wins: 1, losses: 0, win_rate: 1, avg_r: 2, sum_r: 2, avg_rr_planned: 2 });
    expect(card.profit_factor).toBeNull(); // 一笔亏损都没有 → null,不给 Infinity
    expect(card.computed_at).toBe(T0 + 20 * TF);
  });

  it('止损命中:R 为负;空头方向反过来算', async () => {
    const s = store();
    await seed(s, [row('short', { action: 'SHORT', price: '60000', stop_loss: '61000', take_profit: ['58000'] })]);
    // bar0 成交;bar2 打到 61200 → 触发 61000 止损。
    const card = await scorecardFor(JOB, deps(s, [k(0, 60100, 59900, 60000), k(1, 60500, 59800, 59900), k(2, 61200, 59700, 61100)]));
    const o = card.outcomes[0]!;
    expect(o).toMatchObject({ side: 'short', status: 'stopped' });
    expect(o.r).toBe(-1);            // 空头止损永远 -1R
    expect(o.mfe_r).toBe(0.3);       // 59700 对空头有利
    expect(o.mae_r).toBe(-1.2);      // 61200 对空头不利
    expect(card).toMatchObject({ n_scored: 1, wins: 0, losses: 1, win_rate: 0, avg_r: -1, sum_r: -1, profit_factor: 0, avg_rr_planned: 2 });
  });

  it('同一根 K 线既碰止损又碰止盈:按止损算(保守)', async () => {
    const s = store();
    await seed(s, [row('both')]);
    const card = await scorecardFor(JOB, deps(s, [k(0, 60100, 59900, 60000), k(1, 62500, 58800, 61000)]));
    expect(card.outcomes[0]).toMatchObject({ status: 'stopped', r: -1, exit_at: T0 + TF });
    expect(card).toMatchObject({ wins: 0, losses: 1, n_scored: 1 });
  });

  it('入场价始终没被摸到:有效期一过就是 expired,不计分', async () => {
    const s = store();
    // 入场 50000 远低于行情,有效期只有 30 分钟。
    await seed(s, [row('miss', { price: '50000', stop_loss: '49000', valid_until: T0 + 2 * TF })]);
    const card = await scorecardFor(JOB, deps(s, [k(0, 60100, 59900, 60000), k(1, 60300, 59950, 60200), k(2, 60400, 60000, 60300), k(3, 60500, 60100, 60400)]));
    expect(card.outcomes[0]).toMatchObject({ status: 'expired', r: null, entry_at: null, exit_at: null });
    expect(card).toMatchObject({ n_signals: 1, n_scored: 0, wins: 0, losses: 0, win_rate: null, avg_r: null, sum_r: null, profit_factor: null });
  });

  it('没有止损的信号不计分,但不拖累同一订阅里其它信号', async () => {
    const s = store();
    await seed(s, [row('nostop', { stop_loss: null }), row('ok')]);
    const card = await scorecardFor(JOB, deps(s, [k(0, 60100, 59900, 60000), k(1, 62500, 61000, 62200)]));
    const nostop = card.outcomes.find((o) => o.signal_id === 'okxasp_nostop')!;
    expect(nostop).toMatchObject({ status: 'unscorable', r: null, stop: null });
    expect(nostop.note).toContain('没有止损');
    expect(card).toMatchObject({ n_signals: 2, n_scored: 1, wins: 1, losses: 0, avg_r: 2 });
    // 计划盈亏比只看信号自己写的三个价:缺 stop 的那条算不出,不进平均。
    expect(card.avg_rr_planned).toBe(2);
  });

  it('10 分钟内命中缓存(computed_at 不变、不再拉 K 线),force 强制重算', async () => {
    const s = store();
    await seed(s, [row('a')]);
    const bars = [k(0, 60100, 59900, 60000), k(1, 62500, 61000, 62200)];
    const fetchKlines = vi.fn(async () => bars);
    const first = await scorecardFor(JOB, { store: s, now: T0, fetchKlines });
    expect(fetchKlines).toHaveBeenCalledTimes(1);
    expect(s.kvGet(`market.scorecard.${JOB}`)).toContain('"job_id":"job-1"');

    const cachedCard = await scorecardFor(JOB, { store: s, now: T0 + SCORECARD_TTL_MS - 1, fetchKlines });
    expect(fetchKlines).toHaveBeenCalledTimes(1);
    expect(cachedCard.computed_at).toBe(first.computed_at);

    const forced = await scorecardFor(JOB, { store: s, now: T0 + 60_000, fetchKlines, force: true });
    expect(fetchKlines).toHaveBeenCalledTimes(2);
    expect(forced.computed_at).toBe(T0 + 60_000);

    const stale = await scorecardFor(JOB, { store: s, now: T0 + SCORECARD_TTL_MS + 60_000, fetchKlines });
    expect(fetchKlines).toHaveBeenCalledTimes(3);
    expect(stale.computed_at).toBe(T0 + SCORECARD_TTL_MS + 60_000);
  });

  it('同 symbol 一次评分只拉一次 K 线;拉取失败只毁那一条', async () => {
    const s = store();
    await seed(s, [
      row('btc1'), row('btc2', { price: '60050' }),
      row('eth', { symbol: 'ETH-USDT-SWAP', price: '3000', stop_loss: '2900', take_profit: ['3200'] }),
    ]);
    const bars = [k(0, 60100, 59900, 60000), k(1, 62500, 61000, 62200)];
    const fetchKlines = vi.fn(async (symbol: string) => {
      if (symbol === 'ETHUSDT') throw new Error('rate limited');
      return bars;
    });
    const card = await scorecardFor(JOB, { store: s, now: T0 + 20 * TF, fetchKlines });
    expect(fetchKlines.mock.calls.map((c) => c[0]).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    const eth = card.outcomes.find((o) => o.symbol === 'ETHUSDT')!;
    expect(eth.status).toBe('unscorable');
    expect(eth.note).toContain('rate limited');
    expect(card).toMatchObject({ n_signals: 3, n_scored: 2, wins: 2, losses: 0 });
  });

  it('还在场内 = open,浮动 R 用最后一根收盘价;还没到期没成交 = pending_entry', async () => {
    const s = store();
    await seed(s, [row('live'), row('waiting', { price: '50000', stop_loss: '49000' })]);
    const card = await scorecardFor(JOB, deps(s, [k(0, 60100, 59900, 60000), k(1, 61000, 59500, 60500)], { now: T0 + 2 * TF }));
    const live = card.outcomes.find((o) => o.signal_id === 'okxasp_live')!;
    expect(live).toMatchObject({ status: 'open', r: 0.5, mfe_r: 1, mae_r: -0.5, exit_at: null });
    // valid_until 缺省 = published_at + 24h,还没到 → 挂单还在等,不是过期。
    expect(card.outcomes.find((o) => o.signal_id === 'okxasp_waiting')).toMatchObject({ status: 'pending_entry', r: null });
    expect(card).toMatchObject({ n_signals: 2, n_scored: 1, wins: 1, losses: 0 });
  });

  it('只有 open 动作进样本;没有这个订阅的信号给空成绩单', async () => {
    const s = store();
    await seed(s, [row('a'), row('closer', { action: 'CLOSE' }), row('adder', { action: 'ADD' })]);
    const card = await scorecardFor(JOB, deps(s, [k(0, 60100, 59900, 60000), k(1, 62500, 61000, 62200)]));
    expect(card.outcomes.map((o) => o.signal_id)).toEqual(['okxasp_a']);

    const empty = await scorecardFor('job-nobody', deps(s, []));
    expect(empty).toMatchObject({ job_id: 'job-nobody', n_signals: 0, n_scored: 0, wins: 0, losses: 0, win_rate: null, avg_r: null, sum_r: null, profit_factor: null, avg_rr_planned: null, outcomes: [] });
  });
});
