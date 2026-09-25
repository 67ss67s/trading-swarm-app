// 订阅频道「雷达榜单」radar_feed:新一轮检测、判重、多档依次推、welcome 未运行档、流动性门不合格原因、红线词。全部注入依赖,零网络。
import { describe, expect, it } from 'vitest';
import { radarFeedChannel, RADAR_TIER_HORIZON, type RadarCandidateLike, type RadarDeps, type RadarFitRow, type RadarScreenLike } from '../../src/demo/asp-agent/services/radar-feed.js';
import type { ChannelDeps } from '../../src/demo/asp-agent/services/types.js';
import { BANNED_WORDS } from '../../src/demo/asp-agent/publisher.js';
import type { Horizon, HorizonFit, RadarTier } from '../../src/demo/recommend.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 25, 14, 0);

const ok = (direction: HorizonFit['direction'], families: HorizonFit['families']): HorizonFit => ({ eligible: true, reason: null, direction, families, evidence: ['24h 永续成交额 900.0M', '日线多头'] });
const bad = (reason: string, evidence: string[]): HorizonFit => ({ eligible: false, reason, direction: null, families: [], evidence });

function harness(init: { screens?: Partial<Record<RadarTier, RadarScreenLike>>; cands?: Record<string, RadarCandidateLike[]>; fits?: Record<string, HorizonFit>; fitThrows?: boolean; fresh?: boolean } = {}) {
  const screens: Partial<Record<RadarTier, RadarScreenLike>> = { ...init.screens };
  const cands: Record<string, RadarCandidateLike[]> = { ...init.cands };
  const fits: Record<string, HorizonFit> = { ...init.fits };
  const kv = new Map<string, string>(init.fresh ? [] : [['radar_feed:primed', '1']]);
  const logs: string[] = [];
  const fitCalls: { symbols: string[]; horizon: Horizon }[] = [];
  let now = NOW;
  const deps: ChannelDeps & RadarDeps = {
    now: () => now,
    state: { get: (k) => kv.get(k) ?? null, set: (k, v) => { kv.set(k, v); } },
    log: (level, msg) => { logs.push(`${level}:${msg}`); },
    latest: (tier) => screens[tier] ?? null,
    candidates: (id, n) => (cands[id] ?? []).slice(0, n),
    fit: async (symbols, horizon): Promise<RadarFitRow[]> => {
      fitCalls.push({ symbols, horizon });
      if (init.fitThrows) throw new Error('universe offline');
      return symbols.map((s) => ({ symbol: s, fit: fits[s] ?? bad('unknown_asset', ['OKX 全集里没有这个币']), quote_vol_24h: 1e6, depth_usd_05: null }));
    },
  };
  return { deps, screens, cands, fits, kv, logs, fitCalls, setNow: (t: number) => { now = t; } };
}

const screen = (id: string, finishedAgoH: number, status = 'done'): RadarScreenLike => ({ id, status, started_at: NOW - finishedAgoH * HOUR - 600_000, finished_at: NOW - finishedAgoH * HOUR });
const cand = (symbol: string, rank: number, fit_score: number, reasons: string[] = ['趋势贴合', '回撤可控'], strategy_id = 'strat-a'): RadarCandidateLike => ({ symbol, rank, fit_score, reasons, strategy_id });

describe('radarFeedChannel', () => {
  it('新一轮 done 的 screen 推一次,标题双语、入选币、时效、流动性门;同一轮重复 tick 返回 null', async () => {
    const h = harness({
      screens: { swing: screen('scr-s1', 3) },
      cands: { 'scr-s1': [cand('BTCUSDT', 1, 0.82), cand('BTCUSDT', 2, 0.7, ['重复策略'], 'strat-b'), cand('ETHUSDT', 3, 0.74)] },
      fits: { BTCUSDT: ok('long', ['breakout', 'ma_trend']), ETHUSDT: ok('both', ['mean_reversion', 'smc']) },
    });
    expect(radarFeedChannel.key).toBe('radar_feed');
    expect(radarFeedChannel.every_ms).toBe(5 * 60_000);
    const p = await radarFeedChannel.tick(h.deps);
    expect(p).not.toBeNull();
    expect(p!.event_id).toBe('radar:swing:scr-s1');
    expect(p!.channel).toBe('radar_feed');
    const lines = p!.text.split('\n');
    expect(lines[0]).toBe('【雷达榜单 / Radar Picks】波段档 swing · 2026-09-25 11:00 UTC');
    expect(p!.text).toContain('跑完于 3 小时前(未过期');
    expect(p!.text).toContain('#1 BTCUSDT 适配 0.82 · 中线门 通过 · 方向 偏多 long · 策略族 breakout/ma_trend · 理由:趋势贴合;回撤可控');
    expect(p!.text).toContain('#3 ETHUSDT 适配 0.74');
    expect(p!.text).not.toContain('重复策略');
    // swing → mid,同一币去重后只评估一次
    expect(h.fitCalls).toEqual([{ symbols: ['BTCUSDT', 'ETHUSDT'], horizon: 'mid' }]);
    expect(RADAR_TIER_HORIZON).toEqual({ short: 'short', swing: 'mid', weekly: 'long' });
    const picks = p!.payload['picks'] as { symbol: string; gate: { eligible: boolean; direction: string; families: string[] } }[];
    expect(picks.map((x) => x.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(picks[0]!.gate).toMatchObject({ eligible: true, direction: 'long', families: ['breakout', 'ma_trend'] });
    expect(p!.payload).toMatchObject({ tier: 'swing', horizon: 'mid', screen_id: 'scr-s1', stale: false });
    // 可附 JSON:最后一行是 payload
    expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({ screen_id: 'scr-s1' });

    expect(await radarFeedChannel.tick(h.deps)).toBeNull();
    expect(await radarFeedChannel.tick(h.deps)).toBeNull();

    // 同档新一轮 → 再推;running 的不算
    h.screens.swing = screen('scr-s2', 0.5, 'running');
    expect(await radarFeedChannel.tick(h.deps)).toBeNull();
    h.screens.swing = screen('scr-s2', 0.5);
    h.cands['scr-s2'] = [cand('SOLUSDT', 1, 0.9)];
    h.fits['SOLUSDT'] = ok('short', ['breakout']);
    const p2 = await radarFeedChannel.tick(h.deps);
    expect(p2!.event_id).toBe('radar:swing:scr-s2');
    expect(p2!.text).toContain('跑完于 30 分钟前');
  });

  it('多档同时更新:每次只推最早跑完的一档,下次 tick 推下一档,全推完后 null', async () => {
    const h = harness({
      screens: { short: screen('scr-short', 1), swing: screen('scr-swing', 5), weekly: screen('scr-week', 2) },
      cands: { 'scr-short': [cand('BTCUSDT', 1, 0.8)], 'scr-swing': [cand('ETHUSDT', 1, 0.7)], 'scr-week': [cand('BNBUSDT', 1, 0.6)] },
      fits: { BTCUSDT: ok('long', ['breakout']), ETHUSDT: ok('long', ['breakout']), BNBUSDT: ok('long', ['breakout']) },
    });
    const ids: (string | null)[] = [];
    for (let i = 0; i < 4; i++) ids.push((await radarFeedChannel.tick(h.deps))?.event_id ?? null);
    expect(ids).toEqual(['radar:swing:scr-swing', 'radar:weekly:scr-week', 'radar:short:scr-short', null]);
    expect(h.fitCalls.map((c) => c.horizon)).toEqual(['mid', 'long', 'short']);
  });

  it('流动性门不合格:写出原因(成交额/深度/上市时间)且不给方向与策略族', async () => {
    const h = harness({
      screens: { short: screen('scr-1', 2), weekly: screen('scr-w', 1) },
      cands: {
        'scr-1': [cand('BTCUSDT', 1, 0.9), cand('PEPEUSDT', 2, 0.8), cand('DOGEUSDT', 3, 0.7)],
        'scr-w': [cand('NEWUSDT', 1, 0.66)],
      },
      fits: {
        BTCUSDT: ok('long', ['breakout', 'ema_cross']),
        PEPEUSDT: bad('liquidity', ['24h 永续成交额 120.0M', '短线要求永续成交额 ≥ 300.0M(小市值短线扣费后基本必负)']),
        DOGEUSDT: bad('liquidity', ['24h 永续成交额 450.0M', '近价 ±0.5% 挂单 800K', '短线要求 ±0.5% 深度 ≥ 2.0M']),
        NEWUSDT: bad('history', ['24h 永续成交额 40.0M', '上市 120 天,日线历史不够切训练/验证/留出']),
      },
    });
    const p = await radarFeedChannel.tick(h.deps);
    expect(p!.event_id).toBe('radar:short:scr-1');
    expect(p!.text).toContain('本轮 3 个入选,短线流动性门通过 1/3');
    expect(p!.text).toContain('#2 PEPEUSDT 适配 0.80 · 短线门 不合格:流动性不足(短线要求永续成交额 ≥ 300.0M');
    expect(p!.text).toContain('#3 DOGEUSDT 适配 0.70 · 短线门 不合格:流动性不足(短线要求 ±0.5% 深度 ≥ 2.0M)');
    const pepe = (p!.payload['picks'] as { symbol: string; gate: Record<string, unknown> }[]).find((x) => x.symbol === 'PEPEUSDT')!;
    expect(pepe.gate).toMatchObject({ eligible: false, reason: 'liquidity', reason_text: '流动性不足', direction: null, families: [] });

    const w = await radarFeedChannel.tick(h.deps);
    expect(w!.event_id).toBe('radar:weekly:scr-w');
    expect(w!.text.split('\n')[0]).toContain('【雷达榜单 / Radar Picks】周线档 weekly');
    expect(w!.text).toContain('#1 NEWUSDT 适配 0.66 · 长线门 不合格:上市时间不足(上市 120 天');
  });

  it('证据过期(超过两倍刷新周期)标已过期;流动性门取数失败仍推送并说明', async () => {
    const h = harness({ screens: { short: screen('scr-old', 30) }, cands: { 'scr-old': [cand('BTCUSDT', 1, 0.8)] }, fitThrows: true });
    const p = await radarFeedChannel.tick(h.deps);
    expect(p!.text).toContain('跑完于 1 天 6 小时前(已过期,刷新周期 12 小时');
    expect(p!.text).toContain('流动性门取数失败');
    expect(p!.text).toContain('不合格:流动性门暂不可用');
    expect(p!.payload).toMatchObject({ stale: true, gate_error: 'universe offline' });
    expect(h.logs.some((l) => l.startsWith('warn:'))).toBe(true);
  });

  it('本轮无入选币也推一次(不调流动性门)', async () => {
    const h = harness({ screens: { weekly: screen('scr-empty', 1) } });
    const p = await radarFeedChannel.tick(h.deps);
    expect(p!.event_id).toBe('radar:weekly:scr-empty');
    expect(p!.summary).toContain('本轮无入选币');
    expect(h.fitCalls).toEqual([]);
  });

  it('welcome:三档合并摘要,没跑过的档写「尚未运行」;一档都没有也有内容', async () => {
    const h = harness({
      screens: { swing: screen('scr-s', 4) },
      cands: { 'scr-s': [cand('BTCUSDT', 1, 0.82), cand('XYZUSDT', 2, 0.5)] },
      fits: { BTCUSDT: ok('long', ['breakout']), XYZUSDT: bad('liquidity', ['中线要求成交额 ≥ 5.0M']) },
    });
    const w = await radarFeedChannel.welcome(h.deps);
    expect(w.channel).toBe('radar_feed');
    expect(w.text.split('\n')[0]).toContain('【雷达榜单 / Radar Picks】');
    expect(w.text).toContain('短线档 short:尚未运行');
    expect(w.text).toContain('周线档 weekly:尚未运行');
    expect(w.text).toContain('波段档 swing:跑完于 4 小时前(未过期');
    expect(w.text).toContain('BTCUSDT(#1 适配 0.82,中线门通过 偏多 long)');
    expect(w.text).toContain('XYZUSDT(#2 适配 0.50,中线门不合格:流动性不足)');
    expect(w.event_id).toBe('radar:welcome:short=none,swing=scr-s,weekly=none');
    // welcome 不影响 tick 的判重
    expect((await radarFeedChannel.tick(h.deps))!.event_id).toBe('radar:swing:scr-s');

    const empty = await radarFeedChannel.welcome(harness().deps);
    expect(empty.text.length).toBeGreaterThan(50);
    expect(empty.summary).toContain('尚未运行');
    for (const t of ['短线档 short', '波段档 swing', '周线档 weekly']) expect(empty.text).toContain(`${t}:尚未运行`);
  });

  it('红线词:候选理由/策略名里的收益保证类措辞被屏蔽,推送与 welcome 全文过 BANNED_WORDS', async () => {
    const h = harness({
      screens: { short: screen('scr-b', 1) },
      cands: { 'scr-b': [cand('BTCUSDT', 1, 0.9, ['这波稳赚', 'guaranteed breakout, risk-free'], 'strat-保本')] },
      fits: { BTCUSDT: bad('regime', ['日线高波动,中短线假突破多,先不做', '零风险']) },
    });
    const p = await radarFeedChannel.tick(h.deps);
    expect(p).not.toBeNull();
    expect(BANNED_WORDS.test(p!.text)).toBe(false);
    expect(BANNED_WORDS.test(JSON.stringify(p!.payload))).toBe(false);
    expect(p!.text).toContain('[已屏蔽]');
    const w = await radarFeedChannel.welcome(h.deps);
    expect(BANNED_WORDS.test(w.text)).toBe(false);
    // 只给分析与依据,不给买卖指令
    for (const s of [p!.text, w.text]) expect(s).not.toMatch(/买入|卖出|开仓|下单|\bbuy\b|\bsell\b/i);
  });
  it('首次启用:只记各档当前游标、不推旧榜;之后只推新一轮', async () => {
    const h = harness({ fresh: true, screens: { short: screen('s1', 1), swing: screen('w1', 5) }, cands: { s1: [cand('BTCUSDT', 1, 0.9)], w1: [cand('ETHUSDT', 1, 0.8)] } });
    expect(await radarFeedChannel.tick(h.deps)).toBeNull();
    expect(await radarFeedChannel.tick(h.deps)).toBeNull();
    h.screens.short = screen('s2', 0);
    h.cands['s2'] = [cand('SOLUSDT', 1, 0.7)];
    expect((await radarFeedChannel.tick(h.deps))!.event_id).toBe('radar:short:s2');
  });
});
