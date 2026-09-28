/**
 * 顶部 ASP 身份条:名称 #id · 上架审核状态(人话,被拒带原因)· 在线 · 可领收入 + 领取;身份的上架 / 下架放在右侧。
 * products 接口拿不到时用 /api/market/asp 的身份信息兜底。
 */
import { Coins, Megaphone } from 'lucide-react';
import type { AspSummary } from '@/api/asp-products';
import type { MarketIdentity } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { JudgeLock } from '@/components/judge-lock';
import { friendlyError } from '@/lib/edition';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { fmtUsdt } from '../shared';
import { TONE_CLASS, approvalTone, identityPhase } from './labels';

export interface IdentityBarProps {
  summary: AspSummary | null;
  identity: MarketIdentity;
  claimable: string | null;
  claimError: string | null;
  claiming: boolean;
  onClaim: () => void;
  activeBusy: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
}

export function IdentityBar({ summary, identity, claimable, claimError, claiming, onClaim, activeBusy, onActivate, onDeactivate }: IdentityBarProps) {
  const name = summary?.name ?? identity.name;
  const id = summary?.agent_id ?? identity.agent_id;
  const approval = summary?.approval ?? null;
  const tone = approvalTone(approval);
  // 产品汇总还没到(冷启动要几秒)时不猜上架状态,避免新用户先看到「未上架 + 上架身份」
  const pending = !summary;
  const approvalLabel = approval?.label ? t(approval.label) : pending ? t('状态读取中') : identity.status === 'active' ? t('已上架') : t('未上架');
  const online = summary?.online ?? null;
  const amount = Number(claimable ?? '0');
  const canClaim = claimable !== null && Number.isFinite(amount) && amount > 0;
  const isActive = identity.status === 'active';
  // 审核中 / 已上架不给「上架身份」(重复提交没用);被拒给「重新提交审核」
  const phase = identityPhase(approval, isActive);
  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5">
      <div className="flex min-w-0 items-center gap-2.5">
        {identity.avatar ? <img alt="" src={identity.avatar} className="size-9 shrink-0 rounded-md border object-cover" /> : <div className="size-9 shrink-0 rounded-md border bg-muted" />}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold">{name}</span>
            <span className="num text-[11px] text-muted-foreground">#{id}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <Badge variant="outline" className={cn('text-[10px]', approval ? TONE_CLASS[tone] : isActive ? TONE_CLASS.ok : TONE_CLASS.idle)}>
              {approvalLabel}
            </Badge>
            {online !== null ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <span className={cn('size-1.5 rounded-full', online ? 'bg-up' : 'bg-muted-foreground/50')} />
                {online ? t('在线') : t('离线')}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {approval?.remark && tone !== 'ok' ? (
        <p className={cn('text-[11px] sm:max-w-md', tone === 'bad' ? 'text-down' : 'text-muted-foreground')}>
          {tone === 'bad' ? t('原因') : t('说明')}:{friendlyError(approval.remark)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
        <span className="text-[11px] text-muted-foreground">
          {t('可领收入')} <span className="num text-[13px] font-semibold text-foreground">{fmtUsdt(claimable)}</span>
        </span>
        <JudgeLock feature="asp_claim">
          <Button size="xs" variant={canClaim ? 'default' : 'outline'} disabled={claiming || !canClaim} onClick={onClaim}>
            <Coins data-slot="icon" />
            {t('领取到钱包')}
          </Button>
        </JudgeLock>
        {pending ? null : isActive ? (
          <JudgeLock feature="asp_register">
            <Button size="xs" variant="ghost" disabled={activeBusy} onClick={onDeactivate}>
              {t('下架身份')}
            </Button>
          </JudgeLock>
        ) : phase === 'not_submitted' || phase === 'rejected' ? (
          <JudgeLock feature="asp_register">
            <Button size="xs" variant="outline" disabled={activeBusy} onClick={onActivate}>
              <Megaphone data-slot="icon" />
              {phase === 'rejected' ? t('重新提交审核') : t('上架身份')}
            </Button>
          </JudgeLock>
        ) : null}
      </div>
      {claimError ? <p className="w-full text-[10.5px] text-warn">{friendlyError(claimError)}</p> : null}
    </div>
  );
}
