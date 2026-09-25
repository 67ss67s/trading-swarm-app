/**
 * 研究会话(契约 docs/demo/v3-ui-contract.md §9.44)。
 *
 * 对象链:Session → Message(blocks)→ Inquiry(一次提问的研究 run)→ Step → Snapshot → Artifact。
 * 页面是会话优先的:左侧会话列表,中间对话流,右侧结果面板(chat_only → chat_with_artifact)。
 *
 * 红线:
 *   - 恢复历史只靠 GET /sessions/:id;刷新不重发消息、不产生新的 inquiry / model call。
 *   - 后端未就绪(404)一律走空态,不 mock 数据、不编假步骤、缺数据不画 0 不补线。
 *   - completed 只说明这次提问跑完了,不说明策略有效;incomplete 明说「未完成」。
 *   - 本页没有任何交易写入口。
 */
import { BacktestReportById } from '@/components/backtest-report';
import { ConceptCoverage } from './concept-coverage';
import { DataSourceCard } from './data-source-card';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FlaskConical,
  Grid3x3,
  History,
  LineChart,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Scale,
  Search,
  Send,
  TriangleAlert,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { researchApi } from '@/api/client';
import type {
  ResearchArtifact,
  ResearchAvailability,
  ResearchBlock,
  ResearchChatTurn,
  ResearchInquiry,
  ResearchInquiryEvent,
  ResearchInquiryStatus,
  ResearchMessage,
  ResearchPlan,
  ResearchSession,
  ResearchSessionContext,
  ResearchSessionDetail,
  ResearchStep,
  ResearchStepStatus,
  ResearchTaskKind,
  ResearchToolDefinition,
} from '@/api/research-types';
import { foldLive, resolvedPlanSteps } from './session-state';
import { humanMetricName, describeIssue } from './presentation';
import { ArtifactBody, ArtifactCard, ArtifactExports, ArtifactProvenance, DataKindBadge } from '@/components/research-workbench/artifacts';
import { AnimatePresence, Reveal } from '@/components/research-workbench/motion';
import { Markdown } from '@/components/markdown';
import { Pane } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { fmtDateTime, fmtDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// 文案

const TASK_KIND_LABEL: Record<ResearchTaskKind, string> = tmap({
  market: '解释一个资产',
  compare: '比较多个资产',
  validate: '验证一个想法',
  diagnose: '诊断一次实验',
});

const INQUIRY_STATUS_LABEL: Record<ResearchInquiryStatus, string> = tmap({
  queued: '排队中',
  planning: '定计划',
  running: '取数与分析',
  validating: '校验结果',
  completed: '已完成',
  awaiting_input: '等你补条件',
  cancelling: '取消中',
  cancelled: '已取消',
  failed: '失败',
  incomplete: '未完成',
});

const STEP_STATUS_LABEL: Record<ResearchStepStatus, string> = tmap({
  pending: '待执行',
  running: '进行中',
  succeeded: '完成',
  failed: '失败',
  skipped: '跳过',
  cancelled: '已取消',
});

const AVAILABILITY_LABEL: Record<ResearchAvailability, string> = tmap({
  available: '已接入',
  partial: '部分覆盖',
  missing: '尚未接入',
  not_applicable: '不适用',
});

/** 错误码翻人话:不编原因,认不出就把原码显示出来。 */
const ERROR_CODE_LABEL: Record<string, string> = tmap({
  UNSUPPORTED_ASSET: '不支持的标的',
  DATA_MISSING: '缺数据',
  DATA_STALE: '数据过期',
  RATE_LIMIT: '被限流',
  BUDGET_EXHAUSTED: '预算耗尽',
  PROVIDER_ERROR: '数据源报错',
  SCHEMA_MISMATCH: '数据结构不符',
  UNIT_MISMATCH: '单位不一致',
  NOT_COMPARABLE: '口径不可比',
  CANCELLED: '已取消',
  TIMEOUT: '超时',
  interrupted: '进程重启中断',
  research_session_busy: '会话里还有一次提问没跑完',
});

/** 首屏三个入口:都是直接把问题发进会话,不再跳别的页。 */
const ENTRY_CARDS = [
  { key: 'market', icon: Search, title: '研究一个资产', example: 'BTC 最近的上涨是否伴随杠杆升温?' },
  { key: 'compare', icon: Scale, title: '比较资产', example: 'ETH、SOL、DOGE 最近30天，谁比BTC表现更强？' },
  { key: 'validate', icon: LineChart, title: '验证一个想法', example: '验证BTC现货日线20/50均线交叉策略，扣除成本后和直接持有相比如何？' },
] as const;

const LIVE_STATUS: ResearchInquiryStatus[] = ['queued', 'planning', 'running', 'validating', 'cancelling'];
const isLive = (s: ResearchInquiryStatus | undefined): boolean => !!s && LIVE_STATUS.includes(s);

function statusTone(s: ResearchInquiryStatus): string {
  if (s === 'completed') return 'border-up/40 bg-up/10 text-up';
  if (isLive(s)) return 'border-primary/40 bg-primary/10 text-primary';
  if (s === 'failed') return 'border-down/40 bg-down/10 text-down';
  return 'border-warn/40 bg-warn/10 text-warn';
}

function idemKey(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// 旧对话(只读):第三轮那套 localStorage 记录,不迁移、不重放,只让它还能被翻出来看

const LEGACY_CHAT_STORE = 'tg.research.chat';

export function loadLegacyChat(): ResearchChatTurn[] {
  try {
    const raw = window.localStorage.getItem(LEGACY_CHAT_STORE);
    return raw ? (JSON.parse(raw) as ResearchChatTurn[]) : [];
  } catch {
    return []; // 私密模式
  }
}

// ---------------------------------------------------------------------------
// 进行中:SSE + events?after 补发

/**
 * 一次 inquiry 的实时事件:
 *   - App.tsx 的 SSE `research.inquiry` 按 seq 去重写进 ['research','inquiry-live',id];
 *   - 这里再按 cursor 轮询 `GET /inquiries/:id/events?after=` 补断线漏掉的那几条(也兼作 SSE 没接上时的兜底)。
 * 两条路都只合并真实事件,不构造步骤。
 */
function useInquiryEvents(inquiryId: string | null, active: boolean): ResearchInquiryEvent[] {
  const qc = useQueryClient();
  const cursorRef = useRef(0);
  useEffect(() => {
    cursorRef.current = 0;
  }, [inquiryId]);

  const liveQ = useQuery<ResearchInquiryEvent[]>({
    queryKey: ['research', 'inquiry-live', inquiryId],
    queryFn: async () => [],
    enabled: false,
    staleTime: Infinity,
  });

  useQuery({
    queryKey: ['research', 'inquiry-backfill', inquiryId],
    queryFn: async () => {
      const res = await researchApi.inquiryEvents(inquiryId!, cursorRef.current);
      const items = res.items ?? [];
      if (items.length) {
        qc.setQueryData(['research', 'inquiry-live', inquiryId], (old: unknown) => {
          const cur = Array.isArray(old) ? (old as ResearchInquiryEvent[]) : [];
          const seen = new Set(cur.map((x) => x.seq));
          const merged = [...cur, ...items.filter((x) => !seen.has(x.seq))];
          return merged.sort((a, b) => a.seq - b.seq).slice(-800);
        });
      }
      cursorRef.current = res.next_cursor ?? cursorRef.current;
      return items.length;
    },
    enabled: !!inquiryId && active,
    refetchInterval: 3_000,
    retry: false,
  });

  return liveQ.data ?? [];
}

// ---------------------------------------------------------------------------
// 左栏:会话列表(可折叠)

export function SessionSidebar({
  collapsed,
  onToggle,
  sessions,
  loading,
  unavailable,
  activeId,
  onSelect,
  onNew,
  creating,
  legacyTurns,
  onOpenLegacy,
  onOpenHistory,
  runCount,
  onOpenMatrix,
}: {
  collapsed: boolean;
  onToggle: () => void;
  sessions: ResearchSession[];
  loading: boolean;
  unavailable: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  creating: boolean;
  legacyTurns: ResearchChatTurn[];
  onOpenLegacy: () => void;
  onOpenHistory: () => void;
  runCount: number;
  /** 打开右栏「矩阵研究」页签(内嵌新建 + 最近列表,不另开会话) */
  onOpenMatrix?: () => void;
}) {
  if (collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center gap-1 border-r bg-muted/20 py-1.5">
        <Button size="xs" variant="ghost" onClick={onToggle} title={t('展开会话列表')} aria-label={t('展开会话列表')}>
          <PanelLeftOpen />
        </Button>
        <Button size="xs" variant="ghost" onClick={onNew} disabled={creating} title={t('新建会话')}>
          <Plus />
        </Button>
        <Button size="xs" variant="ghost" onClick={onOpenHistory} title={t('实验历史')}>
          <History />
        </Button>
        {onOpenMatrix ? (
          <Button size="xs" variant="ghost" onClick={onOpenMatrix} title={t('矩阵研究')}>
            <Grid3x3 />
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex w-[228px] shrink-0 flex-col border-r bg-muted/20">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <span className="kicker text-[10.5px] text-foreground/85">{t('会话')}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={onNew} disabled={creating} title={t('新建会话')}>
            <Plus /> {t('新建')}
          </Button>
          <Button size="xs" variant="ghost" onClick={onToggle} title={t('收起会话列表')} aria-label={t('收起会话列表')}>
            <PanelLeftClose />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1">
          {loading ? <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{t('读取中…')}</div> : null}
          {unavailable ? (
            <div className="m-1 rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-[10.5px] text-warn">{t('研究会话接口还没就绪,暂时开不了新会话。')}</div>
          ) : null}
          {!loading && !unavailable && !sessions.length ? <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{t('还没有会话。')}</div> : null}
          <ul className="space-y-0.5">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className={cn('flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/60', activeId === s.id && 'bg-accent')}
                >
                  <span className="truncate text-[12px] font-medium">{s.title || t('未命名会话')}</span>
                  <span className="num text-[10px] text-muted-foreground">{fmtDateTime(s.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* 旧对话:第三轮的本地记录与旧实验入口,只读,不混进新会话 */}
        <div className="mt-2 border-t p-1">
          <div className="px-2 py-1 text-[10px] tracking-wide text-muted-foreground uppercase">{t('旧对话(只读)')}</div>
          <button
            type="button"
            onClick={onOpenLegacy}
            disabled={!legacyTurns.length}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11.5px] hover:bg-accent/60 disabled:opacity-50"
          >
            <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{t('本机旧研究问答')}</span>
            <span className="num ml-auto text-[10px] text-muted-foreground">{legacyTurns.length}</span>
          </button>
          <button type="button" onClick={onOpenHistory} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11.5px] hover:bg-accent/60">
            <FlaskConical className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{t('实验历史')}</span>
            <span className="num ml-auto text-[10px] text-muted-foreground">{runCount}</span>
          </button>
          {onOpenMatrix ? (
            <button type="button" onClick={onOpenMatrix} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11.5px] hover:bg-accent/60" title={t('资产 × 周期 × 策略的矩阵研究,在右栏打开')}>
              <Grid3x3 className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{t('矩阵研究')}</span>
            </button>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 步骤

function StepDot({ status }: { status: ResearchStepStatus }) {
  const cls =
    status === 'succeeded'
      ? 'bg-up'
      : status === 'failed'
        ? 'bg-down'
        : status === 'running'
          ? 'bg-primary animate-pulse'
          : status === 'cancelled' || status === 'skipped'
            ? 'bg-warn'
            : 'bg-muted-foreground/40';
  return <span className={cn('mt-[5px] inline-block size-1.5 shrink-0 rounded-full', cls)} title={STEP_STATUS_LABEL[status]} />;
}

/** 摘要里认识的几个字段翻成人话;认不出的原样给开发详情看,不猜含义。 */
function summaryLines(step: ResearchStep): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const s = (step.output_summary ?? {}) as Record<string, unknown>;
  const win = s['window'] as { from_ms?: number; to_ms?: number } | undefined;
  if (win?.from_ms && win?.to_ms) out.push({ label: t('数据范围'), value: `${fmtDateTime(win.from_ms)} → ${fmtDateTime(win.to_ms)}` });
  if (typeof s['provider'] === 'string') out.push({ label: t('来源'), value: String(s['provider']) });
  if (typeof s['as_of'] === 'number') out.push({ label: t('截至'), value: fmtDateTime(s['as_of'] as number) });
  if (typeof s['rows'] === 'number') out.push({ label: t('行数'), value: String(s['rows']) });
  if (typeof s['coverage'] === 'string') out.push({ label: t('覆盖'), value: AVAILABILITY_LABEL[s['coverage'] as ResearchAvailability] ?? String(s['coverage']) });
  if (s['snapshot_reused'] === true) out.push({ label: t('快照'), value: t('复用,不重新取数') });
  if (typeof s['note'] === 'string') out.push({ label: t('摘要'), value: String(s['note']) });
  if (typeof s['observation'] === 'string') out.push({ label: t('观察'), value: String(s['observation']) });
  if (step.started_at && step.ended_at) out.push({ label: t('耗时'), value: fmtDuration(step.ended_at - step.started_at) });
  if (step.error_code) out.push({ label: t('错误'), value: ERROR_CODE_LABEL[step.error_code] ?? step.error_code });
  return out;
}

function StepRow({ step, dev, onOpenArtifact }: { step: ResearchStep; dev: boolean; onOpenArtifact: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const lines = summaryLines(step);
  const hasDetail = lines.length > 0 || dev || (step.artifact_refs?.length ?? 0) > 0;
  return (
    <li className="text-[11.5px]">
      <button type="button" className="flex w-full items-start gap-1.5 text-left hover:text-foreground" onClick={() => hasDetail && setOpen((v) => !v)}>
        <StepDot status={step.status} />
        <span className={cn('min-w-0 flex-1', step.status === 'failed' ? 'text-down' : step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground/85')}>{step.title}</span>
        {step.status === 'running' ? <span className="shrink-0 text-[10px] text-primary">{STEP_STATUS_LABEL.running}</span> : null}
        {hasDetail ? (open ? <ChevronDown className="mt-[2px] size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-[2px] size-3 shrink-0 text-muted-foreground" />) : null}
      </button>
      {open ? (
        <div className="mt-1 mb-1.5 ml-3 space-y-1 border-l pl-2.5">
          {lines.length ? (
            <dl className="space-y-0.5">
              {lines.map((l) => (
                <div key={l.label} className="flex gap-1.5 text-[10.5px]">
                  <dt className="w-14 shrink-0 text-muted-foreground">{l.label}</dt>
                  <dd className="min-w-0 flex-1 break-words">{l.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="text-[10.5px] text-muted-foreground">{t('这一步没有返回摘要。')}</div>
          )}
          {step.tool === 'find_data_source' && step.output_summary ? <DataSourceCard result={((step.output_summary as { result?: unknown }).result ?? step.output_summary) as Parameters<typeof DataSourceCard>[0]['result']} /> : null}
          {step.artifact_refs?.map((id) => <ArtifactCard key={id} id={id} inline onOpen={onOpenArtifact} />)}
          {dev ? (
            <div className="space-y-0.5">
              <div className="text-[10px] text-muted-foreground">
                {t('工具')} <span className="font-medium text-foreground/80">{step.tool || '—'}</span>
                {step.tool_version ? <span className="num ml-1">v{step.tool_version}</span> : null}
              </div>
              <pre className="max-h-40 overflow-auto rounded bg-muted/50 p-1.5 text-[10px] whitespace-pre-wrap">
                {JSON.stringify({ input: step.input ?? null, snapshot_refs: step.snapshot_refs ?? [], output_summary: step.output_summary ?? null }, null, 1)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// blocks

interface BlockCtx {
  steps: ResearchStep[];
  onOpenArtifact: (id: string) => void;
  onOpenRun: (runId: string) => void;
  onOpenSettings?: (runId: string) => void;
  onAsk: (text: string) => void;
  onCancel: (inquiryId: string) => void;
  liveStatus: ResearchInquiryStatus | null;
  liveInquiryId: string | null;
  tools: ResearchToolDefinition[];
}

function PlanBlock({ plan, ctx }: { plan: ResearchPlan; ctx: BlockCtx }) {
  const [open, setOpen] = useState(() => isLive(ctx.liveStatus ?? undefined));
  const [dev, setDev] = useState(false);
  const resolved = resolvedPlanSteps(plan, ctx.steps);
  const byKey = new Map(resolved.map((s, i) => [plan.steps[i]!.key, s]));
  const done = resolved.filter((s) => s.status === 'succeeded').length;
  const toolTitle = (name: string) => ctx.tools.find((x) => x.name === name)?.title ?? null;
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border/70 bg-transparent">
      <div className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-2 text-xs select-none">
        <button type="button" className="inline-flex items-center gap-1.5 hover:text-foreground" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <span className="font-medium">{t(isLive(ctx.liveStatus ?? undefined) ? '正在研究' : '研究过程')}</span>
        </button>
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
          {TASK_KIND_LABEL[plan.task_kind] ?? plan.task_kind}
        </Badge>
        {plan.source === 'fallback_rules' ? (
          <Badge variant="outline" className="h-4 border-warn/40 bg-warn/10 px-1.5 text-[10px] text-warn">
            {t('规则路由')}
          </Badge>
        ) : null}
        <span className="num ml-auto text-[10px] text-muted-foreground">
          {done}/{plan.steps?.length ?? 0} {t('步完成')}
        </span>
        <button type="button" className={cn('text-[10px] text-muted-foreground hover:text-foreground', dev && 'text-foreground')} onClick={() => setDev((v) => !v)}>
          {t('开发详情')}
        </button>
      </div>
      {open ? (
        <ul className="space-y-1 px-2.5 py-2">
          {(plan.steps ?? []).map((p) => {
            const step = byKey.get(p.key);
            const merged: ResearchStep = step ?? {
              id: p.key,
              inquiry_id: ctx.liveInquiryId ?? '',
              seq: 0,
              key: p.key,
              title: p.title || toolTitle(p.tool) || p.tool,
              tool: p.tool,
              status: p.status ?? 'pending',
            };
            return <StepRow key={p.key} step={merged} dev={dev} onOpenArtifact={ctx.onOpenArtifact} />;
          })}
          {!plan.steps?.length ? <li className="text-[11px] text-muted-foreground">{t('计划里没有步骤。')}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function DataGapBlock({ metric, availability, note }: { metric: string; availability: ResearchAvailability; note?: string }) {
  const issue = describeIssue(metric, availability, note);
  return (
    <div className="my-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5 text-xs">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t(humanMetricName(metric))} · {t(issue.label)}</div>
          <p className="mt-1 leading-relaxed text-muted-foreground">{t(issue.message)}</p>
          {issue.technical && note ? <details className="mt-2"><summary className="cursor-pointer text-muted-foreground">{t('技术详情')}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px]">{note}</pre></details> : null}
        </div>
      </div>
    </div>
  );
}

function RunStatusBlock({ inquiryId, status, reason, ctx }: { inquiryId: string; status: ResearchInquiryStatus; reason?: string; ctx: BlockCtx }) {
  const live = isLive(status);
  const text =
    status === 'incomplete'
      ? t('未完成:{reason},已有产物仍可看。', { reason: reason || t('原因未给出') })
      : status === 'cancelled'
        ? t('已取消。已完成的步骤与产物仍可看。')
        : status === 'failed'
          ? t('失败:{reason}', { reason: reason || t('原因未给出') })
          : status === 'completed'
            ? t('这次提问跑完了。跑完只说明步骤执行完毕,不说明结论成立。')
            : INQUIRY_STATUS_LABEL[status];
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px]">
      <Badge variant="outline" className={cn('h-4 shrink-0 px-1.5 text-[10px]', statusTone(status))}>
        {live ? <span className="progress-spinner" /> : null}
        {INQUIRY_STATUS_LABEL[status] ?? status}
      </Badge>
      <span className="min-w-0 flex-1 text-muted-foreground">{text}</span>
      {live ? (
        <Button size="xs" variant="ghost" onClick={() => ctx.onCancel(inquiryId)} title={t('取消:正在跑的工具返回后停下,已完成的产物保留')}>
          <Ban /> {t('取消')}
        </Button>
      ) : null}
    </div>
  );
}

function BlockView({ block, ctx }: { block: ResearchBlock; ctx: BlockCtx }) {
  switch (block.kind) {
    case 'text':
      return <Markdown text={block.text} />;
    case 'plan':
      return <PlanBlock plan={block} ctx={ctx} />;
    case 'step_ref': {
      const step = ctx.steps.find((s) => s.id === block.step_id || s.key === block.step_id);
      if (!step) return <div className="my-1 text-[11px] text-muted-foreground">{t('步骤读不到')}:{block.step_id.slice(0, 8)}</div>;
      return (
        <ul className="my-1.5 rounded-md border px-2.5 py-1.5">
          <StepRow step={step} dev={false} onOpenArtifact={ctx.onOpenArtifact} />
        </ul>
      );
    }
    case 'chart_ref':
    case 'table_ref':
    case 'report_ref':
    case 'comparison_ref':
      return <ArtifactCard id={block.artifact_id} inline onOpen={ctx.onOpenArtifact} caption={(block as { caption?: string }).caption} />;
    case 'strategy_ref':
      return (
        <div><button
          type="button"
          onClick={() => ctx.onOpenRun(block.run_id)}
          className="my-1.5 flex w-full items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-left text-[11.5px] hover:bg-accent/60"
        >
          <FlaskConical className="size-3 text-primary" />
          <span>{t('这一步创建了一次回测')}</span>
          <span className="num ml-auto text-[10px] text-muted-foreground">{block.run_id.slice(0, 8)}</span>
        </button>{ctx.onOpenSettings ? <button type="button" className="mb-3 text-xs text-primary hover:underline" onClick={() => ctx.onOpenSettings?.(block.run_id)}>设置 · 修改规则 · 查看版本</button> : null}</div>
      );
    case 'data_gap':
      return <DataGapBlock metric={block.metric} availability={block.availability} note={block.note} />;
    case 'run_status':
      return <RunStatusBlock inquiryId={block.inquiry_id} status={block.status} reason={block.reason} ctx={ctx} />;
    case 'next_question':
      return (
        <button
          type="button"
          onClick={() => ctx.onAsk(block.text)}
          className="mt-1 mr-1.5 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <CircleHelp className="size-3" /> {block.text}
        </button>
      );
    default:
      return null;
  }
}

function MessageView({ message, ctx, inquiry, events }: { message: ResearchMessage; ctx: BlockCtx; inquiry: ResearchInquiry | null; events: ResearchInquiryEvent[] }) {
  const view = foldLive(inquiry, events);
  const messageCtx: BlockCtx = { ...ctx, steps: view.steps, liveStatus: view.status, liveInquiryId: inquiry?.id ?? null };
  if (message.role === 'user') {
    const text = message.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('\n').trim();
    return (
      <Reveal className="flex justify-end pl-8">
        <div className="max-w-[88%] rounded-2xl rounded-tr-sm bg-muted/70 px-4 py-3 text-sm leading-7 whitespace-pre-wrap">{text}</div>
      </Reveal>
    );
  }
  return (
    <Reveal className="pr-2">
      <div className="research-answer py-2 text-sm leading-7">
        {message.blocks.map((b, i) => (
          <BlockView key={i} block={b} ctx={messageCtx} />
        ))}
        {!message.blocks.length ? <span className="text-[11px] text-muted-foreground">{t('这条回答没有内容。')}</span> : null}
        {inquiry?.checkpoint?.concepts?.length && ['completed', 'partial', 'failed'].includes(view.status ?? '') ? <ConceptCoverage concepts={inquiry.checkpoint.concepts} /> : null}
      </div>
    </Reveal>
  );
}

// ---------------------------------------------------------------------------
// 右栏「结果」视图:同一个 artifact,面板里显示来源 / 截至 / 窗口 / 单位 / 数据身份

export function ArtifactResultPanel({ artifactId, onMeta }: { artifactId: string | null; onMeta?: (a: ResearchArtifact) => void }) {
  const q = useQuery({
    queryKey: ['research', 'artifact', artifactId],
    queryFn: () => researchApi.artifact(artifactId!),
    enabled: !!artifactId,
    staleTime: Infinity,
    retry: false,
  });
  const snapId = q.data?.snapshot_refs?.[0] ?? null;
  const snapQ = useQuery({
    queryKey: ['research', 'snapshot', snapId],
    queryFn: () => researchApi.snapshot(snapId!, 0),
    enabled: !!snapId,
    staleTime: Infinity,
    retry: false,
  });
  const a = q.data;
  // 「换区间重跑」出的新报告就地替换面板(换产物时归零),顶部可以回到原报告
  const [rerun, setRerun] = useState<{ artifactId: string; reportId: string } | null>(null);
  const metaRef = useRef(onMeta);
  metaRef.current = onMeta;
  useEffect(() => {
    if (a) metaRef.current?.(a);
  }, [a]);

  if (!artifactId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <LineChart className="size-7 text-muted-foreground/60" />
        <div className="max-w-sm text-[12px] text-muted-foreground">{t('对话里点一张图或一张表,就在这里打开。关掉面板不会丢掉选中的产物。')}</div>
      </div>
    );
  }
  if (q.isLoading) return <div className="p-3 text-[12px] text-muted-foreground">{t('读取中…')}</div>;
  if (q.error || !a) return <div className="p-3 text-[12px] text-down">{t('产物读不到')}:{artifactId.slice(0, 12)}</div>;

  // 回测步产物(content.view='backtest_report' + report_id):整块换成 Horizon 式全窗口报告面板
  const reportId = (() => {
    const c = (a.content ?? null) as { view?: string; report_id?: string } | null;
    return c && typeof c === 'object' && c.view === 'backtest_report' && typeof c.report_id === 'string' ? c.report_id : null;
  })();
  if (reportId) {
    const rerunId = rerun && rerun.artifactId === a.id ? rerun.reportId : null;
    const shownId = rerunId ?? reportId;
    return (
      <div className="@container flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
          {rerunId ? (
            <>
              <span className="truncate text-foreground/90">{t('区间重跑结果(另存的新报告)')}</span>
              <button type="button" className="shrink-0 text-primary hover:underline" onClick={() => setRerun(null)}>
                {t('回到原报告')}
              </button>
            </>
          ) : (
            <span className="truncate">{a.question ? `${t('这份回测回答')}:${a.question}` : a.title}</span>
          )}
          <a className="ml-auto shrink-0 text-primary hover:underline" href={`#backtest?id=${encodeURIComponent(shownId)}`}>{t('在「我的策略」中打开')}</a>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-3">
            <BacktestReportById
              reportId={shownId}
              compact
              onRerunDone={(id) => setRerun({ artifactId: a.id, reportId: id })}
              header={{
                title: rerunId ? t('{title} · 区间重跑', { title: a.title }) : a.title,
                onShare: () => {
                  void navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}#backtest?id=${encodeURIComponent(shownId)}`).then(() => toast.success(t('已复制报告链接')));
                },
              }}
            />
          </div>
        </ScrollArea>
      </div>
    );
  }

  const provider = a.provider ?? (snapQ.data?.provider ?? null);
  const asOf = a.as_of ?? snapQ.data?.as_of ?? null;
  const win = a.window ?? snapQ.data?.actual_window ?? null;
  const units = a.units ?? snapQ.data?.units ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[14px] font-semibold">{a.title}</h2>
          <DataKindBadge dataKind={a.data_kind} availability={a.availability} />
          <ArtifactExports artifact={a} />
        </div>
        {a.question ? <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t('这张图回答')}:{a.question}</p> : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted-foreground">
          <span>
            {t('来源')} {provider ?? t('未标注')}
          </span>
          <span>
            {t('截至')} <span className="num">{asOf ? fmtDateTime(asOf) : t('未标注')}</span>
          </span>
          {win ? (
            <span className="num">
              {fmtDateTime(win.from_ms)} → {fmtDateTime(win.to_ms)}
            </span>
          ) : null}
          {snapQ.data?.coverage && snapQ.data.coverage !== 'available' ? (
            <span className="text-warn">{AVAILABILITY_LABEL[snapQ.data.coverage as ResearchAvailability] ?? String(snapQ.data.coverage)}</span>
          ) : null}
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          <ArtifactBody artifact={a} height={360} />
          <ArtifactProvenance artifact={a} />
          {a.caption ? <p className="mt-2 text-[11px] text-muted-foreground">{a.caption}</p> : null}
          {a.data_kind === 'estimated' ? (
            <p className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-[10.5px] text-warn">{t('这是估计值,不是实测成交。')}</p>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 中间:会话对话流

export function SessionChat({
  sessionId,
  sessionsUnavailable,
  context,
  onClearContext,
  onEnsureSession,
  onOpenArtifact,
  onOpenRun,
  onOpenSettings,
  onOpenHistory,
  panelOpen,
  onShowPanel,
  narrow,
}: {
  sessionId: string | null;
  sessionsUnavailable: boolean;
  context: ResearchSessionContext;
  onClearContext: () => void;
  /** 没有会话时先建一个,返回新 id;建不出来返回 null */
  onEnsureSession: () => Promise<string | null>;
  onOpenArtifact: (id: string) => void;
  onOpenRun: (runId: string) => void;
  onOpenSettings?: (runId: string) => void;
  onOpenHistory: () => void;
  panelOpen: boolean;
  onShowPanel: () => void;
  narrow: boolean;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState('');
  const [pending, setPending] = useState<{ text: string; key: string; error: string | null } | null>(null);
  const [acceptedInquiry, setAcceptedInquiry] = useState<ResearchInquiry | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const sessionQ = useQuery<ResearchSessionDetail>({
    queryKey: ['research', 'session', sessionId],
    queryFn: () => researchApi.session(sessionId!),
    enabled: !!sessionId,
    retry: false,
  });
  const toolsQ = useQuery({ queryKey: ['research', 'tools'], queryFn: researchApi.tools, staleTime: 10 * 60_000, retry: false });

  const detail = sessionQ.data ?? null;
  const messages = detail?.messages ?? [];
  const inquiries = detail?.inquiries ?? [];
  // 未终态的那条 inquiry = 当前进行中;没有就没有
  const activeInquiry = inquiries.find((i) => isLive(i.status) || i.status === 'awaiting_input')
    ?? (acceptedInquiry && !inquiries.some((i) => i.id === acceptedInquiry.id) ? acceptedInquiry : null);
  const events = useInquiryEvents(activeInquiry?.id ?? null, !!activeInquiry);
  const live = useMemo(() => foldLive(activeInquiry, events), [activeInquiry, events]);
  const liveRunning = isLive(live.status ?? undefined);
  const lastEvent = events.at(-1);
  useEffect(() => {
    if (sessionId && lastEvent && /^inquiry\.(completed|incomplete|failed|cancelled|awaiting_input)$/.test(lastEvent.event)) {
      void qc.invalidateQueries({ queryKey: ['research', 'session', sessionId] });
      void qc.invalidateQueries({ queryKey: ['research', 'sessions'] });
    }
  }, [sessionId, lastEvent?.seq, lastEvent?.event, qc]);


  // 进行中时回源刷会话:拿落库的 blocks(事件只驱动步骤与新产物)
  useEffect(() => {
    if (!sessionId || !liveRunning) return;
    const id = window.setInterval(() => void qc.invalidateQueries({ queryKey: ['research', 'session', sessionId] }), 8_000);
    return () => window.clearInterval(id);
  }, [sessionId, liveRunning, qc]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, live.steps.length, live.artifactIds.length, pending?.text]);

  const sendM = useMutation({
    mutationFn: async (args: { sid: string; text: string; key: string }) =>
      researchApi.sendSessionMessage(args.sid, { text: args.text, idempotency_key: args.key, ...(hasContext(context) ? { context } : {}) }),
    onSuccess: (response, args) => {
      // The accepted run blocks another send even before the session refetch
      // returns. These callbacks belong to this chat instance, including retries.
      setAcceptedInquiry(response.inquiry);
      qc.setQueryData<ResearchSessionDetail>(['research', 'session', args.sid], (old) => old ? {
        ...old,
        messages: old.messages.some((m) => m.id === response.message.id) ? old.messages : [...old.messages, response.message],
        inquiries: old.inquiries.some((i) => i.id === response.inquiry.id) ? old.inquiries : [...old.inquiries, response.inquiry],
      } : old);
      setPending(null);
      void qc.invalidateQueries({ queryKey: ['research', 'session', args.sid], exact: true });
      void qc.invalidateQueries({ queryKey: ['research', 'sessions'] });
    },
    onError: (e: Error & { code?: string }) => {
      const code = (e as { code?: string }).code;
      const msg = code === 'research_session_busy' ? t('会话里还有一次提问没跑完,等它结束或取消后再发。') : e.message;
      setPending((cur) => (cur ? { ...cur, error: msg } : cur));
      toast.error(msg);
    },
  });

  const answerM = useMutation({
    mutationFn: (args: { id: string; text: string }) => researchApi.answerInquiry(args.id, args.text),
    onSuccess: () => {
      setAnswer('');
      void qc.invalidateQueries({ queryKey: ['research', 'session', sessionId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelM = useMutation({
    mutationFn: (id: string) => researchApi.cancelInquiry(id),
    onSuccess: () => {
      toast.success(t('已请求取消:正在跑的工具返回后停下'));
      void qc.invalidateQueries({ queryKey: ['research', 'session', sessionId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ask = (raw: string) => {
    const msg = raw.trim();
    if (!msg || sendM.isPending || pending || activeInquiry) return;
    const key = idemKey();
    setText('');
    setPending({ text: msg, key, error: null });
    void (async () => {
      const sid = sessionId ?? (await onEnsureSession());
      if (!sid) {
        setPending({ text: msg, key, error: t('建不出会话:研究会话接口还没就绪。') });
        return;
      }
      sendM.mutate({ sid, text: msg, key });
    })();
  };

  const retryPending = () => {
    if (!pending || !sessionId) return;
    setPending({ ...pending, error: null });
    sendM.mutate({ sid: sessionId, text: pending.text, key: pending.key }); // 同 key 重发,不重跑
  };

  const ctx: BlockCtx = {
    steps: live.steps,
    onOpenArtifact,
    onOpenRun,
    onOpenSettings,
    onAsk: ask,
    onCancel: (id) => cancelM.mutate(id),
    liveStatus: live.status,
    liveInquiryId: activeInquiry?.id ?? null,
    tools: toolsQ.data?.items ?? [],
  };

  const backendDown = !!sessionQ.error || sessionsUnavailable;
  const empty = !messages.length && !pending && !activeInquiry;
  // 进行中的那条提问,落库的 assistant 消息可能还没写;用真实事件先把计划与产物显示出来
  const liveMessageShown = !!activeInquiry && !messages.some((m) => m.role === 'assistant' && m.inquiry_id === activeInquiry.id && m.blocks.length);

  return (
    <Pane
      title={t('研究')}
      hint={sessionId ? t('会话式研究,只读,不会下单') : t('只读诊断,没有交易权限')}
      actions={
        <>
          {narrow && panelOpen ? (
            <Button variant="ghost" size="xs" onClick={onShowPanel}>
              {t('看结果')}
            </Button>
          ) : null}
          {!narrow && !panelOpen ? (
            <Button variant="ghost" size="xs" onClick={onShowPanel} title={t('重开结果面板,回到上次的产物与分页')}>
              {t('结果面板')}
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={onOpenHistory}>
            <History /> {t('实验')}
          </Button>
        </>
      }
      className="border-b"
      contentClassName="flex min-h-0 flex-col"
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="research-conversation mx-auto w-full max-w-[820px] space-y-6 px-5 py-7 sm:px-8">
          {empty ? (
            <div className="mx-auto max-w-[700px] space-y-7 pt-[clamp(24px,10vh,100px)] pb-8">
              <div className="space-y-1">
                <h1 className="text-3xl font-medium tracking-tight">{t('你想研究什么?')}</h1>
                <p className="text-[12px] text-muted-foreground">
                  {t('从一个问题开始，用数据和图表一起寻找答案。')}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {ENTRY_CARDS.map((c) => (
                  <button key={c.key} type="button" className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/10 p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40" onClick={() => setText(t(c.example))}>
                    <span className="flex items-center gap-1.5 text-[12px] font-medium">
                      <c.icon className="size-3.5 text-primary" /> {t(c.title)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{t(c.example)}</span>
                  </button>
                ))}
              </div>
              {backendDown ? (
                <div className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
                  {t('暂时无法连接研究服务。已有实验、策略构建和资产筛选仍可从右侧打开。')}
                </div>
              ) : null}
            </div>
          ) : null}

          {sessionQ.isLoading && sessionId ? <div className="text-[11.5px] text-muted-foreground">{t('恢复会话中…')}</div> : null}

          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <MessageView key={m.id} message={m} ctx={ctx} inquiry={inquiries.find((q) => q.id === m.inquiry_id) ?? null} events={m.inquiry_id === activeInquiry?.id ? events : []} />
            ))}
          </AnimatePresence>

          {pending ? (
            <>
              <Reveal className="flex justify-end pl-8">
                <div className="max-w-[85%] rounded-md bg-primary/10 px-2.5 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap opacity-70">{pending.text}</div>
              </Reveal>
              {pending.error ? (
                <div className="flex items-center gap-2 text-[11px] text-down">
                  <span>{describeIssue('research', 'missing', pending.error).message}</span>
                  <Button size="xs" variant="ghost" onClick={retryPending} disabled={!sessionId || sendM.isPending}>
                    {t('重试')}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setPending(null)}>
                    {t('丢弃')}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <span className="typing-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  {t('正在受理…')}
                </div>
              )}
            </>
          ) : null}

          {/* 进行中:计划、步骤与新产物都来自真实事件 */}
          {activeInquiry && liveMessageShown ? (
            <Reveal className="pr-2">
              <div className="research-answer py-2 text-sm leading-7">
                <RunStatusBlock inquiryId={activeInquiry.id} status={live.status ?? activeInquiry.status} reason={live.error ?? undefined} ctx={ctx} />
                {live.plan ? <PlanBlock plan={live.plan} ctx={ctx} /> : <div className="text-[11px] text-muted-foreground">{t('还没有计划:等规划器返回。')}</div>}
                {live.artifactIds.map((id) => (
                  <ArtifactCard key={id} id={id} inline onOpen={onOpenArtifact} />
                ))}
              </div>
            </Reveal>
          ) : null}

          {/* awaiting_input:计划缺关键条件,等用户答;这之前不跑任何付费步骤 */}
          {activeInquiry && live.status === 'awaiting_input' ? (
            <div className="rounded-md border border-warn/40 bg-warn/10 p-2.5">
              <div className="text-[11.5px] text-warn">{live.plan?.clarify || t('还缺一个关键条件,补一句再继续。')}</div>
              <div className="mt-1.5 flex gap-1.5">
                <Textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (answer.trim()) answerM.mutate({ id: activeInquiry.id, text: answer.trim() });
                    }
                  }}
                  placeholder={t('补充条件,例如:窗口取最近 90 天')}
                  className="min-h-[38px] resize-none text-[12px]"
                />
                <Button size="xs" onClick={() => answer.trim() && answerM.mutate({ id: activeInquiry.id, text: answer.trim() })} disabled={!answer.trim() || answerM.isPending}>
                  {t('回答')}
                </Button>
              </div>
            </div>
          ) : null}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="research-composer px-5 pt-3 pb-4 sm:px-8">
        <div className="mx-auto w-full max-w-[820px] rounded-2xl border border-border/80 bg-muted/20 p-3 shadow-sm">
          {hasContext(context) ? <ContextChip context={context} onClear={onClearContext} /> : null}
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask(text);
              }
            }}
            placeholder={t('描述资产、现象或策略想法。也可以先问问题,再补条件。')}
            className="min-h-[64px] resize-none border-0 bg-transparent px-1 py-2 text-sm shadow-none focus-visible:ring-0"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-muted-foreground">{t('研究模式 · Enter发送 / Shift+Enter换行')}</span>
            <Button size="xs" onClick={() => ask(text)} disabled={!text.trim() || sendM.isPending || !!pending || !!activeInquiry} title={activeInquiry ? t('会话里还有一次提问没跑完,等它结束或取消后再发。') : undefined}>
              <Send /> {t('发送')}
            </Button>
          </div>
        </div>
      </div>
    </Pane>
  );
}

function hasContext(c: ResearchSessionContext): boolean {
  return !!(c.selected_artifact_id || c.selected_run_id || c.selected_window || c.selected_inquiry_id);
}

/** 输入框上方的「围绕:<产物标题>」;追问时这些引用随消息一起发。 */
function ContextChip({ context, onClear }: { context: ResearchSessionContext; onClear: () => void }) {
  const aid = context.selected_artifact_id ?? null;
  const q = useQuery({ queryKey: ['research', 'artifact', aid], queryFn: () => researchApi.artifact(aid!), enabled: !!aid, staleTime: Infinity, retry: false });
  const label = aid ? (q.data?.title ?? `${t('产物')} ${aid.slice(0, 8)}`) : context.selected_run_id ? `${t('实验')} ${context.selected_run_id.slice(0, 8)}` : t('当前选中');
  const win = context.selected_window;
  return (
    <div className="mb-1.5 flex items-center gap-1.5 rounded-md border bg-muted/30 px-2 py-1 text-[10.5px] text-muted-foreground">
      <span>
        {t('围绕')}:<span className="text-foreground/85">{label}</span>
      </span>
      {win ? (
        <span className="num">
          {fmtDateTime(win.from_ms)} → {fmtDateTime(win.to_ms)}
        </span>
      ) : null}
      <button type="button" className="ml-auto hover:text-foreground" onClick={onClear} title={t('清除引用')}>
        <X className="size-3" />
      </button>
    </div>
  );
}
