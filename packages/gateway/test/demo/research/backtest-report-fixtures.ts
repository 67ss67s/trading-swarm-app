// 回测报告测试用的确定性合成行情(几何随机游走 + 周期趋势),只做工程验证,不是经济证据
import type { ResearchBar, ResearchDataset, StrategyIR } from '@trade-gate/contracts';
import { node } from '../../../src/demo/research/strategy.js';
export function synthBars(n: number, step: number, seed = 7, start = Date.UTC(2019, 0, 1), base = 100): ResearchBar[] {
  let s = seed >>> 0; const rnd = () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
  let price = base; const out: ResearchBar[] = [];
  for (let i = 0; i < n; i++) {
    const drift = 0.0006 * Math.sin(i / 180), shock = (rnd() - 0.5) * 0.04, open = price;
    price = Math.max(1, price * (1 + drift + shock));
    const hi = Math.max(open, price) * (1 + rnd() * 0.01), lo = Math.min(open, price) * (1 - rnd() * 0.01);
    const t = start + i * step;
    out.push({ open_time: t, close_time: t + step - 1, available_at: t + step - 1, open: open.toFixed(8), high: hi.toFixed(8), low: lo.toFixed(8), close: price.toFixed(8), volume: (100 + Math.floor(rnd() * 200)).toFixed(8) });
  }
  return out;
}
export function synthDataset(n: number, step: number, symbol = 'BTCUSDT', seed = 7): ResearchDataset {
  const bars = synthBars(n, step, seed);
  return { venue: 'okx', market: 'spot', symbol, timeframe_ms: step, source: 'synthetic engineering fixture', retrieved_at: bars.at(-1)!.close_time + 1, bars };
}
/** 贴近研究 loop 常见产物:EMA 交叉入场 + ATR 止损 + 吊灯线追踪 + 固定 R 目标(optional)。 */
export function emaIR(): StrategyIR {
  return { version: 1, label: 'EMA 交叉', description: '20/50 EMA 金叉入场', signal: [node('ema_cross', { fast: 20, slow: 50 })], entry: node('next_open_market', {}), risk: { stop: node('atr_stop', { atr_period: 14, multiple: 3 }), sizing: node('risk_fraction', { fraction: '0.01', max_allocation: '0.25' }) }, exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 }), node('fixed_r_target', { r: 3 }, true)] };
}
