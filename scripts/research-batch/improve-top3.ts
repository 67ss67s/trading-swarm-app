/**
 * 把批量研究验证段排行榜前 3 名(单资产 IR 变体;组合族不是 IR,跳过并记下)各跑一次改进环(3 代,多步搜索开),零模型。
 * 独立进程、独立 scratch 库(~/.trading-swarm-okx/research-batch/improve.sqlite),数据来自批量研究冻结的 JSON(不联网),不写策略版本。
 * 资产池与周期 = 该行在批量研究里的资产池(整池或训练段筛出的 5 个);窗口 = 批量研究同一窗口(改进环自己按 50/25/25 切段,与批量研究同一实现)。
 * 波动率目标族在改进环里按单位仓位跑(改进环没有这个缩放层),报告里注明。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/improve-top3.ts [N=3]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openStateDb } from '../../packages/gateway/src/state-db.ts';
import { ImproveStore } from '../../packages/gateway/src/demo/research/improve/store.ts';
import { runImprovement } from '../../packages/gateway/src/demo/research/improve/runner.ts';
import { DEFAULT_BUDGET, DEFAULT_OBJECTIVE } from '../../packages/gateway/src/demo/research/improve/types.ts';
import { DEFAULT_GENERATORS } from '../../packages/gateway/src/demo/research/improve/generators/index.ts';
import { RANDOM_ENTRY_SEED } from '../../packages/gateway/src/demo/research/improve/random-entry.ts';
import { allVariants, type IrVariant } from '../../packages/gateway/src/demo/research/batch/families.ts';
import type { BatchRow } from '../../packages/gateway/src/demo/research/batch/study.ts';
import { BATCH_DIR, TO_MS, segmentsFor, frozenData } from './common.ts';
import { frozenLoader } from './loader.ts';

// 第二个参数 = 只跑第几名(0 起),三名可以分三个进程并行跑;结果写 improve-top3-<名次>.json
const N = Number(process.argv[2] ?? 3), ONLY = process.argv[3] === undefined ? null : Number(process.argv[3]), t0 = Date.now(), log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`);
const summary = JSON.parse(readFileSync(path.join(BATCH_DIR, 'summary.json'), 'utf8')) as { leaderboard: BatchRow[] };
const byId = new Map(allVariants().map((v) => [v.id, v]));
const picks: BatchRow[] = [], skipped: string[] = [];
for (const r of summary.leaderboard) { if (picks.length >= N) break; const v = byId.get(r.variant_id); if (v?.kind === 'ir') picks.push(r); else skipped.push(r.id); }
const db = openStateDb(path.join(BATCH_DIR, ONLY === null ? 'improve.sqlite' : `improve-${ONLY}.sqlite`)), jobs = new ImproveStore(db.db), out: unknown[] = [];
for (const [rank, r] of picks.entries()) {
  if (ONLY !== null && rank !== ONLY) continue;
  const v = byId.get(r.variant_id) as IrVariant, seg = segmentsFor(v.timeframe, v.market), step = frozenData(v.timeframe, v.market).data.timeframe_ms;
  const universe = r.scope === 'screen5' ? r.validation.members : frozenData(v.timeframe, v.market).data.universe;
  const job = jobs.createJob({ strategy_id: null, strategy_version: null, strategy_ir: v.ir, timeframe: v.timeframe, universe, from_ms: seg.train.from_ms - step + 1, to_ms: TO_MS, objective: { ...DEFAULT_OBJECTIVE, stability_penalty: 0.5 }, budget: { ...DEFAULT_BUDGET, generations: 3, wall_clock_ms: 90 * 60_000, allow_explore: true, patience: 2 }, generators: DEFAULT_GENERATORS, dataset_ids: null, random_entry_runs: 20, seed: RANDOM_ENTRY_SEED, write_version: false });
  log(`改进环 ${job.id} 起点 ${r.id}(验证夏普 ${r.validation.sharpe?.toFixed(2)},资产 ${universe.length} 个)`);
  const done = await runImprovement({ db: db.db, loader: frozenLoader(v.market), emit: (e) => { if (/generation|validate|holdout|done/.test(e.phase)) log(`  [${e.phase}] ${e.message.slice(0, 200)}`); } }, job.id);
  const cs = jobs.candidates(job.id);
  out.push({ start: r.id, vol_target_note: v.vol_target ? '改进环按单位仓位跑,没叠加波动率目标' : null, job_id: job.id, status: done.status, error: done.error, frozen_segments: (done.frozen as { segments?: unknown } | null)?.segments ?? null, progress: done.progress, ledger: done.ledger, result: done.result,
    candidates: cs.map((c) => ({ id: c.id, parent_id: c.parent_id, generation: c.generation, generator: c.generator, status: c.status, rationale: c.rationale.slice(0, 300), diff: c.diff, objective: c.evaluation?.objective ?? null, passed: c.evaluation?.passed ?? null, failed: c.evaluation?.gates.filter((g) => !g.ok).map((g) => g.name) ?? [], train: c.evaluation?.train ? { r: c.evaluation.train.total_return, s: c.evaluation.train.sharpe, n: c.evaluation.train.trades, emh: c.evaluation.train.exposure_matched_hold } : null, validation: c.evaluation?.validation ? { r: c.evaluation.validation.total_return, s: c.evaluation.validation.sharpe, n: c.evaluation.validation.trades } : null, holdout: c.evaluation?.holdout ? { r: c.evaluation.holdout.total_return, s: c.evaluation.holdout.sharpe, n: c.evaluation.holdout.trades, emh: c.evaluation.holdout.exposure_matched_hold, hold: c.evaluation.holdout.hold_return } : null })) });
  writeFileSync(path.join(BATCH_DIR, ONLY === null ? 'improve-top3.json' : `improve-top3-${ONLY}.json`), JSON.stringify({ skipped_portfolio_rows: skipped, jobs: out }, null, 1));
  log(`完成 ${job.id}:${done.status} ${done.result?.summary ?? done.error ?? ''}`);
}
db.close();
