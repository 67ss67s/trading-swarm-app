// 事件区(events.ts + events-calendar.ts,设计 §5)。全部零模型、零网络:分类器是纯函数,
// impact 用构造的 K 线算,生命周期用假时钟推。

import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import {
  aggregateStats,
  applyBrief,
  canTransition,
  classifyEvent,
  classifyEventWithFallback,
  computeImpact,
  dueBrief,
  dueStatus,
  eventBlackout,
  eventBlackoutGate,
  EventStore,
  eventsFromCalendar,
  eventsFromNews,
  eventsFromTriggers,
  eventTouchesSymbol,
  isWithinWindow,
  makeEvent,
  MAX_BRIEFS_PER_EVENT,
  nextStatus,
  windowMsFor,
  type MarketEvent,
} from '../../src/demo/events.js';
import { CALENDAR_2026, CALENDAR_LAST_VERIFIED_AT, calendarEntriesWithin, loadEventFeedSources } from '../../src/demo/events-calendar.js';
import type { InformationEvent, Kline, TriggerHit } from '../../src/demo/types.js';

const H = 3_600_000;

// ---------------------------------------------------------------- 分类器

describe('classifyEvent:关键词表(零模型)', () => {
  const cases: { title: string; subkind: string; assets?: string[] }[] = [
    { title: 'Fed holds rates steady at FOMC meeting', subkind: 'fomc' },
    { title: '美联储议息会议决定维持利率不变', subkind: 'fomc' },
    { title: 'US CPI comes in hotter than expected', subkind: 'cpi' },
    { title: '美国非农就业数据大超预期', subkind: 'nfp' },
    { title: 'Nonfarm payrolls miss forecasts', subkind: 'nfp' },
    { title: 'ARB token unlock worth $120M hits next week', subkind: 'unlock', assets: ['ARB'] },
    // 资产映射复用 info.ts 的 ASSET_WORDS,它只认票代码/常见全称——'Arbitrum' 不在表里,分类仍对但 assets 为空。
    { title: 'Arbitrum token unlock worth $120M hits next week', subkind: 'unlock', assets: [] },
    { title: 'Binance will list SUI perpetual contracts', subkind: 'listing', assets: ['SUI'] },
    { title: 'Exchange announces delisting of four trading pairs', subkind: 'delisting' },
    { title: 'DeFi protocol exploited for $40M, funds drained', subkind: 'hack' },
    { title: 'Spot Bitcoin ETF sees record net inflow', subkind: 'etf_flow', assets: ['BTC'] },
    { title: 'SEC files lawsuit against exchange operator', subkind: 'regulation' },
    { title: 'Ethereum mainnet upgrade goes live', subkind: 'upgrade', assets: ['ETH'] },
    { title: '某协议遭黑客攻击损失惨重', subkind: 'hack' },
    { title: 'A quiet Tuesday in the market, traders wait', subkind: 'unclassified' },
  ];
  for (const c of cases) {
    it(`「${c.title.slice(0, 34)}」→ ${c.subkind}`, () => {
      const r = classifyEvent({ title: c.title, source: 'coindesk', kind: 'news' });
      expect(r.subkind).toBe(c.subkind);
      expect(r.unclassified).toBe(c.subkind === 'unclassified');
      if (c.assets) for (const a of c.assets) expect(r.assets).toContain(a);
      expect(r.window_ms).toBe(windowMsFor(c.subkind));
    });
  }

  it('传闻词把可信度降到 rumor,官方源升到 confirmed', () => {
    expect(classifyEvent({ title: 'Rumor: exchange to delist token', source: 'coindesk', kind: 'news' }).confidence).toBe('rumor');
    expect(classifyEvent({ title: 'FOMC statement released', source: 'fed', kind: 'news' }).confidence).toBe('confirmed');
    expect(classifyEvent({ title: 'SEC sues firm', source: 'coindesk', kind: 'news' }).confidence).toBe('reported');
  });

  it('便宜大脑兜底默认不接;接了也只在 unclassified 时调、且只能选表里已有的 subkind', async () => {
    const inp = { title: 'A quiet Tuesday in the market', source: 'coindesk', kind: 'news' as const };
    expect((await classifyEventWithFallback(inp)).subkind).toBe('unclassified');
    let calls = 0;
    const spy = async (): Promise<string> => { calls++; return 'cpi'; };
    expect((await classifyEventWithFallback(inp, spy)).subkind).toBe('cpi');
    expect(calls).toBe(1);
    // 已经分出来的不再调模型
    await classifyEventWithFallback({ title: 'US CPI released', source: 'x', kind: 'news' }, spy);
    expect(calls).toBe(1);
    // 模型瞎编的类别不采纳
    expect((await classifyEventWithFallback(inp, async () => 'banana')).subkind).toBe('unclassified');
    // 模型抛错也不能让分类失败
    expect((await classifyEventWithFallback(inp, async () => { throw new Error('boom'); })).subkind).toBe('unclassified');
  });
});

// ---------------------------------------------------------------- 日历

describe('日历静态表', () => {
  it('每条 expected_at 都是 UTC 毫秒,且落在 2026 年核对日之后', () => {
    expect(CALENDAR_2026.length).toBeGreaterThan(0);
    for (const e of CALENDAR_2026) {
      expect(Number.isInteger(e.expected_at)).toBe(true);
      expect(e.expected_at).toBeGreaterThan(CALENDAR_LAST_VERIFIED_AT);
      expect(new Date(e.expected_at).getUTCFullYear()).toBe(2026);
      expect(e.source_ref).toMatch(/^https:\/\//);
    }
  });

  it('FOMC 14:00 美东 / CPI-NFP 08:30 美东,换算成 UTC 后夏令时前后差一小时', () => {
    const iso = (t: number): string => new Date(t).toISOString();
    const fomcOct = CALENDAR_2026.find((e) => e.subkind === 'fomc' && iso(e.expected_at).startsWith('2026-10'))!;
    const fomcDec = CALENDAR_2026.find((e) => e.subkind === 'fomc' && iso(e.expected_at).startsWith('2026-12'))!;
    expect(iso(fomcOct.expected_at)).toBe('2026-10-28T18:00:00.000Z'); // EDT = UTC−4
    expect(iso(fomcDec.expected_at)).toBe('2026-12-09T19:00:00.000Z'); // EST = UTC−5
    const cpiOct = CALENDAR_2026.find((e) => e.subkind === 'cpi' && iso(e.expected_at).startsWith('2026-10'))!;
    const cpiNov = CALENDAR_2026.find((e) => e.subkind === 'cpi' && iso(e.expected_at).startsWith('2026-11'))!;
    expect(iso(cpiOct.expected_at)).toBe('2026-10-14T12:30:00.000Z');
    expect(iso(cpiNov.expected_at)).toBe('2026-11-10T13:30:00.000Z');
    const nfp = CALENDAR_2026.filter((e) => e.subkind === 'nfp');
    expect(nfp.length).toBeGreaterThanOrEqual(3);
    for (const e of nfp) expect(iso(e.expected_at)).toMatch(/T1[23]:30:00\.000Z$/);
  });

  it('calendarEntriesWithin 只给未来 horizon 内的,且按时间升序', () => {
    const now = Date.parse('2026-09-12T00:00:00Z');
    const within = calendarEntriesWithin(now, 30 * 86_400_000);
    expect(within.length).toBeGreaterThan(0);
    expect(within.every((e) => e.expected_at >= now && e.expected_at <= now + 30 * 86_400_000)).toBe(true);
    expect([...within].sort((a, b) => a.expected_at - b.expected_at)).toEqual(within);
    expect(calendarEntriesWithin(Date.parse('2027-01-01T00:00:00Z'))).toEqual([]);
  });

  it('订阅源默认空,不硬编任何第三方;坏 JSON 当没配', () => {
    expect(loadEventFeedSources(undefined)).toEqual([]);
    expect(loadEventFeedSources('')).toEqual([]);
    expect(loadEventFeedSources('{not json')).toEqual([]);
    const ok = loadEventFeedSources('[{"name":"x","kind":"exchange","url":"https://e.example/rss","format":"rss","subkind":"listing"}]');
    expect(ok).toEqual([{ name: 'x', kind: 'exchange', url: 'https://e.example/rss', format: 'rss', subkind: 'listing' }]);
    // 非 http(s) 的源直接丢
    expect(loadEventFeedSources('[{"name":"x","url":"file:///etc/passwd","format":"rss"}]')).toEqual([]);
  });

  it('eventsFromCalendar 出 scheduled 事件:expected_at 用 UTC,assets 为空 = 宏观', () => {
    const now = Date.parse('2026-09-12T00:00:00Z');
    const evs = eventsFromCalendar(now);
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs) {
      expect(e.kind).toBe('scheduled');
      expect(e.assets).toEqual([]);
      expect(e.expected_at).not.toBeNull();
      expect(e.confidence).toBe('reported'); // 静态兜底不能冒充多源已核验
      expect(e.status).toBe('captured');
    }
  });
});

// ---------------------------------------------------------------- 去重

function db() {
  const state = openStateDb(':memory:');
  return { state, store: new EventStore(state.db) };
}

function news(p: Partial<InformationEvent> & { title: string }): InformationEvent {
  return { id: 'info-1', kind: 'news', source: 'coindesk', source_ref: 'https://x/1', occurred_at: 1_000, observed_at: 1_000, ingested_at: 1_000, dedupe_key: `news:${p.title}`, title: p.title, digest: '', assets: [], ...p };
}

describe('去重', () => {
  it('同一条新闻抓两次只留一条,且不会把已经有简报的旧行打回 captured', () => {
    const { state, store } = db();
    const now = 10 * H;
    const [a] = eventsFromNews([news({ title: 'US CPI comes in hot' })], now);
    expect(store.capture(a!).created).toBe(true);
    const withBrief = applyBrief(store.get(a!.id)!, { at: now, text: '简报', refs: [], lead_minutes: 60 });
    store.save(withBrief);
    const again = store.capture(eventsFromNews([news({ title: 'US CPI comes in hot' })], now)[0]!);
    expect(again.created).toBe(false);
    expect(again.event.status).toBe('briefed');
    expect(store.list({}).length).toBe(1);
    state.close();
  });

  it('派生事件:同资产同 subkind 在一个窗口内只一条,跨窗口才再开一条', () => {
    const { state, store } = db();
    const hits: TriggerHit[] = [{ kind: 'funding', detail: '资金费率 +0.08%', score: 0.9 }];
    const t0 = 100 * H;
    expect(store.captureMany(eventsFromTriggers('BTCUSDT', hits, t0)).created).toHaveLength(1);
    // 同窗口内再触发(哪怕桶边界不同),重叠检查也挡掉
    expect(store.captureMany(eventsFromTriggers('BTCUSDT', hits, t0 + 60_000)).created).toHaveLength(0);
    expect(store.captureMany(eventsFromTriggers('BTCUSDT', hits, t0 + 3 * H)).created).toHaveLength(0);
    // 别的币不算重复
    expect(store.captureMany(eventsFromTriggers('ETHUSDT', hits, t0 + 60_000)).created).toHaveLength(1);
    // 窗口过完再触发,是新的一条(funding_extreme 窗口 8h)
    expect(store.captureMany(eventsFromTriggers('BTCUSDT', hits, t0 + 9 * H)).created).toHaveLength(1);
    state.close();
  });

  it('只有 funding / vol_spike 会升格成派生事件,别的触发器不会', () => {
    const hits: TriggerHit[] = [
      { kind: 'breakout', detail: 'x', score: 1 },
      { kind: 'vol_spike', detail: '量比 3.2', score: 0.8 },
      { kind: 'retest', detail: 'y', score: 0.5 },
    ];
    const out = eventsFromTriggers('SOLUSDT', hits, 5 * H);
    expect(out.map((e) => e.subkind)).toEqual(['vol_spike']);
    expect(out[0]!.assets).toEqual(['SOL']);
    expect(out[0]!.kind).toBe('derived');
  });
});

// ---------------------------------------------------------------- 生命周期

function scheduled(expectedAt: number, windowMs = 4 * H): MarketEvent {
  return makeEvent({ kind: 'scheduled', subkind: 'fomc', title: 'FOMC', assets: [], expected_at: expectedAt, window_ms: windowMs, captured_at: expectedAt - 48 * H, source: 'calendar', confidence: 'confirmed', dedupe_key: `cal:fomc:${expectedAt}` });
}

describe('生命周期状态机', () => {
  const T = 1_000 * H;

  it('captured → briefed → live → resolved → retro_done,只往前走', () => {
    expect(canTransition('captured', 'briefed')).toBe(true);
    expect(canTransition('briefed', 'live')).toBe(true);
    expect(canTransition('live', 'resolved')).toBe(true);
    expect(canTransition('resolved', 'retro_done')).toBe(true);
    // 往回走 / 跳过 resolved / 终态再动,都不行
    expect(canTransition('live', 'briefed')).toBe(false);
    expect(canTransition('live', 'retro_done')).toBe(false);
    expect(canTransition('retro_done', 'resolved')).toBe(false);
    expect(canTransition('dismissed', 'live')).toBe(false);
  });

  it('dueStatus 按时间算应该在哪一档', () => {
    const e = scheduled(T);
    expect(dueStatus(e, T - 2 * H)).toBe('captured');
    expect(dueStatus({ ...e, brief_count: 1 }, T - 2 * H)).toBe('briefed');
    expect(dueStatus(e, T)).toBe('live');
    expect(dueStatus(e, T + 2 * H)).toBe('live');
    expect(dueStatus(e, T + 5 * H)).toBe('resolved');
    // 终态不被时间推动
    expect(dueStatus({ ...e, status: 'retro_done' }, T + 99 * H)).toBe('retro_done');
    expect(dueStatus({ ...e, status: 'dismissed' }, T)).toBe('dismissed');
  });

  it('nextStatus 只在需要迁移且合法时返回目标', () => {
    const e = scheduled(T);
    expect(nextStatus(e, T - 2 * H)).toBeNull();
    expect(nextStatus(e, T)).toBe('live');
    expect(nextStatus({ ...e, status: 'live' }, T + 5 * H)).toBe('resolved');
    expect(nextStatus({ ...e, status: 'resolved' }, T + 5 * H)).toBeNull();
  });

  it('EventStore.advance 把迁移落库,resolved 记 resolved_at', () => {
    const { state, store } = db();
    const e = scheduled(T);
    store.save(e);
    expect(store.advance(store.get(e.id)!, T - 2 * H)).toBeNull();
    expect(store.advance(store.get(e.id)!, T + H)!.status).toBe('live');
    const resolved = store.advance(store.get(e.id)!, T + 5 * H)!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).toBe(T + 5 * H);
    state.close();
  });

  it('简报:T−60 / T−10 各一次,最多两次,窗口开始后不再出', () => {
    const e = scheduled(T);
    expect(dueBrief(e, T - 120 * 60_000)).toBeNull();      // 还早
    expect(dueBrief(e, T - 59 * 60_000)).toEqual({ lead_minutes: 60 });
    const one = applyBrief(e, { at: T - 59 * 60_000, text: '第一份', refs: [], lead_minutes: 60 });
    expect(one.status).toBe('briefed');
    expect(one.brief_count).toBe(1);
    expect(dueBrief(one, T - 40 * 60_000)).toBeNull();     // 第二次要等 T−10
    expect(dueBrief(one, T - 9 * 60_000)).toEqual({ lead_minutes: 10 });
    const two = applyBrief(one, { at: T - 9 * 60_000, text: '第二份', refs: [], lead_minutes: 10 });
    expect(two.brief_count).toBe(MAX_BRIEFS_PER_EVENT);
    expect(two.brief!.text).toBe('第二份');
    expect(two.briefs).toHaveLength(2);
    expect(dueBrief(two, T - 5 * 60_000)).toBeNull();      // 上限到了
    expect(dueBrief({ ...e, status: 'live' }, T + H)).toBeNull();
    // 非 scheduled(没有 expected_at)不做定时简报
    expect(dueBrief(makeEvent({ kind: 'news', subkind: 'hack', title: 'x', captured_at: T, source: 'a', dedupe_key: 'k' }), T)).toBeNull();
  });

  it('dismiss 是终态、幂等,dismissed 的事件不再进闸也不进统计', () => {
    const { state, store } = db();
    const e = scheduled(T);
    store.save(e);
    expect(store.dismiss(e.id)!.status).toBe('dismissed');
    expect(store.dismiss(e.id)!.status).toBe('dismissed');
    expect(store.advance(store.get(e.id)!, T + H)).toBeNull();
    expect(store.liveFor('BTCUSDT', T + H)).toEqual([]);
    expect(eventBlackout([store.get(e.id)!], 'BTCUSDT', T - 30 * 60_000, 60).blocked).toBe(false);
    state.close();
  });

  it('窗口与资产匹配:assets 为空 = 宏观(每个币都算)', () => {
    const macro = scheduled(T);
    expect(eventTouchesSymbol(macro, 'BTCUSDT')).toBe(true);
    const arb = makeEvent({ kind: 'news', subkind: 'unlock', title: 'ARB unlock', assets: ['ARB'], captured_at: T, window_ms: 24 * H, source: 'x', dedupe_key: 'k1' });
    expect(eventTouchesSymbol(arb, 'ARBUSDT')).toBe(true);
    expect(eventTouchesSymbol(arb, 'BTCUSDT')).toBe(false);
    expect(isWithinWindow(macro, T + 2 * H)).toBe(true);
    expect(isWithinWindow(macro, T - 1)).toBe(false);
    expect(isWithinWindow(macro, T + 4 * H + 1)).toBe(false);
  });
});

// ---------------------------------------------------------------- impact 回填

/** 构造 1h K 线:从 `from` 起 `n` 根,收盘价由 priceAt 决定,高低按 ±amp%。 */
function bars(from: number, n: number, priceAt: (i: number) => number, amp = 0.5): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const close = priceAt(i);
    const open = i === 0 ? close : priceAt(i - 1);
    out.push({
      open_time: from + i * H,
      open: open.toFixed(2),
      high: (Math.max(open, close) * (1 + amp / 100)).toFixed(2),
      low: (Math.min(open, close) * (1 - amp / 100)).toFixed(2),
      close: close.toFixed(2),
      volume: '100',
      close_time: from + (i + 1) * H - 1,
    });
  }
  return out;
}

describe('impact 回填(纯代码,从 K 线算)', () => {
  const at = 100 * H;
  // 事件前 24 根都是 100;事件后 1h +2%、4h +5%、24h +10%
  const series = (i: number): number => {
    const hoursAfter = i - 24;
    if (hoursAfter <= 0) return 100;
    if (hoursAfter <= 1) return 102;
    if (hoursAfter <= 4) return 105;
    return 110;
  };

  it('1h / 4h / 24h 涨跌幅按「事件前最后一根收盘价」为基准', () => {
    const k = bars(at - 24 * H, 49, series);
    const impact = computeImpact(k, at, 'BTCUSDT', 999)!;
    expect(impact.base_price).toBe(100);
    expect(impact.move_1h_pct).toBe(2);
    expect(impact.move_4h_pct).toBe(5);
    expect(impact.move_24h_pct).toBe(10);
    expect(impact.symbol).toBe('BTCUSDT');
    expect(impact.computed_at).toBe(999);
  });

  it('数据没到那么远的那一档就是 null,不编', () => {
    const k = bars(at - 24 * H, 27, series); // 事件后只有 3 根
    const impact = computeImpact(k, at, 'BTCUSDT')!;
    expect(impact.move_1h_pct).toBe(2);
    expect(impact.move_4h_pct).toBeNull();
    expect(impact.move_24h_pct).toBeNull();
  });

  it('事件时刻之前一根 K 线都没有 → 整条 impact 为 null', () => {
    expect(computeImpact(bars(at + H, 10, () => 100), at, 'BTCUSDT')).toBeNull();
  });

  it('realized_vol_ratio:事后波动放大 → > 1,平静 → ≈ 1', () => {
    const calm = bars(at - 24 * H, 49, () => 100, 0.2);
    expect(computeImpact(calm, at, 'BTCUSDT')!.realized_vol_ratio).toBeCloseTo(1, 1);
    const before = bars(at - 24 * H, 24, () => 100, 0.2);
    const after = bars(at, 25, (i) => 100 + i, 2);
    const ratio = computeImpact([...before, ...after], at, 'BTCUSDT')!.realized_vol_ratio!;
    expect(ratio).toBeGreaterThan(2);
  });
});

describe('eventStats:同 subkind 历史聚合', () => {
  const mk = (subkind: string, move: number | null, status: MarketEvent['status'] = 'retro_done'): MarketEvent => ({
    ...makeEvent({ kind: 'news', subkind, title: 't', captured_at: 1, source: 's', dedupe_key: `${subkind}-${move}-${Math.random()}` }),
    status,
    impact: move === null ? null : { move_1h_pct: move / 2, move_4h_pct: move, move_24h_pct: move, realized_vol_ratio: 1.5, symbol: 'BTCUSDT', base_price: 100, computed_at: 1 },
  });

  it('same release m/m and y/y share one impact sample while retaining metric surprise pairs', () => {
    const base = { ...mk('cpi', 2), kind: 'scheduled' as const, source: 'calendar', expected_at: 1000000 };
    const calendar = { subkind: 'cpi' as const, expected_at: 1000000, title: 'CPI', source_ref: 'https://bls.gov/', consensus: '0.2%', previous: '0.1%', importance: 'high' as const, calendar_status: 'confirmed' as const, observations: [], verified_at: 1, fallback: false };
    const a = { ...base, calendar: { ...calendar, metric: 'mom_pct_sa' }, actual_metric: 'mom_pct_sa', surprise: '0.1' };
    const b = { ...base, id: 'event-yoy', calendar: { ...calendar, metric: 'yoy_pct' }, actual_metric: 'yoy_pct', surprise: '0.2' };
    const stats = aggregateStats('cpi', [a, b]);
    expect(stats.samples).toBe(1);
    expect(stats.surprise_move_4h).toHaveLength(2);
  });

  it('样本数 / 平均 |4h| / 方向一致率', () => {
    const s = aggregateStats('cpi', [mk('cpi', 2), mk('cpi', 3), mk('cpi', -1), mk('nfp', 9)]);
    expect(s.samples).toBe(3);
    expect(s.avg_abs_move_4h_pct).toBe(2);
    expect(s.avg_move_4h_pct).toBeCloseTo(1.33, 2);
    expect(s.direction_agreement).toBeCloseTo(0.67, 2);
    expect(s.dominant_direction).toBe('up');
  });

  it('没有 impact 的不计数;完全对半没有主导方向;dismissed 的排除', () => {
    expect(aggregateStats('cpi', [mk('cpi', null), mk('cpi', null)]).samples).toBe(0);
    expect(aggregateStats('cpi', []).direction_agreement).toBeNull();
    const even = aggregateStats('cpi', [mk('cpi', 1), mk('cpi', -1)]);
    expect(even.direction_agreement).toBe(0.5);
    expect(even.dominant_direction).toBeNull();
    expect(aggregateStats('cpi', [mk('cpi', 1), mk('cpi', 2, 'dismissed')]).samples).toBe(1);
  });

  it('EventStore.stats 只数 resolved / retro_done 的行', () => {
    const { state, store } = db();
    store.save(mk('cpi', 4));
    store.save({ ...mk('cpi', 8), status: 'live' });
    expect(store.stats('cpi').samples).toBe(1);
    expect(store.stats('cpi').avg_abs_move_4h_pct).toBe(4);
    expect(store.stats('fomc').samples).toBe(0);
    state.close();
  });
});

// ---------------------------------------------------------------- 闸

describe('event_blackout 闸', () => {
  const T = 500 * H;
  const ev = scheduled(T); // FOMC,窗口 4h,宏观

  it('0 = 关闭,永远放行', () => {
    expect(eventBlackout([ev], 'BTCUSDT', T - 60_000, 0).blocked).toBe(false);
    expect(eventBlackoutGate([ev], 'BTCUSDT', T - 60_000, 0, true).passed).toBe(true);
  });

  it('>0 时:事件前 N 分钟到窗口结束之间拒开新仓', () => {
    expect(eventBlackout([ev], 'BTCUSDT', T - 61 * 60_000, 60).blocked).toBe(false); // 还没进封锁区
    expect(eventBlackout([ev], 'BTCUSDT', T - 30 * 60_000, 60).blocked).toBe(true);
    expect(eventBlackout([ev], 'BTCUSDT', T + 2 * H, 60).blocked).toBe(true);         // 窗口内也拦
    expect(eventBlackout([ev], 'BTCUSDT', T + 4 * H + 60_000, 60).blocked).toBe(false); // 窗口过了
  });

  it('只拦开仓:平仓 / 减仓 / 撤单永远 passed,理由写清是「只拦开仓」', () => {
    const blocked = eventBlackoutGate([ev], 'BTCUSDT', T - 30 * 60_000, 60, true);
    expect(blocked.passed).toBe(false);
    expect(blocked.name).toBe('事件封锁');
    expect(blocked.reason).toMatch(/不开新仓/);
    const closing = eventBlackoutGate([ev], 'BTCUSDT', T - 30 * 60_000, 60, false);
    expect(closing.passed).toBe(true);
    expect(closing.reason).toMatch(/只拦开仓/);
  });

  it('按资产分:点名某个币的事件不拦别的币,宏观事件拦所有币', () => {
    const arb = makeEvent({ kind: 'news', subkind: 'unlock', title: 'ARB unlock', assets: ['ARB'], expected_at: T, window_ms: 24 * H, captured_at: T - H, source: 'x', dedupe_key: 'u1' });
    expect(eventBlackout([arb], 'ARBUSDT', T - 30 * 60_000, 60).blocked).toBe(true);
    expect(eventBlackout([arb], 'BTCUSDT', T - 30 * 60_000, 60).blocked).toBe(false);
    expect(eventBlackout([ev], 'ARBUSDT', T - 30 * 60_000, 60).blocked).toBe(true);
  });

  it('已复盘完(retro_done)的历史事件不再封锁', () => {
    expect(eventBlackout([{ ...ev, status: 'retro_done' }], 'BTCUSDT', T - 30 * 60_000, 60).blocked).toBe(false);
  });
});

// ---------------------------------------------------------------- 查询

describe('EventStore 查询', () => {
  it('list 按 status / asset / since 筛;宏观事件在按资产筛时保留', () => {
    const { state, store } = db();
    const T = 700 * H;
    const macro = scheduled(T);
    const arb = makeEvent({ kind: 'news', subkind: 'unlock', title: 'ARB unlock', assets: ['ARB'], captured_at: T, window_ms: H, source: 'x', dedupe_key: 'u2' });
    store.save(macro);
    store.save({ ...arb, status: 'live' });
    expect(store.list({}).length).toBe(2);
    expect(store.list({ status: 'live' }).map((e) => e.id)).toEqual([arb.id]);
    expect(store.list({ asset: 'ARBUSDT' }).length).toBe(2); // 宏观 + ARB
    expect(store.list({ asset: 'ETHUSDT' }).map((e) => e.id)).toEqual([macro.id]);
    expect(store.list({ subkind: 'fomc' }).map((e) => e.id)).toEqual([macro.id]);
    expect(store.list({ since: T + 99 * H })).toEqual([]);
    state.close();
  });

  it('liveFor 只给窗口内且相关的;needingResolve 只给窗口过完的', () => {
    const { state, store } = db();
    const T = 800 * H;
    store.save(scheduled(T));
    expect(store.liveFor('BTCUSDT', T - H)).toEqual([]);
    expect(store.liveFor('BTCUSDT', T + H)).toHaveLength(1);
    expect(store.needingResolve(T + H)).toEqual([]);
    expect(store.needingResolve(T + 5 * H)).toHaveLength(1);
    state.close();
  });

  it('markUsed 记 episode,且同一个 episode 不重复记', () => {
    const { state, store } = db();
    const e = scheduled(900 * H);
    store.save(e);
    store.markUsed(e.id, 'ep-1');
    store.markUsed(e.id, 'ep-1');
    store.markUsed(e.id, 'ep-2');
    expect(store.get(e.id)!.used_by).toEqual(['ep-1', 'ep-2']);
    state.close();
  });

  it('needingBrief 只给还没到窗口、且到点了的 scheduled 事件', () => {
    const { state, store } = db();
    const T = 1_100 * H;
    store.save(scheduled(T));
    expect(store.needingBrief(T - 120 * 60_000)).toEqual([]);
    expect(store.needingBrief(T - 30 * 60_000)).toHaveLength(1);
    expect(store.needingBrief(T + H)).toEqual([]);
    state.close();
  });
});
