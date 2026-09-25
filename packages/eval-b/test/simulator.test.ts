import { describe, expect, it } from 'vitest';

import { simulateOutcome } from '../src/simulator.js';
import type { EvalEpisode } from '../src/types.js';

function proposal(entry: 'market' | 'limit' = 'market'): EvalEpisode['judgment'] {
  return {
    action: 'PROPOSE', direction: 'long', confidence: 0.7, headline: '测试', thesis: '测试', reasons: ['测试 [E1]'], evidence_refs: ['E1'],
    invalidation: null, invalidation_price: '95', target_price: '110', watch_conditions: [],
    proposal: { direction: 'long', entry, limit_price: entry === 'limit' ? '100' : null, entry_zone: null, stop_price: '95', take_profit_price: '110', take_profits: ['110'], rationale: '测试' },
  };
}

const bar = (open: string, high: string, low: string, close: string) => ({ open_time: 1, open, high, low, close, volume: '1', close_time: 2 });

describe('outcome simulator', () => {
  it('uses the next open for market entry and computes take-profit R', () => {
    const result = simulateOutcome(proposal(), [bar('100', '111', '99', '109')]);
    expect(result.exit).toBe('take_profit');
    expect(result.r).toBe(2);
    expect(result.target_first).toBe(true);
  });

  it('lets stop win when stop and target touch in the same bar', () => {
    const result = simulateOutcome(proposal(), [bar('100', '112', '94', '101')]);
    expect(result.exit).toBe('stop');
    expect(result.r).toBe(-1);
    expect(result.target_first).toBe(false);
  });

  it('waits for a limit touch and reports unfilled orders', () => {
    expect(simulateOutcome(proposal('limit'), [bar('105', '108', '102', '104')]).exit).toBe('unfilled');
    const filled = simulateOutcome(proposal('limit'), [bar('105', '108', '102', '104'), bar('102', '111', '99', '110')]);
    expect(filled.fill_bar_index).toBe(1);
    expect(filled.exit).toBe('take_profit');
  });
});
