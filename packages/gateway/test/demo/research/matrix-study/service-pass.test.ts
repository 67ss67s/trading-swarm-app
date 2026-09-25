// 有可控优势的合成执行器:走完 search → 封存 → 留出一次释放(Holm)→ 账户级回放 → adopt(预检)全链路。零网络、零模型。
import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { MatrixStudyService } from '../../../../src/demo/research/matrix-study/service.js';
import type { MatrixEvent } from '../../../../src/demo/research/matrix-study/types.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import { TO_MS, baseSpec, edgeExecutor, loader } from './fixtures.js';

const NOW = TO_MS + 86400000;
function svcOf(o: Partial<ConstructorParameters<typeof MatrixStudyService>[0]> = {}) {
  const db = openStateDb(':memory:').db, events: MatrixEvent[] = [], L = loader(), conclusions: unknown[] = [], adopted: unknown[] = [];
  const svc = new MatrixStudyService({ db, now: () => NOW, loader: L, executorFor: edgeExecutor(), emit: (_e, d) => events.push(d as MatrixEvent), onConclusion: (_r, c) => conclusions.push(c), onAdopted: (_r, a) => adopted.push(a), ...o });
  return { db, svc, events, L, conclusions, adopted };
}

describe('matrix study 服务:通过路径(合成优势)', () => {
  it('封存 finalist → 自动一次释放留出 → Holm → 账户级回放 → completed passed;handoff / outbox / 回调齐', async () => {
    const { db, svc, events, L, conclusions } = svcOf();
    const row = svc.create({ spec: { ...baseSpec(), origin: { chat_session_id: 'chat_1' } }, idempotency_key: 'k1' });
    expect(svc.create({ spec: { ...baseSpec(), origin: { chat_session_id: 'chat_1' } }, idempotency_key: 'k1' }).id).toBe(row.id); // 幂等
    await svc.idle();
    const out = svc.store.require(row.id), st = out.state;
    expect(out.status, st.error ?? '').toBe('completed');
    expect(st.conclusion!.kind).toBe('passed');
    expect(st.holdout_state).toBe('released');
    // finalist:≤ top_k,带留出成绩、Holm 阈值、短中长标签与来源、账户级回放
    expect(st.finalists.length).toBeGreaterThan(0);
    expect(st.finalists.length).toBeLessThanOrEqual(2);
    const f = st.finalists[0]!;
    expect(f.horizon).toBe('mid');
    expect(f.source).toEqual({ recommendation_id: null, radar_tier: null, universe_scan_at: null });
    expect(f.test!.p_value!).toBeLessThan(0.025);
    expect(f.test!.holm_threshold).not.toBeNull();
    expect(f.passed).toBe(true);
    expect(f.portfolio).toMatchObject({ initial: 10000, risk_pct: 0.005, max_open: 3 });
    expect(f.portfolio!.trades).toBeGreaterThan(0);
    expect(f.portfolio!.skipped_by_capacity).toBeGreaterThanOrEqual(0);
    // 账本:谱系试验数 = 本 Study 看过成绩的不同配置;attempt ≥ trial
    expect(st.ledger!.trial_count).toBe(st.ledger!.study_trial_count);
    expect(st.ledger!.attempt_count).toBeGreaterThanOrEqual(st.ledger!.trial_count);
    expect(st.ledger!.dsr_sensitivity.length).toBeGreaterThan(0);
    // 隔离:搜索阶段取数都截止到选择段末;留出取数只在 claim 之后
    const g = out.manifest.segments['4h']!, rel = svc.store.release(row.id)!;
    expect(rel.status).toBe('released');
    const devCalls = L.calls.filter((c) => c.to_ms <= g.selection.to_ms), hoCalls = L.calls.filter((c) => c.to_ms > g.selection.to_ms);
    expect(devCalls.length).toBeGreaterThan(0);
    expect(hoCalls.every((c) => c.to_ms === g.holdout.to_ms)).toBe(true);
    // handoff:开始 / 封存 / 完成(每个都带 study_id)
    const hs = svc.store.handoffs(row.id);
    expect(hs.map((h) => `${h.from}>${h.to}`)).toEqual(expect.arrayContaining(['gate_captain>strategy_lab', 'strategy_lab>gate_captain']));
    expect(hs.every((h) => h.payload?.study_id === row.id)).toBe(true);
    expect(hs.some((h) => h.key.endsWith(':complete'))).toBe(true);
    // outbox 已全部投递、seq 单调;完成回调拿到结论
    expect(svc.store.undelivered().length).toBe(0);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    expect(events.some((e) => e.kind === 'conclusion')).toBe(true);
    expect(conclusions).toHaveLength(1);
    expect(out.manifest.spec.origin.chat_session_id).toBe('chat_1');
    // 释放后不能再往本 Study 登记试验;释放结果不可覆盖
    expect(() => svc.store.insertTrial({ study_id: row.id, program: out.research_program_id, cell_id: 'x', variant_id: 'x', parent_trial_id: null, generation: 9, config_hash: 'new', ir_hash: 'x', judge_hash: null, model_revision: null, candidate: {} })).toThrow('matrix_holdout_claimed_no_more_search');
    expect(() => db.prepare("UPDATE research_holdout_releases SET result_json='{}' WHERE study_id=?").run(row.id)).toThrow('matrix_release_result_immutable');
    expect(() => db.prepare("UPDATE research_matrix_studies SET manifest_json='{}' WHERE id=?").run(row.id)).toThrow('matrix_manifest_immutable');
  }, 120_000);

  it('adopt:预检通过才存成 ResearchStrategy(描述带 horizon / 来源);预检 blocker 整体回滚;幂等', async () => {
    const { db, svc, adopted } = svcOf();
    // ema_cross 不设止损,运行器预检必拦(见下一条);adopt 用带 ATR 硬止损的 breakout 族
    const row = svc.create({ spec: baseSpec({ families: ['breakout'] }) }); await svc.idle();
    const f = svc.store.require(row.id).state.finalists.find((x) => x.passed)!;
    // 注入一个会拦下的预检:策略不能落库
    const blocked = new MatrixStudyService({ db, now: () => NOW, preflight: () => ({ deployable: false, blockers: [{ code: 'x', message: '测试拦截' }], warnings: [] }) });
    const before = new StrategyStore(db).list({ q: '', filter: 'all', sort: 'updated' }).length;
    expect(() => blocked.adopt(row.id, f.id)).toThrow(/adopt_preflight_blocked:x\(测试拦截\)/);
    expect(new StrategyStore(db).list({ q: '', filter: 'all', sort: 'updated' }).length).toBe(before);
    const a = svc.adopt(row.id, f.id, '测试策略');
    expect(a.preflight.deployable).toBe(true);
    expect(a.horizon).toBe('mid');
    const s = new StrategyStore(db).require(a.strategy_id);
    expect(s.timeframe).toBe('4h');
    expect(s.description).toMatch(/horizon=mid/);
    expect(new StrategyStore(db).versionIR(a.strategy_id, a.version)).toEqual(f.ir);
    expect(svc.adopt(row.id, f.id).strategy_id).toBe(a.strategy_id);
    expect(adopted).toHaveLength(1);
    expect(svc.store.handoffs(row.id).some((h) => h.from === 'gate_captain' && h.to === 'thread_manager')).toBe(true);
    expect(() => svc.adopt(row.id, 'nope')).toThrow('finalist_not_found');
  }, 120_000);

  it('adopt 出策略不出错:不设止损的 finalist 被静态预检拦下(no_stop),不落库', async () => {
    const { db, svc } = svcOf();
    const row = svc.create({ spec: baseSpec() }); await svc.idle();
    const f = svc.store.require(row.id).state.finalists.find((x) => x.passed)!;
    expect(f.family).toBe('ema_cross');
    expect(() => svc.adopt(row.id, f.id)).toThrow(/adopt_preflight_blocked:.*no_stop/);
    expect(new StrategyStore(db).list({ q: '', filter: 'all', sort: 'updated' }).length).toBe(0);
    expect(svc.store.adoption(row.id, f.id)).toBeNull();
  }, 120_000);

  it('留出按谱系 + 区间原子占用:手动 finalize 只能成功一次;同谱系重叠区间的新 Study 被拒', async () => {
    const { svc } = svcOf();
    const row = svc.create({ spec: { ...baseSpec(), auto_finalize: false } }); await svc.idle();
    const sealed = svc.store.require(row.id);
    expect(sealed.status).toBe('ready_to_finalize');
    expect(sealed.state.holdout_state).toBe('sealed');
    expect(svc.store.release(row.id)).toBeNull();
    await expect(svc.finalize(row.id, 'wrong')).rejects.toThrow('manifest_hash_mismatch');
    const [a, b] = await Promise.allSettled([svc.finalize(row.id, sealed.manifest_hash), svc.finalize(row.id, sealed.manifest_hash)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(((a.status === 'rejected' ? a : b) as PromiseRejectedResult).reason.message).toMatch(/holdout_already_claimed|conflict/);
    expect(svc.store.require(row.id).status).toBe('completed');
    // 换个 Study id / 改名也不能重用同一留出区间
    expect(() => svc.create({ spec: baseSpec(), idempotency_key: 'other' })).toThrow(/holdout_range_already_used/);
  }, 120_000);
});
