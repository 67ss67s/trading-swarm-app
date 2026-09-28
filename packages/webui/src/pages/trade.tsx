/**
 * 交易页(docs/demo/v2-agent-loop.md §7;09-27 三层改版见 components/trade/*,契约 §9.56):
 * 顶 = 执行通道 · ①来源 → ②判断 → ③风控与执行 摘要胶囊(点开右栏 Risk)· 急停 / 全部暂停 / 日亏停(正常不显示)
 * 左 = ① Sources:AI Scan 卡 + 每个策略运行一张卡(判断方式、今日漏斗、被挡在哪层什么原因;点卡 = 线程只看它);
 *      底部「手动下单」展开区(原下单面板,单向账户,开多/开空 + 只减仓 = 平多/平空)
 * 中 = 策略线程,分「需要处理 / 持仓中 / 待入场」三组;提交结果未知(卡住的挂单)单独归到「需要处理」
 * 右上 = 图表 / 线程 / Jev 判断流 / Agent 对话 / 风控与执行(所有来源共用,就地改 + 让 agent 调)
 * 底 = 持仓 / 挂单(提交结果未知的入场单单列在真实挂单上面)
 *
 * 严格按 App.tsx 顶部注释的 react-query key 约定发 useQuery,不自己开 SSE 连接——
 * App.tsx 的单一 SSE 连接会失效 / 更新这些 key,页面自动跟着活(Jev 判断流用它自己的共享 SSE)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, strategyRunsApi } from '@/api/client';
import type { BasisView, Direction, ManualOrderRequest, Market, MarketView, Overview, OpenOrderView, PositionView, StrategyRunPatch, StrategyThread, SymbolInfo } from '@/api/types';
import { Workspace, Pane } from '@/components/pane';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TradeChart } from '@/components/trade-chart';
import { ChartSymbolList } from '@/components/chart-symbol-list';
import { ChatPanel } from '@/components/chat-panel';
import { SymbolPicker } from '@/components/symbol-picker';
import { ChevronDown, ChevronLeft, ChevronRight, TriangleAlert, X } from 'lucide-react';
import { useAgentStrategy } from '@/api/agent-strategy';
import { useJudgeLive } from '@/api/judge-live';
import { TRADING_SOURCES_KEY, tradingApi, useExecutionPolicy, useTradingSources } from '@/api/trading';
import { RUN_MODE_LABEL, useStrategyRuns } from '@/components/my-strategies/run-panel';
import { JudgeLiveFeed } from '@/components/judge-live';
import { SESSION_KEY } from '@/components/chat-session-bar';
import { TradeContextBar } from '@/components/trade/context-bar';
import { ThreadRow } from '@/components/trade/thread-row';
import { ThreadDetail } from '@/components/trade/thread-detail';
import { SourcesColumn } from '@/components/trade/sources-column';
import { RiskPanel } from '@/components/trade/risk-panel';
import { useTradeWriteLock } from '@/components/trade/write-lock';
import { groupThreads, judgeForThread, matchesOriginFilter, originCounts, sameOriginFilter, threadForOrder, threadHealth, threadOrigin, unknownEntries, type OriginFilter, type ThreadHealth, type ThreadOrigin } from '@/components/trade/logic';
import { channelOf, riskSummary, sourceCards, tunePrompt } from '@/components/trade/sources-logic';
import { stageAgentQuestion } from '@/lib/ask-agent';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';
import {
  DAILY_REGIME_LABEL,
  SESSION_LABEL,
  THREAD_STATUS_LABEL,
  dailyRegimeClass,
  directionLabel,
  directionText,
  fmtPrice,
  fmtQty,
  fmtSigned,
  pnlText,
  backendLabel,
  marketLabel,
  marketOf,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { quadrantOf, quadrantSpec } from '@/domain/hedgeOrderIntent';

// ---------------------------------------------------------------------------
// 小工具

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "0.001" → 3;"1" / "1.0" → 0。用来把杠杆×保证金算出来的数量向下取整到交易所允许的步长。 */
function decimalsOf(stepSize: string | undefined | null): number {
  if (!stepSize) return 0;
  const s = stepSize.trim();
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  const frac = s.slice(dot + 1).replace(/0+$/, '');
  return frac.length;
}

function floorToDecimals(qty: number, decimals: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const factor = 10 ** Math.max(0, decimals);
  return Math.floor(qty * factor + 1e-9) / factor;
}

function marketForSymbol(overview: Overview | undefined, symbol: string): MarketView | undefined {
  if (!overview || !symbol) return undefined;
  if (overview.markets[symbol]) return overview.markets[symbol];
  if (overview.market?.symbol === symbol) return overview.market;
  return undefined;
}

// ---------------------------------------------------------------------------
// 左:下单面板

function OrderPanel({
  symbols,
  selectedSymbol,
  onSelectSymbol,
  watchlist,
  threadSymbols,
  market,
  tradeMarket,
  onTradeMarket,
  marketsEnabled,
  marketsSupported,
  okxSimpleMode,
  okxDemo,
  basis,
  side,
  onSide,
  reduceOnly,
  onReduceOnly,
  orderType,
  onOrderType,
  price,
  onPrice,
  marginUsdt,
  onMarginUsdt,
  leverage,
  onLeverage,
  marginMode,
  onMarginMode,
  tp,
  onTp,
  sl,
  onSl,
  onSubmit,
  submitting,
}: {
  symbols: SymbolInfo[];
  selectedSymbol: string;
  onSelectSymbol: (s: string) => void;
  watchlist: string[];
  threadSymbols: string[];
  market: MarketView | undefined;
  /** §9.40:下单面板选的市场(perp|spot) */
  tradeMarket: Market;
  onTradeMarket: (m: Market) => void;
  /** workflow.markets(允许交易);不在里面的置灰 */
  marketsEnabled: Market[];
  /** execution.markets_supported(通道/账户模式支持);不在里面的置灰并提示 */
  marketsSupported: Market[];
  /** okx 通道且 acctLv=1:永续那格点击弹切换指引而不是死按钮 */
  okxSimpleMode: boolean;
  /** okx profile 是模拟盘:账户模式要在模拟盘里切,弹框文案与链接不同 */
  okxDemo: boolean;
  basis: BasisView | null | undefined;
  side: Direction;
  onSide: (s: Direction) => void;
  reduceOnly: boolean;
  onReduceOnly: (v: boolean) => void;
  orderType: 'market' | 'limit';
  onOrderType: (t: 'market' | 'limit') => void;
  price: string;
  onPrice: (v: string) => void;
  marginUsdt: string;
  onMarginUsdt: (v: string) => void;
  leverage: string;
  onLeverage: (v: string) => void;
  marginMode: 'cross' | 'isolated';
  onMarginMode: (v: 'cross' | 'isolated') => void;
  tp: string;
  onTp: (v: string) => void;
  sl: string;
  onSl: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const symbolInfo = symbols.find((s) => s.symbol === selectedSymbol);
  const refPrice = market ? Number(market.last) : NaN;
  const isSpot = tradeMarket === 'spot';
  const marginNum = Number(marginUsdt);
  const leverageNum = isSpot ? 1 : Number(leverage);
  const notional = Number.isFinite(marginNum) && Number.isFinite(leverageNum) ? marginNum * leverageNum : 0;
  const stepDecimals = decimalsOf(symbolInfo?.step_size);
  const rawQty = Number.isFinite(refPrice) && refPrice > 0 ? notional / refPrice : 0;
  const qty = floorToDecimals(rawQty, stepDecimals);
  const liqPrice =
    !isSpot && Number.isFinite(refPrice) && refPrice > 0 && leverageNum > 0
      ? side === 'long'
        ? refPrice * (1 - (1 / leverageNum) * 0.9)
        : refPrice * (1 + (1 / leverageNum) * 0.9)
      : null;

  const quadrant = quadrantSpec(quadrantOf(side, reduceOnly));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-[12.5px]">
      <MarketToggle value={tradeMarket} onChange={onTradeMarket} enabled={marketsEnabled} supported={marketsSupported} okxSimpleMode={okxSimpleMode} okxDemo={okxDemo} />
      {/* 09-25 ③-2:选着永续但账户是简单模式——下单会被 OKX 拒(51010),原因直接写在这里 */}
      {tradeMarket === 'perp' && okxSimpleMode ? (
        <div className="rounded-sm border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warn" data-testid="trade-simple-mode-warning">
          {t('OKX 账户是简单模式,永续单会被拒(51010);现货照常')}
          <a href="#connect" className="ml-1 underline">
            {t('去接入页切换 →')}
          </a>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <Label htmlFor="trade-symbol">
          {t('币种')}
          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
            {isSpot ? t('{n} 个 USDT 现货对都能交易', { n: symbols.length }) : t('{n} 个 USDT 永续都能交易', { n: symbols.length })}
          </span>
        </Label>
        <div className="flex items-center gap-2">
          <SymbolPicker symbols={symbols} value={selectedSymbol} onChange={onSelectSymbol} watchlist={watchlist} threadSymbols={threadSymbols} className="min-w-0 flex-1" />
          <span className="num shrink-0 text-[12.5px] font-semibold">{market ? fmtPrice(market.last) : '—'}</span>
        </div>
        <BasisStrip basis={basis} />
        {/* 09-25 ③-11:手动下单可以选全市场任意币,但不在观察列表的币 agent 不盯 */}
        {selectedSymbol && !watchlist.includes(selectedSymbol) ? (
          <div className="text-[10.5px] text-muted-foreground" data-testid="trade-not-in-watchlist">
            {t('agent 不管这个币;要让 agent 盯它,去观察列表')}
            <a href="#watch" className="ml-1 text-primary hover:underline">
              {t('去观察列表 →')}
            </a>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        {isSpot ? (
          /* 现货只有买入持有 / 卖出:side 恒 long,reduceOnly 表示卖出(§9.40 action close) */
          <div className="grid grid-cols-2 gap-1.5">
            <Button type="button" variant={!reduceOnly ? 'default' : 'outline'} className={cn(!reduceOnly && 'bg-up text-white hover:bg-up/85')} onClick={() => onReduceOnly(false)}>
              {t('买入')}
            </Button>
            <Button type="button" variant={reduceOnly ? 'default' : 'outline'} className={cn(reduceOnly && 'bg-down text-white hover:bg-down/85')} onClick={() => onReduceOnly(true)}>
              {t('卖出')}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              type="button"
              variant={side === 'long' ? 'default' : 'outline'}
              className={cn(side === 'long' && 'bg-up text-white hover:bg-up/85')}
              onClick={() => onSide('long')}
            >
              {reduceOnly ? t('平多') : t('开多')}
            </Button>
            <Button
              type="button"
              variant={side === 'short' ? 'default' : 'outline'}
              className={cn(side === 'short' && 'bg-down text-white hover:bg-down/85')}
              onClick={() => onSide('short')}
            >
              {reduceOnly ? t('平空') : t('开空')}
            </Button>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="num text-[10.5px] text-muted-foreground">{isSpot ? (reduceOnly ? t('卖出持有的现货(不填数量 = 全部)') : t('用 USDT 买入现货,无杠杆、不能做空')) : quadrant.hint}</span>
          {isSpot ? null : (
            <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground select-none">
              {t('只减仓')}
              <Switch checked={reduceOnly} onCheckedChange={onReduceOnly} />
            </label>
          )}
        </div>
      </div>

      <Tabs value={orderType} onValueChange={(v) => onOrderType(v as 'market' | 'limit')}>
        <TabsList className="w-full">
          <TabsTrigger value="market" className="flex-1">
            {t('市价')}
          </TabsTrigger>
          <TabsTrigger value="limit" className="flex-1">
            {t('限价')}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {orderType === 'limit' ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="trade-price">{t('价格')}</Label>
          <Input id="trade-price" className="num" inputMode="decimal" value={price} onChange={(e) => onPrice(e.target.value)} placeholder={t('限价价格')} />
        </div>
      ) : null}

      {isSpot ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="trade-margin">{reduceOnly ? t('卖出金额(USDT,可选)') : t('花费(USDT)')}</Label>
          <Input id="trade-margin" className="num" inputMode="decimal" value={marginUsdt} onChange={(e) => onMarginUsdt(e.target.value)} placeholder={reduceOnly ? t('留空 = 全部卖出') : undefined} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="trade-margin">{t('保证金(USDT)')}</Label>
              <Input id="trade-margin" className="num" inputMode="decimal" value={marginUsdt} onChange={(e) => onMarginUsdt(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="trade-leverage">{t('杠杆')}</Label>
              <Input id="trade-leverage" className="num" inputMode="decimal" value={leverage} onChange={(e) => onLeverage(e.target.value)} />
            </div>
          </div>

          <ToggleGroup
            type="single"
            variant="outline"
            value={marginMode}
            onValueChange={(v) => v && onMarginMode(v as 'cross' | 'isolated')}
            className="w-full"
          >
            <ToggleGroupItem value="cross" className="flex-1">
              {t('全仓')}
            </ToggleGroupItem>
            <ToggleGroupItem value="isolated" className="flex-1">
              {t('逐仓')}
            </ToggleGroupItem>
          </ToggleGroup>
        </>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="trade-tp">{t('止盈(可选)')}</Label>
          <Input id="trade-tp" className="num" inputMode="decimal" value={tp} onChange={(e) => onTp(e.target.value)} placeholder={t('价格')} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="trade-sl">{isSpot ? t('止损(可选,不强制)') : t('止损(可选)')}</Label>
          <Input id="trade-sl" className="num" inputMode="decimal" value={sl} onChange={(e) => onSl(e.target.value)} placeholder={t('价格')} />
        </div>
      </div>

      <Separator />

      <div className="num flex flex-col gap-1 text-[11.5px] text-muted-foreground">
        <div className="flex items-center justify-between">
          <span>{t('名义')}</span>
          <span className="text-foreground">{notional > 0 ? `${notional.toFixed(2)} USDT` : '—'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>{t('数量')}</span>
          <span className="text-foreground">{qty > 0 ? qty.toFixed(stepDecimals) : '—'}</span>
        </div>
        {isSpot ? null : (
          <div className="flex items-center justify-between">
            <span>{t('预估强平价')}</span>
            <span className="text-foreground">{liqPrice ? fmtPrice(liqPrice) : '—'}</span>
          </div>
        )}
      </div>

      <Button onClick={onSubmit} disabled={submitting || !marketsSupported.includes(tradeMarket) || !marketsEnabled.includes(tradeMarket)} className="mt-1">
        {submitting ? t('提交中…') : isSpot ? (reduceOnly ? t('提交卖出') : t('提交买入')) : reduceOnly ? t('提交平仓') : t('提交开仓')}
      </Button>
    </div>
  );
}

/**
 * §9.40:Perps / Spot 分段开关。工作流没开的置灰;通道/账户模式不支持的置灰并说原因。
 * OKX 简单模式(acctLv=1)下点「永续」不是死按钮:弹框给 OKX 账户模式页的链接,并每 5 秒轮询
 * `okx/account-level/refresh`,用户在那边切完,这边自动亮起来并切过去——不用刷新、不会再撞 51010。
 */
function MarketToggle({ value, onChange, enabled, supported, okxSimpleMode, okxDemo }: { value: Market; onChange: (m: Market) => void; enabled: Market[]; supported: Market[]; okxSimpleMode: boolean; okxDemo: boolean }) {
  const queryClient = useQueryClient();
  const [ask, setAsk] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollStart = useRef(0);
  // onChange 每次渲染都是新函数;SSE 一来就重渲染,放进 effect 依赖会让 5 秒的定时器永远被重置——用 ref 稳住
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const reason = (m: Market): string | null => {
    if (!supported.includes(m)) return m === 'perp' ? (okxSimpleMode ? t('OKX 账户是简单模式,永续不可用;点这里看怎么切') : t('当前通道不支持永续')) : t('当前通道不支持现货');
    if (!enabled.includes(m)) return t('工作流没开这个市场(接入 → 交易市场与风险)');
    return null;
  };
  // 轮询:切完模式网关重读 acctLv,markets_supported 里出现 perp 就停,并把面板切到永续;最多等 10 分钟
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      void api
        .okxRefreshAccountLevel()
        .then((view) => {
          queryClient.setQueryData(['execution'], view);
          if ((view.markets_supported ?? []).includes('perp')) {
            setPolling(false);
            setAsk(false);
            onChangeRef.current('perp');
            toast.success(t('OKX 账户模式已切换,永续可用了'));
          } else if (Date.now() - pollStart.current > 10 * 60_000) {
            setPolling(false);
          }
        })
        .catch(() => {
          /* 网关暂时读不到就下一轮再试 */
        });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [polling, queryClient]);
  // 用户从别处(执行页刷新/重启网关)切好了,这里也跟着收起弹框
  useEffect(() => {
    if (supported.includes('perp') && (ask || polling)) {
      setAsk(false);
      setPolling(false);
    }
  }, [supported, ask, polling]);
  const openGuide = () => {
    setAsk(true);
    pollStart.current = Date.now();
    setPolling(true);
  };
  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        value={value}
        onValueChange={(v) => {
          if (!v) return;
          const m = v as Market;
          if (m === 'perp' && okxSimpleMode && !supported.includes('perp')) {
            openGuide();
            return;
          }
          onChange(m);
        }}
        className="w-full"
      >
        {(['perp', 'spot'] as Market[]).map((m) => {
          const why = reason(m);
          return (
            <ToggleGroupItem key={m} value={m} className={cn('flex-1', why && 'opacity-60')} title={why ?? undefined}>
              {m === 'perp' ? t('永续') : t('现货')}
              {why ? <span className="ml-1 text-[9.5px] text-warn">{m === 'perp' && okxSimpleMode ? t('需切换模式') : t('不可用')}</span> : null}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <ConfirmDialog
        open={ask}
        title={t('把 OKX 账户切到可交易永续的模式')}
        summary={t('去 OKX 切换')}
        busy={false}
        onCancel={() => {
          setAsk(false);
          setPolling(false);
        }}
        onConfirm={() => {
          window.open(okxAccountModeUrl(okxDemo), '_blank', 'noopener');
        }}
      >
        <p className="text-muted-foreground">
          {okxDemo
            ? t('你的模拟盘账户现在是「简单模式」,OKX 不接受永续单(错误 51010)。模拟盘和实盘的账户模式是分开的,要在模拟盘里切:OKX 顶部「交易」→「模拟交易」进入模拟盘 → 交易页右上角 ⚙ → 账户模式 → 「单币种保证金模式」。')
            : t('你的账户现在是「简单模式」,OKX 不接受永续单(错误 51010)。OKX 没有开放给 CLI 的切换接口,要在 OKX 网页/App 切一次:交易页右上角 ⚙ → 账户模式 → 「单币种保证金模式」(首次会要做一次合约风险测评)。')}
        </p>
        <p className="mt-1 text-muted-foreground">
          {polling ? t('切完不用回来点任何东西:这边每 5 秒探一次,模式一变永续就自动亮起并切过去。') : t('点「去 OKX 切换」打开 OKX 页面。')}
        </p>
        {polling ? (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="inline-block size-2 animate-pulse rounded-full bg-warn" />
            {t('等待 OKX 账户模式变化…')}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

/**
 * OKX 账户模式在交易页右上角 ⚙ 的「账户模式」里切;模拟盘与实盘是两套账户、两套页面。
 * 模拟盘没有稳定的直链(/trade-demo* 全 404,入口只在顶部菜单「交易 → 模拟交易」),先落到交易页由用户切进模拟盘;
 * 拿到真实链接后改 OKX_DEMO_TRADE_URL 即可。
 */
const OKX_DEMO_TRADE_URL: string | null = null;
function okxAccountModeUrl(demo: boolean): string {
  if (demo && OKX_DEMO_TRADE_URL) return OKX_DEMO_TRADE_URL;
  return 'https://www.okx.com/trade-swap/btc-usdt-swap';
}

/** §9.40 基差条:现货 vs 永续 + 资金费年化——期现套利的地基;老网关 404 就不显示。 */
function BasisStrip({ basis }: { basis: BasisView | null | undefined }) {
  if (!basis) return null;
  const pct = Number(basis.basis_pct);
  const apr = Number(basis.funding_annualized_pct);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="num flex items-center gap-2 text-[10.5px] text-muted-foreground">
          <span>{t('基差')}</span>
          <span className={cn('font-medium', pct > 0 ? 'text-up' : pct < 0 ? 'text-down' : 'text-foreground')}>{fmtSigned(basis.basis_pct)}%</span>
          <span>{t('资金费年化')}</span>
          <span className={cn('font-medium', apr > 0 ? 'text-up' : apr < 0 ? 'text-down' : 'text-foreground')}>{fmtSigned(basis.funding_annualized_pct)}%</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72 text-[11.5px] leading-relaxed">
        <div>{t('现货')} {fmtPrice(basis.spot_last)} · {t('永续标记')} {fmtPrice(basis.perp_mark)} · {t('基差')} {basis.basis}</div>
        <div className="mt-1 text-muted-foreground">{t('资金费率 {r},每 {h} 小时;正基差 + 正资金费 = 现货多 / 永续空 的期现套利方向', { r: basis.funding_rate, h: Math.round(basis.funding_interval_ms / 3_600_000) })}</div>
      </TooltipContent>
    </Tooltip>
  );
}

/** 图表标题旁的日线状态 / 时段徽章(GET /api/market/regime;老网关没有这个接口就不显示)。 */
function RegimeBadge({ symbol }: { symbol: string }) {
  const regimeQ = useQuery({ queryKey: ['regime', symbol], queryFn: () => api.regime(symbol), enabled: !!symbol, retry: 0, staleTime: 60_000, refetchInterval: 120_000 });
  const r = regimeQ.data;
  if (!r) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1 animate-in fade-in duration-300">
          {r.daily ? (
            <Badge variant="outline" className={cn('h-5 px-1.5 text-[10.5px]', dailyRegimeClass(r.daily.regime))}>
              {DAILY_REGIME_LABEL[r.daily.regime] ?? r.daily.regime}
            </Badge>
          ) : null}
          <Badge variant="outline" className={cn('h-5 px-1.5 text-[10.5px] text-muted-foreground', r.session.name === 'us_open_window' && 'border-warn/40 text-warn')}>
            {SESSION_LABEL[r.session.name] ?? r.session.name}
            {r.session.minutes_to_us_open !== null && r.session.minutes_to_us_open > 0 && r.session.minutes_to_us_open <= 60 ? <span className="num ml-1">{t('{n} 分钟后开盘', { n: r.session.minutes_to_us_open })}</span> : null}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72 text-[11.5px] leading-relaxed">
        {r.daily ? <div>{r.daily.text}</div> : null}
        <div className="mt-1 text-muted-foreground">{r.session.text}</div>
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// 底:持仓 / 挂单

/**
 * 持仓表多一列「管理」:有线程的显示线程状态;没有线程的(手动单、撤单竞态孤立的仓)给「交给 agent」——
 * 接管后建 in_position 线程进复查循环。止损优先用交易所上已挂的,没有就要人填。
 */
/** 名义仓位(U)= 数量 × 标记价;杠杆下真正占用的保证金 ≈ 名义 / 杠杆。 */
function notionalUsdt(p: PositionView): string {
  const n = Math.abs(Number(p.qty) * Number(p.mark_price));
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}
function marginUsdt(p: PositionView): string {
  const n = Math.abs(Number(p.qty) * Number(p.mark_price));
  const lev = marketOf(p) === 'spot' ? 1 : Number(p.leverage) || 1;
  return Number.isFinite(n) ? (n / lev).toFixed(2) : '—';
}

function PositionsTable({ positions, threads, openOrders, originOf }: { positions: PositionView[]; threads: StrategyThread[]; openOrders: OpenOrderView[]; originOf: (t: StrategyThread) => ThreadOrigin }) {
  const queryClient = useQueryClient();
  const [adopting, setAdopting] = useState<PositionView | null>(null);
  const [stopText, setStopText] = useState('');
  const [tpText, setTpText] = useState('');
  const exchangeStopFor = (p: PositionView) =>
    openOrders.find((o) => o.symbol === p.symbol && marketOf(o) === marketOf(p) && o.stop_price && /STOP/i.test(o.type) && !/TAKE_PROFIT/i.test(o.type) && (p.side === 'long' ? /sell/i.test(o.side) : /buy/i.test(o.side))) ?? null;
  const exchangeTpFor = (p: PositionView) => openOrders.find((o) => o.symbol === p.symbol && marketOf(o) === marketOf(p) && o.stop_price && /TAKE_PROFIT/i.test(o.type) && (p.side === 'long' ? /sell/i.test(o.side) : /buy/i.test(o.side))) ?? null;
  const adopt = useMutation({
    mutationFn: (p: PositionView) => api.adoptPosition(p.symbol, { market: marketOf(p), stop_price: stopText.trim() || null, take_profit: tpText.trim() || null }),
    onSuccess: (res) => {
      toast.success(t('{symbol} 交给 agent 接管了', { symbol: res.thread.symbol }), { description: `${t('止损')} ${res.thread.stop_price ?? '—'}${res.thread.take_profits[0] ? `,${t('止盈')} ${res.thread.take_profits[0]}` : ''}` });
      setAdopting(null);
      void queryClient.invalidateQueries({ queryKey: ['threads'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['positions'] });
      void queryClient.invalidateQueries({ queryKey: ['open-orders'] });
    },
    onError: (err) => toast.error(t('接管失败'), { description: errMsg(err) }),
  });
  const openAdopt = (p: PositionView) => {
    setStopText(exchangeStopFor(p)?.stop_price ?? '');
    setTpText(exchangeTpFor(p)?.stop_price ?? '');
    setAdopting(p);
  };
  // 平仓:有线程走线程平仓(撤保护腿+市价平+关线程);无主的走手动单 close 路径(撤该币所有挂单+市价平)
  const [closing, setClosing] = useState<{ p: PositionView; thread: StrategyThread | null } | null>(null);
  const closePos = useMutation({
    mutationFn: async ({ p, thread }: { p: PositionView; thread: StrategyThread | null }) => {
      if (thread) return api.closeThread(thread.id);
      return api.placeOrder({ symbol: p.symbol, market: marketOf(p), side: p.side, action: 'close', type: 'market' });
    },
    onSuccess: (_res, { p }) => {
      toast.success(t('{symbol} 平仓已发出', { symbol: p.symbol }));
      setClosing(null);
      void queryClient.invalidateQueries({ queryKey: ['threads'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['positions'] });
      void queryClient.invalidateQueries({ queryKey: ['open-orders'] });
    },
    onError: (err) => toast.error(t('平仓失败'), { description: errMsg(err) }),
  });
  return (
    <>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('币种')}</TableHead>
          <TableHead>{t('市场')}</TableHead>
          <TableHead>{t('方向')}</TableHead>
          <TableHead>{t('数量')}</TableHead>
          <TableHead>{t('仓位(U)')}</TableHead>
          <TableHead>{t('开仓价')}</TableHead>
          <TableHead>{t('标记价')}</TableHead>
          <TableHead>{t('未实现盈亏')}</TableHead>
          <TableHead>{t('杠杆')}</TableHead>
          <TableHead>{t('管理')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.length === 0 ? (
          <TableRow>
            <TableCell colSpan={10} className="py-6 text-center text-muted-foreground">
              {t('暂无持仓')}
            </TableCell>
          </TableRow>
        ) : (
          positions.map((p, i) => {
            const th = threads.find((t) => t.symbol === p.symbol && marketOf(t) === marketOf(p) && (t.status === 'in_position' || t.status === 'pending_entry')) ?? null;
            const exStop = exchangeStopFor(p);
            return (
            <TableRow key={`${p.symbol}-${i}`}>
              <TableCell className="num font-medium">{p.symbol}</TableCell>
              <TableCell className="text-muted-foreground">{marketLabel(p.market)}</TableCell>
              <TableCell className={cn('font-medium', directionText(p.side))}>{marketOf(p) === 'spot' ? t('持有') : directionLabel(p.side)}</TableCell>
              <TableCell className="num">{fmtQty(p.qty)}</TableCell>
              <TableCell className="num" title={t('名义仓位 = 数量 × 标记价;保证金 ≈ 名义 / 杠杆')}>
                {notionalUsdt(p)}
                <span className="ml-1 text-[10px] text-muted-foreground">{t('保证金 {m}', { m: marginUsdt(p) })}</span>
              </TableCell>
              <TableCell className="num">{fmtPrice(p.entry_price)}</TableCell>
              <TableCell className="num">{fmtPrice(p.mark_price)}</TableCell>
              <TableCell className={cn('num', pnlText(p.unrealized_pnl))}>{fmtSigned(p.unrealized_pnl)}</TableCell>
              <TableCell className="num">{marketOf(p) === 'spot' ? t('现货') : `${p.leverage}x`}</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  {th ? (
                    <Badge variant="outline" className="h-5 max-w-56 px-1.5 text-[10.5px]" title={t('线程 {id}', { id: th.id })}>
                      <span className="truncate">{t('{who} · agent 在管', { who: originOf(th).label })}{th.stop_price ? ` · ${t('止损')} ${fmtPrice(th.stop_price)}` : ''}</span>
                    </Badge>
                  ) : (
                    <>
                      <Badge variant="outline" className={cn('h-5 px-1.5 text-[10.5px]', marketOf(p) === 'spot' ? 'text-muted-foreground' : 'border-warn/40 text-warn')} title={marketOf(p) === 'spot' ? t('不属于任何线程;现货不强制止损,想让 agent 管就交给它') : t('不属于任何线程,agent 不会管它的离场')}>
                        {t('外部持仓(不是本演示开的)')}{exStop ? ` · ${t('交易所止损 {price}', { price: exStop.stop_price })}` : marketOf(p) === 'spot' ? '' : ` · ${t('没有止损')}`}
                      </Badge>
                      <Button size="xs" variant="outline" onClick={() => openAdopt(p)}>
                        {t('交给 agent')}
                      </Button>
                    </>
                  )}
                  <Button size="xs" variant="outline" className="border-down/40 text-down hover:bg-down/10 hover:text-down" onClick={() => setClosing({ p, thread: th })}>
                    {t('平仓')}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
    <ConfirmDialog
      open={adopting !== null}
      title={adopting ? t('把 {symbol} 交给 agent', { symbol: adopting.symbol }) : t('交给 agent')}
      summary={t('接管')}
      busy={adopt.isPending}
      onCancel={() => setAdopting(null)}
      onConfirm={() => adopting && adopt.mutate(adopting)}
    >
      {adopting ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            {marketOf(adopting) === 'spot' ? t('现货持有') : directionLabel(adopting.side)} {fmtQty(adopting.qty)} @ {fmtPrice(adopting.entry_price)}。{t('接管之后建一条线程,agent 按 K 线收盘、止损止盈触发、信息更新来复查,可以 HOLD、减仓、离场;止损止盈由代码守着。')}
          </p>
          <div className="flex flex-col gap-1">
            <Label className="text-[12px]">{marketOf(adopting) === 'spot' ? t('止损价(可选,现货不强制)') : t('止损价(必填)')}{exchangeStopFor(adopting) ? t('(默认用交易所上已挂的)') : ''}</Label>
            <Input className="num h-7" value={stopText} onChange={(e) => setStopText(e.target.value)} placeholder={adopting.side === 'long' ? t('低于标记价') : t('高于标记价')} />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[12px]">{t('止盈价(可选)')}{exchangeTpFor(adopting) ? t('(默认用交易所上已挂的)') : ''}</Label>
            <Input className="num h-7" value={tpText} onChange={(e) => setTpText(e.target.value)} placeholder={t('留空 = 不挂止盈')} />
          </div>
          <p className="text-[10.5px] text-muted-foreground">{t('填了新的止损价,会先撤掉这个币上的旧条件单再挂;沿用交易所已有的就不重复挂。')}</p>
        </div>
      ) : null}
    </ConfirmDialog>
    <ConfirmDialog
      open={closing !== null}
      title={closing ? t('市价平掉 {symbol}', { symbol: closing.p.symbol }) : t('平仓')}
      summary={t('确认平仓')}
      danger
      busy={closePos.isPending}
      onCancel={() => setClosing(null)}
      onConfirm={() => closing && closePos.mutate(closing)}
    >
      {closing ? (
        <p className="text-muted-foreground">
          {directionLabel(closing.p.side)} {fmtQty(closing.p.qty)} @ {fmtPrice(closing.p.entry_price)},{t('未实现')} {fmtSigned(closing.p.unrealized_pnl)}。
          {closing.thread ? t('会先撤掉这条线程的止损止盈,再市价全平并关掉线程。') : t('会先撤掉这个币上的全部挂单(含条件单),再市价全平。')}
          {t('agent_mcp 通道一次约 40 秒,这期间别重复点。')}
        </p>
      ) : null}
    </ConfirmDialog>
    </>
  );
}

/**
 * 挂单 tab。上面单列「提交结果未知」的入场单(本地有线程、交易所没回执)——它们不是交易所上的挂单,
 * 不能和下面的真实挂单混在一起;下面是交易所返回的挂单,标出属于哪条线程(入场腿 / 保护腿)。
 */
function OpenOrdersTable({ orders, threads, unknown, onSelectThread }: { orders: OpenOrderView[]; threads: StrategyThread[]; unknown: { thread: StrategyThread; health: ThreadHealth }[]; onSelectThread: (t: StrategyThread) => void }) {
  return (
    <>
      {unknown.length ? (
        <div className="border-b bg-down/[0.05]" data-testid="trade-unknown-entries">
          <div className="flex items-center gap-1.5 px-3 pt-2 text-[11.5px] font-medium text-down">
            <TriangleAlert className="size-3.5" />
            {t('提交结果未知的入场单 {n} 笔', { n: unknown.length })}
            <span className="font-normal text-muted-foreground">{t('本地有记录,交易所没回执;不在下面的交易所挂单里')}</span>
          </div>
          <Table>
            <TableBody>
              {unknown.map(({ thread, health }) => (
                <TableRow key={thread.id} className="cursor-pointer hover:bg-down/[0.06]" onClick={() => onSelectThread(thread)}>
                  <TableCell className="num w-28 font-medium">{thread.symbol}</TableCell>
                  <TableCell className={cn('w-16 font-medium', directionText(thread.side))}>{marketOf(thread) === 'spot' ? t('买入') : directionLabel(thread.side)}</TableCell>
                  <TableCell className="num">{thread.entry.type === 'market' ? t('市价') : fmtPrice(thread.entry.price)} · {fmtQty(thread.qty)}</TableCell>
                  <TableCell className="num text-muted-foreground">{thread.entry_client_order_id ?? '—'}</TableCell>
                  <TableCell className="text-down">{health.label}{health.stuckMs ? ` · ${t('已卡 {n} 分钟', { n: Math.round(health.stuckMs / 60_000) })}` : ''}</TableCell>
                  <TableCell className="text-right text-[11px] text-primary">{t('看线程 →')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('币种')}</TableHead>
            <TableHead>{t('市场')}</TableHead>
            <TableHead>{t('方向')}</TableHead>
            <TableHead>{t('类型')}</TableHead>
            <TableHead>{t('数量')}</TableHead>
            <TableHead>{t('价格')}</TableHead>
            <TableHead>{t('触发价')}</TableHead>
            <TableHead>{t('只减仓')}</TableHead>
            <TableHead>{t('归属')}</TableHead>
            <TableHead>{t('状态')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="py-6 text-center text-muted-foreground">
                {t('交易所上没有挂单')}
              </TableCell>
            </TableRow>
          ) : (
            orders.map((o) => {
              const th = threadForOrder(o, threads);
              const leg = th ? (th.entry_client_order_id === o.client_order_id ? t('入场') : t('保护')) : null;
              return (
                <TableRow key={o.client_order_id}>
                  <TableCell className="num font-medium">{o.symbol}</TableCell>
                  <TableCell className="text-muted-foreground">{marketLabel(o.market)}</TableCell>
                  <TableCell className={cn('font-medium', o.side.toUpperCase() === 'BUY' ? 'text-up' : 'text-down')}>{o.side.toUpperCase() === 'BUY' ? t('买') : t('卖')}</TableCell>
                  <TableCell>{o.type}</TableCell>
                  <TableCell className="num">{fmtQty(o.qty)}</TableCell>
                  <TableCell className="num">{o.price ? fmtPrice(o.price) : t('市价')}</TableCell>
                  <TableCell className="num">{o.stop_price ? fmtPrice(o.stop_price) : '—'}</TableCell>
                  <TableCell>{o.reduce_only ? t('是') : t('否')}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {th ? (
                      <button type="button" className="hover:text-primary hover:underline" onClick={() => onSelectThread(th)}>
                        {t('线程 · {leg}', { leg: leg! })}
                      </button>
                    ) : (
                      t('无主')
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{o.status}</TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </>
  );
}

// ---------------------------------------------------------------------------
// 主页面

type TopTab = 'chart' | 'thread' | 'jev' | 'agent' | 'risk';
type BottomTab = 'positions' | 'orders';

export function TradePage() {
  const queryClient = useQueryClient();

  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  const executionQ = useQuery({ queryKey: ['execution'], queryFn: api.execution, staleTime: 15_000 });
  // §9.40:下单面板的市场;初始跟 workflow.default_market 走一次
  const [tradeMarket, setTradeMarket] = useState<Market>('perp');
  const symbolsQ = useQuery({ queryKey: ['symbols', tradeMarket], queryFn: () => api.symbolsFor(tradeMarket) });
  const threadsQ = useQuery({ queryKey: ['threads', 'open'], queryFn: () => api.threads('open') });
  const allThreadsQ = useQuery({ queryKey: ['threads', 'all'], queryFn: () => api.threads('all'), staleTime: 30_000 });
  const positionsQ = useQuery({ queryKey: ['positions'], queryFn: api.positions });
  const openOrdersQ = useQuery({ queryKey: ['open-orders'], queryFn: api.openOrders });
  // 三层:① 来源(§9.56 sources;降级用 §9.51 运行 + §9.54 当前策略)② 判断(每个来源各自)③ 风控与执行(§9.56 execution-policy)
  const agentStrategyQ = useAgentStrategy();
  const runsQ = useStrategyRuns();
  const sourcesQ = useTradingSources();
  const policyQ = useExecutionPolicy();
  const judgeQ = useJudgeLive({ limit: 200 });
  const writeLock = useTradeWriteLock();
  // 「卡了多久」要随时间走,SSE 不来也得刷新:30 秒一拍
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // ---- 下单面板状态 ----
  // 深链 #trade?symbol=BNBUSDT(楼层/判断记录跳过来直接选中该币;也方便复现某个币的渲染问题)
  const [selectedSymbol, setSelectedSymbol] = useState(() => (new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('symbol') ?? '').toUpperCase());
  const [side, setSide] = useState<Direction>('long');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [price, setPrice] = useState('');
  const [marginUsdt, setMarginUsdt] = useState('100');
  const [leverage, setLeverage] = useState('3');
  const [marginMode, setMarginMode] = useState<'cross' | 'isolated'>('cross');
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');

  // 币种默认值:优先用当前行情币种,其次用交易所可交易列表的第一个;只在第一次拿到时设置一次。
  useEffect(() => {
    if (selectedSymbol) return;
    const fallback = overviewQ.data?.market?.symbol ?? symbolsQ.data?.symbols[0]?.symbol;
    if (fallback) setSelectedSymbol(fallback);
  }, [selectedSymbol, overviewQ.data?.market?.symbol, symbolsQ.data?.symbols]);

  // 杠杆/全逐仓默认值跟工作流走一次(用户改过之后不再覆盖)。
  const workflowDefaultsApplied = useRef(false);
  useEffect(() => {
    if (workflowDefaultsApplied.current) return;
    const wf = overviewQ.data?.workflow;
    if (!wf) return;
    workflowDefaultsApplied.current = true;
    setLeverage(String(wf.leverage));
    setMarginMode(wf.margin_mode);
    if (wf.default_market === 'spot') setTradeMarket('spot');
  }, [overviewQ.data?.workflow]);
  const marketsEnabled = useMemo<Market[]>(() => overviewQ.data?.workflow.markets ?? ['perp'], [overviewQ.data?.workflow.markets]);
  const marketsSupported = useMemo<Market[]>(() => executionQ.data?.markets_supported ?? ['perp'], [executionQ.data?.markets_supported]);
  const okxSimpleMode = executionQ.data?.exchange === 'okx' && executionQ.data?.okx?.acct_lv === 1;
  const okxDemo = executionQ.data?.exchange === 'okx' && executionQ.data?.okx?.demo !== false;
  // 切到现货:方向恒 long、只减仓 = 卖出;切回永续时复位只减仓
  const changeTradeMarket = (m: Market) => {
    setTradeMarket(m);
    setReduceOnly(false);
    if (m === 'spot') setSide('long');
  };
  const basisQ = useQuery({
    queryKey: ['basis', selectedSymbol],
    queryFn: () => api.basis(selectedSymbol),
    enabled: !!selectedSymbol,
    retry: 0,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  // ---- 右上 / 底部 tab ----
  const [topTab, setTopTab] = useState<TopTab>('chart');
  const [bottomTab, setBottomTab] = useState<BottomTab>('positions');

  // ---- 中间线程列表 / 选中线程 ----
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const threads = useMemo(() => threadsQ.data?.threads ?? [], [threadsQ.data]);
  // 已结束的线程:进行中为空时把最近几条摆出来填空(只读),有进行中时折在下面
  const closedThreads = useMemo(
    () =>
      (allThreadsQ.data?.threads ?? [])
        .filter((t) => t.status !== 'pending_entry' && t.status !== 'in_position')
        .sort((a, b) => b.updated_at - a.updated_at),
    [allThreadsQ.data],
  );
  const closedRecent = useMemo(() => closedThreads.slice(0, 8), [closedThreads]);
  const selectedThread = useMemo(() => threads.find((t) => t.id === selectedThreadId) ?? closedThreads.find((t) => t.id === selectedThreadId) ?? null, [threads, closedThreads, selectedThreadId]);
  const closedCount = closedThreads.length;
  // 线程栏折叠:用户没手动定过就跟着「有没有进行中线程」自动收放;手动定过记本机
  const [threadsPaneUser, setThreadsPaneUser] = useState<boolean | null>(() => {
    try {
      const v = window.localStorage.getItem('tg.trade.threads.open');
      return v === null ? null : v === '1';
    } catch {
      return null;
    }
  });
  // Codex(trade-page-layout):只有「成功加载且进行中为 0」才自动收起,失败/加载中不收
  const threadsPaneOpen = threadsPaneUser ?? !(threadsQ.isSuccess && threads.length === 0);
  const setThreadsPane = (open: boolean) => {
    setThreadsPaneUser(open);
    try {
      window.localStorage.setItem('tg.trade.threads.open', open ? '1' : '0');
    } catch {
      /* 无 storage */
    }
  };
  const [showClosed, setShowClosed] = useState(false);
  // 左栏底部「手动下单」展开区:默认收起(评审先看来源),手动定过记本机
  const [manualOpen, setManualOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('tg.trade.manual.open') === '1';
    } catch {
      return false;
    }
  });
  const setManualPanel = (open: boolean) => {
    setManualOpen(open);
    try {
      window.localStorage.setItem('tg.trade.manual.open', open ? '1' : '0');
    } catch {
      /* 无 storage */
    }
  };
  // 线程来源筛选:全部 / AI Scan / 手动 / 某一个运行(点左栏来源卡)
  const [runFilter, setRunFilter] = useState<OriginFilter>(null);
  const runs = runsQ.data?.runs;
  const originOf = useCallback((th: StrategyThread) => threadOrigin(th, runs), [runs]);
  const judgeItems = judgeQ.data?.items;
  const positionsForHealth = positionsQ.isSuccess ? positionsQ.data : undefined;
  const visibleThreads = useMemo(() => threads.filter((x) => matchesOriginFilter(x, runFilter)), [threads, runFilter]);
  const counts = useMemo(() => originCounts(threads), [threads]);
  const groups = useMemo(() => groupThreads(visibleThreads, now, positionsForHealth), [visibleThreads, now, positionsForHealth]);
  const stuckEntries = useMemo(() => unknownEntries(threads, now, positionsForHealth), [threads, now, positionsForHealth]);
  const watchlist = overviewQ.data?.workflow.watchlist ?? [];
  const threadSymbols = useMemo(() => [...new Set(threads.map((t) => t.symbol))], [threads]);

  const selectThread = (t: StrategyThread) => {
    setSelectedThreadId(t.id);
    setTopTab((cur) => (cur === 'chart' ? cur : 'thread'));
    setSelectedSymbol(t.symbol);
    setSide(t.side);
    if (marketOf(t) !== tradeMarket) changeTradeMarket(marketOf(t));
  };

  // 09-25 ③-12:深链 #trade?thread=<id>(逐次判断页「查看线程」跳过来)——线程列表到了之后选中一次;
  // 已结束的线程顺手展开「已结束」那一栏
  const threadParam = useRef<string | null>(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('thread'));
  useEffect(() => {
    const id = threadParam.current;
    if (!id) return;
    const open = threads.find((x) => x.id === id);
    const closed = open ? null : closedThreads.find((x) => x.id === id);
    const hit = open ?? closed;
    if (!hit) {
      if (threadsQ.isSuccess && allThreadsQ.isSuccess) threadParam.current = null; // 两份都拉到了还找不到,就不再等
      return;
    }
    threadParam.current = null;
    selectThread(hit);
    if (closed) {
      setShowClosed(true);
      setThreadsPane(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, closedThreads, threadsQ.isSuccess, allThreadsQ.isSuccess]);

  /**
   * 图表左侧币种列表 / 下单面板的 SymbolPicker 共用的切币入口:两处必须同步(都写
   * selectedSymbol),并且切到别的币时把选中的线程清掉——否则图表上还画着另一个币的
   * 入场/止损价格线。
   */
  const selectSymbol = useCallback(
    (sym: string) => {
      if (!sym) return;
      setSelectedSymbol(sym);
      setSelectedThreadId((cur) => {
        if (!cur) return cur;
        const t = threads.find((x) => x.id === cur);
        return t && t.symbol !== sym ? null : cur;
      });
    },
    [threads],
  );


  // ---- 下单 mutation ----
  const placeOrderMut = useMutation({
    mutationFn: (payload: ManualOrderRequest) => api.placeOrder(payload),
    onSuccess: (resp) => {
      toast.success(t('已提交 {symbol} {side}', { symbol: resp.thread.symbol, side: marketOf(resp.thread) === 'spot' ? t('现货') : directionLabel(resp.thread.side) }));
      void queryClient.invalidateQueries({ queryKey: ['threads', 'open'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (err) => toast.error(t('下单失败'), { description: errMsg(err) }),
  });

  const handleSubmit = () => {
    if (!selectedSymbol) {
      toast.error(t('先选个币种'));
      return;
    }
    const isSpot = tradeMarket === 'spot';
    const marginNum = Number(marginUsdt);
    const leverageNum = isSpot ? 1 : Number(leverage);
    // 现货卖出可以不填金额(= 全部卖出);其余都要金额
    if (!(isSpot && reduceOnly && marginUsdt.trim() === '') && !(marginNum > 0)) {
      toast.error(isSpot ? t('金额要大于 0') : t('保证金要大于 0'));
      return;
    }
    if (!isSpot && !(leverageNum > 0)) {
      toast.error(t('杠杆要大于 0'));
      return;
    }
    if (orderType === 'limit' && !(Number(price) > 0)) {
      toast.error(t('填一下限价价格'));
      return;
    }
    placeOrderMut.mutate(
      isSpot
        ? {
            symbol: selectedSymbol,
            market: 'spot',
            side: 'long',
            action: reduceOnly ? 'close' : 'open',
            type: orderType,
            price: orderType === 'limit' ? price : undefined,
            margin_usdt: marginUsdt.trim() === '' ? undefined : marginUsdt,
            tp: tp || undefined,
            sl: sl || undefined,
          }
        : {
            symbol: selectedSymbol,
            market: 'perp',
            side,
            action: reduceOnly ? 'close' : 'open',
            type: orderType,
            price: orderType === 'limit' ? price : undefined,
            margin_usdt: marginUsdt,
            leverage: leverageNum,
            tp: tp || undefined,
            sl: sl || undefined,
            margin_mode: marginMode,
          },
    );
  };

  // ---- 线程操作 ----
  const [closeTarget, setCloseTarget] = useState<StrategyThread | null>(null);
  const closeThreadMut = useMutation({
    mutationFn: (id: string) => api.closeThread(id),
    onSuccess: () => {
      toast.success(t('已提交'));
      void queryClient.invalidateQueries({ queryKey: ['threads', 'open'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      setCloseTarget(null);
    },
    onError: (err) => toast.error(t('操作失败'), { description: errMsg(err) }),
  });
  const reviewThreadMut = useMutation({
    mutationFn: (id: string) => api.reviewThread(id),
    onSuccess: () => toast.success(t('已叫它复查')),
    onError: (err) => toast.error(t('复查失败'), { description: errMsg(err) }),
  });

  const market = marketForSymbol(overviewQ.data, selectedSymbol);
  const symbols = symbolsQ.data?.symbols ?? [];
  const positions = positionsQ.data ?? [];
  const openOrders = openOrdersQ.data ?? [];

  const chartSymbol = selectedSymbol || overviewQ.data?.market?.symbol || 'BTCUSDT';
  const chartTimeframe = overviewQ.data?.workflow.timeframe ?? overviewQ.data?.market?.klines_tf ?? '15m';
  const chartLines = selectedThread
    ? {
        entryPrice: selectedThread.entry.price,
        entryZone: selectedThread.entry.zone,
        stopPrice: selectedThread.stop_price,
        takeProfits: selectedThread.take_profits,
      }
    : undefined;

  const selectedHealth = selectedThread ? threadHealth(selectedThread, now, positionsForHealth) : null;
  const openCount = threads.length;
  const actionCount = groups.action.length;

  // ---- ① 来源卡 ----
  const policy = policyQ.data;
  const sourcesView = sourcesQ.data;
  const halted = sourcesView?.shared.halted ?? overviewQ.data?.loop?.halted ?? false;
  const paused = sourcesView?.shared.paused ?? overviewQ.data?.workflow.paused ?? false;
  const cards = useMemo(
    () =>
      sourceCards({
        sources: sourcesView,
        runs,
        agent: agentStrategyQ.data,
        usage: overviewQ.data?.usage_today,
        halted,
        paused,
        watchCount: watchlist.length,
        threads,
      }),
    [sourcesView, runs, agentStrategyQ.data, overviewQ.data?.usage_today, halted, paused, watchlist.length, threads],
  );
  const filteredCard = runFilter ? cards.find((c) => sameOriginFilter(c.filter, runFilter)) ?? null : null;
  const filteredRun = runFilter && typeof runFilter === 'object' ? runs?.find((r) => r.id === runFilter.runId) ?? null : null;
  const filterLabel = runFilter === 'manual' ? t('手动') : filteredCard?.name ?? filteredRun?.strategy_name ?? null;
  const pickFilter = (f: OriginFilter) => {
    setRunFilter(f);
    if (f) setThreadsPane(true);
  };

  // ---- ③ 风控与执行 ----
  const channel = channelOf(policy ? { backend: policy.backend, live: policy.live, profile: policy.profile ?? null, label: policy.execution_label ?? null } : { backend: overviewQ.data?.account?.backend ?? overviewQ.data?.loop?.backend ?? null, live: executionQ.data?.exchange === 'okx' && executionQ.data?.okx?.demo === false });
  const execLabel = channel.label !== '—' ? channel.label : `${backendLabel(overviewQ.data?.account?.backend)}${okxDemo ? ` · ${t('模拟盘')}` : ''}`;
  const wf = overviewQ.data?.workflow;
  const usageFallback = { open_threads: sourcesView?.shared.open_threads ?? openCount, opens_today: sourcesView?.shared.opens_today ?? null, daily_loss_hit: sourcesView?.shared.daily_loss_hit ?? false };
  const riskLine = policy
    ? riskSummary(policy.values, policy.usage)
    : wf
      ? riskSummary({ risk_pct: wf.risk_pct, sizing_agent: wf.sizing_agent, leverage: wf.leverage, max_open_threads: wf.max_open_threads, max_opens_per_day: wf.max_opens_per_day }, usageFallback)
      : null;
  const dailyLossHit = policy?.usage.daily_loss_hit ?? sourcesView?.shared.daily_loss_hit ?? false;
  const activeSources = cards.filter((c) => c.status === 'running' || c.status === 'capped').length;

  // ---- 来源卡动作:暂停/继续、改判断方式(PATCH strategy-runs/:id)----
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const patchRun = useMutation({
    mutationFn: ({ id, body }: { id: string; body: StrategyRunPatch }) => strategyRunsApi.patch(id, body),
    onMutate: ({ id }) => setBusyKey(id),
    onSettled: () => setBusyKey(null),
    onSuccess: (_res, { body }) => {
      void queryClient.invalidateQueries({ queryKey: ['strategy-runs'] });
      void queryClient.invalidateQueries({ queryKey: TRADING_SOURCES_KEY });
      toast.success(body.mode ? t('判断方式已改为 {m}', { m: RUN_MODE_LABEL[body.mode] }) : body.status === 'paused' ? t('已暂停这个来源') : t('已继续运行'));
    },
    onError: (err) => {
      if (writeLock.noteError(err)) toast.error(t('公网演示:访客只读,只有所有者能改'));
      else toast.error(t('操作失败'), { description: errMsg(err) });
    },
  });

  const patchAiScan = useMutation({
    mutationFn: (paused: boolean) => tradingApi.patchAiScan(paused),
    onMutate: () => setBusyKey('ai_scan'),
    onSettled: () => setBusyKey(null),
    onSuccess: (_res, paused) => {
      void queryClient.invalidateQueries({ queryKey: TRADING_SOURCES_KEY });
      toast.success(paused ? t('AI 扫盘已暂停,策略运行照常') : t('AI 扫盘已继续'));
    },
    onError: (err) => {
      if (writeLock.noteError(err)) toast.error(t('公网演示:访客只读,只有所有者能改'));
      else toast.error(t('操作失败'), { description: errMsg(err) });
    },
  });

  // ---- 让 agent 调风控:新开会话 + 预填,切到 Agent tab ----
  const [chatKey, setChatKey] = useState(0);
  const askTune = async () => {
    const prompt = tunePrompt(policy, cards, channel);
    try {
      const res = await api.createChatSession(t('风控调参'));
      window.localStorage.setItem(SESSION_KEY, res.session.id);
    } catch {
      /* 访客 / 老网关建不了会话:就用当前会话 */
    }
    stageAgentQuestion(prompt);
    setChatKey((k) => k + 1);
    setTopTab('agent');
  };

  const rowFor = ({ thread, health }: { thread: StrategyThread; health: ThreadHealth }) => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      health={health}
      origin={originOf(thread)}
      judge={judgeForThread(thread, judgeItems)}
      selected={thread.id === selectedThreadId}
      onSelect={() => selectThread(thread)}
      onClose={() => setCloseTarget(thread)}
      onReview={() => reviewThreadMut.mutate(thread.id)}
      reviewPending={reviewThreadMut.isPending && reviewThreadMut.variables === thread.id}
    />
  );
  const closedRow = (th: StrategyThread) => (
    <ThreadRow key={th.id} thread={th} health={threadHealth(th, now)} origin={originOf(th)} judge={judgeForThread(th, judgeItems)} closed selected={th.id === selectedThreadId} onSelect={() => selectThread(th)} />
  );
  const closedVisible = useMemo(() => closedRecent.filter((x) => matchesOriginFilter(x, runFilter)), [closedRecent, runFilter]);
  const section = (label: string, rows: { thread: StrategyThread; health: ThreadHealth }[], tone?: 'danger') =>
    rows.length ? (
      <div key={label}>
        <div className={cn('kicker sticky top-0 z-10 flex items-center gap-1 border-b bg-card/95 px-3 py-1 text-[10px] backdrop-blur', tone === 'danger' ? 'text-down' : 'text-muted-foreground')}>
          {tone === 'danger' ? <TriangleAlert className="size-3" /> : null}
          {label}
          <span className="num">{rows.length}</span>
        </div>
        {rows.map(rowFor)}
      </div>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <TradeContextBar
        channel={channel}
        state={{ halted, paused, dailyLossHit }}
        activeSources={activeSources}
        totalSources={cards.length}
        riskSummary={riskLine}
        riskActive={topTab === 'risk'}
        onOpenRisk={() => setTopTab('risk')}
      />
      <Workspace className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 divide-x overflow-hidden">
          <Pane
            title={t('① 来源')}
            hint={t('机会从哪来')}
            className="w-[300px] shrink-0"
            contentClassName="min-h-0 flex-1"
          >
            <SourcesColumn
              cards={cards}
              filter={runFilter}
              onFilter={pickFilter}
              counts={{ all: counts.all, manual: counts.manual }}
              lock={writeLock.runReason}
              busyKey={busyKey}
              onToggleRun={(card) => card.runId && patchRun.mutate({ id: card.runId, body: { status: card.status === 'running' || card.status === 'capped' || card.status === 'halted' ? 'paused' : 'running' } })}
              onToggleAiScan={(card) => patchAiScan.mutate(card.status === 'running' || card.status === 'capped')}
              onModeRun={(card, mode) => card.runId && mode !== card.mode && patchRun.mutate({ id: card.runId, body: { mode } })}
              now={now}
              minStopAtr={policy?.values.min_stop_atr ?? null}
              manualOpen={manualOpen}
              onManualOpen={setManualPanel}
              degraded={sourcesQ.data === null}
            >
              <OrderPanel
                symbols={symbols}
                selectedSymbol={selectedSymbol}
                onSelectSymbol={selectSymbol}
                watchlist={watchlist}
                threadSymbols={threadSymbols}
                market={market}
                tradeMarket={tradeMarket}
                onTradeMarket={changeTradeMarket}
                marketsEnabled={marketsEnabled}
                marketsSupported={marketsSupported}
                okxSimpleMode={!!okxSimpleMode}
                okxDemo={!!okxDemo}
                basis={basisQ.data ?? null}
                side={side}
                onSide={setSide}
                reduceOnly={reduceOnly}
                onReduceOnly={setReduceOnly}
                orderType={orderType}
                onOrderType={setOrderType}
                price={price}
                onPrice={setPrice}
                marginUsdt={marginUsdt}
                onMarginUsdt={setMarginUsdt}
                leverage={leverage}
                onLeverage={setLeverage}
                marginMode={marginMode}
                onMarginMode={setMarginMode}
                tp={tp}
                onTp={setTp}
                sl={sl}
                onSl={setSl}
                onSubmit={handleSubmit}
                submitting={placeOrderMut.isPending}
              />
            </SourcesColumn>
          </Pane>

          {!threadsPaneOpen ? (
            <button
              type="button"
              onClick={() => setThreadsPane(true)}
              className="flex w-8 shrink-0 flex-col items-center gap-2 border-r bg-muted/20 py-2 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              title={t('展开策略线程')}
            >
              <ChevronRight className="size-3.5" />
              <span className="kicker [writing-mode:vertical-rl]">{t('策略线程')} · {openCount}</span>
              {actionCount ? <span className="size-2 rounded-full bg-down" title={t('{n} 条需要处理', { n: actionCount })} /> : null}
            </button>
          ) : (
          <Pane
            title={t('策略线程')}
            hint={openCount ? t('{n} 条进行中', { n: openCount }) : t('没有进行中的')}
            className="w-[320px] shrink-0"
            contentClassName="flex min-h-0 flex-1 flex-col"
            actions={
              <button type="button" onClick={() => setThreadsPane(false)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" title={t('收起(没有进行中线程时会自动收起)')}>
                <ChevronLeft className="size-3.5" />
              </button>
            }
          >
            {runFilter ? (
              <div className="flex shrink-0 items-center gap-1.5 border-b bg-primary/[0.04] px-2.5 py-1 text-[11px]" data-testid="trade-origin-filter">
                <span className="text-muted-foreground">{t('只看')}</span>
                <span className="min-w-0 truncate font-medium text-primary">{filterLabel ?? '—'}</span>
                <span className="num text-muted-foreground">{visibleThreads.length}</span>
                <button type="button" onClick={() => setRunFilter(null)} className="ml-auto inline-flex items-center gap-0.5 rounded-sm px-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                  <X className="size-3" />
                  {t('全部')}
                </button>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {threadsQ.isLoading ? (
                <div className="p-4 text-[12px] text-muted-foreground">{t('加载中…')}</div>
              ) : threadsQ.isError ? (
                <div className="p-4 text-[12px] text-down">{t('线程列表没读到,不代表没有线程。')}{errMsg(threadsQ.error)}</div>
              ) : visibleThreads.length === 0 ? (
                <div className="px-3 py-3 text-[11.5px] text-muted-foreground">
                  {runFilter ? t('这个来源现在没有进行中的线程。') : t('没有进行中的线程。来源出了候选、过了判断和风控之后,会出现在这里;手动下单也会。')}
                </div>
              ) : (
                <>
                  {section(t('需要处理'), groups.action, 'danger')}
                  {section(t('持仓中'), groups.holding)}
                  {section(t('待入场'), groups.pending)}
                </>
              )}
              {closedVisible.length ? (
                <>
                  <button type="button" onClick={() => setShowClosed((v) => !v)} className="kicker flex w-full items-center gap-1 border-b bg-muted/30 px-3 py-1 text-left text-[10px] text-muted-foreground hover:text-foreground">
                    {showClosed || visibleThreads.length === 0 ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                    {t('最近结束')} <span className="num">{closedVisible.length}</span>
                  </button>
                  {showClosed || visibleThreads.length === 0 ? closedVisible.map(closedRow) : null}
                </>
              ) : null}
            </div>
            <a href="#history" className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-3 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
              <span>
                {t('已结束')} <span className="num font-semibold text-foreground">{closedCount}</span> {t('条')}
              </span>
              <span className="text-primary">{t('复盘 →')}</span>
            </a>
          </Pane>
          )}

          <Pane
            title={topTab === 'chart' ? chartSymbol : topTab === 'thread' ? t('线程') : topTab === 'jev' ? t('Jev 实盘判断') : topTab === 'risk' ? t('风控与执行') : 'Agent'}
            className="min-w-0 flex-1"
            contentClassName="flex min-h-0 flex-1 flex-col"
            actions={
              <>
                {topTab === 'chart' ? <RegimeBadge symbol={chartSymbol} /> : null}
                <Tabs value={topTab} onValueChange={(v) => setTopTab(v as TopTab)}>
                  <TabsList>
                    <TabsTrigger value="chart">{t('图表')}</TabsTrigger>
                    <TabsTrigger value="thread">
                      {t('线程')}
                      {selectedHealth && selectedHealth.kind !== 'ok' && selectedHealth.kind !== 'submitting' ? <span className="ml-1 size-1.5 rounded-full bg-down" /> : null}
                    </TabsTrigger>
                    <TabsTrigger value="jev">Jev</TabsTrigger>
                    <TabsTrigger value="agent">Agent</TabsTrigger>
                    <TabsTrigger value="risk" data-testid="trade-tab-risk">
                      {t('风控')}
                      {dailyLossHit || halted ? <span className="ml-1 size-1.5 rounded-full bg-down" /> : null}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </>
            }
          >
            {topTab === 'chart' ? (
              <div className="flex min-h-0 flex-1">
                <ChartSymbolList
                  symbols={symbols}
                  value={chartSymbol}
                  onChange={selectSymbol}
                  watchlist={watchlist}
                  watchOnly={overviewQ.data?.workflow.watch_only ?? []}
                  positions={positions}
                  openOrders={openOrders}
                  threads={threads}
                  markets={overviewQ.data?.markets}
                  marketState={overviewQ.data?.market_state}
                />
                <div className="min-h-0 min-w-0 flex-1">
                  <TradeChart symbol={chartSymbol} timeframe={chartTimeframe} lines={chartLines} />
                </div>
              </div>
            ) : null}
            {topTab === 'thread' ? (
              selectedThread && selectedHealth ? (
                <ThreadDetail
                  thread={selectedThread}
                  health={selectedHealth}
                  origin={originOf(selectedThread)}
                  judge={judgeForThread(selectedThread, judgeItems)}
                  onClose={selectedThread.status === 'pending_entry' || selectedThread.status === 'in_position' ? () => setCloseTarget(selectedThread) : null}
                  onOpenJev={() => setTopTab('jev')}
                />
              ) : (
                <div className="p-6 text-center text-[12px] text-muted-foreground">{t('在左边「策略线程」里点一条看详情')}</div>
              )
            ) : null}
            {topTab === 'jev' ? <JudgeLiveFeed runId={filteredRun?.id ?? null} className="min-h-0 flex-1 overflow-y-auto" /> : null}
            {topTab === 'agent' ? (
              <div className="min-h-0 flex-1">
                <ChatPanel key={chatKey} compact />
              </div>
            ) : null}
            {topTab === 'risk' ? (
              <RiskPanel
                policy={policy}
                loading={policyQ.isLoading}
                error={policyQ.isError ? errMsg(policyQ.error) : null}
                workflow={wf}
                usageFallback={usageFallback}
                lock={writeLock.reason}
                noteError={writeLock.noteError}
                onAskAgent={() => void askTune()}
              />
            ) : null}
          </Pane>
        </div>

        <div className="flex min-h-[220px] shrink-0 flex-col border-t">
          <Pane
            title={t('账户')}
            hint={execLabel}
            className="min-h-0 flex-1"
            contentClassName="min-h-0 flex-1 overflow-y-auto"
            actions={
              <Tabs value={bottomTab} onValueChange={(v) => setBottomTab(v as BottomTab)}>
                <TabsList>
                  <TabsTrigger value="positions">
                    {t('持仓')} <span className="num ml-1 text-muted-foreground">{positions.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="orders">
                    {t('挂单')} <span className="num ml-1 text-muted-foreground">{openOrders.length}</span>
                    {stuckEntries.length ? <span className="num ml-1 rounded-sm bg-down/15 px-1 text-[10px] text-down">{t('未知 {n}', { n: stuckEntries.length })}</span> : null}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            }
          >
            {bottomTab === 'positions' ? (
              <PositionsTable positions={positions} threads={threads} openOrders={openOrders} originOf={originOf} />
            ) : (
              <OpenOrdersTable
                orders={openOrders}
                threads={threads}
                unknown={stuckEntries}
                onSelectThread={(th) => {
                  selectThread(th);
                  setTopTab('thread');
                }}
              />
            )}
          </Pane>
        </div>
      </Workspace>

      <ConfirmDialog
        open={!!closeTarget}
        title={closeTarget?.status === 'pending_entry' ? t('撤单') : t('平仓')}
        summary={closeTarget?.status === 'pending_entry' ? t('确认撤单') : t('确认平仓')}
        danger
        busy={closeThreadMut.isPending}
        onCancel={() => setCloseTarget(null)}
        onConfirm={() => {
          if (closeTarget) closeThreadMut.mutate(closeTarget.id);
        }}
      >
        {closeTarget ? (
          <div className="space-y-1.5">
            <p>
              {closeTarget.symbol} · {directionLabel(closeTarget.side)} · {THREAD_STATUS_LABEL[closeTarget.status]}
            </p>
            {threadHealth(closeTarget, now, positionsForHealth).kind === 'submit_unknown' ? (
              <p className="text-[11.5px] text-muted-foreground">{t('这笔入场单提交结果未知。撤单会交给撤单链:按同一个订单号去交易所查,查到就撤、查不到也要等终态确认;在确认之前线程会显示「撤单结果未知」。')}</p>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
