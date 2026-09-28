// @trade-gate/contracts — the package. See README.md for the full export list and how to
// regenerate. Nothing in this file (or anything it imports) reads schema/transitions/tables at
// runtime — generate.ts inlines all of that into src/generated/* ahead of time.

// Generated types (Intent, ExecutableOrderPlan, ..., every $defs subtype and enum) + the raw
// schema/table JSON, inlined `as const`. (The 4 transitions/*.json tables are available the same
// way at './generated/transitions.js', but not re-exported here — machines()/canTransition()/etc.
// below are the intended public surface for those.)
export * from './generated/contracts.js';
import { schemas } from './generated/schemas.js';
import { tables } from './generated/tables.js';
export { schemas, tables };
export type { SchemaName } from './validators.js';

/** The 12 schema names (`schemas`' own keys), e.g. for iterating "validate every fixture". */
export const schemaNames = Object.keys(schemas) as (keyof typeof schemas)[];

// ajv 2020 validators + one type guard per record kind.
export {
  isAccountSnapshot,
  isAuthorization,
  isExchangeOrderObservation,
  isExecEvent,
  isExecPolicy,
  isExecutableOrderPlan,
  isExecutionAttempt,
  isFill,
  isIntent,
  isPositionEffect,
  validate,
} from './validators.js';
export type { ValidateResult } from './validators.js';

// canonical_json / hashes / confirm_fields / clientOrderId.
export {
  accountVersion,
  CanonicalJsonError,
  canonicalJson,
  classifyOrderOrigin,
  clientOrderId,
  confirmFields,
  planHash,
  sha256Hex,
} from './canonical.js';
export type { AccountVersionComponents, ClientOrderIdParams } from './canonical.js';

// State-machine helpers (transitions/*.json) and RPC helpers (rpc.json) — exported both flat and
// grouped under `transitions.*` / `rpc.*` namespace objects, so callers can use whichever reads
// better (`import { canTransition }` vs `import { transitions }; transitions.canTransition(...)`).
export * from './transitions.js';
export * from './rpc.js';
export type { ExecMethods } from './rpc.js';

import * as transitionsNamespace from './transitions.js';
import * as rpcNamespace from './rpc.js';
export const transitions = transitionsNamespace;
export const rpc = rpcNamespace;
