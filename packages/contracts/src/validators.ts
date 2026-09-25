// ajv 2020-12 validators over schema/*.json (via generated/schemas.ts) + one type guard per
// record kind. docs/contracts/README.md §1/§7 R2.

import { createRequire } from 'node:module';
import type { ErrorObject } from 'ajv';
import { schemas } from './generated/schemas.js';
import type {
  AccountSnapshot,
  Authorization,
  ExchangeOrderObservation,
  ExecEvent,
  ExecPolicy,
  ExecutableOrderPlan,
  ExecutionAttempt,
  Fill,
  Intent,
  PositionEffect,
} from './generated/contracts.js';

export type SchemaName = keyof typeof schemas;

// ajv's own .d.ts for these two subpaths is authored as ESM (`export default X`) but the
// package ships as plain CommonJS (no "type": "module"); under this repo's `moduleResolution:
// NodeNext`, a plain `import X from 'ajv/dist/2020.js'` / `import X from 'ajv-formats'`
// mis-resolves `X`'s *type* to the whole module-namespace type instead of the default export
// (confirmed at runtime — Node's own CJS/ESM interop hands back the right value — this is purely
// tsc getting the static type wrong for this shape). `createRequire` sidesteps the broken
// default-import type inference for the value, and `typeof import(...)['default']` — an indexed
// access on the namespace type, a different code path from default-import sugar — reliably
// recovers the real type to cast it back to.
type Ajv2020Ctor = (typeof import('ajv/dist/2020.js'))['default'];
type AddFormatsFn = (typeof import('ajv-formats'))['default'];
const req = createRequire(import.meta.url);
const Ajv2020 = req('ajv/dist/2020.js').default as Ajv2020Ctor;
const addFormats = req('ajv-formats').default as AddFormatsFn;

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  // Two narrow, deliberate overrides of the `strict: true` baseline — both documented in
  // docs/contracts/ts-notes.md, neither weakens what any of the 12 schemas actually validate:
  //
  // unicodeRegExp: false — schema/common.json's ClientOrderId pattern
  // (`^[\.A-Z\:/a-z0-9_-]{1,36}$`) has a stray backslash before `:`, which is a no-op escape
  // under plain regex but an *invalid* one under Unicode-mode regex (what Ajv2020 uses by
  // default), so `ajv.compile` throws for every schema that transitively references it —
  // ClientOrderId, attempt/exchange_order/fill/account_snapshot/plan, i.e. most of them. All 8
  // `pattern`s in this contract are plain-ASCII character classes with no astral-plane or
  // Unicode-property matching, so turning off the `u` flag changes nothing about what any of
  // them match *except* making this one already-intended-as-literal-colon pattern compile. This
  // is a schema bug (packages/contracts/{schema,transitions,tables} is out of this package's
  // edit boundary — see AGENTS.md) — the real fix is dropping that backslash in
  // schema/common.json; this override can come out once that lands.
  //
  // strictRequired: false — ajv's strictRequired check flags `required` entries inside an
  // `if`/`then` (authorization.json's `by === "user"` branch) or `anyOf` member (plan.json's
  // CancelEconomics, "at least one of exchange_order_id/client_order_id") that aren't *also*
  // re-declared in that branch's own `properties`, even though they're legitimately declared on
  // the parent schema one level up — a known ajv false positive for this idiomatic pattern, not
  // a defect in either schema.
  unicodeRegExp: false,
  strictRequired: false,
});
addFormats(ajv);

const schemaIdByName = {} as Record<SchemaName, string>;
for (const [name, schema] of Object.entries(schemas) as [SchemaName, (typeof schemas)[SchemaName]][]) {
  ajv.addSchema(schema);
  schemaIdByName[name] = schema.$id;
}

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '<root>'} ${e.message ?? 'invalid'}`);
}

/** Validates `value` against schema/<name>.json. */
export function validate(name: SchemaName, value: unknown): ValidateResult {
  const validateFn = ajv.getSchema(schemaIdByName[name]);
  if (!validateFn) throw new Error(`validators: unknown schema "${name}"`);
  return validateFn(value) ? { ok: true } : { ok: false, errors: formatErrors(validateFn.errors) };
}

function guard<T>(name: SchemaName) {
  return (value: unknown): value is T => validate(name, value).ok;
}

export const isIntent = guard<Intent>('intent');
export const isExecutableOrderPlan = guard<ExecutableOrderPlan>('plan');
export const isAuthorization = guard<Authorization>('authorization');
export const isExecutionAttempt = guard<ExecutionAttempt>('attempt');
export const isExchangeOrderObservation = guard<ExchangeOrderObservation>('exchange_order');
export const isFill = guard<Fill>('fill');
export const isPositionEffect = guard<PositionEffect>('position_effect');
export const isAccountSnapshot = guard<AccountSnapshot>('account_snapshot');
export const isExecPolicy = guard<ExecPolicy>('policy');
export const isExecEvent = guard<ExecEvent>('events');
