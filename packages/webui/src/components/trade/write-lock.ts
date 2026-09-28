/**
 * 交易页写操作的访客锁(风控 Save、改判断方式、暂停/继续运行)。两层,与楼层 PM 开关(floor-v4/sizing-mode-logic.ts)同一判定:
 *   1. 构建开关:VITE_EDITION=judge 或 VITE_PUBLIC_DEMO=1 → 一律只读
 *   2. 运行时:网关回过 403 judge_locked,或 GET /api/demo/whoami 说 read_only → 本页锁住
 * 评审版(wt/judge-trading):风控/执行策略按 lib/edition.ts 的 lockReason('execution_policy') 锁;策略运行的暂停/继续是
 * 网关放行的可玩操作(public-gate PLAY_ROUTES),构建层不锁,只在网关真回 403 时锁(runReason)。
 */
import { useCallback, useState } from 'react';
import { useDemoAccess } from '@/api/trading';
import { isJudgeLockedError, isReadOnlyBuild } from '@/components/floor-v4/sizing-mode-logic';
import { IS_JUDGE, lockReason } from '@/lib/edition';
import { t } from '@/lib/i18n';

export const READ_ONLY_BUILD = isReadOnlyBuild(import.meta.env as unknown as Record<string, unknown>);

export function tradeLockReason(x: { readOnlyBuild: boolean; serverLocked: boolean; whoamiReadOnly: boolean }): string | null {
  return x.readOnlyBuild || x.serverLocked || x.whoamiReadOnly ? t('公网演示:访客只读,只有所有者能改') : null;
}

/** 403 judge_locked 也可能以 status 403 + 其它 code 出现(老网关),两种都算 */
export function isLockedError(err: unknown): boolean {
  return isJudgeLockedError(err) || (!!err && typeof err === 'object' && (err as { status?: unknown }).status === 403);
}

export function useTradeWriteLock(): { reason: string | null; runReason: string | null; noteError: (err: unknown) => boolean } {
  const access = useDemoAccess();
  const [serverLocked, setServerLocked] = useState(false);
  const noteError = useCallback((err: unknown) => {
    if (!isLockedError(err)) return false;
    setServerLocked(true);
    return true;
  }, []);
  const whoamiReadOnly = !!access.data?.read_only;
  if (IS_JUDGE) {
    const judgeLock = lockReason('execution_policy');
    // whoami 的 read_only 只表示「不是 owner」;访客照样能做网关放行的可玩操作(暂停/继续运行、AI 扫盘),所以这里只看网关有没有真拒过
    return { reason: judgeLock, runReason: serverLocked ? judgeLock : null, noteError };
  }
  const reason = tradeLockReason({ readOnlyBuild: READ_ONLY_BUILD, serverLocked, whoamiReadOnly });
  return { reason, runReason: reason, noteError };
}
