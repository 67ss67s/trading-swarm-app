/**
 * 「我的产品」的标签、格式化与纯逻辑(不依赖 React,测试直接调)。
 * 业务语言:不出现内部词,状态/类型一律人话。
 */
import type { AspApproval, AspProduct, ChecklistItem, ProductStatus } from '@/api/asp-products';
import { t, tmap } from '@/lib/i18n';
import { friendlyMarketError } from '@/components/market/judge';

export const STRATEGY_KEY = 'strategy_signal';

export const PRODUCT_STATUS_LABEL: Record<ProductStatus, string> = tmap({
  listed: '已上架',
  in_review: '审核中',
  paused: '已暂停接单',
  not_listed: '未上架',
});

export const PRODUCT_STATUS_CLASS: Record<ProductStatus, string> = {
  listed: 'bg-up/15 text-up border-up/30',
  in_review: 'bg-warn/15 text-warn border-warn/30',
  paused: 'bg-muted text-muted-foreground border-border',
  not_listed: 'bg-muted text-muted-foreground/80 border-transparent',
};

export const KIND_LABEL: Record<AspProduct['kind'], string> = tmap({
  subscription: '订阅',
  one_time: '按次',
});

/** 订阅频道预览:上架产品 → 它包含的频道(与网关 catalog.ts 的 channels 同步;未知的按 key 本身试)。 */
export const PRODUCT_CHANNELS: Record<string, string[]> = {
  market_intel: ['market_brief', 'radar_feed'],
  micro_alerts: ['micro_alerts'],
};

export function channelsOf(key: string): string[] {
  return PRODUCT_CHANNELS[key] ?? [key];
}

/** 预览要调付费决策模型的产品(网关 catalog.ts paid_model);预览前必须确认。 */
export const PAID_PREVIEW = new Set(['plan_gate', 'jev_probability']);

/** `9.9 USDT/月`、`0.5 USDT/次`、`免费`;价格缺失给 —。 */
export function fmtProductPrice(p: Pick<AspProduct, 'price' | 'price_unit'>): string {
  if (!p.price) return '—';
  const n = Number(p.price);
  if (Number.isFinite(n) && n === 0) return t('免费');
  return `${p.price} USDT/${p.price_unit === 'month' ? t('月') : t('次')}`;
}

export function fmtTrialHours(h: number | null): string | null {
  if (h === null || !(h > 0)) return null;
  if (h % 24 === 0) return t('试用 {d} 天', { d: h / 24 });
  return t('试用 {h} 小时', { h });
}

/** 成功率;没有交付记录时 null(不是 0%)。 */
export function successRate(ok: number, failed: number): number | null {
  const n = ok + failed;
  return n > 0 ? ok / n : null;
}

export interface ProductsSummary {
  total: number;
  /** 在架(含暂停接单:产品仍在市场上)。 */
  listed: number;
  in_review: number;
  paused: number;
  not_listed: number;
  subscribers: number;
  trial: number;
  orders_7d: number;
}

export function summarize(products: AspProduct[]): ProductsSummary {
  return products.reduce<ProductsSummary>(
    (acc, p) => ({
      total: acc.total + 1,
      listed: acc.listed + (p.status === 'listed' || p.status === 'paused' ? 1 : 0),
      in_review: acc.in_review + (p.status === 'in_review' ? 1 : 0),
      paused: acc.paused + (p.status === 'paused' ? 1 : 0),
      not_listed: acc.not_listed + (p.status === 'not_listed' ? 1 : 0),
      subscribers: acc.subscribers + (p.kind === 'subscription' ? p.stats.active_subscribers : 0),
      trial: acc.trial + (p.kind === 'subscription' ? p.stats.trial_subscribers : 0),
      orders_7d: acc.orders_7d + p.stats.orders_7d,
    }),
    { total: 0, listed: 0, in_review: 0, paused: 0, not_listed: 0, subscribers: 0, trial: 0, orders_7d: 0 },
  );
}

/**
 * 「我的产品」汇总一行:`8 个产品 · 审核中 8 · 在架 0 · 2 个订阅者(试用中 2) · 近 7 天 18 张订单`。
 * 按状态拆开,免得「0 个在架」读成什么都没上;为 0 的项不写,只有「在架」总写(它是卖家最关心的那个数)。
 */
export function summaryLine(s: ProductsSummary): string {
  return [
    t('{n} 个产品', { n: s.total }),
    s.in_review ? t('审核中 {n}', { n: s.in_review }) : null,
    t('在架 {n}', { n: s.listed }) + (s.paused ? t('(暂停接单 {n})', { n: s.paused }) : ''),
    s.not_listed ? t('未上架 {n}', { n: s.not_listed }) : null,
    s.subscribers ? t('{n} 个订阅者', { n: s.subscribers }) + (s.trial ? t('(试用中 {n})', { n: s.trial }) : '') : null,
    s.orders_7d ? t('近 7 天 {n} 张订单', { n: s.orders_7d }) : null,
  ]
    .filter((x): x is string => !!x)
    .join(' · ');
}

/** 排序:在架的在前(有客户的更前),审核中,暂停,未上架;策略信号永远第一。 */
const STATUS_ORDER: Record<ProductStatus, number> = { listed: 0, in_review: 1, paused: 2, not_listed: 3 };
export function sortProducts(products: AspProduct[]): AspProduct[] {
  return [...products].sort((a, b) => {
    if (a.key === STRATEGY_KEY) return -1;
    if (b.key === STRATEGY_KEY) return 1;
    return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  });
}

export type Tone = 'ok' | 'wait' | 'bad' | 'idle';

/** 上架审核状态 → 色调。label 由后端给人话;这里只按字面兜底推色调,拿不准就中性。 */
export function approvalTone(a: AspApproval | null | undefined): Tone {
  if (!a) return 'idle';
  const s = `${a.label} ${a.remark ?? ''}`.toLowerCase();
  if (/拒|驳回|reject|denied|fail/.test(s)) return 'bad';
  if (/审核|review|pending|等待/.test(s)) return 'wait';
  if (/已上架|通过|approved|listed|active/.test(s)) return 'ok';
  return 'idle';
}

/**
 * 卖家身份的上架阶段(网关 approvalLabel 的码:2 审核中 / 3 改资料重新审核 / 5、6 被拒 / 1 或缺省 未提交)。
 * 决定身份条上给哪个按钮:审核中和已上架不给「上架身份」,被拒给「重新提交审核」。
 */
export type IdentityPhase = 'listed' | 'in_review' | 'rejected' | 'not_submitted';
export function identityPhase(a: AspApproval | null | undefined, identityActive: boolean): IdentityPhase {
  if (identityActive) return 'listed';
  const code = a?.code ?? null;
  if (code === 2 || code === 3) return 'in_review';
  if (code === 5 || code === 6) return 'rejected';
  if (code === 1) return 'not_submitted';
  // 没有码(老网关)或未知码:按人话 label 兜底
  const tone = approvalTone(a);
  if (tone === 'bad') return 'rejected';
  if (tone === 'wait' && !/未提交/.test(a?.label ?? '')) return 'in_review';
  if (tone === 'ok') return 'listed';
  return 'not_submitted';
}

export const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-up/15 text-up border-up/30',
  wait: 'bg-warn/15 text-warn border-warn/30',
  bad: 'bg-down/10 text-down border-down/30',
  idle: 'bg-muted text-muted-foreground border-transparent',
};

/** 线上描述拆成三段(核心能力 / 买家需提供 / 交付说明);多出的行并进第三段。 */
export function splitDescription(desc: string): [string, string, string] {
  const parts = desc.split('\n');
  return [parts[0] ?? '', parts[1] ?? '', parts.slice(2).join('\n')];
}

/** 后端 checklist 缺失时(接口没起来 / 还没注册)的本地兜底。 */
export function fallbackChecklist(hasIdentity: boolean, products: AspProduct[]): ChecklistItem[] {
  const listed = products.some((p) => p.status === 'listed' || p.status === 'paused' || p.status === 'in_review');
  const approved = products.some((p) => p.status === 'listed' || p.status === 'paused');
  const customer = products.some((p) => p.stats.active_subscribers > 0 || p.stats.orders_total > 0);
  return [
    { key: 'asp', label: t('注册卖家身份'), done: hasIdentity, hint: t('一个钱包一个身份,OKX 付手续费') },
    { key: 'listed', label: t('上架第一个产品'), done: listed, hint: t('定价、写清楚能提供什么') },
    { key: 'review', label: t('提交审核'), done: approved, hint: t('OKX 审核通过后,买家才能在市场里看到') },
    { key: 'first_customer', label: t('等第一个订阅者 / 第一张订单'), done: customer, hint: t('先预览一下买家会收到什么') },
  ];
}

export const ONBOARDING_KEY = 'tg.market.publish.onboarding.dismissed';

export function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeDismissed(v: boolean): void {
  try {
    if (v) window.localStorage.setItem(ONBOARDING_KEY, '1');
    else window.localStorage.removeItem(ONBOARDING_KEY);
  } catch {
    /* 隐私模式等:只在本次会话内生效 */
  }
}

export function errText(err: unknown): string {
  return friendlyMarketError(err instanceof Error ? err.message : String(err));
}

/** react-query key:挂在 ['market'] 下,注册 / 上下架后整体失效时一起刷新。 */
export const PRODUCTS_KEY = ['market', 'asp-products'] as const;
export const customersKey = (key: string) => ['market', 'asp-products', key, 'customers'] as const;
