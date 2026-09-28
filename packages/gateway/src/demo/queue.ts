import { demoContext } from './public-demo.js';
// One brain call at a time (docs/demo/v2-agent-loop.md §1). Jobs are keyed so a burst of events for the
// same thread/symbol collapses into one pending job; FIFO otherwise.

import type { QueueView } from './types.js';

export interface Job {
  key: string;
  kind: 'scan' | 'review' | 'info' | 'chat' | 'manual';
  symbol: string | null;
  run: () => Promise<void>;
}

/** 同 key 已折叠,不同 key 的积压上限;超出直接丢弃(下一次 K 线收盘会再入队)。 */
const MAX_PENDING = 200;

export class BrainQueue {
  private pending: (Job & { priority: boolean })[] = [];
  private running: Job | null = null;
  private onChange: (v: QueueView) => void;

  constructor(onChange: (v: QueueView) => void) {
    this.onChange = onChange;
  }

  private step: QueueView['running'] extends infer R ? (R extends { step?: infer S } ? S : never) : never = null;
  private episodeId: string | null = null;

  view(): QueueView {
    return { pending: this.pending.length, running: this.running ? { kind: this.running.kind, symbol: this.running.symbol, step: this.step ?? null, episode_id: this.episodeId } : null };
  }

  /** Called by the running job to report progress (surfaces in queue.state for the UI). */
  progress(step: NonNullable<QueueView['running']>['step'], episodeId: string | null = null): void {
    this.step = step ?? null;
    if (episodeId) this.episodeId = episodeId;
    this.onChange(this.view());
  }

  /**
   * Returns false if an identical key is already queued or running (deduped). `priority` puts the job
   * ahead of ordinary jobs (the user's chat turn should not wait behind six scans). 同优先级仍按
   * 入队顺序,连续对话不能倒序;正在运行的任务不受影响。
   */
  enqueue(job: Job, opts: { priority?: boolean } = {}): boolean {
    if (this.running?.key === job.key || this.pending.some((j) => j.key === job.key)) return false;
    if (this.pending.length >= MAX_PENDING) return false;
    // 公网演示:排队任务沿用入队时的访客上下文,模型花费记到发起的访客头上。
    const context = demoContext.getStore();
    if (context) {
      const run = job.run;
      job = { ...job, run: () => demoContext.run(context, run) };
    }
    const next = { ...job, priority: opts.priority === true };
    const ordinary = this.pending.findIndex((j) => !j.priority);
    if (next.priority && ordinary >= 0) this.pending.splice(ordinary, 0, next);
    else this.pending.push(next);
    this.onChange(this.view());
    void this.drain();
    return true;
  }

  isBusy(key: string): boolean {
    return this.running?.key === key || this.pending.some((j) => j.key === key);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const next = this.pending.shift();
    if (!next) return;
    this.running = next;
    this.step = null;
    this.episodeId = null;
    this.onChange(this.view());
    try {
      await next.run();
    } catch {
      // run() is expected to handle/log its own errors; never let one job kill the queue
    } finally {
      this.running = null;
      this.step = null;
      this.episodeId = null;
      this.onChange(this.view());
      void this.drain();
    }
  }
}
