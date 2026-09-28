// A minimal fake execd for exec-client.test.ts: a raw NDJSON JSON-RPC server over a UDS, with
// per-method handlers the test installs, and a way to broadcast `exec.event` notifications and to
// forcibly drop connections (to exercise ExecClient's reconnect path). Not a mock of execd's
// actual behavior — just enough wire protocol to drive ExecClient from the outside.

import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { encodeFrame, NdjsonDecoder } from '@trade-gate/contracts';

/**
 * A short (well under macOS's 104-byte UDS path limit), collision-resistant socket path under
 * /tmp — deliberately not the scratchpad/tmp dir this session otherwise uses, which is nested
 * deep enough to blow that limit.
 */
export function shortSocketPath(): string {
  return `/tmp/tg-t-${randomBytes(4).toString('hex')}.sock`;
}

export type MethodHandler = (params: unknown, id: string | number) => unknown | typeof NO_RESPONSE;

export const NO_RESPONSE = Symbol('no-response');

export class FakeExecd {
  readonly socketPath: string;
  connectionCount = 0;

  #server: net.Server;
  #sockets = new Set<net.Socket>();
  #handlers = new Map<string, MethodHandler>();

  constructor(socketPath: string = shortSocketPath()) {
    this.socketPath = socketPath;
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    this.#server = net.createServer((socket) => {
      this.connectionCount++;
      this.#sockets.add(socket);
      const decoder = new NdjsonDecoder();
      socket.on('data', (chunk: Buffer) => {
        let frames: unknown[];
        try {
          frames = decoder.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const frame of frames) this.#handleFrame(socket, frame);
      });
      socket.on('error', () => {});
      socket.on('close', () => this.#sockets.delete(socket));
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.socketPath, () => resolve());
    });
  }

  close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  onMethod(method: string, handler: MethodHandler): void {
    this.#handlers.set(method, handler);
  }

  /** Number of currently-open client connections (0 or 1 in these tests; ExecClient makes one at a time). */
  get liveConnections(): number {
    return this.#sockets.size;
  }

  /** Forcibly drops every open connection without closing the listening server — simulates execd restarting. */
  dropConnections(): void {
    for (const socket of this.#sockets) socket.destroy();
  }

  broadcast(frame: unknown): void {
    for (const socket of this.#sockets) socket.write(encodeFrame(frame));
  }

  broadcastEvent(event: unknown): void {
    this.broadcast({ jsonrpc: '2.0', method: 'exec.event', params: event });
  }

  /** Writes raw bytes to every connection, bypassing encodeFrame — for the oversized-frame test. */
  writeRaw(bytes: Buffer | string): void {
    for (const socket of this.#sockets) socket.write(bytes);
  }

  #handleFrame(socket: net.Socket, frame: unknown): void {
    if (!frame || typeof frame !== 'object') return;
    const f = frame as { method?: unknown; id?: unknown; params?: unknown };
    if (typeof f.method !== 'string' || f.id === undefined) return; // not a request we answer
    const handler = this.#handlers.get(f.method);
    if (!handler) {
      socket.write(
        encodeFrame({
          jsonrpc: '2.0',
          id: f.id,
          error: { code: 1001, message: `no handler for "${f.method}"`, data: { kind: 'not_found', retryable: false } },
        }),
      );
      return;
    }
    const result = handler(f.params, f.id as string | number);
    if (result === NO_RESPONSE) return;
    socket.write(encodeFrame({ jsonrpc: '2.0', id: f.id, result }));
  }
}

/** Polls `check` until it returns true or `timeoutMs` elapses (then throws). No fixed sleeps. */
export async function waitFor(check: () => boolean, opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
