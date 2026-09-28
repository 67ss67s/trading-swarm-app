import type { ResearchDataset, ResearchFactorDefinition, ResearchUniverse, ResearchUniverseRequest } from '@trade-gate/contracts';
import { assertContract, hash } from './primitives.js';
export function factorDefinition(raw:ResearchUniverseRequest):ResearchFactorDefinition {
  const {kind,symbols}=raw.market_factor;
  const expected=kind==='btc'?['BTCUSDT']:kind==='btc_eth_capw'?['BTCUSDT','ETHUSDT']:[...(raw.symbols??[])].sort();
  if(JSON.stringify([...symbols].sort())!==JSON.stringify([...expected].sort()))throw new Error('factor_symbols_mismatch');
  const weights:Record<string,string>=kind==='btc'?{BTCUSDT:'1'}:kind==='btc_eth_capw'?{BTCUSDT:'0.7',ETHUSDT:'0.3'}:Object.fromEntries(expected.map(s=>[s,String(1/expected.length)]));
  return {kind,symbols:expected as [string,...string[]],weights,...(kind==='btc_eth_capw'?{note:'固定 BTC 0.7 / ETH 0.3 权重，不是实时市值权重'}:{})};
}
export function buildUniverse(raw:ResearchUniverseRequest,members:{id:string;data:ResearchDataset}[]):ResearchUniverse {
  assertContract<ResearchUniverseRequest>(raw);if(!('market_factor' in raw)||!('from_ms' in raw))throw new Error('expected_universe_request');
  const factor=factorDefinition(raw),expected=[...new Set([...(raw.symbols??[]),...factor.symbols])].sort();
  if(expected.length>500)throw Error('universe_members_exceed_500');
  members=[...members].sort((a,b)=>a.data.symbol.localeCompare(b.data.symbol));
  if(JSON.stringify(members.map(m=>m.data.symbol))!==JSON.stringify(expected))throw new Error('universe_members_mismatch');
  const step=members[0]!.data.timeframe_ms;
  if(members.some(m=>m.data.timeframe_ms!==step||m.data.calendar!==members[0]!.data.calendar))throw new Error('universe_timeframe_or_calendar_mismatch');
  const times=members.map(m=>new Set(m.data.bars.map(b=>b.close_time)));
  const union=[...new Set(times.flatMap(t=>[...t]))].sort((a,b)=>a-b);
  const aligned=union.filter(t=>times.every(s=>s.has(t)));
  if(aligned.length<3)throw new Error('universe_insufficient_overlap');
  const rows=members.map(({id,data:d})=>({symbol:d.symbol,dataset_id:id,bars:d.bars.length,first_at:d.bars[0]!.close_time,last_at:d.bars.at(-1)!.close_time}));
  const missing=Object.fromEntries(members.map((m,i)=>[m.data.symbol,union.filter(t=>!times[i]!.has(t))]));
  return {id:hash({members:rows.map(m=>({symbol:m.symbol,dataset_id:m.dataset_id})),market_factor:factor}),timeframe_ms:step,members:rows,market_factor:factor,aligned_bars:aligned.length,aligned_close_times:aligned,missing,first_at:aligned[0]!,last_at:aligned.at(-1)!,retrieved_at:Math.max(...members.map(m=>m.data.retrieved_at))};
}
