#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
const args=process.argv.slice(2),opt=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
if(!args.includes('--child')){
 const child=spawnSync(process.execPath,['--experimental-transform-types','--no-warnings','--import',fileURLToPath(new URL('./register.mjs',import.meta.url)),fileURLToPath(import.meta.url),'--child',...args],{stdio:'inherit'});process.exit(child.status??1);
}
const gate=opt('gate','g1'),network=opt('network','deny'),profile=opt('profile','ci');
if(!['deny','allow'].includes(network)||!['ci','release'].includes(profile))throw Error('invalid_network_or_profile');
if(network==='deny')await import('./network-deny.mjs');
else if(!Number.isSafeInteger(Number(opt('max-calls','0')))||Number(opt('max-calls','0'))<1||!/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(opt('max-usd',''))||Number(opt('max-usd','0'))<=0||gate!=='g3'||opt('approved-by','')!=='Jacky'||!opt('connection-id','')||!opt('max-calls','')||!opt('max-usd',''))throw Error('paid_g3_requires_Jacky_approval_connection_and_budgets');
const output=(value)=>{const text=JSON.stringify(value,null,2)+'\n',path=opt('output','');if(path){const resolved=resolve(path),forbidden=resolve(homedir(),'.trade-gate-okx/demo');if(resolved===forbidden||resolved.startsWith(forbidden+'/'))throw Error('forbidden_runtime_directory');writeFileSync(resolved,text);}process.stdout.write(text);};
if(gate==='g1'){
 if(network!=='deny'||opt('provider','stub')!=='stub')throw Error('g1_offline_stubs_only');
 const {runG1}=await import('../../src/demo/research/study-eval/g1.ts');
 const adapterPath=opt('study-adapter',fileURLToPath(new URL('./matrix-adapter.ts',import.meta.url)));
 const {runStudy}=await import(pathToFileURL(resolve(adapterPath)).href);
 if(typeof runStudy!=='function')throw Error('g1_study_adapter_must_export_runStudy');
 const result=await runG1(runStudy,{profile,null_replicates:Number(opt('null-replicates',profile==='release'?'1000':'2')),positive_replicates:Number(opt('positive-replicates',profile==='release'?'100':'1')),fine_bars:Number(opt('fine-bars',String(96*(profile==='release'?3650:45)))),seed:Number(opt('seed','20260925'))},p=>process.stderr.write(JSON.stringify(p)+'\n'));output(result);if(result.status==='failed')process.exitCode=1;
}else if(gate==='g3'){
 const {G3_PROTOCOL,evaluateG3Recorded}=await import('../../src/demo/research/study-eval/g3.ts');
 const manifest=opt('manifest','');
 if(network==='deny')output(manifest?{gate:'g3',mode:'recorded',protocol:G3_PROTOCOL,results:evaluateG3Recorded(JSON.parse(readFileSync(manifest,'utf8')).finalists)}:{gate:'g3',status:'requires_approved_collection',network:'deny',protocol:G3_PROTOCOL});
 else{
  const module=opt('provider-adapter','');if(!module||!manifest)throw Error('g3_frozen_manifest_and_provider_adapter_required');
  const {collect}=await import(pathToFileURL(resolve(module)).href);const result=await collect({manifest:JSON.parse(readFileSync(manifest,'utf8')),connection_id:opt('connection-id',''),max_calls:Number(opt('max-calls','0')),max_usd:opt('max-usd','0'),protocol:G3_PROTOCOL});output(result);
 }
}else if(gate==='g4'||gate==='g5'){
 // 离线验证入口直接复用 vitest；network-deny 已封子进程，另用动态 vitest Node API。
 const {startVitest}=await import('vitest/node');
 if(gate==='g4'&&profile==='release')process.env.TG_G4_RELEASE='1';
 const filter=gate==='g4'?'test/demo/research/study/g4-replay.test.ts':'test/demo/research/study/g5-budget.test.ts';
 const ctx=await startVitest('test',[filter],{root:fileURLToPath(new URL('../../',import.meta.url)),watch:false,pool:'threads',maxWorkers:1,setupFiles:[fileURLToPath(new URL('./network-deny.mjs',import.meta.url))]});
 if(!ctx)throw Error('vitest_start_failed');await ctx.close();if(process.exitCode)throw Error('offline_gate_failed');
}else throw Error('unsupported_gate');
