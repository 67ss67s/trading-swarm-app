import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, constants } from 'node:zlib';
import { baseQuantity, type MicrostructureSnapshot, type MicrostructureSource } from './microstructure.js';
/** gzip 流尚未 close：Z_SYNC_FLUSH 接受完整前缀，末尾半行丢弃；损坏流仍报错。 */
export function readRecordingLines(bytes:Uint8Array):Record<string,unknown>[] {
 const text=gunzipSync(bytes,{finishFlush:constants.Z_SYNC_FLUSH}).toString('utf8');
 return text.slice(0,text.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);
}
export interface RecordingOptions {
 directory:string;
 /** 冻结的线性 USDT 合约基础币/张，未指定的资产不可评。 */
 instruments:Record<string,{inst_id:string;base_per_contract:string}>;
 /** 旧格式at是整个循环开始；必须是整个循环的可靠耗时上界，缺失则不评旧帧。 */
 availability_lag_bound_ms?:number;
 /** 只有采集器成功轮询记录可提供，不允许由事件首末时间推断。 */
 coverage?:(symbol:string,as_of:number)=>MicrostructureSnapshot['liquidation_coverage'];
}
export function recordingMicrostructure(opts:RecordingOptions):MicrostructureSource {
 return async(symbol,as_of)=>{
  const instrument=opts.instruments[symbol];if(!instrument)return null;
  const dates=new Set([as_of,as_of-300_000].map(t=>new Date(t).toISOString().slice(0,10)));
  const files=(await readdir(opts.directory)).filter(n=>['book','liq'].some(k=>n.startsWith(`${k}-${instrument.inst_id}-`))&&[...dates].some(d=>n.includes(d))&&n.endsWith('.jsonl.gz')).sort();
  const out:MicrostructureSnapshot={symbol,book:null,liquidations:[],liquidation_coverage:opts.coverage?.(symbol,as_of)??null};
  const events:MicrostructureSnapshot['liquidations'][number][]=[];
  for(const name of files)for(const r of readRecordingLines(await readFile(join(opts.directory,name)))){
   const at=Number(r.ts),available_at=typeof r.available_at==='number' ? r.available_at : opts.availability_lag_bound_ms !== undefined && Number.isSafeInteger(opts.availability_lag_bound_ms) && opts.availability_lag_bound_ms>=0 ? Math.max(Number(r.at)+opts.availability_lag_bound_ms,at) : Infinity; // 旧 recorder 的 at 是请求发出时刻；至少不能早于交易所时刻。
   if(!Number.isSafeInteger(at)||!Number.isSafeInteger(available_at)||available_at>as_of||at>as_of)continue;
   if(name.startsWith('book-')&&as_of-at<=120_000&&(!out.book||at>out.book.at)){
    const levels=(v:unknown)=>(v as [string,string][]).map(([p,q])=>[p,baseQuantity(q,instrument.base_per_contract)] as const);
    out.book={at,available_at,bids:levels(r.bids),asks:levels(r.asks)};
   }else if(name.startsWith('liq-')&&at>as_of-300_000){
    if(r.posSide!=='long'&&r.posSide!=='short')continue;
    events.push({id:`${instrument.inst_id}:${at}:${r.posSide}:${r.px}:${r.sz}`,at,available_at,position_side:r.posSide,price:String(r.px),quantity:baseQuantity(String(r.sz),instrument.base_per_contract)});
   }
  }
  out.liquidations=events;return out;
 };
}
