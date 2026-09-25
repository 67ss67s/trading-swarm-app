/**
 * 矩阵研究的数据视图与试验评估。
 *
 * 隔离(评审第一节 2):
 *   - 开发视图 loadDevView:取数窗口只到选择段末(selection.to_ms),K 线在内存里也物理截断;segments.holdout 是哨兵(永远取不到 bar)。
 *     搜索、诊断、生成器只拿到它,没有留出句柄。
 *   - 留出视图 loadHoldoutView:只能在 research_holdout_releases 已 claimed 且 Study 在 finalizing 时打开(assertHoldoutCapability),
 *     从留出段起点起跑(空仓),预热只借更早的 K 线算指标。
 * 评估:runPool(与改进环 / 批量研究同一执行器、同一费率口径)正常费率 + 2 倍费率各一次;按边界盯市切训练 / 选择两段(batch.sliceAsset,
 *   交易统计只含段内成熟交易);code_judge 臂经 EvalEnv.judge 走 judge/ 的 judgeWithBars(订单核在意图产生后、模拟成交前过滤),
 *   全部候选(含 skip / error / uncertain)写 research_study_candidates。
 */
import type { StrategyIR } from '@trading-swarm/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { ResearchStore } from '../store.js';
import type { AssetExecutor, BarsLoader } from '../backtest-report.js';
import { poolScore, sliceAsset, volTargetEquity } from '../batch/evaluate.js';
import { slim } from '../batch/study.js';
import { freezeData } from '../improve/data.js';
import { EvalEnv, POOL_CASH, STRESS_FEE_MULTIPLE, diagnoseRun, runPool, type PoolRun, type Window } from '../improve/evaluate.js';
import type { FrozenAsset, FrozenData } from '../improve/types.js';
import { hash } from '../primitives.js';
import { AtomicCallBudget, JudgeDecisionStore, type JudgeRuntime } from '../judge/index.js';
import type { DecisionProvider, JudgeCandidateSnapshot, JudgeResult } from '../judge/types.js';
import { accountReplay, PORTFOLIO_DEFAULTS, type PortfolioSummary, type ReplayCandidate } from './portfolio.js';
import type { DevResult, MatrixManifest, MatrixStudyRow, MatrixTimeframe, MatrixVariantRef, TimeframeSegments } from './types.js';
import type { SlimScore } from '../batch/study.js';

/** 封存哨兵:负区间(judge/purge.assertSplitPurges 据此认定留出已封存,逐变体强制校验空档) */
export const SEALED: Window = { from_ms: -2, to_ms: -1 };
export interface LoadOptions { loader?: BarsLoader; signal?: AbortSignal; progress?: (note: string) => void }
export interface DataView { data: FrozenData; notes: string[]; lock: Record<string, { dataset_id: string; content_hash: string; bars: number; to_ms: number }> }

const barsHash = (a: FrozenAsset) => hash(a.bars.map((b) => [b.open_time, b.open, b.high, b.low, b.close, b.volume]));
const truncate = (a: FrozenAsset, to_ms: number): FrozenAsset => {
  const n = a.bars.filter((b) => b.close_time <= to_ms).length;
  if (n === a.bars.length) return a;
  return { ...a, bars: a.bars.slice(0, n), ...(a.perp ? { perp: { ...a.perp, mark: a.perp.mark.slice(0, n), funding: { ...a.perp.funding, points: a.perp.funding.points.filter((f) => f.ts <= to_ms), to_ms: Math.min(a.perp.funding.to_ms, to_ms) } } } : {}) };
};
function folds4(w: Window, step: number): Window[] {
  const n = Math.max(4, Math.floor((w.to_ms - w.from_ms) / step)), size = Math.floor(n / 4), out: Window[] = [];
  for (let k = 0; k < 4; k++) out.push({ from_ms: w.from_ms + k * size * step, to_ms: k === 3 ? w.to_ms : w.from_ms + ((k + 1) * size - 1) * step + (step - 1) });
  return out;
}

/** 开发视图:训练段首 − 预热 ~ 选择段末。数据指纹进 data_lock(首跑写一次,恢复时必须一致) */
export async function loadDevView(db: DatabaseSync, m: MatrixManifest, tf: MatrixTimeframe, o: LoadOptions): Promise<DataView> {
  const g = m.segments[tf]!;
  const r = await freezeData(new ResearchStore(db), { universe: m.spec.symbols, timeframe: tf, from_ms: g.train.from_ms, to_ms: g.selection.to_ms, market: m.spec.market }, { ...(o.loader ? { loader: o.loader } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.progress ? { progress: o.progress } : {}) });
  const assets = r.data.assets.map((a) => truncate(a, g.selection.to_ms));
  const data: FrozenData = { ...r.data, assets, segments: { folds: folds4(g.train, g.timeframe_ms), train: g.train, validation: g.selection, holdout: SEALED } };
  const lock: DataView['lock'] = {};
  for (const a of assets) lock[`${tf}:${a.symbol}`] = { dataset_id: a.dataset_id, content_hash: barsHash(a), bars: a.bars.length, to_ms: a.bars.at(-1)?.close_time ?? 0 };
  return { data, notes: r.notes.filter((n) => !n.startsWith('切段参考资产')), lock };
}
/** 留出能力:只有该 Study 的留出已 claimed、Study 在 finalizing,才允许打开留出视图 */
export function assertHoldoutCapability(db: DatabaseSync, study_id: string): void {
  const rel = db.prepare('SELECT status FROM research_holdout_releases WHERE study_id=?').get(study_id) as { status: string } | undefined;
  const st = db.prepare('SELECT status FROM research_matrix_studies WHERE id=?').get(study_id) as { status: string } | undefined;
  if (!rel || rel.status !== 'claimed' || st?.status !== 'finalizing') throw Error('holdout_capability_missing');
}
export async function loadHoldoutView(db: DatabaseSync, row: MatrixStudyRow, tf: MatrixTimeframe, o: LoadOptions): Promise<DataView> {
  assertHoldoutCapability(db, row.id);
  const g = row.manifest.segments[tf]!;
  const r = await freezeData(new ResearchStore(db), { universe: row.manifest.spec.symbols, timeframe: tf, from_ms: g.holdout.from_ms, to_ms: g.holdout.to_ms, market: row.manifest.spec.market }, { ...(o.loader ? { loader: o.loader } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  const data: FrozenData = { ...r.data, segments: { folds: [], train: SEALED, validation: SEALED, holdout: g.holdout } };
  const lock: DataView['lock'] = {};
  for (const a of r.data.assets) lock[`holdout:${tf}:${a.symbol}`] = { dataset_id: a.dataset_id, content_hash: barsHash(a), bars: a.bars.length, to_ms: a.bars.at(-1)?.close_time ?? 0 };
  return { data, notes: r.notes.filter((n) => !n.startsWith('切段参考资产')), lock };
}
export const singleAsset = (d: FrozenData, symbol: string): FrozenData | null => { const a = d.assets.find((x) => x.symbol === symbol); return a ? { ...d, universe: [symbol], assets: [a] } : null; };

// ---------------------------------------------------------------- judge 运行时
export interface MatrixJudgeDeps {
  /** 钉住连接版本、maxRetries=0 的决策客户端(judge/ fromDecisionClient 适配);缺省 → code_judge 臂标执行不支持 */
  provider?: DecisionProvider;
  /** recorded_only:只用已记录响应重放(G1/G4 或留出恢复);缺省 request_once */
  mode?: 'request_once' | 'recorded_only';
}
export const judgeBudgetId = (study_id: string) => `matrix:${study_id}`;
export function judgeRuntimeFor(db: DatabaseSync, row: MatrixStudyRow, deps: MatrixJudgeDeps | undefined, signal?: AbortSignal): JudgeRuntime | null {
  const s = row.manifest.spec;
  if (!s.judge || !s.model_profile) return null;
  const mode = deps?.mode ?? 'request_once';
  if (mode === 'request_once' && !deps?.provider) return null;
  const budget = AtomicCallBudget.create(db, judgeBudgetId(row.id), s.budget.max_judge_calls, s.budget.max_judge_usd);
  return { mode, model_profile: s.model_profile, execution_spec_hash: row.manifest.execution_spec_hash, scope: `matrix:${s.research_program_id}`, store: new JudgeDecisionStore(db), budget, ...(deps?.provider ? { provider: deps.provider } : {}), ...(signal ? { signal } : {}) };
}

// ---------------------------------------------------------------- 单次评估
export interface CandidateLog { candidate: JudgeCandidateSnapshot; decision: JudgeResult | null }
export interface RunPair { run: PoolRun; stressed: PoolRun; candidates: CandidateLog[] }
async function runPair(data: FrozenData, ir: StrategyIR, win: Window, o: { check: () => void; executorFor?: (ir: StrategyIR) => AssetExecutor; judge: JudgeRuntime | null; stress?: boolean }): Promise<RunPair> {
  const env = new EvalEnv(data, o.check, o.executorFor), candidates: CandidateLog[] = [], seen = new Set<string>();
  if (ir.judge) { if (!o.judge) throw Error('judge_runtime_unavailable'); env.judge = o.judge; }
  env.on_candidate = (candidate, decision) => { const k = `${candidate.symbol}:${candidate.id}`; if (!seen.has(k)) { seen.add(k); candidates.push({ candidate, decision }); } };
  const key = hash(ir), run = await runPool(env, ir, key, win);
  // 压力运行只重算撮合:同一候选的判断走决策缓存,不重复计费;候选只按首次记
  const stressed = o.stress === false ? run : await runPool(env, ir, key, win, { feeMultiple: STRESS_FEE_MULTIPLE });
  return { run, stressed, candidates };
}
/** 判断结果里出现这些原因时,这次评估不能当作「判断跳过」:预算耗尽 / 取消 / 进行中 → 评估失败,不伪造成绩 */
function judgeFailure(c: CandidateLog[]): string | null {
  for (const x of c) {
    const codes = x.decision?.reason_codes ?? [];
    if (codes.includes('cancelled') || codes.includes('CANCELLED')) return 'CANCELLED';
    if (codes.includes('judge_budget_exhausted')) return 'judge_budget_exhausted';
    if (codes.includes('request_in_flight')) return 'judge_request_in_flight';
    if (codes.includes('recorded_response_missing')) return 'judge_recorded_response_missing';
  }
  return null;
}
function judgeStats(c: CandidateLog[], hasJudge: boolean): DevResult['judge'] {
  if (!hasJudge) return null;
  const d = c.map((x) => x.decision);
  return { candidates: c.length, follow: d.filter((x) => x?.action === 'follow').length, skip: d.filter((x) => x?.action === 'skip' && x.status === 'ok').length, error: d.filter((x) => x?.status === 'error').length, uncertain: d.filter((x) => x?.status === 'uncertain').length };
}
function slicesFor(p: RunPair, data: FrozenData, v: MatrixVariantRef, segs: Record<string, Window>) {
  const a = data.assets[0]!, step = data.timeframe_ms, pa = p.run.per_asset.find((x) => x.symbol === a.symbol), ps = p.stressed.per_asset.find((x) => x.symbol === a.symbol);
  if (!pa || pa.status !== 'completed') throw Error(`execution_failed:${pa?.error ?? 'no_run'}`);
  let samples = pa.equity.map((e) => ({ at: e.at, equity: e.equity, exposure: e.exposure, bench: pa.bench.get(e.at) ?? null }));
  let sSamples = ps && ps.status === 'completed' ? ps.equity.map((e) => ({ at: e.at, equity: e.equity, exposure: e.exposure, bench: null as number | null })) : null;
  let trades = pa.trades.map((t) => ({ entry_at: t.entry_at, exit_at: t.exit_at, return_pct: t.return_pct, fees: t.fees }));
  if (v.vol_target) {
    const vt = volTargetEquity(samples, a.bars, step, v.vol_target); samples = vt.samples;
    if (sSamples) sSamples = volTargetEquity(sSamples, a.bars, step, v.vol_target).samples;
    trades = trades.map((t) => { let w = 1, bt = -Infinity; for (const [at, x] of vt.weights) if (at >= t.entry_at && at - t.entry_at < 2 * step && at > bt) { w = x; bt = at; } return { ...t, return_pct: t.return_pct * w, fees: t.fees * w }; });
  }
  const start = pa.equity[0]?.at ?? null;
  return Object.fromEntries(Object.entries(segs).map(([k, w]) => [k, sliceAsset(a.symbol, samples, sSamples, trades, w, start)]));
}
export const signOf = (ir: StrategyIR): 1 | -1 => (ir.order?.direction === 'short' ? -1 : 1);

/** 开发视图上评估一个变体(单资产):训练 + 选择段 */
export async function evaluateDev(data: FrozenData, g: TimeframeSegments, v: MatrixVariantRef, o: { check: () => void; executorFor?: (ir: StrategyIR) => AssetExecutor; judge: JudgeRuntime | null; onCandidate?: (c: CandidateLog) => void }): Promise<DevResult> {
  if (data.assets.some((a) => (a.bars.at(-1)?.close_time ?? 0) > g.selection.to_ms)) throw Error('dev_view_leak');
  data = { ...data, segments: { folds: folds4(g.train, g.timeframe_ms), train: g.train, validation: g.selection, holdout: SEALED } };
  const p = await runPair(data, v.ir, { from_ms: g.train.from_ms, to_ms: g.selection.to_ms }, o);
  for (const c of p.candidates) o.onCandidate?.(c);
  const jf = judgeFailure(p.candidates); if (jf) throw Error(jf);
  const sl = slicesFor(p, data, v, { train: g.train, selection: g.selection }), sign = signOf(v.ir);
  const tr = poolScore([sl.train!], sign), se = poolScore([sl.selection!], sign);
  let diagnosis: DevResult['diagnosis'] = [];
  try { diagnosis = diagnoseRun(p.run, data, v.ir).map((f) => ({ key: f.key, severity: f.severity, text: f.text })); } catch { /* 诊断失败不影响成绩 */ }
  const fees = sl.selection!.fees;
  return {
    train: slim(tr), selection: slim(se), selection_returns: se.returns, selection_days: sl.selection!.days,
    selection_fees: fees, selection_gross: se.total_return + fees / POOL_CASH,
    diagnosis, judge: judgeStats(p.candidates, !!v.ir.judge), warnings: p.run.warnings.slice(0, 10), engine: p.run.engine_version,
  };
}

export interface HoldoutEval { score: SlimScore; returns: number[]; gross: number | null; portfolio: PortfolioSummary | null; candidates: CandidateLog[]; judge: DevResult['judge'] }
/** 留出段:finalist 本格(单资产)正常 + 2 倍费率;再以同一 IR 在研究资产池全部资产上做账户级回放 */
export async function evaluateHoldout(view: FrozenData, g: TimeframeSegments, symbol: string, v: MatrixVariantRef, market: 'spot' | 'perp', o: { check: () => void; executorFor?: (ir: StrategyIR) => AssetExecutor; judge: JudgeRuntime | null; portfolio?: { risk_pct?: number; max_open?: number } }): Promise<HoldoutEval> {
  view = { ...view, segments: { folds: [], train: SEALED, validation: SEALED, holdout: g.holdout } };
  const one = singleAsset(view, symbol);
  if (!one) throw Error('holdout_data_missing');
  const win = g.holdout, p = await runPair(one, v.ir, win, o);
  const jf = judgeFailure(p.candidates); if (jf) throw Error(jf);
  const sl = slicesFor(p, one, v, { holdout: win }), sc = poolScore([sl.holdout!], signOf(v.ir));
  let portfolio: PortfolioSummary | null = null;
  try {
    const all = await runPair(view, v.ir, win, { ...o, stress: false });
    const trades = all.run.trades.filter((t) => t.entry_at >= win.from_ms - view.timeframe_ms && t.exit_at <= win.to_ms).map((t) => ({ symbol: t.symbol, entry_at: t.entry_at, exit_at: t.exit_at, return_pct: t.return_pct }));
    const cands: ReplayCandidate[] = all.candidates.map((c) => ({ symbol: c.candidate.symbol, as_of: c.candidate.as_of, entry: c.candidate.entry, stop: c.candidate.stop, action: c.decision ? c.decision.action : null }));
    portfolio = accountReplay(trades, cands, { initial: PORTFOLIO_DEFAULTS.initial, risk_pct: o.portfolio?.risk_pct ?? PORTFOLIO_DEFAULTS.risk_pct, max_open: o.portfolio?.max_open ?? PORTFOLIO_DEFAULTS.max_open, gross_cap: market === 'perp' ? 3 : 1 });
  } catch (e) { if (/CANCELLED/.test(String(e))) throw e; }
  return { score: slim(sc), returns: sc.returns, gross: sc.total_return + sl.holdout!.fees / POOL_CASH, portfolio, candidates: p.candidates, judge: judgeStats(p.candidates, !!v.ir.judge) };
}
