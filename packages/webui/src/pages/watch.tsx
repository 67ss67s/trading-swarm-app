// 盯盘参数独立页(#watch)。内容全部在 components/watch/watch-panel.tsx,Agent 页「盯盘参数」抽屉用同一个组件
// (docs/design/watch-screener-review-2026-09-24.md 二-2)。风险、额度、自动化、大脑仍在「设置 › 工作流」;新币候选在「筛选」。
import { WatchPanel } from '@/components/watch/watch-panel';

export function WatchPage() {
  return <WatchPanel layout="page" />;
}
