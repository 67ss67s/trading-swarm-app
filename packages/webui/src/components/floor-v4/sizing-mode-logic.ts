/**
 * 楼层 PM(portfolio_manager)对话框里的「仓位倍率生效模式」—— 纯逻辑部分(无 React,单测直接 import)。
 *
 * 对应 workflow.sizing_agent(§9.21):
 *   off    不调用仓位模型,按基础风险预算下单
 *   advise 每次可开仓问一次倍率,只记录不生效
 *   apply  采用合法意见:基础风险 × 0.25–2 倍率 + 拆单建议;数量仍由代码算(后端默认已是 apply)
 */
import type { Workflow } from '@/api/types';

export type SizingMode = Workflow['sizing_agent'];

export const SIZING_MODES: readonly SizingMode[] = ['off', 'advise', 'apply'];

/**
 * hint 是中文原文即 i18n key,渲染时过 t()(英文在 i18n-en-floor.ts)。
 * label 自带中英两份:全局词典里「关闭」已被占成 Close(关闭按钮),这里要的是开关档位 Off,不能共用一个 key。
 */
export const SIZING_MODE_TEXT: Record<SizingMode, { label: { zh: string; en: string }; hint: string }> = {
  off: { label: { zh: '关闭', en: 'Off' }, hint: '不调用仓位模型,按基础风险下单' },
  advise: { label: { zh: '只建议', en: 'Advise' }, hint: '每次开仓给一个倍率,只记录不生效' },
  apply: { label: { zh: '生效', en: 'Apply' }, hint: '基础风险 × 0.25–2 倍率 + 拆单建议,数量仍由代码算' },
};

export function sizingModeLabel(mode: SizingMode, lang: 'zh' | 'en'): string {
  return SIZING_MODE_TEXT[mode].label[lang];
}

/** 服务端给的值不在三档里(旧网关没这个字段 / 脏数据)→ null,界面不选中任何一档,不替它猜 */
export function normalizeSizingMode(v: unknown): SizingMode | null {
  return typeof v === 'string' && (SIZING_MODES as readonly string[]).includes(v) ? (v as SizingMode) : null;
}

/**
 * 公网演示(评审版)网关对访客的写接口回 403 + code `judge_locked`(wt/judge-edition 的 gateway public-gate.ts;
 * POST /api/workflow 对访客只放行勾选观察列表,改 sizing_agent 会被锁)。api/client.ts 的 ApiRequestError 没导出,按 code 鸭子判断。
 */
export function isJudgeLockedError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'judge_locked';
}

/**
 * 只读构建判定,与 wt/judge-edition 分支现有写法同源(那边尚未合入本分支,合入后直接换成它们):
 *   - lib/edition.ts:IS_JUDGE = VITE_EDITION === 'judge',锁定功能走 lockReason(feature)
 *   - lib/nav.tsx:PUBLIC_DEMO_BUILD = VITE_PUBLIC_DEMO === '1'(deploy/hostinger 公网体验版)
 */
export function isReadOnlyBuild(env: Record<string, unknown>): boolean {
  return env['VITE_EDITION'] === 'judge' || env['VITE_PUBLIC_DEMO'] === '1';
}

export const SIZING_LOCK_REASON = '公网演示模式访客只读,只有所有者能切换';

/** 只读构建,或网关已经对这个会话回过 judge_locked → 锁;否则 null */
export function sizingLockReason(x: { readOnlyBuild: boolean; serverLocked: boolean }): string | null {
  return x.readOnlyBuild || x.serverLocked ? SIZING_LOCK_REASON : null;
}
