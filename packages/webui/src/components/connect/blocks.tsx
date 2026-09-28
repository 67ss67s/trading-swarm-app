/**
 * 接入类可复用块(2026-09-25 信息架构第二批,docs/design/ia-newcomer-audit-2026-09-25.md ③-1/2/3/4):
 * 从 execution-panel.tsx 抽出来,#connect 接入页、Agent 右栏「执行」只读摘要、交易页、开始清单共用。
 *
 *   AccountModeSelect      OKX 账户模式下拉(§9.40,确认后网关签名直打 set-account-level)
 *   SimpleModeWarning      「简单模式开不了永续」警告(51010)
 *   ProtectionVerifyBlock  标记保护单已验证(标记后闸门才放开新开仓)
 *   NetCheckRow            网络自检(连续 5 次只读账户调用)
 *   MarketRiskBlock        交易市场 / 单笔风险 / 杠杆 / 保证金模式,按账户模式联动禁用
 *   isProtectionVerified   保护单是否算验过(新旧两套字段)
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { ExecutionView, Market, NetCheckResult, Workflow } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { JudgeLock } from '@/components/judge-lock';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { friendlyError, lockReason } from '@/lib/edition';
import { acctLvLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

/** 新旧两套字段:§9.31 的 state 优先,只给旧 status 的网关退回旧口径。判不出来的按「没验过」处理 */
export function isProtectionVerified(view: ExecutionView | null | undefined): { verified: boolean; verifying: boolean } {
  const p = view?.protection;
  const verified = p?.state === 'verified' || p?.state === 'not_needed' || (p?.state === undefined && (p?.status === 'verified' || p?.status === 'not_needed'));
  const verifying = p?.state === 'verifying' || (p?.state === undefined && p?.status === 'verifying');
  return { verified: !!verified, verifying: !!verifying };
}

/**
 * OKX 账户模式在交易页右上角 ⚙ 的「账户模式」里切;模拟盘没有稳定直链,先落到交易页由用户切进模拟盘。
 * (和 pages/trade.tsx 的 okxAccountModeUrl 同口径)
 */
export const OKX_ACCOUNT_MODE_URL = 'https://www.okx.com/trade-swap/btc-usdt-swap';

// ---------------------------------------------------------------------------

/**
 * §9.40 账户模式:1 简单 / 2 单币种保证金 / 3 跨币种保证金 / 4 组合保证金。选了别的就弹确认,
 * 确认后网关签名直打 OKX set-account-level(CLI 没这个命令)。OKX 的硬规矩:切换时不能有持仓/挂单/借币;
 * 从简单模式第一次切出必须去网页做测评(51070),这两种拒绝原样显示。
 */
export const ACCT_LV_OPTIONS: { lv: 1 | 2 | 3 | 4; label: string; hint: string }[] = [
  { lv: 1, label: '简单模式', hint: '只能现货;永续单会被 OKX 拒(51010)' },
  { lv: 2, label: '单币种保证金', hint: '永续 + 现货,按币种各算保证金' },
  { lv: 3, label: '跨币种保证金', hint: '永续 + 现货,所有币折 USD 共用保证金' },
  { lv: 4, label: '组合保证金', hint: '专业模式,有资产门槛' },
];

export function AccountModeSelect({ view, size = 'sm' }: { view: ExecutionView; size?: 'sm' | 'md' }) {
  const queryClient = useQueryClient();
  const okx = view.okx ?? null;
  const cur = okx?.acct_lv ?? null;
  const [target, setTarget] = useState<1 | 2 | 3 | 4 | null>(null);
  const positionsQ = useQuery({ queryKey: ['positions'], queryFn: api.positions, staleTime: 15_000 });
  const flat = (positionsQ.data?.length ?? 0) === 0;
  const set = useMutation({
    mutationFn: (lv: 1 | 2 | 3 | 4) => api.okxSetAccountLevel(lv),
    onSuccess: (res) => {
      queryClient.setQueryData(['execution'], res.execution);
      void queryClient.invalidateQueries({ queryKey: ['execution'] });
      void queryClient.invalidateQueries({ queryKey: ['risk'] });
      setTarget(null);
      toast.success(t('OKX 账户模式已切到「{m}」', { m: acctLvLabel(res.acct_lv) }));
    },
    onError: (err: Error & { status?: number; code?: string }) => toast.error(t('切换账户模式失败'), { description: friendlyError(err.message) }),
  });
  const opt = ACCT_LV_OPTIONS.find((o) => o.lv === target) ?? null;
  // 评审版:切账户模式要用私有 OKX key 直打交易所,锁住
  const lock = lockReason('exchange_credentials');
  return (
    <>
      <span className="flex items-center gap-1" title={lock ?? t('OKX 账户模式(acctLv);简单模式下永续不可用(51010),现货照常')}>
        {size === 'sm' ? <span className="text-[10.5px] text-muted-foreground">{t('账户模式')}</span> : null}
        <Select value={cur ? String(cur) : ''} disabled={!!lock} onValueChange={(v) => setTarget(Number(v) as 1 | 2 | 3 | 4)}>
          <SelectTrigger size="sm" className={cn(size === 'sm' ? 'h-6 w-[132px] text-[10.5px]' : 'h-7 w-44 text-[12px]', cur === 1 && 'border-warn/40 text-warn')}>
            <SelectValue placeholder={acctLvLabel(cur, okx?.acct_lv_label)} />
          </SelectTrigger>
          <SelectContent>
            {ACCT_LV_OPTIONS.map((o) => (
              <SelectItem key={o.lv} value={String(o.lv)} className="text-[11.5px]" title={t(o.hint)}>
                {t(o.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
      <ConfirmDialog
        open={target !== null && target !== cur}
        title={opt ? t('把 OKX 账户模式切到「{m}」', { m: t(opt.label) }) : t('切换账户模式')}
        summary={t('确认切换')}
        danger
        busy={set.isPending}
        onCancel={() => setTarget(null)}
        onConfirm={() => target && set.mutate(target)}
      >
        <p className="text-muted-foreground">{opt ? t(opt.hint) : null}</p>
        <p className="mt-1 text-muted-foreground">
          {t('网关会用本机 okx profile 的 key 直接调 OKX 的 set-account-level(CLI 没这个命令)。OKX 要求切换时没有持仓、挂单、借币;从简单模式第一次切出 OKX 只允许在网页/App 做(51070),之后 2/3/4 之间可以在这里切。')}
        </p>
        {!flat ? <p className="mt-1 text-warn">{t('当前账户还有持仓,OKX 大概率会拒;先平掉再切。')}</p> : null}
      </ConfirmDialog>
    </>
  );
}

/** 重新读一次 acctLv(用户在 OKX 网页切完回来点) */
export function RefreshAccountModeButton() {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: api.okxRefreshAccountLevel,
    onSuccess: (view) => {
      queryClient.setQueryData(['execution'], view);
      toast.success(t('已重新读取账户模式:{m}', { m: acctLvLabel(view.okx?.acct_lv, view.okx?.acct_lv_label) }));
    },
    onError: (e: Error) => toast.error(t('读取失败'), { description: friendlyError(e.message) }),
  });
  return (
    <Button size="xs" variant="ghost" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
      {refresh.isPending ? <Loader2 data-slot="icon" className="animate-spin" /> : <RefreshCw data-slot="icon" />}
      {t('切完点刷新')}
    </Button>
  );
}

// ---------------------------------------------------------------------------

/**
 * 「简单模式开不了永续」警告(③-2):OKX 账户 acctLv=1 时渲染,其余情况返回 null。
 * `link` 为 true 时附「去接入页切换」;交易页选永续时、接入页、Agent 执行摘要都用这一份文案。
 */
export function SimpleModeWarning({ view, link = false, className }: { view: ExecutionView | null | undefined; link?: boolean; className?: string }) {
  if (!(view?.exchange === 'okx' && view.okx?.available && view.okx.acct_lv === 1)) return null;
  return (
    <div className={cn('rounded-sm border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warn', className)} data-testid="simple-mode-warning">
      {t('账户处于「简单模式」,OKX 不允许下永续单(51010)。现货照常可交易;要开永续请在 OKX 网页/App:交易 → 右上角账户模式 → 切到「单币种保证金模式」(首次要做一次合约风险测评),然后点刷新。')}
      {link ? (
        <a href="#connect" className="ml-1 underline">
          {t('去接入页切换 →')}
        </a>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * 标记保护单已验证(③-3):保护腿(附带止损)不能让网关自己花钱验(OKX 的算法单要真仓位),按 §7 人工在
 * 模拟盘跑一遍,再点「标记保护单已验证」——真金白银的确认,所以走 ConfirmDialog。
 */
export function ProtectionVerifyBlock({ view }: { view: ExecutionView }) {
  const queryClient = useQueryClient();
  const [ask, setAsk] = useState(false);
  const { verified, verifying } = isProtectionVerified(view);
  const mark = useMutation({
    mutationFn: api.okxMarkVerified,
    onSuccess: (res) => {
      queryClient.setQueryData(['execution'], res);
      void queryClient.invalidateQueries({ queryKey: ['execution'] });
      void queryClient.invalidateQueries({ queryKey: ['risk'] });
      setAsk(false);
      toast.success(t('保护单标记为已验证'));
    },
    onError: (err: Error & { status?: number }) => toast.error(t('标记失败'), { description: friendlyError(err.message) }),
  });
  return (
    <div className="flex flex-col gap-1.5 text-[11.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('font-medium', verified ? 'text-up' : verifying ? 'text-muted-foreground' : 'text-warn')}>
          {verified ? t('已验证') : verifying ? t('验证中') : t('还没验证:闸门不放开新开仓')}
        </span>
        {!verified && !verifying ? (
          <JudgeLock feature="protection_verify">
            <Button size="xs" variant="outline" disabled={mark.isPending} onClick={() => setAsk(true)} title={t('先按验证清单在模拟盘上人工跑一遍,再标记;标记后闸门才放开新开仓')}>
              {mark.isPending ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck data-slot="icon" />}
              {t('标记保护单已验证')}
            </Button>
          </JudgeLock>
        ) : null}
      </div>
      {!verified ? (
        <ol className="list-decimal space-y-0.5 pl-4 text-[10.5px] text-muted-foreground">
          <li>{t('带附带止损开一笔最小仓')}</li>
          <li>{t('能查到算法单')}</li>
          <li>{t('撤掉')}</li>
          <li>{t('单独挂一张')}</li>
          <li>{t('平仓')}</li>
        </ol>
      ) : null}
      <ConfirmDialog
        open={ask}
        title={t('把 OKX 保护单标记为已验证')}
        summary={t('确认,标记已验证')}
        danger
        busy={mark.isPending}
        onCancel={() => setAsk(false)}
        onConfirm={() => mark.mutate()}
      >
        <p className="text-muted-foreground">
          {t('这只是记一笔「人验过了」,网关不会替你去验。标记之后闸门就放开新开仓,所以请先在模拟盘上真的跑通:带附带止损开一笔最小仓 → 能查到算法单 → 撤掉 → 单独挂一张 → 平仓。')}
        </p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * 09-07 网络自检:连续 5 次只读账户调用(每次一个子进程一条新连接,和真下单同一条路),报掉线率和建议。
 * 同步等结果,agent_mcp 约 2 分钟。结果只在本页面内存里,刷新就没,活动流里有一条记录。
 */
export function NetCheckRow() {
  const [result, setResult] = useState<NetCheckResult | null>(null);
  const run = useMutation({
    mutationFn: () => api.netCheck(5),
    onSuccess: (res) => {
      setResult(res.result);
      (res.result.transport_errors ? toast.warning : toast.success)(t('网络自检:{ok}/{total} 通', { ok: res.result.ok, total: res.result.runs.length }), { description: friendlyError(res.result.verdict) });
    },
    onError: (e: Error & { status?: number }) => toast.error(e.status === 409 ? t('正在跑,别重复点') : t('自检没跑起来'), { description: friendlyError(e.message) }),
  });
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
      <Button size="xs" variant="outline" disabled={run.isPending} onClick={() => run.mutate()} title={t('连续 5 次只读账户调用,约 2 分钟;测的就是下单走的那条路')}>
        {run.isPending ? <Loader2 data-slot="icon" className="animate-spin" /> : <RefreshCw data-slot="icon" />}
        {run.isPending ? t('自检中,约 2 分钟…') : t('网络自检')}
      </Button>
      {result ? (
        <span className={cn('num min-w-0 flex-1', result.transport_errors ? 'text-warn' : 'text-muted-foreground')} title={result.runs.map((r, i) => `#${i + 1} ${r.ok ? 'ok' : r.transport_error ? t('掉线') : t('错误')} ${r.ms} ms${r.error ? ` ${friendlyError(r.error)}` : ''}`).join('\n')}>
          {friendlyError(result.verdict)}
        </span>
      ) : null}
    </div>
  );
}

/** 执行通道最近 30 分钟的传输健康(只读一行);后端不统计时不画 */
export function TransportLine({ view }: { view: ExecutionView }) {
  if (!view.transport) return null;
  return (
    <div
      className={cn('num text-[11px]', view.transport.transport_errors > 0 ? 'text-warn' : 'text-muted-foreground')}
      title={view.transport.last_error ? t('最近一次:{detail}', { detail: friendlyError(view.transport.last_error) }) : t('最近 30 分钟没出现连接被掐或超时')}
    >
      {t('网络:最近 {min} 分钟 {runs} 次调用,{bad} 次连接被掐或超时', { min: Math.round(view.transport.window_ms / 60_000), runs: view.transport.runs, bad: view.transport.transport_errors })}
    </div>
  );
}

// ---------------------------------------------------------------------------

type MarketDraft = Pick<Workflow, 'risk_pct' | 'leverage' | 'margin_mode'> & { markets: Market[]; default_market: Market };

function draftOf(w: Workflow): MarketDraft {
  const markets = w.markets?.length ? w.markets : (['perp'] as Market[]);
  return { markets, default_market: w.default_market && markets.includes(w.default_market) ? w.default_market : markets[0]!, risk_pct: w.risk_pct, leverage: w.leverage, margin_mode: w.margin_mode };
}

/**
 * 交易市场 / 单笔风险 / 杠杆 / 保证金模式(③-4):和账户模式放在同一处,按账户模式联动禁用——
 * OKX 简单模式下永续开关不能打开(51010);没开永续时杠杆和保证金模式置灰(现货没有杠杆)。
 * 保存走 POST /api/workflow 的部分应用,只发改了的字段。
 */
export function MarketRiskBlock({ view }: { view: ExecutionView | null | undefined }) {
  const queryClient = useQueryClient();
  const workflowQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });
  const server = workflowQ.data ? draftOf(workflowQ.data) : null;
  const [draft, setDraft] = useState<MarketDraft | null>(null);
  useEffect(() => {
    if (server && draft === null) setDraft(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowQ.data]);
  const save = useMutation({
    mutationFn: (p: Partial<Workflow>) => api.patchWorkflow(p),
    onSuccess: (res) => {
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      setDraft(draftOf(res.workflow));
      if ((res.errors ?? []).length > 0) toast.warning(t('{n} 项没保存', { n: res.errors.length }), { description: res.errors.join('; ') });
      else toast.success(t('已保存'));
    },
    onError: (err) => toast.error(t('保存失败'), { description: friendlyError(err instanceof Error ? err.message : String(err)) }),
  });
  if (!draft || !server) return <div className="text-[11px] text-muted-foreground">{workflowQ.isError ? t('读不到工作流') : t('加载中…')}</div>;

  const simple = view?.exchange === 'okx' && !!view.okx?.available && view.okx.acct_lv === 1;
  const supported = view?.markets_supported ?? (['perp', 'spot'] as Market[]);
  const perpBlocked = simple || !supported.includes('perp');
  const perpOn = draft.markets.includes('perp');
  const patch: Partial<Workflow> = {};
  if (draft.markets.join(',') !== server.markets.join(',')) patch.markets = draft.markets;
  if (draft.default_market !== server.default_market) patch.default_market = draft.default_market;
  if (draft.risk_pct !== server.risk_pct) patch.risk_pct = draft.risk_pct;
  if (draft.leverage !== server.leverage) patch.leverage = draft.leverage;
  if (draft.margin_mode !== server.margin_mode) patch.margin_mode = draft.margin_mode;
  const dirty = Object.keys(patch).length > 0;

  const toggle = (m: Market, on: boolean) =>
    setDraft((d) => {
      if (!d) return d;
      const next = on ? [...new Set([...d.markets, m])] : d.markets.filter((x) => x !== m);
      const markets: Market[] = next.length ? (['perp', 'spot'] as Market[]).filter((x) => next.includes(x)) : [m === 'perp' ? 'spot' : 'perp'];
      return { ...d, markets, default_market: markets.includes(d.default_market) ? d.default_market : markets[0]! };
    });

  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-20 shrink-0 text-muted-foreground">{t('交易市场')}</span>
        {(['perp', 'spot'] as Market[]).map((m) => {
          const disabled = m === 'perp' ? perpBlocked && !perpOn : !supported.includes('spot') && !draft.markets.includes('spot');
          return (
            <label key={m} className={cn('flex items-center gap-1 select-none', disabled && 'opacity-50')} title={m === 'perp' && simple ? t('简单模式下永续不可用;先在上一步切账户模式') : undefined}>
              <Switch checked={draft.markets.includes(m)} disabled={disabled} onCheckedChange={(v) => toggle(m, v)} />
              {m === 'perp' ? t('永续') : t('现货')}
            </label>
          );
        })}
        <span className="text-muted-foreground">{t('默认')}</span>
        <Select value={draft.default_market} onValueChange={(v) => setDraft((d) => (d ? { ...d, default_market: v as Market } : d))}>
          <SelectTrigger size="sm" className="h-7 w-20 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {draft.markets.map((m) => (
              <SelectItem key={m} value={m}>
                {m === 'perp' ? t('永续') : t('现货')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {perpOn && simple ? <div className="text-[11px] text-warn">{t('工作流开着永续,但账户是简单模式:agent 的永续单会被 OKX 拒(51010)。切账户模式,或者关掉永续只做现货。')}</div> : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-20 shrink-0 text-muted-foreground">{t('单笔风险')}</span>
        <Input value={draft.risk_pct} onChange={(e) => setDraft((d) => (d ? { ...d, risk_pct: e.target.value } : d))} className="num h-7 w-20 text-[12px]" inputMode="decimal" />
        <span className="text-[11px] text-muted-foreground">{t('% 权益')}</span>
      </div>
      <div className={cn('flex flex-wrap items-center gap-3', !perpOn && 'opacity-50')} title={!perpOn ? t('只做现货时没有杠杆和保证金模式') : undefined}>
        <span className="w-20 shrink-0 text-muted-foreground">{t('杠杆')}</span>
        <Input
          type="number"
          min={1}
          max={10}
          disabled={!perpOn}
          value={String(draft.leverage)}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(n)) setDraft((d) => (d ? { ...d, leverage: n } : d));
          }}
          className="num h-7 w-20 text-[12px]"
        />
        <span className="text-muted-foreground">{t('保证金模式')}</span>
        <Select disabled={!perpOn} value={draft.margin_mode} onValueChange={(v) => setDraft((d) => (d ? { ...d, margin_mode: v as Workflow['margin_mode'] } : d))}>
          <SelectTrigger size="sm" className="h-7 w-24 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cross">{t('全仓')}</SelectItem>
            <SelectItem value="isolated">{t('逐仓')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Button size="xs" disabled={!dirty || save.isPending} onClick={() => save.mutate(patch)}>
          {save.isPending ? <Loader2 data-slot="icon" className="animate-spin" /> : null}
          {t('保存')}
        </Button>
        {dirty ? (
          <Button size="xs" variant="ghost" onClick={() => setDraft(server)}>
            {t('撤销')}
          </Button>
        ) : null}
        <a href="#settings" className="ml-auto text-[11px] text-primary hover:underline">
          {t('其余风控参数去「风控与自动化」→')}
        </a>
      </div>
    </div>
  );
}

/** OKX 网页的账户模式入口链接 */
export function OkxAccountModeLink() {
  return (
    <a href={OKX_ACCOUNT_MODE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">
      {t('去 OKX 网页切账户模式')}
      <ExternalLink className="size-3" />
    </a>
  );
}
