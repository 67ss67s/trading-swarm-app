/**
 * 改进任务的 worker 线程入口(设计第六节):主线程只收发消息,取数、回测、写候选都在这里。
 * workerData:{ job_id, db_path, pine_url };消息:主 → worker {type:'cancel'};worker → 主 {type:'event',event} / {type:'done',status} / {type:'error',message}。
 * 独立 DatabaseSync 连接(WAL + busy_timeout 5000,迁移已由主线程做过);Pine 地址见 pine-bridge.ts。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { ResearchStore } from '../store.js';
import { installWorkerPine } from './pine-bridge.js';
import { runImprovement } from './runner.js';

export interface ImproveWorkerData { job_id: string; db_path: string; pine_url: string | null }
export type WorkerMessage = { type: 'event'; event: import('./runner.js').ImproveEvent } | { type: 'done'; status: string } | { type: 'error'; message: string };

async function main(): Promise<void> {
  const port = parentPort!, wd = workerData as ImproveWorkerData, ac = new AbortController();
  port.on('message', (m: { type?: string }) => { if (m?.type === 'cancel') ac.abort(); });
  const db = new DatabaseSync(wd.db_path);
  try {
    db.exec('PRAGMA journal_mode = WAL'); db.exec('PRAGMA foreign_keys = ON'); db.exec('PRAGMA busy_timeout = 5000');
    installWorkerPine(wd.pine_url, db, new ResearchStore(db));
    const row = await runImprovement({ db, signal: ac.signal, emit: (event) => port.postMessage({ type: 'event', event } satisfies WorkerMessage) }, wd.job_id);
    port.postMessage({ type: 'done', status: row.status } satisfies WorkerMessage);
  } catch (e) {
    port.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) } satisfies WorkerMessage);
  } finally { db.close(); port.unref(); }
}
void main();
