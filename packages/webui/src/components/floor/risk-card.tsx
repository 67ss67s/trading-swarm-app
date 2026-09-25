/**
 * 楼层左栏:选中 SENTINEL 时的风控告警面板、选中 BOOK 时的账户敞口面板(gateway 65bb92a)。
 * 规则(对方定的):ack = 已阅不解除;「确认恢复」只对 recovery_ready 的 high/critical 可点,否则 409;
 * warn 连续 3 轮干净自动解除;POST /api/risk/evaluate 手动重评免费。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { DemoPortfolioCapacity, PortfolioSnapshot, RiskAlertRow, RiskAlertsResponse, RiskLevel, RiskSeverity } from '@/api/types';
import { CONSTRAINT_LABEL, trimNum, verdictText } from '@/lib/capacity';
import { fmtDateTime, fx, relativeTime } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useVerifyProtection } from '@/components/protection-status';
import { cn } from '@/lib/utils';

export const RISK_LEVEL_LABEL: Record<RiskLevel, string> = tmap({ none: '不变量全过', warn: '有 warn', high: '有 high', critical: 'critical' });
export const RISK_LEVEL_COLOR: Record<RiskLevel, string> = { none: 'var(--of-accent)', warn: 'var(--of-warn)', high: 'var(--of-danger)', critical: 'var(--of-danger)' };
const SEV_COLOR: Record<RiskSeverity, string> = { info: 'var(--of-info)', warn: 'var(--of-warn)', high: 'var(--of-danger)', critical: 'var(--of-danger)' };
const SEV_LABEL: Record<RiskSeverity, string> = { info: 'info', warn: 'warn', high: 'high', critical: 'CRITICAL' };

function AlertRow({ a, now }: { a: RiskAlertRow; now: number }) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['risk'] });
    void qc.invalidateQueries({ queryKey: ['bots'] });
  };
  const ack = useMutation({ mutationFn: () => api.ackRiskAlert(a.id), onSuccess: () => { toast.success(t('已读(不解除)')); invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const resolve = useMutation({ mutationFn: () => api.resolveRiskAlert(a.id), onSuccess: () => { toast.success(t('已确认恢复')); invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const canResolve = a.recovery_ready && (a.severity === 'high' || a.severity === 'critical');
  return (
    <li className="border-l-2 py-1.5 pl-2 text-[10px]" style={{ borderColor: SEV_COLOR[a.severity] }}>
      <div className="flex items-center gap-1">
        <span className="font-bold" style={{ color: SEV_COLOR[a.severity] }}>{SEV_LABEL[a.severity]}</span>
        <span className="text-[var(--of-ink-faint)]">{a.scope}</span>
        {a.auto_action === 'block_new_risk' ? <span className="border border-[var(--of-danger)] px-1 text-[8px] text-[var(--of-danger)]">{t('停止新增风险')}</span> : null}
        <span className="ml-auto text-[var(--of-ink-faint)]" title={t('首次 {at} · 观察到 {n} 次', { at: fmtDateTime(a.first_seen_at), n: a.observed_count })}>
          {relativeTime(a.last_seen_at, now)}
        </span>
      </div>
      <div className="mt-0.5 leading-3.5 text-[var(--of-ink)]">{a.title}</div>
      {a.detail ? <div className="text-[9px] leading-3 text-[var(--of-ink-dim)]">{a.detail}</div> : null}
      {a.value != null && a.threshold != null ? (
        <div className="num text-[9px] text-[var(--of-ink-dim)]">
          {t('值 {v} / 阈值 {th}', { v: fx(a.value), th: a.threshold })}
          {a.clean_streak ? ` · ${t('已连续 {n} 轮干净', { n: a.clean_streak })}` : ''}
        </div>
      ) : null}
      <div className="mt-1 flex gap-1">
        {!a.acked_at ? (
          <button type="button" className="border border-[var(--of-line)] px-1.5 py-0.5 hover:bg-[var(--of-panel-2)]" disabled={ack.isPending} onClick={() => ack.mutate()}>
            {t('已读')}
          </button>
        ) : (
          <span className="text-[var(--of-ink-faint)]">{t('已读 {t}', { t: relativeTime(a.acked_at, now) })}</span>
        )}
        {a.action ? <AlertActionButton action={a.action} /> : null}
        {a.severity === 'high' || a.severity === 'critical' ? (
          <button
            type="button"
            className={cn('border px-1.5 py-0.5', canResolve ? 'border-[var(--of-accent)] text-[var(--of-accent)] hover:bg-[var(--of-panel-2)]' : 'cursor-not-allowed border-[var(--of-line)] text-[var(--of-ink-faint)]')}
            disabled={!canResolve || resolve.isPending}
            title={canResolve ? t('不变量已经连续干净,可以关掉这条告警') : t('还没恢复到能关:代码判了 recovery_ready 才点得动')}
            onClick={() => resolve.mutate()}
          >
            {t('确认恢复')}
          </button>
        ) : (
          <span className="text-[var(--of-ink-faint)]">{t('连续 3 轮干净自动解除')}</span>
        )}
      </div>
    </li>
  );
}

/** §9.20:告警自带的用户动作。verify_protection 走专用确认(写清真钱费用),其它按 method/path/body 原样调;成功靠 SSE 刷新 */
function AlertActionButton({ action }: { action: NonNullable<RiskAlertRow['action']> }) {
  const qc = useQueryClient();
  const [ask, setAsk] = useState(false);
  const verify = useVerifyProtection();
  const generic = useMutation({
    mutationFn: () => api.alertAction(action),
    onSuccess: () => {
      toast.success(t('{label}:已提交', { label: action.label }));
      void qc.invalidateQueries({ queryKey: ['risk'] });
      void qc.invalidateQueries({ queryKey: ['execution'] });
    },
    onError: (e: Error) => toast.error(t('{label} 失败', { label: action.label }), { description: e.message }),
  });
  const busy = verify.isPending || generic.isPending;
  // §9.31:保护腿告警的 scope 是**交易对**(body 带 symbol),验证也按币走;没带 symbol 才退回通道级。
  const symbol = typeof action.body?.['symbol'] === 'string' ? (action.body['symbol'] as string) : undefined;
  // §9.40:告警 body 带 market 就按市场验(spot 凭证与 perp 分开)
  const market = action.body?.['market'] === 'spot' ? ('spot' as const) : undefined;
  // 09-22:合并告警(scope channel:xxx)的 body 是 symbols[](多币逐个验),之前只读单数 symbol → 请求不带币 → 网关兜底挑了 SOL,BTC/ETH/BNB 永远验不上。带 symbols 的按钮原样按 body 发。
  const hasSymbols = Array.isArray(action.body?.['symbols']) && (action.body['symbols'] as unknown[]).length > 0;
  const run = () => (action.kind === 'verify_protection' && !hasSymbols ? verify.mutate({ symbol, market }) : generic.mutate());
  return (
    <>
      <button type="button" className="border border-[var(--of-warn)] px-1.5 py-0.5 text-[var(--of-warn)] hover:bg-[var(--of-panel-2)] disabled:opacity-50" disabled={busy} title={action.note ?? undefined} onClick={() => (action.note ? setAsk(true) : run())}>
        {busy ? '…' : action.label}
      </button>
      {action.note ? <span className="self-center text-[8.5px] text-[var(--of-ink-faint)]">{action.note}</span> : null}
      <ConfirmDialog open={ask} title={action.label} summary={t('确认')} danger busy={busy} onCancel={() => setAsk(false)} onConfirm={() => { setAsk(false); run(); }}>
        <p>{action.note}</p>
      </ConfirmDialog>
    </>
  );
}

export function RiskPanel({ data, now }: { data: RiskAlertsResponse | null | undefined; now: number }) {
  const qc = useQueryClient();
  const evaluate = useMutation({
    mutationFn: api.riskEvaluate,
    onSuccess: () => {
      toast.success(t('已重评'));
      void qc.invalidateQueries({ queryKey: ['risk'] });
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!data) return <div className="of-panel p-3 text-[10px] text-[var(--of-ink-dim)]">{t('风控接口还没就绪。')}</div>;
  return (
    <div className="of-panel p-3">
      <div className="flex items-center">
        <span className="of-kicker">{t('风控告警')}</span>
        <span className="ml-auto text-[10px]" style={{ color: RISK_LEVEL_COLOR[data.level] }}>
          {RISK_LEVEL_LABEL[data.level]} · {t('{n} 条告警', { n: data.alerts.length })}
        </span>
      </div>
      {data.blocks_new_risk ? <div className="mt-1 text-[10px] text-[var(--of-danger)]">{t('代码闸已停止新增风险,只放降风险的动作')}</div> : null}
      <ul className="mt-2 space-y-1">
        {data.alerts.length ? data.alerts.map((a) => <AlertRow key={a.id} a={a} now={now} />) : <li className="text-[10px] text-[var(--of-ink-dim)]">{t('没有开着的告警。')}</li>}
      </ul>
      <button type="button" className="mt-2 border border-[var(--of-line)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--of-panel-2)]" disabled={evaluate.isPending} onClick={() => evaluate.mutate()}>
        {t('立即重评(不花钱)')}
      </button>
    </div>
  );
}

const CLUSTER_LABEL: Record<string, string> = tmap({ crypto_major: '主流币', crypto_beta: '山寨/β', equity_linked: '股票挂钩', metal: '金属', unknown: '未分类' });
const QUALITY_LABEL: Record<PortfolioSnapshot['quality'], string> = tmap({ ok: '快照可靠', stale: '快照过期', inconsistent: '快照不一致', incomplete: '快照不完整' });

export function PortfolioPanel({ snap, capacity, now }: { snap: PortfolioSnapshot | null | undefined; capacity?: DemoPortfolioCapacity | null; now: number }) {
  if (!snap) return <div className="of-panel p-3 text-[10px] text-[var(--of-ink-dim)]">{t('还没有账户敞口快照。')}</div>;
  const bad = snap.quality !== 'ok';
  const clusters = Object.entries(snap.by_cluster).sort((a, b) => (b[1]?.gross ?? 0) - (a[1]?.gross ?? 0));
  return (
    <div className="of-panel p-3">
      <div className="flex items-center">
        <span className="of-kicker">{t('账户敞口')}</span>
        <span className="ml-auto text-[10px]" style={{ color: bad ? 'var(--of-danger)' : 'var(--of-accent)' }} title={snap.quality_note ?? ''}>
          {QUALITY_LABEL[snap.quality]} · {relativeTime(snap.observed_at, now)}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-px bg-[var(--of-line)] text-center">
        <Stat k={t('总敞口')} v={fx(snap.positions.gross_ratio, 2, '×')} sub={`${fx(snap.positions.gross, 0)} U`} />
        <Stat k={t('含挂单/待批')} v={fx(snap.projected.gross_ratio, 2, '×')} sub={`${fx(snap.projected.gross, 0)} U`} />
        <Stat k={t('净敞口')} v={snap.equity > 0 ? fx(snap.positions.net / snap.equity, 2, '×') : '—'} sub={snap.equity > 0 ? (snap.positions.net >= 0 ? t('偏多') : t('偏空')) : t('权益未知')} />
      </div>
      <div className="mt-2 text-[10px]">
        <div className="of-kicker">{t('按风险簇')}</div>
        <ul className="mt-1 space-y-0.5">
          {clusters.map(([k, g]) => (
            <li key={k} className="flex items-center gap-2">
              <span className="w-16 text-[var(--of-ink-dim)]">{CLUSTER_LABEL[k] ?? k}</span>
              <span className="h-1.5 flex-1 bg-[var(--of-line)]">
                <span className="block h-full" style={{ width: `${Math.min(100, (g?.gross_ratio ?? 0) * 50)}%`, background: 'var(--of-accent)' }} />
              </span>
              <span className="num w-12 text-right">{fx(g?.gross_ratio, 2, '×')}</span>
            </li>
          ))}
        </ul>
      </div>
      {capacity ? <CapacityBlock cap={capacity} /> : null}
      <div className="num mt-2 text-[9px] text-[var(--of-ink-dim)]">
        {t('止损预算 {v} U', { v: fx(snap.stop_budget_usdt, 0) })}({snap.stop_budget_ratio != null ? t('占权益 {p}%', { p: fx(snap.stop_budget_ratio * 100, 1) }) : t('权益未知')})
        {snap.unprotected_symbols.length ? <span className="text-[var(--of-danger)]"> · {t('没保护 {list}', { list: snap.unprotected_symbols.join(' ') })}</span> : ` · ${t('都挂了保护腿')}`}
      </div>
    </div>
  );
}

/** §9.18:还能开几条、卡在哪、每币可做/要多少权益。是典型止损情景的估算,不是执行授权 */
function CapacityBlock({ cap }: { cap: DemoPortfolioCapacity }) {
  const short = cap.by_symbol.filter((r) => r.verdict !== 'ok' && !r.occupied);
  return (
    <div className="mt-2 border-t border-[var(--of-line)] pt-2 text-[10px]">
      <div className="flex items-baseline gap-1">
        <span className="of-kicker">{t('容量')}</span>
        <span className="num text-[12px] font-bold" style={{ color: cap.slots_free > 0 ? 'var(--of-accent)' : 'var(--of-warn)' }}>
          {t('还能开 {n} 条', { n: cap.slots_free })}
        </span>
        <span className="text-[var(--of-ink-dim)]">
          {t('/ {total} · 卡在{constraint}', { total: cap.slots_total, constraint: CONSTRAINT_LABEL[cap.binding_constraint] })}
        </span>
      </div>
      <div className="num mt-0.5 text-[9px] text-[var(--of-ink-faint)]">
        {t('保证金预算 {limit} U · 空闲 {free} U · 预算还装 {slots} 条 · 风险 {risk}% · {lev}x', { limit: trimNum(cap.margin_budget.limit_usdt), free: trimNum(cap.margin_budget.free_usdt), slots: cap.margin_budget.slots_supported ?? '—', risk: cap.risk_pct, lev: cap.leverage })}
      </div>
      <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
        {cap.by_symbol.map((r) => (
          <li key={r.symbol} className="flex items-center gap-1" title={r.equity_shortfall && r.equity_shortfall !== '0' ? t('差 {gap} U;最小一单的风险 {min} U,预算只有 {budget} U', { gap: trimNum(r.equity_shortfall), min: trimNum(r.min_size_risk, 2), budget: trimNum(r.risk_budget, 2) }) : r.rules_source ? t('规则来自 {src}', { src: r.rules_source }) : ''}>
            <span className="num w-16 truncate">{r.symbol.replace(/USDT$/, '')}</span>
            <span style={{ color: r.verdict === 'ok' ? 'var(--of-accent)' : r.verdict === 'needs_equity' ? 'var(--of-warn)' : 'var(--of-ink-dim)' }}>{verdictText(r)}</span>
            {r.occupied ? <span className="text-[var(--of-ink-faint)]">· {t('在仓')}</span> : null}
            {r.watch_only ? <span className="text-[var(--of-ink-faint)]">· {t('只观察')}</span> : null}
          </li>
        ))}
      </ul>
      {short.length ? <div className="mt-1 text-[9px] text-[var(--of-warn)]">{t('{n} 个币现在的权益做不了;估算按典型止损 {pct}% 算。', { n: short.length, pct: cap.default_stop_distance_pct })}</div> : null}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div className="bg-[var(--of-panel)] px-1 py-1.5">
      <div className="of-kicker">{k}</div>
      <div className="num text-[12px] font-bold">{v}</div>
      <div className="text-[9px] text-[var(--of-ink-faint)]">{sub}</div>
    </div>
  );
}
