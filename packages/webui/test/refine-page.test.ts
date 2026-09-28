/**
 * 「优化」页(#refine,pages/refine.tsx):地址栏解析、从一次海选里挑能精修的组合;以及默认语言是英文。
 */
import { describe, expect, it, vi } from 'vitest';
import type { CellResult, MatrixCellDef, MatrixStudyView } from '../src/api/matrix-study';
import { parseRefineRoute, refineCandidates, refineHash } from '../src/components/strategy-research/refine-model';

const def = (id: string, over: Partial<MatrixCellDef> = {}): MatrixCellDef => ({ id, symbol: 'SOLUSDT', timeframe: '4h', family: 'breakout', side: 'long', arm: 'code', applicability: 'applicable', reason: null, ...over });
const res = (id: string, over: Partial<CellResult> = {}): CellResult => ({
  cell_id: id, verdict: 'fail', cause: null, best_trial_id: `mt_${id}`, selection: { trades: 20, total_return: 0.01, sharpe: null, max_drawdown: 0.1, exposure: 0.5, expectancy: null, win_rate: null, stressed_return: null, hold_return: null, exposure_matched_hold: null },
  train: null, gates: [], dsr: null, evaluated: 1, judge_delta: null, ...over,
});
function study(cells: [MatrixCellDef, CellResult | null][]): MatrixStudyView {
  return {
    id: 'ms_1', status: 'completed', stage: 'done', created_at: 1, updated_at: 2, manifest_hash: 'h',
    manifest: { spec: { symbols: ['SOLUSDT'], timeframes: ['4h'], families: ['breakout'], market: 'perp', sides: ['long'], arms: ['code'], recommendation_id: null }, cells: cells.map(([d]) => d) },
    state: { stage: 'done', progress: { done: 1, total: 1, eta_ms: null, note: '' }, holdout_state: 'sealed', cells: Object.fromEntries(cells.filter(([, r]) => r).map(([d, r]) => [d.id, r!])), generations: [], finalists: [], conclusion: null, usage: { judge_calls: 0, judge_usd: '0', llm_calls: 0, llm_usd: '0', wall_ms: 0 }, stop_reason: null, notes: [], error: null },
    adoptions: {}, candidate_adoptions: {}, auto_finalize: true, my_strategies: [],
  };
}

describe('refine route', () => {
  it('needs both study and trial to bring a combo in', () => {
    expect(parseRefineRoute('#refine?study=ms_1&trial=mt_2')).toEqual({ study: 'ms_1', trial: 'mt_2', blank: false });
    expect(parseRefineRoute('#refine?study=ms_1')).toEqual({ study: null, trial: null, blank: false });
    expect(parseRefineRoute('#refine?blank=1')).toEqual({ study: null, trial: null, blank: true });
    expect(parseRefineRoute('#refine')).toEqual({ study: null, trial: null, blank: false });
  });
  it('round-trips through the hash', () => {
    expect(refineHash({ study: 'ms_1', trial: 'mt_2' })).toBe('refine?study=ms_1&trial=mt_2');
    expect(refineHash({ blank: true })).toBe('refine?blank=1');
    expect(refineHash({})).toBe('refine');
    expect(parseRefineRoute(`#${refineHash({ study: 'ms 1', trial: 'mt/2' })}`)).toMatchObject({ study: 'ms 1', trial: 'mt/2' });
  });
});

describe('refineCandidates', () => {
  it('ranks passed combos first, then candidates, then the rest by score; skips not-applicable, pending and trial-less cells', () => {
    const s = study([
      [def('a'), res('a', { verdict: 'fail' })],
      [def('b'), res('b', { tier: 'paper_candidate', tier_trial_id: 'mt_b2' })],
      [def('c'), res('c', { verdict: 'pass', tier: 'pass' })],
      [def('d', { applicability: 'not_applicable' }), res('d')],
      [def('e'), null],
      [def('f'), res('f', { best_trial_id: null })],
      [def('g'), res('g', { verdict: 'near' })],
      [def('h'), res('h', { verdict: 'fail', selection: { ...res('h').selection!, total_return: 0.2 } })],
    ]);
    const rows = refineCandidates(s);
    expect(rows.map((r) => r.def.id)).toEqual(['c', 'b', 'g', 'h', 'a']);
    expect(rows[1]!.trial).toBe('mt_b2');
    expect(rows[3]!.total_return).toBe(0.2);
  });
  it('honours the limit', () => {
    const cells = Array.from({ length: 20 }, (_, i) => [def(`x${i}`), res(`x${i}`)] as [MatrixCellDef, CellResult]);
    expect(refineCandidates(study(cells), 5)).toHaveLength(5);
  });
});

describe('default language', () => {
  it('is English when nothing is stored', async () => {
    vi.resetModules();
    const fresh = await import('../src/lib/i18n');
    expect(fresh.getLang()).toBe('en');
    expect(fresh.t('优化')).toBe('Refine');
    expect(fresh.t('OKX.AI')).toBe('OKX.AI');
  });
});
