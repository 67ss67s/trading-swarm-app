/**
 * 判断记录页:v1(README.md §2)时间线的移植 + v2(v2-agent-loop.md §7)增量——按 symbol 过滤、
 * 每张卡带「查看线程」跳转。旧版 EpisodeCard/Timeline(见 git history)是纯 CSS 实现,这里用
 * Pane + Badge + Tailwind 重做,交互模型不变:折叠态先看摘要,点开才懒加载 GET /api/episodes/:id。
 *
 * react-query key 约定见 src/App.tsx 顶部注释:这里只用 ['episodes'] / ['episode', id]——
 * App.tsx 的单条 SSE 连接会在 episode.finished 时把新摘要 prepend 进 ['episodes'] 缓存,本页
 * 不用自己再开一条 /api/events 连接。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleQuestionMark, ExternalLink } from 'lucide-react';
import { api } from '@/api/client';
import type {
  CouncilReview,
  Episode,
  EpisodeSummary,
  EntryAdvice,
  EntryTiming,
  JudgmentGraph,
  PendingEntryView,
  StrategyCouncil,
  VerdictStance,
} from '@/api/types';
import { DECISION_REASON_LABEL, TIER_LABEL } from '@/api/types';
import type { DecisionReasonCode } from '@/api/types';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { askAgent, whyQuestion } from '@/lib/ask-agent';
import {
  ACTION_LABEL,
  INTENT_KIND_LABEL,
  INTENT_STATUS_LABEL,
  STATE_LABEL,
  triggerLabel,
  actionBadgeClass,
  actionLabel,
  directionLabel,
  directionText,
  fmtClock,
  fmtPrice,
  fmtQty,
  relativeTime,
  useNow,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap, listSep } from '@/lib/i18n';
import { st } from '@/lib/server-text-en';
import { friendlyError } from '@/lib/edition';
import { episodeGateReason } from '@/lib/episode-gate';

function distinctSymbols(episodes: EpisodeSummary[]): string[] {
  const set = new Set<string>();
  for (const e of episodes) if (e.symbol) set.add(e.symbol);
  return Array.from(set).sort();
}

/** 09-25 ③-12:带上线程 id,交易页据此选中这条线程(以前只跳 #trade,看不到是哪笔) */
function goToTradePage(threadId?: string | null) {
  window.location.hash = threadId ? `trade?thread=${encodeURIComponent(threadId)}` : 'trade';
}

/** episode.graph.edge(边 id,如 "scan.PROPOSE")在判断图里对应的边定义,取不到就是 null。 */
function resolveEdge(graph: JudgmentGraph | null | undefined, edgeId: string | null) {
  if (!graph || !edgeId) return null;
  return graph.model_edges.find((e) => e.id === edgeId) ?? null;
}

/** 把一组闸 id 翻译成中文闸名(/api/graph 的 guards[id].gate_name),查不到就原样返回 id。 */
function guardNames(graph: JudgmentGraph | null | undefined, guardIds: string[]): string[] {
  if (!graph) return guardIds;
  return guardIds.map((id) => graph.guards[id]?.gate_name ?? id);
}

/** 卡片头部的判断图小徽章:节点 → 动作;越权(edge=null 但 illegal_action 非空)则红色提示。 */
function GraphBadge({ graph, episodeGraph }: { graph: JudgmentGraph | null | undefined; episodeGraph: NonNullable<Episode['graph']> }) {
  const edge = resolveEdge(graph, episodeGraph.edge);
  if (!episodeGraph.edge && episodeGraph.illegal_action) {
    return (
      <Badge variant="destructive" className="text-[10.5px]" title={t('节点 {node} 不允许 {action}', { node: episodeGraph.node, action: episodeGraph.illegal_action })}>
        {t('越权动作')} {ACTION_LABEL[episodeGraph.illegal_action as keyof typeof ACTION_LABEL] ?? episodeGraph.illegal_action}
      </Badge>
    );
  }
  const actionText = edge ? (ACTION_LABEL[edge.action] ?? edge.action) : (episodeGraph.edge ?? '—');
  return (
    <Badge variant="outline" className="num text-[10.5px]" title={edge?.description}>
      {episodeGraph.node} → {actionText}
    </Badge>
  );
}

/**
 * 展开态的闸列表。优先用 episode 自己 graph.guards(非空 = 真评估过,PROPOSE 会填满,
 * 复查只有 thread_still_open),按 gate_name 去 episode.gates 里找对应的通过/拒绝结果;
 * graph.guards 为空(NO_TRADE/WATCH 没有走到过闸这步)时退回该边在判断图里声明的闸列表,
 * 标注"本次未评估"。
 */
function GuardsList({
  graph,
  episodeGraph,
  gates,
}: {
  graph: JudgmentGraph | null | undefined;
  episodeGraph: NonNullable<Episode['graph']>;
  gates: Episode['gates'];
}) {
  const evaluated = episodeGraph.guards.length > 0;
  const guardIds = evaluated ? episodeGraph.guards : (resolveEdge(graph, episodeGraph.edge)?.guards ?? []);
  if (guardIds.length === 0) return null;

  return (
    <div className="mb-1.5 flex flex-col gap-1">
      <div className="text-[10.5px] text-muted-foreground">{evaluated ? t('闸') : t('这条边声明的闸(这次没评估)')}</div>
      <ul className="flex flex-wrap gap-1">
        {guardIds.map((id, i) => {
          const gateName = graph?.guards[id]?.gate_name ?? id;
          if (!evaluated) {
            return (
              <li key={`${id}-${i}`}>
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {gateName}
                </Badge>
              </li>
            );
          }
          const matches = gates.filter((g) => g.name === gateName);
          const passed = matches.length > 0 ? matches.every((m) => m.passed) : null;
          const reason = matches.map((m) => m.reason).filter(Boolean).join('; ');
          return (
            <li key={`${id}-${i}`}>
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px]',
                  passed === true && 'border-up/30 text-up',
                  passed === false && 'border-destructive/30 text-destructive',
                )}
                title={reason || undefined}
              >
                {passed === true ? '✓' : passed === false ? '✗' : '?'} {gateName}
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 顶部可折叠的「判断图」区块:节点表 + 边表,纯表格渲染,不引入 mermaid。 */
function GraphOverview({ graph }: { graph: JudgmentGraph }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t('节点')}</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-7 text-[11px]">{t('节点')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('允许动作')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('说明')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(graph.nodes).map(([id, n]) => (
              <TableRow key={id}>
                <TableCell className="num py-1.5 text-[11.5px] font-medium">{id}</TableCell>
                <TableCell className="py-1.5 text-[11.5px] text-muted-foreground">
                  {n.allowed_actions.map((a) => ACTION_LABEL[a] ?? a).join(listSep()) || '—'}
                </TableCell>
                <TableCell className="py-1.5 text-[11.5px] text-muted-foreground">{n.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t('边(模型动作)')}</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-7 text-[11px]">{t('从')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('动作')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('效果')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('闸数')}</TableHead>
              <TableHead className="h-7 text-[11px]">{t('说明')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {graph.model_edges.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="num py-1.5 text-[11.5px]">{e.from}</TableCell>
                <TableCell className="py-1.5 text-[11.5px] font-medium">{ACTION_LABEL[e.action] ?? e.action}</TableCell>
                <TableCell className="num py-1.5 text-[11.5px] text-muted-foreground">{e.effect}</TableCell>
                <TableCell className="num py-1.5 text-[11.5px] text-muted-foreground" title={guardNames(graph, e.guards).join(listSep())}>
                  {e.guards.length}
                </TableCell>
                <TableCell className="py-1.5 text-[11.5px] text-muted-foreground">{e.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §9.25 补正三 / §9.25b:策略议会票面
//
// 两个含义刻意分开渲染,别混:
//   `gate_effective=false` = 这条闸这次**根本没生效**(能投票的策略撑不起门槛)→ 红标;
//   `reached=false` 而闸有效 = 正常的「没达成共识」。
// `required` 显示网关给的那个数(09-12 起就是用户设的 council_min_agree 原样,不再钳降)。

const STANCE_LABEL: Record<VerdictStance, string> = tmap({ long: '做多', short: '做空', neutral: '中立', abstain: '弃权' });

function stanceClass(stance: VerdictStance): string {
  if (stance === 'long') return 'border-up/30 bg-up/15 text-up';
  if (stance === 'short') return 'border-down/30 bg-down/15 text-down';
  if (stance === 'abstain') return 'border-transparent bg-muted text-muted-foreground';
  return 'border-muted-foreground/30 bg-transparent text-muted-foreground';
}

const TIMING_LABEL: Record<EntryTiming, string> = tmap({ confirmed: '时机已确认', pending: '等回踩', failed: '时机不成立' });

function timingClass(timing: EntryTiming): string {
  if (timing === 'confirmed') return 'border-up/30 text-up';
  if (timing === 'pending') return 'border-warn/30 text-warn';
  return 'border-muted-foreground/30 text-muted-foreground';
}

/** 契约里 fit.score 与 fit.parts 四个都可为 null:一律「—」,不 toFixed。 */
function fmtScore(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(2);
}

/** 列表摘要上的一枚小徽章:闸无效优先于「无共识」。 */
function CouncilSummaryBadge({ council }: { council: NonNullable<EpisodeSummary['council']> }) {
  if (!council.gate_effective) {
    return (
      <Badge variant="outline" className="border-destructive/40 text-[10.5px] text-destructive" title={t('能投票的策略撑不起门槛,这条闸这次没生效')}>
        {t('共识闸无效')}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn('num text-[10.5px]', council.reached ? 'border-up/30 text-up' : 'text-muted-foreground')}
      title={t('同意 {a} / 门槛 {r} · 弃权 {b}', { a: council.agreeing, r: council.required, b: council.abstaining })}
    >
      {council.reached ? t('共识') : t('无共识')} {council.agreeing}/{council.required}
      {council.direction ? ` · ${directionLabel(council.direction)}` : ''}
      {council.entry_timing === 'pending' ? ` · ${t('等回踩')}` : ''}
    </Badge>
  );
}

/** 展开态的完整票面:共识一行 + 每票一行(影子票灰显,不计共识)。 */
function CouncilBlock({ council, review }: { council: StrategyCouncil; review: CouncilReview | null | undefined }) {
  const c = council.consensus;
  return (
    <div className="flex flex-col gap-2">
      {/* 共识行 */}
      <div className="flex flex-col gap-1 rounded-sm border px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium">{t('共识')}</span>
          <Badge variant="outline" className="text-[10.5px] text-muted-foreground">
            {t('模式')} {council.mode}
          </Badge>
          {c.gate_effective ? (
            <Badge variant="outline" className={cn('num text-[10.5px]', c.reached ? 'border-up/30 text-up' : 'text-muted-foreground')}>
              {c.reached ? t('已达成') : t('没达成')} {c.agreeing.length}/{c.required}
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-[10.5px]">
              {t('共识闸当前无效')}
            </Badge>
          )}
          {c.direction ? <span className={cn('text-[11px]', directionText(c.direction))}>{directionLabel(c.direction)}</span> : null}
          {c.entry_timing ? (
            <Badge variant="outline" className={cn('text-[10.5px]', timingClass(c.entry_timing))}>
              {TIMING_LABEL[c.entry_timing]}
            </Badge>
          ) : null}
          <span className="num ml-auto text-[10px] text-muted-foreground">
            {t('能投票 {n} 条', { n: c.voting.length })}
          </span>
        </div>
        {!c.gate_effective ? (
          <p className="text-[11px] leading-relaxed text-destructive">
            {t('共识闸当前无效')}:{c.gate_reason || c.reason || t('能投票的策略撑不起门槛')}
          </p>
        ) : c.reason ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">{c.reason}</p>
        ) : null}
        {c.entry_timing === 'pending' ? (
          <p className="text-[11px] leading-relaxed text-warn">
            {t('方向成立但回踩没确认:这次只许限价挂回踩区,市价开仓会被「策略共识」闸拒。')}
          </p>
        ) : null}
      </div>

      {/* 每条策略一票 */}
      {council.verdicts.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t('这次没有任何策略被唤醒。')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {council.verdicts.map((v) => {
            const advisory = v.advisory === true;
            const failedChecks = v.checks.filter((chk) => chk.pass === false);
            const unknownChecks = v.checks.filter((chk) => chk.pass === null);
            return (
              <li key={`${v.strategy_id}-${v.version}`} className={cn('flex flex-col gap-0.5 rounded-sm border px-2 py-1.5', advisory && 'opacity-60')}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="num text-[11.5px] font-medium">{v.strategy_id}</span>
                  <span className="num text-[10px] text-muted-foreground">v{v.version}</span>
                  <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', stanceClass(v.stance))}>
                    {STANCE_LABEL[v.stance]}
                  </Badge>
                  <span className="num text-[10.5px] text-muted-foreground">{t('信心')} {fmtScore(v.confidence)}</span>
                  {v.entry_timing ? (
                    <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', timingClass(v.entry_timing))}>
                      {TIMING_LABEL[v.entry_timing]}
                    </Badge>
                  ) : null}
                  {advisory ? (
                    <Badge variant="outline" className="h-4 border-transparent bg-muted px-1.5 text-[10px] text-muted-foreground" title={t('影子实盘票:只表态,不计共识')}>
                      {t('影子票')}
                    </Badge>
                  ) : null}
                  <span className="num ml-auto text-[10px] text-muted-foreground" title={v.fit.note}>
                    {t('适配')} {fmtScore(v.fit.score)}
                    <span className="ml-1 text-muted-foreground/70">
                      (lab {fmtScore(v.fit.parts.lab)} · eval {fmtScore(v.fit.parts.eval)} · radar {fmtScore(v.fit.parts.radar)} · hist {fmtScore(v.fit.parts.history)})
                    </span>
                  </span>
                </div>
                {v.stance === 'abstain' ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t('弃权原因')}:{v.reasons.length ? v.reasons.join(';') : t('没给原因')}
                    <span className="ml-1">{t('(弃权不是反对,不计票)')}</span>
                  </p>
                ) : v.reasons.length ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{v.reasons.join(';')}</p>
                ) : null}
                {failedChecks.length || unknownChecks.length ? (
                  <div className="flex flex-wrap gap-1">
                    {failedChecks.map((chk) => (
                      <Badge key={`f-${chk.id}`} variant="outline" className="h-4 border-destructive/30 px-1.5 text-[10px] text-destructive" title={chk.note}>
                        ✗ {chk.id}
                      </Badge>
                    ))}
                    {unknownChecks.map((chk) => (
                      <Badge key={`u-${chk.id}`} variant="outline" className="h-4 px-1.5 text-[10px] text-muted-foreground" title={chk.note}>
                        ? {chk.id}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {review ? (
        <div className="rounded-sm border px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">{t('复核')}</span>:{review.text || t('没有复核文字')}
          <div className="num mt-0.5">
            {t('仍同意')} {review.still_agree.length} · {t('翻向')} {review.flipped.length} · {t('转中立')} {review.gone_neutral.length}
          </div>
        </div>
      ) : null}

      {council.text ? <p className="text-[10.5px] leading-relaxed text-muted-foreground">{council.text}</p> : null}
    </div>
  );
}

/** §9.26:入场方式建议 + 挂单耐心。两块都可能为 null(复查 / 非限价单)。 */
function EntryBlock({ advice, pending }: { advice: EntryAdvice | null | undefined; pending: PendingEntryView | null | undefined }) {
  if (!advice && !pending) return null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      {advice ? (
        <div className="flex flex-col gap-0.5 rounded-sm border px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium">{t('入场方式')}</span>
            <Badge variant="outline" className={cn('text-[10.5px]', advice.recommended === 'limit' ? 'border-warn/30 text-warn' : 'border-up/30 text-up')}>
              {advice.recommended === 'limit' ? t('限价') : t('市价')}
            </Badge>
            {advice.market_blocked ? (
              <Badge variant="outline" className="border-destructive/30 text-[10.5px] text-destructive">
                {t('市价已被闸挡')}
              </Badge>
            ) : null}
            <span className="num text-[10.5px] text-muted-foreground">
              {t('参考挂单区')} {advice.zone ? `${advice.zone[0]}–${advice.zone[1]}` : '—'}
            </span>
            <span className="num text-[10.5px] text-muted-foreground">
              {t('距突破位')} {advice.dist_to_break_atr === null ? '—' : `${advice.dist_to_break_atr.toFixed(2)} ATR`}
            </span>
          </div>
          {advice.reason ? <p className="text-[11px] leading-relaxed text-muted-foreground">{advice.reason}</p> : null}
        </div>
      ) : null}
      {pending ? (
        <div className="flex flex-col gap-0.5 rounded-sm border px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium">{t('挂单耐心')}</span>
            <span className="num text-[10.5px] text-muted-foreground">
              {t('已等 {b}/{m} 根', { b: pending.bars_waited, m: pending.max_wait_bars })} · {t('{n} 分钟', { n: pending.minutes_waited })}
            </span>
            <Badge variant="outline" className={cn('text-[10.5px]', pending.in_zone ? 'border-up/30 text-up' : 'text-muted-foreground')}>
              {pending.in_zone ? t('在挂单区') : t('不在挂单区')}
            </Badge>
            {pending.cancel_warranted ? (
              <Badge variant="outline" className="border-warn/30 text-[10.5px] text-warn">
                {t('建议撤单')}
              </Badge>
            ) : null}
          </div>
          {pending.text ? <p className="text-[11px] leading-relaxed text-muted-foreground">{pending.text}</p> : null}
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {t('撤单请求成功不等于这单没成交(撤后还没回查成交量);撤单也不退当日开仓计数。')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

type Section = 'evidence' | 'decision' | 'council' | 'context' | 'raw';

/**
 * §9.34 减黑盒:证据的**来源种类**。这是 `Evidence.kind`(网关 context.ts 里 add() 的第一个参数),
 * 认不出来的原样显示 —— 新增一种来源时前端不该把它吞掉。
 */
const EVIDENCE_KIND_LABEL: Record<string, string> = tmap({
  market: '行情',
  indicator: '指标',
  checklist: '清单',
  council: '议会',
  regime: '日线状态',
  calendar: '日历',
  trigger: '触发',
  memory: '记忆',
  info: '信息员',
  event: '事件',
  plan: '计划',
  position: '持仓',
});

/** 装载明细里的一行属于哪条路;`research` 目前只有事件简报。 */
const PLAN_KIND_LABEL: Record<string, string> = tmap({
  indicator: '指标',
  event: '事件',
  news: '新闻',
  research: '研究',
  checklist: '清单',
});

function EvidenceList({ episode, now }: { episode: Episode; now: number }) {
  if (episode.evidence.length === 0) {
    return <p className="px-1 py-1 text-[11px] text-muted-foreground">{t('没有登记证据')}</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {episode.evidence.map((ev) => (
        <li
          key={ev.ref}
          className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px]', ev.stale && 'opacity-60')}
        >
          {/* §9.34:每条证据先说清「它是哪一路来的」 */}
          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px] text-muted-foreground">
            {EVIDENCE_KIND_LABEL[ev.kind] ?? ev.kind}
          </Badge>
          <span className="font-medium text-foreground">{ev.label}</span>
          <span className="num text-muted-foreground">{ev.value}</span>
          <span className="text-[10.5px] text-muted-foreground">
            {relativeTime(ev.observed_at, now)} · {ev.source}
          </span>
          {/* §9.34:谁点名要的这条证据。空 = 公共证据(行情/结构/记忆),不是「没人用」。 */}
          {ev.required_by && ev.required_by.length > 0 ? (
            <span className="num text-[10px] text-primary">
              {t('因')} {ev.required_by.join(' / ')} {t('而装')}
            </span>
          ) : null}
          {ev.stale ? (
            <Badge variant="outline" className="border-warn/30 text-[10px] text-warn">
              {t('过期')}
            </Badge>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * §9.34「模型这次看到了什么」的计划面:要了什么、装上了几条、**要了没装上**的那几条和原因。
 * 数据走 `GET /api/judgments/:id`(只读,不重算);老 episode 没有计划快照就照实说。
 */
/**
 * §9.37 减黑盒:一次判断的三栏决策记录 —— **代码允许 →|模型选 →|闸后执行**。
 * 后端只发 reason code(枚举),中文在 DECISION_REASON_LABEL 里;认不出的 code 原样显示,
 * 不把网关新增的枚举值静默吞掉。
 */
function DecisionRecordBlock({ episodeId }: { episodeId: string }) {
  const q = useQuery({ queryKey: ['judgment', episodeId], queryFn: () => api.judgmentDetail(episodeId), retry: 0, staleTime: 5 * 60_000 });
  const dr = q.data?.decision_record ?? null;
  if (q.isLoading) return <p className="text-[10.5px] text-muted-foreground">{t('决策记录加载中…')}</p>;
  if (q.isError || !dr) return <p className="text-[10.5px] text-muted-foreground">{t('这次判断早于决策记录(它是 09-12 之后才开始记的)。')}</p>;

  const codeLabel = (c: string): string => DECISION_REASON_LABEL[c as DecisionReasonCode] ?? c;
  const Codes = ({ codes, tone }: { codes: string[]; tone?: string }) => (
    <div className="flex flex-wrap gap-1">
      {codes.map((c) => (
        <Badge key={c} variant="outline" className={cn('h-4 px-1 text-[10px]', tone)} title={c}>
          {codeLabel(c)}
        </Badge>
      ))}
    </div>
  );

  // 三栏之间不一致的地方就是「黑盒在哪里」的答案,标出来。
  const modelIllegal = dr.model.illegal_action !== null;
  const gateOverruled = dr.model.action !== null && !dr.executed.passed;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[10.5px] text-muted-foreground">
        <span className="text-[11px] font-semibold text-foreground">{t('决策记录')}</span>
        <span className="num">{dr.version}</span>
        {dr.tier ? <Badge variant="outline" className="h-4 px-1 text-[10px]">{t(TIER_LABEL[dr.tier])}</Badge> : null}
        {dr.strategy_version_hash ? <span className="num">{t('策略版本')} {dr.strategy_version_hash.slice(0, 8)}</span> : null}
        {dr.evidence_plan_hash ? <span className="num">{t('证据计划')} {dr.evidence_plan_hash.slice(0, 8)}</span> : null}
      </div>

      <div className="grid gap-1.5 sm:grid-cols-3">
        {/* 一:代码允许 */}
        <div className="flex flex-col gap-1 rounded-sm border px-2 py-1.5">
          <div className="text-[11px] font-semibold">{t('① 代码允许')}</div>
          <div className="text-[10.5px] text-muted-foreground">
            {t('入场方式')}:<span className="num">{dr.allowed.entry_styles.join(' / ') || t('无')}</span>
          </div>
          <div className="text-[10.5px] text-muted-foreground">
            {dr.allowed.council
              ? t('议会:{a}/{b} 票{dir},{ok}', {
                  a: dr.allowed.council.agreeing,
                  b: dr.allowed.council.required,
                  dir: dr.allowed.council.direction ? ` ${dr.allowed.council.direction === 'long' ? t('做多') : t('做空')}` : '',
                  ok: dr.allowed.council.reached ? t('有共识') : t('无共识'),
                })
              : t('议会未参与')}
          </div>
          <div className="num text-[10.5px] text-muted-foreground">
            {dr.allowed.strategies.length ? dr.allowed.strategies.map((x) => `${x.id} v${x.version}`).join(' · ') : t('没有生效策略')}
          </div>
          <Codes codes={dr.allowed.codes} />
        </div>

        {/* 二:模型选 */}
        <div className={cn('flex flex-col gap-1 rounded-sm border px-2 py-1.5', modelIllegal && 'border-warn/60 bg-warn/5')}>
          <div className="text-[11px] font-semibold">{t('② 模型选')}</div>
          <div className="text-[10.5px] text-muted-foreground">
            <span className="num font-semibold text-foreground">{dr.model.action ?? t('无输出')}</span>
            {dr.model.direction ? ` · ${dr.model.direction === 'long' ? t('做多') : t('做空')}` : ''}
            {dr.model.entry ? ` · ${dr.model.entry === 'market' ? t('市价') : t('限价')}` : ''}
            {dr.model.confidence !== null ? ` · ${t('信心')} ${dr.model.confidence.toFixed(2)}` : ''}
          </div>
          {modelIllegal ? (
            <div className="text-[10.5px] text-warn">{t('第一次输出的是允许集外的「{a}」,已修复', { a: dr.model.illegal_action! })}</div>
          ) : null}
          <Codes codes={dr.model.codes} tone={modelIllegal ? 'border-warn/60 text-warn' : undefined} />
        </div>

        {/* 三:闸后执行 */}
        <div className={cn('flex flex-col gap-1 rounded-sm border px-2 py-1.5', gateOverruled && 'border-destructive/50 bg-destructive/5')}>
          <div className="text-[11px] font-semibold">{t('③ 闸后执行')}</div>
          <div className="text-[10.5px] text-muted-foreground">
            <span className="num font-semibold text-foreground">{dr.executed.action ?? t('没有执行')}</span>
            {dr.executed.intent_id ? <span className="num"> · {dr.executed.intent_id}</span> : null}
          </div>
          {dr.executed.blocked_by.length ? (
            <div className="text-[10.5px] text-destructive">{t('被这几道闸拒绝')}:{dr.executed.blocked_by.join(listSep())}</div>
          ) : null}
          <Codes codes={dr.executed.codes} tone={gateOverruled ? 'border-destructive/50 text-destructive' : undefined} />
        </div>
      </div>
    </div>
  );
}

function EvidencePlanBlock({ episodeId }: { episodeId: string }) {
  const q = useQuery({ queryKey: ['judgment', episodeId], queryFn: () => api.judgmentDetail(episodeId), retry: 0, staleTime: 5 * 60_000 });
  const plan = q.data?.evidence_plan ?? null;
  if (q.isLoading) return <p className="mb-1.5 text-[10.5px] text-muted-foreground">{t('证据计划加载中…')}</p>;
  if (q.isError || !plan) {
    return <p className="mb-1.5 text-[10.5px] text-muted-foreground">{t('这次判断没有证据计划快照(它是 09-12 之后才开始记的)。')}</p>;
  }
  const missing = plan.items.filter((i) => !i.included);
  return (
    <div className="mb-2 flex flex-col gap-1 rounded-sm border px-2 py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[11px] font-semibold">{t('证据计划')}</span>
        <span className="num text-[10px] text-muted-foreground">{plan.hash.slice(0, 8)}</span>
        <span className="text-[10.5px] text-muted-foreground">
          {t('指标 {a}/{b}', { a: plan.counts.included_indicators, b: plan.counts.requested_indicators })} · {t('清单 {n}', { n: plan.counts.checklist })} ·{' '}
          {t('事件 {n}', { n: plan.counts.events })} · {t('新闻 {n}', { n: plan.counts.news })} · {t('研究 {n}', { n: plan.counts.research })}
        </span>
      </div>
      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
        {plan.strategies.length ? t('按这几条启用策略的证据并集装:{ids}', { ids: plan.strategies.join(' / ') }) : t('这次判断没有启用策略,装的是公共证据。')}
        {plan.requested.info_topics.length ? ` · ${t('新闻主题')} ${plan.requested.info_topics.join(' / ')}` : ''}
      </div>
      {missing.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {missing.map((i) => (
            <li key={`${i.kind}-${i.key}`} className="flex flex-wrap items-baseline gap-x-1.5 text-[10.5px] text-warn">
              <Badge variant="outline" className="h-4 px-1 text-[10px]">
                {PLAN_KIND_LABEL[i.kind] ?? i.kind}
              </Badge>
              <span className="num">{i.key}</span>
              <span>{t('要了没装上')}:{i.note ?? t('原因未记')}</span>
              {i.required_by.length ? <span className="num text-muted-foreground">({i.required_by.join(' / ')})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EpisodeCard({ summary, now, graph }: { summary: EpisodeSummary; now: number; graph: JudgmentGraph | null | undefined }) {
  const [detail, setDetail] = useState<Episode | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [openSection, setOpenSection] = useState<Section | null>(null);

  const ensureDetail = () => {
    if (detail || detailLoading) return;
    setDetailLoading(true);
    setDetailError(null);
    api
      .episode(summary.id)
      .then(setDetail)
      .catch((err: unknown) => setDetailError(err instanceof Error ? err.message : String(err)))
      .finally(() => setDetailLoading(false));
  };

  const toggleSection = (section: Section) => {
    setOpenSection((cur) => (cur === section ? null : section));
    ensureDetail();
  };

  const badgeLabel = summary.action ? actionLabel(summary.action, summary.direction) : t('判断失败');
  const badgeCls = summary.action ? actionBadgeClass(summary.action, summary.direction) : 'bg-muted text-muted-foreground border-transparent';
  const stateChanged = summary.from_state !== summary.to_state;
  // 闸门拒绝(净 RR 不够 / 持仓计划建不起来…)是正常结果:显示成中性的「没下单 — 原因」,真正的异常才标出错
  const gateReason = episodeGateReason(summary);
  const intent = summary.intent;
  const confidencePct = summary.confidence !== null ? Math.round(summary.confidence * 100) : null;
  // 折叠态就有 summary.graph(后端已补齐);展开后 detail.graph 是同一份数据,兜底优先用 summary。
  const episodeGraph = summary.graph ?? detail?.graph ?? null;

  return (
    <article className="rounded-md border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="num text-[11px] text-muted-foreground">
          {fmtClock(summary.at)} <span className="text-muted-foreground/70">· {relativeTime(summary.at, now)}</span>
        </span>
        <Badge variant="outline" className="text-[11px] font-normal" title={st(summary.trigger.detail)}>
          {triggerLabel(summary.trigger.kind)}
        </Badge>
        <Badge variant="outline" className={cn('text-[11px]', badgeCls)}>
          {badgeLabel}
        </Badge>
        <span className="text-[11px] text-muted-foreground">{summary.symbol}</span>
        {episodeGraph ? <GraphBadge graph={graph} episodeGraph={episodeGraph} /> : null}
        {/* §9.26 列表摘要:议会与入场方式不用点开就能看到 */}
        {summary.council ? <CouncilSummaryBadge council={summary.council} /> : null}
        {summary.entry ? (
          <Badge
            variant="outline"
            className={cn('text-[10.5px]', summary.entry.market_blocked ? 'border-warn/30 text-warn' : 'text-muted-foreground')}
            title={summary.entry.market_blocked ? t('距突破位超过 1 ATR,市价开仓会被「入场方式」闸拒') : undefined}
          >
            {summary.entry.recommended === 'limit' ? t('限价入场') : t('市价入场')}
          </Badge>
        ) : null}
        {confidencePct !== null ? (
          <span className="flex items-center gap-1.5" title={t('置信度 {n}%', { n: confidencePct })}>
            <span className="h-1 w-14 overflow-hidden rounded-full bg-muted">
              <span className="block h-full bg-primary" style={{ width: `${confidencePct}%` }} />
            </span>
            <span className="num text-[10.5px] text-muted-foreground">{confidencePct}%</span>
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => askAgent(whyQuestion({ symbol: summary.symbol, at: summary.at, action: summary.action ? actionLabel(summary.action, summary.direction) : null, episodeId: summary.id }))}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary hover:underline"
            title={t('跳到 Agent 页,把问题预填进对话框')}
          >
            <CircleQuestionMark className="size-3" />
            {t('问 agent 为什么')}
          </button>
          {summary.thread_id ? (
            <button type="button" onClick={() => goToTradePage(summary.thread_id)} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
              {t('查看线程')}
              <ExternalLink className="size-3" />
            </button>
          ) : null}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 px-3 py-2 text-[13px]">
        {summary.headline ? <p className="font-medium">{summary.headline}</p> : null}
        {summary.reasons.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-4 text-[12.5px] text-muted-foreground">
            {summary.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : null}
        {stateChanged ? (
          <p className="text-[11.5px] text-muted-foreground">
            {t('策略')}:{STATE_LABEL[summary.from_state]} → {summary.to_state ? STATE_LABEL[summary.to_state] : '—'}
          </p>
        ) : null}
        {gateReason ? (
          <p className="text-[11.5px] text-muted-foreground" data-testid="episode-not-taken">
            {t('没下单')} — {st(gateReason)}
          </p>
        ) : summary.reducer && !summary.reducer.accepted ? (
          <p className="text-[11.5px] text-muted-foreground">{t('这次判断没改变策略状态')}:{st(summary.reducer.reason)}</p>
        ) : null}
        {summary.schema_errors.length > 0 ? (
          <p className="text-[11.5px] text-warn">{t('模型输出没过校验,按不交易处理了')}:{summary.schema_errors.join('; ')}</p>
        ) : null}
        {summary.error && !gateReason ? <p className="text-[11.5px] text-warn">{t('出错了')}:{friendlyError(summary.error)}</p> : null}

        {intent ? (
          <div className="num mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm bg-muted/40 px-2 py-1.5 text-[11.5px]">
            <span className={directionText(intent.direction)}>
              {INTENT_KIND_LABEL[intent.kind]} · {directionLabel(intent.direction)}
            </span>
            <span>{t('数量')} {fmtQty(intent.quantity)}</span>
            <span>{t('入场')} {intent.entry === 'market' ? t('市价') : t('限价 {price}', { price: fmtPrice(intent.limit_price) })}</span>
            <span>{t('止损')} {fmtPrice(intent.stop_price)}</span>
            <span>{t('止盈')} {intent.take_profit_price ? fmtPrice(intent.take_profit_price) : '—'}</span>
            <Badge variant="outline" className="text-[10.5px]">
              {INTENT_STATUS_LABEL[intent.status]}
            </Badge>
            {intent.error ? <span className="text-warn">{intent.error}</span> : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1 border-t px-2 py-1.5">
        <Button variant="ghost" size="xs" onClick={() => toggleSection('evidence')} aria-expanded={openSection === 'evidence'}>
          {t('看到了什么')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => toggleSection('decision')} aria-expanded={openSection === 'decision'}>
          {t('决策三栏')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => toggleSection('council')} aria-expanded={openSection === 'council'}>
          {t('策略议会')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => toggleSection('context')} aria-expanded={openSection === 'context'}>
          {t('模型看到的原文')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => toggleSection('raw')} aria-expanded={openSection === 'raw'}>
          {t('原始 JSON')}
        </Button>
      </div>

      {openSection ? (
        <div className="border-t px-3 py-2">
          {detailLoading ? <p className="text-[11px] text-muted-foreground">{t('加载中…')}</p> : null}
          {detailError ? <p className="text-[11px] text-warn">{t('加载失败')}:{detailError}</p> : null}
          {detail && openSection === 'evidence' ? (
            <>
              {detail.graph ? (
                <>
                  <p className="mb-1 text-[10.5px] text-muted-foreground">
                    <span className="num">
                      {t('判断图:节点')} {detail.graph.node}
                      {detail.graph.edge ? ` → ${resolveEdge(graph, detail.graph.edge)?.action ?? detail.graph.edge}` : ''}
                    </span>
                  </p>
                  <GuardsList graph={graph} episodeGraph={detail.graph} gates={detail.gates} />
                </>
              ) : null}
              <EvidencePlanBlock episodeId={detail.id} />
              <EvidenceList episode={detail} now={now} />
            </>
          ) : null}
          {detail && openSection === 'decision' ? <DecisionRecordBlock episodeId={detail.id} /> : null}
          {detail && openSection === 'council' ? (
            detail.strategy_council ? (
              <>
                <CouncilBlock council={detail.strategy_council} review={detail.council_review} />
                <EntryBlock advice={detail.entry_advice} pending={detail.pending_entry} />
              </>
            ) : (
              <>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t('这次判断没有议会票面(议会关着,或者这条记录是议会上线之前的)。')}
                </p>
                <EntryBlock advice={detail.entry_advice} pending={detail.pending_entry} />
              </>
            )
          ) : null}
          {detail && openSection === 'context' ? (
            detail.context_text == null ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t('模型收到的完整上下文在公开演示版里不展示(约 {n} 字符)。', { n: detail.context_text_hidden?.length ?? '—' })}
              </p>
            ) : (
              <pre className="num max-h-80 overflow-auto whitespace-pre-wrap rounded-sm bg-muted/40 p-2 text-[11px] leading-relaxed">
                {detail.context_text}
              </pre>
            )
          ) : null}
          {detail && openSection === 'raw' ? (
            <pre className="num max-h-80 overflow-auto whitespace-pre-wrap rounded-sm bg-muted/40 p-2 text-[11px] leading-relaxed">
              {JSON.stringify(detail.judgment, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function JudgmentsPage() {
  const episodesQ = useQuery({ queryKey: ['episodes'], queryFn: () => api.episodes({ limit: 100 }) });
  const graphQ = useQuery({ queryKey: ['graph'], queryFn: () => api.graph(), staleTime: Infinity });
  const [symbolFilter, setSymbolFilter] = useState<string>('all');
  const [graphOpen, setGraphOpen] = useState(false);
  const now = useNow();

  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, staleTime: 5_000 });
  const episodes = episodesQ.data ?? [];
  // 可交易资产 = workflow.watchlist(唯一真源,和交易页观察列表 / 盯盘参数抽屉是同一份);历史 episode 里有、现在不在观察的币归「其它」
  const watchlist = overviewQ.data?.workflow.watchlist ?? [];
  const watchOnly = new Set(overviewQ.data?.workflow.watch_only ?? []);
  const historical = distinctSymbols(episodes).filter((s) => !watchlist.includes(s));
  const visible = symbolFilter === 'all' ? episodes : episodes.filter((e) => e.symbol === symbolFilter);
  const graph = graphQ.data?.graph ?? null;

  return (
    <Workspace className="flex h-full min-h-0 flex-col">
      <Pane title={t('判断记录')} hint={episodesQ.isLoading ? undefined : t('共 {n} 条', { n: visible.length })} contentClassName="flex min-h-0 flex-col">
        <div className="shrink-0 border-b">
          <button
            type="button"
            onClick={() => setGraphOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
            aria-expanded={graphOpen}
          >
            {graphOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t('判断图')}{graph ? <span className="text-[10.5px] text-muted-foreground/70">· {graph.version}</span> : null}
          </button>
          {graphOpen ? (
            graph ? (
              <div className="max-h-72 overflow-auto border-t">
                <GraphOverview graph={graph} />
              </div>
            ) : (
              <p className="px-3 pb-2 text-[11px] text-muted-foreground">
                {graphQ.isLoading ? t('加载中…') : graphQ.isError ? t('加载失败') : t('没有数据')}
              </p>
            )
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
          <span className="mr-1 text-[11px] text-muted-foreground">{t('币种')}</span>
          <Button type="button" variant={symbolFilter === 'all' ? 'default' : 'outline'} size="xs" className="rounded-full" onClick={() => setSymbolFilter('all')}>
            {t('全部')}
          </Button>
          {watchlist.map((sym) => (
            <Button key={sym} type="button" variant={symbolFilter === sym ? 'default' : 'outline'} size="xs" className="num rounded-full" onClick={() => setSymbolFilter(sym)} title={watchOnly.has(sym) ? t('只观察不交易:判断只能出 NO_TRADE / WATCH') : t('可交易')}>
              {sym}
              {watchOnly.has(sym) ? <span className="ml-1 text-[9px] text-muted-foreground">{t('观')}</span> : null}
            </Button>
          ))}
          <a href="#agent" className="text-[10.5px] text-muted-foreground hover:text-foreground hover:underline" title={t('观察列表就是 agent 能交易的币,在「盯盘参数」页里改')}>
            {t('改观察列表 →')}
          </a>
          {historical.length ? (
            <>
              <span className="ml-2 text-[11px] text-muted-foreground/70">{t('其它(历史)')}</span>
              {historical.map((sym) => (
                <Button key={sym} type="button" variant={symbolFilter === sym ? 'secondary' : 'ghost'} size="xs" className="num rounded-full text-muted-foreground" onClick={() => setSymbolFilter(sym)}>
                  {sym}
                </Button>
              ))}
            </>
          ) : null}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-3">
            {episodesQ.isLoading ? (
              <>
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-28 w-full" />
              </>
            ) : null}
            {episodesQ.isError ? (
              <p className="py-6 text-center text-[12px] text-destructive">
                {t('加载失败')}:{episodesQ.error instanceof Error ? episodesQ.error.message : String(episodesQ.error)}
              </p>
            ) : null}
            {!episodesQ.isLoading && !episodesQ.isError && visible.length === 0 ? (
              <p className="py-10 text-center text-[12px] text-muted-foreground">{t('还没有判断记录,等下一次触发。')}</p>
            ) : null}
            {visible.map((ep) => (
              <EpisodeCard key={ep.id} summary={ep} now={now} graph={graph} />
            ))}
          </div>
        </ScrollArea>
      </Pane>
    </Workspace>
  );
}
