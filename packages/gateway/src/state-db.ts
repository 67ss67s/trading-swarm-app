// state.sqlite — gateway's own database (docs/contracts/README.md §9). Only this process opens
// it (exec.sqlite is execd's, on the other side of the UDS boundary). A0 scope: schema + a
// migrator + the three smallest DAOs (events, kv) actually needed to bridge exec.event
// notifications into this table — everything else in §9's table list exists as schema only,
// no business writes yet.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, 'migrations');

export type EventSource = 'gateway' | 'execd';

export interface AppendEventInput {
  market?: 'perp' | 'spot' | null;
  event: string;
  at: number;
  source: EventSource;
  /** The execd events.json `seq` this bridges, if `source: 'execd'`. */
  execSeq?: number | null;
  json: string;
}

export interface EventRow {
  market: 'perp' | 'spot' | null;
  seq: number;
  event: string;
  at: number;
  source: EventSource;
  exec_seq: number | null;
  json: string;
}

export interface StateDb {
  readonly db: DatabaseSync;
  /** Inserts one row into `events`; returns its `seq`. */
  appendEvent(input: AppendEventInput): number;
  /** Rows with `seq > since`, oldest first, capped at `limit` (default 500). */
  eventsSince(since: number, limit?: number): EventRow[];
  kvGet(key: string): string | undefined;
  kvSet(key: string, value: string, updatedAt?: number): void;
  close(): void;
}

interface MigrationFile {
  version: string;
  path: string;
}

function listMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), path: path.join(MIGRATIONS_DIR, f) }));
}

/**
 * Applies every migration in src/migrations/ not yet recorded in `schema_migrations`, each inside
 * its own transaction, in filename order. Idempotent: re-running skips whatever's already applied
 * (including "all of them", the common case).
 */
function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version),
  );
  const recordApplied = db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');

  for (const migration of listMigrations()) {
    if (applied.has(migration.version)) continue;
    const sql = readFileSync(migration.path, 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      recordApplied.run(migration.version, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`state-db: migration "${migration.version}" failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  }
}

/** Opens (creating + migrating if needed) the gateway's state.sqlite at `dbPath`. */
export function openStateDb(dbPath: string): StateDb {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);

  const insertEvent = db.prepare('INSERT INTO events(event, at, source, exec_seq, json, market) VALUES (?, ?, ?, ?, ?, ?)');
  const selectEventsSince = db.prepare(
    'SELECT seq, event, at, source, exec_seq, json, market FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
  );
  const selectKv = db.prepare('SELECT value FROM kv WHERE key = ?');
  const upsertKv = db.prepare(
    'INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );

  return {
    db,
    appendEvent(input) {
      const result = insertEvent.run(input.event, input.at, input.source, input.execSeq ?? null, input.json, input.market ?? null);
      return Number(result.lastInsertRowid);
    },
    eventsSince(since, limit = 500) {
      return selectEventsSince.all(since, limit) as unknown as EventRow[];
    },
    kvGet(key) {
      const row = selectKv.get(key) as { value: string } | undefined;
      return row?.value;
    },
    kvSet(key, value, updatedAt = Date.now()) {
      upsertKv.run(key, value, updatedAt);
    },
    close() {
      db.close();
    },
  };
}
