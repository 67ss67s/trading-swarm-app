/**
 * 「按此区间重跑」:选一个区间(图上选区 / 今年 / 近 3、6 个月 / 近 1 年 / 全部 / 自定义起止),
 * 用同一份 strategy_ir + timeframe + 资产调 POST /api/research/backtests(零模型,同步,几秒到十几秒),
 * 成功后默认跳到新报告 #backtest?id=<新 id>;调用方可以用 onDone 接管(研究页就地换面板、策略详情跳详情)。
 * 当前报告不动,新报告另存一份。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Loader2, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import type { BacktestReport } from '@trading-swarm/contracts';
import { researchApi } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ymd } from './format';
import { RANGE_PRESET_KEYS, dayInput, parseDay, presetWindow, rangeProblem, rerunRequest, rerunSymbols, spanDays, type RangePresetKey, type TimeRange } from './range';

export type RerunMode = RangePresetKey | 'selection' | 'custom';

export function presetLabel(k: RangePresetKey): string {
  return k === 'ytd' ? t('今年') : k === '3m' ? t('近 3 个月') : k === '6m' ? t('近 6 个月') : k === '1y' ? t('近 1 年') : t('全部');
}

export function openBacktestReport(id: string): void {
  window.location.hash = `backtest?id=${encodeURIComponent(id)}`;
}

export interface RangeRerunButtonProps {
  report: BacktestReport;
  /** 图上当前选区;有的话默认按它重跑 */
  selection?: TimeRange | null;
  /** 新报告生成后;不传 = 跳到 #backtest?id=<新 id> */
  onDone?: (reportId: string) => void;
  label?: string;
  variant?: 'outline' | 'default' | 'ghost';
  size?: 'xs' | 'sm';
  className?: string;
}

export function RangeRerunButton({ report, selection = null, onDone, label, variant = 'outline', size = 'sm', className }: RangeRerunButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={variant} size={size} className={className} data-testid="range-rerun-trigger">
          <RotateCw />
          {label ?? t('换区间重跑')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(360px,92vw)] p-3.5">
        {open ? <RangeRerunPanel report={report} selection={selection} onDone={onDone} onClose={() => setOpen(false)} /> : null}
      </PopoverContent>
    </Popover>
  );
}

export function RangeRerunPanel({ report, selection = null, onDone, onClose, now: nowProp }: { report: BacktestReport; selection?: TimeRange | null; onDone?: (reportId: string) => void; onClose?: () => void; now?: number }) {
  const [now] = useState(() => nowProp ?? Date.now());
  const [mode, setMode] = useState<RerunMode>(selection ? 'selection' : '1y');
  const [fromText, setFromText] = useState(() => dayInput(selection?.from_ms ?? report.window.from_ms));
  const [toText, setToText] = useState(() => dayInput(Math.min(selection?.to_ms ?? now, now)));
  const qc = useQueryClient();
  const allLabel = t('全部窗口');

  const range: TimeRange | null | 'invalid' = (() => {
    if (mode === 'selection') return selection ? { from_ms: selection.from_ms, to_ms: Math.min(selection.to_ms, now) } : 'invalid';
    if (mode === 'custom') {
      const f = parseDay(fromText);
      const to = parseDay(toText, true);
      return f === null || to === null ? 'invalid' : { from_ms: f, to_ms: Math.min(to, now) };
    }
    return presetWindow(mode, now);
  })();
  const problem = range === 'invalid' ? 'invalid' : rangeProblem(range, report.timeframe, now);
  const body = range === 'invalid' ? null : rerunRequest(report, range, allLabel);
  const symbols = rerunSymbols(report);

  const run = useMutation({
    mutationFn: () => researchApi.runBacktest(body!),
    onSuccess: ({ report_id }) => {
      void qc.invalidateQueries({ queryKey: ['research', 'backtests'] });
      void qc.invalidateQueries({ queryKey: ['research', 'my-strategies'] });
      void qc.invalidateQueries({ queryKey: ['research', 'my-strategy'] });
      toast.success(t('区间重跑完成,已打开新报告'));
      onClose?.();
      (onDone ?? openBacktestReport)(report_id);
    },
    onError: (e) => toast.error(t('区间重跑失败:{e}', { e: e instanceof Error ? e.message : String(e) })),
  });

  const problemText =
    problem === 'invalid'
      ? mode === 'selection'
        ? t('图上还没有选区')
        : t('日期格式不对')
      : problem === 'order'
        ? t('起点要早于终点')
        : problem === 'too_short'
          ? t('区间太短:至少 5 根 {tf} K 线', { tf: report.timeframe })
          : problem === 'future'
            ? t('起点在未来')
            : null;

  const modes: RerunMode[] = [...(selection ? (['selection'] as const) : []), ...RANGE_PRESET_KEYS, 'custom'];
  const modeLabel = (m: RerunMode) => (m === 'selection' ? t('图上选区') : m === 'custom' ? t('自定义') : presetLabel(m));

  return (
    <div className="space-y-3 text-[12px]" data-testid="range-rerun-panel">
      <div>
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <CalendarRange className="size-4 text-primary" />
          {t('按区间重跑')}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {t('同一份策略、{tf} 周期、{symbols};零模型回测,新报告另存,当前报告不变。', { tf: report.timeframe, symbols: symbols.join(' / ') || '—' })}
        </p>
      </div>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('重跑区间')}>
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={cn('h-6.5 rounded-md border px-2 text-[11.5px] transition-colors', mode === m ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}
          >
            {modeLabel(m)}
          </button>
        ))}
      </div>
      {mode === 'custom' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[10.5px] text-muted-foreground">{t('起(UTC)')}</span>
            <Input type="date" value={fromText} max={dayInput(now)} onChange={(e) => setFromText(e.target.value)} className="num h-7 text-[12px]" aria-label={t('起始日期')} />
          </label>
          <label className="space-y-1">
            <span className="text-[10.5px] text-muted-foreground">{t('止(UTC)')}</span>
            <Input type="date" value={toText} max={dayInput(now)} onChange={(e) => setToText(e.target.value)} className="num h-7 text-[12px]" aria-label={t('结束日期')} />
          </label>
        </div>
      ) : null}
      <div className="rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5">
        {range === 'invalid' ? (
          <span className="text-muted-foreground">—</span>
        ) : range ? (
          <span className="num text-foreground">
            {ymd(range.from_ms)} → {ymd(range.to_ms)} <span className="text-muted-foreground">· {t('{n} 天', { n: spanDays(range) })}</span>
          </span>
        ) : (
          <span className="text-foreground">{t('全部:后端缺省全窗口,到最新已收盘 K 线')}</span>
        )}
        <div className="mt-0.5 text-[10.5px] text-muted-foreground">{t('窗口起点之前会自动借 K 线做预热,交易从起点开始。')}</div>
      </div>
      {problemText ? <div className="text-[11px] text-warn">{problemText}</div> : null}
      {body ? (
        <div className="truncate text-[10.5px] text-muted-foreground" title={body.title}>
          {t('新报告标题')}:{body.title}
        </div>
      ) : null}
      <Button size="sm" className="w-full" disabled={!!problemText || !body || run.isPending} onClick={() => run.mutate()} data-testid="range-rerun-go">
        {run.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
        {run.isPending ? t('重跑中…(通常 10 秒左右)') : t('按此区间重跑')}
      </Button>
    </div>
  );
}
