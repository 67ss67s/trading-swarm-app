/**
 * 策略自动轮换 allocator(契约 §9.35)。决策是**纯函数**,所以这里全部直接喂 spec,不开库。
 *
 * 每条用例对着契约里的一条规则:候选门、排序、每族 1 条、相关票去重、最短驻留、冷却、容量、回滚。
 */
import { describe, expect, it } from 'vitest';
import {
  allocatorDecide,
  ALLOCATOR_COOLDOWN_DAYS,
  ALLOCATOR_MIN_TENURE_DAYS,
  correlationKey,
  enteredAtFrom,
  expectancyFor,
  removedAtFrom,
  runAllocator,
  type AllocatorInputs,
} from '../../src/demo/strategy-allocator.js';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import type { StrategyEvent } from '../../src/demo/strategy-loop.js';
import type { StrategyFamily, StrategySpec, StrategyStatus } from '../../src/demo/strategies.js';

const DAY = 24 * 3_600_000;
const NOW = 1_760_000_000_000;

function spec(id: string, opts: { family?: StrategyFamily; status?: StrategyStatus; expectancy?: number | null; effective_n?: number; lab_at?: number; indicators?: { id: string; tf: string; params?: Record<string, number> }[] } = {}): StrategySpec {
  return {
    id,
    version: 1,
    content_hash: `h-${id}`,
    name: id,
    family: opts.family ?? 'trend_continuation',
    horizon: 'intraday',
    status: opts.status ?? 'paper',
    trigger: { kinds: ['breakout'], min_timeframe: '15m', cooldown_bars: 1 },
    checklist: { required: [], optional: [], min_bars: 60 },
    rules: { entry: [], invalidation: [], exit: [], sizing: [] },
    params: {},
    evidence: { indicators: opts.indicators ?? [{ id: 'rsi', tf: '1h' }], events: [], info_topics: [] },
    eval_stats: { backtests: 0, trades: 0, win_rate: null, expectancy_r: null, total_r: 0, last_run_at: null },
    // 09-12:allocator 只认净值形状(`lab.net.expectancy_r` + `effective_n`),毛的 expectancy_r 只留着当对照。
    lab_stats: opts.expectancy === undefined ? null : { run_id: 'r', at: opts.lab_at ?? NOW, symbols: 5, setups: 50, n: 60, effective_n: opts.effective_n ?? 60, win_rate: 0.5, expectancy_r: opts.expectancy, net: { expectancy_r: opts.expectancy, total_r: 0 }, total_r: 0, note: '' },
    created_at: NOW - 30 * DAY,
    parent_version: null,
  } as unknown as StrategySpec;
}

function inputs(over: Partial<AllocatorInputs> & Pick<AllocatorInputs, 'specs'>): AllocatorInputs {
  return {
    now: NOW,
    mode: 'auto',
    active: [],
    max: 4,
    regime: null,
    realized_r: () => [],
    entered_at: () => NOW - 30 * DAY, // 默认早就进池了(驻留不挡)
    removed_at: () => null,
    ...over,
  };
}

describe('allocatorDecide(§9.35)', () => {
  it('候选门:没到 paper 的进不了票池,理由写 status', () => {
    const { decision, candidates } = allocatorDecide(inputs({ specs: [spec('a', { status: 'shadow', expectancy: 1 })] }));
    expect(decision.to).toEqual([]);
    expect(candidates[0]!.blocked_by).toBe('status');
    expect(candidates[0]!.reason).toContain('shadow');
  });

  it('候选门:退化的策略(连亏 10 笔)不进票池,而且在池的会被换下去', () => {
    const losses = Array.from({ length: 10 }, () => -1);
    const { decision, candidates } = allocatorDecide(
      inputs({ specs: [spec('a', { expectancy: 1 })], active: ['a'], realized_r: () => losses }),
    );
    expect(decision.to).toEqual([]);
    expect(decision.remove.map((x) => x.id)).toEqual(['a']);
    expect(candidates[0]!.blocked_by).toBe('health');
    expect(candidates[0]!.healthy).toBe(false);
  });

  it('退化换下去**不受**最短驻留保护(刚进池也照样出池)', () => {
    const losses = Array.from({ length: 10 }, () => -1);
    const { decision } = allocatorDecide(
      inputs({ specs: [spec('a', { expectancy: 1 })], active: ['a'], entered_at: () => NOW - 60_000, realized_r: () => losses }),
    );
    expect(decision.remove.map((x) => x.id)).toEqual(['a']);
  });

  it('排序:按期望降序;期望为 null 的排最后', () => {
    const { decision } = allocatorDecide(
      inputs({
        max: 2,
        specs: [
          spec('low', { family: 'trend_continuation', expectancy: 0.1, indicators: [{ id: 'rsi', tf: '1h' }] }),
          spec('high', { family: 'mtf', expectancy: 0.9, indicators: [{ id: 'macd', tf: '4h' }] }),
          spec('none', { family: 'volatility', expectancy: null, indicators: [{ id: 'adx', tf: '1h' }] }),
        ],
      }),
    );
    expect(decision.to).toEqual(['high', 'low']);
  });

  it('每族最多 1 条', () => {
    const { decision, candidates } = allocatorDecide(
      inputs({
        specs: [
          spec('t1', { family: 'trend_continuation', expectancy: 0.9, indicators: [{ id: 'rsi', tf: '1h' }] }),
          spec('t2', { family: 'trend_continuation', expectancy: 0.8, indicators: [{ id: 'macd', tf: '4h' }] }),
        ],
      }),
    );
    expect(decision.to).toEqual(['t1']);
    expect(candidates.find((c) => c.id === 't2')!.blocked_by).toBe('family_taken');
  });

  it('相关票去重:看同一批证据 + 同一批触发器的两条,只留期望高的', () => {
    const same = [{ id: 'rsi', tf: '1h' }];
    const a = spec('a', { family: 'mtf', expectancy: 0.9, indicators: same });
    const b = spec('b', { family: 'volatility', expectancy: 0.5, indicators: same });
    expect(correlationKey(a)).toBe(correlationKey(b)); // 不同族,但证据/触发完全一样
    const { decision, candidates } = allocatorDecide(inputs({ specs: [a, b] }));
    expect(decision.to).toEqual(['a']);
    expect(candidates.find((c) => c.id === 'b')!.blocked_by).toBe('correlated');
  });

  it('相关票去重认 params:同一个 RSI 不同参数不是相关票', () => {
    const a = spec('a', { family: 'mtf', expectancy: 0.9, indicators: [{ id: 'rsi', tf: '1h', params: { length: 14 } }] });
    const b = spec('b', { family: 'volatility', expectancy: 0.5, indicators: [{ id: 'rsi', tf: '1h', params: { length: 7 } }] });
    expect(correlationKey(a)).not.toBe(correlationKey(b));
    const { decision } = allocatorDecide(inputs({ specs: [a, b] }));
    expect(decision.to).toEqual(['a', 'b']);
  });

  it(`最短驻留 ${ALLOCATOR_MIN_TENURE_DAYS} 天:刚进池的健康策略不许被更好的换下去`, () => {
    const { decision, candidates } = allocatorDecide(
      inputs({
        max: 1,
        active: ['incumbent'],
        entered_at: (id) => (id === 'incumbent' ? NOW - 1 * DAY : null),
        specs: [spec('incumbent', { family: 'mtf', expectancy: 0.1, indicators: [{ id: 'rsi', tf: '1h' }] }), spec('better', { family: 'volatility', expectancy: 2, indicators: [{ id: 'macd', tf: '4h' }] })],
      }),
    );
    expect(decision.to).toEqual(['incumbent']);
    expect(decision.changed).toBe(false);
    expect(candidates.find((c) => c.id === 'incumbent')!.reason).toContain('最短驻留');
    expect(candidates.find((c) => c.id === 'better')!.blocked_by).toBe('rank');
  });

  it('驻留满了就换得动', () => {
    const { decision } = allocatorDecide(
      inputs({
        max: 1,
        active: ['incumbent'],
        entered_at: () => NOW - (ALLOCATOR_MIN_TENURE_DAYS + 1) * DAY,
        specs: [spec('incumbent', { family: 'mtf', expectancy: 0.1, indicators: [{ id: 'rsi', tf: '1h' }] }), spec('better', { family: 'volatility', expectancy: 2, indicators: [{ id: 'macd', tf: '4h' }] })],
      }),
    );
    expect(decision.to).toEqual(['better']);
    expect(decision.add.map((x) => x.id)).toEqual(['better']);
    expect(decision.remove.map((x) => x.id)).toEqual(['incumbent']);
  });

  it(`冷却 ${ALLOCATOR_COOLDOWN_DAYS} 天:刚被换下去的不许马上回来`, () => {
    const { decision, candidates } = allocatorDecide(
      inputs({ specs: [spec('a', { expectancy: 2 })], removed_at: () => NOW - 3_600_000 }),
    );
    expect(decision.to).toEqual([]);
    expect(candidates[0]!.blocked_by).toBe('cooldown');
    expect(candidates[0]!.reason).toContain('冷却');
  });

  it('冷却过了就能回来', () => {
    const { decision } = allocatorDecide(
      inputs({ specs: [spec('a', { expectancy: 2 })], removed_at: () => NOW - (ALLOCATOR_COOLDOWN_DAYS + 1) * DAY }),
    );
    expect(decision.to).toEqual(['a']);
  });

  it('容量是硬的:驻留强留的条数超过 max 时,期望最低的仍被挤出', () => {
    const { decision } = allocatorDecide(
      inputs({
        max: 1,
        active: ['x', 'y'],
        entered_at: () => NOW - 60_000, // 两条都刚进池
        specs: [spec('x', { family: 'mtf', expectancy: 0.9, indicators: [{ id: 'rsi', tf: '1h' }] }), spec('y', { family: 'volatility', expectancy: 0.1, indicators: [{ id: 'macd', tf: '4h' }] })],
      }),
    );
    expect(decision.to).toEqual(['x']);
    expect(decision.remove.map((x) => x.id)).toEqual(['y']);
  });

  it('票池没变时 changed=false,理由说得出为什么不变', () => {
    const { decision } = allocatorDecide(inputs({ active: ['a'], specs: [spec('a', { expectancy: 0.5 })] }));
    expect(decision.changed).toBe(false);
    expect(decision.to).toEqual(['a']);
    expect(decision.reason).toContain('票池不变');
  });

  it('库里已经没有的策略照样会被移出,并且理由说得出来', () => {
    const { decision } = allocatorDecide(inputs({ active: ['ghost'], specs: [] }));
    expect(decision.remove).toEqual([{ id: 'ghost', reason: '库里已经没有这条策略' }]);
  });
});

describe('expectancyFor:只认净值,regime 枚举与 daily regime 对齐(09-12 回归)', () => {
  const withLab = (extra: Record<string, unknown>, at = NOW): StrategySpec => {
    const s = spec('a', { expectancy: 0.4 });
    const lab = s.lab_stats as unknown as Record<string, unknown>;
    lab['at'] = at;
    delete lab['net'];
    delete lab['effective_n'];
    Object.assign(lab, extra);
    return s;
  };

  it('毛值那一档已经删掉:只有 lab_stats.expectancy_r 时是 none(不拿毛值当净值排序)', () => {
    const r = expectancyFor(withLab({}), null, NOW);
    expect(r.source).toBe('none');
    expect(r.value).toBeNull();
    expect(r.insufficient).toBe(true);
  });

  it('net 读的是新形状 lab.net.expectancy_r,样本数用 effective_n', () => {
    const r = expectancyFor(withLab({ net: { expectancy_r: 0.2, total_r: 12 }, effective_n: 44 }), null, NOW);
    expect(r).toMatchObject({ value: 0.2, source: 'net', n: 44, insufficient: false, stale: false });
  });

  it('regime 桶键是 trend/range/high_vol;bull/bear → trend,volatile → high_vol', () => {
    const s = withLab({ net: { expectancy_r: 0.2 }, effective_n: 44, regime: { trend: { n: 31, net_expectancy: -0.5 }, high_vol: { n: 33, net_expectancy: 0.6 } } });
    expect(expectancyFor(s, 'bull', NOW)).toMatchObject({ value: -0.5, source: 'regime_net', n: 31 });
    expect(expectancyFor(s, 'bear', NOW)).toMatchObject({ value: -0.5, source: 'regime_net' });
    expect(expectancyFor(s, 'volatile', NOW)).toMatchObject({ value: 0.6, source: 'regime_net', n: 33 });
    expect(expectancyFor(s, 'range', NOW).source).toBe('net'); // 没有这个桶才回退到全样本
  });

  it('Lab 成绩超过 30 天没更新 = stale;有效样本不足 30 = insufficient', () => {
    const stale = expectancyFor(withLab({ net: { expectancy_r: 0.2 }, effective_n: 44 }, NOW - 31 * DAY), null, NOW);
    expect(stale.stale).toBe(true);
    const thin = expectancyFor(withLab({ net: { expectancy_r: 0.2 }, effective_n: 12 }), null, NOW);
    expect(thin.insufficient).toBe(true);
  });

  it('一个数都没有 → none', () => {
    expect(expectancyFor(spec('a'), null, NOW)).toMatchObject({ value: null, source: 'none', n: null });
  });
});

describe('证据门只挡新进池(09-12 复审缺口 2)', () => {
  it('没有净期望的新策略进不来,但在池的同类不因此被踢出去', () => {
    const inPool = spec('old', { expectancy: 0.4 });
    const fresh = spec('new', { family: 'mean_reversion' }); // 没有任何净期望数据
    const { decision, candidates } = allocatorDecide(inputs({ active: ['old'], specs: [inPool, fresh] }));
    expect(decision.to).toEqual(['old']);
    expect(candidates.find((c) => c.id === 'new')!.blocked_by).toBe('evidence');
  });
});

describe('台账 → 驻留 / 冷却', () => {
  const ev = (kind: StrategyEvent['kind'], at: number, who: StrategyEvent['who'] = 'code'): StrategyEvent =>
    ({ id: at, strategy_id: 'a', version: 1, at, who, kind, from_status: null, to_status: null, reason: '', evidence: {} }) as StrategyEvent;

  it('enteredAtFrom = 最后一条 activated(后面没有 deactivated)', () => {
    expect(enteredAtFrom([ev('activated', 100), ev('deactivated', 200), ev('activated', 300)])).toBe(300);
    expect(enteredAtFrom([ev('activated', 100), ev('deactivated', 200)])).toBeNull();
    expect(enteredAtFrom([])).toBeNull();
  });

  it('removedAtFrom 只认 allocator(who=code)的停用:人工停用不触发冷却', () => {
    expect(removedAtFrom([ev('deactivated', 200, 'code')])).toBe(200);
    expect(removedAtFrom([ev('deactivated', 200, 'human')])).toBeNull();
    expect(removedAtFrom([ev('deactivated', 200, 'code'), ev('activated', 300)])).toBeNull();
  });
});

// ---------------------------------------------------------------- 库接线(09-12 复审缺口 1/3)

describe('runAllocator 读生效版本 × backend,不读 head raw status', () => {
  it('head=v2 backtest / 生效=v1 paper 时,preview 不把 [breakout_retest] 清空', () => {
    const state = openStateDb(':memory:');
    try {
      const store = new DemoStore(state);
      store.strategies.seed(NOW - 60 * DAY);
      // head 变成一个还在回测的 v2(复审反例:allocator 只看 head 就会判「状态 backtest,不进票池」)
      const v2 = store.strategies.createVersion('breakout_retest', { name: '突破回踩 v2' }, { now: NOW });
      expect(v2.error).toBeNull();
      store.strategies.promote('breakout_retest', 'backtest');
      expect(store.strategies.head('breakout_retest')!.status).toBe('backtest');

      const r = runAllocator(store, { now: NOW, mode: 'manual', backend: 'paper', active: ['breakout_retest'], max: 4, preview: true });
      expect(r.decision.to).toEqual(['breakout_retest']);
      expect(r.decision.remove).toEqual([]);
      const c = r.candidates.find((x) => x.id === 'breakout_retest')!;
      expect(c.status).toBe('paper');
      expect(c.version).toBe(1);
    } finally {
      state.close();
    }
  });

  it('健康数据按生效版本 + backend 取,默认线程不会被判据排空', () => {
    const state = openStateDb(':memory:');
    try {
      const store = new DemoStore(state);
      store.strategies.seed(NOW - 60 * DAY);
      const seen: [string, number][] = [];
      runAllocator(store, {
        now: NOW,
        mode: 'manual',
        backend: 'paper',
        active: ['breakout_retest'],
        max: 4,
        preview: true,
        realizedR: (id, version) => {
          seen.push([id, version]);
          return [];
        },
      });
      expect(seen).toContainEqual(['breakout_retest', 1]);
    } finally {
      state.close();
    }
  });
});
