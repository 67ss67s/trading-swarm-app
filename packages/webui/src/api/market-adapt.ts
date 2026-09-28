/**
 * 信号市场适配层:网关(契约 §9.39)把 OKX CLI 的 data **原样**透传(身份对象、订阅行、服务、评价都是平台字段),
 * 这里统一映射成页面用的视图类型(api/types.ts 的 Market*),组件不认平台字段名。
 * 平台字段随时可能变,所以每个读取都是防御式的:读不到就 null / 0 / '',不抛。
 */
import type {
  ReadCacheMeta,
  FollowMode,
  FollowOverview,
  MarketAftersale,
  MarketAftersaleStatus,
  MarketAsp,
  MarketAspDetail,
  MarketAspSummary,
  MarketDeliveryOut,
  MarketFeedback,
  MarketFundingNotice,
  MarketIdentity,
  MarketInboxParseStatus,
  MarketInboxRow,
  MarketInboxStatus,
  MarketPublisherSettings,
  MarketService,
  MarketSettings,
  MarketStatus,
  MarketSubscriber,
  MarketSubscriptionDisplay,
  MarketSubscriptionGroup,
  MarketSubscriptionView,
  MarketWallet,
  OkxAccountStatus,
  TraderSignal,
} from './types';
import { FOLLOW_MODES, TRADER_SIGNAL_STATUSES } from './types';
import { getLang, t } from '../lib/i18n';
import { TOO_MANY_REQUESTS } from '@/lib/edition';

type Obj = Record<string, unknown>;
/**
 * 评审版(VITE_EDITION=judge)网关从快照文件回同形响应,额外带 `snapshot: { as_of, source }`
 * (as_of 可能是 unix 毫秒 / 秒 / ISO)。字段可能缺,缺了就不带;默认版网关不发这个字段,视图不变。
 */
export interface MarketSnapshotMeta {
  as_of: number | string | null;
  source: string | null;
}
export type WithSnapshot = { snapshot?: MarketSnapshotMeta };
export function snapshotOf(raw: unknown): WithSnapshot {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Obj)['snapshot'] : undefined;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  const o = s as Obj;
  const asOf = typeof o['as_of'] === 'number' || typeof o['as_of'] === 'string' ? (o['as_of'] as number | string) : null;
  return { snapshot: { as_of: asOf, source: typeof o['source'] === 'string' ? o['source'] : null } };
}
/** 多个响应里取第一个有 snapshot.as_of 的(状态 / 身份 / 目录谁有用谁)。 */
export function pickSnapshotAsOf(...sources: unknown[]): number | string | null {
  for (const x of sources) {
    const v = snapshotOf(x).snapshot?.as_of;
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}
const cacheOf = (o: Obj): { cache?: ReadCacheMeta } & WithSnapshot => ({ ...(o['cache'] ? { cache: o['cache'] as ReadCacheMeta } : {}), ...snapshotOf(o) });
export const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
/** 平台 data 有时是 `{list:[…]}`、有时是 `{items:[…]}`、有时直接是数组。 */
export function list(v: unknown): Obj[] {
  if (Array.isArray(v)) return v.map(obj);
  const o = obj(v);
  for (const k of ['list', 'items', 'services', 'data', 'rows', 'agentList']) if (Array.isArray(o[k])) return (o[k] as unknown[]).map(obj);
  return [];
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';
/** 时间:秒 / 毫秒 / ISO 自适应。 */
function ms(v: unknown): number | null {
  if (typeof v === 'string' && /[^0-9.]/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n > 1e14 ? Math.floor(n / 1000) : n;
}
/** 网关的 mode:`copy` 旧名当 book。 */
const modeOf = (v: unknown): FollowMode => (v === 'book' || v === 'copy' ? 'book' : v === 'gated' ? 'gated' : 'evidence');
const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};
/** `card[]` / `cells[]` 里的 `{label,value}` 行(get-my-agents 那套)。 */
function cell(o: Obj, label: string): string | null {
  for (const k of ['cells', 'card']) {
    const rows = Array.isArray(o[k]) ? (o[k] as unknown[]).map(obj) : [];
    const hit = rows.find((r) => String(r['label'] ?? '').toLowerCase() === label.toLowerCase());
    if (hit) return str(hit['value']);
  }
  return null;
}

// ---------------------------------------------------------------------------

export function adaptIdentity(raw: unknown): MarketIdentity | null {
  const o = obj(raw);
  const id = str(pick(o, 'agentId', 'aspAgentId', 'id'));
  if (!id) return null;
  const roleLabel = String(pick(o, 'roleLabel', 'role') ?? '').toLowerCase();
  return {
    agent_id: id,
    name: str(pick(o, 'name', 'aspName')) ?? cell(o, 'Name') ?? `#${id}`,
    role: /asp|provider|seller/.test(roleLabel || (cell(o, 'Role') ?? '').toLowerCase()) ? 'asp' : /user|buyer/.test(roleLabel || (cell(o, 'Role') ?? '').toLowerCase()) ? 'user' : roleLabel,
    status: str(pick(o, 'statusLabel', 'status')) ?? cell(o, 'Status') ?? '',
    approval: str(pick(o, 'approvalLabel')) ?? cell(o, 'Approval status'),
    rating: str(pick(o, 'rating', 'ratingStars')) ?? cell(o, 'Rating'),
    sold_count: num(pick(o, 'soldCount', 'sold_count')) ?? 0,
    avatar: str(pick(o, 'profilePicture', 'avatar', 'picture', 'imageUrl')),
    description: str(pick(o, 'profileDescription', 'description')) ?? cell(o, 'Description'),
  };
}

function adaptAspSummary(raw: unknown, fallback?: MarketIdentity | null): MarketAspSummary {
  const o = obj(raw);
  return {
    asp_agent_id: str(pick(o, 'aspAgentId', 'agentId')) ?? fallback?.agent_id ?? '',
    asp_name: str(pick(o, 'aspName', 'name')) ?? fallback?.name ?? '',
    rating: str(pick(o, 'rating')) ?? fallback?.rating ?? null,
    security_rate: num(pick(o, 'securityRate')),
    feedback_rate: num(pick(o, 'feedbackRate')),
    sold_count: num(pick(o, 'soldCount')) ?? fallback?.sold_count ?? 0,
    online: bool(pick(o, 'onlineStatus', 'online')),
  };
}

export function adaptService(raw: unknown, asp?: MarketAspSummary): MarketService {
  const o = obj(raw);
  const subs = Array.isArray(o['subscription']) ? (o['subscription'] as unknown[]).map(obj) : [];
  const trial = str(pick(o, 'freeTrial'));
  return {
    service_id: str(pick(o, 'serviceId', 'id')) ?? '',
    sid: num(pick(o, 'sid')),
    service_name: str(pick(o, 'serviceName', 'name')) ?? '',
    service_description: str(pick(o, 'serviceDescription', 'description')) ?? '',
    service_type: str(pick(o, 'serviceType', 'type')) ?? 'A2A',
    fee_amount: str(pick(o, 'feeAmount', 'fee')),
    fee_token_symbol: str(pick(o, 'feeTokenSymbol')) ?? 'USDT',
    fee_token_address: str(pick(o, 'feeToken', 'feeTokenAddress')),
    subscription: subs.map((s) => ({ interval: str(s['interval']) ?? 'month', fee: str(s['fee']) ?? '0' })),
    support_trial: bool(pick(o, 'supportTrial')) || (trial !== null && Number(trial) > 0),
    free_trial: trial,
    is_subscribing: bool(pick(o, 'isSubscribing')),
    endpoint: str(pick(o, 'endpoint')),
    asp: asp ?? adaptAspSummary(o['asp']),
  };
}

export function adaptSearch(raw: unknown): { services: MarketService[]; search_after: string | null; has_more: boolean; unmatch_reason: string | null; cache?: ReadCacheMeta } & WithSnapshot {
  const o = obj(raw);
  return { ...cacheOf(o), services: list(o['services']).map((s) => adaptService(s)), search_after: str(o['searchAfter']), has_more: bool(o['hasMore']), unmatch_reason: str(o['unmatchReason']) };
}

export function adaptAspDetail(raw: unknown): MarketAspDetail {
  const o = obj(raw);
  const p = obj(o['profile']);
  const identity = adaptIdentity(p) ?? { agent_id: '', name: '', role: 'asp', status: '', approval: null, rating: null, sold_count: 0, avatar: null, description: null };
  const summary: MarketAspSummary = { ...adaptAspSummary(p, identity), asp_agent_id: identity.agent_id, asp_name: identity.name };
  const feedback: MarketFeedback[] = list(o['feedback']).map((f) => ({
    score: num(pick(f, 'score', 'rating')),
    reviewer: str(pick(f, 'reviewerName', 'creatorName', 'reviewer', 'creatorId', 'reviewerId')),
    role: str(pick(f, 'reviewerRole', 'role')),
    date: str(pick(f, 'date', 'createdAt', 'createTime')),
    description: str(pick(f, 'description', 'comment')),
  }));
  return {
    ...cacheOf(o),
    profile: { ...identity, online: bool(pick(p, 'onlineStatus', 'online')), feedback_rate: num(pick(p, 'feedbackRate')) },
    services: list(o['services']).map((s) => adaptService(s, summary)),
    feedback,
    feedback_error: typeof o['feedback'] === 'string' ? o['feedback'] : null,
  };
}

export function adaptWallet(raw: unknown, error: string | null): MarketWallet {
  const o = obj(raw);
  return {
    logged_in: bool(o['logged_in']),
    email: str(o['email']),
    account_name: str(o['account_name']),
    address: str(o['address']),
    chain: str(o['chain']) ?? 'xlayer',
    balance_usdt: str(o['balance_usdt']),
    deposit_address: str(o['deposit_address']),
    error,
  };
}

export function adaptInboxStatus(raw: unknown): MarketInboxStatus {
  const o = obj(raw);
  const received = num(o['received']) ?? 0;
  const analysis = num(o['analysis']) ?? 0;
  const dlq = num(o['dlq']) ?? 0;
  // 新网关带 counts(按新分类规则重算的逐状态计数):交易信号只算 order/expired,情报/分析 = analysis+report+intel+status+arbitrage,
  // 没读懂 = invalid,处理失败 = 真正的下载/解密失败。老网关没有 counts 时退回旧口径(received − analysis − dlq)。
  const counts = obj(o['counts']);
  const has = !!o['counts'] && typeof o['counts'] === 'object' && !Array.isArray(o['counts']);
  const c = (k: string) => num(counts[k]) ?? 0;
  return {
    transport: o['transport'] === 'watch' ? 'watch' : 'queue',
    available: bool(o['alive']),
    db_path: null,
    last_poll_at: ms(o['last_poll']),
    last_error: str(o['last_error']),
    failures: 0,
    next_attempt_at: null,
    ledger_total: received,
    ingested: has ? c('order') + c('expired') : Math.max(0, received - analysis - dlq),
    skipped_analysis: has ? c('analysis') + c('report') + c('intel') + c('status') + c('arbitrage') : analysis,
    bad_rows: has ? c('invalid') : dlq,
    cursor: num(o['cursor']) ?? 0,
    dlq_count: has ? c('fetch_failed') : dlq,
  };
}

/** `subscribe-cost` 的 data:字段不定,尽量找「总额」和「条数」。 */
function adaptCost(raw: unknown): MarketStatus['monthly_cost'] {
  const o = obj(raw);
  const amount = str(pick(o, 'totalMonthlyCost', 'monthlyCost', 'totalCost', 'total', 'amount', 'cost'));
  const rows = list(o);
  return { amount, currency: str(pick(o, 'currency', 'tokenSymbol')) ?? 'USDT', count: num(pick(o, 'count', 'activeCount')) ?? rows.length };
}

export function adaptPublisher(raw: unknown): MarketPublisherSettings {
  const o = obj(raw);
  const backend = Array.isArray(o['backend_filter']) ? (o['backend_filter'] as unknown[]).map(String) : ['okx', 'binance'];
  return {
    enabled: bool(o['enabled']),
    publish_orders: o['publish_orders'] !== false,
    publish_analysis: o['publish_analysis'] !== false,
    symbols: Array.isArray(o['symbols']) ? (o['symbols'] as unknown[]).map(String) : [],
    include_realized_pnl: o['include_realized_pnl'] !== false,
    allow_paper_analysis: backend.includes('paper'),
    backend_filter: backend,
  };
}

/** 反向:页面的 allow_paper_analysis 折回 backend_filter 里的 'paper'。 */
export function publisherToWire(p: Partial<MarketPublisherSettings>): Obj {
  const { allow_paper_analysis, ...rest } = p;
  const out: Obj = { ...rest };
  if (allow_paper_analysis !== undefined) {
    const base = (rest.backend_filter ?? ['okx', 'binance']).filter((x) => x !== 'paper');
    out['backend_filter'] = allow_paper_analysis ? [...base, 'paper'] : base;
  }
  return out;
}

export function adaptSettings(raw: unknown): MarketSettings {
  const o = obj(raw);
  const subs: MarketSettings['subscriptions'] = {};
  for (const [k, v] of Object.entries(obj(o['subscriptions']))) {
    const c = obj(v);
    subs[k] = { mode: modeOf(c['mode']), approval: c['approval'] === 'auto' ? 'auto' : 'manual', weight: num(c['weight']) ?? 0, enabled: c['enabled'] !== false, label: str(c['label']) };
  }
  return {
    enabled: bool(o['enabled']),
    auto_manage: false,
    transport: o['transport'] === 'watch' ? 'watch' : 'queue',
    poll_ms: num(o['poll_ms']) ?? 3000,
    freshness_s: num(o['freshness_s']) ?? 180,
    default_mode: modeOf(o['default_mode']),
    max_signals_per_subscription_per_day: num(o['max_signals_per_subscription_per_day']) ?? 0,
    subscriptions: subs,
    publisher: adaptPublisher(o['publisher']),
  };
}

export function adaptStatus(raw: unknown, settings: MarketSettings): MarketStatus {
  const o = obj(raw);
  const errors = obj(o['errors']);
  const lights = obj(o['lights']) as unknown as OkxAccountStatus;
  return {
    ...cacheOf(o),
    sections: o['sections'] as Record<string, ReadCacheMeta> | undefined,
    lights: {
      wallet: obj(lights.wallet) as unknown as OkxAccountStatus['wallet'],
      a2a: obj(o['a2a'] ?? lights.a2a) as unknown as OkxAccountStatus['a2a'],
      trade_kit: obj(o['trade_kit'] ?? lights.trade_kit) as unknown as OkxAccountStatus['trade_kit'],
      checked_at: num(lights.checked_at) ?? Date.now(),
    },
    wallet: adaptWallet(o['wallet'], str(errors['wallet'])),
    buyer: adaptIdentity(o['buyer']),
    asp: adaptIdentity(o['asp']),
    this_device: null,
    monthly_cost: adaptCost(o['subscribe_cost']),
    inbox: adaptInboxStatus(o['inbox']),
    settings,
    checked_at: Date.now(),
  };
}

export function adaptFundingNotice(raw: unknown): MarketFundingNotice | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw);
  return {
    deposit_address: str(pick(o, 'deposit_address', 'depositAddress', 'address')),
    currency: str(pick(o, 'currency', 'tokenSymbol')) ?? 'USDT',
    shortfall: str(pick(o, 'shortfall', 'shortfallAmount')),
    qr_png_base64: str(pick(o, 'qr_base64', 'qr_png_base64', 'qrBase64')),
    text: str(pick(o, 'text', 'message', 'error')),
  };
}

function adaptSubStats(raw: unknown): MarketSubscriptionView['stats'] {
  const o = obj(raw);
  return {
    received: num(o['received']) ?? 0,
    orders: num(pick(o, 'order', 'orders')) ?? 0,
    analysis: num(o['analysis']) ?? 0,
    applied: num(pick(o, 'followed', 'applied')) ?? 0,
    skipped: num(o['skipped']) ?? 0,
    review_only: num(o['review_only']) ?? 0,
    agent_judged: num(o['agent_judged']) ?? 0,
    agent_agree_rate: num(o['agent_agree_rate']),
    realized_r: num(o['realized_r']),
    settling: num(o['settling']) ?? 0,
  };
}

/** 订阅栏分组顺序(设计 2026-09-25):进行中 → 试用中 → 等服务方接单 → 已取消续费但试用未到期 → 已结束。 */
export const SUB_GROUP_ORDER: readonly MarketSubscriptionGroup[] = ['active', 'trial', 'pending', 'cancelled_trial', 'ended'];
const SUB_GROUPS = new Set<string>(SUB_GROUP_ORDER);

/**
 * 网关没带 `display`(老网关)时按状态 / 试用字段兜底算分组,口径跟网关 asp-agent/agent.ts `subscriptionDisplay` 一致:
 *   - 试用且没开自动续费(ACTIVE,或本期还没到期)= 「已取消续费 · 试用至 X」;
 *   - 另外兜住 CLOSED + 试用结束时间还没到(取消的只是到期转付费,试用照常)。
 */
export function subscriptionDisplay(
  s: Pick<MarketSubscriptionView, 'status_name' | 'trial_type' | 'auto_renew' | 'trial_end_time' | 'sub_end_time'>,
  now: number = Date.now(),
): MarketSubscriptionDisplay {
  const trial = s.trial_type === 1;
  const st = s.status_name;
  if (trial && !s.auto_renew && (st === 'ACTIVE' || (s.sub_end_time !== null && s.sub_end_time > now))) {
    return { group: 'cancelled_trial', label: t('已取消续费 · 试用中'), until: st === 'ACTIVE' ? (s.trial_end_time ?? s.sub_end_time) : s.sub_end_time };
  }
  if (trial && st === 'CLOSED' && s.trial_end_time !== null && s.trial_end_time > now) {
    return { group: 'cancelled_trial', label: t('已取消续费 · 试用中'), until: s.trial_end_time };
  }
  if (st === 'ACTIVE' && trial) return { group: 'trial', label: t('试用中'), until: s.trial_end_time ?? s.sub_end_time };
  if (st === 'ACTIVE') return { group: 'active', label: s.auto_renew ? t('进行中 · 自动续费') : t('进行中'), until: s.sub_end_time };
  if (!st || st === 'INIT' || st === 'CREATED') return { group: 'pending', label: t('等服务方接单'), until: null };
  const ended: Record<string, string> = {
    CLOSED: trial ? t('试用已结束') : t('已结束'),
    EXPIRED: t('已到期'),
    COMPLETED: t('已完成'),
    REJECTED: t('已拒收'),
    DISPUTED: t('争议处理中'),
    FAILED: t('已终止'),
  };
  return { group: 'ended', label: ended[st] ?? t('已结束'), until: s.sub_end_time ?? s.trial_end_time };
}

function adaptDisplay(raw: unknown, fallback: MarketSubscriptionDisplay): MarketSubscriptionDisplay {
  const d = obj(raw);
  const group = str(d['group']);
  if (!group || !SUB_GROUPS.has(group)) return fallback;
  return { group: group as MarketSubscriptionGroup, label: str(d['label']) || fallback.label, until: d['until'] === null ? null : (ms(d['until']) ?? fallback.until) };
}

export function adaptSubscriptions(raw: unknown): { subscriptions: MarketSubscriptionView[]; this_device: { id: string; name: string } | null; error: string | null; cache?: ReadCacheMeta } & WithSnapshot {
  const o = obj(raw);
  const deviceId = str(o['thisDeviceId']);
  const started = new Map<string, number>();
  const subs: MarketSubscriptionView[] = list(o['subscriptions']).map((s) => {
    const r = obj(s['remote']);
    const cfg = obj(s['config']);
    const job = str(s['job_id']) ?? str(r['jobId']) ?? '';
    const autoRenew = pick(r, 'autoRenew', 'autoRenewal');
    const asp = obj(s['asp']);
    const view: Omit<MarketSubscriptionView, 'display'> = {
      job_id: job,
      title: str(pick(r, 'jobTitle', 'title')) ?? '',
      service_name: str(pick(r, 'serviceName', 'title', 'jobTitle')) ?? str(cfg['label']) ?? job.slice(0, 10),
      service_id: str(pick(r, 'serviceId')),
      provider_agent_id: str(pick(r, 'providerAgentId', 'aspAgentId')),
      provider_name: str(asp['name']) ?? str(pick(r, 'providerAgentName', 'providerName', 'aspName')) ?? (s['remote'] ? '' : t('(仅本地配置)')),
      asp_avatar: str(asp['avatar']),
      asp_service_name: str(asp['service_name']),
      status_name: (str(pick(r, 'statusName')) ?? ({ '-1': 'INIT', '0': 'CREATED', '1': 'ACTIVE', '3': 'REJECTED', '4': 'DISPUTED', '6': 'COMPLETED', '7': 'CLOSED', '8': 'EXPIRED', '9': 'FAILED' }[String(r['status'])]) ?? str(r['status']) ?? (s['remote'] ? 'INIT' : 'CLOSED')).toUpperCase(),
      trial_type: num(pick(r, 'trialType')),
      period_index: num(pick(r, 'periodIndex')),
      auto_renew: bool(autoRenew),
      sub_end_time: ms(pick(r, 'subEndTime', 'endTime')),
      trial_end_time: ms(pick(r, 'trialEndTime')),
      fee_amount: str(pick(r, 'serviceTokenAmount', 'feeAmount')),
      this_device_receives: bool(pick(r, 'thisDeviceReceives')),
      device_list: Array.isArray(r['deviceList']) ? (r['deviceList'] as unknown[]).map(String) : null,
      config: { mode: modeOf(cfg['mode']), approval: cfg['approval'] === 'auto' ? 'auto' : 'manual', weight: num(cfg['weight']) ?? 0, enabled: cfg['enabled'] !== false, label: str(cfg['label']) },
      stats: adaptSubStats(s['stats']),
      last_delivery_at: ms(obj(s['stats'])['last_signal_at']),
    };
    started.set(job, ms(pick(r, 'subStartTime', 'trialStartTime', 'createTime')) ?? 0);
    return { ...view, display: adaptDisplay(s['display'], subscriptionDisplay(view)) };
  });
  // 网关已按分组排好;老网关兜底时这里再排一次(分组顺序,组内按开始时间倒序;稳定排序,网关顺序不被打乱)。
  const backendSorted = list(o['subscriptions']).some((x) => SUB_GROUPS.has(str(obj(x['display'])['group']) ?? ''));
  const rank = (v: MarketSubscriptionView) => SUB_GROUP_ORDER.indexOf(v.display.group);
  const byStart = (a: MarketSubscriptionView, b: MarketSubscriptionView) => (backendSorted ? 0 : (started.get(b.job_id) ?? 0) - (started.get(a.job_id) ?? 0));
  const sorted = subs
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v) - rank(b.v) || byStart(a.v, b.v) || a.i - b.i)
    .map((x) => x.v);
  return { ...cacheOf(o), subscriptions: sorted, this_device: deviceId ? { id: deviceId, name: str(o['thisDeviceName']) ?? deviceId.slice(0, 8) } : null, error: str(o['error']) };
}

// report/intel/status/message/arbitrage 都是「不可执行、只留痕」:按分析行展示,不能落到默认的 'bad'(否则显示成「格式没读懂」)。
const PARSE_MAP: Record<string, MarketInboxParseStatus> = { order: 'ingested', ingested: 'ingested', analysis: 'analysis', report: 'analysis', intel: 'analysis', status: 'analysis', message: 'analysis', arbitrage: 'analysis', invalid: 'bad', bad: 'bad', expired: 'expired', duplicate: 'duplicate', system: 'system', notice: 'system' };

export function adaptInbox(raw: unknown): { rows: MarketInboxRow[]; total: number; inbox: MarketInboxStatus } & WithSnapshot {
  const o = obj(raw);
  const rows: MarketInboxRow[] = list(o['deliveries']).map((d) => {
    const errors = Array.isArray(d['errors']) ? (d['errors'] as unknown[]).map(String) : [];
    return {
      delivery_id: str(d['delivery_id']) ?? String(d['rowid'] ?? ''),
      job_id: str(d['job_id']),
      message_id: null,
      received_at: ms(d['received_at']) ?? 0,
      signal_type: str(d['signal_type']),
      parse_status: PARSE_MAP[String(d['parse_status'])] ?? 'bad',
      signal_id: str(d['signal_id']),
      note: errors.length ? errors.join('; ') : null,
      raw: str(d['raw']) ?? '',
    };
  });
  return { ...snapshotOf(o), rows, total: rows.length, inbox: adaptInboxStatus(o['inbox']) };
}

// ---------------------------------------------------------------------------
// 「信号」栏时间线(设计 2026-09-25):以入站账本(每条投递一行,告警/报告这类没有信号对象的也在)为底,
// 按 signal_id 拼上跟单流水线的信号(状态、价位、待办按钮)。类型从 signal_type / parse_status / 正文标题推。

/** 交易信号 / 情报 / 告警 / 报告 / 系统消息(平台通知、下单往来,默认不显示)。 */
export type FeedKind = 'trade' | 'intel' | 'alert' | 'report' | 'system';

export interface FeedItem {
  key: string;
  job_id: string | null;
  received_at: number;
  kind: FeedKind;
  /** 正文标题(【】里的中文部分),没有就 null。 */
  title: string | null;
  symbol: string | null;
  side: TraderSignal['side'];
  /** 一句话摘要(已去掉平台信封与签名行)。 */
  summary: string;
  /** 去掉平台信封后的正文(展开时展示)。 */
  content: string;
  raw: string;
  signal: TraderSignal | null;
  parse_status: MarketInboxParseStatus | null;
  /** 同一订阅同一内容收到的次数(平台重投 / 收发两份回执会重复)。 */
  repeats: number;
  /** 正文里写的关键价位(报告类),交易信号用 signal 上的。 */
  levels: { entry: string | null; stop: string | null; targets: string[] };
}

const ENVELOPE_RE = /^\s*(?:📥|📤)?\s*\[(?:Received|Sent)\]/;
const ENVELOPE_META_RE = /^(?:jobId|deliverableType|fileKey|digest|Job)\s*:/i;
const DATE_ONLY_RE = /^[\d\s:./-]*(?:UTC)?\s*(?:[(（][^)）]*[)）])?\s*$/;
const CJK_RE = /[一-鿿]/;

/** 把平台信封(📥/📤 [Received]/[Sent] … 「…」)剥掉,拿到服务方真正发来的正文。 */
export function deliveryContent(raw: string): { content: string; envelopeOnly: boolean } {
  const lines = raw.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => /^\s*[「]?\s*【/.test(l));
  if (start >= 0) {
    const out: string[] = [];
    for (const line of lines.slice(start)) {
      const l = line.replace(/^\s*「/, '');
      if (out.length && (/^\s*-\s-\s-\s*$/.test(l) || ENVELOPE_RE.test(l) || /^─{3,}/.test(l.trim()))) break;
      out.push(l.replace(/」\s*$/, ''));
    }
    return { content: out.join('\n').trim(), envelopeOnly: false };
  }
  if (ENVELOPE_RE.test(raw)) {
    const inner = raw.slice(raw.indexOf('「') + 1 || 0, raw.lastIndexOf('」') > 0 ? raw.lastIndexOf('」') : undefined);
    const body = inner
      .split('\n')
      .filter((l) => l.trim() && !ENVELOPE_META_RE.test(l.trim()) && !/^\s*-\s-\s-\s*$/.test(l) && !/^─{3,}/.test(l.trim()) && !ENVELOPE_RE.test(l))
      .join('\n')
      .trim();
    return { content: body, envelopeOnly: true };
  }
  return { content: raw.trim(), envelopeOnly: false };
}

function headerOf(content: string): { title: string | null; rest: string[] } {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  // 标题三种写法:中文【标题】、英文按次报告 [Title]、英文订阅推送 "Market Brief · …"(首段是已知栏目名)
  const m = lines[0]?.match(/^【([^】]*)】\s*(.*)$/) ?? lines[0]?.match(/^\[([^\]]*)\]\s*(.*)$/) ?? lines[0]?.match(/^((?:Market Brief|Radar Picks|Microstructure Alerts?|Quiet[- ]period summary)\b[^·]*)·?\s*(.*)$/i);
  if (!m) return { title: null, rest: lines };
  const title = (m[1] ?? '').split(/\s\/\s/)[0]!.trim() || null;
  return { title, rest: [m[2] ?? '', ...lines.slice(1)] };
}

function kindFromTitle(title: string | null): FeedKind | null {
  if (!title) return null;
  if (/告警|预警|Alert/i.test(title)) return 'alert';
  if (/报告|把关|判断|回测|分析|Report|Gate|Probability|Backtest|Analysis/i.test(title)) return 'report';
  if (/简报|情报|推荐|快讯|日报|Brief|Intel|Picks|News/i.test(title)) return 'intel';
  if (/Futures|Spot|合约|现货|信号|Signal/i.test(title)) return 'trade';
  return null;
}

const isTradeSignal = (sig: TraderSignal | null): boolean =>
  !!sig && (sig.kind === 'arbitrage' ? !!(sig.arbitrage?.basis_pct || sig.arbitrage?.expected_apr) : sig.action !== 'analysis_only' && sig.action !== 'unknown');

/** 投递类型:signal_type / parse_status / 正文标题 三处推断,拿不准当情报。 */
export function classifyDelivery(input: { parse_status: MarketInboxParseStatus | null; signal_type: string | null; content: string; envelopeOnly: boolean; signal: TraderSignal | null }): FeedKind {
  if (input.parse_status === 'system' && !headerOf(input.content).title) return 'system';
  if (isTradeSignal(input.signal) || input.parse_status === 'ingested') return 'trade';
  if (input.envelopeOnly && !headerOf(input.content).title) return 'system';
  // 类型头信息行(【Futures】… | Info only, no order / Status only / Service message)不是交易信号:告警归告警,其余归情报
  const first = input.content.split('\n')[0] ?? '';
  if (/\b(?:Info only|Status only|no order|Service message)\b/i.test(first)) return /Microstructure|Alert|告警/i.test(first) ? 'alert' : 'intel';
  const byTitle = kindFromTitle(headerOf(input.content).title);
  if (byTitle) return byTitle;
  const st = (input.signal_type ?? '').toLowerCase();
  if (st === 'order') return 'trade';
  if (st === 'analysis') return 'intel';
  return 'intel';
}

/** 签名行 / 纯日期行不当摘要:没数字没汉字的短行(如服务方名)也跳过。 */
function isNoise(line: string): boolean {
  const l = line.trim();
  if (!l || /^[—–-]/.test(l)) return true;
  if (DATE_ONLY_RE.test(l)) return true;
  if (!CJK_RE.test(l) && !/\d/.test(l) && l.split(/\s+/).length <= 4) return true;
  return false;
}

/** 双语行「中文 / English」按界面语言留一半;不是双语就原样。 */
function oneLanguage(line: string): string {
  const m = line.match(/^(.*[\u4e00-\u9fff].*?)\s\/\s([^\u4e00-\u9fff]+)$/);
  if (!m) return line;
  return getLang() === 'en' ? m[2]!.trim() : m[1]!.trim();
}

function summaryOf(content: string): string {
  const { title, rest } = headerOf(content);
  for (const line of rest) {
    let l = line
      .replace(/\s*·\s*\d{4}-\d{2}-\d{2}[^·]*$/, '')
      .replace(/^\d{4}-\d{2}-\d{2}[\sT\d:]*(?:UTC)?\s*(?:[(（][^)）]*[)）])?\s*/, '')
      .trim();
    // 「资产×周期推荐 / Asset × horizon(…):短线 …」这类把标题又写一遍的,去掉到冒号为止。
    if (title && l.startsWith(title)) l = l.replace(/^[^:：]*[:：]\s*/, '') || l;
    l = oneLanguage(l);
    if (!isNoise(l)) return l.length > 160 ? `${l.slice(0, 157)}…` : l;
  }
  return '';
}

/** 交易信号的入场 / 止损 / 止盈(清洗过的字符串)。 */
export function signalLevels(sig: TraderSignal): FeedItem['levels'] {
  return { entry: sig.entry_prices.length ? sig.entry_prices.map((p) => cleanPrice(p) ?? p).join(' / ') : null, stop: cleanPrice(sig.stop), targets: sig.tps.map((x) => cleanPrice(x.price) ?? x.price) };
}

function symbolOf(kind: FeedKind, summary: string, sig: TraderSignal | null): string | null {
  if (sig?.symbol && (kind === 'trade' || kind === 'report')) return sig.symbol;
  if (kind !== 'alert' && kind !== 'report') return null;
  const lead = summary.match(/^([A-Z][A-Z0-9]{1,11})(?:USDT|-USDT-SWAP)?\b/);
  if (lead) return lead[1]!;
  const pair = summary.match(/\b([A-Z][A-Z0-9]{1,11})USDT\b/);
  return pair ? pair[1]! : null;
}

/** 价位清洗:去千分位、去多余小数(8 位有效数字),小币价格不丢精度。拿不到数字原样返回。 */
export function cleanPrice(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? String(Number(n.toPrecision(8))) : String(v);
}

/** 找「关键词 数字」里第一个真是价位的:后面紧跟 ×、%、R、倍、ATR 的(「止损 2×ATR」「值得入场 16%」)不算。 */
function priceAfter(content: string, key: string): string | null {
  const re = new RegExp(`(?:${key})\\s*[:：]?\\s*([\\d,]+(?:\\.\\d+)?)(?!\\s*(?:[×x%R倍]|ATR|[\\d.,]))`, 'g');
  for (const m of content.matchAll(re)) return cleanPrice(m[1]);
  return null;
}

/** 报告里常见的「入场 84,300 止损 83,100 目标 86,500 / 88,000」:只认同一行里同时写了入场和止损的计划行。 */
export function levelsFromText(text: string): FeedItem['levels'] {
  const content = text.split('\n').find((l) => /入场\s*[:：]?\s*\d/.test(l) && /止损\s*[:：]?\s*\d/.test(l)) ?? '';
  const tgt = content.match(/(?:目标|止盈)\s*[:：]?\s*([\d,]+(?:\.\d+)?(?:\s*\/\s*[\d,]+(?:\.\d+)?)*)(?!\s*(?:[×x%R倍]|ATR|[\d.,]))/)?.[1];
  return {
    entry: priceAfter(content, '入场'), // i18n-ignore
    stop: priceAfter(content, '止损'), // i18n-ignore
    targets: tgt ? tgt.split('/').map((x) => cleanPrice(x.trim())).filter((x): x is string => !!x) : [],
  };
}

function tradeSummary(sig: TraderSignal): string {
  if (sig.kind === 'arbitrage') {
    const parts = [t('期现套利')];
    if (sig.arbitrage?.basis_pct) parts.push(t('基差 {v}%', { v: sig.arbitrage.basis_pct }));
    if (sig.arbitrage?.expected_apr) parts.push(t('年化 {v}%', { v: sig.arbitrage.expected_apr }));
    return parts.join(' · ');
  }
  const parts: string[] = [];
  if (sig.entry_prices.length) parts.push(t('入场 {v}', { v: sig.entry_prices.map(cleanPrice).join(' / ') }));
  else if (sig.entry_kind === 'market') parts.push(t('按市价入场'));
  if (sig.stop) parts.push(t('止损 {v}', { v: cleanPrice(sig.stop) }));
  if (sig.tps.length) parts.push(t('止盈 {v}', { v: sig.tps.map((x) => cleanPrice(x.price)).join(' / ') }));
  return parts.join(' · ');
}

const signalJobId = (sig: TraderSignal): string | null => {
  const j = (sig as TraderSignal & { subscription_job_id?: string | null }).subscription_job_id;
  return j && j !== 'unknown' ? j : null;
};

/**
 * 账本行 + 跟单信号 → 时间线条目(按收到时间倒序)。
 * 同一订阅同一正文只留一条(`repeats` 记次数);账本里没有、但跟单流水线有的信号也补进来,不丢。
 */
export function buildSignalFeed(rows: MarketInboxRow[], signals: TraderSignal[]): FeedItem[] {
  const bySignal = new Map(signals.map((sg) => [sg.signal_id, sg]));
  const used = new Set<string>();
  const items: FeedItem[] = [];
  const seen = new Map<string, FeedItem>();

  const push = (base: { key: string; job_id: string | null; received_at: number; raw: string; parse_status: MarketInboxParseStatus | null; signal_type: string | null; signal: TraderSignal | null }) => {
    const { content, envelopeOnly } = deliveryContent(base.raw);
    const kind = classifyDelivery({ parse_status: base.parse_status, signal_type: base.signal_type, content, envelopeOnly, signal: base.signal });
    const dedupe = `${base.job_id ?? ''}|${content.slice(0, 600)}`;
    const prev = seen.get(dedupe);
    if (prev && content) {
      prev.repeats += 1;
      if (!prev.signal && base.signal) prev.signal = base.signal;
      return;
    }
    const sig = base.signal;
    const trade = kind === 'trade' && sig && isTradeSignal(sig);
    const summary = trade ? tradeSummary(sig) || summaryOf(content) : summaryOf(content) || (envelopeOnly ? content.split('\n')[0]?.slice(0, 160) ?? '' : '');
    const item: FeedItem = {
      key: base.key,
      job_id: base.job_id,
      received_at: base.received_at,
      kind,
      title: headerOf(content).title,
      symbol: symbolOf(kind, summary, sig),
      side: trade ? sig.side : null,
      summary,
      content: content || base.raw,
      raw: base.raw,
      signal: sig,
      parse_status: base.parse_status,
      repeats: 1,
      levels: trade ? signalLevels(sig) : kind === 'trade' || kind === 'report' ? levelsFromText(content) : { entry: null, stop: null, targets: [] },
    };
    seen.set(dedupe, item);
    items.push(item);
  };

  const sortedRows = [...rows].sort((a, b) => b.received_at - a.received_at);
  for (const r of sortedRows) {
    const sig = r.signal_id ? (bySignal.get(r.signal_id) ?? null) : null;
    if (sig) used.add(sig.signal_id);
    push({ key: `d:${r.delivery_id}`, job_id: r.job_id, received_at: r.received_at, raw: r.raw, parse_status: r.parse_status, signal_type: r.signal_type, signal: sig });
  }
  for (const sg of signals) {
    if (used.has(sg.signal_id)) continue;
    push({ key: `s:${sg.id}`, job_id: signalJobId(sg), received_at: sg.published_at, raw: sg.raw_text, parse_status: null, signal_type: null, signal: sg });
  }
  return items.sort((a, b) => b.received_at - a.received_at);
}

/** 2026-09-25 12:20 UTC(北京 20:20)之前有个 bug 把部分策略交易信号误推给了「市场情报 / 微观告警」订阅。 */
export const MISROUTED_BEFORE = Date.UTC(2026, 8, 25, 12, 20);

const NON_SIGNAL_SERVICE = /市场情报|微观|情报|告警|简报|雷达|market\s*intel|intel|micro\s*structure|alert|brief|radar/i;
const SIGNAL_SERVICE = /策略信号|交易信号|signal/i;

/**
 * 订阅的服务是不是信号类:按目录服务名 → 远端服务名 → 订单标题 → 本地备注逐个看,第一个认得出的算数;
 * 都认不出给 null(由调用方走「组内主导类型」兜底)。
 */
export function subscriptionServiceKind(sub: Pick<MarketSubscriptionView, 'asp_service_name' | 'service_name' | 'title' | 'config'>): 'signal' | 'non_signal' | null {
  for (const text of [sub.asp_service_name, sub.service_name, sub.title, sub.config.label]) {
    if (!text) continue;
    if (NON_SIGNAL_SERVICE.test(text)) return 'non_signal';
    if (SIGNAL_SERVICE.test(text)) return 'signal';
  }
  return null;
}

/**
 * 「不属于该服务类型的历史消息」的 key(信号栏默认收起):
 *   - 认得出是非信号服务(市场情报 / 微观告警…):收到的交易信号全部收起;
 *   - 认不出服务类型:组内某类型过半即为主导类型,不是主导类型且在 MISROUTED_BEFORE 之前收到的收起;
 *   - 信号服务 / 不属于我的订阅 / 平台通知:不动(后两者有各自的开关)。
 */
export function offTypeFeedKeys(feed: FeedItem[], subById: ReadonlyMap<string, MarketSubscriptionView>): Set<string> {
  const out = new Set<string>();
  const byJob = new Map<string, FeedItem[]>();
  for (const f of feed) {
    if (f.kind === 'system' || !f.job_id || !subById.has(f.job_id)) continue;
    const arr = byJob.get(f.job_id);
    if (arr) arr.push(f);
    else byJob.set(f.job_id, [f]);
  }
  for (const [job, items] of byJob) {
    const kind = subscriptionServiceKind(subById.get(job)!);
    if (kind === 'signal') continue;
    if (kind === 'non_signal') {
      for (const f of items) if (f.kind === 'trade') out.add(f.key);
      continue;
    }
    const counts = new Map<FeedKind, number>();
    for (const f of items) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    const [dominant, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (n * 2 <= items.length) continue;
    for (const f of items) if (f.kind !== dominant && f.received_at < MISROUTED_BEFORE) out.add(f.key);
  }
  return out;
}

/** `/api/follow`(MarketSettings)+ `/api/follow/signals?limit=1`(待办 + 采集状态)拼成页面的 overview。 */
export function composeOverview(settings: MarketSettings, signalsRaw: unknown): FollowOverview {
  const s = obj(signalsRaw);
  const anyCopy = Object.values(settings.subscriptions).some((c) => c.mode === 'book' && c.approval === 'auto' && c.enabled);
  return {
    follow: settings,
    inbox: adaptInboxStatus(s['connection']),
    pending_review: (Array.isArray(s['pending_review']) ? (s['pending_review'] as TraderSignal[]) : []) ?? [],
    pending_review_total: num(s['pending_review_total']) ?? 0,
    pending_review_limit: 200,
    // 网关带了 scope 就照它画;老网关没带时用与 §9.38 同款的兜底。
    scope: (s['scope'] as FollowOverview['scope'] | undefined) ?? {
      auto_execution: anyCopy,
      human_actions: ['apply', 'skip', 'reconcile'],
      auto_actions_when_enabled: ['open'],
      manual_only_actions: ['reduce', 'stop_loss_update', 'take_profit_update'],
      auto_manage: false,
      tp_tiers: 'first_only',
      ladder_entry: 'manual_only',
    },
    signals_total: num(s['pending_review_total']) ?? 0,
    modes: FOLLOW_MODES,
    statuses: TRADER_SIGNAL_STATUSES,
  };
}

const AFTERSALE_MAP: Record<string, MarketAftersaleStatus> = { pending: 'pending', received: 'received', processing: 'processing', failed: 'failed', expired: 'expired' };

export function adaptAftersale(raw: unknown): MarketAftersale {
  const o = obj(raw);
  const status = String(o['status'] ?? 'received');
  const decision = str(o['decision']);
  return {
    id: str(o['event_id']) ?? '',
    job_id: str(o['job_id']) ?? '',
    kind: str(o['event']) ?? 'sub_user_reject',
    buyer_agent_id: str(o['buyer']) || null,
    period_index: num(o['period']),
    reason: str(o['reason']) || null,
    deadline_at: ms(o['deadline']),
    status: status === 'done' ? (decision === 'dispute' ? 'disputed' : decision === 'agree_refund' ? 'agreed_refund' : 'received') : (AFTERSALE_MAP[status] ?? 'received'),
    decided_at: null,
    created_at: ms(o['received_at']) ?? 0,
  };
}

export function adaptDelivery(raw: unknown): MarketDeliveryOut {
  const o = obj(raw);
  const ev = obj(o['event']);
  const payload = obj(o['payload']);
  return {
    event_id: str(o['event_id']) ?? '',
    created_at: ms(o['created_at']) ?? 0,
    signal_type: payload['signal_type'] === 'analysis' ? 'analysis' : 'order',
    action: str(payload['action']) ?? str(ev['kind']) ?? '',
    symbol: str(ev['symbol']) ?? str(payload['symbol']) ?? '',
    thread_id: str(ev['thread_id']),
    text: str(o['text']) ?? '',
    payload,
    blocked_reason: str(o['refusal']),
    jobs: list(o['jobs']).map((j) => ({
      job_id: str(j['job_id']) ?? '',
      buyer_agent_id: null,
      status: j['status'] === 'delivered' ? 'delivered' : j['status'] === 'failed' ? 'failed' : 'pending',
      attempt: num(j['attempts']) ?? 0,
      error: str(j['error']),
      delivered_at: j['status'] === 'delivered' ? ms(j['updated_at']) : null,
    })),
  };
}

export function adaptAsp(raw: unknown, publisher: MarketPublisherSettings, deliveries: MarketDeliveryOut[]): MarketAsp {
  const o = obj(raw);
  const identity = adaptIdentity(o['identity']);
  const summary = identity ? { ...adaptAspSummary(o['identity'], identity), asp_agent_id: identity.agent_id, asp_name: identity.name } : undefined;
  const activeJobs = new Set(list(o['active']).map((x) => str(pick(x, 'jobId', 'job_id')) ?? ''));
  const provider = list(o['subscriptions']);
  const subscribers: MarketSubscriber[] = provider.map((r) => {
    const job = str(pick(r, 'jobId', 'job_id')) ?? '';
    return {
      job_id: job,
      buyer_agent_id: str(pick(r, 'buyerAgentId', 'userAgentId', 'clientAgentId')) ?? '',
      buyer_name: str(pick(r, 'buyerAgentName', 'buyerName')),
      status_name: str(pick(r, 'statusName', 'status')) ?? '',
      period_index: num(pick(r, 'periodIndex')),
      sub_start_time: ms(pick(r, 'subStartTime')),
      sub_end_time: ms(pick(r, 'subEndTime')),
      fee_amount: str(pick(r, 'serviceTokenAmount', 'feeAmount')),
      active: activeJobs.has(job),
    };
  });
  for (const job of activeJobs) if (job && !subscribers.some((s) => s.job_id === job)) subscribers.push({ job_id: job, buyer_agent_id: '', buyer_name: null, status_name: 'ACTIVE', period_index: null, sub_start_time: null, sub_end_time: null, fee_amount: null, active: true });
  const claimable = obj(o['claimable']);
  const claimAmount = str(pick(claimable, 'claimable', 'claimableAmount', 'amount', 'total', 'pendingRewards', 'rewards'));
  const orders = deliveries.filter((d) => d.signal_type === 'order' && !d.blocked_reason);
  const closes = orders.filter((d) => d.action === 'CLOSE');
  const rs = closes.map((d) => num(d.payload['realized_r'])).filter((x): x is number => x !== null);
  const jobs = deliveries.flatMap((d) => d.jobs);
  const last = deliveries.reduce<number | null>((acc, d) => (acc === null || d.created_at > acc ? d.created_at : acc), null);
  return {
    ...cacheOf(o),
    identity,
    services: list(o['services']).map((s) => adaptService(s, summary)),
    subscribers,
    active_count: activeJobs.size,
    claimable: { amount: claimAmount, currency: str(pick(claimable, 'currency', 'tokenSymbol')) ?? 'USDT', error: typeof o['claimable'] === 'string' ? o['claimable'] : null },
    aftersales: list(o['aftersales']).map(adaptAftersale),
    publisher,
    track_record: { window_days: 30, orders: orders.length, closes: closes.length, wins: rs.filter((r) => r > 0).length, realized_r_sum: rs.length ? rs.reduce((a, b) => a + b, 0) : null },
    publisher_state: { last_publish_at: last, events: deliveries.length, delivered: jobs.filter((j) => j.status === 'delivered').length, failed: jobs.filter((j) => j.status === 'failed').length, blocked: deliveries.filter((d) => d.blocked_reason).length },
    error: null,
  };
}

export function adaptRegister(raw: unknown): { ok: boolean; agent_id: string | null; message: string | null } {
  const o = obj(raw);
  const result = obj(o['result']);
  const pre = obj(o['precheck']);
  return { ok: bool(o['created']), agent_id: str(pick(result, 'newAgentId', 'agentId', 'id')), message: str(pick(pre, 'reason', 'message')) ?? (o['created'] === false ? t('平台 pre-check 未通过') : null) };
}

/** Keep the write outcome separate from the following list refresh. A failed GET must not invite another write. */
export async function marketSubscriptionAction(job: string, action: 'cancel' | 'reject' | 'autorenew', reason?: string): Promise<unknown> {
  let response: Response; let text: string;
  try {
    response = await fetch(`/api/market/subscriptions/${encodeURIComponent(job)}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reason === undefined ? {} : { reason }),
    });
    text = await response.text();
  } catch (error) { throw new Error(`${t('请求连接中断，操作结果尚未确认；请刷新订阅列表核实，勿重复提交。')}\n${error instanceof Error ? error.message : String(error)}`); }
  // 我们自己的限频(nginx limit_req 回 HTML 429、网关访客限频):请求在进网关 / 进平台之前就被拒了,没有「结果未确认」的问题
  if (response.status === 429) throw new Error(TOO_MANY_REQUESTS);
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { throw new Error(`${t('平台响应无法确认（HTTP {status}），请刷新订阅列表核实结果，勿重复提交。', { status: response.status })}\n${text}`); }
  if (!response.ok) {
    const error = obj(obj(body)['error']);
    const message = String(error['message'] ?? error['hint'] ?? `HTTP ${response.status}`);
    const raw = typeof error['raw_message'] === 'string' ? error['raw_message'] : '';
    throw new Error(raw && !message.includes(raw) ? `${message}\n${raw}` : message);
  }
  return body;
}
/** A selected catalog service must match exactly; never silently purchase a different service or paid plan. */
export function resolveCatalogService(services: MarketService[], selected: { service_id: number | null; name: string } | null, trial: boolean): MarketService {
  const candidates = services.filter((s) => s.subscription.some((p) => p.interval === 'month'));
  const hit = selected ? selected.service_id !== null ? candidates.find((s) => s.sid === selected.service_id) : candidates.find((s) => s.service_name === selected.name)
    : candidates.find((s) => !trial || s.support_trial);
  if (!hit) throw new Error(t('所选服务已变更或下架，请刷新目录后重新选择。'));
  if (hit.is_subscribing) throw new Error(t('此服务已订阅或正在等待接单，请到订阅栏查看。'));
  if (trial && !hit.support_trial) throw new Error(t('此服务当前不支持试用，请刷新目录后重新选择。'));
  return hit;
}

/** 用户点击订阅/翻页时等待后台读快照就绪；每次 GET 仍快速返回，不把空占位当真实空列表。 */
export async function waitForMarketRead<T extends { cache?: ReadCacheMeta }>(read: () => Promise<T>): Promise<T> {
  const until = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (!value.cache || value.cache.fetched_at !== null) return value;
    if (value.cache.error) throw new Error(value.cache.error);
    if (Date.now() >= until) throw new Error(t('服务信息仍在后台加载，请稍后重试'));
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}
