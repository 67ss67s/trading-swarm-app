/**
 * find_data_source 工具结果卡片(§9.44 数据层):这个指标在这个标的 / 周期上能不能拿、谁给、拿不到为什么、能用什么代理。
 *
 * 数据来源:研究 loop 里 tool='find_data_source' 那一步的 step.output_summary.result(ToolResult),
 * 也接受直接传 result.output(目录解析 + proxy_rules)。形状对齐 gateway data/loop-tools.ts 的 present() 与 data/catalog.ts。
 *
 * 状态口径:
 *   可用     availability=available
 *   部分可用 availability=partial(有来源但周期 / 窗口不全)
 *   代理     拿不到原指标,但目录给出了可落地的代理(proxies 非空)——报告里只能以代理身份出现
 *   缺失     missing / not_connected(来源已知但本仓库没接)
 *   不适用   not_applicable(这个市场上指标本身不成立,如现货资金费)
 */

import { CircleCheck, CircleSlash, CircleX, Database, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type DataMetricKey = 'price' | 'funding' | 'open_interest' | 'liquidations' | 'liquidation_estimates' | 'orderbook';
export type DataCatalogAvailability = 'available' | 'partial' | 'missing' | 'not_applicable' | 'not_connected';
export type DataContractAvailability = 'available' | 'partial' | 'missing' | 'not_applicable' | 'stale';

/** find_data_source 的 output(data/loop-tools.ts present())。 */
export interface FindDataSourceOutput {
  metric: DataMetricKey | string;
  instrument_id: string;
  market_type: 'spot' | 'perp' | 'equity' | 'index' | string;
  timeframe: string | null;
  availability: DataCatalogAvailability;
  adapter_id?: string;
  note: string;
  /** 可落地的代理(依赖指标都有已接来源时才给) */
  proxies?: { metric: string; adapter_id: string; note: string }[];
  /** 所有登记了这个指标的来源,含没接的 */
  candidates?: { adapter_id: string; status: 'connected' | 'not_connected'; note: string }[];
  catalog_version: string;
  availability_contract?: DataContractAvailability;
  proxy_rules?: { id: string; label: string; target: string; requires: string[]; statement: string }[];
  fabrication_guard?: string;
}

/** 研究 loop 的 ToolResult 外壳(step.output_summary.result)。 */
export interface FindDataSourceToolResult {
  status: 'ok' | DataContractAvailability | string;
  output: FindDataSourceOutput | null;
  coverage?: { availability: DataContractAvailability; earliest?: number | null; latest?: number | null; note: string };
  warnings?: string[];
  error_code?: string;
}

type Kind = 'available' | 'partial' | 'proxy' | 'missing' | 'not_applicable';

const KIND_LABEL: Record<Kind, string> = tmap({ available: '可用', partial: '部分可用', proxy: '代理', missing: '缺失', not_applicable: '不适用' });
const KIND_CLASS: Record<Kind, string> = {
  available: 'bg-up/15 text-up',
  partial: 'bg-warn/15 text-warn',
  proxy: 'bg-warn/15 text-warn',
  missing: 'bg-down/10 text-down',
  not_applicable: 'bg-muted text-muted-foreground',
};
const METRIC_LABEL: Record<string, string> = tmap({ price: '价格 K 线', funding: '资金费率', open_interest: '持仓量', liquidations: '强平记录', liquidation_estimates: '清算估计', orderbook: '订单簿' });
const MARKET_LABEL: Record<string, string> = tmap({ spot: '现货', perp: '永续', equity: '股票', index: '指数' });

function isToolResult(v: unknown): v is FindDataSourceToolResult {
  return !!v && typeof v === 'object' && 'output' in v && 'status' in v;
}

function kindOf(o: FindDataSourceOutput): Kind {
  if (o.availability === 'available') return 'available';
  if (o.availability === 'not_applicable') return 'not_applicable';
  if (o.proxies?.length) return 'proxy';
  if (o.availability === 'partial') return 'partial';
  return 'missing';
}

/** 研究侧时间一律 UTC 日期。 */
const fmtDay = (ms: number | null | undefined): string => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '—');

function KindIcon({ kind }: { kind: Kind }) {
  if (kind === 'available') return <CircleCheck className="size-3.5 shrink-0 text-up" />;
  if (kind === 'not_applicable') return <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" />;
  if (kind === 'missing') return <CircleX className="size-3.5 shrink-0 text-down" />;
  return <TriangleAlert className="size-3.5 shrink-0 text-warn" />;
}

export function DataSourceCard({ result }: { result: FindDataSourceToolResult | FindDataSourceOutput | null | undefined }) {
  const wrapped = isToolResult(result) ? result : null;
  const o = wrapped ? wrapped.output : (result as FindDataSourceOutput | null | undefined);
  if (!o || typeof o !== 'object' || !('availability' in o)) {
    return (
      <div className="rounded-md border px-3 py-2 text-[11px] text-muted-foreground">
        {t('数据源查询没有结果')}
        {wrapped?.error_code ? <span className="ml-1 font-mono text-down">{wrapped.error_code}</span> : null}
      </div>
    );
  }
  const kind = kindOf(o);
  const coverage = wrapped?.coverage;
  const hasRange = coverage && (typeof coverage.earliest === 'number' || typeof coverage.latest === 'number');
  const connected = (o.candidates ?? []).filter((c) => c.status === 'connected');
  const pending = (o.candidates ?? []).filter((c) => c.status === 'not_connected');
  // 代理规则:目录已判定可落地的(proxies)优先;proxy_rules 是规则表原文,依赖指标也缺时仅作说明
  const rules = o.proxy_rules ?? [];
  const showRules = kind !== 'available' && kind !== 'not_applicable' && rules.length > 0;

  return (
    <div className={cn('rounded-md border', kind === 'missing' && 'border-down/40')}>
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
        <Database className="size-3.5 text-muted-foreground" />
        <span className="kicker text-foreground/85">{t('数据源')}</span>
        <span className="text-xs font-medium">{METRIC_LABEL[o.metric] ?? o.metric}</span>
        <span className="font-mono text-[10.5px] text-muted-foreground">{o.instrument_id}</span>
        <span className="text-[10.5px] text-muted-foreground">{MARKET_LABEL[o.market_type] ?? o.market_type}{o.timeframe ? ` · ${o.timeframe}` : ''}</span>
        <Badge className={cn('ml-auto text-[10.5px]', KIND_CLASS[kind])}>
          <KindIcon kind={kind} />
          {KIND_LABEL[kind]}
        </Badge>
      </div>

      <div className="space-y-2 px-3 py-2 text-[11px]">
        {/* 来源 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="text-muted-foreground">{t('来源')}:</span>
          {o.adapter_id ? (
            <span className="font-mono">{o.adapter_id}</span>
          ) : (
            <span className="text-muted-foreground">{t('无')}</span>
          )}
          {o.availability === 'not_connected' ? <Badge variant="outline" className="text-[10px] text-warn">{t('已知来源,未接入')}</Badge> : null}
          {hasRange ? (
            <span className="text-muted-foreground">
              {t('覆盖区间')}:<span className="num text-foreground">{fmtDay(coverage?.earliest)} → {fmtDay(coverage?.latest)}</span>
            </span>
          ) : null}
        </div>

        {/* 目录说明:可用时是来源与历史深度,缺失 / 不适用时就是原因 */}
        <p className={cn('leading-relaxed', kind === 'missing' ? 'text-down' : kind === 'not_applicable' ? 'text-muted-foreground' : kind === 'available' ? 'text-muted-foreground' : 'text-warn')}>
          {kind === 'missing' ? t('缺失原因') + ':' : kind === 'not_applicable' ? t('不适用原因') + ':' : ''}
          {o.note}
        </p>
        {coverage?.note && coverage.note !== o.note && !o.note.includes(coverage.note) ? <p className="leading-relaxed text-muted-foreground">{coverage.note}</p> : null}

        {/* 可落地的代理 */}
        {o.proxies?.length ? (
          <div className="space-y-1 rounded-md border border-warn/30 bg-warn/5 px-2.5 py-1.5">
            <div className="font-medium text-warn">{t('可用代理(报告里只能以代理身份出现,不能填进原指标)')}</div>
            <ul className="space-y-0.5">
              {o.proxies.map((p, i) => (
                <li key={`${p.metric}:${p.adapter_id}:${i}`} className="leading-relaxed">
                  <span className="font-mono">{p.metric}</span>
                  <span className="text-muted-foreground"> ← {p.adapter_id}</span>
                  <span className="text-muted-foreground">:{p.note}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* 代理规则原文 */}
        {showRules ? (
          <div className="space-y-1">
            <div className="text-muted-foreground">{o.proxies?.length ? t('代理规则') : t('代理规则(依赖的数据也拿不到,暂不可用)')}</div>
            <ul className="space-y-0.5">
              {rules.map((r) => (
                <li key={r.id} className="leading-relaxed">
                  <span className="font-medium">{r.label}</span>
                  <span className="ml-1 font-mono text-[10.5px] text-muted-foreground">{r.requires.join(' + ')}</span>
                  <div className="text-muted-foreground">{r.statement}</div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* 登记了这个指标的所有来源 */}
        {connected.length + pending.length > 0 ? (
          <details className="group">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {t('登记来源 {n} 个(已接 {c},未接 {p})', { n: connected.length + pending.length, c: connected.length, p: pending.length })}
            </summary>
            <ul className="mt-1 space-y-1">
              {[...connected, ...pending].map((c) => (
                <li key={c.adapter_id} className="leading-relaxed">
                  <span className="font-mono">{c.adapter_id}</span>
                  <Badge variant="outline" className={cn('ml-1.5 text-[10px]', c.status === 'connected' ? 'text-up' : 'text-muted-foreground')}>{c.status === 'connected' ? t('已接入') : t('未接入')}</Badge>
                  <div className="text-muted-foreground">{c.note}</div>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {wrapped?.warnings?.length ? (
          <ul className="space-y-0.5 text-[10.5px] text-muted-foreground">
            {wrapped.warnings.filter((w) => !w.startsWith('可用代理:')).map((w, i) => <li key={i}>· {w}</li>)}
          </ul>
        ) : null}
      </div>

      <div className="border-t px-3 py-1 text-[10.5px] text-muted-foreground">
        {o.fabrication_guard ?? t('缺数据就说缺;代理指标必须以代理身份出现在报告里。')}
        <span className="ml-2 font-mono">{o.catalog_version}</span>
      </div>
    </div>
  );
}
