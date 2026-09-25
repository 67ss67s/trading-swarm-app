import { describe,it,expect } from 'vitest';
import { evaluateG3Recorded,G3_PROTOCOL,type G3RecordedFinalist } from '../../../../src/demo/research/study-eval/g3.js';
const DAY=86400000;
function fixture(n=365):G3RecordedFinalist {
 const zero=Array(n).fill(0),profit=Array(n).fill(0.001);
 return{id:'frozen',candidate_count:6000,follow_count:200,days:Array.from({length:n},(_,i)=>Date.UTC(2020,0,1)+i*DAY),daily_returns:{code:zero,cheap_trend:zero,jev:profit,deepseek:zero,cash:zero,matched_random:zero},block_days:5,max_holding_days:4,min_effect:0.0001,max_drawdown:0.2,costs_included:true,jev_cost_usd:'0.162',deepseek_cost_usd:'1.62'};
}
describe('G3 已录账户数据协议，零真实调用',()=>{
 it('账户净增量、共同日网格与保守多重CI',()=>{const result=evaluateG3Recorded([fixture()])[0]!;expect(result.status).toBe('passed');expect(result.correction).toContain('bonferroni');expect(result.comparisons).toHaveLength(2);});
 it('全 skip 与时间/参与不足不能成为赚钱策略',()=>{const f=fixture(30);f.follow_count=0;f.daily_returns.jev=Array(30).fill(0);expect(evaluateG3Recorded([f])[0]!.status).toBe('insufficient_evidence');});
 it('真实风险门槛仍生效，不能只看均值差',()=>{const f=fixture();f.daily_returns.jev[180]=-0.3;expect(evaluateG3Recorded([f])[0]!.status).toBe('failed');});
 it('缺臂、块小于持仓、未来网格、未知费用或漏成本不能分析',()=>{
  const f=fixture();expect(()=>evaluateG3Recorded([{...f,block_days:1}])).toThrow('grid_or_block');
  expect(()=>evaluateG3Recorded([{...f,days:f.days.map((d,i)=>d+(i===5?1:0))}])).toThrow('grid_or_block');
  expect(()=>evaluateG3Recorded([{...f,daily_returns:{...f.daily_returns,cash:[]} }])).toThrow('grid_or_block');
  expect(()=>evaluateG3Recorded([{...f,jev_cost_usd:'unknown'}])).toThrow('decimal');
  expect(()=>evaluateG3Recorded([{...f,costs_included:false as never}])).toThrow('protocol');
 });
 it('采集预算是明示规划值，调用数12000、0重抽',()=>{expect(G3_PROTOCOL.estimated_calls.total).toBe(12000);expect(G3_PROTOCOL.estimated_cost_usd.total).toBe('1.782');});
});
