/**
 * 复盘页「候选和策略」(docs/design/watch-screener-review-2026-09-24.md 二-4):
 *   - 影子候选 candidate-v0 的结算情况(GET /api/candidates/summary + /api/candidates):研究策略按 IR 在线出的候选,
 *     零模型按计划腿(止损 / 目标 / 48 根)和吊灯腿各走一遍 R;与同时段模型判断配对;
 *   - 策略 id 链到「我的策略」(#my-strategies?id=<rs_…>);内置策略名经 lab_strategy_id 反查,反查不到就不链(不猜);
 *   - 判断账本里出现过的策略名也列出来,看哪些对得上策略对象。
 * 样本 < 30 标「观察」;期望旁给中位数 / 截尾均值(从候选逐行算,口径同 gateway analyzer.centerStats)。
 * react-query key:['candidates','summary'] / ['candidates','list'] / ['history','strategy-index'] / ['judgment-ledger','summary-v2',null]。
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { ledgerV2Api, type CandidateGroupStats, type CandidateRow, type PairBucket, type StrategyIndexItem } from '@/api/ledger-v2';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtDateTime, fmtPrice } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MeanWithCenter, NoteStrip, ObserveBadge } from './common';
import { pctText, rText, rTone } from './ledger-rows';
import { candidateLegStats, strategyHref, UNNAMED_STRATEGY } from './ledger-stats';

const PAIR_LABEL: Record<PairBucket, string> = tmap({
  propose_same: '模型同向提议',
  propose_opposite: '模型反向提议',
  no_trade: '模型说不做',
  watch: '模型说观望',
  review: '当时在复查持仓',
  no_judgment: '有 episode 没判断',
  no_episode: '模型没被问',
  pending: '配对窗口没关',
});
const PAIR_ORDER: PairBucket[] = ['propose_same', 'propose_opposite', 'no_trade', 'watch', 'review', 'no_judgment', 'no_episode', 'pending'];

const SETTLE_LABEL: Record<string, string> = tmap({ plan_walk: '已走完', invalid: '无效', unscoreable: '算不出' });

function StrategyLink({ id, index }: { id: string; index: readonly StrategyIndexItem[] }) {
  const href = strategyHref(id, index);
  const hit = index.find((s) => s.id === id) ?? index.find((s) => s.lab_strategy_id === id);
  const synth = id.startsWith('synth:');
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="num truncate" title={id}>
        {id}
      </span>
      {href ? (
        <a href={href} className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-primary hover:underline" title={hit ? hit.name : undefined}>
          {t('我的策略')}
          <ExternalLink className="size-2.5" />
        </a>
      ) : (
        <span className="shrink-0 text-[10px] text-muted-foreground" title={synth ? t('研究台没有 ≤1h 的做多版本时,网关用合成 IR 出候选;它不是策略对象') : t('「我的策略」里没有同 id 或同 lab_strategy_id 的策略对象')}>
          {synth ? t('合成 · 无策略对象') : t('无对应策略对象')}
        </span>
      )}
    </span>
  );
}

function Stat({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground select-none">{label}</div>
      <div className="mt-0.5 text-[16px]/6">{children}</div>
      {sub ? <div className="num mt-0.5 text-[10.5px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function GroupCells({ g }: { g: CandidateGroupStats | undefined }) {
  return (
    <>
      <TableCell className="num text-right">{g?.n ?? 0}</TableCell>
      <TableCell className="num text-right">
        <span className="inline-flex items-center gap-1">
          {g?.settled ?? 0}
          {g && g.n > 0 ? <ObserveBadge n={g.settled} unit={t('条')} /> : null}
        </span>
      </TableCell>
      <TableCell className={cn('num text-right', rTone(g?.plan_mean_r))}>{rText(g?.plan_mean_r)}</TableCell>
      <TableCell className={cn('num text-right', rTone(g?.trail_mean_r))}>{rText(g?.trail_mean_r)}</TableCell>
    </>
  );
}

function CandidateList({ rows, index }: { rows: CandidateRow[]; index: readonly StrategyIndexItem[] }) {
  return (
    <Table className="table-dense">
      <TableHeader>
        <TableRow>
          <TableHead>{t('信号时间')}</TableHead>
          <TableHead>{t('币种')}</TableHead>
          <TableHead>{t('策略')}</TableHead>
          <TableHead className="text-right">{t('入场参考')}</TableHead>
          <TableHead className="text-right">{t('止损')}</TableHead>
          <TableHead className="text-right">{t('目标')}</TableHead>
          <TableHead className="text-right">RR</TableHead>
          <TableHead>{t('模型当时')}</TableHead>
          <TableHead>{t('状态')}</TableHead>
          <TableHead className="text-right">{t('计划腿')}</TableHead>
          <TableHead className="text-right">{t('吊灯腿')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((c) => {
          const st = c.settlement;
          return (
            <TableRow key={c.id} title={c.reason}>
              <TableCell className="num whitespace-nowrap">{fmtDateTime(c.as_of)}</TableCell>
              <TableCell className="num font-medium">
                {c.symbol} <span className="text-[10px] text-muted-foreground">{c.timeframe}</span>
                {c.origin !== 'online' ? <span className="ml-1 text-[10px] text-warn">{t('离线回放')}</span> : null}
              </TableCell>
              <TableCell className="max-w-[260px]">
                <StrategyLink id={c.strategy_id} index={index} />
              </TableCell>
              <TableCell className="num text-right">{fmtPrice(c.entry_ref)}</TableCell>
              <TableCell className="num text-right">{fmtPrice(c.stop)}</TableCell>
              <TableCell className="num text-right">{c.target !== null ? fmtPrice(c.target) : '—'}</TableCell>
              <TableCell className="num text-right">{c.rr !== null ? c.rr.toFixed(1) : '—'}</TableCell>
              <TableCell className="text-[10.5px] text-muted-foreground">
                {c.model ? `${PAIR_LABEL[c.model.bucket] ?? c.model.bucket}${c.model.action ? ` · ${c.model.action}` : ''}` : PAIR_LABEL.pending}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="h-4 px-1.5 text-[10px]" title={st?.note}>
                  {st ? (SETTLE_LABEL[st.source] ?? st.source) : t('等结算')}
                </Badge>
              </TableCell>
              <TableCell className={cn('num text-right', rTone(st?.plan?.r))}>{rText(st?.plan?.r)}</TableCell>
              <TableCell className={cn('num text-right', rTone(st?.trail?.r))}>{rText(st?.trail?.r)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function CandidatesSection() {
  const summaryQ = useQuery({ queryKey: ['candidates', 'summary'], queryFn: () => ledgerV2Api.candidateSummary(null), staleTime: 30_000, retry: 1 });
  const listQ = useQuery({ queryKey: ['candidates', 'list'], queryFn: () => ledgerV2Api.candidates({ limit: 200 }), staleTime: 30_000, retry: 1 });
  const indexQ = useQuery({ queryKey: ['history', 'strategy-index'], queryFn: ledgerV2Api.strategyIndex, staleTime: 120_000, retry: false });
  const ledgerQ = useQuery({ queryKey: ['judgment-ledger', 'summary-v2', null], queryFn: () => ledgerV2Api.summary(null), staleTime: 60_000, retry: false });
  const s = summaryQ.data ?? null;
  const rows = useMemo(() => listQ.data?.rows ?? [], [listQ.data]);
  const index = indexQ.data ?? [];
  const legs = useMemo(() => (listQ.data ? candidateLegStats(rows) : null), [listQ.data, rows]);
  // 列表一页最多 200 条;覆盖不到全体时中位数就只代表最近 200 条,标出来
  const partial = s !== null && listQ.data !== undefined && rows.length < s.n;
  const ledgerStrategies = (ledgerQ.data?.by_strategy ?? []).filter((x) => x.strategy_id && x.strategy_id !== UNNAMED_STRATEGY);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Workspace className="flex shrink-0 flex-col">
        <Pane title={t('影子候选')} hint={s ? t('{n} 条 · 未结算 {a} · 已结算 {b} · 可评分 {c}', { n: s.n, a: s.open, b: s.settled, c: s.scoreable }) : undefined} contentClassName="flex flex-col">
          {summaryQ.isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-14 w-full" />
            </div>
          ) : summaryQ.isError || !s ? (
            <div className="p-3 text-[11.5px] text-muted-foreground">
              {t('影子候选加载失败')}:{summaryQ.error instanceof Error ? summaryQ.error.message : t('网关还没有 /api/candidates')}
            </div>
          ) : (
            <>
              <NoteStrip>
                {t('研究策略按 IR 在线出的候选,不下单;零模型按计划腿(止损 / 目标 / 最多 48 根)和吊灯腿(ATR22×3 追踪)各走一遍 R,再和同时段的模型判断配对。')}
                {' '}
                <span className="text-foreground/80">{s.sample_note}</span>
              </NoteStrip>
              {partial ? <NoteStrip tone="warn">{t('列表只取了最近 {k} 条(共 {n} 条),中位数 / 截尾均值只覆盖这些。', { k: rows.length, n: s.n })}</NoteStrip> : null}
              <div className="grid grid-cols-5 gap-3 p-3">
                <Stat label={t('计划腿期望')} sub={<span className="inline-flex items-center gap-1">{t('可评分 {n} 条', { n: s.scoreable })} <ObserveBadge n={s.scoreable} unit={t('条')} /></span>}>
                  <MeanWithCenter mean={s.plan_expectancy_r} center={legs?.plan ?? null} unit={t('条')} className="items-start" />
                </Stat>
                <Stat label={t('计划腿净期望')} sub={t('扣交易成本后')}>
                  <MeanWithCenter mean={s.plan_net_expectancy_r} center={legs?.net ?? null} unit={t('条')} className="items-start" />
                </Stat>
                <Stat label={t('吊灯腿期望')} sub={t('同一入场,只收紧不设目标')}>
                  <MeanWithCenter mean={s.trail_expectancy_r} center={legs?.trail ?? null} unit={t('条')} className="items-start" />
                </Stat>
                <Stat label={t('计划腿胜率')} sub={s.mean_rr !== null ? t('平均 RR {rr} · 有目标 {p}', { rr: s.mean_rr.toFixed(2), p: pctText(s.share_with_target) }) : undefined}>
                  <span className="num font-semibold">{pctText(s.plan_win_rate)}</span>
                </Stat>
                <Stat label={t('不重叠口径')} sub={t('同一策略同一币上一条还没出场时跳过;{n} 条', { n: s.nonoverlap.n })}>
                  <span className={cn('num font-semibold', rTone(s.nonoverlap.plan_expectancy_r))}>{rText(s.nonoverlap.plan_expectancy_r)}</span>
                  <span className="num ml-1.5 text-[11px] text-muted-foreground">
                    {t('吊灯')} {rText(s.nonoverlap.trail_expectancy_r)}
                  </span>
                </Stat>
              </div>
              <div className="grid grid-cols-2 gap-3 border-t p-3">
                <div className="rounded-md border">
                  <div className="border-b bg-muted/30 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground">{t('按策略')}</div>
                  <Table className="table-dense">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('策略')}</TableHead>
                        <TableHead className="text-right">v</TableHead>
                        <TableHead className="text-right">{t('候选')}</TableHead>
                        <TableHead className="text-right">{t('已结算')}</TableHead>
                        <TableHead className="text-right">{t('计划腿')}</TableHead>
                        <TableHead className="text-right">{t('吊灯腿')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Object.entries(s.by_strategy).length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="py-3 text-center text-[11px] text-muted-foreground">
                            —
                          </TableCell>
                        </TableRow>
                      ) : (
                        Object.entries(s.by_strategy).map(([k, g]) => (
                          <TableRow key={k}>
                            <TableCell className="max-w-[240px]">
                              <StrategyLink id={g.strategy_id} index={index} />
                            </TableCell>
                            <TableCell className="num text-right">{g.version}</TableCell>
                            <GroupCells g={g} />
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
                <div className="rounded-md border">
                  <div className="border-b bg-muted/30 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground">
                    {t('候选 × 模型当时怎么判')}
                    <span className="ml-2 font-normal">{t('模型提议了但没有候选:{n} 次', { n: s.model_proposals_without_candidate })}</span>
                  </div>
                  <Table className="table-dense">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('配对')}</TableHead>
                        <TableHead className="text-right">{t('候选')}</TableHead>
                        <TableHead className="text-right">{t('已结算')}</TableHead>
                        <TableHead className="text-right">{t('计划腿')}</TableHead>
                        <TableHead className="text-right">{t('吊灯腿')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {PAIR_ORDER.filter((b) => (s.pairing[b]?.n ?? 0) > 0).map((b) => (
                        <TableRow key={b}>
                          <TableCell>{PAIR_LABEL[b]}</TableCell>
                          <GroupCells g={s.pairing[b]} />
                        </TableRow>
                      ))}
                      {PAIR_ORDER.every((b) => (s.pairing[b]?.n ?? 0) === 0) ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-3 text-center text-[11px] text-muted-foreground">
                            —
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          )}
        </Pane>
      </Workspace>

      <Workspace className="flex min-h-[220px] flex-1 flex-col">
        <Pane title={t('候选明细')} hint={listQ.data ? t('最近 {n} 条', { n: rows.length }) : undefined} className="min-h-0 flex-1" contentClassName="min-h-0 overflow-auto">
          {listQ.isLoading ? (
            <div className="p-3">
              <Skeleton className="h-20 w-full" />
            </div>
          ) : listQ.isError ? (
            <div className="p-3 text-[11.5px] text-muted-foreground">{t('候选列表加载失败')}</div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-[11.5px] text-muted-foreground">{t('还没有影子候选。研究策略开了影子之后,每根信号 K 线收盘会记一条。')}</div>
          ) : (
            <CandidateList rows={rows} index={index} />
          )}
        </Pane>
      </Workspace>

      <Workspace className="flex shrink-0 flex-col">
        <Pane title={t('判断账本里的策略')} hint={t('判断当时挂的策略名 → 「我的策略」里的策略对象')}>
          {ledgerQ.isError ? (
            <div className="p-3 text-[11.5px] text-muted-foreground">{t('判断账本加载失败')}</div>
          ) : ledgerStrategies.length === 0 ? (
            <div className="p-3 text-[11.5px] text-muted-foreground">{ledgerQ.isLoading ? t('加载中…') : t('账本里的判断都没挂策略。')}</div>
          ) : (
            <ul className="divide-y text-[11.5px]">
              {ledgerStrategies.map((x) => (
                <li key={x.strategy_id} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="min-w-0 flex-1">
                    <StrategyLink id={x.strategy_id!} index={index} />
                  </span>
                  <span className="num text-[10.5px] text-muted-foreground">{t('{n} 行 · 配对 {p}', { n: x.n, p: x.alpha_n })}</span>
                </li>
              ))}
            </ul>
          )}
        </Pane>
      </Workspace>
    </div>
  );
}
