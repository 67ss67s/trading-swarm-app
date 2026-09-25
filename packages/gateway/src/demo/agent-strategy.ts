/**
 * Agent 当前策略(§9.54,一个策略概念):agent 要么「自由判断」(playbook + 模型),要么按一条研究策略运行。
 *
 * - 切到 strategy = 用 §9.51 运行器起(或复用)该策略的运行,并记为 agent 当前策略;原当前策略的运行停掉
 *   (已开仓位按钉住的旧版本机械退出,运行器本身就是这个语义)。
 * - 切到 free = 停掉当前策略的运行。
 * - 当前策略存在时,runtime 里的自由判断线不再开新仓(由 runtime 读 `blocksFreeOpens()`),避免两套大脑同时下单。
 * - 旧库 active_strategies 不再参与开仓;这里只把它原样回显在 legacy_pool_ignored 里提示用户。
 *
 * 依赖全部注入,runtime 只负责接线;本文件不碰交易所、不调模型。
 */
import type { BindingRole, BindingRoleSlice } from '@trading-swarm/contracts';
import type { StrategyRun, StrategyRunMode, StrategyRunStatus } from './strategy-run.js';

export interface CurrentStrategyRef { strategy_id: string; version: number; run_id: string }
export type AgentStrategyKind = 'free' | 'strategy';
export type RoleEngine = 'code' | 'decision' | 'llm';

export interface AgentStrategyView {
  kind: AgentStrategyKind;
  strategy_id: string | null;
  version: number | null;
  name: string | null;
  run_id: string | null;
  run_status: StrategyRunStatus | null;
  mode: StrategyRunMode | null;
  since: number | null;
  slices: BindingRoleSlice[];
  role_engines: Partial<Record<BindingRole, RoleEngine>>;
  legacy_pool_ignored: string[];
}

export interface AgentStrategyDeps {
  now(): number;
  current(): (CurrentStrategyRef & { since: number }) | null;
  setCurrent(ref: (CurrentStrategyRef & { since: number }) | null): void;
  legacyPool(): string[];
  runs: {
    get(id: string): StrategyRun | null;
    create(body: Record<string, unknown>): Promise<{ run: StrategyRun }>;
    patch(id: string, body: Record<string, unknown>): Promise<{ run: StrategyRun }>;
  };
  /** 该版本 binding 的角色片;编译失败返回 [] */
  slices(strategy_id: string, version: number): BindingRoleSlice[];
  /** IR 是否带 judge 块(§9.53 C):带 → judge 片由决策模型执行 */
  hasJudge(strategy_id: string, version: number): boolean;
}

const PUT_KEYS = ['kind', 'strategy_id', 'version', 'mode', 'symbols', 'risk_pct', 'max_open', 'confirm'] as const;
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };

export class AgentStrategyService {
  constructor(private readonly deps: AgentStrategyDeps) {}

  /** runtime 的自由判断线在开新仓前问这一句:有当前策略且它的运行没停,就不开。 */
  blocksFreeOpens(): string | null {
    const cur = this.deps.current();
    if (!cur) return null;
    const run = this.deps.runs.get(cur.run_id);
    return run && run.status !== 'stopped' ? `当前策略「${run.strategy_name}」在运行,自由判断只复查不开新仓` : null;
  }

  view(): AgentStrategyView {
    const cur = this.deps.current(), legacy = this.deps.legacyPool();
    const run = cur ? this.deps.runs.get(cur.run_id) : null;
    if (!cur || !run) {
      return { kind: 'free', strategy_id: null, version: null, name: null, run_id: null, run_status: null, mode: null, since: null, slices: [], role_engines: {}, legacy_pool_ignored: legacy };
    }
    const judge: RoleEngine = this.deps.hasJudge(cur.strategy_id, cur.version) ? 'decision' : run.mode === 'agent' ? 'llm' : 'code';
    return {
      kind: 'strategy', strategy_id: cur.strategy_id, version: run.version, name: run.strategy_name, run_id: run.id, run_status: run.status, mode: run.mode, since: cur.since,
      slices: this.deps.slices(cur.strategy_id, run.version),
      role_engines: { radar: 'code', judge, geometry: 'code', risk: 'code', holding: 'code', execution: 'code' },
      legacy_pool_ignored: legacy,
    };
  }

  async put(raw: unknown): Promise<AgentStrategyView> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('请求体必须是对象');
    const b = raw as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => !(PUT_KEYS as readonly string[]).includes(k));
    if (extra.length) fail(`不认识的字段:${extra.join(', ')}`);
    const cur = this.deps.current();
    if (b['kind'] === 'free') {
      if (cur) {
        const run = this.deps.runs.get(cur.run_id);
        if (run && run.status !== 'stopped') await this.deps.runs.patch(run.id, { status: 'stopped' });
      }
      this.deps.setCurrent(null);
      return this.view();
    }
    if (b['kind'] !== 'strategy') fail('kind 只能是 free 或 strategy');
    const strategy_id = b['strategy_id'];
    if (typeof strategy_id !== 'string' || !strategy_id) fail('缺 strategy_id');
    const body: Record<string, unknown> = { strategy_id, mode: b['mode'] ?? 'agent' };
    for (const k of ['version', 'symbols', 'risk_pct', 'max_open', 'confirm'] as const) if (k in b) body[k] = b[k];
    // 已有同策略的非停止运行 → 运行器 create 会复用它(按新参数重配);否则新建。
    const { run } = await this.deps.runs.create(body);
    if (cur && cur.run_id !== run.id) {
      const old = this.deps.runs.get(cur.run_id);
      if (old && old.status !== 'stopped') await this.deps.runs.patch(old.id, { status: 'stopped' });
    }
    if (run.status === 'paused' || run.status === 'stopped') await this.deps.runs.patch(run.id, { status: 'running' });
    this.deps.setCurrent({ strategy_id: run.strategy_id, version: run.version, run_id: run.id, since: cur?.run_id === run.id ? cur.since : this.deps.now() });
    return this.view();
  }
}
