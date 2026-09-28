import {htfStructure} from './primitives/structure.js';
import type { ResearchDataset, ResearchScreen, ResearchScreenRow, ResearchUniverse } from '@trade-gate/contracts';
import { factorDecompose } from './factor.js';
import { periodsPerYear } from './calendar.js';
import { trendState } from './primitives/trend-state.js';
export function screenUniverse(u:ResearchUniverse,datasets:ResearchDataset[],opts:{window_bars?:number;lookback_bars?:number;as_of?:number;top_n?:number;legacy?:boolean}={}):ResearchScreen {
  if(opts.top_n!==undefined&&(!Number.isInteger(opts.top_n)||opts.top_n<1||opts.top_n>500))throw Error('invalid_top_n');
  const window=opts.window_bars??720,lookback=opts.lookback_bars??2160,at=opts.as_of??u.last_at;
  if(!Number.isSafeInteger(at)||at<0||!Number.isInteger(window)||window<2||window>25000||!Number.isInteger(lookback)||lookback<2||lookback>50000)throw new Error('screen_options_invalid');
  const maps=new Map(datasets.map(d=>[d.symbol,new Map(d.bars.filter(b=>b.close_time<=at&&b.available_at<=at).map(b=>[b.close_time,b]))]));
  const times=u.aligned_close_times.filter(t=>t<=at).slice(-lookback-1);
  // A multi-bar return across a missing candle must not be called a single-bar return.
  const pairs=times.slice(1).flatMap((t,i)=>t - times[i]! === u.timeframe_ms?[[times[i]!,t] as const]:[]);
  const returns=(symbol:string)=>pairs.map(([a,b])=>Math.log(Number(maps.get(symbol)?.get(b)?.close)/Number(maps.get(symbol)?.get(a)?.close)));
  const market=pairs.map(()=>0);
  for(const symbol of u.market_factor.symbols){const r=returns(symbol);for(let i=0;i<r.length;i++)market[i]=market[i]!+r[i]!*Number(u.market_factor.weights[symbol]);}
  const rows:ResearchScreenRow[]=u.members.map(member=>{
    const d=datasets.find(d=>d.symbol===member.symbol);if(!d)throw new Error('screen_dataset_missing');
    const bars=d.bars.filter(b=>b.close_time<=at&&b.available_at<=at).slice(-lookback);
    // Stop trend history at the most recent hole; smoothing does not bridge missing prices.
    let start=0;for(let i=1;i<bars.length;i++)if(bars[i]!.open_time!==bars[i-1]!.open_time+u.timeframe_ms)start=i;
    const trendBars=bars.slice(start);
    const trend=trendState({bars:trendBars,i:trendBars.length-1,timeframe_ms:u.timeframe_ms},{htf:u.timeframe_ms>14400000?`${u.timeframe_ms/60000}m`:'4h'});
    const values=returns(member.symbol),f=factorDecompose(values,market,{window_bars:window,periods_per_year:periodsPerYear(u.timeframe_ms,d.calendar),risk_free_per_bar:Number(d.risk_free_per_bar??0)});
    // Twelve months less the most recent month, in elapsed calendar time. No short-history proxy.
    const month=30*86400000,prior=maps.get(member.symbol)!,a=prior.get(at-12*month),b=prior.get(at-month);
    const momentum=a&&b?Number(b.close)/Number(a.close)-1:null;
    return {...(!opts.legacy?{htf_structure:htfStructure({bars:trendBars,i:trendBars.length-1,timeframe_ms:u.timeframe_ms},{htf:u.timeframe_ms>86400000?`${u.timeframe_ms/60000}m`:'1d'})}:{}),symbol:member.symbol,bars:values.length,status:f.status,trend,momentum_12_1:momentum,...(f.status==='ok'?{beta:f.beta!,alpha_annualized:f.alpha_annualized!,r2:f.r2!,raw:f.raw!,residual:f.residual!,alpha_share:f.alpha_share!,beta_share:f.beta_share!}:{})};
  });
  const valid=rows.filter(r=>r.status==='ok');
  const rank=(score:(r:ResearchScreenRow)=>number)=>new Map([...valid].sort((a,b)=>score(b)-score(a)||a.symbol.localeCompare(b.symbol)).map((r,i)=>[r.symbol,i+1]));
  const sharpe=rank(r=>r.residual?.sharpe??-Infinity),alpha=rank(r=>r.alpha_share??-Infinity),trend=rank(r=>r.trend.status!=='ok'?-1:r.trend.state==='up'?2:r.trend.state==='range'?1:0);
  const composite=rank(r=>-(sharpe.get(r.symbol)!+alpha.get(r.symbol)!+trend.get(r.symbol)!));
  for(const r of valid)r.rank={residual_sharpe:sharpe.get(r.symbol)!,alpha_share:alpha.get(r.symbol)!,composite:composite.get(r.symbol)!};
  return {universe_id:u.id,as_of:at,window_bars:window,lookback_bars:lookback,market_factor:u.market_factor,rows:opts.top_n?[...rows].filter(r=>r.rank).sort((a,b)=>a.rank!.composite-b.rank!.composite).slice(0,opts.top_n):rows,note:'探索性排序，不是选股认证：residual Sharpe、alpha_share、trend 状态三项降序名次之和，平手按 symbol 排序；insufficient 不排名。只用 as_of 及以前已收盘/可得数据；缺根不填价、不把跨缺根收益当单根。bars 为有效收益样本数。负总收益 alpha/beta 按绝对值占比，零总收益或零分母比率为 null。momentum_12_1 为过去 360 至 30 天收益，缺历史为 null。'};
}
