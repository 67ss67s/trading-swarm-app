// R6 (docs/contracts/README.md §6/§7): tables/error_codes.json's `kinds` map must cover
// common.json's ErrorKind enum exactly (same set, both directions) and assign each kind a unique
// JSON-RPC error code. Also exercises the rpc.ts helpers built on top of that table.

import { describe, expect, it } from 'vitest';
import { errorCodeFor, kindForCode, retryableDefault, schemas, tables } from '../src/index.js';

const errorKindEnum = (schemas.common.$defs as { ErrorKind: { enum: readonly string[] } }).ErrorKind.enum;

describe('R6: tables/error_codes.json kinds vs common.json ErrorKind', () => {
  it('kinds keys == ErrorKind enum values (both directions, no drift)', () => {
    const kindsKeys = Object.keys(tables.error_codes.kinds);
    expect(new Set(kindsKeys)).toEqual(new Set(errorKindEnum));
  });

  it('every code in `kinds` is unique', () => {
    const codes = Object.values(tables.error_codes.kinds);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('retryable_default covers exactly the same kinds as `kinds`', () => {
    expect(new Set(Object.keys(tables.error_codes.retryable_default))).toEqual(new Set(Object.keys(tables.error_codes.kinds)));
  });

  for (const kind of errorKindEnum) {
    it(`errorCodeFor/retryableDefault round-trip for "${kind}"`, () => {
      const kindTyped = kind as Parameters<typeof errorCodeFor>[0];
      const code = errorCodeFor(kindTyped);
      expect(code).toBe((tables.error_codes.kinds as Record<string, number>)[kind]);
      expect(kindForCode(code)).toBe(kind);
      expect(retryableDefault(kindTyped)).toBe((tables.error_codes.retryable_default as Record<string, boolean>)[kind]);
    });
  }

  it('kindForCode is undefined for a code nothing maps to', () => {
    expect(kindForCode(-999999)).toBeUndefined();
  });
});
