/**
 * 来源卡(AI Scan / Strategy Run 同一套字段):
 *   名称 + 类型徽章 + 状态点 + 暂停/继续
 *   ② 判断方式(运行可改:直接做 / Jev / LLM / 只发信号;AI Scan 固定是模型 + playbook)
 *   今日漏斗:Candidates → Judged (follow) → Gates passed/entered → Orders
 *   被挡数(红,可点)→ Blocked today:币 · 时间 · 层 · 原因
 *   卡尾:进行中线程、已实现 R、Backtest compare(即将上线)
 * 点卡片 = 线程列表只看它开的。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Pause, Play } from 'lucide-react';
import { strategyRunsApi } from '@/api/client';
import type { StrategyRunMode } from '@/api/types';
import { RUN_MODE_LABEL } from '@/components/my-strategies/run-panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fmtClock } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fmtRunR } from './logic';
import { LAYER_LABEL, blockedRows, isStopDistanceReason, reasonExample, reasonLabel, startOfLocalDay, widenStopHint, type Funnel, type SourceCardModel, type SourceStatus, notTakenLine } from './sources-logic';
import type { BlockLayer } from '@/api/trading';

/** 可选的判断方式(confirm 已下线,只为老运行显示) */
export const JUDGE_MODES: readonly StrategyRunMode[] = ['auto', 'jev', 'agent', 'signal_only'];

const STATUS_TEXT: Record<SourceStatus, string> = tmap({ running: '运行中', paused: '已暂停', stopped: '已停止', error: '出错', halted: '急停中', capped: '今日额度用尽' });
const STATUS_DOT: Record<SourceStatus, string> = { running: 'bg-up', paused: 'bg-warn', capped: 'bg-warn', error: 'bg-down', halted: 'bg-down', stopped: 'bg-muted-foreground' };
export const LAYER_TONE: Record<BlockLayer, string> = {
  judge: 'border-primary/30 text-primary',
  strategy: 'border-warn/40 text-warn',
  gate: 'border-down/40 text-down',
  execution: 'border-border text-muted-foreground',
};

export function FunnelLine({ f, mode }: { f: Funnel; mode: SourceCardModel['mode'] }) {
  const stages: { key: string; label: string; value: string; title?: string }[] = [];
  if (f.candidates !== null) stages.push({ key: 'c', label: t('候选'), value: String(f.candidates) });
  if (f.judged !== null) stages.push({ key: 'j', label: t('已判断'), value: `${f.judged}${f.follow !== null ? ` (${mode === 'model' ? t('开仓 {n}', { n: f.follow }) : t('跟 {n}', { n: f.follow })})` : ''}` });
  else if (f.candidates !== null && (mode === 'auto' || mode === 'signal_only')) stages.push({ key: 'j', label: t('已判断'), value: '—', title: mode === 'auto' ? t('直接做:不判断,候选直接进风控检查') : t('只发信号:不下单') });
  if (f.gatesEntered !== null && f.gatesPassed !== null) stages.push({ key: 'g', label: t('风控检查'), value: `${f.gatesPassed}/${f.gatesEntered}`, title: t('通过 / 进入风控检查') });
  if (f.orders !== null) stages.push({ key: 'o', label: t('漏斗·下单'), value: String(f.orders) });
  if (!stages.length) return <div className="text-[11px] text-muted-foreground">{t('今天还没有数据')}</div>;
  return (
    <div className="num flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px]" data-testid="trade-source-funnel">
      {stages.map((s, i) => (
        <span key={s.key} className="inline-flex items-center gap-1" title={s.title}>
          {i > 0 ? <span className="text-muted-foreground/60">→</span> : null}
          <span className="text-muted-foreground">{s.label}</span>
          <span className="font-medium text-foreground">{s.value}</span>
        </span>
      ))}
    </div>
  );
}

export function SourceCard({
  model,
  active,
  onSelect,
  lock,
  busy,
  onToggle,
  onMode,
  now,
  minStopAtr,
}: {
  model: SourceCardModel;
  /** 风控的止损 ATR 下限;止损距离被挡时引导「放宽策略止损」 */
  minStopAtr?: string | number | null;
  active: boolean;
  onSelect: () => void;
  /** 访客只读原因;null = 可写 */
  lock: string | null;
  busy: boolean;
  /** 暂停 / 继续;没有 = 不显示按钮 */
  onToggle?: (() => void) | null;
  onMode?: ((mode: StrategyRunMode) => void) | null;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const f = model.funnel;
  const running = model.status === 'running' || model.status === 'capped';
  const r = fmtRunR(model.realizedR);
  const isRun = model.kind === 'strategy_run';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn('group cursor-pointer rounded-md border bg-card px-2.5 py-2 text-[12px] transition-colors hover:border-primary/40', active && 'border-primary bg-primary/[0.04] ring-1 ring-primary/30')}
      data-testid="trade-source-card"
      data-source={model.key}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[model.status])} title={STATUS_TEXT[model.status]} />
        <span className="min-w-0 truncate font-semibold" title={model.name}>
          {model.name}
        </span>
        {model.version ? <span className="num shrink-0 text-[10.5px] text-muted-foreground">v{model.version}</span> : null}
        {isRun || model.name !== 'AI Scan' ? (
          <span className={cn('shrink-0 rounded-sm border px-1 text-[10px] font-medium', isRun ? 'border-border text-muted-foreground' : 'border-primary/30 text-primary')}>{isRun ? 'Strategy Run' : 'AI Scan'}</span>
        ) : (
          <span className="shrink-0 text-[10px] text-muted-foreground" title={t('模型拿 playbook 看盘,单例')}>{t('模型看盘')}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {model.status !== 'running' ? (
            <span className={cn('text-[10.5px]', model.status === 'error' || model.status === 'halted' ? 'text-down' : 'text-warn')} title={model.note ?? undefined}>
              {STATUS_TEXT[model.status]}
            </span>
          ) : null}
          {onToggle ? (
            <button
              type="button"
              disabled={!!lock || busy}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={lock ?? (running ? t('暂停:不再开新仓,已有持仓照常管理') : t('继续运行'))}
              data-testid="trade-source-toggle"
            >
              {running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </button>
          ) : null}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="kicker text-[9.5px] text-muted-foreground" title={t('② 判断层:候选要不要做,由这个来源自己的判断方式决定')}>
          {t('判断层')}
        </span>
        {isRun && onMode ? (
          <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Select value={JUDGE_MODES.includes(model.mode as StrategyRunMode) ? (model.mode as string) : undefined} onValueChange={(v) => onMode(v as StrategyRunMode)} disabled={!!lock || busy}>
              <SelectTrigger size="sm" className="h-6 gap-1 rounded-full border-primary/30 bg-primary/5 px-2 py-0 text-[11px] font-medium text-primary" title={lock ?? t('改判断方式')} data-testid="trade-source-mode">
                <SelectValue placeholder={RUN_MODE_LABEL[model.mode as StrategyRunMode] ?? String(model.mode)} />
              </SelectTrigger>
              <SelectContent>
                {JUDGE_MODES.map((m) => (
                  <SelectItem key={m} value={m} className="text-[12px]" title={MODE_HINT[m]}>
                    {RUN_MODE_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <span className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 font-medium text-primary" title={t('AI Scan 由模型拿 playbook 判断')}>
            {model.mode === 'model' ? 'LLM' : RUN_MODE_LABEL[model.mode]}
            {model.playbook ? <span className="font-normal text-primary/80"> · {model.playbook}</span> : null}
          </span>
        )}
        <span className="num min-w-0 truncate text-muted-foreground">{metaLine(model)}</span>
      </div>

      {model.note && model.status !== 'running' ? <div className="mt-1 truncate text-[10.5px] text-warn" title={model.note}>{model.note}</div> : null}

      <div className="mt-1.5 flex items-center gap-1.5">
        {model.scope === 'total' ? <span className="shrink-0 rounded-sm bg-muted px-1 text-[9.5px] text-muted-foreground" title={t('来源接口没读到,显示的是累计数')}>{t('累计')}</span> : null}
        <FunnelLine f={f} mode={model.mode} />
      </div>

      {f.blocked > 0 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className="mt-1 inline-flex items-center gap-1 rounded-sm text-[11px] font-medium text-down hover:underline"
          data-testid="trade-source-blocked"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {model.scope === 'today' ? t('今日被挡 {n}', { n: f.blocked }) : t('被挡 {n}', { n: f.blocked })}
          <span className="font-normal text-muted-foreground">{layerBreakdown(f)}</span>
        </button>
      ) : null}
      {open ? <BlockedToday model={model} now={now} minStopAtr={minStopAtr ?? null} /> : null}
      {notTakenLine(model.notTaken) ? (
        <div className="num mt-1 truncate text-[10.5px] text-muted-foreground" title={t('没做,但不算被挡:模型判断不交易、观察、暂停、行情没到等')} data-testid="trade-source-not-taken">
          {t('今日没做:{s}', { s: notTakenLine(model.notTaken)! })}
        </div>
      ) : null}

      <div className="num mt-1.5 flex items-center gap-2 border-t pt-1.5 text-[10.5px] whitespace-nowrap text-muted-foreground">
        <span>{t('进行中 {n}', { n: model.openThreads ?? '—' })}</span>
        {r ? <span className={cn('font-medium', (model.realizedR ?? 0) >= 0 ? 'text-up' : 'text-down')}>{t('已实现 {r}', { r })}</span> : null}
        <span className="ml-auto min-w-0 cursor-not-allowed truncate text-muted-foreground/60" title={t('即将上线:把实盘结果和回测放在一起对比')}>
          {t('回测对比 →(即将上线)')}
        </span>
      </div>
    </div>
  );
}

const MODE_HINT: Record<StrategyRunMode, string> = tmap({
  auto: '候选直接进风控检查',
  jev: 'Jev 判不跟就不下',
  agent: 'LLM 逐笔判断',
  confirm: '旧方式',
  signal_only: '只发信号不下单',
});

function metaLine(m: SourceCardModel): string {
  const parts: string[] = [];
  if (m.kind === 'ai_scan') {
    if (m.symbols.length) parts.push(t('盯盘 {n} 个币', { n: m.symbols.length }));
    if (m.judgments) parts.push(m.judgments.cap > 0 ? t('今日判断 {a}/{b}', { a: m.judgments.used, b: m.judgments.cap }) : t('今日判断 {a}', { a: m.judgments.used }));
  } else {
    if (m.timeframe) parts.push(m.timeframe);
    if (m.symbols.length) parts.push(m.symbols.length <= 2 ? m.symbols.map((s) => s.replace(/USDT$/, '')).join(' ') : t('{n} 个币', { n: m.symbols.length }));
  }
  return parts.join(' · ');
}

function layerBreakdown(f: Funnel): string {
  const parts = (['judge', 'strategy', 'gate', 'execution'] as const).filter((k) => f.byLayer[k] > 0).map((k) => `${LAYER_LABEL[k]} ${f.byLayer[k]}`);
  if (f.unattributed > 0) parts.push(t('未分层 {n}', { n: f.unattributed }));
  return parts.join(' · ');
}

/** 展开的「今日被挡」:原因汇总(§9.56 top_reasons)+ 逐条(运行事件) */
function BlockedToday({ model, now, minStopAtr }: { model: SourceCardModel; now: number; minStopAtr: string | number | null }) {
  const runId = model.runId;
  const eventsQ = useQuery({
    queryKey: ['strategy-run-events', runId, 200],
    queryFn: () => strategyRunsApi.events(runId!, 200),
    enabled: !!runId,
    staleTime: 30_000,
    retry: false,
  });
  const since = model.scope === 'today' ? startOfLocalDay(now) : 0;
  const rows = blockedRows(eventsQ.data?.rows, since);
  return (
    <div className="mt-1.5 rounded-sm border border-down/20 bg-down/[0.03] px-2 py-1.5 text-[11px]" onClick={(e) => e.stopPropagation()} data-testid="trade-blocked-today">
      <div className="kicker mb-1 text-[9.5px] text-down">{model.scope === 'today' ? t('今日被挡') : t('最近被挡')}</div>
      {model.reasons.length ? (
        <div className="mb-1 flex flex-col gap-0.5">
          {model.reasons.map((r) => {
            const ex = reasonExample(r);
            return (
              <div key={`${r.layer}:${r.key}`} className="flex items-start gap-1.5" title={ex.message ?? undefined}>
                <LayerBadge layer={r.layer} />
                <span className="min-w-0 flex-1 leading-snug">
                  {reasonLabel(r)}
                  {isStopDistanceReason(r) ? <StopHint minStopAtr={minStopAtr} /> : null}
                </span>
                <span className="num shrink-0 font-medium">×{r.count}</span>
                {ex.symbol ? <span className="num shrink-0 text-muted-foreground">{ex.symbol.replace(/USDT$/, '')}{ex.at ? ` ${fmtClock(ex.at).slice(0, 5)}` : ''}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {runId ? (
        eventsQ.isLoading ? (
          <div className="text-muted-foreground">{t('加载中…')}</div>
        ) : rows.length ? (
          <div className={cn('flex max-h-48 flex-col gap-0.5 overflow-y-auto', model.reasons.length && 'border-t pt-1')}>
            {rows.slice(0, 30).map((row) => (
              <div key={row.id} className="flex items-start gap-1.5">
                <span className="num w-10 shrink-0 font-medium">{row.symbol?.replace(/USDT$/, '') ?? '—'}</span>
                <span className="num w-9 shrink-0 text-muted-foreground">{fmtClock(row.at).slice(0, 5)}</span>
                <LayerBadge layer={row.layer} />
                <span className="min-w-0 flex-1 break-words leading-snug text-muted-foreground">
                  {row.reason}
                  {isStopDistanceReason({ reason: row.reason }) ? <StopHint minStopAtr={minStopAtr} /> : null}
                </span>
              </div>
            ))}
          </div>
        ) : !model.reasons.length ? (
          <div className="text-muted-foreground">{t('最近 200 条运行事件里没找到今天被挡的明细')}</div>
        ) : null
      ) : !model.reasons.length ? (
        <div className="text-muted-foreground">{t('没有逐条明细;被挡原因会在判断记录里')}</div>
      ) : null}
    </div>
  );
}

/** 止损距离被挡:该放宽的是策略止损(按 ATR),不是去调低风控下限 */
function StopHint({ minStopAtr }: { minStopAtr: string | number | null }) {
  return (
    <span className="block text-[10.5px] text-primary" title={t('止损太近容易被正常波动扫掉;下限是保护,不建议调低')}>
      → {widenStopHint(minStopAtr)}
    </span>
  );
}

export function LayerBadge({ layer }: { layer: BlockLayer }) {
  return <span className={cn('shrink-0 rounded-sm border px-1 text-[9.5px] leading-[14px] font-medium', LAYER_TONE[layer])}>{LAYER_LABEL[layer]}</span>;
}
