import { afterEach, describe, expect, it } from 'vitest';
import type { ResearchBar } from '@trading-swarm/contracts';
import { openStateDb } from '../../src/state-db.js';
import { stubProfile, stubProvider, type JudgeStubKind } from '../../src/demo/research/judge/stubs.js';
import type { DecisionProvider } from '../../src/demo/research/judge/types.js';
import { BANNED_WORDS } from '../../src/demo/asp-agent/publisher.js';
import { ServiceInputError, type PerCallJob } from '../../src/demo/asp-agent/services/types.js';
import { atr14, createJevProbabilityService, jevJudge, jevProbabilityService, weightedRR, type JevBinding, type JevDeps } from '../../src/demo/asp-agent/services/jev-probability.js';
import { planGateService, type PlanGateDeps } from '../../src/demo/asp-agent/services/plan-gate.js';
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
  const deps: JevDeps & PlanGateDeps = {
    now: () => o.now ?? NOW,
    recommend: async () => { throw new Error('not used'); },
    matrix: () => null,
    bars: async () => bars,
    regime: async () => (o.regime === null ? null : regime(o.regime ?? 'bull')),
    jev: bindingFn,
    ...(o.judge === false ? {} : { judge: jevJudge(bindingFn, ['take', 'regime_fit'], o.max_calls ? { max_calls_per_job: o.max_calls } : {}) }),
    ...(o.qv !== undefined ? { quoteVolume24h: async () => o.qv ?? null } : {}),
  };
  return { state, provider, deps };
}
const job = (service_params: string | null, description = '请帮我把关这笔交易计划,给出结论和依据。', job_id = 'job_0001'): PerCallJob => ({ job_id, service_key: 'plan_gate', description, service_params });
const plan = (x: Record<string, unknown>) => job(JSON.stringify({ symbol: 'BTC', side: 'long', timeframe: '1h', ...x }));
const good = { entry: +(LAST).toFixed(4), stop: +(LAST - 1.5 * ATR).toFixed(4), targets: [+(LAST + 3 * ATR).toFixed(4), +(LAST + 4 * ATR).toFixed(4)] };
const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof ServiceInputError ? e.code : `other:${(e as Error).message}`; } };

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
  it('全部通过 + Jev 支持 → follow,带 Jev 概率与模型版本', async () => {
    const { deps, provider } = setup({ qv: 5e7 });
    const d = await planGateService.handle(job(JSON.stringify({ symbol: 'BTC', side: 'long', ...good })), planGateService.validate(plan(good)), deps);
    expect(d.payload['verdict']).toBe('follow');
    expect(provider.calls).toBe(1);
    const jev = d.payload['jev'] as { involved: boolean; take_yes: number; model_revision: string };
    expect(jev).toMatchObject({ involved: true, take_yes: 0.85, model_revision: 'stub_v1_seed_1' });
    expect((d.payload['gates'] as { status: string }[]).map((g) => g.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    expect(d.text).toContain('可跟随 follow');
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
  ])('硬门槛 %s 不过 → skip,且不调用 Jev', async (gate, p) => {
    const { deps, provider } = setup();
    const params = planGateService.validate(plan(p));
    const d = await planGateService.handle(plan(p), params, deps);
    expect(d.payload['verdict']).toBe('skip');
    expect((d.payload['gates'] as { key: string; status: string }[]).find((g) => g.key === gate)!.status).toBe('fail');
    expect(provider.calls).toBe(0);
    expect(d.text).toContain('Jev 未参与');
  });
  it('逆日线 / 高波动 / 流动性不足 → 软门槛 warn → uncertain', async () => {
    for (const [o, key] of [[{ regime: 'bear' as const }, 'regime'], [{ regime: 'volatile' as const }, 'regime'], [{ qv: 1000 }, 'liquidity']] as const) {
      const { deps } = setup(o);
      const d = await planGateService.handle(plan(good), planGateService.validate(plan(good)), deps);
      expect(d.payload['verdict']).toBe('uncertain');
      expect((d.payload['gates'] as { key: string; status: string }[]).find((g) => g.key === key)!.status).toBe('warn');
    }
  });
  it('Jev 判断不支持 → skip;Jev 边缘 → uncertain', async () => {
    const skip = setup({ kind: 'all_skip' });
    expect((await planGateService.handle(plan(good), planGateService.validate(plan(good)), skip.deps)).payload['verdict']).toBe('skip');
    const edge = setup({ fixed: 0.56 });
    expect((await planGateService.handle(plan(good), planGateService.validate(plan(good)), edge.deps)).payload['verdict']).toBe('uncertain');
  });
  it('Jev 缺席降级:未注入 judge / 连接没绑定 → 只按代码门槛,写明 Jev 未参与', async () => {
    for (const o of [{ judge: false }, { bound: false }]) {
      const { deps, provider } = setup(o);
      const d = await planGateService.handle(plan(good), planGateService.validate(plan(good)), deps);
      expect(d.payload['verdict']).toBe('follow');
      expect(d.payload['jev']).toMatchObject({ involved: false });
      expect(d.text).toContain('Jev 未参与');
      expect(provider.calls).toBe(0);
    }
  });
  it('预算闸:同一 job 上限用尽后 Jev 拒绝 → 降级为代码门槛结论', async () => {
    const { deps, provider } = setup({ max_calls: 1 });
    await planGateService.handle(plan(good), planGateService.validate(plan(good)), deps);
    const later = makeBars(151);
    const d = await planGateService.handle(plan(good), planGateService.validate(plan(good)), { ...deps, bars: async () => later, now: () => later.at(-1)!.close_time + 1 });
    expect(provider.calls).toBe(1);
    expect(d.payload['jev']).toMatchObject({ involved: false, reason_codes: ['judge_budget_exhausted'] });
    expect(d.text).toContain('Jev 未参与');
  });
  it('K 线不足 / 过期 → handle 抛错(不交付)', async () => {
    const { deps } = setup({ bars: BARS.slice(-20) });
    await expect(planGateService.handle(plan(good), planGateService.validate(plan(good)), deps)).rejects.toThrow('bars_insufficient');
    const stale = setup({ now: NOW + 10 * H });
    await expect(planGateService.handle(plan(good), planGateService.validate(plan(good)), stale.deps)).rejects.toThrow('bars_stale');
  });
});

describe('jev_probability', () => {
  const jj = (x: Record<string, unknown> | string, description = '请用 Jev 判断这个标的的概率分布,谢谢。', job_id = 'job_jev_1'): PerCallJob =>
    ({ job_id, service_key: 'plan_gate', description, service_params: typeof x === 'string' ? x : JSON.stringify(x) });

  it('解析:JSON / 自由文本模板关键词 / 默认模板', () => {
    expect(jevProbabilityService.validate(jj({ symbol: 'ETH', timeframe: '4h', templates: ['take', 'quality'] }))).toEqual({ symbol: 'ETHUSDT', timeframe: '4h', market: 'perp', side: 'long', entry: null, stop: null, targets: [], templates: ['take', 'quality'] });
    expect(jevProbabilityService.validate(jj('BTC 15m 支撑能不能守住,阻力会不会突破'))).toMatchObject({ symbol: 'BTCUSDT', timeframe: '15m', templates: ['support_holds', 'resistance_breaks'] });
    expect(jevProbabilityService.validate(jj('SOL 入场 150 止损 155'))).toMatchObject({ side: 'short', entry: 150, stop: 155, templates: ['take', 'support_holds', 'resistance_breaks', 'retreat_risk'] });
  });
  it('缺字段 / 非法输入 / Jev 不可用 → validate 拒单', () => {
    expect(code(() => jevProbabilityService.validate(jj('帮我判断一下行情概率', '请用 Jev 判断一下现在行情的概率分布')))).toBe('symbol_missing');
    expect(code(() => jevProbabilityService.validate(jj({ symbol: 'BTC', templates: ['profit'] })))).toBe('templates_invalid');
    expect(code(() => jevProbabilityService.validate(jj({ symbol: 'BTC', side: 'long', entry: 100, stop: 101 })))).toBe('stop_side');
    expect(code(() => jevProbabilityService.validate(jj({ symbol: 'BTC', side: 'long', entry: 100, targets: [90] })))).toBe('targets_side');
    const guarded = createJevProbabilityService({ judgeAvailable: () => 'decision 角色未绑定' });
    expect(code(() => guarded.validate(jj({ symbol: 'BTC' })))).toBe('jev_unavailable');
    expect(code(() => createJevProbabilityService({ judgeAvailable: () => null }).validate(jj({ symbol: 'BTC' })))).toBeNull();
  });
  it('交付:每题概率分布、模型版本、state 特征、成本;几何未给时按 ATR 推导并写明', async () => {
    const { deps, provider } = setup();
    const params = jevProbabilityService.validate(jj({ symbol: 'BTC', timeframe: '1h' }));
    const d = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), params, deps);
    expect(d.service_key).toBe('jev_probability');
    expect(provider.calls).toBe(1);
    const answers = d.payload['answers'] as { question_key: string; probabilities: Record<string, number> }[];
    expect(answers.map((a) => a.question_key)).toEqual(['take', 'support_holds', 'resistance_breaks', 'retreat_risk']);
    expect(answers[0]!.probabilities).toEqual({ yes: 0.85, no: expect.closeTo(0.15, 10) });
    expect(d.payload['model']).toMatchObject({ model: 'stub/deterministic', model_revision: 'stub_v1_seed_1' });
    expect((d.payload['state'] as { features: Record<string, unknown> }).features).toMatchObject({ trend: 'up' });
    expect((d.payload['state'] as { candidate: Record<string, unknown> }).candidate).toHaveProperty('support');
    expect(d.payload['setup']).toMatchObject({ geometry: { entry: 'last_close', stop: 'atr_1.5', targets: 'rr_2' }, reward_risk: 2 });
    expect(d.payload['cost']).toMatchObject({ cost_usd: '0', cost_status: 'actual', budget: { max_calls: 2, calls: 1 } });
    expect(d.text).toContain('stub_v1_seed_1');
    expect(BANNED_WORDS.test(d.text)).toBe(false);
  });
  it('没有已确认摆动阻力时,价位类模板剔除并写明,其余照常交付', async () => {
    const { deps } = setup({ bars: makeBars(150, H, false) });
    const params = jevProbabilityService.validate(jj({ symbol: 'BTC' }));
    const d = await jevProbabilityService.handle(jj({ symbol: 'BTC' }), params, deps);
    expect(d.payload['templates']).toEqual(['take']);
    expect((d.payload['dropped_templates'] as { reason: string }[]).map((x) => x.reason)).toEqual(Array(3).fill('state_field_unavailable:candidate.resistance'));
    const only = jevProbabilityService.validate(jj({ symbol: 'BTC', templates: ['resistance_breaks'] }));
    await expect(jevProbabilityService.handle(jj({ symbol: 'BTC' }), only, deps)).rejects.toThrow('jev_state_unavailable:candidate.resistance');
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
  it('Jev 不可用 → handle 抛错;单次价格上限高于 JUDGE_MAX_CALL_USD → 拒绝', async () => {
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
