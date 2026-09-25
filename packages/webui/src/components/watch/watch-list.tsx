/**
 * 观察列表(docs/design/watch-screener-review-2026-09-24.md 二-2):
 * 每币一行 最新价 / 24h / 是否在今天的雷达候选里 / 可交易开关;一键移除;拖动排序(也有上移下移按钮);
 * 顶部名额「32 / 60」+ 上限可调。写入由调用方走 PATCH /api/workflow。
 */
import { useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { relativeTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fmtChange, fmtLast, quota, type RadarHit } from './watch-logic';

export interface WatchRowQuote {
  last: number | null;
  change: number | null;
}

export function WatchList({
  watchlist,
  watchOnly,
  max,
  quotes,
  radar,
  positions,
  busy,
  onRemove,
  onMove,
  onSetTrade,
  onSetMax,
  className,
}: {
  watchlist: string[];
  watchOnly: string[];
  max: number;
  quotes: Map<string, WatchRowQuote>;
  radar: Map<string, RadarHit>;
  /** 有在管线程 / 持仓的币:不许一键移除(行情轮询按名单走,移掉会断证据) */
  positions: Map<string, 'in_position' | 'pending_entry' | 'orphan'>;
  busy: boolean;
  onRemove: (sym: string) => void;
  onMove: (from: number, to: number) => void;
  onSetTrade: (sym: string, trade: boolean) => void;
  onSetMax: (n: number) => void;
  className?: string;
}) {
  const quo = quota(watchlist.length, max);
  const wo = new Set(watchOnly);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [maxText, setMaxText] = useState<string | null>(null);
  const radarCount = watchlist.filter((s) => radar.has(s)).length;

  const commitMax = () => {
    if (maxText === null) return;
    const n = Math.round(Number(maxText));
    setMaxText(null);
    if (!Number.isFinite(n) || n === max) return;
    onSetMax(Math.min(300, Math.max(1, n)));
  };

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5 text-[11px]">
        <span className={cn('num text-[12px]', quo.full ? 'text-warn' : 'text-foreground')} title={t('名单名额:已用 / 上限')}>
          <b>{quo.used}</b> / {quo.max}
        </span>
        <span className="text-muted-foreground">
          {t('可交易 {a} · 只观察 {b}', { a: watchlist.length - watchlist.filter((s) => wo.has(s)).length, b: watchlist.filter((s) => wo.has(s)).length })}
        </span>
        <span className="text-muted-foreground">{t('今天进雷达候选 {n} 个', { n: radarCount })}</span>
        <label className="num ml-auto flex items-center gap-1 text-muted-foreground" title={t('每多一个币,就多一份心跳 / 收盘判断的模型费;1–300')}>
          {t('上限')}
          <Input
            type="number"
            min={1}
            max={300}
            value={maxText ?? String(max)}
            onChange={(e) => setMaxText(e.target.value)}
            onBlur={commitMax}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitMax();
            }}
            className="num h-6 w-14 text-[11px]"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {watchlist.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11.5px] text-muted-foreground">{t('名单是空的:从旁边的资产列表点「+」加几个')}</div>
        ) : null}
        {watchlist.map((sym, i) => {
          const q = quotes.get(sym);
          const hit = radar.get(sym);
          const pos = positions.get(sym);
          const trade = !wo.has(sym);
          const locked = pos === 'in_position' || pos === 'pending_entry';
          return (
            <div
              key={sym}
              draggable={!busy}
              onDragStart={(e) => {
                setDragFrom(i);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', sym);
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                setDragOver(i);
              }}
              onDragLeave={() => setDragOver((o) => (o === i ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null && dragFrom !== i) onMove(dragFrom, i);
                setDragFrom(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              className={cn(
                'group flex items-center gap-1.5 border-b px-1.5 py-1 text-[11.5px] hover:bg-muted/40',
                dragFrom === i && 'opacity-40',
                dragOver === i && dragFrom !== null && dragFrom !== i && (dragFrom < i ? 'border-b-2 border-b-primary' : 'border-t-2 border-t-primary'),
              )}
            >
              <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground/60" aria-hidden />
              <span className="num w-5 shrink-0 text-right text-[10px] text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <a href={`#trade?symbol=${sym}`} className="num font-semibold hover:underline">
                    {sym}
                  </a>
                  {pos ? (
                    <Badge variant="outline" className={cn('h-3.5 px-1 text-[9px]', pos === 'orphan' ? 'border-warn/40 text-warn' : 'border-up/40 text-up')}>
                      {pos === 'orphan' ? t('无主仓') : pos === 'pending_entry' ? t('待入场') : t('持仓')}
                    </Badge>
                  ) : null}
                </div>
                <div className="truncate text-[10px]">
                  {hit ? (
                    <a href="#screener" className="text-up hover:underline" title={t('{t}的筛选', { t: relativeTime(hit.at) })}>
                      {t('今日候选 #{rank} · 契合 {fit}', { rank: hit.rank, fit: hit.fit.toFixed(2) })}
                    </a>
                  ) : (
                    <span className="text-muted-foreground/70">{t('今天没进雷达候选')}</span>
                  )}
                </div>
              </div>
              <div className="num w-20 shrink-0 text-right">
                <div>{fmtLast(q?.last ?? null)}</div>
                <div className={cn('text-[10.5px]', q?.change == null ? 'text-muted-foreground' : q.change >= 0 ? 'text-up' : 'text-down')}>{fmtChange(q?.change ?? null)}</div>
              </div>
              <label className="flex w-[4.75rem] shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap" title={trade ? t('可交易:判断能出 PROPOSE') : t('只观察:判断只能出 NO_TRADE / WATCH')}>
                <Switch checked={trade} disabled={busy} onCheckedChange={(v) => onSetTrade(sym, v)} className="scale-75" />
                <span className={cn('text-[10px]', trade ? 'text-foreground' : 'text-muted-foreground')}>{trade ? t('可交易') : t('只观察')}</span>
              </label>
              <div className="flex shrink-0 items-center">
                <button type="button" disabled={busy || i === 0} onClick={() => onMove(i, i - 1)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30" aria-label={t('上移 {symbol}', { symbol: sym })}>
                  <ArrowUp className="size-3" />
                </button>
                <button type="button" disabled={busy || i === watchlist.length - 1} onClick={() => onMove(i, i + 1)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30" aria-label={t('下移 {symbol}', { symbol: sym })}>
                  <ArrowDown className="size-3" />
                </button>
                <button
                  type="button"
                  disabled={busy || locked}
                  onClick={() => onRemove(sym)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-down/10 hover:text-down disabled:opacity-30"
                  aria-label={t('移除 {symbol}', { symbol: sym })}
                  title={locked ? t('还有在管的线程,先在交易页平掉或撤掉再移除') : t('移出名单')}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
