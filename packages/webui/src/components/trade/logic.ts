/**
 * 交易页的纯函数(有单测,test/trade-page.test.tsx)。文案 key = 中文原文,英文在 ./i18n-en.ts。
 *
 *   threadHealth   线程要不要人看:提交结果未知(卡住的挂单)/ attention 码 / 提交中 / 正常
 *   threadOrigin   这条线程从哪来:策略运行 / 跟单 / 手动 / 对话 / AI Scan(没绑策略时 agent 自己看盘开的)
 *   groupThreads   列表分组:需要处理 → 持仓中 → 待入场
 *   judgeForThread 这条线程对应的 Jev 判断(outcome.thread_id)
 *   aspForThread   这笔有没有交给 ASP 发布(运行事件 published,按币种 + 时间窗对上)
 */
import type { OpenOrderView, PositionView, StrategyRun, StrategyRunEvent, StrategyThread } from '@/api/types';
import type { JudgeLiveItem } from '@/api/judge-live';
import { marketOf } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';

/** 网关的提交相位上限(gateway runtime SUBMIT_PHASE_MAX_MS):超过还没回执 = 调用方已经放弃,结果未知 */
export const SUBMIT_PHASE_MAX_MS = 150_000;

/** 前端只读到的线程附加字段(api/types.ts 没镜像,别的会话在动那个文件,这里就地声明) */
export type ThreadExtra = StrategyThread & {
  strategy_id?: string | null;
  strategy_version?: number | null;
  entry_submitting_since?: number | null;
  entry_submitted_at?: number | null;
  entry_cancel_pending?: boolean;
};

export type HealthTone = 'danger' | 'warn' | 'info' | 'ok';
export interface ThreadHealth {
  kind: 'submit_unknown' | 'attention' | 'submitting' | 'ok';
  tone: HealthTone;
  /** 徽章短文案 */
  label: string;
  /** 一句话说清发生了什么、该怎么办 */
  detail: string | null;
  /** 卡了多久(毫秒);只对 submit_unknown 有意义 */
  stuckMs: number | null;
}

const ATTENTION_LABEL: Record<string, string> = tmap({
  ORDER_UNKNOWN: '交易所查不到入场单',
  CANCEL_UNKNOWN: '撤单结果未知',
  PROTECTION_MISSING: '止损没挂上',
  CLOSE_FAILED: '平仓没成功',
  EXTERNAL_POSITION: '同币有外部持仓',
  ENTRY_REMAINDER: '入场单还有余量',
  ENTRY_EXPIRED: '入场单已过期',
  HALT_INCOMPLETE: '急停没收完',
  STOP_MOVE_OLD_CANCEL_PENDING: '移损:旧止损在撤',
  STOP_MOVE_OLD_CANCEL_FAILED: '移损:旧止损没撤掉',
  STOP_MOVE_NEW_UNCONFIRMED: '移损:新止损未确认',
});
const ATTENTION_DETAIL: Record<string, string> = tmap({
  ORDER_UNKNOWN: '入场单在交易所查不到,网关持续核对,不重发也不自动撤。',
  CANCEL_UNKNOWN: '撤单请求发出去了,但没拿到终态回执;网关还在核对有没有成交。',
  PROTECTION_MISSING: '持仓在,但交易所上没有止损单;网关会自动重挂,挂不上请手动处理。',
  CLOSE_FAILED: '平仓请求没成功,仓位可能还在;去交易所核对后再点一次平仓。',
  EXTERNAL_POSITION: '同一个币出现了不属于这条线程的持仓,入场单保留但不挂保护单。',
  ENTRY_REMAINDER: '入场单部分成交,剩余部分还挂着或结果未知。',
  HALT_INCOMPLETE: '急停没有把这条线程完全收掉。',
});
const DANGER_CODES = new Set(['ORDER_UNKNOWN', 'CANCEL_UNKNOWN', 'PROTECTION_MISSING', 'CLOSE_FAILED', 'HALT_INCOMPLETE']);

export function attentionLabel(code: string): string {
  return ATTENTION_LABEL[code] ?? code;
}

function durationText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return t('{n} 分钟', { n: Math.max(1, m) });
  const h = Math.floor(m / 60);
  if (h < 48) return t('{h} 小时 {m} 分', { h, m: m % 60 });
  return t('{n} 天', { n: Math.floor(h / 24) });
}

/**
 * 线程健康度。优先级:提交结果未知 > attention 码 > 提交中 > 正常。
 * 「提交结果未知」= 待入场、开过提交相位、到现在也没有 entry_submitted_at,并且已超过网关的相位上限——
 * 典型是市价单调用超时(09-25 LINKUSDT:okx spot orders 超时 15000ms),本地不知道单子有没有下出去。
 */
export function threadHealth(thread: StrategyThread, now: number, positions?: readonly PositionView[]): ThreadHealth {
  const x = thread as ThreadExtra;
  if (thread.status === 'pending_entry' && typeof x.entry_submitting_since === 'number' && x.entry_submitted_at == null) {
    const age = Math.max(0, now - x.entry_submitting_since);
    if (age >= SUBMIT_PHASE_MAX_MS) {
      const held = positions?.some((p) => p.symbol === thread.symbol && marketOf(p) === marketOf(thread) && Number(p.qty) !== 0);
      const where = positions === undefined ? '' : held ? t('交易所上有 {symbol} 仓位,可能是这笔成交了。', { symbol: thread.symbol }) : t('交易所上没有 {symbol} 仓位。', { symbol: thread.symbol });
      return {
        kind: 'submit_unknown',
        tone: 'danger',
        label: t('提交结果未知'),
        detail: t('入场单 {ago}前开始提交,一直没拿到交易所回执,本地不知道单子有没有下出去。', { ago: durationText(age) }) + where + t('撤单会交给撤单链按同一个订单号去交易所核对。'),
        stuckMs: age,
      };
    }
    return { kind: 'submitting', tone: 'info', label: t('提交中'), detail: null, stuckMs: null };
  }
  if (thread.attention) {
    const code = thread.attention;
    const detail = ATTENTION_DETAIL[code] ?? null;
    return { kind: 'attention', tone: DANGER_CODES.has(code) ? 'danger' : 'warn', label: attentionLabel(code), detail, stuckMs: null };
  }
  return { kind: 'ok', tone: 'ok', label: '', detail: null, stuckMs: null };
}

export function needsAction(h: ThreadHealth): boolean {
  return h.kind === 'submit_unknown' || h.kind === 'attention';
}

// ---------------------------------------------------------------------------
// 来源

export type ThreadOrigin =
  | { kind: 'run'; runId: string; run: StrategyRun | null; label: string }
  | { kind: 'trader'; name: string; label: string }
  | { kind: 'manual' | 'chat' | 'ai_scan'; label: string };

export function threadOrigin(thread: StrategyThread, runs: readonly StrategyRun[] | undefined): ThreadOrigin {
  const o = thread.origin ?? '';
  if (o.startsWith('strategy_run:')) {
    const runId = o.slice('strategy_run:'.length);
    const run = runs?.find((r) => r.id === runId) ?? null;
    return { kind: 'run', runId, run, label: run ? run.strategy_name : t('策略运行') };
  }
  if (o.startsWith('trader:')) {
    const name = o.slice('trader:'.length);
    return { kind: 'trader', name, label: t('跟单 {name}', { name }) };
  }
  if (thread.source === 'manual') return { kind: 'manual', label: t('手动') };
  if (thread.source === 'chat') return { kind: 'chat', label: t('对话') };
  return { kind: 'ai_scan', label: 'AI Scan' };
}

/** "rs_aa7@1" → { id: 'rs_aa7', version: 1 };没有就 null */
export function strategyRef(thread: StrategyThread): { id: string; version: number | null } | null {
  const x = thread as ThreadExtra;
  const raw = x.strategy_id;
  if (!raw) return null;
  const [id, v] = raw.split('@');
  const version = v ? Number(v) : x.strategy_version ?? null;
  return { id: id!, version: Number.isFinite(version as number) ? (version as number) : null };
}

/** 策略研究合并页(#strategy-research)的深链;页面还没合进主分支时 hash 落空,App 会回首页 */
export function strategyResearchHref(strategyId: string): string {
  return `#strategy-research?step=validate&strategy=${encodeURIComponent(strategyId)}`;
}

// ---------------------------------------------------------------------------
// 分组

export interface ThreadGroups {
  action: { thread: StrategyThread; health: ThreadHealth }[];
  holding: { thread: StrategyThread; health: ThreadHealth }[];
  pending: { thread: StrategyThread; health: ThreadHealth }[];
}

export function groupThreads(threads: readonly StrategyThread[], now: number, positions?: readonly PositionView[]): ThreadGroups {
  const g: ThreadGroups = { action: [], holding: [], pending: [] };
  for (const thread of threads) {
    const health = threadHealth(thread, now, positions);
    const row = { thread, health };
    if (needsAction(health)) g.action.push(row);
    else if (thread.status === 'in_position') g.holding.push(row);
    else g.pending.push(row);
  }
  const byUpdated = (a: { thread: StrategyThread }, b: { thread: StrategyThread }) => b.thread.updated_at - a.thread.updated_at;
  g.action.sort((a, b) => (a.health.tone === b.health.tone ? byUpdated(a, b) : a.health.tone === 'danger' ? -1 : 1));
  g.holding.sort(byUpdated);
  g.pending.sort(byUpdated);
  return g;
}

/** 待入场线程里,提交结果未知的那几条(挂单 tab 单列出来,不和交易所真实挂单混在一起) */
export function unknownEntries(threads: readonly StrategyThread[], now: number, positions?: readonly PositionView[]): { thread: StrategyThread; health: ThreadHealth }[] {
  return threads.map((thread) => ({ thread, health: threadHealth(thread, now, positions) })).filter((r) => r.health.kind === 'submit_unknown');
}

/** 交易所挂单属于哪条线程(入场腿或保护腿的 clientOrderId) */
export function threadForOrder(order: OpenOrderView, threads: readonly StrategyThread[]): StrategyThread | null {
  const cid = order.client_order_id;
  if (!cid) return null;
  return threads.find((th) => th.entry_client_order_id === cid || th.protection_client_order_ids.includes(cid)) ?? null;
}

// ---------------------------------------------------------------------------
// Jev / ASP 联动

/**
 * 这条线程对应的 Jev 判断:先按 outcome.thread_id 对;对不上(影子判断常常没回填 outcome)再按
 * 同一个运行 + 同币同向 + 判断时间在开线程前后 15 分钟内对。
 */
export function judgeForThread(thread: Pick<StrategyThread, 'id' | 'symbol' | 'side' | 'created_at' | 'origin'>, items: readonly JudgeLiveItem[] | undefined): JudgeLiveItem | null {
  if (!items?.length) return null;
  const direct = items.find((it) => it.outcome?.thread_id === thread.id);
  if (direct) return direct;
  const o = thread.origin ?? '';
  if (!o.startsWith('strategy_run:')) return null;
  const runId = o.slice('strategy_run:'.length);
  let best: JudgeLiveItem | null = null;
  for (const it of items) {
    if (it.run_id !== runId || it.symbol !== thread.symbol || it.candidate.direction !== thread.side) continue;
    if (it.outcome && it.outcome.thread_id !== thread.id) continue;
    const d = Math.abs(it.created_at - thread.created_at);
    if (d > ASP_MATCH_WINDOW_MS) continue;
    if (!best || d < Math.abs(best.created_at - thread.created_at)) best = it;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 线程来源筛选:全部 / AI Scan / 手动(下单面板 + 对话)/ 某一个策略运行。跟单线程只在「全部」里。

export type OriginFilter = null | 'ai_scan' | 'manual' | { runId: string };

export function matchesOriginFilter(thread: StrategyThread, f: OriginFilter): boolean {
  if (!f) return true;
  const o = thread.origin ?? '';
  if (typeof f === 'object') return o === `strategy_run:${f.runId}`;
  if (o.startsWith('strategy_run:') || o.startsWith('trader:')) return false;
  const manual = thread.source === 'manual' || thread.source === 'chat';
  return f === 'manual' ? manual : !manual;
}

export function sameOriginFilter(a: OriginFilter, b: OriginFilter): boolean {
  if (a === null || b === null || typeof a === 'string' || typeof b === 'string') return a === b;
  return a.runId === b.runId;
}

/** 每个筛选下的进行中线程数:all / ai_scan / manual / 按运行 */
export function originCounts(threads: readonly StrategyThread[]): { all: number; ai_scan: number; manual: number; runs: Record<string, number> } {
  const out = { all: threads.length, ai_scan: 0, manual: 0, runs: {} as Record<string, number> };
  for (const th of threads) {
    const o = th.origin ?? '';
    if (o.startsWith('strategy_run:')) {
      const id = o.slice('strategy_run:'.length);
      out.runs[id] = (out.runs[id] ?? 0) + 1;
    } else if (!o.startsWith('trader:')) {
      if (th.source === 'manual' || th.source === 'chat') out.manual++;
      else out.ai_scan++;
    }
  }
  return out;
}

/** 发布事件和线程之间的时间窗:同一轮扫描里先出候选、再下单、再交 ASP,相差在一根 K 线以内 */
const ASP_MATCH_WINDOW_MS = 15 * 60_000;

export type AspState = { kind: 'published'; at: number } | { kind: 'not_found' } | { kind: 'off' } | { kind: 'unknown' };

export function aspForThread(thread: StrategyThread, run: StrategyRun | null, events: readonly StrategyRunEvent[] | undefined): AspState {
  if (!run) return { kind: 'unknown' };
  const hit = events?.find((e) => e.kind === 'published' && e.symbol === thread.symbol && Math.abs(e.at - thread.created_at) <= ASP_MATCH_WINDOW_MS);
  if (hit) return { kind: 'published', at: hit.at };
  if (!run.publish_asp) return { kind: 'off' };
  return events ? { kind: 'not_found' } : { kind: 'unknown' };
}

/** 运行状态条一句话:扫描 / 候选 / 下单 / 跳过 */
export function runStatsLine(run: StrategyRun): string {
  const s = run.stats;
  return t('扫描 {a} · 候选 {b} · 下单 {c} · 跳过 {d}', { a: s.scans, b: s.candidates, c: s.orders, d: s.skipped });
}

export function fmtRunR(r: number | null | undefined): string | null {
  if (r == null || !Number.isFinite(r)) return null;
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

/** 顶部条要显示的运行:运行中 / 暂停 / 出错的,运行中在前 */
export function activeRuns(runs: readonly StrategyRun[] | undefined): StrategyRun[] {
  const rank = { running: 0, error: 1, paused: 2, stopped: 3 } as const;
  return (runs ?? []).filter((r) => r.status !== 'stopped').sort((a, b) => rank[a.status] - rank[b.status] || b.updated_at - a.updated_at);
}
