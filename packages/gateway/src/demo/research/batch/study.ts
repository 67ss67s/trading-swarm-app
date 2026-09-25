/**
 * 批量研究的汇总规则(纯函数,给脚本与测试共用;设计见 docs/research/batch-study-2026-09-23.md 第三、六、七节):
 *  - 训练段筛资产(screenAssets):训练段里 ≥ 5 笔、夏普 > 0 的资产按夏普取前 5,验证段只算这几个(单独记一次试验);
 *  - 每族冠军(familyChampions):只看训练段,在训练段 ≥ 30 笔的整池行里取训练段扣成本夏普最高的一行
 *    (筛资产行的训练段成绩是按训练段挑出来的,天然偏高,不参加冠军评选);
 *  - 排行榜(leaderboard):按验证段扣成本夏普降序;
 *  - Deflated Sharpe(withDeflated):试验数 = 全部行数,方差 = 全部行同一段日夏普的方差;
 *  - 落库门槛(promotionGates):验证段 n ≥ 30、每笔期望 > 0、2 倍费率收益 > 0、跑赢同敞口持有。
 */
import { deflatedSharpe, variance } from '../improve/stats.js';
import { poolScore, type AssetSlice, type PoolScore } from './evaluate.js';
import type { FamilyKey, Market } from './families.js';

export const SCREEN_TOP = 5, SCREEN_MIN_TRADES = 5, CHAMPION_MIN_TRADES = 30, PROMOTE_MIN_TRADES = 30;
export type SlimScore = Omit<PoolScore, 'returns'>;
export interface BatchRow {
  id: string; variant_id: string; family: FamilyKey; param: string; market: Market; side: string; timeframe: string;
  /** 'pool' = 整个资产池;'screen5' = 训练段筛出的前 5 个资产 */
  scope: 'pool' | 'screen5';
  train: SlimScore; validation: SlimScore;
  per_asset?: { symbol: string; train_return: number | null; train_sharpe: number | null; train_trades: number; validation_return: number | null; validation_sharpe: number | null; validation_trades: number; train_hold?: number | null; validation_hold?: number | null; train_exposure?: number; validation_exposure?: number }[];
  deflated?: { train: number | null; validation: number | null; trials: number };
  gates?: { name: string; ok: boolean; value: number | null }[];
  promotable?: boolean;
}
export const slim = (s: PoolScore): SlimScore => { const { returns: _r, ...rest } = s; return rest; };

/** 单资产的某段夏普(年化)与收益 */
export function assetStats(s: AssetSlice): { ret: number | null; sharpe: number | null } {
  if (!s.eligible || s.eq.length < 2) return { ret: null, sharpe: null };
  const r: number[] = []; for (let i = 1; i < s.eq.length; i++) if (s.eq[i - 1]! > 0) r.push(s.eq[i]! / s.eq[i - 1]! - 1);
  const m = r.reduce((a, b) => a + b, 0) / (r.length || 1), sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, r.length - 1));
  return { ret: s.eq.at(-1)! - 1, sharpe: r.length >= 2 && sd > 0 ? (m / sd) * Math.sqrt(365) : null };
}
/** 训练段筛资产:≥ SCREEN_MIN_TRADES 笔、夏普 > 0,按夏普降序取前 SCREEN_TOP(同夏普按代码),只用训练段 */
export function screenAssets(train: AssetSlice[], top = SCREEN_TOP): string[] {
  return train.filter((s) => s.eligible && s.trades >= SCREEN_MIN_TRADES).map((s) => ({ s, st: assetStats(s) })).filter((x) => x.st.sharpe !== null && x.st.sharpe > 0)
    .sort((a, b) => b.st.sharpe! - a.st.sharpe! || a.s.symbol.localeCompare(b.s.symbol)).slice(0, top).map((x) => x.s.symbol);
}
/** 一个变体的两行(整池 + 筛资产) */
export function rowsFor(meta: Omit<BatchRow, 'id' | 'scope' | 'train' | 'validation' | 'per_asset'>, train: AssetSlice[], validation: AssetSlice[], sign: 1 | -1): BatchRow[] {
  const per_asset = train.map((t, k) => { const v = validation[k]!, a = assetStats(t), b = assetStats(v); return { symbol: t.symbol, train_return: a.ret, train_sharpe: a.sharpe, train_trades: t.trades, validation_return: b.ret, validation_sharpe: b.sharpe, validation_trades: v.trades, train_hold: t.eligible && t.hold.length ? t.hold.at(-1)! - 1 : null, validation_hold: v.eligible && v.hold.length ? v.hold.at(-1)! - 1 : null, train_exposure: t.exposure, validation_exposure: v.exposure }; });
  const rows: BatchRow[] = [{ ...meta, id: meta.variant_id, scope: 'pool', train: slim(poolScore(train, sign)), validation: slim(poolScore(validation, sign)), per_asset }];
  if (train.length > SCREEN_TOP) {
    const picked = new Set(screenAssets(train));
    if (picked.size) rows.push({ ...meta, id: meta.variant_id + '@screen5', scope: 'screen5', train: slim(poolScore(train.filter((s) => picked.has(s.symbol)), sign)), validation: slim(poolScore(validation.filter((s) => picked.has(s.symbol)), sign)) });
  }
  return rows;
}
/** Deflated Sharpe:N = 行数,方差取所有行同一段日夏普的方差 */
export function withDeflated(rows: BatchRow[]): BatchRow[] {
  const N = rows.length, vT = variance(rows.map((r) => r.train.period_sharpe).filter((x): x is number => x !== null)), vV = variance(rows.map((r) => r.validation.period_sharpe).filter((x): x is number => x !== null));
  const d = (s: SlimScore, V: number) => (s.period_sharpe === null || s.days < 2 ? null : deflatedSharpe({ sharpe: s.period_sharpe, trials: N, sharpeVariance: V, days: s.days, skew: s.skew, kurtosis: s.kurtosis })?.dsr ?? null);
  return rows.map((r) => ({ ...r, deflated: { train: d(r.train, vT), validation: d(r.validation, vV), trials: N } }));
}
export function promotionGates(v: SlimScore): { name: string; ok: boolean; value: number | null }[] {
  return [
    { name: 'validation_trades>=30', ok: v.trades >= PROMOTE_MIN_TRADES, value: v.trades },
    { name: 'expectancy>0', ok: v.expectancy !== null && v.expectancy > 0, value: v.expectancy },
    { name: 'stress_2x>0', ok: v.stressed_return !== null && v.stressed_return > 0, value: v.stressed_return },
    { name: 'beats_exposure_matched_hold', ok: v.exposure_matched_hold !== null && v.total_return > v.exposure_matched_hold, value: v.exposure_matched_hold === null ? null : v.total_return - v.exposure_matched_hold },
  ];
}
export function withGates(rows: BatchRow[]): BatchRow[] { return rows.map((r) => { const gates = promotionGates(r.validation); return { ...r, gates, promotable: gates.every((g) => g.ok) }; }); }
/** 排行榜:验证段年化夏普降序(null 垫底),同夏普按 id */
export function leaderboard(rows: BatchRow[]): BatchRow[] { return [...rows].sort((a, b) => (b.validation.sharpe ?? -Infinity) - (a.validation.sharpe ?? -Infinity) || a.id.localeCompare(b.id)); }
/** 每族冠军:只用训练段(训练段 ≥ 30 笔的整池行里训练夏普最高;筛资产行的训练成绩是样本内挑出来的,不参评) */
export function familyChampions(rows: BatchRow[]): Map<FamilyKey, BatchRow> {
  const out = new Map<FamilyKey, BatchRow>();
  for (const r of rows) {
    if (r.scope !== 'pool' || r.train.trades < CHAMPION_MIN_TRADES || r.train.sharpe === null) continue;
    const cur = out.get(r.family);
    if (!cur || r.train.sharpe > cur.train.sharpe! || (r.train.sharpe === cur.train.sharpe && r.id < cur.id)) out.set(r.family, r);
  }
  return out;
}
