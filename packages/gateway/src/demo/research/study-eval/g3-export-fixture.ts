/** 仅供离线测试：真实 SQLite 表形状，价格人为生成，必须 synthetic。 */
import type { DatabaseSync } from 'node:sqlite';
import type { ResearchBar, StrategyIR } from '@trade-gate/contracts';
import type { ExportSnapshot } from './g3-export.js';
const H=3600000,START=Date.UTC(2024,0,1);
export function seedG3ExportFixture(db:DatabaseSync){
 const bars:ResearchBar[]=Array.from({length:2400},(_,i)=>{const at=START+i*H,p=100+Math.sin(i/12)*5+i/2000;return{open_time:at,close_time:at+H-1,available_at:at+H-1,open:p.toFixed(8),close:(p+0.2).toFixed(8),high:(p+1).toFixed(8),low:(p-1).toFixed(8),volume:'100'};});
 const four:ResearchBar[]=Array.from({length:600},(_,i)=>{const b=bars.slice(i*4,i*4+4);return{...b[0]!,close_time:b[3]!.close_time,available_at:b[3]!.available_at,close:b[3]!.close,high:String(Math.max(...b.map(x=>Number(x.high)))),low:String(Math.min(...b.map(x=>Number(x.low)))),volume:'400'};});
 const ir:StrategyIR={version:1,label:'synthetic G3 export',description:'fixture only',entry:{primitive:'next_open_market',params:{}},risk:{stop:{primitive:'atr_stop',params:{atr_period:14,multiple:2}},sizing:{primitive:'equal_notional',params:{max_allocation:1}}},signal:[{primitive:'indicator_threshold',params:{indicator:'rsi',args:{period:14},operator:'below',threshold:40}}],exit:[{primitive:'time_stop',params:{bars:8}}],order:{direction:'long',market:'spot',entry:{type:'market'},take_profits:[{source:{primitive:'fixed_r_target',params:{r:2}}}],on_new_signal:{unfilled:'keep',filled:'ignore'},max_holding_bars:8}} as StrategyIR;
 const segments={timeframe:'4h',timeframe_ms:4*H,train:{from_ms:four[100]!.close_time,to_ms:four[299]!.close_time},selection:{from_ms:four[330]!.close_time,to_ms:four[590]!.close_time},holdout:{from_ms:four[595]!.close_time,to_ms:four[599]!.close_time},purge_bars:30};
 const cell={id:'fixture_cell',symbol:'BTCUSDT',timeframe:'4h',family:'pullback',side:'long',arm:'code',applicability:'applicable',reason:null,variants:[],segments,holding_cap:8};
 const snapshot={study_id:'g3_fixture',manifest:{version:'matrix_manifest_v1',cells:[cell],segments:{'4h':segments},spec:{portfolio:{risk_pct:0.5,max_open:3},market:'spot',protocol:{block_days:5,min_effect:0,max_drawdown:0.35}},created_at:START},cells:{fixture_cell:{cell_id:'fixture_cell',verdict:'near',best_trial_id:'fixture_trial',selection:{sharpe:1}}},finalists:[],trials:[{trial_id:'fixture_trial',status:'evaluated',variant:{id:'fixture_variant',ir,param:'fixture'}}]} as unknown as ExportSnapshot;
 db.exec('CREATE TABLE research_matrix_studies(id TEXT PRIMARY KEY,manifest_json TEXT,state_json TEXT); CREATE TABLE research_study_trials(study_id TEXT,trial_id TEXT,status TEXT,candidate_json TEXT); CREATE TABLE research_datasets(id TEXT PRIMARY KEY,json TEXT);');
 db.prepare('INSERT INTO research_matrix_studies VALUES(?,?,?)').run(snapshot.study_id,JSON.stringify(snapshot.manifest),JSON.stringify({cells:snapshot.cells,finalists:[]}));
 db.prepare('INSERT INTO research_study_trials VALUES(?,?,?,?)').run(snapshot.study_id,'fixture_trial','evaluated',JSON.stringify({variant:snapshot.trials[0]!.variant}));
 const put=db.prepare('INSERT INTO research_datasets VALUES(?,?)');for(const [tf,bs] of [[H,bars],[4*H,four]] as const)put.run(`synthetic_${tf}`,JSON.stringify({venue:'okx',market:'spot',symbol:'BTCUSDT',timeframe_ms:tf,source:'synthetic_g3_export_fixture',retrieved_at:bars.at(-1)!.close_time+1,bars:bs}));
 return snapshot;
}
