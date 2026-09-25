// RPC framework helpers over rpc.json (docs/contracts/README.md §8): error-code table lookups,
// frame type guards, the NDJSON wire codec, and the type-level per-method Params/Result table
// (ExecMethods) that ExecClient (packages/gateway/src/exec-client.ts) indexes into.

import type { ErrorKind } from './generated/contracts.js';
import type {
  AccountSnapshotParams,
  AccountSnapshotResult,
  CredentialsPublicKeyParams,
  CredentialsPublicKeyResult,
  CredentialsSetParams,
  CredentialsSetResult,
  CredentialsStatusParams,
  CredentialsStatusResult,
  EmergencyStopParams,
  EmergencyStopResult,
  EventsSubscribeParams,
  EventsSubscribeResult,
  ExchangeStatusParams,
  ExchangeStatusResult,
  HealthParams,
  HealthResult,
  IntentAuthorizeParams,
  IntentAuthorizeResult,
  IntentBundle,
  IntentGetParams,
  IntentListParams,
  IntentListResult,
  IntentProposeParams,
  IntentProposeResult,
  IntentRejectParams,
  IntentRejectResult,
  OauthRevokeParams,
  OauthRevokeResult,
  OauthStartParams,
  OauthStartResult,
  OauthStatusParams,
  OauthStatusResult,
  PolicyGetParams,
  PolicyGetResult,
  PolicySetParams,
  PolicySetResult,
  RpcFailure,
  RpcNotification,
  RpcRequest,
  RpcSuccess,
} from './generated/contracts.js';
import { tables } from './generated/tables.js';

/**
 * Type-level params/result lookup for every method in rpc.json's `Method`
 * enum (18 of them) — `RpcRequest.params`/`RpcSuccess.result` are typed as a
 * generic `object` in the wire schema itself (the frame envelope doesn't know
 * the method at the type level), so this is what gives `ExecClient.call`
 * (packages/gateway) its per-method typing.
 */
export interface ExecMethods {
  'exec.health': { params: HealthParams; result: HealthResult };
  'exec.intent.propose': { params: IntentProposeParams; result: IntentProposeResult };
  'exec.intent.get': { params: IntentGetParams; result: IntentBundle };
  'exec.intent.list': { params: IntentListParams; result: IntentListResult };
  'exec.intent.authorize': { params: IntentAuthorizeParams; result: IntentAuthorizeResult };
  'exec.intent.reject': { params: IntentRejectParams; result: IntentRejectResult };
  'exec.account.snapshot': { params: AccountSnapshotParams; result: AccountSnapshotResult };
  'exec.exchange.status': { params: ExchangeStatusParams; result: ExchangeStatusResult };
  'exec.policy.get': { params: PolicyGetParams; result: PolicyGetResult };
  'exec.policy.set': { params: PolicySetParams; result: PolicySetResult };
  'exec.emergency_stop': { params: EmergencyStopParams; result: EmergencyStopResult };
  'exec.events.subscribe': { params: EventsSubscribeParams; result: EventsSubscribeResult };
  'exec.oauth.start': { params: OauthStartParams; result: OauthStartResult };
  'exec.oauth.status': { params: OauthStatusParams; result: OauthStatusResult };
  'exec.oauth.revoke': { params: OauthRevokeParams; result: OauthRevokeResult };
  'exec.credentials.public_key': { params: CredentialsPublicKeyParams; result: CredentialsPublicKeyResult };
  'exec.credentials.set': { params: CredentialsSetParams; result: CredentialsSetResult };
  'exec.credentials.status': { params: CredentialsStatusParams; result: CredentialsStatusResult };
}

/** tables/error_codes.json: the ErrorKind -> JSON-RPC error.code mapping. Throws on an unknown kind (table drift). */
export function errorCodeFor(kind: ErrorKind): number {
  const code = tables.error_codes.kinds[kind];
  if (code === undefined) throw new Error(`rpc: no error code registered for kind "${kind}"`);
  return code;
}

/** Reverse of errorCodeFor; undefined if no ErrorKind maps to this code (e.g. an unmapped JSON-RPC standard code). */
export function kindForCode(code: number): ErrorKind | undefined {
  for (const [kind, mapped] of Object.entries(tables.error_codes.kinds)) {
    if (mapped === code) return kind as ErrorKind;
  }
  return undefined;
}

/** tables/error_codes.json's `retryable_default` for a kind. Throws on an unknown kind (table drift). */
export function retryableDefault(kind: ErrorKind): boolean {
  const value = tables.error_codes.retryable_default[kind];
  if (value === undefined) throw new Error(`rpc: no retryable default registered for kind "${kind}"`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A request frame: has `id` and a `method` other than the one reserved for notifications. */
export function isRpcRequest(value: unknown): value is RpcRequest {
  return (
    isPlainObject(value) &&
    value.jsonrpc === '2.0' &&
    'id' in value &&
    typeof value.method === 'string' &&
    value.method !== 'exec.event' &&
    'params' in value
  );
}

/** A success response frame: has `id` and `result`, no `error`/`method`. */
export function isRpcSuccess(value: unknown): value is RpcSuccess {
  return isPlainObject(value) && value.jsonrpc === '2.0' && 'id' in value && 'result' in value && !('error' in value) && !('method' in value);
}

/** A failure response frame: has `id` (possibly null) and `error`. */
export function isRpcFailure(value: unknown): value is RpcFailure {
  return isPlainObject(value) && value.jsonrpc === '2.0' && 'id' in value && 'error' in value;
}

/** The one notification method, `exec.event`: no `id`, `method` is that literal, has `params`. */
export function isRpcNotification(value: unknown): value is RpcNotification {
  return isPlainObject(value) && value.jsonrpc === '2.0' && !('id' in value) && value.method === 'exec.event' && 'params' in value;
}

/** One NDJSON frame: compact JSON followed by "\n". */
export function encodeFrame(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
}

export class FrameTooLargeError extends Error {
  constructor(
    public readonly size: number,
    public readonly limit: number,
  ) {
    super(`ndjson frame exceeds ${limit} bytes (got ${size})`);
    this.name = 'FrameTooLargeError';
  }
}

/** docs/contracts/README.md §8: UDS frames are newline-delimited, UTF-8, each line ≤ 4 MiB. */
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Incremental NDJSON decoder. Feed it bytes/strings as they arrive on the
 * socket; `push` returns whichever complete (newline-terminated) frames it
 * found, parsed, buffering any trailing partial line for the next call. A
 * single line longer than `maxBytes` (default 4 MiB) throws
 * `FrameTooLargeError` — callers should treat that as fatal and close the
 * connection, not try to resume the same decoder.
 */
export class NdjsonDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  readonly #maxBytes: number;

  constructor(opts: { maxBytes?: number } = {}) {
    this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  push(chunk: Buffer | string): unknown[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.#buffer = this.#buffer.length > 0 ? Buffer.concat([this.#buffer, incoming]) : incoming;

    const frames: unknown[] = [];
    let start = 0;
    for (;;) {
      const newlineIndex = this.#buffer.indexOf(0x0a, start);
      if (newlineIndex === -1) break;
      const lineLength = newlineIndex - start;
      if (lineLength > this.#maxBytes) {
        throw new FrameTooLargeError(lineLength, this.#maxBytes);
      }
      const line = this.#buffer.toString('utf8', start, newlineIndex);
      start = newlineIndex + 1;
      if (line.trim().length > 0) {
        frames.push(JSON.parse(line));
      }
    }
    this.#buffer = start > 0 ? this.#buffer.subarray(start) : this.#buffer;
    if (this.#buffer.length > this.#maxBytes) {
      throw new FrameTooLargeError(this.#buffer.length, this.#maxBytes);
    }
    return frames;
  }
}
