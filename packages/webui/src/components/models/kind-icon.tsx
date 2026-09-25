/** 连接类型图标(§9.52 连接列表 / 添加弹层共用);只用 lucide 通用图标,不画厂商商标 */
import { Bot, BrainCircuit, Fish, Plug, Sparkles, Terminal, Waypoints, type LucideIcon } from 'lucide-react';
import type { ConnectionKind } from '@/api/types';
import { cn } from '@/lib/utils';

const KIND_ICON: Record<ConnectionKind, LucideIcon> = {
  openrouter: Waypoints,
  anthropic: Sparkles,
  deepseek: Fish,
  zai: BrainCircuit,
  openai: Bot,
  openai_compatible: Plug,
  cli: Terminal,
};

export function KindIcon({ kind, className }: { kind: ConnectionKind; className?: string }) {
  const Icon = KIND_ICON[kind] ?? Plug;
  return <Icon className={cn('shrink-0', className)} aria-hidden />;
}
