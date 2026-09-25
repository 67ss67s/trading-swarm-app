import type { ResearchBar } from '@trading-swarm/contracts';
export const FINE_MS=15*60_000;
export const NULL_TIMEFRAMES={ '15m':FINE_MS,'4h':16*FINE_MS,'1d':96*FINE_MS } as const;
export function rng(seed:number):()=>number {let s=seed>>>0;return()=>{s=(1664525*s+1013904223)>>>0;return(s+0.5)/2**32;};}
const gaussian=(r:()=>number)=>Math.sqrt(-2*Math.log(r()))*Math.cos(2*Math.PI*r());
const dec=(n:number)=>n.toFixed(8);
export interface NullPanel {symbols:string[];fine:Record<string,ResearchBar[]>;seed:number;null_kind:'n1'|'n2'|'positive_control';funding:'zero';}
export interface NullOptions {seed:number;bars:number;symbols?:string[];start_ms?:number;step_ms?:number;}
function panel(o:NullOptions,kind:NullPanel['null_kind'],increments:(i:number,j:number,previous:number[])=>{ret:number;volume:number}):NullPanel {
 const symbols=o.symbols??['BTCUSDT','ETHUSDT','SOLUSDT'],fine:Record<string,ResearchBar[]>={},last=symbols.map((_,i)=>100+i*10),previous=symbols.map(()=>0),step=o.step_ms??FINE_MS,start=o.start_ms??Date.UTC(2015,0,1);
 if(!Number.isSafeInteger(o.bars)||o.bars<2||o.bars>2_000_000||start%step)throw Error('null_options_invalid');
 symbols.forEach(s=>{fine[s]=[];});
 for(let i=0;i<o.bars;i++)for(let j=0;j<symbols.length;j++){
  const {ret,volume}=increments(i,j,previous),open=last[j]!,close=open*(1+ret),at=start+i*step;
  if(!(close>0)||!Number.isFinite(close))throw Error('null_nonpositive_path');
  fine[symbols[j]!]!.push({open_time:at,close_time:at+step-1,available_at:at+step-1,open:dec(open),close:dec(close),high:dec(Math.max(open,close)),low:dec(Math.min(open,close)),volume:dec(volume)});last[j]=close;previous[j]=ret;
 }
 return{symbols,fine,seed:o.seed,null_kind:kind,funding:'zero'};
}
/** 条件波动只依赖过去；−σ²/2 修正保证价格在零费用下为鞅。 */
export function correlatedWalk(o:NullOptions):NullPanel {
 const r=rng(o.seed),sd:number[]=[],rho=0.65;let common=0;
 return panel(o,'n1',(i,j,previous)=>{if(j===0)common=gaussian(r);const sigma=Math.sqrt(0.000001+0.88*(sd[j]??0.003)**2+0.08*(previous[j]??0)**2);sd[j]=sigma;const z=Math.sqrt(rho)*common+Math.sqrt(1-rho)*gaussian(r);return{ret:Math.exp(sigma*z-sigma*sigma/2)-1,volume:Math.exp(6+0.3*gaussian(r))};});
}
export interface DevelopmentPanel {returns:number[][];volumes:number[][];at:number[];development_to_ms:number;}
/** 同步时间块重抽保留横截面结构；每时点共同独立符号破坏方向可预测性。 */
export function signFlipBlocks(o:NullOptions,development:DevelopmentPanel,block_bars=96):NullPanel {
 const n=development.returns.length,m=o.symbols?.length??3;
 if(n<block_bars||development.at.length!==n||development.volumes.length!==n||development.at.some(t=>t>development.development_to_ms)||development.returns.some(row=>row.length!==m||row.some(v=>!Number.isFinite(v))))throw Error('n2_requires_development_only_panel');
 const r=rng(o.seed);let start=0,sign=1;
 return panel(o,'n2',(i,j)=>{if(j===0){if(i%block_bars===0)start=Math.floor(r()*(n-block_bars+1));sign=r()<0.5?-1:1;}const k=start+i%block_bars;return{ret:sign*Math.max(-0.25,Math.min(0.25,development.returns[k]![j]!)),volume:development.volumes[k]![j]!};});
}
/** 仅为离线工程 fixture：厚尾/聚集开发数据，不宣称真实市场校准。 */
export function syntheticDevelopment(seed=17,n=4096,m=3):DevelopmentPanel {
 const r=rng(seed),returns:number[][]=[],volumes:number[][]=[],at:number[]=[];let volatility=0.004;
 for(let i=0;i<n;i++){const common=gaussian(r)/Math.sqrt(Math.max(0.05,Array.from({length:3},()=>gaussian(r)**2).reduce((a,b)=>a+b,0)/3));volatility=0.0003+0.88*volatility+0.05*Math.abs(common)*volatility;returns.push(Array.from({length:m},()=>Math.max(-0.2,Math.min(0.2,volatility*(common+gaussian(r)*0.3)))));volumes.push(Array.from({length:m},()=>100*(1+Math.abs(common))));at.push(i*FINE_MS);}
 return{returns,volumes,at,development_to_ms:at.at(-1)!};
}
export function positiveControl(o:NullOptions):NullPanel {
 const r=rng(o.seed);return panel(o,'positive_control',(i)=>({ret:0.008*Math.sin(2*Math.PI*i/96)+0.0002*gaussian(r),volume:1000}));
}
/** high/low 从同一重建细路径聚合，拒绝不完整根。 */
export function aggregate(bars:readonly ResearchBar[],step_ms:number):ResearchBar[] {
 if(!bars.length)return[];const fine=bars[0]!.close_time-bars[0]!.open_time+1;if(step_ms%fine)throw Error('aggregation_alignment');
 const count=step_ms/fine,out:ResearchBar[]=[];
 for(let i=0;i<bars.length;){const at=bars[i]!.open_time;if(at%step_ms){i++;continue;}const group=bars.slice(i,i+count);if(group.length<count)break;
  if(group.some((b,k)=>b.open_time!==at+k*fine))throw Error('aggregation_gap');
  out.push({open_time:at,close_time:at+step_ms-1,available_at:at+step_ms-1,open:group[0]!.open,close:group.at(-1)!.close,high:dec(Math.max(...group.map(b=>Number(b.high)))),low:dec(Math.min(...group.map(b=>Number(b.low)))),volume:dec(group.reduce((s,b)=>s+Number(b.volume),0))});i+=count;
 }return out;
}
export function aggregatePanel(panel:NullPanel):Record<string,Record<string,ResearchBar[]>> {return Object.fromEntries(Object.entries(NULL_TIMEFRAMES).map(([tf,step])=>[tf,Object.fromEntries(panel.symbols.map(s=>[s,aggregate(panel.fine[s]!,step)]))]));}
