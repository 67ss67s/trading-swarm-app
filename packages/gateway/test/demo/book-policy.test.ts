import { describe,it,expect } from 'vitest';
import {evaluateBook,type BookInputs} from '../../src/demo/book-policy.js';
const base:BookInputs={equity:'1000',available:'1000',entry:'100',stop:'99',side:'long',risk_pct:'0.5',remaining_stop_budget:'20',remaining_notional:'4000',liquidity_cap:'100000',step_size:'0.001',min_qty:'0.001',min_notional:'5',max_leverage:4,horizon:'intraday',regime:'trend',strategy_health:'healthy',round_trip_cost_bps:'12',funding_budget_bps:'0',now:1000000,observed_at:1000000};
describe('Book risk-first allocation',()=>{
 it('chooses lowest sufficient leverage, costs included',()=>{const x=evaluateBook(base);expect(x.verdict).toBe('candidate');expect(x.leverage).toBe(2);expect(Number(x.loss_at_stop_with_costs)).toBeLessThanOrEqual(5);expect(Number(x.margin)).toBeLessThanOrEqual(250);});
 it('small capital does not raise percentage exposure or leverage',()=>{const x=evaluateBook(base), y=evaluateBook({...base,equity:'100',available:'100'});expect(y.leverage).toBe(x.leverage);expect(Number(y.notional)/100).toBeLessThanOrEqual(Number(x.notional)/1000+0.001);});
 it('cannot round minimum lot upwards through risk cap',()=>{expect(evaluateBook({...base,equity:'10',available:'10',min_notional:'100'}).verdict).toBe('reject');});
 it('funding reduces quantity for identical stop risk',()=>{expect(Number(evaluateBook({...base,funding_budget_bps:'30'}).qty)).toBeLessThan(Number(evaluateBook(base).qty));});
 it('stress blocks new risk',()=>expect(evaluateBook({...base,regime:'stress'}).verdict).toBe('reject'));
 it('unknown and degraded states reduce allocation',()=>{expect(Number(evaluateBook({...base,regime:'unknown',strategy_health:'unknown'}).qty)).toBeLessThan(Number(evaluateBook(base).qty));});
 it.each(['scalp','intraday','swing','position'] as const)('never exceeds configured leverage in %s',horizon=>{expect(evaluateBook({...base,horizon,max_leverage:1}).leverage).toBe(1);});
 it.each([0,1,180001,-180001])('rejects stale or future snapshot offset %s',delta=>{const x=evaluateBook({...base,observed_at:delta===0?0:base.now+delta});expect(x.verdict).toBe('reject');});
 it('rejects wrong-side stop',()=>expect(evaluateBook({...base,stop:'101'}).verdict).toBe('reject'));
 it('supports short side with conservative exit costs',()=>{const x=evaluateBook({...base,side:'short',stop:'101'});expect(x.verdict).toBe('candidate');expect(Number(x.loss_at_stop_with_costs)).toBeLessThanOrEqual(5);});
 it('reserves existing stop budget',()=>{const x=evaluateBook({...base,remaining_stop_budget:'0.1'});expect(Number(x.loss_at_stop_with_costs)).toBeLessThanOrEqual(0.1);});
 it.each(['0','NaN','-1','Infinity'])('rejects invalid price %s',entry=>expect(evaluateBook({...base,entry}).verdict).toBe('reject'));
 it('grid of equity, horizon, and regimes respects all declared budgets',()=>{
  for(const equity of ['10','100','1000','100000'])for(const horizon of ['scalp','intraday','swing','position'] as const)for(const regime of ['trend','range','transition','unknown'] as const){const x=evaluateBook({...base,equity,available:equity,horizon,regime});if(x.verdict==='candidate'){expect(Number(x.loss_at_stop_with_costs)).toBeLessThanOrEqual(Number(x.risk_budget)+1e-10);expect(Number(x.margin)).toBeLessThanOrEqual(Number(equity)*0.25+1e-10);expect(Number(x.notional)).toBeLessThanOrEqual(4000);expect(x.leverage).toBeLessThanOrEqual(4);}}
 });
});
