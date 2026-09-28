/**
 * 「我的策略」(§9.46 策略对象生命周期)的纯函数:文案表、数字格式、生命周期推导、hash 路由。
 * 这里不碰 React / 网络,测试直接调。
 *
 * 数字口径(契约 research-strategy.json ResearchStrategySummary 没写单位,按研究引擎惯例):
 *   total_return / max_drawdown / win_rate 都是**小数**(0.074 = 7.4%),带 _pct 后缀的字段才是百分数。
 *   如果后端最后定成百分数,只改下面 ratioToPct 一处。
 */
import type { ResearchStrategy, ResearchStrategyStatus, ResearchStrategySummary } from '@trade-gate/contracts';
import { t, tmap } from '@/lib/i18n';

export type StrategyFilter = 'all' | 'live' | 'watchlist' | 'alerts';
export type StrategySort = 'updated' | 'return' | 'sharpe' | 'name';

export const FILTERS: StrategyFilter[] = ['all', 'live', 'watchlist', 'alerts'];
export const FILTER_LABEL: Record<StrategyFilter, string> = tmap({ all: '全部', live: '实盘', watchlist: '关注', alerts: '提醒' });

export const SORTS: StrategySort[] = ['updated', 'return', 'sharpe', 'name'];
export const SORT_LABEL: Record<StrategySort, string> = tmap({ updated: '最近更新', return: '总收益', sharpe: '夏普', name: '名称' });

export const STATUS_LABEL: Record<ResearchStrategyStatus, string> = tmap({
  draft: '草稿',
  backtested: '已回测',
  paper: '模拟盘',
  live: '实盘',
  published: '已发布',
  archived: '已归档',
});

/** 生命周期主干(archived 不在步进条上,走 ⋯ 菜单归档) */
export const LIFECYCLE: ResearchStrategyStatus[] = ['draft', 'backtested', 'paper', 'live', 'published'];

/** 状态徽标的颜色 class:只用现有 token(primary 荧光绿 / up / warn / live / muted) */
export function statusTone(s: ResearchStrategyStatus): string {
  switch (s) {
    case 'draft':
      return 'border-border bg-muted text-muted-foreground';
    case 'backtested':
      return 'border-primary/30 bg-primary/10 text-primary';
    case 'paper':
      return 'border-warn/30 bg-warn/10 text-warn';
    case 'live':
      return 'border-live/40 bg-live/10 text-live';
    case 'published':
      return 'border-up/30 bg-up/10 text-up';
    case 'archived':
      return 'border-border bg-transparent text-muted-foreground/70';
  }
}

/** 下一个「往前走」的允许状态(Automate 按钮用);没有就 null。回退类转换不算。 */
export function nextForwardTransition(current: ResearchStrategyStatus, allowed: readonly ResearchStrategyStatus[]): ResearchStrategyStatus | null {
  const cur = LIFECYCLE.indexOf(current);
  let best: ResearchStrategyStatus | null = null;
  for (const s of allowed) {
    const i = LIFECYCLE.indexOf(s);
    if (i > cur && (best === null || i < LIFECYCLE.indexOf(best))) best = s;
  }
  return best;
}

/** 走到某个状态要不要人工输入确认词:进 live 一律要 LIVE(后端 transition body 的 confirm 字段也带上) */
export function transitionConfirmText(to: ResearchStrategyStatus): string | null {
  return to === 'live' ? 'LIVE' : null;
}

/** transition 请求体:进 live 带上 confirm='LIVE'(后端二次校验),其余只带 to */
export function transitionRequest(to: ResearchStrategyStatus): { to: ResearchStrategyStatus; confirm?: string } {
  const confirm = transitionConfirmText(to);
  return confirm ? { to, confirm } : { to };
}

/** 策略有没有可展示的回测:summary 为空或没有 report_id 都算「还没回测」 */
export function hasBacktest(s: Pick<ResearchStrategy, 'summary'>): s is { summary: ResearchStrategySummary } {
  return !!s.summary && !!s.summary.report_id;
}

function finite(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** 小数 → 百分数(口径见文件头) */
export function ratioToPct(x: number): number {
  return x * 100;
}

/** 总收益:+7.4% / −3.1% / 0.0%;没数据 — */
export function fmtReturn(x: number | null | undefined): string {
  if (!finite(x)) return '—';
  const p = ratioToPct(x);
  if (Math.abs(p) < 0.05) return '0.0%';
  return `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%`;
}

/** 最大回撤:不管后端给正数还是负数,都按负向显示;0 显示 0.0% */
export function fmtDrawdown(x: number | null | undefined): string {
  if (!finite(x)) return '—';
  const p = Math.abs(ratioToPct(x));
  return p < 0.05 ? '0.0%' : `−${p.toFixed(1)}%`;
}

/** 胜率:0 笔交易时没有意义,显示 — */
export function fmtWinRate(x: number | null | undefined, trades: number | null | undefined): string {
  if (!finite(x) || !trades) return '—';
  return `${ratioToPct(x).toFixed(1)}%`;
}

/** 夏普:0 笔交易时显示 — */
export function fmtSharpe(x: number | null | undefined, trades: number | null | undefined): string {
  if (!finite(x) || !trades) return '—';
  return x.toFixed(2);
}

export function fmtTrades(x: number | null | undefined): string {
  return finite(x) ? String(x) : '—';
}

/** 卡片副标题的资产·周期:BTCUSDT · 1H(周期统一大写,空值用 —) */
export function assetLine(s: Pick<ResearchStrategy, 'symbol' | 'timeframe'>): string {
  const sym = s.symbol?.trim() || '—';
  const tf = s.timeframe?.trim() ? s.timeframe.trim().toUpperCase() : '—';
  return `${sym} · ${tf}`;
}

/** 列表页 counts 缺省(接口 404 / 老后端)时全 0 */
export const EMPTY_COUNTS = { all: 0, live: 0, watchlist: 0, alerts: 0, draft: 0 };

// ---------------------------------------------------------------------------
// hash 路由(App.tsx 把 #my-strategies 与 #backtest 都落到本页)
//   #my-strategies                      列表
//   #my-strategies?id=<sid>[&report=<rid>]  详情(可指定看哪份报告)
//   #my-strategies?report=<rid>         单独看一份报告
//   #backtest?id=<rid>                  同上(研究页结果面板跳过来用)

/** 详情页签:缺省「回测报告」;tab=deploy 为「部署」(规则拆分预览 + 部署状态) */
export type DetailTab = 'report' | 'deploy';
export type MyStrategiesRoute = { view: 'list' } | { view: 'detail'; id: string; report: string | null; tab?: 'deploy' } | { view: 'report'; report: string };

export function parseRoute(hash: string): MyStrategiesRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [base, query = ''] = raw.split('?');
  const q = new URLSearchParams(query);
  if (base === 'backtest') {
    const rid = q.get('id') ?? q.get('report');
    return rid ? { view: 'report', report: rid } : { view: 'list' };
  }
  const id = q.get('id');
  const report = q.get('report');
  if (id) return { view: 'detail', id, report: report || null, ...(q.get('tab') === 'deploy' ? { tab: 'deploy' as const } : {}) };
  if (report) return { view: 'report', report };
  return { view: 'list' };
}

export function detailHash(id: string, report?: string | null, tab?: DetailTab): string {
  return `my-strategies?id=${encodeURIComponent(id)}${report ? `&report=${encodeURIComponent(report)}` : ''}${tab === 'deploy' ? '&tab=deploy' : ''}`;
}

export function reportHash(report: string): string {
  return `backtest?id=${encodeURIComponent(report)}`;
}

/**
 * 跳研究页的约定(研究页接入由主线程做):
 *   #research?strategy_id=<sid>&new=1          新建策略后开一个新研究会话,把 strategy_id 当上下文
 *   #research?strategy_id=<sid>[&session=<id>] 继续构建;有来源会话就带上,研究页优先恢复它
 */
export function researchHash(strategyId: string, opts: { fresh?: boolean; session?: string | null } = {}): string {
  const q = new URLSearchParams({ strategy_id: strategyId });
  if (opts.fresh) q.set('new', '1');
  if (opts.session) q.set('session', opts.session);
  return `research?${q.toString()}`;
}

/** 分享用的完整深链 */
export function absoluteLink(hash: string): string {
  if (typeof window === 'undefined') return `#${hash}`;
  return `${window.location.origin}${window.location.pathname}#${hash}`;
}

export function copyLink(hash: string): Promise<void> {
  const url = absoluteLink(hash);
  return navigator.clipboard?.writeText(url) ?? Promise.reject(new Error(t('浏览器不允许写剪贴板')));
}

/** 取一个版本最新的那份报告 id(report_ids 按时间先后) */
export function latestReportOf(reportIds: readonly string[]): string | null {
  return reportIds.length ? reportIds[reportIds.length - 1]! : null;
}
