// Jev 两段式(judge_stage = candidates)+ 预算估算口径 + origin.batch。零网络、零费用(判断走桩)。
import { describe, expect, it } from 'vitest';
import type { StrategyIR } from '@trade-gate/contracts';
import { openStateDb } from '../../../../src/state-db.js';
import type { AssetExecutor } from '../../../../src/demo/research/backtest-report.js';
import { MatrixStudyService } from '../../../../src/demo/research/matrix-study/service.js';
import { buildManifest, cellJudgeCalls, estimate, protocolHashOf } from '../../../../src/demo/research/matrix-study/manifest.js';
import { normalizeSpec } from '../../../../src/demo/research/matrix-study/spec.js';
import { PROFILE, TO_MS, baseSpec, edgeExecutor, loader, stubProvider } from './fixtures.js';

const NOW = TO_MS + 86400000;
/** BTC 有优势(格子能过 / 接近),ETH 亏钱(格子不合格)——两段式只该补跑 BTC 的格子 */
const splitExecutor = (): ((ir: StrategyIR) => AssetExecutor) => { const good = edgeExecutor(0.006), bad = edgeExecutor(-0.01); return (ir) => async (x) => (x.symbol === 'BTCUSDT' ? good(ir)(x) : bad(ir)(x)); };
const spec2 = (o: Record<string, unknown> = {}) => baseSpec({ arms: ['code', 'code_judge'], model_profile: PROFILE, families: ['ema_cross', 'pullback'], iterate: { top_k: 1, generations: 0, candidates_per_generation: 1, patience: 1 }, ...o });

describe('Jev 两段式(candidates)', () => {
  it('只对候补 / 接近 / 通过的格子补跑 code_judge,K 上限生效;试验记账、结论与留出段语义不变', async () => {
    const db = openStateDb(':memory:').db, provider = stubProvider();
    const svc = new MatrixStudyService({ db, now: () => NOW, loader: loader(), executorFor: splitExecutor(), judge: { provider } });
    const row = svc.create({ spec: spec2({ judge_stage: 'candidates', judge_stage_max_cells: 1 }) });
    // manifest 冻结时就写明规则;规则进协议哈希
    expect(row.manifest.judge_stage).toMatchObject({ version: 'judge_stage_v1', mode: 'candidates', max_cells: 1, timing: 'after_code_search_before_seal' });
    expect(row.protocol_hash).not.toBe(protocolHashOf({ ...row.manifest.spec, judge_stage: 'all' }));
    expect(() => db.prepare("UPDATE research_matrix_studies SET manifest_json='{}' WHERE id=?").run(row.id)).toThrow();
    await svc.idle();
    const out = svc.store.require(row.id), st = out.state;
    expect(out.status, st.error ?? '').toBe('completed');
    // 入选:BTC 的两格合格,K=1 只补跑 1 格;ETH 不合格不补跑
    expect(st.judge_stage!.status).toBe('done');
    expect(st.judge_stage!.eligible).toBe(2);
    expect(st.judge_stage!.selected).toHaveLength(1);
    const pick = st.judge_stage!.selected[0]!;
    expect(pick.cell_id.startsWith('BTCUSDT|')).toBe(true);
    expect(pick.cell_id.endsWith('|code_judge')).toBe(true);
    const trials = svc.store.trials(row.id);
    const judgeTrials = trials.filter((t) => t.cell_id.endsWith('|code_judge'));
    // 只补跑入选格、与代表性 code 试验同 param 的冻结变体
    expect(new Set(judgeTrials.map((t) => t.cell_id))).toEqual(new Set([pick.cell_id]));
    const cell = out.manifest.cells.find((c) => c.id === pick.cell_id)!;
    expect(judgeTrials.map((t) => t.variant_id).sort()).toEqual(cell.variants.filter((v) => v.param === pick.param).map((v) => v.id).sort());
    expect(judgeTrials.every((t) => t.selection_visible_at !== null)).toBe(true);
    // 记账:补跑试验计入 trial_count / study_trial_count
    expect(st.ledger!.study_trial_count).toBe(trials.filter((t) => t.selection_visible_at !== null).length);
    expect(st.ledger!.study_trial_count).toBe(trials.filter((t) => t.cell_id.endsWith('|code')).length + judgeTrials.length);
    // 格子:没补跑的 code_judge 格记 not_candidate(ineligible,不进主因分布),补跑的记 rerun
    const cj = Object.values(st.cells).filter((c) => c.cell_id.endsWith('|code_judge'));
    expect(cj.filter((c) => c.judge_stage === 'rerun').map((c) => c.cell_id)).toEqual([pick.cell_id]);
    expect(cj.filter((c) => c.judge_stage === 'not_candidate').every((c) => c.verdict === 'ineligible' && c.cause === null)).toBe(true);
    expect(cj.filter((c) => c.judge_stage === 'not_candidate')).toHaveLength(3);
    // 结论只统计补跑过的格子并注明
    expect(st.conclusion!.text).toContain('只对候补测了 Jev');
    expect(st.conclusion!.judge_stage).toEqual({ mode: 'candidates', rerun_cells: 1, eligible: 2, skipped_cells: 3 });
    const view = svc.get(row.id) as { judge_stage: unknown; conclusion: { judge_stage?: unknown; tiers?: Record<string, number> } };
    expect(view.judge_stage).toMatchObject({ status: 'done', eligible: 2 });
    expect(view.conclusion.judge_stage).toMatchObject({ rerun_cells: 1 });
    // 留出段:补跑在封存之前;封存时的试验账本已含补跑;留出一次释放
    const sealed = svc.store.handoffs(row.id).find((h) => h.key.endsWith(':sealed'));
    if (sealed) expect((sealed.payload as { trial_count: number }).trial_count).toBe(st.ledger!.trial_count);
    const rel = db.prepare('SELECT COUNT(*) n FROM research_holdout_releases WHERE study_id=?').get(row.id) as { n: number };
    expect(rel.n).toBeLessThanOrEqual(1);
    expect(st.holdout_state === 'released' || st.finalists.length === 0).toBe(true);
    // 补跑试验只有开发视图评估(没有留出段的 dev 行)
    const stages = db.prepare(`SELECT DISTINCT e.segment AS stage FROM research_study_evaluations e JOIN research_study_trials t ON t.trial_id=e.trial_id WHERE t.study_id=? AND t.cell_id=?`).all(row.id, pick.cell_id) as { stage: string }[];
    expect(stages.map((x) => x.stage)).toEqual(['dev']);
  }, 300_000);

  it('all 模式(不传 judge_stage)行为不变:两臂全跑,没有两段式状态', async () => {
    const db = openStateDb(':memory:').db, provider = stubProvider();
    const svc = new MatrixStudyService({ db, now: () => NOW, loader: loader(), executorFor: splitExecutor(), judge: { provider } });
    const row = svc.create({ spec: spec2() });
    expect(row.manifest.spec.judge_stage).toBe('all');
    expect(row.manifest.judge_stage).toBeUndefined();
    expect(row.protocol_hash).toBe(protocolHashOf(row.manifest.spec));
    await svc.idle();
    const st = svc.store.require(row.id).state;
    expect(st.judge_stage).toBeUndefined();
    const cj = Object.values(st.cells).filter((c) => c.cell_id.endsWith('|code_judge'));
    expect(cj).toHaveLength(4);
    expect(cj.every((c) => c.evaluated > 0 && c.judge_stage === undefined)).toBe(true);
    expect(st.conclusion!.judge_stage).toBeUndefined();
    expect(st.conclusion!.text).not.toContain('只对候补');
  }, 300_000);
});

describe('预算估算口径', () => {
  const svc = () => new MatrixStudyService({ db: openStateDb(':memory:').db, now: () => NOW, modelProfile: () => PROFILE });
  it('candidates:第一阶段只算 code 变体,判断按最坏 K 格;all 口径不变', () => {
    const s = svc();
    const all = s.estimate({ spec: spec2() }), cand = s.estimate({ spec: spec2({ judge_stage: 'candidates', judge_stage_max_cells: 1 }) });
    const app = all.cells.filter((c) => c.applicability === 'applicable');
    const codeV = app.filter((c) => c.id.endsWith('|code')).reduce((a, c) => a + c.variants, 0);
    const judgeCalls = app.reduce((a, c) => a + c.judge_calls, 0);
    // all:与旧口径一致
    expect(all.estimate.matrix_trials).toBe(app.reduce((a, c) => a + c.variants, 0));
    expect(all.estimate.judge_calls).toBe(judgeCalls);
    expect(all.estimate.stage1_trials).toBe(all.estimate.matrix_trials);
    expect(all.estimate.judge_stage.mode).toBe('all');
    // candidates:code 变体 + K 格 × 1 个变体;判断 = 单格最坏的 K 格
    const perVariant = app.filter((c) => c.id.endsWith('|code_judge')).map((c) => c.judge_calls / c.variants).sort((a, b) => b - a);
    expect(cand.estimate.stage1_trials).toBe(codeV);
    expect(cand.estimate.judge_stage).toMatchObject({ mode: 'candidates', max_cells: 1, judge_cells: 4, trials_max: 1 });
    expect(cand.estimate.matrix_trials).toBe(codeV + 1);
    expect(cand.estimate.judge_calls).toBe(Math.ceil(perVariant[0]!));
    expect(cand.estimate.judge_usd).toBe((cand.estimate.judge_calls * Number(PROFILE.max_call_usd)).toFixed(4).replace(/\.?0+$/, ''));
    expect(cand.estimate.budget.variants).toEqual({ value: codeV + 1, limit: 300 });
    expect(cand.estimate.budget.symbols).toEqual({ value: 2, limit: 6 });
    expect(cand.estimate.over).toEqual([]);
  });
  it('实测那组(6 币 × 15m × 6 族 × 多空 × 两臂):all 三个维度超,两段式全部回到预算内', () => {
    const s = new MatrixStudyService({ db: openStateDb(':memory:').db, now: () => Date.UTC(2026, 8, 26), modelProfile: () => ({ ...PROFILE, max_call_usd: '0.00015' }) });
    const big = { symbols: ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'BNB'], timeframes: ['15m'], families: ['breakout', 'ma_trend', 'ema_cross', 'pullback', 'mean_reversion', 'smc'], sides: ['long', 'short'], arms: ['code', 'code_judge'], market: 'perp', iterate: { generations: 0 } };
    const all = s.estimate({ spec: big }).estimate;
    expect(all.over.sort()).toEqual(['judge_calls', 'judge_usd', 'variants']);
    expect(all.within_budget).toBe(false);
    const cand = s.estimate({ spec: { ...big, judge_stage: 'candidates' } }).estimate;
    expect(cand.judge_stage.max_cells).toBe(12);
    expect(cand.over).toEqual([]);
    expect(cand.within_budget).toBe(true);
    expect(cand.matrix_trials).toBe(cand.stage1_trials + 12);
    expect(cand.judge_calls).toBeLessThanOrEqual(12 * 461);
    // 超过 6 个币仍在 spec 层拒绝(前端拆批)
    expect(() => s.estimate({ spec: { ...big, symbols: [...big.symbols, 'ADA'] } })).toThrow(/symbols_invalid/);
  });
  it('cellJudgeCalls 与 estimate 同口径;near 维度在 80% 以上', () => {
    const spec = normalizeSpec(spec2({ budget: { max_variants: 12 } }), { now: NOW });
    const m = buildManifest(spec, null, NOW), e = estimate(m);
    expect(e.judge_calls).toBe(m.cells.reduce((a, c) => a + cellJudgeCalls(c), 0));
    const r = e.matrix_trials / 12;
    if (r > 1) expect(e.over).toContain('variants'); else if (r > 0.8) expect(e.near).toContain('variants');
  });
});

describe('spec:judge_stage / origin.batch', () => {
  it('缺省 all;非法值与 K 单独传都报错;origin.batch 校验后原样保存', () => {
    const ctx = { now: NOW };
    expect(normalizeSpec(baseSpec(), ctx).judge_stage).toBe('all');
    expect(normalizeSpec(baseSpec(), ctx).judge_stage_max_cells).toBeUndefined();
    expect(normalizeSpec(baseSpec({ judge_stage: 'candidates' }), ctx).judge_stage_max_cells).toBe(12);
    expect(() => normalizeSpec(baseSpec({ judge_stage: 'some' }), ctx)).toThrow(/judge_stage_invalid/);
    expect(() => normalizeSpec(baseSpec({ judge_stage_max_cells: 3 }), ctx)).toThrow(/requires_candidates/);
    expect(() => normalizeSpec(baseSpec({ judge_stage: 'candidates', judge_stage_max_cells: 0 }), ctx)).toThrow(/judge_stage_max_cells_invalid/);
    expect(normalizeSpec(baseSpec(), ctx).origin).toEqual({ chat_session_id: null });
    expect(normalizeSpec(baseSpec({ origin: { batch: { id: 'batch-abc', index: 2, total: 3 } } }), ctx).origin).toEqual({ chat_session_id: null, batch: { id: 'batch-abc', index: 2, total: 3 } });
    expect(() => normalizeSpec(baseSpec({ origin: { batch: { id: 'x', index: 4, total: 3 } } }), ctx)).toThrow(/origin.batch.index_invalid/);
    expect(() => normalizeSpec(baseSpec({ origin: { batch: { id: 'x', index: 1 } } }), ctx)).toThrow(/origin.batch/);
    expect(() => normalizeSpec(baseSpec({ origin: { batch: { id: 'bad id', index: 1, total: 1 } } }), ctx)).toThrow(/origin.batch.id_invalid/);
  });
});
