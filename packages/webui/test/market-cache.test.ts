import { afterEach, expect, it, vi } from 'vitest';
import { adaptSubscriptions, waitForMarketRead } from '../src/api/market-adapt';
const loading = { fetched_at: null, state: 'loading' as const, stale: true, refreshing: true, error: null };
afterEach(() => vi.useRealTimers());
it('订阅适配保留未知元信息，不能把首次空占位当空订阅', () => {
  expect(adaptSubscriptions({ subscriptions: [], cache: loading })).toMatchObject({ subscriptions: [], cache: loading });
});
it('命令式搜索等缓存就绪后才消费服务和翻页游标', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValueOnce({ services: [], cache: loading }).mockResolvedValueOnce({ services: ['service'], cache: { ...loading, fetched_at: 100, state: 'ready' } });
  const pending = waitForMarketRead(read);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).services).toEqual(['service']); expect(read).toHaveBeenCalledTimes(2);
});
it('远端加载失败向用户返回错误而非服务不存在', async () => {
  await expect(waitForMarketRead(async () => ({ cache: { ...loading, state: 'error' as const, error: '离线' } }))).rejects.toThrow('离线');
});
