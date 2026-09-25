/**
 * 信号市场(#/market)四栏共用的标签、格式化与小件。
 * 设计 docs/design/asp-market-2026-09-20.md;契约 §9.39。
 */
import type { FollowMode, MarketAftersaleStatus, MarketInboxParseStatus, MarketService, TraderSignalStatus } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

export const MODE_CLASS: Record<FollowMode, string> = {
  book: 'bg-up/15 text-up border-up/30',
  gated: 'bg-primary/15 text-primary border-primary/30',
  evidence: 'bg-muted text-muted-foreground border-transparent',
};

/** 三种模式的一句话说明(订阅弹窗和订阅卡都用)。 */
export const MODE_HINT: Record<FollowMode, string> = tmap({
  book: '组合经理接管:ASP Agent 把 open 信号归一成候选点位直接交给组合经理,代码算仓位、过基础闸 + 组合限额 + 风控哨兵,不问模型;审批 manual 生成待批意图、auto 直接执行;管理动作一律人工',
  gated: 'agent 把关:信号作为证据交给 agent 判断,同向才进待办',
  evidence: '只留证据:进判断账本,不开仓、不进待办',
});

export const STATUS_CLASS: Record<TraderSignalStatus, string> = {
  new: 'bg-primary/15 text-primary border-primary/30',
  triggered: 'bg-primary/15 text-primary border-primary/30',
  applying: 'bg-primary/15 text-primary border-primary/30',
  applied: 'bg-up/15 text-up border-up/30',
  apply_failed: 'bg-down/10 text-down border-down/30',
  skipped: 'bg-muted text-muted-foreground border-transparent',
  evidence: 'bg-muted text-muted-foreground border-transparent',
  review_only: 'bg-warn/15 text-warn border-warn/30',
  expired: 'bg-muted text-muted-foreground/70 border-transparent line-through',
  dead: 'bg-muted text-muted-foreground/70 border-transparent line-through',
  mgmt_applied: 'bg-up/10 text-up border-up/30',
  mgmt_orphan: 'bg-down/10 text-down border-down/30',
};

export const PARSE_STATUS_LABEL: Record<MarketInboxParseStatus, string> = tmap({
  ingested: '已进流',
  analysis: '分析类 · 不跟',
  bad: '解析失败',
  duplicate: '重复投递',
  expired: '到达时已过期',
  system: '系统事件',
});

export const PARSE_STATUS_CLASS: Record<MarketInboxParseStatus, string> = {
  ingested: 'bg-up/15 text-up border-up/30',
  analysis: 'bg-muted text-muted-foreground border-transparent',
  bad: 'bg-down/10 text-down border-down/30',
  duplicate: 'bg-muted text-muted-foreground/70 border-transparent',
  expired: 'bg-warn/15 text-warn border-warn/30',
  system: 'bg-primary/10 text-primary border-primary/30',
};

export const AFTERSALE_STATUS_LABEL: Record<MarketAftersaleStatus, string> = tmap({
  received: '已收到',
  processing: '处理中',
  failed: '处理失败',
  pending: '待处理',
  agreed_refund: '已同意退款',
  disputed: '已提争议',
  expired: '超时自动退款',
});

/** OKX 订阅状态名 → 中文;拿不到的原样显示。 */
export const SUB_STATUS_LABEL: Record<string, string> = tmap({
  ACTIVE: '生效中',
  INIT: '创建中',
  REJECTED: '已拒收',
  DISPUTED: '争议中',
  COMPLETED: '已完成',
  CLOSED: '已关闭',
  FAILED: '已终止',
});

export function subStatusClass(name: string): string {
  switch (name) {
    case 'ACTIVE':
      return 'bg-up/15 text-up border-up/30';
    case 'INIT':
      return 'bg-primary/15 text-primary border-primary/30';
    case 'REJECTED':
    case 'DISPUTED':
      return 'bg-warn/15 text-warn border-warn/30';
    case 'FAILED':
      return 'bg-down/10 text-down border-down/30';
    default:
      return 'bg-muted text-muted-foreground border-transparent';
  }
}

/** `20 USDT/月`、`1 USDT/次`、`免费`。 */
export function fmtServicePrice(s: MarketService): string {
  const sub = s.subscription[0];
  if (sub) {
    const fee = Number(sub.fee);
    if (Number.isFinite(fee) && fee === 0) return t('免费');
    return `${sub.fee} ${s.fee_token_symbol}/${sub.interval === 'month' ? t('月') : sub.interval}`;
  }
  const fee = s.fee_amount === null ? NaN : Number(s.fee_amount);
  if (Number.isFinite(fee) && fee === 0) return t('免费');
  return s.fee_amount === null ? '—' : `${s.fee_amount} ${s.fee_token_symbol}/${t('次')}`;
}

export function isSubscriptionService(s: MarketService): boolean {
  return s.subscription.length > 0;
}

export function fmtTrial(s: MarketService): string | null {
  if (!s.support_trial && !s.free_trial) return null;
  const h = Number(s.free_trial);
  if (Number.isFinite(h) && h > 0) return t('试用 {d} 天', { d: Math.round(h / 24) });
  return t('可试用');
}

/** agent_agree_rate / realized_r:null = 没有样本,不是 0。 */
export function fmtRate(v: number | null): string {
  return v === null ? t('样本不足') : `${Math.round(v * 100)}%`;
}
export function fmtR(v: number | null): string {
  return v === null ? t('样本不足') : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
}

export function shortId(v: string | null | undefined, head = 6, tail = 4): string {
  if (!v) return '—';
  return v.length > head + tail + 1 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v;
}

export function fmtUsdt(v: string | null): string {
  if (v === null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(2)} USDT` : `${v} USDT`;
}

/** 一盏灯:绿点 / 灰点 + 一句 detail。 */
export function Light({ ok, label, detail }: { ok: boolean; label: string; detail: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]" title={detail ?? ''}>
      <span className={cn('size-2 rounded-full', ok ? 'bg-up' : 'bg-muted-foreground/40')} />
      <span className={ok ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
      {detail ? <span className="max-w-[160px] truncate text-muted-foreground">{detail}</span> : null}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: FollowMode }) {
  const label: Record<FollowMode, string> = { book: t('组合经理接管'), gated: t('agent 把关'), evidence: t('只留证据') };
  return (
    <Badge variant="outline" className={cn('text-[10px]', MODE_CLASS[mode])} title={MODE_HINT[mode]}>
      {label[mode]}
    </Badge>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-center text-[12px] text-muted-foreground">{children}</p>;
}

export function ErrorNote({ err }: { err: unknown }) {
  return (
    <p className="p-3 text-[12px] text-destructive">
      {t('加载失败')}:{err instanceof Error ? err.message : String(err)}
    </p>
  );
}
