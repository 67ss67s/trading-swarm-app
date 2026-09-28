/**
 * 4h 永续均线趋势加杠杆研究 · 取标记价(零模型,只读 OKX 公共接口):资产池(universe.json)× 4h 永续,
 * 用 data/perp-market.ts 的 syncCandles(kind='mark')拉标记价 K 线 + loadTiers 拉维持保证金分档与合约面值(分档是当前值,不是历史值),
 * 按批量研究已冻结的成交价 K 线(data/<SYM>-4h-perp.json)的 open_time 对齐,写新的冻结文件
 * ~/.trade-gate-okx/research-batch/perp-trend/data/<SYM>-4h-mark.json;已存在的文件不覆盖。走共享 market-cache.sqlite(只补缺口)。
 * 用法(走 Clash 代理):HTTPS_PROXY=http://127.0.0.1:7897 node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/perp-trend-fetch.ts
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MarketCache, perpContext, syncCandles, loadTiers, symbolToInstId } from '../../packages/gateway/src/demo/research/data/perp-market.ts';
import { configureOkxProxy } from '../../packages/gateway/src/demo/okx-proxy.ts';
import { BATCH_DIR, TO_MS, readFrozen, readUniverse } from './common.ts';

configureOkxProxy();
export const PT_DIR = path.join(BATCH_DIR, 'perp-trend'), PT_DATA = path.join(PT_DIR, 'data');
mkdirSync(PT_DATA, { recursive: true });
const t0 = Date.now(), log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`);
const cache = new MarketCache(), ctx = perpContext(cache), STEP = 4 * 3600000;
for (const symbol of readUniverse()) {
  const file = path.join(PT_DATA, `${symbol}-4h-mark.json`);
  if (existsSync(file)) { log(`${symbol} 已冻结,跳过`); continue; }
  const f = readFrozen(symbol, '4h', 'perp');
  if (!f || !f.bars.length) { log(`${symbol} 没有成交价冻结文件,跳过`); continue; }
  const inst = symbolToInstId(symbol), w = { from_ms: f.bars[0]!.open_time, to_ms: TO_MS };
  try {
    await syncCandles(ctx, inst, 'mark', '4h', w);
    const rows = cache.candles(inst, 'mark', '4h', w.from_ms, TO_MS - STEP + 1), by = new Map(rows.map((r) => [r.open_time, r]));
    // 与成交价 K 线逐根对齐;缺的根为 null(执行核退回成交价并计 mark_fallback)
    const mark = f.bars.map((b) => { const r = by.get(b.open_time); return r ? [r.o, r.h, r.l, r.c] : null; });
    const tiers = await loadTiers(ctx, inst), meta = cache.meta<{ minSz?: string; lotSz?: string; ctVal?: string }>(`instrument:${inst}`)?.value ?? null;
    const missing = mark.filter((m) => !m).length;
    writeFileSync(file, JSON.stringify({ symbol, inst_id: inst, timeframe: '4h', from_ms: w.from_ms, to_ms: TO_MS, source: `okx:${inst} history-mark-price-candles(4H) 与 ${f.source} 按 open_time 对齐`, bars: f.bars.length, mark_missing: missing, mark_first_open: rows[0]?.open_time ?? null, fields: ['open', 'high', 'low', 'close'], mark,
      tiers: tiers.tiers, lever_tiers: tiers.lever_tiers, max_lever: tiers.max_lever, ct_val: tiers.ct_val, ct_mult: tiers.ct_mult, min_sz: meta?.minSz ?? null, lot_sz: meta?.lotSz ?? null, tiers_fetched_at: tiers.fetched_at, tiers_note: '维持保证金分档是取数当天的当前值,不是历史值' }));
    log(`${symbol} 标记价 ${rows.length} 根,对齐缺 ${missing}/${f.bars.length} 根,首根 ${rows[0] ? new Date(rows[0].open_time).toISOString().slice(0, 10) : '-'};分档 ${tiers.tiers.length} 档 max_lever ${tiers.max_lever};请求累计 ${ctx.requests()}`);
  } catch (e) { log(`${symbol} 失败:${(e as Error).message.slice(0, 300)}`); }
}
cache.close();
log(`完成 → ${PT_DATA}`);
