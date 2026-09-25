/** matrix-study 的唯一接入面；无数据读取、网络或模型默认值。 */
export { requiredPurgeBars, assertPurge, assertSplitPurges } from './purge.js';
import type { ResearchBar, StrategyIR } from '@trading-swarm/contracts';
import { EvalEnv, runPool, type Window, type PoolRun } from '../improve/evaluate.js';
import { judgeWithBars, type JudgeRuntime } from './index.js';
import type { JudgeCandidateSnapshot, JudgeResult } from './types.js';
export interface CandidateLog { candidate: JudgeCandidateSnapshot; decision: JudgeResult | null }
export type CandidateRecorder = (candidate: JudgeCandidateSnapshot, decision: JudgeResult | null) => void;
export function judgeFilter(ir: StrategyIR, runtime: JudgeRuntime): (candidate: JudgeCandidateSnapshot, bars: ResearchBar[]) => Promise<JudgeResult> {
  return (candidate,bars) => judgeWithBars(ir,candidate,bars,runtime);
}
/** 不修改共享 env；两臂的候选全部保留，包括 skip/error/uncertain 和模拟器拒单。 */
export async function runWithJudge(env: EvalEnv, ir: StrategyIR, ir_key: string, window: Window, opts: {
  runtime?: JudgeRuntime; on_candidate?: CandidateRecorder; execution?: Parameters<typeof runPool>[4];
} = {}): Promise<PoolRun & { candidates: CandidateLog[] }> {
  if (ir.judge && !opts.runtime) throw Error('judge_runtime_missing');
  const local = new EvalEnv(env.data,env.check,env.executorFor), candidates: CandidateLog[] = [];
  local.judge = opts.runtime;
  local.on_candidate = (candidate,decision) => { candidates.push({candidate,decision}); opts.on_candidate?.(candidate,decision); };
  const result = await runPool(local,ir,ir_key,window,opts.execution);
  env.runs += local.runs;
  return {...result,candidates};
}
