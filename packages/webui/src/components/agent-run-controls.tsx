/**
 * 顶栏唯一的 Agent 开关(2026-09-20 合并前的三颗按钮:「自动交易:开/关」「Agent 开关 ▾」「已暂停/运行中」)。
 *
 * 一颗按钮显示当前状态,点开是两个开关 + 折叠的角色列表:
 *   - Agent 判断  = workflow.paused 取反:到点扫描、复查、调模型。
 *   - 自动交易    = workflow.auto_approve:提议过闸后直接下单,不等人批。打开时顺手把 Executor 拉起来
 *                  (Executor 停着的话批了也不会执行),关掉只关免批,Executor 留着继续执行人工批的单。
 *   - 角色开关    = 八个角色各自的启/停(以前的「独立运行控制」),折叠起来,平时不用看。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { BotProfile, BotRole } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const DETAILS: Record<BotRole, string> = {
  gate_captain: '协调对话与简报', radar: '市场筛选、信息与新闻研究',
  thread_manager: '扫描、交易论点与持仓判断', strategy_lab: '实验、影子研究与策略假设',
  portfolio_manager: '仓位建议与自主配置；硬风控保留', risk_sentinel: '角色对话；自动风控检查和告警保留',
  reviewer: '模型复盘与记忆提炼', executor: '账户查询、结算与交易执行；暂停后账户数据停止刷新',
  asp_agent: 'OKX.AI 信号入站、发布与售后；关掉后不收不发',
};

function useToggle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role, enabled }: { role: BotRole | 'all'; enabled: boolean }) => api.setBotEnabled(role, enabled),
    onSuccess: (res) => {
      qc.setQueryData(['bots'], (old: unknown) => old ? { ...old as object, bots: res.bots } : undefined);
      for (const key of ['bots', 'overview', 'execution', 'workflow', 'screener']) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => toast.error(t('切换失败'), { description: e instanceof Error ? e.message : String(e) }),
  });
}

export function BotRunButton({ bot }: { bot: BotProfile; label?: boolean }) {
  const toggle = useToggle();
  return <Button size="xs" variant="outline" disabled={toggle.isPending} aria-label={`${bot.name} ${bot.enabled ? t('暂停') : t('启用')}`} aria-pressed={bot.enabled}
    title={t(DETAILS[bot.role])} onClick={() => toggle.mutate({ role: bot.role, enabled: !bot.enabled })}
    className={bot.enabled ? 'text-up' : 'text-warn'}>
    {bot.enabled ? <Pause className="size-3" /> : <Play className="size-3" />}
    {bot.enabled ? t('暂停') : t('启用')}
  </Button>;
}

function SwitchRow({ label, desc, checked, disabled, onChange }: { label: string; desc: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium">{label}</div>
        <p className="text-[10.5px] leading-snug text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

export function AgentSwitch({ paused, halted }: { paused: boolean; halted: boolean }) {
  const qc = useQueryClient();
  const wfQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });
  const bots = useQuery({ queryKey: ['bots'], queryFn: api.bots, refetchInterval: 5000 });
  const execution = useQuery({ queryKey: ['execution'], queryFn: api.execution, refetchInterval: 10000 });
  const toggle = useToggle();
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);

  const auto = wfQ.data?.auto_approve ?? false;
  const rows = bots.data?.bots ?? [];
  const executor = rows.find((b) => b.role === 'executor');
  const cost = execution.data?.cost_control;

  const patch = useMutation({
    mutationFn: (p: { paused?: boolean; auto_approve?: boolean }) => api.patchWorkflow(p),
    onSuccess: (res, p) => {
      if (res.errors?.length) { toast.error(t('没切成'), { description: res.errors.join('；') }); return; }
      qc.setQueryData(['workflow'], res.workflow);
      void qc.invalidateQueries({ queryKey: ['overview'] });
      if (p.paused !== undefined) toast.success(p.paused ? t('已暂停 agent') : t('已恢复 agent'));
      if (p.auto_approve !== undefined) toast.success(p.auto_approve ? t('已切到自动交易:agent 的提议过闸后直接下单') : t('已切到需要审批:每笔等你确认'));
      setConfirmAuto(false);
    },
    onError: (e) => toast.error(t('切换失败'), { description: e instanceof Error ? e.message : String(e) }),
  });
  const resetBudget = useMutation({ mutationFn: api.resetModelBudget, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['execution'] }); toast.success(t('额度暂停已解除；未重放历史交易')); }, onError: (e) => toast.error(String(e)) });
  const resetSettlement = useMutation({ mutationFn: api.resetSettlementRetries, onSuccess: () => toast.success(t('已恢复结算查询；每笔最多重试 3 次')), onError: (e) => toast.error(String(e)) });

  // 先把 Executor 拉起来并确认成功,再切免批;任一步失败都不切(review #4:两条请求并发会留下半开状态)
  const enableAuto = async () => {
    if (!bots.data) { toast.error(t('团队状态还没加载,再点一次')); return; }
    if (executor && !executor.enabled) {
      try {
        const res = await toggle.mutateAsync({ role: 'executor', enabled: true });
        if (!res.bots.find((b) => b.role === 'executor')?.enabled) { toast.error(t('Executor 没启起来,没切自动交易')); return; }
      } catch { return; }
    }
    patch.mutate({ auto_approve: true });
  };

  const running = !paused && !halted;
  const label = halted ? t('紧急停止') : paused ? t('Agent 已暂停') : auto ? t('Agent 自动交易') : t('Agent 运行中');

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button size="xs" variant="outline" className={cn('border-transparent', halted ? 'bg-destructive/15 text-destructive' : paused ? 'bg-warn/15 text-warn hover:bg-warn/25' : 'bg-up/15 text-up hover:bg-up/25')} title={t('Agent 判断 / 自动交易 / 各角色开关')}>
            <Bot data-slot="icon" />
            {label}
            <ChevronDown className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-3">
          <SwitchRow label={t('Agent 判断')} desc={t('到点扫描、复查持仓、调模型。关掉后只看盘不判断。')} checked={running} disabled={halted || patch.isPending} onChange={(next) => patch.mutate({ paused: !next })} />
          <SwitchRow label={t('自动交易')} desc={t('提议过完风控闸直接下单,不等你批。关掉后每笔停在「需要你点」。')} checked={auto} disabled={halted || patch.isPending} onChange={(next) => (next ? setConfirmAuto(true) : patch.mutate({ auto_approve: false }))} />
          {executor && !executor.enabled ? <p className="pb-1 text-[10.5px] text-warn">{t('Executor 停着:批了的单也不会执行,在下面角色里启用它。')}</p> : null}
          {cost?.model_budget.blocked ? <div className="border-t py-2 text-[10.5px]"><p className="text-warn">{cost.model_budget.reason}</p><Button size="xs" variant="outline" className="mt-1" disabled={resetBudget.isPending} onClick={() => resetBudget.mutate()}>{t('解除额度暂停')}</Button></div> : null}
          <button type="button" className="flex w-full items-center justify-between border-t pt-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setRolesOpen((v) => !v)}>
            <span>{t('角色开关')} · {rows.filter((b) => b.enabled).length}/{rows.length} {t('启用')}</span>
            <ChevronDown className={cn('size-3 transition-transform', rolesOpen && 'rotate-180')} />
          </button>
          {rolesOpen ? (
            <div className="mt-1">
              <div className="flex justify-end gap-1 pb-1">
                <Button size="xs" variant="ghost" disabled={!rows.length || toggle.isPending} onClick={() => toggle.mutate({ role: 'all', enabled: true })}>{t('全部启用')}</Button>
                <Button size="xs" variant="ghost" disabled={!rows.length || toggle.isPending} onClick={() => toggle.mutate({ role: 'all', enabled: false })}>{t('全部暂停')}</Button>
              </div>
              {bots.isError ? <p className="text-[11px]">{t('团队状态加载失败')}</p> : rows.map((bot) => (
                <div key={bot.role} className="flex items-center gap-2 border-t py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium">{bot.name}</div>
                    <p className="text-[10px] text-muted-foreground">{t(DETAILS[bot.role])}</p>
                  </div>
                  <BotRunButton bot={bot} />
                </div>
              ))}
              {cost ? (
                <div className="border-t pt-2 text-[10px] text-muted-foreground">
                  <p>{cost.read_mode === 'direct' ? t('账户与结算:直接 MCP 读取,0 模型 token') : t('账户与结算:模型读取')} · {t('本次启动')} {cost.model_runs}/{cost.direct_calls}/{cost.cache_hits}</p>
                  <Button size="xs" variant="ghost" className="mt-1 px-0" disabled={resetSettlement.isPending} onClick={() => resetSettlement.mutate()}>{t('重试未完成结算(只读)')}</Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      <ConfirmDialog open={confirmAuto} title={t('切到自动交易')} summary={t('确认切换')} busy={patch.isPending} onCancel={() => setConfirmAuto(false)} onConfirm={() => void enableAuto()}>
        <p className="text-muted-foreground">{t('切过去之后,agent 的开仓提议只要过完全部代码闸(风险、组合限额、风控哨兵),就直接在当前后端下真钱单,不再等你确认。风险、杠杆、上限还是按工作流的设置走。随时能点回「需要审批」。')}</p>
      </ConfirmDialog>
    </>
  );
}
