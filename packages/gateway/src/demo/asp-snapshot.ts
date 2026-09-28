// 信号市场(OKX.AI / ASP)只读快照模式:TG_PUBLIC_ASP_SNAPSHOT=<快照 JSON 路径> 时,
//   - 信号市场与 ASP 服务相关的 GET 全部从快照返回(形状与真实接口一致,另带 `snapshot: { as_of, source }`);
//   - 相关写接口一律 403 judge_locked(英文 message),owner 也一样 —— 这台机器上没有钱包和 okx-a2a;
//   - onchainos / okx-a2a 子进程一律不再启动(asp-agent/cli.ts、execution-okx.ts 的默认 spawn 在这里查开关)。
// 快照由本机的 scripts/export-asp-snapshot.mjs 从 18811 只读导出、已脱敏,scripts/push-asp-snapshot.sh 推到服务器;
// 文件按 mtime 热加载,不用重启。
import { readFileSync, statSync } from 'node:fs';
import type http from 'node:http';
import { englishDeep, publicEnglish } from './public-en.js';

export interface AspSnapshotFile {
  version: 1;
  as_of: number;
  source: string;
  /** key = 规范化的「路径?排序后的查询」(见 snapshotKey),value = 真实接口的响应体。 */
  endpoints: Record<string, unknown>;
}

/** 快照覆盖的读接口(与 webui 信号市场页的实际调用对齐)。行情类(/api/market/klines 等)不在内。 */
const SNAPSHOT_READS: readonly RegExp[] = [
  /^\/api\/market\/(?:status|search|catalog|asp|subscriptions|inbox|settings|identity|devices)(?:\/|$)/,
  /^\/api\/asp-services(?:\/|$)/,
  /^\/api\/okx\/account$/,
];

/** 快照模式下锁住的写接口:信号市场、ASP 服务、钱包登录。 */
const SNAPSHOT_WRITES: readonly RegExp[] = [
  /^\/api\/market\/(?!klines|regime|basis|indicators)[^/]+(?:\/|$)/,
  /^\/api\/asp-services(?:\/|$)/,
  /^\/api\/wallet(?:\/|$)/,
  /^\/api\/follow\/okx-asp(?:\/|$)/,
];

/** 只影响「刷新」而不影响内容的查询参数,查快照时忽略。 */
const IGNORED_PARAMS = new Set(['fresh', 'refresh', 'force', '_']);

export const aspSnapshotPath = (): string | null => process.env['TG_PUBLIC_ASP_SNAPSHOT'] || null;
export const aspSnapshotEnabled = (): boolean => aspSnapshotPath() !== null;

export function snapshotKey(pathname: string, params: URLSearchParams): string {
  const kept = [...params.entries()].filter(([k]) => !IGNORED_PARAMS.has(k)).sort(([a], [b]) => a.localeCompare(b));
  return kept.length ? `${pathname}?${new URLSearchParams(kept).toString()}` : pathname;
}

let cache: { path: string; mtimeMs: number; size: number; data: AspSnapshotFile } | null = null;

/** 按 mtime/size 热加载;文件坏了保留上一份能用的。 */
export function loadAspSnapshot(): AspSnapshotFile | null {
  const file = aspSnapshotPath();
  if (!file) return null;
  let st;
  try {
    st = statSync(file);
  } catch {
    return cache?.path === file ? cache.data : null;
  }
  if (cache && cache.path === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.data;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as AspSnapshotFile;
    if (!data || typeof data.endpoints !== 'object' || typeof data.as_of !== 'number') throw new Error('bad snapshot');
    cache = { path: file, mtimeMs: st.mtimeMs, size: st.size, data };
    return data;
  } catch {
    return cache?.path === file ? cache.data : null;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  // 快照不走 http.ts 的 json()/publicBody,英文评审版(TG_PUBLIC_DEMO=1 + TG_PUBLIC_LANG=en)在这里补上出口英文层
  res.end(JSON.stringify(publicEnglish() ? englishDeep(body) : body));
}

function lookup(snap: AspSnapshotFile, url: URL): unknown {
  const exact = snap.endpoints[snapshotKey(url.pathname, url.searchParams)];
  if (exact !== undefined) return exact;
  const bare = snap.endpoints[url.pathname];
  if (bare === undefined) return undefined;
  // 收件箱按订阅过滤:快照没存这个 job_id 的分页时,从全量里筛。
  const job = url.searchParams.get('job_id');
  if (url.pathname === '/api/market/inbox' && job && bare && typeof bare === 'object' && Array.isArray((bare as { deliveries?: unknown }).deliveries)) {
    const all = (bare as { deliveries: { job_id?: unknown }[] }).deliveries;
    return { ...(bare as object), deliveries: all.filter((d) => d.job_id === job) };
  }
  return bare;
}

/**
 * 快照是定格的:把「还在加载/刷新」的状态收成已完成,缓存时间取快照时间(前端骨架屏靠 cache.fetched_at 判断有没有数据),
 * 根上带 snapshot: { as_of, source }。
 */
function settle(body: Record<string, unknown>, asOf: number, meta: { as_of: number; source: string }): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, snapshot: meta };
  const cache = body['cache'];
  if (cache && typeof cache === 'object' && !Array.isArray(cache)) {
    const c = cache as Record<string, unknown>;
    out['cache'] = { ...c, fetched_at: typeof c['fetched_at'] === 'number' ? c['fetched_at'] : asOf, refreshing: false, stale: false, ...(c['state'] === 'loading' ? { state: 'ready' } : {}) };
  }
  if ('building' in body) out['building'] = false;
  return out;
}

/** http.ts 在公网闸门之后调:返回 true 表示已经回了响应。快照已脱敏,不再走公开投影(保留链上公开的钱包地址)。 */
export function serveAspSnapshot(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (!aspSnapshotEnabled()) return false;
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    if (!SNAPSHOT_READS.some((p) => p.test(url.pathname))) return false;
    const snap = loadAspSnapshot();
    if (!snap) {
      send(res, 503, { error: { code: 'snapshot_unavailable', message: 'The OKX.AI snapshot is not available on this server yet.' } });
      return true;
    }
    const body = lookup(snap, url);
    const meta = { as_of: snap.as_of, source: snap.source };
    if (body === undefined) {
      send(res, 404, { error: { code: 'snapshot_missing', message: 'This OKX.AI view is not included in the read-only snapshot.' }, snapshot: meta });
      return true;
    }
    send(res, 200, body && typeof body === 'object' && !Array.isArray(body) ? settle(body as Record<string, unknown>, snap.as_of, meta) : body);
    return true;
  }
  if (method === 'OPTIONS' || !SNAPSHOT_WRITES.some((p) => p.test(url.pathname))) return false;
  send(res, 403, {
    error: { code: 'judge_locked', message: 'Locked in the review demo: OKX.AI (signal market) is a read-only snapshot of the owner\'s agent; subscribing, publishing and wallet actions are disabled on this server.' },
    locked: true,
  });
  return true;
}

/** 快照模式下 onchainos / okx-a2a 不许启动(调用方把它当成「CLI 不可用」处理)。 */
export function aspCliBlocked(bin: string): boolean {
  return aspSnapshotEnabled() && /(?:^|\/)(?:onchainos|okx-a2a)$/.test(bin);
}
