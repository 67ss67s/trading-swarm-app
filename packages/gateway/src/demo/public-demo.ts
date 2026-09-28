// 公网演示模式(.codex-reports/soak-14d.addendum-1.md §2):免登录只读 + 演示可玩(限频、限额) + owner 管理。
//
// 三种身份:
//   anonymous — 没有 cookie 的访客,按来源 IP 的 HMAC 区分;所有 GET 可读(敏感读取被遮蔽),演示可玩类限频限额。
//   invited   — 用 `?invite=<TG_REVIEW_INVITE_TOKEN>` 换到 HttpOnly cookie 的评审,配额更高、可下 paper 单。
//   owner     — `X-Owner-Token` / `Authorization: Bearer` 头,或 `?owner=<TG_OWNER_TOKEN>` 换到的 cookie;与本机开发同权。
//
// 访客发起的模型调用只在「访客上下文」(AsyncLocalStorage)里计费;后台循环与 owner 的调用走原有的判断上限 /
// decision_daily_usd_cap,不占演示额度,也不会被演示闸门挡住。
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import { BoundedMap } from './bounded-map.js';
import { envInt } from './ops-config.js';

const DAY_MS = 86_400_000;
const OWNER_COOKIE_TTL_MS = 12 * 3_600_000;
const INVITE_COOKIE_TTL_MS = 7 * DAY_MS;
const COOKIE_NAME = 'tg_demo';

export const publicDemo = (): boolean => process.env['TG_PUBLIC_DEMO'] === '1';

export type DemoRole = 'anonymous' | 'invited' | 'owner';

export interface DemoContext {
  role: DemoRole;
  owner: boolean;
  invited: boolean;
  /** 不可逆的访客标识:invited 用 cookie 里的随机数,anonymous 用来源 IP 的 HMAC。 */
  visitor: string;
}

export const demoContext = new AsyncLocalStorage<DemoContext>();

/** 当前调用是否由非 owner 访客发起(后台任务与 owner 返回 null)。 */
export function visitorContext(): DemoContext | null {
  if (!publicDemo()) return null;
  const ctx = demoContext.getStore();
  return ctx && !ctx.owner ? ctx : null;
}

/**
 * 公网演示的拒绝。锁定项一律 403 + code `judge_locked`,message 用英文写明原因(前端直接做 tooltip);
 * 限频/额度/忙分别是 demo_rate_limited / demo_budget_exhausted / demo_busy(429)。
 */
export class DemoDenied extends Error {
  constructor(message: string, readonly code = 'judge_locked', readonly status = 403) {
    super(message);
  }
}

// ---------------------------------------------------------------- 身份

function ownerToken(): string {
  const token = process.env['TG_OWNER_TOKEN'] ?? '';
  if (publicDemo() && token.length < 32) throw new Error('TG_PUBLIC_DEMO=1 要求 TG_OWNER_TOKEN 至少 32 个字符');
  return token;
}

/** 常数时间比较;期望值为空时一律不相等(没配 invite 就没有 invite 身份)。 */
function sameSecret(supplied: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(value: string): string {
  return createHmac('sha256', ownerToken()).update(value).digest('base64url');
}

interface CookieClaims { role: 'owner' | 'invited'; expires: number; nonce: string }

function issueCookie(role: CookieClaims['role'], now = Date.now()): { value: string; maxAgeSeconds: number } {
  const ttl = role === 'owner' ? OWNER_COOKIE_TTL_MS : INVITE_COOKIE_TTL_MS;
  const claims: CookieClaims = { role, expires: now + ttl, nonce: randomBytes(12).toString('hex') };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { value: `${payload}.${sign(payload)}`, maxAgeSeconds: Math.floor(ttl / 1000) };
}

function readCookie(req: IncomingMessage, now = Date.now()): CookieClaims | null {
  const raw = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
  if (!raw) return null;
  const [payload = '', mac = ''] = raw.split('.');
  if (!sameSecret(mac, sign(payload))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CookieClaims;
    if (claims.role !== 'owner' && claims.role !== 'invited') return null;
    return claims.expires > now ? claims : null;
  } catch {
    return null;
  }
}

function headerToken(req: IncomingMessage): string {
  const explicit = req.headers['x-owner-token'];
  if (typeof explicit === 'string') return explicit;
  const auth = req.headers.authorization ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

/** 只信任明确配置的回环单跳 nginx;nginx 必须用 $remote_addr 覆盖 X-Real-IP。 */
function clientAddress(req: IncomingMessage): string {
  const peer = req.socket?.remoteAddress ?? 'local';
  const trusted = process.env['TG_TRUST_LOOPBACK_PROXY'] === '1' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
  const forwarded = req.headers['x-real-ip'];
  return trusted && typeof forwarded === 'string' && forwarded ? forwarded : peer;
}

export function identify(req: IncomingMessage): DemoContext {
  const claims = readCookie(req);
  const owner = claims?.role === 'owner' || sameSecret(headerToken(req), ownerToken());
  if (owner) return { role: 'owner', owner: true, invited: false, visitor: 'owner' };
  if (claims?.role === 'invited') return { role: 'invited', owner: false, invited: true, visitor: `i:${claims.nonce}` };
  const visitor = createHmac('sha256', ownerToken()).update(clientAddress(req)).digest('hex').slice(0, 32);
  return { role: 'anonymous', owner: false, invited: false, visitor: `a:${visitor}` };
}

/** `?owner=` / `?invite=` 换 HttpOnly cookie;返回 null 表示两个都不对。 */
export function exchangeSessionCookie(url: URL): { cookie: string; role: CookieClaims['role'] } | null {
  const owner = url.searchParams.get('owner');
  const invite = url.searchParams.get('invite');
  const role = owner && sameSecret(owner, ownerToken()) ? 'owner'
    : invite && sameSecret(invite, process.env['TG_REVIEW_INVITE_TOKEN'] ?? '') ? 'invited'
      : null;
  if (!role) return null;
  const issued = issueCookie(role);
  const secure = process.env['TG_DEMO_INSECURE_COOKIE'] === '1' ? '' : '; Secure';
  return { role, cookie: `${COOKIE_NAME}=${issued.value}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${issued.maxAgeSeconds}` };
}

// ---------------------------------------------------------------- 限频(进程内,重启清零即可)

const rateWindows = new BoundedMap<string, { at: number; n: number }>(8192);

function rateLimit(key: string, perMinute: number, now = Date.now()): void {
  const prior = rateWindows.get(key);
  const row = prior && now - prior.at < 60_000 ? prior : { at: now, n: 0 };
  if (row.n >= perMinute) throw new DemoDenied('Too many requests from this visitor. Please retry in a minute.', 'demo_rate_limited', 429);
  row.n++;
  rateWindows.set(key, row);
}

/** 每个非 owner 请求都计入:全站 + 单访客。 */
export function limitRequest(ctx: DemoContext): void {
  if (ctx.owner) return;
  rateLimit('req:global', envInt('TG_DEMO_REQUESTS_PER_MINUTE', 1200));
  rateLimit(`req:${ctx.visitor}`, ctx.invited
    ? envInt('TG_DEMO_INVITE_REQUESTS_PER_MINUTE', 600)
    : envInt('TG_DEMO_VISITOR_REQUESTS_PER_MINUTE', 240));
}

// ---------------------------------------------------------------- 持久日额度(UTC 日,重启不清零)

let usageDb: DatabaseSync | undefined;

export function configureDemo(db: DatabaseSync): void {
  usageDb = db;
}

const utcDay = (now = Date.now()): number => Math.floor(now / DAY_MS) * DAY_MS;

function requireUsageDb(): DatabaseSync {
  if (!usageDb) throw new DemoDenied('The demo quota ledger is not ready yet.', 'demo_budget_unavailable', 503);
  return usageDb;
}

/** 演示可玩类写请求:分钟限频 + 每日次数上限。 */
export function limitDemoAction(ctx: DemoContext): void {
  if (ctx.owner) return;
  rateLimit('act:global', envInt('TG_DEMO_WRITES_PER_MINUTE', 60));
  rateLimit(`act:${ctx.visitor}`, ctx.invited ? 20 : 6);
  const db = requireUsageDb();
  const day = utcDay();
  const subject = `actions:${ctx.visitor}`;
  const cap = ctx.invited ? envInt('TG_DEMO_INVITE_DAILY_ACTIONS', 200) : envInt('TG_DEMO_ANON_DAILY_ACTIONS', 20);
  const prior = db.prepare('SELECT requests FROM ops_demo_usage WHERE day = ? AND subject = ?').get(day, subject) as { requests: number } | undefined;
  if ((prior?.requests ?? 0) >= cap) throw new DemoDenied('Daily demo action limit reached. Reports and pages remain browsable.', 'demo_budget_exhausted', 429);
  db.prepare('INSERT INTO ops_demo_usage(day, subject, requests) VALUES (?, ?, 1) ON CONFLICT(day, subject) DO UPDATE SET requests = requests + 1').run(day, subject);
}

/** 十进制美元字符串 → 微美元整数(不用 float 记账)。 */
export function microUsd(value: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error(`金额必须是最多六位小数的非负十进制字符串:${value}`);
  const [whole = '0', frac = ''] = value.split('.');
  const n = Number(whole) * 1_000_000 + Number(frac.padEnd(6, '0'));
  if (!Number.isSafeInteger(n)) throw new Error('金额过大');
  return n;
}

function capMicro(name: string, fallback: string): number {
  return microUsd(process.env[name] || fallback);
}

/**
 * 出站前保守预留(失败/超时不退回):访客总池 TG_DEMO_DAILY_USD + 单访客池。
 * 一个 SAVEPOINT 里先查后加,node:sqlite 同步执行,同进程内不会交错。
 */
export function reserveDemoCost(amount: number): void {
  const ctx = visitorContext();
  if (!ctx || amount <= 0) return;
  const db = requireUsageDb();
  const day = utcDay();
  const subjects: [string, number][] = [
    ['visitors', capMicro('TG_DEMO_DAILY_USD', '2')],
    [`usd:${ctx.visitor}`, ctx.invited ? capMicro('TG_DEMO_INVITE_DAILY_USD', '0.50') : capMicro('TG_DEMO_VISITOR_DAILY_USD', '0.10')],
  ];
  db.exec('SAVEPOINT demo_cost');
  try {
    for (const [subject, limit] of subjects) {
      const row = db.prepare('SELECT reserved_microusd FROM ops_demo_usage WHERE day = ? AND subject = ?').get(day, subject) as { reserved_microusd: number } | undefined;
      if ((row?.reserved_microusd ?? 0) + amount > limit) throw new DemoDenied('Daily demo spending cap reached. Please come back tomorrow; existing reports remain browsable.', 'demo_budget_exhausted', 429);
    }
    const add = db.prepare('INSERT INTO ops_demo_usage(day, subject, reserved_microusd) VALUES (?, ?, ?) ON CONFLICT(day, subject) DO UPDATE SET reserved_microusd = reserved_microusd + excluded.reserved_microusd');
    for (const [subject] of subjects) add.run(day, subject, amount);
    db.exec('RELEASE demo_cost');
  } catch (e) {
    db.exec('ROLLBACK TO demo_cost; RELEASE demo_cost');
    throw e;
  }
}

/** HTTP 模型:按 TG_DEMO_MODEL_PRICES_JSON 的单价上界预留;没配价格的模型访客不能用。 */
export function reserveHttpModel(name: string, input: string, maxOutputTokens = 4096): void {
  if (!visitorContext()) return;
  const prices = JSON.parse(process.env['TG_DEMO_MODEL_PRICES_JSON'] || '{}') as Record<string, { input_per_million: string; output_per_million: string }>;
  const price = prices[name];
  if (!price) throw new DemoDenied('Locked in the review demo: this model has no configured demo price.', 'judge_locked');
  // 输入按 UTF-8 字节数当 token 上界(+1024 协议开销),输出按 max_tokens 硬上限。
  const inputTokens = Buffer.byteLength(input) + 1024;
  reserveDemoCost(Math.ceil((inputTokens * microUsd(price.input_per_million) + maxOutputTokens * microUsd(price.output_per_million)) / 1_000_000));
}

/**
 * 本机 CLI 模型(pi/claude,订阅制):按 TG_DEMO_CLI_CALL_USD 的名义单价计入;不配则访客不能触发。
 * 访客的提示词不能交给带工具的 CLI(codex read-only 沙箱也能读服务器文件,包括 env 里的 owner token)。
 */
export function reserveCliModel(toolless: boolean): void {
  if (!visitorContext()) return;
  if (!toolless) throw new DemoDenied('Locked in the review demo: local model CLIs with tools are owner-only.', 'judge_locked');
  const perCall = process.env['TG_DEMO_CLI_CALL_USD'];
  if (!perCall) throw new DemoDenied('Locked in the review demo: the local model is not enabled for visitors.', 'judge_locked');
  reserveDemoCost(microUsd(perCall));
}

/** Jev 结构化决策:按单次费用上界预留。 */
export function reserveJev(): void {
  if (!visitorContext()) return;
  const upper = process.env['TG_DEMO_JEV_MAX_CALL_USD'];
  if (!upper) throw new DemoDenied('Locked in the review demo: Jev decision calls are not enabled for visitors.', 'judge_locked');
  reserveDemoCost(microUsd(upper));
}

/** 交易所 / 链上写操作的最后一道闸:访客上下文里一律拒绝(路由层已先挡,这里防遗漏)。 */
export function assertVisitorCannotWrite(): void {
  if (visitorContext()) throw new DemoDenied('Locked in the review demo: exchange, wallet and platform writes are owner-only.');
}

export function demoBudgetView(): { visitors_reserved_usd: string; visitors_daily_cap_usd: string } | null {
  if (!publicDemo() || !usageDb) return null;
  const row = usageDb.prepare("SELECT reserved_microusd FROM ops_demo_usage WHERE day = ? AND subject = 'visitors'").get(utcDay()) as { reserved_microusd: number } | undefined;
  return {
    visitors_reserved_usd: ((row?.reserved_microusd ?? 0) / 1_000_000).toFixed(6),
    visitors_daily_cap_usd: process.env['TG_DEMO_DAILY_USD'] || '2',
  };
}

// ---------------------------------------------------------------- 并发槽(1 vCPU 保护)

const slotsInUse = { heavy: 0, chat: 0 };

/** 重计算(回测/研究/矩阵/漏斗):TG_HEAVY_ENABLED=0 整体关闭;并发 TG_HEAVY_CONCURRENCY(公网演示默认 1,本机默认不限)。 */
function heavyLimit(): number {
  if (process.env['TG_HEAVY_ENABLED'] === '0') throw new DemoDenied('Heavy computation is disabled on this server; existing research reports remain available.', 'heavy_disabled', 503);
  return envInt('TG_HEAVY_CONCURRENCY', publicDemo() ? 1 : 0, 0, 64);
}

/** 访客对话:并发 TG_DEMO_CHAT_CONCURRENCY(默认 1);owner 与后台不占。 */
function chatLimit(): number {
  return visitorContext() ? envInt('TG_DEMO_CHAT_CONCURRENCY', 1, 1, 16) : 0;
}

/** 取一个并发槽,返回幂等的释放函数;满了抛 429。limit=0 表示不限。 */
export function claimSlot(kind: 'heavy' | 'chat'): () => void {
  const limit = kind === 'heavy' ? heavyLimit() : chatLimit();
  if (limit === 0) return () => undefined;
  if (slotsInUse[kind] >= limit) throw new DemoDenied(kind === 'heavy' ? 'The server is busy with another computation. Please retry shortly.' : 'The demo assistant is busy. Please retry shortly.', 'demo_busy', 429);
  slotsInUse[kind]++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slotsInUse[kind]--;
  };
}

/** 提前判断重计算能不能接(POST 时先回友好提示,而不是建一个立刻失败的任务)。 */
export function assertHeavyAvailable(): void {
  const limit = heavyLimit();
  if (limit !== 0 && slotsInUse.heavy >= limit) throw new DemoDenied('The server is busy with another computation. Please retry shortly.', 'demo_busy', 429);
}
