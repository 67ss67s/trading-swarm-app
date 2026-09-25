/** G1 使用生产 MatrixStudyService；此文件不实现另一个选择器，不读运行中数据库。 */
import { openStateDb } from '../../src/state-db.js';
import { MatrixStudyService } from '../../src/demo/research/matrix-study/service.js';
import { buildManifest } from '../../src/demo/research/matrix-study/manifest.js';
import { assertPurge } from '../../src/demo/research/judge/filter.js';
import { stubJudgeSpec,stubProvider } from '../../src/demo/research/judge/stubs.js';
import type { G1StudyInput,G1StudyOutcome } from '../../src/demo/research/study-eval/g1.js';
const DAY=86400000;
export async function runStudy(input:G1StudyInput):Promise<G1StudyOutcome> {
 const state=openStateDb(':memory:'),provider=stubProvider(input.judge_kind,input.seed);
 const first=input.panel.fine[input.panel.symbols[0]!]!,end=first.at(-1)!.close_time;
 // release 为三资产×三周期×首版可完整执行的两族×两臂；CI缩小数据/格子，不降低放行线。
 const release=input.profile==='release',timeframes=release?['15m','4h','1d']:['15m'];
 const days=Math.floor((end-first[0]!.open_time+1)/DAY)-(release?301:4);
 if(days<30) {state.close();throw Error('g1_panel_too_short_for_warmup_and_window');}
 const service=new MatrixStudyService({db:state.db,now:()=>Math.max(Date.now(),end+1),
  judge:{mode:'request_once',provider},runnerHasJudge:true,
  loader:async(symbol,tf,w,signal)=>{
   if(signal?.aborted)throw Error('CANCELLED');
   const source=input.bars[tf]?.[symbol];if(!source)throw Error('g1_fixture_series_missing');
   return {source:'g1_synthetic_offline',bars:source.filter(b=>b.open_time>=w.from_ms&&b.close_time<=w.to_ms)};
  },
 });
 try {
  const spec={research_program_id:`g1:${input.panel.null_kind}:${input.seed}:${input.judge_kind}`,symbols:release?input.panel.symbols:[input.panel.symbols[0]!],timeframes,
   families:['pullback','mean_reversion'],market:'spot',sides:['long'],arms:['code','code_judge'],judge:stubJudgeSpec(provider.profile),model_profile:provider.profile,
   window_days:Object.fromEntries(timeframes.map(tf=>[tf,days])),to_ms:end,purge_bars:218,
   iterate:{top_k:3,generations:release?3:1,candidates_per_generation:release?4:1,patience:2},
   budget:{max_variants:300,max_judge_calls:20000,max_judge_usd:'0',wall_clock_ms:14_400_000},
   protocol:{seed:input.seed%2147483647,evidence_mode:'unseen_holdout'},auto_finalize:true};
  const estimated=service.estimate({spec}),manifest=buildManifest(estimated.spec,null,end+1);
  for(const cell of manifest.cells)if(cell.applicability==='applicable'){
   const g=manifest.segments[cell.timeframe]!;
   for(const v of cell.variants)assertPurge(v.ir,g.purge_bars,g.timeframe_ms,[g.train,g.selection,g.holdout]);
  }
  const created=service.create({spec,idempotency_key:`g1:${input.seed}:${input.judge_kind}`});
  await service.idle();const row=service.store.require(created.id);
  if(row.status!=='completed')throw Error(`g1_study_failed:${row.status}:${row.state.error}`);
  if(row.state.ledger.attempt_count<1||row.state.ledger.trial_count<1)throw Error('g1_no_trials_evaluated');
  if(row.state.finalists.length&&row.state.holdout_state!=='released')throw Error('g1_finalist_holdout_not_released');
  return{passed:row.state.conclusion?.kind==='passed',attempt_count:row.state.ledger.attempt_count,trial_count:row.state.ledger.trial_count,finalist_count:row.state.finalists.length,judge_calls:row.state.usage.judge_calls};
 } finally {await service.idle();state.close();}
}
