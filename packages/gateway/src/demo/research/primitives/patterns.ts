/** 形态原语(2026-09-22):交易者张口就来的经典形态,全部只用已确认的 pivot 与已收盘 bar。
 * 反转形态(双底/头肩底/双顶)一律以「收盘突破颈线」的那一根作为单根事件,而不是在 pivot 刚确认时就算成立——
 * 颈线突破是可交易的时刻,pivot 确认只是形态成形;K 线形态(吞没/针形/FVG/内包突破)只看最后两三根。
 */
import { define,n,type PrimitiveContext } from './registry.js';
import { confirmedPivots } from './signals.js';
import type { ResearchBar } from '@trade-gate/contracts';
type Bars=ResearchBar[];
const N=(x:unknown)=>Number(x);
const near=(a:number,b:number,tolPct:number)=>a>0&&Math.abs(a-b)/a<=tolPct/100;

/** 双底/双顶:两个同向 pivot 在容差内齐平,中间有一个反向 pivot 作颈线,收盘首次越过颈线当根触发。 */
function doubleReversal(ctx:PrimitiveContext,p:Record<string,unknown>,kind:'bottom'|'top'):boolean {
 const bars=ctx.bars,i=bars.length-1,swing=n(p,'swing_length'),lookback=n(p,'lookback'),tol=n(p,'tolerance_pct');
 if(i<2*swing+2)return false;
 const side=kind==='bottom'?'low':'high',other=kind==='bottom'?'high':'low';
 const same=confirmedPivots(bars.map(b=>N(b[side])),swing,side),opposite=confirmedPivots(bars.map(b=>N(b[other])),swing,other);
 const second=same.at(-1);if(!second||second.confirmed>i)return false;
 const first=same.filter(x=>x.index<second.index&&x.index>=second.index-lookback).at(-1);if(!first)return false;
 const a=N(bars[first.index]![side]),b=N(bars[second.index]![side]);if(!near(a,b,tol))return false;
 const between=opposite.filter(x=>x.index>first.index&&x.index<second.index&&x.confirmed<=i);if(!between.length)return false;
 const neck=kind==='bottom'
  ?Math.max(...between.map(x=>N(bars[x.index]!.high)))
  :Math.min(...between.map(x=>N(bars[x.index]!.low)));
 const close=N(bars[i]!.close),prev=N(bars[i-1]!.close);
 return kind==='bottom'?close>neck&&prev<=neck:close<neck&&prev>=neck;
}
const reversalWarmup=(p:Record<string,unknown>)=>2*n(p,'swing_length')+n(p,'lookback')+2;
export const double_bottom=define('double_bottom','signal','双底:两个齐平的已确认 pivot low 加中间颈线,收盘首次突破颈线当根触发',reversalWarmup,(ctx,p)=>({pass:doubleReversal(ctx,p,'bottom')}));
export const double_top_exit=define('double_top_exit','exit','双顶:两个齐平的已确认 pivot high,收盘首次跌破颈线当根离场',reversalWarmup,(ctx,p)=>({exit:!!ctx.position&&doubleReversal(ctx,p,'top')}));

/** 头肩底:左肩、更低的头、右肩三个已确认 pivot low,两肩在容差内齐平,颈线取两个中间反弹高点的较高者,收盘突破当根触发。 */
function inverseHeadAndShoulders(ctx:PrimitiveContext,p:Record<string,unknown>):boolean {
 const bars=ctx.bars,i=bars.length-1,swing=n(p,'swing_length'),lookback=n(p,'lookback'),tol=n(p,'tolerance_pct');
 if(i<2*swing+2)return false;
 const lows=confirmedPivots(bars.map(b=>N(b.low)),swing,'low').filter(x=>x.confirmed<=i),highs=confirmedPivots(bars.map(b=>N(b.high)),swing,'high').filter(x=>x.confirmed<=i);
 const right=lows.at(-1);if(!right)return false;
 const window=lows.filter(x=>x.index<right.index&&x.index>=right.index-lookback);
 const head=window.at(-1),left=window.at(-2);if(!head||!left)return false;
 const l=N(bars[left.index]!.low),h=N(bars[head.index]!.low),r=N(bars[right.index]!.low);
 if(!(h<l&&h<r)||!near(l,r,tol))return false;
 const necks=highs.filter(x=>x.index>left.index&&x.index<right.index);if(necks.length<2)return false;
 const neck=Math.max(...necks.map(x=>N(bars[x.index]!.high)));
 const close=N(bars[i]!.close),prev=N(bars[i-1]!.close);
 return close>neck&&prev<=neck;
}
export const head_and_shoulders_inverse=define('head_and_shoulders_inverse','signal','头肩底:左右肩齐平、头部更低的三个已确认 pivot low,收盘突破颈线当根触发',reversalWarmup,(ctx,p)=>({pass:inverseHeadAndShoulders(ctx,p)}));

/** 吞没:前一根反向实体被当根实体完全包住,且当根实体不小于前一根的 min_body_ratio 倍。 */
function engulfing(bars:Bars,p:Record<string,unknown>,kind:'bullish'|'bearish'):boolean {
 const i=bars.length-1;if(i<1)return false;
 const cur=bars[i]!,prev=bars[i-1]!,co=N(cur.open),cc=N(cur.close),po=N(prev.open),pc=N(prev.close);
 const body=Math.abs(cc-co),prevBody=Math.abs(pc-po),ratio=n(p,'min_body_ratio');
 if(prevBody<=0||body<prevBody*ratio)return false;
 return kind==='bullish'
  ?pc<po&&cc>co&&cc>=po&&co<=pc
  :pc>po&&cc<co&&cc<=po&&co>=pc;
}
export const bullish_engulfing=define('bullish_engulfing','signal','看涨吞没:阴线实体被随后的阳线实体完全吞没',()=>2,(ctx,p)=>({pass:engulfing(ctx.bars,p,'bullish')}));
export const bearish_engulfing_exit=define('bearish_engulfing_exit','exit','看跌吞没:阳线实体被随后的阴线实体完全吞没,持仓时离场',()=>2,(ctx,p)=>({exit:!!ctx.position&&engulfing(ctx.bars,p,'bearish')}));

/** 针形/锤子:下影足够长、实体足够小、上影足够短。 */
export const pin_bar=define('pin_bar','signal','锤子线/下影针:下影至少是实体的若干倍,实体与上影都受限',()=>1,(ctx,p)=>{
 const b=ctx.bars.at(-1);if(!b)return {pass:false};
 const h=N(b.high),l=N(b.low),o=N(b.open),c=N(b.close),range=h-l;if(!(range>0))return {pass:false};
 const body=Math.abs(c-o),lower=Math.min(o,c)-l,upper=h-Math.max(o,c);
 return {pass:lower>=n(p,'tail_ratio')*body&&body<=n(p,'max_body_pct')*range&&upper<=n(p,'max_upper_pct')*range};
});

/** 看涨 FVG(三根缺口):第 i-2 根的高点低于第 i 根的低点,中间一根为阳线,缺口宽度达到下限。 */
export const fair_value_gap=define('fair_value_gap','signal','看涨公允价值缺口:三根 K 线中第一根高点低于第三根低点且中间为阳线',()=>3,(ctx,p)=>{
 const bars=ctx.bars,i=bars.length-1;if(i<2)return {pass:false};
 const left=N(bars[i-2]!.high),mid=bars[i-1]!,right=N(bars[i]!.low),close=N(bars[i]!.close);
 const gap=right-left;
 return {pass:gap>0&&N(mid.close)>N(mid.open)&&close>0&&100*gap/close>=n(p,'min_gap_pct')};
});

/** 内包突破:母线之后连续若干根内包线,收盘首次突破母线高点当根触发。 */
export const inside_bar_breakout=define('inside_bar_breakout','signal','内包突破:母线后连续内包线,收盘首次突破母线高点当根触发',p=>n(p,'max_inside_bars')+2,(ctx,p)=>{
 const bars=ctx.bars,i=bars.length-1,max=n(p,'max_inside_bars');if(i<2)return {pass:false};
 let m=i-1,count=0;
 while(m>0&&count<max&&N(bars[m]!.high)<=N(bars[m-1]!.high)&&N(bars[m]!.low)>=N(bars[m-1]!.low)){m--;count++;}
 if(count<1)return {pass:false};
 const top=N(bars[m]!.high);
 return {pass:N(bars[i]!.close)>top&&N(bars[i-1]!.close)<=top};
});
