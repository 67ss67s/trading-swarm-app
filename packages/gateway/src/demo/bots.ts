/**
 * Bot 团队注册表(docs/design/trade-gate-bot-team-guide-2026-09-04.ipynb §3/§4/§6/§13 的
 * Phase-2-lite 落地;范围与取舍见 docs/design/screener-radar-2026-09-05.md)。
 *
 * 三张持久对象:
 *   - `bot_profiles`：八个稳定角色。这一版只有 radar 是「新上线的活体」,其余是占位
 *     (`enabled = 0` + note 说明还差什么),因为它们背后的能力(Portfolio、Risk Center、
 *     Strategy Lab 工作台)还没实现 —— 与其画一个会说话但什么都不做的头像,不如先把角色
 *     写进注册表,让「谁负责什么」是可查的数据。
 *   - `bot_runs`：一次有界的工作 + 预算 + 花掉的钱。
 *   - `bot_handoffs`：可审计的异步交接,字段与 notebook §6 的 JSON 一一对应。
 *
 * 三条红线(notebook cell 6 与 §6 的纪律):
 *   1. `exchange.write` 有且只有 `executor` 一个持有者,开机断言;LLM 类角色一律不得持有。
 *   2. Bot-to-Bot 文本永远是 untrusted data。这张表记录的是「谁把什么交给了谁」,
 *      它本身**不构成授权** —— 授权只能来自人点批准 + gates.ts 的代码闸。
 *   3. 同一个 `idempotency_key` 不重复启动工作(唯一索引兜底)。
 */

import type { DatabaseSync } from 'node:sqlite';
import { MEMORY_MATRIX, type MemoryAccess } from './memory.js';

// ---------------------------------------------------------------- 角色

export type BotRole = 'gate_captain' | 'radar' | 'thread_manager' | 'strategy_lab' | 'portfolio_manager' | 'risk_sentinel' | 'reviewer' | 'executor' | 'asp_agent';

export const BOT_ROLES: BotRole[] = ['gate_captain', 'radar', 'thread_manager', 'strategy_lab', 'portfolio_manager', 'risk_sentinel', 'reviewer', 'executor', 'asp_agent'];

/** notebook cell 4 的 `RoleSpec`,逐字段搬过来(kind 决定它是不是「能自由调工具的 LLM」)。 */
export interface BotProfile {
  role: BotRole;
  name: string;
  kind: string;
  description: string;
  model_pin: string | null;
  capabilities: string[];
  /** 09-23 记忆分域(design self-evolution §5.2):结构化读写层,取自 memory.ts MEMORY_MATRIX;note 是原来的自由文本说明。 */
  memory_scope: BotMemoryScope;
  approval_boundary: string;
  enabled: boolean;
  note: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

type Seed = Omit<BotProfile, 'created_at' | 'updated_at'>;

export interface BotMemoryScope extends MemoryAccess {
  note: string | null;
}

function memScope(role: BotRole, note: string | null): BotMemoryScope {
  const m = MEMORY_MATRIX[role];
  return { read: [...m.read], write: [...m.write], note };
}

/** 库里的 memory_scope 列:新行是 JSON;09-23 之前的行是自由文本 → 按矩阵补结构,原文进 note。 */
function parseMemoryScope(role: BotRole, raw: unknown): BotMemoryScope {
  const text = raw === null || raw === undefined ? '' : String(raw);
  try {
    const v = JSON.parse(text) as Partial<BotMemoryScope>;
    if (v && Array.isArray(v.read) && Array.isArray(v.write)) return { read: v.read, write: v.write, note: typeof v.note === 'string' ? v.note : null };
  } catch {
    /* 旧自由文本 */
  }
  return memScope(role, text || null);
}

const sameLayers = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * 八个角色的初版。`enabled` 的口径刻意保守:**只有已经有真实实现的那一格才是 true**。
 *   - radar：本次新增的 screener.ts(定时全市场筛选),真的在跑。
 *   - thread_manager：现有的判断模块(runtime.ts 的 scan/review)就是它,只是换了个名字。
 *   - executor：现有的执行后端(execution*.ts)+ gates.ts,真的在写交易所。
 * 其余五个是占位,note 里写清楚差什么;UI 会把它们画成灰色。
 */
const SEEDS: Seed[] = [
  { role: 'asp_agent', name: 'ASP Agent / 信号市场', kind: 'deterministic', description: 'OKX.AI 入站、发布、身份、领款与售后', model_pin: null, capabilities: ['market.read', 'asp.publish', 'asp.manage'], memory_scope: memScope('asp_agent', '市场账本与订阅配置'), approval_boundary: '不直连交易所，不转发外部信号；售后由人决策', enabled: true, note: '代码驱动；本批零模型调用', sort_order: 9 },
  {
    role: 'gate_captain',
    name: 'Gate Captain / 总协调',
    kind: 'llm_session',
    description: '用户目标、任务路由、结果汇总、待办与审批收件箱',
    model_pin: null,
    capabilities: ['state.read', 'bot.delegate', 'intent.propose', 'routine.propose'],
    memory_scope: memScope('gate_captain', '用户偏好、沟通方式、团队运行摘要'),
    approval_boundary: '不能批准自己的提案,不能直接触达交易所',
    enabled: true,
    note: 'dispatcher-lite:收件箱(pending handoff)+ 每日简报(代码拼卡,零模型);对话仍走 chat.ts;议会扇出/hash 审批是单列的安全前置,未做。',
    sort_order: 1,
  },
  {
    role: 'radar',
    name: 'Radar / 信息与发现',
    kind: 'llm_recipe',
    description: '市场状态、新闻、候选与 MonitorSpec;每 12 小时短线筛选,每 3 天 / 每周中长线筛选',
    model_pin: null,
    capabilities: ['market.read', 'news.read', 'monitor.propose'],
    memory_scope: memScope('radar', '信息源质量、候选表现、摘要偏好'),
    approval_boundary: '只读,不生成订单;watchlist 提案默认要人点「应用」',
    enabled: true,
    note: null,
    sort_order: 2,
  },
  {
    role: 'thread_manager',
    name: 'Thread Manager / 交易论点',
    kind: 'llm_recipe',
    description: '一个 StrategyThread 从 setup 到关闭的论点连续性',
    model_pin: null,
    capabilities: ['market.read', 'account.read', 'memory.read', 'intent.propose'],
    memory_scope: memScope('thread_manager', '按 symbol/strategy/thread 隔离的教训'),
    approval_boundary: '只提议;数量、杠杆和是否允许由代码决定',
    enabled: true,
    note: null,
    sort_order: 3,
  },
  {
    role: 'strategy_lab',
    name: 'Strategy Lab / 研究与优化',
    kind: 'llm_session+workers',
    description: 'StrategySpec、实验假设、回测任务和晋升提案',
    model_pin: null,
    capabilities: ['dataset.read', 'backtest.run', 'paper.register', 'strategy.propose'],
    memory_scope: memScope('strategy_lab', '研究日志、失败假设、实验结果;不读取 Live 凭证'),
    approval_boundary: '只能进入 DRAFT/BACKTEST/PAPER,晋升必须人批',
    enabled: true,
    note: 'strategy-lab.ts:每 7 天或 ≥10 笔新平仓,把所有策略版本按机械前瞻期望做一次预注册可复现实验(零模型,不改策略不晋升);归因/brief 模型部分未做。',
    sort_order: 4,
  },
  {
    role: 'portfolio_manager',
    name: 'Portfolio Manager / 组合经理',
    kind: 'hybrid',
    description: '总/净/簇敞口、风险预算、资金分配和组合计划',
    model_pin: null,
    capabilities: ['account.read', 'risk.read', 'portfolio.propose'],
    memory_scope: memScope('portfolio_manager', '组合目标与用户偏好;当前仓位永远现拉'),
    approval_boundary: '输出 PortfolioPlan,不直接生成交易所效果',
    enabled: true,
    note: '代码计算敞口/簇集中度/止损预算并执行组合硬闸；PROPOSE 可用 cheap brain 提供有界仓位意见，默认只建议。',
    sort_order: 5,
  },
  {
    role: 'risk_sentinel',
    name: 'Risk Sentinel / 风控哨兵',
    kind: 'deterministic+explainer',
    description: '实时不变量、gate verdict、incident 与告警',
    model_pin: null,
    capabilities: ['account.read', 'policy.veto', 'incident.open', 'emergency_reduce.propose'],
    memory_scope: memScope('risk_sentinel', '告警去重与解释模板;实时指标不进长期记忆'),
    approval_boundary: '代码可以拒绝/收紧,模型永远不能放宽',
    enabled: true,
    note: '纯代码:risk.ts 每次账户轮询评估不变量→指纹告警,high 以上停止新增风险;零模型。',
    sort_order: 6,
  },
  {
    role: 'reviewer',
    name: 'Reviewer / 评测与复盘',
    kind: 'llm_recipe+deterministic_eval',
    description: '反方审查、交易复盘、memory/skill/strategy 候选',
    model_pin: null,
    capabilities: ['episode.read', 'eval.run', 'memory.propose', 'strategy.review'],
    memory_scope: memScope('reviewer', '经批准的 lesson 与评测结论'),
    approval_boundary: '不能改活跃策略或风险参数,只能提出 diff',
    enabled: true,
    note: 'reviewer.ts / reviewer-agent.ts:平仓复盘卡(代码)+ 批量提炼教训(便宜大脑,≥5 笔或 24h,≤2 次/天,每轮 ≤2 条,等人批);提案反方审查未做。',
    sort_order: 7,
  },
  {
    role: 'executor',
    name: 'Executor / 执行服务',
    kind: 'protected_service',
    description: '消费已授权 plan、下单、保护腿、回执与对账',
    model_pin: null,
    capabilities: ['execution.consume_authorized_plan', 'exchange.write', 'reconcile.write'],
    memory_scope: memScope('executor', '无自由文本记忆;只保存六记录、checkpoint 和回执'),
    approval_boundary: '只接受 plan_hash/account_version/authorization 完整的结构化请求',
    enabled: true,
    note: null,
    sort_order: 8,
  },
];

/** AGENT.md 缺失时按 profile 的代码默认描述兜底,不初始化数据库。 */
export function botDescription(role: BotRole): string { return SEEDS.find((s) => s.role === role)!.description; }

/** 只有这一个角色可以写交易所。改这一行 = 改安全边界,不是改配置。 */
export const EXCHANGE_WRITER: BotRole = 'executor';
export const EXCHANGE_WRITE_CAP = 'exchange.write';

/**
 * notebook cell 6 的 `validate_role_boundaries` 的 TS 版。返回中文错误串数组(空 = 通过)。
 * 顺序敏感:`writers` 必须**恰好**是 `['executor']`,多一个少一个都算越界。
 */
export function validateRoleBoundaries(profiles: readonly (Pick<BotProfile, 'role' | 'kind' | 'capabilities'> & Partial<Pick<BotProfile, 'memory_scope'>>)[]): string[] {
  const errors: string[] = [];
  const writers: string[] = [];
  for (const p of profiles) {
    const caps = new Set(p.capabilities);
    if (caps.has(EXCHANGE_WRITE_CAP)) writers.push(p.role);
    if (p.kind.startsWith('llm') && caps.has(EXCHANGE_WRITE_CAP)) errors.push(`${p.role}: LLM 不得拥有 ${EXCHANGE_WRITE_CAP}`);
    if (p.role === 'risk_sentinel' && !caps.has('policy.veto')) errors.push('risk_sentinel 缺少 veto');
    if (p.role === 'gate_captain' && caps.has(EXCHANGE_WRITE_CAP)) errors.push('Gate Captain 不得执行订单');
    // 09-23 记忆分域:库里的读写层必须与代码矩阵一致(矩阵才是边界,库只是展示副本)。
    const mx = MEMORY_MATRIX[p.role];
    if (p.memory_scope && mx && (!sameLayers(p.memory_scope.read, mx.read) || !sameLayers(p.memory_scope.write, mx.write))) errors.push(`${p.role}: memory_scope 与 MEMORY_MATRIX 不一致`);
  }
  if (writers.length !== 1 || writers[0] !== EXCHANGE_WRITER) errors.push(`exchange writer 必须且只能是 ${EXCHANGE_WRITER},实际为 [${writers.join(', ')}]`);
  return errors;
}

/** 开机断言。库里的一行被手改成把 exchange.write 给了别人 → 进程起不来,而不是静默跑。 */
export function assertRoleBoundaries(profiles: readonly (Pick<BotProfile, 'role' | 'kind' | 'capabilities'> & Partial<Pick<BotProfile, 'memory_scope'>>)[]): void {
  const errors = validateRoleBoundaries(profiles);
  if (errors.length) throw new Error(`Bot 角色边界校验失败(notebook §4 红线):${errors.join(';')}`);
}

// ---------------------------------------------------------------- 事件路由与 lane

/** notebook cell 8 的 `EVENT_ROUTES`:一个事件叫醒哪些角色。 */
export const EVENT_ROUTES: Record<string, readonly BotRole[]> = {
  'market_state.updated': ['radar', 'gate_captain'],
  'trigger.hit': ['thread_manager'],
  'proposal.created': ['portfolio_manager', 'risk_sentinel', 'reviewer'],
  'order.filled': ['thread_manager', 'risk_sentinel', 'gate_captain'],
  'protection.missing': ['risk_sentinel', 'executor', 'gate_captain'],
  'thread.closed': ['reviewer', 'strategy_lab', 'portfolio_manager'],
  'strategy.experiment.finished': ['reviewer', 'strategy_lab'],
  'incident.critical': ['risk_sentinel', 'gate_captain'],
  // 本次新增:一次筛选跑完 → Gate Captain 收件箱(Radar 只提议,不改 watchlist)。
  'screen.finished': ['gate_captain'],
};

/**
 * notebook cell 8 的 `lane_for`:同一条 lane 串行,不同 lane 并行(§5 的六类 lane)。
 * 缺字段时退回 `default` 而不是抛错 —— lane 只是并发键,算错了顶多退化成串行。
 */
export function laneFor(eventName: string, payload: Record<string, unknown> = {}): string {
  const s = (k: string): string | null => (typeof payload[k] === 'string' ? (payload[k] as string) : null);
  if (eventName.startsWith('trigger.') || eventName.startsWith('order.')) return `judgment:${s('symbol') ?? 'unknown'}`;
  if (eventName.startsWith('strategy.')) return `research:${s('strategy_id') ?? 'unknown'}`;
  if (eventName.startsWith('proposal.')) return `portfolio:${s('account_version') ?? 'unknown'}`;
  if (eventName.startsWith('execution.')) return `execution:${s('account_id') ?? 'unknown'}`;
  if (eventName.startsWith('incident.')) return 'risk';
  // 情报是单飞的(§5:防止重复拉相同全市场信息);筛选也走这条。
  if (eventName.startsWith('screen.') || eventName.startsWith('market_state.')) return 'intel';
  return 'default';
}

// ---------------------------------------------------------------- runs / handoffs

export type BotRunStatus = 'running' | 'done' | 'failed' | 'skipped';

export interface BotRun {
  id: string;
  role: BotRole;
  routine: string;
  started_at: number;
  finished_at: number | null;
  status: BotRunStatus;
  budget: Record<string, unknown>;
  cost_cny: number;
  summary: string | null;
  error: string | null;
  /** 冻结的输入(创建后不改)与结构化结果(完成时写一次);artifact://bot-run/{id} 回读 result。 */
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
}

export type HandoffKind = 'request' | 'result' | 'review' | 'alert' | 'blocked';
export type HandoffStatus = 'pending' | 'acked';

/** notebook §6 的 JSON,逐字段。`payload` 是结构化产物(这一版:watchlist 提案)。 */
export interface BotHandoff {
  handoff_id: string;
  run_id: string | null;
  from_role: BotRole;
  to_role: BotRole;
  kind: HandoffKind;
  subject: { type: string; id: string };
  summary: string;
  evidence_refs: string[];
  artifact_refs: string[];
  requested_output_schema: string | null;
  priority: number;
  deadline_at: number | null;
  idempotency_key: string;
  status: HandoffStatus;
  created_at: number;
  acked_at: number | null;
  payload: Record<string, unknown> | null;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class BotRegistry {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 首次启动写入八个角色;已存在的行只补齐**结构性**字段(name/kind/description/capabilities/
   * memory_scope/approval_boundary/note/sort_order),`enabled` 与 `model_pin` 一旦落库就归用户,
   * 不被 seed 覆盖。写完立刻断言边界:读回来的是库里那份,而不是代码里那份。
   */
  seed(now = Date.now()): number {
    let n = 0;
    const ins = this.db.prepare(
      `INSERT INTO demo_bot_profile(role, name, kind, description, model_pin, capabilities_json, memory_scope, approval_boundary, enabled, note, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET
         name = excluded.name, kind = excluded.kind, description = excluded.description,
         capabilities_json = excluded.capabilities_json, memory_scope = excluded.memory_scope,
         approval_boundary = excluded.approval_boundary, note = excluded.note,
         sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
    );
    const upg = this.db.prepare('UPDATE demo_bot_profile SET enabled = 1, updated_at = ? WHERE role = ?');
    for (const s of SEEDS) {
      const before = this.profile(s.role);
      ins.run(s.role, s.name, s.kind, s.description, s.model_pin, JSON.stringify(s.capabilities), JSON.stringify(s.memory_scope), s.approval_boundary, s.enabled ? 1 : 0, s.note, s.sort_order, now, now);
      if (!before) n++;
      // 一次性升级:一个角色从「占位」变成真实实现(seed 里 enabled 翻成 true)时,库里还停在占位状态
      // (enabled=0 且旧 note 以「占位」开头)的行跟着翻成 1;用户之后手动关掉的(note 已不是占位)不再动。
      else if (s.enabled && !before.enabled && (before.note ?? '').startsWith('占位')) upg.run(now, s.role);
    }
    assertRoleBoundaries(this.profiles());
    return n;
  }

  private toProfile(row: Record<string, unknown>): BotProfile {
    return {
      role: String(row['role']) as BotRole,
      name: String(row['name']),
      kind: String(row['kind']),
      description: String(row['description']),
      model_pin: row['model_pin'] === null || row['model_pin'] === undefined ? null : String(row['model_pin']),
      capabilities: parseJson<string[]>(row['capabilities_json'], []),
      memory_scope: parseMemoryScope(String(row['role']) as BotRole, row['memory_scope']),
      approval_boundary: String(row['approval_boundary']),
      enabled: Number(row['enabled']) === 1,
      note: row['note'] === null || row['note'] === undefined ? null : String(row['note']),
      sort_order: Number(row['sort_order']),
      created_at: Number(row['created_at']),
      updated_at: Number(row['updated_at']),
    };
  }

  profiles(): BotProfile[] {
    const rows = this.db.prepare('SELECT * FROM demo_bot_profile ORDER BY sort_order ASC').all() as Record<string, unknown>[];
    return rows.map((r) => this.toProfile(r));
  }
  profile(role: string): BotProfile | null {
    const row = this.db.prepare('SELECT * FROM demo_bot_profile WHERE role = ?').get(role) as Record<string, unknown> | undefined;
    return row ? this.toProfile(row) : null;
  }

  setEnabled(role: BotRole, enabled: boolean): void {
    this.db.prepare('UPDATE demo_bot_profile SET enabled = ?, updated_at = ? WHERE role = ?').run(enabled ? 1 : 0, Date.now(), role);
  }

  // ---- runs

  startRun(r: Omit<BotRun, 'finished_at' | 'status' | 'cost_cny' | 'summary' | 'error' | 'input' | 'result'> & Partial<Pick<BotRun, 'cost_cny' | 'input'>>): BotRun {
    const run: BotRun = { finished_at: null, status: 'running', summary: null, error: null, result: null, ...r, cost_cny: r.cost_cny ?? 0, input: r.input ?? null };
    this.db
      .prepare('INSERT INTO demo_bot_run(id, role, routine, started_at, finished_at, status, budget_json, cost_cny, summary, error, input_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(run.id, run.role, run.routine, run.started_at, run.finished_at, run.status, JSON.stringify(run.budget), run.cost_cny, run.summary, run.error, run.input === null ? null : JSON.stringify(run.input));
    return run;
  }

  finishRun(id: string, patch: { status: BotRunStatus; cost_cny?: number; summary?: string | null; error?: string | null; finished_at?: number; result?: Record<string, unknown> | null }): BotRun | null {
    const cur = this.run(id);
    if (!cur) return null;
    const next: BotRun = {
      ...cur,
      status: patch.status,
      cost_cny: patch.cost_cny ?? cur.cost_cny,
      summary: patch.summary ?? cur.summary,
      error: patch.error ?? cur.error,
      finished_at: patch.finished_at ?? Date.now(),
      result: patch.result === undefined ? cur.result : patch.result,
    };
    this.db.prepare('UPDATE demo_bot_run SET finished_at = ?, status = ?, cost_cny = ?, summary = ?, error = ?, result_json = ? WHERE id = ?').run(next.finished_at, next.status, next.cost_cny, next.summary, next.error, next.result === null ? null : JSON.stringify(next.result), id);
    return next;
  }

  private toRun(row: Record<string, unknown>): BotRun {
    return {
      id: String(row['id']),
      role: String(row['role']) as BotRole,
      routine: String(row['routine']),
      started_at: Number(row['started_at']),
      finished_at: row['finished_at'] === null || row['finished_at'] === undefined ? null : Number(row['finished_at']),
      status: String(row['status']) as BotRunStatus,
      budget: parseJson<Record<string, unknown>>(row['budget_json'], {}),
      cost_cny: Number(row['cost_cny'] ?? 0),
      summary: row['summary'] === null || row['summary'] === undefined ? null : String(row['summary']),
      error: row['error'] === null || row['error'] === undefined ? null : String(row['error']),
      input: parseJson<Record<string, unknown> | null>(row['input_json'], null),
      result: parseJson<Record<string, unknown> | null>(row['result_json'], null),
    };
  }

  run(id: string): BotRun | null {
    const row = this.db.prepare('SELECT * FROM demo_bot_run WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.toRun(row) : null;
  }
  /** 新的在前。 */
  runs(opts: { role?: string; routine?: string; limit?: number } = {}): BotRun[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.role) {
      where.push('role = ?');
      args.push(opts.role);
    }
    if (opts.routine) {
      where.push('routine = ?');
      args.push(opts.routine);
    }
    const rows = this.db.prepare(`SELECT * FROM demo_bot_run${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`).all(...args, opts.limit ?? 50) as Record<string, unknown>[];
    return rows.map((r) => this.toRun(r));
  }

  /** 名册读状态不截断到最近 N 条:长任务和大量交接也要准确。 */
  loopState(role: BotRole): { running: boolean; failed: boolean; pending: number } {
    const running = !!this.db.prepare("SELECT 1 FROM demo_bot_run WHERE role=? AND finished_at IS NULL AND status='running' LIMIT 1").get(role);
    const last = this.db.prepare("SELECT status FROM demo_bot_run WHERE role=? AND status IN ('done','failed') ORDER BY finished_at DESC,started_at DESC,rowid DESC LIMIT 1").get(role);
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM demo_bot_handoff WHERE to_role=? AND status='pending'").get(role)!;
    return { running, failed: last?.['status'] === 'failed', pending: Number(pending['n']) };
  }

  // ---- handoffs

  /**
   * 幂等:同一个 `idempotency_key` 第二次调用返回已存在的那条,不新建(notebook §6)。
   * 交接本身不是授权 —— 它只是「谁把什么交给了谁」的可审计记录。
   */
  handoff(h: Omit<BotHandoff, 'status' | 'created_at' | 'acked_at'> & Partial<Pick<BotHandoff, 'status' | 'created_at'>>): BotHandoff {
    const existing = this.handoffByKey(h.idempotency_key);
    if (existing) return existing;
    const row: BotHandoff = { status: h.status ?? 'pending', created_at: h.created_at ?? Date.now(), acked_at: null, ...h, ...(h.status ? { status: h.status } : {}) };
    this.db
      .prepare(
        `INSERT INTO demo_bot_handoff(handoff_id, run_id, from_role, to_role, kind, subject_type, subject_id, summary, evidence_refs_json, artifact_refs_json, requested_output_schema, priority, deadline_at, idempotency_key, status, created_at, acked_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.handoff_id,
        row.run_id,
        row.from_role,
        row.to_role,
        row.kind,
        row.subject.type,
        row.subject.id,
        row.summary,
        JSON.stringify(row.evidence_refs),
        JSON.stringify(row.artifact_refs),
        row.requested_output_schema,
        row.priority,
        row.deadline_at,
        row.idempotency_key,
        row.status,
        row.created_at,
        row.acked_at,
        row.payload === null ? null : JSON.stringify(row.payload),
      );
    return row;
  }

  private toHandoff(row: Record<string, unknown>): BotHandoff {
    return {
      handoff_id: String(row['handoff_id']),
      run_id: row['run_id'] === null || row['run_id'] === undefined ? null : String(row['run_id']),
      from_role: String(row['from_role']) as BotRole,
      to_role: String(row['to_role']) as BotRole,
      kind: String(row['kind']) as HandoffKind,
      subject: { type: String(row['subject_type']), id: String(row['subject_id']) },
      summary: String(row['summary']),
      evidence_refs: parseJson<string[]>(row['evidence_refs_json'], []),
      artifact_refs: parseJson<string[]>(row['artifact_refs_json'], []),
      requested_output_schema: row['requested_output_schema'] === null || row['requested_output_schema'] === undefined ? null : String(row['requested_output_schema']),
      priority: Number(row['priority']),
      deadline_at: row['deadline_at'] === null || row['deadline_at'] === undefined ? null : Number(row['deadline_at']),
      idempotency_key: String(row['idempotency_key']),
      status: String(row['status']) as HandoffStatus,
      created_at: Number(row['created_at']),
      acked_at: row['acked_at'] === null || row['acked_at'] === undefined ? null : Number(row['acked_at']),
      payload: row['payload_json'] === null || row['payload_json'] === undefined ? null : parseJson<Record<string, unknown> | null>(row['payload_json'], null),
    };
  }

  handoffById(id: string): BotHandoff | null {
    const row = this.db.prepare('SELECT * FROM demo_bot_handoff WHERE handoff_id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.toHandoff(row) : null;
  }
  handoffByKey(key: string): BotHandoff | null {
    const row = this.db.prepare('SELECT * FROM demo_bot_handoff WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
    return row ? this.toHandoff(row) : null;
  }
  /** 新的在前。 */
  handoffs(opts: { status?: HandoffStatus; to_role?: string; from_role?: string; limit?: number } = {}): BotHandoff[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    if (opts.to_role) {
      where.push('to_role = ?');
      args.push(opts.to_role);
    }
    if (opts.from_role) { where.push('from_role = ?'); args.push(opts.from_role); }
    const rows = this.db.prepare(`SELECT * FROM demo_bot_handoff${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...args, opts.limit ?? 50) as Record<string, unknown>[];
    return rows.map((r) => this.toHandoff(r));
  }

  /**
   * 待阅计数:等价于 `handoffs({ status: 'pending', to_role, limit: cap }).length`,但只走索引计数,
   * 不读取/解析整行(payload_json 可能很大)。`cap` 保留原来「最多数到 limit 条」的口径。
   */
  pendingCount(to_role: string, cap = 50): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM demo_bot_handoff WHERE to_role = ? AND status = 'pending' LIMIT ?)").get(to_role, cap) as { n: number };
    return Number(row.n);
  }

  /** 人(或 Gate Captain UI)确认收到。ack 不产生任何交易所效果。 */
  ack(id: string, at = Date.now()): BotHandoff | null {
    const cur = this.handoffById(id);
    if (!cur) return null;
    if (cur.status === 'acked') return cur;
    this.db.prepare("UPDATE demo_bot_handoff SET status = 'acked', acked_at = ? WHERE handoff_id = ?").run(at, id);
    return { ...cur, status: 'acked', acked_at: at };
  }
}
