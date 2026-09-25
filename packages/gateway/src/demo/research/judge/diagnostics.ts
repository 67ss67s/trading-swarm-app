import type { JudgeDecisionStore } from './store.js';
/** 只导出失败分布和费用分类，不导出 request/state/header；raw_response_ref 可对账。 */
export function judgeDiagnostics(store: JudgeDecisionStore) {
  const distributions: { raw_response_ref: string; question_key: string; probabilities: unknown; sum: number; deviation: number }[] = [];
  for (const r of store.db.prepare('SELECT request_hash,raw_json FROM research_judge_responses WHERE raw_json IS NOT NULL').all()) {
    const raw = JSON.parse(String(r.raw_json));
    const answers = raw.raw_response?.answers ?? raw.answers ?? {};
    for (const [question_key, a] of Object.entries(answers) as [string, { probabilities?: Record<string, unknown> }][]) {
      const ps = Object.values(a?.probabilities ?? {});
      if (!ps.length || ps.some(p => typeof p !== 'number' || !Number.isFinite(p))) continue;
      const sum = (ps as number[]).reduce((s,p) => s+p,0), deviation = Math.abs(sum-1);
      if (deviation > 1e-6) distributions.push({ raw_response_ref: String(r.request_hash), question_key, probabilities: a.probabilities, sum, deviation });
    }
  }
  const unknown_cost = store.db.prepare(`SELECT coalesce(r.error_code,'usage_cost_missing_or_invalid') reason,count(*) calls
    FROM research_call_attempts a JOIN research_judge_responses r USING(request_hash)
    WHERE a.actual_usd IS NULL GROUP BY reason`).all();
  return { distributions, summary: { count: distributions.length, within_001: distributions.filter(d => d.deviation <= 0.01+1e-12).length, max_deviation: distributions.length ? Math.max(...distributions.map(d => d.deviation)) : null }, unknown_cost };
}
