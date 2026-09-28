// 公网演示的访客对话:每个访客只看得到自己建的会话;问答带一组只读工具(推荐资产、Radar 筛选、我的策略、回测报告、
// Jev 实盘判断),模型吐出的任何写操作指令都只是文本。每轮模型调用由大脑层计费,每次工具调用另按
// TG_DEMO_TOOL_CALL_USD 名义单价计入同一个日花费上限。
import { randomUUID } from 'node:crypto';
import type { DemoRuntime } from './runtime.js';
import type { DemoStore } from './store.js';
import type { ChatMessage, ChatSession, ChatToolCall } from './types.js';
import { CHAT_TOOL_CATALOG } from './agent-registry.js';
import { parseToolLine, readonlyChatTools } from './chat.js';
import { judgeLiveSummary } from './judge-live.js';
import { claimSlot, DemoDenied, microUsd, reserveDemoCost, visitorContext } from './public-demo.js';
import { publicView, redactPublicText } from './public-view.js';

const MAX_QUESTION_CHARS = 2000;
const CHAT_TIMEOUT_MS = 60_000;
const MAX_TOOL_ROUNDS = 3;
const TOOL_RESULT_CHARS = 4000;

type VisitorTool = (rt: DemoRuntime, store: DemoStore, args: Record<string, unknown>) => unknown;

const JUDGE_LIVE_DOC = 'get_judge_live{"limit":10}:Jev 实盘影子判断(只读):最近几条判断(品种、方向、结论、置信度)和汇总统计。用户问「Jev/AI 判断得怎么样」「最近判断了什么」时调它。';

/** 访客可用的只读工具。名字与 agent 工具目录一致,前端据此渲染推荐卡等。 */
export const VISITOR_CHAT_TOOLS: Record<string, { doc: string; run: VisitorTool }> = {
  recommend_assets: {
    doc: CHAT_TOOL_CATALOG['recommend_assets']!.doc,
    run: (rt, _store, args) => rt.chatTools(null).recommend_assets!(args as Parameters<NonNullable<ReturnType<DemoRuntime['chatTools']>['recommend_assets']>>[0]),
  },
  get_screen: {
    doc: CHAT_TOOL_CATALOG['get_screen']!.doc,
    run: (rt, _store, args) => rt.chatTools(null).get_screen(args as { horizon?: 'short' | 'swing' | 'weekly' }),
  },
  list_my_strategies: {
    doc: CHAT_TOOL_CATALOG['list_my_strategies']!.doc,
    run: (_rt, store, args) => readonlyChatTools(store.marketDb).list_my_strategies(args),
  },
  get_backtest_report: {
    doc: CHAT_TOOL_CATALOG['get_backtest_report']!.doc,
    run: (_rt, store, args) => readonlyChatTools(store.marketDb).get_backtest_report(args),
  },
  get_judge_live: {
    doc: JUDGE_LIVE_DOC,
    run: (rt, store, args) => {
      const limit = Math.min(20, Math.max(1, Number(args['limit'] ?? 10) || 10));
      const ledger = rt.strategyRuns().judgeLedger;
      return {
        summary: judgeLiveSummary(store.marketDb, ledger, { now: Date.now(), run_id: null, outcome: () => null }),
        items: ledger.list({ limit }),
        links: [{ label: 'Jev 实盘判断', href: '#judgments' }],
      };
    },
  },
};

function systemPrompt(): string {
  return [
    '你是 Trading Swarm 的公开演示助手,面向 OKX 评审。用户用什么语言提问就用什么语言回答。',
    '可以解释本系统的交易研究、风险控制、策略与多 agent 协作方式,以及页面上看到的数据。',
    '当前是 OKX 模拟盘 / paper 演示:你只有下面这些只读工具,没有下单、改设置或账户管理的工具,不要声称执行了任何操作,也不要给出真实投资建议。',
    '调用工具时单独一行写:@@tool {"name":"<工具名>","args":{...}}。一次一个,拿到 @@result 再继续;不需要工具就直接回答。',
    '工具清单:',
    ...Object.values(VISITOR_CHAT_TOOLS).map((t) => `- ${t.doc}`),
  ].join('\n');
}

export function ownsDemoSession(store: DemoStore, sessionId: string, visitor: string): boolean {
  return Boolean(store.marketDb.prepare('SELECT 1 FROM ops_demo_sessions WHERE id = ? AND visitor = ?').get(sessionId, visitor));
}

export function newDemoSession(store: DemoStore, title: string): ChatSession {
  const ctx = visitorContext();
  if (!ctx) throw new Error('newDemoSession 只用于访客');
  const session = store.createChatSession(`评审 · ${title.slice(0, 60) || '对话'}`);
  store.marketDb.prepare('INSERT INTO ops_demo_sessions(id, visitor, created_at) VALUES (?, ?, ?)').run(session.id, ctx.visitor, Date.now());
  return session;
}

export function demoSessions(store: DemoStore): ChatSession[] {
  const ctx = visitorContext();
  if (!ctx) return [];
  const rows = store.marketDb.prepare('SELECT id FROM ops_demo_sessions WHERE visitor = ? ORDER BY created_at DESC LIMIT 100').all(ctx.visitor) as { id: string }[];
  return rows.map((r) => store.chatSession(r.id)).filter((s): s is ChatSession => s !== null);
}

async function runVisitorTool(rt: DemoRuntime, store: DemoStore, name: string, args: Record<string, unknown>): Promise<{ result: unknown; ok: boolean }> {
  const tool = Object.hasOwn(VISITOR_CHAT_TOOLS, name) ? VISITOR_CHAT_TOOLS[name] : undefined;
  if (!tool) return { result: { error: `Locked in the review demo: tool ${name} is not available to visitors.` }, ok: false };
  reserveDemoCost(microUsd(process.env['TG_DEMO_TOOL_CALL_USD'] || '0.001'));
  try {
    return { result: publicView(await tool.run(rt, store, args)), ok: true };
  } catch (e) {
    return { result: { error: redactPublicText((e as Error).message) }, ok: false };
  }
}

export async function publicChat(rt: DemoRuntime, store: DemoStore, body: Record<string, unknown>): Promise<{ accepted: true; queued: false; session: string }> {
  const ctx = visitorContext();
  if (!ctx) throw new Error('publicChat 只用于访客');
  const text = typeof body['text'] === 'string' ? body['text'].trim().slice(0, MAX_QUESTION_CHARS) : '';
  if (!text) throw new DemoDenied('Please enter a question.', 'invalid', 400);
  let session = typeof body['session'] === 'string' ? body['session'] : '';
  if (!session || session === 'default') session = newDemoSession(store, text.slice(0, 20)).id;
  if (!ownsDemoSession(store, session, ctx.visitor)) throw new DemoDenied('Locked in the review demo: this conversation belongs to another visitor.');

  const release = claimSlot('chat');
  const save = (role: 'user' | 'agent', message: string, toolCalls: ChatToolCall[] = []): void => {
    const row: ChatMessage = { id: randomUUID(), at: Date.now(), role, text: message, kind: 'chat', tool_calls: toolCalls, episode_id: null, session_id: session };
    store.saveChat(row);
    rt.emit('chat.message', row);
  };
  try {
    save('user', text);
    const toolCalls: ChatToolCall[] = [];
    try {
      const brain = rt.brainForRole('chat');
      let convo = `用户:${text}`;
      let answer = '';
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const reply = await brain.complete(systemPrompt(), convo, { timeoutMs: CHAT_TIMEOUT_MS });
        const call = round < MAX_TOOL_ROUNDS ? parseToolLine(reply.text) : null;
        const visible = reply.text.replace(/^@@tool[^\n]*$/m, '').trim();
        if (!call) {
          answer = visible || reply.text.trim();
          break;
        }
        const { result, ok } = await runVisitorTool(rt, store, call.name, call.args);
        toolCalls.push({ name: call.name, args: call.args, result, ok });
        convo += `\n\nagent:${visible ? `${visible}\n` : ''}@@tool ${JSON.stringify(call)}\n@@result ${JSON.stringify(result).slice(0, TOOL_RESULT_CHARS)}\n(继续:如果还需要工具就再调,否则给用户最终回复。)`;
      }
      save('agent', redactPublicText(answer || '(no answer)'), toolCalls);
    } catch (e) {
      save('agent', e instanceof DemoDenied ? e.message : 'The demo assistant is temporarily unavailable. Please retry later.', toolCalls);
      throw e;
    }
    return { accepted: true, queued: false, session };
  } finally {
    release();
  }
}
