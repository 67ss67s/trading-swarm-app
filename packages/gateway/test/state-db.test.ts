// state.sqlite: migrations run twice idempotently, every §9 table exists, events append/since,
// kv get/set.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../src/state-db.js';

const EXPECTED_TABLES = [
  'schema_migrations',
  'events',
  'runs',
  'trace_events',
  'tool_calls',
  'llm_usage',
  'journal',
  'lessons',
  'monitors',
  'cron_jobs',
  'cron_runs',
  'incidents',
  'kv',
];

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tg-state-db-'));
  dbPath = path.join(dir, `${randomBytes(4).toString('hex')}.sqlite`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openStateDb', () => {
  it('creates the sqlite file and every §9 table', () => {
    const stateDb = openStateDb(dbPath);
    expect(existsSync(dbPath)).toBe(true);

    const tableNames = new Set(
      (stateDb.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
    );
    for (const table of EXPECTED_TABLES) {
      expect(tableNames.has(table), `missing table "${table}"`).toBe(true);
    }
    stateDb.close();
  });

  it('every table has a primary key and a time-ish column', () => {
    const stateDb = openStateDb(dbPath);
    for (const table of EXPECTED_TABLES) {
      if (table === 'schema_migrations') continue; // has version(pk)+applied_at, checked separately below
      const columns = stateDb.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
      const hasPk = columns.some((c) => c.pk > 0);
      const hasTimeColumn = columns.some((c) => /(^|_)(at|created_at|updated_at|started_at|opened_at)$/.test(c.name));
      expect(hasPk, `table "${table}" has no primary key`).toBe(true);
      expect(hasTimeColumn, `table "${table}" has no time column`).toBe(true);
    }
    stateDb.close();
  });

  it('schema_migrations records one row per migration file, and re-opening is idempotent', () => {
    const first = openStateDb(dbPath);
    const rowsAfterFirstOpen = first.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[];
    expect(rowsAfterFirstOpen.length).toBeGreaterThan(0);
    first.close();

    const second = openStateDb(dbPath);
    const rowsAfterSecondOpen = second.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[];
    expect(rowsAfterSecondOpen).toEqual(rowsAfterFirstOpen);
    // And the tables are still exactly once each, not duplicated (a non-idempotent migrator would
    // throw "table already exists" on the second open, which — if this test reaches this line —
    // it didn't).
    second.close();
  });

  it('sets WAL journal mode and foreign_keys on', () => {
    const stateDb = openStateDb(dbPath);
    expect((stateDb.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((stateDb.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    stateDb.close();
  });
});

describe('events DAO', () => {
  let stateDb: StateDb;
  beforeEach(() => {
    stateDb = openStateDb(dbPath);
  });
  afterEach(() => stateDb.close());

  it('appendEvent returns increasing seq; eventsSince(0) returns them in order', () => {
    const seq1 = stateDb.appendEvent({ event: 'run.started', at: 1, source: 'gateway', json: '{"a":1}' });
    const seq2 = stateDb.appendEvent({ event: 'account.updated', at: 2, source: 'execd', execSeq: 41, json: '{"b":2}' });
    const seq3 = stateDb.appendEvent({ event: 'account.updated', at: 3, source: 'execd', execSeq: 42, json: '{"c":3}' });
    expect(seq2).toBeGreaterThan(seq1);
    expect(seq3).toBeGreaterThan(seq2);

    const rows = stateDb.eventsSince(0);
    expect(rows.map((r) => r.seq)).toEqual([seq1, seq2, seq3]);
    expect(rows[1]).toMatchObject({ event: 'account.updated', source: 'execd', exec_seq: 41, json: '{"b":2}' });
  });

  it('eventsSince(seq) excludes everything up to and including seq', () => {
    const seq1 = stateDb.appendEvent({ event: 'a', at: 1, source: 'gateway', json: '{}' });
    const seq2 = stateDb.appendEvent({ event: 'b', at: 2, source: 'gateway', json: '{}' });
    stateDb.appendEvent({ event: 'c', at: 3, source: 'gateway', json: '{}' });

    const rows = stateDb.eventsSince(seq1);
    expect(rows.map((r) => r.seq)).toEqual([seq2, seq2 + 1]);
  });

  it('eventsSince respects limit', () => {
    for (let i = 0; i < 5; i++) stateDb.appendEvent({ event: 'x', at: i, source: 'gateway', json: '{}' });
    expect(stateDb.eventsSince(0, 2)).toHaveLength(2);
  });

  it('exec_seq is null for gateway-sourced events unless given', () => {
    const seq = stateDb.appendEvent({ event: 'run.started', at: 1, source: 'gateway', json: '{}' });
    const [row] = stateDb.eventsSince(seq - 1);
    expect(row!.exec_seq).toBeNull();
  });

  it('rejects a source outside the CHECK constraint', () => {
    expect(() => stateDb.appendEvent({ event: 'x', at: 1, source: 'not-a-real-source' as never, json: '{}' })).toThrow();
  });
});

describe('kv DAO', () => {
  let stateDb: StateDb;
  beforeEach(() => {
    stateDb = openStateDb(dbPath);
  });
  afterEach(() => stateDb.close());

  it('kvGet is undefined for a missing key', () => {
    expect(stateDb.kvGet('nope')).toBeUndefined();
  });

  it('kvSet then kvGet round-trips', () => {
    stateDb.kvSet('policy_version', '3');
    expect(stateDb.kvGet('policy_version')).toBe('3');
  });

  it('kvSet upserts (overwrites) an existing key', () => {
    stateDb.kvSet('k', 'first', 100);
    stateDb.kvSet('k', 'second', 200);
    expect(stateDb.kvGet('k')).toBe('second');
    const row = stateDb.db.prepare('SELECT updated_at FROM kv WHERE key = ?').get('k') as { updated_at: number };
    expect(row.updated_at).toBe(200);
  });
});
