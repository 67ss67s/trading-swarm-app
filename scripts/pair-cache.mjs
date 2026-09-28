// 公共历史下载是离线lab专用例外；curl显式使用环境代理，串行限速，不含账户凭证。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PAIR_STUDY, runPairStudy } from '../packages/gateway/src/demo/pair-study.ts';
export async function run() {
  const root = process.env.TG_PAIR_CACHE ?? `${homedir()}/.trade-gate/research/pair-v1`;
  mkdirSync(root, { recursive: true });
  const data = {}; const failures = {};
  async function download(path) {
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY;
    if (!proxy) throw new Error('补缓存需要环境HTTP(S)_PROXY');
    await new Promise(r => setTimeout(r, 600));
    return JSON.parse(execFileSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '60', '--retry', '2', '--proxy', proxy, `https://fapi.binance.com${path}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  }
  for (const symbol of new Set(PAIR_STUDY.pairs.flat())) {
    try {
      let bars;
      try { bars = JSON.parse(readFileSync(`${root}/${symbol}-1h.json`)).bars; }
      catch { try { bars = JSON.parse(readFileSync(`${homedir()}/.trade-gate/demo/klines/${symbol}-1h.json`)).bars; } catch { bars = []; } }
      bars = bars.filter(b => b.open_time >= PAIR_STUDY.from && b.close_time < PAIR_STUDY.to);
      if (bars.length !== 4320 || bars.some((b, i) => b.open_time !== PAIR_STUDY.from + i * 3600000)) {
        bars = [];
        for (let start = PAIR_STUDY.from; start < PAIR_STUDY.to;) {
          const rows = await download(`/fapi/v1/klines?symbol=${symbol}&interval=1h&startTime=${start}&endTime=${PAIR_STUDY.to - 1}&limit=1000`);
          if (!Array.isArray(rows) || !rows.length) throw new Error('小时历史为空');
          bars.push(...rows.map(r => ({ open_time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], close_time: r[6] })));
          const next = rows.at(-1)[0] + 3600000; if (next <= start) throw new Error('小时分页未推进'); start = next;
        }
      }
      writeFileSync(`${root}/${symbol}-1h.json`, JSON.stringify({ bars }));
      let funding;
      try { funding = JSON.parse(readFileSync(`${root}/${symbol}-funding.json`)); }
      catch {
        funding = [];
        for (let start = PAIR_STUDY.from; start < PAIR_STUDY.to;) {
          const rows = await download(`/fapi/v1/fundingRate?symbol=${symbol}&startTime=${start}&endTime=${PAIR_STUDY.to - 1}&limit=1000`);
          if (!Array.isArray(rows)) throw new Error('资金费响应无效');
          if (!rows.length) break;
          funding.push(...rows.map(r => ({ at: Number(r.fundingTime), rate: String(r.fundingRate) })));
          const next = Number(rows.at(-1).fundingTime) + 1; if (next <= start) throw new Error('资金费分页未推进'); start = next;
        }
        writeFileSync(`${root}/${symbol}-funding.json`, JSON.stringify(funding));
      }
      data[symbol] = { bars, funding };
    } catch (e) { failures[symbol] = String(e); console.error(`${symbol}: 数据准备失败`); }
  }
  const result = { ...runPairStudy(data), cache_failures: failures };
  mkdirSync('.codex-reports', { recursive: true });
  writeFileSync('.codex-reports/pair-study-result.json', JSON.stringify(result, null, 2) + '\n');
  console.table(result.trials.map(t => ({ pair: t.symbols.join('/'), status: t.status, n: t.stats.raw_n, clusters: t.stats.effective_n, net: t.stats.net, doubled: t.stats.doubled_net, ci: t.stats.ci.lower, reasons: t.reasons.join(',') })));
  console.log('结果: .codex-reports/pair-study-result.json');
}
