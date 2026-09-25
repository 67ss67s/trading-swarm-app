// 策略一键运行(§9.51):币名规范、扫描摘要、当前运行口径、列表胶囊。node 环境 renderToStaticMarkup。
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StrategyRun, StrategyRunEvent } from '@/api/types';

vi.mock('@/api/client', () => ({ api: {}, researchApi: {}, strategyRunsApi: {}, useLiveEvents: () => {} }));

import { activeRunIds, normalizeSymbol, RunPill, runOf, scanSummary } from '../src/components/my-strategies/run-panel';

const run = (over: Partial<StrategyRun> = {}): StrategyRun => ({
  id: 'run_1', strategy_id: 'rs_1', strategy_name: 'x', version: 1, latest_version: 1, ir_hash: 'h', timeframe: '1h',
  mode: 'auto', market: 'spot', direction: 'long', leverage: 1, symbols: ['BTCUSDT'], risk_pct: 0.5, max_open: 3, publish_asp: false,
  status: 'running', error: null, execution: { backend: 'okx', profile: 'demo', label: 'OKX 模拟盘' }, created_at: 1, updated_at: 1,
  last_scan_at: null, next_scan_at: null,
  stats: { scans: 0, candidates: 0, orders: 0, pending_approval: 0, skipped: 0, rejected: 0, open_threads: 0, closed: 0, realized_r: null, published: 0, today_orders: 2 },
  ...over,
});
const ev = (kind: StrategyRunEvent['kind']): StrategyRunEvent => ({ id: kind + Math.random(), run_id: 'run_1', at: 0, kind, symbol: 'BTCUSDT', message: '', data: null });

describe('策略运行', () => {
  it('币名规范成内部符号', () => {
    expect(['btc', 'SOL-USDT', 'eth/usdt', 'DOGE-USDT-SWAP', '??', ''].map(normalizeSymbol)).toEqual(['BTCUSDT', 'SOLUSDT', 'ETHUSDT', 'DOGEUSDT', null, null]);
  });
  it('扫描摘要', () => {
    expect(scanSummary([ev('scan')])).toBe('这根 K 线没有命中');
    expect(scanSummary([ev('candidate'), ev('candidate'), ev('order_opened'), ev('order_pending'), ev('published')])).toBe('命中 2 个 · 下单 1 笔 · 1 笔待你确认 · 发布 1 条信号');
  });
  it('当前运行:非 stopped 优先,取最近更新', () => {
    const runs = [run({ id: 'a', status: 'stopped', updated_at: 9 }), run({ id: 'b', status: 'paused', updated_at: 5 }), run({ id: 'c', strategy_id: 'rs_2' })];
    expect(runOf(runs, 'rs_1')?.id).toBe('b');
    expect(runOf([run({ status: 'stopped' })], 'rs_1')).toBeNull();
    expect([...activeRunIds(runs)].sort()).toEqual(['rs_1', 'rs_2']);
  });
  it('列表胶囊显示状态和今天单数', () => {
    const html = renderToStaticMarkup(createElement(RunPill, { run: run() }));
    expect(html).toContain('data-run-pill="running"');
    expect(html).toContain('运行中');
    expect(html).toContain('· 2');
    expect(renderToStaticMarkup(createElement(RunPill, { run: run({ status: 'error' }) }))).toContain('出错停下');
  });
});
