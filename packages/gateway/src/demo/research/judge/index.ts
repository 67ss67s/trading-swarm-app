import { needsMicrostructure, type MicrostructureSource } from './microstructure.js';
import { DecisionError } from '../../decisions.js';
import type { ResearchBar, StrategyIR } from '@trade-gate/contracts';
import { hash } from '../primitives.js';
import { buildJudgeState, decisionQuestions, evaluateJudgeRule, normalizeAnswers, validateJudge, validateState } from './pure.js';
import { AtomicCallBudget, JudgeDecisionStore, decisionId, usdUnits } from './store.js';
import type { DecisionProvider, FrozenModelProfile, JudgeCandidateSnapshot, JudgeInput, JudgeResult, RecordedResponse } from './types.js';
export * from './pure.js'; export * from './types.js'; export * from './store.js';
export interface JudgeDeps { mode: 'recorded_only' | 'request_once'; provider?: DecisionProvider; store: JudgeDecisionStore; budget: AtomicCallBudget; signal?: AbortSignal; now?: () => number }
export interface JudgeRuntime extends JudgeDeps { model_profile: FrozenModelProfile; execution_spec_hash: string; scope: string; microstructure?: MicrostructureSource }
export function fromDecisionClient(client: import('../../decisions.js').DecisionClient, profile: FrozenModelProfile): DecisionProvider {
  if (profile.retry_policy !== 'none') throw Error('judge_retries_forbidden');
  return { profile: structuredClone(profile), decide: (r,o) => client.decide(r,o) };
}
export async function judgeCandidate(input: Readonly<JudgeInput>, deps: JudgeDeps): Promise<JudgeResult> {
  const x = structuredClone(input); validateJudge(x.spec); validateState(x.state,x.spec);
  if (x.state.as_of !== x.candidate.as_of || x.state.timeframe_ms !== x.candidate.timeframe_ms) throw Error('judge_state_candidate_mismatch');
  if (x.spec.model_profile_ref !== x.model_profile.ref || !x.model_profile.model_revision || !['judge_answers_v1','judge_answers_v2_rounding_001'].includes(x.model_profile.parser_version) || x.model_profile.retry_policy !== 'none') throw Error('judge_profile_mismatch');
  const maximum = usdUnits(x.model_profile.max_call_usd);
  if (maximum === 0n && x.model_profile.routing !== 'offline_stub') throw Error('judge_price_bound_required');
  const request = { state: x.state as unknown as Record<string, unknown>, questions: decisionQuestions(x.spec) };
  // 回答可以跨阈值复用；最终 decision 仍绑定完整 IR / rule / scope。
  const identity = { request, ordered_questions: x.spec.questions, profile: x.model_profile, timeout_ms: x.spec.timeout_ms, serializer: 'canonical_v1' };
  const state_hash = hash(x.state), request_hash = hash(identity);
  const input_hash = hash(x), key = `${x.decision_key}:${hash({ spec:x.spec,execution:x.execution_spec_hash,profile:x.model_profile,candidate:x.candidate })}`;
  const old = deps.store.result(key,input_hash); if (old) return old;
  const base: JudgeResult = { status:'error',action:'skip',decision_id:decisionId(key),state_hash,request_hash,raw_response_ref:null,answers:[],predicates:[],model_revision:null,latency_ms:0,cost_usd:null,cost_status:'unknown',reason_codes:[] };
  const refuse = (code: string, pin = false): JudgeResult => {
    const usage = deps.store.usage(request_hash), cost_usd = usage ? usage.actual_usd : '0';
    const r: JudgeResult = {...base,cost_usd,cost_status:cost_usd === null ? 'unknown' : 'actual',reason_codes:[code]};
    return pin ? deps.store.put(key,input_hash,r,x) : r;
  };
  let row = deps.store.response(request_hash);
  if (!row) {
    if (deps.mode === 'recorded_only') return refuse('recorded_response_missing');
    if (deps.signal?.aborted || deps.budget.view().cancelled) return refuse('cancelled');
    if (!deps.provider || hash(deps.provider.profile) !== hash(x.model_profile)) return refuse('provider_profile_unavailable',true);
    let claimed: boolean;
    try { claimed = deps.store.claim(request_hash,identity,deps.budget,x.model_profile.max_call_usd); }
    catch (e) {
      const code = (e as Error).message;
      if (code === 'CANCELLED') return refuse(code);
      if (code === 'judge_budget_exhausted') return refuse(code,true);
      throw e; // DB/事务故障交给恢复；不能把调度故障钉成策略 skip。
    }
    if (claimed) {
      // Reserve 后到发送前再次检查取消。仍保留预留，宁可多记不能少记。
      if (deps.signal?.aborted || deps.budget.view().cancelled) deps.store.finish(request_hash,null,'cancelled_before_send');
      else {
        const ac = new AbortController(), abort = () => ac.abort(); deps.signal?.addEventListener('abort',abort,{once:true});
        let timer: ReturnType<typeof setTimeout> | undefined, response: RecordedResponse | null = null, error_code: string | null = null;
        try {
          const timeout = new Promise<never>((_,reject) => { timer=setTimeout(() => { ac.abort(); reject(Error('judge_timeout')); },x.spec.timeout_ms); });
          response = await Promise.race([deps.provider.decide(request,{timeoutMs:x.spec.timeout_ms,signal:ac.signal}),timeout]);
        } catch (e) {
          response = e instanceof DecisionError ? e.recorded_response : null;
          if (!response && e instanceof DecisionError && ['bad_request','decision_budget_exhausted'].includes(e.code)) response = {model:x.model_profile.model,answers:{},usage:{input_tokens:0,cost_usd:0},latency_ms:0,raw_response:{request_not_sent:true}};
          error_code = ac.signal.aborted ? 'judge_timeout_or_cancelled' : e instanceof DecisionError ? `provider_${e.code}` : 'provider_error';
          if (response) response = { ...response, response_error: error_code };
        }
        finally { if (timer) clearTimeout(timer); deps.signal?.removeEventListener('abort',abort); }
        // 持久化失败保留 pending/预留并抛给调度，不能伪装成 provider 错误。
        deps.store.finish(request_hash,response,error_code);
      }
    }
    row = deps.store.response(request_hash);
  }
  // 其他连接/worker 已预留：等待首次响应，不能把 pending 钉成 skip。
  const waitUntil = performance.now() + x.spec.timeout_ms + 100;
  while (row?.status === 'pending') {
    if (deps.signal?.aborted) throw Error('CANCELLED');
    if (performance.now() >= waitUntil) throw Error('judge_request_pending:recover_original_attempt');
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    row = deps.store.response(request_hash);
  }
  if (!row) throw Error('judge_request_missing_after_claim');
  if (!row.raw_json) return refuse(row.error_code ?? 'request_outcome_unknown',true);
  const raw = JSON.parse(row.raw_json) as RecordedResponse, usage = deps.store.usage(request_hash);
  base.raw_response_ref = request_hash; base.latency_ms = Number.isSafeInteger(raw.latency_ms) && raw.latency_ms >= 0 ? raw.latency_ms : 0; base.model_revision = x.model_profile.model_revision;
  base.cost_usd = usage?.actual_usd ?? null; base.cost_status = base.cost_usd === null ? 'unknown' : 'actual';
  let result: JudgeResult;
  try {
    if (deps.signal?.aborted || deps.budget.view().cancelled) throw Error('cancelled');
    if (!Number.isSafeInteger(raw.latency_ms) || raw.latency_ms < 0) throw Error('provider_latency_invalid');
    if (raw.model !== x.model_profile.model) throw Error('model_revision_mismatch');
    if (usage?.status === 'overrun') throw Error('provider_cost_exceeds_reservation');
    if (raw.response_error) throw Error(raw.response_error);
    const answers = normalizeAnswers(x.spec,raw.answers,x.model_profile.parser_version), rule = evaluateJudgeRule(x.spec,answers);
    result = {...base,status:rule.uncertain?'uncertain':'ok',action:rule.action,answers,predicates:rule.predicates,reason_codes:rule.uncertain?['margin_abstain']:rule.action==='skip'?['rule_skip']:[]};
  } catch (e) { result = {...base,reason_codes:[(e as Error).message]}; }
  // DB 失败不是模型解析失败；让调度恢复使用已经钉住的响应。
  // 调度取消不是策略答案：已存 raw/费用保留，恢复可据同一响应完成决策。
  if (result.reason_codes.includes('cancelled')) return result;
  return deps.store.put(key,input_hash,result,x);
}
/** 回测与所有运行模式都用此包装；不接受全量 FrozenData。 */
export async function judgeWithBars(ir: StrategyIR, candidate: JudgeCandidateSnapshot, bars: readonly ResearchBar[], runtime: JudgeRuntime): Promise<JudgeResult> {
  if (!ir.judge) throw Error('judge_spec_missing');
  let state;
  try { state = buildJudgeState(candidate,bars,ir.judge,needsMicrostructure(ir.judge) ? await runtime.microstructure?.(candidate.symbol,candidate.as_of) : null); }
  catch (e) {
    const key = `${runtime.scope}:${candidate.id}:${hash(ir)}`, input = hash({candidate,ir,profile:runtime.model_profile});
    return runtime.store.put(key,input,{status:'error',action:'skip',decision_id:decisionId(key),state_hash:'',request_hash:'',raw_response_ref:null,answers:[],predicates:[],model_revision:null,latency_ms:0,cost_usd:'0',cost_status:'actual',reason_codes:[(e as Error).message]}, {candidate,ir,profile:runtime.model_profile});
  }
  return judgeCandidate({candidate,state,spec:ir.judge,execution_spec_hash:runtime.execution_spec_hash,model_profile:runtime.model_profile,decision_key:`${runtime.scope}:${candidate.id}`},runtime);
}
