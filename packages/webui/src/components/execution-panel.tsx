/**
 * 「执行」卡(v3.3 操作台):选下单走哪个后端,以及 agent_mcp 模式下用哪个 CLI 子进程调
 * 币安 MCP、连没连上。
 *
 * 契约(网关侧另一位 agent 实现):
 *   GET  /api/execution        → ExecutionView
 *   POST /api/execution/check  → ExecutionView(重新探一次)
 *   POST /api/execution/connect→ { started, instructions, url? }
 *   POST /api/workflow         → 带 execution / exec_agent_cli / exec_agent_model,回 { workflow, errors }
 *   SSE  execution.changed     → App.tsx 失效 ['execution']
 *
 * v3.4「币安直连」(§9.8):网关自己拿 OAuth token 直调币安 MCP,不经过任何模型。工具名/参数事先没人知道,
 * 所以授权成功后网关跑 tools/list 并启发式给出「操作 → 工具」草案,人在这里核对(可改 JSON)、跑只读测试、
 * 确认之后 mcp 后端才可选:
 *   GET  /api/binance/map           → { map, tools_count, tools_at, proposal_notes, unmapped_required, … }
 *   POST /api/binance/map/propose   → 重新推断
 *   PUT  /api/binance/map           → 整体替换(改完回到 proposed,要重新确认)
 *   POST /api/binance/map/confirm   → 置 confirmed
 *   POST /api/binance/map/test      → 只跑 account/positions/open_orders/mark_price,永不写
 *
 * 2026-09-05:币安的同意页拒绝了网关自己的 OAuth 客户端(「The AI Agent you are using is not currently
 * supported (3346001)」——client_id 由币安白名单控制,Claude Code 在名单里、网关不在)。所以「币安直连」
 * 这一块整体休眠(代码留着、默认折叠),连接走 agent_mcp:点「用 Claude 登录币安」→ 网关弹一个终端跑
 * 交互式 `claude "/mcp"` → 选 binance-mcp-server → Authenticate → 回来点「检查连接」。
 *
 * 2026-09-20(OKX ATK fork):`view.exchange === 'okx'` 时整张卡换一副面孔——顶部「OKX 接入」块
 * (okx CLI 路径/版本、profile、模拟盘/实盘、可用性),Binance 那几块(直连/OAuth/工具映射/agent_mcp
 * 设置)全部不渲染。Binance 模式下这里和以前一字不差。老网关不返回 `exchange` → 按 binance 处理。
 *   POST /api/execution/okx/verified → ExecutionView(人工在模拟盘验完保护腿后手动标记)
 *
 * 网关还没接线时这些路由会 404:本卡片一律 retry:0 + 缺省兜底,只显示一行说明,不炸页面。
 *
 * 2026-09-25(信息架构第二批):OkxBlock / AccountModeSelect / 保护单标记 / 网络自检拆到 connect/blocks.tsx,
 * 由 #connect 接入页按步骤排;本文件只剩 ExecutionChannelPanel(下单通道 + 币安那几块)、顶栏 ExecutionBadge
 * (点击去 #connect)和 Agent 右栏的只读 ExecutionSummary。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Copy, FlaskConical, Loader2, Pencil, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type {
  BinanceMapResponse,
  BinanceMapTestResponse,
  BinanceOauthStatus,
  ExecutionBackend,
  ExecutionConnectionStatus,
  ExecutionView,
  McpOp,
  Workflow,
} from '@/api/types';
import { isProtectionVerified, NetCheckRow, SimpleModeWarning } from '@/components/connect/blocks';
import { useExecutionQuery } from '@/components/connect/use-execution';
import { ProtectionBlock } from '@/components/protection-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { acctLvLabel, backendLabel, fmtDateTime, marketLabel, relativeTime, useNow } from '@/lib/format';
import type { Market } from '@/api/types';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

/** ['execution'] 的标准订阅方式已搬到 connect/use-execution.ts;这里保留导出,老调用点不用改。 */
export { useExecutionQuery };

const CONNECTION_LABEL: Record<ExecutionConnectionStatus, string> = tmap({
  connected: '已连接',
  needs_auth: '要先登录',
  unavailable: '不可用',
  unknown: '未知',
});

function connectionClass(status: ExecutionConnectionStatus | undefined): string {
  if (status === 'connected') return 'border-up/40 text-up';
  if (status === 'needs_auth') return 'border-warn/40 text-warn';
  if (status === 'unavailable') return 'border-destructive/40 text-destructive';
  return 'text-muted-foreground';
}

/** 顶栏用的小徽章:执行后端一眼可见,点击去 #connect 接入页。 */
export function ExecutionBadge({ className }: { className?: string }) {
  const execQ = useExecutionQuery();
  const view = execQ.data;
  if (!view?.backend) return null;
  const conn = view.connection?.status;
  const isAgent = view.backend === 'agent_mcp';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            if (window.location.hash.slice(1).split('?')[0] !== 'connect') window.location.hash = 'connect';
          }}
          className={cn(
            'rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground',
            isAgent && conn === 'connected' && 'border-up/40 text-up',
            isAgent && conn === 'needs_auth' && 'border-warn/40 text-warn',
            isAgent && conn === 'unavailable' && 'border-destructive/40 text-destructive',
            className,
          )}
        >
          {backendLabel(view.backend)}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span className="num">
          {t('执行后端')} {backendLabel(view.backend)}
          {isAgent ? ` · ${view.agent?.cli ?? '—'} · ${CONNECTION_LABEL[conn ?? 'unknown']}` : ''}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** 13 个操作的中文名(顺序 = 网关 MCP_OPS 的顺序)。 */
const MCP_OP_LABEL: Record<McpOp, string> = tmap({
  account: '读账户',
  positions: '读持仓',
  open_orders: '读挂单',
  place_market: '市价开仓',
  place_limit: '限价开仓',
  place_stop_market_close: '止损(全平)',
  place_take_profit_close: '止盈(全平)',
  cancel_order: '撤一笔',
  cancel_all: '撤全部',
  get_order: '查订单',
  set_leverage: '改杠杆',
  set_margin_type: '改保证金模式',
  mark_price: '标记价格',
});
/** 缺了也能跑:行情退回公开 REST,持仓/挂单退回账户返回里的数组。 */
const MCP_OPTIONAL_OPS: McpOp[] = ['mark_price', 'positions', 'open_orders'];

/**
 * 「币安直连」区块:OAuth 状态 + 工具映射的推断 / 编辑 / 只读测试 / 确认。
 * 只读测试永远只跑 account、positions、open_orders、mark_price,不会下任何单。
 */
function BinanceDirectBlock({ oauth }: { oauth: BinanceOauthStatus }) {
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const [draft, setDraft] = useState<string | null>(null);
  const [tests, setTests] = useState<BinanceMapTestResponse | null>(null);
  // 3346001 之后这一块默认折叠:代码原样留着,等币安把网关加进白名单再展开。
  const [expanded, setExpanded] = useState(false);

  const mapQ = useQuery({ queryKey: ['binance-map'], queryFn: api.binanceMap, enabled: oauth.connected && expanded, retry: 0, staleTime: 15_000 });
  const map = mapQ.data?.map ?? null;
  const ops = mapQ.data?.ops ?? (Object.keys(MCP_OP_LABEL) as McpOp[]);

  const applied = (res: BinanceMapResponse) => {
    queryClient.setQueryData(['binance-map'], res);
    // 确认之后 mcp 选项才会变成可选,所以顺手让执行卡片重取。
    void queryClient.invalidateQueries({ queryKey: ['execution'] });
  };
  const onError = (err: unknown) => toast.error(t('操作失败'), { description: err instanceof Error ? err.message : String(err) });

  const propose = useMutation({
    mutationFn: api.binanceMapPropose,
    onSuccess: (res) => {
      applied(res);
      setTests(null);
      toast.success(t('重新推断完了:{n}/{total} 个操作有候选', { n: Object.keys(res.map?.ops ?? {}).length, total: res.ops.length }), { description: res.refreshed ? t('工具清单刷过了({n} 个)', { n: res.tools_count }) : t('用的是上次抓到的工具清单') });
    },
    onError,
  });
  const confirm = useMutation({
    mutationFn: api.binanceMapConfirm,
    onSuccess: (res) => {
      applied(res);
      toast.success(t('映射确认了,现在能切到「币安 MCP 直连」'));
    },
    onError,
  });
  const test = useMutation({
    mutationFn: () => api.binanceMapTest(),
    onSuccess: (res) => {
      setTests(res);
      if (res.ok_count === res.total) toast.success(t('只读测试全过({ok}/{total})', { ok: res.ok_count, total: res.total }));
      else toast.warning(t('只读测试过了 {ok}/{total}', { ok: res.ok_count, total: res.total }), { description: res.results.find((r) => !r.ok)?.error ?? undefined });
    },
    onError,
  });
  const save = useMutation({
    mutationFn: (json: string) => api.binanceMapPut(JSON.parse(json) as Record<string, unknown>),
    onSuccess: (res) => {
      applied(res);
      setDraft(null);
      setTests(null);
      toast.success(t('映射存好了(回到待确认,要再确认一次)'));
    },
    onError: (err) => toast.error(t('保存失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const busy = propose.isPending || confirm.isPending || test.isPending || save.isPending;
  const unmapped = mapQ.data?.unmapped_required ?? [];
  const statusBadge = !map ? { text: t('还没生成'), cls: 'text-muted-foreground' } : map.status === 'confirmed' ? { text: t('已确认'), cls: 'border-up/40 text-up' } : { text: t('待确认'), cls: 'border-warn/40 text-warn' };

  let draftInvalid: string | null = null;
  if (draft !== null) {
    try {
      JSON.parse(draft);
    } catch (e) {
      draftInvalid = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <div className="border-t">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        <span className="text-[12px] text-muted-foreground">{t('币安直连')}</span>
        <Badge variant="outline" className={cn('text-[10.5px]', !oauth.configured ? 'text-muted-foreground' : oauth.connected ? 'border-up/40 text-up' : 'border-warn/40 text-warn')}>
          {!oauth.configured ? t('没配置') : oauth.connected ? t('已授权') : t('没连上')}
        </Badge>
        {oauth.connected && oauth.expires_at ? (
          <span className="num text-[10.5px] text-muted-foreground" title={fmtDateTime(oauth.expires_at)}>
            {oauth.expires_at <= now ? t('已过期') : t('有效期到 {time}', { time: fmtDateTime(oauth.expires_at) })}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('收起') : t('展开')}
        </Button>
      </div>

      <div className="px-3 pb-2 text-[10.5px] leading-relaxed text-muted-foreground">
        {t('币安拒了网关自己的 OAuth 客户端(「not currently supported」3346001,client_id 要走它的白名单),这块先休眠;下单走上面的「用 Claude 登录币安」。')}
      </div>

      {expanded && !oauth.connected ? (
        <div className="px-3 pb-2 text-[10.5px] leading-relaxed text-muted-foreground">
          {t('还没有网关自己的 token,所以看不到工具清单。哪天币安把网关加进白名单:设')} <span className="num">TG_BINANCE_OAUTH_CLIENT_ID</span> +{' '}
          <span className="num">TG_BINANCE_OAUTH_FORCE=1</span>{t(',再点上面的连接按钮就会跳回币安同意页。')}
        </div>
      ) : null}

      {!expanded || !oauth.connected ? null : (
        <>
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
            <span className="num text-[10.5px] text-muted-foreground">{t('工具 {n} 个', { n: mapQ.data?.tools_count ?? 0 })}</span>
            {mapQ.data?.tools_at ? <span className="text-[10.5px] text-muted-foreground">{t('{ago}抓的', { ago: relativeTime(mapQ.data.tools_at, now) })}</span> : null}
            <Badge variant="outline" className={cn('text-[10.5px]', statusBadge.cls)}>
              {t('映射')}{statusBadge.text}
            </Badge>
            {map ? <span className="num text-[10.5px] text-muted-foreground">{Object.keys(map.ops).length}/{ops.length}</span> : null}
            {mapQ.isFetching ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
          </div>

          {unmapped.length ? (
            <div className="mx-3 mb-1.5 rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-[10.5px] text-warn">
              {t('还有必需的操作没映射')}:{unmapped.map((op) => MCP_OP_LABEL[op] ?? op).join('、')}{t(';补齐了才能确认。')}
            </div>
          ) : null}

          {map ? (
            <div className="mx-3 mb-2 overflow-hidden rounded-md border">
              <table className="w-full table-fixed text-[10.5px]">
                <tbody>
                  {ops.map((op) => {
                    const m = map.ops[op];
                    const optional = MCP_OPTIONAL_OPS.includes(op);
                    return (
                      <tr key={op} className="border-b last:border-b-0">
                        <td className="w-24 px-2 py-1 text-muted-foreground">{MCP_OP_LABEL[op] ?? op}</td>
                        <td className="num truncate px-2 py-1" title={m ? `${m.tool} ${JSON.stringify(m.args)}` : undefined}>
                          {m ? m.tool : <span className={optional ? 'text-muted-foreground' : 'text-destructive'}>{t('没映射')}{optional ? t('(可选)') : ''}</span>}
                        </td>
                        <td className="w-24 px-2 py-1 text-right">
                          {m?.missing?.length ? (
                            <span className="text-warn" title={t('缺参数:{list}', { list: m.missing.join('、') })}>
                              {t('缺 {n} 个参数', { n: m.missing.length })}
                            </span>
                          ) : m?.confidence !== undefined ? (
                            <span className={cn('num', m.confidence >= 0.8 ? 'text-muted-foreground' : 'text-warn')}>{Math.round(m.confidence * 100)}%</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-3 pb-2 text-[10.5px] leading-relaxed text-muted-foreground">{t('还没有映射,点「重新推断」让网关按工具清单生成一版草案。')}</div>
          )}

          {(mapQ.data?.proposal_notes ?? []).slice(0, 3).map((note, i) => (
            <div key={i} className="px-3 pb-1 text-[10.5px] leading-relaxed text-muted-foreground">
              · {note}
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => propose.mutate()}>
              {propose.isPending ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw data-slot="icon" />}
              {t('重新推断')}
            </Button>
            <Button size="xs" variant="outline" disabled={busy || !map} onClick={() => test.mutate()}>
              {test.isPending ? <Loader2 className="size-3 animate-spin" /> : <FlaskConical data-slot="icon" />}
              {t('只读测试')}
            </Button>
            <Button size="xs" variant="outline" disabled={busy || !map} onClick={() => setDraft(JSON.stringify(map, null, 2))}>
              <Pencil data-slot="icon" />
              {t('编辑 JSON')}
            </Button>
            <Button size="xs" variant={map && map.status !== 'confirmed' && !unmapped.length ? 'default' : 'outline'} disabled={busy || !map || map.status === 'confirmed' || unmapped.length > 0} onClick={() => confirm.mutate()}>
              {confirm.isPending ? <Loader2 className="size-3 animate-spin" /> : <Check data-slot="icon" />}
              {t('确认映射')}
            </Button>
          </div>

          {tests ? (
            <div className="mx-3 mb-2 space-y-1 rounded-md border px-2 py-1.5">
              <div className="text-[10.5px] text-muted-foreground">
                {t('只读测试')} <span className="num">{tests.symbol}</span> · {t('{ok}/{total} 通过(只读,没下任何单)', { ok: tests.ok_count, total: tests.total })}
              </div>
              {tests.results.map((r) => (
                <div key={r.op} className="flex items-start gap-1.5 text-[10.5px]">
                  <span className={cn('w-20 shrink-0', r.ok ? 'text-up' : 'text-destructive')}>
                    {MCP_OP_LABEL[r.op] ?? r.op} {r.ok ? '✓' : '✗'}
                  </span>
                  <span className="num min-w-0 flex-1 truncate text-muted-foreground" title={r.error ?? r.sample ?? ''}>
                    {r.error ?? r.sample ?? ''}
                  </span>
                  {r.ok ? <span className="num shrink-0 text-muted-foreground">{r.ms} ms</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('编辑工具映射')}</DialogTitle>
            <DialogDescription>
              {t('整体替换。args 是模板:值正好是')} <span className="num">{'${symbol}'}</span> {t('这种占位符时按原类型注入,这次没值的键会被丢掉;可用的占位符')}{' '}
              <span className="num">{(mapQ.data?.placeholders ?? []).join(' / ')}</span>{t('。保存后回到「待确认」,要重新确认才能下单。')}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={draft ?? ''} onChange={(e) => setDraft(e.target.value)} spellCheck={false} className="num max-h-[50vh] min-h-64 overflow-auto text-[11.5px] leading-relaxed" />
          {draftInvalid ? <div className="text-[11px] text-destructive">{t('JSON 语法错误')}:{draftInvalid}</div> : null}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setDraft(null)}>
              {t('取消')}
            </Button>
            <Button size="sm" disabled={save.isPending || draftInvalid !== null} onClick={() => draft !== null && save.mutate(draft)}>
              {save.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
              {t('保存')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * 执行通道(#connect 接入页用):选下单走哪个后端 + 币安 agent_mcp / 直连那几块。
 * OKX 的账户、账户模式、保护单、网络自检已拆成 connect/blocks.tsx 的独立块,由接入页按步骤排,这里不再画 OkxBlock。
 */
export function ExecutionChannelPanel() {
  const queryClient = useQueryClient();
  const execQ = useExecutionQuery();
  const view: ExecutionView | undefined = execQ.data;
  const now = useNow(10_000);

  const [instructions, setInstructions] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const serverModel = view?.agent?.model ?? null;
  const lastServerModelRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastServerModelRef.current === serverModel) return;
    lastServerModelRef.current = serverModel;
    setModel(serverModel ?? '');
  }, [serverModel]);

  const save = useMutation({
    mutationFn: (p: Partial<Workflow>) => api.patchWorkflow(p),
    onSuccess: (res) => {
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['execution'] });
      void queryClient.invalidateQueries({ queryKey: ['workflow'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      if ((res.errors ?? []).length > 0) toast.warning(t('{n} 项没保存', { n: res.errors.length }), { description: res.errors.join('; ') });
      else toast.success(t('已保存'));
    },
    onError: (err) => toast.error(t('保存失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const check = useMutation({
    mutationFn: api.executionCheck,
    onSuccess: (res) => {
      queryClient.setQueryData(['execution'], res);
      const status = res.connection?.status;
      if (status === 'connected') toast.success(res.exchange === 'okx' ? t('OKX 通道连上了') : t('币安 MCP 连上了'));
      else toast.warning(t('连接状态:{status}', { status: CONNECTION_LABEL[status ?? 'unknown'] }), { description: res.connection?.detail || undefined });
    },
    onError: (err) => toast.error(t('检查失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const connect = useMutation({
    mutationFn: api.executionConnect,
    onSuccess: (res) => {
      // url 有值 = 网关自己的 OAuth 授权页,直接开新标签;回调回网关后会广播 execution.changed
      if (res?.url) {
        window.open(res.url, '_blank', 'noopener,noreferrer');
        toast.info(t('币安授权页开好了,弄完回来点「检查连接」'));
        return;
      }
      if (res?.started) {
        // 网关弹了一个终端跑 `claude "/mcp"`:人在那个窗口里 Authenticate,回来点「检查连接」
        toast.info(t('终端弹出来了'), { description: res.instructions || t('在终端里选 binance-mcp-server → Authenticate,弄完回来点「检查连接」') });
        return;
      }
      setInstructions(res?.instructions || t('网关没返回操作说明。'));
    },
    onError: (err) => toast.error(t('连接失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const options = useMemo(() => view?.options ?? [], [view]);
  const canSwitch = view?.can_switch !== false;
  const backend = view?.backend;
  const conn = view?.connection;
  const modelDirty = (serverModel ?? '') !== model.trim();

  const pickBackend = (kind: ExecutionBackend) => {
    if (!canSwitch || kind === backend || save.isPending) return;
    save.mutate({ execution: kind });
  };
  const commitModel = () => {
    if (!modelDirty) return;
    save.mutate({ exec_agent_model: model.trim() === '' ? null : model.trim() });
  };

  if (execQ.isLoading) {
    return (
      <div className="space-y-2 p-3">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-2/3" />
      </div>
    );
  }
  if (!view) {
    return (
      <div className="p-3 text-[11.5px] leading-relaxed text-muted-foreground">
        {t('网关还没提供')} <span className="num">/api/execution</span>{t(',执行后端面板暂时用不了(接好线自动出现)。')}
        <div className="mt-1.5">
          <Button size="xs" variant="outline" onClick={() => void execQ.refetch()}>
            <RefreshCw data-slot="icon" />
            {t('重试')}
          </Button>
        </div>
      </div>
    );
  }

  // 老网关不返回 exchange → binance,界面和以前一字不差
  const isOkx = view.exchange === 'okx';

  return (
    <div id="execution-section" className="flex flex-col">
      {/* 09-07:推荐通道(官方 binance-cli)没接好时,接入步骤顶到最上面——用户先看到这个,再看别的。
          okx 的接入步骤已经在 OkxBlock 里了,这里不重复一遍 */}
      {options.filter((o) => o.recommended && !o.available && o.setup && !(isOkx && o.kind === 'okx')).map((o) => (
        <div key={`setup-${o.kind}`} className="mx-3 mt-2 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-2 text-[11.5px] leading-relaxed">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <Badge variant="outline" className="h-4 border-primary/50 px-1 text-[9.5px] text-primary">{t('推荐')}</Badge>
            {t('{name} 还没接好', { name: o.label })}
          </div>
          <pre className="num whitespace-pre-wrap font-sans text-[11px] text-muted-foreground">{o.setup}</pre>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        {options.length === 0 ? (
          <span className="num text-[12px]">{backendLabel(backend)}</span>
        ) : (
          [...options].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended))).map((opt) => {
            const active = opt.kind === backend;
            const disabled = !opt.available || !canSwitch || save.isPending;
            return (
              <Tooltip key={opt.kind}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      size="xs"
                      variant={active ? 'default' : 'outline'}
                      disabled={disabled && !active}
                      className={cn('rounded-full', active && 'pointer-events-none', opt.recommended && !active && 'border-primary/50')}
                      onClick={() => pickBackend(opt.kind)}
                    >
                      {opt.recommended ? <span className="mr-1 rounded-sm bg-primary/20 px-1 text-[9.5px] text-primary">{t('推荐')}</span> : null}
                      {opt.label || backendLabel(opt.kind)}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-64 text-[11.5px] leading-relaxed">
                  {!opt.available ? t('不可用:{why}', { why: opt.note || t('少凭证或者少 CLI') }) : !canSwitch ? view.switch_blocker || t('现在不能切') : opt.note || backendLabel(opt.kind)}
                </TooltipContent>
              </Tooltip>
            );
          })
        )}
        {save.isPending ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
      </div>

      {!canSwitch ? (
        <div className="mx-3 mb-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
          {view.switch_blocker || t('现在不能切执行后端')}
        </div>
      ) : null}

      {/* agent_mcp 是 Binance 专属通道:okx 模式下网关根本不注册它,这一整块也不渲染 */}
      {!isOkx && backend === 'agent_mcp' ? (
        <div className="border-t">
          {/* §9.20:止损保护验证状态 + 一键验证(真钱最小仓),阻断类告警的按钮是同一入口 */}
          <ProtectionBlock protection={view.protection} />
          {view.transport ? (
            <div
              className={cn('num mt-1.5 text-[11px]', view.transport.transport_errors > 0 ? 'text-warn' : 'text-muted-foreground')}
              title={view.transport.last_error ? t('最近一次:{detail}', { detail: view.transport.last_error }) : t('最近 30 分钟没出现连接被掐或超时')}
            >
              {t('网络:最近 {min} 分钟 {runs} 次调用,{bad} 次连接被掐或超时', { min: Math.round(view.transport.window_ms / 60_000), runs: view.transport.runs, bad: view.transport.transport_errors })}
              {view.transport.transport_errors > 0 ? ` · ${t('回执丢了会自动查、自动重发,不会误平仓;老是这样就看看代理是不是掐长连接')}` : ''}
            </div>
          ) : null}
          {view.backend === 'agent_mcp' ? <NetCheckRow /> : null}
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <Label className="shrink-0 text-[12px] font-normal text-muted-foreground">CLI</Label>
            <Select
              value={view.agent?.cli ?? 'claude'}
              onValueChange={(v) => save.mutate({ exec_agent_cli: v as 'claude' | 'codex' })}
              disabled={save.isPending}
            >
              <SelectTrigger size="sm" className="h-7 w-28 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">claude</SelectItem>
                <SelectItem value="codex">codex</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <Label className="shrink-0 text-[12px] font-normal text-muted-foreground">
              {t('模型')}
              <span className="ml-1 text-[10px] text-muted-foreground/70">{view.agent?.model_note ?? t('留空 = 用这个 CLI 的默认')}</span>
            </Label>
            <div className="flex min-w-0 items-center gap-1.5">
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={commitModel}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitModel();
                  }
                }}
                placeholder="sonnet / gpt-5 …"
                className="num h-7 w-40 text-[12px]"
              />
              {modelDirty ? (
                <Button size="xs" variant="outline" disabled={save.isPending} onClick={commitModel}>
                  {t('保存')}
                </Button>
              ) : null}
            </div>
          </div>

          {view.agent?.command ? (
            <div className="flex items-center gap-2 px-3 pb-2 text-[10.5px] text-muted-foreground">
              <span className="shrink-0">{t('启动命令')}</span>
              <span className="num min-w-0 flex-1 truncate text-foreground" title={view.agent.resolved?.detail ?? ''}>
                {view.agent.command}
              </span>
              {view.agent.resolved ? (
                <span className={cn('shrink-0', view.agent.resolved.ok ? 'text-muted-foreground' : 'text-destructive')}>
                  {view.agent.resolved.ok ? (view.agent.resolved.via === 'shell' ? t('经 shell') : t('直接起')) : t('找不到')}
                </span>
              ) : null}
              <span className="shrink-0">· {t('在「设置」页改')}</span>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
            <Badge variant="outline" className={cn('text-[10.5px]', connectionClass(conn?.status))}>
              {CONNECTION_LABEL[conn?.status ?? 'unknown']}
            </Badge>
            {conn?.checked_at ? <span className="text-[10.5px] text-muted-foreground">{t('{ago}检查的', { ago: relativeTime(conn.checked_at, now) })}</span> : null}
            {conn?.detail ? (
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground" title={conn.detail}>
                {conn.detail}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
            <Button size="xs" variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
              {t('检查连接')}
            </Button>
            <Button size="xs" variant="outline" disabled={connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
              {t('用 Claude 登录币安')}
            </Button>
            {view.agent?.server_name ? (
              <span className="num truncate text-[10.5px] text-muted-foreground" title={view.agent?.url ?? ''}>
                {view.agent.server_name}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {!isOkx && view.oauth ? <BinanceDirectBlock oauth={view.oauth} /> : null}

      <div className="border-t px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
        {isOkx
          ? t('okx = 网关直接调官方 okx CLI 下单(本地签名,key 只留在本机,不经过任何模型);开仓和止损是一次原子请求;纸面不花钱')
          : t('agent_mcp = 每笔下单由 claude 子进程代调币安官方 MCP(默认 sonnet,读账户有缓存);mcp 直连要币安先把网关加进白名单(3346001),暂时用不了;纸面 / 模拟盘不花钱')}
      </div>

      <Dialog open={instructions !== null} onOpenChange={(open) => !open && setInstructions(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('手动完成币安授权')}</DialogTitle>
            <DialogDescription>{t('在终端里按下面的步骤走一遍,弄完回来点「检查连接」。')}</DialogDescription>
          </DialogHeader>
          <pre className="num max-h-60 overflow-auto rounded-md bg-muted/60 p-2.5 text-[11.5px] leading-relaxed whitespace-pre-wrap">{instructions}</pre>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(instructions ?? '')
                  .then(() => toast.success(t('已复制')))
                  .catch(() => toast.error(t('复制失败,自己选中复制吧')));
              }}
            >
              <Copy data-slot="icon" />
              {t('复制')}
            </Button>
            <Button size="sm" onClick={() => setInstructions(null)}>
              {t('知道了')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Agent 右栏「执行」tab 的只读摘要(2026-09-25 ③-1:写操作都搬到 #connect):
 * 后端 + 连接灯、OKX 账户 / 模拟盘、账户模式、可交易市场、保护单、现货持币,最后一个「去接入页」链接。
 */
export function ExecutionSummary() {
  const execQ = useExecutionQuery();
  const view = execQ.data;
  if (execQ.isLoading) {
    return (
      <div className="space-y-2 p-3">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-2/3" />
      </div>
    );
  }
  if (!view) {
    return (
      <div className="p-3 text-[11.5px] leading-relaxed text-muted-foreground">
        {t('网关还没提供')} <span className="num">/api/execution</span>{t(',执行后端面板暂时用不了(接好线自动出现)。')}
      </div>
    );
  }
  const isOkx = view.exchange === 'okx';
  const okx = view.okx ?? null;
  const conn = view.connection?.status;
  const { verified, verifying } = isProtectionVerified(view);
  const row = (k: string, v: ReactNode, cls?: string) => (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className="w-20 shrink-0 text-[10.5px] text-muted-foreground">{k}</span>
      <span className={cn('num min-w-0 flex-1 truncate text-[11.5px]', cls)}>{v}</span>
    </div>
  );
  return (
    <div id="execution-section" className="flex flex-col divide-y text-[11.5px]">
      {row(t('执行后端'), `${backendLabel(view.backend)}${!isOkx && view.backend === 'agent_mcp' ? ` · ${CONNECTION_LABEL[conn ?? 'unknown']}` : ''}`, !isOkx && view.backend === 'agent_mcp' ? connectionClass(conn) : undefined)}
      {isOkx ? row(t('OKX 账户'), okx?.available ? `${okx.demo !== false ? t('模拟盘') : t('实盘')}${okx.profile ? ` · ${okx.profile}` : ''}` : t('还没连'), okx?.available ? (okx.demo !== false ? 'text-up' : 'text-destructive') : 'text-warn') : null}
      {isOkx && okx?.available ? row(t('账户模式'), acctLvLabel(okx.acct_lv, okx.acct_lv_label), okx.acct_lv === 1 ? 'text-warn' : undefined) : null}
      {isOkx && okx?.available && okx.markets_available ? row(t('可交易市场'), (['perp', 'spot'] as Market[]).filter((m) => okx.markets_available!.includes(m)).map((m) => marketLabel(m)).join(' / ') || '—') : null}
      {view.protection ? row(t('保护单'), verified ? t('已验证') : verifying ? t('验证中') : t('还没验证:闸门不放开新开仓'), verified ? 'text-up' : verifying ? undefined : 'text-warn') : null}
      {isOkx && okx?.spot_holdings && okx.spot_holdings.length > 0 ? (
        <div className="px-3 py-1.5">
          <div className="mb-1 text-[10.5px] text-muted-foreground">{t('现货持币')}</div>
          <div className="flex flex-wrap gap-1.5">
            {okx.spot_holdings.filter((h) => h.usdt_value === null || Number(h.usdt_value) >= 0.01).map((h) => (
              <Badge key={h.ccy} variant="outline" className="num text-[10.5px] text-muted-foreground" title={t('总量 {t} · 可用 {a}', { t: h.total, a: h.available })}>
                {h.ccy} {h.total}
                {h.usdt_value ? <span className="ml-1 text-foreground">≈ {Number(h.usdt_value).toFixed(2)} U</span> : null}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      <SimpleModeWarning view={view} className="mx-3 my-2" />
      <div className="px-3 py-2">
        <a href="#connect" className="inline-flex items-center gap-1 text-[11.5px] text-primary hover:underline">
          {t('账户、账户模式、保护单、网络自检都在接入页改')}
          <ArrowRight className="size-3" />
        </a>
      </div>
    </div>
  );
}
