import { describe, expect, it } from 'vitest';
import { stubBrain } from '../../src/demo/brain.js';
import { parseSizingOpinion, requestSizingOpinion, sizingEvidence } from '../../src/demo/sizing-agent.js';
const evidence = sizingEvidence({ equity: '100', confidence: 0.75 });
const opinion = { risk_multiplier: 1.5, allow_min_lot_overshoot: true, split_entries: 2, reason: '信心充足' };
describe('sizing opinion guard', () => {
  it('accepts bounded controls from code evidence', () => {
    expect(parseSizingOpinion(JSON.stringify(opinion), JSON.stringify(evidence)).multiplier).toBe(1.5);
  });
  it.each([
    { quantity: '1' }, { risk_multiplier: 2.1 }, { risk_multiplier: 0.249 },
    { allow_min_lot_overshoot: 'true' }, { split_entries: 4 }, { split_entries: 1.5 },
    { reason: '目标999' }, { reason: 'x'.repeat(41) }, { reason: '目标10' },
  ])('discards malformed or fabricated numbers: %j', async (patch) => {
    const result = await requestSizingOpinion(stubBrain(() => JSON.stringify({ ...opinion, ...patch })), evidence, 'apply');
    expect(result).toMatchObject({ multiplier: 1, overshoot: false, split: 1, applied: false });
  });
  it('hard timeout works even if the adapter ignores its timeout', async () => {
    const r = await requestSizingOpinion({ name: 'stub', complete: () => new Promise(() => {}) }, evidence, 'apply', 5);
    expect(r.applied).toBe(false);
  });
});

it('checks decoded JSON reason rather than escape spellings', () => {
  const escaped = '{"risk_multiplier":1,"allow_min_lot_overshoot":false,"reason":"\\u0039\\u0039\\u0039"}';
  expect(() => parseSizingOpinion(escaped, JSON.stringify(sizingEvidence({ equity: '39' })))).toThrow(/数字/);
});
