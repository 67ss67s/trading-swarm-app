import { isBlockingAlert } from './risk.js';
/**
 * Portfolio Manager / Risk Sentinel 的路由(portfolio.ts / risk.ts / team-store.ts)。在 http-extra.ts 里一行注册。
 * 写操作只有两个:告警「已阅」(不构成授权)与组合政策(只能收紧;放宽要 confirm=LOOSEN,给界面上的人用)。
 */
import type { RouteContext, RouteModule } from './http-extra.js';
import { CLUSTER_MAP_VERSION, clusterFor, DEFAULT_PORTFOLIO_POLICY } from './portfolio.js';

export const teamRiskRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, fail, readBody, rt, store } = ctx;

  // ---- Strategy Lab(实验)+ Gate Captain(简报)
  route('GET', '/api/lab/experiments', guarded(async (_req, res, url) => {
    json(res, 200, { experiments: store.bots.runs({ role: 'strategy_lab', routine: 'experiment', limit: Number(url.searchParams.get('limit') ?? 10) || 10 }), decision: rt.team.labDecision(), running: rt.team.labIsRunning() });
  }));
  route('POST', '/api/lab/run', guarded(async (_req, res) => {
    if (rt.team.labIsRunning()) return fail(res, 409, '实验正在跑', 'already_running');
    void rt.team.runLab('manual').catch(() => {});
    json(res, 202, { started: true });
  }));
  route('GET', '/api/captain/brief', guarded(async (_req, res) => {
    json(res, 200, { brief: rt.team.latestBrief(), due: rt.team.briefDue(), briefs: store.bots.runs({ role: 'gate_captain', routine: 'daily_brief', limit: 7 }) });
  }));
  route('POST', '/api/captain/brief', guarded(async (_req, res) => {
    json(res, 200, { brief: rt.team.brief('manual') });
  }));

  // ---- Reviewer(复盘卡 + 批次)
  route('GET', '/api/reviewer/cards', guarded(async (_req, res, url) => {
    json(res, 200, { cards: rt.reviewer.cards(Number(url.searchParams.get('limit') ?? 50) || 50), decision: rt.reviewer.decision(), batches: store.bots.runs({ role: 'reviewer', routine: 'review_batch', limit: 10 }) });
  }));
  route('POST', '/api/reviewer/batch', guarded(async (_req, res) => {
    const r = await rt.reviewer.maybeBatch('manual');
    json(res, r.ran ? 200 : 409, r);
  }));

  route('GET', '/api/portfolio/snapshot', guarded(async (_req, res) => {
    const snapshot = rt.portfolioSnapshot ?? store.portfolio.latest();
    json(res, 200, { snapshot, capacity: rt.portfolioCapacity, policy: rt.portfolioPolicy(), default_policy: DEFAULT_PORTFOLIO_POLICY, cluster_map_version: CLUSTER_MAP_VERSION, watchlist_clusters: Object.fromEntries(rt.workflow.watchlist.map((s) => [s, clusterFor(s)])) });
  }));
  // Portfolio Manager 容量账本(§9.18):典型止损情景下还能容纳几条、每币要多少权益。只读估算,不是执行授权。
  route('GET', '/api/portfolio/capacity', guarded(async (_req, res) => {
    json(res, 200, { capacity: rt.portfolioCapacity, snapshot_id: rt.portfolioSnapshot?.snapshot_id ?? null });
  }));
  route('GET', '/api/portfolio/history', guarded(async (_req, res, url) => {
    json(res, 200, { snapshots: store.portfolio.history(Number(url.searchParams.get('limit') ?? 50) || 50) });
  }));
  route('GET', '/api/portfolio/snapshot/:id', guarded(async (_req, res, _url, p) => {
    const s = store.portfolio.get(p['id']!);
    if (!s) return fail(res, 404, `没有快照 ${p['id']}`, 'not_found');
    json(res, 200, { snapshot: s });
  }));
  /** 假设一笔候选成交后的组合影响(只读,给 UI 的「如果我下这单」)。 */
  route('POST', '/api/portfolio/impact', guarded(async (req, res) => {
    const b = await readBody(req);
    const symbol = String(b['symbol'] ?? '').toUpperCase();
    const side = b['side'] === 'short' ? 'short' : 'long';
    const qty = Number(b['qty']);
    const market = b['market'] ?? 'perp';
    if (market !== 'spot' && market !== 'perp') return fail(res, 400, 'invalid_market', 'bad_request');
    const price = Number(b['price'] ?? rt.markets.get(market === 'spot' ? `spot:${symbol}` : symbol)?.mark);
    const stop = b['stop'] === undefined || b['stop'] === null ? null : Number(b['stop']);
    if (!symbol || !(qty > 0) || !(price > 0)) return fail(res, 400, '需要 symbol、qty>0、price>0(或该币有行情)', 'bad_request');
    const impact = rt.portfolioImpact({ market, symbol, side, qty, price, stop });
    if (!impact) return fail(res, 409, '还没有账户快照', 'no_snapshot');
    json(res, 200, { impact });
  }));

  route('GET', '/api/risk/alerts', guarded(async (_req, res, url) => {
    const status = (url.searchParams.get('status') ?? 'open') as 'open' | 'resolved' | 'all';
    if (!['open', 'resolved', 'all'].includes(status)) return fail(res, 400, 'status 只能是 open/resolved/all', 'bad_status');
    json(res, 200, { alerts: store.risk.list({ status, limit: Number(url.searchParams.get('limit') ?? 100) || 100 }), level: rt.riskLevel(), blocks_new_risk: rt.riskOpen.some(isBlockingAlert) });
  }));
  route('POST', '/api/risk/alerts/:id/ack', guarded(async (_req, res, _url, p) => {
    const a = store.risk.ack(p['id']!, Date.now());
    if (!a) return fail(res, 404, `没有告警 ${p['id']}`, 'not_found');
    ctx.emit('risk.changed', { acked: a.id });
    json(res, 200, { alert: a });
  }));
  /** 人点「确认恢复」:只有 recovery_ready 的 high/critical 才能关。 */
  route('POST', '/api/risk/alerts/:id/resolve', guarded(async (_req, res, _url, p) => {
    const r = rt.confirmRiskRecovery(p['id']!);
    if (!r.ok) return fail(res, r.alert ? 409 : 404, r.error ?? '失败', r.alert ? 'not_ready' : 'not_found');
    json(res, 200, { alert: r.alert });
  }));
  /** 「全部确认恢复」:一次关掉所有 recovery_ready 的告警(条件还在的不动)。 */
  route('POST', '/api/risk/recover-all', guarded(async (_req, res) => {
    const rows = rt.confirmAllRiskRecovery();
    json(res, 200, { resolved: rows, level: rt.riskLevel() });
  }));
  /** 手动重评一轮(纯代码,免费)。 */
  route('POST', '/api/risk/evaluate', guarded(async (_req, res) => {
    if (!rt.account) return fail(res, 409, '还没有账户数据', 'no_account');
    rt.evaluateTeamRisk(rt.account);
    json(res, 200, { alerts: store.risk.open(), level: rt.riskLevel(), snapshot_id: rt.portfolioSnapshot?.snapshot_id ?? null });
  }));
  route('GET', '/api/risk/policy', guarded(async (_req, res) => {
    json(res, 200, { policy: rt.portfolioPolicy(), default_policy: DEFAULT_PORTFOLIO_POLICY });
  }));
  route('POST', '/api/risk/policy', guarded(async (req, res) => {
    const b = await readBody(req);
    const confirm = typeof b['confirm'] === 'string' ? b['confirm'] : undefined;
    const { confirm: _c, ...patch } = b;
    void _c;
    const r = rt.setPortfolioPolicy(patch as Record<string, number>, confirm);
    if (r.errors.length) return json(res, 409, { policy: r.policy, errors: r.errors });
    json(res, 200, { policy: r.policy, errors: [] });
  }));
};
