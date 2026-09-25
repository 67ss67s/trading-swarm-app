import { describe, expect, it } from 'vitest';
import { replay, COSTS, priorATR, aggregate } from '../scripts/holding-ab.mjs';
const ms=900000;
const b=(i:number,o:number,h:number,l:number,c:number)=>({open_time:i*ms,close_time:(i+1)*ms-1,open:String(o),high:String(h),low:String(l),close:String(c),volume:'1'});
const seed={side:'long',entry:'100',risk:'10',hard_stop:'90',target:'130',opened_at:0,end_at:3*ms-1};
const bars=[b(0,100,102,99,101),b(1,105,108,104,107),b(2,108,111,107,110)];
describe('cost-aware causal holding replay',()=>{
 it('EXIT fills next bar open and charges actual fill costs',()=>{const r=replay(seed,bars,[{at:ms-1,action:'EXIT'}]);expect(r.fills[0]).toMatchObject({price:'105.00000000',reason:'model_exit'});expect(r.gross_r).toBeCloseTo(.5);expect(r.net_r).toBeLessThan(r.gross_r);expect(r.fee_r).toBeCloseTo((100+105)*COSTS.fee_per_side/10);});
 it('REDUCE sells half and keeps the remainder exposed',()=>{const r=replay(seed,bars,[{at:ms-1,action:'REDUCE'}]);expect(r.fills[0]).toMatchObject({fraction:.5,reason:'model_reduce'});expect(r.fills[1]).toMatchObject({fraction:.5,reason:'evaluation_expiry'});expect(r.gross_r).toBeCloseTo(.75);});
 it('same-bar stop and target uses stop first',()=>{const r=replay(seed,[b(0,100,140,85,110)],[]);expect(r.fills[0].reason).toBe('hard_stop');expect(r.gross_r).toBe(-1);});
 it('gap beyond stop realizes worse than minus one R',()=>{const r=replay(seed,[b(0,80,85,75,82)],[]);expect(r.fills[0].reason).toBe('gap_stop');expect(r.gross_r).toBe(-2);});
 it('HOLD cannot cancel an exchange hard stop',()=>{expect(replay(seed,[b(0,100,105,80,95)],[{at:ms-1,action:'HOLD'}]).fills[0].reason).toBe('hard_stop');});
 it('short REDUCE mirrors long before costs',()=>{const m=bars.map(x=>({...x,open:String(200-Number(x.open)),high:String(200-Number(x.low)),low:String(200-Number(x.high)),close:String(200-Number(x.close))}));const r=replay({...seed,side:'short',hard_stop:'110',target:'70'},m,[{at:ms-1,action:'REDUCE'}]);expect(r.gross_r).toBeCloseTo(.75);expect(r.funding_r).toBeGreaterThan(0);});
 it('events after exit cannot reopen a position',()=>{expect(replay(seed,bars,[{at:ms-1,action:'EXIT'},{at:2*ms-1,action:'REDUCE'}]).fills).toHaveLength(1);});
 it('funding charges held notional and elapsed time',()=>{expect(replay(seed,bars,[{at:ms-1,action:'EXIT'}]).funding_r).toBeCloseTo(100*.0001*(.25/8)/10);});
 it('incomplete aggregate cannot create completed high-timeframe bar',()=>{expect(aggregate(bars,'1h')).toHaveLength(0);expect(aggregate([...bars,b(3,110,113,109,111)],'1h')).toHaveLength(1);});
 it('ATR requires continuous 15-bar prehistory',()=>{const a=Array.from({length:15},(_,i)=>b(i,100,101,99,100));expect(priorATR(a)).toBe(2);a[7]=b(6,100,101,99,100);expect(priorATR(a)).toBeNull();});
});
