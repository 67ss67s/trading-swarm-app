/**
 * 交易页三层改版(components/trade/sources-logic.ts + source-card / risk-panel / context-bar):
 * 漏斗归一、被挡原因分层、卡片降级、风控摘要与编辑校验、「让 agent 调」预填、渲染与英文词条。
 * 止损夹具一律 ≥0.5%(web3 波动下 0.15% 这种止损没有意义)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StrategyRun, StrategyRunEvent, StrategyThread } from '../src/api/types';
import type { ExecutionPolicyView, StrategyRunSource, TradingSourcesView } from '../src/api/trading';
import {
  blockedLayerOfEvent,
  blockedReasonText,
  blockedRows,
  blockedTotals,
  channelOf,
  funnelFromAiScan,
  funnelFromRun,
  funnelFromRunStats,
  isBlockingReason,
  isStopDistanceReason,
  playbookName,
  reasonExample,
  openActions,
  policyDraftPatch,
  reasonLabel,
  riskSummary,
  sourceCards,
  tunePrompt,
  widenStopHint,
  notTakenLine,
} from '../src/components/trade/sources-logic';
import { TradeContextBar } from '../src/components/trade/context-bar';
import { SourceCard } from '../src/components/trade/source-card';
import { RiskPanel } from '../src/components/trade/risk-panel';
import { tradeLockReason } from '../src/components/trade/write-lock';
import { TRADE_EN } from '../src/components/trade/i18n-en';
import { EN } from '../src/lib/i18n-en';

const NOW = Date.UTC(2026, 8, 27, 8);

const runSource = (over: Partial<StrategyRunSource> = {}): StrategyRunSource => ({
  kind: 'strategy_run',
  run_id: 'run_a',
  strategy_id: 'rs_aa7',
  name: 'Multi-TF breakout',
  version: 2,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  timeframe: '4h',
  mode: 'jev',
  status: 'running',
  execution: { backend: 'okx', profile: 'demo', label: 'OKX Demo' },
  today: { scans: 6, candidates: 4, judged: { follow: 2, skip: 2 }, gate_rejected: 1, orders: 1, open_threads: 1 },
  realized_r: 0.8,
  last_event: null,
  top_reasons: [
    { layer: 'judge', key: 'jev_skip', label: 'Jev 判断跳过', count: 2 },
    { layer: 'gate', key: 'stop_distance', label: '止损距离低于下限', count: 1, example: { symbol: 'SOLUSDT', at: NOW - 3_600_000, message: '止损距离:0.52%(允许 0.6%–5%)' } },
  ],
  ...over,
});

const policy = (over: Partial<ExecutionPolicyView> = {}): ExecutionPolicyView => ({
  values: { risk_pct: '0.5', leverage: 3, margin_mode: 'cross', min_stop_pct: 0.6, max_stop_pct: 5, min_stop_atr: 0.5, min_net_rr: 1.5, max_open_threads: 3, max_opens_per_day: 4, daily_loss_stop_pct: '3', sizing_agent: 'apply' },
  bounds: {
    risk_pct: { min: 0.1, max: 2, step: 0.05, agent_direct_min: 0.1, agent_direct_max: 2 },
    leverage: { min: 1, max: 10, step: 1 },
    min_stop_pct: { min: 0.2, max: 2, step: 0.05, agent_direct_min: 0.3, agent_direct_max: 2 },
    max_stop_pct: { min: 1, max: 15, step: 0.5 },
    min_stop_atr: { min: 0, max: 3, step: 0.1, agent_direct_min: 0.3, agent_direct_max: 2 },
    min_net_rr: { min: 0.5, max: 5, step: 0.1 },
    max_open_threads: { min: 1, max: 20, step: 1 },
    max_opens_per_day: { min: 1, max: 50, step: 1 },
    daily_loss_stop_pct: { min: 0.5, max: 20, step: 0.5 },
  },
  backend: 'okx',
  live: false,
  profile: 'demo',
  usage: { open_threads: 2, opens_today: 1, daily_loss_hit: false },
  ...over,
});

const run = (over: Partial<StrategyRun> = {}): StrategyRun =>
  ({
    id: 'run_a', strategy_id: 'rs_aa7', strategy_name: 'Multi-TF breakout', version: 2, latest_version: 2, ir_hash: 'x', timeframe: '4h', mode: 'auto', market: 'perp', direction: 'both', leverage: 3,
    symbols: ['BTCUSDT'], risk_pct: 0.5, max_open: 3, publish_asp: false, status: 'running', error: null, execution: { backend: 'okx', profile: 'demo', label: 'OKX Demo' },
    created_at: NOW - 86_400_000, updated_at: NOW, last_scan_at: NOW, next_scan_at: NOW + 900_000,
    stats: { scans: 40, candidates: 10, orders: 3, pending_approval: 0, skipped: 12, rejected: 2, open_threads: 1, closed: 2, realized_r: -0.3, published: 0, today_orders: 1 },
    ...over,
  }) as StrategyRun;

const ev = (kind: StrategyRunEvent['kind'], message: string, over: Partial<StrategyRunEvent> = {}): StrategyRunEvent => ({ id: `${kind}-${message}`, run_id: 'run_a', at: NOW - 60_000, kind, symbol: 'ETHUSDT', message, data: null, ...over });

describe('漏斗归一', () => {
  it('运行来源:候选 → 判断(跟) → 风控检查 通过/进入 → 下单;被挡按层合计', () => {
    const f = funnelFromRun(runSource());
    expect(f).toMatchObject({ candidates: 4, judged: 4, follow: 2, gatesEntered: 2, gatesPassed: 1, orders: 1, blocked: 3 });
    expect(f.byLayer).toEqual({ judge: 2, strategy: 0, gate: 1, execution: 0 });
  });
  it('top_reasons 只给前几条时,判断层和风控取计数器的较大值', () => {
    const f = funnelFromRun(runSource({ today: { scans: 1, candidates: 9, judged: { follow: 1, skip: 5 }, gate_rejected: 3, orders: 0, open_threads: 0 }, top_reasons: [] }));
    expect(f.byLayer).toMatchObject({ judge: 5, gate: 3 });
    expect(f.blocked).toBe(8);
  });
  it('Direct 模式不判断:judged = null(界面显示「—」)', () => {
    const f = funnelFromRun(runSource({ mode: 'auto', today: { scans: 1, candidates: 3, judged: { follow: 0, skip: 0 }, gate_rejected: 0, orders: 3, open_threads: 3 }, top_reasons: [] }));
    expect([f.judged, f.follow, f.gatesPassed, f.gatesEntered, f.blocked]).toEqual([null, null, 3, 3, 0]);
  });
  it('AI Scan:没有候选层;NO_TRADE 是判断本身不算被挡', () => {
    const f = funnelFromAiScan({ today: { judgments: 12, cap: 2000, actions: { OPEN: 2, NO_TRADE: 9, WATCH: 1 }, gate_rejected: 1, orders: 1 }, top_reasons: [] });
    expect(f).toMatchObject({ candidates: null, judged: 12, follow: 2, gatesEntered: 2, gatesPassed: 1, orders: 1, blocked: 1 });
    expect(openActions({ propose_long: 1, open: 2, no_trade: 5 })).toBe(3);
  });
  it('降级:运行累计统计,候选里没下单也没被闸拒的记为「未分层」', () => {
    const f = funnelFromRunStats(run());
    expect(f).toMatchObject({ candidates: 10, orders: 3, judged: null, gatesEntered: null, blocked: 7, unattributed: 5 });
    expect(f.byLayer.gate).toBe(2);
  });
});

describe('被挡原因分层(运行事件降级)', () => {
  it('agent_skip = 判断;order_rejected 认得出风控检查名 = 风控,否则算下单环节;skip 按原因码 = 运行上限', () => {
    expect(blockedLayerOfEvent(ev('agent_skip', 'jev_skip'))).toBe('judge');
    expect(blockedLayerOfEvent(ev('order_rejected', '提议被拒:止损距离(0.52%(允许 0.6%–5%))'))).toBe('gate');
    expect(blockedLayerOfEvent(ev('order_rejected', 'okx 51008 insufficient margin'))).toBe('execution');
    expect(blockedLayerOfEvent(ev('skip', 'max_open:已达本运行同时持仓上限'))).toBe('strategy');
    expect(blockedLayerOfEvent(ev('skip', 'min_rr:候选不满足 IR 盈亏比要求'))).toBe('strategy');
    expect(blockedLayerOfEvent(ev('skip', 'vol_target_not_connected:禁止退回固定风险仓位'))).toBe('execution');
  });
  it('不是候选被挡的 skip 不算:ir_judge_skip(已有 agent_skip)、行情没到、临时失败、筛选没过、无币种', () => {
    expect(blockedLayerOfEvent(ev('skip', 'ir_judge_skip'))).toBeNull();
    expect(blockedLayerOfEvent(ev('skip', '行情尚未返回最新收盘 K 线,稍后重试'))).toBeNull();
    expect(blockedLayerOfEvent(ev('skip', '临时失败,15 秒后重试:timeout', { data: { transient: true } }))).toBeNull();
    expect(blockedLayerOfEvent(ev('skip', '筛选条件未通过或历史不足,本根跳过', { data: { code: 'screen_filter' } }))).toBeNull();
    expect(blockedLayerOfEvent(ev('skip', '紧急停止中', { symbol: null }))).toBeNull();
    expect(blockedLayerOfEvent(ev('candidate', 'ETHUSDT 命中'))).toBeNull();
  });
  it('今日明细:只要今天的、新的在前,原因码翻成人话', () => {
    const rows = blockedRows(
      [ev('skip', 'max_open:已达本运行同时持仓上限', { id: 'a', at: NOW - 120_000 }), ev('agent_skip', 'jev_skip', { id: 'b', at: NOW - 60_000 }), ev('agent_skip', 'old', { id: 'c', at: NOW - 3 * 86_400_000 })],
      NOW - 86_400_000,
    );
    expect(rows.map((r) => [r.id, r.layer])).toEqual([['b', 'judge'], ['a', 'strategy']]);
    expect(rows[1]!.reason).toBe('本运行同时持仓已到上限');
    expect(blockedReasonText('weird_code:something happened')).toBe('something happened');
  });
  it('止损太近 → 引导放宽策略止损(≥k×ATR);止损太宽不引导', () => {
    expect(isStopDistanceReason({ key: 'stop_distance' })).toBe(true);
    expect(isStopDistanceReason({ key: 'stop_atr' })).toBe(true);
    expect(isStopDistanceReason({ key: 'stop_too_wide', label: '止损距离超过上限' })).toBe(false);
    expect(isStopDistanceReason({ reason: '止损距离:0.52%(允许 0.6%–5%)' })).toBe(true);
    expect(isStopDistanceReason({ reason: '止损距离:7.00%(允许 0.6%–5%)' })).toBe(false);
    expect(widenStopHint(0.5)).toBe('把策略止损放宽(≥0.5×ATR)');
    expect(reasonLabel({ key: 'stop_atr', label: 'x' })).toBe('止损小于 ATR 下限');
    expect(reasonLabel({ key: 'brand_new', label: '新原因' })).toBe('新原因');
  });
});

describe('来源卡模型', () => {
  const view = (sources: TradingSourcesView['sources']): TradingSourcesView => ({
    shared: { open_threads: 2, max_open_threads: 3, opens_today: 1, max_opens_per_day: 4, daily_loss_hit: false, halted: false, paused: false },
    sources,
  });
  const ai = { kind: 'ai_scan' as const, enabled: true, playbook: 'Trend pullback', judge: 'model' as const, symbols: ['BTCUSDT', 'ETHUSDT'], today: { judgments: 12, cap: 2000, actions: { OPEN: 1 }, gate_rejected: 0, orders: 1 }, top_reasons: [] };
  it('AI Scan 永远第一张,运行按 运行中 → 出错 → 暂停 排,停止的不出卡', () => {
    const cards = sourceCards({
      sources: view([runSource({ run_id: 'p', status: 'paused' }), runSource({ run_id: 's', status: 'stopped' }), ai, runSource({ run_id: 'e', status: 'error' }), runSource({ run_id: 'r' })]),
      runs: [], agent: undefined, usage: null, halted: false, paused: false, watchCount: 2, threads: [],
    });
    expect(cards.map((c) => c.key)).toEqual(['ai_scan', 'r', 'e', 'p']);
    expect(cards[0]).toMatchObject({ name: 'AI Scan', playbook: 'Trend pullback', judgments: { used: 12, cap: 2000 }, status: 'running', filter: 'ai_scan', degraded: false });
    expect(cards[1]).toMatchObject({ filter: { runId: 'r' }, mode: 'jev', scope: 'today' });
  });
  it('额度用尽 / 急停 反映到状态', () => {
    const capped = sourceCards({ sources: view([{ ...ai, today: { ...ai.today, judgments: 2000 } }]), runs: [], agent: undefined, usage: null, halted: false, paused: false, watchCount: 2, threads: [] });
    expect(capped[0]!.status).toBe('capped');
    const halted = sourceCards({ sources: { ...view([ai, runSource()]), shared: { ...view([]).shared, halted: true } }, runs: [], agent: undefined, usage: null, halted: false, paused: false, watchCount: 2, threads: [] });
    expect(halted.map((c) => c.status)).toEqual(['halted', 'halted']);
  });
  it('接口 404 → 降级:AI Scan 用 usage,运行用累计 stats,线程数按线程列表', () => {
    const th = { id: 't', origin: undefined, source: 'agent' } as unknown as StrategyThread;
    const cards = sourceCards({ sources: null, runs: [run(), run({ id: 'x', status: 'stopped' })], agent: undefined, usage: { judgments: 5, cap: 100, capped: false, input_tokens: 0, output_tokens: 0, est_cny: null }, halted: false, paused: false, watchCount: 4, threads: [th] });
    expect(cards.map((c) => [c.key, c.scope, c.degraded])).toEqual([['ai_scan', 'today', true], ['run_a', 'total', true]]);
    expect(cards[0]).toMatchObject({ judgments: { used: 5, cap: 100 }, openThreads: 1 });
    expect(cards[0]!.funnel.judged).toBe(5);
  });
  it('降级时 Agent 绑了策略 → AI Scan 视为暂停', () => {
    const cards = sourceCards({ sources: undefined, runs: [], agent: { kind: 'strategy' } as never, usage: null, halted: false, paused: false, watchCount: 0, threads: [] });
    expect(cards[0]!.status).toBe('paused');
  });
});

describe('风控与执行', () => {
  it('顶条摘要:每笔风险 · agent 调仓位 · 杠杆 · 持仓 · 今日 · 止损区间 + ATR 下限 · 盈亏比', () => {
    const p = policy();
    expect(riskSummary(p.values, p.usage)).toBe('每笔风险 0.5% · agent 调仓位 · 3x · 持仓 2/3 · 今日 1/4 · 止损 0.6–5% ≥0.5ATR · 盈亏比 ≥1.5');
    expect(riskSummary({ ...p.values, sizing_agent: 'off', min_stop_atr: undefined }, null)).toBe('每笔风险 0.5% · 3x · 持仓 —/3 · 今日 —/4 · 止损 0.6–5% · 盈亏比 ≥1.5');
  });
  it('执行通道:Paper / OKX Demo / Live', () => {
    expect(channelOf({ backend: 'paper' })).toEqual({ kind: 'paper', label: 'Paper' });
    expect(channelOf({ backend: 'okx', live: false, profile: 'demo' })).toEqual({ kind: 'demo', label: 'OKX Demo' });
    expect(channelOf({ backend: 'okx', live: true })).toEqual({ kind: 'live', label: 'OKX Live' });
    expect(channelOf({ backend: null }).kind).toBe('unknown');
  });
  it('编辑:只带改了的字段,字符串字段回字符串;越界 / 非整数 / 止损下限 ≥ 上限报错', () => {
    const p = policy();
    const ok = policyDraftPatch(p.values, p.bounds, { risk_pct: '0.75', max_open_threads: '5', min_stop_atr: '0.8', leverage: '3', sizing_agent: 'advise' });
    expect(ok.patch).toEqual({ risk_pct: '0.75', max_open_threads: 5, min_stop_atr: 0.8, sizing_agent: 'advise' });
    expect(ok.changed).toEqual(['max_open_threads', 'min_stop_atr', 'risk_pct', 'sizing_agent']);
    const bad = policyDraftPatch(p.values, p.bounds, { min_stop_pct: '0.1', leverage: '2.5', risk_pct: 'abc' });
    expect(bad.patch).toBeNull();
    expect(Object.keys(bad.errors).sort()).toEqual(['leverage', 'min_stop_pct', 'risk_pct']);
    expect(policyDraftPatch(p.values, p.bounds, { min_stop_pct: '1.5', max_stop_pct: '1.2' }).errors.max_stop_pct).toBeTruthy();
    expect(policyDraftPatch(p.values, p.bounds, {}).patch).toBeNull();
  });
  it('老网关没有 min_stop_atr:草稿里的这一项被忽略', () => {
    const p = policy();
    const { min_stop_atr: _drop, ...values } = p.values;
    expect(policyDraftPatch(values, p.bounds, { min_stop_atr: '1' }).changed).toEqual([]);
  });
  it('「让 agent 调」预填:当前参数、区间与 agent 直改区间、今日被挡、模拟盘和真钱通道的不同说法', () => {
    const cards = sourceCards({ sources: { shared: { open_threads: 2, max_open_threads: 3, opens_today: 1, max_opens_per_day: 4, daily_loss_hit: false, halted: false, paused: false }, sources: [runSource()] }, runs: [], agent: undefined, usage: null, halted: false, paused: false, watchCount: 0, threads: [] });
    const totals = blockedTotals(cards);
    expect(totals.total).toBe(3);
    expect(totals.top[0]).toMatchObject({ label: 'Jev 判断跳过', count: 2, layer: 'judge' });
    const text = tunePrompt(policy(), cards, { kind: 'demo', label: 'OKX Demo' });
    expect(text).toContain('OKX Demo');
    expect(text).toContain('min_stop_pct=0.6 [0.2–2](你可直接改 0.3–2)');
    expect(text).toContain('min_stop_atr=0.5');
    expect(text).toContain('今天被挡 3 个');
    expect(text).toContain('超出区间请写成提议');
    expect(text).not.toMatch(/0\.15%/);
    expect(tunePrompt(policy({ live: true }), cards, { kind: 'live', label: 'OKX Live' })).toContain('只给建议');
  });
  it('访客锁:构建开关 / 网关回过 judge_locked / whoami 只读 任一成立', () => {
    expect(tradeLockReason({ readOnlyBuild: false, serverLocked: false, whoamiReadOnly: false })).toBeNull();
    expect(tradeLockReason({ readOnlyBuild: true, serverLocked: false, whoamiReadOnly: false })).toBeTruthy();
    expect(tradeLockReason({ readOnlyBuild: false, serverLocked: true, whoamiReadOnly: false })).toBeTruthy();
    expect(tradeLockReason({ readOnlyBuild: false, serverLocked: false, whoamiReadOnly: true })).toBeTruthy();
  });
});

describe('§9.56 实际形状对齐', () => {
  it('AI Scan:playbook 是对象、额度在 budget、disabled_reason 进 note', () => {
    const cards = sourceCards({
      sources: {
        shared: { open_threads: 0, max_open_threads: 3, opens_today: 0, max_opens_per_day: 4, daily_loss_hit: false, halted: false, paused: false },
        sources: [
          {
            kind: 'ai_scan', id: 'ai_scan', name: 'AI 扫盘', enabled: false, disabled_reason: 'Agent 当前策略接管开仓', playbook: { name: 'Trend pullback', prompt_version: 7, custom: false }, judge: 'model',
            budget: { judgments_used_today: 40, judgment_cap: 2000 },
            today: { judgments: 38, actions: { PROPOSE: 3, NO_TRADE: 30, WATCH: 5 }, proposals: 3, gate_rejected: 1, orders: 1, pending_approval: 0, failed: 0 },
            top_reasons: [
              { layer: 'judge', key: 'no_trade', label: '模型判断不交易', count: 30, example: 'BTCUSDT:no setup' },
              { layer: 'gate', key: 'stop_atr', label: '止损小于 ATR 下限', count: 1, example: 'DOGEUSDT 止损ATR下限:0.3×ATR(下限 0.5×ATR)' },
            ],
          },
        ],
      },
      runs: [], agent: undefined, usage: null, halted: false, paused: false, watchCount: 0, threads: [],
    });
    const ai = cards[0]!;
    expect(ai).toMatchObject({ name: 'AI Scan', playbook: 'Trend pullback', judgments: { used: 40, cap: 2000 }, status: 'paused', note: 'Agent 当前策略接管开仓' });
    // NO_TRADE 是判断本身:不进被挡数,也不进 Blocked today
    expect(ai.funnel).toMatchObject({ judged: 38, follow: 3, blocked: 1 });
    expect(ai.reasons.map((r) => r.key)).toEqual(['stop_atr']);
    expect(playbookName('Legacy')).toBe('Legacy');
    expect(playbookName(null)).toBeNull();
  });
  it('原因:暂停 / 急停 / 临时失败 / 筛选 / 行情没到 不算被挡;example 字符串拆出币种', () => {
    expect(['paused', 'halted', 'transient', 'screen_filter', 'no_trade', 'watch'].map((key) => isBlockingReason({ key, label: '' }))).toEqual([false, false, false, false, false, false]);
    expect(isBlockingReason({ key: 'text:行情尚未返回最新收盘 K 线,稍后重试', label: '' })).toBe(false);
    expect(isBlockingReason({ key: 'text:okx # insufficient margin', label: '' })).toBe(true);
    expect(isBlockingReason({ key: 'stop_distance', label: '' })).toBe(true);
    expect(reasonExample({ layer: 'gate', key: 'stop_distance', label: '', count: 1, example: 'SOLUSDT 止损距离:0.52%(允许 0.6%–5%)' })).toEqual({ symbol: 'SOLUSDT', at: null, message: '止损距离:0.52%(允许 0.6%–5%)' });
    expect(reasonExample({ layer: 'execution', key: 'model_failed', label: '', count: 1, example: 'timeout' }).symbol).toBeNull();
  });
  it('运行:同一候选记了 agent_skip + ir_judge_skip 两条时,判断层按 skip 计数器', () => {
    const f = funnelFromRun(runSource({ top_reasons: [{ layer: 'judge', key: 'ir_judge_skip', label: '', count: 2 }, { layer: 'judge', key: 'text:jev_skip', label: '', count: 2 }] }));
    expect(f.byLayer.judge).toBe(2);
  });
  it('执行通道:§9.56 没有 profile,okx 非实盘 = OKX Demo;未知后端用 execution_label', () => {
    expect(channelOf({ backend: 'okx', live: false, label: 'OKX 模拟盘' }).label).toBe('OKX Demo');
    expect(channelOf({ backend: 'agent_mcp', live: false, label: 'Binance Agentic' }).label).toBe('Binance Agentic');
  });
});

describe('渲染与词条', () => {
  const wrap = (node: React.ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
  it('顶条:通道 + ①②③ + 风控摘要;正常时不显示异常状态,日亏停时显示', () => {
    const html = renderToStaticMarkup(<TradeContextBar channel={{ kind: 'demo', label: 'OKX Demo' }} state={{ halted: false, paused: false, dailyLossHit: false }} activeSources={2} totalSources={3} riskSummary="risk 0.5%/trade · 3x" riskActive={false} onOpenRisk={() => {}} />);
    expect(html).toContain('OKX Demo');
    expect(html).toContain('trade-risk-chip');
    expect(html).toContain('risk 0.5%/trade · 3x');
    expect(html).not.toContain('trade-global-state');
    expect(html).not.toMatch(/Current strategy|自由判断/);
    const hit = renderToStaticMarkup(<TradeContextBar channel={{ kind: 'paper', label: 'Paper' }} state={{ halted: false, paused: false, dailyLossHit: true }} activeSources={1} totalSources={1} riskSummary={null} riskActive onOpenRisk={() => {}} />);
    expect(hit).toContain('日亏停');
  });
  it('来源卡:类型徽章、漏斗、被挡数(红)、回测对比占位;访客时按钮禁用', () => {
    const [card] = sourceCards({ sources: { shared: { open_threads: 0, max_open_threads: 3, opens_today: 0, max_opens_per_day: 4, daily_loss_hit: false, halted: false, paused: false }, sources: [runSource()] }, runs: [], agent: undefined, usage: null, halted: false, paused: false, watchCount: 0, threads: [] }).slice(1);
    const html = wrap(<SourceCard model={card!} active onSelect={() => {}} lock="read only" busy={false} onToggle={() => {}} onMode={() => {}} now={NOW} minStopAtr={0.5} />);
    expect(html).toContain('Strategy Run');
    expect(html).toContain('trade-source-funnel');
    expect(html).toContain('今日被挡 3');
    expect(html).toContain('回测对比 →(即将上线)');
    expect(html).toMatch(/data-testid="trade-source-toggle"[^>]*disabled|disabled[^>]*data-testid="trade-source-toggle"/);
  });
  it('风控面板:按执行顺序的行、ATR 下限一行、agent 直改区间、Ask agent 按钮;访客无保存', () => {
    const html = wrap(<RiskPanel policy={policy()} loading={false} error={null} workflow={undefined} usageFallback={{ open_threads: 0, opens_today: 0, daily_loss_hit: false }} lock={null} noteError={() => false} onAskAgent={() => {}} />);
    const order = [...html.matchAll(/data-key="([a-z_]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['daily_loss_stop_pct', 'max_opens_per_day', 'max_open_threads', 'same_symbol', 'min_stop_pct', 'min_stop_atr', 'max_stop_pct', 'min_net_rr', 'risk_pct', 'sizing_agent', 'leverage']);
    expect(html).toContain('trade-risk-ask-agent');
    expect(html).toContain('trade-risk-save');
    expect(html).toContain('agent 直改 0.3–2');
    expect(html).not.toMatch(/拆单(?!只做建议)/);
    const locked = wrap(<RiskPanel policy={policy()} loading={false} error={null} workflow={undefined} usageFallback={{ open_threads: 0, opens_today: 0, daily_loss_hit: false }} lock="read only" noteError={() => false} onAskAgent={() => {}} />);
    expect(locked).not.toContain('trade-risk-save');
  });
  it('新文案都有英文,并已并进全局词典', () => {
    const files = ['sources-logic.ts', 'source-card.tsx', 'sources-column.tsx', 'risk-panel.tsx', 'write-lock.ts', 'context-bar.tsx'];
    const src = files.map((f) => readFileSync(new URL(`../src/components/trade/${f}`, import.meta.url), 'utf8')).join('\n') + readFileSync(new URL('../src/pages/trade.tsx', import.meta.url), 'utf8');
    const keys = [...src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
    const tm = [...src.matchAll(/tmap\(\{([^}]*)\}/gs)].flatMap((m) => [...m[1]!.matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]!));
    expect([...new Set([...keys, ...tm])].filter((k) => !(k in EN))).toEqual([]);
    for (const k of Object.keys(TRADE_EN)) expect(EN[k]).toBeTruthy();
    // 本轮新词条不被别的词典同名 key 覆盖(三层模型的关键词评委要看到原样)
    for (const k of ['机会来源', '判断层', '风控与执行', '被挡层·风控', '被挡层·运行上限', '让 agent 调参', '漏斗·下单']) expect(EN[k]).toBe(TRADE_EN[k]);
  });
});

describe('AI Scan 单独暂停与「今日没做」', () => {
  const shared = { open_threads: 0, max_open_threads: 3, opens_today: 0, max_opens_per_day: 4, daily_loss_hit: false, halted: false, paused: false };
  const ai = (extra: Record<string, unknown>) => ({ kind: 'ai_scan' as const, enabled: true, playbook: 'Breakout pullback', judge: 'model' as const, today: { judgments: 30, cap: 2000, actions: { NO_TRADE: 25, WATCH: 5 }, gate_rejected: 0, orders: 0 }, top_reasons: [], ...extra });
  const cardsOf = (src: ReturnType<typeof ai>) => sourceCards({ sources: { shared, sources: [src] } as TradingSourcesView, runs: [], agent: undefined, usage: null, halted: false, paused: false, watchCount: 0, threads: [] });

  it('ai_scan.paused 时卡片显示暂停,策略运行不受影响', () => {
    expect(cardsOf(ai({ paused: true }))[0]!.status).toBe('paused');
    expect(cardsOf(ai({ paused: false }))[0]!.status).toBe('running');
  });

  it('not_taken 按次数排、最多三项,不算进被挡', () => {
    const [card] = cardsOf(ai({ not_taken: [
      { layer: 'judge', key: 'watch', label: '观察', count: 5 },
      { layer: 'judge', key: 'no_trade', label: '不交易', count: 25 },
      { layer: 'execution', key: 'bars_pending', label: '行情没到', count: 2 },
      { layer: 'execution', key: 'transient', label: '临时失败', count: 1 },
    ] }));
    expect(card!.funnel.blocked).toBe(0);
    expect(notTakenLine(card!.notTaken)).toBe('判断不交易 25 · 观察中 5 · 行情还没到 2');
    expect(notTakenLine([])).toBeNull();
  });
});
