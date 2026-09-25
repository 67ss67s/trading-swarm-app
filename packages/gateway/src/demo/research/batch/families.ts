/**
 * 批量研究的策略族与标准参数(设计见 docs/research/batch-study-2026-09-23.md 第四节)。
 * 单资产族全部写成带 order 块的 StrategyIR(订单周期执行核,与全窗口报告同一撮合口径);
 *   现货 market=spot 只做多;永续 market=perp、1 倍杠杆,多空各一套,空头的信号/价位按做空语义显式写出(执行核不替我们镜像指标条件)。
 * 组合族(横截面动量、资金费套利)是 research-batch.json 的组合级原语节点,不是 IR。
 * 参数按根数给,四个周期共用;每族 2–4 组,不做网格。变体 id 稳定(族/参数/市场/方向/周期),重跑逐位一致。
 */
import type { StrategyIR, StrategyPrimitive } from '@trading-swarm/contracts';
import { node } from '../strategy.js';
import type { CarryParams } from '../primitives/portfolio-carry.js';
import type { XsmomParams } from '../primitives/portfolio-xsmom.js';

export type FamilyKey = 'breakout' | 'ma_trend' | 'ema_cross' | 'pullback' | 'mean_reversion' | 'smc' | 'xsmom' | 'carry';
export const FAMILY_LABEL: Record<FamilyKey, string> = { breakout: '趋势突破', ma_trend: '均线趋势+波动率目标', ema_cross: '均线金叉纯信号离场', pullback: '回踩均线限价', mean_reversion: '震荡均值回归', smc: 'SMC 结构', xsmom: '横截面动量', carry: '资金费套利' };
export type Market = 'spot' | 'perp';
export type Side = 'long' | 'short';
/** 波动率目标仓位(批量层按单笔缩放,见 evaluate.ts volTargetEquity) */
export interface VolTarget { annual: number; days: number }
export interface IrVariant { kind: 'ir'; id: string; family: FamilyKey; param: string; market: Market; side: Side; timeframe: string; ir: StrategyIR; vol_target?: VolTarget }
export type PortfolioNode = { primitive: 'portfolio_xsmom'; params: XsmomParams } | { primitive: 'portfolio_carry'; params: CarryParams };
export interface PortfolioVariant { kind: 'portfolio'; id: string; family: 'xsmom' | 'carry'; param: string; market: Market; side: 'long' | 'long_short' | 'neutral'; timeframe: string; node: PortfolioNode }
export type Variant = IrVariant | PortfolioVariant;

const ind = (indicator: string, args: Record<string, number>, output?: string) => ({ indicator, args, ...(output ? { output } : {}) });
const sizing = node('equal_notional', { max_allocation: '1' });
const market = node('next_open_market', {});
/** 「不设止盈」的远端兜底:执行核要求至少一档止盈,50R 在实际行情里等于不会触发;min_rr=0 不拦单 */
type TakeProfits = NonNullable<NonNullable<StrategyIR['order']>['take_profits']>;
const tp1 = (source: StrategyPrimitive): TakeProfits => [{ source }];
const FAR_TP = tp1(node('fixed_r_target', { r: 50 }));
/** 时间止损在 checkIR 里必须 optional(执行核仍按 order.max_holding_bars / time_stop 的根数出场) */
const timeStop = (bars: number) => node('time_stop', { bars }, true);
const htfOf = (tf: string) => (tf === '1d' ? '7d' : tf === '4h' ? '1d' : tf === '1h' ? '1d' : '4h');

function ir(label: string, description: string, parts: Omit<StrategyIR, 'version' | 'label' | 'description' | 'entry' | 'risk'> & { stop: StrategyPrimitive; entry?: StrategyPrimitive }): StrategyIR {
  const { stop, entry, ...rest } = parts;
  return { version: 1, label: label.slice(0, 160), description, entry: entry ?? market, risk: { stop, sizing }, ...rest };
}
const tag = (m: Market, s: Side) => (m === 'spot' ? '现货多' : s === 'long' ? '永续多' : '永续空');
const orderOf = (m: Market, s: Side, extra: Partial<NonNullable<StrategyIR['order']>> = {}): NonNullable<StrategyIR['order']> => ({ direction: s, market: m, ...(m === 'perp' ? { leverage: 1 } : {}), ...extra });

/** 单资产族在一个 (市场, 方向, 周期) 上的全部标准参数变体 */
export function irVariants(m: Market, s: Side, tf: string): IrVariant[] {
  if (m === 'spot' && s === 'short') return [];
  const out: IrVariant[] = [], L = s === 'long', mk = (family: FamilyKey, param: string, x: StrategyIR, vol_target?: VolTarget) => out.push({ kind: 'ir', id: `${family}:${param}:${m}:${s}:${tf}`, family, param, market: m, side: s, timeframe: tf, ir: { ...x, label: `batch·${FAMILY_LABEL[family]} ${param} ${tag(m, s)} ${tf}` }, ...(vol_target ? { vol_target } : {}) });
  // 1) 趋势突破:唐奇安 + ATR 初始止损 + 吊灯追踪,不设止盈;持仓中同向新信号忽略
  for (const [look, trail] of [[20, 3], [55, 3], [20, 2]] as const) {
    mk('breakout', `dc${look}_ch${trail}`, ir('', `唐奇安 ${look} 根收盘${L ? '突破' : '跌破'},ATR(14)×2 初始止损,吊灯 ATR(22)×${trail} 追踪,不设止盈`, {
      signal: [node('donchian_breakout', { lookback: look, basis: 'close', ...(L ? {} : { direction: 'down' }) })], stop: node('atr_stop', { atr_period: 14, multiple: 2 }),
      exit: [node('chandelier_trail', { atr_period: 22, multiple: trail })], order: orderOf(m, s, { take_profits: FAR_TP, min_rr: 0, on_new_signal: { unfilled: 'replace', filled: 'ignore' } }),
    }));
  }
  // 2) 均线趋势:快线在慢线之上(上升沿入场),快线穿回离场,ATR×3 灾难止损;仓位按 50% 年化波动目标缩放
  for (const [f, sl] of [[20, 100], [50, 200], [10, 50]] as const) {
    mk('ma_trend', `ema${f}_${sl}_vt`, ir('', `EMA${f} ${L ? '在' : '跌到'} EMA${sl} ${L ? '上方' : '下方'}入场,反穿离场,ATR×3 灾难止损,50% 年化波动目标仓位`, {
      signal: [node('indicator_cross', { indicator: 'ema', args: { period: f }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: sl }, direction: L ? 'above' : 'below' })],
      stop: node('atr_stop', { atr_period: 14, multiple: 3 }),
      exit: [node('indicator_cross_exit', { indicator: 'ema', args: { period: f }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: sl }, direction: L ? 'cross_below' : 'cross_above' })],
      order: orderOf(m, s, { take_profits: FAR_TP, min_rr: 0, on_new_signal: { unfilled: 'replace', filled: 'ignore' } }),
    }), { annual: 0.5, days: 20 });
  }
  // 2b) 均线金叉、死叉离场(纯信号离场:不加追踪、不设止盈、不设止损,每笔 100% 权益)——主线程在 BTC/ETH 日线上看到它明显好于持有,
  //     这里多参数 × 20 币 × 四周期做严格的训练/验证/留出检验,看是不是只在这轮 BTC/ETH 牛市里成立
  for (const [f, sl] of [[10, 30], [20, 50], [50, 200], [10, 50]] as const) {
    const cross = (direction: string) => ({ indicator: 'ema', args: { period: f }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: sl }, direction });
    mk('ema_cross', `ema${f}_${sl}`, ir('', `EMA${f} ${L ? '上穿' : '下穿'} EMA${sl} 入场,反向穿越离场;不加追踪、不设止盈止损,每笔 100% 权益`, {
      // no_stop 只给多头(止损放在收盘价 0.01%);空头用 50×ATR 镜像到上方,同样等于不设止损
      signal: [node('indicator_cross', cross(L ? 'cross_above' : 'cross_below'))], stop: L ? node('no_stop', {}) : node('atr_stop', { atr_period: 14, multiple: 50 }),
      exit: [node('indicator_cross_exit', cross(L ? 'cross_below' : 'cross_above'))],
      order: orderOf(m, s, { take_profits: FAR_TP, min_rr: 0, on_new_signal: { unfilled: 'replace', filled: 'ignore' } }),
    }));
  }
  // 3) 回踩均线限价:EMA20 在 EMA50 上方(空头:下方)时 RSI(14) 跌破(升破)50 触发,限价挂均线,止盈按 R,盈亏比 ≥ 2
  const trend = node('indicator_cross', { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 50 }, direction: L ? 'above' : 'below' });
  const dip = node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: L ? 'below' : 'above', threshold: 50 });
  const pull: [string, StrategyPrimitive, StrategyPrimitive, number][] = [
    ['ema20_stopema50_2r', node('indicator_level', ind('ema', { period: 20 })), node('indicator_level', { ...ind('ema', { period: 50 }), buffer_atr: 0.5 }), 2],
    ['ema20_atr1.5_2.5r', node('indicator_level', ind('ema', { period: 20 })), node('atr_stop', { atr_period: 14, multiple: 1.5 }), 2.5],
    ['ema50_atr2_3r', node('indicator_level', ind('ema', { period: 50 })), node('atr_stop', { atr_period: 14, multiple: 2 }), 3],
  ];
  for (const [param, level, stop, r] of pull) {
    mk('pullback', param, ir('', `趋势中回踩:EMA20 ${L ? '>' : '<'} EMA50 且 RSI14 ${L ? '<' : '>'} 50 触发,限价挂 ${level.params.args ? `EMA${(level.params.args as { period: number }).period}` : ''},止盈 ${r}R,盈亏比 ≥ 2,持仓上限 120 根`, {
      signal: [trend, dip], stop, exit: [timeStop(120)],
      order: orderOf(m, s, { entry: { type: 'limit', price: level }, take_profits: tp1(node('fixed_r_target', { r })), min_rr: 2, on_new_signal: { unfilled: 'replace', filled: 'ignore' }, max_holding_bars: 120 }),
    }));
  }
  // 4) 震荡均值回归:ADX 低时超卖(超买)触发,挂 0.25 ATR 外的 maker 限价,止盈布林中轨
  const adx = (max: number) => node('indicator_threshold', { indicator: 'adx', args: { period: 14 }, operator: 'below', threshold: max });
  const mr: [string, [StrategyPrimitive, ...StrategyPrimitive[]], number, number][] = [
    ['adx20_rsi30', [adx(20), node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: L ? 'cross_below' : 'cross_above', threshold: L ? 30 : 70 })], 2, 30],
    ['adx20_bblower', [adx(20), node('indicator_cross', { indicator: 'price', compare_to: 'indicator', compare_indicator: 'bbands', compare_args: { period: 20, multiple: 2 }, compare_output: L ? 'lower' : 'upper', direction: L ? 'cross_below' : 'cross_above' })], 1.5, 30],
    ['adx25_rsi2', [adx(25), node('indicator_threshold', { indicator: 'rsi', args: { period: 2 }, operator: L ? 'below' : 'above', threshold: L ? 10 : 90 })], 2.5, 10],
  ];
  for (const [param, signal, atrStop, hold] of mr) {
    mk('mean_reversion', param, ir('', `ADX 低位(震荡)时${L ? '超卖' : '超买'}触发,限价挂收盘${L ? '下' : '上'} 0.25 ATR(maker),止盈布林中轨,止损 ${atrStop} ATR,持仓上限 ${hold} 根`, {
      signal, stop: node('atr_stop', { atr_period: 14, multiple: atrStop }), exit: [timeStop(hold)],
      order: orderOf(m, s, { entry: { type: 'limit', price: node('atr_offset_level', { atr_period: 14, multiple: 0.25 }), expiry_bars: 3 }, take_profits: tp1(node('indicator_level', ind('bbands', { period: 20, multiple: 2 }, 'middle'))), min_rr: 0.5, on_new_signal: { unfilled: 'replace', filled: 'ignore' }, max_holding_bars: hold }),
    }));
  }
  // 5) SMC:现有 structure_bos / fair_value_gap 只有向上版本,只跑多头
  if (L) {
    const htf = htfOf(tf), regime = node('htf_structure_regime', { htf, swing_length: 3, max_position: 0.7, require_bos: true });
    mk('smc', 'bos_htf_ob', ir('', `收盘突破确认结构高点(swing 5)+ 高周期(${htf})结构向上且未贴近阻力;止损最近未失效订单块下沿,止盈高周期阻力,盈亏比 ≥ 1.5`, {
      signal: [node('structure_bos', { swing_length: 5 })], regime, stop: node('order_blocks', { swing_length: 5 }), exit: [timeStop(200)],
      order: orderOf(m, s, { take_profits: tp1(node('structure_target', { htf, swing_length: 3 })), min_rr: 1.5, on_new_signal: { unfilled: 'replace', filled: 'ignore' } }),
    }));
    mk('smc', 'fvg_htf_zone', ir('', `看涨公允价值缺口(≥0.2%)+ 高周期(${htf})结构向上;限价挂回下方支撑块上沿,止损块下沿外 0.2 ATR,止盈 2R`, {
      signal: [node('fair_value_gap', { min_gap_pct: 0.2 })], regime, stop: node('structure_level', { swing_length: 5, buffer_atr: 0.2 }), exit: [timeStop(200)],
      order: orderOf(m, s, { entry: { type: 'limit', price: node('structure_level', { swing_length: 5 }) }, take_profits: tp1(node('fixed_r_target', { r: 2 })), min_rr: 2, on_new_signal: { unfilled: 'replace', filled: 'ignore' } }),
    }));
    mk('smc', 'bos_ob_trail', ir('', '收盘突破确认结构高点(swing 3),止损最近订单块下沿,吊灯 ATR(22)×3 追踪,不设止盈', {
      signal: [node('structure_bos', { swing_length: 3 })], stop: node('order_blocks', { swing_length: 3 }), exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 })],
      order: orderOf(m, s, { take_profits: FAR_TP, min_rr: 0, on_new_signal: { unfilled: 'replace', filled: 'ignore' } }),
    }));
  }
  return out;
}

/** 组合族:横截面动量(日线,现货多 / 永续多空)、资金费套利(4h) */
export function portfolioVariants(): PortfolioVariant[] {
  const out: PortfolioVariant[] = [];
  const xs: [string, XsmomParams][] = [['lb30_top3', { lookback_days: 30, top_k: 3, rebalance: 'weekly' }], ['lb30_top5', { lookback_days: 30, top_k: 5, rebalance: 'weekly' }], ['lb90_top5', { lookback_days: 90, top_k: 5, rebalance: 'weekly' }], ['lb30_top5_abs', { lookback_days: 30, top_k: 5, rebalance: 'weekly', abs_filter: true }]];
  for (const [param, p] of xs) out.push({ kind: 'portfolio', id: `xsmom:${param}:spot:long:1d`, family: 'xsmom', param, market: 'spot', side: 'long', timeframe: '1d', node: { primitive: 'portfolio_xsmom', params: { ...p, side: 'long_only' } } });
  out.push({ kind: 'portfolio', id: 'xsmom:lb30_top3_ls:perp:long_short:1d', family: 'xsmom', param: 'lb30_top3_ls', market: 'perp', side: 'long_short', timeframe: '1d', node: { primitive: 'portfolio_xsmom', params: { lookback_days: 30, top_k: 3, rebalance: 'weekly', side: 'long_short' } } });
  // always = 一直持有两腿(门槛放到最低),是另外三档「看费率择时」的对照
  const cs: [string, CarryParams][] = [['always', { window: 1, min_rate: -0.01 }], ['w3_gt0', { window: 3, min_rate: 0 }], ['w9_gt1bp', { window: 9, min_rate: 0.0001 }], ['w21_gt0.5bp', { window: 21, min_rate: 0.00005 }]];
  for (const [param, p] of cs) out.push({ kind: 'portfolio', id: `carry:${param}:perp:neutral:4h`, family: 'carry', param, market: 'perp', side: 'neutral', timeframe: '4h', node: { primitive: 'portfolio_carry', params: p } });
  return out;
}

export const TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
/** 全部变体(单资产族 × 市场 × 方向 × 周期 + 组合族) */
export function allVariants(tfs: readonly string[] = TIMEFRAMES): Variant[] {
  const out: Variant[] = [];
  for (const tf of tfs) for (const [m, s] of [['spot', 'long'], ['perp', 'long'], ['perp', 'short']] as const) out.push(...irVariants(m, s, tf));
  out.push(...portfolioVariants().filter((v) => tfs.includes(v.timeframe)));
  return out;
}
