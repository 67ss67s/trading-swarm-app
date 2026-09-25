import { describe, it, expect, vi } from 'vitest';
import { resolveDataConcept, listAdapters, adaptersFor, connectedAdapterIds, marketTypeOf, CATALOG_VERSION } from '../../../../src/demo/research/data/catalog.js';
import { notApplicableReason, proxiesFor, describeProxy, PROXY_RULES } from '../../../../src/demo/research/data/proxies.js';
import { catalogMarketData, type MarketAdapterEntry } from '../../../../src/demo/research/data/index.js';
import { registerDataTools, type DefineTool, type ToolRegistryLike } from '../../../../src/demo/research/data/loop-tools.js';
import type { Instrument, MarketData, SnapshotDraft } from '../../../../src/demo/research/data/index.js';
import type { ToolResult } from '../../../../src/demo/research/loop/tools.js';
/** 只断言 def 产物里本测试关心的字段;run 用最小签名调用。 */
interface ToolDefinitionShape { name: string; input: string; output: string; access: string; budget_class: string; run(input: unknown, ctx: never): Promise<ToolResult> }
const T0 = Date.UTC(2026, 0, 1), H = 3600_000, WINDOW = { from_ms: T0, to_ms: T0 + 100 * H };
const inst = (market_type: 'spot' | 'perp', base = 'BTC'): Instrument => ({
  canonical_id: `okx:${market_type}:${base}-USDT${market_type === 'perp' ? '-SWAP' : ''}`,
  asset_class: 'crypto', venue: 'okx', market_type, base, quote: 'USDT', timezone: 'UTC',
  ccxt_symbol: market_type === 'perp' ? `${base}/USDT:USDT` : `${base}/USDT`, display: base,
});
const snap = (kind: SnapshotDraft['kind'], instrument: Instrument, rows: SnapshotDraft['rows'], coverage: SnapshotDraft['coverage'] = 'available'): SnapshotDraft => ({
  kind, provider: 'okx', instrument, requested_window: WINDOW, actual_window: rows.length ? WINDOW : null, as_of: WINDOW.to_ms, fetched_at: T0,
  frequency: kind === 'funding' ? '8h' : kind === 'liquidations' ? null : '1h', units: {}, coverage, quality_flags: [], rows, method_version: 'test/v1', checksum: 'x',
});
const priceRows = () => Array.from({ length: 5 }, (_, i) => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, open: '100', high: '101', low: '99', close: '100.5', volume: '1' }));
/** 只实现被测方法的假 MarketData;其余方法被调到就是测试写错了。 */
function fakeMarket(over: Partial<MarketData> = {}): MarketData {
  const boom = () => { throw new Error('unexpected_call'); };
  return { resolve: vi.fn(async () => []), coverage: vi.fn(async () => ({ availability: 'available' as const, note: 'fake' })), price: vi.fn(boom as never), funding: vi.fn(boom as never), openInterest: vi.fn(boom as never), liquidations: vi.fn(boom as never), ...over };
}

describe('目录登记', () => {
  it('OKX 四个指标已登记为 connected,占位来源全部 not_connected 且写了接入所需', () => {
    const okx = listAdapters().find((a) => a.id === 'okx-public')!;
    expect(okx.status).toBe('connected');
    expect(okx.metrics.map((m) => m.metric).sort()).toEqual(['funding', 'liquidations', 'open_interest', 'price']);
    const pending = listAdapters().filter((a) => a.status === 'not_connected');
    expect(pending.map((a) => a.id).sort()).toEqual(['binance-public', 'coinglass', 'tradfi-daily']);
    for (const a of pending) expect(a.connect_requirements.length).toBeGreaterThan(20);
    // 占位来源不能声称自己有 available 的东西
    for (const a of pending) expect(connectedAdapterIds(a.metrics[0]!.metric, a.metrics[0]!.market_types[0]!)).not.toContain(a.id);
    // 目录只读:listAdapters 给的是副本,改它不影响目录
    okx.metrics.length = 0;
    expect(listAdapters().find((a) => a.id === 'okx-public')!.metrics.length).toBe(4);
  });
  it('marketTypeOf 从 canonical_id 解析,认不出的按永续兜底', () => {
    expect(marketTypeOf('okx:spot:BTC-USDT')).toBe('spot');
    expect(marketTypeOf('tradfi:equity:AAPL')).toBe('equity');
    expect(marketTypeOf(inst('perp'))).toBe('perp');
    expect(marketTypeOf('garbage')).toBe('perp');
  });
});

describe('resolveDataConcept', () => {
  it('永续的价格/资金费/持仓量/强平都解析到 okx-public,note 带历史深度', () => {
    for (const metric of ['price', 'funding', 'open_interest', 'liquidations'] as const) {
      const r = resolveDataConcept(metric, inst('perp'), metric === 'funding' ? '8h' : metric === 'liquidations' ? null : '1h');
      expect(r.availability).toBe('available');
      expect(r.adapter_id).toBe('okx-public');
      expect(r.note).toContain('历史深度');
      expect(r.catalog_version).toBe(CATALOG_VERSION);
    }
  });
  it('现货问资金费/持仓量/强平是 not_applicable,不是 missing,也不给代理', () => {
    for (const metric of ['funding', 'open_interest', 'liquidations', 'liquidation_estimates'] as const) {
      const r = resolveDataConcept(metric, inst('spot'));
      expect(r.availability).toBe('not_applicable');
      expect(r.note).toContain('只在永续合约上成立');
      expect(r.adapter_id).toBeUndefined();
      expect(r.proxies).toBeUndefined();
    }
  });
  it('TradFi 标的:日线价格是 not_connected(已知 Stooq/Yahoo 但没接),资金费/强平是 not_applicable', () => {
    const price = resolveDataConcept('price', 'tradfi:equity:AAPL', '1d');
    expect(price.availability).toBe('not_connected');
    expect(price.adapter_id).toBe('tradfi-daily');
    expect(price.note).toContain('接入所需');
    for (const metric of ['funding', 'open_interest', 'liquidations', 'liquidation_estimates'] as const) {
      const r = resolveDataConcept(metric, 'tradfi:equity:AAPL');
      expect(r.availability).toBe('not_applicable');
      expect(r.note).toContain('TradFi');
    }
  });
  it('清算估计是 not_connected(Coinglass 付费未接),并给出杠杆升温代理', () => {
    const r = resolveDataConcept('liquidation_estimates', inst('perp'), '1h');
    expect(r.availability).toBe('not_connected');
    expect(r.adapter_id).toBe('coinglass');
    expect(r.note).toContain('付费 API key');
    expect(r.proxies?.map((p) => p.metric).sort()).toEqual(['funding', 'open_interest']);
    for (const p of r.proxies!) { expect(p.adapter_id).toBe('okx-public'); expect(p.note).toContain('代理'); }
    expect(r.candidates?.map((c) => c.adapter_id)).toContain('coinglass');
  });
  it('目录里没人登记的指标是 missing,代理只作为代理出现', () => {
    const r = resolveDataConcept('orderbook', inst('perp'), '1h');
    expect(r.availability).toBe('missing');
    expect(r.adapter_id).toBeUndefined();
    expect(r.note).toContain('不能用其它指标推算后冒充');
    expect(r.proxies?.[0]!.metric).toBe('price');
    expect(r.proxies?.[0]!.note).toContain('流动性粗代理');
  });
  it('周期没登记时给 partial 并说明要重采样,不假装能给', () => {
    const r = resolveDataConcept('open_interest', inst('perp'), '1w');
    expect(r.availability).toBe('partial');
    expect(r.adapter_id).toBe('okx-public');
    expect(r.note).toContain('重采样');
    // 事件流不受周期约束
    expect(resolveDataConcept('liquidations', inst('perp'), '1w').availability).toBe('available');
  });
  it('adaptersFor 按目录顺序返回,含没接的;资金费在币安也登记了', () => {
    const ids = adaptersFor('funding', 'perp').map((x) => x.adapter.id);
    expect(ids).toEqual(['okx-public', 'binance-public']);
    expect(connectedAdapterIds('funding', 'perp')).toEqual(['okx-public']);
  });
});

describe('代理规则表', () => {
  it('每条规则都自带代理声明与「不能用来干什么」', () => {
    expect(PROXY_RULES.length).toBeGreaterThanOrEqual(3);
    for (const rule of PROXY_RULES) {
      expect(rule.label).toContain('代理');
      expect(describeProxy(rule)).toContain(`不是 ${rule.target}`);
      expect(rule.requires.length).toBeGreaterThan(0);
    }
    expect(describeProxy(PROXY_RULES.find((r) => r.target === 'liquidation_estimates')!)).toContain('清算价位');
  });
  it('代理只在成立的市场上给:现货没有杠杆升温代理', () => {
    expect(proxiesFor('liquidation_estimates', 'perp').length).toBe(1);
    expect(proxiesFor('liquidation_estimates', 'spot').length).toBe(0);
    expect(notApplicableReason('price', 'spot')).toBeNull();
    expect(notApplicableReason('funding', 'equity')).toContain('TradFi');
  });
});

describe('catalogMarketData 多来源 fallback', () => {
  const perp = inst('perp');
  it('第一个来源抛错时回落到下一个,flags 记下失败原因与最终来源', async () => {
    const bad = fakeMarket({ price: vi.fn(async () => { throw new Error('PROVIDER_ERROR: okx 50011 rate'); }) });
    const good = fakeMarket({ price: vi.fn(async (i: Instrument) => snap('price', i, priceRows())) });
    const adapters: MarketAdapterEntry[] = [{ adapter_id: 'okx-public', market: bad }, { adapter_id: 'binance-public', market: good }];
    const d = await catalogMarketData({ adapters }).price(perp, '1h', WINDOW);
    expect(d.rows.length).toBe(5);
    expect(d.coverage).toBe('available');
    expect(d.quality_flags).toContain('source:binance-public');
    expect(d.quality_flags.some((f) => f.startsWith('adapter_failed:okx-public'))).toBe(true);
    expect(good.price).toHaveBeenCalledTimes(1);
  });
  it('第一个来源返回空 missing 也继续试下一个', async () => {
    const empty = fakeMarket({ funding: vi.fn(async (i: Instrument) => snap('funding', i, [], 'missing')) });
    const good = fakeMarket({ funding: vi.fn(async (i: Instrument) => snap('funding', i, [{ ts: T0, rate: 0.0001 }])) });
    const d = await catalogMarketData({ adapters: [{ adapter_id: 'okx-public', market: empty }, { adapter_id: 'binance-public', market: good }] }).funding(perp, WINDOW);
    expect(d.quality_flags).toContain('adapter_missing:okx-public');
    expect(d.quality_flags).toContain('source:binance-public');
    expect(d.rows.length).toBe(1);
  });
  it('没有任何来源能给时返回空快照:rows 必须为空,flags 写清试过谁(never fabricate)', async () => {
    const bad = fakeMarket({ liquidations: vi.fn(async () => { throw new Error('PROVIDER_ERROR: boom'); }) });
    const d = await catalogMarketData({ adapters: [{ adapter_id: 'okx-public', market: bad }] }).liquidations(perp, WINDOW);
    expect(d.rows).toEqual([]);
    expect(d.coverage).toBe('missing');
    expect(d.actual_window).toBeNull();
    expect(d.quality_flags).toContain('tried:okx-public');
    expect(d.quality_flags.some((f) => f.startsWith('adapter_failed:okx-public'))).toBe(true);
    expect(d.checksum.length).toBeGreaterThan(0);
  });
  it('目录说不成立时一个来源都不调,直接 not_applicable 且 rows 为空', async () => {
    const market = fakeMarket({ funding: vi.fn(async () => { throw new Error('should_not_be_called'); }) });
    const d = await catalogMarketData({ adapters: [{ adapter_id: 'okx-public', market }] }).funding(inst('spot'), WINDOW);
    expect(d.coverage).toBe('not_applicable');
    expect(d.rows).toEqual([]);
    expect(market.funding).not.toHaveBeenCalled();
    expect(d.quality_flags[0]).toContain('not_applicable');
  });
  it('目录标 connected 但没给实现时记 no_impl,不静默当成没数据', async () => {
    const d = await catalogMarketData({ adapters: [] }).price(perp, '1h', WINDOW);
    expect(d.quality_flags).toContain('catalog_connected_no_impl:okx-public');
    expect(d.quality_flags).toContain('no_connected_adapter:price');
    expect(d.rows).toEqual([]);
  });
  it('CANCELLED 直接上抛,不会被当成来源失败而回落', async () => {
    const market = fakeMarket({ price: vi.fn(async () => { throw new Error('CANCELLED'); }) });
    await expect(catalogMarketData({ adapters: [{ adapter_id: 'okx-public', market }] }).price(perp, '1h', WINDOW)).rejects.toThrow('CANCELLED');
  });
  it('resolve 合并各来源并按 canonical_id 去重;全挂才抛', async () => {
    const a = fakeMarket({ resolve: vi.fn(async () => [inst('spot'), inst('perp')]) });
    const b = fakeMarket({ resolve: vi.fn(async () => [inst('perp'), inst('spot', 'ETH')]) });
    const out = await catalogMarketData({ adapters: [{ adapter_id: 'okx-public', market: a }, { adapter_id: 'binance-public', market: b }] }).resolve({ symbols: ['BTC'] });
    expect(out.map((i) => i.canonical_id)).toEqual(['okx:spot:BTC-USDT', 'okx:perp:BTC-USDT-SWAP', 'okx:spot:ETH-USDT']);
    const dead = fakeMarket({ resolve: vi.fn(async () => { throw new Error('PROVIDER_ERROR: down'); }) });
    await expect(catalogMarketData({ adapters: [{ adapter_id: 'okx-public', market: dead }] }).resolve({})).rejects.toThrow('PROVIDER_ERROR');
  });
  it('coverage:目录先判不成立,来源说 missing 时回目录的解释', async () => {
    const market = fakeMarket({ coverage: vi.fn(async () => ({ availability: 'missing' as const, note: 'provider says no' })) });
    const md = catalogMarketData({ adapters: [{ adapter_id: 'okx-public', market }] });
    expect((await md.coverage(inst('spot'), 'funding', WINDOW)).availability).toBe('not_applicable');
    expect(market.coverage).not.toHaveBeenCalled();
    const c = await md.coverage(perp, 'price', WINDOW);
    expect(c.availability).toBe('missing');
    expect(c.note).toContain('okx-public');
  });
});

describe('registerDataTools', () => {
  /** 复刻 tools.ts 里私有 def 的签名与默认值,主线程会把真的那个传进来。 */
  function harness() {
    const defs = new Map<string, ToolDefinitionShape>();
    const def = ((name: string, input: string, output: string, run: unknown, options: Record<string, unknown> = {}) => ({
      name, version: '1', task_kinds: ['market', 'compare', 'validate', 'diagnose'], asset_classes: ['crypto'], access: 'compute',
      budget_class: 'none', timeout_ms: 30000, idempotent: true, cancellable: true, input, output, run, ...options,
    })) as unknown as DefineTool;
    const registry: ToolRegistryLike = { register: (d: unknown) => defs.set((d as ToolDefinitionShape).name, d as ToolDefinitionShape) };
    registerDataTools(registry, def);
    return defs;
  }
  const ctx = (market: MarketData) => ({ market, signal: new AbortController().signal }) as never;
  it('注册 find_data_source 与 inspect_data_coverage,IO 只用通用 schema 名', () => {
    const defs = harness();
    expect([...defs.keys()].sort()).toEqual(['find_data_source', 'inspect_data_coverage']);
    expect(defs.get('find_data_source')!.input).toBe('Object');
    expect(defs.get('find_data_source')!.output).toBe('Object');
    expect(defs.get('inspect_data_coverage')!.input).toBe('DataInput');
    expect(defs.get('inspect_data_coverage')!.output).toBe('Coverage');
    expect(defs.get('inspect_data_coverage')!.access).toBe('read');
  });
  it('find_data_source:清算估计报 missing + 没接的原因 + 代理规则;可用时报 ok', async () => {
    const run = harness().get('find_data_source')!.run;
    const miss = await run({ metric: 'liquidation_estimates', instrument: inst('perp'), timeframe: '1h' }, ctx(fakeMarket()));
    expect(miss.status).toBe('missing');
    expect(miss.coverage!.availability).toBe('missing');
    expect((miss.output as Record<string, unknown>).availability).toBe('not_connected');
    expect((miss.output as Record<string, unknown>).adapter_id).toBe('coinglass');
    expect(miss.warnings.join()).toContain('可用代理');
    expect(miss.snapshot_refs).toEqual([]);
    const okr = await run({ metric: 'funding', instrument: 'okx:perp:BTC-USDT-SWAP', timeframe: '8h' }, ctx(fakeMarket()));
    expect(okr.status).toBe('ok');
    expect((okr.output as Record<string, unknown>).adapter_id).toBe('okx-public');
    expect(okr.warnings).toEqual([]);
    await expect(run({ instrument: inst('perp') }, ctx(fakeMarket()))).rejects.toThrow('SCHEMA_MISMATCH');
    await expect(run({ metric: 'funding' }, ctx(fakeMarket()))).rejects.toThrow('SCHEMA_MISMATCH');
  });
  it('inspect_data_coverage:目录定案的三种不碰网络,目录说有才问 provider', async () => {
    const run = harness().get('inspect_data_coverage')!.run;
    const market = fakeMarket({ coverage: vi.fn(async () => ({ availability: 'partial' as const, note: '只给最近记录' })) });
    const na = await run({ metric: 'funding', instrument: inst('spot'), window: WINDOW }, ctx(market));
    expect(na.status).toBe('not_applicable');
    expect(market.coverage).not.toHaveBeenCalled();
    const est = await run({ metric: 'liquidation_estimates', instrument: inst('perp'), window: WINDOW }, ctx(market));
    expect(est.status).toBe('missing');
    expect((est.output as { note: string }).note).toContain('尚未接入');
    expect(market.coverage).not.toHaveBeenCalled();
    const live = await run({ metric: 'liquidations', instrument: inst('perp'), window: WINDOW }, ctx(market));
    expect(market.coverage).toHaveBeenCalledTimes(1);
    expect(live.status).toBe('partial');
    expect((live.output as { note: string }).note).toContain('只给最近记录');
    // Coverage 在契约里是 additionalProperties:false,输出只能有这四个键
    expect(Object.keys(live.output as object).every((k) => ['availability', 'earliest', 'latest', 'note'].includes(k))).toBe(true);
  });
});
