// 09-12 §5 减黑盒:evidence_plan / evidence_plan_hash 的落库/产出(buildContext 是纯函数,不起服务器)。
// 契约 §9.34 附:evidence_plan 只覆盖「要什么」,不覆盖「拿到没有」——同一套启用策略连续判断共用一个 hash。

import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { StrategyLibrary } from '../../src/demo/strategies.js';
import { buildContext, EVIDENCE_PLAN_VERSION, type EpisodeInputs } from '../../src/demo/context.js';
import { tfFeatures } from '../../src/demo/market.js';
import type { AccountView, Kline, MarketView } from '../../src/demo/types.js';

const NOW = 1_788_500_000_000;

function freshLib(): StrategyLibrary {
  const lib = new StrategyLibrary(openStateDb(':memory:').db);
  lib.seed();
  return lib;
}

/** 合成 K 线:与 strategies.test.ts 的 bars() 同型,自成一份避免跨测试文件依赖。 */
function bars(count: number, price: (i: number) => number, t0 = NOW - count * 900_000): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < count; i++) {
    const open = price(i);
    const close = price(i + 1);
    const openTime = t0 + i * 900_000;
    out.push({
      open_time: openTime,
      open: open.toFixed(2),
      high: (Math.max(open, close) + 1).toFixed(2),
      low: (Math.min(open, close) - 1).toFixed(2),
      close: close.toFixed(2),
      volume: '100',
      close_time: openTime + 899_999,
    });
  }
  return out;
}

const MARKET: MarketView = { symbol: 'BTCUSDT', last: '60000', mark: '60000', funding_rate: '0.0006', next_funding_at: NOW + 3_600_000, open_interest: '1000', as_of: NOW, klines_tf: '15m' };
const ACCOUNT: AccountView = { backend: 'paper', equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: NOW };

/** 最小 EpisodeInputs:15m 给够(scanChecklist 需要),1h 给 40 根(够算 rsi),4h 故意不给(测 included=false)。 */
function makeInputs(strategies: EpisodeInputs['strategies']): EpisodeInputs {
  const k15 = bars(60, (i) => 60000 + 40 * Math.sin((i / 20) * Math.PI * 2));
  const k1h = bars(40, (i) => 60000 + i * 3);
  return {
    now: NOW,
    symbol: 'BTCUSDT',
    trigger: { kind: 'breakout', detail: '测试触发' },
    mode: 'scan',
    thread: null,
    open_threads: [],
    account: ACCOUNT,
    market: MARKET,
    features: [tfFeatures('15m', k15), tfFeatures('1h', k1h)],
    oi_change_1h_pct: -2.4,
    ticker24h: { priceChangePercent: '1.0', highPrice: '61000', lowPrice: '59000', quoteVolume: '1000000' },
    market_state: null,
    playbook_text: '用户自己写的补充说明。',
    last_judgment_summary: null,
    halted: false,
    strategies: strategies ?? [],
    klines: { '15m': k15, '1h': k1h },
  };
}

describe('evidence_plan (context.ts buildContext, 09-12 §5)', () => {
  it('always carries a version and a hash that matches its own content', () => {
    const built = buildContext(makeInputs([]));
    expect(built.evidence_plan.version).toBe('ep-v2');
    expect(EVIDENCE_PLAN_VERSION).toBe('ep-v2');
    expect(built.evidence_plan_hash).toBe(built.evidence_plan.hash);
    expect(built.evidence_plan_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requested = union of the active strategies’ custom evidence, tagged with required_by', () => {
    const lib = freshLib();
    const base = lib.head('breakout_retest')!;
    const { spec: custom, error } = lib.createVersion(base.id, {
      evidence: { indicators: [{ id: 'rsi', tf: '1h' }, { id: 'macd', tf: '4h' }], events: [] },
    });
    expect(error).toBeNull();

    const built = buildContext(makeInputs([custom!]));

    expect(built.evidence_plan.requested.indicators).toEqual(
      expect.arrayContaining([
        { id: 'rsi', tf: '1h', required_by: [custom!.id] },
        { id: 'macd', tf: '4h', required_by: [custom!.id] },
      ]),
    );

    // 1h 给了 40 根 K 线,rsi 应该装上,ref 形如 E<n>。
    const rsiItem = built.evidence_plan.items.find((it) => it.kind === 'indicator' && it.key === 'rsi@1h#')!;
    expect(rsiItem).toBeDefined();
    expect(rsiItem.included).toBe(true);
    expect(rsiItem.ref).toMatch(/^E\d+$/);
    expect(rsiItem.required_by).toEqual([custom!.id]);

    // 4h 没给 K 线,macd 应该「要了没装上」,note 里要说明是 K 线不够。
    const macdItem = built.evidence_plan.items.find((it) => it.kind === 'indicator' && it.key === 'macd@4h#')!;
    expect(macdItem).toBeDefined();
    expect(macdItem.included).toBe(false);
    expect(macdItem.ref).toBeNull();
    expect(macdItem.note).toContain('K 线');
  });

  it('counts.included_indicators matches the number of included indicator items', () => {
    const lib = freshLib();
    const base = lib.head('breakout_retest')!;
    const { spec: custom } = lib.createVersion(base.id, {
      evidence: { indicators: [{ id: 'rsi', tf: '1h' }, { id: 'macd', tf: '4h' }], events: [] },
    });
    const built = buildContext(makeInputs([custom!]));
    const includedIndicatorItems = built.evidence_plan.items.filter((it) => it.kind === 'indicator' && it.included);
    expect(built.evidence_plan.counts.included_indicators).toBe(includedIndicatorItems.length);
    expect(built.evidence_plan.counts.included_indicators).toBe(1); // 只有 rsi@1h 装上了
  });

  it('the same strategy set produces the same hash across two buildContext calls; a bigger evidence set changes it', () => {
    const lib = freshLib();
    const base = lib.head('breakout_retest')!;
    const { spec: custom } = lib.createVersion(base.id, {
      evidence: { indicators: [{ id: 'rsi', tf: '1h' }, { id: 'macd', tf: '4h' }], events: [] },
    });

    const first = buildContext(makeInputs([custom!]));
    const second = buildContext(makeInputs([custom!]));
    expect(second.evidence_plan_hash).toBe(first.evidence_plan_hash);

    // 换一套证据(多加一个指标)→ 换了「要什么」→ hash 必须变。
    const { spec: custom2, error } = lib.createVersion(custom!.id, {
      evidence: { indicators: [...custom!.evidence!.indicators, { id: 'ema20', tf: '1h' }], events: [] },
    });
    expect(error).toBeNull();
    const third = buildContext(makeInputs([custom2!]));
    expect(third.evidence_plan_hash).not.toBe(first.evidence_plan_hash);
  });
});
