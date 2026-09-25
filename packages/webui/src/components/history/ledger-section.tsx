/**
 * 复盘页「这类判断值不值」(docs/design/watch-screener-review-2026-09-24.md 二-4):判断账本 jl-v2。
 *
 *   - 分层切换:按策略 / 按触发 / 按 prompt 版本 / 按持仓原因(网关 summary 的 by_strategy / by_trigger_kind /
 *     by_prompt_version / by_holding_reason);
 *   - 每层给样本量(行数、有效配对、独立簇),配对 < 30 标「观察」;网关自己的 insufficient 门槛(10)照样显示裁决;
 *   - 判断增量均值用网关的簇均值 judgment_alpha,旁边的中位数 / 截尾均值由前端从逐行数据按同一簇口径算
 *     (centerStats 口径同 gateway analyzer);逐行没取到就只显示均值并注明;
 *   - regret 拆成「该走没走」(HOLD/ADD 的 regret_hold)和「不该走走了」(EXIT/INVALIDATE 的 regret_exit);
 *   - 复查决策表(by_decision = review_decision_table)。
 *
 * 口径:summary 只取窗口内最近 500 行,逐行也只取同样的 500 行,两边是同一批。
 * react-query key:['judgment-ledger','summary-v2',since] / ['judgment-ledger','rows-v2',since] / ['history','strategy-index']。
 */
import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { LEDGER_SUMMARY_ROW_CAP, ledgerV2Api, type DecisionStratum, type LedgerDimV2, type LedgerRowV2, type LedgerStratumV2 } from '@/api/ledger-v2';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MeanWithCenter, NoteStrip, ObserveBadge } from './common';
import { LEDGER_VERDICT_CLASS, LEDGER_VERDICT_LABEL, LedgerRowList, pctText, rText, rTone } from './ledger-rows';
import { alphaCenter, groupRows, regretSplit, strategyHref, type AlphaCenter, type RegretSide, type RegretSplit } from './ledger-stats';

export const LEDGER_WINDOWS = [
  { id: '7d', label: '近 7 天', ms: 7 * 86_400_000 },
  { id: '30d', label: '近 30 天', ms: 30 * 86_400_000 },
  { id: 'all', label: '全部', ms: null as number | null },
];

const DIMS: { id: LedgerDimV2; label: string; col: string; hint: string }[] = [
  { id: 'strategy', label: '按策略', col: '策略', hint: '判断当时挂的策略(没挂的归「未指明策略」)' },
  { id: 'trigger_kind', label: '按触发', col: '触发', hint: '是什么把这次判断叫起来的(旧 jl-v1 行记 unknown)' },
  { id: 'prompt_version', label: '按 prompt 版本', col: 'prompt 版本', hint: '判断用的 prompt 版本(旧行记 unknown)' },
  { id: 'holding_reason', label: '按持仓原因', col: '持仓原因', hint: '只看复查:模型给出的继续拿着 / 走的理由' },
];

function strataOf(s: Awaited<ReturnType<typeof ledgerV2Api.summary>>, dim: LedgerDimV2): LedgerStratumV2[] | null {
  if (dim === 'strategy') return s.by_strategy;
  const v = dim === 'trigger_kind' ? s.by_trigger_kind : dim === 'prompt_version' ? s.by_prompt_version : s.by_holding_reason;
  return v ?? null;
}

function keyOf(st: LedgerStratumV2, dim: LedgerDimV2): string {
  return (dim === 'strategy' ? st.strategy_id : st.value) ?? '';
}

function sideText(side: RegretSide | undefined): { mean: number | null; n: number } {
  return { mean: side?.mean ?? null, n: side?.n ?? 0 };
}

function StratumLine({
  label,
  href,
  st,
  alpha,
  split,
  minSample,
  open,
  onToggle,
  bold,
}: {
  label: string;
  href: string | null;
  st: LedgerStratumV2;
  alpha: AlphaCenter | null;
  split: RegretSplit | null;
  minSample: number;
  open: boolean;
  onToggle: () => void;
  bold?: boolean;
}) {
  const hold = sideText(split?.hold);
  const exit = sideText(split?.exit);
  const clusters = st.alpha_clusters ?? alpha?.n ?? null;
  return (
    <TableRow className={cn('cursor-pointer', open && 'bg-muted/40', st.insufficient && 'text-muted-foreground')} onClick={onToggle} title={st.insufficient ? t('样本不足(有效配对 {n} < {m}):数字照算,不下结论', { n: st.alpha_n, m: minSample }) : undefined}>
      <TableCell className="w-6 text-muted-foreground">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</TableCell>
      <TableCell className={cn('num max-w-[260px]', bold && 'font-semibold')}>
        <span className="flex items-center gap-1.5">
          <span className="truncate" title={label}>
            {label}
          </span>
          {href ? (
            <a href={href} onClick={(e) => e.stopPropagation()} className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-normal text-primary hover:underline" title={t('去「我的策略」看这个策略对象')}>
              {t('策略')}
              <ExternalLink className="size-2.5" />
            </a>
          ) : null}
          <ObserveBadge n={st.alpha_n} unit={t('对')} />
        </span>
      </TableCell>
      <TableCell className="num text-right" title={t('窗口内行数(含未结算);结算不完整被剔除 {x} 行', { x: st.excluded_incomplete ?? 0 })}>
        {st.n}
      </TableCell>
      <TableCell className="num text-right" title={t('有效配对(已结算、两条腿都有 R)· 独立簇(同一线程多次复查算 1 个)')}>
        {st.alpha_n}
        <span className="text-muted-foreground"> · {clusters ?? '—'}</span>
      </TableCell>
      <TableCell className="text-right" title={t('mean(R_模型 − R_议会),先按簇求均值;中位数 / 截尾均值按同一批簇均值算')}>
        <MeanWithCenter mean={st.judgment_alpha} center={alpha} unit={t('簇')} />
      </TableCell>
      <TableCell className={cn('num text-right', rTone(st.alpha_vs_mechanical))} title={t('mean(R_模型 − R_机械),{n} 行进均值', { n: st.alpha_mech_n })}>
        {rText(st.alpha_vs_mechanical)}
      </TableCell>
      <TableCell className="num text-right" title={t('给出方向并愿意入场的占比:模型 {a} 行 / 议会 {b} 行表态已知', { a: st.model_known_n ?? '—', b: st.council_known_n ?? '—' })}>
        {pctText(st.model_direction_rate)}
        <span className="text-muted-foreground"> / {pctText(st.council_direction_rate)}</span>
      </TableCell>
      <TableCell className="num text-right" title={t('模型方向与议会不一致的比例;不一致时的增量 {a}', { a: rText(st.override_alpha) })}>
        {pctText(st.override_rate)}
      </TableCell>
      <TableCell className={cn('num text-right', hold.n ? rTone(-(hold.mean ?? 0)) : 'text-muted-foreground')} title={t('选了拿着(HOLD/ADD)的复查:max(0, 当场走 − 拿着);网关均值 {v}({n} 个)', { v: rText(st.review_regret_hold), n: st.review_hold_n ?? 0 })}>
        {hold.n ? rText(hold.mean) : '—'}
        <span className="text-muted-foreground"> ({hold.n})</span>
      </TableCell>
      <TableCell className={cn('num text-right', exit.n ? rTone(-(exit.mean ?? 0)) : 'text-muted-foreground')} title={t('选了走(EXIT/INVALIDATE)的复查:max(0, 拿着 − 当场走)')}>
        {exit.n ? rText(exit.mean) : '—'}
        <span className="text-muted-foreground"> ({exit.n})</span>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', LEDGER_VERDICT_CLASS[st.verdict])}>
          {LEDGER_VERDICT_LABEL[st.verdict]}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function RegretBox({ title, hint, side, tone }: { title: string; hint: string; side: RegretSide | null; tone: 'hold' | 'exit' }) {
  const n = side?.n ?? 0;
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className={cn('text-[11.5px] font-semibold', tone === 'hold' ? 'text-warn' : 'text-primary')}>{title}</span>
        <span className="num text-[10.5px] text-muted-foreground">{t('{n} 次 · {c} 条线程', { n, c: side?.clusters ?? 0 })}</span>
        <ObserveBadge n={n} unit={t('次')} />
      </div>
      <div className="mt-0.5 text-[10.5px] text-muted-foreground">{hint}</div>
      {n ? (
        <div className="mt-1.5 flex items-end gap-4">
          <MeanWithCenter mean={side!.mean} center={side} unit={t('次')} className="items-start text-[15px]" />
          <span className="num text-[11px] text-muted-foreground" title={t('regret > 0.5R 的占比')}>
            {t('明显后悔(> 0.5R)')} <b className="text-foreground">{pctText(side!.over_half_share)}</b>
          </span>
        </div>
      ) : (
        <div className="mt-1.5 text-[11px] text-muted-foreground">{t('还没有已结算的这类复查。')}</div>
      )}
    </div>
  );
}

function DecisionTable({ rows }: { rows: DecisionStratum[] }) {
  return (
    <Table className="table-dense">
      <TableHeader>
        <TableRow>
          <TableHead>{t('动作')}</TableHead>
          <TableHead>{t('持仓原因')}</TableHead>
          <TableHead>{t('触发')}</TableHead>
          <TableHead>prompt</TableHead>
          <TableHead className="text-right">{t('次 · 簇')}</TableHead>
          <TableHead className="text-right">{t('regret 均值')}</TableHead>
          <TableHead className="text-right">{t('拿着 R')}</TableHead>
          <TableHead className="text-right">{t('当场走 R')}</TableHead>
          <TableHead className="text-right">{t('该走没走')}</TableHead>
          <TableHead className="text-right" title={t('EXIT/INVALIDATE 里 regret > 0.5R 的占比')}>
            {t('走早了 >0.5R')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((d) => (
          <TableRow key={`${d.model_action}|${d.holding_reason}|${d.trigger_kind}|${d.prompt_version}`} className={cn(d.insufficient && 'text-muted-foreground')}>
            <TableCell className="num font-medium">{d.model_action}</TableCell>
            <TableCell className="num">{d.holding_reason}</TableCell>
            <TableCell className="num">{d.trigger_kind}</TableCell>
            <TableCell className="num max-w-[180px] truncate" title={d.prompt_version}>
              {d.prompt_version}
            </TableCell>
            <TableCell className="num text-right">
              <span className="inline-flex items-center gap-1">
                {d.n} · {d.clusters}
                <ObserveBadge n={d.n} unit={t('次')} />
              </span>
            </TableCell>
            <TableCell className="num text-right">{rText(d.mean_regret)}</TableCell>
            <TableCell className={cn('num text-right', rTone(d.mean_hold_r))}>{rText(d.mean_hold_r)}</TableCell>
            <TableCell className={cn('num text-right', rTone(d.mean_exit_now_r))}>{rText(d.mean_exit_now_r)}</TableCell>
            <TableCell className="num text-right">{rText(d.mean_regret_hold)}</TableCell>
            <TableCell className="num text-right">{pctText(d.exit_regret_gt_half_share)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function LedgerSection() {
  const [win, setWin] = useState('30d');
  const [dim, setDim] = useState<LedgerDimV2>('strategy');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const since = useMemo(() => {
    const w = LEDGER_WINDOWS.find((x) => x.id === win);
    return w?.ms ? Date.now() - w.ms : null;
  }, [win]);
  const summaryQ = useQuery({ queryKey: ['judgment-ledger', 'summary-v2', since], queryFn: () => ledgerV2Api.summary(since), staleTime: 30_000 });
  const rowsQ = useQuery({ queryKey: ['judgment-ledger', 'rows-v2', since], queryFn: () => ledgerV2Api.rows(since), staleTime: 30_000, retry: 1 });
  const indexQ = useQuery({ queryKey: ['history', 'strategy-index'], queryFn: ledgerV2Api.strategyIndex, staleTime: 120_000, retry: false });
  const s = summaryQ.data ?? null;
  const rows: LedgerRowV2[] | null = rowsQ.data?.rows ?? null;
  const index = indexQ.data ?? [];

  const groups = useMemo(() => (rows ? groupRows(rows, dim) : null), [rows, dim]);
  const overallAlpha = useMemo(() => (rows ? alphaCenter(rows) : null), [rows]);
  const overallSplit = useMemo(() => (rows ? regretSplit(rows) : null), [rows]);
  const overdue = useMemo(() => {
    if (!rows) return null;
    const now = Date.now();
    const xs = rows.filter((r) => r.settled_at === null && r.horizon_end_at < now);
    return xs.length ? { n: xs.length, oldest: Math.min(...xs.map((r) => r.horizon_end_at)) } : null;
  }, [rows]);

  const strata = s ? strataOf(s, dim) : null;
  const dimMeta = DIMS.find((d) => d.id === dim)!;
  const total = rowsQ.data?.total ?? null;

  return (
    <Workspace className="flex min-h-0 flex-1 flex-col">
      <Pane
        title={t('这类判断值不值')}
        hint={s ? t('{n} 行 · 已结算 {a} · 结算中 {b}', { n: s.n, a: s.settled, b: s.unsettled }) : undefined}
        className="min-h-0 flex-1"
        contentClassName="flex min-h-0 flex-col overflow-y-auto"
        actions={
          <div className="flex gap-0.5">
            {LEDGER_WINDOWS.map((w) => (
              <Button key={w.id} size="xs" variant={win === w.id ? 'secondary' : 'ghost'} onClick={() => setWin(w.id)}>
                {t(w.label)}
              </Button>
            ))}
          </div>
        }
      >
        {summaryQ.isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : summaryQ.isError || !s ? (
          <div className="p-3 text-[11.5px] text-muted-foreground">
            {t('判断账本加载失败')}:{summaryQ.error instanceof Error ? summaryQ.error.message : t('网关还没有 /api/judgment-ledger')}
          </div>
        ) : (
          <>
            {/* conclusion 是网关写死的结论口径字符串,原样显示 */}
            <NoteStrip>
              <span className="kicker mr-1 text-[9.5px]">{t('结论口径')}</span>
              {s.conclusion}
            </NoteStrip>
            <NoteStrip>
              {t('三条腿在同一 horizon、同一批 K 线上各结算一次 R:模型 / 议会 / 机械基线。这是方向性证据,不是 P&L——单路径、不再入场、无手续费与滑点。')}
              {' '}
              {t('有效配对 < 30 标「观察」;网关自己的门槛是配对 ≥ {m} 且簇 ≥ {c},不到就判「样本不足」。', { m: s.min_sample, c: s.min_clusters ?? s.min_sample })}
            </NoteStrip>
            {total !== null && total > LEDGER_SUMMARY_ROW_CAP ? (
              <NoteStrip tone="warn">{t('这个窗口里账本共 {total} 行,网关汇总只取最近 {cap} 行;下面的数字都只覆盖这 {cap} 行。要看更早的,缩短窗口。', { total, cap: LEDGER_SUMMARY_ROW_CAP })}</NoteStrip>
            ) : null}
            {overdue ? (
              <NoteStrip tone="warn">{t('{n} 行已过 horizon 还没结算(最早到期 {at}),这些行暂不进统计。', { n: overdue.n, at: fmtDateTime(overdue.oldest) })}</NoteStrip>
            ) : null}
            {rowsQ.isError ? <NoteStrip tone="warn">{t('逐行数据没取到:中位数、截尾均值和 regret 拆分算不了,只显示网关给的均值。')}</NoteStrip> : null}

            <div className="grid shrink-0 grid-cols-2 gap-3 border-b p-3">
              <RegretBox title={t('该走没走')} hint={t('复查时选了拿着(HOLD/ADD),事后看当场走更好:max(0, 当场走 R − 拿着 R)')} side={overallSplit?.hold ?? null} tone="hold" />
              <RegretBox title={t('不该走走了')} hint={t('复查时选了走(EXIT/INVALIDATE),事后看拿着更好:max(0, 拿着 R − 当场走 R)')} side={overallSplit?.exit ?? null} tone="exit" />
              {overallSplit && overallSplit.scored === 0 ? (
                <div className="col-span-2 text-[10.5px] text-muted-foreground">{t('窗口内有 {n} 行复查,还没有一行结算出 regret。', { n: overallSplit.reviews })}</div>
              ) : null}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
              {DIMS.map((d) => (
                <Button
                  key={d.id}
                  type="button"
                  size="xs"
                  variant={dim === d.id ? 'default' : 'outline'}
                  className="rounded-full"
                  onClick={() => {
                    setDim(d.id);
                    setOpenKey(null);
                  }}
                >
                  {t(d.label)}
                </Button>
              ))}
              <span className="ml-1 text-[10.5px] text-muted-foreground">{t(dimMeta.hint)}</span>
            </div>
            <div className="shrink-0">
              <Table className="table-dense">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-6" />
                    <TableHead>{t(dimMeta.col)}</TableHead>
                    <TableHead className="text-right">{t('行数')}</TableHead>
                    <TableHead className="text-right" title={t('有效配对 · 独立簇')}>
                      {t('配对 · 簇')}
                    </TableHead>
                    <TableHead className="text-right" title={t('mean(R_模型 − R_议会)')}>
                      {t('判断增量')}
                    </TableHead>
                    <TableHead className="text-right" title={t('mean(R_模型 − R_机械基线);≤ 0 = 连那枚硬币都没赢')}>
                      {t('对硬币')}
                    </TableHead>
                    <TableHead className="text-right">{t('出手率 模型/议会')}</TableHead>
                    <TableHead className="text-right">{t('不听议会率')}</TableHead>
                    <TableHead className="text-right">{t('该走没走')}</TableHead>
                    <TableHead className="text-right">{t('不该走走了')}</TableHead>
                    <TableHead>{t('裁决')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <StratumLine
                    label={t('全体')}
                    href={null}
                    st={s.overall}
                    alpha={overallAlpha}
                    split={overallSplit}
                    minSample={s.min_sample}
                    open={openKey === '__overall__'}
                    onToggle={() => setOpenKey(openKey === '__overall__' ? null : '__overall__')}
                    bold
                  />
                  {openKey === '__overall__' && rows ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={11} className="p-0">
                        <LedgerRowList rows={rows} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {strata === null ? (
                    <TableRow>
                      <TableCell colSpan={11} className="py-4 text-center text-[11px] text-muted-foreground">
                        {t('网关这一版还没给这一层(需要 jl-v2 汇总)。')}
                      </TableCell>
                    </TableRow>
                  ) : strata.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={11} className="py-4 text-center text-[11px] text-muted-foreground">
                        {t('这个窗口里没有这一层的行。')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    strata.map((st) => {
                      const key = keyOf(st, dim);
                      const g = groups?.get(key) ?? null;
                      const open = openKey === key;
                      return (
                        <Fragment key={key}>
                          <StratumLine
                            label={key}
                            href={dim === 'strategy' ? strategyHref(key, index) : null}
                            st={st}
                            alpha={g ? alphaCenter(g) : rows ? alphaCenter([]) : null}
                            split={g ? regretSplit(g) : null}
                            minSample={s.min_sample}
                            open={open}
                            onToggle={() => setOpenKey(open ? null : key)}
                          />
                          {open ? (
                            <TableRow className="hover:bg-transparent">
                              <TableCell colSpan={11} className="p-0">
                                {rows ? <LedgerRowList rows={g ?? []} /> : <div className="px-3 py-2 text-[11px] text-muted-foreground">{rowsQ.isLoading ? t('加载中…') : t('账本明细加载失败')}</div>}
                              </TableCell>
                            </TableRow>
                          ) : null}
                        </Fragment>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="shrink-0 border-t">
              <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
                <span className="kicker text-[10px] text-foreground/85">{t('复查决策表')}</span>
                <span className="text-[10.5px] text-muted-foreground">{t('动作 × 持仓原因 × 触发 × prompt 版本;只看已结算、regret 算得出的复查')}</span>
              </div>
              {s.by_decision === undefined ? (
                <div className="px-3 py-3 text-[11px] text-muted-foreground">{t('网关这一版还没给复查决策表。')}</div>
              ) : s.by_decision.length === 0 ? (
                <div className="px-3 py-3 text-[11px] text-muted-foreground">{t('还没有已结算的复查行,决策表是空的。')}</div>
              ) : (
                <DecisionTable rows={s.by_decision} />
              )}
            </div>
          </>
        )}
      </Pane>
    </Workspace>
  );
}
