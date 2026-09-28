/**
 * 批量研究取数(零模型,只读公共接口):资产池(universe.json)× 周期 × 现货/永续,冻结成 JSON 放 ~/.trade-gate-okx/research-batch/data/。
 *  - 现货:backtest-report 的 okxLoader(先读 state.sqlite 的 research_datasets 缓存,只读打开;缺的头尾从 OKX 公共 K 线补);
 *  - 永续:data/perp-market.ts 的 syncCandles(成交价 K 线)+ loadFunding(OKX 归档/REST,早于 OKX 覆盖的币安代理),走共享 sqlite 缓存;
 *    批量研究全部用 1 倍杠杆,标记价只影响强平,1 倍下不会触发,所以不拉标记价(执行核按成交价兜底并标 mark_fallback)。
 * 窗口(to = TO_MS):15m 最近 365 天、1h 730 天、4h/1d 自 2018-01-01(或上市首根);另向前多借 301 根预热。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/fetch.ts spot|perp [tf,...]
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { okxLoader } from '../../packages/gateway/src/demo/research/backtest-report.ts';
import { ResearchStore } from '../../packages/gateway/src/demo/research/store.ts';
import { MarketCache, perpContext, syncCandles, loadFunding, symbolToInstId } from '../../packages/gateway/src/demo/research/data/perp-market.ts';
import { configureOkxProxy } from '../../packages/gateway/src/demo/okx-proxy.ts';
import { BATCH_DIR, DATA_DIR, TO_MS, windowFor, dataFile, readUniverse } from './common.ts';

configureOkxProxy();
const kind = process.argv[2] as 'spot' | 'perp', tfs = (process.argv[3] ?? '1d,4h,1h,15m').split(',');
if (kind !== 'spot' && kind !== 'perp') throw Error('用法: fetch.ts spot|perp [tfs]');
mkdirSync(DATA_DIR, { recursive: true });
const universe = readUniverse(), t0 = Date.now(), log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`);
const db = kind === 'spot' ? new DatabaseSync(path.join(process.env.HOME!, '.trade-gate-okx', 'demo', 'state.sqlite'), { readOnly: true }) : null;
const load = db ? okxLoader({ store: new ResearchStore(db), service: null as never }) : null;
const cache = kind === 'perp' ? new MarketCache() : null, ctx = cache ? perpContext(cache) : null;
for (const tf of tfs) for (const symbol of universe) {
  const file = dataFile(symbol, tf, kind);
  if (existsSync(file)) { log(`${symbol} ${tf} ${kind} 已冻结`); continue; }
  const w = windowFor(tf);
  try {
    if (kind === 'spot') {
      const got = await load!(symbol, tf, w);
      const bars = got.bars.filter((b) => b.open_time >= w.from_ms && b.close_time <= TO_MS);
      writeFileSync(file, JSON.stringify({ symbol, timeframe: tf, market: 'spot', from_ms: w.from_ms, to_ms: TO_MS, source: got.source, note: got.note ?? null, bars }));
      log(`${symbol} ${tf} spot ${bars.length} 根 ${bars[0] ? new Date(bars[0].open_time).toISOString().slice(0, 10) : '-'}`);
    } else {
      const inst = symbolToInstId(symbol), step = w.step;
      await syncCandles(ctx!, inst, 'trade', tf, w);
      const rows = cache!.candles(inst, 'trade', tf, Math.ceil(w.from_ms / step) * step, TO_MS - step + 1);
      const f8 = (x: number) => x.toFixed(8);
      const bars = rows.map((r) => ({ open_time: r.open_time, close_time: r.open_time + step - 1, available_at: r.open_time + step - 1, open: f8(r.o), high: f8(r.h), low: f8(r.l), close: f8(r.c), volume: f8(r.v) }));
      const funding = bars.length ? await loadFunding(ctx!, inst, { from_ms: bars[0]!.open_time, to_ms: TO_MS }) : null;
      writeFileSync(file, JSON.stringify({ symbol, timeframe: tf, market: 'perp', inst_id: inst, from_ms: w.from_ms, to_ms: TO_MS, source: `okx:perp:${inst}:${tf}:history-candles(成交价);标记价未拉(1 倍杠杆不触发强平)`, funding: funding?.series ?? null, funding_note: funding ? `${funding.provenance.note};覆盖 ${funding.provenance.coverage};${funding.provenance.deviation_note}` : '无 K 线', bars }));
      log(`${symbol} ${tf} perp ${bars.length} 根 ${bars[0] ? new Date(bars[0].open_time).toISOString().slice(0, 10) : '-'} 资金费 ${funding?.series.points.length ?? 0} 期 请求累计 ${ctx!.requests()}`);
    }
  } catch (e) { log(`${symbol} ${tf} ${kind} 失败:${(e as Error).message.slice(0, 300)}`); }
}
db?.close(); cache?.close();
log(`完成 → ${BATCH_DIR}`);
