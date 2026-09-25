/** 确定性分析(§9.44):输入不可变快照,输出 typed metrics + 底表;无效分母 / NaN / 短样本一律给 status,不给 0。 */
import { factorDecompose, factorMetrics } from '../factor.js';
import { timeframeMillis } from '../strategy.js';
import type { SnapshotDraft } from './index.js';
export const ANALYSES_VERSION = 'analyses/v1';
export interface MetricValue { value: number | null; unit: string; status: 'ok' | 'insufficient' | 'not_applicable'; note?: string }
const mv = (value: number | null, unit: string, note?: string): MetricValue => (value === null || !Number.isFinite(value) ? { value: null, unit, status: 'insufficient', ...(note ? { note } : {}) } : { value, unit, status: 'ok', ...(note ? { note } : {}) });
const na = (unit: string, note: string): MetricValue => ({ value: null, unit, status: 'not_applicable', note });
const pct = (v: number | null) => (v === null ? '未知' : `${(v * 100).toFixed(2)}%`);
const closes = (s: SnapshotDraft) => s.rows.map((r) => ({ t: Number(r.close_time), c: Number(r.close) })).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.c) && x.c > 0);
export interface RelativeStrengthRow { canonical_id: string; bars: number; return: MetricValue; beta: MetricValue; alpha_annualized: MetricValue; residual_sharpe: MetricValue; max_drawdown: MetricValue }
export interface RelativeStrengthResult { benchmark: string; window: { from_ms: number; to_ms: number }; rows: RelativeStrengthRow[]; observation: string; method_version: string; warnings: string[] }
/** 各资产对基准的对数收益 OLS(复用 factor.ts);对齐按 close_time 交集;样本不足给 insufficient。 */
export function analyzeRelativeStrength(prices: SnapshotDraft[], benchmark: SnapshotDraft): RelativeStrengthResult {
  const warnings: string[] = [], step = benchmark.frequency ? timeframeMillis(benchmark.frequency) : 3600_000, ppy = (365 * 86400_000) / step;
  const bench = new Map(closes(benchmark).map((x) => [x.t, x.c]));
  const rows = prices.map((p) => {
    const own = closes(p).filter((x) => bench.has(x.t)); const n = own.length;
    if (n < 2) return { canonical_id: p.instrument.canonical_id, bars: n, return: mv(null, 'fraction'), beta: mv(null, 'ratio'), alpha_annualized: mv(null, 'fraction_per_year'), residual_sharpe: mv(null, 'ratio'), max_drawdown: mv(null, 'fraction') };
    const r: number[] = [], m: number[] = [];
    for (let i = 1; i < n; i++) { r.push(Math.log(own[i]!.c / own[i - 1]!.c)); m.push(Math.log(bench.get(own[i]!.t)! / bench.get(own[i - 1]!.t)!)); }
    const total = own.at(-1)!.c / own[0]!.c - 1, raw = factorMetrics(r, m, ppy);
    let beta: number | null = null, alpha: number | null = null, rs: number | null = null;
    try { const f = factorDecompose(r, m, { window_bars: Math.max(2, Math.min(168, Math.floor(r.length / 2))), periods_per_year: ppy }); if (f.status === 'ok') { beta = f.beta ?? null; alpha = f.alpha_annualized ?? null; rs = f.residual?.sharpe ?? null; } else warnings.push(`${p.instrument.canonical_id}: ${f.note}`); } catch (e) { warnings.push(`${p.instrument.canonical_id}: ${String(e)}`); }
    return { canonical_id: p.instrument.canonical_id, bars: n, return: mv(total, 'fraction'), beta: mv(beta, 'ratio', beta === null ? '至少 100 根同周期样本' : undefined), alpha_annualized: mv(alpha, 'fraction_per_year'), residual_sharpe: mv(rs, 'ratio'), max_drawdown: mv(raw.max_drawdown, 'fraction') };
  });
  const name = (id: string) => id.replace(/^okx:(spot|perp):/, '').replace(/-USDT(-SWAP)?$/, '');
  const ranked = rows.filter((r) => r.return.status === 'ok').sort((a, b) => (b.residual_sharpe.value ?? -Infinity) - (a.residual_sharpe.value ?? -Infinity));
  const parts = ranked.map((r) => `${name(r.canonical_id)} 区间收益 ${pct(r.return.value)}${r.beta.status === 'ok' ? `,β ${r.beta.value!.toFixed(2)},剔除大盘后残差 Sharpe ${r.residual_sharpe.value === null ? '未知' : r.residual_sharpe.value.toFixed(2)}` : '(样本不足,未算 β)'}`);
  const benchRow = closes(benchmark); const benchRet = benchRow.length >= 2 ? benchRow.at(-1)!.c / benchRow[0]!.c - 1 : null;
  const strong = ranked.filter((r) => r.residual_sharpe.status === 'ok' && r.residual_sharpe.value! > 0).map((r) => name(r.canonical_id));
  const observation = `观察:基准 ${name(benchmark.instrument.canonical_id)} 区间收益 ${pct(benchRet)};${parts.join(';')}。${strong.length ? `剔除大盘 β 后仍有正残差的是 ${strong.join('、')}` : '剔除大盘 β 后没有资产留下正残差,涨幅主要来自大盘'};这是本窗口的观察,不是对后市的判断`;
  return { benchmark: benchmark.instrument.canonical_id, window: benchmark.requested_window, rows, observation, method_version: ANALYSES_VERSION, warnings };
}
export interface LeverageResult { price_change: MetricValue; oi_change: MetricValue; funding_avg: MetricValue; funding_last: MetricValue; funding_pctile_vs_window: MetricValue; liquidation_count: MetricValue; observation: string; aligned: { ts: number; close: number | null; oi_value_usd: number | null; funding_rate: number | null }[]; method_version: string; warnings: string[] }
/** 杠杆升温观察:价格 / OI / 资金费按价格网格对齐(OI 取 ≤ts 最近值,资金费只在结算点落值),只给观察不给方向判断。 */
export function analyzeLeverage(price: SnapshotDraft, funding: SnapshotDraft | null, oi: SnapshotDraft | null, liq: SnapshotDraft | null): LeverageResult {
  const warnings: string[] = [], px = closes(price);
  const oiRows = (oi?.rows ?? []).map((r) => ({ t: Number(r.ts), v: r.oi_value_usd === null ? null : Number(r.oi_value_usd) })).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  const fRows = (funding?.rows ?? []).map((r) => ({ t: Number(r.ts), v: Number(r.rate) })).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
  let oiIdx = 0; const fMap = new Map(fRows.map((x) => [Math.floor(x.t / 3600_000) * 3600_000, x.v]));
  const aligned = px.map((p) => { while (oiIdx + 1 < oiRows.length && oiRows[oiIdx + 1]!.t <= p.t) oiIdx++; const o = oiRows.length && oiRows[oiIdx]!.t <= p.t ? oiRows[oiIdx]!.v : null; return { ts: p.t, close: p.c, oi_value_usd: o, funding_rate: fMap.get(Math.floor(p.t / 3600_000) * 3600_000) ?? null }; });
  const price_change = px.length >= 2 ? px.at(-1)!.c / px[0]!.c - 1 : null;
  const oiVals = oiRows.map((x) => x.v).filter((v): v is number => v !== null && v > 0);
  const oi_change = oi === null || oi.coverage === 'not_applicable' ? na('fraction', oi === null ? '未取持仓量' : '现货没有持仓量') : mv(oiVals.length >= 2 ? oiVals.at(-1)! / oiVals[0]! - 1 : null, 'fraction');
  const fVals = fRows.map((x) => x.v);
  const funding_avg = funding === null || funding.coverage === 'not_applicable' ? na('fraction_per_8h', funding === null ? '未取资金费' : '现货没有资金费') : mv(fVals.length ? fVals.reduce((a, b) => a + b, 0) / fVals.length : null, 'fraction_per_8h');
  const funding_last = funding === null || funding.coverage === 'not_applicable' ? na('fraction_per_8h', '') : mv(fVals.length ? fVals.at(-1)! : null, 'fraction_per_8h');
  const last = fVals.at(-1); const pctile = fVals.length >= 10 && last !== undefined ? fVals.filter((v) => v <= last).length / fVals.length : null;
  const funding_pctile_vs_window = funding === null || funding.coverage === 'not_applicable' ? na('fraction', '') : mv(pctile, 'fraction', fVals.length < 10 ? '窗口内不足 10 期结算' : '最近一期在本窗口内的分位,不是全历史');
  const liquidation_count = liq === null ? na('count', '未取强平') : liq.coverage === 'not_applicable' ? na('count', '现货没有强平') : mv(liq.rows.length, 'count', liq.coverage === 'partial' ? '公共接口只给最近记录,窗口未完整覆盖' : undefined);
  if (oi && oi.coverage === 'partial') warnings.push('持仓量窗口只部分覆盖'); if (funding && funding.coverage === 'partial') warnings.push('资金费窗口只部分覆盖'); if (price.coverage !== 'available') warnings.push('价格窗口只部分覆盖');
  const parts = [`观察:窗口内价格 ${pct(price_change)}`];
  if (oi_change.status === 'ok') parts.push(`持仓量(USD)${pct(oi_change.value)}`); else if (oi_change.status === 'not_applicable') parts.push(oi_change.note ?? '');
  if (funding_avg.status === 'ok') parts.push(`资金费均值 ${(funding_avg.value! * 100).toFixed(4)}%/8h,最近一期 ${funding_last.value === null ? '未知' : (funding_last.value * 100).toFixed(4) + '%'}${pctile !== null ? `(处于本窗口第 ${Math.round(pctile * 100)} 百分位)` : ''}`);
  if (liquidation_count.status === 'ok') parts.push(`已记录强平 ${liquidation_count.value} 笔${liquidation_count.note ? '(' + liquidation_count.note + ')' : ''}`);
  const rising = oi_change.status === 'ok' && oi_change.value! > 0 && price_change !== null && price_change > 0;
  const hot = funding_avg.status === 'ok' && funding_avg.value! > 0.0001;
  parts.push(rising && hot ? '价格与持仓量同涨且资金费高于 0.01%/8h,这段上涨伴随杠杆多头拥挤的迹象;这是观察,不是方向判断' : rising ? '价格与持仓量同涨,但资金费未明显偏高,杠杆升温迹象有限' : '没有价格与持仓量同涨的组合,看不出杠杆升温;这是观察,不是方向判断');
  return { price_change: mv(price_change, 'fraction'), oi_change, funding_avg, funding_last, funding_pctile_vs_window, liquidation_count, observation: parts.filter(Boolean).join(';'), aligned, method_version: ANALYSES_VERSION, warnings };
}
export interface BuyAndHoldResult { window: { from_ms: number; to_ms: number }; buy_and_hold_return: MetricValue; strategy_net_return: MetricValue; comparable: boolean; note: string; observation: string; method_version: string }
/** 同窗口一次进出的持有:第一根 open 买、最后一根 close 卖,扣同样的费率与滑点;窗口内没有 K 线就 insufficient。 */
export function compareBuyAndHold(bars: { close_time: number; open: string; close: string }[], window: { from_ms: number; to_ms: number }, fee_rate: string, slippage_bps: string, strategy_net_return: number | null): BuyAndHoldResult {
  const inWin = bars.filter((b) => b.close_time >= window.from_ms && b.close_time <= window.to_ms).sort((a, b) => a.close_time - b.close_time);
  const cost = Number(fee_rate) + Number(slippage_bps) / 1e4;
  const bh = inWin.length >= 2 ? (Number(inWin.at(-1)!.close) / Number(inWin[0]!.open)) * ((1 - cost) / (1 + cost)) - 1 : null;
  const comparable = bh !== null && strategy_net_return !== null && Number.isFinite(strategy_net_return);
  const observation = comparable ? `观察:同窗口一直持有(扣同样费用)收益 ${pct(bh)},策略扣费后净收益 ${pct(strategy_net_return)},差 ${pct(strategy_net_return! - bh!)};这只是这一段历史上的对比,样本少时不说明策略好坏` : `观察:${bh === null ? '窗口内没有 K 线,持有收益无法计算' : `同窗口一直持有(扣同样费用)收益 ${pct(bh)}`};策略收益缺失,无法比较`;
  return { window, buy_and_hold_return: mv(bh, 'fraction', '第一根 open 买入、最后一根 close 卖出,费率与滑点与策略相同'), strategy_net_return: mv(strategy_net_return, 'fraction'), comparable, note: comparable ? '同数据集、同窗口、同费率;策略未平仓的盯市盈亏已含在策略收益里' : '缺策略收益或窗口内没有 K 线,不能比较', observation, method_version: ANALYSES_VERSION };
}
