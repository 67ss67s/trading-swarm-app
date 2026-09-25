/**
 * as-of 特征:第 i 根的每个特征值只用 bars[0..i](已收盘)计算,截断未来数据后不变(测试逐项验证)。
 * 能用现有原语表达的特征带 ir 映射(indicator_threshold / trend_state / htf_structure_regime / 形态信号),
 * 表达不了的(时段、相对 BTC 残差、历史分位、距结构位 ATR 数)只参与归因,不进 IR。
 *
 * 口径说明:
 *  - 指标线用 primitives/indicators.ts 的同一张表(全历史递推);回测引擎每根只看最近 viewBars 根,Wilder/EMA 的播种差异随窗口衰减,可忽略;
 *  - 高周期趋势复刻 trend-state.ts 的 trendState(同一递推顺序,测试里逐根对拍);
 *  - 结构位复刻 structure.ts 的 htfStructure:structure() 是逐根因果的,跑一遍全序列后按「截至第 i 根」还原当时的状态(测试里对拍)。
 */
import type { ResearchBar, StrategyPrimitive } from '@trading-swarm/contracts';
import { atrSeries, indicatorLine } from '../../primitives/indicators.js';
import { structure, completeBuckets } from '../../primitives/structure.js';
import { registry } from '../../primitives/index.js';

export type FeatureKind = 'num' | 'cat';
/** 规则条件:数值特征 ≤/≥ 阈值,类别特征 == 取值 */
export interface Condition { feature: string; op: '<=' | '>=' | '=='; value: number }
export interface FeatureDef {
  key: string;
  /** 给人看的中文名 */
  label: string;
  kind: FeatureKind;
  /** 类别特征:编码 → 文字 */
  levels?: string[];
  /** 转成 IR 节点;返回 null 表示这个方向/取值表达不了。slot=regime 的节点整条 IR 只能有一个 */
  ir?: (c: Condition, side: 'long' | 'short') => { slot: 'signal' | 'regime'; node: StrategyPrimitive } | null;
}
export interface AssetFeatures { symbol: string; defs: FeatureDef[]; cols: Float64Array[]; n: number }

const node = (primitive: string, params: Record<string, unknown>): StrategyPrimitive => ({ primitive, params });
/** 阈值保留 4 位有效数字(IR 里好读;对分位档的影响可忽略) */
export const roundThreshold = (x: number) => (x === 0 ? 0 : Number(x.toPrecision(4)));
const thresholdIR = (indicator: string, args: Record<string, number>, output?: string) => (c: Condition) =>
  c.op === '==' ? null : { slot: 'signal' as const, node: node('indicator_threshold', { indicator, ...(Object.keys(args).length ? { args } : {}), ...(output ? { output } : {}), operator: c.op === '<=' ? 'below' : 'above', threshold: roundThreshold(c.value) }) };
const TREND_PARAMS = (htf: string) => ({ adx_period: 14, adx_min: 20, ema_fast: 20, ema_slow: 50, htf });
const STRUCT_PARAMS = (htf: string) => ({ htf, swing_length: 3, confirmation: 'close', zone: 'wick' });

/** 数值指标特征:名字、中文、指标、参数、输出线 */
const IND: [string, string, string, Record<string, number>, string?][] = [
  ['rsi14', 'RSI(14)', 'rsi', { period: 14 }],
  ['roc4', '4 根涨跌幅%', 'roc', { period: 4 }],
  ['roc24', '24 根涨跌幅%', 'roc', { period: 24 }],
  ['roc72', '72 根涨跌幅%', 'roc', { period: 72 }],
  ['roc168', '168 根涨跌幅%', 'roc', { period: 168 }],
  ['natr14', 'ATR%(14)', 'natr', { period: 14 }],
  ['bb_width', '布林带宽%(20,2)', 'bbands', { period: 20, multiple: 2 }, 'bandwidth'],
  ['bb_pctb', '布林 %B(20,2)', 'bbands', { period: 20, multiple: 2 }, 'percent_b'],
  ['vol_ratio', '量比(20)', 'volume_ratio', { period: 20 }],
  ['adx14', 'ADX(14)', 'adx', { period: 14 }, 'adx'],
  ['chop14', '震荡指数(14)', 'chop', { period: 14 }],
  ['mfi14', 'MFI(14)', 'mfi', { period: 14 }],
  ['cmf20', 'CMF(20)', 'cmf', { period: 20 }],
];
const PATTERNS: [string, string, string, Record<string, unknown>][] = [
  ['bull_engulf', '看涨吞没', 'bullish_engulfing', { min_body_ratio: 1 }],
  ['pin_bar', '锤子线', 'pin_bar', { tail_ratio: 2, max_body_pct: 0.33, max_upper_pct: 0.25 }],
  ['inside_break', '内包突破', 'inside_bar_breakout', { max_inside_bars: 3 }],
  ['fvg', '看涨 FVG', 'fair_value_gap', { min_gap_pct: 0.1 }],
];
const tfMs = (tf: string) => { const m = /^(\d+)(m|h|d)$/.exec(tf)!; return Number(m[1]) * ({ m: 60000, h: 3600000, d: 86400000 }[m[2]!]!); };

/** 特征目录(与资产无关);顺序即列顺序 */
export function featureDefs(): FeatureDef[] {
  const defs: FeatureDef[] = IND.map(([key, label, ind, args, output]) => ({ key, label, kind: 'num' as const, ir: thresholdIR(ind, args, output) }));
  defs.push(
    { key: 'macd_hist_sign', label: 'MACD 柱方向', kind: 'cat', levels: ['负', '正'], ir: (c) => ({ slot: 'signal', node: node('indicator_threshold', { indicator: 'macd', output: 'hist', operator: c.value === 1 ? 'above' : 'below', threshold: 0 }) }) },
    { key: 'macd_hist_atr', label: 'MACD 柱/ATR', kind: 'num' },
    { key: 'natr_pct', label: 'ATR% 的 30 天分位', kind: 'num' },
    { key: 'bbw_pct', label: '布林带宽的 30 天分位', kind: 'num' },
    { key: 'dist_sup_atr', label: '距下方最近确认低点(ATR 数)', kind: 'num' },
    { key: 'dist_res_atr', label: '距上方最近确认高点(ATR 数)', kind: 'num' },
    { key: 'resid24', label: '相对 BTC 的 24 根残差收益', kind: 'num' },
  );
  for (const htf of ['4h', '1d']) defs.push({ key: `trend_${htf}`, label: `${htf} 趋势状态`, kind: 'cat', levels: ['range', 'up', 'down'], ir: (c, side) => (side === 'long' && c.value === 1 ? { slot: 'regime', node: node('trend_state', TREND_PARAMS(htf)) } : null) });
  for (const htf of ['1h', '4h', '1d']) {
    defs.push({ key: `bos_${htf}`, label: `${htf} 最近结构突破方向`, kind: 'cat', levels: ['无', 'up', 'down'], ir: (c, side) => (side === 'long' && c.value === 1 ? { slot: 'regime', node: node('htf_structure_regime', { ...STRUCT_PARAMS(htf), require_bos: true, max_position: 1 }) } : null) });
    if (htf !== '1h') defs.push({ key: `pos_${htf}`, label: `${htf} 支撑→阻力区间位置`, kind: 'num', ir: (c, side) => (side === 'long' && c.op === '<=' ? { slot: 'regime', node: node('htf_structure_regime', { ...STRUCT_PARAMS(htf), require_bos: false, max_position: Math.min(1, Math.max(0, roundThreshold(c.value))) }) } : null) });
  }
  for (const [key, label, primitive, params] of PATTERNS) defs.push({ key, label, kind: 'cat', levels: ['否', '是'], ir: (c, side) => (side === 'long' && c.value === 1 ? { slot: 'signal', node: node(primitive, params) } : null) });
  defs.push(
    { key: 'bear_engulf', label: '看跌吞没', kind: 'cat', levels: ['否', '是'] },
    { key: 'utc_session', label: 'UTC 时段(进场根)', kind: 'cat', levels: ['00-06', '06-12', '12-18', '18-24'] },
    { key: 'weekend', label: '周末(UTC)', kind: 'cat', levels: ['工作日', '周末'] },
  );
  return defs;
}

/** trendState 的逐根递推版(同一公式、同一运算顺序);返回 state 编码 0=range 1=up 2=down,status 不 ok 时记 NaN */
export function trendSeries(bars: ResearchBar[], base: number, htf: string, period = 14, fast = 20, slow = 50, adxMin = 20): Float64Array {
  const n = bars.length, out = new Float64Array(n).fill(NaN), target = tfMs(htf), per = target / base;
  const kf = 2 / (fast + 1), ks = 2 / (slow + 1);
  let f = NaN, s = NaN, sPrev = NaN, fPrev = NaN;
  let t = 0, p = 0, m = 0, k = 0, dxSum = 0, dxCount = 0, adx = 0;
  let hs = NaN, hsPrev = NaN, htfCount = 0, curKey = -1, cnt = 0, contiguous = true;
  for (let i = 0; i < n; i++) {
    const b = bars[i]!, close = Number(b.close);
    fPrev = f; sPrev = s;
    f = i === 0 ? close : close * kf + f * (1 - kf);
    s = i === 0 ? close : close * ks + s * (1 - ks);
    if (i > 0) {
      const pb = bars[i - 1]!, up = Number(b.high) - Number(pb.high), down = Number(pb.low) - Number(b.low);
      const tr = Math.max(Number(b.high) - Number(b.low), Math.abs(Number(b.high) - Number(pb.close)), Math.abs(Number(b.low) - Number(pb.close)));
      const pl = up > down && up > 0 ? up : 0, mi = down > up && down > 0 ? down : 0;
      if (k < period) { t += tr; p += pl; m += mi; } else { t = t - t / period + tr; p = p - p / period + pl; m = m - m / period + mi; }
      if (k >= period - 1) {
        const dx = t > 0 && p + m > 0 ? 100 * Math.abs(p - m) / (p + m) : 0;
        if (dxCount < period) { dxSum += dx; dxCount++; if (dxCount === period) adx = dxSum / period; } else adx = (adx * (period - 1) + dx) / period;
      }
      k++;
    }
    const key = Math.floor(b.open_time / target) * target;
    if (key !== curKey) { curKey = key; cnt = 0; contiguous = true; }
    if (b.open_time !== key + cnt * base) contiguous = false;
    cnt++;
    if (contiguous && cnt === per && b.close_time === key + target - 1) { hsPrev = hs; hs = htfCount === 0 ? close : close * ks + hs * (1 - ks); htfCount++; }
    if (i + 1 < Math.max(slow + 1, 2 * period)) continue;
    const htfReady = htfCount >= slow + 1;
    if (!htfReady) continue;
    const direction = hs > hsPrev ? 1 : hs < hsPrev ? 2 : 0;
    // adx():bars.length<2*period 返回 0;dx 不足 period 个时 slice 求均值(不会发生:上面已要求 i+1 ≥ 2*period)
    const value = i + 1 < 2 * period ? 0 : adx, slope = s / sPrev - 1;
    const isUp = f > s && f > fPrev && slope > 0, isDown = f < s && f < fPrev && slope < 0;
    out[i] = value < adxMin ? 0 : isUp && direction === 1 ? 1 : isDown && direction === 2 ? 2 : 0;
  }
  return out;
}

/** htfStructure 的「截至第 i 根」还原:bos 编码 0=无 1=up 2=down;position ∈[0,1] 或 NaN(缺支撑/阻力);status 不 ok 时两者都记 NaN */
export function structureSeries(bars: ResearchBar[], base: number, htf: string, swing = 3): { bos: Float64Array; position: Float64Array } {
  const n = bars.length, bos = new Float64Array(n).fill(NaN), position = new Float64Array(n).fill(NaN);
  const hb = completeBuckets(bars, base, tfMs(htf)), s = structure(hb, swing, 'close', 'wick');
  let k = 0, bi = 0, lastDir = 0, visibleBlocks = 0;
  const blocks = s.blocks; // 按形成顺序(formed_at 非降)
  for (let i = 0; i < n; i++) {
    const at = bars[i]!.close_time, price = Number(bars[i]!.close);
    while (k < hb.length && hb[k]!.close_time <= at) k++;
    if (k < 2 * swing + 1) continue;
    const asOf = hb[k - 1]!.close_time;
    while (bi < s.breaks.length && s.breaks[bi]!.index <= k - 1) { lastDir = s.breaks[bi]!.direction === 'up' ? 1 : 2; bi++; }
    while (visibleBlocks < blocks.length && blocks[visibleBlocks]!.formed_at <= asOf) visibleBlocks++;
    let sup = -Infinity, res = Infinity;
    for (let j = 0; j < visibleBlocks; j++) {
      const x = blocks[j]!;
      if (x.mitigated_at !== null && x.mitigated_at <= asOf) continue;
      if (x.direction === 'up') { const u = Number(x.upper); if (u < price && u > sup) sup = u; }
      else { const l = Number(x.lower); if (l > price && l < res) res = l; }
    }
    bos[i] = lastDir;
    if (Number.isFinite(sup) && Number.isFinite(res)) position[i] = Math.max(0, Math.min(1, (price - sup) / (res - sup)));
  }
  return { bos, position };
}

/** 滚动分位:当前值在最近 window 个有效值里的分位(≤ 当前值的比例) */
function rollingPercentile(v: ArrayLike<number>, window: number): Float64Array {
  const out = new Float64Array(v.length).fill(NaN);
  for (let i = window - 1; i < v.length; i++) {
    const x = v[i]!; if (!Number.isFinite(x)) continue;
    let le = 0, cnt = 0;
    for (let j = i - window + 1; j <= i; j++) { const y = v[j]!; if (Number.isFinite(y)) { cnt++; if (y <= x) le++; } }
    if (cnt >= window / 2) out[i] = le / cnt;
  }
  return out;
}

/** 计算一个资产的全部 as-of 特征。btc:同周期 BTC K 线(按 open_time 对齐算残差;资产本身是 BTC 时残差为 NaN) */
export function computeFeatures(symbol: string, bars: ResearchBar[], timeframe_ms: number, btc?: ResearchBar[] | null): AssetFeatures {
  const defs = featureDefs(), n = bars.length, col = new Map<string, Float64Array>();
  const put = (k: string, v: ArrayLike<number>) => col.set(k, Float64Array.from(v as ArrayLike<number>));
  for (const [key, , ind, args, output] of IND) put(key, indicatorLine(ind, bars, args, output));
  const hist = indicatorLine('macd', bars, {}, 'hist'), atr = atrSeries(bars, 14);
  put('macd_hist_sign', hist.map((x) => (Number.isFinite(x) ? (x > 0 ? 1 : 0) : NaN)));
  put('macd_hist_atr', hist.map((x, i) => (Number.isFinite(x) && atr[i]! > 0 ? x / atr[i]! : NaN)));
  const perDay = Math.round(86400000 / timeframe_ms);
  put('natr_pct', rollingPercentile(col.get('natr14')!, 30 * perDay));
  put('bbw_pct', rollingPercentile(col.get('bb_width')!, 30 * perDay));
  // 本周期结构(swing 3):距最近已确认 pivot 低/高点的 ATR 数
  const local = structure(bars, 3, 'close', 'wick'), lows = local.pivots.filter((x) => x.kind === 'low'), highs = local.pivots.filter((x) => x.kind === 'high');
  const dSup = new Float64Array(n).fill(NaN), dRes = new Float64Array(n).fill(NaN);
  let li = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    while (li < lows.length && lows[li]!.confirmed_index <= i) li++;
    while (hi < highs.length && highs[hi]!.confirmed_index <= i) hi++;
    const price = Number(bars[i]!.close), a = atr[i]!; if (!(a > 0)) continue;
    let sup = -Infinity, res = Infinity;
    for (let j = li - 1; j >= Math.max(0, li - 50); j--) { const p = Number(lows[j]!.price); if (p < price && p > sup) sup = p; }
    for (let j = hi - 1; j >= Math.max(0, hi - 50); j--) { const p = Number(highs[j]!.price); if (p > price && p < res) res = p; }
    if (Number.isFinite(sup)) dSup[i] = (price - sup) / a;
    if (Number.isFinite(res)) dRes[i] = (res - price) / a;
  }
  put('dist_sup_atr', dSup); put('dist_res_atr', dRes);
  // 相对 BTC 残差:24 根对数收益 − β×BTC 同期收益,β 用最近 30 天逐根收益滚动估计
  const resid = new Float64Array(n).fill(NaN);
  if (btc && btc !== bars && !/^BTC/.test(symbol)) {
    const bc = new Map(btc.map((b) => [b.open_time, Number(b.close)]));
    const ra = new Float64Array(n).fill(NaN), rb = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) { const b0 = bc.get(bars[i - 1]!.open_time), b1 = bc.get(bars[i]!.open_time); if (b0 && b1) { ra[i] = Math.log(Number(bars[i]!.close) / Number(bars[i - 1]!.close)); rb[i] = Math.log(b1 / b0); } }
    const W = 30 * perDay;
    let sa = 0, sb = 0, sab = 0, sbb = 0, cntW = 0;
    for (let i = 1; i < n; i++) {
      if (Number.isFinite(ra[i]!)) { sa += ra[i]!; sb += rb[i]!; sab += ra[i]! * rb[i]!; sbb += rb[i]! * rb[i]!; cntW++; }
      const o = i - W; if (o >= 1 && Number.isFinite(ra[o]!)) { sa -= ra[o]!; sb -= rb[o]!; sab -= ra[o]! * rb[o]!; sbb -= rb[o]! * rb[o]!; cntW--; }
      if (i < W || cntW < W / 2 || i < 24) continue;
      const vb = sbb / cntW - (sb / cntW) ** 2; if (!(vb > 0)) continue;
      const beta = (sab / cntW - (sa / cntW) * (sb / cntW)) / vb;
      let a24 = 0, b24 = 0, ok = true;
      for (let j = i - 23; j <= i; j++) { if (!Number.isFinite(ra[j]!)) { ok = false; break; } a24 += ra[j]!; b24 += rb[j]!; }
      if (ok) resid[i] = a24 - beta * b24;
    }
  }
  put('resid24', resid);
  for (const htf of ['4h', '1d']) put(`trend_${htf}`, trendSeries(bars, timeframe_ms, htf));
  for (const htf of ['1h', '4h', '1d']) {
    const st = structureSeries(bars, timeframe_ms, htf);
    put(`bos_${htf}`, st.bos);
    if (htf !== '1h') put(`pos_${htf}`, st.position);
  }
  // 形态:原语本身只看最后几根,给它最近 60 根的窗口就等价于全前缀
  for (const [key, , primitive, params] of PATTERNS) {
    const prim = registry.get(primitive)!, v = new Float64Array(n);
    for (let i = 0; i < n; i++) { const w = bars.slice(Math.max(0, i - 59), i + 1); v[i] = prim.compute({ bars: w, i: w.length - 1, timeframe_ms }, params).pass ? 1 : 0; }
    put(key, v);
  }
  const bear = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const cur = bars[i]!, prev = bars[i - 1]!, co = Number(cur.open), cc = Number(cur.close), po = Number(prev.open), pc = Number(prev.close);
    bear[i] = Math.abs(pc - po) > 0 && Math.abs(cc - co) >= Math.abs(pc - po) && pc > po && cc < co && cc <= po && co >= pc ? 1 : 0;
  }
  put('bear_engulf', bear);
  // 时段按进场根(下一根)开盘的 UTC 小时 —— 信号根收盘时已知
  put('utc_session', bars.map((b) => Math.floor(new Date(b.close_time + 1).getUTCHours() / 6)));
  put('weekend', bars.map((b) => { const d = new Date(b.close_time + 1).getUTCDay(); return d === 0 || d === 6 ? 1 : 0; }));
  return { symbol, defs, cols: defs.map((d) => col.get(d.key) ?? new Float64Array(n).fill(NaN)), n };
}
