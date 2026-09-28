/**
 * 设置页(09-25 侧栏改名「风控与自动化」):按任务口径只做两件事——紧急停止/解除控制 + 后端/大脑只读信息,外加一个工作流
 * 只读概览(编辑在 Agent 页,这里不重复做表单)。紧急停止/解除流程原样照抄 App.tsx 顶栏的
 * 那一份(同一套 ConfirmDialog 用法、同样的 requireText、同样先 api.halt()/api.resume('RESUME')
 * 再 invalidate ['overview'])。
 *
 * react-query key 约定见 src/App.tsx 顶部注释:这里用 ['overview'] + ['workflow'],两个都已经
 * 挂在 App.tsx 的 SSE 处理器上(loop.state / workflow.changed 都会 invalidate),本页不用自己
 * 再开一条 /api/events 连接。
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OctagonAlert } from 'lucide-react';
import { api } from '@/api/client';
import { CliCommandsCard } from '@/components/cli-commands-card';
import { WorkflowForm } from '@/components/workflow-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { JudgeLock } from '@/components/judge-lock';
import { Pane, StatCell, Workspace } from '@/components/pane';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { friendlyError, IS_JUDGE } from '@/lib/edition';
import { backendLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview });

  const [haltOpen, setHaltOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [haltBusy, setHaltBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);

  const loop = overviewQ.data?.loop ?? null;
  const halted = loop?.halted ?? false;

  const confirmHalt = async () => {
    setHaltBusy(true);
    try {
      await api.halt();
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      setHaltOpen(false);
    } finally {
      setHaltBusy(false);
    }
  };
  const confirmResume = async () => {
    setResumeBusy(true);
    try {
      await api.resume('RESUME');
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      setResumeOpen(false);
    } finally {
      setResumeBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <Workspace className="shrink-0">
        <Pane title={t('运行状态')}>
          {overviewQ.isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : overviewQ.isError ? (
            <p className="p-3 text-[12px] text-destructive">
              {t('加载失败')}:{friendlyError(overviewQ.error instanceof Error ? overviewQ.error.message : String(overviewQ.error))}
            </p>
          ) : (
            <div className="divide-y">
              <StatCell label={t('后端')} value={backendLabel(loop?.backend)} />
              <StatCell label={t('回退主脑')} value={loop?.brain ?? '—'} />
              <StatCell
                label={t('调度状态')}
                value={halted ? t('已紧急停止') : loop?.paused ? t('已暂停') : t('运行中')}
                aside={<span className={cn('size-1.5 rounded-full', halted ? 'bg-destructive' : loop?.paused ? 'bg-warn' : 'bg-up')} />}
              />
              <StatCell label={t('自动执行')} value={loop?.auto_approve ? t('开:agent 提议免确认') : t('关:每笔要你批')} />
            </div>
          )}
          <Separator />
          <div className="flex flex-wrap items-center gap-3 p-3">
            <JudgeLock feature="emergency_stop">
              <Button
                variant={halted ? 'destructive' : 'outline'}
                size="sm"
                className={cn(!halted && 'border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive')}
                onClick={() => (halted ? setResumeOpen(true) : setHaltOpen(true))}
              >
                <OctagonAlert data-slot="icon" />
                {halted ? t('解除紧急停止') : t('紧急停止')}
              </Button>
            </JudgeLock>
            <p className="max-w-md text-[11px] text-muted-foreground">
              {halted
                ? t('现在是紧急停止,不会再开新仓,直到你手动解除。')
                : t('会立刻撤掉全部挂单、市价平掉全部持仓,并停掉后面所有开仓判断,直到你手动解除。不可逆。')}
            </p>
          </div>
        </Pane>
      </Workspace>

      <Workspace className="shrink-0">
        <Pane title={t('模型')}>
          <p className="p-3 text-[11.5px] leading-relaxed text-muted-foreground">
            {t('各角色用什么模型、回退主脑 / 副脑,都在「模型连接」页改;这里不再单独放一份。')}
            <a href="#models" className="ml-1 text-primary hover:underline">
              {t('去模型连接 →')}
            </a>
          </p>
        </Pane>
      </Workspace>

      {/* 评审版不露出本机 CLI 启动命令与路径(整块不渲染) */}
      {IS_JUDGE ? null : (
        <Workspace className="shrink-0">
          <Pane title={t('CLI 启动命令')} hint={t('每台机器都不一样:别名、代理前缀、绝对路径都行,改完立刻生效')}>
            <CliCommandsCard />
          </Pane>
        </Workspace>
      )}

      {/* 外观卡只配旧楼层(#floor-legacy);旧楼层所有版本都已下线,这张卡也不再放 */}

      <Workspace className="flex h-[640px] shrink-0 flex-col">
        <Pane title={t('风控与自动化')} hint={t('观察列表和盯盘节奏在「观察列表」页改;交易市场、杠杆、保证金模式在「接入」页改')} className="min-h-0 flex-1" contentClassName="min-h-0">
          {/* 09-25 ③-7:名单 / 节奏只在观察列表页改一份;③-4:交易市场 / 杠杆 / 保证金模式跟账户模式放在接入页 */}
          <WorkflowForm groups={['risk', 'limits', 'automation']} sectioned defaultOpen={['risk']} hideWatchlist hideMarket />
        </Pane>
      </Workspace>

      <ConfirmDialog
        open={haltOpen}
        title={t('紧急停止')}
        summary={t('确认紧急停止')}
        danger
        requireText="HALT"
        busy={haltBusy}
        onCancel={() => setHaltOpen(false)}
        onConfirm={() => void confirmHalt()}
      >
        <p>{t('这会立刻撤掉全部挂单、市价平掉全部持仓,并停掉后面所有开仓判断,直到你手动恢复。不可逆,想清楚再确认。')}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={resumeOpen}
        title={t('解除紧急停止')}
        summary={t('确认解除')}
        danger
        requireText="RESUME"
        busy={resumeBusy}
        onCancel={() => setResumeOpen(false)}
        onConfirm={() => void confirmResume()}
      >
        <p>{t('解除之后调度恢复正常,agent 随时可能重新判断、重新开仓。当前状况处理好了吗?')}</p>
      </ConfirmDialog>
    </div>
  );
}
