/**
 * 策略图标:按 strategy id 生成的确定性几何图案(同一个 id 永远同一张图)。
 * 4×4 格子左右镜像,每格按哈希位取「空 / 圆 / 圆角方 / 小点」,颜色走 primary token,
 * 深浅两档透明度,底板是 primary 的淡色渐变——对齐 Horizon 卡片左上的小方块图标。
 */
import { useId } from 'react';
import { cn } from '@/lib/utils';

/** FNV-1a 32 位;再用 xorshift 展开成足够多的随机位 */
export function glyphSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 1;
}

export type GlyphCell = { x: number; y: number; kind: 1 | 2 | 3; strong: boolean };

/** 纯函数:生成格子,测试也用它断言确定性 */
export function glyphCells(id: string): GlyphCell[] {
  let s = glyphSeed(id);
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  const cells: GlyphCell[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 2; x++) {
      const r = next();
      const kind = (r % 4) as 0 | 1 | 2 | 3;
      if (kind === 0) continue;
      const strong = ((r >>> 4) & 1) === 1;
      cells.push({ x, y, kind, strong });
      cells.push({ x: 3 - x, y, kind, strong });
    }
  }
  // 全空的哈希太难看:至少保证中间一列有东西
  if (cells.length === 0) cells.push({ x: 1, y: 1, kind: 1, strong: true }, { x: 2, y: 1, kind: 1, strong: true });
  return cells;
}

export function StrategyGlyph({ id, className, size = 36 }: { id: string; className?: string; size?: number }) {
  const gid = useId().replace(/:/g, '');
  const cells = glyphCells(id);
  const cell = 7;
  const pad = 4;
  return (
    <svg
      viewBox={`0 0 ${pad * 2 + cell * 4} ${pad * 2 + cell * 4}`}
      width={size}
      height={size}
      aria-hidden
      className={cn('shrink-0 rounded-md', className)}
    >
      <defs>
        <linearGradient id={`g-${gid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.08" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={pad * 2 + cell * 4} height={pad * 2 + cell * 4} rx="6" fill={`url(#g-${gid})`} />
      {cells.map((c, i) => {
        const cx = pad + c.x * cell + cell / 2;
        const cy = pad + c.y * cell + cell / 2;
        const op = c.strong ? 0.95 : 0.55;
        if (c.kind === 1) return <circle key={i} cx={cx} cy={cy} r={cell / 2 - 0.6} fill="var(--primary)" fillOpacity={op} />;
        if (c.kind === 2) return <rect key={i} x={cx - cell / 2 + 0.7} y={cy - cell / 2 + 0.7} width={cell - 1.4} height={cell - 1.4} rx="1.6" fill="var(--primary)" fillOpacity={op} />;
        return <circle key={i} cx={cx} cy={cy} r={1.5} fill="var(--primary)" fillOpacity={op} />;
      })}
    </svg>
  );
}
