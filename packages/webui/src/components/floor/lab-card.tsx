/**
 * 楼层左栏:选中 LAB 时的策略实验面板、选中 HELM 时的值班简报面板(gateway c19646d,两者零模型)。
 * 实验结果是「机械前瞻期望」不是策略成绩——文案不写「已验证」,只写「机械期望」。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, researchApi } from '@/api/client';
import { useLabImproveJobs } from '@/api/evolution';
import type { CaptainBriefResponse, ExperimentResult, LabExperimentsResponse } from '@/api/types';
import { fx, relativeTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { RISK_LEVEL_COLOR, RISK_LEVEL_LABEL } from './risk-card';

function r(v: number | null | undefined, d = 2): string {
  return v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
}

export function LabPanel({ data, now }: { data: LabExperimentsResponse | null | undefined; now: number }) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: api.labRun,
    onSuccess: () => {
      toast.info(t('实验交上去了,几十秒出结果(进度看楼层 LAB 桌)'));
      void qc.invalidateQueries({ queryKey: ['lab'] });
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e: Error) => toast.warning(t('没跑:{msg}', { msg: e.message })),
  });
  if (!data) return (
    <div className="of-panel p-3 text-[10px] text-[var(--of-ink-dim)]">
      {t('实验接口还没就绪。')}
      <LabOutputs now={now} />
    </div>
  );
  const latest = data.experiments[0];
  const res = (latest?.result ?? null) as ExperimentResult | null;
  const d = data.decision;
  return (
    <div className="of-panel p-3">
      <div className="flex items-center">
        <span className="of-kicker">{t('策略实验')}</span>
        <span className="ml-auto text-[10px]" style={{ color: data.running ? 'var(--of-accent)' : 'var(--of-ink-dim)' }}>
          {data.running ? t('在跑') : d.last_at ? t('上次 {t}', { t: relativeTime(d.last_at, now) }) : t('没跑过')}
        </span>
      </div>
      <div className="mt-1 text-[10px] leading-3.5 text-[var(--of-ink-dim)]">
        {d.reason}
        {d.new_closed ? ` · ${t('新平仓 {n} 笔', { n: d.new_closed })}` : ''}
      </div>
      <div className="mt-1 flex gap-1">
        <button type="button" className="border border-[var(--of-accent)] px-1.5 py-0.5 text-[10px] text-[var(--of-accent)] hover:bg-[var(--of-panel-2)] disabled:cursor-not-allowed disabled:border-[var(--of-line)] disabled:text-[var(--of-ink-faint)]" disabled={!d.run || data.running || run.isPending} title={d.run ? t('纯代码机械前瞻,不调模型;同一份 manifest 24 小时内直接返回上一次') : d.reason} onClick={() => run.mutate()}>
          {t('跑一轮机械期望')}
        </button>
        <a className="border border-[var(--of-line)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--of-panel-2)]" href="#my-strategies">
          {t('去我的策略')}
        </a>
      </div>
      <LabOutputs now={now} />
      {res ? (
        <>
          <div className="mt-2 of-kicker">{t('最近一轮 · 机械期望(不是策略成绩)')}</div>
          <table className="num mt-1 w-full text-[9.5px]">
            <thead className="text-[var(--of-ink-faint)]">
              <tr>
                <th className="text-left font-normal">{t('策略')}</th>
                <th className="text-right font-normal">{t('样本')}</th>
                <th className="text-right font-normal">{t('胜率')}</th>
                <th className="text-right font-normal">{t('期望 R')}</th>
                <th className="text-right font-normal">{t('合计 R')}</th>
              </tr>
            </thead>
            <tbody>
              {res.by_strategy.map((b) => (
                <tr key={`${b.strategy_id}@${b.version}`}>
                  <td className="truncate pr-1" title={t('{n} 个币 · setups {s}', { n: b.symbols.length, s: b.setups })}>
                    {b.strategy_id}@{b.version}
                  </td>
                  <td className="text-right">{b.n}</td>
                  <td className="text-right">{b.n ? `${Math.round(b.win_rate * 100)}%` : '—'}</td>
                  <td className="text-right" style={{ color: b.n ? (b.expectancy_r >= 0 ? 'var(--of-accent)' : 'var(--of-danger)') : undefined }}>
                    {b.n ? r(b.expectancy_r) : '—'}
                  </td>
                  <td className="text-right">{b.n ? r(b.total_r, 1) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {res.unmeasured?.length ? (
            <div className="mt-1 text-[9px] leading-3 text-[var(--of-ink-dim)]">
              <span className="text-[var(--of-warn)]">{t('量不出')}</span>{t('(funnel 不是这类结构,这版不给数字):')}
              {res.unmeasured.map((u) => (
                <div key={`${u.strategy_id}@${u.version}`} className="pl-2">
                  {u.strategy_id}@{u.version} · {u.reason}
                </div>
              ))}
            </div>
          ) : null}
          {res.note ? <div className="mt-1 text-[9px] leading-3 text-[var(--of-ink-faint)]">{res.note}</div> : null}
          {res.errors?.length ? <div className="mt-1 text-[9px] text-[var(--of-danger)]">{t('{n} 个格子出错', { n: res.errors.length })}</div> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * 2026-09-23 进化:LAB 最近的研究 / 回测 / 改进环产出各一行(复用 ['research','runs'] 缓存;回测与改进环只拉 3 条)。
 * 拉不到的那一行显示「—」,不挡住上面的机械期望面板。
 */
function LabOutputs({ now }: { now: number }) {
  const runsQ = useQuery({ queryKey: ['research', 'runs'], queryFn: researchApi.runs, refetchInterval: 120_000, retry: false });
  const btQ = useQuery({ queryKey: ['research', 'backtests', 'floor', 3], queryFn: () => researchApi.backtests({ limit: 3 }), refetchInterval: 120_000, retry: false });
  const impQ = useLabImproveJobs(3);
  const run = runsQ.data?.items?.[0];
  const bt = btQ.data?.reports?.[0];
  const imp = impQ.data?.[0];
  const runLabel = run ? (run.manifest?.request?.strategy_ir?.label ?? run.manifest?.source_strategy?.name ?? run.id.slice(0, 8)) : null;
  const rows: { k: string; v: string | null; sub: string | null; at: number | null; href: string }[] = [
    { k: t('研究'), v: runLabel, sub: run ? run.status : null, at: run?.updated_at ?? null, href: run ? `#research?run=${encodeURIComponent(run.id)}` : '#research' },
    { k: t('回测'), v: bt?.title ?? null, sub: bt ? `${bt.score?.value ?? '—'} · ${bt.score?.label ?? ''}` : null, at: bt?.created_at ?? null, href: bt ? `#backtest?id=${encodeURIComponent(bt.id)}` : '#my-strategies' },
    { k: t('改进环'), v: imp?.label ?? null, sub: imp?.summary ?? imp?.status ?? null, at: imp?.updated_at ?? null, href: imp?.strategy_id ? `#my-strategies?id=${encodeURIComponent(imp.strategy_id)}` : '#my-strategies' },
  ];
  return (
    <div className="mt-2 border-t border-[var(--of-line)] pt-1.5">
      <div className="of-kicker">{t('最近产出')}</div>
      <ul className="mt-0.5 space-y-0.5 text-[9.5px] leading-3.5">
        {rows.map((r) => (
          <li key={r.k} className="flex min-w-0 items-baseline gap-1">
            <span className="w-9 shrink-0 text-[var(--of-ink-faint)]">{r.k}</span>
            {r.v ? (
              <a href={r.href} className="min-w-0 flex-1 truncate text-[var(--of-ink)] hover:underline" title={r.sub ? `${r.v}\n${r.sub}` : r.v}>
                {r.v}
                {r.sub ? <span className="text-[var(--of-ink-dim)]"> · {r.sub}</span> : null}
              </a>
            ) : (
              <span className="flex-1 text-[var(--of-ink-faint)]">—</span>
            )}
            {r.at ? <span className="shrink-0 text-[var(--of-ink-faint)]">{relativeTime(r.at, now)}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const ROLE_SHORT: Record<string, string> = { gate_captain: 'HELM', radar: 'RADAR', thread_manager: 'THREAD', strategy_lab: 'LAB', portfolio_manager: 'BOOK', risk_sentinel: 'SENTINEL', reviewer: 'AUDIT', executor: 'EXEC', asp_agent: 'MARKET' };

export function CaptainBriefPanel({ data, now }: { data: CaptainBriefResponse | null | undefined; now: number }) {
  const qc = useQueryClient();
  const make = useMutation({
    mutationFn: api.captainBriefNow,
    onSuccess: () => {
      toast.success(t('简报出好了'));
      void qc.invalidateQueries({ queryKey: ['captain'] });
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!data) return <div className="of-panel p-3 text-[10px] text-[var(--of-ink-dim)]">{t('简报接口还没就绪。')}</div>;
  const b = data.brief;
  return (
    <div className="of-panel p-3">
      <div className="flex items-center">
        <span className="of-kicker">{t('值班简报 · 24h')}</span>
        <span className="ml-auto text-[10px]" style={{ color: data.due ? 'var(--of-warn)' : 'var(--of-ink-dim)' }}>
          {data.due ? t('到点了还没出') : b ? relativeTime(b.to, now) : t('还没有')}
        </span>
      </div>
      {b ? (
        <>
          <div className="mt-1 text-[10px] leading-4 text-[var(--of-ink)]">{b.headline}</div>
          <div className="mt-2 grid grid-cols-3 gap-px bg-[var(--of-line)] text-center text-[9px]">
            <Cell k={t('角色任务')} v={String(Object.values(b.runs_by_role).reduce((a, x) => a + x.runs, 0))} sub={`¥${fx(b.total_cost_cny, 3)}`} />
            <Cell k={t('待读')} v={String(b.pending_handoffs.count)} sub={Object.entries(b.pending_handoffs.by_from).map(([k, v]) => `${ROLE_SHORT[k] ?? k} ${v}`).join(' ') || '—'} />
            <Cell k={t('风控')} v={RISK_LEVEL_LABEL[b.risk.level]} sub={`${t('{n} 条告警', { n: b.risk.open })}${b.risk.blocks_new_risk ? ` · ${t('停新增')}` : ''}`} color={RISK_LEVEL_COLOR[b.risk.level]} />
            <Cell k={t('平仓')} v={String(b.trades.closed)} sub={t('{w} 胜 {l} 负 {r}R', { w: b.trades.wins, l: b.trades.losses, r: r(b.trades.total_r, 1) })} />
            <Cell k={t('总敞口')} v={fx(b.portfolio?.gross_ratio, 2, '×')} sub={b.portfolio ? t('{n} 簇 · {q}', { n: b.portfolio.clusters, q: b.portfolio.quality }) : t('无快照')} />
            <Cell k={t('未保护')} v={String(b.trades.unprotected)} sub={b.trades.unprotected ? t('要处理') : '—'} color={b.trades.unprotected ? 'var(--of-danger)' : undefined} />
          </div>
          {b.risk.titles.length ? <div className="mt-1 text-[9px] leading-3 text-[var(--of-danger)]">{b.risk.titles.join(';')}</div> : null}
          <div className="mt-1 text-[9px] text-[var(--of-ink-faint)]">
            {Object.entries(b.runs_by_role)
              .map(([k, v]) => `${ROLE_SHORT[k] ?? k} ${v.done}/${v.runs}${v.failed ? ` ${t('败 {n}', { n: v.failed })}` : ''}`)
              .join(' · ')}
          </div>
        </>
      ) : (
        <div className="mt-1 text-[10px] text-[var(--of-ink-dim)]">{t('还没出过简报。')}</div>
      )}
      <button type="button" className="mt-2 border border-[var(--of-line)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--of-panel-2)]" disabled={make.isPending} onClick={() => make.mutate()}>
        {t('立即出一份(不调模型)')}
      </button>
    </div>
  );
}

function Cell({ k, v, sub, color }: { k: string; v: string; sub: string; color?: string }) {
  return (
    <div className="bg-[var(--of-panel)] px-1 py-1.5">
      <div className="of-kicker">{k}</div>
      <div className="num text-[12px] font-bold" style={{ color }}>
        {v}
      </div>
      <div className="truncate text-[8.5px] text-[var(--of-ink-faint)]" title={sub}>
        {sub}
      </div>
    </div>
  );
}
