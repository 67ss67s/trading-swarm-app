import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openStateDb } from '../../../src/state-db.js';
import { validate, type ResearchUniverseRequest } from '@trading-swarm/contracts';
import { ResearchStore } from '../../../src/demo/research/store.js';
import { buildUniverse, factorDefinition } from '../../../src/demo/research/universe.js';
import { factorDecompose } from '../../../src/demo/research/factor.js';
import { screenUniverse } from '../../../src/demo/research/screen.js';
import { trendState } from '../../../src/demo/research/primitives/trend-state.js';
import { periodsPerYear, isSessionGap } from '../../../src/demo/research/calendar.js';
import { dataset, hash, request } from '../../../src/demo/research/primitives.js';
import { fixture, params, STEP } from './fixtures.js';
const close: (()=>void)[]=[];afterEach(()=>{for(const f of close.splice(0))f();});
const raw:ResearchUniverseRequest={symbols:['SOLUSDT','BTCUSDT'],timeframe:'1h',from_ms:1,to_ms:2000000000000,market_factor:{kind:'btc',symbols:['BTCUSDT']}};
function universe(gap=false){
  const btc={...fixture(),symbol:'BTCUSDT'},sol={...fixture(),symbol:'SOLUSDT'};
  if(gap)sol.bars.splice(150,1);
  const members=[btc,sol].map(data=>({data,id:hash(data)}));return {u:buildUniverse(raw,members),datasets:[btc,sol]};
}
describe('round 2 universe, factor, screen',()=>{
  it('aligns by intersection, marks missing without filling, and canonicalizes member order',()=>{
    const {u,datasets}=universe(true);expect(u.aligned_bars).toBe(419);expect(u.missing.SOLUSDT).toEqual([datasets[0]!.bars[150]!.close_time]);
    expect(u.aligned_close_times).not.toContain(datasets[0]!.bars[150]!.close_time);
    expect(buildUniverse({...raw,symbols:[...raw.symbols].reverse()},datasets.reverse().map(data=>({data,id:hash(data)}))).id).toBe(u.id);
    expect(validate('research',u).ok).toBe(true);
  });
  it('preserves strict single-asset gap rejection and allows sparse universe snapshots explicitly',()=>{
    const {datasets}=universe(true);expect(()=>dataset(datasets[1])).toThrow('gap');expect(dataset(datasets[1],true).bars).toHaveLength(419);
    expect(()=>request(params(),datasets[1]!)).toThrow('gap');
  });
  it('persists content-addressed universes and reuses market snapshots across retrieval times',()=>{
    const state=openStateDb(':memory:');close.push(()=>state.close());const store=new ResearchStore(state.db),d={...fixture(),symbol:'BTCUSDT'};
    const old=store.putDataset(d),a=store.putMarketDataset({...d,retrieved_at:d.retrieved_at+100});expect(a.id).toBe(old.id);
    expect(store.putMarketDataset({...d,retrieved_at:d.retrieved_at+200}).id).toBe(a.id);
    const u=buildUniverse({...raw,symbols:['BTCUSDT']},[{data:store.dataset(a.id),id:a.id}]);
    expect(store.putUniverse(u)).toEqual(store.putUniverse(u));expect(store.universe(u.id)).toEqual(u);
    expect(store.universes()[0]).not.toHaveProperty('aligned_close_times');expect(store.universes()[0]).not.toHaveProperty('missing');
  });
  it('makes fixed cap weights explicit and rejects inconsistent factor membership',()=>{
    expect(factorDefinition({...raw,market_factor:{kind:'btc_eth_capw',symbols:['ETHUSDT','BTCUSDT']}})).toMatchObject({weights:{BTCUSDT:'0.7',ETHUSDT:'0.3'},note:expect.stringContaining('不是实时市值')});
    expect(()=>factorDefinition({...raw,market_factor:{kind:'btc',symbols:['ETHUSDT']}})).toThrow('factor_symbols_mismatch');
  });
  it('fits an exact beta and intercept with the same residual metric convention',()=>{
    const market=Array.from({length:200},(_,i)=>(i%5-2)/1000),returns=market.map(x=>1.5*x+0.0001);
    const f=factorDecompose(returns,market,{window_bars:50,periods_per_year:8760});
    expect(f.status).toBe('ok');expect(f.beta).toBeCloseTo(1.5,12);expect(f.alpha_per_bar).toBeCloseTo(.0001,12);expect(f.alpha_annualized).toBeCloseTo(.876,10);expect(f.r2).toBeCloseTo(1,12);
    expect(f.residual_returns).toHaveLength(200);expect(f.residual?.total_return).toBeCloseTo(Math.expm1(.02),12);expect(f.residual?.sharpe).toBeNull();expect(f.alpha_share!+f.beta_share!).toBeCloseTo(1,12);
    expect(f.rolling).toHaveLength(151);expect(validate('research',f).ok).toBe(true);
  });
  it('matches the independently generated NumPy regression and risk fixture',()=>{
    const fixture=JSON.parse(readFileSync(new URL('./data/factor-numpy.json',import.meta.url),'utf8'));
    const actual=factorDecompose(fixture.returns,fixture.market_returns,fixture);
    for(const key of ['beta','alpha_per_bar','alpha_annualized','r2'] as const)expect(actual[key]).toBeCloseTo(fixture.expected[key],11);
    for(const row of fixture.rolling){const actualRow=actual.rolling!.find(r=>r.at_index===row.at_index)!;for(const key of ['beta','alpha_annualized','r2'] as const)expect(actualRow[key]).toBeCloseTo(row[key],11);}
    for(const group of ['raw','residual'] as const)for(const [key,value] of Object.entries(fixture.expected[group])){
      if(value===null)expect(actual[group]?.[key as keyof NonNullable<typeof actual.raw>]).toBeNull();
      else expect(actual[group]?.[key as keyof NonNullable<typeof actual.raw>]).toBeCloseTo(value as number,11);
    }
  });
  it('does not invent coefficients for insufficient samples or multi-factor support',()=>{
    expect(factorDecompose(Array(99).fill(0),Array(99).fill(0),{window_bars:20,periods_per_year:8760})).toEqual({status:'insufficient',note:expect.any(String)});
    expect(factorDecompose(Array(100).fill(0),Array(100).fill(0),{window_bars:51,periods_per_year:8760}).status).toBe('insufficient');
    expect(()=>factorDecompose([0],[NaN],{window_bars:2,periods_per_year:8760})).toThrow('returns_invalid');
    expect(()=>factorDecompose([],[],{window_bars:2,periods_per_year:8760,factors:[[0]]})).toThrow('not_implemented');
  });
  it('uses magnitude shares for negative total and null ratios for flat returns',()=>{
    const m=Array.from({length:100},(_,i)=>(i%2?1:-3)/100),f=factorDecompose(m.map(x=>.5*x-.001),m,{window_bars:20,periods_per_year:365});
    expect(f.alpha_share!+f.beta_share!).toBeCloseTo(1);expect(f.alpha_share).toBeGreaterThan(0);expect(f.note).toContain('绝对值');
    const flat=factorDecompose(Array(100).fill(0),Array(100).fill(0),{window_bars:20,periods_per_year:365});expect(flat.alpha_share).toBeNull();expect(flat.raw?.sharpe).toBeNull();expect(flat.raw?.max_drawdown).toBe(0);
  });
  it('uses excess returns for Sharpe and CAPM intercept',()=>{
    const m=Array.from({length:100},(_,i)=>(i%2?1:-1)/100),r=m.map(x=>2*x+.001),f=factorDecompose(r,m,{window_bars:20,periods_per_year:252,risk_free_per_bar:.001});
    expect(f.alpha_per_bar).toBeCloseTo(.002,12);expect(f.raw?.sharpe).toBeCloseTo(0,10);
  });
  it('screen is invariant to all bars after as_of including NaN sentinels',()=>{
    const {u,datasets}=universe(),as_of=datasets[0]!.bars[300]!.close_time,opts={as_of,window_bars:50,lookback_bars:250};
    const before=screenUniverse(u,datasets,opts),poison=datasets.map(d=>({...d,bars:d.bars.map(b=>b.close_time>as_of?{...b,open:'NaN',high:'NaN',low:'NaN',close:'NaN',volume:'NaN'}:b)}));
    expect(screenUniverse(u,poison,opts)).toEqual(before);expect(before.rows).toHaveLength(2);expect(before.rows[0]?.beta).toBeCloseTo(1,10);expect(before.rows[0]?.momentum_12_1).toBeNull();expect(validate('research',before).ok).toBe(true);
    const truncated=datasets.map(d=>({...d,bars:d.bars.filter(b=>b.close_time<=as_of)}));expect(screenUniverse(u,truncated,opts)).toEqual(before);
  });
  it('excludes cross-gap returns and does not rank insufficient rows',()=>{
    const {u,datasets}=universe(true),s=screenUniverse(u,datasets,{window_bars:50,lookback_bars:420});expect(s.rows[0]?.bars).toBe(417);
    const short=screenUniverse(u,datasets,{as_of:datasets[0]!.bars[40]!.close_time,window_bars:50});expect(short.rows.every(r=>r.status==='insufficient'&&!r.rank)).toBe(true);
  });
  it('shared trend primitive cannot read the future and waits for closed higher timeframe bars',()=>{
    const d=fixture(),i=300,ctx={bars:d.bars,i,timeframe_ms:STEP},before=trendState(ctx);
    const poison=d.bars.map((b,j)=>j>i?{...b,high:'NaN',close:'1000000000',low:'NaN'}:b);
    expect(trendState({...ctx,bars:poison})).toEqual(before);expect(trendState({...ctx,bars:d.bars.slice(0,i+1)})).toEqual(before);
    expect(trendState({...ctx,i:199}).status).toBe('insufficient');expect(trendState({...ctx,i:203}).status).toBe('ok');
  });
  it('derives crypto/US RTH annualization and identifies session gaps without price filling',()=>{
    expect(periodsPerYear(STEP)).toBe(8760);expect(periodsPerYear(STEP,'us_equity_rth')).toBe(1638);expect(periodsPerYear(86400000,'us_equity_rth')).toBe(252);
    expect(isSessionGap(100,100+16*STEP,'us_equity_rth')).toBe(true);expect(isSessionGap(100,101,'us_equity_rth')).toBe(false);expect(isSessionGap(100,100+16*STEP)).toBe(false);
    expect(dataset({...fixture(),calendar:'us_equity_rth',adjusted:true,risk_free_per_bar:'0.0001'}).adjusted).toBe(true);
  });
});
