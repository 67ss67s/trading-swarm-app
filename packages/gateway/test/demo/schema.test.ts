// schema.ts: extractJson (pull a JSON object out of free model text) and validateJudgment (the
// hand-written Judgment contract validator — docs/demo/README.md §2 `Judgment`).

import { describe, expect, it } from 'vitest';
import { extractJson, validateJudgment } from '../../src/demo/schema.js';
import type { Judgment } from '../../src/demo/types.js';

// ---------------------------------------------------------------- extractJson

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('pulls JSON out of a ```json fenced block', () => {
    const text = 'here you go:\n```json\n{"a":1,"b":"x"}\n```\nhope that helps';
    expect(extractJson(text)).toEqual({ a: 1, b: 'x' });
  });

  it('pulls JSON out of a bare ``` fence with no language tag', () => {
    const text = '```\n{"a":1}\n```';
    expect(extractJson(text)).toEqual({ a: 1 });
  });

  it('pulls JSON out of prose that prefixes the object with no fence', () => {
    const text = 'Sure, here is my judgment: {"action":"NO_TRADE","confidence":0.1} — let me know if you need more.';
    expect(extractJson(text)).toEqual({ action: 'NO_TRADE', confidence: 0.1 });
  });

  it('balances nested braces so it takes the whole top-level object, not just the first `}`', () => {
    const text = '{"a":{"b":{"c":1}},"d":2}';
    expect(extractJson(text)).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  it('does not stop at a `}` that appears inside a string value', () => {
    const text = '{"headline":"a } b { c","ok":true}';
    expect(extractJson(text)).toEqual({ headline: 'a } b { c', ok: true });
  });

  it('does not stop at an escaped quote inside a string that itself contains braces', () => {
    const text = String.raw`{"note":"she said \"ok } now\"","n":1}`;
    expect(extractJson(text)).toEqual({ note: 'she said "ok } now"', n: 1 });
  });

  it('throws when there is no `{` at all', () => {
    expect(() => extractJson('no json here, sorry')).toThrow(/no JSON object/);
  });

  it('throws when the object is never closed (unterminated)', () => {
    expect(() => extractJson('{"a":1, "b": [1,2,3]')).toThrow(/unterminated/);
  });
});

// ---------------------------------------------------------------- validateJudgment

function baseNoTrade(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    action: 'NO_TRADE',
    direction: null,
    confidence: 0.2,
    headline: '没有优势',
    thesis: '结构混乱,先不交易',
    reasons: ['震荡 [E1]'],
    evidence_refs: ['E1'],
    invalidation: null,
    invalidation_price: null,
    target_price: null,
    watch_conditions: [],
    proposal: null,
    ...overrides,
  };
}

function baseProposal(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    direction: 'long',
    entry: 'market',
    limit_price: null,
    stop_price: '76500.5',
    take_profit_price: '79000',
    rationale: '突破回踩',
    ...overrides,
  };
}

const REFS = new Set(['E1', 'E2', 'E3', 'E4', 'E5']);

describe('validateJudgment: valid inputs pass', () => {
  it('valid NO_TRADE passes with no errors', () => {
    const { judgment, errors } = validateJudgment(baseNoTrade(), REFS);
    expect(errors).toEqual([]);
    expect(judgment).not.toBeNull();
    expect(judgment!.action).toBe('NO_TRADE');
    expect(judgment!.proposal).toBeNull();
  });

  it('valid WATCH passes with no errors', () => {
    const raw = baseNoTrade({ action: 'WATCH', watch_conditions: ['等待回踩'] });
    const { judgment, errors } = validateJudgment(raw, REFS);
    expect(errors).toEqual([]);
    expect(judgment!.action).toBe('WATCH');
    expect(judgment!.watch_conditions).toEqual(['等待回踩']);
  });

  it('valid PROPOSE (with a well-formed proposal) passes with no errors', () => {
    const raw = baseNoTrade({ action: 'PROPOSE', direction: 'long', proposal: baseProposal() });
    const { judgment, errors } = validateJudgment(raw, REFS);
    expect(errors).toEqual([]);
    expect(judgment!.action).toBe('PROPOSE');
    expect(judgment!.proposal).toMatchObject({ direction: 'long', entry: 'market', stop_price: '76500.5' });
  });

  it('valid PROPOSE may omit top-level direction; it is filled in from proposal.direction', () => {
    const raw = baseNoTrade({ action: 'PROPOSE', direction: null, proposal: baseProposal({ direction: 'short', stop_price: '78000' }) });
    const { judgment, errors } = validateJudgment(raw, REFS);
    expect(errors).toEqual([]);
    expect(judgment!.direction).toBe('short');
  });
});

describe('validateJudgment: rejections', () => {
  it('unknown action is rejected', () => {
    const { judgment, errors } = validateJudgment(baseNoTrade({ action: 'BUY_EVERYTHING' }), REFS);
    expect(judgment).toBeNull();
    expect(errors.some((e) => /action must be one of/.test(e))).toBe(true);
  });

  it('non-object input is rejected outright', () => {
    const { judgment, errors } = validateJudgment('just a string', REFS);
    expect(judgment).toBeNull();
    expect(errors).toEqual(['output must be a single JSON object']);
  });

  it('bad confidence (non-numeric) is rejected', () => {
    const { judgment, errors } = validateJudgment(baseNoTrade({ confidence: 'high' }), REFS);
    expect(judgment).toBeNull();
    expect(errors.some((e) => /confidence must be a number/.test(e))).toBe(true);
  });

  it('confidence outside 0..1 is clamped, not rejected', () => {
    const { judgment, errors } = validateJudgment(baseNoTrade({ confidence: 1.7 }), REFS);
    expect(errors).toEqual([]);
    expect(judgment!.confidence).toBe(1);
  });

  it('missing reasons (empty array) is rejected', () => {
    const { judgment, errors } = validateJudgment(baseNoTrade({ reasons: [] }), REFS);
    expect(judgment).toBeNull();
    expect(errors.some((e) => /reasons must have at least 1 item/.test(e))).toBe(true);
  });

  it('unknown evidence refs are rejected by name', () => {
    const { judgment, errors } = validateJudgment(baseNoTrade({ evidence_refs: ['E1', 'E99'] }), REFS);
    expect(judgment).toBeNull();
    expect(errors.some((e) => /unknown refs: E99/.test(e))).toBe(true);
  });

  it('PROPOSE without a proposal object is rejected', () => {
    const { judgment, errors } = validateJudgment(baseNoTrade({ action: 'PROPOSE', direction: 'long', proposal: null }), REFS);
    expect(judgment).toBeNull();
    expect(errors).toContain('action PROPOSE requires a proposal object');
  });

  it('proposal.stop_price that is not a decimal string is rejected', () => {
    const raw = baseNoTrade({ action: 'PROPOSE', direction: 'long', proposal: baseProposal({ stop_price: 'not-a-number' }) });
    const { judgment, errors } = validateJudgment(raw, REFS);
    expect(judgment).toBeNull();
    expect(errors.some((e) => /proposal\.stop_price must be a decimal string/.test(e))).toBe(true);
  });

  it('entry "limit" without limit_price is rejected', () => {
    const raw = baseNoTrade({ action: 'PROPOSE', direction: 'long', proposal: baseProposal({ entry: 'limit', limit_price: null }) });
    const { judgment, errors } = validateJudgment(raw, REFS);
    expect(judgment).toBeNull();
    expect(errors).toContain('proposal.limit_price required when entry is "limit"');
  });

  it('direction mismatch between top-level direction and proposal.direction is rejected', () => {
    const raw = baseNoTrade({ action: 'PROPOSE', direction: 'short', proposal: baseProposal({ direction: 'long' }) });
    const { judgment, errors } = validateJudgment(raw, REFS);
    expect(judgment).toBeNull();
    expect(errors).toContain('proposal.direction must equal direction');
  });

  it('a stray proposal on a non-PROPOSE action is silently dropped, not an error', () => {
    const raw = baseNoTrade({ action: 'WATCH', proposal: baseProposal() });
    const { judgment, errors } = validateJudgment(raw, REFS);
    expect(errors).toEqual([]);
    expect(judgment!.action).toBe('WATCH');
    expect(judgment!.proposal).toBeNull();
  });
});

describe('proposal market validation', () => {
  it('spot short → spot_no_short, spot long passes', () => {
    const make = (direction: string) => baseNoTrade({ action: 'PROPOSE', direction, confidence: 0.8, proposal: baseProposal({ market: 'spot', direction }) });
    expect(validateJudgment(make('short'), REFS).errors).toContain('spot_no_short');
    const long = validateJudgment(make('long'), REFS);
    expect(long.errors).toEqual([]);
    expect(long.judgment?.proposal).toMatchObject({ market: 'spot' });
  });
});

 describe('现货止损可选', () => {
  it.each(['spot', 'perp'] as const)('%s 提案 null stop 按市场验证', market => {
    const result = validateJudgment(baseNoTrade({ action: 'PROPOSE', direction: 'long', proposal: baseProposal({ market, stop_price: null }) }), REFS);
    if (market === 'spot') {
      expect(result.errors).toEqual([]);
      expect(result.judgment?.proposal).toMatchObject({ market: 'spot', stop_price: null });
    } else expect(result.errors.length).toBeGreaterThan(0);
  });
});
