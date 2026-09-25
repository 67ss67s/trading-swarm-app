import { aggregatePanel,correlatedWalk,positiveControl,signFlipBlocks,syntheticDevelopment,type NullPanel } from './nulls.js';
import { clopperPearsonUpper,g1Verdict,type G1Count } from './statistics.js';
import type { JudgeStubKind } from '../judge/stubs.js';
export interface G1StudyInput { panel:NullPanel; bars:ReturnType<typeof aggregatePanel>; judge_kind:JudgeStubKind; seed:number; replicate:number; profile:'ci'|'release'; }
export interface G1StudyOutcome { passed:boolean; attempt_count:number; trial_count:number; finalist_count:number; judge_calls:number; }
/** Adapter 必须重跑 manifest→搜索/迭代→冻结 finalist→一次留出，不能只评分旧冠军。 */
export type G1StudyAdapter=(input:G1StudyInput)=>Promise<G1StudyOutcome>;
export interface G1Options { profile:'ci'|'release'; null_replicates:number; positive_replicates:number; fine_bars:number; seed:number; judge_kinds?:JudgeStubKind[]; }
export async function runG1(adapter:G1StudyAdapter,opts:G1Options,onProgress?:(p:Record<string,unknown>)=>void) {
 if(!Number.isSafeInteger(opts.null_replicates)||opts.null_replicates<1||!Number.isSafeInteger(opts.positive_replicates)||opts.positive_replicates<1)throw Error('g1_replicates_invalid');
 if(opts.profile==='release'&&(opts.null_replicates!==1000||opts.positive_replicates!==100))throw Error('g1_release_requires_1000x2_and_100_controls');
 const kinds=opts.judge_kinds??['deterministic','random','all_skip','boundary_drift'],dev=syntheticDevelopment(opts.seed),groups:G1Count[]=[],counts:Record<string,number>={attempt_count:0,trial_count:0,judge_calls:0,study_runs:0};
 const execute=async(panel:NullPanel,i:number,control=false)=>{
  // 同一 replicate 的各桩合起来是一项 Study 级事件：任一臂放行即记一次，不能按格子稀释。
  let passed=false;const aggregated=aggregatePanel(panel);
  for(const kind of control?kinds.filter(k=>k!=='all_skip'):kinds){const out=await adapter({panel,bars:aggregated,judge_kind:kind,seed:panel.seed,replicate:i,profile:opts.profile});if(![out.attempt_count,out.trial_count,out.judge_calls,out.finalist_count].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('g1_adapter_accounting_invalid');passed ||= out.passed;counts.study_runs!++;counts.attempt_count!+=out.attempt_count;counts.trial_count!+=out.trial_count;counts.judge_calls!+=out.judge_calls;}
  return passed;
 };
 for(const kind of ['n1','n2'] as const){let false_releases=0;for(let i=0;i<opts.null_replicates;i++){
  const o={seed:opts.seed+(kind==='n1'?0:1_000_000)+i,bars:opts.fine_bars};const panel=kind==='n1'?correlatedWalk(o):signFlipBlocks(o,dev);if(await execute(panel,i))false_releases++;onProgress?.({null_kind:kind,done:i+1,total:opts.null_replicates,false_releases});
 }groups.push({null_kind:kind,studies:opts.null_replicates,false_releases,upper_975:clopperPearsonUpper(false_releases,opts.null_replicates)});}
 let detected=0;for(let i=0;i<opts.positive_replicates;i++)if(await execute(positiveControl({seed:opts.seed+2_000_000+i,bars:opts.fine_bars}),i,true))detected++;
 const positive={studies:opts.positive_replicates,detected};
 return{gate:'g1',profile:opts.profile,status:g1Verdict(groups,positive,opts.profile),groups,positive,counts,provider:'offline_stubs',cost_usd:'0',claim:opts.profile==='ci'?'仅证明流程和统计门槛；不声明 FWER 通过':'四类桩的联合释放事件；不声明真实 Jev 全链 G1',protocol:opts};
}
