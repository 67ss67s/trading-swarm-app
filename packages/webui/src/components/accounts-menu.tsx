/**
 * 顶栏「账户」菜单(2026-09-20):一个可展开的入口装下所有要连的东西——OKX 交易账户、Agentic 钱包、MCP。
 *
 * 设计原则:用户不该知道要装什么、跑什么命令。每样东西只有「状态 + 一个动作」:
 *   - OKX 交易账户:没 CLI → 「安装」按钮(网关跑 npm i -g);没凭证 → 三个输入框 + 去 OKX 建 key 的链接,
 *     点「连接」网关转手交给 okx CLI 写 ~/.okx/config.toml,网关本身不存 key。
 *   - Agentic 钱包:「连接」= 网关起 onchainos 登录 → 打开登录页 → 网关轮询到登录成功;「断开」= logout。
 *   - MCP:okx CLI 自带 MCP server,一键挂到 Claude Code 上,Claude 侧就能直接查/下单。
 *
 * OkxConnectForm 同时给执行页的 OkxBlock 用,两处一份代码。
 * 2026-09-25:OkxSection / WalletSection / McpSection 导出给 #connect 接入页复用;OKX 段多一行「账户模式」(③-1)。
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ExternalLink, Loader2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { ExecutionView, OkxSetupRequest, OkxStatus } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useExecutionQuery } from '@/components/connect/use-execution';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { acctLvLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

/** OKX 网页的 API 管理页:带上 go-demo-trading / go-live-trading 会直接切到对应模式(okx CLI 自己 config init 也是这么跳的)。 */
function okxApiKeyUrl(demo: boolean): string {
  return `https://www.okx.com/account/my-api?${demo ? 'go-demo-trading=1' : 'go-live-trading=1'}`;
}

function Light({ on, warn }: { on: boolean; warn?: boolean }) {
  return <span className={cn('size-1.5 shrink-0 rounded-full', on ? 'bg-up' : warn ? 'bg-warn' : 'bg-muted-foreground/40')} />;
}

/** 凭证表单:三个框 + 连接。提交后清空,key 不在前端留。demo 由外面的槽位决定。 */
export function OkxConnectForm({ view, demo, onDone }: { view: ExecutionView | undefined; demo: boolean; onDone?: () => void }) {
  const qc = useQueryClient();
  const okx = view?.okx ?? null;
  const [form, setForm] = useState({ api_key: '', secret_key: '', passphrase: '' });
  const cliMissing = !!okx && !okx.version;

  const install = useMutation({
    mutationFn: api.okxInstall,
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['execution'] });
      res.ok ? toast.success(t('okx CLI 装好了')) : toast.error(t('安装失败'), { description: res.log_tail });
    },
    onError: (e: Error) => toast.error(t('安装失败'), { description: e.message }),
  });
  // 凭证不进 TanStack 的 mutation 缓存(variables 会留到 reset/GC):自己管 pending,发送前就清空表单,
  // 请求结束立刻丢掉 payload 引用(review #3)。
  const [pending, setPending] = useState(false);
  const submit = async () => {
    if (!ready || pending) return;
    let body: OkxSetupRequest | null = { ...form, demo, name: demo ? 'okx-demo' : 'okx-live' };
    setForm({ api_key: '', secret_key: '', passphrase: '' });
    setPending(true);
    try {
      const res = await api.okxSetup(body);
      void qc.invalidateQueries({ queryKey: ['execution'] });
      void qc.invalidateQueries({ queryKey: ['okx'] });
      if (res.credentials_ok) { toast.success(t('OKX 连上了:{p}', { p: res.profile })); onDone?.(); }
      else toast.error(t('凭证写进去了,但查账户失败'), { description: res.error ?? '' });
    } catch (e) {
      toast.error(t('连接失败'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      body = null;
      setPending(false);
    }
  };
  const ready = form.api_key.trim() && form.secret_key.trim() && form.passphrase.trim();

  if (cliMissing) {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-muted-foreground">{t('交易组件还没就绪')}</span>
        <Button size="xs" variant="outline" disabled={install.isPending} onClick={() => install.mutate()}>
          {install.isPending ? <Loader2 data-slot="icon" className="animate-spin" /> : null}
          {install.isPending ? t('安装中,约一分钟…') : t('一键安装')}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-1.5 text-[11px]"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <a href={okxApiKeyUrl(demo)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
        {demo ? t('去 OKX 建模拟盘 API key') : t('去 OKX 建实盘 API key')}
        <ExternalLink className="size-3" />
      </a>
      <Input className="h-7 text-[11px]" placeholder="API key" autoComplete="off" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
      <Input className="h-7 text-[11px]" placeholder="Secret key" type="password" autoComplete="off" value={form.secret_key} onChange={(e) => setForm({ ...form, secret_key: e.target.value })} />
      <div className="flex gap-1.5">
        <Input className="h-7 flex-1 text-[11px]" placeholder="Passphrase" type="password" autoComplete="off" value={form.passphrase} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} />
        <Button type="submit" size="xs" disabled={!ready || pending}>
          {pending ? <Loader2 data-slot="icon" className="animate-spin" /> : null}
          {t('连接')}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">{demo ? t('key 只留在本机,网关和模型都不留。模拟盘随便玩。') : t('key 只留在本机,网关和模型都不留。权限勾「读取 + 交易」就够,不要提币。')}</p>
    </form>
  );
}

/**
 * OKX 段:两个槽位「模拟盘 / 实盘」各自独立。当前用的那个亮绿;另一个可以连上备着,一键切换;
 * 每个槽位都能断开(删本机 profile)。老网关没 profiles 字段时退回单槽位。
 */
export function OkxSection({ view }: { view: ExecutionView | undefined }) {
  const qc = useQueryClient();
  const okx = view?.okx ?? null;
  const profiles = okx?.profiles ?? (okx?.profile ? [{ name: okx.profile, demo: okx.demo !== false, is_default: true }] : []);
  const [tab, setTab] = useState<boolean>(() => profiles.find((p) => p.is_default)?.demo ?? true);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const slot = profiles.find((p) => p.demo === tab) ?? null;
  const active = !!slot?.is_default && !!okx?.available;

  const refresh = (st: OkxStatus) => {
    qc.setQueryData(['execution'], (old: unknown) => (old && typeof old === 'object' ? { ...old, okx: st } : old));
    void qc.invalidateQueries({ queryKey: ['execution'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };
  const use = useMutation({
    mutationFn: api.okxUse,
    onSuccess: (st) => { refresh(st); toast.success(t('已切到 {p}', { p: st.profile ?? '' })); },
    onError: (e: Error) => toast.error(t('切换失败'), { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: api.okxRemove,
    onSuccess: (st) => { refresh(st); setConfirmRemove(null); toast.success(t('已断开')); },
    onError: (e: Error) => toast.error(t('断开失败'), { description: e.message }),
  });

  return (
    <div className="border-b px-3 py-2">
      <div className="flex items-center gap-2 text-[11px]">
        <Light on={!!okx?.available} warn={!okx?.available} />
        <span className="font-medium">{t('OKX 交易账户')}</span>
        <div className="ml-auto flex overflow-hidden rounded-md border text-[10.5px]">
          {([true, false] as const).map((d) => {
            const p = profiles.find((x) => x.demo === d);
            return (
              <button key={String(d)} type="button" onClick={() => { setTab(d); setEditing(false); }} className={cn('flex items-center gap-1 px-2 py-0.5', tab === d ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                <Light on={!!p?.is_default && !!okx?.available} warn={false} />
                {d ? t('模拟盘') : t('实盘')}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-2">
        {slot && !editing ? (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className={cn('num', active ? 'text-up' : 'text-muted-foreground')}>{active ? t('当前使用') : t('已连,未启用')}</span>
            <span className="num text-muted-foreground">{slot.name}</span>
            <span className="ml-auto flex gap-1">
              {!slot.is_default ? <Button size="xs" variant="outline" disabled={use.isPending} onClick={() => use.mutate(slot.name)}>{t('切到这个')}</Button> : null}
              <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>{t('换 key')}</Button>
              <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setConfirmRemove(slot.name)}>{t('断开')}</Button>
            </span>
          </div>
        ) : (
          <OkxConnectForm view={view} demo={tab} onDone={() => setEditing(false)} />
        )}
        {editing ? <button type="button" className="mt-1 text-[10px] text-muted-foreground hover:underline" onClick={() => setEditing(false)}>{t('取消')}</button> : null}
      </div>
      {okx?.available ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px]" data-testid="accounts-okx-acct-lv">
          <span className="text-muted-foreground">{t('账户模式')}</span>
          <span className={cn('num', okx.acct_lv === 1 ? 'text-warn' : 'text-foreground')}>{okx.acct_lv ? acctLvLabel(okx.acct_lv, okx.acct_lv_label) : t('读不到')}</span>
          {okx.acct_lv === 1 ? <span className="text-warn">{t('· 永续不可用')}</span> : null}
          <a href="#connect" className="ml-auto text-[10.5px] text-primary hover:underline">{t('去接入页 →')}</a>
        </div>
      ) : null}
      <ConfirmDialog open={confirmRemove !== null} title={t('断开 OKX 账户')} summary={t('确认断开')} danger busy={remove.isPending} onCancel={() => setConfirmRemove(null)} onConfirm={() => confirmRemove && remove.mutate(confirmRemove)}>
        <p className="text-muted-foreground">{t('会把这套 key 从本机删掉,OKX 上的 API key 本身不受影响;再连要重新粘 key。')}</p>
      </ConfirmDialog>
    </div>
  );
}

export function WalletSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['wallet'], queryFn: () => api.wallet(), refetchInterval: 60_000, retry: 0 });
  const [session, setSession] = useState<string | null>(null);
  const w = q.data ?? null;

  const poll = useMutation({
    mutationFn: (id: string) => api.walletLoginPoll(id),
    onSuccess: (res) => {
      qc.setQueryData(['wallet'], res);
      void qc.invalidateQueries({ queryKey: ['okx'] });
      if (res.logged_in) { setSession(null); failures.current = 0; toast.success(t('钱包连上了')); }
    },
    onError: () => { failures.current += 1; },
  });
  const login = useMutation({
    mutationFn: api.walletLogin,
    onSuccess: (res) => {
      window.open(res.url, '_blank', 'noopener');
      setSession(res.session_id);
      poll.mutate(res.session_id);
    },
    onError: (e: Error) => toast.error(t('发起登录失败'), { description: e.message }),
  });
  const logout = useMutation({
    mutationFn: api.walletLogout,
    onSuccess: (res) => { qc.setQueryData(['wallet'], res); void qc.invalidateQueries({ queryKey: ['okx'] }); toast.success(t('钱包已断开')); },
    // 报错也刷一次真实状态:CLI 可能已经登出了只是回执没解析好(2026-09-20 用户碰到过)
    onError: (e: Error) => { void qc.invalidateQueries({ queryKey: ['wallet'] }); toast.error(t('断开失败'), { description: e.message }); },
  });
  // 登录页在别的标签页完成,网关那边一轮 poll 超时就再来一轮,直到连上或用户放弃。
  // 每轮之间隔 2s,连续失败 5 次就停(review #5:别把 onchainos 起成死循环)。
  const failures = useRef(0);
  useEffect(() => {
    if (!session || poll.isPending || w?.logged_in) return;
    if (failures.current >= 5) { setSession(null); toast.error(t('登录没完成')); failures.current = 0; return; }
    const id = window.setTimeout(() => poll.mutate(session), 2000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, poll.isPending]);

  const busy = login.isPending || !!session;
  return (
    <div className="border-b px-3 py-2">
      <div className="flex items-center gap-2 text-[11px]">
        <Light on={!!w?.logged_in} warn={w?.installed === false} />
        <span className="font-medium">{t('Agentic 钱包')}</span>
        {w?.logged_in ? (
          <span className="num min-w-0 truncate text-muted-foreground" title={w.account_id ?? ''}>{w.email ?? w.account_name}</span>
        ) : (
          <span className="text-muted-foreground">{q.isError ? t('读不到') : w?.installed === false ? t('还没装 onchainos') : t('还没连')}</span>
        )}
        <span className="ml-auto">
          {w?.logged_in ? (
            <Button size="xs" variant="ghost" disabled={logout.isPending} onClick={() => logout.mutate()}>{t('断开')}</Button>
          ) : (
            <Button size="xs" variant="outline" disabled={busy || w?.installed === false} onClick={() => login.mutate()}>
              {busy ? <Loader2 data-slot="icon" className="animate-spin" /> : null}
              {busy ? t('等你在浏览器里登录…') : t('连接')}
            </Button>
          )}
        </span>
      </div>
      {session ? <button type="button" className="mt-1 text-[10px] text-muted-foreground hover:underline" onClick={() => setSession(null)}>{t('取消')}</button> : null}
      {w?.logged_in ? <WalletAssetsBlock /> : null}
    </div>
  );
}

const FAMILY_LABEL: Record<string, string> = { evm: 'EVM', bitcoin: 'BTC', solana: 'SOL', sui: 'SUI', xlayer: 'X Layer' };
function shortAddr(a: string): string { return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a; }

/**
 * 钱包资产:总估值 + 前几个币 + 充值地址。全部是 onchainos 只读命令(OKX 后端聚合),不接 RPC、不接浏览器钱包——
 * 订阅 ASP 的付费签名由 Agentic Wallet 自己在本机签,MetaMask 那条路 agent 签不了、桌面包里也没扩展可连。
 */
function WalletAssetsBlock() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['wallet', 'assets'], queryFn: () => api.walletAssets(), refetchInterval: 120_000, retry: 0 });
  const refresh = useMutation({ mutationFn: () => api.walletAssets(true), onSuccess: (res) => qc.setQueryData(['wallet', 'assets'], res), onError: (e: Error) => toast.error(e.message) });
  const [showAddr, setShowAddr] = useState(false);
  const a = q.data;
  if (!a) return <div className="mt-1.5 text-[10.5px] text-muted-foreground">{q.isError ? t('资产读不到') : t('读资产…')}</div>;
  const total = a.total_value_usd !== null ? Number(a.total_value_usd) : null;
  const copy = (addr: string) => { void navigator.clipboard?.writeText(addr).then(() => toast.success(t('已复制地址'))); };
  return (
    <div className="mt-1.5 flex flex-col gap-1 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="num text-foreground">{total !== null ? `$${total.toFixed(2)}` : '—'}</span>
        <span className="text-[10.5px] text-muted-foreground">{a.assets.length ? t('{n} 种资产', { n: a.assets.length }) : t('钱包是空的')}</span>
        <span className="ml-auto flex gap-1">
          <Button size="xs" variant="ghost" onClick={() => setShowAddr((v) => !v)}>{showAddr ? t('收起') : t('充值地址')}</Button>
          <Button size="xs" variant="ghost" disabled={refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? <Loader2 data-slot="icon" className="animate-spin" /> : t('刷新')}</Button>
        </span>
      </div>
      {a.assets.slice(0, 5).map((x, i) => (
        <div key={`${x.chain}-${x.symbol}-${i}`} className="num flex items-center gap-2 text-[10.5px] text-muted-foreground">
          <span className="w-14 truncate text-foreground">{x.symbol}</span>
          <span className="truncate">{x.balance}</span>
          {x.chain ? <span className="truncate">{x.chain}</span> : null}
          <span className="ml-auto">{x.value_usd !== null ? `$${Number(x.value_usd).toFixed(2)}` : ''}</span>
        </div>
      ))}
      {showAddr ? (
        <div className="flex flex-col gap-1 rounded-md border px-2 py-1.5">
          {a.addresses.slice(0, 5).map((r) => (
            <button key={r.family} type="button" className="num flex items-center gap-2 text-left text-[10.5px] hover:text-foreground" title={t('点击复制 {addr}', { addr: r.address })} onClick={() => copy(r.address)}>
              <span className="w-12 shrink-0 text-muted-foreground">{FAMILY_LABEL[r.family] ?? r.family}</span>
              <span className="truncate">{shortAddr(r.address)}</span>
              {r.chains.length > 1 ? <span className="ml-auto shrink-0 text-muted-foreground">{t('{n} 条链同地址', { n: r.chains.length })}</span> : null}
            </button>
          ))}
          <p className="text-[10px] text-muted-foreground">{t('往这些地址转账就是充值;EVM 系(ETH/BSC/Base/Arbitrum…)共用同一个地址。')}</p>
        </div>
      ) : null}
    </div>
  );
}

export function McpSection({ show }: { show: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['okx', 'mcp'], queryFn: api.okxMcp, enabled: show, retry: 0, staleTime: 60_000 });
  const reg = useMutation({
    mutationFn: api.okxMcpRegister,
    onSuccess: (res) => { qc.setQueryData(['okx', 'mcp'], res); toast.success(res.registered_in_claude ? t('已挂到 Claude Code') : t('没挂上')); },
    onError: (e: Error) => toast.error(t('挂接失败'), { description: e.message }),
  });
  if (!show) return null;
  const m = q.data ?? null;
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 text-[11px]">
        <Light on={!!m?.registered_in_claude} />
        <span className="font-medium">OKX MCP</span>
        <span className="text-muted-foreground">{m?.registered_in_claude ? t('Claude Code 里可用') : m?.cli_available ? t('还没挂到 Claude Code') : t('还没装,点挂接会一并安装')}</span>
        {m && !m.registered_in_claude ? (
          <Button size="xs" variant="outline" className="ml-auto" disabled={reg.isPending} onClick={() => reg.mutate()}>
            {reg.isPending ? <Loader2 data-slot="icon" className="animate-spin" /> : null}
            {t('挂接')}
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">{t('网关下单不经过 MCP(直接 spawn CLI 本地签名);MCP 是给 Claude Code 里的 agent 查账户、下单用的同一套 key。')}</p>
    </div>
  );
}

export function AccountsMenu() {
  const execQ = useExecutionQuery();
  const view = execQ.data;
  const walletQ = useQuery({ queryKey: ['wallet'], queryFn: () => api.wallet(), refetchInterval: 60_000, retry: 0 });
  const isOkx = view?.exchange === 'okx';
  const okxOk = !!view?.okx?.available;
  const walletOk = !!walletQ.data?.logged_in;
  const n = (isOkx ? Number(okxOk) : 0) + Number(walletOk);
  const total = isOkx ? 2 : 1;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline" className="border-transparent text-muted-foreground hover:text-foreground aria-expanded:text-foreground" title={t('OKX 交易账户 / Agentic 钱包 / MCP')}>
          <Wallet data-slot="icon" />
          <span className="num">{t('账户')} {n}/{total}</span>
          <span className="flex items-center gap-0.5">
            {isOkx ? <Light on={okxOk} warn={!okxOk} /> : null}
            <Light on={walletOk} />
          </span>
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        {isOkx ? <OkxSection view={view} /> : null}
        <WalletSection />
        <McpSection show={isOkx} />
      </PopoverContent>
    </Popover>
  );
}
