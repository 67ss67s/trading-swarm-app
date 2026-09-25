// 订阅频道 micro_alerts + 微观结构数据源(src/demo/asp-agent/services/{micro-alerts,micro-source}.ts)。
// 频道用内存假数据源;录制器实现用临时目录里的 gzip jsonl(格式同 ~/.trading-swarm-okx/micro/recorder.mjs),零网络。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MICRO_ALERT_DEFAULTS, bucketOf, microAlertsChannel, type MicroDeps } from '../../src/demo/asp-agent/services/micro-alerts.js';
import { bookStats, memoryMicroSource, recorderMicroSource, sumLiquidations, usd, type MicroBook, type MicroLiq } from '../../src/demo/asp-agent/services/micro-source.js';
import { INSTRUCTION_WORDS, channelPush } from '../../src/demo/asp-agent/services/market-brief.js';
import type { ChannelDeps, ChannelPush } from '../../src/demo/asp-agent/services/types.js';
import { BANNED_WORDS } from '../../src/demo/asp-agent/publisher.js';
import { calculateMicrostructure } from '../../src/demo/research/judge/microstructure.js';

const T = Date.UTC(2026, 8, 25, 12, 0, 0);
const MIN = 60_000, HOUR = 3_600_000;
const COOL = MICRO_ALERT_DEFAULTS.cooldown_ms;

/** 200 档、步长 0.1 的盘口;数量为基础币 */
function book(symbol: string, o: { mid?: number; bid?: number; ask?: number; at?: number; bump?: { side: 'bid' | 'ask'; i: number; qty: number } } = {}): MicroBook {
  const mid = o.mid ?? 84000;
  const bids = Array.from({ length: 200 }, (_, i) => [mid - 0.05 - i * 0.1, o.bid ?? 0.5] as [number, number]);
  const asks = Array.from({ length: 200 }, (_, i) => [mid + 0.05 + i * 0.1, o.ask ?? 0.5] as [number, number]);
  if (o.bump) (o.bump.side === 'bid' ? bids : asks)[o.bump.i]![1] = o.bump.qty;
  return { symbol, inst_id: `${symbol.replace('USDT', '')}-USDT-SWAP`, at: o.at ?? T - 30_000, bids, asks };
}
const liq = (at: number, side: 'long' | 'short', amt: number): MicroLiq => ({ id: `${at}:${side}:${amt}`, at, side, price: 84000, qty: amt / 84000, notional_usd: amt });
/** 近 6h 每 30 分钟一笔 $20K 的基线(每 15 分钟均值 $10K) */
const baseline = (now: number): MicroLiq[] => Array.from({ length: 12 }, (_, i) => liq(now - 20 * MIN - i * 30 * MIN, i % 2 ? 'short' : 'long', 20_000));

function memState() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); }, map: m };
}
function mkDeps(o: { books?: Record<string, MicroBook | null>; liqs?: Record<string, MicroLiq[]>; covFrom?: number; config?: MicroDeps['micro_config']; now?: number } = {}) {
  let clock = o.now ?? T;
  const data = {
    books: o.books ?? { BTCUSDT: book('BTCUSDT'), ETHUSDT: book('ETHUSDT', { mid: 2675 }) },
    liqs: o.liqs ?? { BTCUSDT: baseline(clock), ETHUSDT: [] },
    coverage: {
      BTCUSDT: { from_ms: o.covFrom ?? clock - 7 * HOUR, to_ms: clock - 30_000 },
      ETHUSDT: { from_ms: o.covFrom ?? clock - 7 * HOUR, to_ms: clock - 30_000 },
    } as Record<string, { from_ms: number; to_ms: number } | null>,
  };
  const micro = memoryMicroSource(data);
  const logs: string[] = [];
  const deps: ChannelDeps & MicroDeps = { now: () => clock, state: memState(), log: (_l, m) => { logs.push(m); }, micro, ...(o.config ? { micro_config: o.config } : {}) };
  return { deps, micro, logs, setNow: (t: number) => { clock = t; } };
}
function clean(p: ChannelPush): void {
  expect(BANNED_WORDS.test(p.text)).toBe(false);
  expect(INSTRUCTION_WORDS.test(p.text.split('\n{')[0]!)).toBe(false);
  expect(p.text.length).toBeLessThanOrEqual(3500);
  expect(p.payload['sha256']).toMatch(/^[0-9a-f]{64}$/);
}

describe('micro-source 特征', () => {
  it('bookStats 与 research/judge 的 calculateMicrostructure 口径一致(±0.5% 失衡、价差、单档墙)', () => {
    const b = book('BTCUSDT', { bid: 1.3, ask: 0.7, bump: { side: 'ask', i: 7, qty: 9 } });
    const s = bookStats(b)!;
    const ref = calculateMicrostructure({ symbol: 'BTCUSDT', liquidations: [], liquidation_coverage: null,
      book: { at: b.at, available_at: b.at, bids: b.bids.map(([p, q]) => [p.toFixed(2), String(q)] as const), asks: b.asks.map(([p, q]) => [p.toFixed(2), String(q)] as const) } }, b.at);
    expect(s.imbalance).toBeCloseTo(ref.ob_imbalance_05!, 9);
    expect(s.spread_bps).toBeCloseTo(ref.spread_bps!, 9);
    expect(s.wall_ask!.price).toBeCloseTo(Number(ref.ob_wall_up!.price), 6);
    expect(s.wall_ask!.notional_usd).toBeCloseTo(Number(ref.ob_wall_up!.notional), 2);
    expect(s.visible_pct).toBeCloseTo(19.95 / 84000, 9);
  });

  it('sumLiquidations / usd', () => {
    const s = sumLiquidations([liq(1, 'long', 1_500_000), liq(2, 'short', 20_000)]);
    expect(s).toMatchObject({ long_usd: 1_500_000, short_usd: 20_000, total_usd: 1_520_000, count: 2 });
    expect(s.largest!.at).toBe(1);
    expect([usd(1_520_000), usd(20_000), usd(12), usd(null)]).toEqual(['$1.52M', '$20K', '$12', '—']);
  });
});

describe('recorderMicroSource(读录制器文件)', () => {
  let dir = '';
  const bookLine = (ts: number, bidPx: string, sz: string) => JSON.stringify({ at: ts - 5_000, ts, bids: [[bidPx, sz, '0', '3'], ['83999.9', '100']], asks: [['84000.1', sz], ['84000.2', '100']] });
  const liqLine = (ts: number, posSide: string, sz: string) => JSON.stringify({ at: ts + 3_000, inst: 'BTC-USDT-SWAP', ts, side: posSide === 'long' ? 'sell' : 'buy', posSide, px: '84000', sz });
  const gz = (name: string, lines: string[], tail = '') => writeFileSync(join(dir, name), gzipSync(Buffer.from(lines.join('\n') + '\n' + tail)));
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'micro-src-'));
    gz('book-BTC-USDT-SWAP-2026-09-25.111.jsonl.gz', [bookLine(T - 120_000, '84000', '10'), bookLine(T - 60_000, '84000', '20')], '{"at":1,"ts":'); // 半行尾巴
    gz('book-BTC-USDT-SWAP-2026-09-25.222.jsonl.gz', [bookLine(T - 30_000, '84000', '50')]);
    gz('book-BTC-USDT-SWAP-2026-09-22.999.jsonl.gz', [bookLine(T + 1, '1', '1')]); // 三天前的文件不读
    gz('liq-BTC-USDT-SWAP-2026-09-24.111.jsonl.gz', [liqLine(T - 13 * HOUR, 'long', '100')]);
    gz('liq-BTC-USDT-SWAP-2026-09-25.111.jsonl.gz', [liqLine(T - 10 * MIN, 'long', '100'), liqLine(T - 5 * MIN, 'short', '50'), liqLine(T - 4 * MIN, 'net', '999')]);
    gz('liq-BTC-USDT-SWAP-2026-09-25.222.jsonl.gz', [liqLine(T - 5 * MIN, 'short', '50')]); // 重启后重复拉到的同一笔
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('最新盘口取所有 pid 文件里 ts 最大的一帧,张数按 ctVal 换算成基础币', async () => {
    const src = recorderMicroSource({ directory: dir });
    expect(src.symbols()).toEqual(['BTCUSDT', 'ETHUSDT']);
    const b = (await src.book('BTCUSDT', T))!;
    expect(b.at).toBe(T - 30_000);
    expect(b.bids[0]).toEqual([84000, 0.5]);
    expect(b.asks[1]).toEqual([84000.2, 1]);
    expect(await src.coverage('BTCUSDT', T)).toEqual({ from_ms: T - 120_000, to_ms: T - 30_000 });
    // 过旧 → null;不支持的 symbol / 没文件 → null
    expect(await src.book('BTCUSDT', T + 10 * MIN)).toBeNull();
    expect(await src.book('ETHUSDT', T)).toBeNull();
    expect(await src.coverage('ETHUSDT', T)).toBeNull();
    expect(await src.book('SOLUSDT', T)).toBeNull();
    // 本机时钟落后交易所几十秒也要能用
    expect((await src.book('BTCUSDT', T - 60_000))?.at).toBe(T - 30_000);
  });

  it('清算:跨文件去重、过滤非 long/short、按窗口取,金额 = px × 张 × ctVal', async () => {
    const src = recorderMicroSource({ directory: dir });
    const rows = await src.liquidations('BTCUSDT', T - 30 * MIN, T);
    expect(rows.map((r) => [r.side, r.notional_usd])).toEqual([['long', 84_000], ['short', 42_000]]);
    expect((await src.liquidations('BTCUSDT', T - 14 * HOUR, T)).length).toBe(3);
    expect(await src.liquidations('BTCUSDT', T - 4 * MIN, T)).toEqual([]);
  });

  it('目录不存在不抛错', async () => {
    const src = recorderMicroSource({ directory: join(dir, 'nope') });
    expect(await src.book('BTCUSDT', T)).toBeNull();
    expect(await src.liquidations('BTCUSDT', 0, T)).toEqual([]);
  });
});

describe('micro_alerts 频道', () => {
  it('安静盘口:不推;第一次 tick 只起保活计时', async () => {
    const { deps } = mkDeps();
    expect(await microAlertsChannel.tick(deps)).toBeNull();
    expect(deps.state.get('micro:last_push_at')).toBe(String(T));
    expect(microAlertsChannel.every_ms).toBe(60_000);
  });

  it('清算放量:超过绝对下限且 ≥ 6 倍基线才触发', async () => {
    const liqs = { BTCUSDT: [...baseline(T), liq(T - 3 * MIN, 'long', 450_000), liq(T - 2 * MIN, 'short', 150_000)], ETHUSDT: [] };
    const { deps } = mkDeps({ liqs });
    const p = (await microAlertsChannel.tick(deps))!;
    expect(p.event_id).toBe(`micro:BTCUSDT:liq_surge:${bucketOf(T, COOL)}`);
    expect(p.text.split('\n')[0]).toBe('【微观结构告警 / Microstructure Alert】 BTC 清算放量 / Liquidation surge · 2026-09-25 12:00 UTC');
    expect(p.summary).toBe('BTC 近 15 分钟清算 $600K,多头被强平为主 / longs liquidated');
    expect(p.text).toContain('多头被强平 $450K · 空头被强平 $150K · 2 笔');
    expect(p.text).toContain('近 6h 同长度均值 $10K,当前约 60.0 倍');
    expect(p.text).toContain('当前盘口 / Book now: BTC 中间价 84000.0');
    expect(p.payload).toMatchObject({ kind: 'liq_surge', symbol: 'BTCUSDT' });
    clean(p);

    // 低于绝对下限 → 不触发
    const low = mkDeps({ liqs: { BTCUSDT: [...baseline(T), liq(T - 3 * MIN, 'long', 400_000)], ETHUSDT: [] } });
    await microAlertsChannel.tick(low.deps);
    expect(deps.state.get('micro:cd:BTCUSDT:liq_surge')).toBe(String(T));
    expect(low.deps.state.get('micro:cd:BTCUSDT:liq_surge')).toBeNull();
    // 基线本来就高(不到 6 倍)→ 不触发
    const busy = Array.from({ length: 24 }, (_, i) => liq(T - 20 * MIN - i * 15 * MIN, 'long', 200_000));
    const hot = mkDeps({ liqs: { BTCUSDT: [...busy, liq(T - 3 * MIN, 'long', 900_000)], ETHUSDT: [] } });
    expect(await microAlertsChannel.tick(hot.deps)).toBeNull();
  });

  it('录制器覆盖不足 1h 的基线、或录制器没新盘口(判不了活)→ 不判清算放量', async () => {
    const big = { BTCUSDT: [liq(T - 3 * MIN, 'long', 5_000_000)], ETHUSDT: [] };
    const short = mkDeps({ liqs: big, covFrom: T - 40 * MIN });
    expect(await microAlertsChannel.tick(short.deps)).toBeNull();
    const dead = mkDeps({ liqs: big, books: { BTCUSDT: null, ETHUSDT: null } });
    expect(await microAlertsChannel.tick(dead.deps)).toBeNull();
  });

  it('多个条件同时成立:一次推一条(按优先级),冷却 30 分钟,冷却后换新桶 id 再推', async () => {
    // 买盘 2.5 vs 卖盘 0.5:失衡 +0.67,同时买方 0.01% 聚合桶 $17.6M → 买墙
    const { deps, setNow } = mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 2.5 }), ETHUSDT: book('ETHUSDT', { mid: 2675 }) } });
    const a = (await microAlertsChannel.tick(deps))!;
    expect(a.event_id).toBe(`micro:BTCUSDT:imbalance:${bucketOf(T, COOL)}`);
    expect(a.summary).toBe('BTC 盘口买盘明显偏厚,失衡 +0.67(约 5.0:1)');
    clean(a);
    setNow(T + MIN);
    const b = (await microAlertsChannel.tick(deps))!;
    expect(b.event_id).toBe(`micro:BTCUSDT:wall_bid:${bucketOf(T + MIN, COOL)}`);
    expect(b.summary).toMatch(/^BTC 近价买墙 \$17\.64M @ 83999\.9/);
    expect(b.text).toContain('最大聚合档(0.01% 一桶)/ largest cluster: $17.64M');
    clean(b);
    setNow(T + 29 * MIN);
    expect(await microAlertsChannel.tick(deps)).toBeNull();
    setNow(T + 30 * MIN);
    const c = (await microAlertsChannel.tick(deps))!;
    expect(c.event_id).toBe(`micro:BTCUSDT:imbalance:${bucketOf(T + 30 * MIN, COOL)}`);
    expect(c.event_id).not.toBe(a.event_id);
  });

  it('近价单档大墙(卖方),阈值可被 micro_config 覆盖', async () => {
    const books = { BTCUSDT: book('BTCUSDT', { bump: { side: 'ask', i: 99, qty: 70 } }), ETHUSDT: book('ETHUSDT', { mid: 2675 }) };
    const p = (await microAlertsChannel.tick(mkDeps({ books }).deps))!;
    expect(p.event_id).toBe(`micro:BTCUSDT:wall_ask:${bucketOf(T, COOL)}`);
    expect(p.summary).toBe('BTC 近价卖墙 $5.88M @ 84009.9(距中间价 0.012%)');
    expect(p.text).toContain('最大单档 / largest level: $5.88M @ 84009.9 ▲');
    clean(p);
    // 调高阈值 → 不触发;调低聚合阈值 → ETH 也触发
    expect(await microAlertsChannel.tick(mkDeps({ books, config: { wall_level_usd: { default: 1e9, BTCUSDT: 1e9 }, wall_cluster_usd: { default: 1e9, BTCUSDT: 1e9 } } }).deps)).toBeNull();
    const low = (await microAlertsChannel.tick(mkDeps({ config: { wall_cluster_usd: { default: 1e9, ETHUSDT: 1_000 } } }).deps))!;
    expect(low.event_id).toMatch(/^micro:ETHUSDT:wall_bid:/);
    expect(MICRO_ALERT_DEFAULTS.wall_level_usd['BTCUSDT']).toBe(5_000_000); // 覆盖不改默认
  });

  it('聚合挂单墙(单档都不大,近价一段堆起来)', async () => {
    const p = (await microAlertsChannel.tick(mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 1.2 }), ETHUSDT: null } }).deps))!;
    expect(p.event_id).toMatch(/^micro:BTCUSDT:wall_bid:/);
    expect(p.text).toContain('largest cluster: $8.47M 起于 83999.9 ▲');
    expect(p.text).not.toContain('▲\n最大聚合'); // 单档没过线
  });

  it('保活:6 小时一条没推 → 静默期摘要(当前盘口 + 近 6h 清算),之后重新计时', async () => {
    const { deps, micro, setNow } = mkDeps();
    expect(await microAlertsChannel.tick(deps)).toBeNull(); // 起表
    micro.data.liqs = { BTCUSDT: [liq(T + HOUR, 'long', 120_000), liq(T + 2 * HOUR, 'short', 30_000), liq(T - HOUR, 'long', 9e6)], ETHUSDT: [] };
    setNow(T + 6 * HOUR - 1);
    expect(await microAlertsChannel.tick(deps)).toBeNull();
    setNow(T + 6 * HOUR);
    const q = (await microAlertsChannel.tick(deps))!;
    expect(q.event_id).toBe(`micro:ALL:quiet:${bucketOf(T + 6 * HOUR, 6 * HOUR)}`);
    expect(q.text.split('\n')[0]).toBe('【微观结构静默期摘要 / Microstructure Quiet-Period Summary】 2026-09-25 18:00 UTC');
    expect(q.summary).toBe('过去 6 小时无告警,附当前盘口与清算概况');
    expect(q.text).toContain('BTC 中间价 84000.0');
    expect(q.text).toContain('BTC 近 6h 清算:多头被强平 $120K / 空头被强平 $30K · 2 笔 · 最大一笔 多头 $120K');
    expect(q.text).toContain('ETH 近 6h 清算:多头被强平 $0 / 空头被强平 $0 · 0 笔');
    expect(q.text).toContain('最近告警 / Recent alerts: 无 / none');
    clean(q);
    setNow(T + 6 * HOUR + MIN);
    expect(await microAlertsChannel.tick(deps)).toBeNull();
  });

  it('保活计时被真实告警重置;录制器没数据时静默摘要如实写', async () => {
    const { deps, micro, setNow } = mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 2.5 }), ETHUSDT: null } });
    expect(await microAlertsChannel.tick(deps)).not.toBeNull(); // 失衡告警 @T
    micro.data.books = { BTCUSDT: null, ETHUSDT: null };
    micro.data.coverage = { BTCUSDT: null, ETHUSDT: null };
    setNow(T + 5 * HOUR);
    expect(await microAlertsChannel.tick(deps)).toBeNull();
    setNow(T + 6 * HOUR);
    const q = (await microAlertsChannel.tick(deps))!;
    expect(q.summary).toBe('录制器暂无数据,暂无法判断告警条件');
    expect(q.text).toContain('BTC 盘口:录制器暂无数据');
    expect(q.text).toContain('BTC 近 6h 清算:录制器暂无数据');
    expect(q.text).toMatch(/最近告警 \/ Recent alerts:\n· 2026-09-25 12:00 UTC\(360 分钟前\)BTC 盘口买盘明显偏厚/);
  });

  it('welcome:当前快照 + 当前无告警 / 最近告警;录制器没数据时明说', async () => {
    const quiet = mkDeps();
    const w = await microAlertsChannel.welcome(quiet.deps);
    expect(w.event_id).toBe(`micro:ALL:welcome:${T}`);
    expect(w.text.split('\n')[0]).toBe('【微观结构告警 / Microstructure Alerts】 当前快照 / Snapshot · 2026-09-25 12:00 UTC');
    expect(w.summary).toBe('当前无告警 / No active alerts');
    expect(w.text).toContain('BTC 中间价 84000.0 · 价差 0.01bp · 深度(可见 ±0.02%) 买 $8.40M / 卖 $8.40M · 失衡 +0.00');
    expect(w.text).not.toContain('Active now');
    expect(w.text).toContain('ETH 中间价 2675.0 · 价差 0.37bp · 深度(±0.5%)');
    expect(w.text).toContain('最近告警 / Recent alerts: 无 / none');
    clean(w);

    const hot = mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 2.5 }), ETHUSDT: book('ETHUSDT', { mid: 2675 }) } });
    await microAlertsChannel.tick(hot.deps);
    hot.setNow(T + 10 * MIN);
    const w2 = await microAlertsChannel.welcome(hot.deps);
    expect(w2.text).toContain('当前成立的条件 / Active now: BTC 盘口失衡 · BTC 近价买墙');
    expect(w2.text).toContain('· 2026-09-25 12:00 UTC(10 分钟前)BTC 盘口买盘明显偏厚');

    const empty = mkDeps({ books: { BTCUSDT: null, ETHUSDT: null } });
    const w3 = await microAlertsChannel.welcome(empty.deps);
    expect(w3.summary).toBe('录制器暂无数据 / Recorder has no fresh data');
    expect(w3.text).toContain('BTC 盘口:录制器暂无数据');
    const none = mkDeps();
    const w4 = await microAlertsChannel.welcome({ ...none.deps, micro: null });
    expect(w4.summary).toContain('录制器暂无数据');
    expect(await microAlertsChannel.tick({ ...none.deps, micro: null })).toBeNull();
  });

  it('BANNED_WORDS:命中就抛错', () => {
    expect(() => channelPush('micro_alerts', 'micro:x', '标题', '保证收益', [], {})).toThrow('micro_alerts_banned_words');
    expect(() => channelPush('micro_alerts', 'micro:x', '标题', 'ok', ['no-risk arbitrage'], {})).toThrow('micro_alerts_banned_words');
  });

  it('数据源抛错:记日志、按无数据处理,不抛', async () => {
    const { deps, logs } = mkDeps();
    deps.micro = { ...deps.micro!, book: async () => { throw new Error('disk gone'); } };
    expect(await microAlertsChannel.tick(deps)).toBeNull();
    const w = await microAlertsChannel.welcome(deps);
    expect(w.text).toContain('录制器暂无数据');
    expect(logs.some((l) => l.includes('disk gone'))).toBe(true);
  });
});
