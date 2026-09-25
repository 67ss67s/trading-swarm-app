/** 零网络、零模型费用的研究工作台联调样本；不是策略收益证明。 */
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runReplay } from '../dist/demo/research/engine.js';
import { selectionEvaluation } from '../dist/demo/research/evaluation.js';
import { hash } from '../dist/demo/research/primitives.js';
const dir=resolve(process.argv[2]??'../../work/research-demo');mkdirSync(dir,{recursive:true});
const t0=Date.UTC(2025,0,1),step=3600000;let price=100;
const bars=Array.from({length:420},(_,i)=>{const open=price;price=Math.max(30,price+(i%17===0?-8:i%8===0?4:.4));return {open_time:t0+i*step,close_time:t0+(i+1)*step-1,available_at:t0+(i+1)*step-1,open:open.toFixed(8),high:(Math.max(open,price)+.2).toFixed(8),low:(Math.min(open,price)-.2).toFixed(8),close:price.toFixed(8),volume:i%8===0?'200':'100'};});
const dataset={venue:'synthetic',market:'spot',symbol:'TEST-USDT',timeframe_ms:step,source:'deterministic engineering fixture; NOT economic evidence',retrieved_at:bars.at(-1).close_time,bars};
const study={id:'research-demo-study',dataset_id:hash(dataset),from_ms:bars[30].close_time,development_to_ms:bars[180].close_time,validation_from_ms:bars[200].close_time,validation_to_ms:bars[280].close_time,holdout_from_ms:bars[300].close_time,to_ms:bars[400].close_time,purge_bars:12,max_trials:20};
const request={idempotency_key:'research-demo-v1',dataset_id:study.dataset_id,policy:{label:'收盘突破研究样本',description:'收盘突破前5根最高价且放量；ATR止损；固定目标与持有期。B、C是脚本fixture，不是LLM。',interpretation:'donchian_close_long_v1',lookback:5,atr_period:5,stop_atr:2,take_profit_r:2,volume_multiple:1,holding_bars:8},execution:{initial_cash:'10000',risk_fraction:'0.01',max_allocation:'0.25',fee_rate:'0.001',slippage_bps:'5',qty_step:'0.00000001',min_notional:'5',max_opens_per_day:10},from_ms:study.from_ms,to_ms:study.development_to_ms,arms:['a_rules','b_agent','c_filter'],repeats:2,max_model_calls:1000,timeout_ms:60000,purpose:'development',study_id:study.id,acknowledge_adaptive_search:true};
const fixtureAgent=async v=>{
 const common={reason:'synthetic_decider_fixture',gate_errors:[],evidence_refs:[]};
 if(v.arm.startsWith('c_filter'))return {...common,action:Math.floor(v.at/step)%3===0?'skip':'follow',reason:'fixture按时钟余数筛选，仅用于展示对照，不使用未来标签'};
 if(v.position)return {...common,action:v.position.bars_held>=3?'exit':'hold',reason:'fixture持仓3根后退出，下一open成交'};
 return v.candidate?{...common,action:'enter',entry:v.candidate}:{...common,action:'no_trade'};
};
const result=await runReplay(dataset,request,fixtureAgent);result.evaluation=selectionEvaluation(dataset,request,result);
const replay=await runReplay(dataset,request,async()=>{throw Error('must not call model')},{replay:result.recordings});
const evidence={label:'engineering_only_synthetic_data_and_scripted_decider',model_calls:0,recorded_replay_identical:hash(replay.arms)===hash(result.arms),expected_hash:hash(result.arms),actual_hash:hash(replay.arms),arm_metrics:result.arms.map(a=>({arm:a.arm,...a.metrics}))};
for(const [name,value] of Object.entries({dataset,study,request,result,evidence}))writeFileSync(resolve(dir,`${name}.json`),JSON.stringify(value,null,2)+'\n');
writeFileSync(resolve(dir,'differences.json'),JSON.stringify(result.comparison,null,2)+'\n');
console.log(JSON.stringify({dir,...evidence},null,2));
