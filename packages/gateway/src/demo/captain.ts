import { riskSummary } from './risk.js';
/**
 * Gate Captain(dispatcher-lite,这版**零模型**):
 *   - 收件箱 = 发给 gate_captain 的 pending handoff(已有);
 *   - 每日简报 = 代码从账本拼一张卡(过去 24h:各角色 run 数与花费、待阅交接、开放告警、平仓结果、账户快照),
 *     bot_run(routine daily_brief)+ 活动流一条;每个数字都能在证据里找到(测试对着 store 逐项核)。
 *   - 路由:EVENT_ROUTES 仍是唯一目录;这版不新增模型路由,对话仍走 chat.ts。
 * 议会(Proposal Council)的扇出/扇入与 hash 审批是单列的 L 级安全前置(Codex 稿 §7),这版不做。
 */
import type { BotRegistry, BotRun } from './bots.js';
import type { RiskAlertRow } from './team-store.js';
import { isBlockingAlert } from './risk.js';
import type { PortfolioSnapshot } from './portfolio.js';
import type { TradeCard } from './reviewer.js';

export interface DailyBrief {
  from: number;
  to: number;
  runs_by_role: Record<string, { runs: number; done: number; failed: number; skipped: number; cost_cny: number }>;
  total_cost_cny: number;
  pending_handoffs: { count: number; by_from: Record<string, number> };
  risk: { level: 'none' | 'warn' | 'high' | 'critical'; open: number; blocks_new_risk: boolean; titles: string[] };
  portfolio: { quality: string; equity: number; gross_ratio: number; clusters: number } | null;
  trades: { closed: number; wins: number; losses: number; total_r: number; unprotected: number };
  headline: string;
}

export function buildDailyBrief(inp: { bots: BotRegistry; alerts: RiskAlertRow[]; level: DailyBrief['risk']['level']; snapshot: PortfolioSnapshot | null; cards: TradeCard[]; now: number }): DailyBrief {
  const from = inp.now - 86_400_000;
  const runs = inp.bots.runs({ limit: 500 }).filter((r) => r.started_at >= from);
  const byRole: DailyBrief['runs_by_role'] = {};
  let total = 0;
  for (const r of runs) {
    const cur = byRole[r.role] ?? { runs: 0, done: 0, failed: 0, skipped: 0, cost_cny: 0 };
    cur.runs++;
    if (r.status === 'done') cur.done++;
    if (r.status === 'failed') cur.failed++;
    if (r.status === 'skipped') cur.skipped++;
    cur.cost_cny += r.cost_cny;
    total += r.cost_cny;
    byRole[r.role] = cur;
  }
  const pending = inp.bots.handoffs({ status: 'pending', to_role: 'gate_captain', limit: 200 });
  const byFrom: Record<string, number> = {};
  for (const h of pending) byFrom[h.from_role] = (byFrom[h.from_role] ?? 0) + 1;
  const cards = inp.cards.filter((c) => c.ended_at >= from && c.filled);
  const wins = cards.filter((c) => c.outcome === 'win').length;
  const losses = cards.filter((c) => c.outcome === 'loss').length;
  const totalR = cards.reduce((a, c) => a + (c.r_multiple ?? 0), 0);
  const unprotected = cards.filter((c) => !c.protection_ok).length;
  const s = inp.snapshot;
  const headline = [
    `过去 24h:${runs.length} 次角色任务,¥${total.toFixed(3)}`,
    `${pending.length} 条待阅`,
    inp.alerts.length ? `风控 ${inp.level}(${inp.alerts.length} 条开放)` : '风控无告警',
    cards.length ? `平仓 ${cards.length} 笔,胜 ${wins} 负 ${losses},合计 ${totalR.toFixed(2)}R` : '无平仓',
    s ? `总敞口 ${s.projected.gross_ratio.toFixed(2)}×(${s.quality})` : '无账户快照',
  ].join(';');
  return {
    from,
    to: inp.now,
    runs_by_role: byRole,
    total_cost_cny: Math.round(total * 1000) / 1000,
    pending_handoffs: { count: pending.length, by_from: byFrom },
    risk: { level: inp.level, open: inp.alerts.length, blocks_new_risk: inp.alerts.some((a) => isBlockingAlert(a)), titles: riskSummary(inp.alerts).slice(0, 5) },
    portfolio: s ? { quality: s.quality, equity: s.equity, gross_ratio: s.projected.gross_ratio, clusters: Object.keys(s.by_cluster).length } : null,
    trades: { closed: cards.length, wins, losses, total_r: Math.round(totalR * 100) / 100, unprotected },
    headline,
  };
}

/** 简报每天一次(本地日);上一份还在今天就不再出。 */
export function briefDue(lastBrief: BotRun | null, now: number): boolean {
  if (!lastBrief) return true;
  const a = new Date(lastBrief.started_at);
  const b = new Date(now);
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}
