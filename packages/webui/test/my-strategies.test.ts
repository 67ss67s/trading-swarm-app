// 「我的策略」(§9.46)前端测试:卡片三种形态、筛选计数、进 live 的 LIVE 确认、hash 路由约定。
// 与 research-presentation.test.ts 同样在 node 环境里 renderToStaticMarkup,不起浏览器。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResearchStrategy } from '@trading-swarm/contracts';

const myStrategies = vi.fn();
vi.mock('@/api/client', () => ({ researchApi: { myStrategies: (...a: unknown[]) => myStrategies(...a) } }));

import { StrategyCard, type StrategyCardActions } from '../src/components/my-strategies/strategy-card';
import { FilterCapsules, fetchMyStrategies } from '../src/components/my-strategies/strategy-list';
import { LifecycleStepper } from '../src/components/my-strategies/strategy-detail';
import { glyphCells } from '../src/components/my-strategies/strategy-glyph';
import { equityGeometry, toneOf } from '../src/components/my-strategies/equity-area';
import {
  detailHash,
  fmtDrawdown,
  fmtReturn,
  nextForwardTransition,
  parseRoute,
  reportHash,
  researchHash,
  transitionConfirmText,
  transitionRequest,
} from '../src/components/my-strategies/model';

const NOW = Date.UTC(2026, 8, 23, 12);
const DAY = 86_400_000;

function strategy(over: Partial<ResearchStrategy> = {}): ResearchStrategy {
  return {
    id: 'rs_golden_cross',
    name: 'BTC Daily Golden Cross Strategy',
    description: '',
    status: 'backtested',
    symbol: 'BTCUSDT',
    timeframe: '1d',
    watchlist: false,
    alerts: false,
    current_version: 1,
    created_at: NOW - 10 * DAY,
    updated_at: NOW - 3 * DAY,
    origin: { session_id: 'ses_1', inquiry_id: null, source: 'research_loop' },
    summary: {
      total_return: 0.074,
      sharpe: 0.95,
      max_drawdown: -0.045,
      win_rate: 1,
      trades: 1,
      score: 62,
      score_label: 'fair',
      sparkline: [10000, 10000, 10000, 9950, 10200, 10600, 10500, 10740],
      report_id: 'bt_1',
      backtested_at: NOW - 3 * DAY,
    },
    lab_strategy_id: null,
    published_listing_id: null,
    ...over,
  };
}

const noop = () => {};
const actions: StrategyCardActions = { open: noop, share: noop, rename: noop, toggleWatchlist: noop, toggleAlerts: noop, rebacktest: noop, archive: noop, continueBuilding: noop };
const card = (s: ResearchStrategy) => renderToStaticMarkup(createElement(StrategyCard, { strategy: s, actions, now: NOW }));

describe('strategy card shapes', () => {
  it('renders a backtested card: curve, total return and the four stats', () => {
    const html = card(strategy());
    expect(html).toContain('data-shape="backtested"');
    expect(html).toContain('BTC Daily Golden Cross Strategy');
    expect(html).toContain('BTCUSDT · 1D');
    expect(html).toContain('+7.4%');
    expect(html).toContain('总收益');
    expect(html).toContain('0.95');
    expect(html).toContain('−4.5%');
    expect(html).toContain('100.0%');
    expect(html).toContain('<svg'); // 收益曲线
    expect(html).not.toContain('还没有回测');
  });

  it('renders a draft card: spinner, not-backtested copy and continue building', () => {
    const html = card(strategy({ id: 'rs_draft', name: 'Untitled', status: 'draft', summary: null, symbol: '', timeframe: '' }));
    expect(html).toContain('data-shape="draft"');
    expect(html).toContain('还没有回测');
    expect(html).toContain('跑一次回测看看表现');
    expect(html).toContain('继续构建');
    expect(html).toContain('草稿 · 3 天前');
    expect(html).not.toContain('总收益');
    expect(html).not.toContain('aria-label="分享"'); // 草稿不给分享
  });

  it('renders a zero-trade card: flat 0.0% and em-dashes for sharpe / win rate', () => {
    const s = strategy({
      id: 'rs_gap',
      name: 'Multi-Asset Gap Continuation',
      timeframe: '1h',
      summary: { ...strategy().summary!, total_return: 0, sharpe: null, max_drawdown: 0, win_rate: null, trades: 0, sparkline: [10000, 10000, 10000], report_id: 'bt_2' },
    });
    const html = card(s);
    expect(html).toContain('data-shape="zero-trades"');
    expect(html).toContain('0.0%');
    expect(html).toContain('>—<');
    expect(html).toMatch(/交易数<\/span><span[^>]*>0<\/span>/);
    expect(toneOf(0)).toBe('flat');
    const g = equityGeometry([10000, 10000, 10000]);
    expect(g.points.every((p) => p[1] === g.baseY)).toBe(true);
  });

  it('formats returns and drawdowns from fractions, tolerating either drawdown sign', () => {
    expect(fmtReturn(0.074)).toBe('+7.4%');
    expect(fmtReturn(-0.031)).toBe('−3.1%');
    expect(fmtReturn(null)).toBe('—');
    expect(fmtDrawdown(0.045)).toBe('−4.5%');
    expect(fmtDrawdown(-0.045)).toBe('−4.5%');
  });

  it('draws the same glyph for the same id and different glyphs for different ids', () => {
    expect(glyphCells('rs_a')).toEqual(glyphCells('rs_a'));
    expect(glyphCells('rs_a')).not.toEqual(glyphCells('rs_b'));
  });
});

describe('filter capsules and list query', () => {
  beforeEach(() => myStrategies.mockReset());

  it('shows the backend counts on each capsule and marks the active one', () => {
    const html = renderToStaticMarkup(createElement(FilterCapsules, { value: 'live', counts: { all: 7, live: 1, watchlist: 2, alerts: 3, draft: 4 }, onChange: noop }));
    for (const [f, n] of [['all', 7], ['live', 1], ['watchlist', 2], ['alerts', 3]] as const) {
      expect(html).toMatch(new RegExp(`data-filter="${f}"[\\s\\S]*?data-count="${n}"`));
    }
    expect(html).toMatch(/aria-selected="true" data-filter="live"/);
    expect(html).toMatch(/aria-selected="false" data-filter="all"/);
  });

  it('passes q / filter / sort to the backend and treats 404 as an empty state', async () => {
    myStrategies.mockResolvedValueOnce({ strategies: [strategy()], counts: { all: 1, live: 0, watchlist: 0, alerts: 0, draft: 0 } });
    const ok = await fetchMyStrategies({ q: 'btc', filter: 'watchlist', sort: 'return' });
    expect(myStrategies).toHaveBeenCalledWith({ q: 'btc', filter: 'watchlist', sort: 'return' });
    expect(ok.strategies).toHaveLength(1);

    myStrategies.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }));
    const empty = await fetchMyStrategies({ q: '', filter: 'all', sort: 'updated' });
    expect(myStrategies).toHaveBeenLastCalledWith({ q: undefined, filter: 'all', sort: 'updated' });
    expect(empty).toMatchObject({ strategies: [], unavailable: true, counts: { all: 0 } });

    myStrategies.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(fetchMyStrategies({ q: '', filter: 'all', sort: 'updated' })).rejects.toThrow('boom');
  });
});

describe('lifecycle and LIVE confirmation', () => {
  it('requires typing LIVE only when moving to live, and sends it in the request body', () => {
    expect(transitionConfirmText('live')).toBe('LIVE');
    expect(transitionConfirmText('paper')).toBeNull();
    expect(transitionConfirmText('published')).toBeNull();
    expect(transitionRequest('live')).toEqual({ to: 'live', confirm: 'LIVE' });
    expect(transitionRequest('paper')).toEqual({ to: 'paper' });
  });

  it('picks the next forward transition for Automate and ignores backward ones', () => {
    expect(nextForwardTransition('paper', ['backtested', 'live'])).toBe('live');
    expect(nextForwardTransition('draft', ['backtested', 'paper'])).toBe('backtested');
    expect(nextForwardTransition('published', ['live'])).toBeNull();
  });

  it('highlights the current step and only makes allowed steps clickable', () => {
    const html = renderToStaticMarkup(createElement(LifecycleStepper, { status: 'paper', allowed: ['live', 'backtested'], onPick: noop }));
    expect(html).toMatch(/data-step="paper" data-state="current"/);
    expect(html).toMatch(/data-step="live" data-state="allowed"/);
    expect(html).toMatch(/data-step="backtested" data-state="allowed"/);
    expect(html).toMatch(/disabled="" data-step="published" data-state="locked"|data-step="published" data-state="locked"/);
    expect(html).toMatch(/data-step="draft" data-state="done"/);
  });
});

describe('hash routes', () => {
  it('parses list, detail, report and #backtest routes', () => {
    expect(parseRoute('#my-strategies')).toEqual({ view: 'list' });
    expect(parseRoute('#' + detailHash('rs 1', 'bt_9'))).toEqual({ view: 'detail', id: 'rs 1', report: 'bt_9' });
    expect(parseRoute('#my-strategies?report=bt_3')).toEqual({ view: 'report', report: 'bt_3' });
    expect(parseRoute('#' + reportHash('bt_4'))).toEqual({ view: 'report', report: 'bt_4' });
  });

  it('builds the research jump parameters', () => {
    expect(researchHash('rs_1', { fresh: true })).toBe('research?strategy_id=rs_1&new=1');
    expect(researchHash('rs_1', { session: 'ses_2' })).toBe('research?strategy_id=rs_1&session=ses_2');
  });
});
