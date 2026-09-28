/**
 * §9.53 C 盘口 / 清算特征的数据源:读本机录制器(~/.trade-gate-okx/micro/recorder.mjs)写下的 gzip jsonl。
 * 实盘与回测同一个源 —— 只取 as_of 之前已落盘的帧,不现拉、不回填;没覆盖的资产 / 时段返回 null(判断臂标数据不可评)。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recordingMicrostructure } from './research/judge/recordings.js';
import type { MicrostructureSource } from './research/judge/microstructure.js';

/** OKX 线性 USDT 永续面值(基础币/张),冻结;录制器只录这两个。 */
export const MICRO_INSTRUMENTS = {
  BTCUSDT: { inst_id: 'BTC-USDT-SWAP', base_per_contract: '0.01' },
  ETHUSDT: { inst_id: 'ETH-USDT-SWAP', base_per_contract: '0.1' },
} as const;
/** 旧帧(无 available_at)的 at 是一轮开始时刻:每个品种最多 15s+2s+15s,两个品种串行 ≈64s,再留余量。 */
export const MICRO_LAG_BOUND_MS = 70_000;

let cached: MicrostructureSource | null = null;
export function recorderMicrostructure(dir = process.env.TG_MICRO_DIR ?? join(homedir(), '.trade-gate-okx/micro/data')): MicrostructureSource {
  if (cached && !process.env.TG_MICRO_DIR) return cached;
  const src = recordingMicrostructure({ directory: dir, instruments: MICRO_INSTRUMENTS, availability_lag_bound_ms: MICRO_LAG_BOUND_MS });
  // 目录不存在 / 读坏 → 当作没覆盖(null),不让判断因为 IO 抛错
  const safe: MicrostructureSource = async (symbol, as_of) => { try { return await src(symbol, as_of); } catch { return null; } };
  if (!process.env.TG_MICRO_DIR) cached = safe;
  return safe;
}
