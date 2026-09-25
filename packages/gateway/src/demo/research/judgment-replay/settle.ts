/**
 * 管仓与结算(所有臂完全相同:同一事件只算一次,臂之间只差「做不做」)。
 *
 *  - trail(主):初始止损 = 结构止损;从成交起吊灯线 HH/LL ∓ 3×ATR22(已收盘 K 线简单均值),只收紧不放宽,
 *    不设目标,最长 168 根。做多时与几何实验室 `settleTrail` 逐字等价(测试钉住),这里只是补上做空镜像与资金费。
 *  - plan(副):结构止盈(有才设)+ 结构止损,48 根到期按收盘价平;直接调 outcome.ts `simulateOutcome`
 *    (下一根开盘市价成交、同根同时碰到止损与止盈算止损、跳空穿止损按开盘价)。
 *
 * 成本:outcome.ts `tradeCosts` + DEFAULT_COSTS(taker 0.05%×2、0.01 ATR 滑点×2);永续再按 OKX 真实资金费计入
 * (多头付正费率),现货不传资金费(=0)。R 的分母是 |成交价 − 初始止损|,全程不变。
 */
import { openTrade, simulateOutcome, stepTrade, tradeCosts, tradeR } from '../../outcome.js';
import type { FundingPoint } from './data.js';
import { PLAN_BARS, TRAIL_BARS, type Bar, type Dir, type SettleOut } from './types.js';

export const CHANDELIER_N = 22;
export const CHANDELIER_MULT = 3;

const N = (s: string): number => Number(s);
const r4 = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

export function settlePlanDir(dir: Dir, stop: number, target: number | null, future: readonly Bar[], atr14: number, funding: readonly FundingPoint[] = []): SettleOut {
  const o = simulateOutcome({ direction: dir, entry: 'market', limit_price: null, stop, tp: target, bars: future.slice(0, PLAN_BARS), atr: atr14, funding: [...funding] }) as ReturnType<typeof simulateOutcome> & { funding_r?: number };
  return { management: 'plan', status: o.status, fill: o.fill_price, exit_price: o.exit_price, bars_held: o.bars_held, gross_r: r4(o.gross_r), net_r: r4(o.net_r), funding_r: r4(o.funding_r), funding_estimated: o.funding_estimated ?? false, note: o.note };
}

/** 吊灯线追踪。history = 事件视图里的已收盘 K 线(算第一根的 ATR22 用),future = as_of 之后的 K 线。 */
export function settleTrailDir(dir: Dir, stop: number, history: readonly Bar[], future: readonly Bar[], atr14: number, funding: readonly FundingPoint[] = []): SettleOut {
  const bars = future.slice(0, TRAIL_BARS);
  const none = (status: string, note: string): SettleOut => ({ management: 'trail', status, fill: null, exit_price: null, bars_held: null, gross_r: null, net_r: null, funding_r: null, funding_estimated: false, note });
  if (!bars.length) return none('invalid', 'no future bars');
  const long = dir === 'long';
  const fill = N(bars[0]!.open);
  const t = openTrade(dir, fill, stop, null);
  if (!t) return none('invalid', `stop ${stop} on the wrong side of fill ${fill}`);
  const seen: Bar[] = history.slice(-(CHANDELIER_N + 1));
  let extreme = fill;
  let exit: { price: number; at: number; status: string; held: number } | null = null;
  for (const b of bars) {
    const tail = seen.slice(-(CHANDELIER_N + 1));
    if (tail.length > CHANDELIER_N) {
      let tr = 0;
      for (let i = 1; i < tail.length; i++) {
        const h = N(tail[i]!.high);
        const l = N(tail[i]!.low);
        const pc = N(tail[i - 1]!.close);
        tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
      const off = CHANDELIER_MULT * (tr / CHANDELIER_N);
      if (long) {
        const trail = extreme - off;
        if (trail > t.stop) t.stop = trail;
      } else {
        const trail = extreme + off;
        if (trail < t.stop) t.stop = trail;
      }
    }
    const s = stepTrade(t, b, false);
    if (s.exit) {
      const moved = long ? t.stop > stop : t.stop < stop;
      exit = { price: s.exit.price, at: s.exit.at, status: s.exit.status === 'stop' && moved ? 'trail' : s.exit.status, held: t.bars_held };
      break;
    }
    seen.push(b);
    extreme = long ? Math.max(extreme, N(b.high)) : Math.min(extreme, N(b.low));
  }
  if (!exit) {
    const last = bars.at(-1)!;
    exit = { price: N(last.close), at: last.close_time, status: 'expired', held: t.bars_held };
  }
  const gross = tradeR(t, exit.price);
  const cost = tradeCosts(t, exit.price, 'market', bars[0]!.open_time, exit.at, atr14, [...funding]);
  return { management: 'trail', status: exit.status, fill, exit_price: exit.price, bars_held: exit.held, gross_r: r4(gross), net_r: r4(gross - cost.cost_r), funding_r: r4(cost.funding_r), funding_estimated: cost.funding_estimated, note: exit.status === 'trail' ? `trail stop ${t.stop}` : exit.status };
}
