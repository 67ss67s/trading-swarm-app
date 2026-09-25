/**
 * 推荐资产(契约 §9.53 A,后端 gateway/src/demo/recommend.ts)。
 *
 *   GET /api/recommendations/:id → AssetRecommendation
 *
 * 对话里模型调 recommend_assets 后,工具结果只带 recommendation_id(给模型的是精简版),
 * 推荐卡按 id 取完整结果渲染。类型放这里,不改 api/types.ts(别人在动)。
 */
import { useQuery } from '@tanstack/react-query';

export type Horizon = 'short' | 'mid' | 'long';
export const HORIZONS: Horizon[] = ['short', 'mid', 'long'];
export const HORIZON_TIMEFRAMES: Record<Horizon, string[]> = { short: ['3m', '5m', '15m'], mid: ['1h', '4h'], long: ['12h', '1d'] };

export type FamilyKey = 'breakout' | 'ma_trend' | 'ema_cross' | 'pullback' | 'mean_reversion' | 'smc' | 'xsmom' | 'carry';
export type RegimeKind = 'bull' | 'bear' | 'range' | 'volatile';

export interface HorizonFit {
  eligible: boolean;
  /** liquidity / history / regime / excluded / unknown_asset / no_market / not_requested */
  reason: string | null;
  direction: 'long' | 'short' | 'both' | null;
  families: FamilyKey[];
  evidence: string[];
}
export interface RecommendationRow {
  symbol: string;
  market: 'spot' | 'perp';
  quote_vol_24h: number | null;
  depth_usd_05: number | null;
  regime: RegimeKind | null;
  scan: { rank: number; score: number; reasons: string[] } | null;
  horizons: Record<Horizon, HorizonFit>;
}
export interface AssetRecommendation {
  id: string;
  as_of: number;
  source: { universe_scan_at: number | null; regime_at: number | null };
  rows: RecommendationRow[];
  warnings: string[];
}

export async function fetchRecommendation(id: string): Promise<AssetRecommendation> {
  const res = await fetch(`/api/recommendations/${encodeURIComponent(id)}`);
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((body as { error?: { message?: string } } | null)?.error?.message ?? res.statusText);
  return body as AssetRecommendation;
}

/** 推荐结果落库后不再变,取一次就够 */
export function useRecommendation(id: string | null) {
  return useQuery({ queryKey: ['recommendation', id], queryFn: () => fetchRecommendation(id!), enabled: !!id, staleTime: Infinity, retry: 1 });
}

/** 从对话工具结果里认出推荐 id(工具结果是 recommendationSummary 的形状) */
export function recommendationIdOf(call: { name: string; ok: boolean; result: unknown }): string | null {
  if (call.name !== 'recommend_assets' || !call.ok || !call.result || typeof call.result !== 'object') return null;
  const id = (call.result as { recommendation_id?: unknown }).recommendation_id;
  return typeof id === 'string' && id ? id : null;
}
