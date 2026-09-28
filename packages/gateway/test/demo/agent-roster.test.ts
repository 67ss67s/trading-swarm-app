import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { BOT_ROLES } from '../../src/demo/bots.js';
import { AGENT_REGISTRY, agentSessionId, CHAT_TOOL_CATALOG } from '../../src/demo/agent-registry.js';
import { AGENT_DOC_DIR, readAgentMd } from '../../src/demo/agent-doc.js';
import { systemPrompt, runChatTurn, STRATEGY_LOOP_SKILL, type ChatTools } from '../../src/demo/chat.js';
import { aspReadonlyChatTools, ASP_CHAT_TOOLS } from '../../src/demo/asp-agent/chat-read.js';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain, type Brain } from '../../src/demo/brain.js';
import { createServer } from '../../src/demo/http.js';
import { agentCard, agentDetail } from '../../src/demo/agent-roster.js';
import { ensureResultTable } from '../../src/demo/asp-agent/services/register.js';
import { ensureBroadcastTables } from '../../src/demo/asp-agent/services/broadcast.js';
import { ProviderTaskPoller } from '../../src/demo/asp-agent/provider-tasks.js';
import { MarketCli } from '../../src/demo/asp-agent/cli.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });
function setup() {
  const state = openStateDb(':memory:'); cleanups.push(() => state.close());
  const store = new DemoStore(state);
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain() } });
  // 不 start runtime,无行情、CLI 或模型网络请求。
  return { state, store, rt };
}
function scripted(replies: string[]): Brain {
  return { name: 'fake', complete: vi.fn(async () => ({ text: replies.shift() ?? '完成', latency_ms: 0, model: 'fake', input_tokens: 0, output_tokens: 0 })) };
}

describe('身份与权限', () => {
  it('九角色顺序、callsign、固定标题、工具权限与流程图一致', () => {
    expect(Object.keys(AGENT_REGISTRY)).toEqual(BOT_ROLES);
    expect(Object.values(AGENT_REGISTRY).map((s) => s.callsign)).toEqual(['HELM','RADAR','THREAD','LAB','BOOK','SENTINEL','AUDIT','EXEC','MARKET']);
    for (const role of BOT_ROLES) {
      const spec = AGENT_REGISTRY[role], md = readFileSync(join(AGENT_DOC_DIR, `${role}.md`), 'utf8');
      expect(md.match(/^#+ .+$/gm)).toEqual([`# ${spec.name}`, ...['我是谁','我负责','我不负责(找谁)','红线','我的循环','我能调的工具','口径'].map((h) => `## ${h}`)]);
      const section = md.split('## 我能调的工具')[1]!.split('## 口径')[0]!;
      expect([...section.matchAll(/`(\w+)`/g)].map((m) => m[1])).toEqual(spec.tools);
      expect(new Set(spec.tools).size).toBe(spec.tools.length);
      for (const tool of spec.tools) expect(CHAT_TOOL_CATALOG[tool]).toBeDefined();
      const g = spec.loop.graph, ids = g.nodes.map((n) => n.id);
      expect(g.nodes.length).toBeGreaterThanOrEqual(4); expect(g.nodes.length).toBeLessThanOrEqual(8);
      expect(ids).toContain(g.entry); expect(ids).toContain('work');
      for (const e of g.edges) { expect(ids).toContain(e.from); expect(ids).toContain(e.to); }
      const prompt = systemPrompt(false, role);
      for (const tool of Object.keys(CHAT_TOOL_CATALOG)) expect(prompt.includes(`- ${tool}{`)).toBe(spec.tools.includes(tool));
      expect(prompt.includes(STRATEGY_LOOP_SKILL)).toBe(['gate_captain','strategy_lab'].includes(role));
      for (const tool of ASP_CHAT_TOOLS) expect(spec.tools.includes(tool)).toBe(role === 'asp_agent' || role === 'gate_captain' && tool === 'get_asp_overview');
    }
    expect(systemPrompt(false, 'asp_agent')).toContain('ASP');
    expect(systemPrompt(false, 'asp_agent')).toContain('Trading Swarm');
    expect(systemPrompt(false, 'asp_agent')).not.toContain('主会话');
    expect(systemPrompt(false, 'asp_agent')).toContain('(#market)');
    expect(systemPrompt(false, 'asp_agent')).not.toContain('(#judgments)');
    expect(systemPrompt(false, 'radar')).toContain('(#screener)');
    expect(systemPrompt(false, 'radar')).not.toContain('(#market)');
    expect(systemPrompt(false, null)).toEqual(systemPrompt(false, 'gate_captain'));
  });
  it('缓存按 mtime 失效;缺文件按 profile 描述兜底', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roster-doc-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'asp_agent.md');
    expect(readAgentMd('asp_agent', '本地 profile 描述', dir)).toContain('本地 profile 描述');
    writeFileSync(file, '# A'); expect(readAgentMd('asp_agent', '', dir)).toBe('# A');
    writeFileSync(file, '# B'); utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(readAgentMd('asp_agent', '', dir)).toBe('# B');
    rmSync(file); expect(readAgentMd('asp_agent', '已删除的兜底', dir)).toContain('已删除的兜底');
  });
  it('名单外工具即使存在也不能执行,只读 fallback 也受同一权限限制', async () => {
    const forbidden = vi.fn(), brain = scripted(['@@tool {"name":"list_asp_tasks","args":{}}','@@tool {"name":"get_judgment_ledger","args":{}}','完成']);
    const msg = await runChatTurn({ role: 'radar', tools: { list_asp_tasks: forbidden } as unknown as ChatTools, brain: () => brain,
      stateSummary: () => '', history: () => [], save: () => {}, emit: () => {}, log: () => {}, readonly_db: () => { throw new Error('不得读库'); } }, '查看');
    expect(forbidden).not.toHaveBeenCalled();
    expect(msg.tool_calls.map((x) => x.ok)).toEqual([false, false]);
    expect(msg.tool_calls[0]?.result).toEqual({ ok: false, error: 'not_my_tool: list_asp_tasks 属于 @MARKET,可以去找它' });
    expect(msg.tool_calls[1]?.result).toMatchObject({ error: expect.stringContaining('@AUDIT') });
  });
});

describe('规范线程与名册 HTTP', () => {
  async function http() {
    const t = setup(), server = createServer(t.rt, t.store);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json() as any };
    };
    return { ...t, request, base };
  }
  it('角色创建幂等、规范会话 409、只清指定线程、自由会话可删', async () => {
    const { request, store } = await http();
    for (const role of BOT_ROLES) {
      const a = await request('POST','/api/chat/sessions',{ role, title: '不应覆盖规范名' });
      const b = await request('POST','/api/chat/sessions',{ role });
      expect(a.status).toBe(201); expect(a.body.session).toEqual(b.body.session);
      expect(a.body.session).toMatchObject({ id: agentSessionId(role), role, title: AGENT_REGISTRY[role].name, canonical: true });
      for (const method of ['POST', 'DELETE']) {
        const r = await request(method,`/api/chat/sessions/${agentSessionId(role)}`,method === 'POST' ? { archived: true } : undefined);
        expect(r.status).toBe(409); expect(r.body.error.code).toBe('canonical_session');
      }
    }
    const msg = { at: 99, role: 'user' as const, text: '留着', tool_calls: [], episode_id: null, kind: 'chat' as const };
    store.saveChat({ ...msg, id: 'a', session_id: 'agent:asp_agent' }); store.saveChat({ ...msg, id: 'b', session_id: 'default' });
    expect((await request('POST','/api/chat/reset',{session:'agent:asp_agent'})).status).toBe(200);
    expect(store.chat(20,'chat','agent:asp_agent')).toEqual([]); expect(store.chat(20,'chat','default')).toHaveLength(1);
    const a = await request('POST','/api/chat/sessions',{}), b = await request('POST','/api/chat/sessions',{});
    expect(a.body.session.id).not.toBe(b.body.session.id); expect(a.body.session.canonical).toBe(false);
    expect((await request('DELETE',`/api/chat/sessions/${a.body.session.id}`)).status).toBe(200);
  });
  it('AgentCard 字段/可空值与 detail 形状精确;未知角色 404', async () => {
    const { request } = await http();
    const r = await request('GET','/api/agents');
    expect(r.status).toBe(200); expect(r.body.agents.map((a: any) => a.role)).toEqual(BOT_ROLES);
    expect(r.body.agents.every((a: any) => a.loop.next_run_at === null)).toBe(true);
    const asp = r.body.agents[8];
    expect(Object.keys(asp).sort()).toEqual(['role','name','callsign','tagline','enabled','session_id','message_count','last_message_at','last_text','chat','loop','tools'].sort());
    expect(asp).toMatchObject({ session_id:'agent:asp_agent',message_count:0,last_message_at:null,last_text:null,chat:{state:'idle',tool:null,since:null},loop:{current_node:null,last_run:null,next_run_at:null,pending_handoffs_in:0} });
    expect(Object.keys(asp.loop).sort()).toEqual(['cadence','status','current_node','last_run','next_run_at','pending_handoffs_in'].sort());
    const detail = await request('GET','/api/agents/asp_agent');
    expect(Object.keys(detail.body).sort()).toEqual(['agent','agent_md','graph','recent_runs','handoffs'].sort());
    expect(detail.body.handoffs).toEqual({ in:[],out:[] });
    for (const p of ['/api/agents/nope','/api/agents/constructor','/api/agents/__proto__']) expect(await request('GET',p)).toMatchObject({status:404,body:{error:{code:'unknown_role'}}});
    expect(await request('POST','/api/chat/sessions',{role:'nope'})).toMatchObject({status:404,body:{error:{code:'unknown_role'}}});
  });
  it('0052 归档历史角色线程且不搬消息,default 补语义且启动修复幂等', () => {
    const { state, store } = setup();
    state.db.prepare("INSERT INTO demo_chat_session VALUES ('old','旧角色',1,2,0,0,'asp_agent')").run();
    state.db.prepare("INSERT INTO demo_chat_session VALUES ('free','自由',1,2,0,0,NULL)").run();
    store.saveChat({id:'old-msg',at:5,role:'user',text:'历史',tool_calls:[],episode_id:null,kind:'chat',session_id:'old'});
    state.db.exec("UPDATE demo_chat_session SET role=NULL WHERE id='default'");
    state.db.exec(readFileSync(new URL('../../src/migrations/0052_agent_roster.sql',import.meta.url),'utf8'));
    store.ensureAgentSessions(); store.ensureAgentSessions();
    expect(store.chatSession('old')).toMatchObject({archived:true,canonical:false,message_count:1});
    expect(store.chatSession('free')?.archived).toBe(false);
    expect(store.chatSession('default')).toMatchObject({id:'default',role:'gate_captain',canonical:true});
    expect(store.chat(10,'chat','old')[0]?.text).toBe('历史');
    expect(store.chat(10,'chat','agent:asp_agent')).toEqual([]);
    expect(store.chatSessions().filter((s) => s.canonical)).toHaveLength(9);
  });
  it('聊天 SSE queued → thinking → tool → thinking → idle,落库后 idle;异常 error', async () => {
    const { rt, store, base } = await http();
    const brain = scripted(['@@tool {"name":"get_asp_overview","args":{}}','我是 ASP']);
    vi.spyOn(rt,'brainForRole').mockReturnValue(brain); vi.spyOn(rt,'chatStateSummary').mockReturnValue('测试状态');
    vi.spyOn(rt,'marketAgent').mockImplementation(() => { throw new Error('不得构造 ASP'); });
    const statuses: any[] = [];
    rt.on('chat.status',(e) => { statuses.push(e); if (e.state === 'idle') expect(store.chat(20,'chat',e.session_id).at(-1)?.role).toBe('agent'); });
    const abort = new AbortController(); cleanups.push(() => abort.abort());
    const stream = await fetch(base + '/api/events',{signal:abort.signal});
    const reader = stream.body!.getReader();
    const pendingRead = reader.read();
    rt.sendChat('你是谁','agent:asp_agent');
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe('idle'));
    expect(statuses.map((s) => s.state)).toEqual(['queued','thinking','tool','thinking','idle']);
    expect(statuses[2]).toMatchObject({session_id:'agent:asp_agent',role:'asp_agent',tool:'get_asp_overview',at:expect.any(Number)});
    let text = new TextDecoder().decode((await pendingRead).value);
    while (!text.includes('event: chat.status')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('event: chat.status'); abort.abort();
    expect(agentCard(rt,'asp_agent').chat.state).toBe('idle');
    vi.spyOn(rt,'brainForRole').mockReturnValue({name:'fail',complete:async () => { throw new Error('模拟模型失败'); }});
    rt.sendChat('异常','agent:asp_agent');
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe('error'));
    expect(store.chat(20,'chat','agent:asp_agent').at(-1)?.text).toContain('回复失败');
  });
});

describe('实时循环投影', () => {
  it('同角色不同 routine 的成功恢复按完成时间判断', () => {
    const {store, rt} = setup();
    store.bots.startRun({id:'early',role:'asp_agent',routine:'publish',started_at:10,budget:{}});
    store.bots.startRun({id:'late',role:'asp_agent',routine:'provider',started_at:15,budget:{}});
    store.bots.finishRun('late',{status:'done',finished_at:20});
    store.bots.finishRun('early',{status:'failed',finished_at:30,error:'后完成的失败'});
    expect(agentCard(rt,'asp_agent').loop.status).toBe('error');
  });
  it('状态优先级、真实 running 标志、成功恢复、待阅计数与交接方向', () => {
    const {rt,store} = setup(); rt.workflow.paused = false;
    store.bots.startRun({ id:'r1',role:'strategy_lab',routine:'experiment',started_at:10,budget:{} });
    expect(agentCard(rt,'strategy_lab').loop).toMatchObject({status:'running',current_node:'work'});
    store.bots.finishRun('r1',{status:'failed',finished_at:11,error:'失败'});
    expect(agentCard(rt,'strategy_lab').loop.status).toBe('error');
    store.bots.startRun({id:'r2',role:'strategy_lab',routine:'experiment',started_at:12,budget:{}});
    store.bots.finishRun('r2',{status:'done',finished_at:13});
    expect(agentCard(rt,'strategy_lab').loop.status).toBe('idle');
    vi.spyOn(rt.team,'labIsRunning').mockReturnValue(true);
    rt.workflow.paused = true;
    expect(agentCard(rt,'strategy_lab').loop.status).toBe('running');
    expect(agentCard(rt,'reviewer').loop.status).toBe('paused');
    store.bots.setEnabled('strategy_lab',false);
    expect(agentCard(rt,'strategy_lab').loop).toMatchObject({status:'disabled',current_node:null,next_run_at:null});
    for (let i=0;i<15;i++) store.bots.handoff({handoff_id:`h${i}`,run_id:null,from_role:'asp_agent',to_role:'gate_captain',kind:'alert',subject:{type:'test',id:String(i)},summary:'测试',evidence_refs:[],artifact_refs:[],requested_output_schema:null,priority:1,deadline_at:null,idempotency_key:`h${i}`,payload:{}});
    expect(agentCard(rt,'gate_captain').loop.pending_handoffs_in).toBe(15);
    expect(agentDetail(rt,'asp_agent').handoffs.out).toHaveLength(10);
    expect(agentDetail(rt,'asp_agent').handoffs.in).toHaveLength(0);
  });
});

describe('规范线程并发排队', () => {
  it('后续消息不覆盖当前 thinking,按 A/B/C 顺序执行且不串会话', async () => {
    const {rt,store} = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    vi.spyOn(rt,'brainForRole').mockReturnValue({name:'fake',complete:async (_system,prompt) => {
      const text = prompt.split('用户:').at(-1)!; order.push(text);
      if (text === 'A') await gate;
      return {text:`回复 ${text}`,latency_ms:0,model:'fake',input_tokens:0,output_tokens:0};
    }});
    vi.spyOn(rt,'chatStateSummary').mockReturnValue('测试状态');
    rt.sendChat('A','agent:asp_agent'); rt.sendChat('B','agent:asp_agent'); rt.sendChat('C','agent:asp_agent');
    expect(rt.chatStatus('agent:asp_agent').state).toBe('thinking');
    expect(rt.chatStatus('default').state).toBe('idle');
    release();
    await vi.waitFor(() => expect(store.chat(20,'chat','agent:asp_agent').filter((m) => m.role === 'agent')).toHaveLength(3));
    expect(order).toEqual(['A','B','C']);
    expect(rt.chatStatus('agent:asp_agent').state).toBe('idle');
  });
});

describe('ASP 零写入与逐块降级', () => {
  it('无表或局部缺表都不抛出,每块给 ready:false;链接第一项', () => {
    const db = new DatabaseSync(':memory:'); cleanups.push(() => db.close());
    const kvGet = (key: string) => String(db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.['value'] ?? '') || null;
    const tools = aspReadonlyChatTools({db,kvGet});
    db.exec('PRAGMA query_only=ON');
    const overview = tools.get_asp_overview();
    for (const k of ['identity','services','subscribers','publisher','provider_tasks','claimable','recent_errors']) expect(overview[k]).toMatchObject({ready:false,reason:expect.any(String)});
    for (const name of ASP_CHAT_TOOLS) expect(Object.keys(tools[name]())[0]).toBe('links');
  });
  it('读真形状账本和快照,脱敏且不会把未交付任务挤出 open 列表', () => {
    const {state,store,rt} = setup();
    const cli = new MarketCli(async () => { throw new Error('不许调用 CLI'); });
    new ProviderTaskPoller({store,cli,aspId:async()=>null,ensureSession:async()=>false,log:()=>{},emit:()=>{}});
    ensureResultTable(state.db); ensureBroadcastTables(state.db);
    store.kvSet('market.asp_identity',JSON.stringify({at:100,value:{asp:{agentId:'13866',name:'Trading Swarm'}}}));
    store.kvSet('asp_services.config',JSON.stringify({service_ids:{market_intel:'svc'}}));
    store.bots.startRun({id:'cli-error',role:'asp_agent',routine:'provider',started_at:80,budget:{}});
    store.bots.finishRun('cli-error',{status:'failed',finished_at:90,error:'Command failed: onchainos agent --data private-payload\nprivate-second-line'});
    const insert = state.db.prepare('INSERT INTO okx_market_provider_task(job_id,kind,service_id,buyer_agent_id,state,remote_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
    insert.run('private-job-old','one_time','svc','private-buyer','deliver_unknown',1,1,1);
    for (let i=0;i<25;i++) insert.run(`private-job-${i}`,'subscription','svc','private-buyer','delivered',1,2+i,2+i);
    state.db.exec('PRAGMA query_only=ON');
    const changed = state.db.prepare('SELECT total_changes() AS n').get()!['n'];
    const snapshot = { services:null, subscribers:{at:100,value:[{jobId:'private-job',buyerAgentId:'private-buyer',serviceId:'svc',status:'ACTIVE',trialType:1}]}, claimable:{at:100,value:'1.2500'},registered:true,running:true };
    const tools = aspReadonlyChatTools({db:state.db,kvGet:(k)=>store.kvGet(k),now:()=>101,live:()=>({services:snapshot})});
    expect(tools.get_asp_overview()).toMatchObject({identity:{ready:true,agent_id:'13866'},subscribers:{ready:true,count:1,groups:{trial:1}},claimable:{ready:true,amount:'1.2500'}});
    expect(JSON.stringify(tools.get_asp_overview())).not.toContain('private-');
    const list = tools.list_asp_services() as any; expect(list.items).toHaveLength(7); expect(list.items[0].delivery).toEqual({ready:true,deliveries:25,last_delivery_at:26});
    // 远端对象存在但 fee 不可用时,不能把本地/建议价格标成平台价格。
    for (const [fee, local, price, source] of [['bad','2.50','2.50','local_config'],['bad','bad',list.items[0].price,'suggested_default'],['1.05','2.50','1.05','cached_listing']]) {
      const fallback = aspReadonlyChatTools({db:state.db,kvGet:(k)=>k === 'asp_services.prices' ? JSON.stringify({market_intel:local}) : store.kvGet(k),
        live:()=>({services:{...snapshot,services:{asp:'13866',at:100,value:{agent:{},items:[{serviceId:'svc',fee}]}}}})});
      expect((fallback.list_asp_services() as any).items[0]).toMatchObject({price,price_source:source});
    }
    expect((tools.list_asp_tasks({status:'open',limit:1}) as any).items[0]).toMatchObject({state:'deliver_unknown',reconciliation:{remote_status:1,unknown:true}});
    expect(JSON.stringify(tools.list_asp_subscribers())).not.toContain('private-');
    expect(Object.keys(rt.chatTools()).filter((n)=>ASP_CHAT_TOOLS.includes(n as any))).toEqual([...ASP_CHAT_TOOLS]);
    expect(state.db.prepare('SELECT total_changes() AS n').get()!['n']).toBe(changed);
    expect(()=>tools.list_asp_tasks({status:'bad'})).toThrow('status 只能是');
    expect(()=>tools.list_market_inbox({limit:101})).toThrow('limit 必须');
  });
  it('七项服务明细进入后续模型上下文,不被旧 4k 限额截断', async () => {
    const {state,store} = setup();
    const tools = aspReadonlyChatTools({db:state.db,kvGet:(k)=>store.kvGet(k)});
    const result = tools.list_asp_services();
    expect(JSON.stringify(result).length).toBeGreaterThan(4000);
    expect(JSON.stringify(result).length).toBeLessThan(16_000);
    const brain = scripted(['@@tool {"name":"list_asp_services","args":{}}','已读取七项服务']);
    await runChatTurn({role:'asp_agent',tools:tools as unknown as ChatTools,brain:()=>brain,stateSummary:()=>'',history:()=>[],save:()=>{},emit:()=>{},log:()=>{}},'全部服务');
    expect(vi.mocked(brain.complete).mock.calls[1]![1]).toContain(JSON.stringify(result));
  });
});
