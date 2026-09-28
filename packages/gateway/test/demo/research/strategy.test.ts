import { SpotLedger } from '../../../src/demo/research/ledger.js';
import { describe,it,expect,vi } from 'vitest';
import { validate,type StrategyIR } from '@trade-gate/contracts';
import { fixture,params,STEP } from './fixtures.js';
import { defaultIR,checkIR,compileStrategy,policyToIR,irToPolicy,node,irCandidate } from '../../../src/demo/research/strategy.js';
import { registry,listPrimitives } from '../../../src/demo/research/primitives/index.js';
import { runReplay } from '../../../src/demo/research/engine.js';
import { hash,request } from '../../../src/demo/research/primitives.js';
const defaults:Record<string,Record<string,unknown>>={macd_cross:{fast:12,slow:26,signal:9},macd_divergence:{fast:12,slow:26,signal:9,swing_length:3,lookback:60},macd_divergence_exit:{fast:12,slow:26,signal:9,swing_length:3,lookback:60,source:"macd"},structure_pivots:{swing_length:3},structure_bos:{swing_length:3,confirmation:'close'},order_blocks:{swing_length:3,zone:'wick'},htf_structure:{swing_length:3,htf:'1d'},structure_target:{swing_length:3,htf:'1d'},donchian_breakout:{lookback:20,basis:'close'},volume_surge:{lookback:20,multiple:1.2},ema_cross:{fast:10,slow:30},rsi_threshold:{period:14,threshold:50,operator:'above'},higher_low_sequence:{count:3},next_open_market:{},atr_stop:{atr_period:14,multiple:2},swing_low_stop:{lookback:10},chandelier_trail:{atr_period:22,multiple:3},swing_structure_stop:{lookback:10},trend_break:{ema_period:50,htf:'4h'},breakeven_after_r:{r:1},time_stop:{bars:96},fixed_r_target:{r:2},risk_fraction:{fraction:'0.01',max_allocation:'0.25'},equal_notional:{max_allocation:'0.25'},residual_sharpe_min:{minimum:0},beta_max:{maximum:2},trend_required:{states:['up']},trend_state:{adx_period:14,adx_min:20,ema_fast:20,ema_slow:50,htf:'4h'},indicator_cross:{indicator:'sma',args:{period:20},compare_to:'indicator',compare_indicator:'sma',compare_args:{period:50},direction:'cross_above'},indicator_cross_exit:{indicator:'ema',args:{period:20},compare_to:'price',compare_price:'close',direction:'cross_above'},indicator_threshold:{indicator:'rsi',args:{period:14},operator:'cross_above',threshold:30},indicator_threshold_exit:{indicator:'rsi',args:{period:14},operator:'below',threshold:45},indicator_divergence:{indicator:'macd',output:'hist',swing_length:3,lookback:60},indicator_divergence_exit:{indicator:'macd',output:'hist',swing_length:3,lookback:60},double_bottom:{swing_length:3,lookback:60,tolerance_pct:1.5},double_top_exit:{swing_length:3,lookback:60,tolerance_pct:1.5},head_and_shoulders_inverse:{swing_length:3,lookback:60,tolerance_pct:1.5},bullish_engulfing:{min_body_ratio:1},bearish_engulfing_exit:{min_body_ratio:1},pin_bar:{tail_ratio:2,max_body_pct:0.34,max_upper_pct:0.2},fair_value_gap:{min_gap_pct:0.2},inside_bar_breakout:{max_inside_bars:3},smc_bos:{direction:'bullish'},smc_ob_retest:{},smc_fvg_fill:{},smc_discount:{zone:'discount'},smc_trend:{},smc_ob_level:{buffer_atr:0.5},smc_liquidity_target:{},smc_choch_exit:{kind:'any'}};
describe('IR primitive causality',()=>{
 for(const [name,p]of Object.entries(defaults))it(`${name} cannot observe i+1 or any later bar`,()=>{
  const bars=fixture().bars,i=300,ctx={bars,i,timeframe_ms:STEP,position:{entry_at:bars[280]!.open_time,entry_price:100,initial_distance:5,bars_held:20},screen:{symbol:'BTCUSDT',bars:300,status:'ok' as const,beta:1,alpha_share:.5,trend:{status:'ok' as const,state:'up' as const,adx:25,ema_slope:.01,donchian_pos:.8,htf_state:'up' as const},momentum_12_1:null,residual:{total_return:.1,max_drawdown:.1,drawdown_area:.03,ulcer_index:.05,sharpe:1,sortino:2,information_ratio:1,volatility:.2}}};
  const primitive=registry.get(name)!;expect(primitive).toBeDefined();const before=primitive.compute(ctx,p),poison=bars.map((b,j)=>j>i?{...b,high:'NaN',low:'NaN',open:'999999999',close:'NaN',volume:'NaN'}:b);
  expect(primitive.compute({...ctx,bars:poison},p)).toEqual(before);expect(primitive.compute({...ctx,bars:bars.slice(0,i+1)},p)).toEqual(before);
 });
});
describe('strategy construction and execution',()=>{
 it('roundtrips every legacy economic parameter and preserves legacy replay arms',async()=>{
  const r=params(),ir=policyToIR(r.policy!);expect(irToPolicy(ir)).toEqual(r.policy);expect(checkIR(ir,'1h').ok).toBe(true);
  const old=await runReplay(fixture(),{...r,arms:['a_rules']},async()=>{throw new Error('no model');}),{policy:_,...rest}=r;
  const mapped=await runReplay(fixture(),{...rest,arms:['a_rules'],strategy_ir:policyToIR(r.policy!,r.execution)},async()=>{throw new Error('no model');});
  // Economic path matches; IR records intentionally carry explicit IR context and therefore new decision hashes.
  expect(mapped.arms[0]!.equity).toEqual(old.arms[0]!.equity);expect(mapped.arms[0]!.trades).toEqual(old.arms[0]!.trades);
 });
 it('accepts default trailing strategy and exposes all primitive schemas',()=>{
  const result=checkIR(defaultIR(),'1h');expect(result.ok,JSON.stringify(result.checks)).toBe(true);expect(result.hash).toBe(hash(defaultIR()));expect(result.checks.map(x=>x.name)).toEqual(['units','timeframe_consistency','lookahead','state_machine','order_gate_ready','risk_bounds','warmup']);expect(listPrimitives().items).toHaveLength(63);expect(validate('research',result).ok).toBe(true);
 });
 it('rejects excessive risk, unsupported primitives, incompatible periods and exit dead ends',()=>{
  const cases: [StrategyIR,string][]=[];let ir=defaultIR();ir.risk.sizing.params.fraction='0.2';cases.push([ir,'risk_bounds']);ir=defaultIR();ir.signal[0]!.primitive='eval_code';cases.push([ir,'lookahead']);ir=defaultIR();ir.regime!.params.htf='15m';cases.push([ir,'timeframe_consistency']);ir=defaultIR();ir.exit=[node('time_stop',{bars:24},true)];cases.push([ir,'state_machine']);ir=defaultIR();ir.signal[0]!.params.lookback='20h';cases.push([ir,'units']);
  for(const [candidate,name]of cases){const result=checkIR(candidate,'1h');expect(result.ok).toBe(false);expect(result.checks.find(x=>x.name===name)?.ok).toBe(false);}
 });
 it('compiles IR without a model, repairs JSON at most once and keeps unmapped semantics',async()=>{
  const complete=vi.fn(async()=>({text:JSON.stringify({ir:defaultIR(),unmapped:['看新闻尚无历史原语']}),latency_ms:1,model:'mock',input_tokens:1,output_tokens:1}));
  await compileStrategy({ir:defaultIR(),timeframe:'1h'},{name:'mock',complete});expect(complete).not.toHaveBeenCalled();
  complete.mockResolvedValueOnce({text:'invalid json',latency_ms:1,model:'mock',input_tokens:1,output_tokens:1});const out=await compileStrategy({text:'突破且看新闻',timeframe:'1h'},{name:'mock',complete});expect(complete).toHaveBeenCalledTimes(2);expect(out.ok).toBe(true);expect(out.unmapped).toEqual(['看新闻尚无历史原语']);
 });
 it('2026-09-21 真模型实测:文本路径里模型误标 compatibility 的自由策略被剥掉标签按新策略检查,并记进 unmapped',async()=>{
  const tagged={...defaultIR(),compatibility:'donchian_close_long_v1'};
  const complete=vi.fn(async()=>({text:JSON.stringify({ir:tagged,unmapped:[]}),latency_ms:1,model:'mock',input_tokens:1,output_tokens:1}));
  const out=await compileStrategy({text:'吊灯线追踪突破',timeframe:'1h'},{name:'mock',complete});
  expect(out.ok,JSON.stringify(out.checks)).toBe(true);expect(out.ir&&'compatibility' in out.ir).toBe(false);expect(out.unmapped.some(x=>x.includes('compatibility'))).toBe(true);
 });
 it('rejects ambiguous policy/IR requests and compile-failing risk at request validation',()=>{
  const r=params();expect(validate('research',{...r,strategy_ir:defaultIR()}).ok).toBe(false);const {policy:_,...rest}=r,ir=defaultIR();ir.risk.sizing.params.fraction='0.2';expect(()=>request({...rest,strategy_ir:ir},fixture())).toThrow('strategy_ir_checks_failed');
 });
 it('executes trailing exits without a fixed target or hardcoded holding horizon',async()=>{
  const d=fixture(),r=params(),{policy:_,...rest}=r,ir=defaultIR();delete ir.regime;ir.signal=[node('volume_surge',{lookback:5,multiple:0})];ir.exit=[node('chandelier_trail',{atr_period:5,multiple:1})];
  const out=await runReplay(d,{...rest,strategy_ir:ir,arms:['a_rules']},async()=>{throw new Error('no model');});expect(out.status,out.error??'').toBe('completed');expect(out.arms[0]!.trades.length).toBeGreaterThan(0);expect(out.arms[0]!.trades.every(t=>t.reason!=='horizon'&&t.reason!=='target')).toBe(true);
 });
 it('records regime_filter and prevents B calls when the regime fails',async()=>{
  const r=params(),{policy:_,...rest}=r,decide=vi.fn(async()=>({action:'no_trade' as const,reason:'x',gate_errors:[],evidence_refs:[]}));
  const out=await runReplay(fixture(),{...rest,strategy_ir:defaultIR(),arms:['b_agent'],repeats:1},decide);expect(out.status).toBe('completed');expect(out.arms[0]!.decisions.some(d=>d.reason==='regime_filter')).toBe(true);expect(decide).not.toHaveBeenCalled();
 });
});

describe('IR review regressions',()=>{
 it('combines optional fixed targets by the earliest OR trigger',()=>{
  const ir=defaultIR();delete ir.regime;ir.signal=[node('volume_surge',{lookback:5,multiple:0})];ir.exit=[node('fixed_r_target',{r:2},true),node('fixed_r_target',{r:1},true),node('chandelier_trail',{atr_period:5,multiple:2})];
  const bars=fixture().bars,entry=irCandidate(ir,{bars,i:100,timeframe_ms:STEP}).entry!;
  expect(Number(entry.target)).toBeCloseTo(2*Number(bars[100]!.close)-Number(entry.stop),6);
 });
 it('keeps reviewing a held B position after the entry regime turns down',async()=>{
  const d=fixture();d.bars=d.bars.map((b,i)=>{const p=100+(i<=270?i:270-(i-270)*2);return {...b,open:String(p),high:String(p+1),low:String(p-1),close:String(p)};});
  const {policy:_,...r}=params(),ir=defaultIR();ir.signal=[node('volume_surge',{lookback:5,multiple:0})];ir.exit=[node('breakeven_after_r',{r:100})];let downReviews=0;
  const out=await runReplay(d,{...r,strategy_ir:ir,arms:['b_agent'],repeats:1,from_ms:d.bars[250]!.close_time,to_ms:d.bars[350]!.close_time},async v=>{if(v.position&&v.trend?.state==='down')downReviews++;return v.position?{action:'hold',reason:'hold',gate_errors:[],evidence_refs:[]}:{action:'enter',entry:{candidate_id:'held',stop:'1',target:null,reason:'test'},reason:'test',gate_errors:[],evidence_refs:[]};});
  expect(out.status).toBe('completed');expect(downReviews).toBeGreaterThan(0);
 });
});

it('IR fixed R uses the actual next-open fill risk while legacy targets remain frozen',()=>{
 const config={...params().execution,fee_rate:'0',slippage_bps:'0'},b={...fixture().bars[0]!,open:'105',high:'115',low:'101',close:'110'};
 const ir=new SpotLedger(config);ir.pending={action:'enter',entry:{candidate_id:'ir',stop:'90',target:'120',target_r:2,reason:'IR'}};ir.step(b);expect(ir.position!.target).toBe(13500000000n);
 const legacy=new SpotLedger(config);legacy.pending={action:'enter',entry:{candidate_id:'old',stop:'90',target:'120',reason:'old'}};legacy.step(b);expect(legacy.position!.target).toBe(12000000000n);
});
