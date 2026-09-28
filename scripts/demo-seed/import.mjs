#!/usr/bin/env node
// Load the demo seed into a gateway state database. Safe to run on every start: rows that already exist are skipped.
//   node scripts/demo-seed/import.mjs --db <state.sqlite> --seed scripts/demo-seed/seed.json [--dry-run] [--strict] [--quiet] [--decision-connection <id>]
// Run it while the gateway is stopped, on a database the gateway has already created (it applies the migrations).
// Semantics: one transaction for the whole seed (BEGIN IMMEDIATE); any error other than a conflict rolls everything back.
//   Rows are matched on their primary key: present and identical = skipped; present but different, or hitting a unique key = conflict
//   (reported and skipped, the target row is never overwritten); --strict turns conflicts into a rollback.
// Exit codes: 0 ok (also dry-run); 1 argument / seed error or import error (rolled back); 2 database missing or schema incompatible (nothing written);
//   3 conflicts under --strict (rolled back).
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { FORMAT_VERSION, TABLES, columnsOf, migrationsOf, parseArgs, sameValue } from './lib.mjs';

const die = (code, msg) => { process.stderr.write(`demo-seed: ${msg}\n`); process.exit(code); };
let args;
try { args = parseArgs(process.argv.slice(2), [], ['dry-run', 'strict', 'quiet']); } catch (e) { die(1, e.message); }
if (!args.db || !args.seed) die(1, 'usage: import.mjs --db <state.sqlite> --seed <seed.json> [--dry-run] [--strict] [--quiet] [--decision-connection <id>]');
if (!existsSync(args.db)) die(2, `database not found: ${args.db} (start the gateway once so it creates the database, stop it, then import)`);
let seed;
try { seed = JSON.parse(readFileSync(args.seed, 'utf8')); } catch (e) { die(1, `seed unreadable: ${e.message}`); }
if (seed.format_version !== FORMAT_VERSION) die(1, `format_version mismatch: seed=${seed.format_version} importer=${FORMAT_VERSION}`);
const out = (s) => process.stdout.write(`${s}\n`);
const say = (s) => { if (!args.quiet) out(s); };

const db = new DatabaseSync(args.db);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

// ---------------------------------------------------------------- compatibility (read-only)
const target = migrationsOf(db);
if (!target) { db.close(); die(2, 'incompatible: the database has no schema_migrations table (not created by the gateway?)'); }
const tgt = new Set(target);
const problems = [];
const missingRequired = (seed.required_migrations ?? []).filter((m) => !tgt.has(m));
if (missingRequired.length) problems.push(`missing migrations the seed depends on: ${missingRequired.join(', ')}`);
const active = TABLES.filter((t) => (seed.tables?.[t.name] ?? []).length);
for (const t of active) {
  const tc = columnsOf(db, t.name);
  if (!tc.length) { problems.push(`missing table ${t.name}`); continue; }
  const names = new Set(tc.map((c) => c.name)), seedCols = (seed.columns?.[t.name] ?? []).filter((c) => !(t.auto_seq && c === 'seq'));
  const missing = seedCols.filter((c) => !names.has(c));
  if (missing.length) problems.push(`${t.name}: missing columns ${missing.join(',')}`);
  const need = tc.filter((c) => Number(c.nn) && c.dflt === null && !Number(c.pk) && !seedCols.includes(c.name)).map((c) => c.name);
  if (need.length) problems.push(`${t.name}: required columns the seed does not carry: ${need.join(',')}`);
}
if (problems.length) { db.close(); die(2, `incompatible, nothing imported:\n  ${problems.join('\n  ')}`); }

// ---------------------------------------------------------------- model connection placeholders → the target's decision connection
const PLACEHOLDER = /mc_redacted_\d+/g;
const placeholders = new Set();
const scanPh = (x) => { if (typeof x === 'string') { for (const m of x.match(PLACEHOLDER) ?? []) placeholders.add(m); } else if (x && typeof x === 'object') Object.values(x).forEach(scanPh); };
scanPh(seed.tables);
let remapTo = null;
if (placeholders.size) {
  const hasTable = (n) => !!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(n);
  if (args['decision-connection']) remapTo = String(args['decision-connection']);
  else if (hasTable('model_role_bindings')) {
    const rows = db.prepare("SELECT connection_id FROM model_role_bindings WHERE role = 'decision'").all();
    if (rows.length === 1) remapTo = String(rows[0].connection_id);
  }
  if (remapTo && hasTable('model_connections') && !db.prepare('SELECT 1 AS ok FROM model_connections WHERE id = ?').get(remapTo)) { db.close(); die(2, `decision connection not found: ${remapTo}`); }
  say(remapTo ? `model connection placeholders ${[...placeholders].join(', ')} -> ${remapTo}` : `model connection placeholders ${[...placeholders].join(', ')} kept (no single decision connection in the target)`);
}
if (remapTo) for (const rows of Object.values(seed.tables)) for (const r of rows) for (const k of Object.keys(r)) if (typeof r[k] === 'string') r[k] = r[k].replace(PLACEHOLDER, remapTo);

// ---------------------------------------------------------------- import
const stats = [], conflicts = [];
const quote = (c) => `"${c}"`;
const cond = (cols) => cols.map((c) => `${quote(c)} IS ?`).join(' AND ');
const v = (x) => (x === undefined ? null : x);
db.exec('BEGIN IMMEDIATE');
try {
  for (const t of active) {
    const rows = seed.tables[t.name], cols = (seed.columns[t.name] ?? Object.keys(rows[0] ?? {})).filter((c) => !(t.auto_seq && c === 'seq'));
    const st = { table: t.name, rows: rows.length, inserted: 0, skipped: 0, conflict: 0 };
    stats.push(st);
    const ins = db.prepare(`INSERT INTO ${t.name}(${cols.map(quote).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    if (t.auto_seq) {
      // event tables: the target assigns seq; count identical events on the natural key and only add the difference
      const cnt = db.prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${cond(t.natural)}`);
      const groups = new Map();
      for (const r of rows) { const k = JSON.stringify(t.natural.map((c) => v(r[c]))); const g = groups.get(k) ?? { rows: [], key: t.natural.map((c) => v(r[c])) }; g.rows.push(r); groups.set(k, g); }
      for (const g of groups.values()) {
        const have = Number(cnt.get(...g.key).n);
        g.rows.forEach((r, i) => { if (i < have) { st.skipped++; return; } ins.run(...cols.map((c) => v(r[c]))); st.inserted++; });
      }
      continue;
    }
    const get = db.prepare(`SELECT ${cols.map(quote).join(',')} FROM ${t.name} WHERE ${t.pk.map((c) => `${quote(c)} = ?`).join(' AND ')}`);
    for (const r of rows) {
      const cur = get.get(...t.pk.map((c) => v(r[c])));
      if (cur) {
        const diff = cols.filter((c) => !sameValue(cur[c], v(r[c])));
        if (!diff.length) { st.skipped++; continue; }
        // the gateway may have touched a seeded row since the last import (status, timestamps, summaries): keep its version
        st.conflict++; conflicts.push({ table: t.name, key: t.pk.map((c) => r[c]).join('|'), reason: `already present with different values (${diff.slice(0, 6).join(',')}${diff.length > 6 ? ',...' : ''}); kept the existing row` });
        continue;
      }
      try { ins.run(...cols.map((c) => v(r[c]))); st.inserted++; }
      catch (e) {
        const msg = String(e?.message ?? e);
        if (/UNIQUE constraint failed/i.test(msg)) { st.conflict++; conflicts.push({ table: t.name, key: t.pk.map((c) => r[c]).join('|'), reason: `unique key clash (${msg.replace(/^.*UNIQUE constraint failed:\s*/i, '')}); skipped` }); continue; }
        throw Object.assign(new Error(`${t.name}[${t.pk.map((c) => r[c]).join('|')}]: ${msg}`), { cause: e });
      }
    }
  }
  if (conflicts.length && args.strict) throw Object.assign(new Error(`--strict: ${conflicts.length} conflicts`), { strict: true });
  db.exec(args['dry-run'] ? 'ROLLBACK' : 'COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
  printStats(true);
  db.close();
  die(e.strict ? 3 : 1, `import failed, rolled back, database unchanged: ${e.message}`);
}
printStats(false);
if (args['dry-run']) out('dry run: transaction rolled back, database unchanged');
db.close();

function printStats(verbose) {
  const tot = stats.reduce((a, s) => ({ rows: a.rows + s.rows, inserted: a.inserted + s.inserted, skipped: a.skipped + s.skipped, conflict: a.conflict + s.conflict }), { rows: 0, inserted: 0, skipped: 0, conflict: 0 });
  if (args.quiet && !verbose) { out(`demo seed: ${tot.inserted} rows added, ${tot.skipped} already present${tot.conflict ? `, ${tot.conflict} kept as they are` : ''}`); return; }
  out(`${'table'.padEnd(30)} ${'rows'.padStart(7)} ${'inserted'.padStart(9)} ${'skipped'.padStart(8)} ${'conflict'.padStart(9)}`);
  for (const s of stats) out(`${s.table.padEnd(30)} ${String(s.rows).padStart(7)} ${String(s.inserted).padStart(9)} ${String(s.skipped).padStart(8)} ${String(s.conflict).padStart(9)}`);
  out(`${'TOTAL'.padEnd(30)} ${String(tot.rows).padStart(7)} ${String(tot.inserted).padStart(9)} ${String(tot.skipped).padStart(8)} ${String(tot.conflict).padStart(9)}`);
  for (const c of conflicts.slice(0, 50)) out(`conflict: ${c.table} ${c.key}: ${c.reason}`);
  if (conflicts.length > 50) out(`conflict: ... ${conflicts.length - 50} more`);
}
