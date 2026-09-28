/**
 * 第 5 步「上岗」:设为 agent 当前策略(SetAgentStrategyButton,§9.54),说明上岗后楼层各桌拿到哪些规则(DESK_SLICES ← binding.roles),
 * 币池跟随雷达档(运行已存在时 PATCH symbols_source;agent 切策略会复用同策略的运行,沿用它的币池),
 * Jev:策略带判断要素 → 实盘里把关;没带 → 影子判断只记录不挡单,链到 Agent 页「Jev 判断」。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Cpu, Radar, ShieldCheck, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { researchApi, strategyRunsApi } from '@/api/client';
import type { StrategyRun, StrategyRunPatch } from '@/api/types';
import { useAgentStrategy } from '@/api/agent-strategy';
import { SWITCH_MODES, SetAgentStrategyButton, type SwitchMode } from '@/components/agent-strategy/current-strategy';
import { displayName } from '@/components/agent-strategy/switch-list';
import { useStrategyRuns } from '@/components/my-strategies/run-panel';
import { QUESTION_LABEL } from '@/components/judge-live/logic';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { t, listSep } from '@/lib/i18n';
import type { FlowGo } from './flow-intro';
import { DESK_TEXT, RADAR_TIER_TEXT, RADAR_TOP_N, deployReady, deskRules, forwardRunOf, judgeQuestions, radarTierOf, type FlowRoute } from './model';
import { useFlowStrategy } from './step-validate';
import { StrategyPicker } from './strategy-picker';

/** Agent 页右栏「Jev 判断」tab:agent-side 按 localStorage 记 tab,跳过去前先写好 */
export function openJevTab() {
  try { window.localStorage.setItem('tg.agent.side.tab', 'jev'); } catch { /* 隐私模式 */ }
  window.location.hash = 'agent';
}

export function StepDeploy({ route, go }: { route: FlowRoute; go: FlowGo }) {
  if (!route.strategy) return <StrategyPicker title={t('选一条我的策略上岗')} onPick={(id) => go({ strategy: id })} onBack={{ label: t('回到验收'), go: () => go({ step: 'validate' }) }} />;
  return <DeployBody key={route.strategy} id={route.strategy} go={go} />;
}

function DeployBody({ id, go }: { id: string; go: FlowGo }) {
  const q = useFlowStrategy(id);
  const agent = useAgentStrategy();
  const runsQ = useStrategyRuns();
  const s = q.data?.strategy ?? null;
  const version = s?.current_version ?? 0;
  const bindQ = useQuery({ queryKey: ['research', 'my-strategy-binding', id, version], queryFn: () => researchApi.myStrategyBinding(id, version), enabled: !!version, retry: false });
  if (q.isLoading) return <Skeleton className="h-60 rounded-xl" />;
  if (!s) return <p className="text-[12.5px] text-destructive">{t('读不到这条策略:{e}', { e: (q.error as Error | null)?.message ?? id })}</p>;
  const ir = q.data!.versions.find((v) => v.version === version)?.strategy_ir ?? null;
  const judge = judgeQuestions(ir);
  const run = forwardRunOf(runsQ.data?.runs, id);
  const isCurrent = agent.data?.kind === 'strategy' && agent.data.strategy_id === id;
  const desks = bindQ.data?.binding ? deskRules(bindQ.data.binding.roles) : [];
  return (
    <div className="flex flex-col gap-3" data-testid="step-deploy">
      <section className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 to-transparent px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <h2 className="text-[15px] font-semibold">{t('把「{name}」交给 agent', { name: displayName(s) })}</h2>
          <span className="num text-[12px] text-muted-foreground">v{version} · {s.symbol.replace(/USDT$/, '')} · {s.timeframe}</span>
          <div className="ml-auto"><SetAgentStrategyButton strategyId={id} version={version} mode={run && SWITCH_MODES.includes(run.mode as SwitchMode) ? (run.mode as SwitchMode) : 'agent'} /></div>
        </div>
        <p className="text-[12px] text-muted-foreground">{t('上岗后 agent 只按这条策略开仓(LLM 判断:命中后先判断做不做,价格仍由策略定);已开的仓位按原来的规则退出。随时可以在 Agent 页顶部切回自由判断。')}</p>
        {!deployReady(run) ? <p className="text-[11.5px] text-warn">{t('模拟盘前向还没达到建议线(满 10 笔且期望 > 0)。可以上岗,但建议先多跑一段。')}</p> : null}
        <PoolLine run={isCurrent ? run : null} timeframe={s.timeframe} deployed={isCurrent} />
      </section>

      <section className="rounded-xl border px-4 py-3" data-testid="jev-note">
        <div className="mb-1 flex items-center gap-2"><ShieldCheck className="size-4 text-primary" /><h3 className="text-[13px] font-semibold">{t('Jev 在实盘里做什么')}</h3></div>
        {judge ? (
          <p className="text-[12px]" data-jev="gate">{t('这条策略带了 Jev 判断要素({q}):上岗后 Jev 在实盘里把关,判不过的候选不下单。', { q: judge.map((k) => QUESTION_LABEL[k] ?? k).join(listSep()) || t('默认问题') })}</p>
        ) : (
          <p className="text-[12px]" data-jev="shadow">{t('这条策略没带 Jev 判断要素:Jev 会对每个候选做影子判断,只记录、不挡单,攒下来的记录用来判断以后值不值得让它把关。')}</p>
        )}
        <button type="button" className="mt-1 text-[12px] text-primary hover:underline" onClick={openJevTab}>{t('去 Agent 页看「Jev 判断」')}</button>
      </section>

      <section className="rounded-xl border px-4 py-3" data-testid="desk-rules">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <h3 className="text-[13px] font-semibold">{t('上岗后楼层各桌拿到的规则')}</h3>
          <span className="text-[11px] text-muted-foreground">{t('策略编译成一份绑定,按职责切给各张桌;标「代码」的是代码直接执行,不问模型。')}</span>
        </div>
        {bindQ.isLoading ? <Skeleton className="h-28 rounded-lg" /> : !desks.length ? <p className="text-[12px] text-muted-foreground">{t('这条策略还编译不出绑定:{e}', { e: (bindQ.error as Error | null)?.message ?? t('没有绑定') })}</p> : (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {desks.map((d) => (
              <div key={d.desk} data-desk={d.desk} className={cn('rounded-lg border p-2.5', !d.slices.length && 'border-dashed opacity-70')}>
                <div className="mb-1 text-[12.5px] font-semibold">{DESK_TEXT[d.desk] ?? d.desk}</div>
                {!d.slices.length ? <p className="text-[11px] text-muted-foreground">{t('当前策略没有分给这张桌的规则')}</p> : d.slices.map((sl) => (
                  <div key={sl.role} className="mb-1.5 last:mb-0">
                    <div className="text-[11.5px] font-medium">{sl.title}</div>
                    <p className="text-[11px] text-muted-foreground">{sl.summary}</p>
                    <ul className="mt-0.5 space-y-0.5 text-[11px]">
                      {sl.rules.slice(0, 3).map((r, i) => <li key={i} className="flex gap-1"><Cpu className={cn('mt-0.5 size-3 shrink-0', r.executor === 'code' ? 'text-muted-foreground' : 'text-primary')} /><span className="line-clamp-2">{r.text}</span></li>)}
                      {sl.rules.length > 3 ? <li className="text-muted-foreground">{t('还有 {n} 条', { n: sl.rules.length - 3 })}</li> : null}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <button type="button" className="inline-flex w-fit items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => go({ step: 'validate' })}><ArrowLeft className="size-3.5" />{t('回到验收')}</button>
    </div>
  );
}

/** 币池:上岗了就看它的运行跟不跟雷达档,不跟就给一个「改成跟随」;还没上岗只说明规则 */
function PoolLine({ run, timeframe, deployed }: { run: StrategyRun | null; timeframe: string; deployed: boolean }) {
  const qc = useQueryClient();
  const tier = radarTierOf(timeframe);
  const [confirm, setConfirm] = useState('');
  const live = !!run && run.execution.backend !== 'paper' && run.execution.profile !== 'demo';
  const patch = useMutation({
    mutationFn: () => strategyRunsApi.patch(run!.id, { symbols_source: { kind: 'radar', tier, top_n: RADAR_TOP_N }, ...(live ? { confirm: confirm.trim() } : {}) } as StrategyRunPatch),
    onSuccess: () => { toast.success(t('币池改成跟随{tier}', { tier: RADAR_TIER_TEXT[tier] })); void qc.invalidateQueries({ queryKey: ['strategy-runs'] }); },
    onError: (e) => toast.error((e as Error).message),
  });
  const src = (run as (StrategyRun & { symbols_source?: { kind: string; tier?: 'short' | 'swing' | 'weekly'; top_n?: number } }) | null)?.symbols_source;
  if (!deployed || !run) return <p className="flex items-center gap-1 text-[11.5px] text-muted-foreground" data-pool="pending"><Radar className="size-3.5" />{t('币池:跟随{tier}前 {n} 名。第 4 步已经在模拟盘跑的,上岗沿用那次的币池;没跑过的,上岗后在这里改成跟随。', { tier: RADAR_TIER_TEXT[tier], n: RADAR_TOP_N })}</p>;
  if (src?.kind === 'radar') return <p className="flex items-center gap-1 text-[11.5px] text-up" data-pool="radar"><Radar className="size-3.5" />{t('币池跟随{tier}前 {n} 名,雷达换榜时自动换币(已有持仓不丢)', { tier: RADAR_TIER_TEXT[src.tier ?? tier], n: src.top_n ?? RADAR_TOP_N })}</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11.5px]" data-pool="fixed">
      <Radar className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">{t('币池现在是固定的:{syms}', { syms: run.symbols.map((x) => x.replace(/USDT$/, '')).join(' ') })}</span>
      {live ? <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="LIVE" className="h-6 w-20 text-[11px]" /> : null}
      <Button size="xs" variant="outline" disabled={patch.isPending || (live && confirm.trim() !== 'LIVE')} onClick={() => patch.mutate()}>{t('改成跟随{tier}', { tier: RADAR_TIER_TEXT[tier] })}</Button>
    </div>
  );
}
