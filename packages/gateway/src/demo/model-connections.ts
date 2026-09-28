import { dependencyHealth } from './dependency-health.js';
import { BoundedMap } from './bounded-map.js';
import { withOutputLanguage } from './output-language.js';
// §9.52 模型连接与角色底层(docs/demo/v3-ui-contract.md §9.52;设计 chat-to-strategy-loop §3.7 / 验收 F1–F2)。
//
// 「底层」= 连接(API key 或本机 CLI)+ 角色绑定。7 个角色各自可绑一条连接 + 模型;没绑的回退旧槽位
// (chat/judge/research → workflow.brain 主脑,filter/reviewer/utility → workflow.cheap_brain 副脑,decision → 未设置)。
// 两个旧槽位不迁移、不破坏。
//
// 密钥纪律(F1):元数据进状态库 model_connections / model_role_bindings(迁移 0045);明文 key 单独放
// `<状态库目录>/secrets/model-keys.json`(目录 700、文件 600,`{[connection_id]: api_key}`)。
// API 响应只有 key_masked;错误文本一律过 redact();runtime.log() 也接了 redact()。
// 内存库(测试)没有目录可放:key 只留在进程内存里。
//
// 失效不静默回退(F2):绑定的连接不存在 / 没 key / 401/403 / 连不上 → 该角色调用抛
// `model_connection_failed:<role>:<detail>`,并把连接标成 error(楼层与顶栏据此亮红点)。

import type { FrozenModelProfile } from './research/judge/types.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Brain, BrainResult } from './brain.js';
import { brainCatalog, commandForKind, testBrain } from './brain.js';
import { cliLaunchStatusView } from './cli-launch.js';
import { assertSafeBaseUrl, checkBaseUrlSyntax, HttpBrainError, httpBrain, isRedirectResponse, redactKeyText, UnsafeBaseUrlError, type HttpConnectionKind, type LookupFn } from './brain-http.js';
import { DecisionError, DEFAULT_DECISION_BASE, DEFAULT_DECISION_MODEL, JevDecisionClient, type DecisionClient, type DecisionSpendLedger } from './decisions.js';
import type { BrainTestResult, CliCommandsView } from './types.js';

// ------------------------------------------------------------------ 契约类型(§9.52,字段名不许改)

export type ConnectionKind = 'openrouter' | 'anthropic' | 'deepseek' | 'zai' | 'openai' | 'openai_compatible' | 'cli';
export type CliTool = 'pi' | 'claude' | 'codex';
export interface ConnectionTest { at: number; ok: boolean; latency_ms: number | null; detail: string }
export interface ModelConnection {
  id: string;
  kind: ConnectionKind;
  label: string;
  base_url: string | null;
  cli: CliTool | null;
  key_masked: string | null;
  status: 'untested' | 'ok' | 'error';
  last_test: ConnectionTest | null;
  models_hint: string[];
  created_at: number;
  updated_at: number;
}
export type ModelRole = 'chat' | 'judge' | 'research' | 'filter' | 'reviewer' | 'utility' | 'decision';
export interface RoleBinding { role: ModelRole; connection_id: string | null; model: string | null }
export type EffectiveSource = 'binding' | 'fallback_main' | 'fallback_cheap' | 'unset';
/** POST /api/models/bindings/:role/test 的响应:按角色当前生效底层测一次。 */
export interface RoleTestResult extends ConnectionTest { role: ModelRole; source: EffectiveSource; name: string }
export interface ModelsView {
  connections: ModelConnection[];
  bindings: RoleBinding[];
  effective: Record<ModelRole, { source: EffectiveSource; name: string }>;
  cli_detected: { tool: CliTool; command: string | null; ok: boolean }[];
}

export const CONNECTION_KINDS: ConnectionKind[] = ['openrouter', 'anthropic', 'deepseek', 'zai', 'openai', 'openai_compatible', 'cli'];
export const CLI_TOOLS: CliTool[] = ['pi', 'claude', 'codex'];
export const MODEL_ROLES: ModelRole[] = ['chat', 'judge', 'research', 'filter', 'reviewer', 'utility', 'decision'];
/** 未绑定时回退哪个旧槽位(decision 没有旧槽位)。 */
export const ROLE_FALLBACK: Record<Exclude<ModelRole, 'decision'>, 'main' | 'cheap'> = {
  chat: 'main',
  judge: 'main',
  research: 'main',
  filter: 'cheap',
  reviewer: 'cheap',
  utility: 'cheap',
};

/** 各 HTTP 连接的内置缺省:地址、名字、常用模型(连接测通前的 models_hint)。 */
export const KIND_DEFAULTS: Record<HttpConnectionKind, { base_url: string | null; label: string; models: string[] }> = {
  openrouter: { base_url: 'https://openrouter.ai/api/v1', label: 'OpenRouter', models: ['deepseek/deepseek-v4.1-flash', DEFAULT_DECISION_MODEL] },
  anthropic: { base_url: 'https://api.anthropic.com', label: 'Anthropic', models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] },
  deepseek: { base_url: 'https://api.deepseek.com', label: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] },
  zai: { base_url: 'https://open.bigmodel.cn/api/paas/v4', label: 'Z.ai(智谱)', models: ['glm-5.3', 'glm-5-turbo'] },
  openai: { base_url: 'https://api.openai.com/v1', label: 'OpenAI', models: ['gpt-5.4', 'gpt-5.4-mini'] },
  openai_compatible: { base_url: null, label: '自定义(OpenAI 兼容)', models: [] },
};
const CLI_LABEL: Record<CliTool, string> = { pi: 'pi CLI', claude: 'Claude Code CLI', codex: 'Codex CLI' };

/** 只能走 Decisions API 的模型(不能当 LLM 用)。 */
export const isDecisionOnlyModel = (m: string | null | undefined): boolean => !!m && /^~?typesafe\//.test(m.trim());
/** 模型 id:允许 OpenRouter 的 `~` 前缀(workflow.MODEL_ID_RE 不允许,所以单独一条)。 */
export const CONNECTION_MODEL_RE = /^~?[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;

/** 'sk-or-v1-abc…xyz' → 'sk-or-…c6a5e9'(前 6 后 6);短 key 只留后 2 位。 */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 12) return `…${k.slice(-2)}`;
  return `${k.slice(0, 6)}…${k.slice(-6)}`;
}

/** 从 openrouter.env 文本里取 key(OPENROUTER_API_KEY=…,容忍 export / 引号 / 注释)。 */
export function parseEnvKey(text: string, name = 'OPENROUTER_API_KEY'): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line);
    if (!m) continue;
    let v = m[1]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    return v.trim() || null;
  }
  return null;
}

const httpError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(message), { status, code, ...extra });

// ------------------------------------------------------------------ 密钥文件

/** `<dir>/model-keys.json`,目录 700、文件 600;dir=null(内存库)时只在进程内存里。 */
export class KeyVault {
  private cache: Record<string, string> | null = null;
  constructor(readonly dir: string | null) {}
  get file(): string | null {
    return this.dir ? path.join(this.dir, 'model-keys.json') : null;
  }
  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    this.cache = {};
    const f = this.file;
    if (f && existsSync(f)) {
      try {
        const raw = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) this.cache[k] = v;
      } catch {
        // 文件坏了:当作没有 key(连接会显示「没有 key」而不是崩),不覆盖原文件,等人处理。
        this.cache = {};
        this.corrupt = true;
      }
    }
    return this.cache;
  }
  private corrupt = false;
  get(id: string): string | null {
    return this.load()[id] ?? null;
  }
  all(): string[] {
    return Object.values(this.load());
  }
  set(id: string, key: string): void {
    const m = this.load();
    m[id] = key;
    this.save();
  }
  delete(id: string): void {
    const m = this.load();
    if (!(id in m)) return;
    delete m[id];
    this.save();
  }
  private save(): void {
    const f = this.file;
    if (!f || !this.dir) return;
    if (this.corrupt) throw httpError(500, 'secrets_corrupt', `密钥文件 ${f} 解析失败,拒绝覆盖;请人工检查`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cache ?? {}, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, f);
  }
}

// ------------------------------------------------------------------ 存储

interface ConnRow { id: string; kind: string; label: string; base_url: string | null; cli: string | null; key_masked: string | null; status: string; last_test_json: string | null; models_hint_json: string; created_at: number; updated_at: number }

/**
 * 只有 openai_compatible 能有自定义 base_url;其它 kind 库里若存了地址(旧版本允许改),读取时一律丢掉、用内置缺省,
 * 非缺省地址回调 onIgnoredBase(路由记 warn)。
 */
function rowToConn(r: ConnRow, onIgnoredBase?: (id: string, kind: string, base: string) => void): ModelConnection {
  let last: ConnectionTest | null = null;
  let hints: string[] = [];
  try { last = r.last_test_json ? (JSON.parse(r.last_test_json) as ConnectionTest) : null; } catch { last = null; }
  try { hints = (JSON.parse(r.models_hint_json) as unknown[]).filter((x): x is string => typeof x === 'string'); } catch { hints = []; }
  let base = r.base_url;
  if (base && r.kind !== 'openai_compatible') {
    const def = (KIND_DEFAULTS as Record<string, { base_url: string | null } | undefined>)[r.kind]?.base_url ?? null;
    if (base.replace(/\/+$/, '') !== def) onIgnoredBase?.(r.id, r.kind, base);
    base = null;
  }
  return { id: r.id, kind: r.kind as ConnectionKind, label: r.label, base_url: base, cli: (r.cli as CliTool | null) ?? null, key_masked: r.key_masked, status: r.status as ModelConnection['status'], last_test: last, models_hint: hints, created_at: Number(r.created_at), updated_at: Number(r.updated_at) };
}

export class ModelConnectionStore {
  constructor(private readonly db: DatabaseSync, private readonly onIgnoredBase?: (id: string, kind: string, base: string) => void) {}
  list(): ModelConnection[] {
    return (this.db.prepare('SELECT * FROM model_connections ORDER BY created_at, id').all() as unknown as ConnRow[]).map((r) => rowToConn(r, this.onIgnoredBase));
  }
  get(id: string): ModelConnection | null {
    const r = this.db.prepare('SELECT * FROM model_connections WHERE id = ?').get(id) as unknown as ConnRow | undefined;
    return r ? rowToConn(r, this.onIgnoredBase) : null;
  }
  insert(c: ModelConnection): void {
    this.db.prepare('INSERT INTO model_connections(id, kind, label, base_url, cli, key_masked, status, last_test_json, models_hint_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.kind, c.label, c.base_url, c.cli, c.key_masked, c.status, c.last_test ? JSON.stringify(c.last_test) : null, JSON.stringify(c.models_hint), c.created_at, c.updated_at);
  }
  update(c: ModelConnection): void {
    this.db.prepare('UPDATE model_connections SET label = ?, base_url = ?, cli = ?, key_masked = ?, status = ?, last_test_json = ?, models_hint_json = ?, updated_at = ? WHERE id = ?')
      .run(c.label, c.base_url, c.cli, c.key_masked, c.status, c.last_test ? JSON.stringify(c.last_test) : null, JSON.stringify(c.models_hint), c.updated_at, c.id);
  }
  /** 只改状态,不动 updated_at(updated_at 是配置版本,brain 缓存按它失效)。 */
  setStatus(id: string, status: ModelConnection['status'], last: ConnectionTest | null, hints?: string[]): void {
    if (hints) this.db.prepare('UPDATE model_connections SET status = ?, last_test_json = ?, models_hint_json = ? WHERE id = ?').run(status, last ? JSON.stringify(last) : null, JSON.stringify(hints), id);
    else this.db.prepare('UPDATE model_connections SET status = ?, last_test_json = ? WHERE id = ?').run(status, last ? JSON.stringify(last) : null, id);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM model_connections WHERE id = ?').run(id);
  }
  bindings(): RoleBinding[] {
    const rows = this.db.prepare('SELECT role, connection_id, model FROM model_role_bindings').all() as { role: ModelRole; connection_id: string; model: string | null }[];
    const by = new Map(rows.map((r) => [r.role, r]));
    return MODEL_ROLES.map((role) => ({ role, connection_id: by.get(role)?.connection_id ?? null, model: by.get(role)?.model ?? null }));
  }
  binding(role: ModelRole): RoleBinding | null {
    const r = this.db.prepare('SELECT role, connection_id, model FROM model_role_bindings WHERE role = ?').get(role) as RoleBinding | undefined;
    return r ? { role: r.role, connection_id: r.connection_id, model: r.model ?? null } : null;
  }
  setBinding(role: ModelRole, connectionId: string | null, model: string | null): void {
    if (connectionId === null) this.db.prepare('DELETE FROM model_role_bindings WHERE role = ?').run(role);
    else this.db.prepare('INSERT INTO model_role_bindings(role, connection_id, model, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(role) DO UPDATE SET connection_id = excluded.connection_id, model = excluded.model, updated_at = excluded.updated_at').run(role, connectionId, model, Date.now());
  }
  rolesUsing(connectionId: string): ModelRole[] {
    return (this.db.prepare('SELECT role FROM model_role_bindings WHERE connection_id = ?').all(connectionId) as { role: ModelRole }[]).map((r) => r.role);
  }
}

/** 状态库文件所在目录下的 secrets/;内存库 → null。 */
export function secretsDirFor(db: DatabaseSync): string | null {
  try {
    const rows = db.prepare('PRAGMA database_list').all() as { name: string; file: string }[];
    const file = rows.find((r) => r.name === 'main')?.file ?? '';
    return file ? path.join(path.dirname(file), 'secrets') : null;
  } catch {
    return null;
  }
}

/** 缺省导入源:~/.trade-gate-okx/openrouter.env。测试进程(VITEST)里不碰真实家目录,除非显式给 TG_MODEL_IMPORT_ENV。 */
export function defaultImportEnvPath(): string | null {
  const explicit = process.env['TG_MODEL_IMPORT_ENV'];
  if (explicit !== undefined) return explicit.trim() || null;
  if (process.env['VITEST']) return null;
  return path.join(os.homedir(), '.trade-gate-okx', 'openrouter.env');
}

// ------------------------------------------------------------------ 运行时路由

export interface ModelRouterDeps {
  db: DatabaseSync;
  /** 缺省 secretsDirFor(db)。 */
  secretsDir?: string | null;
  mainBrain: () => Brain;
  cheapBrain: () => Brain;
  /** CLI 连接的大脑(runtime.brainFor:复用注入 / 缓存 / 启动命令)。 */
  cliBrain: (tool: CliTool, model: string | null) => Brain;
  cliCommands: () => Partial<CliCommandsView> | null;
  decisionCapUsd: () => number;
  ledger: DecisionSpendLedger;
  emit: (view: ModelsView) => void;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 测试注入(HTTP 大脑、Decisions、openrouter /models 共用)。 */
  fetchFn?: typeof fetch;
  /** 测试注入:本机 CLI 探测 / CLI 连接测试 / CLI 模型目录。 */
  detectCli?: (tool: CliTool, command: string | null) => boolean;
  testCli?: (tool: CliTool, model: string | null, commands: Partial<CliCommandsView> | null) => Promise<BrainTestResult>;
  cliModels?: (tool: CliTool, commands: Partial<CliCommandsView> | null) => string[];
  /** 启动导入的 env 文件;undefined = defaultImportEnvPath()。 */
  importEnvPath?: string | null;
  /** 测试注入:DNS 解析(openai_compatible 的 base_url 校验;缺省系统解析器)。 */
  lookupFn?: LookupFn;
}

/** api_key 最短长度:更短的 key 既不像真 key,也会让精确替换脱敏误伤正文。 */
export const MIN_API_KEY_LENGTH = 16;
/** 自定义地址 → 日志里只露 scheme://host(旧数据里的地址可能带 userinfo)。 */
const hostOnly = (raw: string): string => {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(非法地址)';
  }
};

type FailingKind = 'missing_connection' | 'missing_key';

export class ModelRouter {
  readonly store: ModelConnectionStore;
  readonly vault: KeyVault;
  private readonly brains = new BoundedMap<string, Brain>(64);
  private readonly decisionClients = new BoundedMap<string, JevDecisionClient>(64);

  private readonly ignoredBaseWarned = new Set<string>();

  constructor(private readonly deps: ModelRouterDeps) {
    this.store = new ModelConnectionStore(deps.db, (id, kind, base) => {
      if (this.ignoredBaseWarned.has(id)) return;
      if (this.ignoredBaseWarned.size >= 1024) this.ignoredBaseWarned.delete(this.ignoredBaseWarned.values().next().value!);
      this.ignoredBaseWarned.add(id);
      deps.log('warn', `模型连接 ${id}(${kind})存了自定义 base_url ${hostOnly(base)},已忽略:内置 provider 只走缺省地址`);
    });
    this.vault = new KeyVault(deps.secretsDir !== undefined ? deps.secretsDir : secretsDirFor(deps.db));
    const importPath = deps.importEnvPath !== undefined ? deps.importEnvPath : defaultImportEnvPath();
    if (importPath) {
      try {
        this.importOpenRouterEnv(importPath);
      } catch (e) {
        deps.log('warn', `导入 OpenRouter 连接失败:${this.redact((e as Error).message)}`);
      }
    }
  }

  /** 脱敏:已存的全部 key + 常见 key 形状。runtime.log 也调它。 */
  redact(text: string): string {
    return redactKeyText(text, this.vault.all());
  }

  // ---------------------------------------------------------------- 视图

  view(): ModelsView {
    const connections = this.store.list();
    const bindings = this.store.bindings();
    const effective = {} as ModelsView['effective'];
    for (const b of bindings) {
      if (b.role === 'decision') {
        effective.decision = b.connection_id ? { source: 'binding', name: `openrouter:${b.model ?? DEFAULT_DECISION_MODEL}` } : { source: 'unset', name: '' };
        continue;
      }
      if (b.connection_id) effective[b.role] = { source: 'binding', name: this.brainForRole(b.role).name };
      else {
        const slot = ROLE_FALLBACK[b.role];
        effective[b.role] = { source: slot === 'main' ? 'fallback_main' : 'fallback_cheap', name: (slot === 'main' ? this.deps.mainBrain() : this.deps.cheapBrain()).name };
      }
    }
    const cmds = this.deps.cliCommands();
    const cli_detected = CLI_TOOLS.map((tool) => {
      const command = commandForKind(tool, cmds);
      let ok = false;
      try {
        ok = this.deps.detectCli ? this.deps.detectCli(tool, command) : command !== null && cliLaunchStatusView(command).ok;
      } catch {
        ok = false;
      }
      return { tool, command, ok };
    });
    return { connections, bindings, effective, cli_detected };
  }

  private changed(): void {
    this.deps.emit(this.view());
  }

  // ---------------------------------------------------------------- 连接 CRUD

  /** 创建连接。openai_compatible 的 base_url 过完整 SSRF 校验(含 DNS),所以是 async。 */
  async createConnection(body: Record<string, unknown>): Promise<ModelConnection> {
    const kind = body['kind'];
    if (typeof kind !== 'string' || !(CONNECTION_KINDS as string[]).includes(kind)) throw httpError(400, 'bad_request', `kind 只能是 ${CONNECTION_KINDS.join('/')}`);
    const k = kind as ConnectionKind;
    const now = Date.now();
    const conn: ModelConnection = { id: `mc_${randomBytes(6).toString('hex')}`, kind: k, label: '', base_url: null, cli: null, key_masked: null, status: 'untested', last_test: null, models_hint: [], created_at: now, updated_at: now };
    const key = this.applyFields(conn, body);
    if (k !== 'cli' && k !== 'openai_compatible' && !key) throw httpError(400, 'api_key_required', `${KIND_DEFAULTS[k].label} 连接需要 api_key`);
    if (k === 'openai_compatible') conn.base_url = await this.safeBase(conn.base_url!, !!key);
    conn.models_hint = this.staticHints(conn);
    this.store.insert(conn);
    if (key) this.vault.set(conn.id, key);
    this.deps.log('info', `新增模型连接 ${conn.label}(${conn.kind}${conn.key_masked ? ` · ${conn.key_masked}` : ''})`);
    this.changed();
    return conn;
  }

  async updateConnection(id: string, body: Record<string, unknown>): Promise<ModelConnection> {
    const conn = this.store.get(id);
    if (!conn) throw httpError(404, 'not_found', `没有连接 ${id}`);
    if (body['kind'] !== undefined && body['kind'] !== conn.kind) throw httpError(400, 'kind_immutable', '连接类型不能改;删掉重建');
    const before = JSON.stringify([conn.base_url, conn.cli]);
    const key = this.applyFields(conn, body);
    const configChanged = key !== null || JSON.stringify([conn.base_url, conn.cli]) !== before;
    // 地址或 key 变了就重验(例:本机 http 无 key 连接补上 key → 必须改 https)。
    if (conn.kind === 'openai_compatible' && configChanged) conn.base_url = await this.safeBase(conn.base_url!, !!(key ?? this.vault.get(conn.id)));
    if (configChanged) {
      // 地址 / key / CLI 变了:上次测试结果作废。
      conn.status = 'untested';
      conn.last_test = null;
      conn.models_hint = this.staticHints(conn);
    }
    conn.updated_at = Math.max(Date.now(), conn.updated_at + 1);
    this.store.update(conn);
    if (key) this.vault.set(conn.id, key);
    this.dropCaches(conn.id);
    this.changed();
    return conn;
  }

  deleteConnection(id: string): void {
    const conn = this.store.get(id);
    if (!conn) throw httpError(404, 'not_found', `没有连接 ${id}`);
    const roles = this.store.rolesUsing(id);
    if (roles.length) throw httpError(409, 'connection_in_use', `连接「${conn.label}」还绑着角色:${roles.join('、')};先改绑再删`, { roles });
    this.store.delete(id);
    this.vault.delete(id);
    this.dropCaches(id);
    this.deps.log('info', `删除模型连接 ${conn.label}(${conn.kind})`);
    this.changed();
  }

  /** 校验并写入 label/base_url/cli;返回新 key(没给 = null)。 */
  private applyFields(conn: ModelConnection, body: Record<string, unknown>): string | null {
    const str = (k: string): string | null | undefined => {
      const v = body[k];
      if (v === undefined) return undefined;
      if (v === null) return null;
      if (typeof v !== 'string') throw httpError(400, 'bad_request', `${k} 必须是字符串`);
      return v.trim();
    };
    const label = str('label');
    if (label !== undefined && label !== null) {
      if (label.length > 60) throw httpError(400, 'bad_request', 'label 最多 60 字符');
      if (label) conn.label = label;
    }
    if (conn.kind === 'cli') {
      const cli = str('cli');
      if (cli !== undefined) {
        if (!cli || !(CLI_TOOLS as string[]).includes(cli)) throw httpError(400, 'bad_request', `cli 只能是 ${CLI_TOOLS.join('/')}`);
        conn.cli = cli as CliTool;
      }
      if (!conn.cli) throw httpError(400, 'cli_required', 'CLI 连接必须选 cli(pi/claude/codex)');
      if (typeof body['api_key'] === 'string' && body['api_key'].trim()) throw httpError(400, 'bad_request', 'CLI 连接不收 api_key(用 CLI 自己的登录)');
      if (str('base_url')) throw httpError(400, 'base_url_not_allowed', 'CLI 连接没有 base_url');
      if (!conn.label) conn.label = CLI_LABEL[conn.cli];
      return null;
    }
    const rawKey = body['api_key'];
    if (rawKey !== undefined && rawKey !== null && typeof rawKey !== 'string') throw httpError(400, 'bad_request', 'api_key 必须是字符串');
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (key && (key.length < MIN_API_KEY_LENGTH || key.length > 400 || /\s/.test(key))) {
      throw httpError(400, 'api_key_invalid', `api_key 格式不对(${MIN_API_KEY_LENGTH}–400 字符,不能有空白)`);
    }
    const base = str('base_url');
    if (conn.kind !== 'openai_compatible') {
      // 内置 provider 只走缺省地址:带非空 base_url 直接拒(防止把已存 key PATCH 到任意主机)。null / 空串 = 没给。
      if (base) throw httpError(400, 'base_url_not_allowed', `${KIND_DEFAULTS[conn.kind].label} 连接只能用内置地址,不能改 base_url;自定义地址请建「OpenAI 兼容」连接`);
    } else {
      if (base !== undefined) conn.base_url = base || null;
      if (!conn.base_url) throw httpError(400, 'base_url_required', '自定义 OpenAI 兼容连接必须填 base_url');
      // 语法层先拦(DNS 层在 create/update 里 await safeBase);有没有 key 看这次给的或已存的。
      conn.base_url = this.syntaxBase(conn.base_url, !!key || !!this.vault.get(conn.id));
    }
    if (!conn.label) conn.label = KIND_DEFAULTS[conn.kind].label;
    if (!key) return null; // 缺省 / 空串 = 不改
    conn.key_masked = maskKey(key);
    return key;
  }

  private syntaxBase(raw: string, hasKey: boolean): string {
    try {
      return checkBaseUrlSyntax(raw, hasKey);
    } catch (e) {
      if (e instanceof UnsafeBaseUrlError) throw httpError(400, e.code, e.message);
      throw e;
    }
  }

  /** openai_compatible 地址的完整校验(语法 + DNS 全部结果),失败 → 400。 */
  private async safeBase(raw: string, hasKey: boolean): Promise<string> {
    try {
      return await assertSafeBaseUrl(raw, { hasKey, ...(this.deps.lookupFn ? { lookup: this.deps.lookupFn } : {}) });
    } catch (e) {
      if (e instanceof UnsafeBaseUrlError) throw httpError(400, e.code, this.redact(e.message));
      throw e;
    }
  }

  private staticHints(conn: ModelConnection): string[] {
    if (conn.kind === 'cli') {
      try {
        return conn.cli ? (this.deps.cliModels ? this.deps.cliModels(conn.cli, this.deps.cliCommands()) : brainCatalog(false, this.deps.cliCommands()).find((o) => o.kind === conn.cli)?.models ?? []) : [];
      } catch {
        return [];
      }
    }
    return [...KIND_DEFAULTS[conn.kind].models];
  }

  private dropCaches(connId: string): void {
    for (const k of [...this.brains.keys()]) if (k.startsWith(`${connId}:`)) this.brains.delete(k);
    for (const k of [...this.decisionClients.keys()]) if (k.startsWith(`${connId}:`)) this.decisionClients.delete(k);
  }

  // ---------------------------------------------------------------- 绑定

  setBinding(roleRaw: string, body: Record<string, unknown>): ModelsView {
    if (!(MODEL_ROLES as string[]).includes(roleRaw)) throw httpError(404, 'not_found', `角色只能是 ${MODEL_ROLES.join('/')}`);
    const role = roleRaw as ModelRole;
    const cid = body['connection_id'];
    if (cid === null || cid === undefined || cid === '') {
      this.store.setBinding(role, null, null);
      this.deps.log('info', `角色 ${role} 解绑,回退${role === 'decision' ? '为未设置' : ROLE_FALLBACK[role] === 'main' ? '主脑' : '副脑'}`);
      this.changed();
      return this.view();
    }
    if (typeof cid !== 'string') throw httpError(400, 'bad_request', 'connection_id 必须是字符串或 null');
    const conn = this.store.get(cid);
    if (!conn) throw httpError(404, 'not_found', `没有连接 ${cid}`);
    const rawModel = body['model'];
    if (rawModel !== undefined && rawModel !== null && typeof rawModel !== 'string') throw httpError(400, 'bad_request', 'model 必须是字符串或 null');
    let model = typeof rawModel === 'string' && rawModel.trim() ? rawModel.trim() : null;
    if (model !== null && !CONNECTION_MODEL_RE.test(model)) throw httpError(400, 'bad_request', 'model 只能是模型 id(字母数字 . _ : / @ -,可带 ~ 前缀,≤ 120 字符)');
    if (role === 'decision') {
      if (conn.kind !== 'openrouter') throw httpError(400, 'decision_requires_openrouter', '判断要素只能绑 OpenRouter 连接(Decisions API)');
      model ??= DEFAULT_DECISION_MODEL;
    } else {
      if (isDecisionOnlyModel(model)) throw httpError(400, 'decision_only_model', `${model} 只能用于判断要素(Decisions API),不能当对话/判断模型`);
      if (conn.kind !== 'cli' && !model) throw httpError(400, 'model_required', 'API 连接必须指定模型');
    }
    this.store.setBinding(role, conn.id, model);
    this.deps.log('info', `角色 ${role} 绑定到 ${conn.label}${model ? ` · ${model}` : ''}`);
    this.changed();
    return this.view();
  }

  // ---------------------------------------------------------------- 执行

  /** 失效的绑定:不回退,调用即抛 model_connection_failed。 */
  private failingBrain(role: ModelRole, why: FailingKind, detail: string): Brain {
    return {
      name: `unavailable:${role}`,
      async complete() {
        throw httpError(502, 'model_connection_failed', `model_connection_failed:${role}:${detail}`, { reason: why });
      },
    };
  }

  /** 包一层:错误统一加前缀;401/403/连不上把连接标 error,调用成功把 error 复位。 */
  private guard(role: ModelRole, conn: ModelConnection, inner: Brain): Brain {
    return {
      name: inner.name,
      complete: async (system, user, o): Promise<BrainResult> => {
        try {
          const r = await inner.complete(withOutputLanguage(system), user, o);
          dependencyHealth.observe('brain', true);
          if (this.store.get(conn.id)?.status === 'error') {
            this.store.setStatus(conn.id, 'ok', { at: Date.now(), ok: true, latency_ms: r.latency_ms, detail: `${role} 调用成功` });
            this.changed();
          }
          return r;
        } catch (e) {
          dependencyHealth.observe('brain', false, e);
          const detail = this.redact((e as Error).message);
          if (e instanceof HttpBrainError && (e.kind === 'auth' || e.kind === 'network')) {
            this.store.setStatus(conn.id, 'error', { at: Date.now(), ok: false, latency_ms: null, detail: `${role} 调用失败:${detail}` });
            this.changed();
          }
          this.deps.log('warn', `角色 ${role} 的连接「${conn.label}」调用失败:${detail}`);
          throw httpError(502, 'model_connection_failed', `model_connection_failed:${role}:${detail}`);
        }
      },
    };
  }

  /** 按角色取大脑。未绑定 → 旧槽位;绑定失效 → 调用即报错(不静默回退)。 */
  brainForRole(role: Exclude<ModelRole, 'decision'>): Brain {
    const b = this.store.binding(role);
    if (!b) return ROLE_FALLBACK[role] === 'main' ? this.deps.mainBrain() : this.deps.cheapBrain();
    const conn = this.store.get(b.connection_id!);
    if (!conn) return this.failingBrain(role, 'missing_connection', `绑定的连接 ${b.connection_id} 已不存在`);
    if (conn.kind === 'cli') return this.guard(role, conn, this.deps.cliBrain(conn.cli ?? 'pi', b.model));
    const cacheKey = `${conn.id}:${conn.updated_at}:${b.model ?? ''}:${role}`;
    const cached = this.brains.get(cacheKey);
    if (cached) return cached;
    const brain = this.buildHttpBrain(conn, b.model);
    const guarded = brain ? this.guard(role, conn, brain) : this.failingBrain(role, 'missing_key', `连接「${conn.label}」没有 api_key`);
    this.brains.set(cacheKey, guarded);
    return guarded;
  }

  private buildHttpBrain(conn: ModelConnection, model: string | null): Brain | null {
    if (conn.kind === 'cli') return null;
    const key = this.vault.get(conn.id);
    if (!key && conn.kind !== 'openai_compatible') return null;
    // 内置 provider 永远走缺省地址(store 读出来的 base_url 已是 null,这里再钉一次);只有 openai_compatible 用自定义地址,
    // 且每次出站前重验(重解析 DNS,防 rebinding;有 key 就不许落到本机)。
    const custom = conn.kind === 'openai_compatible';
    const base = custom ? conn.base_url : KIND_DEFAULTS[conn.kind].base_url;
    if (!base) return null;
    const lookup = this.deps.lookupFn;
    return httpBrain({
      kind: conn.kind,
      base_url: base,
      api_key: key,
      model: model ?? KIND_DEFAULTS[conn.kind].models[0] ?? '',
      ...(custom ? { guardUrl: async () => void (await assertSafeBaseUrl(base, { hasKey: !!key, ...(lookup ? { lookup } : {}) })) } : {}),
      ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
    });
  }

  /**
   * 判断要素(IR judge,§9.53 C)用的「钉住」决策连接:固定模型版本 + 不重试的客户端 + 不可变配置引用。
   * 回测与运行器都按 profile.ref 找它;ref 不含连接修改时间(改连接名称不让在跑的策略失效),
   * 别名 ~typesafe/jev-latest 钉到当前版本(astra:别名不是不可变版本)。未绑定 / 连接失效 → null。
   */
  frozenDecision(): { profile: FrozenModelProfile; client: DecisionClient } | null {
    const b = this.store.binding('decision');
    if (!b?.connection_id) return null;
    const conn = this.store.get(b.connection_id);
    if (!conn || conn.kind !== 'openrouter') return null;
    const key = this.vault.get(conn.id);
    if (!key) return null;
    const model = pinDecisionModel(b.model ?? DEFAULT_DECISION_MODEL);
    const profile: FrozenModelProfile = {
      ref: `decision:${conn.id}:${model}`, connection_id: conn.id, connection_revision: String(conn.updated_at), model, model_revision: model,
      routing: 'openrouter', parser_version: 'judge_answers_v1', max_call_usd: JUDGE_MAX_CALL_USD, retry_policy: 'none',
    };
    const cacheKey = `frozen:${conn.id}:${conn.updated_at}:${model}`;
    let client = this.decisionClients.get(cacheKey);
    if (!client) {
      client = new JevDecisionClient({ api_key: key, model, base_url: this.decisionBase(conn), dailyCapUsd: this.deps.decisionCapUsd, ledger: this.deps.ledger, maxRetries: 0, ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}) });
      this.decisionClients.set(cacheKey, client);
    }
    return { profile, client };
  }

  /** 判断要素的客户端;未绑定 = null;绑定失效 → decide 即抛 model_connection_failed:decision。 */
  decisionClient(): DecisionClient | null {
    const b = this.store.binding('decision');
    if (!b) return null;
    const conn = this.store.get(b.connection_id!);
    const model = b.model ?? DEFAULT_DECISION_MODEL;
    const fail = (detail: string): DecisionClient => ({
      name: `openrouter:${model}`,
      async decide() {
        throw httpError(502, 'model_connection_failed', `model_connection_failed:decision:${detail}`);
      },
    });
    if (!conn) return fail(`绑定的连接 ${b.connection_id} 已不存在`);
    if (conn.kind !== 'openrouter') return fail(`连接「${conn.label}」不是 OpenRouter`);
    const key = this.vault.get(conn.id);
    if (!key) return fail(`连接「${conn.label}」没有 api_key`);
    const cacheKey = `${conn.id}:${conn.updated_at}:${model}`;
    let client = this.decisionClients.get(cacheKey);
    if (!client) {
      client = new JevDecisionClient({ api_key: key, model, base_url: this.decisionBase(conn), dailyCapUsd: this.deps.decisionCapUsd, ledger: this.deps.ledger, ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}) });
      this.decisionClients.set(cacheKey, client);
    }
    const inner = client;
    return {
      name: inner.name,
      decide: async (req, o) => {
        try {
          return await inner.decide(req, o);
        } catch (e) {
          if (e instanceof DecisionError && (e.code === 'decision_budget_exhausted' || e.code === 'bad_request')) throw e;
          dependencyHealth.observe('brain', false, e);
          const detail = this.redact((e as Error).message);
          if (e instanceof DecisionError && (e.code === 'auth' || e.code === 'network')) {
            this.store.setStatus(conn.id, 'error', { at: Date.now(), ok: false, latency_ms: null, detail: `decision 调用失败:${detail}` });
            this.changed();
          }
          throw httpError(502, 'model_connection_failed', `model_connection_failed:decision:${detail}`);
        }
      },
    };
  }

  /** Decisions API 的根:只有 OpenRouter 能绑,且内置 provider 不许自定义地址 → 永远是缺省根。 */
  private decisionBase(_conn: ModelConnection): string {
    return DEFAULT_DECISION_BASE;
  }

  // ---------------------------------------------------------------- 测试

  /** 发一次最小请求:LLM「只回复 ok」;decision 模型发 1 问 noul;cli 走 testBrain。结果写回连接。 */
  async testConnection(id: string, body: Record<string, unknown> = {}): Promise<ConnectionTest> {
    const conn = this.store.get(id);
    if (!conn) throw httpError(404, 'not_found', `没有连接 ${id}`);
    const raw = body['model'];
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw httpError(400, 'bad_request', 'model 必须是字符串');
    let model = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    if (model !== null && !CONNECTION_MODEL_RE.test(model)) throw httpError(400, 'bad_request', 'model 只能是模型 id');
    if (!model && conn.kind !== 'cli') {
      const bound = this.store.bindings().find((b) => b.connection_id === conn.id && b.model && !isDecisionOnlyModel(b.model));
      model = bound?.model ?? conn.models_hint.find((m) => !isDecisionOnlyModel(m)) ?? conn.models_hint[0] ?? null;
      if (!model) throw httpError(400, 'model_required', '这条连接没有可测的模型,请在测试时指定 model');
    }
    const started = Date.now();
    let result: ConnectionTest;
    let hints: string[] | undefined;
    if (conn.kind === 'cli') {
      const cmds = this.deps.cliCommands();
      const r = this.deps.testCli ? await this.deps.testCli(conn.cli ?? 'pi', model, cmds) : await testBrain(conn.cli ?? 'pi', model, 90_000, cmds);
      result = { at: Date.now(), ok: r.ok, latency_ms: r.latency_ms, detail: this.redact(r.ok ? `${r.name} 回复:${(r.text ?? '').slice(0, 60)}` : `${r.name}:${r.error ?? '无输出'}`) };
      if (r.ok) hints = this.staticHints(conn);
    } else if (isDecisionOnlyModel(model)) {
      const key = this.vault.get(conn.id);
      if (conn.kind !== 'openrouter') result = { at: Date.now(), ok: false, latency_ms: null, detail: `${model} 只能走 OpenRouter Decisions API` };
      else if (!key) result = { at: Date.now(), ok: false, latency_ms: null, detail: '没有 api_key' };
      else {
        // 测试不进日花费闸(否则额度用完就测不了);但花费照样记进账本。
        const client = new JevDecisionClient({ api_key: key, model: model!, base_url: this.decisionBase(conn), dailyCapUsd: () => Number.POSITIVE_INFINITY, ledger: this.deps.ledger, maxRetries: 0, ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}) });
        try {
          const r = await client.decide({ state: { ping: 'connectivity test' }, questions: { ok: { type: 'noul', instructions: 'Is this a connectivity test?', criteria: { true: 'yes', false: 'no' } } } }, { timeoutMs: 30_000 });
          const a = r.answers['ok'];
          result = { at: Date.now(), ok: true, latency_ms: r.latency_ms, detail: `Decisions API 正常:noul=${a && a.type === 'noul' ? a.noul.toFixed(3) : '?'}${r.usage.cost_usd !== null ? ` · $${r.usage.cost_usd.toFixed(6)}` : ''}` };
        } catch (e) {
          result = { at: Date.now(), ok: false, latency_ms: Date.now() - started, detail: this.redact((e as Error).message) };
        }
      }
    } else {
      const brain = this.buildHttpBrain(conn, model);
      if (!brain) result = { at: Date.now(), ok: false, latency_ms: null, detail: '没有 api_key' };
      else {
        try {
          const r = await brain.complete('你是连通性测试。只回复一个词:ok', 'ping', { timeoutMs: 60_000 });
          const cost = (r as BrainResult & { cost_usd?: number | null }).cost_usd;
          result = { at: Date.now(), ok: true, latency_ms: r.latency_ms, detail: this.redact(`${brain.name} 回复:${r.text.slice(0, 60)}${typeof cost === 'number' ? ` · $${cost.toFixed(6)}` : ''}`) };
          if (conn.kind === 'openrouter') hints = await this.openRouterModels(conn).catch(() => undefined);
        } catch (e) {
          result = { at: Date.now(), ok: false, latency_ms: Date.now() - started, detail: this.redact((e as Error).message) };
        }
      }
    }
    this.store.setStatus(conn.id, result.ok ? 'ok' : 'error', result, hints);
    this.deps.log(result.ok ? 'info' : 'warn', `测试模型连接 ${conn.label}${model ? ` · ${model}` : ''}:${result.ok ? '通过' : '失败'} ${result.detail}`);
    this.changed();
    return result;
  }

  /**
   * 按角色测试(#models 页每张 agent 卡的「测试连接」):用该角色**当前生效**的底层发一次最短往返。
   * 绑定 → 走 testConnection(连接 id + 绑定的模型),结果写回连接;回退 → 直接调旧槽位大脑一次(不改连接);
   * decision 未设置 → ok:false「未设置」。返回 ConnectionTest + 角色 / 来源 / 生效名,错误文本已脱敏。
   */
  async testRole(roleRaw: string): Promise<RoleTestResult> {
    if (!(MODEL_ROLES as string[]).includes(roleRaw)) throw httpError(404, 'not_found', `角色只能是 ${MODEL_ROLES.join('/')}`);
    const role = roleRaw as ModelRole;
    const b = this.store.binding(role);
    if (b?.connection_id) {
      const conn = this.store.get(b.connection_id);
      const name = role === 'decision' ? `openrouter:${b.model ?? DEFAULT_DECISION_MODEL}` : this.brainForRole(role).name;
      if (!conn) return { role, source: 'binding', name, at: Date.now(), ok: false, latency_ms: null, detail: `绑定的连接 ${b.connection_id} 已不存在` };
      const model = role === 'decision' ? (b.model ?? DEFAULT_DECISION_MODEL) : b.model;
      const r = await this.testConnection(conn.id, model ? { model } : {});
      return { role, source: 'binding', name, ...r };
    }
    if (role === 'decision') return { role, source: 'unset', name: '', at: Date.now(), ok: false, latency_ms: null, detail: '判断要素还没绑定(需要一条 OpenRouter 连接)' };
    const slot = ROLE_FALLBACK[role];
    const brain = slot === 'main' ? this.deps.mainBrain() : this.deps.cheapBrain();
    const source: EffectiveSource = slot === 'main' ? 'fallback_main' : 'fallback_cheap';
    const started = Date.now();
    let result: ConnectionTest;
    try {
      const r = await brain.complete('你是连通性测试。只回复一个词:ok', 'ping', { timeoutMs: 90_000 });
      const ok = r.text.trim().length > 0;
      result = { at: Date.now(), ok, latency_ms: Date.now() - started, detail: this.redact(ok ? `${brain.name} 回复:${r.text.slice(0, 60)}` : `${brain.name}:无输出`) };
    } catch (e) {
      result = { at: Date.now(), ok: false, latency_ms: Date.now() - started, detail: this.redact(`${brain.name}:${(e as Error).message.slice(0, 400)}`) };
    }
    this.deps.log(result.ok ? 'info' : 'warn', `测试角色 ${role}(${source === 'fallback_main' ? '回退主脑' : '回退副脑'} ${brain.name}):${result.ok ? '通过' : '失败'} ${result.detail}`);
    return { role, source, name: brain.name, ...result };
  }

  /** OpenRouter /models 过滤出常用家族(免费的公开列表,不计费);Jev 与缺省始终在前。 */
  private async openRouterModels(_conn: ModelConnection): Promise<string[]> {
    const fetchFn = this.deps.fetchFn ?? globalThis.fetch.bind(globalThis);
    // 固定缺省地址;不跟随重定向(3xx 直接当失败)。
    const res = await fetchFn(`${KIND_DEFAULTS.openrouter.base_url!}/models`, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
    if (isRedirectResponse(res)) throw new Error(`models ${res.status} 重定向,已拒绝跟随`);
    if (!res.ok) throw new Error(`models ${res.status}`);
    const j = (await res.json()) as { data?: { id?: string }[] };
    const keep = /^(~?typesafe|deepseek|z-ai|anthropic|qwen|moonshotai|google|x-ai|minimax|meta-llama|mistralai)\//;
    const ids = (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string' && keep.test(x));
    return [...new Set([...KIND_DEFAULTS.openrouter.models, ...ids])].slice(0, 80);
  }

  // ---------------------------------------------------------------- 启动导入

  /** 有 env 文件且还没有 openrouter 连接 → 导入一条,并把 decision 绑到 Jev(decision 还没绑时)。 */
  importOpenRouterEnv(file: string): boolean {
    if (!existsSync(file)) return false;
    if (this.store.list().some((c) => c.kind === 'openrouter')) return false;
    const key = parseEnvKey(readFileSync(file, 'utf8'));
    if (!key) return false;
    if (key.length < MIN_API_KEY_LENGTH || key.length > 400 || /\s/.test(key)) {
      this.deps.log('warn', `${file} 里的 OPENROUTER_API_KEY 格式不对(${MIN_API_KEY_LENGTH}–400 字符、不能有空白),跳过导入`);
      return false;
    }
    const now = Date.now();
    const conn: ModelConnection = { id: `mc_${randomBytes(6).toString('hex')}`, kind: 'openrouter', label: 'OpenRouter(导入)', base_url: null, cli: null, key_masked: maskKey(key), status: 'untested', last_test: null, models_hint: [...KIND_DEFAULTS.openrouter.models], created_at: now, updated_at: now };
    this.store.insert(conn);
    this.vault.set(conn.id, key);
    if (!this.store.binding('decision')) this.store.setBinding('decision', conn.id, DEFAULT_DECISION_MODEL);
    this.deps.log('info', `已从 ${file} 导入 OpenRouter 连接(${conn.key_masked}),判断要素绑定 ${DEFAULT_DECISION_MODEL}`);
    return true;
  }
}

/**
 * 判断要素单次调用的价格上限(美元,十进制字符串);预算按它原子预留,所以不能太松。
 * Jev 输入 $0.042/M token、输出免费:实测 641 token ≈ $0.000027;fiapp 盘口大状态 ≈ $0.00008 → 取 $0.00015。
 */
export const JUDGE_MAX_CALL_USD = '0.00015';
/**
 * 别名钉到**带日期的快照**:judge 逐次比对响应里的 model 与配置(research/judge/index.ts model_revision_mismatch),
 * 而 `typesafe/jev-1.13` 的响应是 `typesafe/jev-1.13-20260917` —— 只钉到 1.13 会让每次判断都当成版本漂移而 skip
 * (2026-09-25 端到端:400/400 次 error)。直接请求快照名,OpenRouter 接受且原样返回;Jev 出新快照时旧策略仍请求旧快照。
 */
export const JEV_PINNED_SNAPSHOT = 'typesafe/jev-1.13-20260917';
export function pinDecisionModel(model: string): string {
  const m = model.trim().replace(/^~/, '');
  if (m === 'typesafe/jev-latest' || m === 'typesafe/jev-1.13') return JEV_PINNED_SNAPSHOT;
  return m;
}
