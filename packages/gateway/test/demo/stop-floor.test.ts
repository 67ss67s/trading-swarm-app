/**
 * 09-27 止损底线两种模式(契约 §9.56):百分比 / ATR 的判定、ATR 取不到时的回退、所有调用点走同一个函数、
 * 启动一次性迁移、GET /api/execution-policy 的 stop_conversions、提示词里的底线数值。
 * 止损正例都 ≥0.6%,不拿 0.1–0.2% 当正常止损。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXECUTION_THRESHOLDS, executionThresholds, policyFit, renderStopFloor, stopFloorPct, stopGeometry, stopGeometryReason, type ExecutionThresholds,
} from '../../src/demo/execution-policy.js';
import { executionCheck } from '../../src/demo/research/execution-gate.js';
import { evaluateGates, DEFAULT_GATES, type GateConfig, type GateContext } from '../../src/demo/gates.js';
import { applyWorkflowMigration, DEFAULT_PLAYBOOK, DEFAULT_WORKFLOW, LEGACY_DEFAULT_PLAYBOOK_V3, loadWorkflow, migrateWorkflowJson } from '../../src/demo/workflow.js';
import { buildContext, type EpisodeInputs } from '../../src/demo/context.js';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { PaperBackend } from '../../src/demo/execution.js';
import type { Judgment, MarketView, Workflow } from '../../src/demo/types.js';
import type { TfFeatures } from '../../src/demo/market.js';

const PCT = DEFAULT_EXECUTION_THRESHOLDS;
const ATR: ExecutionThresholds = { ...PCT, stop_floor_mode: 'atr', stop_floor_atr_tf: '1h', min_stop_atr: 1 };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe('两种模式的判定', () => {
  it('默认百分比模式 1%:只看百分比,ATR 只用来显示倍数', () => {
    // BTC 1h:价格 100,ATR 0.55(0.55%)
    expect(stopGeometry(100, 98.5, 0.55, PCT)).toMatchObject({ mode: 'pct', blocks: [], effective_min_pct: 1 });
    const tight = stopGeometry(100, 99.4, 0.55, PCT);
    expect(tight.blocks).toEqual(['stop_distance']);
    expect(stopGeometryReason(tight, PCT)).toBe('0.60%(允许 1%–5%)');
    // 1.2% 只有 0.6×ATR(ATR 2):百分比模式照样放行
    expect(stopGeometry(100, 98.8, 2, PCT).blocks).toEqual([]);
    expect(stopGeometry(100, 94, 0.55, PCT).blocks).toEqual(['stop_too_wide']);
  });

  it('ATR 模式:只看 k×所选周期 ATR,百分比底线不生效;上限照判', () => {
    // ATR 0.55:0.6% = 1.09×ATR 放行(比 1% 窄也放行);0.4% = 0.73×ATR 挡,原因码 stop_atr
    expect(stopGeometry(100, 99.4, 0.55, ATR)).toMatchObject({ mode: 'atr', atr_fallback: false, blocks: [] });
    const g = stopGeometry(100, 99.6, 0.55, ATR);
    expect(g.blocks).toEqual(['stop_atr']);
    expect(g.effective_min_pct).toBeCloseTo(0.55, 9);
    expect(stopGeometryReason(g, ATR)).toBe('0.73×ATR(下限 1×1h ATR ≈ 0.55%;距离 0.40%,上限 5%)');
    // 波动大的币:ATR 2(2%),1.5% 的止损只有 0.75×ATR,被挡
    expect(stopGeometry(100, 98.5, 2, ATR).blocks).toEqual(['stop_atr']);
    expect(stopGeometry(100, 94, 2, ATR).blocks).toEqual(['stop_too_wide']);
    // k=0 = 关掉下限,只剩上限
    expect(stopGeometry(100, 99.6, 0.55, { ...ATR, min_stop_atr: 0 }).blocks).toEqual([]);
  });

  it('ATR 模式但 ATR 取不到:改按百分比判,原因里写「ATR 不可用,改按百分比」,原因码 stop_distance', () => {
    for (const atr of [null, undefined, 0, -1, NaN, Infinity]) {
      const g = stopGeometry(100, 99.4, atr, ATR);
      expect(g).toMatchObject({ mode: 'atr', atr_fallback: true, blocks: ['stop_distance'], effective_min_pct: 1 });
      expect(stopGeometryReason(g, ATR)).toBe('ATR 不可用,改按百分比:0.60%(允许 1%–5%)');
    }
    expect(stopGeometry(100, 98.5, null, ATR).blocks).toEqual([]);
  });

  it('当前实际最小止损百分比 stopFloorPct 与给模型看的底线文字', () => {
    expect(stopFloorPct(PCT, 0.55, 100)).toBe(1);
    expect(stopFloorPct(ATR, 0.55, 100)).toBeCloseTo(0.55, 9);
    expect(stopFloorPct({ ...ATR, min_stop_atr: 2.3 }, 0.55, 100)).toBeCloseTo(1.265, 9);
    expect(stopFloorPct(ATR, null, 100)).toBeNull();
    expect(renderStopFloor(PCT, null)).toBe('止损至少 1.00%,不超过 5%');
    expect(renderStopFloor(ATR, 0.55, 'BTCUSDT')).toBe('止损至少 1×1h ATR(当前 BTC≈0.55%),不超过 5%');
    expect(renderStopFloor(ATR, null, 'SOLUSDT')).toContain('SOL 的 1h ATR 暂时取不到,代码会改按 1.00% 判');
  });
});

describe('所有调用点走同一个判定', () => {
  const judgment = (stop: string): Judgment => ({ action: 'PROPOSE', direction: 'long', confidence: 0.6, headline: 'h', thesis: 't', reasons: [], evidence_refs: [], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [],
    proposal: { market: 'perp', direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: stop, take_profit_price: null, take_profits: [], rationale: 'r' } });
  const ctx = (atr?: number | null): GateContext => ({ halted: false, paused: false, account: { equity: '10000', available: '10000', positions: [] } as never, market: { symbol: 'BTCUSDT', mark: '100', as_of: 0 } as MarketView, opens_today: 0, stale_refs: new Set(), ...(atr === undefined ? {} : { atr }) });
  const cfgOf = (th: ExecutionThresholds): GateConfig => ({ ...DEFAULT_GATES, stop_floor_mode: th.stop_floor_mode, stop_floor_atr_tf: th.stop_floor_atr_tf, min_stop_pct: th.min_stop_pct, max_stop_pct: th.max_stop_pct, min_stop_atr: th.min_stop_atr });
  const cases: [string, ExecutionThresholds, number, number | null][] = [
    ['百分比 1.5%', PCT, 98.5, 0.55], ['百分比 0.6%', PCT, 99.4, 0.55], ['百分比 7%', PCT, 93, 0.55],
    ['ATR 0.6%', ATR, 99.4, 0.55], ['ATR 0.4%', ATR, 99.6, 0.55], ['ATR 1.5% 大波动', ATR, 98.5, 2], ['ATR 取不到 0.6%', ATR, 99.4, null], ['ATR 取不到 1.5%', ATR, 98.5, null],
  ];
  it.each(cases)('%s:AI 扫盘开仓检查、回测 executionCheck、策略运行预检 policyFit 结论一致', (_n, th, stop, atr) => {
    const g = stopGeometry(100, stop, atr, th);
    // AI 扫盘 / 策略运行 / 订阅信号 / 对话提议:runtime 都调 evaluateGates
    const failed = evaluateGates(judgment(String(stop)), ctx(atr), cfgOf(th)).filter((x) => !x.passed && ['止损距离', '止损ATR下限'].includes(x.name));
    expect(failed.map((x) => x.code).sort()).toEqual([...g.blocks].sort());
    // 研究回测(research/execution-gate.ts)
    expect(executionCheck('long', 100, stop, null, atr, th).blocks).toEqual(g.blocks);
    // 策略运行预检(strategy-run.ts executionFit → policyFit)
    const fit = policyFit([{ side: 'long', ref: 100, stop, target: null, atr }], th);
    expect(fit.rejected).toBe(g.blocks.length ? 1 : 0);
    for (const b of g.blocks) expect(fit.rejected_by_execution[b]).toBe(1);
  });

  it('ATR 模式下开仓检查的原因写明模式;回退时写明 ATR 不可用', () => {
    const atrRow = evaluateGates(judgment('99.6'), ctx(0.55), cfgOf(ATR)).find((x) => x.name === '止损ATR下限')!;
    expect(atrRow).toMatchObject({ passed: false, code: 'stop_atr' });
    expect(atrRow.reason).toContain('下限 1×1h ATR');
    const fallback = evaluateGates(judgment('99.4'), ctx(null), cfgOf(ATR)).find((x) => x.name === '止损距离')!;
    expect(fallback).toMatchObject({ passed: false, code: 'stop_distance' });
    expect(fallback.reason).toContain('ATR 不可用,改按百分比');
    // 订阅信号不传 ATR(undefined)时同样回退
    expect(evaluateGates(judgment('99.4'), ctx(), cfgOf(ATR)).find((x) => x.name === '止损距离')!.reason).toContain('ATR 不可用');
    // 百分比模式不出 ATR 那一行
    expect(evaluateGates(judgment('98.5'), ctx(0.55), cfgOf(PCT)).some((x) => x.name === '止损ATR下限')).toBe(false);
  });
});

describe('启动一次性迁移', () => {
  const raw = (patch: Record<string, unknown>) => {
    const w: Record<string, unknown> = { ...DEFAULT_WORKFLOW, ...patch };
    delete w['stop_floor_mode']; delete w['stop_floor_atr_tf'];
    return JSON.stringify(w);
  };

  it('只迁没人改过的旧默认值:0.3 → 1.0、0.5 倍 → 1.0;改过的、已经有模式字段的都不动', () => {
    expect(migrateWorkflowJson(raw({ min_stop_pct: 0.3, min_stop_atr: 0.5 })).changes.map((c) => c.key)).toEqual(['min_stop_pct', 'min_stop_atr']);
    expect(migrateWorkflowJson(raw({ min_stop_pct: 0.6, min_stop_atr: 0.8 })).changes).toEqual([]);
    expect(migrateWorkflowJson(JSON.stringify({ ...DEFAULT_WORKFLOW, min_stop_pct: 0.3, stop_floor_mode: 'pct' })).changes).toEqual([]);
    expect(migrateWorkflowJson(undefined).changes).toEqual([]);
    expect(migrateWorkflowJson('{坏的').changes).toEqual([]);
    for (const json of ['null', '[]', '42', '"text"']) expect(migrateWorkflowJson(json).changes).toEqual([]);
    expect(migrateWorkflowJson(raw({ min_stop_pct: '0.3', min_stop_atr: '0.5' })).changes).toEqual([]);
    expect(migrateWorkflowJson(JSON.stringify({ min_stop_pct: 0.3, min_stop_atr: 0.5, stop_floor_mode: null })).changes).toEqual([]);
    const w = applyWorkflowMigration(loadWorkflow(raw({ min_stop_pct: 0.3, min_stop_atr: 0.5 })), [{ key: 'min_stop_pct' }, { key: 'min_stop_atr' }]);
    expect(w).toMatchObject({ min_stop_pct: 1, min_stop_atr: 1, stop_floor_mode: 'pct' });
  });

  it('playbook 逐字等于旧出厂版才换成新默认,多一个空格都不动', () => {
    expect(LEGACY_DEFAULT_PLAYBOOK_V3).toContain('止损放在最近 swing 低/高之外(至少 0.8 ATR)');
    expect(DEFAULT_PLAYBOOK).toContain('止损放在最近结构位(swing 低/高)之外,至少 1%');
    expect(DEFAULT_PLAYBOOK).toContain('第一止盈至少是止损距离的 1.5 倍');
    expect(migrateWorkflowJson(raw({ playbook_text: LEGACY_DEFAULT_PLAYBOOK_V3, min_stop_pct: 0.6 })).changes.map((c) => c.key)).toEqual(['playbook_text']);
    expect(migrateWorkflowJson(raw({ playbook_text: LEGACY_DEFAULT_PLAYBOOK_V3 + ' ', min_stop_pct: 0.6 })).changes).toEqual([]);
    expect(migrateWorkflowJson(raw({ playbook_text: '我自己写的', min_stop_pct: 0.6 })).changes).toEqual([]);
  });

  function boot(json: string) {
    const state = openStateDb(':memory:'); cleanups.push(() => state.close());
    const store = new DemoStore(state);
    store.saveWorkflow(JSON.parse(json) as Workflow);
    return { store, rt: new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: {} }) };
  }

  it('runtime 启动时迁移、存库并记一条活动日志;再启动一次不会重复', () => {
    const { store, rt } = boot(raw({ min_stop_pct: 0.3, min_stop_atr: 0.5, playbook_text: LEGACY_DEFAULT_PLAYBOOK_V3 }));
    expect(rt.workflow).toMatchObject({ min_stop_pct: 1, min_stop_atr: 1, stop_floor_mode: 'pct', stop_floor_atr_tf: '1h', playbook_text: DEFAULT_PLAYBOOK });
    const acts = store.activity(50).filter((a) => a.kind === 'workflow_changed' && (a.data as { via?: string }).via === 'migration');
    expect(acts).toHaveLength(1);
    expect(acts[0]!.title).toContain('止损下限 0.3% → 1%');
    const saved = JSON.parse(store.loadWorkflowJson()!) as Workflow;
    expect(saved).toMatchObject({ min_stop_pct: 1, stop_floor_mode: 'pct', playbook_text: DEFAULT_PLAYBOOK });
    const again = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: {} });
    expect(again.workflow.min_stop_pct).toBe(1);
    expect(store.activity(50).filter((a) => (a.data as { via?: string }).via === 'migration')).toHaveLength(1);
  });

  it('人改过的库:值不动,也不记迁移日志', () => {
    const { store, rt } = boot(raw({ min_stop_pct: 0.6, min_stop_atr: 0.8, playbook_text: '我自己写的 playbook' }));
    expect(rt.workflow).toMatchObject({ min_stop_pct: 0.6, min_stop_atr: 0.8, playbook_text: '我自己写的 playbook', stop_floor_mode: 'pct' });
    expect(store.activity(50).some((a) => (a.data as { via?: string }).via === 'migration')).toBe(false);
  });
});

describe('stop_conversions', () => {
  // 桩行情:价格 100,每根高低差 15m 0.3 / 1h 0.6 / 4h 1.2 → ATR14 ≈ 0.3% / 0.6% / 1.2%
  const RANGE: Record<string, number> = { '15m': 0.3, '1h': 0.6, '4h': 1.2 };
  async function setup(fetch?: (tf: string) => Promise<unknown>) {
    const market = await import('../../src/demo/market.js');
    const spy = vi.spyOn(market, 'fetchKlines').mockImplementation(async (_s, tf) => {
      if (fetch) return fetch(tf) as never;
      const ms = market.tfToMs(tf), end = Math.floor(Date.now() / ms) * ms, r = RANGE[tf] ?? 1;
      return Array.from({ length: 60 }, (_, i) => ({ open_time: end - (60 - i) * ms, close_time: end - (59 - i) * ms - 1, open: '100', high: String(100 + r / 2), low: String(100 - r / 2), close: '100', volume: '1' }));
    });
    const state = openStateDb(':memory:'); cleanups.push(() => state.close());
    const store = new DemoStore(state), backend = new PaperBackend(10_000);
    const rt = new DemoRuntime({ store, backend, brains: {} });
    rt.setWorkflow({ watchlist: ['BTCUSDT'] });
    rt.account = await backend.account();
    return { rt, spy };
  }

  it('按观察列表给出三个周期的 ATR%、当前模式下的最小止损和单笔风险;第二次读走缓存不再拉 K 线', async () => {
    const { rt, spy } = await setup();
    const v = await rt.stopConversions();
    expect(v.stop_conversions_stale).toBe(false);
    expect(v.risk_per_trade_usdt).toBe('50.00'); // 10000 × 0.5%
    const row = v.stop_conversions![0]!;
    expect(row).toMatchObject({ symbol: 'BTCUSDT', price: '100', floor_pct: 1, stale: false });
    expect(row.atr_pct['15m']).toBeCloseTo(0.3, 6);
    expect(row.atr_pct['1h']).toBeCloseTo(0.6, 6);
    expect(row.atr_pct['4h']).toBeCloseTo(1.2, 6);
    expect(typeof v.stop_conversions_as_of).toBe('number');
    const calls = spy.mock.calls.length;
    rt.setWorkflow({ stop_floor_mode: 'atr', stop_floor_atr_tf: '4h', min_stop_atr: 1.5 });
    const atr = await rt.stopConversions();
    expect(atr.stop_conversions![0]!.floor_pct).toBeCloseTo(1.8, 6); // 1.5 × 1.2%
    expect(spy.mock.calls.length).toBe(calls);
  });

  it('K 线一直不回:1 秒内返回,ATR 记 null 并标 stale;百分比模式的底线照样给', async () => {
    const { rt } = await setup(() => new Promise(() => {}));
    const t0 = Date.now();
    const v = await rt.stopConversions();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(v.stop_conversions_stale).toBe(true);
    expect(v.stop_conversions![0]).toMatchObject({ atr_pct: { '15m': null, '1h': null, '4h': null }, floor_pct: 1, stale: true, price: null });
    rt.setWorkflow({ stop_floor_mode: 'atr' });
    expect(rt.stopConversionsNow().stop_conversions![0]!.floor_pct).toBeNull();
  });
});

describe('提示词里的止损底线', () => {
  const now = Date.UTC(2026, 8, 27);
  const base: EpisodeInputs = { now, symbol: 'BTCUSDT', trigger: { kind: 'manual', detail: 't' }, mode: 'scan', thread: null, open_threads: [], account: { backend: 'paper', equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: now } as never,
    market: { symbol: 'BTCUSDT', last: '100', mark: '100', funding_rate: '', next_funding_at: now, open_interest: '', as_of: now, klines_tf: '15m' } as MarketView, features: [{ tf: '15m', atr14: 0.3, ema20: 100, ema50: 99, last_close: 100 } as TfFeatures],
    oi_change_1h_pct: null, ticker24h: { priceChangePercent: '0', highPrice: '101', lowPrice: '99', quoteVolume: '1' }, market_state: null, playbook_text: 'fixture', last_judgment_summary: null, halted: false };

  it('没传(eval 旧用例)按默认 1% 写进规则 5,不再写死 0.3%', () => {
    const b = buildContext(base);
    expect(b.system_text).toContain('按入场价算,止损至少 1.00%,不超过 5%');
    expect(b.system_text).not.toContain('0.3% 到 5%');
    expect(b.context_text).toContain('止损底线(代码核验)');
  });

  it('ATR 模式把本币当前折算的百分比写进规则和计划证据;绑了策略的扫盘不加这条证据', () => {
    const b = buildContext({ ...base, stop_floor: { thresholds: executionThresholds({ stop_floor_mode: 'atr', stop_floor_atr_tf: '1h', min_stop_atr: 1 }), atr_pct: 0.55 } });
    expect(b.system_text).toContain('止损至少 1×1h ATR(当前 BTC≈0.55%),不超过 5%');
    expect(b.context_text).toContain('止损至少 1×1h ATR(当前 BTC≈0.55%)');
    expect(b.system_text).toContain('同时不低于「止损底线(代码核验)」');
    expect(buildContext({ ...base, mode: 'review' }).context_text).not.toContain('止损底线(代码核验)');
  });
});
