import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MarketEvent } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { getLang, t } from '@/lib/i18n';

const dateLocale = () => getLang() === 'en' ? 'en-US' : 'zh-CN';

export interface ResearchTask {
  id: string;
  kind: 'topic' | 'event_prep' | 'event_release' | 'calendar_refresh';
  topic: string;
  event_id: string | null;
  assigned_by: 'agent' | 'user';
  due_at: number;
  status: 'planned' | 'running' | 'done' | 'failed' | 'cancelled';
  phase: string;
  plan: { sources: { url: string; why: string }[]; questions: string[] } | null;
  fetches: { url: string; at: number; ok: boolean; bytes: number; excerpt_ref: string; error?: string }[];
  findings: { claim: string; value?: string; refs: string[]; confidence: string }[];
  brief: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  finished_at: number | null;
  cost: { model_calls: number; fetches: number; input_tokens: number; output_tokens: number; usd: string | null };
}
export interface CalendarEvent extends MarketEvent {
  consensus?: string | null;
  previous?: string | null;
  actual?: string | null;
  surprise?: string | null;
  actual_metric?: string;
  research_status?: string | null;
  calendar?: {
    calendar_status: 'reported' | 'confirmed' | 'conflict';
    fallback: boolean;
    importance: string;
    verified_at: number;
    observations: { source_ref: string; expected_at: number }[];
  };
}
const status: Record<string, string> = { planned: '排队中', running: '研究中', done: '已完成', failed: '失败', cancelled: '已取消' };
export async function researchRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? data.error ?? `HTTP ${res.status}`);
  return data as T;
}
export function AssignResearch({ event }: { event?: MarketEvent }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState(event?.title ?? '');
  const mutation = useMutation({
    mutationFn: () =>
      researchRequest<{ task: ResearchTask }>('/api/research', {
        topic,
        kind: event?.kind === 'scheduled' ? (event.starts_at > Date.now() ? 'event_prep' : 'event_release') : 'topic',
        ...(event ? { event_id: event.id } : {}),
      }),
    onSuccess: () => {
      toast.success(t('已指派研究，可在任务页查看计划或取消'));
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['research'] });
      void qc.invalidateQueries({ queryKey: ['market-events'] });
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={event?.status === 'dismissed'} onClick={() => setOpen(!open)}>
        {t('指派研究')}
      </Button>
      {open && (
        <form
          className="flex min-w-64 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <Input
            aria-label={t('研究主题')}
            maxLength={1000}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t('研究主题，例如：本周通胀发布的关键分歧')}
          />
          <Button size="sm" disabled={!topic.trim() || mutation.isPending}>
            {t('提交')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t('取消')}
          </Button>
        </form>
      )}
    </div>
  );
}
export function CalendarBand({ events, now, onOpen }: { events: CalendarEvent[]; now: number; onOpen: (id: string) => void }) {
  const [day, setDay] = useState('今天');
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const start = new Date(base);
  const end = new Date(base);
  if (day === '本周') {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 7);
  } else {
    const delta = day === '昨天' ? -1 : day === '明天' ? 1 : 0;
    start.setDate(start.getDate() + delta);
    end.setDate(end.getDate() + delta + 1);
  }
  const rows = events
    .filter((e) => e.kind === 'scheduled' && e.starts_at >= start.getTime() && e.starts_at < end.getTime() && e.status !== 'dismissed')
    .sort((a, b) => a.starts_at - b.starts_at);
  return (
    <section aria-label={t('宏观日历')} className="shrink-0 rounded-md border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {['昨天', '今天', '明天', '本周'].map((d) => (
          <Button size="xs" key={d} variant={day === d ? 'default' : 'outline'} onClick={() => setDay(d)}>
            {t(d)}
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">{t('本地时间')} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
      </div>
      <div className="flex max-h-64 gap-3 overflow-auto">
        {rows.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{t('这个时间范围暂无已收录日程。来源失败时日历可能不完整。')}</p>
        ) : (
          rows.map((e) => (
            <article key={e.id} className="min-w-64 rounded border p-3 text-xs">
              <button className="mb-1 text-left font-semibold hover:underline" onClick={() => onOpen(e.id)}>
                {e.title}
              </button>
              <p className="mb-2 text-muted-foreground">
                {new Date(e.starts_at).toLocaleString(dateLocale())} · {e.calendar?.importance ?? '—'}
              </p>
              <dl className="grid grid-cols-2 gap-1">
                <dt>{t('预期')}</dt>
                <dd>{e.consensus ?? '—'}</dd>
                <dt>{t('上次')}</dt>
                <dd>{e.previous ?? '—'}</dd>
                <dt>{t('实际')}</dt>
                <dd>
                  {e.actual ?? '—'} {e.actual_metric ?? ''}
                </dd>
                <dt>surprise</dt>
                <dd>{e.surprise ?? '—'}</dd>
              </dl>
              <p className="my-2 text-muted-foreground">
                {e.calendar?.fallback
                  ? t('静态兜底 · 待核实')
                  : e.calendar?.calendar_status === 'conflict'
                    ? t('发布时间冲突')
                    : e.calendar?.calendar_status === 'confirmed'
                      ? t('两源确认')
                      : t('单源报告')}{' '}
                · {t(status[e.research_status ?? ''] ?? '尚无研究')}
              </p>
              {e.calendar?.calendar_status === 'conflict' && (
                <ul className="my-2 text-amber-600">
                  {e.calendar.observations.map((o, i) => (
                    <li key={i}>
                      {new Date(o.expected_at).toLocaleString(dateLocale())} · {new URL(o.source_ref).hostname}
                    </li>
                  ))}
                </ul>
              )}
              <AssignResearch event={e} />
            </article>
          ))
        )}
      </div>
    </section>
  );
}
function TaskDetail({ id }: { id: string }) {
  const [tab, setTab] = useState('计划');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['research', 'detail', id],
    queryFn: () =>
      researchRequest<{ task: ResearchTask; excerpts: { id: string; url: string; body: string; at: number }[] }>(
        `/api/research/${encodeURIComponent(id)}`,
      ),
  });
  const cancel = useMutation({
    mutationFn: () => researchRequest(`/api/research/${encodeURIComponent(id)}/cancel`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['research'] });
    },
    onError: (e) => toast.error(e.message),
  });
  if (q.isError) return <p role="alert">{q.error.message}</p>;
  if (!q.data) return <p>{t('加载中…')}</p>;
  const { task, excerpts } = q.data;
  return (
    <div className="space-y-3 rounded border bg-card p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{task.topic}</strong>
        <span>
          {t(status[task.status] ?? task.status)} · {task.phase}
        </span>
        <span className="ml-auto">{task.assigned_by === 'user' ? t('用户指派') : t('自动研究')}</span>
        {['planned', 'running'].includes(task.status) && (
          <Button variant="outline" size="xs" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {t('取消任务')}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground">
        {t('计划执行')} {new Date(task.due_at).toLocaleString(dateLocale())} · {t('失败次数')} {task.attempts}
      </p>
      {task.error && (
        <p role="alert" className="rounded bg-amber-500/10 p-2">
          {task.error}
        </p>
      )}
      <div className="flex gap-2">
        {['计划', '抓取', '结论', '花费'].map((v) => (
          <Button key={v} size="xs" variant={v === tab ? 'default' : 'outline'} onClick={() => setTab(v)}>
            {t(v)}
          </Button>
        ))}
      </div>
      {tab === '计划' &&
        (task.plan ? (
          <>
            <ul className="list-inside list-disc">
              {task.plan.questions.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
            {task.plan.sources.map((s, i) => (
              <p key={i} className="break-all">
                {s.why} ·{' '}
                <a href={s.url} target="_blank" rel="noreferrer noopener" className="text-primary underline">
                  {s.url}
                </a>
              </p>
            ))}
          </>
        ) : (
          <p>{t('等待便宜大脑生成来源计划；预算满后排到次日。')}</p>
        ))}
      {tab === '抓取' && (
        <div className="space-y-2">
          {task.fetches.length === 0 && <p>{t('尚未抓取。')}</p>}
          {task.fetches.map((f, i) => (
            <div key={i} className="rounded border p-2">
              <p className="break-all">
                {f.ok ? t('成功') : t('失败')} · {new Date(f.at).toLocaleTimeString(dateLocale())} · {f.bytes} bytes · {f.url}
              </p>
              {f.error && <p>{f.error}</p>}
            </div>
          ))}
          {excerpts.map((e) => (
            <details key={e.id} id={e.id}>
              <summary className="cursor-pointer break-all">
                {e.id} · {e.url}
              </summary>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{e.body}</pre>
            </details>
          ))}
        </div>
      )}
      {tab === '结论' && (
        <div className="space-y-3">
          {task.findings.length === 0 && <p>{t('暂无可核验结论。')}</p>}
          {task.findings.map((f, i) => (
            <div key={i}>
              <p>{f.claim}</p>
              <p className="text-muted-foreground">
                {f.confidence === 'confirmed' ? t('官方数值核验') : t('已登记引用，内容待交叉核验')} ·{' '}
                {f.refs.map((ref) => (
                  <button key={ref} className="mr-2 text-primary underline" onClick={() => setTab('抓取')}>
                    {ref}
                  </button>
                ))}
              </p>
            </div>
          ))}
          <p className="text-muted-foreground">{t('研究只提供证据，不生成交易 Intent。')}</p>
        </div>
      )}
      {tab === '花费' && (
        <dl className="grid grid-cols-2 gap-2">
          <dt>{t('模型调用')}</dt>
          <dd>{task.cost.model_calls} / 2</dd>
          <dt>{t('抓取')}</dt>
          <dd>{task.cost.fetches} / 6</dd>
          <dt>{t('输入 / 输出 tokens')}</dt>
          <dd>
            {task.cost.input_tokens} / {task.cost.output_tokens}
          </dd>
          <dt>{t('美元成本')}</dt>
          <dd>{task.cost.usd ?? t('通道未提供价格，不估算')}</dd>
        </dl>
      )}
    </div>
  );
}
export function ResearchTasks() {
  const [id, setId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['research'],
    queryFn: () =>
      researchRequest<{
        tasks: ResearchTask[];
        usage: { model_calls: number; fetches: number };
        daily_cap: { model_calls: number; fetches: number };
      }>('/api/research?limit=100'),
  });
  return (
    <section className="space-y-3 p-1">
      <AssignResearch />
      <p className="text-xs text-muted-foreground">
        {t('今日 UTC 预算：模型 {used} / {cap} 次 · 抓取 {fetches} / {fetchCap} 次', { used: q.data?.usage.model_calls ?? 0, cap: q.data?.daily_cap.model_calls ?? 20, fetches: q.data?.usage.fetches ?? 0, fetchCap: q.data?.daily_cap.fetches ?? 100 })}
      </p>
      {q.isError && <p role="alert">{q.error.message}</p>}
      {q.isLoading && <p>{t('加载研究任务…')}</p>}
      <div className="flex flex-wrap gap-2">
        {q.data?.tasks.map((task) => (
          <Button key={task.id} size="sm" variant={id === task.id ? 'default' : 'outline'} className="max-w-full" onClick={() => setId(task.id)}>
            <span className="truncate">{task.topic}</span> · {t(status[task.status] ?? task.status)}
          </Button>
        ))}
      </div>
      {q.data?.tasks.length === 0 && <p className="text-xs text-muted-foreground">{t('暂无任务。可以指派自由主题，或在日历事件上指派研究。')}</p>}
      {(id ?? q.data?.tasks[0]?.id) && <TaskDetail key={id ?? q.data?.tasks[0]?.id} id={(id ?? q.data?.tasks[0]?.id)!} />}
    </section>
  );
}
