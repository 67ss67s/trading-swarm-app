/** 研究脚本共用:从 fetch.ts 冻结的 JSON 组装 FrozenData(训练 50% / 验证 25% / 留出 25%,按共同时间轴切)。 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ResearchBar } from '@trade-gate/contracts';
import type { FrozenData } from '../../packages/gateway/src/demo/research/improve/types.ts';

export const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'BNBUSDT'];
export const DATA_DIR = path.join(homedir(), '.trade-gate-okx', 'research-oracle');
export const TO_MS = Date.UTC(2026, 8, 23) - 1;
export function loadFrozen(to_ms = TO_MS): FrozenData {
  const files = readdirSync(DATA_DIR);
  const assets = UNIVERSE.map((symbol) => {
    const f = files.find((x) => x === `${symbol}-1h-${to_ms}.json`);
    if (!f) throw Error(`缺 ${symbol} 数据,先跑 fetch.ts`);
    const j = JSON.parse(readFileSync(path.join(DATA_DIR, f), 'utf8')) as { bars: ResearchBar[] };
    return { symbol, dataset_id: `oracle:${symbol}:1h:${to_ms}`, bars: j.bars };
  });
  const from = Math.max(...assets.map((a) => a.bars[0]!.open_time)), to = Math.min(...assets.map((a) => a.bars.at(-1)!.close_time));
  const H = 3600000, span = to - from, cutAt = (f: number) => Math.floor((from + span * f) / H) * H - 1; // 切点对齐到整点收盘
  const t1 = cutAt(0.5), t2 = cutAt(0.75);
  // 训练段内 4 折(改进环主体用;oracle 不用)
  const folds = [0, 1, 2, 3].map((k) => ({ from_ms: from + Math.floor(((t1 - from) * k) / 4), to_ms: from + Math.floor(((t1 - from) * (k + 1)) / 4) }));
  return { universe: UNIVERSE, timeframe: '1h', timeframe_ms: 3600000, assets, warmup_bars: 300, segments: { folds, train: { from_ms: from, to_ms: t1 }, validation: { from_ms: t1 + 1, to_ms: t2 }, holdout: { from_ms: t2 + 1, to_ms: to } } };
}
