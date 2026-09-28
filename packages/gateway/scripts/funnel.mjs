// 零 PROPOSE 漏斗:把「突破-回踩」playbook + scanChecklist 的每一条入场条件在历史上逐根重放,
// 数出谁在杀机会、放宽到什么程度才有单子、放宽出来的单子值不值得做。零模型调用。
//
//   npm run build --workspace packages/gateway
//   npm run funnel --workspace packages/gateway            # 默认 60 天、27 个代码
//   npm run funnel --workspace packages/gateway -- --days 30 --symbols BTCUSDT,ETHUSDT
//   npm run funnel --workspace packages/gateway -- --no-write   # 只打印,不写文档
//   npm run funnel --workspace packages/gateway -- --out /tmp/funnel.md
//
// 结果默认写入 docs/research/zero-propose-funnel-<生成日期>.md(09-05 那份是修 bug 前的历史报告,不再覆盖)。
// K 线走 backtest.ts 的磁盘缓存(~/.trade-gate/demo/klines),所以第二次跑基本不发请求。
//
// 口径:现行规则 = funnel.ts `CURRENT_THRESHOLDS`,与 `scanChecklist` 逐根一致(funnel.test.ts 对拍)——
// 收破与追单距离都比前 20 根(不含当根),窗口 / 追单上限 / 量比取 review-metrics.ts 的常量。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { aggregateLadder, CONDITION_KEYS, CONDITION_LABEL, CURRENT_THRESHOLDS, DEFAULT_FUNNEL_SYMBOLS, LADDER, notListedLabel, runFunnel, venueLabel } from '../dist/demo/funnel.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const days = Number(arg('days', '60'));
const tf = arg('tf', '15m');
const symbols = arg('symbols', '') ? arg('symbols', '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : DEFAULT_FUNNEL_SYMBOLS;
const write = !argv.includes('--no-write');
const outArg = arg('out', '');

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
const totalBars = report.symbols.reduce((a, s) => a + s.bars, 0);
const condTotals = CONDITION_KEYS.map((key) => ({
  key,
  label: CONDITION_LABEL[key],
  pass: report.symbols.reduce((a, s) => a + (s.conditions.find((c) => c.key === key)?.pass ?? 0), 0),
  kills: report.symbols.reduce((a, s) => a + (s.conditions.find((c) => c.key === key)?.marginal_kills ?? 0), 0),
}));
const killers = [...condTotals].sort((a, b) => b.kills - a.kills);

console.log('\n== 条件通过率(现行规则 = scanChecklist 口径,全部代码合计)==');
console.log(table([['条件'.padEnd(34), '通过'.padStart(8), '通过率'.padStart(8), '边际杀伤'.padStart(9)], ...condTotals.map((c) => [c.label.padEnd(30), String(c.pass).padStart(8), pct(totalBars ? c.pass / totalBars : null).padStart(8), String(c.kills).padStart(9)])]));
console.log(`总根数 ${totalBars}`);

console.log('\n== 放宽阶梯(全部代码合计)==');
console.log(table([['级别'.padEnd(34), '联合'.padStart(7), '去重'.padStart(6), '个/周'.padStart(7), '笔数'.padStart(6), '胜率'.padStart(7), '期望R'.padStart(7)], ...agg.map((a) => [a.label.slice(0, 34).padEnd(30), String(a.joint).padStart(7), String(a.setups).padStart(6), a.per_week.toFixed(1).padStart(7), String(a.outcome.n).padStart(6), pct(a.outcome.win_rate).padStart(7), r2(a.outcome.expectancy_r).padStart(7)])]));

console.log('\n== 质量变体(同一底座,一次动一个旋钮)==');
console.log(table([['变体'.padEnd(38), '机会'.padStart(6), '个/周'.padStart(7), '笔数'.padStart(6), '胜率'.padStart(7), '期望R'.padStart(7), '止/盈/期'.padStart(12)], ...aggVar.map((a) => [a.label.slice(0, 38).padEnd(34), String(a.setups).padStart(6), a.per_week.toFixed(1).padStart(7), String(a.outcome.n).padStart(6), pct(a.outcome.win_rate).padStart(7), r2(a.outcome.expectancy_r).padStart(7), `${a.outcome.stops}/${a.outcome.tps}/${a.outcome.expired}`.padStart(12)])]));

console.log('\n== 每个代码(现行 → 推荐级别)==');
const rec = pickRecommended([...agg, ...aggVar]);
const findRow = (sym, key) => sym.ladder.find((l) => l.key === key) ?? sym.variants.find((l) => l.key === key);
console.log(table([['代码'.padEnd(14), '根数'.padStart(7), '现行'.padStart(5), 'WATCH'.padStart(7), '推荐/周'.padStart(8), '笔数'.padStart(6), '期望R'.padStart(7)], ...report.symbols.map((s) => {
  const row = findRow(s, rec.key);
  return [s.symbol.padEnd(12), String(s.bars).padStart(7), String(s.joint).padStart(5), String(s.watch_eligible).padStart(7), (row?.per_week ?? 0).toFixed(1).padStart(8), String(row?.outcome.n ?? 0).padStart(6), r2(row?.outcome.expectancy_r).padStart(7)];
})]));
console.log(`推荐级别:${rec.key}(${rec.label})`);
if (report.missing.length) console.log(`\n${notListedLabel()}:${report.missing.join(', ')}`);
if (report.errors.length) console.log(`\n拉数失败:${report.errors.map((e) => `${e.symbol}(${e.error})`).join('; ')}`);

/** 推荐级别:笔数 ≥ 200(样本够)的里面期望 R 最高的那一级;都不够就取笔数最多的。对照组永远不当推荐。 */
function pickRecommended(rows) {
  const candidates = rows.filter((r) => r.key !== 'v-control');
  const usable = candidates.filter((r) => r.outcome.n >= 200 && r.outcome.expectancy_r !== null);
  if (usable.length) return usable.reduce((a, b) => (b.outcome.expectancy_r > a.outcome.expectancy_r ? b : a));
  return candidates.reduce((a, b) => (b.outcome.n > a.outcome.n ? b : a));
}

// ------------------------------------------------------------------ 文档

if (!write) process.exit(0);

const d = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const byKey = (key) => agg.find((a) => a.key === key) ?? aggVar.find((a) => a.key === key);
const control = byKey('v-control');
const cur = byKey('current');
const win12 = byKey('win12');
const venue = venueLabel();
const watchTotal = report.symbols.reduce((a, s) => a + s.watch_eligible, 0);
const recRows = report.symbols.map((s) => findRow(s, rec.key)).filter((r) => r && r.outcome.n > 0 && r.outcome.expectancy_r !== null);
const recMin = recRows.length ? Math.min(...recRows.map((r) => r.outcome.expectancy_r)) : null;
const recMax = recRows.length ? Math.max(...recRows.map((r) => r.outcome.expectancy_r)) : null;
const sized = [...agg, ...aggVar].filter((a) => a.key !== 'v-control' && a.outcome.n >= 50 && a.outcome.win_rate !== null);
const wrMin = sized.length ? Math.min(...sized.map((a) => a.outcome.win_rate)) : null;
const wrMax = sized.length ? Math.max(...sized.map((a) => a.outcome.win_rate)) : null;
const positive = agg.filter((a) => a.outcome.n > 0 && a.outcome.expectancy_r !== null && a.outcome.expectancy_r > 0);
const breakevenWr = 1 / (1 + report.outcome.tp_r);

const lines = [];
lines.push(`# 入场条件的历史漏斗(${new Date(report.generated_at).toISOString().slice(0, 10)})`);
lines.push('');
lines.push(`> 由 \`npm run funnel --workspace packages/gateway\` 生成(\`packages/gateway/src/demo/funnel.ts\`),零模型调用。行情源 ${venue};窗口 ${d(report.from)} → ${d(report.to)}(${report.days} 天),判断周期 ${report.timeframe},共 ${report.symbols.length} 个代码 / ${totalBars} 根已收盘 K 线。前瞻结算:下一根开盘市价、止损 = 突破位 ∓ ${report.outcome.stop_atr} ATR、第一止盈 ${report.outcome.tp_r}R、最多向前 ${report.outcome.horizon_bars} 根,同根同触按止损计(\`outcome.ts\` 口径);同一策略两次机会至少隔 ${report.cooldown_bars} 根。`);
lines.push('');
lines.push('## 0. 一句话结论');
lines.push('');
lines.push(`现行规则(与实盘 \`scanChecklist\` 同口径)在 ${report.days} 天 ${totalBars} 根 K 线上产出 **${cur?.joint ?? 0}** 根联合通过、去重后 ${cur?.setups ?? 0} 个机会(${(cur?.per_week ?? 0).toFixed(1)} 个/周,前瞻期望 ${r2(cur?.outcome.expectancy_r)}R,${cur?.outcome.n ?? 0} 笔)。推荐级别是 \`${rec.key}\`(${rec.label};${rec.outcome.n >= 200 ? '笔数 ≥ 200 的级别里期望最高' : '没有级别够 200 笔,取笔数最多的一级,样本偏小'}):${rec.per_week.toFixed(1)} 个/周,前瞻期望 ${r2(rec.outcome.expectancy_r)}R(${rec.outcome.n} 笔,胜率 ${pct(rec.outcome.win_rate)})。`);
lines.push('');
lines.push('## 1. 口径');
lines.push('');
lines.push(`现行规则 = \`CURRENT_THRESHOLDS\`:\`${JSON.stringify(CURRENT_THRESHOLDS)}\`。与 \`review-metrics.ts\` 的 \`scanChecklist\` 逐项对应,\`funnel.test.ts\` 在同一组 K 线上逐根对拍:`);
lines.push('');
lines.push('- **收破**:最近 `breakout_window` 根内有一根收盘越过**它之前**的 20 根高/低(`swing_high_20_prev` / `swing_low_20_prev`,不含当根)。');
lines.push('- **追单距离**:现价到同一个突破位的距离(ATR)。09-27 起与 `entry-policy.ts` 的追单闸同口径;之前量到含当根的 20 根高,突破那根的距离恒约为 0。');
lines.push('- **回踩确认** = 收破 且 当根量比 ≥ `retest_vol_min`;**WATCH 资格** = 1h/4h 同向 且 在射程内 且 回踩未确认。');
lines.push('- 资金费率与日线状态两条来自 playbook 文字规则(`scanChecklist` 不算,模型按规则读)。');
lines.push('');
lines.push('> 历史:2026-09-05 之前 `scanChecklist` 拿收盘价去比**含当根**的 20 根高,`close ≤ high ≤ max(high)`,回踩确认恒为否,三轮 eval 与线上 668 次判断 0 次 PROPOSE 都由它解释。那次的漏斗报告见 `docs/research/zero-propose-funnel-2026-09-05.md`;funnel 里 `breakout_level: \'self\'` 仍可复现那个口径,仅作对照。');
lines.push('');
lines.push('## 2. 条件漏斗与边际杀伤(现行规则)');
lines.push('');
lines.push('"边际杀伤"= 其余六条全过、只死在这一条上的根数。这是"谁在杀机会"唯一有意义的口径:单条通过率高不代表它不致命。');
lines.push('');
lines.push('| 条件 | 通过 | 通过率 | 边际杀伤 |');
lines.push('|---|---:|---:|---:|');
for (const c of condTotals) lines.push(`| ${c.label} | ${c.pass} | ${pct(totalBars ? c.pass / totalBars : null)} | ${c.kills} |`);
lines.push('');
lines.push(`合计 ${totalBars} 根;WATCH 资格命中 ${watchTotal} 根(${pct(totalBars ? watchTotal / totalBars : null)})。杀伤前三:${killers.slice(0, 3).map((k, i) => `${i + 1}. **${k.label}**(${k.kills})`).join(';')}。`);
lines.push('');
lines.push('### 每个代码');
lines.push('');
lines.push('| 代码 | 合约 | 根数 | 联合通过(现行) | WATCH 资格 | 最近一根收破前 20 根 | 杀伤第一 | 杀伤第二 |');
lines.push('|---|---|---:|---:|---:|---:|---|---|');
for (const s of report.symbols) {
  const meta = report.listed.find((l) => l.symbol === s.symbol);
  const k = s.top_killers;
  lines.push(`| ${s.symbol} | ${meta?.contract_type ?? '?'} | ${s.bars} | ${s.joint} | ${s.watch_eligible} | ${s.breakout_prior_last_bar} | ${k[0] ? `${k[0].label}(${k[0].marginal_kills})` : '—'} | ${k[1] ? `${k[1].label}(${k[1].marginal_kills})` : '—'} |`);
}
lines.push('');
lines.push('## 3. 放宽阶梯:每一级多出多少机会,值不值得做');
lines.push('');
lines.push('每一级都在现行规则上单调放宽(不会把原本通过的根挡掉),所以联合数只能升。"个/周"是全部代码合计、按 cooldown 去重后的机会数。期望 R 用隐藏 K 线结算,分母是同一批候选。');
lines.push('');
lines.push('| 级别 | 联合根数 | 去重机会 | 个/周(全部) | 有机会的代码 | 结算笔数 | 胜率 | 期望 R | 止损/止盈/到期 |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
for (const a of agg) lines.push(`| ${a.label} | ${a.joint} | ${a.setups} | ${a.per_week.toFixed(1)} | ${a.symbols_with_setups}/${report.symbols.length} | ${a.outcome.n} | ${pct(a.outcome.win_rate)} | ${r2(a.outcome.expectancy_r)} | ${a.outcome.stops}/${a.outcome.tps}/${a.outcome.expired} |`);
lines.push('');
lines.push('阶梯的定义(`funnel.ts` `LADDER`,patch 叠在现行规则上):');
lines.push('');
for (const rung of LADDER) lines.push(`- \`${rung.key}\` — ${rung.label}:\`${JSON.stringify(rung.patch)}\``);
lines.push('');
lines.push('### 质量变体:同一底座上一次动一个旋钮');
lines.push('');
lines.push('阶梯回答"有没有单子",这一组回答"怎么把单子变成正期望"。底座与阶梯的 `win12+volbreak` 相同;最后一行是**对照组** —— 把所有条件都拆掉,只剩"跟着 1h EMA20/50 的方向,每 4 根开一次"。');
lines.push('');
lines.push('| 变体 | 机会 | 个/周 | 结算笔数 | 胜率 | 期望 R | 止损/止盈/到期 |');
lines.push('|---|---:|---:|---:|---:|---:|---|');
for (const a of aggVar) lines.push(`| ${a.label} | ${a.setups} | ${a.per_week.toFixed(1)} | ${a.outcome.n} | ${pct(a.outcome.win_rate)} | ${r2(a.outcome.expectancy_r)} | ${a.outcome.stops}/${a.outcome.tps}/${a.outcome.expired} |`);
lines.push('');
const ctrlR = control?.outcome.expectancy_r ?? null;
const comparable = aggVar.filter((a) => a.key !== 'v-control' && a.outcome.expectancy_r !== null);
const worseThanControl = ctrlR === null ? [] : comparable.filter((a) => a.outcome.expectancy_r < ctrlR);
const betterThanControl = ctrlR === null ? [] : comparable.filter((a) => a.outcome.expectancy_r >= ctrlR);
lines.push(ctrlR === null
  ? '对照组没有可结算的笔数,无从比较。'
  : `**对照组 ${r2(ctrlR)}R(${control.outcome.n} 笔)。** ${comparable.length} 个带条件的变体里 ${worseThanControl.length} 个比它差,${betterThanControl.length} 个不差于它${betterThanControl.length ? `:${betterThanControl.map((a) => `\`${a.key}\`(${r2(a.outcome.expectancy_r)}R)`).join('、')}` : ''}。带条件的变体普遍不如对照组时,说明这套筛选在该周期上没有可测的选品价值,主要作用只是把"顺着 1h 做"的样本量削小。`);
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
if (recMin !== null && recMax !== null) lines.push(`各代码的期望从 ${r2(recMin)}R 到 ${r2(recMax)}R。离散度远大于阶梯各级之间的差异时,单个代码上的正期望更像样本噪声,不是可复制的边。`);
lines.push('');

lines.push(`## 4. 候选代码在 ${venue} 上的存在性`);
lines.push('');
if (venue === '币安') {
  lines.push('`fetchExchangeInfo()` 只收 `contractType === \'PERPETUAL\'`,而币安的股票/商品永续是 **`TRADIFI_PERPETUAL`**;funnel 的存在性判断单独收了这一类。');
  lines.push('');
}
lines.push(`| 代码 | 合约类型 | 上线日 | 窗口内 ${report.timeframe} 根数 |`);
lines.push('|---|---|---|---:|');
for (const l of report.listed) {
  const s = report.symbols.find((x) => x.symbol === l.symbol);
  lines.push(`| ${l.symbol} | ${l.contract_type} | ${l.onboard ? new Date(l.onboard).toISOString().slice(0, 10) : '—'} | ${s?.bars ?? 0} |`);
}
lines.push('');
lines.push(report.missing.length ? `${notListedLabel()}(已跳过):${report.missing.join('、')}。` : '候选代码**全部存在**。');
lines.push('');
if (report.errors.length) {
  lines.push('拉数失败:');
  for (const e of report.errors) lines.push(`- ${e.symbol}: ${e.error}`);
  lines.push('');
}
lines.push('## 5. 读法与建议');
lines.push('');
lines.push(`1. **回踩窗口。** 现行窗口 ${CURRENT_THRESHOLDS.breakout_window} 根只认"最近这一根刚好收破";放到 12 根(\`win12\`)后联合通过从 ${cur?.joint ?? 0} 变成 ${win12?.joint ?? 0}(${win12 ? win12.per_week.toFixed(1) : 0} 个/周,期望 ${r2(win12?.outcome.expectancy_r)}R)。现行口径下"已收破突破位"的边际杀伤是 ${condTotals.find((c) => c.key === 'breakout').kills} 根。`);
lines.push('');
lines.push(`2. **量比看哪根。** 回踩天然缩量,量能确认该放在突破那根;质量变体里底座 ${r2(byKey('v-base')?.outcome.expectancy_r)}R,突破那根量比 ≥ 1.5 / 2.0 分别是 ${r2(byKey('v-vol15')?.outcome.expectancy_r)}R / ${r2(byKey('v-vol20')?.outcome.expectancy_r)}R。`);
lines.push('');
lines.push(`3. **ATR%、追单距离、日线状态。** 现行口径下它们的边际杀伤分别是 ${condTotals.find((c) => c.key === 'atr_ok').kills} / ${condTotals.find((c) => c.key === 'within_chase').kills} / ${condTotals.find((c) => c.key === 'regime_ok').kills} 根;放宽后多出来的单子期望见阶梯 \`atr\`(${r2(byKey('atr')?.outcome.expectancy_r)}R)/ \`chase2\`(${r2(byKey('chase2')?.outcome.expectancy_r)}R),"只做日线 bull/bear"见 \`v-trendonly\`(${r2(byKey('v-trendonly')?.outcome.expectancy_r)}R)。`);
lines.push('');
lines.push('4. **v2 草稿**:`breakout_retest` v2(`breakout_window=12`、`retest_vol_min=2`)状态停在 `backtest`,不进实盘 —— 实盘 `resolve()` 退回仍是 paper 的 v1。注意 `scanChecklist` 的回踩确认看的是**当根**量比,不是 v2 规则文字里的"突破那根"。');
lines.push('');
lines.push('## 6. 机械期望');
lines.push('');
lines.push(`阶梯上${positive.length ? `正期望的级别:${positive.map((a) => `\`${a.key}\`(${r2(a.outcome.expectancy_r)}R,${a.outcome.n} 笔)`).join('、')}` : '**没有任何一级是正期望**'};推荐级别 ${r2(rec.outcome.expectancy_r)}R(${rec.outcome.n} 笔),对照组 ${r2(ctrlR)}R(${control?.outcome.n ?? 0} 笔)。${report.outcome.tp_r}R 止盈 + 1R 止损的盈亏平衡胜率是 ${pct(breakevenWr)}${wrMin !== null ? `,笔数 ≥ 50 的各级胜率在 ${pct(wrMin)}–${pct(wrMax)} 之间` : ''}。`);
lines.push('');
lines.push(`这批候选的机械期望就是 agent 的基线:同一批候选、同一套止损止盈,机械执行是 ${r2(rec.outcome.expectancy_r)}R。**agent 的价值 = 它在这批候选上的期望 R 减去这个数**。`);
lines.push('');
lines.push(`> 期望 R 是机械执行的结果,不含模型取舍,也不含手续费与滑点;它回答"这批候选整体上是不是正期望",不回答"上线能赚多少"。${report.days} 天 × ${report.symbols.length} 个代码是一个样本,不是一条定律。`);
lines.push('');

const out = outArg ? resolve(outArg) : resolve(dirname(fileURLToPath(import.meta.url)), `../../../docs/research/zero-propose-funnel-${new Date(report.generated_at).toISOString().slice(0, 10)}.md`);
writeFileSync(out, lines.join('\n'));
console.error(`wrote ${out}`);
