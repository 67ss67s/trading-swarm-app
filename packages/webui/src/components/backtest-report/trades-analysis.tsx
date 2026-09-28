/**
 * Trades analysis tab:单笔收益直方图、持仓时长直方图、退出原因分布、盈亏连击、多空占比、计划统计。
 * 直方图:bins 长度 = counts + 1 时按区间边界读;等长时按区间左端点读。
 */
import { useMemo } from 'react';
import type { BacktestAsset, BacktestPlanStats, BacktestTrade } from '@trade-gate/contracts';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EmptyNote, Section } from './performance';
import { exitReasonLabel, pctPlain, pctSigned, ratio, tradeCenter, usdPlain } from './format';
import { assetPlanStats } from './plans';

interface Bar {
  label: string;
  count: number;
  tone: 'up' | 'down' | 'neutral';
  title: string;
}

export function histogramBars(h: { bins: number[]; counts: number[] }, fmt: (v: number) => string, signed: boolean): Bar[] {
  const edges = h.bins.length === h.counts.length + 1;
  return h.counts.map((count, i) => {
    const lo = h.bins[i];
    const hi = edges ? h.bins[i + 1] : h.bins[i + 1];
    const label = lo === undefined ? String(i) : hi === undefined ? `≥${fmt(lo)}` : `${fmt(lo)}~${fmt(hi)}`;
    const mid = lo === undefined ? 0 : hi === undefined ? lo : (lo + hi) / 2;
    return { label, count, tone: signed ? (mid > 0 ? 'up' : mid < 0 ? 'down' : 'neutral') : 'neutral', title: `${label}: ${count}` };
  });
}

function Histogram({ bars, testId }: { bars: Bar[]; testId?: string }) {
  const max = Math.max(1, ...bars.map((b) => b.count));
  return (
    <div data-testid={testId}>
      <div className="flex h-36 items-end gap-[2px]">
        {bars.map((b, i) => (
          <div key={i} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end" title={b.title}>
            <span className="num mb-0.5 text-center text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">{b.count}</span>
            <div
              className={cn('w-full rounded-t-[4px]', b.tone === 'up' ? 'bg-up/80' : b.tone === 'down' ? 'bg-down/80' : 'bg-primary/70', b.count === 0 && 'opacity-30')}
              style={{ height: `${Math.max(b.count ? 3 : 1, (b.count / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px]">
        {bars.map((b, i) => (
          <span key={i} className="num min-w-0 flex-1 truncate text-center text-[9.5px] text-muted-foreground" title={b.label}>
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function HBarList({ rows, total }: { rows: { key: string; label: string; count: number; className?: string }[]; total: number }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[6.5rem_1fr_5rem] items-center gap-2 text-[12px]">
          <span className="truncate text-foreground/90" title={r.label}>
            {r.label}
          </span>
          <div className="h-2.5 overflow-hidden rounded-full bg-muted/60">
            <div className={cn('h-full rounded-full', r.className ?? 'bg-primary/70')} style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
          <span className="num text-right text-muted-foreground">
            {r.count} · {total ? pctPlain(r.count / total, 0) : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

function exitTone(reason: string): string {
  if (reason === 'stop_loss' || reason === 'liquidation' || reason === 'sl') return 'bg-down/75';
  if (reason === 'take_profit' || reason === 'tp') return 'bg-up/75';
  return 'bg-primary/65';
}

function StreakStrip({ trades }: { trades: BacktestTrade[] }) {
  const shown = trades.slice(-240);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-[2px]" aria-label={t('按平仓顺序的盈亏序列')}>
        {shown.map((tr) => (
          <span key={tr.id} className={cn('h-3 w-1.5 rounded-[2px]', tr.pnl > 0 ? 'bg-up/80' : 'bg-down/80')} title={`${tr.symbol} ${pctSigned(tr.return_pct)}`} />
        ))}
      </div>
      {trades.length > shown.length ? <p className="text-[10.5px] text-muted-foreground">{t('只显示最近 {n} 笔', { n: shown.length })}</p> : null}
    </div>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border/60 px-2.5 py-2" title={hint}>
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('num truncate text-[16px] font-semibold', tone ?? 'text-foreground')}>{value}</div>
    </div>
  );
}

export function PlanStatsBlock({ stats }: { stats: BacktestPlanStats }) {
  const r = (v: number | null) => (v === null ? '—' : `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`);
  return (
    <div className="space-y-3" data-testid="plan-stats">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
        <Stat label={t('成交率')} value={pctPlain(stats.fill_rate)} hint={t('成交的计划 / 挂出的计划')} />
        <Stat label={t('止盈命中率')} value={pctPlain(stats.tp_hit_rate)} tone={stats.tp_hit_rate ? 'text-up' : undefined} hint={t('已结束的成交计划里,以止盈离场(或命中过止盈)的比例')} />
        <Stat label={t('止损命中率')} value={pctPlain(stats.sl_hit_rate)} tone={stats.sl_hit_rate ? 'text-down' : undefined} hint={t('已结束的成交计划里,以止损离场的比例')} />
        <Stat label={t('平均计划盈亏比')} value={ratio(stats.avg_planned_rr)} hint={t('下单时首档止盈距离 / 止损距离')} />
        <Stat
          label={t('平均实际 R')}
          value={r(stats.avg_realized_r)}
          tone={stats.avg_realized_r === null ? undefined : stats.avg_realized_r >= 0 ? 'text-up' : 'text-down'}
          hint={t('实际盈亏 / 计划单位风险(入场到止损的距离)')}
        />
        {stats.funding_pnl !== undefined && stats.funding_pnl !== null ? <Stat label={t('资金费合计')} value={`${stats.funding_pnl < 0 ? '−' : '+'}${usdPlain(Math.abs(stats.funding_pnl))}`} tone={stats.funding_pnl >= 0 ? 'text-up' : 'text-down'} hint={t('永续计划资金费现金合计(正=收到);共 {n} 期', { n: stats.funding_periods ?? 0 })} /> : null}
        {stats.liquidation_loss !== undefined && stats.liquidation_loss !== null ? <Stat label={t('强平亏损')} value={`−${usdPlain(Math.abs(stats.liquidation_loss))}`} tone="text-down" hint={t('被强平计划的净亏损合计')} /> : null}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 text-[12px]">
        {(
          [
            ['placed', t('挂出'), stats.placed],
            ['filled', t('成交'), stats.filled],
            ['no_fill', t('未成交'), stats.no_fill],
            ['replaced', t('被替换'), stats.replaced],
            ['rolled', t('滚动换仓'), stats.rolled],
            ['added', t('加仓'), stats.added],
            ['flipped', t('反手'), stats.flipped],
            ['liquidated', t('强平'), stats.liquidated],
          ] as const
        ).map(([k, label, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 rounded-md bg-muted/40 px-2 py-1">
            <span className="truncate text-muted-foreground">{label}</span>
            <span className={cn('num font-medium', k === 'liquidated' && v > 0 ? 'text-down' : 'text-foreground')}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TradesAnalysisTab({ asset, compact }: { asset: BacktestAsset | undefined; compact?: boolean }) {
  const trades = asset?.trades ?? [];
  const stats = asset?.trade_stats ?? null;
  const planStats = useMemo(() => assetPlanStats(asset), [asset]);
  const exitRows = useMemo(() => {
    const src = stats?.exit_reasons ?? trades.reduce<Record<string, number>>((m, tr) => ((m[tr.exit_reason] = (m[tr.exit_reason] ?? 0) + 1), m), {});
    return Object.entries(src)
      .sort((a, b) => b[1] - a[1])
      .map(([k, c]) => ({ key: k, label: exitReasonLabel(k), count: c, className: exitTone(k) }));
  }, [stats, trades]);

  if (!asset || asset.status !== 'completed') return <EmptyNote>{asset?.error ?? t('没有可展示的资产')}</EmptyNote>;
  const total = asset.metrics?.trades ?? trades.length;
  if (total === 0 && trades.length === 0) {
    return (
      <div className="space-y-6">
        <EmptyNote>{t('无成交:这段窗口里策略一笔都没有触发。')}</EmptyNote>
        {planStats ? (
          <Section title={t('计划统计')}>
            <PlanStatsBlock stats={planStats} />
          </Section>
        ) : null}
      </div>
    );
  }
  const long = stats?.long_trades ?? trades.filter((x) => x.side === 'long').length;
  const short = stats?.short_trades ?? trades.filter((x) => x.side === 'short').length;
  const sides = long + short;
  const m = asset.metrics;
  // 平均旁边给中位数与截尾均值:逐笔收益从报告交易列表派生(列表被截断时 hint 里写明按多少笔算)
  const center = tradeCenter(trades.map((x) => x.return_pct));
  const centerHint = `${t('按 {n} 笔', { n: center.n })}${center.n < total ? ` / ${total}` : ''} · ${center.trimmed_each_side ? t('两端各截 {k} 笔(10%)', { k: center.trimmed_each_side }) : t('不足 10 笔,不截尾')}`;
  const toneOf = (v: number | null) => (v === null ? undefined : v >= 0 ? 'text-up' : 'text-down');
  const pctFmt = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="space-y-6">
      <div className={cn('grid gap-6', !compact && '@3xl:grid-cols-2')}>
        <Section title={t('单笔收益分布')}>
          {stats?.return_histogram.counts.length ? <Histogram testId="return-histogram" bars={histogramBars(stats.return_histogram, pctFmt, true)} /> : <EmptyNote>{t('后端未给出分布')}</EmptyNote>}
        </Section>
        <Section title={t('持仓时长分布(K 线根数)')}>
          {stats?.holding_histogram.counts.length ? <Histogram testId="holding-histogram" bars={histogramBars(stats.holding_histogram, (v) => String(Math.round(v)), false)} /> : <EmptyNote>{t('后端未给出分布')}</EmptyNote>}
        </Section>
      </div>
      <div className={cn('grid gap-6', !compact && '@3xl:grid-cols-2')}>
        <Section title={t('退出原因')}>
          <HBarList rows={exitRows} total={exitRows.reduce((a, r) => a + r.count, 0)} />
        </Section>
        <Section title={t('多空占比')}>
          <div className="space-y-2">
            <div className="flex h-3 overflow-hidden rounded-full bg-muted/60">
              {long > 0 ? <div className="h-full bg-up/80" style={{ width: `${(long / Math.max(1, sides)) * 100}%` }} title={`${t('做多')} ${long}`} /> : null}
              {short > 0 ? <div className="h-full bg-down/80" style={{ width: `${(short / Math.max(1, sides)) * 100}%` }} title={`${t('做空')} ${short}`} /> : null}
            </div>
            <div className="flex justify-between text-[12px]">
              <span className="text-up">
                {t('做多')} <span className="num">{long}</span> · <span className="num">{sides ? pctPlain(long / sides, 0) : '—'}</span>
              </span>
              <span className="text-down">
                {t('做空')} <span className="num">{short}</span> · <span className="num">{sides ? pctPlain(short / sides, 0) : '—'}</span>
              </span>
            </div>
            {short === 0 ? <p className="text-[10.5px] text-muted-foreground">{t('当前策略只做多。')}</p> : null}
          </div>
        </Section>
      </div>
      <Section title={t('盈亏连击')}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
          <Stat label={t('最长连胜')} value={String(m?.max_win_streak ?? '—')} tone="text-up" />
          <Stat label={t('最长连亏')} value={String(m?.max_loss_streak ?? '—')} tone="text-down" />
          <Stat label={t('胜率')} value={pctPlain(m?.win_rate)} />
          <Stat label={t('单笔期望')} value={pctSigned(m?.expectancy)} tone={m?.expectancy == null ? undefined : m.expectancy >= 0 ? 'text-up' : 'text-down'} />
          <Stat label={t('单笔中位数')} value={pctSigned(center.median)} tone={toneOf(center.median)} hint={centerHint} />
          <Stat label={t('截尾均值')} value={pctSigned(center.trimmed_mean)} tone={toneOf(center.trimmed_mean)} hint={centerHint} />
        </div>
        {trades.length ? <StreakStrip trades={[...trades].sort((a, b) => a.exit_at - b.exit_at)} /> : null}
      </Section>
      {planStats ? (
        <Section title={t('计划统计')}>
          <PlanStatsBlock stats={planStats} />
        </Section>
      ) : null}
    </div>
  );
}
