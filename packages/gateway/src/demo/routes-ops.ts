// GET /api/health:不需要鉴权。完整视图只给本机/owner;公网匿名访客只拿状态与各依赖是否告警,不给内存、预算、维护细节。
// 只投影计数与时间,不返回账户、路径、模型配置、命令或原始异常。凭证过期/额度耗尽只在这里和活动流告警里出现,页面不展示余额。
import type { DemoRuntime } from './runtime.js';
import type { OpsMonitor, OpsView } from './ops-monitor.js';
import { demoBudgetView } from './public-demo.js';

export interface HealthBudget {
  judgments: number;
  judgment_cap: number;
  judgment_capped: boolean;
  input_tokens: number;
  output_tokens: number;
  decision_spent_usd: string;
  decision_daily_usd_cap: string;
  day_timezone: string;
  public_demo: ReturnType<typeof demoBudgetView>;
}

export type HealthView = OpsView & { budget: HealthBudget | null };

export function healthView(rt: DemoRuntime, ops: OpsMonitor): HealthView {
  const base = ops.view();
  try {
    const usage = rt.usageToday();
    const budget: HealthBudget = {
      judgments: usage.judgments,
      judgment_cap: usage.cap,
      judgment_capped: usage.capped,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      decision_spent_usd: rt.store.kvGet(`models.decision_spend:${new Date().toISOString().slice(0, 10)}`) ?? '0',
      decision_daily_usd_cap: String(rt.workflow.decision_daily_usd_cap ?? 2),
      day_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      public_demo: demoBudgetView(),
    };
    return { ...base, budget };
  } catch {
    return { ...base, status: 'degraded', budget: null };
  }
}

/** 公网匿名视图:外部探活够用,不暴露运行细节。 */
export function publicHealthView(view: HealthView): { status: HealthView['status']; uptime_seconds: number; dependencies: Record<string, { alert: boolean }> } {
  return {
    status: view.status,
    uptime_seconds: view.process.uptime_seconds,
    dependencies: Object.fromEntries(Object.entries(view.dependencies).map(([name, s]) => [name, { alert: s.alert }])),
  };
}
