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

// ------------------------------------------------------------------ 按 agent 分卡(#models 主体,2026-09-25 重做)

/** 每张 agent 卡的标题 / 楼层呼号 / 一句话说明(干什么、用在哪) */
export interface RoleCardMeta {
  title: string;
  callsign: string;
  blurb: string;
}

/** 原文表(中文 = 词典 key);取用走 roleCard(),语言切换后现取现译 */
const ROLE_CARD_RAW: Record<ModelRole, RoleCardMeta> = {
  chat: { title: '对话', callsign: 'Captain / HELM', blurb: '在 Agent 页跟你对话、调工具、起草策略;楼层上的 Captain 就是它。' },
  judge: { title: '判断', callsign: 'Thread manager', blurb: '开仓前判断、持仓线程复查;自动交易每一次决策都问它,要稳。' },
  research: { title: '研究', callsign: 'Strategy Lab', blurb: '研究台 loop 的规划、诊断和写报告;研究页和策略改进环用它。' },
  filter: { title: '策略过滤', callsign: 'Strategy runner', blurb: '策略以 agent 模式运行时,每个入场信号先问它放不放行。' },
  reviewer: { title: '复盘', callsign: 'Reviewer', blurb: '平仓后复盘、反思、沉淀教训;复盘账本里的结论出自它。' },
  utility: { title: '信息员 / 筛选', callsign: 'Radar', blurb: '信息员播报、市场筛选、仓位意见、议会等杂务;调用最多,适合便宜快的模型。' },
  decision: { title: '判断要素', callsign: 'Jev', blurb: '策略里的结构化判断(是否 / 打分),走 OpenRouter Decisions API,只能用 Jev 等决策模型;不设置则策略的判断块不可用。' },
};

export function roleCard(role: ModelRole): RoleCardMeta {
  const m = ROLE_CARD_RAW[role];
  return { title: t(m.title), callsign: m.callsign, blurb: t(m.blurb) };
}

/** 词条齐全性测试用:所有卡片原文 */
export const ROLE_CARD_TEXTS: string[] = Object.values(ROLE_CARD_RAW).flatMap((m) => [m.title, m.blurb]);

/** 卡上分段选择:本机 CLI / API key / 用默认(decision 没有 CLI,「用默认」= 不启用) */
export type BindingMode = 'cli' | 'api' | 'default';

/** API key 类连接类型(新建连接的选项) */
export const API_KINDS: ConnectionKind[] = ['openrouter', 'anthropic', 'deepseek', 'zai', 'openai', 'openai_compatible'];

/** decision 只能选 openrouter 新建 */
export function apiKindsForRole(role: ModelRole): ConnectionKind[] {
  return role === 'decision' ? ['openrouter'] : API_KINDS;
}

/** 当前绑定属于哪种模式(绑定的连接找不到时按 API 算,让用户改掉) */
export function bindingMode(view: ModelsView, role: ModelRole): BindingMode {
  const b = view.bindings.find((x) => x.role === role);
  if (!b?.connection_id) return 'default';
  const c = view.connections.find((x) => x.id === b.connection_id);
  return c?.kind === 'cli' ? 'cli' : 'api';
}

/** 复用已有的某个 CLI 连接(同一工具只建一条) */
export function findCliConnection(view: ModelsView, tool: CliTool): ModelConnection | null {
  return view.connections.find((c) => c.kind === 'cli' && c.cli === tool) ?? null;
}

/** API 模式下某角色能选的已有连接:去掉 CLI;decision 只 openrouter */
export function apiConnectionsForRole(role: ModelRole, connections: ModelConnection[]): ModelConnection[] {
  return connectionsForRole(role, connections).filter((c) => c.kind !== 'cli');
}

/** CLI 模式的模型候选:已有 CLI 连接的 models_hint ∪ /api/brains 目录里该工具的推荐模型(去重,保序) */
export function cliModelHints(view: ModelsView, tool: CliTool, brains: BrainOption[] | null | undefined): string[] {
  const out: string[] = [];
  const push = (m: string) => {
    if (m && !out.includes(m) && !isDecisionOnlyModel(m)) out.push(m);
  };
  findCliConnection(view, tool)?.models_hint.forEach(push);
  brains?.find((b) => b.kind === tool)?.models.forEach(push);
  return out;
}

/** 新建 API 连接时的模型候选(连接还不存在,取各家常用缺省,与网关 KIND_DEFAULTS 对齐) */
export const KIND_MODEL_DEFAULTS: Partial<Record<ConnectionKind, string[]>> = {
  openrouter: ['deepseek/deepseek-v4.1-flash', DECISION_DEFAULT_MODEL],
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  zai: ['glm-5.3', 'glm-5-turbo'],
  openai: ['gpt-5.4', 'gpt-5.4-mini'],
};

export function newKindModelHints(role: ModelRole, kind: ConnectionKind): string[] {
  const hints = KIND_MODEL_DEFAULTS[kind] ?? [];
  if (role !== 'decision') return hints.filter((m) => !isDecisionOnlyModel(m));
  return [DECISION_DEFAULT_MODEL, ...hints.filter((m) => m !== DECISION_DEFAULT_MODEL && isDecisionOnlyModel(m))];
}

/** 卡片草稿(还没保存的选择) */
export interface CardDraft {
  mode: BindingMode;
  cli: CliTool | null;
  /** API 模式:已有连接 id,或 NEW_CONNECTION = 就地新建 */
  connectionId: string | null;
  newKind: ConnectionKind | null;
  model: string;
}

export const NEW_CONNECTION = '__new__';

/** 从服务端绑定得到草稿初值 */
export function draftFromView(view: ModelsView, role: ModelRole): CardDraft {
  const b = view.bindings.find((x) => x.role === role);
  const conn = b?.connection_id ? (view.connections.find((c) => c.id === b.connection_id) ?? null) : null;
  const mode = bindingMode(view, role);
  const firstCli = view.cli_detected.find((d) => d.ok)?.tool ?? null;
  const firstApi = apiConnectionsForRole(role, view.connections)[0]?.id ?? null;
  return {
    mode,
    cli: mode === 'cli' ? (conn?.cli ?? null) : firstCli,
    connectionId: mode === 'api' ? (b?.connection_id ?? null) : firstApi,
    newKind: null,
    model: b?.model ?? '',
  };
}

/** 草稿和服务端比有没有改动(新建连接一定算改动) */
export function draftDirty(view: ModelsView, role: ModelRole, d: CardDraft): boolean {
  const b = view.bindings.find((x) => x.role === role) ?? { role, connection_id: null, model: null };
  const mode = bindingMode(view, role);
  if (d.mode !== mode) return true;
  if (d.mode === 'default') return false;
  const model = d.model.trim() || null;
  if (d.mode === 'cli') {
    const conn = b.connection_id ? view.connections.find((c) => c.id === b.connection_id) : null;
    return conn?.cli !== d.cli || model !== b.model;
  }
  if (d.connectionId === NEW_CONNECTION) return true;
  return d.connectionId !== b.connection_id || model !== b.model;
}

/** 保存前的前端校验;返回人话错误或 null */
export function draftProblem(role: ModelRole, d: CardDraft, newKey: string, newBaseUrl: string): string | null {
  if (d.mode === 'default') return null;
  const model = d.model.trim();
  if (d.mode === 'cli') {
    if (role === 'decision') return t('判断要素只能绑 OpenRouter 连接');
    if (!d.cli) return t('选一个本机 CLI');
    return null;
  }
  if (role !== 'decision' && isDecisionOnlyModel(model)) return t('typesafe/ 开头的模型只能给判断要素用');
  if (!d.connectionId) return t('选一个连接,或新建一个');
  if (d.connectionId === NEW_CONNECTION) {
    if (!d.newKind) return t('先选连接类型');
    if (d.newKind === 'openai_compatible' && !newBaseUrl.trim()) return t('OpenAI 兼容连接要填 base_url');
    const k = newKey.trim();
    if (d.newKind !== 'openai_compatible' && !k) return t('填 API key');
    if (k && (k.length < 16 || /\s/.test(k))) return t('API key 至少 16 位,不能有空白');
  }
  if (role !== 'decision' && !model) return t('这个连接要指定模型');
  return null;
}

/** 卡片状态点:本地测试结果优先;绑定看连接状态;回退 / 未设置没测过就是灰 */
export type CardHealth = 'ok' | 'error' | 'untested' | 'unset';
export function cardHealth(view: ModelsView, role: ModelRole, localTest: { ok: boolean } | null): CardHealth {
  const eff = view.effective[role];
  if (eff?.source === 'unset') return 'unset';
  if (localTest) return localTest.ok ? 'ok' : 'error';
  if (eff?.source !== 'binding') return 'untested';
  const b = view.bindings.find((x) => x.role === role);
  const conn = b?.connection_id ? view.connections.find((c) => c.id === b.connection_id) : null;
  return conn ? conn.status : 'error';
}
