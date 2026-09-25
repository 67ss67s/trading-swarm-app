import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import type { DemoRuntime } from '../../src/demo/runtime.js';
import { MarketCli, CliError, parseCliOutput, type CliRunner } from '../../src/demo/asp-agent/cli.js';
import { AspAgent, findJobId, normalizeJobId } from '../../src/demo/asp-agent/agent.js';
import { DEFAULT_MARKET_SETTINGS } from '../../src/demo/asp-agent/settings.js';
import { marketRoutes } from '../../src/demo/asp-agent/routes-market.js';
import type { RouteHandler } from '../../src/demo/http-extra.js';

const dbs: StateDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' });
const failed = (message: string) => ({ code: 1, stdout: JSON.stringify({ ok: false, message }), stderr: '' });
const hash = `0x${'ab'.repeat(32)}`;
const body = { service_id: 'svc', provider_agent_id: 'asp', fee_amount: '10', fee_token_address: '0x123', use_trial: true, auto_renew: false, mode: 'evidence', weight: 0.5 };
const sub = (patch: Record<string, unknown> = {}) => ({ jobId: hash, serviceId: 'svc', providerAgentId: 'asp', statusName: 'CREATED', trialType: 1, autoRenew: 0, deviceList: ['other-device'], ...patch });
function agent(runner: CliRunner) {
  const db = openStateDb(':memory:'); dbs.push(db);
  const store = new DemoStore(db);
  const rt = { store, followSettings: structuredClone(DEFAULT_MARKET_SETTINGS), okxAspRunCli: runner, okxAspReadQueue: null, emit: vi.fn(), activity: vi.fn(), setWorkflow(p: { follow: typeof DEFAULT_MARKET_SETTINGS }) { this.followSettings = p.follow; }, okxAspFeed: () => ({ traderOf: () => 'ASP' }) };
  return { a: new AspAgent(rt as unknown as DemoRuntime, () => 'test'), rt };
}

describe('market CLI protocol regression', () => {
  it('extracts one pretty envelope amid upgrade/progress text and a JSON log', async () => {
    const stdout = `\u001b[33mNew version available\u001b[0m\n{"progress":10}\n${JSON.stringify({ ok: true, data: { message: 'braces { inside "text" }', list: [] } }, null, 2)}\nDone`;
    expect(await new MarketCli(async () => ({ code: 0, stdout, stderr: 'upgrade advisory' })).call('my-subscriptions')).toMatchObject({ data: { list: [] } });
    expect(parseCliOutput('[{"jobId":"j1"}]')).toEqual({ data: [{ jobId: 'j1' }] });
    expect(() => parseCliOutput('{"ok":true}\n{"ok":false}')).toThrow();
  });
  it.each([1001, '1001'])('maps code %s even when the process exits zero', async (code) => {
    await expect(new MarketCli(async () => ({ code: 0, stdout: JSON.stringify({ code, message: 'upgrade first' }), stderr: '' })).call('my-subscriptions')).rejects.toMatchObject({ code: 'cli_update_required', raw_message: 'upgrade first', status: 503 });
  });
  it('recognizes nested upgrade code and preserves stderr diagnostics', async () => {
    const runner: CliRunner = async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: 1001, message: 'upgrade first' } }), stderr: 'CLI v4 trace' });
    await expect(new MarketCli(runner).call('my-subscriptions')).rejects.toMatchObject({ code: 'cli_update_required', status: 503, raw_message: 'upgrade first\nCLI v4 trace' });
  });
  it('preserves non-JSON stdout and stderr and classifies provider errors', async () => {
    await expect(new MarketCli(async () => ({ code: 1, stdout: 'RPC provider not online', stderr: 'trace detail' })).call('create-subscribe')).rejects.toMatchObject({ code: 'provider_offline', raw_message: 'RPC provider not online\ntrace detail', status: 409 });
    await expect(new MarketCli(async () => ({ code: 0, stdout: 'unexpected output', stderr: '' })).call('create-subscribe')).rejects.toMatchObject({ code: 'cli_invalid_json', raw_message: 'unexpected output', status: 502 });
  });
  it('uses write/read deadlines and never retries a timed-out write', async () => {
    const runner = vi.fn<CliRunner>(async () => ({ code: 124, stdout: '', stderr: 'deadline exceeded' }));
    const cli = new MarketCli(runner);
    await expect(cli.call('create-subscribe')).rejects.toMatchObject({ code: 'cli_timeout', status: 504 });
    expect(runner).toHaveBeenCalledExactlyOnceWith('onchainos', ['agent', 'create-subscribe'], 120_000);
    await expect(cli.call('my-subscriptions')).rejects.toMatchObject({ code: 'cli_timeout' });
    expect(runner.mock.calls[1]?.[2]).toBe(45_000);
  });
  it('serializes shared sessions across instances and recovers after rejection', async () => {
    let active = 0; let peak = 0; const commands: string[] = [];
    const runner: CliRunner = async (_bin, args) => {
      active++; peak = Math.max(peak, active); commands.push(args[1]!);
      await new Promise((resolve) => setTimeout(resolve, 1)); active--;
      if (args[1] === 'first') throw new Error('runner failed');
      return ok({ done: true });
    };
    const results = await Promise.allSettled([new MarketCli(runner).call('first'), new MarketCli(runner).call('second'), new MarketCli(runner).call('third')]);
    expect(peak).toBe(1); expect(commands).toEqual(['first', 'second', 'third']);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
  });
});

describe('subscription creation regression', () => {
  it('normalizes bytes32 job IDs and recursively extracts mixed-key nested results', () => {
    expect(normalizeJobId(hash.slice(2).toUpperCase())).toBe(hash);
    expect(normalizeJobId('opaque-ID')).toBe('opaque-ID');
    expect(findJobId({ payload: { nested: [{ Job_ID: hash.toUpperCase() }] } })).toBe(hash);
    expect(findJobId({ payload: { command: { jobId: '<jobId>' } } })).toBeNull();
  });
  it('fresh remote subscriptions defeat stale catalog duplicate submissions', async () => {
    let reads = 0;
    const runner = vi.fn<CliRunner>(async () => ok({ list: ++reads === 1 ? [] : [sub()] }));
    const { a } = agent(runner); await a.remoteSubscriptions();
    expect(await a.subscribe(body)).toMatchObject({ jobId: hash, already_subscribed: true });
    expect(runner.mock.calls.map((c) => c[1][1])).toEqual(['my-subscriptions', 'my-subscriptions']);
  });
  it.each([null, ['current'], ['other-device']])('duplicate responses report actual device configuration (%j)', async (deviceList) => {
    const runner = vi.fn<CliRunner>(async () => ok({ thisDeviceId: 'current', list: [sub({ deviceList })] }));
    const { a } = agent(runner); const configured = deviceList === null || deviceList.includes('current');
    expect(await a.subscribe(body)).toMatchObject({ jobId: hash, already_subscribed: true, configured, ...(configured ? {} : { error: expect.stringContaining('检查本机接收配置') }) });
    expect(runner).toHaveBeenCalledOnce();
  });
  it.each([failed('list unavailable'), ok({ unexpected: [] })])('blocks all writes when fresh subscription state is unavailable', async (response) => {
    const runner = vi.fn<CliRunner>(async () => response); const { a } = agent(runner);
    await expect(a.subscribe(body)).rejects.toThrow();
    expect(runner.mock.calls.map((c) => c[1][1])).toEqual(['my-subscriptions']);
  });
  it('execution preference failure stops creation without forcing a replacement preference', async () => {
    const runner = vi.fn<CliRunner>(async (_bin, args) => args[1] === 'my-subscriptions' ? ok({ list: [] }) : failed('execution preference exists'));
    const { a } = agent(runner); await expect(a.subscribe(body)).rejects.toMatchObject({ raw_message: 'execution preference exists' });
    expect(runner.mock.calls.map((c) => c[1][1])).toEqual(['my-subscriptions', 'subscription-execution-config-set']);
    expect(runner.mock.calls.flatMap((c) => c[1])).not.toContain('--replace');
  });
  it('serializes concurrent requests and creates exactly once', async () => {
    let created = false;
    const runner = vi.fn<CliRunner>(async (_bin, args) => {
      if (args[1] === 'my-subscriptions') return ok({ thisDeviceId: 'current', list: created ? [sub()] : [] });
      if (args[1] === 'create-subscribe') { created = true; return ok({ payload: { job: { jobId: hash } } }); }
      return ok({ done: true });
    });
    const { a } = agent(runner); const results = await Promise.all([a.subscribe(body), a.subscribe(body)]);
    expect(results[1]).toMatchObject({ already_subscribed: true });
    expect(runner.mock.calls.filter((c) => c[1][1] === 'create-subscribe')).toHaveLength(1);
  });
  it('bounds title to 30 code points, preserves config after device failure', async () => {
    let created = false;
    const runner = vi.fn<CliRunner>(async (_bin, args) => {
      if (args[1] === 'my-subscriptions') return ok({ thisDeviceId: 'current', list: created ? [sub()] : [] });
      if (args[1] === 'create-subscribe') { created = true; return ok({ payload: { job: { jobId: hash } } }); }
      return args[1] === 'subscribe-device-update' ? failed('device locked') : ok({ done: true });
    });
    const { a } = agent(runner);
    expect(await a.subscribe({ ...body, title: '试🚀'.repeat(30) })).toMatchObject({ jobId: hash, configured: false, error: expect.stringContaining('device locked') });
    expect(a.settings().subscriptions[hash]).toMatchObject({ mode: 'evidence', weight: 0.5, enabled: true });
    const argv = runner.mock.calls.find((c) => c[1][1] === 'create-subscribe')![1];
    expect([...argv[argv.indexOf('--title') + 1]!]).toHaveLength(30);
    expect(runner.mock.calls.filter((c) => c[1][1] === 'create-subscribe')).toHaveLength(1);
  });
  it.each([1, 2])('reconciles a missing jobId only with a unique new provider/service row (%s new)', async (count) => {
    let created = false; const old = sub({ jobId: 'old', statusName: 'CLOSED' });
    const runner = vi.fn<CliRunner>(async (_bin, args) => {
      if (args[1] === 'my-subscriptions') return ok({ thisDeviceId: 'current', list: [old, ...(created ? Array.from({ length: count }, (_, i) => sub({ jobId: i === 0 ? hash : 'second-new' })) : [])] });
      if (args[1] === 'create-subscribe') { created = true; return ok({ nextAction: 'configured' }); }
      return ok({ done: true });
    });
    const { a } = agent(runner);
    if (count === 1) expect(await a.subscribe(body)).toMatchObject({ jobId: hash, configured: true });
    else { await expect(a.subscribe(body)).rejects.toMatchObject({ status: 502, code: 'subscription_result_unknown', hint: expect.stringContaining('勿重复提交') }); expect(runner.mock.calls.some((c) => c[1][1] === 'subscribe-device-update')).toBe(false); }
    expect(runner.mock.calls.filter((c) => c[1][1] === 'create-subscribe')).toHaveLength(1);
  });
  it('a failed lookup after successful creation explains the unconfirmed result', async () => {
    let created = false;
    const runner = vi.fn<CliRunner>(async (_bin, args) => {
      if (args[1] === 'my-subscriptions') return created ? failed('lookup failed detail') : ok({ list: [] });
      if (args[1] === 'create-subscribe') created = true;
      return ok({ done: true });
    });
    const { a } = agent(runner); await expect(a.subscribe(body)).rejects.toMatchObject({ code: 'subscription_result_unknown', status: 502, hint: expect.stringContaining('勿重复提交'), raw_message: expect.stringContaining('lookup failed detail') });
    expect(runner.mock.calls.filter((c) => c[1][1] === 'create-subscribe')).toHaveLength(1);
  });
  it.each([null, ['current', 'other-device']])('enabling an already receiving device does not replace the device set (%j)', async (deviceList) => {
    const runner = vi.fn<CliRunner>(async () => ok({ thisDeviceId: 'current', list: [sub({ deviceList })] }));
    const { a } = agent(runner); expect(await a.devices(hash, true)).toMatchObject({ unchanged: true });
    expect(runner.mock.calls.map((c) => c[1][1])).toEqual(['my-subscriptions']);
  });
  it('merges a legacy uppercase configuration with the canonical remote job', async () => {
    const { a, rt } = agent(async () => ok({ list: [sub()] }));
    vi.spyOn(a, 'aspOf').mockReturnValue(null);
    rt.followSettings.subscriptions[hash.slice(2).toUpperCase()] = { mode: 'evidence', weight: 0.75, enabled: false, approval: 'manual' };
    const result = await a.subscriptions();
    expect(result.subscriptions).toHaveLength(1); expect(result.subscriptions[0]).toMatchObject({ job_id: hash, config: { weight: 0.75, enabled: false } });
  });
});

describe('subscription actions regression', () => {
  it('does not mutate a job absent from the buyer list', async () => {
    const runner = vi.fn<CliRunner>(async () => ok({ list: [] })); const { a } = agent(runner);
    await expect(a.subscriptionAction(hash, 'cancel', {})).rejects.toMatchObject({ status: 404 }); expect(runner).toHaveBeenCalledOnce();
  });
  it('enables autorenew with the canonical job ID and invalidates cached state', async () => {
    let enabled = false;
    const runner = vi.fn<CliRunner>(async (_bin, args) => {
      if (args[1] === 'my-subscriptions') return ok({ list: [sub({ statusName: 'ACTIVE', autoRenew: enabled ? 1 : 0 })] });
      enabled = true; return ok({ done: true });
    });
    const { a } = agent(runner); await a.subscriptionAction(hash.slice(2).toUpperCase(), 'autorenew', {});
    expect(runner.mock.calls[1]?.[1]).toEqual(['agent', 'start-autorenew', hash]);
    expect(await a.remoteSubscriptions()).toMatchObject({ list: [{ autoRenew: 1 }] });
    expect(runner).toHaveBeenCalledTimes(3);
  });
  it.each(['CLOSED', 'EXPIRED', 'COMPLETED', 'CANCELED'])('cancel %s is idempotent and returns current state', async (statusName) => {
    const runner = vi.fn<CliRunner>(async () => ok({ list: [sub({ statusName })] })); const { a } = agent(runner);
    expect(await a.subscriptionAction(hash.slice(2).toUpperCase(), 'cancel', {})).toMatchObject({ job_id: hash, unchanged: true, remote: { statusName } });
    expect(runner).toHaveBeenCalledOnce();
  });
  it.each([0, 1])('ACTIVE autoRenew=0 only skips paid cancellation (trialType=%s)', async (trialType) => {
    const runner = vi.fn<CliRunner>(async (_bin, args) => args[1] === 'my-subscriptions' ? ok({ list: [sub({ statusName: 'ACTIVE', trialType })] }) : ok({ done: true }));
    const { a } = agent(runner); await a.subscriptionAction(hash, 'cancel', {});
    expect(runner.mock.calls.map((c) => c[1][1])).toEqual(trialType === 0 ? ['my-subscriptions'] : ['my-subscriptions', 'subscribe-cancel']);
  });
  it('reconciles a cancellation race without retrying the mutation', async () => {
    let reads = 0;
    const runner = vi.fn<CliRunner>(async (_bin, args) => args[1] === 'my-subscriptions' ? ok({ list: [sub({ statusName: ++reads === 1 ? 'CREATED' : 'CLOSED' })] }) : failed('already cancelled'));
    const { a } = agent(runner); expect(await a.subscriptionAction(hash, 'cancel', {})).toMatchObject({ unchanged: true, remote: { statusName: 'CLOSED' } });
    expect(runner.mock.calls.map((c) => c[1][1])).toEqual(['my-subscriptions', 'subscribe-cancel', 'my-subscriptions']);
  });
  it('keeps the original failure if reconciliation also fails', async () => {
    let reads = 0;
    const runner = vi.fn<CliRunner>(async (_bin, args) => args[1] === 'my-subscriptions' ? (++reads === 1 ? ok({ list: [sub()] }) : failed('reread unavailable')) : failed('cancel rejected detail'));
    const { a } = agent(runner); await expect(a.subscriptionAction(hash, 'cancel', {})).rejects.toMatchObject({ raw_message: 'cancel rejected detail' });
  });
  it.each(['reject', 'autorenew'] as const)('prevents %s for terminal subscriptions', async (action) => {
    const runner = vi.fn<CliRunner>(async () => ok({ list: [sub({ statusName: 'CLOSED' })] })); const { a } = agent(runner);
    await expect(a.subscriptionAction(hash, action, { reason: 'not received' })).rejects.toMatchObject({ status: 409 }); expect(runner).toHaveBeenCalledOnce();
  });
  it.each(['reject', 'autorenew'] as const)('%s satisfied state is idempotent', async (action) => {
    const runner = vi.fn<CliRunner>(async () => ok({ list: [sub({ statusName: action === 'reject' ? 'REJECTED' : 'ACTIVE', autoRenew: 1 })] })); const { a } = agent(runner);
    expect(await a.subscriptionAction(hash, action, { reason: 'not received' })).toMatchObject({ unchanged: true }); expect(runner).toHaveBeenCalledOnce();
  });
  it('reject executes only the prepared matching request-refund context', async () => {
    const reason = 'signal missing';
    const runner = vi.fn<CliRunner>(async (_bin, args) => args[1] === 'my-subscriptions' ? ok({ list: [sub({ trialType: 0, statusName: 'ACTIVE' })] }) : args[1] === 'refund-prepare' ? ok({ payload: { capability: { clientOperation: 'request-refund' }, refundContextId: 'ctx1', request: { userReason: reason }, job: { jobId: hash.slice(2).toUpperCase() } } }) : ok({ done: true }));
    const { a } = agent(runner); await a.subscriptionAction(hash, 'reject', { reason });
    expect(runner.mock.calls[1]?.[1]).toEqual(['agent', 'refund-prepare', hash, '--reason', reason]);
    expect(runner.mock.calls[2]?.[1]).toEqual(['agent', 'refund-execute', hash, '--operation', 'request-refund', '--refund-context-id', 'ctx1', '--reason', reason, '--confirm']);
  });
  it.each(['operation', 'context', 'reason', 'job'])('reject blocks mismatched prepared %s without writing', async (mismatch) => {
    const refund = { capability: { clientOperation: mismatch === 'operation' ? 'cancel-trial' : 'request-refund' }, refundContextId: mismatch === 'context' ? '' : 'ctx', request: { userReason: mismatch === 'reason' ? 'different' : 'missing' }, job: { jobId: mismatch === 'job' ? 'other-job' : hash } };
    const runner = vi.fn<CliRunner>(async (_bin, args) => args[1] === 'my-subscriptions' ? ok({ list: [sub()] }) : ok({ payload: refund })); const { a } = agent(runner);
    await expect(a.subscriptionAction(hash, 'reject', { reason: 'missing' })).rejects.toMatchObject({ code: 'refund_not_available', status: 409 });
    expect(runner.mock.calls.some((c) => c[1][1] === 'refund-execute')).toBe(false);
  });
});

describe('market route response semantics', () => {
  async function request(result: unknown, error?: Error) {
    const routes = new Map<string, RouteHandler>(); let response: { status: number; body: unknown } | undefined;
    const { rt } = agent(async () => ok({ list: [] }));
    const runtime = { ...rt, marketAgent: () => ({ subscribe: async () => { if (error) throw error; return result; } }) };
    marketRoutes({ route: (method, path, handler) => { routes.set(`${method} ${path}`, handler); }, guarded: (fn) => fn, json: (_res, status, body) => { response = { status, body }; }, fail: () => {}, readBody: async () => body, rt: runtime as unknown as DemoRuntime, store: rt.store, oauth: null, emit: () => {} });
    await routes.get('POST /api/market/subscribe')!({} as IncomingMessage, {} as ServerResponse, new URL('http://localhost'), {});
    return response;
  }
  it('returns 200 for created subscription with device warning, not a failed transaction', async () => {
    const result = { jobId: hash, configured: false, error: 'device locked' };
    expect(await request(result)).toEqual({ status: 200, body: result });
  });
  it.each([409, 502, 503, 504])('keeps HTTP %s plus human hint and raw CLI failure', async (status) => {
    const error = new CliError('platform_error', 'original CLI detail', {}, status, '可读提示');
    expect(await request(null, error)).toEqual({ status, body: { error: { code: 'platform_error', message: '可读提示\noriginal CLI detail', hint: '可读提示', raw_message: 'original CLI detail' } } });
  });
});

describe('CLI 网络抖动重试', () => {
  const netErr = (msg: string) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: `Network unavailable — check your connection and try again: ${msg}` }), stderr: '' });
  const ok = { code: 0, stdout: JSON.stringify({ ok: true, data: { list: [] } }), stderr: '' };
  it('读操作遇到网络错误会重试直到成功', async () => {
    const { setNetworkBackoffForTest } = await import('../../src/demo/asp-agent/cli.js');
    setNetworkBackoffForTest(0);
    let n = 0;
    const cli = new MarketCli((async () => (++n < 3 ? netErr('error decoding response body') : ok)) as CliRunner);
    await expect(cli.call('my-subscriptions', ['--role', 'buyer'])).resolves.toMatchObject({ ok: true });
    expect(n).toBe(3);
  });
  it('写操作只在连接没建立时重试;发出后才断的不重发', async () => {
    const { setNetworkBackoffForTest } = await import('../../src/demo/asp-agent/cli.js');
    setNetworkBackoffForTest(0);
    let a = 0;
    const connectFail = new MarketCli((async () => (++a < 2 ? netErr('client error (Connect): tls handshake eof') : ok)) as CliRunner);
    await expect(connectFail.call('subscribe-cancel', ['0xabc'])).resolves.toMatchObject({ ok: true });
    expect(a).toBe(2);
    let b = 0;
    const midFail = new MarketCli((async () => { b++; return netErr('error decoding response body'); }) as CliRunner);
    await expect(midFail.call('subscribe-cancel', ['0xabc'])).rejects.toMatchObject({ code: 'network_unavailable' });
    expect(b).toBe(1);
  });
});

describe('CLI 成功时输出人话(非 JSON)', () => {
  it('subscribe-cancel 退出码 0 + ✓ 开头 = 已提交,不报格式错误', async () => {
    const cli = new MarketCli((async () => ({ code: 0, stdout: '✓ Subscription cancel in progress (transaction broadcast)\n  subId:  0xc46d83783073fce17eaeb4e34c113dc1\n', stderr: '' })) as CliRunner);
    const r = await cli.call('subscribe-cancel', ['0xc46d83783073fce17eaeb4e34c113dc1']);
    expect(r).toMatchObject({ ok: true, data: { pending: true } });
  });
  it('非 ✓ 的非 JSON 输出仍按无法确认处理', async () => {
    const cli = new MarketCli((async () => ({ code: 0, stdout: 'something weird', stderr: '' })) as CliRunner);
    await expect(cli.call('subscribe-cancel', ['0xabc'])).rejects.toMatchObject({ code: 'cli_invalid_json' });
  });
});
