/**
 * Horizon 式回测报告面板(§9.46)。布局对齐 Horizon 策略详情:
 *   头部:策略图标 + 名称 + 一句描述 + 窗口起止徽章;右侧 版本 / 设置 / 分享 / 自动化
 *   Tab:概览 / 表现 / 交易分析 / 交易列表 / 策略回放
 *   概览:左侧评分仪表盘 + 置信标签,右侧指标网格;下面「累计盈亏 x% (+$y)」大图
 * 颜色走站点 token(荧光绿 primary、up/down 语义色),不照抄 Horizon 蓝。
 * 外层是 @container,compact(研究页右栏 520–700px)时靠容器查询自动换行。
 */
import { isValidElement, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, CircleAlert, Download, GitCompareArrows, Layers, Maximize2, Settings2, Share2, Tag, TriangleAlert, Workflow } from 'lucide-react';
import type { BacktestAsset, BacktestReport } from '@trade-gate/contracts';
import { researchApi } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PnlChart } from './charts';
import { ASSET_STATUS_LABEL, CONFIDENCE_LABEL, assetColor, defaultAssetKey, pctSigned, toneOf, usdSigned } from './format';
import { MetricsGrid, ScoreGauge } from './overview';
import { PerformanceTab } from './performance';
import { Provenance, WindowBadge } from './provenance';
import type { TimeRange } from './range';
import { RangeRerunButton } from './range-rerun';
import { RangeToolbar } from './range-view';
import { ReplayTab, type ReplayLoader } from './replay-tab';
import { ALL_ASSETS, buildPnlSeries, downloadText, equityCsv } from './series';
import { TradesAnalysisTab } from './trades-analysis';
import { TradesTable } from './trades-table';

export interface BacktestReportHeaderConfig {
  title: string;
  description?: string;
  versionLabel?: string;
  onSettings?: () => void;
  onShare?: () => void;
  onAutomate?: () => void;
  automateLabel?: string;
}

export type BacktestReportTab = 'overview' | 'performance' | 'trades' | 'list' | 'replay';

export interface BacktestReportViewProps {
  report: BacktestReport;
  /** ReactNode = 整块替换头部;对象 = 用默认头部布局,填入标题 / 按钮回调;不传 = 用报告自己的 title / description */
  header?: ReactNode | BacktestReportHeaderConfig;
  /** 研究页右栏(约 520–700px):图更矮、间距更紧 */
  compact?: boolean;
  className?: string;
  /** 初始 tab / 资产 / 叠加模式(测试与深链接用) */
  defaultTab?: BacktestReportTab;
  defaultAssetKey?: string;
  defaultOverlay?: boolean;
  /** 默认展开「更多指标」 */
  defaultMoreMetrics?: boolean;
  /** 回放数据来源;默认 researchApi.backtestReplay(report.id, …)。fixture / 测试时注入 */
  replayLoader?: ReplayLoader;
  /** 「按此区间重跑」;false = 不显示(fixture / 只读场景)。默认显示 */
  rangeRerun?: boolean;
  /** 区间重跑出新报告后;不传 = 跳到 #backtest?id=<新 id> */
  onRerunDone?: (reportId: string) => void;
  /** 初始看区间(测试与深链接用) */
  defaultRange?: TimeRange | null;
}

function isHeaderConfig(h: unknown): h is BacktestReportHeaderConfig {
  return !!h && typeof h === 'object' && !isValidElement(h) && typeof (h as { title?: unknown }).title === 'string';
}

// ---------------------------------------------------------------------------
// 头部

function ReportHeader({ report, header, compact, rerun }: { report: BacktestReport; header: BacktestReportViewProps['header']; compact?: boolean; rerun?: ReactNode }) {
  if (header !== undefined && header !== null && !isHeaderConfig(header)) return <>{header}</>;
  const cfg: BacktestReportHeaderConfig = isHeaderConfig(header) ? header : { title: report.title, description: report.description };
  const version = cfg.versionLabel ?? (report.strategy_version !== null ? `v${report.strategy_version}` : null);
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3" data-testid="report-header">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className={cn('flex shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/25', compact ? 'size-9' : 'size-11')}>
          <Activity className={compact ? 'size-4.5' : 'size-5.5'} />
        </div>
        <div className="min-w-0 space-y-1">
          <h2 className={cn('truncate font-semibold text-foreground', compact ? 'text-[15px]' : 'text-[18px]')}>{cfg.title || report.title}</h2>
          {cfg.description ?? report.description ? <p className="line-clamp-2 text-[12.5px] text-muted-foreground">{cfg.description ?? report.description}</p> : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <WindowBadge report={report} />
            {rerun}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {version ? (
          <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-foreground">
            <Tag className="size-3.5 text-muted-foreground" />
            {version}
          </span>
        ) : null}
        {cfg.onSettings ? (
          <Button variant="outline" size="sm" onClick={cfg.onSettings}>
            <Settings2 />
            {t('设置')}
          </Button>
        ) : null}
        {cfg.onShare ? (
          <Button variant="outline" size="sm" onClick={cfg.onShare}>
            <Share2 />
            {t('分享')}
          </Button>
        ) : null}
        {cfg.onAutomate ? (
          <Button size="sm" onClick={cfg.onAutomate}>
            <Workflow />
            {cfg.automateLabel ?? t('自动化')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 概览:PnL 大图

function AssetChips({ report, assetKey, overlay, onPick, onOverlay }: { report: BacktestReport; assetKey: string; overlay: boolean; onPick: (k: string) => void; onOverlay: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label={t('资产')} data-testid="asset-chips">
      {report.assets.map((a) => {
        const active = !overlay && a.key === assetKey;
        return (
          <button
            key={a.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onPick(a.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px] transition-colors',
              active ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
              a.status !== 'completed' && 'border-dashed',
            )}
            title={a.status !== 'completed' ? `${ASSET_STATUS_LABEL[a.status]}:${a.error ?? ''}` : a.symbols.join(' + ')}
          >
            <i className="inline-block h-0.5 w-2.5 rounded-full" style={{ background: assetColor(report, a.key) }} />
            {a.label}
            {a.status !== 'completed' ? <TriangleAlert className="size-3 text-warn" /> : null}
          </button>
        );
      })}
      {report.assets.length > 1 ? (
        <button
          type="button"
          role="tab"
          aria-selected={overlay}
          onClick={onOverlay}
          className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] transition-colors', overlay ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}
        >
          <Layers className="size-3.5" />
          {t('全部叠加')}
        </button>
      ) : null}
    </div>
  );
}

function PnlSection({
  report,
  asset,
  assetKey,
  overlay,
  setAsset,
  setOverlay,
  compact,
  range,
  setRange,
  rerun,
  onRerunDone,
}: {
  report: BacktestReport;
  asset: BacktestAsset | undefined;
  assetKey: string;
  overlay: boolean;
  setAsset: (k: string) => void;
  setOverlay: (v: boolean) => void;
  compact?: boolean;
  range: TimeRange | null;
  setRange: (r: TimeRange | null) => void;
  rerun: boolean;
  onRerunDone?: (reportId: string) => void;
}) {
  const [compare, setCompare] = useState(true);
  const [full, setFull] = useState(false);
  const mode = overlay ? ALL_ASSETS : assetKey;
  const series = useMemo(() => buildPnlSeries(report, mode, compare), [report, mode, compare]);
  const m = asset?.metrics ?? null;
  const drawn = report.assets.filter((a) => series.lines.some((l) => l.assetKey === a.key && l.role === 'strategy'));
  const noTrades = !overlay && asset?.status === 'completed' && (m?.trades ?? asset.trades.length) === 0;
  const notice = (
    <>
      {noTrades ? (
        <span className="inline-flex w-fit items-center gap-1 rounded-md bg-muted/90 px-2 py-0.5 text-[11px] text-foreground/90" data-testid="no-trades-notice">
          {t('无成交')}
          {series.forcedBenchmark ? <span className="text-muted-foreground">· {t('仍画出持有基准')}</span> : null}
        </span>
      ) : null}
      {overlay && series.missing.length
        ? series.missing.map((a) => (
            <span key={a.key} className="inline-flex w-fit items-center gap-1 rounded-md bg-warn/15 px-2 py-0.5 text-[11px] text-warn">
              <TriangleAlert className="size-3" />
              {a.label} {ASSET_STATUS_LABEL[a.status]}
            </span>
          ))
        : null}
    </>
  );
  const chart = (h: string) =>
    !overlay && asset && asset.status !== 'completed' ? (
      <div className={cn('flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-warn/40 bg-warn/5 px-4 text-center', h)} data-testid="asset-missing">
        <TriangleAlert className="size-5 text-warn" />
        <div className="text-[13px] font-medium text-warn">
          {asset.label} · {ASSET_STATUS_LABEL[asset.status]}
        </div>
        <p className="max-w-md text-[12px] text-muted-foreground">{asset.error ?? t('原因未知')}</p>
        <p className="text-[11px] text-muted-foreground">{t('不画假线。换一个资产,或补数据后重跑。')}</p>
      </div>
    ) : series.lines.length === 0 ? (
      <div className={cn('flex items-center justify-center rounded-md border border-dashed text-[12px] text-muted-foreground', h)}>{t('没有可画的权益曲线')}</div>
    ) : (
      <div className={cn('relative', h)}>
        <PnlChart lines={series.lines} lookup={series.lookup} segments={report.segments} overlay={overlay} notice={notice} visibleRange={range} onVisibleRangeChange={setRange} />
      </div>
    );
  return (
    <section className="space-y-2" data-testid="pnl-section">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-foreground">{t('累计盈亏')}</div>
          <div className="flex flex-wrap items-baseline gap-1.5" data-testid="pnl-headline">
            <span className={cn('num text-[22px] leading-tight font-semibold', toneOf(m?.total_return))}>{pctSigned(m?.total_return)}</span>
            <span className={cn('num text-[12.5px]', toneOf(m?.net_pnl))}>({usdSigned(m?.net_pnl)})</span>
            {asset ? <span className="text-[11.5px] text-muted-foreground">· {asset.label}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={compare}
            onClick={() => setCompare((v) => !v)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors',
              compare ? 'border-primary/40 bg-primary/10 text-primary' : 'border-transparent bg-muted/60 text-foreground/80 hover:text-foreground',
            )}
            data-testid="compare-toggle"
          >
            <GitCompareArrows className="size-3.5" />
            {t('对比持有基准')}
          </button>
          <Button variant="ghost" size="icon-sm" aria-label={t('导出 CSV')} title={t('导出 CSV')} onClick={() => downloadText(`backtest-${report.id}-equity.csv`, equityCsv(drawn))} disabled={!drawn.length}>
            <Download />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('全屏')} title={t('全屏')} onClick={() => setFull(true)}>
            <Maximize2 />
          </Button>
        </div>
      </div>
      <AssetChips
        report={report}
        assetKey={assetKey}
        overlay={overlay}
        onPick={(k) => {
          setOverlay(false);
          setAsset(k);
        }}
        onOverlay={() => setOverlay(true)}
      />
      {chart(compact ? 'h-60' : 'h-80')}
      <RangeToolbar report={report} asset={asset} value={range} onChange={setRange} onRerunDone={onRerunDone} rerun={rerun} />
      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent className="grid-rows-[auto_1fr] gap-3 sm:max-w-[min(1280px,94vw)]">
          <DialogTitle>
            {report.title} · {t('累计盈亏')}
          </DialogTitle>
          {full ? chart('h-[70vh]') : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ---------------------------------------------------------------------------

export function BacktestReportView({ report, header, compact, className, defaultTab = 'overview', defaultAssetKey: initialAsset, defaultOverlay = false, defaultMoreMetrics = false, replayLoader, rangeRerun = true, onRerunDone, defaultRange = null }: BacktestReportViewProps) {
  const [tab, setTab] = useState<BacktestReportTab>(defaultTab);
  // 看区间:概览大图 / 刷选条 / 区间指标 / 策略回放共用
  const [range, setRange] = useState<TimeRange | null>(defaultRange);
  const [assetKey, setAssetKey] = useState(() => (initialAsset && report.assets.some((a) => a.key === initialAsset) ? initialAsset : defaultAssetKey(report)));
  const [overlay, setOverlay] = useState(defaultOverlay);
  const asset = report.assets.find((a) => a.key === assetKey);
  const lowConf = report.score.confidence === 'low';
  const tabs: { key: BacktestReportTab; label: string }[] = [
    { key: 'overview', label: t('概览') },
    { key: 'performance', label: t('表现') },
    { key: 'trades', label: t('交易分析') },
    { key: 'list', label: t('交易列表') },
    { key: 'replay', label: t('策略回放') },
  ];
  return (
    <TooltipProvider>
      <div className={cn('@container flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card text-card-foreground', compact ? 'p-3.5' : 'p-5', className)} data-testid="backtest-report">
        <ReportHeader report={report} header={header} compact={compact} rerun={rangeRerun ? <RangeRerunButton report={report} selection={range} onDone={onRerunDone} size="xs" /> : null} />
        <Tabs value={tab} onValueChange={(v) => setTab(v as BacktestReportTab)} className="min-w-0 flex-col gap-4">
          <div className="-mx-1 overflow-x-auto border-b border-border px-1">
            <TabsList variant="line" className="h-9 gap-3 p-0">
              {tabs.map((x) => (
                <TabsTrigger
                  key={x.key}
                  value={x.key}
                  className="flex-none px-0.5 text-[13px] after:bg-primary data-[state=active]:text-primary data-[state=active]:after:opacity-100 dark:data-[state=active]:text-primary"
                >
                  {x.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="overview" className="min-w-0 space-y-5">
            {lowConf ? (
              <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn" data-testid="low-confidence-banner">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  <b className="font-semibold">{CONFIDENCE_LABEL.low}</b>:{report.score.confidence_reason || t('样本太少')}。{t('下面的数字只能当线索,不能当结论。')}
                </span>
              </div>
            ) : null}
            <div className={cn('flex flex-col gap-5', !compact && '@2xl:flex-row @2xl:items-start')}>
              <ScoreGauge score={report.score} trades={asset?.metrics?.trades ?? null} compact={compact} />
              <div className="min-w-0 flex-1 space-y-2">
                {overlay || report.assets.length > 1 ? (
                  <div className="text-[11px] text-muted-foreground">
                    {t('指标口径')}:<span className="text-foreground/90">{asset?.label ?? '—'}</span>
                    {asset && asset.status !== 'completed' ? <span className="ml-1 text-warn">({ASSET_STATUS_LABEL[asset.status]})</span> : null}
                  </div>
                ) : null}
                <MetricsGrid metrics={asset?.metrics ?? null} compact={compact} defaultMore={defaultMoreMetrics} />
              </div>
            </div>
            <PnlSection report={report} asset={asset} assetKey={assetKey} overlay={overlay} setAsset={setAssetKey} setOverlay={setOverlay} compact={compact} range={range} setRange={setRange} rerun={rangeRerun} onRerunDone={onRerunDone} />
          </TabsContent>

          <TabsContent value="performance" className="min-w-0">
            <AssetBar report={report} assetKey={assetKey} onPick={setAssetKey} />
            <PerformanceTab report={report} asset={asset} compact={compact} />
          </TabsContent>

          <TabsContent value="trades" className="min-w-0">
            <AssetBar report={report} assetKey={assetKey} onPick={setAssetKey} />
            <TradesAnalysisTab asset={asset} compact={compact} />
          </TabsContent>

          <TabsContent value="list" className="min-w-0">
            <TradesTable report={report} assetKey={assetKey} onAssetChange={setAssetKey} />
          </TabsContent>

          <TabsContent value="replay" className="min-w-0">
            <ReplayTab report={report} assetKey={assetKey} onAssetChange={setAssetKey} loader={replayLoader} focus={range} />
          </TabsContent>
        </Tabs>
        <Provenance report={report} />
      </div>
    </TooltipProvider>
  );
}

function AssetBar({ report, assetKey, onPick }: { report: BacktestReport; assetKey: string; onPick: (k: string) => void }) {
  if (report.assets.length < 2) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1">
      {report.assets.map((a) => (
        <button
          key={a.key}
          type="button"
          onClick={() => onPick(a.key)}
          className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px]', a.key === assetKey ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}
        >
          <i className="inline-block h-0.5 w-2.5 rounded-full" style={{ background: assetColor(report, a.key) }} />
          {a.label}
          {a.status !== 'completed' ? <TriangleAlert className="size-3 text-warn" /> : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

export type BacktestReportByIdProps = Omit<BacktestReportViewProps, 'report'> & { reportId: string };

export function BacktestReportById({ reportId, ...rest }: BacktestReportByIdProps) {
  const q = useQuery({
    queryKey: ['research', 'backtest', reportId],
    queryFn: () => researchApi.backtest(reportId),
    enabled: !!reportId,
    staleTime: 60_000,
  });
  if (q.isLoading) {
    return (
      <div className={cn('space-y-3 rounded-xl border border-border bg-card', rest.compact ? 'p-3.5' : 'p-5', rest.className)} data-testid="backtest-report-loading">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-8 w-full" />
        <div className="flex gap-4">
          <Skeleton className="size-28 rounded-full" />
          <Skeleton className="h-28 flex-1" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className={cn('flex items-start gap-2 rounded-xl border border-down/40 bg-down/5 p-4 text-[12.5px] text-down', rest.className)} data-testid="backtest-report-error">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <div>
          <div className="font-medium">{t('回测报告加载失败')}</div>
          <div className="text-muted-foreground">{q.error instanceof Error ? q.error.message : t('报告 {id} 不存在或尚未生成', { id: reportId })}</div>
          <Button variant="outline" size="xs" className="mt-2" onClick={() => void q.refetch()}>
            {t('重试')}
          </Button>
        </div>
      </div>
    );
  }
  // key = 报告 id:换报告(区间重跑后就地切换)时看区间等本地状态归零
  return <BacktestReportView key={q.data.id} report={q.data} {...rest} />;
}
