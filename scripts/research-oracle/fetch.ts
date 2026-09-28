/**
 * oracle 研究取数:6 个现货 × 1h × 最近 2 年,走 backtest-report 的 okxLoader(先读 research_datasets 缓存,缺的头尾从 OKX 公共 K 线补)。
 * 只读打开 state.sqlite(不写库);结果冻结成 JSON 放 ~/.trade-gate-okx/research-oracle/,研究脚本从这里读,重跑完全一致。
 * 用法:node --experimental-transform-types --import ./scripts/research-oracle/register.mjs scripts/research-oracle/fetch.ts [TO_MS]
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { okxLoader } from '../../packages/gateway/src/demo/research/backtest-report.ts';
import { ResearchStore } from '../../packages/gateway/src/demo/research/store.ts';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'BNBUSDT'];
const HOUR = 3600000;
const to_ms = Number(process.argv[2] ?? Math.floor(Date.now() / HOUR) * HOUR - 1);
const from_ms = to_ms + 1 - 730 * 86400000;
const dir = path.join(homedir(), '.trade-gate-okx', 'research-oracle');
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(homedir(), '.trade-gate-okx', 'demo', 'state.sqlite'), { readOnly: true });
const store = new ResearchStore(db);
const load = okxLoader({ store, service: null as never });
for (const symbol of UNIVERSE) {
  const file = path.join(dir, `${symbol}-1h-${to_ms}.json`);
  if (existsSync(file)) { console.log(symbol, 'cached', file); continue; }
  const t0 = Date.now();
  const got = await load(symbol, '1h', { from_ms, to_ms });
  const bars = got.bars.filter((b) => b.open_time >= from_ms && b.close_time <= to_ms);
  writeFileSync(file, JSON.stringify({ symbol, timeframe: '1h', from_ms, to_ms, source: got.source, bars }));
  console.log(symbol, bars.length, 'bars', new Date(bars[0]!.open_time).toISOString(), '→', new Date(bars.at(-1)!.close_time).toISOString(), `${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
db.close();
