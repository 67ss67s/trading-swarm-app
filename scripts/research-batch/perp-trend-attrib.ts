/**
 * 选中配置的盈亏归因(同一份冻结数据、同一配置确定性重算,不是新的一次选择):按资产、已平仓/期末持仓拆 $ 盈亏,看收益是不是一两笔撑起来的。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/perp-trend-attrib.ts [validation|holdout]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runPool } from '../../packages/gateway/src/demo/research/improve/evaluate.ts';
import { hash } from '../../packages/gateway/src/demo/research/primitives.ts';
import { simulatePortfolio } from '../../packages/gateway/src/demo/research/batch/perp-trend.ts';
import { BATCH_DIR } from './common.ts';
import { loaded, irOf, sigma, paths, EXEC, segWin, VT_ANNUAL, type Seg } from './perp-trend-worker.ts';

const seg = (process.argv[2] ?? 'holdout') as Seg, DIR = path.join(BATCH_DIR, 'perp-trend'), res = JSON.parse(readFileSync(path.join(DIR, 'results.json'), 'utf8'));
const pk = res.selection.pick as { signal: string; lev: number; sizing: 'equal' | 'equal_vt' | 'inv_vol' };
const { env } = loaded(), ir = irOf(pk.signal, pk.lev), win = segWin(seg);
const run = await runPool(env, ir, hash(ir), win, { execution: EXEC });
const r = simulatePortfolio(paths(run, win), pk.sizing, sigma, { vtAnnual: VT_ANNUAL });
const by: Record<string, { closed: number; open: number; n: number }> = {};
for (const t of r.trades) { const b = (by[t.symbol] ??= { closed: 0, open: 0, n: 0 }); if (t.open) b.open += t.pnl; else b.closed += t.pnl; b.n++; }
const top = [...r.trades].filter((t) => !t.open).sort((a, b) => b.pnl - a.pnl);
const total = r.equity.at(-1)! - r.equity[0]!, closedSum = r.trades.filter((t) => !t.open).reduce((a, t) => a + t.pnl, 0), openSum = r.trades.filter((t) => t.open).reduce((a, t) => a + t.pnl, 0);
const out = { config: pk, segment: seg, total_pnl: total, closed_pnl: closedSum, open_pnl: openSum, by_asset: Object.fromEntries(Object.entries(by).sort((a, b) => b[1].closed + b[1].open - a[1].closed - a[1].open)),
  top5: top.slice(0, 5).map((t) => ({ symbol: t.symbol, entry: new Date(t.entry_at).toISOString().slice(0, 10), exit: new Date(t.exit_at).toISOString().slice(0, 10), pnl: t.pnl, ret: t.ret_on_margin, weight: t.weight })),
  bottom5: top.slice(-5).map((t) => ({ symbol: t.symbol, pnl: t.pnl, ret: t.ret_on_margin })), top5_share: top.slice(0, 5).reduce((a, t) => a + t.pnl, 0) / total, without_top5: total - top.slice(0, 5).reduce((a, t) => a + t.pnl, 0) };
writeFileSync(path.join(DIR, `attrib-${seg}.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
