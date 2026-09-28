// 外部仓位(不是本网关开的仓,例如 okx-demo 账户上手动开的 BTC-USDT-SWAP 空单 0.34 张 + OCO 90000/81000):
// 只显示;撤单/平仓流程不碰它的挂单与保护单;访客对它的平仓/改单一律 403 judge_locked(见 soak-http.test.ts 的锁定矩阵)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OkxCliBackend, ALGO_REV_KV_PREFIX, type OkxKv, type OkxRunResult, type OkxSpawnFn } from '../../src/demo/execution-okx.js';
import { resetInstruments, setInstruments, type OkxInstrument } from '../../src/demo/okx/instruments.js';
import { isExternalPosition } from '../../src/demo/external-position.js';
import type { AccountView } from '../../src/demo/types.js';

const BTC: OkxInstrument = { symbol: 'BTCUSDT', instId: 'BTC-USDT-SWAP', instFamily: 'BTC-USDT', ctVal: '0.01', ctValCcy: 'BTC', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', state: 'live' };

beforeEach(() => {
  resetInstruments();
  setInstruments([BTC]);
});
afterEach(() => {
  resetInstruments();
  vi.unstubAllEnvs();
});

function backend(calls: string[][], kv: Map<string, string>): OkxCliBackend {
  const spawnFn: OkxSpawnFn = async (_bin, args): Promise<OkxRunResult> => {
    calls.push(args);
    const has = (...xs: string[]): boolean => xs.every((x) => args.includes(x));
    if (has('swap', 'orders') && !args.includes('algo')) {
      return { code: 0, stdout: JSON.stringify([{ ordId: '111', clOrdId: '' }, { ordId: '222', clOrdId: 'tgdabc123def456e1' }]), stderr: '' };
    }
    if (has('algo', 'orders', 'oco')) return { code: 0, stdout: JSON.stringify([{ algoId: '9001', algoClOrdId: '', slTriggerPx: '90000', tpTriggerPx: '81000' }]), stderr: '' };
    if (has('algo', 'orders', 'conditional')) return { code: 0, stdout: JSON.stringify([{ algoId: '9002', algoClOrdId: '' }, { algoId: '9003', algoClOrdId: 'tgdabc123def456s1' }]), stderr: '' };
    if (has('cancel')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 1, stdout: '', stderr: `no fake rule for ${args.join(' ')}` };
  };
  const store: OkxKv = { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) };
  return new OkxCliBackend({ bin: '/nonexistent/okx', profile: 'okx-demo', demo: true, live: false, kv: store, log: () => {}, spawnFn, algoResolveDelayMs: 0 });
}

const EXTERNAL_SHORT: AccountView['positions'][number] = { symbol: 'BTCUSDT', side: 'short', qty: '0.0034', entry_price: '85000', mark_price: '84000', unrealized_pnl: '3.4', leverage: 1, market: 'perp' } as AccountView['positions'][number];

describe('外部仓位', () => {
  it('cancelAll 只撤本网关的单:外部普通单与外部 OCO/条件单一张不碰', async () => {
    const calls: string[][] = [];
    const kv = new Map<string, string>([[`${ALGO_REV_KV_PREFIX}9002`, 'tgd-abc123def456-s0']]); // 9002 是自家附带腿(KV 反查)
    const b = backend(calls, kv);
    const r = await b.cancelAll('BTCUSDT', 'perp');
    expect(r.ok).toBe(true);
    const cancels = calls.filter((a) => a.includes('cancel')).map((a) => a.join(' '));
    expect(cancels.some((c) => c.includes('--ordId 222'))).toBe(true); // 自家 tgd 单
    expect(cancels.some((c) => c.includes('--algoId 9002'))).toBe(true); // 自家附带腿
    expect(cancels.some((c) => c.includes('--algoId 9003'))).toBe(true); // 自家独立腿
    expect(cancels.some((c) => c.includes('--ordId 111'))).toBe(false); // 外部普通单
    expect(cancels.some((c) => c.includes('--algoId 9001'))).toBe(false); // 外部 OCO(止损 90000 / 止盈 81000)
  });

  it('识别:同品种挂着不是本网关的保护单 → 外部;TG_EXTERNAL_POSITIONS 显式指定也算;自家孤儿仓不算', () => {
    const externalOco = { open_orders: [{ symbol: 'BTCUSDT', market: 'perp', client_order_id: '9001', side: 'BUY', type: 'OCO', stop_price: '90000' }] } as unknown as AccountView;
    const ownStop = { open_orders: [{ symbol: 'BTCUSDT', market: 'perp', client_order_id: 'tgdabc123def456s1', side: 'BUY', type: 'STOP_MARKET', stop_price: '90000' }] } as unknown as AccountView;
    const none = { open_orders: [] } as unknown as AccountView;
    expect(isExternalPosition(EXTERNAL_SHORT, externalOco)).toBe(true);
    expect(isExternalPosition(EXTERNAL_SHORT, ownStop)).toBe(false);
    expect(isExternalPosition(EXTERNAL_SHORT, none)).toBe(false);
    vi.stubEnv('TG_EXTERNAL_POSITIONS', 'btcusdt');
    expect(isExternalPosition(EXTERNAL_SHORT, none)).toBe(true);
  });

});
