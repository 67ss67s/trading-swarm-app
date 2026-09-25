/**
 * 把 study.ts 里 promote=true(验证段 n ≥ 30 且扣成本期望 > 0)的只做多规则落成研究策略草稿,并跑一次全窗口回测报告挂上去。
 * 写 ~/.trading-swarm-okx/demo/state.sqlite(WAL,busy_timeout 等锁),只经 StrategyService 写策略相关表 + 回测报告/数据集;不重启 18811,不跑迁移。
 * 名称带「oracle」前缀,来源 manual;状态保持 draft,往 paper/live 推进仍要人确认。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-oracle/publish.ts [--dry]
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { StrategyIR } from '@trading-swarm/contracts';
import { DATA_DIR, UNIVERSE } from './frozen.ts';
import { ResearchStore } from '../../packages/gateway/src/demo/research/store.ts';
import { StrategyStore } from '../../packages/gateway/src/demo/research/strategies/store.ts';
import { StrategyService } from '../../packages/gateway/src/demo/research/strategies/service.ts';

const dry = process.argv.includes('--dry');
const result = JSON.parse(readFileSync(path.join(DATA_DIR, 'study-result.json'), 'utf8')) as { validations: { rule: string; ir: StrategyIR; promote: boolean; validation: { trades: number; expectancy: number | null } }[] };
const promoted = result.validations.filter((v) => v.promote);
if (!promoted.length) { console.log('没有 promote=true 的规则(验证段 n≥30 且扣成本期望>0),不落库'); process.exit(0); }
const db = new DatabaseSync(path.join(homedir(), '.trading-swarm-okx', 'demo', 'state.sqlite'));
db.exec('PRAGMA busy_timeout=15000');
for (const t of ['research_strategies', 'research_strategy_versions', 'research_strategy_reports', 'research_strategy_events', 'research_backtests', 'research_datasets']) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) throw Error(`库里缺表 ${t}(没跑到对应迁移),不写`);
const research = new ResearchStore(db), svc = new StrategyService(new StrategyStore(db), research, null as never);
const published: { rule: string; strategy_id: string; report_id: string }[] = [];
for (const v of promoted) {
  const name = `oracle · ${v.rule}`.slice(0, 120);
  const description = `事后反推(oracle)研究 2026-09-23:${v.rule}。验证段 ${v.validation.trades} 笔、扣成本期望 ${((v.validation.expectancy ?? 0) * 100).toFixed(3)}%/笔。标签含未来数据,规则本身只用当时可见数据;留出段未用。见 docs/research/oracle-study-2026-09-23.md。`;
  if (dry) { console.log('[dry]', name); continue; }
  const s = svc.create({ name, description, symbol: 'BTCUSDT', timeframe: '1h', strategy_ir: v.ir });
  // 全窗口(1h 缺省 730 天)、资产池 6 个币;报告挂到这条策略的当前版本
  const r = await svc.backtest(s.id, { symbols: UNIVERSE });
  published.push({ rule: v.rule, strategy_id: s.id, report_id: r.report_id });
  console.log('落库', s.id, name, '报告', r.report_id);
}
db.close();
if (published.length) writeFileSync(path.join(DATA_DIR, 'published.json'), JSON.stringify(published, null, 1));
