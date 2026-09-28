/**
 * 生成器共用的 IR 操作:按路径找节点、周期类参数缩放、逐条记 diff。
 *
 * 周期类参数与 loop/sweep.ts 同一口径(整数、≥2、名字像长度/周期/回看;阈值与倍数不算),
 * 另外覆盖通用指标原语(indicator_cross / _exit / threshold / divergence)在 args、compare_args 里的周期:
 * 20/50 均线策略的信号是 ema_cross{fast,slow}、离场是 indicator_cross_exit{args.period, compare_args.period},
 * 两处必须一起缩放,否则「入场 25/63、离场还是 20/50」就不是同一个策略的邻域了。
 */
import type { StrategyIR, StrategyPrimitive } from '@trade-gate/contracts';
import type { Candidate } from '../types.js';

export const PERIOD_KEY = /(^|_)(period|length|len|lookback|window|fast|slow|signal|bars|n|span|swing_length|atr_period|ema_period|ema_fast|ema_slow|adx_period|count)$/i;
export type Section = 'signal' | 'exit' | 'stop' | 'regime' | 'entry' | 'sizing';
export interface NodeRef { path: string; section: Section; node: StrategyPrimitive }
export type Diff = Candidate['diff'];
export type Proposal = { ir: StrategyIR; diff: Diff; rationale: string; evidence?: Record<string, unknown> };

export function nodesOf(ir: StrategyIR): NodeRef[] {
  return [
    ...ir.signal.map((node, i) => ({ path: `signal.${i}`, section: 'signal' as const, node })),
    { path: 'entry', section: 'entry' as const, node: ir.entry },
    { path: 'risk.stop', section: 'stop' as const, node: ir.risk.stop },
    ...ir.exit.map((node, i) => ({ path: `exit.${i}`, section: 'exit' as const, node })),
    ...(ir.regime ? [{ path: 'regime', section: 'regime' as const, node: ir.regime }] : []),
  ];
}
/** 按 nodesOf 的路径取节点(克隆后的 IR 上用)。 */
export function nodeAt(ir: StrategyIR, path: string): StrategyPrimitive | null {
  if (path === 'entry') return ir.entry;
  if (path === 'risk.stop') return ir.risk.stop;
  if (path === 'regime') return ir.regime ?? null;
  const [sec, i] = path.split('.');
  return sec === 'signal' ? ir.signal[Number(i)] ?? null : sec === 'exit' ? ir.exit[Number(i)] ?? null : null;
}
export interface PeriodSlot { path: string; section: Section; holder: Record<string, unknown>; key: string; value: number }
/** 所有周期类参数(含 args / compare_args 内层)。 */
export function periodSlots(ir: StrategyIR, sections?: Section[]): PeriodSlot[] {
  const out: PeriodSlot[] = [];
  for (const ref of nodesOf(ir)) {
    if (sections && !sections.includes(ref.section)) continue;
    const scan = (holder: Record<string, unknown>, prefix: string) => {
      for (const [key, value] of Object.entries(holder)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && (key === 'args' || key === 'compare_args')) scan(value as Record<string, unknown>, `${prefix}${key}.`);
        else if (typeof value === 'number' && Number.isInteger(value) && value >= 2 && PERIOD_KEY.test(key)) out.push({ path: `${ref.path}.params.${prefix}${key}`, section: ref.section, holder, key, value });
      }
    };
    scan(ref.node.params ?? {}, '');
  }
  return out;
}
/** 周期类参数整体 × factor(取整,不低于 2;没有任何变化返回 null)。 */
export function scalePeriods(ir: StrategyIR, factor: number, sections?: Section[]): { ir: StrategyIR; diff: Diff } | null {
  const next = structuredClone(ir), diff: Diff = [];
  for (const s of periodSlots(next, sections)) {
    const to = Math.max(2, Math.round(s.value * factor));
    if (to === s.value) continue;
    s.holder[s.key] = to; diff.push({ path: s.path, from: s.value, to });
  }
  return diff.length ? { ir: next, diff } : null;
}
/** 改一个参数(克隆);返回 null 表示值没变。 */
export function setParam(ir: StrategyIR, path: string, key: string, to: unknown): { ir: StrategyIR; diff: Diff } | null {
  const next = structuredClone(ir), node = nodeAt(next, path);
  if (!node) return null;
  const from = node.params[key];
  if (JSON.stringify(from) === JSON.stringify(to)) return null;
  node.params[key] = to;
  return { ir: next, diff: [{ path: `${path}.params.${key}`, from: from ?? null, to }] };
}
/** 整段替换一个节点(克隆)。 */
export function replaceNode(ir: StrategyIR, path: string, to: StrategyPrimitive): { ir: StrategyIR; diff: Diff } | null {
  const next = structuredClone(ir), from = nodeAt(next, path);
  if (!from) return null;
  if (path === 'entry') next.entry = to;
  else if (path === 'risk.stop') next.risk.stop = to;
  else if (path === 'regime') next.regime = to;
  else { const [sec, i] = path.split('.'); (sec === 'signal' ? next.signal : next.exit)[Number(i)] = to; }
  return { ir: next, diff: [{ path, from, to }] };
}
/** 删掉一个 signal / exit / regime 节点(克隆);signal 只剩一个时不删。 */
export function removeNode(ir: StrategyIR, path: string): { ir: StrategyIR; diff: Diff } | null {
  const next = structuredClone(ir), from = nodeAt(next, path);
  if (!from) return null;
  if (path === 'regime') delete next.regime;
  else { const [sec, i] = path.split('.'); if (sec === 'signal') { if (next.signal.length < 2) return null; next.signal.splice(Number(i), 1); } else if (sec === 'exit') next.exit.splice(Number(i), 1); else return null; }
  return { ir: next, diff: [{ path, from, to: null }] };
}
export function appendExit(ir: StrategyIR, node: StrategyPrimitive): { ir: StrategyIR; diff: Diff } {
  const next = structuredClone(ir); next.exit.push(node);
  return { ir: next, diff: [{ path: `exit.${next.exit.length - 1}`, from: null, to: node }] };
}
export function appendSignal(ir: StrategyIR, node: StrategyPrimitive): { ir: StrategyIR; diff: Diff } {
  const next = structuredClone(ir); next.signal.push(node);
  return { ir: next, diff: [{ path: `signal.${next.signal.length - 1}`, from: null, to: node }] };
}
export const describeDiff = (d: Diff) => d.map((x) => `${x.path}: ${short(x.from)} → ${short(x.to)}`).join(';');
const short = (v: unknown) => (v === null || v === undefined ? '无' : typeof v === 'object' && v && 'primitive' in (v as Record<string, unknown>) ? `${(v as StrategyPrimitive).primitive}${JSON.stringify((v as StrategyPrimitive).params)}` : JSON.stringify(v));
