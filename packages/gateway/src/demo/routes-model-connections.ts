/**
 * §9.52 模型连接与角色底层的路由(前缀 /api/models)。在 http-extra.ts 里一行注册。
 * 密钥只进不出:POST/PATCH 收 api_key,任何响应只带 key_masked;错误信息已在 ModelRouter 里脱敏。
 * 每次改动由 ModelRouter 发 SSE `models.changed`(data = ModelsView)。
 */
import type { RouteContext, RouteModule } from './http-extra.js';

export const modelConnectionRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, readBody, rt } = ctx;
  // 注册即建:启动时顺带把 ~/.trade-gate-okx/openrouter.env 导入成一条 openrouter 连接(契约「启动时」)。
  rt.modelConnections();

  route('GET', '/api/models', guarded(async (_req, res) => json(res, 200, rt.modelConnections().view())));

  route('POST', '/api/models/connections', guarded(async (req, res) => {
    // openai_compatible 的 base_url 要查 DNS(SSRF 校验),create/update 是 async。
    json(res, 201, await rt.modelConnections().createConnection(await readBody(req)));
  }));
  route('PATCH', '/api/models/connections/:id', guarded(async (req, res, _url, p) => {
    json(res, 200, await rt.modelConnections().updateConnection(p['id']!, await readBody(req)));
  }));
  route('DELETE', '/api/models/connections/:id', async (_req, res, _url, p) => {
    try {
      rt.modelConnections().deleteConnection(p['id']!);
      json(res, 200, { ok: true });
    } catch (e) {
      const err = e as Error & { status?: number; code?: string; roles?: string[] };
      // 409 带上占用它的角色,前端直接列出来。
      json(res, err.status ?? 500, { error: { code: err.code ?? 'error', message: err.message }, ...(err.roles ? { roles: err.roles } : {}) });
    }
  });
  route('POST', '/api/models/connections/:id/test', guarded(async (req, res, _url, p) => {
    const body = await readBody(req).catch(() => ({}));
    json(res, 200, await rt.modelConnections().testConnection(p['id']!, body));
  }));

  route('PUT', '/api/models/bindings/:role', guarded(async (req, res, _url, p) => {
    json(res, 200, rt.modelConnections().setBinding(p['role']!, await readBody(req)));
  }));
  // 按角色测试:用该角色当前生效的底层(绑定 / 回退主脑副脑)发一次最短往返 → RoleTestResult。
  route('POST', '/api/models/bindings/:role/test', guarded(async (_req, res, _url, p) => {
    json(res, 200, await rt.modelConnections().testRole(p['role']!));
  }));
};
