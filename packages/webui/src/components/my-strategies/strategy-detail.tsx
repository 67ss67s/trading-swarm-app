/**
 * 策略详情(#my-strategies?id=<sid>[&report=<rid>]):
 *   顶部 返回列表 + 状态徽标 + 生命周期步进条(draft → backtested → paper → live → published;
 *   allowed_transitions 里的可点,进 live 要输入 LIVE);明确写「本轮只记录状态,不接实盘执行器」。
 *   主体 WP-C 报告面板(header:名称/描述/版本/Settings/Share/Automate,Automate = 下一个允许的状态);
 *   右栏 版本下拉(切换查看对应报告 ?report=)+ 事件时间线。
 *   页签:回测报告 | 部署(&tab=deploy:规则拆分预览 + 部署状态,只读,见 deploy-panel.tsx;2026-09-23 策略库合并)。
 *   没有报告:「还没有回测」+「运行回测」按钮(运行中 loading,完成后刷新到新报告)。
 * react-query key:['research','my-strategy',id,report];写操作后失效 my-strategies / my-strategy 两个前缀。
 */
import { SetAgentStrategyButton } from '@/components/agent-strategy/current-strategy';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowLeft, Check, FileBarChart, Grid3x3, Loader2, Lock, Play, Rocket, Settings2, Share } from 'lucide-react';
import { toast } from 'sonner';
import type { ResearchStrategyDetail, ResearchStrategyEvent, ResearchStrategyStatus } from '@trading-swarm/contracts';
import { researchApi } from '@/api/client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { DeployPanel } from './deploy-panel';
import { RunButton, RunDialog, RunStatusBar, runOf, useStrategyRuns } from './run-panel';
import { LIFECYCLE, STATUS_LABEL, type DetailTab, assetLine, copyLink, detailHash, latestReportOf, reportHash, researchHash, statusTone, transitionConfirmText, transitionRequest } from './model';
import { ReportByIdSlot, ReportSlot, type ReportHeader } from './report-slot';
import { StrategyGlyph } from './strategy-glyph';
import { StrategyMenu } from './strategy-card';
import { errText, go, invalidateMyStrategies, useStrategyActions } from './use-strategy-actions';

const EVENT_LABEL: Record<ResearchStrategyEvent['kind'], string> = tmap({
  created: '创建',
  version_added: '新版本',
  backtested: '回测',
  transition: '状态变更',
  renamed: '重命名',
  flag_changed: '标记变更',
  archived: '归档',
  session_attached: '绑定研究会话',
});

export function StatusBadge({ status }: { status: ResearchStrategyStatus }) {
  return <span className={cn('inline-flex h-5.5 items-center rounded-full border px-2 text-[11px] font-semibold', statusTone(status))}>{STATUS_LABEL[status]}</span>;
}

/** 生命周期步进条:当前高亮,allowed 里的可点,其余锁住。独立导出给测试。 */
export function LifecycleStepper({
  status,
  allowed,
  onPick,
  busy,
}: {
  status: ResearchStrategyStatus;
  allowed: readonly ResearchStrategyStatus[];
  onPick: (to: ResearchStrategyStatus) => void;
  busy?: boolean;
}) {
  const cur = LIFECYCLE.indexOf(status);
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label={t('生命周期')}>
      {LIFECYCLE.map((s, i) => {
        const current = s === status;
        const done = cur >= 0 && i < cur;
        const clickable = !current && allowed.includes(s) && !busy;
        const state = current ? 'current' : clickable ? 'allowed' : done ? 'done' : 'locked';
        return (
          <li key={s} className="flex items-center gap-1">
            {i > 0 ? <span aria-hidden className={cn('h-px w-4 sm:w-6', done || current ? 'bg-primary/60' : 'bg-border')} /> : null}
            <button
              type="button"
              data-step={s}
              data-state={state}
              disabled={!clickable}
              onClick={() => clickable && onPick(s)}
              title={clickable ? t('切换到「{s}」', { s: STATUS_LABEL[s] }) : undefined}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors [&_svg]:size-3',
                current && 'border-primary bg-primary text-primary-foreground',
                state === 'allowed' && 'border-primary/40 text-primary hover:bg-primary/10',
                state === 'done' && 'border-primary/25 text-foreground/80',
                state === 'locked' && 'border-border text-muted-foreground/60',
                'disabled:cursor-default',
              )}
            >
              {state === 'done' ? <Check /> : state === 'locked' ? <Lock /> : <span className="num text-[10px] opacity-70">{i + 1}</span>}
              {STATUS_LABEL[s]}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function EventTimeline({ events }: { events: ResearchStrategyEvent[] }) {
  const rows = [...events].sort((a, b) => b.at - a.at);
  if (!rows.length) return <p className="text-[12px] text-muted-foreground">{t('还没有事件。')}</p>;
  return (
    <ol className="relative flex flex-col gap-3 border-l border-border pl-4">
      {rows.map((e, i) => (
        <li key={`${e.at}-${i}`} className="relative">
          <span aria-hidden className={cn('absolute top-1.5 -left-[21px] size-2 rounded-full ring-2 ring-card', e.kind === 'transition' ? 'bg-primary' : e.kind === 'archived' ? 'bg-destructive' : 'bg-muted-foreground/60')} />
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <span className="font-medium">{EVENT_LABEL[e.kind]}</span>
            {e.from || e.to ? (
              <span className="text-muted-foreground">
                {e.from ? STATUS_LABEL[e.from] : '—'} → {e.to ? STATUS_LABEL[e.to] : '—'}
              </span>
            ) : null}
            {e.version !== null ? <span className="num text-[11px] text-muted-foreground">v{e.version}</span> : null}
          </div>
          {e.note ? <p className="mt-0.5 text-[11.5px] break-words text-muted-foreground">{e.note}</p> : null}
          <time className="num text-[10.5px] text-muted-foreground/70" title={fmtDateTime(e.at)}>
            {relativeTime(e.at)}
          </time>
        </li>
      ))}
    </ol>
  );
}

async function fetchDetail(id: string, report: string | null): Promise<ResearchStrategyDetail | null> {
  try {
    return await researchApi.myStrategy(id, report ?? undefined);
  } catch (e) {
    if ((e as { status?: number } | null)?.status === 404) return null;
    throw e;
  }
}

/** 详情页签切换(回测报告 | 部署);独立导出给测试 */
export function DetailTabs({ value, onChange }: { value: DetailTab; onChange: (t: DetailTab) => void }) {
  const tabs: [DetailTab, string, typeof Rocket][] = [
    ['report', t('回测报告'), FileBarChart],
    ['deploy', t('运行规则'), Rocket],
  ];
  return (
    <div role="tablist" aria-label={t('详情页签')} className="flex w-fit items-center gap-0.5 rounded-full border border-border bg-card p-1">
      {tabs.map(([k, label, Icon]) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={value === k}
          data-tab={k}
          onClick={() => onChange(k)}
          className={cn('inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors [&_svg]:size-3.5', value === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          <Icon />
          {label}
        </button>
      ))}
    </div>
  );
}

export function StrategyDetail({ id, report, tab = 'report' }: { id: string; report: string | null; tab?: DetailTab }) {
  const qc = useQueryClient();
  const reduced = useReducedMotion();
  const { actions, dialogs, busy, runBacktest } = useStrategyActions({ onArchived: () => go('my-strategies') });
  const [pendingTo, setPendingTo] = useState<ResearchStrategyStatus | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const runsQ = useStrategyRuns();

  const detailQ = useQuery({
    queryKey: ['research', 'my-strategy', id, report],
    queryFn: () => fetchDetail(id, report),
    retry: false,
  });

  const transition = useMutation({
    mutationFn: (to: ResearchStrategyStatus) => researchApi.transitionMyStrategy(id, transitionRequest(to)),
    onSuccess: (d) => {
      toast.success(t('已切换到「{s}」', { s: STATUS_LABEL[d.strategy.status] }));
      setPendingTo(null);
      void invalidateMyStrategies(qc);
    },
    onError: (e) => toast.error(errText(e)),
  });

  const back = (
    <button type="button" onClick={() => go('my-strategies')} className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground [&_svg]:size-3.5">
      <ArrowLeft />
      {t('我的策略')}
    </button>
  );

  if (detailQ.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-2 py-4 sm:px-5">
        {back}
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-[420px] rounded-xl" />
      </div>
    );
  }
  if (detailQ.isError || !detailQ.data) {
    return (
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-2 py-4 sm:px-5">
        {back}
        <div className="rounded-xl border border-dashed border-border px-6 py-16 text-center">
          <div className="text-[14px] font-semibold">{detailQ.isError ? t('策略加载失败') : t('找不到这条策略')}</div>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{detailQ.isError ? errText(detailQ.error) : t('它可能已被归档,或者后端还没有策略对象接口。')}</p>
        </div>
      </div>
    );
  }

  const d = detailQ.data;
  const s = d.strategy;
  const running = busy.has(s.id);
  const currentReportId = d.report?.id ?? report ?? s.summary?.report_id ?? null;
  const versions = [...d.versions].sort((a, b) => b.version - a.version);
  const byVersion = versions.find((v) => !!currentReportId && v.report_ids.includes(currentReportId))?.version;
  const byReport = d.reports.find((r) => r.id === currentReportId)?.strategy_version ?? null;
  const shownVersion = byVersion ?? byReport ?? s.current_version;
  const versionReports = d.reports.filter((r) => r.strategy_version === shownVersion).sort((a, b) => b.created_at - a.created_at);

  const pick = (to: ResearchStrategyStatus) => setPendingTo(to);
  const run = runOf(runsQ.data?.runs, s.id);
  const doBacktest = async () => {
    const rid = await runBacktest(s);
    if (rid) go(detailHash(s.id, rid));
  };
  const share = () =>
    copyLink(detailHash(s.id, currentReportId)).then(
      () => toast.success(t('已复制策略链接')),
      (e) => toast.error(errText(e)),
    );
  const header: ReportHeader = {
    title: s.name,
    description: s.description || assetLine(s),
    versionLabel: `v${shownVersion}`,
    onSettings: () => go(researchHash(s.id, { session: s.origin?.session_id ?? null })),
    onShare: () => void share(),
    onAutomate: s.status === 'archived' ? undefined : () => setRunOpen(true),
    automateLabel: run ? t('运行设置') : t('运行策略'),
  };
  const confirmText = pendingTo ? transitionConfirmText(pendingTo) : null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-2 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {back}
          <span className="h-4 w-px bg-border" />
          <StrategyGlyph id={s.id} size={28} />
          <h1 className="truncate text-[17px] font-semibold" title={s.name}>
            {s.name}
          </h1>
          <StatusBadge status={s.status} />
          <span className="num hidden text-[11.5px] text-muted-foreground sm:inline">{assetLine(s)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => void share()}>
            <Share />
            {t('分享')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void doBacktest()} disabled={running}>
            {running ? <Loader2 className="animate-spin" /> : <Play />}
            {running ? t('回测运行中…') : d.report ? t('重新回测') : t('运行回测')}
          </Button>
          {/* §9.53 B:把这条策略当矩阵的一行,跨资产 × 周期 × 两臂测;表单预选它 */}
          <Button variant="outline" size="sm" disabled={s.status === 'archived' || !s.current_version} title={t('资产 × 周期(15m/4h/1d)× 纯代码 / 代码 + Jev 一起测;通过的存成这条策略的新版本')} onClick={() => { window.location.hash = `matrix-study?strategy=${encodeURIComponent(s.id)}`; }}>
            <Grid3x3 />
            {t('在矩阵研究里测这条')}
          </Button>
          <StrategyMenu strategy={s} actions={actions} triggerClassName="size-7" />
          <RunButton run={run} disabled={s.status === 'archived'} onOpen={() => setRunOpen(true)} />
          {/* §9.54:看中一条策略的地方就能让 agent 按它跑(IA 审计 ③-5) */}
          <SetAgentStrategyButton strategyId={s.id} version={s.current_version} disabled={s.status === 'archived'} />
        </div>
      </div>

      {run ? <RunStatusBar run={run} /> : null}

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <LifecycleStepper status={s.status} allowed={d.allowed_transitions} onPick={pick} busy={transition.isPending} />
          {s.status === 'archived' ? <StatusBadge status="archived" /> : null}
        </div>
        <p className="text-[11.5px] text-muted-foreground">{run ? t('状态跟着运行自动推进:开跑 = 模拟盘 / 实盘,发布到 ASP = 已发布。') : t('不用逐级推进:点右上「运行策略」一键开跑,状态会自动跟上。')}</p>
      </div>

      <DetailTabs value={tab} onChange={(next) => go(detailHash(s.id, report, next))} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        {tab === 'deploy' ? (
          <div className="min-w-0">
            <DeployPanel strategy={s} version={shownVersion || null} />
          </div>
        ) : (
        <motion.div key={currentReportId ?? 'none'} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }} className="min-w-0">
          {d.report ? (
            <ReportSlot report={d.report} header={header} strategyId={s.id} />
          ) : (
            <div className="flex min-h-[360px] flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 py-12 text-center">
              <div className="text-[15px] font-semibold">{running ? t('回测运行中…') : t('还没有回测')}</div>
              <p className="max-w-md text-[12.5px] text-muted-foreground">{t('跑一次回测看看表现:默认用全部历史窗口,主资产外加 BTC / ETH / BTC+ETH 对照。')}</p>
              <div className="mt-2 flex items-center gap-2">
                <Button onClick={() => void doBacktest()} disabled={running}>
                  {running ? <Loader2 className="animate-spin" /> : <Play />}
                  {running ? t('回测运行中…') : t('运行回测')}
                </Button>
                <Button variant="outline" onClick={header.onSettings}>
                  <Settings2 />
                  {t('继续构建')}
                </Button>
              </div>
            </div>
          )}
        </motion.div>
        )}

        <aside className="flex min-w-0 flex-col gap-4">
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="kicker mb-2 text-muted-foreground">{t('版本')}</h2>
            {versions.length ? (
              <Select
                value={String(shownVersion)}
                onValueChange={(v) => {
                  const ver = versions.find((x) => String(x.version) === v);
                  const rid = ver ? latestReportOf(ver.report_ids) : null;
                  go(detailHash(s.id, rid, tab));
                }}
              >
                <SelectTrigger className="w-full" size="sm" aria-label={t('版本')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v) => (
                    <SelectItem key={v.version} value={String(v.version)} disabled={!v.report_ids.length && v.version !== shownVersion} className="text-[12.5px]">
                      <span className="num">v{v.version}</span>
                      <span className="text-muted-foreground"> · {v.note || fmtDateTime(v.created_at)}</span>
                      {!v.report_ids.length ? <span className="text-muted-foreground"> · {t('未回测')}</span> : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-[12px] text-muted-foreground">{t('还没有版本。')}</p>
            )}
            {versionReports.length > 1 ? (
              <div className="mt-3 flex flex-col gap-1">
                <div className="text-[11px] text-muted-foreground">{t('这个版本的回测')}</div>
                {versionReports.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => go(detailHash(s.id, r.id, tab))}
                    className={cn('flex items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-accent', r.id === currentReportId && 'bg-accent')}
                  >
                    <span className="truncate">{r.title || r.primary_key}</span>
                    <span className="num shrink-0 text-[10.5px] text-muted-foreground">{relativeTime(r.created_at)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="kicker mb-3 text-muted-foreground">{t('事件')}</h2>
            <EventTimeline events={d.events} />
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={!!pendingTo}
        title={pendingTo ? t('切换到「{s}」', { s: STATUS_LABEL[pendingTo] }) : ''}
        summary={t('确认切换')}
        danger={pendingTo === 'live'}
        requireText={confirmText ?? undefined}
        busy={transition.isPending}
        onCancel={() => setPendingTo(null)}
        onConfirm={() => pendingTo && transition.mutate(pendingTo)}
      >
        <p>
          {t('「{name}」从「{from}」切到「{to}」。', { name: s.name, from: STATUS_LABEL[s.status], to: pendingTo ? STATUS_LABEL[pendingTo] : '' })}
        </p>
        <p className="text-muted-foreground">{t('只改研究状态,不会下单;要真的跑请用「运行策略」。')}</p>
      </ConfirmDialog>
      {runOpen ? <RunDialog strategy={s} version={shownVersion || null} onClose={() => setRunOpen(false)} /> : null}
      {dialogs}
    </div>
  );
}

/** 单独看一份报告:#backtest?id=<rid> 或 #my-strategies?report=<rid> */
export function StandaloneReport({ reportId }: { reportId: string }) {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-2 py-4 sm:px-5">
      <button type="button" onClick={() => go('my-strategies')} className="inline-flex w-fit items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground [&_svg]:size-3.5">
        <ArrowLeft />
        {t('我的策略')}
      </button>
      <StandaloneReportBody reportId={reportId} />
    </div>
  );
}

function StandaloneReportBody({ reportId }: { reportId: string }) {
  const share = () =>
    copyLink(reportHash(reportId)).then(
      () => toast.success(t('已复制报告链接')),
      (e) => toast.error(errText(e)),
    );
  return <ReportByIdSlot reportId={reportId} header={{ title: t('回测报告'), onShare: () => void share() }} />;
}
