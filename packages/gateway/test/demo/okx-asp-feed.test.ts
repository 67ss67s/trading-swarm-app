// OKX.AI ASP 订阅信号源(src/demo/okx-asp-feed.ts,设计 docs/design/okx-asp-follow-2026-09-20.md §1.3)。
// 全部注入:假队列 + 假 CLI —— 不读真库、不 spawn 任何二进制、不连网。
// 最后一条是端到端:假队列两行 → 真 runtime tick → store.traderSignals 里出现 transport='okx_asp' 的行。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import type { Brain } from '../../src/demo/brain.js';
import {
  OkxAspFeed,
  OKX_ASP_SEEN_KEY,
  OKX_ASP_RAW_PREFIX,
  findJsonObjects,
  normMs,
  normalizeAspSignal,
  pickSignal,
  type OkxCliRunner,
  type QueueRow,
} from '../../src/demo/okx-asp-feed.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

/** 最小可用的一条 ASP order 信号。 */
function signalObj(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { deliveryId: 'dlv-1', signal_type: 'order', symbol: 'BTC-USDT-SWAP', action: 'LONG', price: 77000, stop_loss: 76000, take_profit: 79000, signalTime: NOW - 5_000, ...over };
}

function row(over: Partial<QueueRow> = {}): QueueRow {
  return { id: '1', job_id: 'job-abcdef123456', message_id: 'msg-1', content: JSON.stringify(signalObj()), llm_content: null, payload_json: null, created_at: new Date(NOW).toISOString(), ...over };
}

/** 进程内 kv(跟 trader-feed 测试同一套路)。 */
function memKv(): { kvGet(k: string): string | null; kvSet(k: string, v: string): void; map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, kvGet: (k) => map.get(k) ?? null, kvSet: (k, v) => void map.set(k, v) };
}

function feedOf(rows: QueueRow[] | (() => Promise<QueueRow[]>), runCli?: OkxCliRunner): { feed: OkxAspFeed; kv: ReturnType<typeof memKv>; logs: string[] } {
  const kv = memKv();
  const logs: string[] = [];
  const feed = new OkxAspFeed({
    kv,
    now: () => NOW,
    readQueue: typeof rows === 'function' ? rows : async () => rows,
    ...(runCli ? { runCli } : { runCli: (async () => ({ code: 1, stdout: '', stderr: 'no cli' })) as OkxCliRunner }),
    log: (level, message) => void logs.push(`${level}:${message}`),
  });
  return { feed, kv, logs };
}

// ---------------------------------------------------------------- JSON 抽取

describe('findJsonObjects / pickSignal', () => {
  it('人类文本里夹着的多个顶层对象都能扫出来', () => {
    const text = `播报一下 {"a":1} 然后 {"deliveryId":"d1","signal_type":"order"} 完毕`;
    expect(findJsonObjects(text)).toHaveLength(2);
    expect(pickSignal(text)).toMatchObject({ deliveryId: 'd1' });
  });

  it('字符串里的花括号不算边界(不然边界会算错)', () => {
    const text = `{"deliveryId":"d1","note":"涨到 {目标} 就走","signal_type":"order"}`;
    expect(findJsonObjects(text)).toEqual([text]);
    expect(pickSignal(text)).toMatchObject({ note: '涨到 {目标} 就走' });
  });

  it('信号被包一层信封时取内层那个(外层没有 deliveryId)', () => {
    const text = JSON.stringify({ type: 'push', signal_type: 'wrapper', data: { deliveryId: 'd9', signal_type: 'order', symbol: 'ETH-USDT-SWAP' } });
    expect(pickSignal(text)).toMatchObject({ deliveryId: 'd9', symbol: 'ETH-USDT-SWAP' });
  });

  it('没有信号线索的 JSON / 半截 JSON 都不认', () => {
    expect(pickSignal('{"hello":"world"}')).toBeNull();
    expect(pickSignal('{"deliveryId":"d1"')).toBeNull();
    expect(pickSignal('')).toBeNull();
  });
});

// ---------------------------------------------------------------- 时间自适应

describe('normMs', () => {
  it('秒 / 毫秒 / 微秒 / ISO 都收', () => {
    expect(normMs(1_758_369_600)).toBe(1_758_369_600_000);
    expect(normMs(1_758_369_600_000)).toBe(1_758_369_600_000);
    expect(normMs(1_758_369_600_000_000)).toBe(1_758_369_600_000);
    expect(normMs('2026-09-20T12:00:00Z')).toBe(NOW);
  });

  it('无时区的串按 UTC 解(按本机时区会整整偏几小时)', () => {
    expect(normMs('2026-09-20 12:00:00')).toBe(NOW);
  });

  it('认不出的返回 null', () => {
    expect(normMs('昨天')).toBeNull();
    expect(normMs(0)).toBeNull();
    expect(normMs(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- 归一化

describe('normalizeAspSignal', () => {
  const ctx = { now: NOW, trader: 'ASP 测试', raw_text: 'raw', created_at: new Date(NOW).toISOString() };

  it('order 信号:符号映射、动作映射、价格、止损止盈都落到位', () => {
    const r = normalizeAspSignal(signalObj(), ctx);
    expect(r.signal).toMatchObject({
      signal_id: 'okxasp_dlv-1', symbol: 'BTCUSDT', side: 'long', action: 'open',
      entry_kind: 'limit', entry_prices: ['77000'], stop: '76000', transport: 'okx_asp', market_type: 'perp',
      trader: 'ASP 测试', published_at: NOW - 5_000, backfill: false, status: 'new',
    });
    expect(r.signal?.tps).toEqual([{ price: '79000', pct: null }]);
    expect(r.errors).toEqual([]);
  });

  it('analysis 类不入跟单流(errors 以 analysis: 开头,不是坏行)', () => {
    const r = normalizeAspSignal(signalObj({ signal_type: 'analysis' }), ctx);
    expect(r.signal).toBeNull();
    expect(r.errors[0]).toMatch(/^analysis:/);
  });

  it('动作映射全表', () => {
    const cases: [string, string, string | null][] = [
      ['LONG', 'open', 'long'], ['BUY', 'open', 'long'], ['SHORT', 'open', 'short'], ['SELL', 'open', 'short'],
      ['CLOSE', 'close', null], ['EXIT', 'close', null], ['FLAT', 'close', null],
      ['REDUCE', 'reduce', null], ['TP', 'reduce', null], ['PARTIAL', 'reduce', null], ['ADD', 'add', null],
    ];
    for (const [raw, action, side] of cases) {
      const r = normalizeAspSignal(signalObj({ action: raw }), ctx);
      expect(r.signal?.action, raw).toBe(action);
      expect(r.signal?.side, raw).toBe(side);
    }
  });

  it('close 的方向从 direction 补(关联线程要用)', () => {
    expect(normalizeAspSignal(signalObj({ action: 'CLOSE', direction: 'short' }), ctx).signal?.side).toBe('short');
  });

  it('认不出的动作 / 没有 symbol → 坏行(返回 null,不抛)', () => {
    expect(normalizeAspSignal(signalObj({ action: 'YOLO' }), ctx).signal).toBeNull();
    expect(normalizeAspSignal(signalObj({ symbol: undefined, instId: undefined }), ctx).signal).toBeNull();
    expect(() => normalizeAspSignal('不是对象', ctx)).not.toThrow();
    expect(normalizeAspSignal(null, ctx).signal).toBeNull();
  });

  it('符号:instId / 现货写法 / 已是规范写法都映射成 BTCUSDT', () => {
    for (const s of ['BTC-USDT-SWAP', 'BTC-USDT', 'BTCUSDT']) {
      expect(normalizeAspSignal(signalObj({ symbol: s }), ctx).signal?.symbol).toBe('BTCUSDT');
    }
    expect(normalizeAspSignal(signalObj({ symbol: undefined, instId: 'ETH-USDT-SWAP' }), ctx).signal?.symbol).toBe('ETHUSDT');
  });

  it('时间:signalTime 坏掉时退回队列行 created_at;都没有 → 坏行', () => {
    const late = normalizeAspSignal(signalObj({ signalTime: '不是时间' }), ctx);
    expect(late.signal?.published_at).toBe(NOW);
    const none = normalizeAspSignal(signalObj({ signalTime: undefined }), { ...ctx, created_at: null });
    expect(none.signal).toBeNull();
  });

  it('未来太多的时间不采信(否则以 0 秒龄过掉新鲜度闸)', () => {
    const r = normalizeAspSignal(signalObj({ signalTime: NOW + 10 * 60_000 }), ctx);
    expect(r.signal?.published_at).toBe(NOW);
    expect(r.errors.join()).toMatch(/未来/);
  });

  it('valid_until 早于原发时间 → invalid_validity(不当成无期限)', () => {
    const r = normalizeAspSignal(signalObj({ valid_until: NOW - 60_000 }), ctx);
    expect(r.signal?.invalid_validity).toBe(true);
    const ok = normalizeAspSignal(signalObj({ validUntil: NOW + 60_000 }), ctx);
    expect(ok.signal).toMatchObject({ invalid_validity: false, valid_until: NOW + 60_000 });
  });

  it('can_enter=false → review_only(走现有 backfill 语义,永不自动开仓)', () => {
    expect(normalizeAspSignal(signalObj({ can_enter: false }), ctx).signal?.backfill).toBe(true);
    expect(normalizeAspSignal(signalObj({ is_executable: false }), ctx).signal?.backfill).toBe(true);
    // 字段缺失是「没说」,不是拒绝。
    expect(normalizeAspSignal(signalObj(), ctx).signal?.backfill).toBe(false);
  });

  it('sz / leverage 只留痕不进仓位', () => {
    const r = normalizeAspSignal(signalObj({ sz: '3', leverage: '20' }), ctx);
    expect(r.signal?.size_pct).toBeNull();
    expect(r.signal?.raw_text).toMatch(/sz=3 leverage=20/);
  });

  it('没有 deliveryId 时按原文哈希出稳定 id', () => {
    const a = normalizeAspSignal(signalObj({ deliveryId: undefined }), ctx);
    const b = normalizeAspSignal(signalObj({ deliveryId: undefined }), ctx);
    expect(a.signal?.signal_id).toMatch(/^okxasp_[0-9a-f]{24}$/);
    expect(a.signal?.signal_id).toBe(b.signal?.signal_id);
  });

  it('deliveryId 形状不合法(带空格/凭证形状)→ 退回哈希,不让脏 id 进库', () => {
    const r = normalizeAspSignal(signalObj({ deliveryId: 'sbk_abcdefgh 你好' }), ctx);
    expect(r.signal?.signal_id).toMatch(/^okxasp_[0-9a-f]{24}$/);
  });
});

// ---------------------------------------------------------------- poll

describe('OkxAspFeed.poll', () => {
  it('一行 order → 一条信号,计数落 kv', async () => {
    const { feed } = feedOf([row()]);
    const r = await feed.poll();
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]).toMatchObject({ symbol: 'BTCUSDT', transport: 'okx_asp' });
    expect(feed.status()).toMatchObject({ available: true, seen: 1, ingested: 1, skipped_analysis: 0, bad_rows: 0 });
  });

  it('同一个 message_id 轮两次只入一次', async () => {
    const { feed, kv } = feedOf([row()]);
    expect((await feed.poll()).signals).toHaveLength(1);
    expect((await feed.poll()).signals).toHaveLength(0);
    expect(JSON.parse(kv.kvGet(OKX_ASP_SEEN_KEY)!)).toEqual(['msg-1']);
  });

  it('没有 message_id 的行按 row-<id> 去重', async () => {
    const { feed, kv } = feedOf([row({ message_id: null, id: '77' })]);
    await feed.poll();
    expect(JSON.parse(kv.kvGet(OKX_ASP_SEEN_KEY)!)).toEqual(['row-77']);
  });

  it('已见集合 FIFO 淘汰(上限 5000)', async () => {
    const { feed, kv } = feedOf([row()]);
    kv.kvSet(OKX_ASP_SEEN_KEY, JSON.stringify(Array.from({ length: 5000 }, (_, i) => `old-${i}`)));
    await feed.poll();
    const seen = JSON.parse(kv.kvGet(OKX_ASP_SEEN_KEY)!) as string[];
    expect(seen).toHaveLength(5000);
    expect(seen[0]).toBe('old-1'); // 最老的被挤掉
    expect(seen.at(-1)).toBe('msg-1');
  });

  it('content 挑不出就扫 llm_content / payload_json', async () => {
    const { feed } = feedOf([row({ content: '今天先观望', llm_content: null, payload_json: JSON.stringify(signalObj({ deliveryId: 'd-pj' })) })]);
    const r = await feed.poll();
    expect(r.signals[0]?.signal_id).toBe('okxasp_d-pj');
  });

  it('挑不出信号的行留痕、不算坏行', async () => {
    const { feed, kv } = feedOf([row({ content: '大盘不错,先看看' })]);
    const r = await feed.poll();
    expect(r.signals).toHaveLength(0);
    expect(r.bad_rows).toBe(0);
    expect(kv.kvGet(`${OKX_ASP_RAW_PREFIX}msg-1`)).toMatch(/大盘不错/);
  });

  it('analysis 只计数并留摘要,不入流', async () => {
    const { feed } = feedOf([row({ content: JSON.stringify(signalObj({ signal_type: 'analysis' })) })]);
    const r = await feed.poll();
    expect(r.signals).toHaveLength(0);
    expect(r.skipped_analysis).toBe(1);
    expect(feed.status().skipped_recent[0]).toMatchObject({ message_id: 'msg-1', signal_type: 'analysis' });
  });

  it('坏行不抛、留原文、计数,后面的好行照常入流', async () => {
    const { feed, kv } = feedOf([
      row({ id: '1', message_id: 'bad', content: JSON.stringify(signalObj({ action: 'YOLO' })) }),
      row({ id: '2', message_id: 'good', content: JSON.stringify(signalObj({ deliveryId: 'd2' })) }),
    ]);
    const r = await feed.poll();
    expect(r.bad_rows).toBe(1);
    expect(r.signals.map((s) => s.signal_id)).toEqual(['okxasp_d2']);
    expect(kv.kvGet(`${OKX_ASP_RAW_PREFIX}bad`)).toMatch(/认不出/);
  });

  it('读不到库:不抛、退避推起来、连续失败封顶 60s', async () => {
    const { feed, logs } = feedOf(async () => {
      throw new Error('找不到 a2a 投递库(okx-a2a daemon 还没跑起来?)');
    });
    const r = await feed.poll();
    expect(r.error).toMatch(/找不到 a2a 投递库/);
    expect(feed.status()).toMatchObject({ available: false, failures: 1 });
    expect(feed.ready()).toBe(false);
    expect(feed.status().next_attempt_at).toBe(NOW + 5_000);
    // 退避窗口内再调只回 error,不会再打一次库。
    expect((await feed.poll()).error).toBe('退避窗口内');
    expect(logs.filter((l) => l.startsWith('warn'))).toHaveLength(1);
  });

  it('runCli 失败不影响轮询(订阅列表空着,信号照入)', async () => {
    const { feed } = feedOf([row()], async () => ({ code: 1, stdout: '', stderr: 'onchainos: command not found' }));
    const r = await feed.poll();
    expect(r.signals).toHaveLength(1);
    expect(feed.status().subscriptions).toEqual([]);
    expect(feed.status().subscriptions_error).not.toBeNull();
    // 订阅名查不到 → `ASP <job_id 前 8 位>`
    expect(r.signals[0]?.trader).toBe('ASP job-abcd');
  });
});

// ---------------------------------------------------------------- 订阅 / 三盏灯

describe('subscriptions / accountLights', () => {
  const subsCli: OkxCliRunner = async (bin, args) => {
    if (bin === 'onchainos' && args[0] === 'agent') {
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { list: [{ jobId: 'job-abcdef123456', serviceName: 'BTC 短线', providerAgentName: '张三 ASP', status: 'ACTIVE', periodEnd: '2026-10-20' }] } }), stderr: '' };
    }
    if (bin === 'onchainos') return { code: 0, stdout: JSON.stringify({ ok: true, data: { loggedIn: true, email: 'a@b.com', currentAccountName: 'Account 1' } }), stderr: '' };
    return { code: 0, stdout: 'running pid=54129', stderr: '' };
  };

  it('订阅名映射到带单员名', async () => {
    const { feed } = feedOf([row()], subsCli);
    const r = await feed.poll();
    expect(r.signals[0]?.trader).toBe('张三 ASP');
    expect(feed.status().subscriptions[0]).toMatchObject({ job_id: 'job-abcdef123456', title: 'BTC 短线', status: 'ACTIVE', period_end: '2026-10-20' });
  });

  it('订阅列表缓存 60s(第二次不再 spawn)', async () => {
    let calls = 0;
    const { feed } = feedOf([row()], async (...args) => {
      calls++;
      return subsCli(...args);
    });
    await feed.subscriptions();
    await feed.subscriptions();
    expect(calls).toBe(1);
    expect((await feed.subscriptions(true)).length).toBe(1);
    expect(calls).toBe(2);
  });

  it('三盏灯:钱包 / 守护 / Trade Kit,缓存 30s', async () => {
    let calls = 0;
    const kv = memKv();
    const feed = new OkxAspFeed({
      kv, now: () => NOW, readQueue: async () => [], log: () => {},
      tradeKit: () => ({ ok: true, detail: 'profile demo' }),
      runCli: async (...args) => {
        calls++;
        return subsCli(...args);
      },
    });
    const lights = await feed.accountLights();
    expect(lights.wallet).toMatchObject({ ok: true, detail: 'a@b.com · Account 1', checked_at: NOW });
    expect(lights.a2a).toMatchObject({ ok: true, detail: 'running pid=54129' });
    expect(lights.trade_kit).toMatchObject({ ok: true, detail: 'profile demo' });
    const before = calls;
    await feed.accountLights();
    expect(calls).toBe(before);
    await feed.accountLights(true);
    expect(calls).toBeGreaterThan(before);
  });

  it('守护没跑 / 钱包没登录 → 灯灭,并给一行怎么点亮', async () => {
    const { feed } = feedOf([], async (bin) => (bin === 'okx-a2a' ? { code: 1, stdout: '', stderr: 'not running' } : { code: 0, stdout: JSON.stringify({ ok: true, data: { loggedIn: false } }), stderr: '' }));
    const lights = await feed.accountLights();
    expect(lights.a2a.ok).toBe(false);
    expect(lights.a2a.detail).toMatch(/okx-a2a daemon start/);
    expect(lights.wallet.ok).toBe(false);
    expect(lights.wallet.detail).toMatch(/onchainos wallet login/);
  });
});

// ---------------------------------------------------------------- 端到端(真 runtime)

describe('端到端:假队列 → runtime tick → 跟单信号流', () => {
  let fakeMarket: FakeMarketServer;
  let cacheDir = '';
  let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
  let createServer: typeof import('../../src/demo/http.js').createServer;
  let server: http.Server | null = null;
  let state: StateDb | null = null;
  let rt: InstanceType<typeof import('../../src/demo/runtime.js').DemoRuntime> | null = null;

  const stubBrain: Brain = { name: 'stub', async complete() { return { text: JSON.stringify({ findings: [] }), latency_ms: 1, model: 'stub' }; } };

  beforeAll(async () => {
    fakeMarket = await startFakeMarketServer();
    cacheDir = mkdtempSync(join(tmpdir(), 'tg-okxasp-'));
    process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
    process.env['TG_DEMO_KLINE_CACHE_DIR'] = cacheDir;
    ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
    ({ createServer } = await import('../../src/demo/http.js'));
  });

  afterAll(async () => {
    await fakeMarket.close();
    rmSync(cacheDir, { recursive: true, force: true });
    delete process.env['TG_DEMO_MARKET_BASE'];
    delete process.env['TG_DEMO_KLINE_CACHE_DIR'];
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    if (rt) await rt.stop();
    state?.close();
    rt = null;
    state = null;
  });

  it('两行 order → 两条 transport=okx_asp 的信号,状态是 review_only', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state);
    rt = new DemoRuntime({ store, backend: new PaperBackend(100_000), brains: { stub: stubBrain }, marketPollMs: 600_000, accountPollMs: 600_000 });
    // 注入点要在第一次 okxAspFeed() 之前设(实例是单例)。
    // `can_enter:false` = ASP 明说「这条不可入场」→ 走 backfill 语义 → 一律 review_only。
    const now = Date.now();
    rt.okxAspReadQueue = async () => [
      { id: '1', job_id: 'job-1', message_id: 'm1', content: `播报 ${JSON.stringify({ deliveryId: 'e2e-1', signal_type: 'order', symbol: 'BTC-USDT-SWAP', action: 'LONG', price: 77000, stop_loss: 76000, signalTime: now - 1000, can_enter: false })}`, llm_content: null, payload_json: null, created_at: new Date(now).toISOString() },
      { id: '2', job_id: 'job-1', message_id: 'm2', content: JSON.stringify({ deliveryId: 'e2e-2', signal_type: 'order', symbol: 'ETH-USDT-SWAP', action: 'SHORT', price: 4000, stop_loss: 4100, signalTime: now - 1000, can_enter: false }), llm_content: null, payload_json: null, created_at: new Date(now).toISOString() },
    ];
    rt.okxAspRunCli = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { list: [{ jobId: 'job-1', serviceName: '测试服务', providerAgentName: '测试 ASP', status: 'ACTIVE' }] } }), stderr: '' });
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], active_strategies: [] });
    // 跟单开 + ASP 开 + 名册里有这个 ASP(不在名册只会 skipped,看不出 review_only)。
    rt.setWorkflow({ follow: { enabled: true, subscriptions: { 'job-1': { mode: 'gated', weight: 0.5, enabled: true } } } });
    expect(rt.followSettings.poll_ms).toBe(3000);

    const r = await rt.okxAspTick();
    expect(r.error).toBeNull();
    expect(r.pulled).toBe(2);
    expect(r.handled).toBe(2);

    const rows = store.traderSignals.list({ limit: 50 });
    expect(rows).toHaveLength(2);
    expect(rows.every((s) => s.transport === 'okx_asp')).toBe(true);
    expect(rows.every((s) => s.status === 'review_only')).toBe(true);
    expect(rows.map((s) => s.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(rows.every((s) => s.trader === '测试 ASP')).toBe(true);

    // 再拉一次:去重,不会变成四条。
    const again = await rt.okxAspTick();
    expect(again.pulled).toBe(0);
    expect(store.traderSignals.list({ limit: 50 })).toHaveLength(2);

    // followTick 也顺带跑 ASP(设计 §1.2「现有跟单 tick 里额外 poll」)。
    const tick = await rt.followTick();
    expect(tick.okx_asp).toMatchObject({ pulled: 0, error: null });
  });

  it('三个路由:状态 / 手动拉一次 / 三盏灯', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state);
    rt = new DemoRuntime({ store, backend: new PaperBackend(100_000), brains: { stub: stubBrain }, marketPollMs: 600_000, accountPollMs: 600_000 });
    const now = Date.now();
    rt.okxAspReadQueue = async () => [{ id: '1', job_id: 'job-1', message_id: 'r1', content: JSON.stringify({ deliveryId: 'r-1', signal_type: 'order', symbol: 'BTC-USDT-SWAP', action: 'LONG', price: 77000, stop_loss: 76000, signalTime: now - 1000, can_enter: false }), llm_content: null, payload_json: null, created_at: new Date(now).toISOString() }];
    rt.okxAspRunCli = async (bin, args) => {
      if (bin === 'okx-a2a') return { code: 0, stdout: 'running pid=1', stderr: '' };
      if (args[0] === 'agent') return { code: 0, stdout: JSON.stringify({ ok: true, data: { list: [{ jobId: 'job-1', serviceName: 'S', providerAgentName: '测试 ASP', status: 'ACTIVE' }] } }), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { loggedIn: true, email: 'a@b.com', currentAccountName: 'Account 1' } }), stderr: '' };
    };
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', active_strategies: [] });
    rt.setWorkflow({ follow: { enabled: true, poll_ms: 1500, subscriptions: { 'job-1': { mode: 'gated', weight: 0.5, enabled: true } } } });
    server = createServer(rt, store);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (path: string): Promise<{ status: number; json: Record<string, unknown> }> => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    const s0 = await get('/api/follow/okx-asp');
    expect(s0.status).toBe(200);
    expect(s0.json).toMatchObject({ enabled: true, poll_ms: 1500 });
    expect((s0.json['okx_asp'] as Record<string, unknown>)['subscriptions']).toHaveLength(1);

    const pull = await fetch(`${base}/api/follow/okx-asp/poll`, { method: 'POST' });
    const pulled = (await pull.json()) as Record<string, unknown>;
    expect(pull.status).toBe(200);
    expect(pulled).toMatchObject({ pulled: 1, handled: 1, error: null });
    expect(store.traderSignals.list({ limit: 10 })[0]).toMatchObject({ transport: 'okx_asp', status: 'review_only' });

    const acct = await get('/api/okx/account');
    expect(acct.status).toBe(200);
    expect(acct.json['wallet']).toMatchObject({ ok: true });
    expect(acct.json['a2a']).toMatchObject({ ok: true });
    expect(acct.json['trade_kit']).toHaveProperty('checked_at');
  });

  it('enabled 关着时一行都不拉', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state);
    rt = new DemoRuntime({ store, backend: new PaperBackend(100_000), brains: { stub: stubBrain }, marketPollMs: 600_000, accountPollMs: 600_000 });
    let reads = 0;
    rt.okxAspReadQueue = async () => {
      reads++;
      return [];
    };
    await rt.start();
    rt.setWorkflow({ follow: { enabled: false } });
    expect(rt.followSettings.enabled).toBe(false);
    expect(await rt.okxAspTick()).toMatchObject({ pulled: 0, error: null });
    expect(reads).toBe(0);
  });
});
