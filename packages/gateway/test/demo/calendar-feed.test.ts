import audit from '../fixtures/calendar-verification-0912.json' with { type: 'json' };
import { CALENDAR_2026, CALENDAR_LAST_VERIFIED_AT } from '../../src/demo/events-calendar.js';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  easternTime, fetchCalendar, macroKind, parseBlsCalendar, parseFedCalendar,
  parseForex, publicText, reconcileCalendar, type CalendarFact,
} from '../../src/demo/calendar-feed.js';

const forex = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const bls = 'https://www.bls.gov/schedule/news_release/bls.ics';
const now = Date.parse('2026-09-12T00:00:00Z');
function fact(patch: Partial<CalendarFact> = {}): CalendarFact {
  return { subkind: 'cpi', title: 'CPI m/m', expected_at: Date.parse('2026-09-15T12:30:00Z'), source_ref: forex, consensus: '0.2%', previous: '0.3%', importance: 'high', ...patch };
}
function ics(start: string, summary = 'Consumer Price Index'): string {
  return `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART${start}\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
}

afterEach(() => vi.unstubAllEnvs());

describe('calendar deterministic parsers', () => {
  it('recognizes all requested headline indicators and excludes core series', () => {
    expect(['FOMC Statement', 'CPI m/m', 'PPI m/m', 'Non-Farm Employment Change', 'PCE Price Index', 'Advance GDP q/q', 'Unemployment Claims', 'Retail Sales m/m'].map(macroKind))
      .toEqual(['fomc', 'cpi', 'ppi', 'nfp', 'pce', 'gdp', 'claims', 'retail']);
    expect(macroKind('Core CPI m/m')).toBeNull();
  });
  it('keeps decimal display values, importance and offset dates, filtering other countries', () => {
    const row = { title: 'CPI m/m', country: 'USD', date: '2026-09-15T08:30:00-04:00', forecast: '0.2%', previous: '0.3%', impact: 'High' };
    const result = parseForex(JSON.stringify([row, { ...row, country: 'EUR' }, { ...row, date: 'bad' }, { ...row, title: 'Core CPI' }]), forex);
    expect(result).toEqual([fact({ metric: 'mom_pct_sa' })]);
  });
  it('rejects a non-array forex payload', () => {
    expect(() => parseForex('{}', forex)).toThrow('calendar must be array');
  });
  it('converts Eastern scheduled release hours across DST', () => {
    expect(new Date(easternTime(2026, 9, 15, 8, 30)).toISOString()).toBe('2026-09-15T12:30:00.000Z');
    expect(new Date(easternTime(2026, 11, 10, 8, 30)).toISOString()).toBe('2026-11-10T13:30:00.000Z');
    expect(new Date(easternTime(2026, 3, 8, 8, 30)).toISOString()).toBe('2026-03-08T12:30:00.000Z');
    expect(new Date(easternTime(2026, 11, 1, 8, 30)).toISOString()).toBe('2026-11-01T13:30:00.000Z');
  });
  it('parses BLS UTC and TZID dates with folded ICS summaries', () => {
    expect(parseBlsCalendar(ics(';TZID=America/New_York:20261110T083000', 'Consumer Price\r\n Index'), bls)[0]).toMatchObject({ subkind: 'cpi', expected_at: Date.parse('2026-11-10T13:30:00Z') });
    expect(parseBlsCalendar(ics(':20260915T123000Z', 'Producer Price Index'), bls)[0]).toMatchObject({ subkind: 'ppi', expected_at: Date.parse('2026-09-15T12:30:00Z') });
    expect(parseBlsCalendar(ics(':20260915T123000Z', 'Unrecognized'), bls)).toEqual([]);
  });
  it('parses Fed decision on final meeting day with winter UTC offset', () => {
    const html = '<h4>2026 FOMC Meetings</h4><div class="fomc-meeting__month"><strong>September</strong></div><div class="fomc-meeting__date">15-16*</div><div class="fomc-meeting__month"><strong>December</strong></div><div class="fomc-meeting__date">8-9</div>';
    expect(parseFedCalendar(html, 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm').map(r => new Date(r.expected_at).toISOString()))
      .toEqual(['2026-09-16T18:00:00.000Z', '2026-12-09T19:00:00.000Z']);
  });
});

describe('calendar reconciliation and graceful fallback', () => {
  it('requires independent domains to confirm; duplicate feed paths remain reported', () => {
    expect(reconcileCalendar([fact(), fact({ source_ref: forex.replace('thisweek', 'nextweek') })], now)[0]?.calendar_status).toBe('reported');
    const result = reconcileCalendar([fact(), fact({ source_ref: bls, consensus: null, previous: null })], now)[0]!;
    expect(result).toMatchObject({ calendar_status: 'confirmed', source_ref: bls, consensus: '0.2%', previous: '0.3%', verified_at: now, fallback: false });
    expect(result.observations).toHaveLength(2);
  });
  it('retains conflicting clocks while preferring the official time', () => {
    const official = fact({ source_ref: bls, expected_at: Date.parse('2026-09-16T12:30:00Z') });
    const result = reconcileCalendar([fact(), official], now)[0]!;
    expect(result).toMatchObject({ calendar_status: 'conflict', expected_at: official.expected_at });
    expect(result.observations).toHaveLength(2);
  });
  it('all sources failing returns static reported fallback and warnings', async () => {
    const result = await fetchCalendar(now, async () => { throw new Error('offline'); });
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every(r => r.fallback && r.calendar_status === 'reported')).toBe(true);
    expect(result.warnings.filter(w => w.includes('offline'))).toHaveLength(4);
    expect(result.warnings.some(w => w.startsWith('calendar_fallback:'))).toBe(true);
  });
  it('keeps working source rows when another source has malformed data', async () => {
    const result = await fetchCalendar(now, async (url) => url.endsWith('.ics') ? ics(':20260915T123000Z') : 'malformed');
    expect(result.entries.find(e => e.subkind === 'cpi')).toMatchObject({ fallback: false, calendar_status: 'reported' });
    expect(result.warnings.filter(w => w.startsWith('calendar_source:'))).toHaveLength(3);
  });
});

describe('public fetch transport', () => {
  it('rejects credentials and non-HTTP protocols', async () => {
    await expect(publicText('file:///etc/passwd')).rejects.toThrow('invalid public URL');
    await expect(publicText('https://user:pass@example.com')).rejects.toThrow('invalid public URL');
  });
  it('bypasses env proxies for loopback and enforces response size without Content-Length', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/large') { res.write('x'.repeat(100)); res.end('x'.repeat(100)); }
      else res.end('local-calendar');
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
      vi.stubEnv('http_proxy', 'http://127.0.0.1:1');
      vi.stubEnv('NO_PROXY', ''); vi.stubEnv('no_proxy', '');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing server address');
      const url = `http://127.0.0.1:${address.port}`;
      await expect(publicText(url, 1000)).resolves.toBe('local-calendar');
      await expect(publicText(`${url}/large`, 1000, 50)).rejects.toThrow(/exceeds|fetch failed/);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});


it('official clock corroborates m/m and y/y separately without changing their metrics or forecasts', () => {
  const rows = reconcileCalendar([
    fact({ metric: 'mom_pct_sa', title: 'CPI m/m', consensus: '0.2%' }),
    fact({ metric: 'yoy_pct', title: 'CPI y/y', consensus: '2.5%', previous: '2.4%' }),
    fact({ source_ref: bls, title: 'Consumer Price Index', consensus: null, previous: null }),
  ], now);
  expect(rows).toHaveLength(2);
  expect(rows.find(r => r.metric === 'mom_pct_sa')).toMatchObject({ title: 'CPI m/m', consensus: '0.2%', calendar_status: 'confirmed' });
  expect(rows.find(r => r.metric === 'yoy_pct')).toMatchObject({ title: 'CPI y/y', consensus: '2.5%', previous: '2.4%', calendar_status: 'confirmed' });
});


it('all static fallback dates agree with both recorded official publications, including October CPI', () => {
  expect(CALENDAR_LAST_VERIFIED_AT).toBe(Date.parse(audit.verified_at));
  expect(CALENDAR_2026).toHaveLength(audit.rows.length);
  for (const entry of CALENDAR_2026) {
    const row = audit.rows.find(r => r.title === entry.title)!;
    expect(row.source_a.utc).toBe(row.source_b.utc);
    expect(entry.expected_at).toBe(Date.parse(row.source_a.utc));
  }
});
