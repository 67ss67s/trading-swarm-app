/**
 * §9.52 模型连接与角色底层:纯逻辑(没有 React),给 #models 页、顶栏胶囊、楼层横幅 / 角色卡共用。
 * 契约见 docs/demo/v3-ui-contract.md §9.52;字段名一字不改。
 */
import type { BotRole, BrainOption, CliTool, ConnectionKind, EffectiveSource, ModelConnection, ModelRole, ModelsView } from '@/api/types';
import { t, tmap } from '@/lib/i18n';

/** 固定顺序,与 GET /api/models 的 bindings 顺序一致 */
export const MODEL_ROLES: ModelRole[] = ['chat', 'judge', 'research', 'filter', 'reviewer', 'utility', 'decision'];

export const MODEL_ROLE_LABEL: Record<ModelRole, string> = tmap({
  chat: '对话',
  judge: '判断',
  research: '研究规划',
  filter: '策略过滤',
  reviewer: '复盘',
  utility: '信息员·杂务',
  decision: '判断要素(Jev)',
});

/** 每个角色在网关里具体管哪些调用(角色底层表的第二行说明) */
export const MODEL_ROLE_DUTY: Record<ModelRole, string> = tmap({
  chat: 'Agent 对话',
  judge: '开仓判断 / 线程复查',
  research: '研究 loop 规划、诊断与撰写',
  filter: '策略运行 agent 模式的入场过滤',
  reviewer: '复盘、反思、教训',
  utility: '信息员、筛选、仓位意见、议会等其余副脑调用',
  decision: '结构化判断要素(Decisions API),只能绑 OpenRouter',
});

/** 未绑定时回退到哪个旧槽位(decision 不回退 = 未设置) */
export const ROLE_FALLBACK: Record<ModelRole, 'main' | 'cheap' | null> = {
  chat: 'main',
  judge: 'main',
  research: 'main',
  filter: 'cheap',
  reviewer: 'cheap',
  utility: 'cheap',
  decision: null,
};

export const SOURCE_LABEL: Record<EffectiveSource, string> = tmap({
  binding: '绑定',
  fallback_main: '回退主脑',
  fallback_cheap: '回退副脑',
  unset: '未设置',
});

export const KIND_LABEL: Record<ConnectionKind, string> = tmap({
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  zai: '智谱 Z.ai',
  openai: 'OpenAI',
  openai_compatible: 'OpenAI 兼容',
  cli: '本机 CLI',
});

export const CONNECTION_KINDS: ConnectionKind[] = ['openrouter', 'anthropic', 'deepseek', 'zai', 'openai', 'openai_compatible', 'cli'];

/** 各 kind 的缺省 base_url(只作展示提示;openai_compatible 必填,cli 没有) */
export const DEFAULT_BASE_URL: Partial<Record<ConnectionKind, string>> = {
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com',
  zai: 'https://open.bigmodel.cn/api/paas/v4',
  openai: 'https://api.openai.com/v1',
};

export const CLI_TOOLS: CliTool[] = ['pi', 'claude', 'codex'];

/** decision 角色缺省模型 */
export const DECISION_DEFAULT_MODEL = '~typesafe/jev-latest';

/** model id 以 typesafe/ 或 ~typesafe/ 开头 = 只能给 decision 用 */
export function isDecisionOnlyModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.trim();
  return m.startsWith('typesafe/') || m.startsWith('~typesafe/');
}

/** 某角色能选的连接:decision 只列 openrouter */
export function connectionsForRole(role: ModelRole, connections: ModelConnection[]): ModelConnection[] {
  return role === 'decision' ? connections.filter((c) => c.kind === 'openrouter') : connections;
}

/** 某角色在某连接下的模型候选:非 decision 去掉 decision-only;decision 把缺省 Jev 顶到第一个 */
export function modelHintsForRole(role: ModelRole, conn: ModelConnection | null | undefined): string[] {
  const hints = conn?.models_hint ?? [];
  if (role !== 'decision') return hints.filter((m) => !isDecisionOnlyModel(m));
  return [DECISION_DEFAULT_MODEL, ...hints.filter((m) => m !== DECISION_DEFAULT_MODEL)];
}

/**
 * 换连接时模型怎么带:decision 缺省 Jev;原模型在新连接的候选里就保留;否则取第一个候选;
 * 没有候选(比如 CLI 用自己的缺省模型)给 null,让网关决定(需要时回 model_required)。
 */
export function pickModelForConnection(role: ModelRole, conn: ModelConnection, current: string | null): string | null {
  const hints = modelHintsForRole(role, conn);
  if (role === 'decision') return current && isDecisionOnlyModel(current) ? current : DECISION_DEFAULT_MODEL;
  if (current && hints.includes(current)) return current;
  return hints[0] ?? null;
}

/** status==='ok' 的连接数(顶栏胶囊的 n) */
export function okConnectionCount(view: ModelsView | null | undefined): number {
  return view ? view.connections.filter((c) => c.status === 'ok').length : 0;
}

/** 某角色是不是「绑定了,但绑的连接失效」——楼层 / 顶栏红点 */
export function roleBindingBroken(view: ModelsView | null | undefined, role: ModelRole): boolean {
  if (!view) return false;
  if (view.effective[role]?.source !== 'binding') return false;
  const b = view.bindings.find((x) => x.role === role);
  const conn = b?.connection_id ? view.connections.find((c) => c.id === b.connection_id) : null;
  return conn?.status === 'error';
}

/** 所有失效角色(顶栏胶囊 title 里列出来) */
export function brokenRoles(view: ModelsView | null | undefined): ModelRole[] {
  return MODEL_ROLES.filter((r) => roleBindingBroken(view, r));
}

/**
 * 楼层引导横幅:没有任何可用连接,并且两个旧槽位当前选的 CLI 都起不来。
 * models / brains / 槽位 kind 任何一个还没拿到(或老网关没这个路由)就不出横幅,免得误报。
 */
export function needsModelSetup(view: ModelsView | null | undefined, brains: BrainOption[] | null | undefined, slots: { brain: string; cheap_brain: string } | null | undefined): boolean {
  if (!view || !brains || !slots) return false;
  if (okConnectionCount(view) > 0) return false;
  const main = brains.find((b) => b.kind === slots.brain);
  const cheap = brains.find((b) => b.kind === slots.cheap_brain);
  if (!main || !cheap) return false;
  return main.available === false && cheap.available === false;
}

/** 楼层角色 → 模型角色。不调模型的角色返回 null。 */
export const BOT_MODEL_ROLE: Partial<Record<BotRole, ModelRole>> = {
  gate_captain: 'chat',
  thread_manager: 'judge',
  radar: 'utility',
  reviewer: 'reviewer',
  // Strategy Lab 的研究 loop / 改进环走 research 角色
  strategy_lab: 'research',
  // 组合经理 PROPOSE 的有界仓位意见走副脑那批杂务调用 = utility
  portfolio_manager: 'utility',
};

export interface RoleModelInfo {
  modelRole: ModelRole;
  source: EffectiveSource;
  name: string;
  broken: boolean;
}

export function botRoleModel(role: BotRole, view: ModelsView | null | undefined): RoleModelInfo | null {
  const modelRole = BOT_MODEL_ROLE[role];
  if (!modelRole || !view) return null;
  const eff = view.effective[modelRole];
  if (!eff) return null;
  return { modelRole, source: eff.source, name: eff.name, broken: roleBindingBroken(view, modelRole) };
}

/** 409 connection_in_use 的 body.roles 取出来(拿不到就空数组) */
export function inUseRoles(body: unknown): ModelRole[] {
  const roles = body && typeof body === 'object' ? (body as { roles?: unknown }).roles : null;
  return Array.isArray(roles) ? (roles.filter((r) => typeof r === 'string') as ModelRole[]) : [];
}

/** PUT 绑定的 400 错误码 → 人话 */
export function bindingErrorText(code: string, fallback: string): string {
  switch (code) {
    case 'decision_requires_openrouter':
      return t('判断要素只能绑 OpenRouter 连接');
    case 'decision_only_model':
      return t('typesafe/ 开头的模型只能给判断要素用');
    case 'model_required':
      return t('这个连接要指定模型');
    case 'not_found':
      return t('连接不存在(可能刚被删了)');
    default:
      return fallback;
  }
}

/** 连接名:label 缺省按 kind(CLI 带上工具名) */
export function connectionName(c: Pick<ModelConnection, 'label' | 'kind' | 'cli'>): string {
  if (c.label) return c.label;
  return c.kind === 'cli' && c.cli ? `${KIND_LABEL.cli} · ${c.cli}` : KIND_LABEL[c.kind];
}
