import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { MarketInbox, parseFileDelivery, parseTextSignal, stripFileSecrets, type QueueRow } from '../../src/demo/asp-agent/inbox.js';
import { MarketCli, type CliRunner, CliError } from '../../src/demo/asp-agent/cli.js';
import { MarketPublisher, type PublishEvent } from '../../src/demo/asp-agent/publisher.js';
import { MarketAftersales } from '../../src/demo/asp-agent/aftersales.js';
import { MarketIdentity, validateRegistration } from '../../src/demo/asp-agent/identity.js';
import { DEFAULT_MARKET_SETTINGS, DEFAULT_PUBLISHER_SETTINGS } from '../../src/demo/asp-agent/settings.js';
import { AspAgent } from '../../src/demo/asp-agent/agent.js';
import type { DemoRuntime } from '../../src/demo/runtime.js';
const states: StateDb[] = [];
afterEach(() => { for (const s of states.splice(0)) s.close(); });
function store() { const s = openStateDb(':memory:'); states.push(s); return new DemoStore(s); }
const now = 1800000000000;
const row = (id = 'one', patch: Record<string, unknown> = {}): QueueRow => ({ id, job_id: 'job-1', message_id: id, content: JSON.stringify({ deliveryId: id, signal_type: 'order', symbol: 'BTC-USDT-SWAP', action: 'LONG', signalTime: now, price: '60000', stop_loss: '59000', ...patch }), llm_content: null, payload_json: null, created_at: new Date(now).toISOString() });
const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data: v }), stderr: '' });
const event = (patch: Partial<PublishEvent> = {}): PublishEvent => ({ event_id: 'e1', kind: 'entry_filled', signal_time: now, symbol: 'BTCUSDT', direction: 'long', price: '60000', stop_loss: '59000', take_profit: ['62000'], reason: '突破 / Breakout', thread_id: 't1', realized_r: null, backend: 'okx_atk', paper: false, ...patch });
const listing = { name: 'Market Agent', description: '结构研究', service_name: '市场结构研究信号', service_description: '推送合约研究信号', pricing: 'monthly_trial', fee: '10' };
function inbox(s: DemoStore, extra: Partial<ConstructorParameters<typeof MarketInbox>[0]> = {}) { return new MarketInbox({ store: s, settings: () => ({ ...DEFAULT_MARKET_SETTINGS, enabled: true }), session: () => 's1', now: () => now, system: async () => {}, emit: () => {}, ...extra }); }
describe('durable market inbox', () => {
  it('deliveryId dedup is durable, append-only and independent of message_id', async () => {
    const s = store(); const a = inbox(s);
    await a.accept([row(), { ...row(), message_id: 'second' }, { ...row(), message_id: 'third' }]);
    expect(a.rows()).toHaveLength(1); expect(a.status().duplicates).toBe(2);
    expect(() => s.marketDb.prepare("UPDATE okx_market_delivery_in SET raw='x'").run()).toThrow(/append-only/);
    expect(inbox(s).capture()).toHaveLength(1); expect(inbox(s).capture()).toHaveLength(0);
    expect(s.traderSignals.list()[0]?.subscription_job_id).toBe('job-1');
  });
  it('secrets are redacted before ledger/store persistence and returned frames across ingest paths', async () => {
    const s = store(); const emit = vi.fn(); const a = inbox(s, { emit });
    const secret = 'sbk_reviewkey12345';
    await a.accept([row('redacted', { reason: secret, target_order_ref: secret })]);
    const [signal] = a.capture();
    expect(JSON.stringify(a.rows())).not.toContain(secret);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(secret);
    const saved = s.traderSignals.capture({ ...signal!, id: 'direct', signal_id: 'direct', raw_text: secret, ref_order: secret });
    expect(saved.signal.raw_text).toContain('***');
    expect(JSON.stringify(saved.signal)).not.toContain(secret);
    expect(JSON.stringify(s.marketDb.prepare('SELECT * FROM demo_trader_signal').all())).not.toContain(secret);
  });
  it('capture failure never advances cursor; restart resumes ledger even when queue is empty', async () => {
    const s = store(); const a = inbox(s); await a.accept([row()]);
    const original = s.traderSignals.capture.bind(s.traderSignals);
    s.traderSignals.capture = () => { throw new Error('disk full'); };
    expect(() => a.capture()).toThrow('disk full'); expect(s.kvGet('market.in_cursor')).toBeNull();
    s.traderSignals.capture = original;
    const resumed = inbox(s, { session: () => 's2' }).capture(); expect(resumed[0]?.backfill).toBe(true); expect(resumed).toHaveLength(1);
  });
  it('system envelopes never enter the signal ledger; malformed/analysis rows do', async () => {
    const system = vi.fn(async () => {}); const s = store(); const a = inbox(s, { system });
    await a.accept([{ ...row(), content: JSON.stringify({ agentId: 'a1', message: { source: 'system', event: 'sub_renew', jobId: 'j1' } }) }, row('a', { signal_type: 'analysis' }), { ...row('b'), content: 'not JSON' }]);
    expect(system).toHaveBeenCalledOnce(); expect(a.rows()).toHaveLength(2); expect(a.capture()).toHaveLength(0); expect(a.status()).toMatchObject({ dlq: 1, analysis: 1 });
  });
  it('watch and queue are mutually exclusive and switch tears down the child', async () => {
    const s = store(); let transport: 'watch' | 'queue' = 'watch'; let onLine = (_: string) => {}; const stop = vi.fn(); const readQueue = vi.fn(async () => []);
    const a = inbox(s, { settings: () => ({ ...DEFAULT_MARKET_SETTINGS, enabled: true, transport }), readQueue, watch: (line) => { onLine = line; return { stop }; } });
    a.syncTransport(); await expect(a.poll()).rejects.toThrow('watch'); expect(readQueue).not.toHaveBeenCalled();
    onLine(row().content); await a.stop(); expect(a.rows()).toHaveLength(1);
    transport = 'queue'; a.syncTransport(); await a.poll(); expect(stop).toHaveBeenCalledOnce(); expect(readQueue).toHaveBeenCalledOnce();
  });
});
describe('publisher', () => {
  function publisher(s: DemoStore, runner: CliRunner, paper = false) { return new MarketPublisher({ store: s, cli: new MarketCli(runner), settings: () => ({ ...DEFAULT_PUBLISHER_SETTINGS, enabled: true, backend_filter: paper ? ['okx', 'paper'] : ['okx'] }), aspId: async () => 'asp1', emit: () => {} }); }
  it('sequential fanout freezes subscribers; replay never sends again; retry only failed jobs', async () => {
    const s = store(); const delivered: string[] = []; let active = 0; let peak = 0; let fail = true;
    const runner: CliRunner = async (_bin, args, timeout) => {
      expect(timeout).toBe(20000);
      if (args[1] === 'subscribe-active') return ok({ list: [{ jobId: 'j1' }, { jobId: 'j2' }] });
      expect(args[1]).toBe('deliver'); delivered.push(args[2]!); active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
      return args[2] === 'j2' && fail ? { code: 1, stdout: '{}', stderr: 'failed' } : ok({ sent: true });
    };
    const a = publisher(s, runner);
    await Promise.all([a.publish(event()), a.publish(event())]); expect(delivered).toEqual(['j1', 'j2']); expect(peak).toBe(1);
    await publisher(s, runner).publish(event()); expect(delivered).toHaveLength(2);
    fail = false; await a.retry('e1'); expect(delivered).toEqual(['j1', 'j2', 'j2']);
    expect(s.bots.runs({ routine: 'asp_publish' })[0]).toMatchObject({ input: { subscribers: ['j1', 'j2'] }, result: { jobs: expect.any(Array) } });
  });
  it('paper emits only analysis; external signals emit nothing; banned wording is recorded without CLI', async () => {
    const s = store(); const runner = vi.fn<CliRunner>(async () => ok({ list: [] })); const a = publisher(s, runner, true);
    await a.publish(event({ paper: true, backend: 'paper' })); expect(a.get('e1')?.payload).toMatchObject({ signal_type: 'analysis', paper: true, is_executable: false, valid_until: now + 180000 });
    await a.publish(event({ event_id: 'ext', transport: 'okx_asp' })); expect(a.get('ext')).toBeNull();
    runner.mockClear(); await a.publish(event({ event_id: 'bad', reason: 'Guaranteed risk-free 稳赚' })); expect(a.get('bad')?.refusal).toMatch(/敏感词/); expect(runner).not.toHaveBeenCalled();
  });
  it('more than half failures hand off to captain; exactly half does not', async () => {
    const s = store(); const a = publisher(s, async (_b, args) => args[1] === 'subscribe-active' ? ok({ list: [{ jobId: 'j1' }] }) : { code: 124, stdout: '{}', stderr: 'timeout' });
    await a.publish(event()); expect(s.bots.handoffs({ to_role: 'gate_captain' })).toHaveLength(1);
  });
});
describe('aftersales and identity', () => {
  it('renew is claimed once; reject creates todo and handoff; decision cannot be sent twice', async () => {
    const s = store(); const runner = vi.fn<CliRunner>(async () => ok({ done: true })); const a = new MarketAftersales({ store: s, cli: new MarketCli(runner), aspId: async () => 'asp1', emit: () => {}, activity: () => {} });
    await a.receive({ source: 'system', event: 'sub_renew', jobId: 'j1' }, 'r1'); await a.receive({ source: 'system', event: 'sub_renew', jobId: 'j1' }, 'r1'); expect(runner).toHaveBeenCalledOnce();
    await a.receive({ source: 'system', event: 'sub_user_reject', jobId: 'j1', reason: 'not received', periodIndex: 2 }, 'r2'); expect(s.bots.handoffs()).toHaveLength(1);
    await expect(a.decide('j1', 'dispute')).rejects.toThrow('理由'); await a.decide('j1', 'dispute', '交付已完成'); await expect(a.decide('j1', 'agree_refund')).rejects.toThrow(); expect(runner).toHaveBeenCalledTimes(2);
  });
  it('registration validates fields and avatar, then pre-check/upload/create with correct service keys', async () => {
    const s = store(); const calls: string[][] = [];
    const identity = new MarketIdentity(new MarketCli(async (_b, args) => { calls.push(args); return ok(args[1] === 'pre-check' ? { canCreate: true } : args[1] === 'upload' ? { url: 'https://cdn.example/avatar.png' } : { agentId: '1' }); }), s);
    expect(validateRegistration({ ...listing, fee: 10 })).not.toEqual([]);
    await expect(identity.register(listing, null)).rejects.toThrow('avatar'); expect(calls).toHaveLength(0);
    await identity.register(listing, { bytes: Buffer.from('png'), type: 'image/png' }); expect(calls.map((x) => x[1])).toEqual(['pre-check', 'upload', 'create']);
    const args = calls[2]!; const service = JSON.parse(args[args.indexOf('--service') + 1]!)[0]; expect(service).toMatchObject({ serviceName: listing.service_name, serviceDescription: listing.service_description, fee: '', subscription: [{ interval: 'month', fee: '10' }], freeTrial: '72' });
  });
  it('validate returns CLI findings unchanged; non-json and timeout map to CLI errors', async () => {
    const s = store(); const finding = { pass: false, findings: [{ field: 'service[0].name', code: 'N1', severity: 'block', message: 'bad' }] };
    const identity = new MarketIdentity(new MarketCli(async () => ok(finding)), s); expect(await identity.validate(listing)).toEqual(finding);
    await expect(new MarketCli(async () => ({ code: 124, stdout: '', stderr: 'timed out' })).call('search')).rejects.toMatchObject({ code: 'cli_timeout' });
  });
});
describe('file deliveries (user_attention)', () => {
  const desc = '📥 [Received] ASP#8136 → me\n「jobId: 0xabc\ndeliverableType: file\nfileKey: 0xabc/0xabc-27d0\ndigest: e111e572\nsalt: OlLJe2K8=\nnonce: SRu6CQ==\nsecret: csDntS9I=\nfilename: deliverable_0xabc.md...」';
  it('parses the descriptor and strips key material from the ledger copy', () => {
    expect(parseFileDelivery(desc)).toEqual({ file_key: '0xabc/0xabc-27d0', digest: 'e111e572', salt: 'OlLJe2K8=', nonce: 'SRu6CQ==', secret: 'csDntS9I=', filename: 'deliverable_0xabc.md' });
    expect(parseFileDelivery('{"deliveryId":"x"}')).toBeNull();
    expect(stripFileSecrets(desc)).not.toContain('csDntS9I='); expect(stripFileSecrets(desc)).toContain('fileKey: 0xabc/0xabc-27d0');
  });
  it('decrypts once, files the decrypted signal, and never re-downloads the same attachment', async () => {
    const s = store(); const fetched: string[] = [];
    const body = JSON.stringify({ type: 'signal', deliveryId: '20260922-ad27', signalTime: '2026-09-22T14:34:34+08:00', signal_type: 'analysis', symbol: '', action: 'WELCOME', reason: '欢迎订阅' });
    const i = inbox(s, { fetchFile: async (d) => { fetched.push(d.file_key); return body; } });
    const r: QueueRow = { id: 'ua:todo_1', job_id: '0xabc', message_id: 'agent-message:inbound:92fb', content: desc, llm_content: null, payload_json: null, created_at: new Date(now).toISOString() };
    expect(await i.accept([r])).toEqual({ scanned: 1, duplicates: 0 });
    const rows = i.rows({ limit: 10 }); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ delivery_id: '20260922-ad27', job_id: '0xabc', parse_status: 'analysis' });
    expect(rows[0]!.raw).toContain('欢迎订阅'); expect(rows[0]!.raw).not.toContain('csDntS9I=');
    expect(await i.accept([r])).toEqual({ scanned: 0, duplicates: 1 }); expect(fetched).toEqual(['0xabc/0xabc-27d0']);
  });
  it('keeps the descriptor as an invalid ledger row when decryption fails, without crashing the batch', async () => {
    const s = store(); const i = inbox(s, { fetchFile: async () => null });
    const r: QueueRow = { id: 'ua:todo_2', job_id: '0xabc', message_id: 'agent-message:inbound:aaaa', content: desc, llm_content: null, payload_json: null, created_at: new Date(now).toISOString() };
    expect(await i.accept([r])).toEqual({ scanned: 1, duplicates: 0 }); expect(i.rows({ limit: 10 })[0]).toMatchObject({ delivery_id: 'agent-message:inbound:aaaa', parse_status: 'invalid' });
  });
});
describe('platform notices', () => {
  it('plain-text platform notifications are filed as notice, not invalid', async () => {
    const s = store(); const i = inbox(s);
    await i.accept([{ id: 'ua:todo_9', job_id: '0xabc', message_id: 'agent-message:inbound:n1', content: '【试用已开始】你对「x」的免费试用已开始:2026-09-22 至 2026-09-25', llm_content: null, payload_json: null, created_at: new Date(now).toISOString() }]);
    expect(i.rows({ limit: 5 })[0]).toMatchObject({ delivery_id: 'agent-message:inbound:n1', parse_status: 'notice' });
  });
});
describe('text-line signals (Alpha Engine style)', () => {
  const body = '📥 [Received] Alpha Engine#10521 → Jacky#13529 (you)\nJob: 0xa36d...895d\n「jobId: 0xa36d\ndeliverableType: text\n- - -\n【合约信号】ONE-PERP | LONG 1x | 入场 0.005365-0.005408 | SL 0.003476 | TP1 0.007292 | 仓位 5% | 4h 内有效\n- - -\n[intent:deliver]」';
  it('parses symbol/side/entry range/SL/TP/validity from the line', () => {
    expect(parseTextSignal(body, new Date(now).toISOString())).toEqual({ deliveryId: expect.stringMatching(/^line-[0-9a-f]{16}$/), signal_type: 'order', symbol: 'ONE-USDT-SWAP', action: 'LONG', entry: ['0.005365', '0.005408'], stop_loss: '0.003476', take_profit: ['0.007292'], leverage: '1', position_pct: '5', valid_until: now + 4 * 3600_000, text_format: 'alpha_engine_line' });
    expect(parseTextSignal('【试用已开始】你的免费试用已开始', now)).toBeNull();
  });
  it('files the text signal as an order with a ladder entry and stop', async () => {
    const s = store(); const i = inbox(s);
    await i.accept([{ id: 'ua:t1', job_id: '0xa36d', message_id: 'agent-message:inbound:f3f9', content: body, llm_content: null, payload_json: null, created_at: new Date(now).toISOString() }]);
    const r = i.rows({ limit: 5 })[0]!; expect(r).toMatchObject({ parse_status: 'order', signal_type: 'order' });
    expect(r.signal).toMatchObject({ symbol: 'ONEUSDT', side: 'long', action: 'open', entry_kind: 'ladder', entry_prices: ['0.005365', '0.005408'], stop: '0.003476', valid_until: now + 4 * 3600_000 });
    // 守护里无头 Claude 的「信号送达」回执把同一行再发一遍:必须合成同一条,不能双计。
    const echo = '【信号送达】「trading-swarm · Alpha」(Alpha Engine #10521)\n\n【合约信号】ONE-PERP | LONG 1x | 入场 0.005365-0.005408 | SL 0.003476 | TP1 0.007292 | 仓位 5% | 4h 内有效\n\n该订阅为仅接收模式';
    expect(await i.accept([{ id: 'ua:t2', job_id: '0xa36d', message_id: 'agent-message:inbound:echo1', content: echo, llm_content: null, payload_json: null, created_at: new Date(now + 60_000).toISOString() }])).toEqual({ scanned: 0, duplicates: 1 });
    expect(i.rows({ limit: 5 })).toHaveLength(1);
  });
});
describe('buyer subscriptions', () => {
  function agent(runner: CliRunner) {
    const s = store(); const rt = { store: s, followSettings: structuredClone(DEFAULT_MARKET_SETTINGS), okxAspRunCli: runner, okxAspReadQueue: null, emit: () => {}, activity: () => {}, setWorkflow(p: { follow: typeof DEFAULT_MARKET_SETTINGS }) { this.followSettings = p.follow; }, okxAspFeed: () => ({ traderOf: () => 'ASP' }) };
    return new AspAgent(rt as unknown as DemoRuntime, () => 'session');
  }
  const body = { service_id: 'service1', provider_agent_id: 'asp1', fee_amount: '10', fee_token_address: '0x123', use_trial: true, auto_renew: false, mode: 'evidence', weight: 0.5 };
  it('create/device/config ordering preserves other devices and never supplies autotrade flags', async () => {
    const calls: string[][] = []; const a = agent(async (_b, args) => { calls.push(args); if (args[1] === 'create-subscribe') return ok({ jobId: 'j1' }); if (args[1] === 'my-subscriptions') return ok({ thisDeviceId: 'd2', list: [{ jobId: 'j1', deviceList: ['d1'] }] }); return ok({ updated: true }); });
    expect(await a.subscribe(body)).toMatchObject({ jobId: 'j1', configured: true }); expect(calls.map((x) => x[1])).toEqual(['my-subscriptions', 'subscription-execution-config-set', 'create-subscribe', 'my-subscriptions', 'subscribe-device-update']); expect(calls[1]).toContain('signal_only'); expect(calls.flat().some((x) => x.startsWith('--autotrade') || x === 'guide_direct')).toBe(false); expect(calls[2]).toContain('--provider-agent-id'); expect(calls[4]).toContain('d1,d2'); expect(a.settings().subscriptions['j1']).toMatchObject({ mode: 'evidence', weight: 0.5 });
  });
  it('fundingNoticeCommand is parsed as an allowlisted argv and surfaced without creating config', async () => {
    const calls: string[][] = []; const a = agent(async (_b, args) => { calls.push(args); if (args[1] === 'my-subscriptions') return ok({ list: [] }); if (args[1] === 'create-subscribe') return { code: 1, stdout: JSON.stringify({ ok: false, data: { fundingNoticeCommand: 'onchainos agent funding-notice --chain xlayer --currency USDT --shortfall 10 --deposit-address 0x123 --format json' } }), stderr: '' }; return ok({ address: '0x123', shortfall: '10' }); });
    expect(await a.subscribe(body)).toEqual({ jobId: null, funding_notice: { address: '0x123', shortfall: '10' } }); expect(calls).toHaveLength(4); expect(a.settings().subscriptions).toEqual({});
  });
});

describe('market routes without network sockets', () => {
  it('registers every design endpoint and enforces watch/manual poll conflict', async () => {
    const { marketRoutes } = await import('../../src/demo/asp-agent/routes-market.js');
    const routes = new Map<string, import('../../src/demo/http-extra.js').RouteHandler>();
    const s = store(); const settings = { ...DEFAULT_MARKET_SETTINGS, transport: 'watch' as const };
    const rt = { store: s, followSettings: settings, marketAgent: () => ({ settings: () => ({ ...settings, publisher: DEFAULT_PUBLISHER_SETTINGS }) }) };
    let body: unknown; let status = 0;
    marketRoutes({ route: (method, path, handler) => { routes.set(`${method} ${path}`, handler); }, guarded: (fn) => fn, json: (_res, code, value) => { body = value; status = code; }, fail: () => {}, readBody: async () => ({}), rt: rt as unknown as DemoRuntime, store: s, oauth: null, emit: () => {} });
    for (const path of ['GET /api/market/status', 'POST /api/market/wallet/deposit-notice', 'GET /api/market/search', 'GET /api/market/asp/:agent_id', 'POST /api/market/subscribe', 'GET /api/market/subscriptions', 'PATCH /api/market/subscriptions/:job_id', 'POST /api/market/subscriptions/:job_id/cancel', 'POST /api/market/subscriptions/:job_id/reject', 'POST /api/market/subscriptions/:job_id/autorenew', 'GET /api/market/inbox', 'POST /api/market/inbox/poll', 'GET /api/market/settings', 'POST /api/market/settings', 'GET /api/market/asp', 'POST /api/market/asp/validate', 'POST /api/market/asp/register', 'POST /api/market/asp/activate', 'POST /api/market/asp/deactivate', 'POST /api/market/asp/update', 'POST /api/market/asp/claim', 'POST /api/market/asp/aftersales/:job_id', 'GET /api/market/asp/deliveries', 'POST /api/market/asp/deliveries/:event_id/retry', 'POST /api/market/asp/preview']) expect(routes.has(path), path).toBe(true);
    const req = {} as import('node:http').IncomingMessage; const res = {} as import('node:http').ServerResponse;
    await routes.get('GET /api/market/settings')!(req, res, new URL('http://localhost'), {}); expect(status).toBe(200); expect(body).toMatchObject({ default_mode: 'evidence', publisher: { enabled: false } });
    await expect(routes.get('POST /api/market/inbox/poll')!(req, res, new URL('http://localhost'), {})).rejects.toMatchObject({ status: 409 });
  });
  it('compat pull counts durable new rows resumed this tick, then counts zero on replay', async () => {
    const { DemoRuntime } = await import('../../src/demo/runtime.js'); const { PaperBackend } = await import('../../src/demo/execution.js');
    const s = store(); const rt = new DemoRuntime({ store: s, backend: new PaperBackend(100000), brains: {} });
    rt.symbols = async () => [];
    rt.okxAspReadQueue = async () => [];
    rt.okxAspRunCli = async () => ok({ list: [] });
    rt.setWorkflow({ follow: { enabled: true, subscriptions: { 'job-1': { mode: 'gated', weight: 0.5, enabled: true } } } });
    const a = inbox(s); await a.accept([row('already-captured', { can_enter: false })]); a.capture();
    try {
      expect(await rt.followTick()).toMatchObject({ pulled: 1, handled: 1, resumed: 1, error: null });
      expect(await rt.followTick()).toMatchObject({ pulled: 0, handled: 0, error: null });
    } finally { await rt.stop(); }
  });
  it('two fake queue deliveries reach the real runtime review_only without a listening server', async () => {
    const { DemoRuntime } = await import('../../src/demo/runtime.js'); const { PaperBackend } = await import('../../src/demo/execution.js');
    const s = store(); const rt = new DemoRuntime({ store: s, backend: new PaperBackend(100000), brains: {} });
    rt.symbols = async () => [];
    rt.okxAspReadQueue = async () => [row('runtime-1', { signalTime: Date.now(), can_enter: false }), row('runtime-2', { signalTime: Date.now(), can_enter: false })];
    rt.okxAspRunCli = async () => ok({ list: [{ jobId: 'job-1', providerAgentName: 'source' }] });
    rt.setWorkflow({ follow: { enabled: true, subscriptions: { 'job-1': { mode: 'gated', weight: 0.5, enabled: true } } } });
    const tick = await rt.okxAspTick(); expect(tick).toMatchObject({ pulled: 2, handled: 2, error: null }); expect(s.traderSignals.list().map((x) => x.status)).toEqual(['review_only', 'review_only']);
    expect((await rt.okxAspTick()).pulled).toBe(0); await rt.stop();
  });
});

describe('wallet card and seller-only collection', () => {
  it('caches XLayer wallet data and returns a PNG QR via the single runner', async () => {
    const { MarketWallet } = await import('../../src/demo/asp-agent/wallet.js'); const calls: string[][] = [];
    const address = `0x${'a'.repeat(40)}`;
    const wallet = new MarketWallet(new MarketCli(async (_b, args) => { calls.push(args); if (args[1] === 'status') return ok({ loggedIn: true, email: 'x@y.z', currentAccountName: 'Main' }); if (args[1] === 'addresses') return ok({ xlayer: [{ address }] }); if (args[1] === 'balance') return ok({ tokenAssets: [{ symbol: 'USDT', balance: '12.345' }] }); return ok({ qr_base64: 'iVBORw0KGgo=' }); }));
    expect(await wallet.status()).toMatchObject({ logged_in: true, chain: 'xlayer', balance_usdt: '12.345', address }); await wallet.status(); expect(calls).toHaveLength(3);
    expect(await wallet.depositNotice()).toMatchObject({ deposit_address: address, qr_base64: 'iVBORw0KGgo=', mime_type: 'image/png' }); expect(calls[3]?.[1]).toBe('funding-notice');
  });
  it('publisher enabled with follow disabled still claims renewals, without following signals', async () => {
    const { DemoRuntime } = await import('../../src/demo/runtime.js'); const { PaperBackend } = await import('../../src/demo/execution.js');
    const s = store(); const rt = new DemoRuntime({ store: s, backend: new PaperBackend(100000), brains: {} });
    const calls: string[][] = []; rt.okxAspRunCli = async (_b, args) => { calls.push(args); return ok({ list: [] }); };
    rt.okxAspReadQueue = async () => [{ ...row(), content: JSON.stringify({ agentId: 'asp1', message: { source: 'system', event: 'sub_renew', jobId: 'j1' } }) }, row('seller-order')];
    rt.marketAgent().saveSettings({ publisher: { enabled: true } }); expect(rt.followSettings.enabled).toBe(false);
    await rt.okxAspTick(); expect(calls.some((x) => x[1] === 'subscribe-asp-claim')).toBe(true); expect(s.traderSignals.count()).toBe(0); expect(rt.marketAgent().inbox.rows()).toHaveLength(1); await rt.stop();
  });
});

describe('remaining platform commands with fake CLI', () => {
  it('preserves platform arrays, caches details, and builds activate/update arguments', async () => {
    const s = store(); const calls: string[][] = [];
    const cli = new MarketCli(async (_b, args) => {
      calls.push(args);
      if (args[1] === 'get-my-agents') return ok({ list: [{ agentId: 'a1', roleLabel: 'ASP' }] });
      if (args[1] === 'service-list') return ok([{ id: 'svc1', subscription: [{ interval: 'month', fee: '10' }] }]);
      if (args[1] === 'feedback-list') return ok([{ description: 'untrusted review' }]);
      return ok({ done: true });
    });
    const a = new MarketIdentity(cli, s);
    expect(await a.detail('a1')).toMatchObject({ services: [{ id: 'svc1' }], feedback: [{ description: 'untrusted review' }] });
    await a.detail('a1'); expect(calls).toHaveLength(3);
    await a.mutate('activate', {}); expect(calls.at(-1)).toEqual(['agent', 'activate', '--agent-id', 'a1', '--preferred-language', 'zh-CN']);
    await a.mutate('deactivate', {}); expect(calls.at(-1)).toEqual(['agent', 'deactivate', '--agent-id', 'a1']);
    await a.mutate('update', { ...listing, service_id: 'svc1' });
    const update = calls.at(-1)!; expect(update).not.toContain('--role');
    const services = JSON.parse(update[update.indexOf('--service') + 1]!); expect(services[0]).toMatchObject({ operation: 'update', id: 'svc1', serviceName: listing.service_name });
  });
  it('interrupted fanout can only recover through explicit failed-job retry', async () => {
    const s = store(); const runner = vi.fn<CliRunner>(async () => ok({ list: [] }));
    const a = new MarketPublisher({ store: s, cli: new MarketCli(runner), settings: () => ({ ...DEFAULT_PUBLISHER_SETTINGS, enabled: true }), aspId: async () => 'a1', emit: () => {} });
    await a.publish(event());
    s.marketDb.prepare("INSERT INTO okx_market_delivery_out_job(event_id,job_id,status,attempts,updated_at) VALUES ('e1','j1','pending',1,?)").run(now);
    const recovered = new MarketPublisher({ store: s, cli: new MarketCli(runner), settings: () => ({ ...DEFAULT_PUBLISHER_SETTINGS, enabled: true }), aspId: async () => 'a1', emit: () => {} });
    runner.mockClear(); await recovered.publish(event()); expect(runner).not.toHaveBeenCalled(); expect(recovered.get('e1')?.jobs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('未知') });
    await recovered.retry('e1', 'j1'); expect(runner).toHaveBeenCalledOnce();
  });
  it('watch handles pretty JSON batches and persists disabled-follow rows as review-only', async () => {
    const s = store(); let line = (_s: string) => {}; const a = inbox(s, { signalEnabled: () => false, settings: () => ({ ...DEFAULT_MARKET_SETTINGS, enabled: true, transport: 'watch' }), watch: (fn) => { line = fn; return { stop() {} }; } });
    a.syncTransport();
    for (const text of JSON.stringify({ items: [{ jobId: 'j1', userContent: row('watch-1').content }, { jobId: 'j2', userContent: row('watch-2').content }] }, null, 2).split('\n')) line(text);
    await a.stop(); expect(a.rows()).toHaveLength(2); expect(a.capture().every((s) => s.backfill)).toBe(true);
  });
});

describe('套利信号仅记录', () => {
  it.each(['arbitrage', 'basis', 'funding', '套利', '基差'])('关键字 %s 阻断自动执行', async (keyword) => {
    const s = store(); const a = inbox(s);
    await a.accept([row(`arb-${keyword}`, { reason: `${keyword} BTCUSDT`, basis_pct: '0.1', expected_apr: '12' })]);
    expect(a.capture()).toMatchObject([{ kind: 'arbitrage', status: 'evidence', action: 'analysis_only' }]);
    const saved = s.traderSignals.list()[0]!;
    expect(saved).toMatchObject({ kind: 'arbitrage', reason: 'arbitrage_recorded_only', arbitrage: { symbol: 'BTCUSDT', spot_side: 'long', perp_side: 'short', basis_pct: '0.1', expected_apr: '12' } });
    expect(s.traderSignals.claimForApply(saved.id, 'tester', 'claim', now)).toBeNull();
    expect(s.threads()).toHaveLength(0);
    expect(a.rows()[0]).toMatchObject({ parse_status: 'arbitrage', signal: { kind: 'arbitrage' } });
  });

  it('结构化 kind=arbitrage 不依赖文本关键字,缺少指标明确为 null', async () => {
    const s = store(); const a = inbox(s);
    await a.accept([row('structured-arb', { kind: 'arbitrage' })]);
    expect(a.capture()).toHaveLength(1);
    expect(s.traderSignals.list()[0]).toMatchObject({ kind: 'arbitrage', reason: 'arbitrage_recorded_only', arbitrage: { basis_pct: null, expected_apr: null } });
  });
});
