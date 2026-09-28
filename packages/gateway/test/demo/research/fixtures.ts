import type { ResearchDataset, ResearchRequest, ResearchStudy } from '@trade-gate/contracts';
export const T0=Date.UTC(2025,0,1),STEP=3600000;
export function fixture():ResearchDataset {
  let price=100;
  const bars=Array.from({length:420},(_,i)=>{
    const open=price;price=Math.max(30,price+(i%17===0?-8:i%8===0?4:.4));
    return {open_time:T0+i*STEP,close_time:T0+(i+1)*STEP-1,available_at:T0+(i+1)*STEP-1,open:open.toFixed(8),high:(Math.max(open,price)+.2).toFixed(8),low:(Math.min(open,price)-.2).toFixed(8),close:price.toFixed(8),volume:i%8===0?'200':'100'};
  });
  return {venue:'synthetic',market:'spot',symbol:'TEST-USDT',timeframe_ms:STEP,source:'deterministic engineering fixture; no economic evidence',retrieved_at:bars.at(-1)!.close_time,bars};
}
export function study(id:string):ResearchStudy {const b=fixture().bars;return {id:'study-test',dataset_id:id,from_ms:b[30]!.close_time,development_to_ms:b[180]!.close_time,validation_from_ms:b[200]!.close_time,validation_to_ms:b[280]!.close_time,holdout_from_ms:b[300]!.close_time,to_ms:b[400]!.close_time,purge_bars:12,max_trials:20};}
export function params(id='fixture'):ResearchRequest {const s=study(id);return {idempotency_key:'test-run',dataset_id:id,policy:{label:'收盘突破',description:'收盘突破前 5 根最高价且放量，ATR 止损，固定止盈。',interpretation:'donchian_close_long_v1',lookback:5,atr_period:5,stop_atr:2,take_profit_r:2,volume_multiple:1,holding_bars:8},execution:{initial_cash:'10000',risk_fraction:'0.01',max_allocation:'0.25',fee_rate:'0.001',slippage_bps:'5',qty_step:'0.00000001',min_notional:'5',max_opens_per_day:10},from_ms:s.from_ms,to_ms:s.development_to_ms,arms:['a_rules','b_agent','c_filter'],repeats:2,max_model_calls:1000,timeout_ms:60000,purpose:'development',study_id:s.id,acknowledge_adaptive_search:true};}
