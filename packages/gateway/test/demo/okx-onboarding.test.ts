import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OkxOnboarding, MCP_READ_ARGS } from '../../src/demo/okx-onboarding.js';
import { WalletStatus } from '../../src/demo/wallet-status.js';
import { onboardingRoutes } from '../../src/demo/routes-okx-onboarding.js';
import type { RouteContext, RouteHandler } from '../../src/demo/http-extra.js';
import type { OkxRunResult, OkxSpawnFn } from '../../src/demo/execution-okx.js';

const success = (data: unknown = {}): OkxRunResult => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' });
const status = () => ({ cli: '/fake/okx', profile: 'okx-demo', demo: true, available: true, note: null, version: '1.4.7', profiles: [{ name: 'okx-demo', demo: true, is_default: true }] });
const keys = { api_key: 'secret-api', secret_key: 'secret-signing', passphrase: 'secret-passphrase' };
const loggedIn = { loggedIn: true, email: 'test@example.test', loginType: 'google', currentAccountName: 'test', currentAccountId: 'id', accessToken: 'NEVER_RETURN' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('OKX setup (fake spawn only)', () => {
  it('传递精确 argv、默认 demo，并经 backend 只检查一次余额', async () => {
    const run = vi.fn<OkxSpawnFn>().mockResolvedValue({ code: 0, stdout: '[{"totalEq":"1"}]', stderr: '' });
    const reset = vi.fn();
    const kit = new OkxOnboarding({ run, reset, bin: () => '/fake/okx', status });
    expect(await kit.setup(keys)).toMatchObject({ ok: true, profile: 'okx-demo', demo: true, credentials_ok: true });
    expect(run.mock.calls).toEqual([
      ['/fake/okx', ['config', 'add-profile', 'AK=secret-api', 'SK=secret-signing', 'PP=secret-passphrase', 'demo=true', 'site=global', 'name=okx-demo', '--force'], 20_000],
      ['/fake/okx', ['--profile', 'okx-demo', '--demo', '--json', 'account', 'balance'], 15_000],
    ]);
    expect(reset).toHaveBeenCalledOnce();
  });
  it('live 仅执行只读 credential check，支持 site/name', async () => {
    const run = vi.fn<OkxSpawnFn>().mockResolvedValue({ code: 0, stdout: '[]', stderr: '' });
    const kit = new OkxOnboarding({ run, reset: () => {}, status });
    expect(await kit.setup({ ...keys, demo: false, site: 'eea', name: 'my-live' })).toMatchObject({ profile: 'my-live', demo: false });
    expect(run.mock.calls[0]![1]).toContain('site=eea');
    expect(run.mock.calls[1]![1]).toEqual(['--profile', 'my-live', '--json', 'account', 'balance']);
    expect(await kit.setup({ ...keys, demo: false })).toMatchObject({ profile: 'okx-live' });
  });
  it.each([{ api_key: '' }, { secret_key: '  ' }, { passphrase: 3 }, { demo: 'false' }, { site: 'moon' }, { site: null }, { name: null }, { name: '' }])('拒绝无效输入 %j，不 spawn', async invalid => {
    const run = vi.fn<OkxSpawnFn>();
    await expect(new OkxOnboarding({ run }).setup({ ...keys, ...invalid })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['failed', 'throw', 'timeout', 'credentials'])('所有失败路径丢弃密钥和原始输出: %s', async mode => {
    const raw = JSON.stringify(keys);
    const run = vi.fn<OkxSpawnFn>(async (_bin, args) => {
      if (mode === 'credentials' && args[0] === 'config') return success();
      if (mode === 'throw') throw new Error(raw);
      return { code: 1, stdout: raw, stderr: raw, timedOut: mode === 'timeout', spawnError: raw };
    });
    const result = await new OkxOnboarding({ run, status: () => ({ ...status(), note: raw }), reset: () => {} }).setup(keys);
    expect(result.credentials_ok).toBe(false);
    for (const key of Object.values(keys)) expect(JSON.stringify(result)).not.toContain(key);
    expect(result.ok).toBe(mode === 'credentials');
  });
  it('安装给 5 分钟并在之后重探测', async () => {
    const events: string[] = [];
    const run = vi.fn<OkxSpawnFn>(async () => { events.push('install'); return { code: 0, stdout: 'x'.repeat(5000), stderr: 'done' }; });
    const kit = new OkxOnboarding({ run, reset: () => { events.push('reset'); }, status: () => { events.push('status'); return status(); } });
    const r = await kit.install();
    expect(run).toHaveBeenCalledWith('npm', ['i', '-g', '@okx_ai/okx-trade-cli@1.4.7'], 300_000, { env: expect.any(Object) });
    expect(events).toEqual(['install', 'reset', 'status']);
    expect(r).toMatchObject({ ok: true, version: '1.4.7' });
    expect(r).not.toHaveProperty('log_tail');
  });
});

describe('wallet', () => {
  it('30s 缓存、refresh 和字段白名单', async () => {
    let now = 1000;
    const run = vi.fn<OkxSpawnFn>().mockResolvedValue(success(loggedIn));
    const wallet = new WalletStatus(run, () => '/fake/onchainos', () => now);
    const result = await wallet.status();
    expect(result).toEqual({ installed: true, cli: '/fake/onchainos', logged_in: true, email: loggedIn.email, login_type: 'google', account_name: 'test', account_id: 'id', checked_at: 1000 });
    await wallet.status(); expect(run).toHaveBeenCalledTimes(1);
    await wallet.status(true); expect(run).toHaveBeenCalledTimes(2);
    now += 30_000; await wallet.status(); expect(run).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain('NEVER_RETURN');
  });
  it.each([{ code: 1, stdout: '', stderr: '', spawnError: 'ENOENT' }, { code: 0, stdout: 'bad json', stderr: '' }, { ...success(loggedIn), timedOut: true }, { code: 1, stdout: JSON.stringify({ ok: true, data: loggedIn }), stderr: '' }])('缺失或失败不误亮绿灯 %j', async r => {
    const result = await new WalletStatus(async () => r, () => 'fake').status();
    expect(result.logged_in).toBe(false);
    expect(result.installed).toBe(!('spawnError' in r));
  });
  it('init → poll → status → logout → status；只运行 fake', async () => {
    let logged = false;
    const run = vi.fn<OkxSpawnFn>(async (_bin, args) => {
      if (args.includes('init')) return success({ loginUrl: 'https://example.test/login', authSessionId: 'session', accessToken: 'NEVER_RETURN' });
      if (args.includes('poll')) { logged = true; return success(); }
      if (args.includes('logout')) { logged = false; return success(); }
      return success({ ...loggedIn, loggedIn: logged });
    });
    const wallet = new WalletStatus(run, () => 'fake');
    expect(await wallet.login()).toEqual({ url: 'https://example.test/login', session_id: 'session' });
    expect(await wallet.poll('session')).toMatchObject({ logged_in: true });
    expect(run).toHaveBeenCalledWith('fake', ['wallet', 'login', '--phase', 'poll', '--session-id', 'session'], 60_000, { signal: expect.any(AbortSignal) });
    expect(await wallet.logout()).toMatchObject({ logged_in: false });
    expect(run.mock.calls.map(c => c[1][1])).toEqual(['login', 'login', 'status', 'logout', 'status']);
  });
  it('poll 超时返回 pending，并拒绝空 session', async () => {
    const run = vi.fn<OkxSpawnFn>(async (_bin, args) => args.includes('poll') ? { code: 124, stdout: '', stderr: '', timedOut: true } : success(loggedIn));
    const wallet = new WalletStatus(run, () => 'fake');
    expect(await wallet.poll('session')).toMatchObject({ pending: true });
    await expect(wallet.poll('')).rejects.toThrow('session_id');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('MCP', () => {
  it('使用官方 stdio 命令 user scope，刷新检测', async () => {
    let registered = false;
    const run = vi.fn<OkxSpawnFn>(async (_bin, args) => { if (args.includes('add')) registered = true; return success(); });
    const kit = new OkxOnboarding({ run, mcpBin: () => 'okx-trade-mcp', claudeConfig: async () => JSON.stringify({ mcpServers: registered ? { 'okx-trade-mcp': { command: 'okx-trade-mcp', args: MCP_READ_ARGS } } : {} }) });
    expect(await kit.mcp()).toMatchObject({ registered_in_claude: false });
    expect(await kit.registerMcp()).toMatchObject({ registered_in_claude: true, mcp_command: `okx-trade-mcp ${MCP_READ_ARGS.join(' ')}` });
    expect(run).toHaveBeenCalledWith('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'okx-trade-mcp', '--', 'okx-trade-mcp', ...MCP_READ_ARGS], 20_000);
  });
  it('无关 server 不算已注册，缺 CLI 不算可用', async () => {
    const kit = new OkxOnboarding({ run: async () => ({ code: 1, stdout: '', stderr: '', spawnError: 'missing' }), claudeConfig: async () => '{"mcpServers":{"okx-trade-mcp":{"command":"other"}}}' });
    expect(await kit.mcp()).toMatchObject({ cli_available: false, registered_in_claude: false });
  });
});

it('注册 11 个路由，验证 HTTP 请求/响应与 refresh 传递', async () => {
  const routes = new Map<string, RouteHandler>();
  const run = vi.fn<OkxSpawnFn>().mockResolvedValue(success());
  const kit = new OkxOnboarding({ run, status, reset: () => {} });
  const wallet = new WalletStatus(run, () => 'fake');
  const json = vi.fn(); const fail = vi.fn();
  const readBody = vi.fn().mockResolvedValue({ api_key: '' });
  const rt = { backend: { kind: 'paper' }, switchBackend: vi.fn().mockResolvedValue(null) };
  onboardingRoutes(kit, wallet)({ rt, route: (m, p, h) => routes.set(`${m} ${p}`, h), guarded: h => h, json, fail, readBody } as unknown as RouteContext);
  expect(routes.size).toBe(11);
  const call = (route: string, url = 'http://localhost/') => routes.get(route)!({} as never, {} as never, new URL(url), {});
  await call('POST /api/execution/okx/setup');
  expect(fail).toHaveBeenCalledWith({}, 400, 'api_key 必须为非空字符串');
  expect(run).not.toHaveBeenCalled();
  vi.stubEnv('TG_OKX_PROFILE', 'okx-demo');
  readBody.mockResolvedValue({ profile: 'okx-demo' });
  await call('POST /api/execution/okx/use');
  expect(fail).toHaveBeenLastCalledWith({}, 409, expect.stringContaining('TG_OKX_PROFILE'));
  await call('POST /api/execution/okx/remove');
  expect(fail).toHaveBeenLastCalledWith({}, 409, expect.stringContaining('TG_OKX_PROFILE'));
  vi.stubEnv('TG_OKX_PROFILE', undefined);
  readBody.mockResolvedValue({ profile: 'unknown' });
  await call('POST /api/execution/okx/use');
  expect(fail).toHaveBeenLastCalledWith({}, 400, 'profile 不存在');
  readBody.mockResolvedValue({ profile: 'okx-demo' });
  await call('POST /api/execution/okx/use');
  expect(json).toHaveBeenLastCalledWith({}, 200, status());
  rt.backend.kind = 'okx';
  rt.switchBackend.mockResolvedValue('仍有持仓');
  run.mockClear();
  await call('POST /api/execution/okx/use');
  expect(fail).toHaveBeenLastCalledWith({}, 409, '仍有持仓');
  expect(run).not.toHaveBeenCalled();
  rt.switchBackend.mockResolvedValue(null);
  await call('POST /api/execution/okx/use');
  expect(rt.switchBackend).toHaveBeenCalledWith('paper');
  run.mockClear();
  await call('GET /api/wallet'); await call('GET /api/wallet');
  expect(run).toHaveBeenCalledTimes(1);
  await call('GET /api/wallet', 'http://localhost/api/wallet?refresh=1');
  expect(run).toHaveBeenCalledTimes(2);
  readBody.mockResolvedValue({ session_id: '' }); await call('POST /api/wallet/login/poll');
  expect(fail).toHaveBeenLastCalledWith({}, 400, 'session_id 必须为非空字符串');
});


describe('adversarial onboarding regressions', () => {
  it.each(['-demo', 'a'.repeat(33), 'a.b', 'a/b', 'demo\n'])('rejects profile %j before setup/use/remove', async name => {
    const run = vi.fn<OkxSpawnFn>();
    const kit = new OkxOnboarding({ run, status, reset: () => {}, configPath: () => '/fake/never-access' });
    await expect(kit.setup({ ...keys, name })).rejects.toThrow();
    await expect(kit.use({ profile: name })).rejects.toThrow();
    await expect(kit.remove({ profile: name })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['a'.repeat(32), '_demo', 'demo-1'])('accepts valid profile %j', async name => {
    const kit = new OkxOnboarding({ run: async () => success(), status, reset: () => {} });
    expect(await kit.setup({ ...keys, name })).toMatchObject({ ok: true, profile: name });
  });
  it('scrubs exact AK/SK/PP from all returned status strings', async () => {
    const raw = Object.values(keys).join(' / ');
    const kit = new OkxOnboarding({ run: async () => ({ code: 1, stdout: raw, stderr: raw }), reset: () => {},
      status: () => ({ ...status(), cli: raw, note: raw, version: raw, profiles: [{ name: raw, demo: true, is_default: true }] }) });
    const result = await kit.setup(keys);
    expect(result.credentials_ok).toBe(false);
    for (const secret of Object.values(keys)) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('limits installer environment and keeps npm diagnostics server-side', async () => {
    vi.stubEnv('FAKE_SECRET', 'never-in-child');
    vi.stubEnv('NODE_OPTIONS', '--require=/untrusted');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.test');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn<OkxSpawnFn>().mockResolvedValue({ code: 1, stdout: 'npm-private-output', stderr: 'npm-private-error' });
    const result = await new OkxOnboarding({ run, reset: () => {}, status }).install();
    const env = run.mock.calls[0]![3]!.env!;
    expect(env.HTTPS_PROXY).toBe('http://proxy.test');
    expect(Object.keys(env).every(k => /^(PATH|HOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)$/.test(k))).toBe(true);
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('npm-private');
    expect(log).toHaveBeenCalledWith('OKX CLI install failed:', 'npm-private-output\nnpm-private-error');
  });
  it.each([{ code: 1, stdout: JSON.stringify({ ok: true, data: {} }), stderr: 'token' }, { code: 0, stdout: 'not json token', stderr: '' }, { code: 0, stdout: '{"ok":false}', stderr: '' }])('poll failures remain explicit and do not call status', async result => {
    const run = vi.fn<OkxSpawnFn>().mockResolvedValue(result);
    const wallet = new WalletStatus(run, () => 'fake');
    expect(await wallet.poll('session')).toEqual({ pending: true, error: expect.any(String) });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('dedupes in-flight sessions and allows retry after settlement', async () => {
    let resolve!: (r: OkxRunResult) => void;
    const run = vi.fn<OkxSpawnFn>(() => new Promise(r => { resolve = r; }));
    const wallet = new WalletStatus(run, () => 'fake');
    const first = wallet.poll('one');
    expect(wallet.poll('one')).toBe(first);
    expect(run).toHaveBeenCalledTimes(1);
    resolve({ code: 1, stdout: '', stderr: '' }); await first;
    const retry = wallet.poll('one');
    expect(retry).not.toBe(first);
    resolve({ code: 1, stdout: '', stderr: '' }); await retry;
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('does not accept an unsafe registration, and replaces it before adding read-only', async () => {
    let args = ['--modules', 'all'];
    const run = vi.fn<OkxSpawnFn>(async (_bin, argv) => { if (argv.includes('add')) args = [...MCP_READ_ARGS]; return success(); });
    const kit = new OkxOnboarding({ run, mcpBin: () => 'okx-trade-mcp', claudeConfig: async () => JSON.stringify({ mcpServers: { 'okx-trade-mcp': { command: 'okx-trade-mcp', args } } }) });
    expect(await kit.mcp()).toMatchObject({ registered_in_claude: false });
    expect(await kit.registerMcp()).toMatchObject({ registered_in_claude: true });
    expect(run.mock.calls.filter(c => c[0] === 'claude').map(c => c[1][1])).toEqual(['remove', 'add']);
  });
});

it('HTTP disconnect aborts wallet poll, while normal request close does not', async () => {
  const routes = new Map<string, RouteHandler>();
  let signal: AbortSignal | undefined;
  const run = vi.fn<OkxSpawnFn>(async (_bin, _args, _timeout, options) => {
    signal = options?.signal;
    return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ code: 1, stdout: '', stderr: '' })));
  });
  onboardingRoutes(new OkxOnboarding({ run, status, reset: () => {} }), new WalletStatus(run, () => 'fake'))({
    route: (m, p, h) => routes.set(`${m} ${p}`, h), guarded: h => h,
    readBody: async () => ({ session_id: 'session' }), json: vi.fn(), fail: vi.fn(), rt: {},
  } as unknown as RouteContext);
  const req = Object.assign(new EventEmitter(), { complete: true });
  const res = new EventEmitter();
  const pending = routes.get('POST /api/wallet/login/poll')!(req as never, res as never, new URL('http://localhost'), {});
  await Promise.resolve();
  req.emit('close'); expect(signal?.aborted).toBe(false);
  res.emit('close'); expect(signal?.aborted).toBe(true);
  await pending;
  expect(req.listenerCount('close')).toBe(0);
  expect(res.listenerCount('close')).toBe(0);
});

it('a deduplicated HTTP caller can also cancel the shared poll', async () => {
  let childSignal: AbortSignal | undefined;
  const run = vi.fn<OkxSpawnFn>(async (_bin, _args, _timeout, options) => {
    childSignal = options!.signal;
    return new Promise(resolve => childSignal!.addEventListener('abort', () => resolve({ code: 1, stdout: '', stderr: '' })));
  });
  const wallet = new WalletStatus(run, () => 'fake');
  const first = wallet.poll('session');
  const controller = new AbortController();
  expect(wallet.poll('session', controller.signal)).toBe(first);
  controller.abort();
  expect(childSignal?.aborted).toBe(true);
  expect(await first).toMatchObject({ pending: true });
  expect(run).toHaveBeenCalledTimes(1);
});

describe('wallet assets(地址 + 余额,只走假 spawn)', () => {
  it('EVM 全链同地址归并成一行;余额字段名兜底;没登录不起 CLI', async () => {
    const { WalletStatus, parseWalletAddresses, parseWalletBalance } = await import('../../src/demo/wallet-status.js');
    const rows = parseWalletAddresses({ accountId: 'a', evm: [{ address: '0xabc', chainName: 'eth' }, { address: '0xabc', chainName: 'bnb' }], bitcoin: [{ address: 'bc1p', chainName: 'btc' }], solana: [{ address: 'So1', chainName: 'sol' }] });
    expect(rows.map((r) => [r.family, r.address, r.chains.length])).toEqual([['evm', '0xabc', 2], ['bitcoin', 'bc1p', 1], ['solana', 'So1', 1]]);
    const bal = parseWalletBalance({ totalValueUsd: '12.5', details: { a: { updated_at: 1789891582, data: [{ tokenAssets: [{ tokenSymbol: 'USDT', balance: '10', balanceUsd: '10', chainName: 'eth' }, { symbol: 'ETH', amount: '0.001', valueUsd: '2.5', chainIndex: 1 }] }] } } });
    expect(bal.total_value_usd).toBe('12.5');
    expect(bal.updated_at).toBe(1789891582000);
    expect(bal.assets.map((a) => a.symbol)).toEqual(['USDT', 'ETH']);
    const calls: string[][] = [];
    const run = async (_bin: string, args: string[]) => {
      calls.push(args);
      if (args[1] === 'status') return { code: 0, stdout: JSON.stringify({ ok: true, data: { loggedIn: false } }), stderr: '', timedOut: false, spawnError: null };
      throw new Error('should not spawn');
    };
    const w = new WalletStatus(run as never, () => '/fake/onchainos');
    const v = await w.assets(true);
    expect(v.logged_in).toBe(false);
    expect(v.addresses).toEqual([]);
    expect(calls.map((c) => c[1])).toEqual(['status']);
  });
});
