/** BacktestPlanStats:计划层统计(契约 research-orders.json 已写明每个字段口径)。
 * fill_rate 只算走完时效的计划(filled/(filled+no_fill));replaced/cancelled/blocked/pending 不进分母,免得被替换的单把成交率拖低。 */
import type { BacktestPlan, BacktestPlanStats } from '@trade-gate/contracts';
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export function planStats(plans: BacktestPlan[], counters: { ignored?: number; blocked?: number; added?: number } = {}): BacktestPlanStats {
  const by = (s: BacktestPlan['status']) => plans.filter((p) => p.status === s).length;
  const filled = plans.filter((p) => p.filled_at !== null), settled = filled.filter((p) => p.exit && p.exit.reason !== 'open');
  const noFill = by('no_fill'), reason = (r: string) => settled.filter((p) => p.exit!.reason === r).length;
  const fin = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return {
    placed: plans.filter((p) => p.status !== 'blocked').length,
    filled: filled.length,
    no_fill: noFill,
    replaced: by('replaced'),
    rolled: settled.filter((p) => p.exit!.reason === 'rolled').length,
    added: counters.added ?? plans.reduce((a, p) => a + Math.max(0, p.legs.length - 1), 0),
    flipped: reason('flipped'),
    liquidated: reason('liquidation'),
    fill_rate: filled.length + noFill ? filled.filter((p) => !p.rolled_from).length / (filled.filter((p) => !p.rolled_from).length + noFill) : null,
    avg_planned_rr: avg(fin(plans.filter((p) => p.status !== 'blocked').map((p) => p.planned_rr))),
    avg_realized_r: avg(fin(settled.map((p) => p.r_multiple))),
    tp_hit_rate: settled.length ? settled.filter((p) => p.take_profits.some((t) => t.filled_at !== null)).length / settled.length : null,
    sl_hit_rate: settled.length ? reason('sl') / settled.length : null,
    blocked: counters.blocked ?? by('blocked'),
    ignored: counters.ignored ?? 0,
    cancelled: by('cancelled'),
    pending: by('pending'),
    breakeven: reason('breakeven'),
    funding_missing: filled.filter((p) => p.market === 'perp' && (p.funding_status === 'missing' || p.funding_status === 'partial')).length,
    // 资金费现金 = funding_pct × 保证金(执行核里 funding_pct = 资金费现金 / 保证金);没有可用序列的计划不计(null 不当 0)
    funding_pnl: (() => { const xs = filled.filter((p) => p.market === 'perp' && p.funding_pct !== null && p.funding_pct !== undefined); return xs.length ? xs.reduce((a, p) => a + p.funding_pct! * (p.margin ?? 0), 0) : null; })(),
    funding_periods: filled.reduce((a, p) => a + (p.funding_periods ?? 0), 0),
    liquidation_loss: (() => { const xs = settled.filter((p) => p.exit!.reason === 'liquidation' && p.pnl_pct !== null); return xs.length ? xs.reduce((a, p) => a + p.pnl_pct! * (p.margin ?? 0), 0) : null; })(),
  };
}
