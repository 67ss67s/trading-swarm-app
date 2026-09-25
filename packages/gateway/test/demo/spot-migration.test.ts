import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { newThread } from '../../src/demo/threads.js';

describe('0024 market migration/load', () => {
  it('旧行默认 perp,新行 market/pair_id 往返,凭据按市场独立', () => {
    const state = openStateDb(':memory:');
    try {
      const store = new DemoStore(state);
      const t = newThread({ id: 'old', symbol: 'BTCUSDT', side: 'long', source: 'manual', timeframe: '1h', thesis: '', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '49000', take_profits: [], qty: '0.1', margin_usdt: '5000', leverage: 1, margin_mode: 'cross', now: 1 });
      const { market: _market, pair_id: _pair, ...legacy } = t;
      state.db.prepare('INSERT INTO demo_threads(id,symbol,status,source,created_at,updated_at,json) VALUES (?,?,?,?,?,?,?)').run('old', t.symbol, t.status, t.source, 1, 1, JSON.stringify(legacy));
      expect(state.db.prepare('SELECT market,pair_id FROM demo_threads WHERE id=?').get('old')).toMatchObject({ market: 'perp', pair_id: null });
      expect(store.thread('old')).toMatchObject({ market: 'perp', pair_id: null });
      store.saveThread({ ...t, id: 'spot', market: 'spot', pair_id: 'pair-1' });
      expect(store.thread('spot')).toMatchObject({ market: 'spot', pair_id: 'pair-1' });
      expect(state.db.prepare('SELECT market FROM demo_threads WHERE id=?').get('spot')).toMatchObject({ market: 'spot' });
      state.db.prepare('INSERT INTO demo_intents(id,episode_id,at,status,json) VALUES (?,?,?,?,?)').run('old-intent', 'e', 1, 'proposed', '{}');
      expect(state.db.prepare('SELECT market FROM demo_intents').get()).toMatchObject({ market: 'perp' });
      const ins = state.db.prepare('INSERT INTO protection_credentials(channel,symbol,market,json) VALUES (?,?,?,?)');
      ins.run('okx', 'BTCUSDT', 'perp', '{}'); ins.run('okx', 'BTCUSDT', 'spot', '{}');
      expect(state.db.prepare('SELECT market FROM protection_credentials').all()).toHaveLength(2);
    } finally { state.close(); }
  });
});
