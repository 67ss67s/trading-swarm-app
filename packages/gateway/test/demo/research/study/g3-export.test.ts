import {it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {seedG3ExportFixture} from '../../../../src/demo/research/study-eval/g3-export-fixture.js';
import {exportManifest,exportOutcomes,selectExportChoices,uniformTimeSample} from '../../../../src/demo/research/study-eval/g3-export.js';
import {readExportSnapshot,readExportData} from '../../../../src/demo/research/study-eval/g3-export-db.js';
import {collectG3,validateCollectionManifest} from '../../../../src/demo/research/study-eval/g3-collect.js';
import {analyzeG3} from '../../../../src/demo/research/study-eval/g3-analyze.js';
import {openStateDb} from '../../../../src/state-db.js';
import {hash} from '../../../../src/demo/research/primitives.js';
function setup(){const db=new DatabaseSync(':memory:');seedG3ExportFixture(db);const s=readExportSnapshot(db,'g3_fixture'),choices=selectExportChoices(s).choices,data=Object.fromEntries(choices.map(c=>[c.id,readExportData(db,c)]));return{db,s,data};}
it('SQLite→manifest→条件执行→stub→analyze，续跑不重计；冻结成本、hash、跨日盯市',async()=>{
 const {db,s,data}=setup(),ledger=openStateDb(':memory:');try{
 const m=exportManifest(s,data,{frozen_at:Date.UTC(2026,8,25),synthetic:true});validateCollectionManifest(m);expect(m.finalists[0]!.opportunities.length).toBeGreaterThan(5);
 const out=exportOutcomes(m,data);expect(out.unavailable).toEqual([]);expect(out.finalists.fixture_trial!.some(o=>o.status==='filled')).toBe(true);
 const c=await collectG3(m,ledger.db,{stub:true,max_usd:'2',max_calls:1000}),again=await collectG3(m,ledger.db,{stub:true,max_usd:'2',max_calls:1000});
 expect(again.budget).toEqual(c.budget);expect(c.budget.calls).toBe(m.export_audit.sampling.estimated_calls);expect(Number(m.export_audit.sampling.cost_upper_usd)).toBeLessThanOrEqual(2);
 const a=analyzeG3(m,c,out);expect(a.results[0]!.status).toBe('insufficient_evidence');expect(a.records).toHaveLength(1);
 const altered=structuredClone(data);altered.fixture_trial!.bars[350]!.close='999';expect(()=>exportOutcomes(m,altered)).toThrow('data_changed');
 const bad=structuredClone(out);const filled=bad.finalists.fixture_trial!.find(o=>o.status==='filled'&&o.marks.length>1);expect(filled).toBeTruthy();if(filled&&filled.status!=='not_filled'){filled.marks.shift();expect(()=>analyzeG3(m,c,bad)).toThrow('daily_mtm_missing');}
 }finally{db.close();ledger.close();}
});
it('选择排除 fail/ineligible，finalist 优先且不看 holdout，时间抽样不看结果',()=>{
 const {db,s}=setup();try{
 s.cells.bad={...s.cells.fixture_cell!,cell_id:'bad',verdict:'fail',selection:{...s.cells.fixture_cell!.selection!,sharpe:999}};
 expect(selectExportChoices(s).choices.map(c=>c.id)).toEqual(['fixture_trial']);
 s.finalists=[{id:'final',trial_id:'fixture_trial',cell_id:'fixture_cell',ir:s.trials[0]!.variant.ir,selection:s.cells.fixture_cell!.selection!}];expect(selectExportChoices(s).choices[0]!.id).toBe('final');
 const rows=[0,1,2,3,10,20,90,100].map((as_of,i)=>({candidate:{as_of,id:String(i)},outcome:Math.random()}));expect(uniformTimeSample(rows,3).map(x=>x.candidate.as_of)).toEqual([0,20,100]);expect(uniformTimeSample(rows.map(x=>({...x,outcome:-99})),3).map(x=>x.candidate.id)).toEqual(uniformTimeSample(rows,3).map(x=>x.candidate.id));
 }finally{db.close();}
});
it('预算按两模型上界抽样；缺状态不伪造不收费，缺执行不伪造空仓收益',async()=>{
 const {db,s,data}=setup(),ledger=openStateDb(':memory:');try{
 const m=exportManifest(s,data,{frozen_at:Date.UTC(2026,8,25),synthetic:true,max_usd:'0.0103'});expect(m.export_audit.sampling.after).toEqual([2]);expect(m.export_audit.sampling.cost_upper_usd).toBe('0.0103');
 m.finalists[0]!.opportunities[0]!.state=null;m.finalists[0]!.opportunities[0]!.unavailable_reason='judge_field_unavailable';
 const c=await collectG3(m,ledger.db,{stub:true,max_usd:'2',max_calls:100});expect(c.budget.calls).toBe(2);
 const o=exportOutcomes(m,data),first=o.finalists.fixture_trial!.shift()!;o.unavailable.push({finalist_id:'fixture_trial',candidate_id:first.candidate_id,reason:'funding_missing'});o.manifest_hash=hash(m);
 const a=analyzeG3(m,c,o);expect(a.accounts).toEqual([]);expect(a.results[0]).toMatchObject({status:'insufficient_evidence',evidence:'execution_data_unavailable'});
 }finally{db.close();ledger.close();}
});
it('stub 可以验证真实 manifest，但不能用同一账本转真跑',async()=>{
 const {db,s,data}=setup(),ledger=openStateDb(':memory:');try{const m=exportManifest(s,data,{frozen_at:Date.UTC(2026,8,25)});const c=await collectG3(m,ledger.db,{stub:true,max_usd:'2',max_calls:1000});expect(c.synthetic).toBe(true);await expect(collectG3(m,ledger.db,{stub:false,max_usd:'2',max_calls:1000})).rejects.toThrow('ledger_mode_changed');}finally{db.close();ledger.close();}
});
it('永续真实条件核包含资金费、手续费和滑点；缺标记价不可评，不拿成交价冒充',()=>{
 const {db,s,data}=setup();try{
 s.manifest.spec.market='perp';s.trials[0]!.variant.ir.order!.market='perp';const d=data.fixture_trial!;d.mark=structuredClone(d.bars);d.tiers=[{max_qty:1000000,mmr:0.004}];
 const lo=d.bars[0]!.open_time,hi=d.bars.at(-1)!.close_time;d.funding={from_ms:lo,to_ms:hi,points:Array.from({length:Math.floor((hi-lo)/28800000)+1},(_,i)=>({ts:lo+i*28800000,rate:0.0001,source:'synthetic'}))};
 const m=exportManifest(s,data,{frozen_at:Date.UTC(2026,8,25),synthetic:true}),out=exportOutcomes(m,data);expect(out.unavailable).toEqual([]);const audits=Object.values(out.execution_audit) as {fees_usd:string;funding_usd:string;slippage_bps:string}[];expect(audits.some(a=>Number(a.fees_usd)>0&&Number(a.funding_usd)!==0)).toBe(true);expect(audits.every(a=>a.slippage_bps==='5')).toBe(true);
 d.mark=[];const missing=exportManifest(s,data,{frozen_at:Date.UTC(2026,8,25),synthetic:true});expect(exportOutcomes(missing,data).unavailable.length).toBe(missing.finalists[0]!.opportunities.length);
 }finally{db.close();}
});
it('缓存查询只投影开发截止前 bars，篡改留出价格不会改变 manifest',()=>{
 const {db,s,data}=setup();try{
 const m=exportManifest(s,data,{frozen_at:Date.UTC(2026,8,25),synthetic:true});const row=db.prepare('SELECT json FROM research_datasets WHERE id=?').get('synthetic_14400000')!;const ds=JSON.parse(String(row.json));ds.bars.at(-1).close='999999';db.prepare('UPDATE research_datasets SET json=? WHERE id=?').run(JSON.stringify(ds),'synthetic_14400000');
 const c=selectExportChoices(s).choices[0]!,d=readExportData(db,c);expect(hash(exportManifest(s,{[c.id]:d},{frozen_at:m.frozen_at,synthetic:true}))).toBe(hash(m));
 }finally{db.close();}
});
