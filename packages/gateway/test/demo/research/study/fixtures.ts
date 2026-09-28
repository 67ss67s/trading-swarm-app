import type { ResearchBar, StrategyIR } from '@trade-gate/contracts';
import { node } from '../../../../src/demo/research/strategy.js';
import { candidateSnapshot } from '../../../../src/demo/research/judge/candidate.js';
import { AtomicCallBudget, JudgeDecisionStore, buildJudgeState, type JudgeInput, type JudgeRuntime } from '../../../../src/demo/research/judge/index.js';
import { stubJudgeSpec, stubProvider, type JudgeStubKind } from '../../../../src/demo/research/judge/stubs.js';
import { openStateDb } from '../../../../src/state-db.js';
export const STEP=4*3600000, START=Date.UTC(2020,0,1);
export function bars(n=600, step=STEP): ResearchBar[] {
  let prev=100;
  return Array.from({length:n},(_,i)=> { const c=100+Math.sin(i*Math.PI/4)*3+i*0.0001, o=prev;prev=c;const at=START+i*step;return {open_time:at,close_time:at+step-1,available_at:at+step-1,open:o.toFixed(8),high:(Math.max(o,c)+1).toFixed(8),low:(Math.min(o,c)-1).toFixed(8),close:c.toFixed(8),volume:'100'}; });
}
export function ir(judge=false,side:'long'|'short'='long'): StrategyIR {
  return {version:judge?2:1,label:'offline_fixture',description:'离线确定性',signal:[node('indicator_cross',{indicator:'price',compare_to:'indicator',compare_indicator:'ema',compare_args:{period:3},direction:side==='long'?'cross_above':'cross_below'})],entry:node('next_open_market',{}),risk:{stop:node('atr_stop',{atr_period:14,multiple:2}),sizing:node('equal_notional',{max_allocation:'1'})},exit:[node('time_stop',{bars:4},true)],order:{direction:side,market:side==='long'?'spot':'perp',take_profits:[{source:node('fixed_r_target',{r:2})}],min_rr:0,on_new_signal:{unfilled:'keep',filled:'ignore'},max_holding_bars:4},...(judge?{judge:stubJudgeSpec()}: {})};
}
export function judgeFixture(kind:JudgeStubKind='deterministic', max_calls=10000,max_usd='1') {
  const state=openStateDb(':memory:'), provider=stubProvider(kind), spec=stubJudgeSpec(provider.profile), store=new JudgeDecisionStore(state.db,()=>1000),budget=AtomicCallBudget.create(state.db,'study',max_calls,max_usd);
  const data=bars(120), candidate=candidateSnapshot(ir(),{symbol:'BTCUSDT',as_of:data.at(-1)!.close_time+1,timeframe_ms:STEP,direction:'long',entry:'100',stop:'95',target:'110',reward_risk:2});
  const input:JudgeInput={candidate,state:buildJudgeState(candidate,data,spec),spec,execution_spec_hash:'execution_v1',model_profile:provider.profile,decision_key:candidate.id};
  const runtime:JudgeRuntime={mode:'request_once',provider,store,budget,model_profile:provider.profile,execution_spec_hash:'execution_v1',scope:'test'};
  return {state,provider,spec,store,budget,data,candidate,input,runtime};
}
