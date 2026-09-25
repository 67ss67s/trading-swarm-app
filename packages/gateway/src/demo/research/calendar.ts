import type { ResearchDataset } from '@trading-swarm/contracts';
export function periodsPerYear(timeframe_ms:number, calendar:ResearchDataset['calendar']='crypto_24_7'):number {
  if(!Number.isSafeInteger(timeframe_ms)||timeframe_ms<=0)throw new Error('timeframe_invalid');
  return calendar==='us_equity_rth'?252*Math.max(1,23400000/timeframe_ms):365*86400000/timeframe_ms;
}
/** Session breaks are gaps for execution; never synthesize an overnight price. */
export function isSessionGap(previous_close:number, next_open:number, calendar:ResearchDataset['calendar']='crypto_24_7'):boolean {
  return calendar==='us_equity_rth' && next_open>previous_close+1;
}
