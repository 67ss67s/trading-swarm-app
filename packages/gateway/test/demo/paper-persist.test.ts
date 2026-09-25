// execution.ts: PaperBackend snapshot persistence (docs/demo/README.md §5.8). A gateway restart
// must not lose paper positions / resting orders / balance — otherwise every thread looks
// "closed on the exchange side" with no pnl. Also covers DemoStore's generic demo_kv helpers.

import { describe, expect, it } from 'vitest';
import { PaperBackend, PAPER_SNAPSHOT_VERSION, type PaperPersist } from '../../src/demo/execution.js';
import { DemoStore } from '../../src/demo/store.js';
import { openStateDb } from '../../src/state-db.js';

const SYMBOL = 'BTCUSDT';

/** In-memory PaperPersist, standing in for the demo_kv row. */
function memPersist(): PaperPersist & { blob: string | null; writes: number } {
  return {
    blob: null as string | null,
    writes: 0,
    load(): string | null {
      return this.blob;
    },
    save(json: string): void {
      this.blob = json;
      this.writes += 1;
    },
  };
}

/** A long with a resting stop, on a backend wired to `persist`. */
async function seed(persist: PaperPersist): Promise<PaperBackend> {
  const b = new PaperBackend(10_000, { persist });
  await b.setLeverage(SYMBOL, 5);
  b.setMark(SYMBOL, '50000');
  await b.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'market', limit_price: null, client_order_id: 'e1' });
  await b.placeStop(SYMBOL, 'long', '49000', 's1');
  return b;
}

describe('PaperBackend: snapshot persistence', () => {
  it('a fresh backend restored from the snapshot has the same account, positions and open orders', async () => {
    const persist = memPersist();
    const before = await seed(persist);
    expect(persist.writes).toBeGreaterThan(0);

    const beforeAcct = await before.account();
    const revived = new PaperBackend(10_000, { persist });
    const afterAcct = await revived.account();

    // as_of is Date.now() at call time; everything else must survive the round trip bit-for-bit.
    expect({ ...afterAcct, as_of: 0 }).toEqual({ ...beforeAcct, as_of: 0 });
    expect(afterAcct.positions).toHaveLength(1);
    expect(afterAcct.positions[0]).toMatchObject({ symbol: SYMBOL, side: 'long', qty: '0.1', entry_price: '50000', leverage: 5 });
    expect(afterAcct.open_orders).toHaveLength(1);
    expect(afterAcct.open_orders[0]).toMatchObject({ client_order_id: 's1', type: 'STOP_MARKET', stop_price: '49000', reduce_only: true });
    // the wallet carried the entry fee across the restart
    expect(Number(afterAcct.available)).toBeCloseTo(10_000 - 50000 * 0.1 * 0.0004, 6);
  });

  it('the restored instance still triggers the stop it inherited', async () => {
    const persist = memPersist();
    await seed(persist);
    const revived = new PaperBackend(10_000, { persist });

    const events = revived.tick(SYMBOL, '48900');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'sl_hit', client_order_id: 's1', price: '49000' });
    expect(Number(events[0]!.realized_pnl)).toBeCloseTo((49000 - 50000) * 0.1 - 49000 * 0.1 * 0.0004, 6);

    const acct = await revived.account();
    expect(acct.positions).toHaveLength(0);
    expect(acct.open_orders).toHaveLength(0);
    // and the trigger itself was written back, so a second restart sees the flat book
    const again = new PaperBackend(10_000, { persist });
    const acct2 = await again.account();
    expect(acct2.positions).toHaveLength(0);
    expect(acct2.open_orders).toHaveLength(0);
    expect(await again.getOrder(SYMBOL, 's1')).toMatchObject({ status: 'FILLED' });
  });

  it('a resting limit entry survives and fills after the restart', async () => {
    const persist = memPersist();
    const before = new PaperBackend(10_000, { persist });
    before.setMark(SYMBOL, '50000');
    await before.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'limit', limit_price: '49000', client_order_id: 'l1' });

    const revived = new PaperBackend(10_000, { persist });
    expect((await revived.account()).open_orders).toHaveLength(1);
    const events = revived.tick(SYMBOL, '48800');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'entry_filled', client_order_id: 'l1', price: '49000' });
    expect((await revived.account()).positions).toHaveLength(1);
  });

  it('a snapshot from a different version is discarded (warns, starts fresh)', async () => {
    const persist = memPersist();
    await seed(persist);
    const stale = JSON.parse(persist.blob as string) as { version: number };
    stale.version = PAPER_SNAPSHOT_VERSION + 1;
    persist.blob = JSON.stringify(stale);

    const warnings: unknown[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]): void => void warnings.push(a);
    try {
      const revived = new PaperBackend(10_000, { persist });
      const acct = await revived.account();
      expect(acct.positions).toHaveLength(0);
      expect(acct.open_orders).toHaveLength(0);
      expect(acct.available).toBe('10000.00');
    } finally {
      console.warn = orig;
    }
    expect(warnings).toHaveLength(1);
  });

  it('garbage in the store never throws', async () => {
    const persist = memPersist();
    persist.blob = 'not json';
    const orig = console.warn;
    console.warn = (): void => {};
    try {
      const b = new PaperBackend(10_000, { persist });
      expect((await b.account()).available).toBe('10000.00');
    } finally {
      console.warn = orig;
    }
  });

  it('without persist the backend keeps its old in-memory-only behaviour', async () => {
    const b = new PaperBackend(10_000);
    b.setMark(SYMBOL, '50000');
    await b.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'market', limit_price: null, client_order_id: 'e1' });
    expect((await b.account()).positions).toHaveLength(1);
    expect(new PaperBackend(10_000).snapshot().positions).toHaveLength(0);
  });
});

describe('DemoStore: demo_kv', () => {
  it('kvGet returns null for a missing key and round-trips through kvSet, including a paper snapshot', async () => {
    const state = openStateDb(':memory:');
    try {
      const store = new DemoStore(state);
      expect(store.kvGet('paper_state')).toBeNull();

      const backend = new PaperBackend(10_000, { persist: { load: () => store.kvGet('paper_state'), save: (json) => store.kvSet('paper_state', json) } });
      backend.setMark(SYMBOL, '50000');
      await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'market', limit_price: null, client_order_id: 'e1' });

      const blob = store.kvGet('paper_state');
      expect(blob).not.toBeNull();
      expect(JSON.parse(blob as string)).toMatchObject({ version: PAPER_SNAPSHOT_VERSION });

      store.kvSet('paper_state', 'overwritten');
      expect(store.kvGet('paper_state')).toBe('overwritten');
    } finally {
      state.close();
    }
  });
});
