/** 三个通用原语(2026-09-22):穿越 / 阈值 / 背离,配合 indicators.ts 的指标表,
 * 让「任意指标 × 任意用法」不必为每个组合单独写一个原语(组合爆炸的解法)。
 * 每个信号类原语都配一个 *_exit 版本,方向相反的同一判断可以直接当离场用。
 * 因果性:只读已收盘 bar;穿越只看最后两根;背离只在 pivot 被确认的那一根触发一次。
 */
import { define,n,type PrimitiveContext } from './registry.js';
import { confirmedPivots } from './signals.js';
import { indicatorLine,indicatorWarmup,priceSeries,INDICATORS,type Bars } from './indicators.js';

const rec=(p:Record<string,unknown>,key:string)=>(p[key]&&typeof p[key]==='object'?p[key] as Record<string,unknown>:null);
const name=(p:Record<string,unknown>,key:string)=>String(p[key]??'');
/** 被比较的那条线:指标 / 价格 / 常数 */
function otherLine(bars:Bars,p:Record<string,unknown>):number[] {
 const to=String(p.compare_to??'price');
 if(to==='constant'){const c=Number(p.constant??0);return new Array<number>(bars.length).fill(c);}
 if(to==='indicator')return indicatorLine(name(p,'compare_indicator')||name(p,'indicator'),bars,rec(p,'compare_args'),p.compare_output===undefined?undefined:String(p.compare_output));
 return priceSeries(bars,String(p.compare_price??'close'));
}
const mainLine=(bars:Bars,p:Record<string,unknown>)=>indicatorLine(name(p,'indicator'),bars,rec(p,'args'),p.output===undefined?undefined:String(p.output));
const crossWarmup=(p:Record<string,unknown>)=>{
 const self=indicatorWarmup(name(p,'indicator'),rec(p,'args'));
 const other=String(p.compare_to??'price')==='indicator'?indicatorWarmup(name(p,'compare_indicator')||name(p,'indicator'),rec(p,'compare_args')):1;
 return Math.max(self,other)+1;
};
/** 最后一根发生穿越:上穿要求上一根还在下方(或相等),这一根严格在上方 */
function crossed(ctx:PrimitiveContext,p:Record<string,unknown>):boolean {
 const bars=ctx.bars;if(bars.length<2)return false;
 const a=mainLine(bars,p),b=otherLine(bars,p),i=bars.length-1;
 const a0=a[i-1],a1=a[i],b0=b[i-1],b1=b[i];
 if(![a0,a1,b0,b1].every(x=>Number.isFinite(x as number)))return false;
 const dir=String(p.direction);
 // above/below 是状态:这一根主线在比较线上方/下方即成立(2026-09-23:「回踩 EMA20 限价买」需要「价格在 EMA20 之上」这种持续条件,穿越事件表达不了)
 if(dir==='above')return a1!>b1!;if(dir==='below')return a1!<b1!;
 return dir==='cross_below'?a0!>=b0!&&a1!<b1!:a0!<=b0!&&a1!>b1!;
}
export const indicator_cross=define('indicator_cross','signal','任意指标线与另一条指标线/价格/常数发生穿越(单根事件);direction=above/below 时为状态(处于上方/下方)',crossWarmup,(ctx,p)=>({pass:crossed(ctx,p)}));
export const indicator_cross_exit=define('indicator_cross_exit','exit','持仓时任意指标线与另一条指标线/价格/常数发生穿越即离场',crossWarmup,(ctx,p)=>({exit:!!ctx.position&&crossed(ctx,p)}));

const thresholdWarmup=(p:Record<string,unknown>)=>indicatorWarmup(name(p,'indicator'),rec(p,'args'))+(String(p.operator).startsWith('cross')?1:0);
/** above/below 是状态(每根都可能成立),cross_above/cross_below 是单根事件 */
function threshold(ctx:PrimitiveContext,p:Record<string,unknown>):boolean {
 const bars=ctx.bars,a=mainLine(bars,p),i=bars.length-1,t=n(p,'threshold'),op=String(p.operator);
 const cur=a[i];if(!Number.isFinite(cur as number))return false;
 if(op==='above')return cur!>t;
 if(op==='below')return cur!<t;
 const prev=a[i-1];if(i<1||!Number.isFinite(prev as number))return false;
 return op==='cross_below'?prev!>=t&&cur!<t:prev!<=t&&cur!>t;
}
export const indicator_threshold=define('indicator_threshold','signal','任意指标线相对固定阈值的状态或穿越(如 RSI 上穿 30)',thresholdWarmup,(ctx,p)=>({pass:threshold(ctx,p)}));
export const indicator_threshold_exit=define('indicator_threshold_exit','exit','持仓时任意指标线相对固定阈值的状态或穿越即离场(如 RSI 跌破 50)',thresholdWarmup,(ctx,p)=>({exit:!!ctx.position&&threshold(ctx,p)}));

const divergenceWarmup=(p:Record<string,unknown>)=>indicatorWarmup(name(p,'indicator'),rec(p,'args'))+n(p,'lookback')+2*n(p,'swing_length')+1;
/** 已确认 pivot 之间比较价格与指标:底背离=价格更低而指标更高,顶背离=价格更高而指标更低;确认当根触发一次。 */
export function divergence(bars:Bars,p:Record<string,unknown>,kind:'bullish'|'bearish'):boolean {
 const swing=n(p,'swing_length'),lookback=n(p,'lookback');
 if(bars.length<=2*swing+1)return false;
 const ind=mainLine(bars,p),side=kind==='bullish'?'low':'high';
 const pivots=confirmedPivots(bars.map(b=>Number(b[side])),swing,side),latest=pivots.at(-1);
 if(!latest||latest.confirmed!==bars.length-1)return false;
 const previous=pivots.filter(x=>x.index<latest.index&&x.index>=latest.index-lookback).at(-1);if(!previous)return false;
 const p1=Number(bars[previous.index]![side]),p2=Number(bars[latest.index]![side]),i1=ind[previous.index],i2=ind[latest.index];
 if(!Number.isFinite(i1 as number)||!Number.isFinite(i2 as number))return false;
 return kind==='bullish'?p2<p1&&i2!>i1!:p2>p1&&i2!<i1!;
}
export const indicator_divergence=define('indicator_divergence','signal','任意指标的底背离:价格创更低的已确认 pivot low 而指标抬高,确认当根触发一次',divergenceWarmup,(ctx,p)=>({pass:divergence(ctx.bars,p,'bullish')}));
export const indicator_divergence_exit=define('indicator_divergence_exit','exit','任意指标的顶背离:价格创更高的已确认 pivot high 而指标走低,确认当根离场',divergenceWarmup,(ctx,p)=>({exit:!!ctx.position&&divergence(ctx.bars,p,'bearish')}));

/** 目录文案:列出可用指标、输出线与参数,供文档与提示词引用(不进 describe,避免目录条目过长) */
export const indicatorCatalogText=()=>Object.values(INDICATORS).map(s=>`${s.name}(${s.cn})参数 ${s.args.map(a=>`${a.key}=${a.default}`).join('/')||'无'};输出 ${s.outputs.join('/')}`).join('\n');
