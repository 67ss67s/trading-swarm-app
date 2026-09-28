#!/usr/bin/env node
// 输入已经导出的脱敏响应 JSON（G3 collection 或 {responses:[...]}），不读取运行库、不联网。
import {readFileSync,writeFileSync,realpathSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {homedir} from 'node:os';
const args=process.argv.slice(2),get=k=>args[args.indexOf('--'+k)+1],input=get('input'),output=get('output');
if(!args.includes('--input')||!args.includes('--output'))throw Error('usage: --input sanitized-responses.json --output diagnostics.json');
const forbidden=resolve(homedir(),'.trade-gate-okx/demo'),p=realpathSync(input);
if(p===forbidden||p.startsWith(forbidden+'/'))throw Error('forbidden_runtime_directory');
const rows=JSON.parse(readFileSync(p,'utf8')).responses;if(!Array.isArray(rows))throw Error('responses_required');
const hits=[],unknown={};
for(const r of rows){const raw=typeof r.raw_json==='string'?JSON.parse(r.raw_json):r.raw_json;
 if(raw?.usage?.cost_usd==null){const why=r.error_code??'usage_cost_missing_or_invalid';unknown[why]=(unknown[why]??0)+1;}
 for(const [key,a] of Object.entries(raw?.raw_response?.answers??raw?.answers??{})){const ps=Object.values(a?.probabilities??{});if(!ps.length||ps.some(p=>typeof p!=='number'||!Number.isFinite(p)))continue;const sum=ps.reduce((s,p)=>s+p,0),deviation=Math.abs(sum-1);if(deviation>1e-6)hits.push({raw_response_ref:r.request_hash,question_key:key,probabilities:a.probabilities,sum,deviation});}
}
const report={sample_count:rows.length,probability_sum_hits:hits.length,within_001:hits.filter(h=>h.deviation<=0.01+1e-12).length,max_deviation:hits.length?Math.max(...hits.map(h=>h.deviation)):null,unknown_cost_reasons:unknown,hits};
const out=resolve(output);let ancestor=out;while(!existsSync(ancestor))ancestor=dirname(ancestor);const canonical=join(realpathSync(ancestor),out.slice(ancestor.length));if(canonical===forbidden||canonical.startsWith(forbidden+'/'))throw Error('forbidden_runtime_directory');writeFileSync(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify({...report,hits:undefined})+'\n');
