/**
 * 生成器 2:参数邻域(零模型)。周期类参数(口径见 params.ts,与 loop/sweep.ts 相同并覆盖通用指标的 args)按
 *   整体 ×0.75 / ×1.25 / ×0.5 / ×1.5,再单独动信号段 ±25%、单独动离场段 ±25%;按这个顺序产出,runner 截预算。
 * 平台检验数据:plateauNeighbors(ir) = 整体 ±25% 两个点;runner 对进入验证段前的候选各跑一次训练段,
 *   邻域目标不低于 ratio×候选目标(Objective.plateau_ratio)才算平台,否则判为孤立尖峰淘汰。
 */
import type { StrategyIR } from '@trading-swarm/contracts';
import type { CandidateGenerator, GeneratorContext } from '../types.js';
import { scalePeriods, type Diff, type Section } from './params.js';

const PLAN: { factor: number; sections?: Section[]; label: string }[] = [
  { factor: 0.75, label: '周期整体 ×0.75' }, { factor: 1.25, label: '周期整体 ×1.25' },
  { factor: 0.5, label: '周期整体 ×0.5' }, { factor: 1.5, label: '周期整体 ×1.5' },
  { factor: 0.75, sections: ['signal'], label: '信号周期 ×0.75' }, { factor: 1.25, sections: ['signal'], label: '信号周期 ×1.25' },
  { factor: 0.75, sections: ['exit'], label: '离场周期 ×0.75' }, { factor: 1.25, sections: ['exit'], label: '离场周期 ×1.25' },
];
export function neighborhoodVariants(ir: StrategyIR): { label: string; factor: number; sections: Section[] | null; ir: StrategyIR; diff: Diff }[] {
  const seen = new Set([JSON.stringify(ir)]), out: { label: string; factor: number; sections: Section[] | null; ir: StrategyIR; diff: Diff }[] = [];
  for (const p of PLAN) {
    const v = scalePeriods(ir, p.factor, p.sections);
    if (!v) continue;
    const k = JSON.stringify(v.ir); if (seen.has(k)) continue; seen.add(k);
    out.push({ label: p.label, factor: p.factor, sections: p.sections ?? null, ...v });
  }
  return out;
}
/** 平台检验的邻域点:周期整体 ±25%。 */
export function plateauNeighbors(ir: StrategyIR): { label: string; ir: StrategyIR }[] {
  return [0.75, 1.25].flatMap((f) => { const v = scalePeriods(ir, f); return v ? [{ label: `周期 ×${f}`, ir: v.ir }] : []; });
}
export const neighborhoodGenerator: CandidateGenerator = {
  name: 'neighborhood',
  async generate(ctx: GeneratorContext) {
    return neighborhoodVariants(ctx.parent.ir).filter((v) => ctx.check(v.ir).ok).map((v) => ({
      generator: 'neighborhood' as const, ir: { ...v.ir, label: ctx.parent.ir.label }, diff: v.diff,
      rationale: `参数邻域:${v.label}(${v.factor < 1 ? '更灵敏、信号更多' : '更平滑、信号更少'}),同时是父策略的平台检验点`,
      evidence: { factor: v.factor, sections: v.sections ?? 'all' },
    }));
  },
};
