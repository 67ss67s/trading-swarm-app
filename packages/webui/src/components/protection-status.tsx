/**
 * §9.31 保护腿凭证:**有期限,按「通道 × 交易对」**。
 *
 * v3.11 的那一行状态是「声明」不是「证明」——一次性标记、没有效期,一个月前验过的和昨天验过的
 * 在闸眼里一样。现在它是一张会过期的凭证,所以这块从一行状态变成:
 *   顶部一行通道汇总(三态 · 绿/黄/红)+ ttl / 过期倒计时 + 自动重验这轮为什么没跑;
 *   下面一张小表,watchlist 每个币一行(状态 / 验证于 / 过期于 / 上次真挂结果),
 *   `never_verified` 的那一行自己带「用最小仓验证止损」按钮——**按币验证**,第一次花真钱必须是人点的。
 *
 * 判定口径(不能靠汇总猜):阻断是按 `credentials[].state` 逐币判的,汇总只是「最好的那条」。
 * 老网关只给旧 `status` 时退回 v3.11 的一行渲染,不黑屏、不编数。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Market, ProtectionCredential, ProtectionState, ProtectionStatusView } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t as tr, tmap } from '@/lib/i18n';

type Tone = 'ok' | 'warn' | 'bad' | 'dim';

const TONE: Record<Tone, string> = { ok: 'text-up', warn: 'text-warn', bad: 'text-down', dim: 'text-muted-foreground' };
const TONE_BORDER: Record<Tone, string> = {
  ok: 'border-up/30 bg-up/10 text-up',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  bad: 'border-down/30 bg-down/10 text-down',
  dim: 'border-transparent bg-muted text-muted-foreground',
};

/** 三个判定态 + 两个非判定态。颜色:verified 绿 / 过期·探测失败 黄 / 从没验过 红。 */
const STATE_LABEL: Record<ProtectionState, string> = tmap({
  not_needed: '不用验证',
  verifying: '验证中',
  verified: '已验证',
  verified_stale_or_probe_failed: '过期或上次挂失败',
  never_verified: '从没验证过',
});

function stateTone(state: ProtectionState): Tone {
  if (state === 'verified') return 'ok';
  if (state === 'verified_stale_or_probe_failed' || state === 'verifying') return 'warn';
  if (state === 'never_verified') return 'bad';
  return 'dim';
}

/** 倒计时:过期时刻可为 null → 「—」;已经过期就直说「已过期」,不显示负数。 */
function expiryText(expiresAt: number | null | undefined, now: number): string {
  if (expiresAt === null || expiresAt === undefined || !Number.isFinite(expiresAt)) return '—';
  if (expiresAt <= now) return tr('已过期');
  const days = Math.floor((expiresAt - now) / 86_400_000);
  const hours = Math.floor(((expiresAt - now) % 86_400_000) / 3_600_000);
  return days > 0 ? tr('还有 {d} 天 {h} 小时', { d: days, h: hours }) : tr('还有 {h} 小时', { h: hours });
}

/** v3.11 旧字段的一行文案(网关还没升级时用)。 */
export function protectionText(p: ProtectionStatusView): { text: string; tone: Tone } {
  const cur = p.steps.length ? p.steps.filter((s) => s.ok).length : 0;
  switch (p.status) {
    case 'not_needed':
      return { text: tr('这个通道不用验证'), tone: 'dim' };
    case 'verified':
      return { text: `${tr('已验证')} ${p.verified_at ? fmtDateTime(p.verified_at) : '—'}${p.source === 'env' ? tr('(环境声明)') : ''}`, tone: 'ok' };
    case 'verifying':
      return { text: `${tr('验证中')} · ${tr('第 {i}/{n} 步', { i: cur + 1, n: p.steps.length || '?' })}${p.steps[cur]?.name ? ` ${p.steps[cur]!.name}` : ''}`, tone: 'warn' };
    case 'failed':
      return { text: `${tr('失败')}:${p.last_error ?? p.steps.find((s) => !s.ok)?.detail ?? tr('原因不明')}${p.last_run_at ? ` · ${relativeTime(p.last_run_at)}` : ''}`, tone: 'bad' };
    default:
      return { text: tr('还没验证:新开仓会被下单前的闸挡住'), tone: 'warn' };
  }
}

export function useVerifyProtection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p?: { symbol?: string; market?: Market }) => api.verifyProtection(p?.symbol, p?.market),
    onSuccess: () => {
      toast.info(tr('开始验证,大概 2 分钟,跑完自动刷新'));
      void qc.invalidateQueries({ queryKey: ['execution'] });
      void qc.invalidateQueries({ queryKey: ['risk'] });
    },
    onError: (e: Error & { status?: number }) => toast.error(e.status === 409 ? tr('正在验证,别重复点') : tr('没跑起来'), { description: e.message }),
  });
}

/** 一个「用最小仓验证止损」按钮 + 它的确认框;`symbol` 为空 = 通道级(旧行为)。 */
function VerifyButton({
  symbol,
  market,
  costNote,
  label,
  variant = 'outline',
  disabled,
}: {
  symbol?: string;
  /** §9.40:按市场验证(spot = 买最小 lot → 现货条件单止损 → 卖回);缺省 perp */
  market?: Market;
  costNote: string;
  label: string;
  variant?: 'outline' | 'destructive';
  disabled?: boolean;
}) {
  const [ask, setAsk] = useState(false);
  const verify = useVerifyProtection();
  return (
    <>
      <Button size="xs" variant={variant} disabled={disabled || verify.isPending} onClick={() => setAsk(true)} title={costNote}>
        {label}
      </Button>
      <ConfirmDialog
        open={ask}
        title={symbol ? tr('用最小仓验证 {symbol} 的止损', { symbol: market === 'spot' ? `${symbol} · ${tr('现货')}` : symbol }) : tr('用最小仓验证止损')}
        summary={tr('确认,开始验证')}
        danger
        busy={verify.isPending}
        onCancel={() => setAsk(false)}
        onConfirm={() => {
          setAsk(false);
          verify.mutate({ symbol, market });
        }}
      >
        <p>{costNote}</p>
        <p className="mt-1 text-muted-foreground">
          {market === 'spot'
            ? tr('流程(现货):读账户 → 市价买最小 lot → 挂现货条件单止损 → 交易所确认 → 撤止损 → 市价卖回。过了就自动放行现货买入;失败会尽力撤单卖回,并继续挡着。')
            : tr('流程:读账户 → 市价开最小仓 → 挂止损 → 交易所确认 → 撤止损 → 平仓 → 确认已平。过了就自动放行新开仓;失败会尽力撤单平仓,并继续挡着。')}
        </p>
        {symbol ? <p className="mt-1 text-muted-foreground">{tr('凭证按「通道 × 交易对」记:这次只解除 {symbol} 的阻断,别的币各验各的。', { symbol })}</p> : null}
      </ConfirmDialog>
    </>
  );
}

function CredentialRow({ c, costNote, now }: { c: ProtectionCredential; costNote: string; now: number }) {
  const tone = stateTone(c.state);
  return (
    <>
      <div className="num bg-card px-2 py-1 text-[10.5px] font-semibold">{c.symbol ?? tr('通道级')}</div>
      <div className="bg-card px-2 py-1">
        <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', TONE_BORDER[tone])}>
          {STATE_LABEL[c.state]}
        </Badge>
        {c.market === 'spot' ? (
          <span className="ml-1 text-[9.5px] text-muted-foreground" title={tr('现货凭证:按 (通道 × 交易对 × 市场) 记,和永续的分开')}>
            {tr('现货')}
          </span>
        ) : null}
        {c.source === 'channel' ? (
          <span className="ml-1 text-[9.5px] text-muted-foreground" title={tr('用的是通道级兜底凭证,这个币还没有自己的凭证')}>
            {tr('兜底')}
          </span>
        ) : null}
      </div>
      <div className="num bg-card px-2 py-1 text-[10.5px] text-muted-foreground">{c.verified_at ? fmtDateTime(c.verified_at) : '—'}</div>
      <div className={cn('num bg-card px-2 py-1 text-[10.5px]', c.expires_at !== null && c.expires_at <= now ? 'text-warn' : 'text-muted-foreground')}>
        {c.expires_at ? `${fmtDateTime(c.expires_at)} · ${expiryText(c.expires_at, now)}` : '—'}
      </div>
      <div className="bg-card px-2 py-1 text-[10.5px]" title={c.last_error ?? undefined}>
        {c.last_probe_ok === null || c.last_probe_ok === undefined ? (
          <span className="text-muted-foreground">—</span>
        ) : c.last_probe_ok ? (
          <span className="text-up">{tr('成功')}</span>
        ) : (
          <span className="truncate text-down">{tr('失败')}{c.last_error ? `:${c.last_error}` : ''}</span>
        )}
      </div>
      <div className="flex items-center justify-end bg-card px-2 py-1">
        {c.state === 'never_verified' && c.symbol ? (
          <VerifyButton symbol={c.symbol} market={c.market} costNote={costNote} label={tr('用最小仓验证止损')} variant="destructive" />
        ) : c.state === 'verified_stale_or_probe_failed' && c.symbol ? (
          <VerifyButton symbol={c.symbol} market={c.market} costNote={costNote} label={tr('重新验证')} />
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </div>
    </>
  );
}

export function ProtectionBlock({ protection, compact }: { protection: ProtectionStatusView | null | undefined; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const creds = useMemo(() => {
    const list = protection?.credentials ?? [];
    // 要处理的排前面(从没验过 → 过期/失败 → 其余),同组按 symbol 排;通道级兜底行垫底。
    const rank: Record<ProtectionState, number> = { never_verified: 0, verified_stale_or_probe_failed: 1, verifying: 2, verified: 3, not_needed: 4 };
    return [...list].sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || (a.symbol ?? '￿').localeCompare(b.symbol ?? '￿'));
  }, [protection?.credentials]);

  if (!protection) return null;
  // 新网关看 state,老网关只有 status。两边都可能是 not_needed(paper / Rust / cli 通道天然会挂止损)。
  const state = protection.state;
  if ((state ?? protection.status) === 'not_needed') return null;

  // ---- 老网关:退回 v3.11 的一行 -------------------------------------------
  if (!state) {
    const txt = protectionText(protection);
    const canRun = protection.status === 'unverified' || protection.status === 'failed';
    return (
      <div className={cn('flex flex-wrap items-center gap-2', compact ? 'text-[10.5px]' : 'px-3 py-2 text-[11.5px]')}>
        {protection.status === 'verifying' ? <Loader2 className="size-3.5 animate-spin text-warn" /> : <ShieldCheck className={cn('size-3.5', TONE[txt.tone])} />}
        <span className="shrink-0 text-muted-foreground">{tr('止损保护')}</span>
        <span className={cn('min-w-0 flex-1 truncate', TONE[txt.tone])} title={txt.text}>
          {txt.text}
        </span>
        {protection.status !== 'verified' ? (
          <VerifyButton costNote={protection.cost_note} label={protection.status === 'verifying' ? tr('验证中…') : tr('用最小仓验证止损')} variant={protection.status === 'failed' ? 'destructive' : 'outline'} disabled={!canRun} />
        ) : null}
      </div>
    );
  }

  // ---- §9.31:三态汇总 + 凭证表 -------------------------------------------
  const tone = stateTone(state);
  const needsWork = creds.filter((c) => c.state === 'never_verified' || c.state === 'verified_stale_or_probe_failed');
  return (
    <div className={cn('flex flex-col', compact ? 'gap-1 text-[10.5px]' : 'gap-1.5 px-3 py-2 text-[11.5px]')}>
      <div className="flex flex-wrap items-center gap-2">
        {state === 'verifying' ? <Loader2 className="size-3.5 animate-spin text-warn" /> : <ShieldCheck className={cn('size-3.5', TONE[tone])} />}
        <span className="shrink-0 text-muted-foreground">{tr('止损保护')}</span>
        <Badge variant="outline" className={cn('h-4 shrink-0 px-1.5 text-[10px]', TONE_BORDER[tone])}>
          {STATE_LABEL[state]}
        </Badge>
        <span className="num shrink-0 text-[10.5px] text-muted-foreground" title={tr('凭证有效期,在设置 › 自动化里改;改小了旧凭证立刻过期')}>
          {tr('有效期')} {protection.ttl_days ?? '—'} {tr('天')}
        </span>
        <span className={cn('num shrink-0 text-[10.5px]', protection.expires_at !== null && protection.expires_at !== undefined && protection.expires_at <= now ? 'text-warn' : 'text-muted-foreground')}>
          {tr('过期')} {protection.expires_at ? `${fmtDateTime(protection.expires_at)} · ${expiryText(protection.expires_at, now)}` : '—'}
        </span>
        {needsWork.length > 0 ? (
          <span className="num shrink-0 text-[10.5px] text-warn">{tr('{n} 个币要处理', { n: needsWork.length })}</span>
        ) : null}
        <button
          type="button"
          className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {tr('凭证 {n} 张', { n: creds.length })}
        </button>
      </div>

      {state === 'never_verified' ? (
        <div className="text-[10.5px] leading-relaxed text-down">
          {tr('这条通道上还没有任何币验证过能挂止损:那些币的新开仓会被提交前的闸挡住(已验证的币照常开)。')}
        </div>
      ) : null}
      {protection.auto_note ? (
        <div className="text-[10.5px] leading-relaxed text-muted-foreground" title={tr('自动重跑金丝雀:每通道 × 交易对每天最多一次;从没验过的币不会自动跑')}>
          {tr('自动重验')}:{protection.auto_note}
        </div>
      ) : null}

      {open ? (
        creds.length === 0 ? (
          <div className="text-[10.5px] text-muted-foreground">{tr('网关没给凭证明细。')}</div>
        ) : (
          <div className="overflow-hidden rounded-sm border">
            <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,0.9fr)] gap-px bg-border">
              {[tr('交易对'), tr('状态'), tr('验证于'), tr('过期于'), tr('上次真挂'), ''].map((h, i) => (
                <div key={`${h}-${i}`} className="bg-muted/60 px-2 py-1 text-[10px] font-semibold text-muted-foreground select-none">
                  {h}
                </div>
              ))}
              {creds.map((c) => (
                <CredentialRow key={`${c.channel}-${c.symbol ?? '*'}-${c.market ?? 'perp'}`} c={c} costNote={protection.cost_note} now={now} />
              ))}
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
