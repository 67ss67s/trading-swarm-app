/** 价位原语(2026-09-23,WP-F 订单周期):一个原语同时给出三种角色的价,由 orders/intents.ts 按角色取用——
 *  level=入场角色(限价挂单价)、stop=止损角色、target=止盈角色。方向由 ctx.side 决定(缺省 long,做空镜像到另一侧)。
 *  category 记为 stop,因此同一原语也能直接写进 risk.stop(「止损跌破 EMA50」= indicator_level{ema,50})。
 *  因果性:只读已收盘 bar;高周期结构只用完整的高周期桶(completeBuckets)。
 */
import { define,n,atr,last,type PrimitiveContext } from './registry.js';
import { indicatorLine,indicatorWarmup } from './indicators.js';
import { structure,completeBuckets } from './structure.js';
import { atrSeries } from './indicators.js';
import { pivots } from '../../geometry-lab/core.js';
const tfMs=(tf:unknown)=>{const m=/^(\d+)(m|h|d)$/.exec(String(tf));if(!m)throw Error('invalid_htf');return Number(m[1])*({m:60000,h:3600000,d:86400000}[m[2]!]!);};
const rec=(p:Record<string,unknown>,key:string)=>(p[key]&&typeof p[key]==='object'?p[key] as Record<string,unknown>:null);
const isShort=(ctx:PrimitiveContext)=>ctx.side==='short';
/** 止损角色向外让出的缓冲:buffer_atr × ATR(atr_period);没配就是 0 */
const bufferOf=(ctx:PrimitiveContext,p:Record<string,unknown>)=>{const k=Number(p.buffer_atr??0);if(!(k>0))return 0;const a=atr(ctx.bars,Number(p.atr_period??14));return Number.isFinite(a)?a*k:NaN;};
const bufferWarmup=(p:Record<string,unknown>)=>Number(p.buffer_atr??0)>0?Number(p.atr_period??14)+1:0;
/** 指标线当根值:入场=回踩这条线,止损=跌破(空单=升破)这条线再让出缓冲,止盈=触到这条线(如布林上轨)。 */
export const indicator_level=define('indicator_level','stop','指标线当根值作为价位:入场回踩该线/止损跌破该线(可加 ATR 缓冲)/止盈触及该线',p=>Math.max(indicatorWarmup(String(p.indicator),rec(p,'args')),bufferWarmup(p)),(ctx,p)=>{
 const v=indicatorLine(String(p.indicator),ctx.bars,rec(p,'args'),p.output===undefined?undefined:String(p.output)).at(-1);
 if(v===undefined||!Number.isFinite(v))return {};
 const b=bufferOf(ctx,p);return {level:v,target:v,stop:isShort(ctx)?v+b:v-b};
});
/** 结构位:多单=下方最近未失效支撑块(入场取上沿、止损取下沿再让缓冲)+ 上方最近阻力块下沿止盈;空单镜像。块缺失时退回已确认 pivot。 */
export const structure_level=define('structure_level','stop','结构位:多单回踩下方支撑块上沿入场、跌破下沿止损、上方阻力块下沿止盈;空单镜像;缺块时用已确认 pivot',(p,base)=>(p.htf?Math.ceil(tfMs(p.htf)/(base??3600000)):1)*(2*n(p,'swing_length')+2)+bufferWarmup(p),(ctx,p)=>{
 const visible=ctx.bars,bars=p.htf&&tfMs(p.htf)!==ctx.timeframe_ms?completeBuckets(visible,ctx.timeframe_ms,tfMs(p.htf)):visible,price=last(ctx);
 if(bars.length<2*n(p,'swing_length')+1||!Number.isFinite(price))return {};
 const s=structure(bars,n(p,'swing_length'),String(p.confirmation??'close'),String(p.zone??'wick'));
 const support=s.blocks.filter(x=>!x.mitigated&&x.direction==='up'&&Number(x.upper)<price).sort((a,b)=>Number(b.upper)-Number(a.upper))[0];
 const resistance=s.blocks.filter(x=>!x.mitigated&&x.direction==='down'&&Number(x.lower)>price).sort((a,b)=>Number(a.lower)-Number(b.lower))[0];
 const pivotLow=s.pivots.filter(x=>x.kind==='low'&&Number(x.price)<price).at(-1),pivotHigh=s.pivots.filter(x=>x.kind==='high'&&Number(x.price)>price).at(-1);
 const sup=support?{near:Number(support.upper),far:Number(support.lower)}:pivotLow?{near:Number(pivotLow.price),far:Number(pivotLow.price)}:null;
 const res=resistance?{near:Number(resistance.lower),far:Number(resistance.upper)}:pivotHigh?{near:Number(pivotHigh.price),far:Number(pivotHigh.price)}:null;
 const b=bufferOf(ctx,p);
 if(isShort(ctx))return {...(res?{level:res.near,stop:res.far+b}:{}),...(sup?{target:sup.near}:{})};
 return {...(sup?{level:sup.near,stop:sup.far-b}:{}),...(res?{target:res.near}:{})};
});
/** 收盘价 ± N×ATR:入场=回撤 N×ATR 挂限价,止损=反向 N×ATR,止盈=顺向 N×ATR。 */
export const atr_offset_level=define('atr_offset_level','stop','收盘价偏移 N×ATR:多单入场/止损在下方、止盈在上方;空单镜像',p=>n(p,'atr_period')+1,(ctx,p)=>{
 const a=atr(ctx.bars,n(p,'atr_period'))*n(p,'multiple'),c=last(ctx);if(!Number.isFinite(a)||!Number.isFinite(c))return {};
 return isShort(ctx)?{level:c+a,stop:c+a,target:c-a}:{level:c-a,stop:c-a,target:c+a};
});
/** 收盘价 ± 固定比例(小数)。 */
export const pct_offset_level=define('pct_offset_level','stop','收盘价偏移固定比例:多单入场/止损在下方、止盈在上方;空单镜像',()=>1,(ctx,p)=>{
 const k=n(p,'pct'),c=last(ctx);if(!Number.isFinite(c)||!(k>0))return {};
 return isShort(ctx)?{level:c*(1+k),stop:c*(1+k),target:c*(1-k)}:{level:c*(1-k),stop:c*(1-k),target:c*(1+k)};
});
/** 图上结构止损/止盈(2026-09-23 结构口径的缺省,Jacky:「根据前高这种去判断顶和底给出 reasonable 的止盈点位和止损点位」)。
 * pivot 定义直接复用几何实验室 geometry-lab/core.ts 的 pivots()(左右各 L 根、最右等值为准、第 k+L 根收盘才确认),ATR 用 Wilder(14),
 * 视图取最近 lookback 根(缺省 480,= 几何实验室 View),同一段数据同一信号下与实验室的价位逐一对拍(test/demo/research/structure-exits.test.ts)。
 * 多空按 ctx.side 原生计算(做空取镜像一侧),不走 orders/ 的镜像 K 线。预热只要 pivot 与 ATR 够用,不因 lookback 拉长策略预热。 */
const lookbackOf=(p:Record<string,unknown>)=>Math.max(20,Math.min(5000,Number(p.lookback??480)));
const periodOf=(p:Record<string,unknown>)=>Number(p.atr_period??14);
const pivotWarmup=(p:Record<string,unknown>)=>Math.max(2*n(p,'swing_length')+2,periodOf(p)+1);
/** 止盈:做多取入场上方最近的已确认摆动高点(unswept 缺省 true:之后没有更高的高点扫过它),离收盘 [min_atr,max_atr]×ATR 内;
 * 找不到(创新高、上方没有结构、都太近或太远)就不给 target——止盈不设,持仓交给追踪止损。unswept=false、min_atr=1、max_atr=6 时与 arm A 目标同一规则。 */
export const pivot_target=define('pivot_target','exit','图上结构止盈:入场上方最近的未被扫的已确认摆动高点(1–6 ATR 内),没有就不设止盈、交给追踪止损;空单镜像取下方摆动低点',pivotWarmup,(ctx,p)=>{
 const view=ctx.bars.slice(-lookbackOf(p)),c=last(ctx),a=atrSeries(view,periodOf(p)).at(-1);
 if(a===undefined||!Number.isFinite(a)||!(a>0)||!Number.isFinite(c))return {};
 const short=isShort(ctx),kind=short?'low':'high',lo=Number(p.min_atr??1),hi=Number(p.max_atr??6),unswept=p.unswept!==false;
 // 后缀极值:第 k 根之后(不含 k)的最高高点/最低低点,判断 pivot 是否已被扫
 const after=new Array<number>(view.length+1).fill(short?Infinity:-Infinity);
 for(let k=view.length-1;k>=0;k--){const x=Number(view[k]![kind]);after[k]=short?Math.min(after[k+1]!,x):Math.max(after[k+1]!,x);}
 const xs=pivots(view,n(p,'swing_length'),n(p,'swing_length')).filter(x=>x.kind===kind&&(short?x.price<c:x.price>c)&&(!unswept||(short?after[x.index+1]!>=x.price:after[x.index+1]!<=x.price))).map(x=>x.price).filter(px=>{const d=Math.abs(px-c)/a;return d>=lo&&d<=hi;});
 if(!xs.length)return {};
 const t=short?Math.max(...xs):Math.min(...xs);return {target:t,level:t};
});
/** 止损:做多取收盘下方「最近一个」已确认摆动低点(pick=recent,按时间最近,即上一个更高低点;pick=nearest 取价格最近的,
 * 等于几何实验室 D 臂菜单的「1h swing low #1」),再往下让 buffer_atr×ATR(缺省 0.1,与几何实验室候选止损同缓冲);视图里没有就退回
 * 最近 fallback_lookback 根最低价减缓冲。离入场太近(<0.5 ATR)不在这里挪远——由 order_gate 的 min_stop_atr 判不做。空单镜像取上方摆动高点加缓冲。
 * 缺省用 recent 的依据(几何实验室冻结数据 200 个突破信号,零模型):nearest 常取到 480 根视图里价格恰在收盘下方一点的旧低点,
 * 止损中位 0.70 ATR、38% 的信号会因 <0.5 ATR 不做;recent 中位 3.3 ATR、0 笔被拒,吊灯管理下 +0.19R/笔(nearest +0.03R)。 */
export const pivot_stop=define('pivot_stop','stop','图上结构止损:收盘下方最近一个已确认摆动低点再让 0.1 ATR(无则最近 10 根最低价);空单镜像取上方摆动高点',pivotWarmup,(ctx,p)=>{
 const view=ctx.bars.slice(-lookbackOf(p)),c=last(ctx),a=atrSeries(view,periodOf(p)).at(-1);
 if(a===undefined||!Number.isFinite(a)||!(a>0)||!Number.isFinite(c))return {};
 const short=isShort(ctx),kind=short?'high':'low',buf=Number(p.buffer_atr??0.1)*a;
 const ps=pivots(view,n(p,'swing_length'),n(p,'swing_length')).filter(x=>x.kind===kind&&(short?x.price>c:x.price<c)),xs=ps.map(x=>x.price);
 let level=!xs.length?NaN:p.pick==='nearest'?(short?Math.min(...xs):Math.max(...xs)):ps.reduce((a,b)=>(b.index>=a.index?b:a)).price;
 if(!Number.isFinite(level)){const w=view.slice(-Number(p.fallback_lookback??10)).map(b=>Number(b[kind]));const x=short?Math.max(...w):Math.min(...w);if(short?x>c:x<c)level=x;}
 if(!Number.isFinite(level))return {};
 return {level,stop:short?level+buf:level-buf};
});
