/**
 * §9.56 执行层:阈值读取、止损和净盈亏比判定、参数校验、原因归类、来源漏斗、HTTP 读写。
 * 止损正例都用 ≥0.5% 且跟着周期变的值(15m 约 0.6%、4h 约 2%),不拿 0.1–0.2% 当正常止损。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_EXECUTION_THRESHOLDS, blendedTarget, checkPolicyPatch, codeFromText, executionThresholds, gateReasonCode, netRrCheck, policyFit, policyFitAdvice, stopGeometry,
} from '../../src/demo/execution-policy.js';
import { evaluateGates, DEFAULT_GATES, type GateContext } from '../../src/demo/gates.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';
import { eventReason, parseSince, summarizeAiScan, summarizeRun, type AiScanEpisodeRow } from '../../src/demo/trading-sources.js';
import { splitWorkflowPatch } from '../../src/demo/confirm.js';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { createServer } from '../../src/demo/http.js';
import type { Judgment, MarketView } from '../../src/demo/types.js';
import type { StrategyRun, StrategyRunEvent } from '../../src/demo/strategy-run.js';

const th = DEFAULT_EXECUTION_THRESHOLDS;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe('阈值与判定', () => {
  it('workflow 缺字段或存了坏值时回默认,上下限颠倒时不信任上限', () => {
    expect(executionThresholds(undefined)).toEqual(th);
    expect(executionThresholds({ min_stop_pct: 0.5, max_stop_pct: 8, min_stop_atr: 0, min_net_rr: 2 })).toMatchObject({ min_stop_pct: 0.5, max_stop_pct: 8, min_stop_atr: 0, min_net_rr: 2 });
    expect(executionThresholds({ min_stop_pct: 0.1 as number }).min_stop_pct).toBe(1);
    expect(executionThresholds({ stop_floor_mode: 'x' as never, stop_floor_atr_tf: '2h' as never })).toMatchObject({ stop_floor_mode: 'pct', stop_floor_atr_tf: '1h' });
    expect(executionThresholds({ min_stop_pct: 1.8, max_stop_pct: 1.5 }).max_stop_pct).toBeGreaterThan(1.8);
  });

  it('老快照(百分比和 ATR 两个都 >0、没有模式字段)照旧两条都判,取更严的那个', () => {
    // 09-27 之前冻结的回测快照:0.3% + 0.5×ATR。SOL 15m:价格 150,ATR 0.6(0.4%)
    const legacy = { min_stop_pct: 0.3, max_stop_pct: 5, min_stop_atr: 0.5, min_net_rr: 1.5, round_trip_cost_bps: '12' };
    expect(stopGeometry(150, 150 - 0.225, 0.6, legacy).blocks).toEqual(['stop_distance', 'stop_atr']);
    expect(stopGeometry(150, 150 - 0.9, 0.6, legacy).blocks).toEqual([]);
    const g = stopGeometry(150, 148.8, 3, legacy);
    expect(g.blocks).toEqual(['stop_atr']);
    expect(g.effective_min_pct).toBeCloseTo(1, 6);
    expect(stopGeometry(150, 148.8, null, legacy).blocks).toEqual([]);
    expect(stopGeometry(100, 90, 1, th).blocks).toEqual(['stop_too_wide']);
  });

  it('净盈亏比扣往返成本;没有止盈不适用;分档止盈按仓位加权', () => {
    expect(netRrCheck('long', 100, 98, 104, th)).toMatchObject({ applicable: true, ok: true });
    expect(netRrCheck('long', 100, 98, 103, th).ok).toBe(false); // 毛 1.5R,扣成本不到 1.5
    expect(netRrCheck('long', 100, 98, null, th)).toEqual({ applicable: false, net_rr: null, ok: true });
    expect(netRrCheck('short', 100, 102, 101, th).ok).toBe(false);
    expect(blendedTarget([{ price: 102, size: 0.3 }, { price: 106, size: 0.7 }])).toBeCloseTo(104.8, 9);
    expect(blendedTarget([{ price: 102, size: null }, { price: 106, size: null }])).toBe(102);
    expect(blendedTarget([])).toBeNull();
  });

  it('一批样本的拒绝比例和建议:只建议改策略,不建议调低执行层下限', () => {
    // ATR 0.6 = 0.4%;止损 0.6% / 1.2% / 1.5%,默认 1% 底线挡掉第一条
    const samples = [
      { side: 'long' as const, ref: 150, stop: 149.1, target: 153, atr: 0.6 },
      { side: 'long' as const, ref: 150, stop: 148.2, target: 156, atr: 0.6 },
      { side: 'long' as const, ref: 150, stop: 147.75, target: 156, atr: 0.6 },
    ];
    const fit = policyFit(samples, th);
    expect(fit).toMatchObject({ checked: 3, rejected: 1 });
    expect(fit.rejected_by_execution).toMatchObject({ stop_distance: 1, stop_atr: 0 });
    expect(fit.median_atr_pct).toBeCloseTo(0.4, 6);
    const advice = policyFitAdvice(fit, th);
    expect(advice).toContain('把策略止损倍数放宽到 ≥2.5×ATR');
    expect(advice).not.toMatch(/调低|下调/);
    // ATR 模式 1×ATR:0.6% 那条是 1.5×ATR,放行;0.3% 那条只有 0.75×ATR,按 stop_atr 挡
    const atrTh = { ...th, stop_floor_mode: 'atr' as const };
    const fit2 = policyFit([...samples, { side: 'long', ref: 150, stop: 149.55, target: 153, atr: 0.6 }], atrTh);
    expect(fit2).toMatchObject({ checked: 4, rejected: 1 });
    expect(fit2.rejected_by_execution).toMatchObject({ stop_distance: 0, stop_atr: 1 });
    expect(policyFitAdvice(fit2, atrTh)).toContain('≥1×ATR');
  });
});

describe('参数校验', () => {
  it('越界、非整数、未知键报错;agent 直改区间单独标出', () => {
    const w = { ...DEFAULT_WORKFLOW };
    const bad = checkPolicyPatch({ min_stop_pct: 0.1, leverage: 2.5, foo: 1, margin_mode: 'x' }, w);
    expect(bad.errors.map((e) => e.code).sort()).toEqual(['invalid_type', 'not_integer', 'out_of_bounds', 'unknown_key']);
    const ok = checkPolicyPatch({ min_stop_pct: 0.25, max_stop_pct: 12, risk_pct: 0.75, sizing_agent: 'advise', stop_floor_mode: 'atr', stop_floor_atr_tf: '4h' }, w);
    expect(ok.errors).toEqual([]);
    expect(ok.patch).toEqual({ min_stop_pct: 0.25, max_stop_pct: 12, risk_pct: '0.75', sizing_agent: 'advise', stop_floor_mode: 'atr', stop_floor_atr_tf: '4h' });
    expect(ok.outside_agent_direct.sort()).toEqual(['max_stop_pct', 'min_stop_pct']);
    expect(checkPolicyPatch({ min_stop_pct: 1.5, max_stop_pct: 1 }, w).errors[0]?.code).toBe('invalid_range');
  });

  it('对话里 set_workflow 仍然拒掉风险类键;AI 扫盘暂停直接生效、恢复要人确认', () => {
    expect(splitWorkflowPatch({ risk_pct: 1, min_stop_pct: 0.5 }).refused).toEqual(['risk_pct', 'min_stop_pct']);
    expect(splitWorkflowPatch({ ai_scan_paused: true }).direct).toEqual({ ai_scan_paused: true });
    expect(splitWorkflowPatch({ ai_scan_paused: false }).proposal).toEqual({ ai_scan_paused: false });
  });
});

describe('原因归类', () => {
  it('闸自带 code 优先,旧闸按名字和文本归类', () => {
    expect(gateReasonCode({ name: '止损距离', passed: false, reason: '0.15%(允许 0.3%–5%)' })).toBe('stop_distance');
    expect(gateReasonCode({ name: '止损距离', passed: false, reason: '7.00%(允许 0.3%–5%)' })).toBe('stop_too_wide');
    expect(gateReasonCode({ name: '线程/日内限制', passed: false, reason: '同时线程数已到上限 3' })).toBe('max_open_threads');
    expect(gateReasonCode({ name: '随便', passed: false, reason: 'x', code: 'min_net_rr' })).toBe('min_net_rr');
    expect(codeFromText('基础闸拒绝:止损距离:0.15%(允许 0.3%–5%)')).toEqual({ layer: 'gate', code: 'stop_distance' });
    expect(codeFromText('max_open:已达本运行同时持仓上限')).toEqual({ layer: 'strategy', code: 'max_open' });
    // 发送前止损复查的三种文字
    expect(codeFromText('发送前止损复查:止损ATR下限 0.75×ATR(下限 1×1h ATR ≈ 0.40%;距离 0.30%,上限 5%);原计划不改价')).toEqual({ layer: 'gate', code: 'stop_atr' });
    expect(codeFromText('发送前止损复查:止损距离 ATR 不可用,改按百分比:0.60%(允许 1%–5%);原计划不改价')).toEqual({ layer: 'gate', code: 'stop_distance' });
    expect(codeFromText('发送前止损复查:止损过宽 7.00%(允许 1%–5%);原计划不改价')).toEqual({ layer: 'gate', code: 'stop_too_wide' });
  });

  it('老配置(测试注入百分比 + ATR 两个下限)接上 ATR 时多一行「止损ATR下限」,不接时行数不变', () => {
    const j: Judgment = { action: 'PROPOSE', direction: 'long', confidence: 0.6, headline: 'h', thesis: 't', reasons: [], evidence_refs: [], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [],
      proposal: { market: 'perp', direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '148.8', take_profit_price: null, take_profits: [], rationale: 'r' } };
    const market = { symbol: 'SOLUSDT', mark: '150', as_of: 0 } as MarketView;
    const ctx: GateContext = { halted: false, paused: false, account: { equity: '10000', available: '10000', positions: [] } as never, market, opens_today: 0, stale_refs: new Set() };
    const cfg = { ...DEFAULT_GATES, min_stop_atr: 0.5 };
    expect(evaluateGates(j, ctx, cfg).some((g) => g.name === '止损ATR下限')).toBe(false);
    const withAtr = evaluateGates(j, { ...ctx, atr: 3 }, cfg).find((g) => g.name === '止损ATR下限')!;
    expect(withAtr).toMatchObject({ passed: false, code: 'stop_atr' });
    expect(evaluateGates(j, { ...ctx, atr: 1.5 }, cfg).find((g) => g.name === '止损ATR下限')!.passed).toBe(true);
    expect(evaluateGates(j, { ...ctx, atr: null }, cfg).find((g) => g.name === '止损ATR下限')!).toMatchObject({ passed: true });
  });
});

describe('来源漏斗汇总', () => {
  const ep = (patch: Partial<AiScanEpisodeRow>): AiScanEpisodeRow => ({ id: 'e', at: 1, symbol: 'SOLUSDT', model: 'pi', status: 'done', error: null, action: 'NO_TRADE', headline: '震荡', gates: [], intent_status: null, intent_error: null, ...patch });
  it('AI 扫盘:模型不做和被闸拦下分开放,被挡原因带层和原样闸结果', () => {
    const s = summarizeAiScan([
      ep({ action: 'NO_TRADE' }), ep({ action: 'WATCH' }),
      ep({ action: 'PROPOSE', gates: [{ name: '止损距离', passed: false, reason: '0.15%(允许 0.3%–5%)', code: 'stop_distance' }, { name: '止损ATR下限', passed: false, reason: 'x', code: 'stop_atr' }] }),
      ep({ action: 'PROPOSE', intent_status: 'filled' }), ep({ model: 'code:skipped_model', action: 'NO_TRADE' }),
    ], 'code:skipped_model');
    expect(s.today).toMatchObject({ judgments: 4, proposals: 2, gate_rejected: 1, orders: 1 });
    expect(s.today.actions).toEqual({ NO_TRADE: 2, WATCH: 1, PROPOSE: 2 });
    expect(s.top_reasons.map((r) => [r.layer, r.key])).toEqual([['gate', 'stop_atr'], ['gate', 'stop_distance']]);
    expect(s.not_taken.map((r) => r.key)).toEqual(['no_trade', 'watch']);
  });

  it('AI 扫盘:failed 的提议按真实原因归类,风控检查没过算闸,行情限流算临时失败,认不出的才算模型失败', () => {
    const s = summarizeAiScan([
      ep({ status: 'failed', action: 'PROPOSE', error: '持仓计划: 主周期ATR/入场价格缺失，无法建立持仓契约' }),
      ep({ status: 'failed', action: 'PROPOSE', error: '净盈亏比: 净RR=1.08，需≥1.5；往返成本预算12bps' }),
      ep({ status: 'failed', action: null, error: '/api/v5/market/candles?instId=SUI-USDT-SWAP&bar=4H&limit=80 -> HTTP 429' }),
      ep({ status: 'failed', action: null, error: 'brain timeout' }),
    ], 'code:skipped_model');
    expect(s.today.failed).toBe(4);
    expect(s.top_reasons.map((r) => [r.layer, r.key]).sort()).toEqual([['execution', 'model_failed'], ['gate', 'holding_plan'], ['gate', 'min_net_rr']]);
    expect(s.not_taken.map((r) => r.key)).toEqual(['transient']);
  });

  it('原因码匹配顺序:具体检查名优先于「持仓计划」,AI 扫盘暂停优先于通用暂停', () => {
    expect(codeFromText('发送前持仓计划重闸: 策略ATR尺度;原计划不改价')).toEqual({ layer: 'gate', code: 'holding_atr' });
    expect(codeFromText('发送前持仓计划重闸: 结构失效价;原计划不改价')).toEqual({ layer: 'gate', code: 'invalidation' });
    expect(codeFromText('持仓计划: 主周期ATR/入场价格缺失，无法建立持仓契约')).toEqual({ layer: 'gate', code: 'holding_plan' });
    expect(codeFromText('AI 扫盘已暂停')?.code).toBe('ai_scan_paused');
  });

  it('策略运行:结构化字段优先;IR 判断要素跳过同一个候选只算一次;暂停和行情没到不算被挡', () => {
    const ev = (kind: StrategyRunEvent['kind'], message: string, data: Record<string, unknown> | null = null): StrategyRunEvent => ({ id: Math.random().toString(), run_id: 'r', at: 1, kind, symbol: 'SOLUSDT', message, data });
    const run = { id: 'r', strategy_id: 's', strategy_name: 'SOL 突破', version: 2, symbols: ['SOLUSDT'], timeframe: '15m', mode: 'jev', status: 'running', market: 'perp', risk_pct: 0.5, max_open: 3, execution: { backend: 'paper', profile: null, label: '纸面' } } as unknown as StrategyRun;
    const out = summarizeRun(run, [
      ev('scan', '扫描'), ev('candidate', 'c'), ev('candidate', 'c'), ev('candidate', 'c'), ev('candidate', 'c'),
      ev('order_rejected', '基础闸拒绝:止损距离:0.15%(允许 0.3%–5%)', { layer: 'gate', code: 'stop_distance', gates: [] }),
      ev('order_rejected', '基础闸拒绝:止损距离:0.18%(允许 0.3%–5%)'),
      ev('agent_skip', 'take', { layer: 'judge', code: 'ir_judge_skip' }), ev('skip', 'ir_judge_skip', { layer: 'judge', code: 'ir_judge_skip' }),
      ev('agent_skip', 'Jev 跳过', { layer: 'judge', code: 'jev_skip' }),
      ev('skip', '工作流已暂停'), ev('skip', '行情尚未返回最新收盘 K 线,稍后重试'),
    ], 0);
    expect(out.today).toMatchObject({ scans: 1, candidates: 4, gate_rejected: 2, judged: { follow: 0, skip: 2 }, skipped: 2 });
    expect(out.judge).toBe('jev');
    expect(out.top_reasons.find((r) => r.key === 'stop_distance')).toMatchObject({ layer: 'gate', count: 2 });
    expect(out.top_reasons.find((r) => r.key === 'ir_judge_skip')?.count).toBe(1);
    expect(out.not_taken.map((r) => r.key).sort()).toEqual(['bars_pending', 'paused']);
    expect(eventReason(ev('error', '奇怪的错误 123'))).toMatchObject({ layer: 'execution', key: 'text:奇怪的错误 #' });
  });

  it('since 缺省今天 UTC 零点,非法值返回 null', () => {
    const now = Date.UTC(2026, 8, 27, 10);
    expect(parseSince(null, now)).toBe(Date.UTC(2026, 8, 27));
    expect(parseSince(String(now - 3_600_000), now)).toBe(now - 3_600_000);
    for (const bad of ['abc', String(now + 1), String(now - 40 * 86_400_000)]) expect(parseSince(bad, now)).toBeNull();
  });
});

describe('HTTP 与 agent 工具', () => {
  async function http() {
    // GET 会顺手补 stop_conversions 要的 K 线:测试里用桩,不碰网络
    const market = await import('../../src/demo/market.js');
    vi.spyOn(market, 'fetchKlines').mockImplementation(async (_s, tf) => {
      const ms = market.tfToMs(tf), end = Math.floor(Date.now() / ms) * ms;
      return Array.from({ length: 60 }, (_, i) => ({ open_time: end - (60 - i) * ms, close_time: end - (59 - i) * ms - 1, open: '100', high: '100.5', low: '99.5', close: '100', volume: '1' }));
    });
    const state = openStateDb(':memory:'); cleanups.push(() => state.close());
    const store = new DemoStore(state);
    const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain() } });
    const server = createServer(rt, store);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json() as any };
    };
    return { rt, store, request };
  }

  it('GET/PATCH /api/execution-policy:按边界校验,越界整单 400 不部分生效', async () => {
    const { request, rt } = await http();
    const g = await request('GET', '/api/execution-policy');
    expect(g.status).toBe(200);
    expect(g.body.values).toMatchObject({ stop_floor_mode: 'pct', stop_floor_atr_tf: '1h', min_stop_pct: 1, max_stop_pct: 5, min_stop_atr: 1, min_net_rr: 1.5, risk_pct: 0.5, sizing_agent: 'apply' });
    expect(g.body.bounds.min_stop_pct).toMatchObject({ min: 0.2, max: 5, agent_direct_min: 0.5, agent_direct_max: 3 });
    expect(g.body.bounds.stop_floor_mode).toMatchObject({ values: ['pct', 'atr'] });
    expect(g.body.bounds.stop_floor_atr_tf).toMatchObject({ values: ['15m', '1h', '4h'] });
    expect(g.body).toMatchObject({ backend: 'paper', live: false, usage: { open_threads: 0, opens_today: 0, daily_loss_hit: false } });
    const bad = await request('PATCH', '/api/execution-policy', { min_stop_pct: 0.5, max_stop_pct: 30 });
    expect(bad.status).toBe(400); expect(bad.body.error.code).toBe('invalid_policy');
    expect(rt.workflow.min_stop_pct).toBe(1);
    const ok = await request('PATCH', '/api/execution-policy', { min_stop_pct: 0.5, min_stop_atr: 0.8, max_open_threads: 12, stop_floor_mode: 'atr', stop_floor_atr_tf: '4h', confirm: 'LIVE' });
    expect(ok.status).toBe(200);
    expect(ok.body.policy.values).toMatchObject({ min_stop_pct: 0.5, min_stop_atr: 0.8, max_open_threads: 12, stop_floor_mode: 'atr', stop_floor_atr_tf: '4h' });
    const badEnum = await request('PATCH', '/api/execution-policy', { stop_floor_atr_tf: '2h' });
    expect(badEnum.status).toBe(400);
  });

  it('实盘通道由人改要带 confirm:LIVE', async () => {
    const { request, rt } = await http();
    vi.spyOn(rt, 'executionIsLive').mockReturnValue(true);
    const r = await request('PATCH', '/api/execution-policy', { min_net_rr: 2 });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('live_requires_confirm');
    expect((await request('PATCH', '/api/execution-policy', { min_net_rr: 2, confirm: 'LIVE' })).status).toBe(200);
    expect(rt.workflow.min_net_rr).toBe(2);
  });

  it('agent 工具:模拟盘区间内直接生效;超区间或实盘只生成设置提议', async () => {
    const { rt } = await http();
    const tools = rt.chatTools('s1') as unknown as { set_execution_policy: (a: unknown) => any; get_execution_policy: () => any };
    const view = tools.get_execution_policy();
    expect(view.values.min_net_rr).toBe(1.5);
    expect(Array.isArray(view.stop_conversions)).toBe(true);
    const direct = tools.set_execution_policy({ patch: { min_net_rr: 2, min_stop_pct: 1.2, stop_floor_mode: 'atr', stop_floor_atr_tf: '4h', min_stop_atr: 1.5 } });
    expect(direct).toMatchObject({ applied: true, mode: 'direct' });
    expect(rt.workflow).toMatchObject({ min_net_rr: 2, min_stop_pct: 1.2, stop_floor_mode: 'atr', stop_floor_atr_tf: '4h', min_stop_atr: 1.5 });
    // agent 直改区间 0.5–3:0.4 要人确认
    const outside = tools.set_execution_policy({ patch: { min_stop_pct: 0.4 } });
    expect(outside).toMatchObject({ applied: false, mode: 'proposal', reason: 'outside_agent_direct', outside_agent_direct: ['min_stop_pct'] });
    expect(rt.workflow.min_stop_pct).toBe(1.2);
    expect(rt.workflowProposals()[0]).toMatchObject({ status: 'pending', patch: { min_stop_pct: 0.4 } });
    vi.spyOn(rt, 'executionIsLive').mockReturnValue(true);
    expect(tools.set_execution_policy({ min_net_rr: 1.8 })).toMatchObject({ mode: 'proposal', reason: 'live_requires_human' });
    expect(tools.set_execution_policy({ patch: { min_net_rr: 9 } })).toMatchObject({ ok: false, mode: 'rejected' });
  });

  it('来源漏斗与 AI 扫盘单独暂停:只停扫盘,不动全局暂停', async () => {
    const { request, rt } = await http();
    const s = await request('GET', '/api/trading/sources');
    expect(s.status).toBe(200);
    expect(s.body.shared).toMatchObject({ open_threads: 0, max_open_threads: 3, opens_today: 0, max_opens_per_day: 4, daily_loss_hit: false, halted: false, paused: false });
    expect(s.body.sources[0]).toMatchObject({ kind: 'ai_scan', enabled: true, paused: false, judge: 'model', top_reasons: [], not_taken: [] });
    expect(s.body.sources[0].playbook.name).toContain('突破-回踩');
    expect((await request('GET', '/api/trading/sources?since=abc')).status).toBe(400);
    const p = await request('PATCH', '/api/trading/sources/ai_scan', { paused: true });
    expect(p.status).toBe(200); expect(p.body.source).toMatchObject({ paused: true, enabled: false, disabled_reason: 'AI 扫盘已暂停' });
    expect(rt.workflow.paused).toBe(false);
    expect(rt.scan('BTCUSDT', { kind: 'manual', detail: '测试' })).toBe(false);
    expect((await request('PATCH', '/api/trading/sources/ai_scan', { paused: 'yes' })).status).toBe(400);
  });
});
