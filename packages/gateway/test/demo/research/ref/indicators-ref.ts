/** 冻结的原始实现(git HEAD 2026-09-26,primitives/indicators.ts 性能改造前),只给 indicator-fastpath.test.ts 做逐位对拍参照,不要改。 */
/** 表驱动指标库(2026-09-22):一行一个指标,供 generic.ts 的通用原语按名字取用,本文件自身不注册原语。
 * 口径:与 TA-Lib / pandas-ta 默认一致——EMA 用前 n 根 SMA 播种、标准差用总体口径(ddof=0)、预热之前一律 NaN。
 * 因果性:compute 只读传入的 bars(调用方已切到 [0..i],最后一根已收盘),不做任何前移/后移以外的位移;
 * 一目均衡表的先行 A/B 按"当前这根能看到的云"取 displacement 根之前算出的值,迟行线额外给出 lagging_ref 做对照,均无前视。
 */
import type { ResearchBar } from '@trade-gate/contracts';
export type Bars=ResearchBar[];
export type Args=Record<string,number>;
export interface IndicatorArg {key:string;default:number;min:number;max:number;integer?:boolean}
export interface IndicatorSpec {
 name:string;cn:string;aliases:string[];category:'price'|'ma'|'trend'|'momentum'|'volatility'|'volume';
 args:IndicatorArg[];
 /** 第一条是主输出(不指定 output 时用它) */
 outputs:string[];
 /** 至少需要多少根 bar 才能得到非 NaN 的最新值(= 首个有效下标 + 1) */
 warmup:(a:Args)=>number;
 compute:(bars:Bars,a:Args)=>number[]|Record<string,number[]>;
 note?:string;
}

/* ---------- 取价与滚动窗口工具 ---------- */
const N=(x:unknown)=>Number(x);
export const closeOf=(b:Bars)=>b.map(x=>N(x.close));
export const highOf=(b:Bars)=>b.map(x=>N(x.high));
export const lowOf=(b:Bars)=>b.map(x=>N(x.low));
export const openOf=(b:Bars)=>b.map(x=>N(x.open));
export const volumeOf=(b:Bars)=>b.map(x=>N(x.volume));
export const PRICE_SOURCES=['close','open','high','low','hl2','hlc3','ohlc4'] as const;
export function priceSeries(bars:Bars,source:string):number[] {
 switch(source){
  case 'open':return openOf(bars);case 'high':return highOf(bars);case 'low':return lowOf(bars);
  case 'hl2':return bars.map(b=>(N(b.high)+N(b.low))/2);
  case 'hlc3':return bars.map(b=>(N(b.high)+N(b.low)+N(b.close))/3);
  case 'ohlc4':return bars.map(b=>(N(b.open)+N(b.high)+N(b.low)+N(b.close))/4);
  default:return closeOf(bars);
 }
}
const nan=(len:number)=>new Array<number>(len).fill(NaN);
/** 滚动求和:窗口 n,从下标 start 开始参与,i>=start+n-1 才有效 */
export function rollingSum(v:number[],n:number,start=0):number[] {
 const out=nan(v.length);let sum=0;
 for(let i=start;i<v.length;i++){sum+=v[i]!;if(i>=start+n)sum-=v[i-n]!;if(i>=start+n-1)out[i]=sum;}
 return out;
}
/** 单调队列滚动极值,O(n);窗口含当前根 */
export function rollingMax(v:number[],n:number):number[] {
 const out=nan(v.length),dq:number[]=[];
 for(let i=0;i<v.length;i++){while(dq.length&&v[dq[dq.length-1]!]!<=v[i]!)dq.pop();dq.push(i);if(dq[0]!<=i-n)dq.shift();if(i>=n-1)out[i]=v[dq[0]!]!;}
 return out;
}
export function rollingMin(v:number[],n:number):number[] {
 const out=nan(v.length),dq:number[]=[];
 for(let i=0;i<v.length;i++){while(dq.length&&v[dq[dq.length-1]!]!>=v[i]!)dq.pop();dq.push(i);if(dq[0]!<=i-n)dq.shift();if(i>=n-1)out[i]=v[dq[0]!]!;}
 return out;
}
export function smaSeries(v:number[],n:number):number[] {const s=rollingSum(v,n);return s.map(x=>x/n);}
/** SMA 播种的 EMA(TA-Lib / pandas-ta 默认 sma=True),前 n-1 根为 NaN */
export function emaSeries(v:number[],n:number):number[] {
 const out=nan(v.length),k=2/(n+1);if(v.length<n)return out;
 let sum=0;for(let i=0;i<n;i++)sum+=v[i]!;out[n-1]=sum/n;
 for(let i=n;i<v.length;i++)out[i]=v[i]!*k+out[i-1]!*(1-k);
 return out;
}
/** Wilder 平滑(SMMA / RMA),alpha = 1/n,同样用 SMA 播种 */
export function rmaSeries(v:number[],n:number):number[] {
 const out=nan(v.length);if(v.length<n)return out;
 let sum=0;for(let i=0;i<n;i++)sum+=v[i]!;out[n-1]=sum/n;
 for(let i=n;i<v.length;i++)out[i]=(out[i-1]!*(n-1)+v[i]!)/n;
 return out;
}
export function wmaSeries(v:number[],n:number):number[] {
 const out=nan(v.length),denom=n*(n+1)/2;
 for(let i=n-1;i<v.length;i++){let acc=0;for(let j=0;j<n;j++)acc+=v[i-j]!*(n-j);out[i]=acc/denom;}
 return out;
}
/** 总体标准差(ddof=0),与 TradingView ta.stdev / TA-Lib STDDEV 一致 */
export function stdevSeries(v:number[],n:number):number[] {
 const out=nan(v.length);let sum=0,sq=0;
 for(let i=0;i<v.length;i++){sum+=v[i]!;sq+=v[i]!*v[i]!;if(i>=n){sum-=v[i-n]!;sq-=v[i-n]!*v[i-n]!;}
  if(i>=n-1){const mean=sum/n;out[i]=Math.sqrt(Math.max(0,sq/n-mean*mean));}}
 return out;
}
/** 真实波幅:第 0 根无前收,记 NaN,后续 Wilder 口径 */
export function trSeries(bars:Bars):number[] {
 const out=nan(bars.length);
 for(let i=1;i<bars.length;i++){const b=bars[i]!,pc=N(bars[i-1]!.close);out[i]=Math.max(N(b.high)-N(b.low),Math.abs(N(b.high)-pc),Math.abs(N(b.low)-pc));}
 return out;
}
/** Wilder ATR:atr[n] = tr[1..n] 的均值,之后递推;首个有效下标 = n(与仓库既有 atr() 同口径) */
export function atrSeries(bars:Bars,n:number):number[] {
 const tr=trSeries(bars),out=nan(bars.length);if(bars.length<=n)return out;
 let sum=0;for(let i=1;i<=n;i++)sum+=tr[i]!;out[n]=sum/n;
 for(let i=n+1;i<bars.length;i++)out[i]=(out[i-1]!*(n-1)+tr[i]!)/n;
 return out;
}
/** RSI(Wilder):首个有效下标 = n */
export function rsiSeries(v:number[],n:number):number[] {
 const out=nan(v.length);if(v.length<=n)return out;
 let gain=0,loss=0;
 for(let i=1;i<=n;i++){const d=v[i]!-v[i-1]!;gain+=Math.max(0,d)/n;loss+=Math.max(0,-d)/n;}
 out[n]=loss>0?100-100/(1+gain/loss):gain>0?100:50;
 for(let i=n+1;i<v.length;i++){const d=v[i]!-v[i-1]!;gain=(gain*(n-1)+Math.max(0,d))/n;loss=(loss*(n-1)+Math.max(0,-d))/n;out[i]=loss>0?100-100/(1+gain/loss):gain>0?100:50;}
 return out;
}
/** A/D 累积线(Chaikin Accumulation/Distribution),高低相等的一根按 0 计 */
export function adSeries(bars:Bars):number[] {
 const out=new Array<number>(bars.length).fill(0);let acc=0;
 for(let i=0;i<bars.length;i++){const b=bars[i]!,h=N(b.high),l=N(b.low),c=N(b.close);
  acc+=h>l?((c-l)-(h-c))/(h-l)*N(b.volume):0;out[i]=acc;}
 return out;
}
const dmSeries=(bars:Bars)=>{
 const plus=nan(bars.length),minus=nan(bars.length);
 for(let i=1;i<bars.length;i++){const up=N(bars[i]!.high)-N(bars[i-1]!.high),down=N(bars[i-1]!.low)-N(bars[i]!.low);
  plus[i]=up>down&&up>0?up:0;minus[i]=down>up&&down>0?down:0;}
 return {plus,minus};
};

/* ---------- 指标表 ---------- */
const P=(d:number,min=1,max=5000):IndicatorArg=>({key:'period',default:d,min,max,integer:true});
const arg=(key:string,d:number,min:number,max:number,integer=true):IndicatorArg=>({key,default:d,min,max,integer});
/** 在已知首个有效下标的序列上继续做 EMA(不把 NaN 当 0),用于 DEMA/TEMA/TRIX 的嵌套平滑 */
function emaFrom(v:number[],n:number,first:number):number[] {
 const seg=emaSeries(v.slice(first),n),out=nan(v.length);
 for(let i=0;i<seg.length;i++)if(Number.isFinite(seg[i]!))out[first+i]=seg[i]!;
 return out;
}
const maSpec=(name:string,cn:string,aliases:string[],period:number,fn:(bars:Bars,n:number)=>number[],firstValid:(n:number)=>number,note?:string):IndicatorSpec=>
 ({name,cn,aliases,category:'ma',args:[P(period,2)],outputs:['value'],warmup:a=>firstValid(a.period!)+1,compute:(bars,a)=>fn(bars,a.period!),...(note?{note}:{})});

const SPECS:IndicatorSpec[]=[
 /* --- 均线族 --- */
 /* --- 原始价格(让"价格上穿均线"这类用法有一条主线可用) --- */
 {name:'price',cn:'原始价格',aliases:['price','价格','收盘价','close','k线'],category:'price',args:[],outputs:['close','open','high','low','hl2','hlc3','ohlc4'],warmup:()=>1,
  compute:bars=>Object.fromEntries(PRICE_SOURCES.map(k=>[k,priceSeries(bars,k)]))},
 maSpec('sma','简单移动平均',['sma','ma','移动平均','简单均线'],20,(b,n)=>smaSeries(closeOf(b),n),n=>n-1),
 maSpec('ema','指数移动平均',['ema','指数均线'],20,(b,n)=>emaSeries(closeOf(b),n),n=>n-1,'与旧原语 ema_cross 的 EMA 不同:这里用前 n 根 SMA 播种(TA-Lib 口径),旧原语从第一根递推。'),
 maSpec('wma','加权移动平均',['wma','加权均线'],20,(b,n)=>wmaSeries(closeOf(b),n),n=>n-1),
 maSpec('dema','双指数移动平均',['dema','双重指数均线'],20,(b,n)=>{const e1=emaSeries(closeOf(b),n),e2=emaFrom(e1,n,n-1);
  return e1.map((x,i)=>i>=2*n-2?2*x-e2[i]!:NaN);},n=>2*n-2),
 maSpec('tema','三重指数移动平均',['tema','三重指数均线'],20,(b,n)=>{const e1=emaSeries(closeOf(b),n),e2=emaFrom(e1,n,n-1),e3=emaFrom(e2,n,2*n-2);
  return e1.map((x,i)=>i>=3*n-3?3*x-3*e2[i]!+e3[i]!:NaN);},n=>3*n-3),
 maSpec('hma','Hull 移动平均',['hma','hull','赫尔均线'],20,(b,n)=>{const c=closeOf(b),half=Math.max(1,Math.round(n/2)),root=Math.max(1,Math.round(Math.sqrt(n)));
  const w1=wmaSeries(c,half),w2=wmaSeries(c,n),diff=w2.map((x,i)=>Number.isFinite(x)?2*w1[i]!-x:0),h=wmaSeries(diff,root);
  return h.map((x,i)=>i>=n-1+root-1?x:NaN);},n=>n-1+Math.max(1,Math.round(Math.sqrt(n)))-1),
 maSpec('vwma','成交量加权移动平均',['vwma','量加权均线'],20,(b,n)=>{const pv=rollingSum(b.map(x=>N(x.close)*N(x.volume)),n),v=rollingSum(volumeOf(b),n);
  return pv.map((x,i)=>v[i]!>0?x/v[i]!:NaN);},n=>n-1),
 maSpec('smma','Wilder 平滑均线(RMA)',['smma','rma','wilder','平滑均线'],20,(b,n)=>rmaSeries(closeOf(b),n),n=>n-1),
 {name:'kama',cn:'考夫曼自适应均线',aliases:['kama','自适应均线','考夫曼'],category:'ma',args:[P(10,2),arg('fast',2,1,100),arg('slow',30,2,500)],outputs:['value'],
  warmup:a=>a.period!+1,
  compute:(bars,a)=>{const n=a.period!,fast=2/(a.fast!+1),slow=2/(a.slow!+1),c=closeOf(bars),out=nan(c.length);
   if(c.length<=n)return out;let seed=0;for(let i=0;i<n;i++)seed+=c[i]!;out[n-1]=seed/n;
   for(let i=n;i<c.length;i++){let vol=0;for(let j=i-n+1;j<=i;j++)vol+=Math.abs(c[j]!-c[j-1]!);
    const er=vol>0?Math.abs(c[i]!-c[i-n]!)/vol:0,sc=Math.pow(er*(fast-slow)+slow,2);out[i]=out[i-1]!+sc*(c[i]!-out[i-1]!);}
   out[n-1]=NaN;return out;}},
 /* --- 趋势 --- */
 {name:'macd',cn:'MACD',aliases:['macd','指数平滑异同'],category:'trend',args:[arg('fast',12,1,5000),arg('slow',26,2,5000),arg('signal',9,1,5000)],outputs:['macd','signal','hist'],
  warmup:a=>a.slow!+a.signal!-1,
  compute:(bars,a)=>{const c=closeOf(bars),f=emaSeries(c,a.fast!),s=emaSeries(c,a.slow!),line=f.map((x,i)=>Number.isFinite(s[i]!)?x-s[i]!:NaN);
   const base=a.slow!-1,sig=emaSeries(line.slice(base),a.signal!),signal=nan(c.length),hist=nan(c.length);
   for(let i=0;i<sig.length;i++)if(Number.isFinite(sig[i]!)){signal[base+i]=sig[i]!;hist[base+i]=line[base+i]!-sig[i]!;}
   return {macd:line,signal,hist};}},
 {name:'adx',cn:'平均趋向指数',aliases:['adx','dmi','趋向指标','动向指标'],category:'trend',args:[P(14,2,1000)],outputs:['adx','plus_di','minus_di'],
  warmup:a=>2*a.period!,
  compute:(bars,a)=>{const n=a.period!,{plus,minus}=dmSeries(bars),tr=trSeries(bars),len=bars.length;
   const adx=nan(len),pdi=nan(len),mdi=nan(len);if(len<=n)return {adx,plus_di:pdi,minus_di:mdi};
   let t=0,p=0,m=0;for(let i=1;i<=n;i++){t+=tr[i]!;p+=plus[i]!;m+=minus[i]!;}
   const dx:number[]=[];const push=(i:number)=>{const a1=t>0?100*p/t:0,a2=t>0?100*m/t:0;pdi[i]=a1;mdi[i]=a2;dx.push(a1+a2>0?100*Math.abs(a1-a2)/(a1+a2):0);};
   push(n);
   for(let i=n+1;i<len;i++){t=t-t/n+tr[i]!;p=p-p/n+plus[i]!;m=m-m/n+minus[i]!;push(i);}
   if(dx.length>=n){let v=0;for(let i=0;i<n;i++)v+=dx[i]!/n;adx[2*n-1]=v;
    for(let i=n;i<dx.length;i++){v=(v*(n-1)+dx[i]!)/n;adx[n+i]=v;}}
   return {adx,plus_di:pdi,minus_di:mdi};}},
 {name:'supertrend',cn:'超级趋势',aliases:['supertrend','超级趋势','st'],category:'trend',args:[P(10,1,1000),arg('multiple',3,0.1,100,false)],outputs:['supertrend','direction'],
  warmup:a=>a.period!+1,
  compute:(bars,a)=>{const n=a.period!,m=a.multiple!,atr=atrSeries(bars,n),len=bars.length,line=nan(len),dir=nan(len);
   let up=NaN,low=NaN,d=1;
   for(let i=n;i<len;i++){const b=bars[i]!,mid=(N(b.high)+N(b.low))/2,c=N(b.close),u=mid+m*atr[i]!,l=mid-m*atr[i]!;
    if(i===n){up=u;low=l;d=c>=mid?1:-1;}
    else{const pc=N(bars[i-1]!.close);up=(u<up||pc>up)?u:up;low=(l>low||pc<low)?l:low;d=c>up?1:c<low?-1:d;}
    dir[i]=d;line[i]=d===1?low:up;}
   return {supertrend:line,direction:dir};}},
 {name:'psar',cn:'抛物线转向',aliases:['psar','sar','抛物线','停损转向'],category:'trend',args:[arg('step',0.02,0.001,1,false),arg('max_step',0.2,0.001,1,false)],outputs:['psar','direction'],
  warmup:()=>3,
  compute:(bars,a)=>{const len=bars.length,out=nan(len),dir=nan(len);if(len<3)return {psar:out,direction:dir};
   let bull=N(bars[1]!.close)>=N(bars[0]!.close),sar=bull?N(bars[0]!.low):N(bars[0]!.high),ep=bull?N(bars[1]!.high):N(bars[1]!.low),af=a.step!;
   for(let i=2;i<len;i++){const b=bars[i]!,h=N(b.high),l=N(b.low),p1=bars[i-1]!,p2=bars[i-2]!;
    sar=sar+af*(ep-sar);
    if(bull)sar=Math.min(sar,N(p1.low),N(p2.low));else sar=Math.max(sar,N(p1.high),N(p2.high));
    if(bull&&l<sar){bull=false;sar=ep;ep=l;af=a.step!;}
    else if(!bull&&h>sar){bull=true;sar=ep;ep=h;af=a.step!;}
    else if(bull&&h>ep){ep=h;af=Math.min(a.max_step!,af+a.step!);}
    else if(!bull&&l<ep){ep=l;af=Math.min(a.max_step!,af+a.step!);}
    out[i]=sar;dir[i]=bull?1:-1;}
   return {psar:out,direction:dir};}},
 {name:'ichimoku',cn:'一目均衡表',aliases:['ichimoku','一目','一目均衡','云图'],category:'trend',args:[P(9,1,1000),arg('period_2',26,1,1000),arg('period_3',52,1,2000)],
  outputs:['conversion','base','span_a','span_b','lagging','lagging_ref'],
  warmup:a=>Math.max(a.period_2!,a.period_3!)+a.period_2!,
  note:'先行 A/B 取 displacement(=period_2)根之前算出的云值,即"当前这根脚下的云",不含前视;lagging 为当前收盘,lagging_ref 为 displacement 根前的收盘,两者比较即迟行线穿越。',
  compute:(bars,a)=>{const c1=a.period!,c2=a.period_2!,c3=a.period_3!,d=c2,len=bars.length,h=highOf(bars),l=lowOf(bars),c=closeOf(bars);
   const mid=(n:number)=>{const mx=rollingMax(h,n),mn=rollingMin(l,n);return mx.map((x,i)=>(x+mn[i]!)/2);};
   const conv=mid(c1),base=mid(c2),b52=mid(c3),spanA=nan(len),spanB=nan(len),lagRef=nan(len);
   for(let i=0;i<len;i++){if(i-d>=0){spanA[i]=(conv[i-d]!+base[i-d]!)/2;spanB[i]=b52[i-d]!;lagRef[i]=c[i-d]!;}}
   return {conversion:conv,base,span_a:spanA,span_b:spanB,lagging:c.slice(),lagging_ref:lagRef};}},
 {name:'aroon',cn:'阿隆指标',aliases:['aroon','阿隆'],category:'trend',args:[P(14,1,1000)],outputs:['oscillator','up','down'],
  warmup:a=>a.period!+1,
  compute:(bars,a)=>{const n=a.period!,h=highOf(bars),l=lowOf(bars),len=bars.length,up=nan(len),down=nan(len),osc=nan(len);
   for(let i=n;i<len;i++){let hi=i,lo=i;
    for(let j=i-n;j<=i;j++){if(h[j]!>=h[hi]!)hi=j;if(l[j]!<=l[lo]!)lo=j;}
    up[i]=100*(n-(i-hi))/n;down[i]=100*(n-(i-lo))/n;osc[i]=up[i]!-down[i]!;}
   return {oscillator:osc,up,down};}},
 {name:'vortex',cn:'涡旋指标',aliases:['vortex','vi','涡旋'],category:'trend',args:[P(14,2,1000)],outputs:['plus','minus'],
  warmup:a=>a.period!+1,
  compute:(bars,a)=>{const n=a.period!,len=bars.length,tr=trSeries(bars),vp=nan(len),vm=nan(len);
   for(let i=1;i<len;i++){vp[i]=Math.abs(N(bars[i]!.high)-N(bars[i-1]!.low));vm[i]=Math.abs(N(bars[i]!.low)-N(bars[i-1]!.high));}
   const st=rollingSum(tr.map(x=>Number.isFinite(x)?x:0),n,1),sp=rollingSum(vp.map(x=>Number.isFinite(x)?x:0),n,1),sm=rollingSum(vm.map(x=>Number.isFinite(x)?x:0),n,1);
   return {plus:sp.map((x,i)=>st[i]!>0?x/st[i]!:NaN),minus:sm.map((x,i)=>st[i]!>0?x/st[i]!:NaN)};}},
 {name:'chop',cn:'震荡指数',aliases:['chop','choppiness','震荡指数','盘整指数'],category:'trend',args:[P(14,2,1000)],outputs:['value'],
  warmup:a=>a.period!+1,
  compute:(bars,a)=>{const n=a.period!,tr=trSeries(bars),st=rollingSum(tr.map(x=>Number.isFinite(x)?x:0),n,1),mx=rollingMax(highOf(bars),n),mn=rollingMin(lowOf(bars),n);
   return st.map((x,i)=>{const range=mx[i]!-mn[i]!;return Number.isFinite(x)&&range>0&&x>0?100*Math.log10(x/range)/Math.log10(n):NaN;});}},
 /* --- 摆动/动量 --- */
 {name:'rsi',cn:'相对强弱指数',aliases:['rsi','相对强弱'],category:'momentum',args:[P(14,2,1000)],outputs:['value'],warmup:a=>a.period!+1,
  compute:(bars,a)=>rsiSeries(closeOf(bars),a.period!)},
 {name:'stoch',cn:'随机指标 KD',aliases:['stoch','kdj','kd','随机指标','kdj指标'],category:'momentum',args:[P(14,1,1000),arg('period_2',3,1,1000),arg('period_3',3,1,1000)],outputs:['k','d','j'],
  warmup:a=>a.period!+a.period_2!+a.period_3!-2,
  compute:(bars,a)=>{const mx=rollingMax(highOf(bars),a.period!),mn=rollingMin(lowOf(bars),a.period!),c=closeOf(bars);
   const raw=c.map((x,i)=>mx[i]!>mn[i]!?100*(x-mn[i]!)/(mx[i]!-mn[i]!):Number.isFinite(mx[i]!)?50:NaN);
   const k=smaSeries(raw.map(x=>Number.isFinite(x)?x:0),a.period_2!).map((x,i)=>i>=a.period!+a.period_2!-2?x:NaN);
   const d=smaSeries(k.map(x=>Number.isFinite(x)?x:0),a.period_3!).map((x,i)=>i>=a.period!+a.period_2!+a.period_3!-3?x:NaN);
   return {k,d,j:k.map((x,i)=>3*x-2*d[i]!)};}},
 {name:'stochrsi',cn:'随机 RSI',aliases:['stochrsi','stoch_rsi','随机rsi'],category:'momentum',args:[P(14,2,1000),arg('period_2',14,1,1000),arg('period_3',3,1,1000)],outputs:['k','d'],
  warmup:a=>a.period!+a.period_2!+2*a.period_3!-2,
  compute:(bars,a)=>{const rsi=rsiSeries(closeOf(bars),a.period!),base=a.period!;
   const seg=rsi.slice(base),mx=rollingMax(seg,a.period_2!),mn=rollingMin(seg,a.period_2!);
   const rawSeg=seg.map((x,i)=>mx[i]!>mn[i]!?100*(x-mn[i]!)/(mx[i]!-mn[i]!):Number.isFinite(mx[i]!)?50:NaN);
   const kSeg=smaSeries(rawSeg.map(x=>Number.isFinite(x)?x:0),a.period_3!),dSeg=smaSeries(kSeg.map(x=>Number.isFinite(x)?x:0),a.period_3!);
   const k=nan(rsi.length),d=nan(rsi.length),kFirst=a.period_2!-1+a.period_3!-1,dFirst=kFirst+a.period_3!-1;
   for(let i=0;i<seg.length;i++){if(i>=kFirst)k[base+i]=kSeg[i]!;if(i>=dFirst)d[base+i]=dSeg[i]!;}
   return {k,d};}},
 {name:'cci',cn:'顺势指标',aliases:['cci','顺势指标'],category:'momentum',args:[P(20,2,1000)],outputs:['value'],warmup:a=>a.period!,
  compute:(bars,a)=>{const n=a.period!,tp=bars.map(b=>(N(b.high)+N(b.low)+N(b.close))/3),ma=smaSeries(tp,n),out=nan(tp.length);
   for(let i=n-1;i<tp.length;i++){let dev=0;for(let j=i-n+1;j<=i;j++)dev+=Math.abs(tp[j]!-ma[i]!);dev/=n;out[i]=dev>0?(tp[i]!-ma[i]!)/(0.015*dev):0;}
   return out;}},
 {name:'mfi',cn:'资金流量指标',aliases:['mfi','资金流量'],category:'volume',args:[P(14,2,1000)],outputs:['value'],warmup:a=>a.period!+1,
  compute:(bars,a)=>{const n=a.period!,tp=bars.map(b=>(N(b.high)+N(b.low)+N(b.close))/3),pos=new Array<number>(bars.length).fill(0),neg=new Array<number>(bars.length).fill(0);
   for(let i=1;i<bars.length;i++){const flow=tp[i]!*N(bars[i]!.volume);if(tp[i]!>tp[i-1]!)pos[i]=flow;else if(tp[i]!<tp[i-1]!)neg[i]=flow;}
   const sp=rollingSum(pos,n,1),sn=rollingSum(neg,n,1);
   return sp.map((x,i)=>!Number.isFinite(x)?NaN:sn[i]!>0?100-100/(1+x/sn[i]!):x>0?100:50);}},
 {name:'roc',cn:'变动率',aliases:['roc','变动率','涨跌幅'],category:'momentum',args:[P(12,1,5000)],outputs:['value'],warmup:a=>a.period!+1,
  compute:(bars,a)=>{const c=closeOf(bars);return c.map((x,i)=>i>=a.period!&&c[i-a.period!]!>0?100*(x/c[i-a.period!]!-1):NaN);}},
 {name:'willr',cn:'威廉指标',aliases:['willr','williams_r','威廉','wr'],category:'momentum',args:[P(14,2,1000)],outputs:['value'],warmup:a=>a.period!,
  compute:(bars,a)=>{const mx=rollingMax(highOf(bars),a.period!),mn=rollingMin(lowOf(bars),a.period!),c=closeOf(bars);
   return c.map((x,i)=>mx[i]!>mn[i]!?-100*(mx[i]!-x)/(mx[i]!-mn[i]!):Number.isFinite(mx[i]!)?-50:NaN);}},
 {name:'momentum',cn:'动量',aliases:['momentum','mom','动量'],category:'momentum',args:[P(10,1,5000)],outputs:['value'],warmup:a=>a.period!+1,
  compute:(bars,a)=>{const c=closeOf(bars);return c.map((x,i)=>i>=a.period!?x-c[i-a.period!]!:NaN);}},
 {name:'trix',cn:'三重指数平滑变动率',aliases:['trix'],category:'momentum',args:[P(15,2,1000),arg('signal',9,1,1000)],outputs:['trix','signal'],
  warmup:a=>3*a.period!+a.signal!-2,
  compute:(bars,a)=>{const n=a.period!,e1=emaSeries(closeOf(bars),n),e2=emaFrom(e1,n,n-1),e3=emaFrom(e2,n,2*n-2);
   const first=3*n-2,line=e3.map((x,i)=>i>=first&&e3[i-1]!>0?100*(x/e3[i-1]!-1):NaN);
   const signal=emaFrom(line,a.signal!,first);
   return {trix:line,signal};}},
 {name:'uo',cn:'终极摆动指标',aliases:['uo','ultimate','ultimate_oscillator','终极震荡'],category:'momentum',args:[arg('fast',7,1,1000),P(14,1,1000),arg('slow',28,2,2000)],outputs:['value'],
  warmup:a=>a.slow!+1,
  compute:(bars,a)=>{const len=bars.length,bp=new Array<number>(len).fill(0),tr=new Array<number>(len).fill(0);
   for(let i=1;i<len;i++){const b=bars[i]!,pc=N(bars[i-1]!.close),lo=Math.min(N(b.low),pc),hi=Math.max(N(b.high),pc);bp[i]=N(b.close)-lo;tr[i]=hi-lo;}
   const avg=(n:number)=>{const sb=rollingSum(bp,n,1),st=rollingSum(tr,n,1);return sb.map((x,i)=>st[i]!>0?x/st[i]!:NaN);};
   const a1=avg(a.fast!),a2=avg(a.period!),a3=avg(a.slow!);
   return a3.map((x,i)=>Number.isFinite(x)&&Number.isFinite(a1[i]!)&&Number.isFinite(a2[i]!)?100*(4*a1[i]!+2*a2[i]!+x)/7:NaN);}},
 {name:'ao',cn:'动量震荡指标',aliases:['ao','awesome','awesome_oscillator','动量震荡'],category:'momentum',args:[arg('fast',5,1,1000),arg('slow',34,2,2000)],outputs:['value'],
  warmup:a=>a.slow!,
  compute:(bars,a)=>{const mid=bars.map(b=>(N(b.high)+N(b.low))/2),f=smaSeries(mid,a.fast!),s=smaSeries(mid,a.slow!);
   return s.map((x,i)=>Number.isFinite(x)?f[i]!-x:NaN);}},
 {name:'elder_ray',cn:'艾达透视(多空力量)',aliases:['elder_ray','elder','多空力量','艾达'],category:'momentum',args:[P(13,2,1000)],outputs:['bull','bear'],
  warmup:a=>a.period!,
  compute:(bars,a)=>{const e=emaSeries(closeOf(bars),a.period!);
   return {bull:e.map((x,i)=>Number.isFinite(x)?N(bars[i]!.high)-x:NaN),bear:e.map((x,i)=>Number.isFinite(x)?N(bars[i]!.low)-x:NaN)};}},
 /* --- 波动率/通道 --- */
 {name:'bbands',cn:'布林带',aliases:['bbands','bb','bollinger','布林','布林带'],category:'volatility',args:[P(20,2,1000),arg('multiple',2,0.1,10,false)],
  outputs:['middle','upper','lower','bandwidth','percent_b'],warmup:a=>a.period!,
  compute:(bars,a)=>{const c=closeOf(bars),mid=smaSeries(c,a.period!),sd=stdevSeries(c,a.period!);
   const upper=mid.map((x,i)=>x+a.multiple!*sd[i]!),lower=mid.map((x,i)=>x-a.multiple!*sd[i]!);
   return {middle:mid,upper,lower,
    bandwidth:mid.map((x,i)=>x>0?100*(upper[i]!-lower[i]!)/x:NaN),
    percent_b:upper.map((x,i)=>x>lower[i]!?(c[i]!-lower[i]!)/(x-lower[i]!):Number.isFinite(x)?0.5:NaN)};}},
 {name:'keltner',cn:'肯特纳通道',aliases:['keltner','kc','肯特纳'],category:'volatility',args:[P(20,2,1000),arg('period_2',10,1,1000),arg('multiple',2,0.1,10,false)],
  outputs:['middle','upper','lower'],warmup:a=>Math.max(a.period!,a.period_2!+1),
  compute:(bars,a)=>{const mid=emaSeries(closeOf(bars),a.period!),atr=atrSeries(bars,a.period_2!);
   return {middle:mid,upper:mid.map((x,i)=>x+a.multiple!*atr[i]!),lower:mid.map((x,i)=>x-a.multiple!*atr[i]!)};}},
 {name:'donchian',cn:'唐奇安通道',aliases:['donchian','唐奇安','价格通道'],category:'volatility',args:[P(20,1,5000)],outputs:['middle','upper','lower'],warmup:a=>a.period!,
  compute:(bars,a)=>{const u=rollingMax(highOf(bars),a.period!),l=rollingMin(lowOf(bars),a.period!);
   return {middle:u.map((x,i)=>(x+l[i]!)/2),upper:u,lower:l};}},
 {name:'atr',cn:'平均真实波幅',aliases:['atr','真实波幅'],category:'volatility',args:[P(14,1,1000)],outputs:['value'],warmup:a=>a.period!+1,
  compute:(bars,a)=>atrSeries(bars,a.period!)},
 {name:'natr',cn:'归一化平均真实波幅',aliases:['natr','波动率百分比'],category:'volatility',args:[P(14,1,1000)],outputs:['value'],warmup:a=>a.period!+1,
  compute:(bars,a)=>{const atr=atrSeries(bars,a.period!),c=closeOf(bars);return atr.map((x,i)=>c[i]!>0?100*x/c[i]!:NaN);}},
 {name:'stdev',cn:'收盘价标准差',aliases:['stdev','std','标准差'],category:'volatility',args:[P(20,2,1000)],outputs:['value'],warmup:a=>a.period!,
  compute:(bars,a)=>stdevSeries(closeOf(bars),a.period!)},
 /* --- 量能 --- */
 {name:'obv',cn:'能量潮',aliases:['obv','能量潮'],category:'volume',args:[],outputs:['value'],warmup:()=>1,
  compute:bars=>{const out=new Array<number>(bars.length).fill(0);let acc=0;
   for(let i=1;i<bars.length;i++){const c=N(bars[i]!.close),p=N(bars[i-1]!.close);acc+=c>p?N(bars[i]!.volume):c<p?-N(bars[i]!.volume):0;out[i]=acc;}
   return out;}},
 {name:'vwap',cn:'成交量加权均价(按 UTC 日重置)',aliases:['vwap','均价','成交量加权均价'],category:'volume',args:[],outputs:['value'],warmup:()=>1,
  note:'每个 UTC 自然日重新累计,与交易所 session VWAP 口径一致。',
  compute:bars=>{const out=nan(bars.length);let day=-1,pv=0,v=0;
   for(let i=0;i<bars.length;i++){const b=bars[i]!,d=Math.floor(b.open_time/86400000);
    if(d!==day){day=d;pv=0;v=0;}
    const tp=(N(b.high)+N(b.low)+N(b.close))/3;pv+=tp*N(b.volume);v+=N(b.volume);out[i]=v>0?pv/v:tp;}
   return out;}},
 {name:'cmf',cn:'蔡金资金流',aliases:['cmf','chaikin_money_flow','蔡金资金流'],category:'volume',args:[P(20,2,1000)],outputs:['value'],warmup:a=>a.period!,
  compute:(bars,a)=>{const mfv=bars.map(b=>{const h=N(b.high),l=N(b.low),c=N(b.close);return h>l?((c-l)-(h-c))/(h-l)*N(b.volume):0;});
   const sm=rollingSum(mfv,a.period!),sv=rollingSum(volumeOf(bars),a.period!);
   return sm.map((x,i)=>sv[i]!>0?x/sv[i]!:NaN);}},
 {name:'ad',cn:'累积/派发线',aliases:['ad','accumulation_distribution','累积派发'],category:'volume',args:[],outputs:['value'],warmup:()=>1,compute:bars=>adSeries(bars)},
 {name:'volume_ratio',cn:'量比',aliases:['volume_ratio','量比','相对成交量'],category:'volume',args:[P(20,1,5000)],outputs:['value'],warmup:a=>a.period!,
  compute:(bars,a)=>{const v=volumeOf(bars),ma=smaSeries(v,a.period!);return v.map((x,i)=>ma[i]!>0?x/ma[i]!:NaN);}},
 {name:'chaikin',cn:'蔡金振荡器',aliases:['chaikin','chaikin_oscillator','蔡金振荡'],category:'volume',args:[arg('fast',3,1,1000),arg('slow',10,2,2000)],outputs:['value'],
  warmup:a=>a.slow!,
  compute:(bars,a)=>{const ad=adSeries(bars),f=emaSeries(ad,a.fast!),s=emaSeries(ad,a.slow!);
   return s.map((x,i)=>Number.isFinite(x)?f[i]!-x:NaN);}},
];
export const INDICATORS:Record<string,IndicatorSpec>=Object.fromEntries(SPECS.map(s=>[s.name,s]));

export const INDICATOR_NAMES=Object.keys(INDICATORS).sort();
/** 别名(含中文)→ 规范名;仅供文档与人工查询,IR 里只接受规范名 */
export const INDICATOR_ALIASES:Record<string,string>=Object.fromEntries(
 Object.values(INDICATORS).flatMap(s=>[[s.name,s.name],[s.cn,s.name],...s.aliases.map(a=>[a,s.name] as [string,string])] as [string,string][]));
export const resolveIndicatorName=(x:string)=>INDICATOR_ALIASES[x]??INDICATOR_ALIASES[x.toLowerCase()];

/** 用默认值补齐参数,并把越界值钳回区间(schema 已挡住绝大多数,这里只兜底) */
export function resolveArgs(name:string,raw?:Record<string,unknown>|null):Args {
 const spec=INDICATORS[name];if(!spec)throw new Error(`unknown_indicator:${name}`);
 const out:Args={};
 for(const a of spec.args){const v=Number(raw?.[a.key]);const use=Number.isFinite(v)?v:a.default;
  out[a.key]=Math.min(a.max,Math.max(a.min,a.integer===false?use:Math.round(use)));}
 return out;
}
export function indicatorWarmup(name:string,raw?:Record<string,unknown>|null):number {
 const spec=INDICATORS[name];if(!spec)throw new Error(`unknown_indicator:${name}`);
 return Math.max(1,Math.ceil(spec.warmup(resolveArgs(name,raw))));
}
/** 统一成 {输出名: 序列};单输出的指标输出名为 value */
export function indicatorSeries(name:string,bars:Bars,raw?:Record<string,unknown>|null):Record<string,number[]> {
 const spec=INDICATORS[name];if(!spec)throw new Error(`unknown_indicator:${name}`);
 const r=spec.compute(bars,resolveArgs(name,raw));
 return Array.isArray(r)?{[spec.outputs[0]!]:r}:r;
}
/** 取一条线;output 缺失或不认识时回落到主输出 */
export function indicatorLine(name:string,bars:Bars,raw?:Record<string,unknown>|null,output?:string):number[] {
 const spec=INDICATORS[name]!,all=indicatorSeries(name,bars,raw);
 const key=output&&spec.outputs.includes(output)?output:spec.outputs[0]!;
 return all[key]??all[spec.outputs[0]!]!;
}
/** 单个指标内部的快慢周期约束(fast < slow),供 checkIR 的 ordered 检查复用 */
export function argsOrdered(raw?:Record<string,unknown>|null):boolean {
 const fast=Number(raw?.fast),slow=Number(raw?.slow);
 return !(Number.isFinite(fast)&&Number.isFinite(slow))||fast<slow;
}
