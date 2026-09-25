// One brain call at a time (docs/demo/v2-agent-loop.md §1). Jobs are keyed so a burst of events for the
// same thread/symbol collapses into one pending job; FIFO otherwise.

import type { QueueView } from './types.js';

export interface Job {
  key: string;
  kind: 'scan' | 'review' | 'info' | 'chat' | 'manual';
  symbol: string | null;
  run: () => Promise<void>;
}

export class BrainQueue {
  private pending: Job[] = [];
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
   * at the head of the pending list (the user's chat turn should not wait behind six scans); the job
   * currently running is never interrupted.
   */
  enqueue(job: Job, opts: { priority?: boolean } = {}): boolean {
    if (this.running?.key === job.key || this.pending.some((j) => j.key === job.key)) return false;
    if (opts.priority) this.pending.unshift(job);
    else this.pending.push(job);
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
