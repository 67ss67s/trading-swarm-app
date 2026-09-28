/**
 * 时间刷选条:整段窗口的净值缩略线 + 可拖动的选区。
 *   在空白处按下拖动 = 新建选区;拖选区中间 = 平移;拖两侧把手 = 改起止;双击 = 回到全部。
 *   键盘:选区获得焦点后 ←/→ 平移,Shift+←/→ 改终点,Esc 回到全部。
 * 横轴按时间线性映射(报告净值点已近似等距抽稀,和上面按根数排布的图基本对齐)。
 */
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { BacktestAsset } from '@trade-gate/contracts';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BENCHMARK_COLOR, STRATEGY_COLOR, hexAlpha, ymd } from './format';
import { clampRange, type TimeRange } from './range';

const VB_W = 1000;
const VB_H = 40;

type Drag = { kind: 'new'; anchor: number } | { kind: 'move'; grab: number; start: TimeRange } | { kind: 'from' } | { kind: 'to' };

function pathOf(points: { at: number; v: number }[], window: TimeRange, lo: number, hi: number): string {
  const span = window.to_ms - window.from_ms || 1;
  const vr = hi - lo || 1;
  return points
    .map((p, i) => {
      const x = ((p.at - window.from_ms) / span) * VB_W;
      const y = VB_H - 3 - ((p.v - lo) / vr) * (VB_H - 6);
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join('');
}

export interface RangeBrushProps {
  asset: Pick<BacktestAsset, 'equity'> | null | undefined;
  window: TimeRange;
  value: TimeRange | null;
  onChange: (r: TimeRange | null) => void;
  /** 最窄选区(毫秒),默认 3 根 K 线由调用方传 */
  minSpan: number;
  className?: string;
}

export function RangeBrush({ asset, window, value, onChange, minSpan, className }: RangeBrushProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const span = window.to_ms - window.from_ms || 1;

  const lines = useMemo(() => {
    const eq = (asset?.equity ?? []).filter((p) => p.at >= window.from_ms - 1 && p.at <= window.to_ms + 1);
    const strat = eq.map((p) => ({ at: p.at, v: p.pnl_pct }));
    const bench = eq.filter((p) => p.benchmark_pct !== null).map((p) => ({ at: p.at, v: p.benchmark_pct as number }));
    const all = [...strat, ...bench].map((p) => p.v);
    const lo = all.length ? Math.min(...all) : 0;
    const hi = all.length ? Math.max(...all) : 1;
    const sp = pathOf(strat, window, lo, hi);
    return { strat: sp, area: strat.length ? `${sp}L${VB_W},${VB_H}L0,${VB_H}Z` : '', bench: pathOf(bench, window, lo, hi) };
  }, [asset, window]);

  const msAt = (clientX: number): number => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return window.from_ms;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return window.from_ms + f * span;
  };
  const emit = (from: number, to: number) => onChange(clampRange({ from_ms: from, to_ms: to }, window, minSpan));

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = (e.target as HTMLElement).closest('[data-brush]')?.getAttribute('data-brush');
    const at = msAt(e.clientX);
    if (target === 'from' || target === 'to') drag.current = { kind: target };
    else if (target === 'sel' && value) drag.current = { kind: 'move', grab: at, start: value };
    else drag.current = { kind: 'new', anchor: at };
    try {
      ref.current?.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件 / 已失效的指针:不捕获也能拖(移出条外会中断) */
    }
    setDragging(true);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const at = msAt(e.clientX);
    const cur = value ?? window;
    if (d.kind === 'new') {
      // 起步阶段选区很窄会被 clamp 成 null,等拖够再出现
      if (Math.abs(at - d.anchor) >= minSpan) emit(Math.min(at, d.anchor), Math.max(at, d.anchor));
    } else if (d.kind === 'from') emit(Math.min(at, cur.to_ms - minSpan), cur.to_ms);
    else if (d.kind === 'to') emit(cur.from_ms, Math.max(at, cur.from_ms + minSpan));
    else {
      const w = d.start.to_ms - d.start.from_ms;
      let from = d.start.from_ms + (at - d.grab);
      from = Math.max(window.from_ms, Math.min(window.to_ms - w, from));
      onChange({ from_ms: from, to_ms: from + w });
    }
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setDragging(false);
    try {
      ref.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* 同上 */
    }
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      onChange(null);
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = Math.max(minSpan / 3, span * 0.02) * (e.key === 'ArrowLeft' ? -1 : 1);
    const cur = value ?? window;
    if (e.shiftKey) emit(cur.from_ms, cur.to_ms + step);
    else if (value) {
      const w = cur.to_ms - cur.from_ms;
      const from = Math.max(window.from_ms, Math.min(window.to_ms - w, cur.from_ms + step));
      onChange({ from_ms: from, to_ms: from + w });
    }
  };

  const left = value ? ((value.from_ms - window.from_ms) / span) * 100 : 0;
  const width = value ? ((value.to_ms - value.from_ms) / span) * 100 : 100;

  return (
    <div className={cn('space-y-0.5', className)}>
      <div
        ref={ref}
        className={cn('relative h-11 touch-none overflow-hidden rounded-md border border-border bg-muted/25 select-none', dragging ? 'cursor-grabbing' : 'cursor-crosshair')}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => onChange(null)}
        data-testid="range-brush"
        aria-label={t('时间范围刷选条')}
      >
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full" aria-hidden>
          {lines.area ? <path d={lines.area} fill={hexAlpha(STRATEGY_COLOR, 0.12)} /> : null}
          {lines.bench ? <path d={lines.bench} fill="none" stroke={BENCHMARK_COLOR} strokeOpacity={0.55} strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" /> : null}
          {lines.strat ? <path d={lines.strat} fill="none" stroke={STRATEGY_COLOR} strokeWidth={1.25} vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        {value ? (
          <>
            <div className="pointer-events-none absolute inset-y-0 left-0 bg-background/65" style={{ width: `${left}%` }} />
            <div className="pointer-events-none absolute inset-y-0 right-0 bg-background/65" style={{ width: `${Math.max(0, 100 - left - width)}%` }} />
            <div
              data-brush="sel"
              tabIndex={0}
              role="group"
              aria-label={t('选中区间 {from} → {to}', { from: ymd(value.from_ms), to: ymd(value.to_ms) })}
              onKeyDown={onKey}
              className={cn('absolute inset-y-0 border-y border-primary/40 bg-primary/10 outline-none focus-visible:ring-2 focus-visible:ring-ring/60', dragging ? 'cursor-grabbing' : 'cursor-grab')}
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              <span data-brush="from" className="absolute inset-y-0 -left-1.5 flex w-3 cursor-ew-resize items-center justify-center">
                <i className="h-6 w-1 rounded-full bg-primary shadow" />
              </span>
              <span data-brush="to" className="absolute inset-y-0 -right-1.5 flex w-3 cursor-ew-resize items-center justify-center">
                <i className="h-6 w-1 rounded-full bg-primary shadow" />
              </span>
            </div>
          </>
        ) : (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground/90">{t('在这条上按住拖动,选一段时间')}</span>
        )}
      </div>
      <div className="num flex justify-between text-[10px] text-muted-foreground">
        <span>{ymd(window.from_ms)}</span>
        <span>{ymd(window.to_ms)}</span>
      </div>
    </div>
  );
}
