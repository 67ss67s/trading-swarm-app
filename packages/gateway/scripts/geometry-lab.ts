// Geometry Lab (docs/research/geometry-lab-2026-09-23.md): who places a breakout's stop / target better?
//
//   npx jiti packages/gateway/scripts/geometry-lab.ts import   [--db <lab.sqlite>] [--source-db ~/.trade-gate-okx/demo/state.sqlite]
//   npx jiti packages/gateway/scripts/geometry-lab.ts run-a    [--db …]                       # candidates + arm A on everything (0 model calls)
//   npx jiti packages/gateway/scripts/geometry-lab.ts pilot    [--db …] --n 20 --arms B,C,D --max-calls 160 [--concurrency 4] [--model zai/glm-5.3]
//   npx jiti packages/gateway/scripts/geometry-lab.ts report   [--db …] [--md out.md] [--arms B,D]
//
// pilot extras: --max-cny <¥> hard-stops THIS invocation once its CJK-aware cost estimate (≥ the chars/3 meter) would
// pass the cap; --api-key-env <VAR> reads a provider key from that env var and hands it to pi as --api-key (never
// printed, never stored). 5 consecutive failed candidates stop the run (auth / rate limit: don't retry into the cap).
// Rows carry a `model` label (arm_results.model / model_calls.model); run separate lab DBs per model.
// `pilot` is resumable: candidate×arm rows already in the lab DB are skipped, and --max-calls caps the TOTAL
// model calls recorded in the lab DB (not per invocation). Scaling = rerun pilot with a larger --n and
// --max-calls (Jacky must approve the spend first; the report prints the projection).
// The live demo DBs are only ever opened read-only (import) and the lab DB refuses those paths.
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { piBrain } from '../src/demo/brain.js';
import { armA, findCandidates, futureAfter, pairedVsA, pilotSample, settlePlan, settleTrail, stopRule, summarizeArm, viewAt, type ArmRow, type ArmSummary, type Candidate, type Geometry } from '../src/demo/geometry-lab/core.js';
import { armB, armC, armD, BudgetExhausted, newCnyBudget, newMeter, type ModelCtx } from '../src/demo/geometry-lab/model-arms.js';
import { LabStore } from '../src/demo/geometry-lab/store.js';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'report';
const opt = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const DB = opt('db', '/tmp/trade-gate-scratch/geometry-lab.sqlite');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const store = new LabStore(DB);

function barsBySymbol() {
  return new Map(store.datasets().map((d) => [d.symbol, d.bars]));
}

function settleAndStore(c: Candidate, arm: string, g: Geometry, all: ReturnType<typeof barsBySymbol>, meter = newMeter(), extra: unknown = null, model: string | null = null) {
  const bars = all.get(c.symbol)!;
  const v = viewAt(c.symbol, bars, c.as_of);
  const fut = futureAfter(bars, c.as_of);
  store.putArm(c, arm, g, settlePlan(g, fut, c.atr14), settleTrail(g, v.bars, fut, c.atr14), meter, extra, model);
}

const MAX_CONSECUTIVE_FAILURES = 5;
/** returns why it stopped early (null = ran through) */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<string | null> {
  let i = 0;
  let stop: string | null = null;
  let failStreak = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length && !stop) {
        const x = items[i++]!;
        try {
          await fn(x);
          failStreak = 0;
        } catch (e) {
          if (e instanceof BudgetExhausted) stop = 'budget exhausted (calls or ¥)';
          else {
            console.error('candidate failed:', e instanceof Error ? e.message : e);
            if (++failStreak >= MAX_CONSECUTIVE_FAILURES) stop = `${failStreak} consecutive failures`;
          }
        }
      }
    }),
  );
  if (stop) console.error(`stopped: ${stop}`);
  return stop;
}

const f2 = (x: number | null, d = 2): string => (x === null || !Number.isFinite(x) ? '–' : x.toFixed(d));
const pc = (x: number | null): string => (x === null ? '–' : `${(x * 100).toFixed(0)}%`);

function summaryTable(rows: ArmSummary[]): string {
  const h = '| arm | var | n | inv | E[R] net | win | stop | tgt | trail | exp | stop ATR | <1ATR | tgt null | RR p10/p50/p90 | RR∈[1.3,1.7] | halluc | fallback | calls | tok | lat s | ¥ |';
  const s = '|' + '---|'.repeat(21);
  return [h, s, ...rows.map((r) => `| ${r.arm} | ${r.variant} | ${r.n} | ${r.invalid} | ${f2(r.exp_r, 3)} | ${pc(r.win_rate)} | ${pc(r.stop_hit)} | ${pc(r.target_hit)} | ${pc(r.trail_exit)} | ${pc(r.expired)} | ${f2(r.stop_atr_mean)} | ${pc(r.noise_stop_share)} | ${pc(r.target_null_share)} | ${f2(r.rr_p10)}/${f2(r.rr_p50)}/${f2(r.rr_p90)} | ${pc(r.rr_share_13_17)} | ${pc(r.hallucinated_rate)} | ${pc(r.fallback_rate)} | ${f2(r.calls_per, 1)} | ${f2(r.tokens_per, 0)} | ${f2(r.latency_s_per, 1)} | ${f2(r.cost_cny_per, 4)} |`)].join('\n');
}

async function main() {
  if (cmd === 'import') {
    const src = opt('source-db', join(homedir(), '.trade-gate-okx/demo/state.sqlite'));
    const got = store.importFrom(src, SYMBOLS);
    for (const d of got) console.log(`${d.symbol} ${d.bars.length} bars ${new Date(d.bars[0]!.open_time).toISOString()} → ${new Date(d.bars.at(-1)!.close_time + 1).toISOString()} (${d.source_id.slice(0, 12)})`);
    return;
  }
  const all = barsBySymbol();
  if (!all.size) throw new Error('no datasets in lab DB; run `import` first');
  if (cmd === 'run-a') {
    const cands = [...all].flatMap(([s, bars]) => findCandidates(s, bars));
    store.resetCandidates();
    store.putCandidates(cands);
    for (const c of cands) settleAndStore(c, 'A', armA(viewAt(c.symbol, all.get(c.symbol)!, c.as_of)), all);
    console.log(`candidates ${cands.length}; arm A settled on all`);
    return;
  }
  if (cmd === 'pilot') {
    const n = Number(opt('n', '20'));
    const arms = opt('arms', 'B,C,D').split(',');
    const [provider, model] = opt('model', 'zai/glm-5.3').split('/');
    const keyEnv = opt('api-key-env', '');
    const apiKey = keyEnv ? process.env[keyEnv]?.trim() : undefined;
    if (keyEnv && !apiKey) throw new Error(`--api-key-env ${keyEnv}: env var is empty`);
    const brain = piBrain({ provider: provider!, model: model!, ...(apiKey ? { apiKey } : {}) });
    const pilot = pilotSample(store.candidates(), n);
    const maxCny = Number(opt('max-cny', '0'));
    const budget: ModelCtx['budget'] = { used: store.modelCallCount(), max: Number(opt('max-calls', '160')), ...(maxCny > 0 ? { cny: newCnyBudget(maxCny) } : {}) };
    const run = { calls: 0, errors: 0, in_tok: 0, out_tok: 0, latency_ms: 0, started: Date.now() };
    console.log(`pilot ${pilot.length} candidates, arms ${arms}, brain ${brain.name}${apiKey ? ' (key from env)' : ''}, calls ${budget.used}/${budget.max}${budget.cny ? `, ¥ cap ${maxCny}` : ''}`);
    const spend = () => `run calls ${run.calls} (errors ${run.errors}), in ${run.in_tok} / out ${run.out_tok} tok, meter ¥${(budget.cny?.spent_meter ?? 0).toFixed(4)}, conservative ¥${(budget.cny?.spent ?? 0).toFixed(4)}, wall ${((Date.now() - run.started) / 1000).toFixed(0)}s`;
    for (const arm of arms) {
      const todo = pilot.filter((c) => !store.hasArm(c.id, arm));
      const stopped = await pool(todo, Number(opt('concurrency', '4')), async (c) => {
        const v = viewAt(c.symbol, all.get(c.symbol)!, c.as_of);
        const ctx: ModelCtx = {
          brain,
          budget,
          log: (e) => {
            run.calls++;
            if (e.error) run.errors++;
            run.in_tok += e.in_tok;
            run.out_tok += e.out_tok;
            run.latency_ms += e.latency_ms;
            store.logCall(c.id, e, brain.name);
          },
        };
        if (arm === 'B') {
          const r = await armB(v, ctx);
          settleAndStore(c, 'B', r.g, all, r.meter, null, brain.name);
        } else if (arm === 'C') {
          const r = await armC(v, ctx);
          settleAndStore(c, 'C', r.g, all, r.meter, { tool_calls: r.tool_calls, transcript: r.transcript }, brain.name);
        } else if (arm === 'D') {
          const r = await armD(v, ctx);
          settleAndStore(c, 'D', r.g, all, r.meter, { menu: r.menu }, brain.name);
        }
        console.log(`${arm} ${c.id} done (calls used ${budget.used}${budget.cny ? `, ¥ ${budget.cny.spent.toFixed(4)}/${maxCny}` : ''})`);
      });
      console.log(`arm ${arm} finished: ${spend()}`);
      if (stopped) break;
    }
    console.log(`RUN TOTAL ${brain.name}: ${spend()}`);
    return;
  }
  if (cmd === 'report') {
    const cands = store.candidates();
    const A = store.armRows('A');
    const out: string[] = [];
    const per = new Map<string, number>();
    for (const c of cands) per.set(c.symbol, (per.get(c.symbol) ?? 0) + 1);
    out.push(`candidates: ${cands.length} (${[...per].map(([s, k]) => `${s} ${k}`).join(', ')})`);
    out.push('\n### Arm A, full set\n');
    out.push(summaryTable([summarizeArm('A', 'plan', A), summarizeArm('A', 'trail', A)]));
    const model = opt('arms', 'B,C,D').split(',').map((a) => [a, store.armRows(a)] as const).filter(([, r]) => r.length);
    out.push(`\nrow labels: ${store.armModels().filter((m) => m.arm !== 'A').map((m) => `${m.arm}=${m.model ?? '(unlabelled)'}×${m.n}`).join(', ') || '(no model rows)'}`);
    if (model.length) {
      const ids = new Set(model.flatMap(([, r]) => r.map((x) => x.id)));
      const Ap = A.filter((r) => ids.has(r.id));
      out.push(`\n### Model arms vs A (same ${ids.size} candidates)\n`);
      const rows: ArmSummary[] = [];
      for (const v of ['plan', 'trail'] as const) {
        rows.push(summarizeArm('A', v, Ap));
        for (const [a, r] of model) rows.push(summarizeArm(a, v, r));
      }
      out.push(summaryTable(rows));
      out.push('\n### Paired: arm − A, net R per candidate (95% bootstrap CI, 5000 resamples)\n');
      out.push('| arm | var | n | mean Δ R | CI lo | CI hi | better / worse / same |\n|---|---|---|---|---|---|---|');
      for (const v of ['plan', 'trail'] as const) for (const [a, r] of model) {
        const p = pairedVsA(a, v, r as ArmRow[], Ap);
        out.push(`| ${a} | ${v} | ${p.n} | ${f2(p.mean, 3)} | ${f2(p.lo, 3)} | ${f2(p.hi, 3)} | ${p.better} / ${p.worse} / ${p.same} |`);
      }
      out.push('\n### Cost (measured) and projection for 100 candidates\n');
      out.push('| arm | n | calls | calls/cand | tokens/cand | latency s/cand | ¥/cand | ¥ per 100 | calls per 100 |\n|---|---|---|---|---|---|---|---|---|');
      let tot = 0;
      for (const [a, r] of model) {
        const calls = r.reduce((s, x) => s + x.calls, 0);
        const cny = r.reduce((s, x) => s + x.cost_cny, 0);
        const tok = r.reduce((s, x) => s + x.in_tok + x.out_tok, 0);
        const lat = r.reduce((s, x) => s + x.latency_ms, 0) / 1000;
        tot += (cny / r.length) * 100;
        out.push(`| ${a} | ${r.length} | ${calls} | ${f2(calls / r.length, 2)} | ${f2(tok / r.length, 0)} | ${f2(lat / r.length, 1)} | ${f2(cny / r.length, 4)} | ${f2((cny / r.length) * 100, 2)} | ${f2((calls / r.length) * 100, 0)} |`);
      }
      out.push(`\nProjected ${model.map(([a]) => a).join('+')} for 100 candidates: ¥${f2(tot, 2)} (token counts are the adapter's chars/3 estimate).`);
      out.push('\n### Usage totals (all stored rows, adapter meter)\n');
      out.push('| arm | n | calls | in tok | out tok | ¥ | latency s total | latency s/cand |\n|---|---|---|---|---|---|---|---|');
      for (const [a, r] of model) {
        const sum = (k: 'calls' | 'in_tok' | 'out_tok' | 'cost_cny' | 'latency_ms') => r.reduce((s, x) => s + x[k], 0);
        out.push(`| ${a} | ${r.length} | ${sum('calls')} | ${sum('in_tok')} | ${sum('out_tok')} | ${f2(sum('cost_cny'), 4)} | ${f2(sum('latency_ms') / 1000, 0)} | ${f2(sum('latency_ms') / 1000 / r.length, 1)} |`);
      }
    }
    // 止血 rule (zero model calls): refuse the trade when stop distance < k × ATR14 at decision time.
    out.push('\n### 止血 rule: reject when stop < k×ATR14 (rejected trades = 0R)\n');
    out.push('| set | arm | k | n | rejected | kept E[R] plan | rejected E[R] plan | kept E[R] trail | rejected E[R] trail | Δ vs no rule plan [CI] | Δ vs no rule trail [CI] |\n|---|---|---|---|---|---|---|---|---|---|---|');
    const ids = new Set(model.flatMap(([, r]) => r.map((x) => x.id)));
    const sets: [string, string, ArmRow[]][] = [['full', 'A', A], ...(model.length && ids.size < A.length ? ([['matched', 'A', A.filter((r) => ids.has(r.id))]] as [string, string, ArmRow[]][]) : []), ...model.map(([a, r]) => [`n=${r.length}`, a, r as ArmRow[]] as [string, string, ArmRow[]])];
    for (const [set, a, r] of sets) for (const k of [0.5, 0.75, 1.0]) {
      const s = stopRule(a, r, k);
      out.push(`| ${set} | ${a} | ${k} | ${s.n} | ${pc(s.rejected_share)} | ${f2(s.kept_plan, 3)} | ${f2(s.rejected_plan, 3)} | ${f2(s.kept_trail, 3)} | ${f2(s.rejected_trail, 3)} | ${f2(s.delta_plan.mean, 3)} [${f2(s.delta_plan.lo, 3)}, ${f2(s.delta_plan.hi, 3)}] | ${f2(s.delta_trail.mean, 3)} [${f2(s.delta_trail.lo, 3)}, ${f2(s.delta_trail.hi, 3)}] |`);
    }
    const text = out.join('\n');
    console.log(text);
    const md = opt('md', '');
    if (md) writeFileSync(md, text);
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => store.close());
