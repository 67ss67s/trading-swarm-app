/**
 * 策略对象生命周期(§9.46):状态机 + 回测报告挂链 + 旧三张表的反向引用。
 *
 * 状态机:draft →(≥1 份 completed 报告,报告挂上来时自动)→ backtested → paper ⇄ live(进 live 必须 confirm==='LIVE')
 *   backtested|paper|live → published;任意 → archived;archived → draft。其余一律 409。
 * **paper / live / published 本轮只是状态记录**:不接任何交易所写入口、不碰交易侧 lab 策略库(/api/strategies)。
 * lab_strategy_id / published_listing_id 是挂点:以后晋升到 lab 策略库、swarm/ASP 拿同一个 strategy_id 发布订阅时才写。
 *
 * 链:策略(research_strategies)→ 版本(IR 哈希不可变)→ 报告(research_backtests,WP-A)/ run(research_runs)/
 *   修订草稿(research_artifacts view=strategy_draft)。版本上存 run_ids / revision_refs / lab_strategy_ref 反向引用。
 */
import { randomUUID } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { schemas, type BacktestReport, type BacktestReportSummary, type ResearchStrategy, type ResearchStrategyBacktestRequest, type ResearchStrategyCreate, type ResearchStrategyDetail, type ResearchStrategyList, type ResearchStrategyPatch, type ResearchStrategyStatus, type ResearchStrategySummary, type ResearchStrategyTransition, type ResearchStrategyAttachSession, type StrategyIR } from '@trade-gate/contracts';
import { hash } from '../primitives.js';
import type { ResearchStore } from '../store.js';
import type { ResearchService } from '../service.js';
import type { BacktestReportMeta } from '../hooks.js';
import { getBacktestReport, runBacktestReport } from '../backtest-report.js';
import { StrategyStore, type StrategyFilter, type StrategySort } from './store.js';
import type { BuiltinImportItem, BuiltinImportResult, StrategyBindingResponse } from '@trade-gate/contracts';
import { compileBinding } from './compile-binding.js';
import { BUILTIN_IMPORTS, builtinImportSpec } from './import-builtin.js';

// ---- 契约校验(research-strategy 引用 research / research-backtest,后者又引用 research-orders,四份一起装)
const ajv=new Ajv2020({allErrors:true,strict:false});
for(const name of ['research','research-orders','research-backtest','research-strategy'] as const)ajv.addSchema(schemas[name]);
const compiled=new Map<string,ValidateFunction>();
export function checkStrategy<T>(def:string,value:unknown):T{
  let v=compiled.get(def);if(!v){v=ajv.compile({$ref:`${schemas['research-strategy'].$id}#/$defs/${def}`});compiled.set(def,v);}
  if(!v(value))throw new Error(`invalid_contract:${def}:${ajv.errorsText(v.errors)}`);
  return value as T;
}
const checkIR=(ir:unknown):StrategyIR=>{const v=ajv.getSchema(`${schemas.research.$id}#/$defs/StrategyIR`);if(!v)throw new Error('strategy_ir_schema_missing');if(!v(ir))throw new Error(`invalid_contract:StrategyIR:${ajv.errorsText(v.errors)}`);return ir as StrategyIR;};

/** IR 指纹:与 primitives.hash 同口径(canonical JSON sha256);WP-A 的 strategy_ir_hash 也应这样算,挂链时两种都认。 */
export const irHash=(ir:StrategyIR):string=>hash(ir);
const cut=(s:string,n:number)=>Array.from(s.trim()).slice(0,n).join('');

export const TRANSITIONS:Record<ResearchStrategyStatus,ResearchStrategyStatus[]>={
  draft:['backtested','archived'],
  backtested:['paper','published','archived'],
  paper:['live','published','archived'],
  live:['paper','published','archived'],
  published:['archived'],
  archived:['draft'],
};
export const allowedTransitions=(from:ResearchStrategyStatus,hasCompleted:boolean)=>TRANSITIONS[from].filter(to=>!(from==='draft'&&to==='backtested'&&!hasCompleted));

// 所有 service 实例共享归档通知(HTTP 研究服务与运行器各持一份实例)。
const archiveListeners=new Set<(id:string)=>void>();
export function onStrategyArchived(fn:(id:string)=>void):()=>void{archiveListeners.add(fn);return ()=>{archiveListeners.delete(fn);};}

// ---- 报告 → 摘要
/** 主资产:key===primary_key,否则第一个 completed,再否则第一个。 */
export function primaryAsset(r:BacktestReport){return r.assets.find(a=>a.key===r.primary_key)??r.assets.find(a=>a.status==='completed')??r.assets[0]??null;}
export const reportCompleted=(r:BacktestReport)=>{const a=primaryAsset(r);return !!a&&a.status==='completed'&&!!a.metrics;};
/** 等距降采样,保首尾;≤max 点原样返回。 */
export function downsample(xs:number[],max=120):number[]{if(xs.length<=max)return xs.slice();const out:number[]=[];for(let i=0;i<max;i++)out.push(xs[Math.round(i*(xs.length-1)/(max-1))]!);return out;}
export function reportSummary(r:BacktestReport,strategy_id:string|null,version:number|null):BacktestReportSummary{
  const a=primaryAsset(r);
  return {id:r.id,created_at:r.created_at,title:r.title,timeframe:r.timeframe,primary_key:r.primary_key,strategy_ir_hash:r.strategy_ir_hash,strategy_id,strategy_version:version,score:r.score,metrics:a?.metrics??null,sparkline:downsample((a?.equity??[]).map(p=>p.pnl_pct))};
}
export function cardSummary(r:BacktestReport):ResearchStrategySummary{
  const a=primaryAsset(r),m=a?.metrics??null;
  return {total_return:m?.total_return??null,sharpe:m?.sharpe??null,max_drawdown:m?.max_drawdown??null,win_rate:m?.win_rate??null,trades:m?.trades??null,score:r.score?.value??null,score_label:r.score?.label??null,sparkline:downsample((a?.equity??[]).map(p=>p.pnl_pct)),report_id:r.id,backtested_at:r.created_at};
}

export interface StrategyTarget {strategy_id:string;strategy_version:number}
const FILTERS=new Set<StrategyFilter>(['all','live','watchlist','alerts','archived']),SORTS=new Set<StrategySort>(['updated','return','sharpe','name']);

export class StrategyService {
  /** POST /:id/backtest 在跑时登记「这个 IR 的报告归这条策略」,监听器优先认它(同一 IR 可能出现在多条策略里)。 */
  private pending=new Map<string,StrategyTarget>();
  constructor(readonly store:StrategyStore,readonly research:ResearchStore,readonly service:ResearchService|null){}

  list(q:{q?:string|null;filter?:string|null;sort?:string|null}):ResearchStrategyList{
    const filter=(q.filter||'all') as StrategyFilter,sort=(q.sort||'updated') as StrategySort;
    if(!FILTERS.has(filter))throw new Error(`invalid_filter:${filter}`);if(!SORTS.has(sort))throw new Error(`invalid_sort:${sort}`);
    const text=q.q?.slice(0,200)??'';
    return {strategies:this.store.list({q:text,filter,sort}),counts:this.store.counts(text)};
  }

  detail(id:string,reportId?:string|null):ResearchStrategyDetail{
    const strategy=this.store.require(id),links=this.store.reports(id);
    let pick=reportId?links.find(l=>l.report_id===reportId):links.find(l=>l.version===strategy.current_version);
    if(reportId&&!pick)throw new Error('report_not_found');
    return {strategy,versions:this.store.versions(id),report:pick?getBacktestReport(this.research,pick.report_id):null,reports:links.map(l=>({...l.summary,strategy_id:l.strategy_id,strategy_version:l.version})),events:this.store.events(id),allowed_transitions:allowedTransitions(strategy.status,this.store.hasCompletedReport(id)) as ResearchStrategyDetail['allowed_transitions']};
  }

  create(raw:unknown):ResearchStrategy{
    const b=checkStrategy<ResearchStrategyCreate>('ResearchStrategyCreate',raw);
    const ir=b.strategy_ir?checkIR(b.strategy_ir):null;
    return this.store.tx(()=>{
      const id=newId();
      this.store.insert(id,{name:cut(b.name,120)||cut(ir?.label??'',120)||'Untitled',description:cut(b.description??ir?.description??'',4000),status:'draft',symbol:cut(b.symbol??'',64).toUpperCase()||'BTCUSDT',timeframe:cut(b.timeframe??'',16)||'1h',origin:{session_id:null,inquiry_id:null,source:'manual'},origin_title:null});
      this.store.event(id,'created',{to:'draft',note:ir?'手动创建':'手动创建(无规则草稿)'});
      if(ir)this.pushVersion(id,ir,'初始版本',[]);
      return this.store.require(id);
    });
  }

  patch(id:string,raw:unknown):ResearchStrategyDetail{
    const b=checkStrategy<ResearchStrategyPatch>('ResearchStrategyPatch',raw);
    this.store.tx(()=>{
      const s=this.store.require(id),fields:Parameters<StrategyStore['update']>[1]={};
      if(b.name!==undefined){const name=cut(b.name,120);if(!name)throw new Error('strategy_name_required');if(name!==s.name){fields.name=name;this.store.event(id,'renamed',{note:`名称:${s.name} → ${name}`});}}
      if(b.description!==undefined&&b.description!==s.description){fields.description=cut(b.description,4000);this.store.event(id,'renamed',{note:'描述已更新'});}
      for(const k of ['watchlist','alerts'] as const)if(b[k]!==undefined&&b[k]!==s[k]){fields[k]=b[k]?1:0;this.store.event(id,'flag_changed',{note:`${k}:${b[k]?'on':'off'}`});}
      if(Object.keys(fields).length)this.store.update(id,fields);
    });
    return this.detail(id);
  }

  transition(id:string,raw:unknown,context?:{strategy_run:true}):ResearchStrategyDetail{
    const b=checkStrategy<ResearchStrategyTransition>('ResearchStrategyTransition',raw);
    this.store.tx(()=>{
      const s=this.store.require(id),from=s.status,to=b.to;
      if(!TRANSITIONS[from].includes(to)&&!(context?.strategy_run&&from==='draft'&&to==='paper'))throw new Error(`strategy_transition_conflict:${from}->${to}`);
      if(from==='draft'&&to==='backtested'&&!this.store.hasCompletedReport(id))throw new Error('strategy_transition_conflict:needs_completed_report');
      // 进 live 的人工确认:本轮 live 只是状态记录,但仍要求输入 LIVE,以后接真实执行时这道门不用再加
      if(to==='live'&&b.confirm!=='LIVE')throw new Error('strategy_transition_conflict:live_requires_confirm');
      this.store.update(id,{status:to,archived_at:to==='archived'?this.store.now():null});
      this.store.event(id,to==='archived'?'archived':'transition',{from,to,version:s.current_version||null,note:b.note??''});
    });
    if(b.to==='archived')for(const fn of archiveListeners)fn(id);
    return this.detail(id);
  }

  /** §9.51:运行允许未回测草稿进入 paper;不伪造 backtested。发布挂点由本服务维护。 */
  activateRun(id:string,opts:{live:boolean;confirm?:string;listing_id?:string}):void{
    this.store.tx(()=>{
      let s=this.store.require(id);
      if(s.status==='archived')throw new Error('strategy_archived_conflict');
      if(opts.live&&opts.confirm!=='LIVE')throw new Error('strategy_transition_conflict:live_requires_confirm');
      if(s.status==='draft'||s.status==='backtested'){this.transition(id,{to:'paper',note:'启动策略运行'},{strategy_run:true});s=this.store.require(id);}
      if(opts.live&&s.status==='paper'){this.transition(id,{to:'live',confirm:opts.confirm,note:'启动实盘策略运行'});s=this.store.require(id);}
      if(opts.listing_id){
        this.store.update(id,{published_listing_id:opts.listing_id});
        if(s.status!=='published')this.transition(id,{to:'published',note:`策略运行发布:${opts.listing_id}`});
      }
    });
  }

  /**
   * 前端「新建策略」:先建 Untitled 草稿,再开研究会话(#research?strategy_id=&new=1),用这个把两者绑起来。
   * 只允许 origin.session_id 为空或相同(相同幂等),否则 409;绑定后该会话的回测报告按规则 2.5 挂到这条策略。
   */
  attachSession(id:string,raw:unknown):ResearchStrategyDetail{
    const b=checkStrategy<ResearchStrategyAttachSession>('ResearchStrategyAttachSession',raw);
    this.store.tx(()=>{
      const s=this.store.require(id);if(s.status==='archived')throw new Error('strategy_archived_conflict');
      if(s.origin.session_id&&s.origin.session_id!==b.session_id)throw new Error('strategy_session_conflict');
      if(s.origin.session_id===b.session_id&&s.session_bound)return;
      this.store.update(id,{origin_json:JSON.stringify({...s.origin,session_id:b.session_id}),session_bound:1});
      this.store.event(id,'session_attached',{note:b.session_id});
    });
    return this.detail(id);
  }

  archive(id:string):ResearchStrategyDetail{const s=this.store.require(id);return s.status==='archived'?this.detail(id):this.transition(id,{to:'archived',note:'DELETE'});}

  /** 同 ir_hash 不新建版本(直接返回现状)。 */
  addVersion(id:string,raw:unknown):ResearchStrategyDetail{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('expected_object_body');
    const {strategy_ir,note,...rest}=raw as {strategy_ir?:unknown;note?:unknown};
    if(Object.keys(rest).length)throw new Error(`invalid_contract:unknown_fields:${Object.keys(rest).join(',')}`);
    if(note!==undefined&&typeof note!=='string')throw new Error('invalid_contract:note_must_be_string');
    const ir=checkIR(strategy_ir);
    this.store.tx(()=>{const s=this.store.require(id);if(s.status==='archived')throw new Error('strategy_archived_conflict');if(this.store.versionByHash(id,irHash(ir))===null)this.pushVersion(id,ir,cut((note as string|undefined)??'',4000),[]);});
    return this.detail(id);
  }

  async backtest(id:string,raw:unknown,signal?:AbortSignal):Promise<{report_id:string}>{
    if(!this.service)throw new Error('research_service_unavailable');
    const b=checkStrategy<ResearchStrategyBacktestRequest>('ResearchStrategyBacktestRequest',raw??{});
    const s=this.store.require(id);if(s.status==='archived')throw new Error('strategy_archived_conflict');
    const version=b.version??s.current_version;if(!version)throw new Error('strategy_has_no_version_conflict');
    const ir=this.store.versionIR(id,version);if(!ir)throw new Error('strategy_version_not_found');
    const meta:BacktestReportMeta={session_id:s.origin.session_id,inquiry_id:s.origin.inquiry_id,question:null,symbol:s.symbol};
    const key=irHash(ir),target={strategy_id:id,strategy_version:version};
    this.pending.set(key,target);
    try{
      const report=await runBacktestReport({store:this.research,service:this.service},{strategy_ir:ir,timeframe:b.timeframe??s.timeframe,...(b.symbols?.length?{symbols:b.symbols}:{}),...(b.from_ms!==undefined?{from_ms:b.from_ms}:{}),...(b.to_ms!==undefined?{to_ms:b.to_ms}:{}),title:s.name,description:s.description,meta},signal);
      // WP-A 落库时已 emit 过则这里是幂等空操作;没 emit(或 emit 早于登记)就在这里补挂
      this.attachReport(report,meta,target);
      return {report_id:report.id};
    }finally{if(this.pending.get(key)===target)this.pending.delete(key);}
  }

  /**
   * GET /:id/binding(§9.47):把某个版本(缺省当前版本)的 IR 编译成 StrategyBinding,只读、不落库、不下发。
   * 策略没有 IR(规则未编码的导入草稿)→ binding=null,unmapped 说明缺什么。
   * 导入的内置策略把译文表里丢掉的原规则语义(gaps)并进 unmapped。
   */
  binding(id:string,versionRaw?:string|null,now=Date.now()):StrategyBindingResponse{
    const s=this.store.require(id),spec=s.origin.source==='import'?builtinImportSpec(s.lab_strategy_id):null;
    const version=versionRaw?Number(versionRaw):s.current_version;
    if(versionRaw&&!(Number.isInteger(version)&&version>0))throw new Error('invalid_version');
    const ir=version?this.store.versionIR(id,version):null;
    if(versionRaw&&!ir)throw new Error('strategy_version_not_found');
    if(!ir)return {strategy_id:id,version:null,lab_strategy_id:s.lab_strategy_id,binding:null,unmapped:spec?.gaps.length?spec.gaps:[{code:'no_ir',path:null,severity:'block',message:'这条策略还没有规则(IR),没有可编译的版本',source:'compiler'}]};
    const report_ids=this.store.reports(id).filter(r=>r.version===version).map(r=>r.report_id);
    const binding=compileBinding({strategy_id:id,version,ir,timeframe:s.timeframe,symbol:s.symbol,report_ids,...(spec?{known_gaps:spec.gaps}:{}),now});
    return {strategy_id:id,version,lab_strategy_id:s.lab_strategy_id,binding,unmapped:binding.unmapped};
  }

  /**
   * POST /import-builtin(apply-spec §7):五条内置策略译成研究台策略对象。幂等键 origin.source='import' + lab_strategy_id=<内置 id>;
   * 已存在就不新建(IR 译文变了才加新版本);backtest=true 时对「当前版本还没有完成报告」的各跑一次全窗口回测并挂上。
   * 只写研究台的表,不读写实盘策略库。
   */
  async importBuiltins(raw:unknown,signal?:AbortSignal):Promise<BuiltinImportResult>{
    const b=(raw??{}) as {backtest?:unknown;ids?:unknown};
    if(typeof b!=='object'||Array.isArray(b))throw new Error('expected_object_body');
    for(const k of Object.keys(b))if(!['backtest','ids'].includes(k))throw new Error(`invalid_contract:unknown_fields:${k}`);
    if(b.backtest!==undefined&&typeof b.backtest!=='boolean')throw new Error('invalid_contract:backtest_must_be_boolean');
    if(b.ids!==undefined&&!(Array.isArray(b.ids)&&b.ids.every(x=>typeof x==='string')))throw new Error('invalid_contract:ids_must_be_string_array');
    const ids=b.ids as string[]|undefined;
    for(const id of ids??[])if(!builtinImportSpec(id))throw new Error(`unknown_builtin:${id}`);
    const items:BuiltinImportItem[]=[];
    for(const spec of BUILTIN_IMPORTS){
      if(ids&&!ids.includes(spec.builtin_id))continue;
      const ir=spec.ir?checkIR(spec.ir):null;
      const {strategy_id,created}=this.store.tx(()=>{
        const hit=this.store.byImport(spec.builtin_id);
        if(hit){
          if(ir&&this.store.versionByHash(hit.id,irHash(ir))===null)this.pushVersion(hit.id,ir,'内置策略译文更新',[]);
          return {strategy_id:hit.id,created:false};
        }
        const id=newId();
        this.store.insert(id,{name:spec.name,description:cut(spec.description,4000),status:'draft',symbol:spec.symbol,timeframe:spec.timeframe,origin:{session_id:null,inquiry_id:null,source:'import'},origin_title:spec.builtin_id});
        this.store.update(id,{lab_strategy_id:spec.builtin_id});
        this.store.event(id,'created',{to:'draft',note:`导入内置策略 ${spec.builtin_id}(${spec.translation==='full'?'整条译成 IR':spec.translation==='partial'?'部分可译':'规则未编码'})`});
        if(ir)this.pushVersion(id,ir,`内置策略 ${spec.builtin_id} 译文`,[]);
        return {strategy_id:id,created:true};
      });
      const s=this.store.require(strategy_id);
      let report_id:string|null=this.store.reports(strategy_id).find(r=>r.version===s.current_version&&r.completed)?.report_id??null,error:string|null=null;
      if(b.backtest===true&&ir&&!report_id){
        try{report_id=(await this.backtest(strategy_id,{},signal)).report_id;}
        catch(e){error=cut(e instanceof Error?e.message:String(e),2000);}
      }
      items.push({builtin_id:spec.builtin_id,strategy_id,created,version:s.current_version||null,translation:spec.translation,report_id,error});
    }
    return {items};
  }

  /**
   * onBacktestReport 监听器本体(同步,返回值由 WP-A 写回报告的 strategy_id/strategy_version)。
   * 挂链规则按序:显式目标(本服务发起的回测 / 报告自带 strategy_id)→ IR 哈希已在某未归档策略的版本里 →
   *   本会话经 attach-session 绑定的策略(草稿首版用报告标题改掉默认名)→
   *   本会话(meta.session_id)同名策略加新版本 → 新建策略(来源 research_loop)。
   */
  attachReport(report:BacktestReport,meta:BacktestReportMeta,explicit?:StrategyTarget):StrategyTarget{
    return this.store.tx(()=>{
      const prior=this.store.link(report.id);if(prior)return {strategy_id:prior.strategy_id,strategy_version:prior.version};
      const ir=report.strategy_ir,own=irHash(ir),hashes=[...new Set([report.strategy_ir_hash,own].filter(Boolean))];
      const live=(sid:string|null|undefined)=>{const s=sid?this.store.get(sid):null;return s&&s.status!=='archived'?s:null;};
      const title=cut(report.title||ir.label||meta.question||'',200),name=cut(title,60)||'Untitled';
      let target:StrategyTarget|null=null;
      const into=(sid:string,note:string):StrategyTarget=>{const hit=hashes.map(h=>this.store.versionByHash(sid,h)).find(v=>v!==null);return {strategy_id:sid,strategy_version:hit??this.pushVersion(sid,ir,note,report.run_ids)};};
      // 显式目标只定「哪条策略」,版本仍按 IR 哈希在该策略内找(找不到才加新版本),避免报告挂到 IR 不符的版本上
      const direct=live(explicit?.strategy_id)??live(this.pending.get(own)?.strategy_id)??live(report.strategy_id);
      if(direct)target=into(direct.id,'回测报告带来的新版本');
      target??=(()=>{const h=this.store.findByHash(hashes);return h?{strategy_id:h.strategy_id,strategy_version:h.version}:null;})();
      if(!target&&meta.session_id){
        const bound=this.store.boundToSession(meta.session_id);
        if(bound){
          const first=this.store.maxVersion(bound.id)===0;
          target=into(bound.id,first?'研究会话首个版本':`研究 loop 修订:${cut(meta.question??report.title,200)}`);
          // 草稿首版:默认名换成报告标题,资产/周期跟随报告(草稿建时只是默认值)
          if(first){const f:Parameters<StrategyStore['update']>[1]={timeframe:report.timeframe,origin_title:title||null};const a=primaryAsset(report);if(a?.symbols.length===1)f.symbol=a.symbols[0]!;
            if(DEFAULT_NAMES.has(bound.name)&&name!=='Untitled'){f.name=name;this.store.event(bound.id,'renamed',{note:`名称:${bound.name} → ${name}`});}
            this.store.update(bound.id,f);}
        }
      }
      if(!target&&meta.session_id){
        // 参数扫描派生组的标题是「基准标题 · 参数 10/30」(loop/sweep.ts):按基准标题找回同一条策略,作为它的新版本而不是另起一条
        const base=title.split(' · ')[0]!,variant=base!==title;
        const s=this.store.bySessionTitle(meta.session_id,title,name)??(variant?this.store.bySessionTitle(meta.session_id,base,base):null);if(s)target=into(s.id,variant?`参数扫描:${cut(title.slice(base.length+3),120)}`:`研究 loop 修订:${cut(meta.question??report.title,200)}`);}
      if(!target){
        const id=newId(),a=primaryAsset(report),symbol=a?.symbols.length===1?a.symbols[0]!:(meta.symbol||report.primary_key);
        this.store.insert(id,{name,description:cut(report.description||ir.description||'',4000),status:'draft',symbol,timeframe:report.timeframe,origin:{session_id:meta.session_id??report.session_id,inquiry_id:meta.inquiry_id??report.inquiry_id,source:'research_loop'},origin_title:title||null});
        this.store.event(id,'created',{to:'draft',note:'研究 loop 回测自动建策略'});
        target={strategy_id:id,strategy_version:this.pushVersion(id,ir,'研究 loop 首个版本',report.run_ids)};
      }
      const completed=reportCompleted(report),s=this.store.require(target.strategy_id);
      this.store.putLink({report_id:report.id,strategy_id:target.strategy_id,version:target.strategy_version,completed,summary:reportSummary(report,target.strategy_id,target.strategy_version),created_at:report.created_at});
      this.store.mergeRefs(target.strategy_id,target.strategy_version,this.chainRefs(own,report.run_ids));
      this.store.event(target.strategy_id,'backtested',{version:target.strategy_version,note:`${report.id}${completed?'':'(未完成)'}`});
      const fields:Parameters<StrategyStore['update']>[1]={};
      if(completed&&target.strategy_version===s.current_version)fields.summary_json=JSON.stringify(cardSummary(report));
      if(completed&&s.status==='draft'){fields.status='backtested';this.store.event(s.id,'transition',{from:'draft',to:'backtested',version:target.strategy_version,note:'自动:首份完成的回测报告'});}
      this.store.update(s.id,fields);
      return target;
    });
  }

  /** 新版本号 = max+1,设为当前版本并记事件。 */
  private pushVersion(id:string,ir:StrategyIR,note:string,run_ids:string[]):number{
    const version=this.store.maxVersion(id)+1,h=irHash(ir);
    this.store.addVersion({strategy_id:id,version,ir_hash:h,ir,note,...this.chainRefs(h,run_ids)});
    this.store.update(id,{current_version:version});
    this.store.event(id,'version_added',{version,note});
    return version;
  }

  /**
   * 旧三张表 → 版本的反向引用(只读旧表,不改它们):
   *   research_runs:报告带来的 run_ids ∪ 近 500 个 manifest.request.strategy_ir 同哈希的 run;
   *   研究 loop 修订草稿:research_artifacts 里 payload.view='strategy_draft' 且 payload.ir 同哈希(近 500 条);
   *   lab 策略:这些 run 的 manifest.source_strategy(交易侧 id@version),只留痕不回写 lab。
   * 旧行 JSON 损坏等任何失败都只让引用变少,不挡挂链。
   */
  chainRefs(ir_hash:string,run_ids:string[]):{run_ids:string[];revision_refs:string[];lab_strategy_ref:string|null}{
    const runs=new Set(run_ids),revisions:string[]=[];let lab:string|null=null;
    const db=this.research.db;
    try{
      const rows=db.prepare("SELECT id,json_extract(manifest_json,'$.request.strategy_ir') AS ir,json_extract(manifest_json,'$.source_strategy.id') AS sid,json_extract(manifest_json,'$.source_strategy.version') AS sv FROM research_runs ORDER BY created_at DESC LIMIT 500").all() as {id:string;ir:string|null;sid:string|null;sv:number|null}[];
      for(const r of rows){if(!runs.has(r.id)&&!(r.ir&&hash(JSON.parse(r.ir))===ir_hash))continue;runs.add(r.id);if(!lab&&r.sid)lab=`${r.sid}@${r.sv}`;}
      for(const id of run_ids)if(!rows.some(r=>r.id===id)&&!lab){const r=db.prepare("SELECT json_extract(manifest_json,'$.source_strategy.id') AS sid,json_extract(manifest_json,'$.source_strategy.version') AS sv FROM research_runs WHERE id=?").get(id) as {sid:string|null;sv:number|null}|undefined;if(r?.sid)lab=`${r.sid}@${r.sv}`;}
    }catch(e){console.error('[research] strategy chain: runs lookup failed',e);}
    try{
      const rows=db.prepare("SELECT id,json_extract(content_json,'$.payload.ir') AS ir FROM research_artifacts WHERE json_valid(content_json) AND json_extract(content_json,'$.payload.view')='strategy_draft' ORDER BY created_at DESC LIMIT 500").all() as {id:string;ir:string|null}[];
      for(const r of rows)if(r.ir&&hash(JSON.parse(r.ir))===ir_hash)revisions.push(r.id);
    }catch(e){console.error('[research] strategy chain: revisions lookup failed',e);}
    return {run_ids:[...runs].slice(0,500),revision_refs:revisions.slice(0,200),lab_strategy_ref:lab};
  }
}
const DEFAULT_NAMES=new Set(['Untitled','未命名策略']);
const newId=()=>`rs_${randomUUID().replace(/-/g,'').slice(0,20)}`;
