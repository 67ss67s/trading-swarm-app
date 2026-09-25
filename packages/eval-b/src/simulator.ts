import { demo } from '@trading-swarm/gateway';

import type { SimulatedOutcome } from './types.js';

/** Conservative OHLC simulator: if stop and target touch in one bar, stop wins. */
export function simulateOutcome(judgment: demo.Judgment, future: demo.Kline[], horizonBars = future.length): SimulatedOutcome {
  const proposal = judgment.proposal;
  if (judgment.action !== 'PROPOSE' || !proposal || future.length === 0) {
    return { filled: false, fill_bar_index: null, entry_price: null, exit: 'unfilled', r: null, mae_r: null, mfe_r: null, target_first: false };
  }
  const bars = future.slice(0, horizonBars);
  let fillIndex = 0;
  let entry = Number(bars[0]!.open);
  if (proposal.entry === 'limit') {
    entry = Number(proposal.limit_price);
    fillIndex = bars.findIndex((bar) => Number(bar.low) <= entry && entry <= Number(bar.high));
    if (fillIndex < 0) {
      return { filled: false, fill_bar_index: null, entry_price: null, exit: 'unfilled', r: null, mae_r: null, mfe_r: null, target_first: false };
    }
  }
  const stop = Number(proposal.stop_price);
  const targetText = proposal.take_profit_price ?? proposal.take_profits[0] ?? null;
  const target = targetText === null ? null : Number(targetText);
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !Number.isFinite(stop)) {
    return { filled: true, fill_bar_index: fillIndex, entry_price: entry, exit: 'expiry', r: null, mae_r: null, mfe_r: null, target_first: false };
  }
  let mae = 0;
  let mfe = 0;
  for (let index = fillIndex; index < bars.length; index++) {
    const bar = bars[index]!;
    const low = Number(bar.low);
    const high = Number(bar.high);
    const adverse = proposal.direction === 'long' ? (low - entry) / risk : (entry - high) / risk;
    const favorable = proposal.direction === 'long' ? (high - entry) / risk : (entry - low) / risk;
    mae = Math.min(mae, adverse);
    mfe = Math.max(mfe, favorable);
    const stopHit = proposal.direction === 'long' ? low <= stop : high >= stop;
    const targetHit = target !== null && (proposal.direction === 'long' ? high >= target : low <= target);
    if (stopHit) {
      return { filled: true, fill_bar_index: fillIndex, entry_price: entry, exit: 'stop', r: -1, mae_r: mae, mfe_r: mfe, target_first: false };
    }
    if (targetHit && target !== null) {
      return {
        filled: true,
        fill_bar_index: fillIndex,
        entry_price: entry,
        exit: 'take_profit',
        r: Math.abs(target - entry) / risk,
        mae_r: mae,
        mfe_r: mfe,
        target_first: true,
      };
    }
  }
  const close = Number(bars.at(-1)!.close);
  const r = proposal.direction === 'long' ? (close - entry) / risk : (entry - close) / risk;
  return { filled: true, fill_bar_index: fillIndex, entry_price: entry, exit: 'expiry', r, mae_r: mae, mfe_r: mfe, target_first: false };
}
