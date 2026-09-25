/**
 * 策略对象持久化(migrations/0032):research_strategies / _versions / _reports / _events。
 * 只做 SQL 读写和行↔契约对象的转换;状态机和挂链规则在 service.ts。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BacktestReportSummary, ResearchStrategy, ResearchStrategyEvent, ResearchStrategyEventKind, ResearchStrategyOrigin, ResearchStrategyStatus, ResearchStrategySummary, ResearchStrategyVersion, StrategyIR } from '@trading-swarm/contracts';

export type StrategyFilter = 'all' | 'live' | 'watchlist' | 'alerts' | 'archived';
export type StrategySort = 'updated' | 'return' | 'sharpe' | 'name';
interface StrategyRow {id:string;name:string;description:string;status:ResearchStrategyStatus;symbol:string;timeframe:string;watchlist:number;alerts:number;current_version:number;origin_json:string;origin_title:string|null;session_bound:number;summary_json:string|null;lab_strategy_id:string|null;published_listing_id:string|null;created_at:number;updated_at:number;archived_at:number|null}
interface VersionRow {strategy_id:string;version:number;ir_hash:string;ir_json:string;note:string;run_ids_json:string;revision_refs_json:string;lab_strategy_ref:string|null;created_at:number}
export interface ReportLink {report_id:string;strategy_id:string;version:number;completed:boolean;summary:BacktestReportSummary;created_at:number}
export interface NewStrategy {name:string;description:string;status:ResearchStrategyStatus;symbol:string;timeframe:string;origin:ResearchStrategyOrigin;origin_title:string|null}

const toStrategy=(r:StrategyRow):ResearchStrategy=>({id:r.id,name:r.name,description:r.description,status:r.status,symbol:r.symbol,timeframe:r.timeframe,watchlist:!!r.watchlist,alerts:!!r.alerts,current_version:r.current_version,created_at:r.created_at,updated_at:r.updated_at,origin:JSON.parse(r.origin_json) as ResearchStrategyOrigin,summary:r.summary_json?JSON.parse(r.summary_json) as ResearchStrategySummary:null,lab_strategy_id:r.lab_strategy_id,published_listing_id:r.published_listing_id,session_bound:!!r.session_bound});
// LIKE 转义:用户搜 `50%` 不该变成通配
const like=(q:string)=>`%${q.toLowerCase().replace(/[\\%_]/g,m=>'\\'+m)}%`;
const SORT:Record<StrategySort,string>={updated:'updated_at DESC,created_at DESC,id',return:"json_extract(summary_json,'$.total_return') DESC NULLS LAST,updated_at DESC,id",sharpe:"json_extract(summary_json,'$.sharpe') DESC NULLS LAST,updated_at DESC,id",name:'name COLLATE NOCASE,updated_at DESC,id'};

export class StrategyStore {
  constructor(readonly db:DatabaseSync,readonly now:()=>number=Date.now){}
  tx<T>(fn:()=>T):T{this.db.exec('SAVEPOINT research_strategy');try{const out=fn();this.db.exec('RELEASE research_strategy');return out;}catch(e){this.db.exec('ROLLBACK TO research_strategy');this.db.exec('RELEASE research_strategy');throw e;}}
  insert(id:string,s:NewStrategy):void{const at=this.now();this.db.prepare('INSERT INTO research_strategies(id,name,description,status,symbol,timeframe,origin_json,origin_title,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,s.name,s.description,s.status,s.symbol,s.timeframe,JSON.stringify(s.origin),s.origin_title,at,at);}
  get(id:string):ResearchStrategy|null{const r=this.db.prepare('SELECT * FROM research_strategies WHERE id=?').get(id) as StrategyRow|undefined;return r?toStrategy(r):null;}
  require(id:string):ResearchStrategy{const s=this.get(id);if(!s)throw new Error('strategy_not_found');return s;}
  /** 只改给了的列,顺手刷新 updated_at;列名来自代码常量,不接用户输入。 */
  update(id:string,fields:Partial<Record<'name'|'description'|'status'|'symbol'|'timeframe'|'watchlist'|'alerts'|'current_version'|'summary_json'|'archived_at'|'lab_strategy_id'|'published_listing_id'|'origin_json'|'origin_title'|'session_bound',string|number|null>>):void{
    const keys=Object.keys(fields) as (keyof typeof fields)[];
    this.db.prepare(`UPDATE research_strategies SET ${[...keys.map(k=>`${k}=?`),'updated_at=?'].join(',')} WHERE id=?`).run(...keys.map(k=>fields[k]??null),this.now(),id);
  }
  list(opts:{q?:string;filter?:StrategyFilter;sort?:StrategySort;limit?:number}):ResearchStrategy[]{
    const where=[opts.filter==='archived'?"status='archived'":"status<>'archived'"],args:(string|number)[]=[];
    if(opts.q?.trim()){where.push("(lower(name) LIKE ? ESCAPE '\\' OR lower(symbol) LIKE ? ESCAPE '\\')");args.push(like(opts.q.trim()),like(opts.q.trim()));}
    if(opts.filter==='live')where.push("status='live'");else if(opts.filter==='watchlist')where.push('watchlist=1');else if(opts.filter==='alerts')where.push('alerts=1');
    return (this.db.prepare(`SELECT * FROM research_strategies WHERE ${where.join(' AND ')} ORDER BY ${SORT[opts.sort??'updated']} LIMIT ?`).all(...args,Math.min(5000,opts.limit??5000)) as unknown as StrategyRow[]).map(toStrategy);
  }
  /** 四个 tab + 草稿数,跟随 q 过滤,不含 archived。 */
  counts(q?:string){
    const w=q?.trim()?"AND (lower(name) LIKE ? ESCAPE '\\' OR lower(symbol) LIKE ? ESCAPE '\\')":'',args=q?.trim()?[like(q.trim()),like(q.trim())]:[];
    const r=this.db.prepare(`SELECT count(*) AS all_n,sum(status='live') AS live,sum(watchlist) AS watchlist,sum(alerts) AS alerts,sum(status='draft') AS draft FROM research_strategies WHERE status<>'archived' ${w}`).get(...args) as {all_n:number;live:number|null;watchlist:number|null;alerts:number|null;draft:number|null};
    return {all:r.all_n,live:r.live??0,watchlist:r.watchlist??0,alerts:r.alerts??0,draft:r.draft??0};
  }
  /** 规则 2:本会话同名(原始标题或当前名字),不含归档。 */
  bySessionTitle(session_id:string,title:string,name:string):ResearchStrategy|null{const r=this.db.prepare("SELECT * FROM research_strategies WHERE origin_session_id=? AND (origin_title=? OR name=?) AND status<>'archived' ORDER BY updated_at DESC LIMIT 1").get(session_id,title,name) as StrategyRow|undefined;return r?toStrategy(r):null;}

  /** 新规则 2.5:经 attach-session 绑定到该会话的策略,多条取最近更新,不含归档。 */
  boundToSession(session_id:string):ResearchStrategy|null{const r=this.db.prepare("SELECT * FROM research_strategies WHERE origin_session_id=? AND session_bound=1 AND status<>'archived' ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(session_id) as StrategyRow|undefined;return r?toStrategy(r):null;}

  /** 内置策略导入的幂等键:origin.source='import' 且 lab_strategy_id=<内置 id>,不含归档;多条取最早建的那条 */
  byImport(builtin_id:string):ResearchStrategy|null{const r=this.db.prepare("SELECT * FROM research_strategies WHERE lab_strategy_id=? AND json_extract(origin_json,'$.source')='import' AND status<>'archived' ORDER BY created_at,rowid LIMIT 1").get(builtin_id) as StrategyRow|undefined;return r?toStrategy(r):null;}

  // ---- 版本
  addVersion(v:{strategy_id:string;version:number;ir_hash:string;ir:StrategyIR;note:string;run_ids:string[];revision_refs:string[];lab_strategy_ref:string|null}):void{this.db.prepare('INSERT INTO research_strategy_versions VALUES (?,?,?,?,?,?,?,?,?)').run(v.strategy_id,v.version,v.ir_hash,JSON.stringify(v.ir),v.note,JSON.stringify(v.run_ids),JSON.stringify(v.revision_refs),v.lab_strategy_ref,this.now());}
  /** 链上反向引用只增不减(并集),版本本体(IR)不可变。 */
  mergeRefs(strategy_id:string,version:number,refs:{run_ids:string[];revision_refs:string[];lab_strategy_ref:string|null}):void{
    const r=this.db.prepare('SELECT run_ids_json,revision_refs_json,lab_strategy_ref FROM research_strategy_versions WHERE strategy_id=? AND version=?').get(strategy_id,version) as {run_ids_json:string;revision_refs_json:string;lab_strategy_ref:string|null}|undefined;if(!r)return;
    const u=(a:string,b:string[])=>JSON.stringify([...new Set([...(JSON.parse(a) as string[]),...b])].slice(0,500));
    this.db.prepare('UPDATE research_strategy_versions SET run_ids_json=?,revision_refs_json=?,lab_strategy_ref=? WHERE strategy_id=? AND version=?').run(u(r.run_ids_json,refs.run_ids),u(r.revision_refs_json,refs.revision_refs),r.lab_strategy_ref??refs.lab_strategy_ref,strategy_id,version);
  }
  maxVersion(strategy_id:string):number{return (this.db.prepare('SELECT max(version) AS v FROM research_strategy_versions WHERE strategy_id=?').get(strategy_id) as {v:number|null}).v??0;}
  versionByHash(strategy_id:string,ir_hash:string):number|null{return (this.db.prepare('SELECT version FROM research_strategy_versions WHERE strategy_id=? AND ir_hash=?').get(strategy_id,ir_hash) as {version:number}|undefined)?.version??null;}
  /** 规则 1:任一哈希命中任一未归档策略的版本;多个命中取最近更新的策略。 */
  findByHash(hashes:string[]):{strategy_id:string;version:number}|null{
    if(!hashes.length)return null;
    return (this.db.prepare(`SELECT v.strategy_id,v.version FROM research_strategy_versions v JOIN research_strategies s ON s.id=v.strategy_id WHERE v.ir_hash IN (${hashes.map(()=>'?').join(',')}) AND s.status<>'archived' ORDER BY s.updated_at DESC,v.version DESC LIMIT 1`).get(...hashes) as {strategy_id:string;version:number}|undefined)??null;
  }
  versionIR(strategy_id:string,version:number):StrategyIR|null{const r=this.db.prepare('SELECT ir_json FROM research_strategy_versions WHERE strategy_id=? AND version=?').get(strategy_id,version) as {ir_json:string}|undefined;return r?JSON.parse(r.ir_json) as StrategyIR:null;}
  versions(strategy_id:string):ResearchStrategyVersion[]{
    const reports=this.reports(strategy_id);
    return (this.db.prepare('SELECT * FROM research_strategy_versions WHERE strategy_id=? ORDER BY version DESC LIMIT 1000').all(strategy_id) as unknown as VersionRow[]).map(v=>({strategy_id:v.strategy_id,version:v.version,ir_hash:v.ir_hash,strategy_ir:JSON.parse(v.ir_json) as StrategyIR,note:v.note,created_at:v.created_at,report_ids:reports.filter(r=>r.version===v.version).map(r=>r.report_id).slice(0,500),run_ids:JSON.parse(v.run_ids_json) as string[],revision_refs:JSON.parse(v.revision_refs_json) as string[],lab_strategy_ref:v.lab_strategy_ref}));
  }

  // ---- 报告挂链
  link(report_id:string):ReportLink|null{const r=this.db.prepare('SELECT * FROM research_strategy_reports WHERE report_id=?').get(report_id) as {report_id:string;strategy_id:string;version:number;completed:number;summary_json:string;created_at:number}|undefined;return r?{report_id:r.report_id,strategy_id:r.strategy_id,version:r.version,completed:!!r.completed,summary:JSON.parse(r.summary_json) as BacktestReportSummary,created_at:r.created_at}:null;}
  putLink(l:ReportLink):void{this.db.prepare('INSERT INTO research_strategy_reports VALUES (?,?,?,?,?,?,?)').run(l.report_id,l.strategy_id,l.version,l.completed?1:0,JSON.stringify(l.summary),l.created_at,this.now());}
  /** 新到旧;created_at 同毫秒时按挂链先后。 */
  reports(strategy_id:string):ReportLink[]{return (this.db.prepare('SELECT * FROM research_strategy_reports WHERE strategy_id=? ORDER BY created_at DESC,attached_at DESC,rowid DESC LIMIT 500').all(strategy_id) as unknown as {report_id:string;strategy_id:string;version:number;completed:number;summary_json:string;created_at:number}[]).map(r=>({report_id:r.report_id,strategy_id:r.strategy_id,version:r.version,completed:!!r.completed,summary:JSON.parse(r.summary_json) as BacktestReportSummary,created_at:r.created_at}));}
  hasCompletedReport(strategy_id:string):boolean{return !!this.db.prepare('SELECT 1 FROM research_strategy_reports WHERE strategy_id=? AND completed=1 LIMIT 1').get(strategy_id);}

  // ---- 事件
  event(strategy_id:string,kind:ResearchStrategyEventKind,e:{from?:ResearchStrategyStatus|null;to?:ResearchStrategyStatus|null;version?:number|null;note?:string}={}):void{this.db.prepare('INSERT INTO research_strategy_events(strategy_id,at,kind,from_status,to_status,version,note) VALUES (?,?,?,?,?,?,?)').run(strategy_id,this.now(),kind,e.from??null,e.to??null,e.version??null,(e.note??'').slice(0,4000));}
  events(strategy_id:string):ResearchStrategyEvent[]{return (this.db.prepare('SELECT * FROM (SELECT * FROM research_strategy_events WHERE strategy_id=? ORDER BY seq DESC LIMIT 2000) ORDER BY seq').all(strategy_id) as unknown as {at:number;kind:ResearchStrategyEventKind;from_status:ResearchStrategyStatus|null;to_status:ResearchStrategyStatus|null;version:number|null;note:string}[]).map(e=>({at:e.at,kind:e.kind,from:e.from_status,to:e.to_status,version:e.version,note:e.note}));}
}
