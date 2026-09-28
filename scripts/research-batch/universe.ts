/**
 * 批量研究资产池:OKX 现货 tickers → 24h 报价成交额前 60 → 各取近 90 个完整 UTC 日的日线,按 volCcyQuote 之和排名(research/batch/universe.ts 的 rankUniverse)。
 * 只读公共接口。结果写 ~/.trade-gate-okx/research-batch/universe.json。
 * 用法:HTTPS_PROXY=... node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/universe.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { configureOkxProxy } from '../../packages/gateway/src/demo/okx-proxy.ts';
import { rankUniverse, looksExcluded, type UniverseCandidate } from '../../packages/gateway/src/demo/research/batch/universe.ts';

configureOkxProxy();
const DIR = path.join(homedir(), '.trade-gate-okx', 'research-batch'), DAY = 86400000;
mkdirSync(DIR, { recursive: true });
const okx = async (p: string) => { for (let k = 1; ; k++) { const r = await fetch('https://www.okx.com' + p); const j = (await r.json()) as { code: string; msg: string; data: unknown }; if (j.code === '0') return j.data as Record<string, string>[] | string[][]; if (k >= 3) throw Error(`okx ${j.code} ${j.msg} ${p}`); await new Promise((s) => setTimeout(s, 1000 * k)); } };
const tickers = (await okx('/api/v5/market/tickers?instType=SPOT')) as Record<string, string>[];
const swaps = new Set(((await okx('/api/v5/public/instruments?instType=SWAP')) as Record<string, string>[]).filter((x) => x.settleCcy === 'USDT' && x.state === 'live').map((x) => x.instId.replace(/-USDT-SWAP$/, '')));
const usdt = tickers.filter((t) => t.instId.endsWith('-USDT')).map((t) => ({ base: t.instId.replace(/-USDT$/, ''), vol24: Number(t.volCcy24h) })).filter((t) => !looksExcluded(t.base)).sort((a, b) => b.vol24 - a.vol24).slice(0, 60);
const end = Math.floor(Date.now() / DAY) * DAY; // 今天 00:00 UTC,只算已完结的日
const cands: UniverseCandidate[] = [];
for (const t of usdt) {
  const rows = (await okx(`/api/v5/market/history-candles?instId=${t.base}-USDT&bar=1Dutc&limit=100`)) as string[][];
  const days = rows.filter((r) => Number(r[0]) >= end - 90 * DAY && Number(r[0]) < end && r[8] === '1');
  cands.push({ base: t.base, quote_volume_90d: days.reduce((a, r) => a + Number(r[7]), 0), days: days.length, has_swap: swaps.has(t.base), volume_24h: t.vol24 });
  await new Promise((s) => setTimeout(s, 120));
}
const ranked = rankUniverse(cands, { size: 20 });
const out = { generated_at: new Date().toISOString(), window: { from: new Date(end - 90 * DAY).toISOString(), to: new Date(end).toISOString() }, basis: 'OKX 现货 USDT 当前在售,近 90 个完整 UTC 日 volCcyQuote 之和;排除稳定币/包装币,要求 USDT 永续在售', ...ranked, candidates: cands };
writeFileSync(path.join(DIR, 'universe.json'), JSON.stringify(out, null, 1));
for (const m of ranked.members) console.log(m.rank, m.symbol, (m.quote_volume_90d / 1e9).toFixed(2) + 'B', m.days);
console.log('dropped', ranked.dropped.map((d) => `${d.base}:${d.reason}`).join(' '));
