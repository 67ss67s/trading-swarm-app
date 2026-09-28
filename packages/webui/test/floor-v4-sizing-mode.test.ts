/** 楼层 PM 对话框「仓位倍率生效模式」的纯逻辑 */
import { describe, expect, it } from 'vitest';
import { isJudgeLockedError, isReadOnlyBuild, normalizeSizingMode, SIZING_LOCK_REASON, SIZING_MODES, sizingLockReason, sizingModeLabel } from '../src/components/floor-v4/sizing-mode-logic';
import { EN } from '../src/lib/i18n-en';

describe('floor-v4 sizing mode', () => {
  it('三档顺序固定为 off / advise / apply', () => {
    expect(SIZING_MODES).toEqual(['off', 'advise', 'apply']);
  });

  it('只认三档合法值,其余一律 null(不猜)', () => {
    expect(normalizeSizingMode('apply')).toBe('apply');
    expect(normalizeSizingMode('advise')).toBe('advise');
    expect(normalizeSizingMode('off')).toBe('off');
    expect(normalizeSizingMode(undefined)).toBeNull();
    expect(normalizeSizingMode('APPLY')).toBeNull();
    expect(normalizeSizingMode(1)).toBeNull();
  });

  it('档位标签中英各一份,off 在英文下是 Off 而不是 Close', () => {
    expect(sizingModeLabel('off', 'zh')).toBe('关闭');
    expect(sizingModeLabel('off', 'en')).toBe('Off');
    expect(sizingModeLabel('apply', 'en')).toBe('Apply');
  });

  it('只读构建:VITE_EDITION=judge 或 VITE_PUBLIC_DEMO=1', () => {
    expect(isReadOnlyBuild({})).toBe(false);
    expect(isReadOnlyBuild({ VITE_EDITION: 'default' })).toBe(false);
    expect(isReadOnlyBuild({ VITE_EDITION: 'judge' })).toBe(true);
    expect(isReadOnlyBuild({ VITE_PUBLIC_DEMO: '1' })).toBe(true);
  });

  it('网关回 judge_locked 即锁;别的错误不锁', () => {
    expect(isJudgeLockedError({ code: 'judge_locked', status: 403 })).toBe(true);
    expect(isJudgeLockedError({ code: 'forbidden' })).toBe(false);
    expect(isJudgeLockedError(new Error('x'))).toBe(false);
    expect(isJudgeLockedError(null)).toBe(false);
    expect(sizingLockReason({ readOnlyBuild: false, serverLocked: false })).toBeNull();
    expect(sizingLockReason({ readOnlyBuild: true, serverLocked: false })).toBe(SIZING_LOCK_REASON);
    expect(sizingLockReason({ readOnlyBuild: false, serverLocked: true })).toBe(SIZING_LOCK_REASON);
    expect(EN[SIZING_LOCK_REASON]).toBeTruthy();
  });
});
