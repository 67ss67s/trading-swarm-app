#!/usr/bin/env node
// 评审版英文出口的只读爬虫 + 回放统计(一次性工具,不进网关运行时)。
//
//   node scripts/judge-en-crawl.mjs crawl <dir> [base]      从线上列表接口展开详情 id(接口以 webui/src/api 为准),逐个只读 GET,响应存进 <dir>
//   npm run build && TG_PUBLIC_DEMO=1 TG_PUBLIC_LANG=en TG_PUBLIC_STRATEGY_EN=../../deploy/judge-seed/en-strategy-names.json \
//     node scripts/judge-en-crawl.mjs tally <dir> [summary|detail]
//       before = 线上原样,after = 过本地 dist 的出口英文层(OKX.AI 快照路径走 englishDeep,其余走 publicView);按「接口模板 + 字段路径」计中文条数
//
// 外部内容不计:新闻标题/摘要(info/events、market-state news、market-events 的 kind=news 标题、<untrusted_data> 包着的证据原文)及引号里的这些原文;OKX.AI 目录(/api/market/catalog);
// 第三方 ASP 名与服务名(asp.name / remote.title / signal.trader,含本地加了「trade-gate ·」前缀的订阅标题);买方下单需求原文(event.description)。
import fs from 'node:fs';
const [mode = 'tally', dir = 'crawl', arg] = process.argv.slice(2);

if (mode === 'crawl') {
const B = arg || process.env.BASE || 'https://okx-dev-day-demo.tradingswarm.tech';
const OUT = dir;
fs.mkdirSync(OUT, { recursive: true });
const seen = new Map();
const fname = (p) => p.replace(/[/?=&%:]/g, '_').slice(0, 180) + '.json';
async function get(p) {
  if (seen.has(p)) return seen.get(p);
  const pr = (async () => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(B + p, { signal: AbortSignal.timeout(60000) });
        const t = await r.text();
        if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 3000)); continue; }
        if (r.status !== 200) { console.error(r.status, p); return null; }
        fs.writeFileSync(`${OUT}/${fname(p)}`, JSON.stringify({ __path: p, body: JSON.parse(t) }));
        return JSON.parse(t);
      } catch (e) { console.error('err', p, e.message); }
    }
    return null;
  })();
  seen.set(p, pr);
  return pr;
}
const enc = encodeURIComponent;
const ids = (arr, k = 'id') => (Array.isArray(arr) ? arr.map((x) => x?.[k]).filter((x) => typeof x === 'string' || typeof x === 'number') : []);
async function pool(items, n, fn) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); }

const LISTS = ['/api/overview','/api/workflow','/api/workflow/proposals','/api/activity?limit=100','/api/agents','/api/bots','/api/bots/runs','/api/bots/handoffs','/api/captain/brief','/api/strategies','/api/strategies?include_retired=1','/api/strategies/allocator','/api/screener/latest?horizon=short','/api/screener/latest?horizon=swing','/api/screener/latest?horizon=weekly','/api/screener/history?horizon=short&limit=20','/api/universe','/api/universe/scan','/api/episodes','/api/episodes?limit=50','/api/judgment-ledger','/api/judgment-ledger/summary','/api/candidates','/api/candidates/summary','/api/evolution/daily','/api/graph','/api/market-state','/api/market-state/history?limit=20&view=summary','/api/market-events','/api/info/events?limit=50','/api/info/sources','/api/lab/experiments?limit=20','/api/reviewer/cards?limit=20','/api/risk/alerts?status=open','/api/risk/policy','/api/portfolio/snapshot','/api/portfolio/capacity','/api/history?limit=50','/api/intents?limit=50','/api/threads?status=all','/api/positions','/api/orders/open','/api/memory','/api/judge/live','/api/judge/live/summary','/api/agent/strategy','/api/follow','/api/follow/signals','/api/follow/stats','/api/attribution/summary','/api/backtest?limit=20','/api/research','/api/research/strategies','/api/research/backtests','/api/research/matrix-studies','/api/research/runs','/api/research/sessions?limit=20','/api/research/capabilities','/api/research/primitives','/api/research/schema','/api/research/universes','/api/research/datasets','/api/research/improve?limit=20','/api/research/pine/health','/api/research/pine/scripts','/api/strategy-runs','/api/market/status','/api/market/asp','/api/market/subscriptions','/api/market/inbox','/api/market/regime?symbol=BTCUSDT','/api/market/indicators/sets','/api/market/settings','/api/asp-services','/api/asp-services/products','/api/asp-services/provider-tasks','/api/market/catalog?category=ALL&page=1&page_size=60&sort=hot','/api/chat/sessions','/api/symbols','/api/execution-policy','/api/trading/sources','/api/funnel?symbols=BTCUSDT&days=7'];
await pool(LISTS, 4, get);
const L = async (p) => get(p);
const details = [];
const rs = await L('/api/research/strategies'); for (const id of ids(rs?.strategies)) details.push(`/api/research/strategies/${enc(id)}`, `/api/research/strategies/${enc(id)}/binding`), `/api/strategy-runs/preflight?strategy_id=${enc(id)}` // versions 只有 POST;
const bt = await L('/api/research/backtests'); for (const id of ids(bt?.reports)) details.push(`/api/research/backtests/${enc(id)}`);
const ms = await L('/api/research/matrix-studies'); for (const id of ids(ms?.items)) details.push(`/api/research/matrix-studies/${enc(id)}`);
const sr = await L('/api/strategy-runs'); for (const id of ids(sr?.runs ?? sr?.items ?? sr)) details.push(`/api/strategy-runs/${enc(id)}/events` /* 没有 GET /api/strategy-runs/:id(只有 PATCH),运行详情就在列表里 */, `/api/judge/live?run_id=${enc(id)}`, `/api/judge/live/summary?run_id=${enc(id)}`);
for (const r of ['gate_captain','radar','thread_manager','strategy_lab','portfolio_manager','risk_sentinel','reviewer','executor','asp_agent']) details.push(`/api/agents/${r}`);
const st = await L('/api/strategies?include_retired=1'); for (const id of ids(st?.strategies)) details.push(`/api/strategies/${enc(id)}`, `/api/strategies/${enc(id)}/timeline`);
const ep = await L('/api/episodes?limit=50'); for (const id of ids(Array.isArray(ep) ? ep : ep?.episodes).slice(0, 25)) details.push(`/api/episodes/${enc(id)}`, `/api/judgments/${enc(id)}`);
const th = await L('/api/threads?status=all'); for (const id of ids(th?.threads ?? th).slice(0, 20)) details.push(`/api/threads/${enc(id)}`);
const sh = await L('/api/screener/history?horizon=short&limit=20'); for (const id of ids(sh?.screens).slice(0, 10)) details.push(`/api/screener/${enc(id)}`);
const me = await L('/api/market-events'); for (const id of ids(me?.events).slice(0, 20)) details.push(`/api/market-events/${enc(id)}`);
const ru = await L('/api/research/runs'); for (const id of ids(ru?.runs ?? ru?.items ?? ru).slice(0, 20)) details.push(`/api/research/runs/${enc(id)}`, `/api/research/runs/${enc(id)}/result`);
const se = await L('/api/research/sessions?limit=20'); for (const id of ids(se?.sessions ?? se?.items ?? se).slice(0, 20)) details.push(`/api/research/sessions/${enc(id)}`, `/api/research/sessions/${enc(id)}/messages`);
const un = await L('/api/research/universes'); for (const id of ids(un?.universes ?? un?.items ?? un).slice(0, 10)) details.push(`/api/research/universes/${enc(id)}`);
const bk = await L('/api/backtest?limit=20'); for (const id of ids(bk?.backtests ?? bk?.items ?? bk).slice(0, 10)) details.push(`/api/backtest/${enc(id)}`);
const ev = await L('/api/evolution/daily'); for (const r of (ev?.roles ?? [])) for (const d of (r.days ?? []).slice(-3)) details.push(`/api/evolution/day?role=${enc(r.role)}&date=${enc(d.date)}`);
await pool(details, 4, get);
// 矩阵研究的试验详情(页面「继续打磨」会拉):finalists / 候补
const trialPaths = [];
for (const id of ids(ms?.items)) {
  const d = await get(`/api/research/matrix-studies/${enc(id)}`);
  const tids = new Set();
  const walk = (v, k) => { if (Array.isArray(v)) v.forEach((x) => walk(x, k)); else if (v && typeof v === 'object') { for (const [kk, vv] of Object.entries(v)) { if (kk === 'trial_id' && typeof vv === 'string') tids.add(vv); walk(vv, kk); } } };
  walk(d);
  for (const t of [...tids].slice(0, 15)) trialPaths.push(`/api/research/matrix-studies/${enc(id)}/trials/${enc(t)}`);
}
await pool(trialPaths, 4, get);
console.log('fetched', fs.readdirSync(OUT).length, 'files');
} else {
const { publicView } = await import('../dist/demo/public-view.js');
const { englishDeep } = await import('../dist/demo/public-en.js');
const files = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')));
const CJK = /[㐀-鿿＀-￯　-〿]/;
// 外部内容:新闻原文(标题/摘要)集合
const external = new Set();
for (const { __path, body } of files) {
  const walk = (v, k) => { if (typeof v === 'string') { if (/^(title|digest|summary_zh|text)$/.test(k) && /info\/events|market-state|overview/.test(__path)) external.add(v); return; } if (Array.isArray(v)) v.forEach((x) => walk(x, k)); else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk); };
  if (/info\/events/.test(__path)) walk(body, '');
  // /api/market-events 里 kind=news 的事件标题是 PANews 等新闻原文
  if (/market-events/.test(__path)) for (const e of body?.events ?? (body?.event ? [body.event] : [])) if (e?.kind === 'news' && typeof e.title === 'string') external.add(e.title);
  // 买方下单时写的需求原文(provider-tasks 的 event.description),交付 JSON 里会原样引用
  if (/provider-tasks/.test(__path)) for (const it of body?.items ?? []) { const d = it?.event?.description; if (typeof d === 'string') external.add(d); }
  const news = (v) => { if (Array.isArray(v)) v.forEach(news); else if (v && typeof v === 'object') { if (Array.isArray(v.news)) for (const n of v.news) { if (n?.title) external.add(n.title); if (n?.digest) external.add(n.digest); } Object.values(v).forEach(news); } };
  news(body);
}
const EXT_PATH = [
  /^\/api\/market\/catalog/, // OKX.AI 目录:第三方 agent
];
const EXT_FIELD = /(^|\.)(asp\.name|remote\.title|signal\.trader|event\.description|agentName|agent_name|serviceName|service_name)$/; // 第三方名/服务名、买方需求原文
const tmpl = (p) => p.replace(/\/(rs|run|ms|bt|thr|ep|scr|mev|res|sess|uni)[-_][\w-]+/g, '/:id').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '/:id').replace(/\/trials\/[^/?]+/, '/trials/:tid').replace(/\/(agents)\/\w+/, '/$1/:role').replace(/\?.*$/, (q) => q.replace(/=[^&]*/g, '=')).replace(/\/(ep|thr|scr)-[^/?]+/g, '/:id');
const count = (body, p, into) => {
  if (EXT_PATH.some((r) => r.test(p))) return;
  const walk = (v, path) => {
    if (typeof v === 'string') {
      if (external.has(v)) return;
      // 引文只在内容是外部新闻原文时才不计;我们自己拼进字符串的 JSON 里的中文照计
      // <untrusted_data>…</untrusted_data> 包着的是新闻原文(证据里喂给模型的外部数据),不计
      const bare = v.replace(/<untrusted_data>[\s\S]*?<\/untrusted_data>/g, '').replace(/"([^"]*)"/g, (m, t) => (external.has(t) ? '' : m)).replace(/「([^」]*)」/g, (m, t) => (external.has(t) ? '' : m));
      if (!CJK.test(bare)) return;
      if (EXT_FIELD.test(path) ) return;
      const k = `${tmpl(p)}  ${path.replace(/\[\d+\]/g, '[]')}`; (into[k] ??= { n: 0, ex: v.slice(0, 140) }).n++; return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(body, '');
};
const before = {}, after = {};
const snap = (p) => /^\/api\/(market|asp-services)/.test(p);
for (const { __path, body } of files) { count(body, __path, before); count(snap(__path) ? englishDeep(body) : publicView(body), __path, after); }
const byEp = (m) => { const o = {}; for (const [k, v] of Object.entries(m)) { const ep = k.split('  ')[0]; o[ep] = (o[ep] ?? 0) + v.n; } return o; };
const b = byEp(before), a = byEp(after);
if ((arg ?? 'summary') === 'summary') { const eps = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort((x, y) => (b[y] ?? 0) - (b[x] ?? 0)); let tb = 0, ta = 0; for (const e of eps) { tb += b[e] ?? 0; ta += a[e] ?? 0; console.log(`${String(b[e] ?? 0).padStart(6)} -> ${String(a[e] ?? 0).padStart(5)}  ${e}`); } console.log(`TOTAL ${tb} -> ${ta}`); }
else { for (const [k, v] of Object.entries(after).sort((x, y) => y[1].n - x[1].n)) console.log(`${String(v.n).padStart(5)}  ${k}\n        ${v.ex.replace(/\n/g, '⏎')}`); }
}
