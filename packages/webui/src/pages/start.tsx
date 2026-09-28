/**
 * #start「开始」清单(docs/design/ia-newcomer-audit-2026-09-25.md ⑤,第二批):
 * 新手从这里按顺序走到「agent 用自由判断跑模拟盘」。每一步读真实状态判完成(components/start/logic.ts,
 * 只用已有接口),给一个直达链接;完成的自动打勾。核心四项(交易所 / 模型 / 观察列表 / 当前策略)没完成时,
 * 无 hash 打开页面默认落这里(App.tsx);完成后回到原来的默认页,侧栏底部留一行「接入完成 ✓」随时再打开。
 */
import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { useAgentStrategy } from '@/api/agent-strategy';
import { JudgeLock } from '@/components/judge-lock';
import { Workspace } from '@/components/pane';
import { Button } from '@/components/ui/button';
import { START_OPTIONAL_STEPS, START_STEP_ORDER, type StartStepId, type StartStepState } from '@/components/start/logic';
import { StepStateIcon, STEP_STATE_LABEL } from '@/components/start/step-state';
import { setFreeJudgmentConfirmed, useStartFull } from '@/components/start/use-start';
import { askAgent } from '@/lib/ask-agent';
import { friendlyError, lockReason, type LockedFeature } from '@/lib/edition';
import { exchangeInfo } from '@/lib/exchange';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const STEP_TITLE: Record<StartStepId, string> = {
  exchange: '连接交易所账户',
  account_mode: '选账户模式',
  funding: '入金检查',
  models: '接模型',
  market: '定交易市场与风险',
  watchlist: '选币(观察列表)',
  matrix: '跑一次批量验证',
  strategy: '设 agent 当前策略',
  protection: '验证保护单',
  agent: '让 agent 在模拟盘跑起来',
  review: '看复盘',
};

const STEP_DESC: Record<StartStepId, string> = {
  exchange: '模拟盘 / 实盘二选一,新手先连模拟盘。key 只留在本机。',
  account_mode: '只做现货选简单模式;要做永续,选单币种或跨币种保证金。',
  funding: '实盘账户权益为 0 时 agent 开不了新仓;模拟盘自动跳过。',
  models: '至少一个模型连接测试通过(或本机 CLI 能起来),agent 才能判断。',
  market: '永续 / 现货、单笔风险、杠杆;默认值直接可用,其余去「风控与自动化」。',
  watchlist: '观察列表至少一个币。让 agent 推荐,或者去筛选(名单为空时用全市场扫)。',
  matrix: '可选:从对话推荐卡「去批量验证」进来会带着资产和周期;也可以直接开一个。',
  strategy: '「自由判断」是合法选项,默认就是它;点一次确认,知道这个开关在哪。',
  protection: '只在实盘或要开永续时需要:在模拟盘按清单人工跑一遍,再标记。',
  agent: '顶栏「Agent 判断」打开;「自动交易」保持关闭,每笔要你批。',
  review: '可选:平过仓之后,去复盘看这笔赚没赚、这类判断值不值。',
};

function Action({ href, children, external, lock }: { href: string; children: ReactNode; external?: boolean; lock?: LockedFeature }) {
  // 评审版:这一步要做的事被锁了(交易所凭证 / 模型 key / 保护单…)→ 条目照常显示,按钮置灰 + 悬停说原因
  if (lock && lockReason(lock))
    return (
      <JudgeLock feature={lock}>
        <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px] text-muted-foreground opacity-60">
          {children}
          {external ? <ExternalLink className="size-3" /> : <ArrowRight className="size-3" />}
        </button>
      </JudgeLock>
    );
  return (
    <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer noopener' : undefined} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px] text-primary hover:bg-muted">
      {children}
      {external ? <ExternalLink className="size-3" /> : <ArrowRight className="size-3" />}
    </a>
  );
}

export function StartPage() {
  const qc = useQueryClient();
  const { steps, core, progress, inputs } = useStartFull();
  const stratQ = useAgentStrategy();
  const ex = exchangeInfo(inputs.execution ?? undefined);
  const resume = useMutation({
    mutationFn: () => api.patchWorkflow({ paused: false }),
    onSuccess: (res) => {
      qc.setQueryData(['workflow'], res.workflow);
      void qc.invalidateQueries({ queryKey: ['overview'] });
      toast.success(t('已恢复 agent'));
    },
    onError: (e) => toast.error(t('切换失败'), { description: friendlyError(e instanceof Error ? e.message : String(e)) }),
  });

  const actions = (id: StartStepId, state: StartStepState): ReactNode => {
    switch (id) {
      case 'exchange':
      case 'account_mode':
        return <Action href="#connect" lock="exchange_credentials">{t('去接入页')}</Action>;
      case 'protection':
        return <Action href="#connect" lock="protection_verify">{t('去接入页')}</Action>;
      case 'market':
        return <Action href="#connect">{t('去接入页')}</Action>;
      case 'funding':
        return state === 'todo' ? <Action href={ex.depositUrl} external lock="exchange_credentials">{t('去入金')}</Action> : null;
      case 'models':
        return <Action href="#models" lock="model_connection_edit">{t('去模型连接')}</Action>;
      case 'watchlist':
        return (
          <>
            <Button size="xs" variant="outline" onClick={() => askAgent(t('推荐几个值得盯的币,说说理由'))}>
              {t('让 agent 推荐')}
            </Button>
            <Action href="#screener">{t('去筛选')}</Action>
            <Action href="#watch">{t('去观察列表')}</Action>
          </>
        );
      case 'matrix':
        return <Action href="#matrix-study">{t('去批量验证')}</Action>;
      case 'strategy':
        return (
          <>
            {stratQ.data?.kind === 'strategy' ? (
              <span className="text-[11.5px]">{t('当前:{name}', { name: stratQ.data.name ?? stratQ.data.strategy_id ?? '' })}</span>
            ) : state !== 'done' ? (
              <Button size="xs" variant="outline" onClick={() => setFreeJudgmentConfirmed(true)}>
                {t('确认用自由判断')}
              </Button>
            ) : (
              <span className="text-[11.5px] text-muted-foreground">{t('当前:自由判断')}</span>
            )}
            <Action href="#my-strategies">{t('去我的策略选一条')}</Action>
          </>
        );
      case 'agent':
        return (
          <>
            {state === 'todo' ? (
              <Button size="xs" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate()}>
                {resume.isPending ? <Loader2 data-slot="icon" className="animate-spin" /> : null}
                {t('打开 Agent 判断')}
              </Button>
            ) : null}
            <span className="text-[11px] text-muted-foreground">{t('自动交易保持关闭:每笔要你批')}</span>
          </>
        );
      case 'review':
        return <Action href="#history">{t('去复盘')}</Action>;
    }
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-3 overflow-y-auto pb-6">
      <div className="shrink-0">
        <h2 className="text-[15px] font-semibold">{t('开始:按顺序让 agent 在模拟盘跑起来')}</h2>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          {t('必做 {done} / {total} 项完成。', progress)}
          {core === true ? t('交易所、模型、观察列表、当前策略都好了,默认首页已回到楼层;这页随时可以从侧栏底部再打开。') : t('交易所、模型、观察列表、当前策略这四项没做完之前,打开网页默认先到这里。')}
        </p>
      </div>
      <Workspace className="shrink-0">
        <ol className="divide-y">
          {START_STEP_ORDER.map((id, i) => {
            const state = steps[id];
            const optional = START_OPTIONAL_STEPS.includes(id);
            return (
              <li key={id} className={cn('flex gap-3 px-3 py-2.5', state === 'skipped' && 'opacity-60')} data-testid={`start-step-${id}`}>
                <StepStateIcon state={state} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="num text-[11px] text-muted-foreground">{i + 1}</span>
                    <span className={cn('text-[12.5px] font-medium', state === 'done' && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{t(STEP_TITLE[id])}</span>
                    {optional ? <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">{t('可选')}</span> : null}
                    <span className={cn('ml-auto text-[10.5px]', state === 'todo' ? 'text-warn' : state === 'done' ? 'text-up' : 'text-muted-foreground')}>{STEP_STATE_LABEL[state]}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t(STEP_DESC[id])}</p>
                  {state !== 'skipped' ? <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{actions(id, state)}</div> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </Workspace>
    </div>
  );
}
