import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { createServer } from '../../src/demo/http.js';
import { startFakeOkxServer } from './helpers/fake-okx-server.js';

afterEach(() => { delete process.env['TG_OKX_REST_BASE']; delete process.env['TG_EXCHANGE']; });

describe('GET /api/market/basis', () => {
  it.each([undefined, 'spot', 'perp'] as const)('符合基差契约(missing=%s)', async (missing) => {
    const fake = await startFakeOkxServer({ missingBasisSide: missing });
    process.env['TG_OKX_REST_BASE'] = fake.url; process.env['TG_EXCHANGE'] = 'okx';
    const state = openStateDb(':memory:');
    const store = new DemoStore(state);
    const rt = new DemoRuntime({ store, backend: new PaperBackend(), brains: { stub: stubBrain() } });
    const server = createServer(rt, store);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/market/basis?symbol=BTCUSDT`;
      const response = await fetch(url);
      expect(response.status).toBe(missing ? 404 : 200);
      const body = await response.json();
      if (missing) expect(body).toMatchObject({ error: 'basis_unavailable', missing });
      else {
        expect(body).toMatchObject({ symbol: 'BTCUSDT', spot_last: '81400', perp_mark: '81423.5', funding_interval_ms: 28800000 });
        const count = fake.requests.length;
        expect(await (await fetch(url)).json()).toEqual(body);
        expect(fake.requests.length).toBe(count);
      }
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      state.close(); await fake.close();
    }
  });
});
