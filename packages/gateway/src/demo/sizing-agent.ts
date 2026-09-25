/** Portfolio 意见层：无工具、无经济字段，失败回退。 */
import type { Brain } from './brain.js';
import type { SizingAgent } from './types.js';

export const SIZING_TIMEOUT_MS = 10_000;
export const SIZING_SYSTEM = '你是 Portfolio 仓位顾问。只输出 JSON：risk_multiplier、allow_min_lot_overshoot、可选 split_entries、reason。禁止数量、价格、杠杆及其他字段。倍率从证据 allowed_multipliers 选择，拆单从 allowed_splits 选择。reason 最多40字，任何数字必须来自证据。小账户可建议最小手风险放宽，大账户考虑信心、相关集中度和流动性；所有硬闸由代码裁决。';
export function sizingEvidence(facts: Record<string, unknown>): Record<string, unknown> {
  return { ...facts, allowed_multipliers: Array.from({ length: 36 }, (_, i) => (25 + i * 5) / 100), allowed_splits: [1, 2, 3] };
}
const numbers = (text: string): string[] => [...text.matchAll(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)].map((m) => String(Number(m[0])));
export function parseSizingOpinion(text: string, evidence: string): Omit<SizingAgent, 'applied'> {
  const p = JSON.parse(text) as Record<string, unknown>;
  if (!p || Array.isArray(p) || typeof p !== 'object'
    || Object.keys(p).some((k) => !['risk_multiplier', 'allow_min_lot_overshoot', 'split_entries', 'reason'].includes(k))
    || typeof p.risk_multiplier !== 'number' || !Number.isFinite(p.risk_multiplier) || p.risk_multiplier < 0.25 || p.risk_multiplier > 2
    || typeof p.allow_min_lot_overshoot !== 'boolean'
    || (p.split_entries !== undefined && (!Number.isInteger(p.split_entries) || Number(p.split_entries) < 1 || Number(p.split_entries) > 3))
    || typeof p.reason !== 'string' || !p.reason.trim() || [...p.reason].length > 40) throw new Error('意见不合契约');
  const known = new Set(numbers(evidence));
  if (numbers(JSON.stringify(p)).some((n) => !known.has(n))) throw new Error('意见数字不在证据');
  return { multiplier: p.risk_multiplier, overshoot: p.allow_min_lot_overshoot, split: Number(p.split_entries ?? 1), reason: p.reason };
}
export async function requestSizingOpinion(brain: Brain, evidence: Record<string, unknown>, mode: 'advise' | 'apply', timeoutMs = SIZING_TIMEOUT_MS): Promise<SizingAgent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const user = JSON.stringify(evidence);
    const result = await Promise.race([
      brain.complete(SIZING_SYSTEM, user, { timeoutMs }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('超时')), timeoutMs); }),
    ]);
    return { ...parseSizingOpinion(result.text, user), applied: mode === 'apply' };
  } catch {
    return { multiplier: 1, overshoot: false, split: 1, reason: '仓位意见不可用，回退代码预算', applied: false };
  } finally { if (timer) clearTimeout(timer); }
}
