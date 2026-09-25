/**
 * 历史 tab · bias 翻转时间线:market-state/history 里每次 bias 变化画一个节点
 * (regime→regime),每条历史总结可折叠展开。不对后端返回顺序做假设,先按 as_of
 * 升序求出"翻转点",再倒序(最新在上)渲染。
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MarketState } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { BIAS_LABEL, REGIME_LABEL, fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

interface FlipNode {
  state: MarketState;
  prev: MarketState | null;
}

export function BiasTimeline({ history }: { history: MarketState[] }) {
  const now = useNow();
  const [openId, setOpenId] = useState<string | null>(null);

  const flips = useMemo<FlipNode[]>(() => {
    const asc = [...history].sort((a, b) => a.as_of - b.as_of);
    const out: FlipNode[] = [];
    let prev: MarketState | null = null;
    for (const state of asc) {
      if (!prev || prev.bias !== state.bias) out.push({ state, prev });
      prev = state;
    }
    return out.reverse(); // 最新的翻转在最上面
  }, [history]);

  if (history.length === 0) {
    return <div className="py-6 text-center text-[11.5px] text-muted-foreground">{t('还没有历史记录。')}</div>;
  }
  if (flips.length === 0) {
    return <div className="py-6 text-center text-[11.5px] text-muted-foreground">{t('偏向一直没变过。')}</div>;
  }

  return (
    <ol className="relative ml-2 border-l pl-4 py-2">
      {flips.map((f) => {
        const open = openId === f.state.id;
        return (
          <li key={f.state.id} className="relative pb-4 text-[12px]">
            <span
              className={cn(
                'absolute -left-[21px] top-0.5 size-2.5 rounded-full border-2 border-card',
                f.state.bias === 'long' ? 'bg-up' : f.state.bias === 'short' ? 'bg-down' : 'bg-muted-foreground/60',
              )}
            />
            <button type="button" className="flex w-full flex-wrap items-center gap-1.5 text-left" onClick={() => setOpenId(open ? null : f.state.id)}>
              {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="num text-[10.5px] text-muted-foreground" title={fmtDateTime(f.state.as_of)}>
                {relativeTime(f.state.as_of, now)}
              </span>
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                {f.prev ? REGIME_LABEL[f.prev.regime] : '—'} → {REGIME_LABEL[f.state.regime]}
              </Badge>
              <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', f.state.bias === 'long' ? 'bg-up/15 text-up border-up/30' : f.state.bias === 'short' ? 'bg-down/15 text-down border-down/30' : '')}>
                {BIAS_LABEL[f.state.bias]}
              </Badge>
            </button>
            {open ? (
              <div className="mt-1.5 ml-5 rounded-sm bg-muted/40 px-2 py-1.5 text-[11.5px] leading-relaxed text-foreground/90 animate-in fade-in slide-in-from-top-1 duration-200">
                {f.state.summary || t('（这条没有总结)')}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
