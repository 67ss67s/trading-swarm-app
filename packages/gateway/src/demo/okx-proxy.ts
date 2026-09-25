import * as http from 'node:http';

let previous = '';
let restore: (() => void) | undefined;
/** Node 24 原生 EnvHttpProxyAgent，避免另增 undici 依赖。与 curl 采集器一样继承代理并排除回环。 */
export function configureOkxProxy(env: NodeJS.ProcessEnv = process.env): void {
  const fallback = env.all_proxy || env.ALL_PROXY;
  const proxyEnv = {
    HTTP_PROXY: env.http_proxy || env.HTTP_PROXY || fallback,
    HTTPS_PROXY: env.https_proxy || env.HTTPS_PROXY || fallback,
    NO_PROXY: [env.no_proxy, env.NO_PROXY, 'localhost,127.0.0.1,::1'].filter(Boolean).join(','),
  };
  const key = JSON.stringify(proxyEnv);
  if (key === previous) return;
  restore?.(); restore = undefined;
  if (proxyEnv.HTTP_PROXY || proxyEnv.HTTPS_PROXY) {
    // Node 的实现同时设置 fetch dispatcher 和 http(s) Agent，并返回恢复函数。
    const set = (http as typeof http & { setGlobalProxyFromEnv: (env: NodeJS.ProcessEnv) => () => void }).setGlobalProxyFromEnv;
    if (!set) throw new Error('OKX 代理需要支持 setGlobalProxyFromEnv 的 Node 24 版本');
    restore = set(proxyEnv);
  }
  previous = key;
}
