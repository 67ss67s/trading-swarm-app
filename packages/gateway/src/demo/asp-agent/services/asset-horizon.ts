/**
 * 服务一「资产 × 周期推荐」:把 §9.53 A 的 recommend()(代码计算、零模型)包成按次服务。
 * 输入(全可选):symbols ≤12、horizons short|mid|long、market spot|perp、top_n 1–12。都不给 = 全市场扫描 + 雷达三档。
 */
import { HORIZON_LABEL, HORIZONS, type Horizon as RecHorizon } from '../../recommend.js';
import { freeText, horizonsIn, jsonParams, marketIn, symbolList, symbolsIn } from './params.js';
import { deliverable } from './render.js';
import { ServiceInputError, type PerCallService } from './types.js';

export interface AssetHorizonParams { symbols?: string[]; horizons?: RecHorizon[]; market: 'spot' | 'perp'; top_n: number }

const REGIME_TEXT: Record<string, string> = { bull: '多头 bull', bear: '空头 bear', range: '震荡 range', volatile: '高波动 volatile' };
const DIR_TEXT: Record<string, string> = { long: '做多 long', short: '做空 short', both: '双向 both' };

export const assetHorizonService: PerCallService<AssetHorizonParams> = {
  key: 'asset_horizon',
  validate(job) {
    const p = jsonParams(job) ?? {}, text = freeText(job);
    const found = symbolsIn(text, 12);
    const symbols = symbolList(p['symbols'], 12) ?? (found.length ? found : undefined);
    const top = p['top_n'] === undefined ? 8 : Number(p['top_n']);
    if (!Number.isInteger(top) || top < 1 || top > 12) throw new ServiceInputError('top_n_invalid', 'top_n 必须是 1–12 的整数');
    const horizons = horizonsIn(p['horizons'], text);
    return { ...(symbols ? { symbols } : {}), ...(horizons ? { horizons } : {}), market: marketIn(p['market'], text), top_n: top };
  },
  async handle(job, params, deps) {
    const rec = await deps.recommend(params);
    const horizons = params.horizons ?? [...HORIZONS];
    const picks: Record<string, string[]> = Object.fromEntries(horizons.map((h) => [h, rec.rows.filter((r) => r.horizons[h].eligible).map((r) => r.symbol)]));
    const summary = rec.rows.length
      ? `资产×周期推荐 / Asset × horizon: ${horizons.map((h) => `${HORIZON_LABEL[h]} ${picks[h]!.length ? picks[h]!.map((s) => s.replace(/USDT$/, '')).join('、') : '无 none'}`).join(' · ')}`
      : '没有可推荐的资产 / No eligible assets';
    const lines = rec.rows.map((r) => {
      const hs = horizons.map((h) => {
        const f = r.horizons[h];
        return f.eligible ? `${HORIZON_LABEL[h]}✓ ${DIR_TEXT[f.direction ?? ''] ?? ''} ${f.families.join('/')}` : `${HORIZON_LABEL[h]}✗ ${f.reason ?? ''}`;
      }).join(' | ');
      return `· ${r.symbol} ${r.regime ? REGIME_TEXT[r.regime] ?? r.regime : '日线状态未知'} — ${hs}`;
    });
    if (rec.warnings.length) lines.push(`注意 / Notes: ${rec.warnings.join(';')}`);
    return deliverable(job, 'asset_horizon', '【资产×周期推荐 / Asset × Horizon Picks】 Trading Swarm', summary, lines, {
      recommendation_id: rec.id, as_of: rec.as_of, market: params.market, horizons, picks,
      rows: rec.rows.map((r) => ({
        symbol: r.symbol, regime: r.regime, quote_vol_24h: r.quote_vol_24h, scan_rank: r.scan?.rank ?? null,
        radar_rank: Object.fromEntries(Object.entries(r.radar).map(([h, v]) => [h, v?.rank ?? null])),
        horizons: Object.fromEntries(horizons.map((h) => { const f = r.horizons[h]; return [h, { eligible: f.eligible, direction: f.direction, families: f.families, reason: f.reason, evidence: f.evidence.slice(0, 3) }]; })),
      })),
      warnings: rec.warnings, source: rec.source,
      method: '代码计算、零模型:流动性门槛 + 日线状态(regime)→ 方向与策略族 + 全市场扫描名次 + 雷达三档名次 / rule-based, no LLM',
    });
  },
};
