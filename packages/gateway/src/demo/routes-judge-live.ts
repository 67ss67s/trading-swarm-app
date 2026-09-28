/**
 * 实盘 Jev 判断流(docs/design/jev-live-2026-09-25.md)。
 *
 *   GET /api/judge/live?limit=&run_id=   → { items: JudgeLiveItem[], summary: JudgeLiveSummary }
 *   GET /api/judge/live/summary?run_id=  → JudgeLiveSummary
 *   GET /api/judge/live/stream           → SSE,每条新判断一帧 `event: judge.live`(data = JudgeLiveRecord)
 *
 * judge.live 不在 http.ts 的 EVENTS 白名单里(那个文件归别的会话),所以这里自带一条轻量 SSE;
 * 以后白名单加上 'judge.live',/api/events 也会同样转发,两边数据一致。
 */
import type http from 'node:http';
import type { RouteModule } from './http-extra.js';
import { sseHeartbeatMs } from './ops-config.js';
import { judgeLiveSummary, linkOutcome, type JudgeLiveItem, type JudgeLiveRecord } from './judge-live.js';
import type { StrategyThread } from './types.js';

const RUN_ID = /^run_[a-z0-9]{1,64}$/;

export const judgeLiveRoutes: RouteModule = ctx => {
  const runner = () => ctx.rt.strategyRuns();
  const bad = (res: http.ServerResponse, message: string) => ctx.fail(res, 400, message, 'invalid_request');
  const runParam = (url: URL): string | null | undefined => {
    const v = url.searchParams.get('run_id');
    if (v === null || v === '') return null;
    return RUN_ID.test(v) ? v : undefined;
  };
  /** 候选之后的真实线程结果;每次请求按运行缓存线程列表 */
  const outcomes = () => {
    const cache = new Map<string, StrategyThread[]>(), r = runner();
    return (rec: JudgeLiveRecord) => {
      try {
        let ts = cache.get(rec.run_id);
        if (!ts) { ts = r.deps.threads(rec.run_id); cache.set(rec.run_id, ts); }
        return linkOutcome(rec, ts, r.deps.realizedR);
      } catch { return null; }
    };
  };
  const summary = (run_id: string | null, outcome: ReturnType<typeof outcomes>) => judgeLiveSummary(ctx.store.marketDb, runner().judgeLedger, { now: Date.now(), run_id, outcome });

  ctx.route('GET', '/api/judge/live', ctx.guarded(async (_req, res, url) => {
    const run_id = runParam(url);
    if (run_id === undefined) return bad(res, 'run_id 格式不对');
    const raw = url.searchParams.get('limit');
    if (raw !== null && !/^\d{1,4}$/.test(raw)) return bad(res, 'limit 必须是 1–500 的整数');
    const limit = Math.min(500, Math.max(1, raw === null ? 50 : Number(raw)));
    const outcome = outcomes();
    const items: JudgeLiveItem[] = runner().judgeLedger.list({ limit, run_id }).map(r => ({ ...r, outcome: outcome(r) }));
    ctx.json(res, 200, { items, summary: summary(run_id, outcome) });
  }));

  ctx.route('GET', '/api/judge/live/summary', ctx.guarded(async (_req, res, url) => {
    const run_id = runParam(url);
    if (run_id === undefined) return bad(res, 'run_id 格式不对');
    ctx.json(res, 200, summary(run_id, outcomes()));
  }));

  ctx.route('GET', '/api/judge/live/stream', async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': judge.live\n\n');
    const send = (row: unknown) => { try { res.write(`event: judge.live\ndata: ${JSON.stringify(row)}\n\n`); } catch { /* 连接已断 */ } };
    ctx.rt.on('judge.live', send);
    // 心跳写不进去(写缓冲满)就断开,和 /api/events 一样;间隔见 sseHeartbeatMs(反代下断开的连接靠下一次写失败才释放名额)
    const ping = setInterval(() => { try { if (!res.write(': ping\n\n')) res.destroy(); } catch { res.destroy(); } }, sseHeartbeatMs());
    ping.unref();
    const close = () => { clearInterval(ping); ctx.rt.off('judge.live', send); };
    req.on('close', close); res.on('close', close);
  });
};
