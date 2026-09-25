/**
 * 「发布」栏(卖方侧,设计 §3):ASP 身份与服务 / 订阅者与收入 / 发布器设置 / 投递账本 / 售后待办 / 公开战绩。
 * 没有 ASP 身份时整栏是一张注册表单(pre-check → validate-listing → upload → create → activate)。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, Megaphone, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { MarketAftersale, MarketAsp, MarketDeliveryOut, MarketPricing, MarketPublisherSettings, MarketRegisterForm, MarketValidateFinding } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';
import { AFTERSALE_STATUS_LABEL, EmptyNote, ErrorNote, SUB_STATUS_LABEL, fmtServicePrice, fmtTrial, fmtUsdt, shortId, subStatusClass } from './shared';

const PRICING_LABEL: Record<MarketPricing, string> = tmap({
  per_call: '按次收费',
  monthly: '月订阅',
  monthly_trial: '月订阅 + 72 小时试用',
});

const EMPTY_FORM: MarketRegisterForm = {
  name: '',
  description: '',
  service_name: '',
  service_type: 'A2A',
  pricing: 'monthly_trial',
  fee: '0',
  service_description: '',
};

// ---------------------------------------------------------------------------
// 注册表单

function Findings({ items }: { items: MarketValidateFinding[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {items.map((f, i) => (
        <div key={i} className={cn('rounded border px-2 py-1 text-[11px]', f.severity === 'block' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-warn/40 bg-warn/10 text-warn')}>
          <span className="font-medium">{f.field}</span> · {f.code} · {f.message}
        </div>
      ))}
    </div>
  );
}

function RegisterForm({ onRegistered }: { onRegistered: () => void }) {
  const [form, setForm] = useState<MarketRegisterForm>(EMPTY_FORM);
  const [avatar, setAvatar] = useState<File | null>(null);
  const [findings, setFindings] = useState<MarketValidateFinding[]>([]);
  const [validated, setValidated] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const set = <K extends keyof MarketRegisterForm>(k: K, v: MarketRegisterForm[K]) => {
    setValidated(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const validate = useMutation({
    mutationFn: () => api.marketAspValidate(form),
    onSuccess: (r) => {
      setFindings(r.findings);
      setValidated(r.pass);
      r.pass ? toast.success(t('校验通过')) : toast.error(t('有必须修的问题'));
    },
    onError: (err) => toast.error(t('校验失败'), { description: err instanceof Error ? err.message : String(err) }),
  });
  const register = useMutation({
    mutationFn: () => api.marketAspRegister(form, avatar!),
    onSuccess: (r) => {
      setConfirmOpen(false);
      if (!r.ok) {
        if (r.findings) setFindings(r.findings);
        toast.error(t('注册失败'), { description: r.message ?? undefined });
        return;
      }
      toast.success(t('ASP 身份已注册:#{id}', { id: r.agent_id ?? '?' }), { description: t('还没对外可见,点「上架」发布') });
      onRegistered();
    },
    onError: (err) => toast.error(t('注册失败'), { description: err instanceof Error ? err.message : String(err) }),
  });
  const blocks = findings.filter((f) => f.severity === 'block').length;
  const canRegister = validated && blocks === 0 && avatar !== null;

  return (
    <div className="flex flex-col gap-4 p-4 text-[12px]">
      <div className="rounded border bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
        {t('注册一个 ASP(卖家)身份 = 在 XLayer 上给这个钱包铸一个 ERC-8004 身份,OKX 付 gas,一钱包一 ASP。名称 CN 2–12 / EN 3–25 字,描述 ≤ 500 字,头像必须是图片文件;不能有链接、名人名、「保证收益」类措辞(OKX 的 QA 会拦)。')}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>{t('品牌名')}</Label>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} className="h-7 text-[11.5px]" placeholder="trading-swarm" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('头像(图片文件)')}</Label>
          <Input type="file" accept="image/*" onChange={(e) => setAvatar(e.target.files?.[0] ?? null)} className="h-7 text-[11.5px]" />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label>{t('身份描述(≤ 500 字)')}</Label>
          <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} className="text-[12px]" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('服务名(5–30 字,名词短语)')}</Label>
          <Input value={form.service_name} onChange={(e) => set('service_name', e.target.value)} className="h-7 text-[11.5px]" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('类型')}</Label>
          <Input value="A2A" disabled className="h-7 text-[11.5px]" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('定价')}</Label>
          <Select value={form.pricing} onValueChange={(v) => set('pricing', v as MarketPricing)}>
            <SelectTrigger className="h-7 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PRICING_LABEL) as MarketPricing[]).map((p) => (
                <SelectItem key={p} value={p} className="text-[12px]">
                  {PRICING_LABEL[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{form.pricing === 'per_call' ? t('每次费用(USDT,0 = 免费)') : t('每月费用(USDT,0 = 免费)')}</Label>
          <Input value={form.fee} onChange={(e) => set('fee', e.target.value)} type="number" min={0} step={0.01} className="h-7 text-[11.5px]" />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label>{t('服务描述(三段:核心能力 / 买家需提供 / 交付说明)')}</Label>
          <Textarea value={form.service_description} onChange={(e) => set('service_description', e.target.value)} rows={6} className="text-[12px]" placeholder={t('[核心能力] … \n[买家需提供] … \n[交付说明] 每条信号一段人话 + 一个 JSON(symbol/action/price/stop_loss/take_profit/valid_until),order 可跟、analysis 仅参考;附线程真实结算 R。')} />
        </div>
      </div>
      <Findings items={findings} />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={validate.isPending} onClick={() => validate.mutate()}>
          <ShieldCheck data-slot="icon" />
          {t('校验(OKX QA)')}
        </Button>
        <Button size="sm" disabled={!canRegister || register.isPending} onClick={() => setConfirmOpen(true)}>
          {t('注册 ASP 身份')}
        </Button>
        {!avatar ? <span className="text-[10.5px] text-muted-foreground">{t('先选头像')}</span> : null}
      </div>
      <ConfirmDialog open={confirmOpen} title={t('在 XLayer 上注册 ASP 身份?')} summary={t('链上写入')} busy={register.isPending} onCancel={() => setConfirmOpen(false)} onConfirm={() => register.mutate()}>
        <p>{t('会以「{name}」注册一个 ASP 身份并挂一个服务「{svc}」({pricing},{fee} USDT)。OKX 付 gas;注册后要再点「上架」才对外可见。', { name: form.name, svc: form.service_name, pricing: PRICING_LABEL[form.pricing], fee: form.fee })}</p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 发布器设置

function PublisherSettings({ value, onSave, saving }: { value: MarketPublisherSettings; onSave: (v: MarketPublisherSettings) => void; saving: boolean }) {
  const [symbols, setSymbols] = useState(value.symbols.join(', '));
  const commitSymbols = () => {
    const list = symbols
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (list.join(',') !== value.symbols.join(',')) onSave({ ...value, symbols: list });
  };
  const Row = ({ label, k, hint }: { label: string; k: keyof MarketPublisherSettings; hint?: string }) => (
    <label className="flex items-center justify-between gap-3 text-[11.5px]">
      <span>
        {label}
        {hint ? <span className="ml-1 text-[10.5px] text-muted-foreground">{hint}</span> : null}
      </span>
      <Switch className="scale-90" checked={Boolean(value[k])} disabled={saving} onCheckedChange={(v) => onSave({ ...value, [k]: v })} />
    </label>
  );
  return (
    <div className="flex flex-col gap-2 p-3">
      <Row label={t('发布器总开关')} k="enabled" hint={value.enabled ? t('每条事件对全部活跃订阅者逐户投递') : t('关着:什么都不发,账本照记')} />
      <Row label={t('发 order(线程真实开/平/减仓)')} k="publish_orders" />
      <Row label={t('发 analysis(agent 有方向但没开仓的判断)')} k="publish_analysis" />
      <Row label={t('纸面线程允许以 analysis 发出')} k="allow_paper_analysis" hint={t('永远标 paper:true,绝不当 order')} />
      <Row label={t('平仓信号附真实结算 R')} k="include_realized_pnl" />
      <div className="flex items-center gap-2 text-[11.5px]">
        <span className="shrink-0">{t('只发这些币')}</span>
        <Input value={symbols} onChange={(e) => setSymbols(e.target.value)} onBlur={commitSymbols} placeholder={t('空 = 全部;逗号分开,如 BTCUSDT, ETHUSDT')} className="h-7 text-[11.5px]" />
      </div>
      <p className="text-[10.5px] text-muted-foreground">{t('永远不发:买来的 ASP 信号、纸面 order、含「保证/稳赚」类词的文本。失败不自动重试,在投递账本里逐户重发。')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 投递账本

function DeliveryRow({ d, now, onRetry, retrying }: { d: MarketDeliveryOut; now: number; onRetry: (jobId?: string) => void; retrying: boolean }) {
  const [open, setOpen] = useState(false);
  const delivered = d.jobs.filter((j) => j.status === 'delivered').length;
  const failed = d.jobs.filter((j) => j.status === 'failed').length;
  const pending = d.jobs.filter((j) => j.status === 'pending').length;
  return (
    <div className="border-b px-3 py-2 text-[11.5px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground" title={fmtDateTime(d.created_at)}>
          {relativeTime(d.created_at, now)}
        </span>
        <Badge variant="outline" className={cn('text-[10px]', d.signal_type === 'order' ? 'border-primary/40 text-primary' : 'text-muted-foreground')}>
          {d.signal_type}
        </Badge>
        <span className="num font-medium">{d.symbol}</span>
        <span className="text-muted-foreground">{d.action}</span>
        {d.thread_id ? <span className="num text-[10.5px] text-muted-foreground">{d.thread_id.slice(0, 10)}</span> : null}
        {d.blocked_reason ? (
          <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive" title={d.blocked_reason}>
            {t('已拦下')}
          </Badge>
        ) : (
          <span className="text-muted-foreground">
            <span className="num text-up">{delivered}</span> {t('成功')}
            {failed ? (
              <>
                {' '}
                · <span className="num text-down">{failed}</span> {t('失败')}
              </>
            ) : null}
            {pending ? (
              <>
                {' '}
                · <span className="num">{pending}</span> {t('待发')}
              </>
            ) : null}
            {d.jobs.length === 0 ? <span> · {t('当时没有订阅者')}</span> : null}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {failed ? (
            <Button size="xs" variant="outline" disabled={retrying} onClick={() => onRetry()}>
              {t('重发失败户')}
            </Button>
          ) : null}
          <button className="text-primary underline-offset-2 hover:underline" onClick={() => setOpen((v) => !v)}>
            {open ? t('收起') : t('展开')}
          </button>
        </div>
      </div>
      {d.blocked_reason ? <p className="mt-1 text-[10.5px] text-destructive">{d.blocked_reason}</p> : null}
      {open ? (
        <div className="mt-2 flex flex-col gap-2">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/30 p-2 text-[10.5px]">{d.text}</pre>
          {d.jobs.length ? (
            <div className="flex flex-col gap-1">
              {d.jobs.map((j) => (
                <div key={j.job_id} className="flex flex-wrap items-center gap-2 text-[10.5px]">
                  <span className="num text-muted-foreground" title={j.job_id}>
                    job {shortId(j.job_id, 6, 4)}
                  </span>
                  {j.buyer_agent_id ? <span className="num text-muted-foreground">#{j.buyer_agent_id}</span> : null}
                  <Badge variant="outline" className={cn('text-[10px]', j.status === 'delivered' ? 'text-up' : j.status === 'failed' ? 'text-down' : 'text-muted-foreground')}>
                    {j.status === 'delivered' ? t('已投递') : j.status === 'failed' ? t('失败') : t('待发')}
                  </Badge>
                  {j.attempt > 1 ? <span className="text-muted-foreground">×{j.attempt}</span> : null}
                  {j.error ? <span className="truncate text-down">{j.error}</span> : null}
                  {j.status === 'failed' ? (
                    <Button size="xs" variant="ghost" disabled={retrying} onClick={() => onRetry(j.job_id)}>
                      {t('重发')}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 售后

function AftersaleRow({ a, now, onDecide, busy }: { a: MarketAftersale; now: number; onDecide: (decision: 'agree_refund' | 'dispute') => void; busy: boolean }) {
  return (
    <div className="flex flex-col gap-1 border-b px-3 py-2 text-[11.5px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn('text-[10px]', a.status === 'pending' ? 'border-warn/40 text-warn' : 'text-muted-foreground')}>
          {AFTERSALE_STATUS_LABEL[a.status]}
        </Badge>
        <span>{t('买家拒收')}</span>
        {a.buyer_agent_id ? <span className="num text-muted-foreground">#{a.buyer_agent_id}</span> : null}
        <span className="num text-muted-foreground" title={a.job_id}>
          job {shortId(a.job_id, 6, 4)}
        </span>
        {a.period_index !== null ? <span className="text-muted-foreground">{t('第 {n} 期', { n: a.period_index })}</span> : null}
        {a.deadline_at && a.status === 'pending' ? (
          <span className={cn('ml-auto', a.deadline_at - now < 6 * 3_600_000 ? 'text-down' : 'text-muted-foreground')} title={fmtDateTime(a.deadline_at)}>
            {t('截止')} {relativeTime(a.deadline_at, now)}
          </span>
        ) : null}
      </div>
      {a.reason ? <p className="whitespace-pre-line text-[11px] text-muted-foreground">{a.reason}</p> : null}
      {a.status === 'pending' ? (
        <div className="flex items-center gap-2 pt-0.5">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => onDecide('agree_refund')}>
            {t('同意退款')}
          </Button>
          <Button size="xs" variant="destructive" disabled={busy} onClick={() => onDecide('dispute')}>
            {t('提争议')}
          </Button>
          <span className="text-[10.5px] text-muted-foreground">{t('超时不处理 = 自动退款')}</span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PublishTab() {
  const qc = useQueryClient();
  const now = useNow();
  const q = useQuery({ queryKey: ['market', 'asp'], queryFn: api.marketAsp, refetchInterval: 60_000 });
  const delivQ = useQuery({ queryKey: ['market', 'asp', 'deliveries'], queryFn: () => api.marketAspDeliveries(100), refetchInterval: 30_000, enabled: !!q.data?.identity });
  const [preview, setPreview] = useState<{ text: string; blocked: string | null } | null>(null);
  const [disputeTarget, setDisputeTarget] = useState<MarketAftersale | null>(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [deactivateOpen, setDeactivateOpen] = useState(false);

  const put = (r: MarketAsp) => qc.setQueryData(['market', 'asp'], r);
  const fail = (msg: string) => (err: unknown) => toast.error(msg, { description: err instanceof Error ? err.message : String(err) });
  const saveSettings = useMutation({
    mutationFn: (publisher: MarketPublisherSettings) => api.setMarketSettings({ publisher }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['market', 'asp'] });
      void qc.invalidateQueries({ queryKey: ['market', 'status'] });
      toast.success(t('已保存'));
    },
    onError: fail(t('保存失败')),
  });
  const activate = useMutation({ mutationFn: api.marketAspActivate, onSuccess: (r) => (put(r), toast.success(t('已上架,市场上可见'))), onError: fail(t('上架失败')) });
  const deactivate = useMutation({
    mutationFn: api.marketAspDeactivate,
    onSuccess: (r) => {
      put(r);
      setDeactivateOpen(false);
      toast.success(t('已下架'));
    },
    onError: fail(t('下架失败')),
  });
  const claim = useMutation({ mutationFn: api.marketAspClaim, onSuccess: (r) => (put(r), void qc.invalidateQueries({ queryKey: ['market', 'status'] }), toast.success(t('已领取到 Agentic Wallet'))), onError: fail(t('领取失败')) });
  const decide = useMutation({
    mutationFn: (a: { jobId: string; decision: 'agree_refund' | 'dispute'; reason?: string }) => api.marketAspAftersale(a.jobId, { decision: a.decision, reason: a.reason }),
    onSuccess: (r) => {
      put(r);
      setDisputeTarget(null);
      setDisputeReason('');
      toast.success(t('已提交'));
    },
    onError: fail(t('操作失败')),
  });
  const retry = useMutation({
    mutationFn: (a: { eventId: string; jobId?: string }) => api.marketAspRetryDelivery(a.eventId, a.jobId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['market', 'asp', 'deliveries'] });
      toast.success(t('已重发'));
    },
    onError: fail(t('重发失败')),
  });
  const previewM = useMutation({
    mutationFn: api.marketAspPreview,
    onSuccess: (r) => setPreview({ text: r.text, blocked: r.blocked_reason }),
    onError: fail(t('渲染失败')),
  });

  const asp = q.data ?? null;
  const pendingAftersales = useMemo(() => (asp?.aftersales ?? []).filter((a) => a.status === 'pending'), [asp]);

  if (q.isLoading) {
    return (
      <Workspace className="shrink-0 p-3">
        <Skeleton className="h-40 w-full" />
      </Workspace>
    );
  }
  if (q.isError) {
    return (
      <Workspace className="shrink-0">
        <ErrorNote err={q.error} />
      </Workspace>
    );
  }
  if (!asp?.identity) {
    return (
      <Workspace className="shrink-0">
        <Pane title={t('发布')} hint={t('这个钱包还没有 ASP 身份;注册后 agent 的判断与线程动作才能作为信号卖出去')}>
          {asp?.error ? <div className="border-b bg-warn/10 px-3 py-1 text-[10.5px] text-warn">{asp.error}</div> : null}
          <RegisterForm onRegistered={() => void qc.invalidateQueries({ queryKey: ['market'] })} />
        </Pane>
      </Workspace>
    );
  }

  const id = asp.identity;
  const tr = asp.track_record;
  const isActive = id.status === 'active';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Workspace className="shrink-0">
        <div className="grid grid-cols-1 divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          {/* 身份与服务 */}
          <Pane
            title={t('ASP 身份')}
            hint={isActive ? t('市场上可见') : t('未上架')}
            actions={
              isActive ? (
                <Button size="xs" variant="outline" onClick={() => setDeactivateOpen(true)} disabled={deactivate.isPending}>
                  {t('下架')}
                </Button>
              ) : (
                <Button size="xs" onClick={() => activate.mutate()} disabled={activate.isPending}>
                  <Megaphone data-slot="icon" />
                  {t('上架')}
                </Button>
              )
            }
          >
            <div className="flex flex-col gap-2 p-3 text-[11.5px]">
              <div className="flex items-center gap-3">
                {id.avatar ? <img alt="" src={id.avatar} className="size-10 rounded-md border object-cover" /> : <div className="size-10 rounded-md border bg-muted" />}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold">{id.name}</span>
                    <span className="num text-[10.5px] text-muted-foreground">#{id.agent_id}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {id.status}
                    </Badge>
                    {id.approval ? (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        {id.approval}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="text-[10.5px] text-muted-foreground">
                    {id.rating ?? t('暂无评分')} · {t('已售 {n}', { n: id.sold_count })}
                  </div>
                </div>
              </div>
              {asp.services.map((s) => (
                <div key={s.service_id} className="rounded border bg-muted/20 px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{s.service_name}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {s.service_type}
                    </Badge>
                    <span className="num">{fmtServicePrice(s)}</span>
                    {fmtTrial(s) ? (
                      <Badge variant="outline" className="border-up/40 text-[10px] text-up">
                        {fmtTrial(s)}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-[10.5px] text-muted-foreground">{s.service_description}</p>
                </div>
              ))}
              {asp.services.length === 0 ? <span className="text-[10.5px] text-muted-foreground">{t('没有服务;去 Claude 里说「给 #{id} 加一个服务」', { id: id.agent_id })}</span> : null}
            </div>
          </Pane>

          {/* 订阅者与收入 */}
          <Pane
            title={t('订阅者 · 收入')}
            hint={t('{a} 个活跃(扇出集合)/ 共 {n}', { a: asp.active_count, n: asp.subscribers.length })}
            actions={
              <Button size="xs" variant="outline" disabled={claim.isPending || !asp.claimable.amount || Number(asp.claimable.amount) <= 0} onClick={() => claim.mutate()}>
                <Coins data-slot="icon" />
                {t('领取到钱包')}
              </Button>
            }
          >
            <div className="flex flex-col gap-2 p-3 text-[11.5px]">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-muted-foreground">
                  {t('可领收入')} <span className="num text-foreground">{fmtUsdt(asp.claimable.amount)}</span>
                </span>
                <span className="text-muted-foreground">
                  {t('近 {d} 天')} order <span className="num text-foreground">{tr.orders}</span> · {t('平仓')} <span className="num text-foreground">{tr.closes}</span> · {t('胜')}{' '}
                  <span className="num text-foreground">{tr.wins}</span> · ΣR{' '}
                  <span className="num text-foreground">{tr.realized_r_sum === null ? '—' : `${tr.realized_r_sum >= 0 ? '+' : ''}${tr.realized_r_sum.toFixed(2)}`}</span>
                </span>
                {asp.claimable.error ? <span className="text-[10.5px] text-warn">{asp.claimable.error}</span> : null}
              </div>
              <p className="text-[10.5px] text-muted-foreground">{t('续费到账时代码自动领上一期收入;这里的按钮领全部未领的。')}</p>
              <ScrollArea className="max-h-40">
                {asp.subscribers.length === 0 ? (
                  <EmptyNote>{t('还没有订阅者。')}</EmptyNote>
                ) : (
                  asp.subscribers.map((s) => (
                    <div key={s.job_id} className="flex flex-wrap items-center gap-2 border-b py-1 text-[11px] last:border-b-0">
                      <span className="num">#{s.buyer_agent_id}</span>
                      {s.buyer_name ? <span className="text-muted-foreground">{s.buyer_name}</span> : null}
                      <Badge variant="outline" className={cn('text-[10px]', subStatusClass(s.status_name))}>
                        {SUB_STATUS_LABEL[s.status_name] ?? s.status_name}
                      </Badge>
                      {s.active ? (
                        <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
                          {t('扇出中')}
                        </Badge>
                      ) : null}
                      <span className="ml-auto text-muted-foreground" title={s.sub_end_time ? fmtDateTime(s.sub_end_time) : ''}>
                        {s.period_index !== null ? t('第 {n} 期', { n: s.period_index }) : ''} {s.sub_end_time ? `· ${relativeTime(s.sub_end_time, now)}` : ''}
                      </span>
                    </div>
                  ))
                )}
              </ScrollArea>
            </div>
          </Pane>

          {/* 发布器 */}
          <Pane
            title={t('发布器')}
            hint={asp.publisher_state.last_publish_at ? t('上次 {ago} · 事件 {e} · 成功 {d} · 失败 {f}', { ago: relativeTime(asp.publisher_state.last_publish_at, now), e: asp.publisher_state.events, d: asp.publisher_state.delivered, f: asp.publisher_state.failed }) : t('还没发过')}
            actions={
              <Button size="xs" variant="outline" disabled={previewM.isPending} onClick={() => previewM.mutate()} title={t('渲染一条示例投递,不真发')}>
                <Send data-slot="icon" />
                {t('预览一条')}
              </Button>
            }
          >
            <PublisherSettings value={asp.publisher} onSave={(v) => saveSettings.mutate(v)} saving={saveSettings.isPending} />
          </Pane>
        </div>
      </Workspace>

      {pendingAftersales.length || (asp.aftersales.length ?? 0) ? (
        <Workspace className="shrink-0">
          <Pane title={t('售后')} hint={pendingAftersales.length ? t('{n} 条待处理,约一天内要回应', { n: pendingAftersales.length }) : t('没有待处理')}>
            <ScrollArea className="max-h-56">
              {asp.aftersales.map((a) => (
                <AftersaleRow
                  key={a.id}
                  a={a}
                  now={now}
                  busy={decide.isPending}
                  onDecide={(d) => (d === 'dispute' ? setDisputeTarget(a) : decide.mutate({ jobId: a.job_id, decision: 'agree_refund' }))}
                />
              ))}
            </ScrollArea>
          </Pane>
        </Workspace>
      ) : null}

      <Workspace className="flex min-h-0 flex-1 flex-col">
        <Pane
          title={t('投递账本')}
          hint={t('每个事件一条主记录,逐户结果展开看;失败不自动重试')}
          className="min-h-0 flex-1"
          contentClassName="flex min-h-0 flex-col"
          actions={
            <Button size="xs" variant="outline" onClick={() => void delivQ.refetch()} disabled={delivQ.isFetching}>
              <RefreshCw data-slot="icon" className={cn(delivQ.isFetching && 'animate-spin')} />
            </Button>
          }
        >
          {delivQ.isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : delivQ.isError ? (
            <ErrorNote err={delivQ.error} />
          ) : (delivQ.data?.deliveries.length ?? 0) === 0 ? (
            <EmptyNote>{t('还没有投递;发布器开着时,线程动作与 agent 判断会在这里逐条出现。')}</EmptyNote>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              {delivQ.data!.deliveries.map((d) => (
                <DeliveryRow key={d.event_id} d={d} now={now} retrying={retry.isPending} onRetry={(jobId) => retry.mutate({ eventId: d.event_id, jobId })} />
              ))}
            </ScrollArea>
          )}
        </Pane>
      </Workspace>

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('示例投递(没有真发)')}</DialogTitle>
            <DialogDescription>{t('买家 agent 收到的就是这段:一行人话 + 一个 JSON。')}</DialogDescription>
          </DialogHeader>
          {preview?.blocked ? <p className="text-[11px] text-destructive">{preview.blocked}</p> : null}
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/30 p-3 text-[11px]">{preview?.text}</pre>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={disputeTarget !== null}
        title={t('对这次拒收提争议?')}
        summary={t('进入评审员投票')}
        danger
        busy={decide.isPending}
        onCancel={() => setDisputeTarget(null)}
        onConfirm={() => disputeTarget && disputeReason.trim() && decide.mutate({ jobId: disputeTarget.job_id, decision: 'dispute', reason: disputeReason.trim() })}
      >
        <p>{t('争议由至少 5 位评审员投票,多数决;输了退款。理由要能对上投递账本里的记录。')}</p>
        <Textarea value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} rows={3} className="text-[12px]" placeholder={t('理由(必填)')} />
      </ConfirmDialog>

      <ConfirmDialog open={deactivateOpen} title={t('下架 ASP?')} summary={t('市场上不再可见')} danger busy={deactivate.isPending} onCancel={() => setDeactivateOpen(false)} onConfirm={() => deactivate.mutate()}>
        <p>{t('下架后新买家看不到你;已有订阅照常投递到期。随时可以再上架。')}</p>
      </ConfirmDialog>
    </div>
  );
}
