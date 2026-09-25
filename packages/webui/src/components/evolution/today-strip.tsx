/**
 * 楼层顶部「今天」条(docs/design/evolution-floor-2026-09-23.md §五.1):权益、判断额度与花费、空转比例、
 * 票池状态(为空时红色并附原因)、影子候选。数据取 /api/evolution/daily 的 today;接口未就绪 / 没有 today 时整条不画。
 * 样式走楼层的 --of-* 变量,跟三套场景一起换色。
 */
import type { EvoToday } from '@/api/evolution';
import { t } from '@/lib/i18n';

function money(v: string | null): string {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}

function Item({ k, v, sub, color, title }: { k: string; v: string; sub?: string | null; color?: string; title?: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 px-3 py-1" title={title}>
      <span className="of-kicker shrink-0">{k}</span>
      <span className="num shrink-0 text-[11px] font-bold" style={{ color }}>
        {v}
      </span>
      {sub ? <span className="min-w-0 truncate text-[9.5px] text-[var(--of-ink-dim)]">{sub}</span> : null}
    </div>
  );
}

export function TodayStrip({ today }: { today: EvoToday | null | undefined }) {
  if (!today) return null;
  const j = today.judgments;
  const pool = today.live_pool;
  const cand = today.candidates;
  const idle = j?.idle_share;
  const poolEmpty = pool != null && pool.size <= 0;
  return (
    <div className="flex shrink-0 items-center divide-x divide-[var(--of-line)] overflow-hidden border-b border-[var(--of-line)] bg-[var(--of-panel)]" role="status" aria-label={t('今天')}>
      <div className="flex shrink-0 items-baseline gap-1.5 px-3 py-1">
        <span className="of-title text-xs text-[var(--of-accent)]">{t('今天')}</span>
        <span className="num text-[9.5px] text-[var(--of-ink-faint)]">{today.date} UTC</span>
      </div>
      <Item k={t('权益')} v={money(today.equity)} />
      {j ? <Item k={t('判断')} v={`${j.used} / ${j.cap || '∞'}`} sub={j.cost_cny != null ? `≈ ¥${j.cost_cny.toFixed(2)}` : null} color={j.cap && j.used >= j.cap ? 'var(--of-warn)' : undefined} /> : null}
      {idle != null ? <Item k={t('空转')} v={`${Math.round(idle * 100)}%`} sub={t('票池为空 / 只有 HOLD 仍调模型')} color={idle >= 0.5 ? 'var(--of-warn)' : undefined} title={t('模型调用里空转的比例:票池为空,或只有 HOLD 也照样调用')} /> : null}
      {pool ? <Item k={t('票池')} v={poolEmpty ? t('空') : t('{n} 个', { n: pool.size })} sub={pool.reason} color={poolEmpty ? 'var(--of-danger)' : undefined} title={pool.reason ?? undefined} /> : null}
      {cand ? <Item k={t('影子候选')} v={t('{open} 开 / {settled} 结算', { open: cand.open, settled: cand.settled })} /> : null}
      <a href="#evolution" className="ml-auto shrink-0 px-3 py-1 text-[10px] text-[var(--of-ink-dim)] hover:text-[var(--of-ink)] hover:underline">
        {t('进化 →')}
      </a>
    </div>
  );
}
