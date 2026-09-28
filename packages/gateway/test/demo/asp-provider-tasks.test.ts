import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { MarketCli, setNetworkBackoffForTest, type CliRunner } from '../../src/demo/asp-agent/cli.js';
import { ProviderTaskPoller, ensureBuyerSession, registerProviderHandler, resolveProviderHandler, type ProviderRegistry } from '../../src/demo/asp-agent/provider-tasks.js';
import { formatSignalText, renderDeliverable, signalPrice, validateSignalText, type PublishEvent } from '../../src/demo/asp-agent/publisher.js';
import { DEFAULT_MARKET_SETTINGS, DEFAULT_PUBLISHER_SETTINGS } from '../../src/demo/asp-agent/settings.js';
import { AspAgent, DEFAULT_SIGNAL_SERVICE_ID, parseClaimableText } from '../../src/demo/asp-agent/agent.js';
import { parseTextSignal } from '../../src/demo/asp-agent/inbox.js';
import type { DemoRuntime } from '../../src/demo/runtime.js';

const states: StateDb[] = [];
afterEach(() => { for (const s of states.splice(0)) s.close(); });
function store() { const s = openStateDb(':memory:'); states.push(s); return new DemoStore(s); }
const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data: v }), stderr: '' });
const now = 1800000000000;
const CLAIMABLE = 'claimable rewards (account=0xc133, agentId=13866)\n    USDT                           0.000000  (token=0x779ded0c9e1022225f8e0630b35a9b54be713736)\n    OKB                0.000000000000000000  (token=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)\n\n(No pending rewards at this time)\n';
setNetworkBackoffForTest(0);

describe('asp claimable text output', () => {
  it('parses the human-readable claimable table', () => {
    expect(parseClaimableText(CLAIMABLE)).toMatchObject({ amount: '0.000000', currency: 'USDT', pending: false, rewards: [{ symbol: 'USDT' }, { symbol: 'OKB' }] });
    expect(parseClaimableText('USDT 1.5 (token=0x1)\nclaimable rewards')).toMatchObject({ amount: '1.5', pending: true });
    expect(parseClaimableText('garbage')).toBeNull();
  });
  function agent(runner: CliRunner) {
    const s = store(); s.kvSet('market.asp_identity', JSON.stringify({ at: Date.now(), value: { buyer: null, asp: { agentId: '13866', roleLabel: 'ASP' } } }));
    const rt = { store: s, followSettings: structuredClone(DEFAULT_MARKET_SETTINGS), okxAspRunCli: runner, okxAspReadQueue: null, emit: () => {}, activity: () => {}, log: () => {}, setWorkflow() {}, okxAspFeed: () => ({ traderOf: () => 'ASP' }) };
    return new AspAgent(rt as unknown as DemoRuntime, () => 'session');
  }
  it('GET /api/market/asp view survives a plain-text or failing claimable call', async () => {
    const view = await agent(async (_b, args) => args[1] === 'asp-claimable' ? { code: 0, stdout: CLAIMABLE, stderr: '' } : ok({ list: [] })).asp();
    expect(view.claimable).toMatchObject({ amount: '0.000000', currency: 'USDT', pending: false });
    expect(view.services).toEqual({ list: [] });
    const failed = await agent(async (_b, args) => args[1] === 'asp-claimable' ? { code: 1, stdout: '', stderr: 'boom' } : ok({ list: [] })).asp();
    expect(failed.claimable).toBeNull(); expect(failed).toMatchObject({ claimable_error: expect.stringContaining('收益查询暂不可用') }); expect(failed.active).toEqual({ list: [] });
  });
  it('claim with nothing pending returns claimed:false instead of a format error', async () => {
    const r = await agent(async () => ({ code: 0, stdout: CLAIMABLE, stderr: '' })).claim();
    expect(r).toMatchObject({ claimed: false, pending: false });
  });
});

describe('signal text compliance', () => {
  const e = (patch: Partial<PublishEvent> = {}): PublishEvent => ({ event_id: 'e1', kind: 'strategy_signal', signal_time: now, symbol: 'BTCUSDT', direction: 'long', price: '64120', stop_loss: '63400', take_profit: ['65200', '66100'], reason: 'RSI 回踩 / pullback', thread_id: null, realized_r: null, backend: 'okx', paper: false, market: 'perp', leverage: 3, valid_until: now + 4 * 3600_000, strategy: { id: 's', name: '趋势回踩', version: 1, timeframe: '1h', run_id: 'r' }, signal_only: true, ...patch });
  it('executable signals are one ≤200-char line with a type header', () => {
    const text = formatSignalText(e());
    expect(text).toBe('【Futures】BTC-USDT-SWAP | LONG 3x | Market | Reference Price 64120 | Stop Loss 63400 | Take Profit 65200 | Valid for 4h | Trading Swarm strategy 1h');
    expect(validateSignalText(text)).toEqual({ ok: true, executable: true, errors: [] });
    expect(formatSignalText(e({ market: 'spot', entry_type: 'limit' }))).toMatch(/^【Spot】OKX \| BTC-USDT \| BUY \| Limit \| Order Price 64120 USDT/);
    expect(renderDeliverable(e(), DEFAULT_PUBLISHER_SETTINGS).text).toBe(text);
    // 自家买方收件解析器认得这个格式
    expect(parseTextSignal(text, now)).toMatchObject({ symbol: 'BTC-USDT-SWAP', action: 'LONG', entry: ['64120'], stop_loss: '63400', take_profit: ['65200'], leverage: '3', valid_until: now + 4 * 3600_000 });
  });
  it('analysis/paper become non-executable service messages; long reasons are clipped', () => {
    const text = formatSignalText(e({ signal_only: false, paper: true, backend: 'paper', reason: '很长的理由'.repeat(80) }));
    expect(text.startsWith('Service message:')).toBe(true); expect([...text].length).toBeLessThanOrEqual(200);
    expect(validateSignalText(text)).toMatchObject({ ok: true, executable: false });
    expect(validateSignalText('交易信号 / Trade signal · BTC {"a":1}').ok).toBe(false);
    expect(validateSignalText('【Futures】BTC | 稳赚').ok).toBe(false);
  });
});

describe('provider task poller', () => {
  function setup(opts: { status?: number; kind?: string; serviceId?: string; accept?: 'ok' | 'fail' | 'connect' | 'net-after' | 'expired'; deliver?: 'ok' | 'fail'; session?: boolean; strict?: string } = {}) {
    const s = store(); const calls: string[][] = []; let remote = opts.status ?? 0;
    const registry: ProviderRegistry = new Map();
    const runner: CliRunner = async (_bin, args) => {
      calls.push(args);
      const cmd = args[1] === 'asp' ? `asp ${args[2]}` : args[1];
      const name = ['CREATED', 'ACCEPTED', 'SUBMITTED', 'REFUSED'][remote] ?? 'EXPIRED';
      // 4.6.2 真实形状:status 是名字、数字在 statusCode;list-tasks 不带 serviceId(订阅从 provider my-subscriptions 补,按次从 agent status 找)
      if (cmd === 'asp list-tasks') return ok({ decision: 'ready', payload: { items: [{ jobId: 'job1', taskType: opts.kind ?? 'subscription', status: name, statusCode: remote, statusLabel: 'x', userAgentId: '777', userName: null, testFlag: true }], hasMore: false } });
      if (cmd === 'asp status') return ok({ payload: { task: { jobId: 'job1', status: name, statusCode: remote } } });
      if (cmd === 'my-subscriptions') return ok({ list: [{ jobId: 'job1', serviceId: opts.serviceId ?? 'svc-signal', buyerAgentId: '777', providerAgentId: '13866', status: remote }] });
      // 4.6.2 `agent status` 是纯文本,只有描述没有 serviceId
      if (cmd === 'status') return { code: 0, stdout: 'Task status: Awaiting ASP acceptance\n  jobId:    job1\n  title:    t\n  description: 回测 BTC 4h 突破\n  budget:   2 USDT\n', stderr: '' };
      if (cmd === 'accept-subscription' || cmd === 'accept-job-by-provider') {
        if (opts.accept === 'fail') return { code: 1, stdout: JSON.stringify({ ok: false, error: 'backend said no' }), stderr: '' };
        if (opts.accept === 'expired') return { code: 1, stdout: JSON.stringify({ ok: false, error: 'acceptSubscription failed or returned an unknown network result: Wallet API error (code=1001): subscribe accept window expired' }), stderr: '' };
        if (opts.accept === 'connect') return { code: 1, stdout: JSON.stringify({ ok: false, error: 'Network unavailable: error sending request (Connect): tls handshake eof' }), stderr: '' };
        if (opts.accept === 'net-after') { remote = 1; return { code: 1, stdout: JSON.stringify({ ok: false, error: 'Network unavailable: connection reset' }), stderr: '' }; }
        remote = 1; return ok({ txHash: '0xabc' });
      }
      if (cmd === 'deliver') return opts.deliver === 'fail' ? { code: 1, stdout: JSON.stringify({ ok: false, error: 'weird' }), stderr: '' } : ok({ delivered: true });
      if (cmd === 'decline-subscription' || cmd === 'decline-job-by-provider') { remote = 3; return ok({ declined: true }); }
      return ok({});
    };
    const sessions: string[][] = [];
    const dir = mkdtempSync(join(tmpdir(), 'tg-poller-')), lockPath = join(dir, 'lock'), eventLogPath = join(dir, 'llm.log');
    // 守护进程事件日志:按次单的 serviceId / serviceParams 只在 job_asp_selected 系统事件里
    writeFileSync(eventLogPath, opts.kind !== 'one_time' ? '' : `triggerContentPreview:\n${JSON.stringify({ agentId: '13866', message: { event: 'job_asp_selected', source: 'system', jobId: 'job1', serviceId: opts.serviceId ?? 'svc-signal', serviceParams: '{"tier":"quick"}', clientAgentId: '777' } })}\n${JSON.stringify({ agentId: '999', message: { event: 'job_asp_selected', source: 'system', jobId: 'jobX', serviceId: 'other' } })}\n`);
    const poller = new ProviderTaskPoller({ store: s, cli: new MarketCli(runner), aspId: async () => '13866', ensureSession: async (job, asp, buyer) => { sessions.push([job, asp, String(buyer)]); return opts.session !== false; }, log: () => {}, emit: () => {}, registry, lockPath, eventLogPath, now: () => now, ...(opts.strict ? { strictSignalService: () => opts.strict! } : {}) });
    return { s, calls, poller, registry, sessions, lockPath, opts, setRemote: (n: number) => { remote = n; }, cmds: () => calls.map((a) => a[1] === 'asp' ? `asp ${a[2]}` : a[1]!) };
  }
  it('accepts a new subscription once and immediately delivers the service handler output', async () => {
    const t = setup(); registerProviderHandler('service:svc-signal', { produce: async () => ({ text: '【Futures】BTC-USDT-SWAP | LONG 1x | Market | Reference Price 1 | Valid for 1h' }) }, t.registry);
    await t.poller.tick();
    expect(t.cmds()).toEqual(['asp list-tasks', 'my-subscriptions', 'asp status', 'accept-subscription', 'asp status', 'deliver']);
    expect(t.sessions).toEqual([['job1', '13866', '777']]);
    expect(t.poller.row('job1')).toMatchObject({ state: 'delivered', accept_attempts: 1, deliver_attempts: 1, test_flag: true, handler_key: 'service:svc-signal' });
    await t.poller.tick(); expect(t.cmds().filter((c) => c === 'accept-subscription' || c === 'deliver')).toHaveLength(2);
  });
  it('accept not yet confirmed on-chain: no deliver this tick, delivers next tick; a not-accepted-yet rejection is retryable', async () => {
    const t = setup(); registerProviderHandler('service:svc-signal', { produce: async () => ({ text: '【Futures】BTC-USDT-SWAP | LONG 1x | Market | Valid for 1h' }) }, t.registry);
    const orig = t.poller as unknown as { deps: { cli: MarketCli } };
    const inner = orig.deps.cli.runner; let lag = true;
    (orig.deps.cli as unknown as { runner: CliRunner }).runner = async (b, a) => { const r = await inner(b, a); if (lag && a[1] === 'accept-subscription') t.setRemote(0); return r; };
    await t.poller.tick();
    expect(t.cmds()).not.toContain('deliver'); expect(t.poller.row('job1')).toMatchObject({ state: 'accepted' });
    lag = false; t.setRemote(1); await t.poller.tick();
    expect(t.poller.row('job1')).toMatchObject({ state: 'delivered', deliver_attempts: 1 });
  });
  it('delivers follow_up texts after the main signal line, in order, only once', async () => {
    const t = setup(); registerProviderHandler('service:svc-signal', { produce: async () => ({ text: '【Futures】BTC-USDT-SWAP | Market brief | x | Info only, no order', follow_up: ['detail 1', 'detail 2'] }) }, t.registry);
    await t.poller.tick();
    expect(t.calls.filter((a) => a[1] === 'deliver').map((a) => a[4])).toEqual(['【Futures】BTC-USDT-SWAP | Market brief | x | Info only, no order', 'detail 1', 'detail 2']);
    expect(t.poller.row('job1')).toMatchObject({ state: 'delivered', deliver_attempts: 1 });
    await t.poller.tick(); expect(t.calls.filter((a) => a[1] === 'deliver')).toHaveLength(3);
  });
  it('without a handler for the service it records no_handler and never accepts (no type fallback for other services)', async () => {
    const t = setup({ serviceId: 'svc-intel' }); registerProviderHandler('service:svc-signal', { produce: async () => ({ text: 'x' }) }, t.registry);
    await t.poller.tick();
    expect(t.cmds()).toEqual(['asp list-tasks', 'my-subscriptions']); expect(t.poller.row('job1')).toMatchObject({ state: 'no_handler', service_id: 'svc-intel' });
    registerProviderHandler('service:svc-intel', { produce: async () => ({ text: 'Service message: intel' }) }, t.registry);
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'delivered' });
  });
  it('accept failure/unknown never delivers and is not retried inside the recheck window', async () => {
    const t = setup({ accept: 'fail' }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, t.registry);
    await t.poller.tick(); await t.poller.tick();
    expect(t.cmds().filter((c) => c === 'accept-subscription')).toHaveLength(1); expect(t.cmds()).not.toContain('deliver');
    expect(t.poller.row('job1')).toMatchObject({ state: 'accept_unknown' });
  });
  it('accept_unknown: after 2 minutes, remote still CREATED → one more accept; remote accepted → delivered', async () => {
    const t = setup({ accept: 'fail' }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, t.registry);
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'accept_unknown', accept_attempts: 1 });
    t.s.marketDb.prepare('UPDATE okx_market_provider_task SET updated_at=updated_at-180000').run();
    t.opts.accept = 'ok';
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'delivered', accept_attempts: 2 });
    // 第二次也失败就停在 accept_unknown,不再接
    const u = setup({ accept: 'fail' }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, u.registry);
    for (let i = 0; i < 3; i++) { await u.poller.tick(); u.s.marketDb.prepare('UPDATE okx_market_provider_task SET updated_at=updated_at-180000').run(); }
    expect(u.cmds().filter((c) => c === 'accept-subscription')).toHaveLength(2); expect(u.poller.row('job1')?.state).toBe('accept_unknown');
    // 超时其实已经生效:远端变成 1,直接收养并交付,不再接
    const v = setup({ accept: 'fail' }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, v.registry);
    await v.poller.tick(); v.setRemote(1); v.s.marketDb.prepare('UPDATE okx_market_provider_task SET updated_at=updated_at-180000').run();
    await v.poller.tick(); expect(v.cmds().filter((c) => c === 'accept-subscription')).toHaveLength(1); expect(v.poller.row('job1')).toMatchObject({ state: 'delivered' });
  });
  it('an expired accept window closes the task instead of leaving it unknown', async () => {
    const t = setup({ accept: 'expired' }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, t.registry);
    await t.poller.tick(); t.s.marketDb.prepare('UPDATE okx_market_provider_task SET updated_at=updated_at-180000').run(); await t.poller.tick();
    expect(t.poller.row('job1')?.state).toBe('closed'); expect(t.cmds().filter((c) => c === 'accept-subscription')).toHaveLength(1);
    // 旧版本留下的 accept_unknown(次数已用完、错误里写着窗口过期)回查时也关掉
    const u = setup({ accept: 'fail' }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, u.registry);
    await u.poller.tick(); u.s.marketDb.prepare("UPDATE okx_market_provider_task SET accept_attempts=2, error='Wallet API error (code=1001): subscribe accept window expired', updated_at=updated_at-180000").run();
    await u.poller.tick(); expect(u.poller.row('job1')?.state).toBe('closed');
  });
  it('a lost accept response is reconciled from the remote status and then delivered', async () => {
    const t = setup({ accept: 'net-after' }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, t.registry);
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'delivered' });
  });
  it('connect-phase accept failure retries at most once more', async () => {
    const t = setup({ accept: 'connect' }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, t.registry);
    for (let i = 0; i < 4; i++) await t.poller.tick();
    expect(t.cmds().filter((c) => c === 'accept-subscription').length).toBeLessThanOrEqual(2 * 3); // MarketCli 内部对「连接没建立」的写命令最多 3 次
    expect(t.poller.row('job1')?.state).toBe('accept_unknown'); expect(t.cmds()).not.toContain('deliver');
  });
  it('an already-accepted task (accepted elsewhere) is adopted and delivered once; deliver failure is not auto-resent', async () => {
    const t = setup({ status: 1, deliver: 'fail' }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, t.registry);
    await t.poller.tick(); await t.poller.tick();
    expect(t.cmds()).not.toContain('accept-subscription'); expect(t.cmds().filter((c) => c === 'deliver')).toHaveLength(1);
    expect(t.poller.row('job1')).toMatchObject({ state: 'deliver_unknown' });
  });
  it('non-compliant subscription text is not delivered; session failure defers delivery', async () => {
    const t = setup({ status: 1 }); registerProviderHandler('subscription', { produce: async () => ({ text: '交易信号 {json}' }) }, t.registry);
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'skipped' }); expect(t.cmds()).not.toContain('deliver');
    const u = setup({ status: 1, session: false }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, u.registry);
    await u.poller.tick(); expect(u.poller.row('job1')).toMatchObject({ state: 'accepted' }); expect(u.cmds()).not.toContain('deliver');
  });
  it('decide() can decline with a reason; one-time jobs use the job commands', async () => {
    const t = setup({ kind: 'one_time' }); registerProviderHandler('one_time', { decide: () => ({ accept: false, reason: '不在服务范围' }), produce: async () => ({ text: 'x' }) }, t.registry);
    await t.poller.tick(); expect(t.cmds()).toContain('decline-job-by-provider'); expect(t.poller.row('job1')).toMatchObject({ state: 'declined' });
  });
  it('machine-wide lock: a live foreign pid blocks polling', async () => {
    const t = setup(); writeFileSync(t.lockPath, String(process.ppid));
    expect(await t.poller.tick()).toMatchObject({ locked: true }); expect(t.calls).toHaveLength(0);
    writeFileSync(t.lockPath, '999999'); // 死进程的锁可以接管
    expect(await t.poller.tick()).not.toMatchObject({ locked: true });
    await t.poller.stop();
  });
  it('resolve prefers exact service over type key; ensureBuyerSession runs okx-a2a session create', async () => {
    const reg: ProviderRegistry = new Map(); const a = { produce: async () => ({ text: 'a' }) }; const b = { produce: async () => ({ text: 'b' }) };
    registerProviderHandler('subscription', a, reg); const off = registerProviderHandler('service:s1', b, reg);
    expect(resolveProviderHandler({ kind: 'subscription', service_id: 's1' }, reg)?.handler).toBe(b); off();
    expect(resolveProviderHandler({ kind: 'subscription', service_id: 's1' }, reg)?.handler).toBe(a);
    const seen: string[][] = [];
    expect(await ensureBuyerSession('job1', '777', { asp_id: '13866', runner: async (bin, args) => { seen.push([bin, ...args]); return { code: 0, stdout: '{}', stderr: '' }; } })).toBe(true);
    expect(seen[0]).toEqual(['okx-a2a', 'session', 'create', '--job-id', 'job1', '--my-agent-id', '13866', '--to-agent-id', '777', '--json']);
    expect(await ensureBuyerSession('job1', null, { asp_id: '13866' })).toBe(false);
  });
  it('one-time: serviceId/serviceParams from the daemon event log, buyer description from `agent status` text, both reach the handler', async () => {
    const t = setup({ kind: 'one_time', serviceId: 'svc-report' }); let seen: unknown = null;
    registerProviderHandler('service:svc-report', { decide: (task) => { seen = task.detail; return { accept: true }; }, produce: async (task) => ({ text: `report for ${String(task.detail?.['description'])} ${String(task.detail?.['serviceParams'])}` }) }, t.registry);
    await t.poller.tick();
    expect(seen).toMatchObject({ description: '回测 BTC 4h 突破', serviceParams: '{"tier":"quick"}' });
    expect(t.poller.row('job1')).toMatchObject({ state: 'delivered', service_id: 'svc-report', handler_key: 'service:svc-report' });
    expect(t.poller.row('job1')!.deliverable_text).toBe('report for 回测 BTC 4h 突破 {"tier":"quick"}');
    expect(t.poller.event('job1')).toMatchObject({ event: 'job_asp_selected', client_agent_id: '777' });
    expect(t.poller.event('jobX')).toBeNull(); // 别的 ASP 的事件不收
    await t.poller.tick(); expect(t.cmds().filter((c) => c === 'status')).toHaveLength(1); // 描述只取一次
  });
  it('the ≤200-char signal format check only applies to the strategy-signal service', async () => {
    const long = '【市场情报 / Market Intel】' + '分析'.repeat(300);
    const intel = setup({ serviceId: 'svc-intel', strict: 'svc-signal' });
    registerProviderHandler('service:svc-intel', { produce: async () => ({ text: long }) }, intel.registry);
    await intel.poller.tick(); expect(intel.poller.row('job1')).toMatchObject({ state: 'delivered' });
    const sig = setup({ serviceId: 'svc-signal', strict: 'svc-signal' });
    registerProviderHandler('service:svc-signal', { produce: async () => ({ text: long }) }, sig.registry);
    await sig.poller.tick(); expect(sig.poller.row('job1')).toMatchObject({ state: 'skipped', deliver_attempts: 0 });
  });
  it('reproduce re-runs produce once for an accepted, never-delivered skipped task, and refuses anything else', async () => {
    const t = setup({ serviceId: 'svc-intel' }); let text = 'x'.repeat(300);
    registerProviderHandler('service:svc-intel', { produce: async () => ({ text }) }, t.registry);
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'skipped', remote_status: 1, deliver_attempts: 0 });
    text = 'Service message: fixed';
    expect(await t.poller.reproduce('job1')).toMatchObject({ state: 'delivered', deliverable_text: 'Service message: fixed' });
    await expect(t.poller.reproduce('job1')).rejects.toThrow(/被跳过/);
    expect(t.cmds().filter((c) => c === 'accept-subscription')).toHaveLength(1);
  });
  it('retryDeliver fresh: only when remote is still accepted-not-submitted, then regenerates with current handler', async () => {
    const t = setup({ serviceId: 'svc-intel', deliver: 'fail' }); let text = 'Service message: v1';
    registerProviderHandler('service:svc-intel', { produce: async () => ({ text }) }, t.registry);
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'deliver_unknown', deliverable_text: 'Service message: v1' });
    text = 'Service message: v2';
    const r = await t.poller.retryDeliver('job1', { fresh: true });
    expect(r!.deliverable_text).toBe('Service message: v2');
  });
  it('one-time deliver_unknown: after 2 minutes, remote still accepted → auto re-deliver; remote submitted → delivered; subscriptions stay manual', async () => {
    const t = setup({ kind: 'one_time', serviceId: 'svc-report', deliver: 'fail' });
    registerProviderHandler('service:svc-report', { produce: async () => ({ text: 'report' }) }, t.registry);
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'deliver_unknown', deliver_attempts: 1 });
    await t.poller.tick(); expect(t.poller.row('job1')!.state).toBe('deliver_unknown'); // 未满 2 分钟不动
    t.s.marketDb.prepare('UPDATE okx_market_provider_task SET updated_at=updated_at-180000').run();
    t.opts.deliver = 'ok';
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'delivered', deliver_attempts: 2 });
    const sub = setup({ serviceId: 'svc-intel', deliver: 'fail' });
    registerProviderHandler('service:svc-intel', { produce: async () => ({ text: 'Service message: x' }) }, sub.registry);
    await sub.poller.tick(); sub.s.marketDb.prepare('UPDATE okx_market_provider_task SET updated_at=updated_at-180000').run();
    await sub.poller.tick(); expect(sub.poller.row('job1')!.state).toBe('deliver_unknown');
  });
  it('one-time deliver_unknown whose remote shows submitted is recorded as delivered without resending', async () => {
    const t = setup({ kind: 'one_time', serviceId: 'svc-report', deliver: 'fail' });
    registerProviderHandler('service:svc-report', { produce: async () => ({ text: 'report' }) }, t.registry);
    await t.poller.tick(); t.setRemote(2); t.s.marketDb.prepare('UPDATE okx_market_provider_task SET updated_at=updated_at-180000').run();
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'delivered', deliver_attempts: 1 });
  });
});

describe('signal prices', () => {
  it('rounds engine floats in signal lines by magnitude and keeps short prices as given', () => {
    expect([signalPrice('120.14060717822389'), signalPrice('64120'), signalPrice('0.123456789'), signalPrice('3435.55'), signalPrice(null)]).toEqual(['120.141', '64120', '0.123457', '3435.55', null]);
  });
});
describe('AspAgent welcome signal', () => {
  it('registers only on the strategy-signal serviceId and falls back to a status message', async () => {
    const s = store();
    const rt = { store: s, followSettings: structuredClone(DEFAULT_MARKET_SETTINGS), okxAspRunCli: async () => ok({}), okxAspReadQueue: null, emit: () => {}, activity: () => {}, log: () => {}, setWorkflow() {}, okxAspFeed: () => ({ traderOf: () => 'ASP' }), strategyRuns: () => ({ store: { list: () => [{ status: 'running', publish_asp: true, strategy_name: '趋势回踩', timeframe: '15m', symbols: ['BTCUSDT'], next_scan_at: now + 600_000 }] } }) };
    const a = new AspAgent(rt as unknown as DemoRuntime, () => 'session');
    expect(resolveProviderHandler({ kind: 'subscription', service_id: DEFAULT_SIGNAL_SERVICE_ID })).not.toBeNull();
    expect(resolveProviderHandler({ kind: 'subscription', service_id: 'other-service' })).toBeNull();
    const text = a.welcomeText(now);
    // 无有效信号时发状态信号行:带类型头(审核算作信号),不含方向和价格
    expect(text).toMatch(/^【Futures】BTC-USDT-SWAP \| No active setup \| Strategy 15m scanning \| Next scan .* UTC \| Status only, no order/); expect(validateSignalText(text)).toMatchObject({ ok: true, executable: true });
    s.marketDb.prepare('INSERT INTO okx_market_delivery_out VALUES (?,?,?,?,?,?,?,?)').run('ev1', now - 60_000, JSON.stringify({ event_id: 'ev1', kind: 'strategy_signal', signal_time: now - 60_000, symbol: 'ETHUSDT', direction: 'short', price: '2500', stop_loss: '2600', take_profit: ['2300'], reason: 'r', thread_id: null, realized_r: null, backend: 'okx', paper: false, market: 'perp', leverage: 2, valid_until: now + 3600_000, signal_only: true }), '[]', 't', '{}', '13866', null);
    // 保活频道:6 小时内没有真实信号送达 → 推状态信号;有 → 不推
    const status = a.strategyStatusService().channels[0]!;
    const ctx = { now: () => now, state: { get: () => null, set: () => {} }, log: () => {} };
    expect(await status.tick(ctx)).toMatchObject({ channel: 'strategy_status', signal: expect.stringMatching(/^【Futures】BTC-USDT-SWAP \| No active setup/) });
    s.marketDb.prepare("INSERT INTO okx_market_delivery_out_job(event_id,job_id,status,updated_at) VALUES ('ev1','j1','delivered',?)").run(now - 3_600_000);
    expect(await status.tick(ctx)).toBeNull();
    expect(a.welcomeText(now)).toMatch(/^【Futures】ETH-USDT-SWAP \| SHORT 2x \| Market \| Reference Price 2500 \| Stop Loss 2600 \| Take Profit 2300 \| Valid for 60min/);
  });
});
