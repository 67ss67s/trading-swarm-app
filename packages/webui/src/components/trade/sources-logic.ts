/**
 * 交易页三层模型的纯函数(有单测,test/trade-sources.test.tsx)。文案 key = 中文原文,英文在 ./i18n-en.ts。
 *
 *   ① 来源 Sources     AI Scan(模型拿 playbook 看盘,单例)/ Strategy Run(代码收盘扫描,可多条)
 *   ② 判断 Judge       每个来源各自:Direct=auto / Jev=jev / LLM=agent / Signal only=signal_only
 *   ③ 风控与执行        所有来源共用,全归代码(GET /api/execution-policy)
 *
 *   sourceCards        §9.56 /api/trading/sources → 卡片模型;接口没就绪时用 runs.stats / agent-strategy + usage 降级
 *   funnel*            今日漏斗归一:Candidates → Judged (follow) → Gates passed/entered → Orders,被挡按层计数
 *   blockedLayerOfEvent / blockedRows   运行事件(skip / agent_skip / order_rejected)→ 被挡层 + 原因(Blocked today 降级)
 *   riskSummary / channelOf / policyDraftPatch / tunePrompt   顶条摘要、执行通道、风控编辑、「让 agent 调」预填
 */
import type { AgentStrategyView } from '@/api/agent-strategy';
import type { AiScanSource, BlockLayer, ExecutionPolicyValues, ExecutionPolicyView, ExecutionPolicyPatch, PolicyBound, SourceReason, StrategyRunSource, TradingSourcesView } from '@/api/trading';
import type { StrategyRun, StrategyRunEvent, StrategyRunMode, StrategyThread, UsageToday } from '@/api/types';
import { IS_JUDGE } from '@/lib/edition';
import { t, tmap } from '@/lib/i18n';
import { matchesOriginFilter, type OriginFilter } from './logic';

export const BLOCK_LAYERS: readonly BlockLayer[] = ['judge', 'strategy', 'gate', 'execution'];
/** 被挡层的短名(卡片 / Blocked today 用) */
export const LAYER_LABEL: Record<BlockLayer, string> = tmap({ judge: '被挡层·判断', strategy: '被挡层·运行上限', gate: '被挡层·风控', execution: '被挡层·执行' });

// ---------------------------------------------------------------------------
// 漏斗

export interface Funnel {
  /** AI Scan 没有「候选」这一层(模型直接看盘),为 null */
  candidates: number | null;
  /** Direct / Signal only 不判断时为 null */
  judged: number | null;
  follow: number | null;
  gatesEntered: number | null;
  gatesPassed: number | null;
  orders: number | null;
  /** 今日被挡合计 = 各层之和 + 分不出层的 */
  blocked: number;
  byLayer: Record<BlockLayer, number>;
  /** 降级数据里分不出层的被挡数 */
  unattributed: number;
}

const zeroLayers = (): Record<BlockLayer, number> => ({ judge: 0, strategy: 0, gate: 0, execution: 0 });
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * top_reasons 里哪些算「候选被挡」:模型判 NO_TRADE / WATCH 是判断本身;全局暂停 / 急停已在顶条;
 * 临时失败会重试;筛选没过、行情没到、挂单过期不是候选。这些不进被挡数,也不进 Blocked today。
 */
const NON_BLOCK_KEYS = new Set(['no_trade', 'watch', 'paused', 'halted', 'transient', 'screen_filter', 'stale']);
export function isBlockingReason(r: Pick<SourceReason, 'key' | 'label'>): boolean {
  if (NON_BLOCK_KEYS.has(r.key)) return false;
  if (r.key.startsWith('text:')) return !NOT_BLOCKED_TEXT_RE.test(r.key.slice(5)) && !NOT_BLOCKED_TEXT_RE.test(r.label ?? '');
  return true;
}
const NOT_BLOCKED_TEXT_RE = /^(行情尚未返回|筛选|临时失败|限价挂单已过期|持仓行情存在缺根|运行参数|策略开始|策略已归档|执行通道已变化|雷达币池)|retry|not yet closed/i;

export function blockingReasons(reasons: readonly SourceReason[] | undefined): SourceReason[] {
  return (reasons ?? []).filter(isBlockingReason);
}

export function layerCounts(reasons: readonly SourceReason[] | undefined): Record<BlockLayer, number> {
  const out = zeroLayers();
  for (const r of blockingReasons(reasons)) if (r.layer in out) out[r.layer] += n(r.count);
  return out;
}

function finish(f: Omit<Funnel, 'blocked'>): Funnel {
  const blocked = BLOCK_LAYERS.reduce((s, k) => s + f.byLayer[k], 0) + f.unattributed;
  return { ...f, blocked };
}

/** 运行来源(§9.56)。top_reasons 最多给前 8 条,所以风控被挡数取计数器和原因合计里较大的那个 */
export function funnelFromRun(s: Pick<StrategyRunSource, 'mode' | 'today' | 'top_reasons'>): Funnel {
  const byLayer = layerCounts(s.top_reasons);
  const follow = n(s.today.judged?.follow);
  const skip = n(s.today.judged?.skip);
  // 同一候选网关可能记两条(agent_skip + skip:ir_judge_skip),判断层以 skip 计数器为准
  byLayer.judge = skip > 0 ? skip : byLayer.judge;
  byLayer.gate = Math.max(byLayer.gate, n(s.today.gate_rejected));
  const judging = s.mode === 'jev' || s.mode === 'agent' || follow + skip > 0;
  const orders = n(s.today.orders);
  return finish({
    candidates: n(s.today.candidates),
    judged: judging ? follow + skip : null,
    follow: judging ? follow : null,
    gatesEntered: orders + byLayer.gate + byLayer.execution,
    gatesPassed: orders + byLayer.execution,
    orders,
    byLayer,
    unattributed: 0,
  });
}

/** 判断动作里算「要开仓」的键(网关键名以契约为准,大小写不敏感) */
export function openActions(actions: Record<string, number> | undefined): number {
  let sum = 0;
  for (const [k, v] of Object.entries(actions ?? {})) if (/^(open|propose|enter|long|short|buy|follow)/i.test(k)) sum += n(v);
  return sum;
}

/** AI Scan(§9.56)。没有候选这一步;模型判 NO_TRADE 是它的决定,不算被挡,被挡只数风控和下单环节 */
export function funnelFromAiScan(s: Pick<AiScanSource, 'today' | 'top_reasons'>): Funnel {
  const byLayer = layerCounts(s.top_reasons);
  const follow = typeof s.today.proposals === 'number' ? s.today.proposals : openActions(s.today.actions);
  byLayer.gate = Math.max(byLayer.gate, n(s.today.gate_rejected));
  const orders = n(s.today.orders);
  return finish({
    candidates: null,
    judged: n(s.today.judgments),
    follow,
    gatesEntered: orders + byLayer.gate + byLayer.execution,
    gatesPassed: orders + byLayer.execution,
    orders,
    byLayer,
    unattributed: 0,
  });
}

/** 降级:运行累计统计(不是今日);候选里没下单的都算被挡,但分不出层 */
export function funnelFromRunStats(run: StrategyRun): Funnel {
  const s = run.stats;
  const byLayer = zeroLayers();
  byLayer.gate = n(s.rejected);
  return finish({
    candidates: n(s.candidates),
    judged: null,
    follow: null,
    gatesEntered: null,
    gatesPassed: null,
    orders: n(s.orders),
    byLayer,
    unattributed: Math.max(0, n(s.candidates) - n(s.orders) - n(s.rejected)),
  });
}

/** 降级:AI Scan 只有今日判断次数 */
export function funnelFromUsage(usage: UsageToday | null | undefined): Funnel {
  return finish({ candidates: null, judged: usage ? n(usage.judgments) : null, follow: null, gatesEntered: null, gatesPassed: null, orders: null, byLayer: zeroLayers(), unattributed: 0 });
}

// ---------------------------------------------------------------------------
// 卡片模型

export type SourceStatus = 'running' | 'paused' | 'stopped' | 'error' | 'halted' | 'capped';

export interface SourceCardModel {
  key: string;
  kind: 'ai_scan' | 'strategy_run';
  filter: Exclude<OriginFilter, null | 'manual'>;
  name: string;
  status: SourceStatus;
  /** 判断方式;AI Scan 固定是模型判断 */
  mode: StrategyRunMode | 'model';
  funnel: Funnel;
  /** today = §9.56 今日数;total = 降级用的累计统计 */
  scope: 'today' | 'total';
  reasons: SourceReason[];
  /** 今天没做但不算被挡的原因(模型判不交易、观察、暂停…) */
  notTaken: SourceReason[];
  openThreads: number | null;
  realizedR: number | null;
  runId: string | null;
  timeframe: string | null;
  symbols: string[];
  version: number | null;
  lastEvent: StrategyRunSource['last_event'];
  /** AI Scan */
  playbook: string | null;
  judgments: { used: number; cap: number } | null;
  /** 接口没就绪,用的降级数据 */
  degraded: boolean;
  /** 不开仓的原因(网关 disabled_reason / 运行 error),显示在状态旁 */
  note: string | null;
}

/** §9.56 playbook 是 {name, …};老形状是字符串 */
export function playbookName(p: AiScanSource['playbook'] | undefined): string | null {
  if (!p) return null;
  const name = typeof p === 'string' ? p : p.name;
  return name?.trim() ? name.trim() : null;
}

function runStatus(status: StrategyRun['status'], halted: boolean): SourceStatus {
  return halted && status === 'running' ? 'halted' : status;
}

export interface SourceCardInput {
  sources: TradingSourcesView | null | undefined;
  runs: readonly StrategyRun[] | undefined;
  agent: AgentStrategyView | undefined;
  usage: UsageToday | null | undefined;
  halted: boolean;
  paused: boolean;
  watchCount: number | null;
  threads: readonly StrategyThread[];
}

/** 一条来源开着的线程数(来源接口没给就按线程列表数) */
function countThreads(threads: readonly StrategyThread[], f: OriginFilter): number {
  return threads.filter((x) => matchesOriginFilter(x, f)).length;
}

/**
 * 卡片列表:AI Scan 永远第一张,运行按 运行中 → 出错 → 暂停 排;停止的运行不出卡。
 * sources 为 null(404)/ undefined(加载中或出错)→ 降级。
 */
export function sourceCards(x: SourceCardInput): SourceCardModel[] {
  const out: SourceCardModel[] = [];
  const rank: Record<string, number> = { running: 0, halted: 0, error: 1, capped: 1, paused: 2, stopped: 3 };
  if (x.sources) {
    const halted = x.sources.shared.halted || x.halted;
    for (const s of x.sources.sources) {
      if (s.kind === 'ai_scan') {
        const cap = n(s.budget?.judgment_cap ?? s.today.cap);
        const used = n(s.budget?.judgments_used_today ?? s.today.judgments);
        const status: SourceStatus = halted ? 'halted' : !s.enabled || s.paused || x.sources.shared.paused ? 'paused' : cap > 0 && used >= cap ? 'capped' : 'running';
        out.push({
          key: 'ai_scan', kind: 'ai_scan', filter: 'ai_scan', name: 'AI Scan', status, mode: 'model', funnel: funnelFromAiScan(s), scope: 'today', reasons: blockingReasons(s.top_reasons), notTaken: s.not_taken ?? [], note: s.enabled ? null : s.disabled_reason ?? null,
          openThreads: s.today.open_threads ?? s.open_threads ?? countThreads(x.threads, 'ai_scan'), realizedR: s.realized_r ?? null, runId: null, timeframe: s.timeframe ?? null,
          symbols: s.symbols ?? [], version: null, lastEvent: null, playbook: playbookName(s.playbook), judgments: { used, cap }, degraded: false,
        });
      } else {
        if (s.status === 'stopped') continue;
        out.push({
          key: s.run_id, kind: 'strategy_run', filter: { runId: s.run_id }, name: s.name, status: runStatus(s.status, halted), mode: s.mode, funnel: funnelFromRun(s), scope: 'today', reasons: blockingReasons(s.top_reasons), notTaken: s.not_taken ?? [], note: null,
          openThreads: n(s.today.open_threads), realizedR: s.realized_r ?? x.runs?.find((r) => r.id === s.run_id)?.stats.realized_r ?? null, runId: s.run_id, timeframe: s.timeframe,
          symbols: s.symbols ?? [], version: s.version, lastEvent: s.last_event ?? null, playbook: null, judgments: null, degraded: false,
        });
      }
    }
    if (!out.some((c) => c.kind === 'ai_scan')) out.unshift(aiScanFallback(x));
  } else {
    out.push(aiScanFallback(x));
    for (const r of x.runs ?? []) {
      if (r.status === 'stopped') continue;
      out.push({
        key: r.id, kind: 'strategy_run', filter: { runId: r.id }, name: r.strategy_name, status: runStatus(r.status, x.halted), mode: r.mode, funnel: funnelFromRunStats(r), scope: 'total', reasons: [], notTaken: [], note: r.error ?? null,
        openThreads: n(r.stats.open_threads), realizedR: r.stats.realized_r ?? null, runId: r.id, timeframe: r.timeframe, symbols: r.symbols, version: r.version, lastEvent: null,
        playbook: null, judgments: null, degraded: true,
      });
    }
  }
  const ai = out.find((c) => c.kind === 'ai_scan')!;
  const runs = out.filter((c) => c.kind !== 'ai_scan');
  runs.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  return [ai, ...runs];
}

function aiScanFallback(x: SourceCardInput): SourceCardModel {
  const cap = x.usage ? n(x.usage.cap) : 0;
  const used = x.usage ? n(x.usage.judgments) : 0;
  const capped = !!x.usage && (x.usage.capped || (cap > 0 && used >= cap));
  // §9.54:Agent 绑了策略时,自由判断(AI Scan)不再开仓
  const boundToStrategy = x.agent?.kind === 'strategy';
  const status: SourceStatus = x.halted ? 'halted' : x.paused || boundToStrategy ? 'paused' : capped ? 'capped' : 'running';
  return {
    key: 'ai_scan', kind: 'ai_scan', filter: 'ai_scan', name: 'AI Scan', status, mode: 'model', funnel: funnelFromUsage(x.usage), scope: 'today', reasons: [], notTaken: [], note: null,
    openThreads: countThreads(x.threads, 'ai_scan'), realizedR: null, runId: null, timeframe: null, symbols: [], version: null, lastEvent: null,
    playbook: null, judgments: x.usage ? { used, cap } : null, degraded: true,
  };
}

// ---------------------------------------------------------------------------
// 被挡原因:运行事件 → 层(Blocked today 降级,§9.56 的 top_reasons 没有逐条明细时也用它)

/** 运行自己的规则(IR 盈亏比、本运行持仓上限、同币持仓策略)→ Run cap */
const STRATEGY_CODES = new Set(['max_open', 'ambiguous_position', 'min_rr', 'already_open', 'position_unsettled', 'position_version_mismatch', 'new_signal_pending', 'new_signal_policy', 'flip_perp_only']);
/** 执行接线 / 撤单确认类 */
const EXECUTION_CODES = new Set(['vol_target_not_connected', 'vol_target_sizing_unavailable', 'replace_unconfirmed', 'flip_unconfirmed', 'close_unconfirmed', 'add_unconfirmed', 'judge_runtime_missing']);
/** 风控检查的名字和关键词(网关 gates.ts 的中文名,加上英文版的说法) */
const GATE_RE = /闸|止损距离|止损在正确一侧|盈亏比|每日开仓上限|同时持仓|日亏|当日亏损|紧急停止|已暂停|证据新鲜度|信心下限|状态不明的订单|同币|stop distance|net r|reward.?risk|daily (loss|open)|max open|gate|halt|same symbol/i;
/** 不是「候选被挡」的 skip:行情没到、筛选没过、挂单过期、临时失败重试 */
const NOT_BLOCKED_CODES = new Set(['screen_filter', 'entry_expired', 'entry_unknown_not_found', 'management_history_gap', 'no_candidate', 'regime_filter']);
const NOT_BLOCKED_RE = /^(行情尚未返回|筛选池|临时失败|限价挂单已过期)|retry|not yet closed/i;

export function codeOf(message: string): string {
  const m = /^([a-z][a-z0-9_]*)(?::|$)/.exec(message.trim());
  return m ? m[1]! : '';
}

export function blockedLayerOfEvent(e: Pick<StrategyRunEvent, 'kind' | 'symbol' | 'message' | 'data'>): BlockLayer | null {
  const code = codeOf(e.message) || String((e.data as { code?: unknown } | null)?.code ?? '');
  if (e.kind === 'agent_skip') return code && EXECUTION_CODES.has(code) ? 'execution' : 'judge';
  if (e.kind === 'order_rejected') return GATE_RE.test(e.message) ? 'gate' : 'execution';
  if (e.kind !== 'skip') return null;
  if (!e.symbol || (e.data as { transient?: unknown } | null)?.transient) return null;
  if (code === 'ir_judge_skip') return null; // 同一候选的 agent_skip 已经记过
  if (NOT_BLOCKED_CODES.has(code) || NOT_BLOCKED_RE.test(e.message)) return null;
  if (STRATEGY_CODES.has(code)) return 'strategy';
  if (EXECUTION_CODES.has(code)) return 'execution';
  if (GATE_RE.test(e.message)) return 'gate';
  return 'execution';
}

/** 已知原因码 → 一句人话;不认识就去掉 `code:` 前缀原样显示 */
const CODE_TEXT: Record<string, string> = tmap({
  max_open: '本运行同时持仓已到上限',
  ambiguous_position: '同币有多条活动线程,先对账',
  min_rr: '候选盈亏比低于策略要求',
  already_open: '本运行已有该币持仓或挂单',
  position_unsettled: '同币线程还没对账完',
  position_version_mismatch: '旧版本持仓按旧规则管理,不接新信号',
  new_signal_pending: '上一个信号还在对账',
  new_signal_policy: '策略的新信号处理方式暂不支持',
  flip_perp_only: '反手只支持永续',
  judge_runtime_missing: '判断模型没接上',
  vol_target_not_connected: '波动率目标仓位没接线',
  vol_target_sizing_unavailable: '候选没有波动率目标权重',
});

export function blockedReasonText(message: string): string {
  const code = codeOf(message);
  if (code && CODE_TEXT[code]) return CODE_TEXT[code]!;
  const rest = code && message.length > code.length ? message.slice(code.length + 1).trim() : message.trim();
  return rest || message;
}

export interface BlockedRow {
  id: string;
  symbol: string | null;
  at: number;
  layer: BlockLayer;
  reason: string;
}

export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 今日(since 之后)被挡的候选,新的在前 */
export function blockedRows(events: readonly StrategyRunEvent[] | undefined, since: number): BlockedRow[] {
  const out: BlockedRow[] = [];
  for (const e of events ?? []) {
    if (e.at < since) continue;
    const layer = blockedLayerOfEvent(e);
    if (!layer) continue;
    out.push({ id: e.id, symbol: e.symbol, at: e.at, layer, reason: blockedReasonText(e.message) });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** §9.56 原因码 → 文案(与网关 execution-policy.ts REASON_LABELS 同一套中文,英文走 i18n);不认识就用网关给的 label */
const REASON_CODE_TEXT: Record<string, string> = tmap({
  stop_distance: '止损距离低于下限', stop_atr: '止损小于 ATR 下限', stop_too_wide: '止损距离超过上限', min_net_rr: '净盈亏比不足',
  max_open_threads: '同时持仓已满', max_opens_per_day: '今日开仓次数已满', daily_loss_stop: '触及日亏停', symbol_open: '同币已有线程/持仓',
  halted: '紧急停止', paused: '已暂停', portfolio_limit: '组合限额', risk_sentinel: '风控哨兵告警', sizing: '数量不可用', event_blackout: '事件封锁',
  stop_side: '止损方向错误', stale: '证据/行情过期', confidence: '信心不足', unknown_order: '有状态不明的订单',
  already_open: '本运行已有该币持仓', max_open: '本运行持仓已满', ambiguous_position: '同币多条线程待对账', min_rr: '候选盈亏比低于策略要求',
  position_unsettled: '同币线程待对账', new_signal: '新信号待续接',
  ir_judge_skip: '策略判断要素跳过', jev_skip: 'Jev 判断跳过', jev_unavailable: 'Jev 不可用(按跳过)', agent_skip: 'LLM 判断跳过',
  no_trade: '模型判断不交易', model_failed: '模型调用失败',
  transient: '临时失败(已重试)', execution_unknown: '回执未知', execution_error: '执行错误',
});

export function reasonLabel(r: Pick<SourceReason, 'key' | 'label'>): string {
  return (r.key && REASON_CODE_TEXT[r.key]) || r.label || r.key;
}

/** top_reasons 的 example 统一成 {symbol, at, message} */
export function reasonExample(r: SourceReason): { symbol: string | null; at: number | null; message: string | null } {
  const ex = r.example;
  if (!ex) return { symbol: null, at: null, message: null };
  if (typeof ex === 'string') {
    const m = /^([A-Z0-9]{2,20}USDT)\b[\s:]*/.exec(ex);
    return { symbol: m ? m[1]! : null, at: null, message: m ? ex.slice(m[0].length) || ex : ex };
  }
  return { symbol: ex.symbol ?? null, at: ex.at ?? null, message: ex.message ?? null };
}

// ---------------------------------------------------------------------------
// 风控与执行

export const num = (v: string | number | null | undefined): number => (v === null || v === undefined || v === '' ? NaN : Number(v));
/** 0.5 → "0.5";1.50 → "1.5";NaN → "—" */
export function fmtNum(v: string | number | null | undefined, maxDigits = 2): string {
  const x = num(v);
  if (!Number.isFinite(x)) return '—';
  return String(Number(x.toFixed(maxDigits)));
}

/** 顶条胶囊:`每笔风险 0.5% · agent 调仓位 · 3x · 持仓 2/3 · 今日 1/4 · 止损 0.3–5% · 盈亏比 ≥1.5` */
export function riskSummary(v: Partial<ExecutionPolicyValues>, usage?: { open_threads?: number | null; opens_today?: number | null } | null): string {
  const parts: string[] = [];
  parts.push(t('每笔风险 {v}%', { v: fmtNum(v.risk_pct) }));
  if (v.sizing_agent === 'apply') parts.push(t('agent 调仓位'));
  if (v.leverage !== undefined) parts.push(`${fmtNum(v.leverage)}x`);
  if (v.max_open_threads !== undefined) parts.push(t('持仓 {a}/{b}', { a: usage?.open_threads ?? '—', b: v.max_open_threads }));
  if (v.max_opens_per_day !== undefined) parts.push(t('今日 {a}/{b}', { a: usage?.opens_today ?? '—', b: v.max_opens_per_day }));
  if (v.min_stop_pct !== undefined && v.max_stop_pct !== undefined) parts.push(t('止损 {a}–{b}%', { a: fmtNum(v.min_stop_pct), b: fmtNum(v.max_stop_pct) }) + (v.min_stop_atr !== undefined ? ` ≥${fmtNum(v.min_stop_atr)}ATR` : ''));
  if (v.min_net_rr !== undefined) parts.push(t('盈亏比 ≥{v}', { v: fmtNum(v.min_net_rr) }));
  return parts.join(' · ');
}

export type ChannelKind = 'paper' | 'demo' | 'live' | 'unknown';
/** 执行通道:Paper / OKX Demo / Live */
export function channelOf(x: { backend?: string | null; live?: boolean | null; profile?: string | null; okxDemo?: boolean; label?: string | null }): { kind: ChannelKind; label: string } {
  const b = (x.backend ?? '').toLowerCase();
  if (x.live || x.profile === 'live') return { kind: 'live', label: b === 'okx' ? 'OKX Live' : b === 'binance' ? 'Binance Live' : 'Live' };
  if (!b) return { kind: 'unknown', label: '—' };
  if (b === 'paper') return { kind: 'paper', label: 'Paper' };
  if (b === 'okx') return { kind: 'demo', label: 'OKX Demo' };
  if (b === 'binance' || b.includes('testnet')) return { kind: 'demo', label: 'Binance Testnet' };
  return { kind: 'demo', label: x.label || x.backend! };
}

/** 抽屉里可编辑的数字参数,按一个候选遇到它们的顺序排 */
export const POLICY_NUMERIC_KEYS = ['daily_loss_stop_pct', 'max_opens_per_day', 'max_open_threads', 'min_stop_pct', 'min_stop_atr', 'max_stop_pct', 'min_net_rr', 'risk_pct', 'leverage'] as const;
export type PolicyEditKey = (typeof POLICY_NUMERIC_KEYS)[number] | 'sizing_agent';
export type PolicyDraft = Partial<Record<PolicyEditKey, string>>;
const INTEGER_KEYS = new Set<PolicyEditKey>(['max_opens_per_day', 'max_open_threads', 'leverage']);

/**
 * 草稿 → PATCH 体。只带改了的字段;数字按区间校验,止损上下限要 min < max。
 * 有错时 patch 为 null。字符串型字段(risk_pct 等)原样回十进制字符串,整数字段回 number。
 */
export function policyDraftPatch(values: ExecutionPolicyValues, bounds: Partial<Record<string, PolicyBound>>, draft: PolicyDraft): { patch: ExecutionPolicyPatch | null; errors: Partial<Record<PolicyEditKey, string>>; changed: PolicyEditKey[] } {
  const errors: Partial<Record<PolicyEditKey, string>> = {};
  const patch: Record<string, unknown> = {};
  const changed: PolicyEditKey[] = [];
  for (const key of POLICY_NUMERIC_KEYS) {
    const raw = draft[key];
    if (raw === undefined || values[key] === undefined) continue;
    const cur = num(values[key]);
    const x = Number(raw.trim());
    if (raw.trim() === '' || !Number.isFinite(x)) {
      errors[key] = t('填一个数字');
      continue;
    }
    if (x === cur) continue;
    const b = bounds[key];
    if (b && (x < b.min || x > b.max)) {
      errors[key] = t('范围 {a}–{b}', { a: fmtNum(b.min, 4), b: fmtNum(b.max, 4) });
      continue;
    }
    if (INTEGER_KEYS.has(key) && !Number.isInteger(x)) {
      errors[key] = t('要整数');
      continue;
    }
    patch[key] = typeof values[key] === 'string' ? String(x) : x;
    changed.push(key);
  }
  if (draft.sizing_agent !== undefined && draft.sizing_agent !== values.sizing_agent) {
    if (draft.sizing_agent === 'off' || draft.sizing_agent === 'advise' || draft.sizing_agent === 'apply') {
      patch['sizing_agent'] = draft.sizing_agent;
      changed.push('sizing_agent');
    } else errors.sizing_agent = t('选 off / advise / apply');
  }
  const minStop = draft.min_stop_pct !== undefined ? Number(draft.min_stop_pct) : num(values.min_stop_pct);
  const maxStop = draft.max_stop_pct !== undefined ? Number(draft.max_stop_pct) : num(values.max_stop_pct);
  if (Number.isFinite(minStop) && Number.isFinite(maxStop) && minStop >= maxStop && !errors.min_stop_pct && !errors.max_stop_pct) errors.max_stop_pct = t('要大于止损下限');
  const ok = Object.keys(errors).length === 0;
  return { patch: ok && changed.length ? (patch as ExecutionPolicyPatch) : null, errors, changed };
}

/**
 * 被「止损太近」挡下的原因(止损距离低于下限 / 小于 ATR 下限):引导把策略止损放宽到 ≥k×ATR,而不是去调低下限。
 * 止损太宽(stop_too_wide)不算。有原因码按码判;只有文本时解析「x%(允许 a%–b%)」比大小。
 */
export function isStopDistanceReason(x: { key?: string | null; label?: string | null; reason?: string | null }): boolean {
  if (x.key) return x.key === 'stop_distance' || x.key === 'stop_atr';
  const text = `${x.label ?? ''} ${x.reason ?? ''}`;
  if (/止损ATR下限|×ATR\(下限|小于 ATR 下限|below .*ATR/i.test(text)) return true;
  const m = /止损距离[^;]*?(\d+(?:\.\d+)?)%\(允许 (\d+(?:\.\d+)?)%/.exec(text);
  if (m) return Number(m[1]) < Number(m[2]);
  return /止损距离低于|stop distance .*(below|<)|stop too (tight|close)/i.test(text);
}

export function widenStopHint(minStopAtr: string | number | null | undefined): string {
  const k = fmtNum(minStopAtr);
  return k === '—' ? t('把策略止损放宽(按 ATR 设)') : t('把策略止损放宽(≥{k}×ATR)', { k });
}

/** 今日所有来源被挡合计,按层 + 最常见的几条原因(给「让 agent 调」的提示用) */
export function blockedTotals(cards: readonly SourceCardModel[]): { total: number; byLayer: Record<BlockLayer, number>; top: { label: string; count: number; layer: BlockLayer }[] } {
  const byLayer = zeroLayers();
  const top = new Map<string, { label: string; count: number; layer: BlockLayer }>();
  let total = 0;
  for (const c of cards) {
    if (c.scope !== 'today') continue;
    for (const k of BLOCK_LAYERS) byLayer[k] += c.funnel.byLayer[k];
    total += c.funnel.blocked - c.funnel.unattributed;
    for (const r of c.reasons) {
      const key = `${r.layer}:${r.key}`;
      const cur = top.get(key);
      if (cur) cur.count += n(r.count);
      else top.set(key, { label: reasonLabel(r), count: n(r.count), layer: r.layer });
    }
  }
  return { total, byLayer, top: [...top.values()].sort((a, b) => b.count - a.count).slice(0, 5) };
}

/** 「Ask agent to tune」预填:当前参数 + 区间 + 今日被挡;用户可改再发 */
export function tunePrompt(policy: ExecutionPolicyView | null | undefined, cards: readonly SourceCardModel[], channel: { kind: ChannelKind; label: string }): string {
  const lines: string[] = [];
  lines.push(t('帮我看一下 Trading Swarm 的「风控与执行」参数要不要调(所有来源共用)。'));
  if (policy) {
    lines.push(t('执行通道:{c}。当前:{s}。', { c: channel.label, s: riskSummary(policy.values, policy.usage) }));
    const ranges = POLICY_NUMERIC_KEYS.map((k) => {
      const b = policy.bounds[k];
      if (!b) return null;
      const direct = b.agent_direct_min !== undefined && b.agent_direct_max !== undefined ? t('(你可直接改 {a}–{b})', { a: fmtNum(b.agent_direct_min, 4), b: fmtNum(b.agent_direct_max, 4) }) : '';
      return `${k}=${fmtNum(policy.values[k], 4)} [${fmtNum(b.min, 4)}–${fmtNum(b.max, 4)}]${direct}`;
    }).filter(Boolean);
    if (ranges.length) lines.push(t('参数与区间:{r}。', { r: ranges.join('; ') }));
    lines.push(t('仓位 agent:{m}(PM 倍率 ×0.25–2 由代码钳制,拆单只做建议)。', { m: policy.values.sizing_agent }));
  }
  const b = blockedTotals(cards);
  const layerText = BLOCK_LAYERS.filter((k) => b.byLayer[k] > 0).map((k) => `${LAYER_LABEL[k]} ${b.byLayer[k]}`).join(', ');
  lines.push(b.total > 0 ? t('今天被挡 {n} 个:{layers}。', { n: b.total, layers: layerText || '—' }) : t('今天还没有候选被挡。'));
  if (b.top.length) lines.push(t('最常见的原因:{r}。', { r: b.top.map((x) => `${x.label} ×${x.count}`).join('; ') }));
  // 评审版访客的对话只有只读工具,改不了参数,别让 agent 以为自己能改
  if (IS_JUDGE) lines.push(t('这是公开的评审演示:说清楚你会怎么调、为什么;这里不能直接改参数。'));
  else lines.push(channel.kind === 'live' ? t('这是真钱通道:只给建议,不要直接改。') : t('模拟盘:区间内你可以直接改;超出区间请写成提议等我确认。先说理由再动手。'));
  return lines.join('\n');
}

const NOT_TAKEN_LABEL: Record<string, string> = tmap({
  no_trade: '判断不交易', watch: '观察中', halted: '急停', paused: '暂停', ai_scan_paused: 'AI 扫盘暂停', transient: '临时失败,稍后重试',
  screen_filter: '筛选没过', bars_pending: '行情还没到', entry_expired: '限价单过期没成交', entry_unknown_not_found: '挂单没找到',
});

/** 「今天没做」一行:按次数排,最多三项,例如 `判断不交易 12 · 观察中 5` */
export function notTakenLine(items: readonly SourceReason[], limit = 3): string | null {
  const rows = items.filter((r) => r.count > 0).sort((a, b) => b.count - a.count).slice(0, limit);
  if (!rows.length) return null;
  return rows.map((r) => `${NOT_TAKEN_LABEL[r.key] ?? r.label} ${r.count}`).join(' · ');
}
