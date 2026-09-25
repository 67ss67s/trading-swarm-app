/**
 * manifest 展开与冻结:资产 × 周期 × 族 × 方向 × 臂 → 格子(applicable / not_applicable / research_only,不填零)、
 * 各周期三段窗口(训练 / 选择 / 留出,段间 purge_bars 根空档)、各类哈希、事前估算。
 * 展开结果写库后不可改(research_matrix_studies.manifest_json 有触发器)。
 */
import type { StrategyIR } from '@trading-swarm/contracts';
import { DEFAULT_EXECUTION } from '../backtest-report.js';
import { irVariants, type FamilyKey } from '../batch/families.js';
import { PERP_MAKER, PERP_TAKER, STRESS_FEE_MULTIPLE } from '../improve/evaluate.js';
import { hash } from '../primitives.js';
import { checkIR, timeframeMillis } from '../strategy.js';
import { requiredPurgeBars } from '../judge/purge.js';
import type { AssetRecommendation, Horizon } from '../../recommend.js';
import { usdMul } from './stats.js';
import { MATRIX_RUNNER_VERSION, RUNNABLE_TIMEFRAMES, myFamilyKey, type MatrixCell, type MatrixFamily, type MatrixSide, type MyStrategySnapshot, type MatrixManifest, type MatrixStudySpec, type MatrixTimeframe, type MatrixVariantRef, type TimeframeSegments } from './types.js';

const DAY = 86_400_000;
export const horizonOf = (tf: MatrixTimeframe): Horizon => (tf === '1d' ? 'long' : tf === '4h' ? 'mid' : 'short');
const alignClose = (t: number, step: number) => Math.floor((t + 1) / step) * step - 1;

/** 一个周期的三段:训练 [s, b1];选择 (b1 + purge, b2];留出 (b2 + purge, to]。全部落在 bar close_time 网格上 */
export function segmentsFor(spec: Pick<MatrixStudySpec, 'window_days' | 'to_ms' | 'split' | 'purge_bars'>, tf: MatrixTimeframe, days: number): TimeframeSegments {
  const step = timeframeMillis(tf), W = days * DAY, to = alignClose(spec.to_ms, step), start = alignClose(spec.to_ms - W, step);
  const b1 = alignClose(start + spec.split.train * W, step), b2 = alignClose(start + (spec.split.train + spec.split.selection) * W, step), gap = (spec.purge_bars + 1) * step;
  const seg: TimeframeSegments = { timeframe: tf, timeframe_ms: step, train: { from_ms: start + step, to_ms: b1 }, selection: { from_ms: b1 + gap, to_ms: b2 }, holdout: { from_ms: b2 + gap, to_ms: to }, purge_bars: spec.purge_bars };
  for (const w of [seg.train, seg.selection, seg.holdout]) if (!(w.from_ms < w.to_ms)) throw Error(`segments_too_short:${tf}`);
  return seg;
}

/** 无界持仓族的研究持仓上限(根):15m 2 天 / 4h 20 天 / 1d 60 天;写进 IR order.max_holding_bars,adopt 出去的策略同样带着 */
export const HOLDING_CAP: Record<MatrixTimeframe, number> = { '3m': 480, '5m': 288, '15m': 192, '4h': 120, '1d': 60 };
export const PURGE_HEADROOM = 1.25;
/** 变体 IR 的有界化:没有 time_stop / max_holding_bars 的补 order.max_holding_bars(边界协议 bounded_holding_v1) */
export function bounded(ir: StrategyIR, tf: MatrixTimeframe): { ir: StrategyIR; cap: number | null } {
  if (requiredPurgeBars(ir, timeframeMillis(tf)) !== null || !ir.order) return { ir, cap: null };
  const cap = HOLDING_CAP[tf];
  return { ir: { ...ir, order: { ...ir.order, max_holding_bars: cap }, description: `${ir.description}(研究持仓上限 ${cap} 根)` }, cap };
}
/** 本格空档:max(spec.purge_bars, ⌈最大需要 × 1.25⌉);没有可算上限时返回 null */
export function cellPurge(irs: StrategyIR[], tf: MatrixTimeframe, min: number): number | null {
  const need = irs.map((ir) => requiredPurgeBars(ir, timeframeMillis(tf)));
  if (need.some((n) => n === null)) return null;
  return Math.max(min, Math.ceil(Math.max(...(need as number[])) * PURGE_HEADROOM));
}
/** 在周期外层边界上按本格空档重算三段 */
export function cellSegments(outer: TimeframeSegments, purge: number): TimeframeSegments | null {
  const gap = (purge + 1) * outer.timeframe_ms, sel = { from_ms: outer.train.to_ms + gap, to_ms: outer.selection.to_ms }, ho = { from_ms: outer.selection.to_ms + gap, to_ms: outer.holdout.to_ms };
  const seg: TimeframeSegments = { ...outer, selection: sel, holdout: ho, purge_bars: purge };
  // 空档吃掉一段的 60% 以上就不评估(证据不足,不是不适用)
  const len = (w: { from_ms: number; to_ms: number }) => w.to_ms - w.from_ms;
  if (len(sel) < 0.4 * (outer.selection.to_ms - outer.train.to_ms) || len(ho) < 0.4 * (outer.holdout.to_ms - outer.selection.to_ms)) return null;
  return seg;
}

/** IR 加判断要素块:v2 才允许带 judge(见 contracts StrategyIR.version) */
export function withJudge(ir: StrategyIR, spec: MatrixStudySpec): StrategyIR {
  if (!spec.judge) throw Error('judge_spec_missing');
  return { ...ir, version: 2, judge: spec.judge, label: `${ir.label} · 判断要素` } as StrategyIR;
}

/** 去掉 judge 块(纯代码臂):同一份规则,不经过判断;v2 只为 judge 存在,去掉后回到 v1(schema 要求) */
export function withoutJudge(ir: StrategyIR): StrategyIR { if (!ir.judge) return ir; const { judge: _j, ...rest } = ir; void _j; return { ...rest, version: 1 } as StrategyIR; }

/**
 * 「我的策略」一格的 IR(§9.53 B 自选策略行):
 * - 周期:IR 本身不带周期,参数按根数解释;策略登记周期 ≠ 格子周期时按格子周期跑,reason 记 `timeframe_override:<原>→<格>`;
 *   IR 在格子周期上通不过结构检查(如高周期参数低于基础周期)→ not_applicable `my_strategy_incompatible:…`。
 * - 方向:order.direction(无 order 块 = 做多);long/short 只进同向格;both 只在 long 格评估一次,short 格标 not_applicable。
 * - 市场:order.market ≠ 研究市场时,现货 IR 进永续研究直接改 market;永续 IR 进现货研究只在做多且无杠杆时改,否则 not_applicable。
 * - 臂:code 臂去掉 judge;code_judge 臂 IR 自带 judge 就用它自己的(model_profile_ref 钉到本次冻结的模型配置),没有就附研究 spec 的 judge。
 */
export function myCellIR(snap: MyStrategySnapshot, spec: MatrixStudySpec, tf: MatrixTimeframe, side: MatrixSide, arm: MatrixCell['arm']): { ir: StrategyIR; notes: string[] } | { na: string } {
  let ir = snap.ir; const notes: string[] = [];
  const dir = ir.order?.direction ?? 'long';
  if (dir === 'both' && side === 'short') return { na: 'my_strategy_direction:both_evaluated_in_long_cell' };
  if (dir !== 'both' && dir !== side) return { na: `my_strategy_direction:${dir}` };
  if (ir.order && ir.order.market !== spec.market) {
    if (spec.market === 'spot' && (dir !== 'long' || (ir.order.leverage ?? 1) > 1)) return { na: `my_strategy_market:${ir.order.market}` };
    ir = { ...ir, order: { ...ir.order, market: spec.market, ...(spec.market === 'spot' ? { leverage: 1 } : {}) } };
    notes.push(`market_override:${snap.ir.order!.market}→${spec.market}`);
  }
  if (snap.timeframe !== tf) notes.push(`timeframe_override:${snap.timeframe}→${tf}`);
  const c = checkIR(withoutJudge(ir), tf);
  if (!c.ok) return { na: `my_strategy_incompatible:${c.checks.filter((x) => !x.ok).map((x) => x.name).join(',') || 'invalid'}`.slice(0, 200) };
  if (arm === 'code') return { ir: withoutJudge(ir), notes };
  if (ir.judge) {
    const ref = spec.model_profile!.ref;
    if (ir.judge.model_profile_ref !== ref) { ir = { ...ir, judge: { ...ir.judge, model_profile_ref: ref } }; notes.push('own_judge:model_profile_rebound'); } else notes.push('own_judge');
    return { ir, notes };
  }
  return { ir: withJudge(ir, spec), notes };
}

export function expandCells(spec: MatrixStudySpec, rec: AssetRecommendation | null, segments: MatrixManifest['segments'] = {}, mine: MyStrategySnapshot[] = []): MatrixCell[] {
  const cells: MatrixCell[] = [];
  const recRow = (sym: string) => rec?.rows.find((r) => r.symbol === sym) ?? null;
  const rows: { family: MatrixFamily; snap: MyStrategySnapshot | null }[] = [...spec.families.map((f) => ({ family: f as MatrixFamily, snap: null })), ...(spec.strategies ?? []).map((r) => ({ family: myFamilyKey(r.strategy_id, r.version), snap: mine.find((m) => m.strategy_id === r.strategy_id && m.version === r.version) ?? null }))];
  for (const symbol of spec.symbols) for (const tf of spec.timeframes) for (const { family, snap } of rows) for (const side of spec.sides) for (const arm of spec.arms) {
    const id = `${symbol}|${tf}|${family}|${side}|${arm}`, my = family.startsWith('my:');
    const cell = (applicability: MatrixCell['applicability'], reason: string | null, variants: MatrixVariantRef[] = [], seg: TimeframeSegments | null = null, holding_cap: number | null = null): MatrixCell => ({ id, symbol, timeframe: tf, family, side, arm, applicability, reason, variants, segments: seg, holding_cap });
    if (family === 'xsmom' || family === 'carry') { cells.push(cell('not_applicable', 'portfolio_family_separate_study')); continue; }
    if (spec.market === 'spot' && side === 'short') { cells.push(cell('not_applicable', 'spot_cannot_short')); continue; }
    if (!RUNNABLE_TIMEFRAMES.includes(tf)) { cells.push(cell('research_only', 'short_timeframe_execution_unverified')); continue; }
    const row = recRow(symbol);
    if (rec && !row) { cells.push(cell('not_applicable', 'recommendation:symbol_missing')); continue; }
    if (row) {
      const fit = row.horizons[horizonOf(tf)];
      if (!fit.eligible) { cells.push(cell('not_applicable', `recommendation:${fit.reason ?? 'ineligible'}`)); continue; }
      if (fit.direction && fit.direction !== 'both' && fit.direction !== side) { cells.push(cell('not_applicable', 'recommendation:direction')); continue; }
    }
    if (arm === 'code_judge' && (!spec.judge || !spec.model_profile)) { cells.push(cell('not_applicable', 'judge_runtime_unavailable')); continue; }
    let base: { id: string; param: string; ir: StrategyIR; vol_target?: { annual: number; days: number } }[], notes: string[] = [];
    if (my) {
      if (!snap) { cells.push(cell('not_applicable', 'my_strategy_snapshot_missing')); continue; }
      const r = myCellIR(snap, spec, tf, side, arm);
      if ('na' in r) { cells.push(cell('not_applicable', r.na)); continue; }
      notes = r.notes;
      base = [{ id: `${family}:${spec.market}:${side}:${tf}`, param: `v${snap.version}`, ir: r.ir }];
    } else {
      base = irVariants(spec.market, side, tf).filter((v) => v.family === family);
      if (!base.length) { cells.push(cell('not_applicable', 'family_side_unavailable')); continue; }
    }
    const outer = segments[tf];
    if (!outer) { cells.push(cell('research_only', 'timeframe_segments_missing')); continue; }
    let cap: number | null = null;
    let variants: MatrixVariantRef[] = base.map((v) => { const b = bounded(v.ir, tf); cap = b.cap ?? cap; return { id: `${v.id}|${arm}`, param: v.param, ir: my || arm !== 'code_judge' ? b.ir : withJudge(b.ir, spec), ...(v.vol_target ? { vol_target: v.vol_target } : {}) }; });
    if (arm === 'code_judge' && spec.judge_templates) variants = variants.flatMap(v => spec.judge_templates!.map((j,i) => ({ ...v, template_group: v.id, id: `${v.id}|template_${i}`, ir: { ...v.ir, judge: j } })));
    const purge = cellPurge(variants.map((v) => v.ir), tf, spec.purge_bars), seg = purge === null ? null : cellSegments(outer, purge);
    if (!seg) { cells.push(cell('not_applicable', purge === null ? 'holding_unbounded' : `holding_exceeds_window:purge_${purge}`)); continue; }
    const reason = [cap ? `bounded_holding_v1:max_holding_bars=${cap}` : null, ...notes].filter(Boolean).join(';');
    cells.push(cell('applicable', reason || null, variants, seg, cap));
  }
  return cells;
}

export const executionSpec = () => ({ runner: MATRIX_RUNNER_VERSION, spot_fee_rate: DEFAULT_EXECUTION.fee_rate, perp_taker: PERP_TAKER, perp_maker: PERP_MAKER, slippage_bps: DEFAULT_EXECUTION.slippage_bps, stress_fee_multiple: STRESS_FEE_MULTIPLE, sizing: 'unit_notional_single_asset' });
export const protocolHashOf = (s: MatrixStudySpec) => hash({ protocol: s.protocol, split: s.split, purge_bars: s.purge_bars, iterate: s.iterate, budget: s.budget, judge: s.judge, judge_templates: s.judge_templates ?? null, model_profile: s.model_profile });
export const dataScopeOf = (s: MatrixStudySpec) => `scope_${hash({ symbols: [...s.symbols].sort(), market: s.market }).slice(0, 16)}`;

export function buildManifest(spec: MatrixStudySpec, rec: AssetRecommendation | null, now: number, mine: MyStrategySnapshot[] = []): MatrixManifest {
  const segments: MatrixManifest['segments'] = {};
  for (const tf of spec.timeframes) if (RUNNABLE_TIMEFRAMES.includes(tf)) segments[tf] = segmentsFor(spec, tf, spec.window_days[tf]!);
  const cells = expandCells(spec, rec, segments, mine);
  const dev = Object.fromEntries(Object.entries(segments).map(([tf, s]) => [tf, { from_ms: s!.train.from_ms, to_ms: s!.selection.to_ms }]));
  return {
    version: 'matrix_manifest_v1', spec, ...(mine.length ? { my_strategies: mine } : {}), segments, cells,
    data_request_hash: hash({ symbols: spec.symbols, market: spec.market, dev }),
    protocol_hash: protocolHashOf(spec), execution_spec_hash: hash(executionSpec()), data_scope_id: dataScopeOf(spec), created_at: now,
  };
}
export const manifestHash = (m: MatrixManifest) => hash(m);

export interface MatrixEstimate {
  cells: { total: number; applicable: number; not_applicable: number; research_only: number };
  matrix_trials: number; iteration_trials_max: number; variants: number;
  judge_calls: number; judge_usd: string;
  data: { series: number; bars: number; cold_fetch_ms_upper: number };
  within_budget: boolean; warnings: string[];
}
/**
 * 事前估算(不落库):试验数 = 矩阵全部变体 + 迭代上限(top_k × 代数 × 每代候选);
 * 判断调用 = code_judge 试验 × 开发段根数 / 30(粗估候选率)× 1(正常/压力两次运行共用同一决策);
 * 美元上限 = 调用数 × 单次最大预留;冷数据上限按 OKX 每请求 100 根、300ms 估。
 */
export function estimate(m: MatrixManifest): MatrixEstimate {
  const s = m.spec, app = m.cells.filter((c) => c.applicability === 'applicable');
  const matrix_trials = app.reduce((a, c) => a + c.variants.length, 0), iteration = s.iterate.top_k * s.iterate.generations * s.iterate.candidates_per_generation;
  let judge_calls = 0;
  for (const c of app) if (c.arm === 'code_judge') { const g = c.segments!; judge_calls += c.variants.length * Math.ceil((g.selection.to_ms - g.train.from_ms) / g.timeframe_ms / 30); }
  let bars = 0, series = 0;
  for (const g of Object.values(m.segments)) { series += s.symbols.length; bars += s.symbols.length * Math.ceil((g!.holdout.to_ms - g!.train.from_ms) / g!.timeframe_ms + 301); }
  const warnings: string[] = [];
  if (matrix_trials > s.budget.max_variants) warnings.push(`矩阵变体 ${matrix_trials} 超过预算 ${s.budget.max_variants},请缩小资产 / 周期 / 族`);
  if (judge_calls > s.budget.max_judge_calls) warnings.push(`判断调用粗估 ${judge_calls} 超过预算 ${s.budget.max_judge_calls},超出部分的 code_judge 格会标执行不支持`);
  if (m.cells.some((c) => c.applicability === 'research_only')) warnings.push('3m/5m 首版只标 research_only(运行器与延迟撮合未验证),不评估、不填零');
  if (s.arms.includes('code_judge') && !(s.judge && s.model_profile)) warnings.push('没有冻结的判断模型配置,code_judge 臂全部标 not_applicable');
  // 预算按单次价格上限(max_call_usd)原子预留:上限总额超过研究预算时,跑到一半就会被预算挡住(2026-09-25 端到端发现)
  if (s.model_profile && s.arms.includes('code_judge') && Number(usdMul(s.model_profile.max_call_usd, judge_calls)) > Number(s.budget.max_judge_usd)) {
    warnings.push(`判断花费上限 $${usdMul(s.model_profile.max_call_usd, judge_calls)}(按单次上限 $${s.model_profile.max_call_usd} 预留,实际通常低一个数量级)超过研究预算 $${s.budget.max_judge_usd},超出部分的 code_judge 格会标执行不支持;请缩小矩阵或调高预算`);
  }
  return {
    cells: { total: m.cells.length, applicable: app.length, not_applicable: m.cells.filter((c) => c.applicability === 'not_applicable').length, research_only: m.cells.filter((c) => c.applicability === 'research_only').length },
    matrix_trials, iteration_trials_max: iteration, variants: matrix_trials + iteration,
    judge_calls, judge_usd: s.model_profile ? usdMul(s.model_profile.max_call_usd, judge_calls) : '0',
    data: { series, bars, cold_fetch_ms_upper: Math.ceil(bars / 100) * 300 },
    within_budget: matrix_trials <= s.budget.max_variants, warnings,
  };
}

