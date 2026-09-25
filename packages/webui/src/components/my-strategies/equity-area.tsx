/**
 * 卡片中部的收益曲线面积图(纯 SVG,不拉图表库)。
 * sparkline 按「权益序列」理解,第一个点就是零线:
 *   零线以上用收益色(总收益为正=up 绿、为负=down 红,持平=灰)填渐变,零线以下一律灰;
 *   点数不足两个(0 笔交易 / 空序列)画一条居中的平线,下方灰渐变——对齐 Horizon 的 0.0% 卡片。
 */
import { useId } from 'react';
import { cn } from '@/lib/utils';

export type EquityTone = 'up' | 'down' | 'flat';

export function toneOf(totalReturn: number | null | undefined): EquityTone {
  if (typeof totalReturn !== 'number' || !Number.isFinite(totalReturn) || Math.abs(totalReturn) < 0.0005) return 'flat';
  return totalReturn > 0 ? 'up' : 'down';
}

const W = 300;
const H = 120;
const TOP = 10;
const BOTTOM = 8;

/** 纯函数:序列 → 折线点与零线 y(测试可测) */
export function equityGeometry(values: readonly number[]): { points: [number, number][]; baseY: number } {
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return { points: [[0, H / 2], [W, H / 2]], baseY: H / 2 };
  const base = vals[0]!;
  let lo = Math.min(base, ...vals);
  let hi = Math.max(base, ...vals);
  if (hi - lo < 1e-12) {
    hi += 1;
    lo -= 1;
  }
  const y = (v: number) => TOP + (1 - (v - lo) / (hi - lo)) * (H - TOP - BOTTOM);
  const points = vals.map((v, i) => [(i / (vals.length - 1)) * W, y(v)] as [number, number]);
  return { points, baseY: y(base) };
}

export function EquityArea({ values, tone, className }: { values: readonly number[]; tone: EquityTone; className?: string }) {
  const uid = useId().replace(/:/g, '');
  const { points, baseY } = equityGeometry(values);
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${W},${baseY.toFixed(2)} L0,${baseY.toFixed(2)} Z`;
  // 平线时整块画在线下面,当成「零线以下」灰渐变
  const flat = points.every((p) => Math.abs(p[1] - baseY) < 1e-6);
  const flatArea = `M0,${baseY} L${W},${baseY} L${W},${H} L0,${H} Z`;
  const color = tone === 'up' ? 'var(--up)' : tone === 'down' ? 'var(--down)' : 'var(--muted-foreground)';
  const grey = 'var(--muted-foreground)';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn('block h-full w-full', className)} aria-hidden>
      <defs>
        <linearGradient id={`up-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id={`dn-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={grey} stopOpacity="0.22" />
          <stop offset="100%" stopColor={grey} stopOpacity="0.02" />
        </linearGradient>
        <clipPath id={`above-${uid}`}>
          <rect x="0" y="0" width={W} height={baseY} />
        </clipPath>
        <clipPath id={`below-${uid}`}>
          <rect x="0" y={baseY} width={W} height={H - baseY} />
        </clipPath>
      </defs>
      {flat ? (
        <>
          <path d={flatArea} fill={`url(#dn-${uid})`} />
          <path d={line} fill="none" stroke={grey} strokeOpacity="0.7" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        </>
      ) : (
        <>
          <path d={area} fill={`url(#up-${uid})`} clipPath={`url(#above-${uid})`} />
          <path d={area} fill={`url(#dn-${uid})`} clipPath={`url(#below-${uid})`} />
          <line x1="0" x2={W} y1={baseY} y2={baseY} stroke={grey} strokeOpacity="0.35" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" clipPath={`url(#above-${uid})`} />
          <path d={line} fill="none" stroke={grey} strokeOpacity="0.8" strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" clipPath={`url(#below-${uid})`} />
        </>
      )}
    </svg>
  );
}
