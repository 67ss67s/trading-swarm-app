/**
 * Agent 页右栏顶部的入口条(docs/design/watch-screener-review-2026-09-24.md 二-5):
 * 研究工作台 / 我的策略 / 判断记录 / 信号市场 / 进化 —— 对话里聊到这些,一点就过去。
 * 放右栏不放状态条:状态条里有「盯盘参数」抽屉,另一条线在改。
 */
import { ClipboardList, FlaskConical, Shapes, Sprout, Store } from 'lucide-react';
import { t } from '@/lib/i18n';

export const AGENT_QUICK_LINKS = [
  { href: '#research', label: '研究工作台', icon: FlaskConical },
  { href: '#my-strategies', label: '我的策略', icon: Shapes },
  { href: '#judgments', label: '判断记录', icon: ClipboardList },
  { href: '#market', label: '信号市场', icon: Store },
  { href: '#evolution', label: '进化', icon: Sprout },
] as const;

export function AgentQuickLinks() {
  return (
    <nav aria-label={t('常用入口')} className="grid grid-cols-5 divide-x">
      {AGENT_QUICK_LINKS.map((l) => (
        <a key={l.href} href={l.href} className="flex flex-col items-center gap-0.5 px-1 py-1.5 text-[10.5px] text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50 focus-visible:outline-none" title={t(l.label)}>
          <l.icon className="size-3.5" />
          <span className="max-w-full truncate">{t(l.label)}</span>
        </a>
      ))}
    </nav>
  );
}
