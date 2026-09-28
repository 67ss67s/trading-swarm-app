// 维护线程:自己开一条 SQLite 连接,按 TG_MAINTENANCE_INTERVAL_MS(默认 15 分钟)跑 maintain + dailyBackup,结果回报给 OpsMonitor。
// 主线程发任意消息 = 停止:当前一轮跑完(每批都是短事务)后关库退出。
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { maintain, dailyBackup } from './maintenance.js';
import { envInt } from './ops-config.js';

const dbPath = String((workerData as { dbPath: string }).dbPath);
const db = new DatabaseSync(dbPath);
// 维护线程等锁不影响主线程;主线程一侧 busy_timeout=5000,而我们每批只占几毫秒。
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000');

let stopping = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function close(): void {
  db.close();
  parentPort?.close();
}

function classify(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/locked|busy/i.test(text)) return 'database_busy';
  if (/disk|full|SQLITE_FULL|ENOSPC|backup_insufficient_disk/i.test(text)) return 'disk_capacity';
  if (/backup_integrity_failed/.test(text)) return 'backup_integrity_failed';
  return 'maintenance_failed';
}

async function tick(): Promise<void> {
  running = true;
  try {
    const result = await maintain(db, dbPath);
    // 先报清理结果,备份失败不抹掉磁盘与 checkpoint 状态。
    parentPort?.postMessage({ result });
    result.backup_at = await dailyBackup(db, dbPath);
    parentPort?.postMessage({ result });
  } catch (e) {
    parentPort?.postMessage({ error: classify(e) });
  } finally {
    running = false;
    if (stopping) close();
    else timer = setTimeout(() => void tick(), envInt('TG_MAINTENANCE_INTERVAL_MS', 15 * 60_000, 1000));
  }
}

parentPort?.on('message', () => {
  stopping = true;
  clearTimeout(timer);
  if (!running) close();
});

// 启动后先等一会儿再跑第一轮,避开网关启动时的迁移和首轮轮询。
timer = setTimeout(() => void tick(), envInt('TG_MAINTENANCE_FIRST_DELAY_MS', 60_000, 0));
