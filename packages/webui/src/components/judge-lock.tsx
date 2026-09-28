/**
 * 评审版锁定包装(lib/edition.ts 的 LOCK_REASONS):
 *
 *   <JudgeLock feature="wallet_connect"><Button onClick={connect}>Connect</Button></JudgeLock>
 *
 * 默认版:原样渲染 children,一个属性都不改。
 * 评审版:子元素加 disabled、去掉 onClick,外面包一层 span 挂 tooltip(禁用按钮本身收不到鼠标事件)。
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { lockReason, type LockedFeature } from '@/lib/edition';
import { cn } from '@/lib/utils';

export function JudgeLock({ feature, children, className }: { feature: LockedFeature; children: ReactNode; className?: string }) {
  const reason = lockReason(feature);
  if (!reason) return <>{children}</>;
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<{ disabled?: boolean; onClick?: unknown; 'aria-disabled'?: boolean; tabIndex?: number }>, { disabled: true, onClick: undefined, 'aria-disabled': true })
    : children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex cursor-not-allowed items-center gap-1', className)} tabIndex={0} aria-label={reason} data-judge-lock={feature}>
          {child}
          <Lock className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-[11px]">{reason}</TooltipContent>
    </Tooltip>
  );
}

/** 非按钮的场景(整块表单等):评审版返回原因,调用方自己决定怎么禁用 */
export { lockReason } from '@/lib/edition';
