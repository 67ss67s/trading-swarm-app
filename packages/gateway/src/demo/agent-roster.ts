/** 名册 API 投影(契约 §9.55):只读 store 与调度器字段,不初始化后台工作。 */
import type { BotRole, BotRun, BotHandoff } from './bots.js';
import { AGENT_REGISTRY, agentSessionId, agentTools, type AgentChatState, type AgentGraph, type AgentTool } from './agent-registry.js';
import { readAgentMd } from './agent-doc.js';
import type { DemoRuntime } from './runtime.js';

type RunView = Pick<BotRun, 'id' | 'routine' | 'status' | 'started_at' | 'finished_at' | 'summary'>;
export interface AgentCard {
  role: BotRole;
  name: string;
  callsign: string;
  tagline: string;
  enabled: boolean;
  session_id: string;
  message_count: number;
  last_message_at: number | null;
  last_text: string | null;
  chat: { state: AgentChatState; tool: string | null; since: number | null };
  loop: {
    cadence: string;
    status: 'idle' | 'running' | 'paused' | 'disabled' | 'error';
    current_node: string | null;
    last_run: RunView | null;
    next_run_at: number | null;
    pending_handoffs_in: number;
  };
  tools: AgentTool[];
}
export interface AgentDetail { agent: AgentCard; agent_md: string; graph: AgentGraph; recent_runs: AgentCard['loop']['last_run'][]; handoffs: { in: BotHandoff[]; out: BotHandoff[] } }
const runView = (r: BotRun): RunView => ({ id: r.id, routine: r.routine, status: r.status, started_at: r.started_at, finished_at: r.finished_at, summary: r.summary });

export function agentCard(rt: DemoRuntime, role: BotRole): AgentCard {
  const spec = AGENT_REGISTRY[role], session_id = agentSessionId(role), session = rt.store.chatSession(session_id);
  const last = rt.store.bots.runs({ role, limit: 1 })[0];
  const recorded = rt.store.bots.loopState(role), current = rt.agentLoopSignals(role);
  const enabled = rt.botEnabled(role);
  const status = !enabled ? 'disabled' : rt.workflow.paused && spec.loop.affected_by_pause ? 'paused'
    : recorded.running || current.running ? 'running' : recorded.failed ? 'error' : 'idle';
  return {
    role, name: spec.name, callsign: spec.callsign, tagline: spec.tagline, enabled, session_id,
    message_count: session?.message_count ?? 0, last_message_at: rt.store.lastChatAt(session_id), last_text: session?.last_text ?? null,
    chat: rt.chatStatus(session_id),
    loop: { cadence: spec.loop.cadence, status, current_node: status === 'running' ? 'work' : null,
      last_run: last ? runView(last) : null, next_run_at: status === 'disabled' || status === 'paused' ? null : current.next_run_at,
      pending_handoffs_in: recorded.pending },
    tools: agentTools(role),
  };
}
export function agentCards(rt: DemoRuntime): AgentCard[] { return (Object.keys(AGENT_REGISTRY) as BotRole[]).map((role) => agentCard(rt, role)); }
export function agentDetail(rt: DemoRuntime, role: BotRole): AgentDetail {
  return { agent: agentCard(rt, role), agent_md: readAgentMd(role, rt.store.bots.profile(role)?.description), graph: AGENT_REGISTRY[role].loop.graph,
    recent_runs: rt.store.bots.runs({ role, limit: 10 }).map(runView),
    handoffs: { in: rt.store.bots.handoffs({ to_role: role, limit: 10 }), out: rt.store.bots.handoffs({ from_role: role, limit: 10 }) } };
}
