/**
 * Radar 角色的编排层:把 screener.ts(纯计算)接到运行时——定时(短线 12h / 中线 72h / 周线 7d)、
 * 暂停跳过、bot_runs 记账、radar → gate_captain 的交接、提案应用(只改 watchlist)。
 *
 * 设计:docs/design/trading-swarm-bot-team-guide-2026-09-04.ipynb §11.1 与 docs/design/screener-radar-2026-09-05.md。
 *
 * 红线:
 *   - 这里没有任何一条路径能改 workflow 里除 `watchlist` 之外的字段(proposalPatch 只产出 watchlist)。
 *   - paused = 不调模型:定时筛选整轮跳过(公共 REST 也不打);手动筛选允许,但 brain=null。
 *   - 交接文本是 untrusted data,只记录、不构成授权。
 */
import { randomBytes } from 'node:crypto';
import type { BotRun } from './bots.js';
import type { DemoRuntime } from './runtime.js';
import {
  BRAIN_BUDGET_CNY,
  HORIZON_LABEL,
  HORIZON_SPECS,
  nextScreenAt,
  proposalPatch,
  runScreen as realRunScreen,
  SCREEN_HORIZONS,
  type RunScreenDeps,
  type RunScreenResult,
  type ScreenHorizon,
  type ScreenRow,
  type WatchCandidate,
} from './screener.js';
import type { Workflow } from './types.js';

export const WEEKLY_EVERY_MS = 7 * 86_400_000;
/** 暂停/关闭时定时器多久之后再来看一眼(不是筛选周期,只是「再检查」的间隔)。 */
export const RECHECK_MS = 30 * 60_000;
/** 开机后多久跑到期的筛选:让行情/账户先拉一轮;也保证测试进程(几秒就结束)不会碰到真实公共 REST。 */
const BOOT_DELAY_MS = 60_000;

export type ScreenReason = 'timer' | 'manual' | 'boot';

export interface HorizonSchedule {
  horizon: ScreenHorizon;
  label: string;
  every_ms: number;
  last_at: number | null;
  next_at: number | null;
  running: boolean;
  enabled: boolean;
  progress: { done: number; total: number } | null;
}

export interface RadarOptions {
  /** 测试注入:替换真实的 runScreen(它要打交易所公共 REST)。 */
  runScreen?: (horizon: ScreenHorizon, deps: RunScreenDeps) => Promise<RunScreenResult>;
  now?: () => number;
}

export class Radar {
  private timers: Partial<Record<ScreenHorizon, NodeJS.Timeout>> = {};
  private running: Partial<Record<ScreenHorizon, Promise<ScreenRow>>> = {};
  private progress: Partial<Record<ScreenHorizon, { done: number; total: number }>> = {};
  private readonly runScreenImpl: (horizon: ScreenHorizon, deps: RunScreenDeps) => Promise<RunScreenResult>;
  private readonly now: () => number;
  private stopped = false;

  constructor(
    private readonly rt: DemoRuntime,
    opts: RadarOptions = {},
  ) {
    this.runScreenImpl = opts.runScreen ?? realRunScreen;
    this.now = opts.now ?? (() => Date.now());
  }

  private get workflow(): Workflow {
    return this.rt.workflow;
  }

  everyMs(h: ScreenHorizon): number {
    if (h === 'short') return this.workflow.screener_short_every_ms;
    if (h === 'swing') return this.workflow.screener_swing_every_ms;
    return WEEKLY_EVERY_MS;
  }

  /** 上次**成功**筛选的完成时刻;从没跑过 → null。 */
  lastAt(h: ScreenHorizon): number | null {
    const rows = this.rt.store.screens.screens({ horizon: h, limit: 10 });
    const done = rows.find((r) => r.status === 'done');
    return done?.finished_at ?? null;
  }

  schedule(): HorizonSchedule[] {
    const now = this.now();
    return SCREEN_HORIZONS.map((h) => {
      const last = this.lastAt(h);
      const every = this.everyMs(h);
      const enabled = this.workflow.screener_enabled !== false && this.rt.botEnabled('radar');
      return {
        horizon: h,
        label: HORIZON_LABEL[h],
        every_ms: every,
        last_at: last,
        next_at: enabled ? nextScreenAt(last ?? 0, every, now) : null,
        running: Boolean(this.running[h]),
        enabled,
        progress: this.progress[h] ?? null,
      };
    });
  }

  isRunning(h: ScreenHorizon): boolean {
    return Boolean(this.running[h]);
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * 给每个周期上定时器;到期的(含从没跑过的)从开机 60 秒起**错开**跑(短线 60s、中线 120s、周线 180s)——
   * 三个周期同时起跑会把交易所公共 REST 打到限速:币安时代首轮实测 SKHYNIX 的 4h K 线就是这么丢的;
   * OKX 的 candles 是 40 次/2 秒/IP,且单页只有 300 根(深窗口要翻页 + history-candles 100 根/页),
   * 请求数比币安多,错峰照留。OKX 资产全集的开机检查在 30s(universe-okx.ts),也避开这三档。
   */
  start(): void {
    this.stopped = false;
    SCREEN_HORIZONS.forEach((h, i) => this.arm(h, BOOT_DELAY_MS * (i + 1)));
  }

  stop(): void {
    this.stopped = true;
    for (const h of SCREEN_HORIZONS) {
      const t = this.timers[h];
      if (t) clearTimeout(t);
      delete this.timers[h];
    }
  }

  /** workflow 的筛选字段变了 → 重新算每个周期的下一次。 */
  reschedule(): void {
    if (this.stopped) return;
    for (const h of SCREEN_HORIZONS) this.arm(h, 0);
  }

  private arm(h: ScreenHorizon, minDelayMs: number): void {
    const t = this.timers[h];
    if (t) clearTimeout(t);
    const dueAt = nextScreenAt(this.lastAt(h) ?? 0, this.everyMs(h), this.now());
    const delay = Math.max(minDelayMs, dueAt - this.now(), minDelayMs === 0 ? 1_000 : 0);
    this.timers[h] = setTimeout(() => void this.onTimer(h), Math.min(delay, 2 ** 31 - 1));
    this.timers[h]!.unref?.();
  }

  private async onTimer(h: ScreenHorizon): Promise<void> {
    if (this.stopped) return;
    const w = this.workflow;
    if (w.screener_enabled === false || !this.rt.botEnabled('radar')) {
      this.arm(h, RECHECK_MS);
      return;
    }
    if (w.paused || this.rt.isHalted) {
      // 暂停 = 到点不再调模型,也不打公共 REST。记一条 skipped 的 bot_run 让团队页看得见「为什么没跑」。
      this.rt.store.bots.finishRun(
        this.rt.store.bots.startRun({ id: runId(), role: 'radar', routine: `screen:${h}`, started_at: this.now(), budget: this.budget(w) }).id,
        { status: 'skipped', summary: w.paused ? '已暂停:跳过这轮筛选' : '紧急停止中:跳过这轮筛选', finished_at: this.now() },
      );
      this.rt.emit('bots.changed', { role: 'radar' });
      this.rt.log('info', 'radar', `${HORIZON_LABEL[h]} 筛选到点,${w.paused ? '已暂停' : '紧急停止中'},跳过;${Math.round(RECHECK_MS / 60_000)} 分钟后再看`);
      this.arm(h, RECHECK_MS);
      return;
    }
    try {
      await this.run(h, 'timer');
    } catch (e) {
      this.rt.log('warn', 'radar', `${HORIZON_LABEL[h]} 定时筛选失败:${(e as Error).message.slice(0, 200)}`);
    } finally {
      if (!this.stopped) this.arm(h, RECHECK_MS);
    }
  }

  private budget(w: Workflow): Record<string, unknown> {
    return { max_symbols: w.screener_max_symbols, max_cny: BRAIN_BUDGET_CNY, use_brain: w.screener_use_brain !== false && !w.paused, universe: w.screener_universe, expectancy: w.screener_expectancy === true };
  }

  // ------------------------------------------------------------ 一次筛选

  /**
   * 跑一次。同一周期同时只跑一个(第二个调用拿到同一个 promise)。
   * 暂停时手动仍可跑,但不调模型;定时调用在 onTimer 里已经被挡掉了。
   */
  run(h: ScreenHorizon, reason: ScreenReason): Promise<ScreenRow> {
    this.rt.requireBot('radar');
    const inflight = this.running[h];
    if (inflight) return inflight;
    const p = this.runInner(h, reason).finally(() => {
      delete this.running[h];
      delete this.progress[h];
    });
    this.running[h] = p;
    return p;
  }

  private async runInner(h: ScreenHorizon, reason: ScreenReason): Promise<ScreenRow> {
    const w = this.workflow;
    const store = this.rt.store;
    const startedAt = this.now();
    const useBrain = w.screener_use_brain !== false && !w.paused && !this.rt.isHalted;
    const run: BotRun = store.bots.startRun({ id: runId(), role: 'radar', routine: `screen:${h}`, started_at: startedAt, budget: { ...this.budget(w), reason } });
    this.rt.emit('bots.changed', { role: 'radar', run_id: run.id });
    this.rt.log('info', 'radar', `${HORIZON_LABEL[h]} 筛选开始(${reason};宇宙 ${w.screener_universe},上限 ${w.screener_max_symbols} 币,模型 ${useBrain ? '开' : '关'})`);

    let result: RunScreenResult;
    try {
      result = await this.runScreenImpl(h, {
        workflow: w,
        library: store.strategies,
        brain: useBrain ? this.rt.brainForRole('utility') : null,
        now: startedAt,
        pause_ms: 120,
        log: (level, message) => this.rt.log(level, 'radar', message),
        onProgress: (_symbol, done, total) => {
          this.progress[h] = { done, total };
          this.rt.emit('screener.changed', { screen_id: null, horizon: h, status: 'running', done, total });
        },
      });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      const failed: ScreenRow = {
        id: `scr-fail-${startedAt.toString(36)}`,
        horizon: h,
        started_at: startedAt,
        finished_at: this.now(),
        status: 'failed',
        universe: w.screener_universe,
        symbols: [],
        errors: [],
        run_id: run.id,
        handoff_id: null,
        proposal: null,
        brain: null,
        cost_cny: 0,
        error: msg,
      };
      store.screens.saveScreen(failed);
      store.bots.finishRun(run.id, { status: 'failed', error: msg, finished_at: failed.finished_at! });
      this.rt.activity('screen_failed', { level: 'warn', title: `${HORIZON_LABEL[h]} 筛选失败`, detail: msg, data: { screen_id: failed.id, horizon: h } });
      this.rt.emit('screener.changed', { screen_id: failed.id, horizon: h, status: 'failed' });
      this.rt.emit('bots.changed', { role: 'radar', run_id: run.id });
      throw e;
    }

    const { screen, candidates, proposal } = result;
    screen.run_id = run.id;
    // 交接:radar → gate_captain,kind=result。幂等键按 screen id,重跑不重复交接。
    const handoff = store.bots.handoff({
      handoff_id: `hof-${screen.id.slice(4)}`,
      run_id: run.id,
      from_role: 'radar',
      to_role: 'gate_captain',
      kind: 'result',
      subject: { type: 'screen', id: screen.id },
      summary: `${HORIZON_LABEL[h]} 筛选:${proposal.symbols.length ? `建议观察 ${proposal.symbols.join('/')}` : '没有契合度够高的候选'}(筛了 ${screen.symbols.length} 币${screen.errors.length ? `,${screen.errors.length} 个失败` : ''})`,
      evidence_refs: candidates.slice(0, proposal.k).map((c) => `candidate:${c.symbol}:${c.strategy_id}`),
      artifact_refs: [`artifact://screen/${screen.id}`],
      requested_output_schema: null,
      priority: 40,
      deadline_at: startedAt + HORIZON_SPECS[h].ttl_ms,
      idempotency_key: `screen:${screen.id}:gate_captain:v1`,
      payload: { proposal: proposal as unknown as Record<string, unknown>, top: candidates.slice(0, proposal.k).map((c) => ({ symbol: c.symbol, strategy_id: c.strategy_id, fit_score: c.fit_score })) },
    });
    screen.handoff_id = handoff.handoff_id;
    store.screens.saveScreen(screen);
    store.screens.saveCandidates(candidates);
    store.bots.finishRun(run.id, {
      status: 'done',
      cost_cny: screen.cost_cny,
      summary: handoff.summary,
      finished_at: screen.finished_at ?? this.now(),
    });

    const top = candidates.slice(0, 5).map((c) => `${c.symbol} ${c.fit_score.toFixed(2)}`).join('、');
    this.rt.activity('screen_done', {
      level: 'info',
      title: `${HORIZON_LABEL[h]} 筛选完成:${screen.symbols.length} 币,前 ${Math.min(5, candidates.length)}:${top || '无候选'}`,
      detail: `${proposal.note}${screen.brain?.used ? `;模型 ${screen.brain.model ?? ''} ¥${(screen.cost_cny ?? 0).toFixed(3)}${screen.brain.dropped_lines ? `,丢 ${screen.brain.dropped_lines} 行` : ''}` : ';未调模型'}`,
      data: { screen_id: screen.id, horizon: h, handoff_id: handoff.handoff_id, cost_cny: screen.cost_cny },
    });
    this.rt.emit('screener.changed', { screen_id: screen.id, horizon: h, status: 'done' });
    this.rt.emit('bots.changed', { role: 'radar', run_id: run.id, handoff_id: handoff.handoff_id });

    if (w.screener_apply === 'auto' && proposal.symbols.length) {
      const r = this.apply(screen.id, 'auto');
      this.rt.log('info', 'radar', `自动应用提案:${r.before.join('/')} → ${r.after.join('/')}`);
    }
    return screen;
  }

  // ------------------------------------------------------------ 应用

  /**
   * 把一次筛选的提案落到 workflow。**只有 watchlist**(proposalPatch 的类型就只有这一个键),
   * 风险/杠杆/执行后端/策略启用一个字都不碰;交接顺手标已阅。
   */
  apply(screenId: string, by: 'user' | 'auto', pick?: string[] | null): { workflow: Workflow; before: string[]; after: string[] } {
    const screen = this.rt.store.screens.screen(screenId);
    if (!screen) throw new Error(`没有筛选 ${screenId}`);
    if (!screen.proposal) throw new Error('这次筛选没有提案');
    if (screen.status !== 'done') throw new Error(`筛选状态是 ${screen.status},不能应用`);
    // 每日全市场扫描(horizon='daily',universe-okx.ts)不在 HORIZON_SPECS 里,按 25h 有效期算。
    const ttl = screen.started_at + (HORIZON_SPECS[screen.horizon]?.ttl_ms ?? 25 * 3_600_000);
    if (this.now() > ttl && by === 'auto') throw new Error('提案已过期,自动应用拒绝');
    const before = [...this.workflow.watchlist];
    const patch: { watchlist: string[] } = proposalPatch(screen.proposal, this.workflow.watchlist_max, by === 'user' ? pick : null, before);
    const { workflow, errors } = this.rt.setWorkflow(patch);
    if (errors.length) throw new Error(`应用失败:${errors.join('; ')}`);
    this.rt.store.kvSet('radar.applied_screen', screen.id);
    if (screen.handoff_id) this.rt.store.bots.ack(screen.handoff_id, this.now());
    this.rt.emit('bots.changed', { handoff_id: screen.handoff_id });
    this.rt.log('info', 'radar', `提案已应用(${by}):watchlist ${before.join('/')} → ${workflow.watchlist.join('/')}`);
    return { workflow, before, after: [...workflow.watchlist] };
  }

  /** 给 UI:某次筛选的候选行。 */
  candidates(screenId: string): WatchCandidate[] {
    return this.rt.store.screens.candidates(screenId);
  }
}

function runId(): string {
  return `run-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}
