/**
 * 批量研究结果 → Markdown 表(贴进 docs/research/batch-study-2026-09-23.md 的结果部分)。只读 results.json / summary.json / improve-top3.json。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-batch/report.ts > /tmp/batch.md
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FAMILY_LABEL, type FamilyKey } from '../../packages/gateway/src/demo/research/batch/families.ts';
import type { BatchRow, SlimScore } from '../../packages/gateway/src/demo/research/batch/study.ts';
import { BATCH_DIR } from './common.ts';

const S = JSON.parse(readFileSync(path.join(BATCH_DIR, 'summary.json'), 'utf8')) as { trials: number; leaderboard: BatchRow[]; champions: Record<string, string>; random: Record<string, { champion?: { total_return: number; sharpe: number | null; trades: number } | null; random?: { median_return: number | null; champion_percentile: number | null; returns: number[]; trades: number[] } | null; note?: string | null; error?: string }>; holdout: Record<string, { holdout?: SlimScore; per_asset?: { symbol: string; eligible: boolean; return: number | null; hold: number | null; trades: number }[]; error?: string }>; segments: Record<string, Record<string, { from_ms: number; to_ms: number }>> };
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const mk = (r: BatchRow) => `${r.market === 'spot' ? '现货' : '永续'}${r.side === 'short' ? '空' : r.side === 'long' ? '多' : r.side === 'long_short' ? '多空' : '中性'}`;
const rows = S.leaderboard, out: string[] = [];
const line = (xs: (string | number)[]) => out.push(`| ${xs.join(' | ')} |`);

out.push(`### 分段\n`);
line(['周期·市场', '训练', '验证', '留出']); line(['---', '---', '---', '---']);
for (const [k, s] of Object.entries(S.segments)) line([k, `${day(s.train!.from_ms)} ~ ${day(s.train!.to_ms)}`, `${day(s.validation!.from_ms)} ~ ${day(s.validation!.to_ms)}`, `${day(s.holdout!.from_ms)} ~ ${day(s.holdout!.to_ms)}`]);

out.push(`\n### 每族 × 周期 × 市场:训练段挑出的那一组参数(整池)在两段上的表现\n\n试验总数 ${S.trials}。每格只列训练段扣成本夏普最高的一组参数(训练段 ≥ 30 笔),验证段是它的复验;「超额」= 策略收益 − 同敞口持有。\n`);
line(['族', '周期', '市场', '参数', '训练 n', '训练收益', '训练夏普', '验证 n', '验证收益', '同敞口持有', '超额', '验证夏普', '每笔期望', '2×费率', 'DSR(验证)']); line(Array(15).fill('---'));
const groups = new Map<string, BatchRow[]>();
for (const r of rows.filter((x) => x.scope === 'pool')) { const k = `${r.family}|${r.timeframe}|${mk(r)}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
const order = ['15m', '1h', '4h', '1d'];
for (const [k, g] of [...groups].sort((a, b) => a[0].split('|')[0]!.localeCompare(b[0].split('|')[0]!) || order.indexOf(a[1][0]!.timeframe) - order.indexOf(b[1][0]!.timeframe) || a[0].localeCompare(b[0]))) {
  const ok = g.filter((r) => r.train.trades >= 30 && r.train.sharpe !== null).sort((a, b) => b.train.sharpe! - a.train.sharpe!), r = ok[0] ?? [...g].sort((a, b) => (b.train.sharpe ?? -9) - (a.train.sharpe ?? -9))[0]!;
  const v = r.validation, ex = v.exposure_matched_hold === null ? null : v.total_return - v.exposure_matched_hold;
  line([FAMILY_LABEL[r.family as FamilyKey], r.timeframe, mk(r), r.param + (ok.length ? '' : '(训练<30笔)'), r.train.trades, pct(r.train.total_return), num(r.train.sharpe), v.trades, pct(v.total_return), pct(v.exposure_matched_hold), pct(ex), num(v.sharpe), pct(v.expectancy, 2), pct(v.stressed_return), num(r.deflated?.validation ?? null)]);
  void k;
}

out.push(`\n### 排行榜(验证段扣成本夏普前 30,含筛资产版本)\n`);
line(['#', '变体', '范围', '验证 n', '验证收益', '持有', '同敞口持有', '夏普', '每笔期望', '2×费率', '回撤', 'DSR', '随机入场分位', '落库门槛']); line(Array(14).fill('---'));
rows.slice(0, 30).forEach((r, i) => { const v = r.validation, rnd = S.random[r.id]?.random; line([i + 1, r.variant_id, r.scope === 'screen5' ? `筛5:${v.members.map((m) => m.replace('USDT', '')).join('/')}` : `整池 ${v.members.length}`, v.trades, pct(v.total_return), pct(v.hold_return), pct(v.exposure_matched_hold), num(v.sharpe), pct(v.expectancy, 2), pct(v.stressed_return), pct(v.max_drawdown), num(r.deflated?.validation ?? null), rnd ? `${num((rnd.champion_percentile ?? 0) * 100, 0)}%(随机中位 ${pct(rnd.median_return)})` : '—', r.promotable ? '过' : (r.gates ?? []).filter((g) => !g.ok).map((g) => g.name).join('/')]); });

out.push(`\n### 每族冠军(只按训练段选)的留出段(一次)\n`);
line(['族', '冠军', '训练夏普', '验证收益/同敞口', '验证夏普', '留出 n', '留出收益', '留出持有', '留出同敞口持有', '留出夏普', '留出回撤', 'BTC / ETH 留出(策略 vs 持有)']); line(Array(12).fill('---'));
for (const [fam, id] of Object.entries(S.champions)) {
  const r = rows.find((x) => x.id === id)!, h = S.holdout[id], hv = h?.holdout, pa = h?.per_asset ?? [];
  const be = ['BTCUSDT', 'ETHUSDT'].map((s) => { const a = pa.find((x) => x.symbol === s); return a && a.eligible ? `${s.replace('USDT', '')} ${pct(a.return)} vs ${pct(a.hold)}` : `${s.replace('USDT', '')} —`; }).join(';');
  line([FAMILY_LABEL[fam as FamilyKey], id, num(r.train.sharpe), `${pct(r.validation.total_return)} / ${pct(r.validation.exposure_matched_hold)}`, num(r.validation.sharpe), hv?.trades ?? '—', pct(hv?.total_return), pct(hv?.hold_return), pct(hv?.exposure_matched_hold), num(hv?.sharpe), pct(hv?.max_drawdown), be]);
}
out.push(`\n### 随机入场基线(验证段,20 次,固定种子)\n`);
line(['变体', '策略验证收益(独立跑)', '随机中位', '策略高于随机的比例', '随机笔数中位', '说明']); line(Array(6).fill('---'));
for (const [id, x] of Object.entries(S.random)) { if (!x.random) { line([id, '—', '—', '—', '—', x.note ?? x.error ?? '']); continue; } const t = [...x.random.trades].sort((a, b) => a - b); line([id, pct(x.champion?.total_return), pct(x.random.median_return), `${num((x.random.champion_percentile ?? 0) * 100, 0)}%`, t.length ? t[Math.floor(t.length / 2)]! : '—', x.note ?? '']); }
const fam = new Map<string, number>(); for (const r of rows.filter((x) => x.promotable)) fam.set(r.family, (fam.get(r.family) ?? 0) + 1);
out.push(`\n过落库门槛的行:${rows.filter((r) => r.promotable).length} 个(${[...fam].map(([f, n]) => `${FAMILY_LABEL[f as FamilyKey]} ${n}`).join('、') || '无'})。`);
if (existsSync(path.join(BATCH_DIR, 'published.json'))) out.push(`\n落库:\n\n\`\`\`\n${readFileSync(path.join(BATCH_DIR, 'published.json'), 'utf8')}\n\`\`\``);
console.log(out.join('\n'));
