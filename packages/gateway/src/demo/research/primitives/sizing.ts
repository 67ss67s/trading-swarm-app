import { define } from './registry.js';
import type { ResearchBar, StrategyIR } from '@trading-swarm/contracts';
import { stdev } from '../improve/stats.js';
export const next_open_market=define('next_open_market','entry','主动交易在下一根 open 成交',()=>0,()=>({pass:true}));
export const risk_fraction=define('risk_fraction','sizing','按权益风险比例和初始止损距离计算数量',()=>0,(_ctx,p)=>({sizing:{allocation:'equal_risk',risk_fraction:String(p.fraction),max_allocation:String(p.max_allocation)}}));
export const equal_notional=define('equal_notional','sizing','按最大仓位数等名义分配，总额受组合上限约束',()=>0,(_ctx,p)=>({sizing:{allocation:'equal_notional',max_allocation:String(p.max_allocation)}}));

/**
 * 波动率目标仓位(2026-09-23 晚,从批量层 batch/evaluate.ts volTargetEquity 落进策略对象):
 *   每笔入场按 w = min(1, target_vol / σ) 缩放首腿仓位,叠在缺省的「每笔 100% 可用资金」之上;σ = 信号根(含)及以前 n 根已收盘 K 线
 *   对数收益的样本标准差 × √(每年根数)。只用入场前数据(市价单在信号下一根 open 成交,σ 截至信号根收盘),因果。历史不够 n 根时 w = 1(同批量层)。
 *   缺省:target_vol 0.5(年化 50%)、n = 20 天折算根数(4h = 120 根,至少 5 根)——与批量层 VolTarget {annual:0.5, days:20} 同式;n 上限 4000。预热记 0(见 define 处注释),信号与不加波动目标的同一 IR 逐根相同。
 *   只在 IR 显式用 vol_target 时生效:不用它的 IR 结果逐字节不变(test/demo/research/vol-target.test.ts 钉哈希)。
 *   参数契约:packages/contracts/schema/research.json#PrimitiveParamsVolTarget。
 */
const DAY = 86400000;
export const VOL_TARGET_DEFAULT_TARGET = 0.5;
export const VOL_TARGET_DEFAULT_DAYS = 20;
export const VOL_TARGET_MAX_LOOKBACK = 4000;
/** 改进环里「调目标值」的预设小网格(年化) */
export const VOL_TARGET_GRID = [0.3, 0.5, 0.8] as const;
/** 回看根数:显式 lookback_bars;缺省 = 20 天折算根数(至少 5 根,与批量层 realizedVol 同式),上限 4000。 */
export function volLookbackBars(p: Record<string, unknown>, timeframe_ms: number): number {
  const x = p.lookback_bars;
  if (typeof x === 'number' && Number.isInteger(x) && x >= 5) return Math.min(VOL_TARGET_MAX_LOOKBACK, x);
  return Math.min(VOL_TARGET_MAX_LOOKBACK, Math.max(5, Math.round((VOL_TARGET_DEFAULT_DAYS * DAY) / timeframe_ms)));
}
/** 第 i 根(含)及以前 n 根对数收益的年化实现波动;历史不够返回 null。与 batch/evaluate.ts realizedVol(bars, bars[i+1].open_time, step, 20) 同一结果。 */
export function realizedVolAt(bars: ResearchBar[], i: number, n: number, timeframe_ms: number): number | null {
  if (i < n || i >= bars.length) return null;
  const r: number[] = [];
  for (let k = i - n + 1; k <= i; k++) { const a = Number(bars[k - 1]!.close), b = Number(bars[k]!.close); if (a > 0 && b > 0) r.push(Math.log(b / a)); }
  const sd = stdev(r); return sd > 0 ? sd * Math.sqrt((365 * DAY) / timeframe_ms) : null;
}
/** IR 的波动率目标参数;不用 vol_target 返回 null。 */
export function volTargetOf(ir: Pick<StrategyIR, 'risk'>): { target_vol: number; lookback_bars: number | null } | null {
  const s = ir.risk?.sizing; if (!s || s.primitive !== 'vol_target') return null;
  return { target_vol: Number(s.params.target_vol), lookback_bars: typeof s.params.lookback_bars === 'number' ? s.params.lookback_bars : null };
}
/** 信号根 i 收盘时的仓位权重 w = min(1, 目标/σ);σ 算不出(历史不够/零波动)→ w = 1。 */
export function volTargetWeight(bars: ResearchBar[], i: number, timeframe_ms: number, vt: { target_vol: number; lookback_bars: number | null }): { weight: number; sigma: number | null; lookback: number } {
  const lookback = volLookbackBars(vt.lookback_bars === null ? {} : { lookback_bars: vt.lookback_bars }, timeframe_ms), sigma = realizedVolAt(bars, i, lookback, timeframe_ms);
  return { weight: sigma ? Math.min(1, vt.target_vol / sigma) : 1, sigma, lookback };
}
export const sizeNote = (x: { weight: number; sigma: number | null }, target: number) => `波动目标仓位 w=${x.weight.toFixed(4)}(目标 ${Math.round(target * 100)}%,实现波动 ${x.sigma === null ? '历史不足按 1' : `${(x.sigma * 100).toFixed(1)}%`})`;
export const vol_target=define('vol_target','sizing','波动率目标仓位:每笔 100% 可用资金 × min(1, 目标年化波动 target_vol / 入场前已收盘 K 线的实现年化波动);回看 lookback_bars 根,缺省 20 天',
  // 预热记 0:σ 按下标从整段已收盘 K 线取(不走决策视图),历史不够时 w=1(同批量层)。若记成回看根数,会拉长 engine v4/订单核的决策视图(6×预热),
  // EMA 这类递推指标的起点跟着变,均线贴近时的穿越会翻转——加不加波动目标就不再是同一批信号(2026-09-23 真数据实测 XRP/BNB 各多/错一笔)。
  ()=>0,
  (_ctx,p)=>({sizing:{allocation:'equal_notional',max_allocation:'1',vol_target:{target_vol:Number(p.target_vol),lookback_bars:typeof p.lookback_bars==='number'?p.lookback_bars:null}}}));
