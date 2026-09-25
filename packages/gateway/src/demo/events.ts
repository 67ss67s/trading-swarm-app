import { ResearchStore } from './research.js';
/**
 * 事件区(Event Zone)——设计:docs/design/strategy-loop-v2-and-events-2026-09-12.md §5。
 *
 * 一条 `MarketEvent` 就是「一件会动价的事」:宏观日历、新闻、交易所公告、链上、以及派生自代码触发器的
 * 极端状态。它有生命周期(captured → briefed → live → resolved → retro_done),窗口内会变成判断的证据,
 * 窗口结束后由**代码**回填 impact,再按 subkind 聚合成历史统计喂给下一次同类事件。
 *
 * 硬规则(和仓库 AGENTS.md 一致):
 * - 分类器**零模型**:关键词表 → subkind + 资产映射(复用 info.ts 的 assetsInText)。分不出来的老实记
 *   `unclassified`,**不**为了好看去调模型。`classifyWithBrain` 只是留好的兜底接口,默认不接。
 * - 事件**不能直接下单**。它只做三件事:进证据、给触发器一个 `event` 种类、以及 `event_blackout` 闸(拒开仓,
 *   不拒平仓)。
 * - 外部文本一律当数据:`sanitizeUntrusted` 之后才落库/进 prompt。
 * - 时间戳 unix 毫秒,字段 snake_case。
 */

import type { CalendarObservation } from './calendar-feed.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assetsInText, parseRss, sanitizeUntrusted } from './info.js';
import { CALENDAR_2026, calendarEntriesWithin, CALENDAR_LAST_VERIFIED_AT, loadEventFeedSources, type CalendarEntry, type EventFeedSource } from './events-calendar.js';
import type { GateResult, InformationEvent, Kline, TriggerHit } from './types.js';

export type EventKind = 'scheduled' | 'news' | 'exchange' | 'onchain' | 'derived';
export type EventConfidence = 'confirmed' | 'reported' | 'rumor';
/** `dismissed` 是第六个状态:人工判定「这条不算事件」,它不再进证据也不再统计,但留痕不删。 */
export type EventStatus = 'captured' | 'briefed' | 'live' | 'resolved' | 'retro_done' | 'dismissed';

export interface EventBrief {
  source?: 'research';
  task_id?: string;
  at: number;
  /** ≤200 字的一手信息简报(便宜大脑出);模型失败时是代码写的一句兜底,不留空。 */
  text: string;
  /** 简报引用到的东西:InformationEvent.id / 链接 / 数据名。 */
  refs: string[];
  /** T−多少分钟出的这份简报(60 / 10);手动补录为 null。 */
  lead_minutes: number | null;
}

export interface EventImpact {
  move_1h_pct: number | null;
  move_4h_pct: number | null;
  move_24h_pct: number | null;
  /** 事后 24h 的平均真实波幅 ÷ 事前 24h 的;<1 = 事件反而把波动按下去了。 */
  realized_vol_ratio: number | null;
  /** impact 用哪个 symbol 的 K 线算的(宏观事件按 BTCUSDT 代表大盘)。 */
  symbol: string;
  /** 基准价(事件时刻前最后一根收盘价)。 */
  base_price: number;
  computed_at: number;
}

export interface EventStats {
  subkind: string;
  samples: number;
  surprise_move_4h?: { event_id: string; surprise: string; move_4h_pct: number; metric: string | null }[];
  avg_abs_move_4h_pct: number | null;
  avg_move_4h_pct: number | null;
  /** 方向一致率:样本里占多数的那个方向的占比(0.5–1);样本 < 2 为 null。 */
  direction_agreement: number | null;
  /** 多数方向;样本 < 2 或完全对半为 null。 */
  dominant_direction: 'up' | 'down' | null;
}

export interface MarketEvent {
  calendar?: CalendarObservation;
  consensus?: string | null;
  previous?: string | null;
  actual?: string | null;
  actual_metric?: string;
  actual_refs?: string[];
  surprise?: string | null;
  research_status?: string;
  id: string;
  kind: EventKind;
  subkind: string;
  /** 空 = 宏观事件(影响全市场)。 */
  assets: string[];
  /** scheduled 才有;其余为 null,窗口从 captured_at 起算。 */
  expected_at: number | null;
  window_ms: number;
  captured_at: number;
  source: string;
  source_ref: string;
  confidence: EventConfidence;
  status: EventStatus;
  /** 最近一份简报(T−10 出了就是 T−10 的);没出过为 null。 */
  brief: EventBrief | null;
  impact: EventImpact | null;
  /** 引用过这条事件的 episode id。 */
  used_by: string[];
  // ---- 设计 §5.1 之外、实现需要的字段(契约 §9.30 里都标了)
  /** 给人看的标题(已 sanitize)。 */
  title: string;
  /** 去重键;同键只留一条。 */
  dedupe_key: string;
  /** 历史简报(最多 2 份:T−60 / T−10);`brief` 是它的最后一条。 */
  briefs: EventBrief[];
  /** 已经为这条事件调过几次便宜大脑(硬上限 MAX_BRIEFS_PER_EVENT=2)。 */
  brief_count: number;
  updated_at: number;
  resolved_at: number | null;
  dismissed_at: number | null;
}

/** 每条事件最多问两次便宜大脑(T−60 / T−10),这是设计里的硬上限。 */
export const MAX_BRIEFS_PER_EVENT = 2;
/** 两次简报的提前量(分钟)。 */
export const BRIEF_LEADS_MIN = [60, 10] as const;
/** 简报正文上限(字);prompt 里也写了同一个数。 */
export const BRIEF_MAX_CHARS = 200;

// ---------------------------------------------------------------- 分类器(零模型)

/** 每个 subkind 的默认影响窗口。宏观数据是一瞬间的冲击,解锁/上币要看一整天。 */
export const SUBKIND_WINDOW_MS: Record<string, number> = {
  fomc: 4 * 3_600_000,
  cpi: 2 * 3_600_000,
  nfp: 2 * 3_600_000,
  unlock: 24 * 3_600_000,
  listing: 12 * 3_600_000,
  delisting: 12 * 3_600_000,
  hack: 6 * 3_600_000,
  etf_flow: 6 * 3_600_000,
  regulation: 6 * 3_600_000,
  upgrade: 12 * 3_600_000,
  funding_extreme: 8 * 3_600_000,
  vol_spike: 4 * 3_600_000,
  unclassified: 2 * 3_600_000,
};
const DEFAULT_WINDOW_MS = 2 * 3_600_000;

export function windowMsFor(subkind: string): number {
  return SUBKIND_WINDOW_MS[subkind] ?? DEFAULT_WINDOW_MS;
}

interface ClassifyRule {
  subkind: string;
  /** 命中即定;顺序 = 优先级,越具体越靠前。中英文都收。 */
  re: RegExp;
}

/**
 * 关键词表。写规则时的两条纪律:
 * 1. 宁可 `unclassified` 也不要乱贴标签——错的 subkind 会污染 eventStats,比没标签更贵。
 * 2. 只匹配名词性的事件词,不匹配「可能/或将」这类语气词(那是 confidence 的事)。
 */
export const CLASSIFY_RULES: ClassifyRule[] = [
  { subkind: 'fomc', re: /\bfomc\b|federal open market committee|fed (?:rate )?decision|interest[- ]rate decision|rate (?:hike|cut) decision|美联储(?:议息|利率决议|降息决议|加息决议)|议息会议|利率决议/i },
  { subkind: 'cpi', re: /\bcpi\b|consumer price index|inflation (?:data|report|print)|核心通胀|通胀数据|消费者物价指数/i },
  { subkind: 'nfp', re: /\bnfp\b|non-?farm(?: payrolls?)?|payrolls report|employment situation|非农(?:就业)?(?:数据|报告)?/i },
  { subkind: 'hack', re: /\bhack(?:ed|er)?\b|\bexploit(?:ed)?\b|drained|security breach|stolen funds|rug ?pull|被盗|遭黑客|攻击事件|安全漏洞|跑路/i },
  { subkind: 'unlock', re: /token unlock|\bunlock(?:s|ed|ing)?\b|vesting (?:cliff|unlock|schedule)|cliff unlock|代币解锁|解锁(?:代币|流通)|线性释放/i },
  { subkind: 'delisting', re: /\bdelist(?:s|ed|ing)?\b|will remove|removal of (?:spot )?trading pairs|下架|退市|终止交易/i },
  { subkind: 'listing', re: /will list\b|\blisting\b|lists? [A-Z]{2,10} (?:perpetual|on)|perpetual contract launch|上线(?:交易|合约|现货)|上币|新增交易对/i },
  { subkind: 'etf_flow', re: /\betf\b|spot etf (?:inflow|outflow)|net (?:inflow|outflow)s?|资金净(?:流入|流出)|现货 ?etf/i },
  { subkind: 'regulation', re: /\bsec\b|\bcftc\b|regulator(?:y|s)?|lawsuit|sued|enforcement action|sanctions?|\bban(?:s|ned)\b|legislation|监管|诉讼|处罚|制裁|立法|禁令/i },
  { subkind: 'upgrade', re: /hard fork|\bupgrade\b|mainnet launch|network upgrade|testnet launch|硬分叉|(?:网络|主网)升级|主网上线/i },
];

/** 语气词 → 可信度。命中传闻词就降级,官方源(下面 CONFIRMED_SOURCES)升级。 */
const RUMOR_RE = /\brumou?r(?:ed|s)?\b|reportedly|sources say|unconfirmed|allegedly|传闻|据传|未经证实|市场传言/i;
const REPORTED_RE = /\bmay\b|\bcould\b|expected to|plans to|考虑|或将|拟(?:于|将)|计划/i;
const CONFIRMED_SOURCES = new Set(['fed', 'calendar', 'manual']);

export interface ClassifyInput {
  title: string;
  digest?: string;
  source: string;
  kind: EventKind;
}
export interface ClassifyResult {
  subkind: string;
  assets: string[];
  confidence: EventConfidence;
  window_ms: number;
  /** true = 关键词表认不出来,记 unclassified。便宜大脑兜底(如果接了)只在这时候才有机会。 */
  unclassified: boolean;
}

/** 便宜大脑兜底接口。**默认不接**:传进来才会被调用,且只在 `unclassified` 时调一次。 */
export type BrainClassifier = (input: ClassifyInput) => Promise<string | null>;

/** 零模型分类:关键词表 → subkind,assetsInText → 资产,语气词 → 可信度。 */
export function classifyEvent(inp: ClassifyInput): ClassifyResult {
  const text = `${inp.title} ${inp.digest ?? ''}`;
  const rule = CLASSIFY_RULES.find((r) => r.re.test(text));
  const subkind = rule?.subkind ?? 'unclassified';
  const assets = assetsInText(text);
  let confidence: EventConfidence = 'reported';
  if (RUMOR_RE.test(text)) confidence = 'rumor';
  else if (CONFIRMED_SOURCES.has(inp.source) || inp.kind === 'scheduled' || inp.kind === 'derived') confidence = 'confirmed';
  else if (inp.kind === 'exchange' && !REPORTED_RE.test(text)) confidence = 'confirmed';
  return { subkind, assets, confidence, window_ms: windowMsFor(subkind), unclassified: !rule };
}

/**
 * 带兜底的分类。`brain` 不传(默认)= 纯关键词表。传了也只在 unclassified 时调一次,
 * 且模型只能从 `CLASSIFY_RULES` 已有的 subkind 里选——它没有发明新类别的权力。
 */
export async function classifyEventWithFallback(inp: ClassifyInput, classifyWithBrain?: BrainClassifier): Promise<ClassifyResult> {
  const base = classifyEvent(inp);
  if (!base.unclassified || !classifyWithBrain) return base;
  const known = new Set(CLASSIFY_RULES.map((r) => r.subkind));
  try {
    const picked = (await classifyWithBrain(inp))?.trim().toLowerCase();
    if (picked && known.has(picked)) return { ...base, subkind: picked, window_ms: windowMsFor(picked), unclassified: false };
  } catch {
    /* 兜底失败就还是 unclassified;分类不值得让采集失败 */
  }
  return base;
}

// ---------------------------------------------------------------- 实体构造与窗口

export function eventStartAt(e: Pick<MarketEvent, 'expected_at' | 'captured_at'>): number {
  return e.expected_at ?? e.captured_at;
}
export function eventEndAt(e: Pick<MarketEvent, 'expected_at' | 'captured_at' | 'window_ms'>): number {
  return eventStartAt(e) + e.window_ms;
}
/** 事件窗口内?(含两端) */
export function isWithinWindow(e: MarketEvent, now: number): boolean {
  return now >= eventStartAt(e) && now <= eventEndAt(e);
}
/** 这条事件关不关 `symbol`:资产为空 = 宏观,谁都算;否则按基础资产比。 */
export function eventTouchesSymbol(e: MarketEvent, symbol: string): boolean {
  if (e.assets.length === 0) return true;
  const base = symbol.replace(/USDT$/, '').toUpperCase();
  return e.assets.includes(base);
}

function eventId(dedupeKey: string): string {
  return `ev-${createHash('sha256').update(dedupeKey).digest('hex').slice(0, 16)}`;
}

export interface NewEventInput {
  kind: EventKind;
  subkind: string;
  title: string;
  assets?: string[];
  expected_at?: number | null;
  window_ms?: number;
  captured_at: number;
  source: string;
  source_ref?: string;
  confidence?: EventConfidence;
  dedupe_key: string;
}

export function makeEvent(inp: NewEventInput): MarketEvent {
  const window_ms = inp.window_ms ?? windowMsFor(inp.subkind);
  return {
    id: eventId(inp.dedupe_key),
    kind: inp.kind,
    subkind: inp.subkind,
    assets: [...new Set((inp.assets ?? []).map((a) => a.toUpperCase()))],
    expected_at: inp.expected_at ?? null,
    window_ms,
    captured_at: inp.captured_at,
    source: inp.source,
    source_ref: inp.source_ref ?? '',
    confidence: inp.confidence ?? 'reported',
    status: 'captured',
    brief: null,
    impact: null,
    used_by: [],
    title: sanitizeUntrusted(inp.title, 160),
    dedupe_key: inp.dedupe_key,
    briefs: [],
    brief_count: 0,
    updated_at: inp.captured_at,
    resolved_at: null,
    dismissed_at: null,
  };
}

// ---------------------------------------------------------------- 生命周期状态机

/** 合法迁移表。往回走、跳级、以及 dismissed 之后再动,一律不允许。 */
export const EVENT_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  captured: ['briefed', 'live', 'resolved', 'dismissed'],
  briefed: ['live', 'resolved', 'dismissed'],
  live: ['resolved', 'dismissed'],
  resolved: ['retro_done', 'dismissed'],
  retro_done: [],
  dismissed: [],
};

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return (EVENT_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * 纯函数:按时间算这条事件**应该**处在哪个状态。runtime 只负责把差额落库。
 * - 窗口开始前:有简报 → briefed,没有 → captured
 * - 窗口内:live
 * - 窗口结束后:resolved(impact 回填是另一步,retro_done 由聚合那一步推)
 * 已 dismissed / retro_done 的不再被时间推动。
 */
export function dueStatus(e: MarketEvent, now: number): EventStatus {
  if (e.status === 'dismissed' || e.status === 'retro_done') return e.status;
  if (now > eventEndAt(e)) return 'resolved';
  if (now >= eventStartAt(e)) return 'live';
  return e.brief_count > 0 ? 'briefed' : 'captured';
}

/** 应该走的下一步;不需要动(或不是合法迁移)返回 null。 */
export function nextStatus(e: MarketEvent, now: number): EventStatus | null {
  const due = dueStatus(e, now);
  if (due === e.status) return null;
  return canTransition(e.status, due) ? due : null;
}

/** 现在该不该出简报,以及这是 T−几分钟那一次。不该出返回 null。 */
export function dueBrief(e: MarketEvent, now: number): { lead_minutes: number } | null {
  if (e.expected_at === null) return null; // 只有 scheduled 事件做定时简报
  if (e.status === 'dismissed' || e.status === 'live' || e.status === 'resolved' || e.status === 'retro_done') return null;
  if (e.brief_count >= MAX_BRIEFS_PER_EVENT) return null;
  const minutesToGo = (e.expected_at - now) / 60_000;
  if (minutesToGo < 0) return null;
  // 第 n 次简报用第 n 个提前量;已经过了那个点(比如进程刚起来)就补一次,不跳过。
  const lead = BRIEF_LEADS_MIN[e.brief_count];
  if (lead === undefined) return null;
  return minutesToGo <= lead ? { lead_minutes: lead } : null;
}

export function applyBrief(e: MarketEvent, brief: EventBrief): MarketEvent {
  const briefs = [...e.briefs, brief].slice(-MAX_BRIEFS_PER_EVENT);
  const status: EventStatus = canTransition(e.status, 'briefed') ? 'briefed' : e.status;
  return { ...e, briefs, brief, brief_count: e.brief_count + 1, status, updated_at: brief.at };
}

// ---------------------------------------------------------------- impact 回填(纯代码)

function tr(b: Kline, prevClose: number | null): number {
  const h = Number(b.high);
  const l = Number(b.low);
  if (prevClose === null) return h - l;
  return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
}

/**
 * 从 1h K 线算 impact。`bars` 要覆盖 [at−24h, at+24h];缺的那几段对应字段就是 null,**不编**。
 * 基准 = 事件时刻**之前**最后一根已收盘 K 线的收盘价(用事件之后的价当基准会把事件本身的冲击抹掉)。
 */
export function computeImpact(bars: Kline[], at: number, symbol: string, computedAt = Date.now()): EventImpact | null {
  const sorted = [...bars].sort((a, b) => a.close_time - b.close_time);
  const beforeIdx = sorted.reduce((acc, b, i) => (b.close_time <= at ? i : acc), -1);
  if (beforeIdx < 0) return null;
  const base = Number(sorted[beforeIdx]!.close);
  if (!(base > 0)) return null;
  const closeAt = (offsetMs: number): number | null => {
    const target = at + offsetMs;
    // 要有一根收盘时间 ≥ target 的 K 线才算得出来,否则说明数据还没到那么远。
    const bar = sorted.find((b) => b.close_time >= target);
    return bar ? Number(bar.close) : null;
  };
  const pct = (p: number | null): number | null => (p === null || !Number.isFinite(p) ? null : round2(((p - base) / base) * 100));
  const before = sorted.slice(Math.max(0, beforeIdx - 23), beforeIdx + 1);
  const after = sorted.slice(beforeIdx + 1, beforeIdx + 25);
  const atrp = (window: Kline[], seedPrev: number | null): number | null => {
    if (window.length < 4) return null;
    let prev = seedPrev;
    let sum = 0;
    for (const b of window) {
      sum += tr(b, prev) / Number(b.close);
      prev = Number(b.close);
    }
    return sum / window.length;
  };
  const volBefore = atrp(before, null);
  const volAfter = atrp(after, base);
  return {
    move_1h_pct: pct(closeAt(3_600_000)),
    move_4h_pct: pct(closeAt(4 * 3_600_000)),
    move_24h_pct: pct(closeAt(24 * 3_600_000)),
    realized_vol_ratio: volBefore && volAfter && volBefore > 0 ? round2(volAfter / volBefore) : null,
    symbol,
    base_price: base,
    computed_at: computedAt,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 一条事件的 impact 该用哪个 symbol 的 K 线:有资产用第一个资产,宏观用 BTCUSDT 代表大盘。 */
export function impactSymbolFor(e: MarketEvent, fallback = 'BTCUSDT'): string {
  const a = e.assets[0];
  return a ? `${a}USDT` : fallback;
}

/** 同 subkind 的历史聚合(retro 用的「这类事件一般怎么走」)。 */
export function aggregateStats(subkind: string, events: MarketEvent[]): EventStats {
  const seenReleases = new Set<string>();
  const moves = events
    .filter((e) => e.subkind === subkind && e.status !== 'dismissed' && e.impact?.move_4h_pct !== null && e.impact !== null)
    .filter(e => {
      const key = e.calendar?.metric && e.source === 'calendar' ? `${e.subkind}:${e.expected_at}` : e.id;
      if (seenReleases.has(key)) return false;
      seenReleases.add(key); return true;
    })
    .map((e) => e.impact!.move_4h_pct!)
    .filter((m) => Number.isFinite(m));
  const samples = moves.length;
  if (samples === 0) return { subkind, samples: 0, avg_abs_move_4h_pct: null, avg_move_4h_pct: null, direction_agreement: null, dominant_direction: null };
  const up = moves.filter((m) => m > 0).length;
  const down = moves.filter((m) => m < 0).length;
  const majority = Math.max(up, down);
  return {
    subkind,
    samples,
    surprise_move_4h: events.filter(e => e.subkind === subkind && e.status !== 'dismissed' && e.surprise != null && e.impact?.move_4h_pct != null).map(e => ({ event_id: e.id, surprise: e.surprise!, move_4h_pct: e.impact!.move_4h_pct!, metric: e.actual_metric ?? null })),
    avg_abs_move_4h_pct: round2(moves.reduce((a, m) => a + Math.abs(m), 0) / samples),
    avg_move_4h_pct: round2(moves.reduce((a, m) => a + m, 0) / samples),
    direction_agreement: samples >= 2 ? round2(majority / samples) : null,
    dominant_direction: samples >= 2 && up !== down ? (up > down ? 'up' : 'down') : null,
  };
}

// ---------------------------------------------------------------- 闸:event_blackout

export const EVENT_BLACKOUT_GATE = '事件封锁';

export interface BlackoutResult {
  blocked: boolean;
  reason: string;
  /** 挡住这次开仓的事件(blocked=false 时为 null)。 */
  event: MarketEvent | null;
}

/**
 * `event_blackout_min` > 0 时:事件开始前 N 分钟一直到影响窗口结束,这个币不开新仓。
 * 只拦开仓——平仓/减仓/撤单永远放行(设计明说「只警告不拒平仓」)。0 = 关闭。
 */
export function eventBlackout(events: MarketEvent[], symbol: string, now: number, blackoutMin: number): BlackoutResult {
  if (!(blackoutMin > 0)) return { blocked: false, reason: '未启用(event_blackout_min = 0)', event: null };
  const lead = blackoutMin * 60_000;
  const hit = events
    .filter((e) => e.status !== 'dismissed' && e.status !== 'retro_done' && eventTouchesSymbol(e, symbol))
    .filter((e) => now >= eventStartAt(e) - lead && now <= eventEndAt(e))
    .sort((a, b) => eventStartAt(a) - eventStartAt(b))[0];
  if (!hit) return { blocked: false, reason: `事件封锁 ${blackoutMin} 分钟内无事件`, event: null };
  const mins = Math.round((eventStartAt(hit) - now) / 60_000);
  const when = mins > 0 ? `还有 ${mins} 分钟` : `已开始 ${-mins} 分钟`;
  return { blocked: true, reason: `${hit.subkind} 事件「${hit.title}」${when}(封锁 ${blackoutMin} 分钟 + 影响窗口),不开新仓`, event: hit };
}

/**
 * 拼成 `episode.gates` 里的那一行。`opening=false`(平仓/减仓/撤单)永远 passed,理由写清是「只拦开仓」——
 * 事件封锁不能变成「被困在仓位里出不来」。
 */
export function eventBlackoutGate(events: MarketEvent[], symbol: string, now: number, blackoutMin: number, opening: boolean): GateResult {
  if (!opening) return { name: EVENT_BLACKOUT_GATE, passed: true, reason: '不适用(事件封锁只拦开仓,不拦平仓/减仓/撤单)' };
  const r = eventBlackout(events, symbol, now, blackoutMin);
  return { name: EVENT_BLACKOUT_GATE, passed: !r.blocked, reason: r.reason };
}

// ---------------------------------------------------------------- 三路 capture

/** 新闻 → 事件。信息员抓到的 InformationEvent 直接喂进来,零模型。 */
export function eventsFromNews(news: InformationEvent[], now: number): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (const n of news) {
    if (n.kind !== 'news' || n.source === 'research') continue;
    const c = classifyEvent({ title: n.title, digest: n.digest, source: n.source, kind: 'news' });
    out.push(
      makeEvent({
        kind: 'news',
        subkind: c.subkind,
        title: n.title,
        assets: c.assets,
        expected_at: null,
        window_ms: c.window_ms,
        // 新闻的窗口从「新闻发生时刻」起算,不是从我们抓到的时刻起算(抓取可能晚几小时)。
        captured_at: Math.min(n.occurred_at, now),
        source: n.source,
        source_ref: n.source_ref,
        confidence: c.confidence,
        dedupe_key: `news:${n.dedupe_key}`,
      }),
    );
  }
  return out;
}

/** 日历 → 事件(静态表,零网络)。 */
export function eventsFromCalendar(now: number, horizonMs = 30 * 86_400_000, table: CalendarEntry[] = CALENDAR_2026): MarketEvent[] {
  return calendarEntriesWithin(now, horizonMs, table).map((c) =>
    makeEvent({
      kind: 'scheduled',
      subkind: c.subkind,
      title: c.title,
      assets: [], // 宏观
      expected_at: c.expected_at,
      window_ms: windowMsFor(c.subkind),
      captured_at: now,
      source: 'calendar',
      source_ref: c.source_ref,
      confidence: 'reported',
      dedupe_key: `cal:${c.subkind}:${c.expected_at}${c.metric ? `:${c.metric}` : ''}`,
    }),
  );
}

/** 派生 → 事件:triggers.ts 的 funding / vol_spike 升格。去重由 EventStore.capture 按「同资产同 subkind 同窗口」做。 */
export function eventsFromTriggers(symbol: string, hits: TriggerHit[], now: number): MarketEvent[] {
  const asset = symbol.replace(/USDT$/, '').toUpperCase();
  const out: MarketEvent[] = [];
  for (const h of hits) {
    const subkind = h.kind === 'funding' ? 'funding_extreme' : h.kind === 'vol_spike' ? 'vol_spike' : null;
    if (!subkind) continue;
    const window_ms = windowMsFor(subkind);
    // 去重桶:同资产同 subkind 在一个窗口里只留一条(桶边界也是 dedupe_key 的一部分,DB 的唯一索引兜底)。
    const bucket = Math.floor(now / window_ms);
    out.push(
      makeEvent({
        kind: 'derived',
        subkind,
        title: `${symbol} ${subkind === 'funding_extreme' ? '资金费率极端' : '成交量异动'}:${h.detail}`,
        assets: [asset],
        expected_at: null,
        window_ms,
        captured_at: now,
        source: 'triggers',
        source_ref: `trigger:${h.kind}`,
        confidence: 'confirmed',
        dedupe_key: `derived:${asset}:${subkind}:${bucket}`,
      }),
    );
  }
  return out;
}

/** 订阅源 → 事件。默认没有源(loadEventFeedSources 返回空),这函数就什么都不做。 */
export async function eventsFromFeeds(
  sources: EventFeedSource[],
  now: number,
  fetchText: (url: string) => Promise<string>,
): Promise<{ events: MarketEvent[]; errors: string[] }> {
  const events: MarketEvent[] = [];
  const errors: string[] = [];
  for (const src of sources) {
    try {
      const body = await fetchText(src.url);
      const maxAge = (src.max_age_hours ?? 24) * 3_600_000;
      if (src.format === 'rss') {
        for (const item of parseRss(body, src.name, now, 20, maxAge)) {
          const c = classifyEvent({ title: item.title, digest: item.digest, source: src.name, kind: src.kind });
          const subkind = src.subkind ?? c.subkind;
          events.push(
            makeEvent({
              kind: src.kind,
              subkind,
              title: item.title,
              assets: c.assets,
              expected_at: null,
              window_ms: windowMsFor(subkind),
              captured_at: Math.min(item.occurred_at, now),
              source: src.name,
              source_ref: item.source_ref,
              ...(src.confidence ? { confidence: src.confidence } : { confidence: c.confidence }),
              dedupe_key: `feed:${src.name}:${item.dedupe_key}`,
            }),
          );
        }
      } else {
        const rows = JSON.parse(body) as { title?: unknown; url?: unknown; at?: unknown; assets?: unknown; subkind?: unknown }[];
        if (!Array.isArray(rows)) throw new Error('JSON 源必须是数组');
        for (const r of rows.slice(0, 50)) {
          const title = typeof r.title === 'string' ? r.title : '';
          const at = Number(r.at);
          if (!title || !Number.isFinite(at)) continue;
          const c = classifyEvent({ title, source: src.name, kind: src.kind });
          const subkind = typeof r.subkind === 'string' && r.subkind ? r.subkind : (src.subkind ?? c.subkind);
          const assets = Array.isArray(r.assets) ? r.assets.filter((x): x is string => typeof x === 'string') : c.assets;
          const future = at > now;
          events.push(
            makeEvent({
              kind: src.kind,
              subkind,
              title,
              assets,
              // 未来的时间点 = 预定事件(解锁日历就是这样);过去的 = 已经发生的公告。
              expected_at: future ? at : null,
              window_ms: windowMsFor(subkind),
              captured_at: future ? now : at,
              source: src.name,
              source_ref: typeof r.url === 'string' ? r.url : '',
              ...(src.confidence ? { confidence: src.confidence } : { confidence: c.confidence }),
              dedupe_key: `feed:${src.name}:${createHash('sha256').update(`${title}|${at}`).digest('hex').slice(0, 32)}`,
            }),
          );
        }
      }
    } catch (e) {
      errors.push(`${src.name}: ${(e as Error).message}`);
    }
  }
  return { events, errors };
}

// ---------------------------------------------------------------- 持久化

export interface EventListFilter {
  status?: EventStatus;
  /** 基础资产(BTC)或交易对(BTCUSDT);宏观事件(assets 为空)在按资产筛时**也会**返回。 */
  asset?: string;
  /** 只要窗口结束时间 ≥ since 的(默认不限)。 */
  since?: number;
  subkind?: string;
  limit?: number;
}

export class EventStore {
  readonly research: ResearchStore;
  constructor(private readonly db: DatabaseSync) { this.research = new ResearchStore(db); }

  private rowToEvent(row: { json: string }): MarketEvent {
    return JSON.parse(row.json) as MarketEvent;
  }

  save(e: MarketEvent): void {
    this.db
      .prepare(
        `INSERT INTO market_events(id, kind, subkind, assets_json, expected_at, window_ms, captured_at, starts_at, ends_at, source, source_ref, confidence, status, dedupe_key, updated_at, json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET subkind = excluded.subkind, assets_json = excluded.assets_json, expected_at = excluded.expected_at,
           window_ms = excluded.window_ms, starts_at = excluded.starts_at, ends_at = excluded.ends_at, confidence = excluded.confidence,
           status = excluded.status, updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(e.id, e.kind, e.subkind, JSON.stringify(e.assets), e.expected_at, e.window_ms, e.captured_at, eventStartAt(e), eventEndAt(e), e.source, e.source_ref, e.confidence, e.status, e.dedupe_key, e.updated_at, JSON.stringify(e));
  }

  get(id: string): MarketEvent | null {
    const row = this.db.prepare('SELECT json FROM market_events WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? this.rowToEvent(row) : null;
  }

  byDedupeKey(key: string): MarketEvent | null {
    const row = this.db.prepare('SELECT json FROM market_events WHERE dedupe_key = ?').get(key) as { json: string } | undefined;
    return row ? this.rowToEvent(row) : null;
  }

  /**
   * 落一条新事件。三层去重:
   * 1. `dedupe_key` 已存在 → 不动旧行(旧行可能已经有简报/impact,新抓到的同一条不能把它打回 captured)。
   * 2. 派生事件:同资产同 subkind 的窗口**重叠** → 跳过(桶边界切开时的补丁)。
   * 3. DB 上 `dedupe_key` 唯一索引兜底。
   */
  capture(e: MarketEvent): { event: MarketEvent; created: boolean } {
    const existing = this.byDedupeKey(e.dedupe_key);
    if (existing) return { event: existing, created: false };
    if (e.kind === 'derived') {
      const dup = this.overlappingDerived(e);
      if (dup) return { event: dup, created: false };
    }
    this.save(e);
    return { event: e, created: true };
  }

  captureMany(events: MarketEvent[]): { created: MarketEvent[]; skipped: number } {
    const created: MarketEvent[] = [];
    let skipped = 0;
    for (const e of events) {
      const r = this.capture(e);
      if (r.created) created.push(r.event);
      else skipped++;
    }
    return { created, skipped };
  }

  private overlappingDerived(e: MarketEvent): MarketEvent | null {
    const start = eventStartAt(e);
    const end = eventEndAt(e);
    const rows = this.db
      .prepare("SELECT json FROM market_events WHERE kind = 'derived' AND subkind = ? AND status != 'dismissed' AND ends_at >= ? AND starts_at <= ?")
      .all(e.subkind, start, end) as { json: string }[];
    for (const r of rows) {
      const other = this.rowToEvent(r);
      if (other.assets.some((a) => e.assets.includes(a))) return other;
    }
    return null;
  }

  list(filter: EventListFilter = {}): MarketEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.subkind) {
      where.push('subkind = ?');
      args.push(filter.subkind);
    }
    if (filter.since !== undefined) {
      where.push('ends_at >= ?');
      args.push(filter.since);
    }
    const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
    const sql = `SELECT json FROM market_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY starts_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit) as { json: string }[];
    let out = rows.map((r) => this.rowToEvent(r));
    if (filter.asset) {
      const base = filter.asset.toUpperCase().replace(/USDT$/, '');
      // 宏观事件(assets 为空)对每个币都相关,按资产筛时保留。
      out = out.filter((e) => e.assets.length === 0 || e.assets.includes(base));
    }
    return out;
  }

  /** 「现在还活着」的事件:没 dismissed/retro_done,且窗口还没结束太久(默认到窗口结束为止)。 */
  activeAt(now: number, lookbackMs = 0): MarketEvent[] {
    const rows = this.db
      .prepare("SELECT json FROM market_events WHERE status NOT IN ('dismissed','retro_done') AND ends_at >= ? ORDER BY starts_at ASC LIMIT 200")
      .all(now - lookbackMs) as { json: string }[];
    return rows.map((r) => this.rowToEvent(r));
  }

  /** 窗口内、且和这个 symbol 有关的事件(判断证据 / event 触发器 / 闸都用它)。 */
  liveFor(symbol: string, now: number): MarketEvent[] {
    return this.activeAt(now).filter((e) => isWithinWindow(e, now) && eventTouchesSymbol(e, symbol));
  }

  /** 窗口已经结束、还没回填 impact 的(resolve 一步)。 */
  needingResolve(now: number, limit = 20): MarketEvent[] {
    const rows = this.db
      .prepare("SELECT json FROM market_events WHERE status NOT IN ('dismissed','retro_done') AND ends_at < ? ORDER BY ends_at ASC LIMIT ?")
      .all(now, limit) as { json: string }[];
    return rows.map((r) => this.rowToEvent(r));
  }

  /** 已 resolved、impact 在手、还没做同类聚合的(retro 一步)。 */
  needingRetro(limit = 20): MarketEvent[] {
    const rows = this.db.prepare("SELECT json FROM market_events WHERE status = 'resolved' ORDER BY ends_at ASC LIMIT ?").all(limit) as { json: string }[];
    return rows.map((r) => this.rowToEvent(r));
  }

  /** 还没到窗口、需要出简报的 scheduled 事件。 */
  needingBrief(now: number): { event: MarketEvent; lead_minutes: number }[] {
    const rows = this.db
      .prepare("SELECT json FROM market_events WHERE kind = 'scheduled' AND status IN ('captured','briefed') AND starts_at > ? ORDER BY starts_at ASC LIMIT 20")
      .all(now) as { json: string }[];
    const out: { event: MarketEvent; lead_minutes: number }[] = [];
    for (const r of rows) {
      const e = this.rowToEvent(r);
      const due = dueBrief(e, now);
      if (due) out.push({ event: e, lead_minutes: due.lead_minutes });
    }
    return out;
  }

  /** 同 subkind 的历史聚合;只数已经有 impact 的。 */
  stats(subkind: string, limit = 200): EventStats {
    const rows = this.db
      .prepare("SELECT json FROM market_events WHERE subkind = ? AND status IN ('resolved','retro_done') ORDER BY ends_at DESC LIMIT ?")
      .all(subkind, limit) as { json: string }[];
    return aggregateStats(subkind, rows.map((r) => this.rowToEvent(r)));
  }

  /** 记一次「这条事件被某个 episode 用了」。 */
  markUsed(id: string, episodeId: string, now = Date.now()): void {
    const e = this.get(id);
    if (!e || e.used_by.includes(episodeId)) return;
    this.save({ ...e, used_by: [...e.used_by, episodeId].slice(-50), updated_at: now });
  }

  /** 人工判定「这不算事件」。已 dismissed 的再点一次是幂等的。 */
  dismiss(id: string, now = Date.now()): MarketEvent | null {
    const e = this.get(id);
    if (!e) return null;
    if (e.status === 'dismissed') return e;
    const next: MarketEvent = { ...e, status: 'dismissed', dismissed_at: now, updated_at: now };
    this.save(next);
    return next;
  }

  /** 推一次状态(时间驱动);没动返回 null。 */
  advance(e: MarketEvent, now: number): MarketEvent | null {
    const to = nextStatus(e, now);
    if (!to) return null;
    const next: MarketEvent = { ...e, status: to, updated_at: now, ...(to === 'resolved' ? { resolved_at: now } : {}) };
    this.save(next);
    return next;
  }
}

/** 日历静态表的元信息,出到接口上让前端能提示「这表多久没核对了」。 */
export function calendarMeta(): { last_verified_at: number; entries: number; feeds: number } {
  return { last_verified_at: CALENDAR_LAST_VERIFIED_AT, entries: CALENDAR_2026.length, feeds: loadEventFeedSources().length };
}

/** 给 event_driven SignalFn 的只读输入；本模块没有 Intent/执行依赖。 */
export function eventResearchSignalInput(e: MarketEvent) {
  return { event_id: e.id, subkind: e.subkind, expected_at: e.expected_at, actual: e.actual ?? null, consensus: e.consensus ?? null, surprise: e.surprise ?? null, metric: e.actual_metric ?? null, refs: e.actual != null ? e.actual_refs ?? [] : e.brief?.refs ?? [], confidence: e.calendar?.calendar_status ?? e.confidence };
}
