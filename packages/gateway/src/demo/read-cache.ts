/** 只读视图的 stale-while-revalidate。写操作和交易判断不得使用此缓存。 */
export interface ReadCacheMeta {
  fetched_at: number | null;
  stale: boolean;
  refreshing: boolean;
  state: 'loading' | 'ready' | 'error';
  error: string | null;
}
export class ReadCache<T> {
  private value: T | undefined;
  private fetchedAt: number | null = null;
  private attemptedAt: number | null = null;
  private pending: Promise<void> | null = null;
  private error: string | null = null;
  private generation = 0;
  constructor(private readonly ttlMs = 60_000, private readonly retryMs = 15_000) {}
  invalidate(): void { this.generation++; this.fetchedAt = null; this.attemptedAt = null; this.value = undefined; }
  read(loader: () => Promise<T>, fallback: T, now = Date.now()): { value: T; cache: ReadCacheMeta } {
    const stale = this.fetchedAt === null || now - this.fetchedAt >= this.ttlMs;
    if (stale && !this.pending && (this.attemptedAt === null || now - this.attemptedAt >= this.retryMs)) {
      const generation = this.generation;
      this.attemptedAt = now;
      // 微任务中启动，HTTP 同步路径只取已有值；同一视图最多一个刷新。
      this.pending = Promise.resolve().then(loader).then(value => {
        if (generation !== this.generation) return;
        this.value = value; this.fetchedAt = Date.now(); this.error = null;
      }, error => {
        if (generation === this.generation) this.error = String(error instanceof Error ? error.message : error).slice(0, 500);
      }).finally(() => { this.pending = null; });
    }
    return { value: this.value ?? fallback, cache: { fetched_at: this.fetchedAt, stale, refreshing: this.pending !== null, state: this.error ? 'error' : this.fetchedAt === null ? 'loading' : 'ready', error: this.error } };
  }
}
