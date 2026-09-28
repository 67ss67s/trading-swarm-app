import { define,n,last } from './registry.js';
import { ema } from './trend-state.js';
import { htfSeries,htfRatio,seriesOf } from './htf.js';
// direction=down(2026-09-23 WP-F):收盘/最低价跌破此前 lookback 根最低价,做空触发(「跌破 20 日低点」);缺省 up 与旧口径逐字相同
export const donchian_breakout=define('donchian_breakout','signal','收盘或最高价突破此前通道(direction=down:收盘或最低价跌破此前通道下沿)',p=>n(p,'lookback')+1,(ctx,p)=>p.direction==='down'?({pass:ctx.bars.length>n(p,'lookback')&&Number(ctx.bars.at(-1)?.[p.basis==='high'?'low':'close'])<Math.min(...ctx.bars.slice(-n(p,'lookback')-1,-1).map(b=>Number(b.low)))}):({pass:ctx.bars.length>n(p,'lookback')&&Number(ctx.bars.at(-1)?.[p.basis==='high'?'high':'close'])>Math.max(...ctx.bars.slice(-n(p,'lookback')-1,-1).map(b=>Number(b.high)))}));
export const volume_surge=define('volume_surge','signal','成交量达到此前均量倍数',p=>n(p,'lookback')+1,(ctx,p)=>{const prior=ctx.bars.slice(-n(p,'lookback')-1,-1),mean=prior.reduce((a,b)=>a+Number(b.volume),0)/prior.length;return {pass:prior.length===n(p,'lookback')&&mean>0&&Number(ctx.bars.at(-1)?.volume)>=mean*n(p,'multiple')};});
export const ema_cross=define('ema_cross','signal','快 EMA 向上穿越慢 EMA',p=>n(p,'slow')+1,(ctx,p)=>{const values=ctx.bars.map(b=>Number(b.close)),f=ema(values,n(p,'fast')),s=ema(values,n(p,'slow'));return {pass:values.length>n(p,'slow')&&f.at(-2)!<=s.at(-2)!&&f.at(-1)!>s.at(-1)!};});
export const rsi_threshold=define('rsi_threshold','signal','Wilder RSI 越过指定阈值',p=>n(p,'period')+1,(ctx,p)=>{const period=n(p,'period');if(ctx.bars.length<=period)return {pass:false};let gain=0,loss=0;
 for(let i=1;i<ctx.bars.length;i++){const delta=Number(ctx.bars[i]!.close)-Number(ctx.bars[i-1]!.close),up=Math.max(0,delta),down=Math.max(0,-delta);if(i<=period){gain+=up/period;loss+=down/period;}else{gain=(gain*(period-1)+up)/period;loss=(loss*(period-1)+down)/period;}}
 const rsi=loss>0?100-100/(1+gain/loss):gain>0?100:50;return {pass:p.operator==='above'?rsi>n(p,'threshold'):rsi<n(p,'threshold')};});
export const higher_low_sequence=define('higher_low_sequence','signal','连续低点抬高',p=>n(p,'count'),(ctx,p)=>{const bars=ctx.bars.slice(-n(p,'count'));return {pass:bars.length===n(p,'count')&&bars.every((b,i)=>i===0||Number(b.low)>Number(bars[i-1]!.low))};});
export const candle_streak=define('candle_streak','signal','连续 N 根阳线(收盘>开盘;direction=down:连续阴线),第 N 根收盘当根触发',p=>n(p,'count'),(ctx,p)=>{const k=n(p,'count'),bars=ctx.bars.slice(-k),up=p.direction!=='down';return {pass:bars.length===k&&bars.every(b=>up?Number(b.close)>Number(b.open):Number(b.close)<Number(b.open))};});
/** MACD(快/慢 EMA 差,信号线为其 EMA,柱=差-信号)。ema() 从首值起算,无 NaN 段,预热由 warmup_bars 保证。 */
export function macd(values:number[],fast:number,slow:number,signal:number):{macd:number[];signal:number[];hist:number[]} {
 const f=ema(values,fast),s=ema(values,slow),m=f.map((v,i)=>v-s[i]!),sig=ema(m,signal);return {macd:m,signal:sig,hist:m.map((v,i)=>v-sig[i]!)};
}
/** 已确认的 pivot:中心值严格低于(高于)左侧 swing 根、不高于(不低于)右侧 swing 根;确认时刻 = 中心 + swing,只用已收盘 bar。 */
export function confirmedPivots(values:number[],swing:number,kind:'low'|'high'):{index:number;confirmed:number}[] {
 const out:{index:number;confirmed:number}[]=[];
 for(let c=swing;c+swing<values.length;c++){const v=values[c]!;let ok=true;
  for(let j=c-swing;j<=c+swing&&ok;j++){if(j===c)continue;const x=values[j]!;ok=kind==='low'?(j<c?v<x:v<=x):(j<c?v>x:v>=x);}
  if(ok)out.push({index:c,confirmed:c+swing});}
 return out;
}
const divergenceParams=(p:Record<string,unknown>)=>({fast:n(p,'fast'),slow:n(p,'slow'),signal:n(p,'signal'),swing:n(p,'swing_length'),lookback:n(p,'lookback'),source:p.source==='macd'?'macd':'histogram'} as const);
export const divergenceWarmup=(p:Record<string,unknown>)=>n(p,'slow')+n(p,'signal')+n(p,'lookback')+2*n(p,'swing_length')+1;
/** 在当前 bar 刚被确认的 pivot 与 lookback 内上一个 pivot 之间比较价格与指标:底背离=价格更低、指标更高;顶背离=价格更高、指标更低。 */
export function macdDivergence(bars:import('@trade-gate/contracts').ResearchBar[],p:Record<string,unknown>,kind:'bullish'|'bearish'):boolean {
 const {fast,slow,signal,swing,lookback,source}=divergenceParams(p);if(!(fast<slow)||bars.length<=slow+signal+2*swing)return false;
 const closes=bars.map(b=>Number(b.close)),ind=macd(closes,fast,slow,signal)[source==='macd'?'macd':'hist'];
 const pivotKind=kind==='bullish'?'low':'high',pivots=confirmedPivots(bars.map(b=>Number(b[pivotKind])),swing,pivotKind),latest=pivots.at(-1);
 if(!latest||latest.confirmed!==bars.length-1)return false;
 const previous=pivots.filter(x=>x.index<latest.index&&x.index>=latest.index-lookback).at(-1);if(!previous)return false;
 const p1=Number(bars[previous.index]![pivotKind]),p2=Number(bars[latest.index]![pivotKind]),i1=ind[previous.index]!,i2=ind[latest.index]!;
 return kind==='bullish'?p2<p1&&i2>i1:p2>p1&&i2<i1;
}
export const macd_cross=define('macd_cross','signal','MACD 线向上穿越信号线',p=>n(p,'slow')+n(p,'signal')+1,(ctx,p)=>{const values=ctx.bars.map(b=>Number(b.close)),m=macd(values,n(p,'fast'),n(p,'slow'),n(p,'signal'));return {pass:values.length>n(p,'slow')+n(p,'signal')&&m.macd.at(-2)!<=m.signal.at(-2)!&&m.macd.at(-1)!>m.signal.at(-1)!};});
/**
 * 高周期背离(2026-09-23 夜,params.htf):按 htf 把整段已收盘 K 线分桶聚成完整高周期 K 线(primitives/htf.ts),在高周期上按 macdDivergence 同一规则判背离;
 * 确认那根高周期 K 线收完的执行周期 K 线当根触发(事件型,只这一根)。一次 O(K) 算完整段:MACD 是递推的、pivot 只看 [c−swing, c+swing],
 * 所以第 k 根高周期 K 线上的结论与「截前缀 bars[0..k] 调 macdDivergence」逐位相同(test/demo/research/htf-primitives.test.ts 对拍)。
 */
const divCache=new WeakMap<import('@trade-gate/contracts').ResearchBar[],Map<string,Uint8Array>>();
export function htfDivergenceFlags(series:import('@trade-gate/contracts').ResearchBar[],base:number,htf:string,p:Record<string,unknown>,kind:'bullish'|'bearish'):Uint8Array {
 const {fast,slow,signal,swing,lookback,source}=divergenceParams(p),key=`${base}:${htf}:${fast}:${slow}:${signal}:${swing}:${lookback}:${source}:${kind}`;
 let m=divCache.get(series);if(!m){m=new Map();divCache.set(series,m);}const hit=m.get(key);if(hit)return hit;
 const out=new Uint8Array(series.length),h=htfSeries(series,base,htf);m.set(key,out);if(!(fast<slow))return out;
 const bars=h.bars,ind=macd(bars.map(b=>Number(b.close)),fast,slow,signal)[source==='macd'?'macd':'hist'],pivotKind=kind==='bullish'?'low':'high',pivots=confirmedPivots(bars.map(b=>Number(b[pivotKind])),swing,pivotKind);
 for(let j=1;j<pivots.length;j++){const latest=pivots[j]!,k=latest.confirmed,previous=pivots[j-1]!;if(k+1<=slow+signal+2*swing||previous.index<latest.index-lookback)continue;
  const p1=Number(bars[previous.index]![pivotKind]),p2=Number(bars[latest.index]![pivotKind]),i1=ind[previous.index]!,i2=ind[latest.index]!;
  if(kind==='bullish'?p2<p1&&i2>i1:p2>p1&&i2<i1)out[h.end[k]!]=1;}
 return out;
}
/** 背离判定入口:有 htf 走高周期(整段 series),没有走旧口径(决策视图,逐字节同旧行为)。 */
export function divergenceAt(ctx:import('./registry.js').PrimitiveContext,p:Record<string,unknown>,kind:'bullish'|'bearish'):boolean {
 if(typeof p.htf!=='string')return macdDivergence(ctx.bars,p,kind);
 const {series,i}=seriesOf(ctx);return i>=0&&i<series.length&&htfDivergenceFlags(series,ctx.timeframe_ms,p.htf,p,kind)[i]===1;
}
/** 有 htf 时决策视图预热记 0(从整段 series 算),历史需求 = (旧预热 + 1) 根高周期折算成执行周期根数;没有 htf 与旧口径相同。 */
export const divergenceViewWarmup=(p:Record<string,unknown>)=>typeof p.htf==='string'?0:divergenceWarmup(p);
export const divergenceHistory=(p:Record<string,unknown>,base=3600000)=>{if(typeof p.htf!=='string')return 0;try{return (divergenceWarmup(p)+1)*htfRatio(p.htf,base);}catch{return 0;}};
// direction=bearish(2026-09-23 夜):顶背离当入场触发(做空 short_signal);缺省 bullish 与旧口径逐字相同
export const macd_divergence=define('macd_divergence','signal','MACD 底背离:价格创更低的已确认 pivot low 而 MACD 柱/线抬高,确认当根触发(direction=bearish:顶背离,价格更高的 pivot high 而 MACD 走低,做空触发;htf=在高周期 K 线上判,那根高周期 K 线收盘时触发)',divergenceViewWarmup,(ctx,p)=>({pass:divergenceAt(ctx,p,p.direction==='bearish'?'bearish':'bullish')}),divergenceHistory);
