import type { RouteModule } from './http-extra.js';
import { InputError, ProfilePinnedError, OkxOnboarding } from './okx-onboarding.js';
import { walletStatus, type WalletStatus } from './wallet-status.js';

/** 注入整个服务，HTTP 测试不运行真实 CLI。 */
export function onboardingRoutes(kit = new OkxOnboarding(), wallet: WalletStatus = walletStatus): RouteModule {
  return ({ route, guarded, json, readBody, fail, rt }) => {
    route('POST', '/api/execution/okx/setup', guarded(async (req, res) => {
      try { json(res, 200, await kit.setup(await readBody(req))); }
      catch (e) { if (e instanceof InputError) fail(res, 400, e.message); else fail(res, 500, 'OKX 配置失败'); }
    }));
    for (const action of ['use', 'remove'] as const) {
      route('POST', `/api/execution/okx/${action}`, guarded(async (req, res) => {
        try { json(res, 200, await kit[action](await readBody(req), async () => {
          // 旧 backend 绑定旧 profile；先通过原有持仓/订单闸安全退出，避免状态与执行账户分叉。
          if (rt.backend.kind === 'okx') {
            const reason = await rt.switchBackend('paper');
            if (reason) throw new ProfilePinnedError(reason);
          }
        })); }
        catch (e) {
          if (e instanceof ProfilePinnedError) fail(res, 409, e.message);
          else if (e instanceof InputError) fail(res, 400, e.message);
          else fail(res, 500, action === 'use' ? '切换 OKX 账户失败' : '断开 OKX 账户失败');
        }
      }));
    }
    route('POST', '/api/execution/okx/install', guarded(async (_req, res) => { json(res, 200, await kit.install()); }));
    route('GET', '/api/execution/okx/mcp', guarded(async (_req, res) => { json(res, 200, await kit.mcp()); }));
    route('POST', '/api/execution/okx/mcp/register', guarded(async (_req, res) => { json(res, 200, await kit.registerMcp()); }));
    route('GET', '/api/wallet', guarded(async (_req, res, url) => { json(res, 200, await wallet.status(url.searchParams.get('refresh') === '1')); }));
    route('GET', '/api/wallet/assets', guarded(async (_req, res, url) => { json(res, 200, await wallet.assets(url.searchParams.get('refresh') === '1')); }));
    route('POST', '/api/wallet/login', guarded(async (_req, res) => { json(res, 200, await wallet.login()); }));
    route('POST', '/api/wallet/login/poll', guarded(async (req, res) => {
      const b = await readBody(req);
      if (typeof b.session_id !== 'string' || !b.session_id.trim() || b.session_id.length > 1024 || b.session_id.startsWith('-')) return fail(res, 400, 'session_id 必须为非空字符串');
      const controller = new AbortController();
      const abort = () => controller.abort();
      // IncomingMessage 'close' also fires after a normally consumed body on modern Node.
      const requestClose = () => { if (!req.complete) abort(); };
      req.on('close', requestClose);
      res.on('close', abort);
      if (req.aborted || res.destroyed) abort();
      try { json(res, 200, await wallet.poll(b.session_id, controller.signal)); }
      finally { req.off('close', requestClose); res.off('close', abort); }
    }));
    route('POST', '/api/wallet/logout', guarded(async (_req, res) => { json(res, 200, await wallet.logout()); }));
  };
}
export const okxOnboardingRoutes = onboardingRoutes();
