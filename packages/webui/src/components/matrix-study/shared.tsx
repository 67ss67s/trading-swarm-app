/**
 * 批量验证(内部名:矩阵研究,§9.53 B)页面与研究台内嵌共用的小件:文案表、胶囊开关、格子 family 的可读名。
 * 格子 family 两种:内置策略族(breakout / ma_trend …)与「我的策略」`my:<strategy_id>@v<version>`。
 */
import { createContext } from 'react';
import { FAMILY_TEXT } from '@/components/chat/recommendation-card';
import type { FailureCause, MatrixArm, MatrixMyStrategy, MatrixTimeframe } from '@/api/matrix-study';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

export const TF_HORIZON: Record<MatrixTimeframe, string> = tmap({ '3m': '短线', '5m': '短线', '15m': '短线', '4h': '中线', '1d': '长线' });
export const RUNNABLE: MatrixTimeframe[] = ['15m', '4h', '1d'];
export const FAMILIES = ['breakout', 'ma_trend', 'ema_cross', 'pullback', 'mean_reversion', 'smc'] as const;
export const ARM_TEXT: Record<MatrixArm, string> = tmap({ code: '纯代码', code_judge: '代码 + Jev 判断' });
export const CAUSE_TEXT: Record<FailureCause, string> = tmap({ cost_dominated: '手续费吃掉利润', insufficient_evidence: '样本不足', unsupported_execution: '跑不起来', underperform_hold: '跑不过拿着不动' });
export const STATUS_TEXT: Record<string, string> = tmap({ queued: '排队', running: '研究中', ready_to_finalize: '等你验收', finalizing: '最终验收中', completed: '已完成', cancelled: '已取消', failed: '失败', interrupted: '中断' });
export const STAGE_TEXT: Record<string, string> = tmap({ queued: '排队', data: '取数', matrix: '批量回测', iterate: '自动诊断改进', sealed: '候选已定', holdout: '最终验收', done: '完成' });
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

/**
 * 胶囊多选。warn = 预算提示(只对没选中的项):「再加这个会超 X」写进 title 并加警示样式;severe(超得很明显)再置灰,但不禁用,不挡用户。
 */
export function Toggle<T extends string>({ all, value, onChange, label, disabled, warn }: { all: readonly T[]; value: T[]; onChange: (v: T[]) => void; label: (x: T) => string; disabled?: (x: T) => string | null; warn?: (x: T) => { text: string; severe: boolean } | null }) {
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((x) => {
        const why = disabled?.(x) ?? null, on = value.includes(x);
        const w = !why && !on ? warn?.(x) ?? null : null;
        return (
          <button key={x} type="button" disabled={!!why} title={why ?? w?.text ?? undefined} data-budget-warn={w ? (w.severe ? 'severe' : 'warn') : undefined} onClick={() => onChange(on ? value.filter((v) => v !== x) : [...value, x])}
            className={cn('rounded-full border px-2 py-0.5 text-[12px]', on ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted', why && 'cursor-not-allowed opacity-40', w && 'border-dashed border-destructive/60 text-destructive', w?.severe && 'opacity-50')}>
            {label(x)}
          </button>
        );
      })}
    </div>
  );
}

/** 批量验证与研究台的分工,两边页面顶部各一行(here = 当前页) */
export function DivisionNote({ here, className }: { here: 'matrix' | 'research'; className?: string }) {
  return (
    <p className={cn('text-[11.5px] text-muted-foreground', className)}>
      {here === 'matrix'
        ? <>{t('批量验证是海选:还不知道做哪个币、哪个周期、哪种策略时,一次把组合全跑一遍。已经有想法、要逐条改,去')} <a href="#research" className="text-primary hover:underline">{t('研究台')}</a>{t('精修。')}</>
        : <>{t('研究台是精修:已经有想法,逐条改规则、看回测。还不知道做哪个币、哪个周期、哪种策略,先去')} <a href="#matrix-study" className="text-primary hover:underline">{t('批量验证')}</a>{t('海选。')}</>}
    </p>
  );
}

/**
 * 「策略研究」流程页(#strategy-research)里渲染批量验证详情时的钩子:有它 = 流程模式。
 *   onRefine   抽屉「精修这一组」→ 切到第 3 步,带上 study / trial
 *   onValidate 存成我的策略 / 候补之后「去验收」→ 切到第 4 步,带上 strategy
 *   onBack     返回海选新建表单
 * 流程模式下不显示分工说明,旧研究留下的迭代记录折叠进「旧版迭代记录(历史研究)」。
 */
export interface MatrixFlow { onRefine: (studyId: string, trialId: string) => void; onValidate: (strategyId: string) => void; onBack: () => void }
export const MatrixFlowContext = createContext<MatrixFlow | null>(null);
