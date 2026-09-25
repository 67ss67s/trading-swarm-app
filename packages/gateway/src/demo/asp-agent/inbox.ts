/**
 * OKX.AI ASP 订阅信号的**拉取层**(设计 `docs/design/okx-asp-follow-2026-09-20.md` §1.1)。
 *
 * 它是跟单的**第二个信号源**:本机 `okx-a2a` 守护把订阅到的 ASP 投递写进
 * `~/.okx-agent-task/sqlite/session-store.sqlite` 的 `pending_gateway_deliveries`,
 * 我们只读轮询、归一化成 `TraderSignal`(`transport='okx_asp'`),再交给现有
 * `TraderFollow.ingest` 走同一条人工 apply/skip 链路。
 *
 * 硬规则(与 trader-feed.ts 同一套纪律):
 * - **对队列只读**:`readOnly: true` 打开,永不写、永不删。那张表是**消费即删的队列**
 *   (daemon 处理完就删行),所以是高频轮询「见一条落一条」,而不是靠游标续读 ——
 *   去重键是 `message_id`(没有就 `row-<id>`),已见集合落 kv。
 * - **零自动交易所写**:这里只产出信号,不下单;`can_enter`/`is_executable` 明确为 false 的
 *   直接打 `backfill=true`(现有语义 = 永远 review_only,只进人工待办)。
 * - **坏行不抛**:`normalizeAspSignal` 与 `normalizeBridgeSignal` 同返回形状,一条坏行不打掉整批;
 *   挑不出信号的行也留痕(kv `okx_asp.raw:<id>`),便于事后排查解析。
 * - **退避**:连续失败 `5s × 2^(n-1)` 封顶 60s(守护没跑时不刷屏,验收 §3.1)。
 * - **进程环境原样继承**:OKX 后端要走 Clash 代理(memory okx-a2a-proxy-quirks),
 *   spawn 时**不要**删 `HTTP_PROXY`/`ALL_PROXY` 这些变量,否则 CLI 静默超时。
 * - **不持久化 consentSnapshot、不碰订阅动作**:订阅/退订留给 Claude 里的 `okx-ai` 技能。
 */

import { WalletStatus, walletStatus } from '../wallet-status.js';
import { spawnCli } from './cli.js';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { backoffMs, redactDeep, type FollowKv } from '../trader-feed.js';
import {
  decimalOf,
  defaultSignalRowId,
  protectiveStopPrice,
  sideFrom,
  signalIdError,
  MAX_CLOCK_SKEW_MS,
  type NormalizeResult,
  type TraderAction,
  type TraderEntryKind,
  type TraderSignal,
  type TraderTakeProfit,
} from '../trader-signal.js';
import { instIdToSymbol } from '../okx/instruments.js';
import type { Direction } from '../types.js';

// ---------------------------------------------------------------- 常量与 kv 键

export const OKX_ASP_TRANSPORT = 'okx_asp';
/** 已见投递集合(去重键);FIFO 淘汰,上限见下。 */
export const OKX_ASP_SEEN_KEY = 'okx_asp.seen';
/** 计数器(seen/ingested/skipped_analysis/bad_rows)。 */
export const OKX_ASP_COUNTERS_KEY = 'okx_asp.counters';
/** 分析类(非 order)投递的摘要留痕。 */
export const OKX_ASP_SKIPPED_KEY = 'okx_asp.skipped';
/** 挑不出信号的原文留痕前缀:`okx_asp.raw:<message_id>`。 */
export const OKX_ASP_RAW_PREFIX = 'okx_asp.raw:';
export const OKX_ASP_SEEN_MAX = 5000;
export const OKX_ASP_RAW_MAX_CHARS = 4000;
export const OKX_ASP_SKIPPED_RECENT_MAX = 50;
/** 订阅列表缓存 60s(§1.1 第 3 条)。 */
export const OKX_ASP_SUBS_TTL_MS = 60_000;
/** 三盏灯缓存 30s(§1.2)。 */
export const OKX_ACCOUNT_TTL_MS = 30_000;
export const OKX_CLI_TIMEOUT_MS = 20_000;
/** 只认含这三个键之一的 JSON 对象是「信号」(collect.py `SIGNAL_HINTS`)。 */
const SIGNAL_HINTS = ['deliveryId', 'signal_type', 'signalTime', 'arbitrage'] as const;

/** a2a 库文件候选路径(store.py `DB_CANDIDATES`:版本间挪过位置,所以探测而不是写死)。 */
export function dbCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const home = (env['OKX_AGENT_TASK_HOME'] ?? '').trim() || join(homedir(), '.okx-agent-task');
  return [join(home, 'sqlite', 'session-store.sqlite'), join(home, 'sqlite', 'input.sqlite'), join(home, 'session-store.sqlite'), join(home, 'input.sqlite')];
}

// ---------------------------------------------------------------- 类型

/** 队列行(真实表 `pending_gateway_deliveries` 里我们用得到的列)。 */
export interface QueueRow {
  id: string;
  job_id: string | null;
  message_id: string | null;
  content: string;
  llm_content: string | null;
  payload_json: string | null;
  created_at: string;
}

export interface OkxAspSubscription {
  job_id: string | null;
  title: string;
  provider: string;
  status: string;
  period_end: string | null;
}

export interface OkxAspCounters {
  seen: number;
  ingested: number;
  skipped_analysis: number;
  bad_rows: number;
}

export interface OkxAspStatus extends OkxAspCounters {
  available: boolean;
  db_path: string | null;
  last_poll_at: number | null;
  last_error: string | null;
  failures: number;
  next_attempt_at: number | null;
  subscriptions: OkxAspSubscription[];
  subscriptions_error: string | null;
  skipped_recent: { at: number; message_id: string; signal_type: string; note: string }[];
}

export interface OkxLight {
  ok: boolean;
  detail: string;
  checked_at: number;
}

export interface OkxAccountLights {
  wallet: OkxLight;
  a2a: OkxLight;
  trade_kit: OkxLight;
}

export type OkxCliRunner = (bin: 'onchainos' | 'okx-a2a', args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface OkxAspFeedDeps {
  kv: FollowKv;
  now?: () => number;
  /** 注入点:读队列行。生产 = `node:sqlite` 只读;测试给假数组。 */
  readQueue?: () => Promise<QueueRow[]>;
  /** 注入点:跑 onchainos / okx-a2a 拿 JSON。生产 spawn;测试假实现。 */
  runCli?: OkxCliRunner;
  /** Trade Kit 那盏灯(runtime 传 `okxStatusView()`;不传就是「未知」)。 */
  tradeKit?: () => { ok: boolean; detail: string };
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** 本次跟单会话 id(落进 `TraderSignal.session`,跨会话的旧行按历史信号处理)。 */
  session?: () => string | null;
}

// ---------------------------------------------------------------- JSON 抽取(collect.py 移植)

/**
 * 扫出文本里所有**顶层平衡**的 JSON 对象(collect.py `find_json_objects`)。
 * 投递内容是「人类文本 + 一坨 JSON」混排的,正则切不出来,只能按括号配平扫 ——
 * 字符串里的 `{`/`}`(和转义引号)必须跳过,否则一条带 `"note": "{涨}"` 的信号会把边界算错。
 */
export function findJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * 从一段投递内容里挑出信号 JSON(collect.py `pick_signal`);挑不到返回 null。
 * 优先级:直接带 `deliveryId` 的 → 某个值里嵌着 `deliveryId` 的 → 第一个候选。
 * (有些投递会把信号包一层信封,外层那个没有 deliveryId。)
 */
export function pickSignal(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const candidates: Record<string, unknown>[] = [];
  for (const blob of findJsonObjects(text)) {
    if (!SIGNAL_HINTS.some((h) => blob.includes(h))) continue;
    try {
      const obj = JSON.parse(blob) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) candidates.push(obj as Record<string, unknown>);
    } catch {
      // 半截 JSON:跳过,不影响同一段里其它对象。
    }
  }
  if (!candidates.length) return /arbitrage|basis|funding|套利|基差/i.test(text) ? {kind:'arbitrage', text} : null;
  for (const obj of candidates) if (obj['deliveryId']) return obj;
  for (const obj of candidates) {
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>)['deliveryId']) return v as Record<string, unknown>;
    }
  }
  return candidates[0]!;
}

/**
 * 时间自适应(collect.py `norm_ms`):秒 / 毫秒 / 微秒 / ISO 字符串都收,认不出 → null。
 * 阈值按 collect.py 原样:< 1e11 当秒,> 1e14 当微秒,中间当毫秒。
 */
export function normMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (Number.isFinite(n)) {
    if (n <= 0) return null;
    if (n < 1e11) return Math.round(n * 1000);
    if (n > 1e14) return Math.round(n / 1000);
    return Math.round(n);
  }
  const raw = String(v).trim();
  // 无时区的 naive 串按 UTC 解(trader-signal.ts P1-12 同一条教训:按本机时区解会整整偏 8 小时)。
  const naive = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(raw);
  const ms = Date.parse(naive ? `${raw.replace(' ', 'T')}Z` : raw);
  return Number.isFinite(ms) ? ms : null;
}

/** 外部文本消毒(控制字符、`@@`/`##` 提示注入引子、空白折叠)。 */
function sanitize(s: string, max = OKX_ASP_RAW_MAX_CHARS): string {
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ').replace(/[@#]{2}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------- 归一化

/** ASP 动作词 → 内部动作 + 方向(§1.1 第 2 条)。认不出返回 null = 坏行。 */
export function aspActionOf(raw: unknown): { action: TraderAction; side: Direction | null } | null {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return null;
  if (s === 'LONG' || s === 'BUY') return { action: 'open', side: 'long' };
  if (s === 'SHORT' || s === 'SELL') return { action: 'open', side: 'short' };
  if (s === 'CLOSE' || s === 'EXIT' || s === 'FLAT') return { action: 'close', side: null };
  if (s === 'REDUCE' || s === 'TP' || s === 'PARTIAL') return { action: 'reduce', side: null };
  if (s === 'ADD') return { action: 'add', side: null };
  return null;
}

/** 从一堆候选键里收十进制价(能解析成正数的都收,去重)。 */
function pricesOf(obj: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (v === null || v === undefined || v === '') return;
    const d = decimalOf(v);
    if (d !== null && Number(d) > 0 && !out.includes(d)) out.push(d);
  };
  for (const key of keys) {
    const v = obj[key];
    if (Array.isArray(v)) for (const x of v) push(x && typeof x === 'object' ? (x as Record<string, unknown>)['price'] : x);
    else if (v && typeof v === 'object') push((v as Record<string, unknown>)['price']);
    else push(v);
  }
  return out;
}

/** 「明确为 false」才算 false —— 字段缺失是「没说」,不能当拒绝。 */
function explicitlyFalse(v: unknown): boolean {
  if (v === false) return true;
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'false' || s === 'no' || s === '0';
}

export interface AspNormalizeCtx {
  now: number;
  /** ASP 名(订阅缓存里查到的;查不到由调用方给 `ASP <job_id 前 8 位>`)。 */
  trader: string;
  /** 原投递文本(进 `raw_text`)。 */
  raw_text: string;
  /** 队列行的 `created_at`(时间字段全坏时的兜底)。 */
  created_at?: string | null;
  session?: string | null;
  job_id?: string | null;
  makeId?: (signalId: string) => string;
}

/**
 * ASP 信号对象 → 内部 `TraderSignal`。**不抛**:坏行返回 `{signal:null, errors:[...]}`
 * (与 `normalizeBridgeSignal` 同形状,调用方计进坏行计数)。
 *
 * 只有 `signal_type === 'order'` 才是可跟信号;`analysis` 之类返回 `signal:null` 并在
 * errors 里以 `analysis:` 开头,由调用方分流到「已忽略」计数而不是坏行。
 */
export function normalizeAspSignal(objIn: unknown, ctx: AspNormalizeCtx): NormalizeResult {
  const input = objIn && typeof objIn === 'object' && !Array.isArray(objIn) ? objIn as Record<string,unknown> : {};
  const arbText = ctx.raw_text || JSON.stringify(input);
  if (input['kind'] === 'arbitrage' || /arbitrage|basis|funding|套利|基差/i.test(arbText)) {
    const nested = input['arbitrage'] && typeof input['arbitrage'] === 'object' ? input['arbitrage'] as Record<string,unknown> : input;
    const symbol = instIdToSymbol(String(nested['symbol'] ?? input['symbol'] ?? input['instId'] ?? /[A-Z0-9]+(?:-USDT(?:-SWAP)?|USDT)/.exec(arbText)?.[0] ?? '').toUpperCase());
    const signal_id = `okxasp_${createHash('sha256').update(String(input['deliveryId'] ?? arbText)).digest('hex').slice(0,24)}`;
    const amount = (v:unknown):string|null => typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v) ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
    const now = ctx.now;
    const signal: TraderSignal = { id:defaultSignalRowId(signal_id), signal_id, kind:'arbitrage',
      arbitrage:{symbol,spot_side:'long',perp_side:'short',basis_pct:amount(nested['basis_pct']),expected_apr:amount(nested['expected_apr'])}, reason:'arbitrage_recorded_only',
      record_id:null, trader:ctx.trader, symbol, side:null, action:'analysis_only', entry_kind:'unknown', entry_prices:[], stop:null, tps:[], size_pct:null,
      valid_until:null, published_at:now, ingested_at:now, raw_text:sanitize(arbText), ref_order:null, order_end_state:null, market_type:'arbitrage',
      transport:OKX_ASP_TRANSPORT, subscription_job_id:ctx.job_id ?? 'unknown', backfill:true, session:ctx.session ?? null, needs_reconcile:false,
      claim_id:null, claim_owner:null, claim_at:null, invalid_validity:false, status:'evidence', mode_applied:'evidence', thread_id:null,
      decision:null, created_at:now, updated_at:now };
    return {signal, errors:[]};
  }
  const errors: string[] = [];
  if (!objIn || typeof objIn !== 'object' || Array.isArray(objIn)) return { signal: null, errors: ['投递里挑不出信号对象'] };
  const obj = objIn as Record<string, unknown>;

  // ---- signal_type:只有 order 进跟单流(analysis 只计数)。
  const stype = String(obj['signal_type'] ?? obj['signalType'] ?? '').trim().toLowerCase();
  if (stype && stype !== 'order') return { signal: null, errors: [`analysis:signal_type=${stype} 不是可跟信号,只留痕`] };

  // ---- signal_id:`okxasp_<deliveryId>`;没有(或形状不合法)就按原文哈希。
  const deliveryId = String(obj['deliveryId'] ?? obj['delivery_id'] ?? '').trim();
  const hashed = `okxasp_${createHash('sha256').update(ctx.raw_text || JSON.stringify(obj)).digest('hex').slice(0, 24)}`;
  let signal_id = deliveryId ? `okxasp_${deliveryId}` : hashed;
  // id 是幂等键,不能脱敏也不能改写 —— 形状不合法就退回哈希(哈希一定合法且稳定)。
  if (signalIdError(signal_id)) signal_id = hashed;

  // ---- symbol:`BTC-USDT-SWAP` / `BTC-USDT` → `BTCUSDT`。
  const symbolRaw = String(obj['symbol'] ?? obj['instId'] ?? '').trim().toUpperCase();
  if (!symbolRaw) return { signal: null, errors: [...errors, 'symbol/instId 缺失'] };
  const symbol = instIdToSymbol(symbolRaw);

  // ---- action:认不出就是坏行(不猜方向)。
  const mapped = aspActionOf(obj['action'] ?? obj['raw_action'] ?? obj['direction']);
  if (!mapped) return { signal: null, errors: [...errors, `action ${JSON.stringify(obj['action'] ?? obj['raw_action'] ?? obj['direction'] ?? null)} 认不出`] };
  const action = mapped.action;
  // close/reduce/add 的方向从 direction/side/posSide 补(关联线程要用);补不到就是 null(合法)。
  const side: Direction | null = mapped.side ?? sideFrom(obj['direction'] ?? obj['side'] ?? obj['posSide']);

  // ---- published_at:signalTime|signal_time|ts|time,自适应;全坏退回队列行 created_at。
  let published_at: number | null = null;
  for (const key of ['signalTime', 'signal_time', 'ts', 'time']) {
    const at = normMs(obj[key]);
    if (at === null) continue;
    // 未来太多 = 坏数据(会以 0 秒龄过掉新鲜度闸);退回 created_at 而不是采信。
    if (at > ctx.now + MAX_CLOCK_SKEW_MS) {
      errors.push(`${key} 在未来超过允许偏差,不采信`);
      continue;
    }
    published_at = at;
    break;
  }
  if (published_at === null) published_at = normMs(ctx.created_at ?? null);
  if (published_at === null) return { signal: null, errors: [...errors, '无法确定 published_at(信号时间与队列 created_at 都解析不出)'] };

  // ---- valid_until:规则与 bridge 一致 —— 在场但不可信(解析不出 / 早于原发时间)= 隔离,不当无期限。
  const vuKey = ['valid_until', 'validUntil', 'expireAt', 'expiresAt'].find((k) => obj[k] !== null && obj[k] !== undefined && obj[k] !== '');
  const valid_until = vuKey ? normMs(obj[vuKey]) : null;
  let invalid_validity = false;
  if (vuKey && valid_until === null) {
    errors.push(`${vuKey} 解析不出时间:期限不可信,隔离`);
    invalid_validity = true;
  } else if (valid_until !== null && valid_until < published_at) {
    errors.push(`${vuKey} 早于 published_at:期限不可信,隔离`);
    invalid_validity = true;
  }

  // ---- 价格三件套。
  const entry_prices = pricesOf(obj, ['price', 'entry', 'entryPrice', 'entry_price']);
  const stopCandidates = pricesOf(obj, ['stop_loss', 'stopLoss', 'sl', 'slTriggerPx', 'stop']);
  const stop = protectiveStopPrice(stopCandidates, side);
  const tps: TraderTakeProfit[] = pricesOf(obj, ['take_profit', 'takeProfit', 'tp', 'tpTriggerPx']).map((price) => ({ price, pct: null }));
  const entry_kind: TraderEntryKind = entry_prices.length > 1 ? 'ladder' : entry_prices.length === 1 ? 'limit' : action === 'open' || action === 'add' ? 'market' : 'unknown';

  // ---- 「不可入场」标记 → 走现有 backfill 语义(永远 review_only,只进人工待办)。
  const reviewOnly = explicitlyFalse(obj['can_enter']) || explicitlyFalse(obj['is_executable']);

  // `sz`/`position_pct`/`leverage` **只留痕不参与仓位**(带单员自称的比重不是可比风险权重)。
  const hints = ['sz', 'position_pct', 'leverage'].map((k) => (obj[k] === undefined || obj[k] === null ? null : `${k}=${String(obj[k])}`)).filter((x): x is string => x !== null);
  const raw_text = sanitize([ctx.raw_text, hints.join(' ')].filter((t) => t.trim()).join(' | '));

  const now = ctx.now;
  const signal: TraderSignal = {
    id: (ctx.makeId ?? defaultSignalRowId)(signal_id),
    signal_id,
    record_id: null,
    trader: ctx.trader,
    symbol,
    side,
    action,
    entry_kind,
    entry_prices,
    stop,
    tps,
    size_pct: null,
    valid_until,
    published_at,
    ingested_at: now,
    raw_text,
    ref_order: null,
    order_end_state: null,
    market_type: 'perp',
    transport: OKX_ASP_TRANSPORT,
    subscription_job_id: ctx.job_id ?? 'unknown',
    // review_only 语义直接复用 backfill(resolveMode 里 backfill → review_only,永不自动开仓)。
    backfill: reviewOnly,
    session: ctx.session ?? null,
    needs_reconcile: false,
    claim_id: null,
    claim_owner: null,
    claim_at: null,
    invalid_validity,
    status: 'new',
    mode_applied: null,
    thread_id: null,
    decision: null,
    created_at: now,
    updated_at: now,
  };
  return { signal, errors };
}

// ---------------------------------------------------------------- 生产注入点(sqlite / CLI)

/** 只读打开一个库;WAL 库只读打不开时快照一份再读(store.py `_try_open`)。返回 null = 打不开。 */
function openRo(path: string): { db: DatabaseSync; tmp: string | null } | null {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    return { db, tmp: null };
  } catch {
    // 回退:把 db/-wal/-shm 拷到临时目录再读(WAL 只读打开会要求可写目录)。
  }
  let tmp: string | null = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'okxasp-'));
    const base = join(tmp, basename(path));
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(path + suffix)) copyFileSync(path + suffix, base + suffix);
    }
    const db = new DatabaseSync(base, { readOnly: true });
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    return { db, tmp };
  } catch {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    return null;
  }
}

/** 找到**真的有投递表**的那个库(store.py `open_input_ro`)。 */
export function openDeliveryDb(paths = dbCandidates()): { db: DatabaseSync; tmp: string | null; path: string } | null {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const opened = openRo(path);
    if (!opened) continue;
    const row = opened.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='pending_gateway_deliveries'").get() as { ok?: number } | undefined;
    if (row?.ok) return { ...opened, path };
    opened.db.close();
    if (opened.tmp) rmSync(opened.tmp, { recursive: true, force: true });
  }
  return null;
}

/** 生产版 `readQueue`:读全表(队列消费即删,所以「全表」就是待处理的那几条)。 */
export function readQueueFromDisk(paths = dbCandidates()): { rows: QueueRow[]; path: string } {
  const opened = openDeliveryDb(paths);
  if (!opened) throw new Error('找不到 a2a 投递库(okx-a2a daemon 还没跑起来?)');
  try {
    const raw = opened.db.prepare('SELECT id, job_id, message_id, content, llm_content, payload_json, created_at FROM pending_gateway_deliveries').all() as Record<string, unknown>[];
    // 09-22 实测:守护把 ASP 投递(含 deliverableType:file 的加密附件描述)写进 `user_attention`(kind=notification,
    // 行不删、status pending→handled),`pending_gateway_deliveries` 只是它派给本机 AI 会话的瞬时队列(起完就删,轮询几乎看不到)。
    // 所以两张表都读;user_attention 的幂等键用 idempotency_key(`agent-message:inbound:<xmtp msg id>`)。
    const hasAttention = (opened.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='user_attention'").get() as { ok?: number } | undefined)?.ok;
    const attention = hasAttention ? opened.db.prepare("SELECT id, kind, job_id, user_content, llm_content, choices_json, idempotency_key, created_at FROM user_attention WHERE deleted_at IS NULL AND kind='notification'").all() as Record<string, unknown>[] : [];
    for (const r of attention) raw.push({ id: `ua:${String(r['id'] ?? '')}`, job_id: r['job_id'], message_id: r['idempotency_key'] ?? `ua:${String(r['id'] ?? '')}`, content: r['user_content'], llm_content: r['llm_content'], payload_json: r['choices_json'], created_at: r['created_at'] });
    const rows: QueueRow[] = raw.map((r) => ({
      id: String(r['id'] ?? ''),
      job_id: r['job_id'] === null || r['job_id'] === undefined ? null : String(r['job_id']),
      message_id: r['message_id'] === null || r['message_id'] === undefined ? null : String(r['message_id']),
      content: String(r['content'] ?? ''),
      llm_content: r['llm_content'] === null || r['llm_content'] === undefined ? null : String(r['llm_content']),
      payload_json: r['payload_json'] === null || r['payload_json'] === undefined ? null : String(r['payload_json']),
      created_at: String(r['created_at'] ?? ''),
    }));
    return { rows, path: opened.path };
  } finally {
    opened.db.close();
    if (opened.tmp) rmSync(opened.tmp, { recursive: true, force: true });
  }
}

/**
 * 生产版 `runCli`:`~/.local/bin/<name>` 优先,其次 PATH。
 * **进程环境原样继承** —— OKX 后端要走代理,删掉 `*_PROXY` 会让 CLI 静默超时。
 */
export { spawnCli } from './cli.js';

// ---------------------------------------------------------------- Feed

export interface OkxAspPollResult {
  signals: TraderSignal[];
  /** 这轮新看到的投递行数。 */
  scanned: number;
  /** 归一化成功的条数。 */
  ingested: number;
  /** analysis 之类不入流的条数。 */
  skipped_analysis: number;
  bad_rows: number;
  error: string | null;
}

/** 一轮 ASP 巡检的结果(runtime 的 `okxAspTick()` 与 `POST /api/follow/okx-asp/poll` 的返回)。 */
export interface OkxAspTickResult {
  pulled: number;
  handled: number;
  skipped_analysis: number;
  bad_rows: number;
  error: string | null;
}

export class OkxAspFeed {
  private failures = 0;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private nextAttemptAt: number | null = null;
  private dbPath: string | null = null;
  private subs: OkxAspSubscription[] = [];
  private subsAt = 0;
  private subsError: string | null = null;
  private lights: OkxAccountLights | null = null;
  private lightsAt = 0;

  private readonly wallet: WalletStatus;
  constructor(private readonly deps: OkxAspFeedDeps) {
    this.wallet = new WalletStatus((_bin, args, timeout) => (deps.runCli ?? spawnCli)('onchainos', args, timeout), () => 'onchainos', deps.now);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 退避窗口内 → false(守护没跑时不刷屏,验收 §3.1)。 */
  ready(now = this.now()): boolean {
    return this.nextAttemptAt === null || now >= this.nextAttemptAt;
  }

  // ---- kv 小工具

  private seen(): string[] {
    const raw = this.deps.kv.kvGet(OKX_ASP_SEEN_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  private saveSeen(ids: readonly string[]): void {
    // FIFO 淘汰:新的追在后面,超过上限砍掉最老的。
    this.deps.kv.kvSet(OKX_ASP_SEEN_KEY, JSON.stringify(ids.slice(-OKX_ASP_SEEN_MAX)));
  }

  counters(): OkxAspCounters {
    const raw = this.deps.kv.kvGet(OKX_ASP_COUNTERS_KEY);
    const zero: OkxAspCounters = { seen: 0, ingested: 0, skipped_analysis: 0, bad_rows: 0 };
    if (!raw) return zero;
    try {
      const p = JSON.parse(raw) as Partial<OkxAspCounters>;
      return { seen: Number(p.seen ?? 0), ingested: Number(p.ingested ?? 0), skipped_analysis: Number(p.skipped_analysis ?? 0), bad_rows: Number(p.bad_rows ?? 0) };
    } catch {
      return zero;
    }
  }

  private bumpCounters(delta: Partial<OkxAspCounters>): void {
    const cur = this.counters();
    this.deps.kv.kvSet(OKX_ASP_COUNTERS_KEY, JSON.stringify({
      seen: cur.seen + (delta.seen ?? 0),
      ingested: cur.ingested + (delta.ingested ?? 0),
      skipped_analysis: cur.skipped_analysis + (delta.skipped_analysis ?? 0),
      bad_rows: cur.bad_rows + (delta.bad_rows ?? 0),
    }));
  }

  skippedRecent(): OkxAspStatus['skipped_recent'] {
    const raw = this.deps.kv.kvGet(OKX_ASP_SKIPPED_KEY);
    if (!raw) return [];
    try {
      const p = JSON.parse(raw) as unknown;
      return Array.isArray(p) ? (p as OkxAspStatus['skipped_recent']).slice(0, OKX_ASP_SKIPPED_RECENT_MAX) : [];
    } catch {
      return [];
    }
  }

  private pushSkipped(entries: OkxAspStatus['skipped_recent']): void {
    if (!entries.length) return;
    this.deps.kv.kvSet(OKX_ASP_SKIPPED_KEY, JSON.stringify([...entries, ...this.skippedRecent()].slice(0, OKX_ASP_SKIPPED_RECENT_MAX)));
  }

  // ---- 订阅

  /** `onchainos agent my-subscriptions --role buyer` → `job_id → 订阅`。缓存 60s;CLI 失败不影响轮询。 */
  async subscriptions(force = false): Promise<OkxAspSubscription[]> {
    const now = this.now();
    if (!force && this.subsAt && now - this.subsAt < OKX_ASP_SUBS_TTL_MS) return this.subs;
    const run = this.deps.runCli ?? spawnCli;
    this.subsAt = now;
    try {
      const r = await run('onchainos', ['agent', 'my-subscriptions', '--role', 'buyer'], OKX_CLI_TIMEOUT_MS);
      const body = JSON.parse(r.stdout.trim() || '{}') as { ok?: boolean; data?: { list?: unknown[] } };
      if (body.ok !== true) throw new Error(String(r.stderr || r.stdout).slice(0, 200) || 'CLI 返回 ok=false');
      const list = Array.isArray(body.data?.list) ? body.data!.list! : [];
      this.subs = list.map((x) => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        const str = (...keys: string[]): string => {
          for (const k of keys) if (o[k] !== null && o[k] !== undefined && String(o[k]).trim()) return String(o[k]).trim();
          return '';
        };
        return {
          job_id: str('jobId', 'job_id', 'subscriptionId') || null,
          title: str('serviceName', 'title', 'name', 'serviceTitle') || '(未命名服务)',
          provider: str('providerAgentName', 'providerName', 'provider', 'agentName') || '(未知 ASP)',
          status: str('status', 'state') || 'unknown',
          period_end: str('periodEnd', 'period_end', 'expireAt', 'nextBillingAt') || null,
        };
      });
      this.subsError = null;
    } catch (e) {
      // 订阅名查不到只是显示降级(信号仍然入流,trader 退回 `ASP <job_id>`),不能因此停轮询。
      this.subsError = (e as Error).message.slice(0, 200);
      this.subs = [];
    }
    return this.subs;
  }

  /** 一条投递的带单员名:订阅缓存里查 ASP 名,查不到就 `ASP <job_id 前 8 位>`。 */
  traderOf(jobId: string | null): string {
    const hit = jobId ? this.subs.find((s) => s.job_id === jobId) : null;
    if (hit) return (hit.provider !== '(未知 ASP)' ? hit.provider : hit.title).slice(0, 60);
    return `ASP ${(jobId ?? 'unknown').slice(0, 8)}`;
  }

  // ---- 三盏灯

  /** 钱包 / A2A 守护 / Trade Kit 三盏灯,缓存 30s(`fresh` 强刷)。 */
  /**
   * 先返回上一次结果,过期了在后台刷新(stale-while-revalidate):三盏灯要跑 onchainos / okx-a2a 两个 CLI,
   * 过期后同步现算要 7s+,网络抖时会超时,前端就显示「账户没连接」(2026-09-25)。只有从没算过或 fresh=1 才同步等。
   */
  private lightsRefresh: Promise<OkxAccountLights> | null = null;
  async accountLights(fresh = false): Promise<OkxAccountLights> {
    if (!fresh && this.lights) {
      if (this.now() - this.lightsAt >= OKX_ACCOUNT_TTL_MS && !this.lightsRefresh) {
        this.lightsRefresh = this.computeAccountLights(true).catch(() => this.lights!).finally(() => { this.lightsRefresh = null; });
      }
      return this.lights;
    }
    if (!fresh && this.lightsRefresh) return this.lightsRefresh;
    return this.computeAccountLights(fresh);
  }

  private async computeAccountLights(fresh: boolean): Promise<OkxAccountLights> {
    const now = this.now();
    if (!fresh && this.lights && now - this.lightsAt < OKX_ACCOUNT_TTL_MS) {
      const v = await this.wallet.status();
      return { ...this.lights, wallet: { ok: v.logged_in, detail: v.logged_in ? `${v.email ?? ''} · ${v.account_name ?? ''}`.trim() : '未登录(onchainos wallet login)', checked_at: v.checked_at } };
    }
    const run = this.deps.runCli ?? spawnCli;
    const view = await this.wallet.status(fresh);
    const wallet = { ok: view.logged_in, detail: view.logged_in ? `${view.email ?? ''} · ${view.account_name ?? ''}`.trim() : '未登录(onchainos wallet login)', checked_at: view.checked_at };
    const a2a = await run('okx-a2a', ['status'], OKX_CLI_TIMEOUT_MS)
      .then((r) => {
        const text = `${r.stdout} ${r.stderr}`.trim();
        const ok = /running/i.test(text) && r.code === 0;
        return { ok, detail: ok ? text.slice(0, 120) : `守护没跑(okx-a2a daemon start;跑起来后记得补代理)${text ? `:${text.slice(0, 80)}` : ''}`, checked_at: now };
      })
      .catch((e: Error) => ({ ok: false, detail: `读不到守护状态:${e.message.slice(0, 120)}`, checked_at: now }));
    const kit = this.deps.tradeKit?.() ?? { ok: false, detail: '未接 Trade Kit 状态' };
    this.lights = { wallet, a2a, trade_kit: { ...kit, checked_at: now } };
    this.lightsAt = now;
    return this.lights;
  }

  // ---- 轮询

  /**
   * 拉一轮队列。**失败不抛**:返回 `error` 并把退避推起来(调用方是巡检循环,
   * 守护没跑时每 3s 报一次错等于刷屏)。
   */
  async poll(): Promise<OkxAspPollResult> {
    const empty: OkxAspPollResult = { signals: [], scanned: 0, ingested: 0, skipped_analysis: 0, bad_rows: 0, error: null };
    const now = this.now();
    if (!this.ready(now)) return { ...empty, error: '退避窗口内' };
    let rows: QueueRow[];
    try {
      if (this.deps.readQueue) rows = await this.deps.readQueue();
      else {
        const r = readQueueFromDisk();
        this.dbPath = r.path;
        rows = r.rows;
      }
    } catch (e) {
      this.failures += 1;
      this.lastError = (e as Error).message.slice(0, 300);
      this.nextAttemptAt = now + backoffMs(this.failures);
      this.deps.log('warn', `OKX.AI 队列读不到(第 ${this.failures} 次,退避 ${Math.round(backoffMs(this.failures) / 1000)}s):${this.lastError}`);
      return { ...empty, error: this.lastError };
    }
    this.failures = 0;
    this.lastError = null;
    this.nextAttemptAt = null;
    this.lastPollAt = now;
    // 订阅名只为显示,拿不到不挡轮询(第一次会顺手刷一遍缓存)。
    if (!this.subsAt) await this.subscriptions().catch(() => []);

    const seen = this.seen();
    const seenSet = new Set(seen);
    const fresh: string[] = [];
    const out: TraderSignal[] = [];
    const skipped: OkxAspStatus['skipped_recent'] = [];
    let bad = 0;
    let scanned = 0;
    for (const row of rows) {
      const mid = row.message_id?.trim() || `row-${row.id}`;
      if (seenSet.has(mid)) continue;
      seenSet.add(mid);
      fresh.push(mid);
      scanned++;
      // 三个字段各扫一遍:有的投递把信号放在 content,有的在 llm_content / payload_json。
      const texts = [row.content, row.llm_content, row.payload_json].filter((t): t is string => typeof t === 'string' && t.trim() !== '');
      let obj: Record<string, unknown> | null = null;
      let rawText = '';
      for (const t of texts) {
        const picked = pickSignal(t);
        if (picked) {
          obj = picked;
          rawText = t;
          break;
        }
      }
      if (!obj) {
        // 挑不出信号的行也留痕(前 4000 字),不然事后没法排查解析。
        this.deps.kv.kvSet(`${OKX_ASP_RAW_PREFIX}${mid}`, sanitize(texts.join(' | ')));
        skipped.push({ at: now, message_id: mid, signal_type: 'none', note: '投递里挑不出信号 JSON,已留原文' });
        continue;
      }
      const r = normalizeAspSignal(obj, {
        now,
        trader: this.traderOf(row.job_id),
        raw_text: rawText,
        created_at: row.created_at,
        session: this.deps.session?.() ?? null,
        job_id: row.job_id,
      });
      if (!r.signal) {
        const why = r.errors.join(';');
        if (why.startsWith('analysis:')) {
          skipped.push({ at: now, message_id: mid, signal_type: String(obj['signal_type'] ?? obj['signalType'] ?? 'unknown'), note: why.slice(9, 200) });
        } else {
          bad++;
          this.deps.kv.kvSet(`${OKX_ASP_RAW_PREFIX}${mid}`, sanitize(`${why} || ${rawText}`));
          this.deps.log('warn', `OKX.AI 投递 ${mid} 归一化失败(已留痕):${why.slice(0, 200)}`);
        }
        continue;
      }
      if (r.errors.length) this.deps.log('warn', `OKX.AI 投递 ${mid} 有软错误:${r.errors.join(';').slice(0, 200)}`);
      out.push(r.signal);
    }
    if (fresh.length) this.saveSeen([...seen, ...fresh]);
    this.pushSkipped(skipped);
    if (scanned) this.bumpCounters({ seen: scanned, ingested: out.length, skipped_analysis: skipped.length, bad_rows: bad });
    return { signals: out, scanned, ingested: out.length, skipped_analysis: skipped.length, bad_rows: bad, error: null };
  }

  status(): OkxAspStatus {
    return {
      // 「可用」= 最近一次轮询没失败(退避中 = 守护多半没跑)。
      available: this.lastError === null && this.lastPollAt !== null,
      db_path: this.dbPath,
      last_poll_at: this.lastPollAt,
      last_error: this.lastError,
      failures: this.failures,
      next_attempt_at: this.nextAttemptAt,
      subscriptions: this.subs,
      subscriptions_error: this.subsError,
      skipped_recent: this.skippedRecent(),
      ...this.counters(),
    };
  }
}

// ---------------------------------------------------------------- Durable Signal Market inbox
import type { DemoStore } from '../store.js';
import type { MarketSettings } from './settings.js';
import { object, spawnWatch, type WatchHandle, type WatchRunner } from './cli.js';
import { startAspRun } from './audit.js';
/** ASP 用 `deliver --file` 发的加密附件:投递正文只有这几行描述,内容要拿 secret 解密下载后才看得到。 */
export interface FileDelivery { file_key: string; digest: string; salt: string; nonce: string; secret: string; filename: string | null; }
export function parseFileDelivery(text: string): FileDelivery | null {
  if (!/deliverableType:\s*file/i.test(text)) return null;
  const pick = (k: string) => text.match(new RegExp(`${k}:\\s*(\\S+)`))?.[1] ?? null;
  const file_key = pick('fileKey'); const digest = pick('digest'); const salt = pick('salt'); const nonce = pick('nonce'); const secret = pick('secret');
  if (!file_key || !digest || !salt || !nonce || !secret) return null;
  return { file_key, digest, salt, nonce, secret, filename: pick('filename')?.replace(/\.{3}」?$/, '') ?? null };
}
/**
 * 纯文本行式信号(Alpha Engine #10521 实测格式,09-22):
 * `【合约信号】ONE-PERP | LONG 1x | 入场 0.005365-0.005408 | SL 0.003476 | TP1 0.007292 | 仓位 5% | 4h 内有效`
 * 转成 normalizeAspSignal 吃的对象;认不全(没币种/没方向)就 null,让它按 notice/invalid 留痕。
 * 平台不规定 payload schema,每家 ASP 都可能是自己的文本样式,这里是第一家文本适配器;新样式加新分支,别放宽正则去「猜」。
 */
export function parseTextSignal(text: string, createdAt: string | number | null | undefined): Record<string, unknown> | null {
  const line = text.split('\n').map((l) => l.trim()).find((l) => (/^【?(合约|永续|现货)?信号】?/.test(l) || /^【(Futures|合约)】/i.test(l)) && /\|/.test(l));
  if (!line) return null;
  const parts = line.split('|').map((x) => x.trim());
  const head = parts[0]!.replace(/^【[^】]*】\s*/, '');
  const sym = head.match(/^([A-Z0-9]+)[-\/]?(PERP|USDT(?:-SWAP)?|USD)?/i); if (!sym) return null;
  const symbol = `${sym[1]!.toUpperCase()}-USDT-SWAP`;
  const dir = parts[1]?.match(/^(LONG|SHORT|BUY|SELL|多|空)\s*(\d+(?:\.\d+)?)?x?/i); if (!dir) return null;
  const action = /^(LONG|BUY|多)/i.test(dir[1]!) ? 'LONG' : 'SHORT';
  const num = (label: RegExp) => { const p = parts.find((x) => label.test(x)); const m = p?.match(/(\d+(?:\.\d+)?)(?:\s*[-~–]\s*(\d+(?:\.\d+)?))?/); return m ? [m[1]!, ...(m[2] ? [m[2]] : [])] : []; };
  const entry = num(/^(入场|entry|reference price|order price)/i); const sl = num(/^(SL|止损|stop loss)/i); const tp = parts.filter((x) => /^(TP\d*|止盈|take profit)/i.test(x)).flatMap((x) => x.replace(/^(TP\d*|止盈\d*|take profit)\s*/i, '').match(/\d+(?:\.\d+)?/g) ?? []);
  const pct = parts.find((x) => /^(仓位|position)/i.test(x))?.match(/\d+(?:\.\d+)?/)?.[0];
  const validPart = parts.find((x) => /有效|valid/i.test(x)); const hours = validPart?.match(/(\d+)\s*h/i)?.[1] ?? (validPart?.match(/(\d+)\s*min/i) ? String(Number(validPart.match(/(\d+)\s*min/i)![1]) / 60) : undefined);
  const published = createdAt === null || createdAt === undefined ? NaN : typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  // 同一条行式信号会到两次:XMTP 原件([Received])和守护里无头 Claude 的「信号送达」回执;幂等键按行内容哈希,两份合成一条。
  const deliveryId = `line-${createHash('sha256').update(`${symbol}|${action}|${entry.join('-')}|${sl[0] ?? ''}|${tp.join('/')}`).digest('hex').slice(0, 16)}`;
  return { deliveryId, signal_type: 'order', symbol, action, entry, stop_loss: sl[0] ?? null, take_profit: tp, ...(dir[2] ? { leverage: dir[2] } : {}), ...(pct ? { position_pct: pct } : {}), ...(hours && Number.isFinite(published) ? { valid_until: published + Number(hours) * 3600_000 } : {}), text_format: 'alpha_engine_line' };
}
/** 把密钥材料从要落账本的原文里抹掉(账本会展示给前端)。 */
export function stripFileSecrets(text: string): string { return text.replace(/^(salt|nonce|secret):.*$/gim, '$1: [redacted]'); }
/** 生产版解密:`okx-a2a file download` 到 ~/.okx-agent-task/downloads,回传文件文本;失败回 null(原文照样留痕)。 */
export async function downloadFileDelivery(d: FileDelivery, agentId: string, jobId: string): Promise<string | null> {
  const name = `${jobId.slice(0, 10)}-${d.digest.slice(0, 12)}.txt`;
  const r = await spawnCli('okx-a2a', ['file', 'download', '--file-key', d.file_key, '--agent-id', agentId, '--digest', d.digest, '--salt', d.salt, '--nonce', d.nonce, '--secret', d.secret, '--filename', name], 60_000);
  if (r.code !== 0) return null;
  const path = r.stdout.trim().split('\n').find((l) => l.startsWith('/')) ?? join(homedir(), '.okx-agent-task', 'downloads', name);
  if (!existsSync(path)) return null;
  const { readFileSync } = await import('node:fs');
  return readFileSync(path, 'utf8').slice(0, 200_000);
}
export interface MarketInboxDeps {
  store: DemoStore; settings: () => MarketSettings; session: () => string;
  /** 解密文件投递;不给就只留描述原文。agentId 是本机买方身份(file download 要它)。 */
  fetchFile?: (d: FileDelivery, jobId: string) => Promise<string | null>;
  readQueue?: () => Promise<QueueRow[]>; watch?: WatchRunner; now?: () => number;
  traderOf?: (jobId: string) => string;
  signalEnabled?: () => boolean;
  system: (event: Record<string, unknown>, eventId: string) => Promise<void>;
  emit: (event: string, payload: unknown) => void;
}
export interface InboxRow { rowid: number; delivery_id: string; job_id: string; received_at: number; raw: string; parse_status: string; signal_id: string | null; signal_json: string | null; errors_json: string; signal_type: string | null; session: string | null; }
/** Ledger rows are immutable; cursor advances only after capture in demo_trader_signal succeeds. */
export class MarketInbox {
  private watchHandle: WatchHandle | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopping: Promise<void> = Promise.resolve();
  private polling: Promise<{ scanned: number; duplicates: number }> | null = null;
  private lastPoll: number | null = null;
  private lastError: string | null = null;
  private nextAttempt = 0;
  private failures = 0;
  private duplicates = 0;
  private watchBuffer = '';
  private watchStopping = false;
  constructor(private readonly deps: MarketInboxDeps) {}
  private get db() { return this.deps.store.marketDb; }
  /** 文件投递的「队列键 → 账本 delivery_id」映射落 kv:同一附件不重复下载。 */
  private seenKey(key: string): boolean {
    const mapped = this.deps.store.kvGet(`market.file_seen.${key}`);
    return !!mapped && !!this.db.prepare('SELECT 1 FROM okx_market_delivery_in WHERE delivery_id=?').get(mapped);
  }
  private markSeen(key: string, delivery: string): void { this.deps.store.kvSet(`market.file_seen.${key}`, delivery); }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private systemEnvelope(text: string): Record<string, unknown> | null {
    for (const blob of findJsonObjects(text)) {
      try { const o = object(JSON.parse(blob)); const message = object(o['message']);
        if (message['source'] === 'system' && message['event']) return { ...message, agentId: o['agentId'] ?? message['agentId'] };
        if (o['source'] === 'system' && o['event']) return o;
      } catch { /* untrusted malformed row still gets a ledger entry */ }
    }
    return null;
  }
  async accept(rows: QueueRow[]): Promise<{ scanned: number; duplicates: number }> {
    let scanned = 0; let duplicates = 0;
    for (const incoming of rows) {
      const row = redactDeep(incoming);
      const texts = [row.content, row.llm_content, row.payload_json].filter((x): x is string => !!x);
      // 文件投递:先按幂等键查账本(避免每轮都去下载),没见过才解密,解密出的正文放最前面参与挑信号。
      const fileDesc = [incoming.content, incoming.llm_content].filter((x): x is string => !!x).map(parseFileDelivery).find(Boolean) ?? null;
      const preKey = row.message_id ?? `row-${row.id}`;
      if (fileDesc && this.seenKey(preKey)) { duplicates++; continue; }
      if (fileDesc && this.deps.fetchFile) {
        let body: string | null = null;
        try { body = await this.deps.fetchFile(fileDesc, row.job_id || 'unknown'); } catch (e) { this.deps.emit('market_delivery_error', { job_id: row.job_id, error: (e as Error).message }); }
        if (body) texts.unshift(body);
      }
      const raw = stripFileSecrets(texts.join('\n'));
      const envelope = texts.map((t) => this.systemEnvelope(t)).find(Boolean);
      if (envelope) {
        // Business identity is stable across redelivery with a different queue message id.
        const eid = String(envelope['eventId'] ?? createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
        await this.deps.system(envelope, eid); continue;
      }
      const obj = texts.map(pickSignal).find(Boolean) ?? texts.map((t) => parseTextSignal(t, row.created_at)).find(Boolean) ?? null;
      const delivery = String(obj?.['deliveryId'] ?? obj?.['delivery_id'] ?? row.message_id ?? `row-${row.id}`);
      if (this.db.prepare('SELECT 1 FROM okx_market_delivery_in WHERE delivery_id=?').get(delivery)) { duplicates++; continue; }
      if (fileDesc) this.markSeen(preKey, delivery);
      const job = row.job_id || 'unknown';
      const r = normalizeAspSignal(obj, { now: this.now(), raw_text: raw, trader: this.deps.traderOf?.(job) ?? `ASP ${job.slice(0, 8)}`, created_at: row.created_at, session: this.deps.session(), job_id: job });
      if (r.signal && this.deps.signalEnabled?.() === false) r.signal.backfill = true;
      // 平台文字通知(「试用已开始」「续订成功」这类,正文没有任何 JSON)不是坏信号,记 notice 而不是 invalid/DLQ。
      const notice = !obj && !fileDesc && !raw.includes('{') && /【|订阅|试用|subscription|renew|trial/i.test(raw);
      const status = r.signal?.kind === 'arbitrage' ? 'arbitrage' : r.signal ? (r.signal.invalid_validity || (r.signal.valid_until !== null && r.signal.valid_until < this.now()) ? 'expired' : 'order') : r.errors[0]?.startsWith('analysis:') ? 'analysis' : notice ? 'notice' : 'invalid';
      this.db.prepare('INSERT OR IGNORE INTO okx_market_delivery_in(delivery_id,job_id,received_at,raw,parse_status,signal_id,signal_json,errors_json,signal_type,session) VALUES (?,?,?,?,?,?,?,?,?,?)').run(delivery, job, this.now(), raw, status, r.signal?.signal_id ?? null, r.signal ? JSON.stringify(r.signal) : null, JSON.stringify(r.errors), r.signal?.kind === 'arbitrage' ? 'arbitrage' : obj ? String(obj['signal_type'] ?? 'order').toLowerCase() : null, this.deps.session());
      scanned++;
      this.deps.emit('market_delivery', { delivery_id: delivery, job_id: job, parse_status: status, signal_id: r.signal?.signal_id ?? null });
    }
    this.duplicates += duplicates;
    if (scanned) {
      const id = startAspRun(this.deps.store, 'asp_inbox_tick', { deliveries: scanned });
      this.deps.store.bots.finishRun(id, { status: 'done', result: { received: scanned, duplicates } });
    }
    return { scanned, duplicates };
  }
  async poll(): Promise<{ scanned: number; duplicates: number }> {
    if (this.deps.settings().transport !== 'queue' || this.watchHandle) throw Object.assign(new Error('watch transport 不允许同时轮询 queue'), { status: 409 });
    await this.stopping;
    if (this.polling) return this.polling;
    if (this.now() < this.nextAttempt) return { scanned: 0, duplicates: 0 };
    this.polling = (async () => {
      try {
        const rows = this.deps.readQueue ? await this.deps.readQueue() : readQueueFromDisk().rows;
        const r = await this.accept(rows); this.lastPoll = this.now(); this.lastError = null; this.failures = 0; return r;
      } catch (e) { this.lastError = (e as Error).message; this.nextAttempt = this.now() + backoffMs(++this.failures); throw e; }
      finally { this.polling = null; }
    })();
    return this.polling;
  }
  syncTransport(): void {
    const f = this.deps.settings();
    if (!f.enabled || f.transport !== 'watch') { this.stopWatch(); return; }
    if (this.watchHandle || this.polling || this.watchStopping || this.now() < this.nextAttempt) return;
    this.watchHandle = (this.deps.watch ?? spawnWatch)((text) => {
      this.chain = this.chain.then(async () => {
        await this.acceptWatchLine(text);
        this.lastPoll = this.now(); this.lastError = null;
      }).catch((e: Error) => { this.lastError = e.message; });
    }, (error) => { this.watchHandle = null; this.lastError = error; this.nextAttempt = this.now() + backoffMs(++this.failures); });
  }
  private async acceptWatchLine(line: string): Promise<void> {
    const text = this.watchBuffer ? `${this.watchBuffer}\n${line}` : line;
    let value: unknown;
    try { value = JSON.parse(text); this.watchBuffer = ''; }
    catch {
      if ((text.trim() === '{' || this.watchBuffer) && text.length < 1024 * 1024 && findJsonObjects(text).length === 0) { this.watchBuffer = text; return; }
      this.watchBuffer = ''; value = null;
    }
    const envelope = object(value);
    const items = Array.isArray(value) ? value : Array.isArray(envelope['items']) ? envelope['items'] : Array.isArray(object(envelope['data'])['items']) ? object(envelope['data'])['items'] as unknown[] : [value];
    for (const item of items) {
      const o = object(item); const m = object(o['message']);
      const raw = items.length === 1 && value === item ? text : JSON.stringify(item);
      const content = [o['content'], o['userContent'], m['content']].find((x) => typeof x === 'string');
      await this.accept([{ id: createHash('sha256').update(raw || text).digest('hex'), message_id: o['messageId'] ? String(o['messageId']) : null, job_id: String(o['jobId'] ?? m['jobId'] ?? '') || null, content: raw || text, llm_content: typeof content === 'string' ? content : null, payload_json: null, created_at: new Date(this.now()).toISOString() }]);
    }
  }
  private stopWatch(): void {
    const handle = this.watchHandle; this.watchHandle = null;
    if (handle) {
      this.watchStopping = true;
      this.stopping = Promise.resolve(handle.stop()).finally(() => { this.watchStopping = false; });
    }
  }
  async stop(): Promise<void> { this.stopWatch(); await this.stopping; await this.chain; await this.polling?.catch(() => {}); }
  /** Synchronous durable transfer. A restart replays only rows not captured before the cursor commit. */
  capture(): TraderSignal[] {
    const cursor = Number(this.deps.store.kvGet('market.in_cursor') ?? 0);
    const rows = this.db.prepare('SELECT rowid,* FROM okx_market_delivery_in WHERE rowid>? ORDER BY rowid LIMIT 500').all(cursor) as unknown as InboxRow[];
    const signals: TraderSignal[] = [];
    for (const row of rows) {
      if (row.signal_json) {
        const signal = JSON.parse(row.signal_json) as TraderSignal;
        if (row.session !== this.deps.session()) signal.backfill = true;
        const r = this.deps.store.traderSignals.capture(signal);
        if (r.created || r.signal.status === 'new') signals.push(r.signal);
      }
      this.deps.store.kvSet('market.in_cursor', String(row.rowid));
    }
    return signals;
  }
  rows(opts: { job_id?: string; status?: string; limit?: number } = {}): Omit<InboxRow, 'signal_json' | 'errors_json'>[] {
    const rows = this.db.prepare('SELECT rowid,* FROM okx_market_delivery_in WHERE (? IS NULL OR job_id=?) AND (? IS NULL OR parse_status=?) ORDER BY rowid DESC LIMIT ?').all(opts.job_id ?? null, opts.job_id ?? null, opts.status ?? null, opts.status ?? null, opts.limit ?? 100) as unknown as InboxRow[];
    return rows.map(({ signal_json, errors_json, ...r }) => ({ ...r, raw: r.raw.slice(0, 4000), signal: signal_json ? JSON.parse(signal_json) : null, errors: JSON.parse(errors_json) }));
  }
  status() {
    const counts = this.db.prepare("SELECT COUNT(*) AS received, SUM(parse_status='invalid') AS dlq, SUM(parse_status='analysis') AS analysis FROM okx_market_delivery_in").get()!;
    return { transport: this.deps.settings().transport, experimental: this.deps.settings().transport === 'watch', alive: this.deps.settings().enabled && (this.watchHandle !== null || (this.lastPoll !== null && this.lastError === null)), last_poll: this.lastPoll, last_error: this.lastError, cursor: Number(this.deps.store.kvGet('market.in_cursor') ?? 0), received: Number(counts['received']), dlq: Number(counts['dlq'] ?? 0), analysis: Number(counts['analysis'] ?? 0), duplicates: this.duplicates };
  }
}
