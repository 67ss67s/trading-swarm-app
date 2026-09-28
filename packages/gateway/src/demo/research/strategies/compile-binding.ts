/**
 * StrategyBinding 编译器(§9.47,docs/design/strategy-apply-spec-2026-09-23.md §3):
 * 研究台策略版本(StrategyIR,唯一真源)→ 实盘绑定(只读编译产物),并把规则按角色切片:
 *   radar(什么时候唤醒)/ judge(模型只做入场过滤)/ geometry(代码放止损止盈)/ risk(仓位与杠杆)/
 *   holding(代码管仓,模型不管)/ execution(市价/限价、时效、结转)。每条规则写清执行者 code | model。
 *
 * 口径不自己发明,全部读研究台现行实现(只读引用,不改):
 *   - 订单门:order-gate.ts orderGateFor(ir, DEFAULT_ORDER_GATE)。结构口径(有 min_stop_atr)下止损离入场 <k×ATR 不做、
 *     盈亏比只展示(只有 order.min_rr 用户硬约束才拦)、止盈只取图上价位,算不出就不设交给追踪止损;
 *   - 止盈/时效/结转缺省:orders/intents.ts resolveOrder(研究回放用的同一个函数;不带 order 块的 IR 按现货做多补一个空块再解析);
 *   - 周期:horizon.ts inferHorizon / HORIZON_POLICY(1m/3m/5m 是 scalp,不接)。
 * IR 里实盘不支持的一律进 unmapped(block 不能下发,warn 能下发但语义有损),不近似、不静默丢。
 * 纯函数:不读库、不调模型、不碰交易所。
 */
import type { BindingEvidenceIndicator, BindingRoleSlice, BindingRule, BindingTarget, BindingUnmapped, StrategyBinding, StrategyIR, StrategyPrimitive } from '@trade-gate/contracts';
import { registry } from '../primitives/index.js';
import { hash } from '../primitives.js';
import { DEFAULT_ORDER_GATE, orderGateFor } from '../order-gate.js';
import { resolveOrder } from '../orders/intents.js';
import { hasSignalExit, STRATEGY_SPEC_VERSION } from '../strategy-spec.js';
import { MAX_RESEARCH_LEVERAGE, timeframeMillis } from '../strategy.js';
import { HORIZON_POLICY, inferHorizon } from '../../horizon.js';

export const BINDING_SCHEMA_VERSION = 'strategy-binding/v1' as const;
export const BINDING_COMPILER_VERSION = 'compile-binding/1';
/** 实盘杠杆上限:与研究侧上限同一个数(strategy.ts MAX_RESEARCH_LEVERAGE = 20) */
export const BINDING_LEVERAGE_CAP = MAX_RESEARCH_LEVERAGE;

export interface CompileBindingInput {
  strategy_id: string;
  version: number;
  ir: StrategyIR;
  timeframe: string;
  symbol: string;
  report_ids?: string[];
  /** 导入内置策略时丢掉的原规则语义(import-builtin.ts 的译文表),原样并进 unmapped */
  known_gaps?: BindingUnmapped[];
  now?: number;
}

const TRACKERS = new Set(['chandelier_trail', 'swing_structure_stop']);
const BREAKEVEN = 'breakeven_after_r';
const TARGET_ONLY = new Set(['fixed_r_target', 'structure_target', 'pivot_target']);
const INDICATOR_NODES = new Set(['indicator_cross', 'indicator_cross_exit', 'indicator_threshold', 'indicator_threshold_exit', 'indicator_divergence', 'indicator_divergence_exit', 'indicator_level']);

/** 原语注册表指纹:名字 + 类别(新增/改类别都会变);绑定里记它,研究与生产对拍时核对 */
export function registryFingerprint(): string {
  return `registry/${hash([...registry.values()].map((p) => `${p.name}:${p.category}`).sort()).slice(0, 16)}`;
}

/** 与 strategy.ts humanizeRule 同口径:describe 末尾的 JSON 参数改成「k v · k v」 */
function describe(node: StrategyPrimitive): string {
  const text = registry.get(node.primitive)?.describe(node.params) ?? `未识别原语 ${node.primitive}`;
  return text.replace(/[（(](\{[^）)]*\})[）)]\s*$/, (m, json: string) => {
    try {
      const parts = Object.entries(JSON.parse(json) as Record<string, unknown>).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      return parts.length ? `(${parts.join(' · ')})` : '';
    } catch {
      return m;
    }
  });
}
const rule = (text: string, executor: BindingRule['executor'], ref: string | null = null, primitive: string | null = null): BindingRule => ({ text, executor, ref, primitive });
const nodeRule = (node: StrategyPrimitive, ref: string, prefix = ''): BindingRule => rule(`${prefix}${describe(node)}`, 'code', ref, node.primitive);

// ---------------------------------------------------------------- 证据推导

function numArgs(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  return out;
}
/** 由 IR 原语输入推导模型要看的证据(不手填);指标按「指标+参数+输出线+周期」去重 */
export function evidencePlan(ir: StrategyIR, timeframe: string, structureGate: boolean): StrategyBinding['evidence_plan'] {
  const inds = new Map<string, BindingEvidenceIndicator>(), structure = new Set<string>();
  const add = (indicator: string, args: Record<string, number>, output: string | null, tf: string, from: string) => {
    if (indicator === 'price') return;
    const a = Object.keys(args).sort().map((k) => `${k}=${args[k]}`).join(',');
    const id = `${indicator}(${a})${output ? `.${output}` : ''}@${tf}`;
    const hit = inds.get(id);
    if (hit) { if (!hit.from.includes(from)) hit.from.push(from); return; }
    inds.set(id, { id, indicator, args, output, timeframe: tf, from: [from] });
  };
  const visit = (n: StrategyPrimitive, from: string) => {
    const p = n.params as Record<string, unknown>, tf = typeof p.htf === 'string' ? p.htf : timeframe, num = (k: string) => Number(p[k]);
    if (INDICATOR_NODES.has(n.primitive)) {
      add(String(p.indicator), numArgs(p.args), typeof p.output === 'string' ? p.output : null, timeframe, from);
      if (p.compare_to === 'indicator') add(String(p.compare_indicator ?? p.indicator), numArgs(p.compare_args ?? p.args), typeof p.compare_output === 'string' ? p.compare_output : null, timeframe, from);
      if (typeof p.buffer_atr === 'number') add('atr', { period: Number(p.atr_period ?? 14) }, null, timeframe, from);
      return;
    }
    switch (n.primitive) {
      case 'ema_cross': add('ema', { period: num('fast') }, null, tf, from); add('ema', { period: num('slow') }, null, tf, from); return;
      case 'macd_cross': case 'macd_divergence': case 'macd_divergence_exit': add('macd', numArgs({ fast: p.fast, slow: p.slow, signal: p.signal }), null, tf, from); if (n.primitive !== 'macd_cross') structure.add('swing_pivots'); return;
      case 'rsi_threshold': add('rsi', { period: num('period') }, null, tf, from); return;
      case 'donchian_breakout': add('donchian', { period: num('lookback') }, null, tf, from); return;
      case 'volume_surge': add('volume_ratio', { period: num('lookback') }, null, tf, from); return;
      case 'htf_ma_state': add(p.ma === 'ema' ? 'ema' : 'sma', { period: num('period') }, null, tf, from); return;
      case 'trend_state': add('adx', { period: num('adx_period') }, null, tf, from); add('ema', { period: num('ema_fast') }, null, tf, from); add('ema', { period: num('ema_slow') }, null, tf, from); return;
      case 'trend_break': add('ema', { period: num('ema_period') }, null, timeframe, from); structure.add(`htf_trend@${tf}`); return;
      case 'atr_stop': case 'chandelier_trail': add('atr', { period: num('atr_period') }, null, timeframe, from); return;
      case 'atr_offset_level': add('atr', { period: Number(p.atr_period ?? 14) }, null, timeframe, from); return;
      case 'pivot_stop': case 'pivot_target': structure.add('swing_pivots'); add('atr', { period: Number(p.atr_period ?? 14) }, null, timeframe, from); return;
      case 'structure_level': case 'structure_target': case 'order_blocks': case 'htf_structure': case 'htf_structure_regime': structure.add(typeof p.htf === 'string' ? `htf_structure@${p.htf}` : 'order_blocks'); return;
      case 'swing_low_stop': case 'swing_structure_stop': structure.add('swing_low'); return;
      case 'higher_low_sequence': case 'structure_pivots': case 'structure_bos': case 'double_bottom': case 'double_top_exit': case 'head_and_shoulders_inverse': structure.add('swing_pivots'); return;
      case 'bullish_engulfing': case 'bearish_engulfing_exit': case 'pin_bar': case 'fair_value_gap': case 'inside_bar_breakout': structure.add('candle_patterns'); return;
      default:
        if (n.primitive.startsWith('smc_')) structure.add('smc_structure');
        else if (n.primitive.startsWith('pine_')) structure.add(`pine:${n.primitive}`);
    }
  };
  ir.signal.forEach((n, i) => visit(n, `signal[${i}]`));
  if (ir.regime) visit(ir.regime, 'regime');
  visit(ir.risk.stop, 'risk.stop');
  ir.exit.forEach((n, i) => visit(n, `exit[${i}]`));
  if (ir.order?.entry?.price) visit(ir.order.entry.price, 'order.entry.price');
  ir.order?.take_profits?.forEach((t, i) => visit(t.source, `order.take_profits[${i}]`));
  ir.order?.short_signal?.forEach((n, i) => visit(n, `order.short_signal[${i}]`));
  if (ir.order?.short_regime) visit(ir.order.short_regime, 'order.short_regime');
  // 结构口径的「止损太近不做」用 ATR(14) 判,模型也要看到同一个数
  if (structureGate) add('atr', { period: 14 }, null, timeframe, 'geometry.min_stop_atr');
  return { indicators: [...inds.values()].slice(0, 60), structure: [...structure].slice(0, 30), info_topics: [] };
}

// ---------------------------------------------------------------- unmapped

function compilerGaps(ir: StrategyIR, timeframe: string, leverage: number, direction: StrategyBinding['direction']): BindingUnmapped[] {
  const out: BindingUnmapped[] = [];
  const u = (code: string, severity: BindingUnmapped['severity'], message: string, path: string | null = null) => out.push({ code, path, severity, message, source: 'compiler' });
  let tfMs = 0;
  try { tfMs = timeframeMillis(timeframe); } catch { u('timeframe_invalid', 'block', `周期 ${timeframe} 不认识`, 'timeframe'); }
  if (tfMs && inferHorizon(timeframe) === 'scalp') u('horizon_scalp', 'block', `${timeframe} 属于 scalp(1m/3m/5m),实盘绑定不接受;请用 15m 及以上周期`, 'timeframe');
  if (direction !== 'long') u('direction_not_long', 'block', `方向 ${direction}:实盘 IR 候选目前只做多(研究 IR 的止损/追踪按多头写死,orders/ 执行核接进实盘前做空不能兑现)`, 'order.direction');
  if (leverage > BINDING_LEVERAGE_CAP) u('leverage_over_cap', 'block', `杠杆 ${leverage} 倍超过实盘上限 ${BINDING_LEVERAGE_CAP} 倍`, 'order.leverage');
  if (ir.universe?.screen) u('universe_screen', 'block', '多资产筛选池(universe.screen)线上没有筛选行,候选永远不会触发', 'universe.screen');
  if (ir.compatibility) u('legacy_compatibility', 'warn', `旧模板兼容标记 ${ir.compatibility}:按 IR 原语执行,旧模板语义不再单独维护`, 'compatibility');
  if (ir.risk.stop.primitive === 'no_stop') u('no_stop', 'block', '不设止损:实盘每笔必须有硬止损(失效线),研究里可以回测,不能下发', 'risk.stop');
  const nodes: [StrategyPrimitive, string][] = [...ir.signal.map((n, i) => [n, `signal[${i}]`] as [StrategyPrimitive, string]), [ir.entry, 'entry'], [ir.risk.stop, 'risk.stop'], [ir.risk.sizing, 'risk.sizing'], ...ir.exit.map((n, i) => [n, `exit[${i}]`] as [StrategyPrimitive, string])];
  if (ir.regime) nodes.push([ir.regime, 'regime']);
  if (ir.order?.entry?.price) nodes.push([ir.order.entry.price, 'order.entry.price']);
  ir.order?.take_profits?.forEach((t, i) => nodes.push([t.source, `order.take_profits[${i}]`]));
  for (const [n, path] of nodes) {
    if (!registry.has(n.primitive)) u('unknown_primitive', 'block', `原语 ${n.primitive} 不在原语库里`, path);
    else if (n.primitive.startsWith('pine_')) u('pine_primitive', 'block', `${n.primitive} 依赖 Pine 引擎,线上候选生成不跑 Pine`, path);
  }
  if (ir.entry.primitive !== 'next_open_market') u('entry_primitive', 'warn', `entry=${ir.entry.primitive}:实盘按信号根收盘后下一根开盘执行`, 'entry');
  // 实盘能表达、但 CandidateV0 影子纵切还没接的能力(apply-spec §10 能力子集:spot|perp-long / market / 单目标 / 机械退出)
  if (ir.order?.entry?.type === 'limit') u('v0_limit_entry', 'warn', '限价入场:绑定能表达;CandidateV0 影子目前按下一根开盘市价算候选', 'order.entry');
  if ((ir.order?.take_profits?.length ?? 0) > 1) u('v0_multi_target', 'warn', `分 ${ir.order!.take_profits!.length} 档止盈:CandidateV0 影子只结算单目标`, 'order.take_profits');
  return out;
}

// ---------------------------------------------------------------- 编译

export function compileBinding(input: CompileBindingInput): StrategyBinding {
  const { ir, timeframe } = input;
  let tfMs = 3600_000;
  try { tfMs = timeframeMillis(timeframe); } catch { /* compilerGaps 里 block */ }
  const gate = orderGateFor(ir, DEFAULT_ORDER_GATE);
  const minStopAtr = (gate as { min_stop_atr?: number | null }).min_stop_atr;
  const structureGate = typeof minStopAtr === 'number' && Number.isFinite(minStopAtr);
  // 与研究回放同一个解析函数:不带 order 块的 IR 按现货做多补空块
  const resolved = resolveOrder(ir.order ? ir : { ...ir, order: { direction: 'long', market: 'spot' } }, tfMs, gate)!;
  const direction = resolved.direction, market = resolved.market, leverage = resolved.leverage;
  const horizonRaw = (() => { try { timeframeMillis(timeframe); return inferHorizon(timeframe); } catch { return 'scalp' as const; } })();
  const horizon = horizonRaw === 'scalp' ? null : horizonRaw;

  const trail = ir.exit.find((x) => TRACKERS.has(x.primitive)) ?? null;
  const breakevenR = ir.exit.find((x) => x.primitive === BREAKEVEN);
  const signalExits = ir.exit.filter((x) => !TARGET_ONLY.has(x.primitive) && !TRACKERS.has(x.primitive) && x.primitive !== BREAKEVEN && x.primitive !== 'time_stop');
  const sum = resolved.take_profits.reduce((a, t) => a + (t.size_pct > 0 ? t.size_pct : 0), 0);
  const targets: BindingTarget[] = resolved.take_profits.map((t) => ({
    source: t.source,
    size_pct: sum > 0 && t.size_pct > 0 ? Math.round((t.size_pct / sum) * 1e6) / 1e6 : Math.round((1 / resolved.take_profits.length) * 1e6) / 1e6,
    kind: t.source.primitive === 'fixed_r_target' ? 'r_multiple' : t.source.primitive === 'indicator_level' ? 'indicator' : 'chart',
  }));
  const target_policy: StrategyBinding['target_policy'] = targets.some((t) => t.kind === 'r_multiple') ? 'user_r' : targets.length ? 'chart' : hasSignalExit(ir.exit) ? 'signal_exit' : 'trail_only';
  const stopBuffer = typeof ir.risk.stop.params.buffer_atr === 'number' ? (ir.risk.stop.params.buffer_atr as number) : ir.risk.stop.primitive === 'pivot_stop' ? 0.1 : null;
  const confirm = horizon ? HORIZON_POLICY[horizon].confirm : null;
  // 盈亏比门槛:只有用户硬约束(>0)才算;0/缺省 = 只展示
  const minRR = resolved.min_rr !== null && resolved.min_rr > 0 ? resolved.min_rr : null;

  const unmapped = [...compilerGaps(ir, timeframe, leverage, direction), ...(input.known_gaps ?? [])].slice(0, 100);
  const evidence = evidencePlan(ir, timeframe, structureGate);
  const model: StrategyBinding['model'] = {
    entry_filter: 'on',
    exit_discretion: 'off',
    outputs: ['follow', 'skip', 'narrative', 'risk_events'],
    forbidden: ['改入场价', '改止损', '改止盈', '改仓位或杠杆', '持仓期发起离场(只有信号离场触发 / 硬止损 / 已核实利空事件才允许 EXIT)'],
  };

  // ---- 六个角色切片
  const tfUp = timeframe.toUpperCase();
  const radar: BindingRule[] = [
    rule(`每根 ${tfUp} 收盘评估一次,只用已收盘 K 线;下面条件同一根同时成立(AND),且由假变真的那一根才算新信号`, 'code'),
    ...ir.signal.map((n, i) => nodeRule(n, `signal[${i}]`, '触发:')),
    ...(ir.regime ? [nodeRule(ir.regime, 'regime', '方向门:')] : []),
    ...(resolved.short_signal ?? []).map((n, i) => nodeRule(n, `order.short_signal[${i}]`, '做空触发:')),
    rule('不另设冷却根数;同向新信号按「执行」里的 on_new_signal 处理(替换挂单 / 结转或加仓)', 'code', 'order.on_new_signal'),
  ];
  const judge: BindingRule[] = [
    rule('候选(方向、入场参考、止损、止盈、盈亏比)由代码算好后才叫模型;模型只答 follow / skip,附叙事与风险事件', 'model'),
    rule(`模型看的证据由上面原语自动推导:${evidence.indicators.map((x) => x.id).join('、') || '无指标'}${evidence.structure.length ? `;结构:${evidence.structure.join('、')}` : ''}`, 'code'),
    rule('模型输出里的任何价格/仓位字段一律忽略(不能改入场价、止损、止盈、仓位、杠杆)', 'code'),
    rule('entry_filter 是否开启由研究台 A/C 臂配对证据决定(部署决定);关闭时候选直接进风控闸,不叫模型', 'code'),
  ];
  const geometry: BindingRule[] = [
    nodeRule(ir.risk.stop, 'risk.stop', '止损(= 失效线):'),
    ...(structureGate ? [rule(`止损离入场不到 ${minStopAtr}×ATR(14) 的单子直接不做,不把止损挪远`, 'code', null, null)] : [rule('旧口径:止损不得窄于成本下限,窄了放宽到下限', 'code')]),
    ...targets.map((t, i) => rule(`止盈${targets.length > 1 ? ` 第 ${i + 1} 档(${Math.round(t.size_pct * 100)}%)` : ''}:${describe(t.source)}`, 'code', ir.order?.take_profits?.length ? `order.take_profits[${i}]` : ir.exit.some((x) => x.primitive === t.source.primitive) ? `exit[${ir.exit.findIndex((x) => x.primitive === t.source.primitive)}]` : null, t.source.primitive)),
    rule(
      target_policy === 'chart' ? '止盈只取图上价位;这一根算不出就不设止盈,交给追踪止损,不按 R 倍数倒推补'
        : target_policy === 'user_r' ? '止盈用用户原话要求的 R 倍数(以放置后的止损为 1R)'
          : target_policy === 'signal_exit' ? '不设价位止盈:止盈由用户给的信号离场决定'
            : '没有价位止盈:持仓全部交给追踪止损',
      'code',
    ),
    rule(minRR !== null ? `用户硬约束盈亏比 ≥ ${minRR}:放置后达不到(或算不出止盈)不下单` : '盈亏比按初始止损计算并展示,不作为拦单门槛', 'code', minRR !== null ? 'order.min_rr' : null),
  ];
  const risk: BindingRule[] = [
    nodeRule(ir.risk.sizing, 'risk.sizing', '仓位口径:'),
    rule(`${market === 'perp' ? '永续' : '现货'} ${direction === 'long' ? '做多' : direction === 'short' ? '做空' : '双向'},杠杆 ${leverage} 倍(实盘上限 ${BINDING_LEVERAGE_CAP} 倍)`, 'code', 'order'),
    rule(`单笔初始风险 ≤ 权益 ${Number(gate.max_risk_fraction) * 100}%(风控闸)`, 'code'),
    rule('部署模式(关 / 影子 / 模拟 / 实盘)与仓位上限属于部署,由实盘部署台设定,不在策略语义里', 'code'),
  ];
  const holding: BindingRule[] = [
    ...(trail ? [nodeRule(trail, `exit[${ir.exit.indexOf(trail)}]`, '追踪止损(每根收盘只收紧):')] : []),
    ...(breakevenR ? [nodeRule(breakevenR, `exit[${ir.exit.indexOf(breakevenR)}]`, '保本:')] : []),
    ...(resolved.breakeven_after_tp ? [rule('首档止盈成交后剩余仓位止损移到入场均价', 'code', 'order.breakeven_after_tp')] : []),
    ...signalExits.map((n) => nodeRule(n, `exit[${ir.exit.indexOf(n)}]`, '信号离场:')),
    ...(resolved.max_holding_bars ? [rule(`持仓满 ${resolved.max_holding_bars} 根,下一根开盘离场`, 'code', 'order.max_holding_bars')] : []),
    rule('模型不管仓:持仓期零模型调用;改单只由代码按上面规则做', 'code'),
  ];
  const execution: BindingRule[] = [
    resolved.entry.type === 'limit' && resolved.entry.price
      ? rule(`限价入场:${describe(resolved.entry.price)};${resolved.entry.expiry_bars} 根内触价成交,否则撤单(no_fill)`, 'code', 'order.entry', resolved.entry.price.primitive)
      : rule('市价入场:信号根收盘后下一根开盘成交', 'code', ir.order?.entry ? 'order.entry' : 'entry', ir.entry.primitive),
    rule(`未成交时来了同向新信号:${resolved.on_new_signal.unfilled === 'replace' ? '整单替换' : '保留旧单'};已成交时:${{ roll: '旧计划按下一根开盘结转,新计划的止损止盈接管', add: `加仓(最多 ${resolved.max_adds} 腿)`, ignore: '忽略' }[resolved.on_new_signal.filled]}`, 'code', 'order.on_new_signal'),
    rule('同一根 K 线同时碰到止损与止盈按止损算;跳空按开盘价成交', 'code'),
  ];
  const slice = (role: BindingRoleSlice['role'], title: string, summary: string, rules: BindingRule[]): BindingRoleSlice => ({ role, title, summary, rules: rules.slice(0, 60) });
  const roles: BindingRoleSlice[] = [
    slice('radar', '雷达:什么时候唤醒', `${tfUp} 收盘评估 ${ir.signal.length} 个触发条件${ir.regime ? ' + 方向门' : ''},全部由代码算`, radar),
    slice('judge', '判断 agent:只做入场过滤', `模型只决定做 / 不做;证据 ${evidence.indicators.length} 条指标线 + ${evidence.structure.length} 类结构,由原语推导`, judge),
    slice('geometry', '几何:代码放止损止盈', `${structureGate ? `结构口径:止损离入场 <${minStopAtr} ATR 不做` : '旧口径'};止盈 ${targets.length ? `${targets.length} 档` : '不设价位'}`, geometry),
    slice('risk', '风控:仓位与杠杆', `${market === 'perp' ? '永续' : '现货'} ${leverage} 倍,上限 ${BINDING_LEVERAGE_CAP} 倍`, risk),
    slice('holding', '持仓:代码管仓', `${trail ? '追踪止损' : '无追踪'}${signalExits.length ? ` + ${signalExits.length} 条信号离场` : ''};模型不管仓`, holding),
    slice('execution', '执行:下单方式', resolved.entry.type === 'limit' ? `限价,${resolved.entry.expiry_bars} 根时效` : '下一根开盘市价', execution),
  ];

  const body: Omit<StrategyBinding, 'compiled_at' | 'content_hash'> = {
    schema_version: BINDING_SCHEMA_VERSION,
    compiler_version: BINDING_COMPILER_VERSION,
    strategy_id: input.strategy_id,
    version: input.version,
    ir_hash: hash(ir),
    libs: { primitive_registry: registryFingerprint(), order_gate: structureGate ? 'structure' : 'legacy', strategy_spec: STRATEGY_SPEC_VERSION, horizon_policy: 'horizon/v1' },
    horizon,
    timeframe,
    confirm_timeframe: confirm,
    symbol: input.symbol,
    market,
    direction,
    trigger: { primitives: ir.signal, regime: ir.regime ?? null, short_primitives: resolved.short_signal ?? [], short_regime: resolved.short_regime, eval_on: 'bar_close', cooldown_bars: null },
    evidence_plan: evidence,
    entry: { type: resolved.entry.type, price: resolved.entry.type === 'limit' ? resolved.entry.price : null, expiry_bars: resolved.entry.type === 'limit' ? resolved.entry.expiry_bars : null, on_new_signal: resolved.on_new_signal, max_adds: resolved.max_adds, chase_atr_max: null },
    stop: { primitive: ir.risk.stop, buffer_atr: stopBuffer, is_invalidation: true, min_stop_atr: structureGate ? minStopAtr! : null },
    targets,
    target_policy,
    trail,
    breakeven_after_tp: resolved.breakeven_after_tp,
    breakeven_after_r: breakevenR ? Number(breakevenR.params.r) : null,
    max_holding_bars: resolved.max_holding_bars,
    signal_exits: signalExits,
    min_rr: minRR,
    risk: { sizing: ir.risk.sizing, leverage, leverage_cap: BINDING_LEVERAGE_CAP, max_risk_fraction: gate.max_risk_fraction },
    model,
    roles,
    unmapped,
    deployable: !unmapped.some((x) => x.severity === 'block'),
    evidence_refs: { report_ids: (input.report_ids ?? []).slice(0, 500) },
  };
  return { ...body, content_hash: hash(body), compiled_at: input.now ?? Date.now() };
}
