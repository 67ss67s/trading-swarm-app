import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { PaperBackend, type ExecBackend } from '../../src/demo/execution.js';
import { ExecutorControl } from '../../src/demo/executor-control.js';
import { BOT_ROLES } from '../../src/demo/bots.js';
import { stubBrain } from '../../src/demo/brain.js';
import { createServer } from '../../src/demo/http.js';
import { runChatTurn, type ChatTools } from '../../src/demo/chat.js';
import type { BrainQueue } from '../../src/demo/queue.js';
import type { ManualOrderRequest } from '../../src/demo/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const states: StateDb[] = [];
const runtimes: DemoRuntime[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
function setup(path = ':memory:') {
  const state = openStateDb(path); states.push(state);
  const store = new DemoStore(state);
  const backend = new PaperBackend(10_000);
  const rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain() } });
  // No runtime start: no real market, exchange, model, or scheduler activity.
  rt.radar.stop(); runtimes.push(rt);
  return { state, store, backend, rt };
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const rt of runtimes.splice(0)) await rt.stop();
  for (const state of states.splice(0)) state.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('independent Agent controls', () => {
  it('persists an individual pause through database reopen and leaves other roles enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-agent-controls-')); dirs.push(dir);
    const path = join(dir, 'state.sqlite');
    const first = setup(path);
    first.rt.setBotsEnabled(['executor'], false);
    expect(first.store.bots.profiles().filter(p => !p.enabled).map(p => p.role)).toEqual(['executor']);
    await first.rt.stop(); runtimes.splice(runtimes.indexOf(first.rt), 1);
    first.state.close(); states.splice(states.indexOf(first.state), 1);
    const next = setup(path);
    expect(next.store.bots.profiles().filter(p => !p.enabled).map(p => p.role)).toEqual(['executor']);
    next.rt.setBotsEnabled(['executor'], true);
    expect(next.rt.botEnabled('executor')).toBe(true);
  });

  it('HTTP accepts booleans only, rejects unknown roles, supports all then individual resume', async () => {
    const { rt, store } = setup();
    const server = createServer(rt, store); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (role: string, body: unknown) => fetch(`${url}/api/bots/${role}/enabled`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const body of [{ enabled: 'false' }, { enabled: 0 }, { enabled: null }, {}, null, []]) {
      expect((await post('executor', body)).status).toBe(400);
      expect(rt.botEnabled('executor')).toBe(true);
    }
    expect((await post('unknown', { enabled: false })).status).toBe(404);
    expect((await post('all', { enabled: false })).status).toBe(200);
    expect(store.bots.profiles().every(p => !p.enabled)).toBe(true);
    expect((await post('executor', { enabled: true })).status).toBe(200);
    expect(store.bots.profiles().filter(p => p.enabled).map(p => p.role)).toEqual(['executor']);
  });

  it('paused Executor skips background account/settlement and rejects writes before I/O', async () => {
    const { rt, backend } = setup();
    const account = vi.spyOn(backend, 'account');
    const settlement = vi.fn(async () => ({ trades: [], funding: null }));
    Object.assign(backend, { settlement });
    const entry = vi.spyOn(backend, 'placeEntry');
    rt.setBotsEnabled(['executor'], false);
    const internal = rt as unknown as { pollAccount(): Promise<void>; settlePending(): Promise<void> };
    await internal.pollAccount(); await internal.settlePending();
    await expect(rt.backend.account()).rejects.toMatchObject({ status: 409 });
    await expect(rt.backend.settlement!('BTCUSDT', 0, Date.now())).rejects.toMatchObject({ status: 409 });
    await expect(rt.manualOrder({} as ManualOrderRequest)).rejects.toMatchObject({ status: 409 });
    await expect(rt.approveIntent('missing')).rejects.toMatchObject({ status: 409 });
    await expect(rt.backend.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'test' })).rejects.toMatchObject({ status: 409 });
    expect(account).not.toHaveBeenCalled(); expect(settlement).not.toHaveBeenCalled(); expect(entry).not.toHaveBeenCalled();
    rt.setBotsEnabled(['executor'], true);
    await rt.backend.account(); expect(account).toHaveBeenCalledOnce();
  });

  it('all paused roles reject chat and their manual work entry points', async () => {
    const { rt, store } = setup();
    rt.setBotsEnabled(BOT_ROLES, false);
    for (const role of BOT_ROLES) {
      const session = store.createChatSession(role, Date.now(), role);
      expect(() => rt.sendChat('test', session.id)).toThrow(/暂停/);
    }
    expect(() => rt.sendChat('test')).toThrow(/暂停/);
    expect(rt.runInfoNow('test')).toBe(false);
    expect(rt.scan('BTCUSDT', { kind: 'manual', detail: 'test' })).toBe(false);
    expect(() => rt.radar.run('short', 'manual')).toThrow(/暂停/);
    expect(() => rt.team.runLab('manual')).toThrow(/暂停/);
    expect(() => rt.team.brief('manual')).toThrow(/暂停/);
    expect(() => rt.applyAllocator()).toThrow(/暂停/);
    await expect(rt.reflect()).rejects.toMatchObject({ status: 409 });
    expect((await rt.reviewer.maybeBatch('manual')).ran).toBe(false);
    expect(rt.queueView().pending).toBe(0);
    expect(store.bots.runs({ limit: 100 })).toHaveLength(0);
  });

  it('accepted account reconciliation can finish protection after pause without starting another poll', async () => {
    const { rt, backend } = setup();
    const reply = deferred();
    const originalAccount = backend.account.bind(backend);
    const account = vi.spyOn(backend, 'account').mockImplementation(async () => { await reply.promise; return originalAccount(); });
    const stop = vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: 'submitted', receipt: null, avg_price: null, error: null });
    const internal = rt as unknown as { pollAccount(): Promise<void>; reconcileThreads(): Promise<void>; refreshCapacityRules(): Promise<void> };
    vi.spyOn(internal, 'refreshCapacityRules').mockResolvedValue();
    const reconcile = vi.spyOn(internal, 'reconcileThreads').mockImplementation(async () => {
      await rt.backend.placeStop('BTCUSDT', 'long', '100', 'protect-accepted');
    });
    const firstPoll = internal.pollAccount();
    rt.setBotsEnabled(['executor'], false);
    await internal.pollAccount();
    expect(account).toHaveBeenCalledOnce();
    reply.resolve(); await firstPoll;
    expect(reconcile).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
    expect(rt.executorControl.active).toBe(0);
    await expect(rt.backend.placeStop('BTCUSDT', 'long', '100', 'new')).rejects.toMatchObject({ status: 409 });
  });

  it('rechecks queued scans, info and chat after pause before brain selection or evidence loading', async () => {
    const { rt, store } = setup();
    const blocker = deferred();
    const internal = rt as unknown as { queue: BrainQueue; mainBrain(): unknown; cheapBrain(): unknown };
    const main = vi.spyOn(internal, 'mainBrain'); const cheap = vi.spyOn(internal, 'cheapBrain');
    internal.queue.enqueue({ key: 'block', kind: 'manual', symbol: null, run: () => blocker.promise });
    rt.workflow.paused = false;
    expect(rt.scan('BTCUSDT', { kind: 'manual', detail: 'test' })).toBe(true);
    expect(rt.runInfoNow('test')).toBe(true);
    expect(rt.sendChat('test').queued).toBe(true);
    rt.setBotsEnabled(['thread_manager', 'radar', 'gate_captain'], false);
    blocker.resolve();
    await vi.waitFor(() => expect(rt.queueView()).toMatchObject({ pending: 0, running: null }));
    expect(main).not.toHaveBeenCalled(); expect(cheap).not.toHaveBeenCalled();
    expect(store.chat(10, 'chat', 'default').some(m => m.text.includes('暂停'))).toBe(true);
  });
});

describe('Executor accepted-operation scope', () => {
  it('drains accepted entry/protection/cleanup after pause, blocks concurrent new operations', async () => {
    let enabled = true;
    const gate = new ExecutorControl(() => enabled); const nextLeg = deferred(); const legs: string[] = [];
    const operation = gate.run(async () => {
      legs.push('entry'); await nextLeg.promise;
      await gate.run(async () => { legs.push('stop'); });
      await gate.run(async () => { legs.push('cleanup'); });
    });
    expect(gate.active).toBe(1); enabled = false;
    await expect(gate.run(async () => { legs.push('new-entry'); })).rejects.toMatchObject({ status: 409 });
    nextLeg.resolve(); await operation;
    expect(legs).toEqual(['entry', 'stop', 'cleanup']); expect(gate.active).toBe(0);
  });

  it('delayed callbacks cannot inherit permission after their parent operation completes', async () => {
    let enabled = true;
    const gate = new ExecutorControl(() => enabled); const later = deferred(); const call = vi.fn();
    let delayed!: Promise<unknown>;
    await gate.run(async () => { delayed = later.promise.then(() => gate.run(async () => { call(); })); });
    enabled = false; const rejected = expect(delayed).rejects.toMatchObject({ status: 409 });
    later.resolve(); await rejected;
    expect(call).not.toHaveBeenCalled(); expect(gate.active).toBe(0);
  });

  it('preserves synchronous protection capability, releases failed scopes, permits emergency cleanup', async () => {
    const gate = new ExecutorControl(() => false);
    const backend = new PaperBackend(1000) as ExecBackend; backend.protectionCapability = () => 'unverified';
    expect(gate.wrap(backend).protectionCapability!()).toBe('unverified');
    await expect(gate.run(async () => { throw new Error('failed leg'); }, true)).rejects.toThrow('failed leg');
    expect(gate.active).toBe(0);
    await expect(gate.run(async () => gate.run(async () => 'cleanup'), true)).resolves.toBe('cleanup');
    await expect(gate.run(async () => 'ordinary')).rejects.toMatchObject({ status: 409 });
  });
});

it('pausing in-flight chat blocks its tool and follow-up model call', async () => {
  let enabled = true;
  const reply = deferred(); const tool = vi.fn();
  const complete = vi.fn(async () => { await reply.promise; return { text: '@@tool {"name":"get_state","args":{}}', latency_ms: 0, model: 'stub', input_tokens: 1, output_tokens: 1 }; });
  const result = runChatTurn({
    assertEnabled: () => { if (!enabled) throw Object.assign(new Error('已暂停'), { status: 409 }); },
    brain: () => ({ name: 'stub', complete }), tools: { get_state: tool } as unknown as ChatTools,
    stateSummary: () => '', history: () => [], save: () => {}, emit: () => {}, log: () => {},
  }, 'test');
  enabled = false; const rejected = expect(result).rejects.toMatchObject({ status: 409 });
  reply.resolve(); await rejected;
  expect(complete).toHaveBeenCalledOnce(); expect(tool).not.toHaveBeenCalled();
});
