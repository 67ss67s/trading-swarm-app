import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { schemas, type ResearchBar } from '@trading-swarm/contracts';
import { registry } from '../../../src/demo/research/primitives/index.js';
import { smcCompute, smcStateAt, smcOverlay, smcParamsFromIR, SMC_PRIMITIVES } from '../../../src/demo/research/primitives/smc.js';
import { checkIR, defaultIR, node, applyOrderPhrases } from '../../../src/demo/research/strategy.js';

const T0 = Date.UTC(2025, 0, 1), STEP = 3600000;
const raw = (i: number, o: number, h: number, l: number, c: number): ResearchBar =>
  ({ open_time: T0 + i * STEP, close_time: T0 + (i + 1) * STEP - 1, open: o.toFixed(4), high: h.toFixed(4), low: l.toFixed(4), close: c.toFixed(4), volume: '100' });
/** 只给收盘路径:开盘 = 上一根收盘,影线在实体外各 0.5,便于手算 pivot 与订单块 */
const mk = (closes: number[]) => closes.map((c, i) => { const o = i ? closes[i - 1]! : c; return raw(i, o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c); });
/** 确定性随机游走(LCG),用来测因果与性能 */
function walk(n: number, seed = 7): ResearchBar[] {
  let s = seed, px = 30000; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, (_, i) => { const o = px, drift = (rnd() - 0.5) * 0.03 * px; px = Math.max(100, px + drift); const h = Math.max(o, px) * (1 + rnd() * 0.01), l = Math.min(o, px) * (1 - rnd() * 0.01); return { open_time: T0 + i * 4 * STEP, close_time: T0 + (i + 1) * 4 * STEP - 1, open: o.toFixed(2), high: h.toFixed(2), low: l.toFixed(2), close: px.toFixed(2), volume: '1' }; });
}
const clone = (bars: ResearchBar[]) => bars.map((b) => ({ ...b }));
const P = { internal_length: 2, swing_length: 20, ob_filter: 'none' };
/** 上涨 → 回落 → 更低(CHoCH 向下)→ 反弹并突破下跌段起点(CHoCH 向上) */
const path = () => mk([100, 102, 104, 106, 104, 102, 100, 103, 106, 109, 112, 109, 106, 103, 100, 97, 94, 97, 100, 103, 106, 109, 112, 115, 118]);

describe('SMC 市场结构', () => {
  it('BOS/CHoCH 按收盘确认,pivot 确认前不参与判定', () => {
    const m = smcCompute(path(), P);
    // pivot 高点 3(106.5)在第 5 根确认,第 9 根收盘 109 首次越过 → BOS(此前无趋势)
    // pivot 低点 6(99.5)在第 8 根确认,第 15 根收盘 97 跌破 → CHoCH 向下;pivot 高点 10(112.5)在第 23 根收盘 115 被越过 → CHoCH 向上
    expect(m.breaks.map((b) => [b.index, b.pivot, b.level, b.kind, b.dir])).toEqual([[9, 3, 106.5, 'BOS', 1], [15, 6, 99.5, 'CHoCH', -1], [23, 10, 112.5, 'CHoCH', 1]]);
    expect(m.states.map((s) => s.internal.trend).slice(8, 24)).toEqual([0, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1, -1, 1]);
    // 同向第二次突破为 BOS:再抬高一个低点后跌破
    const more = smcCompute(mk([100, 102, 104, 106, 104, 102, 100, 103, 106, 109, 112, 109, 106, 108, 110, 113, 116]), P);
    expect(more.breaks.map((b) => [b.index, b.kind, b.dir])).toEqual([[9, 'BOS', 1], [15, 'BOS', 1]]);
    // 影线确认:第 8 根上影 107 已越过 106.5,比收盘确认早一根
    const spiky = path(); spiky[8] = raw(8, 103, 107, 102.5, 106);
    expect(smcCompute(spiky, P).breaks[0]!.index).toBe(9); expect(smcCompute(spiky, { ...P, confirmation: 'wick' }).breaks[0]!.index).toBe(8);
  });
  it('摆动级别用更长的 pivot,和内部级别各自记趋势', () => {
    // swing_length=5:第 10 根 112.5 在第 15 根确认为摆动高点,第 23 根收盘越过 → 摆动级别的首次 BOS;此时内部级别是 CHoCH
    const m = smcCompute(path(), { ...P, swing_length: 5 });
    expect(m.breaks.filter((b) => b.scope === 'swing').map((b) => [b.index, b.kind])).toEqual([[23, 'BOS']]);
    expect(m.states[16]!.swing.trend).toBe(0); expect(m.states[16]!.internal.trend).toBe(-1); expect(m.states[23]!.swing.trend).toBe(1);
  });
});

describe('SMC 订单块', () => {
  it('突破时取回落段最低处的最后一根反向 K 线,记录失效(影线/收盘口径)', () => {
    const m = smcCompute(path(), P), bull = m.blocks.find((b) => b.dir === 1)!, bear = m.blocks.find((b) => b.dir === -1)!;
    // 第 3→8 根回落最低在第 6 根(阴线 102→100),块 [99.5, 102.5],第 9 根形成,第 15 根影线跌破 99.5 失效
    expect(bull).toMatchObject({ index: 6, formed: 9, bottom: 99.5, top: 102.5, mitigated: 15 });
    // 看跌块:第 6→14 根反弹最高在第 10 根(阳线 109→112),块 [108.5, 112.5];第 22 根高点 112.5 不算越过,第 23 根越过上沿失效
    expect(bear).toMatchObject({ index: 10, formed: 15, bottom: 108.5, top: 112.5, mitigated: 23 });
    // 收盘口径:第 14 根影线 99.5 不破,第 15 根收盘 97 < 99.5 → 同样第 15 根;把第 15 根改成长下影收回,影线口径失效、收盘口径不失效
    const bars = path(); bars[15] = raw(15, 100, 100.5, 99, 100.2);
    const wick = smcCompute(bars, P).blocks.find((b) => b.dir === 1)!, close = smcCompute(bars, { ...P, mitigation: 'close' }).blocks.find((b) => b.dir === 1)!;
    expect(wick.mitigated).toBe(15); expect(close.mitigated === null || close.mitigated > 15).toBe(true);
  });
  it('回踩 = 形成之后被影线触及且未失效;快照里的块不带事后失效信息', () => {
    const bars = mk([100, 102, 104, 106, 104, 102, 100, 103, 106, 109, 112, 109, 106, 103, 102.6, 104, 106]);
    const m = smcCompute(bars, P);
    // 第 13/14/15 根低点 102.5/102.1/102.1 ≤ 块上沿 102.5 → 回踩;形成那根(第 9 根)不算
    expect(m.states.map((s, i) => (s.internal.retest_bull ? i : -1)).filter((i) => i >= 0)).toEqual([13, 14, 15]);
    expect(m.states[9]!.internal.bull).toEqual({ top: 102.5, bottom: 99.5, index: 6, formed: 9 });
    expect(m.states[8]!.internal.bull).toBeNull();
  });
  it('高波动 K 线不被挑作订单块', () => {
    // 第 6 根是振幅巨大的阴线(低 90),过滤后改取次低的第 5 根阴线
    const bars = path(); bars[6] = raw(6, 102, 102.5, 90, 100);
    const on = smcCompute(bars, { ...P, ob_filter: 'range' }).blocks.find((b) => b.dir === 1)!, off = smcCompute(bars, P).blocks.find((b) => b.dir === 1)!;
    expect(off.index).toBe(6); expect(on.index).toBe(5);
  });
});

describe('SMC FVG / 等高等低 / 区间', () => {
  it('三根 K 线缺口 + 自动阈值过滤小缺口;触及与回补分开记', () => {
    const b: ResearchBar[] = [raw(0, 100, 100.5, 99.5, 100), raw(1, 100, 100.6, 99.8, 100.2), raw(2, 100.2, 100.7, 100, 100.5),
      raw(3, 100.5, 103, 100.4, 102.8), raw(4, 102.8, 103.5, 101, 103.2), // 缺口 1:[100.7, 101] ≈ 0.30%
      raw(5, 103.2, 103.4, 102.9, 103.3), raw(6, 103.3, 103.5, 103.1, 103.4), raw(7, 103.4, 103.9, 103.3, 103.8), raw(8, 103.8, 104, 103.55, 103.9), // 缺口 2:[103.5, 103.55] ≈ 0.05%
      raw(9, 103.9, 103.95, 100.9, 101), raw(10, 101, 101.2, 100.6, 100.8)]; // 第 9 根进入缺口 1,第 10 根到达下沿回补(同时第 8→10 根形成一个看跌缺口)
    const auto = smcCompute(b), all = smcCompute(b, { fvg_auto: false }), bull = (m: typeof auto) => m.gaps.filter((g) => g.dir === 1).map((g) => [g.index, g.bottom, g.top]);
    expect(bull(auto)).toEqual([[2, 100.7, 101]]);
    expect(bull(all)).toEqual([[2, 100.7, 101], [6, 103.5, 103.55]]);
    expect(auto.gaps.find((g) => g.dir === -1)).toMatchObject({ index: 8, formed: 10, bottom: 101.2, top: 103.55 });
    expect(auto.gaps[0]).toMatchObject({ touched: 9, filled: 10 });
    expect(auto.states[9]!.fvg_touch_bull).toBe(true); expect(auto.states[9]!.fvg_fill_bull).toBe(false); expect(auto.states[10]!.fvg_fill_bull).toBe(true);
  });
  it('等高点按 ATR 容差识别,被影线越过记为扫掉', () => {
    const closes = [100, 104, 108, 104, 100, 104, 108.02, 104, 100, 104, 107, 110];
    const m = smcCompute(mk(closes), { eq_length: 2, atr_period: 3, eq_threshold: 0.1 });
    const e = m.equals.find((x) => x.kind === 'EQH')!;
    expect(e).toMatchObject({ a: 2, b: 6, level: 108.52, confirmed: 8, swept: 11 });
    expect(m.states[9]!.eqh).toBe(108.52); expect(m.states[11]!.eqh).toBeNull();
    // 容差 0 → 不算等高
    expect(smcCompute(mk(closes), { eq_length: 2, atr_period: 3, eq_threshold: 0 }).equals).toHaveLength(0);
  });
  it('溢价/折价区按摆动高低划分;强弱高低跟摆动趋势', () => {
    const m = smcCompute(path(), { ...P, swing_length: 3 }), s = m.states[18]!; // 摆动趋势向下后反弹到 100
    expect(s.top).toBe(112.5); expect(s.bottom).toBe(93.5); expect(s.swing.trend).toBe(-1);
    const pass = (zone: string, i: number) => !!registry.get('smc_discount')!.compute({ bars: path(), i, timeframe_ms: STEP }, { ...P, swing_length: 3, zone }).pass;
    expect(pass('discount', 18)).toBe(true); expect(pass('premium', 18)).toBe(false);
    const ov = smcOverlay(path(), { ...P, swing_length: 3 });
    expect(ov.zones).toMatchObject({ premium: { top: 118.5 }, strong_low: true, strong_high: false }); // 最后一根突破后趋势向上 → 低点为强
  });
});

describe('SMC 原语', () => {
  const ctx = (bars: ResearchBar[], i: number, extra: Record<string, unknown> = {}) => ({ bars, i, timeframe_ms: STEP, ...extra });
  it('全部 8 个原语已登记、参数 schema 在契约里、warmup 与 describe 可用', () => {
    for (const name of SMC_PRIMITIVES) { const p = registry.get(name)!; expect(p, name).toBeDefined(); expect(p.params, name).toBeTruthy(); expect(p.warmup_bars({}, STEP)).toBeGreaterThan(0); expect(p.describe({})).toContain('SMC'); }
    expect(registry.get('smc_trend')!.warmup_bars({}, STEP)).toBe(102);
    expect(registry.get('smc_ob_level')!.warmup_bars({ atr_period: 50, internal_length: 5 }, STEP)).toBe(51);
    expect(registry.get('smc_bos')!.warmup_bars({ scope: 'swing', swing_length: 30 }, STEP)).toBe(62);
  });
  it('smc_bos / smc_trend / smc_choch_exit 按级别与方向取值', () => {
    const bars = path(), at = (name: string, p: Record<string, unknown>, extra = {}) => bars.map((_, i) => registry.get(name)!.compute(ctx(bars, i, extra), { ...P, ...p })).map((v, i) => (v.pass || v.exit ? i : -1)).filter((i) => i >= 0);
    expect(at('smc_bos', {})).toEqual([9, 23]);
    expect(at('smc_bos', { kind: 'choch' })).toEqual([23]);
    expect(at('smc_bos', { direction: 'bearish' })).toEqual([15]);
    expect(at('smc_trend', { scope: 'internal' })).toEqual([9, 10, 11, 12, 13, 14, 23, 24]);
    const pos = { position: { entry_at: bars[10]!.open_time, entry_price: 110, initial_distance: 5, bars_held: 1 } };
    expect(at('smc_choch_exit', {}, pos)).toEqual([15]);
    expect(at('smc_choch_exit', {}, { ...pos, side: 'short' })).toEqual([23]);
    expect(at('smc_choch_exit', {})).toEqual([]); // 没持仓不离场
  });
  it('smc_ob_level:多单上沿入场/下沿止损(+ATR 缓冲)/看跌块止盈,空单镜像', () => {
    const bars = path(), v = registry.get('smc_ob_level')!.compute(ctx(bars, 12), P);
    expect(v).toEqual({ level: 102.5, stop: 99.5 });
    const s = registry.get('smc_ob_level')!.compute(ctx(bars, 19, { side: 'short' }), P);
    expect(s).toMatchObject({ level: 108.5, stop: 112.5 });
    const buf = registry.get('smc_ob_level')!.compute(ctx(bars, 12), { ...P, buffer_atr: 1, atr_period: 3 });
    expect(buf.stop!).toBeLessThan(99.5); expect(buf.level).toBe(102.5);
  });
  it('smc_liquidity_target:取上方最近未被扫的 pivot 高点,空单取下方', () => {
    const bars = path();
    // 第 19 根(收 103):上方未扫的内部 pivot 高点只有第 10 根 112.5
    expect(registry.get('smc_liquidity_target')!.compute(ctx(bars, 19), { ...P, scope: 'internal', source: 'swing' })).toEqual({ target: 112.5, level: 112.5 });
    expect(registry.get('smc_liquidity_target')!.compute(ctx(bars, 13, { side: 'short' }), { ...P, scope: 'internal', source: 'swing' })).toEqual({ target: 99.5, level: 99.5 });
    // 第 24 根:112.5 已被扫,上方没有流动性 → 不给价
    expect(registry.get('smc_liquidity_target')!.compute(ctx(bars, 24), { ...P, scope: 'internal', source: 'swing' })).toEqual({});
  });
  it('smc_fvg_fill / smc_ob_retest 作为信号', () => {
    const bars = mk([100, 102, 104, 106, 104, 102, 100, 103, 106, 109, 112, 109, 106, 103, 102.6, 104, 106]);
    const retest = bars.map((_, i) => registry.get('smc_ob_retest')!.compute(ctx(bars, i), P).pass ? i : -1).filter((i) => i >= 0);
    expect(retest).toEqual([13, 14, 15]);
  });
  it('检查器接受一份完整的 SMC 订单周期策略', () => {
    const ir = { ...defaultIR(), signal: [node('smc_bos', { direction: 'bullish' })], regime: node('smc_trend', { scope: 'swing', direction: 'bullish' }), risk: { ...defaultIR().risk, stop: node('smc_ob_level', {}) }, exit: [node('smc_choch_exit', {})],
      order: { direction: 'long' as const, market: 'spot' as const, entry: { type: 'limit' as const, price: node('smc_ob_level', {}) }, take_profits: [{ source: node('smc_liquidity_target', {}) }] } };
    const r = checkIR(ir, '4h'); expect(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok))).toBe(true);
    expect(smcParamsFromIR(ir)).toEqual({});
  });
});

describe('SMC 编译说法', () => {
  it('「回踩订单块限价 / 止损订单块下沿 / 止盈看流动性」确定性落进 order 块', () => {
    const ir: Record<string, unknown> = { ...defaultIR(), signal: [node('smc_bos', { direction: 'bullish' })], regime: node('smc_trend', { scope: 'swing' }) };
    const notes = applyOrderPhrases('BTC 4小时 SMC 策略:摆动结构看涨时,回踩看涨订单块限价买入,止损放在订单块下沿,止盈看上方流动性(前高),回测', ir);
    const o = ir.order as { entry: { type: string; price: { primitive: string } }; take_profits: { source: { primitive: string } }[] };
    expect(o.entry).toMatchObject({ type: 'limit', price: { primitive: 'smc_ob_level' } });
    expect((ir.risk as { stop: { primitive: string } }).stop.primitive).toBe('smc_ob_level');
    expect(o.take_profits.map((x) => x.source.primitive)).toEqual(['smc_liquidity_target']);
    expect(notes.length).toBeGreaterThanOrEqual(3);
    expect(checkIR(ir as never, '4h').ok).toBe(true);
    // 模型已经写了带参数的 smc_ob_level:保留参数,止损沿用同一 scope
    const ir2: Record<string, unknown> = { ...defaultIR(), order: { direction: 'long', market: 'spot', entry: { type: 'limit', price: node('smc_ob_level', { scope: 'swing' }) } } };
    applyOrderPhrases('回踩订单块限价买入,止损在订单块下沿', ir2);
    expect((ir2.order as { entry: { price: unknown } }).entry.price).toEqual(node('smc_ob_level', { scope: 'swing' }));
    expect((ir2.risk as { stop: unknown }).stop).toEqual(node('smc_ob_level', { scope: 'swing' }));
  });
});

describe('SMC 因果性与性能', () => {
  it('截断未来 bar 后此前每一根的状态与事件都不变', () => {
    const bars = walk(2500), full = smcCompute(bars, { internal_length: 5, swing_length: 30, atr_period: 50 });
    for (const k of [120, 377, 901, 1500, 2222]) {
      const cut = smcCompute(clone(bars.slice(0, k)), { internal_length: 5, swing_length: 30, atr_period: 50 });
      expect(JSON.stringify(cut.states)).toBe(JSON.stringify(full.states.slice(0, k)));
      expect(cut.breaks).toEqual(full.breaks.filter((b) => b.index < k));
      expect(cut.blocks.map((b) => ({ ...b, mitigated: null }))).toEqual(full.blocks.filter((b) => b.formed < k).map((b) => ({ ...b, mitigated: null })));
      expect(cut.blocks.map((b) => b.mitigated)).toEqual(full.blocks.filter((b) => b.formed < k).map((b) => (b.mitigated !== null && b.mitigated < k ? b.mitigated : null)));
    }
  });
  it('原语逐根取值:未来 bar 被污染也不变;滑动窗口的状态链与整段计算一致', () => {
    const bars = walk(1500), i = 1100, p = { internal_length: 5, swing_length: 30, atr_period: 50 };
    const poison = bars.map((b, j) => (j > i ? { ...b, high: 'NaN', low: 'NaN', close: 'NaN' } : { ...b }));
    for (const name of SMC_PRIMITIVES) {
      const pos = { position: { entry_at: bars[i - 5]!.open_time, entry_price: 1, initial_distance: 1, bars_held: 5 } };
      expect(registry.get(name)!.compute({ bars: poison, i, timeframe_ms: 4 * STEP, ...pos }, p), name).toEqual(registry.get(name)!.compute({ bars: clone(bars.slice(0, i + 1)), i, timeframe_ms: 4 * STEP, ...pos }, p));
    }
    // 回测形态的调用:窗口起点从 0 开始、之后每次右移一根 → 与整段计算逐根相同
    const full = smcCompute(bars, p), W = 600;
    for (let j = 0; j < bars.length; j++) { const s = Math.max(0, j - W + 1), win = bars.slice(s, j + 1); expect(smcStateAt(win, win.length - 1, p)).toBe(smcStateAt(bars, j, p)); if (j % 97 === 0) expect(JSON.stringify(smcStateAt(win, win.length - 1, p))).toBe(JSON.stringify(full.states[j])); }
  });
  it('4h 六年 1.3 万根:整段计算与逐根原语取值都在 1 秒内', () => {
    const bars = walk(13140, 11); let t = performance.now(); const m = smcCompute(bars); const whole = performance.now() - t;
    expect(m.states).toHaveLength(13140); expect(whole).toBeLessThan(1000);
    const W = 1206, fresh = clone(bars); t = performance.now();
    for (let j = 0; j < fresh.length; j++) { const win = fresh.slice(Math.max(0, j - W + 1), j + 1), c = { bars: win, i: win.length - 1, timeframe_ms: 4 * STEP }; for (const name of ['smc_trend', 'smc_bos', 'smc_ob_level', 'smc_liquidity_target']) registry.get(name)!.compute(c, {}); }
    const stepped = performance.now() - t; expect(stepped).toBeLessThan(1000);
    console.log(`SMC 1.3 万根:整段 ${whole.toFixed(0)}ms,逐根 4 原语 ${stepped.toFixed(0)}ms`);
    const t2 = performance.now(); const ov = smcOverlay(bars); expect(performance.now() - t2).toBeLessThan(1000);
    expect(ov.structures.length).toBeGreaterThan(100); expect(ov.order_blocks.length).toBeGreaterThan(100); expect(ov.fvgs.length).toBeGreaterThan(10);
  });
});

describe('SMC 图层', () => {
  it('结构/订单块/FVG/等高等低/区间/前日前周高低,形状符合契约 SmcOverlay', () => {
    const bars = walk(3000, 3), ov = smcOverlay(bars, { internal_length: 5, swing_length: 30 }, { from_ms: bars[1000]!.open_time, to_ms: bars[2999]!.open_time });
    const req = createRequire(import.meta.url), Ajv = req('ajv/dist/2020.js').default, ajv = new Ajv({ strict: false });
    const check = ajv.compile((schemas.research.$defs as Record<string, object>).SmcOverlay);
    expect(check(ov), JSON.stringify(check.errors)).toBe(true);
    expect(ov.structures.every((s) => s.at >= bars[1000]!.open_time || s.from >= bars[1000]!.open_time || s.at >= s.from)).toBe(true);
    expect(ov.order_blocks.every((b) => b.top >= b.bottom && (b.mitigated_at === null || b.mitigated_at >= bars[1000]!.open_time))).toBe(true);
    expect(new Set(ov.htf_levels.map((x) => x.kind))).toEqual(new Set(['PDH', 'PDL', 'PWH', 'PWL']));
    expect(ov.eq.length).toBeGreaterThan(0); expect(ov.zones).not.toBeNull();
  });
});
