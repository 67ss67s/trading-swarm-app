/** Causal subset of SMC: confirmed pivots, level breaks and the last opposite candle.
 * Reference definitions: joshyattridge/smart-money-concepts (MIT); no Pine code copied.
 * Deliberately excludes FVG, liquidity and premium/discount. Confirmation is never backdated.
 */
import type {ResearchBar,ResearchStructure} from '@trade-gate/contracts';
import {define,type PrimitiveContext} from './registry.js';
export interface Pivot {kind:'high'|'low';index:number;confirmed_index:number;at:number;confirmed_at:number;price:string}
export interface Break {kind:'bos'|'choch';direction:'up'|'down';index:number;at:number;pivot_index:number;level:string}
export interface Block {direction:'up'|'down';index:number;formed_at:number;lower:string;upper:string;mitigated:boolean;mitigated_at:number|null}
export function structure(bars:ResearchBar[],swing_length=3,confirmation='close',zone='wick'):{pivots:Pivot[];breaks:Break[];blocks:Block[]} {
 if(!Number.isInteger(swing_length)||swing_length<1||swing_length>100)throw Error('invalid_swing_length');
 const pivots:Pivot[]=[],breaks:Break[]=[],blocks:Block[]=[];let high:Pivot|undefined,low:Pivot|undefined,direction:string|null=null;const broken=new Set<string>();
 for(let i=0;i<bars.length;i++){
  const b=bars[i]!,center=i-swing_length;
  if(center>=swing_length){const c=bars[center]!,window=bars.slice(center-swing_length,i+1);
   for(const kind of ['high','low'] as const){const price=Number(c[kind]);const extreme=kind==='high'?Math.max(...window.map(x=>Number(x.high))):Math.min(...window.map(x=>Number(x.low)));
    // Deterministic plateau tie: the rightmost equal extreme is the pivot.
    if(price===extreme&&!bars.slice(center+1,i+1).some(x=>Number(x[kind])===price)){
     const pivot={kind,index:center,confirmed_index:i,at:c.close_time,confirmed_at:b.close_time,price:c[kind]};pivots.push(pivot);if(kind==='high')high=pivot;else low=pivot;
    }
   }
  }
  for(const block of blocks)if(!block.mitigated&&block.formed_at<b.close_time&&(block.direction==='up'?Number(b.low)<=Number(block.lower):Number(b.high)>=Number(block.upper))){block.mitigated=true;block.mitigated_at=b.close_time;}
  for(const [dir,pivot] of [['up',high],['down',low]] as const){if(!pivot||broken.has(`${dir}:${pivot.index}`))continue;
   const price=Number(confirmation==='close'?b.close:dir==='up'?b.high:b.low),cross=dir==='up'?price>Number(pivot.price):price<Number(pivot.price);if(!cross)continue;
   broken.add(`${dir}:${pivot.index}`);breaks.push({kind:direction&&direction!==dir?'choch':'bos',direction:dir,index:i,at:b.close_time,pivot_index:pivot.index,level:pivot.price});direction=dir;
   for(let k=i-1;k>=pivot.index;k--){const c=bars[k]!;if(dir==='up'?Number(c.close)<Number(c.open):Number(c.close)>Number(c.open)){
    blocks.push({direction:dir,index:k,formed_at:b.close_time,lower:zone==='body'?Math.min(Number(c.open),Number(c.close)).toFixed(8):c.low,upper:zone==='body'?Math.max(Number(c.open),Number(c.close)).toFixed(8):c.high,mitigated:false,mitigated_at:null});break;
   }}
  }
 }
 return {pivots,breaks,blocks};
}
export function completeBuckets(bars:ResearchBar[],base:number,target:number):ResearchBar[]{
 if(target<base||target%base!==0)return [];const groups=new Map<number,ResearchBar[]>();for(const b of bars){const key=Math.floor(b.open_time/target)*target;const group=groups.get(key)??[];group.push(b);groups.set(key,group);}
 return [...groups].flatMap(([at,g])=>g.length===target/base&&g.every((b,i)=>b.open_time===at+i*base)&&g.at(-1)!.close_time===at+target-1?[{open_time:at,close_time:at+target-1,available_at:at+target-1,open:g[0]!.open,close:g.at(-1)!.close,high:Math.max(...g.map(b=>Number(b.high))).toFixed(8),low:Math.min(...g.map(b=>Number(b.low))).toFixed(8),volume:g.reduce((a,b)=>a+Number(b.volume),0).toFixed(8)}]:[]);
}
const timeframe=(tf:unknown)=>{const m=/^(\d+)(m|h|d)$/.exec(String(tf??'1d'));if(!m)throw Error('invalid_htf');return Number(m[1])*({m:60000,h:3600000,d:86400000}[m[2]!]!);};
export function htfStructure(ctx:PrimitiveContext,p:Record<string,unknown>={}):ResearchStructure {
 const visible=ctx.bars.slice(0,ctx.i+1),bars=completeBuckets(visible,ctx.timeframe_ms,timeframe(p.htf)),s=structure(bars,Number(p.swing_length??3),String(p.confirmation??'close'),String(p.zone??'wick')),price=Number(visible.at(-1)?.close);
 const support=s.blocks.filter(x=>!x.mitigated&&x.direction==='up'&&Number(x.upper)<price).sort((a,b)=>Number(b.upper)-Number(a.upper))[0],resistance=s.blocks.filter(x=>!x.mitigated&&x.direction==='down'&&Number(x.lower)>price).sort((a,b)=>Number(a.lower)-Number(b.lower))[0];
 const pivot=s.pivots.filter(x=>x.kind==='low'&&Number(x.price)<price).at(-1);
 const pos=support&&resistance?(price-Number(support.upper))/(Number(resistance.lower)-Number(support.upper)):null;
 return {as_of:bars.at(-1)?.close_time??null,status:bars.length>=2*Number(p.swing_length??3)+1?'ok':'insufficient',support:support?{lower:support.lower,upper:support.upper,formed_at:support.formed_at}:null,resistance:resistance?{lower:resistance.lower,upper:resistance.upper,formed_at:resistance.formed_at}:null,position:pos===null?null:Math.max(0,Math.min(1,pos)),bos_direction:s.breaks.at(-1)?.direction??null,pivot_low:pivot?.price??null};
}
const local=(ctx:PrimitiveContext,p:Record<string,unknown>)=>structure(ctx.bars,Number(p.swing_length??3),String(p.confirmation??'close'),String(p.zone??'wick'));
export const structure_pivots=define('structure_pivots','signal','确认后才可见的左右 pivot',p=>2*Number(p.swing_length)+1,(ctx,p)=>{const s=local(ctx,p);return {pass:s.pivots.some(x=>x.confirmed_index===ctx.i),structure:s};});
export const structure_bos=define('structure_bos','signal','收盘/影线突破已确认结构位，反向标 CHoCH',p=>2*Number(p.swing_length)+2,(ctx,p)=>{const s=local(ctx,p);return {pass:s.breaks.some(x=>x.index===ctx.i&&x.direction==='up'),structure:s};});
export const order_blocks=define('order_blocks','stop','最近未失效支撑色块下沿，缺失时使用确认 pivot low',p=>2*Number(p.swing_length)+2,(ctx,p)=>{const s=local(ctx,p),price=Number(ctx.bars.at(-1)?.close),block=s.blocks.filter(x=>x.direction==='up'&&!x.mitigated&&Number(x.lower)<price).sort((a,b)=>Number(b.lower)-Number(a.lower))[0];return {stop:block?Number(block.lower):Number(s.pivots.filter(x=>x.kind==='low'&&Number(x.price)<price).at(-1)?.price),structure:s};});
export const htf_structure=define('htf_structure','stop','已收盘高周期支撑色块下沿或 pivot low',(p,base)=>Math.ceil(timeframe(p.htf)/(base??3600000))*(2*Number(p.swing_length??3)+2),(ctx,p)=>{const s=htfStructure(ctx,p);return {stop:s.support?Number(s.support.lower):s.pivot_low?Number(s.pivot_low):undefined,htf_structure:s};});
export const structure_target=define('structure_target','exit','高周期最近上方阻力色块下沿为独立止盈',(p,base)=>Math.ceil(timeframe(p.htf)/(base??3600000))*(2*Number(p.swing_length??3)+2),(ctx,p)=>{const s=htfStructure(ctx,p);return {target:s.resistance?Number(s.resistance.lower):undefined,htf_structure:s};});
/** 日线结构决定大趋势，小周期只在大周期允许的方向和位置上交易（2026-09-21 任务书 §1）。
 * 只用已收盘的高周期 K 线：最近一次结构突破必须向上（BOS/CHoCH up），且当前价离上方阻力块还有空间（position ≤ max_position）。 */
export const htf_structure_regime=define('htf_structure_regime','regime','高周期结构方向门：最近 BOS 向上且价格未贴近上方阻力块',(p,base)=>Math.ceil(timeframe(p.htf)/(base??3600000))*(2*Number(p.swing_length??3)+2),(ctx,p)=>{
 const s=htfStructure(ctx,p),requireBos=p.require_bos!==false,maxPos=p.max_position===undefined?0.7:Number(p.max_position);
 const pass=s.status==='ok'&&(!requireBos||s.bos_direction==='up')&&(s.position===null||s.position<=maxPos);
 return {pass,htf_structure:s};
});
