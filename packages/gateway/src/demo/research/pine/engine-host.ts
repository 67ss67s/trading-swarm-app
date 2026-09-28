/**
 * Pine 引擎托管器:网关进程负责拉起 / 看护 / 收掉 @trade-gate/pine-engine 子进程。
 *
 * - 端口:默认 listen 0(系统分配临时端口),子进程就绪后经 IPC(另有 stdout 一行 JSON 兜底)回报实际端口;
 *   TG_PINE_PORT 可显式指定。不再有固定 879x 端口(那是 trade-switch 的端口段)。
 * - 沙箱:Node 权限模型 `--permission`,只 `--allow-fs-read` 引擎包目录与它的依赖目录(按真实路径逐个放行),
 *   不给 fs 写 / child_process / worker / addons;子进程 env 只带引擎自己的几个变量,拿不到网关的密钥。
 * - 看护:崩溃按指数退避重启,连续失败到上限标记 down;心跳(IPC 每秒一次)断了太久 = 事件循环被脚本卡死,
 *   直接 SIGKILL 重启;子进程运行稳定一段时间后连续失败计数清零。
 * - 收摊:网关 exit 时同步杀子进程;子进程侧 IPC 断开即自行退出,网关被 SIGKILL 也不留孤儿。
 * - 开关:TG_PINE_ENGINE=0 关掉(status=disabled);启动失败不影响网关其它功能,pine_series 照旧明确报错。
 *
 * AGPL 边界:这里只 resolve 引擎包的**路径**并以独立进程启动,从不 import PineTS 或引擎代码。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type PineEngineStatus = 'up' | 'starting' | 'down' | 'disabled';

export interface PineEngineHealth {
  status: PineEngineStatus;
  pid: number | null;
  port: number | null;
  restarts: number;
  last_error: string | null;
  engine: 'pinets';
  version: string | null;
}

export interface PineEngineHostOptions {
  /** 引擎入口;默认解析 @trade-gate/pine-engine/server.js。测试可换成假引擎脚本。 */
  entry?: string;
  /** 沙箱放行的只读目录;默认 = 入口所在包 + 它的依赖树真实目录。 */
  readDirs?: string[];
  /** 显式端口;默认 0 = 临时端口。 */
  port?: number;
  enabled?: boolean;
  /** 是否用权限模型启动,默认 true。 */
  sandbox?: boolean;
  /** 连续失败上限,到了就标记 down 不再拉起。默认 5。 */
  maxRestarts?: number;
  /** 第 n 次重启前的等待,默认 500ms × 2^(n-1),封顶 30s。 */
  backoffMs?: (attempt: number) => number;
  /** 从拉起到就绪的最长等待,默认 20s。 */
  readyTimeoutMs?: number;
  /** 心跳断多久判定卡死,默认 = 单次执行超时 + 15s。 */
  hangMs?: number;
  /** 引擎内单次执行超时,默认 60s。 */
  runTimeoutMs?: number;
  /** 引擎单次响应上限,默认 16MB。 */
  maxOutputBytes?: number;
  /** 稳定运行这么久后连续失败计数清零,默认 60s。 */
  stableMs?: number;
  /** 额外传给子进程的 env(只放引擎相关变量)。 */
  env?: Record<string, string>;
  log?: (line: string) => void;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 引擎包目录:先按 workspace 包名解析,解析不到按仓库布局找(packages/gateway/{src,dist}/demo/research/pine → packages/pine-engine)。 */
export function pineEnginePackageDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return realpathSync(path.dirname(require.resolve('@trade-gate/pine-engine/package.json')));
  } catch { /* 走仓库布局兜底 */ }
  const guess = path.resolve(HERE, '..', '..', '..', '..', '..', 'pine-engine');
  return existsSync(path.join(guess, 'server.js')) ? realpathSync(guess) : null;
}

/** 包目录 + 依赖树(dependencies 递归)的真实目录;npm workspaces 会把依赖提升到根 node_modules,所以逐个放行而不是放行整个根。 */
export function sandboxReadDirs(packageDir: string): string[] {
  const dirs = new Set<string>([realpathSync(packageDir)]);
  const seen = new Set<string>();
  const find = (name: string, from: string): string | null => {
    const require = createRequire(path.join(from, 'package.json'));
    try { return realpathSync(path.dirname(require.resolve(`${name}/package.json`))); } catch { /* exports 不导出 package.json */ }
    try {
      let at = path.dirname(require.resolve(name));
      while (!existsSync(path.join(at, 'package.json')) && path.dirname(at) !== at) at = path.dirname(at);
      return realpathSync(at);
    } catch { return null; }
  };
  const walk = (dir: string): void => {
    let deps: string[] = [];
    try { deps = Object.keys((JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}); } catch { return; }
    for (const dep of deps) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const at = find(dep, dir);
      if (!at) continue;
      dirs.add(at);
      walk(at);
    }
  };
  walk(realpathSync(packageDir));
  // Node 解析依赖会沿祖先目录逐个试 <祖先>/node_modules/<dep>;这些候选路径不在放行表里时,只要该 node_modules 目录存在
  // (比如在 packages/ 下跑过 vitest 留下 packages/node_modules/.vite)就是 ERR_ACCESS_DENIED 而不是 ENOENT,引擎直接起不来(2026-09-23 实测)。
  // 放行这些候选的 package.json 文件路径(实测只放行不存在的目录不生效,显式文件路径生效;不存在也无妨),不放行整个 node_modules。
  for (let at = realpathSync(packageDir); ; at = path.dirname(at)) {
    for (const dep of seen) dirs.add(path.join(at, 'node_modules', dep, 'package.json'));
    if (path.dirname(at) === at) break;
  }
  return [...dirs];
}

export function sandboxFlags(readDirs: string[]): string[] {
  return ['--permission', ...readDirs.map((d) => `--allow-fs-read=${d}`)];
}

export class PineEngineHost {
  private child: ChildProcess | null = null;
  private status: PineEngineStatus = 'down';
  private port: number | null = null;
  private pid: number | null = null;
  private version: string | null = null;
  private lastError: string | null = null;
  private restarts = 0;
  private failures = 0;
  private stopping = false;
  private startedAt = 0;
  private lastBeat = 0;
  private timers = new Set<NodeJS.Timeout>();
  private watchdog: NodeJS.Timeout | null = null;
  private waiters: (() => void)[] = [];
  private exitHook = (): void => { try { this.child?.kill('SIGKILL'); } catch { /* 已退出 */ } };
  readonly options: Required<Omit<PineEngineHostOptions, 'entry' | 'readDirs' | 'env' | 'log'>> & Pick<PineEngineHostOptions, 'entry' | 'readDirs' | 'env' | 'log'>;

  constructor(options: PineEngineHostOptions = {}) {
    const runTimeoutMs = options.runTimeoutMs ?? 60000;
    this.options = {
      entry: options.entry, readDirs: options.readDirs, env: options.env, log: options.log,
      port: options.port ?? 0,
      enabled: options.enabled ?? true,
      sandbox: options.sandbox ?? true,
      maxRestarts: options.maxRestarts ?? 5,
      backoffMs: options.backoffMs ?? ((n) => Math.min(30000, 500 * 2 ** Math.max(0, n - 1))),
      readyTimeoutMs: options.readyTimeoutMs ?? 20000,
      hangMs: options.hangMs ?? runTimeoutMs + 15000,
      runTimeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
      stableMs: options.stableMs ?? 60000,
    };
    if (!this.options.enabled) this.status = 'disabled';
  }

  health(): PineEngineHealth {
    return {
      status: this.status, pid: this.status === 'up' || this.status === 'starting' ? this.pid : null,
      port: this.status === 'up' ? this.port : null,
      restarts: this.restarts, last_error: this.lastError, engine: 'pinets', version: this.version,
    };
  }

  /** 可用地址;没就绪返回 null。 */
  url(): string | null {
    return this.status === 'up' && this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  /** 等到 up(或确定起不来)为止;返回是否可用。 */
  async ready(timeoutMs = this.options.readyTimeoutMs): Promise<boolean> {
    if (this.status === 'up') return true;
    if (this.status !== 'starting') return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
    return (this.status as PineEngineStatus) === 'up'; // await 期间状态会变,别让 TS 按进入时收窄
  }

  start(): this {
    if (!this.options.enabled) { this.status = 'disabled'; return this; }
    if (this.child) return this;
    this.stopping = false;
    process.once('exit', this.exitHook);
    this.spawnChild();
    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.checkHealth(), 1000);
      this.watchdog.unref();
    }
    return this;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    process.removeListener('exit', this.exitHook);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
        child.once('exit', () => { clearTimeout(force); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(force); resolve(); }
      });
    }
    this.child = null;
    if (this.status !== 'disabled') this.status = 'down';
    this.pid = null;
    this.port = null;
    this.flushWaiters();
  }

  private flushWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private log(line: string): void {
    (this.options.log ?? ((l: string) => console.error(l)))(`[pine-engine] ${line}`);
  }

  private spawnChild(): void {
    const entry = this.options.entry ?? (() => {
      const dir = pineEnginePackageDir();
      return dir ? path.join(dir, 'server.js') : null;
    })();
    if (!entry || !existsSync(entry)) {
      this.status = 'down';
      this.lastError = 'pine_engine_package_missing:找不到 @trade-gate/pine-engine(在仓库根目录 npm install)';
      this.log(this.lastError);
      this.flushWaiters();
      return;
    }
    const readDirs = this.options.readDirs ?? sandboxReadDirs(path.dirname(entry));
    const args = [...(this.options.sandbox ? sandboxFlags(readDirs) : []), entry];
    const env: Record<string, string> = {
      PINE_ENGINE_PORT: String(this.options.port),
      PINE_RUN_TIMEOUT_MS: String(this.options.runTimeoutMs),
      PINE_MAX_OUTPUT_BYTES: String(this.options.maxOutputBytes),
      ...(this.options.env ?? {}),
    };
    this.status = 'starting';
    this.port = null;
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env });
    } catch (e) {
      this.onExit(null, `spawn_failed:${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.child = child;
    this.pid = child.pid ?? null;
    this.startedAt = Date.now();
    this.lastBeat = Date.now();
    let stderrTail = '';
    let stdoutBuf = '';
    const markReady = (msg: { port?: unknown; version?: unknown }): void => {
      if (this.child !== child || this.status === 'up') return;
      const port = Number(msg.port);
      if (!Number.isInteger(port) || port <= 0) return;
      this.port = port;
      this.version = typeof msg.version === 'string' ? msg.version : this.version;
      this.status = 'up';
      pineHealthObserver?.(true);
      this.lastBeat = Date.now();
      this.log(`up pid=${child.pid} port=${port} version=${this.version}`);
      this.flushWaiters();
    };
    child.on('message', (msg: { type?: string; port?: unknown; version?: unknown }) => {
      if (msg?.type === 'heartbeat') this.lastBeat = Date.now();
      else if (msg?.type === 'ready') markReady(msg);
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf = (stdoutBuf + chunk).slice(-65536);
      let at: number;
      while ((at = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, at).trim();
        stdoutBuf = stdoutBuf.slice(at + 1);
        if (!line.startsWith('{')) continue;
        try {
          const msg = JSON.parse(line) as { event?: string; port?: unknown; version?: unknown; error?: unknown };
          if (msg.event === 'ready') markReady(msg);
          else if (msg.event === 'error') stderrTail = String(msg.error ?? '');
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-2000); });
    child.on('error', (e) => { stderrTail = `${stderrTail}\n${e.message}`.slice(-2000); });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      const tail = stderrTail.trim().split('\n').filter(Boolean).slice(-4).join(' | ');
      this.onExit(child, `exit code=${code ?? 'null'} signal=${signal ?? 'null'}${tail ? `:${tail}` : ''}`.slice(0, 1200));
    });
    const readyTimer = setTimeout(() => {
      this.timers.delete(readyTimer);
      if (this.child === child && this.status === 'starting') {
        stderrTail = `${stderrTail}\npine_engine_ready_timeout:${this.options.readyTimeoutMs}ms 内没回报端口`;
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }
    }, this.options.readyTimeoutMs);
    this.timers.add(readyTimer);
  }

  private checkHealth(): void {
    const child = this.child;
    if (!child || this.status !== 'up') return;
    if (Date.now() - this.lastBeat > this.options.hangMs) {
      this.log(`heartbeat lost ${Date.now() - this.lastBeat}ms,判定卡死,SIGKILL 重启`);
      this.lastError = `pine_engine_hung:心跳中断超过 ${this.options.hangMs}ms(脚本卡死事件循环)`;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    } else if (this.failures > 0 && Date.now() - this.startedAt > this.options.stableMs) {
      this.failures = 0; // 稳定跑了一段时间,之前的失败不再累计
    }
  }

  private onExit(child: ChildProcess | null, reason: string): void {
    if (child && this.child !== child) return;
    if (!this.stopping) pineHealthObserver?.(false, reason);
    this.child = null;
    this.port = null;
    this.pid = null;
    if (this.stopping) { this.status = 'down'; this.flushWaiters(); return; }
    // 看门狗写的「卡死」原因比 exit signal=SIGKILL 更有信息量,保留它
    if (!this.lastError?.startsWith('pine_engine_hung') || !reason.includes('SIGKILL')) this.lastError = reason;
    this.failures += 1;
    if (this.failures > this.options.maxRestarts) {
      this.status = 'down';
      this.log(`连续失败 ${this.failures - 1} 次重启仍起不来,标记 down:${this.lastError}`);
      this.flushWaiters();
      return;
    }
    const wait = this.options.backoffMs(this.failures);
    this.status = 'starting';
    this.log(`退出(${reason}),${wait}ms 后第 ${this.failures} 次重启`);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopping) return;
      this.restarts += 1;
      this.spawnChild();
    }, wait);
    this.timers.add(timer);
  }
}

// ---- 进程内单例:main.ts 启动时 startPineEngine(),client / 路由从这里取地址与状态。
let host: PineEngineHost | null = null;

/** 按环境变量构造并拉起(TG_PINE_ENGINE=0 关、TG_PINE_PORT 指定端口)。重复调用返回同一个。 */
/**
 * 引擎起来/意外退出时通知网关的依赖健康(main.ts 注入 dependency-health)。用注入而不是 import:
 * 本文件要能被 `node --experimental-strip-types` 单独加载(见 engine-host.test.ts),不能带 .js→.ts 的相对依赖。
 */
let pineHealthObserver: ((ok: boolean, reason?: string) => void) | undefined;
export function setPineHealthObserver(fn: (ok: boolean, reason?: string) => void): void {
  pineHealthObserver = fn;
}

export function startPineEngine(options: PineEngineHostOptions = {}): PineEngineHost {
  if (host) return host;
  const envPort = Number(process.env['TG_PINE_PORT'] ?? '');
  host = new PineEngineHost({
    enabled: process.env['TG_PINE_ENGINE'] !== '0',
    ...(Number.isInteger(envPort) && envPort > 0 ? { port: envPort } : {}),
    ...options,
  });
  return host.start();
}
export function pineEngineHost(): PineEngineHost | null { return host; }
/** 测试用:装一个自己构造的托管器(或清空)。 */
export function setPineEngineHost(next: PineEngineHost | null): void { host = next; }
export async function stopPineEngine(): Promise<void> {
  const current = host;
  host = null;
  await current?.stop();
}

/** 没有托管器时的健康视图(测试 / 未接线):明确是 down 而不是假装 up。 */
export function pineEngineHealth(): PineEngineHealth {
  if (host) return host.health();
  return {
    status: process.env['TG_PINE_ENGINE'] === '0' ? 'disabled' : 'down',
    pid: null, port: null, restarts: 0,
    last_error: process.env['TG_PINE_ENGINE'] === '0' ? null : 'pine_engine_not_started:网关没有托管 Pine 引擎',
    engine: 'pinets', version: null,
  };
}
