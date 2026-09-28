import { probeVerified } from './replay-stats.js';
/**
 * Strategy Lab 与 Gate Captain 的编排层(纯计算分别在 strategy-lab.ts / captain.ts)。两者零模型。
 *   - Lab:每 30 分钟看一眼「距上次实验 ≥ 7 天,或累计 ≥ 10 笔新平仓」;同一 manifest 24h 内不重跑;paused 也跑(不花钱,只读缓存/公共 K 线)。
 *   - Captain:每 30 分钟看一眼「今天还没出简报」;手动可出。
 */
import { randomBytes } from 'node:crypto';
import type { DemoRuntime } from './runtime.js';
import { briefDue, buildDailyBrief, type DailyBrief } from './captain.js';
import { LAB_DEDUP_MS, LAB_EVERY_MS, LAB_MIN_NEW_CLOSED, scheduledLabDays, registerManifest, runExperiment, type ExperimentManifest, type ExperimentResult, type RunExperimentDeps } from './strategy-lab.js';
import { strategyContentHash, type StrategySpec } from './strategies.js';
import { runStrategyLoop } from './strategy-loop.js';

const TICK_MS = 30 * 60_000;
const KV_LAB_LAST = 'team.lab.last_experiment_at';
const KV_LAB_CLOSED_CURSOR = 'team.lab.closed_seen';

export interface TeamAgentOptions {
  runExperiment?: (m: ExperimentManifest, deps: RunExperimentDeps) => Promise<ExperimentResult>;
  now?: () => number;
}

export class TeamAgents {
  private timer: NodeJS.Timeout | null = null;
  private nextTick: number | null = null;
  nextCheckAt(): number | null { return this.timer ? this.nextTick : null; }
  private labRunning: Promise<unknown> | null = null;
  private readonly runExperimentImpl: (m: ExperimentManifest, deps: RunExperimentDeps) => Promise<ExperimentResult>;
  private readonly now: () => number;

  constructor(
    private readonly rt: DemoRuntime,
    opts: TeamAgentOptions = {},
  ) {
    this.runExperimentImpl = opts.runExperiment ?? runExperiment;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    this.nextTick = this.now() + TICK_MS;
    this.timer = setInterval(() => { this.nextTick = this.now() + TICK_MS; void this.tick().catch(() => {}); }, TICK_MS);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  private async tick(): Promise<void> {
    if (this.briefDue()) this.brief('timer');
    const d = this.labDecision();
    if (d.run) await this.runLab('timer').catch(() => {});
  }

  // ------------------------------------------------------------ Strategy Lab

  labIsRunning(): boolean {
    return this.labRunning !== null;
  }
  private labLastAt(): number | null {
    const v = this.rt.store.kvGet(KV_LAB_LAST);
    return v ? Number(v) : null;
  }
  private closedSinceCursor(): number {
    const seen = Number(this.rt.store.kvGet(KV_LAB_CLOSED_CURSOR) ?? '0');
    return this.rt.store.closedThreads(200).filter((t) => (t.closed_at ?? t.updated_at) > seen).length;
  }
  labDecision(): { run: boolean; reason: string; last_at: number | null; new_closed: number } {
    const last = this.labLastAt();
    const newClosed = this.closedSinceCursor();
    if (!this.rt.botEnabled('strategy_lab')) return { run: false, reason: 'Strategy Lab 已暂停', last_at: last, new_closed: newClosed };
    if (this.labRunning) return { run: false, reason: '实验在跑', last_at: last, new_closed: newClosed };
    if (last === null) return { run: true, reason: '从没跑过实验', last_at: last, new_closed: newClosed };
    if (newClosed >= LAB_MIN_NEW_CLOSED) return { run: true, reason: `累计 ${newClosed} 笔新平仓 ≥ ${LAB_MIN_NEW_CLOSED}`, last_at: last, new_closed: newClosed };
    if (this.now() - last >= LAB_EVERY_MS) return { run: true, reason: '距上次实验 ≥ 7 天', last_at: last, new_closed: newClosed };
    return { run: false, reason: `上次实验 ${Math.round((this.now() - last) / 3_600_000)}h 前,${newClosed} 笔新平仓`, last_at: last, new_closed: newClosed };
  }

  /** 注册 manifest → 跑 → 冻结结果进 bot_run → 交接 gate_captain。同一 manifest 24h 内重复调用直接返回上一次。 */
  runLab(reason: 'timer' | 'manual'): Promise<{ run_id: string; manifest: ExperimentManifest; result: ExperimentResult | null; skipped: string | null }> {
    if (this.labRunning) return this.labRunning as Promise<{ run_id: string; manifest: ExperimentManifest; result: ExperimentResult | null; skipped: string | null }>;
    this.rt.requireBot('strategy_lab');
    const p = this.runLabInner(reason).finally(() => {
      this.labRunning = null;
    });
    this.labRunning = p;
    return p;
  }

  /**
   * 09-07 Strategy Lab 自动闭环(workflow.lab_autopilot,零模型):
   *   1. 实验结果按精确版本写回 lab_stats(不碰 eval_stats);
   *   2. 参数探针:某个 head 的单参数拨一档后期望 ≥ 当前 +0.15R、两边样本都 ≥30 → 自动 createVersion 成 draft,并交接给 gate_captain;
   *      同一策略每次实验最多提一个;内容已存在(任一版本 content_hash 相同)不重复提;
   *   3. 数据态晋升:head 是 draft 且有 lab_stats → backtest;head 是 backtest 且 lab n≥20 期望>0 → shadow。paper 及以上永远人批。
   * 返回给交接摘要用的动作列表。
   */
  private labAutopilot(runId: string, result: ExperimentResult, now: number): string[] {
    const lib = this.rt.store.strategies;
    const actions: string[] = [];
    // 1. 写回 lab_stats
    for (const s of result.by_strategy) {
      lib.updateLabStats(s.strategy_id, s.version, { ...s.replay, ...(s.coverage ? { coverage: s.coverage } : {}), run_id: runId, at: now, symbols: s.symbols, setups: s.setups, n: s.n, win_rate: s.win_rate, expectancy_r: s.expectancy_r, total_r: s.total_r, note: '机械前瞻期望(漏斗法,零模型),不是含模型的回放成绩' });
    }
    // 2. Lab 探针队列(§1.3)先结:归因点名的候选值要按**本轮的 head 版本**判,不能等自动探针先建了新版本
    //    再回头找——那时 head 已经变了,队列项会永远停在 queued。
    const queue = this.consumeProbeQueue(result, now);
    actions.push(...queue.actions);
    // 3. 参数探针 → draft(同一策略这轮已经因队列提过版本的就跳过,一轮最多提一个)
    const MIN_N = 30;
    const MIN_GAIN_R = 0.15;
    const proposedThisRun = new Set<string>(queue.handled);
    for (const head of lib.list().filter((x) => x.status !== 'retired')) {
      const base = result.by_strategy.find((s) => s.strategy_id === head.id && s.version === head.version);
      if (!base) continue;
      const cands = (result.probes ?? [])
        .filter((p) => p.strategy_id === head.id && p.version === head.version && probeVerified(p.replay) && (p.selected_folds ?? 0) > 0)
        .sort((a, b) => (b.selected_folds ?? 0) - (a.selected_folds ?? 0) || a.param.localeCompare(b.param) || a.value - b.value);
      const best = cands[0];
      if (!best || proposedThisRun.has(head.id)) continue;
      // 先算这次提案的内容哈希:任一历史版本(比如上次提过、人没采)内容相同就不重复提。createVersion 只和 head 比。
      const patchedParams: StrategySpec['params'] = {};
      for (const [k, v] of Object.entries(head.params)) patchedParams[k] = k === best.param ? { ...v, value: best.value } : { ...v };
      const wouldBe = strategyContentHash({ name: head.name, horizon: head.horizon, family: head.family, trigger: head.trigger, checklist: head.checklist, rules: head.rules, params: patchedParams });
      const dup = lib.versions(head.id).find((v) => v.content_hash === wouldBe);
      if (dup) {
        this.rt.log('info', 'lab', `${head.id} 探针 ${best.param}=${best.value} 更好但与 v${dup.version}(${dup.status})内容相同,不重复提`);
        continue;
      }
      const r = lib.createVersion(head.id, { params: { [best.param]: best.value } }, { now });
      if (!r.spec) {
        this.rt.log('info', 'lab', `${head.id} 探针 ${best.param}=${best.value} 更好(${best.expectancy_r!.toFixed(2)}R vs ${(base.expectancy_r ?? 0).toFixed(2)}R)但没建版本:${r.error}`);
        continue;
      }
      proposedThisRun.add(head.id);
      this.rt.store.strategyEvents.append({ strategy_id: head.id, version: r.spec.version, at: now, who: 'lab', kind: 'version_created', from_status: null, to_status: 'draft', reason: `参数探针:${best.param} ${head.params[best.param]?.value} → ${best.value}`, evidence: { base_expectancy_r: base.expectancy_r, probe_expectancy_r: best.expectancy_r, base_n: base.n, probe_n: best.n } });
      const line = `${head.id} v${r.spec.version}(draft):${best.param} ${head.params[best.param]?.value} → ${best.value},机械期望 ${(base.expectancy_r ?? 0).toFixed(2)}R → ${best.expectancy_r!.toFixed(2)}R(${base.n}/${best.n} 笔)`;
      actions.push(`提案 ${line}`);
      this.rt.log('warn', 'lab', `自动提案:${line}`);
      this.rt.activity('workflow_changed', { level: 'warn', title: `Lab 提议 ${head.id} v${r.spec.version}:${best.param} → ${best.value}`, detail: `${line};是 draft,不会被 agent 用;去策略库看,认可就一路晋升`, data: { strategy_id: head.id, version: r.spec.version, run_id: runId } });
      this.rt.store.bots.handoff({
        handoff_id: `hof-lab-propose-${head.id}-${r.spec.version}`,
        run_id: runId,
        from_role: 'strategy_lab',
        to_role: 'gate_captain',
        kind: 'request',
        subject: { type: 'strategy_version', id: `${head.id}@${r.spec.version}` },
        summary: `Lab 提议新版本:${line}`,
        evidence_refs: [`strategy:${head.id}@${head.version}`, `bot-run:${runId}`],
        artifact_refs: [`artifact://bot-run/${runId}`],
        requested_output_schema: null,
        priority: 30,
        deadline_at: null,
        idempotency_key: `lab-propose:${head.id}:${r.spec.content_hash}`,
        payload: { strategy_id: head.id, version: r.spec.version, param: best.param, value: best.value, base_expectancy_r: base.expectancy_r, probe_expectancy_r: best.expectancy_r, n: best.n },
      });
    }
    // 4. 数据态晋升(只动 head;paper+ 不碰)
    const backend = this.rt.backend.kind;
    for (const raw of lib.list().flatMap(h => lib.versions(h.id).filter(v => v.version === h.version || v.health_by_backend?.[backend]))) {
      const scoped = raw.health_by_backend?.[backend];
      const fresh = { ...raw, status: scoped?.status ?? raw.status };
      if (fresh.status !== 'draft' && fresh.status !== 'backtest') continue;
      const to = fresh.status === 'draft' ? 'backtest' : 'shadow';
      if (fresh.status === 'draft' && !fresh.lab_stats) continue;
      const r = lib.promote(fresh.id, to, { version: fresh.version, ...(scoped ? { backend } : {}) });
      if (r.spec) {
        actions.push(`${fresh.id} v${fresh.version} ${fresh.status} → ${to}`);
        const lab = fresh.lab_stats ?? null;
        this.rt.store.strategyEvents.append({ strategy_id: fresh.id, version: fresh.version, at: now, who: 'lab', kind: 'promote', from_status: fresh.status, to_status: to, reason: `数据态晋升(Lab 漏斗;paper 及以上要人批)`, evidence: { lab_n: lab?.n ?? null, lab_expectancy_r: lab?.expectancy_r ?? null } });
        this.rt.log('info', 'lab', `自动晋升 ${fresh.id} v${fresh.version}:${fresh.status} → ${to}(数据态;paper 及以上要人批)`);
      }
    }
    // 5. 状态机一轮:影子数据够格就 shadow → paper,paper+ 连续劣化就退回 backtest(§1.2)。
    const loop = runStrategyLoop(this.rt.store, { backend: this.rt.backend.kind, active_ids: this.rt.workflow.active_strategies ?? [], now, log: (level, message) => this.rt.log(level, 'strategy', message) });
    for (const a of loop.actions) actions.push(`${a.strategy_id} v${a.version} ${a.from} → ${a.to}(${a.reason})`);
    this.rt.applyStrategyLoop(loop);
    if (actions.length) this.rt.emit('strategy.changed', { source: 'lab', run_id: runId });
    return actions;
  }

  /**
   * 探针队列结算:队列里的 (策略, 参数, 值) 在这一轮实验里有结果了就判一次。
   * 达标口径与自动探针一致(两边样本 ≥30、期望比现值高 ≥0.15R、胜率不掉超过 5 个点),
   * 达标 → `createVersion` 成 draft(**这才是落地**),不达标 → 关掉队列项并写明原因。
   */
  private consumeProbeQueue(result: ExperimentResult, now: number): { actions: string[]; handled: Set<string> } {
    const store = this.rt.store;
    const lib = store.strategies;
    const actions: string[] = [];
    const handled = new Set<string>();
    const MIN_N = 30;
    const MIN_GAIN_R = 0.15;
    for (const q of store.labProbes.queued(50)) {
      const head = lib.head(q.strategy_id);
      if (!head) {
        store.labProbes.resolve(q.id, 'rejected', `策略 ${q.strategy_id} 已不在库里`, now);
        continue;
      }
      const cell = (result.probes ?? []).find((p) => p.strategy_id === head.id && p.version === head.version && p.param === q.param && p.value === q.value);
      const base = result.by_strategy.find((s) => s.strategy_id === head.id && s.version === head.version);
      if (!cell || !base) continue; // 这轮没跑到它(比如 head 换版本了),留在队里等下一轮
      if (cell.expectancy_r === null || !probeVerified(cell.replay) || (cell.selected_folds ?? 0) < 1) {
        store.labProbes.resolve(q.id, 'rejected', `样本不足(现值 ${base.n} 笔 / 候选 ${cell.n} 笔,要 ${MIN_N})`, now);
        continue;
      }
      const gain = cell.expectancy_r - (base.expectancy_r ?? 0);
      if (!probeVerified(cell.replay)) {
        store.labProbes.resolve(q.id, 'rejected', `没达标:期望 ${(base.expectancy_r ?? 0).toFixed(2)}R → ${cell.expectancy_r.toFixed(2)}R(要 +${MIN_GAIN_R}R)`, now);
        continue;
      }
      const r = lib.createVersion(head.id, { params: { [q.param]: q.value } }, { now });
      if (!r.spec) {
        store.labProbes.resolve(q.id, 'rejected', `达标但没建版本:${r.error}`, now);
        continue;
      }
      store.labProbes.resolve(q.id, 'verified', `期望 ${(base.expectancy_r ?? 0).toFixed(2)}R → ${cell.expectancy_r.toFixed(2)}R,落成 v${r.spec.version}`, now);
      store.strategyEvents.append({ strategy_id: head.id, version: r.spec.version, at: now, who: 'attribution', kind: 'version_created', from_status: null, to_status: 'draft', reason: `归因提案经 Lab 验证:${q.param} ${head.params[q.param]?.value} → ${q.value}`, evidence: { base_expectancy_r: base.expectancy_r, probe_expectancy_r: cell.expectancy_r, base_n: base.n, probe_n: cell.n } });
      const line = `${head.id} v${r.spec.version}(draft):归因提案 ${q.param}=${q.value} 经 Lab 验证达标(${(base.expectancy_r ?? 0).toFixed(2)}R → ${cell.expectancy_r.toFixed(2)}R)`;
      actions.push(`提案 ${line}`);
      handled.add(head.id);
      this.rt.log('warn', 'lab', `探针队列落地:${line}`);
    }
    return { actions, handled };
  }

  private async runLabInner(reason: string): Promise<{ run_id: string; manifest: ExperimentManifest; result: ExperimentResult | null; skipped: string | null }> {
    const store = this.rt.store;
    const now = this.now();
    const specs = store.strategies.list().filter((s) => s.status !== 'retired');
    // 每条策略的全部版本都进实验(head 与前版并排,才看得出「改动有没有用」)。
    const allVersions = specs.flatMap((s) => store.strategies.versions(s.id));
    const manifest = registerManifest({ strategies: allVersions, symbols: this.rt.workflow.watchlist, timeframe: this.rt.workflow.timeframe, days: scheduledLabDays(allVersions), now });
    const recent = store.bots.runs({ role: 'strategy_lab', routine: 'experiment', limit: 20 }).find((r) => r.status === 'done' && r.input?.['manifest_hash'] === manifest.manifest_hash && now - r.started_at < LAB_DEDUP_MS);
    if (recent) {
      this.rt.log('info', 'lab', `同一 manifest ${manifest.manifest_hash} 24h 内已跑过(${recent.id}),不重复`);
      return { run_id: recent.id, manifest, result: (recent.result as unknown as ExperimentResult) ?? null, skipped: '24h 内同 manifest 已跑' };
    }
    const run = store.bots.startRun({ id: rid(), role: 'strategy_lab', routine: 'experiment', started_at: now, budget: { model: false, reason }, input: manifest as unknown as Record<string, unknown> });
    this.rt.emit('bots.changed', { role: 'strategy_lab', run_id: run.id });
    this.rt.log('info', 'lab', `实验开始(${reason}):${manifest.strategies.length} 个策略版本 × ${manifest.symbols.length} 币 × ${manifest.days} 天,manifest ${manifest.manifest_hash}`);
    try {
      // 09-12 §1.3:attribution 的 param 提案(lab_probe_queue)当成点名候选值一起跑,
      // 这样「某条归因说把 X 调到 Y」能在同一份数据上拿到与现值可比的期望,而不是靠人凭印象采纳。
      const probeValues: Record<string, { param: string; value: number }[]> = {};
      for (const q of reason === 'timer' ? [] : store.labProbes.queued(50)) {
        const head = store.strategies.head(q.strategy_id);
        if (!head) continue;
        const key = `${head.id}@${head.version}`;
        probeValues[key] = [...(probeValues[key] ?? []), { param: q.param, value: q.value }];
      }
      const result = await this.runExperimentImpl(manifest, { specs: allVersions, pause_ms: 150, probe: new Set(reason === 'timer' ? [] : specs.map((s) => `${s.id}@${s.version}`)), ...(Object.keys(probeValues).length ? { probe_values: probeValues } : {}), onProgress: (sym, done, total) => this.rt.emit('bots.changed', { role: 'strategy_lab', run_id: run.id, progress: { symbol: sym, done, total } }) });
      const top = result.by_strategy.slice(0, 3).map((s) => `${s.strategy_id}@v${s.version} ${s.expectancy_r === null ? 'n/a' : s.expectancy_r.toFixed(2)}R/${s.n}笔`).join('、');
      const summary = `${manifest.strategies.length - result.unmeasured.length}/${manifest.strategies.length} 版本 × ${manifest.symbols.length} 币:${top || '无 setup'}${result.unmeasured.length ? `;${result.unmeasured.length} 个非突破族版本量不出` : ''}${result.errors.length ? `;${result.errors.length} 币失败` : ''}`;
      store.bots.finishRun(run.id, { status: 'done', finished_at: this.now(), summary, result: result as unknown as Record<string, unknown> });
      store.kvSet(KV_LAB_LAST, String(now));
      store.kvSet(KV_LAB_CLOSED_CURSOR, String(now));
      const autopilot = this.rt.workflow.lab_autopilot ? this.labAutopilot(run.id, reason === 'timer' ? { ...result, probes: [] } : result, now) : [];
      store.bots.handoff({
        handoff_id: `hof-lab-${manifest.manifest_hash}`,
        run_id: run.id,
        from_role: 'strategy_lab',
        to_role: 'gate_captain',
        kind: 'result',
        subject: { type: 'strategy_experiment', id: run.id },
        summary: `研究记录:${summary}(机械期望,不是策略成绩)${autopilot.length ? `;自动闭环:${autopilot.join(';')}` : ';无晋升'}`,
        evidence_refs: manifest.strategies.map((s) => `strategy:${s.id}@${s.version}`),
        artifact_refs: [`artifact://bot-run/${run.id}`],
        requested_output_schema: null,
        priority: 20,
        deadline_at: null,
        idempotency_key: `experiment:${manifest.manifest_hash}:captain:v1`,
        payload: { manifest_hash: manifest.manifest_hash, by_strategy: result.by_strategy },
      });
      this.rt.log('info', 'lab', `实验完成:${summary}`);
      this.rt.emit('bots.changed', { role: 'strategy_lab', run_id: run.id });
      return { run_id: run.id, manifest, result, skipped: null };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      store.bots.finishRun(run.id, { status: 'failed', error: msg, finished_at: this.now() });
      this.rt.log('warn', 'lab', `实验失败:${msg}`);
      this.rt.emit('bots.changed', { role: 'strategy_lab', run_id: run.id });
      throw e;
    }
  }

  // ------------------------------------------------------------ Gate Captain

  private lastBrief() {
    return this.rt.store.bots.runs({ role: 'gate_captain', routine: 'daily_brief', limit: 1 })[0] ?? null;
  }
  briefDue(): boolean {
    return this.rt.botEnabled('gate_captain') && briefDue(this.lastBrief(), this.now());
  }
  latestBrief(): DailyBrief | null {
    return (this.lastBrief()?.result as unknown as DailyBrief | null) ?? null;
  }

  /** 出一份简报(零模型)。 */
  brief(reason: 'timer' | 'manual'): DailyBrief {
    this.rt.requireBot('gate_captain');
    const now = this.now();
    const brief = buildDailyBrief({ bots: this.rt.store.bots, alerts: this.rt.riskOpen, level: this.rt.riskLevel(), snapshot: this.rt.portfolioSnapshot, cards: this.rt.reviewer.cards(200), now });
    const run = this.rt.store.bots.startRun({ id: rid(), role: 'gate_captain', routine: 'daily_brief', started_at: now, budget: { model: false, reason }, input: { from: brief.from, to: brief.to } });
    this.rt.store.bots.finishRun(run.id, { status: 'done', finished_at: now, summary: brief.headline, result: brief as unknown as Record<string, unknown> });
    this.rt.activity('brief', { level: 'info', title: `值班简报:${brief.headline}`, data: { run_id: run.id } });
    this.rt.emit('bots.changed', { role: 'gate_captain', run_id: run.id });
    return brief;
  }
}

function rid(): string {
  return `run-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}
