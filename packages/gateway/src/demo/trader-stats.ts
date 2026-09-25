/**
 * 跟单 session 的**权重层**:本机 8794 `GET /api/copytrading/trader-stats` 每小时拉一次,
 * 换成一个 0–1 的仓位倍数。设计 `docs/design/trader-follow-2026-09-12.md` §2「权重」;
 * 接口 `docs/research/bridge-and-stats-api-2026-09-12.md` §B.4/§C.2。
 *
 * 硬规则:
 * - **对 8794 只读**,只打这一个端点;不改它任何配置,不拿它的 key(AGENTS.md 第 6 条)。
 * - 权重只影响**仓位与默认模式**,不影响触发本身(设计 §0)。
 * - `win_rate` 是百分数(63.79),不是 0.63;`max_drawdown_pct` 是**正数**表示跌幅。两边符号约定不同,
 *   在这里统一,不留给调用方。
 * - 胜率分母只算 `resolved`(`tp|sl|signal_close|flipped`);`open`/`no_fill`/`awaiting_fill` 不进分母
 *   —— 这是 8794 自己的口径,不重算。
 * - **拉不到就用 `manual_weight` 并标过期**(设计 §2);不猜、不沿用一个说不清多久以前的数。
 */

import type { FollowFetch, FollowKv } from './trader-feed.js';

export const TRADER_STATS_KEY = 'follow.stats';
/**
 * 本端点的**统计窗口**(复审 P2-04)。`/api/copytrading/trader-stats` 是**全量**聚合,
 * 不分窗口(接口说明书 §B.3:`window` 只有 `/api/leaderboard` 才吃)。设计里写的「近 90 天」
 * 与实际口径不符 —— 这里如实标成 `all`,前端按这个字段显示,不许再写「近 90 天」。
 * 真要 90 天得改对接 `/api/leaderboard?window=90d`,那是另一个端点(留作后续)。
 */
export const TRADER_STATS_WINDOW = 'all' as const;
/** 每小时一次(设计 §1)。 */
export const TRADER_STATS_REFRESH_MS = 3_600_000;
/** 超过这个岁数就算「统计过期」,前端要标。 */
export const TRADER_STATS_STALE_MS = 3 * 3_600_000;

/** 权重三档的阈值(默认值即设计 §2 的三档;进设置可改)。 */
export interface WeightThresholds {
  /** 胜率(百分数)达到这个数且回撤够小 → 满倍。 */
  win_rate_good_pct: number;
  /** 回撤(正数百分比)不超过这个数算「够小」。 */
  dd_good_pct: number;
  /** 回撤超过这个数 → 半倍。 */
  dd_bad_pct: number;
  /** 三档的倍数。 */
  mult_good: number;
  mult_mid: number;
  mult_bad: number;
}

export const DEFAULT_WEIGHT_THRESHOLDS: WeightThresholds = {
  win_rate_good_pct: 55,
  dd_good_pct: 15,
  dd_bad_pct: 30,
  mult_good: 1,
  mult_mid: 0.75,
  mult_bad: 0.5,
};

export interface TraderStatsRow {
  trader: string;
  /** 已结算笔数(8794 `resolved`);不含在途/未成交。 */
  resolved: number;
  /** 百分数(63.79 = 63.79%);算不出为 null。 */
  win_rate: number | null;
  /** 正数 = 跌幅(与 8794 同符号)。 */
  max_drawdown_pct: number | null;
  total_return_pct: number | null;
  expectancy_r: number | null;
  profit_factor: number | null;
  /** 8794 不产出夏普(全仓库 grep 零命中);要夏普得改对接 strategy-public-api。 */
  sharpe: null;
  /** 拉到这份数的本地时刻(响应体自己不带 updated_at,不臆造服务端字段)。 */
  updated_at: number;
}

export interface TraderStatsSnapshot {
  rows: TraderStatsRow[];
  /** 这份数字的窗口口径(见 {@link TRADER_STATS_WINDOW});固定 `all`。 */
  window?: string;
  fetched_at: number;
  /** 拉取失败时的原因;成功为 null。 */
  error: string | null;
}

/**
 * `auto_mult`:8794 近 90 天 `win_rate` 与 `max_drawdown` 分三档
 * (≥55% 且 dd ≤15% → 1.0;dd > 30% → 0.5;其余 0.75)。
 * 统计缺失 / 样本不足 → 返回 null(调用方退回 manual_weight 并标过期)。
 */
/** 够不够样本给权重。低于它的统计不足以支撑「给多大仓」这个判断(8794 排名门槛同款)。 */
export const MIN_RESOLVED_FOR_WEIGHT = 5;

export function autoMult(row: TraderStatsRow | null | undefined, th: WeightThresholds = DEFAULT_WEIGHT_THRESHOLDS): number | null {
  if (!row) return null;
  const wr = row.win_rate;
  const ddRaw = row.max_drawdown_pct;
  // 缺失 ≠ 0(复审 P1-13):第一版 `Number(null)` → 0,于是「没有回撤数据」被读成「回撤 0%」拿满档。
  if (wr === null || ddRaw === null) return null;
  // 样本不足:三笔单的 100% 胜率不是胜率。
  if (!(row.resolved >= MIN_RESOLVED_FOR_WEIGHT)) return null;
  // 胜率越界 = 坏数据(8794 给的是 0–100 的百分数)。
  if (wr < 0 || wr > 100) return null;
  // 回撤**符号统一**:8794 正数表跌幅,strategy-public-api 负数表跌幅。第一版把 -40 当成
  // 「dd ≤ 15」给了满档 —— 一个负号就能把爆过仓的人升成满仓。
  const dd = Math.abs(ddRaw);
  // 永远不放大仓位:这是折扣系数,设置里填 2 也只按 1 算。
  const clamp = (m: number): number => Math.min(1, Math.max(0, m));
  // 顺序要紧:先判「差」再判「好」—— 高胜率高回撤是爆仓型曲线,不能因为胜率好就给满倍。
  if (dd > th.dd_bad_pct) return clamp(th.mult_bad);
  if (wr >= th.win_rate_good_pct && dd <= th.dd_good_pct) return clamp(th.mult_good);
  return clamp(th.mult_mid);
}

export interface WeightView {
  trader: string;
  manual_weight: number;
  auto_mult: number | null;
  /** `manual_weight × auto_mult`;统计不可用时 = `min(manual_weight, STALE_WEIGHT_CAP)`。 */
  weight: number;
  /** true = 统计拉不到 / 太旧 / 样本不足,前端要标「统计过期」。 */
  stale: boolean;
  /** true = 因为统计不可用,权重被 `STALE_WEIGHT_CAP` 压到了 manual_weight 以下(前端要说明为什么变小)。 */
  stale_capped: boolean;
  stats: TraderStatsRow | null;
}

/**
 * 统计不可用时的**绝对降级上限**(P1-13)。
 *
 * 设计原文是「拉不到就用 manual_weight」。按钱路标准那是反的:一次 HTTP 500 不该让风险预算变大。
 */
export const STALE_WEIGHT_CAP = 0.5;

/**
 * 统计不可用时的权重:`min(manual_weight, STALE_WEIGHT_CAP, 最近一次有效权重)`(二审 P1-13)。
 *
 * 只有绝对上限 0.5 是不够的 —— 二审给的反例:`manual=0.4`、`mult_bad=0.5` 时正常权重是 0.2,
 * 统计一失败就变成 `min(0.4, 0.5) = 0.4`,**翻倍**。所以还要带上「最近一次算出来的有效权重」
 * 当天花板:故障状态下的风险预算永远不高于最后一次说得清的那个数。
 *
 * `lastEffective` 由调用方持久化(runtime 存 kv `follow.weight_ceiling`);没有历史记录时只用前两项。
 */
export function staleWeightOf(manual: number, lastEffective: number | null): number {
  const candidates = [manual, STALE_WEIGHT_CAP];
  if (lastEffective !== null && Number.isFinite(lastEffective) && lastEffective >= 0) candidates.push(lastEffective);
  return round4(Math.min(...candidates));
}

export function weightFor(
  trader: string,
  manualWeight: number,
  snapshot: TraderStatsSnapshot | null,
  th: WeightThresholds = DEFAULT_WEIGHT_THRESHOLDS,
  now = Date.now(),
  lastEffective: number | null = null,
): WeightView {
  // manual_weight 本身也钳在 [0,1]:它是折扣,不是杠杆。
  const manual = Number.isFinite(manualWeight) && manualWeight >= 0 ? Math.min(1, manualWeight) : 0;
  const fresh = snapshot !== null && snapshot.error === null && now - snapshot.fetched_at <= TRADER_STATS_STALE_MS;
  const row = fresh ? snapshot.rows.find((r) => r.trader === trader) ?? null : null;
  const mult = fresh ? autoMult(row, th) : null;
  if (mult === null) {
    const capped = staleWeightOf(manual, lastEffective);
    return { trader, manual_weight: manual, auto_mult: null, weight: capped, stale: true, stale_capped: capped < manual, stats: row };
  }
  return { trader, manual_weight: manual, auto_mult: mult, weight: round4(manual * mult), stale: false, stale_capped: false, stats: row };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * 数值读取:**缺失与 0 是两件事**(复审 P1-13)。
 * `Number(null)` 是 0、`Number('')` 也是 0 —— 第一版因此把「没有回撤数据」读成「回撤 0%」,
 * 于是 `dd <= 15` 成立、拿到满档权重 1.0。这里只认真的数字,其余一律 null。
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 8794 响应 → 内部行。响应形状是 `{ by_source: { <trader>: {...} } }`(`trader-stats` 是纯 aggregate),
 * 也容忍 `{ traders: [ { source, ... } ] }`(leaderboard 同款形状),两边都吃。
 */
export function parseTraderStats(body: unknown, fetchedAt: number): TraderStatsRow[] {
  const out: TraderStatsRow[] = [];
  const push = (trader: string, rec: Record<string, unknown>): void => {
    if (!trader.trim()) return;
    out.push({
      trader: trader.trim(),
      resolved: Math.max(0, Math.round(num(rec['resolved']) ?? 0)),
      win_rate: num(rec['win_rate']),
      max_drawdown_pct: num(rec['max_drawdown_pct']),
      total_return_pct: num(rec['total_return_pct']),
      expectancy_r: num(rec['expectancy_r'] ?? rec['avg_r']),
      profit_factor: num(rec['profit_factor']),
      sharpe: null,
      updated_at: fetchedAt,
    });
  };
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const bySource = root['by_source'];
  if (bySource && typeof bySource === 'object' && !Array.isArray(bySource)) {
    for (const [trader, rec] of Object.entries(bySource as Record<string, unknown>)) {
      if (rec && typeof rec === 'object') push(trader, rec as Record<string, unknown>);
    }
  }
  const traders = root['traders'];
  if (Array.isArray(traders)) {
    for (const rec of traders) {
      if (rec && typeof rec === 'object') push(String((rec as Record<string, unknown>)['source'] ?? ''), rec as Record<string, unknown>);
    }
  }
  return out;
}

export interface TraderStatsDeps {
  kv: FollowKv;
  fetch: FollowFetch;
  /** `workflow.follow.stats_url`,如 `http://127.0.0.1:8794`。 */
  baseUrl: () => string;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

/** 8794 统计客户端。缓存落 kv,进程重启后照样有上一份(带 fetched_at,过期照样标 stale)。 */
export class TraderStatsClient {
  private lastAttemptAt = 0;

  constructor(private readonly deps: TraderStatsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  snapshot(): TraderStatsSnapshot | null {
    const raw = this.deps.kv.kvGet(TRADER_STATS_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<TraderStatsSnapshot>;
      if (!Array.isArray(parsed.rows)) return null;
      return { rows: parsed.rows as TraderStatsRow[], fetched_at: Number(parsed.fetched_at ?? 0), error: parsed.error ?? null };
    } catch {
      return null;
    }
  }

  due(now = this.now()): boolean {
    const snap = this.snapshot();
    const last = Math.max(snap?.fetched_at ?? 0, this.lastAttemptAt);
    return now - last >= TRADER_STATS_REFRESH_MS;
  }

  /** 拉一次。失败**不覆盖**上一份好数据,只把 error 记在快照上(旧行仍可用,只是会变 stale)。 */
  async refresh(): Promise<TraderStatsSnapshot> {
    const now = this.now();
    this.lastAttemptAt = now;
    const base = this.deps.baseUrl().replace(/\/+$/, '');
    const prev = this.snapshot();
    if (!base) {
      const snap: TraderStatsSnapshot = { rows: prev?.rows ?? [], fetched_at: prev?.fetched_at ?? 0, error: 'follow.stats_url 未配置' };
      this.deps.kv.kvSet(TRADER_STATS_KEY, JSON.stringify(snap));
      return snap;
    }
    try {
      const res = await this.deps.fetch(`${base}/api/copytrading/trader-stats`, { method: 'GET', headers: { accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}:${text.slice(0, 200)}`);
      const rows = parseTraderStats(JSON.parse(text), now);
      const snap: TraderStatsSnapshot = { rows, window: TRADER_STATS_WINDOW, fetched_at: now, error: null };
      this.deps.kv.kvSet(TRADER_STATS_KEY, JSON.stringify(snap));
      this.deps.log?.('info', `跟单权重:8794 统计拉到 ${rows.length} 位带单员`);
      return snap;
    } catch (e) {
      const snap: TraderStatsSnapshot = { rows: prev?.rows ?? [], fetched_at: prev?.fetched_at ?? 0, error: (e as Error).message };
      this.deps.kv.kvSet(TRADER_STATS_KEY, JSON.stringify(snap));
      this.deps.log?.('warn', `跟单权重:8794 统计拉不到(改用 manual_weight 并标过期):${(e as Error).message}`);
      return snap;
    }
  }
}
