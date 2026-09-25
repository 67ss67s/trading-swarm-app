/**
 * 全币种可搜索选择器(v3,docs/demo/v3-ui-contract.md §5):/api/symbols 现在返回几百个 USDT 永续,
 * 原来的 Select 下拉翻不动。用 cmdk 的命令面板做搜索:置顶「观察列表」和「有线程的币」,下面是全部。
 */
import { useMemo, useState } from 'react';
import { ChevronsUpDown, Pin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import type { SymbolInfo } from '@/api/types';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

export function SymbolPicker({
  symbols,
  value,
  onChange,
  watchlist = [],
  threadSymbols = [],
  className,
}: {
  symbols: SymbolInfo[];
  value: string;
  onChange: (symbol: string) => void;
  watchlist?: string[];
  threadSymbols?: string[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const all = useMemo(() => symbols.filter((s) => !s.status || s.status === 'TRADING').map((s) => s.symbol).sort(), [symbols]);
  const pinned = useMemo(() => [...new Set([...watchlist, ...threadSymbols])].filter((s) => all.includes(s) || symbols.length === 0), [watchlist, threadSymbols, all, symbols.length]);
  const rest = useMemo(() => all.filter((s) => !pinned.includes(s)), [all, pinned]);

  const pick = (s: string) => {
    onChange(s);
    setOpen(false);
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" className={cn('num w-full justify-between font-semibold', className)} onClick={() => setOpen(true)} aria-label={t('选择币种')}>
        <span className="truncate">{value || t('选择币种')}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title={t('选择币种')} description={t('共 {n} 个 USDT 永续', { n: all.length })}>
        <CommandInput placeholder={t('搜币种…(共 {n} 个)', { n: all.length })} autoFocus />
        <CommandList className="max-h-80">
          <CommandEmpty>{t('没有这个币')}</CommandEmpty>
          {pinned.length > 0 ? (
            <>
              <CommandGroup heading={t('观察列表 / 有线程')}>
                {pinned.map((s) => (
                  <CommandItem key={s} value={s} onSelect={() => pick(s)} data-checked={s === value} className="num">
                    <Pin className="text-muted-foreground" />
                    {s}
                    {threadSymbols.includes(s) ? <span className="ml-1 text-[10px] text-primary">{t('线程')}</span> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          ) : null}
          <CommandGroup heading={t('全部({n})', { n: rest.length })}>
            {rest.map((s) => (
              <CommandItem key={s} value={s} onSelect={() => pick(s)} data-checked={s === value} className="num">
                {s}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
