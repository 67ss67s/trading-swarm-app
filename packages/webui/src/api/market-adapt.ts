/**
 * 信号市场适配层:网关(契约 §9.39)把 OKX CLI 的 data **原样**透传(身份对象、订阅行、服务、评价都是平台字段),
 * 这里统一映射成页面用的视图类型(api/types.ts 的 Market*),组件不认平台字段名。
 * 平台字段随时可能变,所以每个读取都是防御式的:读不到就 null / 0 / '',不抛。
 */
import type {
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
  MarketSubscriptionView,
  MarketWallet,
  OkxAccountStatus,
  TraderSignal,
} from './types';
import { FOLLOW_MODES, TRADER_SIGNAL_STATUSES } from './types';

type Obj = Record<string, unknown>;
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

export function adaptSearch(raw: unknown): { services: MarketService[]; search_after: string | null; has_more: boolean; unmatch_reason: string | null } {
  const o = obj(raw);
  return { services: list(o['services']).map((s) => adaptService(s)), search_after: str(o['searchAfter']), has_more: bool(o['hasMore']), unmatch_reason: str(o['unmatchReason']) };
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
  return {
    transport: o['transport'] === 'watch' ? 'watch' : 'queue',
    available: bool(o['alive']),
    db_path: null,
    last_poll_at: ms(o['last_poll']),
    last_error: str(o['last_error']),
    failures: 0,
    next_attempt_at: null,
    ledger_total: received,
    ingested: Math.max(0, received - analysis - dlq),
    skipped_analysis: analysis,
    bad_rows: dlq,
    cursor: num(o['cursor']) ?? 0,
    dlq_count: dlq,
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

export function adaptSubscriptions(raw: unknown): { subscriptions: MarketSubscriptionView[]; this_device: { id: string; name: string } | null; error: string | null } {
  const o = obj(raw);
  const deviceId = str(o['thisDeviceId']);
  const subs: MarketSubscriptionView[] = list(o['subscriptions']).map((s) => {
    const r = obj(s['remote']);
    const cfg = obj(s['config']);
    const job = str(s['job_id']) ?? str(r['jobId']) ?? '';
    const autoRenew = pick(r, 'autoRenew', 'autoRenewal');
    const asp = obj(s['asp']);
    return {
      job_id: job,
      title: str(pick(r, 'jobTitle', 'title')) ?? '',
      service_name: str(pick(r, 'serviceName', 'title', 'jobTitle')) ?? str(cfg['label']) ?? job.slice(0, 10),
      service_id: str(pick(r, 'serviceId')),
      provider_agent_id: str(pick(r, 'providerAgentId', 'aspAgentId')),
      provider_name: str(asp['name']) ?? str(pick(r, 'providerAgentName', 'providerName', 'aspName')) ?? (s['remote'] ? '' : '(仅本地配置)'),
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
  });
  return { subscriptions: subs, this_device: deviceId ? { id: deviceId, name: str(o['thisDeviceName']) ?? deviceId.slice(0, 8) } : null, error: str(o['error']) };
}

const PARSE_MAP: Record<string, MarketInboxParseStatus> = { order: 'ingested', ingested: 'ingested', analysis: 'analysis', invalid: 'bad', bad: 'bad', expired: 'expired', duplicate: 'duplicate', system: 'system' };

export function adaptInbox(raw: unknown): { rows: MarketInboxRow[]; total: number; inbox: MarketInboxStatus } {
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
  return { rows, total: rows.length, inbox: adaptInboxStatus(o['inbox']) };
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
  return { ok: bool(o['created']), agent_id: str(pick(result, 'newAgentId', 'agentId', 'id')), message: str(pick(pre, 'reason', 'message')) ?? (o['created'] === false ? '平台 pre-check 未通过' : null) };
}

/** Keep the write outcome separate from the following list refresh. A failed GET must not invite another write. */
export async function marketSubscriptionAction(job: string, action: 'cancel' | 'reject' | 'autorenew', reason?: string): Promise<unknown> {
  let response: Response; let text: string;
  try {
    response = await fetch(`/api/market/subscriptions/${encodeURIComponent(job)}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reason === undefined ? {} : { reason }),
    });
    text = await response.text();
  } catch (error) { throw new Error(`请求连接中断，操作结果尚未确认；请刷新订阅列表核实，勿重复提交。\n${error instanceof Error ? error.message : String(error)}`); }
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { throw new Error(`平台响应无法确认（HTTP ${response.status}），请刷新订阅列表核实结果，勿重复提交。\n${text}`); }
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
  if (!hit) throw new Error('所选服务已变更或下架，请刷新目录后重新选择。');
  if (hit.is_subscribing) throw new Error('此服务已订阅或正在等待接单，请到订阅栏查看。');
  if (trial && !hit.support_trial) throw new Error('此服务当前不支持试用，请刷新目录后重新选择。');
  return hit;
}
