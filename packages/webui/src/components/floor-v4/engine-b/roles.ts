/**
 * 角色展示元数据 —— 与 src/components/floor/roles.ts 的 ROLE_META 同源(callsign / 颜色 / 桌名 / 工作台页 / 体型),
 * 原型页独立运行,所以这里抄一份而不是 import(那边会拉 i18n 与 React)。搬进 src/ 时直接换成 import。
 */
import { t, tmap } from '@/lib/i18n';
import type { Role, TaskDef } from './types';

export type SpriteShape = 'blob' | 'tall' | 'wide' | 'boxy' | 'cat' | 'bot';

export interface RoleInfo {
  role: Role;
  callsign: string;
  title: string;
  desk: string;
  color: string;
  page: string;
  pageLabel: string;
  shape: SpriteShape;
}

/** desk / pageLabel 是展示文案:读属性时才走 t(),语言运行时切换不会被冻住 */
function info(r: RoleInfo): RoleInfo {
  const { desk, pageLabel } = r;
  return Object.defineProperties(r, {
    desk: { get: () => t(desk), enumerable: true },
    pageLabel: { get: () => t(pageLabel), enumerable: true },
  });
}

export const ROLES: Record<Role, RoleInfo> = {
  gate_captain: info({ role: 'gate_captain', callsign: 'HELM', title: 'Gate Captain', desk: '指挥层 · 作战桌', color: '#ff7a5c', page: 'agent', pageLabel: 'Agent 对话', shape: 'blob' }),
  radar: info({ role: 'radar', callsign: 'RADAR', title: 'Radar', desk: '顶楼 · 雷达天文台', color: '#9be15d', page: 'intel', pageLabel: '信息员', shape: 'tall' }),
  thread_manager: info({ role: 'thread_manager', callsign: 'THREAD', title: 'Thread Manager', desk: '论点台 · 线索板', color: '#5ec8ff', page: 'judgments', pageLabel: '判断记录', shape: 'wide' }),
  strategy_lab: info({ role: 'strategy_lab', callsign: 'LAB', title: 'Strategy Lab', desk: '策略实验室', color: '#c98bff', page: 'my-strategies', pageLabel: '我的策略', shape: 'boxy' }),
  portfolio_manager: info({ role: 'portfolio_manager', callsign: 'BOOK', title: 'Portfolio Manager', desk: '组合台 · 账本墙', color: '#f4a261', page: 'trade', pageLabel: '交易', shape: 'boxy' }),
  risk_sentinel: info({ role: 'risk_sentinel', callsign: 'SENTINEL', title: 'Risk Sentinel', desk: '风控哨台 · 金库门', color: '#ff5d8f', page: 'settings', pageLabel: '设置 · 风控', shape: 'wide' }),
  executor: info({ role: 'executor', callsign: 'EXEC', title: 'Executor', desk: '底楼 · 交易台', color: '#4fd1c5', page: 'agent', pageLabel: 'Agent · 执行', shape: 'blob' }),
  asp_agent: info({ role: 'asp_agent', callsign: 'MARKET', title: 'ASP Agent', desk: '侧楼 · 信号小铺', color: '#7fd1ff', page: 'market', pageLabel: '信号市场', shape: 'wide' }),
  reviewer: info({ role: 'reviewer', callsign: 'AUDIT', title: 'Reviewer', desk: '侧楼 · 复盘图书馆', color: '#ffd166', page: 'history', pageLabel: '复盘', shape: 'tall' }),
};

export const ROLE_ORDER: Role[] = ['gate_captain', 'radar', 'thread_manager', 'strategy_lab', 'portfolio_manager', 'risk_sentinel', 'executor', 'asp_agent', 'reviewer'];

/** SHAPES 与 src/components/floor/prefs.ts 逐字同源 */
export const SHAPES: Record<SpriteShape, string[]> = {
  blob: ['....####....', '...######...', '..########..', '.##h#eeh#e#.', '.####ee####.', '.##########.', '..##.##.##..', '.###.##.###.', '.##..##..##.', '....#..#....', '...##..##...', '..##....##..'],
  tall: ['....####....', '...######...', '...#e##e#...', '...######...', '....####....', '..########..', '.##########.', '.##.####.##.', '.##.####.##.', '....####....', '....#..#....', '...##..##...'],
  wide: ['..........', '.##....##.', '..##..##..', '.########.', '##e####e##', '##########', '#.######.#', '#.#....#.#', '...#..#...', '..##..##..', '.##....##.', '..........'].map((r) => r.padEnd(12, '.')),
  boxy: ['.##########.', '.#h########.', '.##e####e##.', '.##########.', '.###.##.###.', '.####..####.', '.##########.', '..########..', '...##..##...', '...##..##...', '..###..###..', '............'],
  cat: ['.#........#.', '.##......##.', '.###....###.', '.##########.', '.#e######e#.', '.##########.', '.####.#####.', '..########..', '...######...', '..##.##.##..', '..##.##.##..', '............'],
  bot: ['.....##.....', '.....##.....', '..########..', '.#h########.', '.#e######e#.', '.##########.', '.###....###.', '.##########.', '..##.##.##..', '.###.##.###.', '.##..##..##.', '............'],
};

export const STATUS_LABEL: Record<string, string> = tmap({
  working: '在干活',
  waiting: '等着',
  stuck: '卡住了',
  idle: '空闲',
});

/** 原型任务:label / result 读属性时才翻译 */
function task(id: string, label: string, result: string, real: string): TaskDef {
  return { id, real, get label() { return t(label); }, get result() { return t(result); } };
}

/** NPC 对话「派个活」:每个角色 2–3 个一键任务;real = 接真数据时要调的入口 */
export const TASKS: Record<Role, TaskDef[]> = {
  radar: [
    task('scan_all', '扫一下全市场', '扫完 212 个币,3 个异动已进候选', 'POST /api/radar/scan'),
    task('watch_sol', '盯住 SOL', 'SOL 已加入观察列表,急动阈值 0.8%', 'POST /api/watchlist {symbol}'),
  ],
  strategy_lab: [
    task('bt_current', '回测当前策略', '均值回归 v3 · 90 天胜率 58%,Sharpe 1.42', 'POST /api/backtests {strategy_id}'),
    task('bt_eth', '回测当前策略 · ETH', 'ETH 上胜率 54%,回撤 6.1%', 'POST /api/backtests {strategy_id, symbol}'),
  ],
  thread_manager: [
    task('judge_btc', '现在判断一次 BTC', 'BTC:观望,等 84,500 回踩确认', 'POST /api/judgments/run {symbol}'),
    task('judge_sol', '现在判断一次 SOL', 'SOL:偏多,提议回踩 156 做多', 'POST /api/judgments/run {symbol}'),
  ],
  risk_sentinel: [
    task('risk_check', '查一遍风险', '11 道闸全绿,今日亏损 0.41%/3%', 'POST /api/risk/check'),
  ],
  executor: [
    task('positions', '看看持仓', '5 笔持仓,保护腿 5/5 在位', 'GET /api/positions'),
    task('reconcile', '对一次账', '对账完成,零差异', 'POST /api/reconcile'),
  ],
  asp_agent: [
    task('subs', '看订阅信号', '6 个订阅,今天入站 14 条', 'GET /api/asp/subscriptions'),
  ],
  reviewer: [
    task('retro_yday', '复盘昨天', '昨天 9 笔,归因完成,提炼 2 条教训', 'POST /api/retro/run {date}'),
  ],
  portfolio_manager: [
    task('exposure', '重算敞口', '总敞口 38%,净 +12%,预算余 61%', 'POST /api/portfolio/plan'),
  ],
  gate_captain: [
    task('digest', '汇总今天的待办', '2 个待批、1 个晋升提案、0 个告警', 'POST /api/captain/digest'),
    task('standup', '开个站会', '站会开完了,大家各回各位', 'POST /api/captain/meeting'),
  ],
};
