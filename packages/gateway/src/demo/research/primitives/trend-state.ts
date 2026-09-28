import type { ResearchBar, ResearchTrend } from '@trade-gate/contracts';
export interface TrendParams {adx_period?:number;adx_min?:number;ema_fast?:number;ema_slow?:number;htf?:string}
export function ema(values:number[],period:number):number[] {
  const k=2/(period+1),out:number[]=[];
  for(const v of values)out.push(out.length?v*k+out.at(-1)!*(1-k):v);
  return out;
}
/** Wilder-smoothed directional movement; first ADX is mean of the first period DXs. */
function adx(bars:ResearchBar[],period:number):number {
  if(bars.length<2*period)return 0;
  const tr:number[]=[],plus:number[]=[],minus:number[]=[];
  for(let i=1;i<bars.length;i++){
    const b=bars[i]!,p=bars[i-1]!,up=Number(b.high)-Number(p.high),down=Number(p.low)-Number(b.low);
    tr.push(Math.max(Number(b.high)-Number(b.low),Math.abs(Number(b.high)-Number(p.close)),Math.abs(Number(b.low)-Number(p.close))));
    plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);
  }
  let t=0,p=0,m=0;const dx:number[]=[];
  for(let i=0;i<tr.length;i++){
    if(i<period){t+=tr[i]!;p+=plus[i]!;m+=minus[i]!;}else{t=t-t/period+tr[i]!;p=p-p/period+plus[i]!;m=m-m/period+minus[i]!;}
    if(i>=period-1)dx.push(t>0&&p+m>0?100*Math.abs(p-m)/(p+m):0);
  }
  let value=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(const d of dx.slice(period))value=(value*(period-1)+d)/period;
  return value;
}
function htfMs(tf:string):number {const m=/^(\d+)(m|h|d)$/.exec(tf);if(!m)throw new Error('trend_htf_invalid');return Number(m[1])*({m:60000,h:3600000,d:86400000}[m[2]!]!);}
export function trendWarmup(params:TrendParams={},base=3600000):number {
  const target=htfMs(params.htf??'4h');
  if(target<base||target%base!==0)throw new Error('trend_htf_below_or_indivisible_base');
  return Math.max(2*(params.adx_period??14),(params.ema_slow??50)+1,((params.ema_slow??50)+1)*target/base);
}
/** The same causal function is consumed by screen, and is available to engine/IR contexts. */
export function trendState(ctx:{bars:ResearchBar[];i:number;timeframe_ms:number},params:TrendParams={}):ResearchTrend {
  const {i,timeframe_ms:base}=ctx;
  const bars=ctx.bars.slice(0,i+1),period=params.adx_period??14,fast=params.ema_fast??20,slow=params.ema_slow??50,target=htfMs(params.htf??'4h');
  if([period,fast,slow].some(n=>!Number.isInteger(n)||n<2)||fast>=slow||!Number.isFinite(params.adx_min??20))throw new Error('trend_params_invalid');
  trendWarmup(params,base);
  const blank:ResearchTrend={state:'range',adx:0,ema_slope:0,donchian_pos:0.5,htf_state:'range',status:'insufficient'};
  if(bars.length<Math.max(slow+1,2*period))return blank;
  const close=bars.map(b=>Number(b.close)),f=ema(close,fast),s=ema(close,slow),slope=s.at(-1)!/s.at(-2)!-1;
  const buckets=new Map<number,ResearchBar[]>();
  for(const b of bars){const key=Math.floor(b.open_time/target)*target;const bucket=buckets.get(key)??[];bucket.push(b);buckets.set(key,bucket);}
  const htf=[...buckets].flatMap(([start,v])=>v.length===target/base&&v.every((b,j)=>b.open_time===start+j*base)&&v.at(-1)!.close_time===start+target-1?[Number(v.at(-1)!.close)]:[]);
  const hs=ema(htf,slow),htfReady=htf.length>=slow+1;
  const direction:ResearchTrend['state']=!htfReady?'range':hs.at(-1)!>hs.at(-2)!?'up':hs.at(-1)!<hs.at(-2)!?'down':'range';
  const value=adx(bars,period),up=f.at(-1)!>s.at(-1)!&&f.at(-1)!>f.at(-2)!&&slope>0,down=f.at(-1)!<s.at(-1)!&&f.at(-1)!<f.at(-2)!&&slope<0;
  const state:ResearchTrend['state']=value<(params.adx_min??20)?'range':up&&direction==='up'?'up':down&&direction==='down'?'down':'range';
  const window=bars.slice(-20),hi=Math.max(...window.map(b=>Number(b.high))),lo=Math.min(...window.map(b=>Number(b.low)));
  return {state,adx:value,ema_slope:slope,donchian_pos:hi>lo?(close.at(-1)!-lo)/(hi-lo):0.5,htf_state:direction,status:htfReady?'ok':'insufficient'};
}
