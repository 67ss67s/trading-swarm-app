// 运行健康:事件循环延迟、库可读、维护线程最近一轮结果、依赖状态。/api/health 的数据源(routes-ops.ts 投影)。
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import type { MaintenanceResult } from './maintenance.js';
import { dependencyHealth, type DependencyStatus } from './dependency-health.js';
import { envInt } from './ops-config.js';

const LAG_SAMPLE_MS = 10_000;
const LAG_DEGRADED_MS = 1000;

export interface OpsView {
  status: 'ok' | 'degraded';
  process: { uptime_seconds: number; rss: number; heap_used: number; heap_total: number; external: number };
  database: { readable: boolean };
  event_loop: { p99_ms: number; max_ms: number };
  dependencies: Record<string, DependencyStatus>;
  maintenance: MaintenanceResult | null;
  maintenance_error: string | null;
}

export class OpsMonitor {
  private readonly delay = monitorEventLoopDelay({ resolution: 20 });
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly worker?: Worker;
  private latest: MaintenanceResult | null = null;
  private workerError: string | null = null;
  private lag = { p99_ms: 0, max_ms: 0 };

  /** dbPath 为空或 :memory: 时不起维护线程(测试、内存库)。 */
  constructor(private readonly db: DatabaseSync, dbPath?: string) {
    this.delay.enable();
    this.timer = setInterval(() => {
      this.lag = { p99_ms: Math.round(this.delay.percentile(99) / 1e6), max_ms: Math.round(this.delay.max / 1e6) };
      this.delay.reset();
    }, LAG_SAMPLE_MS);
    this.timer.unref();
    if (!dbPath || dbPath === ':memory:' || process.env['TG_MAINTENANCE_ENABLED'] === '0') return;

    this.worker = new Worker(new URL('./maintenance-worker.js', import.meta.url), { workerData: { dbPath } });
    this.worker.on('message', (message: { result?: MaintenanceResult; error?: string }) => {
      if (message.result) {
        this.latest = message.result;
        this.workerError = null;
        const diskOk = message.result.free_bytes >= envInt('TG_DISK_MIN_FREE_BYTES', 1024 ** 3);
        const checkpointOk = !message.result.checkpoint?.busy;
        dependencyHealth.observe('maintenance', diskOk && checkpointOk, diskOk ? 'checkpoint busy' : '磁盘余量不足');
      }
      if (message.error) {
        this.workerError = message.error;
        dependencyHealth.observe('maintenance', false, message.error);
      }
    });
    this.worker.on('error', () => {
      this.workerError = 'worker_failed';
      dependencyHealth.observe('maintenance', false, 'worker_failed');
    });
    this.worker.on('exit', (code) => {
      if (code !== 0) this.workerError = 'worker_exited';
    });
  }

  view(): OpsView {
    let readable = true;
    try {
      this.db.prepare('SELECT 1').get();
    } catch {
      readable = false;
    }
    const dependencies = dependencyHealth.view();
    const intervalMs = envInt('TG_MAINTENANCE_INTERVAL_MS', 15 * 60_000, 1000);
    const stale = this.latest !== null && Date.now() - this.latest.at > intervalMs * 3;
    const healthy = readable && !this.workerError && !stale && this.lag.p99_ms < LAG_DEGRADED_MS && !Object.values(dependencies).some((s) => s.alert);
    const mem = process.memoryUsage();
    return {
      status: healthy ? 'ok' : 'degraded',
      process: { uptime_seconds: Math.floor(process.uptime()), rss: mem.rss, heap_used: mem.heapUsed, heap_total: mem.heapTotal, external: mem.external },
      database: { readable },
      event_loop: this.lag,
      dependencies,
      maintenance: this.latest,
      maintenance_error: this.workerError,
    };
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.delay.disable();
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => void worker.terminate().then(() => resolve()), 5000);
      worker.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      worker.postMessage('stop');
    });
  }
}
