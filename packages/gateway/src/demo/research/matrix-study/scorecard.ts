/**
 * 批量验证 v2:每格评分卡 + 运气折扣 + 三档判定(设计 docs/design/batch-validation-v2-2026-09-25.md)。纯函数。
 *
 * 评分卡口径:直接复用研究台 / 我的策略的 research/analyzer.ts `score()`(BacktestScore:0-100 + score_label
 *   excellent/good/fair/needs_work/poor,六个分项与权重不变),把「选择段」指标喂成主指标、训练段 / 选择段喂成样本内 / 样本外,
 *   基准用同期持有(与研究台 benchmark_return 同义);同敞口持有、手续费占比、2 倍费率另列在卡上。
 *   旧评估没记录盈亏因子时,profit_factor 分项按中性 50 计(与 score() 对缺基准 / 缺分段的处理同法),并在 notes 里写明。
 * 留出段一律不进评分卡:入参只有训练段 / 选择段的 SlimScore 与选择段日收益,类型上就拿不到 holdout。
 *
 * 运气折扣:优先用正式门槛同口径的 Deflated Sharpe(全谱系 trial_count + 本研究选择段夏普方差),另报只按本格试验数的 DSR;
 *   DSR 不可用时按选择段日收益单侧 t 检验 p × 全谱系试验数做 Bonferroni。
 *
 * 三档:
 *   pass            = 原门槛全过 + 最终验收通过(不变);
 *   pending         = 选择段全过、在最终验收名单里,还没验收;
 *   paper_candidate = 候补 · 可纸面观察:选择段净收益 > 0、跑赢同敞口持有、回撤在门槛内、评分卡 ≥ fair、没有执行不支持 / 数据缺失,
 *                     没过的门槛只有样本数(笔数 / 时间块)和 / 或显著性(DSR);选择段全过但没进最终验收名额的也算候补;
 *   fail            = 其余(含最终验收没过的 finalist,以及同格 finalist 最终验收没过时的同格其它变体 —— 留出结果只能否决,不能加分)。
 */
import type { BacktestMetrics, BacktestScore } from '@trade-gate/contracts';
import { cagrOf, score, scoreLabel } from '../analyzer.js';
import { mean, normCdf, stdev } from '../improve/stats.js';
import { POOL_CASH } from '../improve/evaluate.js';
import type { SlimScore } from '../batch/study.js';
import type { JudgedTrial } from './compute.js';
import { dsrOf } from './stats.js';
import { MATRIX_TIERS, type LuckDiscount, type MatrixFinalist, type MatrixManifest, type MatrixProtocol, type MatrixScorecard, type MatrixTier, type MatrixWindow } from './types.js';

export const SCORECARD_VERSION = 'matrix_scorecard_v1' as const;
/** 候补允许没过的门槛:样本数(平仓笔数 / 时间块)与统计显著性(DSR) */
export const SAMPLE_GATE = /^selection_(trades|blocks)>=/;
export const SIGNIFICANCE_GATE = /^deflated_sharpe>=/;
const OK_LABELS = new Set<BacktestScore['label']>(['excellent', 'good', 'fair']);
const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);

function metricsOf(s: SlimScore, w: MatrixWindow, pf: number | null): BacktestMetrics {
  const cagr = cagrOf(1, 1 + s.total_return, w.from_ms, w.to_ms);
  return {
    total_return: s.total_return, cagr, max_drawdown: s.max_drawdown, sharpe: s.sharpe, sortino: null, calmar: cagr !== null && s.max_drawdown > 0 ? cagr / s.max_drawdown : null, volatility: null,
    win_rate: s.win_rate, profit_factor: pf, avg_win: null, avg_loss: null, risk_reward: null, expectancy: s.expectancy, max_win_streak: 0, max_loss_streak: 0, time_in_drawdown: 0, max_drawdown_duration_ms: 0,
    trades: s.trades, exposure: s.exposure, avg_holding_ms: null, best_trade: null, worst_trade: null, net_pnl: s.total_return * POOL_CASH, fees: 0,
    benchmark_return: s.hold_return, excess_return: s.hold_return === null ? null : s.total_return - s.hold_return, alpha: null, beta: null,
  } as BacktestMetrics;
}

/** 选择段日收益均值 > 0 的单侧检验 p(正态近似);样本 < 2 或零波动 → null */
export function oneSidedP(r: number[]): number | null {
  if (r.length < 2) return null;
  const sd = stdev(r);
  if (!(sd > 0)) return null;
  return 1 - normCdf((mean(r) / sd) * Math.sqrt(r.length));
}

export interface TrialCounts { cell_trials: number; study_trials: number; program_trials: number }
export function luckOf(t: JudgedTrial, counts: TrialCounts, sharpeVariance: number): LuckDiscount {
  const sel = t.dev!.selection, dsr = t.dsr, dsr_cell = dsrOf(sel, Math.max(1, counts.cell_trials), sharpeVariance);
  const p = oneSidedP(t.dev!.selection_returns), pb = p === null ? null : Math.min(1, p * Math.max(1, counts.program_trials));
  const method: LuckDiscount['method'] = dsr !== null ? 'dsr' : pb !== null ? 'bonferroni' : 'unavailable';
  const luck = dsr !== null ? 1 - dsr : pb;
  const head = `试了 ${counts.program_trials} 个版本(本格 ${counts.cell_trials} 个、这次研究 ${counts.study_trials} 个)`;
  const text = luck === null
    ? `${head};选择段样本太少,算不出运气折扣,先当它是运气`
    : `${head};按这么多次试验折算,这组选择段成绩约 ${pct(luck, 0)} 的可能是运气${luck >= 0.5 ? ',更像碰巧 —— 先用模拟盘看前向表现' : ''}${method === 'bonferroni' ? '(DSR 不可用,按试验数做 Bonferroni)' : ''}`;
  return { method, cell_trials: counts.cell_trials, study_trials: counts.study_trials, program_trials: counts.program_trials, dsr, dsr_cell, p_value: p, p_bonferroni: pb, luck_probability: luck, text };
}

/** 一个试验的评分卡(只读训练段 + 选择段) */
export function scorecardOf(t: JudgedTrial, seg: { train: MatrixWindow; selection: MatrixWindow }, counts: TrialCounts, sharpeVariance: number): MatrixScorecard | null {
  const d = t.dev;
  if (!d) return null;
  const notes: string[] = [];
  const pfKnown = d.selection_profit_factor !== undefined;
  const sel = metricsOf(d.selection, seg.selection, d.selection_profit_factor ?? null), tr = metricsOf(d.train, seg.train, d.train_profit_factor ?? null);
  const benchCagr = d.selection.hold_return === null ? null : cagrOf(1, 1 + d.selection.hold_return, seg.selection.from_ms, seg.selection.to_ms);
  let sc = score(sel, { in_sample: tr, out_of_sample: sel }, benchCagr);
  if (!pfKnown && sel.trades > 0) {
    // 旧评估没记录盈亏因子:该分项按中性 50(同 score() 对缺基准 / 缺分段的处理),其余分项不动
    const components = sc.components.map((c) => (c.key === 'profit_factor' ? { ...c, value: 50, note: '旧评估未记录盈亏因子,按中性计' } : c)) as BacktestScore['components'];
    const value = Math.max(0, Math.min(100, Math.round(components.reduce((a, c) => a + c.value * c.weight, 0))));
    sc = { ...sc, value, label: scoreLabel(value), components };
    notes.push('这次研究跑在 v2 之前,盈亏因子没有记录,评分里该项按中性计');
  }
  const s = d.selection, feesPct = d.selection_fees / POOL_CASH, gross = d.selection_gross;
  return {
    version: SCORECARD_VERSION, trial_id: t.trial_id, score: sc,
    metrics: {
      total_return: s.total_return, max_drawdown: s.max_drawdown, sharpe: s.sharpe, win_rate: s.win_rate, trades: s.trades, profit_factor: d.selection_profit_factor ?? null, expectancy: s.expectancy, cagr: sel.cagr, days: s.days,
      hold_return: s.hold_return, exposure_matched_hold: s.exposure_matched_hold, excess_vs_hold: s.hold_return === null ? null : s.total_return - s.hold_return, excess_vs_matched_hold: s.exposure_matched_hold === null ? null : s.total_return - s.exposure_matched_hold,
      stressed_return: s.stressed_return, fee_share: gross !== null && gross > 0 ? feesPct / gross : null, fees_pct: feesPct,
    },
    train: { total_return: d.train.total_return, sharpe: d.train.sharpe, trades: d.train.trades, max_drawdown: d.train.max_drawdown, cagr: tr.cagr },
    luck: luckOf(t, counts, sharpeVariance), segments: ['train', 'selection'], notes,
  };
}

const gateText = (g: { name: string; value: number | null }) => {
  if (g.name.startsWith('selection_trades')) return `平仓 ${g.value ?? '—'} 笔,不到 ${g.name.split('>=')[1]} 笔`;
  if (g.name.startsWith('selection_blocks')) return `只有 ${g.value ?? '—'} 个时间块,不到 ${g.name.split('>=')[1]} 个`;
  if (g.name.startsWith('deflated_sharpe')) return `显著性不够(DSR ${g.value === null ? '—' : g.value.toFixed(2)},门槛 ${g.name.split('>=')[1]})`;
  return g.name;
};

/** 候补(可纸面观察)的最少选择段平仓笔数 */
export const CANDIDATE_MIN_TRADES = 5;

/** 单个试验的档位(finalist = 这个试验若进了最终验收名单;cellFinalistFailed = 同格有 finalist 最终验收没过) */
export function tierOf(t: JudgedTrial, card: MatrixScorecard | null, p: MatrixProtocol, finalist: MatrixFinalist | null, cellFinalistFailed = false, sealed = true): { tier: MatrixTier; reasons: string[] } {
  if (!t.dev) return { tier: 'fail', reasons: [t.error ? `没有成绩:${t.error.slice(0, 120)}` : '没有成绩'] };
  if (finalist) {
    if (finalist.passed === true) return { tier: 'pass', reasons: ['原门槛全过,最终验收通过'] };
    if (finalist.passed === false) return { tier: 'fail', reasons: ['最终验收没通过'] };
    return { tier: 'pending', reasons: ['选择段门槛全过,等最终验收'] };
  }
  if (cellFinalistFailed) return { tier: 'fail', reasons: ['同一格的最终候选没过最终验收'] };
  // 搜索还没封存:选择段全过的试验还可能进最终验收名单,先记「等最终验收」
  if (!sealed && t.verdict === 'pass') return { tier: 'pending', reasons: ['选择段门槛全过,搜索还没结束'] };
  if (t.cause === 'unsupported_execution') return { tier: 'fail', reasons: ['执行不支持'] };
  const failed = t.gates.filter((g) => !g.ok), hard = failed.filter((g) => !SAMPLE_GATE.test(g.name) && !SIGNIFICANCE_GATE.test(g.name));
  const s = t.dev.selection, reasons: string[] = [];
  if (hard.length) reasons.push(...hard.map((g) => `没过:${g.name}`));
  if (!(s.total_return > 0)) reasons.push('选择段净收益不为正');
  if (s.exposure_matched_hold === null || !(s.total_return > s.exposure_matched_hold)) reasons.push('没跑赢同敞口持有');
  if (!(s.max_drawdown <= p.max_drawdown)) reasons.push(`回撤 ${pct(s.max_drawdown)} 超过门槛 ${pct(p.max_drawdown, 0)}`);
  if (!card || !OK_LABELS.has(card.score.label)) reasons.push(`评分卡 ${card?.score.label ?? '无'}(至少 fair)`);
  // 候补最少平仓笔数:1–2 笔的「excellent」几乎全是运气,不值得占模拟盘名额
  if (!(s.trades >= CANDIDATE_MIN_TRADES)) reasons.push(`平仓 ${s.trades} 笔,候补至少 ${CANDIDATE_MIN_TRADES} 笔`);
  if (reasons.length) return { tier: 'fail', reasons };
  return { tier: 'paper_candidate', reasons: failed.length ? failed.map(gateText) : ['选择段门槛全过,没进最终验收名额'] };
}

export interface TrialTier { tier: MatrixTier; reasons: string[]; scorecard: MatrixScorecard | null; verdict: JudgedTrial['verdict'] }
export interface CellTier { tier: MatrixTier; tier_trial_id: string | null; tier_reasons: string[]; scorecard: MatrixScorecard | null }
export interface TierBoard { trials: Map<string, TrialTier>; cells: Record<string, CellTier>; candidate_trial_ids: string[]; tiers: Record<MatrixTier, number> }

export const TIER_RANK: Record<MatrixTier, number> = { pass: 4, pending: 3, paper_candidate: 2, fail: 1, ineligible: 0 };
/** 整个研究的三档:每个可见试验一张评分卡 + 档位,每格取最高档(候补里按评分、再按选择段夏普挑一个) */
/** judgeSkip:两段式下没补跑 Jev 的 code_judge 格(记 ineligible,不进三档统计) */
export function tierBoard(m: MatrixManifest, finalists: MatrixFinalist[], trials: JudgedTrial[], counts: { study_trials: number; program_trials: number }, sharpeVariance: number, bestOf: Record<string, string | null> = {}, sealed = true, judgeSkip: ReadonlySet<string> = new Set()): TierBoard {
  const p = m.spec.protocol, byCell = new Map<string, JudgedTrial[]>(), fin = new Map(finalists.map((f) => [f.trial_id, f]));
  for (const t of trials) { const a = byCell.get(t.cell_id) ?? []; a.push(t); byCell.set(t.cell_id, a); }
  const out: TierBoard = { trials: new Map(), cells: {}, candidate_trial_ids: [], tiers: Object.fromEntries(MATRIX_TIERS.map((k) => [k, 0])) as Record<MatrixTier, number> };
  for (const c of m.cells) {
    if (c.applicability !== 'applicable' || judgeSkip.has(c.id)) { out.cells[c.id] = { tier: 'ineligible', tier_trial_id: null, tier_reasons: [], scorecard: null }; out.tiers.ineligible++; continue; }
    const ts = byCell.get(c.id) ?? [], seg = c.segments, cellTrials = ts.filter((t) => t.dev).length;
    const cellFailed = finalists.some((f) => f.cell_id === c.id && f.passed === false);
    const rows = ts.map((t) => {
      const card = seg ? scorecardOf(t, seg, { cell_trials: cellTrials, ...counts }, sharpeVariance) : null;
      const tt = tierOf(t, card, p, fin.get(t.trial_id) ?? null, cellFailed, sealed);
      const row: TrialTier = { ...tt, scorecard: card, verdict: t.verdict };
      out.trials.set(t.trial_id, row);
      return { t, row };
    });
    const top = Math.max(1, ...rows.map((r) => TIER_RANK[r.row.tier]));
    const pick = rows.filter((r) => TIER_RANK[r.row.tier] === top).sort((a, b) => (b.row.scorecard?.score.value ?? -1) - (a.row.scorecard?.score.value ?? -1) || (b.t.dev?.selection.sharpe ?? -Infinity) - (a.t.dev?.selection.sharpe ?? -Infinity) || a.t.trial_id.localeCompare(b.t.trial_id));
    // 未通过的格子沿用原来的「最好试验」(与结果地图数字一致);其余取该档里评分最高的
    const chosen = top === TIER_RANK.fail ? rows.find((r) => r.t.trial_id === bestOf[c.id]) ?? pick[0] : pick[0];
    const tier: MatrixTier = chosen ? chosen.row.tier : 'fail';
    out.cells[c.id] = { tier, tier_trial_id: chosen?.t.trial_id ?? null, tier_reasons: chosen?.row.reasons ?? ['没有评估成绩'], scorecard: chosen?.row.scorecard ?? null };
    out.tiers[tier]++;
    if (tier === 'paper_candidate' && chosen) out.candidate_trial_ids.push(chosen.t.trial_id);
  }
  return out;
}
