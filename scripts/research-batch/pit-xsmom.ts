/**
 * 横截面动量 · 按时点资产池重跑(去幸存者偏差,2026-09-23 晚)。零模型,纯本地计算,读 pit-fetch.ts 冻结的币安现货日线。
 *
 * 预先声明的口径(跑之前写死,不看结果再改):
 *  - 价格与成交额:全部用币安现货 USDT 交易对(含已下架),单一来源;OKX 很多下架币没有历史,不混源。
 *  - 按时点资产池:每个调仓时刻 t,取 (t−90 天, t] 内至少 85 天有 K 线、且 t 当天有收盘的交易对,按报价币成交额之和排名取前 20,
 *    排除稳定币/法币/包装币(research/batch/universe.ts 的 looksExcluded)与杠杆代币(UP/DOWN/BULL/BEAR 后缀)。不要求 OKX 永续在售(按时点无从得知)。
 *  - 退市:持仓资产最后一根 K 线之后,按最后收盘加滑点扣费清算(runXsmom 的 liquidate_delisted)。
 *  - 切段:与批量研究同一份(OKX BTC 日线 makeSegments:训练 / 验证 / 留出),各段独立从 $10,000 起跑(不是连续运行切片)。
 *  - 成本:现货费率 0.1%、滑点 5bp(与批量研究同)。
 *  - 变体:批量研究的 4 个现货多头(lb30_top3 / lb30_top5 / lb90_top5 / lb30_top5_abs);训练段按夏普选 1 个,验证段看全部,留出段只跑训练段选中的 + 原冠军 lb30_top5_abs(预先登记的复核对象)。
 *  - 对照:① 资产池等权持有(同一按时点成员,周调仓等权,即 top_k = 池大小);② BTC 持有;③ 同敞口持有(①的日收益 × 策略前一日敞口);
 *    ④ 随机选币 20 个种子(同成员、同名数、同调仓);⑤ 当前在售资产池(universe.json)同一币安价格重跑,分离「价格来源」与「资产池口径」两种效应。
 *  - 每笔收益给均值、中位数、截尾均值(两端各 10%);笔数 < 30 标「观察」。
 * 输出 ~/.trade-gate-okx/research-batch/pit-xsmom.json,并打印摘要。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/pit-xsmom.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ResearchBar } from '@trade-gate/contracts';
import { runXsmom, DAY_MS, type PortfolioAsset, type PortfolioRun, type XsmomParams, type XsmomRunOptions } from '../../packages/gateway/src/demo/research/primitives/portfolio-xsmom.ts';
import { looksExcluded } from '../../packages/gateway/src/demo/research/batch/universe.ts';
import { portfolioVariants } from '../../packages/gateway/src/demo/research/batch/families.ts';
import { centerStats } from '../../packages/gateway/src/demo/research/analyzer.ts';
import { BATCH_DIR, readUniverse, segmentsFor } from './common.ts';

const PIT_DIR = path.join(BATCH_DIR, 'pit'), POOL = 20, VOL_DAYS = 90, MIN_DAYS = 85, RANDOM_RUNS = 20, SEED = 20260923;
const COST = { fee_rate: 0.001, slippage_bps: 5 }, INITIAL = 10000;
const t0 = Date.now(), log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`);
// looksExcluded 之外、币安早年才有的法币/稳定币代码(PAX = Paxos 稳定币旧代码,第一版漏掉后补,见报告)
const FIAT = new Set(['PAX', 'EURI', 'XUSD', 'EUR', 'GBP', 'AUD', 'TRY', 'BRL', 'RUB', 'BIDR', 'IDRT', 'NGN', 'UAH', 'ZAR', 'BKRW', 'VAI', 'SUSD', 'UST', 'USDSB', 'BVND', 'JPY', 'MXN', 'ARS', 'PLN', 'RON', 'CZK', 'COP']);
const leveraged = (b: string) => /(UP|DOWN|BULL|BEAR)$/.test(b) && b.length > 4;

// ---------- 读数据 ----------
interface Raw { symbol: string; bars: [number, number, number, number, number, number][] }
const assets: PortfolioAsset[] = [], qv = new Map<string, Map<number, number>>(), excluded: string[] = [];
for (const f of readdirSync(PIT_DIR).filter((f) => f.endsWith('.json'))) {
  const r = JSON.parse(readFileSync(path.join(PIT_DIR, f), 'utf8')) as Raw, base = r.symbol.replace(/USDT$/, '');
  if (looksExcluded(base) || FIAT.has(base) || leveraged(base)) { excluded.push(r.symbol); continue; }
  if (r.bars.length < MIN_DAYS) continue;
  const bars: ResearchBar[] = r.bars.map(([t, o, h, l, c, v]) => ({ open_time: t, close_time: t + DAY_MS - 1, available_at: t + DAY_MS - 1, open: String(o), high: String(h), low: String(l), close: String(c), volume: String(v) }));
  assets.push({ symbol: r.symbol, bars });
  qv.set(r.symbol, new Map(r.bars.map(([t, , , , , v]) => [t + DAY_MS - 1, v])));
}
const delistedCount = assets.filter((a) => a.bars.at(-1)!.close_time < Date.UTC(2026, 8, 20)).length;
log(`资产 ${assets.length} 个(其中数据在 2026-09-20 前结束 ${delistedCount} 个),排除 ${excluded.length} 个`);

// ---------- 按时点资产池(调仓时刻缓存) ----------
const pitCache = new Map<number, Set<string>>();
function pitMembers(t: number): Set<string> {
  let s = pitCache.get(t); if (s) return s;
  const ranked: { sym: string; vol: number }[] = [];
  for (const [sym, m] of qv) {
    if (!m.has(t)) continue;
    let vol = 0, days = 0;
    for (let k = 0; k < VOL_DAYS; k++) { const v = m.get(t - k * DAY_MS); if (v !== undefined) { vol += v; days++; } }
    if (days >= MIN_DAYS && vol > 0) ranked.push({ sym, vol });
  }
  ranked.sort((a, b) => b.vol - a.vol || a.sym.localeCompare(b.sym));
  s = new Set(ranked.slice(0, POOL).map((x) => x.sym)); pitCache.set(t, s); return s;
}
const current = new Set(readUniverse());
const universes: Record<string, XsmomRunOptions> = {
  pit: { eligible: pitMembers, liquidate_delisted: true },
  current: { eligible: () => current, liquidate_delisted: true },
};

// ---------- 指标 ----------
interface Metrics { total_return: number; max_dd: number; sharpe: number | null; trades: number; trade_mean: number | null; trade_median: number | null; trade_trimmed: number | null; observation_only: boolean; avg_exposure: number; fees: number; notes: string[] }
function metrics(r: PortfolioRun): Metrics {
  const eq = r.samples.map((s) => s.equity), rets = eq.slice(1).map((v, i) => v / eq[i]! - 1);
  let peak = -Infinity, dd = 0; for (const v of eq) { peak = Math.max(peak, v); dd = Math.max(dd, 1 - v / peak); }
  const m = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length), sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, rets.length - 1));
  const closed = r.trades.filter((t) => !t.open).map((t) => t.return_pct), c = centerStats(closed);
  return { total_return: eq.length ? eq.at(-1)! / INITIAL - 1 : 0, max_dd: dd, sharpe: sd > 0 ? (m / sd) * Math.sqrt(365) : null, trades: closed.length, trade_mean: c.mean, trade_median: c.median, trade_trimmed: c.trimmed_mean, observation_only: closed.length < 30, avg_exposure: r.samples.reduce((a, s) => a + s.exposure, 0) / Math.max(1, r.samples.length), fees: r.fees, notes: r.notes };
}
/** 同敞口持有:基准日收益 × 策略前一日敞口,复利 */
function sameExposure(strat: PortfolioRun, bench: PortfolioRun): number {
  const b = new Map(bench.samples.map((s) => [s.at, s.equity])); let v = 1, prevB: number | null = null, prevExp = 0;
  for (const s of strat.samples) { const x = b.get(s.at); if (x !== undefined && prevB !== null) v *= 1 + prevExp * (x / prevB - 1); if (x !== undefined) prevB = x; prevExp = s.exposure; }
  return v - 1;
}
function btcHold(w: { from_ms: number; to_ms: number }): number {
  const bars = assets.find((a) => a.symbol === 'BTCUSDT')!.bars.filter((b) => b.close_time >= w.from_ms && b.close_time <= w.to_ms);
  return Number(bars.at(-1)!.close) / Number(bars[0]!.close) - 1;
}

// ---------- 跑 ----------
const segs = segmentsFor('1d', 'spot'), variants = portfolioVariants().filter((v) => v.family === 'xsmom' && v.market === 'spot');
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
log(`切段 训练 ${iso(segs.train.from_ms)}~${iso(segs.train.to_ms)} 验证 ${iso(segs.validation.from_ms)}~${iso(segs.validation.to_ms)} 留出 ${iso(segs.holdout.from_ms)}~${iso(segs.holdout.to_ms)}`);
const run = (p: XsmomParams, w: { from_ms: number; to_ms: number }, u: string) => runXsmom(assets, p, w, COST, INITIAL, universes[u]!);
type SegName = 'train' | 'validation' | 'holdout';
const out: Record<string, unknown> = { generated_at: new Date().toISOString(), basis: '币安现货 USDT 日线(含已下架),按时点 90 天成交额前 20;退市按最后收盘清算;各段独立 $10k 起跑', segments: segs, assets: assets.length, ended_before_2026_09_20: delistedCount, results: {} };
const res = out.results as Record<string, unknown>;
function evalSeg(u: string, seg: SegName, only?: string[]) {
  const w = segs[seg], bench = run({ lookback_days: 30, top_k: POOL, rebalance: 'weekly', side: 'long_only' }, w, u), bm = metrics(bench), btc = btcHold(w);
  const rows: Record<string, unknown> = {};
  for (const v of variants) {
    if (only && !only.includes(v.param)) continue;
    const p = v.node.params as XsmomParams, r = run(p, w, u), m = metrics(r);
    const rnd = Array.from({ length: RANDOM_RUNS }, (_, k) => metrics(run({ ...p, select: 'random', seed: SEED + k }, w, u)).total_return).sort((a, b) => a - b);
    rows[v.param] = { ...m, same_exposure_hold: sameExposure(r, bench), random_median: rnd[Math.floor(rnd.length / 2)], random_beaten: rnd.filter((x) => m.total_return > x).length / rnd.length, random_returns: rnd, members_sample: r.rebalances.filter((_, i) => i % 26 === 0).map((rb) => ({ at: iso(rb.at + 1), ranked: rb.ranked, holdings: rb.holdings.map((h) => h.symbol) })) };
    log(`${u} ${seg} ${v.param}: ${(m.total_return * 100).toFixed(1)}% 回撤 ${(m.max_dd * 100).toFixed(0)}% 夏普 ${m.sharpe?.toFixed(2)} 笔 ${m.trades} | 池等权 ${(bm.total_return * 100).toFixed(1)}% BTC ${(btc * 100).toFixed(1)}% 随机中位 ${((rows[v.param] as { random_median: number }).random_median * 100).toFixed(1)}%`);
  }
  res[`${u}:${seg}`] = { pool_equal_weight: bm, btc_hold: btc, rows };
}
for (const u of ['pit', 'current']) for (const seg of ['train', 'validation'] as const) evalSeg(u, seg);
// 训练段按夏普选(按时点口径),留出段只跑选中的 + 原冠军
const trainRows = (res['pit:train'] as { rows: Record<string, Metrics> }).rows;
const pick = Object.entries(trainRows).sort((a, b) => (b[1].sharpe ?? -9) - (a[1].sharpe ?? -9))[0]![0];
out.train_pick = pick;
log(`训练段选中 ${pick};留出段跑 ${[...new Set([pick, 'lb30_top5_abs'])].join(', ')}`);
for (const u of ['pit', 'current']) evalSeg(u, 'holdout', [...new Set([pick, 'lb30_top5_abs'])]);
// 按时点资产池成员快照(每年 1 月第一个调仓),给报告看池子里都是谁
out.pit_snapshots = Object.fromEntries([...pitCache.entries()].sort((a, b) => a[0] - b[0]).filter(([t], i, arr) => i === 0 || new Date(t + 1).getUTCFullYear() !== new Date(arr[i - 1]![0] + 1).getUTCFullYear()).map(([t, s]) => [iso(t + 1), [...s]]));
writeFileSync(path.join(BATCH_DIR, 'pit-xsmom.json'), JSON.stringify(out, null, 1));
log('完成 → pit-xsmom.json');
