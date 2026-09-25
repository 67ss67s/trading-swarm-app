/**
 * 进化页的角色兜底文案:接口没上线或某角色缺行时,按契约 §三 的表先把九行画出来(全灰)。
 * 接口有数据时一律以后端的 label / metric_label 为准。
 */
import type { EvoRoleRow } from '@/api/evolution';
import { ROLE_ORDER } from '@/components/floor/roles';

export const EVO_ROLE_FALLBACK: Record<string, { label: string; metric_label: string }> = {
  thread_manager: { label: '判断', metric_label: '已结算判断事后 R vs 机械对照' },
  radar: { label: '雷达', metric_label: '候选被跟进比例 · 后续结算为正比例' },
  strategy_lab: { label: '策略实验台', metric_label: '研究 / 回测 / 改进环运行数 · 过门槛候选' },
  portfolio_manager: { label: '组合', metric_label: '当天账户收益 vs BTC 持有' },
  risk_sentinel: { label: '风控', metric_label: '去重后告警 · 拦截 · 严重告警' },
  executor: { label: '执行', metric_label: '下单 / 执行成功率 · 交易所报错数' },
  reviewer: { label: '复盘', metric_label: '教训提案数 · 被采纳数' },
  gate_captain: { label: '指挥', metric_label: '判断额度使用 · 空转比例' },
  asp_agent: { label: '信号市场', metric_label: '信号收发与运行成功数' },
};

/** 以 ROLE_ORDER 排序;接口缺的角色补一行空的,接口多出来的角色排在后面 */
export function evoRows(rows: readonly EvoRoleRow[] | undefined): EvoRoleRow[] {
  const by = new Map((rows ?? []).map((r) => [r.role, r]));
  const out: EvoRoleRow[] = ROLE_ORDER.map((role) => by.get(role) ?? { role, label: EVO_ROLE_FALLBACK[role]?.label ?? role, metric_label: EVO_ROLE_FALLBACK[role]?.metric_label ?? '', days: [], summary: { good: 0, ok: 0, bad: 0, none: 0, baseline_days: 0 } });
  for (const r of rows ?? []) if (!(ROLE_ORDER as string[]).includes(r.role)) out.push(r);
  return out;
}
