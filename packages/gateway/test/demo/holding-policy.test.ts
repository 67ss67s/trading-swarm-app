import { describe, expect, it } from 'vitest';
import { buildHoldingPlan, evaluateHoldingReview, holdingEntryGates, holdingEconomics, spikeEvidence } from '../../src/demo/holding-policy.js';
import { newThread } from '../../src/demo/threads.js';
import { tfToMs, type TfFeatures } from '../../src/demo/market.js';
import type { Direction, Kline, StrategyThread } from '../../src/demo/types.js';

const H = 3600000, NOW = 48 * H + 100;
const bar = (at: number, ms: number, close='100'): Kline => ({open_time:at,close_time:at+ms-1,open:close,high:close,low:close,close,volume:'100'});
const feature = (tf:string, at:number, direction:Direction='long', atr=5): TfFeatures => ({tf,last_open_time:at,last_close:direction==='long'?110:90,ema20:100,ema50:direction==='long'?95:105,atr14:atr} as TfFeatures);
function fixture(side:Direction='long'){
 const px=(n:number)=>String(side==='long'?n:200-n);
 let t:StrategyThread={...newThread({id:'independent-holding',backend:'paper',symbol:'BTCUSDT',side,source:'agent',timeframe:'15m',horizon:'swing',thesis:'frozen entry thesis',invalidation_text:px(95),watch_conditions:[],entry:{type:'market',price:'100',zone:null},stop_price:px(80),take_profits:[px(150)],qty:'1',margin_usdt:'100',leverage:1,margin_mode:'cross',now:1}),status:'in_position',opened_at:1,filled_avg_price:'100'};
 const features=[feature('4h',44*H,side),feature('1d',24*H,side)];
 t={...t,holding_plan:buildHoldingPlan({thread:t,features,now:1})!};
 const klines={'4h':[bar(40*H,4*H),bar(44*H,4*H)],'1d':[bar(24*H,24*H)]};
 return {t,features,klines,px,input:()=>({thread:t,now:NOW,market:{mark:'100',as_of:NOW-1},features,klines})};
}
describe('holding policy independent boundaries',()=>{
 for(const side of ['long','short'] as const){
  it(`${side}: incomplete or future primary bar cannot confirm invalidation`,()=>{const f=fixture(side);f.klines['4h']=[bar(44*H,4*H,f.px(90)),bar(48*H,4*H,f.px(90))];expect(evaluateHoldingReview(f.input()).allowed_actions).toEqual(['HOLD']);});
  it(`${side}: pre-entry two-close breach does not invalidate a newly opened position`,()=>{const f=fixture(side);f.klines['4h']=[bar(40*H,4*H,f.px(90)),bar(44*H,4*H,f.px(90))];expect(evaluateHoldingReview({...f.input(),thread:{...f.t,opened_at:44*H+1}}).allowed_actions).toEqual(['HOLD']);});
  it(`${side}: two actual post-entry closes beyond buffered structure allow EXIT`,()=>{const f=fixture(side);f.klines['4h']=[bar(40*H,4*H,f.px(90)),bar(44*H,4*H,f.px(90))];expect(evaluateHoldingReview(f.input()).allowed_actions).toContain('EXIT');});
  it(`${side}: fresh hard stop overrides missing plan and bars`,()=>{const f=fixture(side);expect(evaluateHoldingReview({...f.input(),thread:{...f.t,holding_plan:undefined},market:{mark:f.px(79),as_of:NOW-1},klines:{}}).required_action).toBe('EXIT');});
  it(`${side}: two newly flipped completed timeframes allow EXIT`,()=>{const f=fixture(side),opposite=side==='long'?'short':'long';f.features[0]=feature('4h',44*H,opposite);f.features[1]=feature('1d',24*H,opposite);expect(evaluateHoldingReview(f.input()).reason).toBe('new_both_timeframe_reversal');});
  it(`${side}: already opposing confirmation at entry is not two new flips`,()=>{const f=fixture(side),opposite=side==='long'?'short':'long';f.t.holding_plan!.entry_trends['1d']=opposite;f.features[0]=feature('4h',44*H,opposite);f.features[1]=feature('1d',24*H,opposite);expect(evaluateHoldingReview(f.input()).allowed_actions).toEqual(['HOLD']);});
  it(`${side}: malformed confirmation candle cannot manufacture a new trend reversal`,()=>{const f=fixture(side),opposite=side==='long'?'short':'long';f.features[0]=feature('4h',44*H,opposite);f.features[1]=feature('1d',24*H,opposite);f.klines['1d']=[{...bar(24*H,24*H),close_time:NOW-1}];expect(evaluateHoldingReview(f.input()).allowed_actions).toEqual(['HOLD']);});
  it(`${side}: duplicate primary candles are rejected instead of counted twice`,()=>{const f=fixture(side);const b=bar(44*H,4*H,f.px(90));f.klines['4h']=[b,b];expect(evaluateHoldingReview(f.input()).allowed_actions).toEqual(['HOLD']);});
 }
 it('derived decimal ATR ratio is not spuriously rejected by a second rounded division',()=>{const f=fixture();f.t.stop_price='91';f.t.holding_plan=buildHoldingPlan({thread:f.t,features:[feature('4h',0,'long',3.333333333333),feature('1d',0)],now:1})!;expect(holdingEntryGates(f.t.holding_plan,f.t).find(g=>g.name==='策略ATR尺度')!.passed).toBe(true);});
 it('net costs fail a gross 1.5 RR trade',()=>{const e=holdingEconomics('long','100','80','130','14')!;expect(Number(e.gross_rr)).toBe(1.5);expect(Number(e.net_rr)).toBeLessThan(1.5);});
 it('legacy snapshot does not fabricate entry-time trend direction',()=>{const f=fixture();const p=buildHoldingPlan({thread:f.t,features:f.features,now:NOW,origin:'legacy_snapshot'})!;expect(Object.values(p.entry_trends)).toEqual([null,null]);});
 it('spike detection uses previous 14 TR and never emits an EXIT signal',()=>{const bars=Array.from({length:16},(_,i)=>({...bar(i*900000,900000),high:'101',low:'99'}));bars[15]={...bars[15]!,low:'90',close:'99'};const s=spikeEvidence('long',bars,16*900000)!;expect(s.state).toBe('wick_recovered');expect(Number(s.excursion_atr)).toBe(5);expect(s.exit_signal).toBe(false);});
 it('future spike bar is excluded',()=>{const bars=Array.from({length:16},(_,i)=>({...bar(i*900000,900000),high:'101',low:'99'}));bars[15]={...bars[15]!,low:'90',close:'99'};expect(spikeEvidence('long',bars,15*900000)).toBeNull();});
 it('spike ATR must not cross missing history',()=>{const bars=Array.from({length:17},(_,i)=>({...bar(i*900000,900000),high:'101',low:'99'})).filter((_,i)=>i!==8);expect(spikeEvidence('long',bars,17*900000)).toBeNull();});
 it('duplicate spike history is unavailable',()=>{const bars=Array.from({length:16},(_,i)=>({...bar(i*900000,900000),high:'101',low:'99'}));bars[8]={...bars[7]!};expect(spikeEvidence('long',bars,16*900000)).toBeNull();});
 it('old cached spike is not presented as current evidence',()=>{const bars=Array.from({length:16},(_,i)=>({...bar(i*900000,900000),high:'101',low:'99'}));expect(spikeEvidence('long',bars,25*900000)).toBeNull();});
});

it('position confirmation is a full UTC week, not default 15m',()=>{expect(tfToMs('1w')).toBe(604800000);const f=fixture();f.t.horizon='position';const p=buildHoldingPlan({thread:f.t,features:[feature('1d',0),feature('1w',345600000)],now:1})!;expect(p.thesis_timeframe).toBe('1d');expect(p.confirm_timeframe).toBe('1w');});
it('model-selected multiple tolerates a stop between discrete choices (actual ≥ floor and ≥ 0.75× chosen)',()=>{const f=fixture();f.t.horizon='intraday';f.t.stop_price='94';const plan=(m:string)=>buildHoldingPlan({thread:f.t,features:[feature('1h',0),feature('4h',0)],judgment:{proposal:{risk_plan:{atr_timeframe:'1h',stop_atr_multiple:m}}} as never,now:1})!;const atr=(m:string)=>holdingEntryGates(plan(m),f.t).find(g=>g.name==='策略ATR尺度')!.passed;expect(atr('1.5')).toBe(true);expect(atr('2')).toBe(false);});
it('execution drift below actual strategy ATR minimum cannot reuse a derived selected multiple',()=>{const f=fixture();f.t.horizon='intraday';f.t.stop_price='95';const p=buildHoldingPlan({thread:f.t,features:[feature('1h',0),feature('4h',0)],now:1})!;const drift={...p,hard_stop:'96'};expect(holdingEntryGates(drift,{...f.t,stop_price:'96'}).find(g=>g.name==='策略ATR尺度')!.passed).toBe(false);});

it('trader-follow threads keep the signal provider stop: ATR scale gate does not reject wide stops',()=>{const f=fixture();f.t.horizon='intraday';f.t.stop_price='70';const p=buildHoldingPlan({thread:f.t,features:[feature('1h',0),feature('4h',0)],now:1})!;expect(holdingEntryGates(p,f.t).find(g=>g.name==='策略ATR尺度')!.passed).toBe(false);expect(holdingEntryGates(p,{...f.t,source:'trader'}).find(g=>g.name==='策略ATR尺度')!.passed).toBe(true);});
