/**
 * 第 3 步「精修」:流程页里的精修工作区(refine-workspace.tsx,与独立的「优化」页 #refine 共用)。
 *   带入:地址栏 study + trial;进这一步之后有策略被存 / 更新 → 提示并自动进入第 4 步(每进一次只自动跳一次)。
 */
import { useCallback } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import type { FlowGo } from './flow-intro';
import type { FlowRoute } from './model';
import { RefineWorkspace, type SavedStrategy } from './refine-workspace';

export function StepRefine({ route, go, active }: { route: FlowRoute; go: FlowGo; active: boolean }) {
  const seed = route.study && route.trial ? { study: route.study, trial: route.trial } : null;
  const onSaved = useCallback((s: SavedStrategy) => {
    toast.success(t('「{name}」已存进我的策略,进入验收', { name: s.label }));
    go({ step: 'validate', strategy: s.id });
  }, [go]);
  return (
    <RefineWorkspace
      seed={seed}
      active={active}
      onSaved={onSaved}
      onValidate={(id) => go({ step: 'validate', strategy: id })}
      back={{ label: t('回到海选'), go: () => go({ step: 'scout' }) }}
      onBackToScout={(id) => go({ step: 'scout', ...(id ? { study: id } : {}) })}
      emptyText={t('没有带入的组合:可以在海选结果里点「精修这一组」,也可以直接在下面从头做。')}
      hint={t('在研究台里改规则、跑回测;每次回测会自动存进「我的策略」,存好就进入验收。')}
    />
  );
}
