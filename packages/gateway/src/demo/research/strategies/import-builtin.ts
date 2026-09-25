/**
 * 五条内置策略(strategies.ts BUILTIN_DEFS,实盘策略库)→ 研究台策略对象(apply-spec §7)。
 *
 * 译法:对照 strategies.ts 里每条的 rules 文本与 params,用研究台现有原语写 StrategyIR;原规则里没有原语能表达的语义
 * 不近似,逐条写进 gaps(= 绑定的 unmapped,source='import')和策略描述。实盘那边仍按旧文本路径跑,这里只是研究侧的译文:
 *   - breakout_retest / mtf_alignment / vol_compression_expansion:能译(方向只译做多一侧,IR 候选 long-only);
 *   - range_mean_reversion:部分可译(回归概率门没有原语);
 *   - funding_oi_extreme:译不了(缺资金费率 / OI 数据原语),只建「规则未编码」草稿,不建版本。
 * 幂等键:origin.source='import' 且 lab_strategy_id=<内置 id>(未归档);重复执行不重复建,IR 变了才加新版本。
 * 这里只写研究台自己的表,不读写实盘策略库(strategies.ts 的 StrategyLibrary)。
 */
import type { BindingUnmapped, StrategyIR, StrategyPrimitive } from '@trading-swarm/contracts';

export type BuiltinTranslation = 'full' | 'partial' | 'none';
export interface BuiltinImportSpec {
  builtin_id: string;
  name: string;
  symbol: string;
  timeframe: string;
  translation: BuiltinTranslation;
  description: string;
  ir: StrategyIR | null;
  gaps: BindingUnmapped[];
}

const node = (primitive: string, params: Record<string, unknown>): StrategyPrimitive => ({ primitive, params });
const gap = (code: string, message: string, severity: BindingUnmapped['severity'] = 'warn', path: string | null = null): BindingUnmapped => ({ code, path, severity, message, source: 'import' });
const SIZING = node('equal_notional', { max_allocation: '1' });
const PIVOT_STOP = node('pivot_stop', { swing_length: 3, buffer_atr: 0.1 });
const PIVOT_TARGET = node('pivot_target', { swing_length: 3 });
const TRAIL = node('chandelier_trail', { atr_period: 22, multiple: 3 });
const EMA20_ABOVE_50 = node('indicator_cross', { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 50 }, direction: 'above' });
const SHORT_SIDE = gap('short_side_dropped', '原策略多空双向;IR 只译了做多一侧(实盘 IR 候选目前 long-only),做空一侧没导入');

function ir(label: string, description: string, body: Omit<StrategyIR, 'version' | 'label' | 'description'>): StrategyIR {
  return { version: 1, label, description, ...body };
}

/** 译文表(顺序即导入顺序);参数取自 strategies.ts BUILTIN_DEFS(breakout_retest 取 v2 草稿的 breakout_window=12 / retest_vol_min=2) */
export const BUILTIN_IMPORTS: BuiltinImportSpec[] = [
  (() => {
    const gaps = [
      gap('retest_confirm_missing', '「回踩确认(收在突破位外侧、量比 ≥ retest_vol_min)→ 市价」没有 retest_confirm 原语。替代:突破那根(收盘破 20 根高点 + 量比 ≥2 + 1h EMA20>EMA50)出信号,限价挂在回踩支撑块上沿(structure_level),12 根(breakout_window)内触价才成交;CandidateV0 影子按下一根开盘市价算候选,不模拟这张限价'),
      gap('chase_atr_max', '「距突破位 > 1.5 ATR 不追」没有原语;限价挂在支撑位上,间接不追高'),
      gap('atr_pct_floor', 'ATR% 下限按分周期表(review-metrics),不在策略参数里,未译'),
      gap('range_vol_min', '「日线 range 时突破要量比 ≥1.5」未译:量比门统一取 2'),
      gap('htf_4h_confidence', '「4h 反向只许限价回踩、信心 ≤0.5」是模型信心口径,IR 用 4h 结构方向门(htf_structure_regime)代替:4h 反向直接不做'),
      gap('reduce_on_weakness', '「浮盈 ≥1R 且结构转弱 REDUCE」没有减仓原语;持仓交给图上止盈 + 吊灯追踪'),
      SHORT_SIDE,
    ];
    const description = '1h 收盘突破此前 20 根高点且量比 ≥2、EMA20 在 EMA50 上方、4h 结构向上时出信号;限价挂在回踩支撑块上沿,12 根内回踩成交,否则撤单。止损放在最近已确认摆动低点下方 0.1 ATR,止盈取上方最近未被扫的摆动高点(图上没有就不设),吊灯线 ATR22×3 追踪。预期持有数小时到两三天;信号频率约每 1000 根 5–20 次(待回测验证)。译自内置策略 breakout_retest;回踩确认用「突破信号 + 限价挂支撑」代替(没有 retest_confirm 原语),未译部分见绑定 unmapped。';
    return {
      builtin_id: 'breakout_retest', name: '突破-回踩(内置译文)', symbol: 'BTCUSDT', timeframe: '1h', translation: 'full' as const, description, gaps,
      ir: ir('突破-回踩(内置译文)', description, {
        signal: [node('donchian_breakout', { lookback: 20, basis: 'close' }), node('volume_surge', { lookback: 20, multiple: 2 }), EMA20_ABOVE_50],
        regime: node('htf_structure_regime', { htf: '4h', swing_length: 3 }),
        entry: node('next_open_market', {}),
        risk: { stop: PIVOT_STOP, sizing: SIZING },
        exit: [PIVOT_TARGET, TRAIL],
        order: { direction: 'long', market: 'perp', leverage: 1, entry: { type: 'limit', price: node('structure_level', { swing_length: 3 }), expiry_bars: 12 }, on_new_signal: { unfilled: 'replace', filled: 'ignore' } },
      }),
    };
  })(),
  (() => {
    const gaps = [
      gap('trigger_tf_5m', '原策略在 5m/15m 触发(horizon=scalp);实盘绑定不接 scalp,译成 15m 触发 + 1h 确认'),
      gap('trigger_any_of', '「突破 / 回踩 / EMA 交叉 任一」:IR 的 signal 是同一根 AND,只保留突破一种触发'),
      gap('veto_4h', '「4h 反向且距 EMA 超 1 ATR 否决」未译:一条 IR 只有一个方向门,已用给 1h 趋势'),
      gap('chase_atr_max', '「距突破位 ≤1.5 ATR 才入场」没有原语'),
      gap('reduce_15m_ema', '「浮盈 ≥1R 且 15m 收在 EMA20 另一侧 REDUCE」没有减仓原语'),
      SHORT_SIDE,
    ];
    const description = '15m 收盘突破此前 20 根高点、15m EMA20 在 EMA50 上方、1h 趋势(EMA20/50 + ADX)向上时下一根开盘做多;止损放在最近摆动低点下方 0.1 ATR,止盈取上方最近未被扫的摆动高点,1h 收盘跌破 EMA50 或 1h 趋势转下离场。预期持有数小时;信号频率约每 1000 根 10–30 次(待回测验证)。译自内置策略 mtf_alignment,原 5m 触发改为 15m,未译部分见绑定 unmapped。';
    return {
      builtin_id: 'mtf_alignment', name: '多周期对齐(内置译文)', symbol: 'BTCUSDT', timeframe: '15m', translation: 'full' as const, description, gaps,
      ir: ir('多周期对齐(内置译文)', description, {
        signal: [node('donchian_breakout', { lookback: 20, basis: 'close' }), EMA20_ABOVE_50],
        regime: node('trend_state', { adx_period: 14, adx_min: 15, ema_fast: 20, ema_slow: 50, htf: '1h' }),
        entry: node('next_open_market', {}),
        risk: { stop: PIVOT_STOP, sizing: SIZING },
        exit: [PIVOT_TARGET, node('trend_break', { ema_period: 50, htf: '1h' })],
        order: { direction: 'long', market: 'perp', leverage: 1, entry: { type: 'market' } },
      }),
    };
  })(),
  (() => {
    const gaps = [
      gap('bb_width_rank', '「带宽 90 根分位 ≤20% 或 squeeze 连续 ≥6 根」没有分位/连续根数原语:用「布林上轨仍在肯特纳上轨之下(squeeze 未解除)」在扩张那根判压缩'),
      gap('first_expansion_only', '「只做压缩后第一次扩张」未译:上升沿去重只保证连续触发算一次'),
      gap('revert_bars', '「2 根内收回压缩区间且量比 <1 失效」没有原语;失效用回到布林中轨离场代替'),
      gap('chase_atr_max', '「已走出 1.5 ATR 不追」没有原语'),
      gap('reduce_vol_fade', '「浮盈 ≥1.5R 且量比 <1 REDUCE」没有减仓原语'),
      SHORT_SIDE,
    ];
    const description = '1h 收盘突破此前 20 根高点、量比 ≥1.8,且布林上轨(20,2)仍低于肯特纳上轨(20,1.5)——压缩还没解除的第一根扩张——下一根开盘做多;止损放在 20 根最低价(压缩区间另一端),收盘跌回布林中轨离场,吊灯线 ATR22×3 追踪。预期持有一到几天,靠少数大赢家;信号频率约每 1000 根 1–5 次(待回测验证)。译自内置策略 vol_compression_expansion,未译部分见绑定 unmapped。';
    return {
      builtin_id: 'vol_compression_expansion', name: '波动压缩→扩张(内置译文)', symbol: 'BTCUSDT', timeframe: '1h', translation: 'full' as const, description, gaps,
      ir: ir('波动压缩→扩张(内置译文)', description, {
        signal: [
          node('donchian_breakout', { lookback: 20, basis: 'close' }),
          node('volume_surge', { lookback: 20, multiple: 1.8 }),
          node('indicator_cross', { indicator: 'bbands', args: { period: 20, multiple: 2 }, output: 'upper', compare_to: 'indicator', compare_indicator: 'keltner', compare_args: { period: 20, multiple: 1.5 }, compare_output: 'upper', direction: 'below' }),
        ],
        entry: node('next_open_market', {}),
        risk: { stop: node('swing_low_stop', { lookback: 20 }), sizing: SIZING },
        exit: [node('indicator_cross_exit', { indicator: 'price', compare_to: 'indicator', compare_indicator: 'bbands', compare_args: { period: 20, multiple: 2 }, compare_output: 'middle', direction: 'cross_below' }), TRAIL],
        order: { direction: 'long', market: 'perp', leverage: 1, entry: { type: 'market' } },
      }),
    };
  })(),
  (() => {
    const gaps = [
      gap('reversion_stats', '「历史回归比例 < 55% 不做」(reversionStats 回归概率门)没有原语,未译', 'warn', 'signal'),
      gap('daily_range', '「日线 range」判定未译,只用本周期 ADX14 < 20 判震荡'),
      gap('invalidation_deviation', '「收盘再偏离 0.5 ATR 失效」没有原语;失效用止损(再偏离 1 ATR)与 ADX 升破 25 离场代替'),
      gap('vwap_target', '「目标 EMA20/VWAP」只译了 EMA20'),
      gap('reduce_half_way', '「浮盈 ≥1R 且走完一半 REDUCE」没有减仓原语'),
      SHORT_SIDE,
    ];
    const description = '1h 震荡(ADX14 < 20)时,收盘价低于肯特纳下轨(EMA20 − 2×ATR,即偏离 EMA20 ≥2 ATR)下一根开盘做多;止损放在收盘价下方 1 ATR,止盈挂在 EMA20,ADX 升破 25 或持有满 24 根离场。预期持有数小时到一天;信号频率约每 1000 根 5–15 次(待回测验证)。译自内置策略 range_mean_reversion,**部分可译**:回归概率门(reversionStats)没有原语,未译部分见绑定 unmapped。';
    return {
      builtin_id: 'range_mean_reversion', name: '区间均值回归(内置部分译文)', symbol: 'BTCUSDT', timeframe: '1h', translation: 'partial' as const, description, gaps,
      ir: ir('区间均值回归(内置部分译文)', description, {
        signal: [
          node('indicator_threshold', { indicator: 'adx', args: { period: 14 }, operator: 'below', threshold: 20 }),
          node('indicator_cross', { indicator: 'price', compare_to: 'indicator', compare_indicator: 'keltner', compare_args: { period: 20, multiple: 2 }, compare_output: 'lower', direction: 'below' }),
        ],
        entry: node('next_open_market', {}),
        risk: { stop: node('atr_stop', { atr_period: 14, multiple: 1 }), sizing: SIZING },
        exit: [node('indicator_threshold_exit', { indicator: 'adx', args: { period: 14 }, operator: 'cross_above', threshold: 25 }), { primitive: 'time_stop', params: { bars: 24 }, optional: true }],
        order: { direction: 'long', market: 'perp', leverage: 1, entry: { type: 'market' }, take_profits: [{ source: node('indicator_level', { indicator: 'ema', args: { period: 20 } }) }], max_holding_bars: 24 },
      }),
    };
  })(),
  {
    builtin_id: 'funding_oi_extreme',
    name: '资金费率/OI 极值(规则未编码)',
    symbol: 'BTCUSDT',
    timeframe: '1h',
    translation: 'none',
    description: '规则未编码的草稿:内置策略 funding_oi_extreme 依赖资金费率与持仓量(OI),研究台原语库还没有这两类数据的原语,没法写成 StrategyIR,也就没有版本、不能回测、不能下发。缺:① funding_zscore(|费率| ≥0.05% 且 30 天 z ≥2)原语,需要 data/perp-market.ts 的资金费序列接进原语上下文;② oi_change(OI 1h 变化 ≥1%)原语,需要 OI 历史数据 adapter;③ 距资金费结算 30 分钟内不开新仓的时间窗原语。原规则:正极值 + OI 降做空、负极值 + OI 降做多;极值但 OI 仍升且 1h/4h 同向只许顺势限价挂回踩。',
    ir: null,
    gaps: [
      gap('funding_primitive_missing', '缺资金费率极值原语(费率绝对值 + 30 天 z-score)', 'block', 'signal'),
      gap('oi_primitive_missing', '缺持仓量(OI)变化原语与 OI 历史数据 adapter', 'block', 'signal'),
      gap('funding_window_missing', '缺「距资金费结算 N 分钟内不开新仓」时间窗原语', 'block', 'entry'),
    ],
  },
];

export const BUILTIN_IMPORT_IDS = BUILTIN_IMPORTS.map((x) => x.builtin_id);
export const builtinImportSpec = (id: string | null | undefined) => (id ? BUILTIN_IMPORTS.find((x) => x.builtin_id === id) ?? null : null);
