/**
 * 第 2 步「海选」(原批量验证):复用 components/matrix-study 的新建表单与详情(v2 评分卡、三档结论、格子抽屉)。
 *   资产 / 周期 / 策略族从第 1 步带入(地址栏 syms / tfs / fams / sides / mkt);新建时固定不迭代(iterate.generations = 0)。
 *   结果区沿用地图与抽屉;抽屉「精修这一组」→ 第 3 步(带 study + trial);存成策略后「去验收」→ 第 4 步。
 *   旧研究留下的迭代记录折叠进「旧版迭代记录(历史研究)」(detail.tsx 流程模式)。
 */
import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { MatrixStudyCreate } from '@/components/matrix-study/create';
import { MatrixStudyDetail } from '@/components/matrix-study/detail';
import { MatrixStudyList } from '@/components/matrix-study/list';
import { MatrixFlowContext, type MatrixFlow } from '@/components/matrix-study/shared';
import { t } from '@/lib/i18n';
import type { FlowGo } from './flow-intro';
import type { FlowRoute } from './model';

export function StepScout({ route, go }: { route: FlowRoute; go: FlowGo }) {
  const flow = useMemo<MatrixFlow>(() => ({
    onRefine: (study, trial) => go({ step: 'refine', study, trial }),
    onValidate: (strategy) => go({ step: 'validate', strategy }),
    onBack: () => go({ study: null, trial: null }),
  }), [go]);
  const preset = { symbols: route.syms, timeframes: route.tfs, families: route.fams, sides: route.sides, market: route.mkt ?? undefined };
  const presetKey = JSON.stringify([preset, route.sref]);
  return (
    <MatrixFlowContext.Provider value={flow}>
      <div className="flex flex-col gap-3" data-testid="step-scout">
        {route.study ? (
          <MatrixStudyDetail key={route.study} id={route.study} onBack={flow.onBack} />
        ) : (
          <>
            {!route.syms.length && !route.sref ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-[12px] text-muted-foreground">
                {t('还没选资产。先在第 1 步挑几个推荐的币,或者在下面「手动改资产」里填。')}
                <button type="button" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline" onClick={() => go({ step: 'assets' })}><ArrowLeft className="size-3" />{t('回第 1 步')}</button>
              </div>
            ) : null}
            <MatrixStudyCreate key={presetKey} flow from={null} strategy={route.sref} preset={preset} onCreated={(v) => go({ study: v.id, trial: null })} />
            {/* data-tour:评审版新手引导第 3 步指向已完成的海选列表 */}
            <div data-tour="scout-studies">
              <MatrixStudyList limit={8} onOpen={(id) => go({ study: id, trial: null })} emptyHint />
            </div>
          </>
        )}
      </div>
    </MatrixFlowContext.Provider>
  );
}
