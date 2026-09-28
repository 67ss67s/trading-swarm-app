// ExecClient — gateway's only way to talk to execd (docs/contracts/README.md §8). One UDS
// connection, NDJSON JSON-RPC 2.0 frames (encode/decode reused from @trade-gate/contracts),
// integer request ids, one outstanding event subscription, automatic reconnect with exponential
// backoff, and — the one non-obvious rule this module exists to enforce — a request timeout is
// NOT a failure for write methods (propose/authorize/...): execd may have committed the write and
// the response just didn't make it back, so callers must reconcile via exec.intent.get rather
// than assume the call didn't happen. See `ExecTimeout`'s doc comment.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  encodeFrame,
  type ErrorKind,
  type ExecEvent,
  type ExecMethods,
  isRpcFailure,
  isRpcNotification,
  isRpcSuccess,
  NdjsonDecoder,
} from '@trade-gate/contracts';

export function defaultExecdSocketPath(): string {
  return path.join(os.homedir(), '.trade-gate', 'run', 'execd.sock');
}

/** A JSON-RPC error response from execd, decoded per tables/error_codes.json's shape. */
export class ExecRpcError extends Error {
  constructor(
    public readonly code: number,
    public readonly kind: ErrorKind,
    public readonly retryable: boolean,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ExecRpcError';
  }
}

/**
 * A request got no response within its timeout. **This is not the same as failure.** For a
 * write method (`exec.intent.propose`, `exec.intent.authorize`, ...) execd may have already
 * committed the effect before the response was lost — over a slow reconnect, a socket blip, or
 * execd taking longer than expected. Callers of a write method that catch `ExecTimeout` MUST
 * follow up with `exec.intent.get` (matching by the intent/idempotency key they sent) to find out
 * what actually happened before retrying or surfacing a failure to the user; retrying the same
 * write blindly risks a duplicate. Read methods can typically just be retried.
 */
export class ExecTimeout extends Error {
  constructor(
    public readonly method: string,
    public readonly id: string,
    public readonly timeoutMs: number,
  ) {
    super(`exec rpc timeout after ${timeoutMs}ms: ${method} (id=${id})`);
    this.name = 'ExecTimeout';
  }
}

export interface ExecClientOptions {
  /** UDS path to execd. Default `~/.trade-gate/run/execd.sock`. */
  socketPath?: string;
  /** Default per-call timeout. Default 10_000ms (README §8). */
  defaultTimeoutMs?: number;
  /** `exec.account.snapshot`'s timeout (a forced-refresh snapshot can be slow). Default 30_000ms. */
  accountSnapshotTimeoutMs?: number;
  /** Reconnect backoff floor. Default 250ms. */
  minReconnectDelayMs?: number;
  /** Reconnect backoff ceiling. Default 10_000ms. */
  maxReconnectDelayMs?: number;
  /** Max bytes for one NDJSON line before `FrameTooLargeError` (README §8: 4 MiB). Override mainly for tests. */
  maxFrameBytes?: number;
}

export interface SubscribeHandle {
  /** Stops delivering events for this subscription (does not close the underlying connection). */
  unsubscribe(): void;
  /** Counters since `subscribe()` was called (survives reconnects). */
  stats(): { duplicates: number; outOfOrder: number };
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveSubscription {
  lastDeliveredSeq: number;
  onEvent: (event: ExecEvent) => void;
  duplicates: number;
  outOfOrder: number;
}

/**
 * gateway's UDS JSON-RPC client for execd. One instance per gateway process (execd doesn't do
 * multi-client auth — file permissions on the socket are the boundary, per README §8).
 */
export class ExecClient {
  readonly #socketPath: string;
  readonly #defaultTimeoutMs: number;
  readonly #accountSnapshotTimeoutMs: number;
  readonly #minReconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #maxFrameBytes: number | undefined;

  #socket: net.Socket | null = null;
  /** True strictly between the socket's 'connect' event and its 'close' — see the `connected` getter. */
  #socketReady = false;
  #decoder: NdjsonDecoder;
  #nextId = 1;
  #pending = new Map<string, PendingRequest>();
  #writeQueue: unknown[] = [];
  #subscription: ActiveSubscription | null = null;
  #closed = false;
  #reconnectDelayMs: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ExecClientOptions = {}) {
    this.#socketPath = opts.socketPath ?? defaultExecdSocketPath();
    this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
    this.#accountSnapshotTimeoutMs = opts.accountSnapshotTimeoutMs ?? 30_000;
    this.#minReconnectDelayMs = opts.minReconnectDelayMs ?? 250;
    this.#maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 10_000;
    this.#maxFrameBytes = opts.maxFrameBytes;
    this.#reconnectDelayMs = this.#minReconnectDelayMs;
    this.#decoder = this.#newDecoder();
    this.#connect();
  }

  #newDecoder(): NdjsonDecoder {
    return this.#maxFrameBytes === undefined ? new NdjsonDecoder() : new NdjsonDecoder({ maxBytes: this.#maxFrameBytes });
  }

  /**
   * True once the socket's 'connect' event has actually fired (not just "a `net.Socket` object
   * exists" — that's true from the moment `net.createConnection` is called, well before the OS
   * handshake completes; `call()`/`subscribe()` work regardless, since writes issued before this
   * is true are buffered by Node and flushed on connect, same as this class's own `#writeQueue`
   * for the reconnect-backoff gap).
   */
  get connected(): boolean {
    return this.#socketReady;
  }

  /**
   * Calls one execd method. Resolves with the typed result, rejects with `ExecRpcError` on a
   * JSON-RPC error response, or `ExecTimeout` if nothing came back in time — see that class's
   * doc comment before treating a timeout as "it didn't happen".
   */
  call<M extends keyof ExecMethods>(
    method: M,
    params: ExecMethods[M]['params'],
    opts: { timeoutMs?: number } = {},
  ): Promise<ExecMethods[M]['result']> {
    if (this.#closed) return Promise.reject(new Error('ExecClient: call() after close()'));
    const timeoutMs = opts.timeoutMs ?? this.#timeoutFor(method);
    const id = String(this.#nextId++);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ExecTimeout(method, id, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve: resolve as (r: unknown) => void, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * Delivers `exec.event` notifications in strict seq order starting after `sinceSeq`, via
   * `onEvent`. Duplicates (seq already delivered) and out-of-order arrivals (seq skips ahead of
   * the next expected one) are dropped and counted, never buffered/reordered or handed to
   * `onEvent`. Survives reconnects: re-issues `exec.events.subscribe` with the last delivered seq
   * once the socket comes back, so the gap (if any) gets backfilled by execd's own replay. Only
   * one subscription is supported per client.
   */
  subscribe(sinceSeq: number, onEvent: (event: ExecEvent) => void): SubscribeHandle {
    if (this.#subscription) {
      throw new Error('ExecClient: subscribe() already active — one subscription per client');
    }
    const subscription: ActiveSubscription = { lastDeliveredSeq: sinceSeq, onEvent, duplicates: 0, outOfOrder: 0 };
    this.#subscription = subscription;
    this.#requestSubscribe(sinceSeq);

    return {
      unsubscribe: () => {
        if (this.#subscription === subscription) this.#subscription = null;
      },
      stats: () => ({ duplicates: subscription.duplicates, outOfOrder: subscription.outOfOrder }),
    };
  }

  /** Closes the connection for good: no reconnect, all pending calls reject, subscription cleared. */
  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ExecClient: closed'));
    }
    this.#pending.clear();
    this.#writeQueue = [];
    this.#subscription = null;
    this.#socket?.destroy();
    this.#socket = null;
    this.#socketReady = false;
  }

  #timeoutFor(method: string): number {
    return method === 'exec.account.snapshot' ? this.#accountSnapshotTimeoutMs : this.#defaultTimeoutMs;
  }

  #requestSubscribe(sinceSeq: number): void {
    this.call('exec.events.subscribe', { since_seq: sinceSeq }).catch(() => {
      // A failed (re)subscribe attempt is retried the next time the connection cycles (or the
      // caller can tell via stats()/connected staying inconsistent); swallow here so it doesn't
      // surface as an unhandled rejection unrelated to any specific call() the caller made.
    });
  }

  #send(frame: unknown): void {
    if (this.#socket && this.#socket.writable) {
      this.#socket.write(encodeFrame(frame));
    } else {
      this.#writeQueue.push(frame);
    }
  }

  #connect(): void {
    if (this.#closed) return;
    const socket = net.createConnection({ path: this.#socketPath });
    this.#socket = socket;

    socket.on('connect', () => {
      this.#socketReady = true;
      this.#reconnectDelayMs = this.#minReconnectDelayMs;
      const queued = this.#writeQueue;
      this.#writeQueue = [];
      for (const frame of queued) socket.write(encodeFrame(frame));
      if (this.#subscription) {
        this.#requestSubscribe(this.#subscription.lastDeliveredSeq);
      }
    });

    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = this.#decoder.push(chunk);
      } catch (err) {
        // FrameTooLargeError: a protocol violation, not a transient error — drop the connection
        // and let the normal reconnect path re-establish with a fresh decoder.
        socket.destroy(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      for (const frame of frames) this.#handleFrame(frame);
    });

    socket.on('error', () => {
      // 'close' always follows an 'error' on a net.Socket; reconnect scheduling lives there so it
      // isn't duplicated. An unhandled 'error' event would otherwise crash the process.
    });

    socket.on('close', () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#socketReady = false;
      }
      this.#decoder = this.#newDecoder();
      if (this.#closed) return;
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return;
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, this.#maxReconnectDelayMs);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #handleFrame(frame: unknown): void {
    if (isRpcSuccess(frame) || isRpcFailure(frame)) {
      const id = frame.id === null ? null : String(frame.id);
      if (id === null) return; // e.g. a parse_error response to an unparseable request we never sent
      const pending = this.#pending.get(id);
      if (!pending) return; // already timed out, or a stray response
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (isRpcFailure(frame)) {
        pending.reject(
          new ExecRpcError(frame.error.code, frame.error.data.kind, frame.error.data.retryable, frame.error.message, frame.error.data.details),
        );
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (isRpcNotification(frame)) {
      this.#handleEvent(frame.params);
    }
  }

  #handleEvent(event: ExecEvent): void {
    const subscription = this.#subscription;
    if (!subscription) return;
    if (event.seq <= subscription.lastDeliveredSeq) {
      subscription.duplicates++;
      return;
    }
    if (event.seq !== subscription.lastDeliveredSeq + 1) {
      subscription.outOfOrder++;
      return;
    }
    subscription.lastDeliveredSeq = event.seq;
    subscription.onEvent(event);
  }
}
