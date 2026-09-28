# @trade-gate/contracts

The single source of truth for every "shape that crosses a process/language boundary" in
trade-gate: the six动钱 records (Intent / ExecutableOrderPlan / Authorization / ExecutionAttempt /
ExchangeOrderObservation / Fill), plus PositionEffect / AccountSnapshot / ExecPolicy / ExecEvent
and the gateway↔execd RPC framing — defined once as JSON Schema (`schema/*.json`), never by hand
in TypeScript. `crates/contracts-rs` is the Rust side of the same source; see
`docs/contracts/README.md` for the full contract (naming conventions, canonical_json, the
round-trip test matrix R1–R7, the change-flow) — this file is just "how to work in this package."

## Layout

```
schema/            JSON Schema 2020-12 source (12 files). Edited by the main line only.
transitions/        4 state-machine tables (intent_status, authorization_status, attempt_result,
                     exchange_order_status). Edited by the main line only.
tables/              error_codes / confirm_fields / client_order_id. Edited by the main line only.
fixtures/            Valid/invalid instances + hash vectors. New files welcome; existing ones are
                     the main line's.
scripts/generate.ts  Regenerates everything in src/generated/ from the three directories above.
src/generated/       Committed output of generate.ts — never hand-edited (see the file banners).
src/                 Hand-written: validators, canonical/hash, transitions helpers, rpc helpers,
                     the index.ts barrel.
test/                Vitest suites for R1/R2/R4/R5/R6 (see docs/contracts/README.md §7).
```

## Commands

```
npm run generate         # regenerate src/generated/{contracts,schemas,transitions,tables}.ts
npm run generate:check   # same, but fails (exit 1) if the committed output would change — CI uses this
npm run build             # tsc -b (also runs as part of the root `npm run typecheck`)
npm run test               # vitest run
```

All four also run from the repo root via `npm run generate`/`generate:check`/`typecheck`/`test`
(workspaces), and `npm run check` at the root chains generate:check → typecheck → test.

## `scripts/generate.ts`

Reads `schema/*.json`, flattens every file's own top-level shape and every one of its `$defs`
entries into one synthetic in-memory schema (injecting `title` = the `$defs` key where a title
isn't already present, and rewriting every `$ref` — same-file, cross-file-whole-document, and
cross-file-into-`$defs` — to point within that single flattened document), then compiles it with
`json-schema-to-typescript`. That flattening is load-bearing, not just convenient — see the doc
comments on `loadFlattenedSchema` and `dedupeSuffixedDeclarations` in the script itself for why a
more direct "just point json-schema-to-typescript at the 12 files" approach silently drops or
duplicates types for a schema set this cross-referenced. `transitions/*.json` and `tables/*.json`
get inlined into `src/generated/{transitions,tables}.ts` as plain `as const` data (no flattening
needed there — they don't feed the type compiler). `--check` compares in-memory output against
what's on disk and exits 1 on any diff, without writing anything.

## `src/index.ts` exports

- All generated types (`Intent`, `ExecutableOrderPlan`, ..., every `$defs` subtype and enum —
  `IntentParams`, `OpenParams`, `PlanEconomics`, `ErrorKind`, `IntentStatus`, ...).
- `schemas` (the 12 raw schema JSON documents, `as const`) and `tables` (the 3 raw table JSON
  documents) — `schemaNames` is `Object.keys(schemas)`.
- `validate(name, value)` (ajv 2020-12; `{ok:true}` or `{ok:false, errors: string[]}`) and one type
  guard per record kind: `isIntent`, `isExecutableOrderPlan`, `isAuthorization`,
  `isExecutionAttempt`, `isExchangeOrderObservation`, `isFill`, `isPositionEffect`,
  `isAccountSnapshot`, `isExecPolicy`, `isExecEvent`.
- `canonicalJson`, `sha256Hex`, `planHash`, `accountVersion`, `confirmFields`, `clientOrderId`,
  `classifyOrderOrigin` — docs/contracts/README.md §3–§5.
- State-machine helpers over `transitions/*.json`: `canTransition`, `nextState`, `isTerminal`,
  `machines` — exported flat and also grouped as `transitions.*` (same functions).
- RPC helpers over `rpc.json`: `errorCodeFor`, `kindForCode`, `retryableDefault`, the frame type
  guards (`isRpcRequest`/`isRpcSuccess`/`isRpcFailure`/`isRpcNotification`), `encodeFrame`,
  `NdjsonDecoder`, and the type-level `ExecMethods` table (params/result per method) — flat and
  also grouped as `rpc.*`.

## Two ajv strict-mode overrides (see `src/validators.ts` for the full rationale)

`validate()`'s ajv instance sets `strict: true, allErrors: true` plus two narrow, documented
overrides: `unicodeRegExp: false` (works around a genuine bug in `schema/common.json`'s
`ClientOrderId` pattern — see `docs/contracts/ts-notes.md`) and `strictRequired: false` (a known
ajv false positive for `required` inside `if`/`then` and `anyOf` branches that reference a
parent-declared property, used by `authorization.json` and `plan.json`; not a schema defect).

## Changing a schema

This package's `schema/`, `transitions/`, and `tables/` are not edited here — see
`docs/contracts/README.md` §10 for the change flow (`validate_fixtures.py` → `npm run generate` →
both languages' tests → bump `schema_version` if it's a breaking change). If something looks like a
schema bug from the TypeScript side, it goes in `docs/contracts/ts-notes.md`, not a silent fix here.
