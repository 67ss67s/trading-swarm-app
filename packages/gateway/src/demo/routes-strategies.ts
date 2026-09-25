import { registerManifest, runExperiment } from './strategy-lab.js';
import { probeVerified } from './replay-stats.js';
import { HORIZON_POLICY, type StrategyHorizon } from './horizon.js';
/**
 * 策略库 + 回测归因的 HTTP 路由(docs/demo/v3-ui-contract.md §9.11;
 * docs/design/strategy-library-2026-09-05.md)。在 http-extra.ts 里一行注册。
 *
 * 红线:这里没有任何一条路由能直接改一个在跑的策略的数字。改参数 = 生成一个 draft 新版本;
 * 上线 = 一格一格晋升,而且 paper → live_capped 必须带人工确认。归因只 propose。
 */
import { runAttribution, type AttributionPoint } from './attribution.js';
import type { RouteContext, RouteModule } from './http-extra.js';
import { resolveRunStrategies } from './backtest.js';
import { strategyForBackend, evidenceOf, FAMILY_LABEL, shadowToPaperGate, STATUS_LABEL, STATUS_ORDER, validateEvidenceSpec, wakeKindsOf, type StrategySpec, type StrategyStatus } from './strategies.js';
import { degradeDecision, realizedRFromThreads } from './strategy-loop.js';
import { ALLOCATOR_KV, ALLOCATOR_VERSION, readNumberKv, readPrevious, rollbackAllocator } from './strategy-allocator.js';
import { WORKFLOW_BOUNDS } from './workflow.js';

function isStatus(v: unknown): v is StrategyStatus {
  return typeof v === 'string' && (STATUS_ORDER as string[]).concat('retired').includes(v);
}

/** The next status a strategy could be promoted to, or null at the top / retired. */
export function nextStatus(s: StrategySpec): StrategyStatus | null {
  const i = STATUS_ORDER.indexOf(s.status);
  return i >= 0 && i + 1 < STATUS_ORDER.length ? STATUS_ORDER[i + 1]! : null;
}

export const strategyRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, fail, readBody, rt, store } = ctx;
  const lib = store.strategies;

  const view = (s: StrategySpec): StrategySpec & { family_label: string; status_label: string; next_status: StrategyStatus | null; promote_blocked: string | null; active: boolean; activatable: boolean; effective_evidence: ReturnType<typeof evidenceOf>; wake_kinds: ReturnType<typeof wakeKindsOf>; shadow_blocked: string | null } => {
    s = strategyForBackend(s, rt.backend.kind);
    const next = nextStatus(s);
    return {
      ...s,
      family_label: FAMILY_LABEL[s.family] ?? s.family,
      status_label: STATUS_LABEL[s.status] ?? s.status,
      next_status: next,
      promote_blocked: next ? lib.promoteGate(s, next, { confirm: false }) : '已经在最高状态',
      active: (rt.workflow.active_strategies ?? []).includes(s.id),
      // §9.28:能不能启用 = 这条策略有没有一个 ≥ paper 的版本(与 setWorkflow 同一口径)。
      activatable: lib.resolve([s.id], { backend: rt.backend.kind }).specs.length > 0,
      // §9.27:自定义证据的**生效**值(没写 evidence 的旧策略这里显示默认集)与实际会唤醒它的触发种类。
      effective_evidence: evidenceOf(s),
      wake_kinds: wakeKindsOf(s),
      shadow_blocked: s.status === 'shadow' ? shadowToPaperGate(s) : null,
    };
  };

  const changed = (s: StrategySpec | null): void => {
    if (s) ctx.emit('strategy.changed', { id: s.id, version: s.version, status: s.status });
  };

  // P1：独立 Lab v3 接点，旧版本与在途策略指针保持版本绑定。
  route('POST', '/api/strategies/lab/run', guarded(async (req, res) => {
    const body = await readBody(req);
    const days = Number(body['days'] ?? 90);
    if (!Number.isInteger(days) || days < 81 || days > 730) return fail(res, 400, 'days 必须为 81..730 的整数', 'invalid');
    const specs = lib.list().filter(s => s.status !== 'retired');
    const now = Date.now();
    const manifest = registerManifest({ strategies: specs, symbols: rt.workflow.screener_whitelist ?? rt.workflow.watchlist, timeframe: '15m', days, now });
    const result = await runExperiment(manifest, { specs, probe: new Set(specs.map(s => `${s.id}@${s.version}`)) });
    const runId = `lab-v3-${manifest.manifest_hash}`;
    for (const row of result.by_strategy) {
      lib.updateLabStats(row.strategy_id, row.version, { ...row.replay, ...(row.coverage ? { coverage: row.coverage } : {}), run_id: runId, at: now, symbols: row.symbols, setups: row.setups, n: row.n, win_rate: row.win_rate, expectancy_r: row.expectancy_r, total_r: row.total_r, note: result.note });
      const current = lib.version(row.strategy_id, row.version);
      if (current && nextStatus(current)) lib.promoteGate(current, nextStatus(current)!);
    }
    const proposals: { strategy_id: string; version: number }[] = [];
    for (const probe of result.probes ?? []) {
      if (!probeVerified(probe.replay) || proposals.some(p => p.strategy_id === probe.strategy_id)) continue;
      const head = lib.head(probe.strategy_id);
      if (!head || head.version !== probe.version) continue;
      const created = lib.createVersion(head.id, { params: { [probe.param]: probe.value } }, { now });
      if (!created.spec) continue;
      proposals.push({ strategy_id: head.id, version: created.spec.version });
      store.strategyEvents.append({ strategy_id: head.id, version: created.spec.version, at: now, who: 'lab', kind: 'version_created', from_status: null, to_status: 'draft', reason: '训练窗选参数，测试窗净收益通过 CI 与 DSR', evidence: { oos_n: probe.replay!.oos_n, dsr: probe.replay!.dsr, oos_ci_lower: probe.replay!.oos_ci.lower } });
    }
    json(res, 200, { manifest, result, proposals });
  }));

  // ---- 列表 / 详情

  route('GET', '/api/strategies', guarded(async (_req, res, url) => {
    const includeRetired = url.searchParams.get('include_retired') === '1';
    const strategies = lib.list({ include_retired: includeRetired }).map(view);
    json(res, 200, { strategies, active: rt.workflow.active_strategies ?? [], statuses: STATUS_ORDER, status_labels: STATUS_LABEL, family_labels: FAMILY_LABEL });
  }));

  // 注意:allocator 这几条必须**排在 `/api/strategies/:id` 之前** —— 路由是先注册先匹配,
  // 放在后面的话 `allocator` 会被当成一个策略 id,直接 404「没有策略 allocator」。
  // ---- §9.35 策略自动轮换 allocator(只动 active_strategies 这一个数组;evidence / lab 端点不在这儿)

  const allocatorView = (): Record<string, unknown> => {
    const mode = rt.workflow.active_mode ?? 'manual';
    // **预览**:算出「现在跑一遍会怎么动」,不落库、不写台账(前端顶部那一块读它)。
    const r = rt.applyAllocator({ preview: true });
    return {
      mode,
      max: WORKFLOW_BOUNDS.active_strategies_max,
      active: rt.workflow.active_strategies ?? [],
      regime: r.decision.regime,
      decision: r.decision,
      candidates: r.candidates,
      last_run_at: readNumberKv(store, ALLOCATOR_KV.lastRunAt),
      last_change_at: readNumberKv(store, ALLOCATOR_KV.lastChangeAt),
      last_reason: store.kvGet(ALLOCATOR_KV.lastReason),
      previous: readPrevious(store),
      events: store.strategyEvents.recent(60).filter((e) => e.kind === 'activated' || e.kind === 'deactivated').slice(0, 20),
    };
  };

  route('GET', '/api/strategies/allocator', guarded(async (_req, res) => {
    json(res, 200, allocatorView());
  }));

  route('POST', '/api/strategies/allocator/mode', guarded(async (req, res) => {
    const body = await readBody(req);
    const mode = body['mode'];
    if (mode !== 'manual' && mode !== 'auto') return fail(res, 400, 'mode 只能是 manual / auto', 'invalid');
    const r = await rt.applyWorkflow({ active_mode: mode });
    if (r.errors.length) return json(res, 400, { error: { code: 'invalid', message: r.errors.join(';') }, errors: r.errors });
    ctx.emit('strategy.changed', { active_mode: mode });
    json(res, 200, { mode, workflow: r.workflow });
  }));

  /** 现在跑一遍。manual 下只有 `force=true` 才落库(否则只回预览,`applied=false`)。 */
  route('POST', '/api/strategies/allocator/run', guarded(async (req, res) => {
    const body = await readBody(req);
    const r = rt.applyAllocator({ force: body['force'] === true });
    json(res, 200, { decision: r.decision, candidates: r.candidates, active: r.active, applied: r.applied, skipped_reason: r.skipped_reason, previous: readPrevious(store) });
  }));

  /** 回滚到上一票池。**不受**最短驻留 / 冷却约束:这是人的撤销键,不是一次新决策。 */
  route('POST', '/api/strategies/allocator/rollback', guarded(async (_req, res) => {
    const current = rt.workflow.active_strategies ?? [];
    const r = rollbackAllocator(store, current);
    if (!r) return fail(res, 409, '没有可回滚的票池', 'conflict');
    const applied = await rt.applyWorkflow({ active_strategies: r.active });
    if (applied.errors.length) return json(res, 409, { error: { code: 'conflict', message: applied.errors.join(';') }, errors: applied.errors, active: applied.workflow.active_strategies });
    rt.announceAllocator({ version: ALLOCATOR_VERSION, at: Date.now(), mode: rt.workflow.active_mode ?? 'manual', regime: rt.allocatorRegime(), changed: true, from: [...current], to: r.active, add: r.active.filter((x) => !current.includes(x)).map((id) => ({ id, reason: '回滚到上一票池' })), remove: current.filter((x) => !r.active.includes(x)).map((id) => ({ id, reason: '回滚到上一票池' })), keep: r.active.filter((x) => current.includes(x)).map((id) => ({ id, reason: '回滚后仍在池' })), reason: `回滚到上一票池(${r.active.join('/') || '空'})` });
    ctx.emit('strategy.changed', { source: 'allocator_rollback', active: applied.workflow.active_strategies });
    json(res, 200, { active: applied.workflow.active_strategies, previous: r.previous, restored: true });
  }));

  route('GET', '/api/strategies/:id', guarded(async (_req, res, _url, p) => {
    const id = p['id']!;
    const head = lib.head(id);
    if (!head) return fail(res, 404, `没有策略 ${id}`, 'not_found');
    json(res, 200, {
      strategy: view(head),
      versions: lib.versions(id),
      attributions: store.attributionsForStrategy(id, 50),
      timeline: store.strategyEvents.timeline(id, 200),
      shadow_threads: store.shadowThreads.forVersion(id, head.version, 50),
      degrade: degradeDecision(realizedRFromThreads(store, id, lib.resolve([id], { backend: rt.backend.kind }).specs[0]?.version, rt.backend.kind)),
      probe_queue: store.labProbes.list(50).filter((q) => q.strategy_id === id),
    });
  }));

  // §9.27 台账:一条策略的完整生命周期(旧的在前),前端画晋升时间线。
  route('GET', '/api/strategies/:id/timeline', guarded(async (_req, res, _url, p) => {
    const id = p['id']!;
    if (!lib.head(id)) return fail(res, 404, `没有策略 ${id}`, 'not_found');
    json(res, 200, { strategy_id: id, events: store.strategyEvents.timeline(id, 500) });
  }));

  // §9.28 一键启用 / 停用(在现有 active 集合上增删一个 id,不用前端自己拼全集)。
  const setActive = async (res: Parameters<typeof json>[0], id: string, on: boolean): Promise<void> => {
    const head = lib.head(id);
    if (!head) return fail(res, 404, `没有策略 ${id}`, 'not_found');
    const current = rt.workflow.active_strategies ?? [];
    const nextIds = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    const r = await rt.applyWorkflow({ active_strategies: nextIds });
    if (r.errors.length) return json(res, 409, { error: { code: 'conflict', message: r.errors.join(';') }, errors: r.errors, active: r.workflow.active_strategies });
    store.strategyEvents.append({ strategy_id: id, version: head.version, at: Date.now(), who: 'human', kind: on ? 'activated' : 'deactivated', from_status: head.status, to_status: head.status, reason: on ? '人工启用' : '人工停用', evidence: {} });
    ctx.emit('strategy.changed', { id, active: r.workflow.active_strategies });
    json(res, 200, { active: r.workflow.active_strategies, workflow: r.workflow, strategy: view(lib.head(id) ?? head) });
  };

  route('POST', '/api/strategies/:id/activate', guarded(async (_req, res, _url, p) => setActive(res, p['id']!, true)));
  route('POST', '/api/strategies/:id/deactivate', guarded(async (_req, res, _url, p) => setActive(res, p['id']!, false)));

  // ---- 启用 / 停用(写 workflow.active_strategies;只有 ≥ paper 的能进实盘)

  route('POST', '/api/strategies/active', guarded(async (req, res) => {
    const body = await readBody(req);
    const raw = body['ids'];
    if (!Array.isArray(raw)) return fail(res, 400, 'ids 必须是数组', 'invalid');
    const ids = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
    const { specs, errors } = lib.resolve(ids, { allow_below_paper: false });
    if (errors.length) return json(res, 400, { error: { code: 'invalid', message: errors.join(';') }, errors });
    const r = await rt.applyWorkflow({ active_strategies: specs.map((s) => s.id) });
    if (r.errors.length) return json(res, 400, { error: { code: 'invalid', message: r.errors.join(';') }, errors: r.errors });
    ctx.emit('strategy.changed', { active: r.workflow.active_strategies });
    json(res, 200, { active: r.workflow.active_strategies, workflow: r.workflow });
  }));

  // ---- 生成新版本 / 晋升 / 退役

  route('POST', '/api/strategies/:id/propose-version', guarded(async (req, res, _url, p) => {
    const id = p['id']!;
    const body = await readBody(req);
    let params = (body['params'] ?? undefined) as Record<string, number> | undefined;
    let rules = (body['rules'] ?? undefined) as Partial<StrategySpec['rules']> | undefined;
    // 「采纳这条归因」= 用它的提议当 patch(参数提议直接落值;措辞/清单提议追加成一条规则)。
    const attrId = typeof body['attribution_id'] === 'string' ? body['attribution_id'] : null;
    let attribution: AttributionPoint | null = null;
    if (attrId) {
      attribution = store.attribution(attrId);
      if (!attribution) return fail(res, 404, `没有这条归因:${attrId}`, 'not_found');
      const head = lib.head(id);
      if (!head) return fail(res, 404, `没有策略 ${id}`, 'not_found');
      if (attribution.proposal.kind === 'param' && attribution.proposal.param && attribution.proposal.value !== null && attribution.proposal.value !== undefined) {
        params = { ...(params ?? {}), [attribution.proposal.param]: attribution.proposal.value };
      } else if (attribution.proposal.text) {
        const line = `${attribution.proposal.text}(来自回测归因 ${attribution.run_id})`;
        rules = attribution.proposal.kind === 'checklist_item' ? { ...(rules ?? {}), entry: [...head.rules.entry, line] } : { ...(rules ?? {}), invalidation: [...head.rules.invalidation, line] };
      }
    }
    if (body['horizon'] !== undefined && (typeof body['horizon'] !== 'string' || !Object.hasOwn(HORIZON_POLICY, body['horizon']))) return fail(res, 400, '无效 horizon', 'invalid');
    // §9.36 / P1-11:createVersion 早就支持 evidence,但这条 HTTP 路由**没把 body.evidence 传下去** ——
    // 「后端 type 多一个字段」不等于端到端通了。校验口径与 PUT /evidence 完全一致(同一个纯函数)。
    let evidence: StrategySpec['evidence'] | undefined;
    if (Object.hasOwn(body, 'evidence')) {
      const v = validateEvidenceSpec(body['evidence']);
      if (v.error) return fail(res, 400, v.error, 'invalid');
      evidence = v.evidence;
    }
    const { spec, error } = lib.createVersion(id, { ...(body['horizon'] ? { horizon: body['horizon'] as StrategyHorizon } : {}), ...(params ? { params } : {}), ...(rules ? { rules } : {}), ...(evidence !== undefined ? { evidence } : {}), ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}) });
    if (error) return fail(res, 400, error, 'invalid');
    if (attribution && spec) store.saveAttribution({ ...attribution, applied_version: spec.version });
    if (spec) store.strategyEvents.append({ strategy_id: spec.id, version: spec.version, at: Date.now(), who: attribution ? 'attribution' : 'human', kind: 'version_created', from_status: null, to_status: 'draft', reason: attribution ? `采纳归因 ${attribution.id}:${attribution.title}` : '人工生成新版本', evidence: {} });
    changed(spec);
    json(res, 201, { strategy: spec ? view(spec) : null });
  }));

  /**
   * §9.34 自定义证据:改证据集 = 换判断输入,所以**必须**走 createVersion 出一个新 draft,
   * 绝不原地改旧版本(evidence 进 content_hash,原地改会让已结算的成绩挂在一个不存在的内容上)。
   * body: `{ evidence: StrategyEvidenceSpec | null }`,`null` = 清空回默认集。
   * 跟 propose-version 一样落一行 `version_created` 台账(who='human')。
   */
  route('PUT', '/api/strategies/:id/evidence', guarded(async (req, res, _url, p) => {
    const id = p['id']!;
    const head = lib.head(id);
    if (!head) return fail(res, 404, `没有策略 ${id}`, 'not_found');
    const body = await readBody(req);
    if (!Object.hasOwn(body, 'evidence')) return fail(res, 400, 'evidence 必填(null = 清空回默认集)', 'invalid');
    const { evidence, error } = validateEvidenceSpec(body['evidence']);
    if (error) return fail(res, 400, error, 'invalid');
    const created = lib.createVersion(id, { evidence });
    // 「内容没有变化」不是服务器错:这套证据就是当前版本的证据,照实说,别造一个空 draft。
    if (created.error) return fail(res, 409, created.error, 'conflict');
    const spec = created.spec!;
    store.strategyEvents.append({ strategy_id: spec.id, version: spec.version, at: Date.now(), who: 'human', kind: 'version_created', from_status: head.status, to_status: 'draft', reason: `人工改证据集(指标 ${evidence ? evidence.indicators.length : 0} 项,事件 ${evidence ? evidence.events.length : 0} 项${evidence ? '' : ',已清空回默认集'})`, evidence: {} });
    changed(spec);
    json(res, 201, { strategy: view(spec), from_version: head.version });
  }));

  route('POST', '/api/strategies/:id/promote', guarded(async (req, res, _url, p) => {
    const body = await readBody(req);
    const to = body['to'];
    if (!isStatus(to) || to === 'retired') return fail(res, 400, `to 只能是 ${STATUS_ORDER.join('/')}`, 'invalid');
    const requestedVersion = body['version'];
    if (requestedVersion !== undefined && (!Number.isInteger(requestedVersion) || Number(requestedVersion) < 1)) return fail(res, 400, 'version 必须为正整数', 'invalid');
    const before = requestedVersion === undefined ? lib.head(p['id']!) : lib.version(p['id']!, Number(requestedVersion));
    const { spec, error } = lib.promote(p['id']!, to, { confirm: body['confirm'] === true, ...(before ? { version: before.version } : {}), ...((to === 'paper' || to === 'live_capped' || before?.health_by_backend?.[rt.backend.kind]) ? { backend: rt.backend.kind } : {}) });
    if (error) return fail(res, 409, error, 'conflict');
    if (spec) store.strategyEvents.append({ strategy_id: spec.id, version: spec.version, at: Date.now(), who: 'human', kind: 'promote', from_status: before?.status ?? null, to_status: to, reason: '人工晋升', evidence: { lab_n: spec.lab_stats?.n ?? null, lab_expectancy_r: spec.lab_stats?.expectancy_r ?? null, shadow_n: spec.lab_stats?.shadow?.n ?? null, shadow_expectancy_r: spec.lab_stats?.shadow?.expectancy_r ?? null, eval_expectancy_r: spec.eval_stats.expectancy_r } });
    changed(spec);
    json(res, 200, { strategy: spec ? view(spec) : null });
  }));

  route('POST', '/api/strategies/:id/retire', guarded(async (_req, res, _url, p) => {
    const before = lib.head(p['id']!);
    const { spec, error } = lib.retire(p['id']!);
    if (error) return fail(res, 404, error, 'not_found');
    if (spec) store.strategyEvents.append({ strategy_id: spec.id, version: spec.version, at: Date.now(), who: 'human', kind: 'retire', from_status: before?.status ?? null, to_status: 'retired', reason: '人工退役', evidence: {} });
    // 退役的策略不该继续挂在实盘启用列表里。
    const active = (rt.workflow.active_strategies ?? []).filter((x) => x !== p['id']);
    if (active.length !== (rt.workflow.active_strategies ?? []).length) await rt.applyWorkflow({ active_strategies: active });
    changed(spec);
    json(res, 200, { strategy: spec ? view(spec) : null, active });
  }));

  // ---- 回测归因(步骤 4–6)

  route('GET', '/api/backtest/:id/attribution', guarded(async (_req, res, _url, p) => {
    json(res, 200, { points: store.attributions(p['id']!) });
  }));

  route('POST', '/api/backtest/:id/attribute', guarded(async (_req, res, _url, p) => {
    const runId = p['id']!;
    const run = store.backtestRun(runId);
    if (!run) return fail(res, 404, `没有这次回测:${runId}`, 'not_found');
    if (run.status !== 'done') return fail(res, 409, `回测状态是 ${run.status},跑完了才能归因`, 'conflict');
    const existing = store.attributions(runId);
    if (existing.length) return json(res, 200, { points: existing, error: null, cached: true });
    const strategies = resolveRunStrategies(run.params.strategy_ids ?? [], store.strategies);
    const brain = rt.brainFor(rt.workflow.cheap_brain, rt.workflow.cheap_brain_model);
    const r = await runAttribution(run, store.backtestSteps(runId), run.summary?.trade_rows ?? [], strategies, {
      brain,
      memory: store.memory,
      save: (a) => store.saveAttribution(a),
      // param 类提案进 Lab 探针队列等下一轮验证(§1.3);记忆提案照旧,两条路互不替代。
      enqueueProbe: (p) => {
        store.labProbes.enqueue({ ...p, source: 'attribution' });
      },
    });
    if (r.points.length) ctx.emit('strategy.changed', { run_id: runId, attributions: r.points.length });
    json(res, 200, { points: r.points, error: r.error, cached: false });
  }));
};
