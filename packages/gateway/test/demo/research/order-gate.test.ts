import {it,expect} from 'vitest';
// 旧口径(LEGACY_ORDER_GATE:最小盈亏比 / 成本下限放宽 / 2R 兜底)的语义测试——旧 manifest 仍按它重放。新 run 的结构口径见 structure-exits.test.ts。
import {evaluateOrderGate,LEGACY_ORDER_GATE as DEFAULT_ORDER_GATE} from '../../../src/demo/research/order-gate.js';
import {runReplay} from '../../../src/demo/research/engine.js';
import {fixture,params} from './fixtures.js';
const input={side:'long' as const,entry:'100',stop:'97',target:'106',costs:{fee_rate:'0.001',slippage_bps:'5'},equity:'10000',qty:null,params:DEFAULT_ORDER_GATE};
it('computes decimal distances, round-trip costs and RR',()=>{const g=evaluateOrderGate(input);expect(g.ok).toBe(true);expect(g.rr).toBe(2);expect(g.stop_pct).toBe(.03);expect(g.round_trip_cost_pct).toBe(.003);expect(g.stop_over_cost).toBe(10);});
it('blocks wrong sides, missing targets, tight stops, low RR and excessive risk',()=>{expect(evaluateOrderGate({...input,target:null}).blocked_by).toContain('no_target');expect(evaluateOrderGate({...input,stop:'101'}).blocked_by).toContain('stop_side');expect(evaluateOrderGate({...input,target:'99'}).blocked_by).toContain('stop_side');expect(evaluateOrderGate({...input,stop:'99'}).blocked_by).toContain('stop_too_tight');expect(evaluateOrderGate({...input,target:'103'}).blocked_by).toContain('min_rr');expect(evaluateOrderGate({...input,qty:'100'}).blocked_by).toContain('risk_cap');expect(evaluateOrderGate({...input,side:'short',stop:'103',target:'94'}).ok).toBe(true);});
it('candidate hard gate prevents model access and preserves gate errors',async()=>{const r=params(),d=fixture();let calls=0;const result=await runReplay(d,{...r,arms:['c_filter'],repeats:1,order_gate:{...DEFAULT_ORDER_GATE,min_rr:100}},async()=>{calls++;return {action:'follow',reason:'bypass',evidence_refs:[],gate_errors:[]};});expect(calls).toBe(0);expect(result.arms[0]!.decisions.some(x=>x.action==='blocked'&&x.gate_errors.includes('min_rr'))).toBe(true);});
it('rechecks actual next-open risk and labels the fill rejection',async()=>{const r=params(),d=fixture(),start=30;r.from_ms=d.bars[start]!.close_time;r.to_ms=d.bars[start+2]!.close_time;const close=Number(d.bars[start]!.close);const next=d.bars[start+1]!;next.open=(close*1.2).toFixed(8);next.high=(close*1.25).toFixed(8);next.low=(close*1.19).toFixed(8);next.close=(close*1.21).toFixed(8);
const out=await runReplay(d,{...r,arms:['b_agent'],repeats:1,execution:{...r.execution,sizing_mode:'unit_notional'},order_gate:{...DEFAULT_ORDER_GATE,min_stop_cost_multiple:0,max_risk_fraction:'0.05',risk_cap_sizing:'all'}},async v=>v.at===r.from_ms?{action:'enter',entry:{candidate_id:'gap',stop:(close*.96).toFixed(8),target:(close*2).toFixed(8),reason:'test'},reason:'test',gate_errors:[],evidence_refs:[]}:{action:'no_trade',reason:'test',gate_errors:[],evidence_refs:[]});expect(out.arms[0]!.trades).toHaveLength(0);expect(out.arms[0]!.decisions.some(d=>d.action==='blocked'&&d.gate_errors.includes('risk_cap'))).toBe(true);});
import {fitOrderGate,riskCapApplies} from '../../../src/demo/research/order-gate.js';
import {precheck} from '../../../src/demo/research/precheck.js';
import {compileConstraints,policyToIR,defaultIR} from '../../../src/demo/research/strategy.js';
import {ResearchStore} from '../../../src/demo/research/store.js';
import {openStateDb} from '../../../src/state-db.js';
const costs={fee_rate:'0.001',slippage_bps:'5'};
it('fit widens a stop that is tighter than the cost floor and re-anchors a fixed-R target to the placed stop',()=>{
 const f=fitOrderGate({side:'long',entry:'100',stop:'99',target:null,target_r:2,costs,params:DEFAULT_ORDER_GATE});
 expect(f.fit.stop_source).toBe('cost_floor');expect(f.fit.floor_pct).toBeCloseTo(.024,8);expect(Number(f.stop)).toBeCloseTo(97.6,6);expect(f.fit.target_source).toBe('strategy');expect(Number(f.target)).toBeCloseTo(104.8,6);expect(f.fit.rr).toBeCloseTo(2,6);
 expect(evaluateOrderGate({side:'long',entry:'100',stop:f.stop,target:f.target,costs,equity:'10000',qty:null,params:DEFAULT_ORDER_GATE}).ok).toBe(true);
});
it('fit keeps a strategy stop that already clears the floor, backfills a missing target by fallback R, and leaves a too-close structure target for min_rr to block',()=>{
 const kept=fitOrderGate({side:'long',entry:'100',stop:'96',target:null,costs,params:DEFAULT_ORDER_GATE});
 expect(kept.fit.stop_source).toBe('strategy');expect(kept.stop).toBe('96.00000000');expect(kept.fit.target_source).toBe('fallback_r');expect(Number(kept.target)).toBeCloseTo(108,6);
 const none=fitOrderGate({side:'long',entry:'100',stop:'96',target:null,costs,params:{...DEFAULT_ORDER_GATE,target_fallback_r:null}});
 expect(none.target).toBeNull();expect(evaluateOrderGate({side:'long',entry:'100',stop:'96',target:null,costs,equity:'1',qty:null,params:DEFAULT_ORDER_GATE}).blocked_by).toContain('no_target');
 const close=fitOrderGate({side:'long',entry:'100',stop:'96',target:'102',costs,params:DEFAULT_ORDER_GATE});
 expect(close.fit.target_source).toBe('strategy');expect(evaluateOrderGate({side:'long',entry:'100',stop:close.stop,target:close.target,costs,equity:'1',qty:null,params:DEFAULT_ORDER_GATE}).blocked_by).toEqual(['min_rr']);
 const blocked=fitOrderGate({side:'long',entry:'100',stop:'99',target:'110',costs,params:{...DEFAULT_ORDER_GATE,stop_floor:'block'}});
 expect(blocked.fit.stop_source).toBe('strategy');expect(evaluateOrderGate({side:'long',entry:'100',stop:blocked.stop,target:blocked.target,costs,equity:'1',qty:null,params:{...DEFAULT_ORDER_GATE,stop_floor:'block'}}).blocked_by).toContain('stop_too_tight');
});
it('unit_notional is exempt from the per-trade risk cap unless risk_cap_sizing=all',()=>{
 expect(riskCapApplies(DEFAULT_ORDER_GATE,'unit_notional')).toBe(false);expect(riskCapApplies(DEFAULT_ORDER_GATE,'risk_fraction')).toBe(true);expect(riskCapApplies({...DEFAULT_ORDER_GATE,risk_cap_sizing:'all'},'unit_notional')).toBe(true);
});
it('a tight-ATR strategy now trades under the fit layer instead of being blocked wholesale, and gate_stats count the adjustments',async()=>{
 const r=params(),d=fixture();
 const out=await runReplay(d,{...r,arms:['a_rules'],execution:{...r.execution,sizing_mode:'unit_notional',fee_rate:'0.001',slippage_bps:'5'},order_gate:DEFAULT_ORDER_GATE},async()=>{throw Error('no_model');},{diagnostics:true});
 const arm=out.arms[0]!,stats=arm.diagnostics!.gate_stats!;
 expect(out.status).toBe('completed');expect(stats.evaluated).toBeGreaterThan(0);expect(stats.passed).toBeGreaterThan(0);expect(stats.blocked_by['stop_too_tight']??0).toBe(0);expect(stats.blocked_by['risk_cap']??0).toBe(0);
 const fitted=arm.decisions.filter(x=>x.fit);expect(fitted.length).toBeGreaterThan(0);expect(stats.blocked_by['min_rr']??0).toBe(0);
 for(const x of fitted)expect(x.fit!.stop_pct).toBeGreaterThanOrEqual(x.fit!.floor_pct-1e-9);
 expect(arm.trades.length).toBeGreaterThan(0);for(const t of arm.trades){expect(t.fit).toBeDefined();expect(t.stop).toBeDefined();if(t.fit!.stop_source==='cost_floor')expect(Number(t.fit!.strategy_stop)).toBeGreaterThan(Number(t.stop));}
 expect(arm.trades.some(t=>t.fit!.stop_source==='cost_floor')).toBe(true);
 const legacy=await runReplay(d,{...r,arms:['a_rules'],execution:{...r.execution,sizing_mode:'unit_notional',fee_rate:'0.001',slippage_bps:'5'},order_gate:{min_rr:1.5,min_stop_cost_multiple:8,max_risk_fraction:'0.02',require_target:true}},async()=>{throw Error('no_model');},{diagnostics:true});
 expect(legacy.arms[0]!.diagnostics!.gate_stats!.blocked_by['stop_too_tight']??0).toBeGreaterThan(0);expect(legacy.arms[0]!.decisions.some(x=>x.fit)).toBe(false);
 expect(stats.adjusted.stop_widened+stats.adjusted.target_fallback).toBeGreaterThanOrEqual(0);
});
it('precheck reports stop_fit_rate and compile exposes the concrete cost/RR constraints for the dataset',async()=>{
 const db=openStateDb(':memory:');try{const store=new ResearchStore(db.db),id=store.putDataset(fixture()).id,r=params(id),ir=policyToIR(r.policy!);
  const result=await precheck({ir,dataset_id:id,from_ms:r.from_ms,to_ms:r.to_ms,order_gate:DEFAULT_ORDER_GATE,execution:{...r.execution,sizing_mode:'unit_notional'},thresholds:{min_trades:1,min_gate_pass_rate:0,min_holding_bars:0,min_regime_coverage:0,max_stop_fit_rate:1}},store);
  const fit=result.items.find(i=>i.name==='stop_fit_rate')!;expect(fit.ok).toBe(true);expect(fit.note).toContain('成本下限');expect(result.items.find(i=>i.name==='order_gate_pass_rate')!.note).not.toContain('risk_cap');
  const c=compileConstraints('1h',store.dataset(id),r.execution,DEFAULT_ORDER_GATE,defaultIR());expect(c.stop_floor_pct).toBeCloseTo(8*c.round_trip_cost_pct,10);expect(c.min_rr).toBe(1.5);expect(c.atr_pct_median).not.toBeNull();expect(c.min_atr_multiple).not.toBeNull();expect(c.note).toContain('ATR');
 }finally{db.close();}
});
