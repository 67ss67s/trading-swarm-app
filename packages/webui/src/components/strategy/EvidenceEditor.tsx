/**
 * 自定义证据编辑器(契约 §9.34,设计 docs/design/strategy-research-v3-and-event-research-2026-09-12.md §5)。
 *
 * 一条策略的「证据集」= 它要哪些指标、对哪些触发种类醒、要哪些新闻主题。它**进 content_hash**,
 * 所以这里没有「原地保存」这条路:点保存 = `PUT /api/strategies/:id/evidence` → 网关出一个新 draft,
 * 旧版本一个字不动。UI 必须把这件事说清楚,不然用户会以为自己在改线上那一条。
 *
 * 指标库来自 `GET /api/market/indicators/sets`(§9.10),分类表在本文件里(网关只给 id 列表,
 * 不给分组;分组是纯展示口径,写死在前端比多开一个端点诚实)。列 = 周期,行 = 指标,勾一个格
 * 就是「这个指标在这个周期上要」。
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { StrategyEvidenceSpec } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { triggerLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

/** 勾选格能选的周期(与网关 `TF_MINUTES` 的常用子集一致;策略里已有的别的周期会另起一列)。 */
const TIMEFRAMES = ['15m', '1h', '4h', '1d'];

/** 指标分类(纯展示分组)。指标库里出现但没归类的落进「其它」,不丢。 */
const CATEGORIES: { key: string; label: string; ids: string[] }[] = [
  { key: 'ma', label: '均线', ids: ['ema20', 'ema50', 'ema200', 'sma20', 'sma50', 'sma200', 'wma20', 'dema20', 'tema20'] },
  { key: 'band', label: '通道与带', ids: ['bb', 'keltner', 'donchian', 'vwap', 'vwap_session'] },
  { key: 'trend', label: '趋势', ids: ['supertrend', 'psar', 'ichimoku', 'adx', 'aroon', 'trix'] },
  { key: 'osc', label: '动量与震荡', ids: ['rsi', 'stochrsi', 'stoch', 'macd', 'cci', 'mfi', 'willr', 'mom', 'roc'] },
  { key: 'vol', label: '波动率', ids: ['atr', 'natr', 'stddev', 'squeeze'] },
  { key: 'volume', label: '量能', ids: ['obv', 'ad'] },
];

const CATEGORY_LABEL = tmap(Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<string, string>);

/**
 * 能勾的触发种类。系统内部的那几种(chat / schedule / monitor …)不在这里:
 * 它们不是「这条策略对什么行情醒」,勾了只会让人以为策略能被聊天叫醒。
 */
const EVENT_KINDS = ['kline_close', 'breakout', 'retest', 'ema_cross', 'fast_move', 'vol_spike', 'funding', 'session', 'event', 'heartbeat'];

type Cell = string; // `${id}@${tf}`

const cellKey = (id: string, tf: string): Cell => `${id}@${tf}`;

/** 规范化:排序 + 去重,和网关 `validateEvidenceSpec` 的返回口径一致,这样「有没有改」判得准。 */
function canonical(spec: StrategyEvidenceSpec): string {
  return JSON.stringify({
    indicators: [...spec.indicators].map((i) => `${i.id}@${i.tf}`).sort(),
    events: [...spec.events].sort(),
    info_topics: [...(spec.info_topics ?? [])].sort(),
  });
}

export function EvidenceEditor({
  strategyId,
  /** 这条策略**生效**的证据集(没写自定义时就是默认集),编辑器以它为起点。 */
  effective,
  /** 有没有写过自定义证据(false = 现在跑的是默认集)。 */
  custom,
  headVersion,
  /** 保存成功(出了新 draft)后回调:页面用它跳到时间线。 */
  onSaved,
}: {
  strategyId: string;
  effective: StrategyEvidenceSpec;
  custom: boolean;
  headVersion: number;
  onSaved: (version: number) => void;
}) {
  const qc = useQueryClient();
  const setsQ = useQuery({ queryKey: ['indicator-sets'], queryFn: () => api.indicatorSets(), staleTime: 60 * 60_000 });

  const [cells, setCells] = useState<Set<Cell>>(new Set());
  const [events, setEvents] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [topicDraft, setTopicDraft] = useState('');

  /**
   * 换一条策略(或生效证据真的变了)才整体重置。依赖写成**规范化字符串**而不是 `effective` 对象:
   * SSE 一来就会让 ['strategies'] 前缀失效、react-query 给出一个新对象,按对象身份做依赖会把
   * 用户正在勾的一半改动无声抹掉。
   */
  const effectiveKey = canonical(effective);
  useEffect(() => {
    setCells(new Set(effective.indicators.map((i) => cellKey(i.id, i.tf))));
    setEvents([...effective.events]);
    setTopics([...(effective.info_topics ?? [])]);
    setTopicDraft('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId, headVersion, effectiveKey]);

  const allIds = useMemo(() => setsQ.data?.sets ?? [], [setsQ.data]);
  const grouped = useMemo(() => {
    const known = new Set(CATEGORIES.flatMap((c) => c.ids));
    const rest = allIds.filter((id) => !known.has(id));
    const groups = CATEGORIES.map((c) => ({ key: c.key, ids: c.ids.filter((id) => allIds.includes(id)) })).filter((g) => g.ids.length > 0);
    return rest.length ? [...groups, { key: 'other', ids: rest }] : groups;
  }, [allIds]);

  // 策略里已经写了、但不在默认四列里的周期(比如 5m)照样给一列,不然它会被静默改掉。
  const columns = useMemo(() => {
    const extra = [...cells].map((c) => c.split('@')[1] ?? '').filter((tf) => tf && !TIMEFRAMES.includes(tf));
    return [...TIMEFRAMES, ...[...new Set(extra)].sort()];
  }, [cells]);

  const draft: StrategyEvidenceSpec = useMemo(
    () => ({
      indicators: [...cells]
        .map((c) => {
          const [id = '', tf = ''] = c.split('@');
          return { id, tf };
        })
        .sort((a, b) => a.id.localeCompare(b.id) || a.tf.localeCompare(b.tf)),
      events: [...events].sort(),
      info_topics: [...topics].sort(),
    }),
    [cells, events, topics],
  );

  const dirty = canonical(draft) !== canonical(effective);

  const save = useMutation({
    mutationFn: (payload: StrategyEvidenceSpec | null) => api.putStrategyEvidence(strategyId, payload),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['strategies'] });
      toast.success(t('已生成 v{n} 草稿', { n: r.strategy.version }), { description: t('证据进内容哈希,所以改证据 = 新版本;旧版本没有被改动。') });
      onSaved(r.strategy.version);
    },
    onError: (e: unknown) => {
      toast.error(t('保存失败'), { description: e instanceof Error ? e.message : t('网关拒绝了这次修改') });
    },
  });

  const toggleCell = (id: string, tf: string): void => {
    setCells((prev) => {
      const next = new Set(prev);
      const key = cellKey(id, tf);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const addTopic = (): void => {
    const topic = topicDraft.trim().toLowerCase();
    if (!topic) return;
    setTopics((prev) => (prev.includes(topic) ? prev : [...prev, topic]));
    setTopicDraft('');
  };

  const busy = save.isPending;

  return (
    <section className="flex flex-col gap-2.5 rounded-md border border-primary/25 bg-primary/[0.03] px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="text-[11.5px] font-semibold">{t('编辑证据集')}</div>
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
          {t('保存 = 出一个新草稿')}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="num text-[10px] text-muted-foreground">
            {t('指标 {n}', { n: cells.size })} · {t('事件 {n}', { n: events.length })} · {t('主题 {n}', { n: topics.length })}
          </span>
        </div>
      </div>
      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        {t('证据集决定「模型这次能看到什么」:没有策略要的指标不会进 prompt。它进 content_hash,所以改它会从 v{n} 分出一个 draft 新版本,当前在跑的版本一个字不变。', { n: headVersion })}
      </p>

      {/* 指标库:行 = 指标,列 = 周期 */}
      <div className="flex flex-col gap-1">
        <div className="text-[10.5px] font-semibold text-muted-foreground select-none">{t('指标库')}</div>
        {setsQ.isLoading ? <div className="text-[11px] text-muted-foreground">{t('加载中…')}</div> : null}
        {setsQ.isError ? <div className="text-[11px] text-destructive">{t('指标库没取到,先别改证据(避免存进网关不认的 id)。')}</div> : null}
        {grouped.map((g) => (
          <div key={g.key} className="flex flex-col gap-px overflow-hidden rounded-sm border">
            <div className="bg-muted/60 px-2 py-1 text-[10px] font-semibold text-muted-foreground select-none">
              {CATEGORY_LABEL[g.key] ?? t('其它')}
            </div>
            <div className="grid gap-px bg-border" style={{ gridTemplateColumns: `minmax(0,1.4fr) repeat(${columns.length}, minmax(0,0.6fr))` }}>
              <div className="bg-background px-2 py-1 text-[10px] text-muted-foreground select-none">{t('指标')}</div>
              {columns.map((tf) => (
                <div key={`h-${g.key}-${tf}`} className="num bg-background px-1 py-1 text-center text-[10px] text-muted-foreground select-none">
                  {tf}
                </div>
              ))}
              {g.ids.map((id) => (
                <Fragment key={`${g.key}-${id}`}>
                  <div className="num bg-background px-2 py-1 text-[11px]">{id}</div>
                  {columns.map((tf) => {
                    const on = cells.has(cellKey(id, tf));
                    return (
                      <button
                        key={`${id}-${tf}`}
                        type="button"
                        disabled={busy}
                        aria-pressed={on}
                        aria-label={`${id} ${tf}`}
                        onClick={() => toggleCell(id, tf)}
                        className={cn(
                          'flex items-center justify-center bg-background py-1 transition-colors',
                          on ? 'bg-primary/20 text-primary' : 'text-muted-foreground/40 hover:bg-muted',
                          busy && 'cursor-not-allowed opacity-60',
                        )}
                      >
                        <Check className={cn('size-3', on ? 'opacity-100' : 'opacity-0')} />
                      </button>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 事件(触发种类) */}
      <div className="flex flex-col gap-1">
        <div className="text-[10.5px] font-semibold text-muted-foreground select-none">
          {t('事件')} <span className="font-normal">{t('(与 trigger.kinds 取交集;一个都不选 = 不收窄)')}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {EVENT_KINDS.map((k) => {
            const on = events.includes(k);
            return (
              <button
                key={k}
                type="button"
                disabled={busy}
                aria-pressed={on}
                onClick={() => setEvents((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))}
                className={cn(
                  'rounded-sm border px-1.5 py-0.5 text-[10.5px] transition-colors',
                  on ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                {triggerLabel(k)}
              </button>
            );
          })}
        </div>
      </div>

      {/* 新闻主题 */}
      <div className="flex flex-col gap-1">
        <div className="text-[10.5px] font-semibold text-muted-foreground select-none">
          {t('新闻主题')} <span className="font-normal">{t('(命中的新闻优先进证据,不是硬过滤)')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {topics.map((topic) => (
            <button
              key={topic}
              type="button"
              disabled={busy}
              onClick={() => setTopics((prev) => prev.filter((x) => x !== topic))}
              title={t('移除')}
              className="rounded-sm border border-primary/40 bg-primary/15 px-1.5 py-0.5 text-[10.5px] text-primary"
            >
              {topic} ×
            </button>
          ))}
          <Input
            value={topicDraft}
            disabled={busy}
            placeholder={t('如 etf / listing / macro')}
            onChange={(e) => setTopicDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTopic();
              }
            }}
            className="h-6 w-40 text-[11px]"
          />
          <Button size="xs" variant="outline" disabled={busy || !topicDraft.trim()} onClick={addTopic}>
            {t('加主题')}
          </Button>
        </div>
      </div>

      {/* 保存 */}
      <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
        <Button size="xs" disabled={busy || !dirty || setsQ.isError} onClick={() => save.mutate(draft)}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : null}
          {t('保存为新草稿')}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || !dirty}
          onClick={() => {
            setCells(new Set(effective.indicators.map((i) => cellKey(i.id, i.tf))));
            setEvents([...effective.events]);
            setTopics([...(effective.info_topics ?? [])]);
          }}
        >
          <RotateCcw className="size-3" />
          {t('撤销改动')}
        </Button>
        {custom ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => save.mutate(null)}>
            {t('清空回默认集')}
          </Button>
        ) : null}
        <span className="ml-auto text-[10px] text-muted-foreground">{dirty ? t('有未保存的改动') : t('与生效值一致')}</span>
      </div>
    </section>
  );
}
