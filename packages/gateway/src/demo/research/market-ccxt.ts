/** Public OHLCV only: no credentials, account APIs or execution transport. */
import type {ResearchAsset,ResearchUniverseRequest} from '@trading-swarm/contracts';
import type {Kline} from '../types.js';
import {timeframeMillis} from './strategy.js';
export interface PublicMarket {symbol:string;base:string;quote:string;spot?:boolean;active?:boolean}
export interface PublicExchange {loadMarkets():Promise<Record<string,PublicMarket>>;fetchOHLCV(symbol:string,timeframe:string,since?:number,limit?:number):Promise<(number|undefined)[][]>;close?():Promise<void>}
export async function publicExchange(exchange='okx'):Promise<PublicExchange>{
 if(!/^[a-z][a-z0-9_]{1,40}$/.test(exchange))throw Error('invalid_exchange');
 // Dynamic package resolution allows an explicit dependency-unavailable error in offline deployments.
 const packageName='ccxt';let ccxt:Record<string,unknown>;try{ccxt=(await import(packageName)).default as Record<string,unknown>;}catch{throw Error('ccxt_dependency_unavailable: install gateway dependencies');}
 const Constructor=ccxt[exchange] as (new(options:unknown)=>PublicExchange)|undefined;if(typeof Constructor!=='function')throw Error('unsupported_exchange');// 2026-09-21:这台机的 OKX 直连被墙,ccxt 的 Node fetch 不读环境变量代理,显式喂 HTTPS_PROXY/HTTP_PROXY。
 const proxy=process.env['HTTPS_PROXY']??process.env['https_proxy']??process.env['HTTP_PROXY']??process.env['http_proxy'];
 return new Constructor({enableRateLimit:true,timeout:30000,options:{defaultType:'spot'},...(proxy?{httpsProxy:proxy}:{})});
}
export class CcxtMarket {
 constructor(readonly exchange:string,readonly client:PublicExchange){}
 async markets(quote='USDT'){if(!/^[A-Z0-9]{2,15}$/.test(quote))throw Error('invalid_quote');return Object.values(await this.client.loadMarkets()).filter(m=>m.spot===true&&m.active!==false&&m.quote===quote).sort((a,b)=>a.symbol.localeCompare(b.symbol));}
 async fetchKlines(symbol:string,tf:string,limit:number,end=Date.now(),_market:'spot'='spot'):Promise<Kline[]>{
  if(!Number.isInteger(limit)||limit<1||limit>50000||!Number.isSafeInteger(end))throw Error('invalid_candle_range');const step=timeframeMillis(tf),from=Math.max(0,end-(limit+1)*step),markets=await this.client.loadMarkets(),market=Object.values(markets).find(m=>m.spot===true&&(m.symbol===symbol||m.base+m.quote===symbol));if(!market)throw Error('spot_symbol_not_found');
  const rows=new Map<number,Kline>();let cursor=from;
  for(let page=0;page<Math.ceil(limit/100)+10&&cursor<=end;page++){
   const batch=await this.client.fetchOHLCV(market.symbol,tf,cursor,100);if(!batch.length)break;let max=cursor-1;
   for(const row of batch){if(row.length<6||row.slice(0,6).some(x=>typeof x!=='number'||!Number.isFinite(x)))continue;const [at,o,h,l,c,v]=row as [number,number,number,number,number,number];max=Math.max(max,at);if(at<from||at+step-1>end||at+step>Date.now())continue;rows.set(at,{open_time:at,close_time:at+step-1,open:o.toFixed(8),high:h.toFixed(8),low:l.toFixed(8),close:c.toFixed(8),volume:v.toFixed(8)});}
   if(max<cursor)break;cursor=max+step;
  }
  return [...rows.values()].sort((a,b)=>a.open_time-b.open_time).slice(-limit);
 }
 async assets(quote='USDT',as_of=Date.now()):Promise<{items:ResearchAsset[];as_of:number;note:string}>{
  if(!Number.isSafeInteger(as_of)||as_of<30*86400000)throw Error('invalid_asset_as_of');const items:ResearchAsset[]=[];
  for(const m of await this.markets(quote)){
   try{const first=await this.client.fetchOHLCV(m.symbol,'1d',0,1),firstAt=first[0]?.[0];const candles=await this.fetchKlines(m.symbol,'1d',31,as_of);const recent=candles.filter(b=>b.open_time>=as_of-30*86400000&&b.close_time<=as_of);
    items.push({symbol:m.base+m.quote,exchange:this.exchange,ccxt_symbol:m.symbol,quote:m.quote,first_available_at:typeof firstAt==='number'&&firstAt<=as_of?firstAt:null,quote_volume_30d:recent.reduce((a,b)=>a+Number(b.close)*Number(b.volume),0).toFixed(8),volume_bars:recent.length,status:'ok'});
   }catch(e){items.push({symbol:m.base+m.quote,exchange:this.exchange,ccxt_symbol:m.symbol,quote:m.quote,first_available_at:null,quote_volume_30d:null,volume_bars:0,status:'unavailable',note:e instanceof Error?e.message:String(e)});}
  }
  return {items,as_of,note:'当前公开现货市场目录，不含已下市资产；first_available_at 是该 API since=0 返回的首根，不保证真实上市日。30天成交额为已收盘日线 close×base volume 估计，缺历史时不补造；历史选池使用窗口起点以前数据，仍有当前目录幸存者偏差。'};
 }
}
export function selectAssets(items:ResearchAsset[],filter:NonNullable<ResearchUniverseRequest['filter']>,limit=500){
 const chosen=items.filter(a=>a.status==='ok'&&a.quote===filter.quote&&!filter.exclude.includes(a.symbol)&&a.first_available_at!==null&&a.first_available_at<=filter.listed_before_ms&&a.quote_volume_30d!==null&&a.volume_bars>=29&&Number(a.quote_volume_30d)>=Number(filter.min_quote_volume_30d)).sort((a,b)=>Number(b.quote_volume_30d)-Number(a.quote_volume_30d)||a.symbol.localeCompare(b.symbol));
 return {items:chosen.slice(0,limit),note:chosen.length>limit?`符合 ${chosen.length} 个，按窗口起点前 30 天成交额截断至 ${limit}`:`符合 ${chosen.length} 个；首根与成交额缺失或不足29根日线的成员不入选`};
}

export async function fetchKlines(symbol:string,tf:string,limit:number,end=Date.now(),market:'spot'='spot',exchange='okx'):Promise<Kline[]>{const client=await publicExchange(exchange);try{return await new CcxtMarket(exchange,client).fetchKlines(symbol,tf,limit,end,market);}finally{await client.close?.();}}
