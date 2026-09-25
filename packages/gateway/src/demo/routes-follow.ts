/** Signal Market follow settings, signal review actions, and local subscription statistics. */
import type { RouteContext, RouteHandler, RouteModule } from './http-extra.js';
import { TRADER_ACTIONS, TRADER_SIGNAL_STATUSES, type FollowMode, type TraderAction, type TraderSignal, type TraderSignalStatus } from './trader-signal.js';
import { redactDeep, redactSecrets } from './trader-feed.js';

/**
 * 一条信号出站前的脱敏 —— **整个对象递归过一遍**(R5-03)。
 * 逐字段列举那版只清了 `raw_text` 与 `decision.note`,旧库行的 `signal_id`/`ref_order`/
 * `decision.agent.blocked[]` 都能直出。
 */
function redactSignal(sig: TraderSignal | null, creds: { api_key: string; secret_token: string } | null): TraderSignal | null {
  return sig ? redactDeep(sig, creds) : sig;
}

export const followRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, json: rawJson, fail: rawFail, readBody, rt, store } = ctx;
  /**
   * R5-03:**本模块所有响应**(包括错误文案)都从这里出去,整个 body 递归脱敏一遍。
   * 不再逐个字段挑 —— 挑一次漏一次。
   */
  const json = (res: Parameters<typeof rawJson>[0], status: number, body: unknown): void =>
    rawJson(res, status, redactDeep(body, rt.followCredentials()));
  /**
   * 错误响应:**整个 `{error:{code,message}}` 过一遍 `redactDeep` 再序列化**(七审 R7-03)。
   *
   * 原来只清 `message`,`code` 原样交给 `http.ts` 的 `rawFail` —— 而 `rawFail` 用的是它自己的
   * 序列化,不经过本模块。抛出来的异常对象上挂一个带秘密的 `code`(`Object.assign(err, {code})`)
   * 就会整段直出。所以这里不再走 `rawFail`,自己按同样的形状发。
   */
  const fail = (res: Parameters<typeof rawFail>[0], status: number, message: string, code = 'error'): void =>
    rawJson(res, status, redactDeep({ error: { code, message } }, rt.followCredentials()));
  /**
   * 本模块**自己的** `guarded`(六审 R6-02)。
   *
   * `http.ts` 那个 `guarded` 捕获异常后调的是**它自己的** `fail`,原样吐 `error.message` ——
   * 绕开了上面这层脱敏。异常消息里可能带着 bridge 返回的正文、URL、或旧行拼进去的 id,
   * 所以跟单路由的异常出口必须走这里。
   */
  const guarded = (fn: RouteHandler): RouteHandler => async (req, res, url, p) => {
    try {
      await fn(req, res, url, p);
    } catch (e) {
      if (res.headersSent) return;
      const err = e as { message?: string; status?: number; code?: unknown };
      const status = typeof err.status === 'number' ? err.status : 500;
      fail(res, status, err.message ?? String(e), typeof err.code === 'string' ? err.code : 'error');
    }
  };

  route('GET', '/api/follow', guarded(async (_req, res) => { json(res, 200, rt.followSettings); }));
  route('POST', '/api/follow', guarded(async (req, res) => {
    rt.marketAgent().saveSettings(await readBody(req)); json(res, 200, rt.followSettings);
  }));

  route('GET', '/api/follow/signals', guarded(async (_req, res, url) => {
    const trader = url.searchParams.get('trader');
    const job = url.searchParams.get('job_id');
    const status = url.searchParams.get('status');
    const action = url.searchParams.get('action');
    const symbol = url.searchParams.get('symbol');
    if (status && !(TRADER_SIGNAL_STATUSES as readonly string[]).includes(status)) return fail(res, 400, `status 只能是 ${TRADER_SIGNAL_STATUSES.join('/')}`, 'bad_status');
    if (action && !(TRADER_ACTIONS as readonly string[]).includes(action)) return fail(res, 400, `action 只能是 ${TRADER_ACTIONS.join('/')}`, 'bad_action');
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw === null ? 100 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail(res, 400, 'limit 须为 1–500 整数', 'bad_limit');
    const signals = store.traderSignals.list({
      ...(trader ? { trader } : {}),
      ...(job ? { job_id: job } : {}),
      ...(symbol ? { symbol } : {}),
      ...(status ? { status: status as TraderSignalStatus } : {}),
      ...(action ? { action: action as TraderAction } : {}),
      limit,
    });
    // P1-14:信号行里的 `raw_text` 与 `decision.note` 都含外部文本 / 异常消息,出站前统一过脱敏。
    // 首发范围(§9.38/§9.39):copy 只对 open 自动且仍过全部闸;管理动作永远人工。前端按它画说明。
    const scope = {
      auto_execution: false,
      human_actions: ['apply', 'skip', 'reconcile'],
      auto_actions_when_enabled: ['open', 'add', 'close', 'stopped_out', 'cancel'],
      manual_only_actions: ['reduce', 'stop_loss_update', 'take_profit_update'],
      auto_manage: false,
      tp_tiers: 'first_only',
      ladder_entry: 'manual_only',
    };
    json(res, 200, { pending_review: store.traderSignals.pendingReview(200), pending_review_total: store.traderSignals.pendingReviewCount(), signals: signals.map((sig) => redactSignal(sig, rt.followCredentials())), connection: rt.marketAgent().inbox.status(), scope });
  }));

  route('POST', '/api/follow/signals/:id/apply', guarded(async (req, res, _url, p) => {
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    // 超龄信号要人显式确认一次(几何早就不是那个几何了);有效期过了的一律不给跟。
    const r = await rt.follow().applyManually(p['id']!, { force_stale: body['force_stale'] === true });
    if (!r.signal) return fail(res, r.status ?? 404, r.error ?? '信号不存在', 'not_found');
    if (r.error) return fail(res, r.status ?? 409, redactSecrets(r.error, rt.followCredentials()), 'apply_blocked');
    json(res, 200, { signal: redactSignal(r.signal, rt.followCredentials()) });
  }));

  /**
   * 人工「已核对」(R5-01):只清 `needs_reconcile` 标记,**不动钱、不改状态**。
   * 带那个标记的行意味着「上次可能已经发出去了、结果未知」——
   * 人去交易所核对完现状、点这一下,才允许再 apply / skip。
   */
  route('POST', '/api/follow/signals/:id/reconcile', guarded(async (_req, res, _url, p) => {
    const r = rt.follow().reconcileManually(p['id']!);
    if (!r.signal) return fail(res, r.status ?? 404, r.error ?? '信号不存在', 'not_found');
    if (r.error) return fail(res, r.status ?? 409, r.error, 'reconcile_blocked');
    json(res, 200, { signal: r.signal });
  }));

  route('POST', '/api/follow/signals/:id/skip', guarded(async (req, res, _url, p) => {
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    const note = typeof body['note'] === 'string' && body['note'].trim() ? body['note'].trim().slice(0, 200) : '人工跳过';
    const r = rt.follow().skipManually(p['id']!, note);
    if (!r.signal) return fail(res, r.status ?? 404, r.error ?? '信号不存在', 'not_found');
    if (r.error) return fail(res, r.status ?? 409, redactSecrets(r.error, rt.followCredentials()), 'skip_blocked');
    json(res, 200, { signal: redactSignal(r.signal, rt.followCredentials()) });
  }));

  route('GET', '/api/follow/stats', guarded(async (_req, res) => { json(res, 200, { subscriptions: rt.marketAgent().stats() }); }));

  // ---------------------------------------------------------------- OKX.AI ASP 信号源(§1.2)

  /**
   * 订阅源状态:库路径、上次轮询、入库/忽略/坏行计数、订阅列表。
   * 订阅列表自己带 60s 缓存,所以这里直接要(CLI 失败只让列表空着,不影响状态)。
   */
  route('GET', '/api/follow/okx-asp', guarded(async (_req, res) => {
    const feed = rt.okxAspFeed();
    await feed.subscriptions();
    json(res, 200, { okx_asp: feed.status(), enabled: rt.followSettings.enabled, poll_ms: rt.followSettings.poll_ms });
  }));

  /** 手动拉一次(调试用;`follow.enabled` 或 `okx_asp_enabled` 关着时它什么也不做)。 */
  route('POST', '/api/follow/okx-asp/poll', guarded(async (_req, res) => {
    const r = await rt.okxAspTick();
    json(res, r.error ? 207 : 200, { ...r, okx_asp: rt.okxAspFeed().status() });
  }));

  /**
   * OKX 账户三盏灯:钱包(onchainos)、A2A 守护(okx-a2a)、Trade Kit(okx CLI)。
   * 缓存 30s,`?fresh=1` 强刷 —— 每盏灯都要 spawn 一个 CLI,前端刷页面不该每次都付这个钱。
   * **不依赖当前交易所**:TG_EXCHANGE=binance 时这三盏灯照样能看(只是多半是灭的)。
   */
  route('GET', '/api/okx/account', guarded(async (_req, res, url) => {
    const lights = await rt.okxAccountLights(url.searchParams.get('fresh') === '1');
    json(res, 200, lights);
  }));

  /** 手动拉一轮(调试用;设置没打开时它什么也不做)。 */
  route('POST', '/api/follow/pull', guarded(async (_req, res) => {
    const r = await rt.followTick();
    json(res, r.error ? 207 : 200, { ...r, connection: rt.marketAgent().inbox.status() });
  }));
};

/** 让 `FollowMode` 在本文件里有个用到的地方(路由校验的枚举来源就是它)。 */
export type { FollowMode };
