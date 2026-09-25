/**
 * 进化页(#evolution)的只读聚合:按 UTC 日给九个角色各算一格 good/ok/bad/none。
 * 契约:docs/design/evolution-floor-2026-09-23.md §二~§四。零模型、只读、不写任何表、不加迁移。
 *
 * 结构:
 *   loadEvolutionData(db, from, to)  —— 唯一碰数据库的地方;表或列不存在时该源记空并记进 missing
 *   indexEvolution(data)             —— 按 UTC 日分桶
 *   roleDay(role, idx, date)         —— 每个角色一个纯函数,产出当天 score / headline / metrics / records / events
 *   classify(spec, raw, baseline)    —— 颜色只看「当天已结算」的 score:绝对线 + 自己最近 14 天基线
 *
 * 颜色优先级:绝对坏线 → 明显差于基线 → 绝对好线 → 明显好于基线 → ok。
 * 基线 = 该角色此前 14 个 UTC 日里 score 非空的日子;不足 5 天只用绝对线,明细里注明「基线不足」。
 */
import type { DatabaseSync } from 'node:sqlite';

export const EVOLUTION_VERSION = 'evolution/v1';
export type EvoStatus = 'good' | 'ok' | 'bad' | 'none';
export type EvoRole =
  | 'thread_manager' | 'radar' | 'strategy_lab' | 'portfolio_manager' | 'risk_sentinel'
  | 'executor' | 'reviewer' | 'gate_captain' | 'asp_agent';
export const EVO_ROLES: EvoRole[] = ['thread_manager', 'radar', 'strategy_lab', 'portfolio_manager', 'risk_sentinel', 'executor', 'reviewer', 'gate_captain', 'asp_agent'];
export type EvoEventKind = 'memory_proposed' | 'memory_activated' | 'strategy_promoted' | 'improve_candidate' | 'prompt_version' | 'param_probe';

const DAY_MS = 86_400_000;
/** 基线窗口:该角色自己最近 14 个 UTC 日。 */
export const BASELINE_WINDOW_DAYS = 14;
/** 基线有效天数门槛:不足就只按绝对线判。 */
export const BASELINE_MIN_DAYS = 5;
/** 缺省区间:最近 90 天;单次最多 366 天。 */
export const DEFAULT_RANGE_DAYS = 90;
export const MAX_RANGE_DAYS = 366;
/** day 明细里 records 的上限。 */
export const MAX_RECORDS = 50;

// ---------------------------------------------------------------- 阈值(口径写在注释里)

/** 判断:score = 已结算判断「模型 R − 机械对照 R」的簇均值(同一线程/簇多行先平均)。判断日归属(episode.at)。 */
export const TM = {
  /** 可比对(模型腿与机械腿都有 R)的行少于这个数不判色。 */
  MIN_PAIRED: 3,
  /** 绝对好线:模型比机械对照多赚 ≥ 0.10R。 */
  GOOD_R: 0.1,
  /** 绝对坏线:模型比机械对照少 ≥ 0.25R。 */
  BAD_R: -0.25,
  /** 与基线均值的差超过 ±0.15R 才算「明显」。 */
  BAND_R: 0.15,
} as const;

/** 雷达:score = 当天各次筛选前 TOP_K 名候选里,在卡片有效期(ttl)内被判断跟进(WATCH/PROPOSE)的比例。 */
export const RADAR = {
  TOP_K: 8,
  /** 绝对好线:一半以上的头部候选被跟进。 */
  GOOD_FOLLOW: 0.5,
  BAND: 0.15,
} as const;

/** 策略实验台:score = 当天研究工作的完成率(问询/研究 run/改进环/lab 实验;cancelled、在跑的不进分母)。 */
export const LAB = {
  /** 绝对坏线:完成率 < 50%。 */
  BAD_COMPLETION: 0.5,
  BAND: 0.2,
} as const;
/** 改进环候选里算「过门槛」的状态(baseline 代除外)。 */
const IMPROVE_PASSED = new Set(['evaluated', 'validated', 'champion', 'parent', 'explore_parent']);

/** 组合:score = 当天账户收益 − BTC 持有收益(小数)。 */
export const PM = {
  /** 相邻两条权益记录变动超过 5% 视为出入金,不计入收益。 */
  TRANSFER_STEP: 0.05,
  /** 绝对坏线:账户当天 ≤ −3%(与 daily_loss_stop_pct 默认值同口径),或跑输 BTC ≥ 2 个百分点。 */
  BAD_DAY_RETURN: -0.03,
  BAD_EXCESS: -0.02,
  /** 绝对好线:跑赢 BTC ≥ 1 个百分点。 */
  GOOD_EXCESS: 0.01,
  BAND: 0.01,
} as const;

/** 风控:score = 当天新出现的 high/critical 告警(按 fingerprint 去重)条数,越少越好。 */
export const RISK = {
  /** 绝对坏线:任何 critical,或 high 去重后 ≥ 5 条。 */
  BAD_HIGH: 5,
  BAND: 3,
} as const;

/** 执行:score = 1 − 交易所接口报错占当天 episode 的比例;有下单时另看执行失败率。 */
export const EXEC = {
  /** 绝对坏线:执行失败率 > 10%,或接口报错占比 > 10%。 */
  BAD_FAIL_RATE: 0.1,
  BAD_API_SHARE: 0.1,
  BAND: 0.05,
} as const;
/** 交易所接口报错(不含模型报错)。 */
export const EXCHANGE_ERROR_RE = /\/api\/v5\/|\bokx\b|ECONNRESET|EHOSTDOWN|ETIMEDOUT|ENOTFOUND|Service temporarily unavailable|Code:\s*5\d{4}/i;
/** 模型/大脑报错,排除出交易所口径。 */
const MODEL_ERROR_RE = /^(pi|claude|codex)\b|GLM|Coding Plan|timed out after \d+ms/i;
const INTENT_FAIL_RE = /fail|reject|error|unknown|expired/i;

/** 复盘:score = 当天提出的教训(kind=lesson)里,现在已被采纳(active/superseded)的比例。 */
export const REVIEW = {
  GOOD_ADOPT: 0.5,
  BAND: 0.25,
} as const;

/** 指挥:score = 空转比例 = 调了模型但「票池为空的扫描」或「代码只允许 HOLD 的复查」占调用数,越低越好。 */
export const CAPTAIN = {
  /** 绝对坏线:空转 ≥ 80%。 */
  BAD_IDLE: 0.8,
  /** 绝对好线:空转 ≤ 30%。 */
  GOOD_IDLE: 0.3,
  BAND: 0.1,
} as const;

/** 信号市场:score = 成功项 / 全部项(asp 巡检 run、入站投递解析、出站投递)。 */
export const ASP = {
  /** 绝对坏线:失败 > 10%。 */
  BAD_SUCCESS: 0.9,
  BAND: 0.1,
} as const;
const ASP_BAD_PARSE = new Set(['invalid', 'error', 'rejected', 'failed']);

interface RoleSpec { label: string; metric_label: string; higher_is_better: boolean; band: number; }
export const ROLE_SPECS: Record<EvoRole, RoleSpec> = {
  thread_manager: { label: '判断', metric_label: '已结算判断事后 R:模型 − 机械对照(簇均值,按判断日)', higher_is_better: true, band: TM.BAND_R },
  radar: { label: '雷达', metric_label: `前 ${RADAR.TOP_K} 名候选在有效期内被跟进(WATCH/PROPOSE)的比例;只有进了 watchlist 的币才可能被判断`, higher_is_better: true, band: RADAR.BAND },
  strategy_lab: { label: '策略实验台', metric_label: '研究/回测/改进环完成率;过门槛候选或晋升记为好', higher_is_better: true, band: LAB.BAND },
  portfolio_manager: { label: '组合', metric_label: '当天账户收益 − BTC 持有收益(剔除出入金)', higher_is_better: true, band: PM.BAND },
  risk_sentinel: { label: '风控', metric_label: '当天新增 high/critical 告警(fingerprint 去重),越少越好', higher_is_better: false, band: RISK.BAND },
  executor: { label: '执行', metric_label: '1 − 交易所接口报错占比;有下单时看执行失败率', higher_is_better: true, band: EXEC.BAND },
  reviewer: { label: '复盘', metric_label: '当天教训提案的采纳率(kind=lesson)', higher_is_better: true, band: REVIEW.BAND },
  gate_captain: { label: '指挥', metric_label: '模型调用空转比例(票池为空的扫描 / 只许 HOLD 的复查),越低越好', higher_is_better: false, band: CAPTAIN.BAND },
  asp_agent: { label: '信号市场', metric_label: '信号收发与巡检运行成功率', higher_is_better: true, band: ASP.BAND },
};

// ---------------------------------------------------------------- 输出类型

export interface EvoMetric { key: string; label: string; value: number | string | null; unit?: string }
export interface EvoRecord { at: number; kind: string; title: string; ref: string | null }
export interface EvoEvent { at: number; kind: EvoEventKind; title: string; ref: string | null }
/** 角色纯函数的产出(未判色)。 */
export interface RoleDayRaw {
  /** 用于判色与基线的当天数值;null = 当天没有可结算的结果。 */
  score: number | null;
  /** 当天是否有任何记录(没有 = none)。 */
  active: boolean;
  /** 绝对线命中。 */
  abs: 'good' | 'bad' | null;
  /** score 为空但有记录时的颜色(缺省 none)。 */
  idle_status?: 'ok' | 'none';
  headline: string;
  metrics: EvoMetric[];
  records: EvoRecord[];
  events: EvoEvent[];
}
export interface EvoBaseline { days: number; mean: number | null; note: string | null }
export interface EvoDayCell { date: string; status: EvoStatus; score: number | null; headline: string; events: number }
export interface EvoRoleRow {
  role: EvoRole; label: string; metric_label: string;
  days: EvoDayCell[];
  summary: { good: number; ok: number; bad: number; none: number; baseline_days: number };
}
export interface EvoToday {
  date: string;
  equity: string | null;
  equity_backend: string | null;
  equity_at: number | null;
  judgments: { used: number; cap: number | null; cost_cny: number; idle_share: number | null; model_calls: number; idle: number; basis: 'local_day'; since: number };
  live_pool: { size: number | null; reason: string; active_strategies: string[]; at: number | null };
  candidates: { open: number; settled: number; today_new: number };
}
export interface EvoDaily { version: string; from: string; to: string; roles: EvoRoleRow[]; today: EvoToday | null; missing_sources: string[] }
export interface EvoDayDetail {
  role: EvoRole; date: string; status: EvoStatus; score: number | null; headline: string;
  baseline: EvoBaseline;
  metrics: EvoMetric[];
  records: EvoRecord[];
  events: EvoEvent[];
}

// ---------------------------------------------------------------- 工具

export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export function dayStartMs(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid_date');
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || dayKey(ms) !== date) throw new Error('invalid_date');
  return ms;
}
export const addDays = (date: string, n: number): string => dayKey(dayStartMs(date) + n * DAY_MS);
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = dayStartMs(from), end = dayStartMs(to); t <= end; t += DAY_MS) out.push(dayKey(t));
  return out;
}
const round = (x: number, d = 4): number => { const f = 10 ** d; return Math.round(x * f) / f; };
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const share = (n: number, d: number): number | null => (d > 0 ? n / d : null);
const MINUS = '−';
const signed = (x: number, digits = 2): string => (x >= 0 ? '+' : MINUS) + Math.abs(x).toFixed(digits);
const fmtR = (x: number | null): string => (x === null ? '—' : `${signed(x)}R`);
const fmtPct = (x: number | null, digits = 0): string => (x === null ? '—' : `${(x * 100).toFixed(digits)}%`);
const fmtSignedPct = (x: number | null): string => (x === null ? '—' : `${signed(x * 100)}%`);
/** "≈¥0.022" → 0.022 */
export function parseCostCny(s: unknown): number {
  if (typeof s === 'number') return Number.isFinite(s) ? s : 0;
  if (typeof s !== 'string') return 0;
  const m = /(\d+(?:\.\d+)?)/.exec(s);
  return m ? Number(m[1]) : 0;
}
function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
const clip = (s: string | null | undefined, n = 80): string => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const desc = <T extends { at: number }>(xs: T[]): T[] => [...xs].sort((a, b) => b.at - a.at);

// ---------------------------------------------------------------- 数据行(只取用得到的列)

export interface EpisodeRow {
  id: string; at: number; status: string; action: string | null; symbol: string | null; node: string | null; thread_id: string | null;
  trigger_kind: string | null; prompt_version: string | null; cost: string | null; model_called: number;
  allowed: string | null; voting: number | null; gate_reason: string | null; error: string | null; headline: string | null;
}
export interface LedgerRow {
  episode_id: string; at: number; symbol: string; mode: string; thread_id: string | null; model_action: string | null; model_dir: string | null;
  outcome_r_model: number | null; outcome_r_mechanical: number | null; outcome_source_model: string | null; settled_at: number | null;
  cluster_id: string | null; settlement_status: string | null; mark: number | null; jsource: string | null;
}
export interface EquityRow { at: number; equity: number; backend: string }
export interface RiskRow { id: string; fingerprint: string; kind: string; severity: string; auto_action: string; title: string; first_seen_at: number; observed_count: number; resolved_at: number | null }
export interface ScreenRow { id: string; horizon: string; started_at: number; status: string; n_symbols: number; n_errors: number; cost_cny: number; error: string | null }
export interface WatchCandRow { screen_id: string; symbol: string; strategy_id: string; rank: number; fit_score: number; ttl_at: number; created_at: number }
export interface InquiryRow { id: string; created_at: number; task_kind: string; status: string; question: string }
export interface RunRow { id: string; created_at: number; status: string }
export interface BacktestRow { id: string; created_at: number; strategy_id: string | null }
export interface ImproveJobRow { id: string; created_at: number; status: string; strategy_id: string | null }
export interface ImproveCandRow { job_id: string; id: string; generator: string; status: string; created_at: number; rationale: string }
export interface ResearchStrategyEventRow { seq: number; strategy_id: string; at: number; kind: string; from_status: string | null; to_status: string | null; note: string }
export interface StrategyEventRow { strategy_id: string; version: number; at: number; who: string; kind: string; from_status: string | null; to_status: string | null; reason: string }
export interface ProbeRow { id: string; strategy_id: string; param: string; value: number; queued_at: number; status: string; checked_at: number | null }
export interface BotRunRow { id: string; role: string; routine: string; started_at: number; status: string; cost_cny: number; summary: string | null; error: string | null; result_json: string | null }
export interface MemoryRow { id: string; kind: string; status: string; created_at: number; proposed_by: string | null; content: string | null }
export interface MemoryEventRow { memory_id: string; at: number; kind: string; memory_kind: string | null; content: string | null }
export interface LessonRow { id: number; created_at: number; status: string | null }
export interface IntentRow { id: string; at: number; status: string; symbol: string | null }
export interface DeliveryInRow { delivery_id: string; received_at: number; parse_status: string; signal_type: string | null }
export interface DeliveryOutRow { event_id: string; job_id: string; status: string; updated_at: number }

export interface EvolutionData {
  from_ms: number; to_ms: number;
  episodes: EpisodeRow[]; ledger: LedgerRow[]; equity: EquityRow[]; equity_backend: string | null;
  risk: RiskRow[]; screens: ScreenRow[]; watch: WatchCandRow[];
  inquiries: InquiryRow[]; runs: RunRow[]; backtests: BacktestRow[]; improve_jobs: ImproveJobRow[]; improve_cands: ImproveCandRow[];
  rs_events: ResearchStrategyEventRow[]; strategy_events: StrategyEventRow[]; probes: ProbeRow[];
  bot_runs: BotRunRow[]; memory: MemoryRow[]; memory_events: MemoryEventRow[]; lessons: LessonRow[];
  intents: IntentRow[]; deliveries_in: DeliveryInRow[]; deliveries_out: DeliveryOutRow[];
  /** BTC 价格序列(demo_market_states.majors 的 BTCUSDT last + 判断账本 BTCUSDT 行的 mark),按时间升序。 */
  btc_marks: { at: number; price: number }[];
  /** prompt_version → 全库第一次出现的时刻(判断「当天换了 prompt 版本」)。 */
  prompt_first_seen: Record<string, number>;
  missing: string[];
}

function safeAll<T>(db: DatabaseSync, source: string, sql: string, params: (number | string)[], missing: string[]): T[] {
  try {
    return db.prepare(sql).all(...params) as unknown as T[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such (table|column)/i.test(msg)) { if (!missing.includes(source)) missing.push(source); return []; }
    throw e;
  }
}
function safeGet<T>(db: DatabaseSync, source: string, sql: string, params: (number | string)[], missing: string[]): T | undefined {
  return safeAll<T>(db, source, sql, params, missing)[0];
}

/**
 * 读 [fromMs, toMs) 内的行。只做 SELECT。雷达的跟进窗口会越过 toMs(候选 ttl),所以 episode/ledger 多读 3 天尾巴,
 * 分桶时再按日期截。
 */
export function loadEvolutionData(db: DatabaseSync, fromMs: number, toMs: number): EvolutionData {
  const missing: string[] = [];
  const tail = toMs + 3 * DAY_MS;
  const episodes = safeAll<EpisodeRow>(db, 'demo_episodes', `SELECT id, at, status, action,
      json_extract(json,'$.symbol') AS symbol, json_extract(json,'$.graph.node') AS node, json_extract(json,'$.thread_id') AS thread_id,
      json_extract(json,'$.trigger.kind') AS trigger_kind, json_extract(json,'$.prompt_version') AS prompt_version,
      json_extract(json,'$.usage.cost_estimate') AS cost, (json_extract(json,'$.usage') IS NOT NULL) AS model_called,
      json_extract(json,'$.holding_review.allowed_actions') AS allowed,
      json_array_length(json_extract(json,'$.strategy_council.consensus.voting')) AS voting,
      json_extract(json,'$.strategy_council.consensus.gate_reason') AS gate_reason,
      substr(json_extract(json,'$.error'),1,400) AS error, json_extract(json,'$.judgment.headline') AS headline
    FROM demo_episodes WHERE at >= ? AND at < ? ORDER BY at`, [fromMs, tail], missing);
  const ledger = safeAll<LedgerRow>(db, 'demo_judgment_ledger', `SELECT episode_id, at, symbol, mode, thread_id, model_action, model_dir,
      outcome_r_model, outcome_r_mechanical, outcome_source_model, settled_at,
      json_extract(json,'$.cluster_id') AS cluster_id, json_extract(json,'$.settlement_status') AS settlement_status,
      json_extract(json,'$.mark') AS mark, json_extract(json,'$.source') AS jsource
    FROM demo_judgment_ledger WHERE at >= ? AND at < ? ORDER BY at`, [fromMs - DAY_MS, tail], missing);
  const backendRow = safeGet<{ backend: string }>(db, 'demo_equity', 'SELECT backend FROM demo_equity ORDER BY at DESC LIMIT 1', [], missing);
  const equity_backend = backendRow?.backend ?? null;
  const equity = equity_backend === null ? [] : safeAll<EquityRow>(db, 'demo_equity', 'SELECT at, equity, backend FROM demo_equity WHERE backend = ? AND at >= ? AND at < ? ORDER BY at', [equity_backend, fromMs - DAY_MS, toMs], missing);
  const risk = safeAll<RiskRow>(db, 'demo_risk_alert', 'SELECT id, fingerprint, kind, severity, auto_action, title, first_seen_at, observed_count, resolved_at FROM demo_risk_alert WHERE first_seen_at >= ? AND first_seen_at < ?', [fromMs, toMs], missing);
  const screens = safeAll<ScreenRow>(db, 'demo_screen', `SELECT id, horizon, started_at, status, json_array_length(symbols_json) AS n_symbols, json_array_length(errors_json) AS n_errors, cost_cny, error
    FROM demo_screen WHERE started_at >= ? AND started_at < ?`, [fromMs, toMs], missing);
  const watch = safeAll<WatchCandRow>(db, 'demo_watch_candidate', 'SELECT screen_id, symbol, strategy_id, rank, fit_score, ttl_at, created_at FROM demo_watch_candidate WHERE created_at >= ? AND created_at < ?', [fromMs, toMs + DAY_MS], missing);
  const inquiries = safeAll<InquiryRow>(db, 'research_inquiries', 'SELECT id, created_at, task_kind, status, substr(question,1,200) AS question FROM research_inquiries WHERE created_at >= ? AND created_at < ?', [fromMs, toMs], missing);
  const runs = safeAll<RunRow>(db, 'research_runs', 'SELECT id, created_at, status FROM research_runs WHERE created_at >= ? AND created_at < ?', [fromMs, toMs], missing);
  const backtests = safeAll<BacktestRow>(db, 'research_backtests', 'SELECT id, created_at, strategy_id FROM research_backtests WHERE created_at >= ? AND created_at < ?', [fromMs, toMs], missing);
  const improve_jobs = safeAll<ImproveJobRow>(db, 'improve_jobs', 'SELECT id, created_at, status, strategy_id FROM improve_jobs WHERE created_at >= ? AND created_at < ?', [fromMs, toMs], missing);
  const improve_cands = safeAll<ImproveCandRow>(db, 'improve_candidates', 'SELECT job_id, id, generator, status, created_at, substr(rationale,1,200) AS rationale FROM improve_candidates WHERE created_at >= ? AND created_at < ?', [fromMs, toMs], missing);
  const rs_events = safeAll<ResearchStrategyEventRow>(db, 'research_strategy_events', 'SELECT seq, strategy_id, at, kind, from_status, to_status, note FROM research_strategy_events WHERE at >= ? AND at < ?', [fromMs, toMs], missing);
  const strategy_events = safeAll<StrategyEventRow>(db, 'demo_strategy_event', 'SELECT strategy_id, version, at, who, kind, from_status, to_status, substr(reason,1,200) AS reason FROM demo_strategy_event WHERE at >= ? AND at < ?', [fromMs, toMs], missing);
  const probes = safeAll<ProbeRow>(db, 'demo_lab_probe_queue', 'SELECT id, strategy_id, param, value, queued_at, status, checked_at FROM demo_lab_probe_queue WHERE queued_at >= ? AND queued_at < ?', [fromMs, toMs], missing);
  const bot_runs = safeAll<BotRunRow>(db, 'demo_bot_run', 'SELECT id, role, routine, started_at, status, cost_cny, summary, error, result_json FROM demo_bot_run WHERE started_at >= ? AND started_at < ?', [fromMs, toMs], missing);
  const memory = safeAll<MemoryRow>(db, 'demo_memory', `SELECT id, kind, status, created_at, json_extract(json,'$.proposed_by') AS proposed_by, substr(json_extract(json,'$.content'),1,200) AS content
    FROM demo_memory WHERE created_at >= ? AND created_at < ?`, [fromMs, toMs], missing);
  const memory_events = safeAll<MemoryEventRow>(db, 'demo_memory_events', `SELECT e.memory_id, e.at, e.kind, m.kind AS memory_kind, substr(json_extract(m.json,'$.content'),1,200) AS content
    FROM demo_memory_events e LEFT JOIN demo_memory m ON m.id = e.memory_id WHERE e.at >= ? AND e.at < ? AND e.kind IN ('approved','rejected')`, [fromMs, toMs], missing);
  const lessons = safeAll<LessonRow>(db, 'lessons', 'SELECT id, created_at, status FROM lessons WHERE created_at >= ? AND created_at < ?', [fromMs, toMs], missing);
  const intents = safeAll<IntentRow>(db, 'demo_intents', `SELECT id, at, status, json_extract(json,'$.symbol') AS symbol FROM demo_intents WHERE at >= ? AND at < ?`, [fromMs, toMs], missing);
  const deliveries_in = safeAll<DeliveryInRow>(db, 'okx_market_delivery_in', 'SELECT delivery_id, received_at, parse_status, signal_type FROM okx_market_delivery_in WHERE received_at >= ? AND received_at < ?', [fromMs, toMs], missing);
  const deliveries_out = safeAll<DeliveryOutRow>(db, 'okx_market_delivery_out_job', 'SELECT event_id, job_id, status, updated_at FROM okx_market_delivery_out_job WHERE updated_at >= ? AND updated_at < ?', [fromMs, toMs], missing);
  const firstSeen = safeAll<{ pv: string; first_at: number }>(db, 'demo_episodes', `SELECT json_extract(json,'$.prompt_version') AS pv, MIN(at) AS first_at FROM demo_episodes
    WHERE json_extract(json,'$.prompt_version') IS NOT NULL GROUP BY pv`, [], missing);
  const btcStates = safeAll<{ at: number; price: number | null }>(db, 'demo_market_states', `SELECT m.as_of AS at, CAST(json_extract(j.value,'$.last') AS REAL) AS price
    FROM demo_market_states m, json_each(json_extract(m.json,'$.majors')) j
    WHERE m.as_of >= ? AND m.as_of < ? AND json_extract(j.value,'$.symbol') = 'BTCUSDT'`, [fromMs - DAY_MS, toMs], missing);
  const btc_marks = [
    ...btcStates.filter((r) => typeof r.price === 'number' && r.price > 0).map((r) => ({ at: r.at, price: r.price! })),
    ...ledger.filter((r) => r.symbol === 'BTCUSDT' && typeof r.mark === 'number' && r.mark > 0 && r.at < toMs).map((r) => ({ at: r.at, price: r.mark! })),
  ].sort((a, b) => a.at - b.at);
  const prompt_first_seen: Record<string, number> = {};
  for (const r of firstSeen) prompt_first_seen[r.pv] = r.first_at;
  return {
    from_ms: fromMs, to_ms: toMs, episodes, ledger, equity, equity_backend, risk, screens, watch, inquiries, runs, backtests, improve_jobs, improve_cands,
    rs_events, strategy_events, probes, bot_runs, memory, memory_events, lessons, intents, deliveries_in, deliveries_out, btc_marks, prompt_first_seen, missing,
  };
}

// ---------------------------------------------------------------- 分桶

export interface EvolutionIndex {
  data: EvolutionData;
  by: <K extends keyof EvolutionData>(key: K, date: string) => EvolutionData[K] extends (infer R)[] ? R[] : never;
}
const AT_OF: Partial<Record<keyof EvolutionData, (r: never) => number>> = {
  episodes: (r: EpisodeRow) => r.at, ledger: (r: LedgerRow) => r.at, equity: (r: EquityRow) => r.at, risk: (r: RiskRow) => r.first_seen_at,
  screens: (r: ScreenRow) => r.started_at, watch: (r: WatchCandRow) => r.created_at, inquiries: (r: InquiryRow) => r.created_at,
  runs: (r: RunRow) => r.created_at, backtests: (r: BacktestRow) => r.created_at, improve_jobs: (r: ImproveJobRow) => r.created_at,
  improve_cands: (r: ImproveCandRow) => r.created_at, rs_events: (r: ResearchStrategyEventRow) => r.at, strategy_events: (r: StrategyEventRow) => r.at,
  probes: (r: ProbeRow) => r.queued_at, bot_runs: (r: BotRunRow) => r.started_at, memory: (r: MemoryRow) => r.created_at,
  memory_events: (r: MemoryEventRow) => r.at, lessons: (r: LessonRow) => r.created_at, intents: (r: IntentRow) => r.at,
  deliveries_in: (r: DeliveryInRow) => r.received_at, deliveries_out: (r: DeliveryOutRow) => r.updated_at,
} as Partial<Record<keyof EvolutionData, (r: never) => number>>;

export function indexEvolution(data: EvolutionData): EvolutionIndex {
  const cache = new Map<string, Map<string, unknown[]>>();
  const by = ((key: keyof EvolutionData, date: string) => {
    let m = cache.get(key);
    if (!m) {
      m = new Map();
      const at = AT_OF[key] as ((r: unknown) => number) | undefined;
      const rows = data[key];
      if (at && Array.isArray(rows)) for (const r of rows) { const k = dayKey(at(r)); const b = m.get(k); if (b) b.push(r); else m.set(k, [r]); }
      cache.set(key, m);
    }
    return m.get(date) ?? [];
  }) as EvolutionIndex['by'];
  return { data, by };
}

// ---------------------------------------------------------------- 共用:episode 判空转

const modeOf = (e: EpisodeRow): 'scan' | 'review' => (e.node?.startsWith('review') ? 'review' : e.node === 'scan' ? 'scan' : e.thread_id ? 'review' : 'scan');
/** 空转(判断链审计口径,handoff-2026-09-23-night 十-b):调了模型,但扫描时票池为空(没有策略能投票),或复查时代码只允许 HOLD。 */
export function isIdleCall(e: EpisodeRow): boolean {
  if (!e.model_called) return false;
  if (modeOf(e) === 'scan') return e.voting === 0;
  const allowed = parseJson<unknown>(e.allowed, null);
  return Array.isArray(allowed) && allowed.length === 1 && allowed[0] === 'HOLD';
}
export function idleStats(eps: EpisodeRow[]): { calls: number; idle: number; pool_empty: number; hold_only: number; share: number | null; cost: number } {
  let calls = 0, idle = 0, pool_empty = 0, hold_only = 0, cost = 0;
  for (const e of eps) {
    if (!e.model_called) continue;
    calls++; cost += parseCostCny(e.cost);
    if (isIdleCall(e)) { idle++; if (modeOf(e) === 'scan') pool_empty++; else hold_only++; }
  }
  return { calls, idle, pool_empty, hold_only, share: share(idle, calls), cost: round(cost, 4) };
}
const bySymbolCache = new WeakMap<EvolutionData, { eps: Map<string, EpisodeRow[]>; ledger: Map<string, LedgerRow[]> }>();
function bySymbol(data: EvolutionData): { eps: Map<string, EpisodeRow[]>; ledger: Map<string, LedgerRow[]> } {
  let c = bySymbolCache.get(data);
  if (!c) {
    c = { eps: new Map(), ledger: new Map() };
    for (const e of data.episodes) if (e.symbol) { const b = c.eps.get(e.symbol); if (b) b.push(e); else c.eps.set(e.symbol, [e]); }
    for (const r of data.ledger) { const b = c.ledger.get(r.symbol); if (b) b.push(r); else c.ledger.set(r.symbol, [r]); }
    bySymbolCache.set(data, c);
  }
  return c;
}
const isExchangeError = (err: string | null): boolean => !!err && EXCHANGE_ERROR_RE.test(err) && !MODEL_ERROR_RE.test(err);
const episodeRef = (id: string): string => `#judgments?episode=${encodeURIComponent(id)}`;

// ---------------------------------------------------------------- 各角色纯函数

type DayFn = (idx: EvolutionIndex, date: string) => RoleDayRaw;

/** 判断:已结算判断的模型 R vs 机械对照 R。 */
export const threadManagerDay: DayFn = (idx, date) => {
  const eps = idx.by('episodes', date);
  const rows = idx.by('ledger', date).filter((r) => (r.jsource ?? 'online') === 'online');
  const settled = rows.filter((r) => r.settled_at !== null && (r.settlement_status === null || r.settlement_status === 'complete'));
  const paired = settled.filter((r) => r.outcome_r_model !== null && r.outcome_r_mechanical !== null);
  const buckets = new Map<string, number[]>();
  for (const r of paired) { const k = r.cluster_id ?? r.thread_id ?? r.episode_id; const b = buckets.get(k) ?? []; b.push(r.outcome_r_model! - r.outcome_r_mechanical!); buckets.set(k, b); }
  const alphaRaw = mean([...buckets.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length));
  const modelMean = mean(paired.map((r) => r.outcome_r_model!));
  const mechMean = mean(paired.map((r) => r.outcome_r_mechanical!));
  const enough = paired.length >= TM.MIN_PAIRED && alphaRaw !== null;
  const score = enough ? round(alphaRaw!) : null;
  const idle = idleStats(eps);
  const judged = eps.filter((e) => e.action !== null).length;
  let headline: string;
  if (!eps.length && !rows.length) headline = '当天没有判断';
  else if (!settled.length) headline = `${eps.length} 次判断(${judged} 次有动作,账本 ${rows.length} 行),还没结算`;
  else if (!enough) headline = `${settled.length} 笔结算,可与机械对照比的只有 ${paired.length} 笔(< ${TM.MIN_PAIRED}),不判色`;
  else headline = `${paired.length} 笔结算,模型 ${fmtR(modelMean)} vs 机械 ${fmtR(mechMean)}`;
  const events: EvoEvent[] = [];
  const start = dayStartMs(date), end = start + DAY_MS;
  for (const [pv, at] of Object.entries(idx.data.prompt_first_seen)) if (at >= start && at < end) events.push({ at, kind: 'prompt_version', title: `判断 prompt 切到 ${pv}`, ref: null });
  return {
    score, active: eps.length > 0 || rows.length > 0,
    abs: score === null ? null : score >= TM.GOOD_R ? 'good' : score <= TM.BAD_R ? 'bad' : null,
    headline,
    metrics: [
      { key: 'judgments', label: '判断次数(episode)', value: eps.length, unit: '次' },
      { key: 'ledger_rows', label: '账本行(在线)', value: rows.length, unit: '行' },
      { key: 'settled', label: '已结算', value: settled.length, unit: '行' },
      { key: 'paired', label: '可与机械对照比', value: paired.length, unit: '行' },
      { key: 'settled_r_model', label: '模型决定事后 R', value: modelMean === null ? null : round(modelMean), unit: 'R' },
      { key: 'settled_r_mechanical', label: '机械对照事后 R', value: mechMean === null ? null : round(mechMean), unit: 'R' },
      { key: 'alpha_vs_mechanical', label: '模型 − 机械(簇均值)', value: alphaRaw === null ? null : round(alphaRaw), unit: 'R' },
      { key: 'idle_share', label: '空转比例', value: idle.share === null ? null : round(idle.share), unit: 'ratio' },
    ],
    records: desc(eps).slice(0, MAX_RECORDS).map((e) => ({ at: e.at, kind: 'judgment', title: `${e.symbol ?? '?'} ${modeOf(e)} → ${e.action ?? (e.status === 'failed' ? '失败' : e.status)}${e.headline ? `:${clip(e.headline, 60)}` : e.error ? `:${clip(e.error, 60)}` : ''}`, ref: episodeRef(e.id) })),
    events,
  };
};

/** 雷达:筛选次数、头部候选被跟进比例、跟进后结算为正的比例。 */
export const radarDay: DayFn = (idx, date) => {
  const screens = idx.by('screens', date);
  const runs = idx.by('bot_runs', date).filter((r) => r.role === 'radar');
  const screenIds = new Set(screens.map((s) => s.id));
  const cands = idx.data.watch.filter((c) => screenIds.has(c.screen_id) && c.rank <= RADAR.TOP_K);
  const screenAt = new Map(screens.map((s) => [s.id, s.started_at]));
  const sym = bySymbol(idx.data);
  let followed = 0; const positive: number[] = []; const followedSyms = new Set<string>();
  for (const c of cands) {
    const from = screenAt.get(c.screen_id) ?? c.created_at;
    const hit = (sym.eps.get(c.symbol) ?? []).some((e) => e.symbol === c.symbol && e.at >= from && e.at <= c.ttl_at && (e.action === 'WATCH' || e.action === 'PROPOSE'));
    if (!hit) continue;
    followed++; followedSyms.add(c.symbol);
    for (const r of sym.ledger.get(c.symbol) ?? []) if (r.at >= from && r.at <= c.ttl_at && r.settled_at !== null && r.model_dir && r.outcome_r_model !== null) positive.push(r.outcome_r_model > 0 ? 1 : 0);
  }
  const done = screens.filter((s) => s.status === 'done');
  const allFailed = screens.length > 0 && (done.length === 0 || done.every((s) => s.n_symbols > 0 && s.n_errors >= s.n_symbols));
  const follow = cands.length ? followed / cands.length : null;
  const posShare = positive.length ? mean(positive) : null;
  const score = follow === null ? null : round(follow);
  const active = screens.length > 0 || runs.some((r) => r.status !== 'skipped');
  const headline = !active ? '当天没有筛选'
    : allFailed ? `${screens.length} 次筛选全部失败`
      : `${done.length} 次筛选,前 ${RADAR.TOP_K} 候选 ${cands.length} 个,被跟进 ${followed} 个(${fmtPct(follow)}),跟进后结算为正 ${fmtPct(posShare)}`;
  return {
    score: allFailed ? 0 : score, active,
    abs: allFailed ? 'bad' : score !== null && score >= RADAR.GOOD_FOLLOW ? 'good' : null,
    headline,
    metrics: [
      { key: 'screens', label: '筛选次数', value: screens.length, unit: '次' },
      { key: 'screens_failed_symbols', label: '筛选失败币数', value: screens.reduce((a, s) => a + s.n_errors, 0), unit: '个' },
      { key: 'top_candidates', label: `前 ${RADAR.TOP_K} 名候选`, value: cands.length, unit: '个' },
      { key: 'followed', label: '有效期内被 WATCH/PROPOSE', value: followed, unit: '个' },
      { key: 'follow_rate', label: '跟进比例', value: score, unit: 'ratio' },
      { key: 'positive_share', label: '跟进后已结算且为正的比例(模型表态方向的行)', value: posShare === null ? null : round(posShare), unit: 'ratio' },
      { key: 'cost_cny', label: '筛选花费', value: round(screens.reduce((a, s) => a + (s.cost_cny ?? 0), 0), 4), unit: 'CNY' },
    ],
    records: desc([
      ...screens.map((s) => ({ at: s.started_at, kind: 'screen', title: `${s.horizon} 筛选 ${s.status}:${s.n_symbols} 币,${s.n_errors} 个失败${s.error ? `(${clip(s.error, 40)})` : ''}`, ref: '#screener' })),
      ...cands.filter((c) => followedSyms.has(c.symbol)).map((c) => ({ at: c.created_at, kind: 'followed', title: `${c.symbol}(${c.strategy_id},第 ${c.rank} 名)被跟进`, ref: '#screener' })),
    ]).slice(0, MAX_RECORDS),
    events: [],
  };
};

/** 策略实验台:研究/回测/改进环运行、过门槛候选、晋升。 */
export const strategyLabDay: DayFn = (idx, date) => {
  const inq = idx.by('inquiries', date), runs = idx.by('runs', date), bts = idx.by('backtests', date);
  const jobs = idx.by('improve_jobs', date), cands = idx.by('improve_cands', date);
  const rse = idx.by('rs_events', date), se = idx.by('strategy_events', date), probes = idx.by('probes', date);
  const labRuns = idx.by('bot_runs', date).filter((r) => r.role === 'strategy_lab');
  let ok = 0, total = 0;
  const tally = (status: string, good: string[], bad: string[]) => { if (good.includes(status)) { ok++; total++; } else if (bad.includes(status)) total++; };
  for (const r of inq) tally(r.status, ['completed'], ['failed', 'incomplete']);
  for (const r of runs) tally(r.status, ['completed'], ['failed']);
  for (const r of jobs) tally(r.status, ['completed'], ['failed', 'interrupted']);
  for (const r of labRuns) tally(r.status, ['done'], ['failed']);
  const passed = cands.filter((c) => c.generator !== 'baseline' && IMPROVE_PASSED.has(c.status));
  const promotions = [
    ...rse.filter((e) => e.kind === 'transition' && ['paper', 'live', 'published'].includes(e.to_status ?? '')).map((e) => ({ at: e.at, title: `我的策略 ${e.strategy_id}:${e.from_status ?? '?'} → ${e.to_status}`, ref: `#my-strategies?id=${encodeURIComponent(e.strategy_id)}` })),
    ...se.filter((e) => e.kind === 'promote' || e.kind === 'activated').map((e) => ({ at: e.at, title: `${e.strategy_id}@${e.version} ${e.kind === 'activated' ? '进票池' : `晋升 ${e.from_status ?? '?'} → ${e.to_status ?? '?'}`}(${e.who})`, ref: `#strategies?id=${encodeURIComponent(e.strategy_id)}` })),
  ];
  const gateChecks = se.filter((e) => e.kind === 'gate_check');
  const completion = total ? ok / total : null;
  const active = inq.length + runs.length + bts.length + jobs.length + cands.length + rse.length + se.length + probes.length + labRuns.length > 0;
  const score = completion === null ? null : round(completion);
  const events: EvoEvent[] = [
    ...passed.map((c) => ({ at: c.created_at, kind: 'improve_candidate' as const, title: `改进环候选 ${c.id}(${c.generator})过门槛:${clip(c.rationale, 60)}`, ref: null })),
    ...promotions.map((p) => ({ at: p.at, kind: 'strategy_promoted' as const, title: p.title, ref: p.ref })),
    ...probes.map((p) => ({ at: p.queued_at, kind: 'param_probe' as const, title: `参数探针 ${p.strategy_id}.${p.param}=${p.value}(${p.status})`, ref: null })),
  ];
  const headline = !active ? '当天没有研究活动'
    : `研究 ${inq.length} 问 / ${runs.length} run / ${bts.length} 回测 / ${jobs.length} 改进环,完成率 ${fmtPct(completion)};过门槛 ${passed.length},晋升 ${promotions.length}`;
  return {
    score, active,
    abs: completion !== null && completion < LAB.BAD_COMPLETION ? 'bad' : passed.length + promotions.length > 0 ? 'good' : null,
    idle_status: 'ok',
    headline,
    metrics: [
      { key: 'inquiries', label: '研究问询', value: inq.length, unit: '个' },
      { key: 'research_runs', label: '研究 run', value: runs.length, unit: '个' },
      { key: 'backtests', label: '回测报告', value: bts.length, unit: '份' },
      { key: 'improve_jobs', label: '改进环任务', value: jobs.length, unit: '个' },
      { key: 'improve_candidates', label: '改进环候选', value: cands.filter((c) => c.generator !== 'baseline').length, unit: '个' },
      { key: 'improve_passed', label: '过门槛候选', value: passed.length, unit: '个' },
      { key: 'promotions', label: '策略晋升/进票池', value: promotions.length, unit: '次' },
      { key: 'lab_gate_checks', label: 'Lab 门槛检查(未过)', value: gateChecks.length, unit: '次' },
      { key: 'completion_rate', label: '完成率', value: score, unit: 'ratio' },
    ],
    records: desc([
      ...inq.map((r) => ({ at: r.created_at, kind: 'inquiry', title: `${r.task_kind} ${r.status}:${clip(r.question, 60)}`, ref: '#research' })),
      ...bts.map((r) => ({ at: r.created_at, kind: 'backtest', title: `回测报告 ${r.id}${r.strategy_id ? `(${r.strategy_id})` : ''}`, ref: `#backtest?id=${encodeURIComponent(r.id)}` })),
      ...jobs.map((r) => ({ at: r.created_at, kind: 'improve_job', title: `改进环 ${r.id} ${r.status}`, ref: r.strategy_id ? `#my-strategies?id=${encodeURIComponent(r.strategy_id)}` : null })),
      ...labRuns.map((r) => ({ at: r.started_at, kind: 'lab_run', title: `${r.routine} ${r.status}:${clip(r.summary ?? r.error, 60)}`, ref: null })),
      ...se.filter((e) => e.kind !== 'gate_check').map((e) => ({ at: e.at, kind: `strategy_${e.kind}`, title: `${e.strategy_id}@${e.version} ${e.kind}:${clip(e.reason, 60)}`, ref: `#strategies?id=${encodeURIComponent(e.strategy_id)}` })),
    ]).slice(0, MAX_RECORDS),
    events: desc(events),
  };
};

/** 组合:当天账户收益 vs BTC 持有(BTC 价取判断账本里 BTCUSDT 行的 mark)。 */
export const portfolioDay: DayFn = (idx, date) => {
  const start = dayStartMs(date);
  const rows = idx.by('equity', date);
  const prev = idx.data.equity.filter((r) => r.at < start).at(-1);
  const chain = prev ? [prev, ...rows] : rows;
  let growth = 1, transfers = 0;
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1]!.equity, b = chain[i]!.equity;
    if (!(a > 0)) continue;
    const step = b / a - 1;
    if (Math.abs(step) > PM.TRANSFER_STEP) { transfers++; continue; }
    growth *= 1 + step;
  }
  const dayRet = chain.length >= 2 ? growth - 1 : null;
  const btc = idx.data.btc_marks;
  const btcPrev = btc.filter((r) => r.at < start).at(-1);
  const btcDay = btc.filter((r) => dayKey(r.at) === date);
  const btcFrom = btcPrev?.price ?? btcDay[0]?.price ?? null, btcTo = btcDay.at(-1)?.price ?? null;
  const btcRet = btcFrom && btcTo && (btcPrev || btcDay.length >= 2) ? btcTo / btcFrom - 1 : null;
  const excess = dayRet !== null && btcRet !== null ? dayRet - btcRet : null;
  const score = excess === null ? null : round(excess, 6);
  const abs = dayRet !== null && dayRet <= PM.BAD_DAY_RETURN ? 'bad' : excess !== null && excess <= PM.BAD_EXCESS ? 'bad' : excess !== null && excess >= PM.GOOD_EXCESS ? 'good' : null;
  const last = rows.at(-1);
  const headline = !rows.length ? '当天没有权益记录'
    : dayRet === null ? '权益记录不足两条,算不出收益'
      : btcRet === null ? `账户 ${fmtSignedPct(dayRet)},缺 BTC 价格对照`
        : `账户 ${fmtSignedPct(dayRet)} vs BTC 持有 ${fmtSignedPct(btcRet)}${transfers ? `(剔除 ${transfers} 次出入金跳变)` : ''}`;
  return {
    score, active: rows.length > 0, abs, headline,
    metrics: [
      { key: 'equity_end', label: `日末权益(${idx.data.equity_backend ?? '?'})`, value: last ? last.equity.toFixed(2) : null, unit: 'USDT' },
      { key: 'day_return', label: '账户当天收益', value: dayRet === null ? null : round(dayRet, 6), unit: 'ratio' },
      { key: 'btc_return', label: 'BTC 持有收益', value: btcRet === null ? null : round(btcRet, 6), unit: 'ratio' },
      { key: 'excess', label: '超额', value: score, unit: 'ratio' },
      { key: 'transfer_steps', label: '疑似出入金跳变(剔除)', value: transfers, unit: '次' },
      { key: 'equity_points', label: '权益记录条数', value: rows.length, unit: '条' },
    ],
    records: [],
    events: [],
  };
};

/** 风控:当天新增告警(fingerprint 去重)、拦截(block_new_risk)、严重告警。 */
export const riskDay: DayFn = (idx, date) => {
  const rows = idx.by('risk', date);
  const fp = (sev: string[]) => new Set(rows.filter((r) => sev.includes(r.severity)).map((r) => r.fingerprint)).size;
  const all = new Set(rows.map((r) => r.fingerprint)).size;
  const high = fp(['high', 'critical']), critical = fp(['critical']);
  const blocks = new Set(rows.filter((r) => r.auto_action === 'block_new_risk').map((r) => r.fingerprint)).size;
  const score = rows.length ? high : null;
  const kinds = [...new Set(rows.filter((r) => r.severity === 'high' || r.severity === 'critical').map((r) => r.kind))].slice(0, 3).join('/');
  return {
    score, active: rows.length > 0,
    abs: !rows.length ? null : critical > 0 || high >= RISK.BAD_HIGH ? 'bad' : high === 0 ? 'good' : null,
    headline: !rows.length ? '当天没有新告警' : `${all} 条告警(去重),high/critical ${high}${kinds ? `(${kinds})` : ''},拦截 ${blocks}`,
    metrics: [
      { key: 'alerts', label: '新增告警(fingerprint 去重)', value: all, unit: '条' },
      { key: 'high', label: 'high/critical', value: high, unit: '条' },
      { key: 'critical', label: 'critical', value: critical, unit: '条' },
      { key: 'blocks', label: '拦截新风险(block_new_risk)', value: blocks, unit: '条' },
      { key: 'observed', label: '累计观测次数', value: rows.reduce((a, r) => a + r.observed_count, 0), unit: '次' },
    ],
    records: desc(rows.map((r) => ({ at: r.first_seen_at, kind: `alert_${r.severity}`, title: `${r.severity} ${r.kind}:${clip(r.title, 60)}${r.resolved_at ? '(已恢复)' : ''}`, ref: '#floor' }))).slice(0, MAX_RECORDS),
    events: [],
  };
};

/** 执行:交易所接口报错、下单执行成功率。 */
export const executorDay: DayFn = (idx, date) => {
  const eps = idx.by('episodes', date), intents = idx.by('intents', date);
  const apiErr = eps.filter((e) => e.status !== 'done' && isExchangeError(e.error));
  const gateRejected = eps.filter((e) => e.status === 'failed' && e.action === 'PROPOSE');
  const failedIntents = intents.filter((i) => INTENT_FAIL_RE.test(i.status));
  const failRate = share(failedIntents.length, intents.length);
  const apiShare = share(apiErr.length, eps.length);
  const score = apiShare === null && failRate === null ? null : round(Math.min(1 - (apiShare ?? 0), 1 - (failRate ?? 0)));
  const bad = (failRate !== null && failRate > EXEC.BAD_FAIL_RATE) || (apiShare !== null && apiShare > EXEC.BAD_API_SHARE);
  const good = !bad && intents.length > 0 && failedIntents.length === 0 && apiErr.length === 0;
  return {
    score, active: eps.length + intents.length > 0, abs: bad ? 'bad' : good ? 'good' : null,
    headline: !eps.length && !intents.length ? '当天没有执行相关记录'
      : `下单 ${intents.length} 笔(失败 ${failedIntents.length}),交易所接口报错 ${apiErr.length} 次 / ${eps.length} 次判断(${fmtPct(apiShare, 1)})`,
    metrics: [
      { key: 'intents', label: '下单意图', value: intents.length, unit: '笔' },
      { key: 'intents_failed', label: '执行失败', value: failedIntents.length, unit: '笔' },
      { key: 'exec_fail_rate', label: '执行失败率', value: failRate === null ? null : round(failRate), unit: 'ratio' },
      { key: 'api_errors', label: '交易所接口报错', value: apiErr.length, unit: '次' },
      { key: 'api_error_share', label: '接口报错占判断', value: apiShare === null ? null : round(apiShare), unit: 'ratio' },
      { key: 'gate_rejected', label: 'PROPOSE 被闸拒(非执行失败)', value: gateRejected.length, unit: '次' },
    ],
    records: desc([
      ...intents.map((i) => ({ at: i.at, kind: 'intent', title: `${i.symbol ?? '?'} 下单 ${i.status}`, ref: '#trade' })),
      ...apiErr.map((e) => ({ at: e.at, kind: 'api_error', title: `${e.symbol ?? '?'}:${clip(e.error, 70)}`, ref: episodeRef(e.id) })),
      ...gateRejected.map((e) => ({ at: e.at, kind: 'gate_rejected', title: `${e.symbol ?? '?'} PROPOSE 被拒:${clip(e.error, 60)}`, ref: episodeRef(e.id) })),
    ]).slice(0, MAX_RECORDS),
    events: [],
  };
};

/** 复盘:教训提案数、被采纳数。 */
export const reviewerDay: DayFn = (idx, date) => {
  const mem = idx.by('memory', date), mev = idx.by('memory_events', date), lessons = idx.by('lessons', date);
  const runs = idx.by('bot_runs', date).filter((r) => r.role === 'reviewer');
  const lessonMem = mem.filter((m) => m.kind === 'lesson');
  const proposed = lessonMem.length + lessons.length;
  const adopted = lessonMem.filter((m) => m.status === 'active' || m.status === 'superseded').length + lessons.filter((l) => l.status === 'active' || l.status === 'approved').length;
  const runFailed = runs.some((r) => r.status === 'failed');
  const adopt = share(adopted, proposed);
  const score = adopt === null ? null : round(adopt);
  const active = runs.length + mem.length + mev.length + lessons.length > 0;
  const events: EvoEvent[] = [
    ...mem.map((m) => ({ at: m.created_at, kind: 'memory_proposed' as const, title: `${m.kind} 提案(${m.proposed_by ?? '?'}):${clip(m.content, 60)}`, ref: '#memory' })),
    ...mev.filter((e) => e.kind === 'approved').map((e) => ({ at: e.at, kind: 'memory_activated' as const, title: `${e.memory_kind ?? '记忆'} 激活:${clip(e.content, 60)}`, ref: '#memory' })),
  ];
  return {
    score, active, abs: runFailed ? 'bad' : score !== null && adopted > 0 && score >= REVIEW.GOOD_ADOPT ? 'good' : null, idle_status: 'ok',
    headline: !active ? '当天没有复盘' : `复盘 ${runs.length} 批,教训提案 ${proposed},已采纳 ${adopted}${runFailed ? ',有批次失败' : ''}`,
    metrics: [
      { key: 'review_runs', label: '复盘批次', value: runs.length, unit: '批' },
      { key: 'lessons_proposed', label: '教训提案(lesson)', value: proposed, unit: '条' },
      { key: 'lessons_adopted', label: '已采纳', value: adopted, unit: '条' },
      { key: 'memory_proposed_all', label: '全部记忆提案(含平仓事实)', value: mem.length, unit: '条' },
      { key: 'memory_decisions', label: '当天批准/拒绝', value: mev.length, unit: '次' },
      { key: 'adopt_rate', label: '采纳率', value: score, unit: 'ratio' },
    ],
    records: desc(runs.map((r) => ({ at: r.started_at, kind: 'review_run', title: `${r.routine} ${r.status}:${clip(r.summary ?? r.error, 70)}`, ref: '#history' }))).slice(0, MAX_RECORDS),
    events: desc(events),
  };
};

/** 指挥:判断额度使用、模型调用空转比例。 */
export const captainDay: DayFn = (idx, date) => {
  const eps = idx.by('episodes', date);
  const st = idleStats(eps);
  const runs = idx.by('bot_runs', date).filter((r) => r.role === 'gate_captain');
  const score = st.share === null ? null : round(st.share);
  return {
    score, active: eps.length + runs.length > 0,
    abs: score === null ? null : score >= CAPTAIN.BAD_IDLE ? 'bad' : score <= CAPTAIN.GOOD_IDLE ? 'good' : null,
    headline: !st.calls ? (eps.length ? `${eps.length} 次判断,没有模型调用` : '当天没有判断') : `${st.calls} 次模型调用,空转 ${st.idle}(${fmtPct(st.share)}:票池为空 ${st.pool_empty} / 只许 HOLD ${st.hold_only}),¥${st.cost.toFixed(2)}`,
    metrics: [
      { key: 'judgments', label: '判断次数(episode,cap 口径)', value: eps.length, unit: '次' },
      { key: 'model_calls', label: '模型调用', value: st.calls, unit: '次' },
      { key: 'idle', label: '空转调用', value: st.idle, unit: '次' },
      { key: 'idle_pool_empty', label: '其中票池为空的扫描', value: st.pool_empty, unit: '次' },
      { key: 'idle_hold_only', label: '其中只许 HOLD 的复查', value: st.hold_only, unit: '次' },
      { key: 'idle_share', label: '空转比例', value: score, unit: 'ratio' },
      { key: 'cost_cny', label: '判断花费(估算)', value: st.cost, unit: 'CNY' },
    ],
    records: desc(runs.map((r) => ({ at: r.started_at, kind: 'captain_run', title: `${r.routine} ${r.status}:${clip(r.summary ?? r.error, 70)}`, ref: '#floor' }))).slice(0, MAX_RECORDS),
    events: [],
  };
};

/** 信号市场:巡检运行、入站投递解析、出站投递。 */
export const aspDay: DayFn = (idx, date) => {
  const runs = idx.by('bot_runs', date).filter((r) => r.role === 'asp_agent' && r.status !== 'running' && r.status !== 'skipped');
  const dIn = idx.by('deliveries_in', date), dOut = idx.by('deliveries_out', date).filter((d) => d.status !== 'pending');
  const runOk = runs.filter((r) => r.status === 'done').length;
  const inOk = dIn.filter((d) => !ASP_BAD_PARSE.has(d.parse_status)).length;
  const outOk = dOut.filter((d) => d.status === 'delivered').length;
  const total = runs.length + dIn.length + dOut.length;
  const okN = runOk + inOk + outOk;
  const rate = share(okN, total);
  const score = rate === null ? null : round(rate);
  const received = runs.reduce((a, r) => a + (Number(parseJson<{ received?: number }>(r.result_json, {}).received) || 0), 0);
  return {
    score, active: total > 0,
    abs: score === null ? null : score < ASP.BAD_SUCCESS ? 'bad' : score === 1 && dIn.length + dOut.length > 0 ? 'good' : null,
    headline: !total ? '当天没有信号收发' : `巡检 ${runs.length} 次(成功 ${runOk}),收到 ${dIn.length} 条(解析失败 ${dIn.length - inOk}),发出 ${dOut.length} 条(送达 ${outOk})`,
    metrics: [
      { key: 'runs', label: '巡检运行', value: runs.length, unit: '次' },
      { key: 'runs_ok', label: '巡检成功', value: runOk, unit: '次' },
      { key: 'received_reported', label: '巡检报告的新收到数', value: received, unit: '条' },
      { key: 'deliveries_in', label: '入站投递', value: dIn.length, unit: '条' },
      { key: 'deliveries_in_invalid', label: '入站解析失败', value: dIn.length - inOk, unit: '条' },
      { key: 'deliveries_out', label: '出站投递(已终态)', value: dOut.length, unit: '条' },
      { key: 'deliveries_out_ok', label: '出站送达', value: outOk, unit: '条' },
      { key: 'success_rate', label: '成功率', value: score, unit: 'ratio' },
    ],
    records: desc([
      ...dIn.map((d) => ({ at: d.received_at, kind: 'delivery_in', title: `收到 ${d.signal_type ?? '?'}(${d.parse_status})`, ref: '#market' })),
      ...dOut.map((d) => ({ at: d.updated_at, kind: 'delivery_out', title: `发出 ${d.event_id} → ${d.job_id}(${d.status})`, ref: '#market' })),
      ...runs.filter((r) => r.status !== 'done').map((r) => ({ at: r.started_at, kind: 'asp_run', title: `${r.routine} ${r.status}:${clip(r.error, 60)}`, ref: '#market' })),
    ]).slice(0, MAX_RECORDS),
    events: [],
  };
};

export const ROLE_DAY: Record<EvoRole, DayFn> = {
  thread_manager: threadManagerDay, radar: radarDay, strategy_lab: strategyLabDay, portfolio_manager: portfolioDay,
  risk_sentinel: riskDay, executor: executorDay, reviewer: reviewerDay, gate_captain: captainDay, asp_agent: aspDay,
};

// ---------------------------------------------------------------- 判色

export function baselineOf(scores: (number | null)[]): EvoBaseline {
  const xs = scores.filter((x): x is number => x !== null);
  const m = mean(xs);
  return { days: xs.length, mean: m === null ? null : round(m), note: xs.length < BASELINE_MIN_DAYS ? `基线不足 ${BASELINE_MIN_DAYS} 天(${xs.length} 天),按绝对线判` : null };
}

/** 优先级:绝对坏线 → 明显差于基线 → 绝对好线 → 明显好于基线 → ok。score 为空:有绝对坏线仍判 bad,否则按 idle_status(缺省 none)。 */
export function classify(spec: Pick<RoleSpec, 'higher_is_better' | 'band'>, raw: Pick<RoleDayRaw, 'score' | 'active' | 'abs' | 'idle_status'>, baseline: EvoBaseline): EvoStatus {
  if (!raw.active) return 'none';
  if (raw.abs === 'bad') return 'bad';
  if (raw.score === null) return raw.idle_status ?? 'none';
  const diff = baseline.days >= BASELINE_MIN_DAYS && baseline.mean !== null ? (raw.score - baseline.mean) * (spec.higher_is_better ? 1 : -1) : null;
  if (diff !== null && diff <= -spec.band) return 'bad';
  if (raw.abs === 'good') return 'good';
  if (diff !== null && diff >= spec.band) return 'good';
  return 'ok';
}

interface ComputedDay { date: string; raw: RoleDayRaw; baseline: EvoBaseline; status: EvoStatus }
/** 按日期顺序算一个角色;dates 前面要带上 14 天基线的日子(调用方负责)。 */
function computeRole(idx: EvolutionIndex, role: EvoRole, dates: string[]): Map<string, ComputedDay> {
  const fn = ROLE_DAY[role], spec = ROLE_SPECS[role];
  const scoreBy = new Map<string, number | null>();
  const out = new Map<string, ComputedDay>();
  for (const date of dates) {
    const raw = fn(idx, date);
    scoreBy.set(date, raw.score);
    const prior: (number | null)[] = [];
    for (let i = 1; i <= BASELINE_WINDOW_DAYS; i++) prior.push(scoreBy.get(addDays(date, -i)) ?? null);
    const baseline = baselineOf(prior);
    out.set(date, { date, raw, baseline, status: classify(spec, raw, baseline) });
  }
  return out;
}

export function buildDailyFromData(data: EvolutionData, from: string, to: string): Omit<EvoDaily, 'today'> {
  const idx = indexEvolution(data);
  const all = dateRange(addDays(from, -BASELINE_WINDOW_DAYS), to);
  const shown = new Set(dateRange(from, to));
  const roles: EvoRoleRow[] = EVO_ROLES.map((role) => {
    const computed = computeRole(idx, role, all);
    const days: EvoDayCell[] = [];
    const summary = { good: 0, ok: 0, bad: 0, none: 0, baseline_days: 0 };
    for (const date of all) {
      if (!shown.has(date)) continue;
      const c = computed.get(date)!;
      days.push({ date, status: c.status, score: c.raw.score, headline: c.raw.headline, events: c.raw.events.length });
      summary[c.status]++;
    }
    summary.baseline_days = computed.get(to)?.baseline.days ?? 0;
    return { role, label: ROLE_SPECS[role].label, metric_label: ROLE_SPECS[role].metric_label, days, summary };
  });
  return { version: EVOLUTION_VERSION, from, to, roles, missing_sources: [...data.missing] };
}

export function buildDayFromData(data: EvolutionData, role: EvoRole, date: string): EvoDayDetail {
  const idx = indexEvolution(data);
  const c = computeRole(idx, role, dateRange(addDays(date, -BASELINE_WINDOW_DAYS), date)).get(date)!;
  return {
    role, date, status: c.status, score: c.raw.score, headline: c.raw.headline, baseline: c.baseline,
    metrics: c.raw.metrics, records: desc(c.raw.records).slice(0, MAX_RECORDS), events: desc(c.raw.events),
  };
}

// ---------------------------------------------------------------- today 块

export interface WorkflowLike { daily_judgment_cap?: number | null; active_strategies?: string[] | null }
/** 本地日零点(与 runtime.judgmentsToday / daily_judgment_cap 同口径)。 */
export const localDayStart = (now: number): number => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function loadToday(db: DatabaseSync, now: number, workflow?: WorkflowLike | null): EvoToday {
  const missing: string[] = [];
  let wf = workflow ?? null;
  if (!wf) {
    const kv = safeGet<{ value: string }>(db, 'kv', "SELECT value FROM kv WHERE key = 'demo.workflow'", [], missing);
    wf = parseJson<WorkflowLike | null>(kv?.value, null);
  }
  const since = localDayStart(now);
  const eps = safeAll<EpisodeRow>(db, 'demo_episodes', `SELECT id, at, status, action, json_extract(json,'$.graph.node') AS node, json_extract(json,'$.thread_id') AS thread_id,
      json_extract(json,'$.usage.cost_estimate') AS cost, (json_extract(json,'$.usage') IS NOT NULL) AS model_called,
      json_extract(json,'$.holding_review.allowed_actions') AS allowed,
      json_array_length(json_extract(json,'$.strategy_council.consensus.voting')) AS voting
    FROM demo_episodes WHERE at >= ? AND at <= ?`, [since, now], missing);
  const st = idleStats(eps);
  const eq = safeGet<{ at: number; equity: number; backend: string }>(db, 'demo_equity', 'SELECT at, equity, backend FROM demo_equity ORDER BY at DESC LIMIT 1', [], missing);
  const council = safeGet<{ at: number; verdicts: string | null; voting: number | null; gate_reason: string | null }>(db, 'demo_episodes', `SELECT at,
      json_extract(json,'$.strategy_council.verdicts') AS verdicts,
      json_array_length(json_extract(json,'$.strategy_council.consensus.voting')) AS voting,
      json_extract(json,'$.strategy_council.consensus.gate_reason') AS gate_reason
    FROM demo_episodes WHERE json_extract(json,'$.graph.node') = 'scan' AND json_extract(json,'$.strategy_council') IS NOT NULL AND at <= ? ORDER BY at DESC LIMIT 1`, [now], missing);
  const active = Array.isArray(wf?.active_strategies) ? wf!.active_strategies!.map(String) : [];
  let size: number | null = null, reason: string;
  if (!council) reason = active.length ? `还没有带议会的扫描记录;票池配置 ${active.join('/')}` : '票池配置为空,也没有扫描记录';
  else {
    size = council.voting ?? 0;
    const verdicts = parseJson<{ strategy_id?: string; stance?: string; reasons?: string[] }[]>(council.verdicts, []);
    const abst = verdicts.filter((v) => v.stance === 'abstain').map((v) => `${v.strategy_id ?? '?'} 弃权:${(v.reasons ?? []).join(';') || '无理由'}`);
    reason = size > 0 ? `最近一次扫描有 ${size} 条策略可投票` : [council.gate_reason ?? '没有策略能投票', ...abst].join(';');
    if (!active.length) reason = `票池配置为空;${reason}`;
  }
  const cand = safeGet<{ open: number | null; settled: number | null; today_new: number | null }>(db, 'demo_strategy_candidate',
    'SELECT SUM(settled_at IS NULL) AS open, SUM(settled_at IS NOT NULL) AS settled, SUM(at >= ?) AS today_new FROM demo_strategy_candidate', [since], missing);
  const cap = typeof wf?.daily_judgment_cap === 'number' && wf.daily_judgment_cap > 0 ? wf.daily_judgment_cap : null;
  return {
    date: dayKey(now),
    equity: eq ? eq.equity.toFixed(2) : null, equity_backend: eq?.backend ?? null, equity_at: eq?.at ?? null,
    judgments: { used: eps.length, cap, cost_cny: round(st.cost, 2), idle_share: st.share === null ? null : round(st.share), model_calls: st.calls, idle: st.idle, basis: 'local_day', since },
    live_pool: { size, reason, active_strategies: active, at: council?.at ?? null },
    candidates: { open: cand?.open ?? 0, settled: cand?.settled ?? 0, today_new: cand?.today_new ?? 0 },
  };
}

// ---------------------------------------------------------------- 入口(路由与脚本用)

export function resolveRange(fromQ: string | null, toQ: string | null, now: number): { from: string; to: string } {
  const to = toQ ?? dayKey(now);
  const from = fromQ ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (dayStartMs(from) > dayStartMs(to)) throw new Error('invalid_range');
  if ((dayStartMs(to) - dayStartMs(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) throw new Error('range_too_long');
  return { from, to };
}

export function evolutionDaily(db: DatabaseSync, opts: { from?: string | null; to?: string | null; now?: number; workflow?: WorkflowLike | null } = {}): EvoDaily {
  const now = opts.now ?? Date.now();
  const { from, to } = resolveRange(opts.from ?? null, opts.to ?? null, now);
  const data = loadEvolutionData(db, dayStartMs(addDays(from, -BASELINE_WINDOW_DAYS)), dayStartMs(to) + DAY_MS);
  const body = buildDailyFromData(data, from, to);
  return { ...body, today: loadToday(db, now, opts.workflow) };
}

export function isEvoRole(x: unknown): x is EvoRole { return typeof x === 'string' && (EVO_ROLES as string[]).includes(x); }

export function evolutionDay(db: DatabaseSync, opts: { role: string; date?: string | null; now?: number }): EvoDayDetail {
  if (!isEvoRole(opts.role)) throw new Error('invalid_role');
  const date = opts.date ?? dayKey(opts.now ?? Date.now());
  const start = dayStartMs(date);
  const data = loadEvolutionData(db, start - BASELINE_WINDOW_DAYS * DAY_MS, start + DAY_MS);
  return buildDayFromData(data, opts.role, date);
}
