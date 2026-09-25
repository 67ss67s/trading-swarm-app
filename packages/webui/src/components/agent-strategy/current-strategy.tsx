/**
 * Agent 当前策略(§9.54):胶囊 + 切换弹层 + 楼层桌上的策略片。
 * 胶囊放在 Agent 页顶部与楼层顶栏;切换在弹层里选「自由判断」或我的策略,选中后先看运行预检再一键切。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Check, ChevronDown, Cpu, Sparkles, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { BindingRole, BindingRoleSlice } from '@trading-swarm/contracts';
import { researchApi, strategyRunsApi } from '@/api/client';
import { DESK_SLICES, useAgentStrategy, useSetAgentStrategy, type AgentStrategyView, type RoleEngine } from '@/api/agent-strategy';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

const ENGINE_TEXT: Record<RoleEngine, string> = tmap({ code: '代码', decision: '决策模型', llm: 'LLM' });
const RUN_TEXT: Record<string, string> = tmap({ running: '运行中', paused: '已暂停', stopped: '已停止', error: '出错' });
const MODE_TEXT: Record<string, string> = tmap({ agent: 'Agent 把关', auto: '自动下单', confirm: '每笔我确认' });

/** 胶囊:当前是自由判断还是哪条策略;点开切换 */
export function CurrentStrategyChip({ className }: { className?: string }) {
  const q = useAgentStrategy();
  const [open, setOpen] = useState(false);
  const v = q.data;
  const live = v?.kind === 'strategy' && v.run_status === 'running';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn('inline-flex max-w-72 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors hover:bg-muted', className)}
        title={t('切换 agent 当前策略')}
      >
        {v?.kind === 'strategy' ? <Sparkles className="size-3.5 shrink-0 text-primary" /> : <Bot className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="text-muted-foreground">{t('当前策略')}</span>
        <span className="truncate font-medium">{!v ? '…' : v.kind === 'free' ? t('自由判断') : `${v.name ?? v.strategy_id} v${v.version}`}</span>
        {v?.kind === 'strategy' ? <span className={cn('size-1.5 shrink-0 rounded-full', live ? 'bg-up' : 'bg-muted-foreground')} /> : null}
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </button>
      {open ? <SwitchDialog current={v ?? null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SwitchDialog({ current, onClose }: { current: AgentStrategyView | null; onClose: () => void }) {
  const [pick, setPick] = useState<string | 'free'>(current?.kind === 'strategy' ? current.strategy_id! : 'free');
  const [mode, setMode] = useState<'agent' | 'auto' | 'confirm'>((current?.mode as 'agent' | 'auto' | 'confirm' | null) ?? 'agent');
  const [live, setLive] = useState('');
  const list = useQuery({ queryKey: ['my-strategies', 'switch'], queryFn: () => researchApi.myStrategies({ sort: 'updated' }) });
  const pf = useQuery({ queryKey: ['strategy-run-preflight', pick], queryFn: () => strategyRunsApi.preflight(pick), enabled: pick !== 'free' });
  const set = useSetAgentStrategy();
  const strategies = (list.data?.strategies ?? []).filter((s) => s.status !== 'archived' && s.current_version > 0);
  const needLive = pick !== 'free' && !!pf.data?.requires_live_confirm;
  const blocked = pick !== 'free' && (!pf.data || !pf.data.deployable);
  const submit = () => set.mutate(pick === 'free' ? { kind: 'free' } : { kind: 'strategy', strategy_id: pick, mode, ...(needLive ? { confirm: live } : {}) }, {
    onSuccess: (v) => { toast.success(v.kind === 'free' ? t('已切到自由判断') : t('已切到「{name}」', { name: v.name ?? '' })); onClose(); },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Agent 当前策略')}</DialogTitle>
          <DialogDescription>{t('选一条策略后,agent 只按这条策略开仓;自由判断线只复查已有持仓。切回自由判断会停掉策略运行,已开仓位按原版本规则退出。')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          <Option active={pick === 'free'} onClick={() => setPick('free')} title={t('自由判断')} sub={t('playbook + 模型判断,不绑定策略')} />
          {list.isLoading ? <p className="px-2 py-1 text-[12px] text-muted-foreground">{t('加载我的策略…')}</p> : null}
          {strategies.map((s) => (
            <Option key={s.id} active={pick === s.id} onClick={() => setPick(s.id)} title={s.name} sub={`v${s.current_version} · ${s.symbol} · ${s.timeframe}${s.summary?.score_label ? ` · ${s.summary.score_label}` : ''}`} />
          ))}
        </div>
        {pick !== 'free' ? (
          <div className="space-y-2 rounded-md border p-2 text-[12px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">{t('运行方式')}</span>
              {(['agent', 'auto', 'confirm'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} className={cn('rounded-full border px-2 py-0.5', mode === m ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted')}>{MODE_TEXT[m]}</button>
              ))}
              {pf.data ? <span className="ml-auto text-muted-foreground">{t('下单到')}:{pf.data.execution.label}</span> : null}
            </div>
            {pf.isLoading ? <p className="text-muted-foreground">{t('预检中…')}</p> : null}
            {pf.data?.blockers.map((b) => <p key={b.code} className="flex gap-1 text-destructive"><TriangleAlert className="mt-0.5 size-3 shrink-0" />{b.message}</p>)}
            {pf.data?.warnings.slice(0, 3).map((w) => <p key={w.code} className="flex gap-1 text-muted-foreground"><TriangleAlert className="mt-0.5 size-3 shrink-0" />{w.message}</p>)}
            {needLive ? <Input value={live} onChange={(e) => setLive(e.target.value)} placeholder={t('实盘:输入 LIVE 确认')} className="h-8" /> : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('取消')}</Button>
          <Button onClick={submit} disabled={set.isPending || blocked || (needLive && live !== 'LIVE')}>{set.isPending ? t('切换中…') : t('切换')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Option({ active, onClick, title, sub }: { active: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left', active ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted')}>
      <Check className={cn('size-3.5 shrink-0', active ? 'text-primary' : 'invisible')} />
      <span className="min-w-0">
        <span className="block truncate text-[13px]">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
      </span>
    </button>
  );
}

/** 楼层角色桌上的策略片:该桌从当前策略 binding 拿到的规则 + 谁在执行 */
export function DeskStrategySlices({ desk, view }: { desk: string; view: AgentStrategyView | null | undefined }) {
  const roles = DESK_SLICES[desk];
  if (!roles || !view) return null;
  if (view.kind === 'free') return <p className="text-[11px] text-muted-foreground">{t('自由判断(playbook)')}</p>;
  const slices = roles.map((r) => view.slices.find((s) => s.role === r)).filter((s): s is BindingRoleSlice => !!s);
  if (!slices.length) return <p className="text-[11px] text-muted-foreground">{t('当前策略没有分给这张桌的规则')}</p>;
  return (
    <div className="space-y-2">
      {slices.map((s) => <SliceBlock key={s.role} slice={s} engine={view.role_engines[s.role as BindingRole] ?? 'code'} />)}
    </div>
  );
}

function SliceBlock({ slice, engine }: { slice: BindingRoleSlice; engine: RoleEngine }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1 text-[12px] font-medium">
        {slice.title}
        <span className={cn('ml-auto inline-flex items-center gap-0.5 rounded-full border px-1.5 text-[10px] font-normal', engine === 'code' ? 'text-muted-foreground' : 'border-primary/40 text-primary')}>
          <Cpu className="size-2.5" />{ENGINE_TEXT[engine]}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">{slice.summary}</p>
      <ul className="list-disc space-y-0.5 pl-4 text-[11px]">
        {slice.rules.slice(0, 5).map((r, i) => <li key={i}>{r.text}</li>)}
      </ul>
    </div>
  );
}

export { RUN_TEXT };

/** 「我的策略」详情页的主按钮:把这条策略设为 agent 当前策略(缺省 agent 模式;实盘通道走切换弹层输入 LIVE) */
export function SetAgentStrategyButton({ strategyId, version, disabled }: { strategyId: string; version: number; disabled?: boolean }) {
  const q = useAgentStrategy();
  const set = useSetAgentStrategy();
  const current = q.data?.kind === 'strategy' && q.data.strategy_id === strategyId;
  if (current) {
    return <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 px-2 py-0.5 text-[12px] text-primary"><Sparkles className="size-3.5" />{t('已是 agent 当前策略')}</span>;
  }
  return (
    <Button size="sm" variant="outline" className="gap-1" disabled={disabled || set.isPending || !version}
      onClick={() => set.mutate({ kind: 'strategy', strategy_id: strategyId, version, mode: 'agent' }, {
        onSuccess: () => toast.success(t('agent 已切到这条策略')),
        onError: (e) => toast.error((e as Error).message),
      })}>
      <Sparkles className="size-3.5" />{set.isPending ? t('切换中…') : t('设为 agent 当前策略')}
    </Button>
  );
}
