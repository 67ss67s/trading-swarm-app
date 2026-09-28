// 库维护(在 maintenance-worker.ts 的独立线程里跑,主线程事件循环不参与):
//   1. 旧日志补分类(ops_noise IS NULL → 按 log-policy.ts 判定);
//   2. 超过 TG_NOISE_KEEP_DAYS 天的噪音明细压成「每天每 key 一行摘要」(首条保留为摘要行,次数/末次时间并进去,其余删除);
//   3. 超过 TG_SNAPSHOT_KEEP_DAYS(默认 14)天的持仓/权益快照抽稀成每小时一条(demo_portfolio_snapshot、demo_equity;
//      风控告警引用的快照保留);
//   4. wal_checkpoint(TRUNCATE) + PRAGMA optimize;
//   5. 可选每日在线备份(dailyBackup,默认保留 2 份)。
// 每批一个短事务(默认 500 行),批间让出 10ms,主线程写入最多等一个批次。规则表以外的数据没有任何删除路径。
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { envInt } from './ops-config.js';
import { logPolicy } from './log-policy.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOISE = 1;
const SUMMARY = 2;

interface LogRow { id: number; at: number; scope: string; level: string; message: string; json: string | null; repeat_count: number; last_seen_at: number | null; ops_key: string | null }

export interface RulePlan { rule: string; rows: number; observed: number; summaries: number }

/** 快照抽稀:每张表删了(dry-run 为将删)多少行。 */
export interface SnapshotThinning { demo_portfolio_snapshot: number; demo_equity: number }

export interface MaintenanceResult {
  at: number;
  dry_run: boolean;
  cutoff: number;
  classified: number;
  /** 本轮删除的噪音明细行数(dry-run 为预计值)。 */
  deleted: number;
  /** 本轮新建的摘要行(dry-run 为预计值)。 */
  summarized: number;
  /** 各规则的清理计划/结果;dry-run 只看这一项就知道要删什么。 */
  plan: RulePlan[];
  logs_before: number;
  logs_after: number;
  /** 超过 TG_SNAPSHOT_KEEP_DAYS 天的快照抽稀成每小时一条。 */
  snapshots_thinned: SnapshotThinning;
  remaining_eligible: number;
  unclassified: number;
  checkpoint: { busy: number; log: number; checkpointed: number } | null;
  db_bytes: number;
  wal_bytes: number;
  free_pages: number;
  free_bytes: number;
  dataset_bytes: number;
  dataset_rows: number;
  backup_at: number | null;
  elapsed_ms: number;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ThinSpec { table: keyof SnapshotThinning; key: string; at: string; group: string }
const THIN_SPECS: readonly ThinSpec[] = [
  { table: 'demo_portfolio_snapshot', key: 'snapshot_id', at: 'observed_at', group: "''" },
  { table: 'demo_equity', key: 'at', at: 'at', group: 'backend' },
];

/** 风控告警 refs 里引用过的快照 id(告警证据,抽稀时保留)。 */
function referencedSnapshots(db: DatabaseSync): Set<string> {
  const ids = new Set<string>();
  for (const row of db.prepare('SELECT refs_json FROM demo_risk_alert').iterate() as Iterable<{ refs_json: string }>) {
    try {
      for (const ref of JSON.parse(row.refs_json) as unknown[]) if (typeof ref === 'string') ids.add(ref);
    } catch {
      /* 坏数据:忽略 */
    }
  }
  return ids;
}

/**
 * 按时间顺序走一遍 cutoff 之前的快照:每个(分组, UTC 小时)留第一条,其余删除。第一条是稳定的,所以重复跑是幂等的;
 * 按 (时间, 主键) 游标分批,每批一个短事务。dry-run 只计数。
 */
async function thinSnapshots(db: DatabaseSync, cutoff: number, batch: number, maxBatches: number, dryRun: boolean): Promise<SnapshotThinning> {
  const result: SnapshotThinning = { demo_portfolio_snapshot: 0, demo_equity: 0 };
  const referenced = referencedSnapshots(db);
  for (const spec of THIN_SPECS) {
    const page = db.prepare(`SELECT ${spec.key} AS k, ${spec.at} AS t, ${spec.group} AS g FROM ${spec.table}
      WHERE ${spec.at} < ? AND (${spec.at} > ? OR (${spec.at} = ? AND ${spec.key} > ?)) ORDER BY ${spec.at}, ${spec.key} LIMIT ?`);
    const remove = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.key} = ?`);
    const kept = new Set<string>();
    let cursor: { t: number; k: string | number } = { t: -1, k: '' };
    for (let pass = 0; pass < maxBatches; pass++) {
      const rows = page.all(cutoff, cursor.t, cursor.t, cursor.k, batch) as { k: string | number; t: number; g: string }[];
      if (!rows.length) break;
      cursor = { t: rows.at(-1)!.t, k: rows.at(-1)!.k };
      const doomed: (string | number)[] = [];
      for (const row of rows) {
        const bucket = `${row.g}:${Math.floor(row.t / HOUR_MS)}`;
        if (!kept.has(bucket)) { kept.add(bucket); continue; }
        if (typeof row.k === 'string' && referenced.has(row.k)) continue;
        doomed.push(row.k);
      }
      if (!dryRun && doomed.length) transaction(db, () => { for (const k of doomed) remove.run(k); });
      result[spec.table] += doomed.length;
      if (!dryRun) await pause(10);
    }
  }
  return result;
}
const dayOf = (at: number): number => Math.floor(at / DAY_MS) * DAY_MS;
const count = (db: DatabaseSync, sql: string, ...args: (number | string)[]): number => Number((db.prepare(sql).get(...args) as { n: number }).n);

function transaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function addToPlan(plan: Map<string, RulePlan>, rule: string, observed: number, summary: boolean): void {
  const p = plan.get(rule) ?? { rule, rows: 0, observed: 0, summaries: 0 };
  p.observed += observed;
  if (summary) p.summaries++;
  else p.rows++;
  plan.set(rule, p);
}

/** dry-run:只读扫描,算出按规则要删多少明细、要新建多少摘要。不改任何行,包括分类元数据。 */
function planOnly(db: DatabaseSync, cutoff: number): { deleted: number; summarized: number; plan: RulePlan[] } {
  const plan = new Map<string, RulePlan>();
  const keepers = new Set<string>();
  for (const row of db.prepare('SELECT ops_key, at FROM demo_logs WHERE ops_noise = ? AND at < ?').iterate(SUMMARY, cutoff) as Iterable<{ ops_key: string; at: number }>) {
    keepers.add(`${dayOf(row.at)}:${row.ops_key}`);
  }
  let deleted = 0;
  let summarized = 0;
  const rows = db.prepare('SELECT id, at, scope, level, message, json, repeat_count, ops_noise FROM demo_logs WHERE (ops_noise = ? OR ops_noise IS NULL) AND at < ? ORDER BY at')
    .iterate(NOISE, cutoff) as Iterable<LogRow & { ops_noise: number | null }>;
  for (const row of rows) {
    const policy = logPolicy(row);
    if (!policy.noise || !policy.key) continue;
    const dayKey = `${dayOf(row.at)}:${policy.key}`;
    const becomesSummary = !keepers.has(dayKey);
    if (becomesSummary) { keepers.add(dayKey); summarized++; }
    else deleted++;
    addToPlan(plan, policy.rule, row.repeat_count, becomesSummary);
  }
  return { deleted, summarized, plan: [...plan.values()] };
}

export async function maintain(db: DatabaseSync, dbPath: string, now = Date.now()): Promise<MaintenanceResult> {
  const started = Date.now();
  const batch = envInt('TG_MAINTENANCE_BATCH', 500, 1, 5000);
  const maxBatches = envInt('TG_MAINTENANCE_MAX_BATCHES', 100, 1, 10_000);
  const dryRun = process.env['TG_MAINTENANCE_DRY_RUN'] === '1';
  const cutoff = now - envInt('TG_NOISE_KEEP_DAYS', 3, 1, 3650) * DAY_MS;
  const snapshotCutoff = now - envInt('TG_SNAPSHOT_KEEP_DAYS', 14, 1, 3650) * DAY_MS;
  const logsBefore = count(db, 'SELECT count(*) n FROM demo_logs');
  let classified = 0;
  let deleted = 0;
  let summarized = 0;
  let plan: RulePlan[] = [];

  if (dryRun) {
    ({ deleted, summarized, plan } = planOnly(db, cutoff));
  } else {
    // 1. 旧行补分类(迁移前写入的行没有 ops_noise)。
    const legacy = db.prepare('SELECT id, at, scope, level, message, json FROM demo_logs WHERE ops_noise IS NULL ORDER BY id LIMIT ?');
    const classify = db.prepare('UPDATE demo_logs SET ops_noise = ?, ops_key = ? WHERE id = ?');
    for (let pass = 0; pass < maxBatches; pass++) {
      const rows = legacy.all(batch) as unknown as LogRow[];
      if (!rows.length) break;
      transaction(db, () => {
        for (const row of rows) {
          const policy = logPolicy(row);
          classify.run(policy.noise ? NOISE : 0, policy.key, row.id);
        }
      });
      classified += rows.length;
      await pause(10);
    }

    // 2. 噪音明细 → 每天每 key 一行摘要。摘要更新与明细删除在同一事务里,崩溃不会丢计数或重复计数。
    const plans = new Map<string, RulePlan>();
    const due = db.prepare('SELECT id, at, scope, level, message, json, repeat_count, last_seen_at, ops_key FROM demo_logs WHERE ops_noise = ? AND at < ? ORDER BY at LIMIT ?');
    const findKeeper = db.prepare('SELECT id FROM demo_logs WHERE ops_key = ? AND ops_noise = ? AND at >= ? AND at < ? LIMIT 1');
    const promote = db.prepare('UPDATE demo_logs SET ops_noise = ? WHERE id = ?');
    const merge = db.prepare('UPDATE demo_logs SET repeat_count = repeat_count + ?, last_seen_at = MAX(COALESCE(last_seen_at, at), ?) WHERE id = ?');
    const remove = db.prepare('DELETE FROM demo_logs WHERE id = ?');
    for (let pass = 0; pass < maxBatches; pass++) {
      const rows = due.all(NOISE, cutoff, batch) as unknown as LogRow[];
      if (!rows.length) break;
      transaction(db, () => {
        for (const row of rows) {
          const policy = logPolicy(row);
          const key = row.ops_key ?? policy.key;
          if (!policy.noise || !key) { promote.run(0, row.id); continue; } // 规则收紧后不再算噪音:转为永久保留
          const day = dayOf(row.at);
          const keeper = findKeeper.get(key, SUMMARY, day, day + DAY_MS) as { id: number } | undefined;
          if (keeper) {
            merge.run(row.repeat_count, row.last_seen_at ?? row.at, keeper.id);
            remove.run(row.id);
            deleted++;
            addToPlan(plans, policy.rule, row.repeat_count, false);
          } else {
            promote.run(SUMMARY, row.id);
            summarized++;
            addToPlan(plans, policy.rule, row.repeat_count, true);
          }
        }
      });
      await pause(10);
    }
    plan = [...plans.values()];
  }

  const snapshotsThinned = await thinSnapshots(db, snapshotCutoff, batch, maxBatches, dryRun);
  const checkpoint = dryRun ? null : db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as unknown as MaintenanceResult['checkpoint'];
  if (!dryRun) db.exec('PRAGMA analysis_limit=400; PRAGMA optimize');
  const disk = await statfs(path.dirname(dbPath));
  const size = async (file: string): Promise<number> => (await stat(file).catch(() => null))?.size ?? 0;
  const usage = db.prepare("SELECT bytes, rows FROM ops_cache_usage WHERE name = 'research_datasets'").get() as { bytes: number; rows: number } | undefined;
  return {
    at: now,
    dry_run: dryRun,
    cutoff,
    classified,
    deleted,
    summarized,
    plan,
    logs_before: logsBefore,
    logs_after: count(db, 'SELECT count(*) n FROM demo_logs'),
    snapshots_thinned: snapshotsThinned,
    remaining_eligible: dryRun ? deleted + summarized : count(db, 'SELECT count(*) n FROM demo_logs WHERE ops_noise = ? AND at < ?', NOISE, cutoff),
    unclassified: count(db, 'SELECT count(*) n FROM demo_logs WHERE ops_noise IS NULL'),
    checkpoint,
    db_bytes: await size(dbPath),
    wal_bytes: await size(`${dbPath}-wal`),
    free_pages: Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count),
    free_bytes: disk.bavail * disk.bsize,
    dataset_bytes: usage?.bytes ?? 0,
    dataset_rows: usage?.rows ?? 0,
    backup_at: null,
    elapsed_ms: Date.now() - started,
  };
}

const BACKUP_NAME = /^state-(\d+)\.sqlite$/;

/** TG_BACKUP_ENABLED=1 时每天一份在线备份,保留 TG_BACKUP_KEEP 份(默认 2,只在本机,不做异地拷贝);新备份校验通过并改名成功后才轮转旧的。 */
export async function dailyBackup(db: DatabaseSync, dbPath: string, now = Date.now()): Promise<number | null> {
  if (process.env['TG_BACKUP_ENABLED'] !== '1' || process.env['TG_MAINTENANCE_DRY_RUN'] === '1') return null;
  const dir = path.join(path.dirname(dbPath), 'backups');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stampOf = (name: string): number => Number(BACKUP_NAME.exec(name)![1]);
  const existing = (await readdir(dir)).filter((n) => BACKUP_NAME.test(n)).sort((a, b) => stampOf(b) - stampOf(a));
  const latest = existing[0] ? stampOf(existing[0]) : null;
  if (latest !== null && now - latest < DAY_MS) return latest;

  const need = (await stat(dbPath)).size + ((await stat(`${dbPath}-wal`).catch(() => null))?.size ?? 0);
  const disk = await statfs(dir);
  if (disk.bavail * disk.bsize < need * 2 + 1024 ** 3) throw new Error('backup_insufficient_disk');

  const target = path.join(dir, `state-${now}.sqlite`);
  const temporary = `${target}.tmp`;
  const cleanTemporary = async (): Promise<void> => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(temporary + suffix, { force: true });
  };
  try {
    await backup(db, temporary, { rate: 256 });
    // 备份文件沿用源库的 WAL 模式;先切回 DELETE 再校验,关闭后不留 -wal/-shm。
    const check = new DatabaseSync(temporary);
    try {
      check.exec('PRAGMA journal_mode=DELETE');
      const result = Object.values(check.prepare('PRAGMA quick_check').get() ?? {})[0];
      if (result !== 'ok') throw new Error('backup_integrity_failed');
    } finally {
      check.close();
    }
    await rename(temporary, target);
  } finally {
    await cleanTemporary();
  }
  const keep = envInt('TG_BACKUP_KEEP', 2, 1, 30);
  for (const old of existing.slice(keep - 1)) await rm(path.join(dir, old), { force: true });
  return now;
}
