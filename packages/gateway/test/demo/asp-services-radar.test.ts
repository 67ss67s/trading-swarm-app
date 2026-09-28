// 订阅频道「雷达榜单」radar_feed:只列清单全过 / 差一步(带具体触发条件)的币;新一轮检测、判重、多档依次推、welcome、流动性门、
// OKX USDT 永续过滤、合规措辞、订阅信号行。全部注入依赖,零网络。
import { describe, expect, it } from 'vitest';
import {
  MAX_OPEN, RADAR_ELIGIBLE_ONLY, RADAR_FEED_TOP, RADAR_NEAR_MAX, RADAR_TIER_HORIZON, checklistOf, conditionTrigger, radarFeedChannel, triggerDistance,
  type RadarCandidateLike, type RadarDeps, type RadarFitRow, type RadarScreenLike,
} from '../../src/demo/asp-agent/services/radar-feed.js';
import { CHANNEL_DISCLAIMER as DISCLAIMER, CHANNEL_DISCLAIMER_AI as DISCLAIMER_AI, INSTRUCTION_WORDS } from '../../src/demo/asp-agent/services/market-brief.js';
import type { ChannelDeps, ChannelPush } from '../../src/demo/asp-agent/services/types.js';
import { BANNED_WORDS, validateSignalText } from '../../src/demo/asp-agent/publisher.js';
import type { Horizon, HorizonFit, RadarTier } from '../../src/demo/recommend.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 25, 14, 0);

const REG: Record<string, string> = { long: '多头', short: '空头', both: '震荡' };
/** 过门结果;证据里带日线状态(与推荐层一致),noRegime=true 模拟日线状态未知 */
const ok = (direction: HorizonFit['direction'], families: HorizonFit['families'], noRegime = false): HorizonFit =>
  ({ eligible: true, reason: null, direction, families, evidence: ['24h 永续成交额 900.0M', ...(noRegime ? ['日线状态未知,族按趋势 + 回归各给一类'] : [`日线${REG[direction ?? 'both']}(价>EMA20, EMA20>EMA50,20 日 5.0%)`])] });
const bad = (reason: string, evidence: string[]): HorizonFit => ({ eligible: false, reason, direction: null, families: [], evidence });

/** 筛选器 OpportunityCard 的突破回踩清单(与 screener.ts 同句式);fail 里的条件不通过 */
const BR_KEYS = ['atr_ok', 'trend_agree', 'within_chase', 'breakout', 'retest_vol', 'funding_ok', 'regime_ok'] as const;
const BR_LABEL: Record<string, [string, string]> = {
  atr_ok: ['ATR% ≥ 分周期门槛', 'ATR% 2.00(门槛 0.60)'], trend_agree: ['1h/4h EMA20-vs-EMA50 同向', '同向(偏多)'],
  within_chase: ['距突破位 ≤ 1.5 ATR', '距 2.50 ATR'], breakout: ['1 根内收破突破位', '3 根前突破'],
  retest_vol: ['量比 ≥ 1', '当根量比 0.80,突破那根 0.90'], funding_ok: ['资金费率绝对值不极端', '0.01%(上限 0.05%)'],
  regime_ok: ['日线状态不反对该方向', '日线 volatile'], reversion_prob: ['历史回归比例 ≥ 55%', '回归 40%'],
};
function card(strategy_id: string, fail: string[] = [], opts: { direction?: 'long' | 'short'; extra?: string[]; level?: number; level_short?: number; atr_pct?: number | null; timeframe?: string } = {}): Record<string, unknown> {
  const keys = [...BR_KEYS, ...(opts.extra ?? [])];
  const conditions = keys.map((k) => ({ key: k, label: BR_LABEL[k]![0], pass: !fail.includes(k), near: false, detail: BR_LABEL[k]![1] }));
  return {
    symbol: 'X', timeframe: opts.timeframe ?? '4h', as_of: NOW - 3 * HOUR, last_close: 100, atr_pct: opts.atr_pct === undefined ? 2 : opts.atr_pct, daily_regime: 'volatile',
    // r2:突破位离收盘 1 ATR / 2%(原来 105 / 90 离收盘 2.5 / 5 ATR,正是新规则要剔除的「假 Near」);opts.level 可覆盖
    breakout: { level_long: opts.level ?? 102, level_short: opts.level_short ?? 98, dist_long_atr: 1, dist_short_atr: 1 },
    strategies: [{ strategy_id, passed: keys.length - fail.length, total: keys.length, direction: opts.direction ?? 'long', conditions }],
  };
}

function harness(init: { screens?: Partial<Record<RadarTier, RadarScreenLike>>; cands?: Record<string, RadarCandidateLike[]>; fits?: Record<string, HorizonFit>; fitThrows?: boolean; fresh?: boolean; tradable?: RadarDeps['tradable']; tickers?: RadarDeps['tickers'] } = {}) {
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
      if (symbols.length > 12) throw new Error('recommendAssets 单次最多 12 个');
      if (init.fitThrows) throw new Error('universe offline');
      return symbols.map((s) => ({ symbol: s, fit: fits[s] ?? bad('unknown_asset', ['OKX 全集里没有这个币']), quote_vol_24h: 1e6, depth_usd_05: null }));
    },
    ...(init.tradable ? { tradable: init.tradable } : {}),
    ...(init.tickers ? { tickers: init.tickers } : {}),
  };
  return { deps, screens, cands, fits, kv, logs, fitCalls, setNow: (t: number) => { now = t; } };
}

const CJK = /[一-鿿]/;
/** 推送正文全英文:不许有中日韩字符、【】旧标题、snake_case 内部 key */
function englishBody(text: string): void {
  expect(text).not.toMatch(CJK);
  expect(text).not.toMatch(/[【】]/);
  const body = text.split('\n').slice(1).filter((l) => l !== DISCLAIMER && l !== DISCLAIMER_AI).join('\n');
  expect(body).not.toMatch(/[a-z]+_[a-z_]+/);
}
/** 订阅信号行:【Futures】类型头、≤200 字、信息类尾巴、无红线词 */
function goodSignal(p: ChannelPush): void {
  expect(p.signal).toBeTruthy();
  expect(p.signal!.startsWith('【Futures】OKX USDT perps | Radar')).toBe(true);
  expect(validateSignalText(p.signal!)).toMatchObject({ ok: true, executable: true });
  expect(p.signal).toMatch(/Info only, no order/);
  expect(p.signal!.slice('【Futures】'.length)).not.toMatch(CJK);
}

const screen = (id: string, finishedAgoH: number, status = 'done'): RadarScreenLike => ({ id, status, started_at: NOW - finishedAgoH * HOUR - 600_000, finished_at: NOW - finishedAgoH * HOUR });
const cand = (symbol: string, rank: number, fit_score: number, c: Record<string, unknown> | null = card('breakout_retest'), reasons: string[] = ['契合 1.00(7/7 条通过)', '回撤可控'], strategy_id = 'breakout_retest'): RadarCandidateLike =>
  ({ symbol, rank, fit_score, reasons, strategy_id, ...(c ? { card: c } : {}) });

describe('radar_feed 条件清单 → 触发条件', () => {
  it('清单全过 = complete;差 ≤2 条且都写得出具体条件 = near;差 3 条或有写不出条件的 = far;没有卡片看依据里的条数', () => {
    expect(MAX_OPEN).toBe(2);
    expect(checklistOf(cand('A', 1, 1)).status).toBe('complete');
    const one = checklistOf(cand('A', 1, 0.9, card('breakout_retest', ['breakout'])));
    expect(one).toMatchObject({ status: 'near', met: 6, total: 7, direction: 'long', timeframe: '4h', level: 102, last_close: 100 });
    expect(one.triggers).toEqual(['a fresh 4h close above 102.00']);
    // 突破位 + 距突破位同时没满足:合成一个收盘区间(ATR = 2% × 100 = 2)
    expect(checklistOf(cand('A', 1, 0.8, card('breakout_retest', ['breakout', 'within_chase']))).triggers).toEqual(['a fresh 4h close above 102.00 but not beyond 105.00 (1.5 ATR)']);
    const short = checklistOf(cand('A', 1, 0.8, card('breakout_retest', ['breakout', 'within_chase'], { direction: 'short' })));
    expect(short.triggers).toEqual(['a fresh 4h close below 98.00 but not beyond 95.00 (1.5 ATR)']);
    expect(checklistOf(cand('A', 1, 0.8, card('breakout_retest', ['breakout', 'retest_vol']))).triggers).toEqual(['a fresh 4h close above 102.00', '4h volume at least 1× its average']);
    expect(checklistOf(cand('A', 1, 0.7, card('breakout_retest', ['breakout', 'retest_vol', 'regime_ok']))).status).toBe('far');
    // 历史回归比例这种统计量写不出触发条件 → 不算差一步
    expect(checklistOf(cand('A', 1, 0.8, card('breakout_retest', ['reversion_prob'], { extra: ['reversion_prob'] }))).status).toBe('far');
    expect(checklistOf(cand('A', 1, 1, null, ['契合 1.00(7/7 条通过)'])).status).toBe('complete');
    expect(checklistOf(cand('A', 1, 0.8, null, ['契合 0.86(6/7 条通过)'])).status).toBe('unknown');
    expect(checklistOf(cand('A', 1, 0.8, null, ['趋势贴合'])).status).toBe('unknown');
  });

  it('各类条件的触发文字只写状态与阈值,不写操作', () => {
    const ctx = { tf: '4h', dir: 'long' as const, level: 102, last: 100, atr_pct: 2, regime: 'volatile' };
    const t = (key: string, label: string, detail = '') => conditionTrigger({ key, label, detail }, ctx);
    expect(t('trend_agree', '1h/4h EMA20-vs-EMA50 同向')).toBe('1h and 4h EMA20 vs EMA50 aligned up');
    expect(t('regime_ok', '日线状态不反对该方向')).toBe('daily regime no longer volatile');
    expect(t('funding_ok', '资金费率绝对值不极端', '0.09%(上限 0.05%)')).toBe('|funding| back under 0.05% per period');
    expect(t('atr_ok', 'ATR% ≥ 分周期门槛', 'ATR% 0.40(门槛 0.60)')).toBe('ATR% above 0.60 (now 0.40)');
    expect(t('compressed', '带宽分位 ≤ 20% 或 squeeze ≥ 6 根')).toBe('Bollinger bandwidth in the lowest 20% of 90 bars, or a squeeze lasting 6+ bars');
    expect(t('expansion_vol', '扩张量比 ≥ 1.8')).toBe('4h volume at least 1.8× its average on the breakout bar');
    expect(t('deviation', '距 EMA20 ≥ 2 ATR', '偏离 -1.30 ATR')).toBe('price stretched at least 2.00 ATR from the 4h EMA20 (now -1.30 ATR)');
    expect(t('ranging', '震荡(日线 range 或 ADX < 20)')).toBe('daily regime turns ranging or ADX drops below 20');
    expect(t('funding_z', '|30 天 z| ≥ 2')).toBe('funding 30-day z-score beyond ±2.00');
    expect(t('reversion_prob', '历史回归比例 ≥ 55%')).toBeNull();
    expect(t('whatever', 'x')).toBeNull();
    for (const k of ['breakout', 'within_chase', 'retest_vol', 'trend_agree', 'regime_ok', 'funding_ok', 'atr_ok']) {
      const s = t(k, BR_LABEL[k]![0], BR_LABEL[k]![1])!;
      expect(INSTRUCTION_WORDS.test(s)).toBe(false);
      expect(s).not.toMatch(CJK);
    }
  });
});

describe('radar_feed「Near」要真的近(r2)', () => {
  const near = (sym: string, rank: number, o: Parameters<typeof card>[2] = {}, fail = ['breakout']) => cand(sym, rank, 0.9, card('breakout_retest', fail, o));
  const pushOf = async (tier: RadarTier, list: RadarCandidateLike[], tickers?: RadarDeps['tickers']) => {
    const h = harness({ screens: { [tier]: screen('scr-near', 1) }, cands: { 'scr-near': list }, fits: Object.fromEntries(list.map((c) => [c.symbol, ok('long', ['breakout'])])), ...(tickers ? { tickers } : {}) });
    return { p: (await radarFeedChannel.tick(h.deps))!, h };
  };
  const listed = (p: ChannelPush) => p.text.split('\n').filter((l) => /^\d\. /.test(l)).map((l) => l.split(' · ')[0]!.replace(/^\d\. /, ''));
  it('上限:1.5 × 该档 ATR 且 短线 3% / 波段 6% / 周线 10%', () => {
    expect(RADAR_NEAR_MAX).toEqual({ atr: 1.5, pct: { short: 0.03, swing: 0.06, weekly: 0.1 } });
    const k = (o: Parameters<typeof card>[2]) => checklistOf(near('A', 1, o));
    // 收盘 100、ATR 5(atr_pct 5):突破位 104 = 0.8 ATR / 4% → 短线超 3% 不算近,波段算
    expect(triggerDistance(k({ level: 104, atr_pct: 5 }), 'short', null)).toMatchObject({ within: false, ref_source: 'last_close', abs: 4 });
    expect(triggerDistance(k({ level: 104, atr_pct: 5 }), 'swing', null)).toMatchObject({ within: true, atr: 0.8, pct: 0.04 });
    // ATR 2:103.5 = 1.75 ATR → 各档都不算近(百分比没超也不行)
    for (const t of ['short', 'swing', 'weekly'] as const) expect(triggerDistance(k({ level: 103.5 }), t, null)!.within).toBe(false);
    // 周线:ATR 8、109 = 1.1 ATR / 9% → 周线算近,波段超 6%
    expect(triggerDistance(k({ level: 109, atr_pct: 8 }), 'weekly', null)!.within).toBe(true);
    expect(triggerDistance(k({ level: 109, atr_pct: 8 }), 'swing', null)!.within).toBe(false);
    // ATR 缺失:只看百分比
    expect(triggerDistance(k({ level: 105, atr_pct: null }), 'swing', null)).toMatchObject({ within: true, atr: null, pct: 0.05 });
    expect(triggerDistance(k({ level: 107, atr_pct: null }), 'swing', null)!.within).toBe(false);
    // 有实时价用实时价;已越过突破位 = 0 距离
    expect(triggerDistance(k({}), 'short', 96)).toMatchObject({ ref_source: 'live', abs: 6, atr: 3, within: false });
    expect(triggerDistance(k({}), 'short', 102.4)).toMatchObject({ abs: 0, within: true });
    // 空头:98 / 95 区间,现价 100 → 离区间上沿 2
    expect(triggerDistance(checklistOf(near('A', 1, { direction: 'short' }, ['breakout', 'within_chase'])), 'swing', null)).toMatchObject({ abs: 2, zone: { lo: 95, hi: 98 }, within: true });
    // 非价位触发(量比)不做距离过滤;清单全过没有距离
    expect(triggerDistance(checklistOf(near('A', 1, {}, ['retest_vol'])), 'short', null)).toBeNull();
    expect(triggerDistance(checklistOf(cand('A', 1, 1)), 'short', null)).toBeNull();
  });
  it('复审实例:XRP 触发 1.66 vs 现价 1.52、BTC 87247 vs 83950 → 不列为 Near,计入 Not listed;近的照常列并写距离', async () => {
    const xrp = cand('XRPUSDT', 1, 0.9, { ...card('breakout_retest', ['breakout'], { level: 1.66, atr_pct: 1.2 }), last_close: 1.52 });
    const btc = cand('BTCUSDT', 2, 0.9, { ...card('breakout_retest', ['breakout'], { level: 87247, atr_pct: 0.9 }), last_close: 83950 });
    const eth = near('ETHUSDT', 3, { level: 101 });
    const { p, h } = await pushOf('short', [xrp, btc, eth]);
    expect(listed(p)).toEqual(['ETH']);
    expect(p.text).toContain('Trigger: a fresh 4h close above 101.00 (last close 100.00 at 11:00 UTC; 0.5 ATR / 1.0% away)');
    expect(p.text).toContain('Not listed (of 3 screened): 2 with a price trigger too far from the current price to count as near (over 1.5 ATR or 3%).');
    expect(p.payload).toMatchObject({ hidden: { too_far: 2, incomplete: 0 } });
    expect(p.signal).toContain('Near: ETH (4h close > 101.00)');
    expect(p.signal).not.toMatch(/XRP|BTC/);
    // 太远的不送去流动性门
    expect(h.fitCalls).toEqual([{ symbols: ['ETHUSDT'], horizon: 'short' }]);
    const pk = (p.payload['picks'] as { trigger_distance: { ref_source: string; within: boolean } }[])[0]!;
    expect(pk.trigger_distance).toMatchObject({ ref_source: 'last_close', within: true });
    expect(p.text).not.toMatch(CJK);
  });
  it('实时价优先:收盘时近、现价已跑远 → 不算 Near;现价更近 → 列出并按现价写距离;实时价只取一次', async () => {
    const calls: string[][] = [];
    const tickers: RadarDeps['tickers'] = async (syms) => { calls.push(syms); return { AUSDT: { last: 96 }, BUSDT: { last: 101 } }; };
    const { p } = await pushOf('swing', [near('AUSDT', 1), near('BUSDT', 2, { level: 104 }), cand('CUSDT', 3, 1)], tickers);
    expect(listed(p)).toEqual(['C', 'B']);
    expect(p.text).toContain('Trigger: a fresh 4h close above 104.00 (last close 100.00 at 11:00 UTC, now 101.00; 1.5 ATR / 3.0% away)');
    expect(p.payload).toMatchObject({ hidden: { too_far: 1 } });
    expect(calls).toEqual([['AUSDT', 'BUSDT'], ['CUSDT']]);
  });
  it('ATR 缺失只看百分比,行内只写百分比', async () => {
    const { p } = await pushOf('swing', [near('AUSDT', 1, { level: 105, atr_pct: null }), near('BUSDT', 2, { level: 107, atr_pct: null })]);
    expect(listed(p)).toEqual(['A']);
    expect(p.text).toContain('Trigger: a fresh 4h close above 105.00 (last close 100.00 at 11:00 UTC; 5.0% away)');
    expect(p.text).toContain('1 with a price trigger too far from the current price to count as near (over 1.5 ATR or 6%)');
  });
});

describe('radarFeedChannel', () => {
  it('新一轮推一次:只列清单全过 / 差一步的(全过在前),差一步写具体触发价位;全英文;显式信号行;同一轮重复 tick 返回 null', async () => {
    const h = harness({
      screens: { swing: screen('scr-s1', 3) },
      cands: { 'scr-s1': [
        cand('ETHUSDT', 1, 0.86, card('breakout_retest', ['breakout']), ['契合 0.86(6/7 条通过,1 条差一点)', '还差:1 根内收破突破位未成立']),
        cand('ETHUSDT', 2, 0.7, card('mtf_alignment'), ['重复策略'], 'mtf_alignment'),
        cand('SOLUSDT', 3, 0.71, card('breakout_retest', ['breakout', 'retest_vol', 'regime_ok'])),
        cand('BTCUSDT', 4, 0.82),
        cand('XRPUSDT', 5, 0.8, null, ['趋势贴合']),
      ] },
      fits: { BTCUSDT: ok('long', ['breakout', 'ma_trend']), ETHUSDT: ok('both', ['mean_reversion', 'smc']) },
    });
    expect(radarFeedChannel.key).toBe('radar_feed');
    expect(radarFeedChannel.every_ms).toBe(5 * 60_000);
    const p = (await radarFeedChannel.tick(h.deps))!;
    expect(p.event_id).toBe('radar:swing:scr-s1');
    const lines = p.text.split('\n');
    expect(lines[0]).toBe('Radar Picks · Swing tier · 2026-09-25 11:00 UTC');
    expect(lines[1]).toBe('Swing tier: 1 setup with the full checklist met, 1 within 2 named triggers (4 screened)');
    expect(p.text).toContain('Evidence freshness: Updated 11:00 UTC · next run ~09-28 11:00 UTC');
    expect(p.text).toContain('\n1. BTC · Breakout retest · bias up · Checklist 7/7 met · breakout level 102.00 · last close 100.00 at 11:00 UTC · Daily: bullish\n');
    // r2:差一步的价位触发行内写出离现价多远(ATR 倍数 / 百分比)
    expect(p.text).toContain('\n2. ETH · Breakout retest · bias up · Checklist 6/7 · Trigger: a fresh 4h close above 102.00 (last close 100.00 at 11:00 UTC; 1.0 ATR / 2.0% away) · Daily: ranging\n');
    expect(p.text).not.toContain('SOL');
    expect(p.text).not.toContain('XRP');
    expect(p.text).not.toContain('重复策略');
    expect(p.text).toContain('Not listed (of 4 screened): 2 with 3+ checklist conditions open or no concrete trigger.');
    expect(p.text).toContain('Everything is computed by code.');
    englishBody(p.text);
    expect(p.text).toContain(DISCLAIMER);
    // 只对清单够格的跑流动性门
    expect(h.fitCalls).toEqual([{ symbols: ['BTCUSDT', 'ETHUSDT'], horizon: 'mid' }]);
    expect(RADAR_TIER_HORIZON).toEqual({ short: 'short', swing: 'mid', weekly: 'long' });
    goodSignal(p);
    expect(p.signal).toBe('【Futures】OKX USDT perps | Radar · Swing tier | Checklist met: BTC. Near: ETH (4h close > 102.00) | Info only, no order | Trading Swarm');
    const picks = p.payload['picks'] as { symbol: string; checklist: { status: string; triggers: string[] }; gate: { eligible: boolean; families: string[] } }[];
    expect(picks.map((x) => x.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(picks.map((x) => x.checklist.status)).toEqual(['complete', 'near']);
    expect(picks[0]!.gate).toMatchObject({ eligible: true, families: ['breakout', 'ma_trend'] });
    expect(p.payload).toMatchObject({ tier: 'swing', horizon: 'mid', screen_id: 'scr-s1', stale: false, eligible_only: true, screened: 4, hidden: { incomplete: 2, ineligible: 0, untradable: 0 } });
    expect(p.text).not.toContain('{"');
    expect(p.payload['sha256']).toMatch(/^[0-9a-f]{64}$/);

    expect(await radarFeedChannel.tick(h.deps)).toBeNull();
    // 同档新一轮 → 再推;running 的不算
    h.screens.swing = screen('scr-s2', 0.5, 'running');
    expect(await radarFeedChannel.tick(h.deps)).toBeNull();
    h.screens.swing = screen('scr-s2', 0.5);
    h.cands['scr-s2'] = [cand('SOLUSDT', 1, 0.9, card('breakout_retest', ['breakout', 'within_chase'], { direction: 'short' }))];
    h.fits['SOLUSDT'] = ok('short', ['breakout']);
    const p2 = (await radarFeedChannel.tick(h.deps))!;
    expect(p2.event_id).toBe('radar:swing:scr-s2');
    expect(p2.text).toContain('Updated 13:30 UTC');
    expect(p2.text).toContain('1. SOL · Breakout retest · bias down · Checklist 5/7 · Trigger: a fresh 4h close below 98.00 but not beyond 95.00 (1.5 ATR) (last close 100.00 at 11:00 UTC; 1.0 ATR / 2.0% away) · Daily: bearish');
  });

  it('最多列 5 个:全过的在前,差一条的在差两条的前面,同类按名次;超出的计数', async () => {
    expect(RADAR_FEED_TOP).toBe(5);
    const list = [
      cand('A2USDT', 1, 0.9, card('breakout_retest', ['breakout', 'retest_vol'])),
      cand('A1USDT', 2, 0.9, card('breakout_retest', ['breakout'])),
      cand('C1USDT', 3, 1), cand('C2USDT', 4, 1),
      cand('B2USDT', 5, 0.9, card('breakout_retest', ['breakout', 'retest_vol'])),
      cand('B1USDT', 6, 0.9, card('breakout_retest', ['retest_vol'])),
    ];
    const h = harness({ screens: { weekly: screen('scr-w', 1) }, cands: { 'scr-w': list }, fits: Object.fromEntries(list.map((c) => [c.symbol, ok('long', ['breakout'])])) });
    const p = (await radarFeedChannel.tick(h.deps))!;
    const shown = p.text.split('\n').filter((l) => /^\d\. /.test(l)).map((l) => l.split(' · ')[0]);
    expect(shown).toEqual(['1. C1', '2. C2', '3. A1', '4. B1', '5. A2']);
    expect(p.text).toContain('1 beyond the top 5');
    englishBody(p.text);
    goodSignal(p);
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

  it('各档都只列通过流动性门的币,没过的末尾按原因计数;一个都没过就写明并给最接近的', async () => {
    expect(RADAR_ELIGIBLE_ONLY).toEqual({ short: true, swing: true, weekly: true });
    const h = harness({
      screens: { short: screen('scr-1', 2) },
      cands: { 'scr-1': [cand('PEPEUSDT', 1, 0.95), cand('BTCUSDT', 2, 0.9), cand('DOGEUSDT', 3, 0.7)] },
      fits: {
        BTCUSDT: ok('long', ['breakout', 'ema_cross']),
        PEPEUSDT: bad('liquidity', ['24h 永续成交额 120.0M', '短线要求永续成交额 ≥ 300.0M(小市值短线扣费后基本必负)']),
        DOGEUSDT: bad('regime', ['日线高波动,中短线假突破多,先不做']),
      },
    });
    const p = (await radarFeedChannel.tick(h.deps))!;
    expect(p.summary).toBe('Short-term tier: 1 setup with the full checklist met (3 screened)');
    expect(p.text).toContain('1. BTC · Breakout retest · bias up · Checklist 7/7 met');
    expect(p.text).not.toMatch(/PEPE|DOGE/);
    expect(p.text).toContain('Not listed (of 3 screened): 2 failed the short-term liquidity gate (insufficient liquidity ×1, daily regime not suitable ×1).');
    englishBody(p.text);
    expect(p.payload).toMatchObject({ eligible_only: true, hidden: { untradable: 0, ineligible: 2, ineligible_reasons: { liquidity: 1, regime: 1 } } });

    const none = harness({
      screens: { swing: screen('scr-n', 1) },
      cands: { 'scr-n': [cand('AUSDT', 1, 0.9), cand('BUSDT', 2, 0.8, card('breakout_retest', ['breakout', 'retest_vol', 'regime_ok'])), cand('CUSDT', 3, 0.5, card('breakout_retest', ['breakout', 'retest_vol', 'regime_ok', 'trend_agree']))] },
      fits: { AUSDT: bad('liquidity', ['x']) },
    });
    const q = (await radarFeedChannel.tick(none.deps))!;
    expect(q.summary).toBe('Swing tier: no symbol has the full checklist met or sits within 2 named triggers this round (3 screened)');
    expect(q.text).toContain('No symbols to list this round.');
    expect(q.text).toContain('Not listed (of 3 screened): 2 with 3+ checklist conditions open or no concrete trigger; 1 failed the mid-term liquidity gate (insufficient liquidity ×1). Closest: B 4/7, C 3/7.');
    goodSignal(q);
    expect(q.signal).toContain('No qualifying setups this round (3 screened)');
  });

  it('流动性门按 12 个一批评估,凑够为止', async () => {
    const list = Array.from({ length: 14 }, (_, i) => cand(`C${i + 1}USDT`, i + 1, 0.9 - i * 0.01));
    const fits = Object.fromEntries(list.map((c) => [c.symbol, bad('liquidity', ['短线要求永续成交额 ≥ 300.0M'])]));
    fits['C13USDT'] = ok('short', ['breakout']);
    const h = harness({ screens: { short: screen('scr-b', 1) }, cands: { 'scr-b': list }, fits });
    const p = (await radarFeedChannel.tick(h.deps))!;
    expect(h.fitCalls.map((c) => c.symbols.length)).toEqual([12, 2]);
    expect(p.text).toContain('1. C13 · Breakout retest · bias up · Checklist 7/7 met');
    expect(p.text).toContain('13 failed the short-term liquidity gate');
  });

  it('tradable:与资产 × 周期服务同一口径,只列有 OKX USDT 永续的(只有现货也剔除),不送去评估', async () => {
    const asked: string[] = [];
    const h = harness({
      screens: { short: screen('scr-t', 1), swing: screen('scr-sw', 2) },
      cands: {
        'scr-t': [cand('AMDUSDT', 1, 1), cand('SOXSUSDT', 2, 0.9), cand('BTCUSDT', 3, 0.88), cand('ETHUSDT', 4, 0.8)],
        'scr-sw': [cand('SNDKUSDT', 1, 1), cand('PHAUSDT', 2, 1), cand('XRPUSDT', 3, 0.86)],
      },
      fits: { BTCUSDT: ok('long', ['breakout']), ETHUSDT: ok('both', ['breakout']), XRPUSDT: ok('long', ['ma_trend']), PHAUSDT: ok('long', ['breakout']) },
      tradable: (s, m = 'perp') => { asked.push(`${s}:${m}`); return !['AMDUSDT', 'SOXSUSDT', 'SNDKUSDT'].includes(s) && !(s === 'PHAUSDT' && m === 'perp'); },
    });
    const sw = (await radarFeedChannel.tick(h.deps))!;
    expect(sw.event_id).toBe('radar:swing:scr-sw');
    expect(sw.text).not.toMatch(/SNDK|PHA/);
    expect(sw.text).toContain('2 without an OKX USDT perp.');
    expect(asked.some((x) => x.endsWith(':spot'))).toBe(false);
    const p = (await radarFeedChannel.tick(h.deps))!;
    expect(h.fitCalls.find((c) => c.horizon === 'short')!.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(p.text).not.toMatch(/AMD|SOXS/);
    expect(p.payload).toMatchObject({ hidden: { untradable: 2, ineligible: 0 } });
  });

  it('实时价(可选):触发条件旁写现价;已越过突破位时如实写出;取价失败照常推', async () => {
    const mk = (tickers: RadarDeps['tickers']) => harness({
      screens: { swing: screen('scr-l', 1) }, cands: { 'scr-l': [cand('ETHUSDT', 1, 0.86, card('breakout_retest', ['breakout']))] },
      fits: { ETHUSDT: ok('long', ['breakout']) }, tickers,
    });
    const a = (await radarFeedChannel.tick(mk(async () => ({ ETHUSDT: { last: 101.5 } })).deps))!;
    expect(a.text).toContain('Trigger: a fresh 4h close above 102.00 (last close 100.00 at 11:00 UTC, now 101.50; 0.3 ATR / 0.5% away)');
    const b = (await radarFeedChannel.tick(mk(async () => ({ ETHUSDT: { last: 106 } })).deps))!;
    expect(b.text).toContain('Trigger: a fresh 4h close above 102.00 (now 106.00, already above the level intrabar; a 4h close there completes it)');
    const c = mk(async () => { throw new Error('ticker down'); });
    const cp = (await radarFeedChannel.tick(c.deps))!;
    expect(cp.text).toContain('Trigger: a fresh 4h close above 102.00 (last close 100.00 at 11:00 UTC; 1.0 ATR / 2.0% away)');
    expect(c.logs.some((l) => l.includes('ticker down'))).toBe(true);
    for (const x of [a, b, cp]) { englishBody(x.text); expect(INSTRUCTION_WORDS.test(x.text)).toBe(false); }
  });

  it('证据过期标过期;流动性门取数失败仍推送清单够格的并说明', async () => {
    const h = harness({ screens: { short: screen('scr-old', 30) }, cands: { 'scr-old': [cand('BTCUSDT', 1, 0.8)] }, fitThrows: true });
    const p = (await radarFeedChannel.tick(h.deps))!;
    expect(p.text).toContain('Updated 09-24 08:00 UTC · not refreshed for over 2× the refresh interval, treat as stale');
    expect(p.summary).toBe('Short-term tier: 1 setup with the full checklist met (1 screened) · stale');
    expect(p.text).toContain('Note: the liquidity-gate data fetch failed, so the short-term gate could not be applied this round');
    expect(p.text).toContain('1. BTC · Breakout retest · bias up · Checklist 7/7 met');
    expect(p.text).toContain('Short-term gate: liquidity gate unavailable');
    englishBody(p.text);
    expect(p.payload).toMatchObject({ stale: true, gate_error: 'universe offline' });
    expect(h.logs.some((l) => l.startsWith('warn:'))).toBe(true);

    const o = harness({ screens: { short: screen('scr-late', 13) }, cands: { 'scr-late': [cand('BTCUSDT', 1, 0.8)] }, fits: { BTCUSDT: ok('long', ['breakout']) } });
    expect((await radarFeedChannel.tick(o.deps))!.text).toContain('Updated 01:00 UTC · next run was due 13:00 UTC, not finished yet');
  });

  it('本轮无候选也推一次(不调流动性门)', async () => {
    const h = harness({ screens: { weekly: screen('scr-empty', 1) } });
    const p = (await radarFeedChannel.tick(h.deps))!;
    expect(p.event_id).toBe('radar:weekly:scr-empty');
    expect(p.summary).toBe('Weekly tier: no symbol has the full checklist met or sits within 2 named triggers this round (0 screened)');
    expect(h.fitCalls).toEqual([]);
    goodSignal(p);
  });

  it('welcome:三档合并,每档最多 3 行短写,没跑过的档写「not run yet」;一档都没有也有内容;全英文;信号行列出当前标的', async () => {
    const h = harness({
      screens: { swing: screen('scr-s', 4) },
      cands: { 'scr-s': [cand('BTCUSDT', 1, 0.82), cand('XYZUSDT', 2, 0.9, card('breakout_retest', ['breakout'])), cand('ETHUSDT', 3, 0.8, card('breakout_retest', ['breakout']))] },
      fits: { BTCUSDT: ok('long', ['breakout']), XYZUSDT: bad('liquidity', ['中线要求成交额 ≥ 5.0M']), ETHUSDT: ok('long', ['breakout']) },
    });
    const w = await radarFeedChannel.welcome(h.deps);
    expect(w.text.split('\n')[0]).toBe('Radar Picks · All tiers (short-term / swing / weekly) · 2026-09-25 14:00 UTC');
    expect(w.text).toContain('Short-term tier: not run yet');
    expect(w.text).toContain('Weekly tier: not run yet');
    expect(w.text).toContain('Swing tier (Updated 10:00 UTC · next run ~09-28 10:00 UTC):');
    expect(w.text).toContain('\n· 1. BTC · Breakout retest · bias up · Checklist 7/7 met · breakout level 102.00 · last close 100.00 at 11:00 UTC\n');
    expect(w.text).toContain('\n· 2. ETH · Breakout retest · bias up · Checklist 6/7 · Trigger: a fresh 4h close above 102.00 (last close 100.00 at 11:00 UTC; 1.0 ATR / 2.0% away)\n');
    expect(w.text).not.toContain('XYZ');
    expect(w.text).toContain('From here on, each tier gets its own push whenever a round finishes');
    englishBody(w.text);
    expect(w.event_id).toBe('radar:welcome:short=none,swing=scr-s,weekly=none');
    expect(w.signal).toBe('【Futures】OKX USDT perps | Radar · All tiers | Listed now: BTC, ETH | Info only, no order | Trading Swarm');
    // welcome 不影响 tick 的判重
    expect((await radarFeedChannel.tick(h.deps))!.event_id).toBe('radar:swing:scr-s');

    const empty = await radarFeedChannel.welcome(harness().deps);
    expect(empty.summary).toBe('No radar tier has run yet; you will get a push as soon as a round finishes');
    for (const t of ['Short-term tier', 'Swing tier', 'Weekly tier']) expect(empty.text).toContain(`${t}: not run yet`);
    englishBody(empty.text);
    expect(validateSignalText(empty.signal!)).toMatchObject({ ok: true, executable: true });
  });

  it('红线词屏蔽;指令 / 推荐语气整句删;模型写的依据标 [AI] 并换 AI 免责声明;中文依据整条丢', async () => {
    const h = harness({
      screens: { swing: screen('scr-b', 1) },
      cands: { 'scr-b': [
        cand('BTCUSDT', 1, 0.9, card('strat-保本'), ['这波稳赚', 'AI: Top pick. Worth watching alongside SNDK. Bandwidth near the top of its range', '模型:首选。空头顺势。带宽高位'], 'strat-保本'),
        cand('ETHUSDT', 2, 0.8, card('breakout_retest'), ['We recommend a long entry', 'guaranteed breakout, risk-free']),
      ] },
      fits: { BTCUSDT: ok('long', ['breakout']), ETHUSDT: ok('long', ['breakout']) },
    });
    const p = (await radarFeedChannel.tick(h.deps))!;
    expect(BANNED_WORDS.test(p.text)).toBe(false);
    expect(BANNED_WORDS.test(JSON.stringify(p.payload))).toBe(false);
    expect(BANNED_WORDS.test(p.signal!)).toBe(false);
    expect(p.text).toContain('Basis: [AI] Bandwidth near the top of its range');
    expect(p.text).toContain('Basis: [redacted] breakout, [redacted]');
    expect(p.text).not.toMatch(/top pick|worth|we recommend|long entry|首选|顺势/i);
    expect(p.text).toContain('Basis lines marked [AI] were written by the screening model');
    expect(p.text).toContain(DISCLAIMER_AI);
    // 自定义策略 id 不外露
    expect(p.text).toContain('1. BTC · Custom strategy · bias up');
    englishBody(p.text);
    const w = await radarFeedChannel.welcome(h.deps);
    expect(BANNED_WORDS.test(w.text)).toBe(false);
    englishBody(w.text);
    for (const s of [p.text, w.text]) {
      expect(s).not.toMatch(/买入|卖出|开仓|下单|\bbuy\b|\bsell\b/i);
      expect(INSTRUCTION_WORDS.test(s)).toBe(false);
    }
    const zh = harness({ screens: { swing: screen('scr-z', 1) }, cands: { 'scr-z': [cand('BTCUSDT', 1, 0.9, card('breakout_retest'), ['模型:带宽高位,结构清晰'])] }, fits: { BTCUSDT: ok('long', ['breakout']) } });
    const z = (await radarFeedChannel.tick(zh.deps))!;
    expect(z.text).not.toContain('[AI]');
    expect(z.text).toContain(DISCLAIMER);
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
