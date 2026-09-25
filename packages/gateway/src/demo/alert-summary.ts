/** 面向活动流/模型的错误摘要;底层审计日志和订单回执仍逐条保留。 */
export interface Observations { observed_count?: number; first_seen_at?: number; last_seen_at?: number }
export function collapseObservations<T extends { at: number } & Observations>(rows: T[], key: (row: T) => string | null): (T & Observations)[] {
  const out: (T & Observations)[] = [];
  const groups = new Map<string, T & Observations>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) { out.push(row); continue; }
    const prev = groups.get(k);
    if (!prev) {
      const first = { ...row, observed_count: row.observed_count ?? 1, first_seen_at: row.first_seen_at ?? row.at, last_seen_at: row.last_seen_at ?? row.at };
      groups.set(k, first); out.push(first);
    } else {
      prev.observed_count = (prev.observed_count ?? 1) + (row.observed_count ?? 1);
      prev.first_seen_at = Math.min(prev.first_seen_at ?? prev.at, row.first_seen_at ?? row.at);
      prev.last_seen_at = Math.max(prev.last_seen_at ?? prev.at, row.last_seen_at ?? row.at);
    }
  }
  return out;
}
export function errorKind(message: string): string {
  return /session limit/i.test(message) ? 'session_limit' : /timeout|超时/i.test(message) ? 'timeout' : /ECONN\w+|fetch failed|网络错误/i.test(message) ? 'transport' : /HTTP (\d+)/.exec(message)?.[0] ?? message.replace(/\d+(?:\.\d+)?/g, '#');
}
