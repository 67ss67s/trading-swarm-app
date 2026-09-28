import { publicDemo, assertVisitorCannotWrite } from './public-demo.js';
import { quietCliEnv, stripCliNoise } from './cli-noise.js';
import { aspCliBlocked } from './asp-snapshot.js';
// OKX Agent Trade Kit 执行通道(docs/design/okx-atk-2026-09-20.md §4),kind = 'okx'。
//
// 模板是 execution-cli.ts 的 Binance CliBackend:spawn 官方 CLI + `--json` 解析 + 错误分类
// (transport | rejected | local_reject),写操作超时一律 ambiguous → outcome 'unknown'。
// 执行路径只传 `--profile <name>`；配置向导例外地单次透传凭证，签名与密钥持久化由 CLI 负责。
//
// 两处 OKX 特有的坑,决定了这个文件比 Binance 版厚:
//   1. 数量口径是「合约张数」,内部口径是「币的数量」——进出都要按 ctVal 换(okx/instruments.ts);
//   2. 独立挂的算法单可以带客户端 id(`swap algo place --clOrdId` → OKX 的 `algoClOrdId`),
//      **附带单(swap place 的 --slTriggerPx/--tpTriggerPx)不行** —— CLI 没有 attachAlgoClOrdId。
//      所以附带腿的 algoId 只能从父订单详情的 `attachAlgoOrds[]` 读回;读不到就是 unknown,
//      绝不按「最新的那张 reduceOnly 单」瞎认(codex-review #4)。
//
// 状态发现不打开凭证文件（断开连接按请求原子删除目标表）。profile 名与 demo 标志一律从
// `okx config show`(非 --json 的那一份,api_key 已被 CLI 掩码)解析出来(codex-review #5)。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Market, SpotHolding, AccountView, Backend, Direction, NetCheckResult, OpenOrderView, PositionView, SymbolInfo, TransportHealth } from './types.js';
import type { SymbolRules } from './gates.js';
import type { AlgoLegReceipt, EntryRequest, ExecBackend, OpenWithProtectionReceipt, OpenWithProtectionRequest, OrderReceipt, OrderStatusView, PaperEvent, ProtectionCapability, SettlementTrade, SettlementView, StopMoveRequest, StopProtection } from './execution.js';
import { compareStopPrices } from './threads.js';
import { floorToStep, mulDec, divDec, addDec, contractsToQty, instrumentOf, negDec, numToDec, qtyToContracts, rulesOf, symbolToInstId, toClOrdId } from './okx/instruments.js';
import { cachedInstruments } from './okx/instruments.js';
import { fetchExchangeInfoOkx, fetchTicker24hOkx, fetchPremiumIndexOkx, loadOkxInstruments, okxInstrument } from './market-okx.js';

/** 一次 CLI 调用的结果;注入用的最小面(测试给个 async 函数就行,不用伪造子进程对象)。 */
export interface OkxRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 超时被杀:写操作时意味着「可能已经到交易所」。 */
  timedOut?: boolean;
  /** spawn 本身失败(二进制不存在等)。 */
  spawnError?: string;
}

export type OkxSpawnFn = (bin: string, args: string[], timeoutMs: number, options?: { env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<OkxRunResult>;

export interface OkxKv {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface OkxBackendOptions {
  bin: string;
  profile: string | null;
  /** profile 里的 demo 字段;null = 没读出来(当成实盘处理,更保守)。 */
  demo: boolean | null;
  /** TG_OKX_LIVE=1 才允许非模拟盘启动(双保险)。 */
  live?: boolean;
  kv: OkxKv;
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** 测试注入;缺省 = 真的 spawn okx。 */
  spawnFn?: OkxSpawnFn;
  /** 附带保护腿成交后到挂单列表里找真实 algoId 的重试间隔(毫秒);测试传 0。缺省 800。 */
  algoResolveDelayMs?: number;
}

/** 本网关生成的客户端 id(内部 `tgd-…` 去掉连字符后)都以它开头;见 okx/instruments.ts toClOrdId。 */
const OWN_CLORD_PREFIX = 'tgd';

/** KV:cid'(clOrdId 形态) → algoId。 */
export const ALGO_KV_PREFIX = 'okx.algo.v1:';
/** KV:algoId → cid'(listAlgoOrders 反查)。 */
export const ALGO_REV_KV_PREFIX = 'okx.algo.rev.v1:';
/** KV:保护腿在真实模拟盘验证过(§7.7)。 */
export const OKX_PROTECTION_VERIFIED_KV = 'okx.protection.verified';

/** 写命令超时 20s,读 15s(§4)。 */
const WRITE_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 15_000;
/** account() 结果缓存 15s(§4 accountStalenessMs)。 */
const ACCOUNT_TTL_MS = 15_000;
const ORDER_TTL_MS = 30_000;

/**
 * 无持仓时 close 会报的 code:等价于 Binance 的 -4509,按「已经平掉了」处理。
 * **不包含 51024** —— 官方错误码表里 51024 是「账户被限制」,仓位很可能还在;
 * 把它当成已平会让 runtime 直接结束线程(codex-review #1)。仓位不存在只有 51023。
 */
const NO_POSITION_CODES = new Set(['51023', '51169']);
/**
 * 「请求结果未知」的 code:官方明说 50004 超时既不代表成功也不代表失败,必须去查。
 * 写请求命中它一律 ambiguous → outcome 'unknown',沿原 clOrdId 对账(codex-review #2)。
 */
const AMBIGUOUS_CODES = new Set(['50004']);
/**
 * 单页上限(结算的覆盖证明用)。CLI 不透传 begin/end/after,所以每个接口只拿得到最新一页:
 * `swap fills` 不带 limit → v5 默认 100;`--archive` 时 CLI 自己填 20;
 * `account bills` 我们显式传 `--limit 100`(v5 的上限)。
 */
const FILL_PAGE = 100;
const FILL_ARCHIVE_PAGE = 20;
const BILL_PAGE = 100;

/**
 * 这一页能不能证明覆盖了 `startMs`?两种情况算覆盖:没满页(后面没有更旧的了),
 * 或者最旧一条已经落在窗口起点之前。否则起点之前的记录被挤掉了,数据不完整(codex-review #11)。
 */
export function coversWindow(rows: Record<string, unknown>[], pageCap: number, startMs: number): boolean {
  if (rows.length < pageCap) return true;
  const oldest = rows.reduce((min, r) => Math.min(min, Number(r['ts'] ?? Number.POSITIVE_INFINITY)), Number.POSITIVE_INFINITY);
  return Number.isFinite(oldest) && oldest <= startMs;
}

/**
 * 从**父订单详情**里取附带 TP/SL 的 algoId(v5 `GET /api/v5/trade/order` 的 `attachAlgoOrds[]`,
 * 成员字段 `attachAlgoId` / `attachAlgoClOrdId`;老一点的返回体用 `linkedAlgoOrd.algoId`)。
 * 拿不到就返回 null —— 调用方必须输出 'unknown',不许拿别的单顶上(codex-review #4)。
 */
export function attachedAlgoIdOf(raw: unknown): string | null {
  const o = raw as Record<string, unknown> | null | undefined;
  if (!o) return null;
  const attached = o['attachAlgoOrds'];
  if (Array.isArray(attached)) {
    for (const row of attached) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const id = String(r['attachAlgoId'] ?? r['algoId'] ?? '');
      if (id) return id;
    }
  }
  const linked = o['linkedAlgoOrd'] as Record<string, unknown> | undefined;
  const linkedId = linked && typeof linked === 'object' ? String(linked['algoId'] ?? '') : '';
  return linkedId || null;
}

/** 撤单时表示「这张单不在了」的 code。 */
const ORDER_GONE_CODES = new Set(['51400', '51401', '51402']);
/** 订单不存在(getOrder → null)。 */
const ORDER_NOT_FOUND_CODES = new Set(['51603']);

export const OKX_SETUP_GUIDE = [
  '1. 在本页配置表单填写 OKX API 凭证，选择模拟盘或实盘。',
  '2. 模拟盘请先到 OKX 网页领取模拟金，再刷新账户。',
  '3. 使用账户列表切换或断开连接；CLI 已随网关内置。',
].join('\n');

/** npm postinstall 尝试下载 Pilot/auth；API key 签名不需要 auth，Pilot 缺失可直连。 */
export function bundledOkxBin(pkg: string, command: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${pkg}/package.json`);
    const meta = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: string | Record<string, string> };
    const entry = typeof meta.bin === 'string' ? meta.bin : meta.bin[command];
    if (!entry) return null;
    const bin = path.resolve(path.dirname(manifest), entry);
    return existsSync(bin) ? bin : null;
  } catch { return null; }
}

/** 使用网关自己的 Node，避免依赖 PATH 中的 node 或全局 npm 安装。 */
export function okxInvocation(bin: string, args: string[]): [string, string[]] {
  return /\.[cm]?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

export function defaultOkxCliBin(): string {
  if (process.env['TG_OKX_CLI']) return process.env['TG_OKX_CLI'];
  const bundled = bundledOkxBin('@okx_ai/okx-trade-cli', 'okx');
  if (bundled) return bundled;
  const local = path.join(os.homedir(), '.local', 'bin', 'okx');
  return existsSync(local) ? local : 'okx';
}

/** 仅断开连接时编辑；状态发现仍由 CLI 输出掩码元数据。 */
export function okxConfigPath(): string {
  return path.join(os.homedir(), '.okx', 'config.toml');
}

export interface OkxProfileView { name: string; demo: boolean; is_default: boolean }
type Availability = { available: boolean; note?: string; demo: boolean | null; profile: string | null; version: string | null; cli: string; profiles: OkxProfileView[] };

export interface OkxConfigView {
  exists: boolean;
  /** 配置里出现过的 profile 名。 */
  profiles: string[];
  defaultProfile: string | null;
  /** profile 名 → demo 标志。 */
  demo: Record<string, boolean>;
  error?: string;
}

/**
 * 解析 `okx config show`(**不带 --json**)的输出。
 *
 * 为什么不是 `--json`:CLI 的 `cmdConfigShow` 在 `--json` 分支直接 `printJson(readFullConfig())`,
 * 把 api_key/secret_key/passphrase 原样吐出来;只有人类可读的那一份走 `maskSecret()`。
 * 掩码版印的恰好就是我们要的三样:`default_profile: <name>`、`[<profile>]`、`demo: true|false`。
 *
 * 文本形如:
 *   Config: /Users/x/.okx/config.toml
 *   default_profile: tg-demo
 *   [tg-demo]
 *     api_key:    ****abcd
 *     demo:       true
 *     base_url:   (default)
 */
export function parseOkxConfigShow(text: string): OkxConfigView {
  const profiles: string[] = [];
  const demo: Record<string, boolean> = {};
  let current: string | null = null;
  let defaultProfile: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    // `[default]` 是一个**合法的 profile 名**,不是容器段:这份输出里方括号行只可能是 profile(codex-review #14)。
    const section = /^\[([^\]]+)\]$/.exec(t);
    if (section) {
      const name = section[1]!.trim();
      current = name;
      if (!profiles.includes(name)) profiles.push(name);
      continue;
    }
    const dp = /^default_profile\s*:\s*(.+)$/.exec(t);
    if (dp) {
      const v = dp[1]!.trim();
      if (v && v !== '(not set)') defaultProfile = v;
      continue;
    }
    // CLI 1.4.7 的 `config show` 打的是 `demo   true`(对齐空格,没冒号);旧版是 `demo: true`,两种都认。
    const d = /^demo\s*[:=]?\s*(true|false)\b/.exec(t);
    if (d && current) demo[current] = d[1] === 'true';
  }
  return { exists: profiles.length > 0 || defaultProfile !== null, profiles, defaultProfile, demo };
}

/**
 * profile 名与 demo 标志(§1、§5)。**网关不打开凭证文件** —— 跑一次 `okx config show`,
 * 由持有密钥的那个进程(CLI 自己)把掩码后的元数据交出来(codex-review #5)。
 * 残留面:进程内只出现 profile 名、default_profile、demo 布尔与掩码后的 `****abcd` 尾四位;
 * secret_key/passphrase 在掩码版输出里根本不印,所以配置发现路径不接收它们（配置向导单次透传除外）。
 */
export function readOkxConfig(bin = defaultOkxCliBin()): OkxConfigView {
  try {
    const r = spawnSync(...okxInvocation(bin, ['config', 'show']), { stdio: ['ignore', 'pipe', 'pipe'], timeout: 8_000, encoding: 'utf8' });
    if (r.error) return { exists: false, profiles: [], defaultProfile: null, demo: {}, error: r.error.message };
    return okxConfigFromOutput(String(r.stdout ?? ''), String(r.stderr ?? ''), r.status);
  } catch (e) {
    return { exists: false, profiles: [], defaultProfile: null, demo: {}, error: (e as Error).message };
  }
}

function okxConfigFromOutput(stdout: string, stderr: string, status: number | null): OkxConfigView {
  const view = parseOkxConfigShow(stdout);
  if (!view.exists && status !== 0) return { ...view, error: stderr.trim().slice(0, 200) || `okx config show exit ${status}` };
  return view;
}

/** TG_OKX_PROFILE 优先,否则 config 的 default_profile,再否则第一个 profile。 */
export function resolveOkxProfile(cfg: OkxConfigView): string | null {
  return process.env['TG_OKX_PROFILE'] ?? cfg.defaultProfile ?? cfg.profiles[0] ?? null;
}

let availCache: { at: number; key: string; result: Availability } | null = null;
/** reset 时加一;后台刷新回来发现代数变了就丢弃结果,免得旧 profile 覆盖 reset 后的新发现。 */
let availGen = 0;
let availRefreshing = false;

type OkxProbe = { binOk: boolean; cfg: OkxConfigView; version: string | null };

/**
 * okx 通道现在能不能用:二进制在不在 + config 能不能解析 + profile 存不存在。
 * 缓存 60s(executionView 调用很频繁,不能每次 spawn)。只有首次(或 reset / 换 key 后)同步探测;
 * 过期后先回旧结果、后台异步重探 —— 同步 spawn `okx config show` + `okx --version` 每次要卡住事件循环几秒,
 * 期间所有 HTTP 请求一起排队(页面上表现为各 tab 转圈/没数据)。
 */
export function okxAvailability(bin = defaultOkxCliBin(), wantProfile?: string | null): Availability {
  const key = `${bin}|${wantProfile ?? ''}|${okxConfigPath()}|${process.env['TG_OKX_PROFILE'] ?? ''}`;
  if (availCache && availCache.key === key) {
    if (Date.now() - availCache.at >= 60_000 && !availRefreshing) void refreshOkxAvailability(bin, wantProfile, key);
    return availCache.result;
  }
  let result: Availability;
  try {
    const binOk = bin.includes('/') ? existsSync(bin) : which(bin);
    // 二进制都没有就别 spawn 了:config 元数据只能由 CLI 自己交出来。
    const cfg: OkxConfigView = binOk ? readOkxConfig(bin) : { exists: false, profiles: [], defaultProfile: null, demo: {} };
    result = availabilityFrom(bin, wantProfile, { binOk, cfg, version: binOk ? okxVersion(bin) : null });
  } catch {
    result = availabilityFailed(bin, wantProfile);
  }
  availCache = { at: Date.now(), key, result };
  return result;
}

async function refreshOkxAvailability(bin: string, wantProfile: string | null | undefined, key: string): Promise<void> {
  const gen = availGen;
  availRefreshing = true;
  let result: Availability;
  try {
    const binOk = bin.includes('/') ? existsSync(bin) : (await runQuiet('which', [bin], 8_000)).status === 0;
    let cfg: OkxConfigView = { exists: false, profiles: [], defaultProfile: null, demo: {} };
    let version: string | null = null;
    if (binOk) {
      const [c, v] = await Promise.all([runQuiet(...okxInvocation(bin, ['config', 'show']), 8_000), runQuiet(...okxInvocation(bin, ['--version']), 8_000)]);
      cfg = c.error ? { ...cfg, error: c.error } : okxConfigFromOutput(c.stdout, c.stderr, c.status);
      version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null;
    }
    result = availabilityFrom(bin, wantProfile, { binOk, cfg, version });
  } catch {
    result = availabilityFailed(bin, wantProfile);
  } finally {
    availRefreshing = false;
  }
  if (gen === availGen && availCache?.key === key) availCache = { at: Date.now(), key, result };
}

function availabilityFrom(bin: string, wantProfile: string | null | undefined, { binOk, cfg, version }: OkxProbe): Availability {
  const profile = wantProfile === undefined ? resolveOkxProfile(cfg) : wantProfile;
  const profiles: OkxProfileView[] = cfg.profiles.map(name => ({ name, demo: cfg.demo[name] === true, is_default: name === cfg.defaultProfile }));
  const demo = profile ? (cfg.demo[profile] ?? null) : null;
  if (!binOk) return { available: false, note: `OKX 组件不可用，请尝试重新安装。\n${OKX_SETUP_GUIDE}`, demo, profile, version, cli: bin, profiles };
  if (!cfg.exists) return { available: false, note: `请使用本页表单连接 OKX 账户。\n${OKX_SETUP_GUIDE}`, demo, profile, version, cli: bin, profiles };
  if (cfg.error) return { available: false, note: `无法读取 OKX 配置，请重新连接账户。`, demo, profile, version, cli: bin, profiles };
  if (!profile) return { available: false, note: `尚未连接 OKX 账户，请填写本页配置表单。\n${OKX_SETUP_GUIDE}`, demo, profile, version, cli: bin, profiles };
  if (cfg.profiles.length && !cfg.profiles.includes(profile)) return { available: false, note: `指定的 OKX 账户配置不存在，请在本页重新连接或切换。`, demo, profile, version, cli: bin, profiles };
  return { available: true, demo, profile, version, cli: bin, profiles };
}

function availabilityFailed(bin: string, wantProfile: string | null | undefined): Availability {
  return { available: false, note: `检查 OKX 组件失败，请刷新或重新安装。`, demo: null, profile: wantProfile ?? null, version: null, cli: bin, profiles: [] };
}

/** 异步跑一个短命令收 stdout/stderr;超时杀掉。不抛错。 */
function runQuiet(file: string, args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ status: null, stdout, stderr, error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

/** 测试用:丢掉可用性缓存。 */
export function resetOkxAvailability(): void {
  availCache = null;
  availGen += 1;
}

function which(bin: string): boolean {
  try {
    return spawnSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).status === 0;
  } catch {
    return false;
  }
}

function okxVersion(bin: string): string | null {
  try {
    const r = spawnSync(...okxInvocation(bin, ['--version']), { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8_000 });
    const m = /(\d+\.\d+\.\d+)/.exec(String(r.stdout ?? ''));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 错误

export class OkxCliError extends Error {
  constructor(
    public readonly kind: 'transport' | 'rejected' | 'local_reject',
    message: string,
    /** OKX 的 sCode/code,字符串('51008');解析不出来就 null。 */
    public readonly code: string | null,
    public readonly ambiguous: boolean,
  ) {
    super(message);
  }
}

function isRejectedWith(e: unknown, codes: Set<string>): boolean {
  return e instanceof OkxCliError && e.kind === 'rejected' && e.code !== null && codes.has(e.code);
}

/** 几个值得给人话提示的 code(§4)。 */
function codeHint(code: string | null): string {
  if (code === '51008') return '(保证金/余额不足)';
  if (code === '50111' || code === '50113') return '(API key 无效或权限不够,跑 okx config init 重配)';
  if (code === '51000') return '(参数错误)';
  if (code === '50004') return '(请求超时,交易所未给出结果:可能已成交,按未知对账)';
  if (code === '51024') return '(账户被限制,不代表仓位已平)';
  return '';
}

// ---------------------------------------------------------------- 默认 spawn

export const defaultOkxSpawn: OkxSpawnFn = (bin, args, timeoutMs, options) =>
  new Promise<OkxRunResult>((resolve) => {
    if (options?.signal?.aborted) {
      resolve({ code: 1, stdout: '', stderr: '', spawnError: 'aborted' });
      return;
    }
    if (aspCliBlocked(bin)) {
      resolve({ code: 1, stdout: '', stderr: '', spawnError: 'asp_snapshot_mode' }); // 快照模式:不启动 onchainos / okx-a2a
      return;
    }
    let child;
    try {
      child = spawn(...okxInvocation(bin, args), { stdio: ['ignore', 'pipe', 'pipe'], env: options?.env ?? quietCliEnv() });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: '', spawnError: (e as Error).message });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: OkxRunResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abort);
      resolve(r);
    };
    const abort = () => {
      child.kill('SIGKILL');
      finish({ code: 1, stdout: '', stderr: '', spawnError: 'aborted' });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: 124, stdout: out, stderr: err, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', (e) => finish({ code: 1, stdout: out, stderr: err, spawnError: e.message }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout: out, stderr: err }));
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
  });

// ---------------------------------------------------------------- backend

export class OkxCliBackend implements ExecBackend {
  readonly kind: Backend = 'okx';
  acctLv: 1 | 2 | 3 | 4 | null = null;
  private holdings: SpotHolding[] = [];
  marketsSupported(): Market[] { return this.acctLv === 1 ? ['spot'] : ['perp', 'spot']; }
  marketRejection(market: Market): string | null { return market === 'perp' && this.acctLv === 1 ? 'perp_unavailable_account_mode' : null; }
  private localReject(error: string): OrderReceipt { return { outcome: 'failed', receipt: { kind: 'local_reject', code: error }, avg_price: null, error }; }
  async spotHoldings(): Promise<SpotHolding[]> { await this.account(); return this.holdings; }

  private readonly spawnFn: OkxSpawnFn;
  /**
   * OKX 的 tdMode 是**每张单**指定的,没有「账户级仓位模式」可改:记在这里,下单时用(§4 setMarginType)。
   * 必须按 symbol 存 —— 一个实例上 BTC 用 isolated、ETH 用 cross 是常态,共用一个字段会让
   * 后开的币把先开的币的模式改掉,平仓/保护腿再按错的模式去找仓位(codex-review #6)。
   */
  private readonly marginModes = new Map<string, 'cross' | 'isolated'>();
  /** 每个 symbol 最后一次请求的杠杆:模式变了要在新模式下重设一次(OKX 的杠杆是按 instId+mgnMode 存的)。 */
  private readonly leverages = new Map<string, number>();
  private accountCache: { at: number; view: AccountView } | null = null;
  private accountInflight: Promise<AccountView> | null = null;
  private orderCache = new Map<string, { at: number; view: OrderStatusView | null }>();
  private rulesCache = new Map<string, SymbolRules>();
  private symbolsCache: { at: number; rows: SymbolInfo[] } | null = null;
  private health = { runs: 0, transport: 0, last: null as string | null, lastAt: null as number | null, since: Date.now() };

  constructor(private readonly opts: OkxBackendOptions) {
    this.spawnFn = opts.spawnFn ?? defaultOkxSpawn;
  }

  // ------------------------------------------------------------ 生命周期

  async start(): Promise<void> {
    // 双保险:profile 不是模拟盘时,必须显式 TG_OKX_LIVE=1 才放行(§1)。demo 读不出来按实盘算。
    if (this.opts.demo !== true && !this.opts.live) {
      throw new Error(`OKX profile「${this.opts.profile ?? '(默认)'}」不是模拟盘(demo=${String(this.opts.demo)}),拒绝启动。开发期请用 demo=true 的 profile;真要连实盘,启动时设 TG_OKX_LIVE=1。`);
    }
    const cfg = (await this.run(['account', 'config'], { timeoutMs: READ_TIMEOUT_MS })) as { posMode?: string; acctLv?: string }[];
    const lv = Number(cfg[0]?.acctLv);
    this.acctLv = [1,2,3,4].includes(lv) ? lv as 1|2|3|4 : null;
    const posMode = String(cfg[0]?.posMode ?? '');
    if (this.acctLv !== 1 && posMode && posMode !== 'net_mode') {
      throw new Error(`OKX 账户是 ${posMode},本适配层只支持单向持仓。跑一次:okx account set-position-mode --posMode net_mode(网关不会自动改你的账户设置)。`);
    }
    this.opts.log('info', `okx CLI ready (profile=${this.opts.profile ?? 'default'}, demo=${String(this.opts.demo)}, posMode=${posMode || 'unknown'}, acctLv=${String(cfg[0]?.acctLv ?? '?')})`);
    // 合约表走公共 REST(不需要 key、不用再 spawn 一个进程);拉不到不致命,下单前还会按需再拉。
    try {
      const rows = await loadOkxInstruments();
      await loadOkxInstruments(false, 'spot');
      this.opts.log('info', `OKX 合约表 ${rows.length} 个 USDT 本位永续`);
    } catch (e) {
      this.opts.log('warn', `拉 OKX 合约表失败(下单时会重试):${(e as Error).message}`);
    }
  }

  /**
   * 重新读 `account config` 刷新 acctLv(用户在 OKX 网页切完账户模式后,前端轮询这里让永续亮起来,不用重启网关)。
   * 只读;读失败保持旧值并抛错。
   */
  async refreshAccountLevel(): Promise<1 | 2 | 3 | 4 | null> {
    const cfg = (await this.run(['account', 'config'], { timeoutMs: READ_TIMEOUT_MS })) as { acctLv?: string }[];
    const lv = Number(cfg[0]?.acctLv);
    const next = [1, 2, 3, 4].includes(lv) ? (lv as 1 | 2 | 3 | 4) : null;
    if (next !== this.acctLv) {
      this.opts.log('info', `OKX 账户模式变化:acctLv ${String(this.acctLv)} → ${String(next)}`);
      this.acctLv = next;
      this.invalidateAccount();
    }
    return next;
  }

  async stop(): Promise<void> {}

  // ------------------------------------------------------------ CLI

  /**
   * 跑一条 okx 命令,返回 v5 的 data 数组(`--json` 原样输出它)。
   * 失败分类与 Binance 版一致:写操作超时/非 JSON = ambiguous,调用方按 'unknown' 处理。
   */
  private async run(args: string[], opts: { write?: boolean; timeoutMs?: number } = {}): Promise<unknown[]> {
    const write = opts.write === true;
    if (publicDemo() && this.opts.live) throw new Error('public_demo_live_disabled');
    if (write) assertVisitorCannotWrite();
    if (write && args[0] === 'swap' && this.acctLv === 1) throw new OkxCliError('local_reject', 'perp_unavailable_account_mode', 'perp_unavailable_account_mode', false);
    const timeoutMs = opts.timeoutMs ?? (write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
    // 全局参数必须在 module 前面:okx [--profile x] [--demo] [--json] <module> <action>
    //
    // `--demo` 不是可选的保险,是**唯一**能保证「启动检查看到的模拟盘」就是「命令实际打的环境」的东西:
    // `--profile` 只从 CLI 写死的 ~/.okx/config.toml 里选名字,同名 profile 在别处可以是实盘。
    // 只有明确 TG_OKX_LIVE=1 且 profile 自己就不是 demo 时才不带(CLI 里 --demo/--live 互斥;
    // live=1 但 profile 是 demo 的组合仍然按模拟盘走,不替用户升实盘)(codex-review #3)。
    const demoFlag = this.opts.live === true && this.opts.demo !== true ? [] : ['--demo'];
    const full = [...(this.opts.profile ? ['--profile', this.opts.profile] : []), ...demoFlag, '--json', ...args];
    this.health.runs++;
    const raw = await this.spawnFn(this.opts.bin, full, timeoutMs);
    // 版本更新提醒 / Node 实验警告不是命令结果(cli-noise.ts):不剥掉会把正常的查询判成失败。
    const r = { ...raw, stdout: stripCliNoise(raw.stdout ?? ''), stderr: stripCliNoise(raw.stderr ?? '') };
    if (r.spawnError) {
      this.noteTransport(`spawn okx failed: ${r.spawnError}`);
      throw new OkxCliError('transport', `spawn okx 失败:${r.spawnError}`, null, false);
    }
    if (r.timedOut) {
      this.noteTransport(`okx ${args.slice(0, 2).join(' ')} timed out`);
      throw new OkxCliError('transport', `okx ${args.slice(0, 2).join(' ')} 超时 ${timeoutMs}ms`, null, write);
    }
    const text = (r.stdout || '').trim() || (r.stderr || '').trim();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    // CLI 出错时也可能吐 JSON:{code,msg} 或 [{sCode,sMsg}]
    const failure = extractFailure(parsed);
    if (failure) {
      const message = `${failure.code} ${failure.msg}${codeHint(failure.code)}`.trim();
      // 50004 必须在通用拒单分类**之前**认出来:它不是拒单,是「不知道成没成」。
      if (AMBIGUOUS_CODES.has(failure.code)) throw new OkxCliError('transport', message, failure.code, write);
      throw new OkxCliError('rejected', message, failure.code, false);
    }
    if (r.code !== 0) {
      const msg = ((r.stderr || r.stdout) ?? '').trim().slice(-400) || `exit ${r.code}`;
      // 纯文本错误里也可能只印出 code:同样先认 50004(codex-review #2)。
      const plainAmbiguous = [...AMBIGUOUS_CODES].find((c) => new RegExp(`\\b${c}\\b`).test(msg));
      if (plainAmbiguous) throw new OkxCliError('transport', `${msg}${codeHint(plainAmbiguous)}`, plainAmbiguous, write);
      // 根本没发出去:没配 profile、参数不合法、命令不存在。
      const localReject = /profile .*not found|no such profile|Unknown (?:argument|command)|Either --|is required|config init|credential|api[_ ]?key/i.test(msg);
      if (localReject) throw new OkxCliError('local_reject', msg, null, false);
      const looksRejected = /"?s?[Cc]ode"?\s*[:=]\s*"?5\d{4}|"msg"|Invalid|invalid parameter/.test(msg);
      if (!looksRejected) this.noteTransport(msg);
      // 09-26 stuck-entry:CLI 1.4.x 出错时即使带 --json 也只在 stderr 印纯文本
      // (`Error: Order does not exist\nCode: 51603`,前面还夹着升级提示)。以前这里 code 恒为 null,
      // 于是 getOrder 认不出 51603、把「交易所明确说没有这张单」当成「读不到」抛出去,巡检永远不计 miss。
      const plainCode = looksRejected ? /(?:^|\n)\s*Code:\s*(5\d{4})\s*(?:\n|$)/.exec(msg)?.[1] ?? null : null;
      throw new OkxCliError(looksRejected ? 'rejected' : 'transport', plainCode ? `${msg}${codeHint(plainCode)}` : msg, plainCode, write && !looksRejected);
    }
    if (parsed === null) {
      if (!text) return [];
      this.noteTransport(`unparseable output: ${text.slice(0, 120)}`);
      throw new OkxCliError('transport', `okx 输出不是 JSON:${text.slice(0, 200)}`, null, write);
    }
    return Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  }

  /** 这个 symbol 下单用的 tdMode(没设过就是 cross,和 OKX 的默认一致)。 */
  private mgnModeOf(symbol: string): 'cross' | 'isolated' {
    return this.marginModes.get(symbol) ?? 'cross';
  }

  /**
   * 平仓/保护腿要用**仓位实际的** mgnMode,不是我们本地记的那个:
   * 仓位可能是上一轮、甚至别的实例按别的模式开的(codex-review #6)。
   * 返回 undefined = 这个合约当前没有仓位。
   */
  private async positionRow(instId: string): Promise<Record<string, unknown> | undefined> {
    const rows = (await this.run(['account', 'positions', '--instType', 'SWAP', '--instId', instId])) as Record<string, unknown>[];
    return rows.find((r) => Number(r['pos'] ?? '0') !== 0);
  }

  private noteTransport(message: string): void {
    this.health.transport++;
    this.health.last = message.slice(0, 200);
    this.health.lastAt = Date.now();
  }

  transportHealth(): TransportHealth {
    return { window_ms: Date.now() - this.health.since, runs: this.health.runs, transport_errors: this.health.transport, last_error: this.health.last, last_at: this.health.lastAt };
  }

  // ------------------------------------------------------------ 行情(公共 REST,不走 CLI)

  async symbols(market: Market = 'perp'): Promise<SymbolInfo[]> {
    return fetchExchangeInfoOkx(market);
  }

  async symbolRules(symbol: string, market: Market = 'perp'): Promise<SymbolRules> {
    return rulesOf(await okxInstrument(symbol, market), await this.markPrice(symbol, market));
  }

  async markPrice(symbol: string, market: Market = 'perp'): Promise<string> {
    if (market === 'spot') return (await fetchTicker24hOkx(symbol, market)).lastPrice;
    const pi = await fetchPremiumIndexOkx(symbol);
    return Number(pi.markPrice).toString();
  }

  // ------------------------------------------------------------ 账户

  accountStalenessMs(): number {
    // 缓存 TTL + 一次 CLI 起进程/排队的余量:风控的 30s 门槛在这条通道上会在每次 spawn 期间误报「组件过期」
    // (2026-09-20 楼层上看到的那条),按 agent 通道的口径给足余量。
    return ACCOUNT_TTL_MS + 30_000;
  }

  invalidateAccount(): void {
    this.accountCache = null;
  }

  /** 配置向导只查余额，不加载行情或改变账户设置。 */
  async checkCredentials(): Promise<void> {
    await this.run(['account', 'balance']);
  }

  async account(): Promise<AccountView> {
    if (this.accountCache && Date.now() - this.accountCache.at < ACCOUNT_TTL_MS) return this.accountCache.view;
    if (this.accountInflight) return this.accountInflight;
    this.accountInflight = this.readAccount().finally(() => {
      this.accountInflight = null;
    });
    return this.accountInflight;
  }

  private async readAccount(): Promise<AccountView> {
    // 张数 → 币要 ctVal:合约表没加载就先拉一次,拉不到下面 toCoin() 会硬失败(codex-review #10)。
    await this.ensureInstruments();
    // 五次只读调用可并发(§4);算法单两种 ordType 只能分开问。
    //
    // **算法单查询失败必须让整个快照失败**:把错误吞成 `[]` 等于对巡检说「此刻没有保护单」,
    // 巡检会据此判止损缺失并补挂一张(codex-review #9)。查不到 ≠ 没有。
    const [balRaw, posRaw, ordRaw, condRaw, ocoRaw, spotOrd, spotCond, spotOco] = await Promise.all([
      this.run(['account', 'balance']),
      this.acctLv === 1 ? Promise.resolve([]) : this.run(['account', 'positions', '--instType', 'SWAP']),
      this.acctLv === 1 ? Promise.resolve([]) : this.run(['swap', 'orders']),
      this.acctLv === 1 ? Promise.resolve([]) : this.run(['swap', 'algo', 'orders', '--ordType', 'conditional']),
      this.acctLv === 1 ? Promise.resolve([]) : this.run(['swap', 'algo', 'orders', '--ordType', 'oco']),
      this.run(['spot', 'orders']),
      this.run(['spot', 'algo', 'orders', '--ordType', 'conditional']),
      this.run(['spot', 'algo', 'orders', '--ordType', 'oco']),
    ]);
    const bal = (balRaw[0] ?? {}) as { totalEq?: string; details?: { ccy?: string; eq?: string; availBal?: string; frozenBal?: string; eqUsd?: string; upl?: string }[] };
    const usdt = (bal.details ?? []).find((d) => d.ccy === 'USDT');
    const equity = Number(usdt?.eq ?? bal.totalEq ?? '0');
    const available = Number(usdt?.availBal ?? '0');
    const upl = Number(usdt?.upl ?? '0');

    const positions: PositionView[] = [];
    for (const row of posRaw as Record<string, unknown>[]) {
      const instId = String(row['instId'] ?? '');
      const symbol = symbolOf(instId);
      const pos = Number(row['pos'] ?? '0');
      if (!Number.isFinite(pos) || pos === 0) continue;
      positions.push({
        symbol, market: 'perp',
        // net 模式下 pos 的正负就是方向(§4);账户若是双向模式 start() 已经拦下了。
        side: pos > 0 ? 'long' : 'short',
        qty: this.toCoin(Math.abs(pos), symbol),
        entry_price: Number(row['avgPx'] ?? '0').toString(),
        mark_price: Number(row['markPx'] ?? '0').toString(),
        unrealized_pnl: Number(row['upl'] ?? '0').toFixed(2),
        leverage: Number(row['lever'] ?? '0'),
      });
    }

    const open_orders: OpenOrderView[] = [];
    for (const o of [...ordRaw, ...spotOrd] as Record<string, unknown>[]) {
      const market: Market = String(o['instId']).endsWith('-SWAP') ? 'perp' : 'spot';
      const symbol = symbolOf(String(o['instId'] ?? ''));
      open_orders.push({
        symbol, market,
        client_order_id: String(o['clOrdId'] ?? o['ordId'] ?? ''),
        // runtime 全系统用的是 Binance 的大写词表(LIMIT/MARKET、BUY/SELL),OKX 给的是小写。
        type: String(o['ordType'] ?? '').toUpperCase(),
        side: String(o['side'] ?? '').toUpperCase(),
        qty: this.toCoin(o['sz'], symbol, market),
        price: Number(o['px'] ?? '0') > 0 ? String(o['px']) : null,
        stop_price: null,
        reduce_only: (market === 'spot' && String(o['side']).toLowerCase() === 'sell') || String(o['reduceOnly'] ?? '') === 'true',
        status: String(o['state'] ?? ''),
      });
    }
    for (const a of [...(condRaw as Record<string, unknown>[]), ...(ocoRaw as Record<string, unknown>[]), ...(spotCond as Record<string, unknown>[]), ...(spotOco as Record<string, unknown>[])]) {
      open_orders.push(this.algoToOrderView(a, String(a['instId']).endsWith('-SWAP') ? 'perp' : 'spot'));
    }
    this.holdings = [];
    let spotValue = '0';
    let fallbackCost = false;
    for (const d of bal.details ?? []) {
      if (!d.ccy || d.ccy === 'USDT') continue;
      const total = addDec(d.availBal || '0', d.frozenBal || '0');
      if (!(Number(total) > 0)) continue;
      const symbol = `${d.ccy}USDT`;
      await loadOkxInstruments(false, 'spot');
      const inst = instrumentOf(symbol, 'spot');
      this.holdings.push({ ccy: d.ccy, total, available: d.availBal || '0', usdt_value: d.eqUsd ?? null });
      if (!inst || Number(total) < Number(inst.minSz)) continue;
      const mark = await this.markPrice(symbol, 'spot');
      const value = mulDec(total, mark); spotValue = addDec(spotValue, value);
      const holding = this.holdings[this.holdings.length - 1]!; holding.usdt_value ??= value;
      // 完整近期成交只能提供成本线索;缺历史时显式退回 last。
      const recent = await this.settlement(symbol, Date.now() - 3 * 86_400_000 + 60_000, Date.now(), true, 'spot');
      const lots: {qty:string; price:string}[] = [];
      for (const f of recent?.trades ?? []) {
        if (f.side === 'BUY') lots.push({qty:f.qty,price:f.price});
        else {
          let sell = f.qty;
          while (Number(sell) > 0 && lots.length) {
            const lot = lots[0]!;
            const used = Number(lot.qty) < Number(sell) ? lot.qty : sell;
            sell = addDec(sell,negDec(used)); lot.qty = addDec(lot.qty,negDec(used));
            if (Number(lot.qty) === 0) lots.shift();
          }
        }
      }
      const qty = lots.reduce((v,l) => addDec(v,l.qty),'0');
      const cost = lots.reduce((v,l) => addDec(v,mulDec(l.qty,l.price)),'0');
      const entry = Number(qty) >= Number(total) ? divDec(cost, qty, 18) : mark;
      if (entry === mark) fallbackCost = true;
      positions.push({ symbol, market: 'spot', side: 'long', qty: total, entry_price: entry, mark_price: mark,
        unrealized_pnl: mulDec(addDec(mark, negDec(entry)), total), leverage: 1 });
    }
    const view: AccountView = {
      backend: this.kind,
      equity: addDec(equity.toFixed(2), spotValue),
      available: available.toFixed(2),
      unrealized_pnl: positions.filter(p => p.market === 'spot').reduce((sum,p) => addDec(sum,p.unrealized_pnl), upl.toFixed(2)),
      positions,
      note: fallbackCost ? '现货成本历史不足，部分持币成本暂按最新价估计' : null,
      open_orders,
      as_of: Date.now(),
    };
    this.accountCache = { at: Date.now(), view };
    return view;
  }

  /**
   * 算法单 → 挂单视图。**必须翻译成 runtime 的内部词表**:巡检的 `hasLiveStop()`(threads.ts:106)
   * 只认 `STOP_MARKET`/`STOP` + `BUY`/`SELL`;直接吐 OKX 的 `conditional` / `sell` 会让巡检
   * 一直判「保护缺失」并反复补挂(codex-review #8)。
   *
   * 带 slTriggerPx 的 conditional/OCO = 止损(OCO 同时带 TP 也仍然是一张有止损的单);
   * **只有 tpTriggerPx 的单不能冒充止损** —— 它到不了止损价。
   */
  private algoToOrderView(a: Record<string, unknown>, market: Market = 'perp'): OpenOrderView {
    const symbol = symbolOf(String(a['instId'] ?? ''));
    const algoId = String(a['algoId'] ?? '');
    const algoClOrdId = String(a['algoClOrdId'] ?? '');
    const sl = String(a['slTriggerPx'] ?? '');
    const tp = String(a['tpTriggerPx'] ?? '');
    const hasSl = Boolean(sl) && Number(sl) > 0;
    const hasTp = Boolean(tp) && Number(tp) > 0;
    const ordType = String(a['ordType'] ?? 'conditional');
    return {
      symbol, market,
      // 独立挂的腿带了 algoClOrdId(= 我们的 cid');附带腿没有,只能靠 KV 反查;都没有就用 algoId。
      client_order_id: algoClOrdId || this.opts.kv.get(`${ALGO_REV_KV_PREFIX}${market === 'spot' ? 'spot:' : ''}${algoId}`) || algoId,
      type: hasSl ? 'STOP_MARKET' : hasTp ? 'TAKE_PROFIT_MARKET' : ordType.toUpperCase(),
      side: String(a['side'] ?? '').toUpperCase(),
      qty: this.toCoin(a['sz'], symbol, market),
      price: null,
      stop_price: hasSl ? sl : hasTp ? tp : null,
      // net 模式下带 TP/SL 触发价的 conditional/oco 就是平仓腿 —— OKX 对附带单不回 reduceOnly 字段,
      // 光看那一个字段会让本来挂着的止损被当成「不是保护单」。
      reduce_only: String(a['reduceOnly'] ?? '') === 'true' || Boolean(a['closeFraction']) || hasSl || hasTp,
      status: String(a['state'] ?? 'live'),
    };
  }

  /** 合约表空了就补拉一次(失败不抛:真正的硬失败发生在 toCoin)。 */
  private async ensureInstruments(): Promise<void> {
    if (cachedInstruments().length > 0) return;
    try {
      await loadOkxInstruments(true);
    } catch (e) {
      this.opts.log('warn', `拉 OKX 合约表失败:${(e as Error).message}`);
    }
  }

  /**
   * 张 → 币。**规格缺失时硬失败**:ctVal=0.01 的 BTC 合约 100 张是 1 BTC,不是 100 BTC;
   * 1:1 回退会把风控敞口、成交量、结算数量一起污染(codex-review #10)。
   */
  private toCoin(sz: unknown, symbol: string, market: Market = 'perp'): string {
    if (market === 'spot') return String(sz ?? '0');
    const inst = instrumentOf(symbol, market);
    if (!inst) throw new OkxCliError('transport', `${symbol} 的合约规格(ctVal/lotSz)没拿到,张数换不成币的数量 —— 本次数据不可用,不做 1:1 回退`, null, false);
    return contractsToQty(typeof sz === 'number' ? numToDec(sz) : String(sz ?? '0'), inst);
  }

  // ------------------------------------------------------------ 下单

  private async contracts(symbol: string, qty: string, market: Market = 'perp'): Promise<string> {
    const inst = await okxInstrument(symbol, market);
    const sz = qtyToContracts(qty, inst);
    if (Number(sz) <= 0 || Number(sz) < Number(inst.minSz)) throw new OkxCliError('local_reject', `${symbol} 数量 ${qty} 不足一张(ctVal ${inst.ctVal} × lotSz ${inst.lotSz})`, null, false);
    return sz;
  }

  private receipt(p: Promise<unknown[]>): Promise<OrderReceipt> {
    return p.then(
      (rows) => {
        const rec = (rows[0] ?? {}) as Record<string, unknown>;
        return { outcome: 'submitted' as const, receipt: rec, avg_price: null, error: null };
      },
      (e: unknown) => {
        if (e instanceof OkxCliError) return { outcome: (e.ambiguous ? 'unknown' : 'failed') as 'unknown' | 'failed', receipt: { kind: e.kind, code: e.code }, avg_price: null, error: e.message };
        return { outcome: 'failed' as const, receipt: null, avg_price: null, error: String(e) };
      },
    );
  }

  private closeSide(position: Direction): string {
    return position === 'long' ? 'sell' : 'buy';
  }

  async placeEntry(req: EntryRequest): Promise<OrderReceipt> {
    const market = req.market ?? 'perp';
    const rejection = this.marketRejection(market) ?? (market === 'spot' && req.direction !== 'long' ? 'spot_no_short' : null);
    if (rejection) return this.localReject(rejection);
    let sz: string;
    try {
      sz = await this.contracts(req.symbol, req.qty, market);
    } catch (e) {
      return { outcome: 'failed', receipt: null, avg_price: null, error: (e as Error).message };
    }
    const cid = toClOrdId(req.client_order_id);
    const args = [market === 'spot' ? 'spot' : 'swap', 'place', '--instId', symbolToInstId(req.symbol, market), '--side', req.direction === 'long' ? 'buy' : 'sell', '--ordType', req.entry === 'market' ? 'market' : 'limit', '--sz', sz, '--tdMode', market === 'spot' ? 'cash' : this.mgnModeOf(req.symbol), '--clOrdId', cid];
    if (market === 'spot') args.push('--tgtCcy', 'base_ccy');
    if (req.entry === 'limit') args.push('--px', String(req.limit_price));
    const r = await this.receipt(this.run(args, { write: true }));
    this.invalidateAccount();
    if (r.outcome !== 'submitted' || req.entry !== 'market') return r;
    // 市价单回执只有 ordId/sCode,成交价要再查一次(§4)。
    const st = await this.getOrder(req.symbol, req.client_order_id, true, market).catch(() => null);
    if (!st) return r;
    return { ...r, outcome: st.status === 'FILLED' ? 'filled' : r.outcome, avg_price: st.avg_price };
  }

  /**
   * 开仓 + 附带止损/止盈,一次原子请求(比「先开仓再挂 STOP」少一个裸奔窗口)。
   * OKX 的下单回执不带 algoId,所以成交后再去 algo orders 里把它找出来,写进 KV;
   * 止损与止盈同时带时 OKX 生成的是一张 OCO —— 两条腿回同一个 algoId,这是 OKX 的事实,不是 bug。
   */
  async openWithProtection(req: OpenWithProtectionRequest): Promise<OpenWithProtectionReceipt> {
    const market = req.market ?? 'perp';
    const fail = (msg: string): OpenWithProtectionReceipt => ({
      entry: { outcome: 'failed', receipt: null, avg_price: null, error: msg, executed_qty: null, order_id: null },
      stop: { outcome: 'failed', algo_id: null, error: msg },
      tp: { outcome: req.take_profit ? 'failed' : 'skipped', algo_id: null, error: req.take_profit ? msg : null },
    });
    const rejection = this.marketRejection(market) ?? (market === 'spot' && req.direction !== 'long' ? 'spot_no_short' : null);
    if (rejection) { const r = fail(rejection); r.entry.receipt = { kind: 'local_reject' }; return r; }
    let sz: string;
    try {
      sz = await this.contracts(req.symbol, req.qty, market);
    } catch (e) {
      return fail((e as Error).message);
    }
    const instId = symbolToInstId(req.symbol, market);
    const cid = toClOrdId(req.client_order_id);
    // 真 key 实测(2026-09-20):`--slOrdPx -1` 会被 CLI 的参数解析当成未知选项(值以减号开头),必须写成 `--slOrdPx=-1`。
    const args = [market === 'spot' ? 'spot' : 'swap', 'place', '--instId', instId, '--side', req.direction === 'long' ? 'buy' : 'sell', '--ordType', 'market', '--sz', sz, '--tdMode', market === 'spot' ? 'cash' : this.mgnModeOf(req.symbol), '--clOrdId', cid,
      '--slTriggerPx', req.stop_price, '--slOrdPx=-1', '--slTriggerPxType', market === 'spot' ? 'last' : 'mark'];
    if (market === 'spot') args.push('--tgtCcy', 'base_ccy');
    if (req.take_profit) args.push('--tpTriggerPx', req.take_profit.trigger_price, '--tpOrdPx=-1', '--tpTriggerPxType', market === 'spot' ? 'last' : 'mark');
    const entry = await this.receipt(this.run(args, { write: true }));
    this.invalidateAccount();
    if (entry.outcome === 'failed' || entry.outcome === 'unknown') {
      const msg = entry.error ?? '下单失败';
      return {
        entry: { ...entry, executed_qty: null, order_id: orderIdOf(entry.receipt) },
        stop: { outcome: entry.outcome, algo_id: null, error: msg },
        tp: { outcome: req.take_profit ? entry.outcome : 'skipped', algo_id: null, error: req.take_profit ? msg : null },
      };
    }
    const st = await this.getOrder(req.symbol, req.client_order_id, true, market).catch(() => null);
    // 附带腿的归属**只能**从父订单详情里读(§4 / codex-review #4)。
    const attachId = attachedAlgoIdOf(st?.raw);
    // 2026-09-21 真 key 实测(SOLUSDT 金丝雀两次同样失败):父订单详情里的 attachAlgoId **不是**成交后
    // OKX 真正生成的那张条件单的 algoId——拿它去 orders-algo-pending 查不到,拿它撤单回 51400。
    // 所以有了 attachAlgoId 之后还要到挂单列表里把真实 algoId 找回来:先按 algoId 相等,再按
    // 「无 algoClOrdId + 方向/触发价/止盈价全等 + 创建时间不早于入场单」精确匹配;找不到就是 unknown,
    // 不许把一个撤不掉的 id 当成「已挂上」(那正是止损验证一直失败的根因)。
    let algoId: string | null = null;
    let resolveNote: string | null = null;
    if (attachId) {
      const found = await this.resolveAttachedAlgo(req.symbol, market, attachId, {
        side: this.closeSide(req.direction), stop: req.stop_price, tp: req.take_profit?.trigger_price ?? null,
        notBefore: Number((st?.raw as Record<string, unknown> | undefined)?.['cTime'] ?? 0) || 0,
      });
      if (found.algoId) algoId = found.algoId;
      else resolveNote = found.note;
    }
    if (algoId) {
      this.rememberAlgo(req.stop_client_algo_id, algoId, market);
      if (req.take_profit) this.rememberAlgo(req.take_profit.client_algo_id, algoId, market);
    }
    const legError = algoId ? null : attachId ? `下单已接受,父订单详情给了附带单 ${attachId},但挂单列表里找不到对应的条件单(${resolveNote ?? '?'});保护腿按未知处理,请在执行页复核` : '下单已接受,但父订单详情里还没有附带单的 algoId(attachAlgoOrds 为空);保护腿按未知处理,请在执行页复核';
    const stop: AlgoLegReceipt = { outcome: algoId ? 'submitted' : 'unknown', algo_id: algoId, error: legError };
    const tp: AlgoLegReceipt = req.take_profit ? { outcome: algoId ? 'submitted' : 'unknown', algo_id: algoId, error: legError } : { outcome: 'skipped', algo_id: null, error: null };
    return {
      entry: {
        ...entry,
        outcome: st?.status === 'FILLED' ? 'filled' : entry.outcome,
        avg_price: st?.avg_price ?? entry.avg_price,
        executed_qty: st?.executed_qty ?? null,
        order_id: orderIdOf(entry.receipt),
      },
      stop,
      tp,
    };
  }

  /**
   * 成交后在挂单列表里定位附带保护腿的**真实** algoId。证据链(任一即可,按强到弱):
   *  1. 列表里有 algoId === attachAlgoId(OKX 将来若对齐两者,直接命中);
   *  2. 列表里有 algoClOrdId === 我们的 cid'(CLI 将来支持 attachAlgoClOrdId 时);
   *  3. 无 algoClOrdId 的行,方向/止损触发价/止盈触发价与请求全等,且创建时间不早于入场单;
   *     命中必须**唯一**,多于一张就不认(那是别处的同价单,codex-review #4 的红线)。
   * 列表可能比成交晚一拍,最多查 3 次;列表本身查不到(CLI 失败)返回 null 让调用方按 unknown 处理。
   */
  private async resolveAttachedAlgo(symbol: string, market: Market, attachId: string, want: { side: string; stop: string; tp: string | null; notBefore: number }): Promise<{ algoId: string | null; note: string }> {
    const near = (a: unknown, b: string | null): boolean => {
      if (b === null) return a === undefined || a === null || String(a) === '';
      const x = Number(a), y = Number(b);
      return Number.isFinite(x) && Number.isFinite(y) && y > 0 && Math.abs(x - y) / y < 1e-6;
    };
    const delay = this.opts.algoResolveDelayMs ?? 800;
    let lastNote = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
      const raw = await this.listAlgoRows(symbol, market);
      // 列表本身拉不到(CLI 超时等):退回旧口径,先信父订单详情;后续 algoOrderExists 还会再核。
      if (raw === null) return { algoId: attachId, note: '挂单列表查询失败,暂信父订单详情' };
      const seenIds = new Set<string>();
      const rows = raw.filter((r) => { const id = String(r['algoId'] ?? ''); if (!id || seenIds.has(id)) return false; seenIds.add(id); return true; });
      const byId = rows.find((r) => String(r['algoId'] ?? '') === attachId);
      if (byId) return { algoId: attachId, note: 'algoId 相等' };
      const matches = rows.filter((r) => {
        if (String(r['algoClOrdId'] ?? '')) return false;
        if (String(r['side'] ?? '').toLowerCase() !== want.side) return false;
        if (!near(r['slTriggerPx'], want.stop)) return false;
        if (!near(r['tpTriggerPx'], want.tp)) return false;
        const cTime = Number(r['cTime'] ?? 0);
        return !(want.notBefore > 0 && cTime > 0 && cTime < want.notBefore - 5_000);
      });
      if (matches.length === 1) {
        const id = String(matches[0]!['algoId'] ?? '');
        if (id) return { algoId: id, note: `按方向/触发价/时间唯一匹配到 ${id}` };
      }
      lastNote = matches.length > 1 ? `有 ${matches.length} 张同方向同触发价的条件单,无法唯一归属` : `列表 ${rows.length} 张里没有匹配的条件单`;
    }
    return { algoId: null, note: lastNote };
  }

  private rememberAlgo(clientAlgoId: string, algoId: string, market: Market = 'perp'): void {
    const cid = toClOrdId(clientAlgoId);
    this.opts.kv.set(`${ALGO_KV_PREFIX}${market === 'spot' ? 'spot:' : ''}${cid}`, algoId);
    this.opts.kv.set(`${ALGO_REV_KV_PREFIX}${market === 'spot' ? 'spot:' : ''}${algoId}`, cid);
  }

  private algoIdOf(clientAlgoId: string, market: Market = 'perp'): string | null {
    return this.opts.kv.get(`${ALGO_KV_PREFIX}${market === 'spot' ? 'spot:' : ''}${toClOrdId(clientAlgoId)}`);
  }

  /**
   * 单独挂一条保护腿。OKX 没有 Binance 的 `closePosition=true`:张数只能用**当前持仓**现查
   * (所以先读一次 positions);`--cxlOnClosePos` 让仓位平掉时这张单自动撤,避免留下裸的反向单。
   */
  private async algoLeg(symbol: string, position: Direction, kind: 'sl' | 'tp', trigger: string, clientAlgoId: string, market: Market = 'perp', quantity?: string): Promise<OrderReceipt> {
    const rejection = this.marketRejection(market);
    if (rejection) return this.localReject(rejection);
    if (market === 'spot') return this.spotAlgoLeg(symbol, kind, trigger, clientAlgoId, quantity);
    const instId = symbolToInstId(symbol, market);
    let sz: string;
    let mgnMode: 'cross' | 'isolated';
    try {
      const row = await this.positionRow(instId);
      if (!row) return { outcome: 'failed', receipt: null, avg_price: null, error: `${symbol} 当前没有持仓,挂不了保护腿` };
      sz = numToDec(Math.abs(Number(row['pos'])));
      if (quantity !== undefined) {
        if ((Number(row['pos']) > 0 ? 'long' : 'short') !== position) return this.localReject('partial_tp_side_mismatch');
        const wanted = await this.contracts(symbol, quantity, market);
        if (!(Number(wanted) > 0) || Number(wanted) > Number(sz)) return this.localReject('partial_tp_quantity_invalid');
        sz = wanted;
      }
      // 保护腿的 tdMode 必须跟仓位一致,否则 OKX 定位不到要保护的那个仓位(codex-review #6)。
      mgnMode = String(row['mgnMode'] ?? '') === 'isolated' ? 'isolated' : String(row['mgnMode'] ?? '') === 'cross' ? 'cross' : this.mgnModeOf(symbol);
    } catch (e) {
      const err = e as OkxCliError;
      return { outcome: 'failed', receipt: null, avg_price: null, error: `读持仓失败:${err.message}` };
    }
    // 独立挂的算法单**可以**带客户端 id:CLI 的 `--clOrdId` 透到 OKX 的 `algoClOrdId`
    // (dist 里 `algoClOrdId: readString(args,"algoClOrdId") ?? readString(args,"clOrdId")`)。
    // 有了它,algoOrderExists/listAlgoOrders 就不必只靠 KV 猜(codex-review #4)。
    const algoClOrdId = toClOrdId(clientAlgoId);
    const args = ['swap', 'algo', 'place', '--instId', instId, '--side', this.closeSide(position), '--ordType', 'conditional', '--sz', sz, '--reduceOnly', '--tdMode', mgnMode, '--cxlOnClosePos', '--clOrdId', algoClOrdId];
    if (kind === 'sl') args.push('--slTriggerPx', trigger, '--slOrdPx=-1', '--slTriggerPxType', 'mark');
    else args.push('--tpTriggerPx', trigger, '--tpOrdPx=-1', '--tpTriggerPxType', 'mark');
    const r = await this.receipt(this.run(args, { write: true }));
    const algoId = String((r.receipt as Record<string, unknown> | null)?.['algoId'] ?? '');
    if (algoId) this.rememberAlgo(clientAlgoId, algoId, market);
    this.invalidateAccount();
    return r;
  }

  placeStop(symbol: string, position: Direction, stop_price: string, client_order_id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    return this.algoLeg(symbol, position, 'sl', stop_price, client_order_id, market);
  }

  // CLI 1.4.7:spot/swap algo amend → POST /api/v5/trade/amend-algos。
  // CLI 不透传 reqId:new_cid 是提交前落库的操作 ID，对账必须绑定原 algoId + 目标价。
  readonly stopMoveMode = 'amend' as const;
  async getStopProtection(symbol: string, cid: string, market: Market, algo_id?: string | null): Promise<StopProtection | null> {
    const rows = await this.listAlgoRows(symbol, market);
    if (!rows) return null;
    const id = algo_id ?? this.algoIdOf(cid, market);
    const hits = rows.filter(r => String(r['instId'] ?? '') === symbolToInstId(symbol, market)
      && (id ? String(r['algoId'] ?? '') === id : String(r['algoClOrdId'] ?? '') === toClOrdId(cid) || String(r['algoId'] ?? '') === cid));
    const unique = [...new Map(hits.map(r => [String(r['algoId']), r])).values()];
    if (unique.length !== 1) return null;
    const r = unique[0]!, side = String(r['side'] ?? '');
    if (!r['algoId'] || r['state'] !== 'live' || !['conditional', 'oco'].includes(String(r['ordType'])) || !['sell', 'buy'].includes(side)
      || String(r['slOrdPx']) !== '-1' || !/^\d+(?:\.\d+)?$/.test(String(r['slTriggerPx'])) || !/[1-9]/.test(String(r['slTriggerPx']))) return null;
    // 不接受 hedge / 开仓算法单。附带腿凭 KV 归属；独立腿必须是 reduceOnly 或 closeFraction=1。
    const attachedOwned = (r['reduceOnly'] === undefined || r['reduceOnly'] === '') && this.algoIdOf(cid, market) === String(r['algoId']);
    if (market !== 'spot' && (r['posSide'] && r['posSide'] !== 'net' || !(String(r['reduceOnly']) === 'true' || String(r['closeFraction']) === '1' || attachedOwned))) return null;
    if (market === 'spot' && side !== 'sell') return null;
    let qty: string;
    try { qty = this.toCoin(r['sz'] ?? '0', symbol, market); } catch { return null; }
    return { client_order_id: cid, algo_id: String(r['algoId']), symbol, market, side: side === 'sell' ? 'long' : 'short',
      stop_price: String(r['slTriggerPx']), qty, close_position: market !== 'spot' && String(r['closeFraction']) === '1',
      take_profit_price: r['tpTriggerPx'] && String(r['tpTriggerPx']) !== '0' ? String(r['tpTriggerPx']) : null };
  }
  async amendStop(r: StopMoveRequest, authorize?: () => boolean): Promise<OrderReceipt> {
    if (!r.old_algo_id) return this.localReject('stop_move_missing_algo_id');
    // 再核原单，不按相同币种/相近触发价猜归属，也不让旧快照覆盖已经收紧的单。
    const old = await this.getStopProtection(r.symbol, r.old_cid, r.market, r.old_algo_id);
    if (!old || old.side !== r.side || compareStopPrices(old.stop_price, r.old_stop) !== 0
      || (r.side === 'long' ? compareStopPrices(r.target_stop, old.stop_price) <= 0 : compareStopPrices(r.target_stop, old.stop_price) >= 0)
      || (r.market === 'spot' ? compareStopPrices(old.qty, r.qty) !== 0 : !old.close_position && compareStopPrices(old.qty, r.qty) < 0)) return this.localReject('stop_move_old_protection_changed');
    if (authorize && !authorize()) return this.localReject('stop_move_pre_submit_gate_rejected');
    // 只设置触发价；不传 newSz/newTp*/newSlOrdPx，不开启修改失败自动撤单。
    const result = await this.receipt(this.run([r.market === 'spot' ? 'spot' : 'swap', 'algo', 'amend', '--instId', symbolToInstId(r.symbol, r.market), '--algoId', r.old_algo_id, '--newSlTriggerPx', r.target_stop], { write: true }));
    this.invalidateAccount();
    return result.outcome === 'failed' && !['rejected', 'local_reject'].includes(String((result.receipt as { kind?: string } | null)?.kind)) ? { ...result, outcome: 'unknown' } : result;
  }
  placeTakeProfit(symbol: string, position: Direction, tp_price: string, client_order_id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    return this.algoLeg(symbol, position, 'tp', tp_price, client_order_id, market);
  }

  placePartialTakeProfit(symbol: string, position: Direction, tp: string, qty: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    return this.algoLeg(symbol, position, 'tp', tp, id, market, qty);
  }

  // ------------------------------------------------------------ 算法单自验证

  /**
   * 两种证据:交易所侧的 `algoClOrdId`(独立挂的腿带得上)或 KV 里的 cid → algoId(附带腿只有这个)。
   * 两种都没有 → null:那是「查不到」,不是「没挂」。
   */
  async algoOrderExists(symbol: string, client_algo_id: string, market: Market = 'perp'): Promise<boolean | null> {
    const rows = await this.listAlgoRows(symbol, market);
    if (rows === null) return null;
    const want = toClOrdId(client_algo_id);
    if (rows.some((r) => String(r['algoClOrdId'] ?? '') === want)) return true;
    const algoId = this.algoIdOf(client_algo_id, market);
    if (!algoId) return null;
    return rows.some((r) => String(r['algoId'] ?? '') === algoId);
  }

  async cancelAlgoOrder(symbol: string, client_algo_id: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    let algoId = this.algoIdOf(client_algo_id, market);
    if (!algoId) {
      // KV 丢了还有一条精确路:交易所侧的 algoClOrdId 就是我们算出来的 cid'(不是猜「最新那张」)。
      const rows = await this.listAlgoRows(symbol, market);
      const want = toClOrdId(client_algo_id);
      const hit = rows?.find((r) => String(r['algoClOrdId'] ?? '') === want);
      algoId = hit ? String(hit['algoId'] ?? '') || null : null;
    }
    if (!algoId) return { ok: false, error: `不知道 ${client_algo_id} 对应的 algoId(KV 与 algoClOrdId 都查不到),无法撤单` };
    try {
      await this.run([market === 'spot' ? 'spot' : 'swap', 'algo', 'cancel', '--instId', symbolToInstId(symbol, market), '--algoId', algoId], { write: true });
      this.invalidateAccount();
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async listAlgoOrders(symbol: string, market: Market = 'perp'): Promise<{ client_algo_id: string; algo_id: string | null }[] | null> {
    const rows = await this.listAlgoRows(symbol, market);
    if (rows === null) return null;
    return rows.map((r) => {
      const algoId = String(r['algoId'] ?? '');
      const algoClOrdId = String(r['algoClOrdId'] ?? '');
      return { client_algo_id: algoClOrdId || this.opts.kv.get(`${ALGO_REV_KV_PREFIX}${market === 'spot' ? 'spot:' : ''}${algoId}`) || algoId, algo_id: algoId || null };
    });
  }

  /** conditional + oco 两种 ordType 合并;任一查失败 → null(不确定)。 */
  private async listAlgoRows(symbol: string, market: Market = 'perp'): Promise<Record<string, unknown>[] | null> {
    const instId = symbolToInstId(symbol, market);
    try {
      const [cond, oco] = await Promise.all([
        this.run([market === 'spot' ? 'spot' : 'swap', 'algo', 'orders', '--instId', instId, '--ordType', 'conditional']),
        this.run([market === 'spot' ? 'spot' : 'swap', 'algo', 'orders', '--instId', instId, '--ordType', 'oco']),
      ]);
      return [...(cond as Record<string, unknown>[]), ...(oco as Record<string, unknown>[])];
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ 平仓 / 撤单

  async closePosition(symbol: string, _client_order_id: string, market: Market = 'perp'): Promise<{ closed: boolean; receipt: unknown; error: string | null; ambiguous?: boolean }> {
    const rejection = this.marketRejection(market);
    if (rejection) return {closed:false,receipt:{kind:'local_reject',code:rejection},error:rejection};
    if (market === 'spot') return this.closeSpot(symbol, _client_order_id);
    const instId = symbolToInstId(symbol, market);
    // 平仓的 mgnMode 取**仓位实际的**那个,不是本地记的(codex-review #6);读不到就退回本地记的,
    // 平仓本身比「模式猜错被拒」更要紧,而被拒是显性的(runtime 会再查一次新鲜仓位)。
    let mgnMode = this.mgnModeOf(symbol);
    try {
      const row = await this.positionRow(instId);
      const actual = String(row?.['mgnMode'] ?? '');
      if (actual === 'cross' || actual === 'isolated') mgnMode = actual;
    } catch (e) {
      this.opts.log('warn', `${symbol} 平仓前读持仓失败,按本地记录的 ${mgnMode} 平:${(e as Error).message}`);
    }
    try {
      const r = await this.run(['swap', 'close', '--instId', instId, '--mgnMode', mgnMode, '--posSide', 'net', '--autoCxl'], { write: true });
      this.invalidateAccount();
      return { closed: true, receipt: r[0] ?? null, error: null };
    } catch (e) {
      // 「没有持仓」不是失败:等价于已经平掉了(Binance 的 -4509 同理)。
      // 注意 51024(账户受限)**不在**这个集合里:那不是「仓位没了」(codex-review #1)。
      if (isRejectedWith(e, NO_POSITION_CODES) || /no position|position does not exist|持仓不存在/i.test((e as Error).message)) {
        this.invalidateAccount();
        return { closed: true, receipt: null, error: null };
      }
      // 写超时 / 50004:命令可能已经到交易所了。丢掉这个标记会让 runtime 把意图写成 failed,
      // 而实际仓位可能已经平掉 —— 必须传上去让它保持 unknown(codex-review #7)。
      const ambiguous = e instanceof OkxCliError && e.ambiguous;
      if (ambiguous) this.invalidateAccount();
      return { closed: false, receipt: null, error: (e as Error).message, ...(ambiguous ? { ambiguous: true } : {}) };
    }
  }

  async reducePosition(symbol: string, qty: string, client_order_id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    const rejection = this.marketRejection(market);
    if (rejection) return this.localReject(rejection);
    if (market === 'spot') {
      const canceled = await this.cancelAll(symbol, market);
      if (!canceled.ok) return {outcome:'failed',receipt:null,avg_price:null,error:canceled.error};
      const available = await this.spotAvailable(symbol);
      if (Number(qty) > Number(available)) return this.localReject('insufficient_balance');
      return this.sellSpot(symbol, qty, client_order_id);
    }
    const acct = await this.account();
    const pos = acct.positions.find((p) => p.symbol === symbol && (p.market ?? 'perp') === market);
    if (!pos) return { outcome: 'failed', receipt: null, avg_price: null, error: 'no position' };
    let sz: string;
    try {
      sz = await this.contracts(symbol, qty, market);
    } catch (e) {
      return { outcome: 'failed', receipt: null, avg_price: null, error: (e as Error).message };
    }
    const args = ['swap', 'place', '--instId', symbolToInstId(symbol, market), '--side', this.closeSide(pos.side), '--ordType', 'market', '--sz', sz, '--tdMode', this.mgnModeOf(symbol), '--reduceOnly', '--clOrdId', toClOrdId(client_order_id)];
    const r = await this.receipt(this.run(args, { write: true }));
    this.invalidateAccount();
    return r;
  }

  /** 普通单逐张撤(batch 也行,但逐张的失败面更清楚),算法单只能逐张。 */
  /**
   * 撤掉本网关在这个品种上的全部挂单与条件单。只认自己的单:普通单 clOrdId 以 `tgd` 开头,条件单 algoClOrdId 以 `tgd`
   * 开头或 KV 里有 algoId 反查(附带腿)。账户上别人挂的单(例如外部仓位的 OCO 止损/止盈)一律跳过——外部仓位只显示,
   * 不平、不改保护单、不重挂,只有 owner 手动处理。
   */
  async cancelAll(symbol: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    const instId = symbolToInstId(symbol, market);
    const errors: string[] = [];
    let skipped = 0;
    try {
      const rows = (await this.run([market === 'spot' ? 'spot' : 'swap', 'orders', '--instId', instId])) as Record<string, unknown>[];
      for (const o of rows) {
        const ordId = String(o['ordId'] ?? '');
        if (!ordId) continue;
        if (!this.isOurOrder(o)) { skipped++; continue; } // 外部挂单(不是本网关下的):不碰
        try {
          await this.run([market === 'spot' ? 'spot' : 'swap', 'cancel', instId, '--ordId', ordId], { write: true });
        } catch (e) {
          if (!isRejectedWith(e, ORDER_GONE_CODES)) errors.push(`cancel ${ordId}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      errors.push(`list orders: ${(e as Error).message}`);
    }
    const algos = await this.listAlgoRows(symbol, market);
    if (algos === null) errors.push('list algo orders 失败');
    else {
      for (const a of algos) {
        const algoId = String(a['algoId'] ?? '');
        if (!algoId) continue;
        if (!this.isOurAlgo(a, market)) { skipped++; continue; } // 外部仓位的保护单(OCO 等):不撤不改
        try {
          await this.run([market === 'spot' ? 'spot' : 'swap', 'algo', 'cancel', '--instId', instId, '--algoId', algoId], { write: true });
        } catch (e) {
          if (!isRejectedWith(e, ORDER_GONE_CODES)) errors.push(`cancel algo ${algoId}: ${(e as Error).message}`);
        }
      }
    }
    if (skipped) this.opts.log('info', `${symbol} 撤单跳过 ${skipped} 张外部挂单(不是本网关下的)`);
    this.invalidateAccount();
    return { ok: errors.length === 0, error: errors.join('; ') || null };
  }

  private isOurOrder(row: Record<string, unknown>): boolean {
    return String(row['clOrdId'] ?? '').startsWith(OWN_CLORD_PREFIX);
  }

  private isOurAlgo(row: Record<string, unknown>, market: Market): boolean {
    if (String(row['algoClOrdId'] ?? '').startsWith(OWN_CLORD_PREFIX)) return true;
    const algoId = String(row['algoId'] ?? '');
    return algoId !== '' && this.opts.kv.get(`${ALGO_REV_KV_PREFIX}${market === 'spot' ? 'spot:' : ''}${algoId}`) !== null;
  }

  async cancelOrder(symbol: string, client_order_id: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    const instId = symbolToInstId(symbol, market);
    try {
      await this.run([market === 'spot' ? 'spot' : 'swap', 'cancel', instId, '--clOrdId', toClOrdId(client_order_id)], { write: true });
      this.invalidateAccount();
      return { ok: true, error: null };
    } catch (e) {
      // 已经不在了 = 撤单目的已达成(§4)。注意:这不代表没成交,成交量由 getOrder 读回。
      if (isRejectedWith(e, ORDER_GONE_CODES)) {
        this.invalidateAccount();
        return { ok: true, error: null };
      }
      // 普通单撤不掉,再按算法单试一次(runtime 用同一个 cid 管两种腿)。
      const algoId = this.algoIdOf(client_order_id, market);
      if (algoId) {
        try {
          await this.run([market === 'spot' ? 'spot' : 'swap', 'algo', 'cancel', '--instId', instId, '--algoId', algoId], { write: true });
          this.invalidateAccount();
          return { ok: true, error: null };
        } catch (e2) {
          if (isRejectedWith(e2, ORDER_GONE_CODES)) return { ok: true, error: null };
          return { ok: false, error: (e2 as Error).message };
        }
      }
      return { ok: false, error: (e as Error).message };
    }
  }

  // ------------------------------------------------------------ 订单状态

  async getOrder(symbol: string, client_order_id: string, fresh = false, market: Market = 'perp'): Promise<OrderStatusView | null> {
    const key = `${market}|${symbol}|${client_order_id}`;
    const hit = this.orderCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < ORDER_TTL_MS) return hit.view;
    try {
      const rows = (await this.run([market === 'spot' ? 'spot' : 'swap', 'get', '--instId', symbolToInstId(symbol, market), '--clOrdId', toClOrdId(client_order_id)])) as Record<string, unknown>[];
      const raw = rows[0];
      if (!raw) {
        this.orderCache.set(key, { at: Date.now(), view: null });
        return null;
      }
      const avg = Number(raw['avgPx'] ?? '0');
      const view: OrderStatusView = {
        status: mapOrderState(String(raw['state'] ?? '')),
        avg_price: avg > 0 ? String(raw['avgPx']) : null,
        executed_qty: this.toCoin(raw['accFillSz'] ?? raw['fillSz'] ?? '0', symbol, market),
        raw,
      };
      this.orderCache.set(key, { at: Date.now(), view });
      return view;
    } catch (e) {
      // 51603 = 订单不存在;其余错误往上抛,让调用方知道「读不到」而不是「没有」。
      if (isRejectedWith(e, ORDER_NOT_FOUND_CODES)) {
        this.orderCache.set(key, { at: Date.now(), view: null });
        return null;
      }
      throw e;
    }
  }

  // ------------------------------------------------------------ 杠杆 / 保证金

  private async applyLeverage(symbol: string, leverage: number, mgnMode: 'cross' | 'isolated'): Promise<{ ok: boolean; error: string | null }> {
    try {
      await this.run(['swap', 'leverage', '--instId', symbolToInstId(symbol), '--lever', String(leverage), '--mgnMode', mgnMode], { write: true });
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ ok: boolean; error: string | null }> {
    this.leverages.set(symbol, leverage);
    return this.applyLeverage(symbol, leverage, this.mgnModeOf(symbol));
  }

  /**
   * OKX 的 tdMode 是逐单参数,没有「切换保证金模式」这个账户动作:按 symbol 记下来,后续每张单带上(§4)。
   *
   * runtime 的开仓准备是 setLeverage → setMarginType(Binance 的顺序,不动它)。OKX 的杠杆是按
   * (instId, mgnMode) 存的,所以第一次开 isolated 单时刚才那次 setLeverage 改的是 cross 的杠杆;
   * 模式在这里变了就**在新模式下重设一次**,等价于「先定模式再设杠杆」(codex-review #6)。
   */
  async setMarginType(symbol: string, mode: 'cross' | 'isolated'): Promise<{ ok: boolean; error: string | null }> {
    const prev = this.mgnModeOf(symbol);
    const known = this.marginModes.has(symbol);
    this.marginModes.set(symbol, mode);
    const lev = this.leverages.get(symbol);
    if (lev === undefined || (known && prev === mode)) return { ok: true, error: null };
    if (!known && mode === 'cross') return { ok: true, error: null }; // 默认就是 cross,刚才那次已经设对了
    return this.applyLeverage(symbol, lev, mode);
  }

  // ------------------------------------------------------------ 结算

  /**
   * 窗口内的成交与资金费(§4)。两条数据源分开失败:
   * fills 拿不到 → 返回 null(调用方不得当成「没有盈亏」);bills 拿不到 → funding: null。
   */
  async settlement(symbol: string, startMs: number, endMs: number, _fresh = false, market: Market = 'perp'): Promise<SettlementView | null> {
    await this.ensureInstruments();
    const instId = symbolToInstId(symbol, market);
    const now = Date.now();
    const fillArgs = [market === 'spot' ? 'spot' : 'swap', 'fills', '--instId', instId];
    const fillArchive = startMs < now - 3 * 86_400_000;
    // CLI 1.4.7 spot fills 忽略 archive,无法证明三天以前的窗口覆盖。
    if (market === 'spot' && fillArchive) return null;
    if (fillArchive) fillArgs.push('--archive'); // 近 3 天以外要走归档接口
    let fillsRaw: unknown[];
    try {
      fillsRaw = await this.run(fillArgs);
    } catch (e) {
      this.opts.log('warn', `OKX fills 读取失败 ${symbol}:${(e as Error).message}`);
      return null;
    }
    // okx CLI 1.4.7 的 `swap fills` **只透传 instId/ordId/archive**(cmdSwapFills),没有
    // begin/end/after/limit —— 拿到的永远是最新的一页。所以只能证明覆盖,不能翻页:
    // 整页塞满且最旧一条还在窗口起点之后 = 起点之前的成交被挤掉了,结算不完整 → 返回 null,
    // 由调用方按「没查到」处理,绝不当成 0(codex-review #11)。
    const fillRows = fillsRaw as Record<string, unknown>[];
    const fillPageCap = fillArchive ? FILL_ARCHIVE_PAGE : FILL_PAGE;
    if (!coversWindow(fillRows, fillPageCap, startMs)) {
      this.opts.log('warn', `OKX fills ${symbol} 单页(上限 ${fillPageCap})没覆盖到窗口起点,结算按未查到处理`);
      return null;
    }
    const trades: SettlementTrade[] = [];
    const seenFills = new Set<string>();
    for (const f of fillRows) {
      if (String(f['instId'] ?? '') !== instId) continue;
      const ts = Number(f['ts'] ?? 0);
      if (!(ts >= startMs && ts <= endMs)) continue;
      // 同一 tradeId 只算一次(归档/实时两个接口的窗口有重叠)。
      const key = String(f['tradeId'] ?? f['billId'] ?? `${ts}|${String(f['fillPx'] ?? '')}|${String(f['fillSz'] ?? '')}`);
      if (seenFills.has(key)) continue;
      seenFills.add(key);
      trades.push({
        time: ts,
        // runtime 按大写 BUY/SELL 判平仓腿(§5)。
        side: String(f['side'] ?? '').toUpperCase(),
        price: String(f['fillPx'] ?? '0'),
        qty: this.toCoin(f['fillSz'], symbol, market),
        realized_pnl: String(f['fillPnl'] ?? '0'),
        // OKX 的 fee:负数 = 扣费、正数 = 返佣。内部算的是 `realized - commission + funding`,
        // 所以 commission = -fee,**保号**(maker 返佣要让收益增加,不是减少)(codex-review #12)。
        commission: negDec(market === 'spot' && String(f['feeCcy'] ?? '') === symbol.replace(/USDT$/, '') ? mulDec(String(f['fee'] ?? '0'), String(f['fillPx'] ?? '0')) : String(f['fee'] ?? '0')),
        position_side: String(f['posSide'] ?? '') || null,
      });
    }
    trades.sort((a, b) => a.time - b.time);

    if (market === 'spot') return { trades, funding: null, note: '现货无资金费;成本由线程成交归属计算' };
    let funding: string | null = null;
    // bills 是**整个 SWAP/USDT 账户**的流水,别的币能把目标资金费挤出首页:同样要证明覆盖。
    // CLI 透传 --limit(上限 100),没有 begin/end/after,所以也只有一页。
    const billArgs = ['account', 'bills', '--instType', 'SWAP', '--ccy', 'USDT', '--limit', String(BILL_PAGE)];
    if (startMs < now - 7 * 86_400_000) billArgs.push('--archive');
    try {
      const bills = (await this.run(billArgs)) as Record<string, unknown>[];
      if (!coversWindow(bills, BILL_PAGE, startMs)) {
        this.opts.log('warn', `OKX bills 单页(上限 ${BILL_PAGE})没覆盖到窗口起点,资金费按未知处理`);
      } else {
        let sum = '0';
        const seenBills = new Set<string>();
        for (const b of bills) {
          if (String(b['type'] ?? '') !== '8') continue; // 8 = 资金费
          if (String(b['instId'] ?? '') !== instId) continue;
          const ts = Number(b['ts'] ?? 0);
          if (!(ts >= startMs && ts <= endMs)) continue;
          const billId = String(b['billId'] ?? `${ts}|${String(b['pnl'] ?? b['balChg'] ?? '')}`);
          if (seenBills.has(billId)) continue;
          seenBills.add(billId);
          const v = String(b['pnl'] ?? b['balChg'] ?? '0');
          if (v && Number.isFinite(Number(v))) sum = addDec(sum, v);
        }
        funding = sum;
      }
    } catch (e) {
      this.opts.log('warn', `OKX bills 读取失败 ${symbol}(资金费按未知处理):${(e as Error).message}`);
      funding = null;
    }
    return { trades, funding, note: `okx fills+bills ${new Date(startMs).toISOString()}~${new Date(endMs).toISOString()}` };
  }

  private async spotAvailable(symbol: string): Promise<string> {
    const rows = await this.run(['account', 'balance']) as {details?: {ccy:string; availBal?:string}[]}[];
    const available = rows[0]?.details?.find(d => d.ccy === symbol.replace(/USDT$/, ''))?.availBal ?? '0';
    return floorToStep(available, (await okxInstrument(symbol, 'spot')).lotSz);
  }
  private async sellSpot(symbol: string, qty: string, cid: string): Promise<OrderReceipt> {
    const inst = await okxInstrument(symbol, 'spot');
    const sz = floorToStep(qty, inst.lotSz);
    if (!(Number(sz) >= Number(inst.minSz))) return this.localReject('spot_below_min_size');
    const r = await this.receipt(this.run(['spot', 'place', '--instId', inst.instId, '--side', 'sell', '--ordType', 'market', '--sz', sz, '--tdMode', 'cash', '--tgtCcy', 'base_ccy', '--clOrdId', toClOrdId(cid)], { write: true }));
    this.invalidateAccount();
    if (r.outcome !== 'submitted') return r;
    const st = await this.getOrder(symbol, cid, true, 'spot').catch(() => null);
    return { ...r, outcome: st?.status === 'FILLED' ? 'filled' : 'unknown', avg_price: st?.avg_price ?? null };
  }
  private async closeSpot(symbol: string, cid: string): Promise<{closed:boolean; receipt:unknown; error:string|null; ambiguous?:boolean}> {
    const canceled = await this.cancelAll(symbol, 'spot');
    if (!canceled.ok) return { closed:false, receipt:null, error:canceled.error };
    const qty = await this.spotAvailable(symbol);
    const inst = await okxInstrument(symbol, 'spot');
    if (Number(qty) < Number(inst.minSz)) return { closed:true, receipt:null, error:null };
    const r = await this.sellSpot(symbol, qty, cid);
    return { closed:r.outcome === 'filled', receipt:r.receipt, error:r.error, ambiguous:r.outcome === 'unknown' || r.outcome === 'submitted' };
  }
  private async spotAlgoLeg(symbol: string, kind: 'sl'|'tp', trigger: string, cid: string, quantity?: string): Promise<OrderReceipt> {
    const available = await this.spotAvailable(symbol);
    const qty = quantity ?? available;
    if (!(Number(qty) > 0) || Number(qty) > Number(available)) return this.localReject('partial_tp_quantity_unavailable');
    const inst = await okxInstrument(symbol, 'spot');
    if (Number(qty) < Number(inst.minSz)) return this.localReject('spot_below_min_size');
    const r = await this.receipt(this.run(['spot', 'algo', 'place', '--instId', inst.instId, '--side', 'sell', '--sz', qty,
      '--ordType', 'conditional', `--${kind}TriggerPx`, trigger, `--${kind}OrdPx=-1`, `--${kind}TriggerPxType`, 'last', '--tdMode', 'cash', '--clOrdId', toClOrdId(cid)], {write:true}));
    const algoId = String((r.receipt as Record<string, unknown>|null)?.['algoId'] ?? '');
    if (algoId) this.rememberAlgo(cid, algoId, 'spot');
    this.invalidateAccount(); return r;
  }

  // ------------------------------------------------------------ 保护能力 / 网络自检

  /** 只有在真实模拟盘上跑过 §7 的验证清单、把 KV 置 1 之后才算 verified。 */
  protectionCapability(market: Market = 'perp'): ProtectionCapability {
    return this.opts.kv.get(market === 'spot' ? `${OKX_PROTECTION_VERIFIED_KV}:spot` : OKX_PROTECTION_VERIFIED_KV) === '1' ? 'verified' : 'unverified';
  }

  async netCheck(n: number): Promise<NetCheckResult> {
    const started_at = Date.now();
    const runs: { ms: number; ok: boolean; transport_error: boolean; error: string | null }[] = [];
    const attempts = Math.max(1, Math.min(10, Math.floor(n)));
    for (let i = 0; i < attempts; i++) {
      // 前 n-1 次打公共行情(不签名),最后一次打签名的 balance:这样既测网络也测凭证。
      const args = i === attempts - 1 ? ['account', 'balance'] : ['market', 'ticker', 'BTC-USDT-SWAP'];
      const t0 = Date.now();
      try {
        await this.run(args);
        runs.push({ ms: Date.now() - t0, ok: true, transport_error: false, error: null });
      } catch (e) {
        const transport = e instanceof OkxCliError && e.kind === 'transport';
        runs.push({ ms: Date.now() - t0, ok: false, transport_error: transport, error: (e as Error).message });
      }
    }
    const ok = runs.filter((r) => r.ok).length;
    const transport_errors = runs.filter((r) => r.transport_error).length;
    const other_errors = runs.length - ok - transport_errors;
    const done = runs.filter((r) => r.ok);
    const avg_ms = done.length ? Math.round(done.reduce((a, b) => a + b.ms, 0) / done.length) : null;
    const verdict = transport_errors > 0
      ? `${runs.length} 次里 ${transport_errors} 次连接被掐/超时 —— 是本机网络或代理的问题,不是 OKX 拒单;先看 Clash 节点。`
      : other_errors > 0
        ? `网络通,但有 ${other_errors} 次被 OKX 拒绝(多半是 profile/凭证):跑一次 okx config init 复核。`
        : `${runs.length} 次全通,平均 ${avg_ms ?? 0} ms。`;
    return { backend: this.kind, started_at, finished_at: Date.now(), runs, ok, transport_errors, other_errors, avg_ms, verdict };
  }

  tick(): PaperEvent[] {
    return [];
  }
}

// ---------------------------------------------------------------- 小工具

function symbolOf(instId: string): string {
  const fam = instId.endsWith('-SWAP') ? instId.slice(0, -'-SWAP'.length) : instId;
  return fam.replace(/-/g, '');
}

function orderIdOf(receipt: unknown): string | null {
  const r = receipt as Record<string, unknown> | null;
  const id = r?.['ordId'] ?? r?.['algoId'];
  return id ? String(id) : null;
}

/** OKX 订单状态 → 内部状态(§4)。 */
export function mapOrderState(state: string): string {
  switch (state) {
    case 'live':
									return 'NEW';
    case 'partially_filled':
      return 'PARTIALLY_FILLED';
    case 'filled':
      return 'FILLED';
    case 'canceled':
    case 'mmp_canceled':
      return 'CANCELED';
    default:
      return state.toUpperCase();
  }
}

/** 从 CLI 输出里挖出 OKX 的失败码:`{code,msg}`(顶层)或 `[{sCode,sMsg}]`(逐单回执)。 */
export function extractFailure(parsed: unknown): { code: string; msg: string } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const top = parsed as { code?: unknown; msg?: unknown };
  if (!Array.isArray(parsed) && top.code !== undefined && String(top.code) !== '0') return { code: String(top.code), msg: String(top.msg ?? '') };
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { sCode?: unknown; sMsg?: unknown };
    if (r.sCode !== undefined && String(r.sCode) !== '0') return { code: String(r.sCode), msg: String(r.sMsg ?? '') };
  }
  return null;
}

/** 给执行页展示的 OKX 接入状态(ExecutionView.okx)。 */
export function okxStatusView(): import('./types.js').OkxStatusView {
  const a = okxAvailability();
  return { acct_lv: null, acct_lv_label: null, markets_available: [], spot_holdings: [], cli: a.cli, profile: a.profile, demo: a.demo, available: a.available, note: a.note ?? null, version: a.version, profiles: a.profiles };
}
