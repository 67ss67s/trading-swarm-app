/**
 * 通用日方格(docs/design/evolution-floor-2026-09-23.md):
 *   mode='month'   Solana uptime 样式——每月一块、7 列(周一起)、月标题带该月 good 占比;
 *   mode='compact' 一行最近 N 天(楼层工位、判断记录、我的策略都能复用)。
 * 颜色:good 绿 / ok 黄 / bad 红 / none 灰,走 --evo-* 变量(缺省回退主题 token,楼层覆盖成 --of-*)。
 * 可访问:roving tabindex(整块只有一个 Tab 停靠点),方向键 / Home / End 移动,Enter / Space 选中;
 * hover / focus 出同一个轻量提示(日期 + headline),不给每格挂 radix Tooltip(九行 × 90 格太重)。
 */
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { EvoDay, EvoStatus } from '@/api/evolution';
import { getLang, t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fillDays, groupByMonth, lastNDays, moveIndex, statusColor, type MonthBlock } from './grid-logic';

export const EVO_STATUS_LABEL: Record<EvoStatus, string> = tmap({ good: '好于基线', ok: '接近基线', bad: '差于基线', none: '没有记录 / 未结算' });

export interface DayGridProps {
  /** 可以是稀疏的;缺的日子补成灰格 */
  days: readonly EvoDay[];
  mode?: 'month' | 'compact';
  /** month 模式的范围(含两端);缺省取 days 的首尾 */
  from?: string | null;
  to?: string | null;
  /** compact 模式显示最近几天(截止 to) */
  compactDays?: number;
  /** 格子边长 px;month 默认 12,compact 默认 7 */
  cell?: number;
  gap?: number;
  selectedDate?: string | null;
  onSelect?: (day: EvoDay) => void;
  /** 整体朗读名,比如「RADAR 最近 30 天」 */
  label?: string;
  className?: string;
  /** 提示框贴在格子上方还是下方 */
  tipSide?: 'top' | 'bottom';
}

function monthTitle(b: MonthBlock): string {
  const d = new Date(Date.UTC(b.year, b.month - 1, 1));
  return getLang() === 'en' ? d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : `${b.year}-${String(b.month).padStart(2, '0')}`;
}

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

export function dayAria(d: EvoDay): string {
  return `${d.date} · ${EVO_STATUS_LABEL[d.status]}${d.headline ? ` · ${d.headline}` : ''}`;
}

export function DayGrid({ days, mode = 'month', from, to, compactDays = 30, cell, gap, selectedDate, onSelect, label, className, tipSide = 'top' }: DayGridProps) {
  const size = cell ?? (mode === 'compact' ? 7 : 12);
  const g = gap ?? (mode === 'compact' ? 2 : 3);
  const seq = useMemo<EvoDay[]>(() => {
    if (mode === 'compact') return lastNDays(days, compactDays, to);
    const dates = days.map((d) => d.date).sort();
    const f = from ?? dates[0];
    const e = to ?? dates[dates.length - 1];
    return f && e ? fillDays(days, f, e) : [];
  }, [days, mode, from, to, compactDays]);
  const months = useMemo(() => (mode === 'month' ? groupByMonth(seq) : []), [seq, mode]);
  const indexOf = useMemo(() => new Map(seq.map((d, i) => [d.date, i])), [seq]);

  const selIdx = selectedDate ? indexOf.get(selectedDate) : undefined;
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const active = focusIdx ?? selIdx ?? seq.length - 1;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<{ day: EvoDay; x: number; y: number; h: number } | null>(null);
  const interactive = Boolean(onSelect);

  const showTip = (day: EvoDay, el: HTMLElement) => {
    const root = rootRef.current;
    if (!root) return;
    const a = el.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    setTip({ day, x: a.left - r.left + a.width / 2, y: a.top - r.top, h: a.height });
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const day = seq[i];
    if ((e.key === 'Enter' || e.key === ' ') && day) {
      e.preventDefault();
      e.stopPropagation();
      onSelect?.(day);
      return;
    }
    const next = moveIndex(i, e.key, seq.length, mode === 'compact' ? 1 : 7);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setFocusIdx(next);
    refs.current[next]?.focus();
  };

  const renderCell = (d: EvoDay) => {
    const i = indexOf.get(d.date) ?? 0;
    const sel = d.date === selectedDate;
    const style: CSSProperties = { width: size, height: mode === 'compact' ? Math.round(size * 1.6) : size, background: statusColor(d.status), borderRadius: Math.max(1, Math.round(size / 5)) };
    const common = {
      'data-status': d.status,
      'data-date': d.date,
      'aria-label': dayAria(d),
      onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => showTip(d, e.currentTarget),
      onMouseLeave: () => setTip(null),
      style,
      className: cn('evo-cell block shrink-0 p-0 outline-none transition-transform', interactive && 'cursor-pointer hover:scale-125 focus-visible:scale-125 focus-visible:ring-2 focus-visible:ring-ring', sel && 'ring-2 ring-foreground/80'),
    };
    if (!interactive) return <span key={d.date} role="img" {...common} />;
    return (
      <button
        key={d.date}
        type="button"
        ref={(el) => {
          refs.current[i] = el;
        }}
        tabIndex={i === active ? 0 : -1}
        aria-pressed={sel}
        onFocus={(e) => {
          setFocusIdx(i);
          showTip(d, e.currentTarget);
        }}
        onBlur={() => setTip(null)}
        onClick={(e) => {
          e.stopPropagation();
          onSelect?.(d);
        }}
        onKeyDown={(e) => onKey(e, i)}
        {...common}
      />
    );
  };

  return (
    <div ref={rootRef} className={cn('evo-grid relative', className)} role="group" aria-label={label}>
      {mode === 'compact' ? (
        <div className="flex items-end" style={{ gap: g }}>
          {seq.map(renderCell)}
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          {months.map((b) => (
            <div key={b.key} className="shrink-0">
              <div className="mb-1 flex items-baseline justify-between gap-2 text-[10px] leading-3" style={{ width: 7 * size + 6 * g }}>
                <span className="text-muted-foreground">{monthTitle(b)}</span>
                <span className="num font-medium" style={{ color: b.goodShare == null ? undefined : statusColor(b.goodShare >= 0.5 ? 'good' : b.goodShare >= 0.25 ? 'ok' : 'bad') }} title={t('该月好于基线的天数 / 已结算天数:{g}/{n}', { g: b.counts.good, n: b.counts.good + b.counts.ok + b.counts.bad })}>
                  {pct(b.goodShare)}
                </span>
              </div>
              <div className="grid" style={{ gridTemplateColumns: `repeat(7, ${size}px)`, gap: g }}>
                {b.cells.map((d, k) => (d ? renderCell(d) : <span key={`pad-${k}`} aria-hidden="true" style={{ width: size, height: size }} />))}
              </div>
            </div>
          ))}
        </div>
      )}
      {tip ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-50 w-max max-w-[260px] rounded border bg-popover px-2 py-1 text-[10.5px] leading-4 text-popover-foreground shadow-md"
          style={tipSide === 'top' ? { left: tip.x, top: tip.y - 6, transform: 'translate(-50%, -100%)' } : { left: tip.x, top: tip.y + tip.h + 6, transform: 'translateX(-50%)' }}
        >
          <div className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-sm" style={{ background: statusColor(tip.day.status) }} />
            <span className="num font-medium">{tip.day.date}</span>
            <span className="text-muted-foreground">{EVO_STATUS_LABEL[tip.day.status]}</span>
          </div>
          {tip.day.headline ? <div className="mt-0.5 whitespace-normal">{tip.day.headline}</div> : null}
          {tip.day.events ? <div className="text-muted-foreground">{t('{n} 个进化事件', { n: tip.day.events })}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 图例:四种颜色 + 口径 */
export function DayGridLegend({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground', className)}>
      {(['good', 'ok', 'bad', 'none'] as const).map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: statusColor(s) }} />
          {EVO_STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  );
}
