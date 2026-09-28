// ASP 服务框架:输入解析、资产×周期推荐、上架目录自检、注册(decide/produce)、按服务扇出。零网络,CLI 全部假实现。
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { MarketCli, setNetworkBackoffForTest, type CliRunner } from '../../src/demo/asp-agent/cli.js';
import { BANNED_WORDS, validateSignalText } from '../../src/demo/asp-agent/publisher.js';
import { assetHorizonService } from '../../src/demo/asp-agent/services/asset-horizon.js';
import { STRUCTURED_HEADER } from '../../src/demo/asp-agent/services/render.js';
import { ServiceBroadcaster, signalFor } from '../../src/demo/asp-agent/services/broadcast.js';
import { checkListing, LISTINGS, listingBundle, listingPayload } from '../../src/demo/asp-agent/services/catalog.js';
import { normSymbol, numberAfter, sideIn, symbolsIn, targetsIn } from '../../src/demo/asp-agent/services/params.js';
import type { ProviderHandler, ProviderTask } from '../../src/demo/asp-agent/services/provider-contract.js';
import { jobFromTask, registerAspServices } from '../../src/demo/asp-agent/services/register.js';
import { ServiceInputError, type ChannelPush, type PerCallJob, type ServiceDeps, type SubscriptionChannel } from '../../src/demo/asp-agent/services/types.js';
import type { AssetRecommendation } from '../../src/demo/recommend.js';

setNetworkBackoffForTest(0);
const NOW = Date.UTC(2026, 8, 25, 12);
const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data: v }), stderr: '' });
const job = (o: Partial<PerCallJob> = {}): PerCallJob => ({ job_id: '0xjob1', service_key: 'asset_horizon', description: '请推荐短线适合的币', service_params: null, ...o });
const fit = (eligible: boolean, reason: string | null = null) => ({ eligible, reason, direction: eligible ? 'long' as const : null, families: eligible ? ['breakout' as const] : [], evidence: eligible ? ['雷达短线档第 1 名'] : ['成交额不足'] });
const rec = (): AssetRecommendation => ({
  id: 'rec_1', as_of: NOW, source: { universe_scan_at: NOW, regime_at: NOW, radar_at: {} }, warnings: [],
  rows: [
    { symbol: 'BTCUSDT', market: 'perp', quote_vol_24h: 5e9, depth_usd_05: null, regime: 'bull', scan: { rank: 1, score: 0.9, reasons: [] }, radar: {}, horizons: { short: fit(true), mid: fit(true), long: fit(false, 'not_requested') } },
    { symbol: 'PEPEUSDT', market: 'perp', quote_vol_24h: 4e7, depth_usd_05: null, regime: 'volatile', scan: null, radar: {}, horizons: { short: fit(false, 'volume_below_short_gate'), mid: fit(true), long: fit(false, 'not_requested') } },
  ],
});
const deps = (o: Partial<ServiceDeps> = {}): ServiceDeps => ({
  now: () => NOW, recommend: vi.fn(async () => rec()), matrix: () => null, bars: async () => [], regime: async () => null, ...o,
});

describe('输入解析', () => {
  it('只认全大写或带 USDT 后缀的币名,不把英文单词当币', () => {
    expect(symbolsIn('Please recommend BTC and eth-usdt for Short term, SOL-USDT-SWAP too')).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(symbolsIn('RSI 与 EMA 金叉,TP1 65000,USDT 本位')).toEqual([]);
  });
  it('计划文本:方向、入场、止损、多目标', () => {
    const t = 'BTC 做多 入场 64200 止损 63100 止盈 65500/66800 1h';
    expect(sideIn(undefined, t)).toBe('long');
    expect(numberAfter(t, '入场|entry')).toBe(64200);
    expect(numberAfter(t, '止损|stop|sl')).toBe(63100);
    expect(targetsIn(t)).toEqual([65500, 66800]);
  });
});

describe('资产×周期推荐', () => {
  it('自由文本 → 参数;JSON 参数优先;非法 top_n 拒单', () => {
    expect(assetHorizonService.validate(job({ description: '短线 BTC ETH 现货' }))).toEqual({ symbols: ['BTCUSDT', 'ETHUSDT'], horizons: ['short'], market: 'spot', top_n: 8 });
    expect(assetHorizonService.validate(job({ service_params: '{"symbols":"sol,doge","horizons":["mid"],"market":"perp","top_n":3}' }))).toEqual({ symbols: ['SOLUSDT', 'DOGEUSDT'], horizons: ['mid'], market: 'perp', top_n: 3 });
    expect(() => assetHorizonService.validate(job({ service_params: '{"top_n":50}' }))).toThrow(ServiceInputError);
  });
  it('交付:每币每周期结论 + JSON + 稳定 sha256,无红线词', async () => {
    const d = deps();
    const p = assetHorizonService.validate(job());
    const a = await assetHorizonService.handle(job(), p, d), b = await assetHorizonService.handle(job(), p, d);
    expect(d.recommend).toHaveBeenCalledWith({ horizons: ['short'], market: 'perp', top_n: 8 });
    expect(a.summary).toContain('Short-term BTC');
    expect(a.text).toContain('PEPEUSDT');
    const human = a.text.split(`\n\n${STRUCTURED_HEADER}`)[0]!;
    expect(human).not.toContain('{"service"'); // 人读部分不带 JSON
    expect(a.text).toMatch(/```json\n\{"service":"asset_horizon"/); // JSON 在末尾代码块
    expect(JSON.parse(a.file!.content)).toMatchObject({ sha256: a.sha256, service: 'asset_horizon' });
    expect(a.sha256).toBe(b.sha256);
    expect(a.payload['picks']).toEqual({ short: ['BTCUSDT'] });
    expect(BANNED_WORDS.test(a.text)).toBe(false);
  });
});

describe('上架目录', () => {
  it('7 个服务按默认价全部通过 CLI 规则自检', () => {
    const b = listingBundle();
    expect(b.items.map((x) => x.problems).flat()).toEqual([]);
    expect(b.ok).toBe(true);
    expect(JSON.parse(b.service_arg)).toHaveLength(7);
  });
  it('订阅带月费与 72h 试用、单次价不带试用;更新带 id', () => {
    expect(listingPayload(LISTINGS.market_intel, '9.9')).toMatchObject({ operation: 'create', serviceType: 'A2A', fee: '', subscription: [{ interval: 'month', fee: '9.9' }], freeTrial: '72' });
    expect(listingPayload(LISTINGS.plan_gate, '0.5', '77')).toMatchObject({ operation: 'update', id: '77', fee: '0.5', subscription: [] });
    expect(listingPayload(LISTINGS.plan_gate, '0.5')).not.toHaveProperty('freeTrial');
  });
  it('自检能抓出坏价格、URL、名字过短', () => {
    expect(checkListing(LISTINGS.asset_horizon, '0.555')).toHaveLength(1);
    expect(checkListing({ ...LISTINGS.asset_horizon, name: 'abc', description: ['见 https://x.io', '', ''] }, '1').length).toBeGreaterThanOrEqual(2);
  });
});

const task = (o: Partial<ProviderTask> = {}): ProviderTask => ({ job_id: '0xabc', kind: 'one_time', status: 0, status_label: 'CREATED', service_id: '101', service_name: null, buyer_agent_id: '555', buyer_name: null, title: 't', test_flag: false, raw: {}, detail: { description: '请推荐 BTC ETH 中线' }, ...o });
function registry() {
  const handlers = new Map<string, ProviderHandler>();
  const register = (key: string, h: ProviderHandler) => { handlers.set(key, h); return () => handlers.delete(key); };
  return { handlers, register };
}
const channel = (key: 'market_brief' | 'radar_feed', text: string): SubscriptionChannel => ({ key, every_ms: 60_000, tick: async () => null, welcome: async () => ({ event_id: `${key}:w`, channel: key, summary: key, text, payload: {} }) });

describe('注册', () => {
  it('只注册已配置 serviceId 的服务;按次 decide 校验输入、produce 交付并记哈希', async () => {
    const db = new DatabaseSync(':memory:'), r = registry();
    const off = registerAspServices({ register: r.register, config: { service_ids: { asset_horizon: '101' } }, handlers: { asset_horizon: assetHorizonService }, channels: {}, serviceDeps: () => deps(), channelContext: () => ({}) as never, db, now: () => NOW });
    expect([...r.handlers.keys()]).toEqual(['service:101']);
    const h = r.handlers.get('service:101')!;
    expect(await h.decide!(task(), {} as never)).toEqual({ accept: true });
    expect(await h.decide!(task({ kind: 'subscription' }), {} as never)).toMatchObject({ accept: false });
    expect(await h.decide!(task({ detail: { description: 'x', serviceParams: { top_n: 99 } } }), {} as never)).toMatchObject({ accept: false, reason: expect.stringContaining('top_n') });
    const out = await h.produce(task(), {} as never);
    expect('text' in out && out.text).toContain('Asset × Horizon Picks');
    expect(db.prepare('SELECT listing, sha256 FROM okx_market_service_result WHERE job_id=?').get('0xabc')).toMatchObject({ listing: 'asset_horizon', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    off(); expect(r.handlers.size).toBe(0);
  });
  it('接单后生成连续失败:前两次抛出交给轮询重试,第三次交付失败说明并记账', async () => {
    const db = new DatabaseSync(':memory:'), r = registry();
    const failing = { ...assetHorizonService, handle: async () => { throw new Error('fetch failed: socket disconnected'); } };
    registerAspServices({ register: r.register, config: { service_ids: { asset_horizon: '101' } }, handlers: { asset_horizon: failing }, channels: {}, serviceDeps: () => deps(), channelContext: () => ({}) as never, db, now: () => NOW });
    const h = r.handlers.get('service:101')!;
    await expect(h.produce(task(), {} as never)).rejects.toThrow(/socket/);
    await expect(h.produce(task(), {} as never)).rejects.toThrow(/socket/);
    const out = await h.produce(task(), {} as never);
    expect('text' in out && out.text).toMatch(/Could not complete[\s\S]*reject this delivery for a refund/);
    expect(db.prepare('SELECT summary FROM okx_market_service_result WHERE job_id=?').get('0xabc')).toMatchObject({ summary: expect.stringContaining('failed') });
  });
  it('长时间生成不阻塞轮询:超过等待上限抛「生成中」(不计失败),完成后下一轮取到结果且只跑一次', async () => {
    const db = new DatabaseSync(':memory:'), r = registry(); let release!: () => void; let runs = 0;
    const slow = { ...assetHorizonService, handle: async (j: PerCallJob, p: never, dd: ServiceDeps) => { runs++; await new Promise<void>((ok) => { release = ok; }); return assetHorizonService.handle(j, p, dd); } };
    registerAspServices({ register: r.register, config: { service_ids: { asset_horizon: '101' } }, handlers: { asset_horizon: slow as never }, channels: {}, serviceDeps: () => deps(), channelContext: () => ({}) as never, db, now: () => NOW, produce_wait_ms: 20 });
    const h = r.handlers.get('service:101')!;
    for (let i = 0; i < 4; i++) await expect(h.produce(task(), {} as never)).rejects.toThrow(/生成中/);
    release();
    const out = await h.produce(task(), {} as never);
    expect('text' in out && out.text).toContain('Asset × Horizon Picks');
    expect(runs).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM okx_market_service_attempt').get()).toEqual({ n: 0 });
  });
  it('分档上架:强制档位并进 service_params,自由文本并入描述', () => {
    const j = jobFromTask(task({ detail: { description: 'BTC 4h 突破', serviceParams: '用 2ATR 止损' } }), LISTINGS.research_full);
    expect(JSON.parse(j.service_params!)).toEqual({ tier: 'full' });
    expect(j.description).toContain('2ATR');
    const k = jobFromTask(task({ detail: { description: 'x', service_params: '{"symbols":["BTC"],"tier":"quick"}' } }), LISTINGS.research_full);
    expect(JSON.parse(k.service_params!)).toEqual({ symbols: ['BTC'], tier: 'full' });
  });
  it('订阅:produce 拼各频道欢迎包;一个频道失败不影响另一个', async () => {
    const db = new DatabaseSync(':memory:'), r = registry();
    const broken: SubscriptionChannel = { ...channel('radar_feed', ''), welcome: async () => { throw new Error('boom'); } };
    registerAspServices({ register: r.register, config: { service_ids: { market_intel: '201' } }, handlers: {}, channels: { market_brief: channel('market_brief', '【行情简报 / Market Brief】 x'), radar_feed: broken }, serviceDeps: () => deps(), channelContext: () => ({}) as never, db, now: () => NOW });
    const h = r.handlers.get('service:201')!;
    expect(await h.decide!(task({ kind: 'subscription' }), {} as never)).toEqual({ accept: true });
    const out = await h.produce(task({ kind: 'subscription' }), {} as never);
    // 主交付是合规信号行(审核按它判「发了信号」),各频道全文作为 follow_up 跟上
    expect('text' in out && out.text).toMatch(/^【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP \| Market brief \| /);
    expect('text' in out && validateSignalText(out.text)).toMatchObject({ ok: true, executable: true });
    expect('follow_up' in out && out.follow_up!.join('\n\n')).toMatch(/Market Brief[\s\S]*radar feed section is temporarily unavailable/);
  });
});

describe('按服务扇出', () => {
  function setup(active: Record<string, unknown>[], provider: Record<string, unknown>[] = [], failDeliver = new Set<string>()) {
    const calls: string[][] = [];
    const runner: CliRunner = async (_b, args) => {
      calls.push(args);
      if (args[1] === 'subscribe-active') return ok(active);
      if (args[1] === 'my-subscriptions') return ok({ list: provider });
      if (args[1] === 'deliver') return failDeliver.has(args[2]!) ? { code: 1, stdout: '', stderr: 'boom' } : ok({ txHash: '0x1' });
      return ok({});
    };
    const kv = new Map<string, string>(), db = new DatabaseSync(':memory:');
    const tick = vi.fn(async (): Promise<ChannelPush | null> => ({ event_id: 'brief:1', channel: 'market_brief', summary: 's', text: '【行情简报 / Market Brief】 ok', payload: {} }));
    const ch: SubscriptionChannel = { key: 'market_brief', every_ms: 30 * 60_000, tick, welcome: async () => { throw new Error('unused'); } };
    const session = vi.fn(async () => {});
    const b = new ServiceBroadcaster({ db, cli: new MarketCli(runner), aspId: async () => '13866', now: () => NOW, kvGet: (k) => kv.get(k) ?? null, kvSet: (k, v) => { kv.set(k, v); }, log: () => {}, ensureSession: session, channelDeps: () => ({}) }, () => [{ service_id: '201', channels: [ch] }]);
    return { b, calls, tick, session, db };
  }
  it('没有该服务的订阅者时不调用 tick(不取数不花钱)', async () => {
    const s = setup([{ jobId: 'j-sig', serviceId: '100' }]);
    await s.b.tick();
    expect(s.tick).not.toHaveBeenCalled();
    expect(s.calls.some((a) => a[1] === 'deliver')).toBe(false);
  });
  it('只推给 serviceId 对得上的 job;缺 serviceId 用 provider 视图补;deliver 前建会话;同 event 不重发', async () => {
    const s = setup([{ jobId: 'j1', serviceId: '201', buyerAgentId: '9' }, { jobId: 'j2' }, { jobId: 'j3', serviceId: '100' }], [{ jobId: 'j2', serviceId: '201', buyerAgentId: '8' }]);
    await s.b.tick();
    // 每个订阅两条:先信号行(【Futures】… ≤200 字),再详情全文
    const delivered = s.calls.filter((a) => a[1] === 'deliver').map((a) => [a[2], a[4]]);
    expect(delivered.map((x) => x[0])).toEqual(['j1', 'j1', 'j2', 'j2']);
    expect(delivered[0]![1]).toMatch(/^【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP \| Market brief \| s \| Info only, no order/);
    expect(validateSignalText(delivered[0]![1]!)).toMatchObject({ ok: true, executable: true });
    expect(delivered[1]![1]).toBe('【行情简报 / Market Brief】 ok');
    expect(s.session.mock.calls).toEqual([['j1', '13866', '9'], ['j2', '13866', '8']]);
    expect(s.b.get('brief:1')).toMatchObject({ service_id: '201', subscribers: ['j1', 'j2'] });
    await s.b.tick(); // 未到 every_ms,不 tick
    expect(s.tick).toHaveBeenCalledTimes(1);
  });
  it('my-subscriptions 失败时逐单 subscribe-detail 补 serviceId,并缓存,下一轮不再查', async () => {
    const calls: string[][] = []; const kv = new Map<string, string>();
    const runner: CliRunner = async (_b, args) => {
      calls.push(args);
      if (args[1] === 'subscribe-active') return ok([{ jobId: 'j1', status: 1 }, { jobId: 'j2', status: 1 }]);
      if (args[1] === 'my-subscriptions') return { code: 1, stdout: '', stderr: 'agenticId is required for subscription requests' };
      if (args[1] === 'subscribe-detail') return ok({ jobId: args[2], serviceId: args[2] === 'j1' ? '201' : '100', buyerAgentId: '9' });
      return ok({});
    };
    const b = new ServiceBroadcaster({ db: new DatabaseSync(':memory:'), cli: new MarketCli(runner), aspId: async () => '13866', now: () => NOW, kvGet: (k) => kv.get(k) ?? null, kvSet: (k, v) => { kv.set(k, v); }, log: () => {}, channelDeps: () => ({}) }, () => []);
    expect(await b.subscribers('13866', '201')).toEqual([{ job: 'j1', buyer: '9' }]);
    const n = calls.length;
    expect(await b.subscribers('13866', '201')).toEqual([{ job: 'j1', buyer: '9' }]);
    expect(calls.slice(n).map((a) => a[1])).toEqual(['subscribe-active']);
  });
  it('信号行派生:各频道都带类型头且 ≤200 字', () => {
    const long = 'x'.repeat(400);
    for (const push of [
      { event_id: 'a', channel: 'market_brief', summary: long, text: 't', payload: { summary_line: 'BTC bullish · ETH bullish' } },
      { event_id: 'b', channel: 'radar_feed', summary: 'Swing tier: 7/10 passed', text: 't', payload: { picks: [{ symbol: 'XPLUSDT' }, { symbol: 'ONDOUSDT' }] } },
      { event_id: 'c', channel: 'micro_alerts', summary: 'BTC: $2.79M liquidated in 15 min', text: 't', payload: { symbol: 'BTCUSDT' } },
    ] as ChannelPush[]) {
      const line = signalFor(push);
      expect(validateSignalText(line)).toMatchObject({ ok: true, executable: true });
      expect(line.endsWith('Info only, no order | Trading Swarm')).toBe(true);
    }
    expect(signalFor({ event_id: 'b', channel: 'radar_feed', summary: 's', text: 't', payload: { picks: [{ symbol: 'XPLUSDT' }] } })).toContain('Top: XPL');
    expect(signalFor({ event_id: 'c', channel: 'micro_alerts', summary: 's', text: 't', payload: { symbol: 'ETHUSDT' } })).toMatch(/^【Futures】ETH-USDT-SWAP \| Microstructure/);
  });
  it('投递失败记 failed 不自动重发;进程重启把 pending 标为结果未知', async () => {
    const s = setup([{ jobId: 'j1', serviceId: '201' }, { jobId: 'j2', serviceId: '201' }], [], new Set(['j2']));
    await s.b.tick();
    const jobs = s.b.get('brief:1')!['jobs'] as { job_id: string; status: string }[];
    expect(jobs.map((j) => [j.job_id, j.status])).toEqual([['j1', 'delivered'], ['j2', 'failed']]);
    s.db.prepare("INSERT INTO okx_market_service_push_job(event_id,job_id,status,updated_at) VALUES ('brief:1','j9','pending',0)").run();
    new ServiceBroadcaster({ db: s.db, cli: new MarketCli(async () => ok([])), aspId: async () => '1', now: () => NOW, kvGet: () => null, kvSet: () => {}, log: () => {}, channelDeps: () => ({}) }, () => []);
    expect(s.db.prepare("SELECT status FROM okx_market_service_push_job WHERE job_id='j9'").get()).toEqual({ status: 'failed' });
  });
  it('失败的投递冷却 5 分钟后自动重发,最多 4 次;成功后不再发', async () => {
    const calls: string[][] = []; let now = NOW; let failing = true;
    const runner: CliRunner = async (_b, args) => {
      calls.push(args);
      if (args[1] === 'subscribe-active') return ok([{ jobId: 'j1', serviceId: '201', buyerAgentId: '9' }]);
      if (args[1] === 'deliver') return failing ? { code: 1, stdout: '', stderr: 'CLI timeout' } : ok({ txHash: '0x1' });
      return ok({});
    };
    const kv = new Map<string, string>(), db = new DatabaseSync(':memory:');
    const ch: SubscriptionChannel = { key: 'market_brief', every_ms: 24 * 3_600_000, tick: async () => ({ event_id: 'brief:r', channel: 'market_brief', summary: 's', text: 'detail', payload: {} }), welcome: async () => { throw new Error('unused'); } };
    const b = new ServiceBroadcaster({ db, cli: new MarketCli(runner), aspId: async () => '13866', now: () => now, kvGet: (k) => kv.get(k) ?? null, kvSet: (k, v) => { kv.set(k, v); }, log: () => {}, channelDeps: () => ({}) }, () => [{ service_id: '201', channels: [ch] }]);
    const delivers = () => calls.filter((a) => a[1] === 'deliver').length;
    await b.tick(); expect(delivers()).toBe(1);
    now += 60_000; await b.tick(); expect(delivers()).toBe(1); // 冷却中
    now += 5 * 60_000; await b.tick(); expect(delivers()).toBe(2);
    failing = false; now += 6 * 60_000; await b.tick();
    expect((b.get('brief:r')!['jobs'] as { status: string; attempts: number }[])[0]).toMatchObject({ status: 'delivered', attempts: 3 });
    expect(delivers()).toBe(4); // 信号行 + 详情
    now += 10 * 60_000; await b.tick(); expect(delivers()).toBe(4);
  });
  it('红线词命中:落账为拒绝,不投递', async () => {
    const s = setup([{ jobId: 'j1', serviceId: '201' }]);
    s.tick.mockResolvedValueOnce({ event_id: 'brief:2', channel: 'market_brief', summary: 's', text: '稳赚不赔', payload: {} });
    await s.b.tick();
    expect(s.b.get('brief:2')).toMatchObject({ refusal: expect.stringContaining('敏感词') });
    expect(s.calls.some((a) => a[1] === 'deliver')).toBe(false);
  });
});

describe('币种归一', () => {
  it('USD / USDC / BUSD 计价写法归到 USDT(复审 09-26:BTCUSD → BTCUSD-USDT-SWAP 51001)', () => {
    for (const x of ['BTCUSD', 'BTC-USD', 'btc/usd', 'BTCUSDC', 'BTC', 'BTCUSDT', 'BTC-USDT-SWAP']) expect(normSymbol(x)).toBe('BTCUSDT');
    expect(symbolsIn('Analyze BTCUSD 1h entry setup')).toEqual(['BTCUSDT']);
  });
});
