import type { BacktestReport } from "@trading-swarm/contracts";

// 回测报告落库后的广播点:回测引擎(loop/backtest.ts)只管 emit,策略对象服务(strategies/)订阅后
// 把报告挂到「策略 → 版本 → 报告」链上。两边互不 import,避免回测引擎依赖策略生命周期。
// 监听器可以返回要写回报告的 strategy_id/version(同步),emit 方把它们写进报告再返回。
export interface BacktestReportMeta {
  session_id: string | null;
  inquiry_id: string | null;
  /** 用户原始问题或步骤标题,策略命名用 */
  question: string | null;
  symbol: string;
}
export type BacktestReportListener = (
  report: BacktestReport,
  meta: BacktestReportMeta,
) => { strategy_id: string; strategy_version: number } | void;

const listeners = new Set<BacktestReportListener>();
export function onBacktestReport(fn: BacktestReportListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emitBacktestReport(
  report: BacktestReport,
  meta: BacktestReportMeta,
): { strategy_id: string; strategy_version: number } | null {
  let link: { strategy_id: string; strategy_version: number } | null = null;
  for (const fn of listeners) {
    try {
      const out = fn(report, meta);
      if (out && !link) link = out;
    } catch (e) {
      // 策略挂链失败不影响回测结果本身
      console.error("[research] backtest report listener failed", e);
    }
  }
  return link;
}
