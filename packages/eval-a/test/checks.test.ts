import { describe, expect, it } from 'vitest';
import type { Evidence, Judgment } from '../src/index.js';
import { buildCase, evidenceValidity, hallucinatedNumbers, numbersIn, rubricCheck, sigDigits, unauthorizedAction } from '../src/index.js';
import { synthCases } from './helpers/synthetic.js';

const ev = (ref: string, value: string): Evidence => ({ ref, kind: 'market', label: ref, value, observed_at: 0, source: 't', stale: false });
const J = (over: Partial<Judgment>): Judgment => ({ action: 'NO_TRADE', direction: null, confidence: 0.3, headline: 'h', thesis: 't', reasons: ['r [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null, ...over });

describe('number extraction', () => {
  it('ignores refs/indicator names and counts significant digits', () => {
    expect(numbersIn('E5 EMA20 108208 ATR14 0.25% 20根高 1.5倍').map((n) => n.text)).toEqual(['108208', '0.25', '20', '1.5']);
    expect(sigDigits('108208')).toBe(6);
    expect(sigDigits('0.25')).toBe(2);
    expect(sigDigits('1.20')).toBe(3);
    expect(sigDigits('100')).toBe(3);
  });
});

describe('hallucinated numbers', () => {
  const evidence = [ev('E1', 'last 108208, mark 108208'), ev('E2', '0.0100% (下次 16:00 UTC)')];
  it('accepts numbers quoted from evidence (±0.5 %) and short numbers, flags the rest', () => {
    expect(hallucinatedNumbers(J({ reasons: ['价在 108208 [E1]'] }), evidence, null, 0)).toEqual([]);
    expect(hallucinatedNumbers(J({ reasons: ['价在 108500 附近 [E1]'] }), evidence, null, 0)).toEqual([]); // 0.27 % off
    expect(hallucinatedNumbers(J({ reasons: ['涨 1.5% [E1]'] }), evidence, null, 0)).toEqual([]);
    const signed = [ev('E1', '最近一根 -3.25%, 近5根 +7.63%')];
    expect(hallucinatedNumbers(J({ reasons: ['最近一根大跌3.25% [E1]', '近5根涨7.63% [E1]'] }), signed, null, 0)).toEqual([]); // sign given in words
    expect(hallucinatedNumbers(J({ reasons: ['近5根涨 7.93% [E1]'] }), signed, null, 0).map((n) => n.text)).toEqual(['7.93']);
    const bad = hallucinatedNumbers(J({ reasons: ['价在 107000 [E1]'], thesis: '目标 112345' }), evidence, null, 0);
    expect(bad.map((n) => n.text)).toEqual(['112345', '107000']);
  });
});

describe('evidence validity', () => {
  it('requires refs in the registry and a citation in every reason', () => {
    const evidence = [ev('E1', 'x'), ev('E2', 'y')];
    expect(evidenceValidity(J({}), evidence)).toEqual([]);
    expect(evidenceValidity(J({ evidence_refs: ['E9'] }), evidence)[0]).toContain('E9');
    expect(evidenceValidity(J({ reasons: ['没有引用'] }), evidence)[0]).toContain('未引用');
    expect(evidenceValidity(J({ reasons: ['引用了 [E7]'] }), evidence)[0]).toContain('E7');
  });
});

describe('unauthorized actions', () => {
  it('flags PROPOSE in review, opening actions when halted, review actions in scan', async () => {
    const cases = await synthCases({ n: 1 });
    const scan = cases.find((c) => c.tags.includes('base'))!;
    const halted = cases.find((c) => c.tags.includes('halted'))!;
    const review = cases.find((c) => c.mode === 'review')!;
    const propose = J({ action: 'PROPOSE', direction: 'long', proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '1', take_profit_price: null, take_profits: [], rationale: '' } });
    expect(unauthorizedAction(scan, buildCase(scan).built.allowed_actions, propose)).toBeNull();
    expect(unauthorizedAction(scan, buildCase(scan).built.allowed_actions, J({ action: 'WATCH' }))).toBeNull();
    expect(unauthorizedAction(scan, buildCase(scan).built.allowed_actions, J({ action: 'HOLD' }))).toContain('HOLD');
    expect(unauthorizedAction(halted, buildCase(halted).built.allowed_actions, propose)).toContain('紧急停止');
    expect(unauthorizedAction(halted, buildCase(halted).built.allowed_actions, J({ action: 'NO_TRADE' }))).toBeNull();
    expect(unauthorizedAction(review, buildCase(review).built.allowed_actions, propose)).toContain('PROPOSE');
    expect(unauthorizedAction(review, buildCase(review).built.allowed_actions, J({ action: 'HOLD' }))).toBeNull();
    if (review.thread!.status === 'pending_entry') expect(unauthorizedAction(review, buildCase(review).built.allowed_actions, J({ action: 'REDUCE' }))).toContain('REDUCE');
  });

  it('rubric checks expected_any_of / must_not', async () => {
    const stale = (await synthCases({ n: 1 })).find((c) => c.tags.includes('stale'))!;
    expect(rubricCheck(stale, J({ action: 'PROPOSE' })).ok).toBe(false);
    expect(rubricCheck(stale, J({ action: 'WATCH' })).ok).toBe(true);
  });
});
