/**
 * 诊断与「改善来自哪里」(research round 2 §4):出场原因分布、R 直方图、MAE/MFE、成本占比、
 * 因子归因(alpha/beta 占比、残差回撤)、持有根数、多资产分币;父子实验逐段消融归因。
 * 文案一律按「观察 → 假设 → 验证」三段写:观察是能引用的数值,假设注明它只是可能原因,
 * 验证给出「只改一个条件、同窗口对照、再到预留窗口复核」的做法。不写确定性因果。
 */

import { useQuery } from '@tanstack/react-query';
import { researchApi } from '@/api/client';
import type { ResearchArmResult, ResearchRunSummary } from '@/api/research-types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { armColor, armLabel } from '@/components/research-workbench/arm-chart';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

const REASON_LABEL: Record<string, string> = tmap({ stop: '止损', target: '止盈', agent_exit: '代理退出', agent_reduce: '代理减仓', horizon: '持有期到', trail: '追踪止损', trend_break: '趋势翻转', structure: '结构位', breakeven: '保本', time_stop: '时间止损' });
const GATE_LABEL: Record<string, string> = tmap({ min_rr: '结构没空间', stop_too_tight: '止损太窄', no_target: '无止盈来源', risk_cap: '单笔风险超限', stop_side: '方向错误' });
// 拦下的原因各给一种红/橙,堆叠条里按同一顺序排
const GATE_TONE: Record<string, string> = { min_rr: 'bg-down', stop_too_tight: 'bg-down/70', no_target: 'bg-warn', risk_cap: 'bg-warn/70', stop_side: 'bg-muted-foreground/60' };
const SECTION_LABEL: Record<string, string> = tmap({ signal: '信号', entry: '入场', risk: '风险/止损', exit: '出场', sizing: '仓位', regime: '趋势环境', screen: '筛选', universe: '资产池' });

const num = (v: number | null | undefined, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: number | null | undefined, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const signedPct = (v: number | null | undefined, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '—');
const dec = (v: string | number | null | undefined, d = 2): string => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : String(v);
};
const tone = (v: number | string | null | undefined): string => {
  const n = Number(v);
  return !Number.isFinite(n) || n === 0 ? '' : n > 0 ? 'text-up' : 'text-down';
};

function Card({ title, hint, children, foot, warn }: { title: string; hint?: string; children: React.ReactNode; foot?: string; warn?: string | null }) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
        <span className="kicker text-foreground/85">{title}</span>
        {hint ? <span className="text-[10.5px] text-muted-foreground">{hint}</span> : null}
      </div>
      {warn ? <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-[10.5px] text-warn">{warn}</div> : null}
      {children}
      {foot ? <div className="border-t px-3 py-1 text-[10.5px] text-muted-foreground">{foot}</div> : null}
    </div>
  );
}

/**
 * 盈亏比硬门(先放置再判定):候选出现时代码先放止损止盈,再判盈亏比。
 * 一条横向堆叠条把「通过 / 拦下(按原因)」摊开,放宽与补止盈的数量是通过里的子集,写在下面一行。
 */
function GateCard({ s }: { s: NonNullable<NonNullable<ResearchArmResult['diagnostics']>['gate_stats']> }) {
  const blocked = Object.entries(s.blocked_by).filter(([, v]) => v > 0);
  const blockedTotal = blocked.reduce((a, [, v]) => a + v, 0);
  const passed = s.passed ?? Math.max(0, s.evaluated - blockedTotal);
  const total = Math.max(1, passed + blockedTotal);
  const adj = s.adjusted;
  const segs = [{ key: 'passed', label: t('通过'), value: passed, cls: 'bg-up' }, ...blocked.map(([k, v]) => ({ key: k, label: GATE_LABEL[k] ?? k, value: v, cls: GATE_TONE[k] ?? 'bg-down/50' }))];
  return (
    <Card title={t('盈亏比硬门(先放置再判定)')} hint={t('{n} 个候选', { n: s.evaluated })} foot={t('被拦的候选模型看不到也改不了;回测与实盘同一份代码。')}>
      <div className="space-y-1.5 px-3 py-2">
        <div className="flex h-2.5 w-full overflow-hidden rounded-sm bg-muted">
          {segs
            .filter((x) => x.value > 0)
            .map((x) => (
              <div key={x.key} className={cn('h-full', x.cls)} style={{ width: `${(x.value / total) * 100}%` }} title={`${x.label} ${x.value}`} />
            ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          {segs
            .filter((x) => x.value > 0)
            .map((x) => (
              <span key={x.key} className="inline-flex items-center gap-1">
                <i className={cn('inline-block size-2 shrink-0 rounded-[2px]', x.cls)} />
                <span className={x.key === 'passed' ? 'font-medium' : 'text-muted-foreground'}>{x.label}</span>
                <span className="num">{x.value}</span>
              </span>
            ))}
          {!blockedTotal && !passed ? <span className="text-muted-foreground">{t('没有候选')}</span> : null}
        </div>
        {adj && (adj.stop_widened || adj.target_fallback) ? (
          <div className="text-[10.5px] text-muted-foreground">{t('其中 {n} 个止损放宽到成本下限,{m} 个用固定倍数补止盈', { n: adj.stop_widened, m: adj.target_fallback })}</div>
        ) : null}
      </div>
    </Card>
  );
}

/** 从 trades 现算一份直方图与出场分布,后端没给 diagnostics 时兜底(老 run)。 */
function fallbackDiagnostics(arm: ResearchArmResult): NonNullable<ResearchArmResult['diagnostics']> {
  const bins = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 5];
  const counts = new Array(bins.length - 1).fill(0) as number[];
  const byReason = new Map<string, { count: number; rs: number[]; pnl: number }>();
  for (const tr of arm.trades) {
    if (typeof tr.net_r === 'number') {
      const i = bins.findIndex((b, k) => k < bins.length - 1 && tr.net_r! >= b && tr.net_r! < bins[k + 1]!);
      if (i >= 0) counts[i]!++;
    }
    const g = byReason.get(tr.reason) ?? { count: 0, rs: [], pnl: 0 };
    g.count++;
    if (typeof tr.net_r === 'number') g.rs.push(tr.net_r);
    g.pnl += Number(tr.net_pnl) || 0;
    byReason.set(tr.reason, g);
  }
  // 兜底只知道时间戳,不知道 bar 周期:按小时给,字段名沿用 holding_bars 但标签会写「小时」
  const holding = arm.trades.map((x) => (x.exit_at - x.entry_at) / 3_600_000).sort((a, b) => a - b);
  const holdingStats = holding.length ? { avg: holding.reduce((a, b) => a + b, 0) / holding.length, median: holding[Math.floor(holding.length / 2)]!, max: holding[holding.length - 1]! } : undefined;
  return {
    exit_reasons: [...byReason].map(([reason, g]) => ({ reason, count: g.count, avg_net_r: g.rs.length ? g.rs.reduce((a, b) => a + b, 0) / g.rs.length : null, net_pnl: g.pnl.toFixed(2) })),
    r_histogram: { bins, counts },
    cost_share: { fees: arm.metrics.fees, slippage_est: '—', gross_pnl: arm.trades.reduce((a, x) => a + (Number(x.gross_pnl) || 0), 0).toFixed(2), cost_over_gross_abs: null },
    holding_bars: holdingStats,
  };
}

export function DiagnosticsTab({ arms, run, primaryArm, onPrimary }: { arms: ResearchArmResult[]; run: ResearchRunSummary; primaryArm: string | null; onPrimary: (a: string) => void }) {
  const arm = arms.find((a) => a.arm === primaryArm) ?? arms[0];
  if (!arm) return <div className="p-6 text-[12px] text-muted-foreground">{t('没有结果')}</div>;
  const fromBackend = !!arm.diagnostics;
  const d = arm.diagnostics ?? fallbackDiagnostics(arm);
  const hist = d.r_histogram;
  const maxCount = hist ? Math.max(1, ...hist.counts) : 1;
  const totalTrades = d.exit_reasons?.reduce((a, x) => a + x.count, 0) ?? arm.trades.length;
  // 样本 < 10 笔:每张卡顶部先说清楚下面只是观察,不是结论
  const thin = arm.metrics.closed_trades < 10 ? t('样本 {n} 笔,以下只是观察不是结论。', { n: arm.metrics.closed_trades }) : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-4 py-1.5">
        {arms.map((a) => (
          <button key={a.arm} type="button" onClick={() => onPrimary(a.arm)} className={cn('flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] hover:bg-accent/60', arm.arm === a.arm && 'bg-accent')}>
            <i className="inline-block h-0.5 w-2.5" style={{ background: armColor(a.arm) }} />
            {armLabel(a.arm)}
          </button>
        ))}
        {!fromBackend ? <span className="ml-auto text-[10.5px] text-warn">{t('后端没给 diagnostics(老 run 或第二轮未就绪),以下由前端按交易表现算;MAE/MFE、因子归因不可得。')}</span> : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-2 gap-3 p-4 xl:grid-cols-3">
          <Card
            title={t('出场原因')}
            hint={t('各类退出的笔数与平均 R')}
            warn={thin}
            foot={t('观察:每类退出各占多少笔、平均 R 是多少。假设:某一类退出集中且平均 R 接近 -1,可能是入场噪音或退出距离太近,也可能只是这段行情如此。验证:只改这一条退出条件,同窗口对照,再到预留窗口复核。')}
          >
            <Table className="text-[11.5px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('原因')}</TableHead>
                  <TableHead className="text-right">{t('笔数')}</TableHead>
                  <TableHead className="text-right">{t('占比')}</TableHead>
                  <TableHead className="text-right">{t('平均 R')}</TableHead>
                  <TableHead className="text-right">{t('净盈亏')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(d.exit_reasons ?? []).map((x) => (
                  <TableRow key={x.reason}>
                    <TableCell>{REASON_LABEL[x.reason] ?? x.reason}</TableCell>
                    <TableCell className="num text-right">{x.count}</TableCell>
                    <TableCell className="num text-right text-muted-foreground">{totalTrades ? pct(x.count / totalTrades, 0) : '—'}</TableCell>
                    <TableCell className={cn('num text-right', tone(x.avg_net_r))}>{num(x.avg_net_r)}</TableCell>
                    <TableCell className={cn('num text-right', tone(x.net_pnl))}>{dec(x.net_pnl)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <Card
            title={t('R 分布')}
            hint={t('净 R,按笔')}
            warn={thin}
            foot={t('观察:每笔净 R 落在哪些区间。假设:两端计数很少,可能是规则截断了尾部,也可能只是样本太少。验证:同窗口比较放开/收紧单一退出条件后的分布,再看预留窗口。')}
          >
            {hist ? (
              <div className="px-3 pt-3 pb-1">
                <svg viewBox={`0 0 ${hist.counts.length * 28} 90`} className="h-28 w-full" preserveAspectRatio="none">
                  {hist.counts.map((c, i) => {
                    const h = (c / maxCount) * 70;
                    const lo = hist.bins[i]!;
                    const neg = lo < 0;
                    return (
                      <g key={i}>
                        <rect x={i * 28 + 4} y={72 - h} width={20} height={h} fill={neg ? 'var(--down)' : 'var(--up)'} opacity={0.85} />
                        <text x={i * 28 + 14} y={70 - h - 2} fontSize={8} textAnchor="middle" fill="currentColor">
                          {c || ''}
                        </text>
                        <text x={i * 28 + 14} y={84} fontSize={7} textAnchor="middle" fill="var(--muted-foreground)">
                          {lo}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            ) : (
              <div className="px-3 py-3 text-[11.5px] text-muted-foreground">—</div>
            )}
          </Card>
          <Card
            title={t('MAE / MFE')}
            hint={t('持仓期间最大浮亏 / 最大浮盈(相对初始风险)')}
            warn={thin}
            foot={t('观察:赢家与输家在持仓期间分别到过多少浮盈。假设:赢家 MFE 明显高于最终 R,可能退出偏早;部分亏损交易也曾有浮盈,保本或追踪可能有用。验证:同窗口比较有/无追踪退出;样本不足时不判断哪种更好。')}
          >
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-[11.5px]">
              <dt className="text-muted-foreground">{t('平均 MAE')}</dt>
              <dd className="num text-down">{num(d.mae_mfe?.avg_mae_r)}</dd>
              <dt className="text-muted-foreground">{t('平均 MFE')}</dt>
              <dd className="num text-up">{num(d.mae_mfe?.avg_mfe_r)}</dd>
              <dt className="text-muted-foreground">{t('赢家平均 MFE')}</dt>
              <dd className="num">{num(d.mae_mfe?.winners_avg_mfe_r)}</dd>
              <dt className="text-muted-foreground">{t('输家平均 MFE')}</dt>
              <dd className="num">{num(d.mae_mfe?.losers_avg_mfe_r)}</dd>
              <dt className="text-muted-foreground">{fromBackend ? t('持有根数 均/中/最大') : t('持有小时 均/中/最大')}</dt>
              <dd className="num">{d.holding_bars ? `${num(d.holding_bars.avg, 1)} / ${num(d.holding_bars.median, 1)} / ${num(d.holding_bars.max, 1)}` : '—'}</dd>
            </dl>
          </Card>
          <Card
            title={t('成本占比')}
            hint={t('费用 + 滑点 vs 毛利')}
            warn={thin}
            foot={t('观察:成本占毛利的比例。假设:成本高于正毛利会把净结果转负,但不等于扣费前没有优势。验证:同窗口比较不同费率假设,看净结果的符号是否翻转。')}
          >
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-[11.5px]">
              <dt className="text-muted-foreground">{t('毛盈亏')}</dt>
              <dd className={cn('num', tone(d.cost_share?.gross_pnl))}>{dec(d.cost_share?.gross_pnl)}</dd>
              <dt className="text-muted-foreground">{t('手续费')}</dt>
              <dd className="num">{dec(d.cost_share?.fees)}</dd>
              <dt className="text-muted-foreground">{t('滑点估计')}</dt>
              <dd className="num">{dec(d.cost_share?.slippage_est)}</dd>
              <dt className="text-muted-foreground">{t('成本 / |毛利|')}</dt>
              <dd className={cn('num', (d.cost_share?.cost_over_gross_abs ?? 0) > 1 ? 'text-down' : '')}>{d.cost_share?.cost_over_gross_abs === null || d.cost_share?.cost_over_gross_abs === undefined ? '—' : `${num(d.cost_share.cost_over_gross_abs)}×`}</dd>
              <dt className="text-muted-foreground">{t('净盈亏')}</dt>
              <dd className={cn('num', tone(arm.metrics.net_pnl))}>{dec(arm.metrics.net_pnl)}</dd>
            </dl>
          </Card>
          <Card
            title={t('因子归因')}
            hint={t('策略曲线对市场因子回归')}
            warn={thin}
            foot={t('观察:β、α 与残差部分的表现。假设:β 高而 α 占比低时,收益可能主要来自大盘方向。验证:换一段市场方向不同的窗口,看残差部分是否还在。')}
          >
            {d.factor && d.factor.status === 'ok' ? (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-[11.5px]">
                <dt className="text-muted-foreground">β</dt>
                <dd className="num">{num(d.factor.beta)}</dd>
                <dt className="text-muted-foreground">{t('α 年化')}</dt>
                <dd className={cn('num', tone(d.factor.alpha_annualized))}>{signedPct(d.factor.alpha_annualized)}</dd>
                <dt className="text-muted-foreground">R²</dt>
                <dd className="num">{num(d.factor.r2)}</dd>
                <dt className="text-muted-foreground">{t('α / β 占比')}</dt>
                <dd className="num">
                  <span className="inline-flex items-center gap-1">
                    <i className="inline-block h-1.5 w-16 overflow-hidden rounded bg-muted">
                      <i className="block h-full bg-primary" style={{ width: `${Math.max(0, Math.min(1, d.factor.alpha_share ?? 0)) * 100}%` }} />
                    </i>
                    {pct(d.factor.alpha_share, 0)} / {pct(d.factor.beta_share, 0)}
                  </span>
                </dd>
                <dt className="text-muted-foreground">{t('残差最大回撤')}</dt>
                <dd className="num text-down">-{pct(d.factor.residual_max_dd)}</dd>
                <dt className="text-muted-foreground">{t('残差 Sharpe')}</dt>
                <dd className={cn('num', tone(d.factor.residual_sharpe))}>{num(d.factor.residual_sharpe)}</dd>
              </dl>
            ) : (
              <div className="px-3 py-3 text-[11.5px] text-muted-foreground">{d.factor?.status === 'insufficient' ? t('样本不足以回归') : t('不可得')}</div>
            )}
          </Card>
          {d.gate_stats ? <GateCard s={d.gate_stats} /> : null}
          {arm.by_symbol?.length ? (
            <Card title={t('分币贡献')} hint={t('多资产')}>
              <Table className="text-[11.5px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('币')}</TableHead>
                    <TableHead className="text-right">{t('平仓')}</TableHead>
                    <TableHead className="text-right">{t('胜率')}</TableHead>
                    <TableHead className="text-right">{t('平均 R')}</TableHead>
                    <TableHead className="text-right">{t('净盈亏')}</TableHead>
                    <TableHead className="text-right">{t('贡献')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {arm.by_symbol.map((s) => (
                    <TableRow key={s.symbol}>
                      <TableCell className="font-medium">{s.symbol}</TableCell>
                      <TableCell className="num text-right">{s.closed_trades}</TableCell>
                      <TableCell className="num text-right">{pct(s.win_rate, 0)}</TableCell>
                      <TableCell className={cn('num text-right', tone(s.avg_net_r))}>{num(s.avg_net_r)}</TableCell>
                      <TableCell className={cn('num text-right', tone(s.net_pnl))}>{dec(s.net_pnl)}</TableCell>
                      <TableCell className="num text-right">{pct(s.contribution, 0)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          ) : null}
          <div className="col-span-full">
            <AttributionCard run={run} />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

/** 父子实验逐段消融:child 的每一段改动单独套到 parent 上跑 A 臂,回答「改善来自哪里」。 */
export function AttributionCard({ run }: { run: ResearchRunSummary }) {
  const parentId = run.manifest.request.parent_run_id;
  const q = useQuery({ queryKey: ['research', 'attribution', run.id], queryFn: () => researchApi.attribution(run.id), enabled: !!parentId && run.status === 'completed', retry: false });
  if (!parentId) return <Card title={t('改善来自哪里')} hint={t('父子实验逐段消融')}><div className="px-3 py-3 text-[11.5px] text-muted-foreground">{t('这不是候选实验(没有父实验),没有可归因的改动。从「下一次实验」改一到两个参数再跑,这里会按段拆出各自贡献。')}</div></Card>;
  const a = q.data;
  return (
    <Card title={t('改善来自哪里')} hint={t('父 {p} → 子 {c}', { p: parentId.slice(0, 8), c: run.id.slice(0, 8) })} foot={a?.note ?? t('逐段消融是探索性归因,段间有交互;不是因果证明。')}>
      {q.isLoading ? <div className="px-3 py-3 text-[11.5px] text-muted-foreground">{t('逐段回放中(纯规则,零模型调用)…')}</div> : null}
      {q.error ? <div className="px-3 py-3 text-[11.5px] text-muted-foreground">{/404|not_found|不存在/.test((q.error as Error).message) ? t('后端还没有归因接口(后端交付中)') : (q.error as Error).message}</div> : null}
      {a ? (
        <div className="px-3 py-2">
          <div className="mb-2 flex items-center gap-4 text-[11.5px]">
            <span>
              {t('父')} <span className={cn('num', tone(a.base_net_return))}>{signedPct(a.base_net_return)}</span>
            </span>
            <span>
              {t('子')} <span className={cn('num', tone(a.child_net_return))}>{signedPct(a.child_net_return)}</span>
            </span>
            <span>
              {t('交互项')} <span className="num">{signedPct(a.interaction)}</span>
            </span>
          </div>
          <div className="space-y-1">
            {a.components.filter((c) => c.changed).map((c) => {
              const span = Math.max(0.0001, ...a.components.map((x) => Math.abs(x.delta ?? 0)));
              const w = Math.min(100, (Math.abs(c.delta ?? 0) / span) * 100);
              return (
                <div key={c.section} className="grid grid-cols-[110px_1fr_80px] items-center gap-2 text-[11.5px]">
                  <span>{SECTION_LABEL[c.section] ?? c.section}</span>
                  <div className="relative h-2 overflow-hidden rounded bg-muted">
                    <div className={cn('absolute top-0 h-full', (c.delta ?? 0) >= 0 ? 'left-1/2 bg-up' : 'right-1/2 bg-down')} style={{ width: `${w / 2}%` }} />
                    <div className="absolute top-0 left-1/2 h-full w-px bg-border" />
                  </div>
                  <span className={cn('num text-right', tone(c.delta))}>{signedPct(c.delta)}</span>
                </div>
              );
            })}
            {!a.components.some((c) => c.changed) ? <div className="text-[11.5px] text-muted-foreground">{t('子实验没有改任何段。')}</div> : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
