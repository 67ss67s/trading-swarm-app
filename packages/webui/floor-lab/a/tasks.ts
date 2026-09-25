/**
 * 游戏式交互 → 真实功能的映射表。原型里只走 mock + toast;每条注释写明接真数据时要调的入口。
 */
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

export const TASKS: Partial<Record<RoleId, TaskDef[]>> = {
  radar: [
    { id: 'scan_all', label: '扫一下全市场', icon: 'scan', real: 'POST /api/radar/scan(Radar 立即筛选一轮)', result: '扫完 212 个币,发现 3 个异动' },
    { id: 'watch', label: '盯住某币', icon: 'eye', needsSymbol: true, real: 'POST /api/watchlist { symbol }(加入观察列表)', result: '已加入观察列表' },
  ],
  thread_manager: [
    { id: 'judge_now', label: '现在判断一次', icon: 'chat', needsSymbol: true, real: 'POST /api/judgments/run { symbol }(立即判断)', result: '判断完成:暂不动,等回踩' },
  ],
  strategy_lab: [
    { id: 'backtest', label: '回测当前策略', icon: 'flask', needsSymbol: true, real: 'POST /api/research/backtest { strategy_id, symbol }(研究引擎回测)', result: '回测完成:胜率 56%,盈亏比 1.7' },
  ],
  risk_sentinel: [{ id: 'risk_check', label: '查一遍风险', icon: 'shield', real: 'GET /api/risk/check(风控不变量全检)', result: '风险检查通过,敞口 31%' }],
  executor: [{ id: 'positions', label: '看看持仓', icon: 'bolt', real: '#trade(持仓页)/ GET /api/positions', result: '5 个持仓,保护腿齐全' }],
  asp_agent: [{ id: 'signals', label: '看订阅信号', icon: 'shop', real: '#market(信号市场)/ GET /api/asp/inbox', result: '今天收到 4 条订阅信号' }],
  reviewer: [{ id: 'retro', label: '复盘昨天', icon: 'book', real: 'POST /api/retro/run { date: 昨天 }(复盘流水线)', result: '复盘完成:提炼 1 条教训' }],
  gate_captain: [{ id: 'brief', label: '给我一份简报', icon: 'chat', real: '#agent(Agent 对话,预选 HELM)', result: '简报已放进你的收件箱' }],
  portfolio_manager: [{ id: 'rebalance', label: '看看组合敞口', icon: 'coin', real: 'GET /api/portfolio/exposure', result: '总敞口 31%,簇敞口正常' }],
};

/** 拖币到工位的语义(顶栏行情卡 → 工位) */
export const COIN_DROP: Partial<Record<RoleId, { task: string; verb: string }>> = {
  radar: { task: 'watch', verb: '加入观察列表' },
  thread_manager: { task: 'judge_now', verb: '立即判断' },
  strategy_lab: { task: 'backtest', verb: '用当前策略回测' },
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
  if (has('回测', 'backtest')) return { role: 'strategy_lab', task: 'backtest', symbol };
  if (has('盯', 'watch', '观察')) return { role: 'radar', task: 'watch', symbol };
  if (has('扫', 'scan')) return { role: 'radar', task: 'scan_all' };
  if (has('判断', 'judge')) return { role: 'thread_manager', task: 'judge_now', symbol };
  if (has('风险', 'risk')) return { role: 'risk_sentinel', task: 'risk_check' };
  if (has('持仓', 'position')) return { role: 'executor', task: 'positions' };
  if (has('复盘', 'retro')) return { role: 'reviewer', task: 'retro' };
  if (has('信号', 'signal')) return { role: 'asp_agent', task: 'signals' };
  if (has('敞口', '组合')) return { role: 'portfolio_manager', task: 'rebalance' };
  if (has('简报', 'brief')) return { role: 'gate_captain', task: 'brief' };
  return null;
}
