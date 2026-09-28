/**
 * 概览大图下面的「看区间」条:预设(今年 / 近 3、6 个月 / 近 1 年 / 全部)+ 刷选条 + 区间指标。
 * 区间指标只从报告已有的逐点净值与逐笔交易派生(range.ts rangeStats),不重跑、不扣期初持仓;
 * 想要从空仓开始的真实区间结果,点「按此区间重跑」。
 */
import type { BacktestAsset, BacktestReport } from '@trade-gate/contracts';
import { Info, X } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { pctDrawdown, pctSigned, toneOf, ymd } from './format';
import { RANGE_PRESET_KEYS, matchViewPreset, rangeStats, spanDays, tfMillis, viewPreset, type TimeRange } from './range';
import { RangeBrush } from './range-brush';
import { RangeRerunButton, presetLabel } from './range-rerun';

export interface RangeToolbarProps {
  report: BacktestReport;
  asset: BacktestAsset | undefined;
  value: TimeRange | null;
  onChange: (r: TimeRange | null) => void;
  onRerunDone?: (reportId: string) => void;
  /** false = 不显示重跑按钮 */
  rerun?: boolean;
}

export function RangeToolbar({ report, asset, value, onChange, onRerunDone, rerun = true }: RangeToolbarProps) {
  const window: TimeRange = report.window;
  const step = tfMillis(report.timeframe);
  const active = matchViewPreset(value, window, step);
  const stats = useMemo(() => (value && asset?.status === 'completed' ? rangeStats(asset, value) : null), [asset, value]);
  return (
    <div className="space-y-2" data-testid="range-toolbar">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[11.5px] text-muted-foreground">{t('看区间')}</span>
        {RANGE_PRESET_KEYS.map((k) => {
          const w = viewPreset(k, window);
          const disabled = k !== 'all' && w === null;
          return (
            <button
              key={k}
              type="button"
              disabled={disabled}
              aria-pressed={active === k}
              onClick={() => onChange(w)}
              className={cn(
                'h-6 rounded-md border px-2 text-[11.5px] transition-colors disabled:opacity-40',
                active === k ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {presetLabel(k)}
            </button>
          );
        })}
        {rerun ? <RangeRerunButton report={report} selection={value} onDone={onRerunDone} size="xs" variant="ghost" className="ml-auto text-primary" label={value ? t('按此区间重跑') : t('换区间重跑')} /> : null}
      </div>
      <RangeBrush asset={asset?.status === 'completed' ? asset : null} window={window} value={value} onChange={onChange} minSpan={3 * step} />
      {value ? (
        <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2" data-testid="range-stats">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
            <span className="num font-semibold text-foreground">
              {ymd(value.from_ms)} → {ymd(value.to_ms)}
            </span>
            <span className="text-muted-foreground">· {t('{n} 天', { n: spanDays(value) })}</span>
            {asset ? <span className="text-muted-foreground">· {asset.label}</span> : null}
            <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label={t('回到全部')} title={t('回到全部')} onClick={() => onChange(null)}>
              <X />
            </Button>
          </div>
          {stats ? (
            <>
              <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5 @md:grid-cols-4">
                <Stat k={t('区间收益')} v={pctSigned(stats.ret)} tone={toneOf(stats.ret)} testid="range-ret" />
                <Stat k={t('区间持有收益')} v={pctSigned(stats.bench)} tone={toneOf(stats.bench)} testid="range-bench" />
                <Stat k={t('区间最大回撤')} v={pctDrawdown(stats.max_dd)} tone={stats.max_dd > 0 ? 'text-down' : 'text-foreground'} testid="range-dd" />
                <Stat k={t('区间笔数')} v={stats.trades ? t('{n} 笔 · 胜 {w}', { n: stats.trades, w: stats.wins }) : t('0 笔')} tone="text-foreground" testid="range-trades" />
              </dl>
              <p className="mt-1.5 flex items-start gap-1 text-[10.5px] text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="mt-px size-3 shrink-0 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-[11px]">
                    {t('区间收益 = 区间终点净值 / 起点净值 − 1;持有收益同理用持有基准;回撤峰值只在区间内找;笔数 = 区间内平仓的交易。净值点可能已抽稀,回撤可能略小于逐根计算。')}
                  </TooltipContent>
                </Tooltip>
                <span>
                  {t('区间内派生,未扣期初持仓,不是重跑。')}
                  {stats.open_at_start ? <span className="text-warn"> {t('区间起点时已有持仓,收益含这笔仓位的区间内盈亏。')}</span> : null}
                  {stats.carried_in ? <span> {t('{n} 笔在区间前入场、区间内平仓,已计入笔数。', { n: stats.carried_in })}</span> : null}
                  {stats.trades > 0 && stats.trades < 30 ? <span> {t('不足 30 笔,只能当观察。')}</span> : null}
                </span>
              </p>
            </>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">{t('这段区间里净值点不足两个,算不出区间指标。')}</p>
          )}
        </div>
      ) : (
        <p className="text-[10.5px] text-muted-foreground">{t('拖动时间条,或在图上滚轮缩放 / 拖动平移,看任意一段的区间指标。')}</p>
      )}
    </div>
  );
}

function Stat({ k, v, tone, testid }: { k: string; v: string; tone: string; testid: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] text-muted-foreground">{k}</dt>
      <dd className={cn('num text-[14px] font-semibold', tone)} data-testid={testid}>
        {v}
      </dd>
    </div>
  );
}
