/**
 * ASP 订阅信号的**事后回测评分**(影子回放,不下单、不碰交易所、不写线程)。
 *
 * 目的:一个订阅(`job_id`)推来的 order 信号,如果**完全按它自己写的入场/止损/止盈**执行,
 * 事后用 K 线看会是什么结果。产出每条信号的 R 倍数与订阅级战绩,用来判断这个卖家值不值这笔订阅费。
 *
 * 零模型、纯函数化:输入是信号表 + K 线,输出是数字。唯一的副作用是把结果写进 `demo_kv` 做 10 分钟缓存。
 *
 * ## 回放规则(改这里就要改注释)
 *
 * 1. **样本**:`demo_trader_signal` 里 `subscription_job_id = job` 且 `action = 'open'` 的信号。
 *    管理类动作(add/reduce/close/stop_loss_update…)不是入场信号,不进样本;套利留痕行同理。
 * 2. **K 线**:15m,从 `published_at` 起取到 `now`。`fetchKlines` 只吃 `limit`(没有起止时间参数),
 *    所以按 `(now - published_at) / 15m` 算需要多少根、向上取整到百位、**最多 500 根**;
 *    窗口不够覆盖 `published_at` 时不报错,标 `note`(`K线窗口被截断…`)后照常回放能看到的那段。
 *    只用 `open_time >= published_at` 的整根 K 线 —— 信号发出那一刻正在走的半根不算(保守)。
 * 3. **入场**:阶梯入场取**第一档**价;`entry_prices` 为空(市价信号)= `unscorable`,没有 `stop` 也是。
 *    在 `valid_until`(没有就 `published_at + 24h`)之前,某根 K 线 `low <= entry <= high` 视为成交;
 *    **成交那根不判止损止盈**,从下一根开始判 —— 同一根里既碰入场又碰出场的顺序不可知,不猜。
 * 4. **出场**:成交之后每根先判止损(long `low <= stop` / short `high >= stop`),
 *    再判止盈(只看**第一档** tp,long `high >= tp1` / short `low <= tp1`)。
 *    **同一根都碰到按止损算**(保守)。没有 tp 的信号只可能止损或一直持有,仍然计分。
 * 5. **终态**:`tp_hit` / `stopped` = 已出场;到 `now` 还没出场 = `open`,R 用**最后一根收盘价**算浮动;
 *    成交前 `valid_until` 就过了 = `expired`(`r = null`,不计分);还没到期也还没成交 = `pending_entry`(不计分);
 *    缺方向/缺入场/缺止损/止损方向与开仓方向矛盾/K 线拉取失败 = `unscorable`(不计分,`note` 写原因)。
 * 6. **R**:`risk = |entry - stop|`;long `R = (exit - entry) / risk`,short `R = (entry - exit) / risk`。
 *    `mfe_r` / `mae_r` 用**持仓期间**(含出场那根)的极值同样换算:long 的有利极值是 high、不利极值是 low,short 反过来。
 * 7. **汇总**:只算 `stopped` / `tp_hit` / `open` 三种。`wins = R > 0`、`losses = R < 0`(R 恰好为 0 两边都不算);
 *    `win_rate = wins / (wins + losses)`;`profit_factor = 正 R 之和 / |负 R 之和|`(**一笔亏损都没有 = null**,
 *    不给 Infinity,免得前端把「还没亏过」显示成无限好);`avg_rr_planned` = 平均计划盈亏比 `|tp1 - entry| / risk`。
 *
 * 一笔一笔独立:`fetchKlines` 抛错只毁那一条(标 `unscorable`),不让整张成绩单挂掉。
 * 同一个 symbol 在一次 `scorecardFor` 里只拉一次 K 线(按需要的最大根数缓存复用)。
 */

import type { DemoStore } from '../store.js';
import type { Kline } from '../types.js';
import type { TraderSignal } from '../trader-signal.js';

/** 回放用的 K 线周期,和文件头规则绑死。 */
export const SCORECARD_TF = '15m';
const TF_MS = 15 * 60 * 1000;
/** 交易所单次 K 线上限(`fetchKlines` 签名没有起止时间,只能靠根数往回够)。 */
const MAX_KLINES = 500;
/** 信号没写 `valid_until` 时的默认挂单有效期。 */
const DEFAULT_VALIDITY_MS = 24 * 60 * 60 * 1000;
/** 成绩单缓存有效期。 */
export const SCORECARD_TTL_MS = 10 * 60 * 1000;
const KV_PREFIX = 'market.scorecard.';

export interface ScorecardDeps {
  store: DemoStore;
  now: number;
  fetchKlines: (symbol: string, tf: string, limit: number) => Promise<Kline[]>;
  /** 跳过 10 分钟缓存,强制重算。 */
  force?: boolean;
}

export type SignalOutcomeStatus = 'pending_entry' | 'open' | 'stopped' | 'tp_hit' | 'expired' | 'unscorable';

export interface SignalOutcome {
  signal_id: string;
  symbol: string;
  side: 'long' | 'short' | null;
  published_at: number;
  entry: string | null;
  stop: string | null;
  tps: string[];
  status: SignalOutcomeStatus;
  r: number | null;
  mfe_r: number | null;
  mae_r: number | null;
  entry_at: number | null;
  exit_at: number | null;
  note: string | null;
}

export interface Scorecard {
  job_id: string;
  n_signals: number;
  n_scored: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  avg_r: number | null;
  sum_r: number | null;
  profit_factor: number | null;
  avg_rr_planned: number | null;
  outcomes: SignalOutcome[];
  computed_at: number;
}

/** 计分口径:只有这三种终态进战绩。 */
const SCORED: ReadonlySet<SignalOutcomeStatus> = new Set<SignalOutcomeStatus>(['stopped', 'tp_hit', 'open']);

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** R 值一律留 4 位小数:再多是 K 线精度给不出的假精确,JSON 也难看。 */
function round4(n: number): number {
  return Number(n.toFixed(4));
}

/** 按需要的根数向上取整到百位(100…500),让同 symbol 的多条信号更容易命中同一次拉取。 */
function bucketFor(needed: number): number {
  return Math.min(MAX_KLINES, Math.max(100, Math.ceil(needed / 100) * 100));
}

/**
 * 一次 `scorecardFor` 内的 K 线去重:每个 symbol 只留**一条**取数记录,
 * 后来者要的根数更多就重拉并覆盖(更长的窗口天然包含更短的),更少就直接复用。
 * 失败也缓存 —— 同一 symbol 的后续信号跟着标 unscorable,不重复敲交易所。
 */
class KlineCache {
  private readonly hits = new Map<string, { limit: number; p: Promise<Kline[]> }>();
  constructor(private readonly fetch: ScorecardDeps['fetchKlines']) {}
  get(symbol: string, needed: number): Promise<Kline[]> {
    const limit = bucketFor(needed);
    const cached = this.hits.get(symbol);
    if (cached && cached.limit >= limit) return cached.p;
    const p = this.fetch(symbol, SCORECARD_TF, limit);
    this.hits.set(symbol, { limit, p });
    return p;
  }
}

function base(sig: TraderSignal): SignalOutcome {
  return {
    signal_id: sig.signal_id,
    symbol: sig.symbol,
    side: sig.side,
    published_at: sig.published_at,
    entry: sig.entry_prices[0] ?? null,
    stop: sig.stop,
    tps: sig.tps.map((t) => t.price),
    status: 'unscorable',
    r: null,
    mfe_r: null,
    mae_r: null,
    entry_at: null,
    exit_at: null,
    note: null,
  };
}

function unscorable(sig: TraderSignal, note: string): SignalOutcome {
  return { ...base(sig), status: 'unscorable', note };
}

/** 单条信号的影子回放。已经确认有 side / entry / stop,K 线也拿到了。 */
function replay(sig: TraderSignal, klines: Kline[], now: number, entry: number, stop: number, note: string | null): SignalOutcome {
  const out = base(sig);
  const long = sig.side === 'long';
  const risk = Math.abs(entry - stop);
  const dir = long ? 1 : -1;
  const rOf = (price: number) => round4(((price - entry) / risk) * dir);
  const tp1 = num(sig.tps[0]?.price ?? null);
  const deadline = sig.valid_until ?? sig.published_at + DEFAULT_VALIDITY_MS;
  const window = klines.filter((k) => k.open_time >= sig.published_at && k.open_time <= now);
  if (window.length && window[0]!.open_time > sig.published_at + TF_MS) {
    note = note ?? `K线窗口被截断:最早一根 ${new Date(window[0]!.open_time).toISOString()} 晚于信号发布时间`;
  }

  let filled = false;
  let entryAt: number | null = null;
  let exitPrice: number | null = null;
  let exitAt: number | null = null;
  let status: SignalOutcomeStatus | null = null;
  let best = entry;
  let worst = entry;
  let lastClose: number | null = null;

  for (const k of window) {
    const high = num(k.high);
    const low = num(k.low);
    const close = num(k.close);
    if (high === null || low === null || close === null) continue;
    if (!filled) {
      // 有效期过了还没成交:这一根之后不再看入场。
      if (k.open_time > deadline) break;
      if (low <= entry && entry <= high) {
        filled = true;
        entryAt = k.open_time;
      }
      // 成交那根不判出场(同根内的先后不可知),从下一根开始。
      continue;
    }
    lastClose = close;
    // 极值先更新:出场那根的 high/low 也算进 mfe/mae。
    best = long ? Math.max(best, high) : Math.min(best, low);
    worst = long ? Math.min(worst, low) : Math.max(worst, high);
    const stopHit = long ? low <= stop : high >= stop;
    if (stopHit) {
      status = 'stopped';
      exitPrice = stop;
      exitAt = k.open_time;
      break;
    }
    if (tp1 !== null && (long ? high >= tp1 : low <= tp1)) {
      status = 'tp_hit';
      exitPrice = tp1;
      exitAt = k.open_time;
      break;
    }
  }

  if (!filled) {
    return { ...out, status: deadline <= now ? 'expired' : 'pending_entry', note };
  }
  if (status === null) {
    // 还在场内:浮动 R 用最后一根收盘价。窗口里只有成交那一根时没有收盘价可用,按 0 浮动处理。
    status = 'open';
    exitPrice = lastClose ?? entry;
    exitAt = null;
  }
  return {
    ...out,
    status,
    r: rOf(exitPrice!),
    mfe_r: rOf(best),
    mae_r: rOf(worst),
    entry_at: entryAt,
    exit_at: exitAt,
    note,
  };
}

function summarize(jobId: string, outcomes: SignalOutcome[], planned: number[], now: number): Scorecard {
  const scored = outcomes.filter((o) => SCORED.has(o.status) && o.r !== null);
  const rs = scored.map((o) => o.r!);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const gross = wins.reduce((a, b) => a + b, 0);
  const bad = Math.abs(losses.reduce((a, b) => a + b, 0));
  const sum = rs.reduce((a, b) => a + b, 0);
  return {
    job_id: jobId,
    n_signals: outcomes.length,
    n_scored: scored.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: wins.length + losses.length ? round4(wins.length / (wins.length + losses.length)) : null,
    avg_r: rs.length ? round4(sum / rs.length) : null,
    sum_r: rs.length ? round4(sum) : null,
    // 一笔亏损都没有 → null,不给 Infinity。
    profit_factor: bad > 0 ? round4(gross / bad) : null,
    avg_rr_planned: planned.length ? round4(planned.reduce((a, b) => a + b, 0) / planned.length) : null,
    outcomes,
    computed_at: now,
  };
}

function cached(store: DemoStore, jobId: string, now: number): Scorecard | null {
  const raw = store.kvGet(`${KV_PREFIX}${jobId}`);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Scorecard;
    if (!v || typeof v !== 'object' || typeof v.computed_at !== 'number' || v.job_id !== jobId) return null;
    // 未来时间戳(时钟回拨 / 手改库)一律当失效,免得缓存永远不过期。
    if (v.computed_at > now || now - v.computed_at >= SCORECARD_TTL_MS) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * 一个订阅的事后成绩单。规则见文件头。
 *
 * 10 分钟内重复调用直接给缓存(`computed_at` 是**算出来那一刻**,不是这次调用的时间);
 * `deps.force` 跳过缓存。
 */
export async function scorecardFor(jobId: string, deps: ScorecardDeps): Promise<Scorecard> {
  const { store, now } = deps;
  if (!deps.force) {
    const hit = cached(store, jobId, now);
    if (hit) return hit;
  }

  // agent.ts::stats() 同款查询:投递账本按 job 归集,信号本体从 traderSignals 取。
  const rows = store.marketDb.prepare('SELECT signal_id FROM demo_trader_signal WHERE subscription_job_id=?').all(jobId) as Record<string, unknown>[];
  const signals = rows
    .map((x) => store.traderSignals.find(String(x['signal_id'])))
    .filter((s): s is TraderSignal => !!s && s.kind !== 'arbitrage' && s.action === 'open')
    .sort((a, b) => a.published_at - b.published_at || a.signal_id.localeCompare(b.signal_id));

  const klines = new KlineCache(deps.fetchKlines);
  const outcomes: SignalOutcome[] = [];
  const planned: number[] = [];

  for (const sig of signals) {
    if (sig.side !== 'long' && sig.side !== 'short') { outcomes.push(unscorable(sig, '信号没有方向')); continue; }
    const entry = num(sig.entry_prices[0] ?? null);
    const stop = num(sig.stop);
    if (entry === null || !(entry > 0)) { outcomes.push(unscorable(sig, '没有入场价(市价信号无法回测)')); continue; }
    if (stop === null || !(stop > 0)) { outcomes.push(unscorable(sig, '没有止损,无法定义 R')); continue; }
    if (entry === stop) { outcomes.push(unscorable(sig, '止损等于入场价,风险为 0')); continue; }
    if (sig.side === 'long' ? stop > entry : stop < entry) {
      outcomes.push(unscorable(sig, `止损方向与 ${sig.side} 矛盾(entry ${entry} / stop ${stop})`));
      continue;
    }

    const needed = Math.ceil(Math.max(0, now - sig.published_at) / TF_MS) + 2;
    let bars: Kline[];
    try {
      bars = await klines.get(sig.symbol, needed);
    } catch (e) {
      outcomes.push(unscorable(sig, `K线拉取失败:${(e as Error).message}`));
      continue;
    }
    const note = needed > MAX_KLINES ? `K线窗口被截断:需要 ${needed} 根,单次上限 ${MAX_KLINES} 根` : null;
    const outcome = replay(sig, bars, now, entry, stop, note);
    outcomes.push(outcome);
    // 计划盈亏比只看信号自己写的三个价,和回放结果无关(过期/没成交的也算)。
    const tp1 = num(sig.tps[0]?.price ?? null);
    if (tp1 !== null && tp1 > 0) planned.push(round4(Math.abs(tp1 - entry) / Math.abs(entry - stop)));
  }

  const card = summarize(jobId, outcomes, planned, now);
  store.kvSet(`${KV_PREFIX}${jobId}`, JSON.stringify(card));
  return card;
}
