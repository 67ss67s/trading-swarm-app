// Shared logic for the demo seed (export.mjs / import.mjs). Zero dependencies: only node:sqlite (Node 24+).
// Table list, primary keys, scrubbing rules, leak checks and the translation pass live here;
// the two scripts only parse arguments and print results.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const FORMAT_VERSION = 1;

/**
 * Tables in import order (foreign keys and triggers: strategies before versions, studies before runs,
 * sessions before messages before inquiries before steps, matrix trials before holdout releases).
 * pk: the key used to decide "the target already has this row".
 * auto_seq: AUTOINCREMENT event tables; seq is not imported (the target assigns it), rows are matched on `natural`.
 */
export const TABLES = [
  // matrix studies ("scout" step); optional, empty unless the export named --study
  { name: 'research_matrix_studies', pk: ['id'] },
  { name: 'research_study_cells', pk: ['study_id', 'cell_id'] },
  { name: 'research_study_trials', pk: ['trial_id'] },
  { name: 'research_study_evaluations', pk: ['evaluation_id'] },
  { name: 'research_study_attempts', pk: ['attempt_id'] },
  { name: 'research_holdout_releases', pk: ['release_id'] },
  { name: 'research_data_exposures', pk: ['exposure_id'] },
  { name: 'research_study_events', pk: ['seq'], auto_seq: true, natural: ['study_id', 'at', 'stage', 'payload_json'] },
  { name: 'research_study_candidates', pk: ['study_id', 'trial_id', 'segment', 'candidate_id'] },
  { name: 'research_call_budgets', pk: ['id'] },
  { name: 'research_judge_decisions', pk: ['decision_id'] },
  // saved strategies ("My strategies") and their backtest reports
  { name: 'research_strategies', pk: ['id'] },
  { name: 'research_strategy_versions', pk: ['strategy_id', 'version'] },
  { name: 'research_strategy_reports', pk: ['report_id'] },
  { name: 'research_strategy_events', pk: ['seq'], auto_seq: true, natural: ['strategy_id', 'at', 'kind', 'from_status', 'to_status', 'version', 'note'] },
  // backtest runs the research chats point at (the "This step created a backtest" buttons)
  { name: 'research_studies', pk: ['id'] },
  { name: 'research_runs', pk: ['id'] },
  { name: 'research_events', pk: ['seq'], auto_seq: true, natural: ['run_id', 'at', 'event', 'json'] },
  { name: 'research_backtests', pk: ['id'] },
  { name: 'research_matrix_adoptions', pk: ['study_id', 'finalist_id'] },
  // research chats (the Refine / research workbench conversations)
  { name: 'research_sessions', pk: ['id'] },
  { name: 'research_messages', pk: ['id'] },
  { name: 'research_inquiries', pk: ['id'] },
  { name: 'research_steps', pk: ['id'] },
  { name: 'research_snapshots', pk: ['id'] },
  { name: 'research_artifacts', pk: ['id'] },
];
export const TABLE_NAMES = TABLES.map((t) => t.name);
export const tableOf = (name) => TABLES.find((t) => t.name === name);

// ------------------------------------------------------------------ CLI arguments
/** --k v / --k (boolean) / repeatable keys collect into arrays */
export function parseArgs(argv, repeatable = [], booleans = []) {
  const out = {};
  for (const k of repeatable) out[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw Error(`unexpected_argument:${a}`);
    const k = a.slice(2);
    if (booleans.includes(k)) { out[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw Error(`missing_value:--${k}`);
    if (repeatable.includes(k)) out[k].push(v); else out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------ schema / migrations
/** Non-generated columns (generated columns, hidden=2/3, are neither exported nor inserted) */
export function columnsOf(db, table) {
  return db.prepare(`SELECT name, "notnull" AS nn, dflt_value AS dflt, pk, hidden FROM pragma_table_xinfo(?)`).all(table).filter((c) => Number(c.hidden) === 0);
}
export function migrationsOf(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!has) return null;
  return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => String(r.version));
}
/** Migrations in the repo that create / alter / index / add triggers to the given tables = migrations the target must have */
export function requiredMigrations(dir, tables = TABLE_NAMES) {
  if (!dir || !existsSync(dir)) return null;
  const want = new Set(tables), out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    const hit = [...sql.matchAll(/\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|\bON)\s+("?)(\w+)\1/gi)].some((m) => want.has(m[2]));
    if (hit) out.push(f.replace(/\.sql$/, ''));
  }
  return out;
}

// ------------------------------------------------------------------ scrubbing
const isJsonText = (v) => typeof v === 'string' && /^\s*[[{]/.test(v);
const tryParse = (v) => { try { return { ok: true, v: JSON.parse(v) }; } catch { return { ok: false }; } };
const pathStr = (p) => p.map((s) => (typeof s === 'number' ? '[]' : `.${s}`)).join('');

/** JSON keys nulled unless the value is an id the seed itself carries (local session / loop / thread / lease ids) */
export const NULL_KEYS = ['chat_session_id', 'session_id', 'inquiry_id', 'thread_id', 'lease_token'];
/** JSON keys whose arrays keep only ids the seed itself carries (back references to local runs / revisions) */
export const FILTER_ARRAY_KEYS = ['run_ids', 'revision_refs'];

const ABS_PATH = /(?:~\/\.trade-gate[\w.-]*|\/(?:Users|home|private|var\/folders|tmp|Volumes|opt\/homebrew)\/)[^\s"'`()<>,;]*/g;
const ASP_REF = /\basp:\d+(?::[A-Za-z0-9_:.<>-]+)?/g;
const HEX_ADDR = /\b0x[0-9a-fA-F]{16,}\b/g;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SECRET_HINTS = /(sk-[A-Za-z0-9_-]{16,}|"(?:api_?key|secret|passphrase|access_token|refresh_token|private_key)"\s*:\s*"[^"]+")/i;
/** Words that must never appear in a public seed. Project-specific names (people, private services, ports) come from export --deny <file>. */
export const DENY_WORDS = /\bbridge\b|telegram|\blark\b|feishu/i;

/**
 * Scrubber. keepIds: ids of rows the seed carries itself (sessions, inquiries, runs); references to them stay intact.
 * localIds: every other local random id in the source (sessions, threads, runs, inquiries, ...) — replaced anywhere in any string.
 * Model connection ids become mc_redacted_N (the same id maps to the same N).
 */
export function makeSanitizer({ connectionIds = [], localIds = [], keepIds = [] } = {}) {
  const log = new Map(), redacted = new Set(), keep = new Set(keepIds.map(String));
  const note = (table, column, p, rule, n = 1) => { const k = `${table}\u0000${column}\u0000${pathStr(p)}\u0000${rule}`; log.set(k, (log.get(k) ?? 0) + n); };
  const alias = new Map();
  connectionIds.filter(Boolean).sort().forEach((id, i) => alias.set(String(id), `mc_redacted_${i + 1}`));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const connRe = alias.size ? new RegExp([...alias.keys()].sort((a, b) => b.length - a.length).map(esc).join('|'), 'g') : null;
  const local = [...new Set(localIds.map(String))].filter((s) => s.length >= 12 && /[0-9a-f]{8}/i.test(s) && !alias.has(s) && !keep.has(s));
  const localRe = local.length ? new RegExp(local.sort((a, b) => b.length - a.length).map(esc).join('|'), 'g') : null;
  const kept = (v) => typeof v === 'string' && (keep.has(v) || keep.has(v.split(':')[0]));

  function str(s, table, column, p) {
    let out = s;
    // whole references first, ids afterwards: otherwise the run id inside asp:13866:run_x goes first and 13866 slips through
    out = out.replace(ASP_REF, (m) => { note(table, column, p, 'redact:asp_ref'); redacted.add(m); return 'asp:<redacted>'; });
    out = out.replace(HEX_ADDR, (m) => { note(table, column, p, 'redact:hex_address'); redacted.add(m); return '0x<redacted>'; });
    out = out.replace(ABS_PATH, (m) => { note(table, column, p, 'redact:absolute_path'); redacted.add(m); return '<redacted-path>'; });
    out = out.replace(EMAIL, (m) => { note(table, column, p, 'redact:email'); redacted.add(m); return '<redacted-email>'; });
    out = out.replace(IPV4, (m) => { note(table, column, p, 'redact:ipv4'); redacted.add(m); return '<redacted-ip>'; });
    if (connRe) out = out.replace(connRe, (m) => { note(table, column, p, 'alias:model_connection_id'); redacted.add(m); return alias.get(m); });
    if (localRe) out = out.replace(localRe, (m) => { note(table, column, p, 'redact:local_id'); redacted.add(m); return '<redacted-id>'; });
    return out;
  }
  function walk(v, table, column, p) {
    if (Array.isArray(v)) { let ch = false; const o = v.map((x, i) => { const r = walk(x, table, column, [...p, i]); ch ||= r.changed; return r.v; }); return { v: ch ? o : v, changed: ch }; }
    if (v && typeof v === 'object') {
      let ch = false; const o = {};
      for (const [k, x] of Object.entries(v)) {
        const kp = [...p, k];
        if (NULL_KEYS.includes(k) && x !== null && x !== undefined && !kept(x)) { note(table, column, kp, `null:${k}`); if (typeof x === 'string') redacted.add(x); o[k] = null; ch = true; continue; }
        if (FILTER_ARRAY_KEYS.includes(k) && Array.isArray(x) && x.some((y) => !kept(y))) { note(table, column, kp, `filter:${k}`); for (const y of x) if (typeof y === 'string' && !kept(y)) redacted.add(y); o[k] = x.filter(kept); ch = true; continue; }
        const r = walk(x, table, column, kp); o[k] = r.v; ch ||= r.changed;
      }
      return { v: ch ? o : v, changed: ch };
    }
    if (typeof v === 'string') { const s = str(v, table, column, p); return { v: s, changed: s !== v }; }
    return { v, changed: false };
  }
  const filterJsonIds = (s) => { const pr = tryParse(s ?? '[]'); return JSON.stringify(pr.ok && Array.isArray(pr.v) ? pr.v.filter(kept) : []); };
  /** column rules: table → column → { rule, value(row) } */
  const COLUMN_RULES = {
    research_matrix_studies: {
      lease_token: { rule: 'null:worker_lease', value: () => null },
      lease_until: { rule: 'null:worker_lease', value: () => null },
    },
    research_strategies: {
      session_bound: { rule: 'zero:session_binding', value: (r) => (kept(tryParse(r.origin_json ?? '{}').v?.session_id) ? r.session_bound : 0) },
      published_listing_id: { rule: 'null:asp_listing', value: () => null },
    },
    research_strategy_versions: {
      run_ids_json: { rule: 'filter:local_run_refs', value: (r) => filterJsonIds(r.run_ids_json) },
      revision_refs_json: { rule: 'empty:local_revision_refs', value: () => '[]' },
    },
    research_backtests: {
      session_id: { rule: 'null:local_session', value: (r) => (kept(r.session_id) ? r.session_id : null) },
      inquiry_id: { rule: 'null:local_inquiry', value: (r) => (kept(r.inquiry_id) ? r.inquiry_id : null) },
      idempotency_key: { rule: 'null:local_inquiry_step', value: (r) => (kept(r.idempotency_key) ? r.idempotency_key : null) },
      run_id: { rule: 'null:local_run', value: (r) => (kept(r.run_id) ? r.run_id : null) },
    },
    research_study_events: {
      // completed studies have delivered every event; an empty delivered_at would make the gateway push old events again over SSE
      delivered_at: { rule: 'fill:delivered_at=at', value: (row) => row.delivered_at ?? row.at },
    },
  };
  /** row → scrubbed row (untouched JSON columns keep their original text) */
  function row(table, r) {
    const out = { ...r }, rules = COLUMN_RULES[table] ?? {};
    for (const [c, rule] of Object.entries(rules)) {
      if (!(c in out)) continue;
      const nv = rule.value(out);
      if (nv !== out[c]) {
        note(table, c, [], rule.rule);
        if (typeof out[c] === 'string' && out[c].length >= 6 && !rule.rule.startsWith('fill:') && !isJsonText(out[c])) redacted.add(out[c]);
        if (isJsonText(out[c])) { const pr = tryParse(out[c]); if (pr.ok) for (const y of [].concat(pr.v)) if (typeof y === 'string' && !kept(y)) redacted.add(y); }
        out[c] = nv;
      }
    }
    for (const [c, v] of Object.entries(out)) {
      if (typeof v !== 'string') continue;
      if (isJsonText(v)) {
        const pr = tryParse(v);
        if (pr.ok) { const w = walk(pr.v, table, c, []); if (w.changed) out[c] = JSON.stringify(w.v); continue; }
      }
      out[c] = str(v, table, c, []);
    }
    return out;
  }
  function report() {
    return [...log.entries()].map(([k, count]) => { const [table, column, p, rule] = k.split('\u0000'); return { table, column, path: p || null, rule, count }; })
      .sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column) || String(a.path).localeCompare(String(b.path)) || a.rule.localeCompare(b.rule));
  }
  return { row, report, redacted, aliases: alias };
}

/** Last gate before writing the seed: scrubbed values, local paths, ASP refs, addresses, IPs, emails, secrets and denied words must not appear */
export function leakCheck(tables, redacted, extraDeny = null) {
  // only id-like values (≥ 8 chars with a digit); generic words such as 'default' are not leaks
  const needles = [...redacted].filter((s) => typeof s === 'string' && s.length >= 8 && /\d/.test(s) && !/^<redacted/.test(s));
  const hits = [];
  // test string leaves (and keys) of JSON columns, not the raw JSON: numbers such as 18794.5 are not the port 8794
  const leaves = (v) => {
    if (!isJsonText(v)) return [v];
    const pr = tryParse(v); if (!pr.ok) return [v];
    const out = [];
    const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) { out.push(k); walk(y); } else if (typeof x === 'string') out.push(x); };
    walk(pr.v);
    return out;
  };
  for (const [t, rows] of Object.entries(tables)) {
    rows.forEach((r, i) => {
      for (const [c, v] of Object.entries(r)) {
        if (typeof v !== 'string') continue;
        const bad = new Set();
        if (SECRET_HINTS.test(v)) bad.add('secret_hint');
        for (const s of leaves(v)) {
          if (new RegExp(ABS_PATH.source).test(s)) bad.add('absolute_path');
          if (new RegExp(ASP_REF.source).test(s)) bad.add('asp_ref');
          if (new RegExp(HEX_ADDR.source).test(s)) bad.add('hex_address');
          if (new RegExp(IPV4.source).test(s)) bad.add('ipv4');
          if (new RegExp(EMAIL.source).test(s)) bad.add('email');
          const deny = DENY_WORDS.exec(s) ?? extraDeny?.exec(s); if (deny) bad.add(`denied_word:${deny[0]}`);
          for (const n of needles) if (s.includes(n)) { bad.add(`redacted_value:${n.slice(0, 40)}`); break; }
        }
        if (bad.size) hits.push({ table: t, row: i, column: c, reasons: [...bad] });
      }
    });
  }
  return hits;
}

// ------------------------------------------------------------------ translation (export only)
export const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff5e]/;

/** Numbers inside a string become {0}, {1}, … so one translation covers every numeric variant of a sentence. */
const NUM = /[-+\u2212]?\d[\d,]*(?:\.\d+)?/g;
export function templateOf(s) {
  const vals = [];
  const tpl = s.replace(/[{}]/g, (m) => (m === '{' ? '\u0001' : '\u0002')).replace(NUM, (m) => `{${vals.push(m) - 1}}`);
  return { tpl, vals };
}
const fillTemplate = (en, vals) => en.replace(/\{(\d+)\}/g, (w, i) => vals[Number(i)] ?? w).replace(/\u0001/g, '{').replace(/\u0002/g, '}');
const jsonLeaf = (s) => /^\s*[[{]/.test(s) && tryParse(s).ok;

/** Walk every string leaf (JSON columns, JSON-in-JSON strings and object keys included) and map it through fn */
function mapStrings(tables, fn) {
  const tr = (s) => (jsonLeaf(s) ? JSON.stringify(walk(JSON.parse(s))) : fn(s));
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [fn(k), walk(x)]));
    return typeof v === 'string' ? tr(v) : v;
  };
  for (const rows of Object.values(tables)) for (const r of rows) for (const [c, v] of Object.entries(r)) {
    if (typeof v !== 'string' || !CJK.test(v)) continue;
    if (isJsonText(v)) { const pr = tryParse(v); if (pr.ok) { r[c] = JSON.stringify(walk(pr.v)); continue; } }
    r[c] = fn(v);
  }
}

/** Every distinct CJK string template ({0}… for numbers) still in the rows, with a count and one example */
export function collectCjk(tables) {
  const seen = new Map();
  const probe = structuredClone(tables);
  mapStrings(probe, (s) => {
    if (CJK.test(s)) { const { tpl } = templateOf(s); const e = seen.get(tpl) ?? { n: 0, example: s }; e.n++; seen.set(tpl, e); }
    return s;
  });
  return seen;
}

/**
 * Translate in place. translations = { exact: { "<source>": "English" }, templates: { "<template with {0}…>": "English with {0}…" } }.
 * Exact matches win; otherwise the string's number template is looked up and the numbers are put back.
 * Returns the number of strings replaced.
 */
export function translateTables(tables, { exact = {}, templates = {} } = {}) {
  let n = 0;
  mapStrings(tables, (s) => {
    if (!CJK.test(s)) return s;
    if (Object.hasOwn(exact, s)) { n++; return exact[s]; }
    const { tpl, vals } = templateOf(s);
    if (Object.hasOwn(templates, tpl)) { n++; return fillTemplate(templates[tpl], vals); }
    return s;
  });
  return n;
}

// ------------------------------------------------------------------ helpers
export const sameValue = (a, b) => {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number')) return BigInt(a) === BigInt(b) || Number(a) === Number(b);
  return false;
};
export const jsonSafe = (v) => (typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString()) : v);
