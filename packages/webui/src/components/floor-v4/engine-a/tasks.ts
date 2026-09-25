/**
 * 游戏式交互 → 真实功能的映射表。原型里只走 mock + toast;每条注释写明接真数据时要调的入口。
 */
import { t } from '@/lib/i18n';
import type { RoleId, TaskIcon } from './types';

export interface TaskDef {
  id: string;
  label: string;
  icon: TaskIcon;
  /** 需要一个币种参数(拖币/命令行传入) */
  needsSymbol?: boolean;
  /** 真实入口(接线时照这个调) */
  real: string;
  /** mock 完成时的结果句 */
  result: string;
}

/** label / result 是展示文案:读属性时翻译(语言可运行时切换) */
function td(d: TaskDef): TaskDef {
  return {
    ...d,
    get label() {
      return t(d.label);
    },
    get result() {
      return t(d.result);
    },
  };
}
const drop = (task: string, verb: string) => ({
  task,
  get verb() {
    return t(verb);
  },
});

export const TASKS: Partial<Record<RoleId, TaskDef[]>> = {
  radar: [
    td({
      id: 'scan_all', label: '扫一下全市场', icon: 'scan',
      real: 'POST /api/radar/scan(Radar 立即筛选一轮)', // i18n-ignore(接线备注,不展示)
      result: '扫完 212 个币,发现 3 个异动',
    }),
    td({
      id: 'watch', label: '盯住某币', icon: 'eye', needsSymbol: true,
      real: 'POST /api/watchlist { symbol }(加入观察列表)', // i18n-ignore(接线备注,不展示)
      result: '已加入观察列表',
    }),
  ],
  thread_manager: [
    td({
      id: 'judge_now', label: '现在判断一次', icon: 'chat', needsSymbol: true,
      real: 'POST /api/judgments/run { symbol }(立即判断)', // i18n-ignore(接线备注,不展示)
      result: '判断完成:暂不动,等回踩',
    }),
  ],
  strategy_lab: [
    td({
      id: 'backtest', label: '回测当前策略', icon: 'flask', needsSymbol: true,
      real: 'POST /api/research/backtest { strategy_id, symbol }(研究引擎回测)', // i18n-ignore(接线备注,不展示)
      result: '回测完成:胜率 56%,盈亏比 1.7',
    }),
  ],
  risk_sentinel: [td({
      id: 'risk_check', label: '查一遍风险', icon: 'shield',
      real: 'GET /api/risk/check(风控不变量全检)', // i18n-ignore(接线备注,不展示)
      result: '风险检查通过,敞口 31%',
    })],
  executor: [td({
      id: 'positions', label: '看看持仓', icon: 'bolt',
      real: '#trade(持仓页)/ GET /api/positions', // i18n-ignore(接线备注,不展示)
      result: '5 个持仓,保护腿齐全',
    })],
  asp_agent: [td({
      id: 'signals', label: '看订阅信号', icon: 'shop',
      real: '#market(信号市场)/ GET /api/asp/inbox', // i18n-ignore(接线备注,不展示)
      result: '今天收到 4 条订阅信号',
    })],
  reviewer: [td({
      id: 'retro', label: '复盘昨天', icon: 'book',
      real: 'POST /api/retro/run { date: 昨天 }(复盘流水线)', // i18n-ignore(接线备注,不展示)
      result: '复盘完成:提炼 1 条教训',
    })],
  gate_captain: [td({
      id: 'brief', label: '给我一份简报', icon: 'chat',
      real: '#agent(Agent 对话,预选 HELM)', // i18n-ignore(接线备注,不展示)
      result: '简报已放进你的收件箱',
    })],
  portfolio_manager: [td({
      id: 'rebalance', label: '看看组合敞口', icon: 'coin',
      real: 'GET /api/portfolio/exposure', // i18n-ignore(接线备注,不展示)
      result: '总敞口 31%,簇敞口正常',
    })],
};

/** 拖币到工位的语义(顶栏行情卡 → 工位) */
export const COIN_DROP: Partial<Record<RoleId, { task: string; verb: string }>> = {
  radar: drop('watch', '加入观察列表'),
  thread_manager: drop('judge_now', '立即判断'),
  strategy_lab: drop('backtest', '用当前策略回测'),
};

/** 「聊聊」的真实入口 */
export function chatHref(role: string): string {
  return `#agent?role=${encodeURIComponent(role)}`;
}

/** 「去进化页看全部」 */
export function evoHref(role: string, date: string): string {
  return `#evolution?role=${encodeURIComponent(role)}&date=${encodeURIComponent(date)}`;
}

/** 命令行解析:「让 radar 盯 SOL」「回测 当前策略 ETH」「查风险」 */
export function parseCommand(input: string): { role: RoleId; task: string; symbol?: string } | null {
  const s = input.trim();
  if (!s) return null;
  const sym = (s.match(/\b([A-Za-z]{2,10})(?:USDT)?\b(?!.*\b[A-Za-z]{2,10}\b)/)?.[1] ?? '').toUpperCase();
  const symbol = sym && !['RADAR', 'LAB', 'THREAD', 'EXEC', 'AUDIT', 'BOOK', 'HELM', 'MARKET', 'SENTINEL'].includes(sym) ? sym : undefined;
  const has = (...ws: string[]) => ws.some((w) => s.toLowerCase().includes(w.toLowerCase()));
  if (has('回测', 'backtest')) return { role: 'strategy_lab', task: 'backtest', symbol }; // i18n-ignore(命令解析词表)
  if (has('盯', 'watch', '观察')) return { role: 'radar', task: 'watch', symbol }; // i18n-ignore(命令解析词表)
  if (has('扫', 'scan')) return { role: 'radar', task: 'scan_all' }; // i18n-ignore(命令解析词表)
  if (has('判断', 'judge')) return { role: 'thread_manager', task: 'judge_now', symbol }; // i18n-ignore(命令解析词表)
  if (has('风险', 'risk')) return { role: 'risk_sentinel', task: 'risk_check' }; // i18n-ignore(命令解析词表)
  if (has('持仓', 'position')) return { role: 'executor', task: 'positions' }; // i18n-ignore(命令解析词表)
  if (has('复盘', 'retro')) return { role: 'reviewer', task: 'retro' }; // i18n-ignore(命令解析词表)
  if (has('信号', 'signal')) return { role: 'asp_agent', task: 'signals' }; // i18n-ignore(命令解析词表)
  if (has('敞口', '组合')) return { role: 'portfolio_manager', task: 'rebalance' }; // i18n-ignore(命令解析词表)
  if (has('简报', 'brief')) return { role: 'gate_captain', task: 'brief' }; // i18n-ignore(命令解析词表)
  return null;
}
