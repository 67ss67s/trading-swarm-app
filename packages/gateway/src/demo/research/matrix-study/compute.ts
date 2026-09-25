/**
 * 试验账本 → 每个试验的 DSR / 门槛 / 判定 / 主因 → 每格结果 → 结论文本。纯函数(输入是已评估的试验记录)。
 * DSR 的试验数用谱系级 trial_count(跨 Study 去重、含每代每个新变体),方差取本 Study 全部可见试验选择段日夏普的方差;
 * 有效试验数只作敏感性报告,门槛只用保守值。
 */
import { hash } from '../primitives.js';
import { averageCorrelation, causeOf, dsrOf, effectiveByCorrelation, pairedDelta, selectionGates, sharpeVariance, verdictOf } from './stats.js';
import { FAILURE_CAUSES, type CellResult, type DevResult, type FailureCause, type GateRow, type MatrixCell, type MatrixConclusion, type MatrixFinalist, type MatrixManifest, type MatrixProtocol, type TrialLedger } from './types.js';

export interface TrialRec {
  trial_id: string; cell_id: string; variant_id: string; param: string; parent_trial_id: string | null; generation: number;
  config_hash: string; ir_hash: string; ir: import('@trading-swarm/contracts').StrategyIR; vol_target?: { annual: number; days: number };
  dev: DevResult | null; error: string | null; status: 'evaluated' | 'failed' | 'budget_skipped';
}
export interface JudgedTrial extends TrialRec { gates: GateRow[]; dsr: number | null; verdict: 'pass' | 'near' | 'fail'; cause: FailureCause | null }

const rankOf = (v: 'pass' | 'near' | 'fail') => (v === 'pass' ? 2 : v === 'near' ? 1 : 0);
/** 排序:判定(pass > near > fail)再选择段年化夏普,再 id(稳定) */
export const better = (a: JudgedTrial, b: JudgedTrial) => rankOf(b.verdict) - rankOf(a.verdict) || (b.dev?.selection.sharpe ?? -Infinity) - (a.dev?.selection.sharpe ?? -Infinity) || a.trial_id.localeCompare(b.trial_id);

export function failedCause(error: string | null): FailureCause {
  return error && /DATA_MISSING|data_missing|holdout_data_missing|segments_too_short|window_has_no_bars|too_short/.test(error) ? 'insufficient_evidence' : 'unsupported_execution';
}

export function judgeTrials(recs: TrialRec[], programTrials: number, p: MatrixProtocol): { trials: JudgedTrial[]; variance: number } {
  const visible = recs.filter((r) => r.dev);
  const V = sharpeVariance(visible.map((r) => r.dev!.selection.period_sharpe));
  const trials = recs.map((r): JudgedTrial => {
    if (!r.dev) return { ...r, gates: [], dsr: null, verdict: 'fail', cause: r.status === 'budget_skipped' ? 'insufficient_evidence' : failedCause(r.error) };
    const dsr = dsrOf(r.dev.selection, programTrials, V), gates = selectionGates(r.dev.selection, dsr, p);
    // 复审 High-2:判断大面积出错的试验是「判断不可用」,不能凭剩下的少数跟单成为 finalist / 过留出 / 被 adopt —— 放进正式门槛
    const j = r.dev.judge, er = j && j.candidates ? (j.error + j.uncertain) / j.candidates : null;
    if (er !== null) gates.push({ name: `judge_errors<=${JUDGE_ERROR_MAX * 100}%`, ok: er <= JUDGE_ERROR_MAX, value: er });
    const judgeBroken = er !== null && er > JUDGE_ERROR_MAX;
    const verdict = judgeBroken ? 'fail' : verdictOf(gates, r.dev.selection);
    return { ...r, gates, dsr, verdict, cause: verdict === 'pass' ? null : judgeBroken ? 'unsupported_execution' : causeOf(r.dev.selection, r.dev.selection_gross, gates) };
  });
  return { trials, variance: V };
}

export function ledgerOf(trials: JudgedTrial[], counts: { attempt_count: number; trial_count: number; study_trial_count: number }): TrialLedger {
  const vis = trials.filter((t) => t.dev);
  const rho = averageCorrelation(vis.map((t) => ({ days: t.dev!.selection_days, returns: t.dev!.selection_returns })));
  const byCell = new Set(vis.map((t) => t.cell_id)).size, byCorr = effectiveByCorrelation(counts.trial_count, rho);
  const best = [...vis].sort(better)[0];
  const V = sharpeVariance(vis.map((t) => t.dev!.selection.period_sharpe));
  const sens = best ? [counts.trial_count, byCell, byCorr].filter((x): x is number => x !== null).map((n) => ({ trials: Math.round(n * 100) / 100, dsr: dsrOf(best.dev!.selection, Math.max(1, Math.round(n)), V) })) : [];
  return { ...counts, effective_trials: { conservative: counts.trial_count, by_cell: byCell, by_correlation: byCorr, avg_correlation: rho }, dsr_sensitivity: sens };
}
export const ledgerHash = (l: TrialLedger, trials: JudgedTrial[]) => hash({ l: { attempt_count: l.attempt_count, trial_count: l.trial_count, study_trial_count: l.study_trial_count }, configs: trials.map((t) => t.config_hash).sort() });

/** 判断出错(error + uncertain)占候选的上限;超过即视为判断不可用 */
export const JUDGE_ERROR_MAX = 0.5;
export function cellResults(m: MatrixManifest, trials: JudgedTrial[], stopNote: string | null): Record<string, CellResult> {
  const out: Record<string, CellResult> = {}, byCell = new Map<string, JudgedTrial[]>();
  for (const t of trials) { const a = byCell.get(t.cell_id) ?? []; a.push(t); byCell.set(t.cell_id, a); }
  for (const c of m.cells) {
    if (c.applicability !== 'applicable') { out[c.id] = { cell_id: c.id, verdict: 'ineligible', cause: null, best_trial_id: null, selection: null, train: null, gates: [], dsr: null, evaluated: 0, judge_delta: null }; continue; }
    const ts = (byCell.get(c.id) ?? []).sort(better), best = ts[0];
    if (!best) { out[c.id] = { cell_id: c.id, verdict: 'fail', cause: 'insufficient_evidence', best_trial_id: null, selection: null, train: null, gates: [{ name: stopNote ?? 'not_evaluated', ok: false, value: null }], dsr: null, evaluated: 0, judge_delta: null }; continue; }
    out[c.id] = { cell_id: c.id, verdict: best.verdict, cause: best.cause, best_trial_id: best.trial_id, selection: best.dev?.selection ?? null, train: best.dev?.train ?? null, gates: best.gates, dsr: best.dsr, evaluated: ts.filter((t) => t.dev).length, judge_delta: null };
  }
  // code_judge 相对同格 code 臂:同一参数变体的选择段日收益配对差
  for (const c of m.cells) {
    if (c.arm !== 'code_judge' || c.applicability !== 'applicable') continue;
    const r = out[c.id]!, jb = trials.find((t) => t.trial_id === r.best_trial_id);
    const codeId = c.id.replace(/\|code_judge$/, '|code'), code = trials.find((t) => t.cell_id === codeId && t.generation === 0 && t.param === jb?.param && t.dev);
    if (!jb?.dev || !code?.dev) continue;
    const d = pairedDelta({ days: jb.dev.selection_days, returns: jb.dev.selection_returns }, { days: code.dev.selection_days, returns: code.dev.selection_returns }, m.spec.protocol);
    const j = jb.dev.judge, n = j?.candidates ?? 0;
    const error_ratio = j && n ? (j.error + j.uncertain) / n : null, all_skipped = !!(j && n && j.follow === 0);
    // 复审 Medium-13:全部跳过只说明「都不做」,后端就不给增量数字(不只前端隐藏);大面积出错的判定已在 judgeTrials 的正式门槛里
    const unusable = all_skipped || (error_ratio !== null && error_ratio > JUDGE_ERROR_MAX);
    r.judge_delta = { mean_daily: unusable ? null : d.mean, ci95: unusable ? null : d.ci95, kept_ratio: j && n ? j.follow / n : null, error_ratio, all_skipped };
  }
  return out;
}

const CAUSE_TEXT: Record<FailureCause, string> = { cost_dominated: '费用吃掉', insufficient_evidence: '样本不足', unsupported_execution: '执行不支持', underperform_hold: '跑输持有' };
export function conclusionOf(m: MatrixManifest, cells: Record<string, CellResult>, finalists: MatrixFinalist[]): MatrixConclusion {
  const causes = Object.fromEntries(FAILURE_CAUSES.map((c) => [c, 0])) as Record<FailureCause, number>;
  for (const r of Object.values(cells)) if (r.verdict !== 'ineligible' && r.verdict !== 'pass' && r.cause) causes[r.cause]++;
  for (const f of finalists) if (f.passed === false && f.cause) causes[f.cause]++;
  const na = m.cells.filter((c: MatrixCell) => c.applicability === 'not_applicable').length, ro = m.cells.filter((c) => c.applicability === 'research_only').length;
  const passed = finalists.filter((f) => f.passed === true), applicable = m.cells.length - na - ro;
  const dist = FAILURE_CAUSES.filter((c) => causes[c]).map((c) => `${CAUSE_TEXT[c]} ${causes[c]}`).join('、') || '无';
  const mode = m.spec.protocol.evidence_mode === 'historical_replay' ? '(历史回放:这段历史已被人看过,只能算回放证据,进实盘前还要前向验证)' : '';
  const famText = (fam: string) => { const my = (m.my_strategies ?? []).find((x) => `my:${x.strategy_id}@v${x.version}` === fam); return my ? `「${my.name}」v${my.version}` : fam; };
  const text = passed.length
    ? `${passed.length} 条策略在留出段通过 Holm 校正检验:${passed.map((f) => `${f.symbol} ${f.timeframe} ${famText(f.family)}/${f.side}/${f.arm}`).join(';')}。其余不合格主因:${dist}${mode}`
    : `没有找到通过门槛的策略。${applicable} 个可评估格子${finalists.length ? `、${finalists.length} 个 finalist 在留出段未通过` : ''};主因分布:${dist};另有 ${na} 格不适用、${ro} 格仅研究(3m/5m)${mode}`;
  return { kind: passed.length ? 'passed' : 'no_candidate', finalist_ids: passed.map((f) => f.id), causes, not_applicable: na, research_only: ro, text };
}
