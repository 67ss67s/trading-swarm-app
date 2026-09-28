/**
 * 策略规范(Strategy Spec)——每个会产出/修改策略的 agent 都必须遵守的同一份规则,2026-09-22。
 *
 * 为什么要单独一个模块:此前成本下限、最小盈亏比、ATR 尺度这些数字只喂给了 compile 这一个 agent;
 * B 臂代理出 proposal 时完全不知道成本,止损事后被 order-gate 放宽;C 臂和研究对话代理没有任何策略规范。
 * 结果就是「模型在出策略时就把止盈止损放到合理点位」只在编译期成立。这里把规范做成一份代码:
 *   - specText(constraints, role):给模型看的中文规范,按本数据集的具体数字实例化,按角色附加义务;
 *   - checkIRSpec(ir, constraints):对 StrategyIR 的校验,给 compile / 研究代理起草候选用;
 *   - checkProposalSpec(entry, price, costs, gate):对代理 proposal(B 臂)的校验,结果记进 decision.spec_violations。
 * 规范只做判断和文字,不改数据、不调模型;与 order-gate 的关系:order-gate 是执行期兜底(先放置再判定),
 * 规范是设计期约束(策略/proposal 本来就该满足)。违反 warn 只记录;违反 block 的 IR 不允许发起实验。
 */
import type { StrategyIR, StrategyCompileResult, StrategySpecReport, OrderGateParams, ResearchEntry } from '@trade-gate/contracts';
import { roundTripCostPct, stopFloorPct } from './order-gate.js';
/** v2(2026-09-23 结构口径):止盈止损按图上结构放、盈亏比不拦单、止损太近不做、止盈不能按 R 倍数倒推。新 run 冻结 v2;
 * 规范正文按 constraints 选口径(有 min_stop_atr = v2),旧 manifest 的 gate 没有这个字段,重建出来的仍是 v1 原文。 */
export const STRATEGY_SPEC_VERSION = 'strategy-spec/v2';
export const STRATEGY_SPEC_VERSION_V1 = 'strategy-spec/v1';
const isV2 = (c: SpecConstraints) => typeof c.min_stop_atr === 'number';
const versionOf = (c: SpecConstraints) => (isV2(c) ? STRATEGY_SPEC_VERSION : STRATEGY_SPEC_VERSION_V1);
export type SpecRole = 'compile' | 'b_agent' | 'c_filter' | 'research_agent';
export type SpecConstraints = NonNullable<StrategyCompileResult['constraints']>;
type Violation = StrategySpecReport['violations'][number];
const pct = (v: number | null | undefined, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '未知');
/** 样本纪律:候选/交易少于这个数不允许宣称策略有效(与 precheck 默认 min_trades 一致)。 */
export const SPEC_MIN_TRADES = 30;
/** 通用条款 + 角色义务。每条都能对应到 checkIRSpec / checkProposalSpec / order-gate / precheck 里的一个检查,不写空话。 */
export function specText(c: SpecConstraints, role: SpecRole): string {
  if (isV2(c)) return specTextV2(c, role);
  const scale = c.symbol ? `${c.symbol} ${c.timeframe}` : c.timeframe;
  const common = [
    `【策略规范 ${STRATEGY_SPEC_VERSION_V1} · ${scale}】`,
    `1. 成本:往返成本 ${pct(c.round_trip_cost_pct)};止损距离不得窄于成本下限 ${pct(c.stop_floor_pct)}(代码会把更窄的止损放宽到下限并标 cost_floor,那不是策略的功劳)。`,
    `2. 盈亏比:止盈必须有独立来源(上方阻力块下沿 structure_target,或用户明确要求的固定 R),放置后 RR ≥ ${c.min_rr};结构没给空间的位置策略应主动放弃,不是靠事后拦截。`,
    c.atr_pct_median !== null ? `3. 尺度:本数据集 ATR(14) 中位 ${pct(c.atr_pct_median)},ATR 止损倍数不得低于 ${c.min_atr_multiple!.toFixed(1)};低于它等于用成本级别的止损,请改结构位止损或更高周期。` : `3. 尺度:未提供数据集,ATR 倍数下限未知;发起实验前必须带 dataset_id 重新编译核对。`,
    `4. 方向:优先加 htf_structure_regime 作为 regime,让已收盘的高周期结构决定方向,小周期只在允许的方向和位置交易。`,
    `5. 样本:少于 ${SPEC_MIN_TRADES} 个候选/交易不宣称策略有效;零交易只说明规则没触发,不是高胜率;completed 只表示算完了。`,
    `6. 描述:description 必须写预期持有期(根/小时/天)和每 1000 根的信号频率量级,未测量就写明是待验证假设。`,
  ];
  const role_text: Record<SpecRole, string[]> = {
    compile: [
      `【编译义务】止损来源优先结构位(order_blocks / swing / htf_structure),用 atr_stop 时倍数按第 3 条;fixed_r_target 的 r 不得低于 ${c.min_rr};追踪出场不替代止盈;不能映射的语义如实写进 unmapped。`,
    ],
    b_agent: [
      `【代理判断义务】PROPOSE 时 stop_price 与收盘价的距离必须 ≥ ${pct(c.stop_floor_pct)},take_profit_price 必须给出且 (目标-入场)/(入场-止损) ≥ ${c.min_rr};止损优先放在结构位(证据里的 order_blocks / htf_structure),止盈放在上方阻力块下沿。达不到就 NO_TRADE 并在 thesis 里说明是「结构没空间」还是「止损会被放宽」。不要给会被放宽到下限的止损。`,
    ],
    c_filter: [
      `【筛选义务】只按冻结规则与候选证据答 follow/skip。候选 fit.stop_source=cost_floor 说明策略止损在本周期不起作用,fit.rr 低于 ${c.min_rr} 或 target 为空时应 skip;理由只谈策略规则与结构位置,不谈外部消息。`,
    ],
    research_agent: [
      `【研究代理义务】起草候选(policy.draft / experiments.run_candidate)前先用 strategies.compile 带 dataset_id 编译并读 spec.violations,有 block 不得发起;一轮最多改两个经济参数;不按 holdout 调参;报告按「观察(可引用数值)→假设(注明样本)→验证(只变一个条件、同窗口对照)」三段写,样本不足只写观察不下结论。`,
    ],
  };
  return [...common, ...role_text[role]].join('\n');
}
/** v2 规范正文(结构口径)。每条都对应一处代码:order-gate stop_too_close、orders/intents 缺省止盈、repairIR/dropUnrequestedFixedR、checkIRSpec。 */
function specTextV2(c: SpecConstraints, role: SpecRole): string {
  const scale = c.symbol ? `${c.symbol} ${c.timeframe}` : c.timeframe, k = c.min_stop_atr!;
  const common = [
    `【策略规范 ${STRATEGY_SPEC_VERSION} · ${scale}】`,
    `1. 止损:放在图上的结构位——最近已确认的摆动低点/订单块下沿,再往外让一点缓冲(缺省 0.1 ATR);空单镜像。止损离入场不到 ${k}×ATR(14) 的单子直接不做,代码不会替策略把止损挪远(挪远会让止损率翻倍)。`,
    `2. 止盈:必须是图上有的价位——前高/摆动高点/等高点/未扫流动性/结构阻力,或用户指定的指标线;不能用「1.5 倍 / 2R」这类 R 倍数倒推(fixed_r_target 只在用户原话要求时用)。图上找不到目标(创新高、上方没有结构)就不设止盈,持仓交给吊灯线等追踪止损;用户给了信号离场(死叉离场等)的策略不补止盈。`,
    `3. 盈亏比:用真正会让单子死的那条线(初始止损)计算并展示,不作为拦单门槛;只有用户原话硬约束(order.min_rr)时才拦。`,
    `4. 成本:往返成本 ${pct(c.round_trip_cost_pct)},按实际计入收益;不再把止损放宽到成本下限。` + (c.atr_pct_median !== null ? `本数据集 ATR(14) 中位 ${pct(c.atr_pct_median)},最近允许的止损约 ${pct(k * c.atr_pct_median)}。` : `未提供数据集,ATR 尺度未知;发起实验前带 dataset_id 重新编译核对。`),
    `5. 持仓:追踪止损(吊灯线 ATR(22)×3 等)由代码按收盘逐根只收紧,是否追踪逐策略可配(IR 里去掉 chandelier_trail 即关)。`,
    `6. 方向:优先加 htf_structure_regime 作为 regime,让已收盘的高周期结构决定方向,小周期只在允许的方向和位置交易。`,
    `7. 样本:少于 ${SPEC_MIN_TRADES} 个候选/交易不宣称策略有效;零交易只说明规则没触发,不是高胜率;completed 只表示算完了。`,
    `8. 描述:description 必须写预期持有期(根/小时/天)和每 1000 根的信号频率量级,未测量就写明是待验证假设。`,
  ];
  const role_text: Record<SpecRole, string[]> = {
    compile: [`【编译义务】用户没说止损止盈时:止损 pivot_stop、止盈 pivot_target、持仓 chandelier_trail;用户说了就只放用户说的;用 atr_stop 时倍数不得低于 ${k};仓位缺省每笔 100% 可用资金(equal_notional),用户说了波动率目标才用 vol_target(每笔 × min(1, 目标年化波动/入场前实现波动),规范允许,不算违规),没说不加;不能映射的语义如实写进 unmapped。`],
    b_agent: [`【代理判断义务】PROPOSE 时 stop_price 放在证据里的结构位(摆动低点/订单块/htf_structure)外侧,离收盘不到 ${k}×ATR 就 NO_TRADE(不要把止损挪远凑距离);take_profit_price 取图上的前高/阻力位,图上没有就给 null(由追踪止损管),不要按 R 倍数倒推;盈亏比只作说明,不是开仓条件。`],
    c_filter: [`【筛选义务】只按冻结规则与候选证据答 follow/skip。止损离收盘不到 ${k}×ATR 的候选应 skip;盈亏比低、target 为空都不是 skip 的理由(图上没目标时由追踪止损管);理由只谈策略规则与结构位置,不谈外部消息。`],
    research_agent: [`【研究代理义务】起草候选(policy.draft / experiments.run_candidate)前先用 strategies.compile 带 dataset_id 编译并读 spec.violations,有 block 不得发起;一轮最多改两个经济参数;不按 holdout 调参;报告按「观察(可引用数值)→假设(注明样本)→验证(只变一个条件、同窗口对照)」三段写,样本不足只写观察不下结论。`],
  };
  return [...common, ...role_text[role]].join('\n');
}
// trend_break/time_stop 是默认模板也会用的通用出场,不算「用户指定的止盈方式」
const SIGNAL_EXITS = new Set(['macd_divergence_exit', 'indicator_cross_exit', 'indicator_threshold_exit', 'indicator_divergence_exit', 'pine_series_exit']);
/** 用户指定的信号离场(死叉离场/跌破均线/顶背离/持有 N 根…);有它时编译补全不再塞止盈与追踪出场 */
/** 规范允许的仓位原语(2026-09-23 晚加入 vol_target);状态机检查已要求 risk.sizing 属于 sizing 类,这里给编译/改进环一个显式白名单 */
export const SPEC_SIZING_PRIMITIVES = ['equal_notional', 'risk_fraction', 'vol_target'] as const;
export const hasSignalExit = (exits: { primitive: string }[]) => exits.some((x) => SIGNAL_EXITS.has(x.primitive) || /_exit$/.test(x.primitive));
/** 对 StrategyIR 的规范校验。block 的含义是「这条策略在本数据集上大概率只是在跑成本」,不允许发起实验;warn 只提示。 */
export function checkIRSpec(ir: StrategyIR | null, c: SpecConstraints): StrategySpecReport {
  const violations: Violation[] = [];
  const add = (code: string, severity: Violation['severity'], message: string, field?: string) => violations.push({ code, severity, message, ...(field ? { field } : {}) });
  if (!ir) return { version: versionOf(c), ok: false, violations: [{ code: 'ir_missing', severity: 'block', message: 'IR 不存在,无法校验' }], text: specText(c, 'compile') };
  if (isV2(c)) return checkIRSpecV2(ir, c);
  const stop = ir.risk?.stop, exits = ir.exit ?? [];
  if (!stop) add('stop_source_missing', 'block', '必须声明初始止损来源', 'risk.stop');
  else if (stop.primitive === 'no_stop') add('stop_disabled_by_user', 'warn', '用户明确要求不设止损:回撤只由离场信号控制', 'risk.stop');
  const fixed = exits.filter((x) => x.primitive === 'fixed_r_target').map((x) => Number(x.params.r)).filter(Number.isFinite);
  const structural = exits.some((x) => x.primitive === 'structure_target') || !!ir.order?.take_profits?.length;
  if (ir.order?.min_rr !== undefined && ir.order.min_rr < c.min_rr) add('order_min_rr_below_spec', 'warn', `订单块最小盈亏比 ${ir.order.min_rr} 低于规范 ${c.min_rr}(按用户硬约束执行)`, 'order.min_rr');
  // 用户指定的指标/信号离场(死叉离场、跌破均线、顶背离、持有 N 根…)本身就是用户定义的「止盈」方式(2026-09-23 Jacky:止盈止损可能靠指标决定);
  // 这类策略没有价位止盈,盈亏比门不适用,只 warn。追踪出场(chandelier)仍不能单独替代止盈。
  const signalExit = hasSignalExit(exits);
  if (!fixed.length && !structural && signalExit) add('target_by_signal_exit', 'warn', '止盈由用户指定的信号离场决定,没有价位止盈,最小盈亏比不适用', 'exit');
  else if (!fixed.length && !structural) add('target_source_missing', 'block', '必须声明独立止盈来源(structure_target 或 fixed_r_target),或用户明确的信号离场;追踪出场不能替代止盈', 'exit');
  if (fixed.length && Math.min(...fixed) < c.min_rr) add('fixed_r_below_min_rr', 'block', `固定 R 目标 ${Math.min(...fixed)} 低于最小盈亏比 ${c.min_rr}`, 'exit.fixed_r_target.r');
  if (stop?.primitive === 'atr_stop') {
    const multiple = Number(stop.params.multiple);
    if (c.min_atr_multiple !== null && Number.isFinite(multiple) && multiple < c.min_atr_multiple) {
      // 有实测放宽比例时以它为准(ATR 随时间变化,倍数只是均值判断);没有就按倍数直接判。
      if (c.stop_fit_rate === null) add('atr_multiple_below_floor', 'block', `ATR 止损倍数 ${multiple} 低于本数据集下限 ${c.min_atr_multiple.toFixed(1)}(止损会落在成本级别)`, 'risk.stop.params.multiple');
      else add('atr_multiple_below_floor', 'warn', `ATR 止损倍数 ${multiple} 低于本数据集下限 ${c.min_atr_multiple.toFixed(1)};实测 ${Math.round(c.stop_fit_rate * 100)}% 的候选止损会被放宽`, 'risk.stop.params.multiple');
    }
  }
  if (c.stop_fit_rate !== null && c.stop_fit_rate > 0.5) add('stop_mostly_widened', 'block', `${Math.round(c.stop_fit_rate * 100)}% 的候选止损会被放宽到成本下限:策略自己的止损在 ${c.timeframe} 上几乎不起作用,改结构位止损或更高周期`, 'risk.stop');
  if (c.atr_pct_median !== null && c.atr_pct_median > 0 && c.stop_floor_pct / c.atr_pct_median > 4) add('timeframe_cost_heavy', 'warn', `成本下限是 ATR 中位的 ${(c.stop_floor_pct / c.atr_pct_median).toFixed(1)} 倍:${c.timeframe} 上成本占波动太大,建议更高周期`);
  if (!ir.regime) add('regime_missing', 'warn', '没有 regime(方向门);建议 htf_structure_regime 让高周期结构决定方向', 'regime');
  const desc = ir.description ?? '';
  if (!/持有|根|小时|天|bar|hour|day/i.test(desc)) add('description_missing_holding_period', 'warn', 'description 未写预期持有期', 'description');
  if (!/频率|每\s*1000|信号|signal|frequency/i.test(desc)) add('description_missing_signal_frequency', 'warn', 'description 未写每 1000 根的信号频率量级', 'description');
  return { version: STRATEGY_SPEC_VERSION_V1, ok: !violations.some((v) => v.severity === 'block'), violations, text: specText(c, 'compile') };
}
const TRACKERS = ['chandelier_trail', 'swing_structure_stop', 'trend_break', 'breakeven_after_r'];
/** v2 校验:盈亏比与「必须有独立止盈」不再 block;R 倍数倒推的止盈、ATR 止损低于「太近不做」倍数、没有任何离场手段才是问题。 */
function checkIRSpecV2(ir: StrategyIR, c: SpecConstraints): StrategySpecReport {
  const violations: Violation[] = [], k = c.min_stop_atr!;
  const add = (code: string, severity: Violation['severity'], message: string, field?: string) => violations.push({ code, severity, message, ...(field ? { field } : {}) });
  const stop = ir.risk?.stop, exits = ir.exit ?? [], tps = ir.order?.take_profits ?? [];
  if (!stop) add('stop_source_missing', 'block', '必须声明初始止损来源', 'risk.stop');
  else if (stop.primitive === 'no_stop') add('stop_disabled_by_user', 'warn', '用户明确要求不设止损:回撤只由离场信号控制', 'risk.stop');
  const fixed = exits.some((x) => x.primitive === 'fixed_r_target') || tps.some((t) => t.source.primitive === 'fixed_r_target');
  if (fixed) add('target_is_r_multiple', 'warn', '止盈是按 R 倍数倒推的数(fixed_r_target),不是图上的价位;只在用户原话要求时允许', 'exit.fixed_r_target');
  const chartTarget = exits.some((x) => ['structure_target', 'pivot_target'].includes(x.primitive)) || tps.some((t) => t.source.primitive !== 'fixed_r_target');
  const signalExit = hasSignalExit(exits), tracked = exits.some((x) => TRACKERS.includes(x.primitive));
  if (!fixed && !chartTarget && signalExit) add('target_by_signal_exit', 'warn', '止盈由用户指定的信号离场决定,不补价位止盈', 'exit');
  else if (!fixed && !chartTarget && tracked) add('target_by_trail', 'warn', '没有图上止盈来源:持仓全部交给追踪止损', 'exit');
  else if (!fixed && !chartTarget && !ir.order) add('exit_missing', 'block', '除了初始止损没有任何离场手段:至少要有图上止盈、追踪止损或用户的信号离场之一', 'exit');
  if (ir.order?.min_rr !== undefined) add('order_min_rr_user', 'warn', `用户硬约束盈亏比 ≥ ${ir.order.min_rr}:达不到(或算不出止盈)的信号不下单`, 'order.min_rr');
  if (stop?.primitive === 'atr_stop') {
    const multiple = Number(stop.params.multiple);
    if (Number.isFinite(multiple) && multiple < k) add('atr_stop_below_min_stop_atr', 'block', `ATR 止损倍数 ${multiple} 低于「止损太近不做」的 ${k} 倍:几乎每个信号都会因止损太近不做`, 'risk.stop.params.multiple');
  }
  if (c.stop_too_close_rate != null && c.stop_too_close_rate > 0.5) add('stop_mostly_too_close', 'warn', `${Math.round(c.stop_too_close_rate * 100)}% 的信号止损离入场不到 ${k}×ATR,会不做:止损结构位贴得太近,换更远的结构位或更高周期`, 'risk.stop');
  if (c.atr_pct_median !== null && c.atr_pct_median > 0 && c.round_trip_cost_pct > k * c.atr_pct_median) add('timeframe_cost_heavy', 'warn', `往返成本 ${pct(c.round_trip_cost_pct)} 超过最近允许止损(${k}×ATR ≈ ${pct(k * c.atr_pct_median)}):${c.timeframe} 上成本占波动太大,建议更高周期`);
  if (!ir.regime) add('regime_missing', 'warn', '没有 regime(方向门);建议 htf_structure_regime 让高周期结构决定方向', 'regime');
  const desc = ir.description ?? '';
  if (!/持有|根|小时|天|bar|hour|day/i.test(desc)) add('description_missing_holding_period', 'warn', 'description 未写预期持有期', 'description');
  if (!/频率|每\s*1000|信号|signal|frequency/i.test(desc)) add('description_missing_signal_frequency', 'warn', 'description 未写每 1000 根的信号频率量级', 'description');
  return { version: STRATEGY_SPEC_VERSION, ok: !violations.some((v) => v.severity === 'block'), violations, text: specText(c, 'compile') };
}
/** 代理 proposal(放置前的原始 stop/target)对规范的违反;只返回 code,记进 decision.spec_violations。 */
export function checkProposalSpec(entry: Pick<ResearchEntry, 'stop' | 'target'>, price: string, costs: { fee_rate: string; slippage_bps: string }, gate: OrderGateParams): string[] {
  const out: string[] = [];
  const p = Number(price), s = Number(entry.stop), t = entry.target === null || entry.target === undefined ? null : Number(entry.target);
  if (!(p > 0) || !Number.isFinite(s)) return ['proposal_unparseable'];
  if (!(s > 0 && s < p)) return ['proposal_stop_side'];
  const dist = (p - s) / p, floor = stopFloorPct(costs, gate);
  if (dist < floor) out.push('proposal_stop_below_cost_floor');
  if (dist < 2 * roundTripCostPct(costs)) out.push('proposal_stop_below_2x_cost');
  if (t === null) out.push('proposal_no_target');
  else if (!(t > p)) out.push('proposal_target_side');
  else if ((t - p) / (p - s) < gate.min_rr) out.push('proposal_rr_below_min');
  return [...new Set(out)];
}
