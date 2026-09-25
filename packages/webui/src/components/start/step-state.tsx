/** 开始清单 / 接入页共用的状态灯 + 标签 */
import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { tmap } from '@/lib/i18n';
import type { StartStepState } from './logic';

export const STEP_STATE_LABEL: Record<StartStepState, string> = tmap({
  done: '已完成',
  todo: '待完成',
  blocked: '先完成前一步',
  skipped: '不需要',
  unknown: '读取中',
});

export function StepStateIcon({ state, className }: { state: StartStepState; className?: string }) {
  const cls = cn('size-4 shrink-0', className);
  if (state === 'done') return <CircleCheck className={cn(cls, 'text-up')} aria-label={STEP_STATE_LABEL.done} />;
  if (state === 'todo') return <Circle className={cn(cls, 'text-warn')} aria-label={STEP_STATE_LABEL.todo} />;
  if (state === 'blocked') return <CircleAlert className={cn(cls, 'text-muted-foreground')} aria-label={STEP_STATE_LABEL.blocked} />;
  if (state === 'skipped') return <CircleMinus className={cn(cls, 'text-muted-foreground/60')} aria-label={STEP_STATE_LABEL.skipped} />;
  return <CircleDashed className={cn(cls, 'text-muted-foreground/60')} aria-label={STEP_STATE_LABEL.unknown} />;
}

export function StepStateTag({ state }: { state: StartStepState }) {
  return (
    <span className={cn('flex items-center gap-1 text-[10.5px]', state === 'done' ? 'text-up' : state === 'todo' ? 'text-warn' : 'text-muted-foreground')}>
      <StepStateIcon state={state} className="size-3.5" />
      {STEP_STATE_LABEL[state]}
    </span>
  );
}
