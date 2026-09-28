/**
 * §9.55 九个 agent 的名册 / 详情 hooks。
 * 每个 agent 一条规范线程:gate_captain = "default",其余 = "agent:<role>"。楼层对话框与 Agent 页读写同一个 session id,
 * SSE `chat.message` 按前缀失效 ['chat-messages'] → 两边自动同步;`chat.status` 写进 ['agents'] 缓存给「正在输入」。
 * 老网关没有 /api/agents 时退回静态名册(同样的 session id 约定),对话照常能发。
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { AgentCard, AgentChatStatusEvent, AgentsResponse, BotRole } from './types';
import { t } from '@/lib/i18n';

export const AGENT_ROLES: BotRole[] = ['gate_captain', 'radar', 'thread_manager', 'strategy_lab', 'portfolio_manager', 'risk_sentinel', 'reviewer', 'executor', 'asp_agent'];

export const AGENT_CALLSIGN: Record<BotRole, string> = { gate_captain: 'HELM', radar: 'RADAR', thread_manager: 'THREAD', strategy_lab: 'LAB', portfolio_manager: 'BOOK', risk_sentinel: 'SENTINEL', reviewer: 'AUDIT', executor: 'EXEC', asp_agent: 'MARKET' };

const FALLBACK_NAME: Record<BotRole, [string, string]> = {
  gate_captain: ['Gate Captain', '总协调:汇总团队、把你的目标派给合适的人'],
  radar: ['Radar', '信息与发现:筛候选、盯观察列表'],
  thread_manager: ['Thread Manager', '交易论点:判断某个币、复查线程'],
  strategy_lab: ['Strategy Lab', '研究:推荐 → 批量验证 → 存成策略'],
  portfolio_manager: ['Portfolio Manager', '组合:账户敞口、簇集中度、止损预算'],
  risk_sentinel: ['Risk Sentinel', '风控:开放告警、为什么挡新开仓'],
  reviewer: ['Reviewer', '复盘:平仓复盘卡与教训'],
  executor: ['Executor', '执行:待批意图、执行通道与回执'],
  asp_agent: ['ASP Agent', 'OKX.AI 信号市场:身份、服务、订阅、接单与领款'],
};

export const agentSessionId = (role: BotRole): string => (role === 'gate_captain' ? 'default' : `agent:${role}`);

export const isAgentRole = (r: unknown): r is BotRole => typeof r === 'string' && (AGENT_ROLES as string[]).includes(r);

/** session id → 它属于哪个 agent(规范线程才有);自由会话返回 null */
export function roleOfSession(session: string): BotRole | null {
  if (session === 'default') return 'gate_captain';
  const m = /^agent:([a-z_]+)$/.exec(session);
  return m && isAgentRole(m[1]) ? m[1] : null;
}

function fallbackCard(role: BotRole): AgentCard {
  const [name, tagline] = FALLBACK_NAME[role];
  return {
    role,
    name,
    callsign: AGENT_CALLSIGN[role],
    tagline: t(tagline),
    enabled: true,
    session_id: agentSessionId(role),
    message_count: 0,
    last_message_at: null,
    last_text: null,
    chat: { state: 'idle', tool: null, since: null },
    loop: { cadence: '', status: 'idle', current_node: null, last_run: null, next_run_at: null, pending_handoffs_in: 0 },
    tools: [],
  };
}

export const FALLBACK_AGENTS: AgentsResponse = { agents: AGENT_ROLES.map(fallbackCard) };

export function useAgents() {
  return useQuery<AgentsResponse & { fallback?: boolean }>({
    queryKey: ['agents'],
    queryFn: async () => {
      try {
        return await api.agents();
      } catch {
        return { ...FALLBACK_AGENTS, fallback: true };
      }
    },
    refetchInterval: 20_000,
    staleTime: 5_000,
  });
}

export function useAgentDetail(role: BotRole | null) {
  return useQuery({
    queryKey: ['agents', 'detail', role],
    queryFn: () => api.agent(role!),
    enabled: !!role,
    retry: false,
    refetchInterval: 30_000,
  });
}

/** SSE chat.status → 就地改 ['agents'] 缓存里对应 agent 的 chat 字段;idle/error 时顺带刷新名册(last_text / 计数) */
export function applyChatStatus(qc: QueryClient, ev: AgentChatStatusEvent): void {
  qc.setQueryData<AgentsResponse>(['agents'], (old) => {
    if (!old) return old;
    return { ...old, agents: old.agents.map((a) => (a.session_id === ev.session_id ? { ...a, chat: { state: ev.state, tool: ev.tool, since: ev.at } } : a)) };
  });
  qc.setQueryData(['agents', 'chat-status', ev.session_id], ev);
  if (ev.state === 'idle' || ev.state === 'error') void qc.invalidateQueries({ queryKey: ['agents'], exact: true });
}

/** 每个 agent 的起手提问(点一下填进输入框)。只写它白名单里做得到的事。 */
export function rolePrompts(role: BotRole): string[] {
  const P: Record<BotRole, string[]> = {
    gate_captain: ['团队现在都在忙什么?', '今天的值班简报', '有哪些待我处理的交接?'],
    radar: ['筛一轮短线候选', '全市场扫描前几名是谁?', '观察列表里哪个最值得看?'],
    thread_manager: ['现在为什么不开单?', '复查一下持仓的线程', '看一下 BTC'],
    strategy_lab: ['推荐几个币和周期', '最近一次实验结果', '我的策略里哪条回测最好?'],
    portfolio_manager: ['现在的总敞口和簇集中度', '止损预算还剩多少?', '有没有没保护的腿?'],
    risk_sentinel: ['现在有哪些风控告警?', '为什么挡了新开仓?', '怎么解除这个告警?'],
    reviewer: ['复盘最近的交易', '模型判断值不值?', '最近提炼了哪些教训?'],
    executor: ['有哪些待批的意图?', '现在的执行通道是什么?', '上一笔单的回执'],
    asp_agent: ['你是谁?我们的 ASP 现在什么状态?', '我们上架了哪些服务?', '最近有订阅或接单吗?', '有可以领的款吗?'],
  };
  return P[role].map((x) => t(x));
}

const CHAT_STATE_TEXT: Record<AgentCard['chat']['state'], string> = { idle: '', queued: '排队中', thinking: '正在想', tool: '正在查', error: '出错了' };
export function chatStateText(c: AgentCard['chat'] | null | undefined): string {
  if (!c || c.state === 'idle') return '';
  return c.state === 'tool' && c.tool ? `${t('正在调')} ${c.tool}` : t(CHAT_STATE_TEXT[c.state]);
}

const LOOP_STATUS_TEXT: Record<AgentCard['loop']['status'], string> = { idle: '待命', running: '在跑', paused: '暂停', disabled: '已关', error: '出错' };
export function loopStatusText(s: AgentCard['loop']['status']): string {
  return t(LOOP_STATUS_TEXT[s]);
}

/** agent_md 按二级标题切块(契约固定标题:我是谁 / 我负责 / …) */
export function agentMdSection(md: string, title: string): string | null {
  const re = new RegExp(`^##\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const m = re.exec(md);
  if (!m) return null;
  const rest = md.slice(m.index + m[0].length);
  const next = /^##\s/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim() || null;
}
