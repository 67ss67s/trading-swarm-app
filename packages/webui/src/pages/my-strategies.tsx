/**
 * 我的策略(#my-strategies,§9.46 策略对象生命周期;设计对齐 Horizon「My Strategies」)。
 *
 * 路由(hash 不带斜杠,解析见 components/my-strategies/model.ts parseRoute):
 *   #my-strategies                          卡片/列表
 *   #my-strategies?id=<sid>[&report=<rid>][&tab=deploy]  策略详情(可指定报告;tab=deploy = 「部署」页签:规则拆分预览 + 部署状态)
 *   #my-strategies?report=<rid>             单独看一份回测报告
 *   #backtest?id=<rid>                      同上;App.tsx 把 backtest 映射到本页(侧栏高亮「我的策略」)
 *
 * react-query key:
 *   ['research','my-strategies',filter,sort,q]  列表(搜索/筛选/排序走后端 query)
 *   ['research','my-strategy',id,report]        详情
 *   写操作后两个前缀一起失效(use-strategy-actions.tsx)。
 */
import { useEffect, useState } from 'react';
import { parseRoute, type MyStrategiesRoute } from '@/components/my-strategies/model';
import { StandaloneReport, StrategyDetail } from '@/components/my-strategies/strategy-detail';
import { StrategyList } from '@/components/my-strategies/strategy-list';

function useRoute(): MyStrategiesRoute {
  const [route, setRoute] = useState<MyStrategiesRoute>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function MyStrategiesPage() {
  const route = useRoute();
  if (route.view === 'detail') return <StrategyDetail key={route.id} id={route.id} report={route.report} tab={route.tab ?? 'report'} />;
  if (route.view === 'report') return <StandaloneReport key={route.report} reportId={route.report} />;
  return <StrategyList />;
}
