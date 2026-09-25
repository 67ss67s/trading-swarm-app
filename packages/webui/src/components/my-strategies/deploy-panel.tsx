/**
 * 策略详情的「部署」页签(docs/research/strategy-merge-plan-2026-09-23.md,契约 §9.47):
 *   1. 部署状态(只读):是否已下发到实盘(lab_strategy_id)、部署模式、是否在票池、实盘/影子成绩,
 *      读 GET /api/strategies 与 /api/strategies/allocator;操作一律深链到实盘部署台(#strategies?id=)。
 *   2. 规则拆分预览:GET /api/research/strategies/:id/binding 把这版 IR 编译成 StrategyBinding,按六个角色切片,
 *      每条规则标明执行者(代码 / 模型);编译不支持的语义列在 unmapped。
 * 本页签不写任何实盘接口。react-query key:['research','my-strategy-binding',id,version] / ['strategies'] / ['allocator']。
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Bot, Cpu, TriangleAlert } from 'lucide-react';
import type { BindingRoleSlice, BindingUnmapped, ResearchStrategy, StrategyBinding } from '@trading-swarm/contracts';
import { researchApi } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { DEPLOY_MODE_LABEL, deployDeskHash, isLiveDeployed, type Deployment } from './deploy-model';
import { runOf, useStrategyRuns } from './run-panel';
import { errText, go } from './use-strategy-actions';

const ROLE_ORDER: BindingRoleSlice['role'][] = ['radar', 'judge', 'geometry', 'risk', 'holding', 'execution'];
const EXECUTOR_LABEL = tmap({ code: '代码', model: '模型' });
const SOURCE_LABEL = tmap({ compiler: '编译器', import: '导入译文' });

function ExecutorChip({ executor }: { executor: 'code' | 'model' }) {
  return (
    <span
      data-executor={executor}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10.5px] font-medium [&_svg]:size-3',
        executor === 'model' ? 'border-warn/40 bg-warn/10 text-warn' : 'border-primary/30 bg-primary/10 text-primary',
      )}
    >
      {executor === 'model' ? <Bot /> : <Cpu />}
      {EXECUTOR_LABEL[executor]}
    </span>
  );
}

/** 一个角色切片:标题 + 摘要 + 规则(每条带执行者)。独立导出给测试。 */
export function RoleSliceCard({ slice }: { slice: BindingRoleSlice }) {
  const model = slice.rules.some((r) => r.executor === 'model');
  return (
    <section data-role={slice.role} className={cn('flex flex-col gap-2 rounded-xl border bg-card p-4', model ? 'border-warn/40' : 'border-border')}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{t(slice.title)}</h3>
        <ExecutorChip executor={model ? 'model' : 'code'} />
      </div>
      <p className="text-[11.5px] text-muted-foreground">{slice.summary}</p>
      <ul className="flex flex-col gap-1.5">
        {slice.rules.map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed">
            <ExecutorChip executor={r.executor} />
            <span className="min-w-0 break-words">
              {r.text}
              {r.ref ? <span className="num ml-1 text-[10.5px] text-muted-foreground/70">{r.ref}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function UnmappedList({ items }: { items: BindingUnmapped[] }) {
  if (!items.length) return <p className="text-[12px] text-muted-foreground">{t('没有未映射的语义:IR 里的每条规则实盘都能执行。')}</p>;
  const sorted = [...items].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1));
  return (
    <ul className="flex flex-col gap-1.5">
      {sorted.map((u, i) => (
        <li key={`${u.code}-${i}`} data-severity={u.severity} className="flex items-start gap-2 text-[12px] leading-relaxed">
          <span className={cn('inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-[10.5px] font-semibold', u.severity === 'block' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-warn/40 bg-warn/10 text-warn')}>
            {u.severity === 'block' ? t('不能下发') : t('有损')}
          </span>
          <span className="min-w-0 break-words">
            {u.message}
            <span className="num ml-1 text-[10.5px] text-muted-foreground/70">
              {SOURCE_LABEL[u.source]} · {u.code}
              {u.path ? ` · ${u.path}` : ''}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const fmtR = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R` : '—');
const fmtPct = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—');

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className="num truncate text-[13px] font-semibold">{value}</div>
      {hint ? <div className="truncate text-[10.5px] text-muted-foreground/80" title={hint}>{hint}</div> : null}
    </div>
  );
}

/** 部署状态卡(只读)。独立导出给测试。 */
export function DeployStatusCard({ strategy, deployment, registryError }: { strategy: Pick<ResearchStrategy, 'lab_strategy_id' | 'origin'>; deployment: Deployment | null; registryError?: string | null }) {
  const lab = deployment?.lab_id ?? null;
  return (
    <section data-deployed={deployment?.found ? 'yes' : 'no'} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="kicker text-muted-foreground">{t('部署状态')}</h3>
        <Button size="sm" variant="outline" onClick={() => go(deployDeskHash(lab))}>
          <ArrowUpRight />
          {t('去实盘部署台操作')}
        </Button>
      </div>
      {registryError ? <p className="text-[12px] text-destructive">{t('实盘注册表读取失败')}:{registryError}</p> : null}
      {!strategy.lab_strategy_id ? (
        <p className="text-[12.5px] text-muted-foreground">{t('还没有下发到实盘。下发(apply)属于实盘侧,本轮只做下面的编译预览,不写实盘注册表。')}</p>
      ) : !deployment?.found ? (
        <p className="text-[12.5px] text-muted-foreground">{t('关联的实盘策略 {id} 不在实盘注册表里(可能已被删除或还没同步)。', { id: strategy.lab_strategy_id })}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('实盘策略')} value={deployment.lab_id} hint={deployment.spec ? `${deployment.spec.name} · v${deployment.spec.version} · ${deployment.spec.status_label}` : undefined} />
            <Stat label={t('部署模式')} value={<span data-mode={deployment.mode}>{DEPLOY_MODE_LABEL[deployment.mode]}</span>} hint={deployment.older_version_runs ? t('头版本 v{v} 未到模拟,实盘跑的是更早的 ≥ 模拟版本', { v: deployment.spec?.version ?? '?' }) : undefined} />
            <Stat label={t('票池')} value={deployment.in_pool ? t('在票池') : t('不在票池')} hint={deployment.candidate ? `allocator:${deployment.candidate.reason}` : undefined} />
            <Stat label={t('列表口径')} value={isLiveDeployed(deployment) ? t('算「实盘」') : t('不算「实盘」')} />
            <Stat label={t('实盘成绩')} value={deployment.live_trades ? `${deployment.live_trades} ${t('笔')} · ${fmtR(deployment.live_expectancy_r)}` : t('暂无')} hint={deployment.live_trades ? `${t('胜率')} ${fmtPct(deployment.live_win_rate)}` : undefined} />
            <Stat label={t('影子成绩')} value={deployment.shadow?.n ? `${deployment.shadow.n} ${t('笔')} · ${fmtR(deployment.shadow.expectancy_r)}` : t('暂无')} hint={deployment.shadow?.n ? `${t('累计')} ${fmtR(deployment.shadow.total_r)}` : undefined} />
          </div>
          {strategy.origin.source === 'import' ? (
            <p className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-[11.5px] text-muted-foreground">
              {t('这条是内置策略的研究台译文。实盘现在跑的仍是旧的文本规则版本(实盘部署台里的那条),不是下面编译出的绑定;改由绑定驱动要等实盘侧接 apply。')}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function BindingHeader({ b }: { b: StrategyBinding }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
      <span className={cn('inline-flex h-5.5 items-center rounded-full border px-2 text-[11px] font-semibold', b.deployable ? 'border-up/40 bg-up/10 text-up' : 'border-destructive/40 bg-destructive/10 text-destructive')}>
        {b.deployable ? t('可下发') : t('编译失败,不能下发')}
      </span>
      <span className="num">v{b.version} · {b.content_hash.slice(0, 10)}</span>
      <span>
        {b.timeframe.toUpperCase()}
        {b.confirm_timeframe ? ` / ${t('确认')} ${b.confirm_timeframe.toUpperCase()}` : ''} · {b.horizon ?? 'scalp'}
      </span>
      <span>
        {b.market === 'perp' ? t('永续') : t('现货')} · {b.direction} · {b.risk.leverage}x
      </span>
      <span>{b.libs.order_gate === 'structure' ? t('结构口径') : t('旧口径')} · {b.libs.strategy_spec}</span>
    </div>
  );
}

export function BindingPreview({ binding, unmapped }: { binding: StrategyBinding | null; unmapped: BindingUnmapped[] }) {
  if (!binding) {
    return (
      <section className="flex flex-col gap-3 rounded-xl border border-dashed border-border bg-card/40 p-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold [&_svg]:size-4">
          <TriangleAlert className="text-warn" />
          {t('规则未编码:没有可编译的 IR')}
        </div>
        <UnmappedList items={unmapped} />
      </section>
    );
  }
  const slices = ROLE_ORDER.map((r) => binding.roles.find((s) => s.role === r)).filter((s): s is BindingRoleSlice => !!s);
  return (
    <div className="flex flex-col gap-3">
      <BindingHeader b={binding} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {slices.map((s) => (
          <RoleSliceCard key={s.role} slice={s} />
        ))}
      </div>
      <section className="rounded-xl border border-border bg-card p-4">
        <h3 className="kicker mb-2 text-muted-foreground">{t('未映射 / 有损的语义')}</h3>
        <UnmappedList items={binding.unmapped} />
      </section>
    </div>
  );
}

export function DeployPanel({ strategy, version }: { strategy: ResearchStrategy; version: number | null }) {
  const bindingQ = useQuery({
    queryKey: ['research', 'my-strategy-binding', strategy.id, version],
    queryFn: () => researchApi.myStrategyBinding(strategy.id, version ?? undefined),
    retry: false,
  });
  const runsQ = useStrategyRuns();
  const run = runOf(runsQ.data?.runs, strategy.id);
  return (
    <div className="flex flex-col gap-4">
      {run ? null : (
        <p className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-3 text-[12.5px] text-muted-foreground">
          {t('还没在运行。点右上「运行策略」,运行器会按下面这套规则每根 K 线收盘扫币、下单或发信号。')}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-semibold">{t('它会怎么跑')}</h2>
        <p className="text-[12px] text-muted-foreground">{t('这版规则(IR)编译后,每个角色拿到哪几条规则、由代码还是模型执行。「Agent 把关」模式下模型只决定做不做;其余模式全程代码。')}</p>
      </div>
      {bindingQ.isPending ? (
        <Skeleton className="h-[320px] rounded-xl" />
      ) : bindingQ.isError ? (
        <p className="text-[12.5px] text-destructive">{t('编译失败')}:{errText(bindingQ.error)}</p>
      ) : (
        <BindingPreview binding={bindingQ.data.binding} unmapped={bindingQ.data.unmapped} />
      )}
    </div>
  );
}
