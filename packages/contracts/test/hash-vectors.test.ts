// R5 (docs/contracts/README.md §3/§7): canonicalJson/sha256Hex must match
// fixtures/hash/vectors.json exactly (the third-party arbiter, scripts/canonical_ref.py, produced
// those); planHash/accountVersion/confirmFields/clientOrderId must match the values baked into
// the plan/authorization/account_snapshot/client_order_id fixtures and tables.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  accountVersion,
  canonicalJson,
  clientOrderId,
  confirmFields,
  type ExecutableOrderPlan,
  planHash,
  sha256Hex,
  tables,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, '..', 'fixtures');

function readJson(...segments: string[]): any {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, ...segments), 'utf8'));
}

interface HashVector {
  name: string;
  input: unknown;
  canonical: string;
  sha256: string;
}

const vectors: HashVector[] = readJson('hash', 'vectors.json').vectors;

describe('R5: canonicalJson / sha256Hex match fixtures/hash/vectors.json', () => {
  it('found the expected vectors (sanity check the fixture load itself)', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors) {
    it(vector.name, () => {
      const canonical = canonicalJson(vector.input);
      expect(canonical).toBe(vector.canonical);
      expect(sha256Hex(canonical)).toBe(vector.sha256);
    });
  }
});

describe('R5: planHash', () => {
  const planFiles = ['order_limit_with_protection', 'protect_replace', 'transfer_main_to_sub'];

  for (const name of planFiles) {
    it(`plan/${name}.json`, () => {
      const plan = readJson('plan', `${name}.json`) as ExecutableOrderPlan;
      expect(planHash(plan.economic)).toBe(plan.plan_hash);
    });
  }
});

describe('R5: accountVersion', () => {
  it('account_snapshot/sub_consistent.json', () => {
    const snapshot = readJson('account_snapshot', 'sub_consistent.json');
    const version = accountVersion({
      balances: snapshot.components.balances.data,
      positions: snapshot.components.positions.data,
      open_orders: snapshot.components.open_orders.data,
      position_mode: snapshot.components.position_mode.data,
    });
    expect(version).toBe(snapshot.account_version);
  });
});

describe('R5: confirmFields', () => {
  it('plan/order_limit_with_protection.json matches authorization/user_consumed.json confirm_echo', () => {
    const plan = readJson('plan', 'order_limit_with_protection.json') as ExecutableOrderPlan;
    const authorization = readJson('authorization', 'user_consumed.json');
    expect(confirmFields(plan)).toEqual(authorization.confirm_echo);
  });
});

describe('R5: clientOrderId', () => {
  for (const example of tables.client_order_id.examples) {
    it(`${example.leg}#${example.leg_index} attempt ${example.attempt_no}`, () => {
      expect(
        clientOrderId({
          intentId: example.intent_id,
          leg: example.leg,
          legIndex: example.leg_index,
          attemptNo: example.attempt_no,
        }),
      ).toBe(example.client_order_id);
    });
  }
});
