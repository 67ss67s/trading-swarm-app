import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelBudget } from '../../src/demo/model-budget.js';

function fixture() {
  const data = new Map<string, string>();
  const state = { get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => { data.set(k, v); } };
  return { data, state, budget: new ModelBudget(state, 'model-budget:claude') };
}
afterEach(() => vi.restoreAllMocks());

describe('durable model quota breaker', () => {
  it.each([
    "You've hit your weekly limit · resets Sep 17 at 7pm",
    'You’ve hit your daily limit',
    "You've hit your 5-hour limit",
    'Usage limit reached',
    'usage limit exceeded',
    'out of extra usage',
    'Insufficient credits',
    'credit balance is too low',
    "You've hit your limit · resets 7pm (Asia/Singapore)",
  ])('blocks on quota exhaustion: %s', text => {
    const f = fixture(); vi.spyOn(Date, 'now').mockReturnValue(123456);
    expect(f.budget.observe(text)).toBe(true);
    expect(f.budget.status()).toMatchObject({ blocked: true, blocked_at: 123456 });
    expect(new ModelBudget(f.state, 'model-budget:claude').status()).toEqual(f.budget.status());
  });

  it('remains blocked after elapsed reset-looking time and ordinary errors until manual reset', () => {
    const f = fixture(); vi.spyOn(Date, 'now').mockReturnValue(123456);
    f.budget.observe("You've hit your weekly limit · resets in 1 minute");
    vi.spyOn(Date, 'now').mockReturnValue(123456 + 10 * 86_400_000);
    expect(f.budget.observe('request succeeded')).toBe(false);
    expect(new ModelBudget(f.state, 'model-budget:claude').status().blocked).toBe(true);
    f.budget.reset();
    expect(new ModelBudget(f.state, 'model-budget:claude').status()).toEqual({ blocked: false, blocked_at: null, reason: null });
    expect(f.budget.observe('insufficient credits')).toBe(true);
  });

  it.each(['ECONNRESET socket closed', 'network timeout', 'rate limit reached; retry in 2 seconds', '429 Too Many Requests', 'authentication required', 'order rejected: insufficient margin', 'insufficient balance', 'success'])('does not latch ordinary failure/output: %s', text => {
    const f = fixture();
    expect(f.budget.observe(text)).toBe(false);
    expect(f.data.size).toBe(0);
    expect(f.budget.status()).toEqual({ blocked: false, blocked_at: null, reason: null });
  });

  it('keeps CLI namespaces independent across restarts', () => {
    const f = fixture(); f.budget.observe('usage limit reached');
    expect(new ModelBudget(f.state, 'model-budget:codex').status().blocked).toBe(false);
    expect(new ModelBudget(f.state, 'model-budget:claude').status().blocked).toBe(true);
  });

  it.each(['{broken', 'null', '{}', '{"blocked":"false"}'])('fails closed on damaged persisted record %s', text => {
    const f = fixture(); f.data.set('model-budget:claude', text);
    expect(f.budget.status()).toMatchObject({ blocked: true, blocked_at: null });
    f.budget.reset(); expect(f.budget.status().blocked).toBe(false);
  });
});
