// 写入端日志合并(规则见 log-policy.ts):同一 key 在窗口内只写一行,后续只累加 repeat_count / last_seen_at。
// 合并窗口不跨 UTC 日,方便清理时「每天每 key 一行摘要」直接落在已有行上。
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { logPolicy } from './log-policy.js';
import { envInt } from './ops-config.js';
import type { LogLine } from './types.js';

const DAY_MS = 86_400_000;
const MAX_OPEN_WINDOWS = 2048;
/** 合并中的行至少每分钟回写一次计数,崩溃最多丢一分钟的计数(明细本来就不存)。 */
const FLUSH_EVERY_MS = 60_000;

interface Window { id: number; start: number; last: number; count: number; saved: number; savedAt: number }

export class LogWriter {
  private readonly windows = new Map<string, Window>();
  private readonly windowMs = envInt('TG_LOG_DEDUP_MS', 300_000, 1000);
  private readonly insert: StatementSync;
  private readonly bump: StatementSync;

  constructor(db: DatabaseSync) {
    this.insert = db.prepare('INSERT INTO demo_logs(at, level, scope, message, json, last_seen_at, ops_noise, ops_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.bump = db.prepare('UPDATE demo_logs SET repeat_count = ?, last_seen_at = ? WHERE id = ?');
  }

  /** 返回 true = 写了新行(调用方照常广播/打印);false = 并入了已有行。 */
  write(line: LogLine): boolean {
    const json = line.data === undefined ? null : JSON.stringify(line.data);
    const policy = logPolicy({ level: line.level, scope: line.scope, message: line.message, json });
    const prior = policy.key ? this.windows.get(policy.key) : undefined;
    if (prior && this.sameWindow(prior, line.at)) {
      prior.count++;
      prior.last = line.at;
      if (line.at - prior.savedAt >= FLUSH_EVERY_MS) this.save(prior);
      return false;
    }
    if (prior) this.save(prior);
    const row = this.insert.run(line.at, line.level, line.scope, line.message, json, line.at, policy.noise ? 1 : 0, policy.key);
    if (policy.key) this.open(policy.key, { id: Number(row.lastInsertRowid), start: line.at, last: line.at, count: 1, saved: 1, savedAt: line.at });
    return true;
  }

  flush(): void {
    for (const w of this.windows.values()) this.save(w);
  }

  private sameWindow(w: Window, at: number): boolean {
    return at >= w.start && at - w.start < this.windowMs && Math.floor(at / DAY_MS) === Math.floor(w.start / DAY_MS);
  }

  private open(key: string, w: Window): void {
    this.windows.delete(key);
    if (this.windows.size >= MAX_OPEN_WINDOWS) {
      const oldestKey = this.windows.keys().next().value!;
      this.save(this.windows.get(oldestKey)!);
      this.windows.delete(oldestKey);
    }
    this.windows.set(key, w);
  }

  private save(w: Window): void {
    if (w.count === w.saved) return;
    this.bump.run(w.count, w.last, w.id);
    w.saved = w.count;
    w.savedAt = w.last;
  }
}
