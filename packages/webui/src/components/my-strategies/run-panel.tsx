/**
 * 策略一键运行(§9.51,docs/design/strategy-run-2026-09-24.md)。
 *   RunButton     详情页右上主按钮:没在跑 =「运行策略」,在跑 =「运行设置」;都打开 RunDialog。
 *   RunDialog     一张小卡,字段全有缺省(GET /api/strategy-runs/preflight),直接点「开始运行」即可;
 *                 实盘通道才要输入 LIVE。提交后后端立刻扫一遍最近一根已收盘 K 线,结果 toast 出来。
 *   RunStatusBar  详情页顶部的运行状态条(替代原来只记录状态的生命周期提示):状态、盯的币、下一根收盘、今天单数、
 *                 立即扫描 / 暂停 / 继续 / 停止 / 升级版本,展开看活动流。
 *   useStrategyRuns / runOf  列表页与详情页共用的运行数据(SSE strategy_run.* 到了就失效)。
 * react-query key:['strategy-runs'] / ['strategy-run-events',runId] / ['strategy-run-preflight',sid,version]。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bot, ChevronDown, Hand, Loader2, Pause, Play, Radar, Radio, RefreshCw, Rocket, Settings2, Square, TriangleAlert, X, Zap } from 'lucide-react';
import { toast } from 'sonner';
import type { ResearchStrategy } from '@trading-swarm/contracts';
import { strategyRunsApi, useLiveEvents } from '@/api/client';
import type { StrategyRun, StrategyRunEvent, StrategyRunMode, StrategyRunPreflight } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { errText, go, invalidateMyStrategies } from './use-strategy-actions';

export const RUN_MODE_LABEL: Record<StrategyRunMode, string> = tmap({ auto: '自动下单', agent: 'Agent 把关', confirm: '每笔我确认', signal_only: '只发信号' });
const RUN_MODE_HINT: Record<StrategyRunMode, string> = tmap({
  auto: '策略命中就按代码算好的止损止盈下单,不问模型。',
  agent: '命中后让 Agent 判断做不做;价格仍由策略定,Agent 改不了。',
  confirm: '命中后生成待批订单,你点确认才下。',
  signal_only: '不下单,只把规范化信号发到 ASP 给订阅者。',
});
const RUN_MODE_ICON: Record<StrategyRunMode, typeof Zap> = { auto: Zap, agent: Bot, confirm: Hand, signal_only: Radio };
const MODES: StrategyRunMode[] = ['auto', 'agent', 'confirm', 'signal_only'];
const STATUS_LABEL = tmap({ running: '运行中', paused: '已暂停', stopped: '已停止', error: '出错停下' });
const MAX_SYMBOLS = 30;

// ---------------------------------------------------------------- data

export function useStrategyRuns() {
  const qc = useQueryClient();
  useLiveEvents({
    'strategy_run.updated': () => void qc.invalidateQueries({ queryKey: ['strategy-runs'] }),
    'strategy_run.event': (e) => void qc.invalidateQueries({ queryKey: ['strategy-run-events', e.run_id] }),
  });
  return useQuery({ queryKey: ['strategy-runs'], queryFn: strategyRunsApi.list, staleTime: 5_000, refetchInterval: 30_000, retry: false });
}

/** 一条策略当前的运行:非 stopped 的优先,取最近更新的 */
export function runOf(runs: readonly StrategyRun[] | undefined, strategyId: string): StrategyRun | null {
  const mine = (runs ?? []).filter((r) => r.strategy_id === strategyId).sort((a, b) => b.updated_at - a.updated_at);
  return mine.find((r) => r.status !== 'stopped') ?? null;
}

/** 列表「运行中」口径:running 或 error(出错也要让人看见) */
export function activeRunIds(runs: readonly StrategyRun[] | undefined): Set<string> {
  return new Set((runs ?? []).filter((r) => r.status === 'running' || r.status === 'paused' || r.status === 'error').map((r) => r.strategy_id));
}

function invalidateRuns(qc: ReturnType<typeof useQueryClient>, runId?: string) {
  void qc.invalidateQueries({ queryKey: ['strategy-runs'] });
  if (runId) void qc.invalidateQueries({ queryKey: ['strategy-run-events', runId] });
  void invalidateMyStrategies(qc);
}

/** 扫描结果一句话:扫了几个币、命中几个、下了几单 */
export function scanSummary(scan: readonly StrategyRunEvent[]): string {
  const hits = scan.filter((e) => e.kind === 'candidate').length;
  const opened = scan.filter((e) => e.kind === 'order_opened').length;
  const pending = scan.filter((e) => e.kind === 'order_pending').length;
  const published = scan.filter((e) => e.kind === 'published').length;
  const errors = scan.filter((e) => e.kind === 'error').length;
  const parts = [hits ? t('命中 {n} 个', { n: hits }) : t('这根 K 线没有命中')];
  if (opened) parts.push(t('下单 {n} 笔', { n: opened }));
  if (pending) parts.push(t('{n} 笔待你确认', { n: pending }));
  if (published) parts.push(t('发布 {n} 条信号', { n: published }));
  if (errors) parts.push(t('{n} 个出错', { n: errors }));
  return parts.join(' · ');
}

/** 输入的币名规范成内部符号:btc → BTCUSDT,已带 USDT 的不动 */
export function normalizeSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[-_/\s]/g, '').replace(/SWAP$/, '');
  if (!/^[A-Z0-9]{2,20}$/.test(s)) return null;
  return s.endsWith('USDT') || s.endsWith('USDC') ? s : `${s}USDT`;
}

// ---------------------------------------------------------------- button + dialog

export function RunButton({ run, disabled, onOpen }: { run: StrategyRun | null; disabled?: boolean; onOpen: () => void }) {
  return run ? (
    <Button variant="outline" size="sm" onClick={onOpen} disabled={disabled}>
      <Settings2 />
      {t('运行设置')}
    </Button>
  ) : (
    <Button size="sm" onClick={onOpen} disabled={disabled} className="font-semibold shadow-[0_6px_18px_-8px_var(--primary)]" data-testid="run-strategy">
      <Rocket />
      {t('运行策略')}
    </Button>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit items-center gap-0.5 rounded-full border border-border bg-background p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={cn('h-7 rounded-full px-3 text-[12px] font-medium transition-colors', value === o.v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium">{label}</span>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function SymbolEditor({ value, onChange, watchlist, defaults }: { value: string[]; onChange: (v: string[]) => void; watchlist: string[]; defaults: string[] }) {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text.split(/[,,\s]+/).map(normalizeSymbol).filter((x): x is string => !!x);
    if (!parts.length) return;
    onChange([...new Set([...value, ...parts])].slice(0, MAX_SYMBOLS));
    setText('');
  };
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((s) => (
          <span key={s} className="num inline-flex h-6 items-center gap-1 rounded-full border border-border bg-accent/50 pr-1 pl-2 text-[11.5px]">
            {s.replace(/USDT$/, '')}
            <button type="button" aria-label={t('移除 {s}', { s })} onClick={() => onChange(value.filter((x) => x !== s))} className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3">
              <X />
            </button>
          </span>
        ))}
        {!value.length ? <span className="text-[11.5px] text-destructive">{t('至少盯一个币')}</span> : null}
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          value={text}
          placeholder={t('加币:SOL, DOGE …')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          className="h-7 text-[12px]"
        />
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={!text.trim()}>
          {t('添加')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {defaults.length && !same(value, defaults) ? (
          <button type="button" className="text-primary hover:underline" onClick={() => onChange(defaults.slice(0, MAX_SYMBOLS))}>
            {t('用策略回测的币({n})', { n: defaults.length })}
          </button>
        ) : null}
        {watchlist.length && !same(value, watchlist) ? (
          <button type="button" className="text-primary hover:underline" onClick={() => onChange(watchlist.slice(0, MAX_SYMBOLS))}>
            {t('用我的观察列表({n})', { n: watchlist.length })}
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface FormState {
  mode: StrategyRunMode;
  market: 'spot' | 'perp';
  symbols: string[];
  risk_pct: string;
  max_open: string;
  publish_asp: boolean;
  confirm: string;
}

function initialForm(p: StrategyRunPreflight): FormState {
  const r = p.existing_run;
  return {
    mode: r?.mode ?? p.defaults.mode,
    market: r?.market ?? p.defaults.market,
    symbols: r?.symbols ?? p.defaults.symbols,
    risk_pct: String(r?.risk_pct ?? p.defaults.risk_pct),
    max_open: String(r?.max_open ?? p.defaults.max_open),
    publish_asp: r?.publish_asp ?? (p.defaults.publish_asp && p.asp.identity),
    confirm: '',
  };
}

export function RunDialog({ strategy, version, onClose }: { strategy: ResearchStrategy; version: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const preQ = useQuery({
    queryKey: ['strategy-run-preflight', strategy.id, version],
    queryFn: () => strategyRunsApi.preflight(strategy.id, version ?? undefined),
    retry: false,
  });
  const [form, setForm] = useState<FormState | null>(null);
  useEffect(() => {
    if (preQ.data && !form) setForm(initialForm(preQ.data));
  }, [preQ.data, form]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const start = useMutation({
    mutationFn: (p: StrategyRunPreflight) => {
      const f = form!;
      return strategyRunsApi.start({
        strategy_id: strategy.id,
        version: p.version,
        mode: f.mode,
        market: f.market,
        symbols: f.symbols,
        risk_pct: Number(f.risk_pct),
        max_open: Math.round(Number(f.max_open)),
        publish_asp: f.mode === 'signal_only' ? true : f.publish_asp,
        confirm: p.requires_live_confirm ? f.confirm.trim() : undefined,
      });
    },
    onSuccess: (r, p) => {
      toast.success(p.existing_run ? t('运行设置已更新') : t('「{name}」开始运行', { name: strategy.name }), { description: `${t('刚扫了一遍')}:${scanSummary(r.scan)}` });
      invalidateRuns(qc, r.run.id);
      onClose();
    },
    onError: (e) => toast.error(errText(e)),
  });

  const p = preQ.data;
  const f = form;
  const risk = Number(f?.risk_pct);
  const maxOpen = Number(f?.max_open);
  const riskOk = Number.isFinite(risk) && risk > 0 && risk <= 5;
  const maxOpenOk = Number.isInteger(maxOpen) && maxOpen >= 1 && maxOpen <= 20;
  const liveOk = !p?.requires_live_confirm || f?.confirm.trim() === 'LIVE';
  const needsAsp = f?.mode === 'signal_only' || f?.publish_asp;
  const aspOk = !needsAsp || !!p?.asp.identity;
  const canStart = !!p && !!f && p.deployable && !p.blockers.length && f.symbols.length > 0 && riskOk && maxOpenOk && liveOk && aspOk;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{p?.existing_run ? t('运行设置') : t('运行策略')}</DialogTitle>
          <DialogDescription>
            {strategy.name}
            {p ? ` · v${p.version} · ${p.timeframe.toUpperCase()}` : ''}
          </DialogDescription>
        </DialogHeader>
        {preQ.isPending ? (
          <Skeleton className="h-[360px] rounded-lg" />
        ) : preQ.isError || !p || !f ? (
          <p className="text-[12.5px] text-destructive">{t('读取运行预检失败')}:{errText(preQ.error)}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div data-execution={p.execution.backend} className={cn('flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[12px]', p.requires_live_confirm ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-accent/40')}>
              <span className="text-muted-foreground">{t('下单到')}</span>
              <span className="font-semibold">{f.mode === 'signal_only' ? t('不下单(只发信号)') : p.execution.label}</span>
            </div>

            {p.blockers.length ? (
              <ul className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
                {p.blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            ) : null}

            <Field label={t('运行方式')}>
              <div className="grid grid-cols-2 gap-1.5">
                {MODES.map((m) => {
                  const Icon = RUN_MODE_ICON[m];
                  return (
                    <button
                      key={m}
                      type="button"
                      data-mode={m}
                      aria-pressed={f.mode === m}
                      onClick={() => set('mode', m)}
                      className={cn('flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors', f.mode === m ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40')}
                    >
                      <span className="flex items-center gap-1.5 text-[12.5px] font-semibold [&_svg]:size-3.5">
                        <Icon />
                        {RUN_MODE_LABEL[m]}
                      </span>
                      <span className="text-[11px] leading-snug text-muted-foreground">{RUN_MODE_HINT[m]}</span>
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label={t('市场')} hint={f.market === 'perp' ? t('杠杆 {x}x(取策略设定)', { x: p.defaults.leverage }) : t('现货只做多')}>
              <Segmented
                label={t('市场')}
                value={f.market}
                onChange={(v) => set('market', v)}
                options={[
                  { v: 'spot', label: t('现货') },
                  { v: 'perp', label: t('永续') },
                ]}
              />
            </Field>

            <Field label={t('盯哪些币')} hint={t('{n}/{max}', { n: f.symbols.length, max: MAX_SYMBOLS })}>
              <SymbolEditor value={f.symbols} onChange={(v) => set('symbols', v)} watchlist={p.watchlist} defaults={p.defaults.symbols} />
            </Field>

            {f.mode !== 'signal_only' ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('每笔风险 %')} hint={t('亏到止损时占权益')}>
                  <Input type="number" step="0.1" min="0.1" max="5" value={f.risk_pct} onChange={(e) => set('risk_pct', e.target.value)} aria-invalid={!riskOk} className="h-8 text-[12.5px]" />
                </Field>
                <Field label={t('同时最多持仓')}>
                  <Input type="number" step="1" min="1" max="20" value={f.max_open} onChange={(e) => set('max_open', e.target.value)} aria-invalid={!maxOpenOk} className="h-8 text-[12.5px]" />
                </Field>
              </div>
            ) : null}

            <div className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium">{t('同时发布到 ASP')}</div>
                <p className="text-[11px] text-muted-foreground">
                  {p.asp.identity ? t('策略产出的信号(入场/止损/目标)规范化后投给你的订阅者。') : t('还没有 ASP 身份,先去信号市场注册(链上注册不能一键)。')}
                  {!p.asp.identity ? (
                    <button type="button" className="ml-1 text-primary hover:underline" onClick={() => go('market?tab=publish')}>
                      {t('去注册')}
                    </button>
                  ) : null}
                </p>
              </div>
              <Switch checked={f.mode === 'signal_only' ? true : f.publish_asp} disabled={!p.asp.identity || f.mode === 'signal_only'} onCheckedChange={(v) => set('publish_asp', v)} aria-label={t('同时发布到 ASP')} />
            </div>

            {p.warnings.length ? (
              <ul className="flex flex-col gap-1 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[11.5px] text-muted-foreground">
                {p.warnings.map((w) => (
                  <li key={w.code} className="flex items-start gap-1.5 [&_svg]:mt-0.5 [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:text-warn">
                    <TriangleAlert />
                    {w.message}
                  </li>
                ))}
              </ul>
            ) : null}

            {p.requires_live_confirm && f.mode !== 'signal_only' ? (
              <Field label={t('这是实盘,输入 LIVE 确认')}>
                <Input value={f.confirm} onChange={(e) => set('confirm', e.target.value)} placeholder="LIVE" className="h-8 text-[12.5px]" />
              </Field>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={start.isPending}>
            {t('取消')}
          </Button>
          <Button size="sm" onClick={() => p && start.mutate(p)} disabled={!canStart || start.isPending} data-testid="run-start">
            {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}
            {start.isPending ? t('启动中…') : p?.existing_run ? t('保存') : t('开始运行')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- status bar + activity

const EVENT_TONE: Partial<Record<StrategyRunEvent['kind'], string>> = {
  candidate: 'bg-primary',
  order_opened: 'bg-up',
  order_pending: 'bg-warn',
  agent_follow: 'bg-up',
  order_rejected: 'bg-destructive',
  error: 'bg-destructive',
  exit: 'bg-foreground/70',
  published: 'bg-primary/60',
};

export function RunActivity({ runId }: { runId: string }) {
  const q = useQuery({ queryKey: ['strategy-run-events', runId], queryFn: () => strategyRunsApi.events(runId, 30), retry: false });
  if (q.isPending) return <Skeleton className="h-24 rounded-lg" />;
  if (q.isError) return <p className="text-[12px] text-destructive">{errText(q.error)}</p>;
  const rows = q.data.rows;
  if (!rows.length) return <p className="text-[12px] text-muted-foreground">{t('还没有活动。下一根 K 线收盘时会自动扫描。')}</p>;
  return (
    <ol className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
      {rows.map((e) => (
        <li key={e.id} data-kind={e.kind} className="flex items-start gap-2 text-[12px] leading-relaxed">
          <span aria-hidden className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', EVENT_TONE[e.kind] ?? 'bg-muted-foreground/50')} />
          <span className="min-w-0 flex-1 break-words">
            {e.symbol ? <span className="num mr-1 font-medium">{e.symbol.replace(/USDT$/, '')}</span> : null}
            {e.message}
            {typeof e.data?.['thread_id'] === 'string' && e.symbol ? (
              <button type="button" className="ml-1 text-primary hover:underline" onClick={() => go(`trade?symbol=${encodeURIComponent(e.symbol!)}`)}>
                {t('看订单')}
              </button>
            ) : null}
          </span>
          <time className="num shrink-0 text-[10.5px] text-muted-foreground/70" title={fmtDateTime(e.at)}>
            {relativeTime(e.at)}
          </time>
        </li>
      ))}
    </ol>
  );
}

const hhmm = (ts: number | null) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

export function RunStatusBar({ run }: { run: StrategyRun }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  const [stopping, setStopping] = useState(false);
  const patch = useMutation({
    mutationFn: (body: Parameters<typeof strategyRunsApi.patch>[1]) => strategyRunsApi.patch(run.id, body),
    onSuccess: (r) => {
      toast.success(`${STATUS_LABEL[r.run.status]}`);
      setStopping(false);
      invalidateRuns(qc, run.id);
    },
    onError: (e) => toast.error(errText(e)),
  });
  const scan = useMutation({
    mutationFn: () => strategyRunsApi.scan(run.id),
    onSuccess: (r) => {
      toast.success(t('扫描完成'), { description: scanSummary(r.scan) });
      invalidateRuns(qc, run.id);
    },
    onError: (e) => toast.error(errText(e)),
  });
  const ModeIcon = RUN_MODE_ICON[run.mode];
  const live = run.status === 'running';
  const s = run.stats;
  const facts = [
        run.mode === 'signal_only' ? t('只发信号') : run.execution.label,
        `${run.timeframe.toUpperCase()} · ${run.market === 'perp' ? `${t('永续')} ${run.leverage}x` : t('现货')}`,
        t('盯 {n} 个币', { n: run.symbols.length }),
        live ? t('下一根 {time} 收盘', { time: hhmm(run.next_scan_at) }) : null,
        t('今天 {n} 单', { n: s.today_orders }),
        s.open_threads ? t('持仓 {n}', { n: s.open_threads }) : null,
        s.pending_approval ? t('{n} 笔待确认', { n: s.pending_approval }) : null,
        s.closed ? `${t('已平 {n} 笔', { n: s.closed })}${s.realized_r !== null ? ` · ${s.realized_r >= 0 ? '+' : '−'}${Math.abs(s.realized_r).toFixed(2)}R` : ''}` : null,
        run.publish_asp ? t('已发布 {n} 条', { n: s.published }) : null,
      ].filter((x): x is string => !!x);
  return (
    <section data-run-status={run.status} className={cn('flex flex-col gap-2 rounded-xl border bg-card px-4 py-3', run.status === 'error' ? 'border-destructive/50' : live ? 'border-up/40' : 'border-border')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
            <span className="relative flex size-2">
              {live ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-up opacity-60 motion-reduce:hidden" /> : null}
              <span className={cn('relative inline-flex size-2 rounded-full', live ? 'bg-up' : run.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground')} />
            </span>
            {STATUS_LABEL[run.status]}
          </span>
          <span className="inline-flex items-center gap-1 text-[12px] font-medium [&_svg]:size-3.5">
            <ModeIcon />
            {RUN_MODE_LABEL[run.mode]}
          </span>
          <span className="num text-[11.5px] text-muted-foreground">{facts.join(' · ')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {run.latest_version > run.version ? (
            <Button size="sm" variant="outline" onClick={() => patch.mutate({ version: run.latest_version })} disabled={patch.isPending} title={t('已开的仓位按旧版本跑完,新信号用新版本')}>
              <RefreshCw />
              {t('切到 v{v}', { v: run.latest_version })}
            </Button>
          ) : null}
          {live ? (
            <Button size="sm" variant="outline" onClick={() => scan.mutate()} disabled={scan.isPending}>
              {scan.isPending ? <Loader2 className="animate-spin" /> : <Radar />}
              {t('立即扫描')}
            </Button>
          ) : null}
          {live ? (
            <Button size="sm" variant="outline" onClick={() => patch.mutate({ status: 'paused' })} disabled={patch.isPending}>
              <Pause />
              {t('暂停')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => patch.mutate({ status: 'running' })} disabled={patch.isPending}>
              <Play />
              {t('继续')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setStopping(true)} disabled={patch.isPending} className="text-destructive hover:text-destructive">
            <Square />
            {t('停止')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={t('活动')}>
            <Activity />
            <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
          </Button>
        </div>
      </div>
      {run.error ? <p className="text-[12px] text-destructive">{run.error}</p> : null}
      {open ? (
        <div className="border-t border-border pt-2">
          <RunActivity runId={run.id} />
        </div>
      ) : null}
      <ConfirmDialog
        open={stopping}
        title={t('停止运行')}
        summary={t('确认停止')}
        danger
        busy={patch.isPending}
        onCancel={() => setStopping(false)}
        onConfirm={() => patch.mutate({ status: 'stopped' })}
      >
        <p>{t('不再扫描、不再开新仓。已经开着的仓位保留,止损止盈照常生效,可以在交易页手动平。')}</p>
      </ConfirmDialog>
    </section>
  );
}

/** 列表卡片上的小胶囊 */
export function RunPill({ run }: { run: StrategyRun }) {
  const live = run.status === 'running';
  return (
    <span data-run-pill={run.status} className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10.5px] font-semibold', live ? 'border-up/40 bg-up/10 text-up' : run.status === 'error' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border text-muted-foreground')}>
      <span className={cn('size-1.5 rounded-full', live ? 'bg-up' : run.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground')} />
      {STATUS_LABEL[run.status]}
      {live && run.stats.today_orders ? <span className="num font-normal">· {run.stats.today_orders}</span> : null}
    </span>
  );
}
