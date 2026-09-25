/**
 * 研究工作台的动效基础件(motion 库):只做有证据的动——数字变了才滚、列表项进出才滑、
 * 任务状态变了才换色;全部尊重 prefers-reduced-motion。位移只动 transform/opacity。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

/** 数字滚动到目标值(约 500ms,easeOut);reduced-motion 直接跳。 */
export function useCountUp(target: number, durationMs = 500): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    if (reduced || !Number.isFinite(target)) {
      setValue(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, reduced]);
  return value;
}

/** 滚动数字:format 拿到插值后的数字自己格式化。 */
export function AnimatedNumber({ value, format, className }: { value: number | null | undefined; format: (v: number) => string; className?: string }) {
  const v = useCountUp(typeof value === 'number' && Number.isFinite(value) ? value : 0);
  if (typeof value !== 'number' || !Number.isFinite(value)) return <span className={className}>—</span>;
  return (
    <span className={cn('num tabular-nums', className)}>
      {format(v)}
    </span>
  );
}

/** 进场淡入 + 上滑 6px;列表里配合 AnimatePresence 用。 */
export function Reveal({ children, className, delay = 0, layout = false }: { children: ReactNode; className?: string; delay?: number; layout?: boolean }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      layout={layout}
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? undefined : { opacity: 0, y: -4 }}
      transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1], delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export { AnimatePresence, motion };
