// 09-12:为了让 eval 能给每道闸造用例,「没有状态不明的订单」与「提交前重闸」从 runtime 抽成了纯函数。
// 这两个测试钉住抽取是等价的——判定与文案一字未改。

import { describe, expect, it } from 'vitest';
import { unknownOrderGate } from '../../src/demo/gates.js';
import { openingBlockers, preflightBlockers } from '../../src/demo/threads.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';
import type { StrategyThread, Workflow } from '../../src/demo/types.js';

const wf: Workflow = { ...DEFAULT_WORKFLOW, max_open_threads: 3, max_opens_per_day: 4, daily_loss_stop_pct: '3', updated_at: 0 };

const thread = (over: Partial<StrategyThread> = {}): StrategyThread =>
  ({
    id: 't1', symbol: 'ETHUSDT', side: 'long', status: 'in_position', source: 'agent', timeframe: '15m',
    thesis: '', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null },
    stop_price: null, take_profits: [], qty: '1', margin_usdt: null, leverage: 3, margin_mode: 'cross',
    entry_client_order_id: null, protection_client_order_ids: [], filled_avg_price: null, realized_pnl: null,
    close_reason: null, attention: null, entry_lookup_misses: 0, leg_seq: 0, episode_ids: [], intent_ids: [],
    created_at: 0, updated_at: 0, opened_at: 0, closed_at: null, version: 2, ...over,
  }) as StrategyThread;

describe('unknownOrderGate', () => {
  it('有状态不明的订单就拒,文案与 runtime 原来那一行一致', () => {
    expect(unknownOrderGate(true)).toEqual({ name: '没有状态不明的订单', passed: false, reason: '有一笔订单状态不明,先核对再开新仓' });
    expect(unknownOrderGate(false)).toEqual({ name: '没有状态不明的订单', passed: true, reason: '通过' });
  });
});

describe('preflightBlockers', () => {
  const base = { halted: false, paused: false, symbol: 'BTCUSDT', account: { positions: [] }, other_threads: [] as StrategyThread[], workflow: wf, opens_today: 0, daily_loss_hit: false, symbol_status: 'TRADING' };

  it('都干净时没有 blocker', () => {
    expect(preflightBlockers(base)).toEqual([]);
  });

  it('紧急停止 / 暂停 / 本币已有持仓 / 不可交易,逐条命中', () => {
    expect(preflightBlockers({ ...base, halted: true })).toContain('紧急停止中');
    expect(preflightBlockers({ ...base, paused: true })).toContain('已暂停');
    expect(preflightBlockers({ ...base, account: { positions: [{ symbol: 'BTCUSDT' }] } })).toContain('BTCUSDT 已有持仓(可能是外部的)');
    expect(preflightBlockers({ ...base, symbol_status: 'BREAK' })).toContain('BTCUSDT 当前状态 BREAK,不可交易');
    expect(preflightBlockers({ ...base, symbol_status: null })).toEqual([]);
  });

  it('线程/日内限制原样转发给 openingBlockers', () => {
    const others = [thread({ symbol: 'BTCUSDT' })];
    expect(preflightBlockers({ ...base, other_threads: others })).toEqual(openingBlockers(others, wf, 'BTCUSDT', 0, false));
    expect(preflightBlockers({ ...base, opens_today: 4 })).toContain('今日开仓已到上限 4');
    expect(preflightBlockers({ ...base, daily_loss_hit: true })).toContain('今日亏损已触及 3% 日亏停');
  });
});
