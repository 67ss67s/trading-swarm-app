#!/usr/bin/env node
// 五条内置策略导入研究台(docs/research/strategy-merge-plan-2026-09-23.md):调网关的幂等接口,重复执行不重复建。
// 用法:node packages/gateway/scripts/import-builtin-strategies.mjs [--no-backtest] [--port 18811] [--ids breakout_retest,mtf_alignment]
// 回测是同步的(每条全窗口,首次拉数据可能要几分钟);只写研究台表,不碰实盘策略库。
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(opt('--port') ?? process.env.TG_DEMO_PORT ?? 18811);
const ids = opt('--ids')?.split(',').map((s) => s.trim()).filter(Boolean);
const body = { backtest: !args.includes('--no-backtest'), ...(ids?.length ? { ids } : {}) };
// 回测是同步的,可能超过 fetch(undici)默认 300 秒的响应头超时,所以用 node:http 不设超时
import { request } from 'node:http';
const payload = JSON.stringify(body);
const { status, out } = await new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path: '/api/research/strategies/import-builtin', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), origin: 'http://127.0.0.1:5191' } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (text += c));
    res.on('end', () => { try { resolve({ status: res.statusCode, out: JSON.parse(text) }); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.end(payload);
});
if (status !== 200) { console.error(status, out); process.exit(1); }
for (const x of out.items) console.log(`${x.builtin_id.padEnd(26)} ${x.strategy_id} ${x.created ? '新建' : '已存在'} v${x.version ?? '-'} ${x.translation} report=${x.report_id ?? '-'}${x.error ? ` error=${x.error}` : ''}`);
