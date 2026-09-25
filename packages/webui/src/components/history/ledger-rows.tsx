/**
 * 判断账本的逐行明细(从 pages/history.tsx 搬过来,口径不变):一行 = 一次判断,三条腿(模型 / 议会 / 机械基线)
 * 在同一 horizon、同一批 K 线上各结算一次 R。null ≠ 0:算不出一律「—」。
 * jl-v2 起行上多了 trigger_kind / holding_reason / prompt_version 与 regret_hold / regret_exit,展开时一并显示。
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { LedgerLeg, LedgerLegStatus, LedgerOutcomeSource, LedgerVerdict } from '@/api/types';
import type { LedgerRowV2 } from '@/api/ledger-v2';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { directionLabel, directionText, fmtClock, fmtDateTime, fmtPrice } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { regretExitOf, regretHoldOf } from './ledger-stats';

export const LEDGER_VERDICT_LABEL: Record<LedgerVerdict, string> = tmap({
  insufficient: '样本不足',
  no_edge: '模型没有增量',
  model_adds: '模型有增量',
  model_hurts: '模型在拖后腿',
  unclear: '看不出来',
});

export const LEDGER_VERDICT_CLASS: Record<LedgerVerdict, string> = {
  insufficient: 'bg-muted text-muted-foreground border-transparent',
  no_edge: 'bg-warn/15 text-warn border-warn/30',
  model_adds: 'bg-up/15 text-up border-up/30',
  model_hurts: 'bg-down/15 text-down border-down/30',
  unclear: 'bg-muted text-foreground/80 border-border',
};

const LEDGER_SOURCE_LABEL: Record<LedgerOutcomeSource, string> = tmap({
  thread_settlement: '交易所净 R',
  counterfactual: '反事实',
  flat: '不表态 0R',
  unscoreable: '算不出',
});

const LEG_STATUS_LABEL: Record<LedgerLegStatus, string> = tmap({ stop: '止损', tp: '止盈', expired: '到期', flat: '不表态', unscoreable: '算不出' });

/** null ≠ 0:算不出来就是「—」。 */
export function rText(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
}

export function pctText(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`;
}

export function rTone(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'text-muted-foreground';
  return v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-muted-foreground';
}

function LegCell({ name, leg }: { name: string; leg: LedgerLeg | null }) {
  if (!leg) {
    return (
      <div className="rounded-sm border bg-card px-2 py-1.5 text-[11px]">
        <div className="kicker text-[9.5px] text-muted-foreground">{name}</div>
        <div className="mt-0.5 text-muted-foreground">{t('还没结算')}</div>
      </div>
    );
  }
  return (
    <div className="rounded-sm border bg-card px-2 py-1.5 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span className="kicker text-[9.5px] text-muted-foreground">{name}</span>
        <span className={cn('text-[10.5px]', directionText(leg.direction))}>{leg.direction ? directionLabel(leg.direction) : t('不表态')}</span>
        <span className={cn('num ml-auto font-semibold', rTone(leg.r))}>{rText(leg.r)}</span>
      </div>
      <div className="num mt-0.5 text-[10px] text-muted-foreground">
        {t('成交')} {leg.fill !== null ? fmtPrice(leg.fill) : '—'} · {t('止损')} {leg.stop !== null ? fmtPrice(leg.stop) : '—'} · {t('止盈')} {leg.tp !== null ? fmtPrice(leg.tp) : '—'}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        {LEG_STATUS_LABEL[leg.status]} · {t('走了 {n} 根', { n: leg.bars_walked })}
      </div>
      {leg.note ? <div className="mt-0.5 text-[10px] text-muted-foreground/80">{leg.note}</div> : null}
    </div>
  );
}

export function LedgerRowLine({ row }: { row: LedgerRowV2 }) {
  const [open, setOpen] = useState(false);
  const settled = row.settled_at !== null;
  const rh = regretHoldOf(row);
  const rx = regretExitOf(row);
  return (
    <li className="px-2 py-1.5 text-[11.5px]">
      <div className="flex cursor-pointer flex-wrap items-center gap-1.5" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
        <span className="num font-medium">{row.symbol}</span>
        <span className="num text-[10.5px] text-muted-foreground" title={fmtDateTime(row.at)}>
          {fmtClock(row.at)}
        </span>
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
          {row.mode === 'scan' ? t('扫描') : t('复查')}
        </Badge>
        <span className="text-[10.5px] text-muted-foreground">{row.model_action ?? t('判断没跑出来')}</span>
        <span className="num ml-auto flex items-center gap-2 text-[10.5px]">
          <span title={t('模型腿')} className={rTone(row.outcome_r_model)}>
            {t('模型')} {row.model_dir ? directionLabel(row.model_dir) : t('不表态')} {rText(row.outcome_r_model)}
          </span>
          <span title={t('议会腿;council_agree 为 null = 这次没有议会')} className={rTone(row.outcome_r_council)}>
            {t('议会')} {row.council_dir ? directionLabel(row.council_dir) : row.council_agree === null ? t('无议会') : t('没共识')} {rText(row.outcome_r_council)}
          </span>
          <span title={row.mechanical_note ?? t('机械基线:1h EMA20/50 定方向、0.8 ATR 止损、1.5R 目标、48 根')} className={rTone(row.outcome_r_mechanical)}>
            {t('机械')} {row.mechanical_dir ? directionLabel(row.mechanical_dir) : '—'} {rText(row.outcome_r_mechanical)}
          </span>
          <span className="text-muted-foreground">{settled ? (row.outcome_source_model ? LEDGER_SOURCE_LABEL[row.outcome_source_model] : '—') : t('结算中')}</span>
        </span>
      </div>
      {open ? (
        <div className="mt-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="grid grid-cols-3 gap-1.5">
            <LegCell name={t('模型')} leg={row.legs.model} />
            <LegCell name={t('议会')} leg={row.legs.council} />
            <LegCell name={t('机械基线')} leg={row.legs.mechanical} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
            <span className="num">{t('判断周期')} {row.timeframe ?? '—'}</span>
            <span className="num">{t('horizon 到期')} {fmtDateTime(row.horizon_end_at)}</span>
            {row.trigger_kind ? <span className="num">{t('触发')} {row.trigger_kind}</span> : null}
            {row.prompt_version ? <span className="num">prompt {row.prompt_version}</span> : null}
            {row.holding_reason ? <span className="num">{t('持仓原因')} {row.holding_reason}</span> : null}
            <span className="num">{t('复查 regret')} {rText(row.regret_review)}</span>
            {rh !== null ? <span className="num">{t('该走没走')} {rText(rh)}</span> : null}
            {rx !== null ? <span className="num">{t('不该走走了')} {rText(rx)}</span> : null}
            <span className="num">{row.episode_id}</span>
            {row.settle_note ? <span>{row.settle_note}</span> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

const PAGE = 50;

/** 一层的逐行(来自已取回的那一页,新的在前);一次先显示 50 行。 */
export function LedgerRowList({ rows }: { rows: readonly LedgerRowV2[] }) {
  const [shown, setShown] = useState(PAGE);
  if (rows.length === 0) return <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('这个窗口里没有行。')}</div>;
  return (
    <>
      <ul className="divide-y bg-muted/20">
        {rows.slice(0, shown).map((r) => (
          <LedgerRowLine key={r.episode_id} row={r} />
        ))}
      </ul>
      {rows.length > shown ? (
        <div className="flex justify-center border-t bg-muted/20 py-1.5">
          <Button size="xs" variant="ghost" onClick={() => setShown((n) => n + PAGE)}>
            {t('再显示 {n} 行(共 {total})', { n: Math.min(PAGE, rows.length - shown), total: rows.length })}
          </Button>
        </div>
      ) : null}
    </>
  );
}
