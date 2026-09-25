/**
 * 新建矩阵研究表单(§9.53 B):资产 × 周期 × 策略 × 方向 × 两臂(纯代码 / 代码 + Jev)→ 先估算 → 开始。
 * 「策略」两组可选,至少选一项:
 *   我的策略 —— ResearchStrategy 的某个版本(下拉搜索多选,默认当前版本),请求体 spec.strategies = [{strategy_id, version}];
 *   内置策略族 —— breakout / ma_trend …,请求体 spec.families。
 * 预填:from=<recommendation_id>(推荐卡)或 strategy=<id>(「我的策略」详情页「在矩阵研究里测这条」)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, FlaskConical, Play, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ResearchStrategy } from '@trading-swarm/contracts';
import { researchApi } from '@/api/client';
import { matrixApi, type MatrixArm, type MatrixSpecLite, type MatrixStudyView, type MatrixTimeframe } from '@/api/matrix-study';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FAMILY_TEXT } from '@/components/chat/recommendation-card';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { ARM_TEXT, FAMILIES, RUNNABLE, TF_HORIZON, Toggle } from './shared';

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

export function MatrixStudyCreate({ from, strategy, onCreated }: { from: string | null; strategy?: string | null; onCreated?: (v: MatrixStudyView) => void }) {
  const pre = useQuery({ queryKey: ['matrix-prefill', from], queryFn: () => matrixApi.prefill(from!), enabled: !!from, retry: 0 });
  const opts = useMyStrategyOptions();
  const options = opts.data ?? [];
  const [spec, setSpec] = useState<MatrixSpecLite | null>(null);
  const [symText, setSymText] = useState('');
  const [mine, setMine] = useState<string[]>(() => (strategy ? [strategy] : []));
  useEffect(() => { if (pre.data?.spec) { setSpec(pre.data.spec); setSymText(pre.data.spec.symbols.join(' ')); } }, [pre.data]);
  // 从「我的策略」跳来:资产缺省取该策略的资产(只预填一次,之后随用户改)
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !strategy || !opts.data) return;
    seeded.current = true;
    const s = opts.data.find((x) => x.id === strategy);
    if (!s) { toast.warning(t('没找到策略 {id}(可能已归档)', { id: strategy })); setMine((m) => m.filter((x) => x !== strategy)); return; }
    if (!symText.trim() && s.symbol) setSymText(s.symbol.replace(/USDT$/, ''));
  }, [strategy, opts.data, symText]);
  const cur: MatrixSpecLite = spec ?? { symbols: [], timeframes: strategy ? ['15m', '4h', '1d'] : ['4h'], families: strategy ? [] : ['breakout', 'ma_trend'], market: 'perp', sides: ['long'], arms: ['code', 'code_judge'], recommendation_id: from };
  const patch = (p: Partial<MatrixSpecLite>) => setSpec({ ...cur, ...p });
  const symbols = symText.split(/[\s,，]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => (s.endsWith('USDT') ? s : `${s}USDT`));
  const strategies = mine.map((id) => { const v = options.find((s) => s.id === id)?.current_version; return v ? { strategy_id: id, version: v } : { strategy_id: id }; });
  const full: MatrixSpecLite = { ...cur, symbols, strategies };
  const anyStrategy = full.families.length > 0 || strategies.length > 0;
  const est = useQuery({ queryKey: ['matrix-estimate', JSON.stringify(full)], queryFn: () => matrixApi.estimate(full), enabled: symbols.length > 0 && full.timeframes.length > 0 && anyStrategy, retry: 0 });
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const v = await matrixApi.create(full);
      if (onCreated) onCreated(v); else window.location.hash = `matrix-study?id=${encodeURIComponent(v.id)}`;
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="rounded-lg border p-3">
      <div className="mb-2 flex items-center gap-2">
        <FlaskConical className="size-4 text-primary" />
        <h2 className="text-[15px] font-medium">{t('新建矩阵研究')}</h2>
        {from ? <span className="text-[11px] text-muted-foreground">{t('来自对话推荐 {id}', { id: from })}</span> : null}
      </div>
      {pre.isError ? <p className="mb-2 text-[12px] text-destructive">{t('推荐预填失败:{e}', { e: (pre.error as Error).message })}</p> : null}
      <div className="grid gap-2 text-[12px] md:grid-cols-[6rem_1fr]">
        <span className="text-muted-foreground">{t('资产')}</span>
        <input value={symText} onChange={(e) => setSymText(e.target.value)} placeholder={t('空格分隔,如 SOL DOGE HYPE(≤ 6 个)')} className="h-8 rounded-md border bg-background px-2" />
        <span className="text-muted-foreground">{t('周期')}</span>
        <Toggle all={['3m', '5m', '15m', '4h', '1d'] as MatrixTimeframe[]} value={cur.timeframes} onChange={(v) => patch({ timeframes: v })}
          label={(x) => `${x} · ${TF_HORIZON[x]}`} disabled={(x) => (RUNNABLE.includes(x) ? null : t('3m/5m 运行器暂不支持,只能离线研究,本版不进矩阵'))} />
        <span className="pt-0.5 text-muted-foreground">{t('策略')}</span>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-start gap-2">
            <span className="w-16 shrink-0 pt-0.5 text-[11px] text-muted-foreground">{t('我的策略')}</span>
            <div className="min-w-0 flex-1"><MyStrategyPicker options={options} value={mine} onChange={setMine} loading={opts.isLoading} /></div>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <span className="w-16 shrink-0 pt-0.5 text-[11px] text-muted-foreground">{t('内置策略族')}</span>
            <div className="min-w-0 flex-1"><Toggle all={FAMILIES} value={cur.families as (typeof FAMILIES)[number][]} onChange={(v) => patch({ families: v })} label={(x) => FAMILY_TEXT[x]} /></div>
          </div>
          {mine.length ? <p className="text-[11px] text-muted-foreground">{t('我的策略按每个格子的周期跑(规则里的根数不变);存下来是这条策略的新版本,不新建策略')}</p> : null}
          {!anyStrategy ? <p className="text-[11px] text-warn">{t('至少选一条我的策略或一个内置策略族')}</p> : null}
        </div>
        <span className="text-muted-foreground">{t('方向 / 市场')}</span>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle all={['long', 'short'] as const} value={cur.sides} onChange={(v) => patch({ sides: v })} label={(x) => (x === 'long' ? t('做多') : t('做空'))} disabled={(x) => (x === 'short' && cur.market === 'spot' ? t('现货不能做空') : null)} />
          <Toggle all={['perp', 'spot'] as const} value={[cur.market]} onChange={(v) => v.length && patch({ market: v[v.length - 1]!, sides: v[v.length - 1] === 'spot' ? ['long'] : cur.sides })} label={(x) => (x === 'perp' ? t('永续') : t('现货'))} />
        </div>
        <span className="text-muted-foreground">{t('对照臂')}</span>
        <Toggle all={['code', 'code_judge'] as MatrixArm[]} value={cur.arms} onChange={(v) => patch({ arms: v })} label={(x) => ARM_TEXT[x]} />
        <span className="text-muted-foreground">{t('留出段')}</span>
        <Toggle all={['auto', 'manual'] as const} value={[cur['auto_finalize'] === false ? 'manual' : 'auto']} onChange={(v) => v.length && patch({ auto_finalize: v[v.length - 1] === 'auto' })}
          label={(x) => (x === 'auto' ? t('候选冻结后自动释放一次') : t('我手动释放'))} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-muted/40 px-2.5 py-2 text-[12px]">
        <span className="text-muted-foreground">{t('估算')}</span>
        {est.isLoading ? <span>…</span> : est.isError ? <span className="text-destructive">{(est.error as Error).message}</span> : est.data ? (() => {
          const e = est.data.estimate;
          return (
            <>
              <span className="num">{t('格子')} <b>{e.cells.applicable}</b>/{e.cells.total}{e.cells.research_only ? ` · ${t('仅研究')} ${e.cells.research_only}` : ''}</span>
              <span className="num">{t('试验')} <b>{e.matrix_trials}</b> + {t('迭代上限')} {e.iteration_trials_max}</span>
              <span className="num">Jev <b>{e.judge_calls}</b> {t('次')} ≈ <b>${e.judge_usd}</b></span>
              <span className="num">{t('冷数据最多约 {m} 分钟', { m: Math.ceil(e.data.cold_fetch_ms_upper / 60000) })}</span>
              {!e.within_budget ? <span className="text-destructive">{t('超出变体预算,减少资产/周期/策略族')}</span> : null}
              {e.warnings.slice(0, 2).map((w) => <span key={w} className="text-warn">{w}</span>)}
            </>
          );
        })() : <span className="text-muted-foreground">{t('填好资产后自动估算')}</span>}
        <Button size="sm" className="ml-auto gap-1" disabled={busy || est.data?.estimate.within_budget === false || !symbols.length || !cur.timeframes.length || !anyStrategy || !cur.arms.length} onClick={() => void start()}>
          <Play className="size-3.5" />{busy ? t('创建中…') : t('开始研究')}
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{t('训练 / 选择 / 留出三段按时间切;留出段锁死,最终候选冻结后只释放一次。「没找到」是正常结论。')}</p>
    </section>
  );
}
