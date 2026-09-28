/**
 * Agent 页右栏入口条(2026-09-25 改版):与新手旅程一致 —— 开始清单 → 策略研究 → 我的策略 → 复盘。
 * 研究工作台 / 判断记录 / 信号市场 / 进化 在侧栏导航里,对话里的深链也会直接带过去。
 */
import { FileClock, FlaskConical, ListTodo, Shapes } from 'lucide-react';
import { t } from '@/lib/i18n';

export const AGENT_QUICK_LINKS = [
  { href: '#start', label: '开始清单', icon: ListTodo },
  { href: '#strategy-research', label: '策略研究', icon: FlaskConical },
  { href: '#my-strategies', label: '我的策略', icon: Shapes },
  { href: '#history', label: '复盘', icon: FileClock },
] as const;

export function AgentQuickLinks() {
  return (
    <nav aria-label={t('常用入口')} className="grid grid-cols-4 divide-x">
      {AGENT_QUICK_LINKS.map((l, i) => (
        <a
          key={l.href}
          href={l.href}
          className="group flex flex-col items-center gap-0.5 px-1 py-1.5 text-[10.5px] text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50 focus-visible:outline-none"
          title={t(l.label)}
        >
          <span className="flex items-center gap-1">
            <span className="num text-[9px] text-muted-foreground/60 group-hover:text-primary">{i + 1}</span>
            <l.icon className="size-3.5" />
          </span>
          <span className="max-w-full truncate">{t(l.label)}</span>
        </a>
      ))}
    </nav>
  );
}
