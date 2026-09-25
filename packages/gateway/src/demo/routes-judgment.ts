/**
 * 判断账本的 HTTP 路由(契约 docs/demo/v3-ui-contract.md §9.29;设计 §3)。
 * 两条只读路由,零模型:一条分页行,一条按策略分层的汇总。这里没有任何一条能改账本。
 */
import type { RouteContext, RouteModule } from './http-extra.js';
import { encodeLedgerCursor, summarizeLedger, type LedgerQuery } from './judgment-ledger.js';

/** `?source=`:online(默认)/ replay / trader / backfill / all;认不出的值按默认处理。 */
function sourceOf(url: URL): LedgerQuery['source'] {
  const raw = url.searchParams.get('source');
  return raw === 'replay' || raw === 'trader' || raw === 'backfill' || raw === 'all' || raw === 'online' ? raw : undefined;
}

function sinceOf(url: URL): number | null {
  const raw = url.searchParams.get('since');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const judgmentLedgerRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, fail, store } = ctx;

  /**
   * §9.34 减黑盒:一次判断的**证据来源明细**。id = episode_id。
   * 这里不重算任何东西,只把当时落盘的计划 + 证据 + 账本行拼给前端;
   * 旧 episode 没有 `evidence_plan`(那一版还没做)→ 两个字段都是 null,前端显示「这次判断没有计划快照」。
   * §9.37 起同时返回 `decision_record`(三栏:代码允许 → 模型选 → 闸后执行,理由全是枚举)。
   */
  route('GET', '/api/judgments/:id', guarded(async (_req, res, _url, p) => {
    const id = p['id']!;
    const ep = store.episode(id);
    if (!ep) return fail(res, 404, `没有这次判断:${id}`, 'not_found');
    json(res, 200, {
      episode_id: ep.id,
      at: ep.at,
      symbol: ep.symbol,
      mode: ep.thread_id ? 'review' : 'scan',
      prompt_version: ep.prompt_version,
      context_hash: ep.context_hash,
      evidence_plan_hash: ep.evidence_plan_hash ?? null,
      evidence_plan: ep.evidence_plan ?? null,
      /**
       * §9.37 减黑盒:结构化决策记录(代码允许 → 模型选 → 闸后执行)。
       * 早于这一版的 episode 没有 → null,前端显示「这次判断早于决策记录」。
       */
      decision_record: ep.decision_record ?? null,
      evidence: ep.evidence,
      strategy_refs: ep.strategy_refs ?? [],
      cited_refs: ep.judgment?.evidence_refs ?? [],
      ledger: store.judgments.get(ep.id),
    });
  }));

  route('GET', '/api/judgment-ledger', guarded(async (_req, res, url) => {
    const since = sinceOf(url);
    const strategy_id = url.searchParams.get('strategy_id');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '100') || 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0);
    const cursor = url.searchParams.get('cursor');
    const source = sourceOf(url);
    const rows = store.judgments.list({ since, strategy_id, limit, offset, cursor, source });
    const last = rows[rows.length - 1] ?? null;
    const next_cursor = last ? encodeLedgerCursor(last) : null;
    json(res, 200, { rows, total: store.judgments.count({ since, strategy_id, source }), limit, offset, since, strategy_id, next_cursor });
  }));

  route('GET', '/api/judgment-ledger/summary', guarded(async (_req, res, url) => {
    const since = sinceOf(url);
    // 汇总要看全窗口,不受分页影响;500 行是一次取数上限,超过就按 since 收窄窗口。
    json(res, 200, summarizeLedger(store.judgments.list({ since, limit: 500, source: sourceOf(url) }), { since }));
  }));
};
