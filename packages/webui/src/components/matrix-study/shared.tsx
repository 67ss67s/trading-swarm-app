/**
 * 矩阵研究(§9.53 B)页面与研究台内嵌共用的小件:文案表、胶囊开关、格子 family 的可读名。
 * 格子 family 两种:内置策略族(breakout / ma_trend …)与「我的策略」`my:<strategy_id>@v<version>`。
 */
import { FAMILY_TEXT } from '@/components/chat/recommendation-card';
import type { FailureCause, MatrixArm, MatrixMyStrategy, MatrixTimeframe } from '@/api/matrix-study';
import { cn } from '@/lib/utils';
import { tmap } from '@/lib/i18n';

export const TF_HORIZON: Record<MatrixTimeframe, string> = tmap({ '3m': '短线', '5m': '短线', '15m': '短线', '4h': '中线', '1d': '长线' });
export const RUNNABLE: MatrixTimeframe[] = ['15m', '4h', '1d'];
export const FAMILIES = ['breakout', 'ma_trend', 'ema_cross', 'pullback', 'mean_reversion', 'smc'] as const;
export const ARM_TEXT: Record<MatrixArm, string> = tmap({ code: '纯代码', code_judge: '代码 + Jev' });
export const CAUSE_TEXT: Record<FailureCause, string> = tmap({ cost_dominated: '费用吃掉', insufficient_evidence: '证据不足', unsupported_execution: '执行不支持', underperform_hold: '跑输持有' });
export const STATUS_TEXT: Record<string, string> = tmap({ queued: '排队', running: '研究中', ready_to_finalize: '待释放留出段', finalizing: '留出段检验中', completed: '已完成', cancelled: '已取消', failed: '失败', interrupted: '中断' });
export const STAGE_TEXT: Record<string, string> = tmap({ queued: '排队', data: '取数', matrix: '跑矩阵', iterate: '迭代找根因', sealed: '候选已冻结', holdout: '留出段检验', done: '完成' });
export const VERDICT_CLS: Record<string, string> = { pass: 'bg-up/20 text-up border-up/40', near: 'bg-warn/15 text-warn border-warn/40', fail: 'bg-muted text-muted-foreground', ineligible: 'bg-transparent text-muted-foreground/60 border-dashed' };

export const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
export const shortSyms = (xs: string[]) => xs.map((x) => x.replace(/USDT$/, '')).join(' · ');

/** `my:<strategy_id>@v<version>` → { strategy_id, version };不是「我的策略」格子返回 null */
export function parseMyFamily(f: string): { strategy_id: string; version: number | null } | null {
  if (!f.startsWith('my:')) return null;
  const m = /^my:(.+)@v(\d+)$/.exec(f);
  return m ? { strategy_id: m[1]!, version: Number(m[2]) } : { strategy_id: f.slice(3), version: null };
}

/** 格子 / finalist 的 family 可读名:内置族走 FAMILY_TEXT;我的策略用详情里解析好的名字,找不到就去掉 my: 前缀 */
export function familyLabel(f: string, mine: MatrixMyStrategy[] = []): string {
  const my = parseMyFamily(f);
  if (!my) return FAMILY_TEXT[f as keyof typeof FAMILY_TEXT] ?? f;
  const hit = mine.find((x) => x.strategy_id === my.strategy_id && (my.version === null || x.version === my.version));
  return hit ? `${hit.name} v${hit.version}` : f.slice(3);
}

export function Toggle<T extends string>({ all, value, onChange, label, disabled }: { all: readonly T[]; value: T[]; onChange: (v: T[]) => void; label: (x: T) => string; disabled?: (x: T) => string | null }) {
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((x) => {
        const why = disabled?.(x) ?? null, on = value.includes(x);
        return (
          <button key={x} type="button" disabled={!!why} title={why ?? undefined} onClick={() => onChange(on ? value.filter((v) => v !== x) : [...value, x])}
            className={cn('rounded-full border px-2 py-0.5 text-[12px]', on ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted', why && 'cursor-not-allowed opacity-40')}>
            {label(x)}
          </button>
        );
      })}
    </div>
  );
}
