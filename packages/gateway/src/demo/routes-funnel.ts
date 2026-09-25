/**
 * 零 PROPOSE 漏斗的只读路由(funnel.ts)。在 http-extra.ts 里一行注册。
 *
 * `GET /api/funnel?symbols=BTCUSDT,ETHUSDT&days=60&tf=15m` —— 完全确定性,零模型调用,
 * K 线走 backtest.ts 的磁盘缓存。第一次跑要拉几十个 REST 分页,所以结果按
 * (symbols, days, tf) 缓存 10 分钟,并发的相同请求共用同一个 promise。
 */
import type { RouteContext, RouteModule } from './http-extra.js';
import { aggregateLadder, DEFAULT_FUNNEL_SYMBOLS, runFunnel, type FunnelReport } from './funnel.js';

const TTL_MS = 10 * 60_000;

interface Entry {
  at: number;
  promise: Promise<FunnelReport>;
}

const cache = new Map<string, Entry>();

/** 测试用:清掉缓存。 */
export function clearFunnelCache(): void {
  cache.clear();
}

export const funnelRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, fail } = ctx;

  route('GET', '/api/funnel', guarded(async (_req, res, url) => {
    const raw = (url.searchParams.get('symbols') ?? '').trim();
    const symbols = raw ? raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : DEFAULT_FUNNEL_SYMBOLS;
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 60) || 60));
    const tf = url.searchParams.get('tf') ?? '15m';
    if (symbols.length > 40) return fail(res, 400, 'symbols 最多 40 个', 'too_many_symbols');

    const key = `${tf}|${days}|${symbols.join(',')}`;
    const hit = cache.get(key);
    const fresh = hit && Date.now() - hit.at < TTL_MS ? hit : null;
    const entry: Entry = fresh ?? { at: Date.now(), promise: runFunnel(symbols, { days, timeframe: tf, pause_ms: 120 }) };
    if (!fresh) cache.set(key, entry);
    let report: FunnelReport;
    try {
      report = await entry.promise;
    } catch (e) {
      cache.delete(key);
      return fail(res, 502, `漏斗计算失败:${(e as Error).message.slice(0, 200)}`, 'funnel_failed');
    }
    json(res, 200, { report, aggregate: aggregateLadder(report), cached: !!fresh, cache_age_ms: Date.now() - entry.at });
  }));
};
