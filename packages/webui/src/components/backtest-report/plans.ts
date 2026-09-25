/**
 * 逐笔计划(research-orders.json 的 BacktestPlan)的辅助:
 * BacktestAsset 之后会带可选 plans / plan_stats(契约还没落,这里按可选字段读,旧报告没有就是 undefined)。
 */
import type { BacktestAsset, BacktestPlan, BacktestPlanEventKind, BacktestPlanStats } from '@trading-swarm/contracts';
import { tmap } from '@/lib/i18n';

export type AssetWithPlans = BacktestAsset & { plans?: BacktestPlan[] | null; plan_stats?: BacktestPlanStats | null };

export function assetPlans(asset: BacktestAsset | undefined): BacktestPlan[] | null {
  const p = (asset as AssetWithPlans | undefined)?.plans;
  return Array.isArray(p) ? p : null;
}

function hasEvent(p: BacktestPlan, kind: BacktestPlanEventKind): boolean {
  return p.events.some((e) => e.kind === kind);
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** 后端没给 plan_stats 时按 plans 现算(口径与契约字段同名同义)。 */
export function computePlanStats(plans: BacktestPlan[]): BacktestPlanStats {
  const filled = plans.filter((p) => p.filled_at !== null);
  const settled = filled.filter((p) => p.exit && p.exit.reason !== 'open');
  return {
    placed: plans.length,
    filled: filled.length,
    no_fill: plans.filter((p) => p.status === 'no_fill').length,
    replaced: plans.filter((p) => p.status === 'replaced' || p.replaced_by !== null).length,
    rolled: plans.filter((p) => p.rolled_to !== null || p.exit?.reason === 'rolled').length,
    added: plans.filter((p) => p.legs.length > 1 || hasEvent(p, 'added')).length,
    flipped: plans.filter((p) => p.exit?.reason === 'flipped' || hasEvent(p, 'flipped')).length,
    liquidated: plans.filter((p) => p.exit?.reason === 'liquidation' || hasEvent(p, 'liquidated')).length,
    fill_rate: plans.length ? filled.length / plans.length : null,
    avg_planned_rr: avg(plans.map((p) => p.planned_rr).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))),
    avg_realized_r: avg(settled.map((p) => p.r_multiple).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))),
    tp_hit_rate: settled.length ? settled.filter((p) => p.exit?.reason === 'tp' || hasEvent(p, 'tp_hit')).length / settled.length : null,
    sl_hit_rate: settled.length ? settled.filter((p) => p.exit?.reason === 'sl' || hasEvent(p, 'sl_hit')).length / settled.length : null,
  };
}

export function assetPlanStats(asset: BacktestAsset | undefined): BacktestPlanStats | null {
  const s = (asset as AssetWithPlans | undefined)?.plan_stats;
  if (s) return s;
  const plans = assetPlans(asset);
  return plans && plans.length ? computePlanStats(plans) : null;
}

export const PLAN_STATUS_LABEL: Record<string, string> = tmap({
  pending: '挂单中',
  filled: '已成交',
  no_fill: '未成交',
  replaced: '被替换',
  cancelled: '已撤销',
  blocked: '未下单(被拦)',
});

/** 被拦计划的原因(执行核 blocked_reason):放置前的盈亏比 / 止损方向 / 无止盈等,真实数据里常占多数 */
export const PLAN_BLOCKED_LABEL: Record<string, string> = tmap({
  min_rr: '盈亏比不足',
  no_target: '无止盈价位',
  stop_side: '止损在错误一侧',
  no_stop: '无止损',
  no_entry_price: '无挂单价',
  opposite_signal: '反向信号撤单',
  gap_invalidated: '跳空失效',
  insufficient_cash: '资金不足',
});

export const PLAN_EXIT_LABEL: Record<string, string> = tmap({
  tp: '止盈',
  sl: '止损',
  trail: '移动止损',
  signal_exit: '信号离场',
  time: '到期离场',
  rolled: '滚动换仓',
  flipped: '反手',
  liquidation: '强平',
  breakeven: '保本离场',
  end_of_data: '窗口结束平仓',
  open: '仍持仓',
});

export const PLAN_EVENT_LABEL: Record<string, string> = tmap({
  placed: '挂单',
  filled: '成交',
  no_fill: '未成交过期',
  replaced: '被新计划替换',
  stop_moved: '止损移动',
  tp_moved: '止盈调整',
  tp_hit: '止盈命中',
  sl_hit: '止损命中',
  rolled_in: '滚入',
  rolled_out: '滚出',
  added: '加仓',
  flipped: '反手',
  liquidated: '强平',
  funding: '资金费',
  closed: '平仓',
});

export const LEVEL_SOURCE_LABEL: Record<string, string> = tmap({
  structure_support: '结构支撑',
  structure_resistance: '结构阻力',
  atr: 'ATR',
  rr: '按盈亏比',
  indicator: '指标',
  fixed_pct: '固定百分比',
  user: '手动',
  trail: '移动',
});

/** 时间线圆点色:盈利语义绿、亏损红、结转琥珀、中性灰(与 8794 策略回放一致) */
export function eventDot(kind: string): string {
  switch (kind) {
    case 'filled':
    case 'tp_hit':
    case 'added':
      return 'bg-up';
    case 'sl_hit':
    case 'liquidated':
      return 'bg-down';
    case 'rolled_in':
    case 'rolled_out':
    case 'replaced':
      return 'bg-warn';
    case 'flipped':
    case 'closed':
      return 'bg-primary';
    default:
      return 'bg-muted-foreground/50';
  }
}

export function exitBadge(reason: string | null | undefined): string {
  switch (reason) {
    case 'tp':
      return 'border-up/40 bg-up/10 text-up';
    case 'sl':
    case 'liquidation':
      return 'border-down/40 bg-down/10 text-down';
    case 'rolled':
      return 'border-warn/40 bg-warn/10 text-warn';
    case 'flipped':
    case 'signal_exit':
      return 'border-primary/40 bg-primary/10 text-primary';
    default:
      return 'border-border text-muted-foreground';
  }
}
