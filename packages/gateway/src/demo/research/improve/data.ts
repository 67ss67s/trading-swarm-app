/**
 * 冻结数据与切段(改进环第一阶段,设计第一节)。
 *
 * 冻结:资产池(缺省 BTC/ETH/SOL/DOGE/XRP/BNB 现货)× 周期(缺省 1h)× 时间段(缺省最近 730 天)。
 *   取数走 backtest-report 的 okxLoader(先复用 research_datasets 里已存的同品种同周期数据,只补缺的头尾),
 *   窗口起点前多借 WARMUP_BARS(300)根当预热,整段以 research_datasets 落库,dataset_id 写进任务;
 *   重跑时带同一组 dataset_ids 就不再联网,结果逐字一致。
 * 切段(全部落在参考资产真实 bar 的 close_time 上,闭区间):
 *   可评估的 bar = 窗口起点之后、且前面已有 ≥ 300 根预热的 bar;按根数前 50% 训练 / 中 25% 验证 / 后 25% 留出;
 *   训练段再按根数等分成 4 折滚动前推(连续不重叠,余数给最后一折)。验证/留出段的预热向前借(借的是更早的行情,只算指标,不算成绩)。
 *   参考资产 = 资产池里 bar 最多的那个(并列取池里靠前的),其余资产按 close_time 对齐到同一组边界。
 */
import type { ResearchBar, ResearchDataset } from '@trade-gate/contracts';
import type { ResearchStore } from '../store.js';
import type { ResearchService } from '../service.js';
import { okxLoader, okxPerpLoader, normalizeSymbol, WARMUP_BARS, type AssetPerpInput, type BarsLoader } from '../backtest-report.js';
import { timeframeMillis } from '../strategy.js';
import type { FrozenAsset, FrozenData, Segments } from './types.js';

export const DEFAULT_UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'BNBUSDT'];
export const DEFAULT_TIMEFRAME = '1h';
export const DEFAULT_DAYS = 730;
export const FOLDS = 4;
export const SPLIT = { train: 0.5, validation: 0.25, holdout: 0.25 } as const;
/** 设计要求资产池 ≥ 4 个;少于这个数照跑,但写进 notes。 */
export const MIN_UNIVERSE = 4;

export interface FreezeSpec { universe: string[]; timeframe: string; from_ms: number; to_ms: number; dataset_ids?: Record<string, string>;
  /** 缺省 spot;perp 时取数走永续加载器(成交价 K 线 + 标记价 + 资金费 + 分档),各资产带 perp 输入(2026-09-23 补) */
  market?: 'spot' | 'perp' }
export interface FrozenResult { data: FrozenData; notes: string[]; dataset_ids: Record<string, string> }

/** 切段(见文件头)。bars 是参考资产整段(含预热),from_ms 是评估窗口起点。 */
export function makeSegments(bars: ResearchBar[], from_ms: number, warmup = WARMUP_BARS, folds = FOLDS): Segments {
  const firstIn = bars.findIndex((b) => b.close_time >= from_ms);
  if (firstIn < 0) throw Error('DATA_MISSING:improve_window_has_no_bars');
  const s0 = Math.max(firstIn, warmup), n = bars.length - s0;
  if (n < 4 * folds + 8) throw Error(`DATA_MISSING:improve_window_too_short:${n}_bars_after_warmup`);
  const nTrain = Math.floor(n * SPLIT.train), nVal = Math.floor(n * SPLIT.validation);
  const at = (i: number) => bars[i]!.close_time;
  const train = { from_ms: at(s0), to_ms: at(s0 + nTrain - 1) };
  const validation = { from_ms: at(s0 + nTrain), to_ms: at(s0 + nTrain + nVal - 1) };
  const holdout = { from_ms: at(s0 + nTrain + nVal), to_ms: at(bars.length - 1) };
  const size = Math.floor(nTrain / folds), out: Segments['folds'] = [];
  for (let k = 0; k < folds; k++) { const a = s0 + k * size, b = k === folds - 1 ? s0 + nTrain - 1 : a + size - 1; out.push({ from_ms: at(a), to_ms: at(b) }); }
  return { folds: out, train, validation, holdout };
}

/** 冻结资产池数据:逐资产取数(或按 dataset_ids 还原)→ 落库 → 以参考资产切段。 */
export async function freezeData(store: ResearchStore, spec: FreezeSpec, opts: { loader?: BarsLoader; signal?: AbortSignal; progress?: (note: string) => void } = {}): Promise<FrozenResult> {
  const step = timeframeMillis(spec.timeframe), notes: string[] = [], assets: FrozenAsset[] = [], ids: Record<string, string> = {};
  const universe = [...new Set(spec.universe.map(normalizeSymbol))];
  const perpMarket = spec.market === 'perp';
  if (perpMarket && spec.dataset_ids && Object.keys(spec.dataset_ids).length) throw Error('NOT_SUPPORTED:improve_perp_dataset_ids_restore(永续的资金费/标记价不在 research_datasets 里,按 dataset_ids 还原不完整)');
  const loader = opts.loader ?? (perpMarket ? okxPerpLoader() : okxLoader({ store, service: null as unknown as ResearchService }));
  for (const symbol of universe) {
    if (opts.signal?.aborted) throw Error('CANCELLED');
    try {
      let dataset: ResearchDataset, id: string, perp: AssetPerpInput | null = null;
      const frozenId = spec.dataset_ids?.[symbol];
      if (frozenId) { dataset = store.dataset(frozenId); id = frozenId; if (dataset.timeframe_ms !== step) throw Error(`dataset ${frozenId} 周期不是 ${spec.timeframe}`); }
      else {
        opts.progress?.(`取数 ${symbol} ${spec.timeframe}`);
        // 多借一根:窗口起点所在 bar 的 open 在 from_ms 之前,要让它前面有满 300 根
        const borrow = spec.from_ms - (WARMUP_BARS + 1) * step;
        const got = await loader(symbol, spec.timeframe, { from_ms: borrow, to_ms: spec.to_ms }, opts.signal);
        const bars = got.bars.filter((b) => b.close_time <= spec.to_ms && b.open_time >= borrow);
        if (bars.length < WARMUP_BARS + 4 * FOLDS + 8) { notes.push(`${symbol} 只有 ${bars.length} 根已收盘 K 线,不够预热 + 切段,剔出资产池${got.note ? ';' + got.note : ''}`); continue; }
        if (perpMarket) {
          if (!got.perp) throw Error('DATA_MISSING:永续取数没有返回资金费/标记价');
          const g = got.perp, byOpen = new Map(got.bars.map((b, i) => [b.open_time, g.mark[i] ?? null]));
          perp = { mark: bars.map((b) => byOpen.get(b.open_time) ?? null), funding: g.funding, tiers: g.tiers, max_lever: g.max_lever };
        }
        // 永续数据集以 XXX-USDT-SWAP、market=perp 落库(与 backtest-report 同),现货取数不会误拿
        dataset = { venue: 'okx', market: perpMarket ? 'perp' : 'spot', symbol: perpMarket ? got.perp!.inst_id : symbol, timeframe_ms: step, source: got.source, retrieved_at: Math.max(bars.at(-1)!.close_time + 1, Date.now()), bars };
        id = store.putMarketDataset(dataset, true).id;
        if (got.note) notes.push(`${symbol}:${got.note}`);
      }
      const first = dataset.bars.findIndex((b) => b.close_time >= spec.from_ms);
      if (first >= 0 && first < WARMUP_BARS) notes.push(`${symbol} 窗口起点前只有 ${first} 根,前 ${WARMUP_BARS - first} 根评估 bar 让给预热`);
      assets.push({ symbol, dataset_id: id, bars: dataset.bars, ...(perp ? { perp } : {}) }); ids[symbol] = id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/CANCELLED/.test(msg) || opts.signal?.aborted) throw Error('CANCELLED');
      notes.push(`${symbol} 取数失败,剔出资产池:${msg.slice(0, 300)}`);
    }
  }
  if (!assets.length) throw Error('DATA_MISSING:improve_universe_empty:' + notes.join(';').slice(0, 500));
  if (assets.length < MIN_UNIVERSE) notes.push(`资产池只有 ${assets.length} 个资产,少于设计要求的 ${MIN_UNIVERSE} 个,结论只作观察`);
  const ref = [...assets].sort((a, b) => b.bars.length - a.bars.length || universe.indexOf(a.symbol) - universe.indexOf(b.symbol))[0]!;
  const segments = makeSegments(ref.bars, spec.from_ms);
  notes.push(`切段参考资产 ${ref.symbol}:训练 ${iso(segments.train.from_ms)}~${iso(segments.train.to_ms)}(4 折),验证 ${iso(segments.validation.from_ms)}~${iso(segments.validation.to_ms)},留出 ${iso(segments.holdout.from_ms)}~${iso(segments.holdout.to_ms)}`);
  return { data: { universe: assets.map((a) => a.symbol), timeframe: spec.timeframe, timeframe_ms: step, assets, segments, warmup_bars: WARMUP_BARS, market: perpMarket ? 'perp' : 'spot' }, notes, dataset_ids: ids };
}
const iso = (t: number) => new Date(t + 1).toISOString().slice(0, 13).replace('T', ' ') + 'h';
/** 冻结数据的可持久化摘要(不含 K 线)。 */
export function frozenSummary(d: FrozenData, ids: Record<string, string>) {
  return { universe: d.universe, market: d.market ?? 'spot', timeframe: d.timeframe, timeframe_ms: d.timeframe_ms, warmup_bars: d.warmup_bars, segments: d.segments, dataset_ids: ids, bars: Object.fromEntries(d.assets.map((a) => [a.symbol, a.bars.length])) };
}
