// ASP 按次服务「策略研究报告」两档(quick 快速回测 / full 完整矩阵)。零网络:K 线、矩阵研究、模型编译全部注入假实现。
import { describe, expect, it } from 'vitest';
import type { ResearchBar } from '@trading-swarm/contracts';
import { synthBars } from './research/backtest-report-fixtures.js';
import { makeResearchReportService, researchReportService, tierIn, RESEARCH_REPORT_KEY, type ResearchReportDeps } from '../../src/demo/asp-agent/services/research-report.js';
import { buildIR, type TemplateIdea } from '../../src/demo/asp-agent/services/quick-backtest.js';
import { deliverable, sha256Of } from '../../src/demo/asp-agent/services/render.js';
import { ServiceInputError, type MatrixLike, type MatrixViewLike, type PerCallJob } from '../../src/demo/asp-agent/services/types.js';
import { BANNED_WORDS } from '../../src/demo/asp-agent/publisher.js';
import { checkIR } from '../../src/demo/research/strategy.js';

const NOW = Date.UTC(2026, 8, 25, 0, 0, 0);
const job = (description: string, service_params: string | null = null, job_id = 'job-research-1'): PerCallJob => ({ job_id, service_key: RESEARCH_REPORT_KEY, description, service_params });
const svc = researchReportService;
const reject = (fn: () => unknown): string => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(ServiceInputError); return (e as ServiceInputError).code; } throw new Error('expected ServiceInputError'); };

/** 合成行情:最后一根收在 window.to_ms 之前,覆盖整个请求窗口 */
function fakeBars(seed = 11) {
  const calls: { symbol: string; timeframe: string; market: string; from_ms: number; to_ms: number }[] = [];
  const backtestBars: NonNullable<ResearchReportDeps['backtestBars']> = async (symbol, timeframe, w, market) => {
    calls.push({ symbol, timeframe, market, ...w });
    const step = timeframe === '1d' ? 86_400_000 : timeframe === '4h' ? 14_400_000 : timeframe === '1h' ? 3_600_000 : 900_000;
    const n = Math.floor((w.to_ms + 1 - w.from_ms) / step), start = w.to_ms + 1 - n * step;
    const bars: ResearchBar[] = synthBars(n, step, seed, start, 100);
    if (market === 'perp') {
      const funding = { points: [] as { at: number; rate: number }[], from_ms: w.from_ms, to_ms: w.to_ms };
      return { bars, source: 'synthetic:perp', perp: { inst_id: `${symbol.replace(/USDT$/, '')}-USDT-SWAP`, timeframe, bars, mark: bars.map(() => null), funding, funding_provenance: {} as never, tiers: [], lever_tiers: [] as never, max_lever: 50, provenance: {} as never } as never };
    }
    return { bars, source: 'synthetic:spot' };
  };
  return { calls, backtestBars };
}
function deps(extra: Partial<ResearchReportDeps> = {}): ResearchReportDeps {
  return {
    now: () => NOW,
    recommend: async () => { throw new Error('recommend_not_expected'); },
    matrix: () => null,
    bars: async () => [],
    regime: async () => null,
    sleep: async () => {},
    poll_ms: 1,
    ...fakeBars(),
    ...extra,
  };
}

describe('research_report 档位与自由文本解析', () => {
  it('缺省 quick;矩阵/完整/full → full;JSON tier 优先;非法 tier 拒单', () => {
    expect(tierIn(job('BTC 4h 突破 20 根高点做多,2ATR 止损,3R 止盈'))).toBe('quick');
    expect(tierIn(job('帮我做一份 BTC ETH 4h 的完整矩阵研究报告'))).toBe('full');
    expect(tierIn(job('Please run a full matrix study on SOL 1d'))).toBe('full');
    expect(tierIn(job('快速回测一下,不用完整矩阵:BTC 4h EMA20/50 金叉'))).toBe('quick');
    expect(tierIn(job('完整矩阵 BTC', '{"tier":"quick"}'))).toBe('quick');
    expect(reject(() => tierIn(job('BTC 4h 突破', '{"tier":"deluxe"}')))).toBe('tier_invalid');
  });

  it('示例描述 → 突破模板 + 买方风控,IR 过 checkIR', () => {
    const p = svc.validate(job('BTC 4h 突破 20 根高点做多,2ATR 止损,3R 止盈'));
    expect(p.tier).toBe('quick');
    if (p.tier !== 'quick') throw new Error();
    const q = p.quick;
    expect(q).toMatchObject({ symbol: 'BTCUSDT', timeframe: '4h', market: 'spot', side: 'long', days: 2190 });
    expect(q.idea).toMatchObject({ source: 'template', family: 'breakout', args: { lookback: 20 }, stop: { kind: 'atr', multiple: 2 }, target: { kind: 'r', r: 3 }, trail: null });
    const ir = buildIR(q.idea as TemplateIdea, q);
    expect(checkIR(ir, '4h').ok).toBe(true);
    expect(ir.risk.stop).toMatchObject({ primitive: 'atr_stop', params: { multiple: 2 } });
    expect(ir.order?.take_profits?.[0]?.source).toMatchObject({ primitive: 'fixed_r_target', params: { r: 3 } });
    // 买方说了止损止盈就不叠族缺省的吊灯追踪
    expect(ir.exit.some((x) => x.primitive === 'chandelier_trail')).toBe(false);
  });

  it('均线交叉:EMA20 不当币,周期取 20/50;做空自动走永续', () => {
    const p = svc.validate(job('ETH 1d EMA20/50 金叉做多,不设止损'));
    if (p.tier !== 'quick') throw new Error();
    expect(p.quick.symbol).toBe('ETHUSDT');
    expect(p.quick.idea).toMatchObject({ family: 'ema_cross', args: { fast: 20, slow: 50 }, stop: { kind: 'none' } });
    const s = svc.validate(job('SOL 1h 跌破 55 根低点做空,止损 3%,止盈 6%'));
    if (s.tier !== 'quick') throw new Error();
    expect(s.quick).toMatchObject({ symbol: 'SOLUSDT', timeframe: '1h', market: 'perp', side: 'short' });
    expect(s.quick.idea).toMatchObject({ family: 'breakout', args: { lookback: 55 }, stop: { kind: 'pct', pct: 0.03 }, target: { kind: 'pct', pct: 0.06 } });
    expect(checkIR(buildIR(s.quick.idea as TemplateIdea, s.quick), '1h').ok).toBe(true);
  });

  it('其余族都能出合格 IR(回踩 / RSI 均值回归 / 均线趋势 / SMC / 布林)', () => {
    const cases: [string, string, Record<string, number>][] = [
      ['BTC 4h 回踩 EMA20 做多', 'pullback', { ema: 20 }],
      ['BTC 15m RSI(7) 低于 25 超卖均值回归,最近 90 天', 'mean_reversion', { rsi_period: 7, rsi_level: 25 }],
      ['ETH 4h 趋势跟随:EMA 10 与 EMA 50,吊灯 2.5 ATR 追踪', 'ma_trend', { fast: 10, slow: 50 }],
      ['BTC 4h SMC 结构突破 BOS 做多', 'smc', { swing: 3 }],
      ['DOGE 1h 跌破布林下轨抄底', 'mean_reversion', { bb: 1 }],
    ];
    for (const [text, family, args] of cases) {
      const p = svc.validate(job(text));
      if (p.tier !== 'quick' || p.quick.idea.source !== 'template') throw new Error(text);
      expect(p.quick.idea.family, text).toBe(family);
      expect(p.quick.idea.args, text).toMatchObject(args);
      expect(checkIR(buildIR(p.quick.idea, p.quick), p.quick.timeframe).ok, text).toBe(true);
    }
    const mr = svc.validate(job('BTC 15m RSI(7) 低于 25 超卖均值回归,最近 90 天'));
    if (mr.tier === 'quick') expect(mr.quick.days).toBe(90);
  });

  it('JSON 参数:family/symbol/days/strategy_ir', () => {
    const p = svc.validate(job('json request for quick backtest', JSON.stringify({ symbol: 'avax', timeframe: '1d', family: 'ema_cross', fast: 10, slow: 30, days: 400 })));
    if (p.tier !== 'quick') throw new Error();
    expect(p.quick).toMatchObject({ symbol: 'AVAXUSDT', timeframe: '1d', days: 400, idea: { family: 'ema_cross', args: { fast: 10, slow: 30 } } });
    const ir = buildIR({ source: 'template', family: 'breakout', args: { lookback: 30 }, stop: null, target: null, trail: null, max_hold: null }, { market: 'spot', side: 'long', timeframe: '4h' });
    const q = svc.validate(job('run my own IR please', JSON.stringify({ symbol: 'BTC', timeframe: '4h', strategy_ir: ir })));
    if (q.tier !== 'quick') throw new Error();
    expect(q.quick.idea.source).toBe('ir');
  });

  it('缺参数/不合格拒单(接单前,不取数)', () => {
    expect(reject(() => svc.validate(job('4h 突破 20 根高点做多,2ATR 止损')))).toBe('symbol_required');
    expect(reject(() => svc.validate(job('BTC 4h 我觉得会涨,帮我看看')))).toBe('strategy_unrecognized');
    expect(reject(() => svc.validate(job('BTC 现货 4h 跌破 20 根低点做空')))).toBe('sides_invalid');
    expect(reject(() => svc.validate(job('BTC 4h 突破 20 根高点,最近 10 天')))).toBe('days_invalid');
    expect(reject(() => svc.validate(job('BTC 4h 突破 20 根高点,止损 50 倍 ATR')))).toBe('stop_invalid');
    expect(reject(() => svc.validate(job('BTC 4h 突破 900 根高点')))).toBe('lookback_invalid');
    expect(reject(() => svc.validate(job('json', JSON.stringify({ symbols: ['BTC', 'ETH'], family: 'breakout' }))))).toBe('symbols_too_many');
    expect(reject(() => svc.validate(job('BTC 4h 突破', JSON.stringify({ timeframe: '2h' }))))).toBe('timeframe_invalid');
    expect(reject(() => svc.validate(job('BTC 4h SMC BOS 做空')))).toBe('sides_invalid');
    // 完整档沿用矩阵的校验
    expect(reject(() => svc.validate(job('完整矩阵研究 BTC ETH SOL DOGE 4h')))).toBe('symbols_too_many');
    // 开了 nl_compile 时认不出的描述可以接,交给模型编译
    const nl = makeResearchReportService({ nl_compile: true }).validate(job('BTC 4h 我觉得会涨,帮我看看'));
    expect(nl).toMatchObject({ tier: 'quick', quick: { idea: { source: 'text' } } });
  });
});

describe('quick 快速回测交付', () => {
  it('跑合成行情:双语标题、费用/压力/按年/分段齐全,哈希稳定', async () => {
    const j = job('BTC 1d 突破 20 根高点做多,2ATR 止损,3R 止盈,最近 900 天');
    const p = svc.validate(j), d = deps();
    const a = await svc.handle(j, p, d), b = await svc.handle(j, svc.validate(j), deps());
    const first = a.text.split('\n')[0]!;
    expect(first).toMatch(/策略研究报告/);
    expect(first).toMatch(/Strategy Research Report/);
    expect(a.text).toMatch(/历史回放,只给分析与依据,不构成投资建议/);
    expect(a.text).toMatch(/2 倍费率压力/);
    expect(a.service_key).toBe('research_report');
    expect(a.payload['anchor']).toEqual({ chain: 'xlayer', status: 'not_anchored' });
    expect(a.payload['tier']).toBe('quick');
    const m = a.payload['metrics'] as { trades: number; total_return: number; benchmark_return: number | null };
    const s = a.payload['stressed'] as { total_return: number; trades: number };
    expect(m.trades).toBeGreaterThan(0);
    expect(m.benchmark_return).not.toBeNull();
    expect(s.trades).toBeGreaterThan(0);
    expect(s.total_return).toBeLessThan(m.total_return);
    expect((a.payload['yearly'] as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect((a.payload['segments'] as { name: string }[]).map((x) => x.name)).toEqual(['in_sample', 'out_of_sample']);
    expect((a.payload['fees'] as { taker: number }).taker).toBe(0.001);
    // 窗口:取数含 ≥300 根预热;报告窗口 ≈ 900 天
    const w = a.payload['window'] as { from_ms: number; to_ms: number; bars: number };
    expect(w.bars).toBeGreaterThan(850);
    expect(d.backtestBars).toBeDefined();
    // 哈希:同一输入逐位一致,且就是 payload 的规范化哈希
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toBe(sha256Of(a.payload));
    expect(a.text).toContain(`sha256: ${a.sha256}`);
    expect(BANNED_WORDS.test(a.text)).toBe(false);
  });

  it('做空走永续取数(带 perp 行情),持有基准方向差写进注意', async () => {
    const j = job('ETH 4h 跌破 20 根低点做空,止损 2 ATR,止盈 2R,最近 300 天');
    const f = fakeBars(5), d = deps({ backtestBars: f.backtestBars });
    const out = await svc.handle(j, svc.validate(j), d);
    expect(f.calls[0]).toMatchObject({ symbol: 'ETHUSDT', timeframe: '4h', market: 'perp' });
    expect(out.payload['market']).toBe('perp');
    expect(out.payload['side']).toBe('short');
    expect(out.text).toMatch(/持有基准仍是买入持有/);
    expect((out.payload['fees'] as { taker: number; maker: number }).maker).toBe(0.0002);
  });

  it('模型编译路径:认不出的描述走注入 compile(桩),记录模型与花费;没接 compile 直接报错', async () => {
    const svcNl = makeResearchReportService({ nl_compile: true });
    const j = job('BTC 1d 我想在情绪极度恐慌之后买入,拿一段时间');
    const p = svcNl.validate(j);
    const stubIR = buildIR({ source: 'template', family: 'ema_cross', args: { fast: 10, slow: 30 }, stop: null, target: null, trail: null, max_hold: null }, { market: 'spot', side: 'long', timeframe: '1d' });
    let compiled = 0;
    const out = await svcNl.handle(j, p, deps({ compile: async () => { compiled++; return { ir: { ...stubIR, description: '稳赚的恐慌抄底' }, unmapped: ['情绪极度恐慌:没有情绪数据原语'], model: 'stub-model', usd: '0.12' }; } }));
    expect(compiled).toBe(1);
    expect(out.payload['ir_source']).toBe('model');
    expect(out.payload['compile']).toMatchObject({ model: 'stub-model', usd: '0.12' });
    // 买方/模型给的描述含收益保证词:正文里被遮掉,交付不被拦
    expect(BANNED_WORDS.test(out.text.split('\n{')[0]!)).toBe(false);
    await expect(svcNl.handle(j, p, deps())).rejects.toThrow(/nl_compile_unavailable/);
  });

  it('K 线不够预热 → 抛 data_missing;没接 backtestBars → 抛 unavailable', async () => {
    const j = job('BTC 1d 突破 20 根高点做多');
    const p = svc.validate(j);
    await expect(svc.handle(j, p, deps({ backtestBars: async () => ({ bars: synthBars(100, 86_400_000, 3, NOW - 101 * 86_400_000), source: 'x' }) }))).rejects.toThrow(/data_missing/);
    await expect(svc.handle(j, p, deps({ backtestBars: undefined }))).rejects.toThrow(/quick_backtest_unavailable/);
  });
});

// ---------------------------------------------------------------- full 完整矩阵

function view(id: string, over: Partial<MatrixViewLike> = {}): MatrixViewLike {
  const sc = { trades: 42, total_return: 0.31, sharpe: 1.2, max_drawdown: 0.12, win_rate: 0.45 };
  return {
    id, status: 'completed', stage: 'done', manifest_hash: 'm'.repeat(64), protocol_hash: 'p'.repeat(64), created_at: NOW - 600_000, updated_at: NOW,
    progress: { done: 10, total: 10, note: '' },
    conclusion: { kind: 'passed', finalist_ids: ['c1'], causes: { cost_dominated: 3, insufficient_evidence: 1 }, not_applicable: 0, research_only: 0, text: '1 个策略在留出段站得住' },
    usage: { judge_calls: 0, judge_usd: '0', wall_ms: 60_000 }, stop_reason: null,
    spec: { symbols: ['BTCUSDT', 'ETHUSDT'], timeframes: ['4h'], families: ['breakout', 'ma_trend', 'ema_cross'], market: 'perp', sides: ['long', 'short'], arms: ['code'], protocol: { evidence_mode: 'exploratory', alpha: 0.05, min_trades: 30 } },
    cells: [{ id: 'c1', symbol: 'BTCUSDT', timeframe: '4h', family: 'breakout', side: 'long', arm: 'code', applicability: 'applicable', result: { verdict: 'pass', cause: null, selection: sc } }],
    finalists: [{ id: 'c1', symbol: 'BTCUSDT', timeframe: '4h', family: 'breakout', side: 'long', arm: 'code', passed: true, selection: sc, holdout: sc, portfolio: { total_return: 0.2, max_drawdown: 0.1, trades: 20 } }],
    ...over,
  };
}
function fakeMatrix(behavior: (body: Record<string, unknown>, n: number) => { id: string }) {
  const creates: Record<string, unknown>[] = [];
  let polls = 0;
  const m: MatrixLike = {
    create(body) { creates.push(body); return behavior(body, creates.length); },
    get(id) { polls++; return polls < 3 ? view(id, { status: 'running' }) : view(id); },
  };
  return { m, creates };
}

describe('full 完整矩阵交付', () => {
  it('解析 + 跑矩阵:标题/锚定/哈希', async () => {
    const j = job('BTC ETH 4h 完整矩阵研究,永续多空');
    const p = svc.validate(j);
    expect(p).toMatchObject({ tier: 'full', full: { symbols: ['BTCUSDT', 'ETHUSDT'], timeframes: ['4h'], market: 'perp' } });
    const f = fakeMatrix(() => ({ id: 'ms-1' }));
    const out = await svc.handle(j, p, deps({ matrix: () => f.m }));
    expect(out.text.split('\n')[0]).toMatch(/完整矩阵 \/ Strategy Research Report · Full Matrix/);
    expect(out.payload).toMatchObject({ tier: 'full', study_id: 'ms-1', anchor: { chain: 'xlayer', status: 'not_anchored' }, reused_from: null });
    expect(out.sha256).toBe(sha256Of(out.payload));
    expect(f.creates[0]).toMatchObject({ idempotency_key: `asp_job:${j.job_id}`, spec: { arms: ['code'], budget: { max_judge_calls: 0 } } });
    const again = await svc.handle(j, p, deps({ matrix: () => fakeMatrix(() => ({ id: 'ms-1' })).m }));
    expect(again.sha256).toBe(out.sha256);
  });

  it('变体超预算:收窄到前 3 个族重试一次', async () => {
    const j = job('BTC 4h 完整矩阵研究');
    const f = fakeMatrix((_b, n) => { if (n === 1) throw new Error('budget_max_variants_exceeded:420>300'); return { id: 'ms-narrow' }; });
    const out = await svc.handle(j, svc.validate(j), deps({ matrix: () => f.m }));
    expect(f.creates).toHaveLength(2);
    expect((f.creates[0]!['spec'] as { families?: string[] }).families).toBeUndefined();
    expect((f.creates[1]!['spec'] as { families: string[] }).families).toEqual(['breakout', 'ma_trend', 'ema_cross']);
    expect(out.payload['study_id']).toBe('ms-narrow');
  });

  it('买方指定了族时超预算不擅自收窄,直接失败', async () => {
    const j = job('BTC 4h 完整矩阵研究', JSON.stringify({ tier: 'full', families: ['breakout', 'smc'] }));
    const f = fakeMatrix(() => { throw new Error('budget_max_variants_exceeded:999>300'); });
    await expect(svc.handle(j, svc.validate(j), deps({ matrix: () => f.m }))).rejects.toThrow(/matrix_create_failed/);
  });

  it('同日留出段已被用过:复用那次研究并写明', async () => {
    const j = job('BTC ETH 4h 完整矩阵研究', null, 'job-research-2');
    const f = fakeMatrix(() => { throw new Error('holdout_range_already_used:ms-prev:BTCUSDT,ETHUSDT:4h'); });
    const out = await svc.handle(j, svc.validate(j), deps({ matrix: () => f.m }));
    expect(out.payload).toMatchObject({ study_id: 'ms-prev', reused_from: 'ms-prev' });
    expect(out.text).toMatch(/留出只能看一次,本报告复用该研究结果/);
  });

  it('矩阵服务没就绪 → 抛错(轮询方按失败处理)', async () => {
    const j = job('BTC 4h 完整矩阵研究');
    await expect(svc.handle(j, svc.validate(j), deps())).rejects.toThrow(/matrix_study_unavailable/);
  });
});

describe('措辞红线', () => {
  it('deliverable 正文出现收益保证类词直接拒绝交付', () => {
    expect(() => deliverable(job('x'), RESEARCH_REPORT_KEY, '【策略研究报告 / Strategy Research Report】', '稳赚不赔', [], {})).toThrow(/deliverable_banned_words/);
    expect(() => deliverable(job('x'), RESEARCH_REPORT_KEY, '【策略研究报告 / Strategy Research Report】', 'guaranteed return', [], {})).toThrow(/deliverable_banned_words/);
  });
  it('买方原话里的收益保证词只进 payload 的 request_text,不进人读正文', async () => {
    const j = job('BTC 1d 突破 20 根高点做多,稳赚策略帮我验证,最近 600 天');
    const out = await svc.handle(j, svc.validate(j), deps());
    const head = out.text.split('\n{')[0]!;
    expect(BANNED_WORDS.test(head)).toBe(false);
    expect(String(out.payload['request_text'])).toMatch(/稳赚/);
  });
});
