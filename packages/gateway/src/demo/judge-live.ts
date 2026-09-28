/**
 * 实盘 Jev 判断(docs/design/jev-live-2026-09-25.md):
 *  - 影子判断(shadow):策略运行里 IR 不带 judge 块的候选,也用默认模板(take + quality)问一次 Jev。只记录,不挡单,
 *    不改变 follow 语义;每个运行每 UTC 日有调用次数 + 美元双上限(按 JUDGE_MAX_CALL_USD 原子预留)。
 *  - 挡单判断(gate):IR 带 judge 块时的原有语义(strategy-run.ts 里 judgeWithBars),这里只负责把结果平铺进账本。
 *  - 账本 judge_live_decisions(migrations/0053)。原始问答仍在 research_judge_decisions,decision_key 以 `live:` 开头。
 *
 * 影子判断是非关键路径:runShadowJudge 永不抛错(失败只记一行 error),调用方 fire-and-forget。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ResearchBar, StrategyIR, StrategyJudge } from '@trade-gate/contracts';
import { hash } from './research/primitives.js';
import { timeframeMillis } from './research/strategy.js';
import { AtomicCallBudget, JudgeDecisionStore, buildJudgeState, fromDecisionClient, judgeCandidate, usdString, usdUnits, type JudgeRuntime } from './research/judge/index.js';
import { candidateSnapshot, judgeDecimal } from './research/judge/candidate.js';
import { templateJudge, type JudgeTemplateKey } from './research/judge/templates.js';
import { calculateMicrostructure, needsMicrostructure, type MicrostructureSnapshot, type MicrostructureSource } from './research/judge/microstructure.js';
import type { FrozenModelProfile, JudgeCandidateSnapshot, JudgeResult, JudgeStateV1, NormalizedAnswer, PredicateEvaluation } from './research/judge/types.js';
import type { DecisionClient } from './decisions.js';
import type { StrategyThread } from './types.js';

/** 影子判断每个运行每 UTC 日最多调用次数。 */
export const JEV_SHADOW_MAX_CALLS = 200;
/** 影子判断每个运行每 UTC 日美元上限 = 200 × JUDGE_MAX_CALL_USD($0.00015)。每次调用按单次上限原子预留,超了就不再调。 */
export const JEV_SHADOW_MAX_USD = '0.03';
/** 同一运行器同时在途的影子判断上限;超出直接跳过(记一条原因),不排队、不拖住下单。 */
export const JEV_SHADOW_MAX_INFLIGHT = 4;
/** 影子判断默认问题模板。 */
export const JEV_SHADOW_TEMPLATES: JudgeTemplateKey[] = ['take', 'quality'];

export type JudgeLiveMode = 'shadow' | 'gate';
export type JudgeLiveStatus = 'ok' | 'uncertain' | 'error' | 'skipped';
export interface JudgeLiveCandidate { candidate_id: string | null; direction: 'long' | 'short'; entry: string; stop: string; target: string | null; reward_risk: number | null }
export interface JudgeLiveQuestion { key: string; type: 'noul' | 'score' | 'choice'; instructions: string; labels: string[] }
export interface JudgeLiveMicro {
  /** 这次判断有没有接录制源 */
  requested: boolean;
  /** 盘口特征(失衡/墙/价差)在 as_of 前 2 分钟内可用 */
  book: boolean;
  /** 清算特征(近 5 分钟多空清算额)有完整覆盖 */
  liquidations: boolean;
  /** 盘口/清算特征是否真的进了问题(影子判断要六项齐全才带) */
  used: boolean;
  note: string | null;
}
export interface JudgeLiveStateSummary { candidate: Record<string, unknown>; features: Record<string, unknown>; micro: JudgeLiveMicro }
export interface JudgeLiveRecord {
  id: string;
  /** research_judge_decisions.decision_id(其 decision_key 以 live: 开头);没调到判断(skipped/前置失败)时为 null */
  decision_id: string | null;
  run_id: string; strategy_id: string; strategy_name: string; symbol: string; timeframe: string;
  as_of: number; mode: JudgeLiveMode; status: JudgeLiveStatus;
  /** 判断给出的 follow/skip。影子判断只是「Jev 会怎么选」,不影响下单;skipped 行为 null */
  action: 'follow' | 'skip' | null;
  candidate: JudgeLiveCandidate; questions: JudgeLiveQuestion[]; answers: NormalizedAnswer[]; predicates: PredicateEvaluation[];
  state: JudgeLiveStateSummary | null; reason_codes: string[];
  cost_usd: string | null; latency_ms: number | null; error: string | null; model: string | null; created_at: number;
}
export interface JudgeLiveOutcome { thread_id: string; status: string; opened: boolean; closed: boolean; realized_r: number | null }
export type JudgeLiveItem = JudgeLiveRecord & { outcome: JudgeLiveOutcome | null };
export interface JudgeLiveRunRef { id: string; strategy_id: string; strategy_name: string; timeframe: string; ir_hash: string; market: string }

export const utcDay = (ms: number): number => Math.floor(ms / 86_400_000) * 86_400_000;
const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function liveQuestions(spec: StrategyJudge): JudgeLiveQuestion[] {
  return spec.questions.map(q => ({ key: q.key, type: q.type, instructions: q.instructions, labels: q.type === 'noul' ? ['yes', 'no'] : [...(q.labels ?? [])] }));
}
function candidateSummary(s: JudgeCandidateSnapshot | null, c: { direction: 'long' | 'short'; entry: string; stop: string; target: string | null; reward_risk: number | null }): JudgeLiveCandidate {
  return { candidate_id: s?.id ?? null, direction: c.direction, entry: c.entry, stop: c.stop, target: c.target, reward_risk: c.reward_risk };
}
/** 盘口/清算六项是否可用(与 templateJudge microstructure 的字段一致)。录制源读坏 = 不可用,不抛。 */
export function microAvailability(snap: MicrostructureSnapshot | null | undefined, as_of: number, requested: boolean): JudgeLiveMicro & { features: ReturnType<typeof calculateMicrostructure> } {
  if (!snap) return { requested, book: false, liquidations: false, used: false, note: requested ? 'no_recording' : 'no_source', features: {} };
  try {
    const f = calculateMicrostructure(snap, as_of);
    const book = f.ob_imbalance_05 !== undefined && f.spread_bps !== undefined && f.ob_wall_up !== undefined && f.ob_wall_down !== undefined;
    const liquidations = f.liq_long_5m !== undefined && f.liq_short_5m !== undefined;
    return { requested, book, liquidations, used: false, note: book ? liquidations ? null : 'liquidation_coverage_missing' : 'book_stale_or_missing', features: f };
  } catch (e) { return { requested, book: false, liquidations: false, used: false, note: `micro_invalid:${errMessage(e)}`, features: {} }; }
}

export class JudgeLiveLedger {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}
  /** 按 id 幂等;写入成功返回该行,重复返回 null(不重复推 SSE)。 */
  record(r: Omit<JudgeLiveRecord, 'created_at'> & { created_at?: number }): JudgeLiveRecord | null {
    const row: JudgeLiveRecord = { ...r, created_at: r.created_at ?? this.now() };
    const res = this.db.prepare(`INSERT OR IGNORE INTO judge_live_decisions (id,decision_id,run_id,strategy_id,strategy_name,symbol,timeframe,as_of,mode,status,action,candidate_json,questions_json,answers_json,predicates_json,state_json,reason_codes_json,cost_usd,latency_ms,error,model,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.decision_id, row.run_id, row.strategy_id, row.strategy_name, row.symbol, row.timeframe, row.as_of, row.mode, row.status, row.action,
      JSON.stringify(row.candidate), JSON.stringify(row.questions), JSON.stringify(row.answers), JSON.stringify(row.predicates), row.state ? JSON.stringify(row.state) : null, JSON.stringify(row.reason_codes),
      row.cost_usd, row.latency_ms, row.error, row.model, row.created_at);
    return Number(res.changes) === 1 ? row : null;
  }
  list(opts: { limit?: number; run_id?: string | null; since?: number } = {}): JudgeLiveRecord[] {
    const n = Math.min(2000, Math.max(1, Math.floor(opts.limit ?? 50) || 50));
    const rows = this.db.prepare(`SELECT * FROM judge_live_decisions WHERE (? IS NULL OR run_id=?) AND created_at>=? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(opts.run_id ?? null, opts.run_id ?? null, opts.since ?? 0, n);
    return rows.map(r => ({
      id: String(r['id']), decision_id: r['decision_id'] === null ? null : String(r['decision_id']), run_id: String(r['run_id']), strategy_id: String(r['strategy_id']), strategy_name: String(r['strategy_name']),
      symbol: String(r['symbol']), timeframe: String(r['timeframe']), as_of: Number(r['as_of']), mode: r['mode'] as JudgeLiveMode, status: r['status'] as JudgeLiveStatus,
      action: (r['action'] ?? null) as JudgeLiveRecord['action'], candidate: JSON.parse(String(r['candidate_json'])) as JudgeLiveCandidate, questions: JSON.parse(String(r['questions_json'])) as JudgeLiveQuestion[],
      answers: JSON.parse(String(r['answers_json'])) as NormalizedAnswer[], predicates: JSON.parse(String(r['predicates_json'])) as PredicateEvaluation[],
      state: r['state_json'] === null ? null : JSON.parse(String(r['state_json'])) as JudgeLiveStateSummary, reason_codes: JSON.parse(String(r['reason_codes_json'])) as string[],
      cost_usd: r['cost_usd'] === null ? null : String(r['cost_usd']), latency_ms: r['latency_ms'] === null ? null : Number(r['latency_ms']), error: r['error'] === null ? null : String(r['error']),
      model: r['model'] === null ? null : String(r['model']), created_at: Number(r['created_at']),
    }));
  }
}

/** 候选之后的线程(同运行、同币、同方向、在候选有效期内建的第一条);关联不上 = null。 */
export function linkOutcome(rec: Pick<JudgeLiveRecord, 'symbol' | 'as_of' | 'timeframe' | 'candidate'>, threads: readonly StrategyThread[], realizedR?: (t: StrategyThread) => number | null): JudgeLiveOutcome | null {
  let ms: number; try { ms = timeframeMillis(rec.timeframe); } catch { return null; }
  const t = threads.filter(t => t.symbol === rec.symbol && t.side === rec.candidate.direction && t.created_at >= rec.as_of && t.created_at < rec.as_of + 2 * ms)
    .sort((a, b) => a.created_at - b.created_at)[0];
  if (!t) return null;
  const r = t.status === 'closed' ? realizedR?.(t) ?? null : null;
  return { thread_id: t.id, status: t.status, opened: !!t.opened_at, closed: t.status === 'closed', realized_r: r !== null && Number.isFinite(r) ? r : null };
}

interface Bucket { judged: number; traded: number; closed: number; wins: number; realized_r_sum: number | null; avg_r: number | null }
export interface JudgeLiveSummary {
  day_start: number;
  today: {
    /** 今天记下的判断行(含 skipped) */
    judged: number;
    /** 今天真正发出的 Jev 请求数(原子预算表里的预留次数,live:* 作用域) */
    calls: number;
    /** 已结算花费 + 仍预留(回执没带用量的请求不释放预留) */
    cost_usd: string; reserved_usd: string;
    follow: number; skip: number; follow_ratio: number | null;
    errors: number; skipped: number; shadow: number; gate: number;
    skip_reasons: Record<string, number>;
  };
  /** 今天各运行的影子预算 */
  budgets: { run_id: string; max_calls: number; calls: number; max_usd: string; spent_usd: string; reserved_usd: string }[];
  /** 影子判断 vs 实际结果(近 30 天影子行按 Jev 的 follow/skip 分桶,看后来真实线程的已实现 R) */
  comparison: { window_from: number; follow: Bucket; skip: Bucket };
}
export function judgeLiveSummary(db: DatabaseSync, ledger: JudgeLiveLedger, opts: { now: number; run_id?: string | null; outcome: (rec: JudgeLiveRecord) => JudgeLiveOutcome | null }): JudgeLiveSummary {
  const day = utcDay(opts.now), rows = ledger.list({ run_id: opts.run_id ?? null, since: day, limit: 2000 });
  const skip_reasons: Record<string, number> = {};
  const judged = rows.filter(r => r.status !== 'skipped');
  for (const r of rows.filter(r => r.status === 'skipped')) { const k = r.reason_codes[0] ?? 'unknown'; skip_reasons[k] = (skip_reasons[k] ?? 0) + 1; }
  const follow = judged.filter(r => r.action === 'follow').length, skip = judged.filter(r => r.action === 'skip').length;
  const budgets = db.prepare(`SELECT id,max_calls,max_usd,calls,spent_usd,reserved_usd FROM research_call_budgets WHERE id LIKE 'live:%' AND id LIKE ?`).all(`%:${day}`)
    .map(b => ({ id: String(b['id']), max_calls: Number(b['max_calls']), calls: Number(b['calls']), max_usd: String(b['max_usd']), spent_usd: String(b['spent_usd']), reserved_usd: String(b['reserved_usd']) }))
    .filter(b => !opts.run_id || b.id.split(':')[2] === opts.run_id);
  const sum = (xs: string[]) => usdString(xs.reduce((a, x) => { try { return a + usdUnits(x); } catch { return a; } }, 0n));
  const from = opts.now - 30 * 86_400_000, bucket = (): Bucket => ({ judged: 0, traded: 0, closed: 0, wins: 0, realized_r_sum: null, avg_r: null });
  const comparison = { window_from: from, follow: bucket(), skip: bucket() };
  for (const r of ledger.list({ run_id: opts.run_id ?? null, since: from, limit: 2000 })) {
    if (r.mode !== 'shadow' || !r.action || r.status === 'skipped') continue;
    const b = comparison[r.action]; b.judged++;
    const o = opts.outcome(r); if (!o) continue;
    b.traded++;
    if (o.closed && o.realized_r !== null) { b.closed++; b.realized_r_sum = (b.realized_r_sum ?? 0) + o.realized_r; if (o.realized_r > 0) b.wins++; }
  }
  for (const b of [comparison.follow, comparison.skip]) b.avg_r = b.closed && b.realized_r_sum !== null ? b.realized_r_sum / b.closed : null;
  return {
    day_start: day,
    today: { judged: rows.length, calls: budgets.reduce((a, b) => a + b.calls, 0), cost_usd: sum(budgets.map(b => b.spent_usd)), reserved_usd: sum(budgets.map(b => b.reserved_usd)),
      follow, skip, follow_ratio: follow + skip ? follow / (follow + skip) : null, errors: judged.filter(r => r.status === 'error').length, skipped: rows.length - judged.length,
      shadow: rows.filter(r => r.mode === 'shadow').length, gate: rows.filter(r => r.mode === 'gate').length, skip_reasons },
    budgets: budgets.filter(b => b.id.startsWith('live:shadow:')).map(({ id, ...b }) => ({ run_id: id.split(':')[2]!, ...b })),
    comparison,
  };
}

/**
 * Jev 运行时工厂:返回 JudgeRuntime,或一个「为什么不可用」的原因码。
 * mode='shadow'(缺省)= 影子判断,预算作用域 live:shadow:<run>:<day>;mode='gate' = §9.56 运行模式 jev 的挡单判断,作用域 live:jev:<run>:<day>。
 */
export type JevShadowFactory = (run: JudgeLiveRunRef, day: number, signal: AbortSignal, mode?: JudgeLiveMode) => JudgeRuntime | string;
export function jevShadowFactory(o: { db: DatabaseSync; frozen: () => { profile: FrozenModelProfile; client: DecisionClient } | null; microstructure?: MicrostructureSource; max_calls?: number; max_usd?: string }): JevShadowFactory {
  return (run, day, signal, mode = 'shadow') => {
    try {
      const f = o.frozen();
      if (!f) return 'decision_model_unbound';
      const scope = `live:${mode === 'gate' ? 'jev' : 'shadow'}:${run.id}:${day}`;
      return {
        mode: 'request_once', scope, provider: fromDecisionClient(f.client, f.profile), model_profile: f.profile, signal,
        execution_spec_hash: hash({ kind: mode === 'gate' ? 'jev_gate' : 'jev_shadow', templates: JEV_SHADOW_TEMPLATES, ir_hash: run.ir_hash, timeframe: run.timeframe, market: run.market }),
        store: new JudgeDecisionStore(o.db), budget: AtomicCallBudget.create(o.db, scope, o.max_calls ?? JEV_SHADOW_MAX_CALLS, o.max_usd ?? JEV_SHADOW_MAX_USD),
        ...(o.microstructure ? { microstructure: o.microstructure } : {}),
      };
    } catch (e) { return `decision_model_unavailable:${errMessage(e)}`; }
  };
}

export interface ShadowJudgeInput {
  run: JudgeLiveRunRef; ir: StrategyIR;
  candidate: { symbol: string; as_of: number; direction: 'long' | 'short'; entry_ref: number; stop: number; target: number | null; rr: number | null };
  bars: readonly ResearchBar[]; timeframe_ms: number;
  factory: JevShadowFactory; ledger: JudgeLiveLedger; signal: AbortSignal; now: () => number;
}
const liveId = (x: unknown) => `jl_${hash(x).slice(0, 32)}`;
/** 影子判断一次。永不抛错;返回新写入的账本行(重复/写失败返回 null)。 */
export async function runShadowJudge(x: ShadowJudgeInput): Promise<JudgeLiveRecord | null> {
  return (await runJevJudge(x, 'shadow')).row;
}

/** 一次 Jev 判断的结论。只有 Jev 明确说跟才放行,说跳过、调不到、预算用完或出错都按跳过处理。 */
export interface JevVerdict { row: JudgeLiveRecord | null; action: 'follow' | 'skip' | null; reason: string; code: 'jev_follow' | 'jev_skip' | 'jev_unavailable' }

/**
 * Jev 判断(影子 / 挡单共用一条链):永不抛错。mode='gate' 是 §9.56 运行模式 jev 的真门,账本行 mode='gate',
 * 每个候选一行(影子的「跳过」行按天去重,挡单的每次都记,漏斗要能数到每一笔为什么没下)。
 */
export async function runJevJudge(x: ShadowJudgeInput, mode: JudgeLiveMode): Promise<JevVerdict> {
  const started = performance.now(), c = x.candidate;
  const summary = { direction: c.direction, entry: judgeDecimal(c.entry_ref), stop: judgeDecimal(c.stop), target: c.target === null ? null : judgeDecimal(c.target), reward_risk: c.rr };
  const base = { run_id: x.run.id, strategy_id: x.run.strategy_id, strategy_name: x.run.strategy_name, symbol: c.symbol, timeframe: x.run.timeframe, as_of: c.as_of, mode };
  let questions: JudgeLiveQuestion[] = [], snapshot: JudgeCandidateSnapshot | null = null;
  const candidateId = liveId({ mode, run: x.run.id, symbol: c.symbol, as_of: c.as_of });
  const write = (r: Omit<JudgeLiveRecord, 'created_at' | 'id' | keyof typeof base | 'candidate' | 'questions'> & { id?: string }): JudgeLiveRecord | null => {
    try { return x.ledger.record({ id: r.id ?? candidateId, ...base, candidate: candidateSummary(snapshot, summary), questions, ...r }); }
    catch { return null; }
  };
  const unavailable = (reason: string): JevVerdict => ({ row: write({ id: mode === 'shadow' ? liveId({ mode: 'shadow', run: x.run.id, day: utcDay(x.now()), skip: reason.split(':')[0] }) : candidateId, decision_id: null, status: 'skipped', action: null, answers: [], predicates: [], state: null,
    reason_codes: [reason.split(':')[0]!], cost_usd: '0', latency_ms: null, error: reason, model: null }), action: null, reason, code: 'jev_unavailable' });
  const failed = (reason: string, state: JudgeLiveStateSummary | null = null): JevVerdict => ({ row: write({ decision_id: null, status: 'error', action: null, answers: [], predicates: [], state, reason_codes: [reason.split(':')[0]!], cost_usd: '0',
    latency_ms: Math.round(performance.now() - started), error: reason, model: null }), action: null, reason, code: 'jev_unavailable' });
  const budgetCode = mode === 'gate' ? 'jev_budget_exhausted' : 'shadow_budget_exhausted';
  try {
    if (x.signal.aborted) return { row: null, action: null, reason: 'cancelled', code: 'jev_unavailable' };
    const rt = x.factory(x.run, utcDay(x.now()), x.signal, mode);
    if (typeof rt === 'string') return unavailable(rt);
    const v = rt.budget.view();
    if (v.cancelled || v.blocked || v.calls >= v.max_calls || usdUnits(v.spent_usd) + usdUnits(v.reserved_usd) + usdUnits(rt.model_profile.max_call_usd) > usdUnits(v.max_usd)) return unavailable(budgetCode);
    snapshot = candidateSnapshot(x.ir, { symbol: c.symbol, as_of: c.as_of, timeframe_ms: x.timeframe_ms, ...summary });
    let snap: MicrostructureSnapshot | null = null, readError: string | null = null;
    if (rt.microstructure) { try { snap = await rt.microstructure(c.symbol, c.as_of); } catch (e) { readError = `micro_read_failed:${errMessage(e)}`; } }
    const micro = microAvailability(snap, c.as_of, !!rt.microstructure);
    if (readError) micro.note = readError;
    micro.used = micro.book && micro.liquidations;
    const spec = templateJudge(rt.model_profile.ref, { templates: JEV_SHADOW_TEMPLATES, microstructure: micro.used });
    questions = liveQuestions(spec);
    const { features: _f, ...microFlags } = micro;
    let state: JudgeStateV1;
    try { state = buildJudgeState(snapshot, x.bars, spec, micro.used ? snap : null); }
    catch (e) { return failed(errMessage(e), { candidate: {}, features: {}, micro: microFlags }); }
    if (x.signal.aborted) return { row: null, action: null, reason: 'cancelled', code: 'jev_unavailable' };
    const result = await judgeCandidate({ candidate: snapshot, state, spec, execution_spec_hash: rt.execution_spec_hash, model_profile: rt.model_profile, decision_key: `${rt.scope}:${snapshot.id}` }, rt);
    if (result.reason_codes.includes('judge_budget_exhausted')) return unavailable(budgetCode);
    const row = write(fromResult(result, { candidate: { ...state.candidate }, features: { ...state.features }, micro: microFlags }, rt.model_profile, Math.round(performance.now() - started)));
    const follow = result.action === 'follow' && result.status === 'ok';
    const why = result.reason_codes.join(',') || result.action;
    return { row, action: result.action, reason: follow ? why : result.status === 'ok' || result.status === 'uncertain' ? why : `jev_error:${why}`, code: follow ? 'jev_follow' : result.status === 'error' ? 'jev_unavailable' : 'jev_skip' };
  } catch (e) { return failed(`${mode === 'gate' ? 'jev_failed' : 'shadow_failed'}:${errMessage(e)}`); }
}

function fromResult(result: JudgeResult, state: JudgeLiveStateSummary | null, profile: FrozenModelProfile | null, wall_ms: number) {
  return { decision_id: result.decision_id || null, status: result.status, action: result.action, answers: result.answers, predicates: result.predicates, state, reason_codes: result.reason_codes,
    cost_usd: result.cost_usd, latency_ms: result.latency_ms > 0 ? result.latency_ms : wall_ms, error: result.status === 'error' ? result.reason_codes.join(',') || 'judge_error' : null,
    model: result.model_revision ?? profile?.model ?? null };
}

/** 挡单判断(IR 带 judge 块)的账本行。只读已算好的结果,不改变挡单语义;state 另按同一份录制快照重算一次(纯函数)。 */
export function gateRecord(x: {
  run: JudgeLiveRunRef; ir: StrategyIR; snapshot: JudgeCandidateSnapshot | null; bars: readonly ResearchBar[];
  candidate: ShadowJudgeInput['candidate']; result: JudgeResult | null; error?: string | null;
  micro: { requested: boolean; snapshot: MicrostructureSnapshot | null | undefined }; profile: FrozenModelProfile | null; wall_ms: number;
}): Omit<JudgeLiveRecord, 'created_at'> {
  const c = x.candidate, spec = x.ir.judge ?? null;
  const summary = { direction: c.direction, entry: judgeDecimal(c.entry_ref), stop: judgeDecimal(c.stop), target: c.target === null ? null : judgeDecimal(c.target), reward_risk: c.rr };
  const m = microAvailability(x.micro.snapshot, c.as_of, x.micro.requested), { features: _f, ...micro } = m;
  micro.used = !!spec && needsMicrostructure(spec) && m.book && m.liquidations;
  let state: JudgeLiveStateSummary | null = null;
  if (spec && x.snapshot) {
    try { const s = buildJudgeState(x.snapshot, x.bars, spec, spec && needsMicrostructure(spec) ? x.micro.snapshot ?? null : null); state = { candidate: { ...s.candidate }, features: { ...s.features }, micro }; }
    catch { state = { candidate: {}, features: {}, micro }; }
  }
  const head = { id: liveId({ mode: 'gate', run: x.run.id, symbol: c.symbol, as_of: c.as_of }), run_id: x.run.id, strategy_id: x.run.strategy_id, strategy_name: x.run.strategy_name, symbol: c.symbol, timeframe: x.run.timeframe,
    as_of: c.as_of, mode: 'gate' as const, candidate: candidateSummary(x.snapshot, summary), questions: spec ? liveQuestions(spec) : [] };
  if (!x.result) return { ...head, decision_id: null, status: 'skipped', action: 'skip', answers: [], predicates: [], state, reason_codes: [String(x.error ?? 'judge_error').split(':')[0]!], cost_usd: '0', latency_ms: x.wall_ms, error: x.error ?? 'judge_error', model: null };
  return { ...head, ...fromResult(x.result, state, x.profile, x.wall_ms) };
}

/** 记住录制源本次返回的快照(挡单判断读一次,账本复用同一份;不改变判断输入)。 */
export function memoMicro(src: MicrostructureSource | undefined): { source: MicrostructureSource | undefined; snapshot: () => MicrostructureSnapshot | null | undefined } {
  if (!src) return { source: undefined, snapshot: () => undefined };
  let last: MicrostructureSnapshot | null | undefined;
  return { source: async (symbol, as_of) => (last = await src(symbol, as_of)), snapshot: () => last };
}
