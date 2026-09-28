import { afterEach, describe, expect, it, vi } from 'vitest';
import { adaptInbox, adaptInboxStatus, adaptService, adaptSubscriptions, marketSubscriptionAction, resolveCatalogService, classifyDelivery } from '../src/api/market-adapt';

afterEach(() => vi.unstubAllGlobals());

describe('market subscription write outcome', () => {
  it.each(['cancel', 'reject', 'autorenew'] as const)('%s does not turn a failed follow-up GET into a failed write', async (action) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })).mockRejectedValue(new Error('GET unavailable'));
    vi.stubGlobal('fetch', fetch);
    await expect(marketSubscriptionAction('0xABC/123', action, action === 'reject' ? '质量不合格' : undefined)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/market/subscriptions/0xABC%2F123/${action}`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: action === 'reject' ? JSON.stringify({ reason: '质量不合格' }) : '{}' });
  });

  it('accepts 207 without retrying a successful action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true,"warning":"refresh failed"}', { status: 207 })));
    await expect(marketSubscriptionAction('job', 'cancel')).resolves.toEqual({ ok: true, warning: 'refresh failed' });
  });

  it('keeps both readable guidance and original platform errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: '提供方当前离线，请稍后重试', raw_message: 'provider not online (code 4021)' } }), { status: 409 })));
    const error = await marketSubscriptionAction('job', 'autorenew').catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('提供方当前离线');
    expect((error as Error).message).toContain('provider not online (code 4021)');
  });

  it('retains non-JSON response text and tells users to verify before retrying', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream timeout after submit', { status: 502 })));
    await expect(marketSubscriptionAction('job', 'cancel')).rejects.toThrow(/刷新订阅列表.*勿重复提交[\s\S]*upstream timeout after submit/);
  });

  it('does not invite retrying a write after the connection breaks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket closed after submission')));
    await expect(marketSubscriptionAction('job', 'cancel')).rejects.toThrow(/勿重复提交[\s\S]*socket closed after submission/);
  });

  it('treats an interrupted response body as an unknown write outcome', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockRejectedValue(new Error('response body interrupted')) }));
    await expect(marketSubscriptionAction('job', 'reject', '质量')).rejects.toThrow(/勿重复提交[\s\S]*response body interrupted/);
  });
});

const service = (sid: number, patch: Record<string, unknown> = {}) => adaptService({ serviceId: `service-${sid}`, sid, serviceName: `服务 ${sid}`, subscription: [{ interval: 'month', fee: '10' }], supportTrial: true, ...patch });

describe('catalog purchase resolution', () => {
  it('matches the selected numeric service ID even after a name change', () => {
    const selected = service(2, { serviceName: '新名称' });
    expect(resolveCatalogService([service(1), selected], { service_id: 2, name: '旧名称' }, true)).toBe(selected);
  });

  it('uses an exact name when the catalog has no service ID', () => {
    const selected = service(2);
    expect(resolveCatalogService([service(1), selected], { service_id: null, name: '服务 2' }, true)).toBe(selected);
  });

  it('does not silently switch to a same-name service with a different ID', () => {
    expect(() => resolveCatalogService([service(2, { serviceName: '同名服务' })], { service_id: 1, name: '同名服务' }, true)).toThrow(/变更|下架/);
  });

  it('rejects a removed service instead of choosing the first available service', () => {
    expect(() => resolveCatalogService([service(2)], { service_id: 1, name: '已删除' }, true)).toThrow(/变更|下架/);
  });

  it('does not switch from the selected unavailable trial to another trial or paid plan', () => {
    expect(() => resolveCatalogService([service(1, { supportTrial: false }), service(2)], { service_id: 1, name: '服务 1' }, true)).toThrow('不支持试用');
  });

  it('does not switch from an already subscribed selection to another service', () => {
    expect(() => resolveCatalogService([service(1, { isSubscribing: true }), service(2)], { service_id: 1, name: '服务 1' }, true)).toThrow('已订阅');
  });

  it('does not use a one-time plan for a monthly subscription', () => {
    expect(() => resolveCatalogService([service(1, { subscription: [{ interval: 'once', fee: '1' }] })], { service_id: 1, name: '服务 1' }, false)).toThrow(/变更|下架/);
  });
});

describe('subscription status adaptation', () => {
  it.each([[0, 'CREATED'], [1, 'ACTIVE'], [3, 'REJECTED'], [6, 'COMPLETED'], [7, 'CLOSED'], [8, 'EXPIRED'], [9, 'FAILED']])('maps numeric status %s to %s', (status, expected) => {
    expect(adaptSubscriptions({ subscriptions: [{ job_id: 'job', remote: { status } }] }).subscriptions[0]?.status_name).toBe(expected);
  });

  it('normalizes lowercase status names and string flags', () => {
    const sub = adaptSubscriptions({ subscriptions: [{ job_id: 'job', remote: { statusName: 'active', trialType: '1', autoRenew: 'false' } }] }).subscriptions[0];
    expect(sub).toMatchObject({ status_name: 'ACTIVE', trial_type: 1, auto_renew: false });
  });

  it('keeps string status values when statusName is omitted', () => {
    expect(adaptSubscriptions({ subscriptions: [{ job_id: 'job', remote: { status: 'active' } }] }).subscriptions[0]?.status_name).toBe('ACTIVE');
  });
});

describe('inbox status counters', () => {
  it('uses per-status counts: trade = order+expired, intel = analysis+report+intel+status+arbitrage, unreadable = invalid, failed = fetch_failed', () => {
    const s = adaptInboxStatus({ received: 133, dlq: 61, analysis: 1, counts: { order: 6, expired: 1, analysis: 1, report: 7, intel: 37, status: 3, arbitrage: 2, invalid: 4, fetch_failed: 2, system: 59, notice: 16, duplicate: 4, message: 1 } });
    expect(s).toMatchObject({ ledger_total: 133, ingested: 7, skipped_analysis: 50, bad_rows: 4, dlq_count: 2 });
  });
  it('old gateways without counts keep the legacy mapping', () => {
    expect(adaptInboxStatus({ received: 132, dlq: 61, analysis: 1 })).toMatchObject({ ingested: 70, skipped_analysis: 1, bad_rows: 61, dlq_count: 61 });
  });
  it('new non-executable parse statuses never render as unreadable rows', () => {
    const { rows } = adaptInbox({ deliveries: ['report', 'intel', 'status', 'message', 'arbitrage', 'notice', 'invalid'].map((parse_status, i) => ({ delivery_id: `d${i}`, parse_status, raw: 'x', errors: [] })) });
    expect(rows.map((r) => r.parse_status)).toEqual(['analysis', 'analysis', 'analysis', 'analysis', 'analysis', 'system', 'bad']);
  });
});

describe('classifyDelivery info-only type-header lines', () => {
  const base = { parse_status: null, signal_type: null, envelopeOnly: false, signal: null } as const;
  it('does not show Info only / Status only lines as trade signals', () => {
    expect(classifyDelivery({ ...base, content: '【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP | Market brief | BTC bullish | Info only, no order | Trading Swarm' })).toBe('intel');
    expect(classifyDelivery({ ...base, content: '【Futures】BTC-USDT-SWAP | Microstructure | BTC: $2.79M liquidated | Info only, no order | Trading Swarm' })).toBe('alert');
    expect(classifyDelivery({ ...base, content: '【Futures】BTC-USDT-SWAP | No active setup | Strategy 15m scanning | Status only, no order | Trading Swarm' })).toBe('intel');
    expect(classifyDelivery({ ...base, content: '【Futures】BTC-USDT-SWAP | LONG 3x | Market | Reference Price 64120 | Stop Loss 63400 | Valid for 4h' })).toBe('trade');
  });
});
