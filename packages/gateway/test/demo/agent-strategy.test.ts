// Agent 当前策略(§9.54):切到策略 / 切换停旧运行 / 切回自由判断 / 自由判断开仓被挡 / 参数校验。运行器用内存桩。
import { describe, expect, it } from 'vitest';
import { AgentStrategyService, type AgentStrategyDeps, type CurrentStrategyRef } from '../../src/demo/agent-strategy.js';
import type { StrategyRun } from '../../src/demo/strategy-run.js';

function fixture(o: { judge?: boolean } = {}) {
  const runs = new Map<string, StrategyRun>();
  let cur: (CurrentStrategyRef & { since: number }) | null = null, n = 0, now = 1000;
  const mk = (b: Record<string, unknown>): StrategyRun => ({
    id: `run_${++n}`, strategy_id: String(b['strategy_id']), strategy_name: `策略 ${String(b['strategy_id'])}`, version: Number(b['version'] ?? 1), status: 'running', mode: (b['mode'] ?? 'auto') as StrategyRun['mode'],
  } as unknown as StrategyRun);
  const calls: string[] = [];
  const deps: AgentStrategyDeps = {
    now: () => now,
    current: () => cur,
    setCurrent: (r) => { cur = r; },
    legacyPool: () => ['breakout_retest'],
    runs: {
      get: (id) => runs.get(id) ?? null,
      create: async (b) => {
        calls.push(`create:${String(b['strategy_id'])}:${String(b['mode'])}`);
        const existing = [...runs.values()].find((r) => r.strategy_id === b['strategy_id'] && r.status !== 'stopped');
        const r = existing ?? mk(b); runs.set(r.id, r); return { run: r };
      },
      patch: async (id, b) => { calls.push(`patch:${id}:${String(b['status'])}`); const r = runs.get(id)!; if (b['status']) r.status = b['status'] as StrategyRun['status']; return { run: r }; },
    },
    slices: () => [{ role: 'radar', title: '雷达', summary: '盯 BTC', rules: [] }],
    hasJudge: () => !!o.judge,
  };
  return { svc: new AgentStrategyService(deps), runs, calls, tick: (ms: number) => { now += ms; }, cur: () => cur };
}

describe('AgentStrategyService', () => {
  it('缺省是自由判断,旧库策略只回显不参与', () => {
    const f = fixture();
    expect(f.svc.view()).toMatchObject({ kind: 'free', run_id: null, slices: [], legacy_pool_ignored: ['breakout_retest'] });
    expect(f.svc.blocksFreeOpens()).toBeNull();
  });

  it('切到策略:缺省 agent 模式起运行,自由判断开仓被挡,角色片与执行者可见', async () => {
    const f = fixture({ judge: true });
    const v = await f.svc.put({ kind: 'strategy', strategy_id: 'rs_a' });
    expect(f.calls).toEqual(['create:rs_a:agent']);
    expect(v).toMatchObject({ kind: 'strategy', strategy_id: 'rs_a', run_status: 'running', mode: 'agent', since: 1000 });
    expect(v.role_engines.judge).toBe('decision');
    expect(v.slices).toHaveLength(1);
    expect(f.svc.blocksFreeOpens()).toContain('自由判断只复查不开新仓');
  });

  it('换一条策略:旧运行停掉,当前指向新运行;同一条再切不重置 since', async () => {
    const f = fixture();
    const a = await f.svc.put({ kind: 'strategy', strategy_id: 'rs_a', mode: 'auto' });
    f.tick(500);
    const b = await f.svc.put({ kind: 'strategy', strategy_id: 'rs_b' });
    expect(f.runs.get(a.run_id!)!.status).toBe('stopped');
    expect(b).toMatchObject({ strategy_id: 'rs_b', since: 1500 });
    expect(b.role_engines.judge).toBe('llm');
    f.tick(500);
    const again = await f.svc.put({ kind: 'strategy', strategy_id: 'rs_b', risk_pct: 0.3 });
    expect(again.run_id).toBe(b.run_id);
    expect(again.since).toBe(1500);
  });

  it('切回自由判断:停当前运行,不再挡开仓', async () => {
    const f = fixture();
    const a = await f.svc.put({ kind: 'strategy', strategy_id: 'rs_a' });
    const v = await f.svc.put({ kind: 'free' });
    expect(v.kind).toBe('free');
    expect(f.runs.get(a.run_id!)!.status).toBe('stopped');
    expect(f.svc.blocksFreeOpens()).toBeNull();
    expect(f.cur()).toBeNull();
  });

  it('当前策略的运行被别处停掉:视图回到 free,开仓不再被挡', async () => {
    const f = fixture();
    const a = await f.svc.put({ kind: 'strategy', strategy_id: 'rs_a' });
    f.runs.get(a.run_id!)!.status = 'stopped';
    expect(f.svc.blocksFreeOpens()).toBeNull();
    expect(f.svc.view().run_status).toBe('stopped');
  });

  it('参数校验', async () => {
    const f = fixture();
    await expect(f.svc.put({ kind: 'x' })).rejects.toThrow('kind 只能是');
    await expect(f.svc.put({ kind: 'strategy' })).rejects.toThrow('缺 strategy_id');
    await expect(f.svc.put({ kind: 'free', hack: 1 })).rejects.toThrow('不认识的字段');
    await expect(f.svc.put(null)).rejects.toThrow('请求体必须是对象');
  });
});
