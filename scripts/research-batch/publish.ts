/**
 * 把批量研究里过了落库门槛(验证段 n ≥ 30、每笔期望 > 0、2 倍费率 > 0、跑赢同敞口持有)的单资产 IR 变体落成研究策略:
 *   名称前缀「batch·」,状态 draft;经 strategies/ 的公开服务(StrategyService.create + backtest)写 18811 的 state.sqlite,并挂一份全窗口报告。
 *   全窗口报告:与批量研究同一窗口起点;资产取该行资产池里前 8 个(报告单次上限 8 个),K 线走报告自己的加载器(现货读缓存,永续拉标记价)。
 *   同一 (族, 市场, 方向, 周期) 只落验证段夏普最高的一行。组合族(横截面动量、资金费套利)不能表达成 StrategyIR,满足门槛也只写进报告。同名 draft 已存在就跳过。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/publish.ts [--dry]
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ResearchStore } from '../../packages/gateway/src/demo/research/store.ts';
import { StrategyStore } from '../../packages/gateway/src/demo/research/strategies/store.ts';
import { StrategyService } from '../../packages/gateway/src/demo/research/strategies/service.ts';
import { allVariants, FAMILY_LABEL, type IrVariant } from '../../packages/gateway/src/demo/research/batch/families.ts';
import type { BatchRow } from '../../packages/gateway/src/demo/research/batch/study.ts';
import { BATCH_DIR, TO_MS, segmentsFor } from './common.ts';
import { configureOkxProxy } from '../../packages/gateway/src/demo/okx-proxy.ts';

configureOkxProxy();
const dry = process.argv.includes('--dry');
const summary = JSON.parse(readFileSync(path.join(BATCH_DIR, 'summary.json'), 'utf8')) as { leaderboard: BatchRow[]; trials: number };
const byId = new Map(allVariants().map((v) => [v.id, v]));
// 同一 (族, 市场, 方向, 周期) 只落验证段夏普最高的一行(同族换参数、整池/筛资产的近亲不重复落库,免得策略库被几十条同质草稿刷满)
const seen = new Set<string>(), all = summary.leaderboard.filter((r) => r.promotable && byId.get(r.variant_id)?.kind === 'ir');
const rows = all.filter((r) => { const k = `${r.family}|${r.market}|${r.side}|${r.timeframe}`; if (seen.has(k)) return false; seen.add(k); return true; });
const portfolioOnly = summary.leaderboard.filter((r) => r.promotable && byId.get(r.variant_id)?.kind === 'portfolio').map((r) => r.id);
console.log(`过门槛 IR 行 ${all.length} 个,按 (族, 市场, 方向, 周期) 去重后 ${rows.length} 个;组合族过门槛 ${portfolioOnly.length} 个(不能落 IR):${portfolioOnly.join(', ')}`);
if (!rows.length || dry) { for (const r of rows) console.log('[dry]', r.id); process.exit(0); }
const db = new DatabaseSync(path.join(homedir(), '.trade-gate-okx', 'demo', 'state.sqlite'));
db.exec('PRAGMA busy_timeout=15000');
const svc = new StrategyService(new StrategyStore(db), new ResearchStore(db), null as never), published: unknown[] = [];
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
for (const r of rows) {
  const v = byId.get(r.variant_id) as IrVariant, name = `batch·${FAMILY_LABEL[v.family]} ${v.param} ${v.market === 'spot' ? '现货多' : v.side === 'long' ? '永续多' : '永续空'} ${v.timeframe}${r.scope === 'screen5' ? ' 筛5' : ''}`.slice(0, 120);
  if (db.prepare("SELECT 1 FROM research_strategies WHERE name=? AND status<>'archived'").get(name)) { console.log('已存在,跳过', name); continue; }
  const val = r.validation, desc = `批量研究 2026-09-23(docs/research/batch-study-2026-09-23.md):${v.ir.description}。资产池 ${r.scope === 'screen5' ? '训练段筛出的 ' + val.members.join('/') : val.members.length + ' 个币'};验证段 ${val.trades} 笔、扣成本每笔期望 ${pct(val.expectancy)}、收益 ${pct(val.total_return)}(同敞口持有 ${pct(val.exposure_matched_hold)},2 倍费率 ${pct(val.stressed_return)})、年化夏普 ${val.sharpe?.toFixed(2)};Deflated Sharpe(验证段,试验数 ${summary.trials})${r.deflated?.validation?.toFixed(2) ?? '—'}。${v.vol_target ? '波动率目标仓位只在批量层实现,策略对象按单位仓位回测。' : ''}状态 draft,进 paper 需人工确认。`;
  const s = svc.create({ name, description: desc.slice(0, 4000), symbol: val.members[0] ?? 'BTCUSDT', timeframe: v.timeframe, strategy_ir: v.ir });
  const seg = segmentsFor(v.timeframe, v.market), symbols = val.members.slice(0, 8);
  const rep = await svc.backtest(s.id, { symbols, from_ms: seg.train.from_ms, to_ms: TO_MS });
  published.push({ row: r.id, strategy_id: s.id, name, report_id: rep.report_id, symbols });
  console.log('落库', s.id, name, '报告', rep.report_id);
}
db.close();
writeFileSync(path.join(BATCH_DIR, 'published.json'), JSON.stringify({ published, portfolio_only: portfolioOnly }, null, 1));
