// oracle(事后反推)生成器:标签、特征因果性、置换检验(纯噪声不显著 / 植入规律能找回)、规则 → IR 过 checkIR。
import { describe, it, expect } from 'vitest';
import type { ResearchBar, StrategyIR } from '@trade-gate/contracts';
import { labelSeries, DEFAULT_MECHANICS, type Mechanics } from '../../../../../src/demo/research/improve/oracle/labels.js';
import { computeFeatures, trendSeries, structureSeries } from '../../../../../src/demo/research/improve/oracle/features.js';
import { buildConditions, buildPairs, mine, nullDistribution, permutationP, bitsOf, rng, benjaminiHochberg, rotateLabels, permuteLabels, DEFAULT_MINE, type MiningTable } from '../../../../../src/demo/research/improve/oracle/mine.js';
import { ruleToIR, addRuleToParent, oracleGenerator, mineOracle, type Condition } from '../../../../../src/demo/research/improve/oracle/index.js';
import { featureDefs } from '../../../../../src/demo/research/improve/oracle/features.js';
import { checkIR, defaultIR } from '../../../../../src/demo/research/strategy.js';
import { trendState } from '../../../../../src/demo/research/primitives/trend-state.js';
import { htfStructure } from '../../../../../src/demo/research/primitives/structure.js';
import type { FrozenData, GeneratorContext } from '../../../../../src/demo/research/improve/types.js';

const H = 3600000, T0 = Date.UTC(2024, 0, 1);
const bar = (i: number, o: number, h: number, l: number, c: number, v = 100): ResearchBar => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, available_at: T0 + (i + 1) * H - 1, open: o.toFixed(8), high: h.toFixed(8), low: l.toFixed(8), close: c.toFixed(8), volume: v.toFixed(8) });
/** 随机游走 K 线(确定性) */
function walk(n: number, seed: number, vol = 0.006, drift = 0): ResearchBar[] {
  const r = rng(seed), out: ResearchBar[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const g = () => (r() + r() + r() + r() - 2) * 1.7;
    const o = p, c = o * Math.exp(drift + vol * g()), h = Math.max(o, c) * (1 + Math.abs(vol * 0.5 * g())), l = Math.min(o, c) * (1 - Math.abs(vol * 0.5 * g()));
    out.push(bar(i, o, h, l, c, 50 + 100 * r())); p = c;
  }
  return out;
}
/** 平盘(ATR 固定 = 1)后接一段走势,用来构造已知结果 */
function flatThen(path: number[], flat = 60): ResearchBar[] {
  const out: ResearchBar[] = [];
  for (let i = 0; i < flat; i++) out.push(bar(i, 100, 100.5, 99.5, 100));
  let prev = 100;
  path.forEach((c, k) => { const o = prev; out.push(bar(flat + k, o, Math.max(o, c) + 0.1, Math.min(o, c) - 0.1, c)); prev = c; });
  return out;
}
const M0: Mechanics = { ...DEFAULT_MECHANICS, fee_rate: 0, slippage_bps: 0, min_stop_cost_multiple: 0 };

describe('事后标签', () => {
  it('稳步上涨:多头跑满 48 根时间止损,净 R 远超 2R 记好点;空头当根被止损', () => {
    // ATR(14)=1 → 止损距离 2;每根涨 0.3,48 根后约 +14.4 → ≈ +7R(8R 目标 = +16 不触及)
    const bars = flatThen(Array.from({ length: 80 }, (_, k) => 100 + 0.3 * (k + 1)));
    const i = 59, long = labelSeries(bars, 'long', M0), short = labelSeries(bars, 'short', M0);
    expect(long.good[i]).toBe(1);
    expect(long.r[i]!).toBeGreaterThan(5);
    expect(long.exit_index[i]).toBe(i + 49); // 持满 48 根,下一根 open 离场
    expect(short.good[i]).toBe(0);
    expect(short.r[i]!).toBeLessThan(-0.9);
  });
  it('进场后直接下跌:多头止损 ≈ −1R;扣成本后更差;成本下限会放宽止损', () => {
    const bars = flatThen(Array.from({ length: 60 }, (_, k) => 100 - 0.5 * (k + 1)));
    const i = 59, a = labelSeries(bars, 'long', M0), b = labelSeries(bars, 'long', { ...M0, fee_rate: 0.001, slippage_bps: 5 });
    expect(a.good[i]).toBe(0);
    expect(a.r[i]!).toBeCloseTo(-1, 1);
    expect(b.r[i]!).toBeLessThan(a.r[i]!);
    // 8× 往返成本 = 2.4% > 2×ATR(=2%),止损被放宽到 2.4 → 离场更晚
    const floor = labelSeries(bars, 'long', { ...M0, min_stop_cost_multiple: 8, fee_rate: 0.001, slippage_bps: 5 });
    expect(floor.exit_index[i]!).toBeGreaterThan(a.exit_index[i]!);
  });
  it('跳空越过止损按开盘价成交;未来不够的根不打标签', () => {
    const bars = flatThen([]);
    bars.push(bar(60, 100, 100.1, 99.9, 100), bar(61, 100, 100.1, 99.9, 100), bar(62, 90, 90.1, 89.9, 90));
    for (let k = 63; k < 130; k++) bars.push(bar(k, 90, 90.1, 89.9, 90));
    const lab = labelSeries(bars, 'long', M0);
    // 60 根收盘出信号 → 61 根开盘 100 进场;62 根开盘 90 跳空穿过止损(≈98.1),按开盘价 90 成交
    expect(lab.exit_index[60]).toBe(62);
    expect(lab.ret[60]!).toBeCloseTo(-0.1, 9);
    expect(Number.isNaN(lab.r[bars.length - 10]!)).toBe(true);
    const limited = labelSeries(bars, 'long', M0, 80);
    expect(limited.good[25]).not.toBe(255);
    expect(limited.r[25]).toBe(lab.r[25]);
    expect(limited.good[32]).toBe(255); // 32 + 49 > 80:标签要看到 limit 之后,不标
  });
});

describe('as-of 特征因果性', () => {
  const bars = walk(2200, 11, 0.008), btc = walk(2200, 12, 0.006);
  const full = computeFeatures('ETHUSDT', bars, H, btc);
  it('截断未来数据后,已算出的特征值逐列逐根不变', () => {
    for (const cut of [900, 1500, 2100]) {
      const part = computeFeatures('ETHUSDT', bars.slice(0, cut), H, btc.slice(0, cut));
      full.defs.forEach((d, c) => {
        for (let i = 0; i < cut; i++) {
          const a = full.cols[c]![i]!, b = part.cols[c]![i]!;
          if (Number.isNaN(a) || Number.isNaN(b)) expect([d.key, i, Number.isNaN(a)]).toEqual([d.key, i, Number.isNaN(b)]);
          else expect([d.key, i, a]).toEqual([d.key, i, b]);
        }
      });
    }
  });
  it('高周期趋势与原语 trendState 逐根一致', () => {
    for (const htf of ['4h', '1d']) {
      const s = trendSeries(bars, H, htf);
      for (let i = 1250; i < 2200; i += 37) {
        const t = trendState({ bars, i, timeframe_ms: H }, { adx_period: 14, adx_min: 20, ema_fast: 20, ema_slow: 50, htf });
        const want = t.status === 'ok' ? { range: 0, up: 1, down: 2 }[t.state] : NaN;
        expect([htf, i, s[i]]).toEqual([htf, i, want]);
      }
    }
  });
  it('结构位(BOS 方向、支撑→阻力位置)与原语 htfStructure 逐根一致', () => {
    for (const htf of ['1h', '4h', '1d']) {
      const s = structureSeries(bars, H, htf);
      for (let i = 30; i < 2200; i += 53) {
        const t = htfStructure({ bars, i, timeframe_ms: H }, { htf, swing_length: 3 });
        if (t.status !== 'ok') { expect(Number.isNaN(s.bos[i]!)).toBe(true); continue; }
        expect([htf, i, s.bos[i]]).toEqual([htf, i, t.bos_direction === 'up' ? 1 : t.bos_direction === 'down' ? 2 : 0]);
        if (t.position === null) expect(Number.isNaN(s.position[i]!)).toBe(true);
        else expect(s.position[i]!).toBeCloseTo(t.position, 9);
      }
    }
  });
});

/** 合成挖掘表:N 行、两个资产,特征 a(数值)、b(0/1)、c(数值噪声) */
function synthTable(n: number, seed: number, planted: boolean): MiningTable {
  const r = rng(seed), defs = featureDefs().filter((d) => ['rsi14', 'macd_hist_sign', 'roc24'].includes(d.key));
  const a = new Float64Array(n), b = new Float64Array(n), c = new Float64Array(n), good = new Uint8Array(n), rr = new Float64Array(n), asset = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = 100 * r(); b[i] = r() < 0.5 ? 1 : 0; c[i] = r() * 10 - 5; asset[i] = i < n / 2 ? 0 : 1;
    const p = planted && a[i]! <= 25 && b[i] === 1 ? 0.35 : 0.06;
    good[i] = r() < p ? 1 : 0; rr[i] = good[i] ? 2.5 : -0.5;
  }
  // defs 按 featureDefs 顺序:rsi14(数值 a)、roc24(噪声 c)、macd_hist_sign(0/1 的 b)
  return { cols: [a, c, b], defs, good, r: rr, asset, n };
}
async function run(t: MiningTable, mode: 'iid' | 'rotate' | 'block', P = 200) {
  const o = { ...DEFAULT_MINE, min_support: 150 }, conds = buildConditions(t, o), pairs = buildPairs(conds, o);
  const obs = mine(conds, pairs, bitsOf(t.n, (j) => t.good[j] === 1), t.n, o, true);
  const nul = await nullDistribution(t, conds, pairs, o, { permutations: P, mode, block: 20, horizon: 20, seed: 5 });
  return { conds, obs, p: permutationP(nul, obs.best!.score) };
}
describe('规则挖掘与置换检验', () => {
  it('纯噪声标签:最优规则的置换 p 不显著', async () => {
    for (const mode of ['iid', 'rotate'] as const) {
      const { p } = await run(synthTable(6000, 3, false), mode);
      expect([mode, p > 0.05]).toEqual([mode, true]);
    }
  }, 60000);
  it('植入「a ≤ 25 且 b = 1」的规律:最优规则找回这两个条件,p 显著', async () => {
    const { conds, obs, p } = await run(synthTable(6000, 4, true), 'rotate');
    const best = obs.best!.conds.map((i) => conds[i]!.cond);
    expect(best.find((c) => c.feature === 'rsi14')?.op).toBe('<=');
    expect(best.find((c) => c.feature === 'rsi14')!.value).toBeLessThanOrEqual(26);
    expect(best.find((c) => c.feature === 'macd_hist_sign')).toEqual({ feature: 'macd_hist_sign', op: '==', value: 1 });
    expect(p).toBeLessThan(0.01);
  }, 60000);
  it('置换保持每个资产的好点数与自相关结构;BH 在全为大 p 时没有发现', () => {
    const t = synthTable(1000, 9, true), r = rng(1);
    for (const perm of [rotateLabels(t.good, t.asset, 137), permuteLabels(t.good, t.asset, 25, r), permuteLabels(t.good, t.asset, 1, r)]) {
      for (const a of [0, 1]) expect(perm.filter((_, i) => t.asset[i] === a).reduce((s, x) => s + x, 0)).toBe(t.good.filter((_, i) => t.asset[i] === a).reduce((s, x) => s + x, 0));
    }
    expect(benjaminiHochberg([0.5, 0.9, 0.3, 0.2]).discoveries).toBe(0);
    expect(benjaminiHochberg([0.001, 0.002, 0.9]).discoveries).toBe(2);
  });
});

describe('规则 → StrategyIR', () => {
  const cases: Condition[][] = [
    [{ feature: 'natr14', op: '>=', value: 1.1349 }],
    [{ feature: 'natr14', op: '>=', value: 1.135 }, { feature: 'bos_1h', op: '==', value: 1 }],
    [{ feature: 'roc72', op: '>=', value: 0.0589 }, { feature: 'rsi14', op: '<=', value: 40 }, { feature: 'trend_4h', op: '==', value: 1 }],
    [{ feature: 'pos_1d', op: '<=', value: 0.4 }, { feature: 'bull_engulf', op: '==', value: 1 }, { feature: 'macd_hist_sign', op: '==', value: 1 }],
    [{ feature: 'trend_1d', op: '==', value: 1 }],
  ];
  it('可表达的只做多规则过零模型 checkIR(入场 next_open_market,止损/离场沿用机械管理)', () => {
    for (const conds of cases) {
      const { ir, unexpressed } = ruleToIR(conds, 'long', 'oracle 测试', '测试');
      expect(unexpressed).toEqual([]);
      const c = checkIR(ir, '1h');
      expect(c.ok, JSON.stringify(c.checks.filter((x) => !x.ok))).toBe(true);
      expect(ir!.entry.primitive).toBe('next_open_market');
      expect(ir!.risk.stop).toEqual({ primitive: 'atr_stop', params: { atr_period: 14, multiple: 2 } });
      expect(ir!.exit.map((x) => x.primitive)).toEqual(['chandelier_trail', 'time_stop', 'fixed_r_target']);
    }
  });
  it('表达不了的条件(时段、残差、两个方向门)如实列出,不硬塞', () => {
    expect(ruleToIR([{ feature: 'weekend', op: '==', value: 1 }], 'long', 'x', 'x').unexpressed.length).toBe(1);
    expect(ruleToIR([{ feature: 'resid24', op: '>=', value: 0.01 }], 'long', 'x', 'x').ir).toBeNull();
    expect(ruleToIR([{ feature: 'trend_4h', op: '==', value: 1 }, { feature: 'bos_4h', op: '==', value: 1 }], 'long', 'x', 'x').ir).toBeNull();
  });
  it('做空草稿带 order 块(direction=short, perp);以父 IR 为底加过滤:signal 追加,父已有方向门时不能再加方向门', () => {
    const short = ruleToIR([{ feature: 'rsi14', op: '>=', value: 70 }], 'short', 'x', 'x').ir!;
    expect(short.order).toEqual({ direction: 'short', market: 'perp', leverage: 1 });
    const parent = defaultIR();
    const got = addRuleToParent(parent, [{ feature: 'natr14', op: '>=', value: 1.1 }])!;
    expect(got.ir.signal.length).toBe(parent.signal.length + 1);
    expect(checkIR(got.ir, '1h').ok).toBe(true);
    expect(addRuleToParent(parent, [{ feature: 'bos_4h', op: '==', value: 1 }])).toBeNull();
    const noRegime = { ...parent } as StrategyIR; delete noRegime.regime;
    expect(addRuleToParent(noRegime, [{ feature: 'bos_4h', op: '==', value: 1 }])!.ir.regime?.primitive).toBe('htf_structure_regime');
  });
});

describe('生成器接口', () => {
  const assets = ['BTCUSDT', 'ETHUSDT'].map((symbol, k) => ({ symbol, dataset_id: symbol, bars: walk(6000, 21 + k, 0.008) }));
  const from = assets[0]!.bars[0]!.open_time, to = assets[0]!.bars.at(-1)!.close_time, t1 = from + Math.floor((to - from) * 0.7);
  const data: FrozenData = { universe: ['BTCUSDT', 'ETHUSDT'], timeframe: '1h', timeframe_ms: H, assets, warmup_bars: 300, segments: { folds: [], train: { from_ms: from, to_ms: t1 }, validation: { from_ms: t1 + 1, to_ms: to }, holdout: { from_ms: to, to_ms: to } } };
  it('mineOracle 只用训练段;随机游走上最优规则不显著,生成器不出候选', async () => {
    const res = await mineOracle(data, { permutations: 40, sides: ['long'] });
    const long = res.sides[0]!;
    expect(long.test.to_ms).toBeLessThanOrEqual(t1);
    expect(long.mining.to_ms).toBeLessThan(long.test.from_ms);
    expect(long.p_value).toBeGreaterThan(0.05);
    const parent = { id: 'p', parent_id: null, generation: 0, generator: 'baseline' as const, ir: defaultIR(), diff: [], rationale: '' };
    const ctx = { parent, evaluation: { candidate_id: 'p', folds: [], objective: null, gates: [], passed: false }, diagnosis: [], data, budget: 3, check: (ir: StrategyIR) => ({ ok: checkIR(ir, '1h').ok }) } as GeneratorContext;
    expect(await oracleGenerator.generate(ctx)).toEqual([]);
  }, 120000);
});
