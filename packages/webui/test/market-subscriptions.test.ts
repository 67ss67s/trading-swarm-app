import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { adaptSubscriptions } from '../src/api/market-adapt';

const mocks = vi.hoisted(() => ({
  mutations: [] as Array<{ onSuccess?: (...args: unknown[]) => unknown; onError?: (err: Error) => unknown; retry?: unknown }>,
  pending: false,
  data: {} as unknown,
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
  useQuery: (opts: { queryKey: string[] }) => opts.queryKey[1] === 'subscriptions' ? { data: mocks.data, isLoading: false, isError: false } : {},
  useMutation: (opts: object) => { mocks.mutations.push(opts); return { isPending: mocks.pending, mutate: vi.fn() }; },
}));
vi.mock('@/api/client', () => ({ api: {} }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
import { SubscriptionsTab } from '../src/components/market/subscriptions';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = false;
  mocks.mutations.length = 0;
  mocks.data = adaptSubscriptions({ subscriptions: [{ job_id: 'job', remote: { statusName: 'ACTIVE', trialType: 0, autoRenew: false }, config: {} }] });
});
const render = () => renderToStaticMarkup(createElement(SubscriptionsTab, { onShowSignals: vi.fn() }));

describe('subscription controls', () => {
  it('disables every write action while an operation is pending', () => {
    mocks.pending = true;
    const html = render();
    for (const text of ['开自动续费', '拒收本期', '取消']) {
      const button = html.match(new RegExp(`<button[^>]*>[^<]*${text}</button>`))?.[0];
      expect(button, text).toBeDefined();
      expect(button, text).toContain('disabled');
    }
  });

  it('refreshes subscriptions after each successful write and never retries automatically', () => {
    render();
    for (const mutation of mocks.mutations.slice(1, 4)) {
      mocks.invalidateQueries.mockClear();
      expect(mutation.retry).toBe(false);
      mutation.onSuccess?.();
      expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['market'] });
      expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['follow'] });
    }
    expect(mocks.success).toHaveBeenCalledTimes(3);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('shows original operation errors and refreshes state after ambiguous failures', () => {
    render();
    for (const mutation of mocks.mutations.slice(1, 4)) mutation.onError?.(new Error('请刷新核实\nprovider not online'));
    expect(mocks.error).toHaveBeenCalledTimes(3);
    expect(mocks.error).toHaveBeenLastCalledWith('操作失败', { description: '请刷新核实\nprovider not online' });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['market'] });
  });

  it('shows a cancelled-but-running trial with its end date and no renewal / reject / cancel actions', () => {
    const future = Math.floor((Date.now() + 2 * 86_400_000) / 1000);
    mocks.data = adaptSubscriptions({ subscriptions: [{ job_id: 'job', remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 0, trialEndTime: future } }] });
    const html = render();
    expect(html).toContain('已取消续费 · 试用至');
    expect(html).toContain('试用免费,到期不扣费');
    expect(html).not.toContain('开自动续费');
    expect(html).not.toContain('拒收本期');
    expect(html).not.toContain('取消转付费');
  });

  it('orders groups active → trial → cancelled trial and folds ended subscriptions', () => {
    const future = Math.floor((Date.now() + 2 * 86_400_000) / 1000);
    mocks.data = adaptSubscriptions({ subscriptions: [
      { job_id: 'ended', remote: { statusName: 'closed', trialType: 1, autoRenew: false, title: 'tg · 旧服务' } },
      { job_id: 'cancelled', remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 0, trialEndTime: future, title: 'tg · 取消的试用' } },
      { job_id: 'trial', remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 1, trialEndTime: future, title: 'tg · 试用服务' } },
      { job_id: 'paid', remote: { statusName: 'ACTIVE', trialType: 0, autoRenew: 1, title: 'tg · 付费服务' } },
    ] });
    const html = render();
    const at = (s: string) => html.indexOf(s);
    expect(at('付费服务')).toBeGreaterThan(-1);
    expect(at('付费服务')).toBeLessThan(at('试用服务'));
    expect(at('试用服务')).toBeLessThan(at('取消的试用'));
    expect(html).toContain('试用中 · 还剩');
    expect(html).toContain('已结束');
    expect(html).not.toContain('旧服务');
    expect(html).not.toContain('tg · ');
  });

  it('shows 到期不续费 and no convert-cancel button when the trial auto-renew is already off (gateway display)', () => {
    const future = Math.floor((Date.now() + 2 * 86_400_000) / 1000);
    mocks.data = adaptSubscriptions({ subscriptions: [{ job_id: 'job', remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 0, trialEndTime: future, serviceTokenAmount: '5.9' }, display: { group: 'trial', label: '试用中 · 剩 2 天 19 小时 · 到期不续费', until: future } }] });
    const html = render();
    expect(html).toContain('试用中 · 剩 2 天 19 小时 · 到期不续费');
    expect(html).toContain('试用免费,到期不扣费');
    expect(html).not.toContain('取消转付费');
  });

  it('shows 到期转付费 and keeps the convert-cancel button while auto-renew is on', () => {
    const future = Math.floor((Date.now() + 2 * 86_400_000) / 1000);
    mocks.data = adaptSubscriptions({ subscriptions: [{ job_id: 'job', remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 1, trialEndTime: future, serviceTokenAmount: '5.9' }, display: { group: 'trial', label: '试用中 · 剩 2 天 19 小时 · 到期转付费', until: future } }] });
    let html = render();
    expect(html).toContain('到期转付费');
    expect(html).toContain('取消转付费');
    expect(html).toContain('试用免费,之后 5.9 USDT/月');
    // 老网关的 label 没带续费标注:按 remote.autoRenew 本地拼
    mocks.data = adaptSubscriptions({ subscriptions: [{ job_id: 'job', remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 0, trialEndTime: future }, display: { group: 'trial', label: '试用中', until: future } }] });
    html = render();
    expect(html).toMatch(/试用中 · 还剩 [^<]+ · 到期不续费/);
    expect(html).not.toContain('取消转付费');
  });

  it('explains what to do when there are no subscriptions', () => {
    mocks.data = adaptSubscriptions({ subscriptions: [] });
    const html = renderToStaticMarkup(createElement(SubscriptionsTab, { onShowSignals: vi.fn(), onGoMarket: vi.fn() }));
    expect(html).toContain('你还没有订阅任何服务');
    expect(html).toContain('去市场看看');
  });
});
