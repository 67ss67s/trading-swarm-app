import { pairedBlockBootstrap } from './statistics.js';
import { usdUnits } from '../judge/store.js';
const DAY=86_400_000;
export const G3_PROTOCOL = {
 version:'g3_v1', candidates:6000,max_finalists:3,min_span_days:365,min_follow:100,min_blocks:20,
 arms:['code','cheap_trend','jev','deepseek','cash','matched_random'],primary_comparisons:['jev-code','jev-cheap_trend'],
 bootstrap_replicates:10000,alpha:0.05,seed:20260925,
 estimated_calls:{jev:6000,deepseek:6000,total:12000},
 estimated_cost_usd:{jev:'0.162',deepseek:'1.62',total:'1.782',with_10_percent_contingency:'1.9602'},
 price_basis:'任务评审提供的规划单价：Jev 0.000027/请求；DeepSeek 1000 输入+200 输出=0.00027/请求；非供应商现价核验',
} as const;
export interface G3RecordedFinalist {
 id:string; candidate_count:number; follow_count:number;
 /** 共同 UTC 日网格，unix 毫秒；所有臂同资本/持仓约束，含全部交易与模型实际成本。 */
 days:number[];
 daily_returns:Record<'code'|'cheap_trend'|'jev'|'deepseek'|'cash'|'matched_random',number[]>;
 block_days:number;max_holding_days:number;min_effect:number;max_drawdown:number;
 costs_included:true;jev_cost_usd:string;deepseek_cost_usd:string;
}
/** 输入为共同资本/约束下的账户日净收益，不接受独立机会 R 总和冒充账户净值。 */
export function evaluateG3Recorded(finalists:G3RecordedFinalist[]) { return evaluateRecorded(finalists,G3_PROTOCOL.arms); }
export type G3FourArmFinalist=Omit<G3RecordedFinalist,'daily_returns'> & {daily_returns:Record<'code'|'cheap_trend'|'jev'|'deepseek',number[]>};
export function evaluateG3FourRecorded(finalists:G3FourArmFinalist[]) { return evaluateRecorded(finalists,['code','cheap_trend','jev','deepseek']); }
function evaluateRecorded(finalists:(G3FourArmFinalist & {daily_returns:Partial<G3RecordedFinalist['daily_returns']>})[],arms:readonly (keyof G3RecordedFinalist['daily_returns'])[]) {
 if(!Array.isArray(finalists)||!finalists.length||finalists.length>G3_PROTOCOL.max_finalists||new Set(finalists.map(f=>f.id)).size!==finalists.length)throw Error('g3_finalists_invalid');
 const claims=finalists.length*G3_PROTOCOL.primary_comparisons.length;
 return finalists.map(f=>{
  const n=f.days.length;
  if(!n||f.days.some((d,i)=>!Number.isSafeInteger(d)||d<0||d%DAY!==0||i>0&&d!==f.days[i-1]!+DAY)
    ||Object.keys(f.daily_returns).length!==arms.length||arms.some(arm=>!Array.isArray(f.daily_returns[arm])||f.daily_returns[arm]!.length!==n||f.daily_returns[arm]!.some(r=>!Number.isFinite(r)||r< -1))
    ||![f.block_days,f.max_holding_days].every(v=>Number.isSafeInteger(v)&&v>0)||f.block_days<f.max_holding_days)throw Error('g3_common_grid_or_block_invalid');
  if(!Number.isSafeInteger(f.candidate_count)||f.candidate_count<0||!Number.isSafeInteger(f.follow_count)||f.follow_count<0||f.follow_count>f.candidate_count
    ||!Number.isFinite(f.min_effect)||f.min_effect<0||!Number.isFinite(f.max_drawdown)||f.max_drawdown<=0||f.max_drawdown>0.35||f.costs_included!==true)throw Error('g3_frozen_protocol_invalid');
  usdUnits(f.jev_cost_usd);usdUnits(f.deepseek_cost_usd);
  const ready=f.candidate_count>=6000&&f.follow_count>=100&&n>=365;
  const comparisons=(['code','cheap_trend'] as const).map(arm=>({arm,...pairedBlockBootstrap(f.daily_returns.jev,f.daily_returns[arm],{block_size:f.block_days,replicates:10000,seed:G3_PROTOCOL.seed,alpha:0.05/claims,min_blocks:20})}));
  let wealth=1,peak=1,drawdown=0;for(const r of f.daily_returns.jev){wealth*=1+r;peak=Math.max(peak,wealth);drawdown=Math.max(drawdown,1-wealth/peak);}
  const net=wealth-1;
  return{id:f.id,status:!ready||comparisons.some(c=>c.status!=='ok')?'insufficient_evidence':net>0&&drawdown<=f.max_drawdown&&comparisons.every(c=>c.ci![0]>f.min_effect)?'passed':'failed',comparisons,jev_net_return:net,jev_max_drawdown:drawdown,
   exploratory_deepseek:pairedBlockBootstrap(f.daily_returns.jev,f.daily_returns.deepseek,{block_size:f.block_days,replicates:10000,seed:G3_PROTOCOL.seed,min_blocks:20}),
   correction:'simultaneous_bonferroni_ci (conservative vs Holm)',costs:{jev_usd:f.jev_cost_usd,deepseek_usd:f.deepseek_cost_usd}};
 });
}
