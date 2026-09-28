// 外部依赖状态:最近成功/失败时间、连续失败次数、原因分类。凭证失效、额度耗尽、连续 N 次失败 → 发一次信号
// (main.ts 转成活动流告警),恢复时再发一次。只存固定依赖名与原因分类,不存原始错误、命令、URL 或密钥。
import { envInt } from './ops-config.js';

export const DEPENDENCIES = ['market', 'account', 'brain', 'decision', 'a2a', 'pine', 'maintenance'] as const;
export type DependencyName = (typeof DEPENDENCIES)[number];

export type FailureReason = 'authentication' | 'budget' | 'timeout' | 'unavailable';

export interface DependencyStatus {
  last_success_at: number | null;
  last_failure_at: number | null;
  consecutive_failures: number;
  reason: FailureReason | null;
  alert: boolean;
}

export interface DependencySignal { dependency: DependencyName; recovered: boolean; reason: FailureReason | 'recovered' }

const empty = (): DependencyStatus => ({ last_success_at: null, last_failure_at: null, consecutive_failures: 0, reason: null, alert: false });

function reasonOf(error: unknown): FailureReason {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/\b401\b|\b403\b|auth|credential|expired|login|session.*invalid|凭证|登录|过期/i.test(message)) return 'authentication';
  if (/\b402\b|insufficient|credit|quota|budget|余额|额度/i.test(message)) return 'budget';
  if (/timeout|timed out|超时/i.test(message)) return 'timeout';
  return 'unavailable';
}

export class DependencyHealth {
  private readonly states = new Map<DependencyName, DependencyStatus>();
  private listener?: (signal: DependencySignal) => void;

  onSignal(listener: (signal: DependencySignal) => void): void {
    this.listener = listener;
  }

  observe(name: DependencyName, ok: boolean, error?: unknown, now = Date.now()): void {
    const s = this.states.get(name) ?? empty();
    this.states.set(name, s);
    if (ok) {
      const wasAlert = s.alert;
      Object.assign(s, { last_success_at: now, consecutive_failures: 0, reason: null, alert: false });
      if (wasAlert) this.listener?.({ dependency: name, recovered: true, reason: 'recovered' });
      return;
    }
    const reason = reasonOf(error);
    s.last_failure_at = now;
    s.consecutive_failures++;
    s.reason = reason;
    const alert = reason === 'authentication' || reason === 'budget' || s.consecutive_failures >= envInt('TG_DEPENDENCY_FAILURE_THRESHOLD', 5, 1, 1000);
    const notify = alert && !s.alert;
    s.alert ||= alert;
    if (notify) this.listener?.({ dependency: name, recovered: false, reason });
  }

  view(): Record<DependencyName, DependencyStatus> {
    return Object.fromEntries(DEPENDENCIES.map((name) => [name, { ...(this.states.get(name) ?? empty()) }])) as Record<DependencyName, DependencyStatus>;
  }
}

export const dependencyHealth = new DependencyHealth();
