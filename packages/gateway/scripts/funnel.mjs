// 零 PROPOSE 漏斗:把「突破-回踩」playbook + scanChecklist 的每一条入场条件在历史上逐根重放,
// 数出谁在杀机会、放宽到什么程度才有单子、放宽出来的单子值不值得做。零模型调用。
//
//   npm run build --workspace packages/gateway
//   npm run funnel --workspace packages/gateway            # 默认 60 天、27 个代码
//   npm run funnel --workspace packages/gateway -- --days 30 --symbols BTCUSDT,ETHUSDT
//   npm run funnel --workspace packages/gateway -- --no-write   # 只打印,不写文档
//
// 结果写入 docs/research/zero-propose-funnel-2026-09-05.md。K 线走 backtest.ts 的磁盘缓存
// (~/.trading-swarm/demo/klines),所以第二次跑基本不发请求。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { aggregateLadder, CONDITION_KEYS, CONDITION_LABEL, DEFAULT_FUNNEL_SYMBOLS, LADDER, VARIANTS, runFunnel } from '../dist/demo/funnel.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const days = Number(arg('days', '60'));
const tf = arg('tf', '15m');
const symbols = arg('symbols', '') ? arg('symbols', '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : DEFAULT_FUNNEL_SYMBOLS;
const write = !argv.includes('--no-write');

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const r2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(2));

console.error(`funnel: ${symbols.length} 个代码 × ${days} 天 ${tf};第一次跑要拉 K 线,之后走磁盘缓存…`);
const t0 = Date.now();
const report = await runFunnel(symbols, {
  days,
  timeframe: tf,
  pause_ms: 150,
  onProgress: (s, done, total) => console.error(`  [${String(done).padStart(2)}/${total}] ${s}`),
});
const agg = aggregateLadder(report);
const aggVar = aggregateLadder(report, 'variants');
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ------------------------------------------------------------------ 打印

const table = (rows) => rows.map((r) => r.join('  ')).join('\n');
console.log('\n== 条件通过率(现行规则,全部代码合计)==');
{
  const totalBars = report.symbols.reduce((a, s) => a + s.bars, 0);
  const rows = [['条件'.padEnd(34), '通过'.padStart(8), '通过率'.padStart(8), '边际杀伤'.padStart(9)]];
  for (const key of CONDITION_KEYS) {
    const pass = report.symbols.reduce((a, s) => a + (s.conditions.find((c) => c.key === key)?.pass ?? 0), 0);
    const kills = report.symbols.reduce((a, s) => a + (s.conditions.find((c) => c.key === key)?.marginal_kills ?? 0), 0);
    rows.push([CONDITION_LABEL[key].padEnd(30), String(pass).padStart(8), pct(totalBars ? pass / totalBars : null).padStart(8), String(kills).padStart(9)]);
  }
  console.log(table(rows));
  console.log(`总根数 ${totalBars}`);
}

console.log('\n== 条件通过率(把突破位换成前 20 根之后)==');
{
  const totalBars = report.symbols.reduce((a, s) => a + s.bars, 0);
  const rows = [['条件'.padEnd(34), '通过'.padStart(8), '通过率'.padStart(8), '边际杀伤'.padStart(9)]];
  for (const key of CONDITION_KEYS) {
    const pass = report.symbols.reduce((a, s) => a + (s.conditions_fixed.find((c) => c.key === key)?.pass ?? 0), 0);
    const kills = report.symbols.reduce((a, s) => a + (s.conditions_fixed.find((c) => c.key === key)?.marginal_kills ?? 0), 0);
    rows.push([CONDITION_LABEL[key].padEnd(30), String(pass).padStart(8), pct(totalBars ? pass / totalBars : null).padStart(8), String(kills).padStart(9)]);
  }
  console.log(table(rows));
}

console.log('\n== 放宽阶梯(全部代码合计)==');
console.log(table([['级别'.padEnd(34), '联合'.padStart(7), '去重'.padStart(6), '个/周'.padStart(7), '笔数'.padStart(6), '胜率'.padStart(7), '期望R'.padStart(7)], ...agg.map((a) => [a.label.slice(0, 34).padEnd(30), String(a.joint).padStart(7), String(a.setups).padStart(6), a.per_week.toFixed(1).padStart(7), String(a.outcome.n).padStart(6), pct(a.outcome.win_rate).padStart(7), r2(a.outcome.expectancy_r).padStart(7)])]));

console.log('\n== 质量变体(同一底座,一次动一个旋钮)==');
console.log(table([['变体'.padEnd(38), '机会'.padStart(6), '个/周'.padStart(7), '笔数'.padStart(6), '胜率'.padStart(7), '期望R'.padStart(7), '止/盈/期'.padStart(12)], ...aggVar.map((a) => [a.label.slice(0, 38).padEnd(34), String(a.setups).padStart(6), a.per_week.toFixed(1).padStart(7), String(a.outcome.n).padStart(6), pct(a.outcome.win_rate).padStart(7), r2(a.outcome.expectancy_r).padStart(7), `${a.outcome.stops}/${a.outcome.tps}/${a.outcome.expired}`.padStart(12)])]));

console.log('\n== 每个代码(现行 → 推荐放宽)==');
const best = pickRecommended([...agg, ...aggVar]);
const findRow = (sym, key) => sym.ladder.find((l) => l.key === key) ?? sym.variants.find((l) => l.key === key);
console.log(table([['代码'.padEnd(14), '根数'.padStart(7), '现行'.padStart(5), 'WATCH'.padStart(7), '推荐/周'.padStart(8), '笔数'.padStart(6), '期望R'.padStart(7)], ...report.symbols.map((s) => {
  const row = findRow(s, best.key);
  return [s.symbol.padEnd(12), String(s.bars).padStart(7), String(s.joint).padStart(5), String(s.watch_eligible).padStart(7), (row?.per_week ?? 0).toFixed(1).padStart(8), String(row?.outcome.n ?? 0).padStart(6), r2(row?.outcome.expectancy_r).padStart(7)];
})]));
if (report.missing.length) console.log(`\n币安上没有:${report.missing.join(', ')}`);

/** 推荐级别:笔数 ≥ 200(样本够)的里面期望 R 最高的那一级;都不够就取笔数最多的。 */
function pickRecommended(rows) {
  const usable = rows.filter((r) => r.key !== 'v-control' && r.outcome.n >= 200 && r.outcome.expectancy_r !== null);
  if (usable.length) return usable.reduce((a, b) => (b.outcome.expectancy_r > a.outcome.expectancy_r ? b : a));
  return rows.reduce((a, b) => (b.outcome.n > a.outcome.n ? b : a));
}

// ------------------------------------------------------------------ 文档

if (!write) process.exit(0);

const d = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const totalBars = report.symbols.reduce((a, s) => a + s.bars, 0);
const condTotals = CONDITION_KEYS.map((key) => ({
  key,
  label: CONDITION_LABEL[key],
  pass: report.symbols.reduce((a, s) => a + (s.conditions.find((c) => c.key === key)?.pass ?? 0), 0),
  kills: report.symbols.reduce((a, s) => a + (s.conditions.find((c) => c.key === key)?.marginal_kills ?? 0), 0),
}));
const killers = [...condTotals].sort((a, b) => b.kills - a.kills);
const condFixed = CONDITION_KEYS.map((key) => ({
  key,
  label: CONDITION_LABEL[key],
  kills: report.symbols.reduce((a, s) => a + (s.conditions_fixed.find((c) => c.key === key)?.marginal_kills ?? 0), 0),
}));
const killersFixed = [...condFixed].sort((a, b) => b.kills - a.kills);
const rec = pickRecommended([...agg, ...aggVar]);
const control = aggVar.find((a) => a.key === 'v-control');
const cur = agg.find((a) => a.key === 'current');
const fix = agg.find((a) => a.key === 'fix');

const lines = [];
lines.push(`# 为什么一次 PROPOSE 都没有:入场条件的历史漏斗(${new Date(report.generated_at).toISOString().slice(0, 10)})`);
lines.push('');
lines.push(`> 由 \`npm run funnel --workspace packages/gateway\` 生成(\`packages/gateway/src/demo/funnel.ts\`),零模型调用。窗口 ${d(report.from)} → ${d(report.to)}(${report.days} 天),判断周期 ${report.timeframe},共 ${report.symbols.length} 个代码 / ${totalBars} 根已收盘 K 线。前瞻结算:下一根开盘市价、止损 = 突破位 ∓ ${report.outcome.stop_atr} ATR、第一止盈 ${report.outcome.tp_r}R、最多向前 ${report.outcome.horizon_bars} 根,同根同触按止损计(\`outcome.ts\` 口径);同一策略两次机会至少隔 ${report.cooldown_bars} 根。`);
lines.push('');
lines.push('## 0. 一句话结论');
lines.push('');
lines.push(`现行规则在 ${report.days} 天 ${totalBars} 根 K 线上一共产出 **${cur?.joint ?? 0}** 个候选 —— 不是"市场没机会",是 \`scanChecklist\` 的"回踩确认"判据**在算术上不可能成立**。把突破位口径修成"前 20 根(不含当根)"之后立刻出 ${fix?.joint ?? 0} 个候选;再按下面第 3 节放宽到 \`${rec.key}\`,${report.symbols.length} 个代码合计 ${rec.per_week.toFixed(1)} 个/周,前瞻期望 ${r2(rec.outcome.expectancy_r)}R(${rec.outcome.n} 笔,胜率 ${pct(rec.outcome.win_rate)})。`);
lines.push('');
lines.push('## 1. 根因:`last_close > swing_high_20` 恒为假');
lines.push('');
lines.push('`review-metrics.ts` 的 `scanChecklist` 这样判"最近一根是否收破":');
lines.push('');
lines.push('```ts');
lines.push('const beyond = agree === \'long\' ? base.last_close > base.swing_high_20 : agree === \'short\' ? base.last_close < base.swing_low_20 : false;');
lines.push('const retest = beyond && base.vol_ratio_20 >= RETEST_VOL_MIN;');
lines.push('```');
lines.push('');
lines.push('而 `tfFeatures` 的 `swing_high_20` 是**含当前这根**的 20 根最高价(`ks.slice(-20)`)。于是恒有');
lines.push('`last_close ≤ last_high ≤ swing_high_20`,`beyond` 永远是 `false`,`retest_confirmed` 永远是 `false`。');
lines.push('');
lines.push('后果有两个,方向相反:');
lines.push('');
lines.push('- **PROPOSE 侧**:playbook 写"回踩确认(收在突破位外侧、量比 ≥ retest_vol_min)→ 市价",这条**永远不成立**,模型再听话也开不出单。规则 7 又要求扫描以清单为准,所以它只能在 WATCH / NO_TRADE 之间选 —— 这正是线上 668 次判断 412 次 WATCH、0 次 PROPOSE 的形状。');
lines.push(`- **WATCH 侧**:\`watch_eligible = agree && within && !retest\` 里 \`!retest\` 恒为真,于是 watch 实际退化成"1h/4h 同向 且 距离 ≤ 1.5 ATR"。窗口内 watch_eligible 命中 ${report.symbols.reduce((a, s) => a + s.watch_eligible, 0)} 根(${pct(totalBars ? report.symbols.reduce((a, s) => a + s.watch_eligible, 0) / totalBars : null)})。`);
lines.push('');
lines.push('`triggers.ts` 的 `breakout` 触发器口径是对的 —— 它比的是**上一根**的窗口(`f.last_close > p.swing_high_20`)。两处口径不一致,清单这一处是错的。下面所有"F"级别就是把清单换成前 20 根(不含当根)的口径。');
lines.push('');
lines.push('## 2. 条件漏斗与边际杀伤(现行规则)');
lines.push('');
lines.push('"边际杀伤"= 其余六条全过、只死在这一条上的根数。这是"谁在杀机会"唯一有意义的口径:单条通过率高不代表它不致命。');
lines.push('');
lines.push('| 条件 | 通过 | 通过率 | 边际杀伤 |');
lines.push('|---|---:|---:|---:|');
for (const c of condTotals) lines.push(`| ${c.label} | ${c.pass} | ${pct(totalBars ? c.pass / totalBars : null)} | ${c.kills} |`);
lines.push('');
lines.push(`合计 ${totalBars} 根。全部 ${killers[0].kills} 根杀伤集中在 **${killers[0].label}** 一条上。`);
lines.push('');
lines.push('这张表是**退化**的:`breakout` 一个人通过 0 次,于是"其余全过、只死在这一条"对别的条件必然是 0 —— 它只证明了根因。把突破位换成前 20 根之后,才看得出第二、第三凶手:');
lines.push('');
lines.push('| 条件 | 通过 | 通过率 | 边际杀伤(修完 bug 的口径) |');
lines.push('|---|---:|---:|---:|');
for (const key of CONDITION_KEYS) {
  const pass = report.symbols.reduce((a, s) => a + (s.conditions_fixed.find((c) => c.key === key)?.pass ?? 0), 0);
  const kills = report.symbols.reduce((a, s) => a + (s.conditions_fixed.find((c) => c.key === key)?.marginal_kills ?? 0), 0);
  lines.push(`| ${CONDITION_LABEL[key]} | ${pass} | ${pct(totalBars ? pass / totalBars : null)} | ${kills} |`);
}
lines.push('');
lines.push(`杀伤前三(修完 bug 的口径):${killersFixed.slice(0, 3).map((k, i) => `${i + 1}. **${k.label}**(${k.kills})`).join(';')}。`);
lines.push('');
lines.push('### 每个代码');

lines.push('');
lines.push('| 代码 | 合约 | 根数 | 联合通过(现行) | WATCH 资格 | 前 20 根口径下"最近一根收破" | 杀伤第一(修完 bug) | 杀伤第二 |');
lines.push('|---|---|---:|---:|---:|---:|---|---|');
for (const s of report.symbols) {
  const meta = report.listed.find((l) => l.symbol === s.symbol);
  lines.push(`| ${s.symbol} | ${meta?.contract_type ?? '?'} | ${s.bars} | ${s.joint} | ${s.watch_eligible} | ${s.breakout_prior_last_bar} | ${s.top_killers_fixed[0] ? `${s.top_killers_fixed[0].label}(${s.top_killers_fixed[0].marginal_kills})` : '—'} | ${s.top_killers_fixed[1] ? `${s.top_killers_fixed[1].label}(${s.top_killers_fixed[1].marginal_kills})` : '—'} |`);
}
lines.push('');
lines.push('## 3. 放宽阶梯:每一级多出多少机会,值不值得做');
lines.push('');
lines.push('每一级都是单调放宽(不会把原本通过的根挡掉),所以联合数只能升。"个/周"是全部代码合计、按 cooldown 去重后的机会数。期望 R 用隐藏 K 线结算,分母是同一批候选。');
lines.push('');
lines.push('| 级别 | 联合根数 | 去重机会 | 个/周(全部) | 有机会的代码 | 结算笔数 | 胜率 | 期望 R | 止损/止盈/到期 |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
for (const a of agg) lines.push(`| ${a.label} | ${a.joint} | ${a.setups} | ${a.per_week.toFixed(1)} | ${a.symbols_with_setups}/${report.symbols.length} | ${a.outcome.n} | ${pct(a.outcome.win_rate)} | ${r2(a.outcome.expectancy_r)} | ${a.outcome.stops}/${a.outcome.tps}/${a.outcome.expired} |`);
lines.push('');
lines.push('阶梯的定义(`funnel.ts` `LADDER`):');
lines.push('');
for (const rung of LADDER) lines.push(`- \`${rung.key}\` — ${rung.label}:\`${JSON.stringify(rung.patch)}\``);
lines.push('');
lines.push('### 质量变体:同一底座上一次动一个旋钮');
lines.push('');
lines.push('阶梯回答"有没有单子",这一组回答"怎么把单子变成正期望"。底座是 `fix+win12+volbreak`;最后一行是**对照组** —— 把所有条件都拆掉,只剩"跟着 1h EMA20/50 的方向,每 4 根开一次"。');
lines.push('');
lines.push('| 变体 | 机会 | 个/周 | 结算笔数 | 胜率 | 期望 R | 止损/止盈/到期 |');
lines.push('|---|---:|---:|---:|---:|---:|---|');
for (const a of aggVar) lines.push(`| ${a.label} | ${a.setups} | ${a.per_week.toFixed(1)} | ${a.outcome.n} | ${pct(a.outcome.win_rate)} | ${r2(a.outcome.expectancy_r)} | ${a.outcome.stops}/${a.outcome.tps}/${a.outcome.expired} |`);
lines.push('');
const worseThanControl = aggVar.filter((a) => a.key !== 'v-control' && a.outcome.expectancy_r !== null && control?.outcome.expectancy_r !== null && a.outcome.expectancy_r < control.outcome.expectancy_r);
const betterThanControl = aggVar.filter((a) => a.key !== 'v-control' && a.outcome.expectancy_r !== null && control?.outcome.expectancy_r !== null && a.outcome.expectancy_r >= control.outcome.expectancy_r);
lines.push(`**对照组 ${r2(control?.outcome.expectancy_r)}R(${control?.outcome.n} 笔)—— 而 ${aggVar.length - 1} 个带条件的变体里有 ${worseThanControl.length} 个比它更差。** 唯一(略)胜过对照组的是 ${betterThanControl.map((a) => `\`${a.key}\`(${r2(a.outcome.expectancy_r)}R)`).join('、') || '没有'}。也就是说:把"突破-回踩"的筛选条件一条条加回去,机械期望基本上只是变差 —— 这套条件在 15m 上几乎没有可测的选品价值,主要作用是把"顺着 1h 做"的样本量削小。`);
lines.push('');
lines.push(`### 推荐级别 \`${rec.key}\` 在各代码上的分布`);
lines.push('');
lines.push('| 代码 | 机会 | 个/周 | 结算笔数 | 胜率 | 期望 R |');
lines.push('|---|---:|---:|---:|---:|---:|');
for (const s of report.symbols) {
  const row = findRow(s, rec.key);
  if (!row) continue;
  lines.push(`| ${s.symbol} | ${row.setups} | ${row.per_week.toFixed(2)} | ${row.outcome.n} | ${pct(row.outcome.win_rate)} | ${r2(row.outcome.expectancy_r)} |`);
}
lines.push('');
lines.push('各代码之间的离散度(从 +0.2R 到 −0.3R)远大于任何一级放宽带来的差异,这本身就说明单个代码上的正期望更像样本噪声,不是可复制的边。');
lines.push('');

lines.push('## 4. 8794 白名单在币安 USDⓈ-M 上的存在性');
lines.push('');
lines.push('`fetchExchangeInfo()` 只收 `contractType === \'PERPETUAL\'`,而币安的股票/商品永续是 **`TRADIFI_PERPETUAL`** —— 所以这些代码在 `/api/symbols` 里一个都看不到,但 `/fapi/v1/klines` 是能取到的。要把它们纳入扫描,得放宽 `fetchExchangeInfo` 的合约类型过滤。');
lines.push('');
lines.push('| 代码 | 合约类型 | 上线日 | 窗口内 15m 根数 |');
lines.push('|---|---|---|---:|');
for (const l of report.listed) {
  const s = report.symbols.find((x) => x.symbol === l.symbol);
  lines.push(`| ${l.symbol} | ${l.contract_type} | ${l.onboard ? new Date(l.onboard).toISOString().slice(0, 10) : '—'} | ${s?.bars ?? 0} |`);
}
lines.push('');
lines.push(report.missing.length ? `币安上没有(已跳过):${report.missing.join('、')}。` : '候选代码**全部存在**且在 TRADING。');
lines.push('');
if (report.errors.length) {
  lines.push('拉数失败:');
  for (const e of report.errors) lines.push(`- ${e.symbol}: ${e.error}`);
  lines.push('');
}
lines.push('## 5. 建议');
lines.push('');
lines.push(`1. **先修 bug,这一条不是"放宽"。** \`scanChecklist\` 的 \`beyond\` 必须拿**该根之前**的 20 根高/低来比 —— 和 \`triggers.ts\` 一致。只这一条,候选从 ${cur?.joint ?? 0} 变成 ${fix?.joint ?? 0}(${fix ? fix.per_week.toFixed(1) : 0} 个/周)。在这之前谈"模型太保守"没有意义:模型看到的清单里,PROPOSE 的前提写着"否",而且永远是"否"。**已修**(\`review-metrics.ts\`,配套在 \`tfFeatures\` 上加了 \`swing_high_20_prev\` / \`swing_low_20_prev\`)。`);
lines.push('');
lines.push(`2. **回踩窗口从 1 根放宽到 12 根。** "突破-回踩"按定义就是突破发生在前几根、现在回来踩;窗口 1 根要求"最近这一根刚好收破",把这个形态本身排除在外了。修完 bug 之后,"已收破突破位"仍是最大的杀手(边际杀伤 ${killersFixed[0].kills} 根,第二名 ${killersFixed[1].label} 才 ${killersFixed[1].kills} 根)。`);
lines.push('');
lines.push(`3. **量比改成看突破那根,而且门槛要提高。** 回踩天然缩量(eval 报告 §「为什么还是零 PROPOSE」第 2 条已经指出),量能确认该放在突破那根;而且质量变体里只有把突破那根的量比提到 1.5–2.0,期望才从 ${r2(aggVar.find((a) => a.key === 'v-base')?.outcome.expectancy_r)}R 抬到 ${r2(aggVar.find((a) => a.key === 'v-vol20')?.outcome.expectancy_r)}R。`);
lines.push('');
lines.push(`4. **ATR%、追单距离、日线状态过滤都不用再动。** 修完 bug 的口径下它们的边际杀伤分别是 ${condFixed.find((c) => c.key === 'atr_ok').kills} / ${condFixed.find((c) => c.key === 'within_chase').kills} / ${condFixed.find((c) => c.key === 'regime_ok').kills} 根,放宽任何一个都只换来更多期望更差的单子(见阶梯表 \`fix+atr\` / \`fix+chase2\`)。"只做日线 bull/bear"甚至是全表期望最差的过滤之一。`);
lines.push('');
lines.push(`5. **v2 草稿已按 2+3 生成**:\`breakout_retest\` v2(\`breakout_window=12\`、\`retest_vol_min=2\`),状态停在 \`backtest\`,不进实盘 —— 实盘 \`resolve()\` 会退回仍是 paper 的 v1。回放页用 \`breakout_retest@1\` / \`breakout_retest@2\` 可以在同一段行情上对跑。`);
lines.push('');
lines.push('## 6. 但真正的结论是:放宽阈值不是钱在的地方');
lines.push('');
lines.push(`阶梯上**没有任何一级是正期望**(最好的一级 ${r2(rec.outcome.expectancy_r)}R,${rec.outcome.n} 笔),而"什么条件都不要、只跟 1h 方向"的对照组是 ${r2(control?.outcome.expectancy_r)}R(${control?.outcome.n} 笔)—— 与最好的那一级在同一个数量级,还比大多数带条件的变体好。1.5R 止盈 + 1R 止损的几何盈亏平衡点是 40% 胜率,全表胜率在 37–40% 之间徘徊。也就是说:**机械执行这套「突破-回踩」在 15m 上就是一枚略偏负的硬币**,还没算手续费和滑点。`);
lines.push('');
lines.push('所以对"到底是没机会交易还是条件框太死"这个问题,数据给的答案是两句:');
lines.push('');
lines.push('- **条件框不是太死,是坏的。** 一条恒为假的判据把 PROPOSE 整条路封死了;三轮 eval 0/108、线上 668 次判断只有 1 次 PROPOSE,都由它解释,与"市场没机会"无关。');
lines.push(`- **但把它修好也不会自动开始赚钱。** 修好之后每周有几十个候选,机械期望仍在 0 附近偏负。边要么来自这套形态之外(别的策略族、别的周期、别的证据源),要么来自模型在这些候选上的取舍 —— 而现在终于有了可比的机械基线:同一批候选、同一套止损止盈,机械执行是 ${r2(rec.outcome.expectancy_r)}R。**agent 的价值 = 它在这批候选上的期望 R 减去这个数**,这才是下一步该测的(eval 的 outcome_R 终于有了分母)。`);
lines.push('');
lines.push('> 期望 R 是机械执行的结果,不含模型取舍,也不含手续费与滑点;它回答"这批候选整体上是不是正期望",不回答"上线能赚多少"。60 天 × 27 个代码是一个样本,不是一条定律。');
lines.push('');

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/research/zero-propose-funnel-2026-09-05.md');
writeFileSync(out, lines.join('\n'));
console.error(`wrote ${out}`);
