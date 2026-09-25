import type { BacktestMetrics, BacktestReport, StrategyIR } from '@trading-swarm/contracts';
import { hash } from '../../../../src/demo/research/primitives.js';
import { defaultIR } from '../../../../src/demo/research/strategy.js';
export { defaultIR };
/** 换一个参数得到不同 IR 哈希的变体 */
export function variantIR(lookback:number,label?:string):StrategyIR{const ir=defaultIR();ir.signal[0]={...ir.signal[0]!,params:{...ir.signal[0]!.params,lookback}};if(label)ir.label=label;return ir;}
export function metrics(o:Partial<BacktestMetrics>={}):BacktestMetrics{return {total_return:0.1,cagr:null,max_drawdown:-0.05,sharpe:1,sortino:null,calmar:null,volatility:null,win_rate:0.5,profit_factor:null,avg_win:null,avg_loss:null,risk_reward:null,expectancy:null,max_win_streak:2,max_loss_streak:1,time_in_drawdown:0.2,max_drawdown_duration_ms:0,trades:10,exposure:0.3,avg_holding_ms:null,best_trade:null,worst_trade:null,net_pnl:100,fees:1,benchmark_return:null,excess_return:null,alpha:null,beta:null,time_in_market:0.3,...o};}
let n=0;
export function report(o:{ir?:StrategyIR;id?:string;title?:string;status?:'completed'|'failed';points?:number;m?:Partial<BacktestMetrics>;session_id?:string|null;strategy_id?:string|null;created_at?:number;run_ids?:string[];irHashOverride?:string}={}):BacktestReport{
  const ir=o.ir??defaultIR(),points=o.points??300,ok=(o.status??'completed')==='completed';
  return {id:o.id??`bt_${++n}`,created_at:o.created_at??1_700_000_000_000+n,engine_version:'test',title:o.title??'顺势突破 BTC',description:'测试报告',strategy_ir_hash:o.irHashOverride??hash(ir),strategy_ir:ir,timeframe:'4h',window:{from_ms:0,to_ms:1000},segments:[],execution:{initial_cash:10000,fee_rate:0.001,slippage_bps:5,sizing_mode:'risk_fraction',fill_model:'next_open',basket_weighting:'equal',market:'spot',leverage:1},primary_key:'BTCUSDT',
    assets:[{key:'BTCUSDT',label:'BTC',kind:'single',symbols:['BTCUSDT'],status:ok?'completed':'failed',error:ok?null:'boom',metrics:ok?metrics(o.m):null,segments:[],equity:ok?Array.from({length:points},(_,i)=>({at:i,equity:10000+i,pnl_pct:i/100,drawdown:0,benchmark_pct:null,exposure:0})):[],trades:[],monthly_returns:[],yearly_returns:[],trade_stats:null,data:null},
      {key:'ETHUSDT',label:'ETH',kind:'single',symbols:['ETHUSDT'],status:'completed',error:null,metrics:metrics({total_return:9}),segments:[],equity:[],trades:[],monthly_returns:[],yearly_returns:[],trade_stats:null,data:null}],
    score:{value:72,label:'good',confidence:'medium',confidence_reason:'test',components:[]},run_ids:o.run_ids??[],inquiry_id:null,session_id:o.session_id??null,strategy_id:o.strategy_id??null,strategy_version:null,warnings:[]};
}
export const meta=(session_id:string|null=null,question:string|null=null)=>({session_id,inquiry_id:session_id?`inq_${session_id}`:null,question,symbol:'BTCUSDT'});
