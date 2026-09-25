// 真实订单执行核 + 判断桩(零费用、零网络):code_judge 臂、候选日志、判断记账、取消 / 恢复不清零。
import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { MatrixStudyService } from '../../../../src/demo/research/matrix-study/service.js';
import { assetExecutorFor, type AssetExecutor } from '../../../../src/demo/research/backtest-report.js';
import { buildManifest, manifestHash } from '../../../../src/demo/research/matrix-study/manifest.js';
import { normalizeSpec } from '../../../../src/demo/research/matrix-study/spec.js';
import { PROFILE, TO_MS, baseSpec, edgeExecutor, loader, stubProvider } from './fixtures.js';

const NOW = TO_MS + 86400000;

describe('matrix study 服务:判断臂与记账', () => {
  it('真实订单核:两臂都评估,code_judge 候选全部落日志,判断调用 = 桩实际调用(压力运行不重复计费),账本与 handoff 齐', async () => {
    const db = openStateDb(':memory:').db, provider = stubProvider();
    const svc = new MatrixStudyService({ db, now: () => NOW, loader: loader(), judge: { provider } });
    const row = svc.create({ spec: baseSpec({ arms: ['code', 'code_judge'], model_profile: PROFILE, families: ['ema_cross', 'pullback'] }) });
    await svc.idle();
    const out = svc.store.require(row.id), st = out.state;
    expect(out.status, st.error ?? '').toBe('completed');
    expect(['passed', 'no_candidate']).toContain(st.conclusion!.kind);
    // 两臂格子都有成绩(不填零、不静默跳过)
    const cj = Object.values(st.cells).filter((c) => c.cell_id.endsWith('|code_judge'));
    expect(cj.length).toBeGreaterThan(0);
    expect(cj.every((c) => c.evaluated > 0 || c.cause !== null)).toBe(true);
    expect(cj.some((c) => c.evaluated > 0)).toBe(true);
    // 判断记账:预算表 calls = 桩收到的请求数;费用是十进制字符串且 > 0;每个请求只收一次费
    expect(provider.calls).toBeGreaterThan(0);
    expect(st.usage.judge_calls).toBe(provider.calls);
    expect(Number(st.usage.judge_usd)).toBeGreaterThan(0);
    expect(st.usage.judge_usd).toMatch(/^\d+(\.\d+)?$/);
    const cands = db.prepare('SELECT COUNT(*) n, SUM(json_extract(decision_json,\'$.action\')=\'skip\') s FROM research_study_candidates WHERE study_id=?').get(row.id) as { n: number; s: number };
    expect(cands.n).toBeGreaterThan(0);
    expect(cands.s).toBeGreaterThan(0); // 桩约 1/3 skip,全部候选(含 skip)留痕
    // 账本:谱系 trial_count = 看过成绩的不同配置;迭代的新变体也计入
    const trials = svc.store.trials(row.id);
    expect(st.ledger!.study_trial_count).toBe(trials.filter((t) => t.selection_visible_at !== null).length);
    expect(st.ledger!.attempt_count).toBeGreaterThanOrEqual(st.ledger!.study_trial_count);
    // 无界持仓族补了研究持仓上限,并按本格最大持仓给足空档
    const ema = out.manifest.cells.find((c) => c.family === 'ema_cross' && c.applicability === 'applicable')!;
    expect(ema.holding_cap).toBe(120);
    expect(ema.variants.every((v) => v.ir.order?.max_holding_bars === 120)).toBe(true);
    const pb = out.manifest.cells.find((c) => c.family === 'pullback' && c.applicability === 'applicable')!;
    expect(pb.segments!.purge_bars).toBeGreaterThanOrEqual(120);
    expect(svc.store.handoffs(row.id).some((h) => h.key.endsWith(':start'))).toBe(true);
    // 读视图:格子带 horizon,可研究性与原因都在
    const v = svc.get(row.id) as { cells: { horizon: string; applicability: string }[] };
    expect(v.cells.every((c) => c.horizon === 'mid')).toBe(true);
  }, 300_000);

  it('没有判断客户端时 code_judge 格标执行不支持,不伪造成「全部跳过」', async () => {
    const db = openStateDb(':memory:').db;
    const svc = new MatrixStudyService({ db, now: () => NOW, loader: loader(), executorFor: edgeExecutor() });
    const row = svc.create({ spec: baseSpec({ arms: ['code', 'code_judge'], model_profile: PROFILE }) });
    await svc.idle();
    const st = svc.store.require(row.id).state;
    const cj = Object.values(st.cells).filter((c) => c.cell_id.endsWith('|code_judge'));
    expect(cj.length).toBeGreaterThan(0);
    expect(cj.every((c) => c.cause === 'unsupported_execution' && c.evaluated === 0)).toBe(true);
    expect(st.conclusion!.causes.unsupported_execution).toBeGreaterThanOrEqual(cj.length);
  }, 120_000);

  it('取消 / 恢复:计数、尝试、留出占用不清零;已完成的评估不重跑', async () => {
    const db = openStateDb(':memory:').db;
    let n = 0, svc: MatrixStudyService | null = null;
    const edge = edgeExecutor();
    const exec = (ir: Parameters<typeof edge>[0]): AssetExecutor => async (x) => { if (++n === 6) svc!.cancel(svc!.store.list()[0]!.id); return edge(ir)(x); };
    svc = new MatrixStudyService({ db, now: () => NOW, loader: loader(), executorFor: exec });
    const row = svc.create({ spec: baseSpec() });
    await svc.idle();
    const c1 = svc.store.require(row.id);
    expect(c1.status).toBe('cancelled');
    const done1 = (db.prepare("SELECT COUNT(*) n FROM research_study_attempts WHERE study_id=? AND status='completed'").get(row.id) as { n: number }).n;
    const att1 = svc.store.attemptCount(row.id), vis1 = svc.store.studyTrialCount(row.id);
    expect(att1).toBeGreaterThan(0);
    expect(() => svc!.cancel(row.id)).toThrow(/conflict/);
    svc.resume(row.id); await svc.idle();
    const c2 = svc.store.require(row.id);
    expect(c2.status, c2.state.error ?? '').toBe('completed');
    expect(svc.store.attemptCount(row.id)).toBeGreaterThanOrEqual(att1);
    expect(svc.store.studyTrialCount(row.id)).toBeGreaterThanOrEqual(vis1);
    // 已完成的评估不重复:每个完成的评估行只有一次 completed 尝试
    const dup = db.prepare("SELECT evaluation_id, COUNT(*) n FROM research_study_attempts WHERE study_id=? AND status='completed' GROUP BY evaluation_id HAVING n>1").all(row.id);
    expect(dup).toEqual([]);
    expect(done1).toBeGreaterThan(0);
    expect(c2.state.notes.some((x) => x.startsWith('已取消'))).toBe(true);
    void assetExecutorFor;
  }, 120_000);

  it('进程重启:running 标 interrupted(不自动重跑),resume 后从断点跑完', async () => {
    const db = openStateDb(':memory:').db, svc = new MatrixStudyService({ db, now: () => NOW, loader: loader(), executorFor: edgeExecutor() });
    const spec = normalizeSpec(baseSpec(), { now: NOW }), m = buildManifest(spec, null, NOW);
    const row = svc.store.insert({ idempotency_key: 'crash', manifest: m, manifest_hash: manifestHash(m) });
    svc.store.update(row.id, { status: 'running', lease: { token: 'dead', until: NOW + 1 } });
    expect(svc.recover()).toEqual([row.id]);
    expect(svc.store.require(row.id).status).toBe('interrupted');
    svc.resume(row.id); await svc.idle();
    expect(svc.store.require(row.id).status).toBe('completed');
  }, 120_000);
});
