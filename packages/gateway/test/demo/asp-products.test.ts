// 「我的产品」卖方视图:产品卡/订阅者/暂停接单/改资料预检与提交,以及买方订阅栏分组排序。零网络,CLI 全部假实现,绝不调真 onchainos。
import { afterEach, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { MarketCli, setNetworkBackoffForTest, type CliRunner } from '../../src/demo/asp-agent/cli.js';
import { AspAgent, subscriptionDisplay } from '../../src/demo/asp-agent/agent.js';
import { ProviderTaskPoller, type ProviderHandler, type ProviderTask } from '../../src/demo/asp-agent/provider-tasks.js';
import { AspServices, REVIEW_NOTICE, findTxHash } from '../../src/demo/asp-agent/services/index.js';
import { PAUSE_REASON } from '../../src/demo/asp-agent/services/register.js';
import { DEFAULT_MARKET_SETTINGS } from '../../src/demo/asp-agent/settings.js';
import type { DemoRuntime } from '../../src/demo/runtime.js';

setNetworkBackoffForTest(0);
const states: StateDb[] = [];
const hubs: AspServices[] = [];
afterEach(async () => { for (const h of hubs.splice(0)) await h.stop(); for (const s of states.splice(0)) s.close(); });
function store() { const s = openStateDb(':memory:'); states.push(s); return new DemoStore(s); }
const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data: v }), stderr: '' });
const NOW_S = Math.floor(Date.now() / 1000);
const SIGNAL_SID = 'c7f0c55b-7374-4402-912f-020dd456c066';
const INTEL_SID = '85e36fe4-2c0b-4a79-9546-d1004f56420f';
const MICRO_SID = '7ce4c7b0-199e-4c2d-b077-360902502bd3';
const ASSET_SID = 'asset-sid-1';

const svcRow = (id: number, serviceId: string, serviceName: string, sub: string | null, fee = '', desc = 'line1\nline2\nline3') => ({
  id, serviceId, serviceName, serviceType: 'A2A', serviceDescription: desc, fee: sub ? '' : fee,
  subscription: sub ? [{ fee: sub, interval: 'month' }] : [], ...(sub ? { freeTrial: '72' } : {}),
});
const serviceList = (approvalStatus: number | undefined) => [{
  agentInfo: { agentId: '13866', name: 'Trading Swarm', ...(approvalStatus === undefined ? {} : { approvalStatus }), approvalRemark: '改资料触发重新审批', onlineStatus: 1 },
  hasMore: false,
  list: [
    svcRow(40888, SIGNAL_SID, 'Trading Swarm 策略信号', '1'),
    svcRow(41036, INTEL_SID, 'Market Intel 市场情报', '9.9'),
    svcRow(41037, MICRO_SID, 'BTC/ETH Microstructure Alerts', '5.9'),
    svcRow(41038, ASSET_SID, 'Asset x Horizon Picks', null, '0.5'),
  ],
}];
const provSubs = [
  { jobId: '0xintel1', serviceId: INTEL_SID, providerAgentId: '13866', buyerAgentId: '13529', statusName: 'ACTIVE', status: 1, trialType: 1, autoRenew: 0, subStartTime: null, subEndTime: null, trialStartTime: NOW_S - 3600, trialEndTime: NOW_S + 70 * 3600 },
  { jobId: '0xintel2', serviceId: INTEL_SID, providerAgentId: '13866', buyerAgentId: '14000', statusName: 'CLOSED', status: 7, trialType: 1, autoRenew: 0, trialStartTime: NOW_S - 7200, trialEndTime: NOW_S + 60 * 3600 },
  { jobId: '0xsig1', serviceId: SIGNAL_SID, providerAgentId: '13866', buyerAgentId: '13529', statusName: 'ACTIVE', status: 1, trialType: 0, autoRenew: 1, subStartTime: NOW_S - 86400, subEndTime: NOW_S + 29 * 86400 },
  { jobId: '0xother', serviceId: INTEL_SID, providerAgentId: '99999', buyerAgentId: '1', statusName: 'ACTIVE', status: 1, trialType: 0 },
];

interface Fake { calls: string[][]; validate: { pass: boolean; findings: unknown[] }; update: unknown; approval?: number }
function fakeRunner(f: Fake): CliRunner {
  return async (_bin, args) => {
    f.calls.push(args);
    const cmd = args[1];
    if (cmd === 'service-list') return ok(serviceList(f.approval));
    if (cmd === 'my-subscriptions') return ok({ list: provSubs, thisDeviceId: null });
    if (cmd === 'asp-claimable') return { code: 0, stdout: 'claimable rewards (account=0xabc)\n  USDT 1.5 (token=0x779ded0c9e1022225f8e0630b35a9b54be713736)\n', stderr: '' };
    if (cmd === 'validate-listing') return { code: 0, stdout: JSON.stringify(f.validate, null, 2), stderr: '' };
    if (cmd === 'update') return ok(f.update);
    if (cmd === 'subscribe-active') return ok({ list: [] });
    throw new Error(`unexpected CLI ${args.join(' ')}`);
  };
}
function setup(opts: { approval?: number; configure?: boolean } = {}) {
  const s = store();
  const f: Fake = { calls: [], validate: { pass: true, findings: [] }, update: { txHash: '0x' + 'ab'.repeat(32) }, ...(opts.approval !== undefined ? { approval: opts.approval } : {}) };
  if (!('approval' in opts)) f.approval = 3;
  const cli = new MarketCli(fakeRunner(f));
  // 接单账本表由 ProviderTaskPoller 建
  new ProviderTaskPoller({ store: s, cli, aspId: async () => '13866', ensureSession: async () => true, log: () => {}, emit: () => {}, lockPath: '/nonexistent/lock', eventLogPath: '/nonexistent/log' });
  const logs: string[] = [];
  const rt = { store: s, log: (_l: string, _s: string, m: string) => logs.push(m), emit: () => {}, modelConnections: () => ({ frozenDecision: () => null }) };
  const registry = new Map<string, ProviderHandler>();
  const register = (key: string, h: ProviderHandler) => { registry.set(key, h); return () => { if (registry.get(key) === h) registry.delete(key); }; };
  const hub = new AspServices(rt as unknown as DemoRuntime, { cli, aspId: async () => '13866', micro: null, register, lookup: (k) => registry.get(k), tick_ms: 3_600_000 });
  hubs.push(hub);
  if (opts.configure !== false) s.kvSet('asp_services.config', JSON.stringify({ service_ids: { market_intel: INTEL_SID, micro_alerts: MICRO_SID, asset_horizon: ASSET_SID } }));
  const db = s.marketDb;
  const now = Date.now();
  // 按次:1 单已交付、1 单交付失败说明、1 单拒单(不计订单)、1 单 8 天前已交付
  const task = db.prepare("INSERT INTO okx_market_provider_task(job_id,kind,service_id,buyer_agent_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  task.run('0xa1', 'one_time', ASSET_SID, '13529', 'delivered', now - 3_600_000, now - 3_000_000);
  task.run('0xa2', 'one_time', ASSET_SID, '13529', 'delivered', now - 1_800_000, now - 1_000_000);
  task.run('0xa3', 'one_time', ASSET_SID, '13529', 'declined', now - 1_000_000, now - 1_000_000);
  task.run('0xa4', 'one_time', ASSET_SID, '14000', 'delivered', now - 8 * 86_400_000, now - 8 * 86_400_000);
  task.run('0xintel1', 'subscription', INTEL_SID, '13529', 'delivered', now - 3_600_000, now - 3_500_000);
  db.prepare("INSERT INTO okx_market_provider_event(job_id,description,updated_at) VALUES (?,?,?)").run('0xa1', '推荐短线 BTC ETH', now);
  const res = db.prepare("INSERT INTO okx_market_service_result(job_id,listing,service_id,created_at,summary,payload_json) VALUES (?,?,?,?,?,?)");
  res.run('0xa1', 'asset_horizon', ASSET_SID, now - 3_000_000, 'BTC short ok', '{}');
  res.run('0xa2', 'asset_horizon', ASSET_SID, now - 1_000_000, 'failed: timeout', '{}');
  // 订阅扇出:市场情报 2 条推给 0xintel1,1 成 1 败
  db.prepare("INSERT INTO okx_market_service_push VALUES (?,?,?,?,?,?,?,?,NULL)").run('p1', INTEL_SID, 'market_brief', now - 600_000, 's', 't', '{}', '["0xintel1"]');
  db.prepare("INSERT INTO okx_market_service_push VALUES (?,?,?,?,?,?,?,?,NULL)").run('p2', INTEL_SID, 'market_brief', now - 300_000, 's', 't', '{}', '["0xintel1"]');
  db.prepare("INSERT INTO okx_market_service_push_job(event_id,job_id,status,updated_at) VALUES (?,?,?,?)").run('p1', '0xintel1', 'delivered', now - 600_000);
  db.prepare("INSERT INTO okx_market_service_push_job(event_id,job_id,status,updated_at) VALUES (?,?,?,?)").run('p2', '0xintel1', 'failed', now - 300_000);
  // 策略信号发布器账本
  db.prepare('INSERT INTO okx_market_delivery_out VALUES (?,?,?,?,?,?,?,?)').run('e1', now - 120_000, '{}', '["0xsig1"]', 'x', '{}', '13866', null);
  db.prepare("INSERT INTO okx_market_delivery_out_job(event_id,job_id,status,updated_at) VALUES (?,?,?,?)").run('e1', '0xsig1', 'delivered', now - 100_000);
  return { s, f, hub, registry, logs, now };
}
const ptask = (o: Partial<ProviderTask>): ProviderTask => ({ job_id: '0xnew', kind: 'subscription', status: 0, status_label: null, service_id: null, service_name: null, buyer_agent_id: '1', buyer_name: null, title: null, detail: null, raw: {}, test_flag: false, ...o } as ProviderTask);

describe('GET products', () => {
  it('builds identity strip, checklist and 8 product cards from service-list + ledgers', async () => {
    const { hub, f } = setup();
    const v = await hub.products();
    expect(v.asp).toEqual({ agent_id: '13866', name: 'Trading Swarm', approval: { code: 3, label: '重新审核中(资料有改动)', remark: '改资料触发重新审批' }, online: true, claimable_usdt: '1.5' });
    expect(v.products.map((p) => p.key)).toEqual(['strategy_signal', 'market_intel', 'micro_alerts', 'asset_horizon', 'research_quick', 'research_full', 'plan_gate', 'jev_probability']);
    const by = Object.fromEntries(v.products.map((p) => [p.key, p]));
    expect(by['strategy_signal']).toMatchObject({ name: 'Trading Swarm 策略信号', kind: 'subscription', price: '1', price_unit: 'month', trial_hours: 72, service_id: SIGNAL_SID, listing_id: '40888', status: 'in_review', paused: false,
      stats: { active_subscribers: 1, trial_subscribers: 0, deliveries_ok: 1, deliveries_failed: 0 } });
    // 其他 ASP 的行不算;关闭的不算
    expect(by['market_intel']!.stats).toMatchObject({ active_subscribers: 1, trial_subscribers: 1, orders_total: 1, deliveries_ok: 2, deliveries_failed: 1 });
    expect(by['asset_horizon']).toMatchObject({ kind: 'one_time', price: '0.5', price_unit: 'call', trial_hours: null, listing_id: '41038', description: 'line1\nline2\nline3',
      stats: { orders_total: 3, orders_7d: 2, deliveries_ok: 2, deliveries_failed: 1 } });
    expect(by['asset_horizon']!.stats.last_delivery_at).toBeGreaterThan(0);
    expect(by['research_full']).toMatchObject({ status: 'not_listed', listing_id: null, service_id: null, price: '15', stats: { orders_total: 0, last_delivery_at: null } });
    expect(v.checklist.map((c) => [c.key, c.done])).toEqual([['asp', true], ['listed', true], ['review', true], ['first_customer', true]]);
    // service-list 缓存 5 分钟
    await hub.products();
    expect(f.calls.filter((c) => c[1] === 'service-list')).toHaveLength(1);
    expect(f.calls.find((c) => c[1] === 'service-list')).toEqual(['agent', 'service-list', '--agent-id', '13866', '--page', '1', '--page-size', '20']);
  });
  it('never invents a listed state: unknown approval codes and failed service-list map to unknown / not submitted', async () => {
    const a = setup({ approval: 7 });
    const v = await a.hub.products();
    expect(v.asp.approval).toMatchObject({ code: 7, label: '状态未知(代码 7)' });
    expect(v.products.find((p) => p.key === 'market_intel')!.status).toBe('unknown');
    const b = setup({ approval: undefined });
    const w = await b.hub.products();
    expect(w.asp.approval).toMatchObject({ code: 1, label: '未提交审核' });
    expect(w.checklist.find((c) => c.key === 'review')!.done).toBe(false);
    const r = setup({ approval: 6 });
    expect((await r.hub.products()).asp.approval.label).toBe('被拒:改资料触发重新审批');
  });
});

describe('customers', () => {
  it('subscription products list provider subscribers with trial flag, times in ms and push counts', async () => {
    const { hub } = setup();
    const v = await hub.customers('market_intel');
    expect(v.items.map((x) => x.job_id)).toEqual(['0xintel1', '0xintel2']);
    expect(v.items[0]).toMatchObject({ buyer_agent_id: '13529', status_label: '试用中', trial: true, started_at: (NOW_S - 3600) * 1000, ends_at: (NOW_S + 70 * 3600) * 1000, pushes: 2 });
    expect(v.items[1]).toMatchObject({ status_label: '已结束', pushes: 0 });
    expect((await hub.customers('strategy_signal')).items).toEqual([expect.objectContaining({ job_id: '0xsig1', status_label: '付费中', trial: false, pushes: 1 })]);
  });
  it('one-time products list orders with request text, state label and delivery summary', async () => {
    const { hub } = setup();
    const v = await hub.customers('asset_horizon');
    expect(v.items[0]).toMatchObject({ job_id: '0xa3', state_label: '已拒单', delivered_at: null });
    const a1 = v.items.find((x) => x.job_id === '0xa1')!;
    expect(a1).toMatchObject({ buyer_agent_id: '13529', request: '推荐短线 BTC ETH', state_label: '已交付', summary: 'BTC short ok' });
    expect(a1.delivered_at).toBeGreaterThan(0);
    await expect(hub.customers('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('pause', () => {
  it('paused services reject new orders, skip fan-out, and show as paused; resume restores', async () => {
    const { hub, registry, f } = setup();
    hub.start();
    await expect(Promise.resolve().then(() => hub.setPaused('market_intel', { paused: 'yes' }))).rejects.toMatchObject({ status: 400 });
    expect(hub.setPaused('market_intel', { paused: true })).toMatchObject({ key: 'market_intel', paused: true });
    hub.setPaused('asset_horizon', { paused: true });
    const intel = registry.get(`service:${INTEL_SID}`)!;
    expect(await intel.decide!(ptask({ kind: 'subscription', service_id: INTEL_SID }), {} as never)).toEqual({ accept: false, reason: PAUSE_REASON });
    const asset = registry.get(`service:${ASSET_SID}`)!;
    expect(await asset.decide!(ptask({ kind: 'one_time', service_id: ASSET_SID }), {} as never)).toEqual({ accept: false, reason: PAUSE_REASON });
    // 扇出:暂停的服务整体跳过(连订阅者都不查)
    expect(hub.subscriptionServices().find((x) => x.service_id === INTEL_SID)).toMatchObject({ paused: true });
    f.calls.length = 0; await hub.broadcaster.tick();
    expect(f.calls.filter((c) => c[1] === 'subscribe-active')).toHaveLength(1); // 只剩 micro_alerts
    expect((await hub.products()).products.find((p) => p.key === 'market_intel')!.status).toBe('paused');
    hub.setPaused('market_intel', { paused: false });
    expect(await intel.decide!(ptask({ kind: 'subscription', service_id: INTEL_SID }), {} as never)).toEqual({ accept: true });
    expect(hub.pausedMap()).toEqual({ asset_horizon: true });
  });
  it('wraps the strategy-signal handler registered by agent.ts and restores it on stop', async () => {
    const { hub, registry } = setup();
    const orig: ProviderHandler = { produce: async () => ({ text: 'welcome' }) };
    registry.set(`service:${SIGNAL_SID}`, orig);
    hub.start();
    const wrapped = registry.get(`service:${SIGNAL_SID}`)!;
    expect(wrapped).not.toBe(orig);
    expect(await wrapped.decide!(ptask({ service_id: SIGNAL_SID }), {} as never)).toEqual({ accept: true });
    hub.setPaused('strategy_signal', { paused: true });
    expect(await wrapped.decide!(ptask({ service_id: SIGNAL_SID }), {} as never)).toEqual({ accept: false, reason: PAUSE_REASON });
    expect(await wrapped.produce(ptask({}), {} as never)).toEqual({ text: 'welcome' });
    await hub.stop();
    expect(registry.get(`service:${SIGNAL_SID}`)).toBe(orig);
  });
});

describe('draft and apply (fake CLI only)', () => {
  it('draft merges online fields, runs local check + validate-listing, never writes', async () => {
    const { hub, f } = setup();
    const d = await hub.draft('market_intel', { price: '12' });
    expect(d.service_payload).toEqual({ operation: 'update', id: 41036, serviceName: 'Market Intel 市场情报', serviceDescription: 'line1\nline2\nline3', serviceType: 'A2A', fee: '', subscription: [{ interval: 'month', fee: '12' }], freeTrial: '72' });
    expect(d.validate).toEqual({ pass: true, findings: [] });
    expect(d.warns[0]).toBe(REVIEW_NOTICE);
    expect(d.diff.price).toEqual({ from: '9.9', to: '12', changed: true });
    const v = f.calls.find((c) => c[1] === 'validate-listing')!;
    expect(v.slice(0, 4)).toEqual(['agent', 'validate-listing', '--role', 'asp']);
    expect(JSON.parse(v[5]!)).toEqual([d.service_payload]);
    expect(f.calls.some((c) => c[1] === 'update')).toBe(false);
    const sig = await hub.draft('strategy_signal', { description: ['新的核心能力', '无需提供参数。', ''] });
    expect(sig.service_payload).toMatchObject({ operation: 'update', id: 40888, fee: '', subscription: [{ interval: 'month', fee: '1' }], freeTrial: '72', serviceDescription: '新的核心能力\n无需提供参数。' });
    const one = await hub.draft('asset_horizon', { price: '0.8' });
    expect(one.service_payload).toMatchObject({ id: 41038, fee: '0.8', subscription: [] });
    expect(one.service_payload).not.toHaveProperty('freeTrial');
    const create = await hub.draft('research_full', {});
    expect(create.service_payload).toMatchObject({ operation: 'create', fee: '15' });
    expect(create.warns.join('\n')).toContain('还没上架');
    await expect(hub.draft('market_intel', { price: '1.234' })).rejects.toMatchObject({ status: 400 });
    await expect(hub.draft('market_intel', { description: ['a', 'b'] })).rejects.toMatchObject({ status: 400 });
  });
  it('local findings and CLI findings are merged; diagnostic codes are not exposed', async () => {
    const { hub, f } = setup();
    f.validate = { pass: false, findings: [{ field: 'service[0].servicedescription', code: 'D6', severity: 'block', message: 'remove the link' }] };
    const d = await hub.draft('market_intel', { description: ['see https://x.io now', '', ''] });
    expect(d.validate.pass).toBe(false);
    expect(d.validate.findings).toEqual([expect.objectContaining({ field: 'local', message: expect.stringContaining('URL') }), { field: 'service[0].servicedescription', severity: 'block', message: 'remove the link' }]);
  });
  it('apply requires confirm, rejects mismatched payloads, revalidates, then runs agent update once', async () => {
    const { hub, f } = setup();
    const d = await hub.draft('market_intel', { price: '12' });
    await expect(hub.apply('market_intel', { service_payload: d.service_payload })).rejects.toMatchObject({ status: 400, code: 'confirm_required' });
    await expect(hub.apply('market_intel', { confirm: true, service_payload: { ...d.service_payload, id: 40888 } })).rejects.toMatchObject({ status: 409, code: 'payload_mismatch' });
    await expect(hub.apply('market_intel', { confirm: true, service_payload: { ...d.service_payload, serviceName: 'Renamed Service' } })).rejects.toMatchObject({ status: 400 });
    await expect(hub.apply('market_intel', { confirm: true, service_payload: { ...d.service_payload, endpoint: 'https://x' } })).rejects.toMatchObject({ status: 400 });
    await expect(hub.apply('market_intel', { confirm: true, service_payload: { ...d.service_payload, fee: '3' } })).rejects.toMatchObject({ status: 400 });
    f.validate = { pass: false, findings: [{ field: 'x', code: 'S1', severity: 'block', message: 'bad name' }] };
    await expect(hub.apply('market_intel', { confirm: true, service_payload: d.service_payload })).rejects.toMatchObject({ status: 409, code: 'validate_failed' });
    expect(f.calls.some((c) => c[1] === 'update')).toBe(false);
    f.validate = { pass: true, findings: [] };
    const r = await hub.apply('market_intel', { confirm: true, service_payload: d.service_payload });
    expect(r).toMatchObject({ ok: true, key: 'market_intel', tx_hash: '0x' + 'ab'.repeat(32), notice: REVIEW_NOTICE });
    const updates = f.calls.filter((c) => c[1] === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.slice(0, 5)).toEqual(['agent', 'update', '--agent-id', '13866', '--service']);
    expect(JSON.parse(updates[0]![5]!)).toEqual([d.service_payload]);
    // 提交后 service-list 缓存作废,价格记进本地配置
    const before = f.calls.filter((c) => c[1] === 'service-list').length;
    await hub.products();
    expect(f.calls.filter((c) => c[1] === 'service-list').length).toBe(before + 1);
    expect(hub.prices()).toMatchObject({ market_intel: '12' });
  });
  it('findTxHash reads txHash keys or any 32-byte hex', () => {
    expect(findTxHash({ ok: true, data: { txHash: '0x12' } })).toBe('0x12');
    expect(findTxHash({ ok: true, data: { text: `✓ done 0x${'cd'.repeat(32)}` } })).toBe(`0x${'cd'.repeat(32)}`);
    expect(findTxHash({ ok: true })).toBeNull();
  });
});

describe('buyer subscriptions display', () => {
  const now = Date.UTC(2026, 8, 25, 12);
  const s = (o: Record<string, unknown>) => ({ jobId: '0x1', statusName: 'ACTIVE', trialType: 0, autoRenew: 1, ...o });
  it('groups active → trial → pending → cancelled_trial → ended', () => {
    const sec = (ms: number) => Math.floor(ms / 1000);
    expect(subscriptionDisplay(s({ subEndTime: sec(now + 86_400_000 * 10) }), now)).toMatchObject({ group: 'active', until: sec(now + 86_400_000 * 10) * 1000 });
    expect(subscriptionDisplay(s({ trialType: 1, autoRenew: 1, trialEndTime: sec(now + 30 * 3_600_000) }), now)).toMatchObject({ group: 'trial', label: '试用中 · 剩 1 天 6 小时 · 到期转付费' });
    expect(subscriptionDisplay(s({ statusName: 'CREATED' }), now)).toMatchObject({ group: 'pending', label: '等待服务方接单' });
    expect(subscriptionDisplay(s({ trialType: 1, autoRenew: 0, trialEndTime: sec(now + 3_600_000) }), now)).toMatchObject({ group: 'trial', label: '试用中 · 剩 1 小时 · 到期不续费' });
    expect(subscriptionDisplay(s({ autoRenew: 0, subEndTime: sec(now + 86_400_000) }), now)).toMatchObject({ group: 'active', label: expect.stringContaining('已关闭续费') });
    expect(subscriptionDisplay(s({ statusName: 'CLOSED', trialType: 1, autoRenew: 0, subEndTime: sec(now + 3_600_000) }), now)).toMatchObject({ group: 'cancelled_trial', label: expect.stringContaining('已取消 · 试用至') });
    expect(subscriptionDisplay(s({ statusName: 'CLOSED', trialType: 1, autoRenew: 0 }), now)).toMatchObject({ group: 'ended', label: '已结束' });
    expect(subscriptionDisplay(null, now)).toMatchObject({ group: 'ended' });
  });
  it('subscriptions() returns display and sorts by group then start time desc', async () => {
    const st = store();
    const rows = [
      { jobId: '0xend', statusName: 'CLOSED', trialType: 0, autoRenew: 0, subStartTime: NOW_S - 10 },
      { jobId: '0xcancel', statusName: 'CLOSED', trialType: 1, autoRenew: 0, trialStartTime: NOW_S - 5, subEndTime: NOW_S + 3600 },
      { jobId: '0xtrial', statusName: 'ACTIVE', trialType: 1, autoRenew: 1, trialStartTime: NOW_S - 4, trialEndTime: NOW_S + 3600 },
      { jobId: '0xpaid_old', statusName: 'ACTIVE', trialType: 0, autoRenew: 1, subStartTime: NOW_S - 1000 },
      { jobId: '0xpaid_new', statusName: 'ACTIVE', trialType: 0, autoRenew: 1, subStartTime: NOW_S - 100 },
      { jobId: '0xpending', statusName: 'CREATED', trialType: 0 },
    ];
    const rt = { store: st, followSettings: structuredClone(DEFAULT_MARKET_SETTINGS), okxAspRunCli: (async () => ok({ list: rows })) as CliRunner, okxAspReadQueue: null, emit: () => {}, activity: () => {}, log: () => {}, modelConnections: () => ({ frozenDecision: () => null }), setWorkflow() {}, okxAspFeed: () => ({ traderOf: () => 'ASP' }) };
    const a = new AspAgent(rt as unknown as DemoRuntime, () => 'session');
    try {
      const r = await a.subscriptions();
      expect(r.subscriptions.map((x) => x.job_id)).toEqual(['0xpaid_new', '0xpaid_old', '0xtrial', '0xpending', '0xcancel', '0xend']);
      expect(r.subscriptions.map((x) => x.display.group)).toEqual(['active', 'active', 'trial', 'pending', 'cancelled_trial', 'ended']);
    } finally { await a.services.stop(); }
  });
});
