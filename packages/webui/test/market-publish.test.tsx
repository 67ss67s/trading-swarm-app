import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  mutations: [] as Array<{ onSuccess?: (...args: unknown[]) => unknown; onError?: (err: Error) => unknown; retry?: unknown }>,
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries, setQueryData: vi.fn() }),
  useQuery: (opts: { queryKey: readonly string[] }) => mocks.queries[opts.queryKey.join('/')] ?? { isLoading: true },
  useMutation: (opts: object) => {
    mocks.mutations.push(opts);
    return { isPending: false, mutate: vi.fn(), reset: vi.fn() };
  },
}));
vi.mock('@/api/client', () => ({ api: {} }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { adaptCustomers, adaptDraft, adaptProducts, type AspProduct } from '../src/api/asp-products';
import type { MarketAsp } from '../src/api/types';
import { PublishTab } from '../src/components/market/publish';
import { diffEdits } from '../src/components/market/products/adjust-dialog';
import { approvalTone, fallbackChecklist, fmtProductPrice, fmtTrialHours, identityPhase, sortProducts, splitDescription, successRate, summarize, summaryLine } from '../src/components/market/products/labels';
import { ProductCard, deliveryLine } from '../src/components/market/products/product-card';

const NOW = 1_780_000_000_000;

const rawProducts = {
  asp: { agent_id: '13866', name: 'Trading Swarm', approval: { code: 1, label: '已上架', remark: null }, online: true, claimable_usdt: '12.5' },
  checklist: [
    { key: 'asp', label: '注册 ASP 身份', done: true, hint: '' },
    { key: 'listed', label: '上架第一个产品', done: true, hint: '' },
    { key: 'review', label: '提交审核', done: true, hint: '' },
    { key: 'first_customer', label: '等第一个订阅者', done: false, hint: '先预览' },
  ],
  products: [
    {
      key: 'research_quick', name: 'Strategy Backtest Quick', kind: 'one_time', price: '2', price_unit: 'call', trial_hours: null,
      description: '核心\n需提供\n交付', service_id: 's2', listing_id: '22', status: 'not_listed', paused: false,
      stats: { active_subscribers: 0, trial_subscribers: 0, orders_7d: 0, orders_total: 0, deliveries_ok: 0, deliveries_failed: 0, last_delivery_at: null },
    },
    {
      key: 'strategy_signal', name: '策略信号', kind: 'subscription', price: '20', price_unit: 'month', trial_hours: 72,
      description: 'a\nb\nc', service_id: 's1', listing_id: '11', status: 'listed', paused: false,
      stats: { active_subscribers: 5, trial_subscribers: 2, orders_7d: 0, orders_total: 0, deliveries_ok: 9, deliveries_failed: 1, last_delivery_at: NOW - 5 * 60_000 },
    },
    {
      key: 'market_intel', name: 'Market Intel 市场情报', kind: 'subscription', price: '9.9', price_unit: 'month', trial_hours: 72,
      description: 'x', service_id: 's3', listing_id: '33', status: 'paused', paused: true,
      stats: { active_subscribers: 3, trial_subscribers: 0, orders_7d: 4, orders_total: 4, deliveries_ok: 3, deliveries_failed: 0, last_delivery_at: NOW - 3_600_000 },
    },
  ],
  as_of: NOW,
};

const asp = {
  cache: undefined,
  identity: { agent_id: '13866', name: 'Trading Swarm', role: 'asp', status: 'active', approval: null, rating: null, sold_count: 0, avatar: null },
  services: [],
  subscribers: [],
  active_count: 0,
  claimable: { amount: '1', currency: 'USDT', error: null },
  aftersales: [],
  publisher: { enabled: true, publish_orders: true, publish_analysis: false, allow_paper_analysis: false, include_realized_pnl: true, symbols: [] },
  track_record: { orders: 1, closes: 1, wins: 1, realized_r_sum: 1.5 },
  publisher_state: { last_publish_at: null, events: 0, delivered: 0, failed: 0 },
  error: null,
} as unknown as MarketAsp;

const JARGON = ['扇出', 'fan-out', 'evidence', 'analysis', 'review_only', '证据'];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutations.length = 0;
  mocks.queries = {};
});

describe('asp-products adapters', () => {
  it('fills missing fields defensively instead of crashing', () => {
    const r = adaptProducts({ products: [{ key: 'x', kind: 'one_time' }, { name: 'no key' }] });
    expect(r.asp.agent_id).toBeNull();
    expect(r.asp.approval).toEqual({ code: null, label: '', remark: null });
    expect(r.checklist).toEqual([]);
    expect(r.products).toHaveLength(1);
    const p = r.products[0]!;
    expect(p.price_unit).toBe('call');
    expect(p.status).toBe('not_listed');
    expect(p.stats).toEqual({ active_subscribers: 0, trial_subscribers: 0, orders_7d: 0, orders_total: 0, deliveries_ok: 0, deliveries_failed: 0, last_delivery_at: null });
    expect(adaptProducts(null).products).toEqual([]);
  });

  it('keeps paused products paused when status is missing', () => {
    expect(adaptProducts({ products: [{ key: 'a', paused: true }] }).products[0]!.status).toBe('paused');
  });

  it('reads customers by product kind', () => {
    const s = adaptCustomers({ items: [{ job_id: 'j', buyer_agent_id: 7, trial: true, pushes: '3' }] }, 'subscription');
    expect(s.kind).toBe('subscription');
    expect(s.items[0]).toMatchObject({ buyer_agent_id: '7', trial: true, pushes: 3, started_at: null });
    const o = adaptCustomers({ items: [{ job_id: 'k', request: 'BTC 4h', delivered_at: 5 }] }, 'one_time');
    expect(o.items[0]).toMatchObject({ request: 'BTC 4h', delivered_at: 5, created_at: null, summary: null });
    expect(adaptCustomers(undefined, 'one_time').items).toEqual([]);
  });

  it('treats blocking findings as not passing even if pass=true', () => {
    const d = adaptDraft({ service_payload: { a: 1 }, validate: { pass: true, findings: ['描述不能含 URL'] }, warns: ['注意', 3, null] });
    expect(d.validate.pass).toBe(false);
    expect(d.validate.findings[0]).toEqual({ field: null, severity: 'block', message: '描述不能含 URL' });
    expect(d.warns).toEqual(['注意', '3']);
    expect(adaptDraft({ service_payload: {}, validate: { pass: true, findings: [{ field: 'name', severity: 'suggest', message: 'm' }] } }).validate.pass).toBe(true);
  });
});

describe('product labels', () => {
  const products = adaptProducts(rawProducts).products;

  it('summarizes listed products, subscribers and 7-day orders', () => {
    expect(summarize(products)).toEqual({ total: 3, listed: 2, in_review: 0, paused: 1, not_listed: 1, subscribers: 8, trial: 2, orders_7d: 4 });
  });

  it('breaks the summary down by status and omits zero counts (listed always shown)', () => {
    const base = { total: 8, listed: 0, in_review: 8, paused: 0, not_listed: 0, subscribers: 2, trial: 2, orders_7d: 18 };
    expect(summaryLine(base)).toBe('8 个产品 · 审核中 8 · 在架 0 · 2 个订阅者(试用中 2) · 近 7 天 18 张订单');
    expect(summaryLine({ ...base, in_review: 0, listed: 3, paused: 1, not_listed: 5, subscribers: 0, trial: 0, orders_7d: 0 })).toBe('8 个产品 · 在架 3(暂停接单 1) · 未上架 5');
    expect(summaryLine(summarize(products))).toBe('3 个产品 · 在架 2(暂停接单 1) · 未上架 1 · 8 个订阅者(试用中 2) · 近 7 天 4 张订单');
  });

  it('maps approval codes to an identity phase', () => {
    const a = (code: number | null, label = '') => ({ code, label, remark: null });
    expect(identityPhase(a(2, '审核中'), false)).toBe('in_review');
    expect(identityPhase(a(3, '重新审核中(资料有改动)'), false)).toBe('in_review');
    expect(identityPhase(a(5, '被拒:x'), false)).toBe('rejected');
    expect(identityPhase(a(6, '被拒:x'), false)).toBe('rejected');
    expect(identityPhase(a(1, '未提交审核'), false)).toBe('not_submitted');
    expect(identityPhase(null, false)).toBe('not_submitted');
    expect(identityPhase(a(2, '审核中'), true)).toBe('listed');
    expect(identityPhase(a(null, '已上架'), false)).toBe('listed');
  });

  it('formats price, trial and success rate in plain language', () => {
    expect(fmtProductPrice({ price: '9.9', price_unit: 'month' })).toBe('9.9 USDT/月');
    expect(fmtProductPrice({ price: '0.5', price_unit: 'call' })).toBe('0.5 USDT/次');
    expect(fmtProductPrice({ price: '0', price_unit: 'call' })).toBe('免费');
    expect(fmtProductPrice({ price: '', price_unit: 'call' })).toBe('—');
    expect(fmtTrialHours(72)).toBe('试用 3 天');
    expect(fmtTrialHours(12)).toBe('试用 12 小时');
    expect(fmtTrialHours(null)).toBeNull();
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(9, 1)).toBe(0.9);
  });

  it('puts the strategy signal first and not-listed last', () => {
    expect(sortProducts(products).map((p) => p.key)).toEqual(['strategy_signal', 'market_intel', 'research_quick']);
  });

  it('derives an approval tone from the plain-language label', () => {
    expect(approvalTone({ code: 2, label: '被拒', remark: '描述含链接' })).toBe('bad');
    expect(approvalTone({ code: 0, label: '审核中', remark: null })).toBe('wait');
    expect(approvalTone({ code: 1, label: '已上架', remark: null })).toBe('ok');
    expect(approvalTone({ code: null, label: '', remark: null })).toBe('idle');
  });

  it('splits descriptions into three sections and only diffs changed fields', () => {
    expect(splitDescription('a\nb\nc\nd')).toEqual(['a', 'b', 'c\nd']);
    expect(splitDescription('only')).toEqual(['only', '', '']);
    const p = { price: '2', description: 'a\nb\nc' };
    expect(diffEdits(p, '2', ['a', 'b', 'c'])).toBeNull();
    expect(diffEdits(p, ' 3 ', ['a', 'b', 'c'])).toEqual({ price: '3' });
    expect(diffEdits(p, '2', ['a', 'B', 'c'])).toEqual({ description: ['a', 'B', 'c'] });
  });

  it('builds a local checklist when the backend has none', () => {
    const c = fallbackChecklist(true, products);
    expect(c.map((x) => x.key)).toEqual(['asp', 'listed', 'review', 'first_customer']);
    expect(c.every((x) => x.done)).toBe(true);
    expect(fallbackChecklist(false, []).some((x) => x.done)).toBe(false);
  });

  it('describes last delivery and success rate', () => {
    const s = products.find((p) => p.key === 'strategy_signal')!;
    expect(deliveryLine(s, NOW)).toBe('最近交付 5 分钟前 · 成功率 90%');
    expect(deliveryLine(products.find((p) => p.key === 'research_quick')!, NOW)).toBe('还没交付过');
  });
});

describe('ProductCard', () => {
  const products = adaptProducts(rawProducts).products;
  const render = (p: AspProduct, expanded = false) =>
    renderToStaticMarkup(
      <ProductCard product={p} now={NOW} expanded={expanded} asp={asp} busy={false} onToggle={vi.fn()} onPreview={vi.fn()} onPause={vi.fn()} onAdjust={vi.fn()} />,
    );

  it('shows subscription metrics, status, trial and all actions', () => {
    const html = render(products.find((p) => p.key === 'strategy_signal')!);
    for (const s of ['策略信号', '订阅', '20 USDT/月', '试用 3 天', '已上架', '活跃订阅者', '其中试用中 2', '预览交付', '暂停接单', '调整', '订阅者']) expect(html, s).toContain(s);
  });

  it('shows one-time metrics and offers listing instead of pausing when not listed', () => {
    const html = render(products.find((p) => p.key === 'research_quick')!);
    for (const s of ['按次', '2 USDT/次', '未上架', '近 7 天订单', '累计订单', '上架', '订单']) expect(html, s).toContain(s);
    expect(html).not.toContain('暂停接单');
  });

  it('offers resume on paused products', () => {
    const html = render(products.find((p) => p.key === 'market_intel')!);
    expect(html).toContain('已暂停接单');
    expect(html).toContain('恢复接单');
  });

  it('puts the strategy signal advanced settings in its expanded area', () => {
    mocks.queries['market/asp-products/strategy_signal/customers'] = { isLoading: false, isError: false, data: { kind: 'subscription', items: [] } };
    const html = render(products.find((p) => p.key === 'strategy_signal')!, true);
    expect(html).toContain('高级:推送设置与推送记录');
    expect(html).toContain('还没有订阅者');
    const other = render(products.find((p) => p.key === 'market_intel')!, true);
    expect(other).not.toContain('高级');
  });
});

describe('PublishTab', () => {
  const render = () => renderToStaticMarkup(<PublishTab />);

  it('shows the identity bar, onboarding and the products summary', () => {
    mocks.queries['market/asp'] = { isLoading: false, isError: false, data: asp };
    mocks.queries['market/asp-products'] = { isLoading: false, isError: false, data: adaptProducts(rawProducts) };
    const html = render();
    for (const s of ['Trading Swarm', '#13866', '已上架', '在线', '12.50 USDT', '领取到钱包', '开始卖信号', '已完成 3/4', '去做', '我的产品', '3 个产品 · 在架 2(暂停接单 1) · 未上架 1 · 8 个订阅者(试用中 2) · 近 7 天 4 张订单', '下架身份']) expect(html, s).toContain(s);
    expect(html).not.toContain('上架身份</button>');
    for (const j of JARGON) expect(html, j).not.toContain(j);
  });

  const unlisted = { ...asp, identity: { ...asp.identity!, status: 'inactive' } } as unknown as MarketAsp;
  const withApproval = (approval: { code: number | null; label: string; remark: string | null }) => {
    mocks.queries['market/asp'] = { isLoading: false, isError: false, data: unlisted };
    mocks.queries['market/asp-products'] = { isLoading: false, isError: false, data: adaptProducts({ ...rawProducts, asp: { ...rawProducts.asp, approval } }) };
    return render();
  };

  it('shows the rejection reason and offers resubmitting after a rejection', () => {
    const html = withApproval({ code: 5, label: '被拒:描述含链接', remark: '描述含链接' });
    expect(html).toContain('被拒');
    expect(html).toContain('描述含链接');
    expect(html).toContain('重新提交审核');
    expect(html).not.toContain('上架身份');
  });

  it('hides the list-identity button while under review', () => {
    for (const approval of [{ code: 2, label: '审核中', remark: null }, { code: 3, label: '重新审核中(资料有改动)', remark: '改资料触发重新审批' }]) {
      const html = withApproval(approval);
      expect(html, String(approval.code)).not.toContain('上架身份');
      expect(html, String(approval.code)).not.toContain('重新提交审核');
      expect(html, String(approval.code)).not.toContain('下架身份');
    }
  });

  it('offers listing the identity when it was never submitted', () => {
    const html = withApproval({ code: 1, label: '未提交审核', remark: null });
    expect(html).toContain('上架身份');
    expect(html).not.toContain('重新提交审核');
  });

  it('does not repeat the data time inside the tab (the page header has it) unless the data is stale', () => {
    mocks.queries['market/asp-products'] = { isLoading: false, isError: false, data: adaptProducts(rawProducts) };
    mocks.queries['market/asp'] = { isLoading: false, isError: false, data: { ...asp, cache: { fetched_at: NOW, stale: false, refreshing: false, error: null } } };
    expect(render()).not.toContain('数据时间');
    mocks.queries['market/asp'] = { isLoading: false, isError: false, data: { ...asp, cache: { fetched_at: NOW, stale: true, refreshing: false, error: 'timeout' } } };
    const html = render();
    expect(html).toContain('数据已过期');
    expect(html).toContain('timeout');
  });

  it('keeps the identity bar when the products endpoint fails', () => {
    mocks.queries['market/asp'] = { isLoading: false, isError: false, data: asp };
    mocks.queries['market/asp-products'] = { isLoading: false, isError: true, error: new Error('HTTP 404') };
    const html = render();
    expect(html).toContain('Trading Swarm');
    expect(html).toContain('加载失败');
    expect(html).toContain('HTTP 404');
  });

  it('shows an empty state when there are no products', () => {
    mocks.queries['market/asp'] = { isLoading: false, isError: false, data: asp };
    mocks.queries['market/asp-products'] = { isLoading: false, isError: false, data: adaptProducts({ ...rawProducts, products: [] }) };
    expect(render()).toContain('还没有产品');
  });

  it('shows onboarding plus the registration form without an ASP identity', () => {
    mocks.queries['market/asp'] = { isLoading: false, isError: false, data: { ...asp, identity: null } };
    const html = render();
    expect(html).toContain('注册卖家身份');
    expect(html).toContain('注册 ASP 身份');
    expect(html).toContain('已完成 0/4');
    for (const j of JARGON) expect(html, j).not.toContain(j);
  });

  it('never retries write actions and refreshes products after pausing', () => {
    mocks.queries['market/asp'] = { isLoading: false, isError: false, data: asp };
    mocks.queries['market/asp-products'] = { isLoading: false, isError: false, data: adaptProducts(rawProducts) };
    render();
    for (const m of mocks.mutations) expect(m.retry).toBe(false);
    const pause = mocks.mutations[4]!; // activate, deactivate, claim, decide, pause
    pause.onSuccess?.(undefined, { key: 'market_intel', paused: false });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['market', 'asp-products'] });
    expect(mocks.success).toHaveBeenCalledWith('已恢复接单');
    pause.onError?.(new Error('boom'));
    expect(mocks.error).toHaveBeenCalledWith('操作失败', { description: 'boom' });
  });
});
