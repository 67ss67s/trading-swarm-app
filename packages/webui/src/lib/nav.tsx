import { ArrowLeftRight, Bot, Building2, Cable, Grid3x3, CalendarClock, LayoutGrid, ClipboardList, Crosshair, Eye, FileClock, FlaskConical, ListTodo, PlugZap, Radar, Rocket, ScrollText, ShieldCheck, Shapes, Sprout, Store, type LucideIcon } from 'lucide-react';
import { t, tmap } from '@/lib/i18n';

// 仿 8793 frontend-design/src/lib/nav.tsx。历次加页见 git 历史(v3 复盘 / v3.2 记忆 / v3.5 策略库 / §9.46 我的策略 / §9.52 模型连接 / §9.53 矩阵研究)。
//
// 2026-09-25 信息架构重排(docs/design/ia-newcomer-audit-2026-09-25.md ②):分组从「系统有哪些角色」
// (值班/交易/团队/回顾/系统)改成「用户要做什么」:开始 → 值班 → 选币与策略 → 交易 → 回顾 → 设置,
// 另设一个默认折叠的「高级」组(信号市场 / 信息员 / 事件区 / 日志 / 实盘部署台)。「团队」这个分组名去掉。

export type Page = 'start' | 'connect' | 'trade' | 'agent' | 'watch' | 'floor' | 'floor-v4' | 'intel' | 'events' | 'screener' | 'market' | 'judgments' | 'evolution' | 'memory' | 'history' | 'strategies' | 'research' | 'matrix-study' | 'my-strategies' | 'models' | 'logs' | 'settings';

/** start 组不画组名:接入没完成时置顶一项「开始」,完成后收到侧栏底部一行 */
export type NavGroup = 'start' | 'ops' | 'pick' | 'trade' | 'review' | 'settings' | 'advanced';

export const NAV_GROUP_LABEL: Record<NavGroup, string> = tmap({ start: '开始', ops: '值班', pick: '选币与策略', trade: '交易', review: '回顾', settings: '设置', advanced: '高级' });

/** 侧栏分组顺序(start 由侧栏单独处理,不在这里) */
export const NAV_GROUP_ORDER: NavGroup[] = ['ops', 'pick', 'trade', 'review', 'settings', 'advanced'];

/** 默认折叠的分组 */
export const NAV_COLLAPSIBLE_GROUPS: NavGroup[] = ['advanced'];

export interface NavItem {
  id: Page;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
}

export const NAV: NavItem[] = [
  // 新手第一件事是接入:⑤ 的清单,每步读真实状态判完成
  { id: 'start', label: '开始', icon: ListTodo, group: 'start' },
  // 值班:完成接入后的日常首页 + 跟 agent 说话、批提议、切当前策略
  { id: 'floor', label: '楼层', icon: LayoutGrid, group: 'ops' },
  // 2026-09-25 楼层 v4(docs/design/floor-v4-2026-09-25.md):像素场景为主角,A 开放办公室 / B 大楼剖面可切换;另一工作线 合并前与旧楼层并存
  { id: 'floor-v4', label: '楼层(新)', icon: Building2, group: 'ops' },
  { id: 'agent', label: 'Agent', icon: Bot, group: 'ops' },
  // 选币与策略:「今天该看什么币」→ 名单 → 找策略 → 设为 agent 当前策略(我的策略详情里的按钮)
  { id: 'screener', label: '筛选', icon: Crosshair, group: 'pick' },
  // 09-07 盯盘参数页;09-25 改名「观察列表」(页面主体就是名单 + 加币 + 节奏)
  { id: 'watch', label: '观察列表', icon: Eye, group: 'pick' },
  // 2026-09-21 研究工作台:冻结数据 + 策略,A/B/C 三臂回放
  { id: 'research', label: '研究台', icon: FlaskConical, group: 'pick' },
  // §9.53 B 矩阵研究:资产 × 周期 × 策略族 × 两臂;对话推荐卡「去研究台验证」跳这里
  { id: 'matrix-study', label: '矩阵研究', icon: Grid3x3, group: 'pick' },
  // §9.46 我的策略:研究产出的策略对象;详情顶部「设为 agent 当前策略」(§9.54)
  { id: 'my-strategies', label: '我的策略', icon: Shapes, group: 'pick' },
  { id: 'trade', label: '交易', icon: ArrowLeftRight, group: 'trade' },
  { id: 'history', label: '复盘', icon: FileClock, group: 'review' },
  // 判断记录 → 逐次判断:看单次;复盘里的「这类判断值不值」看聚合
  { id: 'judgments', label: '逐次判断', icon: ClipboardList, group: 'review' },
  // 2026-09-23 进化页;#memory 映射到它的「记忆」标签
  { id: 'evolution', label: '进化', icon: Sprout, group: 'review' },
  // 设置:接入(交易所账户 / 账户模式 / 交易市场 / 模型 / 保护单 / 网络)→ 模型连接 → 风控与自动化
  { id: 'connect', label: '接入', icon: PlugZap, group: 'settings' },
  { id: 'models', label: '模型连接', icon: Cable, group: 'settings' },
  { id: 'settings', label: '风控与自动化', icon: ShieldCheck, group: 'settings' },
  // 高级(默认折叠)
  { id: 'market', label: '信号市场', icon: Store, group: 'advanced' },
  { id: 'intel', label: '信息员', icon: Radar, group: 'advanced' },
  { id: 'events', label: '事件区', icon: CalendarClock, group: 'advanced' },
  { id: 'logs', label: '日志', icon: ScrollText, group: 'advanced' },
  // #strategies 实盘部署台:「我的策略 → 运行规则」的深链目标;R1 前维持,放进高级让人找得到
  { id: 'strategies', label: '实盘部署台', icon: Rocket, group: 'advanced' },
];

/** 不在侧栏、但路由仍在的页(深链进入时顶栏标题用) */
export const HIDDEN_PAGE_LABEL: Partial<Record<Page, string>> = {};

export function pageLabel(page: Page): string {
  const label = NAV.find((n) => n.id === page)?.label ?? HIDDEN_PAGE_LABEL[page];
  return label ? t(label) : '';
}
