import { spawn, execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, join, extname } from 'node:path';
import { homedir } from 'node:os';
import type { ResearchStore } from './store.js';

export const SANDBOX_README=`# 研究数据\nrun.json: 冻结 manifest 与各臂 metrics。dataset.json: OHLCV，价格/数量为十进制字符串，时间为 unix 毫秒。arms/<arm>/: trades.json（成交与净盈亏）、decisions.json（收盘决策）、equity.json（逐根盯市）。资产池 datasets/ 保存每个成员。\n脚本必须为 .mjs，允许 node:fs/path/url/util/assert/buffer，不能联网、创建子进程、加载外部包。用 console.log 输出验证摘要。chart JSON: {kind:'chart',type:'line'|'bar'|'scatter',title,x:'time'|'category',series:[{name,points:[[x,y]]}],y_label,note}；table JSON: {kind:'table',columns:[],rows:[]}；Markdown 用 .md。先执行验证再注册产物；数字必须有执行证据。\n`;
const bootstrap=`import {registerHooks} from 'node:module';
const memoryBudget=128*1024*1024;let allocated=0;const charge=n=>{if(!Number.isSafeInteger(n)||n<0||n>memoryBudget-allocated)throw Error('sandbox_memory_limit');allocated+=n;};
const NativeArrayBuffer=ArrayBuffer;globalThis.ArrayBuffer=new Proxy(NativeArrayBuffer,{construct(t,args){charge(Number(args[0]));return Reflect.construct(t,args);}});
for(const name of ['alloc','allocUnsafe','allocUnsafeSlow']){const original=Buffer[name];Buffer[name]=function(size,...args){charge(size);return original(size,...args);};}
const allowed=new Set(['fs','fs/promises','path','url','util','assert','assert/strict','buffer']);
const root=new URL('./',import.meta.url).href;
for(const key of Object.keys(process.env))if(!['PATH','HOME'].includes(key))delete process.env[key];
registerHooks({resolve(spec,ctx,next){const bare=spec.replace(/^node:/,'');if(allowed.has(bare))return next('node:'+bare,ctx);if(spec.startsWith('./')||spec.startsWith('../')||spec.startsWith('file:')){const u=new URL(spec,ctx.parentURL??root);if(u.protocol==='file:'&&u.href.startsWith(root)&&u.pathname.endsWith('.mjs'))return next(u.href,ctx);}throw Error('sandbox_module_denied:'+spec);}});
Object.defineProperty(globalThis,'fetch',{value:()=>Promise.reject(Error('sandbox_network_denied')),writable:false,configurable:false});
Object.defineProperty(globalThis,'WebSocket',{value:class {constructor(){throw Error('sandbox_network_denied');}},writable:false,configurable:false});
for(const name of ['kill','_kill','_debugProcess','_debugEnd','execve','getBuiltinModule','binding','_linkedBinding','dlopen'])Object.defineProperty(process,name,{value:()=>{throw Error('sandbox_process_denied');},writable:false,configurable:false});
await import(new URL(process.argv[2],root).href);
`;
export interface ExecutionTrace {path:string;exit_code:number|null;stdout_tail:string;stderr_tail:string;duration_ms:number}
export class ResearchSandbox {
 readonly dir:string;executions=0;
 constructor(readonly chat_id:string,root=join(homedir(),'.trading-swarm-okx','research-sandbox')){
  if(!/^[a-zA-Z0-9_-]+$/.test(chat_id))throw Error('invalid_chat_id');
  this.dir=resolve(root,chat_id);mkdirSync(this.dir,{recursive:true,mode:0o700});this.dir=realpathSync(this.dir);
 }
 private path(path:string):string {
  if(!path||path.includes('\0')||path.split(/[\\/]/).some(x=>x.startsWith('.')))throw Error('sandbox_path_denied');
  const full=resolve(this.dir,path),rel=relative(this.dir,full);
  if(!rel||rel.startsWith('..')||rel.startsWith('/'))throw Error('sandbox_path_denied');
  let current=this.dir;for(const part of rel.split('/')){current=join(current,part);try{if(lstatSync(current).isSymbolicLink())throw Error('sandbox_symlink_denied');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  return full;
 }
 write(path:string,content:string){if(typeof content!=='string'||Buffer.byteLength(content)>1024*1024)throw Error('sandbox_file_too_large');const full=this.path(path);mkdirSync(resolve(full,'..'),{recursive:true});writeFileSync(full,content,{mode:0o600});return {path,bytes:Buffer.byteLength(content)};}
 read(path:string,offset=0,limit=20000){if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100000)throw Error('invalid_pagination');const full=this.path(path);if(lstatSync(full).size>20*1024*1024)throw Error('sandbox_file_too_large');const content=readFileSync(full,'utf8');return {path,content:content.slice(offset,offset+limit),total:content.length};}
 files(){const files:string[]=[];const walk=(dir:string)=>{for(const e of readdirSync(dir,{withFileTypes:true})){if(e.name.startsWith('.')||e.isSymbolicLink())continue;const p=join(dir,e.name);if(e.isDirectory())walk(p);else files.push(relative(this.dir,p));}};walk(this.dir);return files.sort();}
 export(store:ResearchStore,run_id?:string){this.write('README.md',SANDBOX_README);if(!run_id){this.write('run.json',JSON.stringify({note:'未选择 run；请先用工具选择实验'}));return;}
  const row=store.get(run_id);if(!row)throw Error('run_not_found');
  this.writeLarge('run.json',{id:row.id,status:row.status,manifest:row.manifest,metrics:row.result?.arms.map(a=>({arm:a.arm,metrics:a.metrics}))??[]});
  if(row.manifest.request.universe_id)for(const d of store.portfolio(row.manifest.request.universe_id).datasets)this.writeLarge(`datasets/${d.symbol}.json`,d);else this.writeLarge('dataset.json',store.dataFor(row.manifest.request));
  for(const arm of row.result?.arms??[])for(const key of ['trades','decisions','equity'] as const)this.writeLarge(`arms/${arm.arm}/${key}.json`,arm[key]);
 }
 private writeLarge(path:string,value:unknown){const full=this.path(path);mkdirSync(resolve(full,'..'),{recursive:true});writeFileSync(full,JSON.stringify(value));}
 async execute(path:string,timeout_ms=120000):Promise<ExecutionTrace>{
  const full=this.path(path);if(extname(full)!=='.mjs')throw Error('esm_mjs_required');if(!Number.isInteger(timeout_ms)||timeout_ms<1||timeout_ms>120000)throw Error('invalid_timeout');
  if(this.executions>=20)throw Error('sandbox_execution_budget');this.executions++;
  const runtime=join(this.dir,'.runtime.mjs');writeFileSync(runtime,bootstrap);
  const started=Date.now();return new Promise((done,reject)=>{
   const child=spawn(process.execPath,['--permission',`--allow-fs-read=${realpathSync(this.dir)}`,`--allow-fs-write=${realpathSync(this.dir)}`,'--max-old-space-size=384','--disallow-code-generation-from-strings',runtime,`./${relative(this.dir,full)}`],{cwd:this.dir,env:{PATH:process.env['PATH']??'',HOME:this.dir},stdio:['ignore','pipe','pipe']});
   let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),timed=false;
   const tail=(old:Buffer,chunk:Buffer)=>Buffer.concat([old,chunk]).subarray(-512*1024);
   child.stdout.on('data',(b:Buffer)=>{stdout=tail(stdout,b);});child.stderr.on('data',(b:Buffer)=>{stderr=tail(stderr,b);});
   const timer=setTimeout(()=>{timed=true;child.kill('SIGKILL');},timeout_ms);
   let memoryLimited=false,memoryCheckUnavailable=false;
   const memoryTimer=setInterval(()=>{if(!child.pid||memoryCheckUnavailable)return;try{execFile('/bin/ps',['-o','rss=','-p',String(child.pid)],{env:{PATH:process.env['PATH']??''}},(error,output)=>{if(error){memoryCheckUnavailable=true;return;}if(Number(output.trim())>512*1024){memoryLimited=true;child.kill('SIGKILL');}});}catch{memoryCheckUnavailable=true;}},100);
   child.on('error',e=>{clearTimeout(timer);clearInterval(memoryTimer);reject(e);});child.on('close',code=>{clearTimeout(timer);clearInterval(memoryTimer);done({path,exit_code:code,stdout_tail:stdout.toString(),stderr_tail:stderr.toString()+(timed?'\nsandbox_timeout':'')+(memoryLimited?'\nsandbox_memory_limit':'')+(memoryCheckUnavailable?'\nsandbox_rss_watchdog_unavailable':''),duration_ms:Date.now()-started});});
  });
 }
}
export function validateArtifact(kind:string,content:unknown):void {
 if(kind==='markdown'){if(typeof content!=='string'||content.length>1024*1024)throw Error('invalid_markdown');return;}
 if(!content||typeof content!=='object'||Array.isArray(content))throw Error('invalid_artifact');const c=content as Record<string,unknown>;
 if(c['kind']!==kind)throw Error('artifact_kind_mismatch');
 if(kind==='table'){if(!Array.isArray(c['columns'])||!c['columns'].every(x=>typeof x==='string')||!Array.isArray(c['rows'])||!c['rows'].every(r=>Array.isArray(r)&&r.length===(c['columns'] as unknown[]).length&&r.every(x=>x===null||['string','boolean'].includes(typeof x)||typeof x==='number'&&Number.isFinite(x))))throw Error('invalid_table');return;}
 if(kind!=='chart'||!['line','bar','scatter'].includes(String(c['type']))||!['time','category'].includes(String(c['x']))||typeof c['title']!=='string'||typeof c['y_label']!=='string'||typeof c['note']!=='string'||!Array.isArray(c['series'])||!c['series'].length)throw Error('invalid_chart');
 for(const series of c['series']){if(!series||typeof series!=='object'||typeof series.name!=='string'||!Array.isArray(series.points)||!series.points.every((p:unknown)=>Array.isArray(p)&&p.length===2&&(c['x']==='time'?typeof p[0]==='number'&&Number.isFinite(p[0]):typeof p[0]==='string')&&typeof p[1]==='number'&&Number.isFinite(p[1])))throw Error('invalid_chart_points');}
}
