import { it,expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { calculateMicrostructure,baseQuantity,type MicrostructureSnapshot } from '../../../../src/demo/research/judge/microstructure.js';
import { readRecordingLines } from '../../../../src/demo/research/judge/recordings.js';
import { buildJudgeState,judgeWithBars } from '../../../../src/demo/research/judge/index.js';
import { judgeFixture,ir } from './fixtures.js';
const at=1_000_000;
const snapshot=():MicrostructureSnapshot=>({symbol:'BTCUSDT',book:{at,available_at:at,bids:[['99.9','2'],['99.8','10'],['99','1000']],asks:[['100.1','1'],['100.2','5'],['101','1000']]},liquidations:[{id:'x',at:at-1,available_at:at,price:'100',quantity:'0.2',position_side:'long'}],liquidation_coverage:{from_ms:at-300_000,to_ms:at,available_at:at}});
it('±0.5% 盘口墙、名义额、spread、方向与去重，张数换算',()=>{
 const x=snapshot();x.liquidations=[...x.liquidations,...x.liquidations];const f=calculateMicrostructure(x,at);
 expect(f.ob_wall_down).toEqual({price:'99.8',notional:'998'});expect(f.ob_wall_up).toEqual({price:'100.2',notional:'501'});expect(f.spread_bps).toBe(20);expect(f.ob_imbalance_05).toBeCloseTo((1197.8-601.1)/(1197.8+601.1));expect(f.liq_long_5m).toBe('20');expect(f.liq_short_5m).toBe('0');expect(baseQuantity('11.89','0.01')).toBe('0.1189');
});
it('未来/过期/未覆盖不填0；窗口左开右闭',()=>{
 const x=snapshot();x.book!.available_at=at+1;x.liquidation_coverage=null;expect(calculateMicrostructure(x,at)).toEqual({});
 const y=snapshot();y.liquidations=[{...y.liquidations[0]!,at:at-300_000},{...y.liquidations[0]!,id:'future',at:at+1}];expect(calculateMicrostructure(y,at).liq_long_5m).toBe('0');expect(calculateMicrostructure(snapshot(),at+120001)).toEqual({});
});
it('截断 gzip 完整前缀可读，末尾半行不伪造',()=>{
 const bytes=gzipSync('{"at":1}\n{"at":2');expect(readRecordingLines(bytes.subarray(0,bytes.length-8))).toEqual([{at:1}]);
});
it('缺 live_only state 返回可识别不可评原因，不收费；带来源同源构建',async()=>{
 const f=judgeFixture();try{const spec={...f.spec,questions:[{...f.spec.questions[0]!,state_fields:['features.spread_bps' as const]}]};
 const result=await judgeWithBars({...ir(true),judge:spec},f.candidate,f.data,f.runtime);expect(result.reason_codes[0]).toContain('judge_live_only_data_unavailable');expect(f.provider.calls).toBe(0);
 const x=snapshot();x.book={...x.book!,at:f.candidate.as_of,available_at:f.candidate.as_of};expect(buildJudgeState(f.candidate,f.data,spec,x).features.spread_bps).toBe(20);
 }finally{f.state.close();}
});
