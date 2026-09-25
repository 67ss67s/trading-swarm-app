/**
 * worker 线程里的 Pine 接线。Pine 引擎子进程归网关主线程托管(pine/engine-host.ts 的进程内单例),worker 线程里没有那个单例,
 * 所以主线程把当前引擎地址经 workerData 传进来,这里装一个只会报地址的托管器替身,再装脚本目录与原语运行时(同一个 DB 文件的另一条连接)。
 * 不改 pine/ 下任何文件;地址失效(引擎重启换端口)时 pine_series 照常报 PROVIDER_ERROR,由候选评估记为失败。
 */
import type { DatabaseSync } from 'node:sqlite';
import { setPineEngineHost, type PineEngineHost } from '../pine/engine-host.js';
import { PineCatalog, setPineCatalog } from '../pine/catalog.js';
import { setPineRuntime, defaultPineRuntime } from '../primitives/pine.js';
import type { ResearchStore } from '../store.js';

export function installWorkerPine(pineUrl: string | null, db: DatabaseSync, store: ResearchStore): void {
  if (pineUrl) {
    const port = Number(new URL(pineUrl).port) || null;
    const shim = {
      url: () => pineUrl,
      health: () => ({ status: 'up', pid: null, port, restarts: 0, last_error: null, engine: 'pinets', version: null }),
      ready: async () => true,
      options: { runTimeoutMs: 60000, maxOutputBytes: 16 * 1024 * 1024 },
    };
    setPineEngineHost(shim as unknown as PineEngineHost);
  }
  setPineCatalog(new PineCatalog(db));
  setPineRuntime(defaultPineRuntime(() => store.datasets(), (id) => store.dataset(id)));
}
