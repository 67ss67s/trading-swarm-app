import { afterEach, describe, expect, it } from 'vitest';
import type { ResearchBar } from '@trade-gate/contracts';
import { openStateDb } from '../../src/state-db.js';
import { stubProfile, stubProvider, type JudgeStubKind } from '../../src/demo/research/judge/stubs.js';
import type { DecisionProvider } from '../../src/demo/research/judge/types.js';
import { BANNED_WORDS } from '../../src/demo/asp-agent/publisher.js';
import { ServiceInputError, type PerCallJob } from '../../src/demo/asp-agent/services/types.js';
import { atr14, baseRates, createJevProbabilityService, fmtBig, fmtPrice, jevJudge, jevProbabilityService, marketFeatures, priceDigits, targetFirstRate, utcText, weightedRR, type JevBinding, type JevDeps } from '../../src/demo/asp-agent/services/jev-probability.js';
import { DISCLAIMER, DISCLAIMER_AI, STRUCTURED_HEADER } from '../../src/demo/asp-agent/services/render.js';
import { AI_DOES_NOT_DECIDE, historyEvidence, PLAN_EVIDENCE, planGateService, type PlanGateDeps } from '../../src/demo/asp-agent/services/plan-gate.js';
import type { DailyRegime } from '../../src/demo/types.js';

const H = 3_600_000, START = Date.UTC(2026, 8, 1);
/** 上行 + 正弦摆动(保证有已确认摆动支撑/阻力,趋势 up) */
function makeBars(n = 150, step = H, swings = true): ResearchBar[] {
  let prev = 100;
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i * 0.05 + Math.sin(i * Math.PI / 4) * 1, o = prev; prev = c;
    const at = START + i * step;
    return { open_time: at, close_time: at + step - 1, available_at: at + step - 1, open: o.toFixed(6), high: (Math.max(o, c) + 0.5 + (swings && i % 8 === 2 ? 0.4 : 0)).toFixed(6), low: (Math.min(o, c) - 0.5 - (swings && i % 8 === 6 ? 0.4 : 0)).toFixed(6), close: c.toFixed(6), volume: '100' };
  });
}
const BARS = makeBars(), LAST = Number(BARS.at(-1)!.close), ATR = atr14(BARS);
/**
 * r2(09-27):计划把关结论改由代码证据决定,PASS 需要同距离历史 ≥ MIN_INDEPENDENT_SAMPLES 个独立样本。
 * 150 根只有 ~5 个独立样本(必然 UNCERTAIN),所以需要 PASS 的用例在 BARS 前面补 450 根同公式历史(索引为负);
 * 最近 150 根与 BARS 逐根相同 → 门槛、ATR、模型输入、LAST/NOW 全都不变,只是历史对照够深。
 */
function deepBars(extra = 450): ResearchBar[] {
  let prev = 100 + (-extra - 1) * 0.05 + Math.sin((-extra - 1) * Math.PI / 4);
  const pre = Array.from({ length: extra }, (_, k) => {
    const i = k - extra, c = 100 + i * 0.05 + Math.sin(i * Math.PI / 4), o = prev; prev = c;
    const at = START + i * H;
    return { open_time: at, close_time: at + H - 1, available_at: at + H - 1, open: o.toFixed(6), high: (Math.max(o, c) + 0.5 + (((i % 8) + 8) % 8 === 2 ? 0.4 : 0)).toFixed(6), low: (Math.min(o, c) - 0.5 - (((i % 8) + 8) % 8 === 6 ? 0.4 : 0)).toFixed(6), close: c.toFixed(6), volume: '100' };
  });
  return [...pre, ...BARS];
}
const DEEP = deepBars();
const NOW = BARS.at(-1)!.close_time + 1 + 60_000;
const regime = (r: DailyRegime['regime']): DailyRegime => ({ regime: r, ema_stack: '', ret_20d_pct: 0, ret_5d_pct: 0, vol_pct_rank: 0, atr_pct: 0, dist_to_ema200_pct: null, text: r, as_of: NOW });

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((f) => f()));

/** 固定概率的离线桩(所有 noul 题同一个 p),用来卡阈值边缘 */
function fixedProvider(p: number): DecisionProvider & { calls: number } {
  const profile = stubProfile('deterministic', 7);
  const prov = { profile, calls: 0, async decide(req: { questions: Record<string, unknown> }) {
    prov.calls++;
    return { model: profile.model, answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: 'noul', noul: p }])), usage: { input_tokens: 0, cost_usd: 0 }, latency_ms: 0 };
  } };
  return prov as unknown as DecisionProvider & { calls: number };
}
function setup(o: { kind?: JudgeStubKind; fixed?: number; bound?: boolean; judge?: boolean; regime?: DailyRegime['regime'] | null; bars?: ResearchBar[]; now?: number; qv?: number | null; max_calls?: number } = {}) {
  const state = openStateDb(':memory:'); closers.push(() => state.close());
  const provider = o.fixed !== undefined ? fixedProvider(o.fixed) : stubProvider(o.kind ?? 'deterministic');
  const binding: JevBinding = { profile: provider.profile, provider, db: state.db };
  const bindingFn = () => (o.bound === false ? null : binding);
  const bars = o.bars ?? BARS;
  /** 每次 deps.bars 请求的根数(验证一次拉齐 1000 根) */
  const barLimits: number[] = [];
  const deps: JevDeps & PlanGateDeps = {
    now: () => o.now ?? (o.bars ? o.bars.at(-1)!.close_time + 1 + 60_000 : NOW),
    recommend: async () => { throw new Error('not used'); },
    matrix: () => null,
    bars: async (_s, _tf, limit) => { barLimits.push(limit); return bars.slice(-limit); },
    regime: async () => (o.regime === null ? null : regime(o.regime ?? 'bull')),
    jev: bindingFn,
    ...(o.judge === false ? {} : { judge: jevJudge(bindingFn, ['take', 'regime_fit'], o.max_calls ? { max_calls_per_job: o.max_calls } : {}) }),
    ...(o.qv !== undefined ? { quoteVolume24h: async () => o.qv ?? null } : {}),
  };
  return { state, provider, deps, barLimits };
}
const job = (service_params: string | null, description = '请帮我把关这笔交易计划,给出结论和依据。', job_id = 'job_0001'): PerCallJob => ({ job_id, service_key: 'plan_gate', description, service_params });
const plan = (x: Record<string, unknown>) => job(JSON.stringify({ symbol: 'BTC', side: 'long', timeframe: '1h', ...x }));
const good = { entry: +(LAST).toFixed(4), stop: +(LAST - 1.5 * ATR).toFixed(4), targets: [+(LAST + 3 * ATR).toFixed(4), +(LAST + 4 * ATR).toFixed(4)] };
const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof ServiceInputError ? e.code : `other:${(e as Error).message}`; } };
/** 人读部分(末尾 Structured data JSON 代码块之前);JSON 由 render 统一附加 */
const headOf = (text: string) => text.split(`\n\n${STRUCTURED_HEADER}`)[0]!;
/** 交付正文里不该出现的建议腔(中英) */
const ADVICE = /倾向值得|倾向不值得|建议(买入|卖出|入场|开仓)|值得入场|\brecommend|\bshould (buy|sell|enter|go long|go short)\b|worth entering|worth (a|taking)\b|\bwe suggest\b/i;
/** 中日韩文字与全角标点:人读正文里一个都不该有(中文买方原话只进 JSON) */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
/** 对外不该出现的内部字段 / 上游名 */
const INTERNAL = [/stub/i, /\bjev\b/i, /typesafe/i, /openrouter/i, /routing/, /cost/i, /成本/, /budget/, /decision_id/, /request_hash/, /reason_codes.*rule_skip/, /max_call_usd/, /model_revision/];
const noInternals = (s: string) => INTERNAL.filter((re) => re.test(s)).map(String);
/** 把测试 K 线整体缩放到 BTC 价位(一位小数),复现审核单 */
function scaledBars(to: number): ResearchBar[] {
  const k = to / LAST, f = (x: string) => (Number(x) * k).toFixed(1);
  return BARS.map((b) => ({ ...b, open: f(b.open), high: f(b.high), low: f(b.low), close: f(b.close) }));
}

describe('plan_gate 输入解析', () => {
  it('自由文本:BTC 做多 入场 64200 止损 63100 止盈 65500/66800 1h', () => {
    expect(planGateService.validate(job('BTC 做多 入场 64200 止损 63100 止盈 65500/66800 1h'))).toEqual({ symbol: 'BTCUSDT', side: 'long', entry: 64200, stop: 63100, targets: [65500, 66800], timeframe: '1h', market: 'perp' });
    expect(planGateService.validate(job(null, 'ETH-USDT short entry: 2500 SL 2600 TP1 2300 TP2 2200 4h 永续'))).toMatchObject({ symbol: 'ETHUSDT', side: 'short', entry: 2500, stop: 2600, targets: [2300, 2200], timeframe: '4h', market: 'perp' });
  });
  it('JSON 参数 + 默认周期 1h', () => {
    expect(planGateService.validate(job(JSON.stringify({ symbol: 'sol-usdt', side: 'buy', entry: '150.5', stop: 147, targets: '155,160', market: 'spot' })))).toEqual({ symbol: 'SOLUSDT', side: 'long', entry: 150.5, stop: 147, targets: [155, 160], timeframe: '1h', market: 'spot' });
  });
  it('缺字段 / 非法输入拒单(ServiceInputError)', () => {
    expect(code(() => planGateService.validate(job('做多 入场 64200 止损 63100', '请帮我看看这笔计划合理不合理,谢谢啦')))).toBe('symbol_missing');
    expect(code(() => planGateService.validate(job('BTC 入场 64200 止损 63100')))).toBe('side_missing');
    expect(code(() => planGateService.validate(job('BTC 做多 止损 63100 止盈 66000')))).toBe('entry_missing');
    expect(code(() => planGateService.validate(job('BTC 做多 入场 64200 止盈 66000')))).toBe('stop_missing');
    expect(code(() => planGateService.validate(plan({ entry: 100, stop: 100 })))).toBe('stop_invalid');
    expect(code(() => planGateService.validate(plan({ side: 'short', market: 'spot', entry: 100, stop: 101 })))).toBe('side_invalid');
    expect(code(() => planGateService.validate(plan({ entry: 100, stop: 95, timeframe: '5m' })))).toBe('timeframe_invalid');
    expect(code(() => planGateService.validate(plan({ entry: 'abc', stop: 95 })))).toBe('entry_invalid');
    expect(code(() => planGateService.validate(job('BTC ETH 做多 入场 1 止损 0.5')))).toBe('symbol_ambiguous');
  });
});

describe('plan_gate 门槛与结论', () => {
  it('加权盈亏比与 intentSnapshot 同算法(错误一侧目标剔除,等权)', () => {
    expect(weightedRR('long', 100, 95, [110, 105, 90])).toEqual({ rr: 1.5, valid: [105, 110] });
    expect(weightedRR('short', 100, 104, [92, 96]).rr).toBe(1.5);
    expect(weightedRR('long', 100, 95, [90]).rr).toBeNull();
  });
  it('全部通过 + AI 模型支持 → 通过(pass),带模型概率,不外露模型名/版本/成本', async () => {
    // r2:PASS 由代码证据决定,需要够深的同距离历史 → 用 DEEP(最近 150 根与 BARS 相同)
    const { deps, provider } = setup({ qv: 5e7, bars: DEEP });
    const d = await planGateService.handle(job(JSON.stringify({ symbol: 'BTC', side: 'long', ...good })), planGateService.validate(plan(good)), deps);
    expect(d.payload['verdict']).toBe('pass');
    expect(provider.calls).toBe(1);
    const ai = d.payload['ai_model'] as Record<string, unknown>;
    expect(ai).toMatchObject({ involved: true, take_yes: 0.85, supported: true });
    expect(ai).not.toHaveProperty('model_revision');
    expect((d.payload['gates'] as { status: string }[]).map((g) => g.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    // r2:第一行不再引用 AI 概率(AI 不改结论),改为代码证据:历史频率相对盈亏平衡的余量 + 样本数
    expect(d.summary).toMatch(/^Verdict: PASS — all hard gates passed and the history clears breakeven: target 1 came before the stop \d+% of the time vs 33% breakeven \(\+\d+ pts, ~\d+ samples\); no soft warnings \(BTCUSDT long 1h\)$/);
    expect(d.text.split('\n')[1]).toBe(d.summary);
    const head = headOf(d.text);
    // r2:AI 行改名「AI reference (uncalibrated…)」并明写不改变结论;历史对照用 DEEP 的 600 根
    expect(head).toContain('AI reference (uncalibrated, generated content): Entry setup: reasonable 85% / not reasonable 15%');
    expect(head).toContain('AI probability is shown for reference and does not change the verdict.');
    expect(head).toMatch(/Code reference: last 600 closed 1h bars \(target 1000, only 600 available\)/);
    expect(head).not.toMatch(CJK);
    expect(ADVICE.test(head)).toBe(false);
    expect(head).toContain('✓ 24h volume: 50M USDT (required ≥ 2M USDT)');
    expect(head).toMatch(/Stop distance: \d+\.\d\d ATR/);
    expect(head).toContain(DISCLAIMER_AI);
    expect(noInternals(head)).toEqual([]);
    expect(noInternals(JSON.stringify(d.payload))).toEqual([]);
    expect(head).not.toMatch(/跟随|follow|skip/);
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(BANNED_WORDS.test(d.text)).toBe(false);
  });
  it.each([
    ['stop_side', { ...good, stop: good.entry + ATR }],
    ['reward_risk', { ...good, targets: [good.entry + 1.5 * ATR] }],
    ['reward_risk', { ...good, targets: [] }],
    ['stop_atr', { entry: good.entry, stop: good.entry - 0.2 * ATR, targets: [good.entry + ATR] }],
    ['stop_atr', { entry: good.entry, stop: good.entry - 5 * ATR, targets: [good.entry + 12 * ATR] }],
    ['entry_fresh', { entry: LAST - 5 * ATR, stop: LAST - 6.5 * ATR, targets: [LAST - 2 * ATR] }],
    ['entry_fresh', { entry: LAST + 2 * ATR, stop: LAST + 0.5 * ATR, targets: [LAST + 6.5 * ATR] }],
  ])('硬门槛 %s 不过 → 不通过(fail),给人话原因,且不调用 AI 模型', async (gate, p) => {
    const { deps, provider } = setup();
    const params = planGateService.validate(plan(p));
    const d = await planGateService.handle(plan(p), params, deps);
    expect(d.payload['verdict']).toBe('fail');
    const row = (d.payload['gates'] as { key: string; status: string; note: string }[]).find((g) => g.key === gate)!;
    expect(row.status).toBe('fail');
    expect(row.note.length).toBeGreaterThan(4);
    expect(d.summary).toMatch(/^Verdict: FAIL — /);
    expect(provider.calls).toBe(0);
    expect(d.text).toContain('AI model not involved');
    expect(headOf(d.text)).not.toMatch(CJK);
    expect(d.text).not.toContain('Jev');
    expect(headOf(d.text)).toContain(DISCLAIMER);
    expect(headOf(d.text)).not.toContain(DISCLAIMER_AI);
  });
  it('逆日线 / 高波动 / 流动性不足 → 软门槛 warn → uncertain', async () => {
    for (const [o, key] of [[{ regime: 'bear' as const }, 'regime'], [{ regime: 'volatile' as const }, 'regime'], [{ qv: 1000 }, 'liquidity']] as const) {
      const { deps } = setup(o);
      const d = await planGateService.handle(plan(good), planGateService.validate(plan(good)), deps);
      expect(d.payload['verdict']).toBe('uncertain');
      expect((d.payload['gates'] as { key: string; status: string }[]).find((g) => g.key === key)!.status).toBe('warn');
    }
  });
  it('审核单 0x52c1 复现:代码门槛全过(含日线顺势)、只有 AI 反对 → 存疑(不是一票否决),写明矛盾 + 代码对照', async () => {
    const { deps, provider, barLimits } = setup({ fixed: 0.16, regime: 'bull', qv: 7.83e9 });
    const d = await planGateService.handle(plan(good), planGateService.validate(plan(good)), deps);
    expect(provider.calls).toBe(1);
    expect(barLimits).toEqual([1000]); // 一次拉齐
    expect((d.payload['gates'] as { status: string }[]).every((g) => g.status === 'pass')).toBe(true);
    expect(d.payload['verdict']).toBe('uncertain');
    // r2 改动(负责人拍板:AI 不再决定结论):仍是 UNCERTAIN,但原因是代码证据 —— 150 根里同距离历史只有 ~5 个独立样本 —— 而不是 AI 的 16%;
    // 第一行不再提 AI,AI 概率挪到「AI reference (uncalibrated)」一行,明写不改变结论
    expect(d.summary).toBe('Verdict: UNCERTAIN — hard gates passed, but the same-distance history has only ~5 independent samples (a firm read needs 30); target 1 came before the stop 59% of the time vs 33% breakeven (BTCUSDT long 1h)');
    expect(d.payload['verdict_evidence']).toMatchObject({ decided_by: 'code', uncertain_reasons: ['small_sample'] });
    expect(d.summary).not.toMatch(/\bAI\b/);
    const head = headOf(d.text);
    expect(head).toContain('the daily trend gate passed (daily uptrend), yet the AI rates the regime incompatible at 84%');
    expect(head).toContain('the AI gave nearly identical probabilities to 2 different questions, so its discrimination is limited');
    expect(head).not.toMatch(CJK);
    // 代码对照:同一批 K 线、同样百分比距离,和纯函数结果一致
    const want = targetFirstRate(BARS, 'long', (good.entry - good.stop) / good.entry, (good.targets[0]! - good.entry) / good.entry)!;
    expect(want).not.toBeNull();
    const ref = d.payload['code_reference'] as { bars: number; target_first: { rate: number; breakeven: number; independent_samples: number } };
    expect(ref.bars).toBe(150);
    expect(ref.target_first.rate).toBeCloseTo(want.target_first, 4);
    expect(ref.target_first.independent_samples).toBe(want.independent);
    expect(ref.target_first.breakeven).toBeCloseTo(1 / 3, 4); // 止损 1.5 ATR、目标 1 在 3 ATR → R=2
    expect(head).toMatch(/code reference: at the same distances, target 1 was hit before the stop \d+% of the time historically \(breakeven needs 33%; ~\d+ independent samples/);
    expect(d.payload['ai_model']).toMatchObject({ involved: true, conflict_with_code: true, take_yes: 0.16 });
    // 依据不再与第一行逐字重复
    const lines = head.split('\n');
    const basisLine = lines.find((l) => l.startsWith('Basis: '))!;
    expect(basisLine).toBeDefined();
    expect(d.summary).not.toContain(basisLine.slice(7));
    expect(ADVICE.test(head)).toBe(false);
    expect(head).toContain(DISCLAIMER_AI);
  });
  it('AI 与代码一致时逻辑不变:有软门槛提示且 AI 也不支持 → 不通过;AI 边缘 → 存疑;AI 支持 + 全过 → 通过', async () => {
    const both = setup({ kind: 'all_skip', regime: 'bear' });
    const bd = await planGateService.handle(plan(good), planGateService.validate(plan(good)), both.deps);
    // r2 改动:软门槛提示 + AI 不支持 以前判 FAIL;现在 FAIL 只由硬门槛决定,软门槛(逆势)→ UNCERTAIN 并写明是哪条,AI 不参与
    expect(bd.payload['verdict']).toBe('uncertain');
    expect(bd.summary).not.toContain('the AI model does not support it either');
    expect(bd.summary).toContain('counter-trend');
    expect((bd.payload['verdict_evidence'] as { uncertain_reasons: string[] }).uncertain_reasons).toContain('soft_warning');
    expect(bd.payload['ai_model']).toMatchObject({ conflict_with_code: false });
    const edge = setup({ fixed: 0.56 });
    // r2 改动:AI 在阈值边缘不再产生 UNCERTAIN;这里仍是 UNCERTAIN,原因是代码证据(150 根只有 ~5 个独立样本),AI 支持与否结论一样
    const ed = await planGateService.handle(plan(good), planGateService.validate(plan(good)), edge.deps);
    expect(ed.payload['verdict']).toBe('uncertain');
    expect((ed.payload['verdict_evidence'] as { uncertain_reasons: string[] }).uncertain_reasons).toEqual(['small_sample', 'not_checked']);
    expect((await planGateService.handle(plan(good), planGateService.validate(plan(good)), setup({ fixed: 0.9 }).deps)).payload['verdict']).toBe('uncertain');
    // 只有 AI 反对、流动性未检查(n/a)→ 仍是存疑,并写明哪项未检查
    const skip = setup({ kind: 'all_skip' });
    const sd = await planGateService.handle(plan(good), planGateService.validate(plan(good)), skip.deps);
    expect(sd.payload['verdict']).toBe('uncertain');
    // r2:措辞改为代码原因列表,仍写明哪项未检查
    expect(sd.summary).toContain('24h volume not checked (not checked)');
  });
  it('targetFirstRate:目标 / 止损谁先到,同根都碰到记止损,超时不计入分母,独立样本按顺序不重叠', () => {
    // 收盘恒 100;第 k 根 high 101.5 / low 99.7(只够到目标 +1%),其余 high 100.2 / low 99.8
    const mk = (hi: (i: number) => number, lo: (i: number) => number, n = 12): ResearchBar[] => Array.from({ length: n }, (_, i) => ({ open_time: i * H, close_time: i * H + H - 1, available_at: i * H + H - 1, open: '100', high: String(hi(i)), low: String(lo(i)), close: '100', volume: '1' }));
    const up = mk((i) => (i % 3 === 2 ? 101.5 : 100.2), () => 99.8);
    const r = targetFirstRate(up, 'long', 0.01, 0.01, 5)!;
    expect(r.target_first).toBe(1);
    expect(r.stop).toBe(0);
    expect(r.breakeven).toBeCloseTo(0.5, 8);
    expect(r.independent).toBeGreaterThan(0);
    expect(r.independent).toBeLessThan(r.target);
    // 同一根既破止损又到目标 → 记止损
    const both = mk(() => 101.5, () => 98.5, 6);
    expect(targetFirstRate(both, 'long', 0.01, 0.01, 5)).toMatchObject({ target_first: 0, target: 0, stop: 5 });
    // 都没碰到 → 超时,无已决样本 → null
    expect(targetFirstRate(mk(() => 100.2, () => 99.8, 20), 'long', 0.01, 0.01, 5)).toBeNull();
    expect(targetFirstRate(up, 'short', 0.01, 0.01, 5)!.target_first).toBe(0); // 做空:+1% 是止损
  });
  it('AI 模型缺席降级:未注入 judge / 连接没绑定 → 只按代码门槛,写明 AI 模型未参与', async () => {
    for (const o of [{ judge: false }, { bound: false }]) {
      // r2:PASS 需要够深的历史与流动性已检查 → DEEP + qv(断言不变)
      const { deps, provider } = setup({ ...o, bars: DEEP, qv: 5e7 });
      const d = await planGateService.handle(plan(good), planGateService.validate(plan(good)), deps);
      expect(d.payload['verdict']).toBe('pass');
      expect(d.payload['ai_model']).toMatchObject({ involved: false });
      expect(d.text).toContain('AI model not involved');
      expect(provider.calls).toBe(0);
    }
  });
  it('预算闸:同一 job 上限用尽后模型拒绝 → 降级为代码门槛结论', async () => {
    const { deps, provider } = setup({ max_calls: 1 });
    await planGateService.handle(plan(good), planGateService.validate(plan(good)), deps);
    const later = makeBars(151);
    const d = await planGateService.handle(plan(good), planGateService.validate(plan(good)), { ...deps, bars: async () => later, now: () => later.at(-1)!.close_time + 1 });
    expect(provider.calls).toBe(1);
    expect(d.payload['ai_model']).toMatchObject({ involved: false, reason_codes: ['judge_budget_exhausted'] });
    expect(d.text).toContain('AI model not involved: AI model call failed (model call quota for this order used up)');
  });
  it('审核单 0xd86b1998 复现:入场价比现价低 23.9% → 最优先提示旧价格/笔误,带现价与时间,盈亏比给修正目标', async () => {
    const bars = scaledBars(84384.6);
    const { deps, provider } = setup({ bars, qv: 7832158483.28 });
    const j = job('{}', '请帮我检查BTC做多交易计划，入场64200，止损63100，目标65500，周期1小时，评估是否值得跟进。');
    const params = planGateService.validate(j);
    expect(params).toMatchObject({ symbol: 'BTCUSDT', side: 'long', entry: 64200, stop: 63100, targets: [65500], timeframe: '1h' });
    const d = await planGateService.handle(j, params, deps);
    expect(provider.calls).toBe(0);
    expect(d.payload['verdict']).toBe('fail');
    expect(d.summary).toBe('Verdict: FAIL — entry 64,200 is 23.9% below the last price 84,384.6, possibly a stale price or a typo (BTCUSDT long 1h)');
    const head = headOf(d.text);
    expect(head).toMatch(/Last price 84,384\.6 \(close as of \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);
    expect(head).not.toMatch(CJK);
    const fresh = (d.payload['gates'] as { key: string; note: string }[]).find((g) => g.key === 'entry_fresh')!;
    expect(fresh.note).toMatch(/^entry 64,200 is 23\.9% below the last price 84,384\.6 \(\d+\.\d ATR\), possibly a stale price or an input error; the plan does not hold at the current price$/);
    expect(fresh.note).not.toContain('target 1');
    expect(head).toContain('with a stop distance of 1,100, reaching 1.5 reward/risk needs a target of at least 65,850');
    expect(d.payload['fixes']).toMatchObject({ target_for_min_rr: 65850 });
    expect(d.payload['market_state']).toMatchObject({ last_close: 84384.6, stale_price_suspected: true, entry_drift_pct: -23.9198 });
    expect(head).toContain('24h volume: 7.83B USDT');
    expect(head).not.toMatch(/\d\.\d{7,}/);
    expect(noInternals(head)).toEqual([]);
    expect(noInternals(JSON.stringify(d.payload))).toEqual([]);
  });
  it('审核原句(中文计划)照常解析;交付正文纯英文、不转述中文原话、无建议腔', async () => {
    const bars = scaledBars(84384.6);
    const { deps } = setup({ bars, qv: 7832158483.28 });
    const j = job(null, '请帮我审核BTC做多的交易计划，入场84300，止损83100，止盈86500，周期1小时。');
    const params = planGateService.validate(j);
    expect(params).toEqual({ symbol: 'BTCUSDT', side: 'long', entry: 84300, stop: 83100, targets: [86500], timeframe: '1h', market: 'perp' });
    const d = await planGateService.handle(j, params, deps);
    const head = headOf(d.text);
    expect(head).not.toMatch(CJK);
    expect(ADVICE.test(head)).toBe(false);
    expect(head.split('\n')[0]).toBe('[Trade Plan Gate] Trading Swarm');
    expect(d.summary).toMatch(/^Verdict: (PASS|FAIL|UNCERTAIN) — .*\(BTCUSDT long 1h\)$/);
    expect(head).toContain('Plan: long, entry 84,300, stop 83,100, targets 86,500 · perpetual 1h');
    for (const label of ['Stop side', 'Weighted reward/risk', 'Stop distance', 'Plan freshness', 'Daily trend alignment', '24h volume']) expect(head).toContain(`${label}: `);
    expect(noInternals(head)).toEqual([]);
    expect(BANNED_WORDS.test(d.text)).toBe(false);
  });
  it('其它硬门槛失败的人话原因:止损太近 / 太远给出对应止损价,越过止损 / 已到目标写清', async () => {
    const { deps } = setup();
    const near = { entry: good.entry, stop: good.entry - 0.2 * ATR, targets: [good.entry + ATR] };
    const a = await planGateService.handle(plan(near), planGateService.validate(plan(near)), deps);
    expect((a.payload['gates'] as { key: string; note: string }[]).find((g) => g.key === 'stop_atr')!.note).toMatch(/^only 0\.20 ATR, normal noise can hit it; 0\.5 ATR corresponds to a stop at /);
    expect((a.payload['fixes'] as { stop_at_min_atr: number }).stop_at_min_atr).toBeCloseTo(good.entry - 0.5 * ATR, 4);
    const hit = { entry: LAST - 2 * ATR, stop: LAST - 3.5 * ATR, targets: [LAST - 0.5 * ATR] };
    const b = await planGateService.handle(plan(hit), planGateService.validate(plan(hit)), deps);
    expect((b.payload['gates'] as { key: string; note: string }[]).find((g) => g.key === 'entry_fresh')!.note).toMatch(/^the last price [\d,.]+ has already reached target 1 at [\d,.]+; the move this plan was aiming for has already happened$/);
  });
  it('数字格式化工具', () => {
    expect(fmtBig(7832158483.28)).toBe('7.83B');
    expect(fmtBig(2_000_000)).toBe('2M');
    expect(fmtPrice(84384.600000000006, 1)).toBe('84,384.6');
    expect(fmtPrice(83840.217857142867, 1)).toBe('83,840.2');
    expect(priceDigits(scaledBars(84384.6))).toBe(1);
    expect(utcText(Date.UTC(2026, 8, 25, 9))).toBe('2026-09-25 09:00 UTC');
  });
  it('K 线不足 / 过期 → handle 抛错(不交付)', async () => {
    const { deps } = setup({ bars: BARS.slice(-20) });
    await expect(planGateService.handle(plan(good), planGateService.validate(plan(good)), deps)).rejects.toThrow('bars_insufficient');
    const stale = setup({ now: NOW + 10 * H });
    await expect(planGateService.handle(plan(good), planGateService.validate(plan(good)), stale.deps)).rejects.toThrow('bars_stale');
  });
});

describe('plan_gate 结论由代码证据决定(r2,09-27 负责人拍板)', () => {
  const run = async (p: Record<string, unknown>, o: Parameters<typeof setup>[0]) => {
    const { deps } = setup(o);
    return planGateService.handle(plan(p), planGateService.validate(plan(p)), deps);
  };
  const reasons = (d: { payload: Record<string, unknown> }) => (d.payload['verdict_evidence'] as { uncertain_reasons: string[] }).uncertain_reasons;
  it('AI 概率不改结论:同一计划 AI 16% / 90% / 未接入 → 同样 PASS;AI 行写明「仅供参考、不改结论」', async () => {
    const out = [];
    for (const o of [{ fixed: 0.16 }, { fixed: 0.9 }, { judge: false }]) out.push(await run(good, { ...o, bars: DEEP, qv: 5e7, regime: 'bull' }));
    expect(out.map((d) => d.payload['verdict'])).toEqual(['pass', 'pass', 'pass']);
    expect(out[0]!.summary).toBe(out[1]!.summary);
    const h = headOf(out[0]!.text);
    const aiLine = h.split('\n').find((l) => l.startsWith('AI reference (uncalibrated'))!;
    expect(aiLine).toContain(AI_DOES_NOT_DECIDE);
    expect(aiLine).toContain('AI probability is shown for reference and does not change the verdict.');
    expect(out[0]!.payload['ai_model']).toMatchObject({ involved: true, affects_verdict: false, calibrated: false, take_yes: 0.16, conflict_with_code: true });
    expect(out[0]!.payload['verdict_evidence']).toMatchObject({ decided_by: 'code', uncertain_reasons: [], edge_margin_pts: 5, min_independent_samples: 30 });
    expect(h).toContain('Suggested fixes / what would make it stronger:');
    expect(h).not.toMatch(CJK);
    expect(ADVICE.test(h)).toBe(false);
  });
  it('UNCERTAIN 路径 1:历史频率离盈亏平衡不到 5 个点(0.6 ATR 止损 / 3 ATR 目标 ≈ 17% vs 17%)', async () => {
    const p = { entry: good.entry, stop: +(LAST - 0.6 * ATR).toFixed(4), targets: [+(LAST + 3 * ATR).toFixed(4)] };
    const d = await run(p, { fixed: 0.9, bars: DEEP, qv: 5e7, regime: 'bull' });
    expect(d.payload['verdict']).toBe('uncertain');
    expect(reasons(d)).toEqual(['near_breakeven']);
    expect(d.summary).toMatch(/^Verdict: UNCERTAIN — hard gates passed, but the history is within 5 pts of breakeven \(target 1 came before the stop \d+% of the time vs 17% breakeven, [+−]\d+ pts, ~\d+ samples\)/);
  });
  it('UNCERTAIN 路径 2:同距离历史独立样本太少(150 根 ≈ 5 个 < 30)', async () => {
    const d = await run(good, { fixed: 0.9, qv: 5e7, regime: 'bull' });
    expect(d.payload['verdict']).toBe('uncertain');
    expect(reasons(d)).toEqual(['small_sample']);
    expect(d.summary).toContain('the same-distance history has only ~5 independent samples (a firm read needs 30)');
  });
  it('UNCERTAIN 路径 3:历史明显低于盈亏平衡(上行行情里做空)—— 硬门槛全过所以不是 FAIL', async () => {
    const p = { side: 'short', entry: good.entry, stop: +(LAST + ATR).toFixed(4), targets: [+(LAST - 3 * ATR).toFixed(4)] };
    const d = await run(p, { fixed: 0.9, bars: DEEP, qv: 5e7, regime: 'range' });
    expect((d.payload['gates'] as { hard: boolean; status: string }[]).filter((g) => g.hard).every((g) => g.status === 'pass')).toBe(true);
    expect(d.payload['verdict']).toBe('uncertain');
    expect(reasons(d)).toEqual(['below_breakeven']);
    expect(d.summary).toMatch(/the history is below breakeven \(target 1 came before the stop 0% of the time vs 25% breakeven, −25 pts/);
    expect(d.payload['ai_model']).toMatchObject({ supported: true, conflict_with_code: true });
  });
  it('UNCERTAIN 路径 4:软门槛提示(逆日线 / 高波动 / 流动性薄)写明是哪条', async () => {
    for (const [o, re] of [[{ regime: 'bear' as const, qv: 5e7 }, /daily trend alignment flagged: daily downtrend, so this long is counter-trend/], [{ regime: 'volatile' as const, qv: 5e7 }, /daily trend alignment flagged: daily volatility is high/], [{ regime: 'bull' as const, qv: 1000 }, /24h volume flagged: low volume/]] as const) {
      const d = await run(good, { ...o, fixed: 0.9, bars: DEEP });
      expect(d.payload['verdict']).toBe('uncertain');
      expect(reasons(d)).toEqual(['soft_warning']);
      expect(d.summary).toMatch(re);
    }
  });
  it('UNCERTAIN 路径 5:有门槛未检查(24h 成交额 / 日线状态取不到)', async () => {
    const a = await run(good, { fixed: 0.9, bars: DEEP, regime: 'bull' });
    expect(a.payload['verdict']).toBe('uncertain');
    expect(reasons(a)).toEqual(['not_checked']);
    expect(a.summary).toContain('24h volume not checked');
    const b = await run(good, { fixed: 0.9, bars: DEEP, regime: null, qv: 5e7 });
    expect(reasons(b)).toEqual(['not_checked']);
    expect(b.summary).toContain('daily trend alignment not checked (daily regime unavailable, not checked)');
  });
  it('UNCERTAIN 路径 6 + 阈值单测:historyEvidence', () => {
    const r = (tf: number, be: number, n: number) => ({ target_first: tf, breakeven: be, independent: n, target: 1, stop: 1, timeouts: 0, risk_pct: 1, reward_pct: 2, max_bars: 100 });
    expect(historyEvidence(null)).toMatchObject({ key: 'no_history', edge: null });
    expect(historyEvidence(r(0.36, 0.33, 60)).key).toBe('near_breakeven'); // 复审实例:36% vs 33%
    expect(historyEvidence(r(0.33 + PLAN_EVIDENCE.edge_margin, 0.33, 60)).key).toBeNull(); // 刚好 5 个点 → 清楚高于
    expect(historyEvidence(r(0.2, 0.33, 60)).key).toBe('below_breakeven');
    expect(historyEvidence(r(0.9, 0.33, 29)).key).toBe('small_sample');
    expect(historyEvidence(r(0.6, 0.33, 30))).toMatchObject({ key: null, text: 'target 1 came before the stop 60% of the time vs 33% breakeven (+27 pts, ~30 samples)' });
  });
  it('硬门槛不过仍是 FAIL(fixable / invalidated 细分不变),AI 不被调用', async () => {
    const { deps, provider } = setup({ bars: DEEP, qv: 5e7 });
    const p = { ...good, targets: [good.entry + ATR] };
    const d = await planGateService.handle(plan(p), planGateService.validate(plan(p)), deps);
    expect(d.payload['verdict']).toBe('fail');
    expect(d.payload['verdict_detail']).toBe('fixable');
    expect(provider.calls).toBe(0);
  });
});

describe('jev_probability', () => {
  const jj = (x: Record<string, unknown> | string, description = '请用模型判断这个标的的概率分布,谢谢。', job_id = 'job_jev_1'): PerCallJob =>
    ({ job_id, service_key: 'plan_gate', description, service_params: typeof x === 'string' ? x : JSON.stringify(x) });
  const AUDIT = '请基于BTC 1小时周期，分析是否值得入场及支撑能否守住，返回概率分布和特征值。';

  it('解析:take 固定必答,问到的问题追加在后;都没问到 → 默认四题', () => {
    expect(jevProbabilityService.validate(jj({ symbol: 'ETH', timeframe: '4h', templates: ['take', 'quality'] }))).toEqual({ symbol: 'ETHUSDT', timeframe: '4h', market: 'perp', side: 'long', entry: null, stop: null, targets: [], templates: ['take', 'quality'], asked: ['take', 'quality'], horizon_bars: 4 });
    expect(jevProbabilityService.validate(jj({ symbol: 'ETH', templates: ['support_holds'] }))).toMatchObject({ templates: ['take', 'support_holds'], asked: ['support_holds'] });
    expect(jevProbabilityService.validate(jj('BTC 15m 支撑能不能守住,阻力会不会突破'))).toMatchObject({ symbol: 'BTCUSDT', timeframe: '15m', templates: ['take', 'support_holds', 'resistance_breaks'] });
    expect(jevProbabilityService.validate(jj('SOL 入场 150 止损 155'))).toMatchObject({ side: 'short', entry: 150, stop: 155, templates: ['take', 'support_holds', 'resistance_breaks', 'retreat_risk'] });
    // 审核单 0x234a4142 原话:「是否值得入场」+「支撑能否守住」
    expect(jevProbabilityService.validate(jj('{}', AUDIT))).toMatchObject({ symbol: 'BTCUSDT', timeframe: '1h', templates: ['take', 'support_holds'], asked: ['take', 'support_holds'] });
    for (const t of ['BTC 现在进场合适吗', 'BTC 值不值得开仓', 'should I enter BTC now?', 'is BTC worth a long here']) {
      const v = jevProbabilityService.validate(jj('{}', t));
      expect(v.templates[0]).toBe('take');
      expect(v.asked).toContain('take');
    }
    expect(jevProbabilityService.validate(jj('BTC 1h 回落风险大吗'))).toMatchObject({ templates: ['take', 'retreat_risk'] });
    expect(jevProbabilityService.validate(jj({ symbol: 'BTC', horizon_bars: 1 }))).toMatchObject({ horizon_bars: 1 });
  });
  it('缺字段 / 非法输入 / 模型不可用 → validate 拒单', () => {
    // 没写币种不再拒单:默认 BTCUSDT 并写明假设(复审 09-26)
    expect(jevProbabilityService.validate(jj('帮我判断一下行情概率', '请判断一下现在行情的概率分布'))).toMatchObject({ symbol: 'BTCUSDT', assumed: [expect.stringContaining('No symbol was given')] });
    expect(jevProbabilityService.validate(jj('Crypto Entry Setup Review', 'Analyze BTCUSD 1h entry setup for support hold and resistance break probabilities'))).toMatchObject({ symbol: 'BTCUSDT', timeframe: '1h' });
    // 认不出的问题不再拒单,退回默认四题
    expect(jevProbabilityService.validate(jj({ symbol: 'BTC', templates: ['profit'] }))).toMatchObject({ templates: ['take', 'support_holds', 'resistance_breaks', 'retreat_risk'] });
    // 真实买家 #13975 09-28 被拒的三单原样参数
    expect(jevProbabilityService.validate(jj({ symbol: 'BTCUSDT', timeframe: '1h', questions: ['entry_setup_reasonable', 'support_hold', 'resistance_break', 'pullback_risk'] })))
      .toMatchObject({ templates: ['take', 'support_holds', 'resistance_breaks', 'retreat_risk'], asked: ['take', 'support_holds', 'resistance_breaks', 'retreat_risk'] });
    expect(jevProbabilityService.validate(jj({ symbol: 'BTC-USDT', timeframe: '1H', side: 'long' }))).toMatchObject({ symbol: 'BTCUSDT', timeframe: '1h', side: 'long' });
    expect(jevProbabilityService.validate(jj({ symbol: 'BTC', timeframe: '240m' }))).toMatchObject({ timeframe: '4h' });
    expect(jevProbabilityService.validate(jj({ symbol: 'BTC', timeframe: 'Daily' }))).toMatchObject({ timeframe: '1d' });
    expect(code(() => jevProbabilityService.validate(jj({ symbol: 'BTC', timeframe: '5m' })))).toBe('timeframe_invalid');
    expect(code(() => jevProbabilityService.validate(jj({ symbol: 'BTC', side: 'long', entry: 100, stop: 101 })))).toBe('stop_side');
    expect(code(() => jevProbabilityService.validate(jj({ symbol: 'BTC', side: 'long', entry: 100, targets: [90] })))).toBe('targets_side');
    expect(code(() => jevProbabilityService.validate(jj({ symbol: 'BTC', horizon_bars: 0 })))).toBe('horizon_invalid');
    expect(code(() => jevProbabilityService.validate(jj({ symbol: 'BTC', horizon_bars: 99 })))).toBe('horizon_invalid');
    const guarded = createJevProbabilityService({ judgeAvailable: () => 'decision 角色未绑定' });
    expect(code(() => guarded.validate(jj({ symbol: 'BTC' })))).toBe('jev_unavailable');
    expect(code(() => createJevProbabilityService({ judgeAvailable: () => null }).validate(jj({ symbol: 'BTC' })))).toBeNull();
  });
  it('交付:英文结论首行、英文问题与标签、特征值、几何未给时按 ATR 推导并写明;不外露内部字段', async () => {
    const { deps, provider } = setup();
    const params = jevProbabilityService.validate(jj({ symbol: 'BTC', timeframe: '1h' }));
    const d = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), params, deps);
    expect(d.service_key).toBe('jev_probability');
    expect(provider.calls).toBe(1);
    const answers = d.payload['answers'] as { question_key: string; question: string; probabilities: Record<string, number>; base_rate: { yes: number; samples: number } | null; divergence: boolean }[];
    expect(answers.map((a) => a.question_key)).toEqual(['take', 'support_holds', 'resistance_breaks', 'retreat_risk']);
    expect(answers[0]!.probabilities).toEqual({ yes: 0.85, no: 0.15 });
    expect(answers[0]!.base_rate).toBeNull();
    expect(d.payload['setup']).toMatchObject({ geometry: { entry: 'last_close', stop: 'atr_1.5', targets: 'rr_2' }, reward_risk: 2 });
    // 首行结论
    expect(d.summary).toMatch(/^Conclusion: BTCUSDT 1h long \(at last price\) — the model puts the probability that the entry setup is "reasonable" at 85% \(model-generated reference; service reference threshold 55%, above the threshold\); support [\d.,]+ holds over the next 4 hours: historical same-distance \d+%, model 85%( \(large divergence\))?/);
    expect(ADVICE.test(headOf(d.text))).toBe(false);
    expect(d.text.split('\n')[1]).toBe(d.summary);
    const head = headOf(d.text);
    expect(head).toContain('· Support holds (the low over the next 4 hours stays above the nearest support');
    expect(head).toMatch(/holds 85% \/ breaks 15%/);
    expect(head).not.toMatch(/support_holds|\byes\b|\bno\b/);
    expect(head).not.toMatch(CJK);
    // 特征值
    const f = d.payload['features'] as Record<string, number | string | null>;
    expect(f).toMatchObject({ ema_stack: expect.stringMatching(/bull|bear|mixed/), volume_ratio: 1 });
    for (const k of ['rsi14', 'atr_pct', 'support_dist_atr', 'resistance_dist_atr', 'change_24h_pct', 'ema20', 'ema50']) expect(typeof f[k]).toBe('number');
    expect(f['rsi14']! as number).toBeGreaterThan(0); expect(f['rsi14']! as number).toBeLessThan(100);
    expect(head).toMatch(/Features: EMA (bullish stack|bearish stack|mixed) \(EMA20 [\d.,]+ \/ EMA50 [\d.,]+\) · RSI14 \d+\.\d · ATR14 [\d.,]+ \([\d.]+%\) · to support -?\d+\.\d ATR · to resistance -?\d+\.\d ATR · 24h [+-]\d+\.\d\d% · volume ratio 1\.00/);
    expect((d.payload['model_inputs'] as Record<string, unknown>)).toMatchObject({ trend: 'up' });
    // 内部字段不外露
    expect(d.payload['model']).toEqual({ name: 'AI decision model', revision_tag: expect.stringMatching(/^[0-9a-f]{10}$/) });
    for (const k of ['state', 'cost', 'decision_id', 'request_hash', 'reason_codes']) expect(d.payload).not.toHaveProperty(k);
    expect(noInternals(head)).toEqual([]);
    expect(noInternals(JSON.stringify(d.payload))).toEqual([]);
    expect(head).toContain('AI decision model');
    expect(head).toContain(DISCLAIMER_AI);
    expect(head).not.toContain('Note:');
    // 浮点噪声
    expect(head).not.toMatch(/\d\.\d{7,}/);
    expect(JSON.stringify(d.payload)).not.toMatch(/\d\.\d{9,}/);
    expect(BANNED_WORDS.test(d.text)).toBe(false);
  });
  it('价位类问题时长跟随周期:1h → 未来 4 小时,15m → 未来 1 小时,horizon_bars 可调;发给模型的问题同步改写(模型侧仍是中文模板)', async () => {
    const { deps, provider } = setup();
    const d = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), jevProbabilityService.validate(jj({ symbol: 'BTC', timeframe: '1h' })), deps);
    expect(d.payload['horizon']).toEqual({ bars: 4, text: '4 hours', applied: true, applies_to: ['support_holds', 'resistance_breaks', 'retreat_risk'] });
    const req = provider.requests[0] as { questions: Record<string, { instructions: string; criteria: Record<string, string> }> };
    for (const k of ['support_holds', 'resistance_breaks', 'retreat_risk']) {
      expect(req.questions[k]!.instructions).toContain('未来4小时');
      expect(JSON.stringify(req.questions[k])).not.toContain('15分钟');
    }
    expect(headOf(d.text)).toContain('level questions look at the next 4 hours (4 × 1h bars)');

    const Q = 900_000, bars15 = makeBars(150, Q);
    const s15 = setup({ bars: bars15, now: bars15.at(-1)!.close_time + 1 + 60_000 });
    const d15 = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), jevProbabilityService.validate(jj({ symbol: 'BTC', timeframe: '15m' })), s15.deps);
    expect(d15.payload['horizon']).toMatchObject({ bars: 4, text: '1 hour', applied: true });
    const one = setup();
    const d1 = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), jevProbabilityService.validate(jj({ symbol: 'BTC', timeframe: '1h', horizon_bars: 1 })), one.deps);
    expect(d1.payload['horizon']).toMatchObject({ bars: 1, text: '1 hour' });
    expect(headOf(d1.text)).toContain('level questions look at the next 1 hour (1 × 1h bar)');
    expect(((one.provider.requests[0] as { questions: Record<string, { instructions: string }> }).questions['support_holds']!.instructions)).toContain('未来1小时');
    // 不同时长 = 不同决策身份,不会复用 4 小时的答案
    expect(d1.sha256).not.toBe(d.sha256);
  });
  it('历史基准率:同一批 K 线、同距离事件的频率,与模型概率并排;偏差 > 25pp 标分歧大', async () => {
    // 手工序列:收盘恒 100,最低 99.5、最高 100.5
    const flat: ResearchBar[] = Array.from({ length: 30 }, (_, i) => ({ open_time: i * H, close_time: i * H + H - 1, available_at: i * H + H - 1, open: '100', high: '100.5', low: '99.5', close: '100', volume: '1' }));
    // 30 根、H=4:26 个重叠窗口,互不重叠的只有 7 个
    expect(baseRates(flat, 4, 'long', { support: 99, resistance: 100.2, stop: 99.6 })).toEqual({
      support_holds: { yes: 1, windows: 26, independent: 7, distance_pct: expect.closeTo(1, 8) },
      resistance_breaks: { yes: 0, windows: 26, independent: 7, distance_pct: expect.closeTo(0.2, 8) },
      retreat_risk: { yes: 1, windows: 26, independent: 7, distance_pct: expect.closeTo(0.4, 8) },
    });
    expect(baseRates(flat, 1, 'long', { support: 99, resistance: null, stop: 99.6 }).support_holds).toMatchObject({ windows: 29, independent: 29 });
    expect(baseRates(flat, 4, 'long', { support: 99.6, resistance: null, stop: 99 })).toMatchObject({ support_holds: { yes: 0 }, retreat_risk: { yes: 0 } });
    expect(baseRates(flat, 4, 'short', { support: null, resistance: null, stop: 100.4 }).retreat_risk!.yes).toBe(1);

    // 服务里:基准率与 marketFeatures 同口径,模型给极端概率 → 分歧大
    const f = marketFeatures(BARS, H);
    const want = baseRates(BARS, 4, 'long', { support: f.support, resistance: f.resistance, stop: LAST - 1.5 * ATR });
    const p = want.support_holds!.yes > 0.5 ? 0.02 : 0.98;
    const { deps } = setup({ fixed: p });
    const d = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), jevProbabilityService.validate(jj('{}', 'BTC 1h 支撑能否守住')), deps);
    const sh = (d.payload['answers'] as { question_key: string; base_rate: { yes: number; independent_windows: number; overlapping_windows: number; bars: number }; divergence: boolean }[]).find((a) => a.question_key === 'support_holds')!;
    // 150 根、H=4:146 个重叠窗口 → 对外报 37 个独立窗口
    expect(sh.base_rate).toMatchObject({ independent_windows: 37, overlapping_windows: 146, bars: 150 });
    expect(sh.base_rate.yes).toBeCloseTo(want.support_holds!.yes, 4);
    expect(sh.divergence).toBe(true);
    const head = headOf(d.text);
    expect(head).toMatch(/historical same-distance holds \d+% \(~37 independent windows\) · model holds \d+% \/ breaks \d+% · model and historical frequency diverge widely/);
    expect(head).not.toMatch(/146 /);
    expect(head).toContain('over the last 150 closed 1h bars (target 1000 bars; only 150 available for this symbol)');
    expect(d.summary).toContain('large divergence');
    expect(d.payload['base_rate_bars']).toEqual({ used: 150, target: 1000 });
  });
  it('历史基准率一次拉 1000 根:独立窗口按不重叠计;模型输入仍只用最近 150 根(与只给 150 根时完全相同)', async () => {
    const long = makeBars(1200), now = long.at(-1)!.close_time + 1 + 60_000;
    const a = setup({ bars: long, now });
    const d = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), jevProbabilityService.validate(jj({ symbol: 'BTC' })), a.deps);
    expect(a.barLimits).toEqual([1000]);
    expect(d.payload['base_rate_bars']).toEqual({ used: 1000, target: 1000 });
    const sh = (d.payload['answers'] as { question_key: string; base_rate: { independent_windows: number; overlapping_windows: number; bars: number } }[]).find((x) => x.question_key === 'support_holds')!;
    expect(sh.base_rate).toMatchObject({ bars: 1000, overlapping_windows: 996, independent_windows: 249 });
    // take 旁边的代码对照(与模型无关):同一批 1000 根、同样止损 / 目标距离
    const setup_ = d.payload['setup'] as { entry: number; stop: number; targets: number[] };
    const tf = targetFirstRate(long.slice(-1000), 'long', (setup_.entry - setup_.stop) / setup_.entry, (setup_.targets[0]! - setup_.entry) / setup_.entry)!;
    expect((d.payload['take_code_reference'] as { target_first: number; independent_samples: number })).toMatchObject({ target_first: expect.closeTo(tf.target_first, 3), independent_samples: tf.independent });
    expect(headOf(d.text)).toMatch(/· Entry setup \(.*\): model reasonable 85% \/ not reasonable 15% · code reference: at the same distances, target 1 was hit before the stop \d+% of the time historically \(breakeven needs 33%; ~\d+ independent samples/);
    const head = headOf(d.text);
    expect(head).toContain('~249 independent windows');
    expect(head).not.toContain('available for this symbol');
    expect(head).not.toContain('small sample');
    const b = setup({ bars: long.slice(-150), now });
    await jevProbabilityService.handle(jj({ symbol: 'BTC' }), jevProbabilityService.validate(jj({ symbol: 'BTC' })), b.deps);
    expect((a.provider.requests[0] as { state: unknown }).state).toEqual((b.provider.requests[0] as { state: unknown }).state);
  });
  it('审核单 0x234a4142 复现:两问都答、1h 看未来 4 小时、带基准率与特征值、BTC 价位去浮点噪声', async () => {
    const bars = scaledBars(84384.6);
    const { deps } = setup({ bars });
    const j = jj('{}', AUDIT, '0x234a4142');
    const d = await jevProbabilityService.handle(j, jevProbabilityService.validate(j), deps);
    expect(d.payload['templates']).toEqual(['take', 'support_holds']);
    expect(d.summary).toMatch(/^Conclusion: BTCUSDT 1h long \(at last price\) — the model puts the probability that the entry setup is "reasonable" at \d+% \(model-generated reference; service reference threshold 55%, (above|near|below) the threshold\); support [\d,]+(\.\d)? holds over the next 4 hours: historical same-distance \d+%, model \d+%/);
    const head = headOf(d.text);
    expect(head).toContain('Last price 84,384.6 (close as of ');
    expect(head).toMatch(/stop [\d,]+(\.\d)? \(1\.5 ATR\)/);
    expect(head).not.toMatch(CJK);
    expect(ADVICE.test(head)).toBe(false);
    expect(head).not.toMatch(/\d\.\d{3,}/);
    expect((d.payload['setup'] as { entry: number; stop: number }).entry).toBe(84384.6);
    expect(d.payload['model_inputs']).toMatchObject({ reference: 84384.6, direction: 'long' });
    expect(JSON.stringify(d.payload)).not.toMatch(/\d{5}\.\d{2,}/); // BTC 价位只到 1 位小数
    expect(JSON.stringify(d.payload)).not.toMatch(/\.\d{9,}/);
    expect(String((d.payload['setup'] as { stop: number }).stop)).toMatch(/^\d+(\.\d)?$/);
    expect(noInternals(head + JSON.stringify(d.payload))).toEqual([]);
  });
  it('没有已确认摆动阻力时,价位类模板剔除并用英文写明,take 照常交付', async () => {
    const { deps } = setup({ bars: makeBars(150, H, false) });
    const params = jevProbabilityService.validate(jj({ symbol: 'BTC' }));
    const d = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), params, deps);
    expect(d.payload['templates']).toEqual(['take']);
    expect((d.payload['dropped_templates'] as { reason: string }[]).map((x) => x.reason)).toEqual(Array(3).fill('state_field_unavailable:candidate.resistance'));
    expect(headOf(d.text)).toContain('Not asked: Support holds (no confirmed swing resistance in the last 100 bars)');
    const only = jevProbabilityService.validate(jj({ symbol: 'BTC', templates: ['resistance_breaks'] }));
    const o = await jevProbabilityService.handle(jj({ symbol: 'BTC' }, undefined, 'job_jev_only'), only, deps);
    expect(o.payload['templates']).toEqual(['take']);
    expect(headOf(o.text)).toContain('Not asked: Resistance break');
  });
  it('同一 job 同一 K 线重试命中落库去重,不重复计费', async () => {
    const { deps, provider } = setup();
    const params = jevProbabilityService.validate(jj({ symbol: 'BTC' }));
    const a = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), params, deps);
    const b = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), params, deps);
    expect(provider.calls).toBe(1);
    expect(b.sha256).toBe(a.sha256);
  });
  it('预算闸:每 job 上限用尽 → handle 抛错,不交付', async () => {
    const svc = createJevProbabilityService({ max_calls_per_job: 1 });
    const { deps, provider } = setup();
    const params = svc.validate(jj({ symbol: 'BTC' }));
    await svc.handle(jj({ symbol: 'BTC' }), params, deps);
    const later = makeBars(151);
    await expect(svc.handle(jj({ symbol: 'BTC' }), params, { ...deps, bars: async () => later, now: () => later.at(-1)!.close_time + 1 })).rejects.toThrow(/jev_failed:.*judge_budget_exhausted/);
    expect(provider.calls).toBe(1);
    // 另一个 job 有自己的 scope,不受影响
    await expect(svc.handle(jj({ symbol: 'BTC' }, undefined, 'job_jev_2'), params, deps)).resolves.toMatchObject({ job_id: 'job_jev_2' });
  });
  it('模型不可用 → handle 抛错;单次价格上限高于 JUDGE_MAX_CALL_USD → 拒绝', async () => {
    const { deps } = setup({ bound: false });
    const params = jevProbabilityService.validate(jj({ symbol: 'BTC' }));
    await expect(jevProbabilityService.handle(jj({ symbol: 'BTC' }), params, deps)).rejects.toThrow('jev_unavailable');
    const pricey = setup();
    const b = pricey.deps.jev!()!;
    const expensive: JevDeps = { ...pricey.deps, jev: () => ({ ...b, profile: { ...b.profile, max_call_usd: '1' } }) };
    await expect(jevProbabilityService.handle(jj({ symbol: 'BTC' }), params, expensive)).rejects.toThrow('jev_price_cap_exceeded');
  });
  it('BANNED_WORDS:买方描述里的违规词不会进交付文本', async () => {
    const { deps } = setup();
    const j = jj({ symbol: 'BTC' }, '保证稳赚的 guaranteed risk-free 判断,快给我');
    const d = await jevProbabilityService.handle(j, jevProbabilityService.validate(j), deps);
    expect(BANNED_WORDS.test(d.text)).toBe(false);
  });
});
