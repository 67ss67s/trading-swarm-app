/** 点击配置：凭证只透传一次给 CLI，不落库、不记录 CLI 原始输出。 */
import { existsSync } from 'node:fs';
import { readFile, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bundledOkxBin, okxInvocation, okxConfigPath, defaultOkxCliBin, defaultOkxSpawn, OkxCliBackend, okxStatusView, resetOkxAvailability, type OkxSpawnFn } from './execution-okx.js';

export function mcpBin(): string {
  if (process.env['TG_OKX_MCP']) return process.env['TG_OKX_MCP'];
  const bundled = bundledOkxBin('@okx_ai/okx-trade-mcp', 'okx-trade-mcp');
  if (bundled) return bundled;
  const local = join(homedir(), '.local/bin/okx-trade-mcp');
  return existsSync(local) ? local : 'okx-trade-mcp';
}

// 1.4.7 README documents --read-only; the shared module registry names these
// modules. The flag filters their writers while retaining order/position reads.
export const MCP_READ_ARGS = ['--modules', 'market,account,spot,swap,futures,option', '--read-only'];
function installEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}
function scrubValues<T>(value: T, secrets: string[]): T {
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), v);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, scrub(item)]));
    return v;
  };
  return scrub(value) as T;
}

export class InputError extends Error {}
export class ProfilePinnedError extends Error {}
function profileName(value: unknown): string {
  if (typeof value !== 'string' || (!/^[A-Za-z0-9_-]{1,32}$/.test(value) || value.startsWith('-'))) throw new InputError('profile 只能包含字母、数字、下划线和连字符（最多 32 字符，不能以连字符开头）');
  return value;
}

// 同一进程中配置修改串行化，避免两个断开请求用旧快照覆盖对方。
let configQueue: Promise<unknown> = Promise.resolve();
function withConfigLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = configQueue.then(operation);
  configQueue = result.catch(() => {});
  return result;
}

/** 只修改目标表与顶层 default_profile；不解析或记录凭证，原子替换并限制权限。 */
export async function removeOkxProfile(configPath: string, profile: string): Promise<void> {
  profileName(profile);
  const text = await readFile(configPath, 'utf8');
  const lines = text.split(/(?<=\n)/);
  const header = /^\s*\[profiles\.(?:([A-Za-z0-9_-]+)|"([^"\\]+)"|'([^']+)')\]\s*(?:#.*)?$/;
  const remaining: string[] = [];
  let dropping = false;
  let found = false;
  let root = true;
  let defaultIndex = -1;
  let defaultName: string | undefined;
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      root = false;
      const match = header.exec(trimmed);
      const name = match?.[1] ?? match?.[2] ?? match?.[3];
      dropping = name === profile;
      if (dropping) found = true;
      else if (name) remaining.push(name);
    }
    if (dropping) continue;
    if (root) {
      const match = /^default_profile\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(trimmed);
      if (match) { defaultIndex = kept.length; defaultName = match[1] ?? match[2]; }
    }
    kept.push(line);
  }
  if (!found) throw new InputError('profile 不存在或配置格式不受支持');
  if (defaultName === profile) kept[defaultIndex] = remaining.length ? `default_profile = ${JSON.stringify(remaining[0])}\n` : '';
  const temp = `${configPath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(kept.join(''), 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(temp, configPath);
  } finally { await unlink(temp).catch(() => {}); }
}
export interface OnboardingDeps {
  configPath?: () => string;
  run?: OkxSpawnFn;
  bin?: () => string;
  status?: typeof okxStatusView;
  reset?: () => void;
  mcpBin?: () => string;
  claudeConfig?: () => Promise<string>;
}
export class OkxOnboarding {
  private configPath; private run; private bin; private status; private reset; private claudeConfig; private mcpBin;
  constructor(deps: OnboardingDeps = {}) {
    this.configPath = deps.configPath ?? okxConfigPath;
    this.mcpBin = deps.mcpBin ?? mcpBin;
    this.run = deps.run ?? defaultOkxSpawn;
    this.bin = deps.bin ?? defaultOkxCliBin;
    this.status = deps.status ?? okxStatusView;
    this.reset = deps.reset ?? resetOkxAvailability;
    this.claudeConfig = deps.claudeConfig ?? (() => readFile(join(homedir(), '.claude.json'), 'utf8'));
  }
  setup(body: Record<string, unknown>) {
    return withConfigLock(() => this.setupUnlocked(body));
  }
  private async setupUnlocked(body: Record<string, unknown>) {
    for (const key of ['api_key', 'secret_key', 'passphrase']) {
      if (typeof body[key] !== 'string' || !(body[key] as string).trim()) throw new InputError(`${key} 必须为非空字符串`);
    }
    if (body.demo !== undefined && typeof body.demo !== 'boolean') throw new InputError('demo 必须为布尔值');
    const demo = body.demo !== false;
    const site = body.site === undefined ? 'global' : body.site;
    if (!['global', 'eea', 'us', 'tr'].includes(site as string)) throw new InputError('site 必须为 global/eea/us/tr');
    const profile = profileName(body.name === undefined ? (demo ? 'okx-demo' : 'okx-live') : body.name);
    // 完全丢弃 stderr/stdout/异常原文，比按子串掩码更可靠（CLI 可能截断或转义密钥）。
    let saved = false;
    try {
      const r = await this.run(this.bin(), ['config', 'add-profile', `AK=${body.api_key}`, `SK=${body.secret_key}`, `PP=${body.passphrase}`, `demo=${demo}`, `site=${site}`, `name=${profile}`, '--force'], 20_000);
      saved = r.code === 0 && !r.spawnError && !r.timedOut;
    } catch { /* 不返回 spawn 异常中的 argv */ }
    this.reset();
    let credentials_ok = false;
    if (saved) {
      const backend = new OkxCliBackend({ bin: this.bin(), profile, demo, live: !demo, spawnFn: this.run, kv: { get: () => null, set: () => {} }, log: () => {} });
      try { await backend.checkCredentials(); credentials_ok = true; } catch { /* 只读检查，错误原文可能含密钥 */ }
    }
    const okx = { ...this.status() };
    // config show 的错误信息也不进入 setup 响应。
    if (okx.note) okx.note = 'OKX CLI 或 profile 尚不可用，请刷新检查';
    return scrubValues({ ok: saved, profile, demo, credentials_ok, ...(!saved ? { error: '保存 OKX 配置失败或超时' } : !credentials_ok ? { error: '凭证检查失败，请检查凭证、权限或网络' } : {}), okx }, [body.api_key, body.secret_key, body.passphrase] as string[]);
  }
  private validateProfile(body: Record<string, unknown>): string {
    const profile = profileName(body.profile);
    if (process.env['TG_OKX_PROFILE']) throw new ProfilePinnedError('TG_OKX_PROFILE 已固定账户，请先移除该环境变量再切换或断开连接');
    this.reset();
    if (!this.status().profiles.some(p => p.name === profile)) throw new InputError('profile 不存在');
    return profile;
  }
  use(body: Record<string, unknown>, beforeChange: () => Promise<void> = async () => {}) {
    return withConfigLock(() => this.useUnlocked(body, beforeChange));
  }
  private async useUnlocked(body: Record<string, unknown>, beforeChange: () => Promise<void>) {
    const profile = this.validateProfile(body);
    await beforeChange();
    const r = await this.run(this.bin(), ['config', 'use', profile], 20_000);
    this.reset();
    if (r.code !== 0 || r.spawnError || r.timedOut) throw new Error('切换 OKX 账户失败或超时');
    return this.status();
  }
  remove(body: Record<string, unknown>, beforeChange: () => Promise<void> = async () => {}) {
    return withConfigLock(() => this.removeUnlocked(body, beforeChange));
  }
  private async removeUnlocked(body: Record<string, unknown>, beforeChange: () => Promise<void>) {
    const profile = this.validateProfile(body);
    await beforeChange();
    await removeOkxProfile(this.configPath(), profile);
    this.reset();
    return this.status();
  }
  async install() {
    let ok = false;
    try {
      const r = await this.run('npm', ['i', '-g', '@okx_ai/okx-trade-cli@1.4.7'], 300_000, { env: installEnv() });
      ok = r.code === 0 && !r.timedOut && !r.spawnError;
      if (!ok) console.error('OKX CLI install failed:', `${r.stdout}\n${r.stderr}`.slice(-4000));
    } catch { console.error('OKX CLI installer could not be started'); }
    this.reset();
    const status = this.status();
    return { ok, cli: status.cli, version: status.version, ...(!ok ? { error: '安装 OKX CLI 失败或超时' } : {}) };
  }
  async mcp() {
    let registered = false;
    let existing = false;
    try {
      const cfg = JSON.parse(await this.claudeConfig());
      const entry = cfg.mcpServers?.['okx-trade-mcp'];
      existing = !!entry;
      const [command, args] = okxInvocation(this.mcpBin(), MCP_READ_ARGS);
      // Exact arguments prevent duplicate --modules or other overrides from
      // making a broader registration look safe.
      registered = entry?.command === command && JSON.stringify(entry.args) === JSON.stringify(args);
    } catch { /* 尚未注册 */ }
    const r = await this.run(this.mcpBin(), ['--version'], 8000).catch(() => null);
    return { cli_available: !!r && r.code === 0 && !r.spawnError && !r.timedOut, mcp_command: `okx-trade-mcp ${MCP_READ_ARGS.join(' ')}`, registered_in_claude: registered,
      ...(existing && !registered ? { reason: 'existing registration is not the gateway read-only configuration' } : {}), checked_at: Date.now() };
  }
  async registerMcp() {
    const current = await this.mcp();
    if (current.registered_in_claude) return current;
    // Use the pinned gateway dependency; never silently install an unpinned MCP.
    if (!current.cli_available) throw new Error('只读 OKX MCP 不可用，请安装网关依赖');
    if (current.reason) {
      const removed = await this.run('claude', ['mcp', 'remove', '--scope', 'user', 'okx-trade-mcp'], 20_000);
      if (removed.code !== 0 || removed.spawnError || removed.timedOut) throw new Error('移除旧 MCP 注册失败或超时');
    }
    const [command, args] = okxInvocation(this.mcpBin(), MCP_READ_ARGS);
    const r = await this.run('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'okx-trade-mcp', '--', command, ...args], 20_000);
    if (r.code !== 0 || r.spawnError || r.timedOut) throw new Error('Claude MCP 注册失败或超时');
    return this.mcp();
  }
}
