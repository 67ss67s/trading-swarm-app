/**
 * 矩阵研究规格:请求体 → 完整 MatrixStudySpec(缺省值、校验、推荐预填)。跑前一次做完,之后只读。
 * 推荐预填只取 eligible 格子(HORIZON_TIMEFRAMES 映射到本首版支持的周期;1h/12h 不在首版矩阵里,写进 notes)。
 */
import type { StrategyJudge } from '@trading-swarm/contracts';
import { hash } from '../primitives.js';
import type { FamilyKey } from '../batch/families.js';
import type { FrozenModelProfile } from '../judge/types.js';
import { HORIZON_TIMEFRAMES, type AssetRecommendation, type Horizon } from '../../recommend.js';
import { usdUnits } from './stats.js';
import { ALL_FAMILIES, MATRIX_TIMEFRAMES, type MatrixArm, type MatrixProtocol, type MatrixSide, type MatrixStudySpec, type MatrixTimeframe } from './types.js';

const DAY = 86_400_000;
export const DEFAULT_WINDOW_DAYS: Record<MatrixTimeframe, number> = { '3m': 30, '5m': 45, '15m': 180, '4h': 730, '1d': 1460 };
export const DEFAULT_SPLIT = { train: 0.6, selection: 0.2, holdout: 0.2 } as const;
export const DEFAULT_PURGE_BARS = 24;
export const DEFAULT_ITERATE = { top_k: 3, generations: 3, candidates_per_generation: 4, patience: 2 } as const;
export const DEFAULT_BUDGET = { max_variants: 300, max_judge_calls: 20000, max_judge_usd: '1', wall_clock_ms: 1_800_000 } as const;
export const DEFAULT_PROTOCOL: MatrixProtocol = { version: 'matrix_v1', alpha: 0.025, min_trades: 30, block_days: 5, min_blocks: 20, bootstrap_replicates: 999, max_drawdown: 0.35, min_effect: 0, min_dsr: 0.95, seed: 20260925, evidence_mode: 'historical_replay', boundary: 'mtm_truncate_v1' };
export const MAX_SYMBOLS = 6;

/**
 * 缺省判断要素(§9.53 C 的 DEFAULT_JUDGE 形状,按 contracts StrategyJudge 写):
 *   take(是否按规则入场合理,是/否)+ quality(有序四档);follow = P(take=yes) − 0.02 ≥ 0.55 且 P(quality=poor) + 0.02 ≤ 0.5。
 * 阈值在研究开始前冻结,验证与留出段不改。model_profile_ref 绑定到本次冻结的模型配置。
 */
export function defaultJudge(profile_ref: string): StrategyJudge {
  const fields = ['candidate.direction', 'candidate.stop_distance_atr', 'candidate.reward_risk', 'features.trend', 'features.volatility', 'features.volume_ratio'] as const;
  return {
    version: 1, engine: 'jev', model_profile_ref: profile_ref, state_schema_version: 'judge_state_v1',
    questions: [
      { key: 'take', type: 'noul', instructions: '按这条策略的规则,此刻按给定的入场、止损和目标开仓是否合理', criteria: ['趋势、波动与盈亏比支持这笔入场', '状态与策略前提不符或盈亏比不足'], state_fields: [...fields] as [typeof fields[number], ...typeof fields[number][]] },
      { key: 'quality', type: 'score', instructions: '这笔候选的整体质量', criteria: ['差:前提明显不成立', '一般:勉强成立', '好:前提成立', '很好:多项证据一致'], labels: ['poor', 'fair', 'good', 'excellent'], state_fields: [...fields] as [typeof fields[number], ...typeof fields[number][]] },
    ],
    rule: { all: [{ question_key: 'take', label: 'yes', operator: 'gte', threshold: 0.55, margin: 0.02 }, { question_key: 'quality', label: 'poor', operator: 'lte', threshold: 0.5, margin: 0.02 }] },
    on_uncertain: 'skip', on_error: 'skip', timeout_ms: 10_000, max_attempts: 1,
  } as StrategyJudge;
}

const obj = (v: unknown, name: string): Record<string, unknown> => { if (v === undefined || v === null) return {}; if (typeof v !== 'object' || Array.isArray(v)) throw Error(`${name}_invalid`); return v as Record<string, unknown>; };
const int = (v: unknown, name: string, lo: number, hi: number, dflt: number): number => { if (v === undefined) return dflt; if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw Error(`${name}_invalid`); return v; };
const numIn = (v: unknown, name: string, lo: number, hi: number, dflt: number): number => { if (v === undefined) return dflt; if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw Error(`${name}_invalid`); return v; };
const list = <T extends string>(v: unknown, name: string, allowed: readonly T[], dflt: T[], max: number): T[] => {
  if (v === undefined) return dflt;
  if (!Array.isArray(v) || !v.length || v.length > max || v.some((x) => !allowed.includes(x as T))) throw Error(`${name}_invalid`);
  return [...new Set(v as T[])];
};
export const normSymbol = (s: string): string => { const u = s.trim().toUpperCase().replace(/[-_/]/g, '').replace(/SWAP$/, ''); return u.endsWith('USDT') ? u : `${u}USDT`; };
/** 研究谱系:同一资产池 + 市场视为同一研究主题(改名 / 新建 Study 不重置试验历史) */
export const programIdOf = (symbols: string[], market: string) => `prog_${hash({ symbols: [...symbols].sort(), market }).slice(0, 16)}`;
export const defaultToMs = (now: number) => Math.floor(now / DAY) * DAY - 1;

function profileOf(v: unknown): FrozenModelProfile | null {
  if (v === undefined || v === null) return null;
  const p = obj(v, 'model_profile'), keys = ['ref', 'connection_id', 'connection_revision', 'model', 'model_revision', 'routing', 'parser_version', 'max_call_usd', 'retry_policy'];
  if (Object.keys(p).some((k) => !keys.includes(k)) || keys.some((k) => typeof p[k] !== 'string' || !(p[k] as string).length)) throw Error('model_profile_invalid');
  if (p.parser_version !== 'judge_answers_v1' || p.retry_policy !== 'none') throw Error('model_profile_invalid');
  usdUnits(p.max_call_usd as string);
  return p as unknown as FrozenModelProfile;
}

export interface SpecContext { now: number; recommendation?: AssetRecommendation | null; model_profile?: FrozenModelProfile | null }

/** 推荐 → 规格草稿:只取 eligible 格子;短线 3m/5m 保留(矩阵里标 research_only),1h/12h 不在首版周期表里 */
export function prefillFromRecommendation(r: AssetRecommendation): { spec: Partial<MatrixStudySpec>; notes: string[] } {
  const notes: string[] = [], symbols: string[] = [], tfs = new Set<MatrixTimeframe>(), fams = new Set<FamilyKey>(), sides = new Set<MatrixSide>();
  const market = r.rows[0]?.market ?? 'perp';
  for (const row of r.rows) {
    let any = false;
    for (const h of Object.keys(row.horizons) as Horizon[]) {
      const f = row.horizons[h];
      if (!f.eligible) continue;
      any = true;
      for (const tf of HORIZON_TIMEFRAMES[h]) { if ((MATRIX_TIMEFRAMES as readonly string[]).includes(tf)) tfs.add(tf as MatrixTimeframe); else notes.push(`${tf} 不在首版矩阵周期里(${h} 档用 ${HORIZON_TIMEFRAMES[h].filter((x) => (MATRIX_TIMEFRAMES as readonly string[]).includes(x)).join('/') || '无'})`); }
      for (const fam of f.families) fams.add(fam);
      if (f.direction === 'long' || f.direction === 'both') sides.add('long');
      if ((f.direction === 'short' || f.direction === 'both') && row.market === 'perp') sides.add('short');
    }
    if (any && symbols.length < MAX_SYMBOLS) symbols.push(row.symbol);
  }
  if (r.rows.filter((x) => Object.values(x.horizons).some((f) => f.eligible)).length > MAX_SYMBOLS) notes.push(`推荐里可研究的资产超过 ${MAX_SYMBOLS} 个,只取前 ${MAX_SYMBOLS} 个`);
  if (!symbols.length) notes.push('推荐卡上没有任何 eligible 格子,无法预填');
  return { spec: { symbols, timeframes: [...tfs].sort((a, b) => MATRIX_TIMEFRAMES.indexOf(a) - MATRIX_TIMEFRAMES.indexOf(b)), families: [...fams], sides: sides.size ? [...sides] : ['long'], market, recommendation_id: r.id }, notes: [...new Set(notes)] };
}

/** 请求体(spec 片段 + 可选 recommendation_id)→ 完整规格;未知字段报错,不静默丢 */
export function normalizeSpec(raw: unknown, ctx: SpecContext): MatrixStudySpec {
  const b0 = obj(raw, 'spec');
  const known = new Set(['auto_finalize', 'portfolio', 'origin', 'research_program_id', 'symbols', 'timeframes', 'families', 'market', 'sides', 'arms', 'judge', 'model_profile', 'window_days', 'to_ms', 'split', 'purge_bars', 'iterate', 'budget', 'protocol', 'recommendation_id']);
  const extra = Object.keys(b0).filter((k) => !known.has(k));
  if (extra.length) throw Error(`unknown_fields:${extra.join(',')}`);
  let b = b0;
  if (b0.recommendation_id !== undefined && b0.recommendation_id !== null) {
    if (typeof b0.recommendation_id !== 'string') throw Error('recommendation_id_invalid');
    if (!ctx.recommendation || ctx.recommendation.id !== b0.recommendation_id) throw Error('recommendation_not_found');
    b = { ...prefillFromRecommendation(ctx.recommendation).spec, ...b0 };
  }
  const market = b.market === undefined ? 'perp' : b.market;
  if (market !== 'spot' && market !== 'perp') throw Error('market_invalid');
  if (!Array.isArray(b.symbols) || !b.symbols.length || b.symbols.length > MAX_SYMBOLS || b.symbols.some((s) => typeof s !== 'string' || !/^[A-Za-z0-9_/-]{2,24}$/.test(s))) throw Error('symbols_invalid');
  const symbols = [...new Set((b.symbols as string[]).map(normSymbol))];
  const timeframes = list(b.timeframes, 'timeframes', MATRIX_TIMEFRAMES, ['15m', '4h', '1d'], 5);
  const families = list(b.families, 'families', ALL_FAMILIES, ['breakout', 'ma_trend', 'ema_cross', 'pullback', 'mean_reversion', 'smc'], 8);
  const sides = list<MatrixSide>(b.sides, 'sides', ['long', 'short'], market === 'perp' ? ['long', 'short'] : ['long'], 2);
  const arms = list<MatrixArm>(b.arms, 'arms', ['code', 'code_judge'], ['code', 'code_judge'], 2);
  const model_profile = b.model_profile === undefined ? ctx.model_profile ?? null : profileOf(b.model_profile);
  let judge: StrategyJudge | null = null;
  if (b.judge !== undefined && b.judge !== null) judge = obj(b.judge, 'judge') as unknown as StrategyJudge;
  else if (arms.includes('code_judge') && model_profile) judge = defaultJudge(model_profile.ref);
  if (judge && model_profile && judge.model_profile_ref !== model_profile.ref) throw Error('judge_model_profile_ref_mismatch');
  const wd = obj(b.window_days, 'window_days'), window_days: Partial<Record<MatrixTimeframe, number>> = {};
  for (const tf of timeframes) window_days[tf] = int(wd[tf], `window_days.${tf}`, 30, 3650, DEFAULT_WINDOW_DAYS[tf]);
  const to_ms = int(b.to_ms, 'to_ms', 0, 9_007_199_254_740_991, defaultToMs(ctx.now));
  if (to_ms > ctx.now) throw Error('to_ms_in_future');
  const sp = obj(b.split, 'split'), split = { train: numIn(sp.train, 'split.train', 0.2, 0.9, DEFAULT_SPLIT.train), selection: numIn(sp.selection, 'split.selection', 0.05, 0.5, DEFAULT_SPLIT.selection), holdout: numIn(sp.holdout, 'split.holdout', 0.05, 0.5, DEFAULT_SPLIT.holdout) };
  if (Math.abs(split.train + split.selection + split.holdout - 1) > 1e-9) throw Error('split_must_sum_to_1');
  const it = obj(b.iterate, 'iterate'), iterate = { top_k: int(it.top_k, 'iterate.top_k', 1, 3, DEFAULT_ITERATE.top_k), generations: int(it.generations, 'iterate.generations', 0, 3, DEFAULT_ITERATE.generations), candidates_per_generation: int(it.candidates_per_generation, 'iterate.candidates_per_generation', 1, 8, DEFAULT_ITERATE.candidates_per_generation), patience: int(it.patience, 'iterate.patience', 1, 3, DEFAULT_ITERATE.patience) };
  const bu = obj(b.budget, 'budget');
  if (bu.max_judge_usd !== undefined && typeof bu.max_judge_usd !== 'string') throw Error('budget.max_judge_usd_must_be_decimal_string');
  const max_judge_usd = bu.max_judge_usd === undefined ? DEFAULT_BUDGET.max_judge_usd : bu.max_judge_usd as string;
  usdUnits(max_judge_usd);
  const budget = { max_variants: int(bu.max_variants, 'budget.max_variants', 1, 300, DEFAULT_BUDGET.max_variants), max_judge_calls: int(bu.max_judge_calls, 'budget.max_judge_calls', 0, 20000, DEFAULT_BUDGET.max_judge_calls), max_judge_usd, wall_clock_ms: int(bu.wall_clock_ms, 'budget.wall_clock_ms', 1000, 14_400_000, DEFAULT_BUDGET.wall_clock_ms) };
  const pr = obj(b.protocol, 'protocol');
  const unknownP = Object.keys(pr).filter((k) => !(k in DEFAULT_PROTOCOL));
  if (unknownP.length) throw Error(`protocol_unknown_fields:${unknownP.join(',')}`);
  const protocol: MatrixProtocol = {
    version: 'matrix_v1', boundary: 'mtm_truncate_v1',
    alpha: numIn(pr.alpha, 'protocol.alpha', 0.001, 0.05, DEFAULT_PROTOCOL.alpha),
    min_trades: int(pr.min_trades, 'protocol.min_trades', 30, 100000, DEFAULT_PROTOCOL.min_trades),
    block_days: int(pr.block_days, 'protocol.block_days', 1, 365, DEFAULT_PROTOCOL.block_days),
    min_blocks: int(pr.min_blocks, 'protocol.min_blocks', 10, 100000, DEFAULT_PROTOCOL.min_blocks),
    bootstrap_replicates: int(pr.bootstrap_replicates, 'protocol.bootstrap_replicates', 199, 10000, DEFAULT_PROTOCOL.bootstrap_replicates),
    max_drawdown: numIn(pr.max_drawdown, 'protocol.max_drawdown', 0.01, 0.35, DEFAULT_PROTOCOL.max_drawdown),
    min_effect: numIn(pr.min_effect, 'protocol.min_effect', 0, 1, DEFAULT_PROTOCOL.min_effect),
    min_dsr: numIn(pr.min_dsr, 'protocol.min_dsr', 0.9, 0.999, DEFAULT_PROTOCOL.min_dsr),
    seed: int(pr.seed, 'protocol.seed', 0, 2_147_483_647, DEFAULT_PROTOCOL.seed),
    evidence_mode: pr.evidence_mode === undefined ? DEFAULT_PROTOCOL.evidence_mode : pr.evidence_mode === 'unseen_holdout' || pr.evidence_mode === 'historical_replay' ? pr.evidence_mode : (() => { throw Error('protocol.evidence_mode_invalid'); })(),
  };
  const pf = obj(b.portfolio, 'portfolio'), og = obj(b.origin, 'origin');
  if (Object.keys(pf).some((k) => k !== 'risk_pct' && k !== 'max_open')) throw Error('portfolio_unknown_fields');
  if (Object.keys(og).some((k) => k !== 'chat_session_id')) throw Error('origin_unknown_fields');
  const research_program_id = b.research_program_id === undefined ? programIdOf(symbols, market) : String(b.research_program_id);
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(research_program_id)) throw Error('research_program_id_invalid');
  return {
    research_program_id, symbols, timeframes, families, market, sides, arms, judge, model_profile, window_days, to_ms, split,
    purge_bars: int(b.purge_bars, 'purge_bars', 0, 5000, DEFAULT_PURGE_BARS), iterate, budget, protocol,
    recommendation_id: typeof b.recommendation_id === 'string' ? b.recommendation_id : null,
    auto_finalize: b.auto_finalize === undefined ? true : typeof b.auto_finalize === 'boolean' ? b.auto_finalize : (() => { throw Error('auto_finalize_invalid'); })(),
    portfolio: { risk_pct: numIn(pf.risk_pct, 'portfolio.risk_pct', 0.01, 5, 0.5), max_open: int(pf.max_open, 'portfolio.max_open', 1, 30, 3) },
    origin: { chat_session_id: og.chat_session_id === undefined || og.chat_session_id === null ? null : typeof og.chat_session_id === 'string' && og.chat_session_id.length <= 200 ? og.chat_session_id : (() => { throw Error('origin.chat_session_id_invalid'); })() },
  };
}
