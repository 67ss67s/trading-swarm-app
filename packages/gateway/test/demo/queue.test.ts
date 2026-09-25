// queue.ts: BrainQueue — one model call in flight at a time, FIFO, dedupe by key while
// pending/running, a throwing job must not stop the queue.

import { describe, expect, it, vi } from 'vitest';
import { BrainQueue, type Job } from '../../src/demo/queue.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function mkJob(key: string, run: () => Promise<void>, overrides: Partial<Job> = {}): Job {
  return { key, kind: 'scan', symbol: null, run, ...overrides };
}

describe('BrainQueue: FIFO + isBusy', () => {
  it('runs jobs in the order they were enqueued', async () => {
    const order: string[] = [];
    const q = new BrainQueue(() => {});
    const gates = [deferred(), deferred(), deferred()];
    q.enqueue(mkJob('a', async () => { order.push('a-start'); await gates[0]!.promise; order.push('a-end'); }));
    q.enqueue(mkJob('b', async () => { order.push('b-start'); await gates[1]!.promise; order.push('b-end'); }));
    q.enqueue(mkJob('c', async () => { order.push('c-start'); await gates[2]!.promise; order.push('c-end'); }));

    await Promise.resolve(); // let the queue start job a
    expect(order).toEqual(['a-start']);
    gates[0]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    gates[1]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start']);
    gates[2]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
  });

  it('isBusy is true for the running job and for pending jobs, false otherwise', async () => {
    const q = new BrainQueue(() => {});
    const gate = deferred();
    q.enqueue(mkJob('running', async () => { await gate.promise; }));
    q.enqueue(mkJob('pending', async () => {}));
    await Promise.resolve();

    expect(q.isBusy('running')).toBe(true);
    expect(q.isBusy('pending')).toBe(true);
    expect(q.isBusy('nope')).toBe(false);
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(q.isBusy('running')).toBe(false);
    expect(q.isBusy('pending')).toBe(false);
  });

  it('enqueue returns true when accepted', () => {
    const q = new BrainQueue(() => {});
    expect(q.enqueue(mkJob('x', async () => {}))).toBe(true);
  });
});

describe('BrainQueue: dedupe by key', () => {
  it('a second enqueue with the same key while pending is rejected (returns false)', () => {
    const q = new BrainQueue(() => {});
    const gate = deferred();
    q.enqueue(mkJob('running', async () => { await gate.promise; }));
    const first = q.enqueue(mkJob('dup', async () => {}));
    const second = q.enqueue(mkJob('dup', async () => {}));
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(q.view().pending).toBe(1); // the duplicate did not get queued twice
  });

  it('a second enqueue with the same key as the currently-running job is rejected', async () => {
    const q = new BrainQueue(() => {});
    const gate = deferred();
    let runs = 0;
    q.enqueue(mkJob('same', async () => { runs++; await gate.promise; }));
    await Promise.resolve();
    const rejected = q.enqueue(mkJob('same', async () => { runs++; }));
    expect(rejected).toBe(false);
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(1);
  });

  it('the same key can be enqueued again once the earlier run has finished', async () => {
    const q = new BrainQueue(() => {});
    let runs = 0;
    q.enqueue(mkJob('k', async () => { runs++; }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(1);
    const again = q.enqueue(mkJob('k', async () => { runs++; }));
    expect(again).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
  });
});

describe('BrainQueue: a throwing job does not stop the queue', () => {
  it('the next job still runs after a prior job throws', async () => {
    const q = new BrainQueue(() => {});
    let secondRan = false;
    q.enqueue(mkJob('boom', async () => { throw new Error('kaboom'); }));
    q.enqueue(mkJob('next', async () => { secondRan = true; }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(secondRan).toBe(true);
    expect(q.view()).toEqual({ pending: 0, running: null });
  });

  it('a synchronously-throwing run() also does not stop the queue', async () => {
    const q = new BrainQueue(() => {});
    let secondRan = false;
    // run() returns Promise<void>, but nothing stops it from synchronously throwing before returning a promise
    q.enqueue(mkJob('sync-boom', () => { throw new Error('sync kaboom'); }) as unknown as Job);
    q.enqueue(mkJob('next', async () => { secondRan = true; }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(secondRan).toBe(true);
  });
});

describe('BrainQueue: view() transitions', () => {
  it('reports pending count and the running job kind/symbol', async () => {
    const views: ReturnType<BrainQueue['view']>[] = [];
    const q = new BrainQueue((v) => views.push(v));
    const gate = deferred();
    q.enqueue(mkJob('a', async () => { await gate.promise; }, { kind: 'scan', symbol: 'BTCUSDT' }));
    q.enqueue(mkJob('b', async () => {}, { kind: 'review', symbol: 'ETHUSDT' }));
    await Promise.resolve();

    expect(q.view()).toMatchObject({ pending: 1, running: { kind: 'scan', symbol: 'BTCUSDT' } });
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(q.view()).toEqual({ pending: 0, running: null });
    expect(views.length).toBeGreaterThan(0);
  });

  it('starts empty: pending 0, running null', () => {
    const q = new BrainQueue(() => {});
    expect(q.view()).toEqual({ pending: 0, running: null });
  });

  it('calls onChange on every enqueue/start/finish transition', async () => {
    const onChange = vi.fn();
    const q = new BrainQueue(onChange);
    q.enqueue(mkJob('a', async () => {}));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2); // at least: enqueued, started/finished
  });
});

describe('BrainQueue priority', () => {
  it('a priority job runs before jobs queued earlier, but never interrupts the running one', async () => {
    const q = new BrainQueue(() => {});
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    q.enqueue({ key: 'first', kind: 'scan', symbol: 'A', run: async () => { order.push('first'); await gate; } });
    q.enqueue({ key: 'second', kind: 'scan', symbol: 'B', run: async () => { order.push('second'); } });
    q.enqueue({ key: 'chat', kind: 'chat', symbol: null, run: async () => { order.push('chat'); } }, { priority: true });
    expect(q.view().running?.key ?? q.view().running?.kind).toBeTruthy();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['first', 'chat', 'second']);
  });
});
