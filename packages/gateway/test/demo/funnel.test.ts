// 零 PROPOSE 漏斗(funnel.ts)+ 它触发的两处修改:scanChecklist 的突破位口径、breakout_retest v2 草稿。
// 全程离线:K 线是合成的,路由用假 fetch,不碰网络也不调模型。

import { describe, expect, it } from 'vitest';
import {
  CONDITION_KEYS,
  CURRENT_THRESHOLDS,
  LADDER,
  computeMetrics,
  evaluateBar,
  funnelForSeries,
  rollingAtr,
  scoreCandidate,
  type FunnelThresholds,
  type SeriesBundle,
} from '../../src/demo/funnel.js';
import { scanChecklist } from '../../src/demo/review-metrics.js';
import { tfFeatures } from '../../src/demo/market.js';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { ensureBreakoutRetestV2, scanThresholdsOf } from '../../src/demo/strategies.js';
import { funnelRoutes, clearFunnelCache } from '../../src/demo/routes-funnel.js';
import type { RouteContext, RouteHandler } from '../../src/demo/http-extra.js';
import type { Kline } from '../../src/demo/types.js';

const MIN = 60_000;

/** 合成一根 K 线;`t` 是开盘时间的序号。 */
function bar(tf_ms: number, i: number, open: number, high: number, low: number, close: number, volume: number): Kline {
  const open_time = 1_700_000_000_000 + i * tf_ms;
  return { open_time, open: String(open), high: String(high), low: String(low), close: String(close), volume: String(volume), close_time: open_time + tf_ms - 1 };
}

/**
 * 一条"已知答案"的序列:前 `flat` 根在 [99, 101] 之间横盘(20 根高点稳定在 101),
 * 第 `flat` 根一根收在 103(**收盘突破**前 20 根的 101,量比很高),其后 `after` 根缓慢回踩到 102 附近。
 * 于是:突破根在 prior 口径下是 `broke_up`,在 self 口径下**不是**(它自己的 high 就是 103.5)。
 */
function breakoutSeries(flat = 60, after = 20, tfMs = 15 * MIN): Kline[] {
  const ks: Kline[] = [];
  for (let i = 0; i < flat; i++) ks.push(bar(tfMs, i, 100, 101, 99, 100 + (i % 2 ? 0.2 : -0.2), 100));
  ks.push(bar(tfMs, flat, 100.2, 103.5, 100, 103, 400)); // 突破那根:放量
  for (let i = 0; i < after; i++) ks.push(bar(tfMs, flat + 1 + i, 103, 103.2, 101.8, 102.4 - i * 0.02, 60)); // 回踩,缩量
  return ks;
}

/** 同一段行情在 1h/4h/1d 上的粗糙镜像,方向一致(EMA20 > EMA50),让趋势条件成立。 */
function higherTf(tfMs: number, n: number, drift: number): Kline[] {
  const ks: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const c = 90 + i * drift;
    ks.push(bar(tfMs, i, c - 0.1, c + 0.5, c - 0.5, c, 100));
  }
  return ks;
}

function bundle(base: Kline[]): SeriesBundle {
  const span = base[base.length - 1]!.close_time - base[0]!.open_time;
  const n1 = Math.ceil(span / (60 * MIN)) + 200;
  return {
    base,
    h1: higherTf(60 * MIN, n1, 0.05).map((k, i) => ({ ...k, open_time: base[0]!.open_time - 200 * 60 * MIN + i * 60 * MIN, close_time: base[0]!.open_time - 200 * 60 * MIN + (i + 1) * 60 * MIN - 1 })),
    h4: higherTf(240 * MIN, 200, 0.2).map((k, i) => ({ ...k, open_time: base[0]!.open_time - 150 * 240 * MIN + i * 240 * MIN, close_time: base[0]!.open_time - 150 * 240 * MIN + (i + 1) * 240 * MIN - 1 })),
    d1: [],
    funding: [],
  };
}

// ---------------------------------------------------------------- 根因:恒为假的 breakout

describe('funnel — 现行 breakout 判据恒为假', () => {
  it('close > swing_high_20 在任何 K 线上都不可能成立', () => {
    const base = breakoutSeries();
    const s = bundle(base);
    const from = base[30]!.close_time;
    const to = base[base.length - 1]!.close_time;
    const { metrics } = computeMetrics(s, '15m', from, to);
    expect(metrics.length).toBeGreaterThan(20);
    for (const m of metrics) {
      expect(m.close > m.hi20).toBe(false);
      expect(m.close < m.lo20).toBe(false);
    }
    // 而 prior 口径下,合成序列里**恰好一根**收破(第 `flat` 根)。
    expect(metrics.filter((m) => m.broke_up).length).toBe(1);
  });

  it('自带答案的序列:现行规则 0 个候选,换成 prior 口径后正好 1 个', () => {
    const base = breakoutSeries();
    const s = bundle(base);
    const from = base[25]!.close_time;
    const to = base[base.length - 1]!.close_time;
    const { metrics } = computeMetrics(s, '15m', from, to);
    const brk = metrics.filter((m) => evaluateBar(m, { ...CURRENT_THRESHOLDS, breakout_level: 'self' }).pass.breakout);
    expect(brk).toHaveLength(0);
    const brkPrior = metrics.filter((m) => evaluateBar(m, { ...CURRENT_THRESHOLDS, breakout_level: 'prior' }).pass.breakout);
    expect(brkPrior).toHaveLength(1);
    expect(brkPrior[0]!.vol_ratio).toBeGreaterThan(1.5); // 突破那根确实是放量的
  });

  it('回踩窗口放宽到 12 根后,突破之后的 11 根也算数', () => {
    const base = breakoutSeries();
    const s = bundle(base);
    const { metrics } = computeMetrics(s, '15m', base[25]!.close_time, base[base.length - 1]!.close_time);
    const th: FunnelThresholds = { ...CURRENT_THRESHOLDS, breakout_level: 'prior', breakout_window: 12 };
    expect(metrics.filter((m) => evaluateBar(m, th).pass.breakout)).toHaveLength(12);
  });

  it('量比 either 口径:回踩那几根自己缩量,但突破那根放量 → 通过', () => {
    const base = breakoutSeries();
    const s = bundle(base);
    const { metrics } = computeMetrics(s, '15m', base[25]!.close_time, base[base.length - 1]!.close_time);
    const retestBar = metrics.find((m) => m.bars_since_up === 3)!;
    expect(retestBar.vol_ratio).toBeLessThan(1); // 回踩缩量,现行口径过不了
    expect(evaluateBar(retestBar, { ...CURRENT_THRESHOLDS, breakout_level: 'prior', breakout_window: 12 }).pass.retest_vol).toBe(false);
    expect(evaluateBar(retestBar, { ...CURRENT_THRESHOLDS, breakout_level: 'prior', breakout_window: 12, vol_mode: 'either' }).pass.retest_vol).toBe(true);
  });
});

// ---------------------------------------------------------------- 边际杀伤 / 阶梯单调

describe('funnel — 边际杀伤与阶梯', () => {
  it('边际杀伤 = 其余全过、只死在这一条的根数,且恒 ≤ 未通过数', () => {
    const base = breakoutSeries(80, 40);
    const out = funnelForSeries('TESTUSDT', bundle(base), base[25]!.close_time, base[base.length - 1]!.close_time);
    expect(out.bars).toBeGreaterThan(30);
    for (const c of out.conditions) expect(c.marginal_kills).toBeLessThanOrEqual(out.bars - c.pass);
    // 现行规则下 breakout 通过 0 次,于是它一个人吃掉全部杀伤、其余六条必然是 0。
    const brk = out.conditions.find((c) => c.key === 'breakout')!;
    expect(brk.pass).toBe(0);
    for (const c of out.conditions) if (c.key !== 'breakout') expect(c.marginal_kills).toBe(0);
    expect(out.joint).toBe(0);
  });

  it('阶梯单调:每一级的联合通过数都不小于前一级', () => {
    const base = breakoutSeries(120, 60);
    const out = funnelForSeries('TESTUSDT', bundle(base), base[25]!.close_time, base[base.length - 1]!.close_time);
    expect(out.ladder.map((r) => r.key)).toEqual(LADDER.map((r) => r.key));
    for (let i = 1; i < out.ladder.length; i++) {
      expect(out.ladder[i]!.joint, `${out.ladder[i]!.key} 不该比 ${out.ladder[i - 1]!.key} 少`).toBeGreaterThanOrEqual(out.ladder[i - 1]!.joint);
    }
    expect(out.ladder[0]!.joint).toBe(0);
    expect(out.ladder.at(-1)!.joint).toBeGreaterThan(0);
  });

  it('每一级的联合通过数都 ≥ 现行规则(放宽不会挡掉原本通过的根)', () => {
    const base = breakoutSeries(120, 60);
    const out = funnelForSeries('TESTUSDT', bundle(base), base[25]!.close_time, base[base.length - 1]!.close_time);
    for (const rung of out.ladder) expect(rung.joint).toBeGreaterThanOrEqual(out.joint);
  });

  it('结算:止损/止盈按 outcome.ts 口径,R 恒在 [-1, tp_r] 内', () => {
    const base = breakoutSeries(120, 60);
    const out = funnelForSeries('TESTUSDT', bundle(base), base[25]!.close_time, base[base.length - 1]!.close_time);
    const last = out.ladder.at(-1)!;
    expect(last.outcome.n).toBeGreaterThan(0);
    expect(last.outcome.win_rate).not.toBeNull();
    expect(last.outcome.expectancy_r!).toBeGreaterThanOrEqual(-1.0001);
    expect(last.outcome.expectancy_r!).toBeLessThanOrEqual(1.5001);
  });

  it('rollingAtr 与 market.atr 同口径', () => {
    const base = breakoutSeries(40, 5);
    const roll = rollingAtr(base, 14);
    // market.atr(最后 14 根真实波幅的均值)在最后一根上应与滚动值一致。
    const trs: number[] = [];
    for (let i = 1; i < base.length; i++) {
      const h = Number(base[i]!.high);
      const l = Number(base[i]!.low);
      const pc = Number(base[i - 1]!.close);
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const expected = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
    expect(roll.at(-1)!).toBeCloseTo(expected, 9);
  });

  it('scoreCandidate:止损在成交价错误一侧时退化成成交价 ∓ stop_atr·ATR,不会返回 null', () => {
    const base = breakoutSeries();
    const s = bundle(base);
    const { metrics, index } = computeMetrics(s, '15m', base[25]!.close_time, base[base.length - 1]!.close_time);
    const i = metrics.findIndex((m) => m.broke_up);
    const ev = evaluateBar(metrics[i]!, { ...CURRENT_THRESHOLDS, breakout_level: 'prior' });
    const r = scoreCandidate(s.base, index[i]!, metrics[i]!, ev, { stop_atr: 0.8, tp_r: 1.5, horizon_bars: 20 });
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThanOrEqual(-1.0001);
  });

  it('没有 K 线的窗口不炸,给出 note', () => {
    const base = breakoutSeries();
    const out = funnelForSeries('TESTUSDT', bundle(base), base[0]!.open_time - 10 * 86_400_000, base[0]!.open_time - 9 * 86_400_000);
    expect(out.bars).toBe(0);
    expect(out.note).toMatch(/没有可用/);
    expect(out.joint).toBe(0);
  });
});

// ---------------------------------------------------------------- scanChecklist 的修正

describe('scanChecklist — 突破位口径与策略门槛', () => {
  const features = (base: Kline[], upto: number) => {
    const win = base.slice(Math.max(0, upto - 59), upto + 1);
    const f = tfFeatures('15m', win);
    const up = { ...f, tf: '1h', ema20: 110, ema50: 100 };
    const up4 = { ...f, tf: '4h', ema20: 110, ema50: 100 };
    return [f, up, up4];
  };

  it('tfFeatures 现在带 prev 窗口,且 swing_high_20_prev ≤ swing_high_20', () => {
    const base = breakoutSeries();
    const f = tfFeatures('15m', base.slice(0, 61));
    expect(f.swing_high_20_prev).toBeDefined();
    expect(f.swing_high_20_prev!).toBeLessThanOrEqual(f.swing_high_20);
    expect(f.swing_low_20_prev!).toBeGreaterThanOrEqual(f.swing_low_20);
  });

  it('突破那根:回踩确认现在能成立(修之前恒为否)', () => {
    const base = breakoutSeries();
    const chk = scanChecklist(features(base, 60))!;
    expect(chk.trend_agree).toBe('long');
    expect(chk.retest_confirmed).toBe(true);
    expect(chk.watch_eligible).toBe(false); // 回踩已确认 → 不再是"只盯着"
    // 老口径(没有 prev 字段的历史 fixture)仍然退回旧行为,不会崩。
    const legacy = features(base, 60).map((f) => {
      const { swing_high_20_prev: _a, swing_low_20_prev: _b, ...rest } = f;
      return rest;
    });
    expect(scanChecklist(legacy)!.retest_confirmed).toBe(false);
  });

  it('回踩那几根:窗口 1 根不算,窗口 12 根 + klines 才算', () => {
    const base = breakoutSeries();
    const at = 64; // 突破后第 4 根
    const f = features(base, at);
    expect(scanChecklist(f)!.retest_confirmed).toBe(false);
    const wide = scanChecklist(f, base.slice(0, at + 1), { breakout_window: 12, retest_vol_min: 0.1 })!;
    expect(wide.retest_confirmed).toBe(true);
    expect(wide.text).toContain('近 12 根内');
  });

  it('门槛来自参数:chase_atr_max 一改,within_chase 与文案跟着变', () => {
    const base = breakoutSeries();
    const f = features(base, 70);
    const tight = scanChecklist(f, undefined, { chase_atr_max: 0.01 })!;
    expect(tight.within_chase).toBe(false);
    expect(tight.text).toContain('上限 0.0');
    const loose = scanChecklist(f, undefined, { chase_atr_max: 3 })!;
    expect(loose.within_chase).toBe(true);
  });

  it('scanThresholdsOf 取策略参数,但**不**覆盖分周期 ATR 表', () => {
    const store = new DemoStore(openStateDb(':memory:'));
    const v1 = store.strategies.version('breakout_retest', 1)!;
    const th = scanThresholdsOf(v1);
    expect(th.chase_atr_max).toBe(1.5);
    expect(th.retest_vol_min).toBe(1);
    expect(th.breakout_window).toBe(1);
    expect(th.atr_pct_floor).toBeUndefined();
  });
});

// ---------------------------------------------------------------- v2 草稿

describe('breakout_retest v2 草稿', () => {
  it('开机自动生成一次,状态 backtest,v1 一个字没变', () => {
    const store = new DemoStore(openStateDb(':memory:'));
    const head = store.strategies.head('breakout_retest')!;
    expect(head.version).toBe(2);
    expect(head.status).toBe('backtest');
    expect(head.params['breakout_window']!.value).toBe(12);
    expect(head.params['retest_vol_min']!.value).toBe(2);
    expect(head.parent_version).toBe(1);
    const v1 = store.strategies.version('breakout_retest', 1)!;
    expect(v1.status).toBe('paper');
    expect(v1.params['breakout_window']!.value).toBe(1);
    expect(v1.params['retest_vol_min']!.value).toBe(1);
    // 幂等:再跑一次不会生成 v3。
    expect(ensureBreakoutRetestV2(store.strategies)).toBeNull();
    expect(store.strategies.versions('breakout_retest').map((v) => v.version)).toEqual([2, 1]);
  });

  it('head 是 backtest 时,实盘 resolve 退回到仍是 paper 的 v1(不会静默清空策略)', () => {
    const store = new DemoStore(openStateDb(':memory:'));
    const live = store.strategies.resolve(['breakout_retest'], { allow_below_paper: false });
    expect(live.errors).toEqual([]);
    expect(live.specs).toHaveLength(1);
    expect(live.specs[0]!.version).toBe(1);
    expect(live.specs[0]!.status).toBe('paper');
    // 回测侧照旧拿 head(v2)。
    expect(store.strategies.resolve(['breakout_retest'], { allow_below_paper: true }).specs[0]!.version).toBe(2);
  });

  it('v2 的门槛能直接喂给 scanChecklist', () => {
    const store = new DemoStore(openStateDb(':memory:'));
    const th = scanThresholdsOf(store.strategies.head('breakout_retest')!);
    expect(th.breakout_window).toBe(12);
    expect(th.retest_vol_min).toBe(2);
  });
});

// ---------------------------------------------------------------- 路由形状

describe('GET /api/funnel', () => {
  function harness(): { call: (query: string) => Promise<{ status: number; body: any }> } {
    const routes = new Map<string, RouteHandler>();
    const ctx = {
      route: (method: string, path: string, handler: RouteHandler) => routes.set(`${method} ${path}`, handler),
      guarded: (fn: RouteHandler) => fn,
      json: () => undefined,
      fail: () => undefined,
      readBody: async () => ({}),
      rt: {} as never,
      store: {} as never,
      oauth: null,
      emit: () => undefined,
    } as unknown as RouteContext;
    let out: { status: number; body: any } = { status: 0, body: null };
    (ctx as { json: unknown }).json = (_res: unknown, status: number, body: unknown) => {
      out = { status, body };
    };
    (ctx as { fail: unknown }).fail = (_res: unknown, status: number, message: string, code?: string) => {
      out = { status, body: { error: message, code } };
    };
    funnelRoutes(ctx);
    return {
      call: async (query: string) => {
        const url = new URL(`http://x/api/funnel${query}`);
        await routes.get('GET /api/funnel')!({} as never, {} as never, url, {});
        return out;
      },
    };
  }

  it('拒绝过多的 symbols', async () => {
    clearFunnelCache();
    const h = harness();
    const res = await h.call(`?symbols=${Array.from({ length: 41 }, (_, i) => `S${i}USDT`).join(',')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('too_many_symbols');
  });

  it('返回 report + aggregate,并在 10 分钟内命中缓存', async () => {
    clearFunnelCache();
    const original = globalThis.fetch;
    // 假服务器是币安形状:fork 默认 okx,这里显式钉币安分支(OKX 分流见 funnel-okx.test.ts)。
    const savedExchange = process.env['TG_EXCHANGE'];
    process.env['TG_EXCHANGE'] = 'binance';
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls++;
      const u = String(input);
      if (u.includes('exchangeInfo')) return new Response(JSON.stringify({ symbols: [{ symbol: 'FAKEUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', onboardDate: 1 }] }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    try {
      const h = harness();
      const res = await h.call('?symbols=FAKEUSDT,NOPEUSDT&days=3');
      expect(res.status).toBe(200);
      expect(res.body.report.days).toBe(3);
      expect(res.body.report.missing).toEqual(['NOPEUSDT']);
      expect(res.body.report.listed.map((l: { symbol: string }) => l.symbol)).toEqual(['FAKEUSDT']);
      expect(res.body.report.symbols[0]!.conditions.map((c: { key: string }) => c.key)).toEqual([...CONDITION_KEYS]);
      expect(Array.isArray(res.body.aggregate)).toBe(true);
      expect(res.body.cached).toBe(false);
      const after = calls;
      const again = await h.call('?symbols=FAKEUSDT,NOPEUSDT&days=3');
      expect(again.body.cached).toBe(true);
      expect(calls).toBe(after); // 缓存命中 = 一个请求都没发
    } finally {
      globalThis.fetch = original;
      if (savedExchange === undefined) delete process.env['TG_EXCHANGE'];
      else process.env['TG_EXCHANGE'] = savedExchange;
    }
  });
});
