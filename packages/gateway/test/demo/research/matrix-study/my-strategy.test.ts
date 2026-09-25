// §9.53 B 自选策略行:「我的策略」某版本 IR 作矩阵的行(资产 × 周期 × 两臂),adopt 出来是该策略的新版本。零网络、零模型(判断用桩)。
import { describe, expect, it } from 'vitest';
import type { StrategyIR } from '@trading-swarm/contracts';
import { openStateDb } from '../../../../src/state-db.js';
import { irVariants } from '../../../../src/demo/research/batch/families.js';
import { MatrixStudyService } from '../../../../src/demo/research/matrix-study/service.js';
import { normalizeSpec } from '../../../../src/demo/research/matrix-study/spec.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import { StrategyService } from '../../../../src/demo/research/strategies/service.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import type { ResearchService } from '../../../../src/demo/research/service.js';
import { PROFILE, TO_MS, baseSpec, edgeExecutor, loader, stubProvider } from './fixtures.js';

const NOW = TO_MS + 86400000;
const emaIR = (): StrategyIR => irVariants('spot', 'long', '4h').find((v) => v.family === 'ema_cross')!.ir;
/** 带 ATR 硬止损的突破族(运行器预检能过,adopt 用) */
const breakoutIR = (): StrategyIR => irVariants('spot', 'long', '4h').find((v) => v.family === 'breakout')!.ir;

/** realEngine=true 走真实订单核(判断臂要它才会产生候选调用) */
function setup(o: Partial<ConstructorParameters<typeof MatrixStudyService>[0]> = {}, realEngine = false) {
  const db = openStateDb(':memory:').db;
  const strategies = new StrategyService(new StrategyStore(db), new ResearchStore(db), null as unknown as ResearchService);
  const svc = new MatrixStudyService({ db, now: () => NOW, loader: loader(), ...(realEngine ? {} : { executorFor: edgeExecutor() }), ...o });
  const mk = (ir: StrategyIR, timeframe = '1h', name = '我的均线') => strategies.create({ name, symbol: 'BTCUSDT', timeframe, strategy_ir: ir });
  return { db, svc, strategies, mk };
}
/** 只用我的策略的规格(不带内置族) */
const mySpec = (id: string, o: Record<string, unknown> = {}) => { const { families: _f, ...rest } = baseSpec(o); void _f; return { ...rest, strategies: [{ strategy_id: id }] }; };

describe('matrix study:我的策略作行', () => {
  it('spec:strategies 解析到当前版本;只给 strategies 时不铺内置族;两者都空 / 找不到策略报错', () => {
    const { svc, mk, strategies } = setup();
    const s = mk(emaIR());
    strategies.addVersion(s.id, { strategy_ir: { ...emaIR(), description: 'v2' }, note: 'v2' });
    const { spec } = svc.estimate({ spec: mySpec(s.id) });
    expect(spec.strategies).toEqual([{ strategy_id: s.id, version: 2 }]);
    expect(spec.families).toEqual([]);
    expect(svc.estimate({ spec: { ...mySpec(s.id), strategies: [{ strategy_id: s.id, version: 1 }], families: ['breakout'] } }).spec).toMatchObject({ strategies: [{ strategy_id: s.id, version: 1 }], families: ['breakout'] });
    expect(() => svc.estimate({ spec: { ...mySpec('nope') } })).toThrow('strategy_not_found:nope');
    expect(() => svc.estimate({ spec: { ...mySpec(s.id), strategies: [{ strategy_id: s.id, version: 9 }] } })).toThrow('strategy_not_found');
    expect(() => normalizeSpec({ ...baseSpec(), families: [] }, { now: NOW })).toThrow('families_or_strategies_required');
    expect(() => normalizeSpec({ ...baseSpec(), strategies: [{ strategy_id: 'x', extra: 1 }] }, { now: NOW })).toThrow('strategies_unknown_fields');
  });

  it('manifest:family=my:<id>@v<n>;周期按格子覆盖并写 reason;方向不符标 not_applicable;两臂 judge 处理', () => {
    const { svc, mk } = setup({ modelProfile: () => PROFILE });
    const s = mk(emaIR(), '1h');
    const est = svc.estimate({ spec: mySpec(s.id, { market: 'perp', sides: ['long', 'short'], arms: ['code', 'code_judge'] }) });
    const fam = `my:${s.id}@v1`;
    expect(est.cells.every((c) => c.id.includes(`|${fam}|`))).toBe(true);
    const long = est.cells.filter((c) => c.id.includes('|long|'));
    expect(long.every((c) => c.applicability === 'applicable' && c.variants === 1)).toBe(true);
    expect(long.every((c) => /timeframe_override:1h→4h/.test(c.reason ?? ''))).toBe(true);
    expect(est.cells.filter((c) => c.id.includes('|short|')).every((c) => c.applicability === 'not_applicable' && c.reason === 'my_strategy_direction:long')).toBe(true);
    // 冻结后的 manifest:code 臂无 judge,code_judge 臂附研究 spec 的 judge
    const row = svc.create({ spec: mySpec(s.id, { market: 'perp', sides: ['long'], arms: ['code', 'code_judge'], auto_finalize: false, iterate: { generations: 0 } }), idempotency_key: 'm1' });
    svc.cancel(row.id);
    const cells = row.manifest.cells, code = cells.find((c) => c.arm === 'code')!, cj = cells.find((c) => c.arm === 'code_judge')!;
    expect(code.family).toBe(fam);
    expect(code.variants[0]!.ir.judge).toBeUndefined();
    expect(cj.variants[0]!.ir.judge).toEqual(row.manifest.spec.judge);
    expect(row.manifest.my_strategies).toMatchObject([{ strategy_id: s.id, version: 1, name: '我的均线', timeframe: '1h' }]);
    expect(svc.get(row.id).my_strategies).toEqual([{ strategy_id: s.id, version: 1, name: '我的均线', symbol: 'BTCUSDT', timeframe: '1h' }]);
  });

  it('IR 自带 judge:code_judge 臂用它自己的问题与规则(模型配置钉到本次冻结的 profile);code 臂去掉', () => {
    const { svc, mk } = setup({ modelProfile: () => PROFILE });
    const base = emaIR(), own = { ...base, version: 2 as const, judge: { ...normalizeSpec({ ...baseSpec(), arms: ['code_judge'] }, { now: NOW, model_profile: PROFILE }).judge!, model_profile_ref: 'other_ref', timeout_ms: 7777 } };
    const s = mk(own as StrategyIR, '4h');
    const row = svc.create({ spec: mySpec(s.id, { arms: ['code', 'code_judge'], auto_finalize: false, iterate: { generations: 0 } }), idempotency_key: 'j1' });
    svc.cancel(row.id);
    const cj = row.manifest.cells.find((c) => c.arm === 'code_judge' && c.applicability === 'applicable')!;
    expect(cj.variants[0]!.ir.judge).toMatchObject({ timeout_ms: 7777, model_profile_ref: PROFILE.ref });
    expect(cj.reason).toMatch(/own_judge:model_profile_rebound/);
    expect(cj.reason).not.toMatch(/timeframe_override/);
    expect(row.manifest.cells.find((c) => c.arm === 'code')!.variants[0]!.ir.judge).toBeUndefined();
  });

  it('全链路:我的策略行照常迭代 / 封存 / 留出 / Holm;adopt 出来是同一策略的新版本(幂等),登记周期跟到这一版', async () => {
    const { svc, mk, strategies } = setup();
    const s = mk(breakoutIR(), '1h');
    const row = svc.create({ spec: mySpec(s.id), idempotency_key: 'full' });
    await svc.idle();
    const out = svc.store.require(row.id), st = out.state;
    expect(out.status, st.error ?? '').toBe('completed');
    expect(st.conclusion!.kind).toBe('passed');
    expect(st.conclusion!.text).toContain('「我的均线」v1');
    expect(st.ledger!.trial_count).toBeGreaterThanOrEqual(2); // 两个资产各一格 + 迭代子代都计入试验数
    const f = st.finalists.find((x) => x.passed)!;
    expect(f.family).toBe(`my:${s.id}@v1`);
    const a = svc.adopt(row.id, f.id);
    expect(a.strategy_id).toBe(s.id);
    expect(a.version).toBe(2);
    expect(svc.adopt(row.id, f.id)).toMatchObject({ strategy_id: s.id, version: 2 });
    const d = strategies.detail(s.id);
    expect(d.versions.map((v) => v.version).sort()).toEqual([1, 2]);
    expect(d.strategy.current_version).toBe(2);
    expect(d.strategy.timeframe).toBe('4h');
    expect(d.strategy.symbol).toBe(f.symbol);
    expect(strategies.store.list({}).length).toBe(1); // 没有新建策略
  });

  it('code_judge 臂(桩判断)也能跑完;判断调用计入预算', async () => {
    const provider = stubProvider();
    const { svc, mk } = setup({ modelProfile: () => PROFILE, judge: { provider } }, true);
    const s = mk(emaIR(), '4h');
    const row = svc.create({ spec: mySpec(s.id, { symbols: ['BTCUSDT'], arms: ['code_judge'], iterate: { generations: 0 } }), idempotency_key: 'cj' });
    await svc.idle();
    const out = svc.store.require(row.id);
    expect(['completed'], out.state.error ?? '').toContain(out.status);
    expect(provider.calls).toBeGreaterThan(0);
    expect(out.state.usage.judge_calls).toBeGreaterThan(0);
  });
});
