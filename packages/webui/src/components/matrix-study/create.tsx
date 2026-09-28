/**
 * 新建批量验证(内部名:矩阵研究,§9.53 B):资产 × 周期 × 策略 × 方向 × 比较方式(纯代码 / 代码 + Jev 判断)→ 先估算 → 开始。
 * 09-25 改版(面向第一次用的交易者):顶部一句话说明 + 三步图示;字段名说人话、每项一行灰字;估算直接说会跑几组、多久、花多少。
 * 「策略」两组可选,至少选一项:
 *   我的策略 —— ResearchStrategy 的某个版本(下拉搜索多选,默认当前版本),请求体 spec.strategies = [{strategy_id, version}];
 *   内置策略族 —— breakout / ma_trend …,请求体 spec.families。
 * 预填:from=<recommendation_id>(推荐卡)或 strategy=<id>(「我的策略」详情页「用批量验证测这条」)。
 * flow = 「策略研究」流程页第 2 步(海选):资产 / 周期 / 策略族由第 1 步带入(preset),资产默认只读(手动改收进折叠);
 *   海选不做迭代:请求体固定 iterate.generations = 0(后端 spec.ts 允许 0..3,search.ts 见 0 即 iterate_disabled),表单不展示迭代。
 * 09-26 边选边估:表单每改一次防抖 300ms 调 estimate(保留上一次结果不闪);四个维度(变体 / 判断调用 / 判断花费 / 币数)逐个黄 / 红;
 *   没选的选项按当前估算静态投影「再加这个会超 X」;超标时给一键修正(两段式 > 自动拆批 > 减维度,数字都先调 estimate 验证);
 *   Jev 缺省两段式(judge_stage = candidates,只对候补补跑 Jev)。投影 / 修正逻辑在 ./budget.ts。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, ChevronsUpDown, FlaskConical, Play, Scissors, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ResearchStrategy } from '@trade-gate/contracts';
import { researchApi } from '@/api/client';
import { matrixApi, useMatrixStudies, type MatrixArm, type MatrixEstimate, type MatrixSpecLite, type MatrixStudyView, type MatrixTimeframe } from '@/api/matrix-study';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FAMILY_TEXT } from '@/components/chat/recommendation-card';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { durationRange, estimateWallMs } from './explain';
import { ARM_TEXT, FAMILIES, RUNNABLE, TF_HORIZON, Toggle } from './shared';
import { DEFAULT_JUDGE_STAGE_MAX_CELLS, MAX_SYMBOLS, budgetDims, createBatches, createDebouncer, dimsText, estimateErrorText, optionHint, overOf, planFixes, type Change, type DimState, type FixOption, type ProjectionBase } from './budget';

const MAX_MY = 6;

/** 「我的策略」候选(不含已归档) */
export function useMyStrategyOptions() {
  return useQuery({
    queryKey: ['matrix-study', 'my-strategy-options'],
    queryFn: async () => (await researchApi.myStrategies({ filter: 'all', sort: 'updated' })).strategies.filter((s) => s.status !== 'archived'),
    staleTime: 30_000, retry: 0,
  });
}

function MyStrategyPicker({ options, value, onChange, loading }: { options: ResearchStrategy[]; value: string[]; onChange: (v: string[]) => void; loading: boolean }) {
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(options.map((s) => [s.id, s])), [options]);
  const toggle = (id: string) => {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else if (value.length >= MAX_MY) toast.warning(t('我的策略最多选 {n} 条', { n: MAX_MY }));
    else onChange([...value, id]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((id) => {
        const s = byId.get(id);
        return (
          <span key={id} className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-[12px] text-primary">
            {s ? `${s.name} v${s.current_version}` : id}
            <button type="button" aria-label={t('移除')} onClick={() => onChange(value.filter((x) => x !== id))} className="opacity-70 hover:opacity-100"><X className="size-3" /></button>
          </span>
        );
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted">
            {value.length ? t('再选一条') : t('选择我的策略')}<ChevronsUpDown className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder={t('搜索策略名 / 资产 / 周期')} />
            <CommandList>
              <CommandEmpty>{loading ? t('加载中…') : t('没有可选的策略')}</CommandEmpty>
              {options.map((s) => (
                <CommandItem key={s.id} value={`${s.name} ${s.symbol} ${s.timeframe} ${s.id}`} disabled={!s.current_version} onSelect={() => toggle(s.id)} className="text-[12px]">
                  <Check className={cn('size-3.5', value.includes(s.id) ? 'opacity-100' : 'opacity-0')} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="num shrink-0 text-muted-foreground">{s.symbol.replace(/USDT$/, '')} · {s.timeframe} · {s.current_version ? `v${s.current_version}` : t('无版本')}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** 海选(流程页)固定关掉迭代:迭代只在第 3 步精修里做 */
export const SCOUT_ITERATE = { generations: 0 } as const;
/** 提交 / 估算用的规格:海选(flow)固定带 iterate.generations = 0,独立页沿用后端缺省迭代 */
export function submitSpec(cur: MatrixSpecLite, symbols: string[], strategies: MatrixSpecLite['strategies'], flow: boolean): MatrixSpecLite {
  return flow ? { ...cur, symbols, strategies, iterate: SCOUT_ITERATE } : { ...cur, symbols, strategies };
}
/** 新建表单缺省 Jev 两段式(flow 与独立页都一样;旧预填规格没有这个字段也补上) */
export const DEFAULT_JUDGE_STAGE = 'candidates' as const;

/** 值变化后静默 ms 才跟上(首个值立刻生效);估算按它防抖 */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  const deb = useMemo(() => createDebouncer<T>(setV, ms), [ms]);
  useEffect(() => { deb.push(value); }, [value, deb]);
  useEffect(() => () => deb.cancel(), [deb]);
  return v;
}
export interface MatrixCreatePreset { symbols?: string[]; timeframes?: MatrixTimeframe[]; families?: string[]; sides?: ('long' | 'short')[]; market?: 'spot' | 'perp' }

export function MatrixStudyCreate({ from, strategy, onCreated, preset, flow = false }: { from: string | null; strategy?: string | null; onCreated?: (v: MatrixStudyView) => void; preset?: MatrixCreatePreset | null; flow?: boolean }) {
  const pre = useQuery({ queryKey: ['matrix-prefill', from], queryFn: () => matrixApi.prefill(from!), enabled: !!from, retry: 0 });
  const opts = useMyStrategyOptions();
  const options = opts.data ?? [];
  const [spec, setSpec] = useState<MatrixSpecLite | null>(null);
  const [symText, setSymText] = useState(() => (preset?.symbols ?? []).map((x) => x.replace(/USDT$/, '')).join(' '));
  const [mine, setMine] = useState<string[]>(() => (strategy ? [strategy] : []));
  useEffect(() => { if (pre.data?.spec) { setSpec({ ...pre.data.spec, judge_stage: pre.data.spec.judge_stage === 'candidates' ? 'candidates' : DEFAULT_JUDGE_STAGE }); setSymText(pre.data.spec.symbols.join(' ')); } }, [pre.data]);
  // 从「我的策略」跳来:资产缺省取该策略的资产(只预填一次,之后随用户改)
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !strategy || !opts.data) return;
    seeded.current = true;
    const s = opts.data.find((x) => x.id === strategy);
    if (!s) { toast.warning(t('没找到策略 {id}(可能已归档)', { id: strategy })); setMine((m) => m.filter((x) => x !== strategy)); return; }
    if (!symText.trim() && s.symbol) setSymText(s.symbol.replace(/USDT$/, ''));
  }, [strategy, opts.data, symText]);
  const presetFams = preset?.families?.filter((f) => (FAMILIES as readonly string[]).includes(f));
  const cur: MatrixSpecLite = spec ?? {
    symbols: [], timeframes: preset?.timeframes?.length ? preset.timeframes : strategy ? ['15m', '4h', '1d'] : ['4h'],
    families: presetFams?.length ? presetFams : strategy ? [] : ['breakout', 'ma_trend'],
    market: preset?.market ?? 'perp', sides: preset?.sides?.length ? (preset.market === 'spot' ? ['long'] : preset.sides) : ['long'], arms: ['code', 'code_judge'], recommendation_id: from,
    judge_stage: DEFAULT_JUDGE_STAGE,
  };
  const patch = (p: Partial<MatrixSpecLite>) => {
    const next: MatrixSpecLite = { ...cur, ...p };
    // 后端只在 candidates 下接受 judge_stage_max_cells
    if (next.judge_stage !== 'candidates') delete next.judge_stage_max_cells;
    setSpec(next);
  };
  const symbols = symText.split(/[\s,，]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => (s.endsWith('USDT') ? s : `${s}USDT`));
  const strategies = mine.map((id) => { const v = options.find((s) => s.id === id)?.current_version; return v ? { strategy_id: id, version: v } : { strategy_id: id }; });
  const full = submitSpec(cur, symbols, strategies, flow);
  const anyStrategy = full.families.length > 0 || strategies.length > 0;
  // 边选边估:规格 JSON 防抖 300ms 再估;保留上一次结果(placeholderData)避免闪烁。币数超了后端直接拒,不估,静态判
  const specKey = JSON.stringify(full);
  const debKey = useDebounced(specKey, 300);
  const settled = debKey === specKey;
  const tooMany = symbols.length > MAX_SYMBOLS;
  const ready = symbols.length > 0 && full.timeframes.length > 0 && anyStrategy && full.arms.length > 0;
  const est = useQuery({ queryKey: ['matrix-estimate', debKey], queryFn: () => matrixApi.estimate(JSON.parse(debKey) as MatrixSpecLite), enabled: ready && !tooMany, retry: 0, placeholderData: keepPreviousData, staleTime: 30_000 });
  const fresh = settled && !est.isPlaceholderData && !est.isFetching;
  const liveEst = ready && !tooMany ? est.data ?? null : null;
  const dims = budgetDims(liveEst?.estimate, symbols.length);
  const over = overOf(dims);
  const base: ProjectionBase | null = liveEst?.cells?.length && !tooMany ? { spec: full, estimate: liveEst.estimate, cells: liveEst.cells } : null;
  const hint = (ch: Change) => optionHint(base, ch, over);
  // 超标 → 一键修正(每条先调 estimate 验证);规格一变就重算
  const fixes = useQuery({
    queryKey: ['matrix-fixes', debKey], enabled: ready && over.length > 0 && settled && (tooMany || (!!est.data && !est.isPlaceholderData)),
    queryFn: () => planFixes(full, tooMany ? null : est.data ?? null, matrixApi.estimate), retry: 0, staleTime: 60_000,
  });
  const [busy, setBusy] = useState(false);
  const history = useMatrixStudies();
  const done = (v: MatrixStudyView) => { if (onCreated) onCreated(v); else window.location.hash = `matrix-study?id=${encodeURIComponent(v.id)}`; };
  const start = async () => {
    setBusy(true);
    try { done(await matrixApi.create(full)); } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const applyFix = async (f: FixOption) => {
    if (f.patch) { patch(f.patch); return; }
    if (!f.batches?.length) return;
    setBusy(true);
    try {
      const r = await createBatches(f.batches, matrixApi.create);
      if (r.created.length) toast.success(t('已创建 {n} 批', { n: r.created.length }));
      if (r.error) toast.error(t('第 {i} 批创建失败:{e}', { i: r.created.length + 1, e: r.error.message }));
      if (r.created[0]) done(r.created[0]);
    } finally { setBusy(false); }
  };
  const withJudge = cur.arms.includes('code_judge');
  const stage = cur.judge_stage === 'candidates' ? 'candidates' : 'all';
  const K = liveEst?.estimate.judge_stage?.max_cells ?? cur.judge_stage_max_cells ?? DEFAULT_JUDGE_STAGE_MAX_CELLS;
  const blocked = over.length > 0;
  return (
    <section className="rounded-lg border p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <FlaskConical className="size-4 text-primary" />
        <h2 className="text-[15px] font-medium">{flow ? t('新建海选') : t('新建批量验证')}</h2>
        {from ? <span className="text-[11px] text-muted-foreground">{t('来自对话推荐 {id}', { id: from })}</span> : null}
      </div>
      <div className="mb-3 flex flex-col gap-2.5 lg:flex-row lg:items-center lg:gap-4">
        <p className="text-[12.5px] leading-relaxed text-muted-foreground lg:max-w-md">{flow ? t('把选好的币、周期和几种打法一次性回测一遍,看哪几组站得住;这一步只比较、不改规则,想改规则到下一步精修。') : t('挑几个币和周期,把几种策略一次性回测,看加上 Jev 判断会不会更好;最后用一段没看过的历史验收,过了才能存成我的策略。')}</p>
        <HowItWorks flow={flow} />
      </div>
      {pre.isError ? <p className="mb-2 text-[12px] text-destructive">{t('推荐预填失败:{e}', { e: (pre.error as Error).message })}</p> : null}
      <div className="grid gap-x-3 gap-y-2.5 text-[12px] md:grid-cols-[6.5rem_1fr]">
        <Field label={t('资产')} hint={flow ? t('第 1 步选好的币;少于 4 个时,结论只能当参考') : t('用空格隔开,最多 6 个;少于 4 个时,结论只能当参考')}>
          {flow ? (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-1" data-testid="scout-symbols">
                {symbols.length ? symbols.map((x) => <span key={x} className="num rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[12px] text-primary">{x.replace(/USDT$/, '')}</span>) : <span className="text-[12px] text-warn">{t('还没有资产,回第 1 步选')}</span>}
              </div>
              <details className="text-[11px]">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('手动改资产')}</summary>
                <input value={symText} onChange={(e) => setSymText(e.target.value)} placeholder={t('空格分隔,如 SOL DOGE HYPE(≤ 6 个)')} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-[12px]" />
              </details>
            </div>
          ) : (
            <input value={symText} onChange={(e) => setSymText(e.target.value)} placeholder={t('空格分隔,如 SOL DOGE HYPE(≤ 6 个)')} className={cn('h-8 w-full rounded-md border bg-background px-2', tooMany && 'border-destructive')} />
          )}
          <SymbolBudget n={symbols.length} add={symbols.length && symbols.length < MAX_SYMBOLS ? hint({ kind: 'add_symbol' }) : null} />
        </Field>
        <Field label={t('周期')} hint={t('15m 算短线,4h 中线,1d 长线。3m / 5m 只研究,不能实盘,这一版先不回测')}>
          <Toggle all={['3m', '5m', '15m', '4h', '1d'] as MatrixTimeframe[]} value={cur.timeframes} onChange={(v) => patch({ timeframes: v })}
            label={(x) => (RUNNABLE.includes(x) ? `${x} · ${TF_HORIZON[x]}` : `${x} · ${t('只研究,不能实盘')}`)} disabled={(x) => (RUNNABLE.includes(x) ? null : t('3m / 5m 的实盘下单还没验证过,这一版不回测'))}
            warn={(x) => hint({ kind: 'add_timeframe', tf: x })} />
        </Field>
        <Field label={t('策略')} hint={t('内置策略族是几种常见打法的模板;也可以拿「我的策略」里存过的来测')}>
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-start gap-2">
              <span className="w-16 shrink-0 pt-0.5 text-[11px] text-muted-foreground">{t('我的策略')}</span>
              <div className="min-w-0 flex-1"><MyStrategyPicker options={options} value={mine} onChange={setMine} loading={opts.isLoading} /></div>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <span className="w-16 shrink-0 pt-0.5 text-[11px] text-muted-foreground">{t('内置策略族')}</span>
              <div className="min-w-0 flex-1"><Toggle all={FAMILIES} value={cur.families as (typeof FAMILIES)[number][]} onChange={(v) => patch({ families: v })} label={(x) => FAMILY_TEXT[x]} warn={(x) => hint({ kind: 'add_family', family: x })} /></div>
            </div>
            {mine.length ? <p className="text-[11px] text-muted-foreground">{t('我的策略按每个格子的周期跑(规则里的根数不变);存下来是这条策略的新版本,不新建策略')}</p> : null}
            {!anyStrategy ? <p className="text-[11px] text-warn">{t('至少选一条我的策略或一个内置策略族')}</p> : null}
          </div>
        </Field>
        <Field label={t('方向 / 市场')} hint={t('永续可以做多也可以做空;现货只能做多')}>
          <div className="flex flex-wrap items-center gap-3">
            <Toggle all={['long', 'short'] as const} value={cur.sides} onChange={(v) => patch({ sides: v })} label={(x) => (x === 'long' ? t('做多') : t('做空'))} disabled={(x) => (x === 'short' && cur.market === 'spot' ? t('现货不能做空') : null)} warn={(x) => hint({ kind: 'add_side', side: x })} />
            <Toggle all={['perp', 'spot'] as const} value={[cur.market]} onChange={(v) => v.length && patch({ market: v[v.length - 1]!, sides: v[v.length - 1] === 'spot' ? ['long'] : cur.sides })} label={(x) => (x === 'perp' ? t('永续') : t('现货'))} />
          </div>
        </Field>
        <Field label={t('比较方式')} hint={t('两种都选,才看得出 Jev 判断到底有没有帮上忙;只选纯代码就不花 Jev 的钱')}>
          <Toggle all={['code', 'code_judge'] as MatrixArm[]} value={cur.arms} onChange={(v) => patch({ arms: v })} label={(x) => ARM_TEXT[x]} warn={(x) => hint({ kind: 'add_arm', arm: x })} />
          {withJudge ? (
            <div className="space-y-0.5" data-testid="judge-stage">
              <Toggle all={['candidates', 'all'] as const} value={[stage]} onChange={(v) => v.length && patch({ judge_stage: v[v.length - 1] })}
                label={(x) => (x === 'candidates' ? t('只对候补测 Jev(省钱)') : t('每组都测 Jev'))} warn={(x) => hint({ kind: 'set_stage', mode: x })} />
              <p className="text-[11px] text-muted-foreground/80">{stage === 'candidates'
                ? t('先只跑纯代码,候补 / 接近 / 通过的格子里按评分取前 {k} 格再补跑 Jev;判断次数和花费按最坏 {k} 格估', { k: K })
                : t('每一组都同时跑纯代码和代码 + Jev 判断,最看得清 Jev 的作用,也最费判断次数')}</p>
            </div>
          ) : null}
        </Field>
        <Field label={t('最终验收')} hint={t('最后那段没看过的历史只能用一次。自动:候选一定下来就拿去考;手动:你先看看候选再决定')}>
          <Toggle all={['auto', 'manual'] as const} value={[cur['auto_finalize'] === false ? 'manual' : 'auto']} onChange={(v) => v.length && patch({ auto_finalize: v[v.length - 1] === 'auto' })}
            label={(x) => (x === 'auto' ? t('自动验收一次') : t('我手动验收'))} />
        </Field>
      </div>
      {ready && blocked ? <FixPanel over={over} loading={fixes.isLoading || fixes.isFetching} fixes={fixes.data ?? []} error={fixes.isError} busy={busy} onApply={(f) => void applyFix(f)} /> : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md bg-muted/40 px-2.5 py-2 text-[12px]" data-testid="estimate-bar">
        {!ready ? <span className="text-muted-foreground">{t('填好资产后自动估算')}</span> : tooMany ? (
          <BudgetDims dims={dims} />
        ) : est.isError && !est.data ? <span className="text-destructive">{estimateErrorText((est.error as Error).message)}</span> : est.data ? (
          <EstimateLine e={est.data.estimate} dims={dims} history={history.data?.items ?? []} withJudge={withJudge} stale={!fresh} />
        ) : <span className="text-muted-foreground">{t('正在估算…')}</span>}
        {est.isError && est.data ? <span className="text-destructive">{estimateErrorText((est.error as Error).message)}</span> : null}
        <div className="ml-auto flex items-center gap-2">
          {ready && blocked ? <span className="text-[11.5px] text-destructive">{t('先点上面的修正')}</span> : null}
          <Button size="sm" className="gap-1" disabled={busy || blocked || !settled || est.data?.estimate.within_budget === false || !ready} onClick={() => void start()}>
            <Play className="size-3.5" />{busy ? t('创建中…') : flow ? t('开始海选') : t('开始验证')}
          </Button>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {t('历史按时间切成三段:前一段用来调参数,中间一段用来挑候选,最后一段先锁起来,候选定了才拿出来考一次;每次尝试都记账,防止「试得多了碰巧好看」。')}
        {' '}{t('所以「没找到能用的策略」很常见,也是有用的结论:说明这些组合在这段行情里站不住,省得拿真钱去试。')}
      </p>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <>
      <span className="pt-1 text-muted-foreground" title={hint}>{label}</span>
      <div className="min-w-0 space-y-1">
        {children}
        <p className="text-[11px] text-muted-foreground/80">{hint}</p>
      </div>
    </>
  );
}

/** 三步小图示:批量回测 → 自动诊断改进 → 最终验收;海选(flow)不迭代,中间一步换成「挑出候选」 */
function HowItWorks({ flow = false }: { flow?: boolean }) {
  const steps = [
    { title: t('批量回测'), sub: t('每种组合跑两遍:纯代码 / 加 Jev 判断') },
    flow ? { title: t('挑出候选'), sub: t('按评分分成通过 / 候补 / 未通过') } : { title: t('自动诊断改进'), sub: t('没过的找原因、改参数重跑') },
    { title: t('最终验收'), sub: t('用没看过的一段历史考一次') },
  ];
  return (
    <ol className="flex flex-1 flex-wrap items-stretch gap-1.5" aria-label={t('批量验证怎么做')}>
      {steps.map((s, i) => (
        <li key={s.title} className="flex items-center gap-1.5">
          <div className="rounded-md border bg-muted/30 px-2 py-1">
            <div className="flex items-center gap-1 text-[12px] font-medium">
              <span className="num inline-flex size-4 items-center justify-center rounded-full bg-primary/15 text-[10px] text-primary">{i + 1}</span>{s.title}
            </div>
            <div className="text-[10.5px] text-muted-foreground">{s.sub}</div>
          </div>
          {i < steps.length - 1 ? <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/60" /> : null}
        </li>
      ))}
    </ol>
  );
}

const LEVEL_CLS: Record<DimState['level'], string> = { ok: '', near: 'text-warn', over: 'text-destructive' };
const dimOf = (dims: DimState[], d: DimState['dim']) => dims.find((x) => x.dim === d)!;

/** 资产栏下一行:币数超了(静态,不用后端)/ 再加一个币会超什么 */
function SymbolBudget({ n, add }: { n: number; add: { detail: string } | null }) {
  if (n > MAX_SYMBOLS) return <p className="text-[11.5px] text-destructive" data-level="over">{t('币数超了:{n} 个,一次最多 {m} 个;可以用下面的「自动拆批」', { n, m: MAX_SYMBOLS })}</p>;
  if (add) return <p className="text-[11px] text-warn">{t('再加一个币会超:{x}', { x: add.detail })}</p>;
  return null;
}

/** 只有币数可说的时候(币数超了,后端不估) */
function BudgetDims({ dims }: { dims: DimState[] }) {
  const s = dimOf(dims, 'symbols');
  return <span className={LEVEL_CLS[s.level]} data-dim="symbols" data-level={s.level}>{t('币数 {v} / {l}', { v: s.shown, l: s.limitShown })}{s.level === 'over' ? ` · ${t('超了:{x}', { x: dimsText(['symbols']) })}` : ''}</span>;
}

/** 估算说人话:可评估几组、变体 / 上限、Jev 次数与预留美元(两段式写最坏 K 格)、预计多久;每个维度 >80% 黄、超了红 */
function EstimateLine({ e, dims, history, withJudge, stale }: { e: MatrixEstimate; dims: DimState[]; history: MatrixStudyView[]; withJudge: boolean; stale: boolean }) {
  const wall = estimateWallMs(e, history);
  const skipped = e.cells.not_applicable + e.cells.research_only;
  const v = dimOf(dims, 'variants'), c = dimOf(dims, 'judge_calls'), u = dimOf(dims, 'judge_usd'), sy = dimOf(dims, 'symbols');
  const cand = e.judge_stage?.mode === 'candidates';
  const k = cand ? Math.min(e.judge_stage!.max_cells ?? DEFAULT_JUDGE_STAGE_MAX_CELLS, e.judge_stage!.judge_cells) : 0;
  const over = overOf(dims);
  return (
    <>
      <span data-dim="variants" data-level={v.level}>
        {t('可评估 {n} 组', { n: e.cells.applicable })} · <span className={LEVEL_CLS[v.level]}>{t('变体 {v} / {l}', { v: v.shown, l: v.limitShown })}</span>
        {e.iteration_trials_max ? <span className="text-muted-foreground">{t('(没过的最多再改 {m} 次重跑)', { m: e.iteration_trials_max })}</span> : null}
        {skipped ? <span className="text-muted-foreground">{t(',另有 {n} 组不适用会跳过', { n: skipped })}</span> : null}
      </span>
      {withJudge ? (
        <span>
          <span className={LEVEL_CLS[c.level]} data-dim="judge_calls" data-level={c.level}>{t('Jev 判断 {n} 次 / {l}', { n: c.shown, l: c.limitShown })}</span>
          {' · '}<span className={LEVEL_CLS[u.level]} data-dim="judge_usd" data-level={u.level}>{t('预留 {u} / {l}', { u: u.shown, l: u.limitShown })}</span>
          {cand ? <span className="text-muted-foreground">{t('(两段式,按最坏 {k} 格估)', { k })}</span> : null}
        </span>
      ) : <span>{t('不用 Jev,不花模型的钱')}</span>}
      {sy.level !== 'ok' ? <span className={LEVEL_CLS[sy.level]} data-dim="symbols" data-level={sy.level}>{t('币数 {v} / {l}', { v: sy.shown, l: sy.limitShown })}</span> : null}
      <span>{wall ? t('预计{d}', { d: durationRange(wall.low, wall.high) }) : t('光取数最多要 {m} 分钟', { m: Math.max(1, Math.ceil(e.data.cold_fetch_ms_upper / 60000)) })}{wall ? <span className="text-muted-foreground">{t('(按最近几次的速度估)')}</span> : null}</span>
      {over.length ? <span className="font-medium text-destructive" data-testid="budget-over">{t('超了:{x}', { x: dimsText(over) })}</span> : null}
      {stale ? <span className="text-[11px] text-muted-foreground">{t('正在重新估算…')}</span> : null}
    </>
  );
}

/** 超标时的一键修正:1–3 个按钮,每个写清修正后的数字(已调 estimate 验证) */
function FixPanel({ over, fixes, loading, error, busy, onApply }: { over: DimState['dim'][]; fixes: FixOption[]; loading: boolean; error: boolean; busy: boolean; onApply: (f: FixOption) => void }) {
  return (
    <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[12px]" data-testid="budget-fixes">
      <div className="font-medium text-destructive">{t('超出这次能跑的上限:{x}', { x: dimsText(over) })}</div>
      {loading && !fixes.length ? <p className="mt-1 text-muted-foreground">{t('正在找修正办法…')}</p> : null}
      {!loading && !fixes.length ? <p className="mt-1 text-muted-foreground">{error ? t('修正办法没算出来,手动少选几个币、周期或策略') : t('没找到能自动修好的办法,手动少选几个币、周期或策略')}</p> : null}
      {fixes.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {fixes.map((f) => (
            <Button key={f.kind + f.title} size="sm" variant={f.still_over.length ? 'outline' : 'secondary'} disabled={busy} data-fix={f.kind} className="h-auto flex-col items-start gap-0 py-1 text-left" onClick={() => onApply(f)}>
              <span className="inline-flex items-center gap-1 text-[12px] font-medium">{f.batches ? <Scissors className="size-3" /> : <Wand2 className="size-3" />}{f.title}</span>
              <span className={cn('num text-[11px] font-normal', f.still_over.length ? 'text-destructive' : 'text-muted-foreground')}>{f.detail}</span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
