/**
 * 生成器 3:组件替换(零模型,思路同 attribution.ts 的逐段替换)。把信号 / 离场 / 止损 / 方向门中的一段,
 * 换成原语库里同类别的其他原语;参数用下面 SWAP_DEFAULTS 的常用默认值(原语契约里没有 default,这张表就是「默认/中位参数」的出处,
 * 取值都是各原语最常见的教科书参数)。只换表里有的原语:Pine、形态、背离这类需要额外输入或解释的不自动换。
 * 替换后必须过零模型编译检查(checkIR + 不引入新的策略规范 block),过不了的直接丢;止盈目标(fixed_r_target / structure_target)不参与替换。
 * 产出顺序:止损、信号、离场、方向门轮流各出一个,保证预算截断时各段都有代表。
 */
import type { StrategyIR, StrategyPrimitive } from '@trading-swarm/contracts';
import { node, timeframeMillis } from '../../strategy.js';
import { registry } from '../../primitives/index.js';
import type { CandidateGenerator, GeneratorContext } from '../types.js';
import { nodesOf, replaceNode, type NodeRef, type Proposal } from './params.js';
import { VOL_TARGET_GRID, volTargetOf } from '../../primitives/sizing.js';
import { SPEC_SIZING_PRIMITIVES } from '../../strategy-spec.js';

/** 高周期参数:取 4h 与基础周期里较大的那个(必须 ≥ 基础周期且整除,checkIR 会再核一遍)。 */
const htfFor = (tf: string, want: string) => (timeframeMillis(want) >= timeframeMillis(tf) ? want : tf);
export function swapDefaults(tf: string): Record<'signal' | 'exit' | 'stop' | 'regime', StrategyPrimitive[]> {
  return {
    signal: [
      node('ema_cross', { fast: 20, slow: 50 }),
      node('macd_cross', { fast: 12, slow: 26, signal: 9 }),
      node('donchian_breakout', { lookback: 20, basis: 'close' }),
      node('indicator_cross', { indicator: 'price', compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 50 }, direction: 'cross_above' }),
      node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'cross_above', threshold: 30 }),
      node('structure_bos', { swing_length: 5 }),
    ],
    exit: [
      node('chandelier_trail', { atr_period: 22, multiple: 3 }),
      node('trend_break', { ema_period: 50, htf: htfFor(tf, '4h') }),
      node('indicator_cross_exit', { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 50 }, direction: 'cross_below' }),
      node('swing_structure_stop', { lookback: 20 }),
      node('indicator_threshold_exit', { indicator: 'rsi', args: { period: 14 }, operator: 'cross_below', threshold: 50 }),
    ],
    stop: [
      node('atr_stop', { atr_period: 14, multiple: 3 }),
      node('swing_low_stop', { lookback: 20 }),
      node('order_blocks', { swing_length: 5 }),
    ],
    regime: [
      node('trend_state', { adx_period: 14, adx_min: 20, ema_fast: 20, ema_slow: 50, htf: htfFor(tf, '4h') }),
      node('htf_structure_regime', { htf: htfFor(tf, '1d'), swing_length: 5 }),
    ],
  };
}
const TARGETS = new Set(['fixed_r_target', 'structure_target']);
/**
 * 仓位段(2026-09-23 晚):波动率目标仓位的加/去/调目标值。批量研究与 perp-trend 组合研究里,「等权 + 50% 年化波动目标」
 * 在训练、验证两段回撤都最小(docs/research/perp-trend-portfolio-2026-09-23.md),所以把它放进变异空间:
 *   父策略没有 vol_target → 依次提议目标 50% / 30% / 80%(预先写死的小网格,不按结果调);
 *   父策略有 vol_target → 先提议去掉(退回每笔 100% 可用资金,消融),再提议网格里的其他目标值;回看根数沿用父策略。
 */
export function sizingProposals(ir: StrategyIR): Proposal[] {
  const cur = ir.risk.sizing, vt = volTargetOf(ir), out: Proposal[] = [];
  if (!(SPEC_SIZING_PRIMITIVES as readonly string[]).includes(cur.primitive)) return out;
  const make = (to: StrategyPrimitive, rationale: string, evidence: Record<string, unknown>) => { const next = structuredClone(ir); next.risk.sizing = to; out.push({ ir: next, diff: [{ path: 'risk.sizing', from: cur, to }], rationale, evidence: { section: 'sizing', from: cur.primitive, to: to.primitive, ...evidence } }); };
  const keep = typeof cur.params.lookback_bars === 'number' ? { lookback_bars: cur.params.lookback_bars } : {};
  if (!vt) for (const t of [0.5, 0.3, 0.8]) make(node('vol_target', { target_vol: t }), `仓位:加波动率目标 ${t * 100}%(每笔 100% 可用资金 × min(1, 目标/入场前 20 天实现波动);批量研究里它压回撤最明显)`, { target_vol: t });
  else {
    make(node('equal_notional', { max_allocation: '1' }), `仓位:去掉波动率目标(${vt.target_vol * 100}%),退回每笔 100% 可用资金,看缩放本身贡献多少`, { target_vol: null });
    for (const t of VOL_TARGET_GRID) if (Math.abs(t - vt.target_vol) > 1e-9) make(node('vol_target', { target_vol: t, ...keep }), `仓位:波动率目标 ${vt.target_vol * 100}% → ${t * 100}%(预设网格 30/50/80%)`, { target_vol: t });
  }
  return out;
}
/** 逐段替换的全部方案(未做编译检查),按段轮流排好;仓位段排在第一条道(每轮先出一个仓位方案)。 */
export function swapProposals(ir: StrategyIR, tf: string): Proposal[] {
  const table = swapDefaults(tf), lanes: Proposal[][] = [sizingProposals(ir)];
  const slots: NodeRef[] = nodesOf(ir).filter((r) => (r.section === 'stop' || r.section === 'signal' || r.section === 'regime' || (r.section === 'exit' && !TARGETS.has(r.node.primitive))));
  const order = ['stop', 'signal', 'exit', 'regime'];
  slots.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
  for (const s of slots) {
    const lane: Proposal[] = [];
    for (const alt of table[s.section as keyof typeof table] ?? []) {
      if (alt.primitive === s.node.primitive || !registry.has(alt.primitive)) continue;
      // 同一策略里已经有这个原语(比如离场已有吊灯线)就不再换成它,免得出现两个一样的段
      if (nodesOf(ir).some((r) => r.section === s.section && r.node.primitive === alt.primitive)) continue;
      const to = s.node.optional ? { ...alt, optional: true } : alt, x = replaceNode(ir, s.path, to);
      if (x) lane.push({ ...x, rationale: `组件替换:${s.path}(${s.node.primitive})换成同类别的 ${alt.primitive},参数用常用默认值`, evidence: { section: s.section, from: s.node.primitive, to: alt.primitive } });
    }
    lanes.push(lane);
  }
  const out: Proposal[] = [];
  for (let k = 0; lanes.some((l) => l.length > k); k++) for (const l of lanes) if (l[k]) out.push(l[k]!);
  return out;
}
export const swapGenerator: CandidateGenerator = {
  name: 'swap',
  async generate(ctx: GeneratorContext) {
    return swapProposals(ctx.parent.ir, ctx.data.timeframe).filter((p) => ctx.check(p.ir).ok).map((p) => ({ generator: 'swap' as const, ir: { ...p.ir, label: ctx.parent.ir.label }, diff: p.diff, rationale: p.rationale, ...(p.evidence ? { evidence: p.evidence } : {}) }));
  },
};
