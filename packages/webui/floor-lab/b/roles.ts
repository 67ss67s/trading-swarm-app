/**
 * 角色展示元数据 —— 与 src/components/floor/roles.ts 的 ROLE_META 同源(callsign / 颜色 / 桌名 / 工作台页 / 体型),
 * 原型页独立运行,所以这里抄一份而不是 import(那边会拉 i18n 与 React)。搬进 src/ 时直接换成 import。
 */
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

export const ROLES: Record<Role, RoleInfo> = {
  gate_captain: { role: 'gate_captain', callsign: 'HELM', title: 'Gate Captain', desk: '指挥层 · 作战桌', color: '#ff7a5c', page: 'agent', pageLabel: 'Agent 对话', shape: 'blob' },
  radar: { role: 'radar', callsign: 'RADAR', title: 'Radar', desk: '顶楼 · 雷达天文台', color: '#9be15d', page: 'intel', pageLabel: '信息员', shape: 'tall' },
  thread_manager: { role: 'thread_manager', callsign: 'THREAD', title: 'Thread Manager', desk: '论点台 · 线索板', color: '#5ec8ff', page: 'judgments', pageLabel: '判断记录', shape: 'wide' },
  strategy_lab: { role: 'strategy_lab', callsign: 'LAB', title: 'Strategy Lab', desk: '策略实验室', color: '#c98bff', page: 'my-strategies', pageLabel: '我的策略', shape: 'boxy' },
  portfolio_manager: { role: 'portfolio_manager', callsign: 'BOOK', title: 'Portfolio Manager', desk: '组合台 · 账本墙', color: '#f4a261', page: 'trade', pageLabel: '交易', shape: 'boxy' },
  risk_sentinel: { role: 'risk_sentinel', callsign: 'SENTINEL', title: 'Risk Sentinel', desk: '风控哨台 · 金库门', color: '#ff5d8f', page: 'settings', pageLabel: '设置 · 风控', shape: 'wide' },
  executor: { role: 'executor', callsign: 'EXEC', title: 'Executor', desk: '底楼 · 交易台', color: '#4fd1c5', page: 'agent', pageLabel: 'Agent · 执行', shape: 'blob' },
  asp_agent: { role: 'asp_agent', callsign: 'MARKET', title: 'ASP Agent', desk: '侧楼 · 信号小铺', color: '#7fd1ff', page: 'market', pageLabel: '信号市场', shape: 'wide' },
  reviewer: { role: 'reviewer', callsign: 'AUDIT', title: 'Reviewer', desk: '侧楼 · 复盘图书馆', color: '#ffd166', page: 'history', pageLabel: '复盘', shape: 'tall' },
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

export const STATUS_LABEL: Record<string, string> = {
  working: '在干活',
  waiting: '等着',
  stuck: '卡住了',
  idle: '空闲',
};

/** NPC 对话「派个活」:每个角色 2–3 个一键任务;real = 接真数据时要调的入口 */
export const TASKS: Record<Role, TaskDef[]> = {
  radar: [
    { id: 'scan_all', label: '扫一下全市场', result: '扫完 212 个币,3 个异动已进候选', real: 'POST /api/radar/scan' },
    { id: 'watch_sol', label: '盯住 SOL', result: 'SOL 已加入观察列表,急动阈值 0.8%', real: 'POST /api/watchlist {symbol}' },
  ],
  strategy_lab: [
    { id: 'bt_current', label: '回测当前策略', result: '均值回归 v3 · 90 天胜率 58%,Sharpe 1.42', real: 'POST /api/backtests {strategy_id}' },
    { id: 'bt_eth', label: '回测当前策略 · ETH', result: 'ETH 上胜率 54%,回撤 6.1%', real: 'POST /api/backtests {strategy_id, symbol}' },
  ],
  thread_manager: [
    { id: 'judge_btc', label: '现在判断一次 BTC', result: 'BTC:观望,等 84,500 回踩确认', real: 'POST /api/judgments/run {symbol}' },
    { id: 'judge_sol', label: '现在判断一次 SOL', result: 'SOL:偏多,提议回踩 156 做多', real: 'POST /api/judgments/run {symbol}' },
  ],
  risk_sentinel: [
    { id: 'risk_check', label: '查一遍风险', result: '11 道闸全绿,今日亏损 0.41%/3%', real: 'POST /api/risk/check' },
  ],
  executor: [
    { id: 'positions', label: '看看持仓', result: '5 笔持仓,保护腿 5/5 在位', real: 'GET /api/positions' },
    { id: 'reconcile', label: '对一次账', result: '对账完成,零差异', real: 'POST /api/reconcile' },
  ],
  asp_agent: [
    { id: 'subs', label: '看订阅信号', result: '6 个订阅,今天入站 14 条', real: 'GET /api/asp/subscriptions' },
  ],
  reviewer: [
    { id: 'retro_yday', label: '复盘昨天', result: '昨天 9 笔,归因完成,提炼 2 条教训', real: 'POST /api/retro/run {date}' },
  ],
  portfolio_manager: [
    { id: 'exposure', label: '重算敞口', result: '总敞口 38%,净 +12%,预算余 61%', real: 'POST /api/portfolio/plan' },
  ],
  gate_captain: [
    { id: 'digest', label: '汇总今天的待办', result: '2 个待批、1 个晋升提案、0 个告警', real: 'POST /api/captain/digest' },
    { id: 'standup', label: '开个站会', result: '站会开完了,大家各回各位', real: 'POST /api/captain/meeting' },
  ],
};
