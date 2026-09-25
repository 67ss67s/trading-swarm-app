/**
 * 矩阵研究(§9.53 B,#matrix-study[?id=|?from=<recommendation_id>|?strategy=<research_strategy_id>]):
 *   新建:资产 × 周期 × 策略(我的策略 / 内置策略族)× 两臂(纯代码 / 代码+Jev)→ 先估算 → 开始;
 *     from = 推荐卡预填;strategy = 「我的策略」详情页「在矩阵研究里测这条」,表单预选这条策略;
 *   详情:阶段与进度 → 矩阵 → 迭代 → 结论 → 留出段一次释放 + 组合回测 → 存成我的策略(我的策略格子存为该策略新版本);
 *   列表:最近的研究。
 * 组件在 components/matrix-study/,研究台「矩阵研究」页签复用同一套(不另开会话)。
 * 纪律同后端:留出段只在最终候选冻结后释放一次;「没找到」是合法结论,不给放宽门槛的按钮。
 */
import { useEffect, useState } from 'react';
import { MatrixStudyCreate } from '@/components/matrix-study/create';
import { MatrixStudyDetail } from '@/components/matrix-study/detail';
import { MatrixStudyList } from '@/components/matrix-study/list';

const route = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');

export function MatrixStudyPage() {
  const [q, setQ] = useState(route);
  useEffect(() => { const on = () => setQ(route()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  const id = q.get('id'), from = q.get('from'), strategy = q.get('strategy');
  return (
    <div className="mx-auto flex h-full min-h-0 max-w-6xl flex-col gap-3 overflow-y-auto p-1">
      {id ? <MatrixStudyDetail id={id} /> : <><MatrixStudyCreate key={`${from ?? ''}|${strategy ?? ''}`} from={from} strategy={strategy} /><MatrixStudyList /></>}
    </div>
  );
}
