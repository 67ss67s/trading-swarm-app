/**
 * Agent 当前策略(契约 §9.54,后端 gateway/src/demo/agent-strategy.ts)。
 *
 *   GET /api/agent/strategy → AgentStrategyView
 *   PUT /api/agent/strategy {kind:'free'} | {kind:'strategy', strategy_id, version?, mode?, confirm?}
 *   SSE agent.strategy
 *
 * 类型放这里,不改 api/types.ts(别人在动)。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BindingRole, BindingRoleSlice } from '@trade-gate/contracts';

export type AgentStrategyKind = 'free' | 'strategy';
export type RoleEngine = 'code' | 'decision' | 'llm';
export interface AgentStrategyView {
  kind: AgentStrategyKind;
  strategy_id: string | null;
  version: number | null;
  name: string | null;
  run_id: string | null;
  run_status: 'running' | 'paused' | 'stopped' | 'error' | null;
  mode: 'auto' | 'jev' | 'agent' | 'confirm' | 'signal_only' | null;
  since: number | null;
  slices: BindingRoleSlice[];
  role_engines: Partial<Record<BindingRole, RoleEngine>>;
  legacy_pool_ignored: string[];
}
export type AgentStrategyPut =
  | { kind: 'free' }
  | { kind: 'strategy'; strategy_id: string; version?: number; mode?: 'auto' | 'jev' | 'agent'; confirm?: string };

async function call<T>(method: 'GET' | 'PUT', body?: unknown): Promise<T> {
  const res = await fetch('/api/agent/strategy', { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json as { error?: string | { message?: string } } | null;
    throw new Error(typeof e?.error === 'string' ? e.error : e?.error?.message ?? res.statusText);
  }
  return json as T;
}

export const AGENT_STRATEGY_KEY = ['agent-strategy'] as const;
export function useAgentStrategy() {
  return useQuery({ queryKey: AGENT_STRATEGY_KEY, queryFn: () => call<AgentStrategyView>('GET'), refetchInterval: 30_000, retry: 1 });
}
export function useSetAgentStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: AgentStrategyPut) => call<AgentStrategyView>('PUT', b),
    onSuccess: (v) => qc.setQueryData(AGENT_STRATEGY_KEY, v),
  });
}

/** 楼层角色桌 ← binding 片(§9.54):同一张桌可能拿到两片 */
export const DESK_SLICES: Record<string, BindingRole[]> = {
  radar: ['radar'],
  thread_manager: ['judge', 'holding'],
  risk_sentinel: ['geometry', 'risk'],
  portfolio_manager: ['risk'],
  executor: ['execution'],
};
