import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecBackend } from './execution.js';

/** Pause rejects new operations; an accepted operation drains through its protection/cleanup legs. */
export class ExecutorControl {
  private readonly scope = new AsyncLocalStorage<{ active: boolean }>();
  active = 0;
  constructor(private readonly enabled: () => boolean) {}
  async run<T>(fn: () => Promise<T>, emergency = false): Promise<T> {
    if (this.scope.getStore()?.active) return fn();
    if (!emergency && !this.enabled()) throw Object.assign(new Error('Executor 已暂停，请先启用执行服务'), { status: 409 });
    const token = { active: true };
    this.active++;
    try { return await this.scope.run(token, fn); }
    finally { token.active = false; this.active--; }
  }
  wrap(backend: ExecBackend): ExecBackend {
    // Lifecycle and pure introspection stay available while paused. All exchange I/O is guarded.
    const local = new Set(['marketsSupported', 'start', 'stop', 'tick', 'accountStalenessMs', 'invalidateAccount', 'transportHealth', 'protectionCapability', 'costControl', 'resetModelBudget']);
    return new Proxy(backend, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (local.has(String(key))) return value.bind(target);
        return (...args: unknown[]) => this.run(() => value.apply(target, args));
      },
    });
  }
}
