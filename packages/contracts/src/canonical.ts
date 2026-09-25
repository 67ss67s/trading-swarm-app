// canonical_json, hashes (plan_hash / account_version), confirm_fields, and clientOrderId —
// docs/contracts/README.md §3–§5. All derivation tables (confirm_fields, client_order_id) are
// read from generated/tables.ts (itself generated from tables/*.json), never duplicated here.

import { createHash } from 'node:crypto';
import type { BalanceRow, ExecutableOrderPlan, Leg, OrderRow, PlanEconomics, PositionMode, PositionRow } from './generated/contracts.js';
import { tables } from './generated/tables.js';

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    // README §3 / scripts/canonical_ref.py: array elements are recursed into but never
    // dropped — only *object member* values of null/undefined are stripped, below.
    return value.map(normalize);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new CanonicalJsonError(
        `canonical_json: non-integer number not allowed (got ${value}); amounts/prices must be decimal strings`,
      );
    }
    return value;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const member = obj[key];
      if (member === null || member === undefined) continue;
      out[key] = normalize(member);
    }
    return out;
  }
  return value; // string | boolean
}

/**
 * docs/contracts/README.md §3: recursively drop `null`/`undefined` object
 * members (array elements are kept, `null` included), sort object keys by
 * Unicode code point, compact output, leave non-ASCII unescaped, and reject
 * any non-integer JSON number (this contract's amounts/prices are always
 * decimal strings — a float here means something upstream broke that rule).
 * Must byte-for-byte match `scripts/canonical_ref.py`'s `canonical()` and
 * Rust's `serde_json::to_string` over a `BTreeMap`-backed `Value`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** sha256, lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * `plan_hash` = sha256_hex(canonical_json(plan.economic)). What an
 * Authorization binds to; `basis` never participates.
 */
export function planHash(economic: PlanEconomics): string {
  return sha256Hex(canonicalJson(economic));
}

export interface AccountVersionComponents {
  balances: readonly BalanceRow[];
  positions: readonly PositionRow[];
  open_orders: readonly OrderRow[];
  position_mode: { mode: PositionMode };
}

/**
 * `account_version` = sha256_hex(canonical_json({balances, positions,
 * open_orders, position_mode})), where each member is the corresponding
 * AccountSnapshot component's `.data` (not the whole component — no
 * `observed_at`/`completeness`/etc.).
 */
export function accountVersion(components: AccountVersionComponents): string {
  return sha256Hex(canonicalJson(components));
}

type ConfirmByKind = typeof tables.confirm_fields.by_kind;
type ConfirmKind = keyof ConfirmByKind;

function confirmFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new CanonicalJsonError(`confirm_fields: non-integer number not allowed (got ${value})`);
    }
    return String(value);
  }
  if (typeof value === 'string') return value;
  return canonicalJson(value); // array | object
}

/**
 * docs/contracts/README.md §4 / tables/confirm_fields.json: the structured-
 * confirmation map an approval surface must echo back verbatim (execd
 * compares it byte-for-byte against this same derivation on
 * `exec.intent.authorize`). `plan_hash` is always present; every other field
 * comes from `plan.economic` keyed by `economic.kind`, values stringified
 * (`true`/`false` for booleans, decimal for integers, `canonical_json` for
 * arrays/objects), and omitted entirely when absent from `economic`.
 */
export function confirmFields(plan: ExecutableOrderPlan): Record<string, string> {
  const economic = plan.economic as unknown as Record<string, unknown> & { kind: ConfirmKind };
  const fields = tables.confirm_fields.by_kind[economic.kind];

  const out: Record<string, string> = { plan_hash: plan.plan_hash };
  for (const field of fields) {
    const value = confirmFieldValue(economic[field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

export interface ClientOrderIdParams {
  intentId: string;
  leg: Leg;
  legIndex: number;
  attemptNo: number;
}

const LEG_CODES: Record<Leg, string> = tables.client_order_id.leg_codes;

/**
 * tables/client_order_id.json: `tg-{intent12}-{leg_code}{leg_index}-{attempt_no}`,
 * where `intent12` is the first 12 lowercase hex chars of `intentId` with
 * hyphens removed. Must be persisted *before* the exchange call it names.
 */
export function clientOrderId(params: ClientOrderIdParams): string {
  const intent12 = params.intentId.replace(/-/g, '').toLowerCase().slice(0, 12);
  const legCode = LEG_CODES[params.leg];
  const id = `${tables.client_order_id.prefix}${intent12}-${legCode}${params.legIndex}-${params.attemptNo}`;
  if (id.length > tables.client_order_id.max_len) {
    throw new Error(`clientOrderId: "${id}" exceeds max_len ${tables.client_order_id.max_len}`);
  }
  return id;
}

/**
 * `tg-` prefix = produced by this repo (local); anything else — including
 * 8794's `ts_` prefix — is foreign. (`OrderOrigin`'s third state, `unknown`,
 * applies when there's no clientOrderId at all, which is out of scope for a
 * function that requires a string id.)
 */
export function classifyOrderOrigin(id: string): 'local' | 'foreign' {
  return id.startsWith(tables.client_order_id.prefix) ? 'local' : 'foreign';
}
