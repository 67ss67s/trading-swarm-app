import type { IncomingMessage } from 'node:http';
import type { RouteModule } from '../http-extra.js';
import { data, list, object, CliError } from './cli.js';
import { filterCatalog } from './catalog.js';
import { scorecardFor } from './scorecard.js';
import { fetchKlines } from '../market.js';
/** Bounded native multipart parser via Web Request; only avatar bytes ever reach a temporary file. */
async function multipart(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1200000) throw Object.assign(new Error('multipart 超过 1.2MB'), { status: 413 }); chunks.push(chunk); }
  let form: FormData;
  try { form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: Buffer.concat(chunks) }).formData(); }
  catch { throw Object.assign(new Error('无效 multipart/form-data'), { status: 400 }); }
  const fields: Record<string, unknown> = {}; let avatar: { bytes: Buffer; type: string } | null = null;
  for (const [key, value] of form.entries()) {
    if (key === 'avatar' && typeof value !== 'string') avatar = { bytes: Buffer.from(await value.arrayBuffer()), type: value.type };
    else if (typeof value === 'string') fields[key] = value;
  }
  return { fields, avatar };
}
const limitOf = (url: URL) => {
  const n = Number(url.searchParams.get('limit') ?? 100); if (!Number.isInteger(n) || n < 1 || n > 500) throw Object.assign(new Error('limit 必须是 1–500'), { status: 400 }); return n;
};
export const marketRoutes: RouteModule = ({ route, guarded: outerGuarded, json, readBody, rt }) => {
  const guarded: typeof outerGuarded = (fn) => outerGuarded(async (req, res, url, p) => {
    try { await fn(req, res, url, p); } catch (e) {
      if (!(e instanceof CliError)) throw e;
      json(res, e.status, { error: { code: e.code, message: e.message, hint: e.hint, raw_message: e.raw_message } });
    }
  });
  const agent = () => rt.marketAgent();
  route('GET', '/api/market/status', guarded(async (_req, res) => {
    const a = agent(); const errors: Record<string, string> = {};
    const safe = async <T>(key: string, fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch (e) { errors[key] = (e as Error).message; return null; } };
    const [lights, wallet, identity, cost] = await Promise.all([
      rt.okxAccountLights(), safe('wallet', () => a.wallet.status()), safe('identity', () => a.identity.mine()), safe('cost', async () => data(await a.cli.call('subscribe-cost'))),
    ]);
    json(res, 200, { lights, wallet, a2a: lights.a2a, trade_kit: lights.trade_kit, buyer: identity?.buyer ?? null, asp: identity?.asp ?? null, subscribe_cost: cost, inbox: a.inbox.status(), errors });
  }));
  route('POST', '/api/market/wallet/deposit-notice', guarded(async (_req, res) => json(res, 200, await agent().wallet.depositNotice())));
  route('GET', '/api/market/search', guarded(async (_req, res, url) => {
    const after = url.searchParams.get('after');
    const aspId = url.searchParams.get('asp_agent_id');
    // 三种起手:续页(只能带 search-after)/ 按 ASP 列它的全部服务(订阅前拿 serviceId/feeToken 用)/ 关键词。
    const args = after ? ['--search-after', after] : aspId ? ['--asp-agent-id', aspId] : ['--keywords', url.searchParams.get('keywords') || '信号 signal 合约 perp'];
    const result = data(await agent().cli.call('service-match', args));
    let services = Array.isArray(result['services']) ? result['services'] as Record<string, unknown>[] : [];
    if (url.searchParams.get('trial') === 'true' || url.searchParams.get('trial') === '1') services = services.filter((x) => x['supportTrial'] === true || !!x['freeTrial']);
    const max = url.searchParams.get('max_fee'); if (max !== null) { if (!/^\d+(?:\.\d+)?$/.test(max)) throw Object.assign(new Error('max_fee 无效'), { status: 400 }); services = services.filter((x) => Number(x['feeAmount']) <= Number(max)); }
    json(res, 200, { ...result, services, searchAfter: result['searchAfter'] ?? null, hasMore: result['hasMore'] === true });
  }));
  // Static /asp routes precede the dynamic identity route.
  // 网页目录(SSR 扒的,只读;设计 §2.3 补充):全站 agent + 分类,详情含服务/评价分布。
  route('GET', '/api/market/catalog', guarded(async (_req, res, url) => {
    const c = agent().catalog.get({ refresh: url.searchParams.get('refresh') === '1' });
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
    const size = Math.min(200, Math.max(1, Number(url.searchParams.get('page_size') ?? 60) || 60));
    const q = { category: url.searchParams.get('category'), text: url.searchParams.get('q'), monthly: url.searchParams.get('monthly') === '1', trial: url.searchParams.get('trial') === '1', sort: url.searchParams.get('sort') };
    const all = filterCatalog(c.agents, q);
    // 不把订阅读取失败渲染成“未订阅”，避免基于未知状态重复开通。
    const mine = await agent().subscribedByProvider();
    json(res, 200, { fetched_at: c.fetched_at, building: c.building, total_site: c.total_site, categories: c.categories, total: all.length, page, page_size: size, agents: all.slice((page - 1) * size, page * size).map((a) => ({ ...a, subscription: mine[a.agent_id] ?? null })), errors: c.errors });
  }));
  route('POST', '/api/market/catalog/refresh', guarded(async (_req, res) => { void agent().catalog.rebuild(); json(res, 202, { building: true }); }));
  route('GET', '/api/market/catalog/:agent_id', guarded(async (_req, res, _url, p) => {
    const d = await agent().catalog.detail(p['agent_id']!);
    if (!d) throw Object.assign(new Error('okx.ai 上没有这个 agent 或页面结构变了'), { status: 404 });
    json(res, 200, d);
  }));
  route('GET', '/api/market/asp', guarded(async (_req, res) => json(res, 200, await agent().asp())));
  route('GET', '/api/market/asp/deliveries', guarded(async (_req, res, url) => json(res, 200, { deliveries: agent().publisher.deliveries(limitOf(url)) })));
  route('GET', '/api/market/asp/:agent_id', guarded(async (_req, res, _url, p) => json(res, 200, await agent().identity.detail(p['agent_id']!))));
  route('POST', '/api/market/subscribe', guarded(async (req, res) => json(res, 200, await agent().subscribe(await readBody(req)))));
  route('GET', '/api/market/subscriptions', guarded(async (_req, res) => json(res, 200, await agent().subscriptions())));
  route('PATCH', '/api/market/subscriptions/:job_id', guarded(async (req, res, _url, p) => {
    const o = await readBody(req); const a = agent(); a.validateConfig(o);
    if (o['this_device_receives'] !== undefined) await a.devices(p['job_id']!, o['this_device_receives'] === true);
    const config = a.saveConfig(p['job_id']!, o); json(res, 200, { job_id: p['job_id'], config });
  }));
  for (const action of ['cancel', 'reject', 'autorenew'] as const) {
    route('POST', `/api/market/subscriptions/:job_id/${action}`, guarded(async (req, res, _url, p) => {
      json(res, 200, await agent().subscriptionAction(p['job_id']!, action, await readBody(req)));
    }));
  }
  // 订阅信号事后回测(影子回放式,零下单):按 K 线检验每条 order 信号的入场/止损/止盈,汇总胜率/平均 R/盈亏比。
  route('GET', '/api/market/subscriptions/:job_id/scorecard', guarded(async (_req, res, url, p) => json(res, 200, await scorecardFor(p['job_id']!, { store: rt.store, now: Date.now(), fetchKlines: (symbol, tf, limit) => fetchKlines(symbol, tf, limit), force: url.searchParams.get('force') === '1' }))));
  route('GET', '/api/market/inbox', guarded(async (_req, res, url) => json(res, 200, { deliveries: agent().inbox.rows({ ...(url.searchParams.get('job_id') ? { job_id: url.searchParams.get('job_id')! } : {}), ...(url.searchParams.get('status') ? { status: url.searchParams.get('status')! } : {}), limit: limitOf(url) }), inbox: agent().inbox.status() })));
  route('POST', '/api/market/inbox/poll', guarded(async (_req, res) => {
    if (rt.followSettings.transport !== 'queue') throw Object.assign(new Error('watch transport 不允许手动 queue poll'), { status: 409 });
    const result = await rt.okxAspTick(); json(res, result.error ? 207 : 200, result);
  }));
  route('GET', '/api/market/settings', guarded(async (_req, res) => json(res, 200, agent().settings())));
  route('POST', '/api/market/settings', guarded(async (req, res) => json(res, 200, agent().saveSettings(await readBody(req)))));
  route('POST', '/api/market/asp/validate', guarded(async (req, res) => json(res, 200, await agent().identity.validate(await readBody(req)))));
  route('POST', '/api/market/asp/register', guarded(async (req, res) => { const { fields, avatar } = await multipart(req); json(res, 200, await agent().identity.register(fields, avatar)); }));
  for (const command of ['activate', 'deactivate', 'update'] as const) route('POST', `/api/market/asp/${command}`, guarded(async (req, res) => json(res, 200, await agent().identity.mutate(command, await readBody(req)))));
  route('POST', '/api/market/asp/claim', guarded(async (_req, res) => json(res, 200, await agent().claim())));
  route('POST', '/api/market/asp/aftersales/:job_id', guarded(async (req, res, _url, p) => {
    const o = await readBody(req); if (o['decision'] !== 'agree_refund' && o['decision'] !== 'dispute') throw Object.assign(new Error('decision 无效'), { status: 400 });
    json(res, 200, await agent().aftersales.decide(p['job_id']!, o['decision'], typeof o['reason'] === 'string' ? o['reason'] : undefined));
  }));
  route('POST', '/api/market/asp/deliveries/:event_id/retry', guarded(async (req, res, _url, p) => { const o = await readBody(req); json(res, 200, await agent().publisher.retry(p['event_id']!, typeof o['job_id'] === 'string' ? o['job_id'] : undefined)); }));
  route('POST', '/api/market/asp/preview', guarded(async (_req, res) => json(res, 200, await agent().preview())));
};
