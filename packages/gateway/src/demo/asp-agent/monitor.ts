/**
 * ASP 运行监视器(只读):把人工巡检看的东西汇总成一份快照,给 OKX.AI 页的「监视」面板用。
 *   GET  /api/asp-services/monitor[?lang=en&fresh=1]           → AspMonitor
 *   GET  /api/asp-services/monitor/pushes?service_id=&hours=    → 该服务的推送明细(信号行 / 详情 / 每个订阅 job 的结果)
 *   GET  /api/asp-services/monitor/tasks/:job_id                → 订单明细(交付文本、错误、次数)
 *   POST /api/asp-services/monitor/retry-pushes                 → 失败推送立刻进入重发(跳过 5 分钟冷却),本地动作,不改上架资料
 *
 * 服务列表以 OKX 上本 ASP 实际上架的服务为准(service-list,和上架状态一起 10 分钟查一次),查不到退回本地配置,
 * 所以上架/下架/改名会自动反映到面板上。
 *
 * 判定口径(与 09-26 上架复盘一致):
 * - 订阅服务:平台按「12 小时内有没有带类型头的信号行」判,距上次成功投递 >7h 警告、>11h 故障;
 * - 接单轮询:轮询被别的进程的机器锁挡住、或上次轮询超过 5 分钟 = 故障;刚启动还没轮询 = 警告;
 * - okx-a2a 守护 / 盘口录制器:进程不在 = 故障;录制数据 15 分钟没更新 = 警告;
 * - 网络:近 1 小时 onchainos 调用失败率 >30% 警告、>60% 故障(本机经 Clash,抖动是常态);
 * - 其余全部读本地库/文件/进程表,不调写命令。
 */
import { execFile } from 'node:child_process';
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cliStats, list, object, type MarketCli } from './cli.js';

export type Level = 'ok' | 'warn' | 'fail' | 'unknown';
export type Lang = 'zh' | 'en';
export interface MonitorCheck { key: string; label: string; status: Level; summary: string; at: number | null; hint: string | null }
export interface MonitorService {
  service_id: string; name: string; kind: 'subscription' | 'one_time'; price: string | null; status: Level; summary: string;
  /** 订阅类 */
  subscribers: number; last_delivered_at: number | null; last_signal: string | null; failed_recent: number;
  timeline: { at: number; channel: string; status: string }[];
  /** 按次类:近 7 天订单按状态计数 */
  orders_7d: Record<string, number>; last_order_at: number | null;
}
export interface MonitorTask {
  job_id: string; kind: string; state: string; test_flag: boolean; buyer: string | null; service_id: string | null; service: string;
  title: string | null; created_at: number; updated_at: number; error: string | null; status: Level; retryable: boolean;
}
export interface AspMonitor {
  at: number; lang: Lang; overall: Level; asp_id: string | null; asp_name: string | null; services_source: 'listing' | 'local_config';
  checks: MonitorCheck[]; services: MonitorService[];
  tasks: { counts_24h: Record<string, number>; items: MonitorTask[] };
  cli: { window_ms: number; total: number; failed: number; by_code: Record<string, number>; recent_errors: { at: number; command: string; code: string | null }[] };
}
export interface MonitorDeps {
  db: DatabaseSync;
  cli: MarketCli;
  now(): number;
  lang?: Lang;
  /** true = 跳过 10 分钟缓存,立刻重查上架状态和服务列表 */
  fresh?: boolean;
  aspId(): Promise<string | null>;
  poller(): { running: boolean; lock_held: boolean; interval_ms: number; last_tick: { at: number; error: string | null; tasks: number; locked: boolean } | null };
  /** 本地配置里的服务(上架列表查不到时的退路,也用来补名字) */
  services(): { service_id: string; name: string; kind: 'subscription' | 'one_time' }[];
  strategyRuns(): { status: string; publish_asp: boolean; strategy_name: string; timeframe: string; next_scan_at: number | null }[];
  /** 测试注入:进程表、文件时间、录制日志尾部 */
  processes?(): Promise<string>;
  recorderDataMtime?(): number | null;
  recorderLogTail?(): string;
  listenerMtime?(): number | null;
}

const H = 3_600_000, M = 60_000;
export const SUB_WARN_MS = 7 * H, SUB_FAIL_MS = 11 * H;
const worst = (xs: Level[]): Level => xs.includes('fail') ? 'fail' : xs.includes('warn') ? 'warn' : xs.includes('unknown') ? 'unknown' : 'ok';

const STATE_TEXT: Record<string, [string, string]> = {
  delivered: ['已交付', 'delivered'], declined: ['已拒单', 'declined'], closed: ['已关闭', 'closed'], seen: ['待接单', 'awaiting acceptance'],
  accepting: ['接单中', 'accepting'], accepted: ['已接单', 'accepted'], delivering: ['交付中', 'delivering'], deliver_failed: ['交付失败', 'delivery failed'],
  deliver_unknown: ['交付结果未知', 'delivery unconfirmed'], accept_unknown: ['接单结果未知', 'acceptance unconfirmed'], decline_unknown: ['拒单结果未知', 'decline unconfirmed'],
  declining: ['拒单中', 'declining'], skipped: ['已跳过', 'skipped'], no_handler: ['无处理器', 'no handler'],
};
/** 双语文案:zh 给本机 5191,en 给评审站快照 */
function tr(lang: Lang) {
  const L = (zh: string, en: string) => (lang === 'en' ? en : zh);
  const ago = (raw: number) => {
    const ms = Math.max(0, raw);
    if (ms < M) return L(`${Math.round(ms / 1000)} 秒前`, `${Math.round(ms / 1000)}s ago`);
    if (ms < H) return L(`${Math.round(ms / M)} 分钟前`, `${Math.round(ms / M)} min ago`);
    return L(`${(ms / H).toFixed(1)} 小时前`, `${(ms / H).toFixed(1)} h ago`);
  };
  const state = (s: string) => { const x = STATE_TEXT[s]; return x ? L(x[0], x[1]) : s; };
  return { L, ago, state };
}

// ---------------------------------------------------------------- 上架状态 + 实际上架的服务(10 分钟缓存)

interface ListingInfo {
  at: number; label: string | null; status: number | null; name: string | null; error: string | null;
  services: { service_id: string; name: string; kind: 'subscription' | 'one_time'; price: string | null }[] | null;
}
let listingCache: ListingInfo | null = null;
const LISTING_TTL = 10 * M;

let listingInflight: Promise<ListingInfo> | null = null;
export const LISTING_WAIT_MS = 15_000;
/**
 * 上架状态 + 服务列表。CLI 调用在网关里是串行队列,重启后常要排几十秒:
 * 有缓存(哪怕过期)就先回缓存、后台刷新;没有缓存最多等 LISTING_WAIT_MS,超时先回「未知」,不把整个监视接口拖住。
 */
async function listing(deps: MonitorDeps, asp: string | null): Promise<ListingInfo> {
  const now = deps.now();
  if (listingCache && !deps.fresh && now - listingCache.at < LISTING_TTL) return listingCache;
  listingInflight ??= fetchListing(deps, asp).finally(() => { listingInflight = null; });
  if (listingCache && !deps.fresh) return listingCache;
  const timeout = new Promise<null>((r) => { const t = setTimeout(() => r(null), deps.fresh ? LISTING_WAIT_MS * 4 : LISTING_WAIT_MS); (t as { unref?: () => void }).unref?.(); });
  return (await Promise.race([listingInflight, timeout])) ?? { at: now, label: null, status: null, name: null, services: null, error: 'still querying OKX' };
}
async function fetchListing(deps: MonitorDeps, asp: string | null): Promise<ListingInfo> {
  const now = deps.now();
  const next: ListingInfo = { ...(listingCache ?? { label: null, status: null, name: null, services: null }), at: now, error: null };
  try {
    const out = object(await deps.cli.call('get-my-agents', ['--role', 'asp']));
    const accounts = (object(out['data'])['list'] as unknown[] | undefined) ?? [];
    const agents = accounts.flatMap((a) => (object(a)['agentList'] as unknown[] | undefined) ?? []).map(object);
    const me = agents.find((a) => String(a['agentId']) === asp) ?? agents[0] ?? {};
    next.label = me['approvalLabel'] ? String(me['approvalLabel']) : null;
    next.status = me['approvalDisplayStatus'] === undefined ? null : Number(me['approvalDisplayStatus']);
    next.name = me['name'] ? String(me['name']) : null;
  } catch (e) { next.error = (e as Error).message.split('\n')[0]!.slice(0, 160); }
  if (asp) {
    try {
      const rows = list(await deps.cli.call('service-list', ['--agent-id', asp, '--page-size', '50']));
      const svc = rows.flatMap((r) => (Array.isArray(r['list']) ? (r['list'] as unknown[]).map(object) : r['serviceId'] ? [r] : []));
      if (svc.length) next.services = svc.map((s) => {
        const sub = Array.isArray(s['subscription']) ? (s['subscription'] as unknown[]).map(object) : [];
        return { service_id: String(s['serviceId']), name: String(s['serviceName'] ?? s['serviceId']), kind: sub.length ? 'subscription' as const : 'one_time' as const, price: sub.length ? `${sub[0]!['fee']} USDT/month` : s['fee'] ? `${s['fee']} USDT` : null };
      });
    } catch (e) { next.error ??= (e as Error).message.split('\n')[0]!.slice(0, 160); }
  }
  listingCache = next;
  return next;
}

const home = () => process.env['HOME'] ?? homedir();
function mtime(path: string): number | null { try { return statSync(path).mtimeMs; } catch { return null; } }
function latestMtime(dir: string): number | null {
  try { return readdirSync(dir).map((f) => mtime(join(dir, f)) ?? 0).reduce((a, b) => Math.max(a, b), 0) || null; } catch { return null; }
}
function tail(path: string, bytes = 16_384): string {
  try {
    const size = statSync(path).size, fd = openSync(path, 'r'), len = Math.min(bytes, size), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len); closeSync(fd); return buf.toString('utf8');
  } catch { return ''; }
}
const psList = () => new Promise<string>((resolve) => execFile('ps', ['-axo', 'pid=,command='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => resolve(String(out ?? ''))));
export const isStrategySignal = (name: string) => /strategy signal/i.test(name);

// ---------------------------------------------------------------- 推送账本读取(两本账:频道扇出 + 策略信号)

export interface PushRow { event_id: string; channel: string; created_at: number; status: string; updated_at: number; job_id: string; attempts: number; signal: string | null; detail: string | null; error: string | null; subscribers: number }
function pushRows(db: DatabaseSync, service_id: string, since: number, strategy: boolean): PushRow[] {
  const a = (db.prepare(`SELECT p.event_id, p.channel, p.created_at, j.status, j.updated_at, j.job_id, j.attempts, j.error, p.text, p.payload_json, p.subscribers_json FROM okx_market_service_push p JOIN okx_market_service_push_job j USING(event_id)
    WHERE p.service_id=? AND p.created_at>=? ORDER BY p.created_at`).all(service_id, since) as Record<string, unknown>[]).map((r) => {
    let signal: string | null = null; try { const v = object(JSON.parse(String(r['payload_json'])))['signal']; signal = typeof v === 'string' ? v : null; } catch {}
    const text = String(r['text'] ?? '');
    return { event_id: String(r['event_id']), channel: String(r['channel']), created_at: Number(r['created_at']), status: String(r['status']), updated_at: Number(r['updated_at']), job_id: String(r['job_id']),
      attempts: Number(r['attempts'] ?? 0), signal: signal ?? text, detail: text && text !== signal ? text : null, error: r['error'] ? String(r['error']).split('\n')[0]!.slice(0, 300) : null, subscribers: count(r['subscribers_json']) };
  });
  let b: PushRow[] = [];
  if (strategy) {
    try {
      b = (db.prepare(`SELECT o.event_id, o.created_at, j.status, j.updated_at, j.job_id, j.attempts, j.error, o.deliverable_text, o.subscriber_set_json FROM okx_market_delivery_out o JOIN okx_market_delivery_out_job j USING(event_id)
        WHERE o.created_at>=? ORDER BY o.created_at`).all(since) as Record<string, unknown>[]).map((r) => ({
        event_id: String(r['event_id']), channel: 'strategy_signal', created_at: Number(r['created_at']), status: String(r['status']), updated_at: Number(r['updated_at']), job_id: String(r['job_id']),
        attempts: Number(r['attempts'] ?? 0), signal: String(r['deliverable_text'] ?? ''), detail: null, error: r['error'] ? String(r['error']).split('\n')[0]!.slice(0, 300) : null, subscribers: count(r['subscriber_set_json']) }));
    } catch {}
  }
  return [...a, ...b].sort((x, y) => x.created_at - y.created_at);
}
const count = (json: unknown) => { try { const v = JSON.parse(String(json ?? '[]')) as unknown; return Array.isArray(v) ? v.length : 0; } catch { return 0; } };

function lastDeliveredEver(db: DatabaseSync, sid: string, strategy: boolean): number | null {
  const a = db.prepare("SELECT MAX(j.updated_at) AS t FROM okx_market_service_push p JOIN okx_market_service_push_job j USING(event_id) WHERE p.service_id=? AND j.status='delivered'").get(sid) as { t: number | null } | undefined;
  let b: { t: number | null } | undefined;
  if (strategy) { try { b = db.prepare("SELECT MAX(updated_at) AS t FROM okx_market_delivery_out_job WHERE status='delivered'").get() as { t: number | null } | undefined; } catch {} }
  const t = Math.max(Number(a?.t ?? 0), Number(b?.t ?? 0));
  return t > 0 ? t : null;
}

// ---------------------------------------------------------------- 快照

export async function buildAspMonitor(deps: MonitorDeps): Promise<AspMonitor> {
  const lang: Lang = deps.lang ?? 'zh', { L, ago, state } = tr(lang);
  const now = deps.now(), db = deps.db, checks: MonitorCheck[] = [];
  const asp = await deps.aspId().catch(() => null);

  // 上架状态
  const li = await listing(deps, asp);
  checks.push({ key: 'listing', label: L('上架状态', 'Listing'), at: li.at,
    status: li.status === 4 ? 'ok' : li.status === 2 ? 'warn' : li.status === null ? 'unknown' : 'fail',
    summary: `${li.label ?? L('未知', 'unknown')}${li.error ? L(`(最近一次查询失败:${li.error})`, ' (last query failed)') : ''}`,
    hint: li.status === 4 ? L('已上架;每 10 分钟向 OKX 查一次,点「重查」立即刷新', 'Listed; checked with OKX every 10 minutes')
      : li.status === 2 ? L('审核中:审核方会下测试单,保持接单和推送在线', 'Under review: the reviewer places test orders, keep order-taking and pushes online')
        : L('被拒或未上架:看 OKX 给的理由,修完用 onchainos agent activate 重新提审', 'Rejected or not listed: read the reason from OKX, fix, then resubmit') });

  // 接单轮询
  const p = deps.poller(), lt = p.last_tick, pollAge = lt ? now - lt.at : null;
  checks.push({ key: 'poller', label: L('接单轮询', 'Order poller'), at: lt?.at ?? null,
    // 刚启动还没轮询过时 lock_held 也是 false,不算故障;只有轮询时被别的进程的锁挡住(locked)才判红
    status: !p.running || lt?.locked || (pollAge !== null && pollAge > 5 * M) ? 'fail' : lt === null || lt.error ? 'warn' : 'ok',
    summary: !p.running ? L('轮询没在跑', 'Poller is not running') : lt?.locked ? L('机器锁被别的进程占着(可能另有实例在接单)', 'Machine lock held by another process (another instance taking orders?)')
      : lt ? L(`上次轮询 ${ago(pollAge!)},看到 ${lt.tasks} 个任务`, `Last poll ${ago(pollAge!)}, ${lt.tasks} task(s) seen`) + (lt.error ? L(`,出错:${lt.error.split('\n')[0]!.slice(0, 120)}`, '; last poll failed') : '')
        : L('刚启动,等第一轮轮询', 'Just started, waiting for the first poll'),
    hint: L('每 60 秒向 OKX 拉一次新订单并接单;订单要在 3 小时内接,红了先看网关是否在跑', 'Pulls and accepts new orders every 60 s; orders must be accepted within 3 hours') });

  // 进程:okx-a2a 守护 + 录制器
  const ps = await (deps.processes ?? psList)();
  const a2aUp = /okx-a2a(?:\.js)?\s+run\b/.test(ps), recUp = /recorder\.mjs/.test(ps);
  const listener = (deps.listenerMtime ?? (() => mtime(join(home(), '.okx-agent-task/logs/listener.log'))))();
  checks.push({ key: 'a2a', label: L('okx-a2a 守护', 'okx-a2a daemon'), at: listener,
    status: !a2aUp ? 'fail' : listener === null || now - listener > 30 * M ? 'warn' : 'ok',
    summary: !a2aUp ? L('进程不在', 'Process not found') : L(`在跑,监听日志更新于 ${listener === null ? '从未' : ago(now - listener)}`, `Running, listener active ${listener === null ? 'never' : ago(now - listener)}`),
    hint: L('接收订单和系统事件的通道;挂了用 launchctl kickstart -k gui/$UID/com.okx.a2a 拉起', 'Receives orders and system events from OKX.AI') });
  const recData = (deps.recorderDataMtime ?? (() => latestMtime(join(home(), '.trade-gate-okx/micro/data'))))();
  const recTail = (deps.recorderLogTail ?? (() => tail(join(home(), '.trade-gate-okx/micro/recorder.log'))))();
  const recFails = recTail.split('\n').filter((l) => { const t = Date.parse(l.slice(0, 24)); return t > now - H && /fail|timeout|abort/i.test(l); }).length;
  checks.push({ key: 'recorder', label: L('盘口录制器', 'Order-book recorder'), at: recData,
    status: !recUp ? 'fail' : recData === null || now - recData > 15 * M ? 'warn' : recFails > 60 ? 'warn' : 'ok',
    summary: !recUp ? L('进程不在', 'Process not found') : L(`数据写入于 ${recData === null ? '从未' : ago(now - recData)},近 1 小时抓取失败 ${recFails} 次`, `Data written ${recData === null ? 'never' : ago(now - recData)}, ${recFails} fetch failure(s) in the last hour`),
    hint: L('微观告警的数据源;挂了用 launchctl kickstart -k gui/$UID/com.tradegate.micro-recorder 拉起', 'Data source for the microstructure alerts') });

  // 网络 / CLI
  const calls = cliStats(now - H);
  const failed = calls.filter((c) => !c.ok && c.code !== 'cli_invalid_json');
  const byCode: Record<string, number> = {};
  for (const c of failed) byCode[c.code ?? 'error'] = (byCode[c.code ?? 'error'] ?? 0) + 1;
  const rate = calls.length ? failed.length / calls.length : 0;
  checks.push({ key: 'network', label: L('网络 / OKX CLI', 'Network / OKX CLI'), at: calls.at(-1)?.at ?? null,
    status: calls.length < 5 ? (calls.length ? 'ok' : 'unknown') : rate > 0.6 ? 'fail' : rate > 0.3 ? 'warn' : 'ok',
    summary: calls.length ? L(`近 1 小时 onchainos 调用失败 ${failed.length}/${calls.length}(${Math.round(rate * 100)}%)`, `${failed.length}/${calls.length} OKX calls failed in the last hour (${Math.round(rate * 100)}%)`) : L('近 1 小时没有 onchainos 调用', 'No OKX calls in the last hour'),
    hint: L('本机经 Clash 出网,失败率高多半是代理节点;失败的推送会自动重发', 'Failed pushes are retried automatically') });

  // 策略运行(策略信号服务的信号源)
  const runs = deps.strategyRuns().filter((r) => r.publish_asp);
  const live = runs.filter((r) => r.status === 'running');
  const runName = (n: string) => (lang === 'en' && /[一-鿿]/.test(n) ? 'Strategy' : n);
  checks.push({ key: 'strategy_run', label: L('策略运行(信号源)', 'Strategy run (signal source)'), at: live[0]?.next_scan_at ?? null,
    status: live.length ? 'ok' : runs.length ? 'warn' : 'unknown',
    summary: live.length ? live.map((r) => L(`${r.strategy_name} ${r.timeframe} 运行中`, `${runName(r.strategy_name)} ${r.timeframe} running`)).join(' · ')
      : runs.length ? L(`${runs.length} 个发布到 ASP 的运行,都没在跑`, `${runs.length} publishing run(s), none running`) : L('没有发布到 ASP 的策略运行', 'No run publishes to the ASP'),
    hint: L('Strategy Signals 的真实信号来自这里;没在跑时只有 6 小时一条的状态信号', 'Live Strategy Signals come from this run') });

  // 服务:以 OKX 上实际上架的为准
  const local = deps.services();
  const listed = li.services;
  const services0 = listed ?? local.map((s) => ({ ...s, price: null }));
  const sevenDays = now - 7 * 24 * H;
  const services: MonitorService[] = services0.map((s) => {
    const strategy = isStrategySignal(s.name);
    if (s.kind === 'subscription') {
      const all = pushRows(db, s.service_id, now - 24 * H, strategy);
      const delivered = all.filter((r) => r.status === 'delivered');
      const lastOk = delivered.length ? Math.max(...delivered.map((r) => r.updated_at)) : lastDeliveredEver(db, s.service_id, strategy);
      const last = all.at(-1), age = lastOk === null ? null : now - lastOk;
      const status: Level = age === null ? 'warn' : age > SUB_FAIL_MS ? 'fail' : age > SUB_WARN_MS ? 'warn' : 'ok';
      return { service_id: s.service_id, name: s.name, kind: 'subscription', price: s.price, status, subscribers: last?.subscribers ?? 0, last_delivered_at: lastOk,
        last_signal: last?.signal ?? null, failed_recent: all.filter((r) => r.status === 'failed').length, orders_7d: {}, last_order_at: null,
        summary: age === null ? L('还没有送达过信号', 'No signal delivered yet') : L(`上次信号送达 ${ago(age)}`, `Last signal delivered ${ago(age)}`) + (age > SUB_WARN_MS ? L(',平台 12 小时没信号会判不合格', '; the platform flags services silent for 12 h') : ''),
        timeline: all.map((r) => ({ at: r.created_at, channel: r.channel, status: r.status })) };
    }
    const rows = db.prepare('SELECT state, COUNT(*) AS n, MAX(created_at) AS last FROM okx_market_provider_task WHERE service_id=? AND created_at>=? GROUP BY state').all(s.service_id, sevenDays) as { state: string; n: number; last: number }[];
    const orders: Record<string, number> = {}; let lastOrder: number | null = null;
    for (const r of rows) { orders[r.state] = Number(r.n); lastOrder = Math.max(lastOrder ?? 0, Number(r.last)); }
    const total = Object.values(orders).reduce((a, b) => a + b, 0);
    const bad = (orders['declined'] ?? 0) + (orders['deliver_failed'] ?? 0) + (orders['deliver_unknown'] ?? 0) + (orders['skipped'] ?? 0);
    return { service_id: s.service_id, name: s.name, kind: 'one_time', price: s.price, status: bad ? 'warn' : 'ok', subscribers: 0, last_delivered_at: null, last_signal: null, failed_recent: 0,
      orders_7d: orders, last_order_at: lastOrder, timeline: [],
      summary: total ? L(`近 7 天 ${total} 单:`, `${total} order(s) in 7 days: `) + Object.entries(orders).map(([k, n]) => `${state(k)} ${n}`).join(' · ') : L('近 7 天没有订单', 'No orders in 7 days') };
  });

  // 订单(审核方测试单 + 真实订单)
  const nameOf = (sid: string | null) => services0.find((x) => x.service_id === sid)?.name ?? local.find((x) => x.service_id === sid)?.name ?? sid ?? '—';
  const trows = db.prepare('SELECT job_id,kind,state,test_flag,buyer_agent_id,service_id,created_at,updated_at,error,raw_json FROM okx_market_provider_task ORDER BY created_at DESC LIMIT 60').all() as Record<string, unknown>[];
  const STUCK = new Set(['seen', 'accepting', 'accepted', 'delivering', 'deliver_failed']);
  const items: MonitorTask[] = trows.map((r) => {
    const st = String(r['state']), age = now - Number(r['updated_at']);
    let title: string | null = null; try { const t = object(JSON.parse(String(r['raw_json'] ?? '{}')))['jobName']; title = typeof t === 'string' ? t : null; } catch {}
    const status: Level = st === 'delivered' || st === 'closed' ? 'ok'
      : STUCK.has(st) ? (age > 2 * H ? 'fail' : age > 20 * M ? 'warn' : 'ok')
        : ['declined', 'deliver_unknown', 'decline_unknown', 'accept_unknown', 'no_handler', 'skipped'].includes(st) ? 'warn' : 'ok';
    const sid = r['service_id'] ? String(r['service_id']) : null;
    return { job_id: String(r['job_id']), kind: String(r['kind']), state: st, test_flag: !!Number(r['test_flag']), buyer: r['buyer_agent_id'] ? String(r['buyer_agent_id']) : null,
      service_id: sid, service: nameOf(sid), title, created_at: Number(r['created_at']), updated_at: Number(r['updated_at']),
      // 错误原文是本机 CLI 输出(中文/路径),只给本机看
      error: r['error'] && lang === 'zh' ? String(r['error']).split('\n')[0]!.slice(0, 200) : null, status, retryable: st === 'deliver_failed' || st === 'deliver_unknown' };
  });
  const counts: Record<string, number> = {};
  for (const r of db.prepare('SELECT state, COUNT(*) AS n FROM okx_market_provider_task WHERE created_at>=? GROUP BY state').all(now - 24 * H) as { state: string; n: number }[]) counts[r.state] = Number(r.n);
  const recent = items.filter((x) => x.created_at >= now - 24 * H);
  checks.push({ key: 'tasks', label: L('订单(24 小时)', 'Orders (24 h)'), at: items[0]?.created_at ?? null,
    status: recent.length ? worst(recent.map((x) => x.status)) : 'ok',
    summary: recent.length ? Object.entries(counts).map(([k, n]) => `${state(k)} ${n}`).join(' · ') : L('近 24 小时没有订单', 'No orders in the last 24 h'),
    hint: L('审核方的测试单被拒或交付失败都会影响上架;点订单看交付内容', 'Declined or failed reviewer orders affect the listing') });

  return {
    at: now, lang, asp_id: asp, asp_name: li.name, services_source: listed ? 'listing' : 'local_config',
    overall: worst([...checks.map((c) => c.status).filter((s) => s !== 'unknown'), ...services.map((s) => s.status)]),
    checks, services, tasks: { counts_24h: counts, items },
    cli: { window_ms: H, total: calls.length, failed: failed.length, by_code: byCode, recent_errors: failed.slice(-8).reverse().map((c) => ({ at: c.at, command: c.command, code: c.code })) },
  };
}

// ---------------------------------------------------------------- 明细

export function monitorPushes(db: DatabaseSync, service_id: string, opts: { now: number; hours: number; strategy: boolean; lang?: Lang }): { items: PushRow[] } {
  const hours = Math.min(Math.max(Number.isFinite(opts.hours) ? opts.hours : 24, 1), 24 * 14);
  const items = pushRows(db, service_id, opts.now - hours * H, opts.strategy).reverse().slice(0, 300);
  return { items: opts.lang === 'en' ? items.map((x) => ({ ...x, error: x.error ? 'delivery failed' : null })) : items };
}

export function monitorTask(db: DatabaseSync, job_id: string, lang: Lang = 'zh'): Record<string, unknown> | null {
  const r = db.prepare('SELECT job_id,kind,state,test_flag,buyer_agent_id,service_id,accept_attempts,deliver_attempts,error,deliverable_text,raw_json,created_at,updated_at FROM okx_market_provider_task WHERE job_id=?').get(job_id) as Record<string, unknown> | undefined;
  if (!r) return null;
  let raw: Record<string, unknown> = {}; try { raw = object(JSON.parse(String(r['raw_json'] ?? '{}'))); } catch {}
  let summary: string | null = null;
  try { const x = db.prepare('SELECT summary FROM okx_market_service_result WHERE job_id=?').get(job_id) as { summary?: string } | undefined; summary = x?.summary ?? null; } catch {}
  return {
    job_id: r['job_id'], kind: r['kind'], state: r['state'], test_flag: !!Number(r['test_flag']), buyer: r['buyer_agent_id'], service_id: r['service_id'],
    accept_attempts: r['accept_attempts'], deliver_attempts: r['deliver_attempts'], created_at: r['created_at'], updated_at: r['updated_at'],
    title: raw['jobName'] ?? null, remote_status: raw['statusLabel'] ?? null, fee: raw['feeLabel'] ?? null, result_summary: summary,
    deliverable_text: r['deliverable_text'] ?? null, error: lang === 'zh' ? r['error'] ?? null : null,
  };
}

/** 失败的推送立刻可重发:把 6 小时内失败且没用完次数的投递的冷却清掉(broadcaster 下一次 tick 就会重发) */
export function expediteFailedPushes(db: DatabaseSync, now: number): number {
  return Number(db.prepare("UPDATE okx_market_service_push_job SET updated_at=? WHERE status='failed' AND updated_at BETWEEN ? AND ? AND attempts < 4")
    .run(now - 5 * M - 1000, now - 6 * H, now).changes);
}

/** 测试用:清掉上架状态缓存 */
export function resetMonitorCacheForTest(): void { listingCache = null; listingInflight = null; }
