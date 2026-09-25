/**
 * 把 perp-trend-run.ts 的 results.json 汇成 markdown 表(写 ~/.trading-swarm-okx/research-batch/perp-trend/tables.md 并打印),报告正文引用这些表。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/perp-trend-report.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BATCH_DIR } from './common.ts';

const DIR = path.join(BATCH_DIR, 'perp-trend'), r = JSON.parse(readFileSync(path.join(DIR, 'results.json'), 'utf8'));
const SIG = ['ema20_100_vt', 'ema50_200_vt'], LEV = [1, 2, 3], SZ = ['equal', 'equal_vt', 'inv_vol'];
const SZL: Record<string, string> = { equal: '等权', equal_vt: '等权+50%波动目标', inv_vol: '等风险(1/σ)' };
const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);
const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
const f2 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2));
const iso = (t: number) => new Date(t + 1).toISOString().slice(0, 10);
const obs = (n: number) => (n < 30 ? `${n}(观察)` : String(n));
const out: string[] = [];
const P = (s = '') => out.push(s);
const seg = r.segments;
P(`切段(永续 4h,makeSegments):训练 ${iso(seg.train.from_ms)}~${iso(seg.train.to_ms)} / 验证 ${iso(seg.validation.from_ms)}~${iso(seg.validation.to_ms)} / 留出 ${iso(seg.holdout.from_ms)}~${iso(seg.holdout.to_ms)}`);
P();
P('### 复现校验(1 倍、每笔 100% 权益、不叠波动率目标,验证段独立跑,独立子账户等资金)');
P('| 信号 | 无标记价(批量研究口径) | 有标记价 | 笔数 |'); P('|---|---|---|---|');
for (const s of SIG) { const c = r.check[s]; if (c) P(`| ${s} | ${pct(c.no_mark.total_return, 2)} | ${pct(c.with_mark.total_return, 2)} | ${c.with_mark.trades} |`); }
P();
P('### 标记价覆盖');
P('| 资产 | 首根标记价 | 对齐缺失根数 | max_lever(当前) |'); P('|---|---|---|---|');
for (const f of readdirSync(path.join(DIR, 'data')).sort()) { const j = JSON.parse(readFileSync(path.join(DIR, 'data', f), 'utf8')); P(`| ${j.symbol.replace('USDT', '')} | ${j.mark_first_open ? new Date(j.mark_first_open).toISOString().slice(0, 10) : '—'} | ${j.mark_missing}/${j.bars} | ${j.max_lever} |`); }
P();
for (const sg of ['train', 'validation']) {
  const any = r.main[`${SIG[0]}:x1:${sg}`];
  P(`### ${sg === 'train' ? '训练段' : '验证段'}:18 个配置(组合 $10k 起;成员 ${any?.members.length} 个:${any?.members.map((x: string) => x.replace('USDT', '')).join(' ')})`);
  P(`基准:资产池等权持有 ${pct(any?.hold_equal.total_return)}(回撤 ${pct(any?.hold_equal.max_drawdown)},夏普 ${f2(any?.hold_equal.sharpe)}),等风险持有 ${pct(any?.hold_inv_vol.total_return)}(回撤 ${pct(any?.hold_inv_vol.max_drawdown)}),BTC 持有 ${pct(any?.btc_hold?.total_return)}(回撤 ${pct(any?.btc_hold?.max_drawdown)})。`);
  P();
  P('| 信号 | 杠杆 | 仓位 | 收益 | $10k→ | 回撤 | 夏普 | 平均敞口 | 同敞口持有 | 2×费率 | 随机入场中位 | 高于随机 |'); P('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of SIG) for (const L of LEV) {
    const m = r.main[`${s}:x${L}:${sg}`], rnd = sg === 'validation' ? r.random[`${s}:x${L}:validation`] : null; if (!m) continue;
    for (const z of SZ) {
      const x = m.results[z]; let rm = '—', above = '—';
      if (rnd) { const rs: number[] = rnd.random[z].returns, srt = [...rs].sort((a, b) => a - b), below = rs.filter((v) => v < x.total_return).length; rm = pct(srt[Math.floor((srt.length - 1) / 2)]); above = `${below}/${rs.length}`; }
      P(`| ${s} | ${L}× | ${SZL[z]} | ${pct(x.total_return)} | ${usd(x.final_usd)} | ${pct(x.max_drawdown)} | ${f2(x.sharpe)} | ${x.avg_exposure.toFixed(2)} | ${pct(x.exposure_matched_hold)} | ${pct(x.stressed_return)} | ${rm} | ${above} |`);
    }
  }
  P();
  P(`逐笔(保证金上的收益,含杠杆、扣费与资金费;与仓位规则无关,每个 信号×杠杆 一行):`);
  P('| 信号 | 杠杆 | 已平仓笔数 | 平均 | 中位数 | 截尾均值(两端各10%) | 胜率 | 强平笔数 | 执行核出场原因 |'); P('|---|---|---|---|---|---|---|---|---|');
  for (const s of SIG) for (const L of LEV) { const m = r.main[`${s}:x${L}:${sg}`]; if (!m) continue; const t = m.results.equal.trades; P(`| ${s} | ${L}× | ${obs(t.closed)} | ${pct(t.mean)} | ${pct(t.median)} | ${pct(t.trimmed)} | ${pct(t.win_rate, 0)} | ${t.liquidations} | ${Object.entries(m.exit_reasons).map(([k, v]) => `${k} ${v}`).join(',')} |`); }
  P();
}
if (r.selection) { P(`### 选择(只看训练段)`); P(`规则:${r.selection.rule}。过门槛:${r.selection.passed.join('、') || '无'}。选中:**${r.selection.pick.id}**(训练段 ${pct(r.selection.pick.train.total_return)},回撤 ${pct(r.selection.pick.train.max_drawdown)},${r.selection.pick.train.trades} 笔)。`); P(); }
if (r.holdout) {
  const pk = r.selection.pick, h = r.holdout, x = h.results[pk.sizing], t = x.trades, rnd = r.holdout_random?.random?.[pk.sizing];
  P(`### 留出段(只跑一次:${pk.id};成员 ${h.members.length} 个:${h.members.map((s: string) => s.replace('USDT', '')).join(' ')})`);
  P('| 对象 | 收益 | $10k→ | 盈亏 | 回撤 | 夏普 |'); P('|---|---|---|---|---|---|');
  P(`| 策略 ${pk.id} | ${pct(x.total_return)} | ${usd(x.final_usd)} | ${usd(x.pnl_usd)} | ${pct(x.max_drawdown)} | ${f2(x.sharpe)} |`);
  P(`| 资产池等权持有 | ${pct(h.hold_equal.total_return)} | ${usd(h.hold_equal.final_usd)} | ${usd(h.hold_equal.pnl_usd)} | ${pct(h.hold_equal.max_drawdown)} | ${f2(h.hold_equal.sharpe)} |`);
  P(`| 等风险持有 | ${pct(h.hold_inv_vol.total_return)} | ${usd(h.hold_inv_vol.final_usd)} | ${usd(h.hold_inv_vol.pnl_usd)} | ${pct(h.hold_inv_vol.max_drawdown)} | ${f2(h.hold_inv_vol.sharpe)} |`);
  if (h.btc_hold) P(`| BTC 持有 | ${pct(h.btc_hold.total_return)} | ${usd(h.btc_hold.final_usd)} | ${usd(h.btc_hold.pnl_usd)} | ${pct(h.btc_hold.max_drawdown)} | ${f2(h.btc_hold.sharpe)} |`);
  P(`| 同敞口持有(${pk.sizing === 'inv_vol' ? '等风险' : '等权'}持有 × 平均敞口 ${x.avg_exposure.toFixed(2)}) | ${pct(x.exposure_matched_hold)} | ${usd(10000 * (1 + x.exposure_matched_hold))} | ${usd(10000 * x.exposure_matched_hold)} | — | — |`);
  if (rnd) { const srt = [...rnd.returns].sort((a: number, b: number) => a - b), below = rnd.returns.filter((v: number) => v < x.total_return).length; P(`| 随机入场(20 次)中位 | ${pct(srt[Math.floor((srt.length - 1) / 2)])} | ${usd(10000 * (1 + srt[Math.floor((srt.length - 1) / 2)]))} | — | 中位 ${pct([...rnd.mdd].sort((a: number, b: number) => a - b)[9])} | — |`); P(); P(`策略高于 ${below}/20 次随机入场(随机收益区间 ${pct(srt[0])} ~ ${pct(srt.at(-1))},入场概率 ${(r.holdout_random.p * 100).toFixed(3)}%/根)。`); }
  P(`2×手续费:${pct(x.stressed_return)}。平均敞口 ${x.avg_exposure.toFixed(2)},在场时间 ${pct(x.in_market, 0)},现金不足按可用现金下单 ${x.cash_capped} 次。`);
  P(`逐笔:${obs(t.closed)} 笔已平仓(另 ${t.n - t.closed} 笔期末未平),平均 ${pct(t.mean)},中位数 ${pct(t.median)},截尾均值 ${pct(t.trimmed)},胜率 ${pct(t.win_rate, 0)},强平 ${t.liquidations} 笔;出场原因 ${Object.entries(h.exit_reasons).map(([k, v]) => `${k} ${v}`).join(',')}。每资产笔数 ${Object.entries(x.per_asset_trades).map(([k, v]) => `${k.replace('USDT', '')} ${v}`).join(' ')}。`);
}
writeFileSync(path.join(DIR, 'tables.md'), out.join('\n'));
console.log(out.join('\n'));
