/**
 * 回测报告服务(§9.46):全窗口 + 多资产 + Nautilus 式统计 + Horizon 式评分,零模型。
 *
 * 窗口:交易起点 = 窗口起点(预热向窗口之前的数据借);借不够统一预热 WARMUP_BARS 根时,所有策略都从「数据首根 + WARMUP_BARS」起步
 *   (策略自身预热更长时从「首根 + 自身预热」起步并写 warning)。同一资产、同一窗口、同一数据 ⇒ A/B 起点一致 ⇒ 持有基准一致。
 *   终点 = 窗口终点前最后一根已收盘 bar。
 * 分段:报告窗口(主资产)按时间 70/30 切成 in_sample / out_of_sample,切点对所有资产共用;每个资产各自给分段 metrics,
 *   交易按入场时间归段。分段只是标注,回测本身是一次连续全窗口运行。
 * 资产:默认 [主资产(非 BTC/ETH 时), BTCUSDT, ETHUSDT] + 篮子 BTC+ETH(两腿各半资金独立运行同一策略、独立记账、不再平衡,
 *   篮子净值 = 两腿逐根相加;基准同为 50/50 买入持有)。行情缺失的资产 status=data_missing,写原因,不补造。
 * 执行:默认执行器 = engine v4(research-spot-ir-v4,见 engine.ts);IR 带 order 块时走订单周期执行核(orders/executor.ts,research-orders-v1),
 *   模块加载时注册(setAssetExecutor 可替换,传 null 恢复缺省)。
 * 永续(order.market=perp):每个资产(含篮子两腿)改从 data/perp-market.ts 取 OKX SWAP 成交价 K 线 + 标记价 + 资金费 + 分档,
 *   数据集以 BTC-USDT-SWAP 形式落库(market=perp,不与现货数据集混用);资金费分界与重叠期偏差写进 asset.data.perp 与 warnings。
 */
import { randomUUID } from 'node:crypto';
import { validate, type BacktestAsset, type BacktestEquityPoint, type BacktestMetrics, type BacktestReport, type BacktestReportSummary, type BacktestScore, type BacktestSegmentMetrics, type BacktestTrade, type BacktestPlan, type BacktestPlanStats, type OrderGateParams, type ResearchBar, type ResearchDataset, type ResearchExecution, type ResearchRequest, type StrategyIR } from '@trading-swarm/contracts';
import type { ResearchStore } from './store.js';
import type { ResearchService } from './service.js';
import { emitBacktestReport, type BacktestReportMeta } from './hooks.js';
import { runReplay, FAST_ENGINE_VERSION, viewBars, type SignalCache } from './engine.js';
import { checkIR, irWarmup, irHistoryBars, timeframeMillis, resolveRequest } from './strategy.js';
import { orderGateFor } from './order-gate.js';
import { prewarmPineSeries } from './primitives/pine.js';
import { STRATEGY_SPEC_VERSION } from './strategy-spec.js';
import { hash } from './primitives.js';
import { analyze, cagrOf, capitalUsage, dailyPnl, downsample, periodReturns, score, sideBreakdown, strategyCapacity, tradeStats, type ClosedTrade, type EquitySample } from './analyzer.js';
import type { MarketData, Window } from './data/index.js';
import type { PerpMarket } from './data/perp-market.js';
import type { FundingSeries, MmrTier, OrderBar } from './orders/types.js';
import { pickOrderExecutor } from './orders/executor.js';
import { volTargetOf } from './primitives/sizing.js';
export const REPORT_VERSION = 'backtest-report/v1';
/** 统一预热:与策略无关的固定根数,保证同批策略同一起点;策略自身预热更长时才例外。 */
export const WARMUP_BARS = 300;
/** 多周期原语窗口前最多借的历史根数(5m 上日线 MA200 ≈ 5.8 万根) */
export const HISTORY_CAP = 60000;
export const IN_SAMPLE_FRACTION = 0.7;
export const BASKET_KEY = 'BTC+ETH';
// 仓位缺省 = 每笔 100% 可用资金(unit_notional,对齐 Horizon「% of equity 100%」,和买入持有同一敞口口径);旧缺省按 1% 风险、单笔 ≤25% 资金,平均敞口不到 1%,和持有对比没有意义(2026-09-23 实测)
export const DEFAULT_EXECUTION: ResearchExecution = { initial_cash: '10000', risk_fraction: '0.01', max_allocation: '1', fee_rate: '0.001', slippage_bps: '5', qty_step: '0.00000001', min_notional: '5', max_opens_per_day: 10, sizing_mode: 'unit_notional' };
export const FILL_MODEL = 'Nautilus 式 bar 撮合:信号在已收盘 bar 上判定,市价单下一根 open 成交(买入加滑点);止损为 stop-market、止盈为限价,开盘跳空穿过止损按开盘价成交、跳空越过止盈按止盈价成交;同一根里止损和止盈都被触及时按 bar 内路径定先后(开盘离最高价近走 O→H→L→C 先止盈,否则 O→L→H→C 先止损,相等时先止损);每次成交收 taker 手续费并按 slippage_bps 向不利方向滑点;现货只做多、不加杠杆;8 位定点记账。';
export const BASKET_WEIGHTING = 'BTC+ETH 篮子:初始资金 50/50 分给 BTCUSDT、ETHUSDT 两条腿,两腿各自独立运行同一策略、独立记账(现金不互借、不再平衡),篮子净值 = 两腿净值在共同时间点上逐根相加;交易起点取两腿中较晚者;持有基准同为 50/50 买入持有、不再平衡。';
export interface LoadedBars { bars: ResearchBar[]; source: string; snapshot_id?: string | null; note?: string; /** 永续路径:与 bars 同一来源的标记价/资金费/分档(data/perp-market.ts) */ perp?: PerpMarket }
export const ORDER_FILL_MODEL = '订单周期执行核(research-orders-v1,对齐 8794 影子回放 v11):信号在已收盘 bar 上判定,市价单下一根 open 成交(加不利滑点);限价单在时效窗口(1h 及以下 24h / 4h 及以上 72h / 其余 48h)内触价才成交,开盘已越过按更优 open,否则 no_fill;止损为 stop-market(跳空按更差 open)、多档止盈为限价(跳空按更优 open),同根止损止盈先止损;同向新信号未成交替换、已成交结转(roll);反向信号未成交撤单、已成交开盘反手;所有成交价钳制到当根高低;吃单 taker 费 + 滑点,挂单 maker 费无滑点。永续:逐仓强平按标记价(强平价 = 均价 x (1 -/+ 1/杠杆 +/- 维持保证金率),与止损同根时离开盘价近者先),真实 8h 资金费按 K 线粒度计入现金(多付空收)。';
export type BarsLoader = (symbol: string, timeframe: string, window: Window, signal?: AbortSignal) => Promise<LoadedBars>;
export interface BacktestJob {
  strategy_ir: StrategyIR;
  timeframe: string;
  /** 默认 [主资产?, BTCUSDT, ETHUSDT] + 篮子 BTC+ETH */
  symbols?: string[];
  from_ms?: number;
  to_ms?: number;
  title?: string;
  description?: string;
  meta: BacktestReportMeta;
  /** false 时不算 BTC+ETH 篮子 */
  basket?: boolean;
  /** 研究 loop:inquiry:step;同键重复调用直接返回已存报告 */
  idempotency_key?: string;
  /** 同一步骤的开发段 run(修订链用),写进 report.run_ids */
  run_ids?: string[];
  execution?: Partial<ResearchExecution>;
  timeout_ms?: number;
}
export interface BacktestDeps {
  store: ResearchStore;
  service: ResearchService;
  /** 行情来源;缺省用 OKX 公共数据层(okxMarketData) */
  market?: MarketData;
  /** 直接给 K 线(测试 / 研究 loop 的同一快照);优先于 market */
  loader?: BarsLoader;
  /** 数据首根时间探针(OKX 在上市前的窗口会返回空页);缺省用 ccxt since=0 */
  firstAt?: (symbol: string, timeframe: string, window: Window) => Promise<number | null>;
  /** 永续路径取数(order.market=perp);缺省 okxPerpLoader(data/perp-market.ts,本地 sqlite 缓存)。测试注入合成永续行情 */
  perpLoader?: BarsLoader;
}
/** 单资产执行器的输入输出 —— 订单周期执行核(WP-F)按这个接口挂进来。 */
export interface AssetPerpInput { mark: (OrderBar | null)[]; funding: FundingSeries; tiers: MmrTier[]; max_lever: number | null }
export interface AssetRunInput { judge?: import('./judge/index.js').JudgeRuntime; candidate_filter?: import('./orders/index.js').OrderPathInput['candidate_filter']; on_candidate?: import('./orders/index.js').OrderPathInput['on_candidate']; symbol: string; dataset: ResearchDataset; dataset_id: string; ir: StrategyIR; execution: ResearchExecution; order_gate: OrderGateParams; timeframe: string; from_ms: number; to_ms: number; cache: SignalCache; check: () => void; /** 订单执行核用:taker/maker 费率(永续缺省 0.05%/0.02%) */ fees?: { taker: string; maker?: string }; /** 永续:与 dataset.bars 下标对齐的标记价 + 资金费 + 分档 */ perp?: AssetPerpInput | null; segment_of?: (at: number) => 'in_sample' | 'out_of_sample' }
export interface AssetRunEquity { at: number; equity: number; holdings: number; exposure: number }
export interface AssetRunOutput { candidates?: import('./judge/filter.js').CandidateLog[]; status: 'completed' | 'failed'; error: string | null; engine_version: string; equity: AssetRunEquity[]; trades: Omit<BacktestTrade, 'segment'>[]; fees: number; plans?: BacktestPlan[]; plan_stats?: BacktestPlanStats | null; warnings?: string[] }
export type AssetExecutor = (input: AssetRunInput) => Promise<AssetRunOutput>;
// 模块加载即注册订单周期执行核(IR 带 order 块时);测试可替换,传 null 恢复这个缺省注册
let pickExecutor: (ir: StrategyIR) => AssetExecutor | null = pickOrderExecutor;
/** 订单周期执行核注册点:返回 null 表示这份 IR 用默认 engine v4;传 null 恢复缺省(order 块 → 订单执行核)。 */
export function setAssetExecutor(pick: ((ir: StrategyIR) => AssetExecutor | null) | null): void { pickExecutor = pick ?? pickOrderExecutor; }
/** 当前生效的单资产执行器(含 setAssetExecutor 的替换);改进环等不落报告的调用方用它,和全窗口报告保持同一口径 */
export function assetExecutorFor(ir: StrategyIR): AssetExecutor { return pickExecutor(ir) ?? engineExecutor; }
const noModel = async (): Promise<never> => { throw Error('backtest_report_model_forbidden'); };
/** 默认执行器:engine v4 快路径,纯 A 臂。 */
export const engineExecutor: AssetExecutor = async (x) => {
  const request: ResearchRequest = { idempotency_key: 'backtest-report', dataset_id: x.dataset_id, study_id: 'backtest-report', strategy_ir: x.ir, execution: x.execution, order_gate: x.order_gate, spec_version: STRATEGY_SPEC_VERSION, from_ms: x.from_ms, to_ms: x.to_ms, arms: ['a_rules'], repeats: 1, max_model_calls: 0, timeout_ms: 3600000, purpose: 'development', acknowledge_adaptive_search: false };
  const r = await runReplay(x.dataset, request, noModel, { fast: true, cache: x.cache, check: x.check });
  const arm = r.arms[0];
  if (!arm) return { status: 'failed', error: r.error ?? 'no_arm', engine_version: r.engine_version, equity: [], trades: [], fees: 0 };
  const step = x.dataset.timeframe_ms, groups = new Map<string, typeof arm.trades>();
  for (const t of arm.trades) groups.set(t.position_id, [...(groups.get(t.position_id) ?? []), t]);
  const trades = [...groups.entries()].map(([id, g]) => {
    const qty = g.reduce((a, t) => a + Number(t.qty), 0), notional = g.reduce((a, t) => a + Number(t.entry_price) * Number(t.qty), 0), pnl = g.reduce((a, t) => a + Number(t.net_pnl), 0), last = g.at(-1)!;
    return { id, symbol: x.symbol, side: 'long' as const, entry_at: g[0]!.entry_at, entry_price: Number(g[0]!.entry_price), exit_at: last.exit_at, exit_price: qty > 0 ? g.reduce((a, t) => a + Number(t.exit_price) * Number(t.qty), 0) / qty : Number(last.exit_price), qty, pnl, return_pct: notional > 0 ? pnl / notional : 0, fees: g.reduce((a, t) => a + Number(t.fees), 0), bars_held: Math.max(0, Math.round((last.exit_at - g[0]!.entry_at) / step)), exit_reason: last.reason };
  });
  const warnings: string[] = [];
  if (r.status === 'completed' && arm.equity.length && Number(arm.equity.at(-1)!.holdings) > 0) warnings.push(`${x.symbol} 期末仍有持仓,按最后收盘价盯市计入净值,不计入已平仓统计`);
  return { status: r.status === 'completed' ? 'completed' : 'failed', error: r.error, engine_version: r.engine_version, equity: arm.equity.map((e) => ({ at: e.at, equity: Number(e.equity), holdings: Number(e.holdings), exposure: e.exposure })), trades, fees: Number(arm.metrics.fees), warnings };
};
export function normalizeSymbol(s: string): string {
  const base = s.replace(/^okx:(spot|perp):/i, '').toUpperCase().replace(/-SWAP$/, '').replace(/[-/:_]/g, '');
  return base.endsWith('USDT') ? base : base + 'USDT';
}
export function defaultSymbols(primary: string | null | undefined): string[] {
  const p = primary ? normalizeSymbol(primary) : null;
  // 主资产排第一(问 ETH 时报告/答案先说 ETH),BTC、ETH 总在;篮子另算
  return [...new Set([...(p ? [p] : []), 'BTCUSDT', 'ETHUSDT'])];
}
/** 快照/交易所行 → 已收盘 ResearchBar(只收 close_time ≤ to 且 < now 的 bar,按 open_time 去重升序)。 */
export function rowsToBars(rows: Record<string, unknown>[], step: number, to_ms: number, now = Date.now()): ResearchBar[] {
  const m = new Map<number, ResearchBar>();
  for (const r of rows) {
    const open_time = Number(r.open_time ?? (r.ts !== undefined ? Number(r.ts) - step + 1 : NaN));
    if (!Number.isSafeInteger(open_time) || open_time < 0) continue;
    const close_time = open_time + step - 1;
    if (close_time > to_ms || close_time >= now) continue;
    const f = (k: string) => { const v = r[k]; const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) && n >= 0 ? n.toFixed(8).replace(/^(\d+\.\d{0,8}).*$/, '$1') : null; };
    const o = f('open'), h = f('high'), l = f('low'), c = f('close'), v = f('volume');
    if (!o || !h || !l || !c || !v || Number(l) <= 0 || Number(h) < Number(l)) continue;
    m.set(open_time, { open_time, close_time, available_at: close_time, open: o, high: h, low: l, close: c, volume: v });
  }
  return [...m.values()].sort((a, b) => a.open_time - b.open_time);
}
/** OKX 默认加载:先查已存 research_datasets 里同品种同周期最长的一段,只补缺的头尾;上市前的窗口先探首根再取。 */
export function okxLoader(deps: BacktestDeps): BarsLoader {
  let marketP: Promise<MarketData> | null = deps.market ? Promise.resolve(deps.market) : null;
  const market = () => (marketP ??= import('./data/index.js').then((m) => m.okxMarketData()));
  return async (symbol, timeframe, window, signal) => {
    const step = timeframeMillis(timeframe), m = await market();
    const base = symbol.replace(/USDT$/, ''), [inst] = await m.resolve({ symbols: [base], market: 'spot' }, signal);
    if (!inst) throw Error(`DATA_MISSING:OKX 没有 ${base}-USDT 现货`);
    const fetchRange = async (w: Window) => (w.to_ms - w.from_ms >= step ? rowsToBars((await m.price(inst, timeframe, w, signal)).rows as Record<string, unknown>[], step, window.to_ms).filter((b) => b.open_time >= w.from_ms) : []);
    const cached = cachedBars(deps.store, symbol, step);
    const have = cached.filter((b) => b.open_time >= window.from_ms - step && b.close_time <= window.to_ms);
    let bars: ResearchBar[], note: string | undefined;
    if (have.length && have[0]!.open_time <= window.from_ms + step) bars = mergeBars(have, await fetchRange({ from_ms: have.at(-1)!.open_time + step, to_ms: window.to_ms }));
    else if (have.length && have[0]!.open_time > window.from_ms + step) {
      // 已存数据从上市首根开始时,窗口起点之前那段在 OKX 上本来就是空的:数据层遇空页即停,只花一次请求就能确认,不必整段重取
      const head = await fetchRange({ from_ms: window.from_ms, to_ms: have[0]!.open_time - 1 });
      bars = mergeBars(mergeBars(head, have), await fetchRange({ from_ms: have.at(-1)!.open_time + step, to_ms: window.to_ms }));
    }
    else {
      bars = await fetchRange(window);
      // OKX 在上市前的时间段返回空页,数据层遇空页就停:只有这时才探首根(ccxt since=0),再从首根取
      if (!bars.length) {
        const first = await (deps.firstAt ?? okxFirstAt)(symbol, timeframe, window).catch(() => null);
        if (first !== null && first > window.from_ms && first < window.to_ms) { bars = await fetchRange({ from_ms: first, to_ms: window.to_ms }); note = `OKX 最早数据 ${new Date(first).toISOString().slice(0, 10)}`; }
      }
    }
    return { bars, source: `okx:spot:${timeframe}:public candles${have.length ? '(部分来自已存数据集)' : ''}`, ...(note ? { note } : {}) };
  };
}
/** 首根探针:OKX 带 since 的 K 线请求在上市前返回空,since=0 又会给最近一根,所以在 [from, to] 上二分「since 处有没有 bar」,约 log2(根数) 次请求。 */
async function okxFirstAt(symbol: string, timeframe: string, window: Window): Promise<number | null> {
  const { publicExchange } = await import('./market-ccxt.js');
  const c = await publicExchange('okx'), step = timeframeMillis(timeframe), pair = symbol.replace(/USDT$/, '') + '/USDT';
  const has = async (t: number) => (await c.fetchOHLCV(pair, timeframe, t, 1)).some((r) => typeof r[0] === 'number' && r[0] >= t && r[0] < t + 2 * step);
  try {
    let lo = Math.floor(window.from_ms / step) * step, hi = Math.floor((window.to_ms - step) / step) * step;
    if (await has(lo)) return lo;
    if (!(await has(hi))) return null;
    while (hi - lo > step) { const mid = lo + Math.floor((hi - lo) / 2 / step) * step; if (await has(mid)) hi = mid; else lo = mid; }
    return hi;
  } finally { await c.close?.(); }
}
export function mergeBars(a: ResearchBar[], b: ResearchBar[]): ResearchBar[] { const m = new Map<number, ResearchBar>(); for (const x of [...a, ...b]) m.set(x.open_time, x); return [...m.values()].sort((x, y) => x.open_time - y.open_time); }
function cachedBars(store: ResearchStore, symbol: string, step: number): ResearchBar[] {
  const rows = store.db.prepare("SELECT id, json_array_length(json,'$.bars') AS n FROM research_datasets WHERE json_extract(json,'$.symbol')=? AND json_extract(json,'$.timeframe_ms')=? AND json_extract(json,'$.venue')='okx' ORDER BY n DESC LIMIT 1").all(symbol, step) as { id: string; n: number }[];
  if (!rows[0]) return [];
  try { return store.dataset(rows[0].id).bars; } catch { return []; }
}
interface Prepared { symbol: string; status: 'ok' | 'data_missing'; error: string | null; dataset?: ResearchDataset; dataset_id?: string; snapshot_id?: string | null; source?: string; start?: number; end?: number; warmup?: number; borrowed?: boolean; warnings: string[]; perp?: AssetPerpInput; perpMeta?: PerpMarket }
/** 永续缺省取数:OKX SWAP 成交价 K 线 + 标记价 + 资金费(OKX 归档/REST,早于 OKX 覆盖的用币安代理)+ 分档,落本地 sqlite 缓存、增量拉取。 */
export function okxPerpLoader(): BarsLoader {
  return async (symbol, timeframe, window, signal) => {
    const { loadPerpMarket } = await import('./data/perp-market.js');
    const m = await loadPerpMarket({ inst_id: symbol, timeframe, from_ms: window.from_ms, to_ms: window.to_ms }, signal ? { signal } : {});
    if (!m.bars.length) throw Error(`DATA_MISSING:OKX 没有 ${m.inst_id} 永续 K 线(${m.provenance.notes.join(';').slice(0, 300)})`);
    return { bars: m.bars, source: `okx:perp:${m.inst_id}:${timeframe}:history-candles(成交价)+history-mark-price-candles(标记价)`, perp: m };
  };
}
const SEG_LABEL: Record<string, string> = { okx_archive: 'OKX 月度归档', okx_rest: 'OKX 官方 REST', binance_proxy: '币安代理' };
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
/** 资金费分界的一句话:按时间顺序列出每段来源、起止与期数,再接重叠期偏差。 */
export function fundingBoundary(m: PerpMarket): string {
  const f = m.funding_provenance, segs = f.segments ?? [];
  const parts = segs.map((x) => `${day(x.from_ms)}~${day(x.to_ms)} ${SEG_LABEL[x.source] ?? x.source}${x.source === 'binance_proxy' ? `(${f.proxy?.symbol ?? ''})` : ''} ${x.points} 期`);
  return `${m.inst_id} 资金费分界:${parts.length ? parts.join(';') : '无数据'}${f.gaps.length ? `;缺 ${f.gaps.length} 段` : ''};覆盖 ${f.coverage};重叠期偏差:${f.deviation_note}`;
}
/** 交易起点规则(见文件头):返回决策首根下标 start、末根 end。 */
export function tradingRange(bars: ResearchBar[], window: Window, warmup: number): { start: number; end: number; borrowed: boolean; warning: string | null } | null {
  let end = -1; for (let i = bars.length - 1; i >= 0; i--) if (bars[i]!.close_time <= window.to_ms) { end = i; break; }
  const firstIn = bars.findIndex((b) => b.open_time >= window.from_ms);
  const need = Math.max(WARMUP_BARS, warmup);
  let start: number, borrowed = false, warning: string | null = null;
  if (firstIn >= WARMUP_BARS && firstIn >= warmup) { start = firstIn; borrowed = true; }
  else { start = need; if (warmup > WARMUP_BARS) warning = `策略预热 ${warmup} 根超过统一预热 ${WARMUP_BARS} 根且窗口前没有足够数据可借,本策略起点晚于同批其他策略,持有基准随之变化`; }
  if (end < 0 || start >= end - 1) return null;
  return { start, end, borrowed, warning };
}
function benchmarkValues(bars: ResearchBar[], start: number, end: number, cash: number, e: ResearchExecution): Map<number, number> {
  // 首个可成交 open(决策首根的下一根)买入:含滑点与 taker 费;之后每根按收盘价 × (1-滑点) × (1-费率) 计清算价值,不再平衡
  const out = new Map<number, number>(), fee = Number(e.fee_rate), slip = Number(e.slippage_bps) / 1e4;
  out.set(bars[start]!.close_time - 1, cash); out.set(bars[start]!.close_time, cash);
  const qty = cash / (Number(bars[start + 1]!.open) * (1 + slip) * (1 + fee));
  for (let i = start + 1; i <= end; i++) out.set(bars[i]!.close_time, qty * Number(bars[i]!.close) * (1 - slip) * (1 - fee));
  return out;
}
interface AssetResult { asset: BacktestAsset; samples: EquitySample[]; closed: ClosedTrade[]; initial: number; engine_version: string; from: number; to: number }
function toClosed(t: Omit<BacktestTrade, 'segment'>): ClosedTrade { return { entry_at: t.entry_at, exit_at: t.exit_at, pnl: t.pnl, return_pct: t.return_pct, fees: t.fees, bars_held: t.bars_held, exit_reason: t.exit_reason, side: t.side }; }
function segmentMetrics(samples: EquitySample[], trades: ClosedTrade[], split: number, win: Window): BacktestSegmentMetrics[] {
  const out: BacktestSegmentMetrics[] = [];
  const is = samples.filter((s) => s.at <= split), baseIdx = is.length - 1, oos = baseIdx >= 0 ? samples.slice(baseIdx).filter((s, k) => k === 0 || s.at > split) : samples.filter((s) => s.at > split);
  const segs: [BacktestSegmentMetrics['name'], EquitySample[], ClosedTrade[], number, number][] = [['in_sample', is, trades.filter((t) => t.entry_at <= split), win.from_ms, split], ['out_of_sample', oos, trades.filter((t) => t.entry_at > split), split + 1, win.to_ms]];
  for (const [name, ss, ts, from_ms, to_ms] of segs) if (ss.length >= 2) out.push({ name, from_ms, to_ms, metrics: analyze(ss, ts, ts.reduce((a, t) => a + t.fees, 0)) });
  return out;
}
function equityPoints(samples: EquitySample[], initial: number): BacktestEquityPoint[] {
  let peak = -Infinity;
  const full = samples.map((s) => { peak = Math.max(peak, s.equity); return { at: s.at, equity: s.equity, pnl_pct: s.equity / initial - 1, drawdown: peak > 0 ? 1 - s.equity / peak : 0, benchmark_pct: s.benchmark === null ? null : s.benchmark / initial - 1, exposure: s.exposure }; });
  return downsample(full, 1000);
}
function buildAsset(key: string, label: string, kind: 'single' | 'basket', symbols: string[], samples: EquitySample[], trades: Omit<BacktestTrade, 'segment'>[], fees: number, initial: number, split: number, win: Window, data: BacktestAsset['data'], extra: Partial<BacktestAsset>): AssetResult {
  const closed = trades.map(toClosed), metrics = analyze(samples, closed, fees);
  const asset = { key, label, kind, symbols, status: 'completed', error: null, metrics, segments: segmentMetrics(samples, closed, split, win), equity: equityPoints(samples, initial), trades: trades.map((t) => ({ ...t, segment: t.entry_at <= split ? 'in_sample' as const : 'out_of_sample' as const })).slice(0, 20000), monthly_returns: periodReturns(samples, 'month').slice(-2000), yearly_returns: periodReturns(samples, 'year'), trade_stats: tradeStats(closed), data, window: win, side_breakdown: sideBreakdown(closed), daily_pnl: dailyPnl(samples), capital_usage: capitalUsage(samples), strategy_capacity: null, ...extra } as unknown as BacktestAsset;
  return { asset, samples, closed, initial, engine_version: extra.engine_version ?? FAST_ENGINE_VERSION, from: win.from_ms, to: win.to_ms };
}
const missingAsset = (key: string, label: string, kind: 'single' | 'basket', symbols: string[], status: 'failed' | 'data_missing', error: string): BacktestAsset => ({ key, label, kind, symbols, status, error, metrics: null, segments: [], equity: [], trades: [], monthly_returns: [], yearly_returns: [], trade_stats: null, data: null, window: null }) as unknown as BacktestAsset;
/** 篮子容量:每条腿只拿一半资金,篮子可容纳资金 = 2 × 两腿里较小的腿容量。 */
function basketCapacity(legs: ReturnType<typeof strategyCapacity>[]): ReturnType<typeof strategyCapacity> {
  const caps = legs.map((l) => l.capacity_usd);
  return { capacity_usd: caps.every((c) => c !== null) ? 2 * Math.min(...(caps as number[])) : null, participation_rate: legs[0]!.participation_rate, median_bar_quote_volume: legs.every((l) => l.median_bar_quote_volume !== null) ? Math.min(...legs.map((l) => l.median_bar_quote_volume!)) : null, avg_entry_fraction: legs.every((l) => l.avg_entry_fraction !== null) ? Math.max(...legs.map((l) => l.avg_entry_fraction!)) / 2 : null, method: legs[0]!.method + ';篮子每腿半仓,取较小腿容量 × 2' };
}
const tfLabel = (ms: number) => (ms % 86400000 === 0 ? `${ms / 86400000}d` : ms % 3600000 === 0 ? `${ms / 3600000}h` : `${ms / 60000}m`);
const DEFAULT_DAYS = (tf: string) => { const ms = timeframeMillis(tf); return ms >= 86400000 ? 3000 : ms >= 14400000 ? 2190 : ms >= 3600000 ? 730 : ms >= 1800000 ? 365 : ms >= 900000 ? 180 : 60; };
function perpProvenance(m: PerpMarket, x: AssetPerpInput): NonNullable<NonNullable<BacktestAsset['data']>['perp']> {
  const f = m.funding_provenance, first = x.tiers[0];
  return { instrument: m.inst_id, source: m.provenance.source.slice(0, 4000), mark_coverage: m.provenance.mark_coverage, mark_missing_bars: x.mark.filter((b) => !b).length, funding_coverage: f.coverage, funding_note: fundingBoundary(m).slice(0, 4000), funding_segments: (f.segments ?? []).slice(0, 200), funding_gaps: f.gaps.slice(0, 200), proxy_until_ms: f.proxy_until_ms, deviation_note: f.deviation_note.slice(0, 4000), max_lever: m.max_lever, maintenance_margin: x.tiers.length ? `OKX 逐仓分档 ${x.tiers.length} 档(当前值,不是历史值),第 1 档 ≤${first!.max_qty} 维持保证金率 ${first!.mmr}` : '分档拉取失败,按缺省 0.4%', flags: m.provenance.flags.slice(0, 50), notes: m.provenance.notes.map((n) => n.slice(0, 4000)).slice(0, 50) };
}
export async function runBacktestReport(deps: BacktestDeps, job: BacktestJob, signal?: AbortSignal): Promise<BacktestReport> {
  if (job.idempotency_key) { const prior = reportByKey(deps.store, job.idempotency_key); if (prior) return prior; }
  const started = Date.now(), deadline = started + Math.min(job.timeout_ms ?? 600000, 3600000);
  const check = () => { if (signal?.aborted) throw Error('CANCELLED'); if (Date.now() > deadline) throw Error('TIMEOUT:backtest_report_time_budget'); };
  const step = timeframeMillis(job.timeframe);
  // 报告是单资产逐个跑(篮子是两腿各自跑),没有资产池:universe.screen 用不上,剥掉并留痕(与 loop/backtest.ts 同一口径)
  let ir = job.strategy_ir; const warnings: string[] = [];
  if (ir.universe) { if (ir.universe.screen && Object.keys(ir.universe.screen).length) warnings.push(`单资产回测没有资产池,已忽略 universe.screen ${JSON.stringify(ir.universe.screen)}`); const { universe: _u, ...rest } = ir; ir = rest as StrategyIR; }
  const checked = checkIR(ir, job.timeframe);
  if (!checked.ok) throw Error('SCHEMA_MISMATCH:strategy_ir_checks_failed:' + checked.checks.filter((c) => !c.ok).map((c) => c.name).join(','));
  const resolved = resolveRequest({ idempotency_key: 'x', dataset_id: 'x', study_id: 'x', strategy_ir: ir, execution: { ...DEFAULT_EXECUTION, ...job.execution }, from_ms: 0, to_ms: 1, arms: ['a_rules'], repeats: 1, max_model_calls: 0, timeout_ms: 1000, purpose: 'development', acknowledge_adaptive_search: false });
  const execution = resolved.execution, order_gate = orderGateFor(ir), initial = Number(execution.initial_cash);
  // 订单块:市场/杠杆/方向;永续手续费缺省 taker 0.05% / maker 0.02%(只在调用方显式给 fee_rate 时跟随),现货沿用 execution.fee_rate
  const perp = ir.order?.market === 'perp', leverage = perp ? ir.order!.leverage ?? 1 : 1, shortSide = !!ir.order && ir.order.direction !== 'long';
  const fees = ir.order ? (perp ? { taker: job.execution?.fee_rate ?? '0.0005', maker: job.execution?.fee_rate ?? '0.0002' } : { taker: execution.fee_rate }) : undefined;
  const warmup = irWarmup(ir, step), now = Date.now();
  const to_ms = Math.min(job.to_ms ?? now, now), from_ms = job.from_ms ?? to_ms - DEFAULT_DAYS(job.timeframe) * 86400000;
  if (!(from_ms < to_ms)) throw Error('SCHEMA_MISMATCH:window_invalid');
  const symbols = [...new Set((job.symbols?.length ? job.symbols : defaultSymbols(job.meta.symbol)).filter((s) => s !== BASKET_KEY).map(normalizeSymbol))].slice(0, 8);
  const primarySymbol = job.meta.symbol ? normalizeSymbol(job.meta.symbol) : symbols[0]!;
  // 多周期原语(日线 MA60 放在 15m 上 = 5856 根)要的窗口前历史可以超过 5000:只多借数据,不进决策视图;不用它们的 IR history=0,借数与旧口径相同
  const history = irHistoryBars(ir, step), loader = perp ? deps.perpLoader ?? okxPerpLoader() : deps.loader ?? okxLoader(deps), borrow = history > 0 ? Math.max(Math.min(5000, Math.max(WARMUP_BARS, warmup)), Math.min(HISTORY_CAP, history)) : Math.min(5000, Math.max(WARMUP_BARS, warmup));
  // 1) 取数(含窗口前借来的预热),逐个资产落成 research_datasets(报告里留 dataset_id,回放取 candles 用)
  const prepared: Prepared[] = [];
  for (const symbol of symbols) {
    check();
    try {
      const got = await loader(symbol, job.timeframe, { from_ms: from_ms - borrow * step, to_ms }, signal);
      const bars = got.bars.filter((b) => b.close_time <= to_ms);
      if (bars.length < WARMUP_BARS + 3 && bars.length < warmup + 3) { prepared.push({ symbol, status: 'data_missing', error: `${symbol} ${job.timeframe} 只有 ${bars.length} 根已收盘 K 线,不够预热 ${Math.max(WARMUP_BARS, warmup)} 根${got.note ? ';' + got.note : ''}`, warnings: [] }); continue; }
      const range = tradingRange(bars, { from_ms, to_ms }, warmup);
      const before = range ? range.start : 0, historyNote = history > 0 && before < history ? `${symbol} 多周期原语需要窗口前 ${history} 根 ${job.timeframe} 历史,只借到 ${before} 根;高周期均线/背离在历史够之前判为不成立(不触发)` : null;
      if (!range) { prepared.push({ symbol, status: 'data_missing', error: `${symbol} 预热之后没有可交易的 bar`, warnings: [] }); continue; }
      if (perp && !got.perp) throw Error('DATA_MISSING:永续路径的取数没有返回标记价/资金费');
      // 永续数据集以 BTC-USDT-SWAP 落库(market=perp):现货取数按 symbol=BTCUSDT 复用已存数据集,不能误拿永续 K 线
      const dataset: ResearchDataset = { venue: 'okx', market: perp ? 'perp' : 'spot', symbol: perp ? got.perp!.inst_id : symbol, timeframe_ms: step, source: got.source, retrieved_at: Math.max(bars.at(-1)!.close_time + 1, now), bars };
      let perpIn: AssetPerpInput | undefined;
      if (perp) { const g = got.perp!, byOpen = new Map(got.bars.map((b, i) => [b.open_time, g.mark[i] ?? null])); perpIn = { mark: bars.map((b) => byOpen.get(b.open_time) ?? null), funding: g.funding, tiers: g.tiers, max_lever: g.max_lever }; }
      const put = deps.store.putMarketDataset(dataset, true);
      prepared.push({ symbol, status: 'ok', error: null, dataset, dataset_id: put.id, snapshot_id: got.snapshot_id ?? null, source: got.source, start: range.start, end: range.end, warmup, borrowed: range.borrowed, warnings: [...(range.warning ? [range.warning] : []), ...(historyNote ? [historyNote] : []), ...(got.note ? [`${symbol}:${got.note}`] : [])], ...(perpIn ? { perp: perpIn, perpMeta: got.perp! } : {}) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/CANCELLED/.test(msg) || signal?.aborted) throw Error('CANCELLED');
      prepared.push({ symbol, status: 'data_missing', error: `${symbol} 行情获取失败:${msg.slice(0, 300)}`, warnings: [] });
    }
  }
  const primaryPrep = prepared.find((p) => p.symbol === primarySymbol && p.status === 'ok') ?? prepared.find((p) => p.status === 'ok');
  const at = (p: Prepared, i: number) => p.dataset!.bars[i]!.close_time;
  const oks = prepared.filter((p) => p.status === 'ok');
  // 报告窗口 = 主资产交易窗口;切点对所有资产共用
  const win: Window = primaryPrep ? { from_ms: at(primaryPrep, primaryPrep.start!), to_ms: at(primaryPrep, primaryPrep.end!) } : { from_ms, to_ms };
  const split = win.from_ms + Math.floor((win.to_ms - win.from_ms) * IN_SAMPLE_FRACTION);
  const pickFor = pickExecutor?.(ir) ?? null, executor = pickFor ?? engineExecutor;
  const caches = new Map<string, SignalCache>();
  const run = async (p: Prepared, from: number, to: number, cash: number) => {
    check();
    if (!caches.has(p.symbol)) { caches.set(p.symbol, new Map()); await prewarmPineSeries(ir, p.dataset!.bars, step).catch(() => undefined); }
    return executor({ symbol: p.symbol, dataset: p.dataset!, dataset_id: p.dataset_id!, ir, execution: { ...execution, initial_cash: cash.toFixed(8).replace(/\.?0+$/, '') || '0' }, order_gate, timeframe: job.timeframe, from_ms: from, to_ms: to, cache: caches.get(p.symbol)!, check, ...(fees ? { fees } : {}), ...(p.perp ? { perp: p.perp } : {}), segment_of: (t: number) => (t <= split ? 'in_sample' : 'out_of_sample') });
  };
  const provenance = (p: Prepared, start: number): NonNullable<BacktestAsset['data']> => ({ source: p.source!, first_at: p.dataset!.bars[0]!.open_time, last_at: p.dataset!.bars.at(-1)!.close_time, bars: p.dataset!.bars.length, timeframe: job.timeframe, dataset_id: p.dataset_id!, snapshot_id: p.snapshot_id ?? null, warmup_bars: start, warmup_borrowed: !!p.borrowed, trading_from_ms: at(p, start), ...(p.perpMeta ? { market: 'perp' as const, perp: perpProvenance(p.perpMeta, p.perp!) } : {}) });
  const samplesOf = (eq: AssetRunEquity[], bench: Map<number, number>): EquitySample[] => eq.map((e) => ({ at: e.at, equity: e.equity, exposure: e.exposure, benchmark: bench.get(e.at) ?? null }));
  const capacityOf = (p: Prepared, s: number, e: number, out: AssetRunOutput, bench: Map<number, number>) => strategyCapacity(p.dataset!.bars.slice(s, e + 1).map((b) => Number(b.close) * Number(b.volume)), out.trades.map((t) => ({ at: t.entry_at, notional: t.qty * t.entry_price })), samplesOf(out.equity, bench));
  // 2) 单资产
  const results: AssetResult[] = [], assets: BacktestAsset[] = [], engines = new Set<string>(), legRuns = new Map<string, { out: AssetRunOutput; bench: Map<number, number> }>();
  for (const p of prepared) {
    const key = p.symbol, label = p.symbol.replace(/USDT$/, '');
    if (p.status !== 'ok') { assets.push(missingAsset(key, label, 'single', [p.symbol], 'data_missing', p.error!)); continue; }
    warnings.push(...p.warnings);
    const out = await run(p, at(p, p.start!), at(p, p.end!), initial);
    engines.add(out.engine_version); warnings.push(...(out.warnings ?? []));
    if (out.status !== 'completed') { assets.push(missingAsset(key, label, 'single', [p.symbol], 'failed', out.error ?? 'failed')); continue; }
    const bench = benchmarkValues(p.dataset!.bars, p.start!, p.end!, initial, execution);
    const r = buildAsset(key, label, 'single', [p.symbol], samplesOf(out.equity, bench), out.trades, out.fees, initial, split, { from_ms: at(p, p.start!), to_ms: at(p, p.end!) }, provenance(p, p.start!), { engine_version: out.engine_version, strategy_capacity: capacityOf(p, p.start!, p.end!, out, bench), ...(out.plans ? { plans: out.plans } : {}), ...(out.plan_stats !== undefined ? { plan_stats: out.plan_stats } : {}) });
    results.push(r); assets.push(r.asset);
  }
  // 3) BTC+ETH 篮子:两腿各半资金、共同起点(较晚者)与终点(较早者)
  const legs = ['BTCUSDT', 'ETHUSDT'].map((s) => prepared.find((p) => p.symbol === s));
  if (job.basket !== false && legs.every((l) => l)) {
    if (!legs.every((l) => l!.status === 'ok')) assets.push(missingAsset(BASKET_KEY, 'BTC+ETH', 'basket', ['BTCUSDT', 'ETHUSDT'], 'data_missing', legs.filter((l) => l!.status !== 'ok').map((l) => l!.error).join(';')));
    else {
      const from = Math.max(...legs.map((l) => at(l!, l!.start!))), to = Math.min(...legs.map((l) => at(l!, l!.end!)));
      const half = initial / 2, outs: { out: AssetRunOutput; bench: Map<number, number> }[] = [];
      for (const l of legs) {
        const p = l!, s = p.dataset!.bars.findIndex((b) => b.close_time >= from), e = p.dataset!.bars.findIndex((b) => b.close_time >= to);
        const out = await run(p, p.dataset!.bars[s]!.close_time, p.dataset!.bars[e]!.close_time, half);
        outs.push({ out, bench: benchmarkValues(p.dataset!.bars, s, e, half, execution) }); legRuns.set(p.symbol, outs.at(-1)!);
      }
      if (outs.some((o) => o.out.status !== 'completed')) assets.push(missingAsset(BASKET_KEY, 'BTC+ETH', 'basket', ['BTCUSDT', 'ETHUSDT'], 'failed', outs.map((o) => o.out.error).filter(Boolean).join(';') || 'failed'));
      else {
        const [a, b] = outs as [typeof outs[0], typeof outs[0]], bm = new Map(b.out.equity.map((x) => [x.at, x]));
        const samples: EquitySample[] = a.out.equity.filter((x) => bm.has(x.at)).map((x) => { const y = bm.get(x.at)!, eq = x.equity + y.equity, ba = a.bench.get(x.at), bb = b.bench.get(x.at); return { at: x.at, equity: eq, exposure: eq > 0 ? (x.holdings + y.holdings) / eq : 0, benchmark: ba !== undefined && bb !== undefined ? ba + bb : null, positions: (x.holdings > 0 ? 1 : 0) + (y.holdings > 0 ? 1 : 0) }; });
        const trades = [...a.out.trades, ...b.out.trades].sort((x, y) => x.exit_at - y.exit_at || x.entry_at - y.entry_at);
        const r = buildAsset(BASKET_KEY, 'BTC+ETH', 'basket', ['BTCUSDT', 'ETHUSDT'], samples, trades, a.out.fees + b.out.fees, initial, split, { from_ms: from, to_ms: to }, null, { engine_version: a.out.engine_version, per_symbol: outs.map((o, k) => { const eqAt = (at: number) => o.out.equity.find((x) => x.at === at)?.equity ?? half, pnl = eqAt(samples.at(-1)?.at ?? to) - eqAt(samples[0]?.at ?? from); return { symbol: legs[k]!.symbol, trades: o.out.trades.length, pnl, win_rate: o.out.trades.length ? o.out.trades.filter((t) => t.pnl > 0).length / o.out.trades.length : null, contribution: pnl / initial }; }) as BacktestAsset['per_symbol'], strategy_capacity: basketCapacity(legs.map((l, k) => capacityOf(l!, l!.dataset!.bars.findIndex((b) => b.close_time >= from), l!.dataset!.bars.findIndex((b) => b.close_time >= to), outs[k]!.out, outs[k]!.bench))) });
        results.push(r); assets.push(r.asset);
      }
    }
  }
  // 永续/做空口径:数据来源与资金费分界逐资产写明;做空时持有基准仍是买入持有
  if (perp) for (const p of oks) if (p.perpMeta) {
    const m = p.perpMeta; warnings.push(`${p.symbol} 永续数据:OKX ${m.inst_id} 成交价 K 线 + 标记价 K 线(缺 ${p.perp!.mark.filter((x) => !x).length} 根标记价,缺的根强平退回成交价)`, fundingBoundary(m));
    if (m.max_lever !== null && leverage > m.max_lever) warnings.push(`${p.symbol} 杠杆 ${leverage} 倍超过 OKX 当前分档最高 ${m.max_lever} 倍,只作研究`);
  }
  if (perp) warnings.push('永续维持保证金分档用的是 OKX 当前值,不是历史值;强平按逐仓、标记价判定');
  if (shortSide) warnings.push(`策略${ir.order!.direction === 'both' ? '含做空' : '做空'}:持有基准仍是买入持有(做多),超额收益里含方向差,不是同方向对照`);
  if (ir.order) warnings.push(`订单周期执行核(${[...engines][0] ?? 'research-orders-v1'}):分段、基准与 analyzer 指标口径不变;计划统计见各资产 plan_stats`);
  // 4) 评分与报告
  const primary = results.find((r) => r.asset.key === primarySymbol) ?? results[0];
  const pm = primary?.asset.metrics ?? null;
  const benchCagr = primary ? cagrOf(primary.samples[0]!.benchmark ?? 0, primary.samples.at(-1)!.benchmark ?? 0, primary.from, primary.to) : null;
  const sc = pm ? score(pm, { in_sample: primary!.asset.segments.find((s) => s.name === 'in_sample')?.metrics ?? null, out_of_sample: primary!.asset.segments.find((s) => s.name === 'out_of_sample')?.metrics ?? null }, benchCagr) : ({ value: 0, label: 'poor', confidence: 'low', confidence_reason: 'Low confidence, 0 trades', components: [{ key: 'no_data', value: 0, weight: 1, note: '主资产没有可用行情或回测失败' }] } as BacktestScore);
  if (pm && pm.trades < 30) warnings.push(`主资产全窗口只有 ${pm.trades} 笔平仓,低于 30 笔纪律线,只作观察`);
  if (!oks.length) warnings.push('所有资产行情都缺失,报告没有回测结果');
  const ir_hash = hash(ir), id = randomUUID(), created_at = Date.now();
  const report = {
    id, created_at, engine_version: [...engines][0] ?? FAST_ENGINE_VERSION, title: (job.title ?? ir.label).slice(0, 300), description: (job.description ?? ir.description ?? '').slice(0, 4000), strategy_ir_hash: ir_hash, strategy_ir: ir, timeframe: job.timeframe,
    window: win, segments: [{ name: 'in_sample', from_ms: win.from_ms, to_ms: split }, { name: 'out_of_sample', from_ms: split + 1, to_ms: win.to_ms }],
    execution: { initial_cash: initial, fee_rate: Number(fees?.taker ?? execution.fee_rate), slippage_bps: Number(execution.slippage_bps), sizing_mode: (volTargetOf(ir) ? `波动率目标仓位(目标年化 ${Math.round(volTargetOf(ir)!.target_vol * 100)}%:每笔 × min(1, 目标/入场前实现波动));` : '') + (ir.order ? `${execution.sizing_mode === 'unit_notional' ? '每笔首腿保证金 = 100% 可用权益' : `每笔首腿保证金 = ${Number(execution.max_allocation) * 100}% 权益`}${perp ? `,永续 ${leverage} 倍杠杆(名义 = 保证金 × ${leverage}),逐仓` : ',现货不加杠杆'};加仓腿等权分摊首腿额度${perp ? `;吃单 ${Number(fees!.taker) * 100}% / 挂单 ${Number(fees!.maker) * 100}%` : ''}` : execution.sizing_mode === 'unit_notional' ? 'unit_notional(每笔 100% 可用资金,现货不加杠杆;和买入持有同一敞口口径)' : `${execution.sizing_mode ?? 'risk_fraction'}(每笔风险 ${Number(execution.risk_fraction) * 100}% 权益,单笔最多 ${Number(execution.max_allocation) * 100}% 资金)`), fill_model: ir.order ? ORDER_FILL_MODEL : FILL_MODEL, basket_weighting: BASKET_WEIGHTING, market: perp ? 'perp' : 'spot', leverage, view_bars: `每根决策只看最近 ${viewBars(ir, resolved.policy, step)} 根已收盘 K 线(6×预热,500–5000);统一预热 ${WARMUP_BARS} 根` },
    primary_key: primary?.asset.key ?? primarySymbol, assets, score: sc, run_ids: (job.run_ids ?? []).slice(0, 32), inquiry_id: job.meta.inquiry_id, session_id: job.meta.session_id, strategy_id: null, strategy_version: null, warnings: [...new Set(warnings)].slice(0, 64).map((w) => w.slice(0, 4000)),
  } as unknown as BacktestReport;
  const checkedReport = validate('research-backtest', report);
  if (!checkedReport.ok) throw Error('SCHEMA_MISMATCH:backtest_report:' + checkedReport.errors.slice(0, 5).join(';'));
  deps.store.db.prepare('INSERT INTO research_backtests(id,created_at,strategy_ir_hash,strategy_id,strategy_version,inquiry_id,session_id,idempotency_key,run_id,report_json,summary_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, created_at, ir_hash, null, null, job.meta.inquiry_id, job.meta.session_id, job.idempotency_key ?? null, job.run_ids?.[0] ?? null, JSON.stringify(report), JSON.stringify(summaryOf(report)));
  const link = emitBacktestReport(report, job.meta);
  if (link) {
    report.strategy_id = link.strategy_id; report.strategy_version = link.strategy_version;
    deps.store.db.prepare('UPDATE research_backtests SET strategy_id=?,strategy_version=?,report_json=?,summary_json=? WHERE id=?').run(link.strategy_id, link.strategy_version, JSON.stringify(report), JSON.stringify(summaryOf(report)), id);
  }
  return report;
}
export function summaryOf(r: BacktestReport): BacktestReportSummary {
  const p = r.assets.find((a) => a.key === r.primary_key);
  const eq = p?.equity ?? [], stride = Math.max(1, Math.ceil(eq.length / 120));
  const spark = eq.filter((_, i) => i % stride === 0).map((e) => e.pnl_pct);
  if (eq.length && (eq.length - 1) % stride !== 0) spark.push(eq.at(-1)!.pnl_pct);
  return { id: r.id, created_at: r.created_at, title: r.title, timeframe: r.timeframe, primary_key: r.primary_key, strategy_ir_hash: r.strategy_ir_hash, strategy_id: r.strategy_id, strategy_version: r.strategy_version, score: r.score, metrics: p?.metrics ?? null, sparkline: spark.slice(0, 120) };
}
export function getBacktestReport(store: ResearchStore, id: string): BacktestReport | null {
  const row = store.db.prepare('SELECT report_json FROM research_backtests WHERE id=?').get(id) as { report_json: string } | undefined;
  return row ? (JSON.parse(row.report_json) as BacktestReport) : null;
}
export function reportByKey(store: ResearchStore, key: string): BacktestReport | null {
  const row = store.db.prepare('SELECT report_json FROM research_backtests WHERE idempotency_key=?').get(key) as { report_json: string } | undefined;
  return row ? (JSON.parse(row.report_json) as BacktestReport) : null;
}
export function reportForRun(store: ResearchStore, run_id: string): BacktestReport | null {
  const row = store.db.prepare('SELECT report_json FROM research_backtests WHERE run_id=? ORDER BY created_at DESC LIMIT 1').get(run_id) as { report_json: string } | undefined;
  return row ? (JSON.parse(row.report_json) as BacktestReport) : null;
}
export function listBacktestReports(store: ResearchStore, q: { strategy_id?: string | null; limit?: number } = {}): BacktestReportSummary[] {
  const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
  const rows = (q.strategy_id ? store.db.prepare('SELECT summary_json FROM research_backtests WHERE strategy_id=? ORDER BY created_at DESC LIMIT ?').all(q.strategy_id, limit) : store.db.prepare('SELECT summary_json FROM research_backtests ORDER BY created_at DESC LIMIT ?').all(limit)) as { summary_json: string }[];
  return rows.map((r) => JSON.parse(r.summary_json) as BacktestReportSummary);
}
/** 回放取 candles 用(WP-F 的 /replay):按报告里的 dataset_id 还原该资产整段 K 线。 */
export function reportBars(store: ResearchStore, report: BacktestReport, asset_key: string): ResearchBar[] | null {
  const a = report.assets.find((x) => x.key === asset_key);
  const id = a?.data?.dataset_id;
  return id ? store.dataset(id).bars : null;
}
export const _test = { tfLabel };
