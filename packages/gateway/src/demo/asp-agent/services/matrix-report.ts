/**
 * 服务二「策略矩阵研究报告」:跑一次小规模矩阵研究(资产 × 周期 × 策略族 × 方向,纯代码臂,零模型花费),
 * 训练/选择/留出三段,留出只看一次;返回结论、finalist 的留出成绩与组合回放,报告 JSON 的 sha256 可锚定到 X Layer。
 *
 * 规模上限(按次服务要可预期):≤3 个资产、≤2 个周期(15m / 4h / 1d)、预算 ≤300 个变体、墙钟 ≤30 分钟。
 * 没给资产 → 先跑一次「资产×周期推荐」,取推荐里前 3 个可研究的资产。
 * 同一资产池当天留出段已被用过(另一个买家或重试)→ 不重跑,复用那次研究的结果并在报告里写明(留出只能看一次)。
 * 上链锚定不在这里做:报告只带 anchor.status = 'not_anchored',锚定动作要人批。
 */
import { SINGLE_ASSET_FAMILIES } from '../../research/matrix-study/types.js';
import { freeText, jsonParams, marketIn, symbolList, symbolsIn } from './params.js';
import { NOT_COIN } from './quick-backtest.js';
import { deliverable, num, pct } from './render.js';
import { ServiceInputError, type Deliverable, type MatrixViewLike, type PerCallJob, type PerCallService, type ServiceDeps } from './types.js';

export const REPORT_TIMEFRAMES = ['15m', '4h', '1d'] as const;
export const REPORT_MAX_SYMBOLS = 3;
export interface MatrixReportParams { symbols?: string[]; timeframes: string[]; families?: string[]; sides?: ('long' | 'short')[]; market: 'spot' | 'perp' }

const DONE = ['completed', 'cancelled', 'failed', 'interrupted', 'ready_to_finalize'];
const FAMILY_TEXT: Record<string, string> = { breakout: '突破', ma_trend: '均线趋势', ema_cross: 'EMA 交叉', pullback: '回调', mean_reversion: '均值回归', smc: 'SMC' };
const CAUSE_TEXT: Record<string, string> = { cost_dominated: '成本吃掉收益', insufficient_evidence: '证据不足', unsupported_execution: '执行不支持', underperform_hold: '跑输持有' };

/** 完整矩阵档的输入校验(research_report tier=full 与旧 matrix_report 共用) */
export function validateMatrix(job: PerCallJob): MatrixReportParams {
  const p = jsonParams(job) ?? {}, text = freeText(job);
  const fromText = symbolsIn(text.replace(NOT_COIN, ' '), REPORT_MAX_SYMBOLS + 1);
  const symbols = symbolList(p['symbols'], REPORT_MAX_SYMBOLS) ?? (fromText.length ? fromText : undefined);
  if (symbols && symbols.length > REPORT_MAX_SYMBOLS) throw new ServiceInputError('symbols_too_many', `一次最多研究 ${REPORT_MAX_SYMBOLS} 个资产 / at most ${REPORT_MAX_SYMBOLS} symbols per report`);
  let timeframes: string[];
  if (p['timeframes'] !== undefined) {
    const xs = Array.isArray(p['timeframes']) ? p['timeframes'].map(String) : String(p['timeframes']).split(/[,，\s]+/);
    timeframes = [...new Set(xs.filter(Boolean))];
  } else {
    timeframes = REPORT_TIMEFRAMES.filter((tf) => new RegExp(`(?<![\\d.])${tf}(?![a-z])`, 'i').test(text));
    if (!timeframes.length) timeframes = /短线|日内|short[\s-]?term|intraday/i.test(text) ? ['15m'] : /长线|long[\s-]?term/i.test(text) ? ['1d'] : ['4h'];
  }
  if (!timeframes.length || timeframes.length > 2 || timeframes.some((tf) => !(REPORT_TIMEFRAMES as readonly string[]).includes(tf))) throw new ServiceInputError('timeframes_invalid', 'timeframes 只能选 1–2 个:15m / 4h / 1d');
  let families: string[] | undefined;
  if (p['families'] !== undefined) {
    families = Array.isArray(p['families']) ? p['families'].map(String) : String(p['families']).split(/[,，\s]+/).filter(Boolean);
    if (!families.length || families.some((f) => !(SINGLE_ASSET_FAMILIES as readonly string[]).includes(f))) throw new ServiceInputError('families_invalid', `families 只能是 ${SINGLE_ASSET_FAMILIES.join(' / ')}`);
  }
  const market = marketIn(p['market'], text);
  let sides: ('long' | 'short')[] | undefined;
  if (p['sides'] !== undefined) {
    const xs = Array.isArray(p['sides']) ? p['sides'].map(String) : String(p['sides']).split(/[,，\s]+/).filter(Boolean);
    if (!xs.length || xs.some((s) => s !== 'long' && s !== 'short')) throw new ServiceInputError('sides_invalid', 'sides 只能是 long / short');
    if (market === 'spot' && xs.includes('short')) throw new ServiceInputError('sides_invalid', '现货不能做空 / spot cannot short');
    sides = [...new Set(xs)] as ('long' | 'short')[];
  }
  return { ...(symbols ? { symbols } : {}), timeframes, ...(families ? { families } : {}), ...(sides ? { sides } : {}), market };
}

/** 跑(或复用)一次矩阵研究并等到结束;返回研究视图与复用/推荐来源,渲染交给调用方 */
export async function runMatrix(job: PerCallJob, params: MatrixReportParams, deps: ServiceDeps): Promise<{ view: MatrixViewLike; reused_from: string | null; recommendation_id: string | null }> {
  const svc = deps.matrix();
  if (!svc) throw new Error('matrix_study_unavailable');
  let symbols = params.symbols, recommendation_id: string | null = null;
  if (!symbols) {
    const rec = await deps.recommend({ market: params.market, top_n: 8 });
    recommendation_id = rec.id;
    symbols = rec.rows.filter((r) => Object.values(r.horizons).some((f) => f.eligible)).map((r) => r.symbol).slice(0, REPORT_MAX_SYMBOLS);
    if (!symbols.length) throw new ServiceInputError('no_symbols', '推荐里没有可研究的资产,请指定 symbols / no eligible assets, please pass symbols');
  }
  const spec = {
    symbols, timeframes: params.timeframes, market: params.market, arms: ['code'],
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
  return { view, reused_from, recommendation_id };
}

async function waitFor(svc: NonNullable<ReturnType<ServiceDeps['matrix']>>, id: string, deps: ServiceDeps): Promise<MatrixViewLike> {
  const poll = deps.poll_ms ?? 5000, limit = deps.matrix_timeout_ms ?? 40 * 60_000, start = deps.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const v = svc.get(id);
    if (DONE.includes(v.status)) return v;
    if (deps.now() - start > limit) throw new Error(`matrix_timeout:${id}:${v.status}:${v.progress.done}/${v.progress.total}`);
    await sleep(poll);
  }
}

export function matrixBody(v: MatrixViewLike, o: { reused_from: string | null; recommendation_id: string | null }): { summary: string; lines: string[]; body: Record<string, unknown> } {
  const s = v.spec, c = v.conclusion;
  const finalists = v.finalists.map((f) => ({
    symbol: f.symbol, timeframe: f.timeframe, family: f.family, side: f.side, arm: f.arm, passed: f.passed, cause: f.cause ?? null,
    selection: f.selection ? score(f.selection) : null, holdout: f.holdout ? score(f.holdout) : null,
    portfolio: f.portfolio ? { total_return: f.portfolio.total_return, max_drawdown: f.portfolio.max_drawdown, trades: f.portfolio.trades } : null,
  }));
  const cells = (v.cells ?? []).filter((x) => x.applicability === 'applicable' && x.result);
  const verdicts = cells.reduce<Record<string, number>>((a, x) => { const k = x.result!.verdict; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const passed = finalists.filter((f) => f.passed === true);
  const status = v.status === 'completed' ? (c?.kind ?? 'no_candidate') : v.status;
  const summary = v.status !== 'completed'
    ? `矩阵研究未完成(${v.status}${v.stop_reason ? `:${v.stop_reason}` : ''}),返回已有进度 / Study ended early`
    : passed.length
      ? `留出段通过 ${passed.length} 个策略 / ${passed.length} strategy(ies) passed holdout: ${passed.map((f) => `${f.symbol.replace(/USDT$/, '')} ${f.timeframe} ${FAMILY_TEXT[f.family] ?? f.family} ${f.side}`).join('、')}`
      : '没有找到在留出段站得住的策略 / No strategy survived the holdout test';
  const lines = [
    `范围 / Scope: ${s.symbols.join(', ')} · ${s.timeframes.join('/')} · ${s.market} · 族 ${s.families.map((f) => FAMILY_TEXT[f] ?? f).join('/')} · ${s.sides.join('/')} · 纯代码臂 code-only`,
    `格子 / Cells: ${cells.length} 个评估,${Object.entries(verdicts).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}`,
    ...(c && Object.values(c.causes).some((n) => n > 0) ? [`不合格主因 / Fail causes: ${Object.entries(c.causes).filter(([, n]) => n > 0).map(([k, n]) => `${CAUSE_TEXT[k] ?? k} ${n}`).join(' · ')}`] : []),
    ...finalists.slice(0, 6).map((f) => `· ${f.passed ? '✓' : '✗'} ${f.symbol} ${f.timeframe} ${FAMILY_TEXT[f.family] ?? f.family} ${f.side}: 留出 holdout 收益 ${pct(f.holdout?.total_return)} · 夏普 ${num(f.holdout?.sharpe)} · 回撤 ${pct(f.holdout?.max_drawdown)} · ${f.holdout?.trades ?? 0} 笔`),
    ...(c?.text ? [`结论 / Conclusion: ${c.text}`] : []),
    ...(o.reused_from ? [`说明:同一资产池当日的留出段已被研究 ${o.reused_from} 使用,留出只能看一次,本报告复用该研究结果 / Holdout already consumed today; reusing study ${o.reused_from}`] : []),
    `证据类型 / Evidence: ${s.protocol.evidence_mode}(α=${s.protocol.alpha},最少 ${s.protocol.min_trades} 笔)`,
  ];
  return { summary, lines, body: {
    study_id: v.id, status, study_status: v.status, reused_from: o.reused_from, recommendation_id: o.recommendation_id,
    manifest_hash: v.manifest_hash, protocol_hash: v.protocol_hash, created_at: v.created_at, finished_at: v.updated_at,
    scope: { symbols: s.symbols, timeframes: s.timeframes, families: s.families, market: s.market, sides: s.sides, arms: s.arms },
    protocol: s.protocol, conclusion: c, cell_verdicts: verdicts,
    cells: cells.map((x) => ({ symbol: x.symbol, timeframe: x.timeframe, family: x.family, side: x.side, verdict: x.result!.verdict, cause: x.result!.cause, selection: x.result!.selection ? score(x.result!.selection) : null })),
    finalists, usage: { judge_calls: v.usage.judge_calls, judge_usd: v.usage.judge_usd, wall_ms: v.usage.wall_ms },
    anchor: { chain: 'xlayer', status: 'not_anchored' },
    method: '训练/选择/留出三段,选择段 Deflated Sharpe 门槛,留出段 Holm 校正 + 块 bootstrap,只释放一次;含 2 倍费率压力 / train-selection-holdout with DSR and Holm-corrected block bootstrap',
  } };
}

const score = (x: { trades: number; total_return: number; sharpe: number | null; max_drawdown: number; win_rate: number | null }) =>
  ({ trades: x.trades, total_return: x.total_return, sharpe: x.sharpe, max_drawdown: x.max_drawdown, win_rate: x.win_rate });
