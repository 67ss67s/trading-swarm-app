import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import type { Judgment } from '../../src/demo/types.js';
let server:FakeMarketServer, DemoRuntime:typeof import('../../src/demo/runtime.js').DemoRuntime;
let rt:InstanceType<typeof DemoRuntime>|null=null,state:StateDb|null=null;
beforeAll(async()=>{server=await startFakeMarketServer(77000,200);process.env.TG_DEMO_MARKET_BASE=server.url;({DemoRuntime}=await import('../../src/demo/runtime.js'));});
afterAll(async()=>{await server.close();delete process.env.TG_DEMO_MARKET_BASE;});
afterEach(async()=>{if(rt)await rt.stop();state?.close();rt=null;state=null;vi.restoreAllMocks();});
const review=(action:'EXIT'|'REDUCE'):Judgment=>({action,direction:'long',confidence:.9,headline:'forced test action',thesis:'noise is a reason to exit',reasons:['fixture [E1]'],evidence_refs:['E1'],invalidation:null,invalidation_price:null,target_price:null,watch_conditions:[],proposal:null});
async function drain(){const start=performance.now();while(rt!.queueView().pending||rt!.queueView().running){if(performance.now()-start>10000)throw Error('runtime did not drain');await new Promise(r=>setTimeout(r,10));}}
async function setup(answer:(system:string,user:string)=>string){state=openStateDb(':memory:');const store=new DemoStore(state),backend=new PaperBackend(10000);rt=new DemoRuntime({store,backend,brains:{stub:stubBrain(answer)},marketPollMs:600000,accountPollMs:600000});await rt.start();rt.setWorkflow({brain:'stub',cheap_brain:'stub',watchlist:['BTCUSDT'],auto_approve:true});return{store,backend};}
async function seed(store:DemoStore){const {newThread}=await import('../../src/demo/threads.js');const t={...newThread({id:'holding-integration',backend:'paper',symbol:'BTCUSDT',side:'long',source:'agent',timeframe:'15m',horizon:'intraday',thesis:'stable thesis',invalidation_text:'50000',watch_conditions:[],entry:{type:'market',price:'77050',zone:null},stop_price:'40000',take_profits:['100000'],qty:'0.01',margin_usdt:'100',leverage:1,margin_mode:'cross',now:Date.now()-8*3600000}),status:'in_position' as const,opened_at:Date.now()-8*3600000,filled_avg_price:'77050'};store.saveThread(t);return t;}
describe('holding policy at runtime execution boundary',()=>{
 for(const action of ['EXIT','REDUCE'] as const)it(`model ${action} while policy HOLD never calls close or reduce`,async()=>{
  const {store,backend}=await setup(()=>JSON.stringify(review(action)));const t=await seed(store);const close=vi.spyOn(backend,'closePosition'),reduce=vi.spyOn(backend,'reducePosition');
  expect(rt!.reviewThread(t.id,{kind:'manual',detail:'independent policy boundary'})).toBe(true);await drain();
  expect(close).not.toHaveBeenCalled();expect(reduce).not.toHaveBeenCalled();expect(store.thread(t.id)!.status).toBe('in_position');
  const ep=store.episode(store.episodes(10).find(e=>e.thread_id===t.id)!.id)!;expect(ep.holding_review!.allowed_actions).toEqual(['HOLD']);expect(ep.judgment_raw).toBeNull();expect((ep as {skipped_model?:boolean}).skipped_model).toBe(true);expect(ep.judgment!.action).toBe('HOLD');expect(ep.graph!.illegal_action??null).toBeNull(); // 09-23 短路①:HOLD-only 不再调模型
 });
 it('09-23 §9.49 a human-verified adverse event makes REDUCE/EXIT reachable on the next review',async()=>{
  const {store}=await setup(()=>JSON.stringify(review('REDUCE')));const t=await seed(store);
  expect(()=>rt!.setVerifiedEvent(t.id,{adverse_side:'short',note:'wrong side'})).toThrow(/不一致/);
  const r=rt!.setVerifiedEvent(t.id,{adverse_side:'long',note:'交易所公告下架该合约'});expect(r.review_queued).toBe(true);
  expect(store.thread(t.id)!.verified_event).toMatchObject({material:true,verified_by:'user',adverse_side:'long'});
  await drain();
  const ep=store.episode(store.episodes(10).find(e=>e.thread_id===t.id)!.id)!;
  expect(ep.holding_review!.reason).toBe('verified_material_event');expect(ep.holding_review!.allowed_actions).toEqual(expect.arrayContaining(['HOLD','REDUCE','EXIT']));
expect(ep.judgment!.action).toBe('REDUCE');expect(ep.graph?.illegal_action??null).toBeNull();
  expect(rt!.clearVerifiedEvent(t.id).thread.verified_event).toBeNull();
 });
 it('low net RR is rejected before saving a new thread or placing an entry',async()=>{
  const {store,backend}=await setup((system,user)=>{if(system.includes('Portfolio 仓位顾问'))return 'garbage';const mark=Number(/mark (\d+(?:\.\d+)?)/.exec(user)![1]);const p={action:'PROPOSE',direction:'long',confidence:.9,headline:'bad economics',thesis:'fixture',strategy_id:'breakout_retest',reasons:['fixture [E1]'],evidence_refs:['E1'],invalidation:null,invalidation_price:String(mark*.995),target_price:String(mark*1.004),watch_conditions:[],proposal:{direction:'long',entry:'market',limit_price:null,entry_zone:null,stop_price:String(mark*.99),take_profit_price:String(mark*1.004),take_profits:[String(mark*1.004)],risk_plan:{atr_timeframe:'1h',stop_atr_multiple:'1'},rationale:'fixture'}};return JSON.stringify(p);});
  const save=vi.spyOn(store,'saveThread'),place=vi.spyOn(backend,'placeEntry');expect(rt!.scan('BTCUSDT',{kind:'manual',detail:'bad rr'})).toBe(true);await drain();
  expect(store.threads()).toHaveLength(0);expect(save).not.toHaveBeenCalled();expect(place).not.toHaveBeenCalled();
  const ep=store.episode(store.episodes(10)[0]!.id)!;expect(ep.gates.find(g=>g.name==='净盈亏比')!.passed).toBe(false);
 });
 it('a bar forming at ep.at cannot become closed stop evidence during model latency',async()=>{
  const H=3600000;let clock=Math.floor(Date.now()/H)*H+58*60000;vi.spyOn(Date,'now').mockImplementation(()=>clock);
  const realFetch=globalThis.fetch;vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{const response=await realFetch(input,init);const url=String(input);if(!url.includes('/fapi/v1/klines'))return response;const rows=await response.json() as unknown[][];const tf=new URL(url).searchParams.get('interval')!;const ms=tf==='1w'?604800000:tf.endsWith('d')?Number(tf.slice(0,-1))*86400000:tf.endsWith('h')?Number(tf.slice(0,-1))*H:Number(tf.slice(0,-1))*60000;const current=Math.floor(clock/ms)*ms;for(let i=0;i<rows.length;i++){rows[i]![0]=current-(rows.length-1-i)*ms;rows[i]![6]=Number(rows[i]![0])+ms-1;if(i===rows.length-1&&tf==='1h'){rows[i]![3]='39000';rows[i]![4]='39000';}}return new Response(JSON.stringify(rows),{status:200,headers:{'content-type':'application/json'}});});
  let invoked=0;const {store,backend}=await setup(()=>{invoked++;clock+=3*60000;return JSON.stringify(review('EXIT'));});const t=await seed(store),close=vi.spyOn(backend,'closePosition');const before=clock;
  expect(rt!.reviewThread(t.id,{kind:'manual',detail:'cross close boundary'})).toBe(true);await drain();expect(invoked).toBe(0);expect(clock).toBe(before); // 09-23 短路①:HOLD-only 不调模型,闸仍按 Date.now() 重算expect(close).not.toHaveBeenCalled();
  const ep=store.episode(store.episodes(10).find(e=>e.thread_id===t.id)!.id)!;expect(ep.holding_review!.required_action).toBeNull();expect(ep.holding_review!.reason).not.toBe('closed_beyond_hard_stop');
 });
});
