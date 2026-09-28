#!/usr/bin/env node
// Export the demo seed from a state database (opened read-only). See README.md in this directory.
//   node scripts/demo-seed/export.mjs --db <copy of state.sqlite> --strategy rs_a [--strategy rs_b ...] [--session <research session id> ...]
//        [--study ms_x ...] [--translations <json>] [--deny <file>] [--allow-cjk] [--migrations-dir <dir>] --out scripts/demo-seed/seed.json
// Exit codes: 0 ok; 1 argument / read error; 2 unknown id or incomplete study; 4 leak gate; 5 text still contains CJK after translation.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMAT_VERSION, TABLES, collectCjk, columnsOf, jsonSafe, leakCheck, makeSanitizer, migrationsOf, parseArgs, requiredMigrations, translateTables } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const die = (code, msg) => { process.stderr.write(`export: ${msg}\n`); process.exit(code); };

let args;
try { args = parseArgs(process.argv.slice(2), ['study', 'strategy', 'session'], ['allow-cjk']); } catch (e) { die(1, e.message); }
if (!args.db || !args.out || (!args.strategy.length && !args.session.length && !args.study.length)) die(1, 'usage: export.mjs --db <sqlite> [--strategy <rs_id> ...] [--session <id> ...] [--study <ms_id> ...] [--translations <json>] [--allow-cjk] --out <seed.json>');
if (!existsSync(args.db)) die(1, `db_not_found:${args.db}`);
const wal = `${args.db}-wal`;
if (existsSync(wal) && statSync(wal).size > 0) process.stderr.write('export: warning: the source has a non-empty -wal file (a live database?); prefer sqlite3 <src> "VACUUM INTO \'<copy>\'" and export the copy. This script only opens it read-only.\n');

const db = new DatabaseSync(args.db, { readOnly: true });
const studies = [...new Set(args.study)], strategies = [...new Set(args.strategy)], sessions = [...new Set(args.session)];
const J = (a) => JSON.stringify(a);
const warnings = [];
const parse = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };

// ---------------------------------------------------------------- id checks
const studyRows = db.prepare('SELECT id,status,stage FROM research_matrix_studies WHERE id IN (SELECT value FROM json_each(?))').all(J(studies));
const missing = [
  ...studies.filter((s) => !studyRows.some((r) => r.id === s)).map((s) => `study:${s}`),
  ...strategies.filter((s) => !db.prepare('SELECT 1 AS ok FROM research_strategies WHERE id=?').get(s)).map((s) => `strategy:${s}`),
  ...sessions.filter((s) => !db.prepare('SELECT 1 AS ok FROM research_sessions WHERE id=?').get(s)).map((s) => `session:${s}`),
];
if (missing.length) die(2, `not_found:${missing.join(',')}`);
const incomplete = studyRows.filter((r) => r.status !== 'completed');
if (incomplete.length) die(2, `study_not_completed:${incomplete.map((r) => `${r.id}(status=${r.status},stage=${r.stage})`).join(',')}`);

// ---------------------------------------------------------------- row selection
const cols = Object.fromEntries(TABLES.map((t) => [t.name, columnsOf(db, t.name).map((c) => c.name)]));
const noTable = TABLES.filter((t) => !cols[t.name].length).map((t) => t.name);
if (noTable.length) die(1, `source_missing_tables:${noTable.join(',')}`);
const sel = (t, where, ...params) => db.prepare(`SELECT ${cols[t].map((c) => `"${c}"`).join(',')} FROM ${t} WHERE ${where}${TABLES.find((x) => x.name === t).auto_seq ? ' ORDER BY seq' : ''}`).all(...params);
const IN = (col) => `${col} IN (SELECT value FROM json_each(?))`;
const raw = {};
const S = J(studies), R = J(strategies), C = J(sessions);

// matrix studies (optional)
raw.research_matrix_studies = sel('research_matrix_studies', IN('id'), S);
for (const t of ['research_study_cells', 'research_study_trials', 'research_study_evaluations', 'research_study_attempts', 'research_holdout_releases', 'research_data_exposures', 'research_study_events', 'research_study_candidates']) raw[t] = sel(t, IN('study_id'), S);
raw.research_call_budgets = sel('research_call_budgets', IN('id'), J(studies.map((s) => `matrix:${s}`)));
const decisionIds = [...new Set(raw.research_study_candidates.map((r) => parse(r.decision_json ?? 'null')?.decision_id).filter(Boolean))];
raw.research_judge_decisions = sel('research_judge_decisions', IN('decision_id'), J(decisionIds));

// research chats
raw.research_sessions = sel('research_sessions', IN('id'), C);
raw.research_messages = sel('research_messages', `${IN('session_id')} ORDER BY session_id, seq`, C);
raw.research_inquiries = sel('research_inquiries', IN('session_id'), C);
const live = raw.research_inquiries.filter((q) => !['completed', 'cancelled', 'failed', 'incomplete'].includes(q.status));
if (live.length) die(2, `inquiry_still_running:${live.map((q) => `${q.id}(${q.status})`).join(',')}`);
const inquiryIds = raw.research_inquiries.map((q) => q.id);
raw.research_steps = sel('research_steps', IN('inquiry_id'), J(inquiryIds));
raw.research_artifacts = sel('research_artifacts', IN('inquiry_id'), J(inquiryIds));

// what the chats point at: artifacts, snapshots, backtest runs, backtest reports
const refs = { artifacts: new Set(), snapshots: new Set(), runs: new Set(), reports: new Set() };
const scan = (v) => {
  if (Array.isArray(v)) return v.forEach(scan);
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (k === 'artifact_id' && typeof x === 'string') refs.artifacts.add(x);
    if (k === 'run_id' && typeof x === 'string') refs.runs.add(x);
    if (k === 'report_id' && typeof x === 'string') refs.reports.add(x);
    if (k === 'snapshot_refs' && Array.isArray(x)) x.forEach((y) => typeof y === 'string' && refs.snapshots.add(y));
    scan(x);
  }
};
for (const m of raw.research_messages) scan(parse(m.blocks_json, []));
for (const s of raw.research_steps) { scan(parse(s.output_summary_json, {})); scan(parse(s.input_json, {})); for (const x of parse(s.snapshot_refs_json, [])) if (typeof x === 'string') refs.snapshots.add(x); }
for (const a of raw.research_artifacts) { scan(parse(a.content_json, {})); if (a.run_id) refs.runs.add(a.run_id); }
for (const s of raw.research_sessions) scan(parse(s.context_json, {}));
const haveArtifacts = new Set(raw.research_artifacts.map((a) => a.id));
const extraArtifacts = [...refs.artifacts].filter((id) => !haveArtifacts.has(id));
if (extraArtifacts.length) raw.research_artifacts.push(...sel('research_artifacts', IN('id'), J(extraArtifacts)));
for (const a of raw.research_artifacts.filter((x) => extraArtifacts.includes(x.id))) scan(parse(a.content_json, {}));
const lostArtifacts = [...refs.artifacts].filter((id) => !raw.research_artifacts.some((a) => a.id === id));
if (lostArtifacts.length) warnings.push(`artifacts_missing_in_source:${lostArtifacts.length}`);

// strategies
raw.research_strategies = sel('research_strategies', IN('id'), R);
for (const t of ['research_strategy_versions', 'research_strategy_reports', 'research_strategy_events']) raw[t] = sel(t, IN('strategy_id'), R);
for (const v of raw.research_strategy_versions) for (const id of parse(v.run_ids_json, [])) refs.runs.add(id);
const reportIds = [...new Set([...raw.research_strategy_reports.map((r) => r.report_id), ...refs.reports])];
raw.research_backtests = sel('research_backtests', `${IN('id')} OR ${IN('strategy_id')} OR ${IN('session_id')}`, J(reportIds), R, C);
for (const b of raw.research_backtests) if (b.run_id && (sessions.includes(b.session_id) || strategies.includes(b.strategy_id))) refs.runs.add(b.run_id);
const missingReports = reportIds.filter((id) => !raw.research_backtests.some((b) => b.id === id));
if (missingReports.length) warnings.push(`backtest_reports_missing:${missingReports.join(',')}`);

// backtest runs and their studies / events (datasets are not exported: the gateway pulls market data again)
raw.research_runs = sel('research_runs', IN('id'), J([...refs.runs]));
const lostRuns = [...refs.runs].filter((id) => !raw.research_runs.some((r) => r.id === id));
if (lostRuns.length) warnings.push(`runs_missing_in_source:${lostRuns.length}`);
raw.research_studies = sel('research_studies', IN('id'), J([...new Set(raw.research_runs.map((r) => r.study_id))]));
raw.research_events = sel('research_events', IN('run_id'), J(raw.research_runs.map((r) => r.id)));
raw.research_snapshots = sel('research_snapshots', IN('id'), J([...refs.snapshots]));

// backtests whose strategy is not exported (a chat's own report, say) lose the dangling strategy link
for (const b of raw.research_backtests) {
  if (!b.strategy_id || strategies.includes(b.strategy_id)) continue;
  const j = parse(b.report_json, null);
  if (j && typeof j === 'object') { j.strategy_id = null; j.strategy_version = null; b.report_json = JSON.stringify(j); }
  const sm = parse(b.summary_json, null);
  if (sm && typeof sm === 'object') { sm.strategy_id = null; sm.strategy_version = null; b.summary_json = JSON.stringify(sm); }
  b.strategy_id = null; b.strategy_version = null;
}

// adoptions: only "exported study × exported strategy"
raw.research_matrix_adoptions = sel('research_matrix_adoptions', IN('study_id'), S).filter((a) => strategies.includes(a.strategy_id));

// ---------------------------------------------------------------- scrubbing
const idsFrom = (table, col = 'id') => { try { return db.prepare(`SELECT ${col} AS v FROM ${table}`).all().map((r) => String(r.v)); } catch { return []; } };
const connectionIds = idsFrom('model_connections');
const localIds = [...idsFrom('demo_chat_session'), ...idsFrom('research_sessions'), ...idsFrom('demo_threads'), ...idsFrom('demo_shadow_thread'), ...idsFrom('strategy_runs'), ...idsFrom('research_inquiries')];
const keepIds = [...sessions, ...inquiryIds, ...raw.research_runs.map((r) => r.id)];
const san = makeSanitizer({ connectionIds, localIds, keepIds });
const tables = {};
for (const t of TABLES) tables[t.name] = raw[t.name].map((r) => san.row(t.name, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, jsonSafe(v)]))));

// ---------------------------------------------------------------- translation (the gateway writes research text in Chinese)
let translated = 0;
if (args.translations) translated = translateTables(tables, JSON.parse(readFileSync(args.translations, 'utf8')));
const cjk = collectCjk(tables);
if (cjk.size) {
  const list = [...cjk.entries()].sort((a, b) => b[1].n - a[1].n);
  const dump = `${path.resolve(args.out)}.cjk.json`;
  writeFileSync(dump, JSON.stringify(list.map(([tpl, e]) => ({ n: e.n, template: tpl, example: e.example })), null, 1));
  if (!args['allow-cjk']) die(5, `${cjk.size} distinct strings still contain CJK (written to ${dump}); add them to --translations or pass --allow-cjk`);
  warnings.push(`cjk_left:${cjk.size} distinct strings (see ${dump})`);
}

// --deny <file>: one word or regex per line (people, private services, private ports); matched case-insensitively on string values
const denyLines = args.deny ? readFileSync(args.deny, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
const extraDeny = denyLines.length ? new RegExp(denyLines.join('|'), 'i') : null;
const leaks = leakCheck(tables, san.redacted, extraDeny);
if (leaks.length) die(4, `leak_gate: ${leaks.length} fields still carry local values; first 20:\n${leaks.slice(0, 20).map((l) => `  ${l.table}[${l.row}].${l.column}: ${l.reasons.join(',')}`).join('\n')}`);

// ---------------------------------------------------------------- migrations
const migrations = migrationsOf(db);
if (!migrations) die(1, 'source_has_no_schema_migrations');
const migDir = args['migrations-dir'] ?? path.resolve(HERE, '../../packages/gateway/src/migrations');
let required = requiredMigrations(migDir, TABLES.filter((t) => tables[t.name].length).map((t) => t.name));
if (!required) die(1, `migrations_dir_not_found:${migDir}`);
required = required.filter((m) => migrations.includes(m));

const counts = Object.fromEntries(TABLES.map((t) => [t.name, tables[t.name].length]));
const seed = {
  format_version: FORMAT_VERSION,
  exported_at: Date.now(),
  generator: 'scripts/demo-seed/export.mjs',
  migrations,
  required_migrations: required,
  columns: Object.fromEntries(TABLES.map((t) => [t.name, cols[t.name]])),
  source: {
    strategies: tables.research_strategies.map((r) => ({ id: r.id, name: r.name, current_version: Number(r.current_version) })),
    sessions: tables.research_sessions.map((r) => ({ id: r.id, title: r.title })),
    studies: studies,
  },
  sanitized: san.report(),
  warnings,
  counts,
  tables,
};
mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(seed)}\n`);

const bytes = statSync(args.out).size;
process.stdout.write(`seed → ${args.out} (${(bytes / 1048576).toFixed(2)} MB, ${translated} strings translated)\n`);
for (const t of TABLES) if (counts[t.name]) process.stdout.write(`  ${t.name.padEnd(30)} ${String(counts[t.name]).padStart(7)}\n`);
process.stdout.write(`sanitized: ${seed.sanitized.length} rules hit, ${seed.sanitized.reduce((a, s) => a + s.count, 0)} places\n`);
for (const s of seed.sanitized) process.stdout.write(`  ${s.table}.${s.column}${s.path ?? ''}  ${s.rule}  x${s.count}\n`);
for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
db.close();
