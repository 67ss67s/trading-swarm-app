/**
 * 流程页顶部的「流程简介」:一句话 + 五步横向小图(在做什么 → 产出什么),点一步切过去;当前步高亮,做完的打勾。
 * useFlowRoute:地址栏 ⇄ 路由状态(刷新不丢;前进后退能用)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { STEPS, STEP_DOING, STEP_OUTPUT, STEP_TITLE, flowHash, parseFlowRoute, stepDone, type FlowRoute, type FlowStep } from './model';

export type FlowGo = (patch: Partial<FlowRoute>, opts?: { replace?: boolean }) => void;

export function useFlowRoute(): { route: FlowRoute; go: FlowGo } {
  const [route, setRoute] = useState<FlowRoute>(() => parseFlowRoute(window.location.hash));
  const ref = useRef(route);
  ref.current = route;
  useEffect(() => {
    const on = () => setRoute(parseFlowRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback<FlowGo>((patch, opts) => {
    const next = flowHash({ ...ref.current, ...patch });
    if (opts?.replace) {
      try { window.history.replaceState(null, '', `#${next}`); } catch { /* 沙箱 */ }
      setRoute(parseFlowRoute(`#${next}`));
    } else {
      window.location.hash = next;
    }
  }, []);
  return { route, go };
}

export function FlowIntro({ route, go }: { route: FlowRoute; go: FlowGo }) {
  const cur = STEPS.indexOf(route.step);
  return (
    <section className="rounded-xl border bg-card px-3 py-2.5" aria-label={t('策略研究流程')}>
      <p className="mb-2 text-[13px] leading-snug">
        <span className="font-semibold">{t('策略研究')}</span>
        <span className="text-muted-foreground"> — {t('从推荐的币开始,先海选一大圈,挑出站得住的精修,验收过了再交给 agent 上岗。')}</span>
      </p>
      <ol className="grid grid-cols-5 gap-1.5 max-md:flex max-md:overflow-x-auto" data-testid="flow-steps">
        {STEPS.map((s: FlowStep, i) => {
          const active = s === route.step, done = !active && stepDone(route, s);
          return (
            <li key={s} className="min-w-[8.5rem] flex-1">
              <button
                type="button"
                data-step={s}
                aria-current={active ? 'step' : undefined}
                onClick={() => go({ step: s })}
                className={cn(
                  'group relative flex h-full w-full flex-col items-start gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-all',
                  active ? 'border-primary bg-primary/10 shadow-[0_6px_18px_-12px_var(--primary)]' : 'border-border hover:border-primary/40 hover:bg-muted/40',
                )}
              >
                <span className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                  <span className={cn('num inline-flex size-4 items-center justify-center rounded-full text-[10px]', active ? 'bg-primary text-primary-foreground' : done ? 'bg-up/20 text-up' : 'bg-muted text-muted-foreground')}>
                    {done ? <Check className="size-2.5" /> : i + 1}
                  </span>
                  {STEP_TITLE[s]}
                </span>
                <span className="text-[10.5px] leading-snug text-muted-foreground">
                  {STEP_DOING[s]} <span className="text-muted-foreground/60">→</span> <span className={cn(active ? 'text-foreground/80' : '')}>{STEP_OUTPUT[s]}</span>
                </span>
                {i < cur ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary/30" /> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
