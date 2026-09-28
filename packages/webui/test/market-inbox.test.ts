import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FollowOverview, TraderSignal } from '../src/api/types';
import { adaptInbox, adaptSubscriptions } from '../src/api/market-adapt';

const mocks = vi.hoisted(() => ({ byKey: {} as Record<string, unknown> }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useQuery: (opts: { queryKey: string[] }) => ({ data: mocks.byKey[opts.queryKey.slice(0, 2).join('/')], isLoading: false, isError: false }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/api/client', () => ({ api: {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { InboxTab } from '../src/components/market/inbox';

const JOB = '0x4d6ac7795d339213d9836e57680c6fddde92b7ba218e955ef5a38c84c6302939';
const sig = (over: Partial<TraderSignal> = {}): TraderSignal => ({
  id: 's1', signal_id: 'sig-1', record_id: null, trader: 'svc', symbol: 'ETHUSDT', side: 'long', action: 'open', entry_kind: 'market', entry_prices: ['2739.52'], stop: '2690.19', tps: [{ price: '2787.83', pct: null } as TraderSignal['tps'][number]],
  size_pct: null, valid_until: null, published_at: Date.now() - 60_000, ingested_at: 0, raw_text: '【Futures】ETH-USDT-SWAP | LONG', ref_order: null, order_end_state: null, market_type: 'swap', transport: 'okx_asp', backfill: false, session: null,
  needs_reconcile: false, claim_id: null, claim_owner: null, claim_at: null, invalid_validity: false, status: 'evidence', mode_applied: 'evidence', thread_id: null, decision: null, created_at: 0, updated_at: 0,
  ...({ subscription_job_id: JOB } as object), ...over,
});
const overview = (pending: TraderSignal[] = []) => ({ pending_review: pending, pending_review_total: pending.length, pending_review_limit: 200, follow: { freshness_s: 180 }, scope: null }) as unknown as FollowOverview;
const render = (ov: FollowOverview = overview()) => renderToStaticMarkup(createElement(InboxTab, { overview: ov, jobFilter: 'all', onJobFilter: vi.fn(), onGoMarket: vi.fn() }));

beforeEach(() => {
  const now = Date.now();
  mocks.byKey = {
    'market/subscriptions': adaptSubscriptions({ subscriptions: [{ job_id: JOB, remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 1, title: 'tg · 自测服务', providerAgentId: '13866' } }], cache: { fetched_at: now } }),
    'market/inbox': adaptInbox({ deliveries: [
      { delivery_id: 'd1', job_id: JOB, received_at: now - 1000, parse_status: 'invalid', raw: '【微观结构告警 / Microstructure Alert】 ETH 清算放量 · OKX 永续 · 2026-09-25 12:16 UTC\nETH 近 15 分钟清算 $1.92M' },
      { delivery_id: 'd2', job_id: JOB, received_at: now - 2000, parse_status: 'order', signal_type: 'order', signal_id: 'sig-1', raw: '【Futures】ETH-USDT-SWAP | LONG' },
      { delivery_id: 'd3', job_id: '0xother', received_at: now - 3000, parse_status: 'invalid', raw: '📥 [Received] SecAgent#1791 → Trading Swarm#13866 (you)\nJob: 0x5c9d\n────────────\n「A task has been created」' },
    ] }),
    'follow/signals': { signals: [sig()] },
  };
});

describe('signals tab', () => {
  it('groups by subscription with one plain-language tag per row and no internal jargon', () => {
    const html = render();
    expect(html).toContain('自测服务');
    expect(html).toContain('告警');
    expect(html).toContain('交易信号');
    expect(html).toContain('ETH 清算放量 · OKX 永续');
    expect(html.match(/只记录,不下单/g)).toHaveLength(1);
    for (const jargon of ['只留证据', 'review_only', 'apply_failed', 'evidence', '— — —']) expect(html).not.toContain(jargon);
  });

  it('hides the to-do section when nothing is pending and shows it when something is', () => {
    expect(render()).not.toContain('待你处理');
    const html = render(overview([sig({ id: 's2', signal_id: 'sig-2', status: 'review_only', mode_applied: 'gated' })]));
    expect(html).toContain('待你处理');
    expect(html).toContain('等你决定是否下单');
    expect(html).toContain('按这条下单');
  });

  it('keeps platform notices and other jobs out of the timeline by default', () => {
    const html = render();
    expect(html).not.toContain('A task has been created');
    expect(html).toContain('显示不属于你订阅的消息(1)');
  });

  it('folds trade signals received by an intel / alert subscription into the merged history toggle', () => {
    mocks.byKey['market/subscriptions'] = adaptSubscriptions({ subscriptions: [{ job_id: JOB, remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 1, title: 'tg · 微观告警 自测' } }], cache: { fetched_at: Date.now() } });
    const html = render();
    expect(html).toContain('ETH 清算放量 · OKX 永续');
    expect(html).not.toContain('只记录,不下单');
    expect(html).not.toContain('显示不属于你订阅的消息(');
    expect(html).toContain('显示不属于你订阅或该服务类型的历史消息(2)');
    expect(html).toContain('1 条 · 最新在上');
  });

  it('labels the toggle by service type only when every hidden item is off-type', () => {
    mocks.byKey['market/subscriptions'] = adaptSubscriptions({ subscriptions: [{ job_id: JOB, remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 1, title: 'tg · 市场情报' } }], cache: { fetched_at: Date.now() } });
    const inbox = mocks.byKey['market/inbox'] as { rows: { job_id: string | null }[] };
    mocks.byKey['market/inbox'] = { ...inbox, rows: inbox.rows.filter((r) => r.job_id === JOB) };
    const html = render();
    expect(html).toContain('显示不属于该服务类型的历史消息(1)');
    expect(html).not.toContain('只记录,不下单');
  });

  it('explains the empty state', () => {
    mocks.byKey['market/inbox'] = adaptInbox({ deliveries: [] });
    mocks.byKey['follow/signals'] = { signals: [] };
    const html = render();
    expect(html).toContain('订阅后收到的内容会出现在这里');
    expect(html).toContain('去市场挑一个服务');
  });
});
