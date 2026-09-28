/**
 * Geometry Lab persistence: its own sqlite (never the live demo DBs). The frozen 1h datasets are COPIED in
 * once from the OKX demo DB (`research_datasets`, opened read-only) so a rerun never depends on live state.
 */
import { realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArmRow, Bar, Candidate, Geometry, Settlement } from './core.js';
import type { CallLogEntry } from './model-arms.js';

const LIVE_DBS = [join(homedir(), '.trade-gate/demo/state.sqlite'), join(homedir(), '.trade-gate-okx/demo/state.sqlite')];

export function refuseLiveDb(path: string): void {
  const real = existsSync(path) ? realpathSync(path) : resolve(path);
  for (const live of LIVE_DBS) {
    const l = existsSync(live) ? realpathSync(live) : live;
    if (real === l) throw new Error(`refusing to write a live DB: ${path}`);
  }
}

export interface DatasetRow {
  symbol: string;
  source_id: string;
  source: string;
  bars: Bar[];
}

export class LabStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    refuseLiveDb(path);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (symbol TEXT PRIMARY KEY, source_id TEXT NOT NULL, source TEXT NOT NULL, first_open INTEGER NOT NULL, last_close INTEGER NOT NULL, n INTEGER NOT NULL, bars_json TEXT NOT NULL, imported_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, as_of INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS arm_results (candidate_id TEXT NOT NULL, arm TEXT NOT NULL, geometry_json TEXT NOT NULL, plan_json TEXT NOT NULL, trail_json TEXT NOT NULL, calls INTEGER NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, latency_ms INTEGER NOT NULL, cost_cny REAL NOT NULL, extra_json TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (candidate_id, arm));
      CREATE TABLE IF NOT EXISTS model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL, arm TEXT NOT NULL, turn INTEGER NOT NULL, system_hash TEXT NOT NULL, user_text TEXT NOT NULL, output_text TEXT, error TEXT, latency_ms INTEGER NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, created_at INTEGER NOT NULL);
    `);
    // `model` labels which brain produced a row (null = code / pre-label rows); added in place on older lab DBs.
    for (const t of ['arm_results', 'model_calls']) {
      const cols = (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('model')) this.db.exec(`ALTER TABLE ${t} ADD COLUMN model TEXT`);
    }
  }

  /** Copy the newest full 1h dataset per symbol out of the OKX demo DB (opened read-only). */
  importFrom(sourceDb: string, symbols: string[], minBars = 2000): DatasetRow[] {
    const src = new DatabaseSync(sourceDb, { readOnly: true });
    const got: DatasetRow[] = [];
    try {
      for (const symbol of symbols) {
        const row = src
          .prepare(`SELECT id, json FROM research_datasets WHERE json_extract(json,'$.symbol')=? AND json_extract(json,'$.timeframe_ms')=3600000 AND json_array_length(json_extract(json,'$.bars'))>=? ORDER BY created_at DESC LIMIT 1`)
          .get(symbol, minBars) as { id: string; json: string } | undefined;
        if (!row) continue;
        const d = JSON.parse(row.json) as { source: string; bars: Bar[] };
        const bars = d.bars;
        for (let i = 1; i < bars.length; i++) if (bars[i]!.open_time <= bars[i - 1]!.open_time) throw new Error(`${symbol}: bars not ascending at ${i}`);
        this.db
          .prepare('INSERT OR REPLACE INTO datasets VALUES (?,?,?,?,?,?,?,?)')
          .run(symbol, row.id, d.source, bars[0]!.open_time, bars.at(-1)!.close_time, bars.length, JSON.stringify(bars), Date.now());
        got.push({ symbol, source_id: row.id, source: d.source, bars });
      }
    } finally {
      src.close();
    }
    return got;
  }

  datasets(): DatasetRow[] {
    return (this.db.prepare('SELECT symbol, source_id, source, bars_json FROM datasets ORDER BY symbol').all() as { symbol: string; source_id: string; source: string; bars_json: string }[]).map((r) => ({ symbol: r.symbol, source_id: r.source_id, source: r.source, bars: JSON.parse(r.bars_json) as Bar[] }));
  }

  /** run-a rebuilds the candidate set; refuses once model-arm rows exist (they would be orphaned). */
  resetCandidates(): void {
    const n = Number((this.db.prepare("SELECT COUNT(*) AS n FROM arm_results WHERE arm <> 'A'").get() as { n: number }).n);
    if (n > 0) throw new Error(`refusing to rebuild candidates: ${n} model-arm rows exist`);
    this.db.exec("DELETE FROM candidates; DELETE FROM arm_results WHERE arm = 'A';");
  }

  putCandidates(cs: Candidate[]): void {
    const st = this.db.prepare('INSERT OR REPLACE INTO candidates VALUES (?,?,?,?)');
    for (const c of cs) st.run(c.id, c.symbol, c.as_of, JSON.stringify(c));
  }

  candidates(): Candidate[] {
    return (this.db.prepare('SELECT json FROM candidates ORDER BY as_of, id').all() as { json: string }[]).map((r) => JSON.parse(r.json) as Candidate);
  }

  putArm(c: Candidate, arm: string, g: Geometry, plan: Settlement, trail: Settlement, meter: { calls: number; in_tok: number; out_tok: number; latency_ms: number; cost_cny: number }, extra: unknown = null, model: string | null = null): void {
    this.db
      .prepare('INSERT OR REPLACE INTO arm_results (candidate_id, arm, geometry_json, plan_json, trail_json, calls, in_tok, out_tok, latency_ms, cost_cny, extra_json, created_at, model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(c.id, arm, JSON.stringify(g), JSON.stringify(plan), JSON.stringify(trail), meter.calls, meter.in_tok, meter.out_tok, meter.latency_ms, meter.cost_cny, extra === null ? null : JSON.stringify(extra), Date.now(), model);
  }

  /** rows per arm × model label, for the report header */
  armModels(): { arm: string; model: string | null; n: number }[] {
    return this.db.prepare('SELECT arm, model, COUNT(*) AS n FROM arm_results GROUP BY arm, model ORDER BY arm, model').all() as { arm: string; model: string | null; n: number }[];
  }

  hasArm(id: string, arm: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM arm_results WHERE candidate_id=? AND arm=?').get(id, arm);
  }

  armRows(arm: string): ArmRow[] {
    const cands = new Map(this.candidates().map((c) => [c.id, c]));
    return (this.db.prepare('SELECT * FROM arm_results WHERE arm=? ORDER BY candidate_id').all(arm) as Record<string, unknown>[]).flatMap((r) => {
      const c = cands.get(String(r['candidate_id']));
      if (!c) return [];
      return [{ id: c.id, arm, ref_close: c.ref_close, atr14: c.atr14, g: JSON.parse(String(r['geometry_json'])) as Geometry, plan: JSON.parse(String(r['plan_json'])) as Settlement, trail: JSON.parse(String(r['trail_json'])) as Settlement, calls: Number(r['calls']), in_tok: Number(r['in_tok']), out_tok: Number(r['out_tok']), latency_ms: Number(r['latency_ms']), cost_cny: Number(r['cost_cny']) }];
    });
  }

  logCall(candidateId: string, e: CallLogEntry, model: string | null = null): void {
    this.db.prepare('INSERT INTO model_calls (candidate_id, arm, turn, system_hash, user_text, output_text, error, latency_ms, in_tok, out_tok, created_at, model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(candidateId, e.arm, e.turn, e.system_hash, e.user_text, e.output_text, e.error, e.latency_ms, e.in_tok, e.out_tok, Date.now(), model);
  }

  modelCallCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM model_calls').get() as { n: number }).n);
  }

  close(): void {
    this.db.close();
  }
}
