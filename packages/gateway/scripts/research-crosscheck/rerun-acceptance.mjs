// Read-only source DB; all new evidence is written to the explicit output directory.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runReplay } from '../../dist/demo/research/engine.js';
import { budgetBrain, makeDecider } from '../../dist/demo/research/agent.js';
import { makeBrain } from '../../dist/demo/brain.js';
const [dbPath,prefix,out]=process.argv.slice(2);
if(!dbPath||!prefix||!out)throw Error('usage: source.sqlite run-prefix output-directory');
const db=new DatabaseSync(dbPath,{readOnly:true});
const row=db.prepare('SELECT * FROM research_runs WHERE id LIKE ?').get(`${prefix}%`);
if(!row)throw Error('run_not_found');
const manifest=JSON.parse(row.manifest_json),request={...manifest.request,idempotency_key:`round3-${randomUUID()}`};
const dataset=JSON.parse(db.prepare('SELECT json FROM research_datasets WHERE id=?').get(request.dataset_id).json);db.close();
mkdirSync(out,{recursive:true});writeFileSync(`${out}/request.json`,JSON.stringify(request,null,2));
const traces=[];const brain=budgetBrain(makeBrain(manifest.brain.kind,manifest.brain.model),{max_calls:request.max_model_calls,deadline:Date.now()+request.timeout_ms,model_call_timeout_ms:request.model_call_timeout_ms,cancelled:()=>false,save:t=>{traces[t.index-1]=t;writeFileSync(`${out}/model-calls.json`,JSON.stringify(traces));}});
const result=await runReplay(dataset,request,makeDecider(brain,request.execution,manifest.source_strategy,''),{diagnostics:true,event:(event,data)=>{if(event==='progress')console.log(JSON.stringify({event,...data}));}});
writeFileSync(`${out}/result.json`,JSON.stringify(result));
console.log(JSON.stringify({status:result.status,error:result.error,arms:result.arms.map(a=>({arm:a.arm,trades:a.trades.length,actions:a.decisions.reduce((counts,d)=>(counts[d.action]=(counts[d.action]??0)+1,counts),{})}))}));
