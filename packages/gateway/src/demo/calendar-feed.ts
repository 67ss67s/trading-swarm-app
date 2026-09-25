/** 确定性公共日历采集。curl 继承 env 代理；不执行 shell，不自动跟随重定向。 */
import { spawn } from 'node:child_process';
import { CALENDAR_2026 } from './events-calendar.js';
export type MacroKind = 'fomc' | 'cpi' | 'ppi' | 'nfp' | 'pce' | 'gdp' | 'claims' | 'retail';
export interface CalendarFact {
  metric?: string;
  subkind: MacroKind; title: string; expected_at: number; source_ref: string;
  consensus: string | null; previous: string | null; importance: 'high' | 'medium' | 'low';
}
export interface CalendarObservation extends CalendarFact {
  calendar_status: 'confirmed' | 'reported' | 'conflict';
  forecast_verified_at?: number;
  observations: CalendarFact[]; verified_at: number; fallback: boolean;
}
export function publicText(url: string, timeoutMs = 15000, maxBytes = 200 * 1024): Promise<string> {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return Promise.reject(new Error('invalid public URL'));
  return new Promise((resolve, reject) => {
    const noProxy = [process.env['NO_PROXY'], process.env['no_proxy'], 'localhost,127.0.0.1,::1'].filter(Boolean).join(',');
    const child = spawn('curl', ['--silent', '--show-error', '--fail', '--max-time', String(timeoutMs / 1000), '--max-filesize', String(maxBytes), '--proto', '=http,https', '--user-agent', 'trading-swarm-research/1.0', url], { env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy, https_proxy: process.env['HTTPS_PROXY'] ?? process.env['https_proxy'], http_proxy: process.env['HTTP_PROXY'] ?? process.env['http_proxy'] }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('fetch timeout')); }, timeoutMs + 1000);
    child.stdout.on('data', (b: Buffer) => { bytes += b.length; if (bytes > maxBytes) { child.kill(); reject(new Error('body exceeds 200KB limit')); } else chunks.push(b); });
    child.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(0, 500); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`public fetch failed (${code}): ${err}`)); });
  });
}
export function macroKind(title: string): MacroKind | null {
  if (/core/i.test(title)) return null;
  if (/federal funds rate|fomc statement|interest rate decision/i.test(title)) return 'fomc';
  if (/cpi|consumer price/i.test(title)) return 'cpi';
  if (/ppi|producer price/i.test(title)) return 'ppi';
  if (/non.?farm employment|employment situation/i.test(title)) return 'nfp';
  if (/pce|personal income and outlays/i.test(title)) return 'pce';
  if (/gdp|gross domestic product/i.test(title)) return 'gdp';
  if (/unemployment claims|initial claims/i.test(title)) return 'claims';
  if (/retail sales/i.test(title)) return 'retail';
  return null;
}
export function parseForex(body: string, source_ref: string): CalendarFact[] {
  const rows: unknown = JSON.parse(body); if (!Array.isArray(rows)) throw new Error('calendar must be array');
  return rows.flatMap((r: Record<string, unknown>) => {
    const title = String(r['title'] ?? ''); const subkind = macroKind(title); const at = Date.parse(String(r['date']));
    if (r['country'] !== 'USD' || !subkind || !Number.isFinite(at)) return [];
    return [{ subkind, metric: /m\/m/i.test(title) ? 'mom_pct_sa' : /y\/y/i.test(title) ? 'yoy_pct' : subkind === 'nfp' ? 'payroll_change_thousands' : subkind === 'fomc' ? 'target_upper_pct' : 'index_level', title, expected_at: at, source_ref, consensus: typeof r['forecast'] === 'string' && r['forecast'] ? r['forecast'] : null, previous: typeof r['previous'] === 'string' && r['previous'] ? r['previous'] : null, importance: r['impact'] === 'High' ? 'high' as const : r['impact'] === 'Medium' ? 'medium' as const : 'low' as const }];
  });
}
/** BLS iCalendar 官方日程；DTSTART 带 TZID 时用美国东部 DST 转 UTC。 */
export function easternTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  const approximate = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).formatToParts(approximate);
  const easternHour = Number(parts.find(p => p.type === 'hour')!.value);
  const offset = ((hour - easternHour) + 24) % 24;
  return approximate + offset * 3600000;
}
export function parseBlsCalendar(body: string, source_ref: string): CalendarFact[] {
  return (body.replace(/\r?\n[ \t]/g, '').match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? []).flatMap(block => {
    const title = /SUMMARY:(.*)/.exec(block)?.[1]?.trim() ?? '';
    const subkind = macroKind(title); const match = /DTSTART([^:]*):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/.exec(block);
    if (!subkind || !match) return [];
    const [y, m, d, h, min] = match.slice(2, 7).map(Number);
    const expected_at = match[8] === 'Z' ? Date.UTC(y!, m! - 1, d!, h!, min!) : easternTime(y!, m!, d!, h!, min!);
    return [{ subkind, title, expected_at, source_ref, consensus: null, previous: null, importance: 'high' as const }];
  });
}
export function parseFedCalendar(body: string, source_ref: string): CalendarFact[] {
  const out: CalendarFact[] = [];
  body = body.replace(/<h4[^>]*>\s*<a[^>]*>/gi, '<h4>');
  for (const section of body.split(/(?=<h4[^>]*>\s*\d{4}\s+FOMC)/i)) {
    const year = Number(/<h4[^>]*>\s*(\d{4})\s+FOMC/i.exec(section)?.[1]); if (!year) continue;
    for (const match of section.matchAll(/fomc-meeting__month[^>]*>[\s\S]*?<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)/g)) {
      const month = new Date(`${match[1]!.split('/').pop()} 1, ${year}`).getMonth() + 1;
      const day = Number(match[2]!.match(/\d+/g)?.pop()); if (!month || !day) continue;
      out.push({ subkind: 'fomc', title: 'FOMC 利率决议', expected_at: easternTime(year, month, day, 14), source_ref, consensus: null, previous: null, importance: 'high' });
    }
  }
  return out;
}
export const CALENDAR_SOURCES = [
  { url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json', parse: parseForex },
  { url: 'https://nfs.faireconomy.media/ff_calendar_nextweek.json', parse: parseForex },
  { url: 'https://www.bls.gov/schedule/news_release/bls.ics', parse: parseBlsCalendar },
  { url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', parse: parseFedCalendar },
];
export function reconcileCalendar(facts: CalendarFact[], now: number): CalendarObservation[] {
  const groups = new Map<string, CalendarFact[]>();
  for (const f of facts) {
    // 同一指标同一周核对，保留冲突时刻；不把同源的两种数值口径当独立佐证。
    const key = `${f.subkind}:${Math.floor((f.expected_at + 3 * 86400000) / (7 * 86400000))}`;
    const rows = groups.get(key) ?? []; rows.push(f); groups.set(key, rows);
  }
  return [...groups.values()].flatMap(rows => {
    const metrics = [...new Set(rows.map(r => r.metric).filter((m): m is string => !!m))];
    return (metrics.length ? metrics : [undefined]).map(metric => {
      const matching = rows.filter(r => !r.metric || r.metric === metric);
      const first = matching.find(r => new URL(r.source_ref).hostname.endsWith('.gov')) ?? matching[0]!;
      const economic = matching.find(r => r.metric === metric && (r.consensus || r.previous)) ?? matching[0]!;
      const dates = new Set(matching.map(r => r.expected_at));
      const domains = new Set(matching.map(r => new URL(r.source_ref).hostname));
      return { ...first, metric, title: economic.title, consensus: economic.consensus, previous: economic.previous, calendar_status: dates.size > 1 ? 'conflict' as const : domains.size > 1 ? 'confirmed' as const : 'reported' as const, observations: matching, verified_at: now, fallback: false };
    });
  });
}
export async function fetchCalendar(now = Date.now(), fetchText = publicText): Promise<{ entries: CalendarObservation[]; warnings: string[] }> {
  const warnings: string[] = []; const facts: CalendarFact[] = [];
  for (const src of CALENDAR_SOURCES) {
    try { const parsed = src.parse(await fetchText(src.url), src.url); if (!parsed.length) throw new Error('no recognized events'); facts.push(...parsed); }
    catch (e) { warnings.push(`calendar_source: ${src.url}: ${(e as Error).message}`); }
  }
  let entries = reconcileCalendar(facts, now).filter(e => e.expected_at >= now - 86400000 && e.expected_at <= now + 30 * 86400000);
  for (const e of entries) if (e.calendar_status === 'conflict') warnings.push(`calendar_conflict: ${e.subkind}: ${e.observations.map(o => new Date(o.expected_at).toISOString()).join(', ')}`);
  const fallback = CALENDAR_2026.filter(e => e.expected_at >= now && e.expected_at <= now + 30 * 86400000 && !entries.some(x => x.subkind === e.subkind && Math.abs(x.expected_at - e.expected_at) < 7 * 86400000));
  if (fallback.length) warnings.push('calendar_fallback: 部分日程仅有静态兜底，尚未核实');
  entries = [...entries, ...fallback.map(e => ({ ...e, consensus: null, previous: null, importance: 'high' as const, calendar_status: 'reported' as const, observations: [], verified_at: now, fallback: true }))];
  return { entries: entries.sort((a, b) => a.expected_at - b.expected_at), warnings };
}
