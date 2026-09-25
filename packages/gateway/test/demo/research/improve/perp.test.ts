// 改进环接永续(2026-09-23):冻结数据带资金费/标记价,候选按永续费率与资金费评估;路由接受 allow_explore 与 30 个资产
import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import { freezeData } from '../../../../src/demo/research/improve/data.js';
import { EvalEnv, runPool, scoreSegment } from '../../../../src/demo/research/improve/evaluate.js';
import { ImproveStore } from '../../../../src/demo/research/improve/store.js';
import { runImprovement } from '../../../../src/demo/research/improve/runner.js';
import { parseImproveRequest } from '../../../../src/demo/research/improve/routes.js';
import { hash } from '../../../../src/demo/research/primitives.js';
import { perpLoader, shortIR, data as perpData } from '../orders/perp-fixture.js';
import { specOf, LOOSE, emaIR } from './fixtures.js';

const DAY = 86400000, START = perpData['BTCUSDT']![0]!.open_time;
describe('改进环 × 永续', () => {
  it('冻结永续数据:带资金费;资金费正时空头收钱,2 倍费率更差', async () => {
    const db = openStateDb(':memory:'), store = new ResearchStore(db.db);
    const f = await freezeData(store, { universe: ['BTCUSDT', 'ETHUSDT'], timeframe: '1d', from_ms: START + 300 * DAY, to_ms: START + 1500 * DAY, market: 'perp' }, { loader: perpLoader({ rate: 0.001 }) });
    expect(f.data.market).toBe('perp');
    expect(f.data.assets.every((a) => a.perp && a.perp.funding.points.length > 0)).toBe(true);
    const env = new EvalEnv(f.data), ir = shortIR({ leverage: 1 }), key = hash(ir), w = f.data.segments.train;
    const r = await runPool(env, ir, key, w), s = await runPool(env, ir, key, w, { feeMultiple: 2 });
    expect(r.per_asset.every((p) => p.status === 'completed')).toBe(true);
    expect(r.trades.length).toBeGreaterThan(0);
    expect(s.samples.at(-1)!.equity).toBeLessThan(r.samples.at(-1)!.equity);
    // 同一 IR 不给资金费(rate=0)时,空头少收资金费 → 净值更低
    const f0 = await freezeData(store, { universe: ['BTCUSDT', 'ETHUSDT'], timeframe: '1d', from_ms: START + 300 * DAY, to_ms: START + 1500 * DAY, market: 'perp' }, { loader: perpLoader({ rate: 0 }) });
    const r0 = await runPool(new EvalEnv(f0.data), ir, key, w);
    expect(r0.samples.at(-1)!.equity).toBeLessThan(r.samples.at(-1)!.equity);
    expect(() => freezeData(store, { universe: ['BTCUSDT'], timeframe: '1d', from_ms: 0, to_ms: 1, market: 'perp', dataset_ids: { BTCUSDT: 'a'.repeat(64) } })).rejects.toThrow('NOT_SUPPORTED');
    db.close();
  }, 120000);
  it('永续 IR 能跑完一代改进环(不再报 spot_only)', async () => {
    const db = openStateDb(':memory:'), jobs = new ImproveStore(db.db);
    const job = jobs.createJob(specOf({ strategy_ir: shortIR({ leverage: 1 }), timeframe: '1d', universe: ['BTCUSDT', 'ETHUSDT'], from_ms: START + 300 * DAY, to_ms: START + 1500 * DAY, objective: LOOSE, budget: { ...specOf().budget, generations: 1, candidates_per_generation: 2 } }));
    const out = await runImprovement({ db: db.db, loader: perpLoader() }, job.id);
    expect(out.status, out.error ?? '').toBe('completed');
    expect((out.frozen as { market: string }).market).toBe('perp');
    db.close();
  }, 180000);
  it('路由:allow_explore 缺省 true、可关;资产池上限 30', () => {
    const db = openStateDb(':memory:'), st = new StrategyStore(db.db);
    expect(parseImproveRequest({ strategy_ir: emaIR() }, st).budget.allow_explore).toBe(true);
    expect(parseImproveRequest({ strategy_ir: emaIR(), budget: { allow_explore: false } }, st).budget.allow_explore).toBe(false);
    expect(() => parseImproveRequest({ strategy_ir: emaIR(), budget: { allow_explore: 'yes' } }, st)).toThrow('budget.allow_explore_invalid');
    const u = Array.from({ length: 20 }, (_, i) => `C${i}USDT`);
    expect(parseImproveRequest({ strategy_ir: emaIR(), universe: u }, st).universe).toHaveLength(20);
    expect(() => parseImproveRequest({ strategy_ir: emaIR(), universe: [...u, ...u] }, st)).toThrow('universe_invalid');
    db.close();
  });
});
describe('同敞口持有的方向', () => {
  it('只做空的 IR:同敞口持有取负号(同敞口做空持有)', async () => {
    const db = openStateDb(':memory:'), store = new ResearchStore(db.db);
    const f = await freezeData(store, { universe: ['BTCUSDT', 'ETHUSDT'], timeframe: '1d', from_ms: START + 300 * DAY, to_ms: START + 1500 * DAY, market: 'perp' }, { loader: perpLoader() });
    const env = new EvalEnv(f.data), ir = shortIR({ leverage: 1 }), w = f.data.segments.train;
    const s = scoreSegment('train', await runPool(env, ir, hash(ir), w), w);
    expect(s.exposure).toBeGreaterThan(0);
    expect(s.exposure_matched_hold!).toBeCloseTo(-s.hold_return! * s.exposure, 9);
    db.close();
  }, 120000);
});
