import { useEffect } from 'react';
import { Lock, OctagonAlert } from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { NAV, type Page } from '@/lib/nav';
import { lockReason } from '@/lib/edition';
import { t } from '@/lib/i18n';

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (page: Page) => void;
  halted: boolean;
  onOpenHalt: () => void;
  onOpenResumeHalt: () => void;
}

export function CommandMenu({ open, onOpenChange, onNavigate, halted, onOpenHalt, onOpenResumeHalt }: CommandMenuProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  // 评审版:紧急停止 / 解除都锁住(会平掉演示仓位),条目保留但置灰,悬停看原因
  const haltLock = lockReason('emergency_stop');
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t('命令面板')} description={t('快速跳转和操作')}>
      <CommandInput placeholder={t('搜页面或操作…')} />
      <CommandList>
        <CommandEmpty>{t('没有匹配的结果')}</CommandEmpty>
        <CommandGroup heading={t('页面')}>
          {NAV.map((item) => (
            <CommandItem key={item.id} onSelect={() => run(() => onNavigate(item.id))}>
              <item.icon />
              {t(item.label)}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('操作')}>
          {haltLock ? (
            <CommandItem disabled title={haltLock} data-judge-lock="emergency_stop">
              <OctagonAlert /> {halted ? t('解除紧急停止') : t('紧急停止')}
              <Lock className="ml-auto" />
            </CommandItem>
          ) : (
            <CommandItem onSelect={() => run(halted ? onOpenResumeHalt : onOpenHalt)}>
              <OctagonAlert /> {halted ? t('解除紧急停止') : t('紧急停止')}
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
