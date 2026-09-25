import type { FollowApproval, FollowMode, TraderSignal } from '../trader-signal.js';
export interface MarketSubscription { mode: FollowMode; weight: number; enabled: boolean; label?: string; /** book 模式:manual = 生成待批意图等人点;auto = executor 直接执行。默认 manual。 */ approval: FollowApproval; }
export interface MarketSettings { enabled: boolean; transport: 'queue' | 'watch'; poll_ms: number; freshness_s: number; default_mode: FollowMode; subscriptions: Record<string, MarketSubscription>; }
export interface PublisherSettings { enabled: boolean; publish_orders: boolean; publish_analysis: boolean; symbols: string[]; min_confidence?: number; include_realized_pnl: boolean; backend_filter: string[]; }
export const DEFAULT_MARKET_SETTINGS: MarketSettings = { enabled: false, transport: 'queue', poll_ms: 3000, freshness_s: 180, default_mode: 'evidence', subscriptions: {} };
export const DEFAULT_PUBLISHER_SETTINGS: PublisherSettings = { enabled: false, publish_orders: true, publish_analysis: true, symbols: [], include_realized_pnl: true, backend_filter: ['okx', 'binance'] };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const mode = (v: unknown): FollowMode => v === 'book' || v === 'copy' ? 'book' : v === 'gated' ? 'gated' : 'evidence';
const approval = (v: unknown): FollowApproval => (v === 'auto' ? 'auto' : 'manual');
const bounded = (v: unknown, lo: number, hi: number, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
export function normalizeMarketSettings(raw: unknown): MarketSettings {
  const o = obj(raw); const subscriptions: Record<string, MarketSubscription> = Object.create(null);
  for (const [id, value] of Object.entries(obj(o['subscriptions']))) {
    if (!id || id.length > 256) continue;
    const c = obj(value);
    subscriptions[id] = { mode: mode(c['mode']), weight: bounded(c['weight'], 0, 1, 0), enabled: c['enabled'] === true, approval: approval(c['approval']), ...(typeof c['label'] === 'string' ? { label: c['label'].slice(0, 120) } : {}) };
  }
  return { enabled: o['enabled'] === true, transport: o['transport'] === 'watch' ? 'watch' : 'queue', poll_ms: Math.round(bounded(o['poll_ms'], 1000, 300000, 3000)), freshness_s: Math.round(bounded(o['freshness_s'], 10, 86400, 180)), default_mode: mode(o['default_mode']), subscriptions };
}
export function subscriptionFor(settings: MarketSettings, signal: Pick<TraderSignal, 'subscription_job_id'>): MarketSubscription {
  return settings.subscriptions[signal.subscription_job_id ?? 'unknown'] ?? { mode: settings.default_mode, weight: 0, enabled: true, approval: 'manual' };
}
export function normalizePublisherSettings(raw: unknown): PublisherSettings {
  const o = obj(raw); const d = DEFAULT_PUBLISHER_SETTINGS;
  return { enabled: o['enabled'] === true, publish_orders: o['publish_orders'] !== false, publish_analysis: o['publish_analysis'] !== false, symbols: Array.isArray(o['symbols']) ? o['symbols'].filter((x): x is string => typeof x === 'string' && /^[A-Z0-9-]+$/.test(x)) : [], include_realized_pnl: o['include_realized_pnl'] !== false, backend_filter: Array.isArray(o['backend_filter']) ? o['backend_filter'].filter((x): x is string => typeof x === 'string' && ['okx', 'binance', 'paper'].includes(x)) : [...d.backend_filter], ...(o['min_confidence'] !== undefined ? { min_confidence: bounded(o['min_confidence'], 0, 1, 1) } : {}) };
}
