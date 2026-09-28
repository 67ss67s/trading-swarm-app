// research_datasets 容量上限:研究数据是可追溯证据(回测/研究结论引用它),不按猜测的引用关系删历史;
// 到上限时拒绝新增(HTTP 507,提示导出归档或调大),已有数据照常复用。用量由 0055_soak_ops 迁移的触发器维护。
import type { DatabaseSync } from 'node:sqlite';
import { envInt } from './ops-config.js';

export class ResearchCacheFull extends Error {
  readonly status = 507;
  readonly code = 'research_cache_capacity';
  constructor() {
    super('research_cache_capacity: 研究数据容量已满,请导出归档或调大 TG_DATASET_MAX_BYTES / TG_DATASET_MAX_ROWS;已有数据保留');
  }
}

/** 研究模块也会在没跑网关迁移的独立库上用(测试、离线评测);没有计量表就不设上限。 */
const metered = new WeakMap<DatabaseSync, boolean>();
function hasUsageTable(db: DatabaseSync): boolean {
  let known = metered.get(db);
  if (known === undefined) {
    known = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ops_cache_usage'").get());
    metered.set(db, known);
  }
  return known;
}

export function insertResearchDataset(db: DatabaseSync, id: string, json: string): void {
  if (db.prepare('SELECT 1 FROM research_datasets WHERE id = ?').get(id)) return;
  if (!hasUsageTable(db)) {
    db.prepare('INSERT OR IGNORE INTO research_datasets VALUES (?, ?, ?)').run(id, Date.now(), json);
    return;
  }
  const maxBytes = envInt('TG_DATASET_MAX_BYTES', 1024 * 1024 * 1024);
  const maxRows = envInt('TG_DATASET_MAX_ROWS', 5000);
  db.exec('SAVEPOINT ops_dataset');
  try {
    const usage = db.prepare("SELECT bytes, rows FROM ops_cache_usage WHERE name = 'research_datasets'").get() as { bytes: number; rows: number } | undefined;
    if (usage && (usage.bytes + Buffer.byteLength(json) > maxBytes || usage.rows >= maxRows)) throw new ResearchCacheFull();
    db.prepare('INSERT OR IGNORE INTO research_datasets VALUES (?, ?, ?)').run(id, Date.now(), json);
    db.exec('RELEASE ops_dataset');
  } catch (e) {
    db.exec('ROLLBACK TO ops_dataset; RELEASE ops_dataset');
    throw e;
  }
}
