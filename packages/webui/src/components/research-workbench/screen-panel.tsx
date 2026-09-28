/**
 * 资产筛选面板(round2-spec §1):资产池 → 对市场因子做滚动回归剔 beta → 每个 symbol 的
 * raw / residual 指标、alpha/beta 占比、趋势状态、名次。screen 只能用 as_of 之前的数据(后端保证)。
 * 排名是探索性排序,不是选股认证;insufficient 的行只显示样本数。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Beaker, Database, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api, researchApi } from '@/api/client';
import type { ResearchScreenRow, ResearchUniverse } from '@/api/research-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

const FACTOR_LABEL: Record<string, string> = tmap({ btc: 'BTC 单因子', btc_eth_capw: 'BTC/ETH 加权', equal_weight_universe: '资产池等权' });
const TREND_LABEL: Record<string, string> = tmap({ up: '上行', down: '下行', range: '震荡' });
const TF_OPTIONS = ['15m', '1h', '4h', '1d'] as const;

const num = (v: number | null | undefined, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: number | null | undefined, d = 1): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const toneOf = (v: number | null | undefined): string => (typeof v === 'number' && v !== 0 ? (v > 0 ? 'text-up' : 'text-down') : '');

export function tfLabel(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

type SortKey = 'composite' | 'residual_sharpe' | 'alpha_share' | 'beta' | 'alpha' | 'raw_return' | 'residual_return' | 'residual_dd' | 'symbol';

export function UniverseScreenPanel({ onNewExperiment }: { onNewExperiment: (universe: ResearchUniverse) => void }) {
  const qc = useQueryClient();
  const universesQ = useQuery({ queryKey: ['research', 'universes'], queryFn: researchApi.universes, retry: false });
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  const [universeId, setUniverseId] = useState<string | null>(null);
  const universes = universesQ.data?.items ?? [];
  const universe = universes.find((u) => u.id === universeId) ?? universes[0] ?? null;
  const [windowBars, setWindowBars] = useState(720);
  const [lookbackBars, setLookbackBars] = useState(2160);
  const screenQ = useQuery({
    queryKey: ['research', 'screen', universe?.id, windowBars, lookbackBars],
    queryFn: () => researchApi.screen(universe!.id, { window_bars: windowBars, lookback_bars: lookbackBars }),
    enabled: !!universe,
    retry: false,
    staleTime: 60_000,
  });
  const [form, setForm] = useState({ symbols: '', timeframe: '1h', days: 120, factor: 'btc' as 'btc' | 'btc_eth_capw' | 'equal_weight_universe' });
  const defaultSymbols = (overviewQ.data?.workflow?.watchlist ?? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']).join(', ');
  const createM = useMutation({
    mutationFn: () => {
      const symbols = (form.symbols || defaultSymbols).split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      const to = Date.now();
      const factorSymbols = form.factor === 'btc' ? ['BTCUSDT'] : form.factor === 'btc_eth_capw' ? ['BTCUSDT', 'ETHUSDT'] : symbols;
      return researchApi.createUniverse({ symbols, timeframe: form.timeframe, from_ms: to - form.days * 86_400_000, to_ms: to, market_factor: { kind: form.factor, symbols: factorSymbols } });
    },
    onSuccess: (u) => {
      toast.success(t('资产池已冻结:{n} 个币,对齐 {b} 根', { n: u.members.length, b: u.aligned_bars }));
      void qc.invalidateQueries({ queryKey: ['research', 'universes'] });
      setUniverseId(u.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'composite', dir: 'asc' });
  const rows = useMemo(() => {
    const items = [...(screenQ.data?.rows ?? [])];
    const val = (r: ResearchScreenRow): number | string | null => {
      switch (sort.key) {
        case 'composite': return r.rank?.composite ?? null;
        case 'residual_sharpe': return r.residual?.sharpe ?? null;
        case 'alpha_share': return r.alpha_share;
        case 'beta': return r.beta;
        case 'alpha': return r.alpha_annualized;
        case 'raw_return': return r.raw?.total_return ?? null;
        case 'residual_return': return r.residual?.total_return ?? null;
        case 'residual_dd': return r.residual?.max_drawdown ?? null;
        case 'symbol': return r.symbol;
      }
    };
    items.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - Number(y);
      return sort.dir === 'asc' ? c : -c;
    });
    return items;
  }, [screenQ.data, sort]);
  const th = (key: SortKey, label: string, cls = 'text-right') => (
    <TableHead className={cn('cursor-pointer select-none whitespace-nowrap', cls)} onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
      {label}
      {sort.key === key ? (sort.dir === 'desc' ? <ArrowDown className="ml-0.5 inline size-3" /> : <ArrowUp className="ml-0.5 inline size-3" />) : null}
    </TableHead>
  );
  const backendMissing = universesQ.error && /404|not_found|不存在/.test((universesQ.error as Error).message);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-4 pt-3 pb-2">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[16px] font-semibold">{t('资产筛选')}</h1>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{t('先剔除大盘 beta,再看每个币靠 alpha 还是靠 beta:对市场因子做滚动回归,残差曲线上算回撤、回撤面积、Sharpe。排名是探索性排序,不是选股认证。')}</p>
          </div>
          {universe ? (
            <Button size="sm" onClick={() => onNewExperiment(universe)}>
              <Beaker /> {t('用这个资产池新建实验')}
            </Button>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md border bg-muted/20 p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Database className="size-3" /> {t('冻结一个资产池')}
          </div>
          <Input value={form.symbols} onChange={(e) => setForm({ ...form, symbols: e.target.value })} placeholder={defaultSymbols} className="h-7 min-w-[280px] flex-1 text-[12px]" />
          <select className="h-7 rounded-md border bg-background px-1.5 text-[12px]" value={form.timeframe} onChange={(e) => setForm({ ...form, timeframe: e.target.value })}>
            {TF_OPTIONS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Input type="number" min={14} max={2000} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} className="h-7 w-16 text-[12px]" /> {t('天')}
          </label>
          <select className="h-7 rounded-md border bg-background px-1.5 text-[12px]" value={form.factor} onChange={(e) => setForm({ ...form, factor: e.target.value as typeof form.factor })}>
            {(['btc', 'btc_eth_capw', 'equal_weight_universe'] as const).map((k) => (
              <option key={k} value={k}>
                {FACTOR_LABEL[k]}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={() => createM.mutate()} disabled={createM.isPending}>
            {createM.isPending ? <RefreshCw className="animate-spin" /> : <Database />} {t('拉取并冻结')}
          </Button>
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-[11.5px]">
        {universes.length ? (
          <select className="h-7 max-w-[520px] rounded-md border bg-background px-2 text-[12px]" value={universe?.id ?? ''} onChange={(e) => setUniverseId(e.target.value)}>
            {universes.map((u) => (
              <option key={u.id} value={u.id}>
                {u.members.map((m) => m.symbol.replace('USDT', '')).join('/')} · {tfLabel(u.timeframe_ms)} · {u.aligned_bars} bars · {FACTOR_LABEL[u.market_factor.kind] ?? u.market_factor.kind} · {fmtDateTime(u.first_at)} → {fmtDateTime(u.last_at)}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-muted-foreground">{backendMissing ? t('后端还没有资产池接口(第二轮 astra 交付中)') : universesQ.isLoading ? t('读取中…') : t('还没有资产池,先冻结一个。')}</span>
        )}
        {universe ? (
          <>
            <label className="ml-2 flex items-center gap-1 text-muted-foreground">
              {t('回归窗口')} <Input type="number" min={50} value={windowBars} onChange={(e) => setWindowBars(Number(e.target.value))} className="h-6 w-20 px-1.5 text-[11px]" /> bars
            </label>
            <label className="flex items-center gap-1 text-muted-foreground">
              {t('评估回看')} <Input type="number" min={100} value={lookbackBars} onChange={(e) => setLookbackBars(Number(e.target.value))} className="h-6 w-20 px-1.5 text-[11px]" /> bars
            </label>
            {screenQ.data ? (
              <span className="ml-auto text-muted-foreground">
                as_of <span className="num">{fmtDateTime(screenQ.data.as_of)}</span> · {t('因子')} {FACTOR_LABEL[screenQ.data.market_factor.kind] ?? screenQ.data.market_factor.kind}
                {screenQ.data.market_factor.weights ? ` (${Object.entries(screenQ.data.market_factor.weights).map(([k, v]) => `${k.replace('USDT', '')} ${v}`).join(', ')})` : ''}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {screenQ.error ? <div className="p-4 text-[12px] text-down">{(screenQ.error as Error).message}</div> : null}
        {screenQ.isLoading ? <div className="p-4 text-[12px] text-muted-foreground">{t('回归计算中…')}</div> : null}
        {screenQ.data ? (
          <Table className="text-[11.5px]">
            <TableHeader>
              <TableRow>
                {th('composite', t('名次'), 'text-left')}
                {th('symbol', t('币'), 'text-left')}
                <TableHead>{t('趋势')}</TableHead>
                {th('beta', 'β')}
                {th('alpha', t('α 年化'))}
                <TableHead className="text-right">R²</TableHead>
                {th('alpha_share', t('α 占比'))}
                {th('raw_return', t('原始收益'))}
                {th('residual_return', t('残差收益'))}
                <TableHead className="text-right">{t('原始回撤')}</TableHead>
                {th('residual_dd', t('残差回撤'))}
                <TableHead className="text-right">{t('回撤面积')}</TableHead>
                <TableHead className="text-right">{t('原始 Sharpe')}</TableHead>
                {th('residual_sharpe', t('残差 Sharpe'))}
                <TableHead className="text-right">IR</TableHead>
                <TableHead className="text-right">{t('动量 12-1')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.symbol} className={cn(r.status === 'insufficient' && 'opacity-60')}>
                  <TableCell className="num">{r.rank?.composite ?? '—'}</TableCell>
                  <TableCell className="font-medium">
                    {r.symbol}
                    {screenQ.data!.market_factor.symbols.includes(r.symbol) ? <span className="ml-1 text-[10px] text-muted-foreground">{t('因子')}</span> : null}
                  </TableCell>
                  <TableCell>
                    {r.trend ? (
                      <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', r.trend.state === 'up' ? 'border-up/40 text-up' : r.trend.state === 'down' ? 'border-down/40 text-down' : 'text-muted-foreground')} title={t('ADX {adx} · EMA 斜率 {slope} · HTF {htf}', { adx: num(r.trend.adx, 1), slope: num(r.trend.ema_slope, 4), htf: r.trend.htf_state ?? '—' })}>
                        {TREND_LABEL[r.trend.state] ?? r.trend.state}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  {r.status === 'insufficient' ? (
                    <TableCell colSpan={13} className="text-muted-foreground">
                      {t('样本不足({n} 根)', { n: r.bars })}
                    </TableCell>
                  ) : (
                    <>
                      <TableCell className="num text-right">{num(r.beta)}</TableCell>
                      <TableCell className={cn('num text-right', toneOf(r.alpha_annualized))}>{pct(r.alpha_annualized)}</TableCell>
                      <TableCell className="num text-right text-muted-foreground">{num(r.r2)}</TableCell>
                      <TableCell className="num text-right">
                        <span className="inline-flex items-center gap-1">
                          <i className="inline-block h-1.5 w-12 overflow-hidden rounded bg-muted">
                            <i className="block h-full bg-primary" style={{ width: `${Math.max(0, Math.min(1, r.alpha_share ?? 0)) * 100}%` }} />
                          </i>
                          {pct(r.alpha_share, 0)}
                        </span>
                      </TableCell>
                      <TableCell className={cn('num text-right', toneOf(r.raw?.total_return))}>{pct(r.raw?.total_return)}</TableCell>
                      <TableCell className={cn('num text-right font-medium', toneOf(r.residual?.total_return))}>{pct(r.residual?.total_return)}</TableCell>
                      <TableCell className="num text-right text-down">-{pct(r.raw?.max_drawdown)}</TableCell>
                      <TableCell className="num text-right text-down">-{pct(r.residual?.max_drawdown)}</TableCell>
                      <TableCell className="num text-right text-muted-foreground" title={`Ulcer ${num(r.residual?.ulcer_index, 3)}`}>{num(r.residual?.drawdown_area, 3)}</TableCell>
                      <TableCell className="num text-right">{num(r.raw?.sharpe)}</TableCell>
                      <TableCell className={cn('num text-right font-medium', toneOf(r.residual?.sharpe))}>{num(r.residual?.sharpe)}</TableCell>
                      <TableCell className="num text-right">{num(r.residual?.information_ratio)}</TableCell>
                      <TableCell className={cn('num text-right', toneOf(r.momentum_12_1))}>{pct(r.momentum_12_1)}</TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {screenQ.data?.note ? <div className="px-4 py-2 text-[10.5px] text-muted-foreground">{screenQ.data.note}</div> : null}
        <div className="px-4 pb-4 text-[10.5px] text-muted-foreground">{t('参考:单因子 CAPM 回归;加密三因子(市场/规模/动量)见 Liu、Tsyvinski、Wu(JF 2022)。本轮只做市场因子;美股换 SPY/行业 ETF + Fama-French 因子,Sharpe 用超额收益。')}</div>
      </ScrollArea>
    </div>
  );
}
