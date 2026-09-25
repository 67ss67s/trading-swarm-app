/**
 * Overview 的上半区:评分仪表盘(Horizon score)+ 指标网格(截图 12 项 + 「更多指标」)。
 * 指标标签是虚线下划线 + tooltip 解释口径(Horizon 同款交互)。
 */
import { useState } from 'react';
import { ChevronDown, CircleAlert, Info } from 'lucide-react';
import type { BacktestMetrics, BacktestScore } from '@trading-swarm/contracts';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AnimatePresence, motion } from '@/components/research-workbench/motion';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CONFIDENCE_LABEL, SCORE_LABEL, formatMetric, metricTone, moreMetricDefs, primaryMetricDefs, scoreComponentLabel, scoreTone, type MetricDef } from './format';

// ---------------------------------------------------------------------------
// 评分仪表盘

const ARC_START = 135; // 度,0 = 3 点钟方向,顺时针
const ARC_SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, sweep: number): string {
  const [x0, y0] = polar(cx, cy, r, fromDeg);
  const [x1, y1] = polar(cx, cy, r, fromDeg + sweep);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

export function ScoreGauge({ score, trades, compact }: { score: BacktestScore; trades: number | null; compact?: boolean }) {
  const value = Math.max(0, Math.min(100, score.value));
  const tone = scoreTone(score.label);
  const size = compact ? 104 : 120;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 8;
  const sweep = (ARC_SWEEP * value) / 100;
  const [dx, dy] = polar(cx, cy, r, ARC_START + sweep);
  const low = score.confidence === 'low';
  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5" data-testid="score-gauge">
      <div className="text-[13px] font-semibold text-foreground">{t('策略评分')}</div>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="group relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60" aria-label={t('查看评分分项')}>
            <svg width={size} height={size * 0.86} viewBox={`0 0 ${size} ${size * 0.86}`} role="img" aria-label={`${value} ${SCORE_LABEL[score.label]}`}>
              <path d={arcPath(cx, cy, r, ARC_START, ARC_SWEEP)} fill="none" stroke="var(--muted)" strokeWidth={7} strokeLinecap="round" />
              {value > 0 ? (
                <motion.path
                  d={arcPath(cx, cy, r, ARC_START, Math.max(0.5, sweep))}
                  fill="none"
                  stroke={tone.stroke}
                  strokeWidth={7}
                  strokeLinecap="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
                />
              ) : null}
              <circle cx={dx} cy={dy} r={5} fill="var(--card)" stroke={tone.stroke} strokeWidth={2.5} />
              <text x={cx} y={cy + 2} textAnchor="middle" className="num fill-foreground" style={{ fontSize: compact ? 28 : 32, fontWeight: 600 }}>
                {value}
              </text>
              <text x={cx} y={cy + 20} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 11 }}>
                {SCORE_LABEL[score.label]}
              </text>
            </svg>
            <Info className="absolute top-1 right-0 size-3 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3 text-xs" align="start">
          <ScoreBreakdown score={score} />
        </PopoverContent>
      </Popover>
      <span
        className={cn(
          'inline-flex max-w-[15rem] items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium',
          low ? 'bg-warn/15 text-warn' : score.confidence === 'medium' ? 'bg-muted text-foreground/80' : 'bg-up/12 text-up',
        )}
        title={score.confidence_reason}
        data-testid="confidence-badge"
      >
        {low ? <CircleAlert className="size-3 shrink-0" /> : null}
        <span className="truncate">
          {CONFIDENCE_LABEL[score.confidence]}
          {score.confidence_reason ? `, ${score.confidence_reason}` : trades !== null ? `, ${t('{n} 笔成交', { n: trades })}` : ''}
        </span>
      </span>
    </div>
  );
}

function ScoreBreakdown({ score }: { score: BacktestScore }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{t('评分分项')}</span>
        <span className="num text-muted-foreground">{t('加权合计 {n}', { n: score.value })}</span>
      </div>
      {score.components.length === 0 ? <p className="text-muted-foreground">{t('后端没有给出分项。')}</p> : null}
      {score.components.map((c) => (
        <div key={c.key} className="space-y-0.5">
          <div className="flex items-baseline justify-between gap-2">
            <span>{scoreComponentLabel(c.key)}</span>
            <span className="num text-muted-foreground">
              {Math.round(c.value)} × {Math.round(c.weight * 100)}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, c.value))}%` }} />
          </div>
          {c.note ? <div className="text-[10.5px] text-muted-foreground">{c.note}</div> : null}
        </div>
      ))}
      <p className="border-t pt-1.5 text-[10.5px] text-muted-foreground">{score.confidence_reason}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 指标

export function MetricLabel({ defn, className }: { defn: MetricDef; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('cursor-help truncate text-[12px] text-muted-foreground underline decoration-muted-foreground/50 decoration-dotted underline-offset-[3px]', className)}>{defn.label}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 leading-relaxed">
        {defn.help}
      </TooltipContent>
    </Tooltip>
  );
}

export function MetricCell({ defn, metrics }: { defn: MetricDef; metrics: BacktestMetrics | null }) {
  const v = metrics ? metrics[defn.key] : null;
  return (
    <div className="min-w-0 space-y-0.5" data-metric={defn.key}>
      <MetricLabel defn={defn} className="block" />
      <div className={cn('num truncate text-[17px] leading-tight font-semibold', metricTone(defn, v))}>{formatMetric(defn, v)}</div>
    </div>
  );
}

export function MetricsGrid({ metrics, compact, defaultMore = false }: { metrics: BacktestMetrics | null; compact?: boolean; defaultMore?: boolean }) {
  const [more, setMore] = useState(defaultMore);
  // 12 项按 2 / 3 / 6 列排(都能整除),跟着外层 @container 宽度走;compact 最多 3 列
  const cols = compact ? 'grid-cols-2 @md:grid-cols-3' : 'grid-cols-2 @md:grid-cols-3 @4xl:grid-cols-6';
  return (
    <div className="min-w-0 flex-1 space-y-3">
      <div className={cn('grid gap-x-5 gap-y-3.5', cols)} data-testid="metrics-primary">
        {primaryMetricDefs().map((d) => (
          <MetricCell key={d.key} defn={d} metrics={metrics} />
        ))}
      </div>
      <button
        type="button"
        onClick={() => setMore((v) => !v)}
        className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
        aria-expanded={more}
      >
        <ChevronDown className={cn('size-3.5 transition-transform', more && 'rotate-180')} />
        {more ? t('收起更多指标') : t('更多指标({n})', { n: moreMetricDefs().length })}
      </button>
      <AnimatePresence initial={false}>
        {more ? (
          <motion.div
            key="more"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className={cn('grid gap-x-5 gap-y-3.5 border-t border-border/60 pt-3', cols)}
            data-testid="metrics-more"
          >
            {moreMetricDefs().map((d) => (
              <MetricCell key={d.key} defn={d} metrics={metrics} />
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
