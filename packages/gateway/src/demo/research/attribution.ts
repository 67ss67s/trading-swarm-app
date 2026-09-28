import type { ResearchAttribution,ResearchRequest,StrategyIR } from '@trade-gate/contracts';
import type { ResearchStore,RunRow } from './store.js';
import { hash,clone } from './primitives.js';
import { policyToIR } from './strategy.js';
import { runReplay } from './engine.js';
import { runPortfolio } from './portfolio.js';
const sections=['signal','entry','risk','exit','sizing','regime','screen'] as const;
type Section=typeof sections[number];
function part(ir:StrategyIR,section:Section):unknown {return section==='risk'?ir.risk.stop:section==='sizing'?ir.risk.sizing:section==='screen'?ir.universe?.screen??null:ir[section]??null;}
function set(ir:StrategyIR,section:Section,value:unknown){if(section==='risk')ir.risk.stop=value as StrategyIR['risk']['stop'];else if(section==='sizing')ir.risk.sizing=value as StrategyIR['risk']['sizing'];else if(section==='screen'){if(value===null)delete ir.universe;else ir.universe={screen:value as NonNullable<StrategyIR['universe']>['screen']};}else if(section==='regime'){if(value===null)delete ir.regime;else ir.regime=value as StrategyIR['regime'];}else Object.assign(ir,{[section]:value});}
const asIR=(r:ResearchRequest)=>r.strategy_ir??policyToIR(r.policy!,r.execution);
async function ruleReturn(store:ResearchStore,r:ResearchRequest,check:()=>void,legacyTargetAnchor=false):Promise<number> {
 const req={...r,arms:['a_rules'] as ['a_rules'],repeats:1,max_model_calls:0};
 const never=async()=>{throw new Error('attribution_must_not_call_model');};
 const result=r.universe_id?await runPortfolio(store.portfolio(r.universe_id),req,never,{check,legacyTargetAnchor}):await runReplay(store.dataFor(req),req,never,{check,legacyTargetAnchor});
 if(result.status!=='completed')throw new Error(`attribution_component_failed:${result.error}`);return result.arms[0]!.metrics.net_return;
}
export async function attributeRuns(store:ResearchStore,child:RunRow,check:()=>void=()=>{}):Promise<ResearchAttribution> {
 if(child.status!=='completed'||!child.manifest.request.parent_run_id)throw new Error('completed_child_with_parent_required');
 const parent=store.get(child.manifest.request.parent_run_id);if(!parent||parent.status!=='completed')throw new Error('completed_parent_required');
 const a=parent.manifest.request,b=child.manifest.request;
 const conditions=(r:ResearchRequest)=>({data:r.universe_id??r.dataset_id,from_ms:r.from_ms,to_ms:r.to_ms,execution:r.execution,order_gate:r.order_gate??null,shortlist:r.shortlist??null});
 if(hash(conditions(a))!==hash(conditions(b)))throw new Error('attribution_requires_same_data_range_execution');
 const key=hash({version:'section-ablation-v3',parent:parent.manifest.hash,child:child.manifest.hash});
 const cached=store.db.prepare('SELECT json FROM research_attributions WHERE cache_key=?').get(key) as {json:string}|undefined;if(cached)return JSON.parse(cached.json) as ResearchAttribution;
 const parentIR=asIR(a),childIR=asIR(b),base=await ruleReturn(store,a,check),target=await ruleReturn(store,b,check),components:ResearchAttribution['components']=[];
 for(const section of sections){check();if(hash(part(parentIR,section))===hash(part(childIR,section)))continue;
  const ir=clone(parentIR);delete ir.compatibility;set(ir,section,clone(part(childIR,section)));
  // Internal ablations may retain the legacy fixed exits. All nodes originate in validated frozen requests;
  // they are never promoted through compile, and cannot call code outside the registry.
  // Preserve the exit section's original price anchor when adapting a legacy policy.
  const legacyTargetAnchor=!!(section==='exit'?childIR:parentIR).compatibility;
  const {policy:_,...rest}=a,solo=await ruleReturn(store,{...rest,strategy_ir:ir},check,legacyTargetAnchor);components.push({section,changed:true,solo_net_return:solo,delta:solo-base});
 }
 const result:ResearchAttribution={parent_run_id:parent.id,child_run_id:child.id,base_net_return:base,child_net_return:target,components,interaction:target-base-components.reduce((sum,c)=>sum+c.delta,0),note:'逐段消融是探索性归因；risk 仅初始 stop，sizing 单列，screen 是 universe.screen。各分量均从 parent 单独替换后跑 A 臂，零模型；段间存在交互，不是因果证明。'};
 store.db.prepare('INSERT OR IGNORE INTO research_attributions VALUES (?,?,?,?)').run(key,child.id,Date.now(),JSON.stringify(result));
 return JSON.parse((store.db.prepare('SELECT json FROM research_attributions WHERE cache_key=?').get(key) as {json:string}).json) as ResearchAttribution;
}
