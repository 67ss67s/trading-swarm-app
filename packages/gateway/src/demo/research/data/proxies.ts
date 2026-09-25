/**
 * 代理指标规则表(§9.44 数据层)。两件事:
 * ① 哪些指标在哪些市场根本不成立(现货没有资金费、TradFi 没有强平)—— 这类要回 not_applicable,不是 missing,更不是 0;
 * ② 某个指标没有数据源时,能用哪些已有指标做「代理」—— 代理只能在报告里以 proxy 身份出现,标题、结论、图例都要写明是代理,
 *    绝不允许把代理的值填进原指标的字段里。规则表是数据,不是实现:这里不算任何数字,只说明「可以用什么替、替的话必须怎么说」。
 */
import type { MetricKey } from './index.js';
export type MarketTypeTag = 'spot' | 'perp' | 'equity' | 'index';
/** 只有永续才有的指标:资金费、持仓量、强平、清算估计。 */
const PERP_ONLY: MetricKey[] = ['funding', 'open_interest', 'liquidations', 'liquidation_estimates'];
const TRADFI: MarketTypeTag[] = ['equity', 'index'];
/**
 * 指标在这个市场上是否根本不成立;成立返回 null,不成立返回给人看的原因。
 * 注意与 missing 的区别:not_applicable 是「问错了」,missing 是「问对了但没数据」,两者在报告里的措辞完全不同。
 */
export function notApplicableReason(metric: MetricKey, market_type: MarketTypeTag): string | null {
  if (TRADFI.includes(market_type)) {
    if (PERP_ONLY.includes(metric)) return '资金费 / 持仓量(永续口径)/ 强平是加密永续合约特有的结构,TradFi 标的上不成立;股票的融券费率、期权未平仓量是另一套口径,不能混用';
    if (metric === 'orderbook') return 'TradFi 逐笔盘口需要交易所授权数据,不在本研究层的范围内';
    return null;
  }
  if (market_type === 'spot' && PERP_ONLY.includes(metric)) return '现货没有资金费 / 持仓量 / 强平;这些指标只在永续合约上成立 —— 要看这些请改问同一资产的永续合约';
  return null;
}
export interface ProxyRequirement { metric: MetricKey }
export interface ProxyRule {
  /** 缺的那个指标 */
  target: MetricKey;
  id: string;
  /** 报告里显示的名字,必须自带「代理」字样 */
  label: string;
  market_types: MarketTypeTag[];
  /** 组成代理所需的指标,缺一条整条规则就不成立 */
  requires: ProxyRequirement[];
  /** 必须随代理一起出现的说明:它能说明什么、不能说明什么 */
  note: string;
}
export const PROXY_RULES: ProxyRule[] = [
  {
    target: 'liquidation_estimates',
    id: 'leverage_heat_from_funding_oi',
    label: '杠杆升温代理',
    market_types: ['perp'],
    requires: [{ metric: 'funding' }, { metric: 'open_interest' }],
    note: '用资金费水平与持仓量变化描述杠杆拥挤的方向和程度。它回答不了「清算价位在哪」—— 没有全市场仓位分布就算不出价位,任何具体点位都是编的。只能说「杠杆在升温/降温」,不能说「XX 价位有多少清算」',
  },
  {
    target: 'liquidations',
    id: 'deleverage_from_oi_drop',
    label: '去杠杆代理',
    market_types: ['perp'],
    requires: [{ metric: 'open_interest' }, { metric: 'price' }],
    note: '持仓量骤降叠加价格急动,通常对应一轮强平。这是推断不是成交记录:主动平仓和强平在持仓量上长得一样,给不出笔数、方向和成交价,只能说「这段有集中减仓」',
  },
  {
    target: 'orderbook',
    id: 'liquidity_from_volume',
    label: '流动性粗代理',
    market_types: ['spot', 'perp'],
    requires: [{ metric: 'price' }],
    note: 'K 线成交量只能粗略反映这段时间有多少量成交,和买卖盘深度是两回事:它看不出挂单厚度、价差和冲击成本。做仓位上限或滑点估计时不能拿它当盘口用',
  },
];
/** 某个指标缺失时,这个市场上可用的代理规则(不判断依赖指标是否真拿得到,那由 catalog 决定)。 */
export function proxiesFor(target: MetricKey, market_type: MarketTypeTag): ProxyRule[] {
  return PROXY_RULES.filter((r) => r.target === target && r.market_types.includes(market_type));
}
/** 报告里该怎么写这条代理:一句话,自带代理声明。 */
export function describeProxy(rule: ProxyRule): string {
  return `${rule.label}(代理指标,不是 ${rule.target}):由 ${rule.requires.map((r) => r.metric).join(' + ')} 构成。${rule.note}`;
}
