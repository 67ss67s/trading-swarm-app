/**
 * 实验库(独立 sqlite,拒绝写两个现网库)。冻结的东西全在这里:数据快照、资金费、manifest、事件(含结算)、
 * 每事件的提示词原文(system 按哈希去重)、模型原始输出与解析结果。之后的报告与零模型重放只读这个库。
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FrozenSeries, FundingPoint } from './data.js';
import type { Decision, FrozenPrompt, PromptMode } from './judge.js';
import type { Bar, JrEvent, Venue } from './types.js';

const LIVE_DBS = [join(homedir(), '.trade-gate/demo/state.sqlite'), join(homedir(), '.trade-gate-okx/demo/state.sqlite'), join(homedir(), '.trade-gate/research/market-cache.sqlite')];

export const defaultJrDb = (): string => process.env['TG_JR_DB'] ?? join(homedir(), '.trade-gate-okx/research/judgment-replay/jr.sqlite');

export function refuseLiveDb(path: string): void {
  const real = existsSync(path) ? realpathSync(path) : resolve(path);
  for (const live of LIVE_DBS) {
    const l = existsSync(live) ? realpathSync(live) : live;
    if (real === l) throw new Error(`refusing to write a live DB: ${path}`);
  }
}

export interface Manifest {
  id: string;
  created_at: number;
  venue: Venue;
  periods: { id: string; from: number; to: number; label: string }[];
  symbols: string[];
  directions: string[];
  cooldown_bars: number;
  prompt_mode: PromptMode;
  /** 「research prompt,非生产 harness」之类的标注,报告原样打印 */
  prompt_label: string;
  versions: Record<string, string>;
  playbook_sha256: string;
  system_sha256: string[];
  datasets: { symbol: string; source: string; source_id: string; n: number; gaps: number; sha256: string }[];
  funding_sha256: string | null;
  costs: Record<string, number>;
  events: { count: number; sha256: string; drops: Record<string, Record<string, number>> };
  /** 臂 → 冻结的模型标识(第一次跑该臂时写入,之后换模型会被拒) */
  models: Record<string, { model: string; key_note: string; prompt_mode: PromptMode; first_run_at: number }>;
}

export interface EventRow {
  event: JrEvent;
  prompt: FrozenPrompt;
  system_sha256: string;
  user_sha256: string;
}

export interface DecisionRow {
  manifest_id: string;
  event_id: string;
  arm: string;
  model: string;
  prompt_mode: PromptMode;
  raw_text: string | null;
  transport_error: string | null;
  decision: Decision;
  in_tok: number;
  out_tok: number;
  latency_ms: number;
  cost_cny: number;
  created_at: number;
}

export class JrStore {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    refuseLiveDb(path);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS datasets (venue TEXT NOT NULL, symbol TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL, n INTEGER NOT NULL, gaps INTEGER NOT NULL, sha256 TEXT NOT NULL, bars_json TEXT NOT NULL, imported_at INTEGER NOT NULL, PRIMARY KEY (venue, symbol));
      CREATE TABLE IF NOT EXISTS funding (symbol TEXT NOT NULL, at INTEGER NOT NULL, rate TEXT NOT NULL, PRIMARY KEY (symbol, at));
      CREATE TABLE IF NOT EXISTS manifests (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompts (sha256 TEXT PRIMARY KEY, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (manifest_id TEXT NOT NULL, id TEXT NOT NULL, symbol TEXT NOT NULL, period TEXT NOT NULL, as_of INTEGER NOT NULL, event_json TEXT NOT NULL, prompt_json TEXT NOT NULL, system_sha256 TEXT NOT NULL, user_sha256 TEXT NOT NULL, PRIMARY KEY (manifest_id, id));
      CREATE TABLE IF NOT EXISTS decisions (manifest_id TEXT NOT NULL, event_id TEXT NOT NULL, arm TEXT NOT NULL, model TEXT NOT NULL, prompt_mode TEXT NOT NULL, raw_text TEXT, transport_error TEXT, decision_json TEXT NOT NULL, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL, latency_ms INTEGER NOT NULL, cost_cny REAL NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (manifest_id, event_id, arm));
    `);
  }

  close(): void {
    this.db.close();
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  putSeries(s: FrozenSeries): void {
    this.db.prepare('INSERT OR REPLACE INTO datasets VALUES (?,?,?,?,?,?,?,?,?)').run(s.venue, s.symbol, s.source, s.source_id, s.bars.length, s.gaps, s.sha256, JSON.stringify(s.bars), Date.now());
  }

  series(venue: Venue): FrozenSeries[] {
    const rows = this.db.prepare('SELECT * FROM datasets WHERE venue=? ORDER BY symbol').all(venue) as { venue: Venue; symbol: string; source: string; source_id: string; gaps: number; sha256: string; bars_json: string }[];
    return rows.map((r) => ({ venue: r.venue, symbol: r.symbol, source: r.source, source_id: r.source_id, gaps: r.gaps, sha256: r.sha256, bars: JSON.parse(r.bars_json) as Bar[] }));
  }

  putFunding(symbol: string, pts: FundingPoint[]): void {
    const st = this.db.prepare('INSERT OR REPLACE INTO funding VALUES (?,?,?)');
    this.tx(() => {
      for (const p of pts) st.run(symbol, p.at, p.rate);
    });
  }

  funding(symbol: string): FundingPoint[] {
    return (this.db.prepare('SELECT at, rate FROM funding WHERE symbol=? ORDER BY at').all(symbol) as { at: number; rate: string }[]).map((r) => ({ at: r.at, rate: r.rate }));
  }

  manifest(id: string): Manifest | null {
    const r = this.db.prepare('SELECT json FROM manifests WHERE id=?').get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Manifest) : null;
  }

  manifests(): Manifest[] {
    return (this.db.prepare('SELECT json FROM manifests ORDER BY created_at').all() as { json: string }[]).map((r) => JSON.parse(r.json) as Manifest);
  }

  saveManifest(m: Manifest): void {
    this.db.prepare('INSERT OR REPLACE INTO manifests VALUES (?,?,?)').run(m.id, m.created_at, JSON.stringify(m));
  }

  /** 冻结一整套事件;已有模型输出的 manifest 不允许重建。 */
  freeze(m: Manifest, rows: EventRow[], systems: Map<string, string>): void {
    if (this.decisionCount(m.id) > 0) throw new Error(`manifest ${m.id} 已有模型输出,拒绝重建事件`);
    this.tx(() => {
      this.db.prepare('DELETE FROM events WHERE manifest_id=?').run(m.id);
      const ps = this.db.prepare('INSERT OR IGNORE INTO prompts VALUES (?,?)');
      for (const [h, t] of systems) ps.run(h, t);
      const st = this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)');
      for (const r of rows) {
        const { system: _s, ...rest } = r.prompt;
        st.run(m.id, r.event.id, r.event.symbol, r.event.period, r.event.as_of, JSON.stringify(r.event), JSON.stringify(rest), r.system_sha256, r.user_sha256);
      }
      this.db.prepare('INSERT OR REPLACE INTO manifests VALUES (?,?,?)').run(m.id, m.created_at, JSON.stringify(m));
    });
  }

  events(manifestId: string): EventRow[] {
    const sys = new Map<string, string>();
    const rows = this.db.prepare('SELECT event_json, prompt_json, system_sha256, user_sha256 FROM events WHERE manifest_id=? ORDER BY as_of, id').all(manifestId) as { event_json: string; prompt_json: string; system_sha256: string; user_sha256: string }[];
    return rows.map((r) => {
      let system = sys.get(r.system_sha256);
      if (system === undefined) {
        system = (this.db.prepare('SELECT text FROM prompts WHERE sha256=?').get(r.system_sha256) as { text: string } | undefined)?.text ?? '';
        sys.set(r.system_sha256, system);
      }
      return { event: JSON.parse(r.event_json) as JrEvent, prompt: { ...(JSON.parse(r.prompt_json) as Omit<FrozenPrompt, 'system'>), system }, system_sha256: r.system_sha256, user_sha256: r.user_sha256 };
    });
  }

  putDecision(d: DecisionRow): void {
    this.db.prepare('INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(d.manifest_id, d.event_id, d.arm, d.model, d.prompt_mode, d.raw_text, d.transport_error, JSON.stringify(d.decision), d.in_tok, d.out_tok, d.latency_ms, d.cost_cny, d.created_at);
  }

  decisions(manifestId: string, arm?: string): DecisionRow[] {
    const rows = (arm ? this.db.prepare('SELECT * FROM decisions WHERE manifest_id=? AND arm=?').all(manifestId, arm) : this.db.prepare('SELECT * FROM decisions WHERE manifest_id=?').all(manifestId)) as (Omit<DecisionRow, 'decision'> & { decision_json: string })[];
    return rows.map(({ decision_json, ...r }) => ({ ...r, decision: JSON.parse(decision_json) as Decision }));
  }

  decisionCount(manifestId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE manifest_id=?').get(manifestId) as { n: number }).n;
  }

  /** 某个模型在整个实验库里累计的调用数与估算人民币(跨 manifest,硬上限按它算)。 */
  spend(model: string): { calls: number; cny: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cost_cny),0) AS c FROM decisions WHERE model=?').get(model) as { n: number; c: number };
    return { calls: r.n, cny: r.c };
  }
}
