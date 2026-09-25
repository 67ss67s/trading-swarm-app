/**
 * 对话里的推荐卡(§9.53 A):资产 × 短/中/长,每格适不适合 + 方向 + 建议策略族,悬停看证据(全是代码算的数)。
 * 「去研究台验证」→ #matrix-study?from=<recommendation_id>,矩阵研究页据此预填(只带 eligible 的格子)。
 */
import { FlaskConical, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HORIZONS, HORIZON_TIMEFRAMES, useRecommendation, type FamilyKey, type Horizon, type HorizonFit, type RegimeKind } from '@/api/recommend';
import { fmtClock } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

const HORIZON_TEXT: Record<Horizon, string> = tmap({ short: '短线', mid: '中线', long: '长线' });
const REGIME_TEXT: Record<RegimeKind, string> = tmap({ bull: '多头', bear: '空头', range: '震荡', volatile: '高波动' });
const DIR_TEXT: Record<'long' | 'short' | 'both', string> = tmap({ long: '做多', short: '做空', both: '双向' });
export const FAMILY_TEXT: Record<FamilyKey, string> = tmap({
  breakout: '突破', ma_trend: '均线趋势', ema_cross: '均线金叉', pullback: '回踩', mean_reversion: '均值回归', smc: 'SMC 结构', xsmom: '横截面动量', carry: '资金费套利',
});
const REASON_TEXT: Record<string, string> = tmap({
  liquidity: '流动性不够', history: '历史太短', regime: '行情不合', excluded: '已排除', unknown_asset: '找不到', no_market: '无该市场', not_requested: '未请求',
});

function Cell({ fit }: { fit: HorizonFit }) {
  const body = fit.eligible ? (
    <div className="flex flex-col gap-0.5">
      <span className={cn('text-[11px] font-medium', fit.direction === 'short' ? 'text-down' : 'text-up')}>{fit.direction ? DIR_TEXT[fit.direction] : '—'}</span>
      <span className="text-[10px] leading-tight text-muted-foreground">{fit.families.slice(0, 3).map((f) => FAMILY_TEXT[f]).join(' · ')}</span>
    </div>
  ) : (
    <span className="text-[11px] text-muted-foreground">{fit.reason ? REASON_TEXT[fit.reason] ?? fit.reason : t('不适合')}</span>
  );
  if (!fit.evidence.length) return <div className="min-h-9 px-1.5 py-1">{body}</div>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('min-h-9 cursor-default rounded px-1.5 py-1', fit.eligible ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-muted')}>{body}</div>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <ul className="space-y-0.5 text-[11px]">
          {fit.evidence.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

export function RecommendationCard({ id }: { id: string }) {
  const q = useRecommendation(id);
  if (q.isLoading) return <div className="mt-2 h-16 animate-pulse rounded-md border bg-background/60" />;
  if (q.isError || !q.data) return <p className="mt-2 text-[11px] text-muted-foreground">{t('推荐卡加载失败')}</p>;
  const r = q.data;
  const eligible = r.rows.reduce((n, row) => n + HORIZONS.filter((h) => row.horizons[h].eligible).length, 0);
  return (
    <div className="mt-2 w-full overflow-hidden rounded-md border bg-background text-foreground">
      <div className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5">
        <span className="text-[12px] font-medium">{t('资产 × 周期推荐')}</span>
        <span className="num text-[10px] text-muted-foreground">{t('{n} 格可研究', { n: eligible })} · {fmtClock(r.as_of)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-[10px] text-muted-foreground">
              <th className="px-2 py-1 font-normal">{t('资产')}</th>
              {HORIZONS.map((h) => (
                <th key={h} className="px-1.5 py-1 font-normal">
                  {HORIZON_TEXT[h]} <span className="num opacity-70">{HORIZON_TIMEFRAMES[h].join('/')}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.rows.map((row) => (
              <tr key={row.symbol} className="border-t align-top">
                <td className="px-2 py-1">
                  <div className="num text-[12px] font-medium">{row.symbol.replace(/USDT$/, '')}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {row.regime ? REGIME_TEXT[row.regime] : t('日线未知')}
                    {row.scan ? ` · #${row.scan.rank}` : ''}
                  </div>
                </td>
                {HORIZONS.map((h) => (
                  <td key={h} className="p-0.5">
                    <Cell fit={row.horizons[h]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.warnings.length ? (
        <div className="flex items-start gap-1 border-t px-2.5 py-1 text-[10px] text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          <span>{r.warnings.join(';')}</span>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 border-t px-2.5 py-1.5">
        <span className="text-[10px] text-muted-foreground">{t('推荐只说明值得研究,赚不赚要看回测')}</span>
        <Button size="sm" className="h-7 gap-1 text-[12px]" disabled={!eligible} onClick={() => { window.location.hash = `matrix-study?from=${encodeURIComponent(r.id)}`; }}>
          <FlaskConical className="size-3.5" />
          {t('去研究台验证')}
        </Button>
      </div>
    </div>
  );
}
