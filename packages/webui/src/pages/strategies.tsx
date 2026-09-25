/**
 * 实盘部署台(#strategies,原「策略库」,v3.5,docs/design/strategy-library-2026-09-05.md)。
 * 2026-09-23 起不在侧栏:用户在「我的策略」里看策略,这里只作为「部署」页签的深链目标做实盘侧操作
 * (晋升/启用/票池轮换);#strategies?id=<内置 id> 直接打开该策略详情。见 docs/research/strategy-merge-plan-2026-09-23.md。
 *
 * 一条策略是**不可变的版本化对象**——触发(哪些事件才唤醒它)+ 清单(代码必须能算出来的证据)+
 * 规则(模型只能在这些边里选)+ 参数(带范围,改一个就是新版本 + 新 hash)+ 评测统计。
 *
 * 这一页刻意**没有**「直接改一个在跑的策略的数字」这条路:
 *   改参数 = 采纳一条归因 → 生成 draft 新版本;
 *   上线   = draft → backtest → shadow → paper → live_capped 一格一格晋升,
 *            而且 paper → live_capped 必须原样输入 LIVE 才放行;
 *   实盘启用开关只对 ≥ paper 的策略开放,低于 paper 的开关是灰的。
 *
 * react-query key 约定见 App.tsx 顶部注释:
 *   ['strategies']      GET /api/strategies(列表 + active + 文案表)
 *   ['strategies', id]  GET /api/strategies/:id(spec + 版本列表 + 归因点)
 *   ['allocator']       GET /api/strategies/allocator(§9.35 票池轮换;写操作后连同
 *                       ['strategies'] / ['workflow'] 一起失效)
 * 任何写操作后两个 key 都失效;SSE `strategy.changed` 在 App.tsx 里按 ['strategies'] 前缀
 * 一次性失效,本页不自己开 /api/events。
 */
import { Fragment, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, History, Power, PowerOff, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type {
  AttributionKind,
  AttributionPoint,
  StrategyEvent,
  StrategyEventActor,
  StrategyEventKind,
  StrategyEvidenceSpec,
  StrategySpec,
  StrategyStatus,
  StrategyView,
  Tier,
} from '@/api/types';
import { TIER_LABEL, TIER_OF, TIERS } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { AllocatorCard } from '@/components/strategy/AllocatorCard';
import { EvidenceEditor } from '@/components/strategy/EvidenceEditor';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { fmtDateTime, triggerLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// 文案与样式(策略库契约独有,只在本页用,不进 lib/format.ts)

/** 晋升路线,retired 不在其中。「低于 paper 不能实盘启用」也按这个序判定。 */
const STATUS_ORDER: StrategyStatus[] = ['draft', 'backtest', 'shadow', 'paper', 'live_capped'];

const FALLBACK_STATUS_LABEL: Record<StrategyStatus, string> = tmap({
  draft: '草稿',
  backtest: '回测中',
  shadow: '影子',
  paper: '纸面',
  live_capped: '限额实盘',
  retired: '已退役',
});

/**
 * 六个状态六种样式(§9.27 的状态机一眼能认出来)。配色约束沿用全站口径:绿/红只表示多空或盈亏,
 * 所以 live_capped 用强调色 + 加粗,不用红;draft 用虚线边与 retired(实线 + 半透明)区分开。
 */
function statusBadgeClass(status: StrategyStatus): string {
  switch (status) {
    case 'backtest':
      return 'bg-primary/15 text-primary border-primary/30';
    case 'shadow':
      return 'bg-warn/15 text-warn border-warn/30';
    case 'paper':
      return 'bg-up/15 text-up border-up/30';
    case 'live_capped':
      return 'bg-accent text-accent-foreground border-foreground/25 font-semibold';
    case 'retired':
      return 'bg-muted text-muted-foreground border-transparent opacity-60';
    default:
      return 'border-dashed border-muted-foreground/40 bg-transparent text-muted-foreground'; // draft
  }
}

/** §9.27 台账一行的动作;和状态徽章一样,绿/红不表示好坏,只有 demote 用 warn。 */
const EVENT_KIND_LABEL: Record<StrategyEventKind, string> = tmap({
  version_created: '生成版本',
  promote: '晋升',
  demote: '降级',
  retire: '退役',
  activated: '启用',
  deactivated: '停用',
});

const EVENT_ACTOR_LABEL: Record<StrategyEventActor, string> = tmap({
  code: '代码',
  human: '人',
  lab: '实验室',
  attribution: '归因',
});

function eventKindClass(kind: StrategyEventKind): string {
  if (kind === 'promote') return 'bg-up/15 text-up border-up/30';
  if (kind === 'demote' || kind === 'deactivated') return 'bg-warn/15 text-warn border-warn/30';
  if (kind === 'retire') return 'bg-muted text-muted-foreground border-transparent';
  if (kind === 'activated') return 'bg-primary/15 text-primary border-primary/30';
  return 'bg-muted text-muted-foreground border-transparent';
}

/** 台账 evidence 里的数字键 → 中文;认不出来的原样显示 key(契约说得清楚:只写数字,不写形容词)。 */
const EVIDENCE_KEY_LABEL: Record<string, string> = tmap({
  lab_n: '实验室笔数',
  lab_expectancy_r: '实验室期望',
  shadow_n: '影子笔数',
  shadow_expectancy_r: '影子期望',
  shadow_max_drawdown_r: '影子回撤',
  loss_streak: '连亏',
  base_expectancy_r: '基线期望',
  probe_expectancy_r: '探针期望',
  n: '笔数',
  expectancy_r: '期望',
  win_rate: '胜率',
});

/** evidence 的值可为 null:一律显示「—」,不 toFixed。 */
function fmtEvidenceValue(v: number | null): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

const ATTRIBUTION_KIND_LABEL: Record<AttributionKind, string> = tmap({
  rule_wording: '改措辞',
  param: '改参数',
  checklist_item: '加清单项',
});

function attributionKindClass(kind: AttributionKind): string {
  if (kind === 'param') return 'bg-primary/15 text-primary border-primary/30';
  if (kind === 'checklist_item') return 'bg-warn/15 text-warn border-warn/30';
  return 'bg-muted text-muted-foreground border-transparent';
}

function statusRank(status: StrategyStatus): number {
  return STATUS_ORDER.indexOf(status);
}

/** 低于 paper 的(草稿/回测中/影子)以及已退役的,都不能挂到实盘启用列表里。 */
function canGoLive(status: StrategyStatus): boolean {
  const r = statusRank(status);
  return r >= 0 && r >= statusRank('paper');
}

function fmtR(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return '—';
  return `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`;
}

function fmtWinRate(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(0)}%`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

// ---------------------------------------------------------------------------
// 小组件

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted-foreground select-none">{label}</div>
      <div className={cn('num truncate text-[11px] font-semibold', tone === 'up' && 'text-up', tone === 'down' && 'text-down')}>{value}</div>
    </div>
  );
}

function LineList({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10.5px] font-semibold text-muted-foreground select-none">{title}</div>
      <ul className="flex flex-col gap-0.5">
        {lines.map((line, i) => (
          <li key={`${i}-${line}`} className="flex gap-1.5 text-[11px] leading-relaxed">
            <span className="num shrink-0 text-muted-foreground">{i + 1}.</span>
            <span className="min-w-0 flex-1">{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * §9.27:三块成绩并排,口径刻意分开写清楚——
 *   实验室 = 漏斗法机械前瞻(零模型),影子实盘 = 虚拟线程按真实 K 线结算,评测 = 含模型的回放。
 * shadow→paper 那道自动门只看中间那块;没有数就是「—」(n=0 时网关每个数都给 null,不编数)。
 */
function StatsRow({ lab, evalStats }: { lab: NonNullable<StrategyView['lab_stats']> | null; evalStats: StrategyView['eval_stats'] }) {
  const shadow = lab?.shadow ?? null;
  return (
    <div className="grid gap-1.5 rounded-sm bg-muted/40 px-2 py-1.5 sm:grid-cols-4">
      <div className="min-w-0" title={lab?.note ?? t('还没跑过 Strategy Lab')}>
        <div className="text-[10px] font-semibold text-muted-foreground select-none">{t('实验室')}</div>
        <div className="flex gap-2">
          <Stat label={t('有效 n')} value={lab ? String(lab.n) : '—'} />
          <Stat label={t('期望')} value={fmtR(lab?.expectancy_r)} tone={lab?.expectancy_r == null ? undefined : lab.expectancy_r >= 0 ? 'up' : 'down'} />
          <Stat label={t('胜率')} value={fmtWinRate(lab?.win_rate)} />
        </div>
      </div>
      <div className="min-w-0 sm:border-l sm:pl-2" title={t('独立代码策略执行器:使用策略入场、止损、止盈、持有期与成本结算；模型回放另见评测')}>
        <div className="text-[10px] font-semibold text-muted-foreground select-none">{t('完整策略成绩')}</div>
        <div className="flex gap-2">
          <Stat label={t('有效 n')} value={shadow ? String(shadow.n) : '—'} />
          <Stat label={t('期望')} value={fmtR(shadow?.net_expectancy_r)} tone={shadow?.net_expectancy_r == null ? undefined : shadow.net_expectancy_r >= 0 ? 'up' : 'down'} />
          <Stat label={t('回撤')} value={shadow?.net_max_drawdown_r != null ? `${shadow.net_max_drawdown_r.toFixed(2)}R` : '—'} />
        </div>
      </div>
      <div className="min-w-0 sm:border-l sm:pl-2" title={t('固定方向代理，不用于完整策略晋升')}>
        <div className="text-[10px] font-semibold text-muted-foreground">{t('代码方向代理成绩')}</div>
        <div className="flex gap-2">
          <Stat label={t('有效 n')} value={String(shadow?.direction_proxy?.n ?? 0)} />
          <Stat label={t('净期望')} value={fmtR(shadow?.direction_proxy?.net_expectancy_r)} />
        </div>
      </div>
      <div className="min-w-0 sm:border-l sm:pl-2" title={t('评测:含模型的回放成绩')}>
        <div className="text-[10px] font-semibold text-muted-foreground select-none">{t('评测')}</div>
        <div className="flex gap-2">
          <Stat label={t('成交')} value={String(evalStats.trades)} />
          <Stat label={t('期望')} value={fmtR(evalStats.expectancy_r)} tone={evalStats.expectancy_r === null ? undefined : evalStats.expectancy_r >= 0 ? 'up' : 'down'} />
          <Stat label={t('MAE')} value={fmtR(evalStats.mae_r_p50)} />
        </div>
      </div>
    </div>
  );
}

/**
 * §9.27 证据段,**这一版只读**:多选编辑(换一套证据 = 换 content_hash = 新版本)留下一轮,
 * 这里先把「这条策略到底喂了哪些指标/事件/话题」显示清楚,省得只能去翻 prompt。
 */
function EvidenceBlock({ effective, custom }: { effective: StrategyEvidenceSpec | null; custom: StrategyEvidenceSpec | null | undefined }) {
  if (!effective) return null;
  const isDefault = !custom;
  return (
    <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <div className="text-[11.5px] font-semibold">{t('证据')}</div>
        <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', isDefault ? 'bg-muted text-muted-foreground border-transparent' : 'bg-primary/15 text-primary border-primary/30')}>
          {isDefault ? t('按默认集') : t('自定义')}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10.5px] text-muted-foreground">{t('指标')}</span>
        {effective.indicators.length === 0 ? (
          <span className="text-[10.5px] text-muted-foreground">—</span>
        ) : (
          effective.indicators.map((ind, i) => (
            <Badge key={`${ind.id}-${ind.tf}-${i}`} variant="outline" className="num h-4 px-1.5 text-[10px]">
              {ind.id}
              <span className="ml-0.5 text-muted-foreground">{ind.tf}</span>
            </Badge>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10.5px] text-muted-foreground">{t('事件')}</span>
        {effective.events.length === 0 ? (
          <span className="text-[10.5px] text-muted-foreground">{t('不收窄(沿用触发种类)')}</span>
        ) : (
          effective.events.map((k) => (
            <Badge key={k} variant="outline" className="h-4 px-1.5 text-[10px]">
              {triggerLabel(k)}
            </Badge>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10.5px] text-muted-foreground">{t('新闻话题')}</span>
        {!effective.info_topics || effective.info_topics.length === 0 ? (
          <span className="text-[10.5px] text-muted-foreground">—</span>
        ) : (
          effective.info_topics.map((topic) => (
            <Badge key={topic} variant="outline" className="h-4 px-1.5 text-[10px]">
              {topic}
            </Badge>
          ))
        )}
      </div>
      <div className="text-[10px] leading-relaxed text-muted-foreground">
        {t('换一套证据 = 换了判断输入 = 必须是新版本(证据进 content_hash),所以这里只看不改。')}
      </div>
    </section>
  );
}

/**
 * §9.27 晋升时间线:竖向,**旧的在前**(从上往下走),每行 who / 状态迁移 / 理由 / 判这一步用到的数字。
 * `who` 里没有模型——模型没有任何晋升权,这一点在界面上也要看得出来。
 */
function TimelineBlock({ events, loading, error }: { events: StrategyEvent[]; loading: boolean; error: string | null }) {
  return (
    <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
      <div className="text-[11.5px] font-semibold">
        {t('晋升时间线')} <span className="num ml-1 text-[10.5px] font-normal text-muted-foreground">{t('{n} 条', { n: events.length })}</span>
      </div>
      {loading ? <span className="text-[11px] text-muted-foreground">{t('加载中…')}</span> : null}
      {error ? <span className="text-[11px] text-destructive">{t('加载失败')}:{error}</span> : null}
      {!loading && !error && events.length === 0 ? (
        <span className="text-[11px] leading-relaxed text-muted-foreground">{t('还没有台账。状态迁移、启停、生成版本都会在这里留一行。')}</span>
      ) : null}
      {events.length > 0 ? (
        <ol className="flex flex-col">
          {events.map((ev, i) => {
            const numbers = Object.entries(ev.evidence ?? {});
            return (
              <li key={ev.id ?? `${ev.at}-${i}`} className="flex min-w-0 gap-2">
                {/* 竖线 + 节点 */}
                <div className="flex w-3 shrink-0 flex-col items-center">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', ev.kind === 'demote' ? 'bg-warn' : ev.kind === 'promote' ? 'bg-up' : 'bg-muted-foreground/50')} />
                  {i < events.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
                </div>
                <div className="min-w-0 flex-1 pb-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className={cn('h-4 shrink-0 px-1.5 text-[10px]', eventKindClass(ev.kind))}>
                      {EVENT_KIND_LABEL[ev.kind] ?? ev.kind}
                    </Badge>
                    <span className="num text-[10px] text-muted-foreground">v{ev.version}</span>
                    <span className="text-[10px] text-muted-foreground">{EVENT_ACTOR_LABEL[ev.who] ?? ev.who}</span>
                    {ev.from_status || ev.to_status ? (
                      <span className="text-[10px] text-muted-foreground">
                        {ev.from_status ? FALLBACK_STATUS_LABEL[ev.from_status] : '—'} → {ev.to_status ? FALLBACK_STATUS_LABEL[ev.to_status] : '—'}
                      </span>
                    ) : null}
                    <span className="num ml-auto shrink-0 text-[10px] text-muted-foreground">{fmtDateTime(ev.at)}</span>
                  </div>
                  {ev.reason ? <div className="text-[10.5px] leading-relaxed text-muted-foreground">{ev.reason}</div> : null}
                  {numbers.length > 0 ? (
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                      {numbers.map(([k, v]) => (
                        <span key={k} className="num text-[10px] text-muted-foreground">
                          {EVIDENCE_KEY_LABEL[k] ?? k} <span className="font-semibold text-foreground">{fmtEvidenceValue(v)}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 卡片

function StrategyCard({
  s,
  busy,
  onToggleActive,
  onPromote,
  onRetire,
  onOpenDetail,
}: {
  s: StrategyView;
  busy: boolean;
  onToggleActive: (next: boolean) => void;
  onPromote: () => void;
  onRetire: () => void;
  onOpenDetail: () => void;
}) {
  // §9.28:能不能启用**由网关说了算**(activatable = 有 ≥ paper 的版本),前端不自己推状态;
  // 老网关没有这个字段时退回本地口径(status ≥ paper)。
  const canActivate = s.activatable ?? canGoLive(s.status);
  const activateBlockedReason = canActivate
    ? null
    : s.status === 'shadow' && s.shadow_blocked
      ? t('还在影子:{why}', { why: s.shadow_blocked })
      : s.status === 'retired'
        ? t('已退役,不能启用')
        : t('状态是「{status}」,只有 paper / 限额实盘能启用', { status: s.status_label || FALLBACK_STATUS_LABEL[s.status] });
  const entryPreview = s.rules.entry.slice(0, 2);
  const st = s.eval_stats;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 rounded-md border bg-card px-2.5 py-2', s.status === 'retired' && 'opacity-70')}>
      {/* 名字 / 家族 / 状态 / 版本 */}
      <div className="flex min-w-0 items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold">{s.name}</div>
          <div className="num truncate text-[10px] text-muted-foreground">{s.id}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', statusBadgeClass(s.status))}>
            {s.status_label || FALLBACK_STATUS_LABEL[s.status]}
          </Badge>
          <span className="num text-[10px] text-muted-foreground">
            v{s.version} · {shortHash(s.content_hash)}
          </span>
        </div>
      </div>

      {/* 触发 */}
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="h-4 shrink-0 border-transparent bg-muted px-1.5 text-[10px] text-muted-foreground">
          {s.family_label}
        </Badge>
        {s.trigger.kinds.map((k) => (
          <Badge key={k} variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">
            {triggerLabel(k)}
          </Badge>
        ))}
        <span className="num text-[10px] text-muted-foreground">≥{s.trigger.min_timeframe}</span>
        <span className="num text-[10px] text-muted-foreground">{t('冷却 {n} 根', { n: s.trigger.cooldown_bars })}</span>
      </div>

      {/* 入场规则前两条 */}
      <div className="flex flex-col gap-0.5">
        {entryPreview.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">{t('还没写入场规则')}</span>
        ) : (
          entryPreview.map((line, i) => (
            <div key={`${i}-${line}`} className="truncate text-[11px] text-foreground/90" title={line}>
              <span className="num mr-1 text-muted-foreground">{i + 1}.</span>
              {line}
            </div>
          ))
        )}
        {s.rules.entry.length > 2 ? <span className="text-[10px] text-muted-foreground">{t('还有 {n} 条,点「查看版本」看全', { n: s.rules.entry.length - 2 })}</span> : null}
      </div>

      {/* 三块成绩并排:实验室(机械前瞻,零模型)/ 影子实盘(虚拟线程结算)/ 评测(含模型的回放) */}
      <StatsRow lab={s.lab_stats ?? null} evalStats={st} />
      {st.noise_note ? <div className="text-[10px] leading-relaxed text-muted-foreground">{st.noise_note}</div> : null}

      {/* 操作 */}
      <div className="flex flex-wrap items-center gap-1.5 border-t pt-1.5">
        <Button
          size="xs"
          variant={s.active ? 'secondary' : 'outline'}
          disabled={busy || (!s.active && !canActivate)}
          title={s.active ? t('从票池里摘掉;在途线程不受影响(它们钉住的是开仓时那个版本)') : (activateBlockedReason ?? t('放进票池:这条策略会参加每次扫描的议会表态'))}
          onClick={() => onToggleActive(!s.active)}
        >
          {s.active ? <PowerOff data-slot="icon" /> : <Power data-slot="icon" />}
          {s.active ? t('停用') : t('启用')}
        </Button>
        {s.active ? (
          <Badge variant="outline" className="h-4 border-primary/30 bg-primary/15 px-1.5 text-[10px] text-primary">
            {t('在票池')}
          </Badge>
        ) : null}
        {!s.active && activateBlockedReason ? <span className="text-[10px] leading-relaxed text-muted-foreground">{activateBlockedReason}</span> : null}

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            onClick={onPromote}
            disabled={busy || s.promote_blocked !== null || s.next_status === null}
            title={s.promote_blocked ?? undefined}
          >
            <ArrowUpCircle data-slot="icon" />
            {t('晋升')}
          </Button>
          <Button size="xs" variant="outline" onClick={onRetire} disabled={busy || s.status === 'retired'}>
            <Trash2 data-slot="icon" />
            {t('退役')}
          </Button>
          <Button size="xs" variant="outline" onClick={onOpenDetail}>
            <History data-slot="icon" />
            {t('查看版本')}
          </Button>
        </div>
      </div>
      {s.promote_blocked ? <div className="text-[10px] leading-relaxed text-muted-foreground">{t('还不能晋升')}:{s.promote_blocked}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 详情抽屉:完整规则 / 参数 / 清单 / 版本列表 / 归因

function DetailSheet({
  id,
  open,
  onOpenChange,
  onAdopt,
  adoptingId,
}: {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdopt: (point: AttributionPoint) => void;
  adoptingId: string | null;
}) {
  const detailQ = useQuery({
    queryKey: ['strategies', id],
    queryFn: () => api.strategyDetail(id!),
    enabled: open && Boolean(id),
  });

  /**
   * §9.27 台账走专用路由(500 行,旧的在前);/api/strategies/:id 里也带一份(200 行),
   * 老网关两边都没有时就是空数组 —— 显示「还没有台账」而不是报错。
   */
  const timelineQ = useQuery({
    queryKey: ['strategies', id, 'timeline'],
    queryFn: () => api.strategyTimeline(id!),
    enabled: open && Boolean(id),
    retry: 0,
  });

  const strategy = detailQ.data?.strategy ?? null;
  const versions = detailQ.data?.versions ?? [];
  const attributions = detailQ.data?.attributions ?? [];
  const timeline = timelineQ.data?.events ?? detailQ.data?.timeline ?? [];
  const degrade = detailQ.data?.degrade ?? null;
  const shadowThreads = detailQ.data?.shadow_threads ?? [];
  const paramRows = useMemo(() => (strategy ? Object.entries(strategy.params) : []), [strategy]);
  /** §9.34:证据存成新草稿后滚到时间线(那一行 version_created 就是这次改动的回执)。 */
  const timelineRef = useRef<HTMLDivElement | null>(null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="text-[13px]">{strategy ? strategy.name : t('策略详情')}</SheetTitle>
          <SheetDescription className="num text-[11px]">
            {strategy ? `${strategy.id} · v${strategy.version} · ${shortHash(strategy.content_hash)} · ${strategy.status_label}` : t('加载中…')}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-4">
            {detailQ.isLoading ? <div className="text-[11px] text-muted-foreground">{t('加载中…')}</div> : null}
            {detailQ.isError ? (
              <div className="text-[11px] text-destructive">
                {t('加载失败')}:{detailQ.error instanceof Error ? detailQ.error.message : t('网关没给数据')}
              </div>
            ) : null}

            {strategy ? (
              <>
                {/* 规则 */}
                <section className="flex flex-col gap-2 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">{t('规则')}</div>
                  <LineList title={t('入场')} lines={strategy.rules.entry} />
                  <LineList title={t('失效条件')} lines={strategy.rules.invalidation} />
                  <LineList title={t('离场')} lines={strategy.rules.exit} />
                  {strategy.rules.sizing_note ? (
                    <div className="flex flex-col gap-0.5">
                      <div className="text-[10.5px] font-semibold text-muted-foreground select-none">{t('仓位说明')}</div>
                      <div className="text-[11px] leading-relaxed">{strategy.rules.sizing_note}</div>
                    </div>
                  ) : null}
                </section>

                {/* 参数 */}
                <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">{t('参数')}</div>
                  {paramRows.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">{t('这条策略没有可调参数。')}</span>
                  ) : (
                    <div className="overflow-hidden rounded-sm border">
                      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,2fr)] gap-px bg-border">
                        {[t('参数'), t('当前值'), t('范围'), t('说明')].map((h) => (
                          <div key={h} className="bg-muted/60 px-2 py-1 text-[10px] font-semibold text-muted-foreground select-none">
                            {h}
                          </div>
                        ))}
                        {paramRows.map(([key, p]) => (
                          <Fragment key={key}>
                            <div className="num bg-card px-2 py-1 text-[10.5px]">{key}</div>
                            <div className="num bg-card px-2 py-1 text-[10.5px] font-semibold">
                              {p.value}
                              {p.unit ? <span className="ml-0.5 font-normal text-muted-foreground">{p.unit}</span> : null}
                            </div>
                            <div className="num bg-card px-2 py-1 text-[10.5px] text-muted-foreground">
                              [{p.min}, {p.max}]
                            </div>
                            <div className="bg-card px-2 py-1 text-[10.5px] text-muted-foreground">{p.note ?? '—'}</div>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="text-[10px] leading-relaxed text-muted-foreground">
                    {t('参数不能就地改。想落地,只能采纳一条归因生成新版本,再一格一格晋升。')}
                  </div>
                </section>

                {/* 清单 */}
                <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">{t('清单')}</div>
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10.5px] text-muted-foreground">{t('必备证据')}</span>
                    {strategy.checklist.required.length === 0 ? (
                      <span className="text-[10.5px] text-muted-foreground">—</span>
                    ) : (
                      strategy.checklist.required.map((r) => (
                        <Badge key={r} variant="outline" className="num h-4 px-1.5 text-[10px]">
                          {r}
                        </Badge>
                      ))
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10.5px] text-muted-foreground">{t('周期')}</span>
                    {strategy.checklist.timeframes.length === 0 ? (
                      <span className="text-[10.5px] text-muted-foreground">—</span>
                    ) : (
                      strategy.checklist.timeframes.map((tf) => (
                        <Badge key={tf} variant="outline" className="num h-4 px-1.5 text-[10px]">
                          {tf}
                        </Badge>
                      ))
                    )}
                  </div>
                </section>

                {/* §9.27 证据(只读) */}
                <EvidenceBlock effective={strategy.effective_evidence ?? null} custom={strategy.evidence} />

                {/* §9.34 自定义证据编辑器:保存 = 出新 draft(evidence 进 content_hash),存完滚到时间线 */}
                {strategy.effective_evidence ? (
                  <EvidenceEditor
                    strategyId={strategy.id}
                    effective={strategy.effective_evidence}
                    custom={Boolean(strategy.evidence)}
                    headVersion={strategy.version}
                    onSaved={() => {
                      void detailQ.refetch();
                      void timelineQ.refetch();
                      timelineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  />
                ) : null}

                {/* §9.27 成绩三块 + 影子线程 + 离降级还有多远 */}
                <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">{t('成绩')}</div>
                  <StatsRow lab={strategy.lab_stats ?? null} evalStats={strategy.eval_stats} />
                  {strategy.shadow_blocked ? (
                    <div className="text-[10.5px] leading-relaxed text-warn">{t('离 paper 还差')}:{strategy.shadow_blocked}</div>
                  ) : null}
                  {degrade ? (
                    <div className={cn('text-[10.5px] leading-relaxed', degrade.degrade ? 'text-warn' : 'text-muted-foreground')}>
                      {degrade.degrade ? t('已达降级线') : t('离降级还有多远')}:{degrade.reason}
                      <span className="num ml-1">
                        ({t('已结算')} {degrade.n} · {t('期望')} {fmtR(degrade.expectancy_r)} · {t('连亏')} {degrade.loss_streak})
                      </span>
                    </div>
                  ) : null}
                  {shadowThreads.length > 0 ? (
                    <div className="text-[10.5px] leading-relaxed text-muted-foreground">
                      {t('影子线程 {n} 条', { n: shadowThreads.length })} ·{' '}
                      {t('在跑 {open} · 已结算 {settled}', {
                        open: shadowThreads.filter((x) => x.status === 'open').length,
                        settled: shadowThreads.filter((x) => x.status === 'settled').length,
                      })}
                    </div>
                  ) : null}
                  <div className="text-[10px] leading-relaxed text-muted-foreground">
                    {t('降级是退回 backtest 重来,不是退役;降级会自动把它移出票池。')}
                  </div>
                </section>

                {/* §9.27 晋升时间线 */}
                <div ref={timelineRef} />
                <TimelineBlock
                  events={timeline}
                  loading={timelineQ.isLoading && timeline.length === 0}
                  error={timelineQ.isError && timeline.length === 0 ? (timelineQ.error instanceof Error ? timelineQ.error.message : t('网关没给数据')) : null}
                />

                {/* 版本列表 */}
                <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">
                    {t('版本')} <span className="num ml-1 text-[10.5px] font-normal text-muted-foreground">{t('{n} 个', { n: versions.length })}</span>
                  </div>
                  <div className="overflow-hidden rounded-sm border">
                    <div className="grid grid-cols-[minmax(0,0.5fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.5fr)_minmax(0,0.7fr)] gap-px bg-border">
                      {[t('版本'), t('状态'), 'hash', t('创建时间'), t('父版本')].map((h) => (
                        <div key={h} className="bg-muted/60 px-2 py-1 text-[10px] font-semibold text-muted-foreground select-none">
                          {h}
                        </div>
                      ))}
                      {versions.map((v: StrategySpec) => (
                        <Fragment key={`${v.id}-${v.version}`}>
                          <div className="num bg-card px-2 py-1 text-[10.5px] font-semibold">v{v.version}</div>
                          <div className="bg-card px-2 py-1">
                            <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', statusBadgeClass(v.status))}>
                              {FALLBACK_STATUS_LABEL[v.status] ?? v.status}
                            </Badge>
                          </div>
                          <div className="num bg-card px-2 py-1 text-[10.5px] text-muted-foreground">{shortHash(v.content_hash)}</div>
                          <div className="num bg-card px-2 py-1 text-[10.5px] text-muted-foreground">{fmtDateTime(v.created_at)}</div>
                          <div className="num bg-card px-2 py-1 text-[10.5px] text-muted-foreground">
                            {v.parent_version === null || v.parent_version === undefined ? '—' : `v${v.parent_version}`}
                          </div>
                        </Fragment>
                      ))}
                    </div>
                  </div>
                </section>

                {/* 归因 */}
                <section className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
                  <div className="text-[11.5px] font-semibold">
                    {t('归因')} <span className="num ml-1 text-[10.5px] font-normal text-muted-foreground">{t('{n} 条', { n: attributions.length })}</span>
                  </div>
                  {attributions.length === 0 ? (
                    <span className="text-[11px] leading-relaxed text-muted-foreground">{t('还没有归因点位。跑完一次回测,去回放页点「跑归因」。')}</span>
                  ) : (
                    attributions.map((point) => (
                      <div key={point.id} className="flex flex-col gap-1 rounded-sm border px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className={cn('h-4 shrink-0 px-1.5 text-[10px]', attributionKindClass(point.kind))}>
                            {ATTRIBUTION_KIND_LABEL[point.kind]}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{point.title}</span>
                          <span className="num shrink-0 text-[10px] text-muted-foreground">{fmtDateTime(point.at)}</span>
                        </div>
                        <div className="flex flex-col gap-0.5 text-[10.5px] leading-relaxed">
                          <div>
                            <span className="text-muted-foreground">{t('证据显示')} </span>
                            {point.evidence_said}
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('规则说')} </span>
                            {point.rule_said}
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('实际')} </span>
                            {point.actual}
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('提议')} </span>
                            {point.proposal.kind === 'param' && point.proposal.param
                              ? t('把 {param} 改成 {value}', { param: point.proposal.param, value: point.proposal.value ?? '—' })
                              : point.proposal.text}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {point.applied_version !== null ? (
                            <span className="num text-[10.5px] text-muted-foreground">{t('已采纳')} → v{point.applied_version}</span>
                          ) : (
                            <Button size="xs" variant="outline" onClick={() => onAdopt(point)} disabled={adoptingId !== null}>
                              <Sparkles data-slot="icon" />
                              {adoptingId === point.id ? t('生成中…') : t('生成新版本')}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </section>
              </>
            ) : null}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 页面

export function StrategiesPage() {
  const queryClient = useQueryClient();
  const [includeRetired, setIncludeRetired] = useState(false);
  // #strategies?id=<id>:从「我的策略 → 部署」深链过来时直接打开该策略详情
  const [detailId, setDetailId] = useState<string | null>(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('id'));
  const [promoteTarget, setPromoteTarget] = useState<StrategyView | null>(null);
  const [retireTarget, setRetireTarget] = useState<StrategyView | null>(null);
  const [adoptingId, setAdoptingId] = useState<string | null>(null);

  const listQ = useQuery({ queryKey: ['strategies'], queryFn: () => api.strategies(true), staleTime: 10_000 });

  const all = useMemo(() => listQ.data?.strategies ?? [], [listQ.data]);
  const active = useMemo(() => listQ.data?.active ?? [], [listQ.data]);
  const shown = useMemo(() => (includeRetired ? all : all.filter((s) => s.status !== 'retired')), [all, includeRetired]);
  const retiredCount = useMemo(() => all.filter((s) => s.status === 'retired').length, [all]);

  /**
   * §9.37 按短 / 中 / 长分层显示。分组只看 `horizon`(网关权威);老网关没有这个字段的策略
   * 单独归到「未标注周期」那一组 —— **不按周期猜**,策略页的分组必须和闸/allocator 看到的是同一个。
   */
  const grouped = useMemo(() => {
    const buckets = new Map<Tier | 'unknown', StrategyView[]>();
    for (const s of shown) {
      const tier: Tier | 'unknown' = s.horizon ? (TIER_OF[s.horizon] ?? 'unknown') : 'unknown';
      buckets.set(tier, [...(buckets.get(tier) ?? []), s]);
    }
    return [...TIERS, 'unknown' as const]
      .map((tier) => ({
        tier,
        label: tier === 'unknown' ? t('未标注周期') : t(TIER_LABEL[tier]),
        items: buckets.get(tier) ?? [],
        active: (buckets.get(tier) ?? []).filter((s) => s.active).length,
      }))
      .filter((g) => g.items.length > 0);
  }, [shown]);

  /** 两个 key 一起失效:列表 + 已打开的详情。 */
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['strategies'] });
    await queryClient.invalidateQueries({ queryKey: ['overview'] });
  };

  const failed = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err));

  /**
   * §9.28:启用 / 停用走**单条**路由,网关自己在现有集合上增删一个 id(前端不拼全集,
   * 也就不会把别人刚改过的票池整包覆盖掉)。状态不够格时网关回 409 + errors,原样弹出来。
   */
  const activeMut = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => (on ? api.activateStrategy(id) : api.deactivateStrategy(id)),
    onSuccess: (res, vars) => {
      toast.success(vars.on ? t('{name} 进票池了', { name: res.strategy.name }) : t('{name} 已停用', { name: res.strategy.name }));
      void refresh();
    },
    onError: failed,
  });

  const promoteMut = useMutation({
    mutationFn: ({ id, to, confirm }: { id: string; to: StrategyStatus; confirm: boolean }) => api.promoteStrategy(id, to, confirm),
    onSuccess: (res) => {
      toast.success(t('{name} 晋升到「{status}」了', { name: res.strategy.name, status: res.strategy.status_label }));
      setPromoteTarget(null);
      void refresh();
    },
    onError: failed,
  });

  const retireMut = useMutation({
    mutationFn: (id: string) => api.retireStrategy(id),
    onSuccess: (res) => {
      toast.success(t('{name} 已退役', { name: res.strategy.name }));
      setRetireTarget(null);
      void refresh();
    },
    onError: failed,
  });

  const adoptMut = useMutation({
    mutationFn: ({ strategyId, attributionId }: { strategyId: string; attributionId: string }) =>
      api.proposeStrategyVersion(strategyId, { attribution_id: attributionId }),
    onSuccess: (res) => {
      toast.success(t('新版本 v{n} 生成好了(草稿);要上线,还得一格一格晋升', { n: res.strategy.version }));
      void refresh();
    },
    onError: failed,
    onSettled: () => setAdoptingId(null),
  });

  const toggleActive = (s: StrategyView, next: boolean) => activeMut.mutate({ id: s.id, on: next });

  const adopt = (point: AttributionPoint) => {
    if (!point.strategy_id) {
      toast.error(t('这条归因没指向具体策略,生成不了新版本'));
      return;
    }
    setAdoptingId(point.id);
    adoptMut.mutate({ strategyId: point.strategy_id, attributionId: point.id });
  };

  const promoteToLive = promoteTarget?.next_status === 'live_capped';

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 工具条 */}
      <Workspace className="shrink-0">
        <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
          <span className="text-[11px] text-muted-foreground">
            {t('实盘启用')} <span className="num font-semibold text-foreground">{active.length}</span> {t('条')}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t('共')} <span className="num font-semibold text-foreground">{shown.length}</span> {t('条')}
          </span>
          <div className="flex items-center gap-1.5">
            <Switch id="strategies-retired" size="sm" checked={includeRetired} onCheckedChange={setIncludeRetired} />
            <label htmlFor="strategies-retired" className="text-[11px] text-muted-foreground">
              {t('显示已退役({n})', { n: retiredCount })}
            </label>
          </div>
          <span className="ml-auto text-[10.5px] leading-relaxed text-muted-foreground">
            {t('参数不能就地改:改一个数字 = 生成一个草稿新版本,再 draft → backtest → shadow → paper → live_capped 一格一格晋升。')}
          </span>
        </div>
        {/* §9.25 补正三 + §9.35:票池 = active_strategies 全集(雷达候选只做优先,不替换票池);
            手动 / 自动轮换、回滚、每条「为什么在 / 不在票池」全在 AllocatorCard 里。 */}
        <AllocatorCard all={all} active={active} />
      </Workspace>

      {/* 卡片列表 */}
      <Workspace className="flex min-h-0 flex-1 flex-col">
        <Pane
          title={t('实盘部署台')}
          hint={listQ.isFetching ? t('刷新中…') : t('{n} 条', { n: shown.length })}
          contentClassName="flex min-h-0 flex-col"
        >
          {listQ.isLoading ? <div className="p-3 text-[11px] text-muted-foreground">{t('加载中…')}</div> : null}
          {listQ.isError ? (
            <div className="p-3 text-[11px] text-destructive">
              {t('策略库加载失败')}:{listQ.error instanceof Error ? listQ.error.message : t('网关没给数据')}
            </div>
          ) : null}
          {!listQ.isLoading && !listQ.isError && shown.length === 0 ? (
            <div className="p-3 text-[11px] text-muted-foreground">{t('策略库是空的。')}</div>
          ) : null}
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-2.5">
              {grouped.map((g) => (
                <div key={g.tier} className="flex flex-col gap-2">
                  {/* 分层标题栏:每层一行小计(几条、其中几条在票池) */}
                  <div className="flex items-center gap-2 border-b pb-1">
                    <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">
                      {g.label}
                    </Badge>
                    <span className="num text-[10.5px] text-muted-foreground">
                      {t('{n} 条', { n: g.items.length })}
                      {g.active > 0 ? ` · ${t('票池 {n}', { n: g.active })}` : ''}
                    </span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
                    {g.items.map((s) => (
                      <StrategyCard
                        key={s.id}
                        s={s}
                        busy={activeMut.isPending || promoteMut.isPending || retireMut.isPending}
                        onToggleActive={(next) => toggleActive(s, next)}
                        onPromote={() => setPromoteTarget(s)}
                        onRetire={() => setRetireTarget(s)}
                        onOpenDetail={() => setDetailId(s.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </Pane>
      </Workspace>

      <DetailSheet
        id={detailId}
        open={detailId !== null}
        onOpenChange={(open) => setDetailId(open ? detailId : null)}
        onAdopt={adopt}
        adoptingId={adoptingId}
      />

      {/* 晋升确认;到 live_capped 是真钱,必须原样输入 LIVE */}
      <ConfirmDialog
        open={promoteTarget !== null}
        title={promoteTarget ? t('晋升「{name}」', { name: promoteTarget.name }) : t('晋升')}
        summary={t('确认晋升')}
        danger={promoteToLive}
        {...(promoteToLive ? { requireText: 'LIVE' } : {})}
        busy={promoteMut.isPending}
        onCancel={() => setPromoteTarget(null)}
        onConfirm={() => {
          if (!promoteTarget?.next_status) return;
          promoteMut.mutate({ id: promoteTarget.id, to: promoteTarget.next_status, confirm: promoteToLive });
        }}
      >
        <p className="leading-relaxed">
          {promoteTarget
            ? t('把 {name}(v{version})从「{from}」晋升到「{to}」。', {
                name: promoteTarget.name,
                version: promoteTarget.version,
                from: promoteTarget.status_label,
                to: promoteTarget.next_status ? FALLBACK_STATUS_LABEL[promoteTarget.next_status] : '—',
              })
            : ''}
        </p>
        {promoteToLive ? (
          <p className="leading-relaxed text-destructive">{t('限额实盘会用真钱下单。这条策略的纸面成绩,够了吗?')}</p>
        ) : null}
      </ConfirmDialog>

      {/* 退役确认 */}
      <ConfirmDialog
        open={retireTarget !== null}
        title={retireTarget ? t('退役「{name}」', { name: retireTarget.name }) : t('退役')}
        summary={t('确认退役')}
        danger
        busy={retireMut.isPending}
        onCancel={() => setRetireTarget(null)}
        onConfirm={() => {
          if (!retireTarget) return;
          retireMut.mutate(retireTarget.id);
        }}
      >
        <p className="leading-relaxed">
          {t('退役之后这条策略会从实盘启用列表里摘掉,而且晋升不回来了。历史版本和回测记录都还在。')}
        </p>
      </ConfirmDialog>
    </div>
  );
}
