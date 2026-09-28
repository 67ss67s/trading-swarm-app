// 策略研究报告交付质量(09-27):没映射上的想法不交付 0 笔 / 占位回测;交付 JSON 一律英文;矩阵报告以近失格子为头条、写明窗口加长与下一步。
import { describe, expect, it } from 'vitest';
import type { ResearchBar, StrategyIR } from '@trade-gate/contracts';
import { synthBars } from './research/backtest-report-fixtures.js';
import { makeResearchReportService, researchReportService, RESEARCH_REPORT_KEY, type ResearchReportDeps } from '../../src/demo/asp-agent/services/research-report.js';
import { buildIR, closestIdea, compileNotes, degenerateReason, englishOnly, FAMILY_EXAMPLE, validateQuick, COMPILE_ENGLISH_HINT, type QuickFamily } from '../../src/demo/asp-agent/services/quick-backtest.js';
import { EVIDENCE_WINDOW_DAYS } from '../../src/demo/asp-agent/services/matrix-report.js';
import { STRUCTURED_HEADER } from '../../src/demo/asp-agent/services/render.js';
import type { MatrixLike, MatrixViewLike, PerCallJob } from '../../src/demo/asp-agent/services/types.js';
import { BANNED_WORDS } from '../../src/demo/asp-agent/publisher.js';

const NOW = Date.UTC(2026, 8, 25, 0, 0, 0);
const CJK = /[　-〿一-鿿＀-￯]/;
const job = (description: string, service_params: string | null = null, job_id = 'job-q-1'): PerCallJob => ({ job_id, service_key: RESEARCH_REPORT_KEY, description, service_params });
const human = (text: string) => text.split(`\n\n${STRUCTURED_HEADER}`)[0]!;
const json = (text: string) => text.split(`\n\n${STRUCTURED_HEADER}`)[1]!;

function deps(extra: Partial<ResearchReportDeps> = {}): ResearchReportDeps {
  return {
    now: () => NOW, recommend: async () => { throw new Error('recommend_not_expected'); }, matrix: () => null, bars: async () => [], regime: async () => null, sleep: async () => {}, poll_ms: 1,
    backtestBars: async (_symbol, timeframe, w, market) => {
      const step = timeframe === '1d' ? 86_400_000 : timeframe === '4h' ? 14_400_000 : timeframe === '1h' ? 3_600_000 : 900_000;
      const n = Math.floor((w.to_ms + 1 - w.from_ms) / step), bars: ResearchBar[] = synthBars(n, step, 11, w.to_ms + 1 - n * step, 100);
      if (market === 'perp') return { bars, source: 'synthetic:perp', perp: { inst_id: 'X-USDT-SWAP', timeframe, bars, mark: bars.map(() => null), funding: { points: [], from_ms: w.from_ms, to_ms: w.to_ms }, funding_provenance: {} as never, tiers: [], lever_tiers: [] as never, max_lever: 50, provenance: {} as never } as never };
      return { bars, source: 'synthetic:spot' };
    },
    ...extra,
  };
}

/** 09-26 真实失败单的模型编译结果(0x2a1a…):占位入场 price>0 + 中文标签 / 描述 / 未映射原因 */
const REAL_FAILED_TEXT = 'Backtest BTC 1h strategy: enter long after 3 consecutive green candles, exit on 1% profit or 0.5% stop loss.';
const PLACEHOLDER_IR = {
  version: 1, label: 'BTC 1h 三连阳做多，1%止盈/0.5%止损', description: '1h 执行周期：连续 3 根阳线后做多。',
  signal: [{ primitive: 'indicator_cross', params: { indicator: 'price', compare_to: 'constant', constant: 0, direction: 'cross_above' }, optional: false }],
  entry: { primitive: 'next_open_market', params: {} },
  risk: { stop: { primitive: 'pct_offset_level', params: { pct: 0.005 } }, sizing: { primitive: 'equal_notional', params: { max_allocation: '1' } } },
  order: { direction: 'long', market: 'spot', entry: { type: 'market' }, take_profits: [{ source: { primitive: 'pct_offset_level', params: { pct: 0.01 } } }] },
  exit: [],
} as unknown as StrategyIR;
const REAL_UNMAPPED = [
  '3 consecutive green candles（连续 3 根阳线）:目录无 K 线形态计数原语（仅有单根吞没/针形等），无法表达连续 3 根阳线的触发条件；indicator_cross 占位为无效信号，需新增形态计数原语后才能实现。',
  '1% profit / 0.5% stop loss 的百分比目标（已映射为 pct_offset_level）:说明：百分比止盈/止损偏离策略规范首选的结构位口径。',
];

describe('quick: never deliver a meaningless model-compiled backtest', () => {
  const nl = makeResearchReportService({ nl_compile: true });

  it('the real failed 09-26 request now maps to the deterministic streak template (no model call)', () => {
    expect(validateQuick(job(REAL_FAILED_TEXT))).toMatchObject({ idea: { source: 'template', family: 'streak' } });
  });

  it('placeholder entry (price vs 0) → not_mapped: explains why, runs the closest template as a labelled reference, JSON has no CJK', async () => {
    const text = 'Backtest BTC 1h: buy when a hammer candle prints right at support, exit on 1% profit or 0.5% stop loss.';
    const p = nl.validate(job(text));
    expect(p).toMatchObject({ tier: 'quick', quick: { idea: { source: 'text' } } });
    const seen: string[] = [];
    const out = await nl.handle(job(text), p, deps({ compile: async (t) => { seen.push(t); return { ir: PLACEHOLDER_IR, unmapped: REAL_UNMAPPED, model: 'pi:zai/glm-5.3', usd: null }; } }));
    expect(seen).toEqual([text + COMPILE_ENGLISH_HINT]);
    const h = human(out.text), ls = h.split('\n');
    expect(ls[1]).toMatch(/^BTC 1h: your rule could not be mapped to supported backtest rules, so it was not tested as described · reference \(closest supported template, Candle streak\): return -?\d/);
    expect(h).toMatch(/Status: NOT TESTED AS DESCRIBED\. The compiled entry condition is a placeholder/);
    expect(h).toMatch(/Could not map: 3 consecutive green candles; 1% profit \/ 0\.5% stop loss/);
    expect(h).toMatch(/It is NOT your strategy/);
    // 带买方 0.5% 止损 / 1% 止盈的模板在合成行情上一笔没成交 → 参考结果退回族缺省风控,并写明
    expect(h).toMatch(/Reference strategy: Enter long after 3 consecutive green candles.*stop 2×ATR14, target 2R/);
    expect(h).toMatch(/Note: With the stop\/target from your request the reference template never traded, so it is shown with its default risk rules/);
    expect(h).toMatch(/Next step: rephrase the entry as one supported rule and order again, e.g\. "BTC 1h: go long after 3 consecutive green candles/);
    expect(h).not.toMatch(/0 trades \(no trades triggered/);
    expect(h).not.toMatch(CJK);
    expect(json(out.text)).not.toMatch(CJK);
    expect(BANNED_WORDS.test(h)).toBe(false);
    expect(out.payload).toMatchObject({ outcome: 'not_mapped', tested_as_described: false, requested: { ir_source: 'model', strategy_ir: { label: 'Custom 1h strategy' } }, reference: { family: 'streak', ir_source: 'template' } });
    expect((out.payload["reference"] as { metrics: { trades: number } }).metrics.trades).toBeGreaterThan(0);
    expect(out.payload['metrics']).toBeUndefined(); // 顶层不放数字,免得被当成买方策略的成绩
  });

  it('an asset with no rule at all is accepted (reviewers\' test orders must not be declined) and answered without a model call', async () => {
    for (const text of ['BTC 4h 我觉得会涨,帮我看看', 'Please check BTC 4h for me, I have a good feeling']) {
      const p = nl.validate(job(text));
      let calls = 0;
      const out = await nl.handle(job(text), p, deps({ compile: async () => { calls++; return { ir: null, unmapped: [], model: 'm', usd: null }; } }));
      expect(calls).toBe(0);
      expect(out.payload['outcome']).toBe('not_mapped');
      const h = human(out.text);
      expect(h).toMatch(/Status: NOT TESTED AS DESCRIBED\. The request names an asset but states no entry or exit rule/);
      expect(h).toMatch(/no close match found; the general channel-breakout template is shown/);
      expect(h).not.toMatch(CJK);
      expect(json(out.text)).not.toMatch(CJK);
    }
  });

  it('compile returns no usable IR → not_mapped without throwing (no paid retries)', async () => {
    const text = 'BTC 4h: enter when funding flips negative and open interest spikes';
    let calls = 0;
    const out = await nl.handle(job(text), nl.validate(job(text)), deps({ compile: async () => { calls++; return { ir: null, unmapped: ['模型 3 次输出未能解析；未执行任何策略'], model: 'm', usd: null }; } }));
    expect(calls).toBe(1);
    expect(out.payload['outcome']).toBe('not_mapped');
    expect(human(out.text)).toMatch(/could not be compiled into a rule set that passes validation/);
    expect(json(out.text)).not.toMatch(CJK);
  });

  it('compiled rules that never trigger (0 trades) → not_mapped with the reason, not a 0-trade report', async () => {
    const never = { ...PLACEHOLDER_IR, label: 'x', description: 'Price above one trillion', signal: [{ primitive: 'indicator_cross', params: { indicator: 'price', compare_to: 'constant', constant: 1e12, direction: 'cross_above' } }] } as unknown as StrategyIR;
    const text = 'BTC 1d: go long when price trades above one trillion';
    const out = await nl.handle(job(text), nl.validate(job(text)), deps({ compile: async () => ({ ir: never, unmapped: [], model: 'm', usd: null }) }));
    expect(out.payload['outcome']).toBe('not_mapped');
    expect(human(out.text)).toMatch(/The compiled rules never triggered: 0 trades over \d+ 1d bars/);
  });

  it('usable compiled rules with an English unmapped part → tested, the gap is stated up front', async () => {
    const ir = buildIR({ source: 'template', family: 'ema_cross', args: { fast: 10, slow: 30 }, stop: null, target: null, trail: null, max_hold: null }, { market: 'spot', side: 'long', timeframe: '1d' });
    const text = 'BTC 1d: buy on a MACD-style momentum turn confirmed by rising volume';
    const out = await nl.handle(job(text), nl.validate(job(text)), deps({ compile: async () => ({ ir, unmapped: ['rising volume confirmation: no volume-trend primitive', '自动补全:未指定止损,按 ATR(14)×2 初始止损'], model: 'm', usd: null }) }));
    const h = human(out.text);
    expect(out.payload).toMatchObject({ outcome: 'tested', tested_as_described: false, ir_source: 'model' });
    expect(h).toMatch(/Mapping: 1 part of the request had no supported rule and was left out \(rising volume confirmation: no volume-trend primitive\); the results below cover only the mapped rules/);
    expect(h).toMatch(/Note: 1 default rule was filled in where the request was silent/);
    expect(json(out.text)).not.toMatch(CJK);
  });

  it('template request with 0 trades explains why instead of a bare zero report', async () => {
    const out = await researchReportService.handle(job('BTC 1d RSI(14) below 5 mean reversion'), researchReportService.validate(job('BTC 1d RSI(14) below 5 mean reversion')), deps({ backtestBars: async (_s, _tf, w) => { const step = 86_400_000, n = Math.floor((w.to_ms + 1 - w.from_ms) / step); return { bars: synthBars(n, step, 3, w.to_ms + 1 - n * step, 100).map((b) => ({ ...b, open: '100', high: '100', low: '100', close: '100' })), source: 'flat' }; } }));
    expect(human(out.text)).toMatch(/Why no trades: the entry condition never became true on BTC 1d/);
  });
});

describe('quick helpers', () => {
  it('compileNotes keeps English fragments, drops Chinese reasons, counts compiler defaults separately', () => {
    expect(compileNotes([...REAL_UNMAPPED, '自动补全:未指定仓位', '自动更正:杠杆', 'volume filter'])).toEqual({ unmapped: ['Not mapped: 3 consecutive green candles', 'Not mapped: 1% profit / 0.5% stop loss', 'Not mapped: volume filter'], defaults: 2 });
  });
  it('degenerateReason flags placeholders but not real price levels', () => {
    expect(degenerateReason(PLACEHOLDER_IR, [])).toMatch(/placeholder/);
    expect(degenerateReason({ ...PLACEHOLDER_IR, signal: [{ primitive: 'indicator_cross', params: { indicator: 'price', compare_to: 'constant', constant: 100000, direction: 'cross_above' } }] } as unknown as StrategyIR, [])).toBeNull();
    expect(degenerateReason({ ...PLACEHOLDER_IR, signal: [{ primitive: 'candle_streak', params: { count: 3, direction: 'up' } }] } as unknown as StrategyIR, ['entry: 占位,无法表达'])).toMatch(/placeholder/);
  });
  it('closestIdea picks a family from keywords, falls back to breakout', () => {
    expect(closestIdea('buy when a hammer candle appears', 'long')).toMatchObject({ matched: true, idea: { family: 'streak' } });
    expect(closestIdea('stochastic oversold bounce', 'long').idea.family).toBe('mean_reversion');
    expect(closestIdea('MACD histogram turns positive', 'long').idea.family).toBe('ema_cross');
    expect(closestIdea('order block retest', 'short').idea.family).toBe('breakout'); // SMC 模板只做多
    expect(closestIdea('something exotic', 'long')).toMatchObject({ matched: false, idea: { family: 'breakout' } });
  });
  it('englishOnly translates known engine notes, drops unknown Chinese in arrays, masks it in fields', () => {
    expect(englishOnly({ a: '中文', b: ['ok', '随便', 'BTCUSDT 期末仍有持仓'], c: { d: 1, e: null } })).toEqual({ a: '(non-English text omitted)', b: ['ok', 'BTCUSDT still holds a position at the window end; it is marked to market at the last close and excluded from closed-trade stats'], c: { d: 1, e: null } });
  });
  it('every FAMILY_EXAMPLE phrase parses back to the same family and side', () => {
    const j = (d: string) => ({ job_id: 'x', service_key: RESEARCH_REPORT_KEY, description: d, service_params: null });
    for (const f of Object.keys(FAMILY_EXAMPLE) as QuickFamily[]) for (const short of f === 'smc' ? [false] : [false, true]) {
      const q = validateQuick(j(FAMILY_EXAMPLE[f]('ETH', '4h', short)));
      expect({ f, short, fam: q.idea.source === 'template' ? q.idea.family : null, side: q.side }).toEqual({ f, short, fam: f, side: short ? 'short' : 'long' });
    }
    expect(validateQuick(j(`${FAMILY_EXAMPLE.mean_reversion('BTC', '4h', false)}, perp`)).market).toBe('perp');
  });
});

// ---------------------------------------------------------------- 矩阵
const PROTO = { evidence_mode: 'historical_replay', alpha: 0.025, min_trades: 30, block_days: 5, min_blocks: 20, bootstrap_replicates: 999, max_drawdown: 0.35, min_effect: 0, min_dsr: 0.95 };
const sc = (trades: number, total_return: number, sharpe: number | null, max_drawdown = 0.05) => ({ trades, total_return, sharpe, max_drawdown, win_rate: 0.5 });
const g = (name: string, ok: boolean, value: number | null) => ({ name, ok, value });
function matrixView(): MatrixViewLike {
  const cell = (id: string, symbol: string, timeframe: string, family: string, side: string, sel: ReturnType<typeof sc>, gates: ReturnType<typeof g>[], extra: Record<string, unknown> = {}) =>
    ({ id, symbol, timeframe, family, side, arm: 'code', applicability: 'applicable', result: { verdict: 'fail', cause: 'insufficient_evidence', selection: sel, gates, ...extra } });
  return {
    id: 'ms-q', status: 'completed', stage: 'done', manifest_hash: 'm'.repeat(64), protocol_hash: 'p'.repeat(64), created_at: NOW - 600_000, updated_at: NOW,
    progress: { done: 1, total: 1, note: '' },
    conclusion: { kind: 'no_candidate', finalist_ids: [], causes: { insufficient_evidence: 3, cost_dominated: 1 }, not_applicable: 0, research_only: 0, text: '没有找到通过门槛的策略' },
    usage: { judge_calls: 0, judge_usd: '0', wall_ms: 1 }, stop_reason: null,
    spec: { symbols: ['BTCUSDT', 'ETHUSDT'], timeframes: ['4h', '1d'], families: ['breakout', 'mean_reversion', 'ema_cross'], market: 'perp', sides: ['long', 'short'], arms: ['code'], protocol: PROTO, window_days: { '4h': 1825, '1d': 2190 } } as MatrixViewLike['spec'],
    cells: [
      cell('a', 'BTCUSDT', '4h', 'mean_reversion', 'short', sc(24, 0.129, 2.25), [g('selection_trades>=30', false, 24), g('deflated_sharpe>=0.95', false, 0.4)], { tier: 'paper_candidate', tier_reasons: ['平仓 24 笔,不到 30 笔'], train: sc(70, 0.21, 1.1), scorecard: { score: { value: 71, label: 'good' }, luck: { luck_probability: 0.6 } } }),
      cell('b', 'ETHUSDT', '4h', 'breakout', 'long', sc(33, -0.09, -1.3), [g('net_return>0', false, -0.09), g('deflated_sharpe>=0.95', false, 0)], { tier: 'fail', tier_reasons: ['选择段净收益不为正'] }),
      cell('c', 'BTCUSDT', '1d', 'ema_cross', 'long', sc(9, 0.1, 1.2), [g('selection_trades>=30', false, 9)], { tier: 'paper_candidate', scorecard: { score: { value: 60, label: 'fair' }, luck: { luck_probability: null } } }),
    ] as unknown as MatrixViewLike['cells'],
    finalists: [],
    ...({ segments: { '4h': { selection: { from_ms: NOW - 730 * 86_400_000, to_ms: NOW - 365 * 86_400_000 } }, '1d': { selection: { from_ms: NOW - 876 * 86_400_000, to_ms: NOW - 438 * 86_400_000 } } } } as object),
  };
}

describe('full matrix: decision-useful report', () => {
  it('near misses are the headline; windows, per-timeframe evidence and next steps are explicit; no CJK anywhere', async () => {
    const v = matrixView(), creates: Record<string, unknown>[] = [];
    const m: MatrixLike = { create: (b) => { creates.push(b); return { id: v.id }; }, get: () => v };
    const j = job('BTC ETH 4h 1d 完整矩阵研究');
    const out = await researchReportService.handle(j, researchReportService.validate(j), deps({ matrix: () => m }));
    expect((creates[0]!['spec'] as { window_days: Record<string, number> }).window_days).toEqual({ '4h': EVIDENCE_WINDOW_DAYS['4h'], '1d': EVIDENCE_WINDOW_DAYS['1d'] });
    const h = human(out.text), ls = h.split('\n');
    expect(ls[1]).toBe('No cell passed the selection gate; holdout not released. 2 near-miss cells cleared the return, cost, drawdown and exposure-matched-hold checks and fell short only on sample size or significance; best: BTC 4h Mean reversion short (selection +12.9%, 24 trades)');
    expect(h).toMatch(/Design: history windows were lengthened beyond the engine defaults .*4h 1825 days \(default 730; selection ≈365 days\), 1d 2190 days \(default 1460; selection ≈438 days\)\. Evidence thresholds are unchanged/);
    expect(h).toMatch(/Evidence 4h: selection ≈365 days \(73 of 20 required 5-day blocks\) · 1\/2 cells reached 30 trades · median 24 trades, max 33 · 1\/2 cells net positive after fees/);
    expect(h).toMatch(/Near misses \(2\):[^\n]*\n· BTC 4h Mean reversion short: selection \+12\.9% · Sharpe 2\.25 · max drawdown 5\.0% · 24 trades · training segment \+21\.0% over 70 trades — short of: trades 24\/30, Deflated Sharpe 0\.40 below 0\.95 · after adjusting for the number of variants tried, ~60% chance the selection result is luck\n· BTC 1d EMA crossover long:/);
    expect(h).toMatch(/Next steps: \(1\) Paper-watch the near-miss cells.*\(2\) Look at the best near miss over its full history with a Strategy Backtest Quick order \(same family, default parameters\), e\.g\. "BTC 4h: short when RSI14 crosses above 70, target the middle Bollinger band".*1d: no cell reached 30 trades in the selection segment \(max 9\), so 1d cells cannot pass by construction; read them as descriptive only, or use 4h or 15m for a statistically testable answer.*Fees ate the edge in 1 cell/);
    expect(h).toMatch(/Conclusion: no strategy passed the gates: .*2 near-miss cells \(sample size \/ significance only\) listed above/);
    expect(h).not.toMatch(CJK);
    expect(h).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    expect(json(out.text)).not.toMatch(CJK);
    expect(BANNED_WORDS.test(h)).toBe(false);
    expect(out.payload).toMatchObject({ design: { extended: true, thresholds_changed: false, window_days: { '4h': 1825, '1d': 2190 } } });
    expect((out.payload['near_misses'] as unknown[]).length).toBe(2);
    expect((out.payload['cells'] as { near_miss: boolean; failed_on: string[] }[]).map((c) => c.near_miss)).toEqual([true, false, true]);
    expect((out.payload['next_steps'] as string[]).length).toBeGreaterThanOrEqual(3);
  });

  it('the suggested quick-backtest order in next steps is itself accepted by the quick tier', () => {
    const ex = FAMILY_EXAMPLE.mean_reversion('BTC', '4h', true);
    expect(validateQuick(job(ex))).toMatchObject({ symbol: 'BTCUSDT', timeframe: '4h', side: 'short', market: 'perp', idea: { family: 'mean_reversion' } });
    expect(validateQuick(job(`${FAMILY_EXAMPLE.smc('LTC', '4h', false)}, perp`))).toMatchObject({ symbol: 'LTCUSDT', side: 'long', market: 'perp', idea: { family: 'smc' } });
  });
});
