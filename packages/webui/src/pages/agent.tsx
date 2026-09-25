/**
 * Agent 页(B+ 方案,docs/design/ui-consistency-agent-page-2026-09-06.md §3/§6):
 *   左:对话(顶部状态条 = 运行摘要 + 暂停/扫描/信息员 + 「盯盘参数」抽屉)
 *   右:固定的异常/待办块 + tabs 状态 | 执行 | 团队
 * 工作流表单本体在 components/workflow-form.tsx;长配置(风险/额度/自动化/大脑)在设置页。
 * query key 约定见 App.tsx 顶部注释;本页不开 SSE。
 */
import { AgentSide } from '@/components/agent-side';
import { AgentStatusBar } from '@/components/agent-status-bar';
import { ChatPanel } from '@/components/chat-panel';
import { Pane, Workspace } from '@/components/pane';
import { t } from '@/lib/i18n';

export function AgentPage() {
  return (
    <div className="grid h-full min-h-0 grid-cols-[1fr_20rem] gap-3">
      <Workspace className="flex min-h-0 flex-col">
        <AgentStatusBar />
        <Pane title={t('对话')} className="min-h-0 flex-1" contentClassName="min-h-0">
          <ChatPanel />
        </Pane>
      </Workspace>
      <AgentSide />
    </div>
  );
}
