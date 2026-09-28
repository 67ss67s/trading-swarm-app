// 矩阵研究 worker_threads:文件库 + 注入合成 loader / 执行器(零网络、零模型)。
// 同一规格 worker 与本线程两种跑法落库结果一致;worker 模式主事件循环不被搜索 / 回测阻塞;判断走消息代理记账一致;取消 / 崩溃 / 关停收尾。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { MatrixStudyService } from '../../../../src/demo/research/matrix-study/service.js';
import { MatrixWorkerRunner } from '../../../../src/demo/research/matrix-study/worker-runner.js';
import type { MatrixEvent, MatrixStudyRow } from '../../../../src/demo/research/matrix-study/types.js';
import { PROFILE, baseSpec, edgeExecutor, loader, stubProvider } from './fixtures.js';

const dir = mkdtempSync(path.join(tmpdir(), 'matrix-worker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const inject = (mode: string) => new URL(`./worker-inject.ts?mode=${mode}`, import.meta.url).href;

function worker(mode: string, o: { judge?: ReturnType<typeof stubProvider> } = {}) {
  const state = openStateDb(path.join(dir, `w${n++}.sqlite`)), events: MatrixEvent[] = [], conclusions: unknown[] = [];
  let svc!: MatrixStudyService;
  const runner = new MatrixWorkerRunner({ db: state.db, flush: () => svc.flush(), inject: inject(mode), onConclusion: (_r, c) => conclusions.push(c), ...(o.judge ? { judge: () => ({ provider: o.judge! }) } : {}) });
  svc = new MatrixStudyService({ db: state.db, offload: runner.offload, emit: (_e, d) => events.push(d as MatrixEvent), onConclusion: () => { throw Error('inline onConclusion must not run in worker mode'); }, ...(o.judge ? { judge: { provider: o.judge } } : {}) });
  return { state, svc, runner, events, conclusions };
}
function inline(edge: boolean, o: { judge?: ReturnType<typeof stubProvider> } = {}) {
  const state = openStateDb(path.join(dir, `i${n++}.sqlite`)), events: MatrixEvent[] = [], conclusions: unknown[] = [];
  const svc = new MatrixStudyService({ db: state.db, loader: loader(), ...(edge ? { executorFor: edgeExecutor() } : {}), emit: (_e, d) => events.push(d as MatrixEvent), onConclusion: (_r, c) => conclusions.push(c), ...(o.judge ? { judge: { provider: o.judge } } : {}) });
  return { state, svc, events, conclusions };
}
/** 主事件循环最大延迟(setInterval 10ms 的漂移) */
function lagMeter() {
  let max = 0, last = performance.now();
  const t = setInterval(() => { const x = performance.now(); max = Math.max(max, x - last - 10); last = x; }, 10);
  return () => { clearInterval(t); return Math.round(Math.max(max, performance.now() - last - 10)); };
}
/** 可比较的落库结果(去掉时间戳 / 随机 id) */
function digest(svc: MatrixStudyService, row: MatrixStudyRow) {
  const s = row.state, trials = svc.store.trials(row.id);
  const byTrial = new Map(trials.map((t) => [t.trial_id, `${t.cell_id}:${t.variant_id}:${t.generation}`]));
  return {
    status: row.status, stage: row.stage, error: s.error, kind: s.conclusion?.kind, text: s.conclusion?.text, holdout: s.holdout_state, stop: s.stop_reason,
    ledger: s.ledger ? { trial_count: s.ledger.trial_count, study_trial_count: s.ledger.study_trial_count, attempt_count: s.ledger.attempt_count } : null,
    cells: Object.values(s.cells).map((c) => ({ ...c, best_trial_id: c.best_trial_id ? byTrial.get(c.best_trial_id) : null })),
    finalists: s.finalists.map((f) => ({ trial: byTrial.get(f.trial_id), selection: f.selection, holdout: f.holdout, test: f.test, passed: f.passed, cause: f.cause, portfolio: f.portfolio, judge: f.judge })),
    trials: trials.map((t) => `${t.cell_id}:${t.variant_id}:${t.generation}:${t.config_hash}:${t.status}`).sort(),
    usage: { judge_calls: s.usage.judge_calls, judge_usd: s.usage.judge_usd },
    handoffs: svc.store.handoffs(row.id).map((h) => h.key.replace(row.id, 'ID').replace(/failed:\d+/, 'failed')).sort(),
    candidates: (svc.store.db.prepare('SELECT COUNT(*) n FROM research_study_candidates WHERE study_id=?').get(row.id) as { n: number }).n,
  };
}
const kinds = (ev: MatrixEvent[]) => ev.map((e) => e.kind);

describe('矩阵研究 worker_threads', () => {
  it('通过路径:worker 与本线程落库结果一致;worker 模式主循环不被阻塞;SSE 单读者无重复', async () => {
    const W = worker('edge'), I = inline(true);
    let stop = lagMeter();
    const wr = W.svc.create({ spec: baseSpec(), idempotency_key: 'k' });
    await W.svc.idle();
    const wLag = stop();
    stop = lagMeter();
    const ir = I.svc.create({ spec: baseSpec(), idempotency_key: 'k' });
    await I.svc.idle();
    const iLag = stop();
    const wOut = W.svc.store.require(wr.id), iOut = I.svc.store.require(ir.id);
    expect(wOut.status, wOut.state.error ?? '').toBe('completed');
    expect(wOut.state.conclusion!.kind).toBe('passed');
    // 合成优势执行器与 IR 无关:同分变体按随机 trial_id 破平,所以这里去掉「是哪个变体」,比其余落库结果(判断臂用真实执行核的用例比完整摘要)
    const loose = (d: ReturnType<typeof digest>) => ({ ...d, text: null, cells: d.cells.map((c) => ({ ...c, best_trial_id: null })), finalists: d.finalists.map((f) => ({ passed: f.passed, cause: f.cause, p: f.test?.p_value, ret: f.holdout?.total_return })).sort((x, y) => String(x.p).localeCompare(String(y.p))) });
    expect(loose(digest(W.svc, wOut))).toEqual(loose(digest(I.svc, iOut)));
    expect(kinds(W.events)).toEqual(kinds(I.events));
    expect(W.events.map((e) => e.seq)).toEqual([...new Set(W.events.map((e) => e.seq))].sort((a, b) => a - b));
    expect(W.svc.store.undelivered().length).toBe(0);
    const ck = (c: unknown[]) => c.map((x) => ({ kind: (x as { kind: string }).kind, n: (x as { finalist_ids: string[] }).finalist_ids.length }));
    expect(W.conclusions).toHaveLength(1);
    expect(ck(W.conclusions)).toEqual(ck(I.conclusions));
    expect(W.runner.active()).toEqual([]);
    console.log(`[matrix worker] event-loop max lag: worker=${wLag}ms inline=${iLag}ms`);
    // 机器负载高时 worker 模式也有零星几百毫秒(建线程 / GC / 同库写锁);本线程模式是整段研究的同步块
    expect(wLag).toBeLessThan(iLag);
    W.state.close(); I.state.close();
  }, 300_000);

  it('判断臂:decide 走消息代理,预算记账 = 主线程 provider 实际调用数,与本线程一致', async () => {
    const pw = stubProvider(), pi = stubProvider();
    const W = worker('loader', { judge: pw }), I = inline(false, { judge: pi });
    const spec = baseSpec({ arms: ['code', 'code_judge'], model_profile: PROFILE });
    const wr = W.svc.create({ spec, idempotency_key: 'j' }); await W.svc.idle();
    const ir = I.svc.create({ spec, idempotency_key: 'j' }); await I.svc.idle();
    const wOut = W.svc.store.require(wr.id);
    expect(wOut.status, wOut.state.error ?? '').toBe('completed');
    expect(pw.calls).toBeGreaterThan(0);
    expect(pw.calls).toBe(pi.calls);
    expect(wOut.state.usage.judge_calls).toBe(pw.calls);
    expect(digest(W.svc, wOut)).toEqual(digest(I.svc, I.svc.store.require(ir.id)));
    W.state.close(); I.state.close();
  }, 600_000);

  it('手动 finalize:claim 在主线程同步完成(返回时已 finalizing),留出评估进 worker → released / completed', async () => {
    const W = worker('edge');
    const row = W.svc.create({ spec: { ...baseSpec(), auto_finalize: false }, idempotency_key: 'f' }); await W.svc.idle();
    const sealed = W.svc.store.require(row.id);
    expect(sealed.status, sealed.state.error ?? '').toBe('ready_to_finalize');
    const p = W.svc.finalize(row.id, sealed.manifest_hash);
    expect(W.svc.store.require(row.id).status).toBe('finalizing');
    await expect(W.svc.finalize(row.id, sealed.manifest_hash)).rejects.toThrow('holdout_already_claimed');
    const out = await p;
    expect(out.status, out.state.error ?? '').toBe('completed');
    expect(out.state.holdout_state).toBe('released');
    expect(W.svc.store.release(row.id)!.status).toBe('released');
    expect(W.conclusions).toHaveLength(1);
    expect(W.svc.store.undelivered().length).toBe(0);
    W.state.close();
  }, 300_000);

  it('取消走 postMessage → cancelled;resume 后在新 worker 里跑完', async () => {
    const W = worker('edge');
    let id = '';
    const svc = W.svc, orig = svc.deps.emit!;
    svc.deps.emit = (e, d) => { orig(e, d); if ((d as MatrixEvent).kind === 'progress' && id && svc.store.require(id).status === 'running') svc.cancel(id); };
    id = svc.create({ spec: baseSpec(), idempotency_key: 'c' }).id;
    await svc.idle();
    expect(svc.store.require(id).status).toBe('cancelled');
    expect(W.runner.active()).toEqual([]);
    svc.deps.emit = orig;
    expect(svc.resume(id).status).toBe('queued');
    await svc.idle();
    const out = svc.store.require(id);
    expect(out.status, out.state.error ?? '').toBe('completed');
    W.state.close();
  }, 300_000);

  it('worker 崩溃:研究落 failed(不留 running)、租约清空、blocked handoff;可 resume', async () => {
    const W = worker('crash');
    const id = W.svc.create({ spec: baseSpec(), idempotency_key: 'x' }).id;
    await W.svc.idle();
    const out = W.svc.store.require(id);
    expect(out.status).toBe('failed');
    expect(out.state.error).toBe('worker_exit:7');
    expect(out.lease_token).toBeNull();
    expect(W.svc.store.handoffs(id).some((h) => h.kind === 'blocked')).toBe(true);
    expect(W.svc.store.undelivered().length).toBe(0);
    expect(W.runner.active()).toEqual([]);
    expect(W.svc.resume(id).status).toBe('queued');
    await W.svc.idle();
    expect(W.svc.store.require(id).status).toBe('failed');
    W.state.close();
  }, 120_000);

  it('关停 close():终止 worker,研究标 interrupted(可 resume),队列放空', async () => {
    const W = worker('hang');
    const id = W.svc.create({ spec: baseSpec(), idempotency_key: 'h' }).id;
    for (let i = 0; i < 400 && W.svc.store.require(id).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(W.svc.store.require(id).status).toBe('running');
    await W.runner.close();
    await W.svc.idle();
    const out = W.svc.store.require(id);
    expect(out.status).toBe('interrupted');
    expect(out.lease_token).toBeNull();
    expect(W.runner.active()).toEqual([]);
    expect(W.svc.resume(id).status).toBe('queued');
    for (let i = 0; i < 400 && !W.runner.active().length; i++) await new Promise((r) => setTimeout(r, 50));
    await W.runner.close(); await W.svc.idle();
    expect(W.svc.store.require(id).status).toBe('interrupted');
    W.state.close();
  }, 120_000);
});
