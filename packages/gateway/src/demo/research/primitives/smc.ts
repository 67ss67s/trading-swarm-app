/**
 * Smart Money Concepts(聪明钱概念)原语与图层(2026-09-23)。
 *
 * 许可说明:概念参照 LuxAlgo「Smart Money Concepts」指标的功能清单(内部/摆动结构、BOS/CHoCH、订单块、FVG、
 * 等高等低、溢价/折价/均衡区、强弱高低点、前日/周高低),实现为自研,按公开的 SMC 概念定义重写,未使用其源码
 * (其 TradingView 脚本为 CC BY-NC-SA 4.0,禁止商用)。
 *
 * 口径(全部因果,只用已收盘 bar):
 *  - pivot:中心 c 的高点严格高于左侧 L 根、不低于右侧 L 根(低点镜像);确认根 = c+L,确认那一根才生效。
 *    内部结构 L=internal_length(缺省 5),摆动结构 L=swing_length(缺省 50),等高等低 L=eq_length(缺省 3)。
 *  - 结构突破:收盘(confirmation=wick 时用影线)越过尚未被突破的最近 pivot。此前趋势与突破方向相反 → CHoCH(反转),
 *    否则 BOS(顺势);突破后趋势 = 突破方向。每个 pivot 只能被突破一次。
 *  - 订单块:看涨突破时,在「被突破的 pivot 高点 → 突破前一根」这段回落里取最低点所在处,再往回找最后一根阴线
 *    (没有就用最低点那根),该 K 线的 [low, high] 即看涨订单块;看跌镜像。高波动 K 线(振幅 ≥ 2×ATR,或 ≥ 2×累计平均振幅)
 *    不参与挑选。失效(mitigation):突破之后的 bar 收盘(close)或影线(wick)穿过块的远端(看涨=下沿)。
 *    回踩 = 未失效块在形成之后被 bar 的影线触及(看涨:low ≤ 上沿)。每级每方向最多保留最近 MAX_ACTIVE 个活跃块。
 *  - FVG:第 i 根 low > 第 i-2 根 high 且中间一根收在第 i-2 根 high 之上 → 看涨缺口 [high(i-2), low(i)];看跌镜像。
 *    自动阈值:缺口幅度(相对 i-2 根)不小于迄今全部候选缺口的平均幅度才保留。触及 = 影线进入缺口,回补 = 影线到达缺口远端。
 *  - 等高/等低:相邻两个 eq pivot 高点(低点)之差 < eq_threshold × ATR → EQH(EQL),价位取两者更外侧;影线越过即被扫。
 *  - 溢价/折价/均衡:摆动区间 = 最近摆动 pivot 高点以来的最高价(top)与最近摆动 pivot 低点以来的最低价(bottom);
 *    上半 = 溢价,下半 = 折价,中线 ±2.5% 区间 = 均衡。
 *  - 强弱高低:摆动趋势向上时 bottom 为强低点、top 为弱高点(待扫的流动性);向下时反之。
 *  - 流动性:尚未被影线越过的 pivot 高点(买方流动性)/低点(卖方流动性),按级别维护;加上未被扫的 EQH/EQL 与摆动 top/bottom。
 *  - 多周期参考:前一个 UTC 日 / 周(周一起)的最高最低价,当日(周)开始后才生效。
 *
 * 计算方式:一台逐根推进的状态机(SmcMachine),整段 O(n)。原语按 ctx.bars 的 K 线对象身份缓存状态链:
 * 回测逐根调用时窗口每次右移一根,只需在链尾推进一步;窗口起点早于已有链时从窗口起点重建。
 * 同一根的状态只依赖链起点到该根的 K 线(因果),截断未来 bar 不改变此前任何输出(见 test/demo/research/smc.test.ts)。
 */
import { schemas, type ResearchBar } from '@trading-swarm/contracts';
import { registry, type Primitive, type PrimitiveContext, type PrimitiveValue } from './registry.js';

export type Scope = 'internal' | 'swing';
export type Dir = 1 | -1;
const SCOPES: Scope[] = ['internal', 'swing'];
/** 每级每方向保留的活跃订单块 / FVG 上限(更老的丢弃,不再参与回踩与价位) */
export const MAX_ACTIVE = 100;
/** 高波动过滤:振幅 ≥ VOL_MULTIPLE × 参照振幅 */
const VOL_MULTIPLE = 2;
/** 均衡区半宽(占区间比例) */
const EQ_BAND = 0.025;

export interface SmcParams {
  internal_length: number; swing_length: number; confirmation: 'close' | 'wick'; mitigation: 'close' | 'wick';
  ob_filter: 'atr' | 'range' | 'none'; atr_period: number; eq_length: number; eq_threshold: number; fvg_auto: boolean;
}
export const SMC_DEFAULTS: SmcParams = { internal_length: 5, swing_length: 50, confirmation: 'close', mitigation: 'wick', ob_filter: 'atr', atr_period: 200, eq_length: 3, eq_threshold: 0.1, fvg_auto: true };
const int = (v: unknown, d: number, lo: number, hi: number) => { const x = Number(v); return Number.isInteger(x) && x >= lo && x <= hi ? x : d; };
/** 原语参数 → 状态机配置;缺省值见 SMC_DEFAULTS,越界回落缺省(schema 已先挡) */
export function smcParams(p: Record<string, unknown> = {}): SmcParams {
  const th = Number(p.eq_threshold);
  return {
    internal_length: int(p.internal_length, SMC_DEFAULTS.internal_length, 1, 50),
    swing_length: int(p.swing_length, SMC_DEFAULTS.swing_length, 2, 200),
    confirmation: p.confirmation === 'wick' ? 'wick' : 'close',
    mitigation: p.mitigation === 'close' ? 'close' : 'wick',
    ob_filter: p.ob_filter === 'range' || p.ob_filter === 'none' ? p.ob_filter : 'atr',
    atr_period: int(p.atr_period, SMC_DEFAULTS.atr_period, 2, 1000),
    eq_length: int(p.eq_length, SMC_DEFAULTS.eq_length, 1, 50),
    eq_threshold: Number.isFinite(th) && th >= 0 && th <= 5 ? th : SMC_DEFAULTS.eq_threshold,
    fvg_auto: p.fvg_auto !== false,
  };
}
const cfgKey = (c: SmcParams) => `${c.internal_length}|${c.swing_length}|${c.confirmation}|${c.mitigation}|${c.ob_filter}|${c.atr_period}|${c.eq_length}|${c.eq_threshold}|${c.fvg_auto}`;

/** 结构突破事件 */
export interface SmcBreak { index: number; pivot: number; level: number; kind: 'BOS' | 'CHoCH'; scope: Scope; dir: Dir }
/** 订单块(mitigated 是事后记录,状态快照里不含它) */
export interface SmcBlock { index: number; formed: number; top: number; bottom: number; dir: Dir; scope: Scope; mitigated: number | null }
export interface SmcGap { index: number; formed: number; top: number; bottom: number; dir: Dir; touched: number | null; filled: number | null }
export interface SmcEqual { kind: 'EQH' | 'EQL'; a: number; b: number; level: number; confirmed: number; swept: number | null }
/** 状态快照里的块:只有价位与形成信息,不带事后的失效时点 */
export interface BlockView { top: number; bottom: number; index: number; formed: number }
export interface ScopeState { trend: -1 | 0 | 1; bull: BlockView | null; bear: BlockView | null; retest_bull: boolean; retest_bear: boolean; liq_above: number | null; liq_below: number | null }
/** 第 i 根收盘后的 SMC 状态(只依赖 ≤ i 的 K 线) */
export interface SmcState {
  breaks: SmcBreak[];
  internal: ScopeState; swing: ScopeState;
  fvg_touch_bull: boolean; fvg_touch_bear: boolean; fvg_fill_bull: boolean; fvg_fill_bear: boolean;
  top: number; bottom: number; top_index: number; bottom_index: number;
  eqh: number | null; eql: number | null;
  pdh: number | null; pdl: number | null; pwh: number | null; pwl: number | null;
  atr: number; close: number;
}
const NO_BREAKS: SmcBreak[] = [];

/** 滑动窗口极值(单调队列):mx[k] = max(high[k-L+1..k]),mn 同理 */
class Sliding {
  mx: number[] = []; mn: number[] = []; private qx: number[] = []; private qn: number[] = []; private hx = 0; private hn = 0;
  constructor(readonly L: number, private readonly H: number[], private readonly Lo: number[]) {}
  push(i: number): void {
    const { qx, qn, H, Lo, L } = this;
    while (qx.length > this.hx && H[qx.at(-1)!]! <= H[i]!) qx.pop(); qx.push(i); while (qx[this.hx]! <= i - L) this.hx++;
    while (qn.length > this.hn && Lo[qn.at(-1)!]! >= Lo[i]!) qn.pop(); qn.push(i); while (qn[this.hn]! <= i - L) this.hn++;
    if (this.hx > 1024) { qx.splice(0, this.hx); this.hx = 0; } if (this.hn > 1024) { qn.splice(0, this.hn); this.hn = 0; }
    this.mx.push(H[qx[this.hx]!]!); this.mn.push(Lo[qn[this.hn]!]!);
  }
  /** 第 i 根确认的 pivot(中心 i-L);返回 [是高点, 是低点] */
  pivot(i: number): [boolean, boolean] {
    const c = i - this.L; if (c < this.L) return [false, false];
    return [this.H[c]! > this.mx[c - 1]! && this.H[c]! >= this.mx[i]!, this.Lo[c]! < this.mn[c - 1]! && this.Lo[c]! <= this.mn[i]!];
  }
}
interface Leg { price: number; index: number; crossed: boolean }
interface Bucket { key: number; h: number; l: number; ph: number | null; pl: number | null }
interface ScopeRun { L: number; trend: -1 | 0 | 1; high: Leg | null; low: Leg | null; bulls: SmcBlock[]; bears: SmcBlock[]; liqH: Leg[]; liqL: Leg[] }
const view = (b: SmcBlock | undefined | null): BlockView | null => b ? { top: b.top, bottom: b.bottom, index: b.index, formed: b.formed } : null;

/** 逐根推进的 SMC 状态机。states[i] 是第 i 根收盘后的状态;breaks/blocks/gaps/equals 是全部事件(含事后失效时点)。 */
export class SmcMachine {
  readonly bars: ResearchBar[] = []; readonly states: SmcState[] = [];
  readonly breaks: SmcBreak[] = []; readonly blocks: SmcBlock[] = []; readonly gaps: SmcGap[] = []; readonly equals: SmcEqual[] = [];
  private H: number[] = []; private Lo: number[] = []; private O: number[] = []; private C: number[] = []; private vol: boolean[] = [];
  private slides = new Map<number, Sliding>(); private runs: Record<Scope, ScopeRun>;
  private atr = NaN; private trSum = 0; private rangeSum = 0;
  private gapSum = 0; private gapCount = 0; private gapsBull: SmcGap[] = []; private gapsBear: SmcGap[] = [];
  private eqPrevH: Leg | null = null; private eqPrevL: Leg | null = null; private eqH: SmcEqual[] = []; private eqL: SmcEqual[] = [];
  private top = NaN; private bottom = NaN; private topIndex = 0; private bottomIndex = 0;
  private day: Bucket = { key: NaN, h: NaN, l: NaN, ph: null, pl: null };
  private week: Bucket = { key: NaN, h: NaN, l: NaN, ph: null, pl: null };
  constructor(readonly cfg: SmcParams) {
    const mk = (L: number): ScopeRun => ({ L, trend: 0, high: null, low: null, bulls: [], bears: [], liqH: [], liqL: [] });
    this.runs = { internal: mk(cfg.internal_length), swing: mk(cfg.swing_length) };
    for (const L of [cfg.internal_length, cfg.swing_length, cfg.eq_length]) if (!this.slides.has(L)) this.slides.set(L, new Sliding(L, this.H, this.Lo));
  }
  get length(): number { return this.states.length; }
  push(bar: ResearchBar): SmcState {
    const i = this.bars.length, { cfg, H, Lo, O, C } = this;
    const h = +bar.high, l = +bar.low, o = +bar.open, c = +bar.close;
    this.bars.push(bar); H.push(h); Lo.push(l); O.push(o); C.push(c);
    // ATR(Wilder):前 P 根取均值,之后 RMA;P 根之前为 NaN
    const tr = i === 0 ? h - l : Math.max(h - l, Math.abs(h - C[i - 1]!), Math.abs(l - C[i - 1]!)), P = cfg.atr_period;
    if (i < P) { this.trSum += tr; if (i === P - 1) this.atr = this.trSum / P; } else this.atr = (this.atr * (P - 1) + tr) / P;
    this.rangeSum += h - l;
    const ref = cfg.ob_filter === 'atr' ? this.atr : cfg.ob_filter === 'range' ? this.rangeSum / (i + 1) : NaN;
    this.vol.push(Number.isFinite(ref) && h - l >= VOL_MULTIPLE * ref);
    for (const s of this.slides.values()) s.push(i);
    if (i === 0) { this.top = h; this.bottom = l; }
    const breaks: SmcBreak[] = [];
    // ── 结构:先登记本根确认的 pivot,再判突破 ──
    for (const scope of SCOPES) {
      const run = this.runs[scope], [ph, pl] = this.slides.get(run.L)!.pivot(i), center = i - run.L;
      if (ph) { run.high = { price: H[center]!, index: center, crossed: false }; while (run.liqH.length && run.liqH.at(-1)!.price < H[center]!) run.liqH.pop(); run.liqH.push({ ...run.high }); if (scope === 'swing') { this.top = H[center]!; this.topIndex = center; } }
      if (pl) { run.low = { price: Lo[center]!, index: center, crossed: false }; while (run.liqL.length && run.liqL.at(-1)!.price > Lo[center]!) run.liqL.pop(); run.liqL.push({ ...run.low }); if (scope === 'swing') { this.bottom = Lo[center]!; this.bottomIndex = center; } }
    }
    if (h > this.top) { this.top = h; this.topIndex = i; }
    if (l < this.bottom) { this.bottom = l; this.bottomIndex = i; }
    // ── 订单块失效与回踩(只看形成之后的 bar)──
    const retest: Record<Scope, [boolean, boolean]> = { internal: [false, false], swing: [false, false] };
    const farBull = cfg.mitigation === 'close' ? c : l, farBear = cfg.mitigation === 'close' ? c : h;
    for (const scope of SCOPES) {
      const run = this.runs[scope];
      run.bulls = run.bulls.filter((b) => { if (farBull < b.bottom) { b.mitigated = i; return false; } if (l <= b.top) retest[scope][0] = true; return true; });
      run.bears = run.bears.filter((b) => { if (farBear > b.top) { b.mitigated = i; return false; } if (h >= b.bottom) retest[scope][1] = true; return true; });
      while (run.liqH.length && run.liqH.at(-1)!.price < h) run.liqH.pop();
      while (run.liqL.length && run.liqL.at(-1)!.price > l) run.liqL.pop();
    }
    // ── 结构突破 → BOS/CHoCH + 新订单块 ──
    const upPx = cfg.confirmation === 'wick' ? h : c, dnPx = cfg.confirmation === 'wick' ? l : c;
    for (const scope of SCOPES) {
      const run = this.runs[scope];
      if (run.high && !run.high.crossed && upPx > run.high.price) {
        run.high.crossed = true; const br: SmcBreak = { index: i, pivot: run.high.index, level: run.high.price, kind: run.trend === -1 ? 'CHoCH' : 'BOS', scope, dir: 1 };
        run.trend = 1; breaks.push(br); this.breaks.push(br);
        const blk = this.block(run.high.index, i - 1, 1, scope, i); if (blk) { run.bulls.push(blk); if (run.bulls.length > MAX_ACTIVE) run.bulls.shift(); }
      }
      if (run.low && !run.low.crossed && dnPx < run.low.price) {
        run.low.crossed = true; const br: SmcBreak = { index: i, pivot: run.low.index, level: run.low.price, kind: run.trend === 1 ? 'CHoCH' : 'BOS', scope, dir: -1 };
        run.trend = -1; breaks.push(br); this.breaks.push(br);
        const blk = this.block(run.low.index, i - 1, -1, scope, i); if (blk) { run.bears.push(blk); if (run.bears.length > MAX_ACTIVE) run.bears.shift(); }
      }
    }
    // ── FVG ──
    let tb = false, tr2 = false, fb = false, fr = false;
    this.gapsBull = this.gapsBull.filter((g) => { if (l <= g.top) { if (g.touched === null) { g.touched = i; tb = true; } if (l <= g.bottom) { g.filled = i; fb = true; return false; } } return true; });
    this.gapsBear = this.gapsBear.filter((g) => { if (h >= g.bottom) { if (g.touched === null) { g.touched = i; tr2 = true; } if (h >= g.top) { g.filled = i; fr = true; return false; } } return true; });
    if (i >= 2) {
      const h2 = H[i - 2]!, l2 = Lo[i - 2]!, mid = C[i - 1]!;
      const bull = l > h2 && mid > h2, bear = h < l2 && mid < l2;
      if (bull || bear) {
        const size = bull ? (l - h2) / h2 : (l2 - h) / l2; this.gapSum += size; this.gapCount++;
        if (!cfg.fvg_auto || size >= this.gapSum / this.gapCount) {
          const g: SmcGap = bull ? { index: i - 2, formed: i, top: l, bottom: h2, dir: 1, touched: null, filled: null } : { index: i - 2, formed: i, top: l2, bottom: h, dir: -1, touched: null, filled: null };
          this.gaps.push(g); const list = bull ? this.gapsBull : this.gapsBear; list.push(g); if (list.length > MAX_ACTIVE) list.shift();
        }
      }
    }
    // ── 等高/等低 ──
    this.eqH = this.eqH.filter((e) => { if (h > e.level) { e.swept = i; return false; } return true; });
    this.eqL = this.eqL.filter((e) => { if (l < e.level) { e.swept = i; return false; } return true; });
    {
      const s = this.slides.get(cfg.eq_length)!, [ph, pl] = s.pivot(i), center = i - cfg.eq_length, tol = cfg.eq_threshold * this.atr;
      if (ph) { const p = this.eqPrevH; if (p && Number.isFinite(tol) && Math.abs(H[center]! - p.price) < tol) { const e: SmcEqual = { kind: 'EQH', a: p.index, b: center, level: Math.max(p.price, H[center]!), confirmed: i, swept: null }; this.equals.push(e); this.eqH.push(e); if (this.eqH.length > MAX_ACTIVE) this.eqH.shift(); } this.eqPrevH = { price: H[center]!, index: center, crossed: false }; }
      if (pl) { const p = this.eqPrevL; if (p && Number.isFinite(tol) && Math.abs(Lo[center]! - p.price) < tol) { const e: SmcEqual = { kind: 'EQL', a: p.index, b: center, level: Math.min(p.price, Lo[center]!), confirmed: i, swept: null }; this.equals.push(e); this.eqL.push(e); if (this.eqL.length > MAX_ACTIVE) this.eqL.shift(); } this.eqPrevL = { price: Lo[center]!, index: center, crossed: false }; }
    }
    // ── 前一日 / 前一周高低 ──
    const roll = (x: Bucket, key: number) => { if (key !== x.key) { if (Number.isFinite(x.key)) { x.ph = x.h; x.pl = x.l; } x.key = key; x.h = h; x.l = l; } else { x.h = Math.max(x.h, h); x.l = Math.min(x.l, l); } };
    roll(this.day, Math.floor(bar.open_time / 86400000)); roll(this.week, Math.floor((bar.open_time + 3 * 86400000) / (7 * 86400000)));
    // ── 快照 ──
    const scopeState = (scope: Scope): ScopeState => {
      const run = this.runs[scope]; let bull: SmcBlock | null = null, bear: SmcBlock | null = null;
      for (const b of run.bulls) if (b.bottom < c && (!bull || b.top > bull.top || (b.top === bull.top && b.formed > bull.formed))) bull = b;
      for (const b of run.bears) if (b.top > c && (!bear || b.bottom < bear.bottom || (b.bottom === bear.bottom && b.formed > bear.formed))) bear = b;
      return { trend: run.trend, bull: view(bull), bear: view(bear), retest_bull: retest[scope][0], retest_bear: retest[scope][1], liq_above: run.liqH.at(-1)?.price ?? null, liq_below: run.liqL.at(-1)?.price ?? null };
    };
    let eqh: number | null = null, eql: number | null = null;
    for (const e of this.eqH) if (e.level > c && (eqh === null || e.level < eqh)) eqh = e.level;
    for (const e of this.eqL) if (e.level < c && (eql === null || e.level > eql)) eql = e.level;
    const st: SmcState = {
      breaks: breaks.length ? breaks : NO_BREAKS, internal: scopeState('internal'), swing: scopeState('swing'),
      fvg_touch_bull: tb, fvg_touch_bear: tr2, fvg_fill_bull: fb, fvg_fill_bear: fr,
      top: this.top, bottom: this.bottom, top_index: this.topIndex, bottom_index: this.bottomIndex, eqh, eql,
      pdh: this.day.ph, pdl: this.day.pl, pwh: this.week.ph, pwl: this.week.pl, atr: this.atr, close: c,
    };
    this.states.push(st); return st;
  }
  /** [from, to] 这段里挑订单块 K 线:看涨取最低点处(看跌取最高点处),再往回找最后一根反向 K 线;高波动 K 线不参与 */
  private block(from: number, to: number, dir: Dir, scope: Scope, formed: number): SmcBlock | null {
    if (to < from) return null;
    const pick = (skipVol: boolean) => { let m = -1; for (let k = from; k <= to; k++) { if (skipVol && this.vol[k]) continue; if (m < 0 || (dir === 1 ? this.Lo[k]! < this.Lo[m]! : this.H[k]! > this.H[m]!)) m = k; } return m; };
    let m = pick(true); if (m < 0) m = pick(false);
    let k = m; for (let j = m; j >= from; j--) { if (this.vol[j]) continue; if (dir === 1 ? this.C[j]! < this.O[j]! : this.C[j]! > this.O[j]!) { k = j; break; } }
    const b: SmcBlock = { index: k, formed, top: this.H[k]!, bottom: this.Lo[k]!, dir, scope, mitigated: null };
    this.blocks.push(b); return b;
  }
}

/** 整段计算(无缓存):测试、图层与离线分析用 */
export function smcCompute(bars: ResearchBar[], p: Record<string, unknown> | SmcParams = {}): SmcMachine {
  const m = new SmcMachine(smcParams(p as Record<string, unknown>)); for (const b of bars) m.push(b); return m;
}

// ── 逐根取值的缓存:按 K 线对象身份串成状态链 ─────────────────────────────
interface Link { m: SmcMachine; k: number }
const chains = new Map<string, WeakMap<object, Link>>();
function register(wm: WeakMap<object, Link>, m: SmcMachine, from: number): void { for (let k = from; k < m.bars.length; k++) wm.set(m.bars[k]!, { m, k }); }
/** 第 i 根(ctx.bars 内下标)收盘后的状态。窗口右移一根 → 在链尾推进一步;链与窗口对不上(起点更早 / 分叉)→ 从窗口起点重建。 */
export function smcStateAt(bars: ResearchBar[], i: number, p: Record<string, unknown>): SmcState | null {
  if (i < 0 || i >= bars.length) return null;
  const cfg = smcParams(p), key = cfgKey(cfg);
  let wm = chains.get(key); if (!wm) { wm = new WeakMap(); chains.set(key, wm); }
  const head = wm.get(bars[0]!);
  if (head) {
    const { m, k: base } = head, end = Math.min(i, m.length - 1 - base);
    if (m.bars[base + end] === bars[end]) {
      if (end === i) return m.states[base + i]!;
      if (base + end === m.length - 1) { const from = m.length; for (let j = end + 1; j <= i; j++) m.push(bars[j]!); register(wm, m, from); return m.states[base + i]!; }
    }
  }
  const m = new SmcMachine(cfg); for (let j = 0; j <= i; j++) m.push(bars[j]!); register(wm, m, 0); return m.states[i]!;
}

// ── 原语 ───────────────────────────────────────────────────────────────
const paramsOf = (name: string) => (schemas.research.$defs as Record<string, unknown>)[`PrimitiveParams${name.split('_').map((x) => x[0]!.toUpperCase() + x.slice(1)).join('')}`] as Record<string, unknown>;
const scopeOf = (p: Record<string, unknown>, d: Scope): Scope => (p.scope === 'internal' || p.scope === 'swing' ? p.scope : d);
const dirOf = (p: Record<string, unknown>): Dir => (p.direction === 'bearish' ? -1 : 1);
/** 预热:所用级别的 pivot 需要 2L+1 根才可能确认一次,再加一根突破;用到 ATR(订单块过滤 / 等高等低 / 缓冲)时至少 atr_period+1 根 */
const warm = (p: Record<string, unknown>, scope: Scope | 'both', atr: boolean) => {
  const c = smcParams(p), L = scope === 'internal' ? c.internal_length : scope === 'swing' ? c.swing_length : Math.max(c.internal_length, c.swing_length);
  return Math.max(2 * L + 2, atr ? c.atr_period + 1 : 0);
};
function defineSmc(name: string, category: Primitive['category'], description: string, warmup: Primitive['warmup_bars'], fn: (st: SmcState, ctx: PrimitiveContext, p: Record<string, unknown>) => PrimitiveValue): Primitive {
  const primitive: Primitive = {
    name, category, params: paramsOf(name), warmup_bars: warmup, lookahead: 'none', describe: (p) => `${description}（${JSON.stringify(p)}）`,
    // 不经 registry.define():它会把 bars 截成新数组,状态链就按不上对象身份了。这里只读 ctx.bars[0..ctx.i]
    compute: (ctx, p) => { const st = smcStateAt(ctx.bars, ctx.i, p); return st ? fn(st, ctx, p) : {}; },
  };
  registry.set(name, primitive); return primitive;
}
const isShort = (ctx: PrimitiveContext) => ctx.side === 'short';

/** 信号:本根发生指定级别、方向、类型的结构突破(事件型,只在突破那根成立) */
export const smc_bos = defineSmc('smc_bos', 'signal', 'SMC 结构突破:本根收盘越过已确认的内部/摆动 pivot;顺势为 BOS、反转为 CHoCH', (p) => warm(p, scopeOf(p, 'internal'), false), (st, _ctx, p) => {
  const scope = scopeOf(p, 'internal'), dir = dirOf(p), kind = p.kind === 'bos' ? 'BOS' : p.kind === 'choch' ? 'CHoCH' : null;
  return { pass: st.breaks.some((b) => b.scope === scope && b.dir === dir && (!kind || b.kind === kind)) };
});
/** 信号:本根影线回踩到未失效的订单块(看涨=low 触及看涨块上沿且未跌破失效)。状态型,订单执行核取上升沿 */
export const smc_ob_retest = defineSmc('smc_ob_retest', 'signal', 'SMC 订单块回踩:本根触及未失效的看涨(看跌)订单块且未使其失效', (p) => warm(p, scopeOf(p, 'internal'), smcParams(p).ob_filter === 'atr'), (st, _ctx, p) => {
  const s = st[scopeOf(p, 'internal')]; return { pass: dirOf(p) === 1 ? s.retest_bull : s.retest_bear };
});
/** 信号:本根首次触及(mode=touch)或完全回补(mode=fill)一个此前形成的 FVG */
export const smc_fvg_fill = defineSmc('smc_fvg_fill', 'signal', 'SMC 公允价值缺口回补:价格回到此前形成的看涨(看跌)FVG,首次触及或完全回补当根触发', () => 3, (st, _ctx, p) => {
  const bull = dirOf(p) === 1, fill = p.mode === 'fill'; return { pass: bull ? (fill ? st.fvg_fill_bull : st.fvg_touch_bull) : (fill ? st.fvg_fill_bear : st.fvg_touch_bear) };
});
/** 信号(状态型):收盘处于摆动区间的折价区(下半)/溢价区(上半)/均衡区(中线 ±2.5%) */
export const smc_discount = defineSmc('smc_discount', 'signal', 'SMC 溢价/折价区:收盘位于最近摆动高低区间的折价区(下半)、溢价区(上半)或均衡区(中线附近)', (p) => warm(p, 'swing', false), (st, _ctx, p) => {
  const range = st.top - st.bottom; if (!(range > 0)) return { pass: false };
  const pos = (st.close - st.bottom) / range, zone = p.zone === 'premium' ? 'premium' : p.zone === 'equilibrium' ? 'equilibrium' : 'discount';
  return { pass: zone === 'discount' ? pos < 0.5 : zone === 'premium' ? pos > 0.5 : Math.abs(pos - 0.5) <= EQ_BAND };
});
/** 方向门:摆动(或内部)结构的当前趋势方向 = 最近一次突破的方向 */
export const smc_trend = defineSmc('smc_trend', 'regime', 'SMC 结构趋势方向门:最近一次摆动(内部)结构突破向上为看涨、向下为看跌', (p) => warm(p, scopeOf(p, 'swing'), false), (st, _ctx, p) => ({ pass: st[scopeOf(p, 'swing')].trend === dirOf(p) }));
/** 价位:多单=下方最近未失效看涨订单块(入场取上沿、止损取下沿再让 buffer_atr×ATR、止盈取上方最近看跌块下沿);空单镜像 */
export const smc_ob_level = defineSmc('smc_ob_level', 'stop', 'SMC 订单块价位:多单在最近未失效看涨订单块上沿挂限价、下沿止损(可加 ATR 缓冲)、上方看跌块下沿止盈;空单镜像', (p) => warm(p, scopeOf(p, 'internal'), true), (st, ctx, p) => {
  const s = st[scopeOf(p, 'internal')], k = Number(p.buffer_atr ?? 0), buf = k > 0 ? k * st.atr : 0; if (!Number.isFinite(buf)) return {};
  if (isShort(ctx)) return { ...(s.bear ? { level: s.bear.bottom, stop: s.bear.top + buf } : {}), ...(s.bull ? { target: s.bull.top } : {}) };
  return { ...(s.bull ? { level: s.bull.top, stop: s.bull.bottom - buf } : {}), ...(s.bear ? { target: s.bear.bottom } : {}) };
});
/** 价位(止盈):多单取上方最近的流动性 —— 未被扫的 pivot 高点 / 等高点 / 摆动 top / 溢价区 / 前日(周)高;空单镜像 */
export function liquidityTarget(st: SmcState, p: Record<string, unknown>, short: boolean): number | undefined {
  const s = st[scopeOf(p, 'swing')], src = String(p.source ?? 'liquidity'), c = st.close;
  const eq = (st.top + st.bottom) / 2, zoneEdge = short ? (c > eq ? eq : st.bottom) : (c < eq ? eq : st.top);
  const pick: Record<string, (number | null)[]> = short
    ? { liquidity: [s.liq_below, st.eql, st.bottom], swing: [s.liq_below], equal: [st.eql], premium: [zoneEdge], prev_day: [st.pdl], prev_week: [st.pwl] }
    : { liquidity: [s.liq_above, st.eqh, st.top], swing: [s.liq_above], equal: [st.eqh], premium: [zoneEdge], prev_day: [st.pdh], prev_week: [st.pwh] };
  const xs = (pick[src] ?? pick.liquidity!).filter((x): x is number => x !== null && Number.isFinite(x) && (short ? x < c : x > c));
  return xs.length ? (short ? Math.max(...xs) : Math.min(...xs)) : undefined;
}
export const smc_liquidity_target = defineSmc('smc_liquidity_target', 'stop', 'SMC 流动性止盈:多单取上方最近未被扫的摆动高点/等高点/区间顶(或溢价区、前日/周高),空单镜像取下方', (p) => warm(p, scopeOf(p, 'swing'), true), (st, ctx, p) => {
  const t = liquidityTarget(st, p, isShort(ctx)); return t === undefined ? {} : { target: t, level: t };
});
/** 离场:持仓期间出现反向 CHoCH(kind=any 时反向 BOS 也算);多单看向下、空单看向上 */
export const smc_choch_exit = defineSmc('smc_choch_exit', 'exit', 'SMC 反向 CHoCH 离场:持仓中出现与持仓方向相反的结构转换(可选含反向 BOS)当根离场', (p) => warm(p, scopeOf(p, 'internal'), false), (st, ctx, p) => {
  if (!ctx.position) return { exit: false };
  const scope = scopeOf(p, 'internal'), want: Dir = isShort(ctx) ? 1 : -1, any = p.kind === 'any';
  return { exit: st.breaks.some((b) => b.scope === scope && b.dir === want && (any || b.kind === 'CHoCH')) };
});
export const SMC_PRIMITIVES = ['smc_bos', 'smc_ob_retest', 'smc_fvg_fill', 'smc_discount', 'smc_trend', 'smc_ob_level', 'smc_liquidity_target', 'smc_choch_exit'] as const;

// ── 图层(回放 overlay=smc)──────────────────────────────────────────────
export interface SmcOverlayOut {
  params: SmcParams;
  structures: { at: number; from: number; level: number; kind: 'BOS' | 'CHoCH'; scope: Scope; dir: 'bullish' | 'bearish' }[];
  order_blocks: { from: number; formed_at: number; to: number | null; top: number; bottom: number; dir: 'bullish' | 'bearish'; scope: Scope; mitigated_at: number | null }[];
  fvgs: { from: number; formed_at: number; top: number; bottom: number; dir: 'bullish' | 'bearish'; touched_at: number | null; filled_at: number | null }[];
  eq: { kind: 'EQH' | 'EQL'; from: number; to: number; level: number; confirmed_at: number; swept_at: number | null }[];
  zones: { from: number; to: number; premium: { top: number; bottom: number }; equilibrium: { top: number; bottom: number }; discount: { top: number; bottom: number }; strong_high: boolean; strong_low: boolean } | null;
  htf_levels: { kind: 'PDH' | 'PDL' | 'PWH' | 'PWL'; from: number; to: number; level: number }[];
  trend: { internal: 'bullish' | 'bearish' | null; swing: 'bullish' | 'bearish' | null };
}
const dname = (d: Dir) => (d === 1 ? 'bullish' : 'bearish') as 'bullish' | 'bearish';
/**
 * 整段 bars 算 SMC 图层,再按 [from_ms, to_ms](K 线 open_time)裁剪;时间一律用 K 线 open_time(与回放 candles.t 一致)。
 * 事后字段(mitigated_at / filled_at / swept_at)只用于画图的终点,不回流到任何交易判断。
 */
export function smcOverlay(bars: ResearchBar[], params: Record<string, unknown> = {}, window?: { from_ms?: number; to_ms?: number }): SmcOverlayOut {
  const m = smcCompute(bars, params), t = (k: number | null) => (k === null ? null : bars[k]!.open_time);
  const lo = window?.from_ms ?? -Infinity, hi = window?.to_ms ?? Infinity, inWin = (a: number, b: number | null) => a <= hi && (b === null || b >= lo);
  const last = m.states.at(-1);
  const zones = (() => {
    if (!last || !(last.top > last.bottom)) return null;
    const eq = (last.top + last.bottom) / 2, band = (last.top - last.bottom) * EQ_BAND, trend = last.swing.trend;
    return { from: bars[Math.min(last.top_index, last.bottom_index)]!.open_time, to: bars.at(-1)!.open_time, premium: { top: last.top, bottom: eq }, equilibrium: { top: eq + band, bottom: eq - band }, discount: { top: eq, bottom: last.bottom }, strong_high: trend === -1, strong_low: trend === 1 };
  })();
  // 前日/周高低:每个 UTC 日(周)一段水平线,只在该日(周)的 K 线上画
  const htf: SmcOverlayOut['htf_levels'] = [];
  const seg = (kind: SmcOverlayOut['htf_levels'][number]['kind'], pick: (s: SmcState) => number | null) => {
    let start = -1, v: number | null = null;
    const flush = (endK: number) => { if (v !== null && start >= 0 && inWin(bars[start]!.open_time, bars[endK]!.open_time)) htf.push({ kind, from: bars[start]!.open_time, to: bars[endK]!.open_time, level: v }); };
    m.states.forEach((s, k) => { const x = pick(s); if (x !== v) { if (k > 0) flush(k - 1); start = k; v = x; } });
    if (m.states.length) flush(m.states.length - 1);
  };
  seg('PDH', (s) => s.pdh); seg('PDL', (s) => s.pdl); seg('PWH', (s) => s.pwh); seg('PWL', (s) => s.pwl);
  const tr = (x: -1 | 0 | 1) => (x === 0 ? null : dname(x));
  return {
    params: m.cfg,
    structures: m.breaks.filter((b) => inWin(bars[b.pivot]!.open_time, bars[b.index]!.open_time)).map((b) => ({ at: bars[b.index]!.open_time, from: bars[b.pivot]!.open_time, level: b.level, kind: b.kind, scope: b.scope, dir: dname(b.dir) })),
    order_blocks: m.blocks.filter((b) => inWin(bars[b.index]!.open_time, t(b.mitigated))).map((b) => ({ from: bars[b.index]!.open_time, formed_at: bars[b.formed]!.open_time, to: t(b.mitigated), top: b.top, bottom: b.bottom, dir: dname(b.dir), scope: b.scope, mitigated_at: t(b.mitigated) })),
    fvgs: m.gaps.filter((g) => inWin(bars[g.index]!.open_time, t(g.filled))).map((g) => ({ from: bars[g.index]!.open_time, formed_at: bars[g.formed]!.open_time, top: g.top, bottom: g.bottom, dir: dname(g.dir), touched_at: t(g.touched), filled_at: t(g.filled) })),
    eq: m.equals.filter((e) => inWin(bars[e.a]!.open_time, t(e.swept))).map((e) => ({ kind: e.kind, from: bars[e.a]!.open_time, to: bars[e.b]!.open_time, level: e.level, confirmed_at: bars[e.confirmed]!.open_time, swept_at: t(e.swept) })),
    zones, htf_levels: htf,
    trend: last ? { internal: tr(last.internal.trend), swing: tr(last.swing.trend) } : { internal: null, swing: null },
  };
}
/** IR 里第一个 SMC 原语的参数(让回放图层与策略口径一致);没有就用缺省 */
export function smcParamsFromIR(ir: { signal?: { primitive: string; params: Record<string, unknown> }[]; regime?: { primitive: string; params: Record<string, unknown> } | null; risk?: { stop?: { primitive: string; params: Record<string, unknown> } }; exit?: { primitive: string; params: Record<string, unknown> }[]; order?: { entry?: { price?: { primitive: string; params: Record<string, unknown> } | null } | null; take_profits?: { source: { primitive: string; params: Record<string, unknown> } }[] } | null } | null | undefined): Record<string, unknown> {
  if (!ir) return {};
  const nodes = [...(ir.signal ?? []), ...(ir.regime ? [ir.regime] : []), ...(ir.risk?.stop ? [ir.risk.stop] : []), ...(ir.exit ?? []), ...(ir.order?.entry?.price ? [ir.order.entry.price] : []), ...(ir.order?.take_profits ?? []).map((x) => x.source)];
  const hit = nodes.find((x) => x.primitive.startsWith('smc_'));
  if (!hit) return {};
  const { scope: _s, direction: _d, kind: _k, mode: _m, zone: _z, source: _src, buffer_atr: _b, ...rest } = hit.params; return rest;
}
