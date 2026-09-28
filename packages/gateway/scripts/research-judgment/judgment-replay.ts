// Judgment Replay CLI(docs/research/judgment-replay-2026-09-23.md)。独立进程运行,不进 18811 网关进程。
//
//   npx jiti packages/gateway/scripts/research-judgment/judgment-replay.ts import   [--db <jr.sqlite>]
//   npx jiti …/judgment-replay.ts freeze   --venue spot|perp [--periods geo,bear] [--cooldown 24] [--prompt prod|research]
//   npx jiti …/judgment-replay.ts estimate --manifest <id> [--sample N] [--upper 3]
//   npx jiti …/judgment-replay.ts run      --manifest <id> --arm B --brain stub-rule|stub-random|glm|deepseek [--sample N]
//                                          --max-calls N --max-cny X [--concurrency 4] [--timeout 90000] [--allow-real]
//   npx jiti …/judgment-replay.ts replay   --manifest <id>          # 零模型:重新解析落库的原始输出,逐条比对
//   npx jiti …/judgment-replay.ts report   --manifest <id> [--md out.md] [--json out.json]
//   npx jiti …/judgment-replay.ts list
//
// 真模型(glm / deepseek)必须同时给 --allow-real 与 JR_ALLOW_REAL_MODEL=1;DeepSeek 的 key 从
// ~/.trade-gate-okx/secrets/deepseek.env 读,只在内存里传给 pi 的 --api-key,不打印、不落库。
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPerp, readSpot } from '../../src/demo/research/judgment-replay/data.js';
import { deepseekClient, glmClient, readEnvFileVar, stubClient, type ModelClient } from '../../src/demo/research/judgment-replay/judge.js';
import { buildReport, estimate, freezeManifest, replayDecisions, reportMarkdown, runArm, subsetFor } from '../../src/demo/research/judgment-replay/run.js';
import { defaultJrDb, JrStore } from '../../src/demo/research/judgment-replay/store.js';
import { PERIODS, SYMBOLS, type Venue } from '../../src/demo/research/judgment-replay/types.js';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'list';
const opt = (k: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : d;
};
const flag = (k: string): boolean => argv.includes(`--${k}`);
const need = (k: string): string => {
  const v = opt(k);
  if (!v) throw new Error(`缺参数 --${k}`);
  return v;
};
const store = new JrStore(opt('db', defaultJrDb())!);
const log = (s: string): void => console.log(s);

function client(kind: string): ModelClient {
  if (kind === 'stub-rule' || kind === 'stub-random') return stubClient(kind, { seed: Number(opt('seed', '1')) });
  if (!flag('allow-real') || process.env['JR_ALLOW_REAL_MODEL'] !== '1') throw new Error('真模型需要 --allow-real 且 JR_ALLOW_REAL_MODEL=1');
  if (kind === 'glm') return glmClient();
  if (kind === 'deepseek') {
    const key = readEnvFileVar(opt('key-file', join(homedir(), '.trade-gate-okx/secrets/deepseek.env'))!, 'DEEPSEEK_API_KEY');
    if (!key) throw new Error('读不到 DEEPSEEK_API_KEY');
    return deepseekClient(key);
  }
  throw new Error(`未知 brain ${kind}`);
}

async function main(): Promise<void> {
  if (cmd === 'import') {
    const spot = readSpot(opt('state-db', join(homedir(), '.trade-gate-okx/demo/state.sqlite'))!, SYMBOLS);
    for (const s of spot) store.putSeries(s);
    const perp = readPerp(opt('market-db', join(homedir(), '.trade-gate/research/market-cache.sqlite'))!, SYMBOLS);
    for (const s of perp.series) store.putSeries(s);
    for (const [sym, f] of perp.funding) store.putFunding(sym, f);
    for (const s of [...spot, ...perp.series]) log(`${s.venue} ${s.symbol} ${s.bars.length} 根 gaps=${s.gaps} ${new Date(s.bars[0]!.open_time).toISOString()} → ${new Date(s.bars.at(-1)!.close_time + 1).toISOString()} sha ${s.sha256.slice(0, 10)}`);
    return;
  }
  if (cmd === 'freeze') {
    const venue = need('venue') as Venue;
    const periods = (opt('periods', 'geo,bear') ?? '').split(',').map((p) => {
      const d = PERIODS[p];
      if (!d) throw new Error(`未知行情段 ${p}`);
      return d;
    });
    const m = freezeManifest(store, { venue, periods, symbols: [...SYMBOLS], cooldown_bars: Number(opt('cooldown', '24')), prompt_mode: (opt('prompt', 'prod') as 'prod' | 'research'), log });
    log(`manifest ${m.id}:${m.events.count} 个事件,events sha ${m.events.sha256.slice(0, 12)}`);
    return;
  }
  if (cmd === 'list') {
    for (const m of store.manifests()) log(`${m.id}  ${m.events.count} 事件  模型 ${JSON.stringify(Object.fromEntries(Object.entries(m.models).map(([a, x]) => [a, x.model])))}`);
    return;
  }
  const id = need('manifest');
  const m = store.manifest(id);
  if (!m) throw new Error(`没有 manifest ${id}`);
  if (cmd === 'estimate') {
    const sample = opt('sample') ? Number(opt('sample')) : undefined;
    const rows = subsetFor(store.events(id), sample);
    for (const model of ['pi:zai/glm-5.3', 'pi:deepseek/deepseek-v4-flash']) {
      const e = estimate(rows, model, m.prompt_mode, Number(opt('upper', '3')));
      log(`${model}:${e.calls} 次,入 ${e.in_tok} 出 ${e.out_tok}(字符/3 估),点估计 ¥${e.cny_point.toFixed(3)},上界(×${opt('upper', '3')})¥${e.cny_upper.toFixed(3)};分段 ${Object.entries(e.by_period).map(([p, v]) => `${p} ${v.calls} 次 ¥${v.cny_point.toFixed(3)}/¥${v.cny_upper.toFixed(3)}`).join(',')}`);
    }
    return;
  }
  if (cmd === 'run') {
    const r = await runArm(store, id, {
      arm: need('arm'),
      client: client(need('brain')),
      ...(opt('sample') ? { sample: Number(opt('sample')) } : {}),
      max_calls: Number(need('max-calls')),
      max_cny: Number(need('max-cny')),
      concurrency: Number(opt('concurrency', '4')),
      timeout_ms: Number(opt('timeout', '90000')),
      log,
    });
    log(JSON.stringify(r));
    return;
  }
  if (cmd === 'replay') {
    const r = replayDecisions(store, id);
    log(`重放 ${r.checked} 条,不一致 ${r.mismatches.length}${r.mismatches.length ? `:${r.mismatches.slice(0, 10).join(', ')}` : ''}`);
    if (r.mismatches.length) process.exitCode = 1;
    return;
  }
  if (cmd === 'report') {
    const rep = buildReport(store, id, Number(opt('seeds', '200')));
    const md = reportMarkdown(rep);
    if (opt('md')) writeFileSync(opt('md')!, md);
    if (opt('json')) writeFileSync(opt('json')!, JSON.stringify(rep, null, 1));
    if (!opt('md')) log(md);
    return;
  }
  throw new Error(`未知命令 ${cmd}`);
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => store.close());
