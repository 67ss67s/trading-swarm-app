/**
 * 进化方格的纯逻辑(不依赖 React / DOM,test/evolution.test.ts 覆盖):
 * 日期补齐、按月分组(Solana uptime 样式:每月一块、7 列、周一起)、good 占比、颜色映射、键盘移动。
 * 日期一律按 UTC 日(契约 §四),字符串 YYYY-MM-DD。
 */
import type { EvoDay, EvoStatus } from '@/api/evolution';

export const STATUS_ORDER: readonly EvoStatus[] = ['good', 'ok', 'bad', 'none'];

/** 颜色走 CSS 变量,缺省回退到主题 token(--up / --warn / --down / --muted-foreground);楼层在祖先上整组覆盖成 --of-*。 */
export const STATUS_VAR: Record<EvoStatus, string> = {
  good: 'var(--evo-good, var(--up))',
  ok: 'var(--evo-ok, var(--warn))',
  bad: 'var(--evo-bad, var(--down))',
  none: 'var(--evo-none, color-mix(in oklab, var(--muted-foreground) 24%, transparent))',
};

export function statusColor(status: EvoStatus): string {
  return STATUS_VAR[status] ?? STATUS_VAR.none;
}

const DAY_MS = 86_400_000;

function parseUtc(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function fmtUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function todayUtc(now: number = Date.now()): string {
  return fmtUtc(now);
}

export function addDays(date: string, n: number): string {
  return fmtUtc(parseUtc(date) + n * DAY_MS);
}

/** from..to 含两端;from > to 返回空 */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = parseUtc(to);
  for (let ms = parseUtc(from); ms <= end && out.length < 3700; ms += DAY_MS) out.push(fmtUtc(ms));
  return out;
}

/** 周一 = 0 … 周日 = 6 */
export function weekdayMon0(date: string): number {
  return (new Date(parseUtc(date)).getUTCDay() + 6) % 7;
}

export function blankDay(date: string): EvoDay {
  return { date, status: 'none', score: null, headline: null };
}

/** 把稀疏的 days 补成 from..to 的连续序列,缺的日子是灰格 */
export function fillDays(days: readonly EvoDay[], from: string, to: string): EvoDay[] {
  const by = new Map(days.map((d) => [d.date, d]));
  return dateRange(from, to).map((date) => by.get(date) ?? blankDay(date));
}

/** 截止 end(含)的最近 n 天;end 缺省取 days 里最晚的一天,再缺省取今天(UTC) */
export function lastNDays(days: readonly EvoDay[], n: number, end?: string | null): EvoDay[] {
  const last = end || days.reduce<string | null>((m, d) => (m === null || d.date > m ? d.date : m), null) || todayUtc();
  return fillDays(days, addDays(last, -(Math.max(1, n) - 1)), last);
}

export interface StatusCounts {
  good: number;
  ok: number;
  bad: number;
  none: number;
}

export function countStatuses(days: readonly EvoDay[]): StatusCounts {
  const c: StatusCounts = { good: 0, ok: 0, bad: 0, none: 0 };
  for (const d of days) c[d.status] = (c[d.status] ?? 0) + 1;
  return c;
}

/** good 占比 = good / 已结算天数(good+ok+bad);一天都没结算返回 null(灰格本身就是信号,不算成 0%) */
export function goodShare(c: StatusCounts): number | null {
  const settled = c.good + c.ok + c.bad;
  return settled > 0 ? c.good / settled : null;
}

export interface MonthBlock {
  /** 'YYYY-MM' */
  key: string;
  year: number;
  month: number;
  /** 前面按周一起补 null 占位,之后是这个月落在范围内的日子(按日期升序) */
  cells: (EvoDay | null)[];
  counts: StatusCounts;
  goodShare: number | null;
}

/** 连续日序列 → 按月分块;每块首日按星期对齐(周一起),块内 7 列 */
export function groupByMonth(days: readonly EvoDay[]): MonthBlock[] {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const blocks: MonthBlock[] = [];
  let cur: MonthBlock | null = null;
  for (const d of sorted) {
    const key = d.date.slice(0, 7);
    if (!cur || cur.key !== key) {
      const parts: number[] = key.split('-').map(Number);
      cur = { key, year: parts[0] ?? 0, month: parts[1] ?? 0, cells: Array.from({ length: weekdayMon0(d.date) }, () => null), counts: { good: 0, ok: 0, bad: 0, none: 0 }, goodShare: null };
      blocks.push(cur);
    }
    cur.cells.push(d);
    cur.counts[d.status] += 1;
  }
  for (const b of blocks) b.goodShare = goodShare(b.counts);
  return blocks;
}

/** 方向键在一维序列上的落点(月块里上下 = ±7 天);越界夹住 */
export function moveIndex(index: number, key: string, len: number, cols = 7): number | null {
  if (len <= 0) return null;
  let next: number;
  switch (key) {
    case 'ArrowLeft':
      next = index - 1;
      break;
    case 'ArrowRight':
      next = index + 1;
      break;
    case 'ArrowUp':
      next = index - cols;
      break;
    case 'ArrowDown':
      next = index + cols;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = len - 1;
      break;
    default:
      return null;
  }
  return Math.min(len - 1, Math.max(0, next));
}

/** 从 hash(`#evolution?role=radar&date=2026-09-20&tab=memory`)里读进化页参数;#memory 落到记忆标签 */
export function parseEvolutionHash(hash: string): { tab: 'grid' | 'memory'; role: string | null; date: string | null } {
  const raw = hash.replace(/^#/, '');
  const [page = '', query = ''] = raw.split('?');
  const q = new URLSearchParams(query);
  const role = q.get('role');
  const date = q.get('date');
  const tab = page === 'memory' || q.get('tab') === 'memory' ? 'memory' : 'grid';
  return { tab, role: role && /^[a-z_]+$/.test(role) ? role : null, date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null };
}
