/** 验收 / 上岗两步没带 strategy 时:从「我的策略」里挑一条(最近更新的在前) */
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Shapes } from 'lucide-react';
import { researchApi } from '@/api/client';
import { SOURCE_TEXT, displayName, strategySource } from '@/components/agent-strategy/switch-list';
import { SCORE_LABEL } from '@/components/backtest-report/format';
import { Skeleton } from '@/components/ui/skeleton';
import { relativeTime } from '@/lib/format';
import { t } from '@/lib/i18n';

export function StrategyPicker({ title, onPick, onBack }: { title: string; onPick: (id: string) => void; onBack?: { label: string; go: () => void } }) {
  const q = useQuery({ queryKey: ['research', 'my-strategies', 'flow-picker'], queryFn: () => researchApi.myStrategies({ filter: 'all', sort: 'updated' }), retry: false });
  const list = (q.data?.strategies ?? []).filter((s) => s.status !== 'archived' && s.current_version > 0).slice(0, 10);
  return (
    <section className="rounded-xl border p-3" data-testid="strategy-picker">
      <div className="mb-2 flex items-center gap-2">
        <Shapes className="size-4 text-primary" />
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {onBack ? <button type="button" className="ml-auto text-[12px] text-primary hover:underline" onClick={onBack.go}>{onBack.label}</button> : null}
      </div>
      {q.isLoading ? <Skeleton className="h-32 rounded-lg" /> : !list.length ? (
        <p className="text-[12px] text-muted-foreground">{t('「我的策略」里还没有能用的策略:先走海选或精修存一条。')}</p>
      ) : (
        <ul className="grid gap-1.5 md:grid-cols-2">
          {list.map((s) => {
            const src = strategySource(s);
            return (
              <li key={s.id}>
                <button type="button" onClick={() => onPick(s.id)} className="group flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors hover:border-primary/50 hover:bg-primary/5">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{displayName(s)}</span>
                      {src ? <span className="shrink-0 rounded-full border px-1.5 text-[10px] text-muted-foreground">{t(SOURCE_TEXT[src])}</span> : null}
                    </span>
                    <span className="num block truncate text-[11px] text-muted-foreground">v{s.current_version} · {s.symbol.replace(/USDT$/, '')} · {s.timeframe}{s.summary?.score_label ? ` · ${SCORE_LABEL[s.summary.score_label]}` : ''} · {relativeTime(s.updated_at)}</span>
                  </span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
