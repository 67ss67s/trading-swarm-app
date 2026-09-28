// CandidateV0 影子候选(strategy-candidate.ts / routes-candidates.ts;契约 §9.50)。零模型、零网络。
import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type http from 'node:http';
import { openStateDb } from '../../src/state-db.js';
import type { Kline } from '../../src/demo/types.js';
import type { StrategyIR } from '@trade-gate/contracts';
import type { RouteContext, RouteHandler } from '../../src/demo/http-extra.js';
import { candidateRoutes } from '../../src/demo/routes-candidates.js';
import { candidateAt } from '../../src/demo/research/engine.js';
import { irCandidate, policyToIR } from '../../src/demo/research/strategy.js';
import {
  analyzeIR,
  generateCandidates,
  listCandidates,
  loadIRForShadow,
  matchModelEpisode,
  matchPending,
  persistCandidate,
  researchContext,
  resetCandidateShadowState,
  runCandidateShadow,
  settleCandidate,
  settleCandidates,
  summarizeCandidates,
  SYNTH_POLICY,
  SYNTH_STRATEGY_ID,
  toResearchBars,
  type StrategyCandidate,
} from '../../src/demo/strategy-candidate.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const bar = (i: number, o: number, h: number, l: number, c: number, v = 10): Kline => ({ open_time: T0 + i * H, close_time: T0 + i * H + H - 1, open: String(o), high: String(h), low: String(l), close: String(c), volume: String(v) });

/** 100 根窄幅震荡 + 第 100 根放量收盘突破 + 第 101 根回落。 */
function breakoutSeries(): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < 100; i++) out.push(bar(i, 100, 100.8, 99.2, 100 + (i % 2 ? 0.3 : -0.3)));
  out.push(bar(100, 100.2, 103.2, 100.1, 103, 30));
  out.push(bar(101, 103, 103.3, 102.5, 102.8));
  return out;
}

let db: DatabaseSync;
beforeEach(() => {
  db = openStateDb(':memory:').db;
  resetCandidateShadowState();
});

const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM demo_strategy_candidate').get() as { n: number }).n;
function insertEpisode(id: string, symbol: string, asOf: number, action: string | null, direction: string | null, thread: string | null = null): void {
  const json = { id, at: asOf + 1000, as_of: asOf, symbol, thread_id: thread, trigger: { kind: 'kline_close' }, judgment: action ? { action, direction } : null, gates: [{ name: 'min_rr', passed: action !== 'PROPOSE' }], intent: null };
  db.prepare('INSERT INTO demo_episodes(id, at, status, action, json) VALUES (?, ?, ?, ?, ?)').run(id, asOf + 1000, 'done', action, JSON.stringify(json));
}

describe('generateCandidates', () => {
  it('合成 1h 唐奇安:突破根收盘出一条候选,几何由 IR 算,下一根不出;同一根只落一条', () => {
    const shadow = loadIRForShadow(db);
    expect(shadow.source).toBe('synthesized_legacy');
    expect(shadow.strategy_id).toBe(SYNTH_STRATEGY_ID);
    expect(shadow.timeframe).toBe('1h');
    expect(shadow.ir_hash).toMatch(/^[0-9a-f]{64}$/);
    const k = breakoutSeries();
    const asOf = T0 + 101 * H;
    const g = generateCandidates({ shadow, symbol: 'BTCUSDT', klines: { '1h': k.slice(0, 101) }, now: asOf + 5000 });
    const c = g.candidate!;
    expect(c).not.toBeNull();
    expect(c.as_of).toBe(asOf);
    expect(c.direction).toBe('long');
    expect(c.entry_ref).toBe(103);
    const atr = (13 * 1.6 + 3.1) / 14;
    expect(c.stop).toBeCloseTo(103 - 2 * atr, 6);
    expect(c.target).toBeCloseTo(103 + 2 * 2 * atr, 6);
    expect(c.target_source).toBe('fixed_r_target');
    expect(c.rr).toBe(2);
    expect(c.invalidation).toBe(c.stop);
    expect(c.horizon_bars).toBe(48);
    expect(c.unmapped).toEqual([]);
    // 未收盘的第 101 根(now 在它收盘前)不进视图 → 结果与上面相同
    expect(generateCandidates({ shadow, symbol: 'BTCUSDT', klines: { '1h': k }, now: asOf + 5000 }).candidate?.id).toBe(c.id);
    // 第 101 根收盘后:不是突破
    const next = generateCandidates({ shadow, symbol: 'BTCUSDT', klines: { '1h': k }, now: asOf + H + 5000 });
    expect(next.candidate).toBeNull();
    expect(next.reason).toBe('no_candidate');
    expect(persistCandidate(db, c)).toBe(true);
    expect(persistCandidate(db, { ...c, at: c.at + 1 })).toBe(false);
    expect(count()).toBe(1);
  });

  it('irCandidate 在合成 IR 上与研究引擎旧路径 candidateAt 逐根一致(随机游走)', () => {
    const ir = policyToIR(SYNTH_POLICY);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const k: Kline[] = [];
    let px = 100;
    for (let i = 0; i < 600; i++) {
      const o = px;
      px = Math.max(1, px * (1 + (rnd() - 0.48) * 0.02));
      k.push(bar(i, o, Math.max(o, px) * (1 + rnd() * 0.004), Math.min(o, px) * (1 - rnd() * 0.004), px, 5 + rnd() * 20));
    }
    const bars = toResearchBars(k, H, T0 + 1000 * H);
    let fires = 0;
    for (let i = 30; i < bars.length; i++) {
      const view = bars.slice(0, i + 1);
      const a = irCandidate(ir, researchContext(view, 500, H)).entry;
      const b = candidateAt(view, SYNTH_POLICY);
      expect(!!a, `bar ${i}`).toBe(!!b);
      if (a && b) {
        fires++;
        expect(Number(a.stop)).toBeCloseTo(Number(b.stop), 6);
        expect(Number(a.target)).toBeCloseTo(Number(b.target), 6);
      }
    }
    expect(fires).toBeGreaterThan(3);
  });
});

describe('IR 选择与 unmapped', () => {
  it('做不到的原语全部进 unmapped,不近似;空头/Pine 不合格', () => {
    const ir = policyToIR(SYNTH_POLICY) as StrategyIR;
    ir.entry = { primitive: 'limit_pullback', params: {} };
    ir.exit = [
      { primitive: 'fixed_r_target', params: { r: 2 } },
      { primitive: 'structure_target', params: { swing_length: 5 } },
      { primitive: 'chandelier_trail', params: { atr_period: 14, multiple: 3 } },
      { primitive: 'indicator_cross_exit', params: {} },
      { primitive: 'time_stop', params: { bars: 24 } },
    ];
    const a = analyzeIR(ir);
    expect(a.eligible).toBe(true);
    expect(a.horizon_bars).toBe(24);
    expect(a.unmapped.some((u) => u.startsWith('entry:limit_pullback'))).toBe(true);
    expect(a.unmapped.some((u) => u.includes('多目标'))).toBe(true);
    expect(a.unmapped.some((u) => u.includes('chandelier_trail(ATR14×3)'))).toBe(true);
    expect(a.unmapped.some((u) => u.startsWith('exit:indicator_cross_exit'))).toBe(true);
    // 候选把 IR 的 unmapped 原样带上
    const shadow = { ...loadIRForShadow(db), ir, unmapped: a.unmapped, horizon_bars: a.horizon_bars };
    const c = generateCandidates({ shadow, symbol: 'BTCUSDT', klines: { '1h': breakoutSeries().slice(0, 101) }, now: T0 + 101 * H + 5000 }).candidate!;
    expect(c.unmapped).toEqual(a.unmapped);
    expect(c.horizon_bars).toBe(24);

    const short = { ...policyToIR(SYNTH_POLICY), order: { direction: 'both', market: 'perp' } } as unknown as StrategyIR;
    expect(analyzeIR(short).eligible).toBe(false);
    const pine = { ...policyToIR(SYNTH_POLICY), signal: [{ primitive: 'pine_series', params: { script_id: 'x' } }] } as StrategyIR;
    expect(analyzeIR(pine).eligible).toBe(false);
  });

  it('研究台有合格的 ≤1h long-only 版本就用它,否则合成', () => {
    const add = (id: string, tf: string, ir: StrategyIR, status = 'backtested') => {
      db.prepare(`INSERT INTO research_strategies(id, name, status, symbol, timeframe, current_version, origin_json, created_at, updated_at) VALUES (?, ?, ?, 'BTCUSDT', ?, 1, '{}', 1, 1)`).run(id, id, status, tf);
      db.prepare('INSERT INTO research_strategy_versions(strategy_id, version, ir_hash, ir_json, created_at) VALUES (?, 1, ?, ?, 1)').run(id, `h_${id}`, JSON.stringify(ir));
    };
    add('rs_daily', '1d', policyToIR(SYNTH_POLICY));
    add('rs_pine', '1h', { ...policyToIR(SYNTH_POLICY), signal: [{ primitive: 'pine_series', params: {} }] } as StrategyIR);
    const s1 = loadIRForShadow(db);
    expect(s1.source).toBe('synthesized_legacy');
    expect(s1.pick_note).toContain('2 条');
    add('rs_ok', '15m', policyToIR(SYNTH_POLICY));
    const s2 = loadIRForShadow(db);
    expect(s2).toMatchObject({ source: 'research_strategy_version', strategy_id: 'rs_ok', version: 1, ir_hash: 'h_rs_ok', timeframe: '15m' });
  });
});

describe('模型配对', () => {
  it('±1 根内最近的 episode;窗口没关不定稿;没有 episode 记 none', () => {
    const shadow = loadIRForShadow(db);
    const c = generateCandidates({ shadow, symbol: 'BTCUSDT', klines: { '1h': breakoutSeries().slice(0, 101) }, now: T0 + 101 * H + 5000 }).candidate!;
    const eth = { ...c, id: 'cand_00000000000000000001', symbol: 'ETHUSDT' };
    persistCandidate(db, c);
    persistCandidate(db, eth);
    insertEpisode('ep_far', 'BTCUSDT', c.as_of - 2 * H, 'PROPOSE', 'long');
    insertEpisode('ep_watch', 'BTCUSDT', c.as_of + 40 * 60_000, 'WATCH', null);
    insertEpisode('ep_near', 'BTCUSDT', c.as_of + 15 * 60_000, 'PROPOSE', 'long');
    expect(matchPending(db, c.as_of + 10 * 60_000)).toBe(0);
    const m = matchModelEpisode(db, c, c.as_of + H);
    expect(m).toMatchObject({ status: 'matched', bucket: 'propose_same', episode_id: 'ep_near', mode: 'scan', action: 'PROPOSE', direction: 'long', gates_failed: ['min_rr'], intent: false });
    expect(matchPending(db, c.as_of + H + 5 * 60_000)).toBe(2);
    const rows = db.prepare('SELECT symbol, model_episode_id, model_action, model_dir FROM demo_strategy_candidate ORDER BY symbol').all();
    expect(rows).toEqual([
      { symbol: 'BTCUSDT', model_episode_id: 'ep_near', model_action: 'PROPOSE', model_dir: 'long' },
      { symbol: 'ETHUSDT', model_episode_id: null, model_action: 'none', model_dir: null },
    ]);
    const s = summarizeCandidates(db);
    expect(s.pairing.propose_same.n).toBe(1);
    expect(s.pairing.no_episode.n).toBe(1);
    expect(s.model_proposals_without_candidate).toBe(0);
  });
});

describe('结算', () => {
  const asOf = T0 + 30 * H;
  const history = Array.from({ length: 30 }, (_, i) => bar(i, 100, 100.5, 99.5, 100));
  const forward = [
    ...Array.from({ length: 10 }, (_, k) => {
      const o = 100 + 0.35 * k;
      return bar(30 + k, o, o + 0.45, o - 0.1, o + 0.35);
    }),
    bar(40, 103.5, 103.55, 96, 96.5),
    ...Array.from({ length: 37 }, (_, k) => bar(41 + k, 96.5, 96.7, 96.3, 96.5)),
  ];
  const cand = (): StrategyCandidate => ({
    id: 'cand_settle0000000000000', version_tag: 'candidate-v0', at: asOf, as_of: asOf, symbol: 'BTCUSDT', timeframe: '1h', strategy_id: SYNTH_STRATEGY_ID, version: 1, ir_hash: 'h',
    ir_source: 'synthesized_legacy', origin: 'replay', direction: 'long', entry_type: 'next_open_market', entry_ref: 100, stop: 98, target: 104, target_source: 'fixed_r_target', rr: 2, invalidation: 98,
    horizon_bars: 48, reason: 't', unmapped: [], view_bars: 30, status: 'open', model: null, settlement: null,
  });

  it('计划腿拿到止损 −1R,吊灯腿被追踪带出为正', () => {
    const s = settleCandidate(cand(), [...history, ...forward], asOf + 49 * H);
    expect(s.source).toBe('plan_walk');
    expect(s.plan).toMatchObject({ status: 'stop', r: -1, fill_price: 100, exit_price: 98 });
    expect(s.trail!.status).toBe('trail');
    expect(s.trail!.r!).toBeGreaterThan(0.2);
  });

  it('settleCandidates 写回 outcome_r / outcome_r_trail;K 线不全且过了宽限记 unscoreable', async () => {
    persistCandidate(db, cand());
    const other = { ...cand(), id: 'cand_short00000000000000', symbol: 'ETHUSDT' };
    persistCandidate(db, other);
    const load = async (symbol: string) => (symbol === 'ETHUSDT' ? [...history, ...forward.slice(0, 10)] : [...history, ...forward]);
    expect(await settleCandidates(db, load, asOf + 47 * H)).toBe(0); // 没到期
    expect(await settleCandidates(db, load, asOf + 49 * H)).toBe(1); // ETH 缺根,还在宽限内
    expect(await settleCandidates(db, load, asOf + 60 * H)).toBe(1);
    const rows = db.prepare('SELECT symbol, outcome_r, outcome_r_trail, outcome_source FROM demo_strategy_candidate ORDER BY symbol').all() as { symbol: string; outcome_r: number | null; outcome_r_trail: number | null; outcome_source: string }[];
    expect(rows[0]).toMatchObject({ symbol: 'BTCUSDT', outcome_r: -1, outcome_source: 'plan_walk' });
    expect(rows[0]!.outcome_r_trail!).toBeGreaterThan(0.2);
    expect(rows[1]).toMatchObject({ symbol: 'ETHUSDT', outcome_r: null, outcome_source: 'unscoreable' });
    const s = summarizeCandidates(db);
    expect(s).toMatchObject({ n: 2, settled: 2, scoreable: 1, plan_expectancy_r: -1, share_with_target: 1, mean_rr: 2 });
    expect(s.trail_expectancy_r!).toBeGreaterThan(0.2);
    expect(s.by_symbol['BTCUSDT']!.settled).toBe(1);
    expect(s.nonoverlap).toMatchObject({ n: 1, plan_expectancy_r: -1 });
  });
});

describe('runCandidateShadow', () => {
  it('每根策略周期只生成一次;拉数失败吞掉并下次重试;从不抛错', async () => {
    const k = breakoutSeries().slice(0, 101);
    let calls = 0;
    const load = async (symbol: string) => {
      calls++;
      if (symbol === 'ERRUSDT') throw new Error('boom');
      return k;
    };
    const now = T0 + 101 * H + 5000;
    const logs: string[] = [];
    const r1 = await runCandidateShadow({ db, symbols: ['BTCUSDT', 'ERRUSDT'], now, loadKlines: load, log: (_l, m) => logs.push(m) });
    expect(r1).toMatchObject({ generated: 1, errors: 1, as_of: T0 + 101 * H });
    expect(logs.some((m) => m.includes('生成失败 ERRUSDT'))).toBe(true);
    const r2 = await runCandidateShadow({ db, symbols: ['BTCUSDT'], now: now + 1000, loadKlines: load });
    expect(r2.generated).toBe(0);
    expect(calls).toBe(3); // 上一轮不完整 → 重试;重试完整后同一根不再拉
    await runCandidateShadow({ db, symbols: ['BTCUSDT'], now: now + 2000, loadKlines: load });
    expect(calls).toBe(3);
    expect(count()).toBe(1);
    process.env['TG_CANDIDATE_SHADOW'] = '0';
    try {
      expect((await runCandidateShadow({ db, symbols: ['BTCUSDT'], loadKlines: load })).skipped).toBe('disabled');
    } finally {
      delete process.env['TG_CANDIDATE_SHADOW'];
    }
  });
});

describe('routes-candidates', () => {
  it('列表新的在前 + cursor 分页;summary 形状', async () => {
    const shadow = loadIRForShadow(db);
    const base = generateCandidates({ shadow, symbol: 'BTCUSDT', klines: { '1h': breakoutSeries().slice(0, 101) }, now: T0 + 101 * H + 5000 }).candidate!;
    for (let i = 0; i < 3; i++) persistCandidate(db, { ...base, id: `cand_${String(i).padStart(20, '0')}`, as_of: base.as_of + i * H });
    const handlers = new Map<string, RouteHandler>();
    const ctx = {
      route: (m: string, p: string, h: RouteHandler) => handlers.set(`${m} ${p}`, h),
      guarded: (fn: RouteHandler) => fn,
      json: (res: { status?: number; body?: unknown }, status: number, body: unknown) => Object.assign(res, { status, body }),
      fail: () => {},
      store: { marketDb: db },
    } as unknown as RouteContext;
    candidateRoutes(ctx);
    const call = async (path: string) => {
      const res: { status?: number; body?: any } = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
      const url = new URL(`http://x${path}`);
      await handlers.get(`GET ${url.pathname}`)!({} as http.IncomingMessage, res as unknown as http.ServerResponse, url, {});
      return res;
    };
    const p1 = await call('/api/candidates?limit=2');
    expect(p1.status).toBe(200);
    expect(p1.body.limit).toBe(2);
    expect(p1.body.rows.map((r: StrategyCandidate) => r.as_of)).toEqual([base.as_of + 2 * H, base.as_of + H]);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await call(`/api/candidates?limit=2&cursor=${p1.body.next_cursor}`);
    expect(p2.body.rows.map((r: StrategyCandidate) => r.as_of)).toEqual([base.as_of]);
    expect(p2.body.next_cursor).toBeNull();
    expect(listCandidates(db, { symbol: 'ETHUSDT' }).rows).toEqual([]);
    const s = await call('/api/candidates/summary');
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ version: 'candidate-v0', n: 3, open: 3, settled: 0 });
    expect(Object.keys(s.body.pairing)).toEqual(['propose_same', 'propose_opposite', 'no_trade', 'watch', 'review', 'no_judgment', 'no_episode', 'pending']);
    expect(s.body.pairing.pending.n).toBe(3);
  });
});
