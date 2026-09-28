import { expect, it } from 'vitest';
import type { StrategyIR } from '@trade-gate/contracts';
import { openStateDb } from '../../../../src/state-db.js';
import type { AssetExecutor } from '../../../../src/demo/research/backtest-report.js';
import { buildManifest, manifestHash } from '../../../../src/demo/research/matrix-study/manifest.js';
import { normalizeSpec } from '../../../../src/demo/research/matrix-study/spec.js';
import { MatrixStudyStore } from '../../../../src/demo/research/matrix-study/store.js';
import { judgeRuntimeFor, loadDevView } from '../../../../src/demo/research/matrix-study/evaluate.js';
import { runMatrix } from '../../../../src/demo/research/matrix-study/search.js';
import { PROFILE, TO_MS, baseSpec, edgeExecutor, loader, stubProvider } from './fixtures.js';

// 测试评估流程，不把合成执行器的收益解释为交易效果。
async function exercise(selection_marker: number) {
  const state = openStateDb(':memory:');
  try {
    const spec = normalizeSpec(baseSpec({
      symbols: ['BTCUSDT'], arms: ['code_judge'], model_profile: PROFILE,
      iterate: { generations: 0 },
      judge_templates: [
        { templates: ['take', 'quality'] },
        { templates: ['take'], rule: { all: [{ question_key: 'take', label: 'yes', operator: 'gte', threshold: 0.8, margin: 0.02 }] } },
      ],
    }), { now: TO_MS + 86400000 });
    const manifest = buildManifest(spec, null, TO_MS + 86400000);
    const cell = manifest.cells.find(c => c.applicability === 'applicable')!;
    // 一个基础策略 × 两个组合；二者必须各登记一次试验。
    cell.variants = cell.variants.slice(0, 2);
    manifest.cells = [cell];
    const g = cell.segments!;
    const store = new MatrixStudyStore(state.db);
    const row = store.insert({ idempotency_key: 'template-regression', manifest, manifest_hash: manifestHash(manifest) });
    const view = await loadDevView(state.db, manifest, '4h', { loader: loader() });
    for (const asset of view.data.assets) asset.bars = asset.bars.map(b => b.close_time > g.train.to_ms
      ? { ...b, open: String(selection_marker), high: String(selection_marker + 1), low: String(selection_marker - 1), close: String(selection_marker) }
      : b);
    const executions: { training: boolean; last_bar: number; templates: string }[] = [];
    const executorFor: (ir: StrategyIR) => AssetExecutor = ir => async x => {
      const training = x.to_ms <= g.train.to_ms;
      executions.push({ training, last_bar: x.dataset.bars.at(-1)!.close_time, templates: ir.judge!.questions.map(q => q.key).join(',') });
      // 训练期 take+quality 更优；选择期标记反转时收益排序也反转。
      const preferred = ir.judge!.questions.length === 2;
      const edge = training ? (preferred ? 0.008 : 0.003) : selection_marker > 500 ? -0.02 : 0.01;
      return edgeExecutor(edge)(ir)(x);
    };
    const context = {
      store, row, views: new Map([['4h', view]]), check: () => {}, overBudget: () => null,
      executorFor, judge: judgeRuntimeFor(state.db, row, { provider: stubProvider() }), onTrial: () => {},
    };
    const trials = await runMatrix(context);
    const winners = trials.filter(t => t.dev !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.ir.judge!.questions.map(q => q.key)).toEqual(['take', 'quality']);
    expect(store.studyTrialCount(row.id)).toBe(2);
    expect(store.programTrialCount(row.research_program_id)).toBe(2);
    expect(store.attemptCount(row.id)).toBe(3); // 2 次训练 + 胜者 1 次开发评估。
    expect(executions.filter(x => x.training)).toHaveLength(4); // 每次含费用压力场景。
    expect(executions.filter(x => x.training).every(x => x.last_bar <= g.train.to_ms)).toBe(true);
    expect(executions.filter(x => !x.training).map(x => x.templates)).toEqual(['take,quality', 'take,quality']);
    const calls = executions.length;
    const resumed = await runMatrix(context);
    expect(executions).toHaveLength(calls);
    expect(store.studyTrialCount(row.id)).toBe(2);
    expect(store.attemptCount(row.id)).toBe(3);
    expect(resumed.filter(t => t.dev !== null).map(t => t.config_hash)).toEqual(winners.map(t => t.config_hash));
    return { winner: winners[0]!.ir.judge, selection_return: winners[0]!.dev!.selection.total_return };
  } finally { state.close(); }
}

it('模板组合仅以训练段选择，每组合进入 trial_count，改变选择段也不换组合，恢复不重跑', async () => {
  const up = await exercise(100), down = await exercise(1000);
  expect(up.winner).toEqual(down.winner);
  expect(up.selection_return).not.toEqual(down.selection_return);
}, 30000);
