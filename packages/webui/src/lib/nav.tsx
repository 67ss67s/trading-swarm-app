import { ArrowLeftRight, Bot, Building2, Cable, CalendarClock, LayoutGrid, ClipboardList, Crosshair, Eye, FileClock, FlaskConical, ListTodo, PlugZap, Radar, ScrollText, ShieldCheck, Shapes, SlidersHorizontal, Sprout, Store, type LucideIcon } from 'lucide-react';
import { t, tmap } from '@/lib/i18n';
import { isPageHidden } from '@/lib/edition';

// 仿 8793 frontend-design/src/lib/nav.tsx。历次加页见 git 历史(v3 复盘 / v3.2 记忆 / v3.5 策略库 / §9.46 我的策略 / §9.52 模型连接 / §9.53 矩阵研究)。
//
// 2026-09-25 信息架构重排(docs/design/ia-newcomer-audit-2026-09-25.md ②):分组从「系统有哪些角色」
// (值班/交易/团队/回顾/系统)改成「用户要做什么」:开始 → 值班 → 选币与策略 → 交易 → 回顾 → 设置,
// 另设一个默认折叠的「高级」组(信息员 / 事件区 / 日志)。「团队」这个分组名去掉。
// 09-25:「实盘部署台」(#strategies,旧策略库)退出导航 —— §9.54 旧库已不能开仓;路由 #strategies 落到 #my-strategies。
// 09-25 晚:「研究台」「批量验证」合成一个「策略研究」流程页(#strategy-research:选资产 → 海选 → 精修 → 验收 → 上岗),
// 和「我的策略」同组放最前;旧路由 #research / #matrix-study 保留(深链照常),只是不在侧栏单列。
// 09-28 开源版:信号市场改叫 OKX.AI,单独一组放在侧栏最上面(不画组名);策略研究的「精修」一步另开一页 #refine(侧栏叫「优化」),
// 紧跟在策略研究后面;旧楼层 / 日志两个旧页所有版本都不进侧栏(lib/edition.ts isPageHidden)。

export type Page = 'start' | 'connect' | 'trade' | 'agent' | 'watch' | 'floor' | 'floor-legacy' | 'intel' | 'events' | 'screener' | 'market' | 'judgments' | 'evolution' | 'memory' | 'history' | 'strategies' | 'research' | 'matrix-study' | 'strategy-research' | 'refine' | 'my-strategies' | 'models' | 'logs' | 'settings';

/** start 组不画组名:接入没完成时置顶一项「开始」,完成后收到侧栏底部一行 */
export type NavGroup = 'start' | 'okx' | 'ops' | 'pick' | 'trade' | 'review' | 'settings' | 'advanced';

export const NAV_GROUP_LABEL: Record<NavGroup, string> = tmap({ start: '开始', okx: 'OKX.AI', ops: '值班', pick: '选币与策略', trade: '交易', review: '回顾', settings: '设置', advanced: '高级' });

/** 侧栏分组顺序(start 由侧栏单独处理,不在这里) */
// 09-27 Jacky:交易才是核心,「交易」并进值班组(楼层下、Agent 上),独立的交易组不再单列
// 09-28:OKX.AI 一组放最上面
export const NAV_GROUP_ORDER: NavGroup[] = ['okx', 'ops', 'pick', 'review', 'settings', 'advanced'];

/** 不画组名的分组(只有一项,项名就说明了一切) */
export const NAV_HEADLESS_GROUPS: NavGroup[] = ['okx'];

/** 默认折叠的分组 */
export const NAV_COLLAPSIBLE_GROUPS: NavGroup[] = ['advanced'];

export interface NavItem {
  id: Page;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
}

/** 公网体验版构建(VITE_PUBLIC_DEMO=1,deploy/hostinger 用):不放这些页,侧栏不显示、深链也回默认页。 */
export const PUBLIC_DEMO_BUILD = import.meta.env['VITE_PUBLIC_DEMO'] === '1';
export const PUBLIC_DEMO_HIDDEN_PAGES: readonly Page[] = ['floor-legacy'];
export const pageAvailable = (page: Page): boolean => !PUBLIC_DEMO_BUILD || !PUBLIC_DEMO_HIDDEN_PAGES.includes(page);

export const ALL_NAV: NavItem[] = [
  // OKX.AI(原「信号市场」):在 OKX.AI 上买服务、收信号、上架自己的服务
  { id: 'market', label: 'OKX.AI', icon: Store, group: 'okx' },
  // 新手第一件事是接入:⑤ 的清单,每步读真实状态判完成
  { id: 'start', label: '开始', icon: ListTodo, group: 'start' },
  // 值班:完成接入后的日常首页 + 跟 agent 说话、批提议、切当前策略
  // 2026-09-25 楼层 v4(docs/design/floor-v4-2026-09-25.md)成为默认楼层:像素场景为主角,A 开放办公室 / B 大楼剖面可切换
  { id: 'floor', label: '楼层', icon: Building2, group: 'ops' },
  { id: 'trade', label: '交易', icon: ArrowLeftRight, group: 'ops' },
  // 旧楼层(卡片式)暂留一段时间,#floor-legacy
  { id: 'floor-legacy', label: '楼层(旧)', icon: LayoutGrid, group: 'ops' },
  { id: 'agent', label: 'Agent', icon: Bot, group: 'ops' },
  // 选币与策略:策略研究(推荐选币 → 海选 → 精修 → 验收 → 上岗)→ 我的策略;筛选 / 观察列表是手动选币的旧路
  { id: 'strategy-research', label: '策略研究', icon: FlaskConical, group: 'pick' },
  // 09-28:策略研究第 3 步「精修」单独成页(挑一组海选结果,在研究台里改规则、回测)
  { id: 'refine', label: '优化', icon: SlidersHorizontal, group: 'pick' },
  // §9.46 我的策略:研究产出的策略对象;详情顶部「设为 agent 当前策略」(§9.54)
  { id: 'my-strategies', label: '我的策略', icon: Shapes, group: 'pick' },
  { id: 'screener', label: '筛选', icon: Crosshair, group: 'pick' },
  // 09-07 盯盘参数页;09-25 改名「观察列表」(页面主体就是名单 + 加币 + 节奏)
  { id: 'watch', label: '观察列表', icon: Eye, group: 'pick' },
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
  { id: 'intel', label: '信息员', icon: Radar, group: 'advanced' },
  { id: 'events', label: '事件区', icon: CalendarClock, group: 'advanced' },
  { id: 'logs', label: '日志', icon: ScrollText, group: 'advanced' },
];

/** 侧栏 / 命令面板用的导航 */
export const NAV: NavItem[] = ALL_NAV.filter((n) => !isPageHidden(n.id) && pageAvailable(n.id));

/** 不在侧栏、但路由仍在的页(深链进入时顶栏标题用) */
// 研究台(2026-09-21 研究工作台)/ 批量验证(§9.53 B 矩阵研究)已并进「策略研究」,深链仍可进
export const HIDDEN_PAGE_LABEL: Partial<Record<Page, string>> = { research: '研究台', 'matrix-study': '批量验证' };

export function pageLabel(page: Page): string {
  const label = NAV.find((n) => n.id === page)?.label ?? HIDDEN_PAGE_LABEL[page];
  return label ? t(label) : '';
}
