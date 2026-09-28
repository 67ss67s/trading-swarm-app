/**
 * 回测里的执行层(契约 §9.56,2026-09-27):决定下单的那一刻,用实盘同一套执行层阈值再判一次。
 *
 * 以前回测不看这些阈值,结果回测里能下的单,到了实盘下不出去。这个文件做两件事:
 *  - `executionCheck` 判止损距离和扣成本后的盈亏比,直接调用 execution-policy.ts 里实盘用的函数,不另写一份;
 *  - `ExecutionTally` 按「资产 + 决策那根 K 线」去重计数,输出契约里的 ExecutionGateStats。
 * 顺序和实盘一样:策略自己的检查先过,才轮到执行层。阈值由调用方从创建时存下的快照里取,这里不读 workflow。
 */
import type { ExecutionGateStats } from '@trade-gate/contracts';
import { netRrCheck, stopGeometry, stopGeometryReason, type ExecutionBlock, type ExecutionThresholds } from '../execution-policy.js';
type Example = { symbol: string; at: number; reason: string };
export const EXEC_GATE_VERSION = 'exec-gate-v1';
export interface ExecutionCheck { blocks: ExecutionBlock[]; reason: string | null }
/**
 * 一个候选过执行层。ref = 参考入场价(市价=信号收盘,限价=挂单价);atr 与 ref 同单位,缺失/预热不足时不判 ATR 下限;
 * target = 最近一档止盈,null = 没有止盈(只有信号/时间离场),净盈亏比不适用、不拦。
 */
export function executionCheck(side: 'long' | 'short', ref: number, stop: number, target: number | null, atr: number | null | undefined, th: ExecutionThresholds): ExecutionCheck {
  const g = stopGeometry(ref, stop, atr, th), rr = netRrCheck(side, ref, stop, target, th), blocks: ExecutionBlock[] = [...g.blocks], notes: string[] = [];
  if (g.blocks.length) notes.push(`止损距离 ${stopGeometryReason(g, th)}`);
  if (!rr.ok) { blocks.push('min_net_rr'); notes.push(`净盈亏比 ${rr.net_rr === null ? '算不出' : Number(rr.net_rr).toFixed(2)} < ${th.min_net_rr}(扣往返成本 ${th.round_trip_cost_bps}bps)`); }
  return { blocks, reason: blocks.length ? notes.join(';') : null };
}
/** 空统计(阈值生效但没有候选进入执行层)。 */
export function emptyExecutionGate(th: ExecutionThresholds): ExecutionGateStats {
  // 契约里的阈值只有 5 个数:网关内部多带的模式/周期字段不能写进统计(researchThresholds 已按模式折好)
  const thresholds = { min_stop_pct: th.min_stop_pct, max_stop_pct: th.max_stop_pct, min_stop_atr: th.min_stop_atr, min_net_rr: th.min_net_rr, round_trip_cost_bps: th.round_trip_cost_bps };
  return { version: EXEC_GATE_VERSION, thresholds, checked: 0, rejected: 0, rejected_by_execution: { stop_distance: 0, stop_atr: 0, stop_too_wide: 0, min_net_rr: 0 }, examples: [] };
}
/**
 * 按 `symbol:at` 去重:同一决策 bar 先后判了候选估算与入场(引擎两处 evaluateCandidate),以最后一次为准——
 * 入场那次才决定下不下单;候选估算被挡时不会再判入场,最后一次就是那次被挡。一个候选可命中多条原因,四个原因分别计数。
 */
export class ExecutionTally {
  private readonly rows = new Map<string, { symbol: string; at: number; check: ExecutionCheck }>();
  constructor(readonly thresholds: ExecutionThresholds) {}
  add(symbol: string, at: number, check: ExecutionCheck): void { this.rows.set(`${symbol}:${at}`, { symbol, at, check }); }
  stats(): ExecutionGateStats {
    const out = emptyExecutionGate(this.thresholds), examples: Example[] = [];
    for (const r of this.rows.values()) {
      out.checked++;
      if (!r.check.blocks.length) continue;
      out.rejected++;
      for (const b of new Set(r.check.blocks)) out.rejected_by_execution[b]++;
      if (examples.length < 5) examples.push({ symbol: r.symbol.slice(0, 80), at: r.at, reason: (r.check.reason ?? r.check.blocks.join(',')).slice(0, 400) });
    }
    return { ...out, examples: examples as ExecutionGateStats['examples'] };
  }
}
/** 多份统计相加(篮子 = 两腿;报告顶层 = 各单资产)。全是 null/缺失 → null(= 旧口径);阈值取第一份非空的快照。 */
export function mergeExecutionGate(list: (ExecutionGateStats | null | undefined)[]): ExecutionGateStats | null {
  const xs = list.filter((x): x is ExecutionGateStats => !!x);
  if (!xs.length) return null;
  const out = emptyExecutionGate(xs[0]!.thresholds), examples: Example[] = [];
  for (const x of xs) {
    out.checked += x.checked; out.rejected += x.rejected;
    for (const k of Object.keys(out.rejected_by_execution) as ExecutionBlock[]) out.rejected_by_execution[k] += x.rejected_by_execution[k] ?? 0;
    for (const e of (x.examples ?? []) as Example[]) if (examples.length < 5) examples.push(e);
  }
  return { ...out, examples: examples as ExecutionGateStats['examples'] };
}
