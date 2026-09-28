/**
 * ③ 风控与执行面板(右栏 Risk tab;顶条胶囊点开的也是它)。全归代码,所有来源共用。
 *
 * 每行 = 名称 · 当前值(可就地改)· 区间 · 今日用量 · 说明,按一个候选遇到它们的顺序排:
 *   熔断(日亏停)→ 容量(每日开仓 / 同时持仓 / 同币互斥)→ 止损与盈亏比(下限 % / ATR 下限 / 上限 / 净 RR)→ 仓位(单笔风险 / PM 倍率 / 杠杆)
 * Save 走 PATCH /api/execution-policy;真钱通道要输入 LIVE;公网演示访客只读。
 * 「Ask agent to tune」:切到 Agent tab、新开会话并预填当前参数 + 今日被挡统计(用户可改再发)。
 * 接口没就绪(404)时用 workflow 里已有的字段只读展示。
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock, Sparkles } from 'lucide-react';
import { EXECUTION_POLICY_KEY, TRADING_SOURCES_KEY, tradingApi, type ExecutionPolicyValues, type ExecutionPolicyView, type PolicyBound, type SizingAgentMode } from '@/api/trading';
import type { Workflow } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fmtNum, num, policyDraftPatch, type PolicyDraft, type PolicyEditKey } from './sources-logic';

type RowKey = PolicyEditKey | 'same_symbol';
interface RowSpec {
  key: RowKey;
  name: string;
  unit: string;
  desc: string;
}
interface GroupSpec {
  title: string;
  rows: RowSpec[];
}

function groups(): GroupSpec[] {
  return [
    {
      title: t('熔断'),
      rows: [{ key: 'daily_loss_stop_pct', name: t('日亏停'), unit: '%', desc: t('当日亏损到权益的这个比例,当天不再开新仓') }],
    },
    {
      title: t('容量'),
      rows: [
        { key: 'max_opens_per_day', name: t('每日开仓上限'), unit: '', desc: t('所有来源合计,当天最多开几笔') },
        { key: 'max_open_threads', name: t('同时持仓上限'), unit: '', desc: t('所有来源合计,同时进行中的线程数') },
        { key: 'same_symbol', name: t('同币互斥'), unit: '', desc: t('同一个币同时只允许一条进行中的线程,不同来源也一样(固定规则)') },
      ],
    },
    {
      title: t('止损与盈亏比'),
      rows: [
        { key: 'min_stop_pct', name: t('止损距离下限'), unit: '%', desc: t('止损离入场太近会被正常波动扫掉') },
        { key: 'min_stop_atr', name: t('止损 ATR 下限'), unit: '×ATR', desc: t('止损至少离入场 k 倍 ATR:按波动率放宽,波动大的币止损要更远') },
        { key: 'max_stop_pct', name: t('止损距离上限'), unit: '%', desc: t('止损太远 = 仓位会被算得很小,超过就不做') },
        { key: 'min_net_rr', name: t('净盈亏比下限'), unit: 'R', desc: t('扣掉手续费和滑点之后的盈亏比') },
      ],
    },
    {
      title: t('仓位'),
      rows: [
        { key: 'risk_pct', name: t('单笔风险'), unit: '%', desc: t('打到止损时亏掉权益的比例;数量由代码按止损距离算') },
        { key: 'sizing_agent', name: t('PM 仓位倍率'), unit: '', desc: t('off:不调用;advise:只记录;apply:倍率生效(×0.25–2,由代码钳制);拆单只做建议,不执行') },
        { key: 'leverage', name: t('杠杆'), unit: 'x', desc: t('只影响保证金占用,风险仍按单笔风险算') },
      ],
    },
  ];
}

const SIZING: readonly SizingAgentMode[] = ['off', 'advise', 'apply'];

function fromWorkflow(wf: Workflow | undefined): ExecutionPolicyValues | null {
  if (!wf) return null;
  return {
    risk_pct: wf.risk_pct,
    leverage: wf.leverage,
    margin_mode: wf.margin_mode,
    min_stop_pct: '',
    max_stop_pct: '',
    min_net_rr: '',
    max_open_threads: wf.max_open_threads,
    max_opens_per_day: wf.max_opens_per_day,
    daily_loss_stop_pct: wf.daily_loss_stop_pct,
    sizing_agent: wf.sizing_agent,
  };
}

export function RiskPanel({
  policy,
  loading,
  error,
  workflow,
  usageFallback,
  lock,
  noteError,
  onAskAgent,
}: {
  /** null = 接口没就绪 */
  policy: ExecutionPolicyView | null | undefined;
  loading: boolean;
  error: string | null;
  workflow: Workflow | undefined;
  usageFallback: { open_threads: number; opens_today: number | null; daily_loss_hit: boolean };
  lock: string | null;
  noteError: (err: unknown) => boolean;
  onAskAgent: () => void;
}) {
  const qc = useQueryClient();
  const values = policy?.values ?? fromWorkflow(workflow);
  const bounds = policy?.bounds ?? {};
  const usage = policy?.usage ?? usageFallback;
  const editable = !!policy && !lock;
  const [draft, setDraft] = useState<PolicyDraft>({});
  const [liveConfirm, setLiveConfirm] = useState('');
  // 服务端值变了(SSE / agent 改了)且本地没在改 → 草稿清掉
  const valuesKey = JSON.stringify(policy?.values ?? null);
  useEffect(() => setDraft({}), [valuesKey]);
  const check = useMemo(() => (policy ? policyDraftPatch(policy.values, bounds, draft) : { patch: null, errors: {}, changed: [] as PolicyEditKey[] }), [policy, bounds, draft]);
  const needLive = !!policy?.live;
  const save = useMutation({
    // 真钱通道的 LIVE 确认只在界面上拦(§9.56 PATCH 不收 confirm 键,未知键会整单 400)
    mutationFn: () => tradingApi.patchPolicy(check.patch!),
    onSuccess: (view) => {
      qc.setQueryData(EXECUTION_POLICY_KEY, view);
      void qc.invalidateQueries({ queryKey: TRADING_SOURCES_KEY });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      setDraft({});
      setLiveConfirm('');
      toast.success(t('风控参数已保存'), { description: t('所有来源的下一笔候选起生效') });
    },
    onError: (err) => {
      if (noteError(err)) toast.error(t('公网演示:访客只读,只有所有者能改'));
      else toast.error(t('没保存成'), { description: err instanceof Error ? err.message : String(err) });
    },
  });

  if (!values) {
    return <div className="p-4 text-[12px] text-muted-foreground">{loading ? t('加载中…') : (error ?? t('风控参数没读到'))}</div>;
  }

  const set = (k: PolicyEditKey, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = check.changed.length > 0;
  const canSave = editable && dirty && !!check.patch && (!needLive || liveConfirm.trim() === 'LIVE') && !save.isPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="trade-risk-panel">
      <div className="flex shrink-0 flex-wrap items-start gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold">{t('风控与执行')}</div>
          <p className="text-[11px] leading-snug text-muted-foreground">{t('全部由代码执行,所有来源共用。按一个候选遇到它们的顺序排列;任何一条不过,这笔就不下。')}</p>
        </div>
        <Button size="xs" variant="outline" onClick={onAskAgent} className="shrink-0 border-primary/40 text-primary hover:bg-primary/5" data-testid="trade-risk-ask-agent" title={t('新开一个 Agent 会话,预填当前参数和今日被挡统计;你可以改完再发')}>
          <Sparkles data-slot="icon" />
          {t('让 agent 调参')}
        </Button>
      </div>
      <p className="shrink-0 border-b bg-muted/30 px-3 py-1.5 text-[10.5px] leading-snug text-muted-foreground">
        {t('模拟盘:agent 可以在「agent 直改」区间内直接改;超出区间会变成提议,等你确认。真钱通道只能人改。')}
      </p>
      {!policy ? (
        <div className="shrink-0 border-b bg-warn/10 px-3 py-1.5 text-[11px] text-warn">{policy === null ? t('这个网关还没有风控接口,下面是工作流里的值,只读。') : error ?? t('加载中…')}</div>
      ) : null}
      {lock ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
          <Lock className="size-3" />
          {lock}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups().map((g, gi) => (
          <section key={g.title}>
            <div className="kicker sticky top-0 z-10 flex items-center gap-1.5 border-b bg-card/95 px-3 py-1 text-[10px] text-muted-foreground backdrop-blur">
              <span className="num">{gi + 1}</span>
              {g.title}
            </div>
            {g.rows.map((row) => (
              <PolicyRow
                key={row.key}
                spec={row}
                values={values}
                bound={row.key === 'same_symbol' ? undefined : bounds[row.key as keyof ExecutionPolicyValues]}
                draft={row.key === 'same_symbol' ? undefined : draft[row.key as PolicyEditKey]}
                error={row.key === 'same_symbol' ? undefined : check.errors[row.key as PolicyEditKey]}
                usage={usage}
                editable={editable}
                onChange={(v) => set(row.key as PolicyEditKey, v)}
              />
            ))}
          </section>
        ))}
      </div>

      {editable ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-muted/30 px-3 py-2">
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{dirty ? t('改了 {n} 项', { n: check.changed.length }) : t('直接在上面改数值,再保存')}</span>
          {needLive && dirty ? (
            <Input value={liveConfirm} onChange={(e) => setLiveConfirm(e.target.value)} placeholder={t('真钱通道:输入 LIVE 确认')} className="num h-7 w-44 text-[12px]" data-testid="trade-risk-live-confirm" />
          ) : null}
          {dirty ? (
            <Button size="xs" variant="ghost" onClick={() => setDraft({})} disabled={save.isPending}>
              {t('还原')}
            </Button>
          ) : null}
          <Button size="xs" onClick={() => save.mutate()} disabled={!canSave} data-testid="trade-risk-save">
            {save.isPending ? t('保存中…') : t('保存')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function rangeText(b: PolicyBound | undefined, unit: string): string | null {
  if (!b) return null;
  return `${fmtNum(b.min, 4)}–${fmtNum(b.max, 4)}${unit === '%' ? '%' : unit === 'x' ? 'x' : ''}`;
}

function PolicyRow({
  spec,
  values,
  bound,
  draft,
  error,
  usage,
  editable,
  onChange,
}: {
  spec: RowSpec;
  values: ExecutionPolicyValues;
  bound: PolicyBound | undefined;
  draft: string | undefined;
  error: string | undefined;
  usage: { open_threads: number; opens_today: number | null; daily_loss_hit: boolean };
  editable: boolean;
  onChange: (v: string) => void;
}) {
  const k = spec.key;
  const usageText =
    k === 'max_open_threads'
      ? t('当前 {a}/{b}', { a: usage.open_threads, b: values.max_open_threads })
      : k === 'max_opens_per_day'
        ? t('今日 {a}/{b}', { a: usage.opens_today ?? '—', b: values.max_opens_per_day })
        : k === 'daily_loss_stop_pct'
          ? usage.daily_loss_hit
            ? t('今天已触发')
            : t('今天未触发')
          : null;
  const usageFull = (k === 'max_open_threads' && usage.open_threads >= values.max_open_threads) || (k === 'max_opens_per_day' && (usage.opens_today ?? 0) >= values.max_opens_per_day) || (k === 'daily_loss_stop_pct' && usage.daily_loss_hit);
  const direct = bound && bound.agent_direct_min !== undefined && bound.agent_direct_max !== undefined ? `${fmtNum(bound.agent_direct_min, 4)}–${fmtNum(bound.agent_direct_max, 4)}` : null;
  const range = rangeText(bound, spec.unit);
  const current = k === 'same_symbol' ? null : k === 'sizing_agent' ? values.sizing_agent : values[k as keyof ExecutionPolicyValues];
  const known = current !== undefined && current !== '' && (k === 'sizing_agent' || Number.isFinite(num(current as string | number)));

  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-b px-3 py-2 text-[12px]', draft !== undefined && 'bg-primary/[0.03]')} data-testid="trade-risk-row" data-key={k}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{spec.name}</span>
          {usageText ? <span className={cn('num rounded-sm px-1 text-[10.5px]', usageFull ? 'bg-down/10 font-medium text-down' : 'bg-muted text-muted-foreground')}>{usageText}</span> : null}
        </div>
        <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">{spec.desc}</p>
      </div>
      <div className="flex flex-col items-end gap-0.5">
        {k === 'same_symbol' ? (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{t('固定')}</span>
        ) : k === 'sizing_agent' ? (
          editable ? (
            <ToggleGroup type="single" variant="outline" size="sm" value={draft ?? values.sizing_agent} onValueChange={(v) => v && onChange(v)} data-testid="trade-risk-sizing">
              {SIZING.map((m) => (
                <ToggleGroupItem key={m} value={m} className="h-6 px-2 text-[11px]">
                  {m}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <span className="num font-medium">{values.sizing_agent}</span>
          )
        ) : editable && known ? (
          <div className="flex items-center gap-1">
            <Input
              value={draft ?? fmtNum(current as string | number, 4)}
              onChange={(e) => onChange(e.target.value)}
              inputMode="decimal"
              className={cn('num h-6 w-16 px-1.5 text-right text-[12px]', error && 'border-down')}
              aria-invalid={!!error}
            />
            <span className="w-7 text-[10.5px] text-muted-foreground">{spec.unit}</span>
          </div>
        ) : (
          <span className="num font-medium">
            {known ? fmtNum(current as string | number, 4) : '—'}
            {known && spec.unit ? <span className="ml-0.5 text-[10.5px] font-normal text-muted-foreground">{spec.unit}</span> : null}
          </span>
        )}
        {error ? <span className="text-[10.5px] text-down">{error}</span> : null}
        {range ? (
          <span className="num text-[10px] text-muted-foreground" title={direct ? t('人工可改区间;agent 在模拟盘可直接改 {d}', { d: direct }) : t('人工可改区间')}>
            {range}
            {direct ? <span className="ml-1 text-primary/80">{t('agent 直改 {d}', { d: direct })}</span> : null}
          </span>
        ) : null}
        {k === 'leverage' ? <span className="text-[10px] text-muted-foreground">{values.margin_mode === 'isolated' ? t('逐仓') : t('全仓')}</span> : null}
      </div>
    </div>
  );
}
