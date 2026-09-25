/** 持仓契约与动作闸。纯函数；价格/成本闸使用十进制有理数，不调用模型或执行器。 */
import { capacityDecimal as D } from './capacity-decimal.js';
import { HORIZON_POLICY, inferHorizon, type StrategyHorizon } from './horizon.js';
import { tfToMs, type TfFeatures } from './market.js';
import { parseInvalidationPrice, tfDirection } from './review-metrics.js';
import type { Action, Direction, GateResult, Judgment, Kline, MarketView, StrategyThread } from './types.js';
import type { StrategySpec } from './strategies.js';

export const HOLDING_POLICY_VERSION = 'holding-v1';
export interface HoldingPlan {
  policy_version: typeof HOLDING_POLICY_VERSION;
  origin: 'entry' | 'legacy_snapshot';
  established_at: number;
  strategy_ref: { id: string; version: number; content_hash: string } | null;
  horizon: StrategyHorizon;
  thesis_timeframe: string;
  confirm_timeframe: string;
  atr_timeframe: string;
  atr_multiple: string;
  atr_at_entry: string;
  selection_source: 'model' | 'derived';
  entry_price: string;
  hard_stop: string;
  invalidation_price: string | null;
  invalidation_text: string | null;
  thesis: string;
  confirm_bars: number;
  invalidation_buffer_atr: string;
  entry_trends: Record<string, Direction | null>;
  round_trip_cost_bps: string;
  min_net_rr: string;
  gross_rr: string | null;
  net_rr: string | null;
  target_mode: 'single' | 'scale_out';
  tp1_qty?: string;
}

export interface HoldingInputs {
  thread: StrategyThread;
  now: number;
  market: Pick<MarketView, 'mark' | 'as_of'>;
  features: TfFeatures[];
  klines: Record<string, Kline[]>;
  /** 仅确定性风控/已由人核实的事实可置入，模型输出不能直接创建事件旁路。 */
  event?: { id: string; verified_by: 'user' | 'risk_service'; adverse_side: Direction; observed_at: number; material: boolean };
}
export interface HoldingReview {
  allowed_actions: Action[];
  required_action: 'EXIT' | null;
  reason: string;
  attention: boolean;
  last_closed_at: number | null;
  spike: ReturnType<typeof spikeEvidence>;
}
const price = (v: unknown): v is string => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && D(v).cmp(D('0')) > 0;
const decimal = (n: number): string => D(n.toFixed(12)).text();
const sign = (side: Direction): number => side === 'long' ? 1 : -1;
const distance = (a: string, b: string) => D(a).cmp(D(b)) >= 0 ? D(a).sub(D(b)) : D(b).sub(D(a));
const direction = (features: TfFeatures[], tf: string) => tfDirection(features.find((f) => f.tf === tf) ?? null);
export function holdingTimeframes(h: StrategyHorizon, entryTf: string): [string, string] {
  return h === 'scalp' ? [entryTf, '1h'] : h === 'position' ? ['1d', '1w'] : [HORIZON_POLICY[h].timeframe, HORIZON_POLICY[h].confirm];
}
export function holdingEconomics(side: Direction, entry: string, stop: string, target: string | null, costBps = '12') {
  if (![entry, stop].every(price) || !target || !price(target) || !/^\d+(\.\d+)?$/.test(costBps)) return null;
  const e = D(entry), s = D(stop), tp = D(target), risk = side === 'long' ? e.sub(s) : s.sub(e), reward = side === 'long' ? tp.sub(e) : e.sub(tp);
  if (risk.cmp(D('0')) <= 0 || reward.cmp(D('0')) <= 0) return null;
  const costs = e.max(tp).mul(D(costBps)).div(D('10000'));
  const netReward = reward.sub(costs), netRisk = risk.add(costs);
  return { gross_rr: reward.div(risk).text(), net_rr: netReward.cmp(D('0')) > 0 ? netReward.div(netRisk).text() : '0', cost_per_unit: costs.text(), net_risk_per_unit: netRisk.text() };
}

export function buildHoldingPlan(inp: {
  thread: StrategyThread; features: TfFeatures[]; judgment?: Judgment | null; strategy?: StrategySpec | null;
  now: number; origin?: HoldingPlan['origin']; round_trip_cost_bps?: string; confirm_bars?: number; invalidation_buffer_atr?: number;
}): HoldingPlan | null {
  const t = inp.thread, j = inp.judgment, choice = j?.proposal?.risk_plan;
  const h = t.horizon ?? inp.strategy?.horizon ?? inferHorizon(t.timeframe);
  // 不给人工/接管的旧持仓凭空改变周期；只有明确策略周期才使用策略映射。
  const [tf, confirm] = !t.horizon && !inp.strategy ? [t.timeframe, h === 'position' ? '1w' : HORIZON_POLICY[h].confirm] : holdingTimeframes(h, t.timeframe);
  const atrTf = choice?.atr_timeframe ?? tf;
  const base = inp.features.find((f) => f.tf === atrTf);
  const entry = t.filled_avg_price ?? t.entry.price ?? j?.proposal?.limit_price;
  if (!entry || !price(entry) || !t.stop_price || !price(t.stop_price) || !base || !(base.atr14 > 0) || !Number.isFinite(base.atr14)) return null;
  const origin = inp.origin ?? 'entry';
  const inv = j?.invalidation_price ?? (parseInvalidationPrice(t.invalidation_text, Number(entry))?.toString() ?? null);
  const bps = inp.round_trip_cost_bps ?? '12';
  const econ = holdingEconomics(t.side, entry, t.stop_price, t.take_profits[0] ?? null, bps);
  return {
    policy_version: HOLDING_POLICY_VERSION, origin, established_at: inp.now,
    strategy_ref: inp.strategy ? { id: inp.strategy.id, version: inp.strategy.version, content_hash: inp.strategy.content_hash } : t.strategy_id && t.strategy_version && t.strategy_content_hash ? { id: t.strategy_id, version: t.strategy_version, content_hash: t.strategy_content_hash } : null,
    horizon: h, thesis_timeframe: tf, confirm_timeframe: confirm, atr_timeframe: atrTf,
    atr_multiple: choice?.stop_atr_multiple ?? distance(entry, t.stop_price).div(D(decimal(base.atr14))).text(), atr_at_entry: decimal(base.atr14), selection_source: choice ? 'model' : 'derived',
    entry_price: entry, hard_stop: t.stop_price, invalidation_price: inv && price(inv) ? inv : null, invalidation_text: t.invalidation_text, thesis: t.thesis,
    confirm_bars: Math.max(1, Math.round(inp.confirm_bars ?? 2)), invalidation_buffer_atr: decimal(Math.max(inp.invalidation_buffer_atr ?? 0.2, HORIZON_POLICY[h].invalidation_atr)),
    entry_trends: { [tf]: origin === 'entry' ? direction(inp.features, tf) : null, [confirm]: origin === 'entry' ? direction(inp.features, confirm) : null },
    round_trip_cost_bps: bps, min_net_rr: String(inp.strategy?.params['min_net_rr']?.value ?? 1.5), gross_rr: econ?.gross_rr ?? null, net_rr: econ?.net_rr ?? null, target_mode: 'single',
  };
}

/** 入场时验证模型所选ATR尺度、最小净收益、失效线方向。只拒绝，不修订单价格。 */
export function holdingEntryGates(plan: HoldingPlan | null, t: StrategyThread): GateResult[] {
  if (t.market === 'spot' && t.stop_price === null) return [{ name: '持仓计划', passed: true, reason: '现货,无止损(可选)' }];
  if (!plan) return [{ name: '持仓计划', passed: false, reason: '主周期ATR/入场价格缺失，无法建立持仓契约' }];
  const allowedTf = holdingTimeframes(plan.horizon, t.timeframe);
  const minAtr = D(String(HORIZON_POLICY[plan.horizon].stop_atr));
  const chosen = D(plan.atr_multiple);
  const actual = distance(plan.entry_price, plan.hard_stop).div(D(plan.atr_at_entry));
  const rrOk = plan.net_rr !== null && D(plan.net_rr).cmp(D(plan.min_net_rr)) >= 0;
  return [
    { name: '策略ATR尺度', passed: allowedTf.includes(plan.atr_timeframe) && chosen.cmp(minAtr) >= 0 && actual.cmp(minAtr) >= 0 && chosen.cmp(D('4')) <= 0 && (plan.selection_source === 'derived' || actual.cmp(chosen) >= 0),
      reason: `${plan.atr_timeframe} ATR=${plan.atr_at_entry}，选择${plan.atr_multiple}倍，实际${actual.text()}倍；策略下限${minAtr.text()}倍` },
    { name: '净盈亏比', passed: rrOk, reason: `净RR=${plan.net_rr ?? '不可计算'}，需≥${plan.min_net_rr}；往返成本预算${plan.round_trip_cost_bps}bps` },
    { name: '结构失效价', passed: plan.invalidation_price !== null && (t.side === 'long' ? D(plan.invalidation_price).cmp(D(plan.entry_price)) < 0 && D(plan.invalidation_price).cmp(D(plan.hard_stop)) >= 0 : D(plan.invalidation_price).cmp(D(plan.entry_price)) > 0 && D(plan.invalidation_price).cmp(D(plan.hard_stop)) <= 0), reason: '失效价须位于入场的不利一侧与硬止损之间，不从自由文本漂移' },
  ];
}

function validBars(bars: readonly Kline[], ms: number, weekly = false): boolean {
  return bars.length > 0 && bars.every((b,i) => Number.isSafeInteger(b.open_time) && Number.isSafeInteger(b.close_time)
    && b.close_time-b.open_time===ms-1 && (b.open_time-(weekly?345600000:0))%ms===0
    && [b.open,b.high,b.low,b.close].every(price)
    && D(b.high).cmp(D(b.open))>=0 && D(b.high).cmp(D(b.close))>=0
    && D(b.low).cmp(D(b.open))<=0 && D(b.low).cmp(D(b.close))<=0
    && (i===0 || b.open_time-bars[i-1]!.open_time===ms));
}

/** 冲击前14根TR，避免用本根扩大后的ATR淡化冲击；输出形态事实而非预测反弹。 */
export function spikeEvidence(side: Direction, bars: readonly Kline[], now: number) {
  const visible = bars.filter((b) => b.close_time <= now);
  const b = visible.at(-1), previous = visible.slice(-16, -1);
  if (!b || previous.length < 15) return null;
  const ms=b.close_time-b.open_time+1;
  if (![60000,180000,300000,900000,3600000,14400000,86400000,604800000].includes(ms) || now-b.close_time>ms || !validBars([...previous,b],ms,ms===604800000)) return null;
  const tr = previous.slice(1).map((x, i) => Math.max(Number(x.high) - Number(x.low), Math.abs(Number(x.high) - Number(previous[i]!.close)), Math.abs(Number(x.low) - Number(previous[i]!.close))));
  const atr = tr.reduce((a, x) => a + x, 0) / 14;
  const prev = Number(previous.at(-1)!.close), lo = Number(b.low), hi = Number(b.high), c = Number(b.close), o = Number(b.open);
  if (!(atr > 0) || ![lo, hi, c, o].every((x) => Number.isFinite(x) && x > 0) || hi < Math.max(o,c) || lo > Math.min(o,c)) return null;
  const excursion = Math.max(0, side === 'long' ? prev - lo : hi - prev), wick = side === 'long' ? Math.min(o,c)-lo : hi-Math.max(o,c);
  const recovery = excursion > 0 ? Math.max(0, Math.min(1, (side === 'long' ? c-lo : hi-c)/excursion)) : 0;
  const recovered = hi > lo && wick/(hi-lo) >= 0.5 && recovery >= 0.65;
  return { state: excursion/atr < 1.5 ? 'ordinary_noise' : recovered ? 'wick_recovered' : 'shock_unresolved', excursion_atr: decimal(excursion/atr), recovery_fraction: decimal(recovery), close_at: b.close_time, exit_signal: false };
}

/**
 * 这两种情况下连挂单也不放开撤单:行情快照过期(fail-closed,与 scan:stale 不许 PROPOSE 同一姿态)、
 * 以及根本没有持仓计划的旧线程(判据是从计划里来的,没有计划就没有判断依据)。
 * 注意 `legacy_plan_unavailable` 的分支在 stale 检查**之前**返回,所以必须单独列出来。
 */
const NO_PENDING_CANCEL = ['market_stale_keep_protection', 'legacy_plan_unavailable'];

export function evaluateHoldingReview(inp: HoldingInputs): HoldingReview {
  const t = inp.thread, p = t.holding_plan, now = inp.now;
  const spike = spikeEvidence(t.side, inp.klines[t.timeframe] ?? [], now);
  // 撤一张还没成交的入场单不动钱、不改任何已批准的经济字段,过撤的代价是错过一笔而不是亏一笔;
  // 所以挂单线程的 INVALIDATE 是常开的边,判不判撤由「挂单耐心(代码计算)」那条证据支撑(entry-policy.ts)。
  // 例外:`market_stale_keep_protection` 是 fail-closed 的一环(行情快照过期时不让模型做任何动作,
  // 与 scan:stale 不许 PROPOSE 同一套姿态),撤单也不放开——看不见行情就不动手。
  const out = (allowed_: Action[], reason: string, attention = false, close: number | null = null): HoldingReview => ((allowed: Action[]) => ({ allowed_actions: allowed, required_action: allowed.length === 1 && allowed[0] === 'EXIT' ? 'EXIT' : null, reason, attention, last_closed_at: close, spike }))(t.status === 'pending_entry' && !NO_PENDING_CANCEL.includes(reason) && !allowed_.includes('INVALIDATE') ? [...allowed_, 'INVALIDATE'] : allowed_);
  const markFresh = price(inp.market.mark) && Number.isInteger(inp.market.as_of) && inp.market.as_of <= now && now - inp.market.as_of <= 180000 && inp.market.as_of > (t.opened_at ?? t.created_at);
  // 已挂保护订单与确定性风险处理不依赖模型/新计划；即使旧计划缺失也不能屏蔽硬触价。
  if (t.status === 'in_position' && markFresh && t.stop_price && price(t.stop_price) && sign(t.side) * D(inp.market.mark).cmp(D(t.stop_price)) <= 0) return out(['EXIT'], 'hard_stop_touch');
  if (!p) return out(['HOLD'], 'legacy_plan_unavailable', true);
  if (!markFresh) return out(['HOLD'], 'market_stale_keep_protection', true);
  const ms = tfToMs(p.thesis_timeframe), all = inp.klines[p.thesis_timeframe] ?? [];
  const valid = validBars(all, ms, p.thesis_timeframe === '1w');
  const since = t.opened_at ?? t.created_at;
  const bars = valid ? all.filter((b) => b.open_time >= since && b.close_time <= now).sort((a,b) => a.close_time-b.close_time) : [];
  const last = bars.at(-1), fresh = last && now - last.close_time <= ms;
  if (t.status === 'in_position' && fresh && sign(t.side) * D(last.close).cmp(D(p.hard_stop)) <= 0) return out(['EXIT'], 'closed_beyond_hard_stop', false, last.close_time);
  const event = inp.event;
  if (event?.material && ['user','risk_service'].includes(event.verified_by) && event.id.trim() && event.adverse_side === t.side && event.observed_at > since && event.observed_at <= now && now-event.observed_at <= 180000) return out(t.status === 'pending_entry' ? ['HOLD','INVALIDATE'] : ['HOLD','REDUCE','EXIT'], 'verified_material_event', true, last?.close_time ?? null);
  if (!fresh) return out(['HOLD'], 'no_fresh_closed_thesis_bars', true);
  if (last.close_time <= (t.last_policy_close_at ?? 0)) return out(['HOLD'], 'no_new_thesis_close', false, last.close_time);
  let count = 0, previous: number | null = null;
  if (p.invalidation_price) for (let i=bars.length-1;i>=0;i--) {
    const b=bars[i]!;
    if (previous!==null && previous-b.close_time!==ms) break;
    if (sign(t.side)*D(b.close).cmp(D(p.invalidation_price))>=0) break;
    count++; previous=b.close_time;
  }
  const depth = p.invalidation_price ? sign(t.side)*(Number(p.invalidation_price)-Number(last.close))/Number(p.atr_at_entry) : 0;
  const confirmed = count >= p.confirm_bars && depth >= Number(p.invalidation_buffer_atr);
  const tfs = [p.thesis_timeframe,p.confirm_timeframe];
  const trendReady = tfs.every((tf) => {
    const f=inp.features.find((f)=>f.tf===tf), ks=inp.klines[tf]?.filter((k)=>k.close_time<=now), k=ks?.at(-1);
    return f && k && ks && validBars(ks,tfToMs(tf),tf==='1w') && k.open_time>=since && now-k.close_time<=tfToMs(tf) && f.last_open_time===k.open_time;
  });
  const flipped = trendReady && tfs.every((tf)=>p.entry_trends[tf]===t.side && direction(inp.features,tf)!==null && direction(inp.features,tf)!==t.side);
  if (confirmed || flipped) return out(t.status==='pending_entry'?['HOLD','INVALIDATE']:['HOLD','EXIT'], confirmed?'confirmed_thesis_invalidation':'new_both_timeframe_reversal', false,last.close_time);
  const r = sign(t.side)*(Number(inp.market.mark)-Number(p.entry_price))/Math.abs(Number(p.entry_price)-Number(p.hard_stop));
  if(t.status==='in_position' && r>=1 && trendReady && direction(inp.features,p.thesis_timeframe)!==null && direction(inp.features,p.thesis_timeframe)!==t.side) return out(['HOLD','REDUCE'],'profit_with_thesis_weakness',false,last.close_time);
  return out(['HOLD'],spike?.state==='wick_recovered'?'wick_recovered_thesis_intact':'thesis_intact',false,last.close_time);
}

export function renderAtrChoices(features: TfFeatures[], strategies: StrategySpec[]): string {
  return strategies.map((s) => {
    const tfs=holdingTimeframes(s.horizon,s.trigger.min_timeframe);
    const choices=tfs.map(tf=>{const f=features.find(f=>f.tf===tf);return `${tf}:ATR=${f&&f.atr14>0?decimal(f.atr14):'缺失(不可选)'}`;}).join(';');
    return `${s.id} horizon=${s.horizon} ${choices};可选倍数1/1.5/2/3(策略下限${HORIZON_POLICY[s.horizon].stop_atr})；在proposal.risk_plan填写atr_timeframe与stop_atr_multiple。止损还需在结构外，止盈必须引用独立目标；不要为凑RR推远目标。`;
  }).join('\n');
}
