// ExecClient, driven against the fake execd in test/helpers/fake-execd.ts. Covers exactly the
// five behaviors the A0 work package calls out: request/response correlation, ExecTimeout on a
// method that never answers, in-seq event delivery with duplicates/out-of-order dropped (and
// counted), reconnect-and-resubscribe after the connection drops, and oversized frames being
// rejected.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecClient, ExecTimeout } from '../src/exec-client.js';
import { FakeExecd, NO_RESPONSE, shortSocketPath, waitFor } from './helpers/fake-execd.js';

let execd: FakeExecd;
let client: ExecClient;

beforeEach(async () => {
  execd = new FakeExecd(shortSocketPath());
  await execd.listen();
  client = new ExecClient({
    socketPath: execd.socketPath,
    // Generous relative to a local UDS round-trip, but still much shorter than the 10s/30s
    // production defaults, so a genuinely-missing response doesn't make the suite slow.
    defaultTimeoutMs: 2000,
    minReconnectDelayMs: 20,
    maxReconnectDelayMs: 80,
  });
  execd.onMethod('exec.events.subscribe', (params) => ({ ok: true, current_seq: (params as { since_seq?: number }).since_seq ?? 0 }));
});

afterEach(async () => {
  client.close();
  await execd.close();
});

/**
 * `client.connected` (the socket's own 'connect' event) and `execd.liveConnections` (the
 * server's 'connection' event) fire as two independent callbacks for the same underlying
 * handshake — order between them isn't guaranteed. Anything that asserts server-side state right
 * after connecting needs both, not just `client.connected`.
 */
async function waitForConnection(): Promise<void> {
  await waitFor(() => client.connected && execd.liveConnections >= 1, { label: 'client and server both see the connection' });
}

describe('ExecClient: request/response correlation', () => {
  it('resolves call() with the matching response, not a different in-flight one', async () => {
    execd.onMethod('exec.health', () => ({
      ok: true,
      version: '0.1.0-test',
      writer_instance_id: 'fake',
      lease_epoch: 1,
      started_at: 0,
      now: 1,
      db_ok: true,
      mode: 'run',
      halted: false,
      open_intents: 0,
      unknown_attempts: 0,
      channels: { main: { state: 'ok' }, sub: { state: 'ok' } },
    }));
    execd.onMethod('exec.policy.get', () => ({
      policy: {
        schema_version: 1,
        version: 1,
        updated_at: 0,
        mode: 'run',
        authority: 'observe',
        emergency_stop: false,
        live_capped_enabled: false,
        symbol_allowlist: [],
        product_allowlist: [],
        caps: {
          max_leverage: 1,
          risk_pct_per_trade: '0.1',
          max_order_notional: '10',
          max_position_notional: '10',
          max_daily_opens: 1,
          daily_loss_stop_pct: '1',
          symbol_cooldown_seconds: 1,
          max_naked_seconds: 1,
          account_truth_max_age_ms: 1000,
          market_max_age_ms: 1000,
          authorization_ttl_market_seconds: 5,
          authorization_ttl_limit_seconds: 5,
          max_price_deviation_bps: 1,
          ntp_drift_block_ms: 1,
          ntp_drift_halt_ms: 1,
        },
        main_account: { manual_trading_enabled: false, transfers_enabled: false, withdraw_enabled: false },
        canary: { enabled: false },
      },
    }));

    await waitForConnection();

    // Two different methods in flight at once — a naive "last response wins" bug would answer
    // one of these with the other's payload.
    const [health, policy] = await Promise.all([client.call('exec.health', {}), client.call('exec.policy.get', {})]);
    expect(health.version).toBe('0.1.0-test');
    expect(policy.policy.mode).toBe('run');
  });

  it('rejects with ExecRpcError carrying code/kind/retryable/details from the error response', async () => {
    await waitForConnection();
    // No handler registered for exec.exchange.status -> the fake server's default "not found" error.
    await expect(client.call('exec.exchange.status', {})).rejects.toMatchObject({
      name: 'ExecRpcError',
      code: 1001,
      kind: 'not_found',
      retryable: false,
    });
  });
});

describe('ExecClient: timeout is not failure', () => {
  it('throws ExecTimeout (not a generic error) when nothing answers within timeoutMs', async () => {
    execd.onMethod('exec.intent.propose', () => NO_RESPONSE);
    await waitForConnection();

    const start = Date.now();
    await expect(client.call('exec.intent.propose', {} as never, { timeoutMs: 60 })).rejects.toBeInstanceOf(ExecTimeout);
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });

  it('ExecTimeout carries the method and id it was raised for', async () => {
    execd.onMethod('exec.intent.propose', () => NO_RESPONSE);
    await waitForConnection();
    try {
      await client.call('exec.intent.propose', {} as never, { timeoutMs: 40 });
      expect.unreachable('should have timed out');
    } catch (err) {
      expect(err).toBeInstanceOf(ExecTimeout);
      expect((err as ExecTimeout).method).toBe('exec.intent.propose');
      expect((err as ExecTimeout).id).toMatch(/^\d+$/);
    }
  });

  it('a stray late response after timeout is ignored, not delivered to a since-rejected call', async () => {
    execd.onMethod('exec.intent.propose', () => NO_RESPONSE);
    await waitForConnection();
    await expect(client.call('exec.intent.propose', {} as never, { timeoutMs: 30 })).rejects.toBeInstanceOf(ExecTimeout);
    // Simulates the response finally arriving after the client already gave up and stopped
    // tracking that id (the exact race ExecTimeout's doc comment describes) — must not throw
    // anywhere in ExecClient, and must not resolve/reject anything (nothing is awaiting id "1").
    execd.broadcast({ jsonrpc: '2.0', id: '1', result: { intent: {}, gate_rejections: [] } });
    await waitForConnection();
  });
});

describe('ExecClient: event subscription', () => {
  it('delivers events in seq order and drops+counts duplicates and out-of-order arrivals', async () => {
    await waitForConnection();
    const delivered: number[] = [];
    const handle = client.subscribe(0, (event) => delivered.push(event.seq));

    await waitFor(() => execd.liveConnections === 1);
    const mk = (seq: number) => ({ schema_version: 1, seq, event: 'health', at: 0, payload: {} });
    execd.broadcastEvent(mk(1));
    execd.broadcastEvent(mk(2));
    execd.broadcastEvent(mk(2)); // duplicate
    execd.broadcastEvent(mk(10)); // gap / out-of-order (expected next is 3)
    execd.broadcastEvent(mk(3));

    await waitFor(() => delivered.length >= 3, { label: 'events 1,2,3 delivered' });
    expect(delivered).toEqual([1, 2, 3]);
    expect(handle.stats()).toEqual({ duplicates: 1, outOfOrder: 1 });
  });

  it('unsubscribe() stops delivery without touching the connection', async () => {
    await waitForConnection();
    const delivered: number[] = [];
    const handle = client.subscribe(0, (event) => delivered.push(event.seq));
    await waitFor(() => execd.liveConnections === 1);

    execd.broadcastEvent({ schema_version: 1, seq: 1, event: 'health', at: 0, payload: {} });
    await waitFor(() => delivered.length === 1);
    handle.unsubscribe();
    execd.broadcastEvent({ schema_version: 1, seq: 2, event: 'health', at: 0, payload: {} });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(delivered).toEqual([1]);
    expect(client.connected).toBe(true);
  });
});

describe('ExecClient: reconnect', () => {
  it('reconnects after the connection drops and resumes queued/new calls', async () => {
    execd.onMethod('exec.health', () => ({
      ok: true,
      version: 'v1',
      writer_instance_id: 'fake',
      lease_epoch: 1,
      started_at: 0,
      now: 1,
      db_ok: true,
      mode: 'run',
      halted: false,
      open_intents: 0,
      unknown_attempts: 0,
      channels: { main: { state: 'ok' }, sub: { state: 'ok' } },
    }));
    await waitForConnection();
    expect(execd.connectionCount).toBe(1);

    execd.dropConnections();
    await waitFor(() => !client.connected, { label: 'client notices the drop' });
    await waitForConnection();
    expect(execd.connectionCount).toBeGreaterThanOrEqual(2);

    const health = await client.call('exec.health', {}, { timeoutMs: 1000 });
    expect(health.version).toBe('v1');
  });

  it('re-issues exec.events.subscribe with the last delivered seq after reconnecting', async () => {
    const subscribeCalls: number[] = [];
    execd.onMethod('exec.events.subscribe', (params) => {
      const sinceSeq = (params as { since_seq?: number }).since_seq ?? 0;
      subscribeCalls.push(sinceSeq);
      return { ok: true, current_seq: sinceSeq };
    });

    await waitForConnection();
    client.subscribe(5, () => {});
    await waitFor(() => subscribeCalls.length === 1);
    expect(subscribeCalls[0]).toBe(5);

    execd.dropConnections();
    await waitFor(() => !client.connected);
    await waitForConnection();
    await waitFor(() => subscribeCalls.length === 2, { timeoutMs: 3000, label: 'resubscribed after reconnect' });
    expect(subscribeCalls[1]).toBe(5); // no events delivered yet, so still resuming from 5
  });

  it('a call made while disconnected is queued and completes once reconnected', async () => {
    execd.onMethod('exec.health', () => ({
      ok: true,
      version: 'queued',
      writer_instance_id: 'fake',
      lease_epoch: 1,
      started_at: 0,
      now: 1,
      db_ok: true,
      mode: 'run',
      halted: false,
      open_intents: 0,
      unknown_attempts: 0,
      channels: { main: { state: 'ok' }, sub: { state: 'ok' } },
    }));
    await waitForConnection();
    execd.dropConnections();
    await waitFor(() => !client.connected);

    const pending = client.call('exec.health', {}, { timeoutMs: 3000 });
    const health = await pending;
    expect(health.version).toBe('queued');
  });
});

describe('ExecClient: oversized frames', () => {
  it('a line over maxFrameBytes drops the connection instead of being parsed', async () => {
    // Own execd + client, deliberately not the shared ones from beforeEach: broadcasting garbage
    // bytes goes to every connection on an execd instance, and every *other* test's responses are
    // legitimately larger than the tiny maxFrameBytes this test wants — isolating it avoids both.
    const localExecd = new FakeExecd(shortSocketPath());
    await localExecd.listen();
    const localClient = new ExecClient({ socketPath: localExecd.socketPath, defaultTimeoutMs: 2000, minReconnectDelayMs: 20, maxFrameBytes: 256 });
    try {
      await waitFor(() => localClient.connected && localExecd.liveConnections >= 1);

      localExecd.writeRaw(Buffer.from('x'.repeat(1000) + '\n'));
      await waitFor(() => !localClient.connected, { label: 'client drops the connection on an oversized frame' });
      // And it recovers: reconnects on its own once the (still-listening) server accepts again.
      await waitFor(() => localClient.connected, { timeoutMs: 3000, label: 'client reconnects after the oversized frame' });
    } finally {
      localClient.close();
      await localExecd.close();
    }
  });
});
