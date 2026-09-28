/**
 * 后端文案英文化(lib/server-text-en.ts):句式表对真实样本的覆盖率 + 关键句式 + 语言开关行为。
 * 样本 test/server-text-en.samples.json 来自 18811 的只读 GET(见文件内 source 字段)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverTextEn, st } from '../src/lib/server-text-en';
import { setLang } from '../src/lib/i18n';

interface Row { field: string; text: string; count: number }
const SAMPLES = JSON.parse(readFileSync(join(__dirname, 'server-text-en.samples.json'), 'utf8')) as { rows: Row[] };
const HAN = /[㐀-鿿]/;

/** 「」里的新闻标题是外部内容,不算残留中文 */
const residualHan = (s: string) => HAN.test(s.replace(/"[^"]*"/g, ''));

export function coverage(rows: Row[]) {
  let total = 0;
  let hit = 0;
  let clean = 0;
  const byField: Record<string, { total: number; hit: number }> = {};
  const misses: Row[] = [];
  for (const r of rows) {
    const out = serverTextEn(r.text);
    total += r.count;
    const f = (byField[r.field] ??= { total: 0, hit: 0 });
    f.total += r.count;
    if (out !== null) {
      hit += r.count;
      f.hit += r.count;
      if (!residualHan(out)) clean += r.count;
    } else misses.push(r);
  }
  return { total, hit, clean, rate: hit / total, byField, misses };
}

describe('server-text-en', () => {
  afterEach(() => setLang('zh'));

  it('covers ≥ 90% of real backend occurrences, and every field ≥ 90%', () => {
    const c = coverage(SAMPLES.rows);
    const report = Object.entries(c.byField).map(([k, v]) => `${k} ${v.hit}/${v.total}`).join(' · ');
    console.log(`[server-text coverage] ${c.hit}/${c.total} = ${(c.rate * 100).toFixed(1)}% · no residual CJK outside news headlines ${c.clean}/${c.total} · ${report}`);
    console.log(`[server-text misses] ${c.misses.sort((a, b) => b.count - a.count).slice(0, 10).map((m) => `${m.count}× ${m.text.slice(0, 60)}`).join(' | ')}`);
    expect(c.rate).toBeGreaterThanOrEqual(0.9);
    for (const [field, v] of Object.entries(c.byField)) expect(v.hit / v.total, field).toBeGreaterThanOrEqual(0.9);
  });

  it('translates common patterns, keeping symbols and numbers', () => {
    expect(serverTextEn('[perp] LINKUSDT 急跌 0.98%')).toBe('[perp] LINKUSDT sharp drop 0.98%');
    expect(serverTextEn('[perp] BTCUSDT 触发:突破')).toBe('[perp] BTCUSDT trigger: breakout');
    expect(serverTextEn('[perp] ETHUSDT 出策略:做空 限价 4012.5,止损 4100')).toBe('[perp] ETHUSDT plan: Short limit 4012.5, stop 4100');
    expect(serverTextEn('风控:账户/行情组件过期 433 秒 ×3')).toBe('Risk: Account/market data stale for 433 s ×3');
    expect(serverTextEn('5 分钟内 急跌 0.98%(阈值 0.8%)')).toBe('Dropped 0.98% within 5 min (threshold 0.8%)');
    expect(serverTextEn('信息员:高波动,偏中性')).toBe('Intel: high volatility, neutral');
    // 样本外(采样后新出现的句式)
    expect(serverTextEn('[perp] SOLUSDT 提议做多被代码闸拦下')).toBe('[perp] SOLUSDT Long proposal blocked by a code gate');
    expect(serverTextEn('SOLUSDT 无行情,用持仓自带标记价;XRPUSDT 无行情,用持仓自带标记价')).toBe("SOLUSDT has no quote; using the position's mark price; XRPUSDT has no quote; using the position's mark price");
  });

  it('keeps news headlines verbatim inside event-window details', () => {
    const out = serverTextEn('事件窗口内:hack「某交易所被盗」(已开始 12 分钟,可信度 reported)(15m K 线 08:30 UTC 收盘)');
    expect(out).toBe('In event window: hack "某交易所被盗" (started 12 min ago, credibility reported) (15m bar closed 08:30 UTC)');
  });

  it('returns null for unknown sentences; composite strings need every segment known', () => {
    expect(serverTextEn('这是一句模型现写的总结')).toBeNull();
    expect(serverTextEn('账户快照不完整;这是一句不认识的')).toBeNull();
    expect(serverTextEn('no chinese here')).toBe('no chinese here');
  });

  it('st(): zh passthrough, en translates, unknown stays as-is, nullish safe', () => {
    setLang('zh');
    expect(st('账户快照不完整')).toBe('账户快照不完整');
    setLang('en');
    expect(st('账户快照不完整')).toBe('Account snapshot incomplete');
    expect(st('这是一句模型现写的总结')).toBe('这是一句模型现写的总结');
    expect(st(null)).toBeNull();
    expect(st(undefined)).toBeUndefined();
  });
});

/** 矩阵研究 / 海选:模板对着 gateway demo/research/matrix-study 的 compute.ts / scorecard.ts 与 improve/data.ts 写 */
describe('server-text-en: matrix study', () => {
  const REPLAY = '(历史回放:这段历史已被人看过,只能算回放证据,进实盘前还要前向验证)';
  const CAND = '候补 3 组(只差样本数 / 显著性,可先用模拟盘观察;候补不算通过)';
  const cases: [string, string][] = [
    [`2 条策略在留出段通过 Holm 校正检验:BTCUSDT 4h breakout/long/code;ETHUSDT 1d 「我的均线」v2/short/jev。另有${CAND}。其余不合格主因:费用吃掉 4、样本不足 9${REPLAY}`,
      '2 strategies passed the Holm-corrected test on the holdout: BTCUSDT 4h breakout/long/code; ETHUSDT 1d 「我的均线」v2/short/jev. Also 3 paper candidates (only short on sample size / significance; can be watched on paper first; candidates don\'t count as passes). Main reasons for the rest: eaten by fees 4, insufficient sample 9 (historical replay: this history has been seen before, so it only counts as replay evidence; forward validation is still required before going live)'],
    [`没有能直接上实盘的策略,但有 3 组值得先用模拟盘看看:${CAND}。40 个可评估格子、2 个 finalist 在留出段未通过;主因分布:跑输持有 20、执行不支持 1;另有 4 格不适用、2 格仅研究(3m/5m)`,
      "No strategy is ready for live trading, but 3 are worth watching on paper first: 3 paper candidates (only short on sample size / significance; can be watched on paper first; candidates don't count as passes). 40 evaluable cells, 2 finalists failed on the holdout; main reasons: underperformed buy-and-hold 20, execution unsupported 1; plus 4 cells not applicable and 2 research-only (3m/5m)"],
    [`没有找到通过门槛的策略。63 个可评估格子;主因分布:无;另有 9 格不适用、0 格仅研究(3m/5m)${REPLAY}`,
      'No strategy passed the gate. 63 evaluable cells; main reasons: none; plus 9 cells not applicable and 0 research-only (3m/5m) (historical replay: this history has been seen before, so it only counts as replay evidence; forward validation is still required before going live)'],
    ['试了 120 个版本(本格 12 个、这次研究 60 个);按这么多次试验折算,这组选择段成绩约 73% 的可能是运气,更像碰巧 —— 先用模拟盘看前向表现',
      '120 versions tried (12 in this cell, 60 in this study); adjusted for that many trials, there is about a 73% chance this selection-period result is luck — more likely a fluke; watch forward performance on paper first'],
    ['试了 8 个版本(本格 2 个、这次研究 8 个);按这么多次试验折算,这组选择段成绩约 12% 的可能是运气(DSR 不可用,按试验数做 Bonferroni)',
      '8 versions tried (2 in this cell, 8 in this study); adjusted for that many trials, there is about a 12% chance this selection-period result is luck (DSR unavailable; Bonferroni by trial count)'],
    ['试了 8 个版本(本格 2 个、这次研究 8 个);选择段样本太少,算不出运气折扣,先当它是运气',
      '8 versions tried (2 in this cell, 8 in this study); too few selection-period samples to estimate a luck discount, so treat it as luck for now'],
    ['平仓 7 笔,不到 20 笔', '7 closed trades, fewer than 20'],
    ['只有 3 个时间块,不到 4 个', 'only 3 time blocks, fewer than 4'],
    ['显著性不够(DSR 0.41,门槛 0.9)', 'not significant enough (DSR 0.41, threshold 0.9)'],
    ['没过:selection_return>0', 'failed: selection_return>0'],
    ['选择段净收益不为正', 'selection-period net return not positive'],
    ['没跑赢同敞口持有', 'did not beat exposure-matched buy-and-hold'],
    ['回撤 32.5% 超过门槛 25%', 'drawdown 32.5% above the 25% limit'],
    ['评分卡 poor(至少 fair)', 'scorecard poor (needs at least fair)'],
    ['平仓 2 笔,候补至少 5 笔', '2 closed trades; candidates need at least 5'],
    ['选择段门槛全过,没进最终验收名额', 'passed all selection gates but did not get a final-validation slot'],
    ['原门槛全过,最终验收通过', 'passed all original gates and final validation'],
    ['最终验收没通过', 'failed final validation'],
    ['同一格的最终候选没过最终验收', "this cell's finalist failed final validation"],
    ['选择段门槛全过,等最终验收', 'passed all selection gates; awaiting final validation'],
    ['执行不支持', 'execution unsupported'],
    ['4h:资产池只有 3 个资产,少于设计要求的 4 个,结论只作观察', '4h: the asset pool has only 3 assets, fewer than the 4 the design requires; treat the conclusion as observational only'],
  ];
  it.each(cases)('%s', (zh, en) => {
    expect(serverTextEn(zh)).toBe(en);
  });
});
