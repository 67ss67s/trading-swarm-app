/**
 * 上架目录:每个对外服务(listing)的名称、描述、计费与处理器映射。
 * listingPayload() 生成 `onchainos agent update --agent-id <asp> --service '<json>'` 的 --service 参数(只生成,不执行;上架/提审由人操作)。
 * 价格是建议值,Jacky 定价后改 DEFAULT_PRICES 或在设置里覆盖。
 *
 * A2A 描述规则(onchainos 4.6.2 `agent update --help`):三段用换行分隔 —— 1 核心能力(必填)/ 2 用户需提供(可选)/ 3 交付说明(可选);
 * 全文 ≤2000 半角宽(CJK 记 2);不许有 URL 和测试字样;serviceName 5–30 字符且不同于 agent 名;单次 fee ≤2 位小数;
 * 订阅只允许 month,可带 72 小时试用;单次服务不能带试用。
 */
import type { ChannelKey, ServiceKey } from './types.js';

export type ListingKey = 'market_intel' | 'micro_alerts' | 'asset_horizon' | 'research_quick' | 'research_full' | 'plan_gate' | 'jev_probability';
export const LISTING_KEYS: readonly ListingKey[] = ['market_intel', 'micro_alerts', 'asset_horizon', 'research_quick', 'research_full', 'plan_gate', 'jev_probability'];

export interface ListingDef {
  key: ListingKey;
  kind: 'subscription' | 'one_time';
  name: string;
  description: [string, string, string];
  guide?: string;
  /** 按次:处理器 key + 强制参数(同一处理器分档上架时用,例如研究报告 quick/full) */
  handler?: { service: ServiceKey; force?: Record<string, unknown> };
  /** 订阅:包含的频道 */
  channels?: ChannelKey[];
  /** 需要付费模型调用(Jev 等):上架前要过条款与成本确认 */
  paid_model?: boolean;
  /** 上架前置条件(人要先确认的事);非空 = 暂不建议上架 */
  hold?: string;
}

export const LISTINGS: Record<ListingKey, ListingDef> = {
  market_intel: {
    key: 'market_intel', kind: 'subscription', name: 'Market Intel 市场情报', channels: ['market_brief', 'radar_feed'],
    description: [
      '加密市场情报订阅:每 30 分钟一份行情简报(BTC/ETH 日线状态、全市场扫描前列、资金费率极值、BTC/ETH 盘口与清算),外加雷达短线/波段/周线三档每轮入选币、理由、证据时效与流动性门结果。Crypto market intel: 30-min briefs plus radar picks across short/swing/weekly tiers.',
      '无需提供参数。No parameters needed.',
      '订阅生效后立即推送一份当前简报与雷达榜单,之后按节奏推送;只提供分析与依据,不含买卖指令,不构成投资建议。First delivery right after activation; analysis only, not investment advice.',
    ],
  },
  micro_alerts: {
    key: 'micro_alerts', kind: 'subscription', name: 'BTC/ETH Microstructure Alerts', channels: ['micro_alerts'],
    description: [
      'BTC/ETH 永续微观结构告警:清算放量、近价大额挂单墙、盘口买卖失衡时推送,附触发数值与基线;每类告警带冷却时间防刷屏。BTC/ETH perp microstructure alerts: liquidation spikes, near-price walls, order-book imbalance.',
      '无需提供参数。No parameters needed.',
      '订阅生效后立即推送当前盘口快照;长时间无告警时每 6 小时推一份静默期摘要。只提供数据与依据,不含买卖指令。Snapshot on activation, quiet-period digest every 6h; data only.',
    ],
  },
  asset_horizon: {
    key: 'asset_horizon', kind: 'one_time', name: 'Asset x Horizon Picks', handler: { service: 'asset_horizon' },
    description: [
      '资产 × 周期推荐:按流动性门槛、日线状态、全市场扫描与雷达名次,给出短线/中线/长线各适合哪些币、方向与适合的策略族,规则计算不调用大模型。Rule-based picks of which assets fit short/mid/long horizons, with direction and strategy families.',
      '可选:币种列表(最多 12 个,如 BTC,ETH)、周期(short/mid/long)、市场(spot/perp)。不填则按全市场扫描与雷达推荐。Optional: symbols, horizons, market.',
      '交付一份推荐表(每币每周期是否合适与理由)及 JSON,附内容哈希。Delivers a table plus JSON with a content hash.',
    ],
  },
  research_quick: {
    key: 'research_quick', kind: 'one_time', name: 'Strategy Backtest Quick', handler: { service: 'research_report', force: { tier: 'quick' } },
    description: [
      '策略快速回测:把你的交易想法(自然语言或策略描述)编成规则,在历史 K 线上跑含手续费与滑点的全窗口回测,报告收益、夏普、回撤、胜率、笔数、同期持有基准与 2 倍费率压力。Quick full-window backtest of your idea with fees and slippage.',
      '需提供:策略想法(标的、周期、入场/出场规则),例如「BTC 4h 突破 20 根高点做多,2ATR 止损,3R 止盈」。Provide: your idea with symbol, timeframe and rules.',
      '交付回测报告及 JSON,附报告哈希(可用于链上存证)。历史回放,不构成投资建议。Report plus JSON with hash; historical replay only.',
    ],
  },
  research_full: {
    key: 'research_full', kind: 'one_time', name: 'Strategy Matrix Research', handler: { service: 'research_report', force: { tier: 'full' } },
    description: [
      '策略矩阵研究:对最多 3 个资产 × 2 个周期 × 多个策略族做训练/选择/留出三段研究,选择段 Deflated Sharpe 门槛、留出段只看一次并做多重检验校正,如实报告有没有站得住的策略。Matrix study with train/selection/holdout and multiple-testing control.',
      '可选:币种(最多 3 个)、周期(15m/4h/1d 选 1–2 个)、策略族、方向、市场。不填则取当前推荐的前 3 个资产、4h。Optional: symbols, timeframes, families, sides, market.',
      '交付研究结论、各格结果、留出段成绩与组合回放及 JSON,附报告哈希(可用于链上存证)。通常 10–30 分钟完成。Report plus JSON with hash; usually 10–30 min.',
    ],
  },
  plan_gate: {
    key: 'plan_gate', kind: 'one_time', name: 'Trade Plan Check', handler: { service: 'plan_gate' },
    description: [
      '交易计划把关:检查你的一笔计划是否站得住 —— 止损方向与 ATR 距离、目标加权盈亏比、入场是否陈旧、是否顺日线状态,规则门槛全部通过后再由 AI 决策模型给出是否值得跟的概率,输出跟/不跟/不确定及每项依据。Checks a trade plan with rule gates, then an AI decision-model probability.',
      '需提供:币种、方向(long/short)、入场价、止损价,可选目标价与周期,例如「BTC 做多 入场 64200 止损 63100 止盈 65500 1h」。Provide: symbol, side, entry, stop; optional targets and timeframe.',
      '交付结论、各项门槛数值与模型概率及 JSON;含 AI 模型生成内容,只给分析依据,不构成投资建议。Verdict with gate values and model probabilities; contains AI-generated content, analysis only.',
    ],
    paid_model: true,
  },
  jev_probability: {
    key: 'jev_probability', kind: 'one_time', name: 'AI Probability Check', handler: { service: 'jev_probability' },
    description: [
      '结构化概率判断:按你给的标的与设定,由规则提取行情特征后交给 AI 决策模型回答模板问题(是否值得入场、支撑能否守住、阻力能否突破、回落风险),返回每个问题的概率分布与所用特征值。Structured probabilities on templated questions from rule-extracted features and an AI decision model.',
      '需提供:币种与周期,可选方向、入场、止损、目标与想问的问题模板。Provide: symbol and timeframe; optional side, levels and templates.',
      '交付各问题概率、模型版本、特征值与本次成本及 JSON;含 AI 模型生成内容,只给分析依据,不构成投资建议。Probabilities, model version and features; AI-generated, analysis only.',
    ],
    paid_model: true,
    hold: '待 typesafe 书面确认:近原样转卖模型概率是否属于 MCA 2.3(a) 的独立服务;确认前不上或限量上',
  },
};

/** 建议价(USDT);订阅为月费,均带 72 小时试用 */
export const DEFAULT_PRICES: Record<ListingKey, string> = {
  market_intel: '9.9', micro_alerts: '5.9', asset_horizon: '0.5', research_quick: '2', research_full: '15', plan_gate: '0.5', jev_probability: '0.3',
};

const width = (s: string) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦　-〿【】]/.test(c) ? 2 : 1), 0);

/** 按 CLI 规则自检;返回问题列表(空 = 可提交) */
export function checkListing(d: ListingDef, fee: string, agentName = 'Trading Swarm'): string[] {
  const out: string[] = [];
  const n = [...d.name].length;
  if (n < 5 || n > 30) out.push(`${d.key}: serviceName 长度 ${n} 不在 5–30`);
  if (d.name.trim().toLowerCase() === agentName.toLowerCase()) out.push(`${d.key}: serviceName 不能与 agent 名相同`);
  const desc = d.description.join('\n');
  if (!d.description[0].trim()) out.push(`${d.key}: 第 1 段核心能力必填`);
  if (width(desc) > 2000) out.push(`${d.key}: 描述宽度 ${width(desc)} > 2000`);
  if (/https?:\/\/|www\.|\.com\b|\.io\b/i.test(desc)) out.push(`${d.key}: 描述不能含 URL`);
  if (/\btest\b|测试/i.test(desc + d.name)) out.push(`${d.key}: 不能含测试字样`);
  if (d.guide && width(d.guide) > 2000) out.push(`${d.key}: serviceGuide 超过 2000 宽`);
  if (!/^\d+(?:\.\d{1,2})?$/.test(fee) || !(Number(fee) > 0)) out.push(`${d.key}: 价格 ${fee} 必须是 ≤2 位小数的正数`);
  return out;
}

/** `agent update --service` 的数组元素;existing_id 有值 = 更新,否则新建 */
export function listingPayload(d: ListingDef, fee: string, existing_id?: string | null): Record<string, unknown> {
  const base = { ...(existing_id ? { operation: 'update', id: existing_id } : { operation: 'create' }), serviceName: d.name, serviceDescription: d.description.join('\n'), ...(d.guide ? { serviceGuide: d.guide } : {}), serviceType: 'A2A' };
  return d.kind === 'subscription'
    ? { ...base, fee: '', subscription: [{ interval: 'month', fee }], freeTrial: '72' }
    : { ...base, fee, subscription: [] };
}

export function listingBundle(prices: Partial<Record<ListingKey, string>> = {}, existing: Partial<Record<ListingKey, string>> = {}, keys: readonly ListingKey[] = LISTING_KEYS) {
  const items = keys.map((k) => { const fee = prices[k] ?? DEFAULT_PRICES[k]; return { key: k, fee, problems: checkListing(LISTINGS[k], fee), service: listingPayload(LISTINGS[k], fee, existing[k] ?? null) }; });
  return { items, service_arg: JSON.stringify(items.map((x) => x.service)), ok: items.every((x) => !x.problems.length) };
}
