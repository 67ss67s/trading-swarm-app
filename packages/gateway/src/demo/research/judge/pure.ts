import { Ajv2020 } from 'ajv/dist/2020.js';
import { schemas, type StrategyJudge, type ResearchBar, type JudgeStateField } from '@trading-swarm/contracts';
import type { DecisionQuestion } from '../../decisions.js';
import type { JudgeCandidateSnapshot, JudgeStateV1, NormalizedAnswer, PredicateEvaluation } from './types.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schemas.research); ajv.addSchema(schemas['research-orders']);
const validate = ajv.compile({ $ref: `${schemas.research.$id}#/$defs/StrategyJudge` });
export function validateJudge(spec: StrategyJudge): void {
  if (!validate(spec)) throw Error(`judge_schema:${ajv.errorsText(validate.errors)}`);
  const keys = new Set<string>();
  for (const q of spec.questions) {
    if (keys.has(q.key)) throw Error('judge_duplicate_question'); keys.add(q.key);
    if (q.criteria.length !== (q.type === 'noul' ? 2 : q.labels!.length)) throw Error('judge_criteria_labels_mismatch');
  }
  for (const p of spec.rule.all) {
    const q = spec.questions.find(q => q.key === p.question_key);
    if (!q || !(q.type === 'noul' ? ['yes', 'no'] : q.labels!).includes(p.label)) throw Error('judge_rule_reference');
  }
}
const exact = (o: object, keys: string[]) => { if (Object.keys(o).some(k => !keys.includes(k))) throw Error('judge_unknown_field'); };
const round = (n: number) => { if (!Number.isFinite(n)) throw Error('judge_nonfinite_feature'); return Number(n.toFixed(8)); };
const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

/** 固定最近 100 根已收盘 bar；不读取对象路径、不接受调用方提供的未来标签/账户对象。 */
export function buildJudgeState(candidate: JudgeCandidateSnapshot, bars: readonly ResearchBar[], spec: StrategyJudge): JudgeStateV1 {
  validateJudge(spec);
  exact(candidate, ['id','symbol','as_of','timeframe_ms','direction','entry','stop','target','reward_risk']);
  if (!Number.isSafeInteger(candidate.as_of) || !Number.isSafeInteger(candidate.timeframe_ms) || candidate.timeframe_ms <= 0 || !['long','short'].includes(candidate.direction)) throw Error('judge_candidate_invalid');
  for (const v of [candidate.entry, candidate.stop, candidate.target].filter(v => v !== null)) if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(v!) || !(Number(v) > 0)) throw Error('judge_price_invalid');
  const seen = bars.filter(b => b.close_time < candidate.as_of && b.available_at < candidate.as_of && b.open_time + candidate.timeframe_ms <= candidate.as_of).slice(-100);
  if (seen.length < 50 || seen.at(-1)!.open_time + candidate.timeframe_ms !== candidate.as_of) throw Error('judge_history_missing');
  for (let i = 0; i < seen.length; i++) {
    const b = seen[i]!;
    if (b.close_time !== b.open_time + candidate.timeframe_ms - 1 || i && b.open_time !== seen[i - 1]!.open_time + candidate.timeframe_ms) throw Error('judge_history_gap');
    if (![b.open,b.high,b.low,b.close,b.volume].every(x => Number.isFinite(Number(x))) || Number(b.low) <= 0 || Number(b.high) < Math.max(Number(b.open),Number(b.close)) || Number(b.low) > Math.min(Number(b.open),Number(b.close))) throw Error('judge_history_invalid');
  }
  const closes = seen.map(b => Number(b.close)), last = closes.at(-1)!;
  const atr = avg(seen.slice(-14).map((b, i) => Math.max(Number(b.high) - Number(b.low), Math.abs(Number(b.high) - closes[closes.length - 15 + i]!), Math.abs(Number(b.low) - closes[closes.length - 15 + i]!))));
  if (!(atr > 0)) throw Error('judge_atr_missing');
  const trend = avg(closes.slice(-20)) > avg(closes.slice(-50)) ? 'up' : 'down';
  const values: Partial<Record<JudgeStateField, string | number>> = {
    'candidate.direction': candidate.direction,
    'candidate.stop_distance_atr': round(Math.abs(Number(candidate.entry) - Number(candidate.stop)) / atr),
    ...(candidate.reward_risk === null ? {} : { 'candidate.reward_risk': round(candidate.reward_risk) }),
    'features.trend': trend, 'features.volatility': round(atr / last),
    'features.volume_ratio': round(Number(seen.at(-1)!.volume) / (avg(seen.slice(-20).map(b => Number(b.volume))) || 1)),
    'features.market_regime': atr / last > 0.04 ? 'volatile' : trend,
    // 历史 funding 要有 as-of 数据适配器后才开放，缺失不能伪造为 0。
  };
  const state: JudgeStateV1 = { version: 'judge_state_v1', as_of: candidate.as_of, timeframe_ms: candidate.timeframe_ms, candidate: {}, features: {} };
  for (const f of [...new Set(spec.questions.flatMap(q => q.state_fields))].sort()) {
    const value = values[f]; if (value === undefined) throw Error(`judge_field_unavailable:${f}`);
    const [group, key] = f.split('.') as ['candidate' | 'features', string]; (state[group] as Record<string,string|number>)[key] = value;
  }
  validateState(state,spec); return state;
}
export function validateState(state: JudgeStateV1, spec: StrategyJudge): void {
  exact(state, ['version','as_of','timeframe_ms','candidate','features']);
  if (state.version !== spec.state_schema_version || !Number.isSafeInteger(state.as_of) || state.as_of < 0 || !Number.isSafeInteger(state.timeframe_ms) || state.timeframe_ms <= 0) throw Error('judge_state_version');
  const want = new Set(spec.questions.flatMap(q => q.state_fields));
  const actual = [...Object.keys(state.candidate).map(k => `candidate.${k}`), ...Object.keys(state.features).map(k => `features.${k}`)];
  if (actual.length !== want.size || actual.some(k => !want.has(k as JudgeStateField))) throw Error('judge_unknown_or_missing_state_field');
  for (const group of ['candidate','features'] as const) for (const [key,value] of Object.entries(state[group])) {
    const choices = key === 'direction' ? ['long','short'] : key === 'trend' ? ['up','down'] : key === 'market_regime' ? ['up','down','volatile'] : null;
    if (choices ? typeof value !== 'string' || !choices.includes(value) : typeof value !== 'number' || !Number.isFinite(value) || (key !== 'funding' && value < 0)) throw Error('judge_state_value');
  }
}
export function decisionQuestions(spec: StrategyJudge): Record<string, DecisionQuestion> {
  return Object.fromEntries(spec.questions.map(q => [q.key, q.type === 'noul' ? { type: q.type, instructions: q.instructions, criteria: { true: q.criteria[0]!, false: q.criteria[1]! } } : q.type === 'score' ? { type: q.type, instructions: q.instructions, criteria: [...q.criteria] } : { type: q.type, instructions: q.instructions, criteria: Object.fromEntries(q.labels!.map((l,i) => [l,q.criteria[i]!])) }]));
}
/** score 使用有序类别概率，不把 score 的位置/期望当成获利概率。 */
export function normalizeAnswers(spec: StrategyJudge, raw: unknown): NormalizedAnswer[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('judge_answers_invalid');
  const all = raw as Record<string, Record<string, unknown>>;
  if (Object.keys(all).length !== spec.questions.length) throw Error('judge_answers_keys');
  const prob = (p: unknown): number => { if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw Error('judge_probability_invalid'); return p; };
  return spec.questions.map(q => {
    const a = all[q.key]; if (!a || a.type !== q.type) throw Error('judge_answer_type');
    if (q.type === 'noul') { exact(a, ['type','noul']); const p = prob(a.noul); return { question_key: q.key, probabilities: { yes: p, no: 1 - p } }; }
    exact(a, ['type',q.type,'confidence','probabilities']); prob(a.confidence);
    if (!a.probabilities || typeof a.probabilities !== 'object') throw Error('judge_distribution_missing');
    const src = a.probabilities as Record<string, unknown>, labels = q.labels!;
    const indexKeys = q.type === 'score' && Object.keys(src).every(k => /^\d+$/.test(k));
    const keys = indexKeys ? labels.map((_,i) => String(i)) : labels;
    if (Object.keys(src).length !== keys.length || Object.keys(src).some(k => !keys.includes(k))) throw Error('judge_distribution_labels');
    const ps = keys.map(k => prob(src[k]));
    if (Math.abs(ps.reduce((a,b) => a+b,0) - 1) > 1e-6) throw Error('judge_probability_sum');
    if (q.type === 'choice' && !labels.includes(String(a.choice))) throw Error('judge_choice_invalid');
    if (q.type === 'score' && (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > labels.length - 1)) throw Error('judge_score_invalid');
    return { question_key: q.key, probabilities: Object.fromEntries(labels.map((l,i) => [l,ps[i]!])) };
  });
}
export function evaluateJudgeRule(spec: StrategyJudge, answers: NormalizedAnswer[]): { action: 'follow' | 'skip'; uncertain: boolean; predicates: PredicateEvaluation[] } {
  const predicates = spec.rule.all.map(p => {
    const probability = answers.find(a => a.question_key === p.question_key)?.probabilities[p.label];
    if (probability === undefined) throw Error('judge_rule_answer_missing');
    const conservative = p.operator === 'gte' ? probability - p.margin : probability + p.margin;
    return { question_key: p.question_key, label: p.label, probability, conservative, passed: p.operator === 'gte' ? conservative >= p.threshold : conservative <= p.threshold };
  });
  const uncertain = predicates.some((v,i) => !v.passed && (spec.rule.all[i]!.operator === 'gte' ? v.probability >= spec.rule.all[i]!.threshold : v.probability <= spec.rule.all[i]!.threshold));
  return { action: predicates.every(p => p.passed) ? 'follow' : 'skip', uncertain, predicates };
}
