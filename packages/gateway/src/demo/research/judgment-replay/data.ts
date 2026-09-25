/**
 * 冻结数据的来源读取(只读)。
 *  - spot:OKX 现货 1h,取自 `~/.trading-swarm-okx/demo/state.sqlite` 的 research_datasets(与几何实验室同源,取覆盖最长的一份)。
 *  - perp:OKX USDT 永续 1h 成交价 K 线 + OKX 资金费,取自研究行情缓存 `~/.trading-swarm/research/market-cache.sqlite`。
 * 两个源库都只以只读方式打开;打不开(WAL 需要写 -shm)时复制到临时目录再读,绝不写源库。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { H1, type Bar, type Venue } from './types.js';

export interface FrozenSeries {
  venue: Venue;
  symbol: string;
  source: string;
  source_id: string;
  bars: Bar[];
  sha256: string;
  /** 相邻两根 open_time 差不是 1h 的次数 */
  gaps: number;
}

export interface FundingPoint {
  at: number;
  rate: string;
}

export function barsHash(bars: readonly Bar[]): string {
  return createHash('sha256').update(JSON.stringify(bars)).digest('hex');
}

export function countGaps(bars: readonly Bar[]): number {
  let g = 0;
  for (let i = 1; i < bars.length; i++) if (bars[i]!.open_time - bars[i - 1]!.open_time !== H1) g++;
  return g;
}

/** 只读打开;失败则复制(连同 -wal)到临时目录再读。返回 [db, cleanup]。 */
function openReadOnly(path: string): [DatabaseSync, () => void] {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.prepare('SELECT 1').get();
    return [db, () => db.close()];
  } catch {
    const dir = mkdtempSync(join(tmpdir(), 'jr-src-'));
    const copy = join(dir, 'src.sqlite');
    copyFileSync(path, copy);
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    const db = new DatabaseSync(copy);
    return [
      db,
      () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    ];
  }
}

function checkAscending(symbol: string, bars: Bar[]): void {
  for (let i = 1; i < bars.length; i++) if (bars[i]!.open_time <= bars[i - 1]!.open_time) throw new Error(`${symbol}: bars not ascending at ${i}`);
}

/** 现货:同一 symbol 的 1h 数据集里覆盖最长的那份。 */
export function readSpot(stateDb: string, symbols: readonly string[]): FrozenSeries[] {
  const [db, done] = openReadOnly(stateDb);
  try {
    const out: FrozenSeries[] = [];
    for (const symbol of symbols) {
      const row = db
        .prepare(
          `SELECT id, json FROM research_datasets WHERE json_extract(json,'$.symbol')=? AND json_extract(json,'$.timeframe_ms')=3600000 AND json_extract(json,'$.market')='spot'
           ORDER BY json_array_length(json_extract(json,'$.bars')) DESC, created_at DESC LIMIT 1`,
        )
        .get(symbol) as { id: string; json: string } | undefined;
      if (!row) throw new Error(`spot dataset missing: ${symbol}`);
      const d = JSON.parse(row.json) as { source: string; bars: Bar[] };
      const bars = d.bars.map((b) => ({ open_time: b.open_time, close_time: b.close_time, available_at: b.available_at ?? b.close_time, open: String(b.open), high: String(b.high), low: String(b.low), close: String(b.close), volume: String(b.volume) }));
      checkAscending(symbol, bars);
      out.push({ venue: 'spot', symbol, source: `okx spot 1h · research_datasets · ${d.source}`, source_id: row.id, bars, sha256: barsHash(bars), gaps: countGaps(bars) });
    }
    return out;
  } finally {
    done();
  }
}

export const instOf = (symbol: string): string => `${symbol.replace(/USDT$/, '')}-USDT-SWAP`;

/** 永续:OKX 成交价 1h K 线 + OKX 资金费(不混币安代理)。 */
export function readPerp(marketDb: string, symbols: readonly string[]): { series: FrozenSeries[]; funding: Map<string, FundingPoint[]> } {
  const [db, done] = openReadOnly(marketDb);
  try {
    const series: FrozenSeries[] = [];
    const funding = new Map<string, FundingPoint[]>();
    for (const symbol of symbols) {
      const inst = instOf(symbol);
      const rows = db.prepare(`SELECT open_time,o,h,l,c,v FROM candles WHERE inst=? AND kind='trade' AND tf='1h' ORDER BY open_time`).all(inst) as { open_time: number; o: number; h: number; l: number; c: number; v: number }[];
      if (!rows.length) throw new Error(`perp candles missing: ${inst}`);
      const bars: Bar[] = rows.map((r) => ({ open_time: r.open_time, close_time: r.open_time + H1 - 1, available_at: r.open_time + H1 - 1, open: String(r.o), high: String(r.h), low: String(r.l), close: String(r.c), volume: String(r.v) }));
      checkAscending(symbol, bars);
      series.push({ venue: 'perp', symbol, source: `okx ${inst} 1h trade candles · market-cache`, source_id: `${inst}:trade:1h:${bars[0]!.open_time}-${bars.at(-1)!.open_time}`, bars, sha256: barsHash(bars), gaps: countGaps(bars) });
      const f = db.prepare(`SELECT ts, rate FROM funding WHERE inst=? AND source='okx' ORDER BY ts`).all(inst) as { ts: number; rate: number }[];
      funding.set(symbol, f.map((x) => ({ at: x.ts, rate: String(x.rate) })));
    }
    return { series, funding };
  } finally {
    done();
  }
}
