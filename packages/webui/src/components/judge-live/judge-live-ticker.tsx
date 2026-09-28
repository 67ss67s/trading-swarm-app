/**
 * 紧凑版 Jev 判断流,给楼层判断桌用(楼层 floor-v4/** 归另一个会话,这里只导出组件,不改楼层)。
 *
 *   <JudgeLiveTicker limit={5} />                        // 自己取数(useJudgeLive,和 Agent 页共用缓存 + SSE)
 *   <JudgeLiveTicker items={rows} summary={s} />          // 楼层已有数据时直接喂
 *   <JudgeLiveTicker onSelect={(item) => ...} />          // 点一条的回调(比如楼层打开详情抽屉)
 *
 * 每条一行:时间 · 币种方向 · 影子/挡单 · 跟/不跟 · 第一个问题的概率;顶部一行今日调用/花费/跟单率。
 */
import { useJudgeLive, type JudgeLiveItem, type JudgeLiveSummary } from '@/api/judge-live';
import { fmtClock } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { directionText, MODE_LABEL, pct, questionRows, summaryLine, verdict } from './logic';

export interface JudgeLiveTickerProps {
  /** 最多显示几条,默认 5 */
  limit?: number;
  /** 只看某个运行 */
  runId?: string | null;
  /** 外部已有数据时直接传,组件就不自己取 */
  items?: JudgeLiveItem[];
  summary?: JudgeLiveSummary;
  /** 点一条 */
  onSelect?: (item: JudgeLiveItem) => void;
  /** 是否显示顶部今日汇总,默认显示 */
  showSummary?: boolean;
  className?: string;
}

export function JudgeLiveTicker(props: JudgeLiveTickerProps) {
  if (props.items) return <JudgeLiveTickerView {...props} items={props.items} />;
  return <JudgeLiveTickerFetch {...props} />;
}

function JudgeLiveTickerFetch(props: JudgeLiveTickerProps) {
  const q = useJudgeLive({ limit: props.limit ?? 5, runId: props.runId ?? null });
  return <JudgeLiveTickerView {...props} items={q.data?.items ?? []} summary={q.data?.summary} loading={q.isLoading} />;
}

export function JudgeLiveTickerView({ items, summary, onSelect, showSummary = true, limit = 5, className, loading }: JudgeLiveTickerProps & { items: JudgeLiveItem[]; loading?: boolean }) {
  const s = summaryLine(summary);
  return (
    <div className={cn('text-[11px]', className)}>
      {showSummary ? (
        <div className="flex gap-2 border-b px-2 py-1 text-[10px] text-muted-foreground">
          <span>{t('Jev 今日 {n} 次', { n: s.calls })}</span>
          <span>{s.cost}</span>
          <span className="ml-auto truncate">{s.ratio}</span>
        </div>
      ) : null}
      {!items.length ? (
        <div className="px-2 py-1.5 text-muted-foreground">{loading ? t('读取中…') : t('还没有实盘判断')}</div>
      ) : (
        <ul className="divide-y">
          {items.slice(0, limit).map(it => {
            const v = verdict(it), first = questionRows(it)[0];
            return (
              <li key={it.id}>
                <button type="button" className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/40 disabled:cursor-default" disabled={!onSelect} onClick={() => onSelect?.(it)}>
                  <span className="num text-[10px] text-muted-foreground">{fmtClock(it.created_at).slice(0, 5)}</span>
                  <span className="num font-semibold">{it.symbol.replace(/USDT$/, '')}</span>
                  <span className={it.candidate.direction === 'long' ? 'text-up' : 'text-down'}>{directionText(it.candidate.direction)}</span>
                  <span className="text-[10px] text-muted-foreground">{MODE_LABEL[it.mode]}</span>
                  <span className={cn('font-semibold', v.tone === 'up' ? 'text-up' : v.tone === 'down' ? 'text-down' : v.tone === 'warn' ? 'text-warn' : 'text-muted-foreground')}>{v.text}</span>
                  {first?.top ? <span className="num ml-auto text-[10px] text-muted-foreground">{first.name} {first.top.name} {pct(first.top.p)}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
