import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
export async function run(mode){
 const args=process.argv.slice(2),opt=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
 if(!args.includes('--child')){const c=spawnSync(process.execPath,['--experimental-transform-types','--no-warnings','--import',fileURLToPath(new URL('./register.mjs',import.meta.url)),process.argv[1],'--child',...args],{stdio:'inherit'});process.exit(c.status??1);}
 if(opt('network','deny')!=='deny')throw Error('g3_export_offline_only');await import('./network-deny.mjs');
 const forbidden=resolve(homedir(),'.trade-gate-okx/demo'),repo=fileURLToPath(new URL('../../../../',import.meta.url));
 const path=(v,database=false)=>{if(!v)throw Error('g3_path_required');const p=resolve(v);let a=p;while(!existsSync(a))a=dirname(a);const real=join(realpathSync(a),p.slice(a.length));if(real===forbidden||real.startsWith(forbidden+'/'))throw Error('forbidden_runtime_directory');if(database&&(real===repo.slice(0,-1)||real.startsWith(repo)))throw Error('database_must_be_outside_repository');return p;};
 const dbPath=path(opt('db'),true),output=path(opt('output'));if(existsSync(output))throw Error('g3_output_exists_use_new_path');
 const src=fileURLToPath(new URL('../../src/demo/research/',import.meta.url));
 const codeFiles=readdirSync(src,{recursive:true}).filter(f=>typeof f==='string'&&f.endsWith('.ts')).sort();
 const codeHash=createHash('sha256');for(const f of codeFiles){codeHash.update(f);codeHash.update(readFileSync(join(src,f)));}const execution_code_hash=codeHash.digest('hex');
 const {readExportSnapshot,readExportData}=await import('../../src/demo/research/study-eval/g3-export-db.ts');
 const {selectExportChoices,exportManifest,exportOutcomes}=await import('../../src/demo/research/study-eval/g3-export.ts');
 const db=new DatabaseSync(dbPath,{readOnly:true}),marketPath=opt('market-db'),market=marketPath?new DatabaseSync(path(marketPath,true),{readOnly:true}):db;
 db.exec('PRAGMA query_only=ON; BEGIN');if(market!==db)market.exec('PRAGMA query_only=ON; BEGIN');
 try{
  let value;
  if(mode==='manifest'){
   const snapshot=readExportSnapshot(db,opt('study-id')),choices=selectExportChoices(snapshot).choices,data=Object.fromEntries(choices.map(c=>[c.id,readExportData(db,c,market)]));
   value=exportManifest(snapshot,data,{frozen_at:Number(opt('frozen-at',Date.now())),synthetic:args.includes('--synthetic-fixture'),max_usd:opt('max-usd','2')});
   value.export_audit.execution_code_hash=execution_code_hash;
  }else{
   const manifest=JSON.parse(readFileSync(path(opt('manifest')),'utf8'));if(!manifest.export_audit)throw Error('g3_export_manifest_required');
   if(manifest.export_audit.execution_code_hash!==execution_code_hash)throw Error('g3_execution_source_changed_reexport_required');
   if(opt('study-id')&&opt('study-id')!==manifest.export_audit.study_id)throw Error('g3_study_mismatch');
   const data=Object.fromEntries(manifest.export_audit.choices.map(c=>[c.id,readExportData(db,c,market)]));value=exportOutcomes(manifest,data);
  }
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({output,...(mode==='manifest'?{sampling:value.export_audit.sampling,unavailable:value.export_audit.unavailable.length}:{outcomes:Object.values(value.finalists).reduce((n,x)=>n+x.length,0),unavailable:value.unavailable.length})}));
 }finally{if(market!==db)market.close();db.close();}
}
