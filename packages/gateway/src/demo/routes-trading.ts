/**
 * 交易页三层(契约 §9.56):执行层参数读写 + 来源漏斗。
 * 权限和 POST /api/workflow 一样:写操作只接受自家页面发来的请求,别的浏览器来源返回 403。
 * 两个 GET 不在 privateApi 里、只含非敏感字段,公网演示访客可读。
 */
import type { RouteContext } from './http-extra.js';
import { parseSince } from './trading-sources.js';

export function tradingRoutes(ctx: RouteContext): void {
  const { route, guarded, json, fail, readBody, rt } = ctx;
  // stop_conversions 从行情缓存算,缺的最多等 0.8 秒,等不到记 null 并标 stale,不拖慢这个接口
  route('GET', '/api/execution-policy', guarded(async (_req, res) => json(res, 200, { ...rt.executionPolicyView(), ...(await rt.stopConversions()) })));
  route('PATCH', '/api/execution-policy', guarded(async (req, res) => {
    const body = await readBody(req);
    try {
      const r = rt.setExecutionPolicy(body, { via: 'human' });
      json(res, 200, { policy: rt.executionPolicyView(), errors: 'errors' in r ? r.errors : [] });
    } catch (e) {
      const err = e as Error & { status?: number; code?: string; errors?: unknown };
      if (err.code === 'invalid_policy') return json(res, 400, { error: { code: 'invalid_policy', message: err.message }, errors: err.errors });
      throw e;
    }
  }));
  // 只暂停/恢复 AI 扫盘;策略运行各自在 PATCH /api/strategy-runs/:id 暂停
  route('PATCH', '/api/trading/sources/ai_scan', guarded(async (req, res) => {
    const body = await readBody(req);
    if (Object.keys(body).some((k) => k !== 'paused') || typeof body['paused'] !== 'boolean') return fail(res, 400, '请求体只能是 {"paused": true|false}', 'bad_request');
    rt.setAiScanPaused(body['paused']);
    const view = rt.tradingSources(parseSince(null, Date.now())!);
    json(res, 200, { source: view.sources.find((x) => x.kind === 'ai_scan') });
  }));
  route('GET', '/api/trading/sources', guarded(async (_req, res, url) => {
    const since = parseSince(url.searchParams.get('since'), Date.now());
    if (since === null) return fail(res, 400, 'since 必须是不晚于现在、且在 31 天内的毫秒时间戳', 'bad_request');
    json(res, 200, rt.tradingSources(since));
  }));
}
