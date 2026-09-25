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

  it('labels a canceled trial as conversion canceled without offering renewal', () => {
    mocks.data = adaptSubscriptions({ subscriptions: [{ job_id: 'job', remote: { statusName: 'closed', trialType: 1, autoRenew: false } }] });
    const html = render();
    expect(html).toContain('已取消转付费');
    expect(html).not.toContain('开自动续费');
    expect(html).not.toContain('拒收本期');
  });
});
