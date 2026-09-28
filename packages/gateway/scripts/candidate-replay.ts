// CandidateV0 影子候选离线回放(docs/research/candidate-v0-2026-09-23.md)。零模型、零下单。
//
// 在一份 state.sqlite **副本**上,用影子同一条 IR(`loadIRForShadow`)把最近 N 天的 1h K 线逐根回放成候选,
// 落 demo_strategy_candidate(origin='replay'),再和副本里的 demo_episodes 配对、按计划腿/吊灯腿结算,打印汇总。
// 回放不是前向证据:它只用来预热表、检查几何与配对口径;前向证据只认运行时钩子写的 origin='online' 行。
//
//   npx jiti packages/gateway/scripts/candidate-replay.ts --db <副本> [--days 30] [--symbols BTCUSDT,ETHUSDT]
//     [--source fetch|dataset] [--market perp|spot] [--json OUT]
//
// --source fetch(默认):market.ts fetchKlines 拉交易所公共 K 线(OKX 需要代理:HTTPS_PROXY=http://127.0.0.1:7897);
// --source dataset:用副本里 research_datasets 已冻结的 1h 数据(不联网,但只到数据集的截止时间)。
// **只准跑在副本上**:路径指向 ~/.trade-gate/demo/state.sqlite 或 ~/.trade-gate-okx/demo/state.sqlite 直接拒绝。
// openStateDb 会给副本补跑未执行的迁移(包括 0041)。
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { openStateDb } from '../src/state-db.js';
import { fetchKlines } from '../src/demo/market.js';
import type { Kline, Market } from '../src/demo/types.js';
import { timeframeMillis } from '../src/demo/research/strategy.js';
import { viewBars } from '../src/demo/research/engine.js';
import {
  generateCandidates,
  loadIRForShadow,
  matchPending,
  persistCandidate,
  settleCandidates,
  summarizeCandidates,
  SYNTH_POLICY,
  TRAIL_ATR_PERIOD,
} from '../src/demo/strategy-candidate.js';

const argv = process.argv.slice(2);
const arg = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
};
const dbArg = arg('db');
if (!dbArg) {
  console.error('用法:npx jiti packages/gateway/scripts/candidate-replay.ts --db <副本路径> [--days 30] [--symbols A,B] [--source fetch|dataset] [--market perp|spot] [--json OUT]');
  process.exit(2);
}
const dbPath = resolve(dbArg);
if (!existsSync(dbPath)) {
  console.error(`没有这个库:${dbPath}`);
  process.exit(2);
}
const LIVE = [resolve(homedir(), '.trade-gate/demo/state.sqlite'), resolve(homedir(), '.trade-gate-okx/demo/state.sqlite')];
const real = (p: string): string => (existsSync(p) ? realpathSync(p) : p);
if (LIVE.map(real).includes(real(dbPath))) {
  console.error(`拒绝:${dbPath} 是现网库。先 sqlite3 <src> '.backup <copy>' 再对副本跑。`);
  process.exit(2);
}
const days = Math.max(1, Number(arg('days') ?? '30'));
const source = arg('source') === 'dataset' ? 'dataset' : 'fetch';
const market: Market = arg('market') === 'spot' ? 'spot' : 'perp';
const jsonOut = arg('json');

const state = openStateDb(dbPath);
const db = state.db;
const shadow = loadIRForShadow(db);
const tf = shadow.timeframe;
const tfMs = timeframeMillis(tf);
const W = viewBars(shadow.ir, SYNTH_POLICY, tfMs);

function watchlist(): string[] {
  const s = arg('symbols');
  if (s) return s.split(',').map((x) => x.trim()).filter(Boolean);
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'demo.workflow'").get() as { value: string } | undefined;
    const wl = row ? (JSON.parse(row.value) as { watchlist?: string[] }).watchlist : undefined;
    if (wl?.length) return wl;
  } catch {
    /* fall through */
  }
  return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
}

async function barsFor(symbol: string): Promise<{ bars: Kline[]; note: string }> {
  if (source === 'dataset') {
    const row = db
      .prepare(`SELECT id, json FROM research_datasets WHERE json_extract(json,'$.symbol') = ? AND json_extract(json,'$.timeframe_ms') = ? ORDER BY json_extract(json,'$.bars[#-1].close_time') DESC, json_array_length(json,'$.bars') DESC LIMIT 1`)
      .get(symbol, tfMs) as { id: string; json: string } | undefined;
    if (!row) return { bars: [], note: 'no_dataset' };
    const d = JSON.parse(row.json) as { source?: string; bars: { open_time: number; open: string; high: string; low: string; close: string; volume: string }[] };
    return { bars: d.bars.map((b) => ({ open_time: b.open_time, close_time: b.open_time + tfMs - 1, open: String(b.open), high: String(b.high), low: String(b.low), close: String(b.close), volume: String(b.volume) })), note: `dataset ${row.id.slice(0, 12)} ${d.source ?? ''}` };
  }
  const want = days * Math.round(86_400_000 / tfMs) + W + TRAIL_ATR_PERIOD + 4;
  return { bars: await fetchKlines(symbol, tf, want, undefined, market), note: `fetch ${market} ${want} 根` };
}

const symbols = watchlist();
console.log(`影子 IR:${shadow.strategy_id}@${shadow.version} ${tf} ir_hash=${shadow.ir_hash.slice(0, 12)}(${shadow.pick_note})`);
const cache = new Map<string, Kline[]>();
let endNow = 0;
let generated = 0;
for (const symbol of symbols) {
  let got: Awaited<ReturnType<typeof barsFor>>;
  try {
    got = await barsFor(symbol);
  } catch (e) {
    console.error(`${symbol} 拉 K 线失败:${(e as Error).message}`);
    continue;
  }
  const bars = [...new Map(got.bars.map((k) => [k.open_time, k])).values()].sort((a, b) => a.open_time - b.open_time);
  const wallNow = Date.now();
  const closed = bars.filter((k) => k.open_time + tfMs <= wallNow);
  cache.set(symbol, closed);
  if (!closed.length) continue;
  const lastClose = closed[closed.length - 1]!.open_time + tfMs;
  endNow = Math.max(endNow, lastClose);
  const from = lastClose - days * 86_400_000;
  let n = 0;
  for (let i = 0; i < closed.length; i++) {
    const b = closed[i]!;
    if (b.open_time + tfMs <= from) continue;
    const now = b.open_time + tfMs + 5000;
    const g = generateCandidates({ shadow, symbol, klines: { [tf]: closed.slice(Math.max(0, i + 1 - W - 2), i + 1) }, now, origin: 'replay' });
    if (g.candidate && persistCandidate(db, g.candidate)) n++;
  }
  generated += n;
  console.log(`${symbol}:${got.note},已收盘 ${closed.length} 根,回放窗口 ${new Date(from).toISOString().slice(0, 16)} → ${new Date(lastClose).toISOString().slice(0, 16)},新候选 ${n}`);
}

// 结算走内存 K 线(和实时 loader 同签名:limit 根、截止 endTime 的 open_time)
const load = async (symbol: string, _tf: string, limit: number, endTime?: number): Promise<Kline[]> => {
  const all = cache.get(symbol) ?? [];
  const upto = endTime === undefined ? all : all.filter((k) => k.open_time <= endTime);
  return upto.slice(-limit);
};
const matched = matchPending(db, endNow);
let settled = 0;
for (;;) {
  const n = await settleCandidates(db, load, endNow, { max: 500, log: (_l, m) => console.error(m) });
  settled += n;
  if (n < 500) break;
}
const firstEp = (db.prepare('SELECT MIN(at) AS t FROM demo_episodes').get() as { t: number | null }).t;
const all = summarizeCandidates(db);
const paired = firstEp ? summarizeCandidates(db, { since: firstEp }) : null;
console.log(`生成 ${generated},配对定稿 ${matched},结算 ${settled}`);
console.log(JSON.stringify({ shadow: { strategy_id: shadow.strategy_id, version: shadow.version, ir_hash: shadow.ir_hash, timeframe: tf, pick_note: shadow.pick_note }, all, paired_window: paired && { since: firstEp, ...paired } }, null, 2));
if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify({ shadow, all, paired_window: paired }, null, 2));
state.close();
