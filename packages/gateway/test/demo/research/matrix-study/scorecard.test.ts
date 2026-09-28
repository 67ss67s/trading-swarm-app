// 批量验证 v2:评分卡复用 analyzer.score()、运气折扣、三档判定(只差样本 / 显著性才是候补;留出段不参与评分卡)。纯函数,零网络。
import { describe, expect, it } from 'vitest';
import { cagrOf, score } from '../../../../src/demo/research/analyzer.js';
import type { JudgedTrial } from '../../../../src/demo/research/matrix-study/compute.js';
import { conclusionOf } from '../../../../src/demo/research/matrix-study/compute.js';
import { scorecardOf, tierBoard, tierOf } from '../../../../src/demo/research/matrix-study/scorecard.js';
import { selectionGates } from '../../../../src/demo/research/matrix-study/stats.js';
import type { DevResult, MatrixFinalist, MatrixManifest, MatrixProtocol } from '../../../../src/demo/research/matrix-study/types.js';
import type { SlimScore } from '../../../../src/demo/research/batch/study.js';

const DAY = 86400000;
const P: MatrixProtocol = { version: 'matrix_v1', alpha: 0.025, min_trades: 30, block_days: 5, min_blocks: 20, bootstrap_replicates: 99, max_drawdown: 0.35, min_effect: 0, min_dsr: 0.95, seed: 1, evidence_mode: 'historical_replay', boundary: 'mtm_truncate_v1' };
const SEG = { train: { from_ms: 0, to_ms: 300 * DAY }, selection: { from_ms: 301 * DAY, to_ms: 421 * DAY } };

function slimOf(o: Partial<SlimScore> = {}): SlimScore {
  return { members: ['BTCUSDT'], trades: 8, total_return: 0.18, sharpe: 1.6, period_sharpe: 0.09, days: 120, skew: 0, kurtosis: 3, max_drawdown: 0.08, exposure: 0.3, expectancy: 0.02, win_rate: 0.6, stressed_return: 0.15, hold_return: -0.1, exposure_matched_hold: -0.03, btc_hold_return: -0.1, ...o };
}
function trialOf(o: { sel?: Partial<SlimScore>; train?: Partial<SlimScore>; dsr?: number | null; id?: string; cell?: string; pf?: number | null | undefined; judge?: DevResult['judge'] } = {}): JudgedTrial {
  const sel = slimOf(o.sel), dsr = o.dsr === undefined ? 0.02 : o.dsr;
  const returns = Array.from({ length: 120 }, (_, i) => (i % 3 === 0 ? -0.004 : 0.004));
  const dev: DevResult = { train: slimOf({ total_return: 0.3, trades: 20, ...o.train }), selection: sel, selection_returns: returns, selection_days: Array.from({ length: 121 }, (_, i) => 301 + i), selection_fees: 50, selection_gross: sel.total_return + 0.005, diagnosis: [], judge: o.judge ?? null, warnings: [], engine: 't', ...('pf' in o ? (o.pf === undefined ? {} : { selection_profit_factor: o.pf, train_profit_factor: 2 }) : { selection_profit_factor: 2.2, train_profit_factor: 2 }) };
  const gates = selectionGates(sel, dsr, P);
  const allOk = gates.every((g) => g.ok);
  return { trial_id: o.id ?? 'mt_a', cell_id: o.cell ?? 'c1', variant_id: 'v', param: 'p', parent_trial_id: null, generation: 0, config_hash: o.id ?? 'h', ir_hash: 'i', ir: {} as never, dev, error: null, status: 'evaluated', gates, dsr, verdict: allOk ? 'pass' : sel.expectancy! > 0 && sel.total_return > 0 ? 'near' : 'fail', cause: allOk ? null : gates.some((g) => g.name.startsWith('selection_trades') && !g.ok) ? 'insufficient_evidence' : 'underperform_hold' };
}
const COUNTS = { cell_trials: 3, study_trials: 40, program_trials: 120 };

describe('评分卡:复用研究台 analyzer.score()', () => {
  it('选择段喂成主指标、训练 / 选择段喂成样本内 / 样本外、同期持有作基准 —— 与直接调 score() 结果一致', () => {
    const t = trialOf(), card = scorecardOf(t, SEG, COUNTS, 0.01)!;
    const sel = t.dev!.selection, tr = t.dev!.train;
    const m = (s: SlimScore, w: { from_ms: number; to_ms: number }, pf: number | null) => ({ total_return: s.total_return, cagr: cagrOf(1, 1 + s.total_return, w.from_ms, w.to_ms), max_drawdown: s.max_drawdown, sharpe: s.sharpe, win_rate: s.win_rate, profit_factor: pf, expectancy: s.expectancy, trades: s.trades, excess_return: s.hold_return === null ? null : s.total_return - s.hold_return }) as never;
    const direct = score(m(sel, SEG.selection, 2.2), { in_sample: m(tr, SEG.train, 2), out_of_sample: m(sel, SEG.selection, 2.2) }, cagrOf(1, 1 + sel.hold_return!, SEG.selection.from_ms, SEG.selection.to_ms));
    expect(card.score).toEqual(direct);
    expect(['excellent', 'good', 'fair', 'needs_work', 'poor']).toContain(card.score.label);
    expect(card.score.confidence).toBe('low'); // 8 笔
    expect(card.metrics).toMatchObject({ total_return: 0.18, trades: 8, profit_factor: 2.2, hold_return: -0.1, exposure_matched_hold: -0.03, fees_pct: 50 / 10000 });
    expect(card.metrics.excess_vs_matched_hold).toBeCloseTo(0.21);
    expect(card.metrics.fee_share).toBeCloseTo(0.005 / 0.185);
    expect(card.segments).toEqual(['train', 'selection']);
  });
  it('旧评估没记盈亏因子:该分项按中性 50,并在 notes 写明', () => {
    const card = scorecardOf(trialOf({ pf: undefined }), SEG, COUNTS, 0.01)!;
    expect(card.score.components.find((c) => c.key === 'profit_factor')).toMatchObject({ value: 50 });
    expect(card.notes.join('')).toContain('盈亏因子');
    expect(card.metrics.profit_factor).toBeNull();
  });
  it('运气折扣:DSR 可用时 = 1 − DSR;不可用时按全谱系试验数 Bonferroni;试验数都记在卡上', () => {
    const a = scorecardOf(trialOf({ dsr: 0.2 }), SEG, COUNTS, 0.01)!.luck;
    expect(a).toMatchObject({ method: 'dsr', cell_trials: 3, study_trials: 40, program_trials: 120, dsr: 0.2 });
    expect(a.luck_probability).toBeCloseTo(0.8);
    expect(a.text).toContain('试了 120 个版本');
    expect(a.text).toContain('80%');
    const b = scorecardOf(trialOf({ dsr: null }), SEG, COUNTS, 0.01)!.luck;
    expect(b.method).toBe('bonferroni');
    expect(b.p_bonferroni).toBeCloseTo(Math.min(1, b.p_value! * 120));
    expect(b.luck_probability).toBe(b.p_bonferroni);
  });
});

describe('三档判定', () => {
  it('只差样本数 / 显著性 → 候补;原因写清楚', () => {
    const t = trialOf(), card = scorecardOf(t, SEG, COUNTS, 0.01)!;
    expect(t.gates.filter((g) => !g.ok).map((g) => g.name)).toEqual(['selection_trades>=30', 'deflated_sharpe>=0.95']);
    const r = tierOf(t, card, P, null);
    expect(r.tier).toBe('paper_candidate');
    expect(r.reasons.join(';')).toContain('平仓 8 笔');
  });
  it('样本不足之外还有别的问题 → 未通过(净收益 ≤ 0 / 跑输同敞口持有 / 回撤超限 / 2 倍费率为负 / 评分卡不够 / 执行不支持)', () => {
    const cases: Parameters<typeof trialOf>[0][] = [
      { sel: { total_return: -0.01, expectancy: -0.001 } },
      { sel: { exposure_matched_hold: 0.25 } },
      { sel: { max_drawdown: 0.4 } },
      { sel: { stressed_return: -0.01 } },
      { sel: { sharpe: -0.5, total_return: 0.001, expectancy: 0.0001, hold_return: 0.5, exposure_matched_hold: -0.5, max_drawdown: 0.3 }, pf: 0.6, train: { total_return: 0.4 } },
    ];
    for (const c of cases) {
      const t = trialOf(c), card = scorecardOf(t, SEG, COUNTS, 0.01)!;
      expect(tierOf(t, card, P, null).tier, JSON.stringify(c)).toBe('fail');
    }
    const broken = { ...trialOf(), cause: 'unsupported_execution' as const };
    expect(tierOf(broken, scorecardOf(broken, SEG, COUNTS, 0.01), P, null).tier).toBe('fail');
    const noDev = { ...trialOf(), dev: null, error: 'DATA_MISSING:no_bars' };
    expect(tierOf(noDev, null, P, null)).toMatchObject({ tier: 'fail' });
  });
  it('finalist:验收通过 = 通过;没过 = 未通过(同格其它变体也不能当候补);没验收 = 等验收;搜索没封存时选择段全过的记等验收', () => {
    const t = trialOf({ sel: { trades: 40 }, dsr: 0.99 }), card = scorecardOf(t, SEG, COUNTS, 0.01)!;
    expect(t.verdict).toBe('pass');
    const f = (passed: boolean | null) => ({ trial_id: t.trial_id, cell_id: 'c1', passed } as unknown as MatrixFinalist);
    expect(tierOf(t, card, P, f(true)).tier).toBe('pass');
    expect(tierOf(t, card, P, f(false)).tier).toBe('fail');
    expect(tierOf(t, card, P, f(null)).tier).toBe('pending');
    expect(tierOf(t, card, P, null).tier).toBe('paper_candidate'); // 选择段全过但没进名额
    expect(tierOf(t, card, P, null, false, false).tier).toBe('pending');
    expect(tierOf(trialOf(), card, P, null, true).tier).toBe('fail');
  });
});

describe('留出段不参与评分卡', () => {
  const manifest = { spec: { protocol: P }, cells: [
    { id: 'c1', applicability: 'applicable', segments: { ...SEG, holdout: { from_ms: 430 * DAY, to_ms: 500 * DAY } } },
    { id: 'c2', applicability: 'applicable', segments: { ...SEG, holdout: { from_ms: 430 * DAY, to_ms: 500 * DAY } } },
    { id: 'c3', applicability: 'not_applicable', segments: null },
  ] } as unknown as MatrixManifest;
  const trials = [trialOf({ id: 'mt_fin', cell: 'c1', sel: { trades: 40 }, dsr: 0.99 }), trialOf({ id: 'mt_cand', cell: 'c2' })];
  const fin = (holdout: Partial<SlimScore> | null, passed: boolean): MatrixFinalist => ({ id: 'mt_fin', trial_id: 'mt_fin', cell_id: 'c1', holdout: holdout ? slimOf(holdout) : null, passed } as unknown as MatrixFinalist);
  it('换掉留出成绩,评分卡逐字不变;评分卡里没有任何留出字段', () => {
    const a = tierBoard(manifest, [fin({ total_return: 0.9, trades: 99 }, true)], trials, { study_trials: 2, program_trials: 2 }, 0.01);
    const b = tierBoard(manifest, [fin({ total_return: -0.7, trades: 1, max_drawdown: 0.9 }, true)], trials, { study_trials: 2, program_trials: 2 }, 0.01);
    expect(a.cells['c1']!.scorecard).toEqual(b.cells['c1']!.scorecard);
    expect(a.cells['c2']!.scorecard).toEqual(b.cells['c2']!.scorecard);
    expect(JSON.stringify(a.cells)).not.toMatch(/holdout/);
    expect(a.cells['c1']!.scorecard!.metrics.total_return).toBe(0.18);
  });
  it('每格取最高档;候补计数进结论,kind 不变', () => {
    const b = tierBoard(manifest, [fin(null, true)], trials, { study_trials: 2, program_trials: 2 }, 0.01);
    expect(b.cells['c1']!.tier).toBe('pass');
    expect(b.cells['c2']).toMatchObject({ tier: 'paper_candidate', tier_trial_id: 'mt_cand' });
    expect(b.cells['c3']!.tier).toBe('ineligible');
    expect(b.candidate_trial_ids).toEqual(['mt_cand']);
    expect(b.tiers).toMatchObject({ pass: 1, paper_candidate: 1, ineligible: 1 });
    const m2 = { ...manifest, spec: { ...manifest.spec, protocol: P }, my_strategies: [] } as unknown as MatrixManifest;
    const none = conclusionOf(m2, {}, [], { candidate_trial_ids: ['mt_cand'], tiers: b.tiers });
    expect(none.kind).toBe('no_candidate');
    expect(none.paper_candidates).toBe(1);
    expect(none.text).toContain('有 1 组值得先用模拟盘看看');
    expect(none.text).toContain('候补不算通过');
    const v1 = conclusionOf(m2, {}, []);
    expect(v1.paper_candidates).toBeUndefined();
    expect(v1.text).toContain('没有找到通过门槛的策略');
  });
});
