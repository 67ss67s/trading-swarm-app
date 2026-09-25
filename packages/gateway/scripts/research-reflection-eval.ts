// 复盘 skill 真模型基线(skills/research-reflection):拿 09-23 的真实回测报告夹具,走研究 loop 真实的
// diagnose_backtest → compose_answer 代码路径(内存库,不碰 18811),用真模型写复盘回答,打印原始输出与过滤后的答案。
// 每个案例 1 次模型调用;--max 控制上限(默认 3)。
//   npx jiti packages/gateway/scripts/research-reflection-eval.ts [--model zai/glm-5.3] [--max 3] [--only 4d23af81,7f53fe31]
import { readFileSync } from 'node:fs';
import type { BacktestReport } from '@trading-swarm/contracts';
import { piBrain, type Brain } from '../src/demo/brain.js';
import { openStateDb } from '../src/state-db.js';
import { LoopStore, DEFAULT_BUDGET } from '../src/demo/research/loop/store.js';
import { Budget } from '../src/demo/research/loop/budget.js';
import { createToolRegistry, type ToolContext } from '../src/demo/research/loop/tools.js';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const MAX = Number(arg('--max') ?? 3), only = arg('--only')?.split(',');
const CASES: { short: string; question: string; report: BacktestReport }[] = JSON.parse(readFileSync(new URL('../test/demo/research/loop/fixtures/reflection-reports.json', import.meta.url), 'utf8'));
// 每个案例:模式(diagnose = 选中回测后追问;validate = 回测完成后的首答)与追问原话
const PLAN: { short: string; mode: 'diagnose' | 'validate'; ask: string }[] = [
  { short: '4d23af81', mode: 'diagnose', ask: '为什么比持有差这么多?' },
  { short: '7f53fe31', mode: 'diagnose', ask: '这个结果可信吗?为什么会亏?' },
  { short: 'c7b8d3c1', mode: 'validate', ask: '' },
];

async function one(p: (typeof PLAN)[number], brain: Brain) {
  const c = CASES.find((x) => x.short === p.short)!;
  const db = openStateDb(':memory:');
  try {
    const store = new LoopStore(db.db), session = store.createSession().id;
    const origin = store.createInquiry(p.mode === 'diagnose' ? store.createSession().id : session, c.question, 'origin').inquiry;
    const report: BacktestReport = { ...c.report, inquiry_id: origin.id, run_ids: ['run_x'] };
    let q = p.mode === 'diagnose' ? store.createInquiry(session, p.ask, 'follow').inquiry : origin;
    if (p.mode === 'diagnose') q = store.updateInquiry(q.id, { task_kind: 'diagnose' });
    const research = { db: { prepare: () => ({ get: (id: string) => (id === report.id ? { report_json: JSON.stringify(report) } : undefined), all: () => [] }) } };
    const raw: string[] = [];
    const recording: Brain = { name: brain.name, complete: async (s, u, o) => { const r = await brain.complete(s, u, o); raw.push(r.text); return r; } };
    const ctx: ToolContext = { inquiry_id: q.id, step_id: 'eval', signal: new AbortController().signal, store, budget: new Budget(DEFAULT_BUDGET), now: Date.now, market: {} as never, backtests: { store: research, comparison: () => ({ report, snapshot_refs: [] }) } as never };
    const registry = createToolRegistry();
    let steps: Record<string, unknown>[], ids: string[];
    if (p.mode === 'diagnose') {
      const d = await registry.call('diagnose_backtest', { run_id: 'run_x', arm: 'a_rules' }, ctx);
      if (d.status !== 'ok') throw Error('diagnose failed ' + JSON.stringify(d));
      steps = [{ tool: 'diagnose_backtest', result: d }]; ids = d.artifact_refs;
    } else {
      const m = report.assets.find((a) => a.key === report.primary_key)!.metrics!;
      const table = store.putArtifact({ inquiry_id: q.id, kind: 'table', title: report.title, question: q.question, snapshot_refs: [], data_kind: 'derived', availability: 'available', spec: { type: 'table' }, caption: '', content: { kind: 'table', columns: [], rows: [], view: 'backtest_report', report_id: report.id, analysis: { observation: `${report.title}:净收益 ${(m.total_return * 100).toFixed(2)}%,同窗口持有 ${((m.benchmark_return ?? 0) * 100).toFixed(2)}%,${m.trades} 笔平仓` }, metrics: {} }, run_id: 'run_x' }).id;
      steps = [{ tool: 'run_backtest', result: { status: 'ok', output: { run_id: 'run_x' }, snapshot_refs: [], artifact_refs: [table], warnings: [], latency_ms: 0 } }]; ids = [table];
    }
    store.updateInquiry(q.id, { checkpoint: { ...store.inquiry(q.id).checkpoint, artifact_refs: ids } });
    ctx.brain = recording;
    const started = Date.now();
    const r = await registry.call('compose_answer', { question: q.question, steps, artifact_ids: ids, metrics: {} }, ctx);
    const blocks = (r.output as { blocks: { kind: string; text?: string }[] } | null)?.blocks ?? [];
    return { short: p.short, mode: p.mode, question: q.question, latency_ms: Date.now() - started, warnings: r.warnings, raw: raw[0] ?? null, answer: blocks.filter((b) => b.kind === 'text').map((b) => b.text) };
  } finally { db.close(); }
}

const brain = piBrain(arg('--model') ? { model: arg('--model')! } : {});
let calls = 0;
for (const p of PLAN.filter((x) => !only || only.includes(x.short))) {
  if (calls >= MAX) break;
  calls++;
  const out = await one(p, brain);
  console.log(JSON.stringify(out, null, 2));
}
console.error(`model calls: ${calls} (${brain.name})`);
