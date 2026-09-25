/**
 * 改进任务调度(主线程侧):建任务行 → 起 worker_threads 跑 runImprovement → 转发进度事件 → 取消。
 * 主线程上只有建行、收消息、广播;取数和回测全在 worker 里,网关的 /health 不被回测阻塞(交接 P0 的正式解法)。
 * 同一时间只跑一个改进任务(第二个 409 improve_busy):一个任务就要占一个核跑满几分钟,再叠一个只会互相拖慢。
 * 数据库是内存库(测试)时没有文件可给 worker 另开连接,退回进程内跑(inline),语义不变。
 * 源码模式(vitest / 未编译)下 worker 入口是 worker.ts:用 Node 自带的 --experimental-transform-types 加一个把 .js 说明符解析到 .ts 的钩子起线程。
 */
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { pineEngineHost } from '../pine/engine-host.js';
import { ImproveStore, type ImproveSpec, type JobRow } from './store.js';
import { runImprovement, type ImproveEvent, type RunnerDeps } from './runner.js';
import type { WorkerMessage } from './worker.js';

const HOOKS = `import{existsSync}from'node:fs';import{fileURLToPath}from'node:url';
export async function resolve(s,c,n){if((s.startsWith('.')||s.startsWith('/'))&&s.endsWith('.js')&&c.parentURL&&c.parentURL.endsWith('.ts')){const u=new URL(s,c.parentURL);const t=u.href.slice(0,-3)+'.ts';if(!existsSync(fileURLToPath(u))&&existsSync(fileURLToPath(t)))return n(t,c);}return n(s,c);}`;
const REGISTER = `import{register}from'node:module';register('data:text/javascript,'+encodeURIComponent(${JSON.stringify(HOOKS)}));`;

export interface ManagerOptions {
  /** 强制进程内跑(测试);缺省:文件库走 worker,内存库进程内 */
  inline?: boolean;
  /** 进程内跑时透传给 runner(测试注入合成行情 / 执行器) */
  runner?: Pick<RunnerDeps, 'loader' | 'executorFor' | 'writeVersion'>;
}
interface Running { id: string; worker: Worker | null; abort: AbortController | null; done: Promise<void> }

export class ImproveManager {
  readonly jobs: ImproveStore;
  private running = new Map<string, Running>();
  constructor(readonly db: DatabaseSync, readonly emit: (e: ImproveEvent) => void, readonly opts: ManagerOptions = {}) {
    this.jobs = new ImproveStore(db);
    const n = this.jobs.recover();
    if (n) console.error(`[research.improve] ${n} 个改进任务随进程重启中断,已标 interrupted`);
  }
  /** 主库文件路径;内存库返回空串。 */
  dbPath(): string { const rows = this.db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]; return rows.find((r) => r.name === 'main')?.file ?? ''; }
  busy(): string | null { return [...this.running.keys()][0] ?? null; }
  start(spec: ImproveSpec): JobRow {
    const other = this.busy();
    if (other) throw Error(`improve_busy:${other}`);
    const job = this.jobs.createJob(spec), path = this.dbPath();
    if (this.opts.inline || !path) this.startInline(job.id); else this.startWorker(job.id, path);
    return job;
  }
  private startInline(id: string): void {
    const abort = new AbortController();
    const done = (async () => { try { await runImprovement({ db: this.db, signal: abort.signal, emit: this.emit, ...this.opts.runner }, id); } finally { this.running.delete(id); } })();
    this.running.set(id, { id, worker: null, abort, done });
  }
  private startWorker(id: string, db_path: string): void {
    const ts = import.meta.url.endsWith('.ts');
    const entry = new URL(ts ? './worker.ts' : './worker.js', import.meta.url);
    const worker = new Worker(entry, { workerData: { job_id: id, db_path, pine_url: pineEngineHost()?.url() ?? null }, execArgv: ts ? ['--experimental-transform-types', '--no-warnings', '--import', 'data:text/javascript,' + encodeURIComponent(REGISTER)] : [] });
    let settle!: () => void;
    const done = new Promise<void>((r) => { settle = r; });
    const finish = (why: string | null) => {
      if (!this.running.has(id)) return;
      this.running.delete(id);
      const row = this.jobs.job(id);
      // worker 没来得及写终态(崩溃 / 被杀):按失败收尾,不留 running 幽灵
      if (why && row && (row.status === 'running' || row.status === 'queued')) { this.jobs.update(id, { status: 'failed', error: why.slice(0, 2000), finished: true }); this.emit({ job_id: id, phase: 'done', generation: row.progress?.generation ?? 0, message: `失败:${why.slice(0, 300)}`, trials: row.progress?.trials ?? 0, status: 'failed' }); }
      settle();
    };
    worker.on('message', (m: WorkerMessage) => { if (m.type === 'event') this.emit(m.event); else if (m.type === 'error') finish(`worker_error:${m.message}`); else if (m.type === 'done') finish(null); });
    worker.on('error', (e) => finish(`worker_error:${e.message}`));
    worker.on('exit', (code) => finish(code === 0 ? 'worker_exit_without_result' : `worker_exit:${code}`));
    this.running.set(id, { id, worker, abort: null, done });
  }
  cancel(id: string): JobRow {
    const job = this.jobs.require(id), r = this.running.get(id);
    if (!r) { if (job.status === 'queued' || job.status === 'running') { this.jobs.update(id, { status: 'cancelled', error: 'cancelled', finished: true }); } return this.jobs.require(id); }
    r.abort?.abort(); r.worker?.postMessage({ type: 'cancel' });
    return this.jobs.require(id);
  }
  /** 等任务结束(测试 / 关停用)。 */
  async wait(id: string): Promise<JobRow> { await this.running.get(id)?.done; return this.jobs.require(id); }
  async close(): Promise<void> { for (const r of this.running.values()) { r.abort?.abort(); r.worker?.postMessage({ type: 'cancel' }); } await Promise.all([...this.running.values()].map((r) => r.done)); }
}
