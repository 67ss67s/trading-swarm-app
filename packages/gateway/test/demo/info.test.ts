// info.ts: the information officer. parseRss / assetsInText are pure. validateMarketState lives in
// schema.ts but is the information officer's output contract. collectInfo/runInformationOfficer are
// exercised end-to-end against a local fake server (TG_DEMO_MARKET_BASE / TG_DEMO_FNG_URL set BEFORE
// dynamic-importing info.ts, since both are read as module-level `const`s). The two RSS sources are
// hard-coded to real hosts (coindesk/cointelegraph) — we don't touch src to make that configurable,
// so instead we stub the publicText transport to reject RSS hosts, deterministically reproducing
// "RSS unreachable" regardless of whether this sandbox actually has outbound internet.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as calendarFeed from '../../src/demo/calendar-feed.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import { validateMarketState } from '../../src/demo/schema.js';
import { stubBrain } from '../../src/demo/brain.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';
import type { Workflow } from '../../src/demo/types.js';

let server: FakeMarketServer;
let info: typeof import('../../src/demo/info.js');

beforeAll(async () => {
  server = await startFakeMarketServer();
  process.env['TG_DEMO_MARKET_BASE'] = server.url;
  process.env['TG_DEMO_FNG_URL'] = server.fngUrl;
  info = await import('../../src/demo/info.js');
});

afterAll(async () => {
  await server.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
  delete process.env['TG_DEMO_FNG_URL'];
});

/** Makes coindesk/cointelegraph fetches fail deterministically; everything else (our fake server,
 * which TG_DEMO_MARKET_BASE/TG_DEMO_FNG_URL already point at) passes through to the real fetch. */
function blockRssFetch(): () => void {
  const real = calendarFeed.publicText;
  const mocked = vi.spyOn(calendarFeed, 'publicText').mockImplementation(async (url, ...args) => {
    if (info.RSS_SOURCES.some((s) => new URL(url).host === new URL(s.url).host)) {
      throw new Error('simulated: rss unreachable in test sandbox');
    }
    return real(url, ...args);
  });
  return () => mocked.mockRestore();
}

function workflowWith(overrides: Partial<Workflow> = {}): Workflow {
  return { ...DEFAULT_WORKFLOW, updated_at: 0, ...overrides };
}

// ---------------------------------------------------------------- parseRss

function rssItem(opts: { title: string; link: string; description: string; pubDate: string }): string {
  const title = `<![CDATA[${opts.title}]]>`;
  return `<item><title>${title}</title><link>${opts.link}</link><description><![CDATA[${opts.description}]]></description><pubDate>${opts.pubDate}</pubDate></item>`;
}

describe('parseRss', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');

  it('parses CDATA titles, unescapes entities, and extracts assets from title+description', () => {
    const xml = `<rss><channel>${rssItem({
      title: 'Bitcoin Surges Past $100k &amp; ETF Inflows Accelerate',
      link: 'https://example.com/btc-100k',
      description: 'Bitcoin (BTC) rallied hard today.',
      pubDate: new Date(now - 2 * 3_600_000).toUTCString(),
    })}</channel></rss>`;
    const items = info.parseRss(xml, 'testsource', now);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Bitcoin Surges Past $100k & ETF Inflows Accelerate');
    expect(items[0]!.source).toBe('testsource');
    expect(items[0]!.kind).toBe('news');
    expect(items[0]!.assets).toContain('BTC');
  });

  it('drops items whose pubDate is older than 6 hours', () => {
    const xml = `<rss><channel>${rssItem({
      title: 'Stale story',
      link: 'https://example.com/old',
      description: 'old news',
      pubDate: new Date(now - 10 * 3_600_000).toUTCString(),
    })}</channel></rss>`;
    expect(info.parseRss(xml, 'testsource', now)).toEqual([]);
  });

  it('keeps items right at the edge (just under 6h) and drops items just over', () => {
    const fresh = rssItem({ title: 'fresh', link: 'https://example.com/fresh', description: 'd', pubDate: new Date(now - (6 * 3_600_000 - 60_000)).toUTCString() });
    const stale = rssItem({ title: 'stale', link: 'https://example.com/stale', description: 'd', pubDate: new Date(now - (6 * 3_600_000 + 60_000)).toUTCString() });
    const xml = `<rss><channel>${fresh}${stale}</channel></rss>`;
    const items = info.parseRss(xml, 'testsource', now);
    expect(items.map((i) => i.title)).toEqual(['fresh']);
  });

  it('extracts ETH from an item mentioning "ETH"', () => {
    const xml = `<rss><channel>${rssItem({
      title: 'ETH Upgrade Ships Successfully',
      link: 'https://example.com/eth-upgrade',
      description: "Ethereum's latest upgrade shipped without a hitch.",
      pubDate: new Date(now - 1 * 3_600_000).toUTCString(),
    })}</channel></rss>`;
    const items = info.parseRss(xml, 'testsource', now);
    expect(items[0]!.assets).toContain('ETH');
  });

  it('two items sharing the same link get the same dedupe_key (so a caller-side Set can dedupe them)', () => {
    const a = rssItem({ title: 'Wire pickup A', link: 'https://example.com/dup', description: 'first', pubDate: new Date(now - 3 * 3_600_000).toUTCString() });
    const b = rssItem({ title: 'Wire pickup B (same story, different title)', link: 'https://example.com/dup', description: 'second', pubDate: new Date(now - 3 * 3_600_000).toUTCString() });
    const xml = `<rss><channel>${a}${b}</channel></rss>`;
    const items = info.parseRss(xml, 'testsource', now);
    expect(items).toHaveLength(2);
    expect(items[0]!.dedupe_key).toBe(items[1]!.dedupe_key);
    expect(items[0]!.id).toBe(items[1]!.id);
  });

  it('items with different links get different dedupe_keys', () => {
    const a = rssItem({ title: 'A', link: 'https://example.com/a', description: 'd', pubDate: new Date(now - 1 * 3_600_000).toUTCString() });
    const b = rssItem({ title: 'B', link: 'https://example.com/b', description: 'd', pubDate: new Date(now - 1 * 3_600_000).toUTCString() });
    const items = info.parseRss(`<rss><channel>${a}${b}</channel></rss>`, 'testsource', now);
    expect(items[0]!.dedupe_key).not.toBe(items[1]!.dedupe_key);
  });

  it('skips items with no title or an unparsable pubDate', () => {
    const noTitle = '<item><link>https://example.com/x</link><description>d</description><pubDate>Wed, 15 Jan 2026 10:00:00 GMT</pubDate></item>';
    const badDate = '<item><title>ok</title><link>https://example.com/y</link><description>d</description><pubDate>not a date</pubDate></item>';
    const items = info.parseRss(`<rss><channel>${noTitle}${badDate}</channel></rss>`, 'testsource', now);
    expect(items).toEqual([]);
  });

  it('respects maxItems', () => {
    const items = Array.from({ length: 5 }, (_, i) => rssItem({ title: `item ${i}`, link: `https://example.com/${i}`, description: 'd', pubDate: new Date(now - 3_600_000).toUTCString() }));
    const parsed = info.parseRss(`<rss><channel>${items.join('')}</channel></rss>`, 'testsource', now, 3);
    expect(parsed).toHaveLength(3);
  });
});

// ---------------------------------------------------------------- assetsInText

describe('assetsInText', () => {
  it('extracts multiple known assets, case-insensitively, deduped', () => {
    expect(info.assetsInText('Bitcoin and ETH both rallied; BTC led the move')).toEqual(['BTC', 'ETH']);
  });

  it('returns an empty array when nothing recognizable is mentioned', () => {
    expect(info.assetsInText('macro data comes in hotter than expected')).toEqual([]);
  });

  it('does not match asset words that are substrings of other words', () => {
    // "solana" -> SOL is a real word match, but this checks a plain english sentence with no coin names.
    expect(info.assetsInText('the solar system has eight planets')).toEqual([]);
  });
});

// ---------------------------------------------------------------- validateMarketState

describe('validateMarketState', () => {
  const validRefs = new Set(['I1', 'I2']);
  const watchlist = ['BTCUSDT', 'ETHUSDT'];

  it('accepts a well-formed output', () => {
    const r = validateMarketState(
      {
        regime: 'trend_up',
        bias: 'long',
        summary: 'BTC 突破关键阻力,市场情绪偏多。',
        key_points: ['BTC 站上 EMA20 [I1]', '资金费率维持正值 [数据]'],
        news: [{ ref: 'I1', relevance: 'high', digest: '突发利好' }],
        candidates: [{ symbol: 'BTCUSDT', direction: 'long', why: '突破回踩确认' }],
        risk_events: [],
      },
      validRefs,
      watchlist,
    );
    expect(r.errors).toEqual([]);
    expect(r.value).not.toBeNull();
    expect(r.value!.regime).toBe('trend_up');
  });

  it('rejects an unknown regime', () => {
    const r = validateMarketState({ regime: 'sideways', bias: 'neutral', summary: 's', key_points: ['a', 'b'], news: [], candidates: [], risk_events: [] }, validRefs, watchlist);
    expect(r.value).toBeNull();
    expect(r.errors.some((e) => e.includes('regime must be one of'))).toBe(true);
  });

  it('rejects a news.ref that was not registered as an I<n>', () => {
    const r = validateMarketState({ regime: 'range', bias: 'neutral', summary: 's', key_points: ['a', 'b'], news: [{ ref: 'I99', relevance: 'high', digest: 'x' }], candidates: [], risk_events: [] }, validRefs, watchlist);
    expect(r.value).toBeNull();
    expect(r.errors.some((e) => e.includes('news.ref I99 is not a registered'))).toBe(true);
  });

  it('rejects a candidate symbol outside the watchlist', () => {
    const r = validateMarketState({ regime: 'range', bias: 'neutral', summary: 's', key_points: ['a', 'b'], news: [], candidates: [{ symbol: 'DOGEUSDT', direction: 'long', why: 'x' }], risk_events: [] }, validRefs, watchlist);
    expect(r.value).toBeNull();
    expect(r.errors.some((e) => e.includes('candidates.symbol DOGEUSDT is not in the watchlist'))).toBe(true);
  });

  it('rejects fewer than 2 key_points', () => {
    const r = validateMarketState({ regime: 'range', bias: 'neutral', summary: 's', key_points: ['only one'], news: [], candidates: [], risk_events: [] }, validRefs, watchlist);
    expect(r.value).toBeNull();
    expect(r.errors.some((e) => e.includes('key_points needs at least 2 items'))).toBe(true);
  });

  it('rejects a non-object payload', () => {
    const r = validateMarketState('not an object', validRefs, watchlist);
    expect(r.value).toBeNull();
    expect(r.errors).toEqual(['output must be a single JSON object']);
  });
});

// ---------------------------------------------------------------- collectInfo / runInformationOfficer

describe('collectInfo', () => {
  it('collects majors for the watchlist and FNG sentiment from the fake server, and records RSS failures without throwing', async () => {
    const restore = blockRssFetch();
    try {
      const workflow = workflowWith({ watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'] });
      const snap = await info.collectInfo(workflow, Date.now());
      expect(snap.majors).toHaveLength(4);
      const btc = snap.majors.find((m) => m.symbol === 'BTCUSDT')!;
      expect(btc.last).not.toBe('n/a');
      expect(btc.funding_rate).not.toBe('n/a');
      expect(snap.fng).toEqual({ value: 42, label: 'Fear' });
      expect(snap.errors.some((e) => e.startsWith('rss:coindesk'))).toBe(true);
      expect(snap.errors.some((e) => e.startsWith('rss:cointelegraph'))).toBe(true);
      expect(snap.news).toEqual([]); // both feeds failed, so no news events at all
    } finally {
      restore();
    }
  });

  it('top_movers excludes watchlist symbols and surfaces high-volume symbols outside it', async () => {
    const restore = blockRssFetch();
    try {
      const workflow = workflowWith({ watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'] });
      const snap = await info.collectInfo(workflow, Date.now());
      expect(snap.top_movers.length).toBeGreaterThan(0);
      for (const m of snap.top_movers) expect(workflow.watchlist).not.toContain(m.symbol);
      expect(snap.top_movers.some((m) => m.symbol === 'DOGEUSDT')).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('runInformationOfficer', () => {
  it('produces a valid MarketState via a stub brain that references no news, even though RSS collection failed', async () => {
    const restore = blockRssFetch();
    try {
      const workflow = workflowWith({ watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'] });
      const stub = stubBrain(() =>
        JSON.stringify({
          regime: 'trend_up',
          bias: 'long',
          summary: '市场情绪偏多,BTC 领涨大盘。',
          key_points: ['BTC 24h 上涨 [数据]', '资金费率维持正值 [数据]'],
          news: [],
          candidates: [],
          risk_events: [],
        }),
      );
      const logs: string[] = [];
      const { state, events } = await info.runInformationOfficer(stub, workflow, null, (level, msg) => logs.push(`${level}:${msg}`));
      expect(state.error).toBeNull();
      expect(state.regime).toBe('trend_up');
      expect(state.bias).toBe('long');
      expect(state.majors).toHaveLength(workflow.watchlist.length);
      expect(state.sentiment).toEqual({ fng: 42, fng_label: 'Fear' });
      expect(events).toEqual([]);
      expect(logs.some((l) => l.includes('信息员采集告警'))).toBe(true);
    } finally {
      restore();
    }
  });

  it('fails closed to regime "unclear" with a populated error when the brain never produces valid JSON', async () => {
    const restore = blockRssFetch();
    try {
      const workflow = workflowWith({ watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'] });
      const stub = stubBrain(() => 'not json at all, sorry');
      const { state } = await info.runInformationOfficer(stub, workflow, null, () => {});
      expect(state.regime).toBe('unclear');
      expect(state.error).not.toBeNull();
      expect(state.summary).toMatch(/模型总结失败/);
      expect(state.majors.length).toBeGreaterThan(0); // numeric section still populated even on model failure
    } finally {
      restore();
    }
  });
});

describe('news sources (v3.9: five defaults, per-source status, cross-source dedup)', () => {
  it('ships five default sources with stable names', () => {
    expect(info.RSS_SOURCES.map((s) => s.name)).toEqual(['coindesk', 'cointelegraph', 'decrypt', 'panews', 'fed']);
    for (const s of info.infoSourcesView()) expect(s).toMatchObject({ name: s.name, url: expect.stringMatching(/^https:\/\//) });
  });

  it('dedupes the same story across sources by normalized title, keeps distinct ones', () => {
    const now = Date.now();
    const mk = (title: string, link: string, source: string) => info.parseRss(`<rss><channel>${rssItem({ title, link, description: 'd', pubDate: new Date(now - 3_600_000).toUTCString() })}</channel></rss>`, source, now)[0]!;
    const a = mk('Bitcoin Breaks Above $80,000 As ETF Inflows Surge', 'https://a.example/1', 'coindesk');
    const b = mk('bitcoin breaks above $80,000 as ETF inflows surge', 'https://b.example/2', 'decrypt');
    const c = mk('Ethereum Foundation posts Q3 update', 'https://b.example/3', 'decrypt');
    const ka = info.newsDedupeKeys(a);
    const kb = info.newsDedupeKeys(b);
    const kc = info.newsDedupeKeys(c);
    expect(ka[0]).not.toBe(kb[0]);
    expect(ka[1]).toBe(kb[1]);
    expect(kc[1]).not.toBe(ka[1]);
  });

  it('honours a per-source max age (fed = 72h) while media stays at 6h', () => {
    const now = Date.now();
    const xml = `<rss><channel>${rssItem({ title: 'Fed statement', link: 'https://fed.example/1', description: 'd', pubDate: new Date(now - 30 * 3_600_000).toUTCString() })}</channel></rss>`;
    expect(info.parseRss(xml, 'fed', now)).toHaveLength(0);
    expect(info.parseRss(xml, 'fed', now, 10, 72 * 3_600_000)).toHaveLength(1);
    expect(info.infoSourcesView().find((s) => s.name === 'fed')!.max_age_hours).toBe(72);
    expect(info.infoSourcesView().find((s) => s.name === 'coindesk')!.max_age_hours).toBe(6);
  });

  it('records per-source error status when a feed is unreachable', async () => {
    const restore = blockRssFetch();
    try {
      await info.collectInfo({ ...(DEFAULT_WORKFLOW as Workflow), watchlist: [] });
    } finally {
      restore();
    }
    const view = info.infoSourcesView();
    expect(view).toHaveLength(5);
    for (const s of view) {
      expect(s.last_status).toBe('error');
      expect(typeof s.last_fetch_at).toBe('number');
      expect(s.last_error).toContain('simulated');
      expect(s.item_count).toBeNull();
      expect(s.used_count).toBeNull();
    }
    expect(info.sourceLabel('panews')).toBe('PANews');
    expect(info.sourceLabel('unknown-src')).toBe('unknown-src');
  });
});
