/**
 * 策略归因报告的 HTTP 路由(契约 docs/demo/v3-ui-contract.md §9.37;设计
 * docs/design/attribution-and-tiers-2026-09-12.md §1.3)。
 *
 * 两条**只读、零模型、零网络**的路由。归因不 propose、不改版本、不下单 —— 这条老约束继续有效。
 * 这里不建表也不缓存:输入全是已经落盘的线程 / 结算 / 候选表 / decision_record,
 * 建一张汇总表就等于多一个可能和源数据不一致的副本(设计 §1.5)。
 */
import type { RouteContext, RouteModule } from './http-extra.js';
import type { DemoStore } from './store.js';
import type { StrategyThread, Workflow } from './types.js';
import { TIER_OF } from './types.js';
import {
  attributionTradeOf,
  opportunityCountsFrom,
  summarizeAttribution,
  type AttributionReport,
  type AttributionTrade,
  type SymbolOrigin,
} from './attribution.js';
import { settlementComplete } from './strategy-loop.js';

/** 扫多少条已平线程 / episode 才够一份报告。两个上限都是「一次取数」的上限,不是统计窗口。 */
const THREAD_SCAN_LIMIT = 2000;
const EPISODE_SCAN_LIMIT = 800;
/** 往回看几次筛选的候选表(Radar 短线 12h 一次,30 次 ≈ 半个月)。 */
const SCREEN_SCAN_LIMIT = 30;

/**
 * 「这个币从哪来」的判定器。顺序写死(设计 §1.2 E):
 * 手工 → Radar 候选(开仓时刻落在候选有效期内)→ 白名单 → 观察名单 → 已不在任何名单。
 */
export function buildOriginResolver(store: DemoStore, workflow: Workflow): (t: StrategyThread) => SymbolOrigin {
  // (symbol|strategy_id) → 这条候选的有效区间们。同一个币可能在多次筛选里出现,全收。
  const windows = new Map<string, { from: number; to: number }[]>();
  for (const screen of store.screens.screens({ limit: SCREEN_SCAN_LIMIT })) {
    for (const c of store.screens.candidates(screen.id)) {
      for (const key of [`${c.symbol}|${c.strategy_id}`, `${c.symbol}|*`]) {
        const list = windows.get(key) ?? [];
        list.push({ from: c.created_at, to: c.ttl_at });
        windows.set(key, list);
      }
    }
  }
  const whitelist = new Set((workflow.screener_whitelist ?? []).map((s) => s.toUpperCase()));
  const watchlist = new Set((workflow.watchlist ?? []).map((s) => s.toUpperCase()));

  return (t: StrategyThread): SymbolOrigin => {
    if (t.source !== 'agent') return 'manual';
    const at = t.opened_at ?? t.created_at;
    const keys = [`${t.symbol}|${t.strategy_id ?? ''}`, `${t.symbol}|*`];
    for (const key of keys) {
      if ((windows.get(key) ?? []).some((w) => at >= w.from && at <= w.to)) return 'radar';
    }
    if (whitelist.has(t.symbol.toUpperCase())) return 'whitelist';
    if (watchlist.has(t.symbol.toUpperCase())) return 'watchlist';
    return 'unknown';
  };
}

interface ReportQuery {
  backend: string;
  since: number | null;
  strategy_id: string | null;
  version: number | null;
}

function queryOf(url: URL, defaultBackend: string): ReportQuery {
  const windowDays = Number(url.searchParams.get('window_days') ?? '');
  const sinceRaw = Number(url.searchParams.get('since') ?? '');
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0
    ? sinceRaw
    : Number.isFinite(windowDays) && windowDays > 0
      ? Date.now() - windowDays * 86_400_000
      : null;
  const v = Number(url.searchParams.get('version') ?? '');
  return {
    backend: url.searchParams.get('backend') ?? defaultBackend,
    since,
    strategy_id: url.searchParams.get('strategy_id'),
    version: Number.isInteger(v) && v > 0 ? v : null,
  };
}

/**
 * 一次取数 → 按 `(strategy_id, version, backend)` 分组的报告们。
 * 线程上没记策略版本的旧行按「该策略的当前 head 版本」归组,并在报告里保持可见
 * (它们的 `strategy_version` 是 head 的号,`price_only_n` / `insufficient` 会如实反映证据质量)。
 */
export function buildReports(store: DemoStore, workflow: Workflow, q: ReportQuery): AttributionReport[] {
  const originOf = buildOriginResolver(store, workflow);
  const episodes = store
    .episodes(EPISODE_SCAN_LIMIT)
    .map((e) => store.episode(e.id))
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const groups = new Map<string, { id: string; version: number; trades: AttributionTrade[] }>();
  for (const t of store.closedThreads(THREAD_SCAN_LIMIT, q.backend)) {
    if (!t.strategy_id) continue;
    if (q.strategy_id && t.strategy_id !== q.strategy_id) continue;
    if (q.since !== null && (t.closed_at ?? t.updated_at) < q.since) continue;
    // 结算不完整的一律不进任何统计(和 judgment-ledger 同一条铁律)。
    if (!settlementComplete(t)) continue;
    const version = t.strategy_version ?? store.strategies.head(t.strategy_id)?.version ?? 0;
    if (q.version !== null && version !== q.version) continue;
    const trade = attributionTradeOf(t, originOf);
    if (!trade) continue;
    const key = `${t.strategy_id}@${version}`;
    const g = groups.get(key) ?? { id: t.strategy_id, version, trades: [] };
    g.trades.push(trade);
    groups.set(key, g);
  }

  const out: AttributionReport[] = [];
  for (const g of groups.values()) {
    const spec = store.strategies.version(g.id, g.version) ?? store.strategies.head(g.id);
    const lab = (spec?.lab_stats ?? null) as (Record<string, unknown> & { timeframe?: string; oos_net_expectancy?: number }) | null;
    out.push(
      summarizeAttribution(g.trades, {
        strategy_id: g.id,
        strategy_name: spec?.name ?? null,
        strategy_version: g.version,
        backend: q.backend,
        tier: spec ? TIER_OF[spec.horizon] : null,
        horizon: spec?.horizon ?? null,
        replay_timeframe: typeof lab?.timeframe === 'string' ? lab.timeframe : null,
        replay_oos_net_expectancy: typeof lab?.oos_net_expectancy === 'number' ? lab.oos_net_expectancy : null,
        opportunities: opportunityCountsFrom(episodes, g.id),
      }),
    );
  }
  return out.sort((a, b) => b.n - a.n || a.strategy_id.localeCompare(b.strategy_id) || a.strategy_version - b.strategy_version);
}

export const attributionRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, fail, rt, store } = ctx;

  /** §9.37:全局汇总 —— 每个 `(id, version)` 一份报告 + 短/中/长三层的一行小计。 */
  route('GET', '/api/attribution/summary', guarded(async (_req, res, url) => {
    const q = queryOf(url, rt.workflow.execution);
    const reports = buildReports(store, rt.workflow, q);
    const byTier = (['short', 'mid', 'long'] as const).map((tier) => {
      const rs = reports.filter((r) => r.tier === tier);
      const n = rs.reduce((a, r) => a + r.n, 0);
      const sum = rs.reduce((a, r) => a + r.net_r_sum, 0);
      // 层小计的样本门槛与单条报告同一个:凑不够就不出期望,不靠「把几条策略加起来」凑样本量。
      const insufficient = n < (reports[0]?.min_sample ?? 10);
      return {
        tier,
        strategies: rs.length,
        n,
        net_r_sum: Math.round(sum * 10_000) / 10_000,
        expectancy_r: insufficient || n === 0 ? null : Math.round((sum / n) * 10_000) / 10_000,
        insufficient,
      };
    });
    json(res, 200, {
      backend: q.backend,
      since: q.since,
      generated_at: Date.now(),
      min_sample: reports[0]?.min_sample ?? 10,
      by_tier: byTier,
      strategies: reports,
    });
  }));

  /** §9.37:单条策略的归因。不带 `version` 时返回该策略所有版本的报告(新→旧按样本量)。 */
  route('GET', '/api/strategies/:id/attribution', guarded(async (_req, res, url, p) => {
    const id = p['id']!;
    if (!store.strategies.head(id)) return fail(res, 404, `没有这条策略:${id}`, 'not_found');
    const q = { ...queryOf(url, rt.workflow.execution), strategy_id: id };
    const reports = buildReports(store, rt.workflow, q);
    json(res, 200, {
      strategy_id: id,
      backend: q.backend,
      since: q.since,
      generated_at: Date.now(),
      versions: reports,
      /** 请求里点名了版本、或者只有一个版本时,前端直接用这个。 */
      report: reports.find((r) => q.version === null || r.strategy_version === q.version) ?? null,
    });
  }));
};
