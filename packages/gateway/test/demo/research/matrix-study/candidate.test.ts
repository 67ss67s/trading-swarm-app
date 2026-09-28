// 批量验证 v2 全链路:只因样本不足没过的格子 → 候补;结论写「候补 N 组」;存为候补策略(权限、标记、幂等、预检);
// 留出段在没有 finalist 时从不取数。合成优势执行器,零网络、零模型。
import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { MatrixStudyService, candidateKey } from '../../../../src/demo/research/matrix-study/service.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import { TO_MS, baseSpec, edgeExecutor, loader } from './fixtures.js';

const NOW = TO_MS + 86400000;
function svcOf(edge = 0.006) {
  const db = openStateDb(':memory:').db, L = loader(), adopted: unknown[] = [];
  const svc = new MatrixStudyService({ db, now: () => NOW, loader: L, executorFor: edgeExecutor(edge), onAdopted: (_r, a) => adopted.push(a) });
  return { db, svc, L, adopted };
}
// 笔数门槛调到够不着:除了样本数(和显著性)以外全过 → 只能是候补
const sampleStarved = (o: Record<string, unknown> = {}) => baseSpec({ protocol: { block_days: 2, bootstrap_replicates: 299, min_trades: 100000 }, iterate: { top_k: 2, generations: 0, candidates_per_generation: 1, patience: 1 }, ...o });

describe('批量验证 v2:候补 · 可纸面观察', () => {
  it('只差样本数 → 候补;结论 kind 不变但写候补 N 组;留出段没被取数', async () => {
    const { svc, L } = svcOf();
    const row = svc.create({ spec: sampleStarved(), idempotency_key: 'c1' });
    await svc.idle();
    const out = svc.store.require(row.id);
    expect(out.status, out.state.error ?? '').toBe('completed');
    expect(out.state.finalists).toHaveLength(0);
    expect(out.state.conclusion!.kind).toBe('no_candidate');
    expect(out.state.conclusion!.paper_candidates).toBeGreaterThan(0);
    expect(out.state.conclusion!.text).toContain('值得先用模拟盘看看');
    const v = svc.get(row.id) as any;
    const cand = v.cells.filter((c: any) => c.result?.tier === 'paper_candidate');
    expect(cand.length).toBe(out.state.conclusion!.paper_candidates);
    const r = cand[0].result;
    expect(r.scorecard.segments).toEqual(['train', 'selection']);
    expect(['excellent', 'good', 'fair']).toContain(r.scorecard.score.label);
    expect(r.scorecard.luck.program_trials).toBeGreaterThan(0);
    expect(r.tier_reasons.join(';')).toMatch(/平仓 \d+ 笔/);
    expect(v.conclusion.paper_candidate_trial_ids).toContain(r.tier_trial_id);
    // 没有 finalist → 留出从没打开:全部取数都截止到选择段末
    const g = out.manifest.segments['4h']!;
    expect(L.calls.every((c) => c.to_ms <= g.selection.to_ms)).toBe(true);
    expect(svc.store.release(row.id)).toBeNull();
  }, 180_000);

  it('亏钱的组合样本也不足 → 未通过,不是候补', async () => {
    const { svc } = svcOf(-0.01);
    const row = svc.create({ spec: sampleStarved(), idempotency_key: 'c2' });
    await svc.idle();
    const v = svc.get(row.id) as any;
    expect(v.cells.every((c: any) => c.result?.tier !== 'paper_candidate')).toBe(true);
    expect(v.conclusion.paper_candidates).toBe(0);
    expect(v.conclusion.text).toContain('没有找到通过门槛的策略');
  }, 180_000);

  it('存为候补策略:带「未经最终验收」标记、adoption 键 candidate:、不自动运行、幂等;不合格 / 不存在的试验拒绝', async () => {
    const { db, svc, adopted } = svcOf();
    // ema_cross 不设止损会被运行器预检拦(no_stop):存候补用带 ATR 硬止损的 breakout 族
    const row = svc.create({ spec: sampleStarved({ families: ['breakout'] }), idempotency_key: 'c3' });
    await svc.idle();
    const v = svc.get(row.id) as any, tid = v.cells.find((c: any) => c.result?.tier === 'paper_candidate').result.tier_trial_id as string;
    // 预检照做:有 blocker 整笔回滚,不落 adoption
    const blocked = new MatrixStudyService({ db, now: () => NOW, preflight: () => ({ deployable: false, blockers: [{ code: 'x', message: '测试拦截' }], warnings: [] }) });
    expect(() => blocked.adoptCandidate(row.id, tid)).toThrow(/adopt_preflight_blocked:x\(测试拦截\)/);
    expect(svc.store.adoption(row.id, candidateKey(tid))).toBeNull();
    const r = svc.adoptCandidate(row.id, tid);
    expect(r).toMatchObject({ kind: 'paper_candidate', final_validation: false, trial_id: tid, tier: 'paper_candidate' });
    expect(r.next.link).toBe(`#my-strategies?id=${encodeURIComponent(r.strategy_id)}`);
    expect(r.preflight.deployable).toBe(true);
    const st = new StrategyStore(db).require(r.strategy_id);
    expect(st.description.startsWith(`[批量验证候补 ${row.id} · 未经最终验收 · `)).toBe(true);
    expect(st.description).toMatch(/· breakout\/long\/code ·/);
    expect(st.name).toContain('候补');
    expect(svc.store.adoption(row.id, candidateKey(tid))).toEqual({ strategy_id: r.strategy_id, version: r.version });
    // 不自动启动运行:没有策略运行记录
    const runs = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='strategy_runs'").get() as { n: number };
    if (runs.n) expect((db.prepare('SELECT COUNT(*) n FROM strategy_runs').get() as { n: number }).n).toBe(0);
    // handoff 带 final_validation=false
    expect(svc.store.handoffs(row.id).find((h) => h.key.endsWith(`adopt:candidate:${tid}`))?.payload).toMatchObject({ kind: 'paper_candidate', final_validation: false, trial_id: tid });
    // 幂等
    expect(svc.adoptCandidate(row.id, tid).strategy_id).toBe(r.strategy_id);
    expect(adopted).toHaveLength(1);
    // 视图里能看到候补 adoption
    expect((svc.get(row.id) as any).candidate_adoptions).toEqual([{ trial_id: tid, adopted: { strategy_id: r.strategy_id, version: r.version } }]);
    expect(() => svc.adoptCandidate(row.id, 'mt_nope')).toThrow('trial_not_found');
  }, 180_000);

  it('未通过档的试验不能存候补;研究没完成不能存', async () => {
    const { svc } = svcOf(-0.01);
    const row = svc.create({ spec: sampleStarved(), idempotency_key: 'c4' });
    await svc.idle();
    const v = svc.get(row.id) as any, t = v.cells.find((c: any) => c.result?.tier_trial_id).result.tier_trial_id;
    expect(() => svc.adoptCandidate(row.id, t)).toThrow(/candidate_not_allowed/);
    const { svc: s2 } = svcOf();
    const r2 = s2.create({ spec: sampleStarved(), idempotency_key: 'c5' });
    expect(() => s2.adoptCandidate(r2.id, 'x')).toThrow(/matrix_study_conflict/);
    await s2.idle();
  }, 180_000);
});
