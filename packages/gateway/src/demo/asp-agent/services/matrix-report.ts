/**
 * 服务二「策略矩阵研究报告」:跑一次小规模矩阵研究(资产 × 周期 × 策略族 × 方向,纯代码臂,零模型花费),
 * 训练/选择/留出三段,留出只看一次;返回结论、finalist 的留出成绩与组合回放,报告 JSON 的 sha256 可锚定到 X Layer。
 *
 * 规模上限(按次服务要可预期):≤3 个资产、≤2 个周期(15m / 4h / 1d)、预算 ≤300 个变体、墙钟 ≤30 分钟。
 * 没给资产 → 先跑一次「资产×周期推荐」,取推荐里前 3 个可研究的资产。
 * 给了资产 → 股票代币 / 杠杆 ETF 在 validate 阶段剔除(全部剔除就拒单);OKX 不可交易的在开跑前按 deps.tradable 剔除,
 *   全部剔除就不建研究、交付「未开跑」说明。剔除了什么、为什么,正文里写明。
 * 正文必答「留出段表现 + 多重检验」:有 finalist 给留出段成绩与 p 值 / Holm 阈值 / 是否拒绝;没有 finalist 列选择段前 3 格
 *   并写明「留出段未释放、Holm 未执行」。选择段根数撑不起最少笔数的周期(典型是 1d)在正文前面提示证据必然偏薄。
 * 同一资产池当天留出段已被用过(另一个买家或重试)→ 不重跑,复用那次研究的结果并在报告里写明(留出只能看一次)。
 * 上链锚定不在这里做:报告只带 anchor.status = 'not_anchored',锚定动作要人批。
 */
import { SINGLE_ASSET_FAMILIES } from '../../research/matrix-study/types.js';
import { DEFAULT_SPLIT, DEFAULT_WINDOW_DAYS } from '../../research/matrix-study/spec.js';
import { freeText, jsonParams, marketIn, normTimeframe, sideIn, symbolList, symbolsIn } from './params.js';
import { FAMILY_EXAMPLE, NOT_COIN, type QuickFamily } from './quick-backtest.js';
import { FAMILY_TEXT, stockLike, type AssetHorizonDeps } from './asset-horizon.js';
import { num, pct } from './render.js';
import { ServiceInputError, type MatrixViewLike, type PerCallJob, type ScoreLike, type ServiceDeps } from './types.js';

export const REPORT_TIMEFRAMES = ['15m', '4h', '1d'] as const;
/**
 * 证据可达窗口(天):引擎缺省窗口下 15m 选择段只有 ~36 天(最多 7 个 5 天块,门槛 20 块,结构上过不了),
 * 4h / 1d 选择段撑不到 30 笔(09-26 四单 66 格全部「样本不足」)。按次报告改用更长的历史,让选择段在原理上够得着
 * 30 笔 / 20 块;证据门槛(笔数、时间块、DSR、Holm、留出只看一次)一个不改,报告里写明改了什么。
 * 15m:540 天 → 选择段 ≈108 天(≈21 块);4h:1825 天 → ≈365 天;1d:2190 天 → ≈438 天(仍偏薄,报告前置提示)。
 */
export const EVIDENCE_WINDOW_DAYS: Record<typeof REPORT_TIMEFRAMES[number], number> = { '15m': 540, '4h': 1825, '1d': 2190 };
export const REPORT_MAX_SYMBOLS = 3;
/** 买方显式给了但被剔除的币:stock_like = 股票代币/杠杆 ETF(validate 阶段);not_tradable = OKX 当前没有对应市场(开跑前) */
export interface DroppedSymbol { symbol: string; reason: 'stock_like' | 'not_tradable' }
export interface MatrixReportParams { symbols?: string[]; timeframes: string[]; families?: string[]; sides?: ('long' | 'short')[]; market: 'spot' | 'perp'; dropped?: DroppedSymbol[] }

const DONE = ['completed', 'cancelled', 'failed', 'interrupted', 'ready_to_finalize'];
const SIDE_TEXT: Record<string, string> = { long: 'long', short: 'short', both: 'both sides' };
const MARKET_TEXT: Record<string, string> = { spot: 'spot', perp: 'USDT perpetual' };
const VERDICT_TEXT: Record<string, string> = { pass: 'passed', near: 'near threshold', fail: 'failed', ineligible: 'not applicable' };
const EVIDENCE_TEXT: Record<string, string> = { historical_replay: 'historical replay (this history has been seen before; counts as replay evidence only)', unseen_holdout: 'unseen holdout segment' };
const STATUS_TEXT: Record<string, string> = { cancelled: 'cancelled', failed: 'failed', interrupted: 'interrupted', ready_to_finalize: 'awaiting finalization', running: 'running', queued: 'queued', finalizing: 'finalizing' };
const base = (s: string) => s.replace(/USDT$/, '');
const tag = (f: { symbol: string; timeframe: string; family: string; side: string }) => `${base(f.symbol)} ${f.timeframe} ${FAMILY_TEXT[f.family] ?? f.family} ${SIDE_TEXT[f.side] ?? f.side}`;
const CAUSE_TEXT: Record<string, string> = { cost_dominated: 'costs eat the edge', insufficient_evidence: 'insufficient evidence', unsupported_execution: 'execution not supported', underperform_hold: 'underperforms buy & hold' };

/** 完整矩阵档的输入校验(research_report tier=full 与旧 matrix_report 共用) */
export function validateMatrix(job: PerCallJob): MatrixReportParams {
  const p = jsonParams(job) ?? {}, text = freeText(job);
  const fromText = symbolsIn(text.replace(NOT_COIN, ' '), REPORT_MAX_SYMBOLS + 1);
  const asked = symbolList(p['symbols'], REPORT_MAX_SYMBOLS) ?? (fromText.length ? fromText : undefined);
  if (asked && asked.length > REPORT_MAX_SYMBOLS) throw new ServiceInputError('symbols_too_many', `At most ${REPORT_MAX_SYMBOLS} symbols per report`);
  // 股票代币 / 杠杆 ETF 不做加密策略研究:显式点名也剔除;全部剔除就在接单前拒单(不白跑 30 分钟)
  const dropped: DroppedSymbol[] = (asked ?? []).filter(stockLike).map((symbol) => ({ symbol, reason: 'stock_like' as const }));
  const symbols = asked?.filter((x) => !stockLike(x));
  if (asked && !symbols!.length) throw new ServiceInputError('symbols_not_tradable', `${asked.map(base).join(', ')}: stock tokens or leveraged ETFs are not covered by crypto strategy research; please pass crypto symbols`);
  let timeframes: string[];
  if (p['timeframes'] !== undefined) {
    const xs = Array.isArray(p['timeframes']) ? p['timeframes'].map(String) : String(p['timeframes']).split(/[,，\s]+/);
    timeframes = [...new Set(xs.map(normTimeframe).filter(Boolean))];
  } else {
    timeframes = REPORT_TIMEFRAMES.filter((tf) => new RegExp(`(?<![\\d.])${tf}(?![a-z])`, 'i').test(text));
    if (!timeframes.length) timeframes = /短线|日内|short[\s-]?term|intraday/i.test(text) ? ['15m'] : /长线|long[\s-]?term/i.test(text) ? ['1d'] : ['4h'];
  }
  if (!timeframes.length || timeframes.length > 2 || timeframes.some((tf) => !(REPORT_TIMEFRAMES as readonly string[]).includes(tf))) throw new ServiceInputError('timeframes_invalid', 'timeframes: pick 1–2 of 15m / 4h / 1d');
  let families: string[] | undefined;
  if (p['families'] !== undefined) {
    families = (Array.isArray(p['families']) ? p['families'].map(String) : String(p['families']).split(/[,，\s]+/)).map((f) => f.trim().toLowerCase().replace(/[\s-]+/g, '_')).filter(Boolean);
    if (!families.length || families.some((f) => !(SINGLE_ASSET_FAMILIES as readonly string[]).includes(f))) throw new ServiceInputError('families_invalid', `families must be from ${SINGLE_ASSET_FAMILIES.join(' / ')}`);
  }
  const market = marketIn(p['market'], text);
  let sides: ('long' | 'short')[] | undefined;
  if (p['sides'] !== undefined) {
    const raw = (Array.isArray(p['sides']) ? p['sides'].map(String) : String(p['sides']).split(/[,，\s]+/)).filter((x) => x.trim());
    // Long / BUY / bullish 和 both 都认;认不出的还是拒
    const xs = raw.flatMap((x) => /^(both|all|long[\s/&_-]*short)$/i.test(x.trim()) ? ['long', 'short'] : [(() => { try { return sideIn(x, '') ?? x; } catch { return x; } })()]);
    if (!xs.length || xs.some((s) => s !== 'long' && s !== 'short')) throw new ServiceInputError('sides_invalid', 'sides must be long or short');
    if (market === 'spot' && xs.includes('short')) throw new ServiceInputError('sides_invalid', 'Spot cannot be shorted');
    sides = [...new Set(xs)] as ('long' | 'short')[];
  }
  return { ...(symbols ? { symbols } : {}), timeframes, ...(families ? { families } : {}), ...(sides ? { sides } : {}), market, ...(dropped.length ? { dropped } : {}) };
}

export interface MatrixRun { view: MatrixViewLike | null; reused_from: string | null; recommendation_id: string | null; dropped: DroppedSymbol[] }

/**
 * 跑(或复用)一次矩阵研究并等到结束;返回研究视图与复用/推荐来源、被剔除的币,渲染交给调用方。
 * 显式给的币全部 OKX 不可交易 → view=null(不建研究),由调用方交付「未开跑」说明。
 */
export async function runMatrix(job: PerCallJob, params: MatrixReportParams, deps: ServiceDeps): Promise<MatrixRun> {
  const svc = deps.matrix();
  if (!svc) throw new Error('matrix_study_unavailable');
  let symbols = params.symbols, recommendation_id: string | null = null;
  const dropped: DroppedSymbol[] = [...(params.dropped ?? [])];
  if (symbols) {
    // 买方点名的币也要过 OKX 可交易判定(判定本身出错按可交易处理,不因快照问题误拒)
    const tradable = (deps as AssetHorizonDeps).tradable;
    const ok = (s: string) => { try { return tradable ? tradable(s, params.market) : true; } catch { return true; } };
    for (const s of symbols) if (!ok(s)) dropped.push({ symbol: s, reason: 'not_tradable' });
    symbols = symbols.filter(ok);
    if (!symbols.length) return { view: null, reused_from: null, recommendation_id: null, dropped };
  } else {
    const rec = await deps.recommend({ market: params.market, top_n: 8 });
    recommendation_id = rec.id;
    // 与资产×周期推荐同口径:剔除股票代币/杠杆 ETF、OKX 不可交易的标的和日线状态未知的币
    const tradable = (deps as AssetHorizonDeps).tradable;
    symbols = rec.rows.filter((r) => r.regime !== null && !stockLike(r.symbol) && (tradable ? tradable(r.symbol, params.market) : true) && Object.values(r.horizons).some((f) => f.eligible)).map((r) => r.symbol).slice(0, REPORT_MAX_SYMBOLS);
    if (!symbols.length) throw new ServiceInputError('no_symbols', 'No researchable assets in the asset × horizon picks; please pass symbols');
  }
  const spec = {
    symbols, timeframes: params.timeframes, market: params.market, arms: ['code'],
    window_days: Object.fromEntries(params.timeframes.map((tf) => [tf, EVIDENCE_WINDOW_DAYS[tf as keyof typeof EVIDENCE_WINDOW_DAYS] ?? (DEFAULT_WINDOW_DAYS as Record<string, number>)[tf]])),
    ...(params.families ? { families: params.families } : {}), ...(params.sides ? { sides: params.sides } : {}),
    budget: { max_variants: 300, max_judge_calls: 0, max_judge_usd: '0', wall_clock_ms: 1_800_000 },
    auto_finalize: true,
  };
  let id: string, reused_from: string | null = null;
  const create = (s: Record<string, unknown>) => svc.create({ spec: s, idempotency_key: `asp_job:${job.job_id}` }).id;
  try {
    try { id = create(spec); }
    catch (e) {
      // 变体超预算:收窄到前 3 个策略族再试一次(规格固定、可复现)
      if (!/^budget_max_variants_exceeded/.test((e as Error).message) || params.families) throw e;
      id = create({ ...spec, families: SINGLE_ASSET_FAMILIES.slice(0, 3) });
    }
  } catch (e) {
    const m = /^holdout_range_already_used:([^:]+):/.exec((e as Error).message);
    if (!m) throw new Error(`matrix_create_failed:${(e as Error).message}`);
    id = m[1]!; reused_from = id;
  }
  const view = await waitFor(svc, id, deps);
  return { view, reused_from, recommendation_id, dropped };
}

async function waitFor(svc: NonNullable<ReturnType<ServiceDeps['matrix']>>, id: string, deps: ServiceDeps): Promise<MatrixViewLike> {
  const poll = deps.poll_ms ?? 5000, limit = deps.matrix_timeout_ms ?? 40 * 60_000, start = deps.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let resumed = false;
  for (;;) {
    const v = svc.get(id);
    // 被网关重启打断的研究续跑一次,别把半成品当报告交付
    if (v.status === 'interrupted' && svc.resume && !resumed) { resumed = true; try { svc.resume(id); } catch { /* 续跑失败就按 interrupted 交付进度说明 */ } await sleep(poll); continue; }
    if (DONE.includes(v.status)) return v;
    if (deps.now() - start > limit) throw new Error(`matrix_timeout:${id}:${v.status}:${v.progress.done}/${v.progress.total}`);
    await sleep(poll);
  }
}


// ---------------------------------------------------------------- 渲染

/** 视图里报告要读、但 MatrixViewLike 没列的字段(运行时 detail 视图都有;缺了就按缺省渲染) */
type Score = ScoreLike & { expectancy?: number | null; stressed_return?: number | null; exposure_matched_hold?: number | null; days?: number };
interface Gate { name: string; ok: boolean; value: number | null }
interface HoldoutTest { days: number; blocks: number; mean_daily: number | null; p_value: number | null; holm_threshold: number | null; rejected: boolean }
interface CellX { id: string; symbol: string; timeframe: string; family: string; side: string; arm: string; applicability: string; result: { verdict: string; cause: string | null; selection: Score | null; train?: Score | null; gates?: Gate[]; dsr?: number | null; tier?: string; scorecard?: { score?: { value?: number; label?: string }; luck?: { luck_probability?: number | null } } | null } | null }
interface FinalistX { id: string; symbol: string; timeframe: string; family: string; side: string; arm: string; passed: boolean | null; cause?: string | null; selection?: Score; holdout?: Score | null; test?: HoldoutTest | null; portfolio?: { total_return: number; max_drawdown: number; trades: number } | null }
interface ProtocolX { evidence_mode: string; alpha: number; min_trades: number; block_days?: number; min_blocks?: number; bootstrap_replicates?: number; max_drawdown?: number; min_dsr?: number }
type Window = { from_ms: number; to_ms: number };

const DAY_MS = 86_400_000;
const TF_MS: Record<string, number> = { '3m': 180_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': DAY_MS };
/** 平均每笔至少占这么多根 K 线(趋势/突破族的保守估计):选择段根数 < 最少笔数 × 它 → 该周期证据必然偏薄 */
const BARS_PER_TRADE = 10;
const RANK: Record<string, number> = { pass: 2, near: 1, fail: 0 };
const DROP_TEXT = (market: string): Record<DroppedSymbol['reason'], string> => ({ stock_like: 'stock token / leveraged ETF, not covered by crypto strategy research', not_tradable: `no tradable ${MARKET_TEXT[market] ?? market} on OKX right now` });
const nTrades = (n: number) => `${n} trade${n === 1 ? '' : 's'}`;
const signed = (x: number | null | undefined) => x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${pct(x)}`;
const pv = (x: number | null | undefined) => x === null || x === undefined || !Number.isFinite(x) ? '—' : x < 0.0001 ? '<0.0001' : x.toFixed(4);
const stopText = (r: string) => /wall_clock/.test(r) ? 'wall-clock limit reached' : /variants/.test(r) ? 'variant budget used up' : /judge/.test(r) ? 'judge budget used up' : /cancel/i.test(r) ? 'cancelled' : r;

/** 被剔除的币一行(没有就不出) */
export function droppedLine(dropped: readonly DroppedSymbol[], market: string): string[] {
  if (!dropped.length) return [];
  const t = DROP_TEXT(market), by = (r: DroppedSymbol['reason']) => dropped.filter((d) => d.reason === r).map((d) => base(d.symbol));
  const parts = (['stock_like', 'not_tradable'] as const).filter((r) => by(r).length).map((r) => `${by(r).join(', ')} (${t[r]})`);
  return [`Dropped: ${parts.join('; ')}`];
}

/** 选择段门槛没过的项 → 英文(带数值) */
function gateText(g: Gate, p: ProtocolX): string {
  const n = g.name, v = g.value, th = /(?:>=|<=)([\d.]+)$/.exec(n)?.[1];
  if (n.startsWith('selection_trades')) return `trades ${v ?? 0}/${th ?? p.min_trades}`;
  if (n.startsWith('selection_blocks')) return `time blocks ${v ?? 0}/${th ?? p.min_blocks ?? '—'}`;
  if (n === 'expectancy>0') return 'expectancy per trade not positive';
  if (n === 'net_return>0') return 'net return after fees not positive';
  if (n === 'stress_2x>0') return 'not profitable at 2× fees';
  if (n === 'beats_exposure_matched_hold') return `underperforms exposure-matched hold${v === null ? '' : ` (by ${signed(v)})`}`;
  if (n.startsWith('max_drawdown')) return `drawdown ${pct(v)} above the ${pct(th === undefined ? p.max_drawdown : Number(th))} cap`;
  if (n.startsWith('deflated_sharpe')) return `Deflated Sharpe ${num(v)} below ${th ?? p.min_dsr ?? '—'}`;
  if (n === 'not_evaluated') return 'no evaluation score';
  return `not evaluated (${stopText(n)})`;
}

/** 本次研究某周期的历史窗口(天):视图 spec.window_days 优先,缺了按引擎缺省 */
const windowOf = (v: MatrixViewLike, tf: string): number => (v.spec as { window_days?: Record<string, number> }).window_days?.[tf] ?? (DEFAULT_WINDOW_DAYS as Record<string, number>)[tf] ?? 0;
/** 选择段天数:有分段用分段,没有按窗口 × 选择段比例 */
const selectionDays = (v: MatrixViewLike, tf: string): number => {
  const w = (v as unknown as { segments?: Record<string, { selection?: Window } | undefined> }).segments?.[tf]?.selection;
  return w ? (w.to_ms - w.from_ms) / DAY_MS : windowOf(v, tf) * DEFAULT_SPLIT.selection;
};
const SAMPLE_GATE = /^selection_(?:trades|blocks)>=/, SIGNIFICANCE_GATE = /^deflated_sharpe>=/;
/** 候补最少选择段笔数(与引擎 scorecard CANDIDATE_MIN_TRADES 同值) */
const NEAR_MISS_MIN_TRADES = 5;

/** 每个周期选择段有多长、够不够撑起最少笔数 */
function thinEvidence(v: MatrixViewLike, cells: CellX[], p: ProtocolX): { timeframe: string; selection_days: number; selection_bars: number; max_trades: number | null }[] {
  const segs = (v as unknown as { segments?: Record<string, { selection?: Window } | undefined> }).segments ?? {};
  const out: { timeframe: string; selection_days: number; selection_bars: number; max_trades: number | null }[] = [];
  for (const tf of v.spec.timeframes) {
    const step = TF_MS[tf]; if (!step) continue;
    const w = segs[tf]?.selection, days = w ? (w.to_ms - w.from_ms) / DAY_MS : windowOf(v, tf) * DEFAULT_SPLIT.selection;
    const bars = Math.round(days * DAY_MS / step);
    if (bars >= p.min_trades * BARS_PER_TRADE) continue;
    const ts = cells.filter((c) => c.timeframe === tf && c.result?.selection).map((c) => c.result!.selection!.trades);
    out.push({ timeframe: tf, selection_days: Math.round(days), selection_bars: bars, max_trades: ts.length ? Math.max(...ts) : null });
  }
  return out;
}

export function matrixBody(v: MatrixViewLike, o: { reused_from: string | null; recommendation_id: string | null; dropped?: readonly DroppedSymbol[] }): { summary: string; lines: string[]; body: Record<string, unknown> } {
  const s = v.spec, c = v.conclusion, p = s.protocol as ProtocolX;
  const nearMin = Math.ceil(p.min_trades / 2);
  const allCells = (v.cells ?? []) as unknown as CellX[];
  const cells = allCells.filter((x) => x.applicability === 'applicable' && x.result);
  // near 要有最少笔数(最少笔数的一半):一两笔碰巧赚钱不能叫「接近门槛」
  const verdictOf = (x: CellX) => x.result!.verdict === 'near' && (x.result!.selection?.trades ?? 0) < nearMin ? 'fail' : x.result!.verdict;
  const verdicts = cells.reduce<Record<string, number>>((a, x) => { const k = verdictOf(x); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const fins = v.finalists as unknown as FinalistX[];
  const finalists = fins.map((f) => ({
    symbol: f.symbol, timeframe: f.timeframe, family: f.family, side: f.side, arm: f.arm, passed: f.passed, cause: f.cause ?? null,
    selection: f.selection ? score(f.selection) : null, holdout: f.holdout ? score(f.holdout) : null, test: f.test ?? null,
    portfolio: f.portfolio ? { total_return: f.portfolio.total_return, max_drawdown: f.portfolio.max_drawdown, trades: f.portfolio.trades } : null,
  }));
  const passed = finalists.filter((f) => f.passed === true);
  const completed = v.status === 'completed', released = completed && finalists.length > 0;
  const status = completed ? (c?.kind ?? 'no_candidate') : v.status;
  const mode = p.evidence_mode === 'historical_replay' ? ' (historical replay: this history has been seen before; forward validation is still required before live use)' : '';
  const failedGates = (x: CellX) => (x.result!.gates ?? []).filter((g) => !g.ok);
  const whyFailed = (x: CellX) => {
    const bad = failedGates(x).map((g) => gateText(g, p));
    return bad.length ? bad.join(', ') : CAUSE_TEXT[x.result!.cause ?? ''] ?? 'gate not met';
  };

  // ---- 近失格子(候补):收益 / 费用 / 回撤 / 同敞口持有都过了,只差样本数或显著性。引擎给了三档就用引擎的,旧视图按门槛自算
  const nearMiss = (x: CellX): boolean => {
    const r = x.result!;
    if (r.tier !== undefined) return r.tier === 'paper_candidate';
    const sel = r.selection, bad = failedGates(x);
    if (!sel || sel.trades < NEAR_MISS_MIN_TRADES || !(sel.total_return > 0) || !(sel.max_drawdown <= (p.max_drawdown ?? 0.35))) return false;
    return bad.length > 0 && bad.every((g) => SAMPLE_GATE.test(g.name) || SIGNIFICANCE_GATE.test(g.name));
  };
  const near = released ? [] : cells.filter(nearMiss)
    // 证据多的排前面:5 笔的高夏普几乎全是运气,头条给笔数最多的近失格子
    .sort((a, b) => (b.result!.selection?.trades ?? 0) - (a.result!.selection?.trades ?? 0) || (b.result!.selection?.sharpe ?? -Infinity) - (a.result!.selection?.sharpe ?? -Infinity) || a.id.localeCompare(b.id));
  const nearRows = near.slice(0, 5).map((x) => ({
    symbol: x.symbol, timeframe: x.timeframe, family: x.family, side: x.side, selection: score(x.result!.selection!),
    train: x.result!.train ? { total_return: x.result!.train.total_return, trades: x.result!.train.trades } : null,
    missing: failedGates(x).map((g) => gateText(g, p)), luck_probability: x.result!.scorecard?.luck?.luck_probability ?? null,
    score: x.result!.scorecard?.score?.value ?? null,
  }));

  // ---- 选择段前 3 格(没有 finalist 时回答「表现最好的是谁、为什么没过」)
  const ranked = cells.filter((x) => (x.result!.selection?.trades ?? 0) > 0)
    .sort((a, b) => (RANK[verdictOf(b)] ?? 0) - (RANK[verdictOf(a)] ?? 0) || (b.result!.selection!.sharpe ?? -Infinity) - (a.result!.selection!.sharpe ?? -Infinity) || b.result!.selection!.total_return - a.result!.selection!.total_return || a.id.localeCompare(b.id))
    .slice(0, 3);
  const top = ranked.map((x) => ({ symbol: x.symbol, timeframe: x.timeframe, family: x.family, side: x.side, verdict: verdictOf(x), cause: x.result!.cause, selection: score(x.result!.selection!), failed: whyFailed(x) }));
  const noScore = cells.filter((x) => !x.result!.selection).length;

  const summary = !completed
    ? `Matrix study ended early (${STATUS_TEXT[v.status] ?? v.status}${v.stop_reason ? `: ${stopText(v.stop_reason)}` : ''}); progress so far is shown below`
    : passed.length
      ? `${passed.length} ${passed.length === 1 ? 'strategy' : 'strategies'} passed the holdout test: ${passed.map(tag).join(', ')}`
      : finalists.length
        ? `All ${finalists.length} finalist${finalists.length === 1 ? '' : 's'} failed the holdout test`
        : `No cell passed the selection gate; holdout not released${nearRows.length
          ? `. ${near.length} near-miss cell${near.length === 1 ? '' : 's'} cleared the return, cost, drawdown and exposure-matched-hold checks and fell short only on sample size or significance; best: ${tag(nearRows[0]!)} (selection ${signed(nearRows[0]!.selection.total_return)}, ${nTrades(nearRows[0]!.selection.trades)})`
          : top.length ? `. Closest cell: ${tag(top[0]!)} (selection ${signed(top[0]!.selection.total_return)}, ${nTrades(top[0]!.selection.trades)}), failed on ${top[0]!.failed}` : ''}`;

  // ---- 前置提示:周期证据偏薄;窗口加长的设计说明
  const thin = thinEvidence(v, allCells, p);
  const thinLines = thin.map((t) => `Note: the ${t.timeframe} selection segment covers only ~${t.selection_days} days (≈${t.selection_bars} bars), so reaching ${p.min_trades} trades per cell is hard and ${t.timeframe} evidence will be thin${t.max_trades !== null ? ` (max ${t.max_trades} trades in any ${t.timeframe} cell this run)` : ''}. An "insufficient evidence" verdict here reflects sample size, not a falsified strategy`);
  const windows = s.timeframes.map((tf) => ({ timeframe: tf, days: windowOf(v, tf), default_days: (DEFAULT_WINDOW_DAYS as Record<string, number>)[tf] ?? null, selection_days: Math.round(selectionDays(v, tf)) }));
  const extended = windows.filter((w) => w.default_days !== null && w.days > w.default_days);
  const designLines = extended.length ? [`Design: history windows were lengthened beyond the engine defaults so each selection segment can in principle reach ${p.min_trades} trades${p.min_blocks ? ` and ${p.min_blocks} ${p.block_days ?? 5}-day blocks` : ''}: ${extended.map((w) => `${w.timeframe} ${w.days} days (default ${w.default_days}; selection ≈${w.selection_days} days)`).join(', ')}. Evidence thresholds are unchanged`] : [];

  // ---- 每个周期的证据量
  const evidence = s.timeframes.map((tf) => {
    const cs = cells.filter((x) => x.timeframe === tf && x.result!.selection), ts = cs.map((x) => x.result!.selection!.trades).sort((a, b) => a - b);
    const days = selectionDays(v, tf);
    return { timeframe: tf, selection_days: Math.round(days), blocks: p.block_days ? Math.floor(days / p.block_days) : null, min_blocks: p.min_blocks ?? null, cells: cs.length, reached_min_trades: ts.filter((n) => n >= p.min_trades).length, median_trades: ts.length ? ts[Math.floor((ts.length - 1) / 2)]! : null, max_trades: ts.length ? ts.at(-1)! : null, net_positive: cs.filter((x) => x.result!.selection!.total_return > 0).length };
  }).filter((e) => e.cells > 0);
  const evidenceLines = evidence.map((e) => `Evidence ${e.timeframe}: selection ≈${e.selection_days} days${e.blocks !== null ? ` (${e.blocks} of ${e.min_blocks ?? '—'} required ${p.block_days}-day blocks)` : ''} · ${e.reached_min_trades}/${e.cells} cells reached ${p.min_trades} trades · median ${e.median_trades ?? '—'} trades, max ${e.max_trades ?? '—'} · ${e.net_positive}/${e.cells} cells net positive after fees`);

  const lines: string[] = [
    ...thinLines,
    ...designLines,
    ...droppedLine(o.dropped ?? [], s.market),
    `Scope: ${s.symbols.map(base).join(', ')}${o.recommendation_id ? ' (no symbols given; took the top researchable coins from the asset × horizon picks)' : ''} · timeframes ${s.timeframes.join('/')} · ${MARKET_TEXT[s.market] ?? s.market} · families ${s.families.map((f) => FAMILY_TEXT[f] ?? f).join(', ')} · sides ${s.sides.map((x) => SIDE_TEXT[x] ?? x).join('/')} · pure code rules, no LLM`,
    `Cells: ${cells.length} evaluated (asset × timeframe × family × side), ${Object.entries(verdicts).sort(([a], [b]) => (RANK[b] ?? -1) - (RANK[a] ?? -1)).map(([k, n]) => `${VERDICT_TEXT[k] ?? k} ${n}`).join(' · ') || '—'}${noScore ? `; ${noScore} cell${noScore === 1 ? '' : 's'} had no selection score (not enough bars, evaluation error or budget used up)` : ''}`,
    ...(c && Object.values(c.causes).some((n) => n > 0) ? [`Main fail causes: ${Object.entries(c.causes).filter(([, n]) => n > 0).map(([k, n]) => `${CAUSE_TEXT[k] ?? k} ${n}`).join(' · ')}${(c.causes['insufficient_evidence'] ?? 0) > 0 ? ' (insufficient evidence = too few trades or time blocks in the selection segment, not a falsified strategy)' : ''}`] : []),
    ...evidenceLines,
  ];

  if (nearRows.length) {
    lines.push(`Near misses (${near.length}): positive after fees, ahead of exposure-matched hold and within the drawdown cap in the selection segment, but short on sample size and/or significance. Candidates for forward (paper) observation, not validated strategies:`);
    for (const n of nearRows) lines.push(`· ${tag(n)}: selection ${signed(n.selection.total_return)} · Sharpe ${num(n.selection.sharpe)} · max drawdown ${pct(n.selection.max_drawdown)} · ${nTrades(n.selection.trades)}${n.train ? ` · training segment ${signed(n.train.total_return)} over ${nTrades(n.train.trades)}${n.train.total_return < 0 ? ' (negative in training: inconsistent across segments)' : ''}` : ''} — short of: ${n.missing.join(', ') || 'final holdout slot'}${n.luck_probability !== null && Number.isFinite(n.luck_probability) ? n.luck_probability >= 0.995 ? ' · after adjusting for the number of variants tried, this selection result is statistically indistinguishable from luck at this sample size' : ` · after adjusting for the number of variants tried, ~${pct(n.luck_probability, 0)} chance the selection result is luck` : ''}`);
  }

  const holmDesc = `Holm step-down correction, family-wise error rate α=${p.alpha} (one-sided${p.block_days ? `, block bootstrap with ${p.block_days}-day blocks` : ''}${p.bootstrap_replicates ? `, ${p.bootstrap_replicates} resamples` : ''})`;
  if (released) {
    lines.push(`Finalists: ${finalists.length} (all selection gates passed), each tested once on the holdout segment:`);
    for (const f of finalists.slice(0, 6)) {
      const h = f.holdout, t = f.test;
      lines.push(`· ${f.passed ? '✓ Passed' : f.passed === false ? '✗ Failed' : '… Undecided'} ${tag(f)}${f.cause ? ` (${CAUSE_TEXT[f.cause] ?? f.cause})` : ''}`);
      lines.push(h
        ? `  Holdout: return ${signed(h.total_return)}${h.exposure_matched_hold !== undefined && h.exposure_matched_hold !== null ? ` · exposure-matched hold ${signed(h.exposure_matched_hold)}` : ''}${h.stressed_return !== undefined && h.stressed_return !== null ? ` · at 2× fees ${signed(h.stressed_return)}` : ''} · Sharpe ${num(h.sharpe)} · max drawdown ${pct(h.max_drawdown)} · win rate ${pct(h.win_rate)} · ${nTrades(h.trades)}`
        : '  Holdout: evaluation failed, no score (treated as failed)');
      lines.push(t
        ? `  Multiple testing: p=${pv(t.p_value)} · Holm threshold ${pv(t.holm_threshold)} · ${t.rejected ? 'null rejected (significant after correction)' : 'null not rejected (not significant after correction)'} · ${t.days} days / ${t.blocks} blocks`
        : '  Multiple testing: no test result (no holdout score or too few trades)');
      if (f.portfolio) lines.push(`  Portfolio replay: return ${signed(f.portfolio.total_return)} · max drawdown ${pct(f.portfolio.max_drawdown)} · ${nTrades(f.portfolio.trades)}`);
    }
    lines.push(`Multiple testing: ${finalists.length} finalist${finalists.length === 1 ? '' : 's'} tested together, ${holmDesc}; passing also requires ≥${p.min_trades} holdout trades, positive returns after fees and at 2× fees, beating exposure-matched hold${p.max_drawdown !== undefined ? `, and drawdown ≤${pct(p.max_drawdown, 0)}` : ''}`);
  } else {
    if (top.length) {
      lines.push(`Top ${top.length} selection cell${top.length === 1 ? '' : 's'}${completed ? ' (none passed the selection gate)' : ''}:`);
      for (const t of top) lines.push(`· ${tag(t)}: selection return ${signed(t.selection.total_return)} · Sharpe ${num(t.selection.sharpe)} · max drawdown ${pct(t.selection.max_drawdown)} · ${nTrades(t.selection.trades)} — failed on: ${t.failed}`);
    } else if (cells.length) lines.push('Selection: no cell produced any trade in the selection segment (0 trades); no candidates to list');
    lines.push(completed
      ? 'Holdout & multiple testing: no cell passed the selection gate, so the holdout was not released (data still sealed and unseen) and the Holm multiple-testing correction was not run — the correction only applies to finalists that pass selection, and there were none'
      : 'Holdout & multiple testing: the study did not finish; holdout not released and Holm correction not run');
  }
  const conclusion = !completed ? null
    : passed.length ? `${passed.length} ${passed.length === 1 ? 'strategy' : 'strategies'} passed the Holm-corrected holdout test: ${passed.map(tag).join(', ')}${mode}`
      : finalists.length ? `all ${finalists.length} finalist${finalists.length === 1 ? '' : 's'} failed the holdout test; no robust strategy found${mode}`
        : `no strategy passed the gates: none of the ${cells.length} evaluable cells passed the selection gate${c?.not_applicable ? `; another ${c.not_applicable} cell${c.not_applicable === 1 ? ' was' : 's were'} not applicable (holding period does not fit the window)` : ''}${near.length ? `; ${near.length} near-miss cell${near.length === 1 ? '' : 's'} (sample size / significance only) listed above` : ''}${mode}`;

  // ---- 下一步(按本次结果给具体动作)
  const qfam = (f: string): QuickFamily | null => (f in FAMILY_EXAMPLE ? f as QuickFamily : null);
  const example = (x: { symbol: string; timeframe: string; family: string; side: string }) => { const f = qfam(x.family); return f ? `${FAMILY_EXAMPLE[f](base(x.symbol), x.timeframe, x.side === 'short')}${s.market === 'perp' && x.side !== 'short' ? ', perp' : ''}` : null; };
  const steps: string[] = [];
  if (passed.length) steps.push(`Forward-test the passing ${passed.length === 1 ? 'strategy' : 'strategies'} on paper before any live use; this is historical replay evidence`);
  if (nearRows.length) {
    steps.push(`Paper-watch the near-miss cells and re-test once they have ${p.min_trades}+ selection-quality trades; until then they are candidates, not validated strategies`);
    const ex = example(nearRows[0]!);
    if (ex) steps.push(`Look at the best near miss over its full history with a Strategy Backtest Quick order (same family, default parameters), e.g. "${ex}"`);
  } else if (!passed.length && top.length) {
    const ex = example(top[0]!);
    if (ex) steps.push(`The closest cell (${tag(top[0]!)}) failed on ${top[0]!.failed}; a Strategy Backtest Quick order such as "${ex}" shows its full-history record`);
  }
  // 结构上过不了门槛的周期:笔数够不着(偏薄提示或本次没有一格到 min_trades)或时间块不够
  const starvedWhy = new Map<string, string>();
  for (const t of thin) starvedWhy.set(t.timeframe, `no cell can reach ${p.min_trades} trades in the selection segment`);
  for (const e of evidence) {
    if (e.reached_min_trades === 0 && !starvedWhy.has(e.timeframe)) starvedWhy.set(e.timeframe, `no cell reached ${p.min_trades} trades in the selection segment (max ${e.max_trades ?? 0})`);
    if (e.blocks !== null && e.min_blocks !== null && e.blocks < e.min_blocks) starvedWhy.set(e.timeframe, `${starvedWhy.has(e.timeframe) ? `${starvedWhy.get(e.timeframe)} and ` : ''}the selection segment has only ${e.blocks} of ${e.min_blocks} required ${p.block_days}-day blocks`);
  }
  for (const [tf, why] of starvedWhy) {
    const alt = ['4h', '15m'].filter((x) => x !== tf && !starvedWhy.has(x));
    steps.push(`${tf}: ${why}, so ${tf} cells cannot pass by construction; read them as descriptive only${alt.length ? `, or use ${alt.join(' or ')} for a statistically testable answer` : ', or order again: the service now runs longer history windows for this reason'}`);
  }
  const costCells = c?.causes['cost_dominated'] ?? 0;
  if (costCells > 0) steps.push(`Fees ate the edge in ${costCells} cell${costCells === 1 ? '' : 's'}; slower timeframes (fewer trades per day) reduce the fee drag`);
  if (!passed.length && s.families.length * s.sides.length > 4) {
    const fams = [...new Set([...nearRows, ...top].map((x) => x.family))].slice(0, 2);
    if (fams.length) steps.push(`Every extra family or side adds trials and raises the Deflated Sharpe bar; a narrower follow-up (families ${fams.map((f) => FAMILY_TEXT[f] ?? f).join(', ')}) makes the same edge easier to confirm`);
  }
  if (!steps.length) steps.push('No family showed a positive edge after costs on these assets and timeframes; try other assets or timeframes rather than tuning these rules');

  lines.push(
    ...(conclusion ? [`Conclusion: ${conclusion}`] : []),
    ...(completed ? [`Next steps: ${steps.map((x, i) => `(${i + 1}) ${x}`).join('; ')}`] : []),
    ...(o.reused_from ? [`Note: today's holdout for this asset pool was already consumed by study ${o.reused_from}; a holdout can only be viewed once, so this report reuses that study's results`] : []),
    `Evidence: ${EVIDENCE_TEXT[p.evidence_mode] ?? p.evidence_mode}; significance α=${p.alpha}, at least ${p.min_trades} trades per cell, "near threshold" needs at least ${nearMin} trades`,
    'Method: train / selection / holdout split; Deflated Sharpe gate on selection, Holm correction + block bootstrap on holdout, released once; includes a 2× fee stress test',
  );
  return { summary, lines, body: {
    study_id: v.id, status, study_status: v.status, reused_from: o.reused_from, recommendation_id: o.recommendation_id,
    manifest_hash: v.manifest_hash, protocol_hash: v.protocol_hash, created_at: v.created_at, finished_at: v.updated_at,
    scope: { symbols: s.symbols, timeframes: s.timeframes, families: s.families, market: s.market, sides: s.sides, arms: s.arms },
    design: { window_days: Object.fromEntries(windows.map((w) => [w.timeframe, w.days])), default_window_days: Object.fromEntries(windows.map((w) => [w.timeframe, w.default_days])), extended: extended.length > 0, thresholds_changed: false },
    dropped_symbols: o.dropped ?? [],
    protocol: s.protocol, conclusion: c ? { kind: c.kind, finalist_ids: c.finalist_ids, causes: c.causes, not_applicable: c.not_applicable, research_only: c.research_only, near_misses: near.length, text: conclusion ?? 'study not finished' } : null, cell_verdicts: verdicts, near_min_trades: nearMin, thin_evidence: thin,
    evidence_by_timeframe: evidence, near_misses: nearRows, next_steps: completed ? steps : [],
    holdout: { released, multiple_testing: released ? 'holm' : 'not_run', alpha: p.alpha, k: finalists.length },
    selection_top: released ? [] : top,
    cells: cells.map((x) => ({ symbol: x.symbol, timeframe: x.timeframe, family: x.family, side: x.side, verdict: verdictOf(x), ...(verdictOf(x) !== x.result!.verdict ? { engine_verdict: x.result!.verdict } : {}), cause: x.result!.cause, near_miss: nearMiss(x), selection: x.result!.selection ? score(x.result!.selection) : null, failed_on: failedGates(x).map((g) => gateText(g, p)) })),
    finalists, usage: { judge_calls: v.usage.judge_calls, judge_usd: v.usage.judge_usd, wall_ms: v.usage.wall_ms },
    anchor: { chain: 'xlayer', status: 'not_anchored' },
    method: 'Train / selection / holdout split; Deflated Sharpe gate on selection, Holm-corrected block bootstrap on holdout, released once; includes a 2× fee stress test',
  } };
}

/** 显式给的币在 OKX 全部不可交易:不建研究,如实说明 */
export function notRunBody(params: MatrixReportParams, dropped: readonly DroppedSymbol[]): { summary: string; lines: string[]; body: Record<string, unknown> } {
  return {
    summary: 'Not run: none of the requested symbols is tradable on OKX',
    lines: [
      ...droppedLine(dropped, params.market),
      `Note: no study was created and nothing was replayed, so there are no holdout results and no multiple-testing results. To run it, order again with crypto symbols that have a ${MARKET_TEXT[params.market] ?? params.market} market on OKX, or leave symbols empty to use the asset × horizon picks`,
    ],
    body: { status: 'not_run', study_id: null, requested: { symbols: dropped.map((d) => d.symbol), timeframes: params.timeframes, market: params.market }, dropped_symbols: dropped },
  };
}

const score = (x: Score) => ({
  trades: x.trades, total_return: x.total_return, sharpe: x.sharpe, max_drawdown: x.max_drawdown, win_rate: x.win_rate,
  ...(x.stressed_return !== undefined ? { stressed_return: x.stressed_return } : {}), ...(x.exposure_matched_hold !== undefined ? { exposure_matched_hold: x.exposure_matched_hold } : {}),
});
