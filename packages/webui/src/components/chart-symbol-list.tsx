/**
 * 图表左侧的币种列表(对齐 8794 控制台 ChartPage 的做法:
 * trade-switch-rs/frontend/src/pages/ChartPage.tsx + frontend-shared/domain/chartSymbols.ts)。
 *
 * 分组优先级:持仓/挂单(持仓 + 活跃挂单 + 未结束线程) → 观察列表(workflow.watchlist)
 * → 全部合约(GET /api/symbols 的全部 USDT 永续,排序后整份列出)。顶上一个搜索框:
 * 边打边过滤,回车按 8794 的 resolveChartSymbolInput 口径解析(`SOL` → `SOLUSDT`,
 * 尾部打错也能纠到唯一候选;解析不出唯一候选就原样切过去,让图表自己报错,而不是
 * 静默停在旧标的上装作切换过了)。
 *
 * 只有观察列表里的币在 overview.markets 里有行情视图,其它币只显示名字。
 * 折叠状态记在 localStorage。
 */
import { memo, useCallback, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { MarketState, MarketView, OpenOrderView, PositionView, StrategyThread, SymbolInfo } from '@/api/types';
import { Input } from '@/components/ui/input';
import { fmtPrice } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const COLLAPSED_KEY = 'trade-chart-symbols-collapsed';
/** 「全部合约」有 700+ 行,不搜索时只渲染前这么多行:整份渲染会让切币种时的重绘掉帧(macOS 上表现为整屏黑闪一下)。 */
const ALL_PREVIEW_ROWS = 80;

const TERMINAL_ORDER_STATUSES = new Set(['filled', 'cancelled', 'canceled', 'rejected', 'closed', 'expired', 'failed']);

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
  } catch {
    /* 隐私模式/禁用存储:折叠状态不记住就是了 */
  }
}

export function normalizeSymbol(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().replace(/\s+/g, '').replace(/\//g, '');
}

/**
 * 自由输入 → 已知合约。精确 → 补 USDT → 最长公共前缀唯一候选(至少 4 个字符,
 * 且长度差 ≤ 2);都不成就原样返回 normalize 后的输入。移植自 8794 的
 * frontend-shared/domain/chartSymbols.ts:resolveChartSymbolInput(去掉 `BTC/USDT` 斜杠形式)。
 */
export function resolveSymbolInput(input: unknown, known: string[]): string {
  const normalized = normalizeSymbol(input);
  if (!normalized || known.length === 0 || known.includes(normalized)) return normalized;
  const completed = `${normalized}USDT`;
  if (known.includes(completed)) return completed;
  let best = '';
  let bestLcp = 0;
  let tie = false;
  for (const candidate of known) {
    const max = Math.min(candidate.length, normalized.length);
    let lcp = 0;
    while (lcp < max && candidate[lcp] === normalized[lcp]) lcp += 1;
    if (lcp > bestLcp) {
      bestLcp = lcp;
      best = candidate;
      tie = false;
    } else if (lcp === bestLcp && lcp > 0 && candidate !== best) {
      tie = true;
    }
  }
  const threshold = Math.max(4, normalized.length - 2);
  return !tie && bestLcp >= threshold ? best : normalized;
}

/** 24h 涨跌:MarketView 上没有这个字段,信息员总结里有(majors / top_movers),两边都兜底找。 */
function changeMap(marketState: MarketState | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of marketState?.majors ?? []) if (m?.symbol) out[m.symbol] = m.change_24h_pct;
  for (const m of marketState?.top_movers ?? []) if (m?.symbol && out[m.symbol] === undefined) out[m.symbol] = m.change_24h_pct;
  return out;
}

interface Group {
  key: string;
  title: string;
  symbols: string[];
}

/** memo:全部合约那一组有几百行,overview 每 20 秒刷新一次,没行情的行不该跟着重渲染。 */
const SymbolRow = memo(function SymbolRow({
  symbol,
  active,
  market,
  change,
  onPick,
  watchOnly,
}: {
  symbol: string;
  active: boolean;
  market: MarketView | undefined;
  change: string | undefined;
  onPick: (symbol: string) => void;
  /** 名单里标了「只观察」:agent 自动判断只能 WATCH/NO_TRADE,手动下单不受限(和 Agent 页名单表同口径) */
  watchOnly?: boolean;
}) {
  const changeNum = change !== undefined && change !== '' ? Number(change) : NaN;
  return (
    <button
      type="button"
      onClick={() => onPick(symbol)}
      title={symbol}
      className={cn(
        'flex w-full items-center gap-1 px-2 py-[3px] text-left transition-colors hover:bg-muted/60',
        active && 'bg-muted text-foreground',
      )}
    >
      <span className={cn('num min-w-0 flex-1 truncate text-[11px]', active ? 'font-semibold' : 'text-foreground/85')}>{symbol}</span>
      {watchOnly ? (
        <span className="shrink-0 rounded-sm border border-warn/30 bg-warn/10 px-1 text-[9px] leading-3 text-warn" title={t('名单里标了只观察:agent 不会自动开仓,你手动下单不受限;去「盯盘参数」页改')}>
          {t('观')}
        </span>
      ) : null}
      {market ? (
        <span className="flex shrink-0 flex-col items-end leading-tight">
          <span className="num text-[10px] text-muted-foreground">{fmtPrice(market.last)}</span>
          {Number.isFinite(changeNum) ? (
            <span className={cn('num text-[9.5px]', changeNum >= 0 ? 'text-up' : 'text-down')}>
              {changeNum >= 0 ? '+' : ''}
              {changeNum.toFixed(2)}%
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
});

export function ChartSymbolList({
  symbols,
  value,
  onChange,
  watchlist = [],
  watchOnly = [],
  positions = [],
  openOrders = [],
  threads = [],
  markets,
  marketState,
  className,
}: {
  symbols: SymbolInfo[];
  value: string;
  onChange: (symbol: string) => void;
  watchlist?: string[];
  watchOnly?: string[];
  positions?: PositionView[];
  openOrders?: OpenOrderView[];
  threads?: StrategyThread[];
  markets?: Record<string, MarketView>;
  marketState?: MarketState | null;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [query, setQuery] = useState('');

  const watchOnlySet = useMemo(() => new Set(watchOnly), [watchOnly]);
  const all = useMemo(
    () =>
      [...new Set((symbols ?? []).filter((s) => !s.status || s.status === 'TRADING').map((s) => s.symbol).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [symbols],
  );

  const groups = useMemo<Group[]>(() => {
    const seen = new Set<string>();
    const uniq = (list: string[]) => {
      const out = [...new Set(list.filter(Boolean).map(normalizeSymbol))].filter((s) => !seen.has(s)).sort((a, b) => a.localeCompare(b));
      for (const s of out) seen.add(s);
      return out;
    };
    const live = uniq([
      ...positions.filter((p) => Number(p.qty) !== 0).map((p) => p.symbol),
      ...openOrders.filter((o) => !TERMINAL_ORDER_STATUSES.has(String(o.status ?? '').toLowerCase())).map((o) => o.symbol),
      ...threads.filter((t) => t.status === 'pending_entry' || t.status === 'in_position').map((t) => t.symbol),
    ]);
    const watch = uniq(watchlist);
    return [
      { key: 'live', title: t('持仓 / 挂单'), symbols: live },
      { key: 'watch', title: t('观察列表'), symbols: watch },
      { key: 'all', title: t('全部合约 {n}', { n: all.length }), symbols: all },
    ];
  }, [positions, openOrders, threads, watchlist, all]);

  const changes = useMemo(() => changeMap(marketState), [marketState]);

  const q = normalizeSymbol(query);
  const shown = useMemo(() => (q ? groups.map((g) => ({ ...g, symbols: g.symbols.filter((s) => s.includes(q)) })).filter((g) => g.symbols.length > 0) : groups), [groups, q]);

  const pick = useCallback(
    (symbol: string) => {
      if (!symbol) return;
      onChange(symbol);
    },
    [onChange],
  );

  const submitQuery = () => {
    const resolved = resolveSymbolInput(query, all);
    if (!resolved) return;
    pick(resolved);
    setQuery('');
  };

  if (collapsed) {
    return (
      <div className={cn('flex w-7 shrink-0 flex-col items-center border-r bg-muted/20 py-1.5', className)}>
        <button
          type="button"
          aria-label={t('展开币种列表')}
          title={t('展开币种列表')}
          onClick={() => {
            setCollapsed(false);
            writeCollapsed(false);
          }}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="size-3.5" />
        </button>
        <span className="num mt-2 text-[10px] text-muted-foreground [writing-mode:vertical-rl]">{t('币种')}</span>
      </div>
    );
  }

  return (
    <div className={cn('flex w-[150px] shrink-0 flex-col border-r bg-muted/10', className)}>
      <div className="flex shrink-0 items-center gap-1 border-b px-1.5 py-1">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitQuery();
              }
            }}
            placeholder={t('搜索 / 回车')}
            aria-label={t('搜索币种')}
            className="num h-6 pr-1 pl-5 text-[11px]"
          />
        </div>
        <button
          type="button"
          aria-label={t('折叠币种列表')}
          title={t('折叠币种列表')}
          onClick={() => {
            setCollapsed(true);
            writeCollapsed(true);
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-muted-foreground">{t('没有匹配的币。直接回车,试试切过去')}</div>
        ) : (
          shown.map((g) => (
            <div key={g.key}>
              <div className="sticky top-0 z-10 bg-card px-2 py-[3px] text-[10px] font-medium text-muted-foreground">{g.title}</div>
              {(g.key === 'all' && !q ? g.symbols.slice(0, ALL_PREVIEW_ROWS) : g.symbols).map((s) => (
                <SymbolRow key={`${g.key}-${s}`} symbol={s} active={s === value} market={markets?.[s]} change={changes[s]} onPick={pick} watchOnly={watchOnlySet.has(s)} />
              ))}
              {g.key === 'all' && !q && g.symbols.length > ALL_PREVIEW_ROWS ? (
                <div className="px-2 py-2 text-[10.5px] text-muted-foreground">{t('还有 {n} 个,在上面搜索框敲币名找', { n: g.symbols.length - ALL_PREVIEW_ROWS })}</div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
