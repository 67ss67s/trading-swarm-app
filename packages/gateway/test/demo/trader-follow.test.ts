// 跟单 session 的纯函数与编排(设计 docs/design/trader-follow-2026-09-12.md §5 验收单测)。
// 零网络、零模型、不起 http:归一化 / 三模式 / 管理动作路由 / 新鲜度 / 重复开仓与再入场 / 权重三档 / 游标与退避 / DLQ。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { newThread } from '../../src/demo/threads.js';
import type { StrategyThread } from '../../src/demo/types.js';
import {
  checkLimitPrice,
  entryPriceForSide,
  isExpired,
  marketableLimitPrice,
  mentionsCostBasis,
  normalizeBridgeSignal,
  protectiveStopPrice,
  remapTpShares,
  splitPercents,
  stopTightens,
  transition,
  type TraderSignal,
} from '../../src/demo/trader-signal.js';
import {
  DEFAULT_FOLLOW_SETTINGS,
  TraderFollow,
  duplicateCheck,
  entryPlanFor,
  followRiskPct,
  linkThread,
  normalizeFollowSettings,
  reducePercentOf,
  resolveMode,
  reverseCheck,
  routeManagement,
  type EntryPlan,
  type FollowDeps,
  type FollowSettings,
  type ManagementResult,
} from '../../src/demo/trader-follow.js';
import { DEFAULT_WEIGHT_THRESHOLDS, autoMult, parseTraderStats, weightFor, type TraderStatsSnapshot } from '../../src/demo/trader-stats.js';
import { TraderFeed, backoffMs, maskSecret, readCredentials, redactSecrets, type FollowFetch } from '../../src/demo/trader-feed.js';

const NOW = Date.parse('2026-09-12T08:00:00Z');

// ---------------------------------------------------------------- 造数

function payload(over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signal_id: 'sig_1',
    symbol: 'btcusdt',
    side: 'long',
    market_type: 'perpetual',
    source: 'telegram',
    entry: { type: 'limit', price: 60000 },
    stop_loss: { price: 59000 },
    take_profit: [{ price: 62000 }, { price: 64000 }],
    created_at: new Date(NOW).toISOString(),
    metadata: { trader: 'TraderB', action_type: 'open', rationale: '突破回踩' },
    ...over,
    ...(Object.keys(meta).length ? { metadata: { trader: 'TraderB', action_type: 'open', rationale: '突破回踩', ...meta } } : {}),
  };
}

function sig(over: Partial<TraderSignal> = {}): TraderSignal {
  const r = normalizeBridgeSignal(payload(), { now: NOW });
  return { ...r.signal!, subscription_job_id: 'job-trader_b', ...over };
}

function settings(over: Partial<FollowSettings> = {}, traderOver: Partial<FollowSettings['subscriptions'][string]> = {}): FollowSettings {
  return {
    ...DEFAULT_FOLLOW_SETTINGS,
    enabled: true,
    subscriptions: { 'job-trader_b': { mode: 'book', weight: 1, enabled: true, ...traderOver } },
    ...over,
  };
}

function traderThread(over: Partial<StrategyThread> = {}): StrategyThread {
  return {
    ...newThread({
      id: 'thr_1',
      backend: 'paper',
      symbol: 'BTCUSDT',
      side: 'long',
      source: 'trader',
      timeframe: '15m',
      thesis: '跟单',
      invalidation_text: null,
      watch_conditions: [],
      entry: { type: 'limit', price: '60000', zone: null },
      stop_price: '59000',
      take_profits: ['62000'],
      qty: '0.01',
      margin_usdt: '200',
      leverage: 3,
      margin_mode: 'cross',
      now: NOW,
    }),
    origin: 'trader:job-trader_b',
    trader_signal_id: 'sig_1',
    ...over,
  };
}

// ---------------------------------------------------------------- 归一化

describe('normalizeBridgeSignal', () => {
  it('单价入场 + 多档止盈 + 大写 symbol + metadata 透传', () => {
    const r = normalizeBridgeSignal(payload(), { now: NOW });
    expect(r.errors).toEqual([]);
    const s = r.signal!;
    expect(s).toMatchObject({ signal_id: 'sig_1', trader: 'TraderB', symbol: 'BTCUSDT', side: 'long', action: 'open', entry_kind: 'limit', stop: '59000', status: 'new', transport: 'telegram' });
    expect(s.entry_prices).toEqual(['60000']);
    expect(s.tps).toEqual([{ price: '62000', pct: null }, { price: '64000', pct: null }]);
    expect(s.published_at).toBe(NOW);
    expect(s.ingested_at).toBe(NOW);
    expect(s.backfill).toBe(false);
  });

  it('区间入场归一化成多档并按升序排列', () => {
    const r = normalizeBridgeSignal(payload({ entry: { type: 'zone', low: 60500, high: 59800 } }), { now: NOW });
    expect(r.signal!.entry_prices).toEqual(['59800', '60500']);
    expect(r.signal!.entry_kind).toBe('zone');
  });

  it('阶梯入场 prices 数组照收', () => {
    const r = normalizeBridgeSignal(payload({ entry: { type: 'limit', prices: [60000, 59500, 59000] } }), { now: NOW });
    expect(r.signal!.entry_prices).toEqual(['59000', '59500', '60000']);
  });

  it('市价意图:没有价、type=market → entry_kind=market', () => {
    const r = normalizeBridgeSignal(payload({ entry: { type: 'market' } }), { now: NOW });
    expect(r.signal!.entry_kind).toBe('market');
    expect(r.signal!.entry_prices).toEqual([]);
  });

  it('open 信号没有 entry.type 也没有价 → 按市价意图兜底', () => {
    const r = normalizeBridgeSignal(payload({ entry: {} }), { now: NOW });
    expect(r.signal!.entry_kind).toBe('market');
  });

  it('无止损:stop 留 null,不编一个出来', () => {
    const r = normalizeBridgeSignal(payload({ stop_loss: null }), { now: NOW });
    expect(r.errors).toEqual([]);
    expect(r.signal!.stop).toBeNull();
  });

  it('多档止盈带 pct 时按其归一化,不带时均分', () => {
    const withPct = normalizeBridgeSignal(payload({ take_profit: [{ price: 62000, pct: 30 }, { price: 64000, pct: 70 }] }), { now: NOW }).signal!;
    expect(remapTpShares(withPct.tps)).toEqual([30, 70]);
    expect(remapTpShares(sig().tps)).toEqual([50, 50]);
  });

  it('published_at 优先 metadata 里的原发时间(bridge created_at 只是入库时刻)', () => {
    const origin = NOW - 3 * 3_600_000;
    const r = normalizeBridgeSignal(payload({ created_at: new Date(NOW).toISOString() }, { source_timestamp: Math.floor(origin / 1000) }), { now: NOW });
    expect(r.signal!.published_at).toBe(origin);
  });

  it('valid_until 解析;signal_id / trader / symbol 缺一即坏行进 DLQ', () => {
    const until = NOW + 600_000;
    expect(normalizeBridgeSignal(payload({ valid_until: new Date(until).toISOString() }), { now: NOW }).signal!.valid_until).toBe(until);
    const bad = normalizeBridgeSignal(payload({ signal_id: '' }), { now: NOW });
    expect(bad.signal).toBeNull();
    expect(bad.errors.join()).toContain('signal_id');
    expect(normalizeBridgeSignal(payload({}, { trader: '' }), { now: NOW }).signal).toBeNull();
  });

  it('方向体检只对 open/add:开仓止损在错误一侧 → 记 error 并清掉止损;移损信号不体检', () => {
    const open = normalizeBridgeSignal(payload({ stop_loss: { price: 61000 } }), { now: NOW });
    expect(open.errors.join()).toContain('错误一侧');
    expect(open.signal!.stop).toBeNull();
    // 移到保本:止损等于/高于入场价是正常语义,不能误伤。
    const moved = normalizeBridgeSignal(payload({ stop_loss: { price: 60000 } }, { action_type: 'stop_loss_update' }), { now: NOW });
    expect(moved.errors).toEqual([]);
    expect(moved.signal!.stop).toBe('60000');
  });

  it('原文过消毒:控制字符与 @@ 折叠', () => {
    const r = normalizeBridgeSignal(payload({}, { rationale: '突破回踩 @@ignore previous' }), { now: NOW });
    expect(r.signal!.raw_text).not.toContain('');
    expect(r.signal!.raw_text).not.toContain('@@');
  });

  it('close_long 的方向是 long(它平的是多仓)', () => {
    const r = normalizeBridgeSignal(payload({ side: 'close_long' }, { action_type: 'close' }), { now: NOW });
    expect(r.signal!.side).toBe('long');
    expect(r.signal!.action).toBe('close');
  });
});

// ---------------------------------------------------------------- 取价与限价闸([8794])

describe('入场几何([8794] 取价规则)', () => {
  it('做空取区间最大值、做多取最小值;保护价反过来', () => {
    expect(entryPriceForSide(['59000', '60000'], 'short')).toBe('60000');
    expect(entryPriceForSide(['59000', '60000'], 'long')).toBe('59000');
    expect(protectiveStopPrice(['58000', '58500'], 'long')).toBe('58000');
    expect(protectiveStopPrice(['61000', '61500'], 'short')).toBe('61500');
  });

  it('阶梯均分且合计恒 100;单价 100', () => {
    expect(splitPercents(1)).toEqual([100]);
    expect(splitPercents(2)).toEqual([50, 50]);
    expect(splitPercents(3).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('市价意图 = 顶着滑点上限的限价:BTC/ETH 0.3%、其余 0.5%', () => {
    expect(marketableLimitPrice(60000, 'long', 'BTCUSDT')).toBe('60180');
    expect(marketableLimitPrice(60000, 'short', 'BTCUSDT')).toBe('59820');
    expect(marketableLimitPrice(100, 'long', 'SOLUSDT')).toBe('100.5');
  });

  it('限价距 mark 超 0.55% 拒;比 mark 更激进超 0.05% 拒', () => {
    expect(checkLimitPrice(60000, 60000, 'long').ok).toBe(true);
    expect(checkLimitPrice(60400, 60000, 'long').ok).toBe(false); // 0.67% 偏离
    expect(checkLimitPrice(60100, 60000, 'long').ok).toBe(false); // 0.167% 更激进
    expect(checkLimitPrice(59900, 60000, 'long').ok).toBe(true); // 挂在下方 = 不激进
  });

  it('entryPlanFor:止损取更紧的那个(agent 更紧就用 agent 的)', () => {
    const plan = entryPlanFor({ signal: sig(), mark: 60000, agent_stop: '59500' });
    expect(plan.ok).toBe(true);
    expect(plan.stop).toBe('59500');
    expect(plan.reason).toContain('agent');
    // agent 更松 → 还是用信号的
    expect(entryPlanFor({ signal: sig(), mark: 60000, agent_stop: '58000' }).stop).toBe('59000');
  });

  it('entryPlanFor:止损在错误一侧 → 不 ok', () => {
    expect(entryPlanFor({ signal: sig({ stop: '61000' }), mark: 60000 }).ok).toBe(false);
  });

  it('entryPlanFor:市价意图翻成限价且 intent=market', () => {
    const p = entryPlanFor({ signal: sig({ entry_kind: 'market', entry_prices: [] }), mark: 60000 });
    expect(p.price).toBe('60180');
    expect(p.intent).toBe('market');
  });

  it('区间按方向取价:做空取最大、做多取最小(取的价就是要挂的价)', () => {
    const short = entryPlanFor({ signal: sig({ side: 'short', entry_kind: 'zone', entry_prices: ['100', '100.4'], stop: '101', tps: [] }), mark: 100.2 });
    expect(short.ok).toBe(true);
    expect(short.price).toBe('100.4'); // 不是排序后的第一个 100
    const long = entryPlanFor({ signal: sig({ entry_kind: 'zone', entry_prices: ['59500', '60000'] }), mark: 59800 });
    expect(long.price).toBe('59500');
    expect(long.legs).toHaveLength(1);
  });

  it('多档阶梯:不降级成「第一档挂全量」,标 unsupported 转人工', () => {
    const plan = entryPlanFor({ signal: sig({ entry_kind: 'ladder', entry_prices: ['58000', '59000', '59500'] }), mark: 59600 });
    expect(plan.ok).toBe(false);
    expect(plan.unsupported).toContain('多档阶梯');
    // 计划里仍然算出每档份额(留给人看),但绝不返回一个可执行的单腿计划
    expect(plan.legs.map((l) => l.percent).reduce((a, b) => a + b, 0)).toBe(100);
    expect(plan.price).toBeNull();
  });

  it('市价意图的顶偏离限价不被普通限价的激进度闸误拒;超过滑点上限才拒', () => {
    // 60180 对 mark 60000 = +0.3%,正好是 BTC 的滑点上限:按 market 意图放行,按普通限价必拒
    expect(checkLimitPrice(60180, 60000, 'long', { intent: 'market', symbol: 'BTCUSDT' }).ok).toBe(true);
    expect(checkLimitPrice(60180, 60000, 'long').ok).toBe(false);
    // 非主流币 0.5%
    expect(checkLimitPrice(100.5, 100, 'long', { intent: 'market', symbol: 'SOLUSDT' }).ok).toBe(true);
    // 超过上限:拒
    expect(checkLimitPrice(60300, 60000, 'long', { intent: 'market', symbol: 'BTCUSDT' }).ok).toBe(false);
    // 空头对称
    expect(checkLimitPrice(59820, 60000, 'short', { intent: 'market', symbol: 'BTCUSDT' }).ok).toBe(true);
    expect(checkLimitPrice(59700, 60000, 'short', { intent: 'market', symbol: 'BTCUSDT' }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- 三模式分支 + 新鲜度

describe('resolveMode 三模式', () => {
  it('名册内 copy → triggered;名册外 / 停用 / 总开关关 → 不处理', () => {
    expect(resolveMode({ signal: sig(), follow: settings(), stats: null, now: NOW }).mode).toBe('book');
    expect(resolveMode({ signal: sig({ trader: '路人', subscription_job_id: 'job-other' }), follow: settings(), stats: null, now: NOW }).mode).toBe('evidence');
    expect(resolveMode({ signal: sig(), follow: settings({}, { enabled: false }), stats: null, now: NOW }).mode).toBeNull();
    expect(resolveMode({ signal: sig(), follow: settings({ enabled: false }), stats: null, now: NOW }).mode).toBeNull();
  });

  it('新鲜度:超过 freshness_s 只能 evidence,并记 trader_signal_stale', () => {
    const stale = sig({ published_at: NOW - 400_000 });
    const d = resolveMode({ signal: stale, follow: settings(), stats: null, now: NOW });
    expect(d.mode).toBe('evidence');
    expect(d.status).toBe('evidence');
    expect(d.codes).toContain('trader_signal_stale');
  });

  it('补拉一律 review_only,永远不自动开仓', () => {
    const d = resolveMode({ signal: sig({ backfill: true }), follow: settings(), stats: null, now: NOW });
    expect(d.mode).toBe('evidence');
    expect(d.status).toBe('review_only');
  });

  it('无止损 → 降级 evidence 并记 trader_signal_no_stop', () => {
    const d = resolveMode({ signal: sig({ stop: null }), follow: settings(), stats: null, now: NOW });
    expect(d.mode).toBe('evidence');
    expect(d.codes).toContain('trader_signal_no_stop');
  });

  it('valid_until 已过 → expired', () => {
    const s = sig({ valid_until: NOW - 1 });
    expect(isExpired(s, NOW)).toBe(true);
    expect(resolveMode({ signal: s, follow: settings(), stats: null, now: NOW }).status).toBe('expired');
  });

  it('每人每日上限:到了就只当证据', () => {
    const d = resolveMode({ signal: sig(), follow: settings(), stats: null, now: NOW, openings_today: 6 });
    expect(d.mode).toBe('evidence');
    expect(d.codes).toContain('trader_gate_blocked');
  });

  it('backend 不支持这个 symbol(代币化美股)→ 只当证据', () => {
    expect(resolveMode({ signal: sig({ symbol: 'AAPLUSDT' }), follow: settings(), stats: null, now: NOW, symbol_supported: false }).mode).toBe('evidence');
  });

  it('add 永远不自动执行,但首发和 open 一样走到 review_only(带几何给人看)', () => {
    // R4-07:首发口径是「含 copy 的 open/add 都等人工」;提前 skipped 会让人在界面上点不了跟
    const d = resolveMode({ signal: sig({ action: 'add' }), follow: settings(), stats: null, now: NOW });
    expect(d.status).toBe('triggered'); // 判定层放行,由编排落 review_only
    expect(d.codes).toContain('trader_add_manual');
  });

  it('gated 模式下 add 照常当一次新的 open 判断', () => {
    const d = resolveMode({ signal: sig({ action: 'add' }), follow: settings({}, { mode: 'gated' }), stats: null, now: NOW });
    expect(d.mode).toBe('gated');
    expect(d.status).toBe('triggered');
  });

  it('权重为 0 = 只留证据不下单', () => {
    expect(resolveMode({ signal: sig(), follow: settings({}, { weight: 0 }), stats: null, now: NOW }).mode).toBe('evidence');
  });
});

// ---------------------------------------------------------------- 重复开仓 / 再入场 / 反向

describe('重复开仓与反向敞口', () => {
  it('同人同币已有在仓线程 → duplicate_open', () => {
    const t = traderThread({ status: 'in_position', opened_at: NOW, filled_avg_price: '60000' });
    expect(duplicateCheck({ signal: sig(), live_threads: [t] }).verdict).toBe('duplicate_open');
  });

  it('挂单还在场上工作也算重复(它不是「原单已死」)', () => {
    const t = traderThread({ status: 'pending_entry', opened_at: null, filled_avg_price: null });
    const r = duplicateCheck({ signal: sig(), live_threads: [t] });
    expect(r.verdict).toBe('duplicate_open');
    expect(r.note).toContain('挂单在场');
  });

  it('原单已死(线程已撤、从没成交)→ reentry(R53 再入场)', () => {
    const dead = traderThread({ status: 'canceled', opened_at: null, filled_avg_price: null });
    const r = duplicateCheck({ signal: sig(), live_threads: [], prior_threads: [dead] });
    expect(r.verdict).toBe('reentry');
    expect(r.note).toContain('R53');
  });

  it('同名 ASP 的不同 jobId 不串联管理动作，也不误判本订阅重复开仓', () => {
    const otherJob = traderThread({ id: 'thr_other_job', origin: 'trader:job-other', status: 'in_position', opened_at: NOW });
    const mine = sig({ trader: '同名 ASP', subscription_job_id: 'job-trader_b' });
    expect(duplicateCheck({ signal: mine, live_threads: [otherJob] }).verdict).toBe('new');
    expect(linkThread({ ...mine, action: 'close' }, [otherJob]).thread).toBeNull();
    expect(linkThread({ ...mine, action: 'close', ref_order: otherJob.id }, [otherJob]).thread).toBeNull();
    const ownJob = traderThread({ id: 'thr_own_job', origin: 'trader:job-trader_b', status: 'in_position', opened_at: NOW });
    expect(duplicateCheck({ signal: mine, live_threads: [otherJob, ownJob] }).thread?.id).toBe(ownJob.id);
    expect(linkThread({ ...mine, action: 'close' }, [otherJob, ownJob]).thread?.id).toBe(ownJob.id);
    expect(reverseCheck({ ...mine, side: 'short' }, [otherJob]).blocked).toBe(true);
  });

  it('没有 jobId 的旧信号仍仅关联同名 legacy origin', () => {
    const legacy = sig({ subscription_job_id: null });
    const oldThread = traderThread({ origin: 'trader:TraderB', status: 'in_position', opened_at: NOW });
    expect(linkThread({ ...legacy, action: 'close' }, [oldThread]).thread?.id).toBe(oldThread.id);
    expect(duplicateCheck({ signal: legacy, live_threads: [oldThread] }).verdict).toBe('duplicate_open');
  });

  it('别人的线程不算重复(按 origin 分)', () => {
    const other = traderThread({ origin: 'trader:TraderA', status: 'in_position', opened_at: NOW });
    expect(duplicateCheck({ signal: sig(), live_threads: [other] }).verdict).toBe('new');
  });

  it('同币已有反向线程 → 拒(不限来源)', () => {
    const short = traderThread({ id: 'thr_s', side: 'short', origin: undefined, source: 'agent' });
    expect(reverseCheck(sig(), [short]).blocked).toBe(true);
    expect(reverseCheck(sig(), [traderThread()]).blocked).toBe(false);
  });
});

// ---------------------------------------------------------------- 管理动作路由

describe('routeManagement 管理动作', () => {
  const t = traderThread({ status: 'in_position', opened_at: NOW, filled_avg_price: '60000' });

  it('close / stopped_out → 自动平线程', () => {
    expect(routeManagement(sig({ action: 'close' }), t).kind).toBe('close');
    expect(routeManagement(sig({ action: 'stopped_out' }), t).kind).toBe('close');
  });

  it('reduce:首发一律人工(不动仓不撤单),比例只当人工队列的文案', () => {
    // R2 收缩范围:减仓没有自动路径了 —— 比例读得出来也只是写进给人看的文案。
    const clear = routeManagement(sig({ action: 'reduce', raw_text: '先减 30%' }), t);
    expect(clear.pending_review).toBe(true);
    expect(clear.note).toContain('不自动执行仓位管理');
    expect(clear.note).toContain('30%');
    expect(clear.reduce_pct).toBe(30);
    // 解析本身仍然要准(文案会写给人看,读错会误导)
    expect(reducePercentOf(sig({ raw_text: '止盈 50%' }))).toEqual({ pct: 50, ambiguous: false });
    expect(reducePercentOf(sig({ raw_text: '减半' }))).toEqual({ pct: 50, ambiguous: false });
    // 收益里的百分比不是仓位比例:第一版会取到 100 直接全平
    expect(reducePercentOf(sig({ raw_text: '收益100%,减仓50%' }))).toEqual({ pct: 50, ambiguous: false });
    expect(reducePercentOf(sig({ raw_text: '2%仓位,先减一点' })).pct).toBeNull();
    expect(reducePercentOf(sig({ raw_text: '减 30%,再平 50%' }))).toEqual({ pct: null, ambiguous: true });
    // 读不出来时文案要说读不出来,不能假装有个数
    const conflicting = routeManagement(sig({ action: 'reduce', raw_text: '减 30%,再平 50%' }), t);
    expect(conflicting.pending_review).toBe(true);
    expect(conflicting.note).toContain('读不出来');
    expect(conflicting.reduce_pct).toBeNull();
  });

  it('cancel → 撤未成交入场腿', () => {
    expect(routeManagement(sig({ action: 'cancel' }), t).kind).toBe('cancel_entries');
  });

  it('stop_loss_update:首发一律人工(收紧也不自动挂)', () => {
    // R2-04/R2-05:改保护腿的实现会按 symbol 扫撤同币条件单、撤一半失败没恢复、TP 失败仍报成功。
    // 那三样没做好之前,连「收紧」都不自动动 —— 撤穿保护比不移损危险得多。
    for (const stop of ['59500', '58000', '60000']) {
      const plan = routeManagement(sig({ action: 'stop_loss_update', stop }), t);
      expect(plan.pending_review).toBe(true);
      expect(plan.note).toContain('不自动执行仓位管理');
      expect(plan.stop_price).toBe(stop);
    }
  });

  it('「移到保本」也进人工,文案里点明是保本口径', () => {
    const s = sig({ action: 'stop_loss_update', stop: '59900', raw_text: '止损移到保本' });
    const plan = routeManagement(s, t);
    expect(plan.pending_review).toBe(true);
    expect(plan.note).toContain('保本');
    // 保本口径的识别与收紧判定仍然要对(人工执行时按它算,也留给以后接自动路)
    expect(mentionsCostBasis('止损移到保本')).toBe(true);
    expect(stopTightens('long', 59000, 60000)).toBe(true);
    expect(stopTightens('long', 59000, 58000)).toBe(false);
    expect(stopTightens('short', 61000, 60000)).toBe(true);
  });

  it('take_profit_update:首发一律人工(分档减仓没实现,不假装改档)', () => {
    const plan = routeManagement(sig({ action: 'take_profit_update', tps: [{ price: '63000', pct: null }, { price: '65000', pct: null }] }), t);
    expect(plan.pending_review).toBe(true);
    expect(plan.note).toContain('63000/65000');
    // percent 一律 0:本实现兑现不了份额,不写一个看起来像已生效的数
    expect(plan.take_profits.map((x) => x.percent)).toEqual([0, 0]);
  });

  it('找不到关联线程 → trader_mgmt_orphan,不动仓', () => {
    const plan = routeManagement(sig({ action: 'close' }), null, { link_reason: '没有活线程' });
    expect(plan.kind).toBe('none');
    expect(plan.codes).toContain('trader_mgmt_orphan');
  });

  it('add 走自己的分支:不自动执行', () => {
    expect(routeManagement(sig({ action: 'add' }), t).kind).toBe('add_manual');
  });

  it('linkThread:引用只认精确命中,查不到就是孤儿(不回退到别的线程)', () => {
    const a = traderThread({ id: 'thr_a', trader_signal_id: 'sig_old' });
    const b = traderThread({ id: 'thr_b', trader_signal_id: 'sig_new' });
    expect(linkThread(sig({ ref_order: 'sig_new' }), [a, b]).thread?.id).toBe('thr_b');
    // 明确引用一条已经结束的旧单 → 孤儿;第一版会回退命中在仓的新单并把它平掉(P0-01)
    const missing = linkThread(sig({ ref_order: 'sig_gone' }), [b]);
    expect(missing.thread).toBeNull();
    expect(missing.reason).toContain('找不到那一单');
    // 引用命中但方向不符 → 孤儿
    const wrongSide = linkThread(sig({ ref_order: 'sig_new', side: 'short' }), [b]);
    expect(wrongSide.thread).toBeNull();
    expect(wrongSide.reason).toContain('方向');
  });

  it('linkThread:方向必须一致;同向多条 / 无方向多条一律孤儿', () => {
    const long = traderThread({ id: 'thr_l', side: 'long' });
    const short = traderThread({ id: 'thr_s', side: 'short' });
    // close_long 只能平多仓:只有 short 线程时是孤儿(第一版 mine[0] 会命中 short 并平掉它)
    const onlyShort = linkThread(sig({ side: 'long', action: 'close' }), [short]);
    expect(onlyShort.thread).toBeNull();
    expect(onlyShort.reason).toContain('方向');
    expect(linkThread(sig({ side: 'long', action: 'close' }), [long, short]).thread?.id).toBe('thr_l');
    // 同向两条、挑不出来 → 孤儿
    const two = linkThread(sig({ side: 'long', action: 'close' }), [long, traderThread({ id: 'thr_l2', side: 'long' })]);
    expect(two.thread).toBeNull();
    expect(two.reason).toContain('挑不出');
    // 没方向也没引用、同币多条 → 孤儿
    const noSide = linkThread(sig({ side: null, action: 'close' }), [long, short]);
    expect(noSide.thread).toBeNull();
    // 别人的线程永远不碰
    expect(linkThread(sig({ trader: '别人', subscription_job_id: 'job-other' }), [long, short]).thread).toBeNull();
  });
});

// ---------------------------------------------------------------- 权重三档

describe('权重(8794 统计)', () => {
  const snap = (rows: Record<string, unknown>[]): TraderStatsSnapshot => ({ rows: parseTraderStats({ by_source: Object.fromEntries(rows.map((r) => [r['trader'], r])) }, NOW), fetched_at: NOW, error: null });

  it('三档:≥55% 且 dd ≤15% → 1.0;dd > 30% → 0.5;其余 0.75', () => {
    const good = parseTraderStats({ by_source: { A: { resolved: 30, win_rate: 60, max_drawdown_pct: 10 } } }, NOW)[0]!;
    const mid = parseTraderStats({ by_source: { B: { resolved: 30, win_rate: 50, max_drawdown_pct: 20 } } }, NOW)[0]!;
    const bad = parseTraderStats({ by_source: { C: { resolved: 30, win_rate: 70, max_drawdown_pct: 40 } } }, NOW)[0]!;
    expect(autoMult(good)).toBe(1);
    expect(autoMult(mid)).toBe(0.75);
    // 高胜率 + 高回撤仍然是 0.5:先判差再判好
    expect(autoMult(bad)).toBe(0.5);
    expect(autoMult(null)).toBeNull();
  });

  it('weight = manual_weight × auto_mult', () => {
    const w = weightFor('TraderB', 0.8, snap([{ trader: 'TraderB', resolved: 30, win_rate: 60, max_drawdown_pct: 10 }]), DEFAULT_WEIGHT_THRESHOLDS, NOW);
    expect(w.weight).toBe(0.8);
    expect(w.stale).toBe(false);
  });

  it('统计不可用 → 权重压到 min(manual, 0.5),绝不因为故障而放大仓位', () => {
    // manual=1 + 统计缺失:第一版会给 1.0(比有统计时的 0.5 还大 —— 故障让风险翻倍)
    const missing = weightFor('TraderB', 1, null, DEFAULT_WEIGHT_THRESHOLDS, NOW);
    expect(missing).toMatchObject({ weight: 0.5, stale: true, stale_capped: true, auto_mult: null });
    // manual 本来就比上限小 → 不变,也不标 capped
    expect(weightFor('TraderB', 0.3, null, DEFAULT_WEIGHT_THRESHOLDS, NOW)).toMatchObject({ weight: 0.3, stale: true, stale_capped: false });
    const old: TraderStatsSnapshot = { rows: [], fetched_at: NOW - 10 * 3_600_000, error: null };
    expect(weightFor('TraderB', 1, old, DEFAULT_WEIGHT_THRESHOLDS, NOW).weight).toBe(0.5);
    // 一次 HTTP 失败:权重只能变小,不能从 0.5 弹回 1
    const good: TraderStatsSnapshot = { rows: parseTraderStats({ by_source: { TraderB: { resolved: 40, win_rate: 60, max_drawdown_pct: 40 } } }, NOW), fetched_at: NOW, error: null };
    expect(weightFor('TraderB', 1, good, DEFAULT_WEIGHT_THRESHOLDS, NOW).weight).toBe(0.5);
    const failed: TraderStatsSnapshot = { ...good, error: 'HTTP 500' };
    expect(weightFor('TraderB', 1, failed, DEFAULT_WEIGHT_THRESHOLDS, NOW).weight).toBeLessThanOrEqual(0.5);
    // manual_weight 本身也钳在 1 以内(它是折扣不是杠杆)
    expect(weightFor('TraderB', 5, good, DEFAULT_WEIGHT_THRESHOLDS, NOW).manual_weight).toBe(1);
  });

  it('统计校验:缺失≠0、负回撤取绝对值、样本不足不给权重、mult 永远 ≤1', () => {
    const row = (rec: Record<string, unknown>) => parseTraderStats({ by_source: { A: rec } }, NOW)[0]!;
    // 回撤缺失:第一版 Number(null)=0 → 满档 1.0
    expect(row({ resolved: 40, win_rate: 60, max_drawdown_pct: null }).max_drawdown_pct).toBeNull();
    expect(autoMult(row({ resolved: 40, win_rate: 60, max_drawdown_pct: null }))).toBeNull();
    expect(autoMult(row({ resolved: 40, win_rate: 60, max_drawdown_pct: '' }))).toBeNull();
    // 负回撤(strategy-public-api 口径)= 40% 跌幅,不是「≤15」
    expect(autoMult(row({ resolved: 40, win_rate: 60, max_drawdown_pct: -40 }))).toBe(0.5);
    // 样本不足
    expect(autoMult(row({ resolved: 3, win_rate: 100, max_drawdown_pct: 1 }))).toBeNull();
    expect(autoMult(row({ resolved: 0, win_rate: 0, max_drawdown_pct: 0 }))).toBeNull();
    // 胜率越界 = 坏数据
    expect(autoMult(row({ resolved: 40, win_rate: 180, max_drawdown_pct: 1 }))).toBeNull();
    // 设置里把 mult_good 填成 2 也只按 1 算
    expect(autoMult(row({ resolved: 40, win_rate: 60, max_drawdown_pct: 1 }), { ...DEFAULT_WEIGHT_THRESHOLDS, mult_good: 2 })).toBe(1);
  });

  it('leaderboard 形状(traders[].source)也吃', () => {
    const rows = parseTraderStats({ traders: [{ source: 'TraderA', resolved: 12, win_rate: 58.2, max_drawdown_pct: 12.5, total_return_pct: 80 }] }, NOW);
    expect(rows[0]).toMatchObject({ trader: 'TraderA', resolved: 12, win_rate: 58.2, sharpe: null });
  });

  it('仓位 = risk_pct × weight,权重 0 → 0', () => {
    expect(followRiskPct('0.5', 0.75)).toBe('0.375');
    expect(followRiskPct('0.5', 0)).toBe('0');
  });
});

// ---------------------------------------------------------------- 游标 / 退避 / DLQ / 凭证

describe('TraderFeed 游标、退避与 DLQ', () => {
  function kvStore(): { kvGet(k: string): string | null; kvSet(k: string, v: string): void; map: Map<string, string> } {
    const map = new Map<string, string>();
    return { map, kvGet: (k) => map.get(k) ?? null, kvSet: (k, v) => void map.set(k, v) };
  }
  const creds = { api_key: 'sbk_test', secret_token: 'sbs_test' };

  function feedWith(handler: (url: string, init: Parameters<FollowFetch>[1]) => { ok?: boolean; status?: number; body: unknown }): { feed: TraderFeed; calls: string[]; kv: ReturnType<typeof kvStore> } {
    const kv = kvStore();
    const calls: string[] = [];
    const feed = new TraderFeed({
      kv,
      fetch: async (url, init) => {
        calls.push(url);
        const r = handler(url, init);
        return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
      },
      baseUrl: () => 'https://bridge.example',
      credentials: () => creds,
      now: () => NOW,
    });
    return { feed, calls, kv };
  }

  it('退避:base × 2^(n-1),封顶 60s', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(10_000);
    expect(backoffMs(4)).toBe(40_000);
    expect(backoffMs(5)).toBe(60_000);
    expect(backoffMs(30)).toBe(60_000);
  });

  it('游标用 scanned_to_id,且**只在落库之后**由调用方提交', async () => {
    const { feed, calls, kv } = feedWith(() => ({ body: { ok: true, scanned_to_id: 1204, count: 1, items: [{ record_id: 1198, signal_id: 'sig_1', envelope: { payload: payload() } }] } }));
    const r = await feed.pullOnce({ waitSeconds: 0 });
    expect(r.signals).toHaveLength(1);
    expect(r.next_cursor).toBe(1204); // 不是最后一条 item 的 1198
    // 关键:pullOnce 自己不推进游标(落库失败/崩溃时整页不会丢)
    expect(feed.cursor()).toBe(0);
    expect(kv.map.get('follow.cursor')).toBeUndefined();
    feed.commitCursor(r.next_cursor);
    expect(feed.cursor()).toBe(1204);
    expect(calls[0]).toContain('after_id=0');
    // 更小的游标不许把它拽回去
    feed.commitCursor(900);
    expect(feed.cursor()).toBe(1204);
  });

  it('整页都是坏行时游标照样能安全前进(不然会反复重读同一坏页)', async () => {
    const { feed } = feedWith(() => ({
      // 没有 scanned_to_id 的异常响应 + 全是归一化失败的行
      body: { items: [{ record_id: 77, signal_id: 'bad', envelope: { payload: payload({ signal_id: '' }) } }] },
    }));
    const r = await feed.pullOnce({ waitSeconds: 0 });
    expect(r.signals).toEqual([]);
    expect(r.dropped).toBe(1);
    expect(r.quarantined).toEqual([77]);
    expect(r.next_cursor).toBe(77); // 坏行已进 DLQ 留痕,可以跨过去
  });

  it('请求带鉴权双头 + 自定义 UA + agent_id', async () => {
    let headers: Record<string, string> = {};
    const kv = kvStore();
    const feed = new TraderFeed({
      kv,
      fetch: async (_url, init) => {
        headers = init.headers;
        return { ok: true, status: 200, text: async () => JSON.stringify({ items: [], scanned_to_id: 1 }) };
      },
      baseUrl: () => 'https://bridge.example',
      credentials: () => creds,
      now: () => NOW,
    });
    await feed.pullOnce({ waitSeconds: 0 });
    expect(headers['X-API-Key']).toBe('sbk_test');
    expect(headers['X-Secret-Token']).toBe('sbs_test');
    expect(headers['User-Agent']).toBe('trade-gate-follow/0.1');
  });

  it('失败不抛:记 error、推退避,ready() 变 false', async () => {
    const { feed } = feedWith(() => ({ ok: false, status: 500, body: { error: 'boom' } }));
    const r = await feed.pullOnce({ waitSeconds: 0 });
    expect(r.error).toContain('500');
    expect(r.signals).toEqual([]);
    expect(feed.ready(NOW)).toBe(false);
    expect(feed.ready(NOW + 6_000)).toBe(true);
    expect(feed.status().failures).toBe(1);
  });

  it('DLQ:桥跳过的坏行 + 我们归一化失败的行都计数', async () => {
    const { feed } = feedWith(() => ({
      body: {
        scanned_to_id: 10,
        items: [{ record_id: 9, signal_id: 'sig_bad', envelope: { payload: payload({ signal_id: '' }) } }],
        skipped: [{ record_id: 8, signal_id: 'sig_worse', error: 'ValidationError: x' }],
      },
    }));
    const r = await feed.pullOnce({ waitSeconds: 0 });
    expect(r.signals).toEqual([]);
    expect(r.dropped).toBe(2);
    const dlq = feed.dlq();
    expect(dlq.count).toBe(2);
    expect(dlq.recent.map((e) => e.stage).sort()).toEqual(['bridge', 'normalize']);
  });

  it('启动补拉:/me 定起点与目标水位,拉到的每条都带 backfill,到水位才算完', async () => {
    let page = 0;
    const { feed, calls } = feedWith((url) => {
      if (url.includes('/me')) return { body: { recent_after_id: 500, cursor: 520 } };
      page += 1;
      return page === 1
        ? { body: { scanned_to_id: 510, items: [{ record_id: 501, signal_id: 'sig_b1', envelope: { payload: payload({ signal_id: 'sig_b1' }) } }] } }
        : { body: { scanned_to_id: 520, items: [] } };
    });
    const first = await feed.backfillStep(500);
    expect(calls[0]).toContain('recent=500');
    expect(first.signals).toHaveLength(1);
    expect(first.signals[0]!.backfill).toBe(true);
    expect(first.target).toBe(520);
    expect(first.done).toBe(false); // 才到 510,水位是 520
    feed.commitCursor(first.next_cursor);
    const second = await feed.backfillStep(500);
    expect(second.done).toBe(true); // 追上水位
    expect(feed.backfillDone()).toBe(false); // 还没 finishBackfill,不能切 live
    feed.finishBackfill();
    expect(feed.backfillDone()).toBe(true);
  });

  it('补拉「只有被过滤记录的空页」不算补完;/me 失败不置完成', async () => {
    // 空页(scanned_to_id 前进但没有属于我们的信号)后面还有历史:不能提前结束
    let page = 0;
    const { feed } = feedWith((url) => {
      if (url.includes('/me')) return { body: { recent_after_id: 0, cursor: 900 } };
      page += 1;
      return { body: { scanned_to_id: page * 100, items: [] } };
    });
    const step = await feed.backfillStep(500);
    expect(step.done).toBe(false);
    expect(feed.backfillDone()).toBe(false);

    const broken = feedWith((url) => (url.includes('/me') ? { ok: false, status: 500, body: {} } : { body: { scanned_to_id: 1, items: [] } }));
    const r = await broken.feed.backfillStep(500);
    expect(r.error).toContain('500');
    expect(r.done).toBe(false);
    expect(broken.feed.backfillDone()).toBe(false); // 失败不许切 live
  });

  it('凭证只从 env 读,kv 里写了也不认(TS 侧不持密)', () => {
    const kv = kvStore();
    kv.kvSet('follow.credentials', JSON.stringify({ api_key: 'sbk_fromkv', secret_token: 'sbs_fromkv' }));
    expect(readCredentials(kv, {}).creds).toBeNull();
    expect(readCredentials(kv, {}).source).toBeNull();
    expect(readCredentials(kv, { TG_FOLLOW_BRIDGE_KEY: 'sbk_env12345', TG_FOLLOW_BRIDGE_SECRET: 'sbs_env12345' })).toMatchObject({ source: 'env', creds: { api_key: 'sbk_env12345' } });
    expect(maskSecret('sbk_abcdefgh')).toBe('sbk_***efgh');
    expect(maskSecret(null)).toBeNull();
    // 只有一半凭证 = 没配
    expect(readCredentials(kvStore(), { TG_FOLLOW_BRIDGE_KEY: 'sbk_env' }).creds).toBeNull();
  });

  it('凭证不会从错误正文 / DLQ / 异常里漏出去', async () => {
    const key = 'sbk_leak_abcd1234';
    const secret = 'sbs_leak_wxyz9876';
    // bridge 把我们发过去的 key/secret 原样回显在错误正文里
    const { feed } = feedWith(() => ({ ok: false, status: 401, body: { detail: `bad key ${key} / ${secret}` } }));
    const kv2 = kvStore();
    const leaky = new TraderFeed({
      kv: kv2,
      fetch: async () => ({ ok: false, status: 401, text: async () => `bad key ${key} secret ${secret}` }),
      baseUrl: () => 'https://bridge.example',
      credentials: () => ({ api_key: key, secret_token: secret }),
      now: () => NOW,
    });
    const r = await leaky.pullOnce({ waitSeconds: 0 });
    expect(r.error).not.toContain(key);
    expect(r.error).not.toContain(secret);
    expect(r.error).toContain('***');
    expect(JSON.stringify(leaky.status())).not.toContain(key);
    // skipped[].error 里的凭证也要抹掉
    const dlqFeed = new TraderFeed({
      kv: kvStore(),
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ scanned_to_id: 5, items: [], skipped: [{ record_id: 4, signal_id: 'x', error: `boom ${key}` }] }) }),
      baseUrl: () => 'https://bridge.example',
      credentials: () => ({ api_key: key, secret_token: secret }),
      now: () => NOW,
    });
    await dlqFeed.pullOnce({ waitSeconds: 0 });
    expect(JSON.stringify(dlqFeed.dlq())).not.toContain(key);
    expect(redactSecrets(`x ${key} y`, { api_key: key, secret_token: secret })).not.toContain(key);
    // 没给 creds 也能按前缀兜住任意 sbk_/sbs_ 形状
    expect(redactSecrets('leak sbk_someotherkey123 here')).not.toContain('sbk_someotherkey123');
    void feed;
  });
});

// ---------------------------------------------------------------- 状态机 + 设置归一化

describe('状态机与设置', () => {
  it('状态机:终态不许被改回去;review_only 只能去 applying/skipped', () => {
    const applied = sig({ status: 'applied' });
    expect(transition(applied, 'skipped', {}, NOW).status).toBe('applied');
    expect(transition(sig(), 'triggered', {}, NOW).status).toBe('triggered');
    // review_only 是唯一可执行前态:apply 先领取成 applying
    expect(transition(sig({ status: 'review_only' }), 'applying', {}, NOW).status).toBe('applying');
    expect(transition(sig({ status: 'review_only' }), 'skipped', {}, NOW).status).toBe('skipped');
    // 不能从 review_only 直接跳到 applied(必须先领取)
    expect(transition(sig({ status: 'review_only' }), 'applied', {}, NOW).status).toBe('review_only');
    // applying 崩溃后只能被隔离回 review_only,或走完自己那次执行
    expect(transition(sig({ status: 'applying' }), 'review_only', {}, NOW).status).toBe('review_only');
    expect(transition(sig({ status: 'applying' }), 'applied', {}, NOW).status).toBe('applied');
    expect(transition(sig({ status: 'applying' }), 'apply_failed', {}, NOW).status).toBe('apply_failed');
    // triggered 不许被 skip 抹掉(那会擦掉「已发出」这个事实)
    expect(transition(sig({ status: 'triggered' }), 'skipped', {}, NOW).status).toBe('triggered');
  });

  it('follow 设置 fail-closed:手改坏的模式回 evidence、越界权重钳住、enabled 必须显式 true', () => {
    const f = normalizeFollowSettings({ enabled: 'yes', freshness_s: -5, subscriptions: { 'job-trader_b': { mode: 'copy!!', weight: 9, enabled: 1 } } });
    expect(f.enabled).toBe(false);
    expect(f.freshness_s).toBe(180);
    expect(f.subscriptions['job-trader_b']).toEqual({ mode: 'evidence', weight: 0, enabled: false, approval: 'manual' });
    expect(normalizeFollowSettings(null).subscriptions).toEqual({});
    expect(normalizeFollowSettings({ transport: 'invalid' }).transport).toBe('queue');
  });

  it('出厂默认:关闭 + 空名册 + gated', () => {
    expect(DEFAULT_FOLLOW_SETTINGS).toMatchObject({ enabled: false, default_mode: 'evidence', freshness_s: 180 });
    expect(DEFAULT_FOLLOW_SETTINGS.subscriptions).toEqual({});
  });
});

// ---------------------------------------------------------------- 编排(假 deps)

describe('TraderFollow 编排', () => {
  function harness(over: { follow?: FollowSettings; threads?: StrategyThread[]; judge?: FollowDeps['judge']; openError?: string | null; actionResult?: ManagementResult } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'tg-follow-'));
    const state = openStateDb(join(dir, 'state.sqlite'));
    const store = new DemoStore(state);
    const calls: string[] = [];
    const emitted: TraderSignal[] = [];
    let threads = over.threads ?? [];
    const deps: FollowDeps = {
      follow: () => over.follow ?? settings(),
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
      markOf: async () => 60000,
      symbolSupported: async () => true,
      openFromSignal: async (_s, _plan: EntryPlan) => {
        calls.push('open');
        if (over.openError) return { outcome: 'rejected' as const, reason: over.openError };
        const t = traderThread({ id: 'thr_new', status: 'in_position', opened_at: NOW, filled_avg_price: '60000' });
        threads = [...threads, t];
        return { outcome: 'opened' as const, thread_id: t.id, reason: '' };
      },
      manualOpen: async (_s, _plan: EntryPlan) => {
        calls.push('manual_open');
        if (over.openError) return { outcome: 'rejected' as const, reason: over.openError };
        const t = traderThread({ id: 'thr_manual', status: 'in_position', opened_at: NOW, filled_avg_price: '60000', source: 'manual' });
        threads = [...threads, t];
        return { outcome: 'opened' as const, thread_id: t.id, reason: '' };
      },
      judge: over.judge ?? (async () => ({ episode_id: 'ep_1', action: 'PROPOSE', direction: 'long', stop: '59500', blocked: [], error: null })),
      closeThread: async (id) => (calls.push(`close:${id}`), over.actionResult ?? { ok: true, detail: '已平' }),
      cancelEntries: async (id) => (calls.push(`cancel:${id}`), over.actionResult ?? { ok: true, detail: '已撤' }),
      recordLedger: () => void calls.push('ledger'),
      emit: (s) => void emitted.push(s),
      log: () => {},
      pendingReview: () => void calls.push('pending_review'),
    };
    return { follow: new TraderFollow(deps), store, calls, emitted, close: () => { state.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it('copy:仅 open 自动执行一次并保存已应用结果与信号几何', async () => {
    const h = harness();
    try {
      const r = await h.follow.ingest(sig());
      expect(r.signal.status).toBe('applied');
      expect(r.signal.thread_id).toBe('thr_new');
      expect(r.signal.decision?.codes).toContain('trader_follow_book');
      expect(r.signal.decision?.plan).toMatchObject({ entry: '60000', stop: '59000', intent: 'limit' });
      expect(h.calls.filter((c) => c === 'open')).toHaveLength(1);
      expect(h.calls).not.toContain('manual_open');
    } finally { h.close(); }
  });

  it('copy 等待取行情时切为 gated 会撤销自动开仓授权', async () => {
    const current = settings();
    const h = harness({ follow: current });
    try {
      const deps = (h.follow as unknown as { deps: FollowDeps }).deps;
      deps.markOf = async () => { current.subscriptions['job-trader_b']!.mode = 'gated'; return 60000; };
      const result = await h.follow.ingest(sig());
      expect(result.signal.status).not.toBe('applied');
      expect(h.calls).not.toContain('open');
      expect(h.calls).not.toContain('manual_open');
    } finally { h.close(); }
  });

  it('copy 发送前再次复查模式，切 gated 后执行器不得发送', async () => {
    const current = settings();
    const h = harness({ follow: current });
    let sends = 0;
    try {
      const deps = (h.follow as unknown as { deps: FollowDeps }).deps;
      deps.openFromSignal = async (_signal, _plan, ctx) => {
        current.subscriptions['job-trader_b']!.mode = 'gated';
        const authorized = ctx.authorize!();
        expect(authorized.ok).toBe(false);
        if (authorized.ok) sends++;
        return { outcome: 'rejected', reason: authorized.reason };
      };
      const result = await h.follow.ingest(sig());
      expect(result.signal.status).not.toBe('applied');
      expect(sends).toBe(0);
    } finally { h.close(); }
  });

  it('copy unknown 保留线程关联并强制核对，同事件重投不重发', async () => {
    const h = harness();
    let sends = 0;
    try {
      const deps = (h.follow as unknown as { deps: FollowDeps }).deps;
      deps.openFromSignal = async () => {
        expect(h.store.traderSignals.find('sig_1')!.status).toBe('triggered');
        sends++;
        return { outcome: 'unknown', thread_id: 'thr_unknown', reason: '回执超时' };
      };
      const result = await h.follow.ingest(sig());
      expect(result.signal).toMatchObject({ status: 'review_only', needs_reconcile: true, thread_id: 'thr_unknown' });
      expect(h.store.traderSignals.find('sig_1')).toMatchObject({ needs_reconcile: true, thread_id: 'thr_unknown' });
      await h.follow.ingest(sig());
      expect(sends).toBe(1);
      expect((await h.follow.applyManually('sig_1')).status).toBe(409);
      expect(h.follow.skipManually('sig_1').status).toBe(409);
    } finally { h.close(); }
  });

  it('幂等:同一个 signal_id 再来一次不重复处置', async () => {
    const h = harness();
    try {
      await h.follow.ingest(sig());
      const again = await h.follow.ingest(sig());
      expect(again.note).toContain('幂等');
      expect(h.calls.filter((c) => c === 'open')).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('已发出未确认(triggered)的行在编排入口也不重跑(R3-04:三个入口同一条纪律)', async () => {
    const h = harness();
    try {
      const incoming = sig({ signal_id: 'sig_trig', id: 'tsig_trig' });
      h.store.traderSignals.capture({ ...incoming, status: 'triggered', thread_id: 'thr_x' });
      const r = await h.follow.ingest(incoming);
      expect(r.note).toContain('不重发');
      expect(h.calls).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('gated + agent 同向 → review_only,agent 结论与几何(止损取 agent 更紧那个)写在信号行上', async () => {
    const h = harness({ follow: settings({}, { mode: 'gated' }) });
    try {
      const r = await h.follow.ingest(sig());
      expect(r.signal.status).toBe('review_only');
      expect(r.signal.decision?.codes).toContain('trader_follow_agent_agree');
      expect(r.signal.decision?.episode_id).toBe('ep_1');
      // agent 结论是给人的依据
      expect(r.signal.decision?.agent).toMatchObject({ stance: 'agree', action: 'PROPOSE', direction: 'long', stop: '59500', blocked: [] });
      // 止损取 agent 的 59500(比信号的 59000 更紧)
      expect(r.signal.decision?.plan?.stop).toBe('59500');
      expect(h.calls).not.toContain('open');
      expect(h.calls).not.toContain('manual_open');
    } finally {
      h.close();
    }
  });

  it('gated + agent 反向/不入场 → skipped,agent 结论照样落行(人还能看到为什么不跟)', async () => {
    const h = harness({ follow: settings({}, { mode: 'gated' }), judge: async () => ({ episode_id: 'ep_x', action: 'PROPOSE', direction: 'short', stop: null, blocked: [], error: null }) });
    try {
      const r = await h.follow.ingest(sig());
      expect(r.signal.status).toBe('skipped');
      expect(r.signal.decision?.agent).toMatchObject({ stance: 'disagree', direction: 'short' });
    } finally {
      h.close();
    }
  });

  it('gated + agent 反向 → 不开,记 trader_follow_agent_disagree', async () => {
    const h = harness({ follow: settings({}, { mode: 'gated' }), judge: async () => ({ episode_id: 'ep_2', action: 'PROPOSE', direction: 'short', stop: null, error: null }) });
    try {
      const r = await h.follow.ingest(sig());
      expect(r.signal.status).toBe('skipped');
      expect(r.signal.decision?.codes).toContain('trader_follow_agent_disagree');
      expect(h.calls).not.toContain('open');
    } finally {
      h.close();
    }
  });

  it('gated + agent 不入场 → trader_follow_agent_flat', async () => {
    const h = harness({ follow: settings({}, { mode: 'gated' }), judge: async () => ({ episode_id: 'ep_3', action: 'NO_TRADE', direction: null, stop: null, error: null }) });
    try {
      expect((await h.follow.ingest(sig())).signal.decision?.codes).toContain('trader_follow_agent_flat');
    } finally {
      h.close();
    }
  });

  it('evidence 模式:不开线程、不问 agent,只落一行 + 账本', async () => {
    const h = harness({ follow: settings({}, { mode: 'evidence' }) });
    try {
      const r = await h.follow.ingest(sig());
      expect(r.signal.status).toBe('evidence');
      expect(h.calls).toEqual(['ledger']);
    } finally {
      h.close();
    }
  });

  it('反向敞口 / 重复开仓 → skipped 并带对应 reason code', async () => {
    const h1 = harness({ threads: [traderThread({ id: 'thr_s', side: 'short', origin: undefined, source: 'agent' })] });
    try {
      expect((await h1.follow.ingest(sig())).signal.decision?.codes).toContain('trader_reverse_exposure');
    } finally {
      h1.close();
    }
    const h2 = harness({ threads: [traderThread({ status: 'in_position', opened_at: NOW })] });
    try {
      expect((await h2.follow.ingest(sig())).signal.decision?.codes).toContain('trader_duplicate_open');
    } finally {
      h2.close();
    }
  });

  it('人工 apply 被闸拒 → 落 apply_failed(人可以再试),原因留在行上', async () => {
    const h = harness({ follow: settings({}, { mode: 'gated' }), openError: '名义 900 USDT 超过上限' });
    try {
      await h.follow.ingest(sig());
      const r = await h.follow.applyManually('sig_1');
      expect(r.error).toContain('超过上限');
      expect(r.signal!.status).toBe('apply_failed');
      expect(r.signal!.decision?.note).toContain('人工 apply 失败');
      // 几何与 agent 结论不能被清掉(R4-07)
      expect(r.signal!.decision?.plan).toBeTruthy();
      expect(h.calls).toContain('manual_open');
      // R5-02:apply_failed 是**明确失败**,可以再试 —— 领取得到
      const retry = h.store.traderSignals.claimForApply('sig_1', 'owner-x', 'claim-x', NOW);
      expect(retry?.status).toBe('applying');
    } finally {
      h.close();
    }
  });

  it('R4-03:apply 原子领取 —— 并发第二次点击拿不到(409),skip 也不许动非 review_only 的行', async () => {
    const h = harness({ follow: settings({}, { mode: 'gated' }) });
    try {
      await h.follow.ingest(sig());
      expect(h.store.traderSignals.bySignalId('sig_1')!.status).toBe('review_only');
      // 手工先领走(带领取身份)
      const claimed = h.store.traderSignals.claimForApply('sig_1', 'owner-a', 'claim-a', NOW);
      expect(claimed!.status).toBe('applying');
      expect(claimed!.claim_id).toBe('claim-a');
      expect(claimed!.claim_owner).toBe('owner-a');
      // 再点一次:领取不到
      const second = await h.follow.applyManually('sig_1');
      expect(second.status).toBe(409);
      expect(second.error).toContain('review_only');
      // applying 的行不许被 skip 抹掉
      const skipped = h.follow.skipManually('sig_1');
      expect(skipped.status).toBe(409);
      expect(h.store.traderSignals.bySignalId('sig_1')!.status).toBe('applying');
    } finally {
      h.close();
    }
  });

  it('管理动作(首发零自动写):close/cancel 也只进人工队列,五类动作零执行器调用', async () => {
    const t = traderThread({ status: 'in_position', opened_at: NOW, filled_avg_price: '60000' });
    const h = harness({ threads: [t] });
    try {
      const closed = await h.follow.ingest(sig({ signal_id: 's_close', id: 'tsig_s_close', action: 'close' }));
      expect(closed.signal.status).toBe('review_only');
      expect(closed.signal.decision?.note).toContain('首发不自动动仓');
      expect(closed.signal.thread_id).toBe(t.id); // 关联记下来,人点「平」时用它
      const canceled = await h.follow.ingest(sig({ signal_id: 's_cancel', id: 'tsig_s_cancel', action: 'cancel' }));
      expect(canceled.signal.status).toBe('review_only');
      expect(h.calls).not.toContain(`close:${t.id}`);
      expect(h.calls).not.toContain(`cancel:${t.id}`);
      // 三类仓位管理:全部 review_only,一个执行器都不调
      for (const [id, patch] of [
        ['s_red', { action: 'reduce' as const, raw_text: '减 30%' }],
        ['s_tight', { action: 'stop_loss_update' as const, stop: '59500' }],
        ['s_loose', { action: 'stop_loss_update' as const, stop: '58000' }],
        ['s_tp', { action: 'take_profit_update' as const, tps: [{ price: '63000', pct: null }] }],
      ] as const) {
        const r = await h.follow.ingest(sig({ signal_id: id, id: `tsig_${id}`, ...patch }));
        expect(r.signal.status).toBe('review_only');
        expect(r.signal.decision?.note).toContain('不自动执行仓位管理');
      }
      expect(h.calls.filter((c) => c === 'pending_review')).toHaveLength(6);
      // 六类动作(close/cancel/reduce/移损×2/改止盈)一个执行器都没碰
      expect(h.calls.some((c) => c.startsWith('reduce:') || c.startsWith('stop:') || c.startsWith('tp:') || c.startsWith('close:') || c.startsWith('cancel:'))).toBe(false);
      const orphan = await h.follow.ingest(sig({ signal_id: 's_orphan', id: 'tsig_s_orphan', action: 'close', symbol: 'ETHUSDT' }));
      expect(orphan.signal.status).toBe('mgmt_orphan');
    } finally {
      h.close();
    }
  });

  it('管理动作不写判断账本(只有 open/add 写)', async () => {
    const h = harness({ threads: [traderThread({ status: 'in_position', opened_at: NOW })] });
    try {
      await h.follow.ingest(sig({ action: 'close' }));
      expect(h.calls).not.toContain('ledger');
    } finally {
      h.close();
    }
  });

  it('超龄信号自动只进 evidence,没有可执行几何 → 人工也 apply 不了', async () => {
    const h = harness({ follow: settings({ freshness_s: 1 }) });
    try {
      const stale = sig({ published_at: NOW - 600_000 });
      const auto = await h.follow.ingest(stale);
      expect(auto.signal.status).toBe('evidence');
      // 首发:apply 只接受 review_only 且行上有 plan;evidence 行两条都不满足
      const r = await h.follow.applyManually(stale.signal_id, { force_stale: true });
      expect(r.status).toBe(409);
      expect(r.error).toContain('review_only');
      expect(h.calls).not.toContain('manual_open');
    } finally {
      h.close();
    }
  });

  it('无止损的信号人工也开不了(自动判定就落 evidence,没有可执行几何)', async () => {
    const h = harness();
    try {
      const r = await h.follow.ingest(sig({ stop: null }));
      expect(r.signal.status).toBe('evidence');
      expect(r.signal.decision?.plan ?? null).toBeNull();
      expect((await h.follow.applyManually('sig_1')).status).toBe(409);
    } finally {
      h.close();
    }
  });

  it('ingestMany 按顺序处理(同一线程的 open 必须早于它的 close)', async () => {
    const h = harness();
    try {
      const open = sig({ signal_id: 'o1', id: 'tsig_o1' });
      const close = sig({ signal_id: 'c1', id: 'tsig_c1', action: 'close' });
      const out = await h.follow.ingestMany([open, close]);
      // 首发两条都是 review_only(open 等人点跟,close 等人点平)
      expect(out.map((o) => o.signal.status)).toEqual(['applied', 'review_only']);
      expect(h.calls.filter((c) => c === 'open')).toHaveLength(1);
      expect(h.calls.some((c) => c.startsWith('close:'))).toBe(false);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------- 存储

describe('TraderSignalStore', () => {
  it('signal_id 唯一 + 幂等 capture + 每人统计 + 每日开仓计数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-follow-store-'));
    const state = openStateDb(join(dir, 'state.sqlite'));
    try {
      const store = new DemoStore(state);
      const a = sig({ status: 'applied' });
      expect(store.traderSignals.capture(a).created).toBe(true);
      expect(store.traderSignals.capture({ ...a, status: 'skipped' }).created).toBe(false);
      expect(store.traderSignals.get(a.id)!.status).toBe('applied');
      expect(store.traderSignals.find('sig_1')!.id).toBe(a.id);
      store.traderSignals.capture(sig({ signal_id: 'sig_2', id: 'tsig_2', status: 'evidence' }));
      expect(store.traderSignals.list({ status: 'evidence' }).map((s) => s.signal_id)).toEqual(['sig_2']);
      expect(store.traderSignals.perTrader()[0]).toMatchObject({ trader: 'TraderB', signals: 2, applied: 1, evidence: 1 });
      // 触发数 = 进过判定链路的(mode_applied 有值且不是 new);这两条夹具都没有 mode_applied
      expect(store.traderSignals.openingsSince('TraderB', NOW - 3_600_000)).toBe(0);
      store.traderSignals.save({ ...a, status: 'review_only', mode_applied: 'gated' });
      expect(store.traderSignals.openingsSince('TraderB', NOW - 3_600_000)).toBe(1);
      expect(store.traderSignals.lastOpening('TraderB', 'BTCUSDT')!.trader).toBe('TraderB');
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

 describe('book 现货止损可选', () => {
  it.each(['spot', 'perpetual'])('%s null stop 只对现货 book 放行', market_type => {
    const result = resolveMode({ signal: sig({ market_type, stop: null }), follow: settings(), stats: null, now: NOW });
    if (market_type === 'spot') { expect(result.mode).toBe('book'); expect(result.codes).not.toContain('trader_signal_no_stop'); }
    else { expect(result.mode).toBe('evidence'); expect(result.codes).toContain('trader_signal_no_stop'); }
  });
});
