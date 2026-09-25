/**
 * 按时点资产池取数(横截面动量去幸存者偏差,2026-09-23 晚):币安现货全部 USDT 交易对的日线,**含已下架币**。
 *  - 来源:data.binance.vision 月度归档 data/spot/monthly/klines/<SYM>/1d/(S3 列目录拿到确切文件清单,不盲探 404);
 *    归档里最后一个月之后到 TO_MS 的日线用 data-api.binance.vision/api/v3/klines 补(只对仍有最近月份数据的交易对)。
 *    两者都是静态 CDN / 公共行情镜像,不占主站 API 权重;本机走 Clash 代理。
 *  - 2025-01 起现货归档的时间戳是微秒,统一折成毫秒。
 *  - 冻结到 ~/.trading-swarm-okx/research-batch/pit/<SYM>.json:{ symbol, bars:[open_time, open, high, low, close, quote_volume][] },已有文件跳过(可断点续跑)。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/pit-fetch.ts [--concurrency 12]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configureOkxProxy } from '../../packages/gateway/src/demo/okx-proxy.ts';
import { readZipText } from '../../packages/gateway/src/demo/research/data/zip.ts';
import { BATCH_DIR, TO_MS } from './common.ts';

configureOkxProxy();
export const PIT_DIR = path.join(BATCH_DIR, 'pit');
mkdirSync(PIT_DIR, { recursive: true });
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const CONC = Number(arg('--concurrency') ?? 12);
const S3 = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision', CDN = 'https://data.binance.vision', API = 'https://data-api.binance.vision';
const t0 = Date.now(), log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`);

async function get(url: string, kind: 'text' | 'bytes'): Promise<string | Buffer | null> {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;
      if (!r.ok) throw Error(`HTTP ${r.status}`);
      return kind === 'text' ? await r.text() : Buffer.from(await r.arrayBuffer());
    } catch (e) { if (k >= 4) throw Error(`${url}: ${(e as Error).message}`); await new Promise((s) => setTimeout(s, 1500 * k)); }
  }
}
/** S3 列目录(自动翻页):返回 CommonPrefixes 或 Keys */
async function list(prefix: string, what: 'prefixes' | 'keys'): Promise<string[]> {
  const out: string[] = []; let marker = '';
  for (;;) {
    const xml = (await get(`${S3}?delimiter=/&prefix=${encodeURIComponent(prefix)}${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`, 'text')) as string;
    const re = what === 'prefixes' ? /<Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g : /<Key>([^<]+)<\/Key>/g;
    for (const m of xml.matchAll(re)) out.push(m[1]!);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return out;
    marker = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] ?? out.at(-1)!;
  }
}
type Row = [number, number, number, number, number, number];
const ms = (t: number) => (t > 1e14 ? Math.floor(t / 1000) : t);
function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(','); if (c.length < 8 || !/^\d+$/.test(c[0]!)) continue; // 跳过表头
    rows.push([ms(Number(c[0])), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[7])]);
  }
  return rows;
}
async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0; await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; await fn(items[i]!, i); } }));
}

const syms = (await list('data/spot/monthly/klines/', 'prefixes')).map((p) => p.split('/').at(-2)!).filter((s) => s.endsWith('USDT') && s.length > 4);
log(`归档里 USDT 交易对 ${syms.length} 个`);
const lastMonth = new Date(TO_MS); const recentKey = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth()).padStart(2, '0')}`; // 上个月(月份 0 起算即上月)
let done = 0, bars = 0, failed: string[] = [];
await pool(syms, CONC, async (sym) => {
  const file = path.join(PIT_DIR, `${sym}.json`);
  if (existsSync(file)) { done++; return; }
  try {
    const keys = (await list(`data/spot/monthly/klines/${sym}/1d/`, 'keys')).filter((k) => k.endsWith('.zip'));
    const rows: Row[] = [];
    for (const k of keys) { const z = (await get(`${CDN}/${k}`, 'bytes')) as Buffer | null; if (z) rows.push(...parseCsv(readZipText(z).text)); }
    rows.sort((a, b) => a[0] - b[0]);
    // 归档末月之后补到 TO_MS(只对最近月份仍有归档的交易对,即至今在售的)
    const lastKey = keys.map((k) => /-(\d{4}-\d{2})\.zip$/.exec(k)?.[1] ?? '').sort().at(-1) ?? '';
    let tail = 0;
    if (lastKey >= recentKey && rows.length) {
      let from = rows.at(-1)![0] + 86400000;
      while (from + 86400000 - 1 <= TO_MS) {
        const txt = (await get(`${API}/api/v3/klines?symbol=${sym}&interval=1d&startTime=${from}&endTime=${TO_MS}&limit=1000`, 'text')) as string | null;
        const arr = txt ? (JSON.parse(txt) as (string | number)[][]) : [];
        const add = arr.map((c) => [ms(Number(c[0])), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[7])] as Row).filter((r) => r[0] + 86400000 - 1 <= TO_MS);
        if (!add.length) break; rows.push(...add); tail += add.length; from = add.at(-1)![0] + 86400000;
      }
    }
    const dedup = rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1]![0]).filter((r) => r[0] + 86400000 - 1 <= TO_MS);
    writeFileSync(file, JSON.stringify({ symbol: sym, source: `binance-spot:data.binance.vision monthly 1d${tail ? ` + data-api klines ${tail} 根` : ''}`, months: keys.length, bars: dedup }));
    bars += dedup.length;
  } catch (e) { failed.push(sym); log(`${sym} 失败 ${(e as Error).message.slice(0, 200)}`); }
  if (++done % 50 === 0) log(`${done}/${syms.length} 累计 ${bars} 根`);
});
log(`完成 ${done}/${syms.length},失败 ${failed.length}${failed.length ? ':' + failed.join(' ') : ''} → ${PIT_DIR}`);
