// 组合级原语(横截面动量、资金费套利)的因果性与口径测试;合成数据,只做工程验证
import { describe, expect, it } from 'vitest';
import type { ResearchBar } from '@trade-gate/contracts';
import { validate } from '@trade-gate/contracts';
import { runXsmom, xsmomTargets, isRebalanceClose, DAY_MS } from '../../../../src/demo/research/primitives/portfolio-xsmom.js';
import { runCarry, carrySignals, normalizedRates } from '../../../../src/demo/research/primitives/portfolio-carry.js';
import { synthBars } from '../backtest-report-fixtures.js';

const START = Date.UTC(2022, 0, 3); // 周一
const days = (n: number, seed: number, base = 100) => synthBars(n, DAY_MS, seed, START, base);
const flat = (n: number, px: number, step = DAY_MS, start = START): ResearchBar[] => Array.from({ length: n }, (_, i) => ({ open_time: start + i * step, close_time: start + (i + 1) * step - 1, available_at: start + (i + 1) * step - 1, open: String(px), high: String(px), low: String(px), close: String(px), volume: '1' }));

describe('portfolio_xsmom', () => {
  it('参数节点过 research-batch 契约', () => {
    expect(validate('research-batch', { primitive: 'portfolio_xsmom', params: { lookback_days: 30, top_k: 3, rebalance: 'weekly' } })).toEqual({ ok: true });
    expect(validate('research-batch', { primitive: 'portfolio_carry', params: { window: 9, min_rate: 0.0001 } })).toEqual({ ok: true });
    expect(validate('research-batch', { primitive: 'portfolio_xsmom', params: { lookback_days: 30 } }).ok).toBe(false);
  });
  it('调仓时刻:周日最后一根收盘(下一根开盘 = 周一 00:00 UTC)', () => {
    expect(isRebalanceClose(Date.UTC(2022, 0, 10) - 1, 'weekly')).toBe(true); // 2022-01-09 周日收盘
    expect(isRebalanceClose(Date.UTC(2022, 0, 11) - 1, 'weekly')).toBe(false);
    expect(isRebalanceClose(Date.UTC(2022, 0, 11) - 1, 'daily')).toBe(true);
  });
  it('排名与权重:前 K 等权、绝对动量留现金、多空各半', () => {
    const sc = [{ symbol: 'A', score: 0.3 }, { symbol: 'B', score: 0.1 }, { symbol: 'C', score: -0.2 }, { symbol: 'D', score: -0.05 }];
    expect([...xsmomTargets(sc, { lookback_days: 30, top_k: 2, rebalance: 'weekly' })]).toEqual([['A', 0.5], ['B', 0.5]]);
    expect([...xsmomTargets(sc, { lookback_days: 30, top_k: 3, rebalance: 'weekly', abs_filter: true })]).toEqual([['A', 1 / 3], ['B', 1 / 3]]);
    const ls = xsmomTargets(sc, { lookback_days: 30, top_k: 1, rebalance: 'weekly', side: 'long_short' });
    expect(ls.get('A')).toBe(0.5); expect(ls.get('C')).toBe(-0.5);
  });
  it('因果:改掉 t 之后的行情,t 及以前的净值与调仓逐位不变', () => {
    const assets = ['A', 'B', 'C', 'D'].map((s, i) => ({ symbol: s, bars: days(200, 3 + i * 7, 50 + i * 10) }));
    const win = { from_ms: START + 40 * DAY_MS, to_ms: START + 200 * DAY_MS }, cost = { fee_rate: 0.001, slippage_bps: 5 }, p = { lookback_days: 30, top_k: 2, rebalance: 'weekly' as const };
    const a = runXsmom(assets, p, win, cost), cut = START + 120 * DAY_MS;
    const changed = assets.map((x) => ({ ...x, bars: x.bars.map((b) => (b.open_time >= cut ? { ...b, open: String(Number(b.open) * 3), close: String(Number(b.close) * 3), high: String(Number(b.high) * 3), low: String(Number(b.low) * 3) } : b)) }));
    const b = runXsmom(changed, p, win, cost);
    expect(b.samples.filter((s) => s.at < cut)).toEqual(a.samples.filter((s) => s.at < cut));
    expect(b.rebalances.filter((r) => r.at < cut)).toEqual(a.rebalances.filter((r) => r.at < cut));
    expect(a.rebalances.length).toBeGreaterThan(15);
  });
  it('成本口径:价格不动时净值只因手续费与滑点下降,随机选币同种子可复现', () => {
    const assets = ['A', 'B', 'C'].map((s) => ({ symbol: s, bars: flat(120, 10) }));
    const r = runXsmom(assets, { lookback_days: 7, top_k: 1, rebalance: 'weekly' }, { from_ms: START + 10 * DAY_MS, to_ms: START + 120 * DAY_MS }, { fee_rate: 0.001, slippage_bps: 5 });
    expect(r.samples.at(-1)!.equity).toBeLessThan(10000);
    expect(r.samples.at(-1)!.equity).toBeGreaterThan(10000 * (1 - 0.0015 * 1.01));// 价格不动排名恒定,只在首次建仓付一次
    const p = { lookback_days: 7, top_k: 1, rebalance: 'weekly' as const, select: 'random' as const, seed: 5 }, w = { from_ms: START + 10 * DAY_MS, to_ms: START + 120 * DAY_MS };
    const d = ['A', 'B', 'C'].map((s, i) => ({ symbol: s, bars: days(120, 11 + i) }));
    expect(runXsmom(d, p, w, { fee_rate: 0.001, slippage_bps: 5 }).samples).toEqual(runXsmom(d, p, w, { fee_rate: 0.001, slippage_bps: 5 }).samples);
  });
  it('永续多空:正费率时多头付、空头收', () => {
    const up = days(120, 1), dn = days(120, 2), H8 = 8 * 3600000;
    const pts = Array.from({ length: 360 }, (_, i) => ({ ts: START + i * H8, rate: 0.001 }));
    const f = { points: pts, from_ms: START, to_ms: START + 360 * H8 };
    const r = runXsmom([{ symbol: 'A', bars: up, funding: f }, { symbol: 'B', bars: dn, funding: f }], { lookback_days: 7, top_k: 1, rebalance: 'weekly', side: 'long_short' }, { from_ms: START + 10 * DAY_MS, to_ms: START + 110 * DAY_MS }, { fee_rate: 0.0005, slippage_bps: 5 });
    expect(Math.abs(r.funding)).toBeLessThan(10000 * 0.001 * 3 * 100 * 0.2);// 多空各半、同费率:资金费大体对冲
    expect(r.samples.every((s) => Math.abs(s.net_exposure) < 0.5)).toBe(true);
  });
  it('运行选项缺省:与不传选项逐位一致(旧批量结果不变)', () => {
    const assets = ['A', 'B', 'C', 'D'].map((s, i) => ({ symbol: s, bars: days(200, 3 + i * 7, 50 + i * 10) }));
    const win = { from_ms: START + 40 * DAY_MS, to_ms: START + 200 * DAY_MS }, cost = { fee_rate: 0.001, slippage_bps: 5 }, p = { lookback_days: 30, top_k: 2, rebalance: 'weekly' as const };
    const a = runXsmom(assets, p, win, cost), b = runXsmom(assets, p, win, cost, 10000, {});
    expect(b).toEqual(a);
    expect(runXsmom(assets, p, win, cost, 10000, { eligible: () => new Set(['A', 'B', 'C', 'D']) }).samples).toEqual(a.samples);
  });
  it('按时点资产池:不在成员集合里的资产不排名、不持有', () => {
    const assets = ['A', 'B', 'C', 'D'].map((s, i) => ({ symbol: s, bars: days(200, 3 + i * 7, 50 + i * 10) }));
    const win = { from_ms: START + 40 * DAY_MS, to_ms: START + 200 * DAY_MS }, cut = START + 120 * DAY_MS;
    const r = runXsmom(assets, { lookback_days: 30, top_k: 2, rebalance: 'weekly' }, win, { fee_rate: 0.001, slippage_bps: 5 }, 10000, { eligible: (t) => new Set(t < cut ? ['A', 'B'] : ['C', 'D']) });
    for (const rb of r.rebalances) { expect(rb.ranked).toBe(2); for (const h of rb.holdings) expect(rb.at < cut ? ['A', 'B'] : ['C', 'D']).toContain(h.symbol); }
  });
  it('退市清算:数据结束的持仓按最后收盘清成现金,不再以最后价永久挂在权益里、也不被当作可用权益加杠杆', () => {
    const rise = flat(60, 10).map((b, i) => { const px = String(10 * (1 + 0.02 * i)); return { ...b, open: px, high: px, low: px, close: px }; });
    const assets = [{ symbol: 'A', bars: rise }, { symbol: 'B', bars: flat(150, 10) }, { symbol: 'C', bars: flat(150, 20) }];
    const win = { from_ms: START + 10 * DAY_MS, to_ms: START + 150 * DAY_MS }, cost = { fee_rate: 0.001, slippage_bps: 5 }, p = { lookback_days: 7, top_k: 1, rebalance: 'weekly' as const };
    const off = runXsmom(assets, p, win, cost), on = runXsmom(assets, p, win, cost, 10000, { liquidate_delisted: true });
    // 不清算:A 停在最后价、调仓又按含 A 的权益满仓买 B,总敞口超过 1
    expect(Math.max(...off.samples.map((s) => s.exposure))).toBeGreaterThan(1.5);
    expect(Math.max(...on.samples.map((s) => s.exposure))).toBeLessThan(1.01); // 满仓时手续费让现金略负,敞口略超 1
    const a = on.trades.find((t) => t.symbol === 'A')!;
    expect(a.open).toBe(false);
    expect(a.exit_price).toBeCloseTo(Number(rise.at(-1)!.close) * (1 - 5e-4), 9);
    expect(on.notes.join()).toContain('退市清算 1 次');
  });
});

describe('portfolio_carry', () => {
  const H4 = 4 * 3600000, H8 = 8 * 3600000;
  it('8h 等效折算与信号只用 ≤ ts 的费率', () => {
    const pts = [{ ts: 0, rate: 0.0001 }, { ts: 4 * 3600000, rate: 0.0001 }, { ts: 8 * 3600000, rate: 0.0003 }];
    expect(normalizedRates(pts).map((x) => +x.rate8h.toFixed(6))).toEqual([0.0001, 0.0002, 0.0006]);
    const s = carrySignals(pts, { window: 2, min_rate: 0.00015 });
    expect(s.map((x) => x.hold)).toEqual([true, true]);
    // 未来费率改掉不影响之前的判定
    expect(carrySignals([...pts.slice(0, 2), { ts: 8 * 3600000, rate: -1 }], { window: 2, min_rate: 0.00015 })[0]).toEqual(s[0]);
  });
  it('价格不动、正费率:入场付两腿成本,之后每期按一半名义收资金费;入场那一刻的结算不收', () => {
    const n = 90, spot = flat(n, 100, H4), perp = flat(n, 100, H4);
    const pts = Array.from({ length: n / 2 }, (_, i) => ({ ts: START + i * H8, rate: 0.0001 }));
    const r = runCarry({ symbol: 'X', spot, perp, funding: { points: pts, from_ms: START, to_ms: pts.at(-1)!.ts } }, { window: 1, min_rate: 0 }, { from_ms: START, to_ms: START + n * H4 - 1 });
    const cost = 5000 * (0.001 + 0.0005) + 5000 * 0.0005 * 2 /* 滑点两腿 */;
    // 第一期 ts=START 当根入场,不收;之后 pts.length-1 期
    const perpQty = 5000 / (100 * (1 - 0.0005)), spotQty = 5000 / (100 * (1 + 0.0005));
    // 权益 = 现金 + 现货市值 + 空头浮盈(永续入场价 99.95 − 收盘 100)+ 资金费
    const expected = (10000 - 5000 - 5000 * 0.0015) + spotQty * 100 + perpQty * (100 * (1 - 0.0005) - 100) + (pts.length - 1) * 0.0001 * perpQty * 100;
    expect(cost).toBeGreaterThan(0);
    expect(r.samples.at(-1)!.equity).toBeCloseTo(expected, 0);
    expect(r.funding).toBeGreaterThan(0);
    expect(r.hold_fraction).toBeGreaterThan(0.95);
  });
  it('价格涨三倍:两腿按带宽调回权益一半,总名义不会涨到权益的 3 倍(否则 1 倍空头早爆仓)', () => {
    const n = 120, px = (i: number) => 100 * (1 + 2 * i / (n - 1));
    const mk = (): ResearchBar[] => Array.from({ length: n }, (_, i) => ({ open_time: START + i * H4, close_time: START + (i + 1) * H4 - 1, available_at: START + (i + 1) * H4 - 1, open: String(px(i)), high: String(px(i)), low: String(px(i)), close: String(px(i)), volume: '1' }));
    const pts = Array.from({ length: n / 2 }, (_, i) => ({ ts: START + i * H8, rate: 0.0001 }));
    const r = runCarry({ symbol: 'X', spot: mk(), perp: mk(), funding: { points: pts, from_ms: START, to_ms: pts.at(-1)!.ts } }, { window: 1, min_rate: 0 }, { from_ms: START, to_ms: START + n * H4 - 1 });
    expect(r.rebalances).toBeGreaterThan(2);
    expect(Math.max(...r.samples.map((x) => x.exposure))).toBeLessThan(1.25 * 1.01);
    expect(Math.abs(r.samples.at(-1)!.net_exposure)).toBeLessThan(0.05);
    expect(r.samples.at(-1)!.equity).toBeGreaterThan(10000 * 0.99);// 价格三倍、中性两腿:只剩成本与资金费
  });
  it('负费率不持有', () => {
    const spot = flat(60, 100, H4), perp = flat(60, 100, H4), pts = Array.from({ length: 30 }, (_, i) => ({ ts: START + i * H8, rate: -0.0001 }));
    const r = runCarry({ symbol: 'X', spot, perp, funding: { points: pts, from_ms: START, to_ms: pts.at(-1)!.ts } }, { window: 3, min_rate: 0 }, { from_ms: START, to_ms: START + 60 * H4 - 1 });
    expect(r.trades).toHaveLength(0); expect(r.samples.at(-1)!.equity).toBe(10000);
  });
});
