/**
 * 数据 adapter 目录(§9.44 数据层)。研究 loop 缺数据时先查这里:哪个来源能给这个指标、给到什么周期、多深的历史、
 * 要不要钱、没接的话缺什么(密钥 / 预算 / 授权)。目录只登记事实,不提供实现 —— 登记成 not_connected 的来源一行代码都没有,
 * 解析结果里也永远不会被当成 available。代理指标规则在 proxies.ts,报告里必须标 proxy,不冒充原指标。
 */
import type { Instrument, MetricKey } from './index.js';
import { notApplicableReason, proxiesFor, type MarketTypeTag } from './proxies.js';
export const CATALOG_VERSION = 'data-catalog/v1';
export type AdapterStatus = 'connected' | 'not_connected';
/** 目录自己的可用性口径:比 SnapshotDraft 的 Availability 多一个 not_connected(来源已知但本仓库没接)。 */
export type CatalogAvailability = 'available' | 'partial' | 'missing' | 'not_applicable' | 'not_connected';
/** 成本档:决定能不能随便调。free_public 可以循环拉,paid_api / licensed 要先报价拿授权。 */
export type CostClass = 'free_public' | 'rate_limited_public' | 'paid_api' | 'licensed';
export interface AdapterMetricEntry {
  metric: MetricKey;
  market_types: MarketTypeTag[];
  /** 支持的周期;事件流(逐笔强平)写 ['event'],日线源写 ['1d']。 */
  timeframes: string[];
  history_depth_note: string;
  cost_class: CostClass;
  availability_note: string;
}
export interface DataAdapter {
  id: string;
  venue: string;
  provider: string;
  status: AdapterStatus;
  asset_classes: ('crypto' | 'equity')[];
  metrics: AdapterMetricEntry[];
  /** 没接的来源:接入所需(密钥 / 成本 / 授权 / 合规)。已接的来源写运行前提。 */
  connect_requirements: string;
}
const CRYPTO_TF = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
/**
 * 目录顺序即 fallback 尝试顺序:已接的排前面,同指标多来源时先试先登记的。
 * 改这里等于改现网数据来源优先级,加来源要连 connect_requirements 一起写,不许只写 id。
 */
export const DATA_ADAPTERS: DataAdapter[] = [
  {
    id: 'okx-public',
    venue: 'okx',
    provider: 'okx-public-v5 (ccxt + /api/v5/public)',
    status: 'connected',
    asset_classes: ['crypto'],
    connect_requirements: '无密钥;走公共只读接口。出口 IP 受 OKX 地域限制影响,被限时整层拿不到数据(不是代码 bug)。',
    metrics: [
      { metric: 'price', market_types: ['spot', 'perp'], timeframes: CRYPTO_TF, history_depth_note: '分页回拉,实测日线可取 2400 天以上;单页 100 根', cost_class: 'rate_limited_public', availability_note: '只给已收盘 K 线,当前未收盘的那根会被丢掉' },
      { metric: 'funding', market_types: ['perp'], timeframes: ['8h'], history_depth_note: '结算历史 REST 只回约 3 个月;回测数据层(perp-market)另接 OKX 月度归档(自 2022-01 起的完整月份),更早用币安同名合约代理并在溯源里标注', cost_class: 'rate_limited_public', availability_note: '只有已结算的期数,没有「下一期预测」;比率是每期分数,不年化' },
      { metric: 'open_interest', market_types: ['perp'], timeframes: ['5m', '15m', '30m', '1h', '4h', '1d'], history_depth_note: '交易所只保留近期档位,长窗口会 partial', cost_class: 'rate_limited_public', availability_note: 'USD 名义与张数两列,缺失的一列给 null 不给 0' },
      { metric: 'liquidations', market_types: ['perp'], timeframes: ['event'], history_depth_note: '公共接口只给最近约 500 条已成交强平单,回不到更早', cost_class: 'rate_limited_public', availability_note: '长窗口必然 partial,quality_flags 会写 truncated_to_recent_N' },
    ],
  },
  {
    id: 'binance-public',
    venue: 'binance',
    provider: 'binance public market data (fapi / api)',
    status: 'not_connected',
    asset_classes: ['crypto'],
    connect_requirements:
      '接入所需:无密钥(公共行情),但需要 ①出口 IP 未被币安地域限制 ②权重预算 —— 本机出口是共享节点,权重按 IP 记且会被邻居花掉(见 8794 的 400 权重桶),接入前必须先定死这条链路的配额并和现有跟单实例的桶隔离。没有这两条就不要接。',
    metrics: [
      { metric: 'price', market_types: ['spot', 'perp'], timeframes: CRYPTO_TF, history_depth_note: '现货/U 本位合约 K 线可回到上线日,分页 limit 决定权重档位', cost_class: 'rate_limited_public', availability_note: '未接入;可作为 OKX 拿不到时的第二价格源(同一根 K 线两家会有细微差异,跨源拼接要标注)' },
      { metric: 'funding', market_types: ['perp'], timeframes: ['8h'], history_depth_note: '资金费结算历史完整', cost_class: 'rate_limited_public', availability_note: '未接入;币安部分合约资金费周期是 4h 不是 8h,接入时口径要按合约读不能写死' },
      { metric: 'open_interest', market_types: ['perp'], timeframes: ['5m', '15m', '30m', '1h', '4h', '1d'], history_depth_note: '官方只留最近 30 天持仓量历史', cost_class: 'rate_limited_public', availability_note: '未接入;30 天以外的窗口即使接了也只能 partial' },
    ],
  },
  {
    id: 'coinglass',
    venue: 'coinglass',
    provider: 'Coinglass API v4',
    status: 'not_connected',
    asset_classes: ['crypto'],
    connect_requirements:
      '接入所需:付费 API key(清算热图 / 清算等级在 Standard 及以上档位,按月计费),需要先报价拿用户授权再开通;免费档不含热图。另需确认条款是否允许把热图转述进对外产品。没有 key 之前 liquidation_estimates 一律 missing,不许用 K 线、成交量或持仓量反推出「清算价位」冒充。',
    metrics: [
      { metric: 'liquidation_estimates', market_types: ['perp'], timeframes: ['1h', '4h', '1d'], history_depth_note: '热图按窗口给,不是时间序列', cost_class: 'paid_api', availability_note: '未接入;这是全市场杠杆分布的估计,本身就带模型假设,接入后必须在报告里标明是估计不是成交' },
      { metric: 'liquidations', market_types: ['perp'], timeframes: ['1h', '4h', '1d'], history_depth_note: '聚合强平额历史可回溯数年', cost_class: 'paid_api', availability_note: '未接入;与 OKX 逐笔强平口径不同(全交易所聚合 + 已按周期汇总),两者不能混在同一列' },
    ],
  },
  {
    id: 'tradfi-daily',
    venue: 'tradfi',
    provider: 'Stooq CSV / Yahoo Finance(候选,二选一)',
    status: 'not_connected',
    asset_classes: ['equity'],
    connect_requirements:
      '接入所需:Stooq 免费无密钥但无 SLA、限频不透明;Yahoo 是非官方接口且条款限制商用 —— 两条都要法务/用户先拍板选哪条并接受其可用性风险。另需时区与复权口径约定(日线以交易所收盘为准,分红拆股是否复权必须写死),否则和加密的 UTC 连续行情对不上。',
    metrics: [
      { metric: 'price', market_types: ['equity', 'index'], timeframes: ['1d'], history_depth_note: '日线可回溯数十年', cost_class: 'free_public', availability_note: '未接入;只有日线,没有盘中;非交易日无行以致窗口天然有洞,不能当成 gap 补值' },
    ],
  },
];
export interface ProxySuggestion { metric: MetricKey; adapter_id: string; note: string }
export interface AdapterCandidate { adapter_id: string; status: AdapterStatus; note: string }
export interface DataConceptResolution {
  metric: MetricKey;
  instrument_id: string;
  market_type: MarketTypeTag;
  timeframe: string | null;
  availability: CatalogAvailability;
  adapter_id?: string;
  note: string;
  proxies?: ProxySuggestion[];
  /** 所有登记了这个指标的来源(含没接的),让规划器知道「不是没人有,是我们没接」。 */
  candidates?: AdapterCandidate[];
  catalog_version: string;
}
/** canonical_id 形如 venue:market_type:symbol;拿不到就按 crypto 永续兜底(研究 loop 现阶段只跑 OKX)。 */
export function marketTypeOf(instrument: Instrument | string): MarketTypeTag {
  if (typeof instrument !== 'string') return instrument.market_type;
  const seg = instrument.split(':')[1]?.toLowerCase() ?? '';
  if (seg === 'spot' || seg === 'perp' || seg === 'equity' || seg === 'index') return seg;
  return 'perp';
}
const idOf = (instrument: Instrument | string) => (typeof instrument === 'string' ? instrument : instrument.canonical_id);
const venueOf = (instrument: Instrument | string) => (typeof instrument === 'string' ? (instrument.split(':')[0] ?? '') : instrument.venue);
export function listAdapters(): DataAdapter[] {
  return DATA_ADAPTERS.map((a) => ({ ...a, metrics: a.metrics.map((m) => ({ ...m })) }));
}
/** 登记了 metric + market_type 的 adapter,按目录顺序;不看 status,调用方自己过滤。 */
export function adaptersFor(metric: MetricKey, market_type: MarketTypeTag): { adapter: DataAdapter; entry: AdapterMetricEntry }[] {
  const out: { adapter: DataAdapter; entry: AdapterMetricEntry }[] = [];
  for (const adapter of DATA_ADAPTERS) for (const entry of adapter.metrics) if (entry.metric === metric && entry.market_types.includes(market_type)) out.push({ adapter, entry });
  return out;
}
/** fallback 顺序:已接的、登记了这个指标的 adapter id,按目录顺序。 */
export function connectedAdapterIds(metric: MetricKey, market_type: MarketTypeTag): string[] {
  return adaptersFor(metric, market_type).filter((x) => x.adapter.status === 'connected').map((x) => x.adapter.id);
}
/** 事件流没有周期概念;'event' 一律放过,其余按登记的周期列表判。 */
const timeframeOk = (entry: AdapterMetricEntry, timeframe: string | null) => !timeframe || entry.timeframes.includes('event') || entry.timeframes.includes(timeframe);
/** 只在指标本身能拿到的时候才给代理,避免「代理的代理」。 */
function suggestProxies(metric: MetricKey, market_type: MarketTypeTag): ProxySuggestion[] {
  const out: ProxySuggestion[] = [];
  for (const rule of proxiesFor(metric, market_type)) {
    const parts = rule.requires.map((need) => ({ need, ids: connectedAdapterIds(need.metric, market_type) }));
    if (parts.some((p) => !p.ids.length)) continue;
    for (const p of parts) out.push({ metric: p.need.metric, adapter_id: p.ids[0]!, note: `${rule.label}(代理,非 ${metric}):${rule.note}` });
  }
  return out;
}
/**
 * 目录解析:这个指标在这个标的这个周期上,到底能不能拿、谁能给、拿不到是为什么。
 * 顺序固定 —— 先判「在这个市场上根本不成立」(not_applicable),再看已接的来源,再看已知但没接的来源(not_connected),
 * 最后才是 missing(连来源都不知道)。任何一条都不返回空数据冒充有数据。
 */
export function resolveDataConcept(metric: MetricKey, instrument: Instrument | string, timeframe?: string | null): DataConceptResolution {
  const market_type = marketTypeOf(instrument), tf = timeframe ?? null, venue = venueOf(instrument);
  const base = { metric, instrument_id: idOf(instrument), market_type, timeframe: tf, catalog_version: CATALOG_VERSION };
  const na = notApplicableReason(metric, market_type);
  if (na) return { ...base, availability: 'not_applicable', note: na };
  const all = adaptersFor(metric, market_type);
  const candidates: AdapterCandidate[] = all.map((x) => ({ adapter_id: x.adapter.id, status: x.adapter.status, note: x.adapter.status === 'connected' ? x.entry.availability_note : x.adapter.connect_requirements }));
  const proxies = suggestProxies(metric, market_type);
  const withProxies = proxies.length ? { proxies } : {};
  const connected = all.filter((x) => x.adapter.status === 'connected');
  // 同 venue 的来源优先(问 OKX 的标的先用 OKX),其余按目录顺序
  const ranked = [...connected].sort((a, b) => Number(b.adapter.venue === venue) - Number(a.adapter.venue === venue));
  const exact = ranked.find((x) => timeframeOk(x.entry, tf));
  if (exact) return { ...base, availability: 'available', adapter_id: exact.adapter.id, note: `${exact.adapter.provider}:${exact.entry.availability_note};历史深度:${exact.entry.history_depth_note}`, candidates, ...withProxies };
  if (ranked.length) {
    const a = ranked[0]!;
    return { ...base, availability: 'partial', adapter_id: a.adapter.id, note: `${a.adapter.id} 有 ${metric} 但只登记了 ${a.entry.timeframes.join('/')} 周期,请求的 ${tf} 需要换周期或自行重采样(重采样要在报告里标注)`, candidates, ...withProxies };
  }
  const pending = all.find((x) => x.adapter.status === 'not_connected');
  if (pending) return { ...base, availability: 'not_connected', adapter_id: pending.adapter.id, note: `已知来源 ${pending.adapter.id}(${pending.adapter.provider})能给 ${metric},但本仓库尚未接入。${pending.adapter.connect_requirements}`, candidates, ...withProxies };
  return { ...base, availability: 'missing', note: `目录里没有任何来源登记 ${metric}(${market_type});这不是暂时拿不到,是根本没有数据源 —— 不能用其它指标推算后冒充`, candidates: candidates.length ? candidates : undefined, ...withProxies };
}
