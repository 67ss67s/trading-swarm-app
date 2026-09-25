import type { Kline } from './types.js';
import { pairZ, type PairModel, type PairSetup } from './pair-signals.js';
export interface PairSeries { bars: Kline[]; funding: { at: number; rate: string }[] }
export interface PairSettlement { gross: number; fees: number; slippage: number; funding: number; net: number; entry_at: number; exit_at: number; quantity: string }
/** 实际资金费时点按前一已收盘价格估名义，成交边界只计支出、不计资格不确定的收入。 */
export function settlePairLeg(series: PairSeries, entry: number, exit: number, exitClose: boolean, sign: number, weight: number, multiplier = 1, frozenQuantity?: string): PairSettlement {
  const first = series.bars[entry]!; const last = series.bars[exit]!;
  const from = first.open_time; const to = exitClose ? last.close_time : last.open_time;
  const ep = Number(first.open); const xp = Number(exitClose ? last.close : last.open); const q = frozenQuantity === undefined ? weight / ep : Number(frozenQuantity);
  if (!(q > 0 && Number.isFinite(q))) throw new Error('双腿数量无效');
  const gross = sign * q * (xp - ep); const fees = q * (ep + xp) * 0.0005 * multiplier; const slippage = q * (ep + xp) * 0.0001 * multiplier;
  const funding = series.funding.filter(f => f.at >= from && f.at <= to).reduce((v, f) => {
    const prior = series.bars[Math.max(0, Math.floor((f.at - series.bars[0]!.open_time) / 3600000) - 1)]!;
    const cost = sign * q * Number(prior.close) * Number(f.rate);
    if ((f.at === from || f.at === to) && cost < 0) return v;
    return v + (cost > 0 ? cost * multiplier : cost);
  }, 0);
  return { gross, fees, slippage, funding, net: gross - fees - slippage - funding, entry_at: from, exit_at: to, quantity: String(q) };
}
export function simulatePairOutcome(setup: PairSetup, model: PairModel, a: PairSeries, b: PairSeries, entry: number, multiplier = 1, delayB = 0) {
  if (![0, 1].includes(delayB) || entry < 1 || entry + 24 + delayB >= a.bars.length || a.bars.length !== b.bars.length) throw new Error('双腿结算窗口不足');
  let exit = entry + 23; let close = true; let reason: 'stop' | 'zero' | 'expired' = 'expired';
  for (let i = entry; i < entry + 23; i++) {
    const z = pairZ(model, a.bars[i]!.close, b.bars[i]!.close);
    if (Math.abs(z) >= 3 || z * setup.z <= 0) { exit = i + 1; close = false; reason = Math.abs(z) >= 3 ? 'stop' : 'zero'; break; }
  }
  const sign = setup.direction === 'long_spread' ? 1 : -1; const w = 1 / (1 + setup.hedge_ratio);
  const legs = [settlePairLeg(a, entry, exit, close, sign, w, multiplier), settlePairLeg(b, entry + delayB, exit + delayB, close, -sign, 1 - w, multiplier, String((1 - w) / Number(b.bars[entry]!.open)))];
  const sum = (k: 'gross' | 'fees' | 'slippage' | 'funding' | 'net') => legs.reduce((v, l) => v + l[k], 0);
  let maxExposure = 0;
  for (let i = entry; i <= exit + delayB; i++) {
    // 同时观察开盘成交前、成交后与收盘，包含退出前最后一次价格漂移。
    for (const mark of ['open_before_exit', 'open_after_exit', 'close'] as const) {
      const exposure = legs.reduce((v, l, j) => {
        const bar = (j ? b : a).bars[i]!;
        const at = mark === 'close' ? bar.close_time : bar.open_time;
        const held = at >= l.entry_at && (mark === 'open_after_exit' ? at < l.exit_at : at <= l.exit_at);
        return v + (held ? (j ? -sign : sign) * Number(l.quantity) * Number(mark === 'close' ? bar.close : bar.open) : 0);
      }, 0);
      maxExposure = Math.max(maxExposure, Math.abs(exposure));
    }
  }
  return { at: setup.at, exit_index: exit + delayB, exit_at: legs[1]!.exit_at, reason, legs, gross: sum('gross'), fees: sum('fees'), slippage: sum('slippage'), funding: sum('funding'), net: sum('net'), initial_net_exposure: sign * (2 * w - 1), max_abs_net_exposure: maxExposure, single: settlePairLeg(a, entry, exit, close, sign, 1, multiplier).net };
}
