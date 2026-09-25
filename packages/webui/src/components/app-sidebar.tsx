import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleCheck, Ellipsis } from 'lucide-react';
import { api } from '@/api/client';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { NAV, NAV_COLLAPSIBLE_GROUPS, NAV_GROUP_LABEL, NAV_GROUP_ORDER, type NavGroup, type NavItem, type Page } from '@/lib/nav';
import { useStartCore } from '@/components/start/use-start';
import { t } from '@/lib/i18n';

/**
 * 全局待办徽章(三层监督的第一层,docs/design/ops-floor-2026-09-05.md §8):
 * 待阅的 bot 交接(['bots','handoffs','pending'],SSE bots.changed 按前缀 ['bots'] 失效)
 * + 等人批的提案(['intents'],intent.changed 时失效;老网关/接口失败按 0 处理)。
 * 只挂在「楼层」和「Agent」两项上:楼层看交接,Agent 页批提案。
 */
function usePendingCounts(): { handoffs: number; intents: number } {
  const handoffsQ = useQuery({ queryKey: ['bots', 'handoffs', 'pending'], queryFn: () => api.botHandoffs('pending', 50), refetchInterval: 60_000, retry: false });
  const intentsQ = useQuery({ queryKey: ['intents'], queryFn: () => api.intents(50), refetchInterval: 60_000, retry: false });
  const handoffs = handoffsQ.data?.handoffs?.length ?? 0;
  const intents = (intentsQ.data ?? []).filter((i) => i.status === 'pending_approval').length;
  return { handoffs, intents };
}

interface AppSidebarProps {
  page: Page;
  onNavigate: (page: Page) => void;
}

const COLLAPSE_KEY = 'tg.nav.collapsed';

/** 折叠组的开合记在本机(try/catch:私密模式 / 沙箱里读写会抛) */
function readCollapsed(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeCollapsed(v: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function AppSidebar({ page, onNavigate }: AppSidebarProps) {
  const pending = usePendingCounts();
  const start = useStartCore();
  // 用户点过的开合;没点过的折叠组默认收起
  const [openState, setOpenState] = useState<Record<string, boolean>>(readCollapsed);
  const isOpen = (g: NavGroup) => (NAV_COLLAPSIBLE_GROUPS.includes(g) ? (openState[g] ?? false) : true);
  const toggle = (g: NavGroup) =>
    setOpenState((cur) => {
      const next = { ...cur, [g]: !isOpen(g) };
      writeCollapsed(next);
      return next;
    });
  const badgeFor = (id: Page): number => (id === 'floor' ? pending.handoffs + pending.intents : id === 'agent' ? pending.intents : 0);
  // 「开始」:核心四项没完成(或还判不出来)时置顶;完成后收到侧栏底部一行
  const startItem = NAV.find((n) => n.id === 'start')!;
  const startPinned = start.core !== true;

  const renderItem = (item: NavItem) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton isActive={page === item.id} tooltip={t(item.label)} onClick={() => onNavigate(item.id)} className="h-7 text-[12.5px] [&>svg]:size-3.5">
        <item.icon />
        <span>{t(item.label)}</span>
      </SidebarMenuButton>
      {badgeFor(item.id) > 0 ? (
        <SidebarMenuBadge className="bg-warn/20 text-warn" title={item.id === 'floor' ? t('{h} 条交接待读 · {i} 个提案待批', { h: pending.handoffs, i: pending.intents }) : t('{i} 个提案待批', { i: pending.intents })}>
          {badgeFor(item.id)}
        </SidebarMenuBadge>
      ) : null}
      {item.id === 'start' && start.progress.total > 0 ? (
        <SidebarMenuBadge className="bg-primary/15 text-primary" title={t('必做 {done} / {total} 项完成。', start.progress)}>
          {start.progress.done}/{start.progress.total}
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );

  return (
    <Sidebar collapsible="icon" className="select-none">
      <SidebarHeader className="py-1.5">
        <div className="flex items-center gap-2 px-1 py-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex size-6.5 shrink-0 items-center justify-center rounded bg-primary font-mono text-[11px] font-bold text-primary-foreground">
            TS
          </div>
          <div className="min-w-0 leading-none group-data-[collapsible=icon]:hidden">
            <div className="truncate text-[13px] font-semibold">Trading Swarm</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {startPinned ? (
          <SidebarGroup className="py-1">
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">{renderItem(startItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
        {NAV_GROUP_ORDER.map((g) => {
          const items = NAV.filter((item) => item.group === g);
          const collapsible = NAV_COLLAPSIBLE_GROUPS.includes(g);
          // 当前页在折叠组里时强制展开,免得「选中的项看不见」
          const open = isOpen(g) || items.some((i) => i.id === page);
          return (
            <SidebarGroup key={g} className="py-1">
              {collapsible ? null : <SidebarGroupLabel className="kicker h-5 px-2 text-[9.5px] text-muted-foreground/70">{NAV_GROUP_LABEL[g]}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {collapsible ? (
                    <SidebarMenuItem>
                      {/* 用菜单按钮而不是组名做开关:侧栏收成图标时组名会隐藏,按钮还在 */}
                      <SidebarMenuButton tooltip={NAV_GROUP_LABEL[g]} onClick={() => toggle(g)} aria-expanded={open} className="h-7 text-[12px] text-muted-foreground [&>svg]:size-3.5" data-testid={`nav-group-toggle-${g}`}>
                        <Ellipsis />
                        <span>{NAV_GROUP_LABEL[g]}</span>
                        {open ? <ChevronDown className="ml-auto" /> : <ChevronRight className="ml-auto" />}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : null}
                  {open ? items.map(renderItem) : null}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      {!startPinned ? (
        <SidebarFooter className="py-1.5">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={page === 'start'} tooltip={t('接入完成 ✓')} onClick={() => onNavigate('start')} className="h-7 text-[11.5px] text-muted-foreground [&>svg]:size-3.5" data-testid="nav-start-done">
                <CircleCheck className="text-up" />
                <span>{t('接入完成 ✓')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      ) : null}
    </Sidebar>
  );
}
