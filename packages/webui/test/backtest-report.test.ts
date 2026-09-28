/**
 * WP-C 回测报告面板:关键渲染(SSR 静态标记,和 research-presentation.test.ts 同一套路,不依赖 jsdom)。
 * 覆盖:三资产切换 / 全部叠加、null 指标、data_missing、0 笔成交、交易列表分页、回放模型与回放 tab。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BacktestReport, BacktestTrade } from '@trade-gate/contracts';
import { BacktestReportView, type BacktestReportViewProps } from '../src/components/backtest-report/report-view';
import { FIXTURE_DATA_MISSING, FIXTURE_FULL, FIXTURE_NO_TRADES, makeFixtureReplay } from '../src/components/backtest-report/fixture';
import { ALL_ASSETS, buildPnlSeries } from '../src/components/backtest-report/series';
import { pctDrawdown, pctSigned, formatMetric, primaryMetricDefs, moreMetricDefs } from '../src/components/backtest-report/format';
import { assetPlans, computePlanStats } from '../src/components/backtest-report/plans';
import { assignLanes, planSegments, planSpan, segmentsToSeries, snapIndex } from '../src/components/backtest-report/replay-model';
import { coverageGaps } from '../src/components/backtest-report/provenance';
import { clampRange, matchViewPreset, monthsBefore, parseDay, presetWindow, rangeProblem, rangeStats, rerunRequest, rerunSymbols, rerunTitle, viewPreset } from '../src/components/backtest-report/range';

function render(props: BacktestReportViewProps, client = new QueryClient()): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(BacktestReportView, props)));
}

/** 取 data-metric="key" 那一格里的数值文本 */
function metricText(html: string, key: string): string {
  const i = html.indexOf(`data-metric="${key}"`);
  expect(i).toBeGreaterThan(-1);
  const seg = html.slice(i, i + 1200);
  const m = /<div class="num[^"]*">([^<]*)<\/div>/.exec(seg);
  return m?.[1] ?? '';
}

describe('fixture 符合契约形状', () => {
  it('三个资产、三种形态', () => {
    expect(FIXTURE_FULL.assets.map((a) => a.key)).toEqual(['BTC', 'ETH', 'BTC+ETH']);
    expect(FIXTURE_FULL.assets.every((a) => a.status === 'completed' && a.trades.length > 0)).toBe(true);
    expect(FIXTURE_NO_TRADES.assets.every((a) => a.trades.length === 0 && a.metrics?.sharpe === null)).toBe(true);
    expect(FIXTURE_DATA_MISSING.assets.map((a) => a.status)).toEqual(['completed', 'data_missing', 'failed']);
    expect(FIXTURE_FULL.assets[0]!.equity.length).toBeLessThanOrEqual(5000);
  });
});

describe('PnL 序列', () => {
  it('全部叠加 = BTC / ETH / BTC+ETH 三条策略线,颜色各不相同;开基准再加三条虚线', () => {
    const off = buildPnlSeries(FIXTURE_FULL, ALL_ASSETS, false);
    const strat = off.lines.filter((l) => l.role === 'strategy');
    expect(strat.map((l) => l.assetKey)).toEqual(['BTC', 'ETH', 'BTC+ETH']);
    expect(new Set(strat.map((l) => l.color)).size).toBe(3);
    expect(off.lines.some((l) => l.role === 'benchmark')).toBe(false);
    const on = buildPnlSeries(FIXTURE_FULL, ALL_ASSETS, true);
    expect(on.lines.filter((l) => l.role === 'benchmark' && l.dashed)).toHaveLength(3);
  });
  it('单资产模式:一条面积线 + 基准;时间严格递增(秒)', () => {
    const s = buildPnlSeries(FIXTURE_FULL, 'ETH', true);
    expect(s.lines.map((l) => `${l.assetKey}:${l.role}`)).toEqual(['ETH:strategy', 'ETH:benchmark']);
    expect(s.lines[0]!.area).toBe(true);
    const pts = s.lines[0]!.points;
    expect(pts.every((p, i) => i === 0 || p.time > pts[i - 1]!.time)).toBe(true);
  });
  it('data_missing 资产不画线,进 missing', () => {
    const s = buildPnlSeries(FIXTURE_DATA_MISSING, ALL_ASSETS, true);
    expect(s.lines.filter((l) => l.role === 'strategy').map((l) => l.assetKey)).toEqual(['BTC']);
    expect(s.missing.map((a) => a.key)).toEqual(['ETH', 'BTC+ETH']);
    expect(buildPnlSeries(FIXTURE_DATA_MISSING, 'ETH', true).lines).toHaveLength(0);
  });
  it('0 笔成交:基准关着也强制画持有基准', () => {
    const s = buildPnlSeries(FIXTURE_NO_TRADES, 'BTC', false);
    expect(s.forcedBenchmark).toBe(true);
    expect(s.lines.map((l) => l.role)).toEqual(['strategy', 'benchmark']);
  });
});

describe('数字格式', () => {
  it('百分比两位小数带符号,最大回撤永远负号', () => {
    expect(pctSigned(0.0737)).toBe('+7.37%');
    expect(pctSigned(-0.0412)).toBe('−4.12%');
    expect(pctDrawdown(0.0453)).toBe('−4.53%');
    expect(pctDrawdown(-0.0453)).toBe('−4.53%');
    expect(pctSigned(null)).toBe('—');
  });
  it('截图 12 项 + 其余全部 BacktestMetrics 字段', () => {
    expect(primaryMetricDefs()).toHaveLength(12);
    const keys = new Set([...primaryMetricDefs(), ...moreMetricDefs()].map((d) => d.key));
    expect([...keys].sort()).toEqual(Object.keys(FIXTURE_FULL.assets[0]!.metrics!).sort());
    expect(formatMetric({ kind: 'ratio' }, null)).toBe('—');
  });
});

describe('BacktestReportView 渲染', () => {
  it('默认 primary_key 资产;头部有窗口起止与 12 项指标', () => {
    const html = render({ report: FIXTURE_FULL, header: { title: '测试策略', description: '一句描述', onAutomate: () => {}, onSettings: () => {}, onShare: () => {} } });
    expect(html).toContain('测试策略');
    expect(html).toContain('2020-01-01 → 2026-09-01');
    expect(html).toContain('data-testid="score-gauge"');
    for (const d of primaryMetricDefs()) expect(html).toContain(`data-metric="${d.key}"`);
    const primary = FIXTURE_FULL.assets.find((a) => a.key === FIXTURE_FULL.primary_key)!;
    expect(html).toContain(pctSigned(primary.metrics!.total_return));
    expect(html).toContain('v1');
  });
  it('资产切换:ETH 的总收益出现在标题;最大回撤是红色负数', () => {
    const eth = FIXTURE_FULL.assets.find((a) => a.key === 'ETH')!;
    const html = render({ report: FIXTURE_FULL, defaultAssetKey: 'ETH' });
    const headline = html.slice(html.indexOf('data-testid="pnl-headline"'), html.indexOf('data-testid="pnl-headline"') + 600);
    expect(headline).toContain(pctSigned(eth.metrics!.total_return));
    const dd = metricText(html, 'max_drawdown');
    expect(dd.startsWith('−')).toBe(true);
    const i = html.indexOf('data-metric="max_drawdown"');
    expect(html.slice(i, i + 1200)).toContain('text-down');
  });
  it('全部叠加:图例同时列出 BTC、ETH、BTC+ETH', () => {
    const html = render({ report: FIXTURE_FULL, defaultOverlay: true });
    const i = html.indexOf('data-testid="pnl-legend"');
    expect(i).toBeGreaterThan(-1);
    const legend = html.slice(i, html.indexOf('</div>', i));
    for (const k of ['BTC', 'ETH', 'BTC+ETH']) expect(legend).toContain(`>${k}<`);
  });
  it('null 指标显示 —,低置信有醒目提示', () => {
    const html = render({ report: FIXTURE_NO_TRADES, defaultMoreMetrics: true });
    for (const k of ['sharpe', 'sortino', 'win_rate', 'profit_factor', 'avg_win', 'avg_loss', 'risk_reward', 'calmar', 'alpha', 'beta']) expect(metricText(html, k)).toBe('—');
    expect(html).toContain('data-testid="low-confidence-banner"');
    expect(html).toContain('data-testid="metrics-more"');
  });
  it('0 笔成交:显示「无成交」,图照画(持有基准)', () => {
    const html = render({ report: FIXTURE_NO_TRADES });
    expect(html).toContain('data-testid="no-trades-notice"');
    expect(html).toContain('无成交');
    expect(html).toContain('data-testid="pnl-legend"');
    expect(html).toContain('持有基准');
  });
  it('data_missing:显示原因、不画线;叠加模式标出缺失资产', () => {
    const eth = FIXTURE_DATA_MISSING.assets.find((a) => a.key === 'ETH')!;
    const html = render({ report: FIXTURE_DATA_MISSING, defaultAssetKey: 'ETH' });
    expect(html).toContain('data-testid="asset-missing"');
    expect(html).toContain(eth.error!);
    expect(html).not.toContain('data-testid="pnl-legend"');
    expect(metricText(html, 'total_return')).toBe('—');
    const all = render({ report: FIXTURE_DATA_MISSING, defaultOverlay: true });
    expect(all).toContain('data-testid="pnl-legend"');
    expect(all).toContain('ETH 数据缺失');
    expect(all).toContain('BTC+ETH 计算失败');
  });
  it('表现 tab:月度热力图、样本内外对照、资产横比', () => {
    const html = render({ report: FIXTURE_FULL, defaultTab: 'performance' });
    expect(html).toContain('data-testid="monthly-heatmap"');
    expect(html).toContain('data-testid="yearly-returns"');
    expect(html).toContain('data-testid="segment-compare"');
    const i = html.indexOf('data-testid="asset-compare"');
    expect(i).toBeGreaterThan(-1);
    for (const k of ['BTC', 'ETH', 'BTC+ETH']) expect(html.slice(i, i + 4000)).toContain(k);
  });
  it('交易分析 tab:直方图 + 计划统计;0 笔时显示无成交', () => {
    const html = render({ report: FIXTURE_FULL, defaultTab: 'trades', defaultAssetKey: 'BTC' });
    expect(html).toContain('data-testid="return-histogram"');
    expect(html).toContain('data-testid="holding-histogram"');
    expect(html).toContain('data-testid="plan-stats"');
    const none = render({ report: FIXTURE_NO_TRADES, defaultTab: 'trades' });
    expect(none).toContain('无成交');
  });
  it('交易列表:上千笔分页', () => {
    const base = FIXTURE_FULL.assets[0]!.trades[0]!;
    const many: BacktestTrade[] = Array.from({ length: 1234 }, (_, i) => ({ ...base, id: `T${i}`, entry_at: base.entry_at + i * 1000, exit_at: base.exit_at + i * 1000 }));
    const report: BacktestReport = { ...FIXTURE_FULL, assets: FIXTURE_FULL.assets.map((a) => (a.key === 'BTC' ? { ...a, trades: many } : a)) as BacktestReport['assets'] };
    const html = render({ report, defaultTab: 'list', defaultAssetKey: 'BTC' });
    expect(html).toContain('data-testid="trades-table"');
    expect(html).toContain('1 / 25');
    expect((html.match(/<tr class="border-b border-border\/40/g) ?? []).length).toBe(50);
  });
  it('溯源:实际数据短于窗口会被标出', () => {
    expect(coverageGaps(FIXTURE_FULL)).toHaveLength(0);
    const short: BacktestReport = {
      ...FIXTURE_FULL,
      assets: FIXTURE_FULL.assets.map((a) => (a.key === 'ETH' && a.data ? { ...a, data: { ...a.data, last_at: Date.UTC(2022, 11, 31) } } : a)) as BacktestReport['assets'],
    };
    expect(coverageGaps(short).map((g) => g.key)).toEqual(['ETH']);
    expect(render({ report: short })).toContain('实际数据只覆盖');
  });
});

describe('策略回放', () => {
  const replay = makeFixtureReplay(FIXTURE_FULL, 'BTC');
  it('计划分泳道后同一泳道不重叠,线段断点对齐 K 线时间', () => {
    const spans = replay.plans.map((p) => planSpan(p, replay.candles));
    const lanes = assignLanes(spans);
    const byLane = new Map<number, typeof spans>();
    for (const s of spans) (byLane.get(lanes.get(s.planId)!) ?? byLane.set(lanes.get(s.planId)!, []).get(lanes.get(s.planId)!)!).push(s);
    for (const list of byLane.values()) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) expect(list[i]!.start).toBeGreaterThan(list[i - 1]!.end + 1);
    }
    const candleSecs = new Set(replay.candles.map((c) => Math.floor(c.t / 1000)));
    const filled = replay.plans.find((p) => p.filled_at !== null && p.stop_path.length > 1) ?? replay.plans.find((p) => p.filled_at !== null)!;
    const segs = planSegments(filled, replay.candles);
    expect(segs.map((s) => s.role)).toEqual(expect.arrayContaining(['entry_pending', 'entry_filled', 'stop', 'tp0']));
    for (const p of segmentsToSeries(segs.filter((s) => s.role === 'stop'), replay.candles)) expect(candleSecs.has(p.time)).toBe(true);
    expect(snapIndex(replay.candles, replay.candles[3]!.t + 1234)).toBe(3);
  });
  it('计划统计:成交率 / 未成交 / 被替换', () => {
    const plans = assetPlans(FIXTURE_FULL.assets[0])!;
    const s = computePlanStats(plans);
    expect(s.placed).toBe(plans.length);
    expect(s.filled).toBe(FIXTURE_FULL.assets[0]!.trades.length);
    expect(s.no_fill).toBeGreaterThan(0);
    expect(s.fill_rate).toBeGreaterThan(0);
    expect(s.fill_rate).toBeLessThan(1);
  });
  it('回放 tab:数据到位后渲染图容器与计划列表', () => {
    const client = new QueryClient();
    client.setQueryData(['research', 'backtest', FIXTURE_FULL.id, 'replay', 'BTC', null, null], replay);
    const html = render({ report: FIXTURE_FULL, defaultTab: 'replay', defaultAssetKey: 'BTC', replayLoader: async (k, f, t) => makeFixtureReplay(FIXTURE_FULL, k, f, t) }, client);
    expect(html).toContain('data-testid="replay-chart"');
    expect(html).toContain('data-testid="plan-list"');
    expect(html).toContain(replay.plans[replay.plans.length - 1]!.id);
  });
});

describe('时间范围(看区间 / 按区间重跑)', () => {
  const D = 86_400_000;
  const T0 = Date.UTC(2025, 0, 1);
  const pt = (day: number, equity: number, bench: number | null, exposure = 0) => ({ at: T0 + day * D, equity, pnl_pct: equity / 10000 - 1, drawdown: 0, benchmark_pct: bench, exposure });
  const trade = (id: string, entryDay: number, exitDay: number, pnl: number) =>
    ({ id, symbol: 'BTCUSDT', side: 'long', entry_at: T0 + entryDay * D, entry_price: 1, exit_at: T0 + exitDay * D, exit_price: 1, qty: 1, pnl, return_pct: pnl / 10000, fees: 0, bars_held: exitDay - entryDay, exit_reason: 'signal', segment: 'in_sample' }) as BacktestTrade;
  const asset = {
    equity: [pt(0, 10000, 0), pt(10, 11000, 0.1), pt(20, 9900, 0.21, 1), pt(30, 12100, 0.1), pt(40, 11000, 0.32)],
    trades: [trade('a', 1, 9, 1000), trade('b', 15, 25, 500), trade('c', 26, 35, -300)],
  };

  it('区间收益 / 持有收益 / 区间内最大回撤 / 区间内平仓笔数', () => {
    const s = rangeStats(asset, { from_ms: T0 + 10 * D, to_ms: T0 + 30 * D })!;
    expect(s.start_at).toBe(T0 + 10 * D);
    expect(s.end_at).toBe(T0 + 30 * D);
    expect(s.ret).toBeCloseTo(12100 / 11000 - 1, 10);
    expect(s.bench).toBeCloseTo(1.1 / 1.1 - 1, 10);
    expect(s.max_dd).toBeCloseTo(1 - 9900 / 11000, 10);
    expect(s.trades).toBe(1); // 只有 b 在 [10,30] 内平仓;c 在 35 平
    expect(s.wins).toBe(1);
    expect(s.open_at_start).toBe(false);
  });
  it('起点落在两点之间:取起点之前最后一个净值点;跨起点的持仓标出来', () => {
    const s = rangeStats(asset, { from_ms: T0 + 22 * D, to_ms: T0 + 40 * D })!;
    expect(s.start_at).toBe(T0 + 20 * D);
    expect(s.ret).toBeCloseTo(11000 / 9900 - 1, 10);
    expect(s.max_dd).toBeCloseTo(1 - 11000 / 12100, 10);
    expect(s.trades).toBe(2); // b(25)与 c(35)
    expect(s.carried_in).toBe(1);
    expect(s.open_at_start).toBe(true);
  });
  it('点不足 / 没有基准', () => {
    expect(rangeStats(asset, { from_ms: T0 + 41 * D, to_ms: T0 + 50 * D })).toBeNull();
    expect(rangeStats({ equity: asset.equity.map((p) => ({ ...p, benchmark_pct: null })), trades: [] }, { from_ms: T0, to_ms: T0 + 40 * D })!.bench).toBeNull();
    expect(rangeStats(null, { from_ms: T0, to_ms: T0 + D })).toBeNull();
  });
  it('预设窗口:今年 / 近 3、6 个月 / 近 1 年 / 全部', () => {
    const now = Date.UTC(2026, 8, 23, 12);
    expect(presetWindow('ytd', now)).toEqual({ from_ms: Date.UTC(2026, 0, 1), to_ms: now });
    expect(presetWindow('3m', now)!.from_ms).toBe(Date.UTC(2026, 5, 23, 12));
    expect(presetWindow('1y', now)!.from_ms).toBe(Date.UTC(2025, 8, 23, 12));
    expect(presetWindow('all', now)).toBeNull();
    expect(monthsBefore(Date.UTC(2026, 4, 31), 3)).toBe(Date.UTC(2026, 1, 28)); // 5/31 往回 3 个月 → 2/28
  });
  it('看区间:预设与报告窗口求交,覆盖整窗口 = 全部', () => {
    const win = { from_ms: Date.UTC(2020, 0, 1), to_ms: Date.UTC(2026, 8, 1) };
    expect(viewPreset('6m', win)).toEqual({ from_ms: Date.UTC(2026, 2, 1), to_ms: win.to_ms });
    expect(viewPreset('all', win)).toBeNull();
    const short = { from_ms: Date.UTC(2026, 6, 1), to_ms: Date.UTC(2026, 8, 1) };
    expect(viewPreset('1y', short)).toBeNull();
    expect(matchViewPreset(viewPreset('3m', win), win, D)).toBe('3m');
    expect(matchViewPreset(null, win, D)).toBe('all');
    expect(clampRange({ from_ms: win.from_ms - D, to_ms: win.from_ms + 10 * D }, win, 3 * D)).toEqual({ from_ms: win.from_ms, to_ms: win.from_ms + 10 * D });
    expect(clampRange({ from_ms: win.from_ms + D, to_ms: win.from_ms + 2 * D }, win, 3 * D)).toBeNull();
  });
  it('重跑请求体:同一 IR / 周期,主资产 symbol 排第一,篮子不传,标题注明区间', () => {
    const r = { ...FIXTURE_FULL, primary_key: 'ETH', title: '稳健中心 · 区间 2024-01-01→2024-06-30' };
    const sym = (k: string) => r.assets.find((a) => a.key === k)!.symbols[0];
    expect(rerunSymbols(r)).toEqual([sym('ETH'), sym('BTC')]);
    const range = { from_ms: Date.UTC(2025, 0, 1), to_ms: Date.UTC(2025, 5, 30, 23, 59, 59, 999) };
    const body = rerunRequest(r, range, '全部窗口');
    expect(body.strategy_ir).toBe(r.strategy_ir);
    expect(body.timeframe).toBe(r.timeframe);
    expect(body.from_ms).toBe(range.from_ms);
    expect(body.to_ms).toBe(range.to_ms);
    expect(body.title).toBe('稳健中心 · 区间 2025-01-01→2025-06-30');
    const all = rerunRequest(r, null, '全部窗口');
    expect('from_ms' in all || 'to_ms' in all).toBe(false);
    expect(all.title).toBe('稳健中心 · 区间 全部窗口');
    expect(rerunTitle('x'.repeat(400), range, 'all').length).toBeLessThanOrEqual(300);
  });
  it('重跑区间校验与日期解析', () => {
    const now = Date.UTC(2026, 8, 23);
    expect(rangeProblem(null, '1d', now)).toBeNull();
    expect(rangeProblem({ from_ms: now - 10 * D, to_ms: now }, '1d', now)).toBeNull();
    expect(rangeProblem({ from_ms: now - 2 * D, to_ms: now }, '1d', now)).toBe('too_short');
    expect(rangeProblem({ from_ms: now - 2 * D, to_ms: now - 5 * D }, '1d', now)).toBe('order');
    expect(rangeProblem({ from_ms: now + D, to_ms: now + 9 * D }, '1d', now)).toBe('future');
    expect(rangeProblem({ from_ms: now - 2 * D, to_ms: now }, '1h', now)).toBeNull();
    expect(parseDay('2025-02-30')).toBeNull();
    expect(parseDay('2025-03-01')).toBe(Date.UTC(2025, 2, 1));
    expect(parseDay('2025-03-01', true)).toBe(Date.UTC(2025, 2, 2) - 1);
  });
  it('报告视图:有看区间时渲染区间指标与口径说明;头部有换区间重跑入口', () => {
    const primary = FIXTURE_FULL.assets.find((a) => a.key === FIXTURE_FULL.primary_key)!;
    const eq = primary.equity;
    const range = { from_ms: eq[Math.floor(eq.length / 3)]!.at, to_ms: eq[Math.floor((eq.length * 2) / 3)]!.at };
    const html = render({ report: FIXTURE_FULL, defaultRange: range });
    expect(html).toContain('data-testid="range-toolbar"');
    expect(html).toContain('data-testid="range-stats"');
    expect(html).toContain('区间内派生,未扣期初持仓,不是重跑。');
    expect(html).toContain(pctSigned(rangeStats(primary, range)!.ret));
    expect(html).toContain('data-testid="range-rerun-trigger"');
    const plain = render({ report: FIXTURE_FULL, rangeRerun: false });
    expect(plain).not.toContain('range-rerun-trigger');
    expect(plain).not.toContain('data-testid="range-stats"');
  });
});
