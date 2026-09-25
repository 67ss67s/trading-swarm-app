/**
 * #start「开始」清单的完成度判断(docs/design/ia-newcomer-audit-2026-09-25.md ⑤):纯函数,没有 React。
 * 每一步只读已有接口的真实状态(/api/execution、/api/models、/api/brains、/api/overview 的 workflow/loop、
 * /api/agent/strategy、/api/matrix-studies、/api/history),不新增后端。
 *
 * 状态:
 *   done     做完了
 *   todo     还没做
 *   blocked  前一步没做完,这步现在做不了(比如交易所没连,读不到账户模式)
 *   skipped  这一步对当前配置不适用(模拟盘不用入金、只做现货不用验保护单、币安没有账户模式)
 *   unknown  数据还没到 / 老网关没这个接口——不算完成也不算没完成,默认首页判定会等它
 *
 * 「核心四项」决定默认首页:交易所连上 / 有可用模型 / 观察列表非空 / 当前策略确认过(见 ②)。
 */
import type { BrainOption, ExecutionView, Market, ModelsView } from '@/api/types';
import { okConnectionCount } from '@/components/models/logic';

export type StartStepId = 'exchange' | 'account_mode' | 'funding' | 'models' | 'market' | 'watchlist' | 'matrix' | 'strategy' | 'protection' | 'agent' | 'review';
export type StartStepState = 'done' | 'todo' | 'blocked' | 'skipped' | 'unknown';

export const START_STEP_ORDER: StartStepId[] = ['exchange', 'account_mode', 'funding', 'models', 'market', 'watchlist', 'matrix', 'strategy', 'protection', 'agent', 'review'];

/** 决定默认首页的四项 */
export const START_CORE_STEPS: StartStepId[] = ['exchange', 'models', 'watchlist', 'strategy'];

/** 可选项:不影响「全部完成」 */
export const START_OPTIONAL_STEPS: StartStepId[] = ['matrix', 'review'];

export interface StartInputs {
  /** undefined = 还在拉;null = 拉失败 / 老网关 */
  execution: ExecutionView | null | undefined;
  models: ModelsView | null | undefined;
  brains: BrainOption[] | null | undefined;
  /** 旧两槽当前选的大脑(overview.loop.brain / cheap_brain 的 kind 部分,或 workflow.brain) */
  slots: { brain: string; cheap_brain: string } | null | undefined;
  workflow: { watchlist?: string[]; markets?: Market[] } | null | undefined;
  /** overview.loop.paused;undefined = 还没拿到 */
  agentPaused: boolean | null | undefined;
  /** /api/agent/strategy 的 kind;undefined = 还在拉;null = 接口失败 */
  agentStrategyKind: 'free' | 'strategy' | null | undefined;
  /** 本机记的「自由判断我确认过了」 */
  freeJudgmentConfirmed: boolean;
  /** 矩阵研究数量;undefined = 没拉 / 失败 */
  matrixStudies?: number | null;
  /** 复盘里已结束的线程数;undefined = 没拉 / 失败 */
  historyThreads?: number | null;
}

export type StartSteps = Record<StartStepId, StartStepState>;

function protectionVerified(view: ExecutionView): boolean | null {
  const p = view.protection;
  if (!p) return null;
  if (p.state === 'verified' || p.state === 'not_needed') return true;
  if (p.state === undefined && (p.status === 'verified' || p.status === 'not_needed')) return true;
  return false;
}

/** 交易所连没连上:okx 看 okx.available;币安看执行通道连接状态。 */
export function exchangeConnected(view: ExecutionView | null | undefined): boolean | null {
  if (!view) return null;
  if (view.exchange === 'okx') return !!view.okx?.available;
  return view.connection?.status === 'connected';
}

/** OKX 账户是简单模式(acctLv=1):永续单会被拒(51010)。 */
export function okxSimpleMode(view: ExecutionView | null | undefined): boolean {
  return view?.exchange === 'okx' && !!view.okx?.available && view.okx.acct_lv === 1;
}

/** 工作流要做的市场里有没有永续(没配置按老默认 perp) */
export function wantsPerp(workflow: { markets?: Market[] } | null | undefined): boolean {
  return (workflow?.markets ?? ['perp']).includes('perp');
}

/** 模拟盘:okx 看 profile 的 demo;币安 / 不知道 → null */
export function isDemo(view: ExecutionView | null | undefined): boolean | null {
  if (!view || view.exchange !== 'okx' || !view.okx?.available) return null;
  return view.okx.demo !== false;
}

export function evaluateStart(i: StartInputs): StartSteps {
  const ex = i.execution;
  const connected = exchangeConnected(ex);
  const isOkx = ex?.exchange === 'okx';

  const exchange: StartStepState = ex === undefined ? 'unknown' : connected === null ? 'unknown' : connected ? 'done' : 'todo';

  let account_mode: StartStepState;
  if (ex === undefined || ex === null) account_mode = 'unknown';
  else if (!isOkx) account_mode = 'skipped';
  else if (!connected) account_mode = 'blocked';
  else if (ex.okx?.acct_lv === undefined || ex.okx?.acct_lv === null) account_mode = 'unknown';
  else account_mode = ex.okx.acct_lv === 1 && wantsPerp(i.workflow) ? 'todo' : 'done';

  let funding: StartStepState;
  if (ex === undefined || ex === null) funding = 'unknown';
  else if (!connected) funding = 'blocked';
  else if (isDemo(ex) === true) funding = 'skipped';
  else if (ex.account_funded === false) funding = 'todo';
  else if (ex.account_funded === true) funding = 'done';
  else funding = 'unknown';

  let models: StartStepState;
  if (i.models && okConnectionCount(i.models) > 0) models = 'done';
  else if (i.brains && i.slots) {
    const main = i.brains.find((b) => b.kind === i.slots!.brain);
    const cheap = i.brains.find((b) => b.kind === i.slots!.cheap_brain);
    if (!main && !cheap) models = i.models ? 'todo' : 'unknown';
    else models = main?.available !== false || cheap?.available !== false ? 'done' : 'todo';
  } else if (i.models) models = 'todo';
  else models = 'unknown';

  let market: StartStepState;
  if (i.workflow === undefined || i.workflow === null) market = 'unknown';
  else if (okxSimpleMode(ex) && wantsPerp(i.workflow)) market = 'todo';
  else market = 'done';

  const watchlist: StartStepState = i.workflow === undefined || i.workflow === null ? 'unknown' : (i.workflow.watchlist ?? []).length > 0 ? 'done' : 'todo';

  const matrix: StartStepState = i.matrixStudies === undefined || i.matrixStudies === null ? 'unknown' : i.matrixStudies > 0 ? 'done' : 'todo';

  let strategy: StartStepState;
  if (i.agentStrategyKind === 'strategy') strategy = 'done';
  else if (i.freeJudgmentConfirmed) strategy = 'done';
  else if (i.agentStrategyKind === undefined) strategy = 'unknown';
  else strategy = 'todo';

  let protection: StartStepState;
  if (ex === undefined || ex === null) protection = 'unknown';
  else if (!connected) protection = 'blocked';
  else {
    const live = isOkx ? ex.okx?.demo === false : ex.backend !== 'paper';
    const needed = live || (isOkx && wantsPerp(i.workflow));
    if (!needed) protection = 'skipped';
    else {
      const v = protectionVerified(ex);
      protection = v === null ? 'unknown' : v ? 'done' : 'todo';
    }
  }

  const agent: StartStepState = i.agentPaused === undefined || i.agentPaused === null ? 'unknown' : i.agentPaused ? 'todo' : 'done';

  const review: StartStepState = i.historyThreads === undefined || i.historyThreads === null ? 'unknown' : i.historyThreads > 0 ? 'done' : 'todo';

  return { exchange, account_mode, funding, models, market, watchlist, matrix, strategy, protection, agent, review };
}

/**
 * 核心四项是否完成:true 完成 / false 没完成 / null 还判不出来(有 unknown)。
 * 只要有一项明确 todo 就是 false,不用等别的数据。
 */
export function startCoreComplete(steps: Pick<StartSteps, 'exchange' | 'models' | 'watchlist' | 'strategy'>): boolean | null {
  const states = START_CORE_STEPS.map((id) => steps[id as keyof typeof steps]);
  if (states.some((s) => s === 'todo' || s === 'blocked')) return false;
  if (states.some((s) => s === 'unknown')) return null;
  return true;
}

/** 清单进度:必做项(去掉可选和 skipped)里完成了几项 */
export function startProgress(steps: StartSteps): { done: number; total: number } {
  const req = START_STEP_ORDER.filter((id) => !START_OPTIONAL_STEPS.includes(id) && steps[id] !== 'skipped');
  return { done: req.filter((id) => steps[id] === 'done').length, total: req.length };
}

/**
 * 无 hash 冷启动时该落哪页:核心没完成 → start;完成了且记住的是 start → 回楼层;
 * 判不出来 → null(先不动,等数据)。saved 是 defaultPage() 给的落点。
 */
export function bootRedirect(core: boolean | null, current: string): 'start' | 'floor' | null {
  if (core === null) return null;
  if (!core) return current === 'start' ? null : 'start';
  return current === 'start' ? 'floor' : null;
}
