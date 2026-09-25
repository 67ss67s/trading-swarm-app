/**
 * 楼层 v4 顶栏的币种芯片(可自定义):
 *   - 首次打开 = 观察列表前 5 个;之后用户的列表存 localStorage(tg.floor.v4.coins,读写 try/catch)
 *   - 末尾「+」开选币面板(与 SymbolPicker 同一套 cmdk 命令面板,OKX 全币种 /api/symbols)
 *   - 悬停出小 × 删除;按住拖动:拖到别的芯片上 = 排序,拖到画布上的 agent = 派活(外壳处理)
 *   - 最多 12 个
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pin } from 'lucide-react';
import { api } from '@/api/client';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { t } from '@/lib/i18n';

export const COINS_KEY = 'tg.floor.v4.coins';
export const COINS_MAX = 12;
export const COINS_DEFAULT_N = 5;

const SYM_RE = /^[A-Z0-9]{1,20}USDT$/;

/** 存储里的列表(坏数据 / 读不到 → null,调用方用观察列表兜底) */
export function loadCoins(): string[] | null {
  try {
    const raw = window.localStorage.getItem(COINS_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return normCoins(v.filter((x): x is string => typeof x === 'string'));
  } catch {
    return null;
  }
}
export function saveCoins(list: readonly string[]): void {
  try {
    window.localStorage.setItem(COINS_KEY, JSON.stringify(list));
  } catch {
    /* 私密模式 */
  }
}

/** 去重、只留 XXXUSDT、截到上限 */
export function normCoins(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of list) {
    const u = s.trim().toUpperCase();
    if (SYM_RE.test(u) && !out.includes(u)) out.push(u);
    if (out.length >= COINS_MAX) break;
  }
  return out;
}

/** 实际显示的列表:用户存过就用存的(空列表也算用户的选择),否则观察列表前 5 个 */
export function effectiveCoins(stored: readonly string[] | null, watchlist: readonly string[]): string[] {
  return stored ? normCoins(stored) : normCoins(watchlist).slice(0, COINS_DEFAULT_N);
}

export function addCoin(list: readonly string[], sym: string): string[] {
  return normCoins([...list, sym]);
}
export function removeCoin(list: readonly string[], sym: string): string[] {
  return list.filter((s) => s !== sym);
}
/** 把 from 挪到 to 的位置 */
export function moveCoin(list: readonly string[], from: string, to: string): string[] {
  const i = list.indexOf(from);
  const j = list.indexOf(to);
  if (i < 0 || j < 0 || i === j) return [...list];
  const next = [...list];
  next.splice(i, 1);
  next.splice(j, 0, from);
  return next;
}

/** 「+」芯片打开的选币面板:置顶观察列表 / 有线程的币,已在顶栏的币不再列 */
export function CoinPickerDialog({ open, onOpenChange, current, watchlist, threadSymbols, onPick }: { open: boolean; onOpenChange: (v: boolean) => void; current: readonly string[]; watchlist: readonly string[]; threadSymbols: readonly string[]; onPick: (sym: string) => void }) {
  const symbolsQ = useQuery({ queryKey: ['symbols'], queryFn: api.symbols, staleTime: 600_000, retry: false }); // /api/symbols 可能要几十秒:页面一开就预取,点「+」时多半已就绪
  const all = useMemo(() => (symbolsQ.data?.symbols ?? []).filter((s) => !s.status || s.status === 'TRADING').map((s) => s.symbol).sort(), [symbolsQ.data]);
  const pinned = useMemo(() => [...new Set([...watchlist, ...threadSymbols])].filter((s) => !current.includes(s) && (all.length === 0 || all.includes(s))), [watchlist, threadSymbols, current, all]);
  const rest = useMemo(() => all.filter((s) => !current.includes(s) && !pinned.includes(s)), [all, current, pinned]);
  const full = current.length >= COINS_MAX;
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t('加一个币到顶栏')} description={t('最多 {n} 个,拖给 agent 派活', { n: COINS_MAX })}>
      <CommandInput placeholder={full ? t('顶栏满了(最多 {n} 个),先删一个', { n: COINS_MAX }) : t('搜币种…(共 {n} 个)', { n: all.length })} autoFocus disabled={full} />
      <CommandList className="max-h-80">
        <CommandEmpty>{symbolsQ.isPending ? t('加载币种…') : t('没有这个币')}</CommandEmpty>
        {!full && pinned.length > 0 ? (
          <>
            <CommandGroup heading={t('观察列表 / 有线程')}>
              {pinned.map((s) => (
                <CommandItem key={s} value={s} onSelect={() => onPick(s)} className="num">
                  <Pin className="text-muted-foreground" />
                  {s}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}
        {!full ? (
          <CommandGroup heading={t('全部({n})', { n: rest.length })}>
            {rest.map((s) => (
              <CommandItem key={s} value={s} onSelect={() => onPick(s)} className="num">
                {s}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}

/** 打开 / 关闭面板的小状态钩子 */
export function usePicker(): [boolean, (v: boolean) => void] {
  return useState(false);
}
