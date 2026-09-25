import { MarketWallet } from './wallet.js';
import type { DemoRuntime } from '../runtime.js';
import { MarketCli, CliError, data, list, object, payload } from './cli.js';
import { MarketInbox, downloadFileDelivery } from './inbox.js';
import { MarketPublisher, renderDeliverable, realizedR, type PublishEvent } from './publisher.js';
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
export function findJobId(v: unknown, depth = 0): string | null {
  if (depth > 12 || !v || typeof v !== 'object') return null;
  const o = object(v);
  for (const [k, value] of Object.entries(o)) if (['jobid', 'subscriptionid', 'subid'].includes(k.replaceAll('_', '').toLowerCase()) && typeof value === 'string' && value && (depth === 0 || /^(?:0x)?[0-9a-f]{64}$/i.test(value))) return normalizeJobId(value);
  for (const x of Object.values(v)) { const r = findJobId(x, depth + 1); if (r) return r; }
  return null;
}
export class AspAgent {
  readonly wallet: MarketWallet; readonly cli: MarketCli; readonly identity: MarketIdentity; readonly inbox: MarketInbox; readonly publisher: MarketPublisher; readonly aftersales: MarketAftersales; readonly catalog: MarketCatalog;
  constructor(private readonly rt: DemoRuntime, session: () => string) {
    this.cli = new MarketCli(rt.okxAspRunCli ?? undefined);
    this.wallet = new MarketWallet(this.cli);
    this.identity = new MarketIdentity(this.cli, rt.store);
    const emit = (name: string, payload: unknown) => rt.emit(name, payload);
    this.aftersales = new MarketAftersales({ store: rt.store, cli: this.cli, aspId: () => this.identity.aspId(), emit, activity: (title) => rt.activity('info_update', { title }) });
    this.inbox = new MarketInbox({ store: rt.store, settings: () => ({ ...rt.followSettings, enabled: this.shouldCollect() }), session, fetchFile: async (d, job) => { const buyer = (await this.identity.mine()).buyer; const id = buyer?.['agentId']; if (!id) throw new Error('没有买方身份,无法解密文件投递'); return downloadFileDelivery(d, String(id), job); }, signalEnabled: () => rt.followSettings.enabled, ...(rt.okxAspReadQueue ? { readQueue: rt.okxAspReadQueue } : {}), system: (e, id) => this.aftersales.receive(e, id), emit, traderOf: (job) => rt.okxAspFeed().traderOf(job) });
    this.catalog = new MarketCatalog({ store: rt.store, log: (level, message) => rt.log(level, 'asp_agent', message) });
    this.publisher = new MarketPublisher({ store: rt.store, cli: this.cli, settings: () => this.settings().publisher, aspId: () => this.identity.aspId(), emit });
  }
  shouldCollect(): boolean {
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
    return { thisDeviceId: remote['thisDeviceId'] ?? null, subscriptions: [...ids].map((job_id) => { const r = rows.find((x) => normalizeJobId(x['jobId']) === job_id) ?? null; return { job_id, remote: r, asp: this.aspOf(r ? String(r['providerAgentId'] ?? '') || null : null, r ? String(r['serviceTokenAmount'] ?? r['paymentTokenAmount'] ?? '') || null : null), config: Object.entries(settings.subscriptions).find(([id]) => normalizeJobId(id) === job_id)?.[1] ?? { mode: settings.default_mode, weight: 0, enabled: true, approval: 'manual' }, stats: stats.find((x) => normalizeJobId(x.job_id) === job_id) ?? { job_id, received: 0, order: 0, analysis: 0, followed: 0, realized_r: null, agent_agree_rate: null, last_signal_at: null } }; }) };
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
    const args = ['--service-id', String(o['service_id']), '--service-token-amount', String(o['fee_amount']), '--service-token-address', String(o['fee_token_address']), '--use-trial', String(o['use_trial'] === true), '--auto-renew', o['auto_renew'] === true ? '1' : '0', '--title', [...String(o['title'] ?? `trading-swarm · ${o['service_id']}`)].slice(0, 30).join('') /* 4.6.2 硬限 30 个字符(按码点数) */, '--description', String(o['description'] ?? 'trading-swarm 信号订阅')];
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
    const [services, active, subscriptions, claimable] = await Promise.all([this.cli.call('service-list', ['--agent-id', id]), this.cli.call('subscribe-active', ['--agent-id', id]), this.cli.call('my-subscriptions', ['--role', 'provider']), this.cli.call('asp-claimable', ['--agent-id', id])]);
    return { identity: identities.asp, services: payload(services), active: payload(active), subscriptions: payload(subscriptions), claimable: payload(claimable), aftersales: this.aftersales.rows() };
  }
  async claim() {
    const id = await this.identity.aspId(); const run = startAspRun(this.rt.store, 'asp_claim', { asp_id: id });
    try { const result = data(await this.cli.call('asp-claim-rewards', ['--agent-id', id])); this.wallet.invalidate(); this.rt.store.bots.finishRun(run, { status: 'done', result }); return result; }
    catch (e) { this.rt.store.bots.finishRun(run, { status: 'failed', error: (e as Error).message }); throw e; }
  }
  async preview() {
    const identities = await this.identity.mine();
    if (identities.asp && list(await this.cli.call('subscribe-active', ['--agent-id', await this.identity.aspId()])).length) throw Object.assign(new Error('有活跃订阅者时不可测试投递'), { status: 409 });
    const e: PublishEvent = { event_id: 'preview', kind: 'decision_record', signal_time: Date.now(), symbol: 'BTCUSDT', direction: 'long', price: '64120', stop_loss: '63400', take_profit: ['65200', '66100'], reason: '示例研究判断 / Example research judgment', thread_id: null, realized_r: null, backend: 'paper', paper: true };
    return renderDeliverable(e, this.settings().publisher);
  }
}
