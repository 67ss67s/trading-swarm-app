/**
 * 矩阵研究的 worker_threads 调度(主线程侧),接在 MatrixStudyService.deps.offload 上:
 *   run 整段、finalize 在 claim 之后的留出评估 → 起一个 worker(worker.ts)跑同一个 MatrixStudyService 方法;
 *   主线程只转发:'flush' → 主服务 flush()(outbox 单读者 → SSE)、'conclusion' → onConclusion、'decide' → judge provider(连接 / 密钥 / 花费账本留在主线程)。
 * 排队语义不变:run 仍由服务的 drain() 串行(同一时间一个 run worker);取消 = 服务原有的 AbortSignal → postMessage cancel。
 * worker 崩溃 / 非正常退出:按进程内抛异常同样落 failed(run 带 blocked handoff,留出段与 finalizeOnce 的 catch 同口径),不留 running 幽灵。
 * 关停:close() / 进程 SIGTERM|SIGINT(仅当宿主已装了这两个信号的处理,即网关 main)终止 worker,研究标 interrupted(与重启后 recover 同口径);
 *   进程 exit 时同步 terminate 兜底。
 * 内存库(测试)没有文件给 worker 另开连接,或 TG_MATRIX_WORKER=0,或服务注入了 loader / executorFor(不能跨线程),退回本线程跑(返回 null)。
 * 源码模式(vitest / 未编译)入口是 worker.ts:与 improve/manager.ts 同法,--experimental-transform-types + .js→.ts 解析钩子。
 */
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { pineEngineHost } from '../pine/engine-host.js';
import { DecisionError } from '../../decisions.js';
import type { DecisionProvider } from '../judge/types.js';
import type { MatrixJudgeDeps } from './evaluate.js';
import { MatrixStudyStore } from './store.js';
import type { MatrixConclusion, MatrixStudyRow } from './types.js';
import type { DecideError, MatrixMainMessage, MatrixWorkerData, MatrixWorkerMessage } from './worker.js';

const HOOKS = `import{existsSync}from'node:fs';import{fileURLToPath}from'node:url';
export async function resolve(s,c,n){if((s.startsWith('.')||s.startsWith('/'))&&s.endsWith('.js')&&c.parentURL&&c.parentURL.endsWith('.ts')){const u=new URL(s,c.parentURL);const t=u.href.slice(0,-3)+'.ts';if(!existsSync(fileURLToPath(u))&&existsSync(fileURLToPath(t)))return n(t,c);}return n(s,c);}`;
const REGISTER = `import{register}from'node:module';register('data:text/javascript,'+encodeURIComponent(${JSON.stringify(HOOKS)}));`;

export interface MatrixWorkerRunnerOptions {
  db: DatabaseSync;
  /** 主服务的 flush(outbox → SSE);worker 每次落库后提醒一次 */
  flush: () => void;
  judge?: () => MatrixJudgeDeps | undefined;
  onConclusion?: (row: MatrixStudyRow, conclusion: MatrixConclusion) => void;
  lease_ms?: number;
  /** 返回 true 时本线程跑(服务注入了不能跨线程的 loader / executorFor 等) */
  inlineIf?: () => boolean;
  /** 强制本线程跑 */
  inline?: boolean;
  /** 仅测试 / 压测:worker 里 import 的模块 URL(导出 loader / executorFor) */
  inject?: string;
  now?: () => number;
}
interface Running { id: string; op: 'run' | 'finalize'; worker: Worker; started: number; done: Promise<MatrixStudyRow>; closing: boolean }

const live = new Set<MatrixWorkerRunner>();
let exitHooked = false, signalHooked = false;
function hookProcess(): void {
  if (!exitHooked) { exitHooked = true; process.once('exit', () => { for (const r of live) r.terminateNow(); }); }
  // 只在宿主已经接管了 SIGTERM / SIGINT(网关 main 的 shutdown)时追加,不改变没有处理器的进程(测试)的默认退出行为
  if (!signalHooked && process.listenerCount('SIGTERM') > 0) {
    signalHooked = true;
    const stop = () => { for (const r of live) void r.close(); };
    process.on('SIGTERM', stop); if (process.listenerCount('SIGINT') > 0) process.on('SIGINT', stop);
  }
}

export class MatrixWorkerRunner {
  readonly store: MatrixStudyStore;
  private running = new Map<string, Running>();
  private now: () => number;
  constructor(readonly opts: MatrixWorkerRunnerOptions) { this.now = opts.now ?? Date.now; this.store = new MatrixStudyStore(opts.db, this.now); }
  /** 主库文件路径;内存库返回空串 */
  dbPath(): string { const rows = this.opts.db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]; return rows.find((r) => r.name === 'main')?.file ?? ''; }
  /** 当前在 worker 里跑的研究 id */
  active(): string[] { return [...this.running.keys()]; }
  /** 接到 MatrixServiceDeps.offload */
  readonly offload = (job: { op: 'run' | 'finalize'; id: string }, signal?: AbortSignal): Promise<MatrixStudyRow> | null => {
    if (this.opts.inline || process.env['TG_MATRIX_WORKER'] === '0' || this.opts.inlineIf?.()) return null;
    const path = this.dbPath();
    if (!path) return null;
    if (this.running.has(job.id)) return Promise.reject(Error('matrix_study_busy'));
    return this.spawn(job.op, job.id, path, signal);
  };

  private spawn(op: 'run' | 'finalize', id: string, db_path: string, signal?: AbortSignal): Promise<MatrixStudyRow> {
    const ts = import.meta.url.endsWith('.ts');
    const jd = this.judgeDeps(), provider: DecisionProvider | null = jd?.provider ?? null;
    const data: MatrixWorkerData = {
      op, study_id: id, db_path, lease_ms: this.opts.lease_ms ?? null, pine_url: pineEngineHost()?.url() ?? null,
      judge: jd ? { profile: provider ? structuredClone(provider.profile) : null, microstructure: !!jd.microstructure, mode: jd.mode ?? null } : null,
      inject: this.opts.inject ?? null, cancel_flag: new SharedArrayBuffer(4),
    };
    const worker = new Worker(new URL(ts ? './worker.ts' : './worker.js', import.meta.url), { workerData: data, execArgv: ts ? ['--experimental-transform-types', '--no-warnings', '--import', 'data:text/javascript,' + encodeURIComponent(REGISTER)] : [] });
    const calls = new Map<number, AbortController>();
    let resolve!: (r: MatrixStudyRow) => void, reject!: (e: unknown) => void, settled = false;
    const done = new Promise<MatrixStudyRow>((a, b) => { resolve = a; reject = b; });
    const r: Running = { id, op, worker, started: this.now(), done, closing: false };
    const onAbort = () => { Atomics.store(new Int32Array(data.cancel_flag!), 0, 1); worker.postMessage({ type: 'cancel' } satisfies MatrixMainMessage); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const settle = (f: () => void) => {
      if (settled) return; settled = true;
      signal?.removeEventListener('abort', onAbort);
      for (const c of calls.values()) c.abort(); calls.clear();
      this.running.delete(id); if (!this.running.size) live.delete(this);
      this.safeFlush(); f();
    };
    const crashed = (why: string) => settle(() => { try { this.markCrashed(r, why); } catch { /* 库已关 */ } this.safeFlush(); try { resolve(this.store.require(id)); } catch (e) { reject(e); } });
    worker.on('message', (m: MatrixWorkerMessage) => {
      switch (m.type) {
        case 'flush': this.safeFlush(); break;
        case 'conclusion': try { this.opts.onConclusion?.(m.row, m.conclusion); } catch { /* 回调失败不影响研究结果 */ } break;
        case 'decide': this.decide(worker, calls, provider, m.rid, m.req, m.timeoutMs); break;
        case 'decide_abort': calls.get(m.rid)?.abort(); break;
        case 'done': settle(() => { try { resolve(this.store.require(id)); } catch (e) { reject(e); } }); break;
        case 'error': if (m.phase === 'setup') crashed(`worker_error:${m.message}`); else settle(() => reject(Error(m.message))); break;
      }
    });
    worker.on('error', (e) => crashed(`worker_error:${e.message}`));
    worker.on('exit', (code) => { if (r.closing) settle(() => { try { this.markInterrupted(r); } catch { /* 库已关 */ } try { resolve(this.store.require(id)); } catch (e) { reject(e); } }); else crashed(code === 0 ? 'worker_exit_without_result' : `worker_exit:${code}`); });
    this.running.set(id, r); live.add(this); hookProcess();
    return done;
  }
  private judgeDeps(): MatrixJudgeDeps | undefined { try { return this.opts.judge?.(); } catch { return undefined; } }
  private safeFlush(): void { try { this.opts.flush(); } catch { /* 库已关 / SSE 失败不影响研究 */ } }
  private decide(worker: Worker, calls: Map<number, AbortController>, provider: DecisionProvider | null, rid: number, req: Parameters<DecisionProvider['decide']>[0], timeoutMs: number | null): void {
    const ac = new AbortController(); calls.set(rid, ac);
    const reply = (m: MatrixMainMessage) => { calls.delete(rid); try { worker.postMessage(m); } catch { /* worker 已退出 */ } };
    const fail = (e: unknown) => {
      const err: DecideError = e instanceof DecisionError ? { message: e.message, name: 'DecisionError', code: e.code, status: e.status, recorded_response: e.recorded_response } : { message: e instanceof Error ? e.message : String(e), name: e instanceof Error ? e.name : 'Error', code: null, status: null, recorded_response: null };
      reply({ type: 'decide_result', rid, ok: false, error: err });
    };
    if (!provider) { fail(Error('judge_provider_unavailable')); return; }
    let p: ReturnType<DecisionProvider['decide']>;
    try { p = provider.decide(req, { ...(timeoutMs !== null ? { timeoutMs } : {}), signal: ac.signal }); } catch (e) { fail(e); return; }
    p.then((result) => reply({ type: 'decide_result', rid, ok: true, result }), fail);
  }
  /** 与 service.fail(run)/ finalizeOnce 的 catch(留出段)同口径 */
  private markCrashed(r: Running, why: string): void {
    const row = this.store.get(r.id); if (!row) return;
    const msg = why.slice(0, 1000);
    if (row.status === 'finalizing') {
      row.state.run_ms += this.now() - r.started; row.state.error = msg;
      this.store.update(r.id, { status: 'failed', state: row.state }, { kind: 'status' });
    } else if (row.status === 'running' || (r.op === 'run' && row.status === 'queued')) {
      row.state.run_ms += this.now() - r.started; row.state.error = msg;
      this.store.update(r.id, { status: 'failed', state: row.state, lease: { token: null, until: null } }, { kind: 'status' }, { from: 'strategy_lab', to: 'gate_captain', kind: 'blocked', key: `failed:${row.state.run_ms}`, summary: `批量验证失败:${msg.slice(0, 200)}` });
    }
  }
  /** 与 store.recover 同口径(关停时就地做,不等下次启动) */
  private markInterrupted(r: Running): void {
    const row = this.store.get(r.id); if (!row || !(['running', 'finalizing'].includes(row.status) || (r.op === 'run' && row.status === 'queued'))) return;
    row.state.notes.push('网关关停,研究中断;可 resume 从断点继续(已完成的评估不重跑、计数不清零)');
    this.store.update(r.id, { status: 'interrupted', state: row.state, lease: { token: null, until: null } }, { kind: 'status' });
  }
  /** 进程 exit 兜底:同步发起终止(状态留给下次启动 recover) */
  terminateNow(): void { for (const r of this.running.values()) { r.closing = true; void r.worker.terminate(); } }
  /** 关停:终止所有 worker,研究标 interrupted;等收尾完成 */
  async close(): Promise<void> {
    const rs = [...this.running.values()];
    for (const r of rs) { r.closing = true; void r.worker.terminate(); }
    await Promise.all(rs.map((r) => r.done.catch(() => undefined)));
  }
}
