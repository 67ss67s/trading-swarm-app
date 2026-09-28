/**
 * 信号市场(#/market)四栏共用的标签、格式化与小件。
 * 设计 docs/design/asp-market-2026-09-20.md;契约 §9.39。
 */
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { FeedKind } from '@/api/market-adapt';
import type { FollowMode, MarketAftersaleStatus, MarketInboxParseStatus, MarketService, MarketSubscriptionGroup, MarketSubscriptionView, TraderSignalStatus } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';
import { friendlyError } from '@/lib/edition';
import { judgeLightDetail } from './judge';

export const MODE_CLASS: Record<FollowMode, string> = {
  book: 'bg-up/15 text-up border-up/30',
  gated: 'bg-primary/15 text-primary border-primary/30',
  evidence: 'bg-muted text-muted-foreground border-transparent',
};

/** 三种处理方式的一句话说明(订阅弹窗和订阅卡都用)。业务语言,不出现内部词。 */
export const MODE_HINT: Record<FollowMode, string> = tmap({
  book: '收到开仓信号后,系统按你的仓位和风控规则自动算好下单方案;可以选「等我确认」或「直接下单」。减仓、移止损这类后续动作始终需要你手动处理。',
  gated: '收到信号后先让 AI 判断一遍,AI 也认同的才提醒你决定,不会自动下单。',
  evidence: '只把信号记下来供参考和统计,不下单,也不提醒你。',
});

/** 处理方式的短名(订阅卡、选择框)。 */
export const MODE_LABEL: Record<FollowMode, string> = tmap({
  book: '按规则下单',
  gated: 'AI 把关后提醒我',
  evidence: '只记录,不下单',
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
export function Light({ ok, label, detail: rawDetail }: { ok: boolean; label: string; detail: string | null }) {
  const detail = judgeLightDetail(ok, rawDetail);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]" title={detail ?? ''}>
      <span className={cn('size-2 rounded-full', ok ? 'bg-up' : 'bg-muted-foreground/40')} />
      <span className={ok ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
      {detail ? <span className="max-w-[160px] truncate text-muted-foreground">{detail}</span> : null}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: FollowMode }) {
  return (
    <Badge variant="outline" className={cn('text-[10px]', MODE_CLASS[mode])} title={MODE_HINT[mode]}>
      {MODE_LABEL[mode]}
    </Badge>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-center text-[12px] text-muted-foreground">{children}</p>;
}

export function ErrorNote({ err }: { err: unknown }) {
  return (
    <p className="p-3 text-[12px] text-destructive">
      {t('加载失败')}:{friendlyError(err instanceof Error ? err.message : String(err))}
    </p>
  );
}

// ---------------------------------------------------------------------------
// 2026-09-25 新用户视角改版:收到内容的类型、订阅分组、首次引导卡。

export const FEED_KIND_LABEL: Record<FeedKind, string> = tmap({
  trade: '交易信号',
  intel: '市场情报',
  alert: '告警',
  report: '报告',
  system: '系统消息',
});

export const FEED_KIND_CLASS: Record<FeedKind, string> = {
  trade: 'border-primary/40 bg-primary/10 text-primary',
  intel: 'border-transparent bg-muted text-foreground/80',
  alert: 'border-warn/40 bg-warn/10 text-warn',
  report: 'border-up/30 bg-up/10 text-up',
  system: 'border-transparent bg-muted text-muted-foreground',
};

export const SUB_GROUP_TITLE: Record<MarketSubscriptionGroup, string> = tmap({
  active: '进行中',
  trial: '试用中',
  pending: '等服务方接单',
  cancelled_trial: '已取消续费 · 试用还没结束',
  ended: '已结束',
});

export const SUB_GROUP_CLASS: Record<MarketSubscriptionGroup, string> = {
  active: 'bg-up/15 text-up border-up/30',
  trial: 'bg-primary/15 text-primary border-primary/30',
  pending: 'bg-warn/15 text-warn border-warn/30',
  cancelled_trial: 'bg-muted text-foreground/80 border-border',
  ended: 'bg-muted text-muted-foreground border-transparent',
};

/** 剩余时长的人话:「2 天 5 小时」「3 小时」「20 分钟」;过期返回 null。 */
export function fmtRemaining(until: number | null, now: number): string | null {
  if (until === null) return null;
  const ms = until - now;
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return t('{n} 分钟', { n: Math.max(1, m) });
  const h = Math.floor(m / 60);
  if (h < 24) return t('{n} 小时', { n: h });
  const d = Math.floor(h / 24);
  return h % 24 ? t('{d} 天 {h} 小时', { d, h: h % 24 }) : t('{n} 天', { n: d });
}

/** localStorage 读写都包 try/catch:隐私模式 / 禁用站点数据时照常渲染,只是不记住。 */
function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    /* 记不住就算了 */
  }
}

/** 引导卡是否已关闭(按 key 记在本浏览器)。 */
export function useDismissed(key: string): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => (typeof window === 'undefined' ? false : readFlag(key)));
  return [
    dismissed,
    () => {
      writeFlag(key);
      setDismissed(true);
    },
  ];
}

export interface GuideStep {
  title: string;
  detail: string;
  /** undefined = 这一步不追踪完成状态(纯说明)。 */
  done?: boolean;
  action?: { label: string; onClick: () => void };
}

/** 首次引导卡:≤ 3 步,每步可带「去做」按钮,完成的打勾;「知道了」后本浏览器不再显示。 */
export function GuideCard({ storageKey, title, steps }: { storageKey: string; title: string; steps: GuideStep[] }) {
  const [dismissed, dismiss] = useDismissed(storageKey);
  // 每一步都做完了就不再打扰(纯说明步骤不算「做完」)。
  if (dismissed || (steps.length > 0 && steps.every((st) => st.done === true))) return null;
  return (
    <section aria-label={title} className="relative rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5">
      <div className="flex items-center gap-2 pr-6">
        <h3 className="text-[12.5px] font-semibold">{title}</h3>
        <button className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={dismiss}>
          {t('知道了,不再显示')}
        </button>
      </div>
      <button className="absolute right-2 top-2 rounded p-0.5 text-muted-foreground hover:bg-muted" aria-label={t('关闭引导')} onClick={dismiss}>
        <X className="size-3.5" />
      </button>
      <ol className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {steps.map((st, i) => (
          <li key={st.title} className={cn('flex gap-2 rounded border bg-card px-2.5 py-2', st.done && 'opacity-75')}>
            <span
              className={cn(
                'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                st.done ? 'border-up/40 bg-up/15 text-up' : 'border-primary/40 text-primary',
              )}
            >
              {st.done ? <Check className="size-3" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn('text-[12px] font-medium', st.done && 'line-through decoration-muted-foreground/60')}>{st.title}</div>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{st.detail}</p>
              {st.action && !st.done ? (
                <Button size="xs" variant="outline" className="mt-1.5" onClick={st.action.onClick}>
                  {st.action.label}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 订阅的服务名:本地下单时起的标题(去掉 tg · 前缀)> 目录服务名 > 平台服务名。 */
export function subName(sub: Pick<MarketSubscriptionView, 'title' | 'asp_service_name' | 'service_name'>): string {
  const local = sub.title.replace(/^(trade-gate|tg)\s*·\s*/, '').trim();
  return local || sub.asp_service_name || sub.service_name;
}

/** 服务方:名字 + 编号;都没有就 null。 */
export function subProvider(sub: Pick<MarketSubscriptionView, 'provider_name' | 'provider_agent_id'>): string | null {
  const name = sub.provider_name?.trim();
  if (name && sub.provider_agent_id) return `${name} #${sub.provider_agent_id}`;
  return name || (sub.provider_agent_id ? `#${sub.provider_agent_id}` : null);
}

/** 时间线上的时间:今天只写时分,其它天写月-日 时分。 */
export function fmtFeedTime(ts: number, now: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

/** 「09-27 14:00」(本地时间),给到期 / 试用截止用。 */
export function fmtMdHm(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
