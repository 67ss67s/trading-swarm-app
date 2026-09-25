import type { StrategyJudge, JudgeStateV1 } from '@trading-swarm/contracts';
import { usdUnits, usdString } from './store.js';
const SCALE=1_000_000_000_000n;
export const LIVE_ONLY_FIELDS = ['features.ob_imbalance_05','features.ob_wall_up','features.ob_wall_down','features.spread_bps','features.liq_long_5m','features.liq_short_5m'] as const;
export const needsMicrostructure=(spec:StrategyJudge)=>spec.questions.some(q=>q.state_fields.some(f=>(LIVE_ONLY_FIELDS as readonly string[]).includes(f)));
export interface MicroBook { at:number; available_at:number; bids:readonly (readonly [string,string])[]; asks:readonly (readonly [string,string])[] }
export interface MicroLiquidation { id:string; at:number; available_at:number; position_side:'long'|'short'; price:string; quantity:string }
/** quantity 必须已换算为基础币数量；OKX 合约张数乘冻结 ctVal，不允许猜。 */
export interface MicrostructureSnapshot {
 symbol:string; book:MicroBook|null; liquidations:readonly MicroLiquidation[];
 /** 成功轮询/连续录制的证据，不能用第一/最后一条清算代替。 */
 liquidation_coverage:{from_ms:number;to_ms:number;available_at:number}|null;
}
export type MicrostructureSource=(symbol:string,as_of:number)=>Promise<MicrostructureSnapshot|null>;
const time=(v:number)=>Number.isSafeInteger(v)&&v>=0;
const decimal=(s:string)=>usdUnits(s);
const positive=(s:string)=>{const n=decimal(s);if(n<=0n)throw Error('micro_nonpositive');return n;};
export const baseQuantity=(contracts:string,base_per_contract:string)=>usdString(decimal(contracts)*positive(base_per_contract)/SCALE);
export function calculateMicrostructure(x:MicrostructureSnapshot,as_of:number):Partial<JudgeStateV1['features']> {
 if(!time(as_of))throw Error('micro_as_of_invalid');
 const out:Partial<JudgeStateV1['features']>={},b=x.book;
 if(b&&time(b.at)&&time(b.available_at)&&b.at<=as_of&&b.available_at<=as_of&&as_of-b.at<=120_000&&as_of-b.available_at<=120_000){
  const parse=(rows:MicroBook['bids'],side:'bid'|'ask')=>rows.map(([p,q],i)=>{const px=positive(p),qty=decimal(q);if(i&& (side==='bid'?px>=positive(rows[i-1]![0]):px<=positive(rows[i-1]![0])))throw Error('micro_book_order');return{price:p,px,notional:px*qty/SCALE};});
  const bids=parse(b.bids,'bid'),asks=parse(b.asks,'ask');
  if(!bids.length||!asks.length||bids[0]!.px>=asks[0]!.px)throw Error('micro_book_invalid');
  const twice_mid=bids[0]!.px+asks[0]!.px;
  const near=(rows:typeof bids)=>rows.filter(r=>(r.px*2n>twice_mid?r.px*2n-twice_mid:twice_mid-r.px*2n)*200n<=twice_mid);
  const bid=near(bids),ask=near(asks),sum=(rows:typeof bids)=>rows.reduce((s,r)=>s+r.notional,0n),bn=sum(bid),an=sum(ask);
  if(bn+an>0n)out.ob_imbalance_05=Number(bn-an)/Number(bn+an);
  const wall=(rows:typeof bids)=>{const r=rows.reduce<(typeof bids)[number]|null>((best,r)=>!best||r.notional>best.notional?r:best,null);return r?{price:r.price,notional:usdString(r.notional)}:undefined;};
  if(bid.length)out.ob_wall_down=wall(bid)!;if(ask.length)out.ob_wall_up=wall(ask)!;
  out.spread_bps=Number((asks[0]!.px-bids[0]!.px)*20000n)/Number(twice_mid);
 }
 const c=x.liquidation_coverage;
 if(c&&[c.from_ms,c.to_ms,c.available_at].every(time)&&c.from_ms<=as_of-300_000&&c.to_ms>=as_of&&c.available_at<=as_of){
  let long=0n,short=0n;const seen=new Set<string>();
  for(const l of x.liquidations){
   if(![l.at,l.available_at].every(time))throw Error('micro_liquidation_time');
   if(l.at<=as_of-300_000||l.at>as_of||l.available_at>as_of||seen.has(l.id))continue;seen.add(l.id);
   const n=positive(l.price)*decimal(l.quantity)/SCALE;
   if(l.position_side==='long')long+=n;else if(l.position_side==='short')short+=n;else throw Error('micro_liquidation_side');
  }
  out.liq_long_5m=usdString(long);out.liq_short_5m=usdString(short);
 }
 return out;
}
