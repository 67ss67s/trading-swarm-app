// 判断账本历史回填(docs/design/judgment-exit-redesign-2026-09-23.md §6 P0-1)。零模型调用。
//
// 账本 09-12 才上线,之前 18 笔真实持仓的 ~200 次复查(HOLD/EXIT)一条都没被反事实过。这个脚本把
// 「有线程、还没有账本行」的 episode 用现有的 `ledgerRowFor` + `settleRow` 补记成 `source='backfill'` 行,
// 再按 (model_action × holding_reason × trigger_kind × prompt_version) 出复查决策表,外加逐线程对照:
// 模型实际离场 vs 按计划拿到止损/止盈 vs 机械吊灯线(ATR22×3,研究台 IR 的默认追踪)管理到底。
//
//   npx jiti packages/gateway/scripts/ledger-backfill.ts --db <state.sqlite 的副本> \
//     [--klines-dir <K 线缓存目录,默认 TG_DEMO_KLINE_CACHE_DIR 或 ~/.trading-swarm/demo/klines>] \
//     [--json <结果 JSON 输出路径>] [--dry-run]
//
// **只准跑在副本上**:路径指向 ~/.trading-swarm/demo/state.sqlite 或 ~/.trading-swarm-okx/demo/state.sqlite 直接拒绝。
// K 线走 backtest.ts 的磁盘缓存(`loadKlines`);缓存没覆盖到的区间才会请求币安公共行情(需要代理时设
// NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…)。缓存缺口补回来会写进 --klines-dir,所以建议指向一份缓存副本。
//
// 口径与限制(写进每一行的 settle_note):
//   - 复查快照(止损/止盈/成交价)取线程**终态**(`reviewSnapshot` 的重建路径),不是判断当时的值;
//     判断过程中挪过止损的线程,早期复查行的 R 基数会有偏差。
//   - regret 走线程自己的周期(`review_bars`),horizon 48 根;三条腿照旧走快照周期。
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadKlines } from '../src/demo/backtest.js';
import {
  JudgmentLedgerStore,
  ledgerRowFor,
  settleRow,
  summarizeDecisions,
  summarizeLedger,
  type JudgmentLedgerRow,
} from '../src/demo/judgment-ledger.js';
import { tfToMs } from '../src/demo/market.js';
import { openTrade, stepTrade, tradeR } from '../src/demo/outcome.js';
import type { Direction, Episode, Kline, StrategyThread } from '../src/demo/types.js';

// ---------------------------------------------------------------- args & safety

const argv = process.argv.slice(2);
const arg = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
};
const dbArg = arg('db');
if (!dbArg) {
  console.error('用法:npx jiti packages/gateway/scripts/ledger-backfill.ts --db <副本路径> [--klines-dir D] [--json OUT] [--dry-run]');
  process.exit(2);
}
const dbPath = resolve(dbArg);
if (!existsSync(dbPath)) {
  console.error(`没有这个库:${dbPath}`);
  process.exit(2);
}
const LIVE = [resolve(homedir(), '.trading-swarm/demo/state.sqlite'), resolve(homedir(), '.trading-swarm-okx/demo/state.sqlite')];
const real = (p: string): string => (existsSync(p) ? realpathSync(p) : p);
if (LIVE.map(real).includes(real(dbPath))) {
  console.error(`拒绝:${dbPath} 是现网库。先 sqlite3 <src> '.backup <copy>' 再对副本跑。`);
  process.exit(2);
}
const klinesDir = arg('klines-dir');
if (klinesDir) process.env['TG_DEMO_KLINE_CACHE_DIR'] = resolve(klinesDir);
const dryRun = argv.includes('--dry-run');
const jsonOut = arg('json');

const NOW = Date.now();
const DAY = 86_400_000;
/** 「拿到计划止损/止盈」与吊灯线对照最多走多久;都没碰到按最后一根收盘算 expired。 */
const PLAN_WALK_MS = 7 * DAY;
const CHANDELIER_ATR = 22;
const CHANDELIER_MULT = 3;

const db = new DatabaseSync(dbPath);
const store = new JudgmentLedgerStore(db);

// ---------------------------------------------------------------- load

const threads = new Map<string, StrategyThread>();
for (const r of db.prepare('SELECT id, json FROM demo_threads').all() as { id: string; json: string }[]) threads.set(r.id, JSON.parse(r.json) as StrategyThread);

const eps = (
  db
    .prepare(
      `SELECT e.id, e.json FROM demo_episodes e
       WHERE json_extract(e.json, '$.thread_id') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM demo_judgment_ledger l WHERE l.episode_id = e.id)
       ORDER BY e.at`,
    )
    .all() as { id: string; json: string }[]
).map((r) => JSON.parse(r.json) as Episode);

// ---------------------------------------------------------------- bars (one load per symbol × tf)

const need = new Map<string, { symbol: string; tf: string; from: number; to: number }>();
const want = (symbol: string, tf: string, from: number, to: number): void => {
  const k = `${symbol}|${tf}`;
  const cur = need.get(k);
  need.set(k, cur ? { ...cur, from: Math.min(cur.from, from), to: Math.max(cur.to, to) } : { symbol, tf, from, to });
};
const firstStructTf = (ep: Episode): string | null => {
  for (const e of ep.evidence ?? []) {
    if (e.kind !== 'structure') continue;
    const m = /^(\S+)\s结构$/.exec(e.label);
    if (m) return m[1]!;
  }
  return null;
};
for (const ep of eps) {
  const th = threads.get(ep.thread_id!);
  const tfs = new Set<string>([firstStructTf(ep), th?.timeframe ?? null].filter((x): x is string => !!x));
  for (const tf of tfs) want(ep.symbol, tf, ep.as_of - 2 * tfToMs(tf), Math.min(NOW - 1, ep.as_of + 60 * tfToMs(tf)));
}
for (const th of threads.values()) {
  if (!th.timeframe || th.opened_at === null || th.opened_at === undefined) continue;
  const tfMs = tfToMs(th.timeframe);
  want(th.symbol, th.timeframe, th.opened_at - (CHANDELIER_ATR + 2) * tfMs, Math.min(NOW - 1, (th.closed_at ?? th.opened_at) + PLAN_WALK_MS));
}

const series = new Map<string, Kline[]>();
const missingBars: string[] = [];
for (const [k, n] of need) {
  try {
    const bars = await loadKlines(n.symbol, n.tf, n.from, n.to);
    series.set(k, bars);
    if (!bars.length) missingBars.push(`${k} 空`);
  } catch (e) {
    missingBars.push(`${k}: ${(e as Error).message}`);
    series.set(k, []);
  }
}
const barsOf = (symbol: string, tf: string, from: number, to: number): Kline[] => (series.get(`${symbol}|${tf}`) ?? []).filter((b) => b.open_time >= from && b.open_time <= to);

// ---------------------------------------------------------------- backfill

const skipped = new Map<string, number>();
const skip = (why: string): void => void skipped.set(why, (skipped.get(why) ?? 0) + 1);
const written: JudgmentLedgerRow[] = [];
const markSource = db.prepare("UPDATE demo_judgment_ledger SET source = 'backfill' WHERE episode_id = ?");

for (const ep of eps) {
  const thread = threads.get(ep.thread_id!) ?? null;
  if (!thread) {
    skip('线程不存在');
    continue;
  }
  if (thread.status !== 'closed' && thread.status !== 'canceled') {
    skip('线程还没结束(不回填,交给线上巡检)');
    continue;
  }
  const row = ledgerRowFor(ep, thread);
  if (!row) {
    skip(ep.status !== 'done' ? `episode ${ep.status}` : ep.trigger.kind === 'chat' ? '对话触发' : '没有判断结果');
    continue;
  }
  if (row.horizon_end_at > NOW) {
    skip('horizon 还没到');
    continue;
  }
  row.source = 'backfill';
  const tfMs = row.timeframe ? tfToMs(row.timeframe) : 0;
  const bars = row.timeframe ? barsOf(ep.symbol, row.timeframe, row.as_of - tfMs, row.horizon_end_at + tfMs) : [];
  const threadTf = thread.timeframe;
  const review_bars = row.mode === 'review' && threadTf ? barsOf(ep.symbol, threadTf, row.as_of - tfToMs(threadTf), row.as_of + 50 * tfToMs(threadTf)) : undefined;
  const settled = settleRow(row, bars, thread, NOW, { review_bars });
  const note = '回填(backfill 09-23):复查快照的止损/止盈/成交价取线程终态,不是判断当时的值';
  settled.settle_note = settled.settle_note ? `${settled.settle_note};${note}` : note;
  if (!dryRun) {
    store.save(settled);
    markSource.run(settled.episode_id);
  }
  written.push(settled);
}

// ---------------------------------------------------------------- per-thread 对照

interface ThreadLine {
  thread_id: string;
  symbol: string;
  timeframe: string;
  side: Direction;
  close_reason: string | null;
  hold_minutes: number | null;
  review_rows: number;
  exit_action: string | null;
  exit_trigger: string | null;
  exit_holding_reason: string | null;
  exit_prompt_version: string | null;
  exit_now_r: number | null;
  hold_r_48: number | null;
  regret_48: number | null;
  /** 从离场判断那刻(没有离场判断则从入场)按计划止损/止盈拿到底,最多 7 天。 */
  hold_plan_r: number | null;
  hold_plan_status: string | null;
  hold_plan_hours: number | null;
  /** 入场起用机械吊灯线(HH/LL ∓ ATR22×3,只收紧)管理到底,无止盈,最多 7 天。 */
  chandelier_r: number | null;
  chandelier_status: string | null;
  /** 入场起按计划止损/止盈、完全不复查的结果。 */
  set_forget_r: number | null;
  set_forget_status: string | null;
  realized_gross_r: number | null;
  stop_pct: number | null;
  tp_pct: number | null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function walkPlan(side: Direction, fill: number, stop: number, tp: number | null, bars: readonly Kline[]): { r: number; status: string; bars: number } | null {
  const t = openTrade(side, fill, stop, tp);
  if (!t || !bars.length) return null;
  let i = 0;
  for (const b of bars) {
    i++;
    const s = stepTrade(t, b);
    if (s.exit) return { r: r4(tradeR(t, s.exit.price)), status: s.exit.status, bars: i };
  }
  return { r: r4(tradeR(t, Number(bars[bars.length - 1]!.close))), status: 'expired', bars: i };
}

function walkChandelier(side: Direction, fill: number, stop: number, history: readonly Kline[], bars: readonly Kline[]): { r: number; status: string } | null {
  const t = openTrade(side, fill, stop, null);
  if (!t || !bars.length) return null;
  const long = side === 'long';
  const seen: Kline[] = [...history];
  let extreme = fill;
  for (const b of bars) {
    // 吊灯线只用**已收盘**的 K 线:ATR22 与入场后的最高/最低都截止到上一根。
    const tail = seen.slice(-(CHANDELIER_ATR + 1));
    if (tail.length > CHANDELIER_ATR) {
      let tr = 0;
      for (let i = 1; i < tail.length; i++) {
        const h = Number(tail[i]!.high), l = Number(tail[i]!.low), pc = Number(tail[i - 1]!.close);
        tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
      const atr = tr / CHANDELIER_ATR;
      const trail = long ? extreme - CHANDELIER_MULT * atr : extreme + CHANDELIER_MULT * atr;
      if (long ? trail > t.stop : trail < t.stop) t.stop = trail;
    }
    const s = stepTrade(t, b, false);
    if (s.exit) return { r: r4(tradeR(t, s.exit.price)), status: s.exit.status === 'stop' && (long ? t.stop > stop : t.stop < stop) ? 'trail' : s.exit.status };
    seen.push(b);
    extreme = long ? Math.max(extreme, Number(b.high)) : Math.min(extreme, Number(b.low));
  }
  return { r: r4(tradeR(t, Number(bars[bars.length - 1]!.close))), status: 'expired' };
}

const allBackfill = dryRun ? written : (db.prepare("SELECT json FROM demo_judgment_ledger WHERE source = 'backfill'").all() as { json: string }[]).map((r) => JSON.parse(r.json) as JudgmentLedgerRow);
const lines: ThreadLine[] = [];
for (const th of [...threads.values()].filter((t) => t.status === 'closed').sort((a, b) => (a.opened_at ?? 0) - (b.opened_at ?? 0))) {
  const rows = allBackfill.filter((r) => r.thread_id === th.id).sort((a, b) => a.as_of - b.as_of);
  const tf = th.timeframe;
  const fill = num(th.filled_avg_price) ?? num(th.entry?.price);
  const stop = num(th.stop_price);
  const tp = num(th.take_profits?.[0]);
  const exitRow = [...rows].reverse().find((r) => r.mode === 'review' && (r.model_action === 'EXIT' || r.model_action === 'INVALIDATE')) ?? null;
  const tfMs = tf ? tfToMs(tf) : 0;
  let holdPlan: ReturnType<typeof walkPlan> = null;
  let chand: ReturnType<typeof walkChandelier> = null;
  let setForget: ReturnType<typeof walkPlan> = null;
  if (tf && fill !== null && stop !== null && th.opened_at) {
    const from = exitRow ? exitRow.as_of : th.opened_at;
    holdPlan = walkPlan(th.side, fill, stop, tp, barsOf(th.symbol, tf, from, from + PLAN_WALK_MS));
    const afterEntry = barsOf(th.symbol, tf, th.opened_at, th.opened_at + PLAN_WALK_MS);
    const before = barsOf(th.symbol, tf, th.opened_at - (CHANDELIER_ATR + 2) * tfMs, th.opened_at - 1);
    chand = walkChandelier(th.side, fill, stop, before, afterEntry);
    setForget = walkPlan(th.side, fill, stop, tp, afterEntry);
  }
  const exitPx = num(th.settlement?.exit_price) ?? (() => {
    const epJson = exitRow ? (db.prepare('SELECT json FROM demo_episodes WHERE id = ?').get(exitRow.episode_id) as { json: string } | undefined) : undefined;
    const ep = epJson ? (JSON.parse(epJson.json) as Episode) : null;
    const receipts = ((ep as { intent?: { receipts?: { leg?: string; receipt?: { avgPrice?: unknown } }[] } } | null)?.intent?.receipts ?? []);
    const rec = receipts.find((x) => x.leg === 'close')?.receipt;
    return num(rec?.avgPrice);
  })();
  const dist = fill !== null && stop !== null ? Math.abs(fill - stop) : null;
  lines.push({
    thread_id: th.id,
    symbol: th.symbol,
    timeframe: tf ?? '?',
    side: th.side,
    close_reason: th.close_reason ?? null,
    hold_minutes: th.opened_at && th.closed_at ? Math.round((th.closed_at - th.opened_at) / 60_000) : null,
    review_rows: rows.filter((r) => r.mode === 'review').length,
    exit_action: exitRow?.model_action ?? null,
    exit_trigger: exitRow?.trigger_kind ?? null,
    exit_holding_reason: exitRow?.holding_reason ?? null,
    exit_prompt_version: exitRow?.prompt_version ?? null,
    exit_now_r: exitRow?.regret?.exit_now_r ?? null,
    hold_r_48: exitRow?.regret?.hold_r ?? null,
    regret_48: exitRow?.regret?.regret_r ?? null,
    hold_plan_r: holdPlan?.r ?? null,
    hold_plan_status: holdPlan?.status ?? null,
    hold_plan_hours: holdPlan ? r4((holdPlan.bars * tfMs) / 3_600_000) : null,
    chandelier_r: chand?.r ?? null,
    chandelier_status: chand?.status ?? null,
    set_forget_r: setForget?.r ?? null,
    set_forget_status: setForget?.status ?? null,
    realized_gross_r: exitPx !== null && fill !== null && dist ? r4(((th.side === 'long' ? 1 : -1) * (exitPx - fill)) / dist) : null,
    stop_pct: fill !== null && dist ? r4((dist / fill) * 100) : null,
    tp_pct: fill !== null && tp !== null ? r4((Math.abs(tp - fill) / fill) * 100) : null,
  });
}

// ---------------------------------------------------------------- print

const f = (x: number | null | undefined, d = 2): string => (x === null || x === undefined ? '—' : x.toFixed(d));
const decisions = summarizeDecisions(allBackfill);
const summary = summarizeLedger(allBackfill);
const reviewRows = allBackfill.filter((r) => r.mode === 'review');
const count = (xs: JudgmentLedgerRow[], pred: (r: JudgmentLedgerRow) => boolean): number => xs.filter(pred).length;

console.log(`# ledger-backfill ${dryRun ? '(dry-run)' : ''} db=${dbPath}`);
console.log(`episode 候选 ${eps.length};本次写入 ${written.length};账本里 backfill 行合计 ${allBackfill.length}(review ${reviewRows.length} / scan ${allBackfill.length - reviewRows.length})`);
console.log(`review 行 regret 可算 ${count(reviewRows, (r) => r.regret !== null)};regret 不可算 ${count(reviewRows, (r) => r.regret === null)}`);
console.log(`跳过:${[...skipped].map(([k, v]) => `${k} ${v}`).join(';') || '无'}`);
if (missingBars.length) console.log(`K 线缺口:${missingBars.join(';')}`);
console.log('\n## by_decision(mode=review)\n');
console.log('| action | holding_reason | trigger | prompt | n | 簇 | mean regret | mean hold_r | mean exit_now_r | mean regret_hold | EXIT regret>0.5R |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const d of decisions) console.log(`| ${d.model_action} | ${d.holding_reason} | ${d.trigger_kind} | ${d.prompt_version} | ${d.n} | ${d.clusters} | ${f(d.mean_regret)} | ${f(d.mean_hold_r)} | ${f(d.mean_exit_now_r)} | ${f(d.mean_regret_hold)} | ${d.exit_regret_gt_half_share === null ? '—' : `${(d.exit_regret_gt_half_share * 100).toFixed(0)}%`} |`);
console.log('\n## 逐线程\n');
console.log('| 币 | 周期 | 收场 | 复查行 | 离场动作 | holding_reason | 触发 | exit_now_r | hold_r(48根) | regret | 拿到计划 | 吊灯线 | 入场即不管 | 实际(毛)R |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const l of lines) console.log(`| ${l.symbol} | ${l.timeframe} | ${(l.close_reason ?? '').slice(0, 14)} | ${l.review_rows} | ${l.exit_action ?? '—'} | ${l.exit_holding_reason ?? '—'} | ${l.exit_trigger ?? '—'} | ${f(l.exit_now_r)} | ${f(l.hold_r_48)} | ${f(l.regret_48)} | ${f(l.hold_plan_r)} ${l.hold_plan_status ?? ''} | ${f(l.chandelier_r)} ${l.chandelier_status ?? ''} | ${f(l.set_forget_r)} ${l.set_forget_status ?? ''} | ${f(l.realized_gross_r)} |`);

if (jsonOut) {
  writeFileSync(resolve(jsonOut), JSON.stringify({ at: NOW, db: dbPath, candidates: eps.length, written: written.length, skipped: Object.fromEntries(skipped), missing_bars: missingBars, summary, decisions, threads: lines, rows: allBackfill }, null, 2));
  console.log(`\nJSON → ${resolve(jsonOut)}`);
}
db.close();
