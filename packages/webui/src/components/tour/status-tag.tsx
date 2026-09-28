/**
 * 评审版三种状态标记(2026-09-26 新手引导):
 *   LIVE     真实调用 —— DeepSeek / Jev 模型、OKX 公共行情、paper 撮合
 *   Snapshot OKX.AI 页 = 我们在 OKX.AI 上真实 ASP(#13866)的只读快照
 *   Locked   评审版锁定(钱包 / 凭证 / 模型密钥 / 执行通道 / 紧急停止 / ASP 写操作)
 *
 * 只在评审版渲染(默认版 Jacky 本机不需要这层说明);引导卡片里用 force 强制渲染。
 * 文案统一英文(评审只看英文),不走 t()。
 */
import { Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { IS_JUDGE, OKX_AI_LISTING_ID } from '@/lib/edition';
import { cn } from '@/lib/utils';

export type StatusKind = 'live' | 'snapshot' | 'locked';

export const STATUS_TAG: Record<StatusKind, { label: string; hint: string; className: string }> = {
  live: {
    label: 'LIVE',
    hint: 'Real calls, running now: DeepSeek and Jev models, OKX public market data, and paper order matching.',
    className: 'border-up/40 bg-up/10 text-up',
  },
  snapshot: {
    label: 'Snapshot',
    hint: `Read-only snapshot of our real ASP on OKX.AI (Agent #${OKX_AI_LISTING_ID}).`,
    className: 'border-primary/40 bg-primary/10 text-primary',
  },
  locked: {
    label: 'Locked',
    hint: 'Locked in the judge edition: wallets, credentials, model keys, the execution channel, emergency stop and OKX.AI write actions stay private.',
    className: 'border-border bg-muted text-muted-foreground',
  },
};

export function StatusTag({ kind, force = false, className }: { kind: StatusKind; force?: boolean; className?: string }) {
  if (!IS_JUDGE && !force) return null;
  const tag = STATUS_TAG[kind];
  return (
    <Tooltip>
      {/* Badge 是函数组件、不转发 ref;Radix 的 asChild 要 ref,外包一层 span 当触发元素 */}
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={`${tag.label}: ${tag.hint}`} data-status-tag={kind} className="inline-flex">
        <Badge
          variant="outline"
          className={cn('h-4 cursor-help gap-0.5 rounded-sm px-1 text-[9.5px] font-semibold tracking-wide normal-case', tag.className, className)}
        >
          {kind === 'live' ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
          {kind === 'locked' ? <Lock aria-hidden /> : null}
          {tag.label}
        </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="z-[80] max-w-64 text-[11px]">{tag.hint}</TooltipContent>
    </Tooltip>
  );
}
