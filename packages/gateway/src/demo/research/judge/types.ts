import type { StrategyJudge } from '@trade-gate/contracts';
import type { DecisionClient, DecisionResult } from '../../decisions.js';

export type { FrozenModelProfile, JudgeCandidateSnapshot, JudgeStateV1, NormalizedAnswer, PredicateEvaluation, JudgeResult } from '@trade-gate/contracts';
import type { FrozenModelProfile, JudgeCandidateSnapshot, JudgeStateV1 } from '@trade-gate/contracts';
export interface JudgeInput {
  candidate: JudgeCandidateSnapshot; state: JudgeStateV1; spec: StrategyJudge;
  execution_spec_hash: string; model_profile: FrozenModelProfile; decision_key: string;
}
/** Client 必须钉住连接版本，maxRetries=0；一次 decide 对应一次可收费请求。 */
export interface DecisionProvider {
  profile: FrozenModelProfile;
  decide: DecisionClient['decide'];
}
export type RecordedResponse = DecisionResult & { provider_request_id?: string; raw_response?: unknown };
