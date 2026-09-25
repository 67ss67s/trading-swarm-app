// 订阅频道 market_brief(src/demo/asp-agent/services/market-brief.ts):全部注入,零网络、零模型。
import { describe, expect, it } from 'vitest';
import { BRIEF_EVERY_MS, INSTRUCTION_WORDS, collectBriefFacts, channelPush, marketBriefChannel, templateSummary, utcLabel, type BriefDeps } from '../../src/demo/asp-agent/services/market-brief.js';
import { memoryMicroSource, type MicroBook, type MicroLiq } from '../../src/demo/asp-agent/services/micro-source.js';
import type { ChannelDeps } from '../../src/demo/asp-agent/services/types.js';
import { BANNED_WORDS } from '../../src/demo/asp-agent/publisher.js';
import type { DailyRegime } from '../../src/demo/types.js';
import type { UniverseAsset, UniverseScanSummary } from '../../src/demo/universe-okx.js';

const T0 = Date.UTC(2026, 8, 25, 14, 30, 0); // 槽起点
const MIN = 60_000;

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
  ready: true, screen_id: 'scr_1', scanned: 280, errors: 0, at: T0 - 14 * 3_600_000, note: null,
  candidates: [
    { symbol: 'SOLUSDT', score: 82.4, reasons: ['日线多头排列', '成交额放大'], strategy_id: 's1', rank: 1 },
    { symbol: 'AVAXUSDT', score: 77.1, reasons: ['突破 20 日高点'], strategy_id: 's2', rank: 2 },
  ],
};

function book(symbol: string, mid: number, bidQty = 1, askQty = 1): MicroBook {
  const step = mid * 0.00001;
  return { symbol, inst_id: `${symbol.replace('USDT', '')}-USDT-SWAP`, at: T0 - 20_000,
    bids: Array.from({ length: 50 }, (_, i) => [mid - step / 2 - i * step, bidQty] as const),
    asks: Array.from({ length: 50 }, (_, i) => [mid + step / 2 + i * step, askQty] as const) };
}
const liq = (at: number, side: 'long' | 'short', usdAmt: number): MicroLiq => ({ id: `${at}:${side}:${usdAmt}`, at, side, price: 84000, qty: usdAmt / 84000, notional_usd: usdAmt });

function memState() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); }, map: m };
}

function mkDeps(over: Partial<BriefDeps> = {}, now = T0 + 5 * MIN) {
  const calls = { regime: 0, scan: 0, universe: 0 };
  const logs: string[] = [];
  let clock = now;
  const micro = memoryMicroSource({
    books: { BTCUSDT: book('BTCUSDT', 84000, 2, 1), ETHUSDT: book('ETHUSDT', 2675, 10, 10) },
    liqs: { BTCUSDT: [liq(T0 - 10 * MIN, 'long', 300_000), liq(T0 - 60 * MIN, 'long', 999_999)], ETHUSDT: [liq(T0, 'short', 50_000)] },
    coverage: { BTCUSDT: { from_ms: T0 - 10 * 3_600_000, to_ms: T0 + 4 * MIN }, ETHUSDT: { from_ms: T0 - 10 * 3_600_000, to_ms: T0 + 4 * MIN } },
  });
  const deps: ChannelDeps & BriefDeps = {
    now: () => clock,
    state: memState(),
    log: (_l, msg) => { logs.push(msg); },
    regime: async (s) => { calls.regime++; return s === 'BTCUSDT' ? regime('range', 1.2, -0.4) : regime('bull'); },
    scan: () => { calls.scan++; return SCAN; },
    universe: () => { calls.universe++; return { updated_at: T0, items: UNIVERSE }; },
    micro,
    ...over,
  };
  return { deps, calls, logs, micro, setNow: (t: number) => { clock = t; } };
}

describe('market_brief 频道', () => {
  it('第一行中英双语标题 + 要点齐全,不含指令词与红线词', async () => {
    const { deps } = mkDeps();
    const p = (await marketBriefChannel.tick(deps))!;
    expect(p.channel).toBe('market_brief');
    expect(p.event_id).toBe(`brief:${T0}`);
    expect(p.text.split('\n')[0]).toBe('【行情简报 / Market Brief】 2026-09-25 14:30 UTC');
    expect(p.text).toContain('BTC 84000.5(24h -0.82%) · 震荡 range · 20日 +1.2% · 5日 -0.4% · ATR 2.34%');
    expect(p.text).toContain('ETH 2675.3(24h +1.23%) · 多头 bull · 20日 +5.2%');
    expect(p.text).toContain('1. SOLUSDT 分 82.4 — 日线多头排列;成交额放大');
    // 资金费率:只看未排除且成交额够的;最高 DOGE,最低 SOL
    expect(p.text).toContain('最高 / Highest: DOGE +0.080% · XRP +0.040% · BTC +0.010%');
    expect(p.text).toContain('最低 / Lowest: SOL -0.120% · ADA -0.030%');
    expect(p.text).not.toContain('JUNK');
    expect(p.text).not.toMatch(/USDC -/);
    // 盘口:BTC 买 2 卖 1 → 失衡 +0.33;清算只算近 30 分钟
    expect(p.text).toMatch(/BTC 中间价 84000\.0 · 价差 0\.10bp · 深度\(可见 ±0\.05%\) 买 \$8\.40M \/ 卖 \$4\.20M · 失衡 \+0\.33/);
    expect(p.text).toContain('BTC 多头被强平 $300K / 空头被强平 $0(1 笔)');
    expect(p.text).toContain('ETH 多头被强平 $0 / 空头被强平 $50K(1 笔)');
    expect(p.text).not.toContain('Missing');
    expect(BANNED_WORDS.test(p.text)).toBe(false);
    expect(INSTRUCTION_WORDS.test(p.text.split('\n{')[0]!)).toBe(false);
    expect(p.payload['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(p.text).toContain(`sha256: ${p.payload['sha256']}`);
    expect(p.text.length).toBeLessThanOrEqual(3500);
  });

  it('同一 30 分钟槽重复 tick:同 event_id 同内容,不重新取数;下一槽出新 id', async () => {
    const { deps, calls, setNow } = mkDeps();
    const a = (await marketBriefChannel.tick(deps))!;
    setNow(T0 + 29 * MIN);
    const b = (await marketBriefChannel.tick(deps))!;
    expect(b.event_id).toBe(a.event_id);
    expect(b.text).toBe(a.text);
    expect(calls.regime).toBe(2);
    setNow(T0 + BRIEF_EVERY_MS + 1);
    const c = (await marketBriefChannel.tick(deps))!;
    expect(c.event_id).toBe(`brief:${T0 + BRIEF_EVERY_MS}`);
    expect(calls.regime).toBe(4);
    expect(marketBriefChannel.every_ms).toBe(30 * MIN);
  });

  it('welcome:45 分钟内复用最近一份,超过就现算;现算的会被同槽 tick 复用', async () => {
    const { deps, calls, setNow } = mkDeps();
    const a = (await marketBriefChannel.tick(deps))!; // 14:35 生成
    setNow(T0 + 5 * MIN + 45 * MIN); // 15:20,刚好 45 分钟
    const w1 = await marketBriefChannel.welcome(deps);
    expect(w1.event_id).toBe(a.event_id);
    expect(calls.regime).toBe(2);
    setNow(T0 + 5 * MIN + 46 * MIN); // 15:21
    const w2 = await marketBriefChannel.welcome(deps);
    expect(w2.event_id).toBe(`brief:${T0 + 30 * MIN}`);
    expect(calls.regime).toBe(4);
    setNow(T0 + 55 * MIN);
    const t = (await marketBriefChannel.tick(deps))!;
    expect(t.event_id).toBe(w2.event_id);
    expect(t.text).toBe(w2.text);
    expect(calls.regime).toBe(4);
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
    });
    const p = (await marketBriefChannel.tick(deps))!;
    expect(p.text.split('\n')[0]).toContain('【行情简报 / Market Brief】');
    expect(p.text).toContain('BTC · 日线状态暂缺');
    expect(p.text).toContain('BTC 暂缺 / n/a');
    expect(p.text).toMatch(/数据暂缺 \/ Missing: .*regime:BTCUSDT.*scan.*funding.*book:BTCUSDT/);
    expect(p.summary).toContain('BTC 日线状态暂缺');
    expect(logs.some((l) => l.includes('klines down'))).toBe(true);
    const w = await marketBriefChannel.welcome(deps);
    expect(w.text.length).toBeGreaterThan(100);
  });

  it('单块超时/抛错只降级那一块;录制器覆盖不到 30 分钟窗口时清算写暂缺而不是 0', async () => {
    const { deps, micro } = mkDeps({ scan: () => new Promise<UniverseScanSummary>(() => {}), brief_config: { block_timeout_ms: 30 } });
    micro.data.coverage!['ETHUSDT'] = { from_ms: T0, to_ms: T0 + 4 * MIN }; // 只录了 5 分钟
    micro.data.books!['ETHUSDT'] = null;
    const p = (await marketBriefChannel.tick(deps))!;
    expect(p.text).toMatch(/Scan leaders\n暂缺/);
    expect(p.text).toContain('ETH 暂缺 / n/a');
    expect(p.text).not.toMatch(/ETH 多头被强平/);
    expect(p.text).toContain('BTC 多头被强平 $300K');
    expect(p.text).toContain('最高 / Highest: DOGE');
  });

  it('summarize 钩子:正常人话采用;含指令词、抛错、返回 null 都退回模板', async () => {
    const ok = mkDeps({ summarize: async (f) => `BTC 震荡,ETH 偏强;扫描 ${f.scan?.top.length} 个靠前。` });
    expect((await marketBriefChannel.tick(ok.deps))!.text.split('\n')[1]).toBe('BTC 震荡,ETH 偏强;扫描 2 个靠前。');

    const tpl = templateSummary(await collectBriefFacts(mkDeps().deps, T0 + 5 * MIN));
    for (const summarize of [async () => '建议逢低买入 BTC', async () => { throw new Error('model down'); }, async () => null, async () => '稳赚不赔']) {
      const d = mkDeps({ summarize });
      const line = (await marketBriefChannel.tick(d.deps))!.text.split('\n')[1];
      expect(line).toBe(tpl);
    }
    expect(tpl).toContain('BTC 日线震荡、ETH 日线多头');
    expect(tpl).toContain('资金费率最高 DOGE +0.080%,最低 SOL -0.120%');
  });

  it('BANNED_WORDS:数据源里混进红线词 → 抛错不推', async () => {
    const { deps } = mkDeps({ scan: () => ({ ...SCAN, candidates: [{ ...SCAN.candidates[0]!, reasons: ['保本型机会'] }] }) });
    await expect(marketBriefChannel.tick(deps)).rejects.toThrow('market_brief_banned_words');
    expect(() => channelPush('market_brief', 'x', 't', 'risk-free 机会', [], {})).toThrow('market_brief_banned_words');
  });

  it('utcLabel', () => {
    expect(utcLabel(T0)).toBe('2026-09-25 14:30 UTC');
  });
});
