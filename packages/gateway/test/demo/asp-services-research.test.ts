// ASP 按次服务「策略研究报告」两档(quick 快速回测 / full 完整矩阵)。零网络:K 线、矩阵研究、模型编译全部注入假实现。
import { describe, expect, it } from 'vitest';
import type { ResearchBar } from '@trade-gate/contracts';
import { synthBars } from './research/backtest-report-fixtures.js';
import { makeResearchReportService, researchReportService, tierIn, RESEARCH_REPORT_KEY, type ResearchReportDeps } from '../../src/demo/asp-agent/services/research-report.js';
import { buildIR, stopIn, targetIn, validateQuick, yearLabel, type TemplateIdea } from '../../src/demo/asp-agent/services/quick-backtest.js';
import { isTransientNetworkError, publicExchange, withPublicRetry, type PublicExchange } from '../../src/demo/research/market-ccxt.js';
import { deliverable, sha256Of, STRUCTURED_HEADER } from '../../src/demo/asp-agent/services/render.js';
import { ServiceInputError, type MatrixLike, type MatrixViewLike, type PerCallJob } from '../../src/demo/asp-agent/services/types.js';
import { BANNED_WORDS } from '../../src/demo/asp-agent/publisher.js';
import { checkIR } from '../../src/demo/research/strategy.js';

const NOW = Date.UTC(2026, 8, 25, 0, 0, 0);
const job = (description: string, service_params: string | null = null, job_id = 'job-research-1'): PerCallJob => ({ job_id, service_key: RESEARCH_REPORT_KEY, description, service_params });
const svc = researchReportService;
/** 人读部分(render 在正文末尾追加了结构化 JSON 代码块) */
const human = (text: string) => text.split(`\n\n${STRUCTURED_HEADER}`)[0]!;
/** 中日韩文字与全角标点:人读正文里一个都不该有(中文买方原话只进 JSON) */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const ADVICE_EN = /\brecommend|\bshould (buy|sell|enter)\b|worth entering|\bwe suggest\b/i;
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
  it('跑合成行情:英文标题、费用/压力/按年/分段齐全,哈希稳定', async () => {
    const j = job('BTC 1d 突破 20 根高点做多,2ATR 止损,3R 止盈,最近 900 天');
    const p = svc.validate(j), d = deps();
    const a = await svc.handle(j, p, d), b = await svc.handle(j, svc.validate(j), deps());
    const first = a.text.split('\n')[0]!;
    expect(first).toBe('[Strategy Research Report · Quick Backtest] Trading Swarm');
    expect(a.text).toMatch(/Nature: historical replay, analysis and evidence only; past performance does not indicate future results/);
    expect(a.text.match(/Not investment advice/g)).toHaveLength(1); // 免责只出现一次(NATURE 不再重复 DISCLAIMER)
    expect(a.text).toMatch(/2× fee stress: return/);
    expect(human(a.text)).not.toMatch(CJK);
    expect(human(a.text)).not.toMatch(ADVICE_EN);
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
    expect(a.text).toContain(a.sha256);
    expect(BANNED_WORDS.test(a.text)).toBe(false);
  });

  it('做空走永续取数(带 perp 行情),持有基准方向差写进注意', async () => {
    const j = job('ETH 4h 跌破 20 根低点做空,止损 2 ATR,止盈 2R,最近 300 天');
    const f = fakeBars(5), d = deps({ backtestBars: f.backtestBars });
    const out = await svc.handle(j, svc.validate(j), d);
    expect(f.calls[0]).toMatchObject({ symbol: 'ETHUSDT', timeframe: '4h', market: 'perp' });
    expect(out.payload['market']).toBe('perp');
    expect(out.payload['side']).toBe('short');
    expect(out.text).toMatch(/Note: Short strategy: the benchmark is still long buy-and-hold/);
    expect(human(out.text)).not.toMatch(CJK);
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
    // 模型/买方的中文描述与未映射片段不转述进正文,只进 JSON
    const hn = human(out.text);
    expect(hn).not.toMatch(CJK);
    expect(hn).toContain('Strategy: custom rules (full definition in strategy_ir in the JSON) (spot long; rules from model-compiled (stub-model))');
    expect(hn).toContain('Note: 1 part of the request could not be mapped to rules (see compile.unmapped in the JSON)');
    expect(out.payload['compile']).toMatchObject({ unmapped: ['A part of the request could not be mapped to a supported rule'] });
    await expect(svcNl.handle(j, p, deps())).rejects.toThrow(/nl_compile_unavailable/);
  });

  it('K 线不够预热 → 抛 data_missing;没接 backtestBars → 抛 unavailable', async () => {
    const j = job('BTC 1d 突破 20 根高点做多');
    const p = svc.validate(j);
    await expect(svc.handle(j, p, deps({ backtestBars: async () => ({ bars: synthBars(100, 86_400_000, 3, NOW - 101 * 86_400_000), source: 'x' }) }))).rejects.toThrow(/data_missing/);
    await expect(svc.handle(j, p, deps({ backtestBars: undefined }))).rejects.toThrow(/quick_backtest_unavailable/);
  });
});

describe('quick 可读性与平台审核原句', () => {
  it('审核原句「BTC 4小时周期突破20根高点做多,2ATR止损,3R止盈」→ 突破模板 + 买方风控;交付正文纯英文', async () => {
    const j = job('请帮我回测BTC 4小时周期突破20根高点做多，2ATR止损，3R止盈策略，含手续费滑点。');
    const p = svc.validate(j);
    if (p.tier !== 'quick') throw new Error();
    expect(p.quick).toMatchObject({ symbol: 'BTCUSDT', timeframe: '4h', market: 'spot', side: 'long', days: 2190 });
    expect(p.quick.idea).toMatchObject({ source: 'template', family: 'breakout', args: { lookback: 20 }, stop: { kind: 'atr', multiple: 2 }, target: { kind: 'r', r: 3 } });
    expect(checkIR(buildIR(p.quick.idea as TemplateIdea, p.quick), '4h').ok).toBe(true);
    const out = await svc.handle(j, p, deps());
    const h = human(out.text);
    expect(h).not.toMatch(CJK);
    expect(h).not.toMatch(ADVICE_EN);
    expect(h.split('\n')[1]).toMatch(/^BTC 4h Channel breakout: return -?\d+\.\d%, buy & hold -?\d+\.\d% · Sharpe /);
    expect(h).toContain('Strategy: Close breaks above the prior 20-bar high; stop 2×ATR14, target 3R (spot long; rules from deterministic template)');
    // 交付 JSON 一律英文:中文原话不回显,只给原文哈希
    expect(out.payload['request_text']).toBeNull();
    expect(out.payload['request_text_sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(out.payload)).not.toMatch(CJK);
  });

  it('正文:英文离场原因、初始资金与手续费占比、部分年标注,不重复「100% of available capital」', async () => {
    const j = job('BTC 1d 突破 20 根高点做多,2ATR 止损,3R 止盈,最近 900 天');
    const out = await svc.handle(j, svc.validate(j), deps());
    const h = human(out.text);
    expect(h).toMatch(/initial capital 10,000 USDT/);
    expect(h).toMatch(/\(\d+(\.\d)?% of initial capital\)/);
    expect(h).toMatch(/Exits: (stop loss|take profit) \d+/);
    expect(h).not.toMatch(/\bsl \d|\btp \d|\bbreakout\b[^:]|end_of_data/);
    expect(h).toMatch(/\(partial, /);
    expect(h).not.toMatch(/100% of available capital per trade/);
    expect(h).not.toMatch(CJK);
    expect(out.payload['initial_cash']).toBe(10000);
    expect(h).not.toMatch(/\{"service"/);
  });

  it('yearLabel:窗口首尾不满一年标「partial」,整年不标', () => {
    const from = Date.UTC(2020, 8, 26), to = Date.UTC(2026, 8, 25);
    expect(yearLabel('2020', from, to)).toBe('2020 (partial, from 09-26)');
    expect(yearLabel('2023', from, to)).toBe('2023');
    expect(yearLabel('2026', from, to)).toBe('2026 (partial, to 09-25)');
    expect(yearLabel('2025', Date.UTC(2025, 2, 1), Date.UTC(2025, 5, 1))).toBe('2025 (partial, 03-01 to 06-01)');
  });
});

describe('公共行情数据源(P0-3)', () => {
  it('okx 客户端只拉 spot/swap 市场目录(不碰期权/交割),构造不联网', async () => {
    const ex = await publicExchange('okx') as unknown as { options: { fetchMarkets: { types: string[] }; defaultType: string } };
    expect(ex.options.fetchMarkets.types).toEqual(['spot', 'swap']);
    expect(ex.options.defaultType).toBe('spot');
  });

  it('偶发网络错有限重试;失败过的 loadMarkets 强制 reload;业务错不重试', async () => {
    const ccxt = (await import('ccxt')).default as unknown as { NetworkError: new (m: string) => Error; BadSymbol: new (m: string) => Error };
    expect(isTransientNetworkError(new ccxt.NetworkError('okx GET https://www.okx.com/api/v5/public/instruments?instType=OPTION other side closed'))).toBe(true);
    expect(isTransientNetworkError(new Error('fetch failed: Client network socket disconnected before secure TLS connection was established'))).toBe(true);
    expect(isTransientNetworkError(new ccxt.BadSymbol('okx does not have market symbol FOO/USDT'))).toBe(false);
    const reloads: boolean[] = [];
    let n = 0;
    const raw: PublicExchange & { loadMarkets(reload?: boolean): Promise<Record<string, never>> } = {
      loadMarkets: async (reload = false) => { reloads.push(reload); if (++n <= 2) throw new ccxt.NetworkError('ECONNRESET'); return {}; },
      fetchOHLCV: async () => { throw new ccxt.BadSymbol('bad symbol'); },
    };
    const c = withPublicRetry(raw, { attempts: 3, backoff_ms: 0 });
    await expect(c.loadMarkets()).resolves.toEqual({});
    expect(reloads).toEqual([false, true, true]);
    await expect(c.fetchOHLCV('FOO/USDT', '4h')).rejects.toThrow(/bad symbol/);
    let k = 0;
    const flaky = withPublicRetry({ loadMarkets: async () => ({}), fetchOHLCV: async () => { if (++k < 3) throw new Error('fetch failed'); return [[1, 1, 1, 1, 1, 1]]; } }, { attempts: 3, backoff_ms: 0 });
    await expect(flaky.fetchOHLCV('BTC/USDT', '4h')).resolves.toHaveLength(1);
    let m = 0;
    const dead = withPublicRetry({ loadMarkets: async () => ({}), fetchOHLCV: async () => { m++; throw new Error('ETIMEDOUT'); } }, { attempts: 3, backoff_ms: 0 });
    await expect(dead.fetchOHLCV('BTC/USDT', '4h')).rejects.toThrow(/ETIMEDOUT/);
    expect(m).toBe(3);
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
    expect(out.text.split('\n')[0]).toBe('[Strategy Research Report · Full Matrix] Trading Swarm');
    expect(out.payload).toMatchObject({ tier: 'full', study_id: 'ms-1', anchor: { chain: 'xlayer', status: 'not_anchored' }, reused_from: null });
    expect(out.sha256).toBe(sha256Of(out.payload));
    const h = human(out.text);
    expect(h).toMatch(/✓ Passed BTC 4h Channel breakout long/);
    expect(h).toMatch(/USDT perpetual · families Channel breakout, MA trend, EMA crossover · sides long\/short/);
    expect(h).not.toMatch(/\bperp\b|\bma_trend\b|\bema_cross\b|\bpass \d/);
    expect(h).not.toMatch(CJK);
    expect(h).toContain(out.sha256);
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
    expect(out.text).toMatch(/a holdout can only be viewed once, so this report reuses that study's results/);
  });

  it('研究被网关重启打断(interrupted)→ 续跑一次再等,不把半成品当报告', async () => {
    const j = job('BTC 4h 完整矩阵研究');
    let polls = 0; const resumed: string[] = [];
    const m: MatrixLike = {
      create: () => ({ id: 'ms-int' }),
      get: (id) => { polls++; return polls === 1 ? view(id, { status: 'interrupted' }) : polls < 3 ? view(id, { status: 'running' }) : view(id); },
      resume: (id) => { resumed.push(id); return {}; },
    };
    const out = await svc.handle(j, svc.validate(j), deps({ matrix: () => m }));
    expect(resumed).toEqual(['ms-int']);
    expect(out.payload['status']).toBe('passed');
  });

  it('没给币:从推荐取前 3 个时剔除股票代币、OKX 不可交易和日线状态未知的币', async () => {
    const j = job('完整矩阵研究 4h 永续');
    const fit = (eligible: boolean) => ({ eligible, reason: eligible ? null : 'liquidity', direction: eligible ? 'long' as const : null, families: eligible ? ['breakout' as const] : [], evidence: [] });
    const row = (symbol: string, regime: 'bull' | null, ok = true) => ({ symbol, market: 'perp' as const, quote_vol_24h: 1e8, depth_usd_05: null, regime, scan: null, radar: {}, horizons: { short: fit(false), mid: fit(ok), long: fit(false) } });
    const f = fakeMatrix(() => ({ id: 'ms-auto' }));
    await svc.handle(j, svc.validate(j), deps({
      matrix: () => f.m,
      recommend: async () => ({ id: 'rec-x', as_of: NOW, source: { universe_scan_at: NOW, regime_at: NOW, radar_at: {} }, warnings: [], rows: [row('SNDKUSDT', 'bull'), row('MUUSDT', 'bull'), row('FOOUSDT', 'bull'), row('XPLUSDT', null), row('DOGEUSDT', 'bull', false), row('BTCUSDT', 'bull'), row('ETHUSDT', 'bull'), row('SOLUSDT', 'bull'), row('LINKUSDT', 'bull')] }),
      tradable: (s: string) => s !== 'FOOUSDT',
    } as Partial<ResearchReportDeps>));
    expect((f.creates[0]!['spec'] as { symbols: string[] }).symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  });

  it('审核原句(0xe5e0):3 个币 + 4h/1d → full 档,两个周期,不指定币走推荐;交付正文纯英文', async () => {
    const j = job('请用3个币种和4h、1d两个周期，进行策略矩阵训练选择，输出留出段表现和多重检验校正结果。');
    const p = svc.validate(j);
    expect(p).toMatchObject({ tier: 'full', full: { timeframes: ['4h', '1d'], market: 'perp' } });
    if (p.tier === 'full') expect(p.full.symbols).toBeUndefined();
    const fit = { eligible: true, reason: null, direction: 'long' as const, families: ['breakout' as const], evidence: ['雷达波段档第 1 名'] };
    const row = (symbol: string) => ({ symbol, market: 'perp' as const, quote_vol_24h: 1e8, depth_usd_05: null, regime: 'bull' as const, scan: null, radar: {}, horizons: { short: fit, mid: fit, long: fit } });
    const f = fakeMatrix(() => ({ id: 'ms-audit' }));
    const out = await svc.handle(j, p, deps({ matrix: () => f.m, recommend: async () => ({ id: 'rec-a', as_of: NOW, source: { universe_scan_at: NOW, regime_at: NOW, radar_at: {} }, warnings: ['雷达三档还没跑过'], rows: [row('BTCUSDT'), row('ETHUSDT'), row('SOLUSDT')] }) }));
    const h = human(out.text);
    expect(h).not.toMatch(CJK);
    expect(h).not.toMatch(ADVICE_EN);
    expect((f.creates[0]!['spec'] as { symbols: string[] }).symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(h).toMatch(/Scope: BTC, ETH \(no symbols given; took the top researchable coins from the asset × horizon picks\)/); // 假研究视图固定回 BTC/ETH
  });

  it('显式点名的股票代币在 validate 剔除并记下;全是股票代币直接拒单', () => {
    const p = svc.validate(job('SNDK XRP MU 4h 1d 完整矩阵研究'));
    if (p.tier !== 'full') throw new Error();
    expect(p.full.symbols).toEqual(['XRPUSDT']);
    expect(p.full.dropped).toEqual([{ symbol: 'SNDKUSDT', reason: 'stock_like' }, { symbol: 'MUUSDT', reason: 'stock_like' }]);
    expect(reject(() => svc.validate(job('SNDK MU 4h 完整矩阵研究')))).toBe('symbols_not_tradable');
    expect(reject(() => svc.validate(job('完整矩阵研究', JSON.stringify({ symbols: ['NVDA', 'TSLA'] }))))).toBe('symbols_not_tradable');
  });

  it('显式点名的 OKX 不可交易币开跑前剔除并写明;全部不可交易 → 不建研究,交付「未开跑」说明', async () => {
    const j = job('XRP FOO SNDK 4h 完整矩阵研究');
    const f = fakeMatrix(() => ({ id: 'ms-drop' }));
    const out = await svc.handle(j, svc.validate(j), deps({ matrix: () => f.m, tradable: (s: string) => s !== 'FOOUSDT' } as Partial<ResearchReportDeps>));
    expect((f.creates[0]!['spec'] as { symbols: string[] }).symbols).toEqual(['XRPUSDT']);
    expect(human(out.text)).toContain('Dropped: SNDK (stock token / leveraged ETF, not covered by crypto strategy research); FOO (no tradable USDT perpetual on OKX right now)');
    expect(out.payload['dropped_symbols']).toEqual([{ symbol: 'SNDKUSDT', reason: 'stock_like' }, { symbol: 'FOOUSDT', reason: 'not_tradable' }]);

    const j2 = job('FOO BAR 4h 完整矩阵研究', null, 'job-research-3');
    const f2 = fakeMatrix(() => ({ id: 'ms-none' }));
    const none = await svc.handle(j2, svc.validate(j2), deps({ matrix: () => f2.m, tradable: () => false } as Partial<ResearchReportDeps>));
    expect(f2.creates).toHaveLength(0);
    expect(none.payload).toMatchObject({ tier: 'full', status: 'not_run', study_id: null });
    expect(human(none.text)).toMatch(/Not run: none of the requested symbols is tradable on OKX/);
    expect(human(none.text)).toMatch(/there are no holdout results and no multiple-testing results/);
    expect(human(none.text)).not.toMatch(CJK);
    // 判定本身抛错按可交易处理
    const j3 = job('XRP 4h 完整矩阵研究', null, 'job-research-4');
    const f3 = fakeMatrix(() => ({ id: 'ms-err' }));
    await svc.handle(j3, svc.validate(j3), deps({ matrix: () => f3.m, tradable: () => { throw new Error('snapshot'); } } as Partial<ResearchReportDeps>));
    expect((f3.creates[0]!['spec'] as { symbols: string[] }).symbols).toEqual(['XRPUSDT']);
  });

  const PROTO = { evidence_mode: 'historical_replay', alpha: 0.025, min_trades: 30, block_days: 5, min_blocks: 20, bootstrap_replicates: 999, max_drawdown: 0.35, min_effect: 0, min_dsr: 0.95 };
  const SEGS = { '4h': { selection: { from_ms: NOW - 292 * 86_400_000, to_ms: NOW - 146 * 86_400_000 } }, '1d': { selection: { from_ms: NOW - 584 * 86_400_000, to_ms: NOW - 292 * 86_400_000 } } };
  const sc = (trades: number, total_return: number, sharpe: number | null, extra: Record<string, unknown> = {}) => ({ trades, total_return, sharpe, max_drawdown: 0.08, win_rate: trades ? 0.5 : null, ...extra });
  const gate = (name: string, ok: boolean, value: number | null) => ({ name, ok, value });
  const cell = (id: string, symbol: string, timeframe: string, family: string, side: string, verdict: string, cause: string | null, selection: ReturnType<typeof sc> | null, gates: ReturnType<typeof gate>[] = []) =>
    ({ id, symbol, timeframe, family, side, arm: 'code', applicability: 'applicable', result: { verdict, cause, selection, gates } });
  const staticMatrix = (v: MatrixViewLike): MatrixLike => ({ create: () => ({ id: v.id }), get: () => v });

  it('没有 finalist:列选择段前 3 格与未过原因,明写留出段未释放 / Holm 未执行;1d 证据偏薄前置;1 笔的 near 降为未通过', async () => {
    const cells = [
      cell('c1', 'XRPUSDT', '4h', 'ma_trend', 'short', 'near', 'insufficient_evidence', sc(1, 0.02, 3.1), [gate('selection_trades>=30', false, 1)]),
      cell('c2', 'BTCUSDT', '4h', 'breakout', 'long', 'near', 'underperform_hold', sc(18, 0.06, 0.9), [gate('selection_trades>=30', false, 18), gate('deflated_sharpe>=0.95', false, 0.41)]),
      cell('c3', 'BTCUSDT', '4h', 'ema_cross', 'long', 'fail', 'insufficient_evidence', sc(12, -0.01, 0.5), [gate('selection_trades>=30', false, 12), gate('selection_blocks>=20', false, 11), gate('net_return>0', false, -0.01)]),
      cell('c4', 'XRPUSDT', '1d', 'breakout', 'long', 'fail', 'insufficient_evidence', null, [gate('not_evaluated', false, null)]),
      cell('c5', 'BTCUSDT', '1d', 'pullback', 'long', 'fail', 'insufficient_evidence', sc(4, 0.03, 0.2), [gate('selection_trades>=30', false, 4), gate('selection_blocks>=20', false, 11)]),
      cell('c6', 'BTCUSDT', '4h', 'smc', 'short', 'fail', 'insufficient_evidence', sc(0, 0, null), [gate('selection_trades>=30', false, 0)]),
    ];
    const v = view('ms-none', {
      spec: { symbols: ['XRPUSDT', 'BTCUSDT'], timeframes: ['4h', '1d'], families: ['breakout', 'ma_trend', 'ema_cross', 'pullback', 'smc'], market: 'perp', sides: ['long', 'short'], arms: ['code'], protocol: PROTO },
      conclusion: { kind: 'no_candidate', finalist_ids: [], causes: { insufficient_evidence: 5, underperform_hold: 1 }, not_applicable: 2, research_only: 0, text: 'engine text' },
      cells, finalists: [], ...({ segments: SEGS } as object),
    });
    const j = job('XRP BTC 4h 1d 完整矩阵研究');
    const out = await svc.handle(j, svc.validate(j), deps({ matrix: () => staticMatrix(v) }));
    const h = human(out.text), ls = h.split('\n');
    expect(ls[1]).toMatch(/No cell passed the selection gate; holdout not released/);
    // 1d 选择段 292 天 ≈ 292 根 < 30×10 → 前置提示;4h 146 天 ≈ 876 根不提示
    expect(ls[2]).toMatch(/the 1d selection segment covers only ~292 days \(≈292 bars\).*1d evidence will be thin \(max 4 trades in any 1d cell this run\)/);
    expect(h).not.toMatch(/4h evidence will be thin/);
    expect(h.indexOf('evidence will be thin')).toBeLessThan(h.indexOf('Scope:'));
    expect(h).toMatch(/Top 3 selection cells/);
    expect(h).toMatch(/· BTC 4h Channel breakout long: selection return \+6\.0% · Sharpe 0\.90 · max drawdown 8\.0% · 18 trades — failed on: trades 18\/30, Deflated Sharpe 0\.41 below 0\.95/);
    expect(h).toMatch(/· XRP 4h MA trend short:.*1 trade — failed on: trades 1\/30/);
    expect(h).toMatch(/· BTC 4h EMA crossover long:.*12 trades — failed on: trades 12\/30, time blocks 11\/20, net return after fees not positive/);
    expect(h).not.toMatch(/MA pullback long:/); // 夏普更低的 1d 格子不进前 3
    expect(h).toMatch(/the holdout was not released \(data still sealed and unseen\) and the Holm multiple-testing correction was not run/);
    expect(h).toMatch(/near threshold 1 · failed 5; 1 cell had no selection score/);
    expect(h).toMatch(/"near threshold" needs at least 15 trades/);
    expect(h).toMatch(/insufficient evidence = too few trades or time blocks in the selection segment, not a falsified strategy/);
    expect(h).not.toMatch(CJK);
    expect(h).not.toMatch(/engine text/);
    expect(h).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    expect(BANNED_WORDS.test(h)).toBe(false);
    const pc = out.payload['cells'] as { symbol: string; family: string; verdict: string; engine_verdict?: string }[];
    expect(pc.find((x) => x.symbol === 'XRPUSDT' && x.family === 'ma_trend')).toMatchObject({ verdict: 'fail', engine_verdict: 'near' });
    expect(out.payload['cell_verdicts']).toEqual({ fail: 5, near: 1 });
    expect(out.payload['holdout']).toEqual({ released: false, multiple_testing: 'not_run', alpha: 0.025, k: 0 });
    expect((out.payload['selection_top'] as unknown[]).length).toBe(3);
    expect(out.payload['thin_evidence']).toEqual([{ timeframe: '1d', selection_days: 292, selection_bars: 292, max_trades: 4 }]);
  });

  it('有 finalist:正文给留出段表现与 p 值 / Holm 阈值 / 是否拒绝', async () => {
    const ho = sc(41, 0.31, 1.2, { stressed_return: 0.22, exposure_matched_hold: 0.1 });
    const f = (id: string, symbol: string, passed: boolean, test: Record<string, unknown>, holdout = ho) => ({ id, symbol, timeframe: '4h', family: 'breakout', side: 'long', arm: 'code', passed, cause: passed ? null : 'underperform_hold', selection: sc(45, 0.2, 1.4), holdout, test, portfolio: { total_return: 0.18, max_drawdown: 0.09, trades: 30 } });
    const v = view('ms-fin', {
      spec: { symbols: ['BTCUSDT', 'ETHUSDT'], timeframes: ['4h'], families: ['breakout'], market: 'perp', sides: ['long'], arms: ['code'], protocol: PROTO },
      finalists: [
        f('c1', 'BTCUSDT', true, { days: 146, blocks: 29, mean_daily: 0.002, p_value: 0.004, holm_threshold: 0.0125, rejected: true }),
        f('c2', 'ETHUSDT', false, { days: 146, blocks: 29, mean_daily: 0.0003, p_value: 0.2, holm_threshold: 0.025, rejected: false }, sc(33, 0.02, 0.3, { stressed_return: -0.01, exposure_matched_hold: 0.05 })),
      ],
      ...({ segments: SEGS } as object),
    });
    const j = job('BTC ETH 4h 完整矩阵研究');
    const out = await svc.handle(j, svc.validate(j), deps({ matrix: () => staticMatrix(v) }));
    const h = human(out.text);
    expect(h).toMatch(/1 strategy passed the holdout test/);
    expect(h).toMatch(/✓ Passed BTC 4h Channel breakout long\n  Holdout: return \+31\.0% · exposure-matched hold \+10\.0% · at 2× fees \+22\.0% · Sharpe 1\.20 · max drawdown 8\.0% · win rate 50\.0% · 41 trades/);
    expect(h).toMatch(/Multiple testing: p=0\.0040 · Holm threshold 0\.0125 · null rejected \(significant after correction\)/);
    expect(h).toMatch(/✗ Failed ETH 4h Channel breakout long \(underperforms buy & hold\)/);
    expect(h).toMatch(/Multiple testing: p=0\.2000 · Holm threshold 0\.0250 · null not rejected \(not significant after correction\)/);
    expect(h).toMatch(/Multiple testing: 2 finalists tested together, Holm step-down correction, family-wise error rate α=0\.025 \(one-sided, block bootstrap with 5-day blocks, 999 resamples\)/);
    expect(h).toMatch(/Conclusion: 1 strategy passed the Holm-corrected holdout test: BTC 4h Channel breakout long/);
    expect(h).not.toMatch(/holdout not released|evidence will be thin/);
    expect(h).not.toMatch(CJK);
    expect(h).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    expect(out.payload['holdout']).toEqual({ released: true, multiple_testing: 'holm', alpha: 0.025, k: 2 });
    expect((out.payload['finalists'] as { test: { rejected: boolean } }[])[0]!.test.rejected).toBe(true);
  });

  it('矩阵服务没就绪 → 抛错(轮询方按失败处理)', async () => {
    const j = job('BTC 4h 完整矩阵研究');
    await expect(svc.handle(j, svc.validate(j), deps())).rejects.toThrow(/matrix_study_unavailable/);
  });
});

describe('措辞红线', () => {
  it('deliverable 正文出现收益保证类词直接拒绝交付', () => {
    expect(() => deliverable(job('x'), RESEARCH_REPORT_KEY, '[Strategy Research Report]', '稳赚不赔', [], {})).toThrow(/deliverable_banned_words/);
    expect(() => deliverable(job('x'), RESEARCH_REPORT_KEY, '[Strategy Research Report]', 'guaranteed return', [], {})).toThrow(/deliverable_banned_words/);
  });
  it('买方原话里的收益保证词只进 payload 的 request_text,不进人读正文', async () => {
    const j = job('BTC 1d 突破 20 根高点做多,稳赚策略帮我验证,最近 600 天');
    const out = await svc.handle(j, svc.validate(j), deps());
    const head = out.text.split('\n{')[0]!;
    expect(BANNED_WORDS.test(head)).toBe(false);
    expect(out.payload['request_text']).toBeNull(); // 中文原话不回显(JSON 一律英文)
    expect(out.text).not.toMatch(/稳赚/);
  });
});

describe('quick backtest risk phrasing (sandbox review 09-25: "3R profit target" was dropped)', () => {
  it('reads R targets written with "profit"/"reward" between the number and "target"', () => {
    const t = 'Backtest BTC 1h strategy: long above prior 20-bar high, 2 ATR stop loss, 3R profit target, include fees and slippage.';
    expect(targetIn(t)).toEqual({ kind: 'r', r: 3 });
    expect(stopIn(t)).toEqual({ kind: 'atr', multiple: 2 });
    for (const x of ['3R target', '3 R take profit', 'profit target 3R', 'take profit at 3R', '3R reward target', 'TP 3R']) expect(targetIn(x)).toEqual({ kind: 'r', r: 3 });
  });
});

describe('quick backtest candle streak template (sandbox review 09-26: "3 consecutive green candles" was declined)', () => {
  const job = (description: string) => ({ job_id: 'j', service_key: 'research_report' as const, description, service_params: null });
  it('maps consecutive green/red candle requests to the deterministic streak template', () => {
    const q = validateQuick(job('Backtest BTC 1h strategy: enter long after 3 consecutive green candles, exit on 1% profit or 0.5% stop loss.'));
    expect(q).toMatchObject({ symbol: 'BTCUSDT', timeframe: '1h', idea: { source: 'template', family: 'streak', args: { count: 3, down: 0 }, stop: { kind: 'pct', pct: 0.005 }, target: { kind: 'pct', pct: 0.01 } } });
    const ir = buildIR((q.idea as TemplateIdea), q);
    expect(ir.signal).toEqual([expect.objectContaining({ primitive: 'candle_streak', params: { count: 3, direction: 'up' } })]);
    expect(checkIR(ir, '1h').ok).toBe(true);
    expect(validateQuick(job('ETH 4h 连续 4 根阴线后做多,止损 2 ATR')).idea).toMatchObject({ family: 'streak', args: { count: 4, down: 1 } });
    expect(validateQuick(job('BTC 1h 三连阳做多')).idea).toMatchObject({ family: 'streak', args: { count: 3, down: 0 } });
  });
});
