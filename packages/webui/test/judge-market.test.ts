/**
 * 评审版信号市场(OKX.AI 只读快照):适配层把 `snapshot` 带过来、横幅文案、状态灯 / 身份 / CacheNote 的友好化。
 * edition 在 import 时就定了(import.meta.env.VITE_EDITION),所以评审版行为都用带 edition 参数的纯函数测。
 */
import { describe, expect, it } from 'vitest';
import { adaptAsp, adaptInbox, adaptSearch, adaptSettings, adaptStatus, adaptSubscriptions, pickSnapshotAsOf, snapshotOf } from '../src/api/market-adapt';
import { adaptProducts } from '../src/api/asp-products';
import { JUDGE_NOT_CONNECTED, identityState, judgeCacheNoteText, judgeLightDetail, listingLabel, snapshotAsOfMs, snapshotBannerText } from '../src/components/market/judge';
import { FRIENDLY_TECH_ERROR, OKX_AI_LISTING_ID } from '../src/lib/edition';

const SNAP = { as_of: 1_790_000_000_000, source: 'okx.ai live ASP (read-only snapshot)' };
const settings = adaptSettings({});

describe('adapters carry snapshot', () => {
  it('status / subscriptions / asp / search / inbox / products keep snapshot when present', () => {
    expect((adaptStatus({ snapshot: SNAP }, settings) as { snapshot?: unknown }).snapshot).toEqual(SNAP);
    expect(adaptSubscriptions({ snapshot: SNAP, subscriptions: [] }).snapshot).toEqual(SNAP);
    expect((adaptAsp({ snapshot: SNAP }, settings.publisher, []) as { snapshot?: unknown }).snapshot).toEqual(SNAP);
    expect(adaptSearch({ snapshot: { as_of: '2026-09-26T08:00:00Z' } }).snapshot).toEqual({ as_of: '2026-09-26T08:00:00Z', source: null });
    expect(adaptInbox({ snapshot: SNAP, deliveries: [] }).snapshot).toEqual(SNAP);
    expect(adaptProducts({ snapshot: SNAP, products: [] }).snapshot).toEqual(SNAP);
  });

  it('no snapshot field → no key at all (default edition views unchanged)', () => {
    expect('snapshot' in adaptStatus({}, settings)).toBe(false);
    expect('snapshot' in adaptSubscriptions({ subscriptions: [] })).toBe(false);
    expect('snapshot' in adaptProducts({})).toBe(false);
    expect(snapshotOf({ snapshot: 'x' })).toEqual({});
    expect(snapshotOf(null)).toEqual({});
  });

  it('pickSnapshotAsOf takes the first response that has as_of', () => {
    expect(pickSnapshotAsOf(null, { snapshot: { source: 's' } }, { snapshot: SNAP })).toBe(SNAP.as_of);
    expect(pickSnapshotAsOf(undefined, {})).toBeNull();
  });
});

describe('snapshot banner', () => {
  it('parses ms / seconds / ISO / numeric string', () => {
    expect(snapshotAsOfMs(1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(snapshotAsOfMs(1_790_000_000)).toBe(1_790_000_000_000);
    expect(snapshotAsOfMs('1790000000000')).toBe(1_790_000_000_000);
    expect(snapshotAsOfMs('2026-09-26T08:00:00Z')).toBe(Date.parse('2026-09-26T08:00:00Z'));
    expect(snapshotAsOfMs(null)).toBeNull();
    expect(snapshotAsOfMs('nope')).toBeNull();
  });

  it('judge shows text with / without as-of; default renders nothing', () => {
    const withTime = snapshotBannerText('9/26/2026, 08:00', 'judge')!;
    expect(withTime).toContain("read-only snapshot of Trading Swarm's live ASP on OKX.AI");
    expect(withTime).toContain('as of 9/26/2026, 08:00.');
    expect(withTime).toContain('nothing here can be changed');
    expect(snapshotBannerText(null, 'judge')).not.toContain('as of');
    expect(snapshotBannerText('x', 'default')).toBeNull();
    expect(listingLabel()).toBe(`OKX.AI #${OKX_AI_LISTING_ID}`);
  });
});

describe('friendly status', () => {
  it('lights: judge turns any off light into a neutral note, default untouched', () => {
    expect(judgeLightDetail(false, '守护没跑(okx-a2a daemon 未启动)', 'judge')).toBe(JUDGE_NOT_CONNECTED);
    expect(judgeLightDetail(false, '请使用本页表单连接 OKX 账户', 'judge')).toBe(JUDGE_NOT_CONNECTED);
    expect(judgeLightDetail(true, 'spawn onchainos ENOENT', 'judge')).toBe(JUDGE_NOT_CONNECTED);
    expect(judgeLightDetail(true, 'v1.2 ok', 'judge')).toBe('v1.2 ok');
    expect(judgeLightDetail(false, 'spawn onchainos ENOENT', 'default')).toBe('spawn onchainos ENOENT');
  });

  it('identity: judge never spins forever, default keeps loading / none', () => {
    const loading = { fetched_at: null, stale: false, refreshing: true, state: 'loading' as const, error: null };
    const failed = { ...loading, refreshing: false, state: 'error' as const, error: 'spawn onchainos ENOENT' };
    expect(identityState(null, loading, 'default')).toBe('loading');
    expect(identityState(null, undefined, 'default')).toBe('none');
    expect(identityState(null, loading, 'judge')).toBe('unknown');
    expect(identityState(null, failed, 'judge')).toBe('unknown');
    expect(identityState(null, undefined, 'judge')).toBe('none');
    expect(identityState({ agent_id: '1' }, loading, 'judge')).toBe('loaded');
  });

  it('cache note: snapshot time first, else fetched_at, never the error', () => {
    const fmt = (ms: number) => `T${ms}`;
    expect(judgeCacheNoteText({ fetched_at: 5 }, 1_790_000_000_000, fmt)).toBe('Snapshot as of T1790000000000');
    expect(judgeCacheNoteText({ fetched_at: 5 }, undefined, fmt)).toBe('Snapshot as of T5');
    expect(judgeCacheNoteText({ fetched_at: null }, null, fmt)).toBeNull();
    expect(judgeCacheNoteText(undefined, undefined, fmt)).toBeNull();
  });

  it('FRIENDLY_TECH_ERROR is plain English', () => {
    expect(FRIENDLY_TECH_ERROR).not.toMatch(/ENOENT|spawn/);
  });
});
