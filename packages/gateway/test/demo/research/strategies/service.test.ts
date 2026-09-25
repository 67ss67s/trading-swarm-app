import { afterEach, describe, expect, it } from 'vitest';
import { validate, type ResearchStrategyStatus } from '@trading-swarm/contracts';
import { openStateDb } from '../../../../src/state-db.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import type { ResearchService } from '../../../../src/demo/research/service.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import { StrategyService, TRANSITIONS, downsample, irHash } from '../../../../src/demo/research/strategies/service.js';
import { defaultIR, meta, report, variantIR } from './fixtures.js';

const clean:(()=>void)[]=[];
afterEach(()=>{for(const f of clean.splice(0))f();});
function setup(){
  const state=openStateDb(':memory:');clean.push(()=>state.close());
  let t=1_000;const research=new ResearchStore(state.db),store=new StrategyStore(state.db,()=>++t);
  return {db:state.db,store,svc:new StrategyService(store,research,{} as ResearchService)};
}
const STATUSES:ResearchStrategyStatus[]=['draft','backtested','paper','live','published','archived'];
/** 造一条处在给定状态的策略(backtested 以后都带一份 completed 报告) */
function at(svc:StrategyService,status:ResearchStrategyStatus):string{
  const id=svc.create({name:`s-${status}`,strategy_ir:defaultIR()}).id;
  const go=(to:ResearchStrategyStatus)=>svc.transition(id,{to,confirm:'LIVE'});
  if(status==='draft')return id;
  if(status==='archived'){go('archived');return id;}
  svc.attachReport(report({ir:defaultIR()}),meta(),{strategy_id:id,strategy_version:1});
  if(status==='paper'||status==='live')go('paper');
  if(status==='live')go('live');
  if(status==='published')go('published');
  return id;
}
const conflict=(fn:()=>unknown)=>expect(fn).toThrow(/conflict/);

describe('策略状态机(§9.46)',()=>{
  it('全部 6×6 转移:只有表里的能过,其余 409(conflict)',()=>{
    for(const from of STATUSES)for(const to of STATUSES){
      const {svc}=setup(),id=at(svc,from);
      expect(svc.store.require(id).status).toBe(from);
      const ok=TRANSITIONS[from].includes(to)&&!(from==='draft'&&to==='backtested');
      if(ok){const d=svc.transition(id,{to,confirm:'LIVE'});expect(d.strategy.status,`${from}->${to}`).toBe(to);expect(d.events.at(-1)!.kind).toBe(to==='archived'?'archived':'transition');}
      else conflict(()=>svc.transition(id,{to,confirm:'LIVE'}));
    }
  });
  it('draft→backtested 需要完成的报告;失败报告不自动转,完成报告自动转',()=>{
    const {svc}=setup(),id=at(svc,'draft');
    expect(svc.detail(id).allowed_transitions).toEqual(['archived']);
    conflict(()=>svc.transition(id,{to:'backtested'}));
    svc.attachReport(report({status:'failed'}),meta(),{strategy_id:id,strategy_version:1});
    expect(svc.store.require(id).status).toBe('draft');expect(svc.store.require(id).summary).toBeNull();
    svc.attachReport(report(),meta(),{strategy_id:id,strategy_version:1});
    const d=svc.detail(id);expect(d.strategy.status).toBe('backtested');expect(d.reports).toHaveLength(2);
    expect(d.events.map(e=>e.kind)).toEqual(['created','version_added','backtested','backtested','transition']);
    expect(d.allowed_transitions).toEqual(['paper','published','archived']);
    // 归档再恢复成 draft 后已有完成报告,可以手动回 backtested
    svc.transition(id,{to:'archived'});expect(svc.store.require(id).status).toBe('archived');
    const back=svc.transition(id,{to:'draft'});expect(back.allowed_transitions).toEqual(['backtested','archived']);
    expect(svc.transition(id,{to:'backtested'}).strategy.status).toBe('backtested');
  });
  it('paper→live 必须 confirm===LIVE;live→paper 可回;published 只能归档',()=>{
    const {svc}=setup(),id=at(svc,'paper');
    conflict(()=>svc.transition(id,{to:'live'}));conflict(()=>svc.transition(id,{to:'live',confirm:'live'}));conflict(()=>svc.transition(id,{to:'live',confirm:' LIVE'}));
    expect(svc.store.require(id).status).toBe('paper');
    expect(svc.transition(id,{to:'live',confirm:'LIVE',note:'人工确认'}).events.at(-1)).toMatchObject({kind:'transition',from:'paper',to:'live',version:1,note:'人工确认'});
    expect(svc.transition(id,{to:'paper'}).strategy.status).toBe('paper');
    const pub=svc.transition(id,{to:'published'});expect(pub.allowed_transitions).toEqual(['archived']);
    // 挂点只留不写
    expect(pub.strategy.lab_strategy_id).toBeNull();expect(pub.strategy.published_listing_id).toBeNull();
    expect(()=>svc.transition(id,{to:'nope'})).toThrow(/invalid_contract/);
  });
  it('DELETE 归档:archived_at 写上、archived 事件、重复归档幂等',()=>{
    const {svc,db}=setup(),id=at(svc,'backtested');
    expect(svc.archive(id).strategy.status).toBe('archived');expect(svc.archive(id).events.filter(e=>e.kind==='archived')).toHaveLength(1);
    expect((db.prepare('SELECT archived_at FROM research_strategies WHERE id=?').get(id) as {archived_at:number}).archived_at).toBeGreaterThan(0);
    svc.transition(id,{to:'draft'});expect((db.prepare('SELECT archived_at FROM research_strategies WHERE id=?').get(id) as {archived_at:number|null}).archived_at).toBeNull();
  });
});

describe('研究 loop 回测报告自动挂链',()=>{
  it('规则 3:无匹配 → 新建策略(research_loop,名字≤60 字,symbol=主资产,timeframe=报告),并自动 backtested',()=>{
    const {svc}=setup(),long='很长的标题'.repeat(20),r=report({title:long,points:500});
    const t=svc.attachReport(r,meta('sess1','找一个 BTC 顺势策略'));
    const d=svc.detail(t.strategy_id);
    expect(t.strategy_version).toBe(1);
    expect(Array.from(d.strategy.name)).toHaveLength(60);
    expect(d.strategy).toMatchObject({status:'backtested',symbol:'BTCUSDT',timeframe:'4h',current_version:1,origin:{session_id:'sess1',inquiry_id:'inq_sess1',source:'research_loop'}});
    expect(d.strategy.summary).toMatchObject({total_return:0.1,sharpe:1,max_drawdown:-0.05,win_rate:0.5,trades:10,score:72,score_label:'good',report_id:r.id,backtested_at:r.created_at});
    expect(d.strategy.summary!.sparkline).toHaveLength(120);expect(d.strategy.summary!.sparkline.at(-1)).toBe(4.99);
    expect(d.versions[0]!.ir_hash).toBe(irHash(r.strategy_ir));expect(d.versions[0]!.report_ids).toEqual([r.id]);
    expect(validate('research-strategy',d)).toEqual({ok:true});
    // 同一份报告再广播一次是幂等的
    expect(svc.attachReport(r,meta('sess1'))).toEqual(t);expect(svc.detail(t.strategy_id).reports).toHaveLength(1);
  });
  it('规则 1:IR 哈希已在某版本 → 挂到该版本(跨会话也认),不建新策略;报告自带的哈希口径不同也按 IR 重算认出',()=>{
    const {svc,store}=setup(),a=svc.attachReport(report({title:'A'}),meta('s1'));
    const b=svc.attachReport(report({title:'完全不同的标题',irHashOverride:'wp-a-own-hash'}),meta('s2'));
    expect(b).toEqual(a);expect(store.list({}).length).toBe(1);expect(svc.detail(a.strategy_id).versions[0]!.report_ids).toHaveLength(2);
  });
  it('规则 2:本会话同名 → 加新版本并成为当前版本;改名后仍按原始标题认;别的会话同名不认',()=>{
    const {svc,store}=setup(),a=svc.attachReport(report({title:'突破策略'}),meta('s1'));
    svc.patch(a.strategy_id,{name:'我改过名字'});
    const b=svc.attachReport(report({title:'突破策略',ir:variantIR(30),m:{total_return:0.5}}),meta('s1','改成 30 根'));
    expect(b).toEqual({strategy_id:a.strategy_id,strategy_version:2});
    const d=svc.detail(a.strategy_id);expect(d.strategy.current_version).toBe(2);expect(d.strategy.summary!.total_return).toBe(0.5);
    expect(d.versions.map(v=>v.version)).toEqual([2,1]);expect(d.versions[0]!.note).toContain('改成 30 根');
    const c=svc.attachReport(report({title:'突破策略',ir:variantIR(40)}),meta('s2'));
    expect(c.strategy_id).not.toBe(a.strategy_id);expect(store.list({}).length).toBe(2);
    // 无会话的报告不走规则 2
    expect(svc.attachReport(report({title:'突破策略',ir:variantIR(50)}),meta(null)).strategy_id).not.toBe(a.strategy_id);
  });
  it('归档策略不参与匹配;报告自带 strategy_id 时挂到该策略(版本按 IR 找,找不到加新版本)',()=>{
    const {svc}=setup(),a=svc.attachReport(report(),meta('s1'));svc.archive(a.strategy_id);
    const b=svc.attachReport(report(),meta('s1'));expect(b.strategy_id).not.toBe(a.strategy_id);
    const c=svc.attachReport(report({ir:variantIR(33),strategy_id:b.strategy_id}),meta(null));
    expect(c).toEqual({strategy_id:b.strategy_id,strategy_version:2});
  });
  it('挂到非当前版本的报告不覆盖卡片摘要',()=>{
    const {svc}=setup(),id=svc.create({name:'x',strategy_ir:defaultIR()}).id;
    svc.addVersion(id,{strategy_ir:variantIR(30)});
    svc.attachReport(report({m:{total_return:0.9}}),meta(),{strategy_id:id,strategy_version:1});
    const d=svc.detail(id);expect(d.strategy.current_version).toBe(2);expect(d.strategy.summary).toBeNull();expect(d.strategy.status).toBe('backtested');
    expect(d.report).toBeNull();// 当前版本还没有报告;getBacktestReport 仍是占位
  });
  it('降采样保首尾、≤120',()=>{expect(downsample([1,2,3])).toEqual([1,2,3]);const x=downsample(Array.from({length:1000},(_,i)=>i));expect(x).toHaveLength(120);expect(x[0]).toBe(0);expect(x.at(-1)).toBe(999);});
});

describe('版本与列表',()=>{
  it('无 IR 新建是 Untitled 草稿;同 ir_hash 不新建版本;非法 IR 400;归档后不能加版本',()=>{
    const {svc}=setup(),s=svc.create({name:''});
    expect(s).toMatchObject({name:'Untitled',status:'draft',current_version:0,symbol:'BTCUSDT',timeframe:'1h',origin:{source:'manual'}});
    expect(svc.addVersion(s.id,{strategy_ir:defaultIR(),note:'v1'}).versions).toHaveLength(1);
    expect(svc.addVersion(s.id,{strategy_ir:defaultIR(),note:'again'}).versions).toHaveLength(1);
    const d=svc.addVersion(s.id,{strategy_ir:variantIR(25)});expect(d.versions.map(v=>v.version)).toEqual([2,1]);expect(d.strategy.current_version).toBe(2);
    expect(d.events.filter(e=>e.kind==='version_added')).toHaveLength(2);
    expect(()=>svc.addVersion(s.id,{strategy_ir:{version:1}})).toThrow(/invalid_contract/);
    expect(()=>svc.addVersion(s.id,{strategy_ir:defaultIR(),extra:1})).toThrow(/unknown_fields/);
    svc.archive(s.id);expect(()=>svc.addVersion(s.id,{strategy_ir:variantIR(26)})).toThrow(/conflict/);
  });
  it('列表:q 搜名称/资产、四个过滤、四种排序、计数跟随 q、归档不列',()=>{
    const {svc}=setup();
    const a=svc.create({name:'Alpha 突破',symbol:'ethusdt'}).id,b=svc.create({name:'beta 均值回归',symbol:'BTCUSDT'}).id,c=svc.create({name:'Gamma',symbol:'SOLUSDT'}).id,z=svc.create({name:'Zeta 50%'}).id;
    svc.attachReport(report({ir:variantIR(11),m:{total_return:0.3,sharpe:2}}),meta(),{strategy_id:a,strategy_version:1});
    svc.attachReport(report({ir:variantIR(12),m:{total_return:0.8,sharpe:0.5}}),meta(),{strategy_id:b,strategy_version:1});
    svc.transition(b,{to:'paper'});svc.transition(b,{to:'live',confirm:'LIVE'});
    svc.patch(a,{watchlist:true,alerts:true});svc.patch(c,{watchlist:true});svc.archive(z);
    const ids=(r:ReturnType<StrategyService['list']>)=>r.strategies.map(s=>s.id);
    const all=svc.list({});expect(ids(all)).toEqual([c,a,b]);expect(all.counts).toEqual({all:3,live:1,watchlist:2,alerts:1,draft:1});
    expect(validate('research-strategy',all)).toEqual({ok:true});
    expect(ids(svc.list({filter:'live'}))).toEqual([b]);expect(ids(svc.list({filter:'watchlist'}))).toEqual([c,a]);expect(ids(svc.list({filter:'alerts'}))).toEqual([a]);
    expect(ids(svc.list({filter:'archived'}))).toEqual([z]);
    expect(ids(svc.list({sort:'return'}))).toEqual([b,a,c]);expect(ids(svc.list({sort:'sharpe'}))).toEqual([a,b,c]);expect(ids(svc.list({sort:'name'}))).toEqual([a,b,c]);
    expect(ids(svc.list({q:'ETH'}))).toEqual([a]);expect(ids(svc.list({q:'均值'}))).toEqual([b]);expect(svc.list({q:'usdt'}).counts.all).toBe(3);
    expect(svc.list({q:'50%'}).strategies).toEqual([]);// 归档的 Zeta 50% 不列;% 不当通配
    expect(svc.list({q:'%'}).strategies).toEqual([]);
    expect(()=>svc.list({filter:'bogus'})).toThrow(/invalid_filter/);expect(()=>svc.list({sort:'bogus'})).toThrow(/invalid_sort/);
  });
  it('PATCH 记事件:改名 renamed、开关 flag_changed、没变化不记;空名 400',()=>{
    const {svc}=setup(),id=svc.create({name:'a'}).id;
    const d=svc.patch(id,{name:'b',description:'desc',watchlist:true,alerts:false});
    expect(d.strategy).toMatchObject({name:'b',description:'desc',watchlist:true,alerts:false});
    expect(d.events.map(e=>[e.kind,e.note])).toEqual([['created','手动创建(无规则草稿)'],['renamed','名称:a → b'],['renamed','描述已更新'],['flag_changed','watchlist:on']]);
    expect(()=>svc.patch(id,{name:'  '})).toThrow(/strategy_name_required/);expect(()=>svc.patch(id,{status:'live'})).toThrow(/invalid_contract/);
  });
});

describe('「策略 → 版本 → run」链:旧表反向引用',()=>{
  it('版本记下同 IR 的 research_runs、loop 修订草稿、run 的 lab 源策略',()=>{
    const {svc,db}=setup(),ir=variantIR(21),other=variantIR(22);
    db.prepare("INSERT INTO research_studies VALUES ('st',1,'{}')").run();
    const run=(id:string,man:unknown)=>db.prepare("INSERT INTO research_runs(id,idempotency_key,request_hash,study_id,status,created_at,updated_at,manifest_json) VALUES (?,?,?,'st','completed',1,1,?)").run(id,id,id,JSON.stringify(man));
    run('run_same',{request:{strategy_ir:ir},source_strategy:{id:'lab_breakout',version:3}});run('run_other',{request:{strategy_ir:other},source_strategy:null});run('run_policy',{request:{policy:{}}});run('run_from_report',{request:{},source_strategy:null});
    const art=(id:string,content:unknown)=>db.prepare("INSERT INTO research_artifacts(id,chat_id,run_id,kind,title,content_json,created_at) VALUES (?,'sess',NULL,'table','t',?,1)").run(id,typeof content==='string'?content:JSON.stringify(content));
    art('draft_same',{__research_loop_v1:{},payload:{view:'strategy_draft',ir}});art('draft_other',{__research_loop_v1:{},payload:{view:'strategy_draft',ir:other}});art('chart',{__research_loop_v1:{},payload:{view:'run_comparison'}});art('legacy_chat',{kind:'chart',data:[]});
    const t=svc.attachReport(report({ir,run_ids:['run_from_report']}),meta('sess'));
    const v=svc.detail(t.strategy_id).versions[0]!;
    expect(new Set(v.run_ids)).toEqual(new Set(['run_from_report','run_same']));expect(v.revision_refs).toEqual(['draft_same']);expect(v.lab_strategy_ref).toBe('lab_breakout@3');
    // 第二份报告带来新 run → 并集
    db.prepare("INSERT INTO research_studies VALUES ('st2',1,'{}')").run();run('run_later',{request:{},source_strategy:null});
    svc.attachReport(report({ir,run_ids:['run_later']}),meta('sess'));
    expect(svc.detail(t.strategy_id).versions[0]!.run_ids).toContain('run_later');
  });
});

describe('attach-session:新建策略草稿绑研究会话',()=>{
  it('只允许 origin.session_id 为空或相同,否则 409;记事件;归档不能绑',()=>{
    const {svc}=setup(),id=svc.create({name:'Untitled'}).id;
    const d=svc.attachSession(id,{session_id:'sA'});
    expect(d.strategy).toMatchObject({origin:{session_id:'sA',source:'manual'},session_bound:true});expect(d.events.at(-1)).toMatchObject({kind:'session_attached',note:'sA'});
    expect(svc.attachSession(id,{session_id:'sA'}).events.filter(e=>e.kind==='session_attached')).toHaveLength(1);// 相同幂等
    expect(()=>svc.attachSession(id,{session_id:'sB'})).toThrow(/conflict/);
    expect(()=>svc.attachSession(id,{session_id:''})).toThrow(/invalid_contract/);
    const auto=svc.attachReport(report({title:'别的会话来的'}),meta('sX'));// research_loop 策略自带会话 sX
    expect(()=>svc.attachSession(auto.strategy_id,{session_id:'sY'})).toThrow(/conflict/);
    expect(svc.attachSession(auto.strategy_id,{session_id:'sX'}).strategy.session_bound).toBe(true);
    const z=svc.create({name:'z'}).id;svc.archive(z);expect(()=>svc.attachSession(z,{session_id:'sZ'})).toThrow(/conflict/);
  });
  it('规则 2.5:绑定会话的草稿收首份报告作 v1 并改掉默认名,后续不同标题报告加新版本;已命名的不改名',()=>{
    const {svc,store}=setup(),id=svc.create({name:'Untitled'}).id;svc.attachSession(id,{session_id:'sA'});
    const a=svc.attachReport(report({title:'SOL 放量突破',ir:variantIR(18)}),meta('sA','找 SOL 策略'));
    expect(a).toEqual({strategy_id:id,strategy_version:1});
    let d=svc.detail(id);expect(d.strategy).toMatchObject({name:'SOL 放量突破',status:'backtested',current_version:1,timeframe:'4h',symbol:'BTCUSDT'});
    expect(d.events.map(e=>e.kind)).toEqual(['created','session_attached','version_added','renamed','backtested','transition']);
    // 标题不同也挂到绑定策略(不走同名规则、不新建)
    expect(svc.attachReport(report({title:'完全另一个标题',ir:variantIR(19)}),meta('sA'))).toEqual({strategy_id:id,strategy_version:2});
    expect(store.list({}).length).toBe(1);
    // 用户已命名的草稿不被改名
    const named=svc.create({name:'我的策略'}).id;svc.attachSession(named,{session_id:'sB'});
    svc.attachReport(report({title:'报告标题',ir:variantIR(20)}),meta('sB'));expect(svc.store.require(named).name).toBe('我的策略');
  });
  it('规则顺序:ir_hash 命中优先于会话绑定;同一会话绑多条取最近更新;未绑定会话仍走同名/新建',()=>{
    const {svc}=setup(),old=svc.attachReport(report({title:'旧策略',ir:variantIR(41)}),meta('s0'));
    const x=svc.create({name:'Untitled'}).id,y=svc.create({name:'未命名策略'}).id;svc.attachSession(x,{session_id:'sA'});svc.attachSession(y,{session_id:'sA'});
    expect(svc.attachReport(report({ir:variantIR(41)}),meta('sA'))).toEqual(old);// 规则 2 先命中
    const t=svc.attachReport(report({title:'新方向',ir:variantIR(42)}),meta('sA'));expect(t.strategy_id).toBe(y);expect(svc.store.require(y).name).toBe('新方向');
    svc.patch(x,{watchlist:true});// x 变成最近更新
    expect(svc.attachReport(report({title:'再来',ir:variantIR(43)}),meta('sA')).strategy_id).toBe(x);
    // 只有 origin.session_id(research_loop 自动建)不算绑定:不同标题仍新建
    const auto=svc.attachReport(report({title:'甲',ir:variantIR(44)}),meta('sC'));
    expect(svc.attachReport(report({title:'乙',ir:variantIR(45)}),meta('sC')).strategy_id).not.toBe(auto.strategy_id);
  });
});
