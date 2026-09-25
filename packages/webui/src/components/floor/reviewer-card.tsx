/**
 * 楼层左栏:选中 AUDIT(Reviewer)时的复盘面板(gateway 7102cd3)。
 * 平仓交易卡 + 批次决策(要不要跑、为什么、今日几次)+ 「立即批量复盘」(便宜大脑,≤ 2 次/天,409 = 不该跑)。
 * 批次产出走记忆流(proposed 记忆 + reviewer→gate_captain 的 review 交接),这里只给入口。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { ReviewerCardsResponse, TradeCard } from '@/api/types';
import { relativeTime } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';

const EXIT_LABEL: Record<TradeCard['exit_class'], string> = tmap({ stop: '止损', take_profit: '止盈', model_exit: '模型离场', invalidated: '失效', canceled: '撤单', manual: '手动', halt: '紧急停止', other: '其他' });
const OUTCOME: Record<TradeCard['outcome'], { label: string; color: string }> = {
  win: { label: '盈', color: 'var(--of-accent)' },
  loss: { label: '亏', color: 'var(--of-danger)' },
  scratch: { label: '平', color: 'var(--of-ink-dim)' },
  unfilled: { label: '没成交', color: 'var(--of-ink-faint)' },
  unknown: { label: '未知', color: 'var(--of-warn)' },
};

function fmtHold(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? t('{n} 分', { n: m }) : m < 1440 ? t('{n} 小时', { n: (m / 60).toFixed(1) }) : t('{n} 天', { n: (m / 1440).toFixed(1) });
}

export function ReviewerPanel({ data, now }: { data: ReviewerCardsResponse | null | undefined; now: number }) {
  const qc = useQueryClient();
  const batch = useMutation({
    mutationFn: api.reviewerBatch,
    onSuccess: (r) => {
      toast.success(t('批量复盘跑完了:{reason}', { reason: r.reason }));
      void qc.invalidateQueries({ queryKey: ['reviewer'] });
      void qc.invalidateQueries({ queryKey: ['bots'] });
      void qc.invalidateQueries({ queryKey: ['memory'] });
    },
    onError: (e: Error) => toast.warning(t('没跑:{msg}', { msg: e.message })),
  });
  if (!data) return <div className="of-panel p-3 text-[10px] text-[var(--of-ink-dim)]">{t('复盘接口还没就绪。')}</div>;
  const d = data.decision;
  return (
    <div className="of-panel p-3">
      <div className="flex items-center">
        <span className="of-kicker">{t('复盘')}</span>
        <span className="ml-auto text-[10px]" style={{ color: d.run ? 'var(--of-accent)' : 'var(--of-ink-dim)' }}>
          {t('{n} 笔等着进批次 · 今日 {runs}/2', { n: d.pending, runs: d.runs_today })}
        </span>
      </div>
      <div className="mt-1 text-[10px] leading-3.5 text-[var(--of-ink-dim)]">
        {d.reason}
        {d.last_batch_at ? ` · ${t('上次 {t}', { t: relativeTime(d.last_batch_at, now) })}` : ''}
      </div>
      <div className="mt-1 flex gap-1">
        <button type="button" className="border border-[var(--of-accent)] px-1.5 py-0.5 text-[10px] text-[var(--of-accent)] hover:bg-[var(--of-panel-2)] disabled:cursor-not-allowed disabled:border-[var(--of-line)] disabled:text-[var(--of-ink-faint)]" disabled={!d.run || batch.isPending} title={d.run ? t('副脑提炼教训 → 记忆页等你批') : d.reason} onClick={() => batch.mutate()}>
          {t('立即批量复盘')}
        </button>
        <a className="border border-[var(--of-line)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--of-panel-2)]" href="#memory">
          {t('去记忆页看提案')}
        </a>
      </div>
      <div className="mt-2 of-kicker">{t('最近平仓')}</div>
      <ul className="mt-1 space-y-1">
        {data.cards.length ? (
          data.cards.slice(0, 8).map((c) => {
            const o = OUTCOME[c.outcome] ?? OUTCOME.unknown;
            return (
              <li key={c.thread_id} className="border-l-2 pl-2 text-[10px]" style={{ borderColor: o.color }}>
                <div className="flex items-center gap-1">
                  <span className="num font-bold">{c.symbol}</span>
                  <span style={{ color: c.side === 'long' ? 'var(--of-accent)' : 'var(--of-danger)' }}>{c.side === 'long' ? t('多') : t('空')}</span>
                  <span style={{ color: o.color }}>{t(o.label)}</span>
                  <span className="text-[var(--of-ink-faint)]">{EXIT_LABEL[c.exit_class] ?? c.exit_class}</span>
                  {!c.protection_ok ? <span className="text-[var(--of-danger)]">{t('缺保护腿')}</span> : null}
                  <span className="ml-auto text-[var(--of-ink-faint)]">{c.ended_at ? relativeTime(c.ended_at, now) : ''}</span>
                </div>
                <div className="num text-[9px] text-[var(--of-ink-dim)]">
                  {c.r_multiple != null ? `${c.r_multiple >= 0 ? '+' : ''}${c.r_multiple.toFixed(2)}R` : '—'} · {c.realized_pnl != null ? `${Number(c.realized_pnl).toFixed(2)} U` : '—'} · {t('持 {d}', { d: fmtHold(c.hold_ms) })} · {c.strategy_id ?? t('无策略')} · {t('判断 {n} 次', { n: c.episode_count })}
                </div>
                {c.notes?.length ? <div className="text-[9px] text-[var(--of-ink-dim)]">{c.notes.slice(0, 2).join(';')}</div> : null}
              </li>
            );
          })
        ) : (
          <li className="text-[10px] text-[var(--of-ink-dim)]">{t('还没有平仓交易卡。')}</li>
        )}
      </ul>
      {data.batches.length ? (
        <div className="mt-2 text-[9px] text-[var(--of-ink-faint)]">
          {t('最近批次')}:{data.batches.slice(0, 3).map((b) => `${relativeTime(b.started_at, now)} ${b.status}${b.cost_cny ? ` ¥${b.cost_cny.toFixed(3)}` : ''}`).join(' · ')}
        </div>
      ) : null}
    </div>
  );
}
