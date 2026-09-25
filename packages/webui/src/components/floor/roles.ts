/**
 * 角色的展示元数据:颜色、徽章、桌子名、桌位、工作台入口、像素位图。
 * 「颜色 = 角色」贯穿楼层、右栏 tile 与交接流(设计稿 §5)。
 *
 * 徽章口径来自 notebook §3:AI = 会调工具的 LLM;CODE = 纯代码裁决(模型只解释);
 * EXEC = 受保护执行服务(唯一 exchange.write 持有者)。有头像不等于能自由调工具。
 */
import { t } from '@/lib/i18n';
import { SHAPES, type FloorPrefs, type SpriteShape } from './prefs';
import type { BotProfileWithPresence as BotProfile, BotRole } from './types';

export type RoleBadge = 'AI' | 'CODE' | 'EXEC';

export interface RoleMeta {
  role: BotRole;
  /** 楼层上的短名(参考物里的 HELM / SCOUT 那种) */
  callsign: string;
  /** 英文角色名,不翻 */
  title: string;
  /** 桌牌上的中文原文;经 resolveRoleMeta 出来时已 t() 过 */
  desk: string;
  badge: RoleBadge;
  color: string;
  /** 桌位,百分比坐标(楼层容器 1000×560 的视口里) */
  x: number;
  y: number;
  /** 点「打开工作台」去哪个 hash 页 */
  page: string;
  /** 中文原文;经 resolveRoleMeta 出来时已 t() 过 */
  pageLabel: string;
  sprite: string[];
  shape: SpriteShape;
}


export const ROLE_META: Record<BotRole, RoleMeta> = {
  gate_captain: { role: 'gate_captain', callsign: 'HELM', title: 'Gate Captain', desk: '指挥台 · 交接桌', badge: 'AI', color: '#ff7a5c', x: 50, y: 34, page: 'agent', pageLabel: 'Agent 对话', sprite: SHAPES.blob.rows, shape: 'blob' },
  radar: { role: 'radar', callsign: 'RADAR', title: 'Radar', desk: '雷达台', badge: 'AI', color: '#9be15d', x: 15, y: 20, page: 'intel', pageLabel: '信息员', sprite: SHAPES.tall.rows, shape: 'tall' },
  strategy_lab: { role: 'strategy_lab', callsign: 'LAB', title: 'Strategy Lab', desk: '策略实验台', badge: 'AI', color: '#c98bff', x: 85, y: 20, page: 'my-strategies', pageLabel: '我的策略', sprite: SHAPES.boxy.rows, shape: 'boxy' },
  thread_manager: { role: 'thread_manager', callsign: 'THREAD', title: 'Thread Manager', desk: '论点台', badge: 'AI', color: '#5ec8ff', x: 15, y: 54, page: 'judgments', pageLabel: '判断记录', sprite: SHAPES.wide.rows, shape: 'wide' },
  reviewer: { role: 'reviewer', callsign: 'AUDIT', title: 'Reviewer', desk: '复盘台', badge: 'AI', color: '#ffd166', x: 85, y: 54, page: 'history', pageLabel: '复盘', sprite: SHAPES.tall.rows, shape: 'tall' },
  portfolio_manager: { role: 'portfolio_manager', callsign: 'BOOK', title: 'Portfolio Manager', desk: '组合台', badge: 'AI', color: '#f4a261', x: 15, y: 86, page: 'trade', pageLabel: '交易', sprite: SHAPES.boxy.rows, shape: 'boxy' },
  risk_sentinel: { role: 'risk_sentinel', callsign: 'SENTINEL', title: 'Risk Sentinel', desk: '风控哨台', badge: 'CODE', color: '#ff5d8f', x: 85, y: 86, page: 'settings', pageLabel: '设置 · 风控', sprite: SHAPES.wide.rows, shape: 'wide' },
  executor: { role: 'executor', callsign: 'EXEC', title: 'Executor', desk: '执行台', badge: 'EXEC', color: '#4fd1c5', x: 50, y: 82, page: 'agent', pageLabel: 'Agent · 执行', sprite: SHAPES.blob.rows, shape: 'blob' },
  // 2026-09-20 第九个角色:OKX.AI 信号市场(入站 relay / 发布 / 身份 / 售后),代码驱动。中列 HELM 与 EXEC 之间。
  asp_agent: { role: 'asp_agent', callsign: 'MARKET', title: 'ASP Agent', desk: '市场台 · OKX.AI', badge: 'CODE', color: '#7fd1ff', x: 50, y: 58, page: 'market', pageLabel: '信号市场', sprite: SHAPES.wide.rows, shape: 'wide' },
};

export const ROLE_ORDER: BotRole[] = ['gate_captain', 'radar', 'thread_manager', 'strategy_lab', 'portfolio_manager', 'risk_sentinel', 'reviewer', 'executor', 'asp_agent'];

/**
 * 网关名册里出现了前端还没写 meta 的角色(以后后端再加角色时的兜底):给一套通用外观,
 * 桌位按顺序排在底墙空档(中列 y≈70 起横向铺开),右栏能点、交接流能画;想好看再补一条 ROLE_META。
 */
const FALLBACK_COLORS = ['#b8c4ff', '#ffd6a5', '#caffbf', '#ffadad', '#bdb2ff'];
export function fallbackRoleMeta(role: string, index: number): RoleMeta {
  const slotsX = [32, 68, 20, 80, 50];
  return {
    role: role as BotRole,
    callsign: role.replace(/_agent$/, '').replace(/_/g, ' ').toUpperCase().slice(0, 8) || 'AGENT',
    title: role.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    desk: `${role} 台`,
    badge: 'CODE',
    color: FALLBACK_COLORS[index % FALLBACK_COLORS.length]!,
    x: slotsX[index % slotsX.length]!,
    y: 70 + Math.floor(index / slotsX.length) * 12,
    page: 'agent',
    pageLabel: 'Agent',
    sprite: SHAPES.blob.rows,
    shape: 'blob',
  };
}

/** 名册里的角色顺序:已知的按 ROLE_ORDER,未知的按名册出现顺序追加在后。 */
export function orderedRoles(roles: readonly string[]): BotRole[] {
  const known = ROLE_ORDER.filter((r) => roles.includes(r));
  const extra = roles.filter((r) => !(ROLE_ORDER as string[]).includes(r)) as BotRole[];
  return [...known, ...extra];
}

export const USER_COLOR = '#e8e6df';

export type RoleMetaMap = Record<BotRole, RoleMeta>;

/**
 * 把设置页的外观偏好(体型/颜色)合进默认元数据,并按当前语言翻好 desk / pageLabel。
 * 调用点要把语言算进 useMemo 的依赖,否则切语言后桌牌不跟着变。
 */
export function resolveRoleMeta(prefs: FloorPrefs, extraRoles: readonly string[] = []): RoleMetaMap {
  const out = {} as RoleMetaMap;
  for (const r of ROLE_ORDER) {
    const base = ROLE_META[r];
    const look = prefs.looks[r];
    const shape = look?.shape && SHAPES[look.shape] ? look.shape : base.shape;
    out[r] = { ...base, desk: t(base.desk), pageLabel: t(base.pageLabel), shape, sprite: SHAPES[shape].rows, color: look?.color ?? base.color };
  }
  extraRoles.filter((r) => !(r in out)).forEach((r, i) => {
    out[r as BotRole] = fallbackRoleMeta(r, i);
  });
  return out;
}

export function roleColor(r: BotRole | 'user', meta: RoleMetaMap = ROLE_META): string {
  return r === 'user' ? USER_COLOR : (meta[r] ?? fallbackRoleMeta(r, 0)).color;
}
export function roleCallsign(r: BotRole | 'user', meta: RoleMetaMap = ROLE_META): string {
  return r === 'user' ? 'YOU' : (meta[r] ?? fallbackRoleMeta(r, 0)).callsign;
}

/**
 * 本地兜底名册:与 gateway bots.ts 的 SEEDS 同源(enabled / note 逐字抄),网关还没有 /api/bots
 * 时用它把楼层画出来,并在右栏标注「名册来自本地,网关未提供」。
 */
const T0 = 0;
export const LOCAL_ROSTER: BotProfile[] = [
  { role: 'gate_captain', name: 'Gate Captain / 总协调', kind: 'llm_session', description: '用户目标、任务路由、结果汇总、待办与审批收件箱', model_pin: null, capabilities: ['state.read', 'bot.delegate', 'intent.propose', 'routine.propose'], memory_scope: '用户偏好、沟通方式、团队运行摘要', approval_boundary: '不能批准自己的提案,不能直接触达交易所', enabled: false, note: '占位:dispatcher / mission timeline 还没实现。今天的对话 Agent(chat.ts)只承担了它的一部分。', sort_order: 1, created_at: T0, updated_at: T0 },
  { role: 'radar', name: 'Radar / 信息与发现', kind: 'llm_recipe', description: '市场状态、新闻、候选与 MonitorSpec;每 12 小时短线筛选,每 3 天 / 每周中长线筛选', model_pin: null, capabilities: ['market.read', 'news.read', 'monitor.propose'], memory_scope: '信息源质量、候选表现、摘要偏好', approval_boundary: '只读,不生成订单;watchlist 提案默认要人点「应用」', enabled: true, note: null, sort_order: 2, created_at: T0, updated_at: T0 },
  { role: 'thread_manager', name: 'Thread Manager / 交易论点', kind: 'llm_recipe', description: '一个 StrategyThread 从 setup 到关闭的论点连续性', model_pin: null, capabilities: ['market.read', 'account.read', 'memory.read', 'intent.propose'], memory_scope: '按 symbol/strategy/thread 隔离的教训', approval_boundary: '只提议;数量、杠杆和是否允许由代码决定', enabled: true, note: null, sort_order: 3, created_at: T0, updated_at: T0 },
  { role: 'strategy_lab', name: 'Strategy Lab / 研究与优化', kind: 'llm_session+workers', description: 'StrategySpec、实验假设、回测任务和晋升提案', model_pin: null, capabilities: ['dataset.read', 'backtest.run', 'paper.register', 'strategy.propose'], memory_scope: '研究日志、失败假设、实验结果;不读取 Live 凭证', approval_boundary: '只能进入 DRAFT/BACKTEST/PAPER,晋升必须人批', enabled: false, note: '占位:策略库与回测已经有了(strategies.ts / backtest.ts),但还没有会自己派实验的 worker 池。', sort_order: 4, created_at: T0, updated_at: T0 },
  { role: 'portfolio_manager', name: 'Portfolio Manager / 组合经理', kind: 'hybrid', description: '总/净/簇敞口、风险预算、资金分配和组合计划', model_pin: null, capabilities: ['account.read', 'risk.read', 'portfolio.propose'], memory_scope: '组合目标与用户偏好;当前仓位永远现拉', approval_boundary: '输出 PortfolioPlan,不直接生成交易所效果', enabled: false, note: '占位:确定性 exposure engine 与 portfolio_snapshots 还没做(notebook Phase 3)。', sort_order: 5, created_at: T0, updated_at: T0 },
  { role: 'risk_sentinel', name: 'Risk Sentinel / 风控哨兵', kind: 'deterministic+explainer', description: '实时不变量、gate verdict、incident 与告警', model_pin: null, capabilities: ['account.read', 'policy.veto', 'incident.open', 'emergency_reduce.propose'], memory_scope: '告警去重与解释模板;实时指标不进长期记忆', approval_boundary: '代码可以拒绝/收紧,模型永远不能放宽', enabled: false, note: '占位:gates.ts 已经是它的心脏,但 alert fingerprint / incident 生命周期还没做(Phase 3)。', sort_order: 6, created_at: T0, updated_at: T0 },
  { role: 'reviewer', name: 'Reviewer / 评测与复盘', kind: 'llm_recipe+deterministic_eval', description: '反方审查、交易复盘、memory/skill/strategy 候选', model_pin: null, capabilities: ['episode.read', 'eval.run', 'memory.propose', 'strategy.review'], memory_scope: '经批准的 lesson 与评测结论', approval_boundary: '不能改活跃策略或风险参数,只能提出 diff', enabled: false, note: '占位:复盘(memory.ts runReflect)与归因(attribution.ts)已经在跑,但还不是一个会被 fan-out 叫醒的角色。', sort_order: 7, created_at: T0, updated_at: T0 },
  { role: 'asp_agent', name: 'ASP Agent / 信号市场', kind: 'deterministic', description: 'OKX.AI 入站、发布、身份、领款与售后', model_pin: null, capabilities: ['market.read', 'asp.publish', 'asp.manage'], memory_scope: '市场账本与订阅配置', approval_boundary: '不直连交易所,不转发外部信号;售后由人决策', enabled: true, note: '代码驱动;本批零模型调用', sort_order: 9, created_at: T0, updated_at: T0 },
  { role: 'executor', name: 'Executor / 执行服务', kind: 'protected_service', description: '消费已授权 plan、下单、保护腿、回执与对账', model_pin: null, capabilities: ['execution.consume_authorized_plan', 'exchange.write', 'reconcile.write'], memory_scope: '无自由文本记忆;只保存六记录、checkpoint 和回执', approval_boundary: '只接受 plan_hash/account_version/authorization 完整的结构化请求', enabled: true, note: null, sort_order: 8, created_at: T0, updated_at: T0 },
];
