#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,openSync,closeSync,unlinkSync } from 'node:fs';
import { resolve,dirname,join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const args=process.argv.slice(2),opt=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
if(!args.includes('--child')){const child=spawnSync(process.execPath,['--experimental-transform-types','--no-warnings','--import',fileURLToPath(new URL('./register.mjs',import.meta.url)),fileURLToPath(import.meta.url),'--child',...args],{stdio:'inherit'});process.exit(child.status??1);}
const network=opt('network','deny'),mode=opt('mode','rehearse');
if(!['deny','allow'].includes(network))throw Error('g3_network_invalid');
if(network==='deny')await import('./network-deny.mjs');
else if(mode!=='collect'||opt('approved-by','')!=='Jacky'||!opt('max-usd','')||!opt('max-calls','')||args.includes('--stub'))throw Error('g3_paid_collection_requires_explicit_budget_and_Jacky');
const forbidden=resolve(homedir(),'.trade-gate-okx/demo'),repo=fileURLToPath(new URL('../../../../',import.meta.url));
function pathOf(s,db=false){if(!s)throw Error('g3_path_required');const p=resolve(s);let ancestor=p;while(!existsSync(ancestor))ancestor=dirname(ancestor);const resolved=join(realpathSync(ancestor),p.slice(ancestor.length));if(resolved===forbidden||resolved.startsWith(forbidden+'/'))throw Error('forbidden_runtime_directory');if(db&&(resolved===repo.slice(0,-1)||resolved.startsWith(repo)))throw Error('database_must_be_outside_repository');return p;}
const read=p=>JSON.parse(readFileSync(pathOf(p),'utf8'));
const write=(p,value)=>{p=pathOf(p);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify(value,null,2)+'\n',{mode:0o600});};
const {collectG3,environmentG3Clients,validateCollectionManifest}=await import('../../src/demo/research/study-eval/g3-collect.ts');
const {analyzeG3}=await import('../../src/demo/research/study-eval/g3-analyze.ts');
const {openStateDb}=await import('../../src/state-db.ts');
async function collect(manifest,dbPath,stub){
 const max_usd=opt('max-usd','2'),max_calls=Number(opt('max-calls','12000'));
 if(!Number.isSafeInteger(max_calls)||max_calls<1||!Number.isFinite(Number(max_usd))||Number(max_usd)<=0||Number(max_usd)>2)throw Error('g3_budget_must_be_positive_and_at_most_2_usd');
 if(network==='deny'&&!stub)throw Error('g3_live_requires_network_allow');
 validateCollectionManifest(manifest);dbPath=pathOf(dbPath,true);mkdirSync(dirname(dbPath),{recursive:true});
 const lock=dbPath+'.lock';
 if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));if(!Number.isSafeInteger(pid)||pid<1)throw Error('g3_lock_invalid');try{process.kill(pid,0);throw Error('g3_worker_active');}catch(e){if(e.code!=='ESRCH')throw e;}unlinkSync(lock);}
 const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);
 let state;
 try{state=openStateDb(dbPath);return await collectG3(manifest,state.db,{max_usd,max_calls,stub,recover_interrupted:true,...(!stub?{clients:environmentG3Clients(manifest)}:{})});}
 finally{state?.close();unlinkSync(lock);}
}
if(mode==='rehearse'){
 if(network!=='deny')throw Error('g3_rehearsal_offline');const dir=pathOf(opt('out-dir','/tmp/jev-g3-rehearsal'));
 const {g3OfflineFixture}=await import('../../src/demo/research/study-eval/g3-fixture.ts');const {manifest,outcomes}=g3OfflineFixture();
 write(join(dir,'manifest.json'),manifest);write(join(dir,'outcomes.json'),outcomes);
 const recorded=await collect(manifest,join(dir,'ledger.sqlite'),true);write(join(dir,'collection.json'),recorded);
 const resumed=await collect(manifest,join(dir,'ledger.sqlite'),true);if(resumed.budget.calls!==recorded.budget.calls)throw Error('g3_resume_double_charged');
 const analysis=analyzeG3(manifest,resumed,outcomes);write(join(dir,'analysis.json'),analysis);
 process.stdout.write(JSON.stringify({mode,output:dir,calls:recorded.budget.calls,resume_calls:resumed.budget.calls,budget:recorded.budget,results:analysis.results})+'\n');
}else if(mode==='collect'){
 const result=await collect(read(opt('manifest','')),opt('db',''),args.includes('--stub'));write(opt('output',''),result);process.stdout.write(JSON.stringify({complete:result.complete,synthetic:result.synthetic,budget:result.budget})+'\n');
}else if(mode==='analyze'){
 if(network!=='deny')throw Error('g3_analysis_offline');const result=analyzeG3(read(opt('manifest','')),read(opt('collection','')),read(opt('outcomes','')));write(opt('output',''),result);process.stdout.write(JSON.stringify({results:result.results})+'\n');
}else throw Error('g3_mode_invalid');
