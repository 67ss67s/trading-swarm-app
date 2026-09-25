/**
 * Reviewer 的编排层(reviewer.ts 是纯计算):
 *   - 线程关闭 → 复盘卡 bot_run(routine trade_card,零模型)→ 检查是否该跑批次;
 *   - 每 30 分钟看一眼 24h 条件;paused 时不调模型;每天 ≤ 2 次批次;
 *   - 批次 = bot_run(routine review_batch)+ memory.propose(proposed)+ handoff reviewer → gate_captain(kind review)。
 * 红线:只写自己的 run/handoff 与 proposed 记忆;对 workflow / thread / intent / 策略 / 已激活记忆一个字不碰。
 */
import { randomBytes } from 'node:crypto';
import type { DemoRuntime } from './runtime.js';
import { HYPOTHESIS_EVERY_MS, HYPOTHESIS_LOOKBACK_MS, runHypothesis } from './strategy-hypothesis.js';
import { BATCH_MAX_PER_DAY, BATCH_MAX_THREADS, BATCH_MIN_THREADS, batchKey, eligibleForBatch, lessonToProposal, reflectBatch, REVIEWER_PROMPT_VERSION, shouldRunBatch, tradeCard, type BatchDecision, type ReflectResult, type TradeCard } from './reviewer.js';
import type { Brain } from './brain.js';
import type { StrategyThread } from './types.js';
import { summarizeLedger, type LedgerSummary } from './judgment-ledger.js';

const KV_LAST_BATCH = 'team.reviewer.last_batch_at';
const KV_LAST_HYPOTHESIS = 'team.reviewer.last_hypothesis_at';
/** 已进过批次的线程 id(JSON 数组,最多留 500 个)。 */
const KV_SEEN = 'team.reviewer.batched_ids';
const TICK_MS = 30 * 60_000;

export interface ReviewerOptions {
  reflect?: (brain: Brain, cards: readonly TradeCard[], existing: readonly string[]) => Promise<ReflectResult>;
  now?: () => number;
}

export class Reviewer {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private readonly reflectImpl: (brain: Brain, cards: readonly TradeCard[], existing: readonly string[]) => Promise<ReflectResult>;
  private readonly now: () => number;

  constructor(
    private readonly rt: DemoRuntime,
    opts: ReviewerOptions = {},
  ) {
    this.reflectImpl = opts.reflect ?? ((b, c, e) => reflectBatch(b, c, e));
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    this.timer = setInterval(() => void this.maybeBatch('timer').catch(() => {}), TICK_MS);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isThinking(): boolean {
    return this.running !== null;
  }

  // ------------------------------------------------------------ ① 复盘卡

  /** 线程关闭/取消/失效时调用(runtime reconcile)。零模型。 */
  onThreadEnded(t: StrategyThread): TradeCard {
    const card = tradeCard(t, this.rt.store.episodeCountForThread(t.id));
    const run = this.rt.store.bots.startRun({ id: runId(), role: 'reviewer', routine: 'trade_card', started_at: this.now(), budget: { model: false }, input: { thread_id: t.id, version: t.version } });
    this.rt.store.bots.finishRun(run.id, {
      status: 'done',
      finished_at: this.now(),
      summary: `${card.symbol} ${card.side} ${card.outcome}${card.r_multiple !== null ? ` ${card.r_multiple}R` : ''} ${card.exit_class}${card.protection_ok ? '' : ' 保护缺失'}`,
      result: card as unknown as Record<string, unknown>,
    });
    this.rt.emit('bots.changed', { role: 'reviewer', run_id: run.id });
    void this.maybeBatch('thread_ended').catch(() => {});
    return card;
  }

  /**
   * 批次卡附带的**判断账本汇总**(契约 §9.29):代码算的 judgment_alpha / override_alpha / regret。
   * 它只写进 bot_run 的 result 供复盘页显示,**不进模型 prompt** —— 模型不该看自己的成绩单再去写教训。
   */
  ledgerSummary(sinceMs = 30 * 24 * 3_600_000): LedgerSummary {
    const since = this.now() - sinceMs;
    return summarizeLedger(this.rt.store.judgments.list({ since, limit: 500 }), { since });
  }

  /** 最近的复盘卡(从 bot_runs 读)。 */
  cards(limit = 50): TradeCard[] {
    return this.rt.store.bots
      .runs({ role: 'reviewer', routine: 'trade_card', limit })
      .map((r) => r.result as unknown as TradeCard | null)
      .filter((c): c is TradeCard => c !== null);
  }

  // ------------------------------------------------------------ ② 批次

  private seenIds(): Set<string> {
    try {
      return new Set(JSON.parse(this.rt.store.kvGet(KV_SEEN) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  }
  private lastBatchAt(): number | null {
    const v = this.rt.store.kvGet(KV_LAST_BATCH);
    return v ? Number(v) : null;
  }
  private runsToday(): number {
    const dayStart = new Date(this.now());
    dayStart.setHours(0, 0, 0, 0);
    return this.rt.store.bots.runs({ role: 'reviewer', routine: 'review_batch', limit: 50 }).filter((r) => r.started_at >= dayStart.getTime() && r.status !== 'skipped').length;
  }

  /** 还没进过批次的合格复盘卡(最多 20 张,最新的优先)。 */
  pendingCards(): TradeCard[] {
    const seen = this.seenIds();
    const closed = this.rt.store.closedThreads(100);
    const out: TradeCard[] = [];
    for (const t of closed) {
      if (seen.has(t.id)) continue;
      const c = tradeCard(t, this.rt.store.episodeCountForThread(t.id));
      if (eligibleForBatch(c)) out.push(c);
      if (out.length >= BATCH_MAX_THREADS) break;
    }
    return out;
  }

  decision(): BatchDecision & { pending: number; runs_today: number; last_batch_at: number | null } {
    const pending = this.pendingCards();
    const oldest = pending.length ? Math.min(...pending.map((c) => c.ended_at)) : null;
    const d = shouldRunBatch({ eligible_new: pending.length, last_batch_at: this.lastBatchAt(), oldest_pending_at: oldest, runs_today: this.runsToday(), paused: this.rt.workflow.paused || !this.rt.botEnabled('reviewer'), now: this.now() });
    return { ...d, pending: pending.length, runs_today: this.runsToday(), last_batch_at: this.lastBatchAt() };
  }

  async maybeBatch(reason: 'timer' | 'thread_ended' | 'manual'): Promise<{ ran: boolean; reason: string; run_id?: string }> {
    if (!this.rt.botEnabled('reviewer')) return { ran: false, reason: 'Reviewer 已暂停' };
    const d = this.decision();
    if (!d.run && reason !== 'manual') return { ran: false, reason: d.reason };
    if (reason === 'manual' && (this.rt.workflow.paused || d.pending === 0)) return { ran: false, reason: this.rt.workflow.paused ? '已暂停:不调模型' : '没有新的合格平仓' };
    if (reason === 'manual' && d.runs_today >= BATCH_MAX_PER_DAY) return { ran: false, reason: `今日已跑 ${d.runs_today}/${BATCH_MAX_PER_DAY} 次` };
    if (this.running) return { ran: false, reason: '已有批次在跑' };
    const p = this.runBatch(reason).finally(() => {
      this.running = null;
    });
    this.running = p;
    const r = await p;
    return { ran: true, reason: d.reason, run_id: r.run_id };
  }

  private async runBatch(reason: string): Promise<{ run_id: string; proposed: number; dropped: number }> {
    const store = this.rt.store;
    const cards = this.pendingCards();
    const key = batchKey(cards);
    const now = this.now();
    const run = store.bots.startRun({ id: runId(), role: 'reviewer', routine: 'review_batch', started_at: now, budget: { model: true, max_lessons: 2, prompt: REVIEWER_PROMPT_VERSION, reason }, input: { batch_key: key, thread_ids: cards.map((c) => c.thread_id), small_sample: cards.length < BATCH_MIN_THREADS } });
    this.rt.emit('bots.changed', { role: 'reviewer', run_id: run.id });
    this.rt.log('info', 'reviewer', `批量复盘开始(${reason}):${cards.length} 笔,批次 ${key}`);
    try {
      const existing = store.memory.list({ status: ['active', 'proposed'], kind: 'lesson', limit: 50 }).map((m) => m.content);
      const r = await this.reflectImpl(this.rt.brainForRole('reviewer'), cards, existing);
      const cost = (r.input_tokens + r.output_tokens * 3) * 0.000004;
      const proposed: string[] = [];
      let dup = 0;
      for (const l of r.kept) {
        const { item, created } = store.memory.propose(lessonToProposal(l, key, now));
        if (created) {
          proposed.push(item.id);
          this.rt.emit('memory.changed', { id: item.id, status: item.status });
        } else dup++;
      }
      // 记住这批线程已经复盘过(不管有没有产出教训)。
      const seen = [...this.seenIds(), ...cards.map((c) => c.thread_id)].slice(-500);
      store.kvSet(KV_SEEN, JSON.stringify(seen));
      store.kvSet(KV_LAST_BATCH, String(now));
      const summary = `${cards.length} 笔 → ${proposed.length} 条教训待批${dup ? `,${dup} 条重复` : ''}${r.dropped.length ? `,${r.dropped.length} 条被闸丢弃` : ''}`;
      // 判断账本汇总只落在 result 里(代码算,没进上面的 prompt)。账本坏了不能拖垮复盘批次。
      let ledger: LedgerSummary | null = null;
      try {
        ledger = this.ledgerSummary();
      } catch (e) {
        this.rt.log('warn', 'reviewer', `判断账本汇总失败:${(e as Error).message}`);
      }
      store.bots.finishRun(run.id, { status: 'done', cost_cny: Math.round(cost * 1000) / 1000, summary: `${summary}${ledger && !ledger.overall.insufficient ? `;判断增量 ${ledger.overall.judgment_alpha ?? 'n/a'}R(${ledger.overall.verdict})` : ''}`, finished_at: this.now(), result: { batch_key: key, proposed_memory_ids: proposed, dropped: r.dropped.map((d) => d.reason), model: r.model, latency_ms: r.latency_ms, judgment_ledger: ledger } });
      if (proposed.length) {
        const h = store.bots.handoff({
          handoff_id: `hof-rev-${key}`,
          run_id: run.id,
          from_role: 'reviewer',
          to_role: 'gate_captain',
          kind: 'review',
          subject: { type: 'memory_proposal', id: proposed.join(',') },
          summary: `复盘 ${cards.length} 笔,提炼 ${proposed.length} 条教训,等你在「记忆」页批准`,
          evidence_refs: cards.map((c) => `thread:${c.thread_id}`),
          artifact_refs: [`artifact://bot-run/${run.id}`, ...proposed.map((id) => `memory:${id}`)],
          requested_output_schema: null,
          priority: 30,
          deadline_at: null,
          idempotency_key: `review:${key}:gate_captain:v1`,
          payload: { memory_ids: proposed, batch_key: key },
        });
        this.rt.activity('workflow_changed', { level: 'info', title: `Reviewer 提炼了 ${proposed.length} 条教训,等你批准`, detail: summary, data: { memory_ids: proposed, handoff_id: h.handoff_id, run_id: run.id } });
      }
      this.rt.log('info', 'reviewer', `批量复盘完成:${summary},¥${cost.toFixed(3)}`);
      this.rt.emit('bots.changed', { role: 'reviewer', run_id: run.id });
      // 09-12 §1.1 假设生成:批次跑完后顺手看一眼「这周该不该找新策略」。默认关,开了也每周最多一次。
      await this.maybeHypothesis(now).catch((e) => this.rt.log('warn', 'reviewer', `假设生成失败:${(e as Error).message.slice(0, 200)}`));
      return { run_id: run.id, proposed: proposed.length, dropped: r.dropped.length };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      store.bots.finishRun(run.id, { status: 'failed', error: msg, finished_at: this.now() });
      this.rt.log('warn', 'reviewer', `批量复盘失败:${msg}`);
      this.rt.emit('bots.changed', { role: 'reviewer', run_id: run.id });
      throw e;
    }
  }

  // ------------------------------------------------------------ 假设生成(§1.1「发现」)

  private lastHypothesisAt(): number | null {
    const v = this.rt.store.kvGet(KV_LAST_HYPOTHESIS);
    return v ? Number(v) : null;
  }

  /** 这次该不该跑假设生成(开关 + 每周 ≤1 次 + 没暂停)。 */
  hypothesisDecision(now = this.now()): { run: boolean; reason: string; last_at: number | null } {
    const last = this.lastHypothesisAt();
    if (!this.rt.botEnabled('strategy_lab') || !this.rt.botEnabled('reviewer')) return { run: false, reason: 'Agent 已暂停', last_at: last };
    if (!this.rt.workflow.strategy_discovery) return { run: false, reason: 'strategy_discovery 关着', last_at: last };
    if (this.rt.workflow.paused) return { run: false, reason: '已暂停:不调模型', last_at: last };
    if (last !== null && now - last < HYPOTHESIS_EVERY_MS) return { run: false, reason: `上次假设生成 ${Math.round((now - last) / 3_600_000)}h 前(每周 ≤1 次)`, last_at: last };
    return { run: true, reason: last === null ? '从没生成过假设' : '距上次 ≥ 7 天', last_at: last };
  }

  /**
   * 跑一次假设生成:便宜大脑一次调用 → 代码校验 → 合格的落成 draft(**模型没有晋升权**)。
   * 不合格的直接丢并记日志;整个过程失败都不能影响复盘批次本身。
   */
  async maybeHypothesis(now = this.now()): Promise<{ ran: boolean; reason: string; drafts: number; dropped: number }> {
    const d = this.hypothesisDecision(now);
    if (!d.run) return { ran: false, reason: d.reason, drafts: 0, dropped: 0 };
    const store = this.rt.store;
    const since = now - HYPOTHESIS_LOOKBACK_MS;
    const retroLines = store
      .closedThreads(200)
      .filter((t) => (t.closed_at ?? t.updated_at) >= since)
      .map((t) => tradeCard(t, store.episodeCountForThread(t.id)))
      .filter((c) => c.filled)
      .map((c) => `${c.symbol} ${c.side === 'long' ? '多' : '空'} 策略 ${c.strategy_id ?? '未标注'} ${c.outcome} ${c.r_multiple === null ? 'R n/a' : `${c.r_multiple.toFixed(2)}R`} 离场类型 ${c.exit_class}${c.close_reason ? `(${c.close_reason.slice(0, 40)})` : ''}`);
    const gaps = store.screens
      .screens({ limit: 10 })
      .filter((sc) => sc.status === 'done' && sc.proposal !== null && sc.proposal.symbols.length === 0)
      .map((sc) => `${new Date(sc.started_at).toISOString().slice(0, 10)} ${sc.horizon} 筛选:${sc.proposal!.note.slice(0, 160)}`);
    const existing = store.strategies.list({ include_retired: true }).map((sp) => ({ id: sp.id, name: sp.name, family: sp.family, horizon: sp.horizon, status: sp.status, expectancy_r: sp.lab_stats?.expectancy_r ?? sp.eval_stats.expectancy_r }));
    const r = await runHypothesis(
      { retro_lines: retroLines, memories: store.memory.list({ status: ['active'], limit: 20 }), existing, gaps },
      { brain: this.rt.brainForRole('reviewer'), library: store.strategies, now, log: (level, message) => this.rt.log(level, 'reviewer', message) },
    );
    store.kvSet(KV_LAST_HYPOTHESIS, String(now));
    if (r.error) {
      this.rt.log('warn', 'reviewer', `假设生成没跑完:${r.error}`);
      return { ran: true, reason: d.reason, drafts: 0, dropped: r.dropped.length };
    }
    for (const made of r.drafts) {
      store.strategyEvents.append({ strategy_id: made.id, version: made.version, at: now, who: 'lab', kind: 'version_created', from_status: null, to_status: 'draft', reason: '假设生成(便宜大脑提案,已过 schema/指标库/可量化/判重四道代码校验)', evidence: { retro_cards: retroLines.length, gaps: gaps.length } });
    }
    if (r.drafts.length) {
      this.rt.activity('workflow_changed', {
        level: 'info',
        title: `策略假设生成:${r.drafts.length} 条新草稿`,
        detail: `${r.drafts.map((x) => `${x.id} v${x.version}`).join('、')};都是 draft,不会被 agent 用,要先过漏斗回测与影子实盘${r.dropped.length ? `;另有 ${r.dropped.length} 条不合格被丢` : ''}`,
        data: { drafts: r.drafts, dropped: r.dropped },
      });
      this.rt.emit('strategy.changed', { source: 'hypothesis', drafts: r.drafts.length });
    }
    this.rt.log('info', 'reviewer', `假设生成:${r.drafts.length} 条落库,${r.dropped.length} 条被丢`);
    return { ran: true, reason: d.reason, drafts: r.drafts.length, dropped: r.dropped.length };
  }
}

function runId(): string {
  return `run-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}
