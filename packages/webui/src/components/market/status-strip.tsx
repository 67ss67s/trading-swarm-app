/**
 * 信号市场顶部状态条:钱包卡(设计 §2.6)+ 身份 + 三盏灯 + 入站采集器状态 + 收信号总开关 + 设置。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Inbox, QrCode, RefreshCw, Settings2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { FollowMode, MarketFundingNotice, MarketSettings, MarketStatus, MarketTransport } from '@/api/types';
import { FOLLOW_MODES, FOLLOW_MODE_LABEL } from '@/api/types';
import { Pane } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { Light, fmtUsdt, shortId } from './shared';

function copyText(v: string) {
  void navigator.clipboard?.writeText(v).then(
    () => toast.success(t('已复制')),
    () => toast.error(t('复制失败')),
  );
}

function monthsAffordable(balance: string | null, monthly: string | null): string | null {
  const b = Number(balance);
  const m = Number(monthly);
  if (!Number.isFinite(b) || !Number.isFinite(m) || m <= 0) return null;
  return String(Math.floor(b / m));
}

/** 钱包卡:登录态 / 地址 / XLayer USDT 余额 / 月成本 / 充值。 */
function WalletCard({ status }: { status: MarketStatus }) {
  const w = status.wallet;
  const [notice, setNotice] = useState<MarketFundingNotice | null>(null);
  const deposit = useMutation({
    mutationFn: api.marketWalletDepositNotice,
    onSuccess: (n) => setNotice(n),
    onError: (err) => toast.error(t('拿不到充值地址'), { description: err instanceof Error ? err.message : String(err) }),
  });
  const months = monthsAffordable(w.balance_usdt, status.monthly_cost.amount);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-r px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Wallet className={cn('size-3.5', w.logged_in ? 'text-up' : 'text-muted-foreground')} />
        <span className="text-[12px] font-medium">{t('Agentic Wallet')}</span>
        {w.logged_in ? (
          <span className="max-w-[180px] truncate text-[11px] text-muted-foreground" title={w.email ?? ''}>
            {w.account_name ?? w.email ?? ''}
          </span>
        ) : (
          <Badge variant="outline" className="border-warn/40 text-[10px] text-warn">
            {t('未登录 · 用顶栏账户菜单登录')}
          </Badge>
        )}
      </div>
      {w.address ? (
        <button className="num inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => copyText(w.address!)} title={w.address}>
          {shortId(w.address, 6, 4)} <Copy className="size-3" />
        </button>
      ) : null}
      <span className="text-[11px] text-muted-foreground">
        {t('XLayer USDT')} <span className="num text-foreground">{fmtUsdt(w.balance_usdt)}</span>
      </span>
      <span className="text-[11px] text-muted-foreground">
        {t('月订阅成本')} <span className="num text-foreground">{status.monthly_cost.amount ? fmtUsdt(status.monthly_cost.amount) : '—'}</span>
        {status.monthly_cost.count ? <span className="ml-1">({t('{n} 个订阅', { n: status.monthly_cost.count })})</span> : null}
        {months !== null ? <span className="ml-1">· {t('够付 {n} 个月', { n: months })}</span> : null}
      </span>
      <Button size="xs" variant="outline" disabled={!w.logged_in || deposit.isPending} onClick={() => deposit.mutate()}>
        <QrCode data-slot="icon" />
        {t('充值')}
      </Button>
      {w.error ? <span className="text-[10.5px] text-warn">{w.error}</span> : null}

      <Dialog open={notice !== null} onOpenChange={(o) => !o && setNotice(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('往 Agentic Wallet 充 USDT(XLayer)')}</DialogTitle>
            <DialogDescription>{t('订阅费从这个钱包扣;只转 XLayer 链上的 USDT,别的链转不进来。')}</DialogDescription>
          </DialogHeader>
          {notice ? (
            <div className="flex flex-col items-center gap-3 text-[12px]">
              {notice.qr_png_base64 ? <img alt="deposit qr" className="size-44 rounded border bg-white p-1" src={`data:image/png;base64,${notice.qr_png_base64}`} /> : null}
              {notice.deposit_address ? (
                <button className="num break-all text-center text-[11px] text-primary hover:underline" onClick={() => copyText(notice.deposit_address!)}>
                  {notice.deposit_address}
                </button>
              ) : null}
              {notice.shortfall ? (
                <span className="text-muted-foreground">
                  {t('缺口')} <span className="num text-foreground">{notice.shortfall} {notice.currency ?? 'USDT'}</span>
                </span>
              ) : null}
              {notice.text ? <p className="text-[11px] text-muted-foreground">{notice.text}</p> : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SettingsDrawer({ settings, onSaved }: { settings: MarketSettings; onSaved: () => void }) {
  const [transport, setTransport] = useState<MarketTransport>(settings.transport);
  const [pollMs, setPollMs] = useState(String(settings.poll_ms));
  const [freshness, setFreshness] = useState(String(settings.freshness_s));
  const [defaultMode, setDefaultMode] = useState<FollowMode>(settings.default_mode);
  const [maxPerDay, setMaxPerDay] = useState(String(settings.max_signals_per_subscription_per_day));
  const save = useMutation({
    mutationFn: () =>
      api.setMarketSettings({
        transport,
        poll_ms: Math.max(1000, Number(pollMs) || 3000),
        freshness_s: Math.max(10, Number(freshness) || 180),
        default_mode: defaultMode,
        max_signals_per_subscription_per_day: Math.max(0, Number(maxPerDay) || 0),
      }),
    onSuccess: (r) => {
      if (r.errors?.length) toast.error(t('保存失败'), { description: r.errors.join('; ') });
      else {
        toast.success(t('已保存'));
        onSaved();
      }
    },
    onError: (err) => toast.error(t('保存失败'), { description: err instanceof Error ? err.message : String(err) }),
  });
  return (
    <div className="flex flex-col gap-4 text-[12px]">
      <div className="flex flex-col gap-1.5">
        <Label>{t('入站通道')}</Label>
        <Select value={transport} onValueChange={(v) => setTransport(v as MarketTransport)}>
          <SelectTrigger className="h-7 text-[11.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="queue" className="text-[12px]">
              {t('queue · 只读轮询 okx-a2a 队列(已验证)')}
            </SelectItem>
            <SelectItem value="watch" className="text-[12px]">
              {t('watch · 常驻 okx-a2a user watch(实验)')}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[10.5px] text-muted-foreground">{t('两条通道不能同开:watch 是破坏性读,会把队列吃空。切换后网关重启采集器。')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>{t('轮询间隔(ms)')}</Label>
          <Input type="number" min={1000} step={500} value={pollMs} onChange={(e) => setPollMs(e.target.value)} className="h-7 text-[11.5px]" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('新鲜度上限(秒)')}</Label>
          <Input type="number" min={10} value={freshness} onChange={(e) => setFreshness(e.target.value)} className="h-7 text-[11.5px]" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('新订阅默认模式')}</Label>
          <Select value={defaultMode} onValueChange={(v) => setDefaultMode(v as FollowMode)}>
            <SelectTrigger className="h-7 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FOLLOW_MODES.map((m) => (
                <SelectItem key={m} value={m} className="text-[12px]">
                  {FOLLOW_MODE_LABEL[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('每订阅每日开仓触发上限(0 = 不限)')}</Label>
          <Input type="number" min={0} value={maxPerDay} onChange={(e) => setMaxPerDay(e.target.value)} className="h-7 text-[11.5px]" />
        </div>
      </div>
      <p className="text-[10.5px] text-muted-foreground">{t('仓位管理类动作(减仓/移损/改止盈)的自动执行永远关闭,这里没有开关。')}</p>
      <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
        {t('保存')}
      </Button>
    </div>
  );
}

export function StatusStrip({ status, isLoading, error }: { status: MarketStatus | null; isLoading: boolean; error: unknown }) {
  const qc = useQueryClient();
  const now = useNow();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const refresh = useQuery({ queryKey: ['market', 'status', 'fresh'], queryFn: () => api.marketStatus(true), enabled: false });
  const toggle = useMutation({
    mutationFn: (v: boolean) => api.setFollow({ follow: { enabled: v } }),
    onSuccess: (r) => {
      qc.setQueryData(['follow'], r);
      void qc.invalidateQueries({ queryKey: ['market', 'status'] });
      toast.success(r.follow.enabled ? t('已开始收信号') : t('已停止收信号'));
    },
    onError: (err) => toast.error(t('切换失败'), { description: err instanceof Error ? err.message : String(err) }),
  });
  const poll = useMutation({
    mutationFn: api.marketInboxPoll,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['market'] });
      void qc.invalidateQueries({ queryKey: ['follow'] });
      toast.success(t('已拉一次'));
    },
    onError: (err) => toast.error(t('拉取失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  return (
    <Pane
      title={t('信号市场')}
      hint={t('OKX.AI · ASP:买信号、收信号、卖信号,全在这一页')}
      actions={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={refresh.isFetching}
            onClick={() => {
              void refresh.refetch().then((r) => {
                if (r.data) qc.setQueryData(['market', 'status'], r.data);
              });
            }}
            title={t('强刷钱包 / 守护 / 身份状态(绕过 30s 缓存)')}
          >
            <RefreshCw data-slot="icon" className={cn(refresh.isFetching && 'animate-spin')} />
          </Button>
          <Button size="xs" variant="outline" onClick={() => setSettingsOpen(true)}>
            <Settings2 data-slot="icon" />
            {t('设置')}
          </Button>
        </>
      }
    >
      {isLoading ? (
        <div className="px-3 py-2 text-[12px] text-muted-foreground">{t('加载中…')}</div>
      ) : error || !status ? (
        <p className="px-3 py-2 text-[12px] text-destructive">
          {t('加载失败')}:{error instanceof Error ? error.message : String(error)}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-stretch">
            <WalletCard status={status} />
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-r px-3 py-2">
              <span className="text-[11px] text-muted-foreground">
                {t('买家身份')}{' '}
                {status.buyer ? (
                  <span className="text-foreground">
                    #{status.buyer.agent_id} {status.buyer.name}
                  </span>
                ) : (
                  <span className="text-warn">{t('没有 User 身份')}</span>
                )}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {t('卖家身份')}{' '}
                {status.asp ? (
                  <span className="text-foreground">
                    #{status.asp.agent_id} {status.asp.name}
                    <span className="ml-1 text-muted-foreground">({status.asp.status})</span>
                  </span>
                ) : (
                  <span>{t('未注册 ASP · 去「发布」栏')}</span>
                )}
              </span>
              <Light ok={status.lights.a2a.ok} label={t('A2A 守护')} detail={status.lights.a2a.detail} />
              <Light ok={status.lights.trade_kit.ok} label={t('Trade Kit')} detail={status.lights.trade_kit.detail} />
              {status.this_device ? (
                <span className="text-[11px] text-muted-foreground" title={status.this_device.id}>
                  {t('本机设备')} <span className="text-foreground">{status.this_device.name}</span>
                </span>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2">
              <div className="flex items-center gap-2">
                <Switch checked={status.settings.enabled} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} />
                <span className="text-[12px] font-medium">{status.settings.enabled ? t('收信号:开') : t('收信号:关')}</span>
              </div>
              <Light
                ok={status.inbox.available}
                label={status.inbox.transport === 'watch' ? t('watch 通道') : t('队列通道')}
                detail={status.inbox.available ? null : status.inbox.last_error ?? t('不可用')}
              />
              <span className="text-[11px] text-muted-foreground">
                {t('上次拉取')} <span className="text-foreground">{status.inbox.last_poll_at ? relativeTime(status.inbox.last_poll_at, now) : t('从未')}</span>
              </span>
              <span className="text-[11px] text-muted-foreground">
                {t('账本')} <span className="num text-foreground">{status.inbox.ledger_total}</span> · {t('进流')} <span className="num text-foreground">{status.inbox.ingested}</span> · {t('分析')}{' '}
                <span className="num text-foreground">{status.inbox.skipped_analysis}</span> · {t('坏行')} <span className={cn('num', status.inbox.bad_rows ? 'text-warn' : 'text-foreground')}>{status.inbox.bad_rows}</span>
                {status.inbox.dlq_count ? (
                  <>
                    {' '}
                    · DLQ <span className="num text-down">{status.inbox.dlq_count}</span>
                  </>
                ) : null}
              </span>
              <Button size="xs" variant="outline" disabled={poll.isPending || !status.settings.enabled} onClick={() => poll.mutate()} title={t('手动拉一次(queue 通道)')}>
                <Inbox data-slot="icon" className={cn(poll.isPending && 'animate-pulse')} />
                {t('拉一次')}
              </Button>
            </div>
          </div>
        </>
      )}

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>{t('信号市场设置')}</SheetTitle>
            <SheetDescription>{t('入站通道与判定口径;每个订阅的模式在「订阅」栏各自改。')}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {status ? (
              <SettingsDrawer
                settings={status.settings}
                onSaved={() => {
                  setSettingsOpen(false);
                  void qc.invalidateQueries({ queryKey: ['market', 'status'] });
                  void qc.invalidateQueries({ queryKey: ['follow'] });
                }}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </Pane>
  );
}
