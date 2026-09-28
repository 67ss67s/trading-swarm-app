/** 批量研究脚本共用:目录、固定截止时刻、各周期窗口、数据文件命名。 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { timeframeMillis } from '../../packages/gateway/src/demo/research/strategy.ts';

export const BATCH_DIR = path.join(homedir(), '.trade-gate-okx', 'research-batch');
export const DATA_DIR = path.join(BATCH_DIR, 'data');
/** 固定截止:2026-09-23 00:00 UTC 之前最后一毫秒,重跑逐位一致 */
export const TO_MS = Date.UTC(2026, 8, 23) - 1;
const DAY = 86400000, EARLIEST = Date.UTC(2018, 0, 1);
export const TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
/** 取数窗口(含向前借的 301 根预热) */
export function windowFor(tf: string): { from_ms: number; to_ms: number; step: number } {
  const step = timeframeMillis(tf), days = tf === '15m' ? 365 : tf === '1h' ? 730 : null;
  const from = days ? TO_MS + 1 - days * DAY - 301 * step : EARLIEST;
  return { from_ms: from, to_ms: TO_MS, step };
}
export const dataFile = (symbol: string, tf: string, market: 'spot' | 'perp') => path.join(DATA_DIR, `${symbol}-${tf}-${market}.json`);
export function readUniverse(): string[] { return (JSON.parse(readFileSync(path.join(BATCH_DIR, 'universe.json'), 'utf8')) as { members: { symbol: string }[] }).members.map((m) => m.symbol); }

// ---------- 冻结数据 → 改进环/批量评估的输入 ----------
import { existsSync } from 'node:fs';
import type { ResearchBar } from '@trade-gate/contracts';
import type { FundingSeries } from '../../packages/gateway/src/demo/research/orders/types.ts';
import type { FrozenAsset, FrozenData, Segments } from '../../packages/gateway/src/demo/research/improve/types.ts';
import { makeSegments } from '../../packages/gateway/src/demo/research/improve/data.ts';
import { completeBuckets } from '../../packages/gateway/src/demo/research/primitives/structure.ts';

export interface FrozenFile { symbol: string; timeframe: string; market: 'spot' | 'perp'; bars: ResearchBar[]; funding?: FundingSeries | null; source: string; funding_note?: string }
export function readFrozen(symbol: string, tf: string, market: 'spot' | 'perp'): FrozenFile | null {
  // 日线由 4h 同源聚合(OKX 日线接口只回到 2020-01,4h 可到 2018-01);资金费取 4h 文件里的同一序列
  if (tf === '1d') {
    const f = readFrozen(symbol, '4h', market); if (!f) return null;
    return { ...f, timeframe: '1d', bars: completeBuckets(f.bars, 4 * 3600000, 86400000), source: f.source + ' → UTC 日聚合' };
  }
  const file = dataFile(symbol, tf, market); if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as FrozenFile;
}
/** 某周期 × 市场的切段:参考资产 = 该市场的 BTC(永续 4h/1d 历史从 2020-01 起,比现货短,所以按市场各切各的),前 300 根预热,50/25/25(与改进环 makeSegments 同一实现) */
export function segmentsFor(tf: string, market: 'spot' | 'perp' = 'spot'): Segments { const f = readFrozen('BTCUSDT', tf, market); if (!f) throw Error(`缺 BTCUSDT ${tf} ${market} 数据`); return makeSegments(f.bars, f.bars[0]!.close_time); }
/** 冻结资产池(现货或永续)→ FrozenData;永续资产带 perp 输入(标记价缺,1 倍杠杆不触发强平) */
export function frozenData(tf: string, market: 'spot' | 'perp', universe = readUniverse()): { data: FrozenData; missing: string[] } {
  const assets: FrozenAsset[] = [], missing: string[] = [];
  for (const symbol of universe) {
    const f = readFrozen(symbol, tf, market);
    if (!f || f.bars.length < 400) { missing.push(symbol); continue; }
    assets.push({ symbol, dataset_id: `batch:${symbol}:${tf}:${market}`, bars: f.bars, ...(market === 'perp' ? { perp: { mark: f.bars.map(() => null), funding: f.funding ?? { points: [], from_ms: 0, to_ms: -1 }, tiers: [], max_lever: null } } : {}) });
  }
  return { data: { universe: assets.map((a) => a.symbol), timeframe: tf, timeframe_ms: timeframeMillis(tf), assets, segments: segmentsFor(tf, market), warmup_bars: 300, market }, missing };
}
