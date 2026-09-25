/** SMC 订单周期策略走全窗口回测 + 回放 overlay=smc(合成数据,只做工程验证)。 */
import { afterEach, describe, it, expect } from 'vitest';
import { validate, type StrategyIR } from '@trading-swarm/contracts';
import { openStateDb } from '../../../src/state-db.js';
import { ResearchStore } from '../../../src/demo/research/store.js';
import { ResearchService } from '../../../src/demo/research/service.js';
import { runBacktestReport, type BarsLoader } from '../../../src/demo/research/backtest-report.js';
import { registerBacktestRoutes } from '../../../src/demo/research/backtest-routes.js';
import { node, checkIR } from '../../../src/demo/research/strategy.js';
import { data } from './orders/perp-fixture.js';
const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).forEach((f) => f()); });
const loader: BarsLoader = async (symbol, _tf, w) => { const b = data[symbol]; if (!b) throw Error('DATA_MISSING'); return { bars: b.filter((x) => x.open_time >= w.from_ms && x.close_time <= w.to_ms), source: 'synthetic' }; };
const smcIR = (): StrategyIR => ({
  version: 1, label: 'SMC 订单块回踩', description: '摆动结构看涨时,内部结构向上突破后在新订单块上沿挂限价,下沿止损,上方流动性止盈;持有数天到数周,每 1000 根约数十个信号(待验证)',
  signal: [node('smc_bos', { direction: 'bullish', swing_length: 20, atr_period: 50 })], entry: node('next_open_market', {}),
  risk: { stop: node('smc_ob_level', { swing_length: 20, atr_period: 50 }), sizing: node('equal_notional', { max_allocation: '1' }) },
  exit: [], regime: node('smc_trend', { scope: 'swing', direction: 'bullish', swing_length: 20, atr_period: 50 }),
  order: { direction: 'long', market: 'spot', entry: { type: 'limit', price: node('smc_ob_level', { swing_length: 20, atr_period: 50 }), expiry_bars: 20 }, take_profits: [{ source: node('smc_liquidity_target', { swing_length: 20, atr_period: 50 }) }], min_rr: 1 },
});
describe('SMC 全窗口回测与回放图层', { timeout: 180000 }, () => {
  it('编译通过、走订单执行核有成交,回放 overlay=smc 返回与策略同参数的图层', async () => {
    const db = openStateDb(':memory:'); clean.push(() => db.close()); const store = new ResearchStore(db.db), service = new ResearchService(store);
    const ir = smcIR(); expect(checkIR(ir, '1d').ok, JSON.stringify(checkIR(ir, '1d').checks.filter((c) => !c.ok))).toBe(true);
    const r = await runBacktestReport({ store, service, loader }, { strategy_ir: ir, timeframe: '1d', from_ms: Date.UTC(2021, 6, 1), to_ms: Date.UTC(2025, 1, 8), meta: { session_id: null, inquiry_id: null, question: 'smc', symbol: 'BTCUSDT' }, basket: false });
    expect(validate('research-backtest', r).ok).toBe(true);
    const btc = r.assets.find((a) => a.key === 'BTCUSDT')!;
    expect(btc.status).toBe('completed');
    expect(btc.plans!.length).toBeGreaterThan(0);
    const filled = btc.plans!.filter((p) => p.filled_at !== null);
    expect(filled.length).toBeGreaterThan(0);
    // 限价 = 订单块上沿、止损 = 下沿:止损在限价下方
    expect(filled.every((p) => p.stop!.price < p.entry_price!)).toBe(true);
    const routes = new Map<string, Function>(), out: { status: number; body: any }[] = [];
    registerBacktestRoutes({ route: (m: string, p: string, h: Function) => routes.set(m + ' ' + p, h), json: (_r: unknown, status: number, body: unknown) => out.push({ status, body }), fail: (_r: unknown, status: number, message: string) => out.push({ status, body: { message } }) } as never, store, service, async () => null);
    const replay = routes.get('GET /api/research/backtests/:id/replay')!;
    await replay({}, {}, new URL('http://x/api?asset=BTCUSDT'), { id: r.id });
    expect(out.at(-1)!.body.smc_overlay).toBeUndefined();
    await replay({}, {}, new URL('http://x/api?asset=BTCUSDT&overlay=smc'), { id: r.id });
    const ov = out.at(-1)!.body.smc_overlay;
    expect(out.at(-1)!.status).toBe(200);
    expect(ov.params).toMatchObject({ swing_length: 20, atr_period: 50, internal_length: 5 });
    expect(ov.structures.length).toBeGreaterThan(0); expect(ov.order_blocks.length).toBeGreaterThan(0);
    // 成交计划的限价正好是某个订单块上沿
    const tops = new Set(ov.order_blocks.filter((b: any) => b.dir === 'bullish' && b.scope === 'internal').map((b: any) => b.top));
    expect(filled.some((p) => tops.has(p.entry_price!))).toBe(true);
    await replay({}, {}, new URL('http://x/api?asset=BTCUSDT&overlay=nope'), { id: r.id });
    expect(out.at(-1)!.status).toBe(400);
  });
});
