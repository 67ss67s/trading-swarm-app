// @trading-swarm/gateway — A0 scope: ExecClient (UDS JSON-RPC client for execd) and state.sqlite
// (schema + migrator + minimal DAOs). See README.md.

export { defaultExecdSocketPath, ExecClient, ExecRpcError, ExecTimeout } from './exec-client.js';
export type { ExecClientOptions, SubscribeHandle } from './exec-client.js';

export { openStateDb } from './state-db.js';
export type { AppendEventInput, EventRow, EventSource, StateDb } from './state-db.js';

// Demo runtime (docs/demo/): exposed as a namespace so evals/scripts can reuse the exact same
// context builder, validator, gates and thread reducer the live loop uses.
export * as demo from './demo/index.js';
