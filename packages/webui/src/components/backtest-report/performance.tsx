/**
 * Performance tab:按年收益、月度热力图(年 × 月)、回撤水下图、样本内 vs 样本外对照、各资产横比。
 */
import { useMemo } from 'react';
import type { BacktestAsset, BacktestPeriodReturn, BacktestReport } from '@trade-gate/contracts';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { UnderwaterChart } from './charts';
import { MetricLabel } from './overview';
import { ASSET_STATUS_LABEL, allMetricDefs, assetColor, formatMetric, metricTone, monthShort, num, pctDrawdown, pctSigned, segmentLabel, toneOf, ymd } from './format';
import { underwaterPoints } from './series';

export function Section({ title, extra, children, className }: { title: string; extra?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted-foreground">{children}</div>;
}

// ---------------------------------------------------------------------------
// 按年收益:策略条 + 基准刻度

function YearlyBars({ rows }: { rows: BacktestPeriodReturn[] }) {
  const maxAbs = Math.max(0.0001, ...rows.flatMap((r) => [Math.abs(r.return), Math.abs(r.benchmark ?? 0)]));
  return (
    <div className="space-y-1" data-testid="yearly-returns">
      <div className="grid grid-cols-[3.2rem_1fr_4.6rem_4.6rem] gap-2 text-[10.5px] text-muted-foreground">
        <span>{t('年份')}</span>
        <span />
        <span className="text-right">{t('策略')}</span>
        <span className="text-right">{t('持有基准')}</span>
      </div>
      {rows.map((r) => {
        const w = (Math.abs(r.return) / maxAbs) * 50;
        const bx = r.benchmark === null ? null : 50 + (r.benchmark / maxAbs) * 50;
        return (
          <div key={r.period} className="grid grid-cols-[3.2rem_1fr_4.6rem_4.6rem] items-center gap-2 text-[12px]">
            <span className="num text-muted-foreground">{r.period}</span>
            <div className="relative h-3.5">
              <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
              <div
                className={cn('absolute inset-y-0.5 rounded-[3px]', r.return >= 0 ? 'bg-up/80' : 'bg-down/80')}
                style={r.return >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
                title={`${r.period} ${pctSigned(r.return)}`}
              />
              {bx !== null ? <div className="absolute inset-y-0 w-0.5 rounded bg-foreground/70" style={{ left: `calc(${bx}% - 1px)` }} title={`${t('持有基准')} ${pctSigned(r.benchmark)}`} /> : null}
            </div>
            <span className={cn('num text-right', toneOf(r.return))}>{pctSigned(r.return)}</span>
            <span className={cn('num text-right text-muted-foreground')}>{pctSigned(r.benchmark)}</span>
          </div>
        );
      })}
      <div className="flex items-center gap-3 pt-1 text-[10.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <i className="inline-block h-2 w-3 rounded-[2px] bg-up/80" />/<i className="inline-block h-2 w-3 rounded-[2px] bg-down/80" /> {t('策略')}
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block h-3 w-0.5 bg-foreground/70" /> {t('持有基准')}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 月度热力图:发散色(涨绿跌红,0 为中性灰),透明度按 |收益| / 最大 |收益|

export function monthlyGrid(rows: BacktestPeriodReturn[]): { years: string[]; cell: Map<string, BacktestPeriodReturn>; maxAbs: number } {
  const cell = new Map<string, BacktestPeriodReturn>();
  const years = new Set<string>();
  let maxAbs = 0;
  for (const r of rows) {
    const [y, m] = r.period.split('-');
    if (!y || !m) continue;
    years.add(y);
    cell.set(`${y}-${Number(m)}`, r);
    maxAbs = Math.max(maxAbs, Math.abs(r.return));
  }
  return { years: [...years].sort(), cell, maxAbs };
}

/** 格子里的一位小数百分比;避免 -0.0 */
function cellPct(v: number): string {
  const s = (v * 100).toFixed(1);
  return s === '-0.0' ? '0.0' : s.replace('-', '−');
}

function MonthlyHeatmap({ monthly, yearly }: { monthly: BacktestPeriodReturn[]; yearly: BacktestPeriodReturn[] }) {
  const { years, cell, maxAbs } = useMemo(() => monthlyGrid(monthly), [monthly]);
  const yearMap = useMemo(() => new Map(yearly.map((y) => [y.period, y])), [yearly]);
  const bg = (v: number) => {
    const a = maxAbs > 0 ? 0.12 + 0.68 * Math.min(1, Math.abs(v) / maxAbs) : 0.12;
    if (Math.abs(v) < 1e-6) return 'color-mix(in oklab, var(--muted) 80%, transparent)';
    return `color-mix(in oklab, ${v > 0 ? 'var(--up)' : 'var(--down)'} ${Math.round(a * 100)}%, transparent)`;
  };
  return (
    <div className="overflow-x-auto" data-testid="monthly-heatmap">
      <table className="w-full min-w-[560px] border-separate border-spacing-[2px] text-[10.5px]">
        <thead>
          <tr className="text-muted-foreground">
            <th className="w-10 text-left font-normal" />
            {Array.from({ length: 12 }, (_, m) => (
              <th key={m} className="font-normal">
                {monthShort(m)}
              </th>
            ))}
            <th className="font-normal">{t('全年')}</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => (
            <tr key={y}>
              <td className="num pr-1 text-muted-foreground">{y}</td>
              {Array.from({ length: 12 }, (_, m) => {
                const r = cell.get(`${y}-${m + 1}`);
                return (
                  <td
                    key={m}
                    className={cn('num h-7 rounded-[3px] text-center', r ? 'text-foreground' : 'text-muted-foreground/40')}
                    style={r ? { background: bg(r.return) } : undefined}
                    title={r ? `${r.period} ${t('策略')} ${pctSigned(r.return)} · ${t('持有基准')} ${pctSigned(r.benchmark)}` : undefined}
                  >
                    {r ? cellPct(r.return) : '·'}
                  </td>
                );
              })}
              {(() => {
                const yr = yearMap.get(y);
                return (
                  <td className={cn('num h-7 rounded-[3px] px-1 text-center font-semibold', yr ? toneOf(yr.return) : 'text-muted-foreground')} title={yr ? pctSigned(yr.return) : undefined}>
                    {yr ? cellPct(yr.return) : '—'}
                  </td>
                );
              })()}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10.5px] text-muted-foreground">{t('单元格为当月策略收益(%),颜色深浅按收益幅度;悬停看持有基准。')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 指标对照表(样本内外 / 各资产)

interface Column {
  key: string;
  title: React.ReactNode;
  metrics: BacktestAsset['metrics'];
  note?: string | null;
}

export function MetricsCompareTable({ columns, testId }: { columns: Column[]; testId?: string }) {
  const defs = allMetricDefs();
  return (
    <div className="overflow-x-auto rounded-md border border-border/70" data-testid={testId}>
      <table className="w-full min-w-[420px] text-[12px]">
        <thead>
          <tr className="border-b border-border/70 bg-muted/30 text-[11px] text-muted-foreground">
            <th className="sticky left-0 z-[1] bg-card px-2.5 py-1.5 text-left font-medium">{t('指标')}</th>
            {columns.map((c) => (
              <th key={c.key} className="px-2.5 py-1.5 text-right font-medium">
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {defs.map((d) => (
            <tr key={d.key} className="border-b border-border/40 last:border-0 hover:bg-muted/20">
              <td className="sticky left-0 z-[1] bg-card px-2.5 py-1">
                <MetricLabel defn={d} />
              </td>
              {columns.map((c) => {
                const v = c.metrics ? c.metrics[d.key] : null;
                return (
                  <td key={c.key} className={cn('num px-2.5 py-1 text-right', metricTone(d, v))} title={!c.metrics && c.note ? c.note : undefined}>
                    {formatMetric(d, v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PerformanceTab({ report, asset, compact }: { report: BacktestReport; asset: BacktestAsset | undefined; compact?: boolean }) {
  const completed = asset?.status === 'completed';
  const dd = useMemo(() => (asset && completed ? underwaterPoints(asset) : []), [asset, completed]);
  const maxDd = asset?.metrics ? num(asset.metrics.max_drawdown) : null;
  return (
    <div className="space-y-6">
      {!asset || !completed ? (
        <EmptyNote>{asset ? `${asset.label}:${ASSET_STATUS_LABEL[asset.status]} — ${asset.error ?? t('原因未知')}` : t('没有可展示的资产')}</EmptyNote>
      ) : (
        <>
          <div className={cn('grid gap-6', !compact && '@4xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]')}>
            <Section title={t('按年收益')}>{asset.yearly_returns.length ? <YearlyBars rows={asset.yearly_returns} /> : <EmptyNote>{t('无年度数据')}</EmptyNote>}</Section>
            <Section title={t('月度收益')}>{asset.monthly_returns.length ? <MonthlyHeatmap monthly={asset.monthly_returns} yearly={asset.yearly_returns} /> : <EmptyNote>{t('无月度数据')}</EmptyNote>}</Section>
          </div>
          <Section
            title={t('回撤水下图')}
            extra={
              <span className="text-[11.5px] text-muted-foreground">
                {t('最大回撤')} <span className="num text-down">{pctDrawdown(maxDd)}</span>
                <span className="mx-1.5">·</span>
                {t('最长回撤时长')} <span className="num text-foreground">{formatMetric({ kind: 'dur' }, asset.metrics?.max_drawdown_duration_ms)}</span>
              </span>
            }
          >
            <div className={cn('rounded-md border border-border/60', compact ? 'h-40' : 'h-52')}>
              <UnderwaterChart points={dd} segments={report.segments} />
            </div>
          </Section>
          <Section title={t('样本内 vs 样本外')}>
            {asset.segments.length ? (
              <MetricsCompareTable
                testId="segment-compare"
                columns={asset.segments.map((s) => ({
                  key: s.name,
                  title: (
                    <span className="inline-flex flex-col items-end leading-tight">
                      <span className={s.name === 'out_of_sample' ? 'text-primary' : undefined}>{segmentLabel(s.name)}</span>
                      <span className="num text-[10px] font-normal text-muted-foreground">
                        {ymd(s.from_ms)} → {ymd(s.to_ms)}
                      </span>
                    </span>
                  ),
                  metrics: s.metrics,
                }))}
              />
            ) : (
              <EmptyNote>{t('这次回测没有切分样本内 / 样本外')}</EmptyNote>
            )}
          </Section>
        </>
      )}
      <Section title={t('各资产横比')}>
        <MetricsCompareTable
          testId="asset-compare"
          columns={report.assets.map((a) => ({
            key: a.key,
            title: (
              <span className="inline-flex items-center gap-1.5">
                <i className="inline-block h-0.5 w-3 rounded-full" style={{ background: assetColor(report, a.key) }} />
                {a.label}
                {a.status !== 'completed' ? <span className="rounded-sm bg-warn/15 px-1 text-[10px] text-warn">{ASSET_STATUS_LABEL[a.status]}</span> : null}
              </span>
            ),
            metrics: a.metrics,
            note: a.error,
          }))}
        />
      </Section>
    </div>
  );
}
