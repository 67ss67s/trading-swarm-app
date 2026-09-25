import { describe, it, expect } from 'vitest';
import type { ResearchBar } from '@trading-swarm/contracts';
import { registry } from '../../../src/demo/research/primitives/index.js';
import { checkIR, defaultIR, node } from '../../../src/demo/research/strategy.js';

const T0 = Date.UTC(2025, 0, 1), STEP = 3600000;
const raw = (i: number, o: number, h: number, l: number, c: number): ResearchBar =>
  ({ open_time: T0 + i * STEP, close_time: T0 + (i + 1) * STEP - 1, open: o.toFixed(4), high: h.toFixed(4), low: l.toFixed(4), close: c.toFixed(4), volume: '100' });
/** 只给收盘路径,上下影固定 ±0.5:pivot 结构与收盘同形,便于手算。 */
const mk = (closes: number[]) => closes.map((c, i) => raw(i, c, c + 0.5, c - 0.5, c));
/** 上下翻转成镜像行情(双底 → 双顶) */
const flip = (bars: ResearchBar[]) => bars.map((b, i) => raw(i, 200 - Number(b.open), 200 - Number(b.low), 200 - Number(b.high), 200 - Number(b.close)));
const position = (bars: ResearchBar[]) => ({ entry_at: bars[0]!.open_time, entry_price: 100, initial_distance: 5, bars_held: 5 });
const fired = (name: string, bars: ResearchBar[], p: Record<string, unknown>, withPosition = false) =>
  bars.map((_, i) => {
    const v = registry.get(name)!.compute({ bars, i, timeframe_ms: STEP, ...(withPosition ? { position: position(bars) } : {}) }, p);
    return (v.pass || v.exit) ? i : -1;
  }).filter((i) => i >= 0);

/** W 形:低点 6(95)、颈线高点 12(105)、低点 18(95.2),第 23 根收盘突破颈线。 */
const wShape = () => mk([110, 108, 106, 104, 102, 100, 95, 97, 99, 101, 103, 105, 107, 105, 103, 101, 99, 97, 95.2, 97, 99, 103, 106, 108, 110, 112, 114, 116, 118, 120]);
/** 头肩底:左肩 4、颈线 6、头 9、颈线 12、右肩 15,第 18 根收盘突破颈线 109.5。 */
const hsShape = () => mk([112, 110, 108, 104, 100, 104, 108, 105, 100, 96, 100, 106, 109, 106, 102, 100.5, 104, 108, 112, 114, 116, 118, 120]);

describe('形态原语:双底与双顶', () => {
  const p = { swing_length: 2, lookback: 50, tolerance_pct: 1 };
  it('双底在收盘首次突破颈线那一根触发一次,之后不重复', () => {
    expect(fired('double_bottom', wShape(), p)).toEqual([23]);
  });
  it('两个低点差得太远时形态不成立', () => {
    const bars = mk([110, 108, 106, 104, 102, 100, 95, 97, 99, 101, 103, 105, 107, 105, 103, 101, 99, 97, 88, 97, 99, 103, 106, 108, 110, 112, 114, 116, 118, 120]);
    expect(fired('double_bottom', bars, p)).toEqual([]);
  });
  it('双顶是离场原语:镜像行情里跌破颈线当根离场,无持仓不触发', () => {
    const bars = flip(wShape());
    expect(fired('double_top_exit', bars, p, false)).toEqual([]);
    expect(fired('double_top_exit', bars, p, true)).toEqual([23]);
  });
  it('warmup = 2×swing + lookback + 2', () => {
    expect(registry.get('double_bottom')!.warmup_bars(p)).toBe(2 * 2 + 50 + 2);
  });
});

describe('形态原语:头肩底', () => {
  const p = { swing_length: 2, lookback: 50, tolerance_pct: 2 };
  it('左右肩齐平、头部更低,收盘突破两个颈线高点的较高者那一根触发', () => {
    expect(fired('head_and_shoulders_inverse', hsShape(), p)).toEqual([18]);
  });
  it('头部不比两肩低时不成立', () => {
    const bars = mk([112, 110, 108, 104, 100, 104, 108, 105, 102, 101, 103, 106, 109, 106, 102, 100.5, 104, 108, 112, 114, 116, 118, 120]);
    expect(fired('head_and_shoulders_inverse', bars, p)).toEqual([]);
  });
});

describe('形态原语:K 线形态', () => {
  it('看涨吞没要求前一根为阴线且实体被完全包住', () => {
    const bars = [raw(0, 100, 101, 99, 100), raw(1, 105, 105.5, 99.5, 100), raw(2, 99, 106.5, 98.5, 106), raw(3, 106, 107, 105, 106.5)];
    expect(fired('bullish_engulfing', bars, { min_body_ratio: 1 })).toEqual([2]);
    expect(fired('bullish_engulfing', bars, { min_body_ratio: 2 })).toEqual([]); // 实体 7 不足前一根 5 的两倍
  });
  it('看跌吞没是离场原语,需要持仓', () => {
    const bars = [raw(0, 100, 101, 99, 100), raw(1, 100, 106, 99.5, 105), raw(2, 106, 106.5, 98.5, 99), raw(3, 99, 100, 98, 99.5)];
    expect(fired('bearish_engulfing_exit', bars, { min_body_ratio: 1 }, false)).toEqual([]);
    expect(fired('bearish_engulfing_exit', bars, { min_body_ratio: 1 }, true)).toEqual([2]);
  });
  it('锤子线要求长下影、小实体、短上影', () => {
    const p = { tail_ratio: 2, max_body_pct: 0.34, max_upper_pct: 0.2 };
    expect(fired('pin_bar', [raw(0, 100, 101, 95, 100.5)], p)).toEqual([0]);
    expect(fired('pin_bar', [raw(0, 100, 106, 99.5, 105)], p)).toEqual([]);   // 大阳线不是针
    expect(fired('pin_bar', [raw(0, 100, 104, 95, 100.5)], p)).toEqual([]);   // 上影过长
  });
  it('看涨 FVG 要求第一根高点低于第三根低点且中间是阳线', () => {
    const gap = [raw(0, 99, 100, 98, 99.5), raw(1, 99, 104.5, 98.8, 104), raw(2, 104, 106, 101, 105)];
    expect(fired('fair_value_gap', gap, { min_gap_pct: 0.3 })).toEqual([2]);
    expect(fired('fair_value_gap', gap, { min_gap_pct: 5 })).toEqual([]);      // 缺口宽度不够
    const noGap = [raw(0, 99, 102, 98, 101.5), raw(1, 101, 104.5, 100.8, 104), raw(2, 104, 106, 101, 105)];
    expect(fired('fair_value_gap', noGap, { min_gap_pct: 0.3 })).toEqual([]);
  });
  it('内包突破:母线后有内包线且收盘首次越过母线高点', () => {
    const bars = [raw(0, 100, 110, 100, 105), raw(1, 105, 108, 102, 106), raw(2, 106, 112, 105, 111), raw(3, 111, 113, 110, 112)];
    expect(fired('inside_bar_breakout', bars, { max_inside_bars: 3 })).toEqual([2]);
    const noInside = [raw(0, 100, 110, 100, 105), raw(1, 105, 111, 99, 106), raw(2, 106, 112, 105, 111)];
    expect(fired('inside_bar_breakout', noInside, { max_inside_bars: 3 })).toEqual([]);
  });
});

describe('形态原语接入 IR 检查', () => {
  it('双底入场 + 看跌吞没离场的 IR 通过全部检查', () => {
    const ir = defaultIR();
    ir.signal = [node('double_bottom', { swing_length: 3, lookback: 60, tolerance_pct: 1.5 })];
    ir.exit.push(node('bearish_engulfing_exit', { min_body_ratio: 1 }));
    const r = checkIR(ir, '1h');
    expect(r.ok, JSON.stringify(r.checks)).toBe(true);
  });
});
