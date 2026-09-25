/**
 * 批量研究主进程:worker_threads 池跑全部变体(零模型,不进 18811 网关进程)→ 汇总排行榜/Deflated Sharpe/门槛/每族冠军
 * → 随机入场基线(验证段前 N + 每族冠军)→ 每族冠军跑一次留出段。结果写 ~/.trading-swarm-okx/research-batch/results.json(可断点续跑)。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/run.ts [--workers 5] [--tf 1d,4h] [--only-eval]
 */
import { Worker } from 'node:worker_threads';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { allVariants, type Variant } from '../../packages/gateway/src/demo/research/batch/families.ts';
import { familyChampions, leaderboard, withDeflated, withGates, type BatchRow } from '../../packages/gateway/src/demo/research/batch/study.ts';
import { BATCH_DIR, segmentsFor } from './common.ts';
import type { Task } from './worker.ts';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const WORKERS = Number(arg('--workers') ?? Math.max(1, Math.min(5, availableParallelism() - 3)));
const TFS = (arg('--tf') ?? '15m,1h,4h,1d').split(',');
/** --families a,b:只跑这些族(口径变更后分批重跑用);--refresh-families a,b:先删掉这些族的已有结果再跑 */
const FAMS = arg('--families')?.split(','), REFRESH = arg('--refresh-families')?.split(',');
const OUT = path.join(BATCH_DIR, arg('--out') ?? 'results.json'), RANDOM_TOP = 20, RANDOM_RUNS = 20, SEED = 20260923;
const t0 = Date.now(), log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`);
interface Results { started_at: string; evals: Record<string, { rows: BatchRow[]; warnings: string[]; engine: string; extra?: unknown; ms: number }>; errors: Record<string, string>; random: Record<string, unknown>; holdout: Record<string, unknown>; segments: Record<string, unknown>; finished_at?: string; elapsed_ms?: number }
const res: Results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { started_at: new Date().toISOString(), evals: {}, errors: {}, random: {}, holdout: {}, segments: {} };
const save = () => writeFileSync(OUT, JSON.stringify(res));
if (REFRESH) for (const k of Object.keys(res.evals)) if (REFRESH.includes(k.split(':')[0]!) && TFS.includes(k.split(':').at(-1)!)) { delete res.evals[k]; delete res.random[k]; delete res.random[k + '@screen5']; delete res.holdout[k]; delete res.holdout[k + '@screen5']; }
for (const tf of TFS) for (const m of ['spot', 'perp'] as const) res.segments[`${tf}:${m}`] = segmentsFor(tf, m);

// ---------- worker 池 ----------
const execArgv = ['--experimental-transform-types', '--no-warnings', '--import', new URL('../research-oracle/register.mjs', import.meta.url).href];
const pool = Array.from({ length: WORKERS }, () => ({ w: new Worker(new URL('./worker.ts', import.meta.url), { execArgv, resourceLimits: { maxOldGenerationSizeMb: 3072 } }), busy: false }));
let seq = 0; const waiters = new Map<number, (m: { ok: boolean; result?: unknown; error?: string }) => void>();
for (const p of pool) p.w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => { waiters.get(m.id)?.(m); waiters.delete(m.id); });
async function runAll<T>(tasks: { key: string; task: Task }[], onDone: (key: string, ok: boolean, r: T | string, ms: number) => void): Promise<void> {
  let next = 0, done = 0;
  await Promise.all(pool.map(async (p) => {
    while (next < tasks.length) {
      const { key, task } = tasks[next++]!, id = ++seq, s = Date.now();
      const m = await new Promise<{ ok: boolean; result?: unknown; error?: string }>((r) => { waiters.set(id, r); p.w.postMessage({ id, task }); });
      done++; onDone(key, m.ok, (m.ok ? m.result : m.error) as T | string, Date.now() - s);
      if (done % 10 === 0 || done === tasks.length) log(`${done}/${tasks.length}`);
    }
  }));
}

// ---------- A) 全部变体:训练 + 验证 ----------
const variants = allVariants(TFS).filter((v) => !res.evals[v.id] && (!FAMS || FAMS.includes(v.family)));
// 按周期、市场排,worker 的数据缓存能复用
variants.sort((a, b) => TFS.indexOf(a.timeframe) - TFS.indexOf(b.timeframe) || a.market.localeCompare(b.market) || a.id.localeCompare(b.id));
log(`变体 ${allVariants(TFS).length} 个,待跑 ${variants.length} 个,worker ${WORKERS}`);
let lastSave = Date.now();
await runAll<{ rows: BatchRow[]; warnings: string[]; engine: string; extra?: unknown }>(variants.map((v) => ({ key: v.id, task: { type: 'eval', variant: v } })), (key, ok, r, ms) => {
  if (ok) { res.evals[key] = { ...(r as { rows: BatchRow[]; warnings: string[]; engine: string }), ms }; delete res.errors[key]; } else { res.errors[key] = String(r).slice(0, 2000); log(`失败 ${key}: ${String(r).slice(0, 300)}`); }
  if (Date.now() - lastSave > 20000) { save(); lastSave = Date.now(); }
});
save();
if (process.argv.includes('--only-eval')) { for (const p of pool) await p.w.terminate(); log('只跑评估,结束'); process.exit(0); }

// ---------- B) 汇总 ----------
const byId = new Map<string, Variant>(allVariants(TFS).map((v) => [v.id, v]));
const rows = withGates(withDeflated(Object.values(res.evals).flatMap((e) => e.rows)));
const board = leaderboard(rows), champs = familyChampions(rows);
log(`行数 ${rows.length}(试验数),可落库 ${rows.filter((r) => r.promotable).length};每族冠军 ${[...champs.values()].map((r) => r.id).join(' / ')}`);

// ---------- C) 随机入场基线:验证段前 RANDOM_TOP + 每族冠军 ----------
const need = new Map<string, BatchRow>(); for (const r of board.slice(0, RANDOM_TOP)) need.set(r.id, r); for (const r of champs.values()) need.set(r.id, r);
const assetsOf = (r: BatchRow) => (r.scope === 'screen5' ? r.validation.members : undefined);
await runAll(([...need.values()].filter((r) => !res.random[r.id])).map((r) => ({ key: r.id, task: { type: 'random' as const, variant: byId.get(r.variant_id)!, runs: RANDOM_RUNS, seed: SEED, ...(assetsOf(r) ? { assets: assetsOf(r)! } : {}) } })), (key, ok, r) => { res.random[key] = ok ? r : { error: String(r).slice(0, 1000) }; });
save();
// ---------- D) 留出段:只给每族冠军,一次 ----------
await runAll([...champs.values()].filter((r) => !res.holdout[r.id]).map((r) => ({ key: r.id, task: { type: 'holdout' as const, variant: byId.get(r.variant_id)!, ...(r.scope === 'screen5' ? { assets: r.train.members } : {}) } })), (key, ok, r) => { res.holdout[key] = ok ? r : { error: String(r).slice(0, 1000) }; });
res.finished_at = new Date().toISOString(); res.elapsed_ms = Date.now() - Date.parse(res.started_at);
save();
writeFileSync(path.join(BATCH_DIR, 'summary.json'), JSON.stringify({ trials: rows.length, leaderboard: board, champions: Object.fromEntries([...champs].map(([f, r]) => [f, r.id])), random: res.random, holdout: res.holdout, segments: res.segments, errors: res.errors }, null, 1));
for (const p of pool) await p.w.terminate();
log('完成');
