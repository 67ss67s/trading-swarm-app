import { describe, it, expect, vi } from 'vitest';
const { setProxy, restore } = vi.hoisted(() => { const restore = vi.fn(); return { setProxy: vi.fn(() => restore), restore }; });
vi.mock('node:http', () => ({ setGlobalProxyFromEnv: setProxy }));
import { configureOkxProxy } from '../../src/demo/okx-proxy.js';

describe('OKX fetch 代理环境', () => {
  it('支持 HTTPS_PROXY/ALL_PROXY，保留 NO_PROXY 并追加回环', () => {
    configureOkxProxy({ HTTPS_PROXY: 'http://proxy:7890', ALL_PROXY: 'http://fallback:7890', NO_PROXY: '.example.test' });
    expect(setProxy).toHaveBeenLastCalledWith({ HTTP_PROXY: 'http://fallback:7890', HTTPS_PROXY: 'http://proxy:7890', NO_PROXY: '.example.test,localhost,127.0.0.1,::1' });
    configureOkxProxy({ HTTPS_PROXY: 'http://proxy:7890', ALL_PROXY: 'http://fallback:7890', NO_PROXY: '.example.test' });
    expect(setProxy).toHaveBeenCalledTimes(1);
    configureOkxProxy({ https_proxy: 'http://lower:7890', no_proxy: 'okx.com' });
    expect(restore).toHaveBeenCalledOnce();
    expect(setProxy).toHaveBeenLastCalledWith({ HTTP_PROXY: undefined, HTTPS_PROXY: 'http://lower:7890', NO_PROXY: 'okx.com,localhost,127.0.0.1,::1' });
    configureOkxProxy({});
    expect(restore).toHaveBeenCalledTimes(2);
  });
});
