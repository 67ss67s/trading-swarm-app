import { describe, expect, it } from 'vitest';

import { checkEvidenceAndNumbers, detectFutureLeakage, unauthorizedReason } from '../src/checks.js';
import type { EvalEpisode } from '../src/types.js';
import { minimalCase, syntheticKlines } from './helpers.js';

describe('hard-invariant checks', () => {
  it('detects an injected hidden future price in context text', () => {
    const evalCase = minimalCase();
    const future = syntheticKlines('15m', evalCase.as_of + 1, 2);
    future[0]!.close = '999999.12';
    evalCase.hidden.future_klines = future;
    const result = detectFutureLeakage(evalCase, `ordinary context with future price 999999.12`);
    expect(result.leaked).toBe(true);
    expect(result.reasons.join(' ')).toContain('999999.12');
  });

  it('detects a visible bar closing after as_of', () => {
    const evalCase = minimalCase();
    evalCase.visible.klines['15m']!.push({ ...evalCase.visible.klines['15m']!.at(-1)!, close_time: evalCase.as_of + 1 });
    expect(detectFutureLeakage(evalCase, 'filtered context').leaked).toBe(true);
  });

  it('checks reason citations, registry membership, and hallucinated numbers', () => {
    const judgment: EvalEpisode['judgment'] = {
      action: 'WATCH', direction: null, confidence: 0.5, headline: '观察', thesis: '等待价格到 77777 再看',
      reasons: ['没有引用', '已登记价格 65000 [E1]'], evidence_refs: ['E1', 'E404'], invalidation: null,
      invalidation_price: null, target_price: null, watch_conditions: [], proposal: null,
    };
    const checked = checkEvidenceAndNumbers(judgment, [{ ref: 'E1', kind: 'market', label: '价格', value: 'last 65000', observed_at: 1, source: 'test', stale: false }]);
    expect(checked.valid).toBe(false);
    expect(checked.errors.join(' ')).toContain('E404');
    expect(checked.errors.join(' ')).toContain('no [E<n>]');
    expect(checked.hallucinated.map((item) => item.token)).toContain('77777');
    expect(checked.hallucinated.map((item) => item.token)).not.toContain('65000');
  });

  it('catches a scan-only PROPOSE action injected into review mode', () => {
    const evalCase = minimalCase();
    evalCase.mode = 'review';
    evalCase.thread = {
      id: 'thr-test', symbol: evalCase.symbol, side: 'long', status: 'in_position', source: 'agent', timeframe: '15m', thesis: 'test',
      invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: evalCase.visible.market.last, zone: null }, stop_price: '40000',
      take_profits: ['50000'], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', entry_client_order_id: null,
      protection_client_order_ids: [], filled_avg_price: evalCase.visible.market.last, realized_pnl: null, close_reason: null, attention: null,
      episode_ids: [], intent_ids: [], created_at: evalCase.as_of, updated_at: evalCase.as_of, opened_at: evalCase.as_of, closed_at: null, version: 1,
    };
    const judgment = {
      action: 'PROPOSE' as const, direction: 'long' as const, confidence: 0.7, headline: 'bad', thesis: 'bad', reasons: ['bad [E1]'], evidence_refs: ['E1'],
      invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [],
      proposal: { direction: 'long' as const, entry: 'market' as const, limit_price: null, entry_zone: null, stop_price: '40000', take_profit_price: '50000', take_profits: ['50000'], rationale: 'bad' },
    };
    expect(unauthorizedReason(evalCase, judgment)).toContain('not in allowed actions');
  });
});
