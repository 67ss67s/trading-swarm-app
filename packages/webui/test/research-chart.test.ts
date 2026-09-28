// 研究图表渲染(Horizon 式):坐标轴标题、分界线、带点折线、柱顶标签、散点盈亏色、热力图、单位格式化、旧图不受影响
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LoopChart } from '@trade-gate/contracts';
import { ResearchChart, formatChartValue, isResearchChart } from '../src/components/research-workbench/research-chart';
import { ArtifactBody } from '../src/components/research-workbench/artifacts';
vi.mock('@/components/markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

const T0 = Date.UTC(2020, 0, 1), DAY = 86400000;
const base = { kind: 'chart', version: 'research-chart/v1' } as const;
const equity: LoopChart = {
  ...base, template: 'equity_comparison', title: '权益曲线对比', type: 'line', x: 'time', x_title: '日期', y_title: '权益 ($)', y_unit: '$',
  series: [
    { name: '持有 BTC ($10k)', mode: 'line', role: 'benchmark', points: Array.from({ length: 800 }, (_, i) => [T0 + i * DAY, 10000 + i * 20]) },
    { name: '均线金叉 · BTC ($10k)', mode: 'line+markers', role: 'strategy', points: Array.from({ length: 800 }, (_, i) => [T0 + i * DAY, i === 5 ? null : 10000 + i * 3]) },
  ],
  annotations: [{ type: 'vline', x: T0 + 560 * DAY, label: '样本外 →', role: 'split' }], caption: '$10k 起步:策略期末 $12.4k', report_id: 'r1',
};
const bars: LoopChart = {
  ...base, template: 'exit_reason_pnl', title: '按退出类型的盈亏', type: 'bar', x: 'category', x_title: '退出类型', y_title: '盈亏 ($)', y_unit: '$',
  series: [{ name: '净盈亏', mode: 'bar', role: 'neutral', points: [['追踪止损', 2400], ['止损', -1000]], labels: ['10 笔', '28T'], point_roles: ['positive', 'negative'] }],
  annotations: [{ type: 'hline', y: 0 }],
};
const scatter: LoopChart = {
  ...base, template: 'trade_scatter', title: '逐笔盈亏', type: 'scatter', x: 'linear', x_title: '交易序号', y_title: '盈亏 ($)', y_unit: '$',
  series: [{ name: '单笔净盈亏', mode: 'scatter', role: 'neutral', points: [[1, -100], [2, 160], [3, 170]], point_roles: ['negative', 'positive', 'positive'] }],
  annotations: [{ type: 'hline', y: 0 }, { type: 'vline', x: 2.5, label: '样本外 →', role: 'split' }],
};
const heat: LoopChart = {
  ...base, template: 'monthly_heatmap', title: '月度收益热力图', type: 'heatmap', x: 'category', x_title: '月份', y_title: '年份', y_unit: '%',
  series: [], annotations: [], heatmap: { x: Array.from({ length: 12 }, (_, i) => `${i + 1}月`), y: ['2022', '2023'], z: [Array.from({ length: 12 }, (_, i) => (i % 2 ? 5 : -2)), Array.from({ length: 12 }, (_, i) => (i < 2 ? 1.5 : null))] },
};
const html = (c: LoopChart, h = 320) => renderToStaticMarkup(createElement(ResearchChart, { chart: c, height: h }));

describe('研究图表渲染', () => {
  it('权益曲线:轴标题、分界竖线与标注、带点策略线、断点不补线、底部图例、图下标题与 Share', () => {
    const out = html(equity);
    expect(out).toContain('权益 ($)');
    expect(out).toContain('日期');
    expect(out).toContain('样本外 →');
    expect(out).toContain('stroke-dasharray="4 3"');
    expect(out).toContain('Share');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('均线金叉 · BTC ($10k)');
    expect(out).toContain('<figcaption');
    expect(out).toContain('$10k 起步');
    // 带点:点太密时抽到约 90 个;null 处断开成两段 path
    const circles = (out.match(/<circle[^>]*r="2.2"/g) ?? []).length;
    expect(circles).toBeGreaterThan(40);
    expect(circles).toBeLessThanOrEqual(100);
    const strat = out.match(/<path d="(M[^"]+)" fill="none" stroke="#e0a030"/)![1]!;
    expect(strat.match(/M/g)).toHaveLength(2);
    // $ 轴刻度用 k 缩写,年份刻度
    expect(out).toMatch(/>1\dk</);
    expect(out).toContain('>2021<');
  });
  it('柱状:柱顶文字带笔数与金额,正绿负红', () => {
    const out = html(bars);
    expect(out).toContain('10 笔 · $2.4k');
    expect(out).toContain('28T · -$1k');
    expect(out).toContain('fill="#2fb36f"');
    expect(out).toContain('fill="#e5534b"');
    expect(out).toContain('退出类型');
    expect(out).toContain('盈利'); // 单序列带正负角色 → 图例显示盈利/亏损
  });
  it('散点:点数与交易数一致、分界竖线', () => {
    const out = html(scatter);
    expect((out.match(/<circle[^>]*r="3.8"/g) ?? []).length).toBe(3);
    expect(out).toContain('交易序号');
    expect(out).toContain('样本外 →');
  });
  it('热力图:12 列 × 年份行,缺月留空,数值标签', () => {
    const out = html(heat);
    expect((out.match(/<rect[^>]*rx="3"/g) ?? []).length).toBe(24);
    expect(out).toContain('2023');
    expect(out).toContain('5.00%');
  });
  it('单位格式化', () => {
    expect(formatChartValue(10000, '$')).toBe('$10k');
    expect(formatChartValue(9974.38, '$')).toBe('$9.97k');
    expect(formatChartValue(-1234, '$')).toBe('-$1.23k');
    expect(formatChartValue(-12.345, '%')).toBe('-12.3%');
    expect(formatChartValue(3.2, '%')).toBe('+3.20%');
    expect(formatChartValue(null, '$')).toBe('—');
  });
  it('ArtifactBody 按版本分流:新图走 Horizon 式渲染,旧图仍走旧 ChartView', () => {
    expect(isResearchChart(equity)).toBe(true);
    const art = (content: unknown) => ({ id: 'a', chat_id: null, run_id: null, kind: 'chart' as const, title: 't', created_at: 1, content });
    expect(renderToStaticMarkup(createElement(ArtifactBody, { artifact: art(equity), height: 300 }))).toContain('research-chart');
    const legacy = renderToStaticMarkup(createElement(ArtifactBody, { artifact: art({ kind: 'chart', type: 'line', x: 'time', y_label: 'USD', series: [{ name: 'close', points: [[1, 2], [2, 3]] }] }), height: 300 }));
    expect(legacy).not.toContain('research-chart');
    expect(legacy).toContain('<svg');
  });
});
