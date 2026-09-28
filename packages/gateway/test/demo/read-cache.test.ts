import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReadCache } from '../../src/demo/read-cache.js';
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
describe('只读视图缓存', () => {
  it('冷启动立即返回加载中，并发读取只发一次，过期仍返回旧值', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const c = new ReadCache<number>(100, 10);
    let resolve!: (n: number) => void;
    const load = vi.fn(() => new Promise<number>(r => { resolve = r; }));
    expect(c.read(load, 0)).toMatchObject({ value: 0, cache: { state: 'loading', fetched_at: null, refreshing: true } });
    c.read(load, 0); await flush(); expect(load).toHaveBeenCalledTimes(1);
    resolve(42); await flush(); expect(c.read(load, 0).value).toBe(42);
    vi.setSystemTime(1200);
    expect(c.read(load, 0)).toMatchObject({ value: 42, cache: { stale: true, fetched_at: 1000 } });
    await flush(); expect(load).toHaveBeenCalledTimes(2);
  });
  it('刷新失败保留成功快照、暴露错误，并对重试限频', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const c = new ReadCache<number>(100, 50);
    c.read(async () => 42, 0); await flush();
    vi.setSystemTime(1200);
    const fail = vi.fn(async () => { throw new Error('离线'); });
    c.read(fail, 0); await flush();
    expect(c.read(fail, 0)).toMatchObject({ value: 42, cache: { state: 'error', error: '离线', stale: true, fetched_at: 1000 } });
    await flush(); expect(fail).toHaveBeenCalledTimes(1);
  });
  it('失效之后旧刷新不能覆盖新状态', async () => {
    const c = new ReadCache<number>(); let resolve!: (n: number) => void;
    c.read(() => new Promise<number>(r => { resolve = r; }), 0); await flush();
    c.invalidate(); resolve(9); await flush();
    expect(c.read(async () => 11, 0).value).toBe(0); await flush();
    expect(c.read(async () => 12, 0).value).toBe(11);
  });
});
