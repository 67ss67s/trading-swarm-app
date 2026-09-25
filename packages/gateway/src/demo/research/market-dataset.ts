import {CcxtMarket,publicExchange} from './market-ccxt.js';
import type { ResearchDataset } from '@trading-swarm/contracts';
import { fetchKlines, marketExchange, tfToMs } from '../market.js';
import type { ResearchStore } from './store.js';
export interface MarketDatasetInput {exchange?:unknown;symbol?:unknown;timeframe?:unknown;from_ms?:unknown;to_ms?:unknown}
/** Shared with the existing from-market endpoint. Uses only its public spot market path. */
export async function importMarketDataset(store:ResearchStore,b:MarketDatasetInput,allowGaps=false,provider?:{exchange:string;fetchKlines:(symbol:string,tf:string,limit:number,end?:number,market?:'spot')=>ReturnType<typeof fetchKlines>}):Promise<{id:string;bars:number;symbol:string;timeframe:string;first_at:number;last_at:number}> {
  if(b.exchange!==undefined&&!provider){const exchange=String(b.exchange),client=await publicExchange(exchange);try{const adapter=new CcxtMarket(exchange,client);return await importMarketDataset(store,b,allowGaps,{exchange,fetchKlines:adapter.fetchKlines.bind(adapter)});}finally{await client.close?.();}}
  const symbol=String(b.symbol??'').toUpperCase();if(!/^[A-Z0-9]{5,20}$/.test(symbol))throw new Error('symbol_required');
  const tf=String(b.timeframe??'1h');
  if(!['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d'].includes(tf))throw new Error('timeframe_invalid');
  const step=tfToMs(tf),now=Date.now(),to=Math.min(Number(b.to_ms??now),now),from=Number(b.from_ms??to-500*step);
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from)throw new Error('range_invalid');
  const want=Math.floor((to-from)/step)+2;if(want>50000)throw new Error('range_exceeds_50000_bars');
  const venue=provider?.exchange??marketExchange(),retrieved_at=Date.now(),raw=await (provider?.fetchKlines??fetchKlines)(symbol,tf,want,to,'spot');
  const bars=raw.filter(k=>k.open_time>=from-step&&k.close_time<=to&&k.close_time<retrieved_at&&k.open_time+step-1<=to&&k.open_time+step-1<retrieved_at).map(k=>({open_time:k.open_time,close_time:k.open_time+step-1,available_at:k.open_time+step-1,open:k.open,high:k.high,low:k.low,close:k.close,volume:k.volume}));
  if(bars.length<10)throw new Error('too_few_bars');
  const d:ResearchDataset={venue,market:'spot',symbol,timeframe_ms:step,source:`${venue}:spot:${tf}:market/candles+history-candles`,retrieved_at,bars};
  const put=store.putMarketDataset(d,allowGaps);
  return {...put,symbol,timeframe:tf,first_at:bars[0]!.close_time,last_at:bars.at(-1)!.close_time};
}
