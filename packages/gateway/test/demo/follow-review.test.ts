// Signal Market 迁移:这些下游安全测试直接预置规范化 TraderSignal inbox;
// ASP 队列、账本与归一化端到端由 okx-asp-feed/market-backend 单独验证。
// 跟单 session:对抗复审(内部评审记录)「测试缺口」那一节点名的分支。
// 一条用例对一条编号,标题里写清是哪一条 —— 以后有人改回去,失败信息能直接说出违反了哪条结论。
// 零网络、零模型:bridge/8794 是注入的假 fetch,后端是 PaperBackend,大脑是 stub。

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import type { Brain } from '../../src/demo/brain.js';
import { newThread } from '../../src/demo/threads.js';
import type { StrategyThread } from '../../src/demo/types.js';
import { normalizeBridgeSignal, timestampOf, defaultSignalRowId, isExpired, MAX_CLOCK_SKEW_MS, type TraderSignal } from '../../src/demo/trader-signal.js';
import { TraderFollow, DEFAULT_FOLLOW_SETTINGS, resolveMode, routeManagement, type FollowDeps, type FollowSettings, type ManagementResult } from '../../src/demo/trader-follow.js';
import { TraderFeed, redactDeep, redactSecrets, type FollowFetch } from '../../src/demo/trader-feed.js';
import { traderLedgerRow } from '../../src/demo/judgment-ledger.js';
import { DEFAULT_WEIGHT_THRESHOLDS, parseTraderStats, staleWeightOf, weightFor, type TraderStatsSnapshot } from '../../src/demo/trader-stats.js';
import { makeEvent } from '../../src/demo/events.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

const FAKE_KEY = 'sbk_reviewkey12345';
const FAKE_SECRET = 'sbs_reviewsecret12345';
/** 假行情服务器的标记价是确定的 basePrice+50。 */
const MARK = 77050;
const ENTRY = '77000';
const STOP = '76000';
const TP = '79000';

let fakeMarket: FakeMarketServer;
let cacheDir = '';
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  cacheDir = mkdtempSync(join(tmpdir(), 'tg-follow-review-'));
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  process.env['TG_DEMO_KLINE_CACHE_DIR'] = cacheDir;
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

// ---------------------------------------------------------------- 纯函数/存储层的缺口

describe('缺口 12:时区与未来时间', () => {
  it('无时区字符串按 UTC 解析,不跟着宿主时区漂', () => {
    // Asia/Singapore 上 Date.parse 会把它当本地时间(偏 -8h),负时区则偏向未来
    expect(timestampOf('2026-09-13T08:00:00')).toBe(Date.parse('2026-09-13T08:00:00Z'));
    expect(timestampOf('2026-09-13 08:00:00')).toBe(Date.parse('2026-09-13T08:00:00Z'));
    expect(timestampOf('2026-09-13')).toBe(Date.parse('2026-09-13T00:00:00Z'));
    // 带时区的照原样
    expect(timestampOf('2026-09-13T08:00:00+08:00')).toBe(Date.parse('2026-09-13T08:00:00+08:00'));
    expect(timestampOf('2026-09-13T08:00:00Z')).toBe(Date.parse('2026-09-13T08:00:00Z'));
  });

  it('超过时钟偏差的未来 published_at 当坏行(不让旧信号以 0 秒龄过闸)', () => {
    const now = Date.parse('2026-09-13T08:00:00Z');
    const payload = (meta: Record<string, unknown>): Record<string, unknown> => ({
      signal_id: 'sig_future', symbol: 'BTCUSDT', side: 'long', source: 'telegram',
      entry: { type: 'limit', price: 77000 }, stop_loss: { price: 76000 },
      created_at: new Date(now + 86_400_000).toISOString(),
      metadata: { trader: '交易员A', action_type: 'open', ...meta },
    });
    // 唯一的时间来源在未来一天 → 定不出 published_at → 坏行
    const bad = normalizeBridgeSignal(payload({}), { now });
    expect(bad.signal).toBeNull();
    expect(bad.errors.join()).toContain('未来');
    // 时钟偏差之内的未来照收(bridge 与本机差几十秒是常态)
    const ok = normalizeBridgeSignal(payload({ source_timestamp: (now + MAX_CLOCK_SKEW_MS / 2) / 1000 }), { now });
    expect(ok.signal).not.toBeNull();
  });

  it('valid_until 早于 published_at:隔离成「已过期」,**不删约束**(二审 P1-12)', () => {
    const now = Date.parse('2026-09-13T08:00:00Z');
    const expired = now - 7200_000;
    const r = normalizeBridgeSignal({
      signal_id: 'sig_bad_valid', symbol: 'BTCUSDT', side: 'long', source: 'telegram',
      entry: { type: 'limit', price: 77000 }, stop_loss: { price: 76000 },
      valid_until: new Date(expired).toISOString(),
      created_at: new Date(now).toISOString(),
      metadata: { trader: '交易员A', action_type: 'open' },
    }, { now });
    // 第一版把它改成 null → 一条本来「已过期」的信号变成「没有有效期」可以开仓
    expect(r.signal!.valid_until).toBe(expired);
    expect(r.signal!.invalid_validity).toBe(true);
    expect(r.errors.join()).toContain('期限不可信');
    // 走到判定层就是 expired,只能进 evidence
    const decision = resolveMode({ signal: r.signal!, follow: settings(), stats: null, now });
    expect(decision.status).toBe('expired');
    expect(decision.mode).toBe('evidence');
  });

  it('R3-07:非法 valid_until 字符串不许变成「没有期限」;倒置期限不靠碰巧过期', () => {
    const now = Date.parse('2026-09-13T08:00:00Z');
    const mk = (validUntil: unknown, publishedOffset = 0): ReturnType<typeof normalizeBridgeSignal> => normalizeBridgeSignal({
      signal_id: 'sig_bad_v', symbol: 'BTCUSDT', side: 'long', source: 'telegram',
      entry: { type: 'limit', price: 77000 }, stop_loss: { price: 76000 },
      valid_until: validUntil,
      created_at: new Date(now).toISOString(),
      metadata: { trader: '交易员A', action_type: 'open', source_timestamp: (now + publishedOffset) / 1000 },
    }, { now });
    // 解析不出来的期限:第一版 timestampOf → null,等于把约束删掉,信号照样能开
    const garbage = mk('下周之前');
    expect(garbage.signal!.invalid_validity).toBe(true);
    expect(resolveMode({ signal: garbage.signal!, follow: settings(), stats: null, now }).status).toBe('expired');
    // 倒置但**还没过期**的那种(published_at=now+20s、valid_until=now+10s):
    // 不能靠 isExpired 碰巧拦住 —— 它此刻是 false
    const inverted = mk(new Date(now + 10_000).toISOString(), 20_000);
    expect(isExpired(inverted.signal!, now)).toBe(false);
    expect(inverted.signal!.invalid_validity).toBe(true);
    expect(resolveMode({ signal: inverted.signal!, follow: settings(), stats: null, now }).status).toBe('expired');
    // 正常期限不受影响
    const ok = mk(new Date(now + 600_000).toISOString());
    expect(ok.signal!.invalid_validity).toBe(false);
  });

  it('原发时间在场但坏掉 → 整条拒,不退回 created_at 当新信号(二审 P1-12)', () => {
    const now = Date.parse('2026-09-13T08:00:00Z');
    const mk = (ts: unknown): ReturnType<typeof normalizeBridgeSignal> => normalizeBridgeSignal({
      signal_id: 'sig_badts', symbol: 'BTCUSDT', side: 'long', source: 'telegram',
      entry: { type: 'limit', price: 77000 }, stop_loss: { price: 76000 },
      created_at: new Date(now).toISOString(),
      metadata: { trader: '交易员A', action_type: 'open', source_timestamp: ts },
    }, { now });
    // 解析不出来
    expect(mk('昨天下午').signal).toBeNull();
    expect(mk('昨天下午').errors.join()).toContain('不退回 created_at');
    // 在未来
    expect(mk((now + 86_400_000) / 1000).signal).toBeNull();
    // 没有这个字段时才允许退回 created_at
    const fallback = normalizeBridgeSignal({
      signal_id: 'sig_ok', symbol: 'BTCUSDT', side: 'long', source: 'telegram',
      entry: { type: 'limit', price: 77000 }, stop_loss: { price: 76000 },
      created_at: new Date(now).toISOString(),
      metadata: { trader: '交易员A', action_type: 'open' },
    }, { now });
    expect(fallback.signal!.published_at).toBe(now);
  });
});

describe('缺口 16:持久化 round-trip、碰撞 ID、迁移幂等', () => {
  function freshStore(): { store: DemoStore; state: StateDb; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tg-follow-rt-'));
    const state = openStateDb(join(dir, 'state.sqlite'));
    return { store: new DemoStore(state), state, dir };
  }

  const sigOf = (over: Partial<TraderSignal> = {}): TraderSignal => {
    const now = Date.parse('2026-09-13T08:00:00Z');
    const r = normalizeBridgeSignal({
      signal_id: 'sig_rt', symbol: 'BTCUSDT', side: 'long', source: 'telegram', market_type: 'futures',
      entry: { type: 'limit', price: 77000 }, stop_loss: { price: 76000 }, take_profit: [{ price: 79000 }],
      created_at: new Date(now).toISOString(),
      metadata: { trader: '交易员A', action_type: 'open', target_order_ref: '昨天那单', order_end_state: 'not_ended' },
    }, { now, backfill: true });
    return { ...r.signal!, subscription_job_id: 'job-trader-a', ...over };
  };

  it('backfill / ref_order / market_type / transport / order_end_state 读回来还在', () => {
    const { store, state, dir } = freshStore();
    try {
      const sig = sigOf();
      expect(sig.backfill).toBe(true);
      store.traderSignals.capture(sig);
      const back = store.traderSignals.get(sig.id)!;
      // 第一版这几个字段只活在内存里,读回来是 false/null/'perpetual'/'' —— 于是重启后
      // 「这条是补拉的」这个事实丢了,补拉的管理动作会被当实时的去动仓(P0-02 的放大器)。
      expect(back.backfill).toBe(true);
      expect(back.ref_order).toBe('昨天那单');
      expect(back.order_end_state).toBe('not_ended');
      expect(back.market_type).toBe('futures');
      expect(back.transport).toBe('telegram');
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('两个不同 signal_id 不会撞成同一个主键', () => {
    const { store, state, dir } = freshStore();
    try {
      // 第一版是「去掉非法字符再截 48 位」:abc.x 与 abcx 会撞
      expect(defaultSignalRowId('abc.x')).not.toBe(defaultSignalRowId('abcx'));
      const long1 = `sig_${'a'.repeat(60)}1`;
      const long2 = `sig_${'a'.repeat(60)}2`;
      expect(defaultSignalRowId(long1)).not.toBe(defaultSignalRowId(long2));
      const a = sigOf({ signal_id: 'abc.x', id: defaultSignalRowId('abc.x') });
      const b = sigOf({ signal_id: 'abcx', id: defaultSignalRowId('abcx') });
      expect(store.traderSignals.capture(a).created).toBe(true);
      // 撞主键时这里会抛 PRIMARY KEY 冲突(ON CONFLICT(signal_id) 兜不住),整页处理被挡住
      expect(store.traderSignals.capture(b).created).toBe(true);
      expect(store.traderSignals.count()).toBe(2);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('迁移重复启动幂等,trader 行的 source 列由触发器维护且不污染默认统计', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-follow-mig-'));
    const path = join(dir, 'state.sqlite');
    try {
      const first = openStateDb(path);
      new DemoStore(first);
      first.close();
      // 第二次打开:同一批迁移不该再跑一遍(schema_migrations 记过了)
      const second = openStateDb(path);
      const store = new DemoStore(second);
      const row = traderLedgerRow({ signal_id: 'sig_led', symbol: 'BTCUSDT', side: 'long', at: Date.now(), snapshot: null, thread_id: null, episode_id: null });
      store.judgments.save(row);
      // 默认(online)口径看不见跟单腿;按 source 查得到
      expect(store.judgments.list({})).toHaveLength(0);
      expect(store.judgments.count({})).toBe(0);
      expect(store.judgments.list({ source: 'trader' })).toHaveLength(1);
      // 再 save 一次(UPDATE OF json)source 列仍然是 trader
      store.judgments.save({ ...row, settle_note: '改一下' });
      expect(store.judgments.list({ source: 'trader' })).toHaveLength(1);
      expect(store.judgments.list({ source: 'all' })).toHaveLength(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- 编排层的缺口(假 deps)

describe('缺口 1/5/11:编排的授权、等待期变化与执行确认', () => {
  function harness(opts: { follow: () => FollowSettings; threads?: StrategyThread[]; actionResult?: ManagementResult; openThreadId?: string } = { follow: () => settings() }) {
    const dir = mkdtempSync(join(tmpdir(), 'tg-follow-h-'));
    const state = openStateDb(join(dir, 'state.sqlite'));
    const store = new DemoStore(state);
    const calls: string[] = [];
    let threads = opts.threads ?? [];
    const deps: FollowDeps = {
      follow: opts.follow,
      stats: () => null,
      signals: {
        capture: (s) => store.traderSignals.capture(s),
        save: (s) => store.traderSignals.save(s),
        find: (id) => store.traderSignals.find(id),
        openingsSince: (t, since) => store.traderSignals.openingsSince(t, since),
        claimForApply: (id, owner, claimId, now) => store.traderSignals.claimForApply(id, owner, claimId, now),
        claimStillOwned: (id, claimId) => store.traderSignals.claimStillOwned(id, claimId),
        saveIfOwned: (sig, claimId) => store.traderSignals.saveIfOwned(sig, claimId),
        clearNeedsReconcile: (id, now) => store.traderSignals.clearNeedsReconcile(id, now),
      },
      now: () => NOW,
      liveThreads: () => threads,
      markOf: async () => MARK,
      symbolSupported: async () => true,
      openFromSignal: async () => {
        calls.push('open');
        const t = threadOf({ id: opts.openThreadId ?? 'thr_new', status: 'in_position', opened_at: NOW, filled_avg_price: ENTRY });
        threads = [...threads, t];
        return { outcome: 'opened' as const, thread_id: t.id, reason: '' };
      },
      manualOpen: async () => {
        calls.push('manual_open');
        const t = threadOf({ id: 'thr_manual', status: 'in_position', opened_at: NOW, filled_avg_price: ENTRY, source: 'manual' });
        threads = [...threads, t];
        return { outcome: 'opened' as const, thread_id: t.id, reason: '' };
      },
      judge: async () => {
        calls.push('judge');
        return { episode_id: 'ep_1', action: 'PROPOSE', direction: 'long', stop: null, blocked: [], error: null };
      },
      closeThread: async (id) => (calls.push(`close:${id}`), opts.actionResult ?? { ok: true, detail: '已平' }),
      cancelEntries: async (id) => (calls.push(`cancel:${id}`), opts.actionResult ?? { ok: true, detail: '已撤' }),
      recordLedger: () => void calls.push('ledger'),
      emit: () => {},
      log: () => {},
      pendingReview: () => void calls.push('pending_review'),
    };
    return { follow: new TraderFollow(deps), store, calls, close: () => { state.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it('R4-07:copy 的 add 也落 review_only(带几何),不自动开仓', async () => {
    const h = harness({ follow: () => settings({}, { mode: 'book' }) });
    try {
      const r = await h.follow.ingest(sig({ action: 'add', signal_id: 'sig_add', id: 'tsig_add' }));
      // 首发口径:含 copy 的 open/add 都等人工 —— 提前 skipped 会让人在界面上点不了跟
      expect(r.signal.status).toBe('review_only');
      expect(r.signal.decision?.codes).toContain('trader_add_manual');
      expect(r.signal.decision?.plan).toMatchObject({ entry: ENTRY, stop: STOP });
      expect(r.signal.thread_id).toBeNull();
      expect(h.calls).not.toContain('open');
      expect(h.calls).not.toContain('manual_open');
    } finally {
      h.close();
    }
  });

  it('缺口 5(人工路径):apply 之前授权被撤销 → 拒绝开仓', async () => {
    for (const [mutate, expected] of [
      [() => settings({}, { mode: 'evidence' }), 'evidence 模式'],
      [() => settings({}, { weight: 0 }), '权重'],
      [() => settings({ enabled: false }), '总开关'],
    ] as const) {
      const current = { value: settings() };
      const h = harness({ follow: () => current.value });
      try {
        await h.follow.ingest(sig({ signal_id: 'sig_auth', id: 'tsig_auth' }));
        current.value = mutate();
        const r = await h.follow.applyManually('sig_auth', { force_stale: true });
        // 要么在 apply 的前置检查里被拒,要么在发送前那道 authorize 里被拒 —— 两种都不许开出线程
        expect(r.signal?.status).not.toBe('applied');
        void expected;
        void r;
      } finally {
        h.close();
      }
    }
  });

  it('缺口 5(自动路径,目前关着):等待期间改配置也不会开 —— 首发本来就一单不发', async () => {
    for (const mutate of [
      () => settings({}, { mode: 'evidence' }),
      () => settings({}, { weight: 0 }),
      () => settings({ enabled: false }),
    ]) {
      const current = { value: settings({}, { mode: 'book' }) };
      const h = harness({ follow: () => current.value });
      try {
        // 处理进行中把设置换掉(模拟模型跑了 20 秒、这期间人改了设置)
        const p = h.follow.ingest(sig({ signal_id: 'sig_mut', id: 'tsig_mut' }));
        current.value = mutate();
        const r = await p;
        // 首发一单不发,所以最坏也只是 review_only;绝不会变成 applied
        expect(r.signal.status).not.toBe('applied');
        expect(h.calls).not.toContain('open');
        expect(h.calls).not.toContain('manual_open');
      } finally {
        h.close();
      }
    }
  });

  it('缺口 5:等待期间信号过了 valid_until → 不开', async () => {
    const h = harness({ follow: () => settings({ freshness_s: 86_400 }) });
    try {
      // valid_until 已经过去(判断之后才发现):发送前那道重校验要拦住
      const r = await h.follow.ingest(sig({ signal_id: 'sig_exp', id: 'tsig_exp', valid_until: NOW - 1000 }));
      expect(r.signal.status).not.toBe('applied');
      expect(h.calls).not.toContain('open');
    } finally {
      h.close();
    }
  });

  it('R4-03:人工 apply 明确失败 → apply_failed,几何与 agent 结论不丢', async () => {
    const h = harness({ follow: () => settings() });
    try {
      await h.follow.ingest(sig({ signal_id: 'sig_af', id: 'tsig_af' }));
      // 让 manualOpen 失败
      const deps = (h.follow as unknown as { deps: FollowDeps }).deps;
      deps.manualOpen = async () => ({ outcome: 'rejected' as const, reason: '名义超上限' });
      const r = await h.follow.applyManually('sig_af');
      expect(r.signal!.status).toBe('apply_failed');
      expect(r.signal!.decision?.plan).toBeTruthy();
      expect(r.error).toContain('名义');
    } finally {
      h.close();
    }
  });

  it('缺口 6:补拉的管理动作即便有在仓线程也不动仓', async () => {
    const t = threadOf({ status: 'in_position', opened_at: NOW, filled_avg_price: ENTRY });
    const h = harness({ follow: () => settings(), threads: [t] });
    try {
      const r = await h.follow.ingest(sig({ action: 'close', backfill: true, signal_id: 'sig_bf', id: 'tsig_bf' }));
      expect(r.signal.status).toBe('review_only');
      expect(h.calls.some((c) => c.startsWith('close:'))).toBe(false);
      expect(h.calls).toContain('pending_review');
    } finally {
      h.close();
    }
  });

  it('缺口 6:迟到很久的管理动作也不自动动仓', async () => {
    const t = threadOf({ status: 'in_position', opened_at: NOW, filled_avg_price: ENTRY });
    const h = harness({ follow: () => settings(), threads: [t] });
    try {
      const r = await h.follow.ingest(sig({ action: 'close', published_at: NOW - 3_600_000, signal_id: 'sig_late', id: 'tsig_late' }));
      expect(r.signal.status).toBe('review_only');
      expect(h.calls.some((c) => c.startsWith('close:'))).toBe(false);
    } finally {
      h.close();
    }
  });

  it('缺口 4:agent 同向但那次判断被闸拒 → 不开,记 trader_gate_blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-follow-g-'));
    const state = openStateDb(join(dir, 'state.sqlite'));
    const store = new DemoStore(state);
    const calls: string[] = [];
    const deps: FollowDeps = {
      follow: () => settings({}, { mode: 'gated' }),
      stats: () => null,
      signals: {
        capture: (s) => store.traderSignals.capture(s),
        save: (s) => store.traderSignals.save(s),
        find: (id) => store.traderSignals.find(id),
        openingsSince: (t, since) => store.traderSignals.openingsSince(t, since),
      },
      now: () => NOW,
      liveThreads: () => [],
      markOf: async () => MARK,
      symbolSupported: async () => true,
      openFromSignal: async () => (calls.push('open'), { outcome: 'opened' as const, thread_id: 'thr_x', reason: '' }),
      manualOpen: async () => (calls.push('manual_open'), { outcome: 'opened' as const, thread_id: 'thr_x', reason: '' }),
      // 模型给了同向 PROPOSE,但那次 episode 被策略共识闸拒了(reducer 不接受)
      judge: async () => ({ episode_id: 'ep_blocked', action: 'PROPOSE', direction: 'long', stop: null, blocked: ['策略共识(没有达到 2 票同向)'], error: null }),
      closeThread: async () => ({ ok: true, detail: '' }),
      cancelEntries: async () => ({ ok: true, detail: '' }),
      recordLedger: () => {},
      emit: () => {},
      log: () => {},
    };
    try {
      const r = await new TraderFollow(deps).ingest(sig({ signal_id: 'sig_gate', id: 'tsig_gate' }));
      expect(r.signal.status).toBe('skipped');
      expect(r.signal.decision?.codes).toContain('trader_gate_blocked');
      expect(r.signal.decision?.note).toContain('策略共识');
      expect(calls).not.toContain('open');
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缺口 2:阶梯信号转人工,不开仓', async () => {
    const h = harness({ follow: () => settings() });
    try {
      const r = await h.follow.ingest(sig({ signal_id: 'sig_lad', id: 'tsig_lad', entry_kind: 'ladder', entry_prices: ['76500', '77000', '77200'] }));
      expect(r.signal.status).toBe('review_only');
      expect(r.signal.decision?.note).toContain('阶梯');
      expect(h.calls).not.toContain('open');
      expect(h.calls).toContain('pending_review');
    } finally {
      h.close();
    }
  });

  it('缺口 7:落库后处理崩掉的行仍是 new,再投同一条会接着处理(不被「见过即跳过」永久跳过)', async () => {
    const h = harness({ follow: () => settings() });
    try {
      const incoming = sig({ signal_id: 'sig_resume', id: 'tsig_resume' });
      // 模拟「上一轮落了库、处理前崩了」:库里有 new 行,但没有 decision
      h.store.traderSignals.capture(incoming);
      expect(h.store.traderSignals.get(incoming.id)!.status).toBe('new');
      const r = await h.follow.ingest(incoming);
      expect(r.note).not.toContain('幂等');
      expect(r.signal.status).toBe('review_only'); // 首发:处置完就是等人
      // 终态之后再投才算幂等
      const again = await h.follow.ingest(incoming);
      expect(again.note).toContain('幂等');
      expect(h.calls.filter((c) => c === 'open' || c === 'manual_open')).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('缺口 15:重复开仓被拒时不借用别人线程的 realized(账本 thread_id 留空)', async () => {
    const t = threadOf({ id: 'thr_first', status: 'in_position', opened_at: NOW, filled_avg_price: ENTRY });
    const dir = mkdtempSync(join(tmpdir(), 'tg-follow-dup-'));
    const state = openStateDb(join(dir, 'state.sqlite'));
    const store = new DemoStore(state);
    const seen: { thread_id: string | null }[] = [];
    const deps: FollowDeps = {
      follow: () => settings(),
      stats: () => null,
      signals: {
        capture: (s) => store.traderSignals.capture(s),
        save: (s) => store.traderSignals.save(s),
        find: (id) => store.traderSignals.find(id),
        openingsSince: (tr, since) => store.traderSignals.openingsSince(tr, since),
        claimForApply: (id, owner, claimId, now) => store.traderSignals.claimForApply(id, owner, claimId, now),
        claimStillOwned: (id, claimId) => store.traderSignals.claimStillOwned(id, claimId),
        saveIfOwned: (sig, claimId) => store.traderSignals.saveIfOwned(sig, claimId),
        clearNeedsReconcile: (id, now) => store.traderSignals.clearNeedsReconcile(id, now),
      },
      now: () => NOW,
      liveThreads: () => [t],
      markOf: async () => MARK,
      symbolSupported: async () => true,
      openFromSignal: async () => ({ outcome: 'rejected' as const, reason: '不该走到这' }),
      manualOpen: async () => ({ outcome: 'rejected' as const, reason: '不该走到这' }),
      judge: async () => ({ episode_id: null, action: null, direction: null, stop: null, blocked: [], error: null }),
      closeThread: async () => ({ ok: true, detail: '' }),
      cancelEntries: async () => ({ ok: true, detail: '' }),
      recordLedger: (_s, ctx) => void seen.push({ thread_id: ctx.thread_id }),
      emit: () => {},
      log: () => {},
    };
    try {
      const r = await new TraderFollow(deps).ingest(sig({ signal_id: 'sig_dup2', id: 'tsig_dup2' }));
      expect(r.signal.decision?.codes).toContain('trader_duplicate_open');
      // 第一版把 dup.thread.id 传给账本 → 多条没执行的信号去蹭同一笔仓的收益
      expect(seen).toEqual([{ thread_id: null }]);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- runtime 接线的缺口

const stubBrain: Brain = {
  name: 'stub',
  async complete(_system, user) {
    if (!user.trim().startsWith('{')) {
      return {
        text: JSON.stringify({
          action: 'PROPOSE', direction: 'long', confidence: 0.6, headline: '跟单复审测试', thesis: '结构同向',
          reasons: ['结构 [E1]'], evidence_refs: ['E1'], invalidation: '跌回', invalidation_price: null, target_price: null,
          watch_conditions: [], strategy_id: null,
          proposal: { entry: 'limit', limit_price: ENTRY, entry_zone: null, stop_price: '76500', take_profit_price: TP, take_profits: [TP], rationale: 'r', direction: 'long' },
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

async function setup(followFetch: FollowFetch): Promise<void> {
  const state = openStateDb(':memory:');
  store = new DemoStore(state);
  rt = new DemoRuntime({ store, backend: new PaperBackend(100_000), brains: { stub: stubBrain }, marketPollMs: 600_000, accountPollMs: 600_000 });
  fixtureFeed = followFetch;
  rt.okxAspReadQueue = async () => [];
  rt.okxAspRunCli = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { list: [{ jobId: 'job-trader-a', providerAgentName: '交易员A' }] } }), stderr: '' });
  await rt.start();
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
  // Downstream safety tests seed durable normalized signals. ASP transport parsing is covered separately.
  if (method === 'POST' && path === '/api/follow/pull' && rt.followSettings.enabled && fixtureFeed) {
    const response = await fixtureFeed('fixture:/subscriber/signals');
    if (!response.ok) throw new Error(await response.text());
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

function item(recordId: number, over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_id: recordId,
    signal_id: `sig_${recordId}`,
    envelope: {
      payload: {
        signal_id: `sig_${recordId}`, symbol: 'BTCUSDT', side: 'long', source: 'telegram', market_type: 'perpetual',
        entry: { type: 'limit', price: Number(ENTRY) }, stop_loss: { price: Number(STOP) }, take_profit: [{ price: Number(TP) }],
        created_at: new Date().toISOString(),
        metadata: { trader: '交易员A', action_type: 'open', rationale: '突破回踩', ...meta },
        ...over,
      },
    },
  };
}

/** 假 bridge:pages 是一页页的 /signals 响应;`me` 给起点与目标水位。 */
function bridge(pages: unknown[], me: Record<string, unknown> = { recent_after_id: 0, cursor: 0 }): { fetch: FollowFetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetch: FollowFetch = async (url) => {
    calls.push(url);
    let body: unknown = {};
    if (url.includes('/subscriber/me')) body = me;
    else if (url.includes('/subscriber/signals')) { const first = i === 0; body = { ...((pages[i++] ?? { items: [] }) as Record<string, unknown>), test_backfill: first && Number(me['cursor']) > 0 }; }
    else if (url.includes('trader-stats')) body = { by_source: {} };
    else body = { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

async function enableFollow(mode: 'book' | 'gated' = 'copy'): Promise<void> {
  await api('POST', '/api/follow', { enabled: true, subscriptions: { 'job-trader-a': { mode, weight: 1, enabled: true } } });
}
async function drain(): Promise<void> { await api('POST', '/api/follow/pull'); }

describe('缺口 3/7/8/10:runtime 接线', () => {
  it('缺口 3:市价意图信号能真的开出线程(不被普通限价的激进度闸拒掉)', async () => {
    const market = item(2, { entry: { type: 'market' } });
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 2, items: [market] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    // 首发一单不发;人点 apply 才开
    expect(rt.openThreads()).toHaveLength(0);
    const pending = (await api('GET', '/api/follow/signals?status=review_only')).json.signals[0];
    expect(pending.decision.plan.intent).toBe('market');
    expect((await api('POST', `/api/follow/signals/${pending.signal_id}/apply`)).status).toBe(200);
    const threads = rt.openThreads();
    expect(threads).toHaveLength(1);
    // 顶着 BTC 0.3% 滑点上限的限价
    expect(Number(threads[0]!.entry.price)).toBeCloseTo(MARK * 1.003, 0);
  });





  it('缺口 7:处理崩掉的行下一轮被 resumeInbox 领回来', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    // 手工塞一条 new 行(= 上一轮落库成功、处理前崩了)
    const now = Date.now();
    const norm = normalizeBridgeSignal((item(50)['envelope'] as Record<string, unknown>)['payload'], { now, record_id: 50 });
    store.traderSignals.capture(norm.signal!);
    expect(store.traderSignals.get(norm.signal!.id)!.status).toBe('new');
    const r = await api('POST', '/api/follow/pull');
    expect(r.json.handled).toBeGreaterThan(0);
    // 重放会把它处置完 —— 首发的「处置完」就是 review_only,不是开仓
    expect(store.traderSignals.get(norm.signal!.id)!.status).toBe('review_only');
    expect(rt.openThreads()).toHaveLength(0);
  });

  it('首发范围:reduce 端到端也只进人工队列,线程一个字不动', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 60, items: [item(60)] }, { scanned_to_id: 61, items: [item(61, {}, { action_type: 'reduce', rationale: '减 50%' })] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    await api('POST', '/api/follow/signals/sig_60/apply');
    const opened = rt.openThreads()[0]!;
    const before = JSON.stringify(store.thread(opened.id));
    await api('POST', '/api/follow/pull');
    const sig = (await api('GET', '/api/follow/signals?action=reduce')).json.signals[0];
    expect(sig.status).toBe('review_only');
    expect(sig.decision.note).toContain('不自动执行仓位管理');
    // 线程完全没被动过(版本号、数量、止损、止盈一个字没改)
    expect(JSON.stringify(store.thread(opened.id))).toBe(before);
    const overview = { pending_review: (await api('GET', '/api/follow/signals?status=review_only')).json.signals };
    expect(overview.pending_review.some((p: { signal_id: string }) => p.signal_id === 'sig_61')).toBe(true);
  });

  it('首发范围:分档止盈只挂第一档,线程与 API 上如实标 tp_partial_unsupported', async () => {
    const multi = item(65, { take_profit: [{ price: 79000 }, { price: 81000, pct: 70 }] });
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 65, items: [multi] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    await api('POST', '/api/follow/signals/sig_65/apply');
    const t = rt.openThreads()[0]!;
    // 只有第一档进了线程(第一版把三档都写进去,保护腿按第一档挂**全仓** TP)
    expect(t.take_profits).toEqual([TP]);
    expect(t.tp_partial_unsupported).toBeTruthy();
    expect(t.tp_partial_unsupported!.placed).toBe(TP);
    expect(t.tp_partial_unsupported!.dropped.map((d) => d.price)).toEqual(['81000']);
    const overview = await api('GET', '/api/overview');
    const shown = overview.json.threads.find((x: { id: string }) => x.id === t.id);
    expect(shown.tp_partial_unsupported.dropped).toHaveLength(1);
  });

  it('缺口 15:人工 apply 之后账本那一行补上执行关联', async () => {
    // 新鲜信号 → review_only + 账本 thread_id=null,apply 之后补上
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 70, items: [item(70)] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    const row = store.judgments.get('trader:sig_70');
    expect(row).not.toBeNull();
    expect(row!.thread_id).toBeNull();
    const applied = await api('POST', '/api/follow/signals/sig_70/apply');
    expect(applied.status).toBe(200);
    expect(store.judgments.get('trader:sig_70')!.thread_id).toBe(applied.json.signal.thread_id);
  });

  it('缺口 15:补拉信号的账本行不带快照(不拿今天的指标评昨天)', async () => {
    const old = item(80);
    ((((old['envelope'] as Record<string, unknown>)['payload'] as Record<string, unknown>)['metadata']) as Record<string, unknown>)['source_timestamp'] = Math.floor((Date.now() - 86_400_000) / 1000);
    const f = bridge([{ scanned_to_id: 80, items: [old] }, { scanned_to_id: 80, items: [] }], { recent_after_id: 0, cursor: 80 });
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    const row = store.judgments.get('trader:sig_80');
    expect(row).not.toBeNull();
    expect(row!.snapshot).toBeNull();
    expect(row!.settle_note).toContain('不可评分');
    // at 是决策时刻(不是 published_at),否则 horizon 从昨天起算、快照是今天的 = 前视
    expect(row!.at).toBeGreaterThan(Date.now() - 120_000);
  });
});

// ---------------------------------------------------------------- 夹具

const NOW = Date.parse('2026-09-13T08:00:00Z');

function settings(over: Partial<FollowSettings> = {}, traderOver: Partial<FollowSettings['subscriptions'][string]> = {}): FollowSettings {
  return {
    ...DEFAULT_FOLLOW_SETTINGS,
    enabled: true,
    subscriptions: { 'job-trader-a': { mode: 'gated', weight: 1, enabled: true, ...traderOver } },
    ...over,
  };
}

function sig(over: Partial<TraderSignal> = {}): TraderSignal {
  const r = normalizeBridgeSignal({
    signal_id: 'sig_h', symbol: 'BTCUSDT', side: 'long', source: 'telegram',
    entry: { type: 'limit', price: Number(ENTRY) }, stop_loss: { price: Number(STOP) }, take_profit: [{ price: Number(TP) }],
    created_at: new Date(NOW).toISOString(),
    metadata: { trader: '交易员A', action_type: 'open', rationale: '突破回踩' },
  }, { now: NOW });
  return { ...r.signal!, subscription_job_id: 'job-trader-a', ...over };
}

function threadOf(over: Partial<StrategyThread> = {}): StrategyThread {
  return {
    ...newThread({
      id: 'thr_h', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'trader', timeframe: '15m',
      thesis: '跟单', invalidation_text: null, watch_conditions: [],
      entry: { type: 'limit', price: ENTRY, zone: null }, stop_price: STOP, take_profits: [TP],
      qty: '0.01', margin_usdt: '200', leverage: 3, margin_mode: 'cross', now: NOW,
    }),
    origin: 'trader:job-trader-a',
    trader_signal_id: 'sig_h',
    ...over,
  };
}

// ---------------------------------------------------------------- 二审 R2-01~R2-06 的分支

describe('R2-01/02/03/06:串行、恢复、会话边界、撤单确认', () => {
  it('R2-01:人工 apply 的账户写排进 runtime 那条真队列(不是跟单自己的链)', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 90, items: [item(90)] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    // 占住队列:apply 的下单必须排在它后面,不能并发
    const order: string[] = [];
    let release = (): void => {};
    const blocked = new Promise<void>((r) => (release = r));
    rt.queue.enqueue({ key: 'test:hog', kind: 'manual', symbol: 'BTCUSDT', run: async () => { await blocked; order.push('hog'); } });
    const applying = api('POST', '/api/follow/signals/sig_90/apply');
    await new Promise((r) => setTimeout(r, 30));
    expect(rt.openThreads()).toHaveLength(0); // 队列被占着 → 还没下单
    release();
    const applied = await applying;
    order.push('follow');
    expect(order).toEqual(['hog', 'follow']);
    expect(applied.status).toBe(200);
    expect(rt.openThreads()).toHaveLength(1);
  });

  it('R2-02:已发出未确认(triggered)的行不重放,转人工;未开始(new)的才重放', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    const now = Date.now();
    // 一条「已发出未确认」:上次崩在「交易所收到了、我们没记完」那个窗口里
    const sentRaw = normalizeBridgeSignal((item(100, { side: 'close_long' }, { action_type: 'close' })['envelope'] as Record<string, unknown>)['payload'], { now, record_id: 100 });
    store.traderSignals.capture({ ...sentRaw.signal!, status: 'triggered', thread_id: 'thr_gone' });
    // 一条「还没开始」
    const freshRaw = normalizeBridgeSignal((item(101)['envelope'] as Record<string, unknown>)['payload'], { now, record_id: 101 });
    store.traderSignals.capture(freshRaw.signal!);
    const r = await api('POST', '/api/follow/pull');
    expect(r.json.handled).toBe(2);
    // triggered 的那条:转人工,绝不重发
    const sent = store.traderSignals.get(sentRaw.signal!.id)!;
    expect(sent.status).toBe('review_only');
    expect(sent.decision!.note).toContain('不自动重发');
    const overview = { pending_review: (await api('GET', '/api/follow/signals?status=review_only')).json.signals };
    expect(overview.pending_review.some((p: { signal_id: string }) => p.signal_id === sentRaw.signal!.signal_id)).toBe(true);
    // new 的那条:正常重放到「处置完」(首发 = review_only)
    expect(store.traderSignals.get(freshRaw.signal!.id)!.status).toBe('review_only');
  });

  it('R2-02:inbox 按 published_at 升序领取(旧 open 先于新 close)', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    const base = Date.now() - 60_000;
    const mk = (recordId: number, at: number, meta: Record<string, unknown> = {}): TraderSignal => {
      const payload = (item(recordId, {}, meta)['envelope'] as Record<string, unknown>)['payload'] as Record<string, unknown>;
      (payload['metadata'] as Record<string, unknown>)['source_timestamp'] = at / 1000;
      return normalizeBridgeSignal(payload, { now: Date.now(), record_id: recordId }).signal!;
    };
    // 先插入「较新的 close」,再插入「较旧的 open」—— 领取顺序必须按时间,不是按插入顺序
    store.traderSignals.capture(mk(111, base + 30_000, { action_type: 'close' }));
    store.traderSignals.capture(mk(110, base, {}));
    const ordered = store.traderSignals.pendingInbox(10).map((s) => s.record_id);
    expect(ordered).toEqual([110, 111]);
    await api('POST', '/api/follow/pull');
    // 顺序对了两条都能处置完(不再停在 new/triggered),而且一单都没发
    const all = (await api('GET', '/api/follow/signals')).json.signals as { record_id: number; status: string }[];
    for (const rid of [110, 111]) {
      const row = all.find((x) => x.record_id === rid)!;
      expect(['review_only', 'mgmt_orphan', 'evidence', 'skipped']).toContain(row.status);
    }
    expect(rt.openThreads()).toHaveLength(0);
  });



  it('首发:cancel 信号连撤单都不发(线程的 entry_cancel_pending 一动不动)', async () => {
    const cancelItem = item(120, {}, { action_type: 'cancel' });
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 119, items: [item(119)] }, { scanned_to_id: 120, items: [cancelItem] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    await api('POST', '/api/follow/signals/sig_119/apply');
    const t = rt.openThreads()[0]!;
    await api('POST', '/api/follow/pull');
    const sig = (await api('GET', '/api/follow/signals?action=cancel')).json.signals[0];
    expect(sig.status).toBe('review_only');
    expect(sig.decision.note).toContain('首发不自动动仓');
    // 撤单链路一步都没走
    expect(store.thread(t.id)!.entry_cancel_pending).not.toBe(true);
    expect(store.thread(t.id)!.status).toBe(t.status);
  });
});


describe('二审:P1-04 完整闸 / P1-05 入场腿过期 / P1-13 权重天花板 / P1-14 凭证残留', () => {
  it('P1-13:统计失败不许放大风险 —— manual=0.4 且上次有效权重 0.2 时,降级后仍是 0.2', () => {
    const good: TraderStatsSnapshot = {
      rows: parseTraderStats({ by_source: { 交易员A: { resolved: 40, win_rate: 60, max_drawdown_pct: 40 } } }, NOW),
      fetched_at: NOW,
      error: null,
    };
    // 正常:0.4 × mult_bad 0.5 = 0.2
    const normal = weightFor('交易员A', 0.4, good, DEFAULT_WEIGHT_THRESHOLDS, NOW);
    expect(normal.weight).toBe(0.2);
    // 统计失败:只有 min(manual, 0.5) 的话是 0.4 —— **翻倍**。带上「最近一次有效权重」天花板才是 0.2。
    const failed: TraderStatsSnapshot = { ...good, error: 'HTTP 500' };
    expect(weightFor('交易员A', 0.4, failed, DEFAULT_WEIGHT_THRESHOLDS, NOW).weight).toBe(0.4);
    expect(weightFor('交易员A', 0.4, failed, DEFAULT_WEIGHT_THRESHOLDS, NOW, normal.weight).weight).toBe(0.2);
    expect(staleWeightOf(0.4, 0.2)).toBe(0.2);
    expect(staleWeightOf(1, null)).toBe(0.5);
  });



  it('P1-04:信号几何要过完整代码闸 —— 事件黑窗期开不进来', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 130, items: [item(130)] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    // 事件黑窗:BTCUSDT 正处在一条事件的影响窗口里
    const now = Date.now();
    store.events.save(makeEvent({ kind: 'scheduled', subkind: 'fomc', title: 'FOMC', assets: ['BTC'], expected_at: now + 600_000, window_ms: 3_600_000, captured_at: now, source: 'calendar', confidence: 'confirmed', dedupe_key: 'k-follow-blackout' }));
    rt.setWorkflow({ event_blackout_min: 60 });
    await api('POST', '/api/follow/pull');
    expect(rt.openThreads()).toHaveLength(0);
    // gated:agent 判断那次 episode 就被黑窗闸拒 → skipped + trader_gate_blocked(缺口 4 同一口径);
    // 已终态的行 apply 一律 409,黑窗期无论如何开不进来。
    const sig = (await api('GET', '/api/follow/signals')).json.signals[0];
    expect(sig.status).toBe('skipped');
    expect(sig.decision.codes).toContain('trader_gate_blocked');
    const applied = await api('POST', `/api/follow/signals/${sig.signal_id}/apply`);
    expect(applied.status).toBe(409);
    expect(rt.openThreads()).toHaveLength(0);
  });

  it('P1-04:每日开仓上限也拦得住信号几何', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 131, items: [item(131)] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    rt.setWorkflow({ max_opens_per_day: 1 });
    // 先用一条真发过单的线程把当天的额度占掉(`threadOpensSince` 只数非手工、且发过入场单的)
    const used = newThread({
      id: 'thr_used', backend: 'paper', symbol: 'ETHUSDT', side: 'long', source: 'agent', timeframe: '15m',
      thesis: '占额度', invalidation_text: null, watch_conditions: [],
      entry: { type: 'market', price: '3000', zone: null }, stop_price: '2900', take_profits: [],
      qty: '0.1', margin_usdt: '100', leverage: 3, margin_mode: 'cross', now: Date.now(),
    });
    store.saveThread({ ...used, status: 'closed', opened_at: Date.now(), closed_at: Date.now(), entry_client_order_id: 'tgd-used-1' });
    await api('POST', '/api/follow/pull');
    const sig = (await api('GET', '/api/follow/signals')).json.signals[0];
    expect((await api('POST', `/api/follow/signals/${sig.signal_id}/apply`)).status).toBe(409);
    expect(rt.openThreads()).toHaveLength(0);
  });

  it('P1-05:入场腿到了信号 valid_until 还没成交 → 首发只告警不撤单(撤单也是写操作)', async () => {
    const soon = Date.now() + 60_000;
    const withExpiry = item(140, { valid_until: new Date(soon).toISOString() });
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 140, items: [withExpiry] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    await api('POST', '/api/follow/signals/sig_140/apply');
    const t = rt.openThreads()[0]!;
    expect(t.entry_expires_at).toBe(soon);
    expect(t.status).toBe('pending_entry');
    // 用显式时钟跨过有效期,避免并发测试负载使信号在 apply 前就过期。
    const clock = vi.spyOn(Date, 'now').mockReturnValue(soon + 1);
    try { await rt.pollAccount(); } finally { clock.mockRestore(); }
    const after = store.thread(t.id)!;
    // 有效期已绑上、且到点会被标出来给人看;但**不自动撤单**(首发零自动写)
    expect(after.attention).toBe('ENTRY_EXPIRED');
    expect(after.status).toBe('pending_entry');
    expect(after.entry_cancel_pending).not.toBe(true);
  });

  it('P1-14:启动时把库里残留的凭证键清掉,接口也读不到任何明文', async () => {
    const state = openStateDb(':memory:');
    const s2 = new DemoStore(state);
    // 模拟早期版本写进库的凭证
    s2.kvSet('follow.credentials', JSON.stringify({ api_key: FAKE_KEY, secret_token: FAKE_SECRET }));
    const rt2 = new DemoRuntime({ store: s2, backend: new PaperBackend(1000), brains: { stub: stubBrain }, marketPollMs: 600_000, accountPollMs: 600_000 });
    try {
      await rt2.start();
      expect(s2.kvGet('follow.credentials')).toBe('');
      // 全库扫一遍:没有任何一行 kv 里还留着明文
      const rows = state.db.prepare('SELECT key, value FROM demo_kv').all() as { key: string; value: string }[];
      expect(rows.some((r) => r.value.includes(FAKE_KEY) || r.value.includes(FAKE_SECRET))).toBe(false);
    } finally {
      await rt2.stop();
      state.close();
    }
  });
});

// ---------------------------------------------------------------- 首发总闸:零自动交易所写

/**
 * 这是首发范围的**兜底测试**(`FOLLOW_AUTO_EXECUTION=false`)。
 *
 * 自动执行的代码还留在常量后面,所以光看状态机不够 —— 要直接数「backend 的写方法被调了几次」。
 * 任何模式(copy/gated/evidence)、任何动作(open/add/close/stopped_out/cancel/reduce/移损/改止盈)、
 * 任何恢复路径(补拉、重投、崩溃后恢复、到期巡检),follow 链路对下面这些方法的调用次数必须是 **0**:
 * 下单、挂止损/止盈、平仓、减仓、撤单(单张与按币)、改杠杆/保证金模式。
 *
 * 只有人显式点 `apply` / `close` 才允许出现写调用 —— 用例最后一段专门验证这一点(证明计数器有效)。
 */
describe('管理动作与历史信号:follow 链路零交易所写调用', () => {
  /** ExecBackend 上所有会动钱 / 动挂单的方法。 */
  const WRITE_METHODS = [
    'placeEntry', 'openWithProtection', 'placeStop', 'placeTakeProfit',
    'closePosition', 'reducePosition', 'cancelAll', 'cancelOrder',
    'cancelAlgoOrder', 'setLeverage', 'setMarginType',
  ] as const;

  function countWrites(backend: Record<string, unknown>): { calls: string[] } {
    const calls: string[] = [];
    for (const m of WRITE_METHODS) {
      const original = backend[m];
      if (typeof original !== 'function') continue;
      backend[m] = (...args: unknown[]) => {
        calls.push(m);
        return (original as (...a: unknown[]) => unknown).apply(backend, args);
      };
    }
    return { calls };
  }

  it('三种模式 × 全部动作 × 补拉/实时/重投/恢复:一次写调用都没有', async () => {
    // 每种动作各来一条,覆盖开仓类与全部管理类
    const actions: { action_type: string; extra?: Record<string, unknown> }[] = [
      { action_type: 'open' },
      { action_type: 'add' },
      { action_type: 'close', extra: { side: 'close_long' } },
      { action_type: 'stopped_out', extra: { side: 'close_long' } },
      { action_type: 'cancel' },
      { action_type: 'reduce' },
      { action_type: 'stop_loss_update', extra: { stop_loss: { price: 76500 } } },
      { action_type: 'take_profit_update', extra: { take_profit: [{ price: 80000 }] } },
    ];
    for (const mode of ['copy', 'gated', 'evidence'] as const) {
      let rec = 200;
      const page = actions.map((a) => item(++rec, a.extra ?? {}, { action_type: a.action_type }));
      // 三页:补拉那一页、实时那一页(同一批再投一次)、以及一页空的
      const f = bridge(
        [{ scanned_to_id: rec, items: page }, { scanned_to_id: rec, items: page }, { scanned_to_id: rec + 1, items: [] }],
        { recent_after_id: 0, cursor: rec },
      );
      await setup(f.fetch);
      const writes = countWrites((rt as unknown as { backend: Record<string, unknown> }).backend);
      await enableFollow(mode === 'evidence' ? 'copy' : mode);
      if (mode === 'evidence') {
        await api('POST', '/api/follow', { enabled: true, subscriptions: { 'job-trader-a': { mode: 'evidence', weight: 1, enabled: true } } });
      }
      // 补拉 → 实时 → 再投(重号)→ 空页
      await drain();
      await api('POST', '/api/follow/pull');
      await api('POST', '/api/follow/pull');
      // 手工塞一条 new 与一条 triggered,逼恢复路径跑一遍
      const now = Date.now();
      const extraNew = normalizeBridgeSignal((item(900, { side: 'close_long' }, { action_type: 'close' })['envelope'] as Record<string, unknown>)['payload'], { now, record_id: 900 });
      store.traderSignals.capture(extraNew.signal!);
      const extraTriggered = normalizeBridgeSignal((item(901, {}, { action_type: 'reduce' })['envelope'] as Record<string, unknown>)['payload'], { now, record_id: 901 });
      store.traderSignals.capture({ ...extraTriggered.signal!, status: 'triggered', thread_id: 'thr_ghost' });
      await api('POST', '/api/follow/pull');
      // 到期巡检也跑一遍
      await rt.pollAccount();

      expect(rt.openThreads(), `${mode}:不该开出任何线程`).toHaveLength(0);
      expect(writes.calls, `${mode}:follow 链路调了交易所写方法`).toEqual([]);
      // 信号确实都被处置了(不是因为没跑到)
      const all = (await api('GET', '/api/follow/signals?limit=100')).json.signals as { status: string }[];
      expect(all.length).toBeGreaterThanOrEqual(actions.length);
      expect(all.every((x) => x.status !== 'new' && x.status !== 'triggered')).toBe(true);
    }
  }, 60_000);

  it('gated 模式只有人点 apply 才会出现写调用(证明上面的计数器是有效的);首发没有 close 端点', async () => {
    const closeItem = item(301, { side: 'close_long' }, { action_type: 'close' });
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 300, items: [item(300)] }, { scanned_to_id: 301, items: [closeItem] }]);
    await setup(f.fetch);
    const writes = countWrites((rt as unknown as { backend: Record<string, unknown> }).backend);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    expect(writes.calls).toEqual([]);
    // 人点「跟」:出现下单写调用
    expect((await api('POST', '/api/follow/signals/sig_300/apply')).status).toBe(200);
    expect(writes.calls).toContain('placeEntry');
    const afterApply = writes.calls.length;
    // close 信号进来:跟单链路仍然零写
    await api('POST', '/api/follow/pull');
    expect(writes.calls).toHaveLength(afterApply);
    // 首发没有 close 端点(平仓走交易页)
    const gone = await fetch(`${baseUrl}/api/follow/signals/sig_301/close`, { method: 'POST' });
    expect(gone.status).toBe(404);
  });
});

describe('R3-06:入库与 SSE 的秘密脱敏(入口处理,不是只在某条路由)', () => {
  it('原文里整段贴着 key 的信号:入库、SSE 帧、HTTP 响应都不含明文', async () => {
    const leaked = `突破回踩,顺便贴一下我的 key ${FAKE_KEY} 和 secret ${FAKE_SECRET}`;
    const dirty = item(400, {}, { rationale: leaked, target_order_ref: `ref-${FAKE_KEY}` });
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 400, items: [dirty] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    // 订阅 SSE,再拉那一页
    const frames: string[] = [];
    const controller = new AbortController();
    const sse = fetch(`${baseUrl}/api/events`, { signal: controller.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        frames.push(decoder.decode(value));
      }
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    await api('POST', '/api/follow/pull');
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await sse;

    // 1) 入库:raw_text 与 ref_order 里没有明文
    const row = store.traderSignals.bySignalId('sig_400')!;
    expect(row.raw_text).not.toContain(FAKE_KEY);
    expect(row.raw_text).not.toContain(FAKE_SECRET);
    expect(row.raw_text).toContain('***');
    expect(row.ref_order).not.toContain(FAKE_KEY);
    // 直接读库那一行(绕过所有视图)也不含明文
    const raw = JSON.stringify((activeState!.db.prepare('SELECT * FROM demo_trader_signal WHERE signal_id = ?').get('sig_400')));
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).not.toContain(FAKE_SECRET);
    // 2) SSE 帧里没有明文
    const sseText = frames.join('');
    expect(sseText).toContain('trader_signal');
    expect(sseText).not.toContain(FAKE_KEY);
    expect(sseText).not.toContain(FAKE_SECRET);
    // 3) HTTP 响应里没有明文
    const listed = JSON.stringify((await api('GET', '/api/follow/signals')).json);
    expect(listed).not.toContain(FAKE_KEY);
    expect(listed).not.toContain(FAKE_SECRET);
  });
});

// ---------------------------------------------------------------- 四审 R4-03~R4-07

describe('R4-03/04/05/06/07', () => {
  it('R4-03:applying 行崩溃后由 resume 隔离成 review_only + needs_reconcile,不自动重发', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 500, items: [item(500)] }]);
    await setup(f.fetch);
    const writes: string[] = [];
    const backend = (rt as unknown as { backend: Record<string, unknown> }).backend;
    for (const m of ['placeEntry', 'closePosition', 'cancelAll'] as const) {
      const orig = backend[m] as (...a: unknown[]) => unknown;
      backend[m] = (...args: unknown[]) => (writes.push(m), orig.apply(backend, args));
    }
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    // 模拟「**上个进程**已领取、发送中崩溃」:claim_owner 写成别的 epoch
    const claimed = store.traderSignals.claimForApply('sig_500', 'previous-process-epoch', 'claim-old', Date.now())!;
    expect(claimed.status).toBe('applying');
    // 启动恢复只在第一次 tick 跑;这里把标记复位,模拟「进程刚起来」
    (rt as unknown as { followStartupResumed: boolean }).followStartupResumed = false;
    const r = await api('POST', '/api/follow/pull'); // 启动恢复
    expect(r.json.handled).toBeGreaterThan(0);
    const after = store.traderSignals.bySignalId('sig_500')!;
    expect(after.status).toBe('review_only');
    expect(after.needs_reconcile).toBe(true);
    expect(after.decision!.note).toContain('不自动重发');
    // 一次写调用都没有
    expect(writes).toEqual([]);
  });

  it('R4-04:补拉重号的 new 行会把 backfill 标记合并进去(不再按实时处理)', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    const now = Date.now();
    // 先落一条「实时」的 new 行(session 是本会话、backfill=false)
    const live = normalizeBridgeSignal((item(510)['envelope'] as Record<string, unknown>)['payload'], { now, record_id: 510, session: 'other-session' });
    store.traderSignals.capture(live.signal!);
    expect(store.traderSignals.bySignalId('sig_510')!.backfill).toBe(false);
    // 同一条再以补拉身份进来 → 合并成 backfill=true
    const again = normalizeBridgeSignal((item(510)['envelope'] as Record<string, unknown>)['payload'], { now, record_id: 510, backfill: true, session: 'this-session' });
    const merged = store.traderSignals.capture(again.signal!);
    expect(merged.created).toBe(false);
    expect(merged.signal.backfill).toBe(true);
    expect(store.traderSignals.bySignalId('sig_510')!.backfill).toBe(true);
    expect(store.traderSignals.bySignalId('sig_510')!.session).toBe('this-session');
  });

  it('R4-04:上个会话留下的 new 行按历史处理(不调模型、不生成实时计划)', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    // 手工塞一条「上个会话」的 new 行
    const stale = normalizeBridgeSignal((item(520)['envelope'] as Record<string, unknown>)['payload'], { now: Date.now(), record_id: 520, session: 'previous-session' });
    store.traderSignals.capture(stale.signal!);
    const before = store.episodes?.length;
    void before;
    const episodesBefore = store.episodes(50).length;
    await api('POST', '/api/follow/pull');
    const after = store.traderSignals.bySignalId('sig_520')!;
    expect(after.backfill).toBe(true); // 被标成历史
    expect(after.status).toBe('review_only');
    // 没调模型:没有新增 episode
    expect(store.episodes(50).length).toBe(episodesBefore);
    // 历史信号不给可执行几何
    expect(after.decision?.plan ?? null).toBeNull();
  });





  it('R4-07:pending_review 从库里查(重启后照样完整,不靠内存列表)', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 610, items: [item(610)] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    const first = (await api('GET', '/api/follow/signals?status=review_only')).json.signals;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ signal_id: 'sig_610', status: 'review_only' });
    expect(first[0].decision.plan).toBeTruthy();
    // 把内存里的那份清掉(模拟重启);库里还在 → 待办照样完整
    (rt as unknown as { followPending: unknown[] }).followPending = [];
    const again = (await api('GET', '/api/follow/signals?status=review_only')).json.signals;
    expect(again).toHaveLength(1);
    expect(again[0].signal_id).toBe('sig_610');
  });
});

// ---------------------------------------------------------------- 五审 R5-01/02/03

describe('R5-01:领取竞态 —— 一个授权只能有一个活跃执行者', () => {
  /** 用可控 Promise 挡住 manualOpen,在「已领取、发送未回」的窗口里交错别的操作。 */
  function blockingHarness() {
    const dir = mkdtempSync(join(tmpdir(), 'tg-follow-race-'));
    const state = openStateDb(join(dir, 'state.sqlite'));
    const store = new DemoStore(state);
    const calls: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    let owners = 0;
    const deps: FollowDeps = {
      follow: () => settings(),
      stats: () => null,
      signals: {
        capture: (s) => store.traderSignals.capture(s),
        save: (s) => store.traderSignals.save(s),
        find: (id) => store.traderSignals.find(id),
        openingsSince: (t, since) => store.traderSignals.openingsSince(t, since),
        claimForApply: (id, owner, claimId, now) => store.traderSignals.claimForApply(id, owner, claimId, now),
        claimStillOwned: (id, claimId) => store.traderSignals.claimStillOwned(id, claimId),
        saveIfOwned: (sig, claimId) => store.traderSignals.saveIfOwned(sig, claimId),
        clearNeedsReconcile: (id, now) => store.traderSignals.clearNeedsReconcile(id, now),
      },
      newClaimId: () => `claim-${++owners}`,
      claimOwner: () => 'this-process',
      now: () => NOW,
      liveThreads: () => [],
      markOf: async () => MARK,
      symbolSupported: async () => true,
      openFromSignal: async () => ({ outcome: 'rejected' as const, reason: '自动路径关着' }),
      manualOpen: async (_s, _p, ctx) => {
        calls.push('manual_open:start');
        await gate; // 卡在「已领取、发送未回」
        // 发送前回调:领取还在不在
        const ok = ctx.authorize?.() ?? { ok: true, reason: '' };
        if (!ok.ok) return { outcome: 'rejected' as const, reason: ok.reason };
        calls.push('manual_open:send');
        return { outcome: 'opened' as const, thread_id: 'thr_race', reason: '' };
      },
      judge: async () => ({ episode_id: null, action: 'PROPOSE', direction: 'long', stop: STOP, blocked: [], error: null }),
      closeThread: async () => ({ ok: true, detail: '' }),
      cancelEntries: async () => ({ ok: true, detail: '' }),
      recordLedger: () => {},
      emit: () => {},
      log: (_l, m) => void calls.push(`log:${m.slice(0, 24)}`),
    };
    return { follow: new TraderFollow(deps), store, calls, release, close: () => { state.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it('第二次 apply / skip 都拿不到同一个授权;旧快照不覆盖新状态', async () => {
    const h = blockingHarness();
    try {
      await h.follow.ingest(sig({ signal_id: 'sig_race', id: 'tsig_race' }));
      expect(h.store.traderSignals.bySignalId('sig_race')!.status).toBe('review_only');
      // A 开始 apply,卡在发送里
      const first = h.follow.applyManually('sig_race');
      await new Promise((r) => setTimeout(r, 20));
      expect(h.store.traderSignals.bySignalId('sig_race')!.status).toBe('applying');
      // B 再点一次:领取不到
      const second = await h.follow.applyManually('sig_race');
      expect(second.status).toBe(409);
      // B 想 skip:applying 不是可执行前态,拒
      expect(h.follow.skipManually('sig_race').status).toBe(409);
      // 放行 A
      h.release();
      const done = await first;
      expect(done.error).toBeNull();
      expect(done.signal!.status).toBe('applied');
      // 全程只有一个 owner 发过单
      expect(h.calls.filter((c) => c === 'manual_open:send')).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('领取在发送途中被隔离 → 放弃发送、也不覆盖新状态', async () => {
    const h = blockingHarness();
    try {
      await h.follow.ingest(sig({ signal_id: 'sig_race2', id: 'tsig_race2' }));
      const first = h.follow.applyManually('sig_race2');
      await new Promise((r) => setTimeout(r, 20));
      // 模拟「被隔离」:把行改成 review_only + needs_reconcile(claim 作废)
      const row = h.store.traderSignals.bySignalId('sig_race2')!;
      h.store.traderSignals.save({ ...row, status: 'review_only', needs_reconcile: true, claim_id: null, claim_owner: null, claim_at: null });
      h.release();
      const done = await first;
      // 发送前回调发现领取没了 → 不发
      expect(h.calls).not.toContain('manual_open:send');
      expect(done.error).toBeTruthy();
      // 旧快照没有覆盖隔离结果
      const after = h.store.traderSignals.bySignalId('sig_race2')!;
      expect(after.status).toBe('review_only');
      expect(after.needs_reconcile).toBe(true);
    } finally {
      h.close();
    }
  });

  it('运行期 tick 不再碰本进程的 applying(只有启动恢复才处理上个进程的)', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 700, items: [item(700)] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    // 本进程领走
    const epoch = (rt as unknown as { submitEpoch: string }).submitEpoch;
    const claimed = store.traderSignals.claimForApply('sig_700', epoch, 'claim-live', Date.now())!;
    expect(claimed.status).toBe('applying');
    // 再跑几轮 tick:活跃领取不许被撤
    await api('POST', '/api/follow/pull');
    await api('POST', '/api/follow/pull');
    expect(store.traderSignals.bySignalId('sig_700')!.status).toBe('applying');
    expect(store.traderSignals.bySignalId('sig_700')!.claim_id).toBe('claim-live');
  });

  it('needs_reconcile 的行 apply 与 skip 都要先人工 reconcile', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 710, items: [item(710)] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    const row = store.traderSignals.bySignalId('sig_710')!;
    store.traderSignals.save({ ...row, needs_reconcile: true });
    expect((await api('POST', '/api/follow/signals/sig_710/apply')).status).toBe(409);
    expect((await api('POST', '/api/follow/signals/sig_710/skip')).status).toBe(409);
    expect(rt.openThreads()).toHaveLength(0);
    // 人工「已核对」只清标记,不动钱
    const rec = await api('POST', '/api/follow/signals/sig_710/reconcile');
    expect(rec.status).toBe(200);
    expect(rec.json.signal.needs_reconcile).toBe(false);
    expect(rec.json.signal.status).toBe('review_only');
    expect(rt.openThreads()).toHaveLength(0);
    // 清掉之后才放行
    expect((await api('POST', '/api/follow/signals/sig_710/apply')).status).toBe(200);
  });
});

describe('R5-02:失败分类', () => {
  function outcomeHarness(outcome: 'rejected' | 'failed_before_send' | 'unknown', threadId: string | null = null) {
    const dir = mkdtempSync(join(tmpdir(), 'tg-follow-oc-'));
    const state = openStateDb(join(dir, 'state.sqlite'));
    const store = new DemoStore(state);
    const deps: FollowDeps = {
      follow: () => settings(),
      stats: () => null,
      signals: {
        capture: (s) => store.traderSignals.capture(s),
        save: (s) => store.traderSignals.save(s),
        find: (id) => store.traderSignals.find(id),
        openingsSince: (t, since) => store.traderSignals.openingsSince(t, since),
        claimForApply: (id, owner, claimId, now) => store.traderSignals.claimForApply(id, owner, claimId, now),
        claimStillOwned: (id, claimId) => store.traderSignals.claimStillOwned(id, claimId),
        saveIfOwned: (s2, claimId) => store.traderSignals.saveIfOwned(s2, claimId),
        clearNeedsReconcile: (id, now) => store.traderSignals.clearNeedsReconcile(id, now),
      },
      now: () => NOW,
      liveThreads: () => [],
      markOf: async () => MARK,
      symbolSupported: async () => true,
      openFromSignal: async () => ({ outcome: 'rejected' as const, reason: 'x' }),
      manualOpen: async () => ({ outcome, reason: '造的失败', ...(threadId ? { thread_id: threadId } : {}) }),
      judge: async () => ({ episode_id: null, action: 'PROPOSE', direction: 'long', stop: STOP, blocked: [], error: null }),
      closeThread: async () => ({ ok: true, detail: '' }),
      cancelEntries: async () => ({ ok: true, detail: '' }),
      recordLedger: () => {},
      emit: () => {},
      log: () => {},
    };
    return { follow: new TraderFollow(deps), store, close: () => { state.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it('rejected / failed_before_send → apply_failed(明确失败,可以再 apply)', async () => {
    for (const oc of ['rejected', 'failed_before_send'] as const) {
      const h = outcomeHarness(oc);
      try {
        await h.follow.ingest(sig({ signal_id: `sig_${oc}`, id: `tsig_${oc}` }));
        const r = await h.follow.applyManually(`sig_${oc}`);
        expect(r.signal!.status).toBe('apply_failed');
        expect(r.signal!.needs_reconcile).toBe(false);
        expect(r.signal!.thread_id).toBeNull();
        // 可以再试:apply_failed 也能被领取
        expect(h.store.traderSignals.claimForApply(`sig_${oc}`, 'o', 'c', Date.now())?.status).toBe('applying');
      } finally {
        h.close();
      }
    }
  });

  it('unknown(发送之后出错)→ review_only + needs_reconcile,并保留 thread_id', async () => {
    const h = outcomeHarness('unknown', 'thr_unknown');
    try {
      await h.follow.ingest(sig({ signal_id: 'sig_unk', id: 'tsig_unk' }));
      const r = await h.follow.applyManually('sig_unk');
      expect(r.signal!.status).toBe('review_only');
      expect(r.signal!.needs_reconcile).toBe(true);
      expect(r.signal!.thread_id).toBe('thr_unknown');
      expect(r.signal!.decision?.note).toContain('状态不确定');
      // 没核对之前不许再 apply
      expect((await h.follow.applyManually('sig_unk')).status).toBe(409);
    } finally {
      h.close();
    }
  });

  it('apply_failed 与 needs_reconcile 都进人工待办查询', async () => {
    const h = outcomeHarness('rejected');
    try {
      await h.follow.ingest(sig({ signal_id: 'sig_pend', id: 'tsig_pend' }));
      await h.follow.applyManually('sig_pend');
      const pending = h.store.traderSignals.pendingReview(50);
      expect(pending.map((x) => x.signal_id)).toContain('sig_pend');
      expect(h.store.traderSignals.pendingReviewCount()).toBeGreaterThanOrEqual(1);
    } finally {
      h.close();
    }
  });
});

describe('R5-03:脱敏覆盖完整输出对象', () => {
  /** 合成秘密:**不等于**当前 env 的凭证,只能靠形状兜底正则清掉。 */
  const OTHER_KEY = 'sbk_someoneElsesKey_9876543210';
  const OTHER_SECRET = 'sbs_OldRotatedSecret_ABCDEFGH';

  it('旧行的 signal_id / ref_order / decision.agent.blocked 在 HTTP 与 SSE 出口都不含明文', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    // 直接往库里塞一条「旧行」——入口脱敏之前落下的那种
    const base = normalizeBridgeSignal((item(800)['envelope'] as Record<string, unknown>)['payload'], { now: Date.now(), record_id: 800 }).signal!;
    store.traderSignals.save({
      ...base,
      signal_id: `sig_${OTHER_KEY}`,
      ref_order: `ref-${OTHER_SECRET}`,
      raw_text: `原文里也贴了 ${OTHER_KEY}`,
      status: 'review_only',
      mode_applied: 'gated',
      decision: {
        codes: [], at: Date.now(), note: `note 里有 ${OTHER_SECRET}`,
        agent: { stance: 'agree', action: 'PROPOSE', direction: 'long', stop: '1', blocked: [`闸拒原因带 ${OTHER_KEY}`] },
        plan: { entry: ENTRY, intent: 'limit', stop: STOP, take_profits: [TP], reason: `plan 理由带 ${OTHER_SECRET}` },
      },
    });
    // HTTP:列表 / overview 的 pending_review
    const listed = JSON.stringify((await api('GET', '/api/follow/signals')).json);
    const overview = JSON.stringify((await api('GET', '/api/follow')).json);
    for (const text of [listed, overview]) {
      expect(text).not.toContain(OTHER_KEY);
      expect(text).not.toContain(OTHER_SECRET);
    }
    expect(listed).toContain('***');
    // SSE:走 quarantine 的那条 emit
    const frames: string[] = [];
    const controller = new AbortController();
    const sse = fetch(`${baseUrl}/api/events`, { signal: controller.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        frames.push(decoder.decode(value));
      }
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const row = store.traderSignals.bySignalId(`sig_${OTHER_KEY}`)!;
    store.traderSignals.save({ ...row, status: 'triggered' });
    await api('POST', '/api/follow/pull'); // resume → quarantine → SSE
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await sse;
    const sseText = frames.join('');
    expect(sseText).not.toContain(OTHER_KEY);
    expect(sseText).not.toContain(OTHER_SECRET);
  });



  it('redactDeep 递归到任意嵌套;redactSecrets 不要求词边界且不区分大小写', () => {
    const deep = redactDeep({ a: `x${OTHER_KEY}`, b: [{ c: OTHER_SECRET }], d: { e: { f: [`${OTHER_KEY}`] } }, n: 1, z: null }, null);
    const text = JSON.stringify(deep);
    expect(text).not.toContain(OTHER_KEY);
    expect(text).not.toContain(OTHER_SECRET);
    expect(deep.n).toBe(1);
    expect(deep.z).toBeNull();
    // 下划线前缀 + 大写变体
    expect(redactSecrets(`sig_${OTHER_KEY}`)).not.toContain(OTHER_KEY);
    expect(redactSecrets(`SIG_${OTHER_KEY.toUpperCase()}`)).not.toContain(OTHER_KEY.toUpperCase());
  });
});

// ---------------------------------------------------------------- 六审 R6-01 / R6-02

describe('R6-01:unknown 回执穿过真实 openThreadFromSignal/executeOpen', () => {
  /** 拉一条信号到 review_only,返回它的 signal_id。 */
  async function pendingSignal(recordId: number): Promise<string> {
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    const row = (await api('GET', '/api/follow/signals?status=review_only&limit=1')).json.signals[0];
    expect(row.signal_id).toBe(`sig_${recordId}`);
    return row.signal_id;
  }

  it('placeEntry 回 unknown 且 getOrder 无果 → 信号 review_only + needs_reconcile,thread_id 非空', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 900, items: [item(900)] }]);
    await setup(f.fetch);
    const sid = await pendingSignal(900);
    // 假后端:下单回执不明,按 CID 回查也查不到
    const backend = (rt as unknown as { backend: Record<string, unknown> }).backend;
    backend['placeEntry'] = async (): Promise<unknown> => ({ outcome: 'unknown', receipt: {}, avg_price: null, error: '网关超时' });
    backend['getOrder'] = async (): Promise<null> => null;

    const r = await api('POST', `/api/follow/signals/${sid}/apply`);
    // 这是「不确定」,不是成功
    expect(r.status).toBe(409);
    const row = store.traderSignals.bySignalId(sid)!;
    expect(row.status).toBe('review_only');
    expect(row.needs_reconcile).toBe(true);
    expect(row.thread_id).toBeTruthy(); // 线程关联必须留着
    expect(row.decision!.note).toContain('状态不确定');
    // 线程侧也确实停在待核对
    const t = store.thread(row.thread_id!)!;
    expect(t.attention).toBe('ORDER_UNKNOWN');
    // 没核对之前不许再 apply
    expect((await api('POST', `/api/follow/signals/${sid}/apply`)).status).toBe(409);
  }, 30_000);

  it('建线程之后、原 catch 之外的步骤失败 → 同样 review_only + needs_reconcile 且带 thread_id', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 901, items: [item(901)] }]);
    await setup(f.fetch);
    const sid = await pendingSignal(901);
    // `symbolRules` 在建线程之后、executeOpen 内部也会用到;这里打的是 executeOpen 里那次账户读,
    // 它原来在 try 之外(newIntent/activity 同理)。
    const backend = (rt as unknown as { backend: Record<string, unknown> }).backend;
    const originalAccount = backend['account'];
    backend['account'] = async (): Promise<unknown> => {
      // 线程已经建出来(信号行挂上了 thread_id)之后的那次账户读抛错 —— 正是「建线程之后、原 catch 之外」。
      // 老写法靠 calls 计数 + 未绑定 this 的 TypeError 误打误撞;Executor 代理把 this 绑对之后就不成立了。
      if (rt!.openThreads().length > 0) throw new Error('账户读崩了');
      return (originalAccount as () => Promise<unknown>)();
    };
    const r = await api('POST', `/api/follow/signals/${sid}/apply`);
    expect(r.status).toBe(409);
    const row = store.traderSignals.bySignalId(sid)!;
    expect(row.status).toBe('review_only');
    expect(row.needs_reconcile).toBe(true);
    expect(row.thread_id).toBeTruthy();
  }, 30_000);

  it('发送后交易所明确拒单 → apply_failed(可再试),不谎称「发送前失败」', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 902, items: [item(902)] }]);
    await setup(f.fetch);
    const sid = await pendingSignal(902);
    const backend = (rt as unknown as { backend: Record<string, unknown> }).backend;
    backend['placeEntry'] = async (): Promise<unknown> => ({ outcome: 'failed', receipt: {}, avg_price: null, error: '余额不足' });
    const r = await api('POST', `/api/follow/signals/${sid}/apply`);
    expect(r.status).toBe(409);
    const row = store.traderSignals.bySignalId(sid)!;
    expect(row.status).toBe('apply_failed');
    expect(row.needs_reconcile).toBe(false);
    expect(row.decision!.note).toContain('余额不足');
    // 明确失败可以再试
    expect(store.traderSignals.claimForApply(sid, 'o', 'c', Date.now())?.status).toBe('applying');
  }, 30_000);
});

describe('R6-02:日志出口脱敏(四处都不含明文)', () => {
  const OLD_KEY = 'sbk_leakedThroughLogs_1234567890';

  it('对带旧 ID 的行调 reconcile:HTTP / log SSE / GET /api/logs / console 四处都清', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    await drain();
    // 旧行:signal_id 里整段贴着一把**不是当前 env** 的 key,且需要对账
    const base = normalizeBridgeSignal((item(910)['envelope'] as Record<string, unknown>)['payload'], { now: Date.now(), record_id: 910 }).signal!;
    store.traderSignals.save({ ...base, signal_id: `sig_${OLD_KEY}`, status: 'review_only', needs_reconcile: true, mode_applied: 'book' });

    // 接住 console 输出
    const consoleLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => void consoleLines.push(args.map(String).join(' '));

    const frames: string[] = [];
    const controller = new AbortController();
    const sse = fetch(`${baseUrl}/api/events`, { signal: controller.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        frames.push(decoder.decode(value));
      }
    }).catch(() => {});
    try {
      await new Promise((r) => setTimeout(r, 50));
      const r = await api('POST', `/api/follow/signals/${base.id}/reconcile`);
      expect(r.status).toBe(200);
      await new Promise((r2) => setTimeout(r2, 120));
      controller.abort();
      await sse;

      // 1) HTTP 成功响应
      expect(JSON.stringify(r.json)).not.toContain(OLD_KEY);
      // 2) log SSE 帧(reconcile 会写一条 info 日志)
      const sseText = frames.join('');
      expect(sseText).toContain('event: log');
      expect(sseText).not.toContain(OLD_KEY);
      // 3) GET /api/logs
      const logs = JSON.stringify((await api('GET', '/api/logs?limit=200')).json);
      expect(logs).not.toContain(OLD_KEY);
      // 4) console
      expect(consoleLines.join('\n')).not.toContain(OLD_KEY);
      expect(consoleLines.some((l) => l.includes('***'))).toBe(true);
    } finally {
      console.error = originalError;
    }
  }, 30_000);

  it('跟单路由抛出的异常也经自己的 guarded 脱敏', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    // 让 follow() 抛一个带合成秘密的异常
    const original = rt.follow.bind(rt);
    (rt as unknown as { follow: () => unknown }).follow = (): never => {
      throw new Error(`内部错误,顺手带出了 ${OLD_KEY}`);
    };
    try {
      const r = await api('POST', '/api/follow/signals/whatever/skip');
      expect(r.status).toBeGreaterThanOrEqual(400);
      const body = JSON.stringify(r.json);
      expect(body).not.toContain(OLD_KEY);
      expect(body).toContain('***');
    } finally {
      (rt as unknown as { follow: unknown }).follow = original;
    }
  });
});

// ---------------------------------------------------------------- 七审 R7-01/02/03

describe('R7-01/02/03', () => {
  async function pending(recordId: number): Promise<string> {
    await enableFollow('gated');
    await drain();
    await api('POST', '/api/follow/pull');
    const row = (await api('GET', '/api/follow/signals?status=review_only&limit=1')).json.signals[0];
    expect(row.signal_id).toBe(`sig_${recordId}`);
    return row.signal_id;
  }

  it('R7-01:回查见零成交终态、但撤单链二查无果 → unknown(不是 apply_failed)', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 920, items: [item(920)] }]);
    await setup(f.fetch);
    const sid = await pending(920);
    const backend = (rt as unknown as { backend: Record<string, unknown> }).backend;
    backend['placeEntry'] = async (): Promise<unknown> => ({ outcome: 'unknown', receipt: {}, avg_price: null, error: '网关超时' });
    let getOrderCalls = 0;
    backend['getOrder'] = async (): Promise<unknown> => {
      getOrderCalls += 1;
      // 第一次(executeOpen 的回查):零成交终态;第二次(撤单链的再查):查不到
      return getOrderCalls === 1 ? { status: 'CANCELED', executed_qty: '0', avg_price: null } : null;
    };

    const r = await api('POST', `/api/follow/signals/${sid}/apply`);
    expect(r.status).toBe(409);
    const row = store.traderSignals.bySignalId(sid)!;
    // 撤单链没能确认零敞口 → 必须是「不确定」,不能当明确失败放人重试
    expect(row.status).toBe('review_only');
    expect(row.needs_reconcile).toBe(true);
    expect(row.thread_id).toBeTruthy();
    expect(row.decision!.note).toContain('状态不确定');
    expect(getOrderCalls).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('R7-01:撤单链确认零成交(终态+零成交+新鲜账户无仓)→ 才是 apply_failed', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 921, items: [item(921)] }]);
    await setup(f.fetch);
    const sid = await pending(921);
    const backend = (rt as unknown as { backend: Record<string, unknown> }).backend;
    backend['placeEntry'] = async (): Promise<unknown> => ({ outcome: 'unknown', receipt: {}, avg_price: null, error: '网关超时' });
    backend['getOrder'] = async (): Promise<unknown> => ({ status: 'CANCELED', executed_qty: '0', avg_price: null });
    const r = await api('POST', `/api/follow/signals/${sid}/apply`);
    expect(r.status).toBe(409);
    const row = store.traderSignals.bySignalId(sid)!;
    expect(row.status).toBe('apply_failed');
    expect(row.needs_reconcile).toBe(false);
  }, 30_000);

  it('R7-02:首次 saveThread 的事件监听器抛错 → 线程已落库且信号带同一个 thread_id', async () => {
    const f = bridge([{ scanned_to_id: 1, items: [] }, { scanned_to_id: 930, items: [item(930)] }]);
    await setup(f.fetch);
    const sid = await pending(930);
    // 注入一个会抛错的 thread.changed 监听器:saveThread 写完库、同步 emit 时炸
    const boom = (): never => {
      throw new Error('监听器炸了');
    };
    rt.on('thread.changed', boom);
    try {
      const r = await api('POST', `/api/follow/signals/${sid}/apply`);
      expect(r.status).toBe(409);
      const row = store.traderSignals.bySignalId(sid)!;
      expect(row.status).toBe('review_only');
      expect(row.needs_reconcile).toBe(true);
      // 关键:线程确实已经落库,而且信号记的就是它
      expect(row.thread_id).toBeTruthy();
      const persisted = store.thread(row.thread_id!);
      expect(persisted).not.toBeNull();
      expect(persisted!.id).toBe(row.thread_id);
      expect(persisted!.origin).toBe('trader:job-trader-a');
    } finally {
      rt.off('thread.changed', boom);
    }
  }, 30_000);

  it('R7-03:异常对象上的 code 也脱敏', async () => {
    const SECRET_CODE = 'sbk_otherSecret_1234567890';
    const f = bridge([{ scanned_to_id: 1, items: [] }]);
    await setup(f.fetch);
    await enableFollow('gated');
    const original = rt.follow.bind(rt);
    (rt as unknown as { follow: () => unknown }).follow = (): never => {
      throw Object.assign(new Error('内部错误'), { code: SECRET_CODE });
    };
    try {
      const r = await api('POST', '/api/follow/signals/whatever/skip');
      expect(r.status).toBeGreaterThanOrEqual(400);
      const body = JSON.stringify(r.json);
      expect(body).not.toContain(SECRET_CODE);
      expect(body).toContain('***');
    } finally {
      (rt as unknown as { follow: unknown }).follow = original;
    }
  });
});
