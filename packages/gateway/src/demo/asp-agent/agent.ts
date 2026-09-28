import { aspSnapshotEnabled } from '../asp-snapshot.js';
import { MarketWallet } from './wallet.js';
import type { DemoRuntime } from '../runtime.js';
import { MarketCli, CliError, data, list, object, payload } from './cli.js';
import { ProviderTaskPoller, ensureBuyerSession, registerProviderHandler } from './provider-tasks.js';
import { AspServices } from './services/index.js';
import { infoSignal, type SubscriptionServiceDef } from './services/broadcast.js';
import type { SubscriptionChannel } from './services/types.js';
import { symbolToInstId } from '../okx/instruments.js';
import { MarketInbox, downloadFileDelivery } from './inbox.js';
import { MarketPublisher, englishName, renderDeliverable, realizedR, serviceMessage, signalLine, type PublishEvent } from './publisher.js';
import { MarketIdentity } from './identity.js';
import { MarketAftersales } from './aftersales.js';
import { MarketCatalog } from './catalog.js';
import { normalizePublisherSettings, normalizeMarketSettings, type MarketSubscription } from './settings.js';
import { startAspRun } from './audit.js';
/** Canonicalize bytes32 only; opaque platform IDs remain case-sensitive. */
export function normalizeJobId(v: unknown): string {
  const id = String(v ?? '');
  return /^(?:0x)?[0-9a-f]{64}$/i.test(id) ? `0x${id.replace(/^0x/i, '').toLowerCase()}` : id;
}
export function subscriptionStatus(r: Record<string, unknown>): string {
  return String(r['statusName'] ?? ({ '-1': 'INIT', '0': 'CREATED', '1': 'ACTIVE', '3': 'REJECTED', '4': 'DISPUTED', '6': 'COMPLETED', '7': 'CLOSED', '8': 'EXPIRED', '9': 'FAILED' } as Record<string, string>)[String(r['status'])] ?? '').toUpperCase();
}
const terminal = (r: Record<string, unknown>) => ['CLOSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(subscriptionStatus(r));
const enabled = (v: unknown) => v === true || v === 1 || v === '1';
export type SubscriptionGroup = 'active' | 'trial' | 'pending' | 'cancelled_trial' | 'ended';
export const SUBSCRIPTION_GROUP_ORDER: readonly SubscriptionGroup[] = ['active', 'trial', 'pending', 'cancelled_trial', 'ended'];
const epochMs = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null; };
const utc = (ms: number) => `${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')} UTC`;
/**
 * 订阅栏分组(买方视图):付费进行中 → 试用中(会转付费)→ 等服务方接单 → 已取消续费但试用未到期 → 已结束。
 * 试用期内(ACTIVE + trialType 1)一律按剩余试用时间显示并标到期是否转付费;已不是 ACTIVE 但试用期没到的归「已取消 · 试用至」。时间字段是秒。
 */
export function subscriptionDisplay(r: Record<string, unknown> | null, now = Date.now()): { group: SubscriptionGroup; label: string; until: number | null; started_at: number | null } {
  if (!r) return { group: 'ended', label: '平台没有返回这条订阅', until: null, started_at: null };
  const status = subscriptionStatus(r); const trial = Number(r['trialType']) === 1; const renew = enabled(r['autoRenew']);
  const subEnd = epochMs(r['subEndTime']); const trialEnd = epochMs(r['trialEndTime']);
  const started_at = epochMs(r['subStartTime']) ?? epochMs(r['trialStartTime']) ?? epochMs(r['createTime']) ?? null;
  // 试用单没法区分「主动取消续费」和「建单时就没开续费」(都是 autoRenew=0),所以试用期内一律按试用剩余时间显示,再标到期后会不会转付费
  if (status === 'ACTIVE' && trial) {
    const until = trialEnd ?? subEnd; const h = until ? Math.max(0, Math.round((until - now) / 3_600_000)) : null;
    const left = h === null ? '试用中' : h >= 24 ? `试用中 · 剩 ${Math.floor(h / 24)} 天 ${h % 24} 小时` : `试用中 · 剩 ${h} 小时`;
    return { group: 'trial', label: `${left} · ${renew ? '到期转付费' : '到期不续费'}`, until, started_at };
  }
  if (trial && subEnd !== null && subEnd > now) return { group: 'cancelled_trial', label: `已取消 · 试用至 ${utc(subEnd)}`, until: subEnd, started_at };
  if (status === 'ACTIVE') return { group: 'active', label: subEnd ? `进行中 · 至 ${utc(subEnd)}${renew ? ' · 自动续费' : ' · 已关闭续费'}` : '进行中', until: subEnd, started_at };
  if (!status || status === 'INIT' || status === 'CREATED') return { group: 'pending', label: '等待服务方接单', until: null, started_at };
  const ended: Record<string, string> = { CLOSED: '已结束', COMPLETED: '已完成', EXPIRED: '已到期', FAILED: '失败', CANCELLED: '已取消', CANCELED: '已取消', REJECTED: '已拒收', DISPUTED: '争议处理中' };
  return { group: 'ended', label: ended[status] ?? `已结束(${status})`, until: subEnd ?? trialEnd, started_at };
}
export function findJobId(v: unknown, depth = 0): string | null {
  if (depth > 12 || !v || typeof v !== 'object') return null;
  const o = object(v);
  for (const [k, value] of Object.entries(o)) if (['jobid', 'subscriptionid', 'subid'].includes(k.replaceAll('_', '').toLowerCase()) && typeof value === 'string' && value && (depth === 0 || /^(?:0x)?[0-9a-f]{64}$/i.test(value))) return normalizeJobId(value);
  for (const x of Object.values(v)) { const r = findJobId(x, depth + 1); if (r) return r; }
  return null;
}
/** 解析 `asp-claimable` 的人话输出:「claimable rewards (account=…)」+ 每行「SYMBOL amount (token=0x…)」+ 可选「(No pending rewards at this time)」。 */
export function parseClaimableText(raw: string): { amount: string; currency: string; pending: boolean; rewards: { symbol: string; amount: string; token: string }[]; text: string } | null {
  const text = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!/claimable rewards|no pending rewards/i.test(text)) return null;
  const rewards = [...text.matchAll(/^\s*([A-Za-z][A-Za-z0-9₮.]*)\s+(\d+(?:\.\d+)?)\s+\(token=(0x[0-9a-fA-F]+)\)/gm)].map((m) => ({ symbol: m[1]!, amount: m[2]!, token: m[3]! }));
  const usdt = rewards.find((r) => /^USDT/i.test(r.symbol));
  const pending = !/no pending rewards/i.test(text) && rewards.some((r) => Number(r.amount) > 0);
  return { amount: usdt ? usdt.amount : pending ? rewards.find((r) => Number(r.amount) > 0)!.amount : '0', currency: usdt ? 'USDT' : rewards.find((r) => Number(r.amount) > 0)?.symbol ?? 'USDT', pending, rewards, text };
}
/** 「Trading Swarm 策略信号」服务的 serviceId:环境变量 > kv market.signal_service_id > 已上架默认值。 */
export const DEFAULT_SIGNAL_SERVICE_ID = 'c7f0c55b-7374-4402-912f-020dd456c066';
export function signalServiceId(store: { kvGet(key: string): string | null }): string {
  return process.env['TG_ASP_SIGNAL_SERVICE_ID'] || store.kvGet('market.signal_service_id') || DEFAULT_SIGNAL_SERVICE_ID;
}
export class AspAgent {
  readonly wallet: MarketWallet; readonly cli: MarketCli; readonly identity: MarketIdentity; readonly inbox: MarketInbox; readonly publisher: MarketPublisher; readonly aftersales: MarketAftersales; readonly catalog: MarketCatalog;
  /** ASP 侧唯一接单方(订阅/按次),见 provider-tasks.ts。 */
  readonly providerTasks: ProviderTaskPoller;
  /** 对外服务(市场情报 / 微观告警订阅 + 按次服务):处理器注册到 providerTasks,订阅按 serviceId 扇出。 */
  readonly services: AspServices;
  constructor(private readonly rt: DemoRuntime, session: () => string) {
    this.cli = new MarketCli(rt.okxAspRunCli ?? undefined);
    this.wallet = new MarketWallet(this.cli);
    this.identity = new MarketIdentity(this.cli, rt.store);
    const emit = (name: string, payload: unknown) => rt.emit(name, payload);
    this.aftersales = new MarketAftersales({ store: rt.store, cli: this.cli, aspId: () => this.identity.aspId(), emit, activity: (title) => rt.activity('info_update', { title }) });
    this.inbox = new MarketInbox({ store: rt.store, settings: () => ({ ...rt.followSettings, enabled: this.shouldCollect() }), session, fetchFile: async (d, job) => { const buyer = (await this.identity.mine()).buyer; const id = buyer?.['agentId']; if (!id) throw new Error('没有买方身份,无法解密文件投递'); return downloadFileDelivery(d, String(id), job); }, signalEnabled: () => rt.followSettings.enabled, selfAspIds: () => { try { const a = JSON.parse(rt.store.kvGet('market.asp_identity') ?? '{}').value?.asp; const id = a?.agentId ?? a?.aspAgentId ?? a?.id; return id ? [String(id)] : []; } catch { return []; } }, ...(rt.okxAspReadQueue ? { readQueue: rt.okxAspReadQueue } : {}), system: async (e, id) => { await this.aftersales.receive(e, id); if (/^(sub_open|job_asp_selected|sub_asp_selected)$/.test(String(e['event']))) void this.providerTasks.tick(); }, emit, traderOf: (job) => rt.okxAspFeed().traderOf(job) });
    this.catalog = new MarketCatalog({ store: rt.store, log: (level, message) => rt.log(level, 'asp_agent', message) });
    this.publisher = new MarketPublisher({ store: rt.store, cli: this.cli, settings: () => this.settings().publisher, aspId: () => this.identity.aspId(), emit, serviceId: () => signalServiceId(rt.store), paused: () => this.services?.isPaused('strategy_signal') ?? false });
    this.providerTasks = new ProviderTaskPoller({
      store: rt.store, cli: this.cli, emit, log: (level, message) => rt.log(level, 'asp_agent', message),
      aspId: async () => { const asp = (await this.identity.mine()).asp; const id = asp?.['agentId'] ?? asp?.['aspAgentId'] ?? asp?.['id']; return id ? String(id) : null; },
      ensureSession: (job, asp, buyer) => ensureBuyerSession(job, buyer, { asp_id: asp, ...(rt.okxAspRunCli ? { runner: rt.okxAspRunCli } : {}) }),
      // 【Futures】/【Spot】+200 字的信号格式只约束策略信号订阅;市场情报/微观告警是分析类服务
      strictSignalService: () => signalServiceId(rt.store),
    });
    // 策略信号服务:接单后立即回一条规范化信号(有效期内的最新计划;没有就发「当前无信号 + 下次扫描时间」的服务消息)。
    // 只挂在这条服务的 serviceId 上;其它服务(市场情报等)由各自处理器负责,没有处理器就不接单。
    registerProviderHandler(`service:${signalServiceId(rt.store)}`, { produce: async () => ({ text: this.welcomeText() }) });
    this.services = new AspServices(rt, {
      cli: this.cli, aspId: () => this.identity.aspId(), register: registerProviderHandler,
      // 会话建不起来必须抛错,扇出才不会 deliver
      ensureSession: async (job, asp, buyer) => { if (!(await ensureBuyerSession(job, buyer, { asp_id: asp, ...(rt.okxAspRunCli ? { runner: rt.okxAspRunCli } : {}) }))) throw new Error('A2A 会话建立失败,本次不投递'); },
      extraServices: () => [this.strategyStatusService()],
    });
    // 注入了 CLI 的环境(测试)不自动起轮询;生产可用 TG_ASP_PROVIDER_POLL=0 关。
    if (!rt.okxAspRunCli && process.env['TG_ASP_PROVIDER_POLL'] !== '0' && process.env['TG_SOAK_OFFLINE'] !== '1' && !process.env['VITEST']) { this.providerTasks.start(); this.services.start(); }
  }
  /** 新订阅的第一条交付:有效期内(至少还剩 1 分钟)最近一条可执行信号按剩余有效期重发;否则发状态消息。 */
  welcomeText(now = Date.now()): string {
    const rows = this.rt.store.marketDb.prepare('SELECT event_json FROM okx_market_delivery_out WHERE refusal IS NULL ORDER BY created_at DESC LIMIT 50').all();
    for (const r of rows) {
      let e: PublishEvent; try { e = JSON.parse(String(r['event_json'])) as PublishEvent; } catch { continue; }
      if (!['strategy_signal', 'entry_filled'].includes(e.kind) || e.direction === 'flat') continue;
      if (!e.signal_only && (e.paper || e.backend === 'paper')) continue;
      if ((e.valid_until ?? e.signal_time + 180_000) < now + 60_000) continue;
      return signalLine(e, e.direction === 'short' ? 'SHORT' : 'LONG', now);
    }
    return this.statusSignal(now);
  }
  /**
   * 没有有效信号时的状态信号行(【Futures】/【Spot】类型头、≤200 字、不含方向和价格,买方 agent 不会当成可执行单)。
   * OKX.AI 审核只把类型头开头的交付算「发了信号」,「Service message」不算,所以欢迎包和保活都用它。
   */
  statusSignal(now = Date.now()): string {
    let runs: { strategy_name: string; timeframe: string; symbols: string[]; next_scan_at: number | null; market: 'spot' | 'perp' }[] = [];
    try { runs = this.rt.strategyRuns().store.list().filter((r) => r.status === 'running' && r.publish_asp); } catch {}
    const next = runs.map((r) => r.next_scan_at).filter((x): x is number => typeof x === 'number' && x > now).sort((a, b) => a - b)[0];
    const run = runs[0];
    const hhmm = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
    const spot = run?.market === 'spot';
    const inst = run ? run.symbols.slice(0, 2).map((s) => symbolToInstId(s, run.market)).join(', ') : 'BTC-USDT-SWAP';
    const head = spot ? `【Spot】OKX | ${inst}` : `【Futures】${inst}`;
    const scan = run ? `${englishName(run.strategy_name) ?? 'Strategy'} ${run.timeframe} scanning${next ? ` | Next scan ${hhmm(next)} UTC` : ` | Scans every ${run.timeframe} bar close`}` : 'Strategy scan idle';
    return infoSignal(`${head} | No active setup`, scan).replace(' | Info only, no order |', ' | Status only, no order |');
  }
  /** 策略信号服务的保活频道:最近 6 小时内没推过任何交付(真实信号或状态)就推一条状态信号,保证订阅者 12 小时内必有信号 */
  strategyStatusService(): SubscriptionServiceDef {
    const BUCKET = 6 * 3_600_000;
    const channel: SubscriptionChannel = {
      key: 'strategy_status', every_ms: 10 * 60_000,
      tick: async (deps) => {
        const now = deps.now();
        const recent = this.rt.store.marketDb.prepare("SELECT 1 FROM okx_market_delivery_out_job WHERE status='delivered' AND updated_at>=? LIMIT 1").get(now - BUCKET);
        if (recent) return null;
        const signal = this.statusSignal(now);
        return { event_id: `strategy_status:${Math.floor(now / BUCKET)}`, channel: 'strategy_status', summary: signal, text: signal, signal, payload: { kind: 'strategy_status', at: now } };
      },
      welcome: async (deps) => { const signal = this.statusSignal(deps.now()); return { event_id: `strategy_status:welcome:${deps.now()}`, channel: 'strategy_status', summary: signal, text: signal, signal, payload: { kind: 'strategy_status' } }; },
    };
    return { service_id: signalServiceId(this.rt.store), channels: [channel], ...(this.services?.isPaused('strategy_signal') ? { paused: true } : {}) };
  }
  shouldCollect(): boolean {
    if (aspSnapshotEnabled()) return false; // 只读快照模式:不轮询收件箱
    if (this.rt.followSettings.enabled || this.settings().publisher.enabled) return true;
    try { return !!JSON.parse(this.rt.store.kvGet('market.asp_identity') ?? '{}').value?.asp; } catch { return false; }
  }
  settings() {
    let stored: Record<string, unknown> = {}; try { stored = object(JSON.parse(this.rt.store.kvGet('market.settings') ?? '{}')); } catch {}
    return { ...this.rt.followSettings, publisher: normalizePublisherSettings(stored['publisher']) };
  }
  saveSettings(patch: Record<string, unknown>) {
    const old = this.settings(); const next = { ...normalizeMarketSettings({ ...old, ...patch }), publisher: normalizePublisherSettings({ ...old.publisher, ...object(patch['publisher']) }) };
    this.rt.setWorkflow({ follow: next }); this.rt.store.kvSet('market.settings', JSON.stringify(next)); this.inbox.syncTransport(); return next;
  }
  stats() {
    const db = this.rt.store.marketDb;
    const deliveries = db.prepare("SELECT job_id,COUNT(*) AS received,SUM(signal_type='order') AS orders,SUM(parse_status='analysis') AS analysis,MAX(received_at) AS last_signal_at FROM okx_market_delivery_in GROUP BY job_id").all();
    const ids = new Set([...Object.keys(this.rt.followSettings.subscriptions), ...deliveries.map((x) => String(x['job_id']))]);
    return [...ids].map((job) => {
      const d = deliveries.find((x) => x['job_id'] === job);
      const raw = db.prepare('SELECT signal_id FROM demo_trader_signal WHERE subscription_job_id=?').all(job);
      const signals = raw.map((x) => this.rt.store.traderSignals.find(String(x['signal_id']))!).filter(Boolean);
      const judged = signals.filter((s) => s.decision?.agent);
      const followed = signals.filter((s) => s.status === 'applied');
      const results = [...new Set(followed.map((s) => s.thread_id).filter((x): x is string => !!x))].map((id) => realizedR(this.rt.store, this.rt.store.thread(id))).filter((r): r is string => r !== null);
      const r = results.reduce((sum, r) => sum + Number(r), 0);
      return { job_id: job, received: Number(d?.['received'] ?? 0), order: Number(d?.['orders'] ?? 0), analysis: Number(d?.['analysis'] ?? 0), followed: followed.length, realized_r: results.length ? r.toFixed(4) : null, agent_agree_rate: judged.length ? judged.filter((s) => s.decision?.agent?.stance === 'agree').length / judged.length : null, last_signal_at: d?.['last_signal_at'] ?? null };
    });
  }
  private buyerQueue: Promise<unknown> = Promise.resolve();
  private buyerOperation<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.buyerQueue.then(fn); this.buyerQueue = result.catch(() => undefined); return result;
  }
  private remoteSubsPending: Promise<Record<string, unknown>> | null = null;
  private remoteSubsGeneration = 0;
  private remoteSubsCache: { at: number; value: Record<string, unknown> } | null = null;
  /** my-subscriptions(buyer)带 60s 缓存:订阅栏、目录「已订阅」标记、scorecard 都要它,别每次都起 CLI。 */
  async remoteSubscriptions(fresh = false): Promise<Record<string, unknown>> {
    if (!fresh && this.remoteSubsCache && Date.now() - this.remoteSubsCache.at < 60_000) return this.remoteSubsCache.value;
    if (this.remoteSubsPending) return this.remoteSubsPending;
    const generation = this.remoteSubsGeneration;
    const pending = this.cli.call('my-subscriptions', ['--role', 'buyer']).then((result) => {
      const raw = payload(result); const value = Array.isArray(raw) ? { list: raw } : object(raw);
      if (!['list', 'subscriptions', 'items'].some((key) => Array.isArray(value[key]))) throw new CliError('cli_invalid_json', JSON.stringify(result), {}, 502, '订阅列表格式无法确认，已停止操作。');
      if (generation === this.remoteSubsGeneration) this.remoteSubsCache = { at: Date.now(), value };
      return value;
    });
    this.remoteSubsPending = pending;
    try { return await pending; } finally { if (this.remoteSubsPending === pending) this.remoteSubsPending = null; }
  }
  invalidateSubscriptions() { this.remoteSubsCache = null; this.remoteSubsPending = null; this.remoteSubsGeneration++; }
  /** ASP 身份(名字/头像/服务名)从网页目录补:CLI 的订阅行只有 providerAgentId 和我们自己起的 title。 */
  aspOf(providerAgentId: string | null, fee: string | null): { name: string; avatar: string | null; service_name: string | null } | null {
    if (!providerAgentId) return null;
    const a = this.catalog.get().agents.find((x) => x.agent_id === providerAgentId); if (!a) return null;
    const svc = a.services.find((x) => fee !== null && x.price !== null && Number(x.price) === Number(fee)) ?? a.services.find((x) => x.price_interval === 'month') ?? a.services[0];
    return { name: a.name, avatar: a.avatar, service_name: svc?.name ?? null };
  }
  /** providerAgentId → 我方在它名下的订阅(目录卡标「试用中/已订阅/等接单」用)。 */
  async subscribedByProvider(): Promise<Record<string, { job_id: string; status_name: string; trial: boolean }>> {
    const out: Record<string, { job_id: string; status_name: string; trial: boolean }> = {};
    for (const r of list(await this.remoteSubscriptions())) {
      const pid = String(r['providerAgentId'] ?? ''); const status = subscriptionStatus(r); if (!pid || !status) continue;
      if (terminal(r)) continue;
      out[pid] = { job_id: String(r['jobId'] ?? ''), status_name: status, trial: Number(r['trialType']) === 1 };
    }
    return out;
  }
  async subscriptions() {
    const remote = await this.remoteSubscriptions(true);
    const stats = this.stats(); const rows = list(remote); const settings = this.rt.followSettings;
    const ids = new Set([...rows.map((x) => normalizeJobId(x['jobId'])), ...Object.keys(settings.subscriptions).map(normalizeJobId)].filter(Boolean));
    const now = Date.now(); const rank = (g: SubscriptionGroup) => SUBSCRIPTION_GROUP_ORDER.indexOf(g);
    // 排序:按 display.group 顺序,组内按开始时间倒序
    return { thisDeviceId: remote['thisDeviceId'] ?? null, subscriptions: [...ids].map((job_id) => { const r = rows.find((x) => normalizeJobId(x['jobId']) === job_id) ?? null; const { started_at, ...display } = subscriptionDisplay(r, now); return { job_id, display, started_at, remote: r, asp: this.aspOf(r ? String(r['providerAgentId'] ?? '') || null : null, r ? String(r['serviceTokenAmount'] ?? r['paymentTokenAmount'] ?? '') || null : null), config: Object.entries(settings.subscriptions).find(([id]) => normalizeJobId(id) === job_id)?.[1] ?? { mode: settings.default_mode, weight: 0, enabled: true, approval: 'manual' }, stats: stats.find((x) => normalizeJobId(x.job_id) === job_id) ?? { job_id, received: 0, order: 0, analysis: 0, followed: 0, realized_r: null, agent_agree_rate: null, last_signal_at: null } }; })
      .sort((a, b) => rank(a.display.group) - rank(b.display.group) || (b.started_at ?? 0) - (a.started_at ?? 0)) };
  }
  async devices(job: string, receives: boolean) {
    const remote = await this.remoteSubscriptions(true);
    const device = remote['thisDeviceId']; if (typeof device !== 'string' || !device) throw new Error('my-subscriptions 没有返回 thisDeviceId');
    const sub = list(remote).find((x) => normalizeJobId(x['jobId']) === normalizeJobId(job)); if (!sub) throw new Error(`my-subscriptions 找不到 ${job}`);
    let devices: string[];
    if (sub['deviceList'] === null || sub['deviceList'] === undefined) {
      // null means all devices: enabling this receiver is already satisfied.
      if (receives) return { unchanged: true };
      // Resolve that set before removing one receiver to preserve other receivers.
      const all = list(await this.cli.call('device-list'));
      devices = all.map((x) => String(x['deviceId'] ?? x['id'] ?? '')).filter(Boolean);
      if (!devices.length && !receives) throw new Error('无法取得设备集合，未覆盖原有接收列表');
    } else if (Array.isArray(sub['deviceList'])) devices = sub['deviceList'].map(String);
    else throw new Error('deviceList 格式无效');
    if (receives && devices.includes(device)) return { unchanged: true };
    devices = [...new Set(receives ? [...devices, device] : devices.filter((x) => x !== device))];
    const result = data(await this.cli.call('subscribe-device-update', ['--job-id', normalizeJobId(job), '--device-list', devices.join(',')])); this.invalidateSubscriptions(); return result;
  }
  subscribe(o: Record<string, unknown>) { return this.buyerOperation(() => this.createSubscription(o)); }
  private async createSubscription(o: Record<string, unknown>) {
    for (const key of ['service_id', 'fee_amount', 'fee_token_address']) if (typeof o[key] !== 'string' || !o[key]) throw Object.assign(new Error(`${key} 必填`), { status: 400 });
    if (!/^\d+(?:\.\d{1,6})?$/.test(String(o['fee_amount']))) throw Object.assign(new Error('fee_amount 必须是十进制字符串'), { status: 400 });
    this.validateConfig(o);
    const args = ['--service-id', String(o['service_id']), '--service-token-amount', String(o['fee_amount']), '--service-token-address', String(o['fee_token_address']), '--use-trial', String(o['use_trial'] === true), '--auto-renew', o['auto_renew'] === true ? '1' : '0', '--title', [...String(o['title'] ?? `trade-gate · ${o['service_id']}`)].slice(0, 30).join('') /* 4.6.2 硬限 30 个字符(按码点数) */, '--description', String(o['description'] ?? 'trade-gate 信号订阅')];
    // onchainos 4.6.2 的 create-subscribe 没有任何 autotrade 参数(自动交易是 skill 流程里另行 consent 的),这里永远不传;provider-agent-id 在 4.6.2 是必填。
    if (typeof o['provider_agent_id'] !== 'string' || !o['provider_agent_id']) throw Object.assign(new Error('provider_agent_id 必填(onchainos 4.6.2 起 create-subscribe 要求)'), { status: 400 });
    args.push('--provider-agent-id', String(o['provider_agent_id']));
    // onchainos 4.6.2 起 create-subscribe 前必须先持久化本机的「订阅执行偏好」;我们永远是 signal_only:
    // 投递只进本机网关账本,由 PM/人工决定是否下单,绝不让 okx-a2a 按 Service Guide 自动跟单(guide_direct)。
    const beforeRemote = await this.remoteSubscriptions(true);
    const before = list(beforeRemote);
    const existing = before.find((r) => String(r['serviceId']) === o['service_id'] && String(r['providerAgentId']) === o['provider_agent_id'] && !terminal(r));
    if (existing) {
      const configured = existing['thisDeviceReceives'] === true || existing['deviceList'] === null || (Array.isArray(existing['deviceList']) && existing['deviceList'].includes(beforeRemote['thisDeviceId']));
      return { jobId: normalizeJobId(existing['jobId']), funding_notice: null, configured, already_subscribed: true, error: configured ? undefined : '已有订阅，请勿重复订阅；请到订阅栏检查本机接收配置。' };
    }
    await this.executionConfig(String(o['service_id']));
    let result: Record<string, unknown>;
    try { result = data(await this.cli.call('create-subscribe', args)); }
    catch (e) { if (!(e instanceof CliError)) throw e; const funding = await this.funding(e.output); if (funding) return { jobId: null, funding_notice: funding }; throw e; }
    const funding = await this.funding(result); if (funding) return { jobId: null, funding_notice: funding };
    // 4.6.2 的返回是 next-action 式信封(nextAction/payload/executionProfileSaved…),jobId 不一定在顶层:递归找,找不到再回查 my-subscriptions。
    this.invalidateSubscriptions();
    let job = findJobId(result);
    try { job ??= await this.newJobFor(String(o['service_id']), String(o['provider_agent_id']), before); } catch (e) { throw new CliError('subscription_result_unknown', (e as Error).message, {}, 502, '订阅可能已创建，回查失败；请刷新订阅列表核实，勿重复提交。'); }
    if (!job) throw new CliError('subscription_result_unknown', `create-subscribe 没有返回 jobId(顶层键:${Object.keys(result).join(',')})`, {}, 502, '订阅可能已创建，无法唯一确认 jobId；请刷新订阅列表核实，勿重复提交。');
    // Creation is not retried if device routing fails; expose the created job for repair.
    this.saveConfig(job, { mode: o['mode'] ?? this.rt.followSettings.default_mode, approval: o['approval'] ?? 'manual', weight: o['weight'] ?? 0, enabled: true });
    try { await this.devices(job, true); } catch (e) { this.invalidateSubscriptions(); this.rt.emit('market_subscription', { job_id: job, action: 'created' }); return { jobId: job, funding_notice: null, configured: false, error: `订阅已创建，请勿重复订阅。本机接收配置失败：${(e as Error).message}` }; }
    this.invalidateSubscriptions(); this.rt.emit('market_subscription', { job_id: job, action: 'created' }); return { jobId: job, funding_notice: null, configured: true };
  }
  /** Only a unique new row for this provider/service can reconcile a missing create result. */
  private async newJobFor(service: string, provider: string, before: Record<string, unknown>[]): Promise<string | null> {
    const previous = new Set(before.map((r) => normalizeJobId(r['jobId'])));
    const rows = list(await this.remoteSubscriptions(true)).filter((r) => String(r['serviceId']) === service && String(r['providerAgentId']) === provider && !previous.has(normalizeJobId(r['jobId'])));
    return rows.length === 1 ? normalizeJobId(rows[0]!['jobId']) || null : null;
  }
  private async executionConfig(service: string) {
    // A configuration error is not authorization to replace an existing execution preference.
    await this.cli.call('subscription-execution-config-set', ['--service-id', service, '--execution-mode', 'signal_only']);
  }
  subscriptionAction(job: string, action: 'cancel' | 'reject' | 'autorenew', o: Record<string, unknown>) {
    return this.buyerOperation(async () => {
      job = normalizeJobId(job);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(job)) throw Object.assign(new Error('job_id 格式无效'), { status: 400 });
      if (action === 'reject' && (typeof o['reason'] !== 'string' || !o['reason'].trim() || o['reason'].length > 2000)) throw Object.assign(new Error('拒收理由须为 1–2000 字符'), { status: 400 });
      const current = async () => list(await this.remoteSubscriptions(true)).find((r) => normalizeJobId(r['jobId']) === job);
      const satisfied = (r: Record<string, unknown>) => action === 'cancel'
        ? terminal(r) || (subscriptionStatus(r) === 'ACTIVE' && Number(r['trialType']) !== 1 && (r['autoRenew'] === false || r['autoRenew'] === 0 || r['autoRenew'] === '0'))
        : action === 'autorenew' ? !terminal(r) && enabled(r['autoRenew']) : ['REJECTED', 'DISPUTED'].includes(subscriptionStatus(r));
      const remote = await current();
      if (!remote) throw Object.assign(new Error('当前买方订阅列表中找不到该 job_id'), { status: 404 });
      if (satisfied(remote)) return { job_id: job, unchanged: true, remote };
      if (terminal(remote)) throw Object.assign(new Error(`订阅已${subscriptionStatus(remote)}，无法执行此操作`), { status: 409 });
      try {
        let result: Record<string, unknown>;
        if (action === 'reject') {
          const prepared = data(await this.cli.call('refund-prepare', [job, '--reason', String(o['reason'])]));
          // Only execute the same refund the user requested; trial cancellation is a separate action.
          const refund = object(prepared['payload']);
          const operation = object(refund['capability'])['clientOperation']; const context = refund['refundContextId'];
          if (operation !== 'request-refund' || typeof context !== 'string' || !context || object(refund['request'])['userReason'] !== o['reason'] || normalizeJobId(object(refund['job'])['jobId']) !== job) throw new CliError('refund_not_available', JSON.stringify(prepared), {}, 409, '当前订阅无法拒收退款；试用取消请使用“取消转付费”。');
          result = data(await this.cli.call('refund-execute', [job, '--operation', operation, '--refund-context-id', context, '--reason', String(o['reason']), '--confirm']));
        } else result = data(await this.cli.call(action === 'cancel' ? 'subscribe-cancel' : 'start-autorenew', [job]));
        this.invalidateSubscriptions(); this.rt.emit('market_subscription', { job_id: job, action });
        return { job_id: job, result };
      } catch (error) {
        this.invalidateSubscriptions();
        // A remote transition may race the precheck, including a successful write with lost response.
        const latest = await current().catch(() => undefined);
        if (latest && satisfied(latest)) return { job_id: job, unchanged: true, remote: latest };
        throw error;
      }
    });
  }
  private async funding(v: unknown): Promise<unknown | null> {
    const o = data(v); const command = o['fundingNoticeCommand'] ?? object(v)['fundingNoticeCommand']; if (!command) return null;
    // Never run CLI output through a shell. Accept only the funding-notice verb and its documented flags.
    const tokens = Array.isArray(command) ? command.map(String) : String(command).match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((x) => x.replace(/^['"]|['"]$/g, '')) ?? [];
    const start = tokens.indexOf('funding-notice');
    if (start < 0 || !['agent', 'onchainos'].every((x) => tokens.slice(0, start).includes(x))) return { command, error: '无法安全解析 fundingNoticeCommand' };
    const args = tokens.slice(start + 1); const allowed = new Set(['--chain', '--currency', '--shortfall', '--deposit-address', '--format', '--reason', '--available', '--required', '--deposit-chain']);
    for (let i = 0; i < args.length; i += 2) if (!allowed.has(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith('--')) return { command, error: 'fundingNoticeCommand 参数无效' };
    return data(await this.cli.call('funding-notice', args));
  }
  validateConfig(o: Record<string, unknown>) {
    if (o['mode'] !== undefined && !['book', 'copy', 'gated', 'evidence'].includes(String(o['mode']))) throw Object.assign(new Error('mode 无效'), { status: 400 });
    if (o['approval'] !== undefined && !['manual', 'auto'].includes(String(o['approval']))) throw Object.assign(new Error('approval 只能是 manual/auto'), { status: 400 });
    if (o['weight'] !== undefined && (typeof o['weight'] !== 'number' || !Number.isFinite(o['weight']) || o['weight'] < 0 || o['weight'] > 1)) throw Object.assign(new Error('weight 必须是 0–1'), { status: 400 });
    for (const key of ['enabled', 'this_device_receives', 'use_trial', 'auto_renew']) if (o[key] !== undefined && typeof o[key] !== 'boolean') throw Object.assign(new Error(`${key} 必须是 boolean`), { status: 400 });
  }
  saveConfig(job: string, patch: Record<string, unknown>): MarketSubscription {
    this.validateConfig(patch);
    job = normalizeJobId(job);
    const f = this.rt.followSettings;
    const subscriptions = Object.fromEntries(Object.entries(f.subscriptions).map(([id, config]) => [normalizeJobId(id), config]));
    const c = { mode: f.default_mode, weight: 0, enabled: true, approval: 'manual', ...subscriptions[job], ...patch };
    const next = this.saveSettings({ subscriptions: { ...subscriptions, [job]: c } }); this.rt.emit('market_subscription', { job_id: job, action: 'updated' }); return next.subscriptions[job]!;
  }
  async asp() {
    const identities = await this.identity.mine(); if (!identities.asp) return { identity: null, services: null, active: null, subscriptions: null, claimable: null, aftersales: this.aftersales.rows() };
    const id = await this.identity.aspId();
    // 收益查询是附属信息:onchainos 4.6.2 的 asp-claimable 只打人话表格(非 JSON),解析不了/失败也只降级这一格,不拖垮整个视图。
    const claim = this.claimable(id);
    const [services, active, subscriptions, claimable] = await Promise.all([this.cli.call('service-list', ['--agent-id', id]), this.cli.call('subscribe-active', ['--agent-id', id]), this.cli.call('my-subscriptions', ['--role', 'provider']), claim]);
    return { identity: identities.asp, services: payload(services), active: payload(active), subscriptions: payload(subscriptions), claimable: claimable.value, ...(claimable.error ? { claimable_error: claimable.error } : {}), aftersales: this.aftersales.rows() };
  }
  private async claimable(id: string): Promise<{ value: unknown; error: string | null }> {
    try { return { value: payload(await this.cli.call('asp-claimable', ['--agent-id', id])), error: null }; }
    catch (e) {
      const text = e instanceof CliError && e.code === 'cli_invalid_json' ? parseClaimableText(e.raw_message) : null;
      if (text) return { value: text, error: null };
      return { value: null, error: `收益查询暂不可用:${(e as Error).message.split('\n')[0]}` };
    }
  }
  async claim() {
    const id = await this.identity.aspId(); const run = startAspRun(this.rt.store, 'asp_claim', { asp_id: id });
    try {
      let result: Record<string, unknown>;
      try { result = data(await this.cli.call('asp-claim-rewards', ['--agent-id', id])); }
      catch (e) {
        // 没有待领收益时 CLI 同样只打人话;识别成「无可领」而不是格式错误,其余错误照抛。
        const parsed = e instanceof CliError && e.code === 'cli_invalid_json' ? parseClaimableText(e.raw_message) : null;
        if (!parsed || parsed.pending) throw e;
        result = { claimed: false, ...parsed };
      }
      this.wallet.invalidate(); this.rt.store.bots.finishRun(run, { status: 'done', result }); return result; }
    catch (e) { this.rt.store.bots.finishRun(run, { status: 'failed', error: (e as Error).message }); throw e; }
  }
  async preview() {
    const identities = await this.identity.mine();
    if (identities.asp && list(await this.cli.call('subscribe-active', ['--agent-id', await this.identity.aspId()])).length) throw Object.assign(new Error('有活跃订阅者时不可测试投递'), { status: 409 });
    const e: PublishEvent = { event_id: 'preview', kind: 'decision_record', signal_time: Date.now(), symbol: 'BTCUSDT', direction: 'long', price: '64120', stop_loss: '63400', take_profit: ['65200', '66100'], reason: '示例研究判断 / Example research judgment', thread_id: null, realized_r: null, backend: 'paper', paper: true };
    return renderDeliverable(e, this.settings().publisher);
  }
}
