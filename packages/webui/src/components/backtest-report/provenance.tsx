/**
 * 数据溯源:窗口起止(醒目)、每个资产的数据源 / 实际起止 / 根数 / 周期、执行参数、引擎版本、告警。
 * 实际数据起点比窗口晚(或终点早)超过 2 根 K 线时单独标黄 —— 用户之前被「只看到 2020–2022」坑过。
 */
import { CalendarRange, TriangleAlert } from 'lucide-react';
import type { BacktestReport } from '@trade-gate/contracts';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ASSET_STATUS_LABEL, pctPlain, spanLabel, usdPlain, ymd, ymdhm } from './format';

function tfMs(tf: string): number {
  const n = Number(tf.slice(0, -1));
  const u = tf.slice(-1);
  const unit = u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : u === 'd' ? 86_400_000 : u === 'w' ? 7 * 86_400_000 : 86_400_000;
  return (Number.isFinite(n) && n > 0 ? n : 1) * unit;
}

/** 顶部的窗口徽章:起止 + 跨度 + 周期,永远显示 */
export function WindowBadge({ report, className }: { report: BacktestReport; className?: string }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border border-primary/30 bg-primary/8 px-2 py-0.5 text-[12px] text-foreground', className)} data-testid="window-badge">
      <CalendarRange className="size-3.5 text-primary" />
      <span className="num font-semibold">
        {ymd(report.window.from_ms)} → {ymd(report.window.to_ms)}
      </span>
      <span className="text-muted-foreground">
        · {spanLabel(report.window.from_ms, report.window.to_ms)} · {report.timeframe}
      </span>
    </span>
  );
}

export function coverageGaps(report: BacktestReport): { key: string; label: string; first: number; last: number }[] {
  const tol = tfMs(report.timeframe) * 2;
  const out: { key: string; label: string; first: number; last: number }[] = [];
  for (const a of report.assets) {
    if (!a.data) continue;
    if (a.data.first_at - report.window.from_ms > tol || report.window.to_ms - a.data.last_at > tol) out.push({ key: a.key, label: a.label, first: a.data.first_at, last: a.data.last_at });
  }
  return out;
}

export function Provenance({ report }: { report: BacktestReport }) {
  const ex = report.execution;
  const gaps = coverageGaps(report);
  return (
    <footer className="space-y-3 border-t border-border/70 pt-4 text-[11.5px] text-muted-foreground" data-testid="provenance">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{t('数据溯源')}</span>
        <WindowBadge report={report} />
      </div>
      {gaps.length ? (
        <div className="flex items-start gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-warn">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <div>
            {gaps.map((g) => (
              <div key={g.key}>{t('{label} 实际数据只覆盖 {from} → {to},短于回测窗口', { label: g.label, from: ymd(g.first), to: ymd(g.last) })}</div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-[11.5px]">
          <thead>
            <tr className="text-left text-[10.5px]">
              <th className="py-1 pr-3 font-medium">{t('资产')}</th>
              <th className="py-1 pr-3 font-medium">{t('数据源')}</th>
              <th className="py-1 pr-3 font-medium">{t('实际起止')}</th>
              <th className="py-1 pr-3 font-medium">{t('交易窗口')}</th>
              <th className="py-1 pr-3 text-right font-medium">{t('预热')}</th>
              <th className="py-1 pr-3 text-right font-medium">{t('根数')}</th>
              <th className="py-1 pr-3 font-medium">{t('周期')}</th>
              <th className="py-1 font-medium">{t('状态')}</th>
            </tr>
          </thead>
          <tbody>
            {report.assets.map((a) => (
              <tr key={a.key} className="border-t border-border/40">
                <td className="py-1 pr-3 text-foreground" title={a.engine_version ? `${t('执行器')} ${a.engine_version}` : undefined}>
                  {a.label}
                  <span className="ml-1 text-[10.5px]">{a.symbols.join(' + ')}</span>
                </td>
                <td className="py-1 pr-3">{a.data?.source ?? '—'}</td>
                <td className="num py-1 pr-3 text-foreground/90" title={a.data?.dataset_id ? `dataset ${a.data.dataset_id}${a.data.snapshot_id ? ` · snapshot ${a.data.snapshot_id}` : ''}` : undefined}>
                  {a.data ? `${ymd(a.data.first_at)} → ${ymd(a.data.last_at)}` : '—'}
                </td>
                <td className="num py-1 pr-3 text-foreground/90" title={t('预热之后第一根决策 K 线 → 最后一根已收盘 K 线')}>
                  {a.window ? `${ymd(a.window.from_ms)} → ${ymd(a.window.to_ms)}` : a.data?.trading_from_ms ? `${ymd(a.data.trading_from_ms)} →` : '—'}
                </td>
                <td className="num py-1 pr-3 text-right" title={a.data?.warmup_borrowed ? t('预热向窗口之前的数据借了 K 线') : t('预热占用窗口内的 K 线')}>
                  {a.data ? `${a.data.warmup_bars}${a.data.warmup_borrowed ? ` · ${t('借')}` : ''}` : '—'}
                </td>
                <td className="num py-1 pr-3 text-right">{a.data ? a.data.bars.toLocaleString('en-US') : '—'}</td>
                <td className="py-1 pr-3">{a.data?.timeframe ?? report.timeframe}</td>
                <td className={cn('py-1', a.status === 'completed' ? 'text-foreground/80' : 'text-warn')} title={a.error ?? undefined}>
                  {ASSET_STATUS_LABEL[a.status]}
                  {a.error ? <span className="ml-1 text-[10.5px]">— {a.error}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.assets.some((a) => a.data?.perp) ? (
        <div className="space-y-1" data-testid="perp-provenance">
          {report.assets.filter((a) => a.data?.perp).map((a) => {
            const p = a.data!.perp!;
            return (
              <div key={a.key} className="rounded-md border border-border/60 px-2.5 py-1.5">
                <div className="text-foreground">{t('{label} 永续数据', { label: a.label })} <span className="num text-[10.5px]">{p.instrument}</span></div>
                <div>{p.funding_note}</div>
                <div className="flex flex-wrap gap-x-3">
                  <span>{t('标记价缺 {n} 根', { n: p.mark_missing_bars })}</span>
                  <span>{p.maintenance_margin}</span>
                  {p.max_lever !== null ? <span>{t('当前最高杠杆 {n}x', { n: p.max_lever })}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-4 gap-y-1">
        <Item k={t('初始资金')} v={usdPlain(ex.initial_cash)} />
        <Item k={t('手续费率')} v={pctPlain(ex.fee_rate, 3)} />
        <Item k={t('滑点')} v={`${ex.slippage_bps} bps`} />
        <Item k={t('成交模型')} v={ex.fill_model} />
        <Item k={t('市场 / 杠杆')} v={`${ex.market === 'spot' ? t('现货') : t('永续')} · ${ex.leverage}x`} />
        {ex.view_bars ? <Item k={t('决策可见历史')} v={ex.view_bars} /> : null}
        <Item k={t('仓位模式')} v={ex.sizing_mode} />
        <Item k={t('篮子口径')} v={ex.basket_weighting} />
        <Item k={t('引擎版本')} v={report.engine_version} />
        <Item k={t('策略哈希')} v={report.strategy_ir_hash.length > 20 ? `${report.strategy_ir_hash.slice(0, 20)}…` : report.strategy_ir_hash} title={report.strategy_ir_hash} />
        <Item k={t('生成时间')} v={`${ymdhm(report.created_at)} UTC`} />
        <Item k={t('报告 ID')} v={report.id} />
      </dl>
      {report.warnings.length ? (
        <ul className="space-y-0.5 text-warn">
          {report.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {w}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[10.5px]">{t('时间均为 UTC;收益已扣手续费与滑点,持有基准不扣费。')}</p>
    </footer>
  );
}

function Item({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0">{k}</dt>
      <dd className="num truncate text-foreground/90" title={title ?? v}>
        {v}
      </dd>
    </div>
  );
}
