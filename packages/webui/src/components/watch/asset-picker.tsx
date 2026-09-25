/**
 * 资产选择器(docs/design/watch-screener-review-2026-09-24.md 二-2):
 * 搜索即联想(代码 / 名称,Enter 加第一个;也能敲「btc,eth,sol」一次加几个)、按现货 / 永续筛、
 * 按成交额 / 涨跌 / 资金费排序、每行「+」一键加入、勾选批量加入、已在名单的标「已监控」、
 * 名额「32 / 60」超上限禁用并说明。数据 = /api/universe(没上线时降级到 /api/symbols)。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useUniverse, universeApi, type UniverseItem, type UniverseMarketFilter } from '@/api/universe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { relativeTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fmtChange, fmtCompact, fmtFunding, fmtLast, parseSymbolInput, pickerRows, quota, type AssetSortKey, type RadarHit, type SortDir } from './watch-logic';

const SORTS: { id: string; key: AssetSortKey; dir: SortDir; label: string }[] = [
  { id: 'volume', key: 'volume', dir: 'desc', label: '成交额从高到低' },
  { id: 'gain', key: 'change', dir: 'desc', label: '涨得最多' },
  { id: 'loss', key: 'change', dir: 'asc', label: '跌得最多' },
  { id: 'fund_hi', key: 'funding', dir: 'desc', label: '资金费最高' },
  { id: 'fund_lo', key: 'funding', dir: 'asc', label: '资金费最低' },
];

const MARKETS: { id: UniverseMarketFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'spot', label: '现货' },
  { id: 'perp', label: '永续' },
];

const ROW_LIMIT = 200;

export function AssetPicker({
  watchlist,
  max,
  onAdd,
  busy = false,
  radar,
  exchangeName = 'OKX',
  className,
}: {
  watchlist: string[];
  max: number;
  /** 调用方负责名额截断与写入;这里只在超上限时先拦一道 */
  onAdd: (symbols: string[]) => void;
  busy?: boolean;
  radar?: Map<string, RadarHit>;
  exchangeName?: string;
  className?: string;
}) {
  const qc = useQueryClient();
  const universeQ = useUniverse();
  const data = universeQ.data;
  const [q, setQ] = useState('');
  const [market, setMarket] = useState<UniverseMarketFilter>('all');
  const [sortId, setSortId] = useState('volume');
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const sort = SORTS.find((s) => s.id === sortId) ?? SORTS[0]!;
  const inList = useMemo(() => new Set(watchlist), [watchlist]);
  const quo = quota(watchlist.length, max);

  const { rows, matched } = useMemo(
    () => pickerRows(data?.items ?? [], { market, q, includeExcluded }, sort.key, sort.dir, ROW_LIMIT),
    [data, market, q, includeExcluded, sort.key, sort.dir],
  );
  const known = useMemo(() => new Set((data?.items ?? []).map((x) => x.symbol)), [data]);
  const pickedList = [...picked].filter((s) => !inList.has(s));

  const refresh = useMutation({
    mutationFn: universeApi.refresh,
    onSuccess: () => {
      toast.success(t('已让后端刷新 OKX 资产全集,刷新完会顺带跑一遍全市场扫描'));
      void qc.invalidateQueries({ queryKey: ['universe'] });
      void qc.invalidateQueries({ queryKey: ['screener'] });
    },
    onError: (err) => toast.error(t('刷新失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const tryAdd = (syms: string[]) => {
    const fresh = [...new Set(syms)].filter((s) => !inList.has(s));
    if (!fresh.length) {
      toast.info(t('都已经在名单里了'));
      return;
    }
    if (fresh.length > quo.room) {
      toast.error(t('名额不够:还能加 {room} 个,想加 {n} 个', { room: quo.room, n: fresh.length }), { description: t('先移掉几个,或者把名单上限调高') });
      return;
    }
    onAdd(fresh);
    setPicked((p) => {
      const n = new Set(p);
      for (const s of fresh) n.delete(s);
      return n;
    });
  };

  const onEnter = () => {
    // 敲了分隔符 = 一次加几个;否则加列表第一个还没监控的
    if (/[,，\s]/.test(q.trim())) {
      const syms = parseSymbolInput(q);
      const bad = data ? syms.filter((s) => !known.has(s)) : [];
      if (bad.length) {
        toast.error(t('{ex} 上没有这些币', { ex: exchangeName }), { description: bad.join('、') });
        return;
      }
      tryAdd(syms);
      setQ('');
      return;
    }
    const first = rows.find((r) => !inList.has(r.symbol));
    if (first) {
      tryAdd([first.symbol]);
      setQ('');
    }
  };

  const togglePick = (sym: string, on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      if (on) n.add(sym);
      else n.delete(sym);
      return n;
    });

  const fullReason = t('名单满了({used} / {max}):先移掉几个,或者把上限调高', { used: quo.used, max: quo.max });

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {/* 搜索 + 筛选 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2.5 py-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onEnter();
              } else if (e.key === 'Escape') setQ('');
            }}
            placeholder={t('搜代码或名称,比如 sol;Enter 加第一个')}
            className="num h-7 pl-7 text-[12px]"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('搜索资产')}
          />
        </div>
        <div className="flex items-center gap-0.5 rounded-md border p-0.5">
          {MARKETS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMarket(m.id)}
              className={cn('rounded px-1.5 py-0.5 text-[11px] transition-colors', market === m.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')}
            >
              {t(m.label)}
            </button>
          ))}
        </div>
        <Select value={sortId} onValueChange={setSortId}>
          <SelectTrigger size="sm" className="h-7 w-32 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-[12px]">
                {t(s.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 数据源状态 + 名额 + 批量 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/30 px-2.5 py-1 text-[10.5px] text-muted-foreground">
        {universeQ.isLoading ? (
          <span>{t('加载资产列表…')}</span>
        ) : data?.fallback ? (
          <span className="text-warn" title={t('后端 /api/universe 还没上线;先用可交易列表联想,只有代码,没有价格 / 涨跌 / 资金费')}>
            {t('OKX 资产全集接口未就绪,先用可交易列表联想')}
          </span>
        ) : data ? (
          <span className="num">
            {t('{ex} 全集 {n} 个', { ex: exchangeName, n: data.total })}
            {data.updated_at ? ` · ${t('更新于 {t}', { t: relativeTime(data.updated_at) })}` : ''}
          </span>
        ) : (
          <span className="text-destructive">{t('资产列表加载失败')}</span>
        )}
        {data && !data.fallback ? (
          <button type="button" className="inline-flex items-center gap-0.5 hover:text-foreground disabled:opacity-50" disabled={refresh.isPending} onClick={() => refresh.mutate()} title={t('让后端现在重拉一次 OKX 在售清单(平时每天 UTC 00:10 自动刷)')}>
            <RefreshCw className={cn('size-3', refresh.isPending && 'animate-spin')} />
            {t('刷新')}
          </button>
        ) : null}
        <label className="flex items-center gap-1" title={t('稳定币、包装币等后端默认排除的')}>
          <input type="checkbox" className="size-3 accent-primary" checked={includeExcluded} onChange={(e) => setIncludeExcluded(e.target.checked)} />
          {t('含稳定币 / 包装币')}
        </label>
        <span className={cn('num ml-auto', quo.full ? 'text-warn' : 'text-foreground')} title={t('名单名额:已用 / 上限')}>
          {t('名额')} {quo.used} / {quo.max}
        </span>
        {pickedList.length ? (
          pickedList.length > quo.room ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button size="xs" disabled>
                    {t('加入所选({n})', { n: pickedList.length })}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('勾了 {n} 个,只剩 {room} 个名额', { n: pickedList.length, room: quo.room })}</TooltipContent>
            </Tooltip>
          ) : (
            <Button size="xs" disabled={busy} onClick={() => tryAdd(pickedList)}>
              {t('加入所选({n})', { n: pickedList.length })}
            </Button>
          )
        ) : null}
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label={t('资产列表')}>
        {rows.length === 0 && !universeQ.isLoading ? (
          <div className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">{q ? t('{ex} 上没有匹配「{q}」的资产', { ex: exchangeName, q }) : t('没有资产')}</div>
        ) : null}
        {rows.map((it) => (
          <AssetRow
            key={it.symbol}
            it={it}
            monitored={inList.has(it.symbol)}
            picked={picked.has(it.symbol)}
            onPick={(v) => togglePick(it.symbol, v)}
            full={quo.full}
            fullReason={fullReason}
            busy={busy}
            radar={radar?.get(it.symbol)}
            fallback={Boolean(data?.fallback)}
            onAdd={() => tryAdd([it.symbol])}
          />
        ))}
        {matched > rows.length ? (
          <div className="px-3 py-2 text-center text-[10.5px] text-muted-foreground">{t('还有 {n} 个没列出来,继续输入缩小范围', { n: matched - rows.length })}</div>
        ) : null}
      </div>
    </div>
  );
}

function AssetRow({
  it,
  monitored,
  picked,
  onPick,
  full,
  fullReason,
  busy,
  radar,
  fallback,
  onAdd,
}: {
  it: UniverseItem;
  monitored: boolean;
  picked: boolean;
  onPick: (v: boolean) => void;
  full: boolean;
  fullReason: string;
  busy: boolean;
  radar?: RadarHit;
  fallback: boolean;
  onAdd: () => void;
}) {
  const chg = it.change_24h;
  const addBtn = (
    <Button size="icon-xs" variant="outline" disabled={full || busy} onClick={onAdd} aria-label={t('加入 {symbol}', { symbol: it.symbol })} title={full ? undefined : t('加进观察列表')}>
      <Plus />
    </Button>
  );
  return (
    <div role="option" aria-selected={monitored} className={cn('flex items-center gap-2 border-b px-2.5 py-1 text-[11.5px] hover:bg-muted/40', picked && 'bg-primary/5', it.excluded && 'opacity-60')}>
      <input
        type="checkbox"
        className="size-3.5 shrink-0 accent-primary disabled:opacity-30"
        checked={picked && !monitored}
        disabled={monitored}
        onChange={(e) => onPick(e.target.checked)}
        aria-label={t('勾选 {symbol}', { symbol: it.symbol })}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="num font-semibold">{it.base}</span>
          <span className="num text-[10px] text-muted-foreground">/USDT</span>
          {fallback ? null : it.markets.map((m) => (
            <Badge key={m} variant="outline" className={cn('h-3.5 px-1 text-[9px]', m === 'perp' ? 'border-primary/30 text-primary' : 'text-muted-foreground')}>
              {m === 'perp' ? t('永续') : t('现货')}
            </Badge>
          ))}
          {radar ? (
            <Badge variant="outline" className="h-3.5 border-up/30 bg-up/10 px-1 text-[9px] text-up" title={t('今天雷达候选 #{rank}', { rank: radar.rank })}>
              {t('候选')} #{radar.rank}
            </Badge>
          ) : null}
          {it.excluded ? <span className="text-[9.5px] text-muted-foreground">{t('已排除')}</span> : null}
        </div>
        {fallback ? null : (
          <div className="num text-[10px] text-muted-foreground">
            {t('成交额')} {fmtCompact(it.quote_volume_24h)}
            {it.rank_by_volume ? ` #${it.rank_by_volume}` : ''}
            {it.funding_rate !== null ? ` · ${t('资金费')} ${fmtFunding(it.funding_rate)}` : ''}
          </div>
        )}
      </div>
      {fallback ? null : (
        <div className="num w-20 shrink-0 text-right">
          <div>{fmtLast(it.last)}</div>
          <div className={cn('text-[10.5px]', chg === null ? 'text-muted-foreground' : chg >= 0 ? 'text-up' : 'text-down')}>{fmtChange(chg)}</div>
        </div>
      )}
      <div className="flex w-14 shrink-0 justify-end">
        {monitored ? (
          <span className="inline-flex items-center gap-0.5 text-[10.5px] text-up">
            <Check className="size-3" />
            {t('已监控')}
          </span>
        ) : full ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{addBtn}</span>
            </TooltipTrigger>
            <TooltipContent>{fullReason}</TooltipContent>
          </Tooltip>
        ) : (
          addBtn
        )}
      </div>
    </div>
  );
}
