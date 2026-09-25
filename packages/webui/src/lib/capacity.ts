/** §9.18 组合容量的展示文案,楼层 Portfolio 卡与 Agent 页名单表共用一份 */
import type { CapacityConstraint, CapacitySymbol, CapacityVerdict } from '@/api/types';
import { t, tmap } from '@/lib/i18n';

export const CONSTRAINT_LABEL: Record<CapacityConstraint, string> = tmap({
  thread_slots: '线程数上限',
  margin_budget: '保证金预算',
  available_margin: '可用保证金',
  min_size_risk: '最小单风险',
  rules_unknown: '交易规则未知',
  market_unavailable: '行情不可用',
  watchlist: '名单为空',
  snapshot_unavailable: '没有账户快照',
});

export const VERDICT_LABEL: Record<CapacityVerdict, string> = tmap({ ok: '可做', needs_equity: '权益不够', rules_unknown: '规则未知', unavailable: '行情不可用' });

/** 每币一句:「可做」/「要 240 U」/「规则未知」;occupied 与 watch_only 另标 */
export function verdictText(r: CapacitySymbol): string {
  if (r.verdict === 'needs_equity') return r.required_equity ? t('要 {n} U', { n: trimNum(r.required_equity) }) : t('权益不够');
  return VERDICT_LABEL[r.verdict];
}

/** 十进制字符串只做截断显示,不做算术 */
export function trimNum(v: string | null | undefined, digits = 0): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toFixed(digits);
}
