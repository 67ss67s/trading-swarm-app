// 数字格式化(仿 8793 frontend-design/src/lib/format.ts,改成接受契约里的十进制字符串)
// + 全站中文文案表(源仓库这些散在 i18n/*.ts 里,本项目不做 i18n,直接写死中文)。
import { useEffect, useState } from 'react';
import { getLang, t, tmap } from './i18n';
import type {
  Market,
  Action,
  ActivityItem,
  ActivityKind,
  DailyRegime,
  DemoIntent,
  Direction,
  Regime,
  SessionName,
  StrategyState,
  ThreadSource,
  ThreadStatus,
  TriggerKind,
} from '../api/types';

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const usdt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 没读到真实数据(undefined/null/空串/NaN)一律显示 —,绝不显示 NaN/undefined 之类的假值
export function fmtUsdt(v: string | number | null | undefined): string {
  const n = toNum(v);
  return n === null ? '—' : usdt.format(n);
}

export function fmtSigned(v: string | number | null | undefined): string {
  const n = toNum(v);
  if (n === null) return '—';
  return (n >= 0 ? '+' : '−') + usdt.format(Math.abs(n));
}

/** v 已经是"百分比数值"的十进制字符串(比如 funding_rate="0.0100" 代表 1%,change_24h_pct="1.23" 代表 1.23%)。 */
export function fmtPct(v: string | number | null | undefined, digits = 2): string {
  const n = toNum(v);
  if (n === null) return '—';
  return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(digits) + '%';
}

/** confidence 是 0..1 的小数,直接取整成百分比,不带符号。 */
export function fmtConfidencePct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${Math.round(x * 100)}%`;
}

export function fmtPrice(v: string | number | null | undefined): string {
  const n = toNum(v);
  if (n === null) return '—';
  const digits = n >= 1000 ? 1 : n >= 10 ? 2 : 4;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

export function fmtQty(v: string | number | null | undefined): string {
  const n = toNum(v);
  if (n === null) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 5 }).format(n);
}

/** 涨跌语义色 class:文本(对应 index.css 的 --up/--down token) */
export function pnlText(v: string | number | null | undefined): string {
  const n = toNum(v);
  if (n === null) return 'text-muted-foreground';
  return n >= 0 ? 'text-up' : 'text-down';
}

export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.round((now - ts) / 1000);
  if (diff < 5) return t('刚刚');
  if (diff < 60) return t('{n} 秒前', { n: diff });
  const m = Math.round(diff / 60);
  if (m < 60) return t('{n} 分钟前', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('{n} 小时前', { n: h });
  const d = Math.round(h / 24);
  return t('{n} 天前', { n: d });
}

/** 日期/时间的 locale 跟着界面语言走。 */
function dateLocale(): string {
  return getLang() === 'en' ? 'en-US' : 'zh-CN';
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString(dateLocale(), { hour12: false });
}

/** 每 intervalMs 触发一次重渲染,给相对时间("3 分钟前")用。 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------------------
// 文案表(全部中文,不做 jargon:不出现 plan_hash / reducer / gate 这类内部词)

export const ACTION_LABEL: Record<Action, string> = tmap({
  NO_TRADE: '不交易',
  WATCH: '观察',
  PROPOSE: '提议开仓',
  HOLD: '持有',
  ADD: '加仓',
  REDUCE: '减仓',
  EXIT: '离场',
  INVALIDATE: '论点失效',
});

export function actionLabel(action: Action, direction: Direction | null): string {
  if (action === 'PROPOSE') return direction === 'short' ? t('提议做空') : t('提议做多');
  return ACTION_LABEL[action];
}

/** 配色约束:绿/红只表示多/空或盈亏。PROPOSE/ADD 借用多空色,其余用灰/蓝/琥珀。 */
export function actionBadgeClass(action: Action, direction: Direction | null): string {
  if (action === 'PROPOSE' || action === 'ADD') {
    if (direction === 'short') return 'bg-down/15 text-down border-down/30';
    if (direction === 'long') return 'bg-up/15 text-up border-up/30';
    return 'bg-primary/15 text-primary border-primary/30';
  }
  if (action === 'HOLD' || action === 'REDUCE') return 'bg-primary/15 text-primary border-primary/30';
  if (action === 'WATCH' || action === 'INVALIDATE') return 'bg-warn/15 text-warn border-warn/30';
  return 'bg-muted text-muted-foreground border-transparent'; // NO_TRADE / EXIT / 判断失败(action=null)兜底
}

export const STATE_LABEL: Record<StrategyState, string> = tmap({
  researching: '研究中',
  watching: '观察中',
  ready: '准备入场',
  active: '持仓中',
  managing: '管理持仓',
  closing: '离场中',
  closed: '已结束',
  invalidated: '已失效',
});

export const TRIGGER_LABEL: Record<TriggerKind, string> = tmap({
  kline_close: 'K 线收盘',
  manual: '手动触发',
  schedule: '定时触发',
  monitor: '持续监控',
  position_review: '持仓复查',
  scan: '扫描',
  info_update: '信息更新',
  order_filled: '订单成交',
  tp_hit: '止盈触发',
  sl_hit: '止损触发',
  thread_review: '线程复查',
  chat: '对话',
  // v3 代码触发器
  fast_move: '急拉急跌',
  breakout: '突破',
  ema_cross: 'EMA 交叉',
  vol_spike: '放量',
  retest: '回踩',
  session: '开收盘窗口',
  funding: '资金费率极端',
  heartbeat: '心跳',
  event: '事件窗口',
});

export function triggerLabel(kind: string): string {
  return (TRIGGER_LABEL as Record<string, string>)[kind] ?? kind;
}

export const INTENT_STATUS_LABEL: Record<DemoIntent['status'], string> = tmap({
  pending_approval: '等待确认',
  approved: '已确认,提交中',
  rejected: '已拒绝',
  submitted: '已提交',
  filled: '已成交',
  failed: '失败',
  unknown: '状态不明,正在核对',
});

export const INTENT_KIND_LABEL: Record<DemoIntent['kind'], string> = tmap({
  open: '开仓',
  close: '平仓',
  reduce: '减仓',
});

export const THREAD_STATUS_LABEL: Record<ThreadStatus, string> = tmap({
  pending_entry: '待入场',
  in_position: '持仓中',
  closed: '已结束',
  canceled: '已撤',
  invalidated: '已失效',
});

export function threadStatusBadgeClass(status: ThreadStatus): string {
  if (status === 'in_position') return 'bg-up/15 text-up border-up/30';
  if (status === 'pending_entry') return 'bg-primary/15 text-primary border-primary/30';
  if (status === 'invalidated') return 'bg-warn/15 text-warn border-warn/30';
  return 'bg-muted text-muted-foreground border-transparent'; // closed / canceled
}

export const THREAD_SOURCE_LABEL: Record<ThreadSource, string> = tmap({
  agent: 'agent',
  manual: '手动',
  chat: '对话',
});

export const REGIME_LABEL: Record<Regime, string> = tmap({
  trend_up: '上升趋势',
  trend_down: '下降趋势',
  range: '区间震荡',
  volatile: '剧烈波动',
  unclear: '不明朗',
});

export const BIAS_LABEL: Record<'long' | 'short' | 'neutral', string> = tmap({
  long: '偏多',
  short: '偏空',
  neutral: '中性',
});

export function directionLabel(direction: Direction | null): string {
  if (direction === 'long') return t('做多');
  if (direction === 'short') return t('做空');
  return '—';
}

export function directionText(direction: Direction | null): string {
  if (direction === 'long') return 'text-up';
  if (direction === 'short') return 'text-down';
  return 'text-muted-foreground';
}


// ---------------------------------------------------------------------------
// v3:活动流 / 复盘 / 行情状态 文案与样式

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return t('{n} 秒', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('{n} 分钟', { n: m });
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? t('{h} 小时 {m} 分', { h, m: rm }) : t('{n} 小时', { n: h });
  const d = Math.floor(h / 24);
  return t('{d} 天 {h} 小时', { d, h: h % 24 });
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(dateLocale(), { month: '2-digit', day: '2-digit' });
}

export function fmtHourBucket(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString(dateLocale(), { month: '2-digit', day: '2-digit' })} ${String(d.getHours()).padStart(2, '0')}:00`;
}

export type ActivityGroup = 'trade' | 'agent' | 'system';

export const ACTIVITY_GROUP_LABEL: Record<ActivityGroup, string> = tmap({ trade: '交易', agent: 'agent', system: '系统' });

export function activityGroup(kind: ActivityKind): ActivityGroup {
  switch (kind) {
    case 'thread_opened':
    case 'entry_filled':
    case 'protection_placed':
    case 'tp_hit':
    case 'sl_hit':
    case 'thread_closed':
    case 'thread_canceled':
    case 'thread_invalidated':
    case 'manual_order':
    case 'approval_needed':
    case 'approved':
    case 'rejected':
    case 'attention':
    case 'attention_cleared':
      return 'trade';
    case 'proposal':
    case 'proposal_blocked':
    case 'trigger':
    case 'info_update':
    case 'chat_action':
    case 'screen_done':
    case 'screen_failed':
      return 'agent';
    default:
      return 'system';
  }
}

export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = tmap({
  proposal: '出策略',
  proposal_blocked: '被闸拦下',
  approval_needed: '等你确认',
  approved: '已批准',
  rejected: '已拒绝',
  thread_opened: '开仓',
  entry_filled: '成交',
  protection_placed: '已挂保护',
  tp_hit: '止盈',
  sl_hit: '止损',
  thread_closed: '平仓',
  thread_canceled: '已撤',
  thread_invalidated: '失效',
  attention: '需要处理',
  attention_cleared: '已恢复',
  manual_order: '手动下单',
  chat_action: '对话操作',
  trigger: '触发器',
  info_update: '信息员',
  brain_error: '模型出错',
  halt: '紧急停止',
  resume: '解除紧急停止',
  paused: '暂停',
  resumed: '恢复',
  workflow_changed: '工作流',
  screen_done: '筛选完成',
  screen_failed: '筛选失败',
  risk_alert: '风控告警',
  risk_cleared: '风控解除',
  brief: '值班简报',
});

/** 徽章样式:交易类实色(按 level 定色),agent 类描边,系统类灰。 */
export function activityBadgeClass(item: ActivityItem): string {
  const group = activityGroup(item.kind);
  if (group === 'trade') {
    if (item.level === 'success') return 'bg-up text-white border-transparent';
    if (item.level === 'danger') return 'bg-down text-white border-transparent';
    if (item.level === 'warn') return 'bg-warn text-white border-transparent';
    return 'bg-primary text-primary-foreground border-transparent';
  }
  if (group === 'agent') {
    if (item.level === 'warn') return 'bg-warn/10 text-warn border-warn/40';
    if (item.level === 'danger') return 'bg-down/10 text-down border-down/40';
    if (item.level === 'success') return 'bg-up/10 text-up border-up/40';
    return 'bg-primary/10 text-primary border-primary/40';
  }
  if (item.level === 'danger') return 'bg-down/10 text-down border-down/30';
  return 'bg-muted text-muted-foreground border-transparent';
}

export const DAILY_REGIME_LABEL: Record<DailyRegime, string> = tmap({
  bull: '日线偏牛',
  bear: '日线偏熊',
  range: '日线震荡',
  volatile: '日线高波动',
});

export function dailyRegimeClass(r: DailyRegime): string {
  if (r === 'bull') return 'bg-up/15 text-up border-up/30';
  if (r === 'bear') return 'bg-down/15 text-down border-down/30';
  if (r === 'volatile') return 'bg-warn/15 text-warn border-warn/30';
  return 'bg-muted text-muted-foreground border-transparent';
}

export const SESSION_LABEL: Record<SessionName, string> = tmap({
  us_open_window: '美股开盘窗口',
  us: '美股时段',
  london: '欧洲时段',
  asia: '亚洲时段',
  weekend: '周末',
  off: '清淡时段',
});

// ---------------------------------------------------------------------------
// v3.3:执行后端标签(paper/demo/cli/agent_mcp;认不出的原样显示,不做穷举 switch)

export const BACKEND_LABEL: Record<string, string> = tmap({
  paper: '纸面模拟',
  demo: '币安模拟盘',
  cli: 'binance-cli',
  agent_mcp: 'Agent MCP',
  mcp: '币安 MCP 直连',
  okx: 'OKX(okx CLI)',
});

export function backendLabel(backend: string | null | undefined): string {
  if (!backend) return '—';
  return BACKEND_LABEL[backend] ?? backend;
}

/** 数字安全格式化:null / undefined / NaN 一律 '—',别让 toFixed 把整页炸掉。 */
export function fx(v: number | string | null | undefined, digits = 2, suffix = ''): string {
  const n = typeof v === 'string' ? Number(v) : v;
  return n == null || Number.isNaN(n) ? '—' : `${n.toFixed(digits)}${suffix}`;
}

// ---------------------------------------------------------------------------
// §9.40 市场维度(perp|spot)


export const MARKET_LABEL = tmap<Record<Market, string>>({ perp: '永续', spot: '现货' });

/** 老网关/老数据没有 market 字段 → perp。 */
export function marketOf(x: { market?: Market | null } | null | undefined): Market {
  return x?.market === 'spot' ? 'spot' : 'perp';
}

export function marketLabel(m: Market | null | undefined): string {
  return MARKET_LABEL[m === 'spot' ? 'spot' : 'perp'];
}

/** OKX 账户模式文案(acctLv);网关给了 label 就用网关的。 */
export function acctLvLabel(lv: number | null | undefined, fallback?: string | null): string {
  if (fallback) return fallback;
  switch (lv) {
    case 1:
      return t('简单模式');
    case 2:
      return t('单币种保证金');
    case 3:
      return t('跨币种保证金');
    case 4:
      return t('组合保证金');
    default:
      return t('未知');
  }
}
