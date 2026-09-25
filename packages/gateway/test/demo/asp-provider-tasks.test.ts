import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { MarketCli, setNetworkBackoffForTest, type CliRunner } from '../../src/demo/asp-agent/cli.js';
import { ProviderTaskPoller, ensureBuyerSession, registerProviderHandler, resolveProviderHandler, type ProviderRegistry } from '../../src/demo/asp-agent/provider-tasks.js';
import { formatSignalText, renderDeliverable, validateSignalText, type PublishEvent } from '../../src/demo/asp-agent/publisher.js';
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
    expect(text).toBe('【Futures】BTC-USDT-SWAP | LONG 3x | Market | Reference Price 64120 | Stop Loss 63400 | Take Profit 65200 | Valid for 4h | Trading Swarm 趋势回踩 1h');
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
  function setup(opts: { status?: number; kind?: string; serviceId?: string; accept?: 'ok' | 'fail' | 'connect' | 'net-after'; deliver?: 'ok' | 'fail'; session?: boolean } = {}) {
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
      if (cmd === 'status') return ok({ task: { jobId: 'job1', service: { serviceId: opts.serviceId ?? 'svc-signal' } } });
      if (cmd === 'accept-subscription' || cmd === 'accept-job-by-provider') {
        if (opts.accept === 'fail') return { code: 1, stdout: JSON.stringify({ ok: false, error: 'backend said no' }), stderr: '' };
        if (opts.accept === 'connect') return { code: 1, stdout: JSON.stringify({ ok: false, error: 'Network unavailable: error sending request (Connect): tls handshake eof' }), stderr: '' };
        if (opts.accept === 'net-after') { remote = 1; return { code: 1, stdout: JSON.stringify({ ok: false, error: 'Network unavailable: connection reset' }), stderr: '' }; }
        remote = 1; return ok({ txHash: '0xabc' });
      }
      if (cmd === 'deliver') return opts.deliver === 'fail' ? { code: 1, stdout: JSON.stringify({ ok: false, error: 'weird' }), stderr: '' } : ok({ delivered: true });
      if (cmd === 'decline-subscription' || cmd === 'decline-job-by-provider') { remote = 3; return ok({ declined: true }); }
      return ok({});
    };
    const sessions: string[][] = [];
    const lockPath = join(mkdtempSync(join(tmpdir(), 'tg-poller-')), 'lock');
    const poller = new ProviderTaskPoller({ store: s, cli: new MarketCli(runner), aspId: async () => '13866', ensureSession: async (job, asp, buyer) => { sessions.push([job, asp, String(buyer)]); return opts.session !== false; }, log: () => {}, emit: () => {}, registry, lockPath, now: () => now });
    return { s, calls, poller, registry, sessions, lockPath, cmds: () => calls.map((a) => a[1] === 'asp' ? `asp ${a[2]}` : a[1]!) };
  }
  it('accepts a new subscription once and immediately delivers the service handler output', async () => {
    const t = setup(); registerProviderHandler('service:svc-signal', { produce: async () => ({ text: '【Futures】BTC-USDT-SWAP | LONG 1x | Market | Reference Price 1 | Valid for 1h' }) }, t.registry);
    await t.poller.tick();
    expect(t.cmds()).toEqual(['asp list-tasks', 'my-subscriptions', 'asp status', 'accept-subscription', 'deliver']);
    expect(t.sessions).toEqual([['job1', '13866', '777']]);
    expect(t.poller.row('job1')).toMatchObject({ state: 'delivered', accept_attempts: 1, deliver_attempts: 1, test_flag: true, handler_key: 'service:svc-signal' });
    await t.poller.tick(); expect(t.cmds().filter((c) => c === 'accept-subscription' || c === 'deliver')).toHaveLength(2);
  });
  it('without a handler for the service it records no_handler and never accepts (no type fallback for other services)', async () => {
    const t = setup({ serviceId: 'svc-intel' }); registerProviderHandler('service:svc-signal', { produce: async () => ({ text: 'x' }) }, t.registry);
    await t.poller.tick();
    expect(t.cmds()).toEqual(['asp list-tasks', 'my-subscriptions']); expect(t.poller.row('job1')).toMatchObject({ state: 'no_handler', service_id: 'svc-intel' });
    registerProviderHandler('service:svc-intel', { produce: async () => ({ text: 'Service message: intel' }) }, t.registry);
    await t.poller.tick(); expect(t.poller.row('job1')).toMatchObject({ state: 'delivered' });
  });
  it('accept failure/unknown never delivers and is not retried', async () => {
    const t = setup({ accept: 'fail' }); registerProviderHandler('subscription', { produce: async () => ({ text: 'Service message: hi' }) }, t.registry);
    await t.poller.tick(); await t.poller.tick();
    expect(t.cmds().filter((c) => c === 'accept-subscription')).toHaveLength(1); expect(t.cmds()).not.toContain('deliver');
    expect(t.poller.row('job1')).toMatchObject({ state: 'accept_unknown' });
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
});

describe('AspAgent welcome signal', () => {
  it('registers only on the strategy-signal serviceId and falls back to a status message', async () => {
    const s = store();
    const rt = { store: s, followSettings: structuredClone(DEFAULT_MARKET_SETTINGS), okxAspRunCli: async () => ok({}), okxAspReadQueue: null, emit: () => {}, activity: () => {}, log: () => {}, setWorkflow() {}, okxAspFeed: () => ({ traderOf: () => 'ASP' }), strategyRuns: () => ({ store: { list: () => [{ status: 'running', publish_asp: true, strategy_name: '趋势回踩', timeframe: '15m', symbols: ['BTCUSDT'], next_scan_at: now + 600_000 }] } }) };
    const a = new AspAgent(rt as unknown as DemoRuntime, () => 'session');
    expect(resolveProviderHandler({ kind: 'subscription', service_id: DEFAULT_SIGNAL_SERVICE_ID })).not.toBeNull();
    expect(resolveProviderHandler({ kind: 'subscription', service_id: 'other-service' })).toBeNull();
    const text = a.welcomeText(now);
    expect(text).toMatch(/^Service message: .*趋势回踩 15m BTCUSDT.*Next scan/); expect(validateSignalText(text).ok).toBe(true);
    s.marketDb.prepare('INSERT INTO okx_market_delivery_out VALUES (?,?,?,?,?,?,?,?)').run('ev1', now - 60_000, JSON.stringify({ event_id: 'ev1', kind: 'strategy_signal', signal_time: now - 60_000, symbol: 'ETHUSDT', direction: 'short', price: '2500', stop_loss: '2600', take_profit: ['2300'], reason: 'r', thread_id: null, realized_r: null, backend: 'okx', paper: false, market: 'perp', leverage: 2, valid_until: now + 3600_000, signal_only: true }), '[]', 't', '{}', '13866', null);
    expect(a.welcomeText(now)).toMatch(/^【Futures】ETH-USDT-SWAP \| SHORT 2x \| Market \| Reference Price 2500 \| Stop Loss 2600 \| Take Profit 2300 \| Valid for 60min/);
  });
});
