/**
 * 策略归因报告(契约 §9.37;设计 docs/design/attribution-and-tiers-2026-09-12.md §1)。
 *
 * 汇总是**纯函数**,所以大部分用例直接喂 `AttributionTrade`,不开库;
 * 只有「净 R 口径不漂」那一条要和 `strategy-loop.realizedRFromThreads` 对拍,才开一个内存库。
 */
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_MIN_SAMPLE,
  attributionTradeOf,
  exitKindOf,
  REPLAY_TIMEFRAME_FALLBACK,
  summarizeAttribution,
  type AttributionTrade,
  type ExitKind,
  type SymbolOrigin,
} from '../../src/demo/attribution.js';
import { realizedRFromThreads } from '../../src/demo/strategy-loop.js';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import type { Direction, StrategyThread } from '../../src/demo/types.js';

const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;

function trade(over: Partial<AttributionTrade> = {}): AttributionTrade {
  return {
    thread_id: `t-${Math.random().toString(36).slice(2, 8)}`,
    symbol: 'BTCUSDT',
    direction: 'long',
    opened_at: NOW,
    closed_at: NOW + HOUR,
    timeframe: '15m',
    net_r: 1,
    r_source: 'settlement',
    exit: 'take_profit',
    stop_distance_pct: 1,
    cost_over_risk: 0.05,
    origin: 'watchlist',
    mae_r: null,
    mfe_r: null,
    ...over,
  };
}

/** n 笔同形样本,时间上逐小时排开(窗口算得出来)。 */
function many(n: number, over: Partial<AttributionTrade> | ((i: number) => Partial<AttributionTrade>) = {}): AttributionTrade[] {
  return Array.from({ length: n }, (_, i) =>
    trade({ opened_at: NOW + i * HOUR, closed_at: NOW + (i + 1) * HOUR, ...(typeof over === 'function' ? over(i) : over) }),
  );
}

const base = { strategy_id: 'breakout_retest', strategy_version: 1, backend: 'paper' };

describe('方向维度', () => {
  it('多空各自 n / 净 R / 胜率,skew = long 期望 − short 期望', () => {
    const trades = [
      ...many(6, { direction: 'long' as Direction, net_r: 2 }),
      ...many(6, { direction: 'short' as Direction, net_r: -1 }),
    ];
    const r = summarizeAttribution(trades, base);
    expect(r.n).toBe(12);
    expect(r.direction.insufficient).toBe(false);
    expect(r.direction.long).toMatchObject({ n: 6, net_r_sum: 12, expectancy_r: 2, win_rate: 1 });
    expect(r.direction.short).toMatchObject({ n: 6, net_r_sum: -6, expectancy_r: -1, win_rate: 0 });
    expect(r.direction.skew).toBe(3);
  });

  it('只有单边样本时 skew 仍算得出来(另一边期望 = null → skew = null,不拿 0 冒充)', () => {
    const r = summarizeAttribution(many(12, { direction: 'long' as Direction }), base);
    expect(r.direction.short.n).toBe(0);
    expect(r.direction.short.expectancy_r).toBeNull();
    expect(r.direction.skew).toBeNull();
  });
});

describe('止损 / 止盈维度', () => {
  it('close_reason 六种文本 → 六个 ExitKind', () => {
    const cases: [string | null, ExitKind][] = [
      ['止损触发 @ 96000', 'stop'],
      ['止盈触发 @ 104000', 'take_profit'],
      ['挂单到期未成交', 'expiry'],
      ['论点失效,撤单', 'invalidation'],
      ['用户手动平仓', 'manual'],
      [null, 'other'],
    ];
    for (const [reason, kind] of cases) expect(exitKindOf(reason)).toBe(kind);
  });

  it('「止损」判定排在「平仓」之前:止损回执里带「平仓」两个字也还是止损', () => {
    expect(exitKindOf('止损触发,已平仓 @ 96000')).toBe('stop');
  });

  it('各 kind 的占比之和 = 1,期望按 kind 分开算', () => {
    const trades = [
      ...many(4, { exit: 'stop' as ExitKind, net_r: -1 }),
      ...many(6, { exit: 'take_profit' as ExitKind, net_r: 2 }),
      ...many(2, { exit: 'expiry' as ExitKind, net_r: 0 }),
    ];
    const r = summarizeAttribution(trades, base);
    expect(r.exits.by_kind.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 6);
    expect(r.exits.by_kind.find((b) => b.kind === 'stop')).toMatchObject({ n: 4, expectancy_r: -1 });
    expect(r.exits.by_kind.find((b) => b.kind === 'take_profit')).toMatchObject({ n: 6, expectancy_r: 2 });
    expect(r.exits.by_kind.find((b) => b.kind === 'expiry')!.n).toBe(2);
  });

  it('止损距离中位与费/风险比中位;线上没有 MAE/MFE 时写 null 并说明,不编近似值', () => {
    const trades = many(12, (i) => ({ stop_distance_pct: i < 6 ? 1 : 3, cost_over_risk: 0.1 }));
    const r = summarizeAttribution(trades, base);
    expect(r.exits.stop_distance_pct_p50).toBe(2);
    expect(r.exits.cost_over_risk_p50).toBeCloseTo(0.1, 6);
    expect(r.exits.mae_r_p50).toBeNull();
    expect(r.exits.mfe_r_p50).toBeNull();
    expect(r.exits.note).toContain('不编近似值');
  });

  it('线程上真的记了极值时,中位数自动就有(签名已经留好位置)', () => {
    const r = summarizeAttribution(many(12, { mae_r: -0.4, mfe_r: 1.8 }), base);
    expect(r.exits.mae_r_p50).toBe(-0.4);
    expect(r.exits.mfe_r_p50).toBe(1.8);
    expect(r.exits.note).toBe('');
  });
});

describe('周期一致性维度', () => {
  it('线上 1h×3 + 15m×9 而回放是 15m → consistent=false,mismatch 只列 1h', () => {
    const trades = many(12, (i) => ({ timeframe: i < 3 ? '1h' : '15m' }));
    const r = summarizeAttribution(trades, { ...base, replay_timeframe: '15m' });
    expect(r.period.consistent).toBe(false);
    expect(r.period.mismatch).toEqual([{ tf: '1h', n: 3 }]);
    expect(r.period.online_timeframes).toEqual([{ tf: '15m', n: 9 }, { tf: '1h', n: 3 }]);
  });

  it('全是 15m → consistent=true;回放周期缺省回落到 15m', () => {
    const r = summarizeAttribution(many(12), base);
    expect(r.period.replay_timeframe).toBe(REPLAY_TIMEFRAME_FALLBACK);
    expect(r.period.consistent).toBe(true);
    expect(r.period.mismatch).toEqual([]);
  });

  it('gap = 线上净期望 − 回放 OOS 净期望;任一侧没有数就是 null', () => {
    const withReplay = summarizeAttribution(many(12, { net_r: 0.5 }), { ...base, replay_oos_net_expectancy: 0.2 });
    expect(withReplay.period.live_net_expectancy_r).toBe(0.5);
    expect(withReplay.period.gap).toBeCloseTo(0.3, 6);
    const noReplay = summarizeAttribution(many(12, { net_r: 0.5 }), base);
    expect(noReplay.period.gap).toBeNull();
  });
});

describe('screener 来源维度', () => {
  it('四个来源各一批,占比与各自净期望分开算', () => {
    const trades = [
      ...many(3, { origin: 'radar' as SymbolOrigin, net_r: 2 }),
      ...many(3, { origin: 'whitelist' as SymbolOrigin, net_r: 1 }),
      ...many(3, { origin: 'watchlist' as SymbolOrigin, net_r: -1 }),
      ...many(3, { origin: 'manual' as SymbolOrigin, net_r: -2 }),
    ];
    const r = summarizeAttribution(trades, base);
    expect(r.screener.by_origin.map((b) => b.origin)).toEqual(['radar', 'whitelist', 'watchlist', 'manual']);
    expect(r.screener.by_origin.find((b) => b.origin === 'radar')).toMatchObject({ n: 3, expectancy_r: 2 });
    expect(r.screener.by_origin.find((b) => b.origin === 'manual')).toMatchObject({ n: 3, expectancy_r: -2 });
    expect(r.screener.by_origin.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 6);
  });
});

describe('频率维度', () => {
  it('机会数/被闸拒分布只来自 decision_record,没有时如实写「无法统计」', () => {
    const r = summarizeAttribution(many(12), base);
    expect(r.frequency.opportunities).toBeNull();
    expect(r.frequency.blocked).toEqual([]);
    expect(r.frequency.note).toContain('无法统计');
  });

  it('有 decision_record 时给转化率与被闸拒直方图(按次数降序)', () => {
    const trades = many(12);
    const r = summarizeAttribution(trades, {
      ...base,
      opportunities: { opportunities: 48, blocked: { 每日开仓上限: 3, 信心下限: 9 }, coverage_from: NOW - 86_400_000 },
    });
    expect(r.frequency.opportunities).toBe(48);
    expect(r.frequency.conversion).toBeCloseTo(12 / 48, 6);
    expect(r.frequency.blocked).toEqual([{ gate: '信心下限', n: 9 }, { gate: '每日开仓上限', n: 3 }]);
    expect(r.frequency.coverage_from).toBe(NOW - 86_400_000);
    // 窗口 12 小时不足一周,按一周计:12 笔 / 1 周。
    expect(r.frequency.opens_per_week).toBe(12);
  });
});

describe('样本不足', () => {
  it(`n < ${ATTRIBUTION_MIN_SAMPLE} → 整块 insufficient,推断量全 null,计数量仍在`, () => {
    const trades = [
      ...many(5, { direction: 'long' as Direction, exit: 'stop' as ExitKind }),
      ...many(4, { direction: 'short' as Direction, exit: 'take_profit' as ExitKind }),
    ];
    const r = summarizeAttribution(trades, base);
    expect(r.n).toBe(9);
    expect(r.insufficient).toBe(true);
    // 推断量
    expect(r.expectancy_r).toBeNull();
    expect(r.win_rate).toBeNull();
    expect(r.direction.long.expectancy_r).toBeNull();
    expect(r.direction.skew).toBeNull();
    expect(r.exits.by_kind.every((b) => b.expectancy_r === null)).toBe(true);
    expect(r.exits.stop_distance_pct_p50).toBeNull();
    expect(r.period.gap).toBeNull();
    expect(r.screener.by_origin.every((b) => b.expectancy_r === null)).toBe(true);
    // 计数量:数不够不许出结论,但不许假装没数据
    expect(r.direction.long.n).toBe(5);
    expect(r.direction.short.n).toBe(4);
    expect(r.exits.by_kind.find((b) => b.kind === 'stop')!.n).toBe(5);
    expect(r.net_r_sum).toBe(9);
  });

  it(`n = ${ATTRIBUTION_MIN_SAMPLE} 正好够`, () => {
    const r = summarizeAttribution(many(ATTRIBUTION_MIN_SAMPLE), base);
    expect(r.insufficient).toBe(false);
    expect(r.expectancy_r).toBe(1);
  });
});

// ---------------------------------------------------------------- 口径对拍(开库)

function thread(over: Partial<StrategyThread>): StrategyThread {
  return {
    id: `th-${Math.random().toString(36).slice(2, 9)}`,
    symbol: 'BTCUSDT',
    side: 'long',
    status: 'closed',
    source: 'agent',
    backend: 'paper',
    strategy_id: 'breakout_retest',
    strategy_version: 1,
    timeframe: '15m',
    thesis: '',
    invalidation_text: null,
    watch_conditions: [],
    entry: { type: 'market', price: '100', zone: null },
    stop_price: '98',
    take_profits: ['104'],
    qty: '1',
    margin_usdt: null,
    leverage: 3,
    margin_mode: 'cross',
    entry_client_order_id: 'cid',
    protection_client_order_ids: [],
    filled_avg_price: '100',
    realized_pnl: '2',
    exit_price: '102',
    close_reason: '止盈触发 @ 102',
    attention: null,
    entry_lookup_misses: 0,
    leg_seq: 1,
    episode_ids: [],
    intent_ids: [],
    created_at: NOW,
    updated_at: NOW + HOUR,
    opened_at: NOW,
    closed_at: NOW + HOUR,
    version: 1,
    settlement: { at: NOW + HOUR, realized_pnl: '2', commission: '0.1', funding: '-0.02', net_pnl: '1.88', exit_price: '102', trades: 2, window: [NOW, NOW + HOUR], source: 'exchange', initial_risk_usdt: '2' },
    ...over,
  } as StrategyThread;
}

describe('净 R 口径不漂(对拍 strategy-loop.realizedRFromThreads)', () => {
  it('同一批线程,attributionTradeOf 的 net_r 序列 === realizedRFromThreads', () => {
    const db = openStateDb(':memory:');
    const store = new DemoStore(db);
    const rows = [
      thread({ settlement: { at: NOW + HOUR, realized_pnl: '3', commission: '0.1', funding: '0', net_pnl: '2.9', exit_price: '103', trades: 2, window: [NOW, NOW + HOUR], source: 'exchange', initial_risk_usdt: '2' }, closed_at: NOW + HOUR }),
      thread({ side: 'short', settlement: { at: NOW + 2 * HOUR, realized_pnl: '-2', commission: '0.1', funding: '-0.1', net_pnl: '-2.2', exit_price: '102', trades: 2, window: [NOW, NOW + 2 * HOUR], source: 'exchange', initial_risk_usdt: '2' }, closed_at: NOW + 2 * HOUR }),
      thread({ settlement: { at: NOW + 3 * HOUR, realized_pnl: '1', commission: '0.05', funding: '0', net_pnl: '0.95', exit_price: '101', trades: 2, window: [NOW, NOW + 3 * HOUR], source: 'exchange', initial_risk_usdt: '2' }, closed_at: NOW + 3 * HOUR }),
    ];
    for (const t of rows) store.saveThread(t);

    const expected = realizedRFromThreads(store, 'breakout_retest', 1, 'paper');
    const actual = store
      .closedThreads(100, 'paper')
      .map((t) => attributionTradeOf(t, () => 'watchlist'))
      .filter((x): x is AttributionTrade => x !== null)
      .sort((a, b) => a.closed_at - b.closed_at)
      .map((t) => t.net_r);

    expect(expected.length).toBe(3);
    expect(actual).toEqual(expected);
    db.close();
  });

  it('没有交易所净额时退到价格算 R 并标 price(报告里 price_only_n 会显出来)', () => {
    const t = thread({ realized_pnl: null, settlement: null, exit_price: '102' });
    const a = attributionTradeOf(t, () => 'radar')!;
    expect(a.r_source).toBe('price');
    expect(a.net_r).toBe(1); // (102-100)*1 / |100-98|*1
    expect(a.cost_over_risk).toBeNull();
    const r = summarizeAttribution([a], base);
    expect(r.price_only_n).toBe(1);
  });

  it('费/风险比:手续费 + 资金费支出 ÷ 初始风险;资金费是收入时不抵扣手续费', () => {
    const paid = attributionTradeOf(thread({ settlement: { at: NOW, realized_pnl: '2', commission: '0.1', funding: '-0.1', net_pnl: '1.8', exit_price: '102', trades: 2, window: [NOW, NOW], source: 'exchange', initial_risk_usdt: '2' } }), () => 'radar')!;
    expect(paid.cost_over_risk).toBeCloseTo(0.1, 6); // (0.1 + 0.1) / 2
    const earned = attributionTradeOf(thread({ settlement: { at: NOW, realized_pnl: '2', commission: '0.1', funding: '0.5', net_pnl: '2.4', exit_price: '102', trades: 2, window: [NOW, NOW], source: 'exchange', initial_risk_usdt: '2' } }), () => 'radar')!;
    expect(earned.cost_over_risk).toBeCloseTo(0.05, 6); // 只有手续费
  });

  it('还没平仓 / 数量不可用的线程不进统计', () => {
    expect(attributionTradeOf(thread({ status: 'in_position' }), () => 'radar')).toBeNull();
    expect(attributionTradeOf(thread({ qty: '0' }), () => 'radar')).toBeNull();
    expect(attributionTradeOf(thread({ qty: 'x' }), () => 'radar')).toBeNull();
  });

  it('口径继承的怪癖:`filled_avg_price: null` 被 realizedRFromThreads 当 0 收下,这里保持一致', () => {
    // `Number(null ?? '')` 是 0 不是 NaN —— strategy-loop 的 realizedRFromThreads 就是这么判的。
    // 归因**故意**不在这里收紧:两边口径必须是同一个,否则降级/轮换和报告会各说各话。
    // 真要收紧,应该改 strategy-loop 那一处(本包不动那个文件),两边一起变。
    const a = attributionTradeOf(thread({ filled_avg_price: null }), () => 'radar');
    expect(a).not.toBeNull();
    expect(a!.stop_distance_pct).toBeNull(); // 入场价算不出来的时候止损距离如实写 null
    expect(realizedRFromThreads.length).toBeGreaterThan(0); // 口径来源就在那个函数里
  });
});
