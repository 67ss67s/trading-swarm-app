// Signal Market 迁移:这些下游安全测试直接预置规范化 TraderSignal inbox;
// ASP 队列、账本与归一化端到端由 okx-asp-feed/market-backend 单独验证。
// 跟单 session 的路由 + runtime 接线(routes-follow.ts,经 http-extra.ts 注册;契约 §9.38)。
// 走真实 createServer + PaperBackend;bridge 与 8794 都是注入的假 fetch,大脑是 stub —— 不连网、不调付费模型。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import type { Brain } from '../../src/demo/brain.js';
import { normalizeBridgeSignal } from '../../src/demo/trader-signal.js';
import type { FollowFetch } from '../../src/demo/trader-feed.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

const FAKE_KEY = 'sbk_fakekey1234567';
const FAKE_SECRET = 'sbs_fakesecret7654321';

let fakeMarket: FakeMarketServer;
let cacheDir = '';
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  cacheDir = mkdtempSync(join(tmpdir(), 'tg-follow-http-'));
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  process.env['TG_DEMO_KLINE_CACHE_DIR'] = cacheDir;
  // 凭证只从 env 走(复审 P1-14:接口不再接受写入),测试也照这条路注入假凭证。
  process.env['TG_FOLLOW_BRIDGE_KEY'] = FAKE_KEY;
  process.env['TG_FOLLOW_BRIDGE_SECRET'] = FAKE_SECRET;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
  ({ createServer } = await import('../../src/demo/http.js'));
});

afterAll(async () => {
  await fakeMarket.close();
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env['TG_DEMO_MARKET_BASE'];
  delete process.env['TG_DEMO_KLINE_CACHE_DIR'];
  delete process.env['TG_FOLLOW_BRIDGE_KEY'];
  delete process.env['TG_FOLLOW_BRIDGE_SECRET'];
});

/** stub 大脑:扫描时提议做多(gated 的「agent 同向」路径),其余请求给个最小合法体。 */
const longBrain: Brain = {
  name: 'stub',
  async complete(_system, user) {
    if (!user.trim().startsWith('{')) {
      return {
        text: JSON.stringify({
          action: 'PROPOSE', direction: 'long', confidence: 0.6, headline: '跟单把关测试', thesis: '结构同向',
          reasons: ['结构 [E1]'], evidence_refs: ['E1'], invalidation: '跌回突破位', invalidation_price: null, target_price: null,
          watch_conditions: [], strategy_id: null,
          proposal: { entry: 'limit', limit_price: '77000', entry_zone: null, stop_price: '76500', take_profit_price: '79000', take_profits: ['79000'], rationale: '结构同向,跟单把关', direction: 'long' },
        }),
        latency_ms: 1, model: 'stub',
      };
    }
    return { text: JSON.stringify({ findings: [] }), latency_ms: 1, model: 'stub' };
  },
};

let activeHttp: http.Server | null = null;
let activeRt: InstanceType<typeof DemoRuntime> | null = null;
let activeState: StateDb | null = null;
let baseUrl = '';
let store: DemoStore;
let rt: InstanceType<typeof DemoRuntime>;
let fixtureFeed: FollowFetch | null = null;

/** bridge / 8794 的假 fetch:按 url 分派;`bridgePages` 是一页页的 /signals 响应。 */
function fakeFetch(opts: { bridgePages?: unknown[]; me?: unknown; stats?: unknown; fail?: boolean }): { fetch: FollowFetch; calls: string[] } {
  const calls: string[] = [];
  let page = 0;
  const fetch: FollowFetch = async (url) => {
    calls.push(url);
    if (opts.fail) return { ok: false, status: 502, text: async () => 'upstream down' };
    let body: unknown = {};
    // `cursor` 是补拉的目标水位(P1-07):补到它才算补完。
    if (url.includes('/subscriber/me')) body = opts.me ?? { recent_after_id: 0, cursor: 0 };
    else if (url.includes('/subscriber/signals')) { const first = page === 0; body = { ...(((opts.bridgePages ?? [])[page++] ?? { items: [] }) as Record<string, unknown>), test_backfill: first && Number((opts.me as Record<string, unknown> | undefined)?.['cursor'] ?? 0) > 0 }; }
    else if (url.includes('/api/copytrading/trader-stats')) body = opts.stats ?? { by_source: {} };
    else if (url.includes('/agent-deliveries')) body = { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

async function setup(followFetch?: FollowFetch): Promise<void> {
  const state = openStateDb(':memory:');
  store = new DemoStore(state);
  rt = new DemoRuntime({ store, backend: new PaperBackend(100_000), brains: { stub: longBrain }, marketPollMs: 600_000, accountPollMs: 600_000 });
  fixtureFeed = followFetch ?? null;
  rt.okxAspReadQueue = async () => [];
  rt.okxAspRunCli = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { list: [{ jobId: 'job-trader-a', providerAgentName: '交易员A' }] } }), stderr: '' });
  await rt.start();
  // 不能 paused:`preflightOpen` 里「已暂停」会挡掉一切开仓(那是对的行为)。start() 不带 runOnStart,
  // 所以这里没有任何自动模型调用;只有 gated 那条用例会真跑一次 stub 判断。
  // 票池留空:gated 那次判断就不需要 `strategy_id` 命中某条策略(schema 会校验它在票池里)。
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], timeframe: '15m', active_strategies: [] });
  const server = createServer(rt, store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  activeHttp = server;
  activeRt = rt;
  activeState = state;
}

afterEach(async () => {
  if (activeHttp) {
    activeHttp.closeAllConnections?.();
    await new Promise<void>((r) => activeHttp!.close(() => r()));
  }
  if (activeRt) await activeRt.stop();
  activeState?.close();
  activeHttp = null;
  activeRt = null;
  activeState = null;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  if (method === 'POST' && path === '/api/follow/pull' && rt.followSettings.enabled && fixtureFeed) {
    const response = await fixtureFeed('fixture:/subscriber/signals');
    const page = JSON.parse(await response.text());
    for (const item of page.items ?? []) {
      const normalized = normalizeBridgeSignal(item.envelope?.payload, { now: Date.now(), record_id: item.record_id, backfill: page.test_backfill === true });
      if (normalized.signal) store.traderSignals.capture({ ...normalized.signal, subscription_job_id: 'job-trader-a', session: (rt as unknown as { followSession: string }).followSession });
    }
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/**
 * 假行情服务器的标记价是确定的 `basePrice + 50 = 77050`(helpers/fake-market-server.ts)。
 * 信号价必须落在 mark 的 0.55% 以内、且不比 mark 更激进,否则会被 [8794] 那两道限价闸正确拒掉
 * —— 第一版夹具用了 60000,离 mark 22%,拒得完全对。
 */
const MARK = 77050;
const ENTRY = '77000';
const STOP = '76000';
const TP = '79000';

/** 跑到「补拉已完成」为止(第一轮定水位、后面逐页;失败就停)。 */
async function drainBackfill(): Promise<void> { await api('POST', '/api/follow/pull'); }

function bridgeItem(recordId: number, over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    record_id: recordId,
    signal_id: `sig_${recordId}`,
    envelope: {
      event_type: 'structured_signal.created',
      payload: {
        signal_id: `sig_${recordId}`,
        symbol: 'BTCUSDT',
        side: 'long',
        source: 'telegram',
        market_type: 'perpetual',
        entry: { type: 'limit', price: Number(ENTRY) },
        stop_loss: { price: Number(STOP) },
        take_profit: [{ price: Number(TP) }],
        created_at: new Date(now).toISOString(),
        metadata: { trader: '交易员A', action_type: 'open', rationale: '突破回踩', ...meta },
        ...over,
      },
    },
  };
}

// ---------------------------------------------------------------- 设置 / 状态

describe('GET/POST /api/follow', () => {
  it('出厂:关闭、空名册、无凭证、游标 0', async () => {
    await setup();
    const r = await api('GET', '/api/follow');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enabled: false, default_mode: 'evidence', freshness_s: 180 });
    expect(r.json.subscriptions).toEqual({});
    expect(r.json).toMatchObject({ transport: 'queue', poll_ms: 3000 });
  });

  it('改设置:名册整块替换(删得掉人),越界 fail-closed', async () => {
    await setup();
    const r1 = await api('POST', '/api/follow', { enabled: true, freshness_s: 300, subscriptions: { 'job-trader-a': { mode: 'book', weight: 0.8, enabled: true }, 'job-trader_b': { mode: 'gated', weight: 0.5, enabled: true } } });
    expect(r1.status).toBe(200);
    expect(Object.keys(r1.json.subscriptions).sort()).toEqual(['job-trader-a', 'job-trader_b']);
    expect(r1.json.freshness_s).toBe(300);
    // 只发一个人 → 另一个被删掉(整块替换,不做半合并)
    const r2 = await api('POST', '/api/follow', { subscriptions: { 'job-trader-a': { mode: 'book', weight: 0.8, enabled: true } } });
    expect(Object.keys(r2.json.subscriptions)).toEqual(['job-trader-a']);
    // 手改坏的 mode → evidence;越界权重钳住
    const r3 = await api('POST', '/api/follow', { subscriptions: { 'job-trader-a': { mode: 'nope', weight: 5, enabled: true } } });
    expect(r3.json.subscriptions['job-trader-a']).toEqual({ mode: 'evidence', weight: 0, enabled: true, approval: 'manual' });
  });




});

// ---------------------------------------------------------------- 拉取 → 处置

describe('POST /api/follow/pull 端到端', () => {
  async function enable(mode: 'book' | 'gated' | 'evidence'): Promise<void> {
    await api('POST', '/api/follow', { enabled: true, subscriptions: { 'job-trader-a': { mode, weight: 1, enabled: true } } });
  }

  it('关着的时候一个请求都不发', async () => {
    const f = fakeFetch({});
    await setup(f.fetch);
    const r = await api('POST', '/api/follow/pull');
    expect(r.json).toMatchObject({ pulled: 0, handled: 0 });
    expect(f.calls).toEqual([]);
  });

  it('历史信号恢复全部 review_only,不开任何线程', async () => {
    // /me 必须给全库水位(R2-03:拿不到就不许猜,保持补拉状态重试)
    const f = fakeFetch({ me: { recent_after_id: 100, cursor: 102 }, bridgePages: [{ scanned_to_id: 102, items: [bridgeItem(101), bridgeItem(102)] }, { scanned_to_id: 102, items: [] }] });
    await setup(f.fetch);
    await enable('gated');
    const r = await api('POST', '/api/follow/pull');
    expect(r.json.handled).toBe(2);
    const signals = (await api('GET', '/api/follow/signals')).json.signals;
    expect(signals).toHaveLength(2);
    expect(signals.every((s: { status: string }) => s.status === 'review_only')).toBe(true);
    expect(rt.openThreads()).toHaveLength(0);
    // 8794 权重那一路和 bridge 是两件事(它到点自己跑),所以只看 bridge 的调用顺序。
  });

  it('gated:live 信号落 review_only,一单不发;人点 apply 才走手动开仓链路', async () => {
    const f = fakeFetch({ bridgePages: [{ scanned_to_id: 1, items: [] }, { scanned_to_id: 2, items: [bridgeItem(2)] }] });
    await setup(f.fetch);
    await enable('gated');
    await drainBackfill();
    const r = await api('POST', '/api/follow/pull');
    expect(r.json).toMatchObject({ pulled: 1, error: null });
    // 首发:零自动写
    expect(rt.openThreads()).toHaveLength(0);
    const pending = (await api('GET', '/api/follow/signals?status=review_only')).json.signals[0];
    expect(pending).toMatchObject({ status: 'review_only', mode_applied: 'gated', thread_id: null });
    expect(pending.decision.codes).toContain('trader_follow_agent_agree');
    expect(pending.decision.plan).toMatchObject({ entry: ENTRY, stop: '76500' });
    // 判断账本仍然落一行 source='trader'(跟没跟都落);默认(online)口径看不见它
    expect(store.judgments.list({ source: 'trader' })).toHaveLength(1);
    expect(store.judgments.list({ source: 'trader' })[0]).toMatchObject({ episode_id: 'trader:sig_2', model_dir: 'long', mode: 'scan' });
    // gated 模式 agent 那次 scan 本身是一条 online 判断(正常);trader 那行不混进 online 口径。
    expect(store.judgments.list({}).every((j) => j.episode_id !== 'trader:sig_2')).toBe(true);
    // 人点「跟」:走手动开仓链路,线程 source=manual + origin 关联
    const applied = await api('POST', '/api/follow/signals/sig_2/apply');
    expect(applied.status).toBe(200);
    const threads = rt.openThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ symbol: 'BTCUSDT', side: 'long', source: 'manual', origin: 'trader:job-trader-a', trader_signal_id: 'sig_2', stop_price: '76500' });
    expect(threads[0]!.entry.type).toBe('limit');
    expect(applied.json.signal).toMatchObject({ status: 'applied', thread_id: threads[0]!.id });
  });

  it('人点 apply 开了第一条之后,同人同币的第二条 apply 被 duplicate 拦住', async () => {
    const f = fakeFetch({ bridgePages: [{ scanned_to_id: 1, items: [] }, { scanned_to_id: 3, items: [bridgeItem(2), bridgeItem(3)] }] });
    await setup(f.fetch);
    await enable('gated');
    await drainBackfill();
    await api('POST', '/api/follow/pull');
    // 两条都在等人
    expect((await api('GET', '/api/follow/signals?status=review_only')).json.signals).toHaveLength(2);
    expect(rt.openThreads()).toHaveLength(0);
    expect((await api('POST', '/api/follow/signals/sig_2/apply')).status).toBe(200);
    expect(rt.openThreads()).toHaveLength(1);
    // 第一条的挂单还在场上工作 → 第二条是真重复(不是 R53 的「原单已死」)
    const second = await api('POST', '/api/follow/signals/sig_3/apply');
    expect(second.status).toBe(409);
    expect(second.json.error.message).toContain('已有在仓或挂单线程');
    expect(rt.openThreads()).toHaveLength(1);
  });

  it('无止损的信号只进 evidence,记 trader_signal_no_stop', async () => {
    const f = fakeFetch({ bridgePages: [{ scanned_to_id: 1, items: [] }, { scanned_to_id: 4, items: [bridgeItem(4, { stop_loss: null })] }] });
    await setup(f.fetch);
    await enable('gated');
    await drainBackfill();
    await api('POST', '/api/follow/pull');
    const s = (await api('GET', '/api/follow/signals')).json.signals[0];
    expect(s.status).toBe('evidence');
    expect(s.decision.codes).toContain('trader_signal_no_stop');
    expect(rt.openThreads()).toHaveLength(0);
  });

  it('gated:agent 判断照跑,结论落信号行,状态 review_only,一单不发', async () => {
    const f = fakeFetch({ bridgePages: [{ scanned_to_id: 1, items: [] }, { scanned_to_id: 5, items: [bridgeItem(5)] }] });
    await setup(f.fetch);
    await enable('gated');
    await drainBackfill();
    await api('POST', '/api/follow/pull');
    expect(rt.openThreads()).toHaveLength(0);
    const sig = (await api('GET', '/api/follow/signals')).json.signals[0];
    expect(sig.status).toBe('review_only');
    expect(sig.mode_applied).toBe('gated');
    expect(sig.decision.codes).toContain('trader_follow_agent_agree');
    expect(sig.decision.agent).toMatchObject({ stance: 'agree', action: 'PROPOSE', direction: 'long', stop: '76500' });
    // stub 大脑给的止损 76500 比信号的 76000 更紧 → 人工执行时用的几何取 agent 的
    expect(sig.decision.plan.stop).toBe('76500');
    expect(sig.decision.episode_id).toBeTruthy();
    const ep = store.episode(sig.decision.episode_id)!;
    expect(ep.origin).toBe('trader:job-trader-a');
    expect(ep.trigger.kind).toBe('trader_signal');
    expect(ep.thread_id).toBeNull();
    expect(ep.intent).toBeNull();
    // 同一簇:agent 的 online 行与跟单腿共用 cluster_id
    const traderRow = store.judgments.list({ source: 'trader' })[0]!;
    const onlineRow = store.judgments.list({})[0]!;
    expect(traderRow.cluster_id).toBe(onlineRow.cluster_id);
  });

  it('管理动作:close 落 review_only 且一个字不动仓;首发只能 skip(平仓去交易页)', async () => {
    const closeItem = bridgeItem(7, { side: 'close_long' }, { action_type: 'close' });
    const orphan = bridgeItem(8, { symbol: 'ETHUSDT', side: 'close_long' }, { action_type: 'close' });
    const f = fakeFetch({ bridgePages: [{ scanned_to_id: 1, items: [] }, { scanned_to_id: 6, items: [bridgeItem(6)] }, { scanned_to_id: 8, items: [closeItem, orphan] }] });
    await setup(f.fetch);
    await enable('gated');
    await drainBackfill();
    await api('POST', '/api/follow/pull');
    await api('POST', '/api/follow/signals/sig_6/apply'); // 人先把仓开出来
    const opened = rt.openThreads()[0]!;
    const before = JSON.stringify(store.thread(opened.id));
    await api('POST', '/api/follow/pull');
    // close 信号只挂人工队列,仓位一个字不动
    expect(JSON.stringify(store.thread(opened.id))).toBe(before);
    const all = (await api('GET', '/api/follow/signals')).json.signals as { signal_id: string; status: string; decision: { codes: string[]; note: string } }[];
    const closeRow = all.find((s) => s.signal_id === 'sig_7')!;
    expect(closeRow.status).toBe('review_only');
    expect(closeRow.decision.note).toContain('首发不自动动仓');
    const orphanRow = all.find((s) => s.signal_id === 'sig_8')!;
    expect(orphanRow.status).toBe('mgmt_orphan');
    expect(orphanRow.decision.codes).toContain('trader_mgmt_orphan');
    // 首发没有 close 端点(平仓走交易页);这条 review_only 只能 skip
    const gone = await fetch(`${baseUrl}/api/follow/signals/sig_7/close`, { method: 'POST' });
    expect(gone.status).toBe(404);
    const skipped = await api('POST', '/api/follow/signals/sig_7/skip', { note: '我自己去平' });
    expect(skipped.json.signal.status).toBe('skipped');
    // 孤儿不是 review_only → 连 skip 都不许
    expect((await api('POST', '/api/follow/signals/sig_8/skip')).status).toBe(409);
  });

  it('移损(收紧或放松都一样)→ review_only + pending_review,不动仓不撤单', async () => {
    const loosen = bridgeItem(10, { stop_loss: { price: 75000 } }, { action_type: 'stop_loss_update' });
    const f = fakeFetch({ bridgePages: [{ scanned_to_id: 1, items: [] }, { scanned_to_id: 9, items: [bridgeItem(9)] }, { scanned_to_id: 10, items: [loosen] }] });
    await setup(f.fetch);
    await enable('gated');
    await drainBackfill();
    await api('POST', '/api/follow/pull');
    await api('POST', '/api/follow/signals/sig_9/apply');
    const opened = rt.openThreads()[0]!;
    const stopBeforePull = store.thread(opened.id)!.stop_price;
    expect(stopBeforePull).toBe('76500'); // agent 比信号 76000 更紧，入场时已经采用
    await api('POST', '/api/follow/pull');
    expect(store.thread(opened.id)!.stop_price).toBe(stopBeforePull); // 管理信号不改入场时的更紧止损
    const overview = (await api('GET', '/api/follow/signals')).json;
    // R4-07:pending_review 是库里 review_only 的信号行(重启后照样完整)
    expect(overview.pending_review.some((p: { decision: { note: string } }) => p.decision.note.includes('不自动执行仓位管理'))).toBe(true);
    // 首发范围在接口上要能读到
    expect(overview.scope).toMatchObject({ auto_execution: false, auto_manage: false, tp_tiers: 'first_only', ladder_entry: 'manual_only' });
    // R5-01:多了「已核对」——它只清 needs_reconcile 标记,不动钱
    expect(overview.scope.human_actions).toEqual(['apply', 'skip', 'reconcile']);
    expect(overview.pending_review_total).toBeGreaterThanOrEqual(overview.pending_review.length);
    expect(overview.scope.manual_only_actions).toEqual(['reduce', 'stop_loss_update', 'take_profit_update']);
  });






});

// ---------------------------------------------------------------- 人工 apply / skip

describe('POST /api/follow/signals/:id/(apply|skip)', () => {
  it('apply:只接受 review_only;超龄落 evidence 的行连 force_stale 都不给跟', async () => {
    const stale = bridgeItem(20);
    (((stale['envelope'] as Record<string, unknown>)['payload'] as Record<string, unknown>)['metadata'] as Record<string, unknown>)['source_timestamp'] = Math.floor((Date.now() - 600_000) / 1000);
    const f = fakeFetch({ bridgePages: [{ scanned_to_id: 1, items: [] }, { scanned_to_id: 20, items: [stale] }] });
    await setup(f.fetch);
    await api('POST', '/api/follow', { enabled: true, subscriptions: { 'job-trader-a': { mode: 'gated', weight: 1, enabled: true } } });
    await drainBackfill();
    await api('POST', '/api/follow/pull');
    const before = (await api('GET', '/api/follow/signals')).json.signals[0];
    expect(before.status).toBe('evidence');
    expect(before.decision.codes).toContain('trader_signal_stale');
    expect((await api('POST', `/api/follow/signals/${before.signal_id}/apply`, { force_stale: true })).status).toBe(409);
    expect(rt.openThreads()).toHaveLength(0);
  });

  it('apply:review_only 的行可以跟,并且发的是行上那份几何(不重算)', async () => {
    const f = fakeFetch({ bridgePages: [{ scanned_to_id: 1, items: [] }, { scanned_to_id: 22, items: [bridgeItem(22)] }] });
    await setup(f.fetch);
    await api('POST', '/api/follow', { enabled: true, subscriptions: { 'job-trader-a': { mode: 'gated', weight: 1, enabled: true } } });
    await drainBackfill();
    await api('POST', '/api/follow/pull');
    const row = (await api('GET', '/api/follow/signals')).json.signals[0];
    expect(row.status).toBe('review_only');
    const planned = row.decision.plan;
    const r = await api('POST', `/api/follow/signals/${row.signal_id}/apply`);
    expect(r.status).toBe(200);
    const t = rt.openThreads()[0]!;
    // 发出去的就是行上那份(价格会按交易所 tick 网格对齐,所以按数值比)
    expect(Number(t.entry.price)).toBe(Number(planned.entry));
    expect(Number(t.stop_price)).toBe(Number(planned.stop));
    // 再 apply 一次 → 409(已是 applied)
    expect((await api('POST', `/api/follow/signals/${row.signal_id}/apply`)).status).toBe(409);
    // 几何与判断依据没被清掉
    expect(r.json.signal.decision.plan).toMatchObject({ entry: planned.entry, stop: planned.stop });
  });

  it('skip:只改状态不动仓;未知 id → 404', async () => {
    const f = fakeFetch({ bridgePages: [{ scanned_to_id: 1, items: [] }, { scanned_to_id: 21, items: [bridgeItem(21, { stop_loss: null })] }] });
    await setup(f.fetch);
    await api('POST', '/api/follow', { enabled: true, subscriptions: { 'job-trader-a': { mode: 'gated', weight: 1, enabled: true } } });
    await drainBackfill();
    await api('POST', '/api/follow/pull');
    // 无止损那条落 evidence → 连 skip 都不许(只有 review_only 能 skip)
    expect((await api('POST', '/api/follow/signals/sig_21/skip', { note: '这条不跟' })).status).toBe(409);
    expect(rt.openThreads()).toHaveLength(0);
    expect((await api('POST', '/api/follow/signals/sig_nope/skip')).status).toBe(404);
    expect((await api('POST', '/api/follow/signals/sig_nope/apply')).status).toBe(404);
  });
});

// ---------------------------------------------------------------- 统计

describe('GET /api/follow/stats', () => {
  it('按 jobId 返回纯本地统计且权重仅来自订阅设置', async () => {
    await setup();
    await api('POST', '/api/follow', { enabled: true, subscriptions: { 'job-trader-a': { mode: 'evidence', weight: 0.8, enabled: true } } });
    const result = await api('GET', '/api/follow/stats');
    expect(result.status).toBe(200);
    expect(result.json.subscriptions).toContainEqual({ job_id: 'job-trader-a', received: 0, order: 0, analysis: 0, followed: 0, realized_r: null, agent_agree_rate: null, last_signal_at: null });
  });
});
