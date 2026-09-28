/**
 * 矩阵研究的 worker 线程入口:主线程只做建行 / claim / 收消息,取数、搜索、回测、留出评估都在这里(跑的就是 MatrixStudyService.run / finalize 原样)。
 * workerData 见 MatrixWorkerData;独立 DatabaseSync 连接(WAL + busy_timeout 5000,迁移已由主线程做过)。
 * 依赖在这里重建:recommendation 读同一个库;judge 的 provider 走消息代理(连接 / 密钥 / 花费账本都留在主线程),
 * 盘口录制源用 recorderMicrostructure()(与 runtime 钩子同一个函数,读同一个目录);outbox 只由主线程 flush(worker 发 'flush' 提醒)。
 * 消息:主 → worker {type:'cancel'} / {type:'decide_result'};worker → 主 {type:'flush'} / {type:'conclusion'} / {type:'decide'} / {type:'decide_abort'} / {type:'done'} / {type:'error'}。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { DecisionError, type DecisionRequest, type DecisionResult } from '../../decisions.js';
import { RecommendationStore } from '../../recommend.js';
import { recorderMicrostructure } from '../../micro-source.js';
import { ResearchStore } from '../store.js';
import { installWorkerPine } from '../improve/pine-bridge.js';
import type { BarsLoader, AssetExecutor } from '../backtest-report.js';
import type { StrategyIR } from '@trade-gate/contracts';
import type { FrozenModelProfile } from '../judge/types.js';
import type { MatrixJudgeDeps } from './evaluate.js';
import { MatrixStudyService } from './service.js';
import type { MatrixConclusion, MatrixStudyRow } from './types.js';

export interface MatrixWorkerData {
  op: 'run' | 'finalize'; study_id: string; db_path: string; lease_ms: number | null; pine_url: string | null;
  /** 取消标志(Int32Array[0]=1):搜索 / 回测大段同步时线程收不到 'cancel' 消息,check() 读 signal.aborted 时直接看这块共享内存 */
  cancel_flag: SharedArrayBuffer | null;
  /** 主线程在起线程时取的判断依赖快照:provider 只传 profile(decide 走消息),microstructure 只传有没有 */
  judge: { profile: FrozenModelProfile | null; microstructure: boolean; mode: MatrixJudgeDeps['mode'] | null } | null;
  /** 仅测试 / 压测:模块 URL,导出 loader?: BarsLoader、executorFor?: (ir) => AssetExecutor(替代联网 loader) */
  inject: string | null;
}
export interface DecideError { message: string; name: string; code: string | null; status: number | null; recorded_response: DecisionResult | null }
export type MatrixWorkerMessage =
  | { type: 'flush' }
  | { type: 'conclusion'; row: MatrixStudyRow; conclusion: MatrixConclusion }
  | { type: 'decide'; rid: number; req: DecisionRequest; timeoutMs: number | null }
  | { type: 'decide_abort'; rid: number }
  | { type: 'done'; status: string }
  /** phase=setup:线程没起来(开库 / 装依赖失败),主线程按崩溃收尾;phase=op:run / finalize 自己抛出的,和进程内抛出同样处理 */
  | { type: 'error'; message: string; phase: 'setup' | 'op' };
export type MatrixMainMessage =
  | { type: 'cancel' }
  | { type: 'decide_result'; rid: number; ok: true; result: DecisionResult }
  | { type: 'decide_result'; rid: number; ok: false; error: DecideError };

async function main(): Promise<void> {
  const port = parentPort!, wd = workerData as MatrixWorkerData, ac = new AbortController();
  if (wd.cancel_flag) {
    const flag = new Int32Array(wd.cancel_flag), real = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
    Object.defineProperty(ac.signal, 'aborted', { get(this: AbortSignal) { if (!real.call(this) && Atomics.load(flag, 0) === 1) ac.abort(); return real.call(this) as boolean; } });
  }
  const post = (m: MatrixWorkerMessage) => port.postMessage(m);
  const pending = new Map<number, { resolve: (r: DecisionResult) => void; reject: (e: unknown) => void }>();
  let rid = 0;
  port.on('message', (m: MatrixMainMessage) => {
    if (m?.type === 'cancel') ac.abort();
    else if (m?.type === 'decide_result') {
      const p = pending.get(m.rid); if (!p) return;
      pending.delete(m.rid);
      if (m.ok) p.resolve(m.result);
      else {
        const e = m.error, err = e.name === 'DecisionError' && e.code ? new DecisionError(e.message, e.code as DecisionError['code'], e.status, e.recorded_response) : Object.assign(Error(e.message), { name: e.name });
        p.reject(err);
      }
    }
  });
  let db: DatabaseSync | null = null, svc: MatrixStudyService;
  try {
    db = new DatabaseSync(wd.db_path);
    db.exec('PRAGMA journal_mode = WAL'); db.exec('PRAGMA foreign_keys = ON'); db.exec('PRAGMA busy_timeout = 5000');
    installWorkerPine(wd.pine_url, db, new ResearchStore(db));
    const inj = wd.inject ? (await import(wd.inject)) as { loader?: BarsLoader; executorFor?: (ir: StrategyIR) => AssetExecutor } : {};
    let judge: MatrixJudgeDeps | undefined;
    if (wd.judge) {
      const profile = wd.judge.profile;
      judge = {
        ...(profile ? {
          provider: {
            profile,
            decide: (req: DecisionRequest, o?: { timeoutMs?: number; signal?: AbortSignal }) => new Promise<DecisionResult>((resolve, reject) => {
              const id = ++rid;
              if (o?.signal?.aborted) { reject(Object.assign(Error('This operation was aborted'), { name: 'AbortError' })); return; }
              pending.set(id, { resolve, reject });
              o?.signal?.addEventListener('abort', () => { if (pending.has(id)) post({ type: 'decide_abort', rid: id }); }, { once: true });
              post({ type: 'decide', rid: id, req, timeoutMs: o?.timeoutMs ?? null });
            }),
          },
        } : {}),
        ...(wd.judge.microstructure ? { microstructure: recorderMicrostructure() } : {}),
        ...(wd.judge.mode ? { mode: wd.judge.mode } : {}),
      };
    }
    const d = db;
    svc = new MatrixStudyService({
      db: d,
      ...(inj.loader ? { loader: inj.loader } : {}),
      ...(inj.executorFor ? { executorFor: inj.executorFor } : {}),
      ...(judge ? { judge } : {}),
      recommendation: (id) => new RecommendationStore(d).get(id),
      onConclusion: (row, conclusion) => post({ type: 'conclusion', row, conclusion }),
      ...(wd.lease_ms ? { lease_ms: wd.lease_ms } : {}),
    });
    // outbox 只让主线程读 / 标已送达(单读者,SSE 顺序与进程内一致)
    svc.flush = () => post({ type: 'flush' });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e), phase: 'setup' });
    db?.close(); port.unref(); return;
  }
  try {
    const row = wd.op === 'run' ? await svc.run(wd.study_id, ac.signal) : await svc.finalize(wd.study_id, undefined, ac.signal, true);
    post({ type: 'flush' });
    post({ type: 'done', status: row.status });
  } catch (e) {
    post({ type: 'flush' });
    post({ type: 'error', message: e instanceof Error ? e.message : String(e), phase: 'op' });
  } finally { db.close(); port.unref(); }
}
void main();
