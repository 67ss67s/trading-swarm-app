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
    key: 'market_intel', kind: 'subscription', name: 'Market Intel', channels: ['market_brief', 'radar_feed'],
    description: [
      'OKX market intel for crypto traders: a brief every 4 hours (UTC 0/4/8/12/16/20) with BTC/ETH prices from OKX perp order-book mids, daily regime, OKX perp liquidations over the last 4 hours, plus the daily market-wide scan leaders and funding-rate extremes (daily snapshots, timestamped). Radar picks for the short-term, swing and weekly tiers are pushed whenever a tier finishes a run, with reasons and evidence freshness. OKX-tradable crypto only; the short-term tier lists only symbols that pass its liquidity gate.',
      'No parameters needed.',
      'A welcome pack (current brief + latest radar tiers) is delivered right after activation. Rule-based analysis only, no trade instructions, not investment advice.',
    ],
  },
  micro_alerts: {
    key: 'micro_alerts', kind: 'subscription', name: 'BTC/ETH Microstructure Alerts', channels: ['micro_alerts'],
    description: [
      'BTC/ETH microstructure alerts from OKX perpetuals: pushed when liquidations spike versus the 6-hour baseline, with the price change over the window. 30-minute cooldown per alert type; a quiet-period summary after 6 hours without alerts. Order-book imbalance and wall alerts are paused until a full-depth book feed is connected.',
      'No parameters needed.',
      'An order-book snapshot is delivered right after activation. Data and evidence only, no trade instructions.',
    ],
  },
  asset_horizon: {
    key: 'asset_horizon', kind: 'one_time', name: 'Asset x Horizon Picks', handler: { service: 'asset_horizon' },
    description: [
      'Asset × horizon picks: rule-based screening (liquidity gates, daily regime, market-wide scan and radar ranks) that tells you which OKX-tradable coins fit short-term, mid-term and long-term trading, with directional bias and suitable strategy families. No LLM involved.',
      'Optional: symbols (up to 12, e.g. BTC, ETH), horizons (short/mid/long), market (spot/perp). If omitted, picks come from the market scan and radar.',
      'Delivers a ranked table (fit per coin and horizon, with reasons and data timestamps) plus structured JSON.',
    ],
  },
  research_quick: {
    key: 'research_quick', kind: 'one_time', name: 'Strategy Backtest Quick', handler: { service: 'research_report', force: { tier: 'quick' } },
    description: [
      'Quick strategy backtest: turns your trading idea (plain language or a rule description) into rules and runs a full-window backtest on historical candles with fees and slippage. Reports return, Sharpe, max drawdown, win rate, trade count, buy-and-hold benchmark, yearly breakdown and a 2× fee stress check.',
      'Provide your idea with symbol, timeframe and entry/exit rules, e.g. "BTC 4h: go long on a close above the prior 20-bar high, 2 ATR stop, 3R target".',
      'Delivers the backtest report plus structured JSON with a report hash. Historical replay only, not investment advice.',
    ],
  },
  research_full: {
    key: 'research_full', kind: 'one_time', name: 'Strategy Matrix Research', handler: { service: 'research_report', force: { tier: 'full' } },
    description: [
      'Strategy matrix research: up to 3 assets × 2 timeframes × several strategy families, run through train / selection / holdout segments with a Deflated Sharpe gate and multiple-testing correction; the holdout is used only once. Reports honestly whether any strategy holds up.',
      'Optional: symbols (up to 3), timeframes (1–2 of 15m/4h/1d), strategy families, sides, market. If omitted, the top 3 recommended assets on 4h are used.',
      'Delivers the conclusion, per-cell results, holdout performance, multiple-testing results and portfolio replay, plus structured JSON with a report hash. Usually 10–30 minutes.',
    ],
  },
  plan_gate: {
    key: 'plan_gate', kind: 'one_time', name: 'Trade Plan Check', handler: { service: 'plan_gate' },
    description: [
      'Trade plan check: tests whether your plan holds up — entry vs. current price, stop side and ATR distance, weighted reward/risk, daily-regime alignment — and, once all rule gates pass, adds an AI decision-model probability. Verdict is pass / fail / uncertain with the evidence for each gate and suggested fixes.',
      'Provide symbol, side (long/short), entry and stop; optional targets and timeframe, e.g. "BTC long, entry 84300, stop 83100, target 86500, 1h".',
      'Delivers the verdict, gate values and fixes plus structured JSON. Contains AI-generated content when the model is used; analysis only, not investment advice.',
    ],
    paid_model: true,
  },
  jev_probability: {
    key: 'jev_probability', kind: 'one_time', name: 'AI Probability Check', handler: { service: 'jev_probability' },
    description: [
      'Structured probability check: rule-extracted market features are passed to an AI decision model that answers templated questions — is the entry setup reasonable (always answered), will support hold, will resistance break, pullback risk — with historical base rates from the same candles alongside.',
      'Provide symbol and timeframe; optional side, entry, stop, target and which questions to ask.',
      'Delivers per-question probabilities, historical base rates and feature values plus structured JSON. AI-generated content; analysis only, not investment advice.',
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
