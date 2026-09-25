/**
 * 「需要你点」(§9.19):人批 = 一次性确认 token。
 * 口径(gateway 定的):pending_approval 意图 + pending 设置提议 + recovery_ready 风控告警 + 待批记忆。普通 PROPOSE 不算。
 * 两步点击都在同一张卡上:「执行/应用」先取 token 并展示要点 + 120 秒倒计时,「确认」再带 nonce 提交;
 * 428 = 没带 nonce(不该发生),409 confirm_expired/confirm_unknown → 重取,confirm_mismatch = 内容变了 → 重取并提示。
 * reject 不需要 token。自动交易路径不经过这里。v3.10.1:默认 agent 在对话里可自批(workflow.chat_requires_approval=false),
 * 此时意图会短暂经过 pending_approval 再 approved,计数里按 principal='agent' 且 <5 秒忽略,免得红点闪。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiRequestError } from '@/api/client';
import type { ConfirmToken, DemoIntent, WorkflowProposal } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { backendLabel, directionLabel, fmtPrice, fmtQty, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t as tr, tmap } from '@/lib/i18n';

// ---------------------------------------------------------------- 计数

export interface NeedsYou {
  intents: DemoIntent[];
  proposals: WorkflowProposal[];
  recovery: { id: string; title: string }[];
  memories: number;
  total: number;
}

export function useNeedsYou(): NeedsYou {
  const intentsQ = useQuery({ queryKey: ['intents'], queryFn: () => api.intents(50), refetchInterval: 60_000, retry: false });
  const proposalsQ = useQuery({ queryKey: ['workflow', 'proposals'], queryFn: api.workflowProposals, refetchInterval: 60_000, retry: false });
  const riskQ = useQuery({ queryKey: ['risk', 'alerts', 'open'], queryFn: () => api.riskAlerts('open'), refetchInterval: 60_000, retry: false });
  const memQ = useQuery({ queryKey: ['memory', 'list', 'proposed'], queryFn: () => api.memoryList('proposed', undefined, 50), refetchInterval: 120_000, retry: false });
  const now = useNow(1000);
  const intents = (intentsQ.data ?? []).filter((i) => i.status === 'pending_approval' && !(i.principal === 'agent' && now - i.at < 5_000));
  const proposals = (proposalsQ.data?.proposals ?? []).filter((p) => p.status === 'pending');
  const recovery = (riskQ.data?.alerts ?? []).filter((a) => a.recovery_ready && (a.severity === 'high' || a.severity === 'critical')).map((a) => ({ id: a.id, title: a.title }));
  const memories = memQ.data?.counts?.proposed ?? memQ.data?.items?.length ?? 0;
  return { intents, proposals, recovery, memories, total: intents.length + proposals.length + recovery.length + memories };
}

// ---------------------------------------------------------------- 两步确认公共件

function confirmErrorText(err: unknown): { text: string; retake: boolean } {
  if (err instanceof ApiRequestError) {
    if (err.code === 'confirm_expired') return { text: tr('确认过期了(120 秒),重新取一次'), retake: true };
    if (err.code === 'confirm_unknown') return { text: tr('确认码用过了或者不存在,重新取一次'), retake: true };
    if (err.code === 'confirm_mismatch') return { text: tr('你确认之前内容变了,已经重新拉一遍,再看一眼'), retake: true };
    if (err.code === 'confirm_required') return { text: tr('少了确认码(前端 bug),重新取一次'), retake: true };
    return { text: err.message, retake: false };
  }
  return { text: err instanceof Error ? err.message : String(err), retake: false };
}

function useCountdown(expiresAt: number | null): number {
  const now = useNow(1000);
  return expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : 0;
}

/** 两步:idle → armed(拿到 token) → 提交。token 过期自动退回 idle */
function useTwoStep<T>(take: () => Promise<ConfirmToken<T>>, submit: (nonce: string) => Promise<unknown>, onDone: () => void) {
  const [token, setToken] = useState<ConfirmToken<T> | null>(null);
  const left = useCountdown(token?.expires_at ?? null);
  useEffect(() => {
    if (token && left === 0) setToken(null);
  }, [token, left]);
  const arm = useMutation({ mutationFn: take, onSuccess: setToken, onError: (e) => toast.error(tr('取不到确认码'), { description: confirmErrorText(e).text }) });
  const go = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error(tr('先点一次取确认码'));
      return submit(token.nonce);
    },
    onSuccess: () => {
      setToken(null);
      onDone();
    },
    onError: (e) => {
      const r = confirmErrorText(e);
      toast.error(tr('没执行'), { description: r.text });
      setToken(null);
      if (r.retake) arm.mutate();
    },
  });
  return { token, left, arm, go, disarm: () => setToken(null) };
}

// ---------------------------------------------------------------- 意图卡

function IntentCard({ it, showExecute }: { it: DemoIntent; showExecute: boolean }) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['intents'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };
  const step = useTwoStep(
    () => api.intentConfirmToken(it.id),
    (nonce) => api.approveIntent(it.id, nonce),
    () => {
      toast.success(tr('已确认,正在提交'));
      done();
    },
  );
  const reject = useMutation({
    mutationFn: () => api.rejectIntent(it.id),
    onSuccess: () => {
      toast.success(tr('已拒绝'));
      done();
    },
    onError: (e) => toast.error(tr('拒绝失败'), { description: e instanceof Error ? e.message : String(e) }),
  });
  const tk = step.token?.intent;
  return (
    <li className="px-3 py-2 text-[12px]">
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
          {it.kind === 'open' ? tr('开仓') : it.kind === 'close' ? tr('平仓') : tr('减仓')}
        </Badge>
        <span className="num font-semibold">{it.symbol}</span>
        <span className={cn('text-[11px]', it.direction === 'long' ? 'text-up' : 'text-down')}>{directionLabel(it.direction)}</span>
        <span className="num text-[11px] text-muted-foreground">{fmtQty(it.quantity)}</span>
        <span className="ml-auto text-[10.5px] text-muted-foreground">
          {it.principal === 'agent' ? 'agent' : tr('手动')} · {relativeTime(it.at)}
        </span>
      </div>
      <div className="num mt-0.5 text-[10.5px] text-muted-foreground">
        {it.entry === 'market' ? tr('市价') : tr('限价 {price}', { price: fmtPrice(it.limit_price) })} · {tr('止损')} {it.stop_price ? fmtPrice(it.stop_price) : '—'} · {tr('止盈')} {it.take_profit_price ? fmtPrice(it.take_profit_price) : '—'} · {backendLabel(it.backend)}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{it.sizing.note}</div>
      {it.sizing.agent ? <div className="mt-1 text-[11px] text-muted-foreground">{it.sizing.agent.applied ? tr('仓位已采用') : tr('仓位没采用')}:{it.sizing.agent.reason}</div> : null}
      {tk ? (
        <div className="mt-1.5 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px]">
          <div className="mb-1 flex items-center gap-2 text-warn">
            <span className="font-semibold">{tr('再看一遍。确认之后是真的下到 {backend}', { backend: backendLabel(tk.backend) })}</span>
            <span className="num ml-auto">{step.left}s</span>
          </div>
          <div className="num grid grid-cols-2 gap-x-3 gap-y-0.5 text-foreground">
            <span>{tr('币种')} {tk.symbol}</span>
            <span>{tr('方向')} {directionLabel(tk.direction)}</span>
            <span>{tr('数量')} {fmtQty(tk.quantity)}</span>
            <span>{tr('止损')} {tk.stop_price ? fmtPrice(tk.stop_price) : tr('无')}</span>
          </div>
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1.5">
        {showExecute ? (
          step.token ? (
            <>
              <Button size="xs" variant="destructive" disabled={step.go.isPending} onClick={() => step.go.mutate()}>
                <Check data-slot="icon" />
                {tr('确认执行')}
              </Button>
              <Button size="xs" variant="ghost" onClick={step.disarm}>
                {tr('取消')}
              </Button>
            </>
          ) : (
            <Button size="xs" variant="outline" disabled={step.arm.isPending} onClick={() => step.arm.mutate()} title={tr('第一步:取一个一次性确认码,把要点摆出来;这一步不下单')}>
              {tr('执行…')}
            </Button>
          )
        ) : (
          <span className="text-[10.5px] text-muted-foreground">{tr('这个会话关了执行按钮(会话栏里能开)')}</span>
        )}
        <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" disabled={reject.isPending} onClick={() => reject.mutate()}>
          <X data-slot="icon" />
          {tr('拒绝')}
        </Button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- 设置提议卡

const KEY_LABEL: Record<string, string> = tmap({ watchlist: '名单', watch_only: '只观察', timeframe: '周期', playbook_text: '策略说明', paused: '暂停', brain: '主脑', brain_model: '主脑模型', cheap_brain: '副脑', cheap_brain_model: '副脑模型' });

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length ? v.join(' ') : tr('(空)');
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  return JSON.stringify(v);
}

function ProposalCard({ p }: { p: WorkflowProposal }) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['workflow'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };
  const step = useTwoStep(
    () => api.proposalConfirmToken(p.id),
    (nonce) => api.applyProposal(p.id, nonce),
    () => {
      toast.success(tr('设置已应用'));
      done();
    },
  );
  const reject = useMutation({
    mutationFn: () => api.rejectProposal(p.id),
    onSuccess: () => {
      toast.success(tr('已拒绝这条提议'));
      done();
    },
    onError: (e) => toast.error(tr('拒绝失败'), { description: e instanceof Error ? e.message : String(e) }),
  });
  const keys = Object.keys(p.patch);
  const left = useCountdown(p.expires_at);
  return (
    <li className="px-3 py-2 text-[12px]">
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
          {tr('设置提议')}
        </Badge>
        <span className="text-[11px]">{keys.map((k) => KEY_LABEL[k] ?? k).join(' · ')}</span>
        <span className="ml-auto text-[10.5px] text-muted-foreground" title={tr('{ago}提的', { ago: relativeTime(p.created_at) })}>
          {left > 0 ? tr('{n} 分钟后失效', { n: Math.floor(left / 60) }) : tr('已失效')}
        </span>
      </div>
      <table className="num mt-1 w-full text-[10.5px]">
        <tbody>
          {keys.map((k) => (
            <tr key={k} className="align-top">
              <td className="w-16 py-0.5 text-muted-foreground">{KEY_LABEL[k] ?? k}</td>
              <td className="py-0.5 text-muted-foreground line-through">{fmtVal(p.before[k])}</td>
              <td className="py-0.5 pl-2 text-foreground">{fmtVal(p.after[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.errors.length ? <div className="mt-1 text-[10.5px] text-down">{p.errors.join(';')}</div> : null}
      {step.token ? (
        <div className="mt-1 flex items-center gap-2 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
          <span>{tr('再点一次就写进工作流')}</span>
          <span className="num ml-auto">{step.left}s</span>
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1.5">
        {step.token ? (
          <>
            <Button size="xs" variant="default" disabled={step.go.isPending} onClick={() => step.go.mutate()}>
              <Check data-slot="icon" />
              {tr('确认应用')}
            </Button>
            <Button size="xs" variant="ghost" onClick={step.disarm}>
              {tr('取消')}
            </Button>
          </>
        ) : (
          <Button size="xs" variant="outline" disabled={step.arm.isPending || p.errors.length > 0} onClick={() => step.arm.mutate()}>
            {tr('应用…')}
          </Button>
        )}
        <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" disabled={reject.isPending} onClick={() => reject.mutate()}>
          <X data-slot="icon" />
          {tr('拒绝')}
        </Button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- 列表 + 顶栏计数

/** 09-20:几条「确认恢复」一键全关(网关只关 recovery_ready 的,条件还在的不动)。 */
function RecoverAllRow({ n }: { n: number }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: api.recoverAllRisk,
    onSuccess: (res) => { toast.success(tr('已确认恢复 {n} 条', { n: res.resolved.length })); void qc.invalidateQueries({ queryKey: ['risk'] }); void qc.invalidateQueries({ queryKey: ['overview'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
      <span className="min-w-0 flex-1">{tr('{n} 条风控告警的成因已消失', { n })}</span>
      <Button size="xs" variant="outline" disabled={m.isPending} onClick={() => m.mutate()}>{tr('全部确认恢复')}</Button>
    </li>
  );
}

export function ApprovalsList({ data, showExecute = true, className }: { data: NeedsYou; showExecute?: boolean; className?: string }) {
  if (data.total === 0) return <div className={cn('px-3 py-4 text-center text-[11.5px] text-muted-foreground', className)}>{tr('没有要你点的东西。自动交易不走这儿。')}</div>;
  return (
    <ul className={cn('divide-y', className)}>
      {data.intents.map((it) => (
        <IntentCard key={it.id} it={it} showExecute={showExecute} />
      ))}
      {data.proposals.map((p) => (
        <ProposalCard key={p.id} p={p} />
      ))}
      {data.recovery.length > 1 ? <RecoverAllRow n={data.recovery.length} /> : null}
      {data.recovery.map((r) => (
        <li key={r.id} className="flex items-center gap-2 px-3 py-2 text-[12px]">
          <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-down">
            {tr('风控')}
          </Badge>
          <span className="min-w-0 flex-1 truncate">{r.title}</span>
          <a href="#floor?sel=risk_sentinel" className="shrink-0 text-[11px] text-primary hover:underline">
            {tr('去确认恢复 →')}
          </a>
        </li>
      ))}
      {data.memories ? (
        <li className="flex items-center gap-2 px-3 py-2 text-[12px]">
          <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
            {tr('记忆')}
          </Badge>
          <span className="min-w-0 flex-1">{tr('{n} 条记忆提案等你批', { n: data.memories })}</span>
          <a href="#memory" className="shrink-0 text-[11px] text-primary hover:underline">
            {tr('去记忆页 →')}
          </a>
        </li>
      ) : null}
    </ul>
  );
}

/** 顶栏常驻:红色计数,点开就是清单;0 时灰 */
export function NeedsYouBadge() {
  const data = useNeedsYou();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={tr('要你点的:待批意图、设置提议、风控确认恢复、记忆提案。普通出策略不算,自动交易也不走这儿;默认 agent 在对话里自己批,设置页开了「对话执行需我确认」才会有意图进来。')}
          className={cn('flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors aria-expanded:bg-muted', data.total ? 'border-destructive/50 bg-destructive/10 font-semibold text-destructive' : 'border-transparent text-muted-foreground hover:border-border')}
        >
          <BellRing className="size-3.5" />
          <span className="num">{data.total}</span>
          <span className="hidden lg:inline">{tr('需要你点')}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[420px] p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="text-[12px] font-semibold">{tr('需要你点')}</span>
          <span className="text-[10.5px] text-muted-foreground">{tr('两步确认,120 秒内有效')}</span>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          <ApprovalsList data={data} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
