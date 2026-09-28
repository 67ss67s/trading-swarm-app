// 订阅频道 micro_alerts + 微观结构数据源(src/demo/asp-agent/services/{micro-alerts,micro-source}.ts)。
// 频道用内存假数据源;录制器实现用临时目录里的 gzip jsonl(格式同 ~/.trade-gate-okx/micro/recorder.mjs),零网络。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MICRO_ALERT_DEFAULTS, bucketOf, maxLiqBurst, microAlertsChannel, type MicroDeps } from '../../src/demo/asp-agent/services/micro-alerts.js';
import { bookStats, memoryMicroSource, okxRestMicroSource, recorderMicroSource, sumLiquidations, usd, withFallback, type MicroBook, type MicroLiq } from '../../src/demo/asp-agent/services/micro-source.js';
import { CHANNEL_DISCLAIMER as DISCLAIMER, INSTRUCTION_WORDS, channelPush } from '../../src/demo/asp-agent/services/market-brief.js';
import type { ChannelDeps, ChannelPush } from '../../src/demo/asp-agent/services/types.js';
import { BANNED_WORDS, validateSignalText } from '../../src/demo/asp-agent/publisher.js';
import { signalFor } from '../../src/demo/asp-agent/services/broadcast.js';
import { calculateMicrostructure } from '../../src/demo/research/judge/microstructure.js';

const T = Date.UTC(2026, 8, 25, 12, 0, 0);
const MIN = 60_000, HOUR = 3_600_000;
const COOL = MICRO_ALERT_DEFAULTS.cooldown_ms;

/** 200 档、步长 0.1 的盘口(BTC 只看得到 ±0.02%,和线上录制器一样浅);数量为基础币。step 调大 = 深盘口 */
function book(symbol: string, o: { mid?: number; bid?: number; ask?: number; at?: number; step?: number; bump?: { side: 'bid' | 'ask'; i: number; qty: number } } = {}): MicroBook {
  const mid = o.mid ?? 84000, step = o.step ?? 0.1;
  const bids = Array.from({ length: 200 }, (_, i) => [mid - step / 2 - i * step, o.bid ?? 0.5] as [number, number]);
  const asks = Array.from({ length: 200 }, (_, i) => [mid + step / 2 + i * step, o.ask ?? 0.5] as [number, number]);
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
/** 盘口两类告警在浅盘口下默认停发;测判定逻辑时强制打开 */
const SHALLOW_OK = { book_alerts_when_shallow: true } as const;
function clean(p: ChannelPush): void {
  expect(BANNED_WORDS.test(p.text)).toBe(false);
  expect(INSTRUCTION_WORDS.test(p.text)).toBe(false);
  // JSON 不进聊天正文;全英文:无中日韩字符、无【】旧双语标题、无 snake_case 内部 key
  expect(p.text).not.toContain('{"');
  expect(p.text).not.toMatch(/[一-鿿]/);
  expect(p.text).not.toMatch(/[【】]/);
  expect(p.text.split('\n').slice(1).filter((l) => l !== DISCLAIMER).join('\n')).not.toMatch(/[a-z]+_[a-z_]+/);
  expect(p.text).not.toMatch(/spread/i);
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

  it('midAt:先查 book() 记下的中间价,查不到再扫盘口文件;超出容差返回 null', async () => {
    const src = recorderMicroSource({ directory: dir });
    // 刚启动内存里没有 → 扫文件:T-60s 那一帧(买一 84000 / 卖一 84000.1)
    expect(await src.midAt!('BTCUSDT', T - 55_000)).toEqual({ at: T - 60_000, mid: 84000.05 });
    expect(await src.midAt!('BTCUSDT', T - 10 * MIN)).toBeNull();
    expect(await src.midAt!('BTCUSDT', T - 10 * MIN, 10 * MIN)).toEqual({ at: T - 120_000, mid: 84000.05 });
    expect(await src.midAt!('ETHUSDT', T)).toBeNull();
    await src.book('BTCUSDT', T);
    expect(await src.midAt!('BTCUSDT', T - 25_000)).toEqual({ at: T - 30_000, mid: 84000.05 });
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
    expect(p.text.split('\n')[0]).toBe('Microstructure Alert · BTC Liquidation spike · OKX perps · 2026-09-25 12:00 UTC');
    expect(p.summary).toBe('BTC liquidation spike: $600K in 15 min on OKX perps, 60.0x the 6h 15-min average, 75% longs, price +0.00% over the window');
    expect(p.text).toContain('Last 15 min: longs $450K · shorts $150K (75% longs) · 2 liquidations');
    // 订阅信号行:类型头 + 标的 + 事件 + 规模 + 相对基线倍数 + 方向占比 + 窗口价格变化,≤200 字
    expect(p.signal).toBe('【Futures】BTC-USDT-SWAP | Liquidation spike | $600K liquidated in 15 min, 60.0x the 6h 15-min avg, 75% longs, price +0.00% over the window | Info only, no order | Trading Swarm');
    expect(validateSignalText(p.signal!).ok).toBe(true);
    expect(signalFor(p)).toBe(p.signal);
    expect(p.text).toContain('Data source: OKX perps public market data, captured by our order-book and liquidation recorder.');
    // 没有中间价序列 → 退回首末笔清算成交价
    expect(p.text).toContain('Price over the window (first/last liquidation fill): 11:57 UTC 84000.0 → 11:58 UTC 84000.0 (+0.00%)');
    expect(p.text).toContain('Baseline: $10K per 15-min window on average over the last 6h, now ~60.0× (trigger: ≥ $500K and ≥ 6× baseline)');
    expect(p.text).toContain('Largest single liquidation: long $450K @ 84000.0 (2026-09-25 11:57 UTC)');
    expect(p.text).toContain('Current order book (OKX perps): BTC mid 84000.0 · within the visible ±0.02%');
    expect(p.text).toContain('Structural observation only, not a trading instruction.');
    expect(p.payload).toMatchObject({ kind: 'liq_surge', symbol: 'BTCUSDT', source: 'okx_swap', alert: { price_move: { source: 'liq_price' } } });
    clean(p);

    // 有录制器中间价 → 用窗口起点那一帧中间价 → 当前中间价
    const withMid = mkDeps({ liqs });
    withMid.micro.data.mids = { BTCUSDT: [{ at: T - 16 * MIN, mid: 83000 }, { at: T - 15 * MIN + 20_000, mid: 83500 }] };
    const m = (await microAlertsChannel.tick(withMid.deps))!;
    expect(m.text).toContain('Price over the window (OKX perps mid): 11:45 UTC 83500.0 → 11:59 UTC 84000.0 (+0.60%)');
    expect((m.payload['alert'] as { price_move: { change_pct: number } }).price_move.change_pct).toBeCloseTo(0.5988, 3);
    // 只有一笔清算、也没有中间价 → 写暂缺
    const one = mkDeps({ liqs: { BTCUSDT: [...baseline(T), liq(T - 3 * MIN, 'long', 700_000)], ETHUSDT: [] } });
    expect((await microAlertsChannel.tick(one.deps))!.text).toContain('Price change over the window: unavailable');

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
    const { deps, setNow } = mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 2.5 }), ETHUSDT: book('ETHUSDT', { mid: 2675 }) }, config: SHALLOW_OK });
    const a = (await microAlertsChannel.tick(deps))!;
    expect(a.event_id).toBe(`micro:BTCUSDT:imbalance:${bucketOf(T, COOL)}`);
    expect(a.summary).toBe('BTC: OKX perps order book clearly bid-heavy, imbalance +0.67 (~5.0:1)');
    clean(a);
    setNow(T + MIN);
    const b = (await microAlertsChannel.tick(deps))!;
    expect(b.event_id).toBe(`micro:BTCUSDT:wall_bid:${bucketOf(T + MIN, COOL)}`);
    expect(b.summary).toMatch(/^BTC: \$17\.64M bid wall near price on OKX perps @ 83999\.9/);
    expect(b.text).toContain('Largest cluster (0.01% buckets): $17.64M');
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
    const p = (await microAlertsChannel.tick(mkDeps({ books, config: SHALLOW_OK }).deps))!;
    expect(p.event_id).toBe(`micro:BTCUSDT:wall_ask:${bucketOf(T, COOL)}`);
    expect(p.summary).toBe('BTC: $5.88M ask wall near price on OKX perps @ 84009.9 (0.012% from mid)');
    expect(p.text).toContain('Largest single level: $5.88M @ 84009.9 ▲');
    expect(p.text).toMatch(/Trigger: single level ≥ \$5\.00M or cluster ≥ \$8\.00M/);
    clean(p);
    // 调高阈值 → 不触发;调低聚合阈值 → ETH 也触发
    expect(await microAlertsChannel.tick(mkDeps({ books, config: { ...SHALLOW_OK, wall_level_usd: { default: 1e9, BTCUSDT: 1e9 }, wall_cluster_usd: { default: 1e9, BTCUSDT: 1e9 } } }).deps)).toBeNull();
    const low = (await microAlertsChannel.tick(mkDeps({ config: { wall_cluster_usd: { default: 1e9, ETHUSDT: 1_000 } } }).deps))!;
    expect(low.event_id).toMatch(/^micro:ETHUSDT:wall_bid:/);
    expect(MICRO_ALERT_DEFAULTS.wall_level_usd['BTCUSDT']).toBe(5_000_000); // 覆盖不改默认
  });

  it('聚合挂单墙(单档都不大,近价一段堆起来)', async () => {
    const p = (await microAlertsChannel.tick(mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 1.2 }), ETHUSDT: null }, config: SHALLOW_OK }).deps))!;
    expect(p.event_id).toMatch(/^micro:BTCUSDT:wall_bid:/);
    expect(p.text).toContain('Largest cluster (0.01% buckets): $8.47M starting at 83999.9 ▲');
    expect(p.text).not.toContain('▲\nLargest cluster'); // 单档没过线
  });

  it('可见盘口不足 ±0.3%:默认停发盘口失衡与大墙;盘口够深照常判', async () => {
    expect(MICRO_ALERT_DEFAULTS.book_min_visible_pct).toBe(0.003);
    expect(MICRO_ALERT_DEFAULTS.book_alerts_when_shallow).toBe(false);
    // 线上那种 200 档浅盘口:买盘再厚、单档再大也不推
    const shallow = mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 2.5, bump: { side: 'ask', i: 0, qty: 500 } }), ETHUSDT: null } });
    expect(await microAlertsChannel.tick(shallow.deps)).toBeNull();
    // 步长 2 → 可见约 ±0.47%:失衡照常告警
    const deep = mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 2.5, step: 2 }), ETHUSDT: null } });
    const p = (await microAlertsChannel.tick(deep.deps))!;
    expect(p.event_id).toMatch(/^micro:BTCUSDT:imbalance:/);
    expect(p.text).toContain('Trigger: |imbalance| ≥ 0.6 within ±0.47% and total depth ≥ $2.00M');
    expect(p.payload).toMatchObject({ alert: { source: 'okx_swap' } });
    clean(p);
    // 阈值可调
    expect(await microAlertsChannel.tick(mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 2.5, step: 2 }), ETHUSDT: null }, config: { book_min_visible_pct: 0.006 } }).deps)).toBeNull();
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
    expect(q.text.split('\n')[0]).toBe('Microstructure Quiet-Period Summary · 2026-09-25 18:00 UTC');
    expect(q.summary).toBe('No alerts in the past 6h: BTC max 15-min liquidations $120K; ETH max 15-min liquidations $0');
    expect(q.text).toContain('No alerts in the past 6h. What the OKX perps microstructure did in that window:');
    expect(q.text).toContain('BTC mid 84000.0');
    expect(q.text).toContain('BTC liquidations, last 6h: longs $120K / shorts $30K · 2 liquidations · largest: long $120K @ 84000.0');
    expect(q.text).toContain('BTC largest 15-min liquidation burst: $120K (12:45–13:00 UTC, 100% longs), 19.2× the 6h 15-min average; an alert needs ≥ $500K and ≥ 6× baseline');
    expect(q.text).toContain('ETH liquidations, last 6h: longs $0 / shorts $0 · 0 liquidations');
    expect(q.text).toContain('ETH largest 15-min liquidation burst: none');
    // 第一次 tick 采过一次可见盘口失衡样本
    expect(q.text).toContain('BTC order-book imbalance on the visible book over the window: +0.00 to +0.00');
    expect(q.signal).toMatch(/^【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP \| Quiet 6h \| No liquidation spike in 6h; BTC max 15m liq \$120K; ETH max 15m liq \$0 \| Info only, no order \| Trading Swarm$/);
    expect(validateSignalText(q.signal!).ok).toBe(true);
    expect(q.text).toContain('Recent alerts: none');
    clean(q);
    setNow(T + 6 * HOUR + MIN);
    expect(await microAlertsChannel.tick(deps)).toBeNull();
  });

  it('保活计时被真实告警重置;录制器与 REST 都没数据时不推空摘要(下个 tick 再试)', async () => {
    const { deps, micro, setNow } = mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 2.5 }), ETHUSDT: null }, config: SHALLOW_OK });
    expect(await microAlertsChannel.tick(deps)).not.toBeNull(); // 失衡告警 @T
    micro.data.books = { BTCUSDT: null, ETHUSDT: null };
    micro.data.coverage = { BTCUSDT: null, ETHUSDT: null };
    setNow(T + 5 * HOUR);
    expect(await microAlertsChannel.tick(deps)).toBeNull();
    setNow(T + 6 * HOUR);
    expect(await microAlertsChannel.tick(deps)).toBeNull();
    expect(deps.state.get('micro:last_push_at')).toBe(String(T)); // 计时不重置
    // 数据回来(哪怕只有清算)→ 照常推,且不含「没数据」
    micro.data.coverage = { BTCUSDT: { from_ms: T, to_ms: T + 6 * HOUR }, ETHUSDT: null };
    setNow(T + 6 * HOUR + MIN);
    const q = (await microAlertsChannel.tick(deps))!;
    expect(q.text).not.toMatch(/no recorder data/i);
    expect(q.text).toContain('BTC liquidations, last 6h: longs $0 / shorts $0 · 0 liquidations');
    expect(q.text).toMatch(/Recent alerts:\n· 2026-09-25 12:00 UTC \(361 min ago\) BTC: OKX perps order book clearly bid-heavy/);
    clean(q);
  });

  it('welcome:盘口类告警暂停时,「最近告警」不列暂停前触发的失衡/大墙,清算照列;改英文前存的中文摘要按 kind 重写', async () => {
    const h = mkDeps({ books: { BTCUSDT: book('BTCUSDT'), ETHUSDT: null } });
    h.deps.state.set('micro:recent', JSON.stringify([
      { at: T - 600_000, symbol: 'BTCUSDT', kind: 'wall_bid', summary: 'BTC: $9.00M bid wall near price', event_id: 'a' },
      { at: T - 300_000, symbol: 'BTCUSDT', kind: 'liq_surge', summary: 'BTC: $2.00M liquidated on OKX perps in the last 15 min, mostly longs', event_id: 'b' },
      { at: T - 200_000, symbol: 'ETHUSDT', kind: 'liq_surge', summary: 'ETH 近 15 分钟 OKX 永续清算 $1.2M,空头被强平为主', event_id: 'c' },
    ]));
    const w = await microAlertsChannel.welcome(h.deps);
    expect(w.text).toContain('paused');
    expect(w.text).toContain('BTC: $2.00M liquidated on OKX perps');
    expect(w.text).toContain('(5 min ago) BTC: $2.00M');
    expect(w.text).toContain('ETH Liquidation spike');
    expect(w.text).not.toContain('bid wall near price\n');
    expect(w.text).not.toContain('$9.00M');
    expect((w.payload['recent'] as { kind: string }[]).map((r) => r.kind)).toEqual(['liq_surge', 'liq_surge']);
    clean(w);
  });
  it('welcome:当前快照 + 当前无告警 / 最近告警;录制器没数据时明说', async () => {
    const quiet = mkDeps();
    const w = await microAlertsChannel.welcome(quiet.deps);
    expect(w.event_id).toBe(`micro:ALL:welcome:${T}`);
    expect(w.text.split('\n')[0]).toBe('Microstructure Alerts · Current snapshot · OKX perps · 2026-09-25 12:00 UTC');
    expect(w.summary).toBe('No active alerts');
    expect(w.text).toContain('Current order book (OKX perps):\nBTC mid 84000.0 · within the visible ±0.02%: bids $8.40M / asks $8.40M · imbalance +0.00');
    expect(w.text).not.toContain('Conditions currently met');
    expect(w.text).toContain('ETH mid 2675.0 · within ±0.5%');
    expect(w.text).toContain('Recent alerts: none');
    // BTC 盘口太浅:明说停发;ETH 够深,规则里仍列盘口两类
    expect(w.text).toContain('Order-book imbalance and wall alerts paused: BTC visible book only ±0.02%, below the ±0.3% minimum.');
    expect(w.text).toContain('Rules: OKX perps liquidations ≥ 6× baseline (with the price change over the window); order-book imbalance |x| ≥ 0.6; large walls near price. 30-min cooldown per alert type; a quiet-period summary after 6h without alerts.');
    expect(w.payload).toMatchObject({ book_alerts_paused: ['BTCUSDT'] });
    clean(w);
    // 全都浅 → 规则里不再写盘口两类
    const allShallow = await microAlertsChannel.welcome(mkDeps({ books: { BTCUSDT: book('BTCUSDT'), ETHUSDT: null } }).deps);
    expect(allShallow.text).not.toContain('; order-book imbalance |x|');
    expect(allShallow.text).toContain('Rules: OKX perps liquidations ≥ 6× baseline (with the price change over the window). 30-min');

    const hot = mkDeps({ books: { BTCUSDT: book('BTCUSDT', { bid: 2.5 }), ETHUSDT: book('ETHUSDT', { mid: 2675 }) }, config: SHALLOW_OK });
    await microAlertsChannel.tick(hot.deps);
    hot.setNow(T + 10 * MIN);
    const w2 = await microAlertsChannel.welcome(hot.deps);
    expect(w2.summary).toBe('2 conditions currently met');
    expect(w2.text).toContain('Conditions currently met: BTC Order-book imbalance · BTC Bid wall near price');
    expect(w2.text).toContain('· 2026-09-25 12:00 UTC (10 min ago) BTC: OKX perps order book clearly bid-heavy');
    expect(w2.text).not.toContain('alerts paused');
    clean(w2);

    const empty = mkDeps({ books: { BTCUSDT: null, ETHUSDT: null } });
    const w3 = await microAlertsChannel.welcome(empty.deps);
    expect(w3.summary).toBe('Live data temporarily unreachable');
    expect(w3.text).toContain('BTC order book: temporarily unavailable');
    expect(validateSignalText(w3.signal!).ok).toBe(true);
    clean(w3);
    const none = mkDeps();
    const w4 = await microAlertsChannel.welcome({ ...none.deps, micro: null });
    expect(w4.summary).toBe('Live data temporarily unreachable');
    expect(w4.signal).toMatch(/^【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP \| Microstructure snapshot \| /);
    expect(w4.text).toContain('alerts will start automatically once it is back');
    clean(w4);
    expect(await microAlertsChannel.tick({ ...none.deps, micro: null })).toBeNull();
  });

  it('BANNED_WORDS:命中就抛错', () => {
    expect(() => channelPush('micro_alerts', 'micro:x', 'Title', 'guaranteed returns', [], {})).toThrow('micro_alerts_banned_words');
    expect(() => channelPush('micro_alerts', 'micro:x', 'Title', 'ok', ['no-risk arbitrage'], {})).toThrow('micro_alerts_banned_words');
    expect(() => channelPush('micro_alerts', 'micro:x', 'Title', '保证收益', [], {})).toThrow('micro_alerts_banned_words');
  });

  it('数据源抛错:记日志、按无数据处理,不抛', async () => {
    const { deps, logs } = mkDeps();
    deps.micro = { ...deps.micro!, book: async () => { throw new Error('disk gone'); } };
    expect(await microAlertsChannel.tick(deps)).toBeNull();
    const w = await microAlertsChannel.welcome(deps);
    expect(w.text).toContain('temporarily unavailable');
    expect(logs.some((l) => l.includes('disk gone'))).toBe(true);
  });
});

describe('OKX REST 兜底数据源 + 录制器拼接', () => {
  /** 假 OKX:清算单按 after 分页(新→旧,每页 ≤100) */
  function fakeOkx(o: { liqs: { ts: number; posSide: string; px: string; sz: string }[]; now: number }) {
    const calls: string[] = [];
    const get = async (path: string): Promise<unknown> => {
      calls.push(path);
      const q = new URLSearchParams(path.split('?')[1]);
      if (path.startsWith('/api/v5/public/liquidation-orders')) {
        const after = q.get('after') ? Number(q.get('after')) : Infinity;
        const rows = o.liqs.filter((r) => r.ts < after).sort((a, b) => b.ts - a.ts).slice(0, 100);
        return [{ details: rows.map((r) => ({ ts: String(r.ts), posSide: r.posSide, side: r.posSide === 'long' ? 'sell' : 'buy', bkPx: r.px, sz: r.sz })) }];
      }
      if (path.startsWith('/api/v5/market/books')) return [{ ts: String(o.now - 5_000), bids: [['84000', '100', '0', '3'], ['83999.9', '50', '0', '1']], asks: [['84000.1', '200', '0', '2']] }];
      if (path.startsWith('/api/v5/market/candles')) return [[String(o.now - 60_000), '84100', '84200', '83900', '84000', '1'], [String(o.now - 120_000), '84500', '84600', '84000', '84100', '1']];
      if (path.startsWith('/api/v5/rubik')) return [[String(o.now - 300_000), '1', '1', '2000000000'], [String(o.now - 600_000), '1', '1', '1000000000']];
      if (path.startsWith('/api/v5/public/funding-rate')) return [{ fundingRate: '0.0001', fundingTime: String(o.now + HOUR), ts: String(o.now) }];
      return [];
    };
    return { get, calls };
  }

  it('清算:按 after 往回翻页到回补目标,之后只拉最新一页并与缓存接上;id 与录制器同格式', async () => {
    let now = T;
    // 250 笔,每 20 秒一笔(约 83 分钟)
    const liqs = Array.from({ length: 250 }, (_, i) => ({ ts: T - 10_000 - i * 20_000, posSide: i % 2 ? 'short' : 'long', px: '84000', sz: '100' }));
    const f = fakeOkx({ liqs, now });
    const src = okxRestMicroSource({ get: f.get, now: () => now, history_ms: HOUR, min_refresh_ms: 20_000 });
    const rows = await src.liquidations('BTCUSDT', T - HOUR, T);
    expect(f.calls.filter((c) => c.includes('liquidation-orders'))).toHaveLength(2); // 第二页已过 1h 目标就停
    expect(rows.every((r) => r.notional_usd === 84_000)).toBe(true); // 100 张 × 0.01 BTC × 84000
    expect(rows[0]!.id).toMatch(/^BTC-USDT-SWAP:\d+:(long|short):84000:100$/);
    const cov = (await src.coverage('BTCUSDT', T))!;
    expect(cov.source).toBe('okx_rest');
    expect(cov.from_ms).toBeLessThanOrEqual(T - HOUR);
    expect(f.calls.filter((c) => c.includes('liquidation-orders'))).toHaveLength(2); // 20s 内复用
    // 1 分钟后新增 3 笔 → 只拉 1 页就接上缓存
    liqs.push({ ts: T + 30_000, posSide: 'long', px: '84000', sz: '1000' }, { ts: T + 40_000, posSide: 'short', px: '84000', sz: '100' }, { ts: T + 50_000, posSide: 'long', px: '84000', sz: '100' });
    now = T + MIN;
    const after = await src.liquidations('BTCUSDT', T, now);
    expect(f.calls.filter((c) => c.includes('liquidation-orders'))).toHaveLength(3);
    expect(after.map((r) => r.notional_usd)).toEqual([840_000, 84_000, 84_000]);
  });

  it('历史翻到底(不足一页)→ 覆盖从回补目标算起;盘口 / K 线 / 持仓量 / 资金费解析', async () => {
    const f = fakeOkx({ liqs: [{ ts: T - 5 * MIN, posSide: 'long', px: '84000', sz: '10' }], now: T });
    const src = okxRestMicroSource({ get: f.get, now: () => T, history_ms: 7 * HOUR });
    expect(await src.coverage('BTCUSDT', T)).toEqual({ from_ms: T - 7 * HOUR, to_ms: T, source: 'okx_rest' });
    const b = (await src.book('BTCUSDT', T))!;
    expect(b).toMatchObject({ source: 'okx_rest', at: T - 5_000, inst_id: 'BTC-USDT-SWAP' });
    expect(b.bids[0]).toEqual([84000, 1]);
    expect(await src.book('BTCUSDT', T + 10 * MIN)).toBeNull(); // 过旧
    expect((await src.candles!('BTCUSDT', '1m', 5)).map((c) => c.at)).toEqual([T - 120_000, T - 60_000]);
    expect(await src.openInterest!('BTCUSDT', 3)).toMatchObject({ oi_usd: 2e9, history: [{ oi_usd: 1e9 }, { oi_usd: 2e9 }] });
    expect(await src.funding!('BTCUSDT')).toEqual({ at: T, rate: 0.0001, next_at: T + HOUR });
    expect(await src.book('SOLUSDT', T)).toBeNull();
  });

  it('withFallback:录制器没新帧用 REST 盘口;录制器覆盖不够时清算两边合并去重;覆盖区间拼接', async () => {
    const shared = liq(T - 3 * MIN, 'long', 1_000);
    const rec = memoryMicroSource({ books: { BTCUSDT: null, ETHUSDT: book('ETHUSDT', { mid: 2675 }) }, liqs: { BTCUSDT: [shared], ETHUSDT: [] }, coverage: { BTCUSDT: { from_ms: T - 30 * MIN, to_ms: T - 30_000 }, ETHUSDT: null } });
    const rest = memoryMicroSource({ books: { BTCUSDT: { ...book('BTCUSDT'), source: 'okx_rest' }, ETHUSDT: null }, liqs: { BTCUSDT: [shared, liq(T - 2 * HOUR, 'short', 2_000)], ETHUSDT: [] }, coverage: { BTCUSDT: { from_ms: T - 7 * HOUR, to_ms: T, source: 'okx_rest' }, ETHUSDT: null }, funding: { BTCUSDT: { at: T, rate: 0.0001, next_at: null } } });
    const src = withFallback(rec, rest);
    expect((await src.book('BTCUSDT', T))!.source).toBe('okx_rest');
    expect((await src.book('ETHUSDT', T))!.source).toBe('recorder');
    expect((await src.liquidations('BTCUSDT', T - 6 * HOUR, T)).map((r) => r.notional_usd)).toEqual([2_000, 1_000]);
    expect(await src.liquidations('BTCUSDT', T - 10 * MIN, T)).toEqual([shared]); // 录制器覆盖得了 → 只用录制器
    expect(await src.coverage('BTCUSDT', T)).toEqual({ from_ms: T - 7 * HOUR, to_ms: T, source: 'okx_rest' });
    expect(await src.funding!('BTCUSDT')).toMatchObject({ rate: 0.0001 });
    // recorderMicroSource 显式 fallback:目录不存在也有数
    const viaRec = recorderMicroSource({ directory: join(tmpdir(), 'no-such-micro-dir'), fallback: rest });
    expect((await viaRec.book('BTCUSDT', T))!.source).toBe('okx_rest');
    expect(recorderMicroSource({ directory: join(tmpdir(), 'no-such-micro-dir') }).deepBook).toBeUndefined();
  });

  it('maxLiqBurst:滑动 15 分钟窗口里最大的一段', () => {
    const rows = [liq(T - 60 * MIN, 'long', 100), liq(T - 20 * MIN, 'long', 300), liq(T - 10 * MIN, 'short', 100), liq(T - 1 * MIN, 'short', 50)];
    expect(maxLiqBurst(rows, 15 * MIN)).toMatchObject({ total_usd: 400, long_usd: 300, short_usd: 100, count: 2, to: T - 10 * MIN });
    expect(maxLiqBurst([], 15 * MIN)).toBeNull();
  });

  it('告警详情:录制器断档时用 1 分钟 K 线写窗口价格;深盘口 / 持仓量 / 资金费 / REST 数据来源都写进正文', async () => {
    const liqs = { BTCUSDT: [...baseline(T), liq(T - 3 * MIN, 'long', 900_000), liq(T - 2 * MIN, 'short', 100_000)], ETHUSDT: [] };
    const h = mkDeps({ liqs, books: { BTCUSDT: { ...book('BTCUSDT'), source: 'okx_rest' }, ETHUSDT: null } });
    const deep = book('BTCUSDT', { step: 4, bid: 0.9, ask: 0.3, at: T - 10_000 });
    Object.assign(h.micro.data, {
      candles: { BTCUSDT: Array.from({ length: 18 }, (_, i) => ({ at: T - (17 - i) * MIN, open: 84400 - i * 20, high: 84450 - i * 20, low: 84350 - i * 20, close: 84380 - i * 20 })) },
      deep: { BTCUSDT: deep },
      oi: { BTCUSDT: { at: T - MIN, oi_usd: 2.2e9, history: Array.from({ length: 14 }, (_, i) => ({ at: T - MIN - (13 - i) * 5 * MIN, oi_usd: 2.3e9 - i * 0.1e9 / 13 })) } },
      funding: { BTCUSDT: { at: T, rate: -0.00005, next_at: T + 4 * HOUR } },
    });
    const p = (await microAlertsChannel.tick(h.deps))!;
    expect(p.text).toContain('Price over the window (OKX perps 1-min candles): 11:45 UTC 84360.0 → 12:00 UTC 84040.0 (-0.38%)');
    expect(p.summary).toBe('BTC liquidation spike: $1.00M in 15 min on OKX perps, 100.0x the 6h 15-min average, 90% longs, price -0.38% over the window');
    expect(p.signal).toContain('$1.00M liquidated in 15 min, 100.0x the 6h 15-min avg, 90% longs, price -0.38% over the window');
    expect([...p.signal!].length).toBeLessThanOrEqual(200);
    expect(p.text).toMatch(/BTC order book within ±0\.5% \(full depth\): bids \$[\d.]+M \/ asks \$[\d.]+M · imbalance \+0\.50 · largest bid \$[\d.]+K @ [\d.]+ \([\d.]+% below mid\) · largest ask .+above mid\)/);
    expect(p.text).toMatch(/BTC open interest: \$2\.20B, -[\d.]+% over the last 15 min, -[\d.]+% over 1h/);
    expect(p.text).toContain('BTC funding rate: -0.0050% for the current period (settles 16:00 UTC)');
    expect(p.text).toContain('Data source: OKX perps public market data; order book (BTC) read directly from the OKX public REST API while our recorder catches up.');
    expect(p.payload).toMatchObject({ context: { funding: { rate: -0.00005 }, deep_book: { band_pct: 0.005 } }, alert: { price_move: { source: 'candles_1m' } } });
    clean(p);
    const w = await microAlertsChannel.welcome(h.deps);
    expect(w.signal).toMatch(/^【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP \| Microstructure snapshot \| 1 condition met; BTC imbalance \+0\.50, funding -0\.0050% \| Info only, no order \| Trading Swarm$/);
    clean(w);
  });

  it('静默摘要:6h 价格区间、深盘口失衡采样区间、持仓量与资金费', async () => {
    const h = mkDeps();
    Object.assign(h.micro.data, {
      deep: { BTCUSDT: book('BTCUSDT', { step: 4, bid: 0.6, ask: 0.4 }), ETHUSDT: null },
      candles: { BTCUSDT: Array.from({ length: 26 }, (_, i) => ({ at: Math.floor((T + 6 * HOUR) / 900_000) * 900_000 - (25 - i) * 15 * MIN, open: 84000 + i * 10, high: 84100 + i * 10, low: 83900 + i * 10, close: 84010 + i * 10 })), ETHUSDT: [] },
      funding: { BTCUSDT: { at: T, rate: 0.0001, next_at: null }, ETHUSDT: null },
    });
    expect(await microAlertsChannel.tick(h.deps)).toBeNull(); // 起表 + 采样
    h.setNow(T + 3 * HOUR);
    h.micro.data.deep!['BTCUSDT'] = book('BTCUSDT', { step: 4, bid: 0.3, ask: 0.6 });
    await microAlertsChannel.tick(h.deps);
    h.setNow(T + 6 * HOUR);
    const q = (await microAlertsChannel.tick(h.deps))!;
    expect(q.text).toMatch(/BTC price, last 6h: 84010\.0 → 84260\.0 \(\+0\.30%\), range 83910\.0–84350\.0 \(0\.52%\)/);
    expect(q.text).toContain('BTC order-book imbalance within ±0.5% over the window: -0.34 to +0.20 (3 samples)');
    expect(q.text).toContain('BTC funding rate: +0.0100% for the current period');
    expect(q.summary).toMatch(/^No alerts in the past 6h: BTC \+0\.3%, max 15-min liquidations/);
    expect(q.signal).toMatch(/^【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP \| Quiet 6h \| No liquidation spike in 6h; BTC \+0\.3%, max 15m liq \$0, funding \+0\.0100%; ETH max 15m liq \$0 \|/);
    clean(q);
  });
});
