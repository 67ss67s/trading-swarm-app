/**
 * 事后标签(oracle 的「答案」):对每根已收盘 K 线,假设在下一根 open 进场,按一套固定的机械管理跑完,看扣成本后能不能拿到 ≥ good_r 个 R。
 * 标签本身用了进场之后的 K 线(最多 max_bars+1 根),这是方法固有的前视;真正的检验是把挖出来的规则拿到验证段上做真实回测。
 *
 * 机械管理与回测引擎(engine v4 + order-gate)同口径:
 *  - 初始止损 = 信号根收盘 − stop_multiple×ATR(atr_period);止损距离低于「成本下限」(min_stop_cost_multiple × 往返成本,默认 8×0.3%=2.4%)时放宽到下限(order-gate 的 widen);
 *  - 止盈 = 信号根收盘 + target_r × 止损距离(限价;IR 里要求有独立止盈来源,用一个很远的 fixed_r_target,几乎不触发);
 *  - 吊灯追踪:持仓以来最高价 − trail_multiple×ATR(trail_period),每根收盘后只上移,下一根生效;
 *  - 持有满 max_bars 根后下一根 open 离场;
 *  - 成交:止损 stop-market(跳空按 open)、止盈限价(跳空按 open),同根都触及时按 bar 内路径(open 离高点近先止盈,否则先止损,相等先止损);
 *    每次成交收 fee_rate 并向不利方向滑 slippage_bps。
 * 做空完全镜像。
 */
import type { ResearchBar } from '@trading-swarm/contracts';
import { atrSeries } from '../../primitives/indicators.js';

export type Side = 'long' | 'short';
export interface Mechanics {
  atr_period: number; stop_multiple: number;
  trail_period: number; trail_multiple: number;
  max_bars: number; target_r: number;
  fee_rate: number; slippage_bps: number;
  /** 止损距离下限 = 这个倍数 × 往返成本(与 DEFAULT_ORDER_GATE.min_stop_cost_multiple 一致;0 表示不设下限) */
  min_stop_cost_multiple: number;
  /** 净 R ≥ 这个值记为好点 */
  good_r: number;
}
export const DEFAULT_MECHANICS: Mechanics = { atr_period: 14, stop_multiple: 2, trail_period: 22, trail_multiple: 3, max_bars: 48, target_r: 8, fee_rate: 0.001, slippage_bps: 5, min_stop_cost_multiple: 8, good_r: 2 };
/** 标签要看到进场后多少根 K 线(进场根 + 持有 max_bars 根 + 离场根) */
export const labelHorizon = (m: Mechanics = DEFAULT_MECHANICS) => m.max_bars + 1;

export interface LabelSeries {
  /** 扣成本后的净 R;不可标(预热不足 / 未来不够 / 超出 limit)为 NaN */
  r: Float64Array;
  /** 1 = 好点(r ≥ good_r),0 = 其余,255 = 不可标 */
  good: Uint8Array;
  /** 离场所在根下标(调试 / 非重叠模拟用),不可标为 -1 */
  exit_index: Int32Array;
  /** 净收益率(相对进场成交额,已扣双边费用与滑点),非重叠随机入场基线用 */
  ret: Float64Array;
}

/**
 * 逐根打标签。limit:只标「标签所需的未来 K 线全部 ≤ limit 下标」的根(训练段内的标签不许看到训练段之后的数据)。
 */
export function labelSeries(bars: ResearchBar[], side: Side, m: Mechanics = DEFAULT_MECHANICS, limit = bars.length - 1): LabelSeries {
  const n = bars.length, o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
  for (let i = 0; i < n; i++) { const b = bars[i]!; o[i] = Number(b.open); h[i] = Number(b.high); l[i] = Number(b.low); c[i] = Number(b.close); }
  const atr = atrSeries(bars, m.atr_period), trailAtr = atrSeries(bars, m.trail_period);
  const slip = m.slippage_bps / 1e4, fee = m.fee_rate, floorPct = m.min_stop_cost_multiple * (2 * fee + 2 * slip);
  const r = new Float64Array(n).fill(NaN), good = new Uint8Array(n).fill(255), exit_index = new Int32Array(n).fill(-1), ret = new Float64Array(n).fill(NaN);
  const long = side === 'long', H = labelHorizon(m);
  for (let i = 0; i < n; i++) {
    if (i + H > limit || !Number.isFinite(atr[i]!) || !Number.isFinite(trailAtr[i]!)) continue;
    const ref = c[i]!, dist = Math.max(m.stop_multiple * atr[i]!, floorPct * ref);
    let stop = long ? ref - dist : ref + dist;
    const target = long ? ref + m.target_r * dist : ref - m.target_r * dist;
    if (!(stop > 0) || !(dist > 0)) continue;
    const e = i + 1, entry = long ? o[e]! * (1 + slip) : o[e]! * (1 - slip);
    let exitPx = NaN, exitAt = -1, extreme = long ? -Infinity : Infinity;
    for (let j = e; j <= i + H; j++) {
      // 持满 max_bars 根:这一根 open 离场
      if (j - e >= m.max_bars) { exitPx = o[j]!; exitAt = j; break; }
      const hitStop = long ? l[j]! <= stop : h[j]! >= stop, hitTarget = long ? h[j]! >= target : l[j]! <= target;
      const stopFill = long ? Math.min(o[j]!, stop) : Math.max(o[j]!, stop), targetFill = long ? Math.max(o[j]!, target) : Math.min(o[j]!, target);
      if (hitStop && hitTarget) {
        // bar 内路径:long 时 open 离最高价近 → O→H→L→C 先止盈;short 镜像(open 离最低价近先止盈)
        const targetFirst = long ? h[j]! - o[j]! < o[j]! - l[j]! : o[j]! - l[j]! < h[j]! - o[j]!;
        exitPx = targetFirst ? targetFill : stopFill; exitAt = j; break;
      }
      if (hitStop) { exitPx = stopFill; exitAt = j; break; }
      if (hitTarget) { exitPx = targetFill; exitAt = j; break; }
      // 收盘后更新吊灯止损(只朝有利方向移动),下一根生效
      extreme = long ? Math.max(extreme, h[j]!) : Math.min(extreme, l[j]!);
      const trail = long ? extreme - m.trail_multiple * trailAtr[j]! : extreme + m.trail_multiple * trailAtr[j]!;
      if (Number.isFinite(trail) && (long ? trail > stop : trail < stop)) stop = trail;
    }
    if (exitAt < 0) continue;
    const fill = long ? exitPx * (1 - slip) : exitPx * (1 + slip);
    // 每单位的净损益(含双边手续费),风险 = 进场成交价到初始止损的距离
    const initialStop = long ? ref - dist : ref + dist, risk = Math.abs(entry - initialStop);
    const pnl = long ? fill * (1 - fee) - entry * (1 + fee) : entry * (1 - fee) - fill * (1 + fee);
    r[i] = pnl / (risk > 0 ? risk : dist);
    ret[i] = pnl / entry;
    good[i] = r[i]! >= m.good_r ? 1 : 0;
    exit_index[i] = exitAt;
  }
  return { r, good, exit_index, ret };
}
