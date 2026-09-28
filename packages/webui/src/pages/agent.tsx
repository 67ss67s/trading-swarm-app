/**
 * Agent 页(2026-09-25 改版,在 B+ 方案 docs/design/ui-consistency-agent-page-2026-09-06.md 基础上):
 *   左:意图卡(components/agent-status-bar:agent 此刻在干什么 + 暂停/立即扫描/切换策略)+ 对话(空态是建议提问卡)
 *   右:需要你处理 → 今天 → 旅程入口 → tabs 状态 | 执行 | 团队
 *   窄屏(< lg)单列,右栏折到对话下方,整页滚动。
 * 工作流表单本体在 components/workflow-form.tsx;长配置(风险/额度/自动化/大脑)在设置页。
 * query key 约定见 App.tsx 顶部注释;本页不开 SSE。
 */
import { AgentSide } from '@/components/agent-side';
import { AgentStatusBar } from '@/components/agent-status-bar';
import { ChatPanel } from '@/components/chat-panel';
import { Pane, Workspace } from '@/components/pane';
import { StatusTag } from '@/components/tour/status-tag';
import { t } from '@/lib/i18n';

export function AgentPage() {
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_21rem] lg:overflow-hidden">
      <Workspace className="flex min-h-[36rem] flex-col lg:min-h-0">
        <AgentStatusBar />
        {/* data-tour:评审版新手引导第 2 步指向这里 */}
        <div data-tour="agent-chat" className="flex min-h-0 flex-1 flex-col">
          <Pane title={t('对话')} badge={<StatusTag kind="live" />} className="min-h-0 flex-1" contentClassName="min-h-0">
            <ChatPanel />
          </Pane>
        </div>
      </Workspace>
      <AgentSide />
    </div>
  );
}
