/**
 * Agent 页「Jev 判断流」+ 楼层用的 JudgeLiveTicker(components/judge-live/*,docs/design/jev-live-2026-09-25.md):
 * 纯函数、渲染、Agent 页挂载、英文词条齐全。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JudgeLiveItem, JudgeLiveSummary } from '../src/api/judge-live';
import { JudgeLiveFeedView, JudgeLiveTickerView, JUDGE_LIVE_EN } from '../src/components/judge-live';
import { comparisonLine, fmtUsd, microBadges, outcomeText, questionRows, summaryLine, verdict } from '../src/components/judge-live/logic';
import { EN } from '../src/lib/i18n-en';
import { setLang } from '../src/lib/i18n';

const NOW = Date.UTC(2026, 8, 25, 12);
function item(over: Partial<JudgeLiveItem> = {}): JudgeLiveItem {
  return {
    id: 'jl_1', decision_id: 'jd_1', run_id: 'run_a', strategy_id: 'rs_1', strategy_name: '突破回踩', symbol: 'BTCUSDT', timeframe: '1h', as_of: NOW - 3_600_000,
    mode: 'shadow', status: 'ok', action: 'follow',
    candidate: { candidate_id: 'c1', direction: 'long', entry: '100', stop: '98', target: '104', reward_risk: 2 },
    questions: [{ key: 'take', type: 'noul', instructions: '合理吗', labels: ['yes', 'no'] }, { key: 'quality', type: 'score', instructions: '质量', labels: ['poor', 'fair', 'good', 'excellent'] }],
    answers: [{ question_key: 'take', probabilities: { yes: 0.72, no: 0.28 } }, { question_key: 'quality', probabilities: { poor: 0.1, fair: 0.2, good: 0.5, excellent: 0.2 } }],
    predicates: [{ question_key: 'take', label: 'yes', probability: 0.72, conservative: 0.7, passed: true }, { question_key: 'quality', label: 'poor', probability: 0.1, conservative: 0.12, passed: true }],
    state: { candidate: { direction: 'long', reward_risk: 2 }, features: { trend: 'up', volatility: 0.0123, liq_long_5m: '1200' }, micro: { requested: true, book: false, liquidations: true, used: false, note: 'book_stale_or_missing' } },
    reason_codes: [], cost_usd: '0.00003', latency_ms: 820, error: null, model: 'typesafe/jev-1.13-20260917', created_at: NOW - 60_000,
    outcome: { thread_id: 't1', status: 'closed', opened: true, closed: true, realized_r: 1.5 },
    ...over,
  };
}
const summary: JudgeLiveSummary = {
  day_start: NOW - 12 * 3_600_000,
  today: { judged: 3, calls: 2, cost_usd: '0.00006', reserved_usd: '0', follow: 1, skip: 1, follow_ratio: 0.5, errors: 0, skipped: 1, shadow: 2, gate: 1, skip_reasons: { decision_model_unbound: 1 } },
  budgets: [{ run_id: 'run_a', max_calls: 200, calls: 2, max_usd: '0.03', spent_usd: '0.00006', reserved_usd: '0' }],
  comparison: { window_from: NOW - 30 * 86_400_000, follow: { judged: 4, traded: 3, closed: 2, wins: 2, realized_r_sum: 3, avg_r: 1.5 }, skip: { judged: 2, traded: 1, closed: 1, wins: 0, realized_r_sum: -1, avg_r: -1 } },
};
const gate = item({ id: 'jl_2', mode: 'gate', action: 'skip', symbol: 'ETHUSDT', candidate: { candidate_id: 'c2', direction: 'short', entry: '2000', stop: '2050', target: null, reward_risk: null }, answers: [{ question_key: 'take', probabilities: { yes: 0.2, no: 0.8 } }], questions: [{ key: 'take', type: 'noul', instructions: 'x', labels: ['yes', 'no'] }], predicates: [{ question_key: 'take', label: 'yes', probability: 0.2, conservative: 0.18, passed: false }], outcome: null });
const skipped = item({ id: 'jl_3', status: 'skipped', action: null, answers: [], predicates: [], state: null, reason_codes: ['decision_model_unbound'], cost_usd: '0', error: 'decision_model_unbound', outcome: null });

describe('judge-live logic', () => {
  it('问题行:按标签顺序出概率段,取最高标签,标出规则没过', () => {
    const rows = questionRows(item());
    expect(rows.map(r => r.name)).toEqual(['该不该做', '候选质量']);
    expect(rows[0]!.segments.map(s => [s.name, s.p])).toEqual([['是', 0.72], ['否', 0.28]]);
    expect(rows[1]!.top).toMatchObject({ name: '好', p: 0.5 });
    expect(questionRows(gate)[0]!.passed).toBe(false);
  });
  it('结论、费用、盘口/清算可用性、结果', () => {
    expect(verdict(item())).toEqual({ text: '跟', tone: 'up' });
    expect(verdict(gate)).toEqual({ text: '不跟', tone: 'down' });
    expect(verdict(skipped).text).toBe('没调用');
    expect(verdict(item({ status: 'uncertain', action: 'skip' })).text).toBe('拿不准 · 不跟');
    expect(verdict(item({ mode: 'gate', status: 'error', action: 'skip' })).text).toBe('出错 · 不跟');
    expect([fmtUsd('0.00003'), fmtUsd('0'), fmtUsd('1.234'), fmtUsd(null)]).toEqual(['$0.00003', '$0', '$1.23', '—']);
    expect(microBadges(item().state).map(b => [b.text, b.ok])).toEqual([['盘口:不可用', false], ['清算:可用', true], ['没带进问题', false]]);
    expect(outcomeText(item())).toBe('已平仓 +1.50R');
    expect(outcomeText(gate)).toBe('没关联到线程');
  });
  it('汇总与对照', () => {
    expect(summaryLine(summary)).toEqual({ calls: '2', cost: '$0.00006', ratio: '跟 1 / 不跟 1(50%)', modes: '影子 2 · 挡单 1' });
    expect(comparisonLine(summary)).toBe('近 30 天:Jev 说跟的平仓 2 笔、平均 +1.50R;说不跟的平仓 1 笔、平均 -1.00R');
    expect(summaryLine(undefined).calls).toBe('—');
  });
});

describe('JudgeLiveFeedView / JudgeLiveTickerView 渲染', () => {
  it('列表:时间、币种方向、问题概率条、跟不跟、影子/挡单、费用;顶部今日汇总', () => {
    const html = renderToStaticMarkup(<JudgeLiveFeedView items={[item(), gate, skipped]} summary={summary} />);
    for (const s of ['今日调用', '跟 1 / 不跟 1(50%)', '影子 2 · 挡单 1', 'BTCUSDT', 'ETHUSDT', '影子', '挡单', '该不该做', '候选质量', '是 72%', '好 50%', '$0.00003', '决策模型没绑定', '近 30 天']) expect(html, s).toContain(s);
    expect(html).toContain('width:72%');
    expect(html).not.toContain('盘口:不可用'); // 未展开
  });
  it('展开一条:state 摘要,盘口/清算可用性标出来,后来的结果', () => {
    const html = renderToStaticMarkup(<JudgeLiveFeedView items={[item()]} summary={summary} openId="jl_1" />);
    for (const s of ['盘口:不可用', '清算:可用', '盘口快照过期或缺失', '趋势', '向上', '近 5 分钟多头清算', '入场 100 · 止损 98 · 目标 104', '后来:已平仓 +1.50R', '关掉这个运行的影子判断', '耗时 820 ms']) expect(html, s).toContain(s);
  });
  it('空列表与出错', () => {
    expect(renderToStaticMarkup(<JudgeLiveFeedView items={[]} />)).toContain('还没有实盘判断');
    expect(renderToStaticMarkup(<JudgeLiveFeedView items={[]} error="boom" />)).toContain('判断流读取失败:boom');
  });
  it('紧凑版 ticker', () => {
    const html = renderToStaticMarkup(<JudgeLiveTickerView items={[item(), gate]} summary={summary} limit={1} />);
    expect(html).toContain('Jev 今日 2 次'); expect(html).toContain('BTC'); expect(html).toContain('该不该做 是 72%'); expect(html).not.toContain('ETH');
    expect(renderToStaticMarkup(<JudgeLiveTickerView items={[]} showSummary={false} />)).toContain('还没有实盘判断');
  });
  it('英文界面', () => {
    setLang('en');
    try {
      const html = renderToStaticMarkup(<JudgeLiveFeedView items={[item(), gate]} summary={summary} openId="jl_1" />);
      for (const s of ['Calls today', 'Shadow', 'Gate', 'Follow', 'Skip', 'Take it?', 'Order book: unavailable', 'Liquidations: available']) expect(html, s).toContain(s);
    } finally { setLang('zh'); }
  });
});

describe('挂载与英文词条', () => {
  it('Agent 页右栏有「Jev 判断」tab', () => {
    const src = readFileSync(new URL('../src/components/agent-side.tsx', import.meta.url), 'utf8');
    expect(src).toContain('<JudgeLiveFeed />'); expect(src).toContain('value="jev"');
  });
  it('判断流用到的中文都有英文,且已并进总词典', () => {
    const zh = new Set<string>();
    for (const f of ['logic.ts', 'judge-live-feed.tsx', 'judge-live-ticker.tsx']) {
      const s = readFileSync(new URL(`../src/components/judge-live/${f}`, import.meta.url), 'utf8');
      for (const m of s.matchAll(/\bt\('([^']+)'/g)) zh.add(m[1]!);
      for (const block of s.matchAll(/tmap\(\{([\s\S]*?)\}\)/g)) for (const m of block[1]!.matchAll(/:\s*'([^']+)'/g)) zh.add(m[1]!);
    }
    expect(zh.size).toBeGreaterThan(50);
    for (const k of zh) expect(JUDGE_LIVE_EN[k] ?? EN[k], k).toBeTruthy();
    for (const k of ['Jev 判断', '每条候选 Jev 怎么判 · 影子只记录不挡单']) expect(EN[k], k).toBeTruthy();
  });
});
