// Judgment Replay(docs/research/judgment-replay-2026-09-23.md)的零模型机器。全部用合成 K 线 + 桩模型,不起任何进程。
// 这里任何一条挂了,真跑的数字都不可信:泄露未来、臂之间管仓不一致、重放对不上、预算闸失效、随机基线不可复现。
import { describe, expect, it, vi } from 'vitest';
import { rng as coreRng, settlePlan, settleTrail, viewAt } from '../../../../src/demo/geometry-lab/core.js';
import { tfFeatures } from '../../../../src/demo/market.js';
import { assertInputsBlind, buildEventContext, buildEvents, episodeInputs, lightFeatures, makeBundle, structuralStop, TRIGGER_FIELDS } from '../../../../src/demo/research/judgment-replay/events.js';
import { Budget, BudgetExhausted, decideProd, sha, stubClient, type PublicEvent } from '../../../../src/demo/research/judgment-replay/judge.js';
import { buildReport, freezeManifest, pub, replayDecisions, reportMarkdown, runArm } from '../../../../src/demo/research/judgment-replay/run.js';
import { settlePlanDir, settleTrailDir } from '../../../../src/demo/research/judgment-replay/settle.js';
import { armStats, paired, randomBaseline, sampleK, stratifiedSample } from '../../../../src/demo/research/judgment-replay/stats.js';
import { JrStore } from '../../../../src/demo/research/judgment-replay/store.js';
import { accountRow } from '../../../../src/demo/research/judgment-replay/account.js';
import { centerStats } from '../../../../src/demo/research/analyzer.js';
import { barsHash, countGaps } from '../../../../src/demo/research/judgment-replay/data.js';
import type { Bar, JrEvent, PeriodDef } from '../../../../src/demo/research/judgment-replay/types.js';

// 冻结要逐根重放触发器 + 构造生产上下文,合成数据上也要十几秒
vi.setConfig({ testTimeout: 120_000 });

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 6);
const N_BARS = 1300;

/** 带趋势切换、偶发放量的随机游走:足够让生产触发器(突破/均线交叉/放量/回踩)在上面反复触发。 */
function synth(seed: number, start = 100): Bar[] {
  const r = coreRng(seed);
  let c = start;
  const out: Bar[] = [];
  for (let i = 0; i < N_BARS; i++) {
    const o = c;
    const drift = Math.sin(i / 90) * 0.004;
    c = Math.max(1, c * (1 + drift + (r() - 0.5) * 0.018));
    const v = 100 + r() * 60 + (r() < 0.05 ? 400 : 0);
    out.push({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, available_at: T0 + (i + 1) * H - 1, open: o.toFixed(4), high: (Math.max(o, c) * (1 + r() * 0.004)).toFixed(4), low: (Math.min(o, c) * (1 - r() * 0.004)).toFixed(4), close: c.toFixed(4), volume: v.toFixed(2) });
  }
  return out;
}

const PERIOD: PeriodDef = { id: 'syn', from: T0 + 600 * H, to: T0 + 1100 * H, label: '合成段' };
const poison = (bars: Bar[], asOf: number): Bar[] => bars.map((b) => (b.open_time > asOf ? { ...b, open: '1', high: '99999', low: '0.5', close: '5000', volume: '1' } : b));

function memStore(): JrStore {
  const s = new JrStore(':memory:');
  for (const [sym, seed] of [['BTCUSDT', 3], ['ETHUSDT', 7]] as const) {
    const bars = synth(seed);
    s.putSeries({ venue: 'spot', symbol: sym, source: 'synthetic', source_id: `syn-${seed}`, bars, sha256: barsHash(bars), gaps: countGaps(bars) });
    s.putSeries({ venue: 'perp', symbol: sym, source: 'synthetic', source_id: `syn-${seed}`, bars, sha256: barsHash(bars), gaps: countGaps(bars) });
    s.putFunding(sym, Array.from({ length: N_BARS / 8 }, (_, i) => ({ at: T0 + i * 8 * H, rate: ((i % 5) - 1) * 0.0001 + '' })));
  }
  return s;
}

describe('事件:生产触发器重放', () => {
  const bars = synth(3);
  const b = makeBundle('spot', 'BTCUSDT', bars);
  const built = buildEvents(b, PERIOD, { directions: ['long'], cooldown_bars: 12 });

  it('产出事件,方向、冷却、结构止损下限都成立', () => {
    expect(built.events.length).toBeGreaterThan(5);
    const last = new Map<string, number>();
    for (const e of built.events) {
      expect(e.direction).toBe('long');
      expect(e.stop_atr).toBeGreaterThanOrEqual(0.5);
      expect(e.stop).toBeLessThan(e.ref_close);
      const prev = last.get(e.direction);
      if (prev !== undefined) expect(e.as_of - prev).toBeGreaterThanOrEqual(12 * H);
      last.set(e.direction, e.as_of);
    }
    expect(built.drops.accepted).toBe(built.events.length);
  });

  it('lightFeatures 在触发器字段上与生产 tfFeatures 逐位相等', () => {
    for (const i of [300, 555, 777, 1000]) {
      const w = bars.slice(i - 120, i);
      const a = lightFeatures('1h', w);
      const p = tfFeatures('1h', w);
      for (const k of TRIGGER_FIELDS) expect(a[k]).toBe(p[k]);
    }
  });

  it('防泄露:as_of 之后的 K 线换成垃圾,提示词逐字节不变、止损不变、输入过盲检', () => {
    for (const e of built.events.slice(0, 6)) {
      const clean = buildEventContext(b, e);
      const dirty = makeBundle('spot', 'BTCUSDT', poison(bars, e.as_of));
      const bad = buildEventContext(dirty, e);
      expect(bad.built.system_text).toBe(clean.built.system_text);
      expect(bad.built.user_text).toBe(clean.built.user_text);
      expect(structuralStop(viewAt('BTCUSDT', dirty.h1, e.as_of), 'long').stop).toBe(e.stop);
      expect(() => assertInputsBlind(episodeInputs(dirty, e.as_of, e.hits), e.as_of)).not.toThrow();
    }
  });

  it('防泄露:塞进一根未来 K 线,盲检会抛', () => {
    const e = built.events[0]!;
    const inp = episodeInputs(b, e.as_of, e.hits);
    const future = bars.find((x) => x.open_time > e.as_of)!;
    inp.klines!['1h'] = [...inp.klines!['1h']!, future];
    expect(() => assertInputsBlind(inp, e.as_of)).toThrow(/future_bar_leak/);
  });

  it('桩模型看到的 user 文本就是冻结的提示词,且不含 as_of 之后的时间', async () => {
    const e = built.events[2]!;
    const { built: ctx } = buildEventContext(b, e);
    const seen: string[] = [];
    const c = stubClient('stub-rule', { seen: (u) => seen.push(u) });
    await c.complete(ctx.system_text, ctx.user_text, pub(e), { timeoutMs: 1000 });
    expect(seen[0]).toBe(ctx.user_text);
    const stamps = [...ctx.user_text.matchAll(/20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g)].map((m) => Date.parse(m[0]));
    for (const t of stamps) expect(t).toBeLessThanOrEqual(e.as_of);
  });
});

describe('管仓:所有臂共用同一次结算', () => {
  const bars = synth(11);
  it('做多时与几何实验室 settleTrail / settlePlan 逐字段一致', () => {
    for (const i of [520, 640, 800, 950]) {
      const v = viewAt('X', bars, bars[i]!.close_time);
      const st = structuralStop(v, 'long');
      const fut = bars.slice(i + 1);
      const mine = settleTrailDir('long', st.stop, v.bars, fut, st.atr14);
      const core = settleTrail({ stop: st.stop, target: null, rationale: '', source_levels: [], flags: [] }, v.bars, fut, st.atr14);
      expect([mine.status, mine.fill, mine.exit_price, mine.bars_held, mine.gross_r, mine.net_r]).toEqual([core.status, core.fill, core.exit_price, core.bars_held, core.gross_r, core.net_r]);
      const tgt = Number(bars[i]!.close) + 2 * st.atr14;
      const mp = settlePlanDir('long', st.stop, tgt, fut, st.atr14);
      const cp = settlePlan({ stop: st.stop, target: tgt, rationale: '', source_levels: [], flags: [] }, fut, st.atr14);
      expect([mp.status, mp.exit_price, mp.net_r]).toEqual([cp.status, cp.exit_price, cp.net_r]);
    }
  });

  it('做空镜像:价格对称翻转后,空单结果与多单一致(无成本差异时)', () => {
    const flip = (b: Bar): Bar => ({ ...b, open: (1000 - Number(b.open)).toFixed(4), high: (1000 - Number(b.low)).toFixed(4), low: (1000 - Number(b.high)).toFixed(4), close: (1000 - Number(b.close)).toFixed(4) });
    const i = 700;
    const v = viewAt('X', bars, bars[i]!.close_time);
    const st = structuralStop(v, 'long');
    const long = settleTrailDir('long', st.stop, v.bars, bars.slice(i + 1), st.atr14);
    const fl = bars.map(flip);
    const vs = viewAt('X', fl, bars[i]!.close_time);
    const short = settleTrailDir('short', 1000 - st.stop, vs.bars, fl.slice(i + 1), st.atr14);
    expect(short.status).toBe(long.status);
    expect(short.bars_held).toBe(long.bars_held);
    expect(short.gross_r!).toBeCloseTo(long.gross_r!, 3);
  });

  it('同一事件在 A / 模型臂 / 随机臂上拿到的是同一个净 R', async () => {
    const s = memStore();
    const m = freezeManifest(s, { venue: 'spot', periods: [PERIOD], symbols: ['BTCUSDT', 'ETHUSDT'], cooldown_bars: 12, prompt_mode: 'prod' });
    await runArm(s, m.id, { arm: 'B', client: stubClient('stub-rule'), max_calls: 1000, max_cny: 1, concurrency: 3, timeout_ms: 1000 });
    const events = s.events(m.id).map((r) => r.event);
    const dec = new Map(s.decisions(m.id, 'B').map((d) => [d.event_id, d.decision.follow]));
    const perArm = (f: (e: JrEvent) => boolean): Map<string, number> => new Map(events.filter(f).map((e) => [e.id, e.trail.net_r!]));
    const a = perArm(() => true);
    const bArm = perArm((e) => dec.get(e.id) === true);
    for (const [id, r] of bArm) expect(r).toBe(a.get(id));
    const st = armStats('B', events, (e) => dec.get(e.id) === true, 'trail');
    expect(st.total_r).toBeCloseTo([...bArm.values()].reduce((x, y) => x + y, 0), 9);
    // 逐事件配对:A − B 恰好等于被 B 跳过的那些事件的净 R 之和 / n
    const pr = paired('A', () => true, 'B', (e) => dec.get(e.id) === true, events, 'trail');
    const skipped = events.filter((e) => dec.get(e.id) !== true).reduce((x, e) => x + e.trail.net_r!, 0);
    expect(pr.mean!).toBeCloseTo(skipped / events.length, 9);
    s.close();
  });
});

describe('冻结、零模型重放、报告', () => {
  it('同样输入重冻结得到同一个 manifest;两个桩臂落库后重放零差异、报告可重算且一致', async () => {
    const s = memStore();
    const opts = { venue: 'perp' as const, periods: [PERIOD], symbols: ['BTCUSDT', 'ETHUSDT'], cooldown_bars: 12, prompt_mode: 'prod' as const };
    const m1 = freezeManifest(s, opts);
    const m2 = freezeManifest(s, opts);
    expect(m2.id).toBe(m1.id);
    expect(m2.events.sha256).toBe(m1.events.sha256);
    expect(m1.directions).toEqual(['long', 'short']);
    await runArm(s, m1.id, { arm: 'B', client: stubClient('stub-rule'), max_calls: 1000, max_cny: 1, concurrency: 4, timeout_ms: 1000 });
    await runArm(s, m1.id, { arm: 'B2', client: stubClient('stub-random', { seed: 5 }), sample: 12, max_calls: 1000, max_cny: 1, concurrency: 2, timeout_ms: 1000 });
    expect(() => freezeManifest(s, opts)).toThrow(/已有模型输出/); // 有模型输出后不许重建事件
    const rp = replayDecisions(s, m1.id);
    expect(rp.checked).toBe(m1.events.count + 12);
    expect(rp.mismatches).toEqual([]);
    const r1 = reportMarkdown(buildReport(s, m1.id, 50));
    const r2 = reportMarkdown(buildReport(s, m1.id, 50));
    expect(r1).toBe(r2);
    expect(r1).toContain('生产 harness');
    expect(r1).toContain('随机基线');
    expect(buildReport(s, m1.id, 50).head_to_head?.n).toBe(12);
    // 报告层派生:中位数 / 截尾均值 + 账户折算(与 account.ts 直接算的一致),附仓位规则说明
    const rep = buildReport(s, m1.id, 50);
    const armA = rep.full.trail.arms[0]!;
    const rsA = s.events(m1.id).map((r) => r.event.trail.net_r).filter((x): x is number => x !== null);
    expect(armA.median_trade).toBeCloseTo(centerStats(rsA).median!, 12);
    expect(armA.trimmed_trade).toBeCloseTo(centerStats(rsA).trimmed_mean!, 12);
    expect(rep.full.trail.account.map((r) => r.arm)).toEqual(['A', 'A_f']);
    expect(rep.full.trail.account[0]).toEqual(accountRow('A', s.events(m1.id).map((r) => r.event), () => true, 'trail', 'perp', [PERIOD]));
    expect(rep.model_arms.find((a) => a.arm === 'B2')!.by_management.plan.account.map((r) => r.arm)).toEqual(['A', 'A_f', 'B2']);
    expect(rep.account.hold).toHaveLength(1);
    expect(rep.account.hold[0]!.symbols).toBe(2);
    expect(r1).toContain('真实盈亏的仓位规则');
    expect(r1).toContain('每笔风险 = 当前已实现权益 × 1%');
    expect(r1).toContain('中位 R');
    expect(r1).toContain('截尾均值 R');
    expect(r1).toContain('| 等权持有 |');
    // 换模型跑同一个臂会被拒(模型标识已冻结)
    await expect(runArm(s, m1.id, { arm: 'B', client: stubClient('stub-random'), max_calls: 10, max_cny: 1, concurrency: 1, timeout_ms: 1000 })).rejects.toThrow(/已冻结/);
    s.close();
  });

  it('research 模式在产物里标明「research prompt,非生产 harness」', () => {
    const s = memStore();
    const m = freezeManifest(s, { venue: 'spot', periods: [PERIOD], symbols: ['BTCUSDT'], cooldown_bars: 24, prompt_mode: 'research' });
    expect(m.prompt_label).toContain('research prompt,非生产 harness');
    const row = s.events(m.id)[0]!;
    expect(row.prompt.system).toContain('非生产 harness');
    expect(row.prompt.user).toContain('## 候选事件');
    s.close();
  });

  it('生产解析:PROPOSE 同向且过闸才算 follow;反向或契约错误都不算', async () => {
    const bars = synth(3);
    const b = makeBundle('spot', 'BTCUSDT', bars);
    const e = buildEvents(b, PERIOD, { directions: ['long'], cooldown_bars: 12 }).events[0]!;
    const { built, inputs } = buildEventContext(b, e);
    const p = { mode: 'prod' as const, system: built.system_text, user: built.user_text, allowed_actions: built.allowed_actions, strategy_ids: built.strategy_ids, evidence: built.evidence, market: inputs.market };
    const follow = await stubClient('stub-random', { p: 1 }).complete(p.system, p.user, pub(e), { timeoutMs: 1 });
    expect(decideProd(follow.text, p, e).follow).toBe(true);
    const opposite: PublicEvent = { ...pub(e), direction: 'short' };
    const shortText = (await stubClient('stub-random', { p: 1 }).complete(p.system, p.user, opposite, { timeoutMs: 1 })).text;
    const d = decideProd(shortText, p, e);
    expect(d.status).toBe('ok');
    expect(d.follow).toBe(false);
    expect(decideProd('not json at all', p, e).status).toBe('model_error');
  });
});

describe('预算上限', () => {
  it('调用数上限:到点就停,不多发一次', async () => {
    const s = memStore();
    const m = freezeManifest(s, { venue: 'spot', periods: [PERIOD], symbols: ['BTCUSDT', 'ETHUSDT'], cooldown_bars: 12, prompt_mode: 'prod' });
    let calls = 0;
    const r = await runArm(s, m.id, { arm: 'B', client: stubClient('stub-rule', { seen: () => calls++ }), max_calls: 5, max_cny: 1, concurrency: 3, timeout_ms: 1000 });
    expect(calls).toBe(5);
    expect(r.stopped).toMatch(/调用数上限/);
    expect(s.decisions(m.id, 'B')).toHaveLength(5);
    // 上限按整个实验库累计:再跑一次也不会多发
    const r2 = await runArm(s, m.id, { arm: 'B', client: stubClient('stub-rule', { seen: () => calls++ }), max_calls: 5, max_cny: 1, concurrency: 3, timeout_ms: 1000 });
    expect(calls).toBe(5);
    expect(r2.attempted).toBe(0);
    s.close();
  });

  it('人民币上限:用带价的名字(不起进程)跑,累计估算不越线', async () => {
    const s = memStore();
    const m = freezeManifest(s, { venue: 'spot', periods: [PERIOD], symbols: ['BTCUSDT', 'ETHUSDT'], cooldown_bars: 12, prompt_mode: 'prod' });
    const row = s.events(m.id)[0]!;
    const per = Budget.costOf('pi:zai/glm-5.3', Math.ceil((row.prompt.system + row.prompt.user).length / 3), 400);
    const cap = per * 3.5;
    const r = await runArm(s, m.id, { arm: 'B', client: stubClient('stub-rule', { name: 'pi:zai/glm-5.3' }), max_calls: 1000, max_cny: cap, concurrency: 1, timeout_ms: 1000 });
    expect(r.stopped).toMatch(/人民币上限/);
    expect(r.attempted).toBeGreaterThanOrEqual(2);
    expect(r.attempted).toBeLessThanOrEqual(4);
    expect(s.spend('pi:zai/glm-5.3').cny).toBeLessThanOrEqual(cap + 1e-9);
    s.close();
  });

  it('Budget.reserve 越线直接抛,不计数', () => {
    const b = new Budget('pi:deepseek/deepseek-v4-flash', 10, 0.001);
    const big = 'x'.repeat(3_000_000);
    expect(() => b.reserve(big, '', 400)).toThrow(BudgetExhausted);
    expect(b.calls).toBe(0);
  });
});

describe('随机基线与抽样可复现', () => {
  const evs: JrEvent[] = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, venue: 'spot', symbol: i % 2 ? 'A' : 'B', period: i < 30 ? 'p1' : 'p2', as_of: T0 + i * 5 * H, direction: 'long', kind: 'breakout', hits: [], ref_close: 1, atr14: 1, stop: 0, stop_source: '', stop_atr: 1, target: null, trend_ok: i % 3 === 0, trail: { management: 'trail', status: 'x', fill: 1, exit_price: 1, bars_held: 1, gross_r: 0, net_r: Math.sin(i) , funding_r: 0, funding_estimated: false, note: '' }, plan: { management: 'plan', status: 'x', fill: 1, exit_price: 1, bars_held: 1, gross_r: 0, net_r: Math.cos(i), funding_r: 0, funding_estimated: false, note: '' } }));
  const model = (e: JrEvent): boolean => Number(e.id.slice(1)) % 4 === 1;

  it('固定种子两次抽样完全一致,k 与模型做单数相同,不同种子不同', () => {
    const a = randomBaseline('B', model, evs, 'trail', 30, true);
    const b = randomBaseline('B', model, evs, 'trail', 30, true);
    expect(a).toEqual(b);
    expect(a.k).toBe(evs.filter(model).length);
    expect(a.picks!.every((p) => p.length === a.k && new Set(p).size === a.k)).toBe(true);
    expect(a.picks![0]).not.toEqual(a.picks![1]);
    expect(sampleK(60, 10, 7)).toEqual(sampleK(60, 10, 7));
  });

  it('分层子样本:总数正好、可复现、每层都有', () => {
    const s1 = stratifiedSample(evs, 20, sha);
    const s2 = stratifiedSample(evs, 20, sha);
    expect(s1.map((e) => e.id)).toEqual(s2.map((e) => e.id));
    expect(s1).toHaveLength(20);
    expect(new Set(s1.map((e) => `${e.period}|${e.symbol}`)).size).toBe(4);
  });

  it('整簇 bootstrap 区间固定种子可复现', () => {
    const x = armStats('A', evs, () => true, 'trail');
    const y = armStats('A', evs, () => true, 'trail');
    expect(x.ci_trade).toEqual(y.ci_trade);
    expect(x.ci_trade[0]!).toBeLessThanOrEqual(x.mean_trade!);
    expect(x.ci_trade[1]!).toBeGreaterThanOrEqual(x.mean_trade!);
  });
});
