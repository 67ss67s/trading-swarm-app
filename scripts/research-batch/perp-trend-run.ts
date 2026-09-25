/**
 * 4h 永续均线趋势 · 杠杆 × 组合仓位研究主进程(零模型;报告 docs/research/perp-trend-portfolio-2026-09-23.md)。
 *
 * 预先声明(跑之前写死,不事后挑):
 *   信号 = 批量研究两条永续 4h 均线趋势变体 ma_trend:ema20_100_vt / ema50_200_vt(EMA 快线在慢线上方入场、下穿离场、ATR×3 灾难止损);
 *   杠杆 L ∈ {1, 2, 3}(逐仓,标记价判强平,维持保证金分档取当前值);
 *   仓位 ∈ {equal 等权 1/N, equal_vt 等权 × min(1, 50%/σ20d), inv_vol 等风险 (1/σ20d)/Σ(1/σ20d)},共享 $10k 资金账户;
 *   共 2 × 3 × 3 = 18 个配置。切段 = 批量研究 makeSegments(永续 4h:训练 2020-02→2023-05 / 验证 2023-05→2025-01 / 留出 2025-01→2026-09),每段独立跑。
 *   选择规则(只看训练段):训练段回撤(4h 收盘逐点)≤ 35% 且 ≥ 30 笔的配置里取训练段总收益最高;都不过则取回撤最小。
 *   验证段:18 个配置各看一次(含随机入场基线 20 次);留出段:只给选中的那一个配置跑一次(含它自己的随机入场基线)。
 * 结果写 ~/.trading-swarm-okx/research-batch/perp-trend/results.json(可断点续跑;留出段已存在则不再跑)。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/perp-trend-run.ts [--workers 2]
 */
import { Worker } from 'node:worker_threads';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { selectConfig, type Sizing } from '../../packages/gateway/src/demo/research/batch/perp-trend.ts';
import { BATCH_DIR, segmentsFor } from './common.ts';
import { SIGNALS, LEVERAGES, SIZINGS, type Task } from './perp-trend-worker.ts';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const WORKERS = Number(arg('--workers') ?? 2), RUNS = 20, SEED = 20260923, OUT = path.join(BATCH_DIR, 'perp-trend', 'results.json');
const t0 = Date.now(), log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`);
type R = { started_at: string; segments: unknown; main: Record<string, any>; random: Record<string, any>; check: Record<string, any>; selection?: any; holdout?: any; holdout_random?: any; errors: Record<string, string>; finished_at?: string };
const res: R = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { started_at: new Date().toISOString(), segments: segmentsFor('4h', 'perp'), main: {}, random: {}, check: {}, errors: {} };
const save = () => writeFileSync(OUT, JSON.stringify(res));

const execArgv = ['--experimental-transform-types', '--no-warnings', '--import', new URL('../research-oracle/register.mjs', import.meta.url).href];
const pool = Array.from({ length: WORKERS }, () => new Worker(new URL('./perp-trend-worker.ts', import.meta.url), { execArgv, resourceLimits: { maxOldGenerationSizeMb: 3072 } }));
let seq = 0; const waiters = new Map<number, (m: { ok: boolean; result?: unknown; error?: string }) => void>();
for (const w of pool) w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => { waiters.get(m.id)?.(m); waiters.delete(m.id); });
async function runAll(tasks: { key: string; task: Task; into: (r: any) => void }[]) {
  let next = 0;
  await Promise.all(pool.map(async (w) => {
    while (next < tasks.length) {
      const { key, task, into } = tasks[next++]!, id = ++seq, s = Date.now();
      const m = await new Promise<{ ok: boolean; result?: unknown; error?: string }>((r) => { waiters.set(id, r); w.postMessage({ id, task }); });
      if (m.ok) { into(m.result); delete res.errors[key]; } else { res.errors[key] = String(m.error).slice(0, 2000); log(`失败 ${key}: ${String(m.error).slice(0, 400)}`); }
      log(`${key} ${((Date.now() - s) / 1000).toFixed(0)}s`); save();
    }
  }));
}

// A) 复现校验 + 训练/验证段主跑(6 个 信号×杠杆,每个出三种仓位)
const tasks: { key: string; task: Task; into: (r: any) => void }[] = [];
for (const s of SIGNALS) if (!res.check[s]) tasks.push({ key: `check:${s}`, task: { type: 'check', signal: s }, into: (r) => { res.check[s] = r; } });
for (const seg of ['train', 'validation'] as const) for (const s of SIGNALS) for (const L of LEVERAGES) { const k = `${s}:x${L}:${seg}`; if (!res.main[k]) tasks.push({ key: k, task: { type: 'main', signal: s, lev: L, seg }, into: (r) => { res.main[k] = r; } }); }
// B) 验证段随机入场基线
for (const s of SIGNALS) for (const L of LEVERAGES) { const k = `${s}:x${L}:validation`; if (!res.random[k]) tasks.push({ key: 'random:' + k, task: { type: 'random', signal: s, lev: L, seg: 'validation', runs: RUNS, seed: SEED }, into: (r) => { res.random[k] = r; } }); }
await runAll(tasks);

// C) 只看训练段选一个配置
const rows = SIGNALS.flatMap((s) => LEVERAGES.flatMap((L) => SIZINGS.map((sz) => { const m = res.main[`${s}:x${L}:train`]?.results?.[sz]; return m ? { id: `${s}:x${L}:${sz}`, signal: s, lev: L, sizing: sz, train: { total_return: m.total_return, max_drawdown: m.max_drawdown, trades: m.trades.closed } } : null; }).filter(Boolean))) as { id: string; signal: string; lev: number; sizing: Sizing; train: { total_return: number; max_drawdown: number; trades: number } }[];
if (rows.length !== 18) { log(`训练段结果不全(${rows.length}/18),不做选择`); for (const w of pool) await w.terminate(); process.exit(1); }
const sel = selectConfig(rows);
res.selection ??= { rule: sel.rule, passed: sel.passed, pick: sel.pick, selected_at: new Date().toISOString() };
save(); log(`选中 ${res.selection.pick.id}(${res.selection.rule})`);

// D) 留出段:只跑选中的配置一次(含随机入场基线)
const pk = res.selection.pick as { signal: string; lev: number; sizing: Sizing };
const hold: { key: string; task: Task; into: (r: any) => void }[] = [];
if (!res.holdout) hold.push({ key: 'holdout', task: { type: 'main', signal: pk.signal, lev: pk.lev, seg: 'holdout', sizings: [pk.sizing] }, into: (r) => { res.holdout = r; } });
if (!res.holdout_random) hold.push({ key: 'holdout_random', task: { type: 'random', signal: pk.signal, lev: pk.lev, seg: 'holdout', runs: RUNS, seed: SEED, sizings: [pk.sizing] }, into: (r) => { res.holdout_random = r; } });
await runAll(hold);
res.finished_at = new Date().toISOString(); save();
for (const w of pool) await w.terminate();
log('完成 → ' + OUT);
