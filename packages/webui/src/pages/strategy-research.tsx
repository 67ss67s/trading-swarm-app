/**
 * 策略研究(#strategy-research,2026-09-25):「批量验证」和「研究台」合成的一条主路径,面向第一次用的交易者和评委。
 * 两边最后产出的是同一种东西(我的策略里的一个版本),区别只在找到它的过程,所以一页五步:
 *   1 选资产(推荐卡片墙,不手填)→ 2 海选(原批量验证,不迭代)→ 3 精修(嵌研究台,迭代只在这里)
 *   → 4 验收(最终验收只考一次 + 模拟盘前向)→ 5 上岗(设为 agent 当前策略,币池跟随雷达档)
 * 状态全在地址栏(见 components/strategy-research/model.ts 顶部),刷新不丢;旧路由 #research / #matrix-study 照常可用。
 * 精修那一步第一次进入后保持挂载(隐藏),在验收和精修之间来回切不丢研究台里的状态。
 */
import { useEffect, useState } from 'react';
import { FlowIntro, useFlowRoute } from '@/components/strategy-research/flow-intro';
import { StepAssets } from '@/components/strategy-research/step-assets';
import { StepScout } from '@/components/strategy-research/step-scout';
import { StepRefine } from '@/components/strategy-research/step-refine';
import { StepValidate } from '@/components/strategy-research/step-validate';
import { StepDeploy } from '@/components/strategy-research/step-deploy';

export function StrategyResearchPage() {
  const { route, go } = useFlowRoute();
  const [refineMounted, setRefineMounted] = useState(route.step === 'refine');
  useEffect(() => { if (route.step === 'refine') setRefineMounted(true); }, [route.step]);
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 pb-4" data-step={route.step}>
      <FlowIntro route={route} go={go} />
      {route.step === 'assets' ? <StepAssets route={route} go={go} /> : null}
      {route.step === 'scout' ? <StepScout route={route} go={go} /> : null}
      {refineMounted ? <div hidden={route.step !== 'refine'}><StepRefine route={route} go={go} active={route.step === 'refine'} /></div> : null}
      {route.step === 'validate' ? <StepValidate route={route} go={go} /> : null}
      {route.step === 'deploy' ? <StepDeploy route={route} go={go} /> : null}
    </div>
  );
}
