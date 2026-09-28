/** 只读 SQLite adapter：只查研究表；不构造 ResearchStore/MarketCache（构造器会建表/迁移）。 */
import type { DatabaseSync } from 'node:sqlite';
import type { ResearchBar } from '@trade-gate/contracts';
import type { ExportSnapshot, ExportChoice, ExportData } from './g3-export.js';
const parse=(v:unknown)=>JSON.parse(String(v));
const has=(db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export function readExportSnapshot(db:DatabaseSync,study_id:string):ExportSnapshot{
 const r=db.prepare("SELECT manifest_json, json_extract(state_json,'$.cells') cells,json_extract(state_json,'$.data_lock') data_lock FROM research_matrix_studies WHERE id=?").get(study_id);if(!r)throw Error('matrix_study_not_found');
 // SQL 投影物理排除 finalist 的 holdout/test/passed/portfolio 与 release 表。
 const fs=db.prepare("SELECT json_extract(f.value,'$.id') id,json_extract(f.value,'$.trial_id') trial_id,json_extract(f.value,'$.cell_id') cell_id,json_extract(f.value,'$.ir') ir,json_extract(f.value,'$.selection') selection FROM research_matrix_studies s,json_each(s.state_json,'$.finalists') f WHERE s.id=?").all(study_id);
 const trials=db.prepare('SELECT trial_id,status,json_extract(candidate_json,\'$.variant\') variant FROM research_study_trials WHERE study_id=?').all(study_id);
 return{study_id,...(r.data_lock?{data_lock:parse(r.data_lock)}:{}),manifest:parse(r.manifest_json),cells:parse(r.cells),finalists:fs.map(f=>({id:String(f.id),trial_id:String(f.trial_id),cell_id:String(f.cell_id),ir:parse(f.ir),selection:parse(f.selection)})),trials:trials.map(t=>({trial_id:String(t.trial_id),status:String(t.status),variant:parse(t.variant)}))};
}
const stepOf=(tf:string)=>tf==='1d'?86400000:tf==='4h'?14400000:tf==='1h'?3600000:tf==='15m'?900000:NaN;
export function readExportData(db:DatabaseSync,c:ExportChoice,marketDb:DatabaseSync=db):ExportData{
 const sources=new Set<string>(),inst=c.ir.order?.market==='perp'?c.symbol.replace(/USDT$/,'-USDT-SWAP'):c.symbol,market=c.ir.order?.market??'spot';
 function bars(tf:string,kind:'trade'|'mark'):ResearchBar[]{
  const step=stepOf(tf),map=new Map<number,ResearchBar>();
  // 截止 selection.to_ms，绝不取留出 bar；重复缓存若同一时间价格冲突则拒绝。
  const add=(b:ResearchBar)=>{if(b.close_time>c.to_ms)return;const old=map.get(b.open_time);if(old&&['open','high','low','close','volume'].some(k=>Number(old[k as keyof ResearchBar])!==Number(b[k as keyof ResearchBar])))throw Error('g3_conflicting_cached_bars');map.set(b.open_time,b);};
  if(kind==='trade'&&has(db,'research_datasets')){
   const rows=db.prepare("SELECT d.id,b.value bar FROM research_datasets d,json_each(d.json,'$.bars') b WHERE json_extract(d.json,'$.market')=? AND json_extract(d.json,'$.symbol') IN (?,?) AND json_extract(d.json,'$.timeframe_ms')=? AND json_extract(b.value,'$.close_time')<=? AND (? IS NULL OR d.id=?) ORDER BY d.id,json_extract(b.value,'$.open_time')").all(market,inst,c.symbol,step,c.to_ms,tf===c.timeframe?c.dataset_id??null:null,tf===c.timeframe?c.dataset_id??null:null);
   for(const row of rows){sources.add(`research_datasets:${row.id}`);add(parse(row.bar));}
  }
  if(has(marketDb,'candles')){
   const rows=marketDb.prepare('SELECT open_time,o,h,l,c,v FROM candles WHERE inst=? AND kind=? AND tf=? AND open_time+?<=? ORDER BY open_time').all(inst,kind,tf,step,c.to_ms+1);
   if(rows.length)sources.add(`candles:${inst}:${kind}:${tf}`);
   for(const b of rows){const at=Number(b.open_time),decimal=(v:unknown)=>Number(v).toFixed(12).replace(/\.?0+$/,'')||'0';add({open_time:at,close_time:at+step-1,available_at:at+step-1,open:decimal(b.o),high:decimal(b.h),low:decimal(b.l),close:decimal(b.c),volume:decimal(b.v)});}
  }
  return [...map.values()].sort((a,b)=>a.open_time-b.open_time);
 }
 const main=bars(c.timeframe,'trade'),trend_1h=bars('1h','trade'),trend_4h=bars('4h','trade'),mark=bars(c.timeframe,'mark');
 let funding:ExportData['funding']=null;const tiers:ExportData['tiers']=[];
 if(has(marketDb,'funding')){
  const points=marketDb.prepare("SELECT ts,rate,source FROM funding WHERE inst=? AND source='okx' AND ts BETWEEN ? AND ? ORDER BY ts").all(inst,c.from_ms-8*3600000,c.to_ms).map(p=>({ts:Number(p.ts),rate:Number(p.rate),source:String(p.source)}));
  // 缓存点之间超过8h即缺数据；不把缺失期当零，不隐式使用代理资金费。
  if(points.length>1&&points.every((p,i)=>!i||p.ts-points[i-1]!.ts<=8*3600000)){funding={points,from_ms:points[0]!.ts,to_ms:points.at(-1)!.ts};sources.add(`funding:${inst}:okx`);}
 }
 if(has(marketDb,'meta')){
  const instrument=marketDb.prepare('SELECT json FROM meta WHERE key=?').get(`instrument:${inst}`),raw=marketDb.prepare('SELECT json FROM meta WHERE key=?').get(`position_tiers:${inst.replace(/-SWAP$/,'')}:isolated`);
  if(instrument&&raw){const ins=parse(instrument.json),rows=parse(raw.json);const unit=Number(ins.ctVal)*Number(ins.ctMult||1);
   for(const row of rows){const max_qty=Number(row.maxSz)*unit,mmr=Number(row.mmr);if(max_qty>0&&mmr>0)tiers.push({max_qty,mmr});}tiers.sort((a,b)=>a.max_qty-b.max_qty);sources.add(`meta:${inst}:current_tiers_not_historical`);
  }
 }
 return{bars:main,trend_1h,trend_4h,mark,funding,tiers,source_ids:[...sources].sort()};
}
