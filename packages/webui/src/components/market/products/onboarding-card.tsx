/**
 * 新手引导卡(可关闭,localStorage 记住;全部完成自动不再出现)。
 * 4 步来自后端 checklist;每个没完成的步骤有「去做」。
 */
import { Check, X } from 'lucide-react';
import type { ChecklistItem } from '@/api/asp-products';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

export function OnboardingCard({ items, onGo, onDismiss }: { items: ChecklistItem[]; onGo: (key: string) => void; onDismiss: () => void }) {
  const done = items.filter((i) => i.done).length;
  // 第一个没完成的步骤高亮,其余的「去做」弱一点
  const nextIdx = items.findIndex((i) => !i.done);
  return (
    <section className="rounded-md border border-primary/30 bg-primary/5 p-3" aria-label={t('新手引导')}>
      <header className="flex items-center gap-2">
        <h2 className="text-[12.5px] font-semibold">{t('开始卖信号')}</h2>
        <span className="num text-[11px] text-muted-foreground">{t('已完成 {d}/{n}', { d: done, n: items.length })}</span>
        <Button size="icon-xs" variant="ghost" className="ml-auto" onClick={onDismiss} aria-label={t('关闭引导')} title={t('关闭引导')}>
          <X />
        </Button>
      </header>
      <ol className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((s, i) => (
          <li key={s.key || i} className={cn('flex items-start gap-2 rounded border bg-card/60 p-2', i === nextIdx && 'border-primary/40')}>
            <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[10.5px]', s.done ? 'border-up/40 bg-up/15 text-up' : 'text-muted-foreground')}>
              {s.done ? <Check className="size-3" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn('text-[12px] font-medium', s.done && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{t(s.label)}</div>
              {s.hint ? <div className="text-[10.5px] text-muted-foreground">{t(s.hint)}</div> : null}
              {!s.done ? (
                <Button size="xs" variant={i === nextIdx ? 'default' : 'outline'} className="mt-1.5" onClick={() => onGo(s.key)}>
                  {t('去做')}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
