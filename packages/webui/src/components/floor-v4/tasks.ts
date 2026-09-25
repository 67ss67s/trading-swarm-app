/**
 * 楼层 v4 的「派个活」:每一条都落到现有前端接口或现有页面(不新增后端接口)。
 *   watch    → PATCH /api/workflow {watchlist}(加观察列表,同盯盘参数页 useWatchWriter)
 *   info_run → POST /api/info/run-now(信息员马上梳理一轮)
 *   judge    → POST /api/scan-now [{symbol}](立即判断,同 Agent 页「扫描」按钮)
 *   backtest → POST /api/research/strategies/:id/backtest(我的策略 · 回测)
 *   brief / exposure / risk → 只读(captain brief / portfolio snapshot / risk alerts)
 *   goto     → 跳到现有工作台页
 * 纯函数,测试可直接覆盖。
 */
import { t } from '@/lib/i18n';
import type { FloorModel, Role } from './snapshot';

export type RealTaskKind = 'watch' | 'info_run' | 'judge' | 'backtest' | 'brief' | 'exposure' | 'risk' | 'goto';

export interface RealTask {
  id: string;
  label: string;
  kind: RealTaskKind;
  symbol?: string;
  hash?: string;
  /** 给引擎 / 提示用的一句「真实入口」 */
  real: string;
}

export interface TaskContext {
  model: FloorModel | null;
  /** 当前观察列表 */
  watchlist: readonly string[];
  /** 雷达候选(market_state.candidates 的 symbol) */
  candidates: readonly string[];
  /** 开着的线程币种 */
  threadSymbols: readonly string[];
}

export function normSym(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

export const watchTask = (sym: string): RealTask => ({ id: `watch:${sym}`, label: t('盯住 {s}', { s: sym }), kind: 'watch', symbol: sym, real: 'PATCH /api/workflow {watchlist}' });
export const judgeTask = (sym?: string): RealTask =>
  sym
    ? { id: `judge:${sym}`, label: t('现在判断一次 {s}', { s: sym }), kind: 'judge', symbol: sym, real: 'POST /api/scan-now {symbol}' }
    : { id: 'judge:all', label: t('现在把观察列表判断一轮'), kind: 'judge', real: 'POST /api/scan-now' };
export const backtestTask = (name: string, sym?: string): RealTask => ({
  id: `backtest:${sym ?? ''}`,
  label: sym ? t('用「{n}」回测 {s}', { n: name, s: sym }) : t('回测当前策略「{n}」', { n: name }),
  kind: 'backtest',
  ...(sym ? { symbol: sym } : {}),
  real: 'POST /api/research/strategies/:id/backtest',
});

export function realTasks(role: Role, ctx: TaskContext): RealTask[] {
  const out: RealTask[] = [];
  switch (role) {
    case 'gate_captain':
      out.push({ id: 'brief', label: t('念一下今天的值班简报'), kind: 'brief', real: 'GET /api/captain/brief' });
      break;
    case 'radar': {
      const cand = ctx.candidates.find((s) => !ctx.watchlist.includes(s));
      if (cand) out.push(watchTask(cand));
      out.push({ id: 'info_run', label: t('马上梳理一轮市场'), kind: 'info_run', real: 'POST /api/info/run-now' });
      break;
    }
    case 'thread_manager': {
      const sym = ctx.threadSymbols[0] ?? ctx.watchlist[0];
      if (sym) out.push(judgeTask(sym));
      out.push(judgeTask());
      break;
    }
    case 'strategy_lab': {
      const st = ctx.model?.strategyObj;
      if (st) out.push(backtestTask(st.name));
      else out.push({ id: 'goto:my-strategies', label: t('去我的策略建一条'), kind: 'goto', hash: 'my-strategies', real: '#my-strategies' });
      break;
    }
    case 'portfolio_manager':
      out.push({ id: 'exposure', label: t('报一下组合敞口'), kind: 'exposure', real: 'GET /api/portfolio/snapshot' });
      break;
    case 'risk_sentinel':
      out.push({ id: 'risk', label: t('查一遍风控告警'), kind: 'risk', real: 'GET /api/risk/alerts?status=open' });
      break;
    case 'executor':
      out.push({ id: 'goto:trade', label: t('看看持仓'), kind: 'goto', hash: 'trade', real: '#trade' });
      break;
    case 'reviewer':
      out.push({ id: 'goto:history', label: t('翻一下复盘'), kind: 'goto', hash: 'history', real: '#history' });
      break;
    case 'asp_agent':
      out.push({ id: 'goto:market', label: t('看订阅信号'), kind: 'goto', hash: 'market', real: '#market' });
      break;
  }
  return out;
}

/** 拖币给谁 → 干什么;null = 这个角色不接币 */
export function coinTask(role: Role, sym: string, ctx: TaskContext): RealTask | null {
  if (role === 'radar') return watchTask(sym);
  if (role === 'thread_manager') return judgeTask(sym);
  if (role === 'strategy_lab') return ctx.model?.strategyObj ? backtestTask(ctx.model.strategyObj.name, sym) : null;
  return null;
}

/** 命令行:「让 radar 盯 SOL」「判断 BTC」「回测 ETH」「查风险」 */
export function parseCommand(input: string, ctx: TaskContext): { role: Role; task: RealTask } | null {
  const s = input.trim();
  if (!s) return null;
  const words = s.match(/[A-Za-z]{2,12}/g) ?? [];
  const NAMES = new Set(['RADAR', 'LAB', 'THREAD', 'EXEC', 'AUDIT', 'BOOK', 'HELM', 'MARKET', 'SENTINEL', 'HELP']);
  const raw = [...words].reverse().find((w) => !NAMES.has(w.toUpperCase()));
  const sym = raw ? normSym(raw) : '';
  const has = (...ws: string[]) => ws.some((w) => s.toLowerCase().includes(w.toLowerCase()));
  if (has('回测', 'backtest')) {
    const st = ctx.model?.strategyObj;
    return st ? { role: 'strategy_lab', task: backtestTask(st.name, sym || undefined) } : null;
  }
  if (has('盯', 'watch', '观察') && sym) return { role: 'radar', task: watchTask(sym) }; // i18n-ignore(命令词表)
  // i18n-ignore(下一行是命令词表)
  if (has('梳理', '扫', 'scan', 'info')) return { role: 'radar', task: { id: 'info_run', label: t('马上梳理一轮市场'), kind: 'info_run', real: 'POST /api/info/run-now' } };
  if (has('判断', 'judge')) return { role: 'thread_manager', task: judgeTask(sym || undefined) };
  for (const role of ['risk_sentinel', 'portfolio_manager', 'executor', 'reviewer', 'asp_agent', 'gate_captain'] as Role[]) {
    const hit = realTasks(role, ctx)[0];
    // i18n-ignore(下一行是命令词表)
    const kw: Record<string, string[]> = { risk_sentinel: ['风险', '风控', 'risk'], portfolio_manager: ['敞口', '组合', 'exposure'], executor: ['持仓', 'position'], reviewer: ['复盘', 'retro'], asp_agent: ['信号', 'signal'], gate_captain: ['简报', 'brief'] };
    if (hit && has(...(kw[role] ?? []))) return { role, task: hit };
  }
  return null;
}
