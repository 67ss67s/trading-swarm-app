// 订阅频道 market_brief(src/demo/asp-agent/services/market-brief.ts):全部注入,零网络、零模型。
import { describe, expect, it } from 'vitest';
import {
  ADVICE_WORDS, BRIEF_EVERY_MS, BRIEF_SIGNAL_HEAD, fundingAnnualized, fundingFromRaw, fundingPer8h, okxBriefContext, oiFromRows, rangeFromCandles, CHANNEL_DISCLAIMER as DISCLAIMER, CHANNEL_DISCLAIMER_AI as DISCLAIMER_AI, INSTRUCTION_WORDS, asOfLabel, channelPush, collectBriefFacts, englishReason, fitReasonText, marketBriefChannel, scrubInstructions, slotOf, strategyName, templateSummary, utcLabel,
  type BriefContext, type BriefDeps,
} from '../../src/demo/asp-agent/services/market-brief.js';
import { memoryMicroSource, type MicroBook, type MicroLiq } from '../../src/demo/asp-agent/services/micro-source.js';
import type { ChannelDeps } from '../../src/demo/asp-agent/services/types.js';
import { BANNED_WORDS, validateSignalText } from '../../src/demo/asp-agent/publisher.js';
import type { DailyRegime } from '../../src/demo/types.js';
import type { UniverseAsset, UniverseScanSummary } from '../../src/demo/universe-okx.js';

const T0 = Date.UTC(2026, 8, 25, 16, 0, 0); // 4 小时槽起点
const MIN = 60_000, HOUR = 3_600_000;

function regime(kind: DailyRegime['regime'], r20 = 5.2, r5 = -1.1): DailyRegime {
  return { regime: kind, ema_stack: '价>EMA20, EMA20>EMA50', ret_20d_pct: r20, ret_5d_pct: r5, vol_pct_rank: 0.4, atr_pct: 2.34, dist_to_ema200_pct: 8, text: '', as_of: T0 - 86_400_000 };
}
function asset(symbol: string, over: Partial<UniverseAsset> = {}): UniverseAsset {
  return {
    symbol, base: symbol.replace('USDT', ''), markets: ['spot', 'perp'] as UniverseAsset['markets'], spot_inst_id: null, perp_inst_id: null,
    last: '100', change_24h: '1.500', quote_volume_24h: '100000000.00', spot_quote_volume_24h: null, perp_quote_volume_24h: '50000000.00',
    funding_rate: '0.0001', next_funding_at: null, listed_at: null, rank_by_volume: 1, quote_volume_90d: null, rank_by_volume_90d: null,
    excluded: false, excluded_reason: null, updated_at: T0, ...over,
  };
}
const UNIVERSE = [
  asset('BTCUSDT', { last: '84000.5', change_24h: '-0.820' }),
  asset('ETHUSDT', { last: '2675.3', change_24h: '1.230' }),
  asset('DOGEUSDT', { funding_rate: '0.0008' }),
  asset('SOLUSDT', { funding_rate: '-0.0012' }),
  asset('XRPUSDT', { funding_rate: '0.0004' }),
  asset('ADAUSDT', { funding_rate: '-0.0003' }),
  // 成交额太小 → 不进资金费率极值
  asset('JUNKUSDT', { funding_rate: '0.0300', perp_quote_volume_24h: '10000.00' }),
  // 排除的 → 不进
  asset('USDCUSDT', { funding_rate: '-0.0200', excluded: true, excluded_reason: 'stable' }),
];
const SCAN: UniverseScanSummary = {
  ready: true, screen_id: 'scr_1', scanned: 280, errors: 0, at: T0 - 14 * HOUR, note: null,
  candidates: [
    // 上游理由多为中文:认得的句式(成交额名次 / 契合 / 机械期望 / 还差)翻成英文,其余中文整条丢
    { symbol: 'SOLUSDT', score: 0.857, reasons: ['日线多头排列', 'OKX 永续,24h 成交额第 3 / 653', '近 30 天机械期望 0.42R,12 笔'], strategy_id: 'mtf_alignment', rank: 1 },
    { symbol: 'METAUSDT', score: 0.8, reasons: ['美股代币'], strategy_id: 'mtf_alignment', rank: 2 },
    { symbol: 'AVAXUSDT', score: 0.771, reasons: ['Broke the 20-day high, top pick', '突破 20 日高点,首选', '契合 0.77'], strategy_id: 's2', rank: 3 },
  ],
};

function book(symbol: string, mid: number, bidQty = 1, askQty = 1, at = T0 - 20_000): MicroBook {
  const step = mid * 0.00001;
  return { symbol, inst_id: `${symbol.replace('USDT', '')}-USDT-SWAP`, at,
    bids: Array.from({ length: 50 }, (_, i) => [mid - step / 2 - i * step, bidQty] as const),
    asks: Array.from({ length: 50 }, (_, i) => [mid + step / 2 + i * step, askQty] as const) };
}
const liq = (at: number, side: 'long' | 'short', usdAmt: number): MicroLiq => ({ id: `${at}:${side}:${usdAmt}`, at, side, price: 84000, qty: usdAmt / 84000, notional_usd: usdAmt });

function memState() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); }, map: m };
}

/** 4 小时背景桩:BTC/ETH 资金费率(8h 结算)、持仓量、区间;全市场费率含不同结算周期(ADA 1h、DOGE 4h) */
function ctxStub(at = T0 + 5 * MIN): BriefContext {
  return {
    at,
    majors: {
      BTCUSDT: { funding: { rate: 0.0001, interval_h: 8, next_at: T0 + 8 * HOUR }, oi: { usd: 2.4e9, at, chg_4h_pct: -0.5, chg_24h_pct: 1.2, scope: 'usdt_perp' }, range: { at, last: 84010, chg_4h_pct: 0.25, chg_24h_pct: -0.8, hi_4h: 84200, lo_4h: 83800, hi_24h: 84500, lo_24h: 83000 } },
      ETHUSDT: { funding: { rate: -0.00005, interval_h: 8, next_at: T0 + 8 * HOUR }, oi: { usd: 1.1e9, at, chg_4h_pct: 2.1, chg_24h_pct: null, scope: 'all_contracts' }, range: null },
    },
    funding: [
      { symbol: 'BTCUSDT', rate: 0.0001, interval_h: 8, next_at: null }, { symbol: 'ETHUSDT', rate: -0.00005, interval_h: 8, next_at: null },
      { symbol: 'DOGEUSDT', rate: 0.0008, interval_h: 4, next_at: null }, { symbol: 'SOLUSDT', rate: -0.0012, interval_h: 8, next_at: null },
      { symbol: 'XRPUSDT', rate: 0.0004, interval_h: 8, next_at: null }, { symbol: 'ADAUSDT', rate: -0.0003, interval_h: 1, next_at: null },
      { symbol: 'JUNKUSDT', rate: 0.03, interval_h: 8, next_at: null }, { symbol: 'USDCUSDT', rate: -0.02, interval_h: 8, next_at: null },
    ],
  };
}

function mkDeps(over: Partial<BriefDeps> = {}, now = T0 + 5 * MIN) {
  const calls = { regime: 0, scan: 0, universe: 0 };
  const logs: string[] = [];
  let clock = now;
  const regimes: Record<string, DailyRegime> = { BTCUSDT: regime('range', 1.2, -0.4), ETHUSDT: regime('bull') };
  const micro = memoryMicroSource({
    books: { BTCUSDT: book('BTCUSDT', 84000, 2, 1), ETHUSDT: book('ETHUSDT', 2675, 10, 10) },
    liqs: {
      BTCUSDT: [liq(T0 - 10 * MIN, 'long', 300_000), liq(T0 - 50 * MIN, 'short', 200_000), liq(T0 - 5 * HOUR, 'long', 999_999)],
      ETHUSDT: [liq(T0, 'short', 50_000)],
    },
    coverage: { BTCUSDT: { from_ms: T0 - 10 * HOUR, to_ms: T0 + 4 * MIN }, ETHUSDT: { from_ms: T0 - 10 * HOUR, to_ms: T0 + 4 * MIN } },
  });
  const deps: ChannelDeps & BriefDeps = {
    now: () => clock,
    state: memState(),
    log: (_l, msg) => { logs.push(msg); },
    regime: async (s) => { calls.regime++; return regimes[s] ?? null; },
    scan: () => { calls.scan++; return SCAN; },
    universe: () => { calls.universe++; return { updated_at: T0, items: UNIVERSE }; },
    micro,
    context: async () => ctxStub(clock),
    ...over,
  };
  return { deps, calls, logs, micro, regimes, setNow: (t: number) => { clock = t; } };
}
const CJK = /[一-鿿]/;
/** 推送正文全英文:不许有中日韩字符、不许有旧版【】双语标题、不许有 snake_case 内部 key */
function englishBody(text: string): void {
  expect(text).not.toMatch(CJK);
  expect(text).not.toMatch(/[【】]/);
  const body = text.split('\n').slice(1).filter((l) => l !== DISCLAIMER && l !== DISCLAIMER_AI).join('\n');
  expect(body).not.toMatch(/[a-z]+_[a-z_]+/);
}

describe('market_brief 频道', () => {
  it('标题与正文全英文;现价只有盘口中间价一个;快照字段标截至时间;JSON 不进正文', async () => {
    const { deps } = mkDeps();
    const p = (await marketBriefChannel.tick(deps))!;
    expect(p.channel).toBe('market_brief');
    expect(p.event_id).toBe(`brief:${T0}`);
    const lines = p.text.split('\n');
    expect(lines[0]).toBe('Market Brief · 2026-09-25 16:00 UTC');
    // 没有上一份:摘要写日线状态 + 清算合计(4 小时窗口,T0-5h 那笔不算)
    expect(lines[1]).toBe('Daily regime: BTC ranging, ETH bullish; open interest over 4h BTC -0.5%, ETH +2.1%. BTC/ETH liquidations on OKX perps in the last 4h: $550K, mostly longs.');
    expect(p.text).toContain('— BTC & ETH, last 4h (OKX USDT perps; prices are order-book mids at 15:59 UTC)');
    // 现价 = 盘口中间价;没接实时行情 → 24h 涨跌来自快照并标注;4h 涨跌与区间来自 15m K 线
    expect(p.text).toContain('BTC 84000.0 · 4h +0.25% · 24h -0.82% (snapshot as of 16:00 UTC) · 4h range 83800.0–84200.0 (price at 50% of range) · 24h range 83000.0–84500.0\n');
    // 资金费率折算每 8h + 年化 + 结算周期;持仓量 4h/24h 变化
    expect(p.text).toContain('BTC funding +0.0100%/8h (+11.0% annualized; settles every 8h) · open interest $2.40B (4h -0.50%, 24h +1.20%)');
    expect(p.text).toContain('ETH 2675.0 · 24h +1.23% (snapshot as of 16:00 UTC)\n');
    expect(p.text).toContain('ETH funding -0.0050%/8h (-5.5% annualized; settles every 8h) · open interest $1.10B across all OKX contracts (4h +2.10%)');
    expect(p.text).toContain('— Daily regime (daily candles as of 09-24)\nBTC ranging · 20d +1.2% · 5d -0.4% · ATR 2.34% · Vol percentile 40%\nETH bullish · 20d +5.2%');
    expect(p.text).not.toContain('84000.5');
    // 扫描:策略英文名,不写分数;中文理由按结构翻译或丢弃;推荐语气分句被删
    expect(p.text).toContain('— Daily scan leaders (OKX USDT perps, market-wide, as of 02:00 UTC, updated daily)');
    expect(p.text).toContain('1. SOLUSDT · Multi-timeframe alignment — OKX perp, #3 of 653 by 24h volume; Rule-based expectancy 0.42R over 12 trades (last 30 days)');
    // 自定义策略 id 不外露;「契合 x」改成说清楚契合什么
    expect(p.text).toContain('3. AVAXUSDT · Custom strategy — Broke the 20-day high; Checklist fit 0.77');
    expect(p.text).not.toContain(' s2');
    expect(p.text).not.toMatch(/top pick/i);
    // 资金费率:实时全市场费率,全部折算到每 8h 再排(ADA 1h 结算单期 -0.03% = 每 8h -0.24%,排到最低);只看未排除且成交额够的
    expect(p.text).toContain('— Funding rate extremes (OKX USDT perps with 24h volume ≥ $5.00M; all rates normalized to per-8h; live at 16:05 UTC)');
    expect(p.text).toContain('Highest: DOGE +0.160%/8h (4h cycle) · XRP +0.040%/8h · BTC +0.010%/8h');
    expect(p.text).toContain('Lowest: ADA -0.240%/8h (1h cycle) · SOL -0.120%/8h · ETH -0.005%/8h');
    expect(p.text).not.toMatch(/not normalized/);
    // 订阅信号行:显式给,【Futures】类型头、≤200 字、信息类尾巴
    expect(p.signal).toBe('【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP | Market brief | BTC 84000.0 4h +0.25% OI -0.5% · ETH 2675.0 OI +2.1% · Liq 4h $550K · Daily BTC ranging, ETH bullish | Info only, no order | Trading Swarm');
    expect(p.signal!.startsWith(BRIEF_SIGNAL_HEAD)).toBe(true);
    expect(validateSignalText(p.signal!)).toMatchObject({ ok: true, executable: true });
    expect(p.text).not.toContain('JUNK');
    expect(p.text).not.toMatch(/USDC -/);
    // 盘口深度段已删(中间价只在行情行);不写价差、不重复中间价
    expect(p.text).not.toMatch(/imbalance|spread|visible ±/i);
    expect(p.text).not.toContain('mid 84000');
    expect(p.text).toContain('— Liquidations, last 4h (OKX perps)');
    expect(p.text).toContain('BTC longs $300K / shorts $200K (2 liquidations)');
    expect(p.text).toContain('ETH longs $0 / shorts $50K (1 liquidation)');
    expect(p.text).not.toContain('Data unavailable');
    englishBody(p.text);
    // JSON 不拼进正文,完整数据在 payload
    expect(p.text).not.toContain('{"');
    expect(p.text).toContain(DISCLAIMER);
    expect(p.payload['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(p.text).toContain(`Checksum (sha256): ${String(p.payload['sha256']).slice(0, 16)}`);
    expect((p.payload['facts'] as { majors: { price_source: string }[] }).majors.map((m) => m.price_source)).toEqual(['book_mid', 'book_mid']);
    expect(BANNED_WORDS.test(p.text)).toBe(false);
    expect(INSTRUCTION_WORDS.test(p.text)).toBe(false);
    expect(p.text.length).toBeLessThanOrEqual(2500);
  });

  it('实时行情:24h 涨跌取 tickers 不标快照;没有盘口的币现价取行情并标注,盘口仍是唯一现价来源', async () => {
    const { deps, micro } = mkDeps({ tickers: async (syms) => { expect(syms).toEqual(['BTCUSDT', 'ETHUSDT']); return { BTCUSDT: { last: 84010, change_24h: -0.5 }, ETHUSDT: { last: 2680.5, change_24h: 0.38 } }; } });
    micro.data.books!['ETHUSDT'] = null;
    const p = (await marketBriefChannel.tick(deps))!;
    expect(p.text).toContain('BTC 84000.0 · 4h +0.25% · 24h -0.50% · 4h range');
    expect(p.text).not.toContain('84010');
    expect(p.text).toContain('ETH 2680.5 (OKX ticker 16:05 UTC) · 24h +0.38%\n');
    // 行情接口挂了 → 退回快照并标注
    const down = mkDeps({ tickers: async () => { throw new Error('okx 502'); } });
    down.micro.data.books = { BTCUSDT: null, ETHUSDT: null };
    const q = (await marketBriefChannel.tick(down.deps))!;
    expect(q.text).toContain('BTC 84000.5 (snapshot as of 16:00 UTC) · 4h +0.25% · 24h -0.82% (snapshot as of 16:00 UTC)');
    expect(down.logs.some((l) => l.includes('okx 502'))).toBe(true);
  });

  it('tradable:扫描与资金费率只列有 OKX USDT 永续的(与资产 × 周期服务同一口径,只有现货的也剔除),并注明略去几个', async () => {
    const seen: string[] = [];
    // AVAX 只有现货 → 也不列
    const { deps } = mkDeps({ tradable: (s, m = 'perp') => { seen.push(`${s}:${m}`); return s !== 'METAUSDT' && s !== 'DOGEUSDT' && !(s === 'AVAXUSDT' && m === 'perp'); } });
    const p = (await marketBriefChannel.tick(deps))!;
    expect(p.text).not.toContain('METAUSDT');
    // 剔除后连续编号,不跳号
    expect(p.text).toContain('(2 symbols without an OKX USDT perp omitted; numbering continues)');
    expect(p.text).toContain('1. SOLUSDT · Multi-timeframe alignment');
    expect(p.text).not.toContain('AVAX');
    expect(p.text).not.toMatch(/^2\. /m);
    expect((p.payload['facts'] as { scan: { top: { rank: number }[] } }).scan.top.map((c) => c.rank)).toEqual([1]);
    expect(p.text).toContain('Highest: XRP +0.040%/8h · BTC +0.010%/8h');
    expect(p.text).not.toContain('DOGE');
    expect(seen).not.toContain('METAUSDT:spot'); // 只按永续判
    expect(seen).toContain('DOGEUSDT:perp');
    // 判定抛错 → 不过滤,记日志
    const bad = mkDeps({ tradable: () => { throw new Error('universe gone'); } });
    expect((await marketBriefChannel.tick(bad.deps))!.text).toContain('METAUSDT');
    expect(bad.logs.some((l) => l.includes('universe gone'))).toBe(true);
  });

  it('正文(标题行、免责声明行以外)不出现 snake_case 内部 key 与中日韩字符:策略 id 全部英文化,未知 id 写 Custom strategy;契合改写成命中条数', async () => {
    const scan: UniverseScanSummary = {
      ...SCAN,
      candidates: [
        { symbol: 'XPLUSDT', score: 1, reasons: ['OKX 永续,24h 成交额第 26 / 653', '契合 1.00(7/7 条通过)'], strategy_id: 'position_breakout_retest', rank: 1 },
        { symbol: 'ONDOUSDT', score: 0.86, reasons: ['契合 0.86(5/7 条通过,2 条差一点)', '还差:量能未放大(0.8x);收盘未站上通道'], strategy_id: 'swing_breakout_retest', rank: 2 },
        { symbol: 'LDOUSDT', score: 0.8, reasons: ['x'], strategy_id: 'swing_vol_compression_expansion', rank: 3 },
        { symbol: 'ARBUSDT', score: 0.7, reasons: ['y'], strategy_id: 'lab_custom_v2', rank: 4 },
        { symbol: 'OPUSDT', score: 0.6, reasons: ['z'], strategy_id: 'funding_oi_extreme', rank: 5 },
      ],
    };
    const { deps } = mkDeps({ scan: () => scan });
    const p = (await marketBriefChannel.tick(deps))!;
    const w = await marketBriefChannel.welcome(deps);
    const empty = mkDeps({ regime: async () => null, scan: () => ({ ready: false, screen_id: null, scanned: 0, errors: 0, at: null, note: null, candidates: [] }), universe: () => null, micro: null });
    const e = (await marketBriefChannel.tick(empty.deps))!;
    for (const t of [p.text, w.text, e.text]) englishBody(t);
    expect(p.text).toContain('1. XPLUSDT · Long-term breakout retest — OKX perp, #26 of 653 by 24h volume; Checklist 7/7 met');
    expect(p.text).toContain('2. ONDOUSDT · Swing breakout retest — Checklist 5/7 met (2 more close); 2 checklist conditions not yet met');
    expect(p.text).toContain('3. LDOUSDT · Swing volatility squeeze → expansion');
    expect(p.text).toContain('4. ARBUSDT · Custom strategy');
    expect(p.text).toContain('5. OPUSDT · Funding/OI extreme');
    expect(strategyName('breakout_retest')).toBe('Breakout retest');
    expect(strategyName('whatever')).toBe('Custom strategy');
    expect(strategyName(null)).toBeNull();
    expect(fitReasonText('契合 0.86(6/7 条通过)')).toBe('Checklist 6/7 met');
    expect(englishReason('日线多头排列')).toBeNull();
    expect(englishReason('还差:量能未放大(0.8x)')).toBe('1 checklist condition not yet met');
  });

  it('4 小时一槽(对齐 UTC 0/4/8/…):同槽重复 tick 同 id 同内容不取数;下一槽写变化、扫描/资金费率同源写「同上一份」', async () => {
    expect(BRIEF_EVERY_MS).toBe(4 * HOUR);
    expect(marketBriefChannel.every_ms).toBe(5 * MIN);
    expect(slotOf(Date.UTC(2026, 8, 25, 9, 30))).toBe(Date.UTC(2026, 8, 25, 8, 0));
    const { deps, calls, micro, regimes, setNow } = mkDeps();
    const a = (await marketBriefChannel.tick(deps))!;
    setNow(T0 + 3 * HOUR + 59 * MIN);
    const b = (await marketBriefChannel.tick(deps))!;
    expect(b.event_id).toBe(a.event_id);
    expect(b.text).toBe(a.text);
    expect(calls.regime).toBe(2);

    setNow(T0 + BRIEF_EVERY_MS + MIN);
    micro.data.books!['BTCUSDT'] = book('BTCUSDT', 84840, 2, 1, T0 + BRIEF_EVERY_MS + 30_000);
    micro.data.books!['ETHUSDT'] = book('ETHUSDT', 2675, 10, 10, T0 + BRIEF_EVERY_MS + 30_000);
    micro.data.coverage = { BTCUSDT: { from_ms: T0 - 10 * HOUR, to_ms: T0 + BRIEF_EVERY_MS }, ETHUSDT: { from_ms: T0 - 10 * HOUR, to_ms: T0 + BRIEF_EVERY_MS } };
    regimes['BTCUSDT'] = regime('bull');
    const c = (await marketBriefChannel.tick(deps))!;
    expect(c.event_id).toBe(`brief:${T0 + BRIEF_EVERY_MS}`);
    expect(calls.regime).toBe(4);
    const cl = c.text.split('\n');
    expect(cl[0]).toBe('Market Brief · 2026-09-25 20:00 UTC');
    expect(cl[1]).toBe('Since the 16:00 UTC brief: BTC +1.00%, ETH +0.00%; open interest over 4h BTC -0.5%, ETH +2.1%; BTC daily regime flipped from ranging to bullish. No BTC/ETH liquidations on OKX perps in the last 4h.');
    // 同一份扫描:压成一行但仍列出标的(不写空洞的「unchanged」);资金费率是实时的,照常给
    expect(c.text).toContain('— Daily scan leaders (as of 02:00 UTC, updated daily; same scan as the 16:00 UTC brief): SOL · META · AVAX\n');
    expect(c.text).not.toMatch(/unchanged since the last brief/);
    expect(c.text).toContain('Highest: DOGE +0.160%/8h (4h cycle)');
    // 日线翻了 → 日线段完整给
    expect(c.text).toContain('— Daily regime (daily candles as of 09-24)\nBTC bullish');
    expect(c.text).not.toContain('SOLUSDT');
    // 摘要不重复正文的扫描 / 资金费率
    expect(cl[1]).not.toMatch(/SOL|DOGE|[Ff]unding/);
    englishBody(c.text);

    // 再下一槽什么都没怎么变:摘要以「Quiet 4h」开头,日线段压成一行
    setNow(T0 + 2 * BRIEF_EVERY_MS + MIN);
    micro.data.books!['BTCUSDT'] = book('BTCUSDT', 84900, 2, 1, T0 + 2 * BRIEF_EVERY_MS + 30_000);
    micro.data.books!['ETHUSDT'] = book('ETHUSDT', 2676, 10, 10, T0 + 2 * BRIEF_EVERY_MS + 30_000);
    deps.context = async (_s, at) => { const x = ctxStub(at); x.majors['ETHUSDT']!.oi!.chg_4h_pct = 0.4; return x; };
    const q = (await marketBriefChannel.tick(deps))!;
    expect(q.text.split('\n')[1]).toMatch(/^Quiet 4h since the 09-25 20:00 UTC brief: BTC \+0\.07%, ETH \+0\.04%; open interest over 4h BTC -0\.5%, ETH \+0\.4%; daily regimes unchanged\./);
    expect(q.text).toContain('— Daily regime (daily candles as of 09-24, same as the 09-25 20:00 UTC brief): BTC bullish (20d +5.2%, ATR 2.34%) · ETH bullish (20d +5.2%, ATR 2.34%)\n');
    englishBody(q.text);
    // 欢迎包给同一份的完整版(不写「unchanged」)
    const w = await marketBriefChannel.welcome(deps);
    expect(w.event_id).toBe(q.event_id);
    expect(w.text).not.toContain('same scan as');
    expect(w.text).not.toContain('same as the');
    expect(w.text).toContain('1. SOLUSDT · Multi-timeframe alignment');
    // 欢迎包标题写生成时刻(00:01),不冒充槽起点
    expect(w.text.split('\n')[0]).toBe('Market Brief · 2026-09-26 00:01 UTC (period 00:00–04:00 UTC)');
    englishBody(w.text);
  });

  it('welcome:45 分钟内复用最近一份,超过就现算(同槽 id 不变);现算的会被同槽 tick 复用', async () => {
    const { deps, calls, setNow } = mkDeps();
    const a = (await marketBriefChannel.tick(deps))!; // 16:05 生成
    setNow(T0 + 5 * MIN + 45 * MIN);
    const w1 = await marketBriefChannel.welcome(deps);
    expect(w1.event_id).toBe(a.event_id);
    expect(calls.regime).toBe(2);
    setNow(T0 + 5 * MIN + 46 * MIN);
    const w2 = await marketBriefChannel.welcome(deps);
    expect(w2.event_id).toBe(`brief:${T0}`);
    expect(calls.regime).toBe(4);
    expect(w2.text.split('\n')[0]).toBe('Market Brief · 2026-09-25 16:51 UTC (period 16:00–20:00 UTC)');
    setNow(T0 + 55 * MIN);
    const t = (await marketBriefChannel.tick(deps))!;
    expect(t.event_id).toBe(w2.event_id);
    expect(t.text).toBe(w2.text);
    expect(calls.regime).toBe(4);
  });

  it('旧版状态(30 分钟一份、无 ref;或改英文前的中文版)不认,照常现算', async () => {
    const { deps } = mkDeps();
    deps.state.set('brief:last', JSON.stringify({ push: { event_id: `brief:${T0}`, text: 'old' }, generated_at: T0, slot: T0 }));
    const p = (await marketBriefChannel.tick(deps))!;
    expect(p.text).not.toBe('old');
    expect(p.text.split('\n')[1]).toMatch(/^Daily regime: BTC ranging/);
    // 同一槽里存着改英文前的中文版(有 ref/full/push 但没有 lang)→ 不回放,重算英文
    const zh = mkDeps();
    const stored = JSON.parse(deps.state.get('brief:last')!) as Record<string, unknown>;
    const zhPush = { ...(stored['push'] as object), text: '【行情简报 / Market Brief】 旧中文' };
    zh.deps.state.set('brief:last', JSON.stringify({ ...stored, lang: undefined, push: zhPush, full: zhPush }));
    const t = (await marketBriefChannel.tick(zh.deps))!;
    const w = await marketBriefChannel.welcome(zh.deps);
    for (const x of [t, w]) { expect(x.text).not.toMatch(CJK); expect(x.text.split('\n')[0]).toMatch(/^Market Brief · /); }
  });

  it('没有任何历史时 welcome 现算,内容非空', async () => {
    const { deps } = mkDeps();
    const w = await marketBriefChannel.welcome(deps);
    expect(w.event_id).toBe(`brief:${T0}`);
    expect(w.text.length).toBeGreaterThan(200);
  });

  it('数据全缺:不抛错,每块写暂缺,仍然出一份', async () => {
    const { deps, logs } = mkDeps({
      regime: async () => { throw new Error('klines down'); },
      scan: () => ({ ready: false, screen_id: null, scanned: 0, errors: 0, at: null, note: '还没有每日全市场扫描', candidates: [] }),
      universe: () => null,
      micro: null,
      context: async () => { throw new Error('okx public down'); },
    });
    const p = (await marketBriefChannel.tick(deps))!;
    expect(p.text.split('\n')[0]).toContain('Market Brief · ');
    expect(p.text).toContain('BTC daily regime unavailable');
    expect(p.text).toContain('BTC price unavailable');
    expect(p.text).toContain('BTC unavailable');
    expect(p.text).toMatch(/Data unavailable: .*OKX universe snapshot.*BTC price.*BTC liquidations.*BTC daily regime.*BTC 4h context \(funding, open interest, range\).*daily scan.*funding rates/);
    expect(p.summary).toContain('BTC unavailable');
    expect(logs.some((l) => l.includes('klines down'))).toBe(true);
    englishBody(p.text);
    const w = await marketBriefChannel.welcome(deps);
    expect(w.text.length).toBeGreaterThan(100);
  });

  it('单块超时只降级那一块;录制器覆盖不足 30 分钟写暂缺而不是 0,只覆盖一部分窗口时标注覆盖时长', async () => {
    const { deps, micro } = mkDeps({ scan: () => new Promise<UniverseScanSummary>(() => {}), brief_config: { block_timeout_ms: 30 } });
    micro.data.coverage!['ETHUSDT'] = { from_ms: T0, to_ms: T0 + 4 * MIN }; // 只录了 5 分钟
    micro.data.coverage!['BTCUSDT'] = { from_ms: T0 - HOUR, to_ms: T0 + 4 * MIN }; // 只录了 65 分钟
    micro.data.books!['ETHUSDT'] = null;
    const p = (await marketBriefChannel.tick(deps))!;
    expect(p.text).toMatch(/Daily scan leaders \(OKX USDT perps, market-wide, updated daily\)\nUnavailable/);
    expect(p.text).toContain('ETH unavailable');
    expect(p.text).not.toMatch(/ETH longs/);
    expect(p.text).toContain('BTC longs $300K / shorts $200K (2 liquidations; recorder covers only the last 1.1h)');
    expect(p.text).toContain('Highest: DOGE');
    // 录制器停了(最新一帧超过 5 分钟)→ 暂缺
    micro.data.coverage!['BTCUSDT'] = { from_ms: T0 - 10 * HOUR, to_ms: T0 - 20 * MIN };
    const f = await collectBriefFacts(deps, T0 + 5 * MIN);
    expect(f.liquidations['BTCUSDT']).toBeNull();
  });

  it('summarize 钩子:正常英文人话采用(免责声明换 AI 版);含指令词/推荐语气/中文、抛错、返回 null 都退回模板', async () => {
    const ok = mkDeps({ summarize: async (f) => `BTC is ranging while ETH holds firmer; ${f.scan?.top.length} names lead the daily scan.` });
    const okp = (await marketBriefChannel.tick(ok.deps))!;
    expect(okp.text.split('\n')[1]).toBe('BTC is ranging while ETH holds firmer; 3 names lead the daily scan.');
    expect(okp.text).toContain(DISCLAIMER_AI);

    const tpl = templateSummary(await collectBriefFacts(mkDeps().deps, T0 + 5 * MIN));
    for (const summarize of [
      async () => 'We recommend buying BTC on dips', async () => 'BTC is the top pick today', async () => 'Consider a long entry on ETH',
      async () => 'BTC 震荡,ETH 偏强。', async () => { throw new Error('model down'); }, async () => null, async () => 'guaranteed upside',
    ]) {
      const d = mkDeps({ summarize });
      const p = (await marketBriefChannel.tick(d.deps))!;
      expect(p.text.split('\n')[1]).toBe(tpl);
      expect(p.text).toContain(DISCLAIMER);
      expect(p.text).not.toMatch(CJK);
    }
    expect(tpl).toContain('Daily regime: BTC ranging, ETH bullish');
  });

  it('BANNED_WORDS:数据源里混进红线词 → 抛错不推', async () => {
    const { deps } = mkDeps({ scan: () => ({ ...SCAN, candidates: [{ ...SCAN.candidates[0]!, reasons: ['guaranteed breakout structure'] }] }) });
    await expect(marketBriefChannel.tick(deps)).rejects.toThrow('market_brief_banned_words');
    expect(() => channelPush('market_brief', 'x', 't', 'risk-free setup', [], {})).toThrow('market_brief_banned_words');
    expect(() => channelPush('market_brief', 'x', 't', 'ok', [], { note: '稳赚' })).toThrow('market_brief_banned_words');
  });

  it('超长时从末尾砍要点行,不超过 MAX_TEXT', () => {
    const p = channelPush('market_brief', 'x', 'Title', 'Summary', Array.from({ length: 200 }, (_, i) => `Line ${i} ${'x'.repeat(30)}`), {});
    expect(p.text.length).toBeLessThanOrEqual(3500);
    expect(p.text).toContain('(Truncated; the rest is in the structured data.)');
    expect(p.text).toContain(DISCLAIMER);
  });

  it('scrubInstructions:含指令 / 推荐语气的分句整段删掉(中英文都管)', () => {
    expect(scrubInstructions('首选。空头顺势。结构同 SNDK 可并列盯。带宽高位')).toBe('带宽高位');
    expect(scrubInstructions('日线高波动,中短线假突破多,先不做')).toBe('日线高波动,中短线假突破多');
    expect(scrubInstructions('日线空头,现货只能做多')).toBe('日线空头');
    expect(scrubInstructions('建议关注')).toBe('');
    expect(scrubInstructions('契合 0.86(6/7 条通过)')).toBe('契合 0.86(6/7 条通过)');
    expect(ADVICE_WORDS.test('可盯')).toBe(true);
    // 英文:按 . ; , ! ? + 空白切,小数不切
    expect(scrubInstructions('Top pick. Trend is intact. Worth watching. Bandwidth at 0.86 of range')).toBe('Trend is intact. Bandwidth at 0.86 of range');
    expect(scrubInstructions('We recommend it. Volume expanding')).toBe('Volume expanding');
    expect(scrubInstructions('Consider a long entry, momentum strong')).toBe('momentum strong');
    expect(scrubInstructions('Great opportunity; should rally')).toBe('');
    expect(scrubInstructions('Checklist 6/7 met, OKX perp')).toBe('Checklist 6/7 met, OKX perp');
    for (const w of ['recommend', 'should', 'top pick', 'opportunity', 'worth it', 'consider', 'buy the dip']) expect(ADVICE_WORDS.test(w) || INSTRUCTION_WORDS.test(w)).toBe(true);
    for (const w of ['buy', 'sell', 'go long', 'go short', 'entry', 'stop-loss', 'take-profit', 'open a long', 'close the position']) expect(INSTRUCTION_WORDS.test(w)).toBe(true);
    for (const w of ['Short-term tier', 'longs $300K / shorts $200K', 'bid-heavy', 'Long-term breakout retest']) { expect(INSTRUCTION_WORDS.test(w)).toBe(false); expect(ADVICE_WORDS.test(w)).toBe(false); }
  });

  it('utcLabel / asOfLabel', () => {
    expect(utcLabel(T0)).toBe('2026-09-25 16:00 UTC');
    expect(asOfLabel(T0 - 14 * HOUR, T0)).toBe('02:00 UTC');
    expect(asOfLabel(T0 - 20 * HOUR, T0)).toBe('09-24 20:00 UTC');
  });
});

describe('market_brief 4 小时背景(OKX 公共接口)', () => {
  it('资金费率折算:每 8h 与年化按结算周期换算;周期未知不折算', () => {
    expect(fundingPer8h({ rate: 0.0003, interval_h: 1 })).toBeCloseTo(0.0024, 10);
    expect(fundingPer8h({ rate: 0.0001, interval_h: 8 })).toBeCloseTo(0.0001, 10);
    expect(fundingPer8h({ rate: 0.0001, interval_h: null })).toBeNull();
    expect(fundingAnnualized({ rate: 0.0001, interval_h: 8 })).toBeCloseTo(0.1095, 6);
    expect(fundingAnnualized({ rate: 0.0001, interval_h: 4 })).toBeCloseTo(0.219, 6);
    expect(fundingFromRaw({ fundingRate: '-0.0059', fundingTime: String(T0), nextFundingTime: String(T0 + 4 * HOUR) })).toEqual({ rate: -0.0059, interval_h: 4, next_at: T0 });
    expect(fundingFromRaw({ fundingRate: '' })).toBeNull();
  });

  it('持仓量 4h/24h 变化、15m K 线区间:按时间对齐取参考点;覆盖不够不给 24h', () => {
    const rows: [number, number][] = Array.from({ length: 26 }, (_, i) => [T0 - i * HOUR, 1000 + i * 10]); // 新→旧,越早越大
    const oi = oiFromRows(rows, { usd: 990, at: T0 + 10 * MIN }, 'usdt_perp')!;
    expect(oi.usd).toBe(990);
    expect(oi.chg_4h_pct).toBeCloseTo((990 / 1040 - 1) * 100, 6); // T0+10m-4h → 取 T0-4h 那行
    expect(oi.chg_24h_pct).toBeCloseTo((990 / 1240 - 1) * 100, 6);
    const now = T0;
    const candles = Array.from({ length: 96 }, (_, i) => { const ts = now - (i + 1) * 15 * MIN; const o = 100 + i; return [String(ts), String(o), String(o + 2), String(o - 2), String(o - 0.5)]; });
    const r = rangeFromCandles(candles, now)!;
    expect(r.last).toBe(99.5); // 最新一根 close
    expect(r.hi_4h).toBe(117); // 近 16 根:i=0..15,最高 115+2
    expect(r.lo_4h).toBe(98);
    expect(r.chg_4h_pct).toBeCloseTo((99.5 / 115 - 1) * 100, 6);
    expect(r.chg_24h_pct).toBeCloseTo((99.5 / 195 - 1) * 100, 6);
    expect(rangeFromCandles(candles.slice(0, 20), now)!.chg_24h_pct).toBeNull();
  });

  it('okxBriefContext:一次全市场资金费率 + 每币三次;持仓历史挂了退到全合约持仓;全市场费率挂了退到单币费率', async () => {
    const paths: string[] = [];
    const get = (async (path: string) => {
      paths.push(path);
      if (path.includes('instId=ANY')) throw new Error('ANY down');
      if (path.includes('funding-rate?instId=BTC')) return [{ instId: 'BTC-USDT-SWAP', fundingRate: '0.0001', fundingTime: String(T0 + HOUR), nextFundingTime: String(T0 + 9 * HOUR) }];
      if (path.includes('funding-rate?instId=ETH')) return [];
      if (path.includes('open-interest?')) return [{ oiUsd: '2000', ts: String(T0) }];
      if (path.includes('open-interest-history') && path.includes('ETH')) throw new Error('hist down');
      if (path.includes('open-interest-history')) return [[String(T0 - HOUR), '1', '1', '1900'], [String(T0 - 5 * HOUR), '1', '1', '1600']];
      if (path.includes('open-interest-volume')) return [[String(T0 - HOUR), '500', '9'], [String(T0 - 5 * HOUR), '400', '9']];
      if (path.includes('candles')) return [[String(T0 - 15 * MIN), '10', '11', '9', '10.5']];
      throw new Error(`unexpected ${path}`);
    }) as <T>(p: string) => Promise<T>;
    const c = await okxBriefContext(['BTCUSDT', 'ETHUSDT'], T0, get);
    expect(c.funding).toBeNull();
    expect(c.majors['BTCUSDT']!.funding).toEqual({ rate: 0.0001, interval_h: 8, next_at: T0 + HOUR });
    expect(c.majors['ETHUSDT']!.funding).toBeNull();
    expect(c.majors['BTCUSDT']!.oi).toMatchObject({ usd: 2000, scope: 'usdt_perp', chg_4h_pct: 25 });
    expect(c.majors['ETHUSDT']!.oi).toMatchObject({ usd: 500, scope: 'all_contracts', chg_4h_pct: 25 });
    expect(c.majors['BTCUSDT']!.range).toMatchObject({ last: 10.5, hi_4h: 11, lo_4h: 9 });
    expect(paths.filter((p) => p.includes('open-interest-volume?ccy=ETH'))).toHaveLength(1);
    expect(paths.some((p) => p.includes('open-interest-volume?ccy=BTC'))).toBe(false);
  });

  it('全市场费率取不到:日快照单期费率按缓存的结算周期折算;周期不认识的币不列', async () => {
    const { deps } = mkDeps();
    await marketBriefChannel.tick(deps); // 实时路径把结算周期写进缓存
    expect(JSON.parse(deps.state.get('brief:funding_intervals')!)).toMatchObject({ DOGEUSDT: 4, ADAUSDT: 1, SOLUSDT: 8 });
    const d2 = mkDeps({ context: async () => ({ at: T0, majors: {}, funding: null }) });
    d2.deps.state.set('brief:funding_intervals', deps.state.get('brief:funding_intervals')!);
    const p = (await marketBriefChannel.tick(d2.deps))!;
    expect(p.text).toContain('all rates normalized to per-8h; daily snapshot as of 16:00 UTC)');
    expect(p.text).toContain('Highest: DOGE +0.160%/8h (4h cycle) · XRP +0.040%/8h · BTC +0.010%/8h');
    expect(p.text).toContain('Lowest: ADA -0.240%/8h (1h cycle) · SOL -0.120%/8h · ETH +0.010%/8h');
    // 没有缓存也没有实时:资金费率极值写暂缺,不输出未折算的数
    const d3 = mkDeps({ context: null });
    const q = (await marketBriefChannel.tick(d3.deps))!;
    expect(q.text).toMatch(/Funding rate extremes \([^)]*\)\nUnavailable/);
    expect(q.text).toContain('BTC 4h context (funding, open interest, range)');
  });

  it('改版前(没有 v2 标记)同一槽的英文状态不回放,重算新格式', async () => {
    const { deps } = mkDeps();
    await marketBriefChannel.tick(deps);
    const stored = JSON.parse(deps.state.get('brief:last')!) as Record<string, unknown>;
    const old = { ...(stored['push'] as object), text: 'Market Brief · old v1' };
    deps.state.set('brief:last', JSON.stringify({ ...stored, v: undefined, push: old, full: old }));
    const p = (await marketBriefChannel.tick(deps))!;
    expect(p.text).not.toContain('old v1');
    expect(p.signal).toMatch(/^【Futures】/);
  });
});
