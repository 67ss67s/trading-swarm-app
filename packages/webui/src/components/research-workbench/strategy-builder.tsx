/**
 * 策略构建 loop(research round 2 §3.3):自然语言 → 策略 IR → 单位/周期/前视/状态机/风险/预热检查 → 才能进回测。
 * 模型只能把话映射到原语库,映射不了的意思在 unmapped 里如实列出;右侧原语目录是它的全部词汇。
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Beaker, Check, ChevronRight, List, RefreshCw, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { researchApi } from '@/api/client';
import type { OrderGateParams, ResearchCompileConstraints, ResearchCompileResponse, ResearchExecution, ResearchPrimitive, StrategyIR } from '@/api/research-types';
import { RulesCard, SpecReport, hasSpecBlock, rulesFromIr, type RulesSource } from '@/components/research-workbench/rules-card';
import { tfLabel } from '@/components/research-workbench/screen-panel';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

const CATEGORY_LABEL: Record<ResearchPrimitive['category'], string> = tmap({ screen: '筛选', regime: '趋势/环境', signal: '信号', entry: '入场', stop: '止损', sizing: '仓位', exit: '出场' });
const CATEGORY_ORDER: ResearchPrimitive['category'][] = ['screen', 'regime', 'signal', 'entry', 'stop', 'sizing', 'exit'];
const CHECK_LABEL: Record<string, string> = tmap({ units: '单位', timeframe_consistency: '周期一致', lookahead: '无前视', state_machine: '状态机', risk_bounds: '风险边界', warmup: '预热' });
const TF_OPTIONS = ['15m', '1h', '4h', '1d'] as const;
// 原语描述里需要翻译的几条(目录本身由后端返回,这里只补英文;没覆盖的按后端原文显示)
const PRIMITIVE_DESC: Record<string, string> = tmap({ htf_structure_regime: '高周期结构方向门:最近 BOS 向上且价格未贴近上方阻力块' });

const EXAMPLE = '只在 4h 趋势向上、ADX 大于 20 时做多;1h 收盘突破前 20 根最高价且成交量是 20 根均量 1.2 倍以上入场;止损放在 2 倍 ATR;+1R 后止损上移到成本;用 3 倍 ATR 的吊灯线追踪,收盘跌破 EMA50 也出;单笔风险 1%,最多同时 3 个仓。';

export function StrategyBuilder({
  initialIr,
  seedText,
  onUseIr,
  execution,
  orderGate,
  seedDatasetId,
}: {
  initialIr: StrategyIR | null;
  /** 首屏「验证一个想法」带过来的原话,直接填进描述框 */
  seedText?: string;
  onUseIr: (ir: StrategyIR, timeframe: string, warmupBars: number) => void;
  /** 算设计约束(往返成本 / 止损下限 / ATR)用的执行与闸门;跟着当前实验走 */
  execution: ResearchExecution;
  orderGate: OrderGateParams;
  seedDatasetId: string | null;
}) {
  const primsQ = useQuery({ queryKey: ['research', 'primitives'], queryFn: researchApi.primitives, retry: false, staleTime: 5 * 60_000 });
  const dsQ = useQuery({ queryKey: ['research', 'datasets'], queryFn: researchApi.datasets, retry: false, staleTime: 60_000 });
  const datasets = dsQ.data?.items ?? [];
  const [datasetId, setDatasetId] = useState<string | null>(seedDatasetId);
  // 约束基准:优先当前实验的数据集,没有就用列表第一条(拿它的成本与 ATR 中位算止损下限)
  useEffect(() => {
    if (datasetId && datasets.some((d) => d.id === datasetId)) return;
    const pick = (seedDatasetId && datasets.find((d) => d.id === seedDatasetId)) || datasets[0];
    if (pick) setDatasetId(pick.id);
  }, [datasets, datasetId, seedDatasetId]);
  const [text, setText] = useState('');
  useEffect(() => {
    if (seedText) setText(seedText);
  }, [seedText]);
  const [showPrimitives, setShowPrimitives] = useState(false);
  const [timeframe, setTimeframe] = useState('1h');
  const [irText, setIrText] = useState(initialIr ? JSON.stringify(initialIr, null, 2) : '');
  const [result, setResult] = useState<ResearchCompileResponse | null>(null);
  const [irError, setIrError] = useState<string | null>(null);

  const compileM = useMutation({
    mutationFn: (body: { text?: string; ir?: StrategyIR }) => researchApi.compileStrategy({ ...body, timeframe, ...(datasetId ? { dataset_id: datasetId } : {}), execution, order_gate: orderGate }),
    onSuccess: (r) => {
      setResult(r);
      if (r.ir) setIrText(JSON.stringify(r.ir, null, 2));
      setIrError(r.ir ? null : t('模型输出无法解析成 IR,请换个说法或直接改 JSON'));
      if (r.unmapped.length) toast.warning(t('{n} 处意思没有对应原语,已忽略', { n: r.unmapped.length }));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const recheck = () => {
    try {
      const ir = JSON.parse(irText) as StrategyIR;
      setIrError(null);
      compileM.mutate({ ir });
    } catch (e) {
      setIrError((e as Error).message);
    }
  };

  const groups = useMemo(() => {
    const by = new Map<ResearchPrimitive['category'], ResearchPrimitive[]>();
    for (const p of primsQ.data?.items ?? []) by.set(p.category, [...(by.get(p.category) ?? []), p]);
    return CATEGORY_ORDER.filter((c) => by.has(c)).map((c) => [c, by.get(c)!] as const);
  }, [primsQ.data]);
  const backendMissing = primsQ.error && /404|not_found|不存在/.test((primsQ.error as Error).message);

  // 可读规则卡:后端给 rules 就用它,只有 IR 时如实列原语(rawOnly),都没有就不画
  const rulesSource: RulesSource | null = result?.rules?.length
    ? { rules: result.rules, fromBackend: true, rawOnly: false }
    : result?.ir
      ? { rules: rulesFromIr(result.ir), fromBackend: false, rawOnly: true }
      : null;
  const specBlocked = hasSpecBlock(result?.spec);

  return (
    <div className={cn('grid h-full min-h-0', showPrimitives ? 'grid-cols-[minmax(0,1fr)_280px]' : 'grid-cols-1')}>
      <div className="flex min-h-0 flex-col">
        <header className="shrink-0 border-b px-4 pt-3 pb-2">
          <div className="flex items-center gap-2">
            <h1 className="text-[16px] font-semibold">{t('策略构建')}</h1>
            <Button size="xs" variant={showPrimitives ? 'secondary' : 'ghost'} className="ml-auto" onClick={() => setShowPrimitives((v) => !v)}>
              <List /> {t('原语目录')}
            </Button>
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{t('用自然语言描述规则,模型把它映射成策略 IR(筛选 / 趋势 / 信号 / 入场 / 止损 / 仓位 / 出场),六项检查全过才能进回测。持有期跟着走势走:出场用追踪止损、结构位、趋势翻转,而不是数根数。')}</p>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="kicker text-foreground/85">1 · {t('描述')}</span>
                <select className="h-6 rounded-md border bg-background px-1.5 text-[11px]" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                  {TF_OPTIONS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
                <select className="h-6 max-w-[180px] rounded-md border bg-background px-1.5 text-[11px]" value={datasetId ?? ''} onChange={(e) => setDatasetId(e.target.value || null)} title={t('算设计约束用的数据:往返成本、ATR 中位、止损下限都按它算')}>
                  <option value="">{t('不按数据算约束')}</option>
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.symbol} {tfLabel(d.timeframe_ms)}
                    </option>
                  ))}
                </select>
                <button type="button" className="text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={() => setText(EXAMPLE)}>
                  {t('填一个例子')}
                </button>
              </div>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} className="min-h-[96px] text-[12.5px]" />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => compileM.mutate({ text })} disabled={!text.trim() || compileM.isPending}>
                  {compileM.isPending ? <RefreshCw className="animate-spin" /> : <Sparkles />} {t('映射成策略 IR')}
                </Button>
                <span className="text-[10.5px] text-muted-foreground">{t('调一次当前大脑;模型只能选原语,不能写代码。')}</span>
              </div>
            </section>

            {result ? (
              <section className="space-y-2">
                <div className="kicker text-foreground/85">2 · {t('规则与检查')}</div>
                {/* 先看人话规则卡,再看机器校验;IR / hash / 原语目录都在下面的折叠里 */}
                {rulesSource ? <RulesCard source={rulesSource} title={t('这条策略的规则')} hint={rulesSource.fromBackend ? undefined : t('后端还没给可读翻译')} /> : null}
                <SpecReport spec={result.spec} />
                <div className={cn('rounded-md border px-3 py-2 text-[12px]', result.ok ? 'border-up/40 bg-up/10' : 'border-warn/40 bg-warn/10')}>{result.summary}</div>
                {result.constraints ? <ConstraintsStrip c={result.constraints} multiple={orderGate.min_stop_cost_multiple} /> : null}
                <ul className="grid grid-cols-3 gap-1.5">
                  {result.checks.map((c) => (
                    <li key={c.name} className={cn('flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px]', c.ok ? 'border-border' : 'border-down/40 bg-down/10')}>
                      {c.ok ? <Check className="mt-0.5 size-3 shrink-0 text-up" /> : <X className="mt-0.5 size-3 shrink-0 text-down" />}
                      <span>
                        <span className="font-medium">{CHECK_LABEL[c.name] ?? c.name}</span>
                        {c.message ? <span className="block text-muted-foreground">{c.message}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
                {result.unmapped.length ? (
                  <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
                    {t('没有对应原语、已忽略的意思')}:{result.unmapped.join(';')}
                  </div>
                ) : null}
                <div className="num text-[10.5px] text-muted-foreground">hash {result.hash ? result.hash.slice(0, 16) : '—'}</div>
              </section>
            ) : null}

            <section className="space-y-2">
              {/* 原始表示默认折叠:普通路径只看上面的规则卡,专业用户展开改 JSON */}
              <details className="group rounded-md border">
                <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-[11.5px] select-none">
                  <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                  <span className="kicker text-foreground/85">3 · {t('查看规则表示')}</span>
                  <span className="text-[10.5px] text-muted-foreground">{t('策略 IR JSON / hash;可以直接改,改完重新检查,改了参数就是新 hash')}</span>
                </summary>
                <div className="space-y-2 border-t p-3">
                  <Textarea value={irText} onChange={(e) => setIrText(e.target.value)} placeholder={t('映射后出现在这里;也可以直接粘一份 IR')} className="num min-h-[260px] text-[11px]" spellCheck={false} />
                  {irError ? <div className="text-[11px] text-down">JSON: {irError}</div> : null}
                </div>
              </details>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={recheck} disabled={!irText.trim() || compileM.isPending}>
                  <RefreshCw /> {t('重新检查')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (!result?.ok) return;
                    try {
                      // 预热根数来自 compile 的 warmup 检查文案(「需要 N 根预热」);切段时窗口起点必须晚于它
                      const warm = Number(/需要\s*(\d+)\s*根预热/.exec(result.checks.find((c) => c.name === 'warmup')?.message ?? '')?.[1] ?? 0);
                      onUseIr(JSON.parse(irText) as StrategyIR, timeframe, Number.isFinite(warm) ? warm : 0);
                    } catch (e) {
                      setIrError((e as Error).message);
                    }
                  }}
                  disabled={!result?.ok || specBlocked || JSON.stringify(result?.ir) !== JSON.stringify(safeParse(irText))}
                  title={
                    !result?.ok
                      ? t('检查未全过')
                      : specBlocked
                        ? t('策略规范有不允许项:{s}', { s: (result?.spec?.violations ?? []).filter((v) => v.severity === 'block').map((v) => v.code).join('、') })
                        : JSON.stringify(result?.ir) !== JSON.stringify(safeParse(irText))
                          ? t('IR 改过了,先重新检查')
                          : ''
                  }
                >
                  <Beaker /> {t('用这条策略新建实验')}
                </Button>
                {result && !result.ok ? <span className="text-[10.5px] text-warn">{t('检查未全过,不能进回测')}</span> : null}
                {result?.ok && specBlocked ? <span className="text-[10.5px] text-down">{t('策略规范有不允许项,不能进回测')}</span> : null}
              </div>
            </section>
          </div>
        </ScrollArea>
      </div>
      <aside className="flex min-h-0 flex-col border-l" style={showPrimitives ? undefined : { display: 'none' }}>
        <div className="flex h-8 shrink-0 items-center border-b bg-muted/40 px-2.5">
          <span className="kicker text-foreground/85">{t('原语库')}</span>
          <span className="ml-auto num text-[10.5px] text-muted-foreground">{primsQ.data?.items.length ?? ''}</span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-2 text-[11px]">
            {backendMissing ? <div className="text-muted-foreground">{t('后端还没有原语目录(后端交付中)')}</div> : null}
            {primsQ.isLoading ? <div className="text-muted-foreground">{t('读取中…')}</div> : null}
            {groups.map(([cat, items]) => (
              <div key={cat} className="mb-2">
                <div className="mb-0.5 text-[10.5px] text-muted-foreground">{CATEGORY_LABEL[cat]}</div>
                {items.map((p) => (
                  <details key={p.name} className="group">
                    <summary className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/60 select-none">
                      <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                      <span className="num">{p.name}</span>
                    </summary>
                    <div className="ml-4 space-y-0.5 pb-1 text-muted-foreground">
                      <div>{PRIMITIVE_DESC[p.name] ?? p.description}</div>
                      {p.warmup_note ? <div>{p.warmup_note}</div> : null}
                      <pre className="max-h-32 overflow-auto rounded bg-muted/40 p-1 text-[10px] whitespace-pre-wrap">{JSON.stringify(p.params_schema?.['properties'] ?? p.params_schema, null, 1)}</pre>
                    </div>
                  </details>
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
      </aside>
    </div>
  );
}

/** 设计约束条:编译时按数据算出来的成本 / 止损下限 / ATR,模型提示里用的是同一份。 */
function ConstraintsStrip({ c, multiple }: { c: ResearchCompileConstraints; multiple: number }) {
  const p = (v: number, d = 2): string => `${(v * 100).toFixed(d)}%`;
  const items: { key: string; node: string; warn?: boolean }[] = [
    { key: 'cost', node: `${t('往返成本')} ${p(c.round_trip_cost_pct)}` },
    { key: 'floor', node: `${t('止损下限')} ${p(c.stop_floor_pct)}(${t('成本')}×${multiple})` },
    { key: 'rr', node: `${t('最小盈亏比')} ${c.min_rr}` },
  ];
  if (c.atr_pct_median !== null) items.push({ key: 'atr', node: `ATR(14) ${t('中位')} ${p(c.atr_pct_median)}${c.min_atr_multiple !== null ? ` → ${t('止损至少')} ${c.min_atr_multiple.toFixed(1)} ATR` : ''}` });
  if (c.strategy_stop_pct_median !== null)
    items.push({
      key: 'fit',
      node: `${t('本策略原始止损中位')} ${p(c.strategy_stop_pct_median)}${c.stop_fit_rate !== null ? `(${Math.round(c.stop_fit_rate * 100)}% ${t('会被放宽')})` : ''}`,
      warn: (c.stop_fit_rate ?? 0) > 0.5,
    });
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border bg-muted/20 px-3 py-1.5 text-[11px]">
      <span className="kicker shrink-0 text-foreground/85">{t('设计约束')}</span>
      {items.map((it, i) => (
        <span key={it.key} className={cn('num', it.warn ? 'text-warn' : 'text-muted-foreground')}>
          {i > 0 ? <span className="mr-1.5 text-muted-foreground/50">·</span> : null}
          {it.node}
        </span>
      ))}
      <span className="w-full text-[10px] text-muted-foreground">{t('模型提示里放的是同一份约束;止损来源优先结构位,ATR 倍数不得低于上面的下限。')}</span>
    </div>
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
